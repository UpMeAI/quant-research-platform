"""Fail-closed supervisor primitives for HEAVY_RUN_SPEC_V1.

The module deliberately keeps every external operation injectable.  Tests use
only filesystem fixtures; production commands are reached only by ``run``.
"""
import dataclasses
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import subprocess
import time

from . import core, guard

GIB = 2 ** 30
FLOOR_GIB = 150
RESUME_MARGIN_GIB = 10
GUARD_CLEAR = dt.timedelta(minutes=60)
DRIVER_EXITS = frozenset((0, 3, 4, 64, 65, 66, 75))
MUTATION_INVARIANTS = {
    "BINARY_GIB", "UNKNOWN_IS_FALSE", "V2_GATES", "MISSING_INVALID", "COOPERATIVE_NOT_FROZEN",
    "CLEAN_STRAYS", "DB_PROBE_REQUIRED", "COMPARATOR_SHA", "YIELD_NOT_T1", "LEDGER_HASH_CHAIN",
}
FORBIDDEN_ROOTS = ("/srv/v6-prod", "/srv/research-lane2")
PRECONDITIONS = frozenset(("FILE_SHA", "JSON_FIELD_EQ", "JSON_TIME_AFTER", "TASK_COMPLETE", "NOT_BEFORE"))
COMMON_ROWS = frozenset(("H01", "H02", "H03", "H04", "H05", "H06", "H07", "H08"))
Q0_ROWS = frozenset(("Q01", "Q02"))
LAB_ROWS = frozenset(("L01", "L02", "L03", "L04"))


class HeavyRefused(Exception):
    def __init__(self, code, detail=None):
        super().__init__(code if detail is None else "%s:%s" % (code, detail))
        self.code = code
        self.detail = detail


@dataclasses.dataclass(frozen=True)
class DriverOutcome:
    result: str
    queue_state: str
    code: str
    count_t1: bool = False


class FakeServices:
    """Small deterministic pin service used by acceptance tests."""
    def __init__(self, image_digest=None):
        self._image_digest = image_digest
        self.driver_calls = []

    def image_digest(self, _name):
        return self._image_digest


class DefaultServices:
    def image_digest(self, name):
        r = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", name], capture_output=True, text=True, timeout=30)
        return r.stdout.strip() if r.returncode == 0 else None

    def available_bytes(self, path):
        return os.statvfs(path).f_bavail * os.statvfs(path).f_frsize

    def run_driver(self, argv, env, cwd):
        return subprocess.run(argv, cwd=str(cwd), env=env, timeout=None).returncode


def _sha(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _json(path):
    try:
        return json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError, TypeError):
        return None


def _field(doc, dotted):
    cur = doc
    for part in str(dotted).split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None, False
        cur = cur[part]
    return cur, True


def _walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _walk_strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _walk_strings(v)


def validate_spec(value):
    """Return closed refusal codes; an empty list means structurally usable."""
    if not isinstance(value, dict) or value.get("schema") != "HEAVY_RUN_SPEC_V1":
        return ["INVALID_PIN_SPEC"]
    required = ("pins", "preconditions", "db", "run_dirs", "acceptance", "budget")
    if any(k not in value for k in required):
        return ["INVALID_PIN_SPEC"]
    pins = value.get("pins") or {}
    if any(k not in pins for k in ("run_plan", "input_manifest", "code_tree", "image", "template", "driver")):
        return ["INVALID_PIN_SPEC"]
    if not isinstance(value.get("preconditions"), list) or not isinstance(value.get("run_dirs"), dict):
        return ["INVALID_PIN_SPEC"]
    if any(not isinstance(p, dict) or p.get("kind") not in PRECONDITIONS for p in value["preconditions"]):
        return ["INVALID_PIN_SPEC"]
    if not value["run_dirs"] or any(not isinstance(v, str) or not v.startswith("/") for v in value["run_dirs"].values()):
        return ["INVALID_PIN_SPEC"]
    for s in _walk_strings(value):
        if any(s == p or s.startswith(p + "/") for p in FORBIDDEN_ROOTS):
            return ["PATH_FORBIDDEN"]
    db = value.get("db")
    if isinstance(db, str):
        mode = db
    elif isinstance(db, dict):
        mode = db.get("mode")
    else:
        mode = None
    if mode not in ("NONE", "READ_ONLY"):
        return ["INVALID_PIN_SPEC"]
    template_id = ((pins.get("template") or {}).get("template_id"))
    rows = set((value.get("acceptance") or {}).get("rows") or [])
    required_rows = COMMON_ROWS | (LAB_ROWS if template_id == "T-HEAVY-LAB-E2E-V1-LINUX" else Q0_ROWS)
    if not required_rows <= rows:
        return ["INVALID_PIN_SPEC"]
    if template_id == "T-HEAVY-Q0-LANE-V1-LINUX" and not rows.intersection(("Q03", "Q04", "Q05")):
        return ["INVALID_PIN_SPEC"]
    if not re.fullmatch(r"[0-9a-f]{64}", str((pins.get("template") or {}).get("template_sha256") or "")):
        return ["INVALID_PIN_SPEC"]
    return []


