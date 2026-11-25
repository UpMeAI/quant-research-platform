"""Q3c: the consumer stages the agent's inputs, maps its result.json onto the outcome classes, and completes only on its own re-validation (never the agent's block).
Also the HK spool hand-off (rq-agent.service as a oneshot that drains a spool) and its units. Node is required for the validator; without it the tests that need it are skipped."""
import json, os, shutil, subprocess, threading, time, unittest
from unittest import mock
from helpers import *  # noqa
from rq import agentseam  # noqa

NODE = shutil.which("node")
REPO = ROOT
DEPLOY = ROOT / "deploy"
AI = DEPLOY / "research-queue-ai" / "hk"
STUB_AGENT = str(ROOT / "tests" / "_rq_stub_agent.js")
need_node = unittest.skipUnless(NODE, "node not available")
FACTS = None


VALUES = [{"signals": 12, "window_days": 60}, {"hit_rate_pct": 41.5, "n": 87}, {"lag_days": 3}, {"count": 3, "key": "LATE_ENTRY"}, {"missing": ["RS60"]}]


def fact_pack(week="2026-W47", market="CN_A"):
    return {"schema": "REVIEW_AI_FACT_PACK_V1", "week": week, "market": market,
            "facts": [{"id": "F-%03d" % (i + 1), "source": {"path": "runs/RQT-LINUX-20261122-aaaa1111/attempt-1/evidence/%d.json" % (i + 1), "sha256": sha("src%d" % (i + 1)), "pointer": "/rows/%d" % (i + 1)},
                       "at": "2026-11-20T18:00:00+08:00", "value": v} for i, v in enumerate(VALUES)],
            "code_counts": [{"key": "LATE_ENTRY", "count": 3, "fact_id": "F-004"}]}


class Mapping(unittest.TestCase):
    def test_result_status_maps_onto_outcome_classes(self):
        m = agentseam.map_result
        self.assertEqual(m({"schema": "RQ_AGENT_RESULT_V1", "status": "DONE"}).kind, "SUCCESS")
        o = m({"schema": "RQ_AGENT_RESULT_V1", "status": "WAITING", "wait_state": "WAITING_CREDENTIAL", "reason_code": "RQ_CREDENTIAL_ABSENT"})
        self.assertEqual((o.kind, o.code), ("A", "RQ_CREDENTIAL_ABSENT"))
        o = m({"schema": "RQ_AGENT_RESULT_V1", "status": "WAITING", "wait_state": "WAITING_QUOTA", "reason_code": "RQ_QUOTA"})
        self.assertEqual((o.kind, o.code), ("Q", "RQ_QUOTA"))
        o = m({"schema": "RQ_AGENT_RESULT_V1", "status": "WAITING", "wait_state": "WAITING_EXTERNAL", "reason_code": "MECHANISM_ADMISSION"})
        self.assertEqual((o.kind, o.code), ("E", "MECHANISM_ADMISSION"))
        o = m({"schema": "RQ_AGENT_RESULT_V1", "status": "RETRY", "reason_code": "RQ_PROVIDER_5XX", "retry_after_s": 120})
        self.assertEqual((o.kind, o.code, o.retry_after_s), ("T3", "RQ_PROVIDER_5XX", 120))
        self.assertEqual(m({"schema": "RQ_AGENT_RESULT_V1", "status": "DEFER", "reason_code": "RQ_PEAK_REFUSED"}).kind, "DEFER")
        o = m({"schema": "RQ_AGENT_RESULT_V1", "status": "BLOCKED_DETERMINISTIC", "reason_code": "RQ_PRO_FALLBACK_FAILED"})
        self.assertEqual((o.kind, o.code), ("D", "RQ_PRO_FALLBACK_FAILED"))
        for bad in ({"schema": "RQ_AGENT_RESULT_V1", "status": "MAYBE"}, {"schema": "RQ_AGENT_RESULT_V1", "status": "WAITING", "wait_state": "WAITING_NOWHERE"}):
            self.assertEqual(m(bad).kind, "D", bad)

    def test_classify_uses_the_mapping_only_for_agent_results(self):
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d)
            (p / "result.json").write_text(json.dumps({"schema": "RQ_AGENT_RESULT_V1", "status": "WAITING", "wait_state": "WAITING_QUOTA", "reason_code": "RQ_QUOTA"}))
            o = consumer.classify(p, {"exit_code": 0})
            self.assertEqual(o.kind, "Q")
            (p / "result.json").write_text(json.dumps({"anything": 1}))
            self.assertEqual(consumer.classify(p, {"exit_code": 0}).kind, "SUCCESS")  # non-agent tasks keep the Q1 protocol

    def test_untrusted_result_fields_are_validated_and_retry_after_is_clamped(self):
        bad_fields = (
            {"status": ["WAITING"], "wait_state": "WAITING_QUOTA"},
            {"status": "WAITING", "wait_state": ["WAITING_QUOTA"]},
            {"status": "WAITING", "wait_state": "WAITING_QUOTA", "reason_code": {"code": "RQ_QUOTA"}},
            {"status": "BLOCKED_DETERMINISTIC", "reason_code": "X" * 65},
            {"status": "RETRY", "retry_after_s": True},
        )
        for result in bad_fields:
            outcome = agentseam.map_result({"schema": "RQ_AGENT_RESULT_V1", **result})
            self.assertEqual((outcome.kind, outcome.code), ("D", "RESULT_FIELD_INVALID"), result)
        outcome = agentseam.map_result({"schema": "RQ_AGENT_RESULT_V1", "status": "RETRY", "reason_code": "RQ_PROVIDER", "retry_after_s": 300_000_000_000})
        self.assertEqual((outcome.kind, outcome.code, outcome.retry_after_s), ("T3", "RQ_PROVIDER", 86400))


