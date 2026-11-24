import hashlib
import json

from .errors import MtlError


ZERO_SHA256 = "0" * 64


def line_hash(line):
    unsigned = {key: value for key, value in line.items() if key != "line_sha256"}
    raw = json.dumps(unsigned, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _finish(line):
    line["line_sha256"] = line_hash(line)
    return line


def frozen_line(row_id, seq, frozen_rev, market, prev_sha256, qrp_commit):
    return _finish({
        "schema": "MASTER_TABLE_ROW_REGISTRY_V1",
        "seq": seq,
        "row_id": row_id,
        "origin": f"FROZEN_REV{frozen_rev}",
        "join": {"entry_ids": [], "result_ids": [], "study_refs": []},
        "market": market,
        "source": None,
        "created_rev": frozen_rev,
        "writer": {"program": "mtl.freeze.build_freeze", "version": "1", "qrp_commit": qrp_commit},
        "prev_sha256": prev_sha256,
    })


def auto_line(row_id, seq, created_rev, market, source, prev_sha256, qrp_commit, join=None):
    return _finish({
        "schema": "MASTER_TABLE_ROW_REGISTRY_V1",
        "seq": seq,
        "row_id": row_id,
        "origin": "LEDGER_AUTO",
        "join": join or {"entry_ids": [], "result_ids": [source["result_id"]], "study_refs": []},
        "market": market,
        "source": dict(source),
        "created_rev": created_rev,
        "writer": {"program": "mtl.run_master_table", "version": "1", "qrp_commit": qrp_commit},
        "prev_sha256": prev_sha256,
    })


def verify(lines, ledger_lines, frozen_rev):
    previous = ZERO_SHA256
    for expected_seq, line in enumerate(lines, 1):
        if (line.get("schema") != "MASTER_TABLE_ROW_REGISTRY_V1"
                or line.get("seq") != expected_seq
                or line.get("prev_sha256") != previous
                or line.get("line_sha256") != line_hash(line)):
            raise MtlError(f"ROW_REGISTRY_UNVERIFIABLE:{expected_seq}", 3)
        if line.get("origin") == "LEDGER_AUTO":
            source = line.get("source") or {}
            actual = ledger_lines.get((source.get("ledger"), source.get("line_no")))
            if (not actual
                    or actual.get("result_id") != source.get("result_id")
                    or actual.get("line_sha256") != source.get("line_sha256")):
                raise MtlError(f"ROW_REGISTRY_UNVERIFIABLE:{expected_seq}", 3)
        elif line.get("origin") != f"FROZEN_REV{frozen_rev}" or line.get("source") is not None:
            raise MtlError(f"ROW_REGISTRY_UNVERIFIABLE:{expected_seq}", 3)
        previous = line["line_sha256"]
    return True
