"""Whitelisted source readers for PROGRESS_REGISTRY_V1."""

from __future__ import annotations

import datetime as dt
import glob
import hashlib
import json
import os
from pathlib import Path

from . import guard

MAX_BYTES = 64 * 1024 * 1024
TERMINAL_STATES = {
    "CLOSED", "FAILED_RESCORE", "FAILED_PARTIAL", "VERDICT_SEALED", "SEALED",
    "ABORTED", "SKIPPED_NO_VERDICT", "B_SEALED", "VERDICT_WITHDRAWN",
}
WORST = {"UNKNOWN": 6, "MISSING": 5, "STALE": 4, "OK": 3, "ZERO": 2, "NOT_APPLICABLE": 1}


class SourceError(Exception):
    def __init__(self, reason, source=None):
        super().__init__(reason)
        self.reason = reason
        self.source = source or {"path": None, "sha256": None, "bytes": None, "mtime": None}


def parse_time(value):
    if not isinstance(value, str) or not value:
        raise ValueError("AS_OF_MISSING")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso(value):
    return value.isoformat(timespec="seconds")


def _meta(path: Path, raw=None, owner_program=None):
    try:
        stat = path.stat()
    except OSError:
        stat = None
    return {
        "path": str(path),
        "owner_program": owner_program,
        "sha256": hashlib.sha256(raw).hexdigest() if raw is not None else None,
        "bytes": len(raw) if raw is not None else None,
        "mtime": dt.datetime.fromtimestamp(stat.st_mtime, dt.timezone.utc).isoformat() if stat else None,
    }


def _path(path, cfg, owner_program=None):
    allowed = cfg.get("allowed_read_prefixes", ())
    try:
        return guard.require_readable_path(path, allowed_prefixes=allowed)
    except guard.PathForbidden as exc:
        raise SourceError("PATH_FORBIDDEN", _meta(Path(os.fspath(path)), owner_program=owner_program)) from exc


def read_bytes(path, cfg, owner_program=None):
    source = _path(path, cfg, owner_program)
    try:
        size = source.stat().st_size
        if size > MAX_BYTES:
            raise SourceError("TOO_LARGE", _meta(source, owner_program=owner_program))
        raw = source.read_bytes()
    except FileNotFoundError as exc:
        raise SourceError("FILE_ABSENT", _meta(source, owner_program=owner_program)) from exc
    except PermissionError as exc:
        raise SourceError("PERMISSION_DENIED", _meta(source, owner_program=owner_program)) from exc
    except SourceError:
        raise
    except OSError as exc:
        raise SourceError("PERMISSION_DENIED", _meta(source, owner_program=owner_program)) from exc
    return raw, _meta(source, raw, owner_program)


def read_json(path, cfg, owner_program=None):
    raw, meta = read_bytes(path, cfg, owner_program)
    try:
        return json.loads(raw), meta, raw
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceError("PARSE_ERROR", meta) from exc


def read_jsonl(path, cfg, owner_program=None):
    raw, meta = read_bytes(path, cfg, owner_program)
    if not raw:
        return [], meta, raw
    rows = []
    try:
        for line in raw.decode("utf-8").splitlines():
            if line.strip():
                item = json.loads(line)
                if not isinstance(item, dict):
                    raise ValueError("not object")
                rows.append(item)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise SourceError("PARSE_ERROR", meta) from exc
    return rows, meta, raw


def _due_missing(exc, due_at, now, *, key, title, max_age_h=None):
    if exc.reason == "FILE_ABSENT" and due_at:
        try:
            if now < parse_time(due_at):
                return section(key, title, "NOT_APPLICABLE", "NOT_YET_DUE", [exc.source], None, None, max_age_h, due_at)
        except ValueError:
            pass
    state = "MISSING" if exc.reason == "FILE_ABSENT" else "UNKNOWN"
    return section(key, title, state, exc.reason, [exc.source], None, None, max_age_h, due_at)


