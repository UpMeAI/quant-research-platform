import hashlib
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "master-table"))

from mtl import render


FIXTURE = Path(__file__).parent / "fixtures" / "frozen"


class ByteIdentityTests(unittest.TestCase):
    def test_frozen_only_never_reserializes(self):
        raw_json = (FIXTURE / "FROZEN_REV9.json").read_bytes()
        raw_md = (FIXTURE / "FROZEN_REV9.md").read_bytes()
        pins = {
            "frozen_rev": 9,
            "frozen_json_sha256": hashlib.sha256(raw_json).hexdigest(),
            "frozen_md_sha256": hashlib.sha256(raw_md).hexdigest(),
        }
        out_json, out_md = render.frozen_only(raw_json, raw_md, pins)
        self.assertEqual(hashlib.sha256(raw_json).digest(), hashlib.sha256(out_json).digest())
        self.assertEqual(hashlib.sha256(raw_md).digest(), hashlib.sha256(out_md).digest())


if __name__ == "__main__":
    unittest.main()
