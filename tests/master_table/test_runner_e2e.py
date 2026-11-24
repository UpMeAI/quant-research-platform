import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / "services" / "master-table"
FIXTURE = Path(__file__).parent / "fixtures"
sys.path.insert(0, str(SERVICE))

from mtl import registry, writer


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def tree_bytes(root, exclude=()):
    excluded = set(exclude)
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.name not in excluded
    }


class RunnerHarness:
    def __init__(self, base):
        self.base = Path(base)
        self.service = self.base / "service"
        self.root = self.base / "published"
        self.frozen = self.base / "frozen"
        self.ledger_dir = self.base / "ledgers"
        shutil.copytree(SERVICE, self.service)
        self.frozen.mkdir()
        self.ledger_dir.mkdir()
        for name in ("FROZEN_REV9.json", "FROZEN_REV9.md"):
            shutil.copyfile(FIXTURE / "frozen" / name, self.frozen / name)

        self.join_map = {
            "schema": "JOIN_MAP_V1",
            "freezeDate": "2026-11-25",
            "rows": {
                "Z01": {"entry_ids": ["CN-Z01"], "rowClass": "FROZEN_CLOSED"},
                "Z02": {
                    "entry_ids": ["UC-Z02"],
                    "rowClass": "FROZEN_OPEN",
                    "expected_sources": [{
                        "ledger": "overseas_sealed_verdicts",
                        "key": "entry_id",
                        "value": "UC-Z02",
                    }],
                    "tStart": {
                        "value": "2026-10-27T16:45:06+08:00",
                        "registryStatus": "STARTED",
                    },
                    "nextCheck": "2027-04-30",
                },
            },
        }
        self.join_path = self.frozen / "JOIN_MAP_V1.json"
        self.join_path.write_text(compact(self.join_map) + "\n", encoding="utf-8")

        self.ledger_path = self.ledger_dir / "ashare_sealed_verdicts.jsonl"
        initial = (FIXTURE / "ledgers" / "ashare_sealed_verdicts.jsonl").read_bytes()
        self.ledger_path.write_bytes(initial)
        self.initial_ledger = initial

        self._write_pins()
        self.root.joinpath("state").mkdir(parents=True)
        first = registry.frozen_line("Z01", 1, 9, "A股", registry.ZERO_SHA256, "test")
        second = registry.frozen_line("Z02", 2, 9, "美股", first["line_sha256"], "test")
        self.registry_path = self.root / "state" / "ROW_REGISTRY_V1.jsonl"
        self.registry_path.write_text(compact(first) + "\n" + compact(second) + "\n", encoding="utf-8")

        self.config_value = {
            "schema": "MASTER_TABLE_CONFIG_V1",
            "qrp_var_authoritative": True,
            "allowed_roots": [str(self.base)],
            "ledger_dir": str(self.ledger_dir),
            "root": str(self.root),
            "frozen_dir": str(self.frozen),
            "required_ledgers": [self.ledger_path.name],
            "optional_ledgers": [],
            "freeze_manifest": {
                "schema": "FREEZE_MANIFEST_V1",
                "ledgers": [{
                    "path": self.ledger_path.name,
                    "bytes": len(initial),
                    "sha256": sha(initial),
                }],
            },
            "qrp_commit": "test-head",
        }
        self.config = self.base / "config.json"
        self.write_config()

    def _write_pins(self):
        frozen_json = (self.frozen / "FROZEN_REV9.json").read_bytes()
        frozen_md = (self.frozen / "FROZEN_REV9.md").read_bytes()
        join_raw = self.join_path.read_bytes()
        source = (
            "FROZEN_REV = 9\n"
            f"FROZEN_JSON_SHA256 = {sha(frozen_json)!r}\n"
            f"FROZEN_MD_SHA256 = {sha(frozen_md)!r}\n"
            f"JOIN_MAP_SHA256 = {sha(join_raw)!r}\n"
            f"TSTART_REGISTRY_SHA256 = {'d' * 64!r}\n\n"
            "def require_set():\n"
            "    return (FROZEN_REV, FROZEN_JSON_SHA256, FROZEN_MD_SHA256, "
            "JOIN_MAP_SHA256, TSTART_REGISTRY_SHA256)\n"
        )
        (self.service / "mtl" / "pins.py").write_text(source, encoding="utf-8")

    def write_config(self, value=None, path=None):
        target = Path(path or self.config)
        target.write_text(json.dumps(value or self.config_value), encoding="utf-8")
        return target

    def command(self, *args, config=None):
        return [
            sys.executable,
            "-I",
            "-B",
            str(self.service / "run_master_table.py"),
            "--config",
            str(config or self.config),
            *args,
        ]

    def run(self, *args, config=None):
        return subprocess.run(
            self.command(*args, config=config),
            text=True,
            capture_output=True,
            check=False,
        )

    def run_code(self, code):
        return subprocess.run(
            [sys.executable, "-I", "-B", "-c", code],
            text=True,
            capture_output=True,
            check=False,
        )

    def status(self):
        return json.loads((self.root / "state" / "run_status.json").read_text(encoding="utf-8"))

    def live(self):
        return json.loads((self.root / "live" / f"{writer.BASE}.json").read_text(encoding="utf-8"))

    def append(self, record):
        with self.ledger_path.open("a", encoding="utf-8") as stream:
            stream.write(compact(record) + "\n")

    def new_record(self, **overrides):
        value = json.loads((FIXTURE / "ledgers" / "ashare_sealed_verdicts.append.jsonl").read_text())
        value.update(overrides)
        return value


