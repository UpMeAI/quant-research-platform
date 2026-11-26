import hashlib
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "master-table"))

from mtl import counts, render
from mtl.errors import MtlError


FIXTURE = Path(__file__).parent / "fixtures" / "frozen"


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.raw_json = (FIXTURE / "FROZEN_REV9.json").read_bytes()
        self.raw_md = (FIXTURE / "FROZEN_REV9.md").read_bytes()
        self.frozen = json.loads(self.raw_json)
        self.pins = {
            "frozen_rev": 9,
            "frozen_json_sha256": hashlib.sha256(self.raw_json).hexdigest(),
            "frozen_md_sha256": hashlib.sha256(self.raw_md).hexdigest(),
            "join_map_sha256": "a" * 64,
            "tstart_registry_sha256": "b" * 64,
        }

    def test_frozen_only_is_byte_identical(self):
        self.assertEqual((self.raw_json, self.raw_md), render.frozen_only(self.raw_json, self.raw_md, self.pins))
        damaged = self.raw_json.replace(b'"Z01"', b'"X01"', 1)
        with self.assertRaisesRegex(MtlError, "FROZEN_SNAPSHOT_SHA_MISMATCH"):
            render.frozen_only(damaged, self.raw_md, self.pins)

    def test_candidate_preserves_frozen_rows_and_digest_excludes_evaluated_on(self):
        overlay = {row["id"]: {"schema": "MASTER_TABLE_FED_V1", "rowClass": "FROZEN_CLOSED"}
                   for row in self.frozen["items"]}
        a = render.build(self.frozen, self.raw_md, overlay, [], [], [], self.pins, "2026-11-25", 10)
        b = render.build(self.frozen, self.raw_md, overlay, [], [], [], self.pins, "2026-11-26", 10)
        for source, result in zip(self.frozen["items"], a.document["items"]):
            self.assertEqual(source, {k: v for k, v in result.items() if k != "ledgerFed"})
        self.assertEqual(a.document["ledgerOverlay"]["digest"], b.document["ledgerOverlay"]["digest"])
        self.assertNotEqual(a.json_bytes, b.json_bytes)
        self.assertIn(b"<!-- FROZEN_REV9_BEGIN -->", a.md_bytes)
        self.assertIn(self.raw_md, a.md_bytes)

    def test_counts_port_legacy_formulas_and_fed_states(self):
        rows = [dict(row, ledgerFed={"verdict": {"state": state}})
                for row, state in zip(self.frozen["items"], ("OK", "MISSING"))]
        result = counts.compute(rows)
        self.assertEqual({"已出结论": 1, "前向中": 1}, result["statusCounts"])
        self.assertEqual(1, result["marketCounts"]["byMarket"]["美股"]["forward"])
        self.assertEqual({"OK": 1, "MISSING": 1}, result["fedStatusCounts"]["verdict"])

    def test_changed_frozen_row_order_and_markers_refuse(self):
        live = json.loads(self.raw_json)
        live["items"][0]["detail"] = "changed"
        with self.assertRaisesRegex(MtlError, "FROZEN_ROW_CHANGED:Z01:detail"):
            render.verify_live_frozen(self.frozen, live, 9)
        live = json.loads(self.raw_json)
        live["items"].reverse()
        with self.assertRaisesRegex(MtlError, "FROZEN_ORDER_CHANGED"):
            render.verify_live_frozen(self.frozen, live, 9)
        with self.assertRaisesRegex(MtlError, "FROZEN_MD_CHANGED"):
            render.verify_frozen_md(b"no markers", self.raw_md, 9)


if __name__ == "__main__":
    unittest.main()