def load_spec(cfg, spec_sha256, run_driver=None):
    """Read the canonical inbox path and verify its bytes before parsing."""
    if not re.fullmatch(r"[0-9a-f]{64}", str(spec_sha256 or "")):
        raise HeavyRefused("INVALID_PIN_SPEC")
    path = pathlib.Path(cfg.inbox_dir) / "heavy-specs" / (spec_sha256 + ".json")
    try:
        raw = path.read_bytes()
    except OSError:
        raise HeavyRefused("INVALID_PIN_SPEC")
    if hashlib.sha256(raw).hexdigest() != spec_sha256:
        raise HeavyRefused("INVALID_PIN_SPEC")
    try:
        value = json.loads(raw)
    except ValueError:
        raise HeavyRefused("INVALID_PIN_SPEC")
    errs = validate_spec(value)
    if errs:
        raise HeavyRefused(errs[0])
    return value, path


def _pin_file(entry, sha_key="sha256"):
    try:
        p = pathlib.Path(entry["path"])
        return p.is_file() and not p.is_symlink() and _sha(p) == entry[sha_key]
    except (KeyError, OSError, TypeError):
        return False


def check_pins(spec, services=None):
    services = services or DefaultServices()
    pins = spec.get("pins") or {}
    bad = []
    if not _pin_file(pins.get("run_plan") or {}):
        bad.append({"pin": "run_plan", "code": "INVALID_PIN_RUN_PLAN"})
    if not _pin_file(pins.get("input_manifest") or {}):
        bad.append({"pin": "input_manifest", "code": "INVALID_PIN_INPUT_MANIFEST"})
    tree = pins.get("code_tree") or {}
    tar_ok = _pin_file({"path": tree.get("path"), "sha256": tree.get("tar_sha256")})
    man_ok = _pin_file({"path": tree.get("manifest_path"), "sha256": tree.get("manifest_sha256")})
    if not (tar_ok and man_ok):
        bad.append({"pin": "code_tree", "code": "INVALID_PIN_CODE_TREE"})
    image = pins.get("image") or {}
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(image.get("digest") or "")) or services.image_digest(image.get("name")) != image.get("digest"):
        bad.append({"pin": "image", "code": "INVALID_PIN_IMAGE"})
    driver = pins.get("driver") or {}
    if not _pin_file(driver):
        bad.append({"pin": "driver", "code": "INVALID_PIN_DRIVER"})
    return bad


def validate_comparators(spec):
    for comp in ((spec.get("pins") or {}).get("driver") or {}).get("comparators") or []:
        if not _pin_file(comp):
            return "INVALID_PIN_COMPARATOR"
    return None


def check_preconditions(spec, conn, now):
    rows = []
    for p in spec.get("preconditions") or []:
        kind = p.get("kind")
        ok = False
        detail = {}
        try:
            if kind == "FILE_SHA":
                ok = _pin_file(p)
                detail["sha256"] = _sha(p["path"]) if pathlib.Path(p["path"]).is_file() else None
            elif kind == "JSON_FIELD_EQ":
                doc = _json(p.get("path"))
                got, present = _field(doc, p.get("field"))
                ok = present and got == p.get("value")
                detail["got"] = got if present else None
            elif kind == "JSON_TIME_AFTER":
                av, ap = _field(_json(p.get("path")), p.get("field"))
                bv, bp = _field(_json(p.get("other_path")), p.get("other_field"))
                ok = ap and bp and core.parse_iso(av) > core.parse_iso(bv)
            elif kind == "TASK_COMPLETE":
                row = conn.execute("select state from task where task_id=?", (p.get("task_id"),)).fetchone() if conn is not None else None
                ok = bool(row and row[0] == "COMPLETE")
            elif kind == "NOT_BEFORE":
                ok = now >= core.parse_iso(p.get("at"))
        except (OSError, ValueError, TypeError, KeyError):
            ok = False
        rows.append({"kind": kind, "pass": bool(ok), "detail": detail})
    return all(x["pass"] for x in rows), rows


def floor_allows(available_bytes, floor_gib=FLOOR_GIB, peak_bytes=0):
    return isinstance(available_bytes, int) and available_bytes >= int(floor_gib) * GIB + int(peak_bytes or 0)


def guard_resume_ready(now, last_trip, available_bytes, floor_gib=FLOOR_GIB):
    return now - last_trip >= GUARD_CLEAR and available_bytes >= (int(floor_gib) + RESUME_MARGIN_GIB) * GIB


