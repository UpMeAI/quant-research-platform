import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock


ROOT = pathlib.Path(__file__).parents[3]
APP = ROOT / "apps" / "research-web-export"
DEPLOY = ROOT / "deploy" / "qrp-research-web"
sys.path.insert(0, str(APP))

import authority
import parity
import tunnel
import web_run


SHA = "a" * 64


class FakeFacts:
    def __init__(self, *, writable=False, token_mode=0o600, desk_head=SHA,
                 desk_clean=True, mirror_valid=True, binary_sha=None):
        self.writable = writable
        self.token_mode = token_mode
        self.desk_head = desk_head
        self.desk_clean = desk_clean
        self.mirror_valid = mirror_valid
        self.binary_sha = binary_sha or ("b" * 64)
        self.guard_calls = []
        self.reads = []

    def is_dir(self, path):
        return True

    def is_file(self, path):
        return True

    def is_writable(self, path):
        return self.writable

    def git_head(self, path):
        return self.desk_head if "portfolio-desk" in str(path) else SHA

    def git_clean(self, path):
        return self.desk_clean if "portfolio-desk" in str(path) else True

    def review_mirror_valid(self, current, mirror_root, commit, manifest):
        return self.mirror_valid

    def binary_sha256(self, path):
        return self.binary_sha

    def token_metadata(self, path):
        return {"mode": self.token_mode, "regular": True, "symlink": False}

    def read_token(self, path):
        self.reads.append(path)
        raise AssertionError("token content must never be read")

    def delegate_guard(self, module, config):
        self.guard_calls.append((module, config))
        return pathlib.Path(config["authoritative_dir"])


def base_env(mode="POST_SWITCH"):
    return {
        "QRP_WEB_MODE": mode,
        "QRP_ROOT": f"/srv/research-lane/qrp/code/{SHA}",
        "QRP_PINNED_SHA": SHA,
        "QRP_VAR_ROOT": authority.POST_SWITCH_VAR if mode == "POST_SWITCH" else authority.PRE_SWITCH_VAR,
        "QRP_DATA_DIR": (authority.POST_SWITCH_VAR if mode == "POST_SWITCH" else authority.PRE_SWITCH_VAR) + "/ledger",
        "QRP_DESK_ROOT": "/srv/research-lane/ops/desk/portfolio-desk",
        "QRP_DESK_PINNED_SHA": SHA,
        "QRP_DESK_REVIEW_LOOP_ROOT": "/srv/research-lane/qrp/review-loop-mirror/current",
        "QRP_REVIEW_LOOP_COMMIT": "c" * 40,
        "QRP_REVIEW_LOOP_MANIFEST": "/srv/research-lane/qrp/review-loop-mirror/manifests/" + ("c" * 40) + ".sha256",
        "QRP_PRODUCT_MILESTONE_AUTHORITY": "V8_1_COORDINATOR",
        "QRP_NODE": "/srv/research-lane/tools/node-v23.11.0-linux-x64/bin/node",
        "QRP_HOST": "127.0.0.1",
        "QRP_PORT": "4311",
        "QRP_AUTHORITY_MARKER": "/srv/research-lane/qrp/AUTHORITATIVE",
        "QRP_VAR_LINUX_MANIFEST": "/srv/research-lane/qrp/migration/linux-var.sha256",
        "QRP_VAR_MAC_MANIFEST": "/srv/research-lane/qrp/migration/mac-var.sha256",
        "QRP_MAC_VAR_MODE_PROOF": "/srv/research-lane/qrp/migration/mac-var-mode.json",
        "QRP_VAR_GUARD_MODULE": f"/srv/research-lane/qrp/code/{SHA}/deploy/research-queue/linux/relay-run.py",
        "QRP_WEB_STATUS": "/srv/research-lane/ops-logs/qrp-research-web/status.json",
    }


