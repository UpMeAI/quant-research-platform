import datetime as dt
import fcntl
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "services" / "progress-page"))

from progress import run


NOW = dt.datetime(2026, 11, 26, 9, 7, 2, tzinfo=dt.timezone(dt.timedelta(hours=8)))


class RunTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.cfg = self.root / "config.json"
        self.cfg.write_text(json.dumps({"schema": "PROGRESS_CONFIG_V1", "out_dir": str(self.root / "out"), "state_dir": str(self.root / "state"), "sections": {}, "stale_banner_after_h": 3, "upload": {"enabled": False}}))
        self.registry = {"schema": "PROGRESS_REGISTRY_V1", "generated_at": NOW.isoformat(), "registry_sha256": "a" * 64, "sections_by_state": {"OK": 1}, "sections": []}

    def tearDown(self): self.temp.cleanup()

    def test_local_generation_and_status(self):
        rc = run.run_once(self.cfg, now=NOW, build_fn=lambda c, n: self.registry, render_fn=lambda r: "<html>safe</html>", publish_fn=lambda *a, **k: {"state": "DISABLED", "at": NOW.isoformat(), "rc": 0})
        self.assertEqual(0, rc)
        self.assertTrue((self.root / "out" / "site" / "index.html").exists())
        status = json.loads((self.root / "state" / "status.json").read_text())
        self.assertEqual("a" * 64, status["registry_sha256"])

    def test_forbidden_token_scan_exits_three_without_publish(self):
        calls = []
        rc = run.run_once(self.cfg, now=NOW, build_fn=lambda c, n: self.registry, render_fn=lambda r: "sk-ABCDEFGHIJKLMNOPQRST", publish_fn=lambda *a, **k: calls.append(a))
        self.assertEqual(3, rc)
        self.assertEqual([], calls)

    def test_unit_files_have_frozen_controls(self):
        service = (ROOT / "deploy" / "progress-page" / "research-progress-page.service").read_text()
        timer = (ROOT / "deploy" / "progress-page" / "research-progress-page.timer").read_text()
        self.assertIn("Nice=19", service)
        self.assertIn("IOSchedulingClass=idle", service)
        self.assertIn("CPUAffinity=0-7 16-23", service)
        self.assertIn("/srv/research-lane/ops-logs/progress-page/", service)
        self.assertNotIn("EnvironmentFile=", service)
        self.assertIn("OnCalendar=*-*-* *:07,37:00 Asia/Shanghai", timer)
        self.assertIn("Persistent=false", timer)

    def test_held_flock_does_nothing(self):
        state = self.root / "state"
        state.mkdir()
        with (state / "run.lock").open("a+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            rc = run.run_once(self.cfg, now=NOW, build_fn=lambda c, n: self.registry, render_fn=lambda r: "<html>safe</html>", publish_fn=lambda *a, **k: {"state": "DISABLED"})
        self.assertEqual(0, rc)
        self.assertFalse((self.root / "out").exists())

    def test_missing_runtime_paths_is_config_error(self):
        self.cfg.write_text(json.dumps({"schema": "PROGRESS_CONFIG_V1", "sections": {}, "upload": {"enabled": False}}))
        self.assertEqual(2, run.run_once(self.cfg, now=NOW))


if __name__ == "__main__":
    unittest.main()
