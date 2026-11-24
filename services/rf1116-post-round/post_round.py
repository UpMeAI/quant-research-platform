#!/usr/bin/env python3
"""RF1116 post-round deterministic host program (Package B).

This program owns no research decisions.  It turns frozen mining facts and
trusted RQ results into idempotent files and invokes the already-authoritative
round runner through an injected command boundary.  Task outcomes are joined
only through RQ_STATUS_V1's closed per-task view and the queue's authoritative
attempt path; aggregate counts are never used to guess which task completed.
"""
from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
from typing import Any, Callable

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import lexicon_copy


CST = dt.timezone(dt.timedelta(hours=8))
SPEC_SHA8 = "04a0961f"
FIREWALL = re.compile(r"score|ic|fold|holdout|gate|sr|return|pnl", re.I)
SECRET = re.compile(r"sk-[A-Za-z0-9]{16,}")
SIZE = re.compile(r"小市值|市值效应|规模效应|small[- ]?cap|size (?:effect|premium)", re.I)
WAIT_STATES = {"WAITING_FREEZE", "WAITING_QUOTA", "WAITING_PROVIDER", "WAITING_CREDENTIAL", "WAITING_EXTERNAL",
               "WAITING_VERDICT_READING", "READY", "CLAIMED", "RUNNING", "PAUSED", "EVIDENCE_WRITTEN"}
TERMINAL_STATES = {"DONE", "NOT_APPLICABLE_ZERO_SELECTED"}
STOP_PREFIX = "STOPPED_"
TASK_KEYS = {"task_id", "idem_key", "state", "attempt_no"}
TASK_ID = re.compile(r"^RQT-(?:LINUX|HK)-\d{8}-[0-9a-f]{8}$")
SHA64 = re.compile(r"^[0-9a-f]{64}$")
RUNNER_ENV_KEYS = ("PATH", "LANG", "LC_ALL", "RF1116_RUNNER_IMAGE")


class RunnerError(RuntimeError):
    pass


class LedgerTampered(RuntimeError):
    pass


class TaskAuthorityError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode()
    return hashlib.sha256(value).hexdigest()


def request_idem(request: dict) -> str:
    """The producer.py idempotency authority, reproduced byte-for-byte."""
    return sha256(canonical({"template_id": request.get("template_id"),
                             "template_sha256": request.get("template_sha256"),
                             "subject": request.get("subject") or {},
                             "params": request.get("params") or {}}))


def resolve_task(status: dict, request: dict) -> dict:
    """Resolve exactly one closed task row by the full request idempotency key."""
    if not isinstance(status, dict) or status.get("schema") != "RQ_STATUS_V1":
        raise TaskAuthorityError("RQ_STATUS_SCHEMA")
    tasks = status.get("tasks")
    if not isinstance(tasks, list):
        raise TaskAuthorityError("RQ_STATUS_TASKS_MISSING")
    for row in tasks:
        if (not isinstance(row, dict) or set(row) != TASK_KEYS or not TASK_ID.fullmatch(str(row.get("task_id", "")))
                or not SHA64.fullmatch(str(row.get("idem_key", ""))) or not isinstance(row.get("state"), str)
                or not row.get("state") or isinstance(row.get("attempt_no"), bool)
                or not isinstance(row.get("attempt_no"), int) or row["attempt_no"] < 0):
            raise TaskAuthorityError("RQ_STATUS_TASK_SHAPE")
    matches = [row for row in tasks if row["idem_key"] == request_idem(request)]
    if not matches:
        raise TaskAuthorityError("RQ_TASK_NOT_FOUND")
    if len(matches) != 1:
        raise TaskAuthorityError("RQ_TASK_AMBIGUOUS")
    return dict(matches[0])


def read_task_result(runs_dir: pathlib.Path, task: dict, request: dict, output_key: str) -> dict:
    """Read and bind D01 evidence at the queue's current authoritative attempt."""
    attempt = task.get("attempt_no")
    if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt <= 0:
        raise TaskAuthorityError("RQ_TASK_ATTEMPT_NOT_STARTED")
    if task.get("state") != "COMPLETE":
        raise TaskAuthorityError("RQ_TASK_NOT_COMPLETE")
    path = pathlib.Path(runs_dir) / task["task_id"] / ("attempt-%d" % attempt) / "result.json"
    try:
        result = json.loads(path.read_text())
    except FileNotFoundError:
        raise TaskAuthorityError("RQ_TASK_RESULT_MISSING")
    except (OSError, ValueError, TypeError):
        raise TaskAuthorityError("RQ_TASK_RESULT_INVALID")
    outputs = result.get("outputs") if isinstance(result, dict) else None
    output = outputs.get(output_key) if isinstance(outputs, dict) else None
    output_sha = outputs.get(output_key + "_sha256") if isinstance(outputs, dict) else None
    validator = result.get("validator") if isinstance(result, dict) else None
    subject = request.get("subject") or {}
    expected_schema = "RF1116_MECH_NOTE_OUTPUT_V1" if output_key == "mechanism_notes" else "RF1116_MECH_REVIEW_OUTPUT_V1"
    if (not isinstance(output, dict) or output.get("schema") != expected_schema
            or output.get("task_id") != task["task_id"] or output.get("round_id") != subject.get("round_id")
            or output.get("batch_no") != subject.get("batch_no") or result.get("schema") != "RQ_AGENT_RESULT_V1"
            or result.get("task_id") != task["task_id"] or result.get("kind") != request.get("kind")
            or result.get("status") != "DONE"):
        raise TaskAuthorityError("RQ_TASK_RESULT_BINDING")
    derived_sha = sha256(canonical(output))
    if (not SHA64.fullmatch(str(output_sha or "")) or output_sha != derived_sha
            or not isinstance(validator, dict) or validator.get("ok") is not True
            or validator.get("sha256") != derived_sha):
        raise TaskAuthorityError("RQ_TASK_RESULT_D01")
    try:
        parse_time(result["at"])
    except (KeyError, TypeError, ValueError):
        raise TaskAuthorityError("RQ_TASK_RESULT_AT")
    if SECRET.search(canonical(result)):
        raise TaskAuthorityError("RQ_TASK_RESULT_SECRET_SHAPED")
    return {"task": dict(task), "result": result, "output": output, "path": path}


