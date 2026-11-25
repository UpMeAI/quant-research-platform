"""Cloudflare Pages publishing with credential isolation and Access fail-closure."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import stat
import subprocess
import urllib.error
import urllib.request
from pathlib import Path


MARKER = b'<meta name="progress-page" content="PROGRESS_REGISTRY_V1">'


def _iso(now):
    return now.isoformat(timespec="seconds")


def _safe_result(state, now, rc=0, reason=None):
    result = {"state": state, "at": _iso(now), "rc": rc}
    if reason:
        result["reason"] = reason
    return result


def _content_digest(site_dir):
    registry = json.loads((site_dir / "registry.json").read_text(encoding="utf-8"))
    registry.pop("generated_at", None)
    registry.pop("registry_sha256", None)
    raw = json.dumps(registry, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def _read_state(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_state(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _token_env(path, node_bin):
    token_file = Path(path)
    try:
        mode = stat.S_IMODE(token_file.stat().st_mode)
    except FileNotFoundError:
        return None, "TOKEN_FILE_ABSENT"
    except OSError:
        return None, "TOKEN_FILE_ABSENT"
    if mode != 0o600:
        return None, "TOKEN_FILE_MODE"
    values = {}
    try:
        for line in token_file.read_text(encoding="utf-8").splitlines():
            if not line or line.lstrip().startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key in {"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"}:
                values[key] = value
    except OSError:
        return None, "TOKEN_FILE_ABSENT"
    if not all(values.get(key) for key in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")):
        return None, "TOKEN_FILE_KEYS"
    return {
        "PATH": str(node_bin), "HOME": os.environ.get("HOME", "/home/kayla"),
        "CLOUDFLARE_API_TOKEN": values["CLOUDFLARE_API_TOKEN"],
        "CLOUDFLARE_ACCOUNT_ID": values["CLOUDFLARE_ACCOUNT_ID"],
    }, None


def _access_check(opener, public_url):
    try:
        response = opener(public_url)
        with response as opened:
            status = getattr(opened, "status", getattr(opened, "code", None))
            url = opened.geturl() if hasattr(opened, "geturl") else public_url
            body = opened.read()
        if status in (401, 403):
            return "PROTECTED"
        if status == 302 and "cloudflareaccess.com" in str(url):
            return "PROTECTED"
        if status == 200 and MARKER in body:
            return "PUBLIC"
        if "cloudflareaccess.com" in str(url):
            return "PROTECTED"
        return "UNREACHABLE"
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return "PROTECTED"
        if exc.code == 302 and "cloudflareaccess.com" in str(exc.headers.get("Location", "")):
            return "PROTECTED"
        return "UNREACHABLE"
    except (urllib.error.URLError, OSError, TimeoutError):
        return "UNREACHABLE"


def publish(site_dir: Path, cfg: dict, state_dir: Path, *, runner=subprocess.run,
            opener=urllib.request.urlopen, now) -> dict:
    site_dir, state_dir = Path(site_dir), Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    if not cfg.get("enabled", False):
        return _safe_result("DISABLED", now)
    if (state_dir / "upload.disabled").exists():
        return _safe_result("DISABLED_LOCKED", now, 4)

    publish_state_path = state_dir / "publish-state.json"
    previous = _read_state(publish_state_path)
    try:
        digest = _content_digest(site_dir)
    except (OSError, json.JSONDecodeError):
        return _safe_result("FAILED", now, 4, "SITE_UNREADABLE")
    last_at = previous.get("last_upload_at")
    if previous.get("content_digest") == digest and last_at:
        try:
            age_h = (now - dt.datetime.fromisoformat(last_at.replace("Z", "+00:00"))).total_seconds() / 3600
        except (ValueError, TypeError):
            age_h = float("inf")
        if age_h < float(cfg.get("min_interval_h", 2)):
            return _safe_result("SKIPPED_UNCHANGED", now)

    env, reason = _token_env(cfg.get("token_env_file", ""), cfg.get("node_bin", ""))
    if reason:
        return _safe_result("FAILED", now, 4, reason)
    argv = [
        str(cfg.get("wrangler")), "pages", "deploy", str(site_dir),
        "--project-name", str(cfg.get("project")), "--branch", "main", "--commit-dirty=true",
    ]
    try:
        completed = runner(argv, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        rc = int(completed.returncode)
    except Exception:
        return _safe_result("FAILED", now, 4, "RUNNER_ERROR")
    if rc != 0:
        return _safe_result("FAILED", now, rc, "WRANGLER_FAILED")

    access = _access_check(opener, cfg.get("public_url"))
    if access == "PUBLIC":
        (state_dir / "upload.disabled").write_text("ACCESS_NOT_ENFORCED\n", encoding="utf-8")
        return _safe_result("ACCESS_NOT_ENFORCED", now, 4)
    if access == "UNREACHABLE":
        return _safe_result("ACCESS_CHECK_UNREACHABLE", now, 0)
    _write_state(publish_state_path, {"content_digest": digest, "last_upload_at": _iso(now)})
    return _safe_result("UPLOADED", now)
