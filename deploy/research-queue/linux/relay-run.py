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
VAR_ROOT = "/srv/research-lane/qrp/var"
DATA_DIR = "/srv/research-lane/qrp/var/ledger"
AUTHORITY = "V8_1_COORDINATOR"
LOCAL_OUTBOX = "/srv/research-lane/research-queue/relay-outbox"
LOCAL_INBOX = "/srv/research-lane/research-queue/inbox/fact-packs"
QUEUE_OUTBOX = "/srv/research-lane/research-queue/outbox"
RETURN_ROOT = "/srv/research-lane/qrp/var/research-queue-return"
HK_OUTBOX = "/var/lib/research-queue/outbox/"
HK_GATE_TARGET = "root@smartflow-hk"
CODE_ROOT = "/srv/research-lane/qrp/code"
AUTHORITY_MARKER = "/srv/research-lane/qrp/AUTHORITATIVE"
LINUX_MANIFEST = "/srv/research-lane/qrp/migration/linux-var.sha256"
MAC_MANIFEST = "/srv/research-lane/qrp/migration/mac-var.sha256"
MAC_MODE_PROOF = "/srv/research-lane/qrp/migration/mac-var-mode.json"
MAC_VAR_PATH = "/Users/kaylame/KaylaProject/quant-research-platform/var"
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)


class RelayError(RuntimeError):
    pass


