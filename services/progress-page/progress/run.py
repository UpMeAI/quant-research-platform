"""One deterministic progress-page generation and optional publication."""

from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
import re
import tempfile
from pathlib import Path

from . import config, registry, render, publish


FORBIDDEN = (
    re.compile(r"sk-[A-Za-z0-9]{16,}"),
    re.compile(r"CLOUDFLARE_API_TOKEN"),
    re.compile(r"BEGIN .*PRIVATE KEY"),
    re.compile(r"/srv/v6-prod"),
)


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=1) + "\n").encode()
    fd, temp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        os.replace(temp, path)
    except Exception:
        try: os.unlink(temp)
        except OSError: pass
        raise


def _write_text(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(value, encoding="utf-8")
    os.replace(tmp, path)


def _scan(*values):
    return any(pattern.search(value) for value in values for pattern in FORBIDDEN)


def _status(state_dir, now, rc, reg=None, upload=None):
    old = {}
    path = state_dir / "status.json"
    try: old = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError): pass
    value = {
        "lastOkAt": now.isoformat(timespec="seconds") if rc == 0 else old.get("lastOkAt"),
        "rc": rc,
        "registry_sha256": reg.get("registry_sha256") if reg else old.get("registry_sha256"),
        "sections_by_state": reg.get("sections_by_state") if reg else old.get("sections_by_state"),
        "upload": upload,
    }
    _write_json(path, value)


def run_once(config_path, *, now=None, build_fn=registry.build, render_fn=render.render,
             publish_fn=publish.publish, lock_held=False):
    now = now or dt.datetime.now().astimezone()
    try:
        cfg = config.load(config_path)
    except config.ConfigError:
        return 2
    if not cfg.get("out_dir") or not cfg.get("state_dir"):
        return 2
    out_dir = Path(cfg.get("out_dir", ""))
    state_dir = Path(cfg.get("state_dir", ""))
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_handle = (state_dir / "run.lock").open("a+")
    try:
        if not lock_held:
            try:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0
        try:
            reg = build_fn(cfg, now)
            html = render_fn(reg)
            registry_text = json.dumps(reg, ensure_ascii=False, sort_keys=True, indent=1) + "\n"
            site = out_dir / "site"
            site.mkdir(parents=True, exist_ok=True)
            registry.write_atomic(reg, out_dir / "registry.json")
            registry.write_atomic(reg, site / "registry.json")
            _write_text(site / "index.html", html)
        except Exception:
            _status(state_dir, now, 3, upload={"state": "NOT_ATTEMPTED", "at": now.isoformat(timespec="seconds"), "rc": 3})
            return 3
        if _scan(html, registry_text):
            upload = {"state": "NOT_ATTEMPTED", "reason": "FORBIDDEN_TOKEN", "at": now.isoformat(timespec="seconds"), "rc": 3}
            _status(state_dir, now, 3, reg, upload)
            return 3
        upload = publish_fn(site, cfg.get("upload", {}), state_dir, now=now)
        failed = upload.get("state") in {"FAILED", "ACCESS_NOT_ENFORCED", "DISABLED_LOCKED"}
        rc = 4 if failed else 0
        _status(state_dir, now, rc, reg, upload)
        return rc
    finally:
        lock_handle.close()
