"""rq-complete: the only writer of COMPLETE (declared completion authority). Q1 covers SELF_VALIDATED templates (cards, checks, prereg drafts),
which end on their own deterministic validators. Gate + check completion (RUN_GATE_V1, HOLD re-checks) is a later PR."""
import json
import pathlib

from . import core


def complete_self_validated(conn, cfg, task_id, now):
    task = core.get_task(conn, task_id)
    if task["state"] != "EVIDENCE_WRITTEN":
        return task["state"]
    adm = json.loads(task["admission_json"])["derived"]
    if adm["completion"] != "SELF_VALIDATED":
        return task["state"]
    p = cfg.runs_dir / task_id / ("attempt-%d" % task["attempt_no"]) / "result.json"
    try:
        v = json.loads(p.read_text()).get("validator") or {}
    except (OSError, ValueError, AttributeError):
        v = {}
    if v.get("ok") is True and v.get("sha256"):
        core.transition(conn, task_id, "COMPLETE", actor="rq-complete", now=now, reason="SELF_VALIDATED")
    else:
        core.transition(conn, task_id, "BLOCKED_DETERMINISTIC", actor="rq-complete", now=now, reason="VALIDATOR_NOT_OK")
    return core.get_task(conn, task_id)["state"]


def tick(conn, cfg, now):
    ids = [r[0] for r in conn.execute("select task_id from task where state='EVIDENCE_WRITTEN'")]
    return [t for t in ids if complete_self_validated(conn, cfg, t, now) == "COMPLETE"]
