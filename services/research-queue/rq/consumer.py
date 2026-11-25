"""Consumer: claim, launch, heartbeat, adopt, finalize, classify outcomes (§3.4, §3.7, §3.8). One consumer per host.

The consumer is the only writer of task state while a task runs; task processes only write files in their attempt directory.
"""
import dataclasses
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import signal
import subprocess
import sys

from . import agentseam, core, guard, heavy, pause, producer, runtime, status as status_mod

T3_BACKOFF_S = (60, 180, 600, 1800, 3600)   # six tries in all, then WAITING_PROVIDER
T1_BACKOFF_S = 600
D_PREFIXES = ("MINE_", "TRIAL_LEDGER_", "MECHANISM_", "AI_ROLE_", "PREREG_", "PARITY_")
KINDS = ("T1", "T2", "T3", "Q", "A", "D", "E", "S")
SECRET_NAME = ("KEY", "TOKEN", "SECRET", "PASSWORD", "DEEPSEEK")


@dataclasses.dataclass
class Outcome:
    kind: str                       # SUCCESS or one of KINDS
    code: str = None
    http_status: int = None
    retry_after_s: int = None


def outcome_from_http(status, retry_after_s=None):
    if status in (401, 403):
        return Outcome("A", "CREDENTIAL_REJECTED", status)
    if status == 402:
        return Outcome("Q", "QUOTA", status)
    if status == 429 or 500 <= status <= 504:
        return Outcome("T3", "PROVIDER_%d" % status, status, retry_after_s)
    if status in (400, 422):
        return Outcome("D", "REQUEST_INVALID_%d" % status, status)
    return Outcome("D", "HTTP_%d" % status, status)


def _read_json(p):
    try:
        return json.loads(pathlib.Path(p).read_text())
    except (OSError, ValueError):
        return None


def classify(attempt_dir, exit_info):
    """Turn the wrapper's exit record and the task's own error.json / result.json into one Outcome."""
    d = pathlib.Path(attempt_dir)
    sig, code = exit_info.get("exit_signal"), exit_info.get("exit_code")
    if sig is not None:
        if exit_info.get("oom_kill"):
            return Outcome("T2", "RESOURCE_OOM")
        return Outcome("T1", "SIGNAL_%d" % sig)
    if code is None:
        return Outcome("T1", "RUNTIME_LOST")
    driver = _read_json(d / "driver-result.json")
    if isinstance(driver, dict) and driver.get("exit") == code:
        h = heavy.classify_driver_result(driver)
        if h.queue_state == "EVIDENCE_WRITTEN":
            res = _read_json(d / "result.json")
            return Outcome("SUCCESS") if isinstance(res, dict) else Outcome("D", "RESULT_MISSING")
        if h.queue_state == "WAITING_QUOTA":
            return Outcome("Q", h.code)
        if h.queue_state == "WAITING_PROVIDER":
            return Outcome("T3", h.code)
        if h.queue_state == "WAITING_CREDENTIAL":
            return Outcome("A", h.code)
        if h.queue_state == "WAITING_EXTERNAL":
            return Outcome("E", h.code)
        return Outcome("D", h.code)
    err = _read_json(d / "error.json")
    if isinstance(err, dict):
        k = err.get("class")
        if k in KINDS:
            return Outcome(k, str(err.get("code") or k), err.get("http_status"), err.get("retry_after_s"))
        if err.get("http_status"):
            o = outcome_from_http(int(err["http_status"]), err.get("retry_after_s"))
            return dataclasses.replace(o, code=str(err.get("code") or o.code))
        return Outcome("D", str(err.get("code") or "ERROR_UNCLASSIFIED"))
    if code == 0:
        res = _read_json(d / "result.json")
        if isinstance(res, dict) and res.get("schema") == "RQ_AGENT_RESULT_V1":
            return agentseam.map_result(res)  # Q3c: the agent's status decides the class; completion is the consumer's own re-validation
        return Outcome("SUCCESS") if isinstance(res, dict) else Outcome("D", "RESULT_MISSING")
    if code in (64, 65, 66):
        return Outcome("D", "EXIT_%d" % code)
    return Outcome("D", "EXIT_%d_UNSTRUCTURED" % code)


def _count_events(conn, task_id, reason):
    return conn.execute("select count(*) from event where task_id=? and reason_code=?", (task_id, reason)).fetchone()[0]