def section(key, title, state, reason, sources, data, as_of=None, max_age_h=None, due_at=None, age_h=None):
    return {
        "key": key, "title_zh": title, "state": state, "reason": reason,
        "sources": sources, "as_of": as_of,
        "freshness": {"max_age_h": max_age_h, "age_h": age_h, "due_at": due_at},
        "data": data,
    }


def _fresh_state(as_of, max_age_h, now):
    try:
        stamp = parse_time(as_of)
    except ValueError:
        return "UNKNOWN", "AS_OF_MISSING", None
    if stamp > now + dt.timedelta(minutes=10):
        return "UNKNOWN", "AS_OF_IN_FUTURE", None
    age = (now - stamp).total_seconds() / 3600
    if max_age_h is not None and age > float(max_age_h):
        return "STALE", "STALE_SOURCE", age
    return "OK", None, age


def read_s1(spec, cfg, now):
    key, title = "S1_JOBS", "运行态作业心跳"
    jobs, metas, states = [], [], []
    for job in spec.get("jobs", []):
        try:
            if Path(str(job.get("status_path", ""))).suffix != ".json":
                raise SourceError("PATH_FORBIDDEN", {"path": str(job.get("status_path")), "owner_program": job.get("name"), "sha256": None, "bytes": None, "mtime": None})
            value, meta, _ = read_json(job.get("status_path"), cfg, job.get("name"))
            metas.append(meta)
            as_of = value.get("lastOkAt")
            state, reason, age = _fresh_state(as_of, job.get("max_age_h"), now)
            counts = {str(k): v for k, v in list((value.get("counts") or {}).items())[:20] if isinstance(v, (int, float)) and not isinstance(v, bool)}
            data = {"name": job.get("name"), "lastOkAt": as_of, "rc": value.get("rc"), "counts": counts}
        except SourceError as exc:
            metas.append(exc.source)
            due = job.get("due_at")
            state = "NOT_APPLICABLE" if exc.reason == "FILE_ABSENT" and due and now < parse_time(due) else ("MISSING" if exc.reason == "FILE_ABSENT" else "UNKNOWN")
            reason = "NOT_YET_DUE" if state == "NOT_APPLICABLE" else exc.reason
            age, data = None, None
        states.append({"name": job.get("name"), "state": state, "reason": reason, "data": data, "age_h": age})
        if data is not None:
            jobs.append(data)
    if not spec.get("jobs"):
        return section(key, title, "ZERO", None, [], {"jobs": [], "sources_state": []})
    overall = max(states, key=lambda row: WORST[row["state"]])["state"]
    reason = next((x["reason"] for x in states if x["state"] == overall and x["reason"]), None)
    data = {"jobs": jobs, "sources_state": [{k: row[k] for k in ("name", "state", "reason")} for row in states]}
    if overall in {"MISSING", "UNKNOWN", "NOT_APPLICABLE"} and not jobs:
        data = None
    return section(key, title, overall, reason, metas, data)


