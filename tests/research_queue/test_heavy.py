"""HR-01..HR-28: frozen AQ heavy-run queue-side acceptance, all local fakes."""
import copy
import datetime as dt
import hashlib
import json
import os
import pathlib
import tempfile
import unittest

from helpers import *  # noqa
from rq import heavy, heavy_accept  # noqa: E402


GIB = 2 ** 30
SCHEMA_SHA = "c7b6376e8d1d31a7a5b692902bb32fdbc1c19ca6f4e06ddadce31b3962a7cfff"
LEGACY_TEMPLATE_SHAS = {
    "T-AI-REVIEW-CARD-V1-LINUX-CN_A": "7849a35d674b5b9cae3e94e0424f3d4ee5871d402fd96e79d6ac7c7a03018d39",
    "T-AI-CHECK-V1-LINUX-CN_A": "4de786fb2c9a65cffcf4d4aef34194c14fbcbd396fac0e17f2db5a1193033a1e",
}


def h(data):
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def heavy_template(kind="HEAVY_Q0_LANE", pause_mode="COOPERATIVE_FILE"):
    tid = "T-HEAVY-Q0-LANE-V1-LINUX" if kind == "HEAVY_Q0_LANE" else "T-HEAVY-LAB-E2E-V1-LINUX"
    return tpl(
        tid,
        kinds=[kind], market="CN_A", markets=["CN_A"], weight_class="W2",
        io_class="LANE1_DB" if kind == "HEAVY_Q0_LANE" else "LANE1_FILES",
        argv=["/usr/bin/python3", "-m", "rq", "heavy-run", "{spec_sha256}"],
        recovery_argv=["/usr/bin/python3", "-m", "rq", "heavy-run", "{spec_sha256}", "--resume"],
        params={"spec_sha256": "^[0-9a-f]{64}$"}, completion="HEAVY_MATRIX",
        idempotent=False, recovery_max=2, outputs=["HEAVY_RESULT_V1.json"],
        evidence_matrix={"id": "EM-HEAVY-V1", "sha256": h("EM-HEAVY-V1")},
        heavy={
            "spec_schema": "HEAVY_RUN_SPEC_V1", "pause_mode": pause_mode,
            "unit_props": ["Nice=19", "IOSchedulingClass=idle", "CPUAffinity=0-7 16-23", "CPUQuota=600%", "MemoryMax=24G"],
            "floor_gib": 150, "driver_contract": "HEAVY_DRIVER_V1",
            "terminal_map": "HEAVY_TERMINAL_MAP_V1", "stop_lead_s": 1800,
        },
    )


def spec(root, *, db="NONE", preconditions=None, rows=None):
    root = pathlib.Path(root)
    files = {}
    for name in ("run-plan", "input-manifest", "tree.tar", "tree-manifest", "driver", "comparator"):
        p = root / name
        p.write_text(name)
        files[name] = {"path": str(p), "sha256": h(name)}
    return {
        "schema": "HEAVY_RUN_SPEC_V1",
        "pins": {
            "run_plan": files["run-plan"], "input_manifest": files["input-manifest"],
            "code_tree": {"path": files["tree.tar"]["path"], "tar_sha256": files["tree.tar"]["sha256"], "manifest_path": files["tree-manifest"]["path"], "manifest_sha256": files["tree-manifest"]["sha256"]},
            "image": {"name": "q0", "digest": "sha256:" + "a" * 64},
            "template": {"template_id": "T-HEAVY-Q0-LANE-V1-LINUX", "template_sha256": "b" * 64},
            "driver": {"path": files["driver"]["path"], "sha256": files["driver"]["sha256"], "comparators": [{"path": files["comparator"]["path"], "sha256": files["comparator"]["sha256"]}]},
        },
        "preconditions": preconditions or [],
        "db": {"mode": db},
        "run_dirs": {"main": str(root / "lane-main")},
        "acceptance": {"rows": rows or ["H01", "H02", "H04", "H05", "H06", "H07", "H08", "Q01", "Q02"]},
        "budget": {"expected_compute_s": 1, "peak_bytes": 0},
    }


