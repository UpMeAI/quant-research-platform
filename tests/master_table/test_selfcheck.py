import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "master-table"))

from mtl import counts, selfcheck
from mtl.errors import MtlError


FIXTURE = Path(__file__).parent / "fixtures" / "frozen"


def candidate():
    doc = json.loads((FIXTURE / "FROZEN_REV9.json").read_text())
    doc["revision"] = 10
    for row in doc["items"]:
        row["ledgerFed"] = {
            "schema": "MASTER_TABLE_FED_V1", "rowClass": "FROZEN_CLOSED",
            **{key: {"state": "MISSING", "value": None, "reason": "NO_PRODUCER_DECLARED", "src": None}
               for key in ("verdict", "verdictToken", "status", "sealedOn", "sealSha256", "k2State", "tStart", "tStartRegistryStatus", "nextCheck")},
            "records": [],
        }
    doc.update(counts.compute(doc["items"]))
    return doc


class SelfCheckTests(unittest.TestCase):
    def test_good_candidate_and_injected_faults(self):
        doc = candidate()
        md = b"# rev 10\nA04 10\nwarm-up 2\nQ0-R9 7\n"
        self.assertTrue(selfcheck.check(doc, md, frozen_ids=["Z01", "Z02"], registry_ids=["Z01", "Z02"]))
        cases = []
        bad = candidate(); del bad["items"][0]["id"]; cases.append(bad)
        bad = candidate(); bad["statusCounts"]["已出结论"] += 1; cases.append(bad)
        bad = candidate(); bad["items"][0]["ledgerFed"]["verdict"]["state"] = "BOGUS"; cases.append(bad)
        for bad in cases:
            with self.subTest(bad=bad):
                with self.assertRaises(MtlError):
                    selfcheck.check(bad, md, frozen_ids=["Z01", "Z02"], registry_ids=["Z01", "Z02"])
        with self.assertRaisesRegex(MtlError, "SELF_CHECK_MD"):
            selfcheck.check(candidate(), b"# wrong\n", frozen_ids=["Z01", "Z02"], registry_ids=["Z01", "Z02"])


if __name__ == "__main__":
    unittest.main()
