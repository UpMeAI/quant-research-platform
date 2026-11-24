"""Validate one QRP authority, supervise the loopback origin, persist status."""

import argparse
import datetime as dt
import json
import os
import signal
import socket
import subprocess
import time

import authority
import status


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _ready(host, port):
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def run(env=None, *, check=False, popen=subprocess.Popen, clock=time.monotonic, sleep=time.sleep):
    env = dict(os.environ if env is None else env)
    config = authority.validate(env)
    plan = {"mode": config.mode, "root": str(config.root), "varRoot": str(config.var_root), "dataDir": str(config.data_dir), "host": config.host, "port": config.port, "edge": "OFF"}
    if check:
        return {"state": "READY", "plan": plan}
    child_env = dict(env)
    child_env.pop("QRP_RUNTIME_TOKEN", None)
    child_env.pop("QRP_RESEARCH_TOKEN", None)
    argv = [str(config.node), str(config.root / "apps" / "research-api" / "index.js")]
    process = popen(argv, cwd=config.root, env=child_env)
    def forward(signum, _frame):
        if process.poll() is None:
            process.send_signal(signum)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    deadline = clock() + 30
    while process.poll() is None and clock() < deadline and not _ready(config.host, config.port):
        sleep(0.1)
    if process.poll() is not None or not _ready(config.host, config.port):
        if process.poll() is None:
            process.terminate()
        rc = process.wait(timeout=10)
        status.write(config.status, {"schema": "QRP_RESEARCH_WEB_STATUS_V1", "lastOkAt": None, "rc": rc or 1, "state": "START_FAILED", "counts": {"routes": 0}})
        return rc or 1
    last_ok = _now()
    status.write(config.status, {"schema": "QRP_RESEARCH_WEB_STATUS_V1", "lastOkAt": last_ok, "rc": None, "state": "RUNNING", "counts": {"routes": 5}})
    rc = process.wait()
    status.write(config.status, {"schema": "QRP_RESEARCH_WEB_STATUS_V1", "lastOkAt": last_ok, "rc": rc, "state": "EXITED", "counts": {"routes": 5}})
    return rc


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    result = run(check=args.check)
    if args.check:
        print(json.dumps(result, sort_keys=True))
        return 0
    return result


if __name__ == "__main__":
    raise SystemExit(main())