def _fail(code):
    raise RelayError(code)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _open_dir_nofollow(path, create=False, mode=0o750):
    """Open an absolute directory without following any path component."""
    path = pathlib.Path(path)
    if not path.is_absolute() or any(part in ("", ".", "..") for part in path.parts[1:]):
        _fail("SAFE_PATH_INVALID")
    fd = os.open("/", os.O_RDONLY | O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            try:
                next_fd = os.open(part, os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, mode=mode, dir_fd=fd)
                next_fd = os.open(part, os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise


def _read_regular_nofollow(path, max_bytes, error_code, missing_ok=False):
    """Return (bytes, (dev, ino)) for a stable nonsymlink regular file."""
    path = pathlib.Path(path)
    parent_fd = file_fd = None
    try:
        parent_fd = _open_dir_nofollow(path.parent)
        file_fd = os.open(path.name, os.O_RDONLY | O_NOFOLLOW, dir_fd=parent_fd)
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > max_bytes:
            _fail(error_code)
        chunks, remaining = [], max_bytes + 1
        while remaining:
            chunk = os.read(file_fd, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > max_bytes:
            _fail(error_code)
        after_fd = os.fstat(file_fd)
        after_path = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
        identity = (before.st_dev, before.st_ino)
        if identity != (after_fd.st_dev, after_fd.st_ino) or identity != (after_path.st_dev, after_path.st_ino):
            _fail(error_code)
        return data, identity
    except FileNotFoundError:
        if missing_ok:
            return None, None
        _fail(error_code)
    except RelayError:
        raise
    except OSError:
        _fail(error_code)
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if parent_fd is not None:
            os.close(parent_fd)


def _unlink_if_same(path, identity, error_code):
    path = pathlib.Path(path)
    parent_fd = None
    try:
        parent_fd = _open_dir_nofollow(path.parent)
        current = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != identity or not stat.S_ISREG(current.st_mode):
            _fail(error_code)
        os.unlink(path.name, dir_fd=parent_fd)
    except RelayError:
        raise
    except OSError:
        _fail(error_code)
    finally:
        if parent_fd is not None:
            os.close(parent_fd)


def _chmod_regular_nofollow(path, mode, error_code):
    path = pathlib.Path(path)
    parent_fd = file_fd = None
    try:
        parent_fd = _open_dir_nofollow(path.parent)
        file_fd = os.open(path.name, os.O_RDONLY | O_NOFOLLOW, dir_fd=parent_fd)
        if not stat.S_ISREG(os.fstat(file_fd).st_mode):
            _fail(error_code)
        os.fchmod(file_fd, mode)
    except RelayError:
        raise
    except OSError:
        _fail(error_code)
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if parent_fd is not None:
            os.close(parent_fd)


def _atomic_write(path, data, mode=0o640, create_only=False):
    path = pathlib.Path(path)
    parent_fd = _open_dir_nofollow(path.parent, create=True)
    pending = ".%s.part.%d" % (path.name, os.getpid())
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(pending, flags | O_NOFOLLOW, mode, dir_fd=parent_fd)
    try:
        with os.fdopen(fd, "wb", closefd=True) as handle:
            fd = None
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        pending_fd = os.open(pending, os.O_RDONLY | O_NOFOLLOW, dir_fd=parent_fd)
        try:
            os.fchmod(pending_fd, mode)
        finally:
            os.close(pending_fd)
        if create_only:
            try:
                os.link(pending, path.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
            except FileExistsError:
                _fail("ARTIFACT_EXISTS")
            finally:
                try:
                    os.unlink(pending, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass
        else:
            os.replace(pending, path.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
    except Exception:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(pending, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        raise
    finally:
        os.close(parent_fd)


def guard_qrp_var(config, is_writable=None, expected_paths=None):
    """Validate the ops-produced switch evidence before any ledger operation."""
    required = ("authority_marker", "authoritative_dir", "linux_manifest", "mac_manifest", "mac_mode_proof")
    if not isinstance(config, dict) or any(not isinstance(config.get(k), str) or not config[k] for k in required):
        _fail("QRP_VAR_GUARD_INVALID")
    expected = expected_paths or {
        "authority_marker": AUTHORITY_MARKER, "authoritative_dir": VAR_ROOT,
        "linux_manifest": LINUX_MANIFEST, "mac_manifest": MAC_MANIFEST,
        "mac_mode_proof": MAC_MODE_PROOF, "mac_var_path": MAC_VAR_PATH,
    }
    if any(config.get(key) != expected.get(key) for key in required):
        _fail("QRP_VAR_GUARD_INVALID")
    authority = pathlib.Path(config["authoritative_dir"])
    authority_fd = None
    try:
        authority_fd = _open_dir_nofollow(authority)
    except (OSError, RelayError):
        _fail("QRP_VAR_AUTHORITY_NOT_WRITABLE")
    finally:
        if authority_fd is not None:
            os.close(authority_fd)
    _read_regular_nofollow(config["authority_marker"], 4096, "QRP_VAR_AUTHORITY_MISSING")
    writable = is_writable or (lambda p: os.access(str(p), os.W_OK))
    if not writable(authority):
        _fail("QRP_VAR_AUTHORITY_NOT_WRITABLE")
    linux_manifest, _ = _read_regular_nofollow(config["linux_manifest"], 64 * 1024 * 1024, "QRP_VAR_MANIFEST_MISMATCH")
    mac_manifest, _ = _read_regular_nofollow(config["mac_manifest"], 64 * 1024 * 1024, "QRP_VAR_MANIFEST_MISMATCH")
    if not linux_manifest or linux_manifest != mac_manifest:
        _fail("QRP_VAR_MANIFEST_MISMATCH")
    try:
        proof_bytes, _ = _read_regular_nofollow(config["mac_mode_proof"], 64 * 1024, "QRP_VAR_DUAL_WRITABLE")
        proof = json.loads(proof_bytes)
    except (RelayError, UnicodeError, ValueError):
        _fail("QRP_VAR_DUAL_WRITABLE")
    if (not isinstance(proof, dict) or proof.get("schema") != "QRP_MAC_VAR_MODE_PROOF_V1"
            or proof.get("path") != expected["mac_var_path"]
            or proof.get("writable") is not False):
        _fail("QRP_VAR_DUAL_WRITABLE")
    return authority


def verify_qrp_checkout(qrp_root, pinned, run=subprocess.run, path_check=None):
    qrp_root = pathlib.Path(qrp_root)
    expected = pathlib.Path(CODE_ROOT) / pinned
    if not SHA64.fullmatch(pinned) or qrp_root != expected or qrp_root.is_symlink():
        _fail("QRP_PIN_INVALID")
    if path_check is None:
        try:
            fd = _open_dir_nofollow(qrp_root)
            os.close(fd)
        except (OSError, RelayError):
            _fail("QRP_PIN_INVALID")
    elif not path_check(qrp_root):
        _fail("QRP_PIN_INVALID")
    commands = (
        ["/usr/bin/git", "-C", str(qrp_root), "rev-parse", "HEAD"],
        ["/usr/bin/git", "-C", str(qrp_root), "status", "--porcelain", "--untracked-files=no"],
    )
    outputs = []
    for argv in commands:
        try:
            result = run(argv, capture_output=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            _fail("QRP_PIN_INVALID")
        if result.returncode != 0:
            _fail("QRP_PIN_INVALID")
        output = result.stdout.decode("ascii", "strict") if isinstance(result.stdout, bytes) else result.stdout
        outputs.append(output.strip())
    if outputs != [pinned, ""]:
        _fail("QRP_PIN_INVALID")
    return qrp_root


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
    if not SAFE_JSON.fullmatch(source.name):
        _fail("LOCAL_SOURCE_INVALID")
    data, source_identity = _read_regular_nofollow(source, MAX_PACK_BYTES, "LOCAL_SOURCE_UNREADABLE")
    invalid = validator(data)
    if invalid:
        _fail("PACK_INVALID:%s" % invalid)
    code = marker(data)
    if code:
        _fail("SEEN_MARK_FAILED:%s" % code)
    digest = _sha(data)
    existing, _ = _read_regular_nofollow(destination, MAX_PACK_BYTES, "LOCAL_DEST_SHA_MISMATCH", missing_ok=True)
    if existing is not None:
        if _sha(existing) != digest:
            _fail("LOCAL_DEST_SHA_MISMATCH")
        _unlink_if_same(source, source_identity, "LOCAL_SOURCE_CHANGED")
        return "REPLAY"
    _atomic_write(destination, data, mode=0o640)
    published, _ = _read_regular_nofollow(destination, MAX_PACK_BYTES, "LOCAL_DEST_VERIFY_FAILED")
    if _sha(published) != digest:
        _fail("LOCAL_DEST_VERIFY_FAILED")
    _unlink_if_same(source, source_identity, "LOCAL_SOURCE_CHANGED")
    return "DELIVERED"


class GateRsyncTransport:
    """Rsync client whose remote command bytes are admitted only by #132."""
    def __init__(self, target, rsync="/usr/bin/rsync", run=subprocess.run):
        if target != HK_GATE_TARGET:
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
        self._run([self.rsync, "-a", "--checksum", "--delay-updates", "--", str(stage) + "/", self.target + ":fact-packs/"])

    def pull_returns(self, destination):
        destination = pathlib.Path(destination)
        destination.mkdir(parents=True, exist_ok=True)
        self._run([self.rsync, "-a", "--checksum", "--", self.target + ":" + HK_OUTBOX, str(destination) + "/"])


def _copy_return(source, destination):
    source, destination = pathlib.Path(source), pathlib.Path(destination)
    if not SAFE_JSON.fullmatch(source.name):
        _fail("RETURN_FILE_INVALID")
    data, _ = _read_regular_nofollow(source, MAX_PACK_BYTES, "RETURN_FILE_INVALID")
    existing, _ = _read_regular_nofollow(destination, MAX_PACK_BYTES, "RETURN_DEST_SHA_MISMATCH", missing_ok=True)
    if existing is not None:
        if existing != data:
            _fail("RETURN_DEST_SHA_MISMATCH")
        return "REPLAY"
    _atomic_write(destination, data, mode=0o640)
    published, _ = _read_regular_nofollow(destination, MAX_PACK_BYTES, "RETURN_DEST_VERIFY_FAILED")
    if _sha(published) != _sha(data):
        _fail("RETURN_DEST_VERIFY_FAILED")
    return "COPIED"


def _load_json(path, default):
    try:
        data, _ = _read_regular_nofollow(path, 16 * 1024 * 1024, "STATE_FILE_INVALID", missing_ok=True)
        if data is None:
            return default
        value = json.loads(data)
        return value if isinstance(value, dict) else default
    except (UnicodeError, ValueError):
        return default


def _load_pack_validator(qrp_root):
    package_root = pathlib.Path(qrp_root) / "services/research-queue"
    sys.path.insert(0, str(package_root))
    try:
        return importlib.import_module("rq.relay")._valid_pack
    except (ImportError, AttributeError):
        _fail("PACK_VALIDATOR_UNAVAILABLE")


def _config_from_env(env, pin_check=verify_qrp_checkout):
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
    pin_check(qrp_root, pinned)
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
            "authority_marker": env["QRP_AUTHORITY_MARKER"], "authoritative_dir": VAR_ROOT,
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
                if not SAFE_JSON.fullmatch(source.name):
                    _fail("HK_SOURCE_INVALID")
                data, _ = _read_regular_nofollow(source, MAX_PACK_BYTES, "HK_SOURCE_INVALID")
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
                source_data, _ = _read_regular_nofollow(source, MAX_PACK_BYTES, "RETURN_FILE_INVALID")
                state["returns"][_sha(source_data)] = "hk/%s" % source.name
                result["returnsCopied"] += 1
        except RelayError as error:
            result["failed"].append(["hk", "outbox", str(error)])

    local_returns = pathlib.Path(config["queue_outbox"])
    for source in sorted(local_returns.glob("*.json")) if local_returns.is_dir() else []:
        try:
            _copy_return(source, pathlib.Path(config["return_root"]) / "linux" / source.name)
            source_data, _ = _read_regular_nofollow(source, MAX_PACK_BYTES, "RETURN_FILE_INVALID")
            state["returns"][_sha(source_data)] = "linux/%s" % source.name
            result["returnsCopied"] += 1
        except RelayError as error:
            result["failed"].append(["linux", source.name, str(error)])
    _atomic_write(config["state_path"], (json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n").encode(), mode=0o600)
    return result


def dry_run_plan(config):
    """Read-only inventory: no marker, transport, state or status write."""
    result = {"mode": "DRY_RUN", "wouldUpload": False, "localPacks": [], "hkPacks": [],
              "w05": {"authority": config["authority"], "node": config["node"], "producerHookRoot": None}}
    for host, key in (("linux", "localPacks"), ("hk", "hkPacks")):
        root = pathlib.Path(config["outbox_root"]) / host / "REVIEW_AI_FACT_PACK_V1"
        for source in sorted(root.glob("*.json")) if root.is_dir() else []:
            try:
                info = source.lstat()
                if source.is_symlink() or not stat.S_ISREG(info.st_mode) or not SAFE_JSON.fullmatch(source.name) or info.st_size > MAX_PACK_BYTES:
                    continue
                data, _ = _read_regular_nofollow(source, MAX_PACK_BYTES, "LOCAL_SOURCE_INVALID")
                result[key].append({"name": source.name, "sha256": _sha(data)})
            except (OSError, RelayError):
                continue
    return result


def run_shadow(config, shadow_root, run=subprocess.run, scratch_root="/srv/research-lane/scratch"):
    """Pull-only pre-switch comparison under Linux scratch; never mark/upload."""
    shadow_root = pathlib.Path(shadow_root).resolve()
    scratch = pathlib.Path(scratch_root).resolve()
    if shadow_root == scratch or scratch not in shadow_root.parents:
        _fail("SHADOW_ROOT_OUTSIDE_SCRATCH")
    shadow_root.mkdir(parents=True, exist_ok=True)
    result = dry_run_plan(config)
    result["mode"] = "SHADOW_NO_UPLOAD"
    result["returns"] = {"linux": [], "hk": []}
    for source in sorted(pathlib.Path(config["queue_outbox"]).glob("*.json")):
        destination = shadow_root / "research-queue-return/linux" / source.name
        _copy_return(source, destination)
        source_data, _ = _read_regular_nofollow(source, MAX_PACK_BYTES, "RETURN_FILE_INVALID")
        result["returns"]["linux"].append({"name": source.name, "sha256": _sha(source_data)})
    with tempfile.TemporaryDirectory(prefix="q137-shadow-", dir=str(shadow_root)) as temp:
        pull = pathlib.Path(temp) / "hk"
        GateRsyncTransport(config["hk_target"], run=run).pull_returns(pull)
        for source in sorted(pull.glob("*.json")):
            destination = shadow_root / "research-queue-return/hk" / source.name
            _copy_return(source, destination)
            source_data, _ = _read_regular_nofollow(source, MAX_PACK_BYTES, "RETURN_FILE_INVALID")
            result["returns"]["hk"].append({"name": source.name, "sha256": _sha(source_data)})
    return result


def _write_status(path, rc, result=None, error=None):
    body = {"schema": "Q137_RELAY_STATUS_V1", "lastOkAt": datetime.now(timezone.utc).isoformat() if rc == 0 else None,
            "rc": rc, "counts": result or {}, "error": error}
    _atomic_write(path, (json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode(), mode=0o640)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--shadow-root")
    args = parser.parse_args(argv)
    if sum(bool(x) for x in (args.once, args.dry_run, args.shadow_root)) != 1:
        parser.error("choose exactly one of --once, --dry-run or --shadow-root")
    if args.shadow_root and not args.no_upload:
        parser.error("--shadow-root requires --no-upload")
    status = os.environ.get("RQ_RELAY_STATUS", "/srv/research-lane/ops-logs/research-queue-relay/status.json")
    try:
        config = _config_from_env(os.environ)
        if args.dry_run:
            print(json.dumps(dry_run_plan(config), sort_keys=True, separators=(",", ":")))
            return 0
        if args.shadow_root:
            print(json.dumps(run_shadow(config, args.shadow_root), sort_keys=True, separators=(",", ":")))
            return 0
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
