"""Atomic status JSON shared by the origin and tunnel supervisors."""

import json
import os
import pathlib
import tempfile


def write(path, payload):
    target = pathlib.Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=target.parent, prefix="." + target.name, delete=False) as handle:
        json.dump(payload, handle, sort_keys=True, indent=2)
        handle.write("\n")
        pending = pathlib.Path(handle.name)
    os.chmod(pending, 0o640)
    os.replace(pending, target)
