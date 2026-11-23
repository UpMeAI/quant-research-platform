"""AQ-17H / AQ-17L (static part and the evaluator), AQ-18 unit side, AQ-19 unit side. The real cap proofs run at install."""
import json, pathlib, re, shutil, subprocess, tarfile, tempfile, unittest
from helpers import *  # noqa
from rq import capproof  # noqa

D = ROOT / "deploy" / "research-queue"


def unit(host, name):
    out = {}
    cur = None
    for line in (D / host / name).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            cur = line
            continue
        k, _, v = line.partition("=")
        out.setdefault((cur, k), []).append(v)
    return out


def val(u, sec, key):
    return u[("[%s]" % sec, key)][-1]


class LinuxUnits(unittest.TestCase):
    def test_files_present(self):
        for n in ("research.slice", "rq-producer.service", "rq-producer.timer", "rq-consumer.service", "rq-pause.service", "rq-pause.timer"):
            self.assertTrue((D / "linux" / n).exists(), n)

    def test_slice_caps(self):
        u = unit("linux", "research.slice")
        self.assertEqual(val(u, "Slice", "CPUQuota"), "1200%")
        self.assertEqual(val(u, "Slice", "MemoryMax"), "40G")
        self.assertEqual(val(u, "Slice", "IOWeight"), "50")

    def test_units_are_user_units_in_research_slice(self):
        for n in ("rq-producer.service", "rq-consumer.service", "rq-pause.service"):
            u = unit("linux", n)
            self.assertEqual(val(u, "Service", "Slice"), "research.slice", n)
            self.assertNotIn(("[Service]", "User"), u, n)  # user units have no User=
            self.assertEqual(val(u, "Service", "NoNewPrivileges"), "yes", n)
        c = unit("linux", "rq-consumer.service")
        self.assertEqual(val(c, "Service", "KillMode"), "process")  # tasks and the consumer's children outlive a consumer crash
        self.assertEqual(val(c, "Service", "Restart"), "always")
        self.assertEqual(val(unit("linux", "rq-pause.timer"), "Timer", "OnCalendar"), "*-*-* *:*:05")

    def test_pause_does_not_start_before_rf1116_timer_is_disabled_note(self):
        doc = (ROOT / "deploy/research-lane/round-runner/DEPLOY.md").read_text()
        self.assertIn("rq-pause", doc)
        self.assertIn("rf1116-window-pause.timer", doc)

    def test_cap_proof_script_and_evaluator_linux(self):
        sh = D / "cap-proof.sh"
        self.assertTrue(sh.exists())
        self.assertEqual(subprocess.run(["bash", "-n", str(sh)]).returncode, 0)
        ok = capproof.evaluate("LINUX", {"cpu_seconds": 118.0, "window_s": 120, "quota_cpus": 12, "burner_cpus": 16, "oom_kill": 1, "cgroup_parent_result": "REFUSED:operation not permitted"})
        self.assertEqual(ok, [])
        bad = capproof.evaluate("LINUX", {"cpu_seconds": 118.0, "window_s": 120, "quota_cpus": 12, "burner_cpus": 16, "oom_kill": 1})
        self.assertTrue(any("cgroup_parent_result" in b for b in bad))  # the --cgroup-parent outcome must be recorded
        over = capproof.evaluate("LINUX", {"cpu_seconds": 12.0 * 120 * 1.2, "window_s": 120, "quota_cpus": 12, "burner_cpus": 16, "oom_kill": 1, "cgroup_parent_result": "OK"})
        self.assertTrue(any("cpu" in b for b in over))


