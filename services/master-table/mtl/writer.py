"""Crash-safe, same-filesystem master-table publication."""

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import tempfile

from .errors import MtlError


BASE = "RESEARCH_MASTER_TABLE_20261110"


def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=1) + "\n").encode("utf-8")


def _atomic(path, raw, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if mode is not None:
            os.chmod(temporary, mode)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


@contextmanager
def locked(root):
    state = Path(root) / "state"
    state.mkdir(parents=True, exist_ok=True)
    stream = (state / ".lock").open("a+b")
    try:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise MtlError("LOCKED", 75) from exc
        yield
    finally:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        finally:
            stream.close()


def _rev_path(root, revision, suffix):
    return Path(root) / "revs" / f"{BASE}.rev{revision}.{suffix}"


def _install_revision(path, raw):
    if path.exists():
        try:
            current = path.read_bytes()
        except OSError as exc:
            raise MtlError("REV_EXISTS_DIFFERENT", 5) from exc
        if current != raw:
            raise MtlError("REV_EXISTS_DIFFERENT", 5)
        return
    _atomic(path, raw, 0o444)


def write_status(root, status):
    _atomic(Path(root) / "state" / "run_status.json", _json_bytes(status))


def publish(root, revision, json_bytes, md_bytes, status, last_run=None):
    root = Path(root)
    revisions = (("json", json_bytes), ("md", md_bytes))
    for suffix, raw in revisions:
        _install_revision(_rev_path(root, revision, suffix), raw)
    for suffix, raw in revisions:
        _atomic(root / "live" / f"{BASE}.{suffix}", raw)
    _atomic(root / "state" / "last_run.json", _json_bytes(last_run or status))
    write_status(root, status)
    return status.get("result", "NEW_REV")
