"""Atomic, non-overwriting, descriptor-bound RUT1 input delivery."""

import datetime as dt
import fcntl
import json
import os
import shutil
import subprocess
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath

from . import forms, verify
from .securefs import Root, Tree, UnsafePath


MIN_FREE_AFTER_BYTES = 220_000_000_000
EXPECTED_BYTES = {"p1": 1_000_000_000, "p2": 10_000_000_000}
DEFAULT_BASE = Path("/srv/research-lane/overseas")
CST = dt.timezone(dt.timedelta(hours=8))
DEADLINES = {
    "p1": dt.datetime(2026, 11, 28, 7, 30, tzinfo=CST),
    "p2": dt.datetime(2026, 12, 6, 11, 30, tzinfo=CST),
}
STATUS_RELATIVE = "research/rut1-input-copy.status.json"
RECEIPT = "RUT1_INPUT_COPY_RECEIPT_V1.json"


@dataclass(frozen=True)
class RunResult:
    code: int
    reason: str
    receipt: Path | None = None
    plan: tuple[tuple[str, ...], ...] = ()


def _target_relative(phase: str) -> str:
    return "data/rut1-s8parity" if phase == "p1" else "data/rut1-s8parity-b/alpaca-1m"


def _stage_relative(phase: str, run_id: str) -> str:
    name = "rut1-s8parity.staging" if phase == "p1" else "rut1-s8parity-b.staging"
    return f"data/{name}/{run_id}"


def _target(base: Path, phase: str) -> Path:
    return Path(base) / _target_relative(phase)


def _stage(base: Path, phase: str, run_id: str) -> Path:
    return Path(base) / _stage_relative(phase, run_id)


def _receipt_payload(phase: str, run_id: str, started: dt.datetime,
                     ended: dt.datetime, result: str, tree: Tree) -> dict:
    files = []
    for relative, kind in sorted(tree.entries().items()):
        if kind != "file" or PurePosixPath(relative).name.startswith("RUT1_INPUT_COPY_RECEIPT_V1"):
            continue
        files.append({
            "path": relative,
            "sha256": tree.digest(relative),
            "bytes": tree.lstat(relative).st_size,
        })
    return {
        "schema": "RUT1_INPUT_COPY_RECEIPT_V1", "phase": phase,
        "runId": run_id, "startedAt": started.isoformat(), "endedAt": ended.isoformat(),
        "forms": [operation.form_id for operation in forms.build_plan(phase, Path("/stage"))],
        "files": files, "result": result,
    }


def _write_receipt(tree: Tree, phase: str, run_id: str, started: dt.datetime,
                   ended: dt.datetime, result: str) -> None:
    tree.atomic_json(RECEIPT, _receipt_payload(phase, run_id, started, ended, result, tree), 0o444)


def _receipt_path(base: Path, relative: str) -> Path:
    return Path(base) / relative / RECEIPT


def _complete_receipt(root: Root, target_relative: str, phase: str) -> bool:
    try:
        with root.tree(target_relative) as target:
            payload = json.loads(target.read_bytes(RECEIPT).decode("utf-8"))
    except (FileNotFoundError, OSError, UnsafePath, UnicodeError, json.JSONDecodeError):
        return False
    return (payload.get("schema"), payload.get("phase"), payload.get("result")) == (
        "RUT1_INPUT_COPY_RECEIPT_V1", phase, "COMPLETE")


def _expected_target_entries(files: dict[str, str], phase: str) -> dict[str, str]:
    expected = {}
    for relative in files:
        parts = PurePosixPath(relative).parts
        for index in range(1, len(parts)):
            expected.setdefault(PurePosixPath(*parts[:index]).as_posix(), "dir")
        expected[relative] = "file"
    if phase == "p2":
        expected["alpaca-1m.RECEIPT.json"] = "file"
    return expected


