"""AQ-08 window pause, AQ-09 cutover blackout, brakes. Stub clock, stub systemctl/docker; nothing real is touched."""
import datetime as dt, json, os, unittest
from helpers import *  # noqa


class Recorder:
    def __init__(self, ps=""):
        self.calls, self.ps = [], ps

    def __call__(self, argv):
        self.calls.append(list(argv))
        if argv[:2] == ["docker", "ps"]:
            return 0, self.ps
        return 0, ""


class Sensors:
    def __init__(self, **kw):
        self.v = dict(mem_gib=64.0, load5=0.5, nvme_await_ms=2.0, lane1_free_gib=800.0, disk_free_gib=40.0, pm2_restart=False)
        self.v.update(kw)

    def mem_available_gib(self): return self.v["mem_gib"]
    def load5(self): return self.v["load5"]
    def nvme_read_await_ms_20min(self): return self.v["nvme_await_ms"]
    def lane1_free_gib(self): return self.v["lane1_free_gib"]
    def disk_free_gib(self): return self.v["disk_free_gib"]
    def pm2_recent_restart(self): return self.v["pm2_restart"]


class Windows(unittest.TestCase):
    def test_aq08_linux_window_edges(self):
        f = lambda h, m, **k: pause.window_reason("LINUX", at(h, m, **k), io=False)
        # Tuesday 11-24
        for h, m, inside in [(6, 29, False), (6, 30, True), (7, 59, True), (8, 0, False), (9, 14, False), (9, 15, True),
                             (15, 29, True), (15, 30, False), (18, 9, False), (18, 10, True), (21, 29, True), (21, 30, False)]:
            self.assertEqual(f(h, m) is not None, inside, "%02d:%02d" % (h, m))
        self.assertIsNone(pause.window_reason("LINUX", at(10, 0, day=28), io=False))  # Saturday
        self.assertIsNone(pause.window_reason("LINUX", at(10, 0, day=29), io=False))  # Sunday

    def test_aq08_io_tasks_also_yield_00_15_to_01_15(self):
        self.assertIsNotNone(pause.window_reason("LINUX", at(0, 15), io=True))
        self.assertIsNone(pause.window_reason("LINUX", at(0, 15), io=False))
        self.assertIsNone(pause.window_reason("LINUX", at(1, 15), io=True))

    def test_aq08_hk_net_window(self):
        f = lambda h, m, **k: pause.window_reason("HK", at(h, m, **k), io=False)
        for h, m, run in [(10, 44, False), (10, 45, True), (21, 44, True), (21, 45, False), (22, 30, False), (3, 0, False),
                          (5, 40, False), (7, 10, False), (9, 25, False), (9, 55, False)]:
            self.assertEqual(f(h, m) is None, run, "%02d:%02d" % (h, m))
        self.assertIsNone(f(12, 0, day=28))  # weekend runs in the same window
        self.assertIsNotNone(pause.window_reason("HK", at(10, 0, day=23), io=False))  # Mon 09:55-10:45 stays denied


class Blackouts(unittest.TestCase):
    def test_aq09_entries_block_and_freeze_or_stop(self):
        bl = pause.parse_blackouts({"entries": [
            {"id": "CUTOVER", "start": "2026-11-29T00:30:00+08:00", "end": "2026-11-29T04:00:00+08:00", "hosts": ["LINUX"], "mode": "STOP"},
            {"id": "T0COPY", "start": "2026-11-23T20:45:00+08:00", "end": "2026-11-24T06:30:00+08:00", "hosts": ["LINUX"], "mode": "FREEZE"}]})
        a = pause.blackout_at(bl, "LINUX", at(1, 35, day=29))
        self.assertEqual((a.id, a.mode), ("CUTOVER", "STOP"))
        self.assertIsNone(pause.blackout_at(bl, "LINUX", at(4, 0, day=29)))
        self.assertIsNone(pause.blackout_at(bl, "HK", at(1, 35, day=29)))
        self.assertEqual(pause.blackout_at(bl, "LINUX", at(23, 0, day=23)).mode, "FREEZE")
        with self.assertRaises(ValueError):
            pause.parse_blackouts({"entries": [{"id": "x", "start": "bad", "end": "bad", "hosts": ["LINUX"], "mode": "STOP"}]})


