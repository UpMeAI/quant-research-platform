import hashlib
import importlib.util
import json
import os
import shutil
import stat
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "services" / "pause-recheck" / "pause_recheck.py"
SPEC = importlib.util.spec_from_file_location("pause_recheck", MODULE)
pause_recheck = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pause_recheck)

CST = timezone(timedelta(hours=8))
NOW = datetime(2026, 12, 3, 22, 0, tzinfo=CST)
SHA = "a" * 64


def pretty(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=1) + "\n").encode()


def engine_doc(body):
    return {**body, "output_sha256": hashlib.sha256(pretty(body)).hexdigest()}


def terms(candidate="C-1", market="CN_A"):
    return {
        "schema": "PROMOTION_TERMS_V1",
        "candidate_id": candidate,
        "market": market,
        "layer": "ALPHA",
        "k2_sha256": SHA,
        "k2_frozen_at": "2026-11-24T10:00:00+08:00",
        "terms_frozen_at": "2026-11-24T10:00:00+08:00",
        "mechanism_ids": ["ACCT.CONCURRENCY.NON_MAJOR_CAP"],
        "min_sample_n": 200,
        "min_economic_value": {"metric": "DELTA_G_PER_YEAR", "value": 0.02},
        "thresholds": {"s3": {"cost_multiple": 2, "max_growth_sacrifice": 0.01}, "s4": {"max_overlap": 0.6}},
        "insufficient_policy": {
            "horizon_months": 12,
            "p_threshold": 0.5,
            "budget_share_max": 0.2,
            "resume_sample_fraction": 0.5,
            "max_failed_rechecks": 3,
        },
        "review_endpoint": {"kind": "DATE", "value": "2027-03-01"},
        "stage_evidence": {},
    }


class FakeRunner:
    def __init__(self, results=None, unavailable=False):
        self.results = list(results or [])
        self.unavailable = unavailable
        self.calls = []

    def __call__(self, argv, env):
        self.calls.append((list(argv), dict(env)))
        if self.unavailable:
            raise FileNotFoundError("node")
        result = self.results.pop(0) if self.results else {
            "schema": "PROMOTION_RECHECK_V1",
            "candidate_id": "C-1",
            "as_of": NOW.isoformat(),
            "paused_output_sha256": None,
            "paused_code": "PAUSE_LOW_POWER",
            "state": "STILL_PAUSED",
            "conclusion": "暂停",
            "failed_rechecks": 1,
            "escalate": False,
            "nextAction": "RECHECK_NEXT_MONTH",
            "reasonCodes": ["SAMPLE_AND_RATE_STILL_SHORT"],
            "production_effect": "NONE",
        }
        return pause_recheck.CommandResult(0, pretty(engine_doc(result)).decode(), "")