class FinalizationSafety(Base):
    def test_unexpected_finalize_error_blocks_once_instead_of_crashing_the_consumer_loop(self):
        t = tpl("T-STUB-W0-V1")
        admitted = self.admit(registry([t]), req(t))
        claimed = core.claim(self.conn, host="LINUX", worker=self.cfg.worker, now=self.t0)
        core.transition(self.conn, admitted.task_id, "RUNNING", actor="rq-consumer", now=self.t0, token=claimed["lease_token"])

        class Exited:
            @staticmethod
            def status(_attempt_dir):
                return runtime.RuntimeStatus(True, False, {"exit_code": 0})

        with mock.patch.object(consumer, "_finalize", side_effect=TypeError("poisoned result")) as finalize:
            summary = consumer.tick(self.conn, self.cfg, Exited(), self.t0)
            self.assertEqual(summary["finished"], [admitted.task_id])
            self.assertEqual((self.state(admitted.task_id), self.row(admitted.task_id)["state_reason"]), ("BLOCKED_DETERMINISTIC", "FINALIZE_ERROR"))
            consumer.tick(self.conn, self.cfg, Exited(), self.t0)
            self.assertEqual(finalize.call_count, 1, "the same poison result must not be finalized in a restart loop")


class Outcomes(Base):
    def test_defer_goes_back_to_ready_without_spending_a_budget(self):
        t = tpl("T-STUB-W0-V1")
        r = self.admit(registry([t]), req(t))
        c = core.claim(self.conn, host="LINUX", worker="w", now=self.t0)
        core.transition(self.conn, r.task_id, "RUNNING", actor="rq-consumer", now=self.t0, token=c["lease_token"])
        consumer.apply_outcome(self.conn, self.cfg, r.task_id, consumer.Outcome("DEFER", "RQ_PEAK_REFUSED"), self.t0)
        row = self.row(r.task_id)
        self.assertEqual(row["state"], "READY")
        self.assertEqual(row["state_reason"], "DEFER")
        self.assertGreater(row["not_before"], core.iso(self.t0))
        self.assertEqual(self.conn.execute("select count(*) from event where task_id=? and reason_code='T1_INTERRUPTED'", (r.task_id,)).fetchone()[0], 0)