def _remediation(cfg, task, code, now):
    p = cfg.outbox_dir / ("remediation-%s.json" % task["task_id"])
    guard.check_write_path(p)
    p.write_text(json.dumps({"schema": "RQ_REMEDIATION_REQUEST_V1", "task_id": task["task_id"], "template_id": task["template_id"], "code": code,
                             "at": core.iso(now), "note": "deterministic failure; fix the template, prompt or validator, then admit a new version"}))


def _heavy_emit(cfg, task, outcome, now):
    adm = json.loads(task["admission_json"])["derived"]
    if not adm.get("heavy"):
        return
    task_dir = cfg.runs_dir / task["task_id"]
    task_dir.mkdir(parents=True, exist_ok=True)
    row = heavy.append_ledger(task_dir / "RUN_LEDGER.jsonl", {"actor": "rq-consumer", "at": core.iso(now), "attempt_no": task["attempt_no"],
                                                               "outcome": dataclasses.asdict(outcome)})
    p = cfg.outbox_dir / ("heavy-%s-%06d.json" % (task["task_id"], row["seq"]))
    guard.check_write_path(p)
    p.write_text(core.canonical({"schema": "HEAVY_ATTEMPT_RETURN_V1", "task_id": task["task_id"], "attempt_no": task["attempt_no"],
                                 "at": core.iso(now), "outcome": dataclasses.asdict(outcome), "ledger_hash": row["hash"]}))


def apply_outcome(conn, cfg, task_id, outcome, now, token=None):
    """Move the task out of RUNNING/CLAIMED according to the §3.7 class. Fencing: the caller's token (default: the row's current one)."""
    task = core.get_task(conn, task_id)
    token = token or task["lease_token"]
    adm = json.loads(task["admission_json"])["derived"]

    def go(state, reason, **kw):
        core.transition(conn, task_id, state, actor="rq-consumer", now=now, reason=reason, token=token, detail=kw.pop("detail", None), fields=kw.get("fields"))
        _heavy_emit(cfg, task, outcome, now)

    k = outcome.kind
    if k == "SUCCESS":
        go("EVIDENCE_WRITTEN", "SUCCESS")
    elif k == "T1":
        used = _count_events(conn, task_id, "T1_INTERRUPTED")
        if not adm["idempotent"] and not adm.get("recovery_argv"):
            go("BLOCKED_DETERMINISTIC", "NO_RECOVERY_PATH")
        elif adm.get("recovery_argv") and used >= adm.get("recovery_max", task["transient_budget"]):
            go("BLOCKED_DETERMINISTIC", "RECOVERY_EXHAUSTED")
        elif used >= task["transient_budget"]:
            go("BLOCKED_DETERMINISTIC", "T1_BUDGET_EXHAUSTED")
        else:
            go("READY", "T1_INTERRUPTED", fields={"not_before": core.iso(now + dt.timedelta(seconds=T1_BACKOFF_S))}, detail={"cause": outcome.code})
    elif k == "T2":
        go("BLOCKED_DETERMINISTIC", "RESOURCE_OOM")
        _remediation(cfg, task, "RESOURCE_OOM", now)
    elif k == "T3":
        tries = _count_events(conn, task_id, "T3_RETRY")
        if tries >= len(T3_BACKOFF_S):
            go("WAITING_PROVIDER", outcome.code or "PROVIDER")
        else:
            wait = max(T3_BACKOFF_S[tries], int(outcome.retry_after_s or 0))
            go("READY", "T3_RETRY", fields={"not_before": core.iso(now + dt.timedelta(seconds=wait))}, detail={"http_status": outcome.http_status, "wait_s": wait})
    elif k == "DEFER":  # the agent's off-peak refusal: try again later, no budget spent
        go("READY", "DEFER", fields={"not_before": core.iso(now + dt.timedelta(seconds=agentseam.DEFER_S))}, detail={"cause": outcome.code})
    elif k == "Q":
        go("WAITING_QUOTA", outcome.code or "QUOTA")
    elif k == "A":
        go("WAITING_CREDENTIAL", outcome.code or "CREDENTIAL")
    elif k == "E":
        if outcome.code in producer.EXTERNAL_CODES:
            if outcome.code == "GUARD_DISK_FLOOR" and _count_events(conn, task_id, "GUARD_DISK_FLOOR") >= 2:
                go("BLOCKED_DETERMINISTIC", "STOPPED_BY_GUARD_REPEATED")
                _remediation(cfg, task, "STOPPED_BY_GUARD_REPEATED", now)
            else:
                go("WAITING_EXTERNAL", outcome.code)
        else:
            go("BLOCKED_DETERMINISTIC", "EXTERNAL_CODE_UNKNOWN")
    elif k == "S":
        go("SAFETY_STOP", outcome.code or "SAFETY")
    else:
        go("BLOCKED_DETERMINISTIC", outcome.code or "D")
        _remediation(cfg, task, outcome.code, now)