def read_s2(spec, cfg, now):
    key, title = "S2_AQ_LINUX", "自主研究队列（Linux）"
    try:
        value, meta, _ = read_json(spec.get("path"), cfg, "research-queue rq/status.py")
        if value.get("schema") != "RQ_STATUS_V1":
            raise SourceError("SCHEMA_MISMATCH", meta)
        state, reason, age = _fresh_state(value.get("at"), spec.get("max_age_h", 1), now)
        if state == "UNKNOWN":
            return section(key, title, state, reason, [meta], None, None, spec.get("max_age_h", 1), spec.get("due_at"))
        by_purpose = {}
        spend = value.get("spend") if isinstance(value.get("spend"), dict) else {}
        for key_data in (spend.get("keys") or {}).values():
            for purpose, facts in (key_data.get("by_purpose") or {}).items():
                out = by_purpose.setdefault(purpose, {"cny": 0.0, "calls": 0})
                out["cny"] += facts.get("cny", 0) or 0
                out["calls"] += facts.get("calls", 0) or 0
        alerts = []
        for alert in value.get("alerts", []):
            alerts.append({"code": alert.get("code"), "priority": alert.get("priority"), "dry_run": alert.get("dry_run"), "tasks_count": len(alert.get("tasks") or [])})
        breaches = list(value.get("sla_breaches") or [])
        data = {
            "at": value.get("at"), "counts": value.get("counts") or {},
            "oldest_age_s": value.get("oldest_age_s") or {},
            "sla_breaches": {"count": len(breaches), "task_ids": breaches[:10]},
            "consumer_heartbeat": value.get("consumer_heartbeat"),
            "pauses": value.get("pauses"), "circuits": value.get("circuits"),
            "alerts": alerts, "spend": {"month": spend.get("month"), "by_purpose": by_purpose},
        }
        return section(key, title, state, reason, [meta], data, value.get("at"), spec.get("max_age_h", 1), spec.get("due_at"), age)
    except SourceError as exc:
        return _due_missing(exc, spec.get("due_at"), now, key=key, title=title, max_age_h=spec.get("max_age_h", 1))


def _last_by(rows, field):
    out = {}
    for row in rows:
        if row.get(field) is not None:
            out[row[field]] = row
    return out


def read_s3(spec, cfg, now):
    key, title = "S3_RF1116", "RF1116 挖掘轮次"
    due = spec.get("due_at")
    try:
        rows, meta, _ = read_jsonl(spec.get("rounds_path"), cfg, "services/mining-rounds")
    except SourceError as exc:
        return _due_missing(exc, due, now, key=key, title=title, max_age_h=spec.get("max_age_h"))
    allowed = ("round_id", "market", "month", "status", "candidates_scored", "cap", "gmine_passes", "opened_at", "closed_at")
    rounds = [{k: row.get(k) for k in allowed if k in row} for row in _last_by(rows, "round_id").values()]
    sources_state = [{"name": "rounds", "state": "OK" if rows else "ZERO", "reason": None}]
    timer_rows, metas = [], [meta]
    for label, pattern_key in (("round_timer", "round_timer_ledger_glob"), ("score_timer", "score_timer_ledger_glob")):
        pattern = spec.get(pattern_key)
        if not pattern:
            continue
        paths = sorted(glob.glob(pattern))
        if not paths:
            sources_state.append({"name": label, "state": "MISSING", "reason": "FILE_ABSENT"})
            continue
        for path in paths:
            try:
                events, event_meta, _ = read_jsonl(path, cfg, label)
                metas.append(event_meta)
                last = events[-1] if events else None
                if not last:
                    sources_state.append({"name": label, "state": "ZERO", "reason": None})
                    continue
                state_field = spec.get(f"{label}_state_field", spec.get("state_field", "state"))
                value = last.get(state_field, last.get("transition"))
                time_value = last.get("at")
                source_state, source_reason, age = _fresh_state(time_value, spec.get("max_age_h", 48), now)
                if value in TERMINAL_STATES and source_state == "STALE":
                    source_state, source_reason = "OK", None
                sources_state.append({"name": label, "state": source_state, "reason": source_reason})
                timer_rows.append({"name": label, "state": value, "at": time_value, "code": last.get("code")})
            except SourceError as exc:
                metas.append(exc.source)
                sources_state.append({"name": label, "state": "MISSING" if exc.reason == "FILE_ABSENT" else "UNKNOWN", "reason": exc.reason})
    overall = max(sources_state, key=lambda x: WORST[x["state"]])["state"]
    reason = next((x["reason"] for x in sources_state if x["state"] == overall and x["reason"]), None)
    data = {"rounds": rounds, "timers": timer_rows, "sources_state": sources_state}
    if not rows and overall not in {"UNKNOWN", "MISSING"}:
        overall = "ZERO"
    return section(key, title, overall, reason, metas, data if (rounds or timer_rows or overall in {"OK", "ZERO", "STALE"}) else None, due_at=due)


