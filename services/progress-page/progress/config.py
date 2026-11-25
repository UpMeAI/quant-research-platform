"""Loading and validation for PROGRESS_CONFIG_V1."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


class ConfigError(ValueError):
    pass


def validate(cfg: dict) -> dict:
    if not isinstance(cfg, dict) or cfg.get("schema") != "PROGRESS_CONFIG_V1":
        raise ConfigError("SCHEMA_MISMATCH")
    if not isinstance(cfg.get("sections", {}), dict):
        raise ConfigError("SECTIONS_INVALID")
    if not isinstance(cfg.get("upload", {}), dict):
        raise ConfigError("UPLOAD_INVALID")
    try:
        threshold = float(cfg.get("stale_banner_after_h", 3))
    except (TypeError, ValueError) as exc:
        raise ConfigError("STALE_BANNER_INVALID") from exc
    if threshold <= 0:
        raise ConfigError("STALE_BANNER_INVALID")
    return cfg


def load(path: str | Path) -> dict:
    source = Path(path)
    try:
        raw = source.read_bytes()
        cfg = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError("CONFIG_UNREADABLE") from exc
    validate(cfg)
    cfg = dict(cfg)
    cfg["_config_sha256"] = hashlib.sha256(raw).hexdigest()
    cfg["_config_path"] = str(source)
    return cfg
