from datetime import date, timedelta

from . import joinmap, ledgers, newrows


_VERDICT_LEDGERS = {
    "ashare_sealed_verdicts",
    "overseas_sealed_verdicts",
    "sealed_research_results",
}


def _field(state, value=None, reason=None, src=None):
    return {"state": state, "value": value, "reason": reason, "src": src}


def _source(record):
    return f"{record['_ledger']}:{record['result_id']}"


def _parse_date(value):
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _token(decision, src):
    raw = decision if isinstance(decision, str) else None
    if raw and "；" in raw:
        return _field("UNKNOWN", raw, "COMPOUND_DECISION", src)
    if raw:
        for token in ("不做", "暂停", "做"):
            if raw.startswith(token):
                return _field("OK", token, None, src)
    return _field("UNKNOWN", raw, "DECISION_VOCAB", src)


def _is_forward(row_class):
    return row_class == "FROZEN_OPEN"


def _k2(spec, row_class):
    value = spec.get("k2State")
    if isinstance(value, dict):
        state = value.get("state", "OK")
        return _field(state, value.get("value"), value.get("reason"), value.get("src", "JOIN_MAP_V1"))
    if row_class == "NEW":
        return _field("MISSING", None, "NO_PRODUCER_DECLARED", None)
    return _field("NOT_APPLICABLE", None, "NO_K2_FOR_ROW", None)


def _tstart(spec, row_class, evaluated_on):
    if not _is_forward(row_class):
        na = _field("NOT_APPLICABLE", None, "NOT_FORWARD", None)
        return na, dict(na)
    fact = spec.get("tStart") or {}
    value = fact.get("value")
    status = fact.get("registryStatus")
    src = "JOIN_MAP_V1" if fact else None
    if value:
        return _field("OK", value, None, src), _field("OK", status, None, src)
    generated = _parse_date(fact.get("generatedAt"))
    current = _parse_date(evaluated_on)
    if status in {"NOT_STARTED", "RESERVED"} and generated and current and current > generated + timedelta(days=14):
        return (_field("STALE", None, "REGISTRY_NOT_UPDATED_14D", src),
                _field("STALE", status, "REGISTRY_NOT_UPDATED_14D", src))
    return _field("MISSING", None, "AWAITING_PRODUCER", src), _field("OK", status, None, src)


def _joined_heads(records):
    by_entry = {}
    for record in records:
        key = record.get("entry_id") or record.get("result_id")
        by_entry.setdefault(key, []).append(record)
    heads = []
    conflict = False
    for group in by_entry.values():
        current = ledgers.heads(group)
        heads.extend(current)
        if len(current) > 1:
            conflict = True
    return heads, conflict


def _projection(spec, records, evaluated_on, row_class):
    records = list(records)
    record_ids = [record["result_id"] for record in records]
    heads, conflict = _joined_heads(records)
    if conflict:
        conflict_field = _field("CONFLICT", None, "TWO_HEADS", None)
        verdict = dict(conflict_field)
        token = dict(conflict_field)
        status = dict(conflict_field)
        sealed = dict(conflict_field)
        digest = dict(conflict_field)
    elif len(heads) > 1:
        raw = "；".join(str(record.get("decision", "")) for record in heads)
        verdict = _field("UNKNOWN", raw, "COMPOUND_DECISION", None)
        token = _field("UNKNOWN", raw, "COMPOUND_DECISION", None)
        status = _field("UNKNOWN", None, "COMPOUND_DECISION", None)
        sealed = _field("UNKNOWN", None, "COMPOUND_DECISION", None)
        digest = _field("UNKNOWN", None, "COMPOUND_DECISION", None)
    elif heads:
        head = heads[0]
        src = _source(head)
        verdict = _field("OK", head.get("decision"), None, src)
        token = _token(head.get("decision"), src)
        status_value = newrows.STATUS_BY_KIND.get(head.get("kind"))
        status = (_field("OK", status_value, None, src) if status_value
                  else _field("UNKNOWN", head.get("kind"), "UNMAPPED_KIND", src))
        sealed_value = head.get("sealed_on") or head.get("locked_at")
        sealed = (_field("OK", sealed_value, None, src) if _parse_date(sealed_value)
                  else _field("UNKNOWN", sealed_value, "UNPARSEABLE_DATE", src))
        digest = _field("OK", head.get("file_sha256"), None, src)
    else:
        expected = bool(spec.get("expected_sources"))
        freeze_date = _parse_date(spec.get("freezeDate"))
        current = _parse_date(evaluated_on)
        if (expected and not spec.get("nextCheck") and freeze_date and current
                and current > freeze_date + timedelta(days=30)):
            missing = _field("STALE", None, "AWAITING_PRODUCER_30D", None)
        elif expected:
            missing = _field("MISSING", None, "AWAITING_PRODUCER", None)
        else:
            missing = _field("MISSING", None, "NO_PRODUCER_DECLARED", None)
        verdict = dict(missing)
        token = dict(missing)
        status = dict(missing)
        sealed = dict(missing)
        digest = dict(missing)

    next_check = spec.get("nextCheck")
    current = _parse_date(evaluated_on)
    next_date = _parse_date(next_check)
    stale_next = bool(next_date and current and current > next_date + timedelta(days=14))
    if stale_next and not any((_parse_date(item.get("sealed_on") or item.get("locked_at")) or date.min) >= next_date
                              for item in records):
        reason = "NO_RESULT_BY_NEXTCHECK_PLUS_14D"
        last_value = verdict.get("value")
        verdict = _field("STALE", last_value, reason, verdict.get("src"))
        token = _field("STALE", token.get("value"), reason, token.get("src"))
        next_field = _field("STALE", next_check, reason, "JOIN_MAP_V1")
    elif next_check:
        next_field = _field("OK", next_check, None, "JOIN_MAP_V1")
    elif _is_forward(row_class):
        next_field = _field("MISSING", None, "AWAITING_PRODUCER", None)
    else:
        next_field = _field("NOT_APPLICABLE", None, "NOT_FORWARD", None)

    tstart, registry_status = _tstart(spec, row_class, evaluated_on)
    return {
        "schema": "MASTER_TABLE_FED_V1",
        "rowClass": row_class,
        "verdict": verdict,
        "verdictToken": token,
        "status": status,
        "sealedOn": sealed,
        "sealSha256": digest,
        "k2State": _k2(spec, row_class),
        "tStart": tstart,
        "tStartRegistryStatus": registry_status,
        "nextCheck": next_field,
        "records": record_ids,
    }


