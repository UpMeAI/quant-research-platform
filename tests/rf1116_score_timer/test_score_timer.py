import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "services" / "rf1116-score-timer" / "score_timer.py"
SPEC = importlib.util.spec_from_file_location("rf1116_score_timer", MODULE)
timer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(timer)

CST = timezone(timedelta(hours=8))


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def record(body):
    return {**body, "record_hash": hashlib.sha256(canonical(body).encode()).hexdigest()}


def append(path, row, newline=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as out:
        out.write(canonical(row).encode())
        if newline:
            out.write(b"\n")


class FakeRunner:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def __call__(self, argv, env):
        self.calls.append((list(argv), dict(env)))
        return self.handler(list(argv), dict(env))


class World:
    def __init__(self, now=None, segment="R1", selected=None):
        self.tmp = tempfile.TemporaryDirectory(prefix="q151-")
        self.root = Path(self.tmp.name)
        self.var_root = self.root / "var"
        self.data = self.var_root / "ledger"
        self.research = self.data / "research"
        self.state = self.root / "score-timer"
        self.lane = self.root / "lane"
        self.run_sh = self.lane / "code" / "deploy" / "research-lane" / "round-runner" / "run.sh"
        self.run_sh.parent.mkdir(parents=True)
        self.run_sh.write_text("#!/bin/sh\n", encoding="utf-8")
        self.now = now or datetime(2027, 1, 5, 20, 0, tzinfo=CST)
        self.round_id = f"ROUND-{segment}"
        self.selected = ["C1"] if selected is None else selected
        holdout = {"from": "2027-01-04", "to": "2027-03-18", "segment": "R2"} if segment == "R2" else {"from": "2026-10-19", "to": "2026-12-31"}
        self.round = record({"schema": "MINING_ROUND_V1", "round_id": self.round_id, "market": "CN_A", "status": "CAP_REACHED", "holdout": holdout, "opened_at": "2026-12-01T20:50:00+08:00"})
        self.selection = record({"schema": "MINING_SELECTION_V1", "round_id": self.round_id, "market": "CN_A", "selection_sha256": "a" * 64,
                                 "selected": self.selected, "evaluated": len(self.selected), "recorded_at": "2026-12-02T00:00:00+08:00"})
        items = [{"candidate_id": cid, "registration_hash": hashlib.sha256(cid.encode()).hexdigest()} for cid in sorted(self.selected)]
        mechanism_body = {"schema": "MINING_MECHANISM_V1", "round_id": self.round_id, "candidate_id": "C1", "mechanism_id": "M1"}
        mechanism = record(mechanism_body)
        if items:
            items[0]["registration_hash"] = mechanism["record_hash"]
        set_sha = hashlib.sha256(canonical({"round_id": self.round_id, "selection_record_hash": self.selection["record_hash"], "items": items}).encode()).hexdigest()
        self.review = record({"schema": "MECHANISM_REVIEW_V1", "round_id": self.round_id, "selection_record_hash": self.selection["record_hash"],
                              "mechanism_set_sha256": set_sha, "items": items,
                              "verdicts": [{"candidate_id": cid, "verdict": "APPROVED"} for cid in self.selected],
                              "reviewed_at": "2026-12-03T00:00:00+08:00", "recorded_at": "2026-12-03T00:00:00+08:00"})
        append(self.research / "mining_rounds.jsonl", self.round)
        append(self.research / "mining_selections.jsonl", self.selection)
        if self.selected:
            append(self.research / "mining_mechanisms.jsonl", mechanism)
        append(self.research / "mining_mechanism_reviews.jsonl", self.review)
        if segment == "R2":
            append(self.research / "holdout_segment_resolutions.jsonl", record({"schema": "HOLDOUT_SEGMENT_RESOLUTION_V1", "segment": "R2", "market": "CN_A", "window": {"from": "2027-01-04", "to": "2027-03-18"}}))
        for seg, name in (("R1", "rf1116-cn-a-daily-holdout-from-20261019"), ("R2", "rf1116-cn-a-daily-holdout-r2")):
            (self.lane / "holdout-sealed" / name).mkdir(parents=True, exist_ok=True)
            (self.lane / "holdout-daydrop" / seg).mkdir(parents=True, exist_ok=True)

    def config(self, **kwargs):
        base = dict(data_dir=self.data, var_root=self.var_root, state_dir=self.state, lane_dir=self.lane, run_sh=self.run_sh,
                    image="qrp-round-runner:397538ca54b0", blackouts_path=None, disk_floor_gib=0)
        base.update(kwargs)
        return timer.Config(**base)

    def close_round(self, status="CLOSED"):
        append(self.research / "mining_rounds.jsonl", record({**{k: v for k, v in self.round.items() if k != "record_hash"}, "status": status, "closed_at": self.now.isoformat()}))

    def open_round(self, gates=0):
        append(self.research / "holdout_vault.jsonl", record({"schema": "HOLDOUT_OPEN_V1", "round_id": self.round_id, "candidate_ids": self.selected, "opened_at": self.now.isoformat()}))
        append(self.research / "mining_rounds.jsonl", record({**{k: v for k, v in self.round.items() if k != "record_hash"}, "status": "SCORING"}))
        for n in range(gates):
            append(self.research / "mining_gate_records.jsonl", record({"schema": "MINING_GATE_RECORD_V1", "round_id": self.round_id, "candidate_id": f"C{n + 1}"}))


class ScoreTimerTests(unittest.TestCase):
    def test_jsonl_valid_last_line_without_newline_and_mid_file_corruption(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.jsonl"
            append(p, {"x": 1})
            append(p, {"x": 2}, newline=False)
            self.assertEqual(timer.read_jsonl(p), [{"x": 1}, {"x": 2}])
            p.write_bytes(b'{"x":1}\nnot-json\n{"x":2}')
            with self.assertRaisesRegex(timer.LedgerError, "CORRUPT_LINE:2"):
                timer.read_jsonl(p)

    def test_failure_matrix_preserves_waiting_and_stopped_families(self):
        waiting = [
            (75, "", "BUSY"),
            (2, '{"error":"MINE_RUNNER_HOLDOUT_BEFORE_SEAL_END"}', "MINE_RUNNER_HOLDOUT_BEFORE_SEAL_END"),
            (2, '{"error":"MINE_RUNNER_HOLDOUT_INCOMPLETE","message":"MINE_RUNNER_HOLDOUT_INCOMPLETE:arrival:2027-01-04"}', "MINE_RUNNER_HOLDOUT_INCOMPLETE"),
            (2, '{"error":"MINE_RUNNER_SEGMENT_END_UNKNOWN"}', "MINE_RUNNER_SEGMENT_END_UNKNOWN"),
            (2, '{"error":"MINE_RUNNER_ROUND_NOT_READY"}', "MINE_RUNNER_ROUND_NOT_READY"),
            (75, '{"error":"MINE_RUNNER_HOLDOUT_ARRIVAL_UNANCHORED"}', "MINE_RUNNER_HOLDOUT_ARRIVAL_UNANCHORED"),
            (2, '{"error":"MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID","message":"MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:UNANCHORED:head"}', "MINE_RUNNER_HOLDOUT_ARRIVAL_UNANCHORED"),
            (75, '{"error":"MINE_RUNNER_PRIOR_SEGMENT_NOT_OPENED"}', "MINE_RUNNER_PRIOR_SEGMENT_NOT_OPENED"),
            (75, '{"error":"MINE_RUNNER_ARRIVE_LOCKED"}', "MINE_RUNNER_ARRIVE_LOCKED"),
        ]
        for rc, err, code in waiting:
            with self.subTest(code=code):
                self.assertEqual(timer.classify_failure(rc, err), ("WAITING", code))
        stopped = ["MINE_RUNNER_MECHANISM_REVIEW_MISSING", "MINE_RUNNER_SELECTION_FILE_MISMATCH", "MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID",
                   "MINE_RUNNER_HOLDOUT_FIELD_INCOMPLETE", "MINE_RUNNER_HOLDOUT_FIELD_EMPTY", "MINE_RUNNER_HOLDOUT_FIELD_VALUES_INVALID",
                   "MINE_RUNNER_HOLDOUT_SEAL_INVALID", "MINE_RUNNER_HOLDOUT_FILE_SHA_MISMATCH"]
        for code in stopped:
            with self.subTest(code=code):
                self.assertEqual(timer.classify_failure(2, canonical({"error": code})), ("STOPPED", code))

    def test_arrive_reads_only_first_json_line_then_checks_and_scores(self):
        w = World()
        (w.lane / "holdout-daydrop" / "R1" / "20270104").mkdir()
        order = []
        def handle(argv, env):
            cmd = argv[1]
            order.append(cmd)
            if cmd == "arrive":
                return timer.CommandResult(0, canonical({"status": "COMPLETE", "arrived": ["2027-01-04"], "chain_seq": 3}) + "\n" + canonical({"status": "ANCHORED"}) + "\n", "")
            if cmd == "arrive-check":
                return timer.CommandResult(0, canonical({"status": "COMPLETE", "missing": []}), "")
            if cmd == "score":
                w.close_round()
                return timer.CommandResult(0, canonical({"status": "CLOSED"}), "")
            raise AssertionError(argv)
        result = timer.Supervisor(w.config(), FakeRunner(handle), now=lambda: w.now).tick()
        self.assertEqual(order, ["arrive", "arrive-check", "score"])
        self.assertEqual(result["rounds"][w.round_id], "DONE")
        rows = timer.read_jsonl(w.state / "ledger.jsonl")
        arrived = next(x for x in rows if x["state"] == "ARRIVAL_STATUS")
        self.assertEqual(arrived["detail"]["chain_seq"], 3)
        self.assertNotIn("ANCHORED", canonical(arrived))

    def test_clock_r2_order_and_review_wait_alert(self):
        early = World(now=datetime(2026, 12, 31, 23, 59, tzinfo=CST))
        runner = FakeRunner(lambda *_: (_ for _ in ()).throw(AssertionError("must not run")))
        got = timer.Supervisor(early.config(), runner, now=lambda: early.now).tick()
        self.assertEqual(got["rounds"][early.round_id], "WAITING_CLOCK")
        self.assertEqual(runner.calls, [])

        r2 = World(segment="R2", now=datetime(2027, 3, 19, 1, 0, tzinfo=CST))
        no_prior = timer.Supervisor(r2.config(), runner, now=lambda: r2.now).tick()
        self.assertEqual(no_prior["rounds"][r2.round_id], "WAITING_PRIOR_SEGMENT")
        append(r2.research / "mining_rounds.jsonl", record({"schema": "MINING_ROUND_V1", "round_id": "OLD-R1", "market": "CN_A", "status": "CAP_REACHED", "holdout": {"from": "2026-10-19", "to": "2026-12-31"}}))
        got = timer.Supervisor(r2.config(), runner, now=lambda: r2.now).tick()
        self.assertEqual(got["rounds"][r2.round_id], "WAITING_PRIOR_SEGMENT")

        review = World(now=datetime(2027, 1, 5, 20, 0, tzinfo=CST))
        (review.research / "mining_mechanism_reviews.jsonl").unlink()
        got = timer.Supervisor(review.config(), runner, now=lambda: review.now).tick()
        self.assertEqual(got["rounds"][review.round_id], "WAITING_REVIEW")
        alerts = json.loads((review.state / "alert_status.json").read_text())
        self.assertEqual([x["code"] for x in alerts["active"]], ["WAITING_REVIEW_48H"])

    def test_incomplete_after_end_alerts_once(self):
        w = World()
        runner = FakeRunner(lambda argv, env: timer.CommandResult(4, canonical({"status": "INCOMPLETE", "missing": ["2026-12-31"]}), "") if argv[1] == "arrive-check" else (_ for _ in ()).throw(AssertionError(argv)))
        sup = timer.Supervisor(w.config(), runner, now=lambda: w.now)
        self.assertEqual(sup.tick()["rounds"][w.round_id], "WAITING_ARRIVAL")
        self.assertEqual(sup.tick()["rounds"][w.round_id], "WAITING_ARRIVAL")
        alerts = json.loads((w.state / "alert_status.json").read_text())["active"]
        self.assertEqual([a["code"] for a in alerts], ["ARRIVAL_INCOMPLETE_AT_END"])
        self.assertEqual(alerts[0]["detail"]["missing"], ["2026-12-31"])

        unknown = World(segment="R2", now=datetime(2027, 3, 19, 1, 0, tzinfo=CST))
        append(unknown.research / "mining_rounds.jsonl", record({"schema": "MINING_ROUND_V1", "round_id": "DONE-R1", "market": "CN_A", "status": "CLOSED", "holdout": {"from": "2026-10-19", "to": "2026-12-31"}}))
        check = FakeRunner(lambda argv, env: timer.CommandResult(0, canonical({"status": "WINDOW_END_UNKNOWN", "missing": []}), ""))
        self.assertEqual(timer.Supervisor(unknown.config(), check, now=lambda: unknown.now).tick()["rounds"][unknown.round_id], "WAITING_SEGMENT_END")
        self.assertEqual([c[0][1] for c in check.calls], ["arrive-check"])

    def test_restart_guard_never_starts_second_score_and_long_run_alerts(self):
        w = World()
        timer.Supervisor(w.config(), FakeRunner(lambda *_: None), now=lambda: w.now)._transition(w.round_id, "RUNNING_SCORE", {"started_at": (w.now - timedelta(hours=13)).isoformat()})
        runner = FakeRunner(lambda *_: (_ for _ in ()).throw(AssertionError("must not start a second score")))
        got = timer.Supervisor(w.config(), runner, now=lambda: w.now).tick()
        self.assertEqual(got["rounds"][w.round_id], "WAITING_RUNNING")
        self.assertEqual(json.loads((w.state / "alert_status.json").read_text())["active"][0]["code"], "SCORE_LONG_RUNNING")
        timer.Supervisor(w.config(), runner, now=lambda: w.now).tick()
        self.assertEqual(len(json.loads((w.state / "alert_status.json").read_text())["active"]), 1)

        arrive = World()
        (arrive.lane / "holdout-daydrop" / "R1" / "20270104").mkdir()
        marker = timer.Supervisor(arrive.config(), FakeRunner(lambda *_: None), now=lambda: arrive.now)
        marker._transition("SEGMENT:R1", "RUNNING_ARRIVE", {"started_at": arrive.now.isoformat()})
        no_second_writer = FakeRunner(lambda *_: (_ for _ in ()).throw(AssertionError("must not overlap arrival")))
        got = timer.Supervisor(arrive.config(), no_second_writer, now=lambda: arrive.now).tick()
        self.assertEqual(got["rounds"][arrive.round_id], "WAITING_RUNNING")
        self.assertEqual(no_second_writer.calls, [])

    def test_crash_after_open_rescores_exactly_once_and_chmod_precedes_both(self):
        w = World()
        events = []
        def chmod(path):
            events.append(("chmod", Path(path).name))
        def handle(argv, env):
            cmd = argv[1]
            events.append(("run", cmd))
            if cmd == "arrive-check":
                return timer.CommandResult(0, canonical({"status": "COMPLETE", "missing": []}), "")
            if cmd == "score":
                w.open_round()
                return timer.CommandResult(137, "", "oom")
            if cmd == "rescore":
                w.close_round("FAILED_RESCORE")
                return timer.CommandResult(2, "", canonical({"error": "MINE_RUNNER_RESCORE_FAILED"}))
            raise AssertionError(argv)
        runner = FakeRunner(handle)
        sup = timer.Supervisor(w.config(), runner, chmod=chmod, now=lambda: w.now)
        self.assertEqual(sup.tick()["rounds"][w.round_id], "STOPPED")
        self.assertEqual([x for x in events if x[0] == "run"], [("run", "arrive-check"), ("run", "score"), ("run", "rescore")])
        chmod_positions = [n for n, value in enumerate(events) if value == ("chmod", "rf1116-cn-a-daily-holdout-from-20261019")]
        self.assertEqual(len(chmod_positions), 2)
        self.assertLess(chmod_positions[0], events.index(("run", "score")))
        self.assertLess(chmod_positions[1], events.index(("run", "rescore")))
        sup.tick()
        self.assertEqual(sum(1 for c, _ in runner.calls if c[1] == "rescore"), 1)

    def test_deterministic_refusal_is_not_retried_across_ten_ticks(self):
        w = World()
        def handle(argv, env):
            if argv[1] == "arrive-check":
                return timer.CommandResult(0, canonical({"status": "COMPLETE", "missing": []}), "")
            return timer.CommandResult(2, "", canonical({"error": "MINE_RUNNER_SELECTION_FILE_MISMATCH"}))
        runner = FakeRunner(handle)
        sup = timer.Supervisor(w.config(), runner, now=lambda: w.now)
        before = {p.relative_to(w.data): p.read_bytes() for p in w.data.rglob("*") if p.is_file()}
        for _ in range(10):
            sup.tick()
        self.assertEqual(sum(1 for c, _ in runner.calls if c[1] == "score"), 1)
        self.assertEqual([a["code"] for a in json.loads((w.state / "alert_status.json").read_text())["active"]], ["MINE_RUNNER_SELECTION_FILE_MISMATCH"])
        self.assertEqual(before, {p.relative_to(w.data): p.read_bytes() for p in w.data.rglob("*") if p.is_file()})

    def test_docker_start_retries_three_times_then_stops(self):
        w = World()
        clock = [w.now]
        def handle(argv, env):
            if argv[1] == "arrive-check":
                return timer.CommandResult(0, canonical({"status": "COMPLETE", "missing": []}), "")
            return timer.CommandResult(125, "", "cannot start")
        runner = FakeRunner(handle)
        sup = timer.Supervisor(w.config(), runner, now=lambda: clock[0])
        states = []
        for _ in range(4):
            states.append(sup.tick()["rounds"][w.round_id])
            clock[0] += timedelta(hours=4)
        self.assertEqual(states, ["WAITING_DOCKER", "WAITING_DOCKER", "STOPPED_DOCKER", "STOPPED_DOCKER"])
        self.assertEqual(sum(1 for c, _ in runner.calls if c[1] == "score"), 3)

    def test_blackout_and_disk_floor_wait_without_commands(self):
        w = World()
        blackout = w.root / "blackouts.json"
        blackout.write_text(canonical({"entries": [{"id": "X", "start": (w.now - timedelta(hours=1)).isoformat(), "end": (w.now + timedelta(hours=1)).isoformat(), "hosts": ["LINUX"], "mode": "FREEZE"}]}))
        runner = FakeRunner(lambda *_: (_ for _ in ()).throw(AssertionError("must wait")))
        got = timer.Supervisor(w.config(blackouts_path=blackout), runner, now=lambda: w.now).tick()
        self.assertEqual(got["rounds"][w.round_id], "WAITING_BLACKOUT")
        got = timer.Supervisor(w.config(disk_floor_gib=10**9), runner, now=lambda: w.now).tick()
        self.assertEqual(got["rounds"][w.round_id], "WAITING_DISK")

    def test_state_hash_chain_tamper_stops_and_emits_alert_status(self):
        w = World()
        sup = timer.Supervisor(w.config(), FakeRunner(lambda *_: None), now=lambda: w.now)
        sup._transition(w.round_id, "WAITING_CLOCK", {})
        data = (w.state / "ledger.jsonl").read_text().replace("WAITING_CLOCK", "DONE")
        (w.state / "ledger.jsonl").write_text(data)
        with self.assertRaisesRegex(timer.LedgerError, "HASH_MISMATCH"):
            timer.Supervisor(w.config(), FakeRunner(lambda *_: None), now=lambda: w.now).tick()
        self.assertEqual(json.loads((w.state / "alert_status.json").read_text())["active"][0]["code"], "LEDGER_TAMPER")

    def test_qrp_var_single_authority_and_refusals(self):
        w = World()
        backup = w.root / "mac-var"
        backup.mkdir()
        timer.validate_qrp_var(w.config(data_candidates=(w.var_root, backup), writable_probe=lambda p: p == w.var_root))
        with self.assertRaisesRegex(timer.ConfigError, "QRP_VAR_DUAL_WRITABLE"):
            timer.validate_qrp_var(w.config(data_candidates=(w.var_root, backup), writable_probe=lambda p: True))
        a = w.root / "linux.manifest"; b = w.root / "mac.manifest"
        a.write_text("a\n"); b.write_text("b\n")
        with self.assertRaisesRegex(timer.ConfigError, "QRP_VAR_MANIFEST_MISMATCH"):
            timer.validate_qrp_var(w.config(data_candidates=(w.var_root, backup), manifest_files=(a, b), writable_probe=lambda p: p == w.var_root))
        b.unlink()
        with self.assertRaisesRegex(timer.ConfigError, "QRP_VAR_MANIFEST_MISMATCH"):
            timer.validate_qrp_var(w.config(data_candidates=(w.var_root, backup), manifest_files=(a, b), writable_probe=lambda p: p == w.var_root))

    def test_production_config_binds_ledger_below_authoritative_var_root(self):
        w = World()
        (w.lane / "code" / ".QRP_COMMIT").write_text("397538ca54b00cc58663d52f6c9c81f033c7acc3\n")
        original = os.environ.copy()
        try:
            os.environ.clear()
            os.environ["RF1116_LANE"] = str(w.lane)
            config = timer.config_from_env()
        finally:
            os.environ.clear()
            os.environ.update(original)
        self.assertEqual(config.var_root, Path("/srv/research-lane/qrp/var"))
        self.assertEqual(config.data_dir, Path("/srv/research-lane/qrp/var/ledger"))
        self.assertEqual(config.data_candidates, (Path("/srv/research-lane/qrp/var"),))

    def test_unit_files_are_bounded_user_timer(self):
        deploy = ROOT / "deploy" / "research-lane" / "score-timer"
        service = (deploy / "rf1116-score-timer.service").read_text()
        unit_timer = (deploy / "rf1116-score-timer.timer").read_text()
        self.assertIn("ExecStart=/usr/bin/python3", service)
        self.assertRegex(service, r"(?m)^ExecStart=/usr/bin/python3 .*/score_timer\.py tick$")
        self.assertNotIn("User=", service)
        self.assertIn("OnCalendar=*:0/30", unit_timer)
        self.assertIn("Persistent=true", unit_timer)


if __name__ == "__main__":
    unittest.main()
