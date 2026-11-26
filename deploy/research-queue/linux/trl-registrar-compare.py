#!/usr/bin/python3
"""Byte-compare direct Mac and Linux registrar fixture receipts."""
import argparse
import json
import pathlib
import re
import sys


SHA64 = re.compile(r"[0-9a-f]{64}")


def compare(mac_path, linux_path):
    mac = pathlib.Path(mac_path).read_bytes()
    linux = pathlib.Path(linux_path).read_bytes()
    valid = True
    try:
        value = json.loads(linux)
        valid = (isinstance(value, dict) and value.get("schema") == "TRIAL_REGISTRATION_RECEIPT_V1"
                 and SHA64.fullmatch(value.get("request_sha256", "")) is not None and isinstance(value.get("rows"), list))
    except (UnicodeError, ValueError):
        valid = False
    return {"schema": "Q137_TRL_REGISTRAR_COMPARE_V1", "pass": valid and mac == linux,
            "bytesEqual": mac == linux, "receiptValid": valid, "macBytes": len(mac), "linuxBytes": len(linux)}


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
