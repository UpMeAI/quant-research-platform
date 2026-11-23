"""plan-coord ruling 11-23 13:35 (M6, revisions): ONE card task per (market, weekId); the first admitted pack wins; a later revision pack (REVIEW_AI_FACT_PACK_<M>_<week>_R1 after the base pack, or the
reverse) creates NO second task. producer.tick looks, before it creates a card task for a pack, for a card task of the same market and weekId in ANY state except the terminal-failure states
(BLOCKED_DETERMINISTIC, CANCELLED, GATE_FAIL, REFUSED_*; plan-coord 13:41 correction: FAILED is no state, CANCELLED is what follows BLOCKED): found -> the pack is skipped (`revision_skipped` in the tick stats, reason REVISION_OF_CARDED_WEEK, pack sha256 in the status); a failed earlier card
lets the revision in (the old idea ids were never delivered). Other markets and other weeks are independent. The relay still ships every pack. Packs: the synthetic desk-shaped fixtures."""
import datetime as dt, hashlib, json, pathlib, shutil, unittest
from helpers import *  # noqa
from test_q3b_templates import shipped, IDS  # noqa
from test_lab_feedback import feedback  # noqa

FIX = ROOT / "tests" / "fixtures" / "desk-fact-packs"
REASON = "REVISION_OF_CARDED_WEEK"
FREES = ("BLOCKED_DETERMINISTIC", "CANCELLED", "GATE_FAIL", "REFUSED_ADMISSION")   # the states that do NOT hold a week (plan-coord 13:41); every other core state holds it
HOLDS = tuple(s for s in core.STATES if s not in FREES)


def pack(market, revision=False, week="2031-W07"):
    host = "linux" if market == "CN_A" else "hk"
    return FIX / host / "REVIEW_AI_FACT_PACK_V1" / ("REVIEW_AI_FACT_PACK_%s_%s%s.json" % (market, week, "_R1" if revision else ""))


BASE, R1 = pack("CN_A"), pack("CN_A", True)
sha_of = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()  # noqa: E731


class Cards(Base):
    """The producer's card tasks for one market, read back from the database."""
    host = "LINUX"
    market = "CN_A"
    registry = staticmethod(shipped)

    def setUp(self):
        super().setUp()
        self.inbox = self.cfg.inbox_dir / "fact-packs"
        self.inbox.mkdir(parents=True, exist_ok=True)
        self.n = 0

    def put(self, *packs):
        for p in packs:
            shutil.copy(p, self.inbox / p.name)

    def tick(self):
        self.n += 1
        return producer.tick(self.conn, self.cfg, self.registry(), self.t0 + dt.timedelta(minutes=self.n))

    def cards(self, market=None):
        rows = self.conn.execute("select task_id, state, admission_json from task where market=? order by rowid", (market or self.market,)).fetchall()
        return [(r[0], r[1], pathlib.Path(json.loads(r[2])["request"]["inputs"][0]["path"]).name) for r in rows]

    def set_state(self, task_id, state):
        self.conn.execute("update task set state=? where task_id=?", (state, task_id))


