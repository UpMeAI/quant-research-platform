#!/usr/bin/python3
"""One fail-closed Linux pass of the #137 research-queue relay."""
import argparse
import hashlib
import importlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone


SAFE_JSON = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}[.]json")
SHA64 = re.compile(r"[0-9a-f]{64}")
MAX_PACK_BYTES = 16 * 1024 * 1024
NODE = "/srv/research-lane/tools/node-v23.11.0-linux-x64/bin/node"
DATA_DIR = "/srv/research-lane/qrp/var"
AUTHORITY = "V8_1_COORDINATOR"
LOCAL_OUTBOX = "/srv/research-lane/research-queue/relay-outbox"
LOCAL_INBOX = "/srv/research-lane/research-queue/inbox/fact-packs"
QUEUE_OUTBOX = "/srv/research-lane/research-queue/outbox"
RETURN_ROOT = "/srv/research-lane/qrp/var/research-queue-return"
HK_OUTBOX = "/var/lib/research-queue/outbox/"


class RelayError(RuntimeError):
    pass


def _fail(code):
    raise RelayError(code)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _atomic_write(path, data, mode=0o640, create_only=False):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(".%s.part.%d" % (path.name, os.getpid()))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(str(pending), flags, mode)
    try:
        with os.fdopen(fd, "wb", closefd=True) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(str(pending), mode)
        if create_only:
            try:
                os.link(str(pending), str(path))
            except FileExistsError:
                _fail("ARTIFACT_EXISTS")
            finally:
                pending.unlink(missing_ok=True)
        else:
            os.replace(str(pending), str(path))
    except Exception:
        pending.unlink(missing_ok=True)
        raise


def guard_qrp_var(config, is_writable=None):
    """Validate the ops-produced switch evidence before any ledger operation."""
    required = ("authority_marker", "authoritative_dir", "linux_manifest", "mac_manifest", "mac_mode_proof")
    if not isinstance(config, dict) or any(not isinstance(config.get(k), str) or not config[k] for k in required):
        _fail("QRP_VAR_GUARD_INVALID")
    authority = pathlib.Path(config["authoritative_dir"]).resolve()
    if not pathlib.Path(config["authority_marker"]).is_file():
        _fail("QRP_VAR_AUTHORITY_MISSING")
    writable = is_writable or (lambda p: os.access(str(p), os.W_OK))
    if not authority.is_dir() or not writable(authority):
        _fail("QRP_VAR_AUTHORITY_NOT_WRITABLE")
    try:
        linux_manifest = pathlib.Path(config["linux_manifest"]).read_bytes()
        mac_manifest = pathlib.Path(config["mac_manifest"]).read_bytes()
    except OSError:
        _fail("QRP_VAR_MANIFEST_MISMATCH")
    if not linux_manifest or linux_manifest != mac_manifest:
        _fail("QRP_VAR_MANIFEST_MISMATCH")
    try:
        proof = json.loads(pathlib.Path(config["mac_mode_proof"]).read_text())
    except (OSError, UnicodeError, ValueError):
        _fail("QRP_VAR_DUAL_WRITABLE")
    if (not isinstance(proof, dict) or proof.get("schema") != "QRP_MAC_VAR_MODE_PROOF_V1"
            or not isinstance(proof.get("path"), str) or not proof["path"]
            or proof.get("writable") is not False):
        _fail("QRP_VAR_DUAL_WRITABLE")
    return authority


