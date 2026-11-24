"""Agent seam (Q3c): the consumer stages an agent task's inputs, maps the agent's result.json onto outcome classes, and re-validates the result itself.

Authority: the agent (a container on Linux, the rq-agent user on HK) is untrusted data-producer. Its result.json is read as data; a task completes only when the
consumer's own short-lived node process (`cli.js validate`) says the result is valid. A `validator` block written by the agent is never read for these kinds.
Node and the agent code are read-only inputs; a missing node, a crash, a timeout or unparseable output is VALIDATOR_UNAVAILABLE (BLOCKED_DETERMINISTIC), never COMPLETE.
"""
import hashlib
import json
import os
import pathlib
import re
import subprocess


AGENT_KINDS = ("AI_REVIEW_CARD", "AI_CHECK", "AI_MECH_NOTE", "AI_MECH_REVIEW")
NODE_TIMEOUT_S = 120
WAIT_STATES = {"WAITING_CREDENTIAL": "A", "WAITING_QUOTA": "Q", "WAITING_EXTERNAL": "E"}
DEFER_S = 1800
RESULT_FIELD_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
MAX_RETRY_AFTER_S = 86400


class SeamError(Exception):
    def __init__(self, code, detail=""):
        super().__init__("%s %s" % (code, detail))
        self.code, self.detail = code, detail


def _outcome(kind, code=None, http_status=None, retry_after_s=None):
    from . import consumer  # late: consumer imports this module
    return consumer.Outcome(kind, code, http_status, retry_after_s)


def map_result(res):
    """RQ_AGENT_RESULT_V1.status -> consumer Outcome (queue-seam.js transitionFor, in the consumer's own classes)."""
    st = res.get("status") if isinstance(res, dict) else None
    if isinstance(res, dict) and "status" in res and (not isinstance(st, str) or not RESULT_FIELD_RE.fullmatch(st)):
        return _outcome("D", "RESULT_FIELD_INVALID")
    for name in ("reason_code", "wait_state"):
        value = res.get(name) if isinstance(res, dict) else None
        if isinstance(res, dict) and name in res and (not isinstance(value, str) or not RESULT_FIELD_RE.fullmatch(value)):
            return _outcome("D", "RESULT_FIELD_INVALID")
    reason = (res.get("reason_code") or None) if isinstance(res, dict) else None
    if st == "DONE":
        return _outcome("SUCCESS")
    if st == "WAITING":
        kind = WAIT_STATES.get(res.get("wait_state"))
        return _outcome(kind, reason or res.get("wait_state")) if kind else _outcome("D", "RESULT_WAIT_STATE_INVALID")
    if st == "RETRY":
        ra = res.get("retry_after_s")
        if ra is not None and (isinstance(ra, bool) or not isinstance(ra, int) or ra <= 0):
            return _outcome("D", "RESULT_FIELD_INVALID")
        return _outcome("T3", reason or "PROVIDER", None, min(ra, MAX_RETRY_AFTER_S) if ra is not None else None)
    if st == "DEFER":
        return _outcome("DEFER", reason or "DEFER")
    if st == "BLOCKED_DETERMINISTIC":
        return _outcome("D", reason or "BLOCKED_DETERMINISTIC")
    return _outcome("D", "RESULT_STATUS_INVALID")


def _node_env():
    return {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL") if k in os.environ}


def _cli(cfg):
    return str(cfg.agent_cli or pathlib.Path(__file__).resolve().parents[2] / "research-queue-agent" / "cli.js")


def _run(cfg, args, timeout=NODE_TIMEOUT_S):
    try:
        r = subprocess.run([cfg.node_bin, _cli(cfg)] + args, capture_output=True, text=True, timeout=timeout, env=_node_env())
    except (OSError, subprocess.SubprocessError) as e:
        raise SeamError("UNAVAILABLE", str(e)[:120])
    if r.returncode != 0:
        raise SeamError("UNAVAILABLE", "exit %d: %s" % (r.returncode, (r.stderr or "")[-200:]))
    return r.stdout


def needs_staging(task):
    """An agent-kind task that was admitted with its input file. One without an input has nothing to stage (its launcher refuses, exit 66)."""
    if task["kind"] not in AGENT_KINDS:
        return False
    return bool(json.loads(task["admission_json"])["request"].get("inputs"))


def needs_consumer_revalidation(task):
    """Agent-produced SELF_VALIDATED results are untrusted by default, including future/unlisted agent kinds."""
    kind = task.get("kind") or ""
    return kind in AGENT_KINDS or kind.startswith("AI_") or task.get("agent_host") != task.get("host")


def stage(cfg, task, attempt_dir):
    """Write attempt_dir/in/{task.json,bundle.json} from the admitted task (re-hashing its input file first). Raises SeamError(code)."""
    adm = json.loads(task["admission_json"])
    inputs = adm["request"].get("inputs") or []
    if len(inputs) != 1:
        raise SeamError("STAGE_INPUT_COUNT", str(len(inputs)))
    f = pathlib.Path(inputs[0]["path"])
    try:
        raw = f.read_bytes()
    except OSError:
        raise SeamError("STAGE_INPUT_MISSING")
    if hashlib.sha256(raw).hexdigest() != inputs[0]["sha256"]:
        raise SeamError("STAGE_INPUT_SHA_MISMATCH")
    row = {k: task[k] for k in ("task_id", "host", "agent_host", "kind", "market", "template_id", "template_sha256")}
    row["attempt_no"] = task["attempt_no"]
    try:
        _run(cfg, ["stage", "--row-json", json.dumps(row), "--input", str(f), "--out", str(pathlib.Path(attempt_dir) / "in")])
    except SeamError as e:
        raise SeamError("STAGE_UNAVAILABLE", e.detail)


def revalidate(cfg, task_id, attempt_dir):
    """The consumer's own validation of result.json. Returns {ok, codes, output_sha256}; raises SeamError('UNAVAILABLE') on any crash."""
    d = pathlib.Path(attempt_dir)
    out = _run(cfg, ["validate", "--task", str(d / "in" / "task.json"), "--bundle", str(d / "in" / "bundle.json"), "--result", str(d / "result.json")])
    try:
        v = json.loads(out)
    except ValueError:
        raise SeamError("UNAVAILABLE", "unparseable validator output")
    if not isinstance(v, dict) or not isinstance(v.get("ok"), bool) or not isinstance(v.get("codes"), list):
        raise SeamError("UNAVAILABLE", "validator output shape")
    return v
