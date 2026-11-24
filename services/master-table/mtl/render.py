"""Deterministic master-table projection and rendering."""

from dataclasses import dataclass
import hashlib
import json

from . import counts
from .errors import MtlError


@dataclass(frozen=True)
class Candidate:
    document: dict
    json_bytes: bytes
    md_bytes: bytes


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def serialize(document):
    return (json.dumps(document, ensure_ascii=False, indent=1) + "\n").encode("utf-8")


def frozen_only(raw_json, raw_md, pin_values):
    if (_sha(raw_json) != pin_values.get("frozen_json_sha256")
            or _sha(raw_md) != pin_values.get("frozen_md_sha256")):
        raise MtlError("FROZEN_SNAPSHOT_SHA_MISMATCH", 3)
    try:
        revision = json.loads(raw_json)["revision"]
    except (KeyError, TypeError, json.JSONDecodeError, UnicodeError) as exc:
        raise MtlError("FROZEN_SNAPSHOT_SHA_MISMATCH", 3) from exc
    if int(revision) != int(pin_values.get("frozen_rev")):
        raise MtlError("FROZEN_SNAPSHOT_SHA_MISMATCH", 3)
    return raw_json, raw_md


def verify_live_frozen(frozen, live, frozen_rev):
    frozen_rows = frozen.get("items", [])
    live_rows = live.get("items", [])
    expected_ids = [row.get("id") for row in frozen_rows]
    actual_ids = [row.get("id") for row in live_rows[:len(frozen_rows)]]
    if expected_ids != actual_ids:
        raise MtlError("FROZEN_ORDER_CHANGED", 3)
    for expected, actual in zip(frozen_rows, live_rows):
        public = {key: value for key, value in actual.items() if key != "ledgerFed"}
        for key in list(expected):
            if public.get(key) != expected[key]:
                raise MtlError(f"FROZEN_ROW_CHANGED:{expected.get('id')}:{key}", 3)
        extra = set(public) - set(expected)
        if extra:
            key = sorted(extra)[0]
            raise MtlError(f"FROZEN_ROW_CHANGED:{expected.get('id')}:{key}", 3)
    return True


def verify_frozen_md(live_md, frozen_md, frozen_rev):
    begin = f"<!-- FROZEN_REV{frozen_rev}_BEGIN -->\n".encode()
    end = f"<!-- FROZEN_REV{frozen_rev}_END -->".encode()
    start = live_md.find(begin)
    finish = live_md.find(end, start + len(begin)) if start >= 0 else -1
    if start < 0 or finish < 0 or live_md[start + len(begin):finish] != frozen_md:
        raise MtlError("FROZEN_MD_CHANGED", 3)
    return True


def _registry_sha(registry_lines):
    raw = b"".join((_canonical(line) + b"\n") for line in registry_lines)
    return _sha(raw)


def _latest_timestamp(ledgers, fallback):
    values = []
    for ledger in ledgers:
        if not isinstance(ledger, dict):
            continue
        for key in ("sealed_on", "locked_at", "registered_at", "created_at", "timestamp"):
            value = ledger.get(key)
            if isinstance(value, str) and value:
                values.append(value)
    return max(values)[:10] if values else fallback


def _display(value):
    if value is None:
        return "null"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value).replace("|", "\\|").replace("\n", " ")


def _render_md(document, frozen_md, pin_values):
    rev = document["revision"]
    frozen_rev = pin_values["frozen_rev"]
    lines = [
        f"# 全研究首轮总表 · 机器版 rev {rev}", "",
        (f"冻结 rev {frozen_rev}；JSON {pin_values['frozen_json_sha256']}；"
         f"JOIN_MAP {pin_values.get('join_map_sha256', '')}；"
         f"T_start {pin_values.get('tstart_registry_sha256', '')}。"),
        "",
        "规则：冻结字段不改写；台账投影保持缺失、未知、冲突和不适用互不混同。", "",
        f"<!-- FROZEN_REV{frozen_rev}_BEGIN -->",
    ]
    prefix = "\n".join(lines).encode("utf-8") + b"\n"
    suffix_lines = [
        f"<!-- FROZEN_REV{frozen_rev}_END -->", "",
        "## M. 台账投影（程序生成，rev F+1 起）", "",
        "| id | rowClass | verdict | status | nextCheck |", "|---|---|---|---|---|",
    ]
    for row in document.get("items", []):
        fed = row.get("ledgerFed") or {}
        def cell(name):
            field = fed.get(name) or {}
            return _display({"state": field.get("state"), "value": field.get("value")})
        suffix_lines.append("| " + " | ".join((
            _display(row.get("id")), _display(fed.get("rowClass")), cell("verdict"),
            cell("status"), cell("nextCheck"),
        )) + " |")
    return prefix + frozen_md + ("\n" if not frozen_md.endswith(b"\n") else "").encode() + ("\n".join(suffix_lines) + "\n").encode("utf-8")


def build(frozen, frozen_md, projections, new_rows, unjoined, ledgers, pin_values,
          evaluated_on, revision, registry_lines=None):
    frozen_rows = []
    for row in frozen.get("items", []):
        current = dict(row)
        current["ledgerFed"] = projections[row["id"]]
        frozen_rows.append(current)
    public_new = [{key: value for key, value in row.items() if key != "_registry_source"}
                  for row in new_rows]
    items = frozen_rows + public_new
    digest_payload = {
        "ledgerFed": [row["ledgerFed"] for row in items],
        "newRows": public_new,
        "unjoined": unjoined,
    }
    overlay = {
        "frozenRev": int(pin_values["frozen_rev"]),
        "frozenJsonSha256": pin_values["frozen_json_sha256"],
        "joinMapSha256": pin_values.get("join_map_sha256"),
        "tstartRegistrySha256": pin_values.get("tstart_registry_sha256"),
        "rowRegistrySha256": _registry_sha(registry_lines or []),
        "ledgers": [dict(value) for value in ledgers if isinstance(value, dict) and "path" in value],
        "unjoined": list(unjoined),
        "evaluatedOn": evaluated_on,
        "digest": _sha(_canonical(digest_payload)),
    }
    overlay["failureCandidates"] = [
        {"id": row["id"], "state": "UNANNOTATED"}
        for row in public_new
        if ((row.get("ledgerFed") or {}).get("verdictToken") or {}).get("value") == "不做"
    ]
    document = dict(frozen)
    document.update({
        "revision": int(revision),
        "asOf": _latest_timestamp(ledgers, frozen.get("asOf")),
        "stage": "机器版（台账投影）",
        "items": items,
    })
    document.update(counts.compute(items))
    document["ledgerOverlay"] = overlay
    raw_json = serialize(document)
    raw_md = _render_md(document, frozen_md, pin_values)
    return Candidate(document, raw_json, raw_md)
