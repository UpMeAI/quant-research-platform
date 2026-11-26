import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "master-table"))

from mtl import fed


def rec(result_id="r1", entry_id="CN-Z01", **overrides):
    value = {
        "schema": "ASHARE_SEALED_VERDICT_LOCK_V1",
        "result_id": result_id,
        "entry_id": entry_id,
        "kind": "RESULT",
        "strategy_ref": "ASHARE_V6_PAPER",
        "sealed_on": "2026-11-20",
        "decision": "不做",
        "file_sha256": "a" * 64,
        "refs": [],
        "supersedes_ref": None,
        "production_effect": "NONE",
        "locked_at": "2026-11-20T10:00:00+08:00",
        "_ledger": "ashare_sealed_verdicts",
        "_line_no": 1,
        "_line_sha256": "b" * 64,
    }
    value.update(overrides)
    return value


def row(row_id="Z01", status="已出结论"):
    return {"id": row_id, "market": "A股", "status": status, "detail": "frozen"}


def join(rows):
    return {"schema": "JOIN_MAP_V1", "freezeDate": "2026-11-25", "rows": rows}


class FedProjectionTests(unittest.TestCase):
    def test_frozen_row_projection_matches_f3_shape(self):
        frozen = {"items": [row()]}
        joins = join({"Z01": {"rowClass": "FROZEN_CLOSED", "entry_ids": ["CN-Z01"]}})
        projected, new_rows, unjoined = fed.build(
            frozen, joins, {"ashare_sealed_verdicts": [rec()]}, [], "2026-11-25"
        )
        self.assertEqual([], new_rows)
        self.assertEqual([], unjoined)
        self.assertEqual([
            "schema", "rowClass", "verdict", "verdictToken", "status", "sealedOn",
            "sealSha256", "k2State", "tStart", "tStartRegistryStatus", "nextCheck", "records",
        ], list(projected["Z01"]))
        self.assertEqual({"state": "OK", "value": "不做", "reason": None,
                          "src": "ashare_sealed_verdicts:r1"}, projected["Z01"]["verdict"])
        self.assertEqual("不做", projected["Z01"]["verdictToken"]["value"])
        self.assertEqual("NOT_APPLICABLE", projected["Z01"]["tStart"]["state"])
        self.assertEqual(["r1"], projected["Z01"]["records"])

    def test_one_record_can_project_to_two_rows(self):
        frozen = {"items": [row("Z01"), row("Z03")]}
        joins = join({
            "Z01": {"rowClass": "FROZEN_CLOSED", "entry_ids": ["CN-Z01"]},
            "Z03": {"rowClass": "FROZEN_CLOSED", "entry_ids": ["CN-Z01"]},
        })
        projected, _, unjoined = fed.build(frozen, joins, {"ashare_sealed_verdicts": [rec()]}, [], "2026-11-25")
        self.assertEqual(["r1"], projected["Z01"]["records"])
        self.assertEqual(["r1"], projected["Z03"]["records"])
        self.assertEqual([], unjoined)

    def test_supersede_head_wins_and_two_heads_conflict(self):
        frozen = {"items": [row()]}
        joins = join({"Z01": {"rowClass": "FROZEN_CLOSED", "entry_ids": ["CN-Z01"]}})
        chain = [rec("r1", kind="DRAFT", decision="草稿（未冻结）"),
                 rec("r2", kind="STATUS", decision="暂停", supersedes_ref="r1"),
                 rec("r3", decision="做", supersedes_ref="r2")]
        projected, _, _ = fed.build(frozen, joins, {"ashare_sealed_verdicts": chain}, [], "2026-11-25")
        self.assertEqual("做", projected["Z01"]["verdictToken"]["value"])
        conflict = [rec("r1", decision="做"), rec("r2", decision="不做")]
        projected, _, _ = fed.build(frozen, joins, {"ashare_sealed_verdicts": conflict}, [], "2026-11-25")
        for key in ("verdict", "verdictToken", "status", "sealedOn", "sealSha256"):
            self.assertEqual(("CONFLICT", "TWO_HEADS"),
                             (projected["Z01"][key]["state"], projected["Z01"][key]["reason"]))

    def test_decision_vocabulary_never_maps_insufficient_to_no(self):
        cases = [
            ("INSUFFICIENT", "UNKNOWN", "DECISION_VOCAB", "INSUFFICIENT"),
            ("草稿（未冻结）", "UNKNOWN", "DECISION_VOCAB", "草稿（未冻结）"),
            ("V1 未判定（转前向）；V2_SPY 不做", "UNKNOWN", "COMPOUND_DECISION", "V1 未判定（转前向）；V2_SPY 不做"),
            ("做（影子）", "OK", None, "做"),
            ("不做（无候选）", "OK", None, "不做"),
            ("暂停", "OK", None, "暂停"),
        ]
        frozen = {"items": [row()]}
        joins = join({"Z01": {"rowClass": "FROZEN_CLOSED", "entry_ids": ["CN-Z01"]}})
        for decision, state, reason, value in cases:
            with self.subTest(decision=decision):
                projected, _, _ = fed.build(frozen, joins, {"ashare_sealed_verdicts": [rec(decision=decision)]}, [], "2026-11-25")
                token = projected["Z01"]["verdictToken"]
                self.assertEqual((state, reason, value), (token["state"], token["reason"], token["value"]))

    def test_next_check_boundary_and_tstart_staleness(self):
        frozen = {"items": [row("Z02", "前向中")]}
        joins = join({"Z02": {
            "rowClass": "FROZEN_OPEN", "entry_ids": ["UC-Z02"],
            "expected_sources": [{"ledger": "overseas_sealed_verdicts", "key": "entry_id", "value": "UC-Z02"}],
            "tStart": {"value": None, "registryStatus": "NOT_STARTED", "generatedAt": "2026-11-14"},
            "nextCheck": "2027-04-30",
        }})
        boundary, _, _ = fed.build(frozen, joins, {}, [], "2027-05-14")
        self.assertEqual(("MISSING", "AWAITING_PRODUCER"),
                         (boundary["Z02"]["verdict"]["state"], boundary["Z02"]["verdict"]["reason"]))
        stale, _, _ = fed.build(frozen, joins, {}, [], "2027-05-15")
        self.assertEqual(("STALE", "NO_RESULT_BY_NEXTCHECK_PLUS_14D"),
                         (stale["Z02"]["verdict"]["state"], stale["Z02"]["verdict"]["reason"]))
        self.assertEqual(("STALE", "REGISTRY_NOT_UPDATED_14D"),
                         (stale["Z02"]["tStart"]["state"], stale["Z02"]["tStart"]["reason"]))

    def test_unmapped_and_non_row_records_stay_unjoined(self):
        frozen = {"items": []}
        unknown = rec(entry_id="CN-NEW", strategy_ref="ZZZ")
        non_row = rec("baseline-1", entry_id=None, _ledger="baseline_evaluations")
        _, new_rows, unjoined = fed.build(
            frozen, join({}), {"ashare_sealed_verdicts": [unknown], "baseline_evaluations": [non_row]}, [], "2026-11-25"
        )
        self.assertEqual([], new_rows)
        self.assertEqual(["UNKNOWN_MARKET", "NOT_ROW_LEDGER"], [item["code"] for item in unjoined])


if __name__ == "__main__":
    unittest.main()
