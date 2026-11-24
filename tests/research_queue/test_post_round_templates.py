"""#149 Package C: frozen post-round templates, pins, and user units."""
import configparser
import json
import pathlib
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


if __name__ == "__main__":
    unittest.main()
