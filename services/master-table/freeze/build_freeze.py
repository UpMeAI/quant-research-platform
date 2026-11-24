#!/usr/bin/env python3
"""Build a review-only freeze proposal from the last hand-authored table."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys


MASTER_TABLE = Path(__file__).resolve().parents[1]
if str(MASTER_TABLE) not in sys.path:
    sys.path.insert(0, str(MASTER_TABLE))

from mtl import registry


OPEN_STATES = {
    "在跑", "未跑", "缺输入", "代码未完成", "前向中", "前向未启动",
    "工程闸门", "起草中", "结论待出", "DECISION_GAP",
}
SHA_RE = re.compile(r"(?<![0-9a-f])([0-9a-f]{8,64})(?![0-9a-f])")
PAGE_RE = re.compile(r"(?:artifacts/coordinator/)?([A-Za-z0-9_.-]*(?:K2|FREEZE)[A-Za-z0-9_.-]*[.]md)")


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def _record_id(record):
    return record.get("result_id") or record.get("mark_id")


def _read_ledgers(root):
    records = []
    facts = []
    for path in sorted(Path(root).glob("*.jsonl")):
        if path.name == "trials.jsonl":
            continue
        raw = path.read_bytes()
        facts.append({"path": path.name, "bytes": len(raw), "sha256": _sha(raw)})
        for line_no, line in enumerate(raw.splitlines(), 1):
            if not line:
                continue
            record = json.loads(line)
            if isinstance(record, dict) and _record_id(record):
                value = dict(record)
                value["_ledger"] = path.stem
                value["_line_no"] = line_no
                records.append(value)
    return records, facts


def _text(row):
    values = []
    for key in ("auth", "detail", "next", "verdict"):
        value = row.get(key)
        if isinstance(value, list):
            values.extend(str(item) for item in value)
        elif value is not None:
            values.append(str(value))
    return "\n".join(values)


def _row_id(item_id, rows):
    if item_id in rows:
        return item_id
    base = str(item_id).split("#", 1)[0]
    return base if base in rows else None


def _add(spec, record, evidence):
    for source, target in (("entry_id", "entry_ids"), ("result_id", "result_ids"), ("study_ref", "study_refs")):
        value = record.get(source)
        if value and value not in spec[target]:
            spec[target].append(value)
    if evidence not in spec["evidence"]:
        spec["evidence"].append(evidence)


def _k2_fact(row, coord_dir):
    text = _text(row)
    match = PAGE_RE.search(text)
    if not match:
        return None
    page = match.group(1)
    suffix = text[match.end():match.end() + 100]
    cited_match = SHA_RE.search(suffix)
    cited = cited_match.group(1) if cited_match else None
    source = Path(coord_dir) / page
    if not source.is_file():
        return {"state": "SOURCE_FILE_ABSENT", "value": {"page": page, "citedSha": cited},
                "reason": "SOURCE_FILE_ABSENT", "src": "FREEZE_TOOL"}
    actual = _sha(source.read_bytes())
    state = "MATCH" if cited and actual.startswith(cited) else "CITED_SHA_DIFFERS"
    return {"state": state, "value": {"page": page, "sha256": actual, "citedSha": cited},
            "reason": None if state == "MATCH" else state, "src": "FREEZE_TOOL"}


def _tstart_map(path):
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    result = {}
    for row in document.get("rows", []):
        row_id = row.get("masterTableRow")
        if not row_id:
            continue
        result[row_id] = {
            "value": row.get("T_start"),
            "registryStatus": row.get("status"),
            "generatedAt": document.get("generatedAt"),
        }
        if row.get("to"):
            result[row_id]["nextCheck"] = row["to"]
    return document, result


def _pins(revision, frozen_json_sha, frozen_md_sha, join_sha, tstart_sha):
    return ("# PROPOSED: plan-coord must sign JOIN_MAP before ops installs these pins.\n"
            f"FROZEN_REV = {revision}\n"
            f"FROZEN_JSON_SHA256 = {frozen_json_sha!r}\n"
            f"FROZEN_MD_SHA256 = {frozen_md_sha!r}\n"
            f"JOIN_MAP_SHA256 = {join_sha!r}\n"
            f"TSTART_REGISTRY_SHA256 = {tstart_sha!r}\n")


def build(table_json, table_md, ledger_dir, register, tstart_registry, coord_dir, out,
          qrp_commit="UNKNOWN"):
    table_json = Path(table_json); table_md = Path(table_md); out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    raw_json = table_json.read_bytes(); raw_md = table_md.read_bytes()
    table = json.loads(raw_json)
    revision = int(table["revision"])
    rows = {row["id"]: row for row in table["items"]}
    records, ledger_facts = _read_ledgers(ledger_dir)
    by_sha = {}
    for record in records:
        digest = record.get("file_sha256")
        if digest:
            by_sha.setdefault(digest, []).append(record)

    proposal_rows = {}
    for row_id, row in rows.items():
        proposal_rows[row_id] = {
            "rowClass": "FROZEN_OPEN" if row.get("status") in OPEN_STATES else "FROZEN_CLOSED",
            "entry_ids": [], "result_ids": [], "study_refs": [], "evidence": [],
            "expected_sources": "NONE_DECLARED",
        }

    register_doc = json.loads(Path(register).read_text(encoding="utf-8"))
    for entry in register_doc.get("entries", []):
        row_id = _row_id(entry.get("item_id"), rows)
        digest = (entry.get("conclusion") or {}).get("seal_sha256")
        if row_id and digest:
            for record in by_sha.get(digest, []):
                _add(proposal_rows[row_id], record, "REGISTER_SEAL")

    for record in records:
        for source in record.get("source_refs") or []:
            row_id = source.get("master_table_row") or source.get("masterTableRow")
            if row_id in proposal_rows:
                _add(proposal_rows[row_id], record, "SEGMENT_ROW")
        rid = _record_id(record)
        digest = record.get("file_sha256")
        for row_id, row in rows.items():
            text = _text(row)
            if rid and rid in text:
                _add(proposal_rows[row_id], record, "TEXT_RESULT_ID")
            elif digest and any(len(value) >= 8 and digest.startswith(value) for value in SHA_RE.findall(text)):
                _add(proposal_rows[row_id], record, "TEXT_SHA8")

    tstart_doc, tstarts = _tstart_map(tstart_registry)
    for row_id, fact in tstarts.items():
        if row_id in proposal_rows:
            proposal_rows[row_id]["tStart"] = {key: value for key, value in fact.items() if key != "nextCheck"}
            if fact.get("nextCheck"):
                proposal_rows[row_id]["nextCheck"] = fact["nextCheck"]
    for row_id, row in rows.items():
        k2 = _k2_fact(row, coord_dir)
        if k2:
            proposal_rows[row_id]["k2State"] = k2

    joined = set()
    for spec in proposal_rows.values():
        joined.update(spec["result_ids"])
    unreferenced = sorted(_record_id(record) for record in records if _record_id(record) not in joined)
    join_map = {
        "schema": "JOIN_MAP_V1", "state": "PROPOSED", "frozenRev": revision,
        "freezeDate": table.get("asOf", "")[:10], "rows": proposal_rows,
    }
    join_path = out / "JOIN_MAP_V1.proposed.json"
    _dump(join_path, join_map)
    manifest = {
        "schema": "FREEZE_MANIFEST_V1", "state": "PROPOSED", "frozenRev": revision,
        "ledgers": ledger_facts, "unreferencedRecords": unreferenced,
    }
    _dump(out / "FREEZE_MANIFEST_V1.json", manifest)

    lines = []
    previous = registry.ZERO_SHA256
    for seq, row in enumerate(table["items"], 1):
        line = registry.frozen_line(row["id"], seq, revision, row.get("market"), previous, qrp_commit)
        lines.append(line); previous = line["line_sha256"]
    (out / "ROW_REGISTRY_V1.jsonl").write_text(
        "".join(json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n" for line in lines),
        encoding="utf-8")
    (out / f"FROZEN_REV{revision}.json").write_bytes(raw_json)
    (out / f"FROZEN_REV{revision}.md").write_bytes(raw_md)
    tstart_sha = _sha(Path(tstart_registry).read_bytes())
    (out / "pins.proposed.py").write_text(
        _pins(revision, _sha(raw_json), _sha(raw_md), _sha(join_path.read_bytes()), tstart_sha),
        encoding="utf-8")
    return {"state": "PROPOSED", "frozenRev": revision, "rows": len(rows),
            "ledgers": len(ledger_facts), "unreferenced": len(unreferenced)}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--table-json", required=True)
    parser.add_argument("--table-md", required=True)
    parser.add_argument("--ledger-dir", required=True)
    parser.add_argument("--register", required=True)
    parser.add_argument("--tstart-registry", required=True)
    parser.add_argument("--coord-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--qrp-commit", default="UNKNOWN")
    args = parser.parse_args(argv)
    result = build(args.table_json, args.table_md, args.ledger_dir, args.register,
                   args.tstart_registry, args.coord_dir, args.out, args.qrp_commit)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