class AuthorityTest(unittest.TestCase):
    def test_post_switch_delegates_to_package_137_exactly(self):
        facts = FakeFacts()
        config = authority.validate(base_env(), facts=facts)
        self.assertEqual(authority.POST_SWITCH_VAR, str(config.var_root))
        self.assertEqual(1, len(facts.guard_calls))
        delegated = facts.guard_calls[0][1]
        self.assertEqual(authority.POST_SWITCH_VAR, delegated["authoritative_dir"])
        self.assertEqual("/srv/research-lane/qrp/AUTHORITATIVE", delegated["authority_marker"])

    def test_named_guard_failures_are_not_relabelled(self):
        class Refusing(FakeFacts):
            def delegate_guard(self, module, config):
                raise RuntimeError("QRP_VAR_MANIFEST_MISMATCH")
        with self.assertRaisesRegex(RuntimeError, "^QRP_VAR_MANIFEST_MISMATCH$"):
            authority.validate(base_env(), facts=Refusing())

    def test_pre_switch_mirror_must_be_read_only(self):
        with self.assertRaisesRegex(authority.AuthorityError, "QRP_VAR_DUAL_WRITABLE"):
            authority.validate(base_env("PRE_SWITCH_COMPARE"), facts=FakeFacts(writable=True))
        config = authority.validate(base_env("PRE_SWITCH_COMPARE"), facts=FakeFacts(writable=False))
        self.assertEqual(authority.PRE_SWITCH_VAR, str(config.var_root))

    def test_unknown_paths_modes_and_tokens_fail_closed(self):
        mutations = []
        bad = base_env(); bad["QRP_WEB_MODE"] = "AUTO"; mutations.append(bad)
        bad = base_env(); bad["QRP_VAR_ROOT"] = "/tmp/var"; mutations.append(bad)
        bad = base_env(); bad["QRP_DATA_DIR"] = authority.POST_SWITCH_VAR; mutations.append(bad)
        bad = base_env(); bad["QRP_HOST"] = "0.0.0.0"; mutations.append(bad)
        bad = base_env(); bad["QRP_RUNTIME_TOKEN"] = "must-not-exist"; mutations.append(bad)
        bad = base_env(); bad["QRP_RESEARCH_TOKEN"] = "must-not-exist"; mutations.append(bad)
        for env in mutations:
            with self.subTest(env=env), self.assertRaises(authority.AuthorityError):
                authority.validate(env, facts=FakeFacts())

    def test_desk_dependency_requires_exact_commit_and_clean_tree(self):
        with self.assertRaisesRegex(authority.AuthorityError, "QRP_DESK_PIN_MISMATCH"):
            authority.validate(base_env(), facts=FakeFacts(desk_head="d" * 64))
        with self.assertRaisesRegex(authority.AuthorityError, "QRP_DESK_CHECKOUT_DIRTY"):
            authority.validate(base_env(), facts=FakeFacts(desk_clean=False))

    def test_review_loop_dependency_requires_bound_commit_and_manifest(self):
        with self.assertRaisesRegex(authority.AuthorityError, "QRP_REVIEW_LOOP_MANIFEST_MISMATCH"):
            authority.validate(base_env(), facts=FakeFacts(mirror_valid=False))
        bad = base_env(); bad["QRP_REVIEW_LOOP_COMMIT"] = "not-a-commit"
        with self.assertRaisesRegex(authority.AuthorityError, "QRP_REVIEW_LOOP_COMMIT_INVALID"):
            authority.validate(bad, facts=FakeFacts())


