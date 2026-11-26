#!/usr/bin/python3
"""Isolated real-node parity: direct CLI bytes versus #137 runner bytes."""
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import tempfile


HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location("q137_registrar", HERE / "trl-registrar-run.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
FIXED_AT = "2026-11-24T10:02:00+08:00"


def main():
    request = json.loads((HERE / "trl-registrar-fixture-request.json").read_text())
    request_sha = hashlib.sha256(runner.canonical_json(request).encode()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="q137-registrar-real-") as temp:
        base = pathlib.Path(temp)
        source = base / "runs/RQT-Q137/outbox/trl-requests" / (request_sha + ".json")
        source.parent.mkdir(parents=True)
        source.write_text(json.dumps(request, sort_keys=True, separators=(",", ":")) + "\n")
        common_env = {"QRP_PRODUCT_MILESTONE_AUTHORITY": runner.AUTHORITY, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
        direct = subprocess.run([runner.NODE, str(ROOT / "apps/research-cli/k2_trl_registrar.js"), "--request", str(source),
                                 "--registered-by", runner.AUTHORITY, "--registered-at", FIXED_AT],
                                env={**common_env, "QRP_DATA_DIR": str(base / "direct-data")}, capture_output=True, timeout=120)
        if direct.returncode:
            raise SystemExit("DIRECT_FAILED:" + direct.stderr.decode("utf-8", "replace")[:200])
        config = {"run_root": str(base / "runs"), "node": runner.NODE, "qrp_root": str(ROOT), "data_dir": str(base / "runner-data"),
                  "authority": runner.AUTHORITY, "registered_at": FIXED_AT, "max_request_bytes": 1048576}
        receipt = runner.process_request(source, config)
        runner_bytes = receipt.read_bytes()
        if direct.stdout != runner_bytes:
            raise SystemExit("RECEIPT_BYTES_DIFFER")
        for ledger in (base / "direct-data/research/trials.jsonl", base / "runner-data/research/trials.jsonl"):
            if not ledger.is_file():
                raise SystemExit("LEDGER_MISSING")
        value = json.loads(runner_bytes)
        if value.get("request_sha256") != request_sha or value.get("schema") != "TRIAL_REGISTRATION_RECEIPT_V1":
            raise SystemExit("RECEIPT_INVALID")
        print(json.dumps({"schema": "Q137_TRL_REAL_FIXTURE_RESULT_V1", "node": subprocess.check_output([runner.NODE, "--version"], text=True).strip(),
                          "requestSha256": request_sha, "receiptSha256": hashlib.sha256(runner_bytes).hexdigest(),
                          "bytesEqual": True, "rows": len(value["rows"])}, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
