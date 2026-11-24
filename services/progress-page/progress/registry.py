"""Build and atomically write PROGRESS_REGISTRY_V1."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

from . import SCHEMA, sources
from .config import validate


ORDER = (
    ("S1", "S1_JOBS", "运行态作业心跳", sources.read_s1),
    ("S2", "S2_AQ_LINUX", "自主研究队列（Linux）", sources.read_s2),
    ("S3", "S3_RF1116", "RF1116 挖掘轮次", sources.read_s3),
    ("S4", "S4_SEALED_VERDICTS", "封存结论", sources.read_s4),
    ("S5", "S5_RUT1", "RUT1 前向运行", sources.read_s5),
    ("S7", "S7_PLAN_SNAPSHOT", "计划冻结快照（11-25 冻结，之后不再更新）", sources.read_s7),
)
STATES = ("OK", "ZERO", "STALE", "MISSING", "UNKNOWN", "NOT_APPLICABLE")


def _not_configured(key, title):
    return sources.section(key, title, "UNKNOWN", "NOT_CONFIGURED", [], None)


def _config_digest(cfg):
    if cfg.get("_config_sha256"):
        return cfg["_config_sha256"]
    public = {k: v for k, v in cfg.items() if not str(k).startswith("_")}
    raw = json.dumps(public, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def build(cfg: dict, now) -> dict:
    validate(cfg)
    specs = cfg.get("sections", {})
    rows = []
    for spec_key, registry_key, title, reader in ORDER:
        spec = specs.get(spec_key)
        rows.append(reader(spec, cfg, now) if isinstance(spec, dict) else _not_configured(registry_key, title))
    rows.append(sources.read_s8())
    s9 = specs.get("S9")
    rows.append(sources.read_s9(s9, cfg, now) if isinstance(s9, dict) else _not_configured("S9_MASTER_TABLE", "研究总表（脚本生成）"))
    counts = {state: sum(row["state"] == state for row in rows) for state in STATES}
    obj = {
        "schema": SCHEMA,
        "generated_at": now.isoformat(timespec="seconds"),
        "generator": {"commit": str(cfg.get("generator_commit", "UNKNOWN"))[:12], "host": "LINUX"},
        "config_sha256": _config_digest(cfg),
        "stale_banner_after_h": cfg.get("stale_banner_after_h", 3),
        "sections": rows,
        "sections_by_state": counts,
    }
    raw = json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    obj["registry_sha256"] = hashlib.sha256(raw).hexdigest()
    return obj


def write_atomic(obj: dict, path: str | Path) -> str:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True) + "\n").encode()
    fd, tmp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp_name, target)
        try:
            dir_fd = os.open(target.parent, os.O_RDONLY)
            try: os.fsync(dir_fd)
            finally: os.close(dir_fd)
        except OSError:
            pass
    except Exception:
        try: os.unlink(tmp_name)
        except OSError: pass
        raise
    return hashlib.sha256(raw).hexdigest()
