"""Deterministic completion authority for HEAVY_MATRIX tasks."""
import hashlib
import json
import pathlib

from . import core, guard, heavy

VALID_VALUES = frozenset(("PASS", "FAIL", "MISSING", "NOT_APPLICABLE"))


def decide(rows, non_gate_rows=frozenset(("Q01",))):
    """Return the frozen five-result decision for a matrix projection."""
    if not isinstance(rows, dict) or not rows or any(v not in VALID_VALUES for v in rows.values()):
        return "INVALID", "INVALID_EVIDENCE_MATRIX"
    missing = sorted(k for k, v in rows.items() if v == "MISSING")
    if missing:
        return "INVALID", "INVALID_MISSING:" + ",".join(missing)
    failures = sorted(k for k, v in rows.items() if v == "FAIL" and k not in set(non_gate_rows))
    if failures:
        return "DONE_REFUSED", "HEAVY_REFUSED:" + ",".join(failures)
    comparison = [v for k, v in rows.items() if k.startswith(("Q", "L")) and k not in set(non_gate_rows)]
    if comparison and "PASS" not in comparison:
        return "DONE_REFUSED", "HEAVY_REFUSED:NO_COMPARISON_PASS"
    return "DONE_ACCEPTED", "HEAVY_ACCEPTED"


def _sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def verify_manifest(directory, required=()):
    """Return {relative_path: problem}; empty means a complete exact manifest."""
    root = pathlib.Path(directory)
    manifest = root / "SHA256SUMS"
    problems = {}
    try:
        lines = manifest.read_text().splitlines()
    except OSError:
        return {"SHA256SUMS": "MISSING"}
    seen = set()
    for line in lines:
        if "  " not in line:
            problems["SHA256SUMS"] = "INVALID"
            continue
        want, name = line.split("  ", 1)
        if not name or name.startswith("/") or ".." in pathlib.PurePosixPath(name).parts or name in seen:
            problems[name or "SHA256SUMS"] = "INVALID"
            continue
        seen.add(name)
        p = root / name
        if not p.is_file():
            problems[name] = "MISSING"
        elif _sha(p) != want:
            problems[name] = "SHA256_MISMATCH"
        elif p.stat().st_mode & 0o777 != 0o444:
            problems[name] = "MODE_NOT_0444"
    for name in required:
        if name not in seen:
            problems[name] = "MISSING"
    if manifest.stat().st_mode & 0o777 != 0o444:
        problems["SHA256SUMS"] = "MODE_NOT_0444"
    return problems


def result_document(task_id, rows, comparisons, pins):
    result, reason = decide(rows, non_gate_rows={"Q01"})
    norm1 = comparisons.get("Q01") if isinstance(comparisons, dict) else None
    norm2 = comparisons.get("Q02") if isinstance(comparisons, dict) else None
    wording = None
    if norm1 == "FAIL_DIFFERENCES" and norm2 == "PASS":
        wording = "PASS under NORM_V2（NORM_V1 为 FAIL_DIFFERENCES）"
    return {
        "schema": "HEAVY_RESULT_V1", "task_id": task_id, "result": result, "reason": reason,
        "matrix_sha256": core.sha256_hex(core.canonical(rows)), "pins": pins or {},
        "norm": {"NORM_V1": norm1, "NORM_V2": norm2, "wording": wording},
    }


def write_readonly(path, value):
    p = pathlib.Path(path)
    p.write_text(core.canonical(value))
    p.chmod(0o444)
    return p


def _load(path):
    try:
        return json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError):
        return None


def evaluate_attempt(attempt_dir, task_id):
    d = pathlib.Path(attempt_dir)
    required = ("preflight.json", "ro-probe.json", "containers.json", "cleanup.json", "secret-scan.json", "floor.jsonl", "gates.jsonl",
                "driver-result.json", "EVIDENCE_ROWS.json")
    manifest_errors = verify_manifest(d, required=required)
    evidence = _load(d / "EVIDENCE_ROWS.json")
    rows = (evidence or {}).get("rows") if isinstance(evidence, dict) else None
    comparisons = (evidence or {}).get("comparisons") if isinstance(evidence, dict) else {}
    pins = (evidence or {}).get("pins") if isinstance(evidence, dict) else {}
    if not isinstance(rows, dict):
        rows = {"EVIDENCE_ROWS": "MISSING"}
    if guard.scan_secrets([d]):
        rows = dict(rows)
        rows["H08"] = "FAIL"
    if manifest_errors:
        rows = dict(rows)
        rows["H07"] = "MISSING"
    matrix = {"schema": "HEAVY_EVIDENCE_MATRIX_V1", "task_id": task_id, "rows": dict(sorted(rows.items())), "manifest_errors": manifest_errors}
    result = result_document(task_id, rows, comparisons or {}, pins or {})
    return matrix, result


def complete_task(conn, cfg, task_id, now):
    task = core.get_task(conn, task_id)
    if not task or task["state"] != "EVIDENCE_WRITTEN":
        return None
    d = cfg.runs_dir / task_id / ("attempt-%d" % task["attempt_no"])
    matrix, result = evaluate_attempt(d, task_id)
    task_dir = cfg.runs_dir / task_id
    matrix_path = write_readonly(task_dir / "EVIDENCE_MATRIX.json", matrix)
    result["matrix_sha256"] = _sha(matrix_path)
    result_path = write_readonly(task_dir / "HEAVY_RESULT_V1.json", result)
    heavy.append_ledger(task_dir / "RUN_LEDGER.jsonl", {"actor": "rq-complete", "result": result["result"], "result_sha256": _sha(result_path)})
    return result
