import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "services" / "master-table" / "freeze" / "build_freeze.py"


def load_tool():
    spec = importlib.util.spec_from_file_location("mtl_build_freeze", TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FreezeTests(unittest.TestCase):
    def test_proposal_records_evidence_and_never_reads_trials(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            ledgers = root / "ledgers"; ledgers.mkdir()
            coord = root / "coord"; coord.mkdir()
            out = root / "out"
            table = {
                "revision": 9,
                "items": [
                    {"id": "Z01", "market": "A股", "status": "已出结论",
                     "auth": ["RESULT-Z01-aaaaaaaaaaaa"]},
                    {"id": "Z02", "market": "美股", "status": "前向中",
                     "auth": ["K2_Z02_FREEZE_1.md cccccccccccccccc"]},
                    {"id": "Z03", "market": "跨市场", "status": "未跑", "auth": []},
                ],
            }
            table_json = root / "table.json"; table_json.write_text(json.dumps(table), encoding="utf-8")
            table_md = root / "table.md"; table_md.write_text("# frozen\n", encoding="utf-8")
            record = {"schema": "TEST", "result_id": "RESULT-Z01-aaaaaaaaaaaa",
                      "entry_id": "CN-Z01", "file_sha256": "a" * 64}
            extra = {"schema": "TEST", "result_id": "UNREFERENCED", "entry_id": "CN-X",
                     "file_sha256": "b" * 64}
            (ledgers / "ashare_sealed_verdicts.jsonl").write_text(
                json.dumps(record) + "\n" + json.dumps(extra) + "\n", encoding="utf-8")
            (ledgers / "trials.jsonl").write_text("not-json-and-must-not-be-read\n", encoding="utf-8")
            register = root / "register.json"
            register.write_text(json.dumps({"entries": [{"item_id": "Z01", "conclusion": {"seal_sha256": "a" * 64}}]}), encoding="utf-8")
            tstart = root / "tstart.json"
            tstart.write_text(json.dumps({"generatedAt": "2026-11-14T00:00:00+08:00", "rows": [
                {"masterTableRow": "Z02", "status": "STARTED", "T_start": "2026-10-27", "to": "2027-04-30"}
            ]}), encoding="utf-8")
            page = coord / "K2_Z02_FREEZE_1.md"; page.write_text("k2", encoding="utf-8")
            import hashlib
            table["items"][1]["auth"][0] = "K2_Z02_FREEZE_1.md " + hashlib.sha256(page.read_bytes()).hexdigest()[:16]
            table_json.write_text(json.dumps(table), encoding="utf-8")

            result = tool.build(table_json, table_md, ledgers, register, tstart, coord, out, qrp_commit="abc123")
            self.assertEqual("PROPOSED", result["state"])
            joins = json.loads((out / "JOIN_MAP_V1.proposed.json").read_text())
            self.assertEqual("PROPOSED", joins["state"])
            self.assertEqual(["CN-Z01"], joins["rows"]["Z01"]["entry_ids"])
            self.assertIn("REGISTER_SEAL", joins["rows"]["Z01"]["evidence"])
            self.assertIn("TEXT_RESULT_ID", joins["rows"]["Z01"]["evidence"])
            self.assertEqual("STARTED", joins["rows"]["Z02"]["tStart"]["registryStatus"])
            self.assertEqual("MATCH", joins["rows"]["Z02"]["k2State"]["state"])
            self.assertEqual("NONE_DECLARED", joins["rows"]["Z03"]["expected_sources"])
            manifest = json.loads((out / "FREEZE_MANIFEST_V1.json").read_text())
            self.assertEqual(["UNREFERENCED"], manifest["unreferencedRecords"])
            self.assertNotIn("trials.jsonl", [item["path"] for item in manifest["ledgers"]])
            registry_lines = [json.loads(line) for line in (out / "ROW_REGISTRY_V1.jsonl").read_text().splitlines()]
            self.assertEqual(["Z01", "Z02", "Z03"], [line["row_id"] for line in registry_lines])
            self.assertTrue((out / "FROZEN_REV9.json").is_file())
            self.assertIn("FROZEN_REV = 9", (out / "pins.proposed.py").read_text())


if __name__ == "__main__":
    unittest.main()