def _move_without_overwrite(source: Tree, target: Tree,
                            files: dict[str, str], phase: str) -> bool:
    allowed = _expected_target_entries(files, phase)
    for relative, kind in target.entries().items():
        if relative not in allowed or allowed[relative] != kind:
            return False
    for relative, expected_digest in files.items():
        existing = target.digest_existing(relative)
        if existing is not None and existing != expected_digest:
            return False
    for relative, expected_digest in files.items():
        if target.digest_existing(relative) is None:
            target.install_from(source, relative, expected_digest)
    return True


def _p2_receipt(target: Tree) -> None:
    entries = target.entries()
    payload = {
        "schema": "ALPACA_1M_COPY_RECEIPT_V1", "result": "PASS",
        "copies": {
            name: {
                "dataFiles": len([
                    path for path, kind in entries.items()
                    if kind == "file" and path.startswith(name + "/")
                    and path.endswith("/2026-11.jsonl.gz")
                ])
            }
            for name in ("raw", "all")
        },
    }
    target.atomic_json("alpaca-1m.RECEIPT.json", payload, 0o444)


def _subprocess_runner(operation: forms.Operation) -> int:
    return subprocess.run(
        operation.argv,
        check=False,
        pass_fds=operation.pass_fds,
    ).returncode


def _bound_operation(operation: forms.Operation, stage_path: Path, stage: Tree):
    """Bind a pull destination to a held directory descriptor."""
    if operation.destination is None:
        return operation, None
    relative = operation.destination.relative_to(stage_path)
    if operation.form_id == "R-16-SUMS":
        destination_tree = Tree(os.dup(stage.fd))
        bound_destination = Path(f"/proc/self/fd/{destination_tree.fd}") / relative.name
    else:
        destination_tree = stage.subtree(relative.as_posix(), create=True)
        bound_destination = Path(f"/proc/self/fd/{destination_tree.fd}")
    argv = list(operation.argv)
    argv[-1] = str(bound_destination)
    return replace(
        operation,
        argv=argv,
        destination=bound_destination,
        pass_fds=(destination_tree.fd,),
    ), destination_tree


def _status(root: Root, phase: str, code: int, result: str,
            attempted: dt.datetime, *, success=False) -> None:
    previous = root.read_json(STATUS_RELATIVE, {}) or {}
    last_ok = attempted.isoformat() if success else previous.get("lastOkAt")
    payload = {
        "schema": "RUT1_INPUT_COPY_STATUS_V1",
        "lastOkAt": last_ok,
        "lastAttemptAt": attempted.isoformat(),
        "phase": phase,
        "result": result,
        "rc": code,
    }
    root.atomic_json(STATUS_RELATIVE, payload)


def _finish(root: Root, phase: str, code: int, reason: str, attempted: dt.datetime,
            receipt: Path | None = None, plan=()) -> RunResult:
    _status(root, phase, code, reason, attempted, success=(code == 0))
    return RunResult(code, reason, receipt, plan)


