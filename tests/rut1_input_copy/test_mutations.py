import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[2] / "services" / "rut1-input-copy"))

from rut1copy import forms


class RefusalMutationTest(unittest.TestCase):
    def test_eight_contract_mutants_are_killed(self):
        valid = forms.build_plan("p1", pathlib.Path("/stage"))[0]
        mutants = [
            ("traversal", valid.gate_command.replace("2026-11-10/", "../2026-11-10/")),
            ("extra_arg", valid.gate_command + " EXTRA"),
            ("other_prefix", valid.gate_command.replace(forms.US_1M_ROOT, "/etc/")),
            ("write_server", valid.gate_command.replace("--sender ", "")),
            ("no_safe_links", valid.gate_command.replace(" --safe-links", "")),
            ("shell_meta", valid.gate_command + ";id"),
            ("wrong_day", valid.gate_command.replace("2026-11-10", "2026-11-26")),
            ("wrong_user", valid.gate_command.replace("/home/admin/", "/home/other/")),
        ]
        self.assertEqual(8, len(mutants))
        for name, command in mutants:
            with self.subTest(mutant=name):
                self.assertFalse(forms.is_allowed_gate_command(command))


if __name__ == "__main__":
    unittest.main()