class NodeSeenMarker:
    def __init__(self, qrp_root, node, env, run=subprocess.run):
        self.qrp_root = pathlib.Path(qrp_root)
        self.node = node
        self.env = dict(env)
        self.run = run
        if self.node != NODE:
            _fail("SEEN_MARK_NODE_INVALID")
        if self.env.get("QRP_PRODUCT_MILESTONE_AUTHORITY") != AUTHORITY:
            _fail("SEEN_MARK_AUTHORITY_INVALID")
        if not pathlib.Path(self.env.get("QRP_DATA_DIR", "")).is_absolute():
            _fail("SEEN_MARK_DATA_DIR_INVALID")
        self.env.pop("RQ_SEEN_MARK_QRP_ROOT", None)

    def __call__(self, data):
        argv = [self.node, str(self.qrp_root / "apps/research-cli/review_pack_seen.js"), "mark", "--file", "-"]
        try:
            result = self.run(argv, input=data, capture_output=True, timeout=60, env=self.env)
        except (OSError, subprocess.SubprocessError):
            return "SEEN_MARK_UNAVAILABLE"
        if result.returncode == 0:
            return None
        first = (result.stderr or b"").lstrip().split(b":", 1)[0].split(None, 1)[0][:80]
        return first.decode("ascii", "ignore") if re.fullmatch(rb"[A-Z][A-Z0-9_]{2,79}", first) else "SEEN_MARK_EXIT_%d" % result.returncode


def deliver_local(source, destination, marker, validator):
    source, destination = pathlib.Path(source), pathlib.Path(destination)
    try:
        info = source.lstat()
    except OSError:
        _fail("LOCAL_SOURCE_UNREADABLE")
    if source.is_symlink() or not stat.S_ISREG(info.st_mode) or not SAFE_JSON.fullmatch(source.name):
        _fail("LOCAL_SOURCE_INVALID")
    if info.st_size > MAX_PACK_BYTES:
        _fail("LOCAL_SOURCE_TOO_LARGE")
    data = source.read_bytes()
    invalid = validator(data)
    if invalid:
        _fail("PACK_INVALID:%s" % invalid)
    code = marker(data)
    if code:
        _fail("SEEN_MARK_FAILED:%s" % code)
    digest = _sha(data)
    if destination.exists():
        if destination.is_symlink() or not destination.is_file() or _sha(destination.read_bytes()) != digest:
            _fail("LOCAL_DEST_SHA_MISMATCH")
        source.unlink()
        return "REPLAY"
    _atomic_write(destination, data, mode=0o640)
    if _sha(destination.read_bytes()) != digest:
        destination.unlink(missing_ok=True)
        _fail("LOCAL_DEST_VERIFY_FAILED")
    source.unlink()
    return "DELIVERED"


