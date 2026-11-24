import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "master-table"))

from mtl.errors import MtlError
from mtl import writer


class WriterTests(unittest.TestCase):
    def test_publish_rev_is_read_only_and_live_matches(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            result = writer.publish(root, 10, b'{"revision":10}\n', b"# rev 10\n", {"result": "NEW_REV"})
            self.assertEqual("NEW_REV", result)
            for suffix in ("json", "md"):
                rev = root / "revs" / f"RESEARCH_MASTER_TABLE_20261110.rev10.{suffix}"
                live = root / "live" / f"RESEARCH_MASTER_TABLE_20261110.{suffix}"
                self.assertEqual(rev.read_bytes(), live.read_bytes())
                self.assertEqual(0o444, rev.stat().st_mode & 0o777)
            self.assertEqual("NEW_REV", json.loads((root / "state" / "run_status.json").read_text())["result"])

    def test_existing_different_rev_refuses_but_same_bytes_recovers(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            writer.publish(root, 10, b"same", b"same-md", {"result": "NEW_REV"})
            self.assertEqual("NEW_REV", writer.publish(root, 10, b"same", b"same-md", {"result": "NEW_REV"}))
            with self.assertRaisesRegex(MtlError, "REV_EXISTS_DIFFERENT"):
                writer.publish(root, 10, b"different", b"same-md", {"result": "NEW_REV"})

    def test_locked_refuses_with_75(self):
        with tempfile.TemporaryDirectory() as td:
            with writer.locked(Path(td)):
                with self.assertRaises(MtlError) as caught:
                    with writer.locked(Path(td)):
                        pass
            self.assertEqual(("LOCKED", 75), (caught.exception.code, caught.exception.exit_code))


if __name__ == "__main__":
    unittest.main()