@need_node
class AgentFlow(Base):
    """queue -> staging -> agent stub (the real runAgentTask with a canned model) -> classify -> re-validation -> COMPLETE."""

    def setUp(self):
        super().setUp()
        self.cfg.node_bin = NODE
        self.t = net_tpl("T-STUB-CARD-V1", prompt_admission_sha256=sha("p"), params={}, argv=[NODE, STUB_AGENT], markets=["CN_A"], agent_host="LINUX", run_host="LINUX", producer_host="LINUX")
        self.reg = registry([self.t])
        d = self.cfg.inbox_dir / "fact-packs"
        d.mkdir(parents=True)
        (d / "2026-W47-CN_A.json").write_text(json.dumps(fact_pack()))
        self.cfg.env_allowlist = ["STUB_MODE"]

    def _run(self, mode=None):
        if mode:
            os.environ["STUB_MODE"] = mode
            self.addCleanup(os.environ.pop, "STUB_MODE", None)
        producer.tick(self.conn, self.cfg, self.reg, self.t0)
        tid = self.conn.execute("select task_id from task where state='READY'").fetchone()[0]
        rt = runtime.ProcessRuntime()
        self.addCleanup(rt.stop_all)
        st = drive(self, rt, self.t0, tid)
        return tid, st

    def test_staging_writes_the_seam_files_before_launch(self):
        tid, st = self._run()
        d = self.cfg.runs_dir / tid / "attempt-1"
        task = json.loads((d / "in" / "task.json").read_text())
        self.assertEqual((task["task_id"], task["kind"], task["market"], task["agent_host"], task["attempt_no"]), (tid, "AI_REVIEW_CARD", "CN_A", "LINUX", 1))
        bundle = json.loads((d / "in" / "bundle.json").read_text())
        self.assertEqual((bundle["schema"], bundle["market"], bundle["week_id"]), ("RQ_AGENT_BUNDLE_V1", "CN_A", "2026-W47"))
        self.assertEqual(len(bundle["pack"]["facts"]), 5)

    def test_end_to_end_valid_result_completes_on_the_consumers_revalidation(self):
        tid, st = self._run()
        self.assertEqual(st, "EVIDENCE_WRITTEN")
        self.assertEqual(complete.tick(self.conn, self.cfg, self.t0), [tid])
        row = self.row(tid)
        self.assertEqual((row["state"], row["state_reason"]), ("COMPLETE", "SELF_VALIDATED"))

    def test_forged_validator_block_on_an_invalid_result_is_not_complete(self):
        tid, st = self._run("forge")
        self.assertEqual(st, "EVIDENCE_WRITTEN")
        res = json.loads((self.cfg.runs_dir / tid / "attempt-1" / "result.json").read_text())
        self.assertTrue(res["validator"]["ok"])  # the agent certified itself ...
        self.assertEqual(complete.tick(self.conn, self.cfg, self.t0), [])
        row = self.row(tid)
        self.assertEqual((row["state"], row["state_reason"]), ("BLOCKED_DETERMINISTIC", "VALIDATOR_NOT_OK"))  # ... and the consumer did not believe it

    def test_missing_node_is_blocked_never_complete(self):
        tid, st = self._run()
        self.cfg.node_bin = "/nonexistent/node"
        self.assertEqual(complete.tick(self.conn, self.cfg, self.t0), [])
        self.assertEqual((self.row(tid)["state"], self.row(tid)["state_reason"]), ("BLOCKED_DETERMINISTIC", "VALIDATOR_UNAVAILABLE"))

    def test_validator_crash_exit_is_unavailable(self):
        tid, st = self._run()
        self.cfg.node_bin = "/usr/bin/false"
        self.assertEqual(complete.tick(self.conn, self.cfg, self.t0), [])
        self.assertEqual((self.row(tid)["state"], self.row(tid)["state_reason"]), ("BLOCKED_DETERMINISTIC", "VALIDATOR_UNAVAILABLE"))

    def test_input_changed_after_admission_is_refused_at_staging(self):
        producer.tick(self.conn, self.cfg, self.reg, self.t0)
        tid = self.conn.execute("select task_id from task where state='READY'").fetchone()[0]
        (self.cfg.inbox_dir / "fact-packs" / "2026-W47-CN_A.json").write_text(json.dumps(dict(fact_pack(), facts=[])))
        rt = runtime.ProcessRuntime()
        self.addCleanup(rt.stop_all)
        consumer.tick(self.conn, self.cfg, rt, self.t0)
        self.assertEqual((self.state(tid), self.row(tid)["state_reason"]), ("BLOCKED_DETERMINISTIC", "STAGE_INPUT_SHA_MISMATCH"))

    def test_agent_result_waiting_credential_parks_the_task(self):
        tid, st = self._run("no_credential")
        self.assertEqual(st, "WAITING_CREDENTIAL")


