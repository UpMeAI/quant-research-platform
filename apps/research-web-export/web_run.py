"""Validate one QRP authority, supervise the loopback origin, persist status."""

import argparse
import datetime as dt
import http.client
import json
import os
import signal
import subprocess
import time

import authority
import parity
import status


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


class OriginNotReady(RuntimeError):
    pass


def _fetch(host, port, route):
    connection = http.client.HTTPConnection(host, port, timeout=1)
    try:
        connection.request("GET", route, headers={"Host": f"{host}:{port}", "Connection": "close"})
        response = connection.getresponse()
        return response.status, response.getheader("Content-Type", ""), response.read()
    finally:
        connection.close()


def probe_origin(fetch):
    for route in parity.QRP_ROUTES:
        try:
            code, content_type, body = fetch(route)
        except (OSError, http.client.HTTPException) as exc:
            raise OriginNotReady("QRP_ROUTE_UNREACHABLE:" + route) from exc
        if code != 200:
            raise OriginNotReady("QRP_ROUTE_NOT_200:" + route)
        if not isinstance(content_type, str) or not content_type or not isinstance(body, bytes):
            raise OriginNotReady("QRP_ROUTE_RESPONSE_INVALID:" + route)
    return len(parity.QRP_ROUTES)


def run(env=None, *, check=False, popen=subprocess.Popen, clock=time.monotonic,
        sleep=time.sleep, route_probe=probe_origin):
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
    status.write(config.status, {"schema": "QRP_RESEARCH_WEB_STATUS_V1", "lastOkAt": None,
                                 "rc": None, "state": "STARTING", "counts": {"routes": 0}})
    def forward(signum, _frame):
        if process.poll() is None:
            process.send_signal(signum)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    deadline = clock() + 30
    route_count = 0
    while process.poll() is None and clock() < deadline:
        try:
            route_count = route_probe(lambda route: _fetch(config.host, config.port, route))
            break
        except OriginNotReady:
            pass
        sleep(0.1)
    if process.poll() is not None or route_count != len(parity.QRP_ROUTES):
        if process.poll() is None:
            process.terminate()
        rc = process.wait(timeout=10)
        status.write(config.status, {"schema": "QRP_RESEARCH_WEB_STATUS_V1", "lastOkAt": None,
                                     "rc": rc or 1, "state": "UNKNOWN", "counts": {"routes": 0}})
        return rc or 1
    last_ok = _now()
    status.write(config.status, {"schema": "QRP_RESEARCH_WEB_STATUS_V1", "lastOkAt": last_ok,
                                 "rc": None, "state": "RUNNING", "counts": {"routes": route_count}})
    rc = process.wait()
    status.write(config.status, {"schema": "QRP_RESEARCH_WEB_STATUS_V1", "lastOkAt": last_ok,
                                 "rc": rc, "state": "EXITED", "counts": {"routes": route_count}})
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
