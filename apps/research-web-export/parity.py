"""Networkless comparison core plus operator-only snapshot CLI."""

import argparse
import hashlib
import json
import os
import pathlib
import tempfile
import urllib.request
from datetime import datetime, timezone


QRP_ROUTES = (
    "/", "/api/workspace", "/api/strategies", "/api/runtime-status",
    "/api/runtime-research-loop",
)


class ParityError(RuntimeError):
    pass


def _fail(code):
    raise ParityError(code)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _normalize(route, content_type, body):
    kind = content_type.split(";", 1)[0].strip().lower()
    if kind != "application/json":
        return body
    try:
        value = json.loads(body)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ParityError("ROUTE_JSON_INVALID:" + route) from exc
    if route == "/api/runtime-status" and isinstance(value, dict):
        health = value.get("health")
        if isinstance(health, dict):
            health.pop("generatedAt", None)
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def capture_qrp(fetch, captured_at):
    rows = {}
    for route in QRP_ROUTES:
        status, content_type, body = fetch(route)
        if status != 200:
            _fail("QRP_ROUTE_NOT_200:" + route)
        rows[route] = {
            "status": status,
            "contentType": content_type.split(";", 1)[0].strip().lower(),
            "normalizedSha256": _sha(_normalize(route, content_type, body)),
        }
    return {"schema": "QRP_WEB_PARITY_SNAPSHOT_V1", "capturedAt": captured_at, "routes": rows}


def compare_qrp(left, right):
    if not isinstance(left, dict) or not isinstance(right, dict):
        _fail("QRP_SNAPSHOT_INVALID")
    if left.get("schema") != "QRP_WEB_PARITY_SNAPSHOT_V1" or right.get("schema") != left.get("schema"):
        _fail("QRP_SNAPSHOT_INVALID")
    expected = set(QRP_ROUTES)
    if set(left.get("routes", {})) != expected or set(right.get("routes", {})) != expected:
        _fail("QRP_ROUTE_SET_MISMATCH")
    for side in (left, right):
        for row in side["routes"].values():
            if (not isinstance(row, dict) or row.get("status") != 200
                    or not isinstance(row.get("contentType"), str)
                    or not isinstance(row.get("normalizedSha256"), str)
                    or len(row["normalizedSha256"]) != 64):
                _fail("QRP_SNAPSHOT_INVALID")
    different = [route for route in QRP_ROUTES if left["routes"][route] != right["routes"][route]]
    if different:
        _fail("QRP_ROUTE_MISMATCH:" + ",".join(different))
    return {"schema": "QRP_WEB_PARITY_RESULT_V1", "result": "PASS", "routes": len(QRP_ROUTES)}


def capture_desk(fetch, routes, commit):
    if not isinstance(commit, str) or not commit or not isinstance(routes, list):
        _fail("DESK_SNAPSHOT_INVALID")
    if len(routes) != len(set(routes)) or not routes or any(not isinstance(r, str) or not r.startswith("/") for r in routes):
        _fail("DESK_ROUTE_SET_INVALID")
    rows = {}
    for route in routes:
        status, content_type, body = fetch(route)
        rows[route] = {
            "status": status,
            "contentType": content_type.split(";", 1)[0].strip().lower(),
            "bodySha256": _sha(body),
        }
    return {"schema": "DESK_PANEL_PARITY_SNAPSHOT_V1", "commit": commit, "routes": rows}


def compare_desk(left, right, expected_commit):
    if (not isinstance(expected_commit, str) or not expected_commit
            or left.get("schema") != "DESK_PANEL_PARITY_SNAPSHOT_V1"
            or right.get("schema") != left.get("schema")):
        _fail("DESK_SNAPSHOT_INVALID")
    if left.get("commit") != expected_commit or right.get("commit") != expected_commit:
        _fail("DESK_COMMIT_MISMATCH")
    if set(left.get("routes", {})) != set(right.get("routes", {})):
        _fail("DESK_ROUTE_SET_MISMATCH")
    for side in (left, right):
        if not side["routes"] or any(not isinstance(route, str) or not route.startswith("/") for route in side["routes"]):
            _fail("DESK_ROUTE_SET_MISMATCH")
        if any(row.get("status") != 200 for row in side["routes"].values()):
            _fail("DESK_ROUTE_NOT_200")
    return {"schema": "DESK_PANEL_PARITY_RESULT_V1", "result": "PASS", "routes": len(left["routes"])}


def _fetcher(base):
    if not (base.startswith("http://127.0.0.1:") or base.startswith("http://localhost:")):
        _fail("CAPTURE_BASE_NOT_LOOPBACK")
    def fetch(route):
        request = urllib.request.Request(base.rstrip("/") + route, headers={"Accept": "application/json,text/html"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read()
    return fetch


def _read_json(path):
    target = pathlib.Path(path)
    if target.is_symlink() or not target.is_file():
        _fail("SNAPSHOT_FILE_INVALID")
    try:
        return json.loads(target.read_text())
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ParityError("SNAPSHOT_FILE_INVALID") from exc


def _write_json(path, payload):
    target = pathlib.Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=target.parent, prefix="." + target.name, delete=False) as handle:
        json.dump(payload, handle, sort_keys=True, indent=2)
        handle.write("\n")
        pending = pathlib.Path(handle.name)
    os.chmod(pending, 0o444)
    os.replace(pending, target)


def main(argv=None):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    qcap = sub.add_parser("capture-qrp"); qcap.add_argument("--base", required=True); qcap.add_argument("--out", required=True)
    qcmp = sub.add_parser("compare-qrp"); qcmp.add_argument("--left", required=True); qcmp.add_argument("--right", required=True)
    dcap = sub.add_parser("capture-desk"); dcap.add_argument("--base", required=True); dcap.add_argument("--commit", required=True); dcap.add_argument("--routes", required=True); dcap.add_argument("--out", required=True)
    dcmp = sub.add_parser("compare-desk"); dcmp.add_argument("--left", required=True); dcmp.add_argument("--right", required=True); dcmp.add_argument("--expected-commit", required=True)
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc).isoformat()
    if args.command == "capture-qrp":
        result = capture_qrp(_fetcher(args.base), now); _write_json(args.out, result)
    elif args.command == "compare-qrp":
        result = compare_qrp(_read_json(args.left), _read_json(args.right))
    elif args.command == "capture-desk":
        raw = _read_json(args.routes); routes = raw if isinstance(raw, list) else raw.get("routes")
        result = capture_desk(_fetcher(args.base), routes, args.commit); _write_json(args.out, result)
    else:
        result = compare_desk(_read_json(args.left), _read_json(args.right), args.expected_commit)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
