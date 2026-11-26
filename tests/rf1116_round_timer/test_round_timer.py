import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "services" / "rf1116-round-timer" / "round_timer.py"
SPEC = importlib.util.spec_from_file_location("rf1116_round_timer", MODULE)
timer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(timer)
CST = timezone(timedelta(hours=8))


class FakeRunner:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    def __call__(self, argv, env):
        self.calls.append((list(argv), dict(env)))
        return self.results.pop(0)


class World:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="q148-"))
        self.var_root = self.root / "var"
        self.data = self.var_root / "ledger"
        self.research = self.data / "research"
        self.state = self.root / "state"
        self.lane = self.root / "lane"
        self.segment = self.lane / "holdout-sealed" / "r2"
        self.segment.mkdir(parents=True)
        self.research.mkdir(parents=True)
        self.run_sh = self.lane / "code" / "deploy" / "research-lane" / "round-runner" / "run.sh"
        self.run_sh.parent.mkdir(parents=True)
        self.run_sh.write_text("#!/bin/sh\n", encoding="utf-8")
        self.sums = self.segment / "SHA256SUMS"
        self.sums.write_text("a" * 64 + "  data.csv\n", encoding="utf-8")
        self.freeze = self.root / "RF1116_HOLDOUT_CN_A_R2_FREEZE_1.md"
        self.freeze.write_text("frozen\n", encoding="utf-8")
        self.freeze_sha = hashlib.sha256(self.freeze.read_bytes()).hexdigest()
        self.model_sources = {
            "https://updates": b"deepseek-v4-pro -> DeepSeek-V4-Pro-0813\ndeepseek-flash -> DeepSeek-V4.1-Flash-1017\n",
            "https://pricing": b"deepseek-v4-pro: DeepSeek-V4-Pro-0813\ndeepseek-flash: DeepSeek-V4.1-Flash-1017\n",
        }
        self.now = datetime(2026, 12, 1, 20, 50, tzinfo=CST)

    def config(self, **kwargs):
        values = dict(
            var_root=self.var_root,
            data_dir=self.data,
            state_dir=self.state,
            lane_dir=self.lane,
            holdout_dir=self.segment,
            holdout_sums=self.sums,
            r2_freeze=self.freeze,
            r2_freeze_sha256=self.freeze_sha,
            run_sh=self.run_sh,
            image="qrp-round-runner:0123456789ab",
            blackouts_path=None,
            disk_floor_gib=0,
            model_sources=self.model_sources,
            data_candidates=(self.var_root,),
            manifest_files=(),
            key_file=self.root / "deepseek-research.env",
        )
        values.update(kwargs)
        return timer.Config(**values)

    def docker_stub_runner(self, outcome):
        fake_bin = self.root / "fake-bin"
        fake_bin.mkdir()
        docker = fake_bin / "docker"
        docker.write_text(
            """#!/usr/bin/env python3
import json
import os
import sys

args = sys.argv[1:]
with open(os.environ["Q148_DOCKER_LOG"], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(args) + "\\n")
if args and args[0] in {"ps", "stop"}:
    raise SystemExit(0)
if "llm-init" in args:
    print(json.dumps({"command": "llm-init", "exchange": "/out/llm-exchange", "withdrawn": 0}))
    raise SystemExit(0)
if "-d" in args:
    print("0123456789abcdef" * 4)
    raise SystemExit(0)
if "generate" in args and "--generator" in args:
    outcome = os.environ["Q148_FAKE_LLM_OUTCOME"]
    print(json.dumps({
        "round_id": None if outcome == "WAITING_KEY_ABSENT" else "R1",
        "status": "WAITING",
        "llm_state": outcome,
        "ping": {"outcome": outcome, "raw_error": "FILE_ABSENT" if outcome == "WAITING_KEY_ABSENT" else None},
    }))
    raise SystemExit(75)
raise SystemExit(0)
""",
            encoding="utf-8",
        )
        docker.chmod(0o755)
        captured = []

        def run(argv, env):
            process = subprocess.run(
                argv,
                env={
                    **os.environ,
                    **env,
                    "PATH": f"{fake_bin}{os.pathsep}{Path(sys.executable).parent}{os.pathsep}{os.environ['PATH']}",
                    "Q148_FAKE_LLM_OUTCOME": outcome,
                    "Q148_DOCKER_LOG": str(self.root / "docker-argv.jsonl"),
                    "RF1116_LANE_FOR_TESTS": str(self.lane),
                },
                text=True,
                capture_output=True,
                check=False,
            )
            result = timer.CommandResult(process.returncode, process.stdout, process.stderr)
            captured.append(result)
            return result

        return run, captured


