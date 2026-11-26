import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "master-table"))

from mtl.errors import MtlError
from mtl import guard, pins


class GuardTests(unittest.TestCase):
    def test_allowed_path_under_declared_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            self.assertEqual(root / "ledger" / "a.jsonl",
                             guard.safe_path(root / "ledger" / "a.jsonl", [root]))

    def test_sensitive_or_outside_paths_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            for path in (root / ".env", root / "token.json", root / "holdout" / "x",
                         Path("/srv/v6-prod/app/x"), root.parent / "outside.json"):
                with self.subTest(path=path), self.assertRaisesRegex(MtlError, "PATH_FORBIDDEN") as caught:
                    guard.safe_path(path, [root])
                self.assertEqual(4, caught.exception.exit_code)

    def test_placeholder_pins_refuse_runner(self):
        with self.assertRaisesRegex(MtlError, "PINS_NOT_SET") as caught:
            pins.require_set()
        self.assertEqual(3, caught.exception.exit_code)

    def test_stdlib_and_no_network_or_subprocess(self):
        forbidden = ("urllib.request", "http.client", "socket", "subprocess", "openai", "anthropic")
        for source in (ROOT / "services" / "master-table" / "mtl").glob("*.py"):
            text = source.read_text(encoding="utf-8")
            for token in forbidden:
                self.assertNotIn(token, text, f"{source.name}: forbidden {token}")


if __name__ == "__main__":
    unittest.main()
