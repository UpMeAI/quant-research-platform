"""rq-complete: the only writer of COMPLETE (declared completion authority). Q1 covers SELF_VALIDATED templates (cards, checks, prereg drafts),
which end on their own deterministic validators. Gate + check completion (RUN_GATE_V1, HOLD re-checks) is a later PR."""
import json
import pathlib

from . import agentseam, core, heavy_accept, validated_return


def complete_self_validated(conn, cfg, task_id, now):
    task = core.get_task(conn, task_id)
    if task["state"] != "EVIDENCE_WRITTEN":
        return task["state"]
    adm = json.loads(task["admission_json"])["derived"]
    if adm["completion"] != "SELF_VALIDATED":
        return task["state"]
    if agentseam.needs_consumer_revalidation(task):
        return _complete_agent(conn, cfg, task, now)
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


def _complete_agent(conn, cfg, task, now):
    """Agent kinds: COMPLETE only on the consumer's own re-validation of result.json. The agent's `validator` block is never read."""
    task_id = task["task_id"]
    d = cfg.runs_dir / task_id / ("attempt-%d" % task["attempt_no"])
    try:
        v = agentseam.revalidate(cfg, task_id, d)
    except agentseam.SeamError as e:
        core.transition(conn, task_id, "BLOCKED_DETERMINISTIC", actor="rq-complete", now=now, reason="VALIDATOR_UNAVAILABLE", detail={"error": e.detail[:200]})
        return core.get_task(conn, task_id)["state"]
    if v["ok"] is True:
        published = None
        if task["kind"] == "AI_REVIEW_CARD":  # RQ_VALIDATED_RETURN_V1 carries cards/ideas; checks and mechanism records keep their own consumers
            try:
                published = validated_return.publish(cfg, task, d, v)
            except validated_return.ReturnError as e:
                core.transition(conn, task_id, "BLOCKED_DETERMINISTIC", actor="rq-complete", now=now, reason=e.code, detail={"error": e.detail[:200]})
                return core.get_task(conn, task_id)["state"]
        detail = {"output_sha256": v.get("output_sha256")}
        if published is not None:
            detail["bundle_sha256"] = published["bundle_sha256"]
        core.transition(conn, task_id, "COMPLETE", actor="rq-complete", now=now, reason="SELF_VALIDATED",
                        detail=detail)
    else:
        core.transition(conn, task_id, "BLOCKED_DETERMINISTIC", actor="rq-complete", now=now, reason="VALIDATOR_NOT_OK", detail={"codes": [str(c)[:80] for c in v["codes"]][:20]})
    return core.get_task(conn, task_id)["state"]


def tick(conn, cfg, now):
    ids = [r[0] for r in conn.execute("select task_id from task where state='EVIDENCE_WRITTEN'")]
    completed = []
    for task_id in ids:
        task = core.get_task(conn, task_id)
        derived = json.loads(task["admission_json"])["derived"]
        if derived["completion"] == "HEAVY_MATRIX":
            result = heavy_accept.complete_task(conn, cfg, task_id, now)
            if result["result"] == "DONE_ACCEPTED":
                core.transition(conn, task_id, "COMPLETE", actor="rq-complete", now=now, reason="HEAVY_ACCEPTED")
            elif result["result"] == "DONE_REFUSED":
                core.transition(conn, task_id, "GATE_FAIL", actor="rq-complete", now=now, reason=result["reason"])
            else:
                core.transition(conn, task_id, "BLOCKED_DETERMINISTIC", actor="rq-complete", now=now, reason=result["reason"])
            state = core.get_task(conn, task_id)["state"]
        else:
            state = complete_self_validated(conn, cfg, task_id, now)
        if state == "COMPLETE":
            completed.append(task_id)
    return completed
