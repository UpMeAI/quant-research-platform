"""AQ-16 template guards, AQ-18/19 HK scope, AQ-22 path guards, AQ-24/25 static guards, AQ-36 host routing, producer intake."""
import json, re, unittest
from helpers import *  # noqa

SRC = ROOT / "services" / "research-queue" / "rq"


class Guards(Base):
    def test_aq16_unfrozen_template_refused(self):
        t = tpl("T-STUB-W0-V1")
        r = self.admit(registry([t], pin=False), req(t))
        self.assertEqual((r.state, r.code), ("REFUSED_ADMISSION", "TEMPLATE_NOT_FROZEN"))
        # once the template is pinned the same request is admitted as a new task
        r2 = self.admit(registry([t]), req(t))
        self.assertEqual(r2.state, "READY")
        self.assertNotEqual(r.task_id, r2.task_id)

    def test_aq16_changed_template_sha_is_not_frozen(self):
        t = tpl("T-STUB-W0-V1")
        reg = registry([t])
        r = self.admit(reg, req(t, template_sha256="0" * 64))
        self.assertEqual(r.code, "TEMPLATE_NOT_FROZEN")
        r = self.admit(reg, req("T-NO-SUCH-V1"))
        self.assertEqual(r.code, "TEMPLATE_NOT_FROZEN")

    def test_aq16_argv_outside_allowlist(self):
        t = tpl("T-STUB-W0-V1")
        reg = registry([t])
        self.assertEqual(self.admit(reg, req(t, argv=["/bin/sh", "-c", "id"])).code, "ARGV_NOT_ALLOWED")
        self.assertEqual(self.admit(reg, req(t, subject={"n": 2}, params={"mode": "ok; reboot"})).code, "PARAM_NOT_ALLOWED")
        self.assertEqual(self.admit(reg, req(t, subject={"n": 3}, params={"mode": "ok", "extra": "1"})).code, "PARAM_NOT_ALLOWED")
        ok = self.admit(reg, req(t, subject={"n": 4}, argv=[PY, STUB, "ok"]))
        self.assertEqual(ok.state, "READY")
        self.assertEqual(json.loads(self.row(ok.task_id)["admission_json"])["derived"]["argv"], [PY, STUB, "ok"])

    def test_aq16_input_sha_mismatch_and_source_allowlist(self):
        f = self.root / "inputs" / "pack.json"
        f.parent.mkdir()
        f.write_text("{}")
        t = tpl("T-STUB-W0-V1", inputs=[{"prefix": str(self.root / "inputs")}])
        reg = registry([t])
        good = {"path": str(f), "sha256": sha("{}")}
        self.assertEqual(self.admit(reg, req(t, inputs=[good])).state, "READY")
        bad = {"path": str(f), "sha256": "0" * 64}
        self.assertEqual(self.admit(reg, req(t, subject={"n": 2}, inputs=[bad])).code, "INPUT_SHA_MISMATCH")
        other = {"path": "/etc/hosts", "sha256": "0" * 64}
        self.assertEqual(self.admit(reg, req(t, subject={"n": 3}, inputs=[other])).code, "INPUT_NOT_ALLOWED")

    def test_aq16_missing_trl_refused(self):
        t = tpl("T-STUB-W0-V1", requires_trl=True)
        reg = registry([t])
        self.assertEqual(self.admit(reg, req(t)).code, "TRL_MISSING")
        ok = self.admit(reg, req(t, subject={"n": 2}, trl_ids=["TRL-1"], trl_ledger_snapshot_sha256="a" * 64))
        self.assertEqual(ok.state, "READY")

    def test_aq22_path_guards(self):
        for p in ("/srv/research-lane2", "/srv/research-lane2/x/y", "/srv/v6-prod", "/srv/v6-prod/db"):
            with self.assertRaises(guard.PathForbidden):
                guard.check_path(p)
        guard.check_path("/srv/research-lane/research-queue/runs")
        guard.check_path("/srv/research-lane2x")  # a different name, not the failed lane
        t = tpl("T-STUB-W0-V1", inputs=[{"prefix": "/srv/research-lane2"}])
        self.assertEqual(self.admit(registry([t]), req(t, inputs=[{"path": "/srv/research-lane2/a", "sha256": "0" * 64}])).code, "PATH_FORBIDDEN")
        with self.assertRaises(guard.PathForbidden):
            config.Config(host="LINUX", root=pathlib.Path("/srv/v6-prod/rq"))

    def test_aq24_master_table_never_written(self):
        with self.assertRaises(guard.PathForbidden):
            guard.check_write_path("/x/y/RESEARCH_MASTER_TABLE.json")
        with self.assertRaises(guard.PathForbidden):
            guard.check_write_path(self.root / "RESEARCH_MASTER_TABLE_ROW_REQUEST.json")
        for p in SRC.glob("*.py"):
            if p.name != "guard.py":
                self.assertNotIn("RESEARCH_MASTER_TABLE", p.read_text(), p.name)

    def test_aq25_v6_untouched_static(self):
        for p in list(SRC.glob("*.py")) + list((ROOT / "deploy/research-queue").rglob("*")):
            if not p.is_file() or p.name in ("pause.py",):
                continue
            s = p.read_text()
            for bad in ("psycopg", "pg8000", "asyncpg", "pymysql", "mysql.connector", "5432", "ashare-v6", "Ashare-V6", ".env.local", "docker exec", "docker restart", "docker prune"):
                self.assertNotIn(bad, s, "%s in %s" % (bad, p))
        s = (SRC / "pause.py").read_text()  # pause.py may name V6 only in its refuse list
        for bad in ("psycopg", "pymysql", "5432", "docker exec", "docker restart", "docker prune"):
            self.assertNotIn(bad, s)


