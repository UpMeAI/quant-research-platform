"""#149 Package C: frozen post-round templates, pins, and user units."""
import configparser
import hashlib
import json
import pathlib
import re
import unittest

from helpers import Base, ROOT, core, producer, templates


CFG = ROOT / "config"
UNITS = ROOT / "deploy" / "research-lane" / "post-round"
NEW_IDS = (
    "T-AI-MECH-NOTE-V1-LINUX-CN_A",
    "T-AI-MECH-REVIEW-V1-LINUX-CN_A",
)
PROMPT_SHAS = {
    NEW_IDS[0]: "2dbf2864f0e7c36db553002a7a42fecd1e3b55afde1780959ec3063d07586f86",
    NEW_IDS[1]: "ddebb02883ddb61517fd359871ca4f0a987605900f1309eaa9ecd2b6682fed33",
}
BASE_TEMPLATE_SHAS = {
    "T-AI-REVIEW-CARD-V1-LINUX-CN_A": "7849a35d674b5b9cae3e94e0424f3d4ee5871d402fd96e79d6ac7c7a03018d39",
    "T-AI-CHECK-V1-LINUX-CN_A": "4de786fb2c9a65cffcf4d4aef34194c14fbcbd396fac0e17f2db5a1193033a1e",
    "T-AI-REVIEW-CARD-V1-HK-US-CRYPTO": "e1f4f217d121800aec2e13688c0c4c1fbebfa7245de981307f04efdbaf7dca32",
    "T-AI-CHECK-V1-HK-US-CRYPTO": "491a86b4348a34a92164fa978596ff2d870daa129780bc6e368c5a8e9f02240d",
    "T-AI-PREREG-V1": "4e4c43dc86638798dea1d2c0bf7ee120ef886743c451f8c63d4ee311a2ff0d7f",
    "T-HEAVY-Q0-LANE-V1-LINUX": "17d8b3ff034be917c12074c315fe1e0e31dd905788be74704ea8089f5e276c9f",
    "T-HEAVY-LAB-E2E-V1-LINUX": "af7212e2a004d3fe813e3c4f3a96f21f897608d3e96ecb6e661031d35e1e4446",
}
BASE_PINS = [
    {
        "template_id": "T-AI-REVIEW-CARD-V1-LINUX-CN_A",
        "template_sha256": "7849a35d674b5b9cae3e94e0424f3d4ee5871d402fd96e79d6ac7c7a03018d39",
        "frozen_page_sha256": "c53171740c6d59be5ee4171f95b0b07dba71a69def14a430403f099aa8fe6a40",
    },
    {
        "template_id": "T-AI-CHECK-V1-LINUX-CN_A",
        "template_sha256": "4de786fb2c9a65cffcf4d4aef34194c14fbcbd396fac0e17f2db5a1193033a1e",
        "frozen_page_sha256": "c53171740c6d59be5ee4171f95b0b07dba71a69def14a430403f099aa8fe6a40",
    },
    {
        "template_id": "T-AI-REVIEW-CARD-V1-HK-US-CRYPTO",
        "template_sha256": "e1f4f217d121800aec2e13688c0c4c1fbebfa7245de981307f04efdbaf7dca32",
        "frozen_page_sha256": None,
    },
    {
        "template_id": "T-AI-CHECK-V1-HK-US-CRYPTO",
        "template_sha256": "491a86b4348a34a92164fa978596ff2d870daa129780bc6e368c5a8e9f02240d",
        "frozen_page_sha256": None,
    },
]


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


def package_a_success_result(template_id):
    """Representative output produced by Package A's authoritative success path."""
    is_note = template_id == NEW_IDS[0]
    task_id = "RQT-LINUX-20261124-a149c001"
    output_key = "mechanism_notes" if is_note else "mechanism_review"
    output = {
        "schema": "RF1116_MECH_NOTE_OUTPUT_V1" if is_note else "RF1116_MECH_REVIEW_OUTPUT_V1",
        "task_id": task_id,
        "round_id": "MR-CN_A-2026-11-a6cb823f86",
        "batch_no": 1,
        ("notes" if is_note else "items"): ([{
            "candidate_id": "A001",
            "outcome": "NOTE",
            "mechanism_id": "SEL.XSEC.VALUE",
            "economic_logic_zh": "估值字段的截面差异可能反映定价分歧与风险补偿",
            "failure_mode_zh": "估值口径失真或样本结构突变时可能失效",
            "fields_cited": ["pb"],
            "no_mechanism_code": None,
            "proposal": None,
        }] if is_note else [{
            "candidate_id": "A001",
            "status": "CONSISTENT",
            "code": None,
            "note_zh": "公式、机制与文字说明相互一致",
        }]),
        "prompt_admission_sha256": PROMPT_SHAS[template_id],
        "model": "deepseek-flash",
    }
    output_sha256 = core.sha256_hex(core.canonical(output))
    return {
        "schema": "RQ_AGENT_RESULT_V1",
        "task_id": task_id,
        "kind": "AI_MECH_NOTE" if is_note else "AI_MECH_REVIEW",
        "at": "2026-11-24T15:00:00+08:00",
        "calls": [],
        "outputs": {output_key: output, output_key + "_sha256": output_sha256},
        "status": "DONE",
        "validator": {"ok": True, "sha256": output_sha256},
    }


