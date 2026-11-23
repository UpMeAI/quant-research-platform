#!/usr/bin/env python3
"""Deterministic HEAVY_DRIVER_V1 stub. It never opens Docker, systemd, or a database."""
import json
import os
import pathlib
import sys


def main(argv):
    exit_code = int(argv[1]) if len(argv) > 1 else 0
    reason = argv[2] if len(argv) > 2 else ("COMPLETE" if exit_code == 0 else "STUB")
    total = int(os.environ.get("STUB_SESSIONS_TOTAL", "2"))
    done = total if exit_code == 0 else int(os.environ.get("STUB_SESSIONS_DONE", "1"))
    payload = {
        "exit": exit_code,
        "sessions_done": done,
        "sessions_total": total,
        "last_date": "2026-11-24" if done else None,
        "reason": reason,
        "dbReadOnlyProbe": json.loads(os.environ["STUB_DB_PROBE"]) if "STUB_DB_PROBE" in os.environ else None,
    }
    out = pathlib.Path(os.environ["RQ_ATTEMPT_DIR"]) / "driver-result.json"
    with out.open("x") as f:
        json.dump(payload, f, sort_keys=True, separators=(",", ":"))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