class World:
    def __init__(self, now=NOW, results=True):
        self.tmp = tempfile.TemporaryDirectory(prefix="q153-")
        self.root = Path(self.tmp.name)
        self.var_root = self.root / "var"
        self.data = self.var_root / "ledger"
        self.research = self.data / "research"
        self.promotion = self.research / "promotion"
        self.results = self.promotion / "results"
        self.terms = self.promotion / "terms"
        self.observed = self.promotion / "observed"
        self.state = self.research / "pause-recheck"
        self.inbox = self.root / "inbox"
        self.queue_status = self.root / "queue-status.json"
        self.queue_runs = self.root / "queue-runs"
        self.blackouts = self.root / "blackouts.json"
        self.now = now
        if results:
            self.results.mkdir(parents=True)
        self.terms.mkdir(parents=True)
        self.observed.mkdir(parents=True)
        self.inbox.mkdir(parents=True)
        self.blackouts.write_text('{"entries":[]}\n')

    def config(self, **over):
        base = dict(
            data_dir=self.data,
            var_root=self.var_root,
            state_dir=self.state,
            inbox_dir=self.inbox,
            queue_status_path=self.queue_status,
            queue_runs_dir=self.queue_runs,
            blackouts_path=self.blackouts,
            engine_cli=ROOT / "services" / "promotion-engine" / "cli.js",
            template_sha256="b" * 64,
            data_candidates=(self.var_root,),
            manifest_files=(),
            writable_probe=lambda p: p == self.var_root,
        )
        base.update(over)
        return pause_recheck.Config(**base)

    def supervisor(self, runner=None, **config):
        return pause_recheck.Supervisor(self.config(**config), runner=runner, now=lambda: self.now)

    def add_result(self, candidate="C-1", market="CN_A", as_of="2026-11-30T10:00:00+08:00", paused=True, code="PAUSE_LOW_POWER", suffix="1"):
        t = terms(candidate, market)
        tbytes = pretty(t)
        tsha = hashlib.sha256(tbytes).hexdigest()
        (self.terms / f"{tsha}.json").write_bytes(tbytes)
        resolution = ({
            "conclusion": "暂停",
            "code": code,
            "resume_condition": {"kind": "SAMPLE_FRACTION_OR_RATE_RECOVERY", "sample_n_target": 100},
            "recheck": {"cadence": "MONTHLY", "max_failed_rechecks": 3, "on_exhaustion": "PAUSE_ESCALATE_TO_OWNER"},
            "policy_source": "K2_FROZEN_POLICY",
        } if paused else None)
        body = {
            "schema": "PROMOTION_RESULT_V1",
            "candidate_id": candidate,
            "stage": "S2",
            "verdict": "INSUFFICIENT" if paused else "PASS",
            "reasonCodes": [code] if paused else ["PASS"],
            "nextAction": "PAUSE_UNTIL_RESUME_CONDITION" if paused else "PROCEED_TO_S3",
            "resolution": resolution,
            "as_of": as_of,
            "inputs": {"terms_sha256": tsha, "evidence_sha256": "c" * 64},
            "value_config_sha256": "d" * 64,
            "production_effect": "NONE",
        }
        result = engine_doc(body)
        path = self.results / f"{candidate}.{suffix}.json"
        path.write_bytes(pretty(result))
        return result, path, t

    def add_observed(self, result, observed=None, month="2026-12"):
        body = {
            "schema": "PROMOTION_RECHECK_OBSERVED_V1",
            "candidate_id": result["candidate_id"],
            "month": month,
            "paused_output_sha256": result["output_sha256"],
            "observed": observed or {"observed_sample_n": 100, "events_per_month": 0},
            "sources": [{"path": "research/source.json", "sha256": "e" * 64}],
            "written_by": "fixture",
        }
        path = self.observed / result["candidate_id"] / f"{month}.json"
        path.parent.mkdir(parents=True)
        path.write_bytes(pretty(body))
        return path

    def pause_list(self):
        return json.loads((self.state / "2026-12" / "PAUSE_LIST_V1.json").read_text())

    def alerts(self):
        p = self.state / "alert_status.json"
        return json.loads(p.read_text())["active"] if p.exists() else []


