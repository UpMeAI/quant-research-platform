"""Fail-closed validation for a generated master-table candidate."""

import re

from . import counts
from .errors import MtlError
from .newrows import NW


STATES = {"OK", "MISSING", "UNKNOWN", "CONFLICT", "STALE", "NOT_APPLICABLE"}
FED_FIELDS = counts.FED_FIELDS
FED_KEYS = ("schema", "rowClass", *FED_FIELDS, "records")
NEW_PROSE = (
    "group", "q", "form", "machine", "detail", "missing", "eta", "ok", "strength",
    "use", "next", "cutoff", "layer", "layerTopic", "layerNote",
)


def _fail(code):
    raise MtlError(f"SELF_CHECK_{code}", 3)


def check(document, md_bytes, frozen_ids, registry_ids):
    revision = document.get("revision")
    if not isinstance(revision, int) or f"rev {revision}".encode() not in md_bytes:
        _fail("MD")
    for sentence in (b"A04 10", b"warm-up 2", b"Q0-R9 7"):
        if md_bytes.count(sentence) != 1:
            _fail("MD")

    rows = document.get("items")
    if not isinstance(rows, list):
        _fail("ROWS")
    ids = [row.get("id") for row in rows]
    if any(not value for value in ids) or len(ids) != len(set(ids)):
        _fail("IDS")
    if ids[:len(frozen_ids)] != list(frozen_ids) or ids != list(registry_ids):
        _fail("REGISTRY")
    if any(row.get("status") not in counts.STATUSES for row in rows):
        _fail("STATUS")
    if any(row.get("market") not in counts.MARKETS for row in rows):
        _fail("MARKET")

    actual = counts.compute(rows)
    for key in ("statusCounts", "marketCounts", "layerCounts", "lists", "layerPending", "fedStatusCounts"):
        if document.get(key) != actual[key]:
            _fail("COUNTS")

    frozen = set(frozen_ids)
    for row in rows:
        fed = row.get("ledgerFed")
        if not isinstance(fed, dict) or tuple(fed) != FED_KEYS:
            _fail("LEDGER_FED")
        for name in FED_FIELDS:
            field = fed.get(name)
            if not isinstance(field, dict) or tuple(field) != ("state", "value", "reason", "src"):
                _fail("LEDGER_FED")
            if field["state"] not in STATES:
                _fail("LEDGER_FED_STATE")
            if field["state"] not in {"OK", "STALE", "UNKNOWN"} and field["value"] is not None:
                _fail("LEDGER_FED_VALUE")
        if row["id"] not in frozen:
            if not re.fullmatch(r"L-[A-Za-z0-9._-]+", row["id"]):
                _fail("NEW_ID")
            if any(row.get(key) != NW for key in NEW_PROSE):
                _fail("NEW_PROSE")
    return True
