import json
from pathlib import Path

from .errors import MtlError
from .guard import safe_path
from . import pins


def load(path):
    source = Path(path).expanduser().resolve(strict=False)
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MtlError(f"CONFIG_INVALID:{source.name}", 4) from exc
    if not isinstance(value, dict):
        raise MtlError("CONFIG_INVALID:ROOT", 4)
    pins.require_set()
    if value.get("qrp_var_authoritative") is not True:
        raise MtlError("QRP_VAR_NOT_AUTHORITATIVE", 4)
    roots = value.get("allowed_roots", [])
    for key in ("ledger_dir", "root", "frozen_dir"):
        if key in value:
            value[key] = str(safe_path(value[key], roots))
    return value