def guard_terminal(stops):
    return "STOPPED_BY_GUARD_REPEATED" if int(stops) >= 3 else "GUARD_DISK_FLOOR"


def t1_terminal(attempts, budget):
    return "T1_BUDGET_EXHAUSTED" if int(attempts) > int(budget) else "T1_INTERRUPTED"


def validate_db_probe(report, db):
    mode = db if isinstance(db, str) else (db or {}).get("mode")
    if mode == "NONE":
        return None
    if not isinstance(report, dict):
        return "DB_NOT_READ_ONLY"
    source = report.get("source")
    if source == "WAIVED":
        waiver = (db or {}).get("waiver") if isinstance(db, dict) else None
        if isinstance(waiver, dict) and waiver.get("reason") and re.fullmatch(r"[0-9a-f]{64}", str(waiver.get("pinRecordSha256") or "")):
            return None
        return "DB_NOT_READ_ONLY"
    if source not in ("ROLE_DEFAULT", "OPTIONS"):
        return "DB_NOT_READ_ONLY"
    if report.get("transactionReadOnly") is not True or report.get("writeAttemptSqlstate") != "25006" or not report.get("role"):
        return "DB_NOT_READ_ONLY"
    return None


def validate_containers(containers, prefix, writer, stop_exact):
    bad = []
    writer_name = (writer or {}).get("container") if isinstance(writer, dict) else None
    for item in containers or []:
        name = item.get("name")
        if not isinstance(name, str) or not name.startswith(prefix) or name == writer_name:
            continue
        if item.get("network") == "container:a6r-postgres":
            env = item.get("env") or []
            if not any(x == "PGOPTIONS=-c default_transaction_read_only=on" for x in env):
                stop_exact(name)
                bad.append(name)
    return bad


def cleanup_strays(names, prefix, stop_exact):
    for name in names or []:
        if isinstance(name, str) and name.startswith(prefix):
            stop_exact(name)


def gates_ready(path, now_epoch, writer_alive):
    try:
        age = now_epoch - pathlib.Path(path).stat().st_mtime
        return bool(writer_alive) and 0 <= age < 180
    except OSError:
        return False


def gates_cleanup_ok(writer_alive):
    return not writer_alive


def classify_driver_result(result):
    if not isinstance(result, dict):
        return DriverOutcome("INVALID", "BLOCKED_DETERMINISTIC", "INVALID_DRIVER_RESULT")
    code, reason = result.get("exit"), str(result.get("reason") or "")
    if code == 0:
        return DriverOutcome("DONE", "EVIDENCE_WRITTEN", "HEAVY_EVIDENCE")
    if code == 3:
        return DriverOutcome("STOPPED_BY_GUARD", "WAITING_EXTERNAL", "GUARD_DISK_FLOOR")
    if code == 4:
        return DriverOutcome("WAITING", "WAITING_EXTERNAL", "GUARD_DISK_FLOOR")
    if code == 75:
        if reason.startswith("QUOTA"):
            return DriverOutcome("WAITING", "WAITING_QUOTA", "QUOTA")
        for name in ("WINDOW_YIELD", "DATA_NOT_READY", "GUARD_BRAKE", "TRL_RECEIPT"):
            if reason.startswith(name):
                return DriverOutcome("WAITING", "WAITING_EXTERNAL", name)
        return DriverOutcome("INVALID", "BLOCKED_DETERMINISTIC", "INVALID_DRIVER_REASON")
    if code in (64, 65, 66):
        return DriverOutcome("INVALID", "BLOCKED_DETERMINISTIC", "INVALID_" + (reason.split(":", 1)[0] or "DRIVER_REFUSAL"))
    return DriverOutcome("INVALID", "BLOCKED_DETERMINISTIC", "INVALID_DRIVER_EXIT")


def _task_record(path, task_id):
    p = pathlib.Path(path) / "RQ_TASK.json"
    return _json(p), p


def prepare_run_dirs(spec, task_id, resume=False):
    for raw in (spec.get("run_dirs") or {}).values():
        d = pathlib.Path(raw)
        if d.is_symlink():
            return "INVALID_RUN_DIR_REUSED"
        doc, mark = _task_record(d, task_id)
        if d.exists():
            if not d.is_dir() or doc != {"task_id": task_id}:
                return "INVALID_RUN_DIR_REUSED"
        else:
            if resume:
                return "INVALID_RUN_DIR_REUSED"
            d.mkdir(parents=True)
            mark.write_text(core.canonical({"task_id": task_id}))
            mark.chmod(0o444)
    return None


def append_ledger(path, entry):
    path = pathlib.Path(path)
    prev = core.GENESIS
    seq = 1
    if path.exists() and path.stat().st_size:
        lines = path.read_text().splitlines()
        last = json.loads(lines[-1])
        prev, seq = last["hash"], int(last["seq"]) + 1
    body = dict(entry)
    body.update(seq=seq, prev_hash=prev)
    body["hash"] = core.sha256_hex(core.canonical([seq, entry, prev]))
    with path.open("a") as f:
        f.write(core.canonical(body) + "\n")
        f.flush()
        os.fsync(f.fileno())
    return body


