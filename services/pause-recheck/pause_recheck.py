#!/usr/bin/env python3
"""Monthly, deterministic re-check of paused promotion-engine results.

The promotion engine remains the sole producer of re-check decisions.  This
module only discovers frozen inputs, invokes ``cli.js recheck``, projects its
result, writes immutable evidence, and requests a factual AI consistency card.
"""

import argparse
import dataclasses
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


CST = timezone(timedelta(hours=8))
SPEC_SHA256 = "5f880312358be75d0e37dc32c9c39b8725f84aa9bb92c008b992b35936014d6a"
PROMPT_ADMISSION_SHA256 = "aa550fbe9fb08864508ad3204f8ee826ad0a697e87121967a6329a4d574c0058"
TEMPLATE_ID = "T-AI-PAUSE-CHECK-V1-LINUX"
LEDGER_SCHEMA = "PAUSE_RECHECK_LEDGER_EVENT_V1"
ALERT_SCHEMA = "PAUSE_RECHECK_ALERT_STATUS_V1"
VALID_HISTORY_STATES = {"STILL_PAUSED", "PAUSE_ESCALATE_TO_OWNER", "RESUME"}
MONTH_STATES_FOR_CARD = {"STAY_PAUSED_REASON_REFRESHED", "STAY_PAUSED_ESCALATED", "REOPEN_CANDIDATE"}
WINDOWS = (("0630", "0800"), ("0915", "1530"), ("1810", "2130"))
SHA64 = re.compile(r"^[0-9a-f]{64}$")
SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]")
FORBIDDEN_SOURCE = (
    re.compile(r"(^|/)mining[^/]*/(.*?/)?out(/|$)", re.I),
    re.compile(r"MINING_SELECTION_V1|MINING_GATE_RECORD_V1"),
    re.compile(r"(^|/)(vaults?|holdout[-_]vaults?)(/|$)", re.I),
    re.compile(r"(^|/)(race|paper)/results?(/|$)", re.I),
)


class ConfigError(RuntimeError):
    pass


class LedgerError(RuntimeError):
    pass


@dataclasses.dataclass
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class Config:
    def __init__(self, *, data_dir, state_dir, inbox_dir, queue_status_path,
                 queue_runs_dir, blackouts_path, engine_cli,
                 template_sha256, var_root=None, data_candidates=(),
                 manifest_files=(), writable_probe=None, node_bin="node",
                 engine_code_commit="UNKNOWN"):
        self.data_dir = Path(data_dir)
        self.var_root = Path(var_root) if var_root else (
            self.data_dir.parent if self.data_dir.name == "ledger" else self.data_dir
        )
        self.state_dir = Path(state_dir)
        self.inbox_dir = Path(inbox_dir)
        self.queue_status_path = Path(queue_status_path)
        self.queue_runs_dir = Path(queue_runs_dir)
        self.blackouts_path = Path(blackouts_path) if blackouts_path else None
        self.engine_cli = Path(engine_cli)
        self.template_sha256 = str(template_sha256)
        self.node_bin = str(node_bin)
        self.engine_code_commit = str(engine_code_commit)
        self.data_candidates = tuple(Path(x) for x in (data_candidates or (self.var_root,)))
        self.manifest_files = tuple(Path(x) for x in manifest_files)
        self.writable_probe = writable_probe or (lambda p: os.access(p, os.W_OK))


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def pretty(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=1) + "\n"


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def sha256_file(path):
    return sha256_bytes(Path(path).read_bytes())


def engine_body_hash(value):
    body = {k: v for k, v in value.items() if k != "output_sha256"}
    return sha256_bytes(pretty(body).encode())


def read_jsonl(path):
    path = Path(path)
    if not path.exists():
        return []
    rows = []
    for number, raw in enumerate(path.read_bytes().splitlines(), 1):
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise LedgerError(f"LEDGER_BROKEN:{number}") from exc
        if not isinstance(row, dict):
            raise LedgerError(f"LEDGER_BROKEN:{number}")
        rows.append(row)
    return rows


