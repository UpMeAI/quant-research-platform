"""The one reading of a REVIEW_AI_FACT_PACK_V1 header, shared by the Mac relay and the host producer (stdlib only, no I/O).
Two writers exist: the desk producer (ops/review-loop/ai-review-facts.cjs) writes `contract` and `weekId`; the queue's own tests and the lab wrote `schema` and `week` / `week_id`.
Both are accepted. Every alias that is present must say the same thing, so a pack that disagrees with itself is not a pack: `schema` and `contract` must each equal SCHEMA,
and the week keys must agree with each other. Fail closed: anything else is no schema / no week."""

SCHEMA = "REVIEW_AI_FACT_PACK_V1"
SCHEMA_KEYS = ("schema", "contract")
WEEK_KEYS = ("week", "weekId", "week_id")


def schema_ok(pack):
    """True when the pack names REVIEW_AI_FACT_PACK_V1 under `schema` or `contract` (or both, and then both say it)."""
    if not isinstance(pack, dict):
        return False
    present = [pack[k] for k in SCHEMA_KEYS if k in pack]
    return bool(present) and all(isinstance(v, str) and v == SCHEMA for v in present)


def week_of(pack):
    """The ISO week of the pack (`week`, `weekId` or `week_id`), or None when there is none, it is not a non-empty string, or two aliases disagree."""
    if not isinstance(pack, dict):
        return None
    present = [pack[k] for k in WEEK_KEYS if k in pack]
    if not present or not all(isinstance(v, str) and v for v in present) or len(set(present)) != 1:
        return None
    return present[0]