# ---------------------------------------------------------------- receipts
def _outputs_sha(d):
    h = hashlib.sha256()
    files = [d / "result.json"] + sorted((d / "out").rglob("*") if (d / "out").is_dir() else [])
    for f in files:
        if f.is_file():
            h.update(str(f.relative_to(d)).encode() + b"\0" + hashlib.sha256(f.read_bytes()).hexdigest().encode() + b"\0")
    return h.hexdigest()


def _exe_version(argv0):
    if re.fullmatch(r"(python3?(\.\d+)?|node)", os.path.basename(argv0)):
        try:
            r = subprocess.run([argv0, "--version"], capture_output=True, text=True, timeout=5)
            return (r.stdout or r.stderr).strip()
        except (OSError, subprocess.SubprocessError):
            return None
    return None


def write_receipt(conn, cfg, task, attempt_no, d, argv, exit_info, env):
    pauses = [{"at": a, "reason": r} for a, r in conn.execute("select at, reason_code from event where task_id=? and to_state='PAUSED' order by seq", (task["task_id"],))]
    commit = None
    for cand in (pathlib.Path(__file__).resolve().parent.parent.parent.parent / "COMMIT",):
        if cand.exists():
            commit = cand.read_text().strip()
    rc = {"receipt": "RUN_RECEIPT_V1", "task_id": task["task_id"], "attempt_no": attempt_no, "executable": os.path.realpath(argv[0]) if argv else None,
          "executable_version": _exe_version(argv[0]) if argv else None, "commit": commit, "argv_sha256": core.sha256_hex(core.canonical(argv)),
          "home": env.get("HOME"), "cwd": str(d / "work"), "path_entries": (env.get("PATH") or "").split(os.pathsep),
          "env_allowlist": {k: ("<set>" if any(s in k.upper() for s in SECRET_NAME) else v) for k, v in sorted(env.items()) if k != "PYTHONPATH"},
          "secrets_present": {k: (k in env) for k in sorted(os.environ) if any(s in k.upper() for s in SECRET_NAME)},
          "mounts": [], "pauses": pauses, "exit": exit_info, "cgroup_peak": exit_info.get("usage"), "outputs_sha256": _outputs_sha(d)}
    p = d / "receipt.json"
    p.write_text(core.canonical(rc))
    return hashlib.sha256(p.read_bytes()).hexdigest()


# ---------------------------------------------------------------- tick
def _attempt_dir(cfg, task_id, n):
    return cfg.runs_dir / task_id / ("attempt-%d" % n)


def _attempt_argv(admission, attempt_dir, attempt_no):
    """Select heavy recovery from driver evidence; ordinary tasks retain counter recovery."""
    if admission.get("heavy"):
        resume = runtime.has_prior_driver_result(attempt_dir, attempt_no)
    else:
        resume = int(attempt_no) > 1
    return admission["recovery_argv"] if resume and admission.get("recovery_argv") else admission["argv"]


def _launch(conn, cfg, rt, claimed, now):
    task = core.get_task(conn, claimed["task_id"])
    adm = json.loads(task["admission_json"])["derived"]
    n = claimed["attempt_no"]
    d = _attempt_dir(cfg, task["task_id"], n)
    argv = _attempt_argv(adm, d, n)
    guard.check_write_path(d)
    if agentseam.needs_staging(task):
        try:
            agentseam.stage(cfg, task, d)
        except agentseam.SeamError as e:
            core.transition(conn, task["task_id"], "BLOCKED_DETERMINISTIC", actor="rq-consumer", now=now, reason=e.code, token=claimed["lease_token"], detail={"error": e.detail[:200]})
            return
    try:
        rt.start(cfg, d, argv, task["task_id"], n, task["weight_class"])
    except OSError as e:
        core.transition(conn, task["task_id"], "BLOCKED_DETERMINISTIC", actor="rq-consumer", now=now, reason="LAUNCH_FAILED", token=claimed["lease_token"], detail={"error": str(e)[:200]})
        return
    conn.execute("update attempt set runtime=?, started_at=? where task_id=? and attempt_no=?", (rt.name, core.iso(now), task["task_id"], n))
    core.transition(conn, task["task_id"], "RUNNING", actor="rq-consumer", now=now, token=claimed["lease_token"])