class OneCardPerMarketAndWeek(Cards):
    def test_base_then_revision_creates_one_task(self):
        self.put(BASE)
        out = self.tick()
        self.assertEqual((out["admitted"], out.get("revision_skipped")), (1, 0))
        self.put(R1)
        out = self.tick()
        self.assertEqual((out["admitted"], out.get("revision_skipped")), (0, 1), out)
        self.assertEqual([(s, n) for _, s, n in self.cards()], [("READY", BASE.name)])

    def test_revision_then_base_creates_one_task(self):
        self.put(R1)
        self.tick()
        self.put(BASE)
        out = self.tick()
        self.assertEqual((out["admitted"], out.get("revision_skipped")), (0, 1), out)
        self.assertEqual([(s, n) for _, s, n in self.cards()], [("READY", R1.name)], "the first admitted pack wins, whichever it is")

    def test_both_new_in_one_tick_the_first_by_file_name_wins(self):
        self.put(R1, BASE)
        out = self.tick()
        self.assertEqual((out["admitted"], out.get("revision_skipped")), (1, 1), out)
        self.assertEqual([(s, n) for _, s, n in self.cards()], [("READY", BASE.name)])

    def test_stats_and_status_show_the_skip(self):
        self.put(BASE)
        self.tick()
        (task_id, _, _), = self.cards()
        self.put(R1)
        out = self.tick()
        self.assertEqual(out.get("revision_skipped"), 1)
        self.assertEqual(out.get("revision_skipped_log"), [[R1.name, REASON]])
        for _ in range(2):  # stable: the same pack is listed again, nothing else changes
            s = status.build(self.conn, self.cfg, self.t0 + dt.timedelta(minutes=10))
            self.assertEqual(s["revision_skipped"], [{"pack": R1.name, "sha256": sha_of(R1), "week": "2031-W07", "market": "CN_A", "of_task": task_id, "reason": REASON}])
            out = self.tick()
            self.assertEqual((out["admitted"], out.get("revision_skipped")), (0, 1))
        self.assertEqual(len(self.cards()), 1)
        status.write(self.conn, self.cfg, self.t0)
        self.assertEqual(json.loads(self.cfg.status_path.read_text())["revision_skipped"][0]["sha256"], sha_of(R1))

    def test_no_skip_listed_when_nothing_is_skipped(self):
        self.put(BASE)
        out = self.tick()
        self.assertEqual(out.get("revision_skipped"), 0)
        self.assertEqual(status.build(self.conn, self.cfg, self.t0)["revision_skipped"], [])

    def test_a_card_in_any_state_but_the_freeing_ones_holds_the_week(self):
        self.assertIn("SAFETY_STOP", HOLDS)
        self.assertIn("COMPLETE", HOLDS)
        self.assertEqual(sorted(set(core.STATES) - set(HOLDS)), sorted(FREES), "every core state is either freeing or holding")
        self.put(BASE)
        self.tick()
        (task_id, _, _), = self.cards()
        self.put(R1)
        for state in HOLDS:
            self.set_state(task_id, state)
            out = self.tick()
            self.assertEqual((out["admitted"], out.get("revision_skipped"), len(self.cards())), (0, 1, 1), state)

    def _revision_after_failed_first(self, state):
        self.put(BASE)
        self.tick()
        (task_id, _, _), = self.cards()
        self.set_state(task_id, state)
        self.put(R1)
        out = self.tick()
        self.assertEqual((out["admitted"], out.get("revision_skipped")), (1, 0), out)
        self.assertEqual([(s, n) for _, s, n in self.cards()], [(state, BASE.name), ("READY", R1.name)])
        out = self.tick()  # stable: no third task, nothing skipped (each pack has its own task)
        self.assertEqual((out["admitted"], out.get("revision_skipped"), len(self.cards())), (0, 0, 2))

    def test_a_blocked_first_card_lets_the_revision_in(self):
        self._revision_after_failed_first("BLOCKED_DETERMINISTIC")

    def test_a_cancelled_first_card_lets_the_revision_in(self):
        self._revision_after_failed_first("CANCELLED")

    def test_a_blocked_card_the_coordinator_then_cancels_never_holds_the_week(self):
        """BLOCKED_DETERMINISTIC -> CANCELLED is the only way out of a blocked card; the revision that arrives after the cancel must not be skipped forever."""
        self.put(BASE)
        self.tick()
        (task_id, _, _), = self.cards()
        self.set_state(task_id, "BLOCKED_DETERMINISTIC")
        self.assertEqual(self.tick().get("revision_skipped"), 0)
        self.set_state(task_id, "CANCELLED")
        self.put(R1)
        out = self.tick()
        self.assertEqual((out["admitted"], out.get("revision_skipped")), (1, 0), out)
        self.assertEqual([(s, n) for _, s, n in self.cards()], [("CANCELLED", BASE.name), ("READY", R1.name)])

    def test_a_gate_failed_first_card_lets_the_revision_in(self):
        self._revision_after_failed_first("GATE_FAIL")

    def test_a_refused_first_card_lets_the_revision_in(self):
        self._revision_after_failed_first("REFUSED_ADMISSION")

    def test_the_skip_is_not_final_the_revision_is_admitted_when_the_first_card_fails_later(self):
        self.put(BASE, R1)
        self.tick()
        (task_id, _, _), = self.cards()
        self.assertEqual(self.tick().get("revision_skipped"), 1)
        self.set_state(task_id, "BLOCKED_DETERMINISTIC")
        out = self.tick()
        self.assertEqual((out["admitted"], out.get("revision_skipped")), (1, 0), out)
        self.assertEqual([(s, n) for _, s, n in self.cards()], [("BLOCKED_DETERMINISTIC", BASE.name), ("READY", R1.name)])

    def test_another_week_of_the_same_market_is_independent(self):
        self.put(BASE)
        self.tick()
        other = self.inbox / "REVIEW_AI_FACT_PACK_CN_A_2031-W08.json"
        other.write_text(json.dumps(dict(json.loads(BASE.read_text()), weekId="2031-W08")))
        out = self.tick()
        self.assertEqual((out["admitted"], out.get("revision_skipped")), (1, 0), out)
        self.assertEqual(len(self.cards()), 2)

    def test_a_skipped_pack_takes_no_lab_feedback(self):
        lf = self.cfg.inbox_dir / "lab-feedback"
        lf.mkdir(parents=True, exist_ok=True)
        (lf / "RQT-LINUX-20261124-aaaa1111.json").write_text(json.dumps(feedback()))
        self.put(BASE)
        self.tick()
        (lf / "RQT-LINUX-20261125-bbbb2222.json").write_text(json.dumps(feedback(sha_="c" * 64)))
        self.put(R1)
        self.assertEqual(self.tick().get("revision_skipped"), 1)
        state = json.loads((self.cfg.inbox_dir / "lab-feedback-state.json").read_text())
        self.assertEqual(sorted(state["packs"]), [BASE.name], "the skipped pack was not seen: it holds no feedback set")


