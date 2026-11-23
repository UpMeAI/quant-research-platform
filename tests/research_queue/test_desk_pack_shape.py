"""AQ <-> desk: REVIEW_AI_FACT_PACK_V1 packs in the REAL shape the desk producer writes (ops/review-loop/ai-review-facts.cjs, desk PR #131) through the Mac relay and the host producer's inbox intake.
The packs are tests/fixtures/desk-fact-packs/: the desk producer's own output for two SYNTHETIC week files (made-up ids, texts, dates; plan-coord ruling 11-23 13:35: no real desk content in this public
repo); MANIFEST.json holds their sha256 and how they were made. The desk writes `contract` (not `schema`) and `weekId` (not `week`); QRP's own fixtures used `schema` and `week`, so every desk pack was
refused ("SCHEMA") by the relay and counted unreadable by the producer. Also here: one card task per (market, weekId) (plan-coord M6 ruling 11-23 13:35). JS side: tests/research_queue_desk_pack.test.js."""
import hashlib, json, pathlib, shutil, tempfile, unittest
from helpers import *  # noqa
from rq import relay
from test_q3b_templates import shipped, IDS  # noqa
from test_lab_feedback import feedback  # noqa
from test_relay import StubTransport  # noqa

FIX = ROOT / "tests" / "fixtures" / "desk-fact-packs"
MANIFEST = json.loads((FIX / "MANIFEST.json").read_text())
REAL = sorted(FIX.glob("*/REVIEW_AI_FACT_PACK_V1/*.json"))
CN_R1 = FIX / "linux" / "REVIEW_AI_FACT_PACK_V1" / "REVIEW_AI_FACT_PACK_CN_A_2031-W07_R1.json"
CN_R0 = FIX / "linux" / "REVIEW_AI_FACT_PACK_V1" / "REVIEW_AI_FACT_PACK_CN_A_2031-W07.json"
US_R1 = FIX / "hk" / "REVIEW_AI_FACT_PACK_V1" / "REVIEW_AI_FACT_PACK_US_EQUITY_2031-W07_R1.json"
CRYPTO_R1 = FIX / "hk" / "REVIEW_AI_FACT_PACK_V1" / "REVIEW_AI_FACT_PACK_CRYPTO_2031-W07_R1.json"


def mutated(path, **over):
    j = json.loads(path.read_text())
    for k, v in over.items():
        if v is None:
            j.pop(k, None)
        else:
            j[k] = v
    return json.dumps(j).encode()


class Fixtures(unittest.TestCase):
    def test_six_desk_shaped_packs_byte_for_byte_the_manifest_made_from_synthetic_weeks(self):
        self.assertEqual(len(REAL), 6)
        self.assertEqual(sorted(str(p.relative_to(FIX)) for p in REAL), sorted(MANIFEST["packs"]))
        for rel, sha in MANIFEST["week_files"].items():
            self.assertEqual(hashlib.sha256((FIX / rel).read_bytes()).hexdigest(), sha, rel)
        for p in REAL:
            self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(), MANIFEST["packs"][str(p.relative_to(FIX))], p.name)
            j = json.loads(p.read_text())
            self.assertRegex(j["sourceWeek"]["file"], r"^REVIEW_LOOP_WEEK_2031-W07(_R1)?\.json$", "a synthetic week (2031), nothing real")
            self.assertEqual(j["contract"], "REVIEW_AI_FACT_PACK_V1")
            for k in ("schema", "week", "week_id"):
                self.assertNotIn(k, j, "%s: the desk header has no %s" % (p.name, k))