class SpoolScripts(unittest.TestCase):
    """The spool hand-off, shell level: the consumer-side client and the agent-side drain, with a stand-in agent CLI."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = pathlib.Path(self._tmp.name)
        self.spool = self.root / "spool"
        for n in ("in", "out"):
            (self.spool / n).mkdir(parents=True)
        self.att = self.root / "att"
        (self.att / "in").mkdir(parents=True)
        (self.att / "in" / "task.json").write_text('{"task_id":"RQT-HK-1"}')
        (self.att / "in" / "bundle.json").write_text('{"b":1}')
        self.cli = self.root / "fake-cli.sh"
        self.cli.write_text('#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --out) OUT="$2";; --task) T="$2";; esac; shift; done\n'
                            '[ "${FAKE_FAIL:-}" = 1 ] && exit 4\nmkdir -p "$OUT.tmp" && cp "$T" "$OUT.tmp/task.copy" && echo \'{"schema":"RQ_AGENT_RESULT_V1","status":"DONE"}\' > "$OUT.tmp/result.json" && mv "$OUT.tmp" "$OUT"\n')
        self.cli.chmod(0o755)
        self.env = {"PATH": "/usr/bin:/bin", "RQ_ATTEMPT_DIR": str(self.att), "RQ_TASK_ID": "RQT-HK-1", "RQ_ATTEMPT_NO": "1", "RQ_SPOOL_DIR": str(self.spool), "RQ_SPOOL_POLL_S": "0.1", "RQ_SPOOL_TIMEOUT_S": "20",
                    "RQ_NODE": "/bin/sh", "RQ_AGENT_CLI": str(self.cli)}

    def client(self, **kw):
        return subprocess.Popen(["sh", str(AI / "spool-client.sh")], env=dict(self.env, **kw), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def drain(self, **kw):
        return subprocess.run(["sh", str(AI / "rq-agent-drain.sh")], env=dict(self.env, **kw), capture_output=True, text=True, timeout=60)

    def test_scripts_exist_and_are_plain_posix_sh(self):
        for n in ("spool-client.sh", "rq-agent-drain.sh"):
            p = AI / n
            self.assertTrue(p.exists() and os.access(p, os.X_OK), n)
            self.assertEqual(subprocess.run(["sh", "-n", str(p)]).returncode, 0, n)
            code = "\n".join(l for l in p.read_text().splitlines() if not l.lstrip().startswith("#"))
            for bad in ("DEEPSEEK", "sudo", "systemctl", "systemd-run", "polkit", "curl", "wget"):
                self.assertNotIn(bad, code, (n, bad))

    def test_client_stages_into_the_spool_and_publishes_the_drained_result(self):
        c = self.client()
        for _ in range(100):
            if (self.spool / "in" / "RQT-HK-1-a1" / "task.json").exists():
                break
            time.sleep(0.05)
        self.assertTrue((self.spool / "in" / "RQT-HK-1-a1" / "bundle.json").exists())
        r = self.drain()
        self.assertEqual(r.returncode, 0, r.stderr)
        out, err = c.communicate(timeout=30)
        self.assertEqual(c.returncode, 0, err)
        self.assertEqual(json.loads((self.att / "result.json").read_text())["status"], "DONE")
        self.assertTrue((self.att / "out" / "task.copy").exists())
        self.assertFalse((self.spool / "in" / "RQT-HK-1-a1").exists(), "the consumer-side client removes its staged input")

    def test_drain_is_idempotent_and_skips_when_paused_or_empty(self):
        self.assertEqual(self.drain().returncode, 0)  # empty spool
        (self.spool / "in" / "RQT-HK-9-a1").mkdir()
        (self.spool / "in" / "RQT-HK-9-a1" / "task.json").write_text("{}")
        (self.spool / "in" / "RQT-HK-9-a1" / "bundle.json").write_text("{}")
        (self.spool / "in" / ".pause").write_text("")
        self.drain()
        self.assertFalse((self.spool / "out" / "RQT-HK-9-a1").exists(), "a pause file stops the drain")
        (self.spool / "in" / ".pause").unlink()
        self.drain()
        self.assertTrue((self.spool / "out" / "RQT-HK-9-a1" / "result.json").exists())
        mtime = (self.spool / "out" / "RQT-HK-9-a1" / "result.json").stat().st_mtime_ns
        self.drain()
        self.assertEqual((self.spool / "out" / "RQT-HK-9-a1" / "result.json").stat().st_mtime_ns, mtime, "a processed task is not run again")

    def test_agent_failure_becomes_a_structured_deterministic_error(self):
        c = self.client()
        time.sleep(0.5)
        self.drain(FAKE_FAIL="1")
        c.communicate(timeout=30)
        err = json.loads((self.att / "error.json").read_text())
        self.assertEqual((err["class"], err["code"]), ("D", "AGENT_EXIT_4"))
        self.assertNotEqual(c.returncode, 0)

    def test_a_symlink_in_the_agent_output_is_refused_not_followed(self):
        secret = self.root / "queue.sqlite"
        secret.write_text("QUEUE-DB")
        out = self.spool / "out" / "RQT-HK-1-a1"
        out.mkdir()
        os.symlink(secret, out / "result.json")
        c = self.client()
        c.communicate(timeout=30)
        err = json.loads((self.att / "error.json").read_text())
        self.assertEqual((err["class"], err["code"]), ("D", "AGENT_OUTPUT_SYMLINK"))
        self.assertFalse((self.att / "result.json").exists())

    def test_timeout_is_an_interruption_not_a_failure(self):
        c = self.client(RQ_SPOOL_TIMEOUT_S="1")
        c.communicate(timeout=30)
        err = json.loads((self.att / "error.json").read_text())
        self.assertEqual((err["class"], err["code"]), ("T1", "SPOOL_TIMEOUT"))

    def test_timeout_counts_active_poll_iterations_not_wall_clock(self):
        code = (AI / "spool-client.sh").read_text()
        self.assertNotIn("date +%s", code)
        self.assertIn("POLL_COUNT", code)
        self.assertIn("MAX_POLLS", code)

    def test_client_without_staged_input_refuses_66(self):
        shutil.rmtree(self.att / "in")
        r = subprocess.run(["sh", str(AI / "spool-client.sh")], env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 66)
        self.assertIn("RQ_AGENT_INPUT_NOT_STAGED", r.stderr)


def unit(path):
    out, cur = {}, None
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            cur = line
            continue
        k, _, v = line.partition("=")
        out.setdefault((cur, k), []).append(v)
    return out


class SpoolUnits(unittest.TestCase):
    def test_agent_is_a_timer_started_oneshot_that_drains_the_spool_as_rq_agent(self):
        u = unit(AI / "rq-agent.service")
        g = lambda k: u[("[Service]", k)][-1]  # noqa
        self.assertEqual(g("Type"), "oneshot")
        self.assertEqual(g("User"), "rq-agent")
        self.assertIn("rq-agent-drain.sh", g("ExecStart"))
        self.assertEqual(g("IPAddressDeny"), "any")
        self.assertEqual(g("RestrictAddressFamilies"), "AF_UNIX")
        self.assertEqual(g("TemporaryFileSystem"), "/var/lib:ro")
        self.assertEqual(g("BindReadOnlyPaths"), "/var/lib/rq-spool/in")
        self.assertEqual(g("BindPaths"), "/var/lib/rq-spool/out")
        self.assertEqual(g("TimeoutStartSec"), "infinity")
        self.assertNotIn(("[Service]", "EnvironmentFile"), u)
        t = unit(AI / "rq-agent.timer")
        self.assertRegex(t[("[Timer]", "OnCalendar")][-1], r"10\.\.21:0/5")
        self.assertTrue(t[("[Timer]", "OnCalendar")][-1].endswith(" Asia/Shanghai"))
        self.assertEqual(t[("[Timer]", "Unit")][-1] if ("[Timer]", "Unit") in t else "rq-agent.service", "rq-agent.service")

    def test_groups_keep_the_agent_out_of_the_queue_group_and_the_socket_belongs_to_the_agent_group(self):
        s = (DEPLOY / "research-queue" / "hk" / "rq.sysusers.conf").read_text()
        self.assertNotIn("m rq-agent rq", s)
        self.assertIn("m research-queue rq", s)
        g = (AI / "rq-deepseek-gateway.service").read_text()
        self.assertIn("Group=rq-agent\n", g)
        self.assertNotIn("Group=rq\n", g)
        tf = (DEPLOY / "research-queue" / "hk" / "rq.tmpfiles.conf").read_text()
        self.assertRegex(tf, r"d /var/lib/rq-spool\s+0750 research-queue rq-agent")
        self.assertRegex(tf, r"d /var/lib/rq-spool/in\s+2750 research-queue rq-agent")
        self.assertRegex(tf, r"d /var/lib/rq-spool/out\s+2770 research-queue rq-agent")
        self.assertNotIn("rq-agent rq", tf)
        self.assertRegex(tf, r"d /var/lib/rq-gw\s+0700 rq-gw rq-gw")
        self.assertNotIn("/var/lib/research-queue/gateway", tf)
        self.assertIn("--db /var/lib/rq-gw/gateway.sqlite", g)
        self.assertIn("ReadWritePaths=/var/lib/rq-gw", g)

    def test_consumer_and_pause_units_may_write_the_spool_only_where_needed(self):
        c = unit(DEPLOY / "research-queue" / "hk" / "rq-consumer.service")
        self.assertIn("/var/lib/rq-spool", c[("[Service]", "ReadWritePaths")][-1])
        p = unit(DEPLOY / "research-queue" / "hk" / "rq-pause.service")
        self.assertIn("/var/lib/rq-spool", p[("[Service]", "ReadWritePaths")][-1])
        self.assertNotIn(("[Service]", "AmbientCapabilities"), c)


class SpoolPause(Base):
    host = "HK"

    def _running(self):
        from test_pause import Sensors
        self.Sensors = Sensors
        spool = self.root / "spool"
        (spool / "in").mkdir(parents=True)
        self.cfg.spool_dir = str(spool)
        t = net_tpl()
        r = self.admit(registry([t]), req(t, market="US_EQUITY", params={"mode": "sleep"}), at(11, 0))
        rt = runtime.ProcessRuntime()
        self.addCleanup(rt.stop_all)
        os.environ["STUB_SLEEP"] = "20"
        self.addCleanup(os.environ.pop, "STUB_SLEEP", None)
        consumer.tick(self.conn, self.cfg, rt, at(11, 0))
        self.assertEqual(self.state(r.task_id), "RUNNING")
        return r, spool

    def test_pause_freezes_the_consumer_and_the_agent_service_and_writes_the_pause_file(self):
        r, spool = self._running()
        calls = []
        pauser = pause.Pauser(lambda argv: (calls.append(argv) or (0, "")), "HK")
        sf = self.cfg.state_dir / "pause-state.json"
        pause.tick(self.conn, self.cfg, at(11, 1), pauser, self.Sensors(load5=4.0), [], sf)
        self.assertEqual(sorted(a[-1] for a in calls if a[:2] == ["systemctl", "freeze"]), ["rq-agent.service", "rq-consumer.service"])
        self.assertTrue((spool / "in" / ".pause").exists())
        calls.clear()
        pause.tick(self.conn, self.cfg, at(11, 30), pauser, self.Sensors(load5=0.5), [], sf)
        self.assertEqual(self.state(r.task_id), "RUNNING")
        self.assertFalse((spool / "in" / ".pause").exists())
        self.assertIn(["systemctl", "thaw", "rq-agent.service"], calls)
        self.assertIn(["systemctl", "thaw", "rq-consumer.service"], calls)

    def test_agent_unit_freeze_failure_is_tolerated_when_the_unit_is_inactive(self):
        r, spool = self._running()
        pauser = pause.Pauser(lambda argv: (1, "") if argv[-1] == "rq-agent.service" else (0, ""), "HK")
        res = pause.tick(self.conn, self.cfg, at(11, 1), pauser, self.Sensors(load5=4.0), [], self.cfg.state_dir / "pause-state.json")
        self.assertEqual(res["paused"], [r.task_id])
        self.assertEqual(self.state(r.task_id), "PAUSED")
        self.assertTrue((spool / "in" / ".pause").exists(), "the pause file still stops a drain that starts later")


class HkTemplates(unittest.TestCase):
    def test_hk_templates_are_pinned_with_the_spool_client_argv(self):
        reg = templates.Registry.load(ROOT / "config/research_queue_templates.v1.json", ROOT / "config/research_queue_template_pins.v1.json")
        for tid in ("T-AI-REVIEW-CARD-V1-HK-US-CRYPTO", "T-AI-CHECK-V1-HK-US-CRYPTO"):
            t = reg.get(tid)
            self.assertEqual(t["argv"], ["/opt/research-queue/current/deploy/research-queue-ai/hk/spool-client.sh"])
            self.assertEqual(templates.validate_template(t), [])
            self.assertTrue(reg.is_frozen(t), tid)
            pin = [p for p in reg.pins if p["template_id"] == tid][0]
            self.assertIsNone(pin["frozen_page_sha256"], "FREEZE_2 page not written yet")
            self.assertEqual(pin["template_sha256"], templates.template_sha256(t))
            self.assertIn("spool", t["launch"])
        self.assertEqual(len(reg.pins), 7)


if __name__ == "__main__":
    unittest.main()
