import datetime as dt
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[2] / "services" / "progress-page"))

from progress import registry


NOW = dt.datetime(2026, 11, 26, 9, 7, 2, tzinfo=dt.timezone(dt.timedelta(hours=8)))


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


FED_FIELDS = (
    "verdict", "verdictToken", "status", "sealedOn", "sealSha256",
    "k2State", "tStart", "tStartRegistryStatus", "nextCheck",
)


def fed(row_class="FROZEN_CLOSED"):
    return {
        "schema": "MASTER_TABLE_FED_V1",
        "rowClass": row_class,
        **{
            name: {"state": "MISSING", "value": None,
                   "reason": "NO_PRODUCER_DECLARED", "src": None}
            for name in FED_FIELDS
        },
        "records": [],
    }


def master_table(revision=101, items=None):
    return {
        "revision": revision,
        "asOf": "2026-11-26",
        "marketCounts": {"byMarket": {
            "CN_A": {"done": 1, "forward": 0, "running": 0,
                     "todo": 0, "blocked": 0, "total": 1},
        }},
        "ledgerOverlay": {
            "evaluatedOn": "2026-11-26", "frozenRev": 100, "unjoined": [],
        },
        "items": items if items is not None else [{"id": "Z1", "ledgerFed": fed()}],
    }