class PackShape(unittest.TestCase):
    """The one reading of the header (rq/packshape.py), used by the relay and the producer."""

    def test_schema_is_schema_or_contract_with_the_same_value_check(self):
        from rq import packshape
        S = "REVIEW_AI_FACT_PACK_V1"
        self.assertTrue(packshape.schema_ok({"schema": S}))
        self.assertTrue(packshape.schema_ok({"contract": S}))
        self.assertTrue(packshape.schema_ok({"schema": S, "contract": S}))
        for bad in ({}, {"schema": "OTHER"}, {"contract": "OTHER"}, {"schema": S, "contract": "OTHER"}, {"schema": "OTHER", "contract": S}, {"schema": None}, {"contract": ""}, {"schema": [S]}, None, [], "x"):
            self.assertFalse(packshape.schema_ok(bad), repr(bad))

    def test_week_is_week_weekId_or_week_id_and_aliases_must_agree(self):
        from rq import packshape
        self.assertEqual(packshape.week_of({"week": "2026-W47"}), "2026-W47")
        self.assertEqual(packshape.week_of({"weekId": "2031-W07"}), "2031-W07")
        self.assertEqual(packshape.week_of({"week_id": "2031-W07"}), "2031-W07")
        self.assertEqual(packshape.week_of({"week": "2026-W47", "weekId": "2026-W47", "week_id": "2026-W47"}), "2026-W47")
        for bad in ({}, {"week": ""}, {"weekId": 46}, {"week": None}, {"week": "2026-W47", "weekId": "2026-W48"}, None, [], "x"):
            self.assertIsNone(packshape.week_of(bad), repr(bad))
        for p in REAL:
            self.assertEqual(packshape.week_of(json.loads(p.read_text())), "2031-W07")


class RelayReal(unittest.TestCase):
    def test_every_real_pack_passes_the_relay_check(self):
        for p in REAL:
            self.assertIsNone(relay._valid_pack(p.read_bytes()), p.name)

    def test_relay_check_header_rules(self):
        self.assertEqual(relay._valid_pack(mutated(CN_R1, contract="OTHER")), "SCHEMA")
        self.assertEqual(relay._valid_pack(mutated(CN_R1, contract=None)), "SCHEMA")
        self.assertEqual(relay._valid_pack(mutated(CN_R1, schema="OTHER")), "SCHEMA", "a wrong schema is not rescued by a right contract")
        self.assertEqual(relay._valid_pack(mutated(CN_R1, schema="REVIEW_AI_FACT_PACK_V1")), None)
        self.assertEqual(relay._valid_pack(mutated(CN_R1, contract=None, schema="REVIEW_AI_FACT_PACK_V1")), None, "the QRP shape is still accepted")
        self.assertEqual(relay._valid_pack(b"{"), "NOT_JSON")
        self.assertEqual(relay._valid_pack(CN_R1.read_bytes() + b" sk-" + b"Ab12" * 6), "SECRET_PATTERN")

    def test_relay_pass_ships_each_real_pack_to_its_hosts_inbox_only(self):
        with tempfile.TemporaryDirectory() as t:
            r = pathlib.Path(t)
            shutil.copytree(FIX, r / "desk", ignore=shutil.ignore_patterns("MANIFEST.json", "weeks", "*.cjs"))
            cfg = dict(relay.DEFAULT_CONFIG, outbox_root=str(r / "desk"), return_root=str(r / "qrp"), state_path=str(r / "state.json"))
            cfg["hosts"] = {"linux": dict(relay.DEFAULT_CONFIG["hosts"]["linux"], outbox="/outbox"), "hk": dict(relay.DEFAULT_CONFIG["hosts"]["hk"], outbox="/outbox")}
            out = relay.run(cfg, StubTransport(r / "remote"))
            self.assertEqual(out["refused"], [])
            self.assertEqual(out["failed"], [])
            self.assertEqual(sorted(n for _, n in out["pushed"]), sorted(p.name for p in REAL))
            lin = sorted(x.name for x in (r / "remote/linux/srv/research-lane/research-queue/inbox/fact-packs").glob("*.json"))
            hk = sorted(x.name for x in (r / "remote/hk/var/lib/research-queue/inbox/fact-packs").glob("*.json"))
            self.assertEqual(lin, [CN_R0.name, CN_R1.name])
            self.assertEqual(len(hk), 4)
            self.assertTrue(all("_CN_A_" not in n for n in hk))
            self.assertEqual((r / "remote/linux/srv/research-lane/research-queue/inbox/fact-packs" / CN_R1.name).read_bytes(), CN_R1.read_bytes(), "byte for byte")
            again = relay.run(cfg, StubTransport(r / "remote"))
            self.assertEqual(again["pushed"], [], "idempotent by sha")


