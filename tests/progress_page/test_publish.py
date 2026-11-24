import datetime as dt
import pathlib
import stat
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, str(pathlib.Path(__file__).parents[2] / "services" / "progress-page"))

from progress.publish import publish


NOW = dt.datetime(2026, 11, 26, 9, 7, 2, tzinfo=dt.timezone(dt.timedelta(hours=8)))


class Result:
    def __init__(self, code=0): self.returncode = code


class Response:
    def __init__(self, code, body=b"", url="https://kayla-progress.pages.dev/"):
        self.status, self._body, self.url = code, body, url
    def read(self): return self._body
    def geturl(self): return self.url
    def __enter__(self): return self
    def __exit__(self, *_): return False


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.site = self.root / "site"; self.site.mkdir()
        (self.site / "index.html").write_text('<meta name="progress-page" content="PROGRESS_REGISTRY_V1">')
        (self.site / "registry.json").write_text('{"x":1}')
        self.state = self.root / "state"; self.state.mkdir()
        self.token = self.root / "token.env"
        self.token.write_text("CLOUDFLARE_API_TOKEN=STUB_SECRET_VALUE\nCLOUDFLARE_ACCOUNT_ID=account\n")
        self.token.chmod(stat.S_IRUSR | stat.S_IWUSR)
        self.cfg = {"enabled": True, "project": "kayla-progress", "wrangler": "/fixed/wrangler", "node_bin": "/fixed/node/bin", "token_env_file": str(self.token), "public_url": "https://kayla-progress.pages.dev/", "min_interval_h": 2}

    def tearDown(self): self.temp.cleanup()

    def test_disabled_and_locked_never_call_runner(self):
        calls = []
        disabled = dict(self.cfg, enabled=False)
        self.assertEqual("DISABLED", publish(self.site, disabled, self.state, runner=lambda *a, **k: calls.append(a), opener=None, now=NOW)["state"])
        (self.state / "upload.disabled").write_text("locked")
        self.assertEqual("DISABLED_LOCKED", publish(self.site, self.cfg, self.state, runner=lambda *a, **k: calls.append(a), opener=None, now=NOW)["state"])
        self.assertEqual([], calls)

    def test_exact_command_env_and_access_redirect(self):
        seen = {}
        def runner(argv, **kwargs): seen.update(argv=argv, kwargs=kwargs); return Result()
        result = publish(self.site, self.cfg, self.state, runner=runner, opener=lambda *a, **k: Response(302, url="https://x.cloudflareaccess.com/"), now=NOW)
        self.assertEqual("UPLOADED", result["state"])
        self.assertEqual(["/fixed/wrangler", "pages", "deploy", str(self.site), "--project-name", "kayla-progress", "--branch", "main", "--commit-dirty=true"], seen["argv"])
        self.assertEqual({"PATH", "HOME", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"}, set(seen["kwargs"]["env"]))
        self.assertNotIn("STUB_SECRET_VALUE", repr(result))

    def test_public_page_locks_and_network_error_does_not(self):
        result = publish(self.site, self.cfg, self.state, runner=lambda *a, **k: Result(), opener=lambda *a, **k: Response(200, (self.site / "index.html").read_bytes()), now=NOW)
        self.assertEqual("ACCESS_NOT_ENFORCED", result["state"])
        self.assertTrue((self.state / "upload.disabled").exists())
        (self.state / "upload.disabled").unlink()
        def unavailable(*_a, **_k): raise urllib.error.URLError("down")
        result = publish(self.site, self.cfg, self.state, runner=lambda *a, **k: Result(), opener=unavailable, now=NOW)
        self.assertEqual("ACCESS_CHECK_UNREACHABLE", result["state"])
        self.assertFalse((self.state / "upload.disabled").exists())

    def test_bad_token_file_and_failed_upload(self):
        self.token.unlink()
        calls = []
        result = publish(self.site, self.cfg, self.state, runner=lambda *a, **k: calls.append(a), opener=None, now=NOW)
        self.assertEqual(("FAILED", "TOKEN_FILE_ABSENT"), (result["state"], result["reason"]))
        self.assertEqual([], calls)
        self.token.write_text("CLOUDFLARE_API_TOKEN=x\nCLOUDFLARE_ACCOUNT_ID=y\n"); self.token.chmod(0o644)
        result = publish(self.site, self.cfg, self.state, runner=lambda *a, **k: Result(), opener=None, now=NOW)
        self.assertEqual("TOKEN_FILE_MODE", result["reason"])


if __name__ == "__main__":
    unittest.main()