def _registry_rows(registry):
    result = {}
    for line in registry or []:
        for key in ("entry_ids", "result_ids", "study_refs"):
            for value in (line.get("join") or {}).get(key, []):
                result[value] = line.get("row_id")
    return result


def _record_sort_key(record):
    return (record.get("sealed_on") or record.get("locked_at") or "", record.get("result_id") or "")


def build(frozen_doc, join_map, records, registry, evaluated_on):
    rows = join_map.get("rows", {})
    frozen_rows = frozen_doc.get("items", [])
    records_in_order = []
    for ledger_name, ledger_records in records.items():
        for raw in ledger_records:
            item = dict(raw)
            item.setdefault("_ledger", ledger_name)
            records_in_order.append(item)

    by_row = {row["id"]: [] for row in frozen_rows}
    joined_ids = set()
    for record in records_in_order:
        matched = joinmap.rows_for_record(join_map, record)
        for row_id in matched:
            if row_id in by_row:
                by_row[row_id].append(record)
                joined_ids.add(id(record))

    projected = {}
    for row in frozen_rows:
        row_id = row["id"]
        spec = dict(rows.get(row_id, {}))
        spec.setdefault("freezeDate", join_map.get("freezeDate"))
        row_class = spec.get("rowClass", "FROZEN_CLOSED")
        projected[row_id] = _projection(spec, by_row[row_id], evaluated_on, row_class)

    registered = _registry_rows(registry)
    new_candidates = []
    unjoined = []
    for record in records_in_order:
        if id(record) in joined_ids:
            continue
        identifiers = [record.get("entry_id"), record.get("result_id"), record.get("study_ref")]
        if any(value in registered for value in identifiers if value):
            continue
        ledger_name = record.get("_ledger")
        if ledger_name not in _VERDICT_LEDGERS:
            unjoined.append({"result_id": record.get("result_id"), "code": "NOT_ROW_LEDGER"})
            continue
        if record.get("kind") not in newrows.STATUS_BY_KIND:
            unjoined.append({"result_id": record.get("result_id"), "code": "UNMAPPED_KIND"})
            continue
        if not newrows.market(record):
            unjoined.append({"result_id": record.get("result_id"), "code": "UNKNOWN_MARKET"})
            continue
        new_candidates.append(record)

    superseded = set()
    for record in new_candidates:
        ref = record.get("supersedes_ref")
        if ref:
            superseded.add(ref)
    new_rows = []
    for record in sorted((item for item in new_candidates if item.get("result_id") not in superseded), key=_record_sort_key):
        spec = {"freezeDate": join_map.get("freezeDate")}
        overlay = _projection(spec, [record], evaluated_on, "NEW")
        new_rows.append(newrows.build(record, overlay))
    return projected, new_rows, unjoined