class RunnerEndToEndTests(unittest.TestCase):
    def harness(self, td):
        return RunnerHarness(Path(td))

    def test_new_rev_then_no_change_is_deterministic_and_preserves_frozen_rows(self):
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            first = h.run("--evaluated-on", "2026-11-25")
            self.assertEqual(0, first.returncode, first.stderr)
            self.assertEqual(("NEW_REV", 10, "2026-11-25"),
                             (h.status()["result"], h.status()["rev"], h.status()["evaluatedOn"]))
            document = h.live()
            self.assertEqual("2026-11-25", document["ledgerOverlay"]["evaluatedOn"])
            frozen = json.loads((FIXTURE / "frozen" / "FROZEN_REV9.json").read_text())
            for expected, actual in zip(frozen["items"], document["items"]):
                public = {key: value for key, value in actual.items() if key != "ledgerFed"}
                self.assertEqual(compact(expected), compact(public))
            rev_json = h.root / "revs" / f"{writer.BASE}.rev10.json"
            rev_md = h.root / "revs" / f"{writer.BASE}.rev10.md"
            for revision, live in ((rev_json, h.root / "live" / f"{writer.BASE}.json"),
                                   (rev_md, h.root / "live" / f"{writer.BASE}.md")):
                self.assertEqual(0o444, revision.stat().st_mode & 0o777)
                self.assertEqual(revision.read_bytes(), live.read_bytes())
            before = tree_bytes(h.root, exclude={"run_status.json", ".lock"})
            second = h.run("--evaluated-on", "2026-11-25")
            self.assertEqual(0, second.returncode, second.stderr)
            self.assertEqual(("NO_CHANGE", 10), (h.status()["result"], h.status()["rev"]))
            self.assertEqual(before, tree_bytes(h.root, exclude={"run_status.json", ".lock"}))

    def test_frozen_only_is_byte_exact_and_check_never_writes_real_root(self):
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            completed = h.run("--frozen-only", "--evaluated-on", "2026-11-25")
            self.assertEqual(0, completed.returncode, completed.stderr)
            for suffix in ("json", "md"):
                expected = (h.frozen / f"FROZEN_REV9.{suffix}").read_bytes()
                self.assertEqual(expected, (h.root / "live" / f"{writer.BASE}.{suffix}").read_bytes())
                self.assertEqual(expected, (h.root / "revs" / f"{writer.BASE}.rev9.{suffix}").read_bytes())
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            self.assertEqual(0, h.run("--evaluated-on", "2026-11-25").returncode)
            before = tree_bytes(h.root)
            completed = h.run("--check", "--evaluated-on", "2026-11-25")
            self.assertEqual(0, completed.returncode, completed.stderr)
            self.assertEqual(before, tree_bytes(h.root))

    def test_authority_refusal_and_mtl_failures_are_machine_readable(self):
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            refused = dict(h.config_value, qrp_var_authoritative=False)
            path = h.write_config(refused, h.base / "refused.json")
            completed = h.run(config=path)
            self.assertEqual(4, completed.returncode)
            self.assertEqual("QRP_VAR_NOT_AUTHORITATIVE", completed.stderr.strip())
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            self.assertEqual(0, h.run("--evaluated-on", "2026-11-25").returncode)
            live_path = h.root / "live" / f"{writer.BASE}.json"
            live = json.loads(live_path.read_text())
            live["items"][0]["detail"] = "changed"
            live_path.write_text(json.dumps(live, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
            completed = h.run("--evaluated-on", "2026-11-25")
            self.assertEqual(3, completed.returncode)
            self.assertEqual("FROZEN_ROW_CHANGED:Z01:detail", completed.stderr.strip())
            self.assertEqual(("FAILED", "FROZEN_ROW_CHANGED:Z01:detail"),
                             (h.status()["result"], h.status()["code"]))

    def test_ledger_registry_and_conflict_mutants_fail_or_remain_explicit(self):
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            self.assertEqual(0, h.run("--evaluated-on", "2026-11-25").returncode)
            h.ledger_path.write_bytes(h.initial_ledger[:-2])
            completed = h.run("--evaluated-on", "2026-11-25")
            self.assertEqual(4, completed.returncode)
            self.assertEqual("LEDGER_NOT_APPEND_ONLY:ashare_sealed_verdicts.jsonl", h.status()["code"])
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            self.assertEqual(0, h.run("--evaluated-on", "2026-11-25").returncode)
            lines = h.registry_path.read_text().splitlines()
            changed = json.loads(lines[0]); changed["market"] = "美股"
            h.registry_path.write_text(compact(changed) + "\n" + "\n".join(lines[1:]) + "\n", encoding="utf-8")
            completed = h.run("--evaluated-on", "2026-11-25")
            self.assertEqual(3, completed.returncode)
            self.assertEqual("ROW_REGISTRY_UNVERIFIABLE:1", h.status()["code"])
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            self.assertEqual(0, h.run("--evaluated-on", "2026-11-25").returncode)
            h.append(h.new_record(result_id="ASV-CN-Z01-second", entry_id="CN-Z01", decision="做"))
            completed = h.run("--evaluated-on", "2026-11-25")
            self.assertEqual(0, completed.returncode, completed.stderr)
            z01 = next(row for row in h.live()["items"] if row["id"] == "Z01")
            self.assertEqual(("CONFLICT", "TWO_HEADS"),
                             (z01["ledgerFed"]["verdict"]["state"], z01["ledgerFed"]["verdict"]["reason"]))

    def test_unexpected_json_key_and_os_errors_replace_stale_ok_without_details(self):
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            self.assertEqual(0, h.run("--evaluated-on", "2026-11-25").returncode)
            h.registry_path.write_text("{\n", encoding="utf-8")
            completed = h.run("--evaluated-on", "2026-11-25")
            self.assertEqual(1, completed.returncode)
            self.assertEqual("UNEXPECTED:JSONDecodeError", completed.stderr.strip())
            self.assertEqual(("FAILED", "UNEXPECTED:JSONDecodeError"),
                             (h.status()["result"], h.status()["code"]))
            self.assertNotIn(str(h.base), completed.stderr)
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            self.assertEqual(0, h.run("--evaluated-on", "2026-11-25").returncode)
            missing = dict(h.config_value); missing.pop("frozen_dir")
            config_path = h.write_config(missing, h.base / "missing-key.json")
            completed = h.run("--evaluated-on", "2026-11-25", config=config_path)
            self.assertEqual(1, completed.returncode)
            self.assertEqual("UNEXPECTED:KeyError", completed.stderr.strip())
            self.assertEqual("UNEXPECTED:KeyError", h.status()["code"])
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            self.assertEqual(0, h.run("--evaluated-on", "2026-11-25").returncode)
            h.append(h.new_record())
            code = f"""
import pathlib, sys
sys.path.insert(0, {str(h.service)!r})
import run_master_table as app
original = pathlib.Path.replace
def fail_registry_replace(self, target):
    if pathlib.Path(target).name == 'ROW_REGISTRY_V1.jsonl':
        raise OSError('details must not escape')
    return original(self, target)
pathlib.Path.replace = fail_registry_replace
raise SystemExit(app.main(['--config', {str(h.config)!r}, '--evaluated-on', '2026-11-25']))
"""
            completed = h.run_code(code)
            self.assertEqual(1, completed.returncode)
            self.assertEqual("UNEXPECTED:OSError", completed.stderr.strip())
            self.assertEqual("UNEXPECTED:OSError", h.status()["code"])
            allowed = {".lock", "ROW_REGISTRY_V1.jsonl", "last_run.json", "run_status.json"}
            self.assertEqual(set(), {path.name for path in (h.root / "state").iterdir()} - allowed)

    def test_crash_after_registry_replace_self_heals_without_duplicate_row(self):
        with tempfile.TemporaryDirectory() as td:
            h = self.harness(td)
            self.assertEqual(0, h.run("--evaluated-on", "2026-11-25").returncode)
            h.append(h.new_record())
            code = f"""
import sys
sys.path.insert(0, {str(h.service)!r})
import run_master_table as app
def crash(*args, **kwargs):
    raise OSError('crash after registry replace')
app.writer.publish = crash
raise SystemExit(app.main(['--config', {str(h.config)!r}, '--evaluated-on', '2026-11-25']))
"""
            failed = h.run_code(code)
            self.assertEqual(1, failed.returncode)
            self.assertEqual("UNEXPECTED:OSError", h.status()["code"])
            self.assertEqual(3, len(h.registry_path.read_text().splitlines()))
            recovered = h.run("--evaluated-on", "2026-11-25")
            self.assertEqual(0, recovered.returncode, recovered.stderr)
            self.assertEqual(["L-CN-ZNEW"], [row["id"] for row in h.live()["items"] if row["id"].startswith("L-")])
            self.assertEqual(3, len(h.registry_path.read_text().splitlines()))


if __name__ == "__main__":
    unittest.main()
