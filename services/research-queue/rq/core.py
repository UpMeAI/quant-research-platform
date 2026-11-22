"""Queue core: connection, schema, state machine, event hash chain, atomic claim, lease, circuits.

Every state change and its event row are written in one transaction. Task processes never write the database.
All times are CST (+08:00) strings; callers pass `now` explicitly so behaviour is deterministic.
"""
import contextlib
import datetime as dt
import hashlib
import json
import pathlib
import re
import sqlite3
import uuid

CST = dt.timezone(dt.timedelta(hours=8))
GENESIS = "0" * 64
SCHEMA_PATH = pathlib.Path(__file__).with_name("schema.sql")

STATES = (
    "PROPOSED", "ADMITTED", "READY", "CLAIMED", "RUNNING", "PAUSED", "EVIDENCE_WRITTEN", "GATE_PASS", "GATE_FAIL",
    "CHECK_PENDING", "CHECK_CONSISTENT", "CHECK_HOLD", "COMPLETE",
    "REFUSED_ADMISSION", "WAITING_FREEZE", "WAITING_EXTERNAL", "WAITING_QUOTA", "WAITING_PROVIDER", "WAITING_CREDENTIAL",
    "WAITING_VERDICT_READING", "BLOCKED_DETERMINISTIC", "SAFETY_STOP", "CANCELLED",
)
LEASE_STATES = ("CLAIMED", "RUNNING", "PAUSED")
WAITING = ("WAITING_FREEZE", "WAITING_EXTERNAL", "WAITING_QUOTA", "WAITING_PROVIDER", "WAITING_CREDENTIAL", "WAITING_VERDICT_READING")
ACTORS = ("rq-producer", "rq-consumer", "rq-pause", "rq-complete", "rq-gate", "coordinator")

_OUT = ("BLOCKED_DETERMINISTIC", "SAFETY_STOP", "CANCELLED") + WAITING
TRANSITIONS = {
    "PROPOSED": ("ADMITTED", "REFUSED_ADMISSION", "WAITING_FREEZE"),
    "ADMITTED": ("READY", "CANCELLED") + WAITING,
    "READY": ("CLAIMED", "CANCELLED") + WAITING + ("BLOCKED_DETERMINISTIC",),
    "CLAIMED": ("RUNNING", "READY") + _OUT,
    "RUNNING": ("PAUSED", "EVIDENCE_WRITTEN", "READY") + _OUT,
    "PAUSED": ("RUNNING", "READY", "SAFETY_STOP", "CANCELLED"),
    "EVIDENCE_WRITTEN": ("GATE_PASS", "GATE_FAIL", "COMPLETE", "BLOCKED_DETERMINISTIC", "CANCELLED") + WAITING,
    "GATE_PASS": ("CHECK_PENDING", "COMPLETE", "CANCELLED"),
    "GATE_FAIL": ("CANCELLED",),
    "CHECK_PENDING": ("CHECK_CONSISTENT", "CHECK_HOLD", "COMPLETE", "GATE_FAIL", "CANCELLED") + WAITING,
    "CHECK_CONSISTENT": ("COMPLETE", "CANCELLED"),
    "CHECK_HOLD": ("COMPLETE", "GATE_FAIL", "CANCELLED"),
    "WAITING_FREEZE": ("CANCELLED",),
    "WAITING_EXTERNAL": ("READY", "CANCELLED", "BLOCKED_DETERMINISTIC"),
    "WAITING_QUOTA": ("READY", "CANCELLED", "BLOCKED_DETERMINISTIC"),
    "WAITING_PROVIDER": ("READY", "CANCELLED", "BLOCKED_DETERMINISTIC"),
    "WAITING_CREDENTIAL": ("READY", "CANCELLED", "BLOCKED_DETERMINISTIC"),
    "WAITING_VERDICT_READING": ("COMPLETE", "CANCELLED"),
    "BLOCKED_DETERMINISTIC": ("CANCELLED",),
    "SAFETY_STOP": ("READY", "CANCELLED"),
}
TERMINAL = ("COMPLETE", "REFUSED_ADMISSION", "CANCELLED")
SETTABLE = {"not_before", "lease_expires_at", "heartbeat_at", "lease_owner", "lease_token", "priority"}


class SchemaMismatch(Exception):
    pass


class LeaseTokenStale(Exception):
    pass


class TransitionRefused(Exception):
    pass


# ---------------------------------------------------------------- time and hashing
def now_cst():
    return dt.datetime.now(CST)


def iso(t):
    return t.astimezone(CST).isoformat(timespec="seconds")


def parse_iso(s):
    return dt.datetime.fromisoformat(s).astimezone(CST)


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(s):
    return hashlib.sha256(s.encode() if isinstance(s, str) else s).hexdigest()


