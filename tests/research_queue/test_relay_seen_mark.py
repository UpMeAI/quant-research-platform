"""W05 (plan-coord ruling 11-23, W05_REVIEWED_IS_SEEN_RULING_V1 section 2): the entry points that take a review fact pack into the research side write its SEEN mark first.
The Mac relay marks before a pack ships (no mark, no delivery, retried next pass); the host producer marks the pack it admits when the marker is configured. The marker is the
QRP front door (apps/research-cli/review_pack_seen.js mark), called as a child process: this module only decides when, and what a failure means."""
import json, os, pathlib, tempfile, unittest
from unittest import mock
from helpers import *  # noqa
from rq import relay
from test_q3b_templates import shipped  # noqa

PACK = {"schema": "REVIEW_AI_FACT_PACK_V1", "week": "2026-W47", "market": "CN_A",
        "facts": [{"id": "F-001", "source": {"path": "docs/review-loop/w.json", "sha256": "b" * 64, "pointer": "/"}, "at": "2026-11-20T18:00:00+08:00", "value": {"k": 1}}]}


class StubTransport:
    def __init__(self, root, log=None):
        self.root, self.log = pathlib.Path(root), log if log is not None else []

    def push(self, host, data, remote_dir, name, expected_sha):
        self.log.append(("push", host, name))
        p = self.root / host / remote_dir.lstrip("/")
        p.mkdir(parents=True, exist_ok=True)
        (p / name).write_bytes(data)
        return relay.sha256_bytes(data)

    def list_outbox(self, host):
        return []

    def fetch(self, host, name):
        return b""


