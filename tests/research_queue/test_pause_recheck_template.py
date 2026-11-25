"""#153 Package B: pause re-check template, pin, user units, and contract."""
import configparser
import json
import pathlib
import shutil
import unittest

from helpers import Base, ROOT, core, producer, templates
from rq import agentseam


CFG = ROOT / "config"
UNITS = ROOT / "deploy" / "research-lane" / "pause-recheck"
CONTRACT = ROOT / "docs" / "contracts" / "PAUSE_RECHECK_V1.md"
TEMPLATE_ID = "T-AI-PAUSE-CHECK-V1-LINUX"
PROMPT_SHA = "aa550fbe9fb08864508ad3204f8ee826ad0a697e87121967a6329a4d574c0058"
SPEC_SHA = "5f880312358be75d0e37dc32c9c39b8725f84aa9bb92c008b992b35936014d6a"
NODE = shutil.which("node")

BASE_TEMPLATE_SHAS = {
    "T-AI-REVIEW-CARD-V1-LINUX-CN_A": "7849a35d674b5b9cae3e94e0424f3d4ee5871d402fd96e79d6ac7c7a03018d39",
    "T-AI-CHECK-V1-LINUX-CN_A": "4de786fb2c9a65cffcf4d4aef34194c14fbcbd396fac0e17f2db5a1193033a1e",
    "T-AI-REVIEW-CARD-V1-HK-US-CRYPTO": "e1f4f217d121800aec2e13688c0c4c1fbebfa7245de981307f04efdbaf7dca32",
    "T-AI-CHECK-V1-HK-US-CRYPTO": "491a86b4348a34a92164fa978596ff2d870daa129780bc6e368c5a8e9f02240d",
    "T-AI-PREREG-V1": "4e4c43dc86638798dea1d2c0bf7ee120ef886743c451f8c63d4ee311a2ff0d7f",
    "T-HEAVY-Q0-LANE-V1-LINUX": "17d8b3ff034be917c12074c315fe1e0e31dd905788be74704ea8089f5e276c9f",
    "T-HEAVY-LAB-E2E-V1-LINUX": "af7212e2a004d3fe813e3c4f3a96f21f897608d3e96ecb6e661031d35e1e4446",
    "T-AI-MECH-NOTE-V1-LINUX-CN_A": "7567eeb8882b4aee734857664fa41237c3279200b87b9f48e13d1bff6c7073a3",
    "T-AI-MECH-REVIEW-V1-LINUX-CN_A": "7c0e702d452e5be5a2c977a7149cce3900c467f2a190c561e9ac2fbcdd3f81e9",
}
BASE_PIN_IDS = (
    "T-AI-REVIEW-CARD-V1-LINUX-CN_A",
    "T-AI-CHECK-V1-LINUX-CN_A",
    "T-AI-REVIEW-CARD-V1-HK-US-CRYPTO",
    "T-AI-CHECK-V1-HK-US-CRYPTO",
    "T-AI-MECH-NOTE-V1-LINUX-CN_A",
    "T-AI-MECH-REVIEW-V1-LINUX-CN_A",
)


def shipped():
    return templates.Registry.load(
        CFG / "research_queue_templates.v1.json",
        CFG / "research_queue_template_pins.v1.json",
    )


def unit(name):
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    parser.optionxform = str
    parser.read(UNITS / name)
    return parser


def pause_bundle(market):
    facts = [{
        "id": "F-001",
        "source": {
            "path": "research/promotion/results/CAND-1.json",
            "sha256": "a" * 64,
            "pointer": "/resolution",
            "record_type": "PROMOTION_RESULT_V1",
        },
        "at": "2026-12-03T22:00:00+08:00",
        "value": {"code": "PAUSE_LOW_POWER", "month_state": "STAY_PAUSED_REASON_REFRESHED"},
    }]
    matrix = [
        {"req_id": "PR-1", "fact_ids": ["F-001"], "gate_result": "STAY_PAUSED_REASON_REFRESHED"},
        {"req_id": "PR-2", "fact_ids": ["F-001"], "gate_result": "STAY_PAUSED_REASON_REFRESHED"},
        {"req_id": "PR-3", "fact_ids": ["F-001"], "gate_result": "STAY_PAUSED_REASON_REFRESHED"},
    ]
    return {"schema": "RQ_AGENT_BUNDLE_V1", "market": market, "pack": {"market": market, "facts": facts, "evidence_matrix": matrix}}