# ---------------------------------------------------------------- connection and schema
def connect(path):
    conn = sqlite3.connect(str(path), timeout=30, isolation_level=None)
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    return conn


@contextlib.contextmanager
def _txn(conn):
    """BEGIN IMMEDIATE unless the caller already holds a transaction."""
    if conn.in_transaction:
        yield
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def schema_sha256():
    return hashlib.sha256(SCHEMA_PATH.read_bytes()).hexdigest()


def _norm_sql(s):
    return re.sub(r"\s+", " ", re.sub(r"--[^\n]*", "", s or "")).strip()


def schema_fingerprint(conn):
    rows = conn.execute("select type, name, sql from sqlite_master where name not like 'sqlite_%' and sql is not null order by type, name").fetchall()
    return sha256_hex(canonical([[t, n, _norm_sql(s)] for t, n, s in rows]))


def _expected_fingerprint():
    mem = sqlite3.connect(":memory:")
    mem.executescript(SCHEMA_PATH.read_text())
    fp = schema_fingerprint(mem)
    mem.close()
    return fp


def migrate(conn):
    """Create the frozen schema in an empty database; refuse any database whose schema differs from it."""
    n = conn.execute("select count(*) from sqlite_master where name not like 'sqlite_%'").fetchone()[0]
    if n == 0:
        conn.executescript("BEGIN IMMEDIATE;" + SCHEMA_PATH.read_text() + "COMMIT;")
    if schema_fingerprint(conn) != _expected_fingerprint():
        raise SchemaMismatch("database schema differs from schema.sql sha256 " + schema_sha256())
    if conn.execute("pragma integrity_check").fetchone()[0] != "ok":
        raise SchemaMismatch("integrity_check failed")


# ---------------------------------------------------------------- events (hash chain)
def insert_event(conn, task_id, at, actor, from_state, to_state, reason_code, detail):
    with _txn(conn):
        prev = conn.execute("select hash from event order by seq desc limit 1").fetchone()
        prev_hash = prev[0] if prev else GENESIS
        detail_json = canonical(detail or {})
        at_s = at if isinstance(at, str) else iso(at)
        h = sha256_hex(canonical([task_id, at_s, actor, from_state, to_state, reason_code, detail_json, prev_hash]))
        conn.execute("insert into event (task_id, at, actor, from_state, to_state, reason_code, detail_json, prev_hash, hash) values (?,?,?,?,?,?,?,?,?)",
                     (task_id, at_s, actor, from_state, to_state, reason_code, detail_json, prev_hash, h))


def verify_chain(conn):
    prev = GENESIS
    for seq, task_id, at, actor, fs, ts, rc, dj, ph, h in conn.execute(
            "select seq, task_id, at, actor, from_state, to_state, reason_code, detail_json, prev_hash, hash from event order by seq"):
        if ph != prev or sha256_hex(canonical([task_id, at, actor, fs, ts, rc, dj, ph])) != h:
            return False, seq
        prev = h
    return True, None


def chain_head(conn):
    r = conn.execute("select seq, hash from event order by seq desc limit 1").fetchone()
    return {"seq": r[0], "hash": r[1]} if r else {"seq": 0, "hash": GENESIS}


# ---------------------------------------------------------------- tasks
def insert_task(conn, row, now, actor="rq-producer"):
    """Insert a task idempotently. row: dict with the task columns (state is READY or REFUSED_ADMISSION). Returns True if created."""
    cols = ("task_id", "idem_key", "host", "agent_host", "kind", "market", "template_id", "template_sha256", "evidence_matrix_sha256",
            "admission_json", "admission_sha256", "weight_class", "io_class", "depends_on", "state", "state_reason", "not_before",
            "transient_budget", "priority")
    with _txn(conn):
        vals = [row[c] for c in cols]
        cur = conn.execute("insert into task (%s, attempt_no, created_at, updated_at, row_version) values (%s, 0, ?, ?, 0) on conflict(idem_key) do nothing"
                           % (",".join(cols), ",".join("?" * len(cols))), vals + [iso(now), iso(now)])
        if cur.rowcount != 1:
            return False
        tid = row["task_id"]
        if row["state"] == "REFUSED_ADMISSION":
            insert_event(conn, tid, now, actor, None, "PROPOSED", "PROPOSED", {})
            insert_event(conn, tid, now, actor, "PROPOSED", "REFUSED_ADMISSION", row["state_reason"], {})
        else:
            insert_event(conn, tid, now, actor, None, "PROPOSED", "PROPOSED", {})
            insert_event(conn, tid, now, actor, "PROPOSED", "ADMITTED", "ADMITTED", {})
            insert_event(conn, tid, now, actor, "ADMITTED", row["state"], "READY", {})
        return True