class RelayMarksBeforeShipping(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.addCleanup(self._t.cleanup)
        r = pathlib.Path(self._t.name)
        self.r = r
        self.cfg = dict(relay.DEFAULT_CONFIG, outbox_root=str(r / "desk"), return_root=str(r / "qrp"), state_path=str(r / "state.json"))
        self.cfg["hosts"] = {"linux": dict(relay.DEFAULT_CONFIG["hosts"]["linux"], outbox="/outbox")}
        d = r / "desk" / "linux" / "REVIEW_AI_FACT_PACK_V1"
        d.mkdir(parents=True)
        self.name = "REVIEW_AI_FACT_PACK_CN_A_2026-W47.json"
        self.raw = json.dumps(PACK).encode()
        (d / self.name).write_bytes(self.raw)
        self.log = []
        self.tr = StubTransport(r / "remote", self.log)

    def test_the_mark_is_written_before_the_push_with_the_pack_bytes(self):
        def marker(host, name, data):
            self.log.append(("mark", host, name, data))
            return None
        out = relay.run(self.cfg, self.tr, marker=marker)
        self.assertEqual(out["pushed"], [["linux", self.name]])
        self.assertEqual([e[0] for e in self.log], ["mark", "push"], "mark first, then ship")
        self.assertEqual(self.log[0][3], self.raw)

    def test_a_failed_mark_blocks_the_delivery_and_the_next_pass_retries(self):
        out = relay.run(self.cfg, self.tr, marker=lambda host, name, data: "TRIAL_LEDGER_AUTHORITY_NOT_CONFIGURED")
        self.assertEqual(out["pushed"], [])
        self.assertEqual(out["failed"], [["linux", self.name, "SEEN_MARK_FAILED:TRIAL_LEDGER_AUTHORITY_NOT_CONFIGURED"]])
        self.assertFalse([e for e in self.log if e[0] == "push"], "an unmarked pack is not delivered")
        out = relay.run(self.cfg, self.tr, marker=lambda host, name, data: None)
        self.assertEqual(out["pushed"], [["linux", self.name]], "a later pass with a working marker delivers it")

    def test_a_pack_already_shipped_is_not_marked_again(self):
        calls = []
        relay.run(self.cfg, self.tr, marker=lambda host, name, data: calls.append(name))
        out = relay.run(self.cfg, self.tr, marker=lambda host, name, data: calls.append(name))
        self.assertEqual((calls, len(out["skipped"])), ([self.name], 1))

    def test_refused_packs_are_not_marked(self):
        d = self.r / "desk/linux/REVIEW_AI_FACT_PACK_V1"
        (d / "other.json").write_text(json.dumps({"schema": "SOMETHING_ELSE"}))
        calls = []
        relay.run(self.cfg, self.tr, marker=lambda host, name, data: calls.append(name))
        self.assertEqual(calls, [self.name])


class NodeMarker(unittest.TestCase):
    def fake(self, rc=0, err=b""):
        seen = {}

        def run(argv, input=None, capture_output=False, timeout=None, env=None, **kw):
            seen.update(argv=argv, input=input, env=env, timeout=timeout)
            return mock.Mock(returncode=rc, stdout=b"{}", stderr=err)
        return seen, run

    def test_calls_the_qrp_cli_with_the_pack_on_stdin_and_no_secret_in_argv(self):
        seen, run = self.fake()
        m = relay.NodeSeenMarker("/qrp", node="/usr/local/bin/node", run=run)
        self.assertIsNone(m("linux", "x.json", b"{}"))
        self.assertEqual(seen["argv"], ["/usr/local/bin/node", "/qrp/apps/research-cli/review_pack_seen.js", "mark", "--file", "-"])
        self.assertEqual(seen["input"], b"{}")
        self.assertTrue(seen["timeout"])

    def test_a_failure_comes_back_as_the_cli_error_code(self):
        _, run = self.fake(rc=1, err=b"REVIEW_PACK_SEEN_MARKET_UNKNOWN:X\n")
        self.assertEqual(relay.NodeSeenMarker("/qrp", run=run)("linux", "x.json", b"{}"), "REVIEW_PACK_SEEN_MARKET_UNKNOWN")
        _, run = self.fake(rc=3, err=b"")
        self.assertEqual(relay.NodeSeenMarker("/qrp", run=run)("linux", "x.json", b"{}"), "SEEN_MARK_EXIT_3")

    def test_a_missing_node_or_a_timeout_is_a_failure_not_a_pass(self):
        def boom(*a, **k):
            raise OSError("no node")
        self.assertEqual(relay.NodeSeenMarker("/qrp", run=boom)("linux", "x.json", b"{}"), "SEEN_MARK_UNAVAILABLE")

    def test_main_always_wires_the_node_marker_into_the_relay_pass(self):
        got = {}

        def fake_run(cfg, transport, marker=None):
            got["marker"] = marker
            return {"failed": []}
        with mock.patch.object(relay, "run", fake_run), mock.patch.object(relay, "SshTransport", lambda cfg: None):
            self.assertEqual(relay.main([]), 0)
        self.assertIsInstance(got["marker"], relay.NodeSeenMarker)

    def test_the_producer_marker_exists_only_when_the_host_is_configured(self):
        self.assertIsNone(relay.NodeSeenMarker.from_env({}))
        m = relay.NodeSeenMarker.from_env({"RQ_SEEN_MARK_QRP_ROOT": "/opt/qrp", "RQ_SEEN_MARK_NODE": "/opt/node/bin/node"})
        self.assertEqual((m.qrp_root, m.node), ("/opt/qrp", "/opt/node/bin/node"))


class ProducerMarksTheAdmittedPack(Base):
    def drop(self, pack=PACK, name="2026-W47-CN_A.json"):
        d = self.cfg.inbox_dir / "fact-packs"
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_text(json.dumps(pack))
        return d / name

    def test_the_pack_is_marked_before_the_card_task_is_admitted(self):
        self.drop()
        calls = []
        out = producer.tick(self.conn, self.cfg, shipped(), self.t0, seen_marker=lambda host, name, data: calls.append((host, name, json.loads(data)["week"])))
        self.assertEqual(calls, [("LINUX", "2026-W47-CN_A.json", "2026-W47")])
        self.assertEqual(out["admitted"], 1)

    def test_no_mark_no_card_task_and_the_pack_is_retried_on_the_next_tick(self):
        self.drop()
        out = producer.tick(self.conn, self.cfg, shipped(), self.t0, seen_marker=lambda host, name, data: "SEEN_MARK_UNAVAILABLE")
        self.assertEqual((out["admitted"], out["seen_mark_failed"]), (0, [["2026-W47-CN_A.json", "SEEN_MARK_UNAVAILABLE"]]))
        self.assertIsNone(self.conn.execute("select 1 from task where state='READY'").fetchone())
        out = producer.tick(self.conn, self.cfg, shipped(), self.t0, seen_marker=lambda host, name, data: None)
        self.assertEqual(out["admitted"], 1)

    def test_without_a_marker_the_tick_is_unchanged(self):
        self.drop()
        out = producer.tick(self.conn, self.cfg, shipped(), self.t0)
        self.assertEqual((out["admitted"], "seen_mark_failed" in out), (1, False))


if __name__ == "__main__":
    unittest.main()