class GateRsyncTransport:
    """Rsync client whose remote command bytes are admitted only by #132."""
    def __init__(self, target, rsync="/usr/bin/rsync", run=subprocess.run):
        if not isinstance(target, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+", target):
            _fail("HK_GATE_TARGET_INVALID")
        if rsync != "/usr/bin/rsync":
            _fail("RSYNC_BINARY_INVALID")
        self.target, self.rsync, self.run = target, rsync, run

    def _run(self, argv):
        result = self.run(argv, capture_output=True, timeout=180)
        if result.returncode != 0:
            _fail("HK_GATE_RSYNC_FAILED")

    def push_fact_packs(self, stage):
        stage = pathlib.Path(stage)
        self._run([self.rsync, "-a", "--checksum", "--delay-updates", "--protect-args", "--", str(stage) + "/", self.target + ":fact-packs/"])

    def pull_returns(self, destination):
        destination = pathlib.Path(destination)
        destination.mkdir(parents=True, exist_ok=True)
        self._run([self.rsync, "-a", "--checksum", "--protect-args", "--", self.target + ":" + HK_OUTBOX, str(destination) + "/"])


def _copy_return(source, destination):
    source, destination = pathlib.Path(source), pathlib.Path(destination)
    info = source.lstat()
    if source.is_symlink() or not stat.S_ISREG(info.st_mode) or not SAFE_JSON.fullmatch(source.name) or info.st_size > MAX_PACK_BYTES:
        _fail("RETURN_FILE_INVALID")
    data = source.read_bytes()
    if destination.exists():
        if destination.is_symlink() or not destination.is_file() or destination.read_bytes() != data:
            _fail("RETURN_DEST_SHA_MISMATCH")
        return "REPLAY"
    _atomic_write(destination, data, mode=0o640)
    if _sha(destination.read_bytes()) != _sha(data):
        _fail("RETURN_DEST_VERIFY_FAILED")
    return "COPIED"


def _load_json(path, default):
    try:
        value = json.loads(pathlib.Path(path).read_text())
        return value if isinstance(value, dict) else default
    except (OSError, UnicodeError, ValueError):
        return default


def _load_pack_validator(qrp_root):
    package_root = pathlib.Path(qrp_root) / "services/research-queue"
    sys.path.insert(0, str(package_root))
    try:
        return importlib.import_module("rq.relay")._valid_pack
    except (ImportError, AttributeError):
        _fail("PACK_VALIDATOR_UNAVAILABLE")


def _config_from_env(env):
    expected = {
        "QRP_DATA_DIR": DATA_DIR,
        "QRP_PRODUCT_MILESTONE_AUTHORITY": AUTHORITY,
        "RQ_RELAY_OUTBOX": LOCAL_OUTBOX,
        "RQ_LOCAL_FACT_PACK_INBOX": LOCAL_INBOX,
        "RQ_QUEUE_OUTBOX": QUEUE_OUTBOX,
        "RQ_RETURN_ROOT": RETURN_ROOT,
        "RQ_NODE": NODE,
    }
    for key, value in expected.items():
        if env.get(key) != value:
            _fail("ENV_INVALID:%s" % key)
    if env.get("RQ_SEEN_MARK_QRP_ROOT") not in (None, ""):
        _fail("RQ_SEEN_MARK_QRP_ROOT_MUST_BE_UNSET")
    qrp_root = env.get("QRP_ROOT", "")
    pinned = env.get("QRP_PINNED_SHA", "")
    if not SHA64.fullmatch(pinned) or pathlib.Path(qrp_root).name != pinned:
        _fail("QRP_PIN_INVALID")
    required = ("RQ_HK_GATE_TARGET", "RQ_RELAY_STATE", "RQ_RELAY_STATUS", "QRP_AUTHORITY_MARKER",
                "QRP_VAR_LINUX_MANIFEST", "QRP_VAR_MAC_MANIFEST", "QRP_MAC_VAR_MODE_PROOF")
    if any(not env.get(key) for key in required):
        _fail("ENV_MISSING")
    return {
        "qrp_root": qrp_root,
        "node": NODE,
        "data_dir": DATA_DIR,
        "authority": AUTHORITY,
        "outbox_root": LOCAL_OUTBOX,
        "local_inbox": LOCAL_INBOX,
        "queue_outbox": QUEUE_OUTBOX,
        "return_root": RETURN_ROOT,
        "hk_target": env["RQ_HK_GATE_TARGET"],
        "state_path": env["RQ_RELAY_STATE"],
        "status_path": env["RQ_RELAY_STATUS"],
        "guard": {
            "authority_marker": env["QRP_AUTHORITY_MARKER"], "authoritative_dir": DATA_DIR,
            "linux_manifest": env["QRP_VAR_LINUX_MANIFEST"], "mac_manifest": env["QRP_VAR_MAC_MANIFEST"],
            "mac_mode_proof": env["QRP_MAC_VAR_MODE_PROOF"],
        },
    }


def run_once(config, env=None, run=subprocess.run):
    guard_qrp_var(config["guard"])
    clean_env = {"QRP_DATA_DIR": DATA_DIR, "QRP_PRODUCT_MILESTONE_AUTHORITY": AUTHORITY, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    marker = NodeSeenMarker(config["qrp_root"], config["node"], clean_env, run=run)
    validate_pack = _load_pack_validator(config["qrp_root"])
    state = _load_json(config["state_path"], {"hk_pushed": {}, "returns": {}})
    state.setdefault("hk_pushed", {})
    state.setdefault("returns", {})
    result = {"localDelivered": 0, "localReplay": 0, "hkPushed": 0, "returnsCopied": 0, "failed": []}

    local_source = pathlib.Path(config["outbox_root"]) / "linux" / "REVIEW_AI_FACT_PACK_V1"
    for source in sorted(local_source.glob("*.json")) if local_source.is_dir() else []:
        try:
            outcome = deliver_local(source, pathlib.Path(config["local_inbox"]) / source.name, marker, validate_pack)
            result["localDelivered" if outcome == "DELIVERED" else "localReplay"] += 1
        except RelayError as error:
            result["failed"].append(["linux", source.name, str(error)])

    hk_source = pathlib.Path(config["outbox_root"]) / "hk" / "REVIEW_AI_FACT_PACK_V1"
    with tempfile.TemporaryDirectory(prefix="q137-hk-push-") as temp:
        stage = pathlib.Path(temp)
        staged = []
        for source in sorted(hk_source.glob("*.json")) if hk_source.is_dir() else []:
            try:
                info = source.lstat()
                if source.is_symlink() or not stat.S_ISREG(info.st_mode) or not SAFE_JSON.fullmatch(source.name) or info.st_size > MAX_PACK_BYTES:
                    _fail("HK_SOURCE_INVALID")
                data = source.read_bytes()
                digest = _sha(data)
                if state["hk_pushed"].get(digest) == source.name:
                    continue
                bad = validate_pack(data)
                if bad:
                    _fail("PACK_INVALID:%s" % bad)
                code = marker(data)
                if code:
                    _fail("SEEN_MARK_FAILED:%s" % code)
                _atomic_write(stage / source.name, data, mode=0o640)
                staged.append((digest, source.name))
            except RelayError as error:
                result["failed"].append(["hk", source.name, str(error)])
        transport = GateRsyncTransport(config["hk_target"], run=run)
        if staged:
            try:
                transport.push_fact_packs(stage)
                for digest, name in staged:
                    state["hk_pushed"][digest] = name
                    result["hkPushed"] += 1
            except RelayError as error:
                result["failed"].append(["hk", "fact-packs", str(error)])

        pull = stage / "pull"
        try:
            transport.pull_returns(pull)
            for source in sorted(pull.glob("*.json")):
                destination = pathlib.Path(config["return_root"]) / "hk" / source.name
                _copy_return(source, destination)
                state["returns"][_sha(source.read_bytes())] = "hk/%s" % source.name
                result["returnsCopied"] += 1
        except RelayError as error:
            result["failed"].append(["hk", "outbox", str(error)])

    local_returns = pathlib.Path(config["queue_outbox"])
    for source in sorted(local_returns.glob("*.json")) if local_returns.is_dir() else []:
        try:
            _copy_return(source, pathlib.Path(config["return_root"]) / "linux" / source.name)
            state["returns"][_sha(source.read_bytes())] = "linux/%s" % source.name
            result["returnsCopied"] += 1
        except RelayError as error:
            result["failed"].append(["linux", source.name, str(error)])
    _atomic_write(config["state_path"], (json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n").encode(), mode=0o600)
    return result


def _write_status(path, rc, result=None, error=None):
    body = {"schema": "Q137_RELAY_STATUS_V1", "lastOkAt": datetime.now(timezone.utc).isoformat() if rc == 0 else None,
            "rc": rc, "counts": result or {}, "error": error}
    _atomic_write(path, (json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode(), mode=0o640)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    if not args.once:
        parser.error("--once is required")
    status = os.environ.get("RQ_RELAY_STATUS", "/srv/research-lane/ops-logs/research-queue-relay/status.json")
    try:
        config = _config_from_env(os.environ)
        result = run_once(config)
        rc = 1 if result["failed"] else 0
        _write_status(status, rc, result=result)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return rc
    except Exception as error:
        _write_status(status, 1, error=str(error)[:240])
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