class PauseRecheckTests(unittest.TestCase):
    def test_empty_results_and_source_absent_are_distinct_and_idempotent(self):
        empty = World()
        first = empty.supervisor().tick()
        self.assertEqual(first["state"], "DONE_NO_PAUSED_ROWS")
        self.assertEqual(empty.pause_list()["list_state"], "NO_PAUSED_ROWS")
        self.assertEqual(empty.pause_list()["source"]["results_seen"], 0)
        self.assertFalse(list((empty.inbox / "requests").glob("*.json")))
        before = (empty.state / "2026-12" / "PAUSE_LIST_V1.json").read_bytes()
        empty.supervisor().tick()
        self.assertEqual((empty.state / "2026-12" / "PAUSE_LIST_V1.json").read_bytes(), before)
        self.assertEqual(empty.alerts(), [])

        absent = World(results=False)
        self.assertEqual(absent.supervisor().tick()["state"], "SOURCE_ABSENT")
        self.assertEqual(absent.pause_list()["list_state"], "SOURCE_ABSENT")
        absent.supervisor().tick()
        self.assertEqual([a["code"] for a in absent.alerts()], ["SOURCE_ABSENT"])

    def test_latest_paused_only_and_sha_mismatch_or_tie_are_unknown(self):
        w = World()
        w.add_result("A", paused=True, as_of="2026-10-01T10:00:00+08:00", suffix="old")
        w.add_result("A", paused=False, as_of="2026-11-01T10:00:00+08:00", suffix="new")
        rb, pb, _ = w.add_result("B")
        w.add_observed(rb)
        w.add_result("C", paused=True, as_of="2026-11-02T10:00:00+08:00", suffix="x")
        w.add_result("C", paused=True, as_of="2026-11-02T10:00:00+08:00", suffix="y")
        raw = bytearray(pb.read_bytes()); raw[-3] = ord("x"); pb.write_bytes(raw)
        out = w.supervisor(FakeRunner()).tick()
        rows = {r["candidate_id"]: r for r in w.pause_list()["rows"]}
        self.assertNotIn("A", rows)
        self.assertEqual(rows["B"]["month_state"], "INPUT_INVALID:RESULT_SHA_MISMATCH")
        self.assertEqual(rows["C"]["month_state"], "INPUT_INVALID:RESULT_TIE")
        self.assertEqual(out["state"], "DONE_ROWS")

    def test_missing_observed_never_calls_engine_or_advances_history(self):
        w = World(); w.add_result()
        runner = FakeRunner()
        w.supervisor(runner).tick()
        self.assertEqual(w.pause_list()["rows"][0]["month_state"], "OBSERVED_MISSING")
        self.assertEqual(runner.calls, [])
        ledger = pause_recheck.read_jsonl(w.state / "PAUSE_RECHECK_LEDGER.jsonl")
        self.assertNotIn("RECHECK_DONE", [x["event"] for x in ledger])
        self.assertEqual([a["code"] for a in w.alerts()], ["OBSERVED_MISSING:C-1"])

    def test_stub_engine_argv_and_resume_mapping(self):
        w = World(); result, _, _ = w.add_result(); w.add_observed(result)
        engine = {
            "schema": "PROMOTION_RECHECK_V1", "candidate_id": "C-1", "as_of": NOW.isoformat(),
            "paused_output_sha256": result["output_sha256"], "paused_code": "PAUSE_LOW_POWER",
            "state": "RESUME", "conclusion": None, "failed_rechecks": 0, "escalate": False,
            "nextAction": "REJUDGE_UNDER_SECTION_4_2", "reasonCodes": ["RESUME_SAMPLE_FRACTION_REACHED"], "production_effect": "NONE",
        }
        runner = FakeRunner([engine])
        w.supervisor(runner).tick()
        argv = runner.calls[0][0]
        self.assertEqual(argv[1:3], [str(ROOT / "services" / "promotion-engine" / "cli.js"), "recheck"])
        for flag in ("--paused", "--terms", "--observed", "--history", "--as-of", "--out"):
            self.assertIn(flag, argv)
        row = w.pause_list()["rows"][0]
        self.assertEqual((row["month_state"], row["next_action"]), ("REOPEN_CANDIDATE", "REJUDGE_UNDER_SECTION_4_2"))

    def test_real_engine_resumes_at_frozen_sample_boundary(self):
        if not shutil.which("node"):
            self.skipTest("node is not on PATH")
        w = World(); result, _, _ = w.add_result(); w.add_observed(result, {"observed_sample_n": 100, "events_per_month": 0})
        w.supervisor().tick()
        self.assertEqual(w.pause_list()["rows"][0]["month_state"], "REOPEN_CANDIDATE")

    def test_failed_history_excludes_unknown_month_and_escalates_at_three(self):
        w = World(); result, _, _ = w.add_result(); w.add_observed(result, {"observed_sample_n": 1, "events_per_month": 0})
        sup = w.supervisor(FakeRunner([{
            "schema": "PROMOTION_RECHECK_V1", "candidate_id": "C-1", "as_of": NOW.isoformat(),
            "paused_output_sha256": result["output_sha256"], "paused_code": "PAUSE_LOW_POWER", "state": "PAUSE_ESCALATE_TO_OWNER",
            "conclusion": "暂停", "failed_rechecks": 3, "escalate": True, "nextAction": "PLAN_COORD_RECOMMENDS_TO_OWNER",
            "reasonCodes": ["SAMPLE_AND_RATE_STILL_SHORT", "PAUSE_ESCALATE_TO_OWNER", "NO_AUTOMATIC_CONVERSION"], "production_effect": "NONE",
        }]))
        sup.append_event("2026-10", "RECHECK_DONE", {"candidate_id": "C-1", "paused_output_sha256": result["output_sha256"], "as_of": "2026-10-03T22:00:00+08:00", "state": "STILL_PAUSED"})
        sup.append_event("2026-11", "ROW_UNKNOWN", {"candidate_id": "C-1", "paused_output_sha256": result["output_sha256"], "as_of": "2026-11-03T22:00:00+08:00", "state": "OBSERVED_MISSING"})
        sup.append_event("2026-11", "RECHECK_DONE", {"candidate_id": "C-1", "paused_output_sha256": result["output_sha256"], "as_of": "2026-11-04T22:00:00+08:00", "state": "STILL_PAUSED"})
        sup.tick()
        history_path = Path(sup.runner.calls[0][0][sup.runner.calls[0][0].index("--history") + 1])
        history = json.loads(history_path.read_text())
        self.assertEqual([h["state"] for h in history], ["STILL_PAUSED", "STILL_PAUSED"])
        self.assertEqual(w.pause_list()["rows"][0]["month_state"], "STAY_PAUSED_ESCALATED")
        self.assertNotIn("不做", (w.state / "2026-12" / "PAUSE_LIST_V1.json").read_text())

    def test_prior_resume_waits_for_rejudge_without_engine_call(self):
        w = World(); result, _, _ = w.add_result(); w.add_observed(result)
        sup = w.supervisor(FakeRunner())
        sup.append_event("2026-11", "RECHECK_DONE", {"candidate_id": "C-1", "paused_output_sha256": result["output_sha256"], "as_of": "2026-11-03T22:00:00+08:00", "state": "RESUME"})
        sup.tick()
        self.assertEqual(w.pause_list()["rows"][0]["month_state"], "REOPEN_CANDIDATE_WAITING_REJUDGE")
        self.assertEqual(sup.runner.calls, [])

    def test_blackout_window_and_missed_are_bounded_waits(self):
        w = World()
        w.blackouts.write_text(json.dumps({"entries": [{"id": "X", "start": "2026-12-03T21:00:00+08:00", "end": "2026-12-03T23:00:00+08:00", "hosts": ["LINUX"], "mode": "FREEZE"}]}))
        self.assertEqual(w.supervisor().tick()["state"], "WAIT_BLACKOUT")
        self.assertFalse((w.state / "2026-12" / "PAUSE_LIST_V1.json").exists())
        w.now = datetime(2026, 12, 4, 22, 0, tzinfo=CST)
        self.assertEqual(w.supervisor().tick()["state"], "DONE_NO_PAUSED_ROWS")

        daytime = World(now=datetime(2026, 12, 3, 10, 0, tzinfo=CST))
        self.assertEqual(daytime.supervisor().tick()["state"], "WAIT_WINDOW")
        missed = World(now=datetime(2026, 12, 8, 0, 1, tzinfo=CST))
        self.assertEqual(missed.supervisor().tick()["state"], "MISSED")
        self.assertEqual([a["code"] for a in missed.alerts()], ["PAUSE_RECHECK_MISSED"])

    def test_forbidden_conclusion_engine_unavailable_and_ledger_tamper_refuse(self):
        forbidden = World(); result, _, _ = forbidden.add_result(); forbidden.add_observed(result)
        bad = {"schema": "PROMOTION_RECHECK_V1", "candidate_id": "C-1", "as_of": NOW.isoformat(), "state": "STILL_PAUSED", "conclusion": "不做", "reasonCodes": []}
        self.assertEqual(forbidden.supervisor(FakeRunner([bad])).tick()["state"], "REFUSED:FORBIDDEN_CONCLUSION")
        self.assertFalse((forbidden.state / "2026-12" / "PAUSE_LIST_V1.json").exists())

        unavailable = World(); result, _, _ = unavailable.add_result(); unavailable.add_observed(result)
        self.assertEqual(unavailable.supervisor(FakeRunner(unavailable=True)).tick()["state"], "REFUSED:ENGINE_UNAVAILABLE")

        tamper = World(); sup = tamper.supervisor(); sup.append_event("2026-11", "TICK_START", {})
        p = tamper.state / "PAUSE_RECHECK_LEDGER.jsonl"
        p.write_text(p.read_text().replace("TICK_START", "LIST_WRITTEN"))
        self.assertEqual(sup.tick()["state"], "REFUSED:LEDGER_BROKEN")
        self.assertEqual([a["code"] for a in tamper.alerts()], ["REFUSED:LEDGER_BROKEN"])

    def test_two_market_requests_have_distinct_subjects_and_firewall_safe_packs(self):
        w = World()
        for candidate, market in (("C-1", "CN_A"), ("U-1", "US_EQUITY")):
            result, _, _ = w.add_result(candidate, market, suffix=market)
            w.add_observed(result)
        w.supervisor(FakeRunner()).tick()
        reqs = [json.loads(p.read_text()) for p in sorted((w.inbox / "requests").glob("*.json"))]
        self.assertEqual(len(reqs), 2)
        self.assertEqual(len({json.dumps(r["subject"], sort_keys=True) for r in reqs}), 2)
        for req in reqs:
            bundle = json.loads(Path(req["inputs"][0]["path"]).read_text())
            self.assertEqual(bundle["schema"], "RQ_AGENT_BUNDLE_V1")
            self.assertEqual([r["req_id"] for r in bundle["pack"]["evidence_matrix"]], ["PR-1", "PR-2", "PR-3"])
            self.assertNotRegex(json.dumps(bundle, ensure_ascii=False), r'(?i)"(?:owner|desk)[^"]*"\s*:')
            for fact in bundle["pack"]["facts"]:
                self.assertFalse(pause_recheck.fact_source_forbidden(fact["source"]))

    def test_card_collection_never_changes_month_state(self):
        w = World(); result, _, _ = w.add_result(); w.add_observed(result)
        w.supervisor(FakeRunner()).tick()
        original = w.pause_list()["rows"][0]["month_state"]
        request = next((w.inbox / "requests").glob("*.json"))
        subject = json.loads(request.read_text())["subject"]
        for status, verdict, expected in (("DONE", "CONSISTENT", "DONE_CONSISTENT"), ("DONE", "HOLD", "DONE_HOLD"), ("BLOCKED_DETERMINISTIC", None, "CARD_BLOCKED")):
            w.queue_status.write_text(json.dumps({"schema": "RQ_STATUS_V1", "tasks": [{"task_id": "RQT-1", "subject": subject, "state": status, "verdict": verdict, "codes": []}]}))
            out = w.supervisor().tick()
            self.assertEqual(out["cards"]["C-1"], expected)
            self.assertEqual(w.pause_list()["rows"][0]["month_state"], original)
        w.now = datetime(2026, 12, 7, 22, 0, tzinfo=CST)
        w.queue_status.unlink()
        self.assertEqual(w.supervisor().tick()["cards"]["C-1"], "CARD_LATE")

    def test_var_authority_refusals_and_read_only_backup(self):
        w = World(); backup = w.root / "mac-var"; backup.mkdir()
        pause_recheck.validate_qrp_var(w.config(data_candidates=(w.var_root, backup), writable_probe=lambda p: p == w.var_root))
        with self.assertRaisesRegex(pause_recheck.ConfigError, "QRP_VAR_DUAL_WRITABLE"):
            pause_recheck.validate_qrp_var(w.config(data_candidates=(w.var_root, backup), writable_probe=lambda p: True))
        a = w.root / "linux.manifest"; b = w.root / "mac.manifest"; a.write_text("a\n"); b.write_text("b\n")
        with self.assertRaisesRegex(pause_recheck.ConfigError, "QRP_VAR_MANIFEST_MISMATCH"):
            pause_recheck.validate_qrp_var(w.config(data_candidates=(w.var_root, backup), manifest_files=(a, b)))

    def test_artifacts_are_read_only_and_protected_inputs_unchanged(self):
        w = World(); result, result_path, _ = w.add_result(); observed = w.add_observed(result)
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (result_path, observed, next(w.terms.glob("*.json")))}
        w.supervisor(FakeRunner()).tick()
        artifacts = [w.state / "2026-12" / "PAUSE_LIST_V1.json", w.state / "2026-12" / "AI_CHECKS_V1.json"]
        self.assertTrue(all((p.stat().st_mode & stat.S_IWUSR) == 0 for p in artifacts))
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in before})
        self.assertEqual(w.config().data_dir, w.var_root / "ledger")


if __name__ == "__main__":
    unittest.main()