class PauseRecheckTemplate(Base):
    def setUp(self):
        super().setUp()
        self.reg = shipped()
        self.template = self.reg.get(TEMPLATE_ID)

    def _request(self, market="CN_A"):
        bundle = pause_bundle(market)
        path = self.cfg.inbox_dir / "pause-packs" / (market + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = core.canonical(bundle).encode() + b"\n"
        path.write_bytes(raw)
        return {
            "template_id": TEMPLATE_ID,
            "template_sha256": templates.template_sha256(self.template),
            "market": market,
            "kind": "AI_CHECK",
            "subject": {
                "candidate_id": "CAND-1",
                "month": "2026-12",
                "pack_sha256": core.sha256_hex(raw),
                "prompt_admission_sha256": PROMPT_SHA,
            },
            "params": {},
            "inputs": [{"path": str(path), "sha256": core.sha256_hex(raw)}],
            "depends_on": [],
            "priority": 50,
        }

    def test_b01_template_validates_and_has_the_frozen_route(self):
        self.assertIsNotNone(self.template)
        self.assertEqual(templates.validate_template(self.template), [])
        reference = self.reg.get("T-AI-CHECK-V1-LINUX-CN_A")
        for key in (
            "kinds", "producer_host", "run_host", "agent_host", "weight_class",
            "io_class", "argv", "argv_env_required", "params", "outputs",
            "expected_duration_s", "prompt_admission_sha256", "idempotent",
            "transient_budget", "completion", "requires_trl", "gateway",
            "windows_cst", "n_rule",
        ):
            self.assertEqual(self.template[key], reference[key], key)
        self.assertEqual(self.template["inputs"], [{"prefix": "{inbox}/pause-packs"}])
        self.assertEqual(self.template["markets"], ["CN_A", "US_EQUITY", "CRYPTO"])
        self.assertEqual(
            self.template["subject_keys"],
            "candidate_id, month, pack sha256, prompt-admission sha256",
        )
        self.assertEqual(self.template["authority_shas"], [SPEC_SHA])

    def test_b02_existing_templates_and_pins_are_byte_semantically_unchanged(self):
        self.assertEqual([t["template_id"] for t in self.reg.templates[:-1]], list(BASE_TEMPLATE_SHAS))
        self.assertEqual(self.reg.templates[-1]["template_id"], TEMPLATE_ID)
        for template in self.reg.templates[:-1]:
            self.assertEqual(
                templates.template_sha256(template),
                BASE_TEMPLATE_SHAS[template["template_id"]],
                template["template_id"],
            )
        self.assertEqual(tuple(p["template_id"] for p in self.reg.pins[:-1]), BASE_PIN_IDS)
        self.assertEqual(self.reg.pins[-1]["template_id"], TEMPLATE_ID)

    def test_b03_missing_pin_refuses_then_pinned_request_is_idempotently_ready(self):
        self.assertIsNotNone(self.template)
        request = self._request()
        unpinned = templates.Registry(
            self.reg.templates,
            [p for p in self.reg.pins if p["template_id"] != TEMPLATE_ID],
        )
        refused = producer.admit(self.conn, self.cfg, unpinned, request, self.t0)
        self.assertEqual((refused.state, refused.code), ("REFUSED_ADMISSION", "TEMPLATE_NOT_FROZEN"))
        first = producer.admit(self.conn, self.cfg, self.reg, request, self.t0)
        again = producer.admit(self.conn, self.cfg, self.reg, request, self.t0)
        self.assertEqual((first.state, first.code, first.created), ("READY", "", True))
        self.assertEqual((again.task_id, again.state, again.created), (first.task_id, "READY", False))

    def test_b04_prompt_sha_is_the_admitted_ai_check_prompt(self):
        self.assertIsNotNone(self.template)
        admissions = json.loads((CFG / "research_queue_prompt_admissions.v1.json").read_text())["entries"]
        admitted = next(e for e in admissions if e["prompt_id"] == "RQ_PROMPT_AI_CHECK_V1")
        self.assertEqual((admitted["state"], admitted["system_sha256"]), ("ADMITTED", PROMPT_SHA))
        self.assertEqual(self.template["prompt_admission_sha256"], admitted["system_sha256"])

    def test_b05_evidence_matrix_hash_is_canonical(self):
        self.assertIsNotNone(self.template)
        self.assertEqual(self.template["evidence_matrix"]["id"], "EM-AI-PAUSE-CHECK-V1")
        self.assertEqual(
            self.template["evidence_matrix"]["sha256"],
            core.sha256_hex(core.canonical(self.template["evidence_matrix_rows"])),
        )
        self.assertEqual([r["id"] for r in self.template["evidence_matrix_rows"]], ["PR-1", "PR-2", "PR-3"])

    @unittest.skipUnless(NODE, "node not available")
    def test_b06_us_equity_pause_pack_stages_and_consumer_revalidates(self):
        self.cfg.node_bin = NODE
        admitted = producer.admit(self.conn, self.cfg, self.reg, self._request("US_EQUITY"), self.t0)
        self.assertEqual((admitted.state, admitted.code), ("READY", ""))
        claimed = core.claim(self.conn, host="LINUX", worker=self.cfg.worker, now=self.t0)
        self.assertEqual(claimed["task_id"], admitted.task_id)
        task = core.get_task(self.conn, admitted.task_id)
        attempt = self.cfg.runs_dir / admitted.task_id / "attempt-1"
        agentseam.stage(self.cfg, task, attempt)
        staged_task = json.loads((attempt / "in" / "task.json").read_text())
        staged_bundle = json.loads((attempt / "in" / "bundle.json").read_text())
        self.assertEqual((staged_task["kind"], staged_task["market"]), ("AI_CHECK", "US_EQUITY"))
        self.assertEqual((staged_bundle["market"], staged_bundle["pack"]["market"]), ("US_EQUITY", "US_EQUITY"))

        report = {
            "schema": "RQ_CHECK_REPORT_V1",
            "task_id": admitted.task_id,
            "prompt_admission_sha256": PROMPT_SHA,
            "model": "deepseek-flash",
            "verdict": "CONSISTENT",
            "items": [{
                "req_id": row["req_id"],
                "status": "COVERED",
                "fact_ids": ["F-001"],
                "note_zh": "本月事实支持该项",
            } for row in staged_bundle["pack"]["evidence_matrix"]],
            "hold_reasons": [],
            "unknowns": [],
        }
        result = {
            "schema": "RQ_AGENT_RESULT_V1",
            "task_id": admitted.task_id,
            "kind": "AI_CHECK",
            "status": "DONE",
            "outputs": {
                "check_report": report,
                "check_report_sha256": core.sha256_hex(core.canonical(report)),
                "fact_pack_sha256": core.sha256_hex(core.canonical(staged_bundle["pack"])),
            },
        }
        attempt.mkdir(parents=True, exist_ok=True)
        (attempt / "result.json").write_bytes(core.canonical(result).encode() + b"\n")
        validation = agentseam.revalidate(self.cfg, admitted.task_id, attempt)
        self.assertTrue(validation["ok"], validation["codes"])


class PauseRecheckUnits(unittest.TestCase):
    def test_b07_user_timer_service_install_and_contract_are_frozen(self):
        service = unit("qrp-pause-recheck.service")
        timer = unit("qrp-pause-recheck.timer")
        self.assertEqual(service["Service"]["Type"], "oneshot")
        self.assertEqual(
            service["Service"]["ExecStart"],
            "/usr/bin/python3 /srv/research-lane/research-queue/code/current/services/pause-recheck/pause_recheck.py tick",
        )
        self.assertEqual(timer["Timer"]["OnCalendar"], "*-*-03..07 22:00:00 Asia/Shanghai")
        self.assertEqual(timer["Timer"]["Persistent"], "true")
        self.assertEqual(timer["Install"]["WantedBy"], "timers.target")
        self.assertNotIn("User", service["Service"])
        all_unit_text = "\n".join(
            (UNITS / name).read_text()
            for name in ("qrp-pause-recheck.service", "qrp-pause-recheck.timer")
        ).lower()
        self.assertNotIn("docker", all_unit_text)

        install = (UNITS / "INSTALL.md").read_text()
        for value in (
            "qrp-pause-recheck.service",
            "qrp-pause-recheck.timer",
            "%h/.config/research-queue/pause-recheck.env",
            "research/promotion/results",
            "research/promotion/terms",
            "research/promotion/observed",
            "research/pause-recheck",
            "kayla",
            "OBSERVED_MISSING",
        ):
            self.assertIn(value, install)
        self.assertNotIn("docker", install.lower())
        self.assertNotIn("rm -", install.lower())
        contract = CONTRACT.read_text()
        self.assertIn(SPEC_SHA, contract)
        self.assertIn("暂停 ≠ 不做", contract)
        self.assertIn("OBSERVED_MISSING", contract)
        self.assertIn("NO_PAUSED_ROWS", contract)
        self.assertIn("SOURCE_ABSENT", contract)


if __name__ == "__main__":
    unittest.main()
