#!/usr/bin/env python3
"""Generate the append-only-ledger projection of the frozen master table."""

import argparse
from datetime import datetime
import json
from pathlib import Path
import sys
import tempfile
from zoneinfo import ZoneInfo

from mtl import config, fed, ledgers, pins, registry, render, selfcheck, writer
from mtl.errors import MtlError


def _read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def _registry(path):
    try:
        return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line]
    except FileNotFoundError:
        return []


def _pin_values():
    return {
        "frozen_rev": int(pins.FROZEN_REV),
        "frozen_json_sha256": pins.FROZEN_JSON_SHA256,
        "frozen_md_sha256": pins.FROZEN_MD_SHA256,
        "join_map_sha256": pins.JOIN_MAP_SHA256,
        "tstart_registry_sha256": pins.TSTART_REGISTRY_SHA256,
    }


def _ledger_lines(records):
    values = {}
    for name, rows in records.items():
        for row in rows:
            values[(name, row["_line_no"])] = {
                "result_id": row.get("result_id"), "line_sha256": row["_line_sha256"],
            }
    return values


def _ledger_facts(state):
    return [dict({"path": name}, **fact) for name, fact in sorted(state.get("ledgers", {}).items())]


def _append_registry(lines, new_rows, revision, qrp_commit):
    previous = lines[-1]["line_sha256"] if lines else registry.ZERO_SHA256
    output = list(lines)
    for row in new_rows:
        source = row["_registry_source"]
        join = {"entry_ids": [], "result_ids": [source["result_id"]], "study_refs": []}
        line = registry.auto_line(row["id"], len(output) + 1, revision, row["market"], source,
                                  previous, qrp_commit, join=join)
        output.append(line)
        previous = line["line_sha256"]
    return output


def _registry_bytes(lines):
    return b"".join((json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n").encode() for line in lines)


def run(args):
    cfg = config.load(args.config)
    root = Path(cfg["root"])
    frozen_dir = Path(cfg["frozen_dir"])
    pin_values = _pin_values()
    raw_json = (frozen_dir / f"FROZEN_REV{pins.FROZEN_REV}.json").read_bytes()
    raw_md = (frozen_dir / f"FROZEN_REV{pins.FROZEN_REV}.md").read_bytes()
    render.frozen_only(raw_json, raw_md, pin_values)
    if args.frozen_only:
        return 0
    frozen = json.loads(raw_json)
    live_json_path = root / "live" / f"{writer.BASE}.json"
    live_md_path = root / "live" / f"{writer.BASE}.md"
    if live_json_path.exists():
        render.verify_live_frozen(frozen, json.loads(live_json_path.read_text(encoding="utf-8")),
                                  int(pins.FROZEN_REV))
    if live_md_path.exists():
        render.verify_frozen_md(live_md_path.read_bytes(), raw_md, int(pins.FROZEN_REV))
    joins = json.loads((frozen_dir / "JOIN_MAP_V1.json").read_text(encoding="utf-8"))
    state = _read_json(root / "state" / "last_run.json", {}) or {}
    rows = _registry(root / "state" / "ROW_REGISTRY_V1.jsonl")
    records, ledger_state = ledgers.read(cfg, state)
    registry.verify(rows, _ledger_lines(records), int(pins.FROZEN_REV))
    evaluated_on = args.evaluated_on or datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
    projections, new_rows, unjoined = fed.build(frozen, joins, records, rows, evaluated_on)
    last_rev = int(state.get("rev") or pins.FROZEN_REV)
    candidate_rev = last_rev + 1
    next_registry = _append_registry(rows, new_rows, candidate_rev, cfg.get("qrp_commit", "UNKNOWN"))
    candidate = render.build(frozen, raw_md, projections, new_rows, unjoined,
                             _ledger_facts(ledger_state), pin_values, evaluated_on,
                             candidate_rev, next_registry)
    previous_digest = state.get("digest")
    digest = candidate.document["ledgerOverlay"]["digest"]
    result = "NO_CHANGE" if previous_digest == digest else "NEW_REV"
    effective_rev = last_rev if result == "NO_CHANGE" else candidate_rev
    now = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
    status = {"schema": "MASTER_TABLE_RUN_STATUS_V1", "ran_at": now,
              "evaluatedOn": evaluated_on, "result": result, "code": "OK",
              "rev": effective_rev, "inputs": candidate.document["ledgerOverlay"]["ledgers"]}
    if result == "NO_CHANGE":
        writer.write_status(root, status)
        return 0
    selfcheck.check(candidate.document, candidate.md_bytes,
                    [row["id"] for row in frozen["items"]],
                    [line["row_id"] for line in next_registry])
    registry_path = root / "state" / "ROW_REGISTRY_V1.jsonl"
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=registry_path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(_registry_bytes(next_registry)); stream.flush()
        import os
        os.fsync(stream.fileno())
    temporary.replace(registry_path)
    last_run = dict(ledger_state, rev=candidate_rev, digest=digest)
    writer.publish(root, candidate_rev, candidate.json_bytes, candidate.md_bytes, status, last_run)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--evaluated-on")
    parser.add_argument("--frozen-only", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    if args.evaluated_on:
        try:
            datetime.strptime(args.evaluated_on, "%Y-%m-%d")
        except ValueError:
            parser.error("--evaluated-on must be YYYY-MM-DD")
    try:
        if args.check:
            with tempfile.TemporaryDirectory() as td:
                raw = json.loads(Path(args.config).read_text(encoding="utf-8"))
                raw["root"] = td
                raw["allowed_roots"] = list(raw.get("allowed_roots", [])) + [td]
                config_path = Path(td) / "config.json"
                config_path.write_text(json.dumps(raw), encoding="utf-8")
                args.config = str(config_path)
                return run(args)
        cfg = config.load(args.config)
        with writer.locked(cfg["root"]):
            return run(args)
    except MtlError as exc:
        try:
            cfg = config.load(args.config)
            writer.write_status(cfg["root"], {
                "schema": "MASTER_TABLE_RUN_STATUS_V1",
                "ran_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
                "evaluatedOn": args.evaluated_on,
                "result": "FAILED", "code": exc.code, "rev": None, "inputs": [],
            })
        except Exception:
            pass
        print(exc.code, file=sys.stderr)
        return exc.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
