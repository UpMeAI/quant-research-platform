"""Strict verification for RUT1 inputs."""

import hashlib
import json
from pathlib import Path, PurePosixPath

from . import forms


class VerificationError(ValueError):
    pass


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def reject_appledouble(root: Path) -> None:
    for path in root.rglob("*"):
        if path.name == ".DS_Store" or path.name.startswith("._"):
            raise VerificationError("APPLEDOUBLE_REFUSED")


def verify_sum_file(sum_file: Path, root: Path) -> list[Path]:
    if not sum_file.is_file() or sum_file.is_symlink():
        raise VerificationError("MISSING_SHA256SUMS")
    verified = []
    seen = set()
    for line in sum_file.read_text(encoding="utf-8").splitlines():
        if len(line) < 67 or line[64:66] not in ("  ", " *"):
            raise VerificationError("INVALID_SHA256SUMS")
        expected, name = line[:64], line[66:]
        rel = PurePosixPath(name)
        if (not expected.isascii() or any(c not in "0123456789abcdef" for c in expected)
                or rel.is_absolute() or ".." in rel.parts or name in seen):
            raise VerificationError("INVALID_SHA256SUMS")
        seen.add(name)
        path = root.joinpath(*rel.parts)
        if not path.is_file() or path.is_symlink() or digest(path) != expected:
            raise VerificationError("SHA256_MISMATCH")
        verified.append(path)
    if not verified:
        raise VerificationError("EMPTY_SHA256SUMS")
    return verified


def _verify_p1(stage: Path) -> None:
    for day in forms.TRADING_DAYS:
        verify_sum_file(stage / "us-1m" / day / "SHA256SUMS", stage / "us-1m" / day)
    decision = stage / "decision-inputs" / "us-v5"
    files = verify_sum_file(decision / "SHA256SUMS", decision)
    if {path.name for path in files} != {f"{day}.jsonl.gz" for day in forms.TRADING_DAYS}:
        raise VerificationError("DECISION_DAY_SET_MISMATCH")
    fills = stage / "fills"
    files = verify_sum_file(fills / "SHA256SUMS", fills)
    if {path.name for path in files} != {"US_V5_FILLS_E3_V2.json"}:
        raise VerificationError("FILLS_SET_MISMATCH")
    try:
        payload = json.loads((fills / "US_V5_FILLS_E3_V2.json").read_text())
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError("FILLS_INVALID_JSON") from exc
    if payload.get("schema") != "US_V5_FILLS_E3_V2" or payload.get("to", "") < "2026-11-27":
        raise VerificationError("FILLS_CONTRACT_MISMATCH")


def _verify_p2(stage: Path) -> None:
    root = stage
    expected = set()
    symbol_sets = []
    for copy_name in ("raw", "all"):
        copy_root = root / copy_name
        data_files = list(copy_root.glob("*/2026-11.jsonl.gz"))
        symbols = {path.parent.name for path in data_files}
        if len(data_files) != 79 or len(symbols) != 79:
            raise VerificationError("ALPACA_SYMBOL_COUNT_MISMATCH")
        symbol_sets.append(symbols)
        for data in data_files:
            manifest = data.with_name(data.name + ".MANIFEST.json")
            if not manifest.is_file() or manifest.is_symlink():
                raise VerificationError("MISSING_MANIFEST")
            try:
                payload = json.loads(manifest.read_text())
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise VerificationError("INVALID_MANIFEST") from exc
            if payload.get("file") != data.name or payload.get("sha256") != digest(data):
                raise VerificationError("MANIFEST_MISMATCH")
            expected.update((data.relative_to(root), manifest.relative_to(root)))
    if symbol_sets[0] != symbol_sets[1]:
        raise VerificationError("ALPACA_SYMBOL_SET_MISMATCH")
    verified = {path.relative_to(root) for path in verify_sum_file(root / "SHA256SUMS", root)}
    if verified != expected:
        raise VerificationError("ALPACA_SUM_SET_MISMATCH")


def verify_stage(phase: str, stage: Path) -> None:
    reject_appledouble(stage)
    if phase == "p1":
        _verify_p1(stage)
    elif phase == "p2":
        _verify_p2(stage)
    else:
        raise VerificationError("INVALID_PHASE")
