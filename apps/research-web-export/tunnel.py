"""Pinned cloudflared argv builder; token contents are never opened."""

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import signal
import stat
import subprocess
import time

import status


TOKEN_FILE = "/home/kayla/.config/cloudflared/qrp-research-web.token"
STATUS_FILE = "/srv/research-lane/ops-logs/qrp-research-web/tunnel-status.json"
PID_FILE = "/run/user/1000/qrp-research-web/cloudflared.pid"
VERSION = re.compile(r"[0-9]{4}\.[0-9]{1,2}\.[0-9]+")
SHA64 = re.compile(r"[0-9a-f]{64}")


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

    def binary_sha256(self, path):
        digest = hashlib.sha256()
        try:
            with pathlib.Path(path).open("rb") as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(block)
        except OSError:
            return None
        return digest.hexdigest()

    def runtime_directory_ready(self, path):
        try:
            info = pathlib.Path(path).lstat()
        except OSError:
            return False
        return (stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                and stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == os.getuid())


def command(env=None, *, facts=None):
    env = dict(os.environ if env is None else env)
    facts = facts or ProductionFacts()
    if env.get("QRP_WEB_EDGE", "OFF") != "ON":
        _fail("QRP_EDGE_DISABLED")
    binary = env.get("QRP_CLOUDFLARED_BIN", "")
    version = env.get("QRP_CLOUDFLARED_VERSION", "")
    expected_sha = env.get("QRP_CLOUDFLARED_SHA256", "")
    token = env.get("QRP_CLOUDFLARED_TOKEN_FILE", "")
    pid_file = env.get("QRP_TUNNEL_PID_FILE", "")
    if not VERSION.fullmatch(version) or binary != f"/srv/research-lane/tools/cloudflared-{version}/cloudflared":
        _fail("QRP_CLOUDFLARED_VERSION_MISMATCH")
    if not facts.is_file(binary):
        _fail("QRP_CLOUDFLARED_BINARY_INVALID")
    if not SHA64.fullmatch(expected_sha) or facts.binary_sha256(binary) != expected_sha:
        _fail("QRP_CLOUDFLARED_SHA256_MISMATCH")
    if token != TOKEN_FILE:
        _fail("QRP_TUNNEL_TOKEN_PATH_INVALID")
    if pid_file != PID_FILE:
        _fail("QRP_TUNNEL_PID_PATH_INVALID")
    metadata = facts.token_metadata(token)
    if not metadata.get("regular") or metadata.get("symlink"):
        _fail("QRP_TUNNEL_TOKEN_INVALID")
    if metadata.get("mode") != 0o600:
        _fail("QRP_TUNNEL_TOKEN_MODE")
    return [binary, "tunnel", "--no-autoupdate", "run", "--pidfile", pid_file, "--token-file", token]


def _pid_ready(path, pid):
    target = pathlib.Path(path)
    try:
        info = target.lstat()
        return (stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                and target.read_text(encoding="ascii").strip() == str(pid))
    except (OSError, UnicodeError):
        return False


def run(env=None, *, check=False, facts=None, popen=subprocess.Popen,
        ready=_pid_ready, clock=time.monotonic, sleep=time.sleep):
    env = dict(os.environ if env is None else env)
    facts = facts or ProductionFacts()
    argv = command(env, facts=facts)
    status_file = env.get("QRP_TUNNEL_STATUS", "")
    if status_file != STATUS_FILE:
        _fail("QRP_TUNNEL_STATUS_INVALID")
    if not facts.runtime_directory_ready(pathlib.Path(PID_FILE).parent):
        _fail("QRP_TUNNEL_RUNTIME_DIR_INVALID")
    plan = {"edge": "ON", "binary": argv[0], "binarySha256": env["QRP_CLOUDFLARED_SHA256"],
            "version": env["QRP_CLOUDFLARED_VERSION"], "tokenFile": TOKEN_FILE,
            "pidFile": PID_FILE}
    if check:
        return {"state": "READY", "plan": plan}
    status.write(status_file, {"schema": "QRP_TUNNEL_STATUS_V1", "lastOkAt": None,
                               "rc": None, "state": "STARTING", "counts": {"processes": 0}})
    process = popen(argv)
    def forward(signum, _frame):
        if process.poll() is None:
            process.send_signal(signum)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    deadline = clock() + 30
    verified = False
    while process.poll() is None and clock() < deadline:
        if ready(PID_FILE, process.pid):
            verified = True
            break
        sleep(0.1)
    if process.poll() is not None or not verified:
        if process.poll() is None:
            process.terminate()
        rc = process.wait(timeout=10)
        status.write(status_file, {"schema": "QRP_TUNNEL_STATUS_V1", "lastOkAt": None,
                                   "rc": rc or 1, "state": "UNKNOWN", "counts": {"processes": 0}})
        return rc or 1
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
