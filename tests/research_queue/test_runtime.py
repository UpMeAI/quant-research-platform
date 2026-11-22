"""AQ-04 lease expiry and adoption, AQ-05 kill -9 consumer, AQ-06 kill -9 task, AQ-07 score crash, run receipts."""
import datetime as dt, json, os, signal, subprocess, sys, time, unittest
from helpers import *  # noqa


def wait_for(fn, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError("timeout")


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(out) and not out.startswith("Z")


class Lease(Base):
    def setUp(self):
        super().setUp()
        self.t = tpl("T-STUB-W0-V1", params={"mode": "^[A-Za-z0-9_]+$"})
        self.reg = registry([self.t])
        self.rt = runtime.ProcessRuntime()
        os.environ["STUB_SLEEP"] = "4"
        self.addCleanup(os.environ.pop, "STUB_SLEEP", None)

    def attempt_dir(self, task_id, n=1):
        return self.cfg.runs_dir / task_id / ("attempt-%d" % n)

    def test_aq04_expired_lease_with_live_runtime_is_adopted_not_relaunched(self):
        r = self.admit(self.reg, req(self.t, params={"mode": "sleep"}))
        consumer.tick(self.conn, self.cfg, self.rt, self.t0)
        self.assertEqual(self.state(r.task_id), "RUNNING")
        old = self.row(r.task_id)["lease_token"]
        # consumer 1 is SIGSTOPped: no heartbeat for > TTL. Consumer 2 starts later.
        later = self.t0 + dt.timedelta(minutes=11)
        s = consumer.tick(self.conn, self.cfg, runtime.ProcessRuntime(), later, worker="w2")
        self.assertIn(r.task_id, s["adopted"])
        row = self.row(r.task_id)
        self.assertEqual(row["state"], "RUNNING")
        self.assertEqual(row["attempt_no"], 1)
        self.assertEqual(self.conn.execute("select count(*) from attempt").fetchone()[0], 1)
        self.assertNotEqual(row["lease_token"], old)
        self.assertEqual(row["lease_owner"], "w2")
        with self.assertRaises(core.LeaseTokenStale):  # the woken consumer 1 cannot write
            core.transition(self.conn, r.task_id, "EVIDENCE_WRITTEN", actor="rq-consumer", now=later, token=old)
        with self.assertRaises(core.LeaseTokenStale):
            core.heartbeat(self.conn, r.task_id, old, later, 600)
        self.assertEqual(drive(self, self.rt, later, r.task_id), "EVIDENCE_WRITTEN")
        self.assertEqual(self.conn.execute("select count(*) from attempt").fetchone()[0], 1)

    def test_aq05_kill9_consumer_task_keeps_running_and_is_adopted(self):
        import config_helper
        cfgfile = config_helper.write(self.cfg, self.root, lease_ttl_s=2, registry=self.reg, loop_interval_s=0.2)
        r = self.admit(self.reg, req(self.t, params={"mode": "sleep"}), now=core.now_cst())
        env = dict(os.environ, PYTHONPATH=str(ROOT / "services" / "research-queue"))
        p = subprocess.Popen([PY, "-m", "rq", "--config", str(cfgfile), "consumer-run"], env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        wait_for(lambda: self.state(r.task_id) == "RUNNING")
        pidfile = self.attempt_dir(r.task_id) / "child.pid"
        child = int(wait_for(lambda: pidfile.exists() and pidfile.read_text().strip() or None))
        p.send_signal(signal.SIGKILL)
        p.wait()
        self.assertTrue(pid_alive(child), "task must survive the consumer")
        time.sleep(2.5)  # lease expires
        s = consumer.tick(self.conn, self.cfg, runtime.ProcessRuntime(), core.now_cst(), worker="w2")
        self.assertIn(r.task_id, s["adopted"])
        self.assertEqual(drive(self, self.rt, core.now_cst(), r.task_id), "EVIDENCE_WRITTEN")
        self.assertEqual(self.row(r.task_id)["attempt_no"], 1)
        self.assertEqual(self.conn.execute("select count(*) from attempt").fetchone()[0], 1)


class Crash(Base):
    def setUp(self):
        super().setUp()
        self.rt = runtime.ProcessRuntime()
        os.environ["STUB_SLEEP"] = "30"
        self.addCleanup(os.environ.pop, "STUB_SLEEP", None)

    def kill_child(self, task_id, n):
        pf = self.cfg.runs_dir / task_id / ("attempt-%d" % n) / "child.pid"
        pid = int(wait_for(lambda: pf.exists() and pf.read_text().strip() or None))
        os.kill(pid, signal.SIGKILL)

    def argv(self, task_id, n):
        return json.loads((self.cfg.runs_dir / task_id / ("attempt-%d" % n) / "argv.txt").read_text())

    def test_aq06_killed_generate_is_resumed_never_relaunched(self):
        g = gen_tpl()
        r = self.admit(registry([g]), req(g, subject={"round": "R1"}, params={"round_id": "MR-1"}))
        consumer.tick(self.conn, self.cfg, self.rt, self.t0)
        wait_for(lambda: (self.cfg.runs_dir / r.task_id / "attempt-1" / "argv.txt").exists())
        self.kill_child(r.task_id, 1)
        self.assertEqual(drive(self, self.rt, self.t0, r.task_id), "READY")
        row = self.row(r.task_id)
        self.assertEqual(row["state_reason"], "T1_INTERRUPTED")
        self.assertGreaterEqual(row["not_before"], core.iso(self.t0 + dt.timedelta(minutes=10)))
        later = self.t0 + dt.timedelta(minutes=11)
        os.environ["STUB_SLEEP"] = "0"
        self.assertEqual(drive(self, self.rt, later, r.task_id), "EVIDENCE_WRITTEN")
        self.assertEqual(self.argv(r.task_id, 1)[0], "generate")
        self.assertEqual(self.argv(r.task_id, 2), ["resume", "MR-1"])
        self.assertEqual(self.row(r.task_id)["attempt_no"], 2)

    def test_aq07_score_crash_gets_exactly_one_rescore_then_blocks(self):
        s = score_tpl()
        reg = registry([s])
        r = self.admit(reg, req(s, subject={"round": "R1"}, params={"round_id": "MR-1"}))
        consumer.tick(self.conn, self.cfg, self.rt, self.t0)
        wait_for(lambda: (self.cfg.runs_dir / r.task_id / "attempt-1" / "child.pid").exists())
        self.kill_child(r.task_id, 1)
        self.assertEqual(drive(self, self.rt, self.t0, r.task_id), "READY")
        t1 = self.t0 + dt.timedelta(minutes=11)
        consumer.tick(self.conn, self.cfg, self.rt, t1)
        wait_for(lambda: (self.cfg.runs_dir / r.task_id / "attempt-2" / "child.pid").exists())
        self.assertEqual(self.argv(r.task_id, 2), ["rescore", "MR-1"])
        self.kill_child(r.task_id, 2)
        self.assertEqual(drive(self, self.rt, t1, r.task_id), "BLOCKED_DETERMINISTIC")
        self.assertEqual(self.row(r.task_id)["state_reason"], "RECOVERY_EXHAUSTED")
        self.assertEqual(self.row(r.task_id)["attempt_no"], 2)

    def test_aq07_structured_refusal_is_blocked_no_rescore(self):
        s = score_tpl()
        s["argv"] = [PY, STUB, "exit64"]
        s["params"] = {}
        r = self.admit(registry([s]), req(s, params={}))
        self.assertEqual(drive(self, self.rt, self.t0, r.task_id), "BLOCKED_DETERMINISTIC")
        self.assertEqual(self.row(r.task_id)["state_reason"], "MINE_MARKET_PAUSED")
        self.assertEqual(self.row(r.task_id)["attempt_no"], 1)

    def test_unstructured_nonzero_exit_is_blocked_not_retried(self):
        t = tpl("T-STUB-W0-V1")
        r = self.admit(registry([t]), req(t, params={"mode": "fail1"}))
        self.assertEqual(drive(self, self.rt, self.t0, r.task_id), "BLOCKED_DETERMINISTIC")
        self.assertEqual(self.row(r.task_id)["attempt_no"], 1)

    def test_non_idempotent_without_recovery_is_blocked_after_interruption(self):
        t = tpl("T-STUB-W0-V1", idempotent=False)
        r = self.admit(registry([t]), req(t, params={"mode": "sleep"}))
        consumer.tick(self.conn, self.cfg, self.rt, self.t0)
        self.kill_child(r.task_id, 1)
        self.assertEqual(drive(self, self.rt, self.t0, r.task_id), "BLOCKED_DETERMINISTIC")
        self.assertEqual(self.row(r.task_id)["state_reason"], "NO_RECOVERY_PATH")

    def test_t1_budget_exhausted_blocks(self):
        t = tpl("T-STUB-W0-V1", transient_budget=1)
        r = self.admit(registry([t]), req(t, params={"mode": "sleep"}))
        now = self.t0
        for n in (1, 2):
            consumer.tick(self.conn, self.cfg, self.rt, now)
            self.kill_child(r.task_id, n)
            st = drive(self, self.rt, now, r.task_id)
            now = now + dt.timedelta(minutes=11)
        self.assertEqual(st, "BLOCKED_DETERMINISTIC")
        self.assertEqual(self.row(r.task_id)["state_reason"], "T1_BUDGET_EXHAUSTED")


class Receipts(Base):
    def test_receipt_complete_and_secret_free(self):
        os.environ["DEEPSEEK_RESEARCH_API_KEY"] = "sk-" + "a1B2c3D4" * 5
        self.addCleanup(os.environ.pop, "DEEPSEEK_RESEARCH_API_KEY", None)
        t = tpl("T-STUB-W0-V1")
        r = self.admit(registry([t]), req(t, params={"mode": "ok"}))
        self.assertEqual(drive(self, runtime.ProcessRuntime(), self.t0, r.task_id), "EVIDENCE_WRITTEN")
        d = self.cfg.runs_dir / r.task_id / "attempt-1"
        rc = json.loads((d / "receipt.json").read_text())
        for k in ("receipt", "executable", "executable_version", "argv_sha256", "home", "cwd", "path_entries", "env_allowlist",
                  "secrets_present", "mounts", "pauses", "exit", "cgroup_peak", "outputs_sha256", "commit"):
            self.assertIn(k, rc, k)
        self.assertEqual(rc["receipt"], "RUN_RECEIPT_V1")
        self.assertEqual(rc["secrets_present"], {"DEEPSEEK_RESEARCH_API_KEY": False})  # the child never sees it
        a = self.conn.execute("select receipt_sha256, exit_code from attempt").fetchone()
        self.assertEqual(a[0], __import__("hashlib").sha256((d / "receipt.json").read_bytes()).hexdigest())
        self.assertEqual(a[1], 0)
        hits = guard.scan_secrets([self.root], secret_values=[os.environ["DEEPSEEK_RESEARCH_API_KEY"]])
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()