def run_status(revision=101):
    return {
        "schema": "MASTER_TABLE_RUN_STATUS_V1", "result": "NO_CHANGE",
        "code": None, "rev": revision,
        "ran_at": "2026-11-26T08:07:02+08:00", "evaluatedOn": "2026-11-26",
    }


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.cfg = {
            "schema": "PROGRESS_CONFIG_V1",
            "generator_commit": "0123456789ab",
            "stale_banner_after_h": 3,
            "allowed_read_prefixes": [str(self.root)],
            "sections": {},
            "upload": {"enabled": False},
        }

    def tearDown(self):
        self.temp.cleanup()

    def section(self, obj, key):
        return next(row for row in obj["sections"] if row["key"] == key)

    def test_s2_state_freshness_whitelist_and_spend_redaction(self):
        path = self.root / "status.json"
        dump(path, {
            "schema": "RQ_STATUS_V1", "host": "linux", "at": "2026-11-26T08:57:02+08:00",
            "counts": {"READY": 2}, "oldest_age_s": {"READY": 3},
            "sla_breaches": ["a", "b"], "consumer_heartbeat": "ok",
            "pauses": {}, "circuits": [],
            "alerts": [{"code": "RQ_STUCK", "priority": "P2", "dry_run": True, "tasks": ["a"]}],
            "spend": {"month": "2026-11", "keys": {
                "secret-key-id": {"by_purpose": {"review": {"cny": 1.5, "usd": 0.2}}, "calls": 9}
            }}, "event_head": "must-not-leak",
        })
        self.cfg["sections"]["S2"] = {"path": str(path), "max_age_h": 1}
        row = self.section(registry.build(self.cfg, NOW), "S2_AQ_LINUX")
        self.assertEqual("OK", row["state"])
        encoded = json.dumps(row["data"], ensure_ascii=False)
        self.assertNotIn("secret-key-id", encoded)
        self.assertNotIn("event_head", encoded)
        self.assertEqual(2, row["data"]["sla_breaches"]["count"])

        value = json.loads(path.read_text())
        value["at"] = "2026-11-26T08:06:02+08:00"
        dump(path, value)
        row = self.section(registry.build(self.cfg, NOW), "S2_AQ_LINUX")
        self.assertEqual("STALE", row["state"])
        self.assertAlmostEqual(1.0167, row["freshness"]["age_h"], places=3)
        self.assertIsNotNone(row["data"])

    def test_s2_fail_closed_states(self):
        path = self.root / "missing.json"
        self.cfg["sections"]["S2"] = {
            "path": str(path), "max_age_h": 1, "due_at": "2026-11-25T00:00:00+08:00"
        }
        row = self.section(registry.build(self.cfg, NOW), "S2_AQ_LINUX")
        self.assertEqual(("MISSING", "FILE_ABSENT", None), (row["state"], row["reason"], row["data"]))
        path.write_text("{", encoding="utf-8")
        row = self.section(registry.build(self.cfg, NOW), "S2_AQ_LINUX")
        self.assertEqual(("UNKNOWN", "PARSE_ERROR", None), (row["state"], row["reason"], row["data"]))
        for mutation, reason in (
            ({"schema": "WRONG", "at": NOW.isoformat()}, "SCHEMA_MISMATCH"),
            ({"schema": "RQ_STATUS_V1"}, "AS_OF_MISSING"),
            ({"schema": "RQ_STATUS_V1", "at": "2026-11-26T10:07:02+08:00"}, "AS_OF_IN_FUTURE"),
        ):
            dump(path, mutation)
            row = self.section(registry.build(self.cfg, NOW), "S2_AQ_LINUX")
            self.assertEqual(("UNKNOWN", reason, None), (row["state"], row["reason"], row["data"]))

    def test_s3_last_row_per_round_and_bad_line(self):
        path = self.root / "mining_rounds.jsonl"
        rows = [
            {"round_id": "R1", "market": "CN_A", "month": "2026-11", "status": "OPEN", "generator": "private", "opened_at": NOW.isoformat(), "cap": 3, "candidates_scored": 0},
            {"round_id": "R2", "market": "CN_A", "month": "2026-11", "status": "CLOSED", "opened_at": NOW.isoformat(), "closed_at": NOW.isoformat(), "cap": 3, "candidates_scored": 2},
            {"round_id": "R1", "market": "CN_A", "month": "2026-11", "status": "SCORING", "holdout": "private", "opened_at": NOW.isoformat(), "cap": 3, "candidates_scored": 1},
        ]
        path.write_text("\n".join(json.dumps(x) for x in rows) + "\n", encoding="utf-8")
        self.cfg["sections"]["S3"] = {"rounds_path": str(path), "due_at": "2026-12-01T20:45:00+08:00"}
        row = self.section(registry.build(self.cfg, NOW), "S3_RF1116")
        self.assertEqual("OK", row["state"])
        self.assertEqual({"R1": "SCORING", "R2": "CLOSED"}, {x["round_id"]: x["status"] for x in row["data"]["rounds"]})
        self.assertNotIn("holdout", json.dumps(row["data"]))
        path.write_text(path.read_text() + "{bad\n", encoding="utf-8")
        row = self.section(registry.build(self.cfg, NOW), "S3_RF1116")
        self.assertEqual(("UNKNOWN", "PARSE_ERROR", None), (row["state"], row["reason"], row["data"]))

    def test_s4_due_and_latest_thirty(self):
        path = self.root / "sealed.jsonl"
        self.cfg["sections"]["S4"] = {"ashare_path": str(path), "due_at": "2026-11-27T00:00:00+08:00"}
        row = self.section(registry.build(self.cfg, NOW), "S4_SEALED_VERDICTS")
        self.assertEqual(("NOT_APPLICABLE", "NOT_YET_DUE"), (row["state"], row["reason"]))
        self.cfg["sections"]["S4"]["due_at"] = "2026-11-25T00:00:00+08:00"
        row = self.section(registry.build(self.cfg, NOW), "S4_SEALED_VERDICTS")
        self.assertEqual(("MISSING", "FILE_ABSENT"), (row["state"], row["reason"]))
        rows = [{"entry_id": str(i), "kind": "K", "strategy_ref": "S", "decision": "做", "sealed_on": "x", "production_effect": "NONE", "supersedes_ref": None, "locked_at": f"2026-11-25T{i:02d}:00:00+08:00", "file_sha256": "a" * 64} for i in range(35)]
        path.write_text("\n".join(json.dumps(x) for x in rows) + "\n")
        row = self.section(registry.build(self.cfg, NOW), "S4_SEALED_VERDICTS")
        self.assertEqual(35, row["data"]["total"])
        self.assertEqual(30, len(row["data"]["rows"]))
        self.assertEqual("34", row["data"]["rows"][0]["entry_id"])

    def test_s5_reads_only_ledger_and_sealed_digest(self):
        run = self.root / "run"
        run.mkdir()
        ledger = run / "RUN_LEDGER.jsonl"
        ledger.write_text(json.dumps({"at": NOW.isoformat(), "state": "VERDICT_SEALED"}) + "\n")
        sealed = run / "SEALED.json"
        sealed.write_bytes(b"sealed")
        (run / "VERDICT.json").write_text("PRIVATE-MARKER")
        (run / "POWER.json").write_text("PRIVATE-MARKER")
        self.cfg["sections"]["S5"] = {"runs": [{"name": "RUN_A", "ledger_path": str(ledger), "sealed_path": str(sealed), "due_at": "2026-11-25T00:00:00+08:00", "max_age_h": 6}]}
        row = self.section(registry.build(self.cfg, NOW), "S5_RUT1")
        self.assertEqual("OK", row["state"])
        self.assertEqual("VERDICT_SEALED", row["data"]["runs"][0]["state"])
        self.assertEqual(hashlib.sha256(b"sealed").hexdigest(), row["data"]["runs"][0]["sealed_sha256"])
        self.assertNotIn("PRIVATE-MARKER", json.dumps(row))

    def test_s7_sha_and_verbatim_rows(self):
        path = self.root / "plan.json"
        value = {"schema": "PLAN_SNAPSHOT_V1", "workplan": [{"key": "x", "state": "进行中"}], "focus": [], "milestones": []}
        dump(path, value)
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        self.cfg["sections"]["S7"] = {"path": str(path), "sha256": sha}
        row = self.section(registry.build(self.cfg, NOW), "S7_PLAN_SNAPSHOT")
        self.assertEqual(value["workplan"], row["data"]["workplan"])
        path.write_text(path.read_text() + " ")
        row = self.section(registry.build(self.cfg, NOW), "S7_PLAN_SNAPSHOT")
        self.assertEqual(("UNKNOWN", "SHA_MISMATCH", None), (row["state"], row["reason"], row["data"]))

    def test_s9_whitelist_counts_and_no_text(self):
        table = self.root / "RESEARCH_MASTER_TABLE_20261110.json"
        status = self.root / "run_status.json"
        row_fed = fed("NEW")
        row_fed["verdict"] = {"state": "OK", "value": "做", "reason": None, "src": "sealed"}
        row_fed["status"] = {"state": "MISSING", "value": None, "reason": "NO_PRODUCER_DECLARED", "src": None}
        row_fed["sealedOn"] = {"state": "OK", "value": "2026-11-26", "reason": None, "src": "sealed"}
        value = master_table(items=[{"id": "Z1", "detail": "NEVER-LEAK-ME", "ledgerFed": row_fed}])
        value["ledgerOverlay"]["unjoined"] = [1, 2]
        dump(table, value)
        dump(status, run_status())
        self.cfg["sections"]["S9"] = {"table_path": str(table), "status_path": str(status), "due_at": "2026-11-25T18:30:00+08:00", "max_age_h": 3}
        row = self.section(registry.build(self.cfg, NOW), "S9_MASTER_TABLE")
        self.assertEqual("OK", row["state"])
        self.assertEqual(2, row["data"]["ledgerOverlay"]["unjoined_count"])
        self.assertEqual(["Z1"], [x["id"] for x in row["data"]["new_rows"]])
        self.assertNotIn("NEVER-LEAK-ME", json.dumps(row))

    def test_s9_without_ledger_fed_is_zero(self):
        table = self.root / "RESEARCH_MASTER_TABLE_20261110.json"
        status = self.root / "run_status.json"
        dump(table, master_table(revision=100, items=[{"id": "old", "detail": "x"}]))
        value = run_status(revision=100)
        value["ran_at"] = NOW.isoformat()
        dump(status, value)
        self.cfg["sections"]["S9"] = {"table_path": str(table), "status_path": str(status), "due_at": "2026-11-25T18:30:00+08:00", "max_age_h": 3}
        row = self.section(registry.build(self.cfg, NOW), "S9_MASTER_TABLE")
        self.assertEqual("ZERO", row["state"])

    def test_s9_rejects_incomplete_or_conflicting_contracts(self):
        table = self.root / "RESEARCH_MASTER_TABLE_20261110.json"
        status = self.root / "run_status.json"
        self.cfg["sections"]["S9"] = {
            "table_path": str(table), "status_path": str(status),
            "due_at": "2026-11-25T18:30:00+08:00", "max_age_h": 3,
        }
        cases = []
        cases.append((master_table(), {k: v for k, v in run_status().items() if k != "schema"}))
        cases.append((master_table(items=[]), run_status()))
        cases.append((master_table(revision=102), run_status(revision=101)))
        partial = fed()
        del partial["nextCheck"]
        cases.append((master_table(items=[{"id": "Z1", "ledgerFed": partial}]), run_status()))
        for table_value, status_value in cases:
            with self.subTest(table=table_value, status=status_value):
                dump(table, table_value)
                dump(status, status_value)
                row = self.section(registry.build(self.cfg, NOW), "S9_MASTER_TABLE")
                self.assertEqual(
                    ("UNKNOWN", "SCHEMA_MISMATCH", None),
                    (row["state"], row["reason"], row["data"]),
                )

    def test_registry_is_only_page_age_producer(self):
        current = registry.build(self.cfg, NOW)
        self.assertEqual(("OK", 0.0), (current["page_age_state"], current["page_age_h"]))

        aged = registry.with_page_age(current, NOW + dt.timedelta(hours=4))
        self.assertEqual(("OK", 4.0), (aged["page_age_state"], aged["page_age_h"]))
        self.assertEqual(0.0, current["page_age_h"])

        missing = registry.with_page_age({"schema": "PROGRESS_REGISTRY_V1"}, NOW)
        invalid = registry.with_page_age(
            {"schema": "PROGRESS_REGISTRY_V1", "generated_at": "not-a-time"}, NOW
        )
        self.assertEqual(("MISSING", None), (missing["page_age_state"], missing["page_age_h"]))
        self.assertEqual(("UNKNOWN", None), (invalid["page_age_state"], invalid["page_age_h"]))

    def test_registry_hash_determinism_null_data_and_atomic_failure(self):
        first = registry.build(self.cfg, NOW)
        second = registry.build(self.cfg, NOW)
        self.assertEqual(first, second)
        unsigned = dict(first)
        digest = unsigned.pop("registry_sha256")
        canonical = json.dumps(unsigned, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        self.assertEqual(hashlib.sha256(canonical).hexdigest(), digest)
        for row in first["sections"]:
            if row["state"] in {"MISSING", "UNKNOWN", "NOT_APPLICABLE"}:
                self.assertIsNone(row["data"])
        target = self.root / "registry.json"
        target.write_text("old")
        with mock.patch("progress.registry.os.replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                registry.write_atomic(first, target)
        self.assertEqual("old", target.read_text())


if __name__ == "__main__":
    unittest.main()
