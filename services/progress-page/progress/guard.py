"""Fail-closed path guard for progress-page source reads."""

from __future__ import annotations

import os
from pathlib import Path, PurePath


class PathForbidden(ValueError):
    reason = "PATH_FORBIDDEN"


MASTER_TABLE_FILES = {
    "/srv/research-lane/master-table/live/RESEARCH_MASTER_TABLE_20261110.json",
    "/srv/research-lane/master-table/state/run_status.json",
}
QRP_LEDGER_FILES = {
    "ashare_sealed_verdicts.jsonl",
    "overseas_sealed_verdicts.jsonl",
    "mining_rounds.jsonl",
}
NEVER_FILENAMES = {
    "POWER.json", "VERDICT.json", "VERDICT_RECORD.json", "INPUT_RECORD.json",
    "DECLARATION.json", "score.json", "selection.json", "mining_llm_calls.jsonl",
    "trials.jsonl",
}
SECRET_PARTS = ("token", "secret", "credential")


def _under(path: str, root: str) -> bool:
    return path == root.rstrip("/") or path.startswith(root.rstrip("/") + "/")


def _raw_has_parent(path: str | os.PathLike) -> bool:
    return ".." in PurePath(os.fspath(path)).parts


def require_readable_path(path: str | os.PathLike, *, allowed_prefixes=()) -> Path:
    raw = os.fspath(path)
    if not raw or _raw_has_parent(raw):
        raise PathForbidden(raw)
    resolved = Path(raw).expanduser().resolve(strict=False)
    value = str(resolved)
    lower_parts = tuple(part.lower() for part in resolved.parts)
    name_lower = resolved.name.lower()

    if _under(value, "/srv/v6-prod") or _under(value, "/home/kayla/.ssh"):
        raise PathForbidden(value)
    if any("holdout" in part for part in lower_parts):
        raise PathForbidden(value)
    if any(part.startswith("rut1-arms-") for part in lower_parts):
        raise PathForbidden(value)
    if resolved.name in NEVER_FILENAMES:
        raise PathForbidden(value)
    if resolved.suffix.lower() in {".env", ".key", ".pem"}:
        raise PathForbidden(value)
    if any(marker in name_lower for marker in SECRET_PARTS):
        raise PathForbidden(value)

    if _under(value, "/srv/research-lane/master-table"):
        if value not in MASTER_TABLE_FILES:
            raise PathForbidden(value)
        return resolved
    if value in MASTER_TABLE_FILES:
        return resolved
    if value == "/home/kayla/.local/state/research-queue/status.json":
        return resolved
    if _under(value, "/home/kayla/.config"):
        raise PathForbidden(value)
    if _under(value, "/srv/research-lane/qrp/var/ledger/research"):
        if resolved.name not in QRP_LEDGER_FILES:
            raise PathForbidden(value)
        return resolved
    if value == "/srv/research-lane/rf1116-mining/out/qrp-data/research/mining_rounds.jsonl":
        return resolved
    if _under(value, "/srv/research-lane/overseas/runs/rut1-unattended"):
        if resolved.name not in {"RUN_LEDGER.jsonl", "SEALED.json"}:
            raise PathForbidden(value)
        return resolved
    if _under(value, "/srv/research-lane/progress-page"):
        return resolved
    if _under(value, "/srv/research-lane"):
        return resolved
    if _under(value, "/home/kayla/.local/state") and resolved.suffix == ".json":
        return resolved
    for prefix in allowed_prefixes or ():
        root = str(Path(prefix).expanduser().resolve(strict=False))
        if _under(value, root):
            return resolved
    raise PathForbidden(value)
