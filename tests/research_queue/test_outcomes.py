"""AQ-10 wait states, AQ-11 no cost-cap state, AQ-13 completion authority (core part), AQ-14 circuits."""
import datetime as dt, json, os, re, unittest
from helpers import *  # noqa

SRC = ROOT / "services" / "research-queue" / "rq"


class Probes:
    def __init__(self):
        self.balance, self.cred_fp, self.provider = False, None, False

    def balance_ok(self): return self.balance
    def credential_fingerprint(self, key_id): return self.cred_fp
    def provider_ok(self): return self.provider
    def external(self, code, task): return None


class Waits(Base):
    def setUp(self):
        super().setUp()
        self.t = tpl("T-STUB-W0-V1")
        self.reg = registry([self.t])
        self.rt = runtime.ProcessRuntime()

    def run_err(self, mode, now, subject=None):
        r = self.admit(self.reg, req(self.t, subject=subject or {"n": 1}, params={"mode": mode}), now)
        return r.task_id, drive(self, self.rt, now, r.task_id)

    def test_http_class_mapping(self):
        f = consumer.outcome_from_http
        self.assertEqual((f(401).kind, f(403).kind, f(402).kind, f(429, 30).kind), ("A", "A", "Q", "T3"))
        self.assertEqual((f(500).kind, f(503).kind, f(504).kind, f(400).kind, f(422).kind), ("T3", "T3", "T3", "D", "D"))
        self.assertEqual(f(429, 30).retry_after_s, 30)

    def test_aq10_402_waits_for_quota_never_failed_and_resumes_on_balance_flip(self):
        tid, st = self.run_err("err_Q_QUOTA_402", self.t0)
        self.assertEqual(st, "WAITING_QUOTA")
        pr = Probes()
        producer.tick(self.conn, self.cfg, self.reg, self.t0 + dt.timedelta(hours=6), pr)
        self.assertEqual(self.state(tid), "WAITING_QUOTA")
        pr.balance = True
        producer.tick(self.conn, self.cfg, self.reg, self.t0 + dt.timedelta(hours=12), pr)
        self.assertEqual(self.state(tid), "READY")

    def test_aq10_429_retry_after_sets_not_before(self):
        tid, st = self.run_err("err_T3_RATE_429", self.t0)
        self.assertEqual(st, "READY")
        self.assertGreaterEqual(self.row(tid)["not_before"], core.iso(self.t0 + dt.timedelta(seconds=60)))
        self.assertEqual(self.row(tid)["state_reason"], "T3_RETRY")

    def test_aq10_six_5xx_then_waiting_provider(self):
        r = self.admit(self.reg, req(self.t, params={"mode": "err_T3_BAD_503"}), self.t0)
        now = self.t0
        states = []
        for i in range(6):
            states.append(drive(self, self.rt, now, r.task_id))
            now += dt.timedelta(hours=2)
        self.assertEqual(states[:5], ["READY"] * 5)
        self.assertEqual(states[5], "WAITING_PROVIDER")
        pr = Probes()
        pr.provider = True
        producer.tick(self.conn, self.cfg, self.reg, now, pr)
        self.assertEqual(self.state(r.task_id), "READY")

    def test_aq10_401_waits_for_credential_one_alert_resumes_on_fingerprint_change(self):
        tid, st = self.run_err("err_A_CRED_401", self.t0)
        self.assertEqual(st, "WAITING_CREDENTIAL")
        pr = Probes()
        pr.cred_fp = None  # key file absent / unchanged
        for i in range(3):
            producer.tick(self.conn, self.cfg, self.reg, self.t0 + dt.timedelta(minutes=i), pr)
            status.write(self.conn, self.cfg, self.t0 + dt.timedelta(minutes=i))
        self.assertEqual(self.state(tid), "WAITING_CREDENTIAL")
        lines = [json.loads(l) for l in (self.cfg.state_dir / "alerts.jsonl").read_text().splitlines()]
        self.assertEqual([l["code"] for l in lines if l["code"] == "RQ_CREDENTIAL"], ["RQ_CREDENTIAL"])  # once
        pr.cred_fp = "abc123def456"
        producer.tick(self.conn, self.cfg, self.reg, self.t0 + dt.timedelta(minutes=5), pr)
        self.assertEqual(self.state(tid), "READY")

    def test_aq10_safety_and_external(self):
        tid, st = self.run_err("err_S_WRITEOUTSIDE", self.t0, {"n": 1})
        self.assertEqual(st, "SAFETY_STOP")
        core.transition(self.conn, tid, "CANCELLED", actor="coordinator", now=self.t0, reason="TEST_DONE")  # frees the host; no tie with the next task
        tid2, st2 = self.run_err("err_E_HOLDOUTINCOMPLETE", self.t0, {"n": 2})
        self.assertEqual((st2, self.row(tid2)["state_reason"]), ("WAITING_EXTERNAL", "HOLDOUT_INCOMPLETE"))

    def test_safety_stop_stops_the_host_claiming_until_coordinator_clears(self):
        tid, st = self.run_err("err_S_WRITEOUTSIDE", self.t0, {"n": 1})
        self.admit(self.reg, req(self.t, subject={"n": 2}), self.t0)
        self.assertEqual(consumer.tick(self.conn, self.cfg, self.rt, self.t0)["claimed"], [])
        with self.assertRaises(core.TransitionRefused):
            core.transition(self.conn, tid, "READY", actor="rq-consumer", now=self.t0)
        core.transition(self.conn, tid, "READY", actor="coordinator", now=self.t0, reason="CLEARED_BY_COORDINATOR")
        self.assertNotEqual(consumer.tick(self.conn, self.cfg, self.rt, self.t0)["claimed"], [])


