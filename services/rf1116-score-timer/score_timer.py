#!/usr/bin/env python3
"""RF1116 unattended holdout arrival and score supervisor (#151).

The supervisor is deliberately a ledger consumer.  It does not reproduce the
scorer or arrival decisions: those remain in run.sh / QRP #157.  Each tick
serialises arrival, completeness checking and score/rescore, then decides from
the canonical ledgers rather than from a previous process exit alone.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


CST = timezone(timedelta(hours=8))
TERMINAL = frozenset({"CLOSED", "FAILED_RESCORE", "FAILED_PARTIAL", "FAILED_EVALUATION"})
ARRIVAL_STATUSES = frozenset({"NOT_AVAILABLE", "NOT_YET", "NOOP", "COMPLETE"})
WAITING_EXACT = frozenset({
    "MINE_RUNNER_HOLDOUT_BEFORE_SEAL_END",
    "MINE_RUNNER_SEGMENT_END_UNKNOWN",
    "MINE_RUNNER_HOLDOUT_ARRIVAL_UNANCHORED",
    "MINE_RUNNER_PRIOR_SEGMENT_NOT_OPENED",
    "MINE_RUNNER_ARRIVE_LOCKED",
})
SHA64 = re.compile(r"^[0-9a-f]{64}$")


class LedgerError(RuntimeError):
    pass


class ConfigError(RuntimeError):
    pass


class CommandResult:
    def __init__(self, rc, stdout="", stderr="", started_at=None, finished_at=None):
        self.rc = int(rc)
        self.stdout = str(stdout or "")
        self.stderr = str(stderr or "")
        self.started_at = started_at
        self.finished_at = finished_at


class Config:
    def __init__(self, *, data_dir, state_dir, lane_dir, run_sh, image,
                 blackouts_path=None, disk_floor_gib=150, data_candidates=(),
                 manifest_files=(), writable_probe=None):
        self.data_dir = Path(data_dir)
        self.state_dir = Path(state_dir)
        self.lane_dir = Path(lane_dir)
        self.run_sh = Path(run_sh)
        self.image = str(image)
        self.blackouts_path = Path(blackouts_path) if blackouts_path else None
        self.disk_floor_gib = float(disk_floor_gib)
        self.data_candidates = tuple(Path(x) for x in (data_candidates or (self.data_dir,)))
        self.manifest_files = tuple(Path(x) for x in manifest_files)
        self.writable_probe = writable_probe or (lambda p: os.access(p, os.W_OK))


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def record_hash(value):
    return sha256_bytes(canonical_json({k: v for k, v in value.items() if k != "record_hash"}).encode())


def read_jsonl(path):
    path = Path(path)
    if not path.exists():
        return []
    raw = path.read_bytes()
    if not raw:
        return []
    rows = []
    for number, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            raise LedgerError(f"CORRUPT_LINE:{number}:blank")
        try:
            row = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise LedgerError(f"CORRUPT_LINE:{number}:{exc}") from exc
        if not isinstance(row, dict):
            raise LedgerError(f"CORRUPT_LINE:{number}:not-object")
        rows.append(row)
    return rows


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(canonical_json(value) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def first_json_line(text):
    for line in str(text or "").splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise LedgerError(f"FIRST_JSON_INVALID:{exc}") from exc
        if not isinstance(value, dict):
            raise LedgerError("FIRST_JSON_INVALID:not-object")
        return value
    raise LedgerError("FIRST_JSON_MISSING")


def error_code(stderr):
    try:
        value = first_json_line(stderr)
        code = value.get("error")
        if isinstance(code, str) and code:
            return code
    except LedgerError:
        pass
    text = str(stderr or "")
    match = re.search(r"\b(MINE(?:_RUNNER)?_[A-Z0-9_]+)\b", text)
    return match.group(1) if match else "UNKNOWN_REFUSAL"


def classify_failure(rc, stderr):
    code = error_code(stderr) if stderr else ("BUSY" if rc == 75 else "UNKNOWN_REFUSAL")
    # Compatibility with the pre-F6 #157 string.  The frozen interface now
    # emits the dedicated code, but an older installed image may still put the
    # healing state in message while leaving error at ARRIVAL_INVALID.
    if code == "MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID" and re.search(r"(^|:)UNANCHORED(?::|\b)", str(stderr or "")):
        code = "MINE_RUNNER_HOLDOUT_ARRIVAL_UNANCHORED"
    if rc == 75:
        return "WAITING", code
    if code in WAITING_EXACT or code.startswith("MINE_RUNNER_HOLDOUT_INCOMPLETE") or "ROUND_NOT_READY" in code:
        return "WAITING", code
    return "STOPPED", code


def validate_qrp_var(config):
    candidates = tuple(dict.fromkeys(p.resolve() for p in config.data_candidates))
    if config.data_dir.resolve() not in candidates:
        raise ConfigError("QRP_VAR_AUTHORITY_NOT_CONFIGURED")
    writable = [p for p in candidates if p.exists() and config.writable_probe(p)]
    if len(writable) > 1:
        raise ConfigError("QRP_VAR_DUAL_WRITABLE")
    if config.manifest_files and any(not p.exists() for p in config.manifest_files):
        raise ConfigError("QRP_VAR_MANIFEST_MISMATCH")
    manifests = [p.read_bytes() for p in config.manifest_files]
    if len(manifests) > 1 and any(x != manifests[0] for x in manifests[1:]):
        raise ConfigError("QRP_VAR_MANIFEST_MISMATCH")
    return config.data_dir.resolve()


def default_runner(argv, env):
    started = datetime.now(CST)
    process = subprocess.run(argv, env={**os.environ, **env}, text=True, capture_output=True, check=False)
    return CommandResult(process.returncode, process.stdout, process.stderr, started, datetime.now(CST))


def chmod_readable(path):
    subprocess.run(["chmod", "-R", "a+rX", str(path)], check=True)


class Supervisor:
    def __init__(self, config, runner=default_runner, chmod=chmod_readable, now=None):
        self.config = config
        self.runner = runner
        self.chmod = chmod
        self.now = now or (lambda: datetime.now(CST))
        self.ledger_path = config.state_dir / "ledger.jsonl"
        self.alert_path = config.state_dir / "alert_status.json"
        self.lock_path = config.state_dir / "tick.lock"

    def _research(self, name):
        return self.config.data_dir / "research" / name

    def _state_rows(self):
        rows = read_jsonl(self.ledger_path)
        previous = None
        for index, row in enumerate(rows, 1):
            if row.get("schema") != "RF1116_SCORE_TIMER_EVENT_V1" or row.get("seq") != index:
                raise LedgerError(f"HASH_MISMATCH:{index}:shape")
            if row.get("prev_hash") != previous or row.get("record_hash") != record_hash(row):
                raise LedgerError(f"HASH_MISMATCH:{index}")
            previous = row["record_hash"]
        return rows

    def _current(self, round_id):
        rows = [row for row in self._state_rows() if row.get("round_id") == round_id]
        return rows[-1] if rows else None

    def _transition(self, round_id, state, detail):
        rows = self._state_rows()
        body = {
            "schema": "RF1116_SCORE_TIMER_EVENT_V1",
            "seq": len(rows) + 1,
            "at": self.now().isoformat(),
            "round_id": str(round_id),
            "state": str(state),
            "detail": detail or {},
            "prev_hash": rows[-1]["record_hash"] if rows else None,
        }
        row = {**body, "record_hash": record_hash(body)}
        self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
        with self.ledger_path.open("a", encoding="utf-8") as out:
            out.write(canonical_json(row) + "\n")
            out.flush()
            os.fsync(out.fileno())
        return row

    def _alerts(self):
        if not self.alert_path.exists():
            return {"schema": "RF1116_SCORE_TIMER_ALERT_STATUS_V1", "updated_at": self.now().isoformat(), "active": []}
        value = json.loads(self.alert_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or not isinstance(value.get("active"), list):
            raise LedgerError("ALERT_STATUS_INVALID")
        return value

    def _alert(self, round_id, code, detail=None):
        value = self._alerts()
        key = f"{round_id}:{code}"
        if not any(row.get("key") == key for row in value["active"]):
            value["active"].append({"key": key, "round_id": round_id, "code": code, "at": self.now().isoformat(), "detail": detail or {}})
        value["updated_at"] = self.now().isoformat()
        atomic_json(self.alert_path, value)

    def _alert_tamper(self, detail):
        try:
            self._alert("SUPERVISOR", "LEDGER_TAMPER", {"error": str(detail)})
        except Exception:
            atomic_json(self.alert_path, {"schema": "RF1116_SCORE_TIMER_ALERT_STATUS_V1", "updated_at": self.now().isoformat(),
                                          "active": [{"key": "SUPERVISOR:LEDGER_TAMPER", "round_id": "SUPERVISOR", "code": "LEDGER_TAMPER", "at": self.now().isoformat(), "detail": {"error": str(detail)}}]})

    @staticmethod
    def _latest(rows, key="round_id"):
        result = {}
        for row in rows:
            if row.get(key):
                result[row[key]] = row
        return result

    @staticmethod
    def _segment(round_row):
        return "R2" if (round_row.get("holdout") or {}).get("segment") == "R2" else "R1"

    def _holdout_dir(self, segment):
        name = "rf1116-cn-a-daily-holdout-r2" if segment == "R2" else "rf1116-cn-a-daily-holdout-from-20261019"
        return self.config.lane_dir / "holdout-sealed" / name

    def _env(self, segment):
        return {"RF1116_RUNNER_IMAGE": self.config.image, "RF1116_HOLDOUT_SEGMENT": segment, "QRP_DATA_DIR": str(self.config.data_dir)}

    def _run(self, round_id, kind, argv, env):
        started = self.now()
        if self.runner is default_runner:
            process = subprocess.Popen(argv, env={**os.environ, **env}, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            alerted = False
            while True:
                try:
                    stdout, stderr = process.communicate(timeout=300)
                    break
                except subprocess.TimeoutExpired:
                    if not alerted and self.now() - started > timedelta(hours=12):
                        self._alert(round_id, "SCORE_LONG_RUNNING", {"started_at": started.isoformat(), "phase": kind})
                        alerted = True
            result = CommandResult(process.returncode, stdout, stderr, started, self.now())
        else:
            result = self.runner(argv, env)
        if not isinstance(result, CommandResult):
            result = CommandResult(result.returncode, result.stdout, result.stderr)
        result.started_at = result.started_at or started
        result.finished_at = result.finished_at or self.now()
        out_dir = self.config.state_dir / "rounds" / re.sub(r"[^A-Za-z0-9_.-]", "_", round_id)
        out_dir.mkdir(parents=True, exist_ok=True)
        seq = 1 + len(list(out_dir.glob(f"*-{kind}.json")))
        stem = out_dir / f"{seq:03d}-{kind}"
        (stem.with_suffix(".stdout")).write_text(result.stdout, encoding="utf-8")
        (stem.with_suffix(".stderr")).write_text(result.stderr, encoding="utf-8")
        # run.sh uses foreground docker run; its stdout/stderr are the container log stream.
        (stem.with_suffix(".docker.log")).write_text(result.stdout + result.stderr, encoding="utf-8")
        evidence = {
            "kind": kind,
            "rc": result.rc,
            "started_at": result.started_at.isoformat(),
            "finished_at": result.finished_at.isoformat(),
            "stdout_sha256": sha256_bytes(result.stdout.encode()),
            "stderr_sha256": sha256_bytes(result.stderr.encode()),
            "docker_log_sha256": sha256_bytes((result.stdout + result.stderr).encode()),
        }
        atomic_json(stem.with_suffix(".json"), evidence)
        return result, evidence, stem.with_suffix(".docker.log")

    def _blackout(self):
        path = self.config.blackouts_path
        if not path or not path.exists():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ConfigError(f"BLACKOUT_FILE_INVALID:{exc}") from exc
        now = self.now()
        for row in value.get("entries", []):
            try:
                start = datetime.fromisoformat(row["start"])
                end = datetime.fromisoformat(row["end"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ConfigError("BLACKOUT_FILE_INVALID") from exc
            if "LINUX" in row.get("hosts", []) and start <= now < end:
                return row.get("id", "BLACKOUT")
        return None

    def _disk_low(self):
        return shutil.disk_usage(self.config.lane_dir).free < self.config.disk_floor_gib * 1024 ** 3

    def _review_ready(self, round_id, selection, reviews, mechanisms):
        if not selection.get("selected"):
            return True
        review = reviews.get(round_id)
        if not review or review.get("record_hash") != record_hash(review):
            return False
        selected = sorted(selection.get("selected") or [])
        verdicts = {x.get("candidate_id"): x.get("verdict") for x in review.get("verdicts") or [] if isinstance(x, dict)}
        if any(verdicts.get(cid) not in {"APPROVED", "REJECTED"} for cid in selected):
            return False
        registrations = {(row.get("round_id"), row.get("candidate_id")): row.get("record_hash") for row in mechanisms if row.get("schema") == "MINING_MECHANISM_V1"}
        items = [{"candidate_id": cid, "registration_hash": registrations.get((round_id, cid))} for cid in selected]
        set_sha = sha256_bytes(canonical_json({"round_id": round_id, "selection_record_hash": selection.get("record_hash"), "items": items}).encode())
        return review.get("selection_record_hash") == selection.get("record_hash") and review.get("items") == items and review.get("mechanism_set_sha256") == set_sha

    def _window_end(self, round_row, resolutions):
        if self._segment(round_row) == "R1":
            return (round_row.get("holdout") or {}).get("to")
        rows = [x for x in resolutions if x.get("schema") == "HOLDOUT_SEGMENT_RESOLUTION_V1" and x.get("segment") == "R2" and x.get("market") == round_row.get("market")]
        return ((rows[-1].get("window") or {}).get("to") if rows else None)

    def _arrival(self, segment):
        drop = self.config.lane_dir / "holdout-daydrop" / segment
        if not drop.exists() or not any(drop.iterdir()):
            return
        rid = f"SEGMENT:{segment}"
        current = self._current(rid)
        if current and current["state"] in {"RUNNING_ARRIVE", "STOPPED_ARRIVE"}:
            return
        self._transition(rid, "RUNNING_ARRIVE", {"segment": segment})
        result, evidence, _ = self._run(rid, "arrive", [str(self.config.run_sh), "arrive"], self._env(segment))
        if result.rc == 0:
            value = first_json_line(result.stdout)
            status = value.get("status")
            if status not in ARRIVAL_STATUSES:
                raise LedgerError(f"ARRIVAL_STATUS_INVALID:{status}")
            self._transition(rid, "ARRIVAL_STATUS", value)
        else:
            state, code = classify_failure(result.rc, result.stderr)
            self._transition(rid, f"{state}_ARRIVE", {"code": code, **evidence})
            if state == "STOPPED":
                self._alert(rid, code)

    def _complete(self, round_id, segment, end):
        result, evidence, _ = self._run(round_id, "arrive-check", [str(self.config.run_sh), "arrive-check"], self._env(segment))
        if result.rc in {0, 4}:
            value = first_json_line(result.stdout)
            status = value.get("status")
            if status == "COMPLETE" and result.rc == 0:
                return True
            if status == "WINDOW_END_UNKNOWN":
                self._transition(round_id, "WAITING_SEGMENT_END", value)
                return False
            if status == "INCOMPLETE" and result.rc == 4:
                self._transition(round_id, "WAITING_ARRIVAL", value)
                if end and self.now().date() > datetime.fromisoformat(end).date():
                    self._alert(round_id, "ARRIVAL_INCOMPLETE_AT_END", {"missing": value.get("missing") or []})
                return False
            raise LedgerError(f"ARRIVE_CHECK_INVALID:{result.rc}:{status}")
        state, code = classify_failure(result.rc, result.stderr)
        self._transition(round_id, f"{state}_ARRIVAL_CHECK", {"code": code, **evidence})
        if state == "STOPPED":
            self._alert(round_id, code)
        return False

    def _round_facts(self, round_id):
        heads = self._latest([x for x in read_jsonl(self._research("mining_rounds.jsonl")) if x.get("schema") == "MINING_ROUND_V1"])
        vault = [x for x in read_jsonl(self._research("holdout_vault.jsonl")) if x.get("round_id") == round_id]
        opens = [x for x in vault if x.get("schema") == "HOLDOUT_OPEN_V1"]
        gates = [x for x in read_jsonl(self._research("mining_gate_records.jsonl")) if x.get("schema") == "MINING_GATE_RECORD_V1" and x.get("round_id") == round_id]
        return heads.get(round_id), opens[-1] if opens else None, gates

    def _rescore(self, round_id, segment, score_rc, crash_log):
        current = self._current(round_id)
        if current and current["state"] in {"RUNNING_RESCORE", "RESCORE_EXIT", "DONE", "STOPPED"}:
            return current["state"]
        self.chmod(self._holdout_dir(segment))
        reason = f"RF1116_SCORE_EXIT_{score_rc}"
        self._transition(round_id, "RUNNING_RESCORE", {"reason": reason})
        result, evidence, _ = self._run(round_id, "rescore", [str(self.config.run_sh), "rescore", round_id, reason, str(crash_log)], self._env(segment))
        self._transition(round_id, "RESCORE_EXIT", evidence)
        head, _, _ = self._round_facts(round_id)
        if result.rc == 0 and head and head.get("status") == "CLOSED":
            self._transition(round_id, "DONE", {"via": "rescore"})
            return "DONE"
        code = error_code(result.stderr)
        self._transition(round_id, "STOPPED", {"code": code, "phase": "rescore", **evidence})
        self._alert(round_id, code, {"phase": "rescore"})
        return "STOPPED"

    def _score(self, round_id, segment):
        current = self._current(round_id)
        if current and current["state"] == "WAITING_DOCKER":
            next_at = current.get("detail", {}).get("next_retry_at")
            if next_at and self.now() < datetime.fromisoformat(next_at):
                return "WAITING_DOCKER"
        self.chmod(self._holdout_dir(segment))
        self._transition(round_id, "RUNNING_SCORE", {"segment": segment, "started_at": self.now().isoformat()})
        result, evidence, crash_log = self._run(round_id, "score", [str(self.config.run_sh), "score", round_id], self._env(segment))
        self._transition(round_id, "SCORE_EXIT", evidence)
        if result.finished_at - result.started_at > timedelta(hours=12):
            self._alert(round_id, "SCORE_LONG_RUNNING", {"started_at": result.started_at.isoformat(), "finished_at": result.finished_at.isoformat()})
        head, opened, gates = self._round_facts(round_id)
        if result.rc == 0 and head and head.get("status") == "CLOSED":
            self._transition(round_id, "DONE", {"via": "score"})
            return "DONE"
        if opened and head and head.get("status") == "SCORING" and len(gates) < len(opened.get("candidate_ids") or []):
            return self._rescore(round_id, segment, result.rc, crash_log)
        if result.rc in {125, 126, 127} and not opened:
            attempts = sum(1 for row in self._state_rows() if row.get("round_id") == round_id and row.get("state") == "SCORE_EXIT" and row.get("detail", {}).get("rc") in {125, 126, 127})
            if attempts >= 3:
                self._transition(round_id, "STOPPED_DOCKER", {"attempts": attempts, **evidence})
                self._alert(round_id, "STOPPED_DOCKER", {"attempts": attempts})
                return "STOPPED_DOCKER"
            next_at = self.now() + timedelta(minutes=30 * (2 ** (attempts - 1)))
            self._transition(round_id, "WAITING_DOCKER", {"attempts": attempts, "next_retry_at": next_at.isoformat(), **evidence})
            return "WAITING_DOCKER"
        state, code = classify_failure(result.rc, result.stderr)
        self._transition(round_id, state, {"code": code, **evidence})
        if state == "STOPPED":
            self._alert(round_id, code)
        return state

    def _tick_locked(self):
        validate_qrp_var(self.config)
        rows = self._state_rows()
        heads = self._latest([x for x in read_jsonl(self._research("mining_rounds.jsonl")) if x.get("schema") == "MINING_ROUND_V1"])
        selections = self._latest([x for x in read_jsonl(self._research("mining_selections.jsonl")) if x.get("schema") == "MINING_SELECTION_V1"])
        reviews = self._latest([x for x in read_jsonl(self._research("mining_mechanism_reviews.jsonl")) if x.get("schema") == "MECHANISM_REVIEW_V1"])
        mechanisms = read_jsonl(self._research("mining_mechanisms.jsonl"))
        resolutions = read_jsonl(self._research("holdout_segment_resolutions.jsonl"))
        candidates = [head for rid, head in heads.items() if head.get("status") in {"OPEN", "CAP_REACHED"} and rid in selections]
        candidates.sort(key=lambda x: (self._segment(x) == "R2", x.get("opened_at", ""), x.get("round_id", "")))
        result = {"status": "OK", "rounds": {}}
        blackout = self._blackout()
        disk_low = self._disk_low()
        if not blackout and not disk_low:
            for segment in sorted({self._segment(x) for x in candidates}, key=lambda x: x == "R2"):
                score_busy = any(self._segment(x) == segment and (self._current(x["round_id"]) or {}).get("state") in {"RUNNING_SCORE", "RUNNING_RESCORE"} for x in candidates)
                if not score_busy:
                    self._arrival(segment)
        for head in candidates:
            rid = head["round_id"]
            current = self._current(rid)
            if current and current["state"] in {"DONE", "STOPPED", "STOPPED_DOCKER"}:
                result["rounds"][rid] = current["state"]
                continue
            if current and current["state"] in {"RUNNING_SCORE", "RUNNING_RESCORE"}:
                started = current.get("detail", {}).get("started_at") or current.get("at")
                if started and self.now() - datetime.fromisoformat(started) > timedelta(hours=12):
                    self._alert(rid, "SCORE_LONG_RUNNING", {"started_at": started})
                result["rounds"][rid] = "WAITING_RUNNING"
                continue
            if blackout:
                self._transition(rid, "WAITING_BLACKOUT", {"blackout": blackout})
                result["rounds"][rid] = "WAITING_BLACKOUT"
                continue
            if disk_low:
                self._transition(rid, "WAITING_DISK", {"floor_gib": self.config.disk_floor_gib})
                result["rounds"][rid] = "WAITING_DISK"
                continue
            segment = self._segment(head)
            arrival_state = self._current(f"SEGMENT:{segment}")
            if arrival_state and arrival_state["state"] == "RUNNING_ARRIVE":
                self._transition(rid, "WAITING_RUNNING", {"phase": "arrive", "segment": segment})
                result["rounds"][rid] = "WAITING_RUNNING"
                continue
            if segment == "R2":
                prior = [x for x in heads.values() if x.get("market") == head.get("market") and self._segment(x) == "R1"]
                if not prior or any(x.get("status") not in TERMINAL for x in prior):
                    self._transition(rid, "WAITING_PRIOR_SEGMENT", {"non_terminal": [x["round_id"] for x in prior if x.get("status") not in TERMINAL]})
                    result["rounds"][rid] = "WAITING_PRIOR_SEGMENT"
                    continue
            end = self._window_end(head, resolutions)
            if segment == "R2" and not end:
                self._transition(rid, "WAITING_SEGMENT_END", {})
                result["rounds"][rid] = "WAITING_SEGMENT_END"
                continue
            not_before = datetime(2027, 1, 1, tzinfo=CST)
            if segment == "R2":
                not_before = max(not_before, datetime.fromisoformat(end).replace(tzinfo=CST) + timedelta(days=1))
            if self.now() < not_before:
                self._transition(rid, "WAITING_CLOCK", {"not_before": not_before.isoformat()})
                result["rounds"][rid] = "WAITING_CLOCK"
                continue
            selection = selections[rid]
            if not self._review_ready(rid, selection, reviews, mechanisms):
                self._transition(rid, "WAITING_REVIEW", {})
                at = selection.get("recorded_at")
                if at and self.now() - datetime.fromisoformat(at) >= timedelta(hours=48):
                    self._alert(rid, "WAITING_REVIEW_48H")
                result["rounds"][rid] = "WAITING_REVIEW"
                continue
            if not self._complete(rid, segment, end):
                result["rounds"][rid] = self._current(rid)["state"]
                continue
            result["rounds"][rid] = self._score(rid, segment)
        return result

    def tick(self):
        self.config.state_dir.mkdir(parents=True, exist_ok=True)
        lock = self.lock_path.open("a+")
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {"status": "BUSY", "rounds": {}}
            try:
                return self._tick_locked()
            except LedgerError as exc:
                self._alert_tamper(exc)
                raise
        finally:
            lock.close()


def config_from_env():
    lane = Path(os.environ.get("RF1116_LANE", "/srv/research-lane/rf1116-mining"))
    data = Path(os.environ.get("QRP_DATA_DIR", "/srv/research-lane/qrp/var"))
    if data != Path("/srv/research-lane/qrp/var") and os.environ.get("RF1116_SCORE_TIMER_ALLOW_TEST_DATA_DIR") != "1":
        raise ConfigError("QRP_VAR_AUTHORITY_NOT_CONFIGURED")
    state = Path(os.environ.get("RF1116_SCORE_TIMER_STATE_DIR", str(lane / "score-timer")))
    run_sh = Path(os.environ.get("RF1116_RUN_SH", str(lane / "code/deploy/research-lane/round-runner/run.sh")))
    commit_file = lane / "code/.QRP_COMMIT"
    commit = commit_file.read_text(encoding="utf-8").strip() if commit_file.exists() else ""
    image = os.environ.get("RF1116_RUNNER_IMAGE", f"qrp-round-runner:{commit[:12]}" if len(commit) >= 12 else "")
    if not image:
        raise ConfigError("RUNNER_IMAGE_NOT_PINNED")
    candidates = tuple(Path(x) for x in os.environ.get("QRP_VAR_CANDIDATES", str(data)).split(os.pathsep) if x)
    manifests = tuple(Path(x) for x in os.environ.get("QRP_VAR_MANIFESTS", "").split(os.pathsep) if x)
    blackout = os.environ.get("RQ_BLACKOUTS_FILE", str(lane / "code/config/rq-blackouts.v1.json"))
    return Config(data_dir=data, state_dir=state, lane_dir=lane, run_sh=run_sh, image=image,
                  blackouts_path=blackout, disk_floor_gib=float(os.environ.get("RF1116_DISK_FLOOR_GIB", "150")),
                  data_candidates=candidates, manifest_files=manifests)


def main(argv=None):
    args = list(argv or sys.argv[1:])
    if args != ["tick"]:
        print("usage: score_timer.py tick", file=sys.stderr)
        return 64
    try:
        result = Supervisor(config_from_env()).tick()
    except (ConfigError, LedgerError, OSError, subprocess.SubprocessError) as exc:
        print(canonical_json({"status": "ERROR", "error": str(exc)}), file=sys.stderr)
        return 2
    print(canonical_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