def read_s4(spec, cfg, now):
    key, title = "S4_SEALED_VERDICTS", "封存结论"
    due = spec.get("due_at")
    all_rows, metas = [], []
    paths = [("ashare", spec.get("ashare_path")), ("overseas", spec.get("overseas_path"))]
    paths = [(name, path) for name, path in paths if path]
    if not paths:
        return section(key, title, "UNKNOWN", "NOT_CONFIGURED", [], None, due_at=due)
    for name, path in paths:
        try:
            rows, meta, _ = read_jsonl(path, cfg, f"{name}-sealed-verdicts")
            metas.append(meta)
            all_rows.extend(rows)
        except SourceError as exc:
            return _due_missing(exc, due, now, key=key, title=title)
    allowed = ("entry_id", "kind", "strategy_ref", "decision", "sealed_on", "production_effect", "supersedes_ref", "locked_at")
    values = []
    for row in sorted(all_rows, key=lambda x: str(x.get("locked_at", "")), reverse=True)[:30]:
        item = {k: row.get(k) for k in allowed}
        item["file_sha256"] = str(row.get("file_sha256", ""))[:12]
        values.append(item)
    state = "OK" if all_rows else "ZERO"
    return section(key, title, state, None, metas, {"rows": values, "total": len(all_rows)}, due_at=due)


def read_s5(spec, cfg, now):
    key, title = "S5_RUT1", "RUT1 前向运行"
    states, metas, runs = [], [], []
    for run in spec.get("runs", []):
        due = run.get("due_at")
        try:
            events, meta, _ = read_jsonl(run.get("ledger_path"), cfg, run.get("name"))
            metas.append(meta)
            if not events:
                state, reason, age = "ZERO", None, None
                value = {"name": run.get("name"), "state": None, "at": None, "lines": 0, "sealed": False, "sealed_sha256": None}
            else:
                last = events[-1]
                state, reason, age = _fresh_state(last.get("at"), run.get("max_age_h", 6), now)
                word = last.get("state")
                if word in TERMINAL_STATES or str(word).startswith("ABORTED/"):
                    if state == "STALE": state, reason = "OK", None
                sealed_sha = None
                sealed = False
                try:
                    sealed_raw, sealed_meta = read_bytes(run.get("sealed_path"), cfg, run.get("name"))
                    metas.append(sealed_meta); sealed = True; sealed_sha = hashlib.sha256(sealed_raw).hexdigest()
                except SourceError as sealed_exc:
                    if sealed_exc.reason != "FILE_ABSENT":
                        raise
                value = {"name": run.get("name"), "state": word, "at": last.get("at"), "lines": len(events), "sealed": sealed, "sealed_sha256": sealed_sha}
            states.append({"name": run.get("name"), "state": state, "reason": reason})
            runs.append(value)
        except SourceError as exc:
            metas.append(exc.source)
            not_due = exc.reason == "FILE_ABSENT" and due and now < parse_time(due)
            states.append({"name": run.get("name"), "state": "NOT_APPLICABLE" if not_due else ("MISSING" if exc.reason == "FILE_ABSENT" else "UNKNOWN"), "reason": "NOT_YET_DUE" if not_due else exc.reason})
    if not states:
        return section(key, title, "UNKNOWN", "NOT_CONFIGURED", [], None)
    overall = max(states, key=lambda x: WORST[x["state"]])["state"]
    reason = next((x["reason"] for x in states if x["state"] == overall and x["reason"]), None)
    data = {"runs": runs, "sources_state": states} if runs else None
    return section(key, title, overall, reason, metas, data)