def resolve_path(value, dotted_path):
    for part in dotted_path.split("."):
        value = value[part]
    return value


class PostRoundTemplates(Base):
    def test_c01_templates_validate_and_mirror_linux_net_route(self):
        reg = shipped()
        reference = reg.get("T-AI-REVIEW-CARD-V1-LINUX-CN_A")
        for tid, kind in zip(NEW_IDS, ("AI_MECH_NOTE", "AI_MECH_REVIEW")):
            template = reg.get(tid)
            self.assertIsNotNone(template, tid)
            self.assertEqual(templates.validate_template(template), [], tid)
            self.assertEqual(template["kinds"], [kind])
            for key in (
                "producer_host", "run_host", "agent_host", "weight_class",
                "io_class", "argv", "params", "expected_duration_s",
                "idempotent", "transient_budget", "completion",
                "requires_trl", "markets", "gateway", "windows_cst",
                "n_rule", "argv_env_required",
            ):
                self.assertEqual(template[key], reference[key], (tid, key))
            self.assertEqual(template["inputs"], [{"prefix": "{inbox}/mech-packs"}])
            self.assertEqual(template["outputs"], ["result.json"])
            self.assertEqual(template["prompt_admission_sha256"], PROMPT_SHAS[tid])

    def test_c02_c03_unpinned_refused_then_pinned_is_idempotently_ready(self):
        reg = shipped()
        for tid in NEW_IDS:
            template = reg.get(tid)
            unpinned = templates.Registry(reg.templates, [p for p in reg.pins if p["template_id"] != tid])
            pack = self.cfg.inbox_dir / "mech-packs" / (tid + ".json")
            pack.parent.mkdir(parents=True, exist_ok=True)
            pack.write_text("{}")
            request = {
                "template_id": tid,
                "template_sha256": templates.template_sha256(template),
                "market": "CN_A",
                "kind": template["kinds"][0],
                "subject": {"round_id": "MR-CN_A-2026-11-a6cb823f86", "batch_no": 1, "pack_sha256": core.sha256_hex(pack.read_bytes())},
                "params": {},
                "inputs": [{"path": str(pack), "sha256": core.sha256_hex(pack.read_bytes())}],
                "depends_on": [],
                "priority": 50,
            }
            refused = producer.admit(self.conn, self.cfg, unpinned, request, self.t0)
            self.assertEqual((refused.state, refused.code), ("REFUSED_ADMISSION", "TEMPLATE_NOT_FROZEN"), tid)
            first = producer.admit(self.conn, self.cfg, reg, request, self.t0)
            again = producer.admit(self.conn, self.cfg, reg, request, self.t0)
            self.assertEqual((first.state, first.code, first.created), ("READY", "", True), tid)
            self.assertEqual((again.task_id, again.state, again.code, again.created), (first.task_id, "READY", "", False), tid)
            count = self.conn.execute("select count(*) from task where task_id=?", (first.task_id,)).fetchone()[0]
            self.assertEqual(count, 1, tid)

    def test_c04_base_templates_and_pins_are_unchanged_and_new_items_append(self):
        reg = shipped()
        self.assertEqual([t["template_id"] for t in reg.templates[:-2]], list(BASE_TEMPLATE_SHAS))
        self.assertEqual([t["template_id"] for t in reg.templates[-2:]], list(NEW_IDS))
        for template in reg.templates[:-2]:
            self.assertEqual(templates.template_sha256(template), BASE_TEMPLATE_SHAS[template["template_id"]])
        self.assertEqual(reg.pins[:len(BASE_PINS)], BASE_PINS)
        self.assertEqual([p["template_id"] for p in reg.pins[-2:]], list(NEW_IDS))
        for pin in reg.pins[-2:]:
            self.assertIsNone(pin["frozen_page_sha256"])
            self.assertEqual(pin["template_sha256"], templates.template_sha256(reg.get(pin["template_id"])))

    def test_c05_evidence_matrix_hashes_match_rows(self):
        reg = shipped()
        for tid, matrix_id in zip(NEW_IDS, ("EM-AI-MECH-NOTE-V1", "EM-AI-MECH-REVIEW-V1")):
            template = reg.get(tid)
            self.assertEqual(template["evidence_matrix"]["id"], matrix_id)
            self.assertEqual(
                template["evidence_matrix"]["sha256"],
                core.sha256_hex(core.canonical(template["evidence_matrix_rows"])),
                tid,
            )

    def test_c05_matrix_output_paths_resolve_package_a_success_and_verify_output_hash(self):
        reg = shipped()
        keys = {
            NEW_IDS[0]: "mechanism_notes",
            NEW_IDS[1]: "mechanism_review",
        }
        for tid, output_key in keys.items():
            template = reg.get(tid)
            matrix_row = next(row for row in template["evidence_matrix_rows"] if row["id"] == "EM-02")
            paths = re.findall(r"outputs\.[a-z0-9_]+", matrix_row["evidence"])
            self.assertEqual(paths, [f"outputs.{output_key}", f"outputs.{output_key}_sha256"], tid)

            result = package_a_success_result(tid)
            wrapped = resolve_path(result, paths[0])
            named_sha256 = resolve_path(result, paths[1])
            self.assertEqual(named_sha256, core.sha256_hex(core.canonical(wrapped)), tid)
            self.assertEqual(result["validator"], {"ok": True, "sha256": named_sha256}, tid)

    def test_c05_review_matrix_matches_authoritative_bounded_string_note_semantics(self):
        template = shipped().get(NEW_IDS[1])
        matrix_row = next(row for row in template["evidence_matrix_rows"] if row["id"] == "EM-03")
        self.assertEqual(
            matrix_row["req"],
            "every HOLD item has an allowed code; every CONSISTENT item has null code; note_zh is a string of at most 80 characters",
        )
        consistent = package_a_success_result(NEW_IDS[1])["outputs"]["mechanism_review"]["items"][0]
        self.assertEqual(consistent["status"], "CONSISTENT")
        self.assertIsNone(consistent["code"])
        consistent["note_zh"] = ""
        self.assertIsInstance(consistent["note_zh"], str)
        self.assertLessEqual(len(consistent["note_zh"]), 80)

    def test_c05_subject_is_only_round_batch_and_pack_sha(self):
        for tid in NEW_IDS:
            subject_keys = shipped().get(tid)["subject_keys"]
            self.assertEqual(subject_keys, "round_id, batch_no, pack sha256", tid)
            self.assertNotIn("prompt-admission", subject_keys, tid)


