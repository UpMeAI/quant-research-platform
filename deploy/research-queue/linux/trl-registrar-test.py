#!/usr/bin/python3
"""Frozen #137 TRL registrar acceptance.  Run off the current Mac."""
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent


def load_runner():
    spec = importlib.util.spec_from_file_location("q137_registrar", HERE / "trl-registrar-run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


registrar = load_runner()


def canonical(value):
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(k) + ":" + canonical(value[k]) for k in sorted(value)) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    return json.dumps(value, separators=(",", ":"))


class RegistrarAcceptance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="q137-registrar-")
        self.root = pathlib.Path(self.temp.name)
        self.run_root = self.root / "runs"
        self.req_dir = self.run_root / "RQT-1" / "outbox" / "trl-requests"
        self.receipt_dir = self.run_root / "RQT-1" / "inbox" / "trl-receipts"
        self.req_dir.mkdir(parents=True)
        self.request = {
            "schema": "TRIAL_REGISTRATION_REQUEST_V1",
            "draft_id": "D1",
            "family_id": "F1",
            "market": "CN_A",
            "k2_sha256": "a" * 64,
            "specs": [{"role": "BASELINE", "family_id": "F1", "market": "CN_A", "k2_sha256": "a" * 64, "config_label": "B"}],
        }
        self.sha = hashlib.sha256(canonical(self.request).encode()).hexdigest()
        self.request_file = self.req_dir / f"{self.sha}.json"
        self.request_file.write_text(json.dumps(self.request) + "\n")

    def tearDown(self):
        self.temp.cleanup()

    def config(self):
        return {
            "run_root": str(self.run_root),
            "node": "/srv/research-lane/tools/node-v23.11.0-linux-x64/bin/node",
            "qrp_root": "/srv/research-lane/qrp/code/pinned",
            "data_dir": "/srv/research-lane/qrp/var/ledger",
            "authority": "V8_1_COORDINATOR",
            "max_request_bytes": 1048576,
        }

    def receipt(self):
        return {"schema": "TRIAL_REGISTRATION_RECEIPT_V1", "request_sha256": self.sha, "rows": []}

    def test_request_maps_only_to_sibling_receipt_and_exact_cli(self):
        calls = []

        class Result:
            returncode = 0
            stderr = b""

        result = Result()
        result.stdout = (json.dumps(self.receipt(), sort_keys=True, separators=(",", ":")) + "\n").encode()

        def fake(argv, **kwargs):
            calls.append((argv, kwargs))
            return result

        out = registrar.process_request(self.request_file, self.config(), run=fake)
        expected = self.receipt_dir / f"{self.sha}.json"
        self.assertEqual(out, expected)
        self.assertEqual(expected.read_bytes(), result.stdout)
        self.assertEqual(expected.stat().st_mode & 0o777, 0o444)
        self.assertEqual(calls[0][0], [
            self.config()["node"],
            self.config()["qrp_root"] + "/apps/research-cli/k2_trl_registrar.js",
            "--request", str(self.request_file.resolve()),
            "--registered-by", "V8_1_COORDINATOR",
        ])
        self.assertEqual(calls[0][1]["env"]["QRP_DATA_DIR"], "/srv/research-lane/qrp/var/ledger")
        self.assertEqual(calls[0][1]["env"]["QRP_PRODUCT_MILESTONE_AUTHORITY"], "V8_1_COORDINATOR")

    def test_replay_is_idempotent_but_mismatch_refuses(self):
        self.receipt_dir.mkdir(parents=True)
        receipt_file = self.receipt_dir / f"{self.sha}.json"
        same = (json.dumps(self.receipt(), sort_keys=True, separators=(",", ":")) + "\n").encode()
        receipt_file.write_bytes(same)

        class Result:
            returncode = 0
            stderr = b""
            stdout = same

        self.assertEqual(registrar.process_request(self.request_file, self.config(), run=lambda *_a, **_k: Result()), receipt_file)
        receipt_file.chmod(0o644)
        receipt_file.write_text('{"schema":"wrong"}\n')
        with self.assertRaisesRegex(registrar.RegistrarError, "TRL_RECEIPT_REPLAY_MISMATCH"):
            registrar.process_request(self.request_file, self.config(), run=lambda *_a, **_k: Result())

    def test_filename_content_symlink_and_escape_are_refused_before_node(self):
        called = []
        wrong = self.req_dir / ("f" * 64 + ".json")
        wrong.write_bytes(self.request_file.read_bytes())
        with self.assertRaisesRegex(registrar.RegistrarError, "TRL_REQUEST_SHA_MISMATCH"):
            registrar.process_request(wrong, self.config(), run=lambda *_a, **_k: called.append(True))

        link = self.req_dir / ("e" * 64 + ".json")
        link.symlink_to(self.request_file)
        with self.assertRaisesRegex(registrar.RegistrarError, "TRL_REQUEST_NOT_REGULAR"):
            registrar.process_request(link, self.config(), run=lambda *_a, **_k: called.append(True))

        outside = self.root / f"{self.sha}.json"
        outside.write_bytes(self.request_file.read_bytes())
        with self.assertRaisesRegex(registrar.RegistrarError, "TRL_REQUEST_OUTSIDE_RUN_ROOT"):
            registrar.process_request(outside, self.config(), run=lambda *_a, **_k: called.append(True))
        self.assertEqual(called, [])

    def test_invalid_receipt_is_never_published(self):
        class Result:
            returncode = 0
            stderr = b""
            stdout = b'{"schema":"TRIAL_REGISTRATION_RECEIPT_V1","request_sha256":"bad","rows":[]}\n'

        with self.assertRaisesRegex(registrar.RegistrarError, "TRL_RECEIPT_INVALID"):
            registrar.process_request(self.request_file, self.config(), run=lambda *_a, **_k: Result())
        self.assertFalse((self.receipt_dir / f"{self.sha}.json").exists())

    def test_unit_and_env_contract(self):
        service = (HERE / "trl-registrar.service").read_text()
        timer = (HERE / "trl-registrar.timer").read_text()
        env = (HERE / "trl-registrar-env.example").read_text()
        for needle in ("EnvironmentFile=", "Nice=10", "IOSchedulingClass=idle", "CPUAffinity=0-7 16-23", "OnFailure=", "/usr/bin/flock", "trl-registrar-run.py"):
            self.assertIn(needle, service)
        self.assertIn("Persistent=true", timer)
        self.assertIn("QRP_DATA_DIR=/srv/research-lane/qrp/var/ledger", env)
        self.assertIn("QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR", env)


if __name__ == "__main__":
    unittest.main()