class TunnelTest(unittest.TestCase):
    def test_edge_is_off_by_default(self):
        with self.assertRaisesRegex(tunnel.TunnelError, "QRP_EDGE_DISABLED"):
            tunnel.command({"QRP_WEB_EDGE": "OFF"}, facts=FakeFacts())

    def test_exact_binary_and_token_metadata_without_token_read(self):
        facts = FakeFacts()
        env = {
            "QRP_WEB_EDGE": "ON",
            "QRP_CLOUDFLARED_BIN": "/srv/research-lane/tools/cloudflared-2026.11.1/cloudflared",
            "QRP_CLOUDFLARED_VERSION": "2026.11.1",
            "QRP_CLOUDFLARED_SHA256": "b" * 64,
            "QRP_CLOUDFLARED_TOKEN_FILE": "/home/kayla/.config/cloudflared/qrp-research-web.token",
        }
        argv = tunnel.command(env, facts=facts)
        self.assertEqual(env["QRP_CLOUDFLARED_BIN"], argv[0])
        self.assertEqual(["tunnel", "--no-autoupdate", "run", "--token-file", env["QRP_CLOUDFLARED_TOKEN_FILE"]], argv[1:])
        self.assertEqual([], facts.reads)
        with self.assertRaisesRegex(tunnel.TunnelError, "QRP_TUNNEL_TOKEN_MODE"):
            tunnel.command(env, facts=FakeFacts(token_mode=0o644))

    def test_binary_version_and_sha_are_both_bound(self):
        env = {
            "QRP_WEB_EDGE": "ON",
            "QRP_CLOUDFLARED_BIN": "/srv/research-lane/tools/cloudflared-2026.11.1/cloudflared",
            "QRP_CLOUDFLARED_VERSION": "2026.11.1",
            "QRP_CLOUDFLARED_SHA256": "b" * 64,
            "QRP_CLOUDFLARED_TOKEN_FILE": "/home/kayla/.config/cloudflared/qrp-research-web.token",
        }
        bad_version = dict(env); bad_version["QRP_CLOUDFLARED_VERSION"] = "2026.10.0"
        with self.assertRaisesRegex(tunnel.TunnelError, "QRP_CLOUDFLARED_VERSION_MISMATCH"):
            tunnel.command(bad_version, facts=FakeFacts())
        with self.assertRaisesRegex(tunnel.TunnelError, "QRP_CLOUDFLARED_SHA256_MISMATCH"):
            tunnel.command(env, facts=FakeFacts(binary_sha="d" * 64))

    def test_unverified_process_stays_starting_without_last_ok(self):
        env = {
            "QRP_WEB_EDGE": "ON",
            "QRP_CLOUDFLARED_BIN": "/srv/research-lane/tools/cloudflared-2026.11.1/cloudflared",
            "QRP_CLOUDFLARED_VERSION": "2026.11.1",
            "QRP_CLOUDFLARED_SHA256": "b" * 64,
            "QRP_CLOUDFLARED_TOKEN_FILE": "/home/kayla/.config/cloudflared/qrp-research-web.token",
            "QRP_TUNNEL_STATUS": tunnel.STATUS_FILE,
            "QRP_TUNNEL_PID_FILE": "/run/user/1000/qrp-research-web/cloudflared.pid",
        }
        process = SimpleNamespace(poll=lambda: None, terminate=lambda: None,
                                  wait=lambda timeout=None: 1,
                                  send_signal=lambda signum: None, pid=4321)
        writes = []
        with mock.patch.object(tunnel.status, "write", side_effect=lambda path, payload: writes.append(payload)):
            rc = tunnel.run(env, facts=FakeFacts(), popen=lambda argv: process,
                            ready=lambda path, pid: False,
                            clock=iter((0, 31)).__next__, sleep=lambda _: None)
        self.assertEqual(1, rc)
        self.assertEqual("STARTING", writes[0]["state"])
        self.assertIsNone(writes[0]["lastOkAt"])
        self.assertFalse(any(row["state"] == "RUNNING" for row in writes))


class ParityTest(unittest.TestCase):
    def test_qrp_exact_routes_and_only_one_volatile_pointer(self):
        self.assertEqual(5, len(parity.QRP_ROUTES))
        responses = {
            "/": (200, "text/html", b"<html>same</html>"),
            "/api/workspace": (200, "application/json", b'{"schema":"W","value":1}'),
            "/api/strategies": (200, "application/json", b'{"rows":[1]}'),
            "/api/runtime-status": (200, "application/json", b'{"health":{"generatedAt":"A","state":"OK"}}'),
            "/api/runtime-research-loop": (200, "application/json", b'{"state":"READ_ONLY"}'),
        }
        left = parity.capture_qrp(lambda route: responses[route], "2026-11-24T15:00:00+08:00")
        changed = dict(responses)
        changed["/api/runtime-status"] = (200, "application/json", b'{"health":{"generatedAt":"B","state":"OK"}}')
        right = parity.capture_qrp(lambda route: changed[route], "2026-11-24T15:00:10+08:00")
        self.assertEqual("PASS", parity.compare_qrp(left, right)["result"])
        changed["/api/runtime-status"] = (200, "application/json", b'{"health":{"generatedAt":"B","state":"BAD"}}')
        mismatch = parity.capture_qrp(lambda route: changed[route], "2026-11-24T15:00:20+08:00")
        with self.assertRaisesRegex(parity.ParityError, "QRP_ROUTE_MISMATCH"):
            parity.compare_qrp(left, mismatch)

    def test_desk_requires_expected_commit_same_routes_and_200(self):
        routes = ["/", "/strategy", "/system"]
        fetch = lambda route: (200, "text/html", route.encode())
        left = parity.capture_desk(fetch, routes, "abc123")
        right = parity.capture_desk(fetch, routes, "abc123")
        self.assertEqual("PASS", parity.compare_desk(left, right, "abc123")["result"])
        right["commit"] = "other"
        with self.assertRaisesRegex(parity.ParityError, "DESK_COMMIT_MISMATCH"):
            parity.compare_desk(left, right, "abc123")
        right = parity.capture_desk(lambda route: (500 if route == "/system" else 200, "text/html", b"x"), routes, "abc123")
        with self.assertRaisesRegex(parity.ParityError, "DESK_ROUTE_NOT_200"):
            parity.compare_desk(left, right, "abc123")

    def test_desk_rejects_content_type_and_body_mismatch(self):
        routes = ["/", "/strategy"]
        left = parity.capture_desk(lambda route: (200, "text/html", route.encode()), routes, "abc123")
        content_changed = parity.capture_desk(lambda route: (200, "application/json", route.encode()), routes, "abc123")
        with self.assertRaisesRegex(parity.ParityError, "DESK_CONTENT_MISMATCH"):
            parity.compare_desk(left, content_changed, "abc123")
        body_changed = parity.capture_desk(lambda route: (200, "text/html", (route + "x").encode()), routes, "abc123")
        with self.assertRaisesRegex(parity.ParityError, "DESK_CONTENT_MISMATCH"):
            parity.compare_desk(left, body_changed, "abc123")


