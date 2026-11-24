#!/usr/bin/env python3
"""Offline integrity check for an installed master-table root."""

import argparse
import json
from pathlib import Path
import sys

from mtl import selfcheck, writer
from mtl.errors import MtlError


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    args = parser.parse_args(argv)
    root = Path(args.root)
    status = json.loads((root / "state" / "run_status.json").read_text(encoding="utf-8"))
    revision = int(status["rev"])
    json_path = root / "revs" / f"{writer.BASE}.rev{revision}.json"
    md_path = root / "revs" / f"{writer.BASE}.rev{revision}.md"
    document = json.loads(json_path.read_text(encoding="utf-8"))
    registry_lines = [json.loads(line) for line in
                      (root / "state" / "ROW_REGISTRY_V1.jsonl").read_text(encoding="utf-8").splitlines() if line]
    registry_ids = [line["row_id"] for line in registry_lines]
    frozen_rev = int(document["ledgerOverlay"]["frozenRev"])
    frozen_ids = [line["row_id"] for line in registry_lines
                  if line.get("origin") == f"FROZEN_REV{frozen_rev}"]
    try:
        selfcheck.check(document, md_path.read_bytes(), frozen_ids, registry_ids)
    except (MtlError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(getattr(exc, "code", f"SELF_CHECK_IO:{type(exc).__name__}"), file=sys.stderr)
        return getattr(exc, "exit_code", 3)
    print(f"OK rev={revision} frozen={frozen_rev}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
