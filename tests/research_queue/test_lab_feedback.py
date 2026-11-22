"""W24 (plan-coord ruling 11-23 (6)): the lab's LAB_FEEDBACK_FACTS_V1 file goes into the queue intake and the Q1 producer merges it into the next card's fact pack, with ids of their own."""
import json, unittest
from helpers import *  # noqa
from test_q3b_templates import shipped, IDS  # noqa

SRC = {"path": "lab/RQT-LINUX-20261124-aaaa1111/feedback.json", "sha256": "a" * 64, "pointer": "/"}


def feedback(market="CN_A", sha_="a" * 64, verdict="pending"):
    return {"schema": "LAB_FEEDBACK_FACTS_V1", "card_id": "RQT-LINUX-20261124-aaaa1111", "market": market, "as_of": "2026-11-24T18:00:00+08:00",
            "facts": [{"source": dict(SRC, sha256=sha_), "at": "2026-11-24T18:00:00+08:00",
                       "value": {"candidate_id": "AIP-CNA-001", "terminal_state": "FROZEN_AWAITING_FORWARD", "verdict": verdict, "reason_codes": ["AWAITING_FORWARD"]}}]}


def pack(n=5):
    return {"schema": "REVIEW_AI_FACT_PACK_V1", "week": "2026-W48", "market": "CN_A",
            "facts": [{"id": "F-%03d" % i, "source": {"path": "runs/x/%d.json" % i, "sha256": "b" * 64, "pointer": "/"}, "at": "2026-11-27T18:00:00+08:00", "value": {"k": i}} for i in range(1, n + 1)]}


class MergeFunction(unittest.TestCase):
    def test_facts_get_ids_after_the_pack_and_keep_their_source(self):
        out = producer.merge_lab_feedback(pack(), [feedback()])
        self.assertEqual([f["id"] for f in out["facts"]][-2:], ["F-005", "F-006"])
        self.assertEqual(out["facts"][-1]["source"]["sha256"], "a" * 64)
        self.assertEqual(out["facts"][-1]["value"]["verdict"], "pending")

    def test_idempotent_and_does_not_mutate_the_input(self):
        p = pack()
        once = producer.merge_lab_feedback(p, [feedback()])
        twice = producer.merge_lab_feedback(once, [feedback()])
        self.assertEqual(once, twice, "a fact already cited (same source sha) is not added again")
        self.assertEqual(len(p["facts"]), 5)

    def test_other_market_and_malformed_files_are_ignored(self):
        out = producer.merge_lab_feedback(pack(), [feedback(market="US_EQUITY"), {"schema": "NOPE"}, feedback(sha_="c" * 64)])
        self.assertEqual(len(out["facts"]), 6)
        self.assertEqual(out["facts"][-1]["source"]["sha256"], "c" * 64)

    def test_order_is_deterministic(self):
        a = producer.merge_lab_feedback(pack(), [feedback(sha_="d" * 64), feedback(sha_="c" * 64)])
        b = producer.merge_lab_feedback(pack(), [feedback(sha_="c" * 64), feedback(sha_="d" * 64)])
        self.assertEqual(a, b)


class IntakeMerge(Base):
    def test_tick_merges_lab_feedback_files_into_the_card_task_input(self):
        d = self.cfg.inbox_dir / "fact-packs"; d.mkdir(parents=True, exist_ok=True)
        (d / "2026-W48-CN_A.json").write_text(json.dumps(pack()))
        lf = self.cfg.inbox_dir / "lab-feedback"; lf.mkdir(parents=True, exist_ok=True)
        (lf / "RQT-LINUX-20261124-aaaa1111.json").write_text(json.dumps(feedback()))
        producer.tick(self.conn, self.cfg, shipped(), at(10, 0, day=28))
        row = self.conn.execute("select admission_json from task where state='READY'").fetchone()
        self.assertIsNotNone(row)
        inputs = json.loads(row[0])["request"]["inputs"]
        merged = json.loads(pathlib.Path(inputs[0]["path"]).read_text())
        self.assertEqual(merged["facts"][-1]["id"], "F-006")
        self.assertEqual(merged["facts"][-1]["source"]["sha256"], "a" * 64)
        self.assertEqual(inputs[0]["sha256"], hashlib.sha256(pathlib.Path(inputs[0]["path"]).read_bytes()).hexdigest())
        self.assertEqual(len(json.loads((d / "2026-W48-CN_A.json").read_text())["facts"]), 5, "the producer never edits the pack it was given")

    def test_without_feedback_files_nothing_changes(self):
        d = self.cfg.inbox_dir / "fact-packs"; d.mkdir(parents=True, exist_ok=True)
        (d / "2026-W48-CN_A.json").write_text(json.dumps(pack()))
        producer.tick(self.conn, self.cfg, shipped(), at(10, 0, day=28))
        inputs = json.loads(self.conn.execute("select admission_json from task where state='READY'").fetchone()[0])["request"]["inputs"]
        self.assertEqual(inputs[0]["path"], str(d / "2026-W48-CN_A.json"))


if __name__ == "__main__":
    unittest.main()