def verify_ledger(path):
    prev = core.GENESIS
    try:
        for expected, line in enumerate(pathlib.Path(path).read_text().splitlines(), 1):
            row = json.loads(line)
            entry = {k: v for k, v in row.items() if k not in ("seq", "prev_hash", "hash")}
            want = core.sha256_hex(core.canonical([expected, entry, prev]))
            if row.get("seq") != expected or row.get("prev_hash") != prev or row.get("hash") != want:
                return False, expected
            prev = row["hash"]
    except (OSError, ValueError, TypeError):
        return False, 1
    return True, None


def _write_json(path, value, mode=0o444):
    path = pathlib.Path(path)
    path.write_text(core.canonical(value))
    path.chmod(mode)


def write_error(attempt_dir, error_class, code):
    p = pathlib.Path(attempt_dir) / "error.json"
    p.write_text(core.canonical({"class": error_class, "code": code}))
    return p


def run(cfg, spec_sha256, *, conn=None, resume=False, dry=False, services=None, now=None):
    """Execute a single supervised heavy attempt; returns the supervisor exit code.

    This path is intentionally conservative: every unimplemented or unverifiable
    production fact becomes a structured refusal, never a guessed success.
    """
    services = services or DefaultServices()
    now = now or core.now_cst()
    attempt = pathlib.Path(os.environ.get("RQ_ATTEMPT_DIR", ""))
    if not attempt.is_dir():
        raise HeavyRefused("INVALID_ATTEMPT_DIR")
    spec, spec_path = load_spec(cfg, spec_sha256)
    if cfg.blackouts_path:
        try:
            from . import pause
            pause.load_blackouts(cfg.blackouts_path)
        except pause.BlackoutsUnusable:
            write_error(attempt, "E", "BLACKOUTS_FILE_UNUSABLE")
            return 75
    preflight = {"schema": "HEAVY_PREFLIGHT_V1", "spec_sha256": spec_sha256, "pins": [], "preconditions": []}
    bad = check_pins(spec, services)
    comp = validate_comparators(spec)
    if comp:
        bad.append({"pin": "comparator", "code": comp})
    preflight["pins"] = bad
    ok, checks = check_preconditions(spec, conn, now)
    preflight["preconditions"] = checks
    _write_json(attempt / "preflight.json", preflight)
    if bad:
        write_error(attempt, "D", bad[0]["code"])
        return 65
    if not ok:
        write_error(attempt, "E", "HEAVY_PRECONDITION")
        return 75
    available = services.available_bytes(cfg.lane1_path)
    peak = int((spec.get("budget") or {}).get("peak_bytes") or 0)
    (attempt / "floor.jsonl").write_text(core.canonical({"at": core.iso(now), "available_bytes": available, "floor_gib": FLOOR_GIB, "peak_bytes": peak}) + "\n")
    if not floor_allows(available, FLOOR_GIB, peak):
        write_error(attempt, "E", "GUARD_DISK_FLOOR")
        return 4
    err = prepare_run_dirs(spec, os.environ.get("RQ_TASK_ID", ""), resume=resume)
    if err:
        write_error(attempt, "D", err)
        return 65
    if dry:
        _write_json(attempt / "result.json", {"schema": "HEAVY_DRY_RUN_V1", "status": "DRY_RUN_OK"})
        return 0
    driver = ((spec.get("pins") or {}).get("driver") or {}).get("path")
    env = {k: v for k, v in os.environ.items() if k in (
        "RQ_TASK_ID", "RQ_ATTEMPT_DIR", "RQ_RUN_DIR", "RQ_PAUSE_FILE", "RQ_GATES_FILE", "RQ_CONTAINER_PREFIX",
        "RQ_RESUME", "DOCKER_HOST", "LC_ALL", "LANG")}
    rc = services.run_driver([driver], env, attempt / "work")
    result = _json(attempt / "driver-result.json")
    if not isinstance(result, dict) or result.get("exit") != rc or rc not in DRIVER_EXITS:
        write_error(attempt, "D", "INVALID_DRIVER_RESULT")
        return 66
    if (spec.get("db") or {}).get("mode") == "READ_ONLY" and validate_db_probe(result.get("dbReadOnlyProbe"), spec.get("db")):
        write_error(attempt, "E", "DB_NOT_READ_ONLY")
        return 75
    outcome = classify_driver_result(result)
    _write_json(attempt / "result.json", {"schema": "HEAVY_SUPERVISOR_RESULT_V1", "outcome": dataclasses.asdict(outcome), "driver": result})
    return rc
