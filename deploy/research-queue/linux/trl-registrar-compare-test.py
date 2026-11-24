#!/usr/bin/python3
import importlib.util
import json
import pathlib
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("q137_trl_compare", HERE / "trl-registrar-compare.py")
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


class CompareTest(unittest.TestCase):
    def test_receipts_must_be_valid_and_byte_equal(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            a, b = root / "a.json", root / "b.json"
            receipt = {"schema": "TRIAL_REGISTRATION_RECEIPT_V1", "request_sha256": "a" * 64, "rows": []}
            data = (json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n").encode()
            a.write_bytes(data); b.write_bytes(data)
            self.assertTrue(compare.compare(a, b)["pass"])
            b.write_bytes(data + b"\n")
            self.assertFalse(compare.compare(a, b)["pass"])


if __name__ == "__main__":
    unittest.main()