class HeavyFrozenAcceptance(Base):
    def setUp(self):
        super().setUp()
        self.s = spec(self.root)

    def write_spec(self, value=None):
        raw = core.canonical(value or self.s).encode()
        p = self.cfg.inbox_dir / "heavy-specs" / (h(raw) + ".json")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(raw)
        return h(raw), p

    def test_hr01_template_validation_is_closed(self):
        t = heavy_template()
        self.assertEqual(templates.validate_template(t), [])
        for key in ("spec_schema", "pause_mode", "unit_props", "floor_gib", "driver_contract", "terminal_map", "stop_lead_s"):
            bad = copy.deepcopy(t); bad["heavy"].pop(key)
            self.assertTrue(templates.validate_template(bad), key)
        for bad in (dict(t, completion="SELF_VALIDATED"), dict(t, argv=t["argv"] + ["/tmp/spec.json"])):
            self.assertTrue(templates.validate_template(bad))

    def test_hr02_spec_sha_mismatch_never_invokes_driver(self):
        sha_, path = self.write_spec()
        called = []
        with self.assertRaisesRegex(heavy.HeavyRefused, "INVALID_PIN_SPEC"):
            heavy.load_spec(self.cfg, "0" * 64, run_driver=lambda *_: called.append(True))
        self.assertEqual(called, [])
        self.assertEqual(heavy.load_spec(self.cfg, sha_)[0], self.s)

    def test_hr03_each_pin_mismatch_has_its_own_code(self):
        services = heavy.FakeServices(image_digest="sha256:" + "a" * 64)
        self.assertEqual(heavy.check_pins(self.s, services), [])
        cases = (("run_plan", "INVALID_PIN_RUN_PLAN"), ("input_manifest", "INVALID_PIN_INPUT_MANIFEST"),
                 ("code_tree", "INVALID_PIN_CODE_TREE"), ("image", "INVALID_PIN_IMAGE"), ("driver", "INVALID_PIN_DRIVER"))
        for key, code in cases:
            x = copy.deepcopy(self.s)
            if key == "image": x["pins"][key]["digest"] = "sha256:" + "0" * 64
            elif key == "code_tree": x["pins"][key]["tar_sha256"] = "0" * 64
            else: x["pins"][key]["sha256"] = "0" * 64
            self.assertEqual(heavy.check_pins(x, services)[0]["code"], code)
        self.assertEqual(services.driver_calls, [])

    def test_hr04_false_unknown_and_then_true_preconditions(self):
        p = self.root / "gate.json"; p.write_text('{"ok":false}')
        self.s["preconditions"] = [{"kind": "JSON_FIELD_EQ", "path": str(p), "field": "ok", "value": True}]
        self.assertFalse(heavy.check_preconditions(self.s, self.conn, self.t0)[0])
        p.write_text('{"ok":true}')
        self.assertTrue(heavy.check_preconditions(self.s, self.conn, self.t0)[0])
        p.unlink()
        self.assertFalse(heavy.check_preconditions(self.s, self.conn, self.t0)[0])

    def test_hr05_json_time_after_is_strict(self):
        a = self.root / "a.json"; b = self.root / "b.json"
        a.write_text('{"at":"2026-11-24T09:00:00+08:00"}'); b.write_text('{"at":"2026-11-24T09:00:01+08:00"}')
        pc = {"kind": "JSON_TIME_AFTER", "path": str(a), "field": "at", "other_path": str(b), "other_field": "at"}
        self.s["preconditions"] = [pc]
        self.assertFalse(heavy.check_preconditions(self.s, self.conn, self.t0)[0])
        a.write_text('{"at":"2026-11-24T09:00:02+08:00"}')
        self.assertTrue(heavy.check_preconditions(self.s, self.conn, self.t0)[0])

    def test_hr06_task_complete_rejects_noncomplete_dependencies(self):
        t = tpl("T-HR06")
        r = self.admit(registry([t]), req(t))
        pc = {"kind": "TASK_COMPLETE", "task_id": r.task_id}
        self.s["preconditions"] = [pc]
        for state in ("GATE_FAIL", "BLOCKED_DETERMINISTIC"):
            self.conn.execute("update task set state=? where task_id=?", (state, r.task_id))
            self.assertFalse(heavy.check_preconditions(self.s, self.conn, self.t0)[0])
        self.conn.execute("update task set state='COMPLETE' where task_id=?", (r.task_id,))
        self.assertTrue(heavy.check_preconditions(self.s, self.conn, self.t0)[0])

    def test_hr07_floor_uses_binary_gib_and_inclusive_boundary(self):
        self.assertFalse(heavy.floor_allows(161061273599, floor_gib=150, peak_bytes=0))
        self.assertTrue(heavy.floor_allows(161061273600, floor_gib=150, peak_bytes=0))

    def test_hr08_guard_resume_requires_sixty_minutes_and_ten_gib(self):
        trip = self.t0
        self.assertFalse(heavy.guard_resume_ready(trip + dt.timedelta(minutes=59), trip, 160 * GIB, 150))
        self.assertFalse(heavy.guard_resume_ready(trip + dt.timedelta(minutes=60), trip, 160 * GIB - 1, 150))
        self.assertTrue(heavy.guard_resume_ready(trip + dt.timedelta(minutes=60), trip, 160 * GIB, 150))
        self.assertEqual(heavy.guard_terminal(3), "STOPPED_BY_GUARD_REPEATED")

    def test_hr09_db_probe_uses_driver_report_not_pgoptions(self):
        ok = {"role": "ashare", "source": "ROLE_DEFAULT", "transactionReadOnly": True, "writeAttemptSqlstate": "25006"}
        self.assertIsNone(heavy.validate_db_probe(ok, {"mode": "READ_ONLY"}))
        for patch in ({"transactionReadOnly": False}, {"writeAttemptSqlstate": "00000"}, {"source": "OPTIONS", "transactionReadOnly": False}):
            self.assertEqual(heavy.validate_db_probe(dict(ok, **patch), {"mode": "READ_ONLY"}), "DB_NOT_READ_ONLY")

    def test_hr10_one_bad_container_is_stopped_by_exact_name(self):
        calls = []
        containers = [{"name": "rq-task-X-1", "network": "container:a6r-postgres", "env": []}, {"name": "other", "network": "none", "env": []}]
        bad = heavy.validate_containers(containers, "rq-task-X-", None, lambda name: calls.append(name))
        self.assertEqual((bad, calls), (["rq-task-X-1"], ["rq-task-X-1"]))

    def test_hr11_gate_writer_requires_fresh_file_and_dead_writer(self):
        now = 1_000.0
        self.assertFalse(heavy.gates_ready(self.root / "missing", now, writer_alive=True))
        p = self.root / "gates.json"; p.write_text("{}")
        os.utime(p, (now - 179, now - 179))
        self.assertTrue(heavy.gates_ready(p, now, writer_alive=True))
        self.assertFalse(heavy.gates_cleanup_ok(writer_alive=True))
        self.assertTrue(heavy.gates_cleanup_ok(writer_alive=False))

    def test_hr12_window_yield_is_waiting_and_not_t1(self):
        out = heavy.classify_driver_result({"exit": 75, "reason": "WINDOW_YIELD:PAUSE"})
        self.assertEqual((out.result, out.queue_state, out.code, out.count_t1), ("WAITING", "WAITING_EXTERNAL", "WINDOW_YIELD", False))

    def test_hr13_blackouts_fail_closed_but_unset_is_allowed(self):
        self.assertEqual(pause.load_blackouts(None), [])
        for name, text in (("missing", None), ("bad", "{"), ("wrong", '{"schema":"NO","entries":[]}')):
            p = self.root / name
            if text is not None: p.write_text(text)
            with self.assertRaisesRegex(pause.BlackoutsUnusable, "BLACKOUTS_FILE_UNUSABLE"):
                pause.load_blackouts(p)
        p = self.root / "ok"; p.write_text('{"schema":"RQ_BLACKOUTS_V1","entries":[]}')
        self.assertEqual(pause.load_blackouts(p), [])

    def test_hr14_t1_cleanup_only_stops_exact_task_prefix(self):
        calls = []
        heavy.cleanup_strays(["rq-task-T-1", "rq-task-T-2", "rq-task-OTHER"], "rq-task-T-", calls.append)
        self.assertEqual(calls, ["rq-task-T-1", "rq-task-T-2"])
        self.assertEqual(heavy.t1_terminal(3, 2), "T1_BUDGET_EXHAUSTED")

    def test_hr15_done_accepted(self):
        rows = {r: "PASS" for r in ("H01", "H02", "H04", "H05", "H06", "H07", "H08", "Q01", "Q02")}
        self.assertEqual(heavy_accept.decide(rows, non_gate_rows={"Q01"}), ("DONE_ACCEPTED", "HEAVY_ACCEPTED"))

    def test_hr16_norm_v1_is_reported_but_v2_gates(self):
        rows = {"H01": "PASS", "Q01": "FAIL", "Q02": "PASS"}
        self.assertEqual(heavy_accept.decide(rows, non_gate_rows={"Q01"})[0], "DONE_ACCEPTED")
        rows["Q02"] = "FAIL"
        self.assertEqual(heavy_accept.decide(rows, non_gate_rows={"Q01"})[0], "DONE_REFUSED")
        rows["Q01"] = "MISSING"
        self.assertEqual(heavy_accept.decide(rows, non_gate_rows={"Q01"})[0], "INVALID")

    def test_hr17_comparator_hash_is_checked_before_run(self):
        comp = pathlib.Path(self.s["pins"]["driver"]["comparators"][0]["path"])
        self.assertIsNone(heavy.validate_comparators(self.s))
        comp.write_text("changed")
        self.assertEqual(heavy.validate_comparators(self.s), "INVALID_PIN_COMPARATOR")

    def test_hr18_missing_or_changed_evidence_is_invalid(self):
        d = self.root / "evidence"; d.mkdir(); (d / "a.json").write_text("{}")
        (d / "SHA256SUMS").write_text(h("{}") + "  a.json\n")
        self.assertEqual(heavy_accept.verify_manifest(d), {})
        (d / "a.json").write_text('{"x":1}')
        self.assertIn("a.json", heavy_accept.verify_manifest(d))
        (d / "a.json").unlink()
        self.assertIn("a.json", heavy_accept.verify_manifest(d))

    def test_hr19_completion_is_deterministic(self):
        rows = {"H01": "PASS", "Q01": "FAIL", "Q02": "PASS"}
        a = heavy_accept.result_document("T", rows, {"Q01": "FAIL_DIFFERENCES", "Q02": "PASS"}, {})
        b = heavy_accept.result_document("T", dict(reversed(list(rows.items()))), {"Q02": "PASS", "Q01": "FAIL_DIFFERENCES"}, {})
        self.assertEqual(core.canonical(a), core.canonical(b))

    def test_hr20_results_are_readonly_and_ledger_chain_detects_mutation(self):
        p = self.root / "result.json"; heavy_accept.write_readonly(p, {"ok": True})
        self.assertEqual(p.stat().st_mode & 0o777, 0o444)
        ledger = self.root / "RUN_LEDGER.jsonl"
        heavy.append_ledger(ledger, {"step": "A"}); heavy.append_ledger(ledger, {"step": "B"})
        self.assertEqual(heavy.verify_ledger(ledger), (True, None))
        lines = ledger.read_text().splitlines(); lines[0] = lines[0].replace('"A"', '"X"'); ledger.write_text("\n".join(lines) + "\n")
        self.assertFalse(heavy.verify_ledger(ledger)[0])

    def test_hr21_run_dir_cannot_be_reused_by_another_task(self):
        d = pathlib.Path(self.s["run_dirs"]["main"]); d.mkdir(); (d / "RQ_TASK.json").write_text('{"task_id":"OTHER"}')
        self.assertEqual(heavy.prepare_run_dirs(self.s, "T", resume=True), "INVALID_RUN_DIR_REUSED")

    def test_hr22_unit_props_and_child_environment_are_exact(self):
        c = runtime.SystemdRuntime(run_cmd=lambda _: (0, "")).command("rq-task-T-a1", ["x"], {}, "W2")
        for prop in ("Nice=19", "IOSchedulingClass=idle", "CPUAffinity=0-7 16-23", "CPUQuota=600%", "MemoryMax=24G"):
            self.assertIn(prop, c)
        env = runtime.child_env(self.cfg, self.root, "T", 1)
        for key in ("RQ_TASK_ID", "RQ_ATTEMPT_DIR", "RQ_RUN_DIR", "RQ_PAUSE_FILE", "RQ_GATES_FILE", "RQ_CONTAINER_PREFIX", "RQ_RESUME"):
            self.assertIn(key, env)

    def test_hr23_heavy_slot_is_single_and_priority_ordered(self):
        self.assertEqual(core.slot_class({"weight_class": "W2", "io_class": "LANE1_FILES"}), "HEAVY")
        t = heavy_template(); reg = registry([t])
        r2 = self.admit(reg, req(t, subject={"n": 2}, params={"spec_sha256": "2" * 64}, market="CN_A", priority=20))
        r1 = self.admit(reg, req(t, subject={"n": 1}, params={"spec_sha256": "1" * 64}, market="CN_A", priority=10))
        c = core.claim(self.conn, host="LINUX", worker="w", now=self.t0)
        self.assertEqual(c["task_id"], r1.task_id)
        self.assertIsNone(core.claim(self.conn, host="LINUX", worker="w", now=self.t0))

    def test_hr24_w24_quota_and_trl_waits_never_fail(self):
        q = heavy.classify_driver_result({"exit": 75, "reason": "QUOTA:llm_state"})
        trl = heavy.classify_driver_result({"exit": 75, "reason": "TRL_RECEIPT"})
        self.assertEqual((q.queue_state, trl.queue_state), ("WAITING_QUOTA", "WAITING_EXTERNAL"))
        self.assertEqual(trl.code, "TRL_RECEIPT")

    def test_hr25_waiver_requires_a_frozen_pin(self):
        waived = {"role": "ashare", "source": "WAIVED", "transactionReadOnly": False, "writeAttemptSqlstate": None}
        self.assertEqual(heavy.validate_db_probe(waived, {"mode": "READ_ONLY"}), "DB_NOT_READ_ONLY")
        db = {"mode": "READ_ONLY", "waiver": {"reason": "frozen", "pinRecordSha256": "a" * 64}}
        self.assertIsNone(heavy.validate_db_probe(waived, db))

    def test_hr26_forbidden_paths_and_secrets_fail(self):
        for value in ("/srv/v6-prod/x", "/srv/research-lane2/x"):
            bad = copy.deepcopy(self.s); bad["run_dirs"]["main"] = value
            self.assertEqual(heavy.validate_spec(bad)[0], "PATH_FORBIDDEN")
        p = self.root / "secret.txt"; p.write_text("sk-" + "A" * 20)
        self.assertTrue(guard.scan_secrets([self.root]))

    def test_hr27_mutation_invariants_are_explicit(self):
        self.assertEqual(heavy.MUTATION_INVARIANTS, {
            "BINARY_GIB", "UNKNOWN_IS_FALSE", "V2_GATES", "MISSING_INVALID", "COOPERATIVE_NOT_FROZEN",
            "CLEAN_STRAYS", "DB_PROBE_REQUIRED", "COMPARATOR_SHA", "YIELD_NOT_T1", "LEDGER_HASH_CHAIN",
        })

    def test_hr28_legacy_templates_and_ddl_are_unchanged(self):
        reg = templates.Registry.load(ROOT / "config/research_queue_templates.v1.json", ROOT / "config/research_queue_template_pins.v1.json")
        got = {t["template_id"]: templates.template_sha256(t) for t in reg.templates if t["template_id"] in LEGACY_TEMPLATE_SHAS}
        self.assertEqual(got, LEGACY_TEMPLATE_SHAS)
        self.assertEqual(core.schema_sha256(), SCHEMA_SHA)


if __name__ == "__main__":
    unittest.main()
