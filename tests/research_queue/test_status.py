"""AQ-20 visibility, AQ-21 secrets scan, AQ-27 environment parity, per-key month spend view (status side of AQ-31)."""
import datetime as dt, json, os, pathlib, sqlite3, subprocess, sys, unittest
from unittest import mock
from helpers import *  # noqa


class Status(Base):
    def setUp(self):
        super().setUp()
        self.t = tpl("T-STUB-W0-V1")
        self.reg = registry([self.t])

    def test_status_counts_oldest_age_and_heartbeat(self):
        for i in range(3):
            self.admit(self.reg, req(self.t, subject={"n": i}))
        s = status.build(self.conn, self.cfg, self.t0 + dt.timedelta(hours=2))
        self.assertEqual(s["schema"], "RQ_STATUS_V1")
        self.assertEqual(s["counts"]["READY"], 3)
        self.assertEqual(s["oldest_age_s"]["READY"], 7200)
        self.assertIn("circuits", s)
        self.assertIn("pauses", s)
        self.assertIn("spend", s)
        status.write(self.conn, self.cfg, self.t0)
        self.assertEqual(json.loads(self.cfg.status_path.read_text())["counts"]["READY"], 3)

    def test_task_view_is_closed_ordered_authoritative_and_does_not_read_results(self):
        requests = [
            req(self.t, subject={"n": "second"}),
            req(self.t, subject={"n": "first"}),
        ]
        admitted = [self.admit(self.reg, request) for request in requests]
        claimed = core.claim(self.conn, host="LINUX", worker="w", now=self.t0)
        self.assertEqual(claimed["task_id"], admitted[0].task_id)

        attempt_dir = self.cfg.runs_dir / claimed["task_id"] / "attempt-1"
        attempt_dir.mkdir(parents=True)
        result_path = attempt_dir / "result.json"
        secret_marker = "sk-" + "ResultMustNotLeak1234"
        result_path.write_text("not-json " + secret_marker)

        original_read_text = pathlib.Path.read_text

        def refuse_result_read(path, *args, **kwargs):
            if path.name == "result.json":
                raise AssertionError("rq status must not read attempt results")
            return original_read_text(path, *args, **kwargs)

        with mock.patch.object(pathlib.Path, "read_text", refuse_result_read):
            built = status.build(self.conn, self.cfg, self.t0)

        rows = built["tasks"]
        self.assertEqual([row["task_id"] for row in rows], sorted(r.task_id for r in admitted))
        self.assertTrue(all(set(row) == {"task_id", "idem_key", "state", "attempt_no"} for row in rows))
        self.assertNotIn(secret_marker, json.dumps(built, sort_keys=True))

        by_id = {row["task_id"]: row for row in rows}
        for request, result in zip(requests, admitted):
            expected_idem = core.sha256_hex(core.canonical({
                "template_id": request["template_id"],
                "template_sha256": request["template_sha256"],
                "subject": request["subject"],
                "params": request["params"],
            }))
            self.assertEqual(by_id[result.task_id]["idem_key"], expected_idem)
        self.assertEqual(by_id[admitted[0].task_id]["state"], "CLAIMED")
        self.assertEqual(by_id[admitted[0].task_id]["attempt_no"], 1)
        self.assertEqual(by_id[admitted[1].task_id]["state"], "READY")
        self.assertEqual(by_id[admitted[1].task_id]["attempt_no"], 0)

        legacy_keys = {
            "schema", "host", "at", "counts", "oldest_age_s", "sla_breaches",
            "consumer_heartbeat", "pauses", "circuits", "event_head", "spend",
            "alerts", "revision_skipped",
        }
        self.assertEqual(set(built) - {"tasks"}, legacy_keys)

    def test_aq20_stuck_task_raises_rq_stuck_dry_run(self):
        r = self.admit(self.reg, req(self.t))
        c = core.claim(self.conn, host="LINUX", worker="w", now=self.t0)
        core.transition(self.conn, r.task_id, "RUNNING", actor="rq-consumer", now=self.t0, token=c["lease_token"])
        s = status.build(self.conn, self.cfg, self.t0 + dt.timedelta(hours=2))
        codes = {a["code"]: a for a in s["alerts"]}
        self.assertIn("RQ_STUCK", codes)
        self.assertEqual(codes["RQ_STUCK"]["priority"], "P2")
        self.assertTrue(codes["RQ_STUCK"]["dry_run"])
        self.assertIn(r.task_id, codes["RQ_STUCK"]["tasks"])

    def test_aq20_consumer_down_after_15_minutes(self):
        status.touch_consumer_heartbeat(self.cfg, self.t0)
        up = status.build(self.conn, self.cfg, self.t0 + dt.timedelta(minutes=14))
        self.assertNotIn("RQ_CONSUMER_DOWN", [a["code"] for a in up["alerts"]])
        down = status.build(self.conn, self.cfg, self.t0 + dt.timedelta(minutes=16))
        a = [a for a in down["alerts"] if a["code"] == "RQ_CONSUMER_DOWN"][0]
        self.assertEqual(a["priority"], "P1")

    def test_other_alert_codes_and_priorities(self):
        ids = {}
        for i, st in enumerate(("BLOCKED_DETERMINISTIC", "SAFETY_STOP", "CHECK_HOLD")):
            r = self.admit(self.reg, req(self.t, subject={"n": i}))
            self.conn.execute("update task set state=? where task_id=?", (st, r.task_id))
            ids[st] = r.task_id
        a = {x["code"]: x["priority"] for x in status.build(self.conn, self.cfg, self.t0)["alerts"]}
        self.assertEqual((a["RQ_BLOCKED_DETERMINISTIC"], a["RQ_SAFETY_STOP"], a["RQ_HOLD"]), ("P2", "P1", "digest"))

    def test_month_spend_per_key_from_the_gateway_ledger(self):
        db = self.root / "gateway.sqlite"
        c = sqlite3.connect(db)
        c.execute("create table call (call_id text primary key, at text, key_id text, key_fp12 text, purpose text, task_id text, model text, peak integer, http_status integer,"
                  " prompt_cache_hit_tokens integer, prompt_cache_miss_tokens integer, completion_tokens integer, reasoning_tokens integer, price_table text, cny real, usd real, request_sha256 text)")
        rows = [("c1", "2026-11-03T10:00:00+08:00", "LINUX_RESEARCH", "a" * 12, "RQ_AGENT", 1.25, 0.2), ("c2", "2026-11-30T23:59:00+08:00", "LINUX_RESEARCH", "a" * 12, "MINING_LLM", 2.0, 0.3),
                ("c3", "2026-12-01T00:00:00+08:00", "LINUX_RESEARCH", "a" * 12, "RQ_AGENT", 9.0, 1.0), ("c4", "2026-11-05T10:00:00+08:00", "HK_REVIEW", "b" * 12, "RQ_AGENT", 0.5, 0.07)]
        for i, (cid, at_, k, fp, pur, cny, usd) in enumerate(rows):
            c.execute("insert into call values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (cid, at_, k, fp, pur, None, "m", 0, 200, 0, 0, 0, 0, "P1", cny, usd, "r"))
        c.commit()
        c.close()
        sp = status.month_spend(db, dt.datetime(2026, 11, 15, tzinfo=CST))
        self.assertEqual(sp["month"], "2026-11")
        self.assertAlmostEqual(sp["keys"]["LINUX_RESEARCH"]["cny"], 3.25)
        self.assertAlmostEqual(sp["keys"]["LINUX_RESEARCH"]["by_purpose"]["MINING_LLM"]["cny"], 2.0)
        self.assertAlmostEqual(sp["keys"]["HK_REVIEW"]["cny"], 0.5)
        self.assertEqual(status.month_spend(self.root / "absent.sqlite", self.t0), {"month": "2026-11", "keys": {}, "ledger": "ABSENT"})
        self.cfg.gateway_db = db
        s = status.build(self.conn, self.cfg, dt.datetime(2026, 11, 15, tzinfo=CST))
        self.assertAlmostEqual(s["spend"]["keys"]["LINUX_RESEARCH"]["cny"], 3.25)
        self.assertNotIn("key_fp12_full", json.dumps(s))


class Secrets(unittest.TestCase):
    def test_aq21_scan_finds_keys_and_given_values(self):
        import tempfile, pathlib
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            (d / "ok.log").write_text("nothing here sk-short")
            self.assertEqual(guard.scan_secrets([d]), [])
            (d / "bad.log").write_text("x sk-" + "Ab12" * 6)
            (d / "val.txt").write_text("hunter2-secret-value")
            hits = guard.scan_secrets([d], secret_values=["hunter2-secret-value"])
            self.assertEqual(sorted(h["file"].split("/")[-1] for h in hits), ["bad.log", "val.txt"])
            self.assertNotIn("Ab12" * 6, json.dumps(hits))  # the hit report never repeats the secret


class Environment(Base):
    def manifest(self):
        return config.build_manifest(self.cfg)

    def test_aq27_matching_environment_passes(self):
        self.assertEqual(config.verify_environment(self.manifest(), self.cfg), [])

    def test_aq27_each_mismatch_is_refused(self):
        m = self.manifest()
        for key, val in (("host_role", "HK"), ("python_major_minor", "2.7"), ("home", "/nope"), ("user", "nobody"),
                         ("executable", "/usr/bin/other-python"), ("schema_sha256", "0" * 64), ("code_sha256", "0" * 64)):
            bad = dict(m, **{key: val})
            errs = config.verify_environment(bad, self.cfg)
            self.assertTrue(any(key in e for e in errs), key)

    def test_aq27_start_refuses_on_mismatch(self):
        import config_helper
        m = self.manifest()
        m["host_role"] = "HK"
        mp = self.root / "manifest.json"
        mp.write_text(json.dumps(m))
        p = config_helper.write(self.cfg, self.root, install_manifest=str(mp))
        env = dict(os.environ, PYTHONPATH=str(ROOT / "services" / "research-queue"))
        r = subprocess.run([PY, "-m", "rq", "--config", str(p), "consumer-run", "--once"], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 78)
        self.assertIn("ENV_MISMATCH", r.stderr)


class Bundles(unittest.TestCase):
    def test_bundle_verify(self):
        import tempfile, pathlib
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            (d / "HK-T1.json").write_text("abc")
            self.assertTrue(core.verify_bundle(d, {"host": "HK", "task_id": "T1", "bundle_sha256": sha("abc")}))
            self.assertFalse(core.verify_bundle(d, {"host": "HK", "task_id": "T1", "bundle_sha256": sha("abd")}))
            self.assertFalse(core.verify_bundle(d, {"host": "HK", "task_id": "T2", "bundle_sha256": sha("abc")}))
            self.assertFalse(core.verify_bundle(d, {"host": "HK", "task_id": "../x", "bundle_sha256": sha("abc")}))


if __name__ == "__main__":
    unittest.main()
