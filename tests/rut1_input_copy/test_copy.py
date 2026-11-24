import datetime as dt
import fcntl
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[2] / "services" / "rut1-input-copy"))

from rut1copy import copy, forms


CST = dt.timezone(dt.timedelta(hours=8))
P1_NOW = dt.datetime(2026, 11, 28, 5, 0, tzinfo=CST)
P2_NOW = dt.datetime(2026, 12, 5, 15, 0, tzinfo=CST)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_sum(root, entries):
    lines = []
    for rel, data in entries:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        lines.append(f"{sha(data)}  {rel}")
    (root / "SHA256SUMS").write_text("\n".join(lines) + "\n")


class FixtureRunner:
    def __init__(self, *, bad_sha=False, appledouble=False, rc=0, clocks=None):
        self.calls = []
        self.bad_sha = bad_sha
        self.appledouble = appledouble
        self.rc = rc
        self.clocks = iter(clocks or [])

    def __call__(self, operation):
        self.calls.append(operation.argv)
        if self.rc:
            return self.rc
        dest = operation.destination
        if dest is None:
            return 0
        dest.mkdir(parents=True, exist_ok=True)
        if operation.form_id.startswith("R-04-"):
            write_sum(dest, [("SPY.jsonl", operation.form_id.encode())])
        elif operation.form_id == "R-05":
            entries = [(f"{day}.jsonl.gz", day.encode()) for day in forms.TRADING_DAYS]
            write_sum(dest, entries)
        elif operation.form_id == "R-06-READ":
            payload = json.dumps({"schema": "US_V5_FILLS_E3_V2", "to": "2026-11-27"}).encode()
            write_sum(dest, [("US_V5_FILLS_E3_V2.json", payload)])
        elif operation.form_id in {"R-16-RAW", "R-16-ALL"}:
            for index in range(79):
                symbol = f"SYM{index:03d}"
                data = f"{operation.form_id}:{symbol}".encode()
                data_rel = pathlib.Path(symbol) / "2026-11.jsonl.gz"
                manifest = json.dumps({"file": data_rel.name, "sha256": sha(data)}).encode()
                (dest / data_rel).parent.mkdir(parents=True, exist_ok=True)
                (dest / data_rel).write_bytes(data)
                (dest / symbol / "2026-11.jsonl.gz.MANIFEST.json").write_bytes(manifest)
        elif operation.form_id == "R-16-SUMS":
            root = dest.parent
            lines = []
            for path in sorted(root.glob("*/*/2026-11*")):
                rel = path.relative_to(root)
                lines.append(f"{sha(path.read_bytes())}  {rel}")
            dest.write_text("\n".join(lines) + "\n")
        if self.appledouble:
            (dest / "._x").write_bytes(b"forbidden")
            self.appledouble = False
        if self.bad_sha and (dest / "SHA256SUMS").exists():
            text = (dest / "SHA256SUMS").read_text()
            (dest / "SHA256SUMS").write_text("0" * 64 + text[64:])
            self.bad_sha = False
        return 0


class CopyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.temp.name) / "overseas"
        self.base.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def run(self, phase, runner, now, **kwargs):
        return copy.run_phase(
            phase, base=self.base, runner=runner, clock=lambda: now,
            free_bytes=copy.MIN_FREE_AFTER_BYTES + copy.EXPECTED_BYTES[phase] + 1,
            run_id=f"test-{phase}", **kwargs)

    def test_p1_complete_delivery_and_read_only_receipt(self):
        runner = FixtureRunner()
        result = self.run("p1", runner, P1_NOW)
        self.assertEqual(0, result.code)
        target = self.base / "data" / "rut1-s8parity"
        self.assertTrue((target / "us-1m" / "2026-11-27" / "SHA256SUMS").is_file())
        self.assertTrue((target / "decision-inputs" / "us-v5" / "2026-11-27.jsonl.gz").is_file())
        self.assertTrue((target / "fills" / "US_V5_FILLS_E3_V2.json").is_file())
        receipt = json.loads((target / "RUT1_INPUT_COPY_RECEIPT_V1.json").read_text())
        self.assertEqual(("RUT1_INPUT_COPY_RECEIPT_V1", "p1", "COMPLETE"),
                         (receipt["schema"], receipt["phase"], receipt["result"]))
        self.assertEqual(0o444, (target / "RUT1_INPUT_COPY_RECEIPT_V1.json").stat().st_mode & 0o777)

    def test_sha_mismatch_moves_nothing(self):
        result = self.run("p1", FixtureRunner(bad_sha=True), P1_NOW)
        self.assertEqual(4, result.code)
        self.assertFalse((self.base / "data" / "rut1-s8parity").exists())
        self.assertEqual("PARTIAL", json.loads(result.receipt.read_text())["result"])

    def test_deadline_after_partial_pull_aborts_and_keeps_staging(self):
        times = iter((P1_NOW, dt.datetime(2026, 11, 28, 7, 31, tzinfo=CST)))
        result = copy.run_phase(
            "p1", base=self.base, runner=FixtureRunner(), clock=lambda: next(times),
            free_bytes=copy.MIN_FREE_AFTER_BYTES + copy.EXPECTED_BYTES["p1"] + 1,
            run_id="deadline")
        self.assertEqual(5, result.code)
        self.assertTrue(result.receipt.is_file())
        self.assertEqual("ABORTED", json.loads(result.receipt.read_text())["result"])
        self.assertFalse((self.base / "data" / "rut1-s8parity").exists())

    def test_existing_different_file_is_conflict_and_untouched(self):
        target = self.base / "data" / "rut1-s8parity" / "fills" / "US_V5_FILLS_E3_V2.json"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"existing")
        result = self.run("p1", FixtureRunner(), P1_NOW)
        self.assertEqual(4, result.code)
        self.assertEqual(b"existing", target.read_bytes())
        self.assertEqual("CONFLICT", json.loads(result.receipt.read_text())["result"])

    def test_appledouble_is_refused(self):
        result = self.run("p1", FixtureRunner(appledouble=True), P1_NOW)
        self.assertEqual(3, result.code)
        self.assertEqual("APPLEDOUBLE_REFUSED", result.reason)
        self.assertFalse((self.base / "data" / "rut1-s8parity").exists())

    def test_second_instance_exits_75(self):
        lock_path = self.base / "data" / "rut1-input-copy.lock"
        lock_path.parent.mkdir(parents=True)
        with lock_path.open("a+") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run("p1", FixtureRunner(), P1_NOW)
        self.assertEqual(75, result.code)

    def test_rerun_after_complete_is_noop(self):
        self.assertEqual(0, self.run("p1", FixtureRunner(), P1_NOW).code)
        runner = FixtureRunner(rc=126)
        result = self.run("p1", runner, P1_NOW)
        self.assertEqual(0, result.code)
        self.assertEqual([], runner.calls)

    def test_p2_has_no_marker_and_delivers_79_by_two(self):
        runner = FixtureRunner()
        result = self.run("p2", runner, P2_NOW)
        self.assertEqual(0, result.code)
        target = self.base / "data" / "rut1-s8parity-b" / "alpaca-1m"
        self.assertEqual(79, len(list((target / "raw").glob("*/2026-11.jsonl.gz"))))
        self.assertEqual(79, len(list((target / "all").glob("*/2026-11.jsonl.gz"))))
        receipt = json.loads((target / "alpaca-1m.RECEIPT.json").read_text())
        self.assertEqual("ALPACA_1M_COPY_RECEIPT_V1", receipt["schema"])
        self.assertEqual(79, receipt["copies"]["raw"]["dataFiles"])
        self.assertNotIn("marker", json.dumps(receipt).lower())

    def test_gate_refusal_is_exit_three(self):
        result = self.run("p1", FixtureRunner(rc=126), P1_NOW)
        self.assertEqual((3, "GATE_REFUSED"), (result.code, result.reason))

    def test_check_print_plan_touches_nothing(self):
        runner = FixtureRunner()
        result = copy.run_phase("p1", base=self.base, runner=runner, clock=lambda: P1_NOW,
                                check=True, run_id="check")
        self.assertEqual(0, result.code)
        self.assertTrue(result.plan)
        self.assertEqual([], runner.calls)
        self.assertEqual([], list(self.base.iterdir()))

    def test_disk_floor_refuses_before_runner(self):
        runner = FixtureRunner()
        result = copy.run_phase("p1", base=self.base, runner=runner, clock=lambda: P1_NOW,
                                free_bytes=copy.MIN_FREE_AFTER_BYTES, run_id="disk")
        self.assertEqual((3, "DISK_FLOOR"), (result.code, result.reason))
        self.assertEqual([], runner.calls)


if __name__ == "__main__":
    unittest.main()
