#!/usr/bin/python3
"""Register queued W24 TRL requests against the one authoritative QRP var."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import re
import stat
import subprocess
import sys
from datetime import datetime, timezone
from decimal import Decimal


HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("q137_relay_guard", HERE / "relay-run.py")
_guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_guard)

NODE = _guard.NODE
DATA_DIR = _guard.DATA_DIR
AUTHORITY = _guard.AUTHORITY
SHA_NAME = re.compile(r"([0-9a-f]{64})[.]json")


class RegistrarError(RuntimeError):
    pass


def _fail(code):
    raise RegistrarError(code)


def _js_number(value):
    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    absolute = abs(value)
    raw = repr(value).lower()
    if 1e-6 <= absolute < 1e21:
        return format(Decimal(raw), "f").rstrip("0").rstrip(".")
    mantissa, exponent = raw.split("e")
    mantissa = mantissa.rstrip("0").rstrip(".")
    exp = int(exponent)
    return "%se%s%d" % (mantissa, "+" if exp >= 0 else "", exp)


def canonical_json(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(canonical_json(key) + ":" + canonical_json(value[key]) for key in sorted(value)) + "}"
    _fail("TRL_REQUEST_INVALID")


def _under(root, path):
    root, path = pathlib.Path(root).resolve(), pathlib.Path(path).resolve()
    return path == root or root in path.parents


def _validate_receipt(data, expected):
    try:
        value = json.loads(data)
    except (UnicodeError, ValueError):
        _fail("TRL_RECEIPT_INVALID")
    if (not isinstance(value, dict) or value.get("schema") != "TRIAL_REGISTRATION_RECEIPT_V1"
            or value.get("request_sha256") != expected or not isinstance(value.get("rows"), list)):
        _fail("TRL_RECEIPT_INVALID")
    return value


def _publish_receipt(path, data):
    path = pathlib.Path(path)
    if path.exists():
        if path.is_symlink() or not path.is_file() or path.read_bytes() != data:
            _fail("TRL_RECEIPT_REPLAY_MISMATCH")
        os.chmod(str(path), 0o444)
        return path
    try:
        _guard._atomic_write(path, data, mode=0o444, create_only=True)
    except _guard.RelayError as error:
        if str(error) != "ARTIFACT_EXISTS" or path.read_bytes() != data:
            _fail("TRL_RECEIPT_REPLAY_MISMATCH")
    return path


def process_request(request_file, config, run=subprocess.run):
    request_file = pathlib.Path(request_file)
    run_root = pathlib.Path(config.get("run_root", "")).resolve()
    try:
        resolved = request_file.resolve(strict=True)
        info = request_file.lstat()
    except OSError:
        _fail("TRL_REQUEST_NOT_REGULAR")
    if not _under(run_root, resolved):
        _fail("TRL_REQUEST_OUTSIDE_RUN_ROOT")
    if request_file.is_symlink() or not stat.S_ISREG(info.st_mode):
        _fail("TRL_REQUEST_NOT_REGULAR")
    relative = resolved.relative_to(run_root)
    if len(relative.parts) != 4 or relative.parts[1:3] != ("outbox", "trl-requests") or not re.fullmatch(r"[A-Za-z0-9_.:-]+", relative.parts[0]):
        _fail("TRL_REQUEST_OUTSIDE_RUN_ROOT")
    match = SHA_NAME.fullmatch(request_file.name)
    if not match or info.st_size > int(config.get("max_request_bytes", 1048576)):
        _fail("TRL_REQUEST_INVALID")
    try:
        request = json.loads(request_file.read_text())
    except (OSError, UnicodeError, ValueError):
        _fail("TRL_REQUEST_INVALID")
    digest = hashlib.sha256(canonical_json(request).encode("utf-8")).hexdigest()
    if digest != match.group(1):
        _fail("TRL_REQUEST_SHA_MISMATCH")
    receipt = run_root / relative.parts[0] / "inbox" / "trl-receipts" / request_file.name
    if receipt.exists():
        data = receipt.read_bytes()
        try:
            _validate_receipt(data, digest)
        except RegistrarError:
            _fail("TRL_RECEIPT_REPLAY_MISMATCH")
        return _publish_receipt(receipt, data)

    node = config.get("node")
    qrp_root = pathlib.Path(config.get("qrp_root", ""))
    data_dir = config.get("data_dir")
    authority = config.get("authority")
    if node != NODE or not pathlib.Path(data_dir or "").is_absolute() or authority != AUTHORITY or not qrp_root.is_absolute():
        _fail("TRL_CONFIG_INVALID")
    argv = [node, str(qrp_root / "apps/research-cli/k2_trl_registrar.js"), "--request", str(resolved), "--registered-by", authority]
    if config.get("registered_at"):
        argv.extend(["--registered-at", config["registered_at"]])
    env = {"QRP_DATA_DIR": data_dir, "QRP_PRODUCT_MILESTONE_AUTHORITY": authority, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    try:
        result = run(argv, capture_output=True, timeout=120, env=env)
    except (OSError, subprocess.SubprocessError):
        _fail("TRL_REGISTRAR_UNAVAILABLE")
    if result.returncode != 0:
        _fail("TRL_REGISTRAR_FAILED")
    data = result.stdout
    _validate_receipt(data, digest)
    if not data.endswith(b"\n") or data.count(b"\n") != 1:
        _fail("TRL_RECEIPT_INVALID")
    return _publish_receipt(receipt, data)


def _config_from_env(env):
    expected = {"QRP_DATA_DIR": DATA_DIR, "QRP_PRODUCT_MILESTONE_AUTHORITY": AUTHORITY, "RQ_NODE": NODE}
    for key, value in expected.items():
        if env.get(key) != value:
            _fail("ENV_INVALID:%s" % key)
    qrp_root, pinned = env.get("QRP_ROOT", ""), env.get("QRP_PINNED_SHA", "")
    if not re.fullmatch(r"[0-9a-f]{64}", pinned) or pathlib.Path(qrp_root).name != pinned:
        _fail("QRP_PIN_INVALID")
    required = ("RQ_RUN_ROOT", "RQ_REGISTRAR_STATUS", "QRP_AUTHORITY_MARKER", "QRP_VAR_LINUX_MANIFEST", "QRP_VAR_MAC_MANIFEST", "QRP_MAC_VAR_MODE_PROOF")
    if any(not env.get(key) for key in required):
        _fail("ENV_MISSING")
    return {
        "run_root": env["RQ_RUN_ROOT"], "status_path": env["RQ_REGISTRAR_STATUS"], "node": NODE,
        "qrp_root": qrp_root, "data_dir": DATA_DIR, "authority": AUTHORITY, "max_request_bytes": 1048576,
        "guard": {"authority_marker": env["QRP_AUTHORITY_MARKER"], "authoritative_dir": _guard.VAR_ROOT,
                  "linux_manifest": env["QRP_VAR_LINUX_MANIFEST"], "mac_manifest": env["QRP_VAR_MAC_MANIFEST"],
                  "mac_mode_proof": env["QRP_MAC_VAR_MODE_PROOF"]},
    }


def _write_status(path, rc, counts, error=None):
    body = {"schema": "Q137_TRL_REGISTRAR_STATUS_V1", "lastOkAt": datetime.now(timezone.utc).isoformat() if rc == 0 else None,
            "rc": rc, "counts": counts, "error": error}
    _guard._atomic_write(path, (json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode(), mode=0o640)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    if not args.once:
        parser.error("--once is required")
    status = os.environ.get("RQ_REGISTRAR_STATUS", "/srv/research-lane/ops-logs/trl-registrar/status.json")
    counts = {"processed": 0, "failed": 0}
    try:
        config = _config_from_env(os.environ)
        _guard.guard_qrp_var(config["guard"])
        root = pathlib.Path(config["run_root"])
        failures = []
        for request in sorted(root.glob("*/outbox/trl-requests/*.json")) if root.is_dir() else []:
            try:
                process_request(request, config)
                counts["processed"] += 1
            except RegistrarError as error:
                counts["failed"] += 1
                failures.append([request.name, str(error)])
        rc = 1 if failures else 0
        _write_status(status, rc, counts, error=failures or None)
        print(json.dumps({"counts": counts, "failed": failures}, sort_keys=True, separators=(",", ":")))
        return rc
    except Exception as error:
        _write_status(status, 1, counts, error=str(error)[:240])
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