def get_task(conn, task_id):
    cur = conn.execute("select * from task where task_id=?", (task_id,))
    r = cur.fetchone()
    return dict(zip([d[0] for d in cur.description], r)) if r else None


def transition(conn, task_id, to_state, *, actor, now, reason=None, token=None, detail=None, fields=None):
    """Move a task. Refuses unknown edges, non-authoritative actors and stale lease tokens; writes the event in the same transaction."""
    with _txn(conn):
        row = get_task(conn, task_id)
        if row is None:
            raise TransitionRefused("no such task " + task_id)
        frm = row["state"]
        if actor not in ACTORS:
            raise TransitionRefused("unknown actor " + str(actor))
        if to_state not in TRANSITIONS.get(frm, ()):
            raise TransitionRefused("%s -> %s is not a transition" % (frm, to_state))
        if to_state == "COMPLETE" and actor != "rq-complete":
            raise TransitionRefused("only rq-complete writes COMPLETE")
        if to_state == "CANCELLED" and actor != "coordinator":
            raise TransitionRefused("only the coordinator cancels")
        if frm == "SAFETY_STOP" and actor != "coordinator":
            raise TransitionRefused("only the coordinator clears SAFETY_STOP")
        if frm in LEASE_STATES and (actor == "rq-consumer" or token is not None):
            if token is None or token != row["lease_token"]:
                raise LeaseTokenStale("stale lease token for " + task_id)
        sets = {"state": to_state, "state_reason": reason, "updated_at": iso(now), "row_version": row["row_version"] + 1}
        if to_state not in LEASE_STATES:
            sets.update(lease_owner=None, lease_token=None, lease_expires_at=None, heartbeat_at=None)
        for k, v in (fields or {}).items():
            if k not in SETTABLE:
                raise TransitionRefused("field not settable: " + k)
            sets[k] = v
        if to_state in ("READY",) and "not_before" not in (fields or {}):
            sets["not_before"] = None
        conn.execute("update task set %s where task_id=?" % ", ".join("%s=?" % k for k in sets), list(sets.values()) + [task_id])
        insert_event(conn, task_id, now, actor, frm, to_state, reason, detail)


def heartbeat(conn, task_id, token, now, ttl):
    with _txn(conn):
        row = get_task(conn, task_id)
        if row is None or row["state"] not in LEASE_STATES or row["lease_token"] != token:
            raise LeaseTokenStale("stale lease token for " + task_id)
        conn.execute("update task set lease_expires_at=?, heartbeat_at=? where task_id=?",
                     (iso(now + dt.timedelta(seconds=ttl)), iso(now), task_id))


def extend_lease(conn, task_id, now, ttl):
    """Used by the pause controller (it holds no token): keep a PAUSED task's lease alive."""
    conn.execute("update task set lease_expires_at=?, heartbeat_at=? where task_id=? and state in ('CLAIMED','RUNNING','PAUSED')",
                 (iso(now + dt.timedelta(seconds=ttl)), iso(now), task_id))


def adopt(conn, task_id, worker, now, ttl):
    """A new consumer takes over a task whose lease expired but whose runtime is alive: same attempt, rotated token."""
    with _txn(conn):
        row = get_task(conn, task_id)
        token = uuid.uuid4().hex
        conn.execute("update task set lease_owner=?, lease_token=?, lease_expires_at=?, heartbeat_at=?, row_version=row_version+1, updated_at=? where task_id=?",
                     (worker, token, iso(now + dt.timedelta(seconds=ttl)), iso(now), iso(now), task_id))
        insert_event(conn, task_id, now, "rq-consumer", row["state"], row["state"], "ADOPTED", {"worker": worker, "attempt_no": row["attempt_no"]})
        return token


def release_claim(conn, task_id, now, reason="CLAIM_EXPIRED"):
    """A claim whose runtime never started goes back to READY and the attempt is not counted."""
    with _txn(conn):
        row = get_task(conn, task_id)
        conn.execute("delete from attempt where task_id=? and attempt_no=?", (task_id, row["attempt_no"]))
        conn.execute("update task set attempt_no=attempt_no-1 where task_id=?", (task_id,))
        transition(conn, task_id, "READY", actor="rq-consumer", now=now, reason=reason, token=row["lease_token"])


def unit_name(task_id, attempt_no):
    return "rq-task-%s-a%d" % (task_id, attempt_no)


# ---------------------------------------------------------------- bundles and dependencies
def verify_bundle(bundle_dir, dep):
    """A cross-host dependency {host, task_id, bundle_sha256} is satisfied only by a relayed bundle file with that sha."""
    if bundle_dir is None:
        return False
    host, tid, want = dep.get("host"), dep.get("task_id"), dep.get("bundle_sha256")
    if not (isinstance(host, str) and isinstance(tid, str) and re.fullmatch(r"[A-Za-z0-9._-]+", tid) and re.fullmatch(r"[A-Z]+", host)):
        return False
    p = pathlib.Path(bundle_dir) / ("%s-%s.json" % (host, tid))
    return p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest() == want