def _run_phase(phase: str, *, base: Path, root: Root, runner, clock,
               free_bytes: int | None, run_id: str, rendered) -> RunResult:
    stage_relative = _stage_relative(phase, run_id)
    target_relative = _target_relative(phase)
    stage_path = _stage(base, phase, run_id)
    started = clock()
    if started >= DEADLINES[phase]:
        root.ensure_dir(stage_relative)
        with root.tree(stage_relative) as stage:
            _write_receipt(stage, phase, run_id, started, started, "ABORTED")
        return _finish(
            root, phase, 5, "DEADLINE", started,
            _receipt_path(base, stage_relative), rendered)
    if _complete_receipt(root, target_relative, phase):
        return _finish(
            root, phase, 0, "ALREADY_COMPLETE", started,
            _receipt_path(base, target_relative), rendered)
    if free_bytes is None:
        free_bytes = shutil.disk_usage(base).free
    if free_bytes < MIN_FREE_AFTER_BYTES + EXPECTED_BYTES[phase]:
        return _finish(root, phase, 3, "DISK_FLOOR", started, plan=rendered)

    root.ensure_dir("data")
    lock_fd = root.open_regular(
        "data/rut1-input-copy.lock",
        os.O_RDWR | os.O_CREAT,
        create_parents=True,
    )
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return _finish(root, phase, 75, "LOCKED", clock(), plan=rendered)
        root.ensure_dir(stage_relative)
        with root.tree(stage_relative) as stage:
            for operation in forms.build_plan(phase, stage_path):
                bound, destination_tree = _bound_operation(operation, stage_path, stage)
                try:
                    rc = runner(bound)
                finally:
                    if destination_tree is not None:
                        destination_tree.close()
                if rc == 126:
                    ended = clock()
                    _write_receipt(stage, phase, run_id, started, ended, "PARTIAL")
                    return _finish(
                        root, phase, 3, "GATE_REFUSED", ended,
                        _receipt_path(base, stage_relative), rendered)
                if rc != 0:
                    ended = clock()
                    _write_receipt(stage, phase, run_id, started, ended, "PARTIAL")
                    return _finish(
                        root, phase, 3, "PULL_REFUSED", ended,
                        _receipt_path(base, stage_relative), rendered)
                ended = clock()
                if ended >= DEADLINES[phase]:
                    _write_receipt(stage, phase, run_id, started, ended, "ABORTED")
                    return _finish(
                        root, phase, 5, "DEADLINE", ended,
                        _receipt_path(base, stage_relative), rendered)
            ended = clock()
            try:
                verified_files = verify.verify_tree(phase, stage)
            except verify.VerificationError as exc:
                reason = str(exc)
                _write_receipt(stage, phase, run_id, started, ended, "PARTIAL")
                code = 3 if reason == "APPLEDOUBLE_REFUSED" else 4
                return _finish(
                    root, phase, code, reason, ended,
                    _receipt_path(base, stage_relative), rendered)
            with root.tree(target_relative, create=True) as target:
                if not _move_without_overwrite(stage, target, verified_files, phase):
                    _write_receipt(stage, phase, run_id, started, ended, "CONFLICT")
                    return _finish(
                        root, phase, 4, "CONFLICT", ended,
                        _receipt_path(base, stage_relative), rendered)
                if phase == "p2":
                    _p2_receipt(target)
                _write_receipt(target, phase, run_id, started, ended, "COMPLETE")
        return _finish(
            root, phase, 0, "COMPLETE", ended,
            _receipt_path(base, target_relative), rendered)
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)


def run_phase(phase: str, *, base: Path = DEFAULT_BASE, runner=_subprocess_runner,
              clock=lambda: dt.datetime.now(CST), free_bytes: int | None = None,
              run_id: str | None = None, check: bool = False) -> RunResult:
    if phase not in ("p1", "p2"):
        return RunResult(3, "INVALID_PHASE")
    base = Path(base)
    run_id = run_id or clock().strftime("%Y%m%dT%H%M%S%z")
    stage_path = _stage(base, phase, run_id)
    plan = forms.build_plan(phase, stage_path)
    rendered = tuple(tuple(operation.argv) for operation in plan)
    if check:
        return RunResult(0, "PLAN", plan=rendered)
    try:
        with Root(base) as root:
            try:
                return _run_phase(
                    phase,
                    base=base,
                    root=root,
                    runner=runner,
                    clock=clock,
                    free_bytes=free_bytes,
                    run_id=run_id,
                    rendered=rendered,
                )
            except Exception as exc:
                reason = "UNSAFE_PATH" if isinstance(exc, UnsafePath) else f"UNEXPECTED:{type(exc).__name__}"
                code = 4 if reason == "UNSAFE_PATH" else 3
                return _finish(root, phase, code, reason, clock(), plan=rendered)
    except (UnsafePath, OSError):
        return RunResult(4, "UNSAFE_PATH", plan=rendered)