class HKUnits(unittest.TestCase):
    NAMES = ("research.slice", "rq-producer.service", "rq-producer.timer", "rq-consumer.service", "rq-pause.service", "rq-pause.timer")

    def test_files_present(self):
        for n in self.NAMES + ("rq.sysusers.conf", "rq.tmpfiles.conf"):
            self.assertTrue((D / "hk" / n).exists(), n)

    def test_slice_caps_match_plan(self):
        u = unit("hk", "research.slice")
        exp = {"CPUQuota": "100%", "CPUWeight": "10", "MemoryMax": "512M", "MemorySwapMax": "0", "IOWeight": "10",
               "IOReadBandwidthMax": "/dev/vda 20M", "IOWriteBandwidthMax": "/dev/vda 10M", "TasksMax": "64"}
        for k, v in exp.items():
            self.assertEqual(val(u, "Slice", k), v, k)

    def test_aq18_every_hk_rq_unit_denies_ip_except_none_listed_here(self):
        for n in ("rq-producer.service", "rq-consumer.service"):
            u = unit("hk", n)
            self.assertEqual(val(u, "Service", "IPAddressDeny"), "any", n)
            for k, v in (("User", "research-queue"), ("Slice", "research.slice"), ("Nice", "19"), ("IOSchedulingClass", "idle"),
                         ("OOMScoreAdjust", "1000"), ("NoNewPrivileges", "yes"), ("PrivateTmp", "yes"), ("ProtectSystem", "strict"),
                         ("ProtectHome", "yes"), ("ReadWritePaths", "/var/lib/research-queue /var/lib/rq-spool" if n == "rq-consumer.service" else "/var/lib/research-queue")):  # Q3c: the consumer also writes the agent spool
                self.assertEqual(val(u, "Service", k), v, "%s %s" % (n, k))
            self.assertEqual(val(u, "Service", "CapabilityBoundingSet"), "")
        self.assertEqual(val(unit("hk", "rq-consumer.service"), "Service", "KillMode"), "process")
        p = unit("hk", "rq-pause.service")  # root: it freezes units; it still has no network
        self.assertEqual(val(p, "Service", "IPAddressDeny"), "any")
        self.assertNotIn(("[Service]", "User"), p)

    def test_aq19_no_database_access_on_hk(self):
        for p in (D / "hk").iterdir():
            s = p.read_text().lower()
            for bad in ("research_ro", "3306", "mysql", "export-crypto-desk", "binance"):
                self.assertNotIn(bad, s, "%s in %s" % (bad, p.name))

    def test_users_and_dirs(self):
        s = (D / "hk/rq.sysusers.conf").read_text()
        for u in ("research-queue", "rq-agent", "rq-gw"):
            self.assertRegex(s, r"(?m)^u\s+%s\s" % u)
        self.assertRegex(s, r"(?m)^g\s+rq\b")
        t = (D / "hk/rq.tmpfiles.conf").read_text()
        self.assertRegex(t, r"(?m)^d /var/lib/research-queue\s+2770 research-queue rq")
        self.assertRegex(t, r"(?m)^d /var/lib/rq-gw\s+0700 rq-gw rq-gw")
        self.assertNotIn("/var/lib/research-queue/gateway", t)

    def test_cap_proof_evaluator_hk(self):
        good = {"cpu_seconds": 120.0, "window_s": 120, "oom_kill": 1, "peak_bytes": 500 * 2**20, "pm2_restarts": 0, "new_error_lines": 0,
                "load5": 1.2, "agent_tcp_connect": "EPERM", "db_from_rq": "UNREACHABLE"}
        self.assertEqual(capproof.evaluate("HK", good), [])
        for key, bad in (("cpu_seconds", 130.0), ("oom_kill", 0), ("peak_bytes", 600 * 2**20), ("pm2_restarts", 1), ("new_error_lines", 2),
                         ("load5", 3.0), ("agent_tcp_connect", "OK"), ("db_from_rq", "REACHABLE")):
            errs = capproof.evaluate("HK", dict(good, **{key: bad}))
            self.assertTrue(any(key in e for e in errs), key)
        self.assertTrue(capproof.evaluate("HK", {k: v for k, v in good.items() if k != "load5"}))  # missing evidence is a failure


class DeployDoc(unittest.TestCase):
    def test_consumer_cli_resolves_from_the_full_deploy_archive(self):
        for name in ("DEPLOY.md", "DEPLOY.head.md"):
            doc = (D / name).read_text()
            self.assertRegex(doc, r"git archive <sha>\s*\|\s*tar -x")
            self.assertNotRegex(doc, r"git archive <sha>\s+(services|config|docs)/")
        self.assertIn("Environment=PATH=/srv/research-lane/tools/node-v23.11.0-linux-x64/bin:/usr/bin:/bin", (D / "linux/rq-consumer.service").read_text())
        self.assertIn("Environment=PATH=/opt/node22/bin:/usr/bin:/bin", (D / "hk/rq-consumer.service").read_text())

        node = shutil.which("node")
        self.assertIsNotNone(node, "ci-linux must run this suite with node on PATH")
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = root / "repo.tar"
            made = subprocess.run(["git", "archive", "-o", str(archive), "HEAD"], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(made.returncode, 0, made.stderr)
            with tarfile.open(archive) as bundle:
                bundle.extractall(root / "tree", filter="data")
            for name, value in (("task.json", {}), ("bundle.json", {}), ("result.json", None)):
                (root / name).write_text(json.dumps(value))
            cli = root / "tree/services/research-queue-agent/cli.js"
            run = subprocess.run([node, str(cli), "validate", "--task", str(root / "task.json"), "--bundle", str(root / "bundle.json"), "--result", str(root / "result.json")],
                                 capture_output=True, text=True, env={"PATH": str(pathlib.Path(node).parent) + ":/usr/bin:/bin"})
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIs(json.loads(run.stdout)["ok"], False)

    def test_deploy_readme_has_sha_table_matching_files(self):
        doc = (D / "DEPLOY.md").read_text()
        import hashlib
        for host in ("linux", "hk"):
            for p in sorted((D / host).iterdir()):
                h = hashlib.sha256(p.read_bytes()).hexdigest()
                self.assertIn(h, doc, "%s/%s missing from the DEPLOY.md sha table" % (host, p.name))
        self.assertIn(hashlib.sha256((D / "cap-proof.sh").read_bytes()).hexdigest(), doc)


if __name__ == "__main__":
    unittest.main()
