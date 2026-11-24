import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "master-table"))

from mtl import fed


NW = "NOT_WRITTEN_NO_AUTHOR_AFTER_1125"


class NewRowTests(unittest.TestCase):
    def test_f5_new_row_is_byte_exact_and_registry_candidate_is_bound_to_ledger(self):
        record = {
            "schema": "ASHARE_SEALED_VERDICT_LOCK_V1", "result_id": "ASV-CN-ZNEW-bbbbbbbbbbbb",
            "entry_id": "CN-ZNEW", "kind": "RESULT", "strategy_ref": "INDEX_BOOK",
            "sealed_on": "2026-12-03", "decision": "做", "file_sha256": "b" * 64,
            "refs": [{"role": "FILE", "ref": "ZNEW.json", "sha256": "b" * 64}],
            "supersedes_ref": None, "production_effect": "NONE",
            "locked_at": "2026-12-03T10:00:00+08:00", "_ledger": "ashare_sealed_verdicts",
            "_line_no": 2, "_line_sha256": "c" * 64,
        }
        projected, rows, unjoined = fed.build(
            {"items": []}, {"schema": "JOIN_MAP_V1", "freezeDate": "2026-11-25", "rows": {}},
            {"ashare_sealed_verdicts": [record]}, [], "2026-12-03"
        )
        self.assertEqual({}, projected)
        self.assertEqual([], unjoined)
        self.assertEqual(1, len(rows))
        new = rows[0]
        self.assertEqual([
            "id", "market", "group", "q", "auth", "form", "owner", "machine", "status",
            "detail", "missing", "eta", "ok", "verdict", "strength", "use", "prod", "next",
            "cutoff", "layer", "layerTopic", "layerNote", "owner_name", "ledgerFed", "_registry_source",
        ], list(new))
        self.assertEqual("L-CN-ZNEW", new["id"])
        self.assertEqual("A股", new["market"])
        self.assertEqual("LEDGER", new["owner"])
        self.assertEqual("QRP 台账（无会话）", new["owner_name"])
        self.assertEqual("做", new["verdict"])
        self.assertEqual("production_effect NONE", new["prod"])
        for key in ("group", "q", "form", "machine", "detail", "missing", "eta", "ok",
                    "strength", "use", "next", "cutoff", "layer", "layerTopic", "layerNote"):
            self.assertEqual(NW, new[key])
        self.assertEqual({"ledger": "ashare_sealed_verdicts", "result_id": record["result_id"],
                          "line_no": 2, "line_sha256": "c" * 64}, new["_registry_source"])
        self.assertEqual("OK", new["ledgerFed"]["verdictToken"]["state"])
        # The internal registry candidate is removed before serialization.
        public = {key: value for key, value in new.items() if key != "_registry_source"}
        self.assertNotIn("_registry_source", json.dumps(public, ensure_ascii=False, separators=(",", ":")))

    def test_new_rows_sort_by_record_date_then_result_id(self):
        base = {
            "schema": "OVERSEAS_SEALED_VERDICT_LOCK_V1", "kind": "RESULT",
            "strategy_ref": "US_V5_ETF_3000USD", "decision": "做", "file_sha256": "a" * 64,
            "refs": [], "supersedes_ref": None, "production_effect": "NONE",
            "_ledger": "overseas_sealed_verdicts", "_line_sha256": "b" * 64,
        }
        late = dict(base, result_id="r-b", entry_id="B", sealed_on="2026-12-04", locked_at="2026-12-04T00:00:00+08:00", _line_no=2)
        early = dict(base, result_id="r-a", entry_id="A", sealed_on="2026-12-03", locked_at="2026-12-03T00:00:00+08:00", _line_no=1)
        _, rows, _ = fed.build({"items": []}, {"rows": {}, "freezeDate": "2026-11-25"},
                               {"overseas_sealed_verdicts": [late, early]}, [], "2026-12-04")
        self.assertEqual(["L-A", "L-B"], [item["id"] for item in rows])


if __name__ == "__main__":
    unittest.main()
