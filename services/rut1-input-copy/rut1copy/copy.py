"""Atomic, non-overwriting RUT1 input delivery."""

import datetime as dt
import fcntl
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import forms, verify


MIN_FREE_AFTER_BYTES = 220_000_000_000
EXPECTED_BYTES = {"p1": 1_000_000_000, "p2": 10_000_000_000}
DEFAULT_BASE = Path("/srv/research-lane/overseas")
CST = dt.timezone(dt.timedelta(hours=8))
DEADLINES = {
    "p1": dt.datetime(2026, 11, 28, 7, 30, tzinfo=CST),
    "p2": dt.datetime(2026, 12, 6, 11, 30, tzinfo=CST),
}


@dataclass(frozen=True)
class RunResult:
    code: int
    reason: str
    receipt: Path | None = None
    plan: tuple[tuple[str, ...], ...] = ()


def _target(base: Path, phase: str) -> Path:
    return (base / "data" / "rut1-s8parity" if phase == "p1" else
            base / "data" / "rut1-s8parity-b" / "alpaca-1m")


def _stage(base: Path, phase: str, run_id: str) -> Path:
    name = "rut1-s8parity.staging" if phase == "p1" else "rut1-s8parity-b.staging"
    return base / "data" / name / run_id


def _atomic_json(path: Path, payload: dict, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".tmp.{os.getpid()}")
    temporary.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def _receipt_payload(phase: str, run_id: str, started: dt.datetime,
                     ended: dt.datetime, result: str, stage: Path) -> dict:
    files = []
    if stage.exists():
        for path in sorted(p for p in stage.rglob("*") if p.is_file() and not p.is_symlink()):
            if path.name.startswith("RUT1_INPUT_COPY_RECEIPT_V1"):
                continue
            files.append({
                "path": path.relative_to(stage).as_posix(),
                "sha256": verify.digest(path),
                "bytes": path.stat().st_size,
            })
    return {
        "schema": "RUT1_INPUT_COPY_RECEIPT_V1", "phase": phase,
        "runId": run_id, "startedAt": started.isoformat(), "endedAt": ended.isoformat(),
        "forms": [operation.form_id for operation in forms.build_plan(phase, stage)],
        "files": files, "result": result,
    }


def _write_staging_receipt(phase: str, run_id: str, started: dt.datetime,
                           ended: dt.datetime, result: str, stage: Path) -> Path:
    path = stage / "RUT1_INPUT_COPY_RECEIPT_V1.json"
    _atomic_json(path, _receipt_payload(phase, run_id, started, ended, result, stage), 0o444)
    return path


def _complete_receipt(target: Path, phase: str) -> Path | None:
    path = target / "RUT1_INPUT_COPY_RECEIPT_V1.json"
    try:
        payload = json.loads(path.read_text())
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if (payload.get("schema"), payload.get("phase"), payload.get("result")) == (
            "RUT1_INPUT_COPY_RECEIPT_V1", phase, "COMPLETE"):
        return path
    return None


def _move_without_overwrite(stage: Path, target: Path) -> bool:
    conflict = False
    for source in sorted((p for p in stage.rglob("*") if p.is_file()), key=lambda p: len(p.parts)):
        if source.name == "RUT1_INPUT_COPY_RECEIPT_V1.json":
            continue
        relative = source.relative_to(stage)
        destination = target / relative
        if destination.exists():
            if (not destination.is_file() or destination.is_symlink()
                    or verify.digest(destination) != verify.digest(source)):
                conflict = True
        elif destination.is_symlink():
            conflict = True
    if conflict:
        return False
    for source in sorted((p for p in stage.rglob("*") if p.is_file()), key=lambda p: len(p.parts)):
        if source.name == "RUT1_INPUT_COPY_RECEIPT_V1.json":
            continue
        destination = target / source.relative_to(stage)
        if destination.exists():
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, destination)
    return True


