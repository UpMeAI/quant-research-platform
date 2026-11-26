import pathlib
import hashlib
import unittest


ROOT = pathlib.Path(__file__).parents[2]
TOKEN = "@QRP_REVIEWED_SHA@"
IMMUTABLE_ROOT = f"/srv/research-lane/research-queue/code/{TOKEN}"
REVIEWED_SHA = "a" * 40


class UnitTest(unittest.TestCase):
    def assert_uses_installed_qrp_tree(self, service):
        self.assertNotIn("/code/current", service)
        self.assertIn(f"WorkingDirectory={IMMUTABLE_ROOT}", service)
        self.assertIn(
            f"Environment=PYTHONPATH={IMMUTABLE_ROOT}/services/rut1-input-copy",
            service,
        )
        rendered_once = service.replace(TOKEN, REVIEWED_SHA)
        rendered_twice = service.replace(TOKEN, REVIEWED_SHA)
        self.assertNotIn(TOKEN, rendered_once)
        self.assertIn(f"/code/{REVIEWED_SHA}", rendered_once)
        self.assertEqual(
            hashlib.sha256(rendered_once.encode()).hexdigest(),
            hashlib.sha256(rendered_twice.encode()).hexdigest(),
        )

    def test_p1_unit_and_timer(self):
        service = (ROOT / "deploy" / "rut1-input-copy" / "research-rut1-input-copy-p1.service").read_text()
        timer = (ROOT / "deploy" / "rut1-input-copy" / "research-rut1-input-copy-p1.timer").read_text()
        self.assertIn("--phase p1", service)
        self.assertIn("TimeoutStartSec=9000", service)
        self.assertIn("Nice=19", service)
        self.assertIn("IOSchedulingClass=idle", service)
        self.assert_uses_installed_qrp_tree(service)
        self.assertIn("OnCalendar=2026-11-28 05:00:00 Asia/Shanghai", timer)

    def test_p2_timer_has_exact_half_hour_window(self):
        service = (ROOT / "deploy" / "rut1-input-copy" / "research-rut1-input-copy-p2.service").read_text()
        timer = (ROOT / "deploy" / "rut1-input-copy" / "research-rut1-input-copy-p2.timer").read_text()
        self.assertIn("--phase p2", service)
        self.assert_uses_installed_qrp_tree(service)
        lines = [line for line in timer.splitlines() if line.startswith("OnCalendar=")]
        self.assertEqual(41, len(lines))
        self.assertEqual("OnCalendar=2026-12-05 15:00:00 Asia/Shanghai", lines[0])
        self.assertEqual("OnCalendar=2026-12-06 11:00:00 Asia/Shanghai", lines[-1])
        self.assertEqual(len(lines), len(set(lines)))

    def test_install_requires_immutable_tree_provenance_and_fixed_rendered_bytes(self):
        install = (ROOT / "deploy" / "rut1-input-copy" / "INSTALL.md").read_text()
        for required in (
            TOKEN,
            "owner",
            "mode",
            "tree manifest",
            "exact reviewed QRP commit",
            "rendered",
            "SHA-256",
        ):
            self.assertIn(required, install)


if __name__ == "__main__":
    unittest.main()