def _finalize(conn, cfg, task, d, st, now):
    n = task["attempt_no"]
    outcome = classify(d, st.exit)
    adm = json.loads(task["admission_json"])["derived"]
    argv = _attempt_argv(adm, d, n)
    env = {}
    try:
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG")}
        env.update({k: os.environ[k] for k in cfg.env_allowlist if k in os.environ and not any(s in k.upper() for s in SECRET_NAME)})
    except Exception:
        pass
    rsha = write_receipt(conn, cfg, task, n, d, argv, st.exit or {}, env)
    conn.execute("update attempt set ended_at=?, exit_code=?, exit_signal=?, error_code=?, receipt_sha256=? where task_id=? and attempt_no=?",
                 (core.iso(now), (st.exit or {}).get("exit_code"), (st.exit or {}).get("exit_signal"), outcome.code, rsha, task["task_id"], n))
    apply_outcome(conn, cfg, task["task_id"], outcome, now)


def tick(conn, cfg, rt, now, *, worker=None, sensors=None, blackouts=None):
    worker = worker or cfg.worker
    summary = {"claimed": [], "adopted": [], "requeued": [], "finished": []}
    status_mod.touch_consumer_heartbeat(cfg, now)
    if blackouts is None:
        try:
            blackouts = pause.load_blackouts(cfg.blackouts_path)
        except pause.BlackoutsUnusable:
            summary["refused"] = ["BLACKOUTS_FILE_UNUSABLE"]
            return summary
    cur = conn.execute("select * from task where state in ('CLAIMED','RUNNING')")
    cols = [c[0] for c in cur.description]
    for r in cur.fetchall():
        task = dict(zip(cols, r))
        tid, n = task["task_id"], task["attempt_no"]
        d = _attempt_dir(cfg, tid, n)
        st = rt.status(d)
        try:
            if st.exit is not None:
                try:
                    _finalize(conn, cfg, task, d, st, now)
                except (core.LeaseTokenStale, core.TransitionRefused):
                    raise
                except Exception as exc:
                    core.transition(conn, tid, "BLOCKED_DETERMINISTIC", actor="rq-consumer", now=now, reason="FINALIZE_ERROR",
                                    token=task["lease_token"], detail={"error": exc.__class__.__name__})
                summary["finished"].append(tid)
            elif core.parse_iso(task["lease_expires_at"]) <= now:
                if st.alive:
                    token = core.adopt(conn, tid, worker, now, cfg.lease_ttl_s)
                    if task["state"] == "CLAIMED":
                        core.transition(conn, tid, "RUNNING", actor="rq-consumer", now=now, token=token)
                    summary["adopted"].append(tid)
                elif not st.started:
                    core.release_claim(conn, tid, now)
                    summary["requeued"].append(tid)
                else:
                    apply_outcome(conn, cfg, tid, Outcome("T1", "RUNTIME_LOST"), now)
                    conn.execute("update attempt set ended_at=?, error_code='RUNTIME_LOST' where task_id=? and attempt_no=?", (core.iso(now), tid, n))
                    summary["requeued"].append(tid)
            elif task["lease_owner"] == worker:
                if task["state"] == "CLAIMED" and not st.started:
                    _launch(conn, cfg, rt, {"task_id": tid, "attempt_no": n, "lease_token": task["lease_token"]}, now)
                elif (now - core.parse_iso(task["heartbeat_at"])).total_seconds() >= cfg.heartbeat_s:
                    core.heartbeat(conn, tid, task["lease_token"], now, cfg.lease_ttl_s)
        except (core.LeaseTokenStale, core.TransitionRefused):
            continue  # another writer moved it first; its state is authoritative
    brakes = pause.evaluate_brakes(cfg.host, sensors, pause.load_state(cfg), now) if sensors is not None else {}

    def blocked(row):
        return pause.pause_reason(cfg.host, row, now, blackouts, brakes, claim=True, windows=cfg.apply_windows)

    while True:
        c = core.claim(conn, host=cfg.host, worker=worker, now=now, ttl=cfg.lease_ttl_s, blocked=blocked, bundle_dir=cfg.inbox_dir / "bundles")
        if c is None:
            break
        summary["claimed"].append(c["task_id"])
        _launch(conn, cfg, rt, c, now)
    return summary
