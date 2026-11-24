import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "master-table"))

from mtl.errors import MtlError
from mtl import ledgers


def record(result_id="ASV-CN-Z01-a", **overrides):
    value = {
        "schema": "ASHARE_SEALED_VERDICT_LOCK_V1",
        "result_id": result_id,
        "entry_id": "CN-Z01",
        "kind": "RESULT",
        "strategy_ref": "ASHARE_V6_PAPER",
        "sealed_on": "2026-11-20",
        "decision": "不做",
        "file_sha256": "a" * 64,
        "refs": [],
        "supersedes_ref": None,
        "production_effect": "NONE",
        "locked_at": "2026-11-20T10:00:00+08:00",
    }
    value.update(overrides)
    return value


class LedgerReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ledger_dir = self.root / "ledgers"
        self.ledger_dir.mkdir()
        self.name = "ashare_sealed_verdicts.jsonl"
        self.path = self.ledger_dir / self.name
        self.line = json.dumps(record(), ensure_ascii=False, separators=(",", ":")) + "\n"
        self.path.write_text(self.line, encoding="utf-8")
        raw = self.line.encode()
        self.cfg = {
            "ledger_dir": str(self.ledger_dir),
            "required_ledgers": [self.name],
            "optional_ledgers": ["optional.jsonl"],
            "freeze_manifest": {
                "ledgers": [{
                    "path": self.name,
                    "bytes": len(raw),
                    "sha256": hashlib.sha256(raw).hexdigest(),
                }]
            },
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_records_and_persists_append_only_state(self):
        records, state = ledgers.read(self.cfg, {})
        self.assertEqual(["ashare_sealed_verdicts"], list(records))
        self.assertEqual("ASV-CN-Z01-a", records["ashare_sealed_verdicts"][0]["result_id"])
        self.assertEqual(1, records["ashare_sealed_verdicts"][0]["_line_no"])
        self.assertEqual(hashlib.sha256(self.line.encode()).hexdigest(), records["ashare_sealed_verdicts"][0]["_line_sha256"])
        self.assertEqual(len(self.line.encode()), state["ledgers"][self.name]["bytes"])

    def test_append_is_accepted_but_rewrite_is_rejected(self):
        _, state = ledgers.read(self.cfg, {})
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record("ASV-CN-Z01-b", supersedes_ref="ASV-CN-Z01-a"), ensure_ascii=False) + "\n")
        records, _ = ledgers.read(self.cfg, state)
        self.assertEqual(2, len(records["ashare_sealed_verdicts"]))
        raw = self.path.read_bytes()
        self.path.write_bytes(raw.replace(b"CN-Z01", b"CN-X01", 1))
        with self.assertRaisesRegex(MtlError, "LEDGER_NOT_APPEND_ONLY:ashare_sealed_verdicts.jsonl"):
            ledgers.read(self.cfg, state)

    def test_missing_required_ledger_is_input_refusal(self):
        self.path.unlink()
        with self.assertRaisesRegex(MtlError, "LEDGER_MISSING:ashare_sealed_verdicts.jsonl") as caught:
            ledgers.read(self.cfg, {})
        self.assertEqual(4, caught.exception.exit_code)

    def test_malformed_or_identifier_free_lines_are_input_refusals(self):
        for bad in ('{"schema":"X","result_id":', '{"schema":"X"}\n'):
            with self.subTest(bad=bad):
                self.path.write_text(bad, encoding="utf-8")
                self.cfg["freeze_manifest"] = {"ledgers": []}
                with self.assertRaisesRegex(MtlError, "LEDGER_PARSE:ashare_sealed_verdicts.jsonl:1") as caught:
                    ledgers.read(self.cfg, {})
                self.assertEqual(4, caught.exception.exit_code)

    def test_supersede_heads_are_deterministic(self):
        first = record("r1")
        second = record("r2", supersedes_ref="r1")
        third = record("r3")
        self.assertEqual(["r2", "r3"], [row["result_id"] for row in ledgers.heads([first, second, third])])


if __name__ == "__main__":
    unittest.main()
