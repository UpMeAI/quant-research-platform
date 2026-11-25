import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[2] / "services" / "progress-page"))

from progress import guard


class GuardTest(unittest.TestCase):
    def test_forbidden_names_and_segments(self):
        cases = (
            "/srv/v6-prod/x.json",
            "/srv/research-lane/holdout-sealed/a.json",
            "/srv/research-lane/holdout_vault.jsonl",
            "/srv/research-lane/overseas/runs/rut1-arms-20261122/RUN.txt",
            "/srv/research-lane/x.env",
            "/srv/research-lane/POWER.json",
            "/srv/research-lane/mining_llm_calls.jsonl",
            "/home/kayla/.ssh/id_ed25519",
        )
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(guard.PathForbidden):
                    guard.require_readable_path(value)

    def test_master_table_allows_exactly_two_files(self):
        guard.require_readable_path(
            "/srv/research-lane/master-table/live/RESEARCH_MASTER_TABLE_20261110.json"
        )
        guard.require_readable_path(
            "/srv/research-lane/master-table/state/run_status.json"
        )
        for value in (
            "/srv/research-lane/master-table/live/RESEARCH_MASTER_TABLE_20261110.md",
            "/srv/research-lane/master-table/state/ROW_REGISTRY_V1.jsonl",
            "/srv/research-lane/master-table/revs/101.json",
            "/srv/research-lane/master-table/config/pins.json",
            "/srv/research-lane/master-table/state/.lock",
            "/srv/research-lane/master-table/live/../state/run_status.json",
        ):
            with self.subTest(value=value):
                with self.assertRaises(guard.PathForbidden):
                    guard.require_readable_path(value)

    def test_symlink_is_checked_after_realpath(self):
        with tempfile.TemporaryDirectory() as td:
            link = pathlib.Path(td) / "status.json"
            link.symlink_to("/srv/v6-prod/secret.json")
            with self.assertRaises(guard.PathForbidden):
                guard.require_readable_path(link, allowed_prefixes=(td,))


if __name__ == "__main__":
    unittest.main()