class Brakes(unittest.TestCase):
    def test_linux_brakes_by_class(self):
        st = {}
        b = pause.evaluate_brakes("LINUX", Sensors(nvme_await_ms=12.0), st, at(16, 0))
        self.assertEqual(b["IO_AWAIT"], "TRIPPED")
        b = pause.evaluate_brakes("LINUX", Sensors(mem_gib=10.0), st, at(16, 0))
        self.assertEqual(b["MEM"], "TRIPPED")
        b = pause.evaluate_brakes("LINUX", Sensors(lane1_free_gib=150.0), st, at(16, 0))
        self.assertEqual(b["LANE1_FREE"], "TRIPPED")
        b = pause.evaluate_brakes("LINUX", Sensors(nvme_await_ms=None), st, at(16, 0))
        self.assertEqual(b["IO_AWAIT"], "UNKNOWN")  # unknown is its own state, not CLEAR
        self.assertEqual(pause.evaluate_brakes("LINUX", Sensors(), st, at(16, 0)), {"IO_AWAIT": "CLEAR", "MEM": "CLEAR", "LANE1_FREE": "CLEAR"})

    def test_hk_brakes_resume_after_ten_clear_minutes(self):
        st = {}
        for kw in ({"load5": 3.1}, {"mem_gib": 1.4}, {"pm2_restart": True}, {"disk_free_gib": 19.0}):
            b = pause.evaluate_brakes("HK", Sensors(**kw), {}, at(12, 0))
            self.assertIn("TRIPPED", b.values(), kw)
        pause.evaluate_brakes("HK", Sensors(load5=3.5), st, at(12, 0))
        b = pause.evaluate_brakes("HK", Sensors(), st, at(12, 5))
        self.assertIn("TRIPPED", b.values())  # clear for only 0 minutes
        b = pause.evaluate_brakes("HK", Sensors(), st, at(12, 16))
        self.assertNotIn("TRIPPED", b.values())

    def test_brake_applies_by_task_class(self):
        brakes = {"IO_AWAIT": "TRIPPED", "MEM": "CLEAR", "LANE1_FREE": "CLEAR"}
        io = {"io_class": "LANE1_DB", "weight_class": "W1"}
        w2 = {"io_class": "NONE", "weight_class": "W2"}
        none = {"io_class": "NONE", "weight_class": "W0"}
        self.assertIsNotNone(pause.pause_reason("LINUX", io, at(16, 0), [], brakes))
        self.assertIsNone(pause.pause_reason("LINUX", none, at(16, 0), [], brakes))
        self.assertIsNone(pause.pause_reason("LINUX", w2, at(16, 0), [], brakes))
        brakes["MEM"] = "TRIPPED"
        self.assertIsNotNone(pause.pause_reason("LINUX", w2, at(16, 0), [], brakes))


class Names(unittest.TestCase):
    def test_aq08_only_allowlisted_names(self):
        ok = [("unit", "rq-task-RQT-LINUX-1.service"), ("unit", "rq-agent-x.service"), ("docker", "rq-task-1"), ("docker", "rf1116-generate-20261117"),
              ("docker", "rf1116-resume"), ("docker", "rf1116-score"), ("docker", "rf1116-rescore")]
        for k, n in ok:
            self.assertTrue(pause.allowed_target("LINUX", k, n), n)
        bad = [("docker", "rf1116-mechanisms"), ("docker", "rf1116-review"), ("unit", "ashare-v6-scheduler.service"), ("docker", "ashare-v6-x"),
               ("unit", "c3fwd-job.service"), ("docker", "q73-run"), ("docker", "postgres-1"), ("unit", "pm2-root.service"),
               ("unit", "portfolio-desk-web.service"), ("unit", "rq-task-x.service; reboot"), ("docker", "rq-task-../x")]
        for k, n in bad:
            self.assertFalse(pause.allowed_target("LINUX", k, n), n)
        self.assertFalse(pause.allowed_target("HK", "docker", "rf1116-score"))  # rf1116 names exist on Linux only
        self.assertTrue(pause.allowed_target("HK", "unit", "rq-consumer.service"))
        p = pause.Pauser(Recorder(), "LINUX")
        with self.assertRaises(ValueError):
            p.freeze("unit", "ashare-v6-scheduler.service")


