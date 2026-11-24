import hashlib
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "master-table"))

from mtl.errors import MtlError
from mtl import registry


class RegistryTests(unittest.TestCase):
    def test_hash_chain_is_canonical_and_verifiable(self):
        frozen = registry.frozen_line("Z01", 1, 9, "A股", "0" * 64, qrp_commit="abc")
        self.assertEqual(registry.line_hash(frozen), frozen["line_sha256"])
        source = {"ledger": "ashare_sealed_verdicts", "result_id": "r2", "line_no": 2,
                  "line_sha256": "b" * 64}
        auto = registry.auto_line("L-CN-ZNEW", 2, 10, "A股", source, frozen["line_sha256"], qrp_commit="abc")
        ledger_lines = {("ashare_sealed_verdicts", 2): {"result_id": "r2", "line_sha256": "b" * 64}}
        registry.verify([frozen, auto], ledger_lines, frozen_rev=9)

    def test_hand_added_or_broken_chain_line_fails_closed(self):
        frozen = registry.frozen_line("Z01", 1, 9, "A股", "0" * 64, qrp_commit="abc")
        source = {"ledger": "ashare_sealed_verdicts", "result_id": "fake", "line_no": 4,
                  "line_sha256": "f" * 64}
        auto = registry.auto_line("L-FAKE", 2, 10, "A股", source, frozen["line_sha256"], qrp_commit="abc")
        with self.assertRaisesRegex(MtlError, "ROW_REGISTRY_UNVERIFIABLE:2") as caught:
            registry.verify([frozen, auto], {}, frozen_rev=9)
        self.assertEqual(3, caught.exception.exit_code)
        auto["prev_sha256"] = "9" * 64
        with self.assertRaisesRegex(MtlError, "ROW_REGISTRY_UNVERIFIABLE:2"):
            registry.verify([frozen, auto], {}, frozen_rev=9)

    def test_line_hash_excludes_only_line_sha256(self):
        line = registry.frozen_line("Z01", 1, 9, "A股", "0" * 64, qrp_commit="abc")
        expected = dict(line)
        expected.pop("line_sha256")
        encoded = json.dumps(expected, ensure_ascii=False, separators=(",", ":")).encode()
        self.assertEqual(hashlib.sha256(encoded).hexdigest(), line["line_sha256"])


if __name__ == "__main__":
    unittest.main()