def _deps_ok(conn, depends_on, bundle_dir):
    for d in json.loads(depends_on or "[]"):
        if isinstance(d, dict):
            if not verify_bundle(bundle_dir, d):
                return False
        else:
            r = conn.execute("select state from task where task_id=?", (d,)).fetchone()
            if not r or r[0] != "COMPLETE":
                return False
    return True


def slot_class(row):
    if row["weight_class"] == "NET":
        return "NET"
    if row["weight_class"] == "W2" or row["io_class"] == "LANE1_DB":
        return "HEAVY"
    return "LIGHT"


# ---------------------------------------------------------------- circuits
def reset_circuit(conn, template_id, *, actor, now):
    if actor != "coordinator":
        raise TransitionRefused("only the coordinator resets a circuit")
    insert_event(conn, "CIRCUIT:" + template_id, now, actor, None, "CIRCUIT_RESET", "CIRCUIT_RESET", {})


def open_circuits(conn, host, now):
    """Template circuit: the same D code twice since the last reset. Host circuit: any SAFETY_STOP, or 3 T1 interruptions within an hour."""
    resets = dict(conn.execute("select substr(task_id, 9), max(seq) from event where to_state='CIRCUIT_RESET' group by task_id").fetchall())
    counts = {}
    for tpl, code, seq in conn.execute("select t.template_id, e.reason_code, e.seq from event e join task t on t.task_id=e.task_id where e.to_state='BLOCKED_DETERMINISTIC'"):
        if seq > resets.get(tpl, 0):
            counts[(tpl, code)] = counts.get((tpl, code), 0) + 1
    templates = {tpl: code for (tpl, code), n in counts.items() if n >= 2}
    reason = None
    r = conn.execute("select task_id from task where state='SAFETY_STOP' limit 1").fetchone()
    if r:
        reason = "SAFETY_STOP:" + r[0]
    else:
        since = iso(now - dt.timedelta(hours=1))
        n = conn.execute("select count(*) from event where reason_code='T1_INTERRUPTED' and at>=? and at<=?", (since, iso(now))).fetchone()[0]
        if n >= 3:
            reason = "T1_BURST:%d" % n
    return {"templates": templates, "host": reason}


# ---------------------------------------------------------------- claim
def claim(conn, *, host, worker, now, ttl=600, slots=True, blocked=None, bundle_dir=None):
    """Atomically claim the best READY task for this host (BEGIN IMMEDIATE). NET tasks are claimed on their agent_host.
    Returns {task_id, lease_token, attempt_no, unit} or None. `blocked(row) -> reason|None` lets the caller veto a task (windows, brakes)."""
    with _txn(conn):
        circuits = open_circuits(conn, host, now)
        if circuits["host"]:
            return None
        cur = conn.execute("select * from task where state in ('CLAIMED','RUNNING','PAUSED')")
        cols = [d[0] for d in cur.description]
        occupied = {slot_class(dict(zip(cols, r))) for r in cur.fetchall()}
        cur = conn.execute(
            "select * from task where state='READY' and ((weight_class!='NET' and host=?) or (weight_class='NET' and agent_host=?))"
            " and (not_before is null or not_before<=?) order by priority, created_at, task_id", (host, host, iso(now)))
        cols = [d[0] for d in cur.description]
        for r in cur.fetchall():
            row = dict(zip(cols, r))
            if row["template_id"] in circuits["templates"]:
                continue
            if host == "HK" and row["weight_class"] != "NET":
                continue
            if slots and slot_class(row) in occupied:
                continue
            if blocked is not None and blocked(row):
                continue
            if not _deps_ok(conn, row["depends_on"], bundle_dir):
                continue
            token = uuid.uuid4().hex
            n = row["attempt_no"] + 1
            upd = conn.execute(
                "update task set state='CLAIMED', lease_owner=?, lease_token=?, lease_expires_at=?, heartbeat_at=?, attempt_no=?, row_version=row_version+1, updated_at=?"
                " where task_id=? and state='READY'", (worker, token, iso(now + dt.timedelta(seconds=ttl)), iso(now), n, iso(now), row["task_id"]))
            if upd.rowcount != 1:
                continue
            unit = unit_name(row["task_id"], n)
            conn.execute("insert into attempt (task_id, attempt_no, lease_token, unit_or_container) values (?,?,?,?)", (row["task_id"], n, token, unit))
            insert_event(conn, row["task_id"], now, "rq-consumer", "READY", "CLAIMED", "CLAIMED", {"worker": worker, "attempt_no": n})
            return {"task_id": row["task_id"], "lease_token": token, "attempt_no": n, "unit": unit}
        return None
