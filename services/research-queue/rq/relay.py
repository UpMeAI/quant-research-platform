"""Mac relay (design section 8.1, "ops (Mac)"): ships bundles from the desk's relay outbox to each host's queue inbox, and returns agent
outboxes to the Mac QRP. Runs from launchd every 15 minutes. Existing ssh aliases only (no new keys). Every transfer is verified on arrival
by sha256 and is idempotent by bundle sha. The transport is injectable; tests use a local stub. Nothing here talks to a database or V6."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys

from . import packshape

NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.json")
SECRET_RE = re.compile(rb"sk-[A-Za-z0-9]{16,}")
SCHEMA = packshape.SCHEMA
HOME = pathlib.Path.home()

DEFAULT_CONFIG = {
    "outbox_root": str(HOME / "Library/Application Support/portfolio-desk/rq-relay-outbox"),
    "return_root": str(HOME / "KaylaProject/quant-research-platform/var/research-queue-return"),
    "state_path": str(HOME / "Library/Application Support/research-queue/relay-state.json"),
    "hosts": {
        "linux": {"ssh": [str(HOME / "bin-v6q0/lx")], "inbox": "/srv/research-lane/research-queue/inbox", "outbox": "/srv/research-lane/research-queue/outbox", "owner": None},
        "hk": {"ssh": ["ssh", "smartflow-vps"], "inbox": "/var/lib/research-queue/inbox", "outbox": "/var/lib/research-queue/outbox", "owner": "research-queue:rq"},
    },
    "bundle_dirs": ["REVIEW_AI_FACT_PACK_V1"],     # outbox_root/<host>/<bundle_dir>/*.json  ->  <host inbox>/fact-packs/
    "inbox_subdir": {"REVIEW_AI_FACT_PACK_V1": "fact-packs"},
}


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


class SshTransport:
    """push: write to a temp name, hash on the remote, and move into place only if the hash equals the expected one."""
    def __init__(self, cfg):
        self.cfg = cfg

    def _ssh(self, host, remote_cmd, stdin=None):
        argv = list(self.cfg["hosts"][host]["ssh"]) + [remote_cmd]
        return subprocess.run(argv, input=stdin, capture_output=True, timeout=120)

    def push(self, host, data, remote_dir, name, expected_sha):
        h = self.cfg["hosts"][host]
        d, tmp = shlex.quote(remote_dir), shlex.quote(".%s.part" % name)
        install = ("install -o %s -g %s -m 0640 %s %s" % (h["owner"].split(":")[0], h["owner"].split(":")[1], tmp, shlex.quote(name))) if h.get("owner") else "mv %s %s" % (tmp, shlex.quote(name))
        cmd = ("set -e; umask 027; mkdir -p %s; cd %s; cat > %s; got=$(sha256sum %s | cut -d' ' -f1); "
               "if [ \"$got\" = %s ]; then %s; rm -f %s; echo \"$got\"; else rm -f %s; echo \"$got\"; fi") % (d, d, tmp, tmp, shlex.quote(expected_sha), install, tmp, tmp)
        r = self._ssh(host, cmd, stdin=data)
        return r.stdout.decode().strip().split("\n")[-1] if r.returncode == 0 else None

    def list_outbox(self, host):
        r = self._ssh(host, "cd %s 2>/dev/null && sha256sum *.json 2>/dev/null || true" % shlex.quote(self.cfg["hosts"][host]["outbox"]))
        out = []
        for line in r.stdout.decode().splitlines():
            p = line.split()
            if len(p) == 2 and NAME_RE.fullmatch(p[1]):
                out.append((p[1], p[0]))
        return out

    def fetch(self, host, name):
        r = self._ssh(host, "cat %s/%s" % (shlex.quote(self.cfg["hosts"][host]["outbox"]), shlex.quote(name)))
        return r.stdout if r.returncode == 0 else None


def _load_state(p):
    try:
        return json.loads(pathlib.Path(p).read_text())
    except (OSError, ValueError):
        return {"pushed": {}, "pulled": {}}


def _save_state(p, st):
    p = pathlib.Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, sort_keys=True, indent=1))
    os.replace(tmp, p)


def _valid_pack(data):
    if SECRET_RE.search(data):
        return "SECRET_PATTERN"
    try:
        j = json.loads(data)
    except ValueError:
        return "NOT_JSON"
    if not packshape.schema_ok(j):
        return "SCHEMA"
    return None


def run(cfg, transport):
    """One relay pass. Returns a summary; failures of one host or file never stop the others."""
    st = _load_state(cfg["state_path"])
    out = {"pushed": [], "skipped": [], "refused": [], "failed": [], "pulled": []}
    for host in cfg["hosts"]:
        pushed = st["pushed"].setdefault(host, {})
        for bd in cfg["bundle_dirs"]:
            src = pathlib.Path(cfg["outbox_root"]) / host / bd
            for f in sorted(src.glob("*.json")) if src.is_dir() else []:
                if not NAME_RE.fullmatch(f.name) or f.is_symlink() or not f.is_file():
                    out["refused"].append([host, f.name, "NAME"])
                    continue
                data = f.read_bytes()
                sha = sha256_bytes(data)
                if pushed.get(sha):
                    out["skipped"].append([host, f.name])
                    continue
                bad = _valid_pack(data)
                if bad:
                    out["refused"].append([host, f.name, bad])
                    continue
                remote_dir = cfg["hosts"][host]["inbox"].rstrip("/") + "/" + cfg["inbox_subdir"][bd]
                try:
                    got = transport.push(host, data, remote_dir, f.name, sha)
                except Exception as e:  # a transport error is a failure of this file only
                    got = None
                if got == sha:
                    pushed[sha] = f.name
                    out["pushed"].append([host, f.name])
                else:
                    out["failed"].append([host, f.name, "VERIFY_FAILED" if got else "TRANSPORT"])
        pulled = st["pulled"].setdefault(host, {})
        try:
            listing = transport.list_outbox(host)
        except Exception:
            out["failed"].append([host, "outbox", "TRANSPORT"])
            continue
        dest = pathlib.Path(cfg["return_root"]) / host
        for name, sha in listing:
            if pulled.get(sha):
                continue
            try:
                data = transport.fetch(host, name)
            except Exception:
                data = None
            if data is None or sha256_bytes(data) != sha:
                out["failed"].append([host, name, "FETCH_VERIFY_FAILED"])
                continue
            dest.mkdir(parents=True, exist_ok=True)
            tmp = dest / (".%s.part" % name)
            tmp.write_bytes(data)
            os.replace(tmp, dest / name)
            pulled[sha] = name
            out["pulled"].append([host, name])
    _save_state(cfg["state_path"], st)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="rq-relay")
    ap.add_argument("--config")
    a = ap.parse_args(argv)
    cfg = dict(DEFAULT_CONFIG)
    if a.config and pathlib.Path(a.config).exists():
        cfg.update(json.loads(pathlib.Path(a.config).read_text()))
    res = run(cfg, SshTransport(cfg))
    print(json.dumps(res))
    return 1 if res["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
