"""Build and atomically publish RQ_VALIDATED_RETURN_V1 bundles.

Only rq-complete calls this module, after the trusted consumer-side validator
has accepted the attempt.  The result sidecars are not inputs: revalidate()
reads result.json, so card and ideas are taken from that same file.
"""
import hashlib
import json
import os
import pathlib
import re
import tempfile

from . import core, guard


SCHEMA = "RQ_VALIDATED_RETURN_V1"
VALIDATOR = {"name": "rq-consumer-revalidate", "version": "Q3C_V1"}
_SAFE_TASK_ID = re.compile(r"^[A-Za-z0-9._-]+$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ReturnError(Exception):
    def __init__(self, code, detail=""):
        super().__init__("%s %s" % (code, detail))
        self.code = code
        self.detail = detail


def _json(path):
    try:
        raw = pathlib.Path(path).read_bytes()
        value = json.loads(raw)
    except (OSError, ValueError, TypeError) as e:
        raise ReturnError("RETURN_SOURCE_INVALID", str(e)[:160])
    if not isinstance(value, dict):
        raise ReturnError("RETURN_SOURCE_INVALID", "%s is not an object" % pathlib.Path(path).name)
    return raw, value


def _binding(value):
    if not isinstance(value, dict):
        return None
    ref, digest = value.get("ref"), value.get("sha256")
    if not isinstance(ref, str) or not ref or not isinstance(digest, str) or not _SHA256.fullmatch(digest):
        return None
    return {"ref": ref, "sha256": digest}


def _bindings(task, task_doc, bundle):
    """Read explicit staged bindings, with the current Q3c staged form as the compatibility representation."""
    fact = _binding(task_doc.get("fact_pack"))
    registry = _binding(task_doc.get("registry"))

    if fact is None:
        try:
            inputs = json.loads(task["admission_json"])["request"]["inputs"]
        except (KeyError, TypeError, ValueError):
            inputs = []
        if isinstance(inputs, list) and len(inputs) == 1:
            item = inputs[0]
            fact = _binding({"ref": item.get("path"), "sha256": item.get("sha256")}) if isinstance(item, dict) else None

    if registry is None and isinstance(bundle.get("registry"), dict):
        registry = {
            "ref": "in/bundle.json#/registry",
            "sha256": core.sha256_hex(core.canonical(bundle["registry"])),
        }

    if fact is None or registry is None:
        missing = [name for name, value in (("fact_pack", fact), ("registry", registry)) if value is None]
        raise ReturnError("RETURN_BINDING_MISSING", ",".join(missing))
    return fact, registry


def _validated_outputs(result):
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        raise ReturnError("RETURN_SOURCE_INVALID", "result.outputs")
    if isinstance(outputs.get("card"), dict):
        card = outputs["card"]
        ideas = outputs.get("factor_ideas")
    else:
        raise ReturnError("RETURN_SOURCE_INVALID", "validated card")
    if not isinstance(ideas, list) or not all(isinstance(idea, dict) for idea in ideas):
        raise ReturnError("RETURN_SOURCE_INVALID", "validated ideas")
    return card, ideas


def build(task, attempt_dir, validation):
    """Return (canonical bytes, parsed document) for one accepted attempt."""
    attempt = pathlib.Path(attempt_dir)
    _, task_doc = _json(attempt / "in" / "task.json")
    _, staged = _json(attempt / "in" / "bundle.json")
    result_raw, result = _json(attempt / "result.json")
    fact, registry = _bindings(task, task_doc, staged)
    card, ideas = _validated_outputs(result)
    output_sha = validation.get("output_sha256") if isinstance(validation, dict) else None
    if not isinstance(output_sha, str) or not _SHA256.fullmatch(output_sha):
        raise ReturnError("RETURN_SOURCE_INVALID", "output_sha256")

    body = {
        "schema": SCHEMA,
        "task_id": task["task_id"],
        "attempt_no": task["attempt_no"],
        "host": task["host"],
        "template_id": task["template_id"],
        "template_sha256": task["template_sha256"],
        "kind": task["kind"],
        "market": task["market"],
        "validator": dict(VALIDATOR),
        "card": card,
        "ideas": ideas,
        "card_sha256": core.sha256_hex(core.canonical(card)),
        "ideas_sha256": core.sha256_hex(core.canonical(ideas)),
        "fact_pack": fact,
        "registry": registry,
        "result_sha256": hashlib.sha256(result_raw).hexdigest(),
        "output_sha256": output_sha,
    }
    doc = dict(body, bundle_sha256=core.sha256_hex(core.canonical(body)))
    return (core.canonical(doc) + "\n").encode("utf-8"), doc


def _output_path(cfg, task):
    task_id = task.get("task_id")
    attempt_no = task.get("attempt_no")
    if not isinstance(task_id, str) or not _SAFE_TASK_ID.fullmatch(task_id) or isinstance(attempt_no, bool) or not isinstance(attempt_no, int) or attempt_no <= 0:
        raise ReturnError("RETURN_PATH_FORBIDDEN", "task id or attempt")
    outbox = pathlib.Path(cfg.outbox_dir)
    path = outbox / ("validated-return-%s-a%d.json" % (task_id, attempt_no))
    try:
        if path.parent.resolve() != outbox.resolve() or path.is_symlink():
            raise ReturnError("RETURN_PATH_FORBIDDEN", str(path))
        guard.check_write_path(path)
        guard.check_write_path(path.resolve(strict=False))
    except guard.PathForbidden as e:
        raise ReturnError("RETURN_PATH_FORBIDDEN", str(e)[:160])
    return path


def _fsync_dir(path):
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    fd = os.open(str(path), flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish(cfg, task, attempt_dir, validation):
    """Atomically publish an immutable bundle, accepting an identical prior publish."""
    data, doc = build(task, attempt_dir, validation)
    path = _output_path(cfg, task)
    outbox = path.parent

    if path.exists():
        try:
            existing = path.read_bytes()
        except OSError as e:
            raise ReturnError("RETURN_EXISTS_DIFFERENT", str(e)[:160])
        if existing != data:
            raise ReturnError("RETURN_EXISTS_DIFFERENT", path.name)

    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".%s." % path.name, suffix=".tmp", dir=str(outbox), delete=False) as f:
            tmp = pathlib.Path(f.name)
            guard.check_write_path(tmp)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        tmp.chmod(0o444)
        if path.exists():
            existing = path.read_bytes()
            if existing != data:
                raise ReturnError("RETURN_EXISTS_DIFFERENT", path.name)
        os.replace(str(tmp), str(path))
        tmp = None
        path.chmod(0o444)
        _fsync_dir(outbox)
    finally:
        if tmp is not None:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
    return {"path": path, "bundle_sha256": doc["bundle_sha256"]}
