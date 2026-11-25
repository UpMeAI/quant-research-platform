"""#166: publish the consumer-validated agent result before COMPLETE.

The trusted revalidator reads in/task.json, in/bundle.json and result.json.  The
return producer must therefore take card/ideas from result.json.outputs; the
agent-written sidecar files are deliberately contradictory in these tests.
"""
import hashlib
import json
from unittest import mock

from helpers import *  # noqa
from rq import agentseam  # noqa


VALIDATION = {"ok": True, "codes": [], "output_sha256": "9" * 64}


class ValidatedReturn(Base):
    def setUp(self):
        super().setUp()
        self.template = net_tpl(
            "T-VALIDATED-RETURN-V1",
            prompt_admission_sha256=sha("prompt"),
            params={},
            argv=[PY, STUB, "ok"],
            markets=["CN_A"],
            agent_host="LINUX",
            run_host="LINUX",
            producer_host="LINUX",
            inputs=[{"prefix": "{inbox}/fact-packs"}],
        )
        pack_dir = self.cfg.inbox_dir / "fact-packs"
        pack_dir.mkdir(parents=True)
        self.pack_path = pack_dir / "2026-W47-CN_A.json"
        self.pack = {
            "schema": "REVIEW_AI_FACT_PACK_V1",
            "week": "2026-W47",
            "market": "CN_A",
            "facts": [{"id": "F-001", "at": "2026-11-20T18:00:00+08:00", "value": {"n": 1}}],
        }
        pack_raw = (json.dumps(self.pack, indent=2, ensure_ascii=False) + "\n").encode()
        self.pack_path.write_bytes(pack_raw)
        admitted = self.admit(
            registry([self.template]),
            req(
                self.template,
                params={},
                market="CN_A",
                inputs=[{"path": str(self.pack_path), "sha256": hashlib.sha256(pack_raw).hexdigest()}],
            ),
        )
        self.task_id = admitted.task_id
        claimed = core.claim(self.conn, host="LINUX", worker="test", now=self.t0)
        self.assertEqual(claimed["task_id"], self.task_id)
        core.transition(self.conn, self.task_id, "RUNNING", actor="rq-consumer", now=self.t0, token=claimed["lease_token"])
        core.transition(self.conn, self.task_id, "EVIDENCE_WRITTEN", actor="rq-consumer", now=self.t0, token=claimed["lease_token"], reason="SUCCESS")

        self.attempt = self.cfg.runs_dir / self.task_id / "attempt-1"
        (self.attempt / "in").mkdir(parents=True)
        task = self.row(self.task_id)
        task_doc = {k: task[k] for k in ("task_id", "host", "agent_host", "kind", "market", "template_id", "template_sha256", "attempt_no")}
        (self.attempt / "in" / "task.json").write_text(core.canonical(task_doc) + "\n")
        self.registry_view = {
            "market": "CN_A",
            "mechanisms": [],
            "readings": {},
            "holding_periods": [],
        }
        self.bundle = {
            "schema": "RQ_AGENT_BUNDLE_V1",
            "market": "CN_A",
            "week_id": "2026-W47",
            "pack": self.pack,
            "registry": self.registry_view,
        }
        (self.attempt / "in" / "bundle.json").write_text(core.canonical(self.bundle) + "\n")
        self.card = {"schema": "REVIEW_AI_CARD_V1", "task_id": self.task_id, "body": {"zh": "可信结果"}}
        self.ideas = [{"schema": "REVIEW_FACTOR_IDEA_V1", "idea_id": "I-001", "question_zh": "如何验证？"}]
        self.result = {
            "schema": "RQ_AGENT_RESULT_V1",
            "task_id": self.task_id,
            "kind": "AI_REVIEW_CARD",
            "status": "DONE",
            "outputs": {"card": self.card, "factor_ideas": self.ideas},
        }
        self.result_raw = (json.dumps(self.result, indent=1, ensure_ascii=False) + "\n").encode()
        (self.attempt / "result.json").write_bytes(self.result_raw)
        (self.attempt / "card.json").write_text('{"tampered":true}\n')
        (self.attempt / "factor_ideas.jsonl").write_text('{"tampered":true}\n')

    @property
    def output(self):
        return self.cfg.outbox_dir / ("validated-return-%s-a1.json" % self.task_id)

    def run_complete(self, verdict=VALIDATION):
        with mock.patch.object(agentseam, "revalidate", return_value=verdict):
            return complete.tick(self.conn, self.cfg, self.t0)

    def test_valid_result_is_canonical_read_only_and_published_before_complete(self):
        self.assertEqual(self.run_complete(), [self.task_id])
        self.assertEqual(self.state(self.task_id), "COMPLETE")
        raw = self.output.read_bytes()
        doc = json.loads(raw)
        self.assertEqual(raw, (core.canonical(doc) + "\n").encode())
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o444)
        self.assertEqual(
            set(doc),
            {
                "schema", "task_id", "attempt_no", "host", "template_id", "template_sha256", "kind", "market",
                "validator", "card", "ideas", "card_sha256", "ideas_sha256", "fact_pack", "registry",
                "result_sha256", "output_sha256", "bundle_sha256",
            },
        )
        self.assertEqual((doc["card"], doc["ideas"]), (self.card, self.ideas))
        self.assertEqual(doc["result_sha256"], hashlib.sha256(self.result_raw).hexdigest())
        self.assertEqual(doc["output_sha256"], VALIDATION["output_sha256"])
        self.assertEqual(doc["fact_pack"], {"ref": str(self.pack_path), "sha256": hashlib.sha256(self.pack_path.read_bytes()).hexdigest()})
        self.assertEqual(doc["registry"], {"ref": "in/bundle.json#/registry", "sha256": core.sha256_hex(core.canonical(self.registry_view))})
        self.assertEqual(doc["card_sha256"], core.sha256_hex(core.canonical(self.card)))
        self.assertEqual(doc["ideas_sha256"], core.sha256_hex(core.canonical(self.ideas)))
        body = dict(doc)
        bundle_sha = body.pop("bundle_sha256")
        self.assertEqual(bundle_sha, core.sha256_hex(core.canonical(body)))
        self.assertNotIn("timestamp", doc)
        self.assertNotIn("at", doc)

    def test_empty_validated_ideas_array_is_published(self):
        self.result["outputs"]["factor_ideas"] = []
        self.result_raw = (json.dumps(self.result, indent=1, ensure_ascii=False) + "\n").encode()
        (self.attempt / "result.json").write_bytes(self.result_raw)
        self.assertEqual(self.run_complete(), [self.task_id])
        self.assertEqual(json.loads(self.output.read_bytes())["ideas"], [])

    def test_crash_after_publish_reuses_identical_bytes_then_completes(self):
        real_transition = core.transition
        crashed = {"done": False}

        def crash_once(conn, task_id, to_state, **kwargs):
            if to_state == "COMPLETE" and not crashed["done"]:
                crashed["done"] = True
                raise RuntimeError("simulated crash after publish")
            return real_transition(conn, task_id, to_state, **kwargs)

        with mock.patch.object(agentseam, "revalidate", return_value=VALIDATION), mock.patch.object(core, "transition", side_effect=crash_once):
            with self.assertRaisesRegex(RuntimeError, "simulated crash"):
                complete.tick(self.conn, self.cfg, self.t0)
        first = self.output.read_bytes()
        self.assertEqual(self.state(self.task_id), "EVIDENCE_WRITTEN")
        self.assertEqual(self.run_complete(), [self.task_id])
        self.assertEqual(self.output.read_bytes(), first)
        self.assertEqual(self.state(self.task_id), "COMPLETE")

    def test_existing_different_bytes_blocks_without_overwrite(self):
        original = b'{"belongs":"elsewhere"}\n'
        self.output.write_bytes(original)
        self.output.chmod(0o444)
        self.assertEqual(self.run_complete(), [])
        self.assertEqual((self.state(self.task_id), self.row(self.task_id)["state_reason"]), ("BLOCKED_DETERMINISTIC", "RETURN_EXISTS_DIFFERENT"))
        self.assertEqual(self.output.read_bytes(), original)

    def test_missing_fact_pack_binding_blocks_without_file(self):
        row = self.row(self.task_id)
        admission = json.loads(row["admission_json"])
        admission["request"]["inputs"] = []
        self.conn.execute("update task set admission_json=? where task_id=?", (core.canonical(admission), self.task_id))
        self.assertEqual(self.run_complete(), [])
        self.assertEqual((self.state(self.task_id), self.row(self.task_id)["state_reason"]), ("BLOCKED_DETERMINISTIC", "RETURN_BINDING_MISSING"))
        self.assertFalse(self.output.exists())

    def test_missing_registry_binding_blocks_without_file(self):
        bundle = dict(self.bundle)
        bundle.pop("registry")
        (self.attempt / "in" / "bundle.json").write_text(core.canonical(bundle) + "\n")
        self.assertEqual(self.run_complete(), [])
        self.assertEqual((self.state(self.task_id), self.row(self.task_id)["state_reason"]), ("BLOCKED_DETERMINISTIC", "RETURN_BINDING_MISSING"))
        self.assertFalse(self.output.exists())

    def test_not_ok_or_unavailable_revalidation_never_publishes(self):
        self.assertEqual(self.run_complete({"ok": False, "codes": ["BAD"], "output_sha256": None}), [])
        self.assertEqual(self.row(self.task_id)["state_reason"], "VALIDATOR_NOT_OK")
        self.assertFalse(self.output.exists())

    def test_seam_error_never_publishes(self):
        with mock.patch.object(agentseam, "revalidate", side_effect=agentseam.SeamError("UNAVAILABLE", "down")):
            self.assertEqual(complete.tick(self.conn, self.cfg, self.t0), [])
        self.assertEqual(self.row(self.task_id)["state_reason"], "VALIDATOR_UNAVAILABLE")
        self.assertFalse(self.output.exists())

    def test_task_id_cannot_escape_the_configured_outbox(self):
        from rq import validated_return

        task = dict(self.row(self.task_id))
        task["task_id"] = "../escape"
        with self.assertRaises(validated_return.ReturnError) as caught:
            validated_return.publish(self.cfg, task, self.attempt, VALIDATION)
        self.assertEqual(caught.exception.code, "RETURN_PATH_FORBIDDEN")
        self.assertFalse((self.cfg.outbox_dir.parent / "escape-a1.json").exists())

