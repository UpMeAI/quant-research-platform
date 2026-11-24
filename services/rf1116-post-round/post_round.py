#!/usr/bin/env python3
"""RF1116 post-round deterministic host program (Package B).

This program owns no research decisions.  It turns frozen mining facts and
trusted RQ results into idempotent files and invokes the already-authoritative
round runner through an injected command boundary.  Missing task-level RQ
state stays unknown: RQ_STATUS_V1 on the current base only contains aggregate
counts, so it must never be used to guess which task completed.
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
WAIT_STATES = {"WAITING_QUOTA", "WAITING_PROVIDER", "WAITING_CREDENTIAL", "WAITING_EXTERNAL", "READY", "CLAIMED", "RUNNING", "PAUSED"}
TERMINAL_STATES = {"DONE", "NOT_APPLICABLE_ZERO_SELECTED"}
STOP_PREFIX = "STOPPED_"


class RunnerError(RuntimeError):
    pass


class LedgerTampered(RuntimeError):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode()
    return hashlib.sha256(value).hexdigest()


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
            dispositions.append({"candidate_id": cid, "registered": False, "d_checks": {"passed": False, "code": code},
                                 "ai_note_outcome": outcome, "ai_review": None, "verdict": "REJECTED", "note": "D05:%s" % code, "research_state": "暂停"})
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
        value = value.get("registered", value.get("survivors", []))
    return {x.get("candidate_id") for x in value or [] if isinstance(x, dict) and x.get("candidate_id")}


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
    return [{**batch, "batch_no": "%s-r%d" % (batch.get("batch_no"), i + 1), "batch_of": len(candidates), "candidates": [candidate], "repacked_once": True}
            for i, candidate in enumerate(candidates)]


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
        windows = json.loads(path.read_text()).get("windows", [])
    except (OSError, ValueError, AttributeError):
        return False
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
        if any(x.get("round_id") == round_id and x.get("code") == code for x in rows):
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as fh:
            fh.write(canonical({"schema": "POST_ROUND_ALERT_V1", "round_id": round_id, "code": code, "at": iso_cst(now), "dry_run": True}) + "\n")

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
        return gate.get("verdict") == "PASS" and now.astimezone(CST) - at <= dt.timedelta(hours=26)

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

    def _enqueue_notes(self, round_id: str, selection: dict, survivors: list[dict]) -> int:
        mechs, glossary = self._mechanisms_and_glossary()
        packs = build_note_packs(round_id, survivors, self._pins(selection), mechs, glossary)
        for pack in packs:
            raw = canonical(pack) + "\n"
            psha = sha256(raw)
            pack_path = self.cfg.inbox / "mech-packs" / ("note-%s-%02d-%s.json" % (round_id, pack["batch_no"], psha[:12]))
            immutable_write(pack_path, raw)
            request = {"template_id": self.cfg.note_template_id, "template_sha256": self.cfg.note_template_sha256,
                       "market": "CN_A", "kind": "AI_MECH_NOTE", "subject": {"round_id": round_id, "batch_no": pack["batch_no"], "pack_sha256": psha},
                       "params": {}, "inputs": [{"path": str(pack_path), "sha256": psha}], "depends_on": [], "priority": 50}
            request_path = self.cfg.inbox / "requests" / ("post-round-note-%s-%02d-%s.json" % (round_id, pack["batch_no"], psha[:12]))
            immutable_write(request_path, canonical(request) + "\n")
        return len(packs)

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
            if not self._model_gate_passes(now):
                directory.mkdir(parents=True, exist_ok=True)
                out[round_id] = self._append(ledger, round_id, "WAITING_MODEL_GATE", now)
                continue
            directory.mkdir(parents=True, exist_ok=True)
            if not last:
                self._append(ledger, round_id, "DETECTED", now, selection_sha256=selection["selection_sha256"])
            view = self.runner("mechanisms", round_id)
            survivors = view.get("survivors", view) if isinstance(view, dict) else view
            count = self._enqueue_notes(round_id, selection, survivors)
            # Current RQ_STATUS_V1 has no task-level rows.  Enqueue is safe and
            # idempotent; advancing from here without task authority is not.
            out[round_id] = self._append(ledger, round_id, "NOTES_ENQUEUED", now, note_batches=count, task_authority="UNKNOWN")
        return out


def _runner(command: pathlib.Path) -> Callable:
    def call(action: str, round_id: str, file: pathlib.Path | None = None):
        argv = [str(command), action, round_id] + ([str(file)] if file else [])
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=300, env={k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL") if k in os.environ})
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