class Tick(Base):
    def setUp(self):
        super().setUp()
        self.t = tpl("T-STUB-W0-V1")
        self.reg = registry([self.t])
        os.environ["STUB_SLEEP"] = "20"
        self.addCleanup(os.environ.pop, "STUB_SLEEP", None)
        self.rt = runtime.ProcessRuntime()
        self.addCleanup(self.rt.stop_all)

    def run_one(self):
        r = self.admit(self.reg, req(self.t, params={"mode": "sleep"}))
        consumer.tick(self.conn, self.cfg, self.rt, self.t0)
        self.assertEqual(self.state(r.task_id), "RUNNING")
        return r.task_id

    def test_aq08_pause_in_window_thaw_outside_lease_never_expires(self):
        tid = self.run_one()
        rec = Recorder()
        pauser = pause.Pauser(rec, "LINUX")
        st = self.cfg.state_dir / "pause-state.json"
        now = at(9, 14)
        for minute in range(0, 6 * 60 + 30):  # 09:14 .. 15:44, every minute
            n = now + dt.timedelta(minutes=minute)
            pause.tick(self.conn, self.cfg, n, pauser, Sensors(), [], st)
            row = self.row(tid)
            if n >= at(9, 15) and n < at(15, 30):
                self.assertEqual(row["state"], "PAUSED", n)
                self.assertGreater(row["lease_expires_at"], core.iso(n), "lease expired while paused at %s" % n)
            else:
                self.assertEqual(row["state"], "RUNNING", n)
        verbs = [c for c in rec.calls if c[0] == "systemctl"]
        self.assertEqual([c[2] for c in verbs], ["freeze", "thaw"])
        self.assertTrue(all(c[1] == "--user" for c in verbs))
        events = [r[0] for r in self.conn.execute("select to_state from event where task_id=? order by seq", (tid,))]
        self.assertIn("PAUSED", events)

    def test_reaper_does_not_touch_paused_task(self):
        tid = self.run_one()
        pauser = pause.Pauser(Recorder(), "LINUX")
        pause.tick(self.conn, self.cfg, at(10, 0), pauser, Sensors(), [], self.cfg.state_dir / "pause-state.json")
        self.assertEqual(self.state(tid), "PAUSED")
        s = consumer.tick(self.conn, self.cfg, self.rt, at(10, 0) + dt.timedelta(hours=3))
        self.assertEqual((s["adopted"], s["requeued"]), ([], []))
        self.assertEqual(self.state(tid), "PAUSED")

    def test_aq08_rf1116_containers_paused_in_window_and_only_those(self):
        ps = "rf1116-generate-20261117 running;rf1116-mechanisms running;rf1116-score running;ashare-v6-x running;rf1116-resume paused"
        rec = Recorder(ps)
        pauser = pause.Pauser(rec, "LINUX")
        pause.tick(self.conn, self.cfg, at(10, 0), pauser, Sensors(), [], self.cfg.state_dir / "pause-state.json")
        docker = sorted(" ".join(c[:3]) for c in rec.calls if c[0] == "docker" and c[1] != "ps")
        self.assertEqual(docker, ["docker pause rf1116-generate-20261117", "docker pause rf1116-score"])
        rec2 = Recorder(ps)
        pause.tick(self.conn, self.cfg, at(16, 0), pause.Pauser(rec2, "LINUX"), Sensors(), [], self.cfg.state_dir / "pause-state.json")
        docker = sorted(" ".join(c[:3]) for c in rec2.calls if c[0] == "docker" and c[1] != "ps")
        self.assertEqual(docker, ["docker unpause rf1116-resume"])

    def test_aq09_blackout_no_claims_and_stop_requeues_after(self):
        bl = pause.parse_blackouts({"entries": [{"id": "CUTOVER", "start": core.iso(at(16, 30)), "end": core.iso(at(17, 30)), "hosts": ["LINUX"], "mode": "STOP"}]})
        tid = self.run_one()
        rec = Recorder()
        pause.tick(self.conn, self.cfg, at(16, 31), pause.Pauser(rec, "LINUX"), Sensors(), bl, self.cfg.state_dir / "pause-state.json", runtime=self.rt)
        self.assertEqual(self.state(tid), "READY")
        self.assertEqual(self.row(tid)["state_reason"], "BLACKOUT_STOP:CUTOVER")
        self.assertGreaterEqual(self.row(tid)["not_before"], core.iso(at(17, 30)))
        self.admit(self.reg, req(self.t, subject={"n": 9}))
        self.assertEqual(consumer.tick(self.conn, self.cfg, self.rt, at(17, 0), blackouts=bl)["claimed"], [])
        self.assertEqual(consumer.tick(self.conn, self.cfg, self.rt, at(17, 29), blackouts=bl)["claimed"], [])
        self.assertNotEqual(consumer.tick(self.conn, self.cfg, self.rt, at(17, 31), blackouts=bl)["claimed"], [])

    def test_consumer_does_not_claim_inside_a_window(self):
        self.admit(self.reg, req(self.t))
        self.assertEqual(consumer.tick(self.conn, self.cfg, self.rt, at(10, 0))["claimed"], [])
        self.assertNotEqual(consumer.tick(self.conn, self.cfg, self.rt, at(16, 0))["claimed"], [])


class HKPause(Base):
    host = "HK"

    def test_hk_pause_freezes_consumer_unit_after_writing_paused(self):
        t = net_tpl()
        reg = registry([t])
        r = self.admit(reg, req(t, market="US_EQUITY", params={"mode": "sleep"}), at(11, 0))
        rt = runtime.ProcessRuntime()
        self.addCleanup(rt.stop_all)
        os.environ["STUB_SLEEP"] = "20"
        self.addCleanup(os.environ.pop, "STUB_SLEEP", None)
        consumer.tick(self.conn, self.cfg, rt, at(11, 0))
        self.assertEqual(self.state(r.task_id), "RUNNING")
        order = []

        def run(argv):
            order.append((argv, self.state(r.task_id)))
            return 0, ""

        pause.tick(self.conn, self.cfg, at(11, 1), pause.Pauser(run, "HK"), Sensors(load5=4.0), [], self.cfg.state_dir / "pause-state.json")
        self.assertEqual(order[0][0], ["systemctl", "freeze", "rq-consumer.service"])
        self.assertEqual(order[0][1], "PAUSED")  # PAUSED and the lease are written before the freeze
        self.assertGreater(self.row(r.task_id)["lease_expires_at"], core.iso(at(11, 1)))


if __name__ == "__main__":
    unittest.main()