def read_jsonl(path: pathlib.Path) -> list[dict]:
    """Read complete JSON lines, tolerating a final line without newline."""
    try:
        text = path.read_text()
    except FileNotFoundError:
        return []
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def latest_by(rows: list[dict], key: str) -> dict[str, dict]:
    out = {}
    for row in rows:
        if isinstance(row, dict) and row.get(key):
            out[str(row[key])] = row
    return out


def parse_time(value: str) -> dt.datetime:
    value = value.strip().replace("Z", "+00:00")
    parsed = dt.datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("timezone required")
    return parsed.astimezone(CST)


def iso_cst(value: dt.datetime) -> str:
    return value.astimezone(CST).isoformat(timespec="seconds")


def immutable_write(path: pathlib.Path, value: bytes | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = value if isinstance(value, bytes) else value.encode()
    if path.exists():
        if path.read_bytes() != raw:
            raise RuntimeError("IMMUTABLE_FILE_MISMATCH:%s" % path.name)
        return
    tmp = path.with_name(path.name + ".tmp-%d" % os.getpid())
    tmp.write_bytes(raw)
    os.chmod(tmp, 0o444)
    os.replace(tmp, path)


class HashLedger:
    def __init__(self, path: pathlib.Path):
        self.path = pathlib.Path(path)

    def verify(self) -> dict | None:
        prev = "0" * 64
        last = None
        for seq, row in enumerate(read_jsonl(self.path), 1):
            if row.get("seq") != seq or row.get("prev_hash") != prev:
                raise LedgerTampered("POST_ROUND_LEDGER_CHAIN")
            body = {k: v for k, v in row.items() if k != "record_hash"}
            want = sha256(canonical(body))
            if row.get("record_hash") != want:
                raise LedgerTampered("POST_ROUND_LEDGER_HASH")
            prev, last = want, row
        return last

    def append(self, body: dict) -> dict:
        last = self.verify()
        row = dict(body)
        row["seq"] = (last or {}).get("seq", 0) + 1
        row["prev_hash"] = (last or {}).get("record_hash", "0" * 64)
        row["record_hash"] = sha256(canonical(row))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as fh:
            fh.write(canonical(row) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        return row


@dataclasses.dataclass(frozen=True)
class Config:
    data_dir: pathlib.Path
    lane_out: pathlib.Path
    post_root: pathlib.Path
    inbox: pathlib.Path
    state_dir: pathlib.Path
    runs_dir: pathlib.Path
    model_gate_file: pathlib.Path
    register_file: pathlib.Path
    space_file: pathlib.Path
    code_commit_file: pathlib.Path
    blackouts_file: pathlib.Path
    selection_space_sha256: str
    note_template_id: str
    note_template_sha256: str
    review_template_id: str
    review_template_sha256: str


def _candidate_fields(formula: str, glossary: list[dict]) -> list[str]:
    names = []
    for item in glossary:
        name = item.get("name") if isinstance(item, dict) else None
        if name and re.search(r"(?<![A-Za-z0-9_])%s(?![A-Za-z0-9_])" % re.escape(name), formula):
            names.append(name)
    return sorted(names)


def build_note_packs(round_id: str, survivors: list[dict], pins: dict, mechanisms: list[dict], glossary: list[dict]) -> list[dict]:
    clean = []
    for survivor in survivors:
        # Construct the allowed projection rather than recursively deleting keys.
        cid, formula = survivor.get("candidate_id"), survivor.get("formula")
        if not isinstance(cid, str) or not isinstance(formula, str):
            raise ValueError("SURVIVOR_SHAPE")
        clean.append({"candidate_id": cid, "formula": formula, "fields": _candidate_fields(formula, glossary)})
    total = (len(clean) + 5) // 6
    return [{"schema": "RF1116_MECH_NOTE_PACK_V1", "round_id": round_id, "market": "CN_A", "batch_no": i + 1,
             "batch_of": total, "pins": pins, "candidates": clean[i * 6:(i + 1) * 6], "mechanisms": mechanisms, "glossary": glossary}
            for i in range(total)]


def _numbers(text: str) -> set[str]:
    return set(re.findall(r"(?<![A-Za-z_])[-+]?\d+(?:\.\d+)?", text or ""))


def _note_failure(note: dict, formula: str, allowed: set[str]) -> str | None:
    if note.get("mechanism_id") not in allowed:
        return "MECHANISM_NOT_ALLOWED"
    econ, failure = note.get("economic_logic_zh"), note.get("failure_mode_zh")
    text = (econ if isinstance(econ, str) else "") + "\n" + (failure if isinstance(failure, str) else "")
    if SIZE.search(text):
        return "SIZE_AS_MECHANISM"
    if not isinstance(econ, str) or not 20 <= len(econ) <= 160 or not isinstance(failure, str) or not 10 <= len(failure) <= 100:
        return "LENGTH"
    if lexicon_copy.has_forbidden_wording(text):
        return "WORDING"
    fields = note.get("fields_cited")
    if not isinstance(fields, list) or not fields or any(not isinstance(f, str) or not re.search(r"(?<![A-Za-z0-9_])%s(?![A-Za-z0-9_])" % re.escape(f), formula) for f in fields):
        return "FIELDS_NOT_IN_FORMULA"
    if not _numbers(text).issubset(_numbers(formula)):
        return "NUMBER_NOT_IN_PACK"
    if SECRET.search(canonical(note)):
        return "SECRET_SHAPED"
    if any(re.search(r"(?:^|_)(?:at|time|timestamp)(?:$|_)", str(k), re.I) for k in note):
        return "WRITTEN_AT"
    return None


def evaluate_notes(notes: list[dict], formulas: dict[str, str], allowed: set[str], result_at: str, registration_at: dt.datetime) -> dict:
    try:
        written = parse_time(result_at)
    except (TypeError, ValueError):
        written = None
    registrations, dispositions = [], []
    for note in notes:
        cid, outcome = note.get("candidate_id"), note.get("outcome")
        if outcome == "NO_MECHANISM":
            dispositions.append({"candidate_id": cid, "registered": False, "d_checks": {}, "ai_note_outcome": outcome,
                                 "ai_review": None, "verdict": "REJECTED", "note": "NO_MECHANISM:%s" % note.get("no_mechanism_code"), "research_state": "暂停"})
            continue
        if outcome == "NEW_MECHANISM_PROPOSAL":
            dispositions.append({"candidate_id": cid, "registered": False, "d_checks": {}, "ai_note_outcome": outcome,
                                 "ai_review": None, "verdict": "REJECTED", "note": "WAITING_EXTERNAL:MECHANISM_ADMISSION", "research_state": "暂停"})
            continue
        code = _note_failure(note, formulas.get(cid, ""), allowed) if outcome == "NOTE" else "SCHEMA"
        if written is None or written > registration_at.astimezone(CST):
            code = "WRITTEN_AT"
        if code:
            audit = "D07" if code == "WRITTEN_AT" else "D05"
            dispositions.append({"candidate_id": cid, "registered": False, "d_checks": {"passed": False, "code": code},
                                 "ai_note_outcome": outcome, "ai_review": None, "verdict": "REJECTED", "note": "%s:%s" % (audit, code), "research_state": "暂停"})
            continue
        registrations.append({"schema": "MINING_MECHANISM_V1", "candidate_id": cid, "mechanism_id": note["mechanism_id"],
                              "economic_logic_zh": note["economic_logic_zh"], "failure_mode_zh": note["failure_mode_zh"],
                              "written_at": iso_cst(written)})
    return {"registrations": registrations, "dispositions": dispositions}


def rank_equivalent_duplicates(selection: dict) -> dict[str, str]:
    candidates = sorted((x for x in selection.get("candidates", []) if isinstance(x, dict)), key=lambda x: x.get("candidate_id", ""))
    duplicates = {}
    for i, left in enumerate(candidates):
        a = ((left.get("validation_book") or {}).get("monthly_d"))
        if not isinstance(a, list):
            continue
        for right in candidates[i + 1:]:
            b = ((right.get("validation_book") or {}).get("monthly_d"))
            if isinstance(b, list) and len(a) == len(b) and all(abs(float(x) - float(y)) <= 1e-12 for x, y in zip(a, b)):
                duplicates[right["candidate_id"]] = left["candidate_id"]
    return duplicates


def _registered_ids(value: Any) -> set[str]:
    if isinstance(value, dict):
        explicit = value.get("registered") or []
        ids = {x for x in explicit if isinstance(x, str)}
        ids.update(x.get("candidate_id") for x in explicit if isinstance(x, dict) and x.get("candidate_id"))
        ids.update(x.get("candidate_id") for x in value.get("survivors", [])
                   if isinstance(x, dict) and x.get("registered") is True and x.get("candidate_id"))
        return ids
    return {x for x in value or [] if isinstance(x, str)} | {
        x.get("candidate_id") for x in value or [] if isinstance(x, dict) and x.get("candidate_id")}


def register_remaining(runner: Callable, round_id: str, directory: pathlib.Path, rows: list[dict]) -> list[str]:
    before = _registered_ids(runner("mechanisms", round_id))
    remaining = [r for r in rows if r.get("candidate_id") not in before]
    if not remaining:
        return []
    number = 1 + len(list(directory.glob("registrations.*.jsonl")))
    path = directory / ("registrations.%d.jsonl" % number)
    immutable_write(path, "".join(canonical(r) + "\n" for r in remaining))
    runner("mechanisms", round_id, path)
    after = _registered_ids(runner("mechanisms", round_id))
    added = after - before
    expected = {r["candidate_id"] for r in remaining}
    if added != expected:
        raise RunnerError("REGISTER_MISMATCH")
    return sorted(added)


def map_disposition(facts: dict) -> tuple[str, str, str]:
    if not facts.get("registered"):
        if facts.get("ai_note_outcome") == "NO_MECHANISM":
            note = "NO_MECHANISM:%s" % facts.get("no_mechanism_code")
        elif facts.get("ai_note_outcome") == "NEW_MECHANISM_PROPOSAL":
            note = "WAITING_EXTERNAL:MECHANISM_ADMISSION"
        elif facts.get("d_failure"):
            note = facts["d_failure"]
        else:
            note = "AI_NOTE_BLOCKED"
        return "REJECTED", note, "暂停"
    if facts.get("duplicate_of"):
        return "REJECTED", "DUPLICATE_RANK_EQUIVALENT:%s" % facts["duplicate_of"], "暂停"
    if facts.get("review_status") == "HOLD":
        return "REJECTED", "AI_REVIEW_HOLD:%s" % facts.get("review_code"), "暂停"
    if facts.get("review_blocked"):
        return "REJECTED", "AI_REVIEW_BLOCKED", "暂停"
    if facts.get("review_status") == "CONSISTENT":
        return "APPROVED", "AQ_POST_ROUND_V1", "做"
    return "REJECTED", "AI_REVIEW_BLOCKED", "暂停"


def record_review(runner: Callable, round_id: str, path: pathlib.Path) -> str:
    try:
        runner("review", round_id, path)
    except RunnerError as exc:
        return "STOPPED_REVIEW_REFUSED:%s" % str(exc)
    return "REVIEW_RECORDED"


def repack_blocked(batch: dict) -> list[dict]:
    candidates = batch.get("candidates") or []
    if len(candidates) <= 1:
        return []
    return [{**batch, "candidates": [candidate]} for candidate in candidates]


def classify_tasks(tasks: list[dict]) -> str:
    states = {x.get("state") for x in tasks if isinstance(x, dict)}
    if not states or states & WAIT_STATES:
        return "WAITING_AQ"
    if states <= {"COMPLETE", "BLOCKED_DETERMINISTIC"}:
        return "TERMINAL"
    return "WAITING_AQ"


def deadline_state(now: dt.datetime, end: str, recorded: bool, alerts: set, round_id: str) -> str | None:
    if recorded:
        return None
    if end in (None, "UNKNOWN", "CALENDAR_NOT_PUBLISHED"):
        return "DEADLINE_UNKNOWN"
    boundary = dt.datetime.fromisoformat(end).replace(tzinfo=CST) + dt.timedelta(days=1)
    if now.astimezone(CST) >= boundary:
        alerts.add((round_id, "POST_ROUND_REVIEW_LATE"))
        return "POST_ROUND_REVIEW_LATE"
    return None


def _in_blackout(path: pathlib.Path, now: dt.datetime) -> bool:
    try:
        document = json.loads(path.read_text())
    except (OSError, ValueError, AttributeError):
        return False
    if document.get("schema") == "RQ_BLACKOUTS_V1":
        for entry in document.get("entries", []):
            try:
                start = parse_time(entry["start"])
                end = parse_time(entry["end"])
            except (KeyError, TypeError, ValueError):
                continue
            if ("LINUX" in (entry.get("hosts") or []) and entry.get("mode") in {"FREEZE", "STOP"}
                    and entry.get("placeholder") is not True and start <= now.astimezone(CST) < end):
                return True
        return False
    windows = document.get("windows", [])
    t = now.astimezone(CST).time().replace(tzinfo=None)
    for window in windows:
        try:
            start = dt.time.fromisoformat(window["start"])
            end = dt.time.fromisoformat(window["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if (start <= end and start <= t < end) or (start > end and (t >= start or t < end)):
            return True
    return False


class PostRound:
    def __init__(self, cfg: Config, runner: Callable, clock: Callable[[], dt.datetime]):
        self.cfg, self.runner, self.clock = cfg, runner, clock

    def _alert(self, round_id: str, code: str, now: dt.datetime) -> None:
        path = self.cfg.state_dir / "alerts.jsonl"
        rows = read_jsonl(path)
        key = "%s:%s" % (round_id, code)
        if any(x.get("code") == code and x.get("key") == key for x in rows):
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as fh:
            fh.write(canonical({"code": code, "priority": "P1", "key": key,
                                "at": iso_cst(now), "round_id": round_id}) + "\n")

    def _append(self, ledger: HashLedger, round_id: str, state: str, now: dt.datetime, **detail) -> str:
        last = ledger.verify()
        if last and last.get("state") == state and all(last.get(k) == v for k, v in detail.items()):
            return state
        ledger.append({"round_id": round_id, "state": state, "at": iso_cst(now), **detail})
        return state

    def _model_gate_passes(self, now: dt.datetime) -> bool:
        try:
            gate = json.loads(self.cfg.model_gate_file.read_text())
            at = parse_time(gate["at"])
        except (OSError, ValueError, KeyError, TypeError):
            return False
        return gate.get("status") == "PASS" and now.astimezone(CST) - at <= dt.timedelta(hours=26)

    def _pins(self, selection: dict) -> dict:
        return {"selection_record_hash": selection.get("record_hash"), "register_sha256": sha256(self.cfg.register_file.read_bytes()),
                "space_sha256": self.cfg.selection_space_sha256, "code_commit": self.cfg.code_commit_file.read_text().strip()}

    def _mechanisms_and_glossary(self) -> tuple[list[dict], list[dict]]:
        register = json.loads(self.cfg.register_file.read_text())
        mechs = [{k: row.get(k) for k in ("mechanism_id", "title_zh", "description_zh")}
                 for row in register.get("mechanisms", []) if row.get("layer") == "SELECTION_TIMING" and row.get("decision_point") == "SELECT" and row.get("route") != "NOT_DO_SETTLED"]
        space = json.loads(self.cfg.space_file.read_text())
        glossary = []
        for section in ("fields", "operators"):
            for name, value in sorted((space.get(section) or {}).items()):
                glossary.append({"name": name, "description_zh": value.get("zh") if isinstance(value, dict) else value})
        return mechs, glossary

    def _write_pack_request(self, prefix: str, template_id: str, template_sha256: str, kind: str, pack: dict) -> dict:
        raw = canonical(pack) + "\n"
        psha = sha256(raw)
        batch = int(pack["batch_no"])
        pack_path = self.cfg.inbox / "mech-packs" / ("%s-%s-%02d-%s.json" % (prefix, pack["round_id"], batch, psha[:12]))
        immutable_write(pack_path, raw)
        request = {"template_id": template_id, "template_sha256": template_sha256, "market": "CN_A", "kind": kind,
                   "subject": {"round_id": pack["round_id"], "batch_no": batch, "pack_sha256": psha}, "params": {},
                   "inputs": [{"path": str(pack_path), "sha256": psha}], "depends_on": [], "priority": 50}
        request_path = self.cfg.inbox / "requests" / ("post-round-%s-%s-%02d-%s.json" % (prefix, pack["round_id"], batch, psha[:12]))
        immutable_write(request_path, canonical(request) + "\n")
        return request

    def _enqueue_notes(self, round_id: str, selection: dict, survivors: list[dict]) -> list[dict]:
        mechs, glossary = self._mechanisms_and_glossary()
        packs = build_note_packs(round_id, survivors, self._pins(selection), mechs, glossary)
        return [self._write_pack_request("note", self.cfg.note_template_id, self.cfg.note_template_sha256, "AI_MECH_NOTE", pack)
                for pack in packs]

    def _load_status(self) -> dict:
        try:
            return json.loads((self.cfg.state_dir / "status.json").read_text())
        except FileNotFoundError:
            raise TaskAuthorityError("RQ_STATUS_MISSING")
        except (OSError, ValueError, TypeError):
            raise TaskAuthorityError("RQ_STATUS_INVALID")

    def _tasks(self, requests: list[dict]) -> list[dict]:
        status = self._load_status()
        return [{"request": request, "task": resolve_task(status, request)} for request in requests]

    @staticmethod
    def _pack(request: dict) -> dict:
        try:
            inputs = request["inputs"]
            path = pathlib.Path(inputs[0]["path"])
            raw = path.read_bytes()
            pack = json.loads(raw)
        except (KeyError, IndexError, OSError, ValueError, TypeError):
            raise TaskAuthorityError("RQ_TASK_PACK_INVALID")
        if (len(inputs) != 1 or sha256(raw) != inputs[0].get("sha256")
                or sha256(raw) != (request.get("subject") or {}).get("pack_sha256")):
            raise TaskAuthorityError("RQ_TASK_PACK_SHA")
        return pack

    def _complete_results(self, tasks: list[dict], output_key: str) -> list[dict]:
        out = []
        for entry in tasks:
            row = entry["task"]
            if row["state"] == "COMPLETE":
                loaded = read_task_result(self.cfg.runs_dir, row, entry["request"], output_key)
                out.append({**entry, **loaded, "pack": self._pack(entry["request"])})
            elif row["state"] == "BLOCKED_DETERMINISTIC":
                out.append({**entry, "result": None, "output": None, "pack": self._pack(entry["request"])})
            else:
                raise TaskAuthorityError("RQ_TASK_NOT_TERMINAL")
        return out

    def _repack_results(self, results: list[dict], prefix: str, template_id: str, template_sha256: str,
                        kind: str, output_key: str) -> tuple[str, list[dict], list[dict]]:
        """Replace each blocked multi-candidate result with one closed singleton attempt."""
        kept, requests = [], []
        for entry in results:
            singles = repack_blocked(entry["pack"]) if entry["output"] is None else []
            if not singles:
                kept.append(entry)
                continue
            requests.extend(self._write_pack_request(prefix, template_id, template_sha256, kind, pack)
                            for pack in singles)
        if not requests:
            return "TERMINAL", kept, []
        tasks = self._tasks(requests)
        phase = classify_tasks([entry["task"] for entry in tasks])
        if phase == "WAITING_AQ":
            unsupported = [entry["task"]["state"] for entry in tasks
                           if entry["task"]["state"] not in WAIT_STATES
                           and entry["task"]["state"] not in {"COMPLETE", "BLOCKED_DETERMINISTIC"}]
            if unsupported:
                raise TaskAuthorityError("RQ_TASK_STATE_UNSUPPORTED")
            return phase, kept, tasks
        return "TERMINAL", kept + self._complete_results(tasks, output_key), tasks

    def _registration_records(self, round_id: str) -> dict[str, dict]:
        rows = [row for row in read_jsonl(self.cfg.data_dir / "research/mining_mechanisms.jsonl")
                if row.get("round_id") == round_id and row.get("candidate_id")]
        return latest_by(rows, "candidate_id")

    def _enqueue_reviews(self, round_id: str, selection: dict, view: dict, registrations: dict[str, dict],
                         formulas: dict[str, str], fields: dict[str, list[str]]) -> list[dict]:
        if not registrations:
            return []
        mechanisms, glossary = self._mechanisms_and_glossary()
        descriptions = {row["mechanism_id"]: row["description_zh"] for row in mechanisms}
        candidates = []
        for cid, row in sorted(registrations.items()):
            candidates.append({"candidate_id": cid, "formula": formulas[cid], "fields": fields[cid],
                               "mechanism_id": row["mechanism_id"], "mechanism_description_zh": descriptions[row["mechanism_id"]],
                               "economic_logic_zh": row["economic_logic_zh"], "failure_mode_zh": row["failure_mode_zh"],
                               "registration_hash": row["record_hash"]})
        total = (len(candidates) + 5) // 6
        pins = {**self._pins(selection), "mechanism_set_sha256": view["mechanism_set_sha256"]}
        packs = [{"schema": "RF1116_MECH_REVIEW_PACK_V1", "round_id": round_id, "market": "CN_A", "batch_no": i + 1,
                  "batch_of": total, "pins": pins, "candidates": candidates[i * 6:(i + 1) * 6], "glossary": glossary}
                 for i in range(total)]
        return [self._write_pack_request("review", self.cfg.review_template_id, self.cfg.review_template_sha256,
                                         "AI_MECH_REVIEW", pack) for pack in packs]

    def _finish(self, ledger: HashLedger, round_id: str, selection: dict, now: dt.datetime, note_results: list[dict],
                review_results: list[dict], view: dict, registrations: dict[str, dict], note_failures: dict[str, str]) -> str:
        note_by_candidate, note_task_by_candidate, failed = {}, {}, dict(note_failures)
        for entry in note_results:
            candidate_ids = [c["candidate_id"] for c in entry["pack"]["candidates"]]
            if entry["output"] is None:
                for cid in candidate_ids:
                    failed[cid] = "AI_NOTE_BLOCKED"
                continue
            notes = entry["output"].get("notes")
            if (not isinstance(notes, list) or len(notes) != len(candidate_ids)
                    or {n.get("candidate_id") for n in notes if isinstance(n, dict)} != set(candidate_ids)):
                raise TaskAuthorityError("RQ_TASK_RESULT_CANDIDATES")
            for note in notes:
                note_by_candidate[note["candidate_id"]] = note
                note_task_by_candidate[note["candidate_id"]] = entry["task"]["task_id"]
        review_by_candidate, review_task_by_candidate, review_blocked = {}, {}, set()
        for entry in review_results:
            candidate_ids = [c["candidate_id"] for c in entry["pack"]["candidates"]]
            if entry["output"] is None:
                review_blocked.update(candidate_ids)
                continue
            items = entry["output"].get("items")
            if (not isinstance(items, list) or len(items) != len(candidate_ids)
                    or {item.get("candidate_id") for item in items if isinstance(item, dict)} != set(candidate_ids)):
                raise TaskAuthorityError("RQ_TASK_RESULT_CANDIDATES")
            for item in items:
                review_by_candidate[item["candidate_id"]] = item
                review_task_by_candidate[item["candidate_id"]] = entry["task"]["task_id"]
        duplicates = rank_equivalent_duplicates(json.loads((self.cfg.lane_out / "rounds" / round_id / "selection.json").read_text()))
        dispositions, disagreements, verdicts = [], [], []
        for cid in selection.get("selected") or []:
            note = note_by_candidate.get(cid) or {}
            review = review_by_candidate.get(cid) or {}
            facts = {"registered": cid in registrations, "ai_note_outcome": note.get("outcome"),
                     "no_mechanism_code": note.get("no_mechanism_code"), "duplicate_of": duplicates.get(cid),
                     "review_status": review.get("status"), "review_code": review.get("code"),
                     "review_blocked": cid in review_blocked, "d_failure": failed.get(cid)}
            verdict, reason, research_state = map_disposition(facts)
            dispositions.append({"candidate_id": cid, "registered": facts["registered"], "d_checks": {},
                                 "ai_note_outcome": facts["ai_note_outcome"],
                                 "ai_review": {"status": facts["review_status"], "code": facts["review_code"]} if review else None,
                                 "verdict": verdict, "note": reason, "research_state": research_state})
            verdicts.append({"candidate_id": cid, "verdict": verdict, "note": reason})
            if facts["review_status"] == "HOLD":
                disagreements.append({"candidate_id": cid, "note_task_id": note_task_by_candidate.get(cid),
                                      "review_task_id": review_task_by_candidate.get(cid), "code": facts["review_code"]})
        directory = self.cfg.post_root / round_id
        immutable_write(directory / "dispositions.jsonl", "".join(canonical(row) + "\n" for row in dispositions))
        immutable_write(directory / "disagreements.jsonl", "".join(canonical(row) + "\n" for row in disagreements))
        reviewer = "AQ_POST_ROUND_V1 program (spec %s; note tasks %d, review tasks %d)" % (
            SPEC_SHA8, len(note_results), len(review_results))
        verdict_doc = {"mechanism_set_sha256": view["mechanism_set_sha256"], "reviewer": reviewer, "verdicts": verdicts}
        verdict_path = directory / "verdicts.json"
        immutable_write(verdict_path, canonical(verdict_doc) + "\n")
        state = record_review(self.runner, round_id, verdict_path)
        if state.startswith(STOP_PREFIX):
            self._alert(round_id, state, now)
            return self._append(ledger, round_id, state, now)
        self._append(ledger, round_id, "REVIEW_RECORDED", now, verdicts_sha256=sha256(verdict_path.read_bytes()))
        return self._append(ledger, round_id, "DONE", now)

    def tick(self) -> dict[str, str]:
        now = self.clock()
        selections = latest_by(read_jsonl(self.cfg.data_dir / "research/mining_selections.jsonl"), "round_id")
        if not selections:
            return {}
        rounds = latest_by(read_jsonl(self.cfg.data_dir / "research/mining_rounds.jsonl"), "round_id")
        opens = {str(x.get("round_id")) for x in read_jsonl(self.cfg.data_dir / "research/holdout_vault.jsonl") if x.get("round_id") and (x.get("action") == "OPEN" or x.get("opened_at"))}
        out = {}
        for round_id, selection in selections.items():
            if _in_blackout(self.cfg.blackouts_file, now):
                out[round_id] = "BLACKOUT_READ_ONLY"
                continue
            directory = self.cfg.post_root / round_id
            ledger = HashLedger(directory / "POST_ROUND_LEDGER.jsonl")
            try:
                last = ledger.verify()
            except LedgerTampered:
                self._alert(round_id, "POST_ROUND_LEDGER_TAMPERED", now)
                out[round_id] = "STOPPED_LEDGER_TAMPERED"
                continue
            if last and (str(last.get("state", "")).startswith(STOP_PREFIX) or last.get("state") in TERMINAL_STATES):
                out[round_id] = last["state"]
                continue
            selected = selection.get("selected")
            if selected == []:
                directory.mkdir(parents=True, exist_ok=True)
                out[round_id] = self._append(ledger, round_id, "NOT_APPLICABLE_ZERO_SELECTED", now)
                continue
            row = rounds.get(round_id, {})
            if row.get("scoring_neutralization") != "RANK_GAUSS_V2":
                directory.mkdir(parents=True, exist_ok=True)
                out[round_id] = self._append(ledger, round_id, "STOPPED_LEGACY_ROUND", now)
                self._alert(round_id, "STOPPED_LEGACY_ROUND", now)
                continue
            if round_id in opens or row.get("status") not in {"OPEN", "CAP_REACHED"}:
                directory.mkdir(parents=True, exist_ok=True)
                out[round_id] = self._append(ledger, round_id, "STOPPED_AFTER_HOLDOUT_OPEN", now)
                self._alert(round_id, "STOPPED_AFTER_HOLDOUT_OPEN", now)
                continue
            selection_path = self.cfg.lane_out / "rounds" / round_id / "selection.json"
            try:
                selection_raw = selection_path.read_bytes()
            except OSError:
                selection_raw = b""
            if sha256(selection_raw) != selection.get("selection_sha256"):
                directory.mkdir(parents=True, exist_ok=True)
                out[round_id] = self._append(ledger, round_id, "STOPPED_SELECTION_FILE_MISMATCH", now)
                self._alert(round_id, "STOPPED_SELECTION_FILE_MISMATCH", now)
                continue
            directory.mkdir(parents=True, exist_ok=True)
            if not last:
                self._append(ledger, round_id, "DETECTED", now, selection_sha256=selection["selection_sha256"])
            ledger_states = {item.get("state") for item in read_jsonl(ledger.path)}
            holdout = row.get("holdout")
            if isinstance(holdout, dict):
                deadline = deadline_state(now, holdout.get("to"), "REVIEW_RECORDED" in ledger_states, set(), round_id)
                if deadline and deadline not in ledger_states:
                    self._append(ledger, round_id, deadline, now)
                if deadline == "POST_ROUND_REVIEW_LATE":
                    self._alert(round_id, deadline, now)
            if not self._model_gate_passes(now):
                out[round_id] = self._append(ledger, round_id, "WAITING_MODEL_GATE", now)
                continue
            view = self.runner("mechanisms", round_id)
            survivors = view.get("survivors", view) if isinstance(view, dict) else view
            note_requests = self._enqueue_notes(round_id, selection, survivors)
            try:
                note_tasks = self._tasks(note_requests)
            except TaskAuthorityError as exc:
                out[round_id] = self._append(ledger, round_id, "NOTES_ENQUEUED", now, note_batches=len(note_requests), task_authority=exc.code)
                continue
            note_phase = classify_tasks([entry["task"] for entry in note_tasks])
            if note_phase == "WAITING_AQ":
                unknown = [entry["task"]["state"] for entry in note_tasks
                           if entry["task"]["state"] not in WAIT_STATES and entry["task"]["state"] not in {"COMPLETE", "BLOCKED_DETERMINISTIC"}]
                if unknown:
                    out[round_id] = self._append(ledger, round_id, "NOTES_ENQUEUED", now, note_batches=len(note_requests),
                                                 task_authority="RQ_TASK_STATE_UNSUPPORTED")
                else:
                    out[round_id] = self._append(ledger, round_id, "WAITING_AQ", now, phase="NOTES",
                                                 task_ids=sorted(entry["task"]["task_id"] for entry in note_tasks))
                continue
            try:
                note_results = self._complete_results(note_tasks, "mechanism_notes")
                note_repack_phase, note_results, note_repack_tasks = self._repack_results(
                    note_results, "note-repack", self.cfg.note_template_id, self.cfg.note_template_sha256,
                    "AI_MECH_NOTE", "mechanism_notes")
            except TaskAuthorityError as exc:
                out[round_id] = self._append(ledger, round_id, "NOTES_ENQUEUED", now, note_batches=len(note_requests), task_authority=exc.code)
                continue
            if note_repack_phase == "WAITING_AQ":
                out[round_id] = self._append(ledger, round_id, "WAITING_AQ", now, phase="NOTES_REPACK",
                                             task_ids=sorted(entry["task"]["task_id"] for entry in note_repack_tasks))
                continue
            self._append(ledger, round_id, "NOTES_TERMINAL", now,
                         task_ids=sorted(entry["task"]["task_id"] for entry in note_results))
            registration_rows, note_failures = [], {}
            formulas, fields = {}, {}
            for entry in note_results:
                for candidate in entry["pack"]["candidates"]:
                    formulas[candidate["candidate_id"]] = candidate["formula"]
                    fields[candidate["candidate_id"]] = candidate["fields"]
                if entry["output"] is None:
                    for candidate in entry["pack"]["candidates"]:
                        note_failures[candidate["candidate_id"]] = "AI_NOTE_BLOCKED"
                    continue
                allowed = {mechanism["mechanism_id"] for mechanism in entry["pack"]["mechanisms"]}
                evaluated = evaluate_notes(entry["output"].get("notes") or [], formulas, allowed,
                                           entry["result"]["at"], now)
                registration_rows.extend(evaluated["registrations"])
                note_failures.update({item["candidate_id"]: item["note"] for item in evaluated["dispositions"]})
            try:
                register_remaining(self.runner, round_id, directory, registration_rows)
            except RunnerError:
                raise
            view = self.runner("mechanisms", round_id)
            registrations = self._registration_records(round_id)
            wanted = {row["candidate_id"] for row in registration_rows}
            if not wanted.issubset(registrations):
                out[round_id] = self._append(ledger, round_id, "NOTES_TERMINAL", now, task_authority="REGISTRATION_LEDGER_MISSING")
                continue
            self._append(ledger, round_id, "REGISTERED", now, registered=sorted(registrations))
            try:
                review_requests = self._enqueue_reviews(round_id, selection, view, registrations, formulas, fields)
            except (KeyError, TypeError, ValueError):
                out[round_id] = self._append(ledger, round_id, "REGISTERED", now, task_authority="REVIEW_PACK_AUTHORITY_MISSING")
                continue
            if not review_requests:
                out[round_id] = self._finish(ledger, round_id, selection, now, note_results, [], view, registrations, note_failures)
                continue
            try:
                review_tasks = self._tasks(review_requests)
            except TaskAuthorityError as exc:
                out[round_id] = self._append(ledger, round_id, "REVIEWS_ENQUEUED", now, review_batches=len(review_requests), task_authority=exc.code)
                continue
            review_phase = classify_tasks([entry["task"] for entry in review_tasks])
            if review_phase == "WAITING_AQ":
                unknown = [entry["task"]["state"] for entry in review_tasks
                           if entry["task"]["state"] not in WAIT_STATES and entry["task"]["state"] not in {"COMPLETE", "BLOCKED_DETERMINISTIC"}]
                if unknown:
                    out[round_id] = self._append(ledger, round_id, "REVIEWS_ENQUEUED", now,
                                                 review_batches=len(review_requests), task_authority="RQ_TASK_STATE_UNSUPPORTED")
                else:
                    out[round_id] = self._append(ledger, round_id, "WAITING_AQ", now, phase="REVIEWS",
                                                 task_ids=sorted(entry["task"]["task_id"] for entry in review_tasks))
                continue
            try:
                review_results = self._complete_results(review_tasks, "mechanism_review")
                review_repack_phase, review_results, review_repack_tasks = self._repack_results(
                    review_results, "review-repack", self.cfg.review_template_id, self.cfg.review_template_sha256,
                    "AI_MECH_REVIEW", "mechanism_review")
            except TaskAuthorityError as exc:
                out[round_id] = self._append(ledger, round_id, "REVIEWS_ENQUEUED", now,
                                             review_batches=len(review_requests), task_authority=exc.code)
                continue
            if review_repack_phase == "WAITING_AQ":
                out[round_id] = self._append(ledger, round_id, "WAITING_AQ", now, phase="REVIEWS_REPACK",
                                             task_ids=sorted(entry["task"]["task_id"] for entry in review_repack_tasks))
                continue
            self._append(ledger, round_id, "REVIEWS_TERMINAL", now,
                         task_ids=sorted(entry["task"]["task_id"] for entry in review_results))
            out[round_id] = self._finish(ledger, round_id, selection, now, note_results, review_results,
                                         view, registrations, note_failures)
        return out


def _runner(command: pathlib.Path) -> Callable:
    def call(action: str, round_id: str, file: pathlib.Path | None = None):
        argv = [str(command), action, round_id] + ([str(file)] if file else [])
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=300,
                              env={k: os.environ[k] for k in RUNNER_ENV_KEYS if k in os.environ})
        if proc.returncode:
            match = re.search(r"\b(MINE_[A-Z0-9_]+)\b", proc.stderr + "\n" + proc.stdout)
            raise RunnerError(match.group(1) if match else "RUNNER_EXIT_%d" % proc.returncode)
        try:
            return json.loads(proc.stdout)
        except ValueError as exc:
            raise RunnerError("RUNNER_OUTPUT_INVALID") from exc
    return call


def env_config() -> Config:
    path = lambda name, default: pathlib.Path(os.environ.get(name, default))
    return Config(data_dir=path("QRP_DATA_DIR", "/srv/research-lane/qrp/var/ledger"), lane_out=path("RF1116_LANE_OUT", "/srv/research-lane/rf1116-mining/out"),
                  post_root=path("RF1116_POST_ROOT", "/srv/research-lane/rf1116-mining/post-round"), inbox=path("RQ_INBOX", "/var/lib/research-queue/inbox"),
                  state_dir=path("RQ_STATE_DIR", "/var/lib/research-queue/state"), runs_dir=path("RQ_RUNS_DIR", "/var/lib/research-queue/runs"),
                  model_gate_file=path("RF1116_MODEL_GATE_FILE", "/srv/research-lane/rf1116-mining/state/model_gate_last.json"),
                  register_file=path("RF1116_REGISTER_FILE", "config/research_mechanism_register.v1.json"), space_file=path("RF1116_SPACE_FILE", "config/research_mining_space.v1.json"),
                  code_commit_file=path("RF1116_COMMIT_FILE", "/srv/research-lane/rf1116-mining/.QRP_COMMIT"), blackouts_file=path("RQ_BLACKOUTS_FILE", "config/rq-blackouts.v1.json"),
                  selection_space_sha256=os.environ.get("RF1116_SPACE_SHA256", ""), note_template_id=os.environ.get("RF1116_NOTE_TEMPLATE_ID", "T-AI-MECH-NOTE-V1-LINUX-CN_A"),
                  note_template_sha256=os.environ.get("RF1116_NOTE_TEMPLATE_SHA256", ""), review_template_id=os.environ.get("RF1116_REVIEW_TEMPLATE_ID", "T-AI-MECH-REVIEW-V1-LINUX-CN_A"),
                  review_template_sha256=os.environ.get("RF1116_REVIEW_TEMPLATE_SHA256", ""))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("tick",))
    args = parser.parse_args(argv)
    if args.command == "tick":
        engine = PostRound(env_config(), _runner(pathlib.Path(os.environ.get("RF1116_RUNNER", "/srv/research-lane/rf1116-mining/run.sh"))), lambda: dt.datetime.now(CST))
        print(canonical(engine.tick()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