class PostRoundUserUnits(unittest.TestCase):
    def test_c06_user_service_runs_only_the_post_round_tick(self):
        service = unit("rf1116-post-round.service")
        self.assertNotIn("User", service["Service"])
        self.assertEqual(
            service["Service"]["ExecStart"],
            "/usr/bin/python3 /srv/research-lane/research-queue/code/current/services/rf1116-post-round/post_round.py tick",
        )
        self.assertNotIn("docker", (UNITS / "rf1116-post-round.service").read_text().lower())

    def test_c06_timer_is_persistent_and_runs_every_thirty_minutes(self):
        timer = unit("rf1116-post-round.timer")
        self.assertEqual(timer["Timer"]["OnCalendar"], "*-*-* *:0/30:00")
        self.assertEqual(timer["Timer"]["Persistent"], "true")
        self.assertEqual(timer["Install"]["WantedBy"], "timers.target")
        self.assertNotIn("docker", (UNITS / "rf1116-post-round.timer").read_text().lower())

    def test_c06_install_names_user_units_env_and_owned_post_round_directory(self):
        text = (UNITS / "INSTALL.md").read_text()
        for required in (
            "rf1116-post-round.service",
            "rf1116-post-round.timer",
            "systemctl --user",
            "%h/.config/research-queue/rf1116-post-round.env",
            "RF1116_NOTE_TEMPLATE_SHA256",
            "RF1116_REVIEW_TEMPLATE_SHA256",
            "/srv/research-lane/rf1116-mining/post-round",
            "kayla",
        ):
            self.assertIn(required, text)
        self.assertNotIn("docker", text.lower())
        self.assertNotIn("rm -", text.lower())

    def test_fix_cf1_install_pins_the_shipped_frozen_space(self):
        text = (UNITS / "INSTALL.md").read_text()
        env = dict(line.split("=", 1) for line in text.splitlines()
                   if line.startswith("RF1116_SPACE_") and "=" in line)
        prefix = "/srv/research-lane/research-queue/code/current/"
        self.assertTrue(env["RF1116_SPACE_FILE"].startswith(prefix))
        shipped_path = ROOT / env["RF1116_SPACE_FILE"].removeprefix(prefix)
        self.assertTrue(shipped_path.is_file(), shipped_path)
        self.assertEqual(
            hashlib.sha256(shipped_path.read_bytes()).hexdigest(),
            env["RF1116_SPACE_SHA256"],
        )

    def test_fix_cf2_install_template_hashes_equal_registry_pins(self):
        text = (UNITS / "INSTALL.md").read_text()
        env = dict(line.split("=", 1) for line in text.splitlines()
                   if line.startswith("RF1116_") and "=" in line)
        registry = shipped()
        pins = {pin["template_id"]: pin["template_sha256"] for pin in registry.pins}
        for prefix in ("NOTE", "REVIEW"):
            template_id = env[f"RF1116_{prefix}_TEMPLATE_ID"]
            installed_sha256 = env[f"RF1116_{prefix}_TEMPLATE_SHA256"]
            self.assertEqual(installed_sha256, pins[template_id], template_id)
            self.assertEqual(installed_sha256, templates.template_sha256(registry.get(template_id)), template_id)


if __name__ == "__main__":
    unittest.main()
