#!/usr/bin/python3
import importlib.util
import json
import pathlib
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("q137_relay_compare", HERE / "relay-compare.py")
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


class CompareTest(unittest.TestCase):
    def test_exact_sets_and_w05_pass_timestamps_do_not_matter(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            base = {"localPacks": [{"name": "a.json", "sha256": "a" * 64}], "hkPacks": [],
                    "returns": {"linux": [], "hk": []},
                    "w05": {"authority": "V8_1_COORDINATOR", "node": "/srv/research-lane/tools/node-v23.11.0-linux-x64/bin/node", "producerHookRoot": None}}
            a, b = root / "a.json", root / "b.json"
            a.write_text(json.dumps({**base, "at": "one"}))
            b.write_text(json.dumps({**base, "at": "two"}))
            self.assertTrue(compare.compare(a, b)["pass"])
            changed = dict(base); changed["localPacks"] = []
            b.write_text(json.dumps(changed))
            self.assertEqual(compare.compare(a, b)["differences"], ["localPacks"])


if __name__ == "__main__":
    unittest.main()
