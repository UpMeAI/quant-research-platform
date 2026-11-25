"""AQ-Q3b: the four NET templates (Linux CN_A / HK US+crypto, card and check) are real, validated, pinned entries; the HK launch needs no new privilege."""
import json, subprocess, unittest
from helpers import *  # noqa

CFG = ROOT / "config"
DEPLOY = ROOT / "deploy"
IDS = ("T-AI-REVIEW-CARD-V1-LINUX-CN_A", "T-AI-CHECK-V1-LINUX-CN_A", "T-AI-REVIEW-CARD-V1-HK-US-CRYPTO", "T-AI-CHECK-V1-HK-US-CRYPTO")
PROMPT_BY_KIND = {"AI_REVIEW_CARD": "26c2cdc9abebf767f8d65b0198702951e7a0a2e550c5b13570ee84643d373ecf", "AI_CHECK": "aa550fbe9fb08864508ad3204f8ee826ad0a697e87121967a6329a4d574c0058"}


def shipped():
    return templates.Registry.load(CFG / "research_queue_templates.v1.json", CFG / "research_queue_template_pins.v1.json")


def by_id(reg, tid):
    return reg.get(tid)


class ShippedTemplates(unittest.TestCase):
    def test_four_templates_validate_with_the_core_validator(self):
        reg = shipped()
        for tid in IDS:
            t = reg.get(tid)
            self.assertIsNotNone(t, tid)
            self.assertEqual(templates.validate_template(t), [], tid)
            self.assertEqual((t["weight_class"], t["io_class"], t["completion"], t["idempotent"]), ("NET", "NONE", "SELF_VALIDATED", True), tid)
            self.assertNotIn("template_sha256", t, "the sha is of the template without any sha field")
            self.assertNotIn("<run>", json.dumps(t), "no unresolved placeholder in a frozen template")

    def test_pins_match_the_computed_shas_one_per_template(self):
        reg = shipped()
        pins = {p["template_id"]: p for p in reg.pins}
        mech_ids = ("T-AI-MECH-NOTE-V1-LINUX-CN_A", "T-AI-MECH-REVIEW-V1-LINUX-CN_A")
        pause_ids = ("T-AI-PAUSE-CHECK-V1-LINUX",)
        self.assertEqual(sorted(pins), sorted(IDS + mech_ids + pause_ids))
        self.assertEqual(len(reg.pins), 7, "four Q3b pins plus two #149C pins and the #153 pause pin, no stray pins")
        for tid in mech_ids:
            self.assertIn(tid, pins)
        for tid in IDS:
            t = reg.get(tid)
            self.assertEqual(pins[tid]["template_sha256"], templates.template_sha256(t), tid)
            self.assertRegex(pins[tid]["template_sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(reg.is_frozen(t), tid)
            self.assertIn("frozen_page_sha256", pins[tid])
            self.assertEqual(pins[tid]["frozen_page_sha256"], "c53171740c6d59be5ee4171f95b0b07dba71a69def14a430403f099aa8fe6a40" if "LINUX" in tid else None, tid)  # Linux: RQ_TEMPLATES_V1_FREEZE_1; HK: FREEZE_2 not written yet
        self.assertEqual(len({p["template_sha256"] for p in reg.pins}), 7)

    def test_unpinned_template_is_refused(self):
        reg = shipped()
        self.assertFalse(reg.is_frozen(reg.get("T-AI-PREREG-V1")), "the prereg template is not part of Q3b and stays unpinned")
        for tid in ("T-AI-PREREG-V1",):
            t = reg.get(tid)
            self.assertEqual(self._admit(reg, t, "CN_A").code, "TEMPLATE_NOT_FROZEN")
        # a pinned template changed by one byte is no longer the pinned one
        t = json.loads(json.dumps(reg.get(IDS[0])))
        t["expected_duration_s"] += 1
        reg2 = templates.Registry([t] + [x for x in reg.templates if x["template_id"] != t["template_id"]], reg.pins)
        self.assertFalse(reg2.is_frozen(t))
        self.assertEqual(self._admit(reg2, t, "CN_A").code, "TEMPLATE_NOT_FROZEN")

    def _admit(self, reg, t, market):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = config.Config(host="LINUX", root=pathlib.Path(tmp.name))
        conn = core.connect(cfg.db_path)
        core.migrate(conn)
        r = {"template_id": t["template_id"], "template_sha256": templates.template_sha256(t), "market": market, "kind": t["kinds"][0], "subject": {"n": 1}, "params": {}, "inputs": [], "depends_on": [], "priority": 50}
        return producer.admit(conn, cfg, reg, r, at(10, 0, day=28))

    def test_evidence_matrix_rows_hash_to_the_pinned_matrix_sha_and_prompt_pins_match_admissions(self):
        reg = shipped()
        adm = json.loads((CFG / "research_queue_prompt_admissions.v1.json").read_text())["entries"]
        sha_of_kind = {e["kind"]: e["system_sha256"] for e in adm}
        for tid in IDS:
            t = reg.get(tid)
            self.assertEqual(core.sha256_hex(core.canonical(t["evidence_matrix_rows"])), t["evidence_matrix"]["sha256"], tid)
            self.assertEqual(t["evidence_matrix"]["id"], "EM-" + t["kinds"][0].replace("_", "-") + "-V1")
            self.assertEqual(t["prompt_admission_sha256"], PROMPT_BY_KIND[t["kinds"][0]], tid)
            self.assertEqual(t["prompt_admission_sha256"], sha_of_kind[t["kinds"][0]], tid)
        self.assertEqual(reg.get(IDS[0])["evidence_matrix"]["sha256"], "b11c668c052d855189a476010c402a15b27def0038a710acf554d6f00410439c")
        self.assertEqual(reg.get(IDS[1])["evidence_matrix"]["sha256"], "e7365bcc9949c91ecb35a8d44b86d0fea206ea478f7aefd3b89695d13bacae5a")

    def test_host_and_market_scope(self):
        reg = shipped()
        for tid, host, markets in ((IDS[0], "LINUX", ["CN_A"]), (IDS[1], "LINUX", ["CN_A"]), (IDS[2], "HK", ["CRYPTO", "US_EQUITY"]), (IDS[3], "HK", ["CRYPTO", "US_EQUITY"])):
            t = reg.get(tid)
            self.assertEqual((t["producer_host"], t["run_host"], t["agent_host"]), (host, host, host), tid)
            self.assertEqual(sorted(t["markets"]), markets, tid)
            self.assertEqual(t["params"], {})


class HkLaunch(unittest.TestCase):
    def test_hk_launch_is_the_spool_client_not_a_child_agent_or_systemctl(self):
        reg = shipped()
        for tid in IDS[2:]:
            self.assertEqual(reg.get(tid)["argv"], ["/opt/research-queue/current/deploy/research-queue-ai/hk/spool-client.sh"], tid)
        self.assertFalse((DEPLOY / "research-queue-ai" / "hk" / "run-agent.sh").exists())
        u = (DEPLOY / "research-queue" / "hk" / "rq-consumer.service").read_text()
        self.assertNotIn("RestrictAddressFamilies", u)

    def test_linux_argv(self):
        reg = shipped()
        for tid in IDS[:2]:
            self.assertEqual(reg.get(tid)["argv"], ["/srv/research-lane/research-queue/code/current/deploy/research-queue-ai/linux/run-agent.sh"], tid)

    def test_linux_launcher_defaults_to_the_attempt_dir_and_keeps_its_flags(self):
        s = (DEPLOY / "research-queue-ai" / "linux" / "run-agent.sh").read_text()
        self.assertIn("RQ_ATTEMPT_DIR", s)
        for flag in ("--network none", "--read-only", "--cap-drop ALL", "no-new-privileges", "--user 1000:1000"):
            self.assertIn(flag, s)


class ShippedAdmission(Base):
    """The producer picks the host's card template by market; the shipped registry admits exactly the routes the design allows."""

    def _pack(self, market, week="2026-W48"):
        d = self.cfg.inbox_dir / "fact-packs"
        d.mkdir(parents=True, exist_ok=True)
        (d / ("%s-%s.json" % (week, market))).write_text(json.dumps({"schema": "REVIEW_AI_FACT_PACK_V1", "week": week, "market": market, "facts": []}))

    def _rows(self):
        return self.conn.execute("select market, state, template_id, agent_host, state_reason from task order by market").fetchall()

    def test_linux_admits_cn_a_card_with_the_linux_template(self):
        self._pack("CN_A")
        producer.tick(self.conn, self.cfg, shipped(), at(10, 0, day=28))
        rows = [r for r in self._rows() if r[1] == "READY"]
        self.assertEqual([(r[0], r[2], r[3]) for r in rows], [("CN_A", IDS[0], "LINUX")])
        adm = json.loads(self.conn.execute("select admission_json from task where state='READY'").fetchone()[0])
        self.assertEqual(adm["derived"]["argv"], shipped().get(IDS[0])["argv"])
        self.assertEqual(adm["derived"]["prompt_admission_sha256"], PROMPT_BY_KIND["AI_REVIEW_CARD"])

    def test_linux_refuses_us_card_and_check_for_cn_a_is_admitted(self):
        self._pack("US_EQUITY")
        producer.tick(self.conn, self.cfg, shipped(), at(10, 0, day=28))
        self.assertEqual([r[1] for r in self._rows()], ["REFUSED_ADMISSION"])
        reg = shipped()
        t = reg.get(IDS[1])
        r = self.admit(reg, req(t, market="CN_A", params={}, kind="AI_CHECK", subject={"task": "RQT-LINUX-20261130-aaaaaaaa", "gate_record_sha256": "a" * 64, "prompt_admission_sha256": t["prompt_admission_sha256"]}))
        self.assertEqual((r.state, r.code), ("READY", ""))


class ShippedAdmissionHK(Base):
    host = "HK"

    def test_hk_admits_us_and_crypto_cards_and_checks_and_refuses_cn_a(self):
        reg = shipped()
        d = self.cfg.inbox_dir / "fact-packs"
        d.mkdir(parents=True)
        for m in ("US_EQUITY", "CRYPTO", "CN_A"):
            (d / ("2026-W48-%s.json" % m)).write_text(json.dumps({"schema": "REVIEW_AI_FACT_PACK_V1", "week": "2026-W48", "market": m, "facts": []}))
        producer.tick(self.conn, self.cfg, reg, at(10, 0, day=28))
        rows = self.conn.execute("select market, state, template_id from task order by market").fetchall()
        self.assertEqual([(r[0], r[1], r[2]) for r in rows if r[1] == "READY"], [("CRYPTO", "READY", IDS[2]), ("US_EQUITY", "READY", IDS[2])])
        self.assertEqual([r[0] for r in rows if r[1] != "READY"], ["CN_A"])
        t = reg.get(IDS[3])
        for m in ("US_EQUITY", "CRYPTO"):
            r = self.admit(reg, req(t, market=m, params={}, kind="AI_CHECK", subject={"task": "RQT-HK-20261130-bbbbbbbb", "m": m, "gate_record_sha256": "b" * 64, "prompt_admission_sha256": t["prompt_admission_sha256"]}))
            self.assertEqual((r.state, r.code), ("READY", ""), m)
        self.assertEqual(self.admit(reg, req(t, market="CN_A", params={}, kind="AI_CHECK", subject={"n": 9})).code, "AGENT_HOST_MISMATCH")


if __name__ == "__main__":
    unittest.main()