class HKScope(Base):
    host = "HK"

    def test_aq19_hk_extract_refused_and_hk_runs_net_only(self):
        t = tpl("T-HK-EXTRACT-V1", kinds=["HK_EXTRACT"], producer_host="HK", run_host="HK", agent_host="HK", weight_class="W0", io_class="HK_DB")
        r = self.admit(registry([t]), req(t))
        self.assertEqual((r.state, r.code), ("REFUSED_ADMISSION", "HK_COMPUTE_FORBIDDEN"))
        w = tpl("T-STUB-W0-V1", producer_host="HK", run_host="HK", agent_host="HK")
        self.assertEqual(self.admit(registry([w]), req(w)).code, "HK_COMPUTE_FORBIDDEN")

    def test_aq18_hk_forbidden_argv_tokens(self):
        for argv in ([PY, "/x/export-crypto-desk.js"], [PY, "/opt/smartflow/main-app/index.js"], [PY, "http://example.com/x"],
                     [PY, "mysql://127.0.0.1:3306/db"], [PY, "--db", "127.0.0.1:3306"]):
            t = net_tpl(argv=argv, params={}, agent_host="HK", producer_host="HK")
            r = self.admit(registry([t]), req(t, market="US_EQUITY", params={}))
            self.assertEqual(r.code, "HK_FORBIDDEN_ARGV", argv)
        ok = net_tpl(argv=[PY, "/opt/research-queue/agent.js", "http://127.0.0.1:9/x"], params={})
        self.assertEqual(self.admit(registry([ok]), req(ok, market="US_EQUITY", params={})).state, "READY")

    def test_aq36_market_routes_agent_host(self):
        t = net_tpl()
        reg = registry([t])
        self.assertEqual(self.admit(reg, req(t, market="CRYPTO")).state, "READY")
        self.assertEqual(self.admit(reg, req(t, subject={"n": 2}, market="US_EQUITY")).state, "READY")
        r = self.admit(reg, req(t, subject={"n": 3}, market="CN_A"))  # CN_A is never on HK
        self.assertEqual((r.state, r.code), ("REFUSED_ADMISSION", "AGENT_HOST_MISMATCH"))
        row = self.row(self.admit(reg, req(t, market="CRYPTO")).task_id)
        self.assertEqual((row["host"], row["agent_host"]), ("HK", "HK"))


class LinuxRouting(Base):
    def test_linux_producer_refuses_us_net_task_and_non_owned_templates(self):
        t = net_tpl()
        r = self.admit(registry([t]), req(t, market="US_EQUITY"))
        self.assertEqual(r.code, "AGENT_HOST_MISMATCH")
        t2 = tpl("T-STUB-W0-V1", producer_host="HK", run_host="HK")
        self.assertEqual(self.admit(registry([t2]), req(t2)).code, "HOST_ROUTE_REFUSED")


