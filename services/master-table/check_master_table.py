#!/usr/bin/env python3
"""Offline integrity check for an installed master-table root."""

import argparse
import json
from pathlib import Path
import sys

from mtl import registry, selfcheck, writer
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
        previous = registry.ZERO_SHA256
        for seq, line in enumerate(registry_lines, 1):
            if (line.get("seq") != seq or line.get("prev_sha256") != previous
                    or line.get("line_sha256") != registry.line_hash(line)):
                raise MtlError(f"ROW_REGISTRY_UNVERIFIABLE:{seq}", 3)
            previous = line["line_sha256"]
        for suffix, revision_path in (("json", json_path), ("md", md_path)):
            live_path = root / "live" / f"{writer.BASE}.{suffix}"
            if live_path.read_bytes() != revision_path.read_bytes():
                raise MtlError(f"SELF_CHECK_LIVE_DIFF:{suffix}", 3)
            if revision_path.stat().st_mode & 0o777 != 0o444:
                raise MtlError(f"SELF_CHECK_REV_MODE:{suffix}", 3)
        selfcheck.check(document, md_path.read_bytes(), frozen_ids, registry_ids)
    except (MtlError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(getattr(exc, "code", f"SELF_CHECK_IO:{type(exc).__name__}"), file=sys.stderr)
        return getattr(exc, "exit_code", 3)
    print(f"OK rev={revision} frozen={frozen_rev}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
