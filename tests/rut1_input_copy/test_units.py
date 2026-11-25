import pathlib
import unittest


ROOT = pathlib.Path(__file__).parents[2]


class UnitTest(unittest.TestCase):
    def test_p1_unit_and_timer(self):
        service = (ROOT / "deploy" / "rut1-input-copy" / "research-rut1-input-copy-p1.service").read_text()
        timer = (ROOT / "deploy" / "rut1-input-copy" / "research-rut1-input-copy-p1.timer").read_text()
        self.assertIn("--phase p1", service)
        self.assertIn("TimeoutStartSec=9000", service)
        self.assertIn("Nice=19", service)
        self.assertIn("IOSchedulingClass=idle", service)
        self.assertIn("OnCalendar=2026-11-28 05:00:00 Asia/Shanghai", timer)

    def test_p2_timer_has_exact_half_hour_window(self):
        service = (ROOT / "deploy" / "rut1-input-copy" / "research-rut1-input-copy-p2.service").read_text()
        timer = (ROOT / "deploy" / "rut1-input-copy" / "research-rut1-input-copy-p2.timer").read_text()
        self.assertIn("--phase p2", service)
        lines = [line for line in timer.splitlines() if line.startswith("OnCalendar=")]
        self.assertEqual(41, len(lines))
        self.assertEqual("OnCalendar=2026-12-05 15:00:00 Asia/Shanghai", lines[0])
        self.assertEqual("OnCalendar=2026-12-06 11:00:00 Asia/Shanghai", lines[-1])
        self.assertEqual(len(lines), len(set(lines)))


if __name__ == "__main__":
    unittest.main()