class RoundTimerTests(unittest.TestCase):
    def test_waiting_and_exit_matrix(self):
        retry = {"WAITING_RATE_LIMITED", "WAITING_PROVIDER_UNAVAILABLE", "WAITING_STEP_NO_RESPONSE"}
        no_retry = {"WAITING_QUOTA", "WAITING_MODEL_MISMATCH", "WAITING_KEY_ABSENT", "WAITING_KEY_REJECTED", "WAITING_METER_UNKNOWN"}
        for outcome in retry:
            self.assertEqual(timer.classify(75, outcome).action, "RETRY")
        for outcome in no_retry:
            self.assertEqual(timer.classify(75, outcome).action, "ALERT_NO_RESUME")
        self.assertEqual(timer.classify(75, "WAITING_STEP_CRASHED_MID_CALL").action, "SETTLE_ONCE")
        for outcome in ("STOPPED_TOKEN_CAP", "STOPPED_CALL_CAP", "STOPPED_EMPTY_REPLIES"):
            self.assertEqual(timer.classify(3, outcome).action, "ALERT_NO_RESUME")
        self.assertEqual(timer.classify(0, None).action, "DONE")
        self.assertEqual(timer.classify(73, None).action, "WAIT_BUSY")
        self.assertEqual(timer.classify(74, None).action, "WAIT_BUSY")
        self.assertEqual(timer.classify(64, None).action, "ALERT_NO_RESUME")
        self.assertEqual(timer.classify(2, None, "MINE_ROUND_MONTHLY_CAP").action, "ALERT_NO_RESUME")

    def test_model_gate_both_models_equal_and_atomic_state_format(self):
        w = World()
        gate = timer.ModelGate(w.config(), fetch=lambda url: w.model_sources[url], now=lambda: w.now)
        result = gate.check(write_state=True)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["models"], ["deepseek-flash", "deepseek-v4-pro"])
        self.assertRegex(result["at"], r"\+08:00$")
        self.assertRegex(result["expected_sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(result["observed_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(json.loads((w.state / "model_gate_last.json").read_text()), result)
        gate.check(write_state=True)
        self.assertTrue((w.state / "model_gate_last.json.prev").exists())

    def test_model_gate_fails_closed_for_either_alias_and_fetch(self):
        w = World()
        for needle in (b"DeepSeek-V4-Pro-0813", b"DeepSeek-V4.1-Flash-1017"):
            bad = dict(w.model_sources)
            bad["https://pricing"] = bad["https://pricing"].replace(needle, b"CHANGED")
            self.assertEqual(timer.ModelGate(w.config(model_sources=bad), fetch=lambda url, values=bad: values[url]).check()["status"], "FAIL")
        def failed(_url):
            raise OSError("offline")
        self.assertEqual(timer.ModelGate(w.config(), fetch=failed).check()["status"], "FETCH_FAILED")

    def test_model_gate_requires_exact_unambiguous_alias_mappings_in_every_source(self):
        w = World()
        expected = w.config().expected_models
        canonical = {
            "https://updates": b"deepseek-v4-pro -> DeepSeek-V4-Pro-0813\ndeepseek-flash -> DeepSeek-V4.1-Flash-1017\n",
            "https://pricing": b"deepseek-v4-pro: DeepSeek-V4-Pro-0813\ndeepseek-flash: DeepSeek-V4.1-Flash-1017\n",
        }
        cases = {
            "swapped": {
                **canonical,
                "https://pricing": b"deepseek-v4-pro: DeepSeek-V4.1-Flash-1017\ndeepseek-flash: DeepSeek-V4-Pro-0813\n",
            },
            "all_strings_wrong_relationship": {
                **canonical,
                "https://updates": b"deepseek-v4-pro deepseek-flash DeepSeek-V4.1-Flash-1017 DeepSeek-V4-Pro-0813\n",
            },
            "duplicate_conflict": {
                **canonical,
                "https://updates": canonical["https://updates"] + b"deepseek-v4-pro -> DeepSeek-V4.1-Flash-1017\n",
            },
        }
        for name, sources in cases.items():
            with self.subTest(name=name):
                result = timer.ModelGate(w.config(model_sources=sources), fetch=lambda url, values=sources: values[url]).check()
                self.assertEqual(result["status"], "FAIL")
        missing = {"https://updates": canonical["https://updates"]}
        result = timer.ModelGate(w.config(model_sources=canonical), fetch=lambda url: missing[url]).check()
        self.assertEqual(result["status"], "FETCH_FAILED")
        result = timer.ModelGate(w.config(model_sources=canonical), fetch=lambda url: canonical[url]).check()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["expected_sha256"], hashlib.sha256(timer.canonical(expected).encode()).hexdigest())
        presented = {
            url: b"<html><body><section>" + body.replace(b"\n", b"</section><section>") + b"</section></body></html>"
            for url, body in canonical.items()
        }
        restyled = timer.ModelGate(w.config(model_sources=presented), fetch=lambda url: presented[url]).check()
        self.assertEqual(restyled["status"], "PASS")
        self.assertEqual(restyled["observed_sha256"], result["observed_sha256"])

    def test_var_authority_refusals_and_single_authority(self):
        w = World()
        backup = w.root / "mac-var"
        backup.mkdir()
        with self.assertRaisesRegex(timer.ConfigError, "QRP_VAR_DUAL_WRITABLE"):
            timer.validate_qrp_var(w.config(data_candidates=(w.var_root, backup), writable_probe=lambda _p: True))
        m1, m2 = w.root / "linux.manifest", w.root / "mac.manifest"
        m1.write_text("a\n"); m2.write_text("b\n")
        with self.assertRaisesRegex(timer.ConfigError, "QRP_VAR_MANIFEST_MISMATCH"):
            timer.validate_qrp_var(w.config(manifest_files=(m1, m2)))
        self.assertEqual(timer.validate_qrp_var(w.config()).resolve(), w.data.resolve())

    def test_var_authority_requires_linux_to_be_the_only_writable_candidate(self):
        w = World()
        backup = w.root / "mac-var"
        backup.mkdir()
        with self.assertRaisesRegex(timer.ConfigError, "QRP_VAR_AUTHORITY_NOT_WRITABLE"):
            timer.validate_qrp_var(w.config(data_candidates=(w.var_root, backup), writable_probe=lambda _p: False))
        with self.assertRaisesRegex(timer.ConfigError, "QRP_VAR_AUTHORITY_NOT_WRITABLE"):
            timer.validate_qrp_var(w.config(data_candidates=(w.var_root, backup), writable_probe=lambda p: p == backup))
        missing = w.root / "missing-linux-var"
        with self.assertRaisesRegex(timer.ConfigError, "QRP_VAR_AUTHORITY_NOT_WRITABLE"):
            timer.validate_qrp_var(w.config(
                var_root=missing, data_dir=missing / "ledger",
                data_candidates=(missing, backup), writable_probe=lambda p: p == backup,
            ))
        m1, m2 = w.root / "linux.manifest", w.root / "mac.manifest"
        m1.write_text("same\n"); m2.write_text("same\n")
        config = w.config(
            data_candidates=(w.var_root, backup), manifest_files=(m1, m2),
            writable_probe=lambda p: p == w.var_root,
        )
        self.assertEqual(timer.validate_qrp_var(config), w.data.resolve())

    def test_once_per_slot_is_idempotent_and_advances_only_after_terminal(self):
        w = World()
        runner = FakeRunner(timer.CommandResult(0, '{"round_id":"R1","status":"CAP_REACHED"}\n'))
        supervisor = timer.Supervisor(w.config(), runner=runner, fetch=lambda url: w.model_sources[url], now=lambda: w.now, disk_free=lambda _p: 999)
        self.assertEqual(supervisor.tick("2026-12:1")["state"], "DONE")
        self.assertEqual(supervisor.tick("2026-12:1")["state"], "DONE")
        self.assertEqual(len(runner.calls), 1)
        self.assertEqual(runner.calls[0][1]["RF1116_HOLDOUT_SEGMENT"], "R2")
        self.assertEqual(runner.calls[0][1]["QRP_DATA_DIR"], str(w.data))

    def test_monthly_tick_serializes_two_slots_and_catches_up_after_first_day(self):
        w = World(); w.now = datetime(2026, 12, 2, 5, 0, tzinfo=CST)
        runner = FakeRunner(timer.CommandResult(0, '{"round_id":"R1"}'), timer.CommandResult(0, '{"round_id":"R2"}'))
        supervisor = timer.Supervisor(w.config(), runner=runner, fetch=lambda url: w.model_sources[url], now=lambda: w.now, disk_free=lambda _p: 999)
        self.assertEqual(supervisor.tick_auto()["state"], "DONE")
        self.assertEqual(len(runner.calls), 2)
        self.assertEqual(supervisor.tick_auto()["state"], "DONE")
        self.assertEqual(len(runner.calls), 2)

    def test_retry_is_bounded_three_per_round_day(self):
        w = World()
        waiting = timer.CommandResult(75, '{"round_id":"R1","status":"WAITING","llm_state":"WAITING_RATE_LIMITED"}\n')
        runner = FakeRunner(waiting, waiting, waiting, waiting)
        supervisor = timer.Supervisor(w.config(), runner=runner, fetch=lambda url: w.model_sources[url], now=lambda: w.now, disk_free=lambda _p: 999)
        self.assertEqual(supervisor.tick("2026-12:1")["state"], "WAITING_RETRY")
        self.assertEqual(supervisor.tick("2026-12:1")["state"], "WAITING_RETRY")
        self.assertEqual(len(runner.calls), 1)
        w.now += timedelta(hours=1)
        for _ in range(2):
            self.assertEqual(supervisor.tick("2026-12:1")["state"], "WAITING_RETRY")
            w.now += timedelta(hours=1)
        self.assertEqual(supervisor.tick("2026-12:1")["state"], "WAITING_RETRY_LIMIT")
        self.assertEqual(len(runner.calls), 3)
        self.assertEqual(runner.calls[1][0][-2:], ["resume-llm", "R1"])

    def test_open_round_identity_survives_a_precondition_wait(self):
        w = World()
        waiting = timer.CommandResult(75, '{"round_id":"R1","status":"WAITING","llm_state":"WAITING_RATE_LIMITED"}\n')
        runner = FakeRunner(waiting, timer.CommandResult(0, '{"round_id":"R1","status":"CAP_REACHED"}\n'))
        free = {"gib": 999}
        supervisor = timer.Supervisor(
            w.config(disk_floor_gib=150), runner=runner,
            fetch=lambda url: w.model_sources[url], now=lambda: w.now,
            disk_free=lambda _p: free["gib"],
        )
        first = supervisor.tick("2026-12:1")
        self.assertEqual(first["state"], "WAITING_RETRY")
        self.assertEqual(first["detail"]["round_id"], "R1")

        w.now += timedelta(hours=1)
        free["gib"] = 149
        blocked = supervisor.tick("2026-12:1")
        self.assertEqual(blocked["state"], "WAITING_DISK_FLOOR")
        self.assertEqual(blocked["detail"]["round_id"], "R1")

        free["gib"] = 999
        self.assertEqual(supervisor.tick("2026-12:1")["state"], "DONE")
        self.assertEqual(runner.calls[1][0][-2:], ["resume-llm", "R1"])

    def test_real_run_sh_prefixes_do_not_hide_rc75_round_identity(self):
        w = World()
        runner, captured = w.docker_stub_runner("WAITING_RATE_LIMITED")
        real_run_sh = ROOT / "deploy" / "research-lane" / "round-runner" / "run.sh"
        supervisor = timer.Supervisor(
            w.config(run_sh=real_run_sh), runner=runner,
            fetch=lambda url: w.model_sources[url], now=lambda: w.now,
            disk_free=lambda _p: 999,
        )

        waiting = supervisor.tick("2026-12:1")

        self.assertEqual(captured[0].rc, 75)
        lines = captured[0].stdout.splitlines()
        self.assertEqual(json.loads(lines[0])["command"], "llm-init")
        self.assertRegex(lines[1], r"^[0-9a-f]{64}$")
        self.assertEqual(json.loads(lines[2])["llm_state"], "WAITING_RATE_LIMITED")
        self.assertEqual(waiting["state"], "WAITING_RETRY")
        self.assertEqual(waiting["detail"]["code"], "WAITING_RATE_LIMITED")
        self.assertEqual(waiting["detail"]["round_id"], "R1")

    def test_starting_with_round_id_recovers_by_resuming_same_round(self):
        w = World()
        runner = FakeRunner(timer.CommandResult(0, '{"round_id":"R1","status":"CAP_REACHED"}\n'))
        supervisor = timer.Supervisor(
            w.config(), runner=runner, fetch=lambda url: w.model_sources[url],
            now=lambda: w.now, disk_free=lambda _p: 999,
        )
        supervisor._transition("2026-12:1", "STARTING", {"resume": True, "round_id": "R1"})

        recovered = supervisor.tick("2026-12:1")

        self.assertEqual(recovered["state"], "DONE")
        self.assertEqual(recovered["detail"]["round_id"], "R1")
        self.assertEqual(runner.calls[0][0][-2:], ["resume-llm", "R1"])

    def test_key_file_absent_from_real_run_sh_is_alerted_without_retry(self):
        w = World()
        runner, captured = w.docker_stub_runner("WAITING_KEY_ABSENT")
        real_run_sh = ROOT / "deploy" / "research-lane" / "round-runner" / "run.sh"
        supervisor = timer.Supervisor(
            w.config(run_sh=real_run_sh), runner=runner,
            fetch=lambda url: w.model_sources[url], now=lambda: w.now,
            disk_free=lambda _p: 999,
        )

        stopped = supervisor.tick("2026-12:1")

        self.assertEqual(captured[0].rc, 75)
        self.assertIn('"raw_error": "FILE_ABSENT"', captured[0].stdout)
        self.assertEqual(stopped["state"], "STOPPED_WAITING_KEY_ABSENT")
        self.assertEqual(stopped["detail"]["round_id"], None)
        self.assertEqual(json.loads((w.state / "alert_status.json").read_text())["active"][0]["code"], "WAITING_KEY_ABSENT")
        self.assertEqual(supervisor.tick("2026-12:1"), stopped)
        self.assertEqual(len(captured), 1)

    def test_uncertain_initial_start_is_stopped_instead_of_reopened(self):
        w = World()
        runner = FakeRunner()
        supervisor = timer.Supervisor(
            w.config(), runner=runner, fetch=lambda url: w.model_sources[url],
            now=lambda: w.now, disk_free=lambda _p: 999,
        )
        supervisor._transition("2026-12:1", "STARTING", {"resume": False})

        recovered = supervisor.tick("2026-12:1")
        self.assertEqual(recovered["state"], "STOPPED_UNCERTAIN_START")
        self.assertEqual(runner.calls, [])
        alerts = json.loads((w.state / "alert_status.json").read_text())
        self.assertEqual(alerts["active"][0]["code"], "UNCERTAIN_START")

    def test_crashed_mid_call_settles_once_then_stops(self):
        w = World()
        calls = w.lane / "out" / "qrp-data" / "research" / "mining_llm_calls.jsonl"
        calls.parent.mkdir(parents=True)
        calls.write_text(json.dumps({"round_id": "R1", "outcome": "WAITING_STEP_CRASHED_MID_CALL", "request_sha256": "a" * 64}) + "\n")
        crashed = timer.CommandResult(75, '{"round_id":"R1","status":"WAITING","llm_state":"WAITING_STEP_CRASHED_MID_CALL"}\n')
        runner = FakeRunner(crashed, crashed)
        supervisor = timer.Supervisor(w.config(), runner=runner, fetch=lambda url: w.model_sources[url], now=lambda: w.now, disk_free=lambda _p: 999)
        self.assertEqual(supervisor.tick("2026-12:1")["state"], "WAITING_SETTLE")
        self.assertEqual(supervisor.tick("2026-12:1")["state"], "STOPPED_CRASH_SETTLED")
        self.assertEqual(len(runner.calls), 2)
        self.assertTrue((w.state / "alert_status.json").exists())

    def test_crash_occurrences_use_runner_local_projection_and_never_unknown(self):
        w = World()
        calls = w.lane / "out" / "qrp-data" / "research" / "mining_llm_calls.jsonl"
        calls.parent.mkdir(parents=True)
        crashed = timer.CommandResult(75, '{"round_id":"R1","status":"WAITING","llm_state":"WAITING_STEP_CRASHED_MID_CALL"}\n')
        runner = FakeRunner(crashed, crashed, crashed)
        supervisor = timer.Supervisor(w.config(), runner=runner, fetch=lambda url: w.model_sources[url], now=lambda: w.now, disk_free=lambda _p: 999)
        first_sha, second_sha = "1" * 64, "2" * 64
        calls.write_text(json.dumps({"round_id": "R1", "outcome": "WAITING_STEP_CRASHED_MID_CALL", "request_sha256": first_sha}) + "\n")
        self.assertEqual(supervisor.tick("2026-12:1")["detail"]["occurrence"], first_sha)
        with calls.open("a") as stream:
            stream.write(json.dumps({"round_id": "R1", "outcome": "WAITING_STEP_CRASHED_MID_CALL", "request_sha256": second_sha}) + "\n")
        self.assertEqual(supervisor.tick("2026-12:1")["detail"]["occurrence"], second_sha)
        stopped = supervisor.tick("2026-12:1")
        self.assertEqual(stopped["state"], "STOPPED_CRASH_SETTLED")
        rows = [json.loads(line) for line in (w.state / "ledger.jsonl").read_text().splitlines()]
        settles = [row["detail"]["occurrence"] for row in rows if row["state"] == "WAITING_SETTLE"]
        self.assertEqual(settles, [first_sha, second_sha])
        self.assertNotIn("unknown", settles)

    def test_real_merged_run_sh_mount_and_two_crash_occurrences_settle_independently(self):
        w = World()
        calls = w.lane / "out" / "qrp-data" / "research" / "mining_llm_calls.jsonl"
        calls.parent.mkdir(parents=True)
        runner, captured = w.docker_stub_runner("WAITING_STEP_CRASHED_MID_CALL")
        real_run_sh = ROOT / "deploy" / "research-lane" / "round-runner" / "run.sh"
        supervisor = timer.Supervisor(
            w.config(run_sh=real_run_sh), runner=runner,
            fetch=lambda url: w.model_sources[url], now=lambda: w.now,
            disk_free=lambda _p: 999,
        )
        first_sha, second_sha = "3" * 64, "4" * 64
        calls.write_text(json.dumps({"round_id": "R1", "outcome": "WAITING_STEP_CRASHED_MID_CALL", "request_sha256": first_sha}) + "\n")
        self.assertEqual(supervisor.tick("2026-12:1")["detail"]["occurrence"], first_sha)
        with calls.open("a") as stream:
            stream.write(json.dumps({"round_id": "R1", "outcome": "WAITING_STEP_CRASHED_MID_CALL", "request_sha256": second_sha}) + "\n")
        self.assertEqual(supervisor.tick("2026-12:1")["detail"]["occurrence"], second_sha)
        self.assertEqual(supervisor.tick("2026-12:1")["state"], "STOPPED_CRASH_SETTLED")
        self.assertEqual([result.rc for result in captured], [75, 75, 75])
        docker_calls = [json.loads(line) for line in (w.root / "docker-argv.jsonl").read_text().splitlines()]
        mounts = [arg for call in docker_calls for arg in call if arg.endswith(":/out:rw")]
        self.assertIn(f"{w.lane / 'out'}:/out:rw", mounts)
        self.assertNotIn(f"{w.data}:/out:rw", mounts)

    def test_absent_or_non_regular_crash_occurrence_fails_closed_and_alerts(self):
        for kind in ("absent", "fifo"):
            with self.subTest(kind=kind):
                w = World()
                calls = w.lane / "out" / "qrp-data" / "research" / "mining_llm_calls.jsonl"
                calls.parent.mkdir(parents=True)
                if kind == "fifo":
                    os.mkfifo(calls)
                crashed = timer.CommandResult(75, '{"round_id":"R1","status":"WAITING","llm_state":"WAITING_STEP_CRASHED_MID_CALL"}\n')
                supervisor = timer.Supervisor(w.config(), runner=FakeRunner(crashed), fetch=lambda url: w.model_sources[url], now=lambda: w.now, disk_free=lambda _p: 999)
                result = supervisor.tick("2026-12:1")
                self.assertEqual(result["state"], "STOPPED_CRASH_OCCURRENCE_UNAVAILABLE")
                alerts = json.loads((w.state / "alert_status.json").read_text())
                self.assertEqual(alerts["active"][0]["code"], "CRASH_OCCURRENCE_UNAVAILABLE")

    def test_stderr_refusal_uses_first_json_document(self):
        w = World()
        result = timer.CommandResult(
            2, "",
            '{"error":"MINE_ROUND_MONTHLY_CAP"}\n{"error":"LATER_DIAGNOSTIC"}\n',
        )
        supervisor = timer.Supervisor(w.config(), runner=FakeRunner(result), fetch=lambda url: w.model_sources[url], now=lambda: w.now, disk_free=lambda _p: 999)
        stopped = supervisor.tick("2026-12:1")
        self.assertEqual(stopped["state"], "STOPPED_MINE_ROUND_MONTHLY_CAP")
        self.assertEqual(stopped["detail"]["code"], "MINE_ROUND_MONTHLY_CAP")

    def test_no_resume_matrix_and_refused_open_alert(self):
        for rc, payload, error in (
            (75, '{"round_id":"R1","status":"WAITING","llm_state":"WAITING_QUOTA"}', ""),
            (3, '{"round_id":"R1","status":"STOPPED","llm_state":"STOPPED_TOKEN_CAP"}', ""),
            (2, "", '{"error":"MINE_ROUND_MONTHLY_CAP"}'),
            (64, "", "usage"),
        ):
            with self.subTest(rc=rc):
                w = World(); runner = FakeRunner(timer.CommandResult(rc, payload, error))
                supervisor = timer.Supervisor(w.config(), runner=runner, fetch=lambda url: w.model_sources[url], now=lambda: w.now, disk_free=lambda _p: 999)
                self.assertTrue(supervisor.tick("2026-12:1")["state"].startswith("STOPPED"))
                supervisor.tick("2026-12:1")
                self.assertEqual(len(runner.calls), 1)
                self.assertTrue((w.state / "alert_status.json").exists())

    def test_blackout_disk_missing_freeze_segment_key_and_model_gate_wait_without_start(self):
        cases = []
        w1 = World(); blackout = w1.root / "blackouts.json"; blackout.write_text(json.dumps({"entries": [{"start": "2026-12-01T20:00:00+08:00", "end": "2026-12-01T21:00:00+08:00", "hosts": ["LINUX"], "mode": "STOP"}]})); cases.append((w1, w1.config(blackouts_path=blackout), 999))
        w2 = World(); cases.append((w2, w2.config(disk_floor_gib=150), 149))
        w3 = World(); w3.freeze.unlink(); cases.append((w3, w3.config(), 999))
        w4 = World(); w4.sums.unlink(); w4.segment.rmdir(); cases.append((w4, w4.config(), 999))
        w5 = World(); bad = dict(w5.model_sources); bad["https://updates"] = b"changed"; cases.append((w5, w5.config(model_sources=bad), 999))
        for w, config, free in cases:
            runner = FakeRunner()
            outcome = timer.Supervisor(config, runner=runner, fetch=lambda url, values=config.model_sources: values[url], now=lambda w=w: w.now, disk_free=lambda _p, free=free: free).tick("2026-12:1")
            self.assertTrue(outcome["state"].startswith("WAITING") or outcome["state"].startswith("STOPPED"))
            self.assertEqual(runner.calls, [])

    def test_ledger_is_hash_chained_and_tamper_fails_closed(self):
        w = World(); runner = FakeRunner(timer.CommandResult(0, '{"round_id":"R1"}'))
        supervisor = timer.Supervisor(w.config(), runner=runner, fetch=lambda url: w.model_sources[url], now=lambda: w.now, disk_free=lambda _p: 999)
        supervisor.tick("2026-12:1")
        rows = [json.loads(line) for line in (w.state / "ledger.jsonl").read_text().splitlines()]
        self.assertEqual(rows[0]["prev_hash"], None)
        self.assertEqual(rows[-1]["prev_hash"], rows[-2]["record_hash"])
        rows[0]["state"] = "TAMPERED"
        (w.state / "ledger.jsonl").write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        with self.assertRaisesRegex(timer.LedgerError, "HASH_MISMATCH"):
            supervisor.tick("2026-12:2")

    def test_ledger_tamper_alerts_once_without_rewriting_damaged_ledger(self):
        corruptions = {
            "hash": lambda rows: rows[0].update(state="TAMPERED"),
            "shape": lambda rows: rows[0].update(schema="WRONG"),
            "json": None,
        }
        for kind, mutate in corruptions.items():
            with self.subTest(kind=kind):
                w = World(); runner = FakeRunner(timer.CommandResult(0, '{"round_id":"R1"}'))
                supervisor = timer.Supervisor(w.config(), runner=runner, fetch=lambda url: w.model_sources[url], now=lambda: w.now, disk_free=lambda _p: 999)
                supervisor.tick("2026-12:1")
                ledger = w.state / "ledger.jsonl"
                if kind == "json":
                    damaged = ledger.read_bytes() + b"{not-json}\n"
                else:
                    rows = [json.loads(line) for line in ledger.read_text().splitlines()]
                    mutate(rows)
                    damaged = ("\n".join(json.dumps(row) for row in rows) + "\n").encode()
                ledger.write_bytes(damaged)
                for _ in range(2):
                    with self.assertRaises(timer.LedgerError):
                        supervisor.tick("2026-12:2")
                self.assertEqual(ledger.read_bytes(), damaged)
                alerts = json.loads((w.state / "alert_status.json").read_text())
                tamper = [row for row in alerts["active"] if row["code"] == "LEDGER_TAMPER"]
                self.assertEqual(len(tamper), 1)
                self.assertEqual(tamper[0]["detail"], {"reason": "LEDGER_INTEGRITY_INVALID"})


if __name__ == "__main__":
    unittest.main()
