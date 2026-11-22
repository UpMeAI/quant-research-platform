"""RQ_STATUS_V1, alerts and the per-key month spend view (§3.8). Everything is derived from the database and the files; display only."""
import datetime as dt
import json
import pathlib
import sqlite3

from . import core, pause

STUCK_LEASE_S = 1800
READY_SLA_S = 24 * 3600
CONSUMER_DOWN_S = 15 * 60
ONCE_CODES = ("RQ_CREDENTIAL", "RQ_SAFETY_STOP", "RQ_BLOCKED_DETERMINISTIC")


def touch_consumer_heartbeat(cfg, now):
    (cfg.state_dir / "consumer.heartbeat").write_text(core.iso(now))


def month_spend(gateway_db, now):
    month = now.astimezone(core.CST).strftime("%Y-%m")
    if not gateway_db or not pathlib.Path(gateway_db).exists():
        return {"month": month, "keys": {}, "ledger": "ABSENT"}
    start = dt.datetime(now.year, now.month, 1, tzinfo=core.CST)
    end = dt.datetime(now.year + (now.month == 12), now.month % 12 + 1, 1, tzinfo=core.CST)
    c = sqlite3.connect("file:%s?mode=ro" % gateway_db, uri=True)
    try:
        rows = c.execute("select key_id, purpose, sum(cny), sum(usd), count(*) from call where at>=? and at<? group by key_id, purpose", (core.iso(start), core.iso(end))).fetchall()
    finally:
        c.close()
    keys = {}
    for k, p, cny, usd, n in rows:
        e = keys.setdefault(k, {"cny": 0.0, "usd": 0.0, "calls": 0, "by_purpose": {}})
        e["cny"] += cny or 0.0
        e["usd"] += usd or 0.0
        e["calls"] += n
        e["by_purpose"][p] = {"cny": cny or 0.0, "usd": usd or 0.0}
    return {"month": month, "keys": keys}


def _alerts(conn, cfg, now, counts):
    def ids(state):
        return [r[0] for r in conn.execute("select task_id from task where state=?", (state,))]

    out = []

    def add(code, pri, tasks=None, **kw):
        out.append(dict(code=code, priority=pri, dry_run=True, tasks=tasks or [], **kw))

    stuck = [r[0] for r in conn.execute("select task_id from task where state in ('CLAIMED','RUNNING') and lease_expires_at<?", (core.iso(now - dt.timedelta(seconds=STUCK_LEASE_S)),))]
    late = [r[0] for r in conn.execute("select task_id from task where state='READY' and updated_at<?", (core.iso(now - dt.timedelta(seconds=READY_SLA_S)),))]
    if stuck or late:
        add("RQ_STUCK", "P2", stuck + late, reasons={"lease_expired": stuck, "ready_sla": late})
    if counts.get("BLOCKED_DETERMINISTIC"):
        add("RQ_BLOCKED_DETERMINISTIC", "P2", ids("BLOCKED_DETERMINISTIC"))
    if counts.get("SAFETY_STOP"):
        add("RQ_SAFETY_STOP", "P1", ids("SAFETY_STOP"))
    if counts.get("WAITING_CREDENTIAL"):
        add("RQ_CREDENTIAL", "P1", ids("WAITING_CREDENTIAL"))
    if counts.get("CHECK_HOLD"):
        add("RQ_HOLD", "digest", ids("CHECK_HOLD"))
    hb = cfg.state_dir / "consumer.heartbeat"
    age = None
    if hb.exists():
        try:
            age = (now - core.parse_iso(hb.read_text().strip())).total_seconds()
        except ValueError:
            age = None
    if age is None or age > CONSUMER_DOWN_S:
        add("RQ_CONSUMER_DOWN", "P1", age_s=age, reason="NO_HEARTBEAT" if age is None else "STALE")
    return out


def build(conn, cfg, now):
    counts = dict(conn.execute("select state, count(*) from task group by state").fetchall())
    oldest = {s: int((now - core.parse_iso(m)).total_seconds()) for s, m in conn.execute("select state, min(updated_at) from task group by state")}
    ps = pause.load_state(cfg)
    hb = cfg.state_dir / "consumer.heartbeat"
    return {"schema": "RQ_STATUS_V1", "host": cfg.host, "at": core.iso(now), "counts": counts, "oldest_age_s": oldest,
            "sla_breaches": [r[0] for r in conn.execute("select task_id from task where state='READY' and updated_at<?", (core.iso(now - dt.timedelta(seconds=READY_SLA_S)),))],
            "consumer_heartbeat": hb.read_text().strip() if hb.exists() else None,
            "pauses": {"paused_tasks": counts.get("PAUSED", 0), "brakes": ps.get("brakes", {}), "pause_state_at": ps.get("at")},
            "circuits": core.open_circuits(conn, cfg.host, now), "event_head": core.chain_head(conn),
            "spend": month_spend(cfg.gateway_db, now), "alerts": _alerts(conn, cfg, now, counts)}


def write(conn, cfg, now):
    s = build(conn, cfg, now)
    tmp = cfg.status_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=1, sort_keys=True))
    tmp.replace(cfg.status_path)
    log = cfg.state_dir / "alerts.jsonl"
    seen = set()
    if log.exists():
        seen = {(j["code"], j["key"]) for j in map(json.loads, log.read_text().splitlines())}
    with open(log, "a") as f:
        for a in s["alerts"]:
            key = ",".join(sorted(a["tasks"]))
            if a["code"] in ONCE_CODES and (a["code"], key) not in seen:
                f.write(json.dumps({"code": a["code"], "priority": a["priority"], "key": key, "at": core.iso(now)}) + "\n")
    return s
