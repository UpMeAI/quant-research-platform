import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy" / "master-table"


class DeployUnitTests(unittest.TestCase):
    def test_service_and_timer_are_bounded_user_units(self):
        service = (DEPLOY / "master-table.service").read_text(encoding="utf-8")
        timer = (DEPLOY / "master-table.timer").read_text(encoding="utf-8")
        self.assertIn("Type=oneshot", service)
        self.assertIn("/usr/bin/python3 -I -B", service)
        self.assertIn("Nice=10", service)
        self.assertIn("IOSchedulingClass=idle", service)
        self.assertIn("TimeoutStartSec=300", service)
        self.assertNotIn("Environment=", service)
        self.assertNotIn("network", service.lower())
        self.assertIn("OnCalendar=*-*-* *:17:00", timer)
        self.assertIn("Persistent=true", timer)

    def test_example_and_install_keep_authority_switch_closed(self):
        config = json.loads((DEPLOY / "MASTER_TABLE_CONFIG_V1.example.json").read_text(encoding="utf-8"))
        self.assertFalse(config["qrp_var_authoritative"])
        self.assertEqual("MASTER_TABLE_CONFIG_V1", config["schema"])
        install = (DEPLOY / "INSTALL.md").read_text(encoding="utf-8")
        self.assertIn("QRP_VAR_NOT_AUTHORITATIVE", install)
        self.assertIn("--check", install)
        self.assertIn("NO_CHANGE", install)
        self.assertIn("sha256sum -c", install)
        self.assertIn("12:30", install)
        self.assertNotIn("systemctl enable --now", install)


if __name__ == "__main__":
    unittest.main()
