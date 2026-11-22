"""Mac relay: ships fact packs to each host inbox and returns agent outboxes, verified by sha, idempotent by sha. Local stub transport only."""
import json, pathlib, plistlib, tempfile, unittest
from helpers import *  # noqa
from rq import relay


class StubTransport:
    def __init__(self, root, corrupt=False):
        self.root, self.corrupt, self.pushes = pathlib.Path(root), corrupt, 0

    def push(self, host, data, remote_dir, name, expected_sha):
        self.pushes += 1
        got = relay.sha256_bytes(data[:-1] if self.corrupt else data)
        if got == expected_sha:
            p = self.root / host / remote_dir.lstrip("/")
            p.mkdir(parents=True, exist_ok=True)
            (p / name).write_bytes(data)
        return got

    def list_outbox(self, host):
        d = self.root / host / "outbox"
        return [(f.name, relay.sha256_bytes(f.read_bytes())) for f in sorted(d.glob("*.json"))] if d.is_dir() else []

    def fetch(self, host, name):
        return (self.root / host / "outbox" / name).read_bytes()


class Relay(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.addCleanup(self._t.cleanup)
        r = pathlib.Path(self._t.name)
        self.r = r
        self.cfg = dict(relay.DEFAULT_CONFIG, outbox_root=str(r / "desk"), return_root=str(r / "qrp"), state_path=str(r / "state.json"))
        self.cfg["hosts"] = {"linux": dict(relay.DEFAULT_CONFIG["hosts"]["linux"], outbox="/outbox"), "hk": dict(relay.DEFAULT_CONFIG["hosts"]["hk"], outbox="/outbox")}
        for h in ("linux", "hk"):
            d = r / "desk" / h / "REVIEW_AI_FACT_PACK_V1"
            d.mkdir(parents=True)
            (d / ("2026-W47-%s.json" % h)).write_text(json.dumps({"schema": "REVIEW_AI_FACT_PACK_V1", "week": "2026-W47", "market": "X", "facts": []}))
        self.tr = StubTransport(r / "remote")

    def test_ships_each_pack_to_its_host_inbox_and_is_idempotent(self):
        out = relay.run(self.cfg, self.tr)
        self.assertEqual(sorted(h for h, _ in out["pushed"]), ["hk", "linux"])
        self.assertTrue((self.r / "remote/linux/srv/research-lane/research-queue/inbox/fact-packs/2026-W47-linux.json").exists())
        self.assertTrue((self.r / "remote/hk/var/lib/research-queue/inbox/fact-packs/2026-W47-hk.json").exists())
        self.assertFalse((self.r / "remote/hk/var/lib/research-queue/inbox/fact-packs/2026-W47-linux.json").exists())  # hosts get only their own
        n = self.tr.pushes
        out2 = relay.run(self.cfg, self.tr)
        self.assertEqual((self.tr.pushes, out2["pushed"], len(out2["skipped"])), (n, [], 2))

    def test_arrival_hash_mismatch_is_not_recorded_and_retried(self):
        bad = StubTransport(self.r / "remote", corrupt=True)
        out = relay.run(self.cfg, bad)
        self.assertEqual(out["pushed"], [])
        self.assertEqual(len(out["failed"]), 2)
        self.assertFalse(list((self.r / "remote").rglob("*.json")))
        out = relay.run(self.cfg, self.tr)  # a later good pass delivers
        self.assertEqual(len(out["pushed"]), 2)

    def test_refuses_secret_patterns_bad_names_and_wrong_schema(self):
        d = self.r / "desk/linux/REVIEW_AI_FACT_PACK_V1"
        (d / "leak.json").write_text(json.dumps({"schema": "REVIEW_AI_FACT_PACK_V1", "x": "sk-" + "Ab12" * 6}))
        (d / "other.json").write_text(json.dumps({"schema": "SOMETHING_ELSE"}))
        (d / "bad name.json").write_text("{}")
        out = relay.run(self.cfg, self.tr)
        self.assertEqual(sorted(r[2] for r in out["refused"]), ["NAME", "SCHEMA", "SECRET_PATTERN"])
        self.assertEqual(len(out["pushed"]), 2)

    def test_returns_agent_outboxes_once_verified(self):
        ob = self.r / "remote/hk/outbox"
        ob.mkdir(parents=True)
        (ob / "card-1.json").write_text('{"card": 1}')
        out = relay.run(self.cfg, self.tr)
        self.assertEqual(out["pulled"], [["hk", "card-1.json"]])
        self.assertEqual((self.r / "qrp/hk/card-1.json").read_text(), '{"card": 1}')
        self.assertEqual(relay.run(self.cfg, self.tr)["pulled"], [])

        class Lying(StubTransport):
            def fetch(self, host, name):
                return b"tampered"
        (ob / "card-2.json").write_text('{"card": 2}')
        out = relay.run(self.cfg, Lying(self.r / "remote"))
        self.assertEqual(out["failed"][0][2], "FETCH_VERIFY_FAILED")
        self.assertFalse((self.r / "qrp/hk/card-2.json").exists())

    def test_one_failing_host_does_not_stop_the_other(self):
        class Flaky(StubTransport):
            def push(self, host, *a):
                if host == "linux":
                    raise OSError("ssh down")
                return super().push(host, *a)
        out = relay.run(self.cfg, Flaky(self.r / "remote"))
        self.assertEqual([h for h, _ in out["pushed"]], ["hk"])
        self.assertEqual(out["failed"][0][:2], ["linux", "2026-W47-linux.json"])

    def test_ssh_transport_commands_use_existing_aliases_only(self):
        c = relay.DEFAULT_CONFIG
        self.assertEqual(c["hosts"]["hk"]["ssh"], ["ssh", "smartflow-vps"])
        self.assertTrue(c["hosts"]["linux"]["ssh"][0].endswith("bin-v6q0/lx"))
        for src in (ROOT / "services/research-queue/rq/relay.py", *(ROOT / "deploy/research-queue/mac").iterdir()):
            s = src.read_text()
            self.assertNotIn("ssh-keygen", s)
            self.assertNotIn("id_ed25519", s)

    def test_plist_template_is_valid_and_every_15_minutes(self):
        s = (ROOT / "deploy/research-queue/mac/com.upmeai.research-queue-relay.plist.template").read_text().replace("__HOME__", "/h").replace("__QRP_CHECKOUT__", "/q")
        p = plistlib.loads(s.encode())
        self.assertEqual(p["StartInterval"], 900)
        self.assertEqual(p["Label"], "com.upmeai.research-queue-relay")


if __name__ == "__main__":
    unittest.main()