def _p2_receipt(target: Path) -> None:
    payload = {
        "schema": "ALPACA_1M_COPY_RECEIPT_V1", "result": "PASS",
        "copies": {
            name: {"dataFiles": len(list((target / name).glob("*/2026-11.jsonl.gz")))}
            for name in ("raw", "all")
        },
    }
    _atomic_json(target / "alpaca-1m.RECEIPT.json", payload, 0o444)


def _subprocess_runner(operation: forms.Operation) -> int:
    return subprocess.run(operation.argv, check=False).returncode


def run_phase(phase: str, *, base: Path = DEFAULT_BASE, runner=_subprocess_runner,
              clock=lambda: dt.datetime.now(CST), free_bytes: int | None = None,
              run_id: str | None = None, check: bool = False) -> RunResult:
    if phase not in ("p1", "p2"):
        return RunResult(3, "INVALID_PHASE")
    base = Path(base)
    run_id = run_id or clock().strftime("%Y%m%dT%H%M%S%z")
    stage = _stage(base, phase, run_id)
    target = _target(base, phase)
    plan = forms.build_plan(phase, stage if phase == "p1" else stage)
    rendered = tuple(tuple(operation.argv) for operation in plan)
    if check:
        return RunResult(0, "PLAN", plan=rendered)

    started = clock()
    if started >= DEADLINES[phase]:
        stage.mkdir(parents=True, exist_ok=True)
        receipt = _write_staging_receipt(phase, run_id, started, started, "ABORTED", stage)
        return RunResult(5, "DEADLINE", receipt, rendered)
    existing = _complete_receipt(target, phase)
    if existing:
        return RunResult(0, "ALREADY_COMPLETE", existing, rendered)
    if free_bytes is None:
        free_bytes = shutil.disk_usage(base).free
    if free_bytes < MIN_FREE_AFTER_BYTES + EXPECTED_BYTES[phase]:
        return RunResult(3, "DISK_FLOOR", plan=rendered)

    lock_path = base / "data" / "rut1-input-copy.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return RunResult(75, "LOCKED", plan=rendered)
        stage.mkdir(parents=True, exist_ok=True)
        for operation in plan:
            rc = runner(operation)
            if rc == 126:
                receipt = _write_staging_receipt(
                    phase, run_id, started, clock(), "PARTIAL", stage)
                return RunResult(3, "GATE_REFUSED", receipt, rendered)
            if rc != 0:
                receipt = _write_staging_receipt(
                    phase, run_id, started, clock(), "PARTIAL", stage)
                return RunResult(3, "PULL_REFUSED", receipt, rendered)
            ended = clock()
            if ended >= DEADLINES[phase]:
                receipt = _write_staging_receipt(
                    phase, run_id, started, ended, "ABORTED", stage)
                return RunResult(5, "DEADLINE", receipt, rendered)
        ended = clock()
        try:
            verify.verify_stage(phase, stage)
        except verify.VerificationError as exc:
            reason = str(exc)
            result = "PARTIAL"
            receipt = _write_staging_receipt(phase, run_id, started, ended, result, stage)
            code = 3 if reason == "APPLEDOUBLE_REFUSED" else 4
            return RunResult(code, reason, receipt, rendered)
        if not _move_without_overwrite(stage, target):
            receipt = _write_staging_receipt(phase, run_id, started, ended, "CONFLICT", stage)
            return RunResult(4, "CONFLICT", receipt, rendered)
        if phase == "p2":
            _p2_receipt(target)
        receipt = target / "RUT1_INPUT_COPY_RECEIPT_V1.json"
        _atomic_json(receipt, _receipt_payload(phase, run_id, started, ended, "COMPLETE", target), 0o444)
        _atomic_json(base / "research" / "rut1-input-copy.status.json",
                     {"lastOkAt": ended.isoformat(), "rc": 0})
        return RunResult(0, "COMPLETE", receipt, rendered)
