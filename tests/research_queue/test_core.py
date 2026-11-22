"""AQ-01 schema, AQ-02 atomic claim, AQ-03 idempotency, AQ-26 restart, AQ-28 event chain."""
import datetime as dt, json, multiprocessing as mp, os, sqlite3, tempfile, unittest
from helpers import *  # noqa


def _worker(db, out):
    conn = core.connect(db)
    ids = []
    while True:
        c = core.claim(conn, host="LINUX", worker="w%d" % os.getpid(), now=at(10), slots=False)
        if c is None:
            break
        ids.append(c["task_id"])
    json.dump(ids, open(out, "w"))


class Schema(Base):
    def test_aq01_schema(self):
        tables = {r[0] for r in self.conn.execute("select name from sqlite_master where type='table'")}
        self.assertTrue({"task", "attempt", "event"} <= tables)
        self.assertEqual(self.conn.execute("pragma integrity_check").fetchone()[0], "ok")
        self.assertEqual(self.conn.execute("pragma journal_mode").fetchone()[0], "wal")
        self.assertEqual(self.conn.execute("pragma synchronous").fetchone()[0], 2)  # FULL
        doc = (ROOT / "docs/contracts/RESEARCH_QUEUE_V1.md").read_text()
        self.assertIn("schema.sql sha256: " + core.schema_sha256(), doc)
        core.migrate(self.conn)  # idempotent

    def test_aq01_altered_schema_refused(self):
        p = self.root / "other.sqlite"
        c = sqlite3.connect(p)
        c.execute("create table task(task_id text)")
        c.commit()
        c.close()
        with self.assertRaises(core.SchemaMismatch):
            core.migrate(core.connect(p))


class AtomicClaim(Base):
    def test_aq02_no_double_claim_20_runs(self):
        reg = registry([tpl("T-STUB-W0-V1")])
        ctx = mp.get_context("fork")
        for run in range(20):
            db = self.root / ("run%d.sqlite" % run)
            conn = core.connect(db)
            core.migrate(conn)
            for i in range(200):
                r = producer.admit(conn, self.cfg, reg, req(tpl("T-STUB-W0-V1"), subject={"n": i}), at(10))
                self.assertEqual(r.state, "READY")
            conn.close()
            outs = [str(self.root / ("o%d_%d.json" % (run, k))) for k in range(8)]
            procs = [ctx.Process(target=_worker, args=(str(db), o)) for o in outs]
            [p.start() for p in procs]
            [p.join(120) for p in procs]
            self.assertTrue(all(p.exitcode == 0 for p in procs))
            claimed = [i for o in outs for i in json.load(open(o))]
            self.assertEqual(len(claimed), 200, "run %d" % run)
            self.assertEqual(len(set(claimed)), 200, "double claim in run %d" % run)

    def test_claim_respects_not_before_priority_and_slots(self):
        reg = registry([tpl("T-STUB-W0-V1")])
        a = self.admit(reg, req(tpl("T-STUB-W0-V1"), subject={"n": 1}, priority=60))
        b = self.admit(reg, req(tpl("T-STUB-W0-V1"), subject={"n": 2}, priority=10))
        c = self.admit(reg, req(tpl("T-STUB-W0-V1"), subject={"n": 3}, not_before=core.iso(self.t0 + dt.timedelta(hours=2))))
        first = core.claim(self.conn, host="LINUX", worker="w", now=self.t0)
        self.assertEqual(first["task_id"], b.task_id)  # lowest priority number first
        # one light slot on LINUX: the next claim waits until the first leaves CLAIMED/RUNNING/PAUSED
        self.assertIsNone(core.claim(self.conn, host="LINUX", worker="w", now=self.t0))
        core.transition(self.conn, b.task_id, "RUNNING", actor="rq-consumer", now=self.t0, token=first["lease_token"])
        self.assertIsNone(core.claim(self.conn, host="LINUX", worker="w", now=self.t0))
        core.transition(self.conn, b.task_id, "EVIDENCE_WRITTEN", actor="rq-consumer", now=self.t0, token=first["lease_token"])
        second = core.claim(self.conn, host="LINUX", worker="w", now=self.t0)
        self.assertEqual(second["task_id"], a.task_id)  # c is not_before t0+2h
        self.assertEqual(self.state(c.task_id), "READY")

    def test_claim_order_is_deterministic_for_equal_priority_and_time(self):
        reg = registry([tpl("T-STUB-W0-V1")])
        ids = [self.admit(reg, req(tpl("T-STUB-W0-V1"), subject={"n": i})).task_id for i in range(12)]
        got = []
        for _ in ids:
            c = core.claim(self.conn, host="LINUX", worker="w", now=self.t0, slots=False)
            got.append(c["task_id"])
        self.assertEqual(got, ids)  # admission order, not task-id order

    def test_dependencies_gate_claim(self):
        reg = registry([tpl("T-STUB-W0-V1")])
        a = self.admit(reg, req(tpl("T-STUB-W0-V1"), subject={"n": 1}))
        b = self.admit(reg, req(tpl("T-STUB-W0-V1"), subject={"n": 2}, depends_on=[a.task_id], priority=1))
        c1 = core.claim(self.conn, host="LINUX", worker="w", now=self.t0, slots=False)
        self.assertEqual(c1["task_id"], a.task_id)  # b has the better priority but depends on a
        self.assertIsNone(core.claim(self.conn, host="LINUX", worker="w", now=self.t0, slots=False))

    def test_net_task_is_claimed_on_agent_host_only(self):
        t = net_tpl()
        reg = registry([t])
        r = self.admit(reg, req(t, market="CN_A", params={"mode": "ok"}))
        self.assertEqual(r.state, "READY")
        self.assertIsNone(core.claim(self.conn, host="HK", worker="w", now=self.t0))
        self.assertIsNotNone(core.claim(self.conn, host="LINUX", worker="w", now=self.t0))


