import datetime as dt
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE_DIR = ROOT / "services" / "rf1116-post-round"


def load(name):
    spec = importlib.util.spec_from_file_location(name, MODULE_DIR / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


post_round = load("post_round")
lexicon_copy = load("lexicon_copy")


def canon(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(value):
    raw = value if isinstance(value, bytes) else value.encode()
    return hashlib.sha256(raw).hexdigest()


class Runner:
    def __init__(self, survivors=None, ledger_path=None):
        self.survivors = survivors or []
        self.ledger_path = pathlib.Path(ledger_path) if ledger_path else None
        self.registered = []
        self.calls = []
        self.register_fail_after = None
        self.review_error = None
        self.review = None
        self.real_list_shape = False

    def view(self):
        registered = {row["candidate_id"]: row for row in self.registered}
        registration_hashes = {}
        if self.ledger_path and self.ledger_path.exists():
            for line in self.ledger_path.read_text().splitlines():
                row = json.loads(line)
                registration_hashes[row["candidate_id"]] = row["record_hash"]
        survivors = []
        for row in self.survivors:
            reg = registered.get(row["candidate_id"])
            survivors.append({**row, "registered": reg is not None,
                              "mechanism_id": reg.get("mechanism_id") if reg else None,
                              "written_at": reg.get("written_at") if reg else None})
        items = [{"candidate_id": row["candidate_id"],
                  "registration_hash": registration_hashes.get(row["candidate_id"], sha(canon(row)))
                  if row["candidate_id"] in registered else None}
                 for row in sorted(self.survivors, key=lambda x: x["candidate_id"])]
        return {"survivors": survivors, "registered": [] if self.real_list_shape else list(self.registered),
                "mechanism_set_sha256": sha(canon(items)), "review": self.review}

    def __call__(self, action, round_id, file=None):
        self.calls.append((action, round_id, pathlib.Path(file).name if file else None))
        if action == "mechanisms" and file is None:
            return self.view()
        if action == "mechanisms":
            rows = [json.loads(x) for x in pathlib.Path(file).read_text().splitlines() if x]
            limit = self.register_fail_after if self.register_fail_after is not None else len(rows)
            accepted = rows[:limit]
            self.registered.extend(accepted)
            if self.ledger_path:
                self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
                with self.ledger_path.open("a") as fh:
                    for row in accepted:
                        body = {**row, "round_id": round_id}
                        fh.write(canon({**body, "record_hash": sha(canon(body))}) + "\n")
            if limit < len(rows):
                raise post_round.RunnerError("REGISTER_EXIT_1")
            return {"registered": list(self.registered)}
        if action == "review":
            if self.review_error:
                raise post_round.RunnerError(self.review_error)
            self.review = json.loads(pathlib.Path(file).read_text())
            return {"ok": True, "mechanism_set_sha256": self.review["mechanism_set_sha256"]}
        raise AssertionError(action)


class PostRoundTest(unittest.TestCase):
    NOW = dt.datetime(2026, 11, 24, 14, 0, tzinfo=dt.timezone(dt.timedelta(hours=8)))
    ROUND = "MR-CN_A-2026-11-a6cb823f86"

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        for name in ("ledger/research", "out/rounds", "post", "inbox/requests", "inbox/mech-packs", "state", "runs"):
            (self.tmp / name).mkdir(parents=True, exist_ok=True)
        self.selection = {"candidates": []}
        self.selection_file = self.tmp / "out/rounds" / self.ROUND / "selection.json"
        self.selection_file.parent.mkdir(parents=True)
        self.selection_file.write_text(canon(self.selection))
        (self.tmp / "register.json").write_text(canon({"mechanisms": [
            {"mechanism_id": "SEL.XSEC.VALUE", "title_zh": "估值截面", "description_zh": "估值字段的截面排序", "layer": "SELECTION_TIMING", "decision_point": "SELECT"}
        ]}))
        (self.tmp / "space.json").write_text(canon({"fields": {"pb": {"zh": "市净率"}}, "operators": {"ts_std": {"zh": "滚动标准差"}}}))
        (self.tmp / ".QRP_COMMIT").write_text("f6c4793\n")
        (self.tmp / "model_gate.json").write_text(canon({"verdict": "PASS", "at": "2026-11-24T13:00:00+08:00"}))
        (self.tmp / "blackouts.json").write_text(canon({"windows": []}))
        self.cfg = post_round.Config(
            data_dir=self.tmp / "ledger", lane_out=self.tmp / "out", post_root=self.tmp / "post",
            inbox=self.tmp / "inbox", state_dir=self.tmp / "state", runs_dir=self.tmp / "runs",
            model_gate_file=self.tmp / "model_gate.json", register_file=self.tmp / "register.json",
            space_file=self.tmp / "space.json", code_commit_file=self.tmp / ".QRP_COMMIT",
            blackouts_file=self.tmp / "blackouts.json", selection_space_sha256="0d3556fa",
            note_template_id="T-NOTE", note_template_sha256="1" * 64,
            review_template_id="T-REVIEW", review_template_sha256="2" * 64,
        )
        self.task_rows = []

    def write_rows(self, name, rows):
        p = self.tmp / "ledger/research" / name
        p.write_text("\n".join(canon(x) for x in rows))  # deliberately no trailing newline

    def seed(self, selected, neutralization="RANK_GAUSS_V2", status="OPEN", selection_sha=None, holdout=False):
        self.selection = {"candidates": [
            {"candidate_id": cid, "mean_ic": 0.03, "positive_folds": 3,
             "validation_book": {"monthly_d": [float(i), float(i + 1)]}}
            for i, cid in enumerate(selected)
        ]}
        self.selection_file.write_text(canon(self.selection))
        self.write_rows("mining_selections.jsonl", [{"round_id": self.ROUND, "selected": selected,
            "selection_sha256": selection_sha or sha(self.selection_file.read_bytes()), "record_hash": "sel-hash"}])
        row = {"round_id": self.ROUND, "status": status}
        if neutralization is not None:
            row["scoring_neutralization"] = neutralization
        self.write_rows("mining_rounds.jsonl", [row])
        self.write_rows("holdout_vault.jsonl", [{"round_id": self.ROUND, "action": "OPEN"}] if holdout else [])

    def survivors(self, n):
        return [{"candidate_id": "A%03d" % i, "formula": "(-ts_std(pb,10))", "mining_score": .8,
                 "validation_mean_ic": .03, "positive_folds": 3, "holdout_score": 9}
                for i in range(1, n + 1)]

    def request_idem(self, request):
        return sha(canon({"template_id": request["template_id"], "template_sha256": request["template_sha256"],
                          "subject": request.get("subject") or {}, "params": request.get("params") or {}}))

    def write_task(self, request, output_key, output_body, state="COMPLETE", attempt_no=1, task_id=None):
        idem = self.request_idem(request)
        task_id = task_id or ("RQT-LINUX-20261124-%s" % idem[:8])
        row = {"task_id": task_id, "idem_key": idem, "state": state, "attempt_no": attempt_no}
        self.task_rows.append(row)
        (self.tmp / "state/status.json").write_text(canon({"schema": "RQ_STATUS_V1", "tasks": self.task_rows}))
        if attempt_no > 0 and output_body is not None:
            output = {"task_id": task_id, **output_body}
            output_sha = sha(canon(output))
            result = {"schema": "RQ_AGENT_RESULT_V1", "task_id": task_id, "kind": request["kind"],
                      "status": "DONE", "at": "2026-11-24T06:00:00Z",
                      "validator": {"ok": True, "sha256": output_sha},
                      "outputs": {output_key: output, output_key + "_sha256": output_sha}}
            path = self.tmp / "runs" / task_id / ("attempt-%d" % attempt_no) / "result.json"
            path.parent.mkdir(parents=True)
            path.write_text(canon(result))
        return row

    def test_b01_no_selection_is_noop(self):
        r = Runner()
        self.assertEqual(post_round.PostRound(self.cfg, r, lambda: self.NOW).tick(), {})
        self.assertEqual(list((self.tmp / "post").iterdir()), [])
        self.assertEqual(r.calls, [])

    def test_b02_pack_six_six_one_firewall_and_idempotence(self):
        s = self.survivors(13)
        self.seed([x["candidate_id"] for x in s])
        r = Runner(s)
        p = post_round.PostRound(self.cfg, r, lambda: self.NOW)
        self.assertEqual(p.tick()[self.ROUND], "NOTES_ENQUEUED")
        packs = sorted((self.tmp / "inbox/mech-packs").glob("note-*.json"))
        self.assertEqual([len(json.loads(x.read_text())["candidates"]) for x in packs], [6, 6, 1])
        for pack in packs:
            self.assertNotRegex(pack.read_text().lower(), r"score|ic|fold|holdout|gate|return|pnl")
        reqs = sorted((self.tmp / "inbox/requests").glob("*.json"))
        self.assertEqual(len(reqs), 3)
        p.tick()
        self.assertEqual(sorted((self.tmp / "inbox/requests").glob("*.json")), reqs)

    def test_b02_real_scale_191_is_32_packs_and_structurally_bounded(self):
        packs = post_round.build_note_packs(self.ROUND, self.survivors(191), {"selection_record_hash": "x"}, [], [])
        self.assertEqual(len(packs), 32)
        self.assertLessEqual(len(packs) * 5, 170)
        self.assertTrue(all(1 <= len(p["candidates"]) <= 6 for p in packs))

    def test_b03_legacy_or_missing_neutralization_stops_and_alerts_once(self):
        for value in ("LINEAR_RAW_V1", None):
            with self.subTest(value=value):
                shutil.rmtree(self.tmp / "post", ignore_errors=True); (self.tmp / "post").mkdir()
                (self.tmp / "state/alerts.jsonl").unlink(missing_ok=True)
                self.seed(["A001"], neutralization=value)
                p = post_round.PostRound(self.cfg, Runner(self.survivors(1)), lambda: self.NOW)
                self.assertEqual(p.tick()[self.ROUND], "STOPPED_LEGACY_ROUND")
                p.tick()
                self.assertEqual(len((self.tmp / "state/alerts.jsonl").read_text().splitlines()), 1)
                self.assertEqual(list((self.tmp / "inbox/requests").glob("*.json")), [])

    def test_b04_holdout_open_stops(self):
        self.seed(["A001"], holdout=True)
        out = post_round.PostRound(self.cfg, Runner(self.survivors(1)), lambda: self.NOW).tick()
        self.assertEqual(out[self.ROUND], "STOPPED_AFTER_HOLDOUT_OPEN")

    def test_b05_deterministic_note_checks_and_written_at(self):
        notes = [
            {"candidate_id": "A00%d" % i, "outcome": "NOTE", "mechanism_id": "SEL.XSEC.VALUE",
             "economic_logic_zh": "市净率的截面差异能够反映估值锚定偏离程度与再定价摩擦", "failure_mode_zh": "极端行业结构变化时关系可能失真",
             "fields_cited": ["pb"], "no_mechanism_code": None, "proposal": None}
            for i in range(1, 5)
        ]
        notes += [dict(notes[0], candidate_id="A005", economic_logic_zh="小市值效应解释这一公式的差异"),
                  {"candidate_id": "A006", "outcome": "NO_MECHANISM", "mechanism_id": None,
                   "economic_logic_zh": None, "failure_mode_zh": None, "fields_cited": [],
                   "no_mechanism_code": "NONE_FITS", "proposal": None}]
        result = post_round.evaluate_notes(notes, {"A00%d" % i: "(-ts_std(pb,10))" for i in range(1, 7)},
                                           {"SEL.XSEC.VALUE"}, "2026-11-24T06:00:00Z", self.NOW)
        self.assertEqual(len(result["registrations"]), 4)
        self.assertTrue(all(x["written_at"] == "2026-11-24T14:00:00+08:00" for x in result["registrations"]))
        self.assertEqual({x["note"] for x in result["dispositions"]}, {"D05:SIZE_AS_MECHANISM", "NO_MECHANISM:NONE_FITS"})

    def test_b06_list_before_write_and_resume_only_remaining(self):
        rows = [{"candidate_id": "A00%d" % i, "mechanism_id": "SEL.XSEC.VALUE", "written_at": "2026-11-24T14:00:00+08:00"} for i in range(1, 5)]
        r = Runner(self.survivors(4)); r.register_fail_after = 3
        d = self.tmp / "post" / self.ROUND; d.mkdir()
        with self.assertRaises(post_round.RunnerError):
            post_round.register_remaining(r, self.ROUND, d, rows)
        r.register_fail_after = None
        post_round.register_remaining(r, self.ROUND, d, rows)
        writes = [c for c in r.calls if c[0] == "mechanisms" and c[2]]
        self.assertEqual(len(writes), 2)
        self.assertEqual(len([json.loads(x) for x in (d / writes[-1][2]).read_text().splitlines()]), 1)
        self.assertEqual(len({x["candidate_id"] for x in r.registered}), 4)

    def test_b07_rank_equivalence_rejects_larger_id(self):
        sel = {"candidates": [{"candidate_id": "A002", "validation_book": {"monthly_d": [1, 2.0]}},
                              {"candidate_id": "A001", "validation_book": {"monthly_d": [1 + 1e-13, 2]}}]}
        self.assertEqual(post_round.rank_equivalent_duplicates(sel), {"A002": "A001"})

    def test_b08_mapping_table_and_research_state_closed(self):
        cases = [
            ({"registered": False, "ai_note_outcome": "NO_MECHANISM", "no_mechanism_code": "DEGENERATE"}, "REJECTED", "NO_MECHANISM:DEGENERATE", "暂停"),
            ({"registered": False, "ai_note_outcome": "NEW_MECHANISM_PROPOSAL"}, "REJECTED", "WAITING_EXTERNAL:MECHANISM_ADMISSION", "暂停"),
            ({"registered": False, "d_failure": "D05:WORDING"}, "REJECTED", "D05:WORDING", "暂停"),
            ({"registered": False, "note_blocked": True}, "REJECTED", "AI_NOTE_BLOCKED", "暂停"),
            ({"registered": True, "duplicate_of": "A001"}, "REJECTED", "DUPLICATE_RANK_EQUIVALENT:A001", "暂停"),
            ({"registered": True, "review_status": "HOLD", "review_code": "HOLD_MECHANISM_MISMATCH"}, "REJECTED", "AI_REVIEW_HOLD:HOLD_MECHANISM_MISMATCH", "暂停"),
            ({"registered": True, "review_blocked": True}, "REJECTED", "AI_REVIEW_BLOCKED", "暂停"),
            ({"registered": True, "review_status": "CONSISTENT"}, "APPROVED", "AQ_POST_ROUND_V1", "做"),
        ]
        for facts, verdict, note, state in cases:
            self.assertEqual(post_round.map_disposition(facts), (verdict, note, state))

    def test_b09_review_refusal_stops_and_is_not_retried(self):
        r = Runner(); r.review_error = "MINE_MECHANISM_REVIEW_SET_CHANGED"
        d = self.tmp / "post" / self.ROUND; d.mkdir()
        p = d / "verdicts.json"; p.write_text("[]")
        self.assertEqual(post_round.record_review(r, self.ROUND, p), "STOPPED_REVIEW_REFUSED:MINE_MECHANISM_REVIEW_SET_CHANGED")
        self.assertEqual(len([x for x in r.calls if x[0] == "review"]), 1)

    def test_b10_blocked_batch_repacked_once_then_rejected(self):
        batch = {"batch_no": 1, "candidates": [{"candidate_id": "A001"}, {"candidate_id": "A002"}]}
        singles = post_round.repack_blocked(batch)
        self.assertEqual([len(x["candidates"]) for x in singles], [1, 1])
        self.assertEqual(post_round.repack_blocked(singles[0]), [])
        self.assertEqual(post_round.map_disposition({"registered": False, "note_blocked": True})[1], "AI_NOTE_BLOCKED")

    def test_b11_wait_is_wait_not_rejection(self):
        self.assertEqual(post_round.classify_tasks([{"state": "COMPLETE"}, {"state": "WAITING_QUOTA"}]), "WAITING_AQ")
        self.assertEqual(post_round.classify_tasks([{"state": "READY"}]), "WAITING_AQ")

    def test_b12_deadline_known_alerts_once_unknown_does_not(self):
        alerts = set()
        self.assertEqual(post_round.deadline_state(self.NOW.replace(year=2027), "2026-12-31", False, alerts, self.ROUND), "POST_ROUND_REVIEW_LATE")
        self.assertEqual(post_round.deadline_state(self.NOW.replace(year=2027), "2026-12-31", False, alerts, self.ROUND), "POST_ROUND_REVIEW_LATE")
        self.assertEqual(len(alerts), 1)
        self.assertEqual(post_round.deadline_state(self.NOW, "UNKNOWN", False, alerts, "R2"), "DEADLINE_UNKNOWN")
        self.assertEqual(len(alerts), 1)

    def test_b13_selection_hash_mismatch(self):
        self.seed(["A001"], selection_sha="0" * 64)
        out = post_round.PostRound(self.cfg, Runner(self.survivors(1)), lambda: self.NOW).tick()
        self.assertEqual(out[self.ROUND], "STOPPED_SELECTION_FILE_MISMATCH")

    def test_b14_hash_chain_tamper_is_refused_and_alerted(self):
        d = self.tmp / "post" / self.ROUND; d.mkdir()
        led = post_round.HashLedger(d / "POST_ROUND_LEDGER.jsonl")
        led.append({"state": "DETECTED", "round_id": self.ROUND, "at": "x"})
        self.assertEqual(led.verify()["state"], "DETECTED")
        text = led.path.read_text().replace("DETECTED", "DONE")
        led.path.write_text(text)
        with self.assertRaises(post_round.LedgerTampered):
            led.verify()

    def test_b15_zero_selected_is_distinct(self):
        self.seed([])
        out = post_round.PostRound(self.cfg, Runner(), lambda: self.NOW).tick()
        self.assertEqual(out[self.ROUND], "NOT_APPLICABLE_ZERO_SELECTED")
        self.assertTrue((self.tmp / "post" / self.ROUND / "POST_ROUND_LEDGER.jsonl").exists())

    def test_b16_python_lexicon_matches_js_terms(self):
        js = (ROOT / "services/research-queue-agent/lexicon.js").read_text()
        for name in ("PREDICTION", "VERDICT", "DIRECTION"):
            block = js.split("const %s = [" % name, 1)[1].split("];", 1)[0]
            import re
            terms = re.findall(r"\[['\"]([^'\"]+)['\"],\s*/", block)
            self.assertEqual(terms, getattr(lexicon_copy, name + "_TERMS"))

    def test_b17_blackout_tick_is_read_only(self):
        self.seed(["A001"])
        (self.tmp / "blackouts.json").write_text(canon({"windows": [{"id": "X", "start": "13:00", "end": "15:00", "tz": "+08:00"}]}))
        r = Runner(self.survivors(1))
        out = post_round.PostRound(self.cfg, r, lambda: self.NOW).tick()
        self.assertEqual(out[self.ROUND], "BLACKOUT_READ_ONLY")
        self.assertEqual(list((self.tmp / "inbox/requests").glob("*.json")), [])
        self.assertEqual(r.calls, [])

    def test_b18_task_view_uses_full_idem_and_authoritative_attempt_result(self):
        request = {"template_id": "T-NOTE", "template_sha256": "1" * 64, "kind": "AI_MECH_NOTE",
                   "subject": {"round_id": self.ROUND, "batch_no": 1, "pack_sha256": "3" * 64}, "params": {}}
        body = {"schema": "RF1116_MECH_NOTE_OUTPUT_V1", "round_id": self.ROUND, "batch_no": 1, "notes": []}
        task = self.write_task(request, "mechanism_notes", body, attempt_no=2)
        decoy = self.tmp / "runs" / task["task_id"] / "attempt-1" / "result.json"
        decoy.parent.mkdir(parents=True)
        decoy.write_text("not the authoritative attempt")
        status = json.loads((self.tmp / "state/status.json").read_text())
        self.assertEqual(post_round.request_idem(request), task["idem_key"])
        resolved = post_round.resolve_task(status, request)
        loaded = post_round.read_task_result(self.cfg.runs_dir, resolved, request, "mechanism_notes")
        self.assertEqual(loaded["output"]["round_id"], self.ROUND)
        self.assertEqual(loaded["task"]["attempt_no"], 2)

    def test_b19_missing_zero_ambiguous_and_open_task_rows_fail_closed(self):
        request = {"template_id": "T-NOTE", "template_sha256": "1" * 64, "kind": "AI_MECH_NOTE",
                   "subject": {"round_id": self.ROUND, "batch_no": 1, "pack_sha256": "3" * 64}, "params": {}}
        idem = self.request_idem(request)
        good = {"task_id": "RQT-LINUX-20261124-%s" % idem[:8], "idem_key": idem, "state": "READY", "attempt_no": 0}
        cases = [
            ({"schema": "RQ_STATUS_V1"}, "RQ_STATUS_TASKS_MISSING"),
            ({"schema": "RQ_STATUS_V1", "tasks": []}, "RQ_TASK_NOT_FOUND"),
            ({"schema": "RQ_STATUS_V1", "tasks": [good, {**good, "task_id": "RQT-LINUX-20261125-%s" % idem[:8]}]}, "RQ_TASK_AMBIGUOUS"),
            ({"schema": "RQ_STATUS_V1", "tasks": [{**good, "extra": True}]}, "RQ_STATUS_TASK_SHAPE"),
        ]
        for status, code in cases:
            with self.subTest(code=code), self.assertRaisesRegex(post_round.TaskAuthorityError, code):
                post_round.resolve_task(status, request)
        with self.assertRaisesRegex(post_round.TaskAuthorityError, "RQ_TASK_ATTEMPT_NOT_STARTED"):
            post_round.read_task_result(self.cfg.runs_dir, {**good, "state": "COMPLETE"}, request, "mechanism_notes")

    def test_b20_runner_subprocess_environment_is_an_exact_nonsecret_allowlist(self):
        proc = mock.Mock(returncode=0, stdout="{}", stderr="")
        ambient = {"PATH": "/usr/bin", "LANG": "C.UTF-8", "LC_ALL": "C", "RF1116_RUNNER_IMAGE": "qrp-round-runner:abc123",
                   "HOME": "/must-not-leak", "DEEPSEEK_API_KEY": "sk-" + "x" * 20, "UNRELATED": "no"}
        with mock.patch.dict(os.environ, ambient, clear=True), mock.patch.object(post_round.subprocess, "run", return_value=proc) as run_mock:
            post_round._runner(pathlib.Path("/runner"))("mechanisms", self.ROUND)
        self.assertEqual(run_mock.call_args.kwargs["env"], {k: ambient[k] for k in ("PATH", "LANG", "LC_ALL", "RF1116_RUNNER_IMAGE")})

    def test_b21_end_to_end_status_results_registration_review_and_done(self):
        survivors = self.survivors(1)
        self.seed(["A001"])
        runner = Runner(survivors, self.tmp / "ledger/research/mining_mechanisms.jsonl")
        runner.real_list_shape = True
        engine = post_round.PostRound(self.cfg, runner, lambda: self.NOW)
        self.assertEqual(engine.tick()[self.ROUND], "NOTES_ENQUEUED")
        note_request = json.loads(next((self.tmp / "inbox/requests").glob("post-round-note-*.json")).read_text())
        note = {"candidate_id": "A001", "outcome": "NOTE", "mechanism_id": "SEL.XSEC.VALUE",
                "economic_logic_zh": "市净率的截面差异能够反映估值锚定偏离程度与再定价摩擦",
                "failure_mode_zh": "极端行业结构变化时关系可能失真", "fields_cited": ["pb"],
                "no_mechanism_code": None, "proposal": None}
        note_body = {"schema": "RF1116_MECH_NOTE_OUTPUT_V1", "round_id": self.ROUND, "batch_no": 1, "notes": [note]}
        self.write_task(note_request, "mechanism_notes", note_body)
        self.assertEqual(engine.tick()[self.ROUND], "REVIEWS_ENQUEUED")
        self.assertEqual(len(runner.registered), 1)
        review_request = json.loads(next((self.tmp / "inbox/requests").glob("post-round-review-*.json")).read_text())
        review_body = {"schema": "RF1116_MECH_REVIEW_OUTPUT_V1", "round_id": self.ROUND, "batch_no": 1,
                       "items": [{"candidate_id": "A001", "status": "CONSISTENT", "code": None,
                                  "note_zh": "公式、机制与文字说明相互一致"}]}
        self.write_task(review_request, "mechanism_review", review_body)
        self.assertEqual(engine.tick()[self.ROUND], "DONE")
        verdicts = json.loads((self.tmp / "post" / self.ROUND / "verdicts.json").read_text())
        self.assertEqual(verdicts["verdicts"], [{"candidate_id": "A001", "verdict": "APPROVED", "note": "AQ_POST_ROUND_V1"}])
        self.assertEqual(runner.review["reviewer"], "AQ_POST_ROUND_V1 program (spec 04a0961f; note tasks 1, review tasks 1)")

    def test_b22_waiting_attempt_zero_never_reads_result_or_becomes_rejected(self):
        self.seed(["A001"])
        engine = post_round.PostRound(self.cfg, Runner(self.survivors(1)), lambda: self.NOW)
        engine.tick()
        request = json.loads(next((self.tmp / "inbox/requests").glob("post-round-note-*.json")).read_text())
        idem = self.request_idem(request)
        (self.tmp / "state/status.json").write_text(canon({"schema": "RQ_STATUS_V1", "tasks": [{
            "task_id": "RQT-LINUX-20261124-%s" % idem[:8], "idem_key": idem, "state": "READY", "attempt_no": 0}]}))
        original = pathlib.Path.read_text
        def guarded(path, *args, **kwargs):
            if path.name == "result.json":
                raise AssertionError("attempt zero must not read a result")
            return original(path, *args, **kwargs)
        with mock.patch.object(pathlib.Path, "read_text", guarded):
            self.assertEqual(engine.tick()[self.ROUND], "WAITING_AQ")
        self.assertFalse((self.tmp / "post" / self.ROUND / "verdicts.json").exists())


if __name__ == "__main__":
    unittest.main()
