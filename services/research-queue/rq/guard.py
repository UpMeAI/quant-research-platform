"""Path guards and the secret scan. The queue never reads or writes the failed lane2, V6 production storage or the master table."""
import os
import pathlib
import re

FORBIDDEN_PREFIXES = ("/srv/research-lane2", "/srv/v6-prod")
MASTER_TABLE_PREFIX = "RESEARCH_MASTER_TABLE"
SECRET_RE = re.compile(rb"sk-[A-Za-z0-9]{16,}")


class PathForbidden(Exception):
    pass


def _norm(p):
    return os.path.realpath(os.path.normpath(str(p)))


def check_path(p):
    for cand in {os.path.normpath(str(p)), _norm(p)}:
        for f in FORBIDDEN_PREFIXES:
            if cand == f or cand.startswith(f + "/"):
                raise PathForbidden("path is forbidden for the research queue: " + str(p))
    return p


def check_write_path(p):
    check_path(p)
    if os.path.basename(str(p)).startswith(MASTER_TABLE_PREFIX):
        raise PathForbidden("the queue never writes RESEARCH_MASTER_TABLE*: " + str(p))
    return p


def scan_secrets(paths, secret_values=(), max_bytes=256 * 2**20):
    """Return [{file, kind}] for every file under `paths` that holds an `sk-...` token or one of `secret_values`. Hits never repeat the secret."""
    values = [v.encode() for v in secret_values if v and len(v) >= 8]
    hits = []
    for base in paths:
        base = pathlib.Path(base)
        files = [base] if base.is_file() else [f for f in base.rglob("*") if f.is_file() and not f.is_symlink()]
        for f in files:
            try:
                if f.stat().st_size > max_bytes:
                    continue
                data = f.read_bytes()
            except OSError:
                continue
            if SECRET_RE.search(data):
                hits.append({"file": str(f), "kind": "sk_token"})
            elif any(v in data for v in values):
                hits.append({"file": str(f), "kind": "secret_value"})
    return hits