class ProducerLinuxReal(Base):
    host = "LINUX"

    def _inbox(self, *packs):
        d = self.cfg.inbox_dir / "fact-packs"
        d.mkdir(parents=True, exist_ok=True)
        for p in packs:
            shutil.copy(p, d / p.name)
        return d

    def _tasks(self):
        return self.conn.execute("select market, state, template_id, admission_json from task order by task_id").fetchall()

    def _check_admitted(self, pack):
        d = self._inbox(pack)
        out = producer.tick(self.conn, self.cfg, shipped(), self.t0)
        self.assertEqual((out["unreadable"], out["admitted"], out["refused"]), (0, 1, 0), out)
        (market, state, template, adm), = self._tasks()
        self.assertEqual((market, state, template), ("CN_A", "READY", IDS[0]))
        req = json.loads(adm)["request"]
        self.assertEqual(req["subject"]["week"], "2031-W07")
        self.assertEqual(req["subject"]["market"], "CN_A")
        self.assertEqual(req["subject"]["fact_pack_sha256"], hashlib.sha256(pack.read_bytes()).hexdigest())
        self.assertEqual(req["inputs"], [{"path": str(d / pack.name), "sha256": hashlib.sha256(pack.read_bytes()).hexdigest()}])
        again = producer.tick(self.conn, self.cfg, shipped(), self.t0)
        self.assertEqual((again["admitted"], again["unreadable"]), (0, 0))
        self.assertEqual(len(self._tasks()), 1, "idempotent: one card task per delivered pack")

    def test_cn_a_week_pack_is_admitted_as_a_card_task(self):
        self._check_admitted(CN_R0)

    def test_cn_a_revision_pack_is_admitted_as_a_card_task(self):
        self._check_admitted(CN_R1)

    def test_a_pack_without_a_usable_header_is_still_unreadable(self):
        d = self.cfg.inbox_dir / "fact-packs"
        d.mkdir(parents=True, exist_ok=True)
        (d / "no_contract.json").write_bytes(mutated(CN_R1, contract=None))
        (d / "wrong_contract.json").write_bytes(mutated(CN_R1, contract="OTHER"))
        (d / "no_week.json").write_bytes(mutated(CN_R1, weekId=None))
        (d / "week_conflict.json").write_bytes(mutated(CN_R1, week="2026-W47"))
        out = producer.tick(self.conn, self.cfg, shipped(), self.t0)
        self.assertEqual((out["unreadable"], out["admitted"], len(self._tasks())), (4, 0, 0))

    def test_lab_feedback_joins_a_real_pack_with_ids_after_the_desks(self):
        d = self._inbox(CN_R1)
        lf = self.cfg.inbox_dir / "lab-feedback"
        lf.mkdir(parents=True, exist_ok=True)
        (lf / "RQT-LINUX-20261124-aaaa1111.json").write_text(json.dumps(feedback()))
        producer.tick(self.conn, self.cfg, shipped(), self.t0)
        (market, state, template, adm), = self._tasks()
        self.assertEqual(state, "READY")
        inputs = json.loads(adm)["request"]["inputs"]
        merged = json.loads(pathlib.Path(inputs[0]["path"]).read_text())
        real = json.loads(CN_R1.read_text())
        self.assertEqual(len(merged["facts"]), len(real["facts"]) + 1)
        self.assertEqual(merged["facts"][-1]["id"], "F-%03d" % (len(real["facts"]) + 1))
        self.assertEqual(merged["facts"][:len(real["facts"])], real["facts"], "the desk's facts are untouched")
        for k in ("contract", "weekId", "market", "revision", "hash", "sourceWeek"):
            self.assertEqual(merged[k], real[k], k)
        self.assertEqual(json.loads(adm)["request"]["subject"]["week"], "2031-W07")
        self.assertEqual((d / CN_R1.name).read_bytes(), CN_R1.read_bytes(), "the producer never edits the pack it was given")


class ProducerHkReal(Base):
    host = "HK"

    def test_us_and_crypto_real_packs_are_read_not_unreadable(self):
        d = self.cfg.inbox_dir / "fact-packs"
        d.mkdir(parents=True, exist_ok=True)
        for p in (US_R1, CRYPTO_R1):
            shutil.copy(p, d / p.name)
        out = producer.tick(self.conn, self.cfg, shipped(), self.t0)
        self.assertEqual(out["unreadable"], 0, out)
        rows = self.conn.execute("select market, state from task order by market").fetchall()
        self.assertEqual([r[0] for r in rows], ["CRYPTO", "US_EQUITY"], "each pack reaches admission (READY once the HK templates are pinned, refused until then)")


if __name__ == "__main__":
    unittest.main()