def read_s7(spec, cfg, now):
    key, title = "S7_PLAN_SNAPSHOT", "计划冻结快照（11-25 冻结，之后不再更新）"
    try:
        value, meta, raw = read_json(spec.get("path"), cfg, "plan-coord freeze")
        if hashlib.sha256(raw).hexdigest() != spec.get("sha256"):
            raise SourceError("SHA_MISMATCH", meta)
        if value.get("schema") != "PLAN_SNAPSHOT_V1":
            raise SourceError("SCHEMA_MISMATCH", meta)
        data = {k: value.get(k, []) for k in ("workplan", "focus", "milestones")}
        return section(key, title, "OK" if any(data.values()) else "ZERO", None, [meta], data)
    except SourceError as exc:
        return _due_missing(exc, spec.get("due_at"), now, key=key, title=title)


def read_s8():
    items = [
        ("HK 研究队列状态", "现有 HK 告警与 #133 research-web 导出"),
        ("T3 影子 S 周任务（HK）", "现有 HK 告警与 #133 research-web 导出"),
        ("U11 前向采集（HK）", "现有 HK 告警与 #133 research-web 导出"),
        ("V6 每日运行", "现有 alert-checks 飞书告警"),
        ("C3 FWD 前向车道", "现有 HK 告警"),
        ("试验台账 N", "QRP trial-ledger"),
    ]
    return section("S8_NOT_IN_SCOPE", "V1 未覆盖", "NOT_APPLICABLE", "NOT_IN_V1_SCOPE", [], None)


S9_FED_FIELDS = (
    "verdict", "verdictToken", "status", "sealedOn", "sealSha256",
    "k2State", "tStart", "tStartRegistryStatus", "nextCheck",
)
S9_FED_KEYS = ("schema", "rowClass", *S9_FED_FIELDS, "records")
S9_FIELD_KEYS = ("state", "value", "reason", "src")
S9_FIELD_STATES = ("OK", "NOT_APPLICABLE", "MISSING", "UNKNOWN", "STALE", "CONFLICT")
S9_ROW_CLASSES = {"FROZEN_CLOSED", "FROZEN_OPEN", "FROZEN_NOT_APPLICABLE", "NEW"}
S9_RESULTS = {"NO_CHANGE", "NEW_REV", "FAILED"}
S9_MARKET_COUNTS = ("done", "forward", "running", "todo", "blocked", "total")


def _integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _s9_status_valid(status):
    if not isinstance(status, dict):
        return False
    if status.get("schema") != "MASTER_TABLE_RUN_STATUS_V1":
        return False
    if status.get("result") not in S9_RESULTS or not _integer(status.get("rev")):
        return False
    try:
        stamp = parse_time(status.get("ran_at"))
    except (TypeError, ValueError):
        return False
    return stamp.tzinfo is not None and stamp.utcoffset() is not None