class Intake(Base):
    def test_fact_pack_in_inbox_creates_one_card_task_per_week_and_market(self):
        t = net_tpl("T-AI-REVIEW-CARD-V1", prompt_admission_sha256=sha("prompt"), params={}, argv=[PY, STUB, "ok"])
        reg = registry([t])
        d = self.cfg.inbox_dir / "fact-packs"
        d.mkdir(parents=True)
        pack = {"schema": "REVIEW_AI_FACT_PACK_V1", "week": "2026-W48", "market": "CN_A", "facts": []}
        (d / "2026-W48-CN_A.json").write_text(json.dumps(pack))
        (d / "2026-W48-US_EQUITY.json").write_text(json.dumps(dict(pack, market="US_EQUITY")))
        s1 = producer.tick(self.conn, self.cfg, reg, at(10, 0))
        s2 = producer.tick(self.conn, self.cfg, reg, at(10, 1))
        rows = self.conn.execute("select market, state, kind, agent_host from task order by market").fetchall()
        self.assertEqual([(r[0], r[1], r[2], r[3]) for r in rows if r[1] != "REFUSED_ADMISSION"], [("CN_A", "READY", "AI_REVIEW_CARD", "LINUX")])
        self.assertEqual(s1["admitted"], 1)
        self.assertEqual(s2["admitted"], 0)
        adm = json.loads(self.conn.execute("select admission_json from task where market='CN_A'").fetchone()[0])
        self.assertEqual(adm["request"]["subject"]["week"], "2026-W48")
        self.assertEqual(adm["request"]["subject"]["prompt_admission_sha256"], sha("prompt"))

    def test_request_files_and_bad_json(self):
        t = tpl("T-STUB-W0-V1")
        d = self.cfg.inbox_dir / "requests"
        d.mkdir(parents=True)
        (d / "a.json").write_text(json.dumps(req(t)))
        (d / "bad.json").write_text("{not json")
        s = producer.tick(self.conn, self.cfg, registry([t]), at(10, 0))
        self.assertEqual((s["admitted"], s["unreadable"]), (1, 1))

    def test_bundle_dependency_verified_by_sha(self):
        t = tpl("T-STUB-W0-V1")
        reg = registry([t])
        b = self.cfg.inbox_dir / "bundles"
        b.mkdir(parents=True)
        (b / "HK-RQT-HK-1.json").write_text("bundle")
        dep = {"host": "HK", "task_id": "RQT-HK-1", "bundle_sha256": sha("bundle")}
        r = self.admit(reg, req(t, depends_on=[dep]))
        self.assertIsNotNone(core.claim(self.conn, host="LINUX", worker="w", now=self.t0, bundle_dir=b))
        r2 = self.admit(reg, req(t, subject={"n": 2}, depends_on=[dict(dep, bundle_sha256="0" * 64)]))
        self.assertIsNone(core.claim(self.conn, host="LINUX", worker="w", now=self.t0, bundle_dir=b, slots=False))


class TemplateFiles(unittest.TestCase):
    def test_shipped_registry_is_valid_and_only_frozen_templates_are_pinned(self):
        reg = templates.Registry.load(ROOT / "config/research_queue_templates.v1.json", ROOT / "config/research_queue_template_pins.v1.json")
        ids = {t["template_id"] for t in reg.templates}
        pinned = {"T-AI-REVIEW-CARD-V1-LINUX-CN_A", "T-AI-CHECK-V1-LINUX-CN_A", "T-AI-REVIEW-CARD-V1-HK-US-CRYPTO", "T-AI-CHECK-V1-HK-US-CRYPTO", "T-AI-MECH-NOTE-V1-LINUX-CN_A", "T-AI-MECH-REVIEW-V1-LINUX-CN_A"}
        legacy = pinned | {"T-AI-PREREG-V1", "T-AI-REVIEW-CARD-V1-HK-US-CRYPTO", "T-AI-CHECK-V1-HK-US-CRYPTO"}
        heavy_ids = {"T-HEAVY-Q0-LANE-V1-LINUX", "T-HEAVY-LAB-E2E-V1-LINUX"}
        self.assertTrue(legacy | heavy_ids <= ids)
        for t in reg.templates:
            self.assertEqual(templates.validate_template(t), [], t["template_id"])
            self.assertEqual(t["weight_class"], "W2" if t["template_id"] in heavy_ids else "NET")
            self.assertEqual(reg.is_frozen(t), t["template_id"] in pinned, t["template_id"])  # T-AI-PREREG-V1 waits for its own freeze page
        self.assertEqual({p["template_id"] for p in reg.pins}, pinned)

    def test_validate_template_rejects_bad_shapes(self):
        t = tpl("T-X-V1")
        self.assertEqual(templates.validate_template(t), [])
        for key, val in (("weight_class", "W9"), ("argv", []), ("completion", "MAYBE"), ("producer_host", "MAC")):
            self.assertTrue(templates.validate_template(dict(t, **{key: val})), key)
        self.assertTrue(templates.validate_template({k: v for k, v in t.items() if k != "evidence_matrix"}))
        self.assertTrue(templates.validate_template(dict(t, idempotent=False)))  # non-idempotent needs recovery_argv


if __name__ == "__main__":
    unittest.main()
