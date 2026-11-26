"""Strict, descriptor-bound verification for RUT1 inputs."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath

from . import forms
from .securefs import Root, Tree, UnsafePath


class VerificationError(ValueError):
    pass


def digest(path: Path) -> str:
    """Digest a regular file without following any path component."""
    path = Path(path)
    try:
        with Root(path.parent) as root:
            fd = root.open_regular(path.name)
            try:
                value = hashlib.sha256()
                while True:
                    block = os.read(fd, 1024 * 1024)
                    if not block:
                        break
                    value.update(block)
                return value.hexdigest()
            finally:
                os.close(fd)
    except (OSError, UnsafePath) as exc:
        raise VerificationError("UNSAFE_PATH") from exc


def _add_parents(expected: dict[str, str], relative: str) -> None:
    parts = PurePosixPath(relative).parts
    for index in range(1, len(parts)):
        expected.setdefault(PurePosixPath(*parts[:index]).as_posix(), "dir")


def _expected_file(expected: dict[str, str], relative: str) -> None:
    expected[relative] = "file"
    _add_parents(expected, relative)


def _tree_entries(tree: Tree) -> dict[str, str]:
    try:
        entries = tree.entries()
    except (OSError, UnsafePath) as exc:
        raise VerificationError("UNSAFE_PATH") from exc
    for relative in entries:
        name = PurePosixPath(relative).name
        if name == ".DS_Store" or name.startswith("._"):
            raise VerificationError("APPLEDOUBLE_REFUSED")
    return entries


def verify_sum_file(tree: Tree, sum_relative: str,
                    root_relative: str) -> tuple[dict[str, str], str]:
    try:
        raw_bytes = tree.read_bytes(sum_relative)
        raw = raw_bytes.decode("utf-8")
    except (OSError, UnsafePath, UnicodeError) as exc:
        raise VerificationError("MISSING_SHA256SUMS") from exc
    verified = {}
    seen = set()
    for line in raw.splitlines():
        if len(line) < 67 or line[64:66] not in ("  ", " *"):
            raise VerificationError("INVALID_SHA256SUMS")
        expected, name = line[:64], line[66:]
        rel = PurePosixPath(name)
        if (not expected.isascii() or any(c not in "0123456789abcdef" for c in expected)
                or rel.is_absolute() or ".." in rel.parts or "." in rel.parts
                or not rel.parts or name in seen):
            raise VerificationError("INVALID_SHA256SUMS")
        seen.add(name)
        full = (PurePosixPath(root_relative) / rel).as_posix() if root_relative else rel.as_posix()
        try:
            actual = tree.digest(full)
        except (OSError, UnsafePath) as exc:
            raise VerificationError("SHA256_MISMATCH") from exc
        if actual != expected:
            raise VerificationError("SHA256_MISMATCH")
        verified[full] = expected
    if not verified:
        raise VerificationError("EMPTY_SHA256SUMS")
    return verified, hashlib.sha256(raw_bytes).hexdigest()


def _require_exact_tree(actual: dict[str, str], expected: dict[str, str]) -> None:
    if actual != expected:
        raise VerificationError("UNREGISTERED_TREE_ENTRY")


def _verify_p1(tree: Tree, actual: dict[str, str]) -> dict[str, str]:
    expected = {}
    verified_files = {}
    for day in forms.TRADING_DAYS:
        root = f"us-1m/{day}"
        sums = f"{root}/SHA256SUMS"
        _expected_file(expected, sums)
        files, sums_digest = verify_sum_file(tree, sums, root)
        verified_files.update(files)
        verified_files[sums] = sums_digest
    decision = "decision-inputs/us-v5"
    decision_sums = f"{decision}/SHA256SUMS"
    _expected_file(expected, decision_sums)
    files, sums_digest = verify_sum_file(tree, decision_sums, decision)
    if {PurePosixPath(path).name for path in files} != {
            f"{day}.jsonl.gz" for day in forms.TRADING_DAYS}:
        raise VerificationError("DECISION_DAY_SET_MISMATCH")
    verified_files.update(files)
    verified_files[decision_sums] = sums_digest
    fills = "fills"
    fills_sums = f"{fills}/SHA256SUMS"
    _expected_file(expected, fills_sums)
    files, sums_digest = verify_sum_file(tree, fills_sums, fills)
    if {PurePosixPath(path).name for path in files} != {"US_V5_FILLS_E3_V2.json"}:
        raise VerificationError("FILLS_SET_MISMATCH")
    verified_files.update(files)
    verified_files[fills_sums] = sums_digest
    for relative in verified_files:
        _expected_file(expected, relative)
    _require_exact_tree(actual, expected)
    try:
        payload = json.loads(tree.read_bytes("fills/US_V5_FILLS_E3_V2.json").decode("utf-8"))
    except (OSError, UnsafePath, UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError("FILLS_INVALID_JSON") from exc
    if payload.get("schema") != "US_V5_FILLS_E3_V2" or payload.get("to", "") < "2026-11-27":
        raise VerificationError("FILLS_CONTRACT_MISMATCH")
    return dict(sorted(verified_files.items()))


def _verify_p2(tree: Tree, actual: dict[str, str]) -> dict[str, str]:
    verified, sums_digest = verify_sum_file(tree, "SHA256SUMS", "")
    expected = {}
    _expected_file(expected, "SHA256SUMS")
    for relative in verified:
        _expected_file(expected, relative)
    _require_exact_tree(actual, expected)

    data_files = {
        relative for relative in verified
        if len(PurePosixPath(relative).parts) == 3
        and PurePosixPath(relative).parts[0] in ("raw", "all")
        and PurePosixPath(relative).name == "2026-11.jsonl.gz"
    }
    required = set(data_files)
    symbol_sets = []
    for copy_name in ("raw", "all"):
        selected = {path for path in data_files if PurePosixPath(path).parts[0] == copy_name}
        symbols = {PurePosixPath(path).parts[1] for path in selected}
        if len(selected) != 79 or len(symbols) != 79:
            raise VerificationError("ALPACA_SYMBOL_COUNT_MISMATCH")
        symbol_sets.append(symbols)
        for data in selected:
            manifest = data + ".MANIFEST.json"
            required.add(manifest)
            try:
                payload = json.loads(tree.read_bytes(manifest).decode("utf-8"))
            except (OSError, UnsafePath, UnicodeError, json.JSONDecodeError) as exc:
                raise VerificationError("INVALID_MANIFEST") from exc
            if payload.get("file") != PurePosixPath(data).name or payload.get("sha256") != tree.digest(data):
                raise VerificationError("MANIFEST_MISMATCH")
    if symbol_sets[0] != symbol_sets[1]:
        raise VerificationError("ALPACA_SYMBOL_SET_MISMATCH")
    if set(verified) != required:
        raise VerificationError("ALPACA_SUM_SET_MISMATCH")
    return dict(sorted({**verified, "SHA256SUMS": sums_digest}.items()))


def verify_tree(phase: str, tree: Tree) -> dict[str, str]:
    actual = _tree_entries(tree)
    if phase == "p1":
        return _verify_p1(tree, actual)
    if phase == "p2":
        return _verify_p2(tree, actual)
    raise VerificationError("INVALID_PHASE")


def verify_stage(phase: str, stage: Path) -> dict[str, str]:
    """Compatibility entry point; the copy runner uses a held Tree directly."""
    stage = Path(stage)
    try:
        with Root(stage.parent) as root, root.tree(stage.name) as tree:
            return verify_tree(phase, tree)
    except UnsafePath as exc:
        raise VerificationError("UNSAFE_PATH") from exc
