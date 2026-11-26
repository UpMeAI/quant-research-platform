#!/usr/bin/env python3
"""Unattended RF1116 monthly LLM round supervisor (#148)."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

CST = timezone(timedelta(hours=8))
SHA64 = re.compile(r"^[0-9a-f]{64}$")
RETRYABLE = frozenset({"WAITING_RATE_LIMITED", "WAITING_PROVIDER_UNAVAILABLE", "WAITING_STEP_NO_RESPONSE"})
NO_RESUME = frozenset({"WAITING_QUOTA", "WAITING_MODEL_MISMATCH", "WAITING_KEY_ABSENT", "WAITING_KEY_REJECTED", "WAITING_METER_UNKNOWN"})
STOPPED = frozenset({"STOPPED_TOKEN_CAP", "STOPPED_CALL_CAP", "STOPPED_EMPTY_REPLIES"})
MODELS = {"deepseek-flash": "DeepSeek-V4.1-Flash-1017", "deepseek-v4-pro": "DeepSeek-V4-Pro-0813"}
DEFAULT_MODEL_SOURCES = {
    "https://api-docs.deepseek.com/updates": None,
    "https://api-docs.deepseek.com/quick_start/pricing": None,
}


class ConfigError(RuntimeError): pass
class LedgerError(RuntimeError): pass


class CommandResult:
    def __init__(self, rc, stdout="", stderr=""):
        self.rc, self.stdout, self.stderr = int(rc), str(stdout or ""), str(stderr or "")


class Decision:
    def __init__(self, action, code):
        self.action, self.code = str(action), str(code)


class Config:
    def __init__(self, *, var_root, data_dir, state_dir, lane_dir, holdout_dir,
                 holdout_sums, r2_freeze, r2_freeze_sha256, run_sh, image,
                 blackouts_path=None, disk_floor_gib=150, model_sources=None,
                 data_candidates=(), manifest_files=(), writable_probe=None,
                 key_file=None, first_month="2026-12", expected_models=None):
        self.var_root, self.data_dir = Path(var_root), Path(data_dir)
        self.state_dir, self.lane_dir = Path(state_dir), Path(lane_dir)
        self.holdout_dir, self.holdout_sums = Path(holdout_dir), Path(holdout_sums)
        self.r2_freeze, self.r2_freeze_sha256 = Path(r2_freeze), str(r2_freeze_sha256)
        self.run_sh, self.image = Path(run_sh), str(image)
        self.blackouts_path = Path(blackouts_path) if blackouts_path else None
        self.disk_floor_gib = float(disk_floor_gib)
        self.model_sources = dict(model_sources or DEFAULT_MODEL_SOURCES)
        self.data_candidates = tuple(Path(p) for p in (data_candidates or (self.var_root,)))
        self.manifest_files = tuple(Path(p) for p in manifest_files)
        self.writable_probe = writable_probe or (lambda path: os.access(path, os.W_OK))
        self.key_file = Path(key_file) if key_file else Path("/home/kayla/.config/qrp-research-key/deepseek-research.env")
        self.first_month = str(first_month)
        self.expected_models = dict(expected_models or MODELS)


def canonical(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
def sha256_bytes(value): return hashlib.sha256(value).hexdigest()
def record_hash(value): return sha256_bytes(canonical({k: v for k, v in value.items() if k != "record_hash"}).encode())


def atomic_json(path, value, keep_previous=False):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    if keep_previous and path.exists():
        previous = path.with_name(path.name + ".prev")
        old_tmp = previous.with_name(f".{previous.name}.{os.getpid()}.tmp")
        old_tmp.write_bytes(path.read_bytes()); os.replace(old_tmp, previous)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_text(canonical(value) + "\n", encoding="utf-8"); os.replace(temp, path)


def first_json(text):
    value = {}
    for line in str(text or "").splitlines():
        if not line.strip(): continue
        try: candidate = json.loads(line)
        except json.JSONDecodeError: continue
        if isinstance(candidate, dict): value = candidate
    return value


def classify(rc, outcome=None, error=None):
    code = str(outcome or error or f"RC_{int(rc)}")
    if rc == 0: return Decision("DONE", code)
    if rc in (73, 74): return Decision("WAIT_BUSY", code)
    if rc in (3, 64): return Decision("ALERT_NO_RESUME", code)
    if rc == 75:
        if code in RETRYABLE: return Decision("RETRY", code)
        if code == "WAITING_STEP_CRASHED_MID_CALL": return Decision("SETTLE_ONCE", code)
        return Decision("ALERT_NO_RESUME", code)
    return Decision("ALERT_NO_RESUME", code)


def validate_qrp_var(config):
    root, data = config.var_root.resolve(), config.data_dir.resolve()
    candidates = tuple(dict.fromkeys(p.resolve() for p in config.data_candidates))
    if root not in candidates or data != root / "ledger": raise ConfigError("QRP_VAR_AUTHORITY_NOT_CONFIGURED")
    writable = [p for p in candidates if p.exists() and config.writable_probe(p)]
    if len(writable) > 1: raise ConfigError("QRP_VAR_DUAL_WRITABLE")
    if config.manifest_files and any(not p.exists() for p in config.manifest_files): raise ConfigError("QRP_VAR_MANIFEST_MISMATCH")
    contents = [p.read_bytes() for p in config.manifest_files]
    if len(contents) > 1 and any(value != contents[0] for value in contents[1:]): raise ConfigError("QRP_VAR_MANIFEST_MISMATCH")
    return data


def default_fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "qrp-rf1116-model-gate/1"})
    with urllib.request.urlopen(request, timeout=30) as response: return response.read()


class ModelGate:
    def __init__(self, config, fetch=default_fetch, now=None):
        self.config, self.fetch = config, fetch
        self.now = now or (lambda: datetime.now(CST))

    def check(self, write_state=False):
        observed, status = {}, "PASS"
        for url in sorted(self.config.model_sources):
            try:
                body = self.fetch(url); body = body if isinstance(body, bytes) else str(body).encode()
            except Exception as exc:
                observed[url] = {"fetch": "FAILED", "error_class": type(exc).__name__}; status = "FETCH_FAILED"; continue
            text = body.decode("utf-8", errors="replace")
            matches = {model: (served in text and ("pricing" not in url or model in text)) for model, served in self.config.expected_models.items()}
            observed[url] = {"fetch": "OK", "sha256": sha256_bytes(body), "matches": matches}
            if not all(matches.values()) and status == "PASS": status = "FAIL"
        result = {"at": self.now().astimezone(CST).isoformat(), "status": status,
                  "expected_sha256": sha256_bytes(canonical(self.config.expected_models).encode()),
                  "observed_sha256": sha256_bytes(canonical(observed).encode()), "models": sorted(self.config.expected_models)}
        if write_state: atomic_json(self.config.state_dir / "model_gate_last.json", result, keep_previous=True)
        return result


def default_runner(argv, env):
    process = subprocess.run(argv, env={**os.environ, **env}, text=True, capture_output=True, check=False)
    return CommandResult(process.returncode, process.stdout, process.stderr)


def default_disk_free(path): return shutil.disk_usage(path).free / (1024 ** 3)


class Supervisor:
    def __init__(self, config, runner=default_runner, fetch=default_fetch, now=None, disk_free=default_disk_free):
        self.config, self.runner, self.fetch = config, runner, fetch
        self.now = now or (lambda: datetime.now(CST)); self.disk_free = disk_free
        self.ledger_path = config.state_dir / "ledger.jsonl"
        self.alert_path = config.state_dir / "alert_status.json"
        self.lock_path = config.state_dir / "tick.lock"

    def _rows(self):
        if not self.ledger_path.exists(): return []
        rows, previous = [], None
        for number, line in enumerate(self.ledger_path.read_text(encoding="utf-8").splitlines(), 1):
            try: row = json.loads(line)
            except json.JSONDecodeError as exc: raise LedgerError(f"HASH_MISMATCH:{number}:json") from exc
            if row.get("schema") != "RF1116_ROUND_TIMER_EVENT_V1" or row.get("seq") != number:
                raise LedgerError(f"HASH_MISMATCH:{number}:shape")
            if row.get("prev_hash") != previous or row.get("record_hash") != record_hash(row):
                raise LedgerError(f"HASH_MISMATCH:{number}")
            previous = row["record_hash"]; rows.append(row)
        return rows

    def _transition(self, slot, state, detail=None):
        rows = self._rows()
        body = {"schema": "RF1116_ROUND_TIMER_EVENT_V1", "seq": len(rows) + 1,
                "at": self.now().astimezone(CST).isoformat(), "slot": slot,
                "state": state, "detail": detail or {},
                "prev_hash": rows[-1]["record_hash"] if rows else None}
        row = {**body, "record_hash": record_hash(body)}
        self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
        with self.ledger_path.open("a", encoding="utf-8") as stream:
            stream.write(canonical(row) + "\n"); stream.flush(); os.fsync(stream.fileno())
        return row

    def _current(self, slot):
        rows = [row for row in self._rows() if row["slot"] == slot]
        return rows[-1] if rows else None

    def _alert(self, slot, code, detail=None):
        if self.alert_path.exists(): value = json.loads(self.alert_path.read_text(encoding="utf-8"))
        else: value = {"schema": "RF1116_ROUND_TIMER_ALERT_STATUS_V1", "active": []}
        key = f"{slot}:{code}"
        if not any(row.get("key") == key for row in value["active"]):
            value["active"].append({"key": key, "slot": slot, "code": code,
                                    "at": self.now().astimezone(CST).isoformat(), "detail": detail or {}})
        value["updated_at"] = self.now().astimezone(CST).isoformat(); atomic_json(self.alert_path, value)

    def _in_blackout(self):
        if not self.config.blackouts_path: return None
        value, instant = json.loads(self.config.blackouts_path.read_text(encoding="utf-8")), self.now().astimezone(CST)
        for entry in value.get("entries", []):
            if "LINUX" in entry.get("hosts", []) and datetime.fromisoformat(entry["start"]) <= instant < datetime.fromisoformat(entry["end"]):
                return entry.get("id", "BLACKOUT")
        return None

    def _preconditions(self, slot):
        try: validate_qrp_var(self.config)
        except ConfigError as exc:
            self._alert(slot, str(exc)); return f"STOPPED_{exc}"
        if (not self.config.r2_freeze.exists() or not SHA64.match(self.config.r2_freeze_sha256)
                or sha256_bytes(self.config.r2_freeze.read_bytes()) != self.config.r2_freeze_sha256):
            self._alert(slot, "R2_FREEZE_MISSING_OR_MISMATCH"); return "WAITING_R2_FREEZE"
        if not self.config.holdout_dir.is_dir() or not self.config.holdout_sums.is_file(): return "WAITING_HOLDOUT_SEGMENT"
        blackout = self._in_blackout()
        if blackout: return f"WAITING_BLACKOUT:{blackout}"
        if self.disk_free(self.config.lane_dir) < self.config.disk_floor_gib: return "WAITING_DISK_FLOOR"
        gate = ModelGate(self.config, fetch=self.fetch, now=self.now).check(write_state=True)
        if gate["status"] != "PASS":
            self._alert(slot, f"MODEL_GATE_{gate['status']}", gate); return f"WAITING_MODEL_GATE:{gate['status']}"
        return None

    def _execute(self, current):
        round_id = ((current or {}).get("detail") or {}).get("round_id")
        if round_id:
            argv = [str(self.config.run_sh), "resume-llm", round_id]
        else:
            argv = [str(self.config.run_sh), "generate-llm", sha256_bytes(self.config.holdout_sums.read_bytes())]
        env = {"RF1116_RUNNER_IMAGE": self.config.image, "RF1116_HOLDOUT_SEGMENT": "R2", "QRP_DATA_DIR": str(self.config.data_dir)}
        return self.runner(argv, env)

    def _crash_occurrence(self, round_id):
        calls = self.config.data_dir / "research" / "mining_llm_calls.jsonl"
        if not round_id or not calls.exists(): return "unknown"
        latest = None
        for line in calls.read_text(encoding="utf-8").splitlines():
            try: row = json.loads(line)
            except json.JSONDecodeError: continue
            if row.get("round_id") == round_id and row.get("outcome") == "WAITING_STEP_CRASHED_MID_CALL": latest = row
        if not latest: return "unknown"
        return str(latest.get("request_sha256") or latest.get("key") or latest.get("seq") or "unknown")

    def _tick_locked(self, slot):
        if not re.fullmatch(r"\d{4}-\d{2}:[12]", slot): raise ConfigError("SLOT_KEY_INVALID")
        current = self._current(slot)
        if current and (current["state"] == "DONE" or current["state"].startswith("STOPPED")): return current
        current_round_id = ((current or {}).get("detail") or {}).get("round_id")
        if current and current["state"] == "STARTING" and not current_round_id:
            detail = {"prior_record_hash": current["record_hash"]}
            self._alert(slot, "UNCERTAIN_START", detail)
            return self._transition(slot, "STOPPED_UNCERTAIN_START", detail)
        today = self.now().astimezone(CST).date().isoformat()
        retry_count = len([row for row in self._rows() if row["slot"] == slot and row["state"] == "WAITING_RETRY" and row["at"][:10] == today])
        retry_after = ((current or {}).get("detail") or {}).get("retry_after")
        if current and current["state"] == "WAITING_RETRY" and retry_after and self.now().astimezone(CST) < datetime.fromisoformat(retry_after):
            return current
        if current and current["state"] in {"WAITING_RETRY", "WAITING_RETRY_LIMIT"} and retry_count >= 3:
            return self._transition(slot, "WAITING_RETRY_LIMIT", {"round_id": current["detail"].get("round_id"), "attempts_today": retry_count})
        precondition = self._preconditions(slot)
        if precondition:
            return self._transition(slot, precondition, {"round_id": current_round_id} if current_round_id else None)
        self._transition(slot, "STARTING", {"resume": bool(current_round_id), "round_id": current_round_id})
        result = self._execute(current)
        output, refusal = first_json(result.stdout), first_json(result.stderr)
        outcome, error = output.get("llm_state"), refusal.get("error")
        round_id = output.get("round_id") or ((current or {}).get("detail") or {}).get("round_id")
        decision = classify(result.rc, outcome, error)
        detail = {"rc": result.rc, "code": decision.code, "round_id": round_id}
        if decision.action == "DONE": return self._transition(slot, "DONE", detail)
        if decision.action == "WAIT_BUSY": return self._transition(slot, "WAITING_BUSY", detail)
        if decision.action == "RETRY":
            delay = (5, 15, 30)[min(retry_count, 2)]
            detail["retry_after"] = (self.now().astimezone(CST) + timedelta(minutes=delay)).isoformat()
            return self._transition(slot, "WAITING_RETRY", detail)
        if decision.action == "SETTLE_ONCE":
            detail["occurrence"] = self._crash_occurrence(round_id)
            prior = [row for row in self._rows() if row["slot"] == slot and row["state"] == "WAITING_SETTLE" and row["detail"].get("occurrence") == detail["occurrence"]]
            self._alert(slot, decision.code, detail)
            return self._transition(slot, "STOPPED_CRASH_SETTLED" if prior else "WAITING_SETTLE", detail)
        self._alert(slot, decision.code, detail); return self._transition(slot, f"STOPPED_{decision.code}", detail)

    def tick(self, slot):
        self.config.state_dir.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX); return self._tick_locked(slot)

    def tick_auto(self):
        now = self.now().astimezone(CST)
        month = f"{now:%Y-%m}"
        if month < self.config.first_month or (now.day == 1 and (now.hour, now.minute) < (20, 50)):
            return {"state": "WAITING_NOT_SLOT_TIME", "at": now.isoformat()}
        last = None
        for ordinal in (1, 2):
            last = self.tick(f"{month}:{ordinal}")
            if last["state"] != "DONE": return last
        return last


def config_from_env():
    var_root = Path(os.environ.get("QRP_VAR_ROOT", "/srv/research-lane/qrp/var"))
    data_dir = Path(os.environ.get("QRP_DATA_DIR", str(var_root / "ledger")))
    lane = Path(os.environ.get("RF1116_LANE_DIR", "/srv/research-lane/rf1116-mining"))
    candidates = tuple(filter(None, os.environ.get("QRP_VAR_CANDIDATES", str(var_root)).split(":")))
    manifests = tuple(filter(None, os.environ.get("QRP_VAR_MANIFESTS", "").split(":")))
    expectations_file = Path(os.environ.get("RF1116_MODEL_EXPECTATIONS_FILE", str(lane / "code" / "config" / "rq_deepseek_gateway.v1.json")))
    try:
        expected_models = json.loads(expectations_file.read_text(encoding="utf-8"))["price_table"]["source"]["model_versions"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ConfigError("MODEL_EXPECTATIONS_INVALID") from exc
    return Config(
        var_root=var_root, data_dir=data_dir,
        state_dir=os.environ.get("RF1116_ROUND_TIMER_STATE_DIR", str(lane / "round-timer")),
        lane_dir=lane,
        holdout_dir=os.environ.get("RF1116_R2_HOLDOUT_DIR", str(lane / "holdout-sealed" / "rf1116-cn-a-daily-holdout-r2")),
        holdout_sums=os.environ.get("RF1116_R2_HOLDOUT_SUMS", str(lane / "holdout-sealed" / "rf1116-cn-a-daily-holdout-r2" / "SHA256SUMS")),
        r2_freeze=os.environ.get("RF1116_R2_FREEZE_FILE", str(lane / "contracts" / "RF1116_HOLDOUT_CN_A_R2_FREEZE_1.md")),
        r2_freeze_sha256=os.environ.get("RF1116_R2_FREEZE_SHA256", ""),
        run_sh=os.environ.get("RF1116_RUN_SH", str(lane / "code" / "deploy" / "research-lane" / "round-runner" / "run.sh")),
        image=os.environ.get("RF1116_RUNNER_IMAGE", ""),
        blackouts_path=os.environ.get("RF1116_BLACKOUTS_FILE", str(lane / "code" / "config" / "rq-blackouts.v1.json")),
        disk_floor_gib=float(os.environ.get("RF1116_DISK_FLOOR_GIB", "150")),
        data_candidates=candidates, manifest_files=manifests,
        first_month=os.environ.get("RF1116_FIRST_MONTH", "2026-12"),
        expected_models=expected_models,
    )


def main(argv):
    config = config_from_env()
    if argv == ["--check-only"]:
        result = ModelGate(config).check(write_state=True); print(canonical(result))
        return 0 if result["status"] == "PASS" else 1
    if argv == ["tick"]:
        print(canonical(Supervisor(config).tick_auto())); return 0
    if len(argv) == 2 and argv[0] == "tick-slot":
        print(canonical(Supervisor(config).tick(argv[1]))); return 0
    print("usage: round_timer.py --check-only | tick | tick-slot YYYY-MM:{1|2}", file=sys.stderr); return 64


if __name__ == "__main__": raise SystemExit(main(sys.argv[1:]))