class Idempotency(Base):
    def test_aq03_same_admission_one_row_other_sha_conflict(self):
        t = tpl("T-STUB-W0-V1")
        reg = registry([t])
        r1 = self.admit(reg, req(t))
        r2 = self.admit(reg, req(t))
        self.assertTrue(r1.created and not r2.created)
        self.assertEqual(r1.task_id, r2.task_id)
        self.assertEqual(self.conn.execute("select count(*) from task").fetchone()[0], 1)
        other = self.admit(reg, req(t, inputs=[{"path": "x", "sha256": "0" * 64}]))
        self.assertEqual(other.code, "IDEM_CONFLICT")
        self.assertEqual(self.conn.execute("select count(*) from task").fetchone()[0], 1)

    def test_task_id_format(self):
        t = tpl("T-STUB-W0-V1")
        r = self.admit(registry([t]), req(t))
        self.assertRegex(r.task_id, r"^RQT-LINUX-20261128-[0-9a-f]{8}$")


class EventChain(Base):
    def test_aq28_chain_verifies_and_edits_break_it(self):
        t = tpl("T-STUB-W0-V1")
        for i in range(3):
            self.admit(registry([t]), req(t, subject={"n": i}))
        ok, bad = core.verify_chain(self.conn)
        self.assertTrue(ok)
        self.assertGreaterEqual(self.conn.execute("select count(*) from event").fetchone()[0], 9)
        self.conn.execute("update event set reason_code='TAMPERED' where seq=2")
        ok, bad = core.verify_chain(self.conn)
        self.assertFalse(ok)
        self.assertEqual(bad, 2)
        self.conn.execute("update event set reason_code=(select reason_code from event where seq=1) where seq=2")

    def test_aq28_deleted_row_breaks_chain(self):
        t = tpl("T-STUB-W0-V1")
        self.admit(registry([t]), req(t))
        self.conn.execute("delete from event where seq=2")
        self.assertFalse(core.verify_chain(self.conn)[0])

    def test_state_change_and_event_in_same_transaction(self):
        t = tpl("T-STUB-W0-V1")
        r = self.admit(registry([t]), req(t))
        n = self.conn.execute("select count(*) from event").fetchone()[0]
        with self.assertRaises(core.TransitionRefused):
            core.transition(self.conn, r.task_id, "COMPLETE", actor="rq-consumer", now=self.t0)
        self.assertEqual(self.conn.execute("select count(*) from event").fetchone()[0], n)
        self.assertEqual(self.state(r.task_id), "READY")


class Restart(Base):
    def test_aq26_restart_recovers_state_without_duplicates(self):
        t = tpl("T-STUB-W0-V1")
        reg = registry([t])
        inbox = self.cfg.inbox_dir / "requests"
        inbox.mkdir(parents=True)
        for i in range(3):
            (inbox / ("r%d.json" % i)).write_text(json.dumps(req(t, subject={"n": i})))
        producer.tick(self.conn, self.cfg, reg, self.t0)
        self.conn.close()
        conn2 = core.connect(self.cfg.db_path)
        core.migrate(conn2)
        producer.tick(conn2, self.cfg, reg, self.t0)
        self.assertEqual(conn2.execute("select count(*) from task").fetchone()[0], 3)
        self.assertTrue(core.verify_chain(conn2)[0])


if __name__ == "__main__":
    unittest.main()
