import json
import shlex
import subprocess
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
        self.assertIn("RestrictAddressFamilies=AF_UNIX", service)
        self.assertIn("IPAddressDeny=any", service)
        self.assertNotIn("Environment=", service)
        self.assertNotIn("network", service.lower())
        self.assertIn("OnCalendar=*-*-* *:17:00", timer)
        self.assertIn("Persistent=true", timer)

    def test_service_execstart_imports_mtl_under_isolated_python(self):
        service = (DEPLOY / "master-table.service").read_text(encoding="utf-8")
        line = next(line for line in service.splitlines() if line.startswith("ExecStart="))
        argv = shlex.split(line.removeprefix("ExecStart="))
        self.assertEqual(["/usr/bin/python3", "-I", "-B"], argv[:3])
        self.assertEqual("/srv/research-lane/qrp/services/master-table/run_master_table.py", argv[3])
        local_script = ROOT / "services" / "master-table" / "run_master_table.py"
        completed = subprocess.run(
            [*argv[:3], str(local_script), "--help"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertIn("--config", completed.stdout)

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
        self.assertIn("RestrictAddressFamilies=AF_UNIX", install)
        self.assertIn("IPAddressDeny=any", install)
        self.assertNotIn("systemctl enable --now", install)


if __name__ == "__main__":
    unittest.main()
