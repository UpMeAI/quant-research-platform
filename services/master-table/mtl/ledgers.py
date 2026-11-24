import hashlib
import json
from pathlib import Path

from .errors import MtlError


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _prefix_ok(raw, fact):
    size = int(fact.get("bytes", -1))
    return 0 <= size <= len(raw) and _sha(raw[:size]) == fact.get("sha256")


def _identifier(record):
    return record.get("result_id") or record.get("mark_id")


def _parse(name, raw):
    result = []
    for line_no, raw_line in enumerate(raw.splitlines(keepends=True), 1):
        try:
            record = json.loads(raw_line.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise MtlError(f"LEDGER_PARSE:{name}:{line_no}", 4) from exc
        if not isinstance(record, dict) or not record.get("schema") or not _identifier(record):
            raise MtlError(f"LEDGER_PARSE:{name}:{line_no}", 4)
        record = dict(record)
        record["_ledger"] = name[:-6] if name.endswith(".jsonl") else name
        record["_line_no"] = line_no
        record["_line_sha256"] = _sha(raw_line)
        result.append(record)
    return result


def read(cfg, state):
    ledger_dir = Path(cfg["ledger_dir"])
    required = list(cfg.get("required_ledgers", []))
    optional = list(cfg.get("optional_ledgers", []))
    manifest = {
        item["path"]: item
        for item in cfg.get("freeze_manifest", {}).get("ledgers", [])
    }
    previous = state.get("ledgers", {}) if isinstance(state, dict) else {}
    records_by_ledger = {}
    new_state = {"ledgers": {}}
    for name in required + optional:
        path = ledger_dir / name
        if not path.is_file():
            if name in required:
                raise MtlError(f"LEDGER_MISSING:{name}", 4)
            continue
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise MtlError(f"LEDGER_MISSING:{name}", 4) from exc
        for fact in (manifest.get(name), previous.get(name)):
            if fact and not _prefix_ok(raw, fact):
                raise MtlError(f"LEDGER_NOT_APPEND_ONLY:{name}", 4)
        key = name[:-6] if name.endswith(".jsonl") else name
        records_by_ledger[key] = _parse(name, raw)
        new_state["ledgers"][name] = {"bytes": len(raw), "sha256": _sha(raw)}
    return records_by_ledger, new_state


def heads(records):
    superseded = set()
    for record in records:
        refs = record.get("supersedes_ref", record.get("supersedes"))
        if isinstance(refs, str) and refs:
            superseded.add(refs)
        elif isinstance(refs, list):
            superseded.update(ref for ref in refs if isinstance(ref, str))
    return [record for record in records if _identifier(record) not in superseded]