def _s9_table_valid(table):
    if not isinstance(table, dict):
        return False
    if not _integer(table.get("revision")) or not isinstance(table.get("asOf"), str) or not table["asOf"]:
        return False
    market_counts = table.get("marketCounts")
    by_market = market_counts.get("byMarket") if isinstance(market_counts, dict) else None
    if not isinstance(by_market, dict):
        return False
    for market, raw_counts in by_market.items():
        if not isinstance(market, str) or not market or not isinstance(raw_counts, dict):
            return False
        if any(
            name not in raw_counts
            or not _integer(raw_counts[name])
            or raw_counts[name] < 0
            for name in S9_MARKET_COUNTS
        ):
            return False
    overlay = table.get("ledgerOverlay")
    if not isinstance(overlay, dict):
        return False
    if not isinstance(overlay.get("evaluatedOn"), str) or not overlay["evaluatedOn"]:
        return False
    if not _integer(overlay.get("frozenRev")) or not isinstance(overlay.get("unjoined"), list):
        return False
    items = table.get("items")
    return (
        isinstance(items, list)
        and bool(items)
        and all(isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"] for item in items)
    )


def _s9_fed_valid(fed):
    if not isinstance(fed, dict) or tuple(fed) != S9_FED_KEYS:
        return False
    if fed.get("schema") != "MASTER_TABLE_FED_V1" or fed.get("rowClass") not in S9_ROW_CLASSES:
        return False
    if not isinstance(fed.get("records"), list):
        return False
    for name in S9_FED_FIELDS:
        field = fed.get(name)
        if not isinstance(field, dict) or tuple(field) != S9_FIELD_KEYS:
            return False
        if field.get("state") not in S9_FIELD_STATES:
            return False
        if field["state"] not in {"OK", "STALE", "UNKNOWN"} and field.get("value") is not None:
            return False
    return True


def read_s9(spec, cfg, now):
    key, title = "S9_MASTER_TABLE", "研究总表（脚本生成）"
    due, max_age = spec.get("due_at"), spec.get("max_age_h", 3)
    try:
        table, table_meta, _ = read_json(spec.get("table_path"), cfg, "master-table.service")
        status, status_meta, _ = read_json(spec.get("status_path"), cfg, "master-table.service")
        if not _s9_status_valid(status):
            raise SourceError("SCHEMA_MISMATCH", status_meta)
        if not _s9_table_valid(table):
            raise SourceError("SCHEMA_MISMATCH", table_meta)
        if table["revision"] != status["rev"]:
            raise SourceError("SCHEMA_MISMATCH", status_meta)
        state, reason, age = _fresh_state(status.get("ran_at"), max_age, now)
        if state == "UNKNOWN":
            return section(key, title, state, reason, [table_meta, status_meta], None, None, max_age, due)
        items = table["items"]
        fed_seen = any("ledgerFed" in item for item in items)
        if fed_seen and not all(_s9_fed_valid(item.get("ledgerFed")) for item in items):
            raise SourceError("SCHEMA_MISMATCH", table_meta)
        counts = {field: {s: 0 for s in S9_FIELD_STATES} for field in S9_FED_FIELDS}
        new_rows = []
        for item in items:
            fed = item.get("ledgerFed")
            if not isinstance(fed, dict):
                continue
            for field in S9_FED_FIELDS:
                counts[field][fed[field]["state"]] += 1
            if fed.get("rowClass") == "NEW":
                def field_value(name): return (fed.get(name) or {}).get("value")
                new_rows.append({"id": item.get("id") or item.get("key"), "verdict": field_value("verdict"), "status": field_value("status"), "sealedOn": field_value("sealedOn")})
        by_market = {}
        for market, raw_counts in table["marketCounts"]["byMarket"].items():
            by_market[str(market)] = {name: raw_counts[name] for name in S9_MARKET_COUNTS}
        data = {
            "revision": table.get("revision"), "asOf": table.get("asOf"),
            "marketCounts": {"byMarket": by_market},
            "ledgerOverlay": {
                "evaluatedOn": (table.get("ledgerOverlay") or {}).get("evaluatedOn"),
                "frozenRev": (table.get("ledgerOverlay") or {}).get("frozenRev"),
                "unjoined_count": len((table.get("ledgerOverlay") or {}).get("unjoined") or []),
            },
            "ledgerFedStateCounts": counts,
            "new_row_count": len(new_rows), "new_rows": list(reversed(new_rows))[:30],
            "run_status": {k: status.get(k) for k in ("result", "code", "rev", "ran_at", "evaluatedOn")},
        }
        if not fed_seen:
            state, reason = "ZERO", None
            data["machine_rows"] = "NOT_YET_GENERATED"
            data["note_zh"] = "机器版尚未生成"
        return section(key, title, state, reason, [table_meta, status_meta], data, status.get("ran_at"), max_age, due, age)
    except SourceError as exc:
        return _due_missing(exc, due, now, key=key, title=title, max_age_h=max_age)