def atomic_json(path, value, mode=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(pretty(value))
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
        if mode is not None:
            os.chmod(path, mode)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def immutable_json(path, value):
    path = Path(path)
    if path.exists():
        raise ConfigError(f"IMMUTABLE_EXISTS:{path}")
    atomic_json(path, value, 0o444)


def validate_qrp_var(config):
    candidates = tuple(dict.fromkeys(p.resolve() for p in config.data_candidates))
    root = config.var_root.resolve()
    data = config.data_dir.resolve()
    if root not in candidates or data not in {root, root / "ledger"}:
        raise ConfigError("QRP_VAR_AUTHORITY_NOT_CONFIGURED")
    writable = [p for p in candidates if p.exists() and config.writable_probe(p)]
    if len(writable) > 1:
        raise ConfigError("QRP_VAR_DUAL_WRITABLE")
    if config.manifest_files and any(not p.exists() for p in config.manifest_files):
        raise ConfigError("QRP_VAR_MANIFEST_MISMATCH")
    manifests = [p.read_bytes() for p in config.manifest_files]
    if len(manifests) > 1 and any(x != manifests[0] for x in manifests[1:]):
        raise ConfigError("QRP_VAR_MANIFEST_MISMATCH")
    return data


def default_runner(argv, env):
    proc = subprocess.run(argv, env={**os.environ, **env}, text=True,
                          capture_output=True, check=False, timeout=300)
    return CommandResult(proc.returncode, proc.stdout, proc.stderr)


def fact_source_forbidden(source):
    path = str((source or {}).get("path") or "")
    record_type = str((source or {}).get("record_type") or "")
    return any(pattern.search(path) for pattern in FORBIDDEN_SOURCE) or record_type in {
        "MINING_SELECTION", "MINING_GATE_RECORD", "VAULT_EVENT",
        "HOLDOUT_VAULT", "RACE_RESULT", "PAPER_RESULT",
    }


class Supervisor:
    def __init__(self, config, runner=default_runner, now=None):
        self.config = config
        self.runner = runner or default_runner
        self.now = now or (lambda: datetime.now(CST))
        self.ledger_path = config.state_dir / "PAUSE_RECHECK_LEDGER.jsonl"
        self.alert_path = config.state_dir / "alert_status.json"

    def _ledger_rows(self):
        rows = read_jsonl(self.ledger_path)
        previous = None
        for index, row in enumerate(rows, 1):
            body = {k: v for k, v in row.items() if k != "row_sha256"}
            if (row.get("schema") != LEDGER_SCHEMA or row.get("seq") != index
                    or row.get("prev_sha256") != previous
                    or row.get("row_sha256") != sha256_bytes(canonical(body).encode())):
                raise LedgerError(f"LEDGER_BROKEN:{index}")
            previous = row["row_sha256"]
        return rows

    def append_event(self, month, event, payload):
        rows = self._ledger_rows()
        body = {
            "schema": LEDGER_SCHEMA,
            "seq": len(rows) + 1,
            "prev_sha256": rows[-1]["row_sha256"] if rows else None,
            "at": self.now().isoformat(),
            "month": str(month),
            "event": str(event),
            "payload": payload or {},
        }
        row = {**body, "row_sha256": sha256_bytes(canonical(body).encode())}
        self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
        with self.ledger_path.open("a", encoding="utf-8") as out:
            out.write(canonical(row) + "\n")
            out.flush()
            os.fsync(out.fileno())
        return row

    def _alert_doc(self):
        if not self.alert_path.exists():
            return {"schema": ALERT_SCHEMA, "updated_at": self.now().isoformat(), "active": []}
        try:
            value = json.loads(self.alert_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise LedgerError("ALERT_STATUS_INVALID") from exc
        if value.get("schema") != ALERT_SCHEMA or not isinstance(value.get("active"), list):
            raise LedgerError("ALERT_STATUS_INVALID")
        return value

    def _alert(self, month, code, detail=None):
        try:
            value = self._alert_doc()
        except LedgerError:
            value = {"schema": ALERT_SCHEMA, "updated_at": self.now().isoformat(), "active": []}
        key = f"{month}:{code}"
        if not any(x.get("key") == key for x in value["active"]):
            value["active"].append({
                "key": key, "month": month, "code": code,
                "at": self.now().isoformat(), "detail": detail or {},
            })
        value["updated_at"] = self.now().isoformat()
        atomic_json(self.alert_path, value)

    def _blackout(self):
        if not self.config.blackouts_path or not self.config.blackouts_path.exists():
            return None
        try:
            value = json.loads(self.config.blackouts_path.read_text())
            for row in value.get("entries", []):
                start = datetime.fromisoformat(row["start"])
                end = datetime.fromisoformat(row["end"])
                if "LINUX" in row.get("hosts", []) and start <= self.now() < end:
                    return row.get("id") or "BLACKOUT"
        except (OSError, ValueError, TypeError, KeyError) as exc:
            raise ConfigError("BLACKOUT_FILE_INVALID") from exc
        return None

    def _in_window(self):
        now = self.now().astimezone(CST)
        hhmm = now.strftime("%H%M")
        return now.weekday() < 5 and any(start <= hhmm < end for start, end in WINDOWS)

    @staticmethod
    def _read_json(path):
        try:
            value = json.loads(Path(path).read_text())
        except (OSError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def _scan_results(self):
        root = self.config.data_dir / "research" / "promotion" / "results"
        if not root.is_dir():
            return {"present": False, "root": root, "seen": 0, "candidates": 0, "rows": []}
        groups = {}
        seen = 0
        for path in sorted(root.glob("*.json")):
            seen += 1
            value = self._read_json(path)
            if not value or not isinstance(value.get("candidate_id"), str):
                continue
            groups.setdefault(value["candidate_id"], []).append((value, path))
        rows = []
        for candidate, items in sorted(groups.items()):
            items.sort(key=lambda x: str(x[0].get("as_of") or ""), reverse=True)
            latest_at = items[0][0].get("as_of")
            tied = [x for x in items if x[0].get("as_of") == latest_at]
            value, path = items[0]
            if len(tied) > 1:
                rows.append({"candidate_id": candidate, "result": value, "path": path,
                             "invalid": "RESULT_TIE"})
                continue
            if value.get("output_sha256") != engine_body_hash(value):
                rows.append({"candidate_id": candidate, "result": value, "path": path,
                             "invalid": "RESULT_SHA_MISMATCH"})
                continue
            resolution = value.get("resolution") or {}
            if (value.get("verdict") == "INSUFFICIENT"
                    and resolution.get("conclusion") == "暂停"
                    and str(resolution.get("code") or "").startswith("PAUSE_")):
                rows.append({"candidate_id": candidate, "result": value, "path": path,
                             "invalid": None})
        return {"present": True, "root": root, "seen": seen,
                "candidates": len(groups), "rows": rows}

    def _find_terms(self, terms_sha):
        root = self.config.data_dir / "research" / "promotion" / "terms"
        for path in sorted(root.glob("*.json")) if root.is_dir() else []:
            try:
                if sha256_file(path) == terms_sha:
                    return path
            except OSError:
                continue
        return None

    def _observed(self, candidate, month, paused_sha):
        path = (self.config.data_dir / "research" / "promotion" / "observed"
                / candidate / f"{month}.json")
        value = self._read_json(path)
        if (not value or value.get("schema") != "PROMOTION_RECHECK_OBSERVED_V1"
                or value.get("candidate_id") != candidate
                or value.get("month") != month
                or value.get("paused_output_sha256") != paused_sha
                or not isinstance(value.get("observed"), dict)
                or not isinstance(value.get("sources"), list)):
            return None, path
        return value, path

    def _history(self, candidate, paused_sha):
        out = []
        for row in self._ledger_rows():
            payload = row.get("payload") or {}
            if (row.get("event") == "RECHECK_DONE"
                    and payload.get("candidate_id") == candidate
                    and payload.get("paused_output_sha256") == paused_sha
                    and payload.get("state") in VALID_HISTORY_STATES
                    and isinstance(payload.get("as_of"), str)):
                out.append({"as_of": payload["as_of"], "state": payload["state"]})
        return sorted(out, key=lambda x: x["as_of"])

    @staticmethod
    def _row_base(result):
        resolution = result.get("resolution") or {}
        return {
            "candidate_id": result.get("candidate_id"),
            "market": result.get("market") or result.get("inputs", {}).get("market") or None,
            "layer": result.get("layer") or result.get("inputs", {}).get("layer") or None,
            "paused_code": resolution.get("code"),
            "paused_output_sha256": result.get("output_sha256"),
            "paused_as_of": result.get("as_of"),
            "resume_condition": resolution.get("resume_condition"),
            "recheck_policy": resolution.get("recheck"),
            "policy_source": resolution.get("policy_source"),
        }

    @staticmethod
    def _map_engine(result):
        state = result.get("state")
        if state == "STILL_PAUSED":
            return "STAY_PAUSED_REASON_REFRESHED", "RECHECK_NEXT_MONTH"
        if state == "PAUSE_ESCALATE_TO_OWNER":
            return "STAY_PAUSED_ESCALATED", "PLAN_COORD_RECOMMENDS_TO_OWNER"
        if state == "RESUME":
            return "REOPEN_CANDIDATE", "REJUDGE_UNDER_SECTION_4_2"
        codes = ",".join(str(x) for x in (result.get("reasonCodes") or [])) or "UNKNOWN"
        return f"INPUT_INVALID:{codes}", "FIX_INPUT"

    def _engine(self, month_dir, result, result_path, terms_path,
                observed, observed_path, history):
        safe = SAFE_NAME.sub("_", result["candidate_id"])
        history_dir = month_dir / "history"
        history_dir.mkdir(parents=True, exist_ok=True)
        history_path = history_dir / f"{safe}.json"
        if not history_path.exists():
            immutable_json(history_path, history)
        observed_dir = month_dir / "engine-observed"
        observed_dir.mkdir(parents=True, exist_ok=True)
        observed_engine = observed_dir / f"{safe}.json"
        if not observed_engine.exists():
            immutable_json(observed_engine, observed["observed"])
        staging = month_dir / ".staging"
        staging.mkdir(parents=True, exist_ok=True)
        output_path = staging / f"{safe}.json"
        if output_path.exists():
            output_path.chmod(0o600)
            output_path.unlink()
        argv = [
            self.config.node_bin, str(self.config.engine_cli), "recheck",
            "--paused", str(result_path), "--terms", str(terms_path),
            "--observed", str(observed_engine), "--history", str(history_path),
            "--as-of", self.now().isoformat(), "--out", str(output_path),
        ]
        try:
            response = self.runner(argv, {"QRP_DATA_DIR": str(self.config.data_dir)})
        except (FileNotFoundError, subprocess.SubprocessError, OSError) as exc:
            raise ConfigError("ENGINE_UNAVAILABLE") from exc
        if not isinstance(response, CommandResult):
            response = CommandResult(response.returncode, response.stdout, response.stderr)
        if response.returncode not in (0, 2):
            if output_path.exists():
                output_path.chmod(0o600)
                output_path.unlink()
            raise ConfigError("ENGINE_UNAVAILABLE")
        if not output_path.exists() and response.stdout.strip():
            output_path.write_text(response.stdout)
        value = self._read_json(output_path)
        if value is None:
            if output_path.exists():
                output_path.chmod(0o600)
                output_path.unlink()
            raise ConfigError("ENGINE_OUTPUT_INVALID")
        if (value.get("schema") != "PROMOTION_RECHECK_V1"
                or value.get("candidate_id") != result["candidate_id"]
                or value.get("paused_output_sha256") != result["output_sha256"]
                or value.get("output_sha256") != engine_body_hash(value)):
            output_path.chmod(0o600)
            output_path.unlink()
            raise ConfigError("ENGINE_OUTPUT_INVALID")
        if "不做" in pretty(value) or value.get("conclusion") not in ("暂停", None):
            try:
                output_path.chmod(0o600)
                output_path.unlink()
            except OSError:
                pass
            raise ConfigError("FORBIDDEN_CONCLUSION")
        final_dir = month_dir / "rechecks"
        final_dir.mkdir(parents=True, exist_ok=True)
        final = final_dir / f"{safe}.json"
        os.replace(output_path, final)
        os.chmod(final, 0o444)
        try:
            staging.rmdir()
        except OSError:
            pass
        return value, final

    def _pack_and_request(self, month_dir, row, result, result_path,
                          engine, engine_path, observed, observed_path, history):
        if not SHA64.fullmatch(self.config.template_sha256):
            raise ConfigError("TEMPLATE_PIN_NOT_CONFIGURED")
        candidate = row["candidate_id"]
        facts = [
            {"id": "F-001", "source": {"path": str(result_path), "sha256": sha256_file(result_path),
             "record_type": "PROMOTION_RESULT_V1", "pointer": "/resolution"},
             "at": result.get("as_of"), "value": {"paused_code": row["paused_code"], "resume_condition": row["resume_condition"]}},
            {"id": "F-002", "source": {"path": str(engine_path), "sha256": sha256_file(engine_path),
             "record_type": "PROMOTION_RECHECK_V1", "pointer": "/"},
             "at": engine.get("as_of"), "value": {"state": engine.get("state"), "reasonCodes": engine.get("reasonCodes"),
                                                     "failed_rechecks": engine.get("failed_rechecks")}},
            {"id": "F-003", "source": {"path": str(observed_path), "sha256": sha256_file(observed_path),
             "record_type": "PROMOTION_RECHECK_OBSERVED_V1", "pointer": "/observed"},
             "at": self.now().isoformat(), "value": {"observed": observed.get("observed"), "sources": observed.get("sources")}},
        ]
        if history:
            facts.append({"id": "F-004", "source": {"path": str(self.ledger_path), "sha256": sha256_file(self.ledger_path),
                          "record_type": LEDGER_SCHEMA, "pointer": "/RECHECK_DONE"},
                          "at": self.now().isoformat(), "value": history})
        matrix = [
            {"req_id": "PR-1", "fact_ids": ["F-001", "F-002", "F-003"], "gate_result": row["month_state"],
             "requirement": f"暂停理由 {row['paused_code']} 的数值依据仍被本月事实支持"},
            {"req_id": "PR-2", "fact_ids": ["F-001", "F-002", "F-003"], "gate_result": row["month_state"],
             "requirement": "恢复条件的满足或未满足与事实一致"},
            {"req_id": "PR-3", "fact_ids": ["F-001", "F-003"], "gate_result": row["month_state"],
             "requirement": "观测来源与暂停时口径一致"},
        ]
        if any(fact_source_forbidden(f["source"]) for f in facts):
            raise ConfigError("PACK_FIREWALL")
        pack = {"market": row["market"], "facts": facts, "evidence_matrix": matrix}
        bundle = {"schema": "RQ_AGENT_BUNDLE_V1", "market": row["market"], "pack": pack}
        packs = month_dir / "pause-packs"
        packs.mkdir(parents=True, exist_ok=True)
        safe = SAFE_NAME.sub("_", candidate)
        pack_path = packs / f"{safe}.json"
        if not pack_path.exists():
            immutable_json(pack_path, bundle)
        pack_sha = sha256_file(pack_path)
        subject = {"candidate_id": candidate, "month": row["month"], "pack_sha256": pack_sha,
                   "prompt_admission_sha256": PROMPT_ADMISSION_SHA256}
        request = {
            "template_id": TEMPLATE_ID,
            "template_sha256": self.config.template_sha256,
            "market": row["market"], "kind": "AI_CHECK", "subject": subject,
            "params": {}, "inputs": [{"path": str(pack_path), "sha256": pack_sha}],
            "depends_on": [], "priority": 50,
        }
        requests = self.config.inbox_dir / "requests"
        requests.mkdir(parents=True, exist_ok=True)
        request_path = requests / f"pause-{row['month']}-{safe}.json"
        if not request_path.exists():
            atomic_json(request_path, request)
        return request, pack_path

    def _request_for(self, month, candidate):
        safe = SAFE_NAME.sub("_", candidate)
        path = self.config.inbox_dir / "requests" / f"pause-{month}-{safe}.json"
        return self._read_json(path)

    def _cards(self, month, rows, write=True):
        status = self._read_json(self.config.queue_status_path) or {}
        tasks = status.get("tasks") if isinstance(status.get("tasks"), list) else []
        items = []
        mapping = {}
        late = self.now().astimezone(CST).day >= 7
        for row in rows:
            candidate = row["candidate_id"]
            request = self._request_for(month, candidate)
            if row.get("month_state") not in MONTH_STATES_FOR_CARD or not request:
                continue
            subject = request.get("subject")
            task = next((x for x in tasks if isinstance(x, dict) and x.get("subject") == subject), None)
            state = "CARD_LATE" if late and not task else "PENDING"
            verdict = None
            codes = []
            task_id = None
            if task:
                task_id = task.get("task_id")
                result = self._task_result(task)
                verdict = (result.get("outputs") or {}).get("check_report", {}).get("verdict") if result else task.get("verdict")
                codes = task.get("codes") if isinstance(task.get("codes"), list) else []
                if task.get("state") == "DONE" and verdict == "CONSISTENT":
                    state = "DONE_CONSISTENT"
                elif task.get("state") == "DONE" and verdict == "HOLD":
                    state = "DONE_HOLD"
                elif task.get("state") in {"BLOCKED_DETERMINISTIC", "FAILED", "CANCELLED"}:
                    state = "CARD_BLOCKED"
            mapping[candidate] = state
            items.append({"candidate_id": candidate, "task_id": task_id, "state": state,
                          "verdict": verdict, "check_report_sha256": task.get("check_report_sha256") if task else None,
                          "codes": codes})
            if state == "DONE_HOLD":
                self._alert(month, "DONE_HOLD", {"candidate_id": candidate})
            elif state in {"CARD_BLOCKED", "CARD_LATE"}:
                self._alert(month, state, {"candidate_id": candidate})
        terminal = all(x["state"] != "PENDING" for x in items)
        path = self.config.state_dir / month / "AI_CHECKS_V1.json"
        if write and items and (terminal or late) and not path.exists():
            body = {"schema": "AI_CHECKS_V1", "month": month, "items": items}
            immutable_json(path, {**body, "ai_checks_sha256": sha256_bytes(canonical(body).encode())})
            self.append_event(month, "CARDS_WRITTEN", {"path": str(path), "items": len(items)})
        return mapping, path if path.exists() else None

    def _task_result(self, task):
        candidates = []
        if isinstance(task.get("result_path"), str):
            candidates.append(Path(task["result_path"]))
        task_id = task.get("task_id")
        if isinstance(task_id, str) and task_id:
            candidates.extend(sorted((self.config.queue_runs_dir / task_id).glob("attempt-*/result.json"), reverse=True))
        for path in candidates:
            value = self._read_json(path)
            if not value or value.get("schema") != "RQ_AGENT_RESULT_V1":
                continue
            report = (value.get("outputs") or {}).get("check_report")
            reported_sha = (value.get("outputs") or {}).get("check_report_sha256")
            if isinstance(report, dict) and reported_sha == sha256_bytes(canonical(report).encode()):
                return value
        return None

    def _latest(self, month, list_path, list_sha, ai_path):
        rows = self._ledger_rows()
        value = {
            "month": month, "list_path": str(list_path), "list_sha256": list_sha,
            "ai_checks_path": str(ai_path) if ai_path else None,
            "ai_checks_sha256": sha256_file(ai_path) if ai_path else None,
            "ledger_head_sha256": rows[-1]["row_sha256"] if rows else None,
        }
        atomic_json(self.config.state_dir / "latest.json", value)

    def _refused(self, month, code, detail=None):
        state = f"REFUSED:{code}"
        self._alert(month, state, detail)
        try:
            if code != "LEDGER_BROKEN":
                self.append_event(month, "REFUSED", {"code": code, "detail": detail or {}})
        except LedgerError:
            pass
        return {"state": state, "cards": {}}

    def tick(self):
        now = self.now().astimezone(CST)
        month = now.strftime("%Y-%m")
        try:
            prior_rows = self._ledger_rows()
        except LedgerError as exc:
            return self._refused(month, "LEDGER_BROKEN", {"error": str(exc)})
        had_prior_tick = any(row.get("month") == month and row.get("event") == "TICK_START" for row in prior_rows)
        try:
            validate_qrp_var(self.config)
        except ConfigError as exc:
            return self._refused(month, str(exc))
        self.append_event(month, "TICK_START", {})
        try:
            blackout = self._blackout()
        except ConfigError as exc:
            return self._refused(month, str(exc))
        if blackout:
            self.append_event(month, "WAIT_BLACKOUT", {"blackout_id": blackout})
            return {"state": "WAIT_BLACKOUT", "cards": {}}
        if self._in_window():
            self.append_event(month, "WAIT_WINDOW", {})
            return {"state": "WAIT_WINDOW", "cards": {}}

        month_dir = self.config.state_dir / month
        list_path = month_dir / "PAUSE_LIST_V1.json"
        if list_path.exists():
            doc = self._read_json(list_path) or {"rows": []}
            cards, ai_path = self._cards(month, doc.get("rows") or [])
            self._latest(month, list_path, doc.get("list_sha256"), ai_path)
            if doc.get("list_state") == "SOURCE_ABSENT":
                state = "SOURCE_ABSENT"
            elif not doc.get("rows"):
                state = "DONE_NO_PAUSED_ROWS"
            elif cards and any(value == "PENDING" for value in cards.values()):
                state = "WAITING_CARDS"
            elif cards and any(value == "CARD_LATE" for value in cards.values()):
                state = "DONE_ROWS_CARDS_INCOMPLETE"
            else:
                state = "DONE_ROWS"
            return {"state": state, "cards": cards}
        if now.day > 7 or (now.day == 7 and had_prior_tick):
            self._alert(month, "PAUSE_RECHECK_MISSED")
            self.append_event(month, "ALERT", {"code": "PAUSE_RECHECK_MISSED"})
            return {"state": "MISSED", "cards": {}}

        source = self._scan_results()
        rows = []
        if source["present"]:
            for item in source["rows"]:
                result = item["result"]
                base = self._row_base(result)
                base.update({"month": month, "failed_rechecks": None,
                             "recheck_output_sha256": None, "next_action": None,
                             "observed_sha256": None})
                if item["invalid"]:
                    base["month_state"] = f"INPUT_INVALID:{item['invalid']}"
                    rows.append(base)
                    self._alert(month, f"INPUT_INVALID:{item['candidate_id']}", {"code": item["invalid"]})
                    self.append_event(month, "ROW_UNKNOWN", {"candidate_id": item["candidate_id"], "state": base["month_state"]})
                    continue
                paused_sha = result["output_sha256"]
                history = self._history(item["candidate_id"], paused_sha)
                if history and history[-1]["state"] == "RESUME":
                    base.update({"month_state": "REOPEN_CANDIDATE_WAITING_REJUDGE", "next_action": "REJUDGE_UNDER_SECTION_4_2"})
                    rows.append(base)
                    continue
                terms_path = self._find_terms((result.get("inputs") or {}).get("terms_sha256"))
                if not terms_path:
                    base["month_state"] = "INPUT_INVALID:TERMS_NOT_FOUND"
                    rows.append(base)
                    self._alert(month, f"INPUT_INVALID:{item['candidate_id']}", {"code": "TERMS_NOT_FOUND"})
                    continue
                terms = self._read_json(terms_path) or {}
                base["market"] = terms.get("market")
                base["layer"] = terms.get("layer")
                observed, observed_path = self._observed(item["candidate_id"], month, paused_sha)
                if observed is None:
                    base["month_state"] = "OBSERVED_MISSING"
                    rows.append(base)
                    self._alert(month, f"OBSERVED_MISSING:{item['candidate_id']}")
                    self.append_event(month, "ROW_UNKNOWN", {"candidate_id": item["candidate_id"],
                                      "paused_output_sha256": paused_sha, "as_of": now.isoformat(), "state": "OBSERVED_MISSING"})
                    continue
                if not SHA64.fullmatch(self.config.template_sha256):
                    return self._refused(month, "TEMPLATE_PIN_NOT_CONFIGURED")
                base["observed_sha256"] = sha256_file(observed_path)
                try:
                    engine, engine_path = self._engine(month_dir, result, item["path"], terms_path,
                                                       observed, observed_path, history)
                except ConfigError as exc:
                    code = str(exc)
                    if code in {"ENGINE_UNAVAILABLE", "FORBIDDEN_CONCLUSION"}:
                        return self._refused(month, code)
                    if code == "ENGINE_OUTPUT_INVALID":
                        base["month_state"] = "INPUT_INVALID:ENGINE_OUTPUT_INVALID"
                        rows.append(base)
                        self._alert(month, f"INPUT_INVALID:{item['candidate_id']}", {"code": code})
                        self.append_event(month, "ROW_UNKNOWN", {"candidate_id": item["candidate_id"], "state": base["month_state"]})
                        continue
                    raise
                month_state, next_action = self._map_engine(engine)
                base.update({"month_state": month_state, "failed_rechecks": engine.get("failed_rechecks"),
                             "recheck_output_sha256": engine.get("output_sha256"), "next_action": next_action})
                rows.append(base)
                self.append_event(month, "RECHECK_DONE", {"candidate_id": item["candidate_id"],
                                  "paused_output_sha256": paused_sha, "as_of": engine.get("as_of") or now.isoformat(),
                                  "state": engine.get("state"), "output_sha256": engine.get("output_sha256")})
                if month_state == "STAY_PAUSED_ESCALATED":
                    self._alert(month, f"STAY_PAUSED_ESCALATED:{item['candidate_id']}")
                elif month_state == "REOPEN_CANDIDATE":
                    self._alert(month, f"REOPEN_CANDIDATE:{item['candidate_id']}")
                if month_state in MONTH_STATES_FOR_CARD:
                    try:
                        self._pack_and_request(month_dir, {**base, "month_state": month_state}, result,
                                               item["path"], engine, engine_path, observed,
                                               observed_path, history)
                    except ConfigError as exc:
                        return self._refused(month, str(exc))
                    self.append_event(month, "CARD_REQUESTED", {"candidate_id": item["candidate_id"]})

        source_state = "PRESENT" if source["present"] else "ABSENT"
        list_state = "ROWS" if rows else ("NO_PAUSED_ROWS" if source["present"] else "SOURCE_ABSENT")
        by_state = {}
        for row in rows:
            by_state[row["month_state"]] = by_state.get(row["month_state"], 0) + 1
        body = {
            "schema": "PAUSE_LIST_V1", "month": month, "as_of": now.isoformat(),
            "spec_sha256": SPEC_SHA256, "engine_code_commit": self.config.engine_code_commit,
            "source": {"root": str(source["root"]), "results_seen": source["seen"],
                       "candidates_seen": source["candidates"], "state": source_state},
            "list_state": list_state, "paused_rows": len(rows), "by_state": by_state,
            "rows": rows,
            "ai_checks": "NOT_REQUESTED_NO_ROWS" if not rows else "PENDING",
        }
        if "不做" in pretty(body):
            return self._refused(month, "FORBIDDEN_CONCLUSION")
        document = {**body, "list_sha256": sha256_bytes(canonical(body).encode())}
        immutable_json(list_path, document)
        self.append_event(month, "LIST_WRITTEN", {"path": str(list_path), "list_sha256": document["list_sha256"]})
        if list_state == "SOURCE_ABSENT":
            self._alert(month, "SOURCE_ABSENT")
            self.append_event(month, "ALERT", {"code": "SOURCE_ABSENT"})
        ai_path = None
        if not rows:
            ai_body = {"schema": "AI_CHECKS_V1", "month": month, "state": "NOT_REQUESTED_NO_ROWS", "items": []}
            ai_doc = {**ai_body, "ai_checks_sha256": sha256_bytes(canonical(ai_body).encode())}
            ai_path = month_dir / "AI_CHECKS_V1.json"
            immutable_json(ai_path, ai_doc)
            self.append_event(month, "CARDS_WRITTEN", {"path": str(ai_path), "items": 0})
        self._latest(month, list_path, document["list_sha256"], ai_path)
        requested = any(row.get("month_state") in MONTH_STATES_FOR_CARD for row in rows)
        state = ("SOURCE_ABSENT" if list_state == "SOURCE_ABSENT" else
                 "WAITING_CARDS" if requested else
                 "DONE_ROWS" if rows else "DONE_NO_PAUSED_ROWS")
        return {"state": state, "cards": {}}


def config_from_env():
    qrp_root = Path(__file__).resolve().parents[2]
    var_root = Path(os.environ.get("QRP_VAR_ROOT", "/srv/research-lane/qrp/var"))
    data = Path(os.environ.get("QRP_DATA_DIR", str(var_root / "ledger")))
    if ((var_root != Path("/srv/research-lane/qrp/var") or data != var_root / "ledger")
            and os.environ.get("PAUSE_RECHECK_ALLOW_TEST_DATA_DIR") != "1"):
        raise ConfigError("QRP_VAR_AUTHORITY_NOT_CONFIGURED")
    state = Path(os.environ.get("PAUSE_RECHECK_STATE_DIR", str(data / "research" / "pause-recheck")))
    inbox = Path(os.environ.get("RQ_INBOX_DIR", "/srv/research-lane/research-queue/inbox"))
    return Config(
        data_dir=data, var_root=var_root, state_dir=state, inbox_dir=inbox,
        queue_status_path=os.environ.get("RQ_STATUS_PATH", "/srv/research-lane/research-queue/state/status.json"),
        queue_runs_dir=os.environ.get("RQ_RUNS_DIR", "/srv/research-lane/research-queue/runs"),
        blackouts_path=os.environ.get("RQ_BLACKOUTS_FILE", str(qrp_root / "config" / "rq-blackouts.v1.json")),
        engine_cli=os.environ.get("PROMOTION_ENGINE_CLI", str(qrp_root / "services" / "promotion-engine" / "cli.js")),
        template_sha256=os.environ.get("PAUSE_RECHECK_TEMPLATE_SHA256", ""),
        node_bin=os.environ.get("NODE", "node"),
        engine_code_commit=os.environ.get("QRP_CODE_COMMIT", "UNKNOWN"),
        data_candidates=tuple(Path(x) for x in os.environ.get("QRP_VAR_CANDIDATES", str(var_root)).split(os.pathsep) if x),
        manifest_files=tuple(Path(x) for x in os.environ.get("QRP_VAR_MANIFESTS", "").split(os.pathsep) if x),
    )


def main(argv=None):
    parser = argparse.ArgumentParser(prog="pause_recheck.py")
    parser.add_argument("command", choices=("tick",))
    args = parser.parse_args(argv)
    try:
        result = Supervisor(config_from_env()).tick()
    except (ConfigError, LedgerError) as exc:
        print(json.dumps({"state": "REFUSED", "code": str(exc)}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if not str(result.get("state", "")).startswith("REFUSED:") else 2


if __name__ == "__main__":
    sys.exit(main())
