import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[2] / "services" / "rut1-input-copy"))

from rut1copy import forms


class FormsTest(unittest.TestCase):
    def test_package_a_commands_are_byte_exact(self):
        planned = forms.build_plan("p1", pathlib.Path("/stage")) + forms.build_plan("p2", pathlib.Path("/stage"))
        actual = {operation.form_id: operation.gate_command for operation in planned}
        for day in forms.TRADING_DAYS:
            route = "R-04-" + day.replace("-", "")
            self.assertEqual(
                "rsync --server --sender -logDtprce.iLsfxCIvu --safe-links . "
                + forms.US_1M_ROOT + day + "/", actual[route])
        self.assertEqual(forms.DECISION_GATE_COMMAND, actual["R-05"])
        self.assertEqual(forms.DECISION_SUMS_COMMAND, actual["R-05-PREP"])
        self.assertEqual(forms.FILLS_EXPORT_COMMAND, actual["R-06"])
        self.assertEqual(forms.FILLS_READ_GATE_COMMAND, actual["R-06-READ"])
        self.assertEqual(forms.P2_RAW_GATE_COMMAND, actual["R-16-RAW"])
        self.assertEqual(forms.P2_ALL_GATE_COMMAND, actual["R-16-ALL"])
        self.assertEqual(forms.P2_SUMS_GATE_COMMAND, actual["R-16-SUMS"])
        self.assertNotIn("MARKER", actual)

    def test_manifest_producer_runs_immediately_before_decision_rsync(self):
        planned = forms.build_plan("p1", pathlib.Path("/stage"))
        ids = [operation.form_id for operation in planned]
        self.assertEqual(ids[ids.index("R-05") - 1], "R-05-PREP")
        prep = planned[ids.index("R-05-PREP")]
        self.assertIsNone(prep.destination)
        self.assertEqual(prep.argv[-2:], ["root@47.242.198.62", forms.DECISION_SUMS_COMMAND])

    def test_every_command_is_an_argv_list_with_pinned_key_paths(self):
        for phase in ("p1", "p2"):
            for operation in forms.build_plan(phase, pathlib.Path("/stage")):
                self.assertIsInstance(operation.argv, list)
                self.assertNotIn("shell", operation.argv)
                if operation.argv[0] == "/usr/bin/rsync":
                    remote = operation.argv[operation.argv.index("-e") + 1]
                    self.assertIn("id_ed25519_linux_hk", remote)
                    self.assertIn("known_hosts_hk", remote)

    def test_invalid_day_values_are_refused(self):
        for value in ("../2026-11-10", "2026-1-10", "2026-11-10 extra", "2026-11-26"):
            with self.subTest(value=value), self.assertRaises(forms.FormRefused):
                forms.build_p1_plan(pathlib.Path("/stage"), days=(value,))


if __name__ == "__main__":
    unittest.main()
