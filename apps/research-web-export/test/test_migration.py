import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).parents[3]
APP = ROOT / "apps" / "research-web-export"
DEPLOY = ROOT / "deploy" / "qrp-research-web"
sys.path.insert(0, str(APP))

import authority
import parity
import tunnel


SHA = "a" * 64


class FakeFacts:
    def __init__(self, *, writable=False, token_mode=0o600):
        self.writable = writable
        self.token_mode = token_mode
        self.guard_calls = []
        self.reads = []

    def is_dir(self, path):
        return True

    def is_file(self, path):
        return True

    def is_writable(self, path):
        return self.writable

    def git_head(self, path):
        return SHA

    def git_clean(self, path):
        return True

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
        "QRP_DESK_REVIEW_LOOP_ROOT": "/srv/research-lane/ops/state/review-loop-mirror/current",
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


class TunnelTest(unittest.TestCase):
    def test_edge_is_off_by_default(self):
        with self.assertRaisesRegex(tunnel.TunnelError, "QRP_EDGE_DISABLED"):
            tunnel.command({"QRP_WEB_EDGE": "OFF"}, facts=FakeFacts())

    def test_exact_binary_and_token_metadata_without_token_read(self):
        facts = FakeFacts()
        env = {
            "QRP_WEB_EDGE": "ON",
            "QRP_CLOUDFLARED_BIN": "/srv/research-lane/tools/cloudflared-2026.11.1/cloudflared",
            "QRP_CLOUDFLARED_TOKEN_FILE": "/home/kayla/.config/cloudflared/qrp-research-web.token",
        }
        argv = tunnel.command(env, facts=facts)
        self.assertEqual(env["QRP_CLOUDFLARED_BIN"], argv[0])
        self.assertEqual(["tunnel", "--no-autoupdate", "run", "--token-file", env["QRP_CLOUDFLARED_TOKEN_FILE"]], argv[1:])
        self.assertEqual([], facts.reads)
        with self.assertRaisesRegex(tunnel.TunnelError, "QRP_TUNNEL_TOKEN_MODE"):
            tunnel.command(env, facts=FakeFacts(token_mode=0o644))


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
        ):
            self.assertIn(phrase, text)
        self.assertLess(text.index("systemctl --user disable --now"), text.index("launchctl bootstrap"))


if __name__ == "__main__":
    unittest.main()
