"""Pinned cloudflared argv builder; token contents are never opened."""

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import signal
import stat
import subprocess

import status


TOKEN_FILE = "/home/kayla/.config/cloudflared/qrp-research-web.token"
STATUS_FILE = "/srv/research-lane/ops-logs/qrp-research-web/tunnel-status.json"
BIN = re.compile(r"/srv/research-lane/tools/cloudflared-[A-Za-z0-9._-]+/cloudflared")


class TunnelError(RuntimeError):
    pass


def _fail(code):
    raise TunnelError(code)


class ProductionFacts:
    def is_file(self, path):
        return pathlib.Path(path).is_file() and not pathlib.Path(path).is_symlink()

    def token_metadata(self, path):
        try:
            info = pathlib.Path(path).lstat()
        except OSError:
            return {"regular": False, "symlink": False, "mode": None}
        return {"regular": stat.S_ISREG(info.st_mode), "symlink": stat.S_ISLNK(info.st_mode), "mode": stat.S_IMODE(info.st_mode)}


def command(env=None, *, facts=None):
    env = dict(os.environ if env is None else env)
    facts = facts or ProductionFacts()
    if env.get("QRP_WEB_EDGE", "OFF") != "ON":
        _fail("QRP_EDGE_DISABLED")
    binary = env.get("QRP_CLOUDFLARED_BIN", "")
    token = env.get("QRP_CLOUDFLARED_TOKEN_FILE", "")
    if not BIN.fullmatch(binary) or not facts.is_file(binary):
        _fail("QRP_CLOUDFLARED_BINARY_INVALID")
    if token != TOKEN_FILE:
        _fail("QRP_TUNNEL_TOKEN_PATH_INVALID")
    metadata = facts.token_metadata(token)
    if not metadata.get("regular") or metadata.get("symlink"):
        _fail("QRP_TUNNEL_TOKEN_INVALID")
    if metadata.get("mode") != 0o600:
        _fail("QRP_TUNNEL_TOKEN_MODE")
    return [binary, "tunnel", "--no-autoupdate", "run", "--token-file", token]


def run(env=None, *, check=False, facts=None, popen=subprocess.Popen):
    env = dict(os.environ if env is None else env)
    argv = command(env, facts=facts)
    status_file = env.get("QRP_TUNNEL_STATUS", "")
    if status_file != STATUS_FILE:
        _fail("QRP_TUNNEL_STATUS_INVALID")
    plan = {"edge": "ON", "binary": argv[0], "tokenFile": TOKEN_FILE}
    if check:
        return {"state": "READY", "plan": plan}
    process = popen(argv)
    def forward(signum, _frame):
        if process.poll() is None:
            process.send_signal(signum)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    last_ok = dt.datetime.now(dt.timezone.utc).isoformat()
    status.write(status_file, {"schema": "QRP_TUNNEL_STATUS_V1", "lastOkAt": last_ok, "rc": None, "state": "RUNNING", "counts": {"processes": 1}})
    rc = process.wait()
    status.write(status_file, {"schema": "QRP_TUNNEL_STATUS_V1", "lastOkAt": last_ok, "rc": rc, "state": "EXITED", "counts": {"processes": 0}})
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
