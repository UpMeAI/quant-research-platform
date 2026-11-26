#!/usr/bin/python3
"""Compare one Mac relay snapshot with one Linux shadow snapshot."""
import argparse
import json
import pathlib
import sys


def normalized(path):
    value = json.loads(pathlib.Path(path).read_text())
    if not isinstance(value, dict):
        raise ValueError("SNAPSHOT_INVALID")
    w05 = value.get("w05")
    if not isinstance(w05, dict):
        raise ValueError("SNAPSHOT_W05_MISSING")
    return {
        "localPacks": sorted((x["name"], x["sha256"]) for x in value.get("localPacks", [])),
        "hkPacks": sorted((x["name"], x["sha256"]) for x in value.get("hkPacks", [])),
        "returns": {host: sorted((x["name"], x["sha256"]) for x in value.get("returns", {}).get(host, [])) for host in ("linux", "hk")},
        "w05": {"authority": w05.get("authority"), "node": w05.get("node"), "producerHookRoot": w05.get("producerHookRoot")},
    }


def compare(mac_path, linux_path):
    mac, linux = normalized(mac_path), normalized(linux_path)
    differences = [key for key in ("localPacks", "hkPacks", "returns", "w05") if mac[key] != linux[key]]
    return {"schema": "Q137_RELAY_SHADOW_COMPARE_V1", "pass": not differences, "differences": differences,
            "rule": "names+sha256 sets and W05 authority/node/producer-hook view byte-values equal; timestamps ignored"}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--mac", required=True)
    parser.add_argument("--linux", required=True)
    args = parser.parse_args(argv)
    result = compare(args.mac, args.linux)
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