class NoCostCap(unittest.TestCase):
    def test_aq11_no_budget_state_or_code_path(self):
        self.assertNotIn("WAITING_BUDGET", core.STATES)
        self.assertNotIn("MONTHLY_CAP", producer.EXTERNAL_CODES)
        for p in SRC.glob("*.py"):
            s = p.read_text()
            for bad in ("WAITING_BUDGET", "MONTHLY_CAP", "monthly_cap", "budget_cny"):
                self.assertNotIn(bad, s, "%s in %s" % (bad, p.name))


class CompletionAuthority(Base):
    def setUp(self):
        super().setUp()
        self.t = tpl("T-STUB-W0-V1")
        self.reg = registry([self.t])

    def evidence(self, validator_ok=True):
        r = self.admit(self.reg, req(self.t, params={"mode": "ok"}))
        drive(self, runtime.ProcessRuntime(), self.t0, r.task_id)
        if not validator_ok:
            d = self.cfg.runs_dir / r.task_id / "attempt-1" / "result.json"
            d.write_text(json.dumps({"outputs": [], "validator": {"ok": False}}))
        return r.task_id

    def test_only_rq_complete_may_write_complete(self):
        tid = self.evidence()
        self.assertEqual(self.state(tid), "EVIDENCE_WRITTEN")
        for actor in ("rq-consumer", "rq-producer", "rq-pause", "coordinator"):
            with self.assertRaises(core.TransitionRefused):
                core.transition(self.conn, tid, "COMPLETE", actor=actor, now=self.t0)
        complete.complete_self_validated(self.conn, self.cfg, tid, self.t0)
        self.assertEqual(self.state(tid), "COMPLETE")

    def test_validator_not_ok_is_blocked_not_complete(self):
        tid = self.evidence(validator_ok=False)
        complete.complete_self_validated(self.conn, self.cfg, tid, self.t0)
        self.assertEqual(self.state(tid), "BLOCKED_DETERMINISTIC")

    def test_static_only_complete_module_transitions_to_complete(self):
        for p in SRC.glob("*.py"):
            if p.name in ("complete.py", "core.py"):
                continue
            self.assertIsNone(re.search(r"transition\([^)]*['\"]COMPLETE['\"]", p.read_text(), re.S), p.name)


class Circuits(Base):
    def setUp(self):
        super().setUp()
        self.t = tpl("T-STUB-W0-V1")
        self.reg = registry([self.t])
        self.rt = runtime.ProcessRuntime()

    def test_aq14_same_d_code_twice_opens_template_circuit(self):
        for i in (1, 2):
            r = self.admit(self.reg, req(self.t, subject={"n": i}, params={"mode": "exit64"}))
            self.assertEqual(drive(self, self.rt, self.t0, r.task_id), "BLOCKED_DETERMINISTIC")
        self.assertIn("T-STUB-W0-V1", core.open_circuits(self.conn, "LINUX", self.t0)["templates"])
        r3 = self.admit(self.reg, req(self.t, subject={"n": 3}, params={"mode": "ok"}))
        self.assertEqual(consumer.tick(self.conn, self.cfg, self.rt, self.t0)["claimed"], [])
        self.assertEqual(self.state(r3.task_id), "READY")
        core.reset_circuit(self.conn, "T-STUB-W0-V1", actor="coordinator", now=self.t0)
        self.assertEqual(core.open_circuits(self.conn, "LINUX", self.t0)["templates"], {})

    def test_two_different_d_codes_do_not_open_it(self):
        r = self.admit(self.reg, req(self.t, subject={"n": 1}, params={"mode": "exit64"}))
        drive(self, self.rt, self.t0, r.task_id)
        r = self.admit(self.reg, req(self.t, subject={"n": 2}, params={"mode": "fail1"}))
        drive(self, self.rt, self.t0, r.task_id)
        self.assertEqual(core.open_circuits(self.conn, "LINUX", self.t0)["templates"], {})

    def test_host_circuit_after_three_t1_in_an_hour(self):
        t = tpl("T-STUB-W0-V1", transient_budget=9)
        r = self.admit(registry([t]), req(t, params={"mode": "sleep"}))
        for i in range(3):
            core.insert_event(self.conn, r.task_id, self.t0 + dt.timedelta(minutes=i), "rq-consumer", "RUNNING", "READY", "T1_INTERRUPTED", {})
        self.assertIsNotNone(core.open_circuits(self.conn, "LINUX", self.t0 + dt.timedelta(minutes=10))["host"])
        self.assertIsNone(core.open_circuits(self.conn, "LINUX", self.t0 + dt.timedelta(minutes=90))["host"])


if __name__ == "__main__":
    unittest.main()