class RuntimeReadinessTest(unittest.TestCase):
    def test_origin_requires_all_five_real_route_probes(self):
        seen = []
        def fetch(route):
            seen.append(route)
            return (503 if route == "/api/strategies" else 200, "application/json", b"{}")
        with self.assertRaisesRegex(web_run.OriginNotReady, "QRP_ROUTE_NOT_200"):
            web_run.probe_origin(fetch)
        self.assertEqual(list(parity.QRP_ROUTES[:3]), seen)


class IsolatedLaunchTest(unittest.TestCase):
    def test_absolute_runtime_directory_imports_under_isolated_python(self):
        runtime = APP / "runtime"
        unit = (DEPLOY / "ops-qrp-research-web.service").read_text()
        self.assertIn(
            "ExecStart=/usr/bin/python3 -I -B /srv/research-lane/ops/qrp-research-web/runtime web",
            unit,
        )
        result = subprocess.run(
            [sys.executable, "-I", "-B", str(runtime), "web", "--help"],
            cwd="/", capture_output=True, text=True, timeout=15, check=False,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("web", result.stdout)


class DeliveryTest(unittest.TestCase):
    def test_units_are_loopback_pinned_and_inert(self):
        web = (DEPLOY / "ops-qrp-research-web.service").read_text()
        edge = (DEPLOY / "ops-qrp-tunnel.service").read_text()
        for text in (web, edge):
            self.assertIn("OnFailure=ops-notify@%n.service", text)
            self.assertIn("CPUAffinity=0-7 16-23", text)
            self.assertIn("Nice=10", text)
            self.assertIn("Restart=on-failure", text)
            self.assertIn("/srv/research-lane/ops-logs/qrp-research-web/", text)
        self.assertIn("MemoryMax=1G", web)
        self.assertIn("EnvironmentFile=/home/kayla/.config/ops-env/qrp-research-web.env", web)
        self.assertIn("EnvironmentFile=/home/kayla/.config/ops-env/qrp-tunnel.env", edge)
        self.assertNotIn("CLOUDFLARE_API_TOKEN=", web + edge)

    def test_runbook_freezes_external_and_rollback_boundaries(self):
        text = (DEPLOY / "RUNBOOK.md").read_text()
        for phrase in (
            "systemctl --user disable --now", "read back inactive", "launchctl bootstrap",
            "Owner-only", "#134", "#131", "QRP_VAR_DUAL_WRITABLE",
            "QRP_VAR_MANIFEST_MISMATCH", "150 GiB", "mac-mirror-to-linux.sh",
            "QRP_RUNTIME_TOKEN", "QRP_RESEARCH_TOKEN", "NOT_VERIFIED",
            "R-c2", "#152", "contentType", "bodySha256",
        ):
            self.assertIn(phrase, text)
        self.assertLess(text.index("systemctl --user disable --now"), text.index("launchctl bootstrap"))


if __name__ == "__main__":
    unittest.main()
