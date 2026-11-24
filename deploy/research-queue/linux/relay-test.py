#!/usr/bin/python3
"""Frozen #137 relay acceptance.  Run on Linux/old MBP, never the current Mac."""
import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent


def load_runner():
    spec = importlib.util.spec_from_file_location("q137_relay", HERE / "relay-run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


relay = load_runner()


class RelayAcceptance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="q137-relay-")
        self.root = pathlib.Path(self.temp.name)
        self.var = self.root / "linux-var"
        self.var.mkdir()
        self.authority = self.root / "AUTHORITATIVE"
        self.authority.write_text("LINUX\n")
        self.linux_manifest = self.root / "linux.sha256"
        self.mac_manifest = self.root / "mac.sha256"
        self.linux_manifest.write_text("same\n")
        self.mac_manifest.write_text("same\n")
        self.mode_proof = self.root / "mac-mode.json"
        self.mode_proof.write_text(json.dumps({
            "schema": "QRP_MAC_VAR_MODE_PROOF_V1",
            "path": "/Users/kaylame/KaylaProject/quant-research-platform/var",
            "writable": False,
        }) + "\n")
        self.guard = {
            "authority_marker": str(self.authority),
            "authoritative_dir": str(self.var),
            "linux_manifest": str(self.linux_manifest),
            "mac_manifest": str(self.mac_manifest),
            "mac_mode_proof": str(self.mode_proof),
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_authority_guard_is_fail_closed(self):
        self.assertEqual(relay.guard_qrp_var(self.guard, is_writable=lambda p: pathlib.Path(p) == self.var), self.var.resolve())
        self.mode_proof.write_text('{"schema":"QRP_MAC_VAR_MODE_PROOF_V1","path":"x","writable":true}\n')
        with self.assertRaisesRegex(relay.RelayError, "QRP_VAR_DUAL_WRITABLE"):
            relay.guard_qrp_var(self.guard, is_writable=lambda p: pathlib.Path(p) == self.var)
        self.mode_proof.write_text('{"schema":"QRP_MAC_VAR_MODE_PROOF_V1","path":"x","writable":false}\n')
        self.mac_manifest.write_text("different\n")
        with self.assertRaisesRegex(relay.RelayError, "QRP_VAR_MANIFEST_MISMATCH"):
            relay.guard_qrp_var(self.guard, is_writable=lambda p: pathlib.Path(p) == self.var)
        self.authority.unlink()
        with self.assertRaisesRegex(relay.RelayError, "QRP_VAR_AUTHORITY_MISSING"):
            relay.guard_qrp_var(self.guard, is_writable=lambda p: pathlib.Path(p) == self.var)

    def test_local_delivery_marks_first_is_atomic_and_idempotent(self):
        source = self.root / "relay-outbox" / "linux" / "REVIEW_AI_FACT_PACK_V1" / "pack.json"
        dest = self.root / "inbox" / "fact-packs" / "pack.json"
        source.parent.mkdir(parents=True)
        source.write_bytes(b'{"schema":"REVIEW_AI_FACT_PACK_V1"}\n')
        events = []

        def marker(data):
            events.append(("mark", hashlib.sha256(data).hexdigest(), dest.exists()))
            return None

        got = relay.deliver_local(source, dest, marker=marker, validator=lambda _data: None)
        self.assertEqual(got, "DELIVERED")
        self.assertEqual(events[0][2], False)
        self.assertFalse(source.exists())
        self.assertEqual(hashlib.sha256(dest.read_bytes()).hexdigest(), events[0][1])

        source.write_bytes(dest.read_bytes())
        self.assertEqual(relay.deliver_local(source, dest, marker=marker, validator=lambda _data: None), "REPLAY")
        self.assertFalse(source.exists())

    def test_local_failure_never_removes_source_or_overwrites(self):
        source = self.root / "source.json"
        dest = self.root / "dest.json"
        source.write_text("new\n")
        dest.write_text("old\n")
        with self.assertRaisesRegex(relay.RelayError, "LOCAL_DEST_SHA_MISMATCH"):
            relay.deliver_local(source, dest, marker=lambda _data: None, validator=lambda _data: None)
        self.assertEqual(source.read_text(), "new\n")
        self.assertEqual(dest.read_text(), "old\n")

        dest.unlink()
        with self.assertRaisesRegex(relay.RelayError, "SEEN_MARK_FAILED:AUTHORITY"):
            relay.deliver_local(source, dest, marker=lambda _data: "AUTHORITY", validator=lambda _data: None)
        self.assertTrue(source.exists())
        self.assertFalse(dest.exists())

    def test_node_marker_exact_argv_and_authority_only_in_environment(self):
        calls = []

        class Result:
            returncode = 0
            stderr = b""

        def fake(argv, **kwargs):
            calls.append((argv, kwargs))
            return Result()

        env = {"QRP_PRODUCT_MILESTONE_AUTHORITY": "V8_1_COORDINATOR", "QRP_DATA_DIR": str(self.var)}
        marker = relay.NodeSeenMarker("/srv/research-lane/qrp/code/pinned", "/srv/research-lane/tools/node-v23.11.0-linux-x64/bin/node", env, run=fake)
        self.assertIsNone(marker(b"{}\n"))
        self.assertEqual(calls[0][0], [
            "/srv/research-lane/tools/node-v23.11.0-linux-x64/bin/node",
            "/srv/research-lane/qrp/code/pinned/apps/research-cli/review_pack_seen.js",
            "mark", "--file", "-",
        ])
        self.assertEqual(calls[0][1]["input"], b"{}\n")
        self.assertEqual(calls[0][1]["env"], env)
        self.assertNotIn("V8_1_COORDINATOR", " ".join(calls[0][0]))

    def test_hk_transport_is_fixed_rsync_without_remote_shell(self):
        calls = []

        class Result:
            returncode = 0
            stderr = b""

        transport = relay.GateRsyncTransport("root@smartflow-hk", "/usr/bin/rsync", run=lambda argv, **kw: calls.append(argv) or Result())
        stage = self.root / "stage"
        stage.mkdir()
        pull = self.root / "pull"
        transport.push_fact_packs(stage)
        transport.pull_returns(pull)
        self.assertEqual(calls[0], ["/usr/bin/rsync", "-a", "--checksum", "--delay-updates", "--", f"{stage}/", "root@smartflow-hk:fact-packs/"])
        self.assertEqual(calls[1], ["/usr/bin/rsync", "-a", "--checksum", "--", "root@smartflow-hk:/var/lib/research-queue/outbox/", f"{pull}/"])
        joined = "\n".join(" ".join(c) for c in calls)
        for forbidden in ("sh -c", "scp", "sftp", "--remove-source-files", "--protect-args", ";", "|"):
            self.assertNotIn(forbidden, joined)

    def test_unit_and_env_contract(self):
        service = (HERE / "relay-linux.service").read_text()
        timer = (HERE / "relay-linux.timer").read_text()
        env = (HERE / "relay-env.example").read_text()
        for needle in ("EnvironmentFile=", "Nice=10", "IOSchedulingClass=idle", "CPUAffinity=0-7 16-23", "OnFailure=", "/usr/bin/flock", "relay-run.py"):
            self.assertIn(needle, service)
        self.assertIn("Persistent=true", timer)
        self.assertIn("QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR", env)
        self.assertIn("RQ_SEEN_MARK_QRP_ROOT=", env)
        self.assertNotIn("RQ_SEEN_MARK_QRP_ROOT=/", env)
        self.assertIn("QRP_DATA_DIR=/srv/research-lane/qrp/var/ledger", env)

    def test_shadow_is_pull_only_and_confined_to_scratch(self):
        outbox = self.root / "relay-outbox"
        for host in ("linux", "hk"):
            source = outbox / host / "REVIEW_AI_FACT_PACK_V1" / f"{host}.json"
            source.parent.mkdir(parents=True)
            source.write_text('{}\n')
        local_returns = self.root / "queue-outbox"; local_returns.mkdir(); (local_returns / "local.json").write_text('{}\n')
        calls = []

        class Result:
            returncode = 0
            stderr = b""

        def fake(argv, **_kwargs):
            calls.append(argv)
            destination = pathlib.Path(argv[-1].rstrip("/"))
            destination.mkdir(parents=True, exist_ok=True)
            (destination / "hk.json").write_text('{}\n')
            return Result()

        config = {"authority": "V8_1_COORDINATOR", "node": relay.NODE, "outbox_root": str(outbox),
                  "queue_outbox": str(local_returns), "hk_target": "root@smartflow-hk"}
        shadow = self.root / "shadow"
        got = relay.run_shadow(config, shadow, run=fake, scratch_root=self.root)
        self.assertEqual(got["mode"], "SHADOW_NO_UPLOAD")
        self.assertEqual([x["name"] for x in got["returns"]["linux"]], ["local.json"])
        self.assertEqual([x["name"] for x in got["returns"]["hk"]], ["hk.json"])
        self.assertEqual(len(calls), 1)
        self.assertIn("root@smartflow-hk:/var/lib/research-queue/outbox/", calls[0])
        self.assertNotIn(":fact-packs/", " ".join(calls[0]))
        with self.assertRaisesRegex(relay.RelayError, "SHADOW_ROOT_OUTSIDE_SCRATCH"):
            relay.run_shadow(config, self.root.parent / "outside", run=fake, scratch_root=self.root)


if __name__ == "__main__":
    unittest.main()