class OneCardPerMarketAndWeekHk(Cards):
    """HK: US_EQUITY and CRYPTO of the same week are independent markets (a stub pinned card template stands in for the HK pins, which are not merged yet)."""
    host = "HK"
    market = "US_EQUITY"
    registry = staticmethod(lambda: registry([net_tpl("T-STUB-AI-REVIEW-CARD-HK", prompt_admission_sha256=sha("prompt"), params={}, argv=[PY, STUB, "ok"])]))

    def test_same_week_two_markets_two_tasks_and_each_revision_is_skipped(self):
        self.put(pack("US_EQUITY"), pack("CRYPTO"))
        out = self.tick()
        self.assertEqual((out["admitted"], out.get("revision_skipped")), (2, 0), out)
        self.assertEqual([len(self.cards("US_EQUITY")), len(self.cards("CRYPTO"))], [1, 1])
        self.put(pack("US_EQUITY", True), pack("CRYPTO", True))
        out = self.tick()
        self.assertEqual((out["admitted"], out.get("revision_skipped")), (0, 2), out)
        self.assertEqual(sorted(n for _, n in out["revision_skipped_log"]), [REASON, REASON])
        self.assertEqual([len(self.cards("US_EQUITY")), len(self.cards("CRYPTO"))], [1, 1])
        self.assertEqual(sorted(x["market"] for x in status.build(self.conn, self.cfg, self.t0)["revision_skipped"]), ["CRYPTO", "US_EQUITY"])


if __name__ == "__main__":
    unittest.main()
