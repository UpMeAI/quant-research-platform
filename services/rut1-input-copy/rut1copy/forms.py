"""The immutable Package A forms consumed by the RUT1 copy job."""

from dataclasses import dataclass
from pathlib import Path


class FormRefused(ValueError):
    """Raised when a request is outside the frozen gate forms."""


TRADING_DAYS = (
    "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13",
    "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19",
    "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25",
    "2026-11-27",
)
US_1M_ROOT = (
    "/home/admin/trading-system-v2/trading-system-v2/trading-system-v2/"
    "artifacts/market/us-1m/"
)
DECISION_ROOT = (
    "/home/admin/trading-system-v2/trading-system-v2/trading-system-v2/"
    "reports/decision-inputs/us-v5/"
)
FILLS_ROOT = "/home/admin/rut1-exports/fills/"
P2_ROOT = "/root/us-ssl-forward/research-data/alpaca-1m/"
SERVER_PREFIX = "rsync --server --sender -logDtprce.iLsfxCIvu --safe-links . "

DECISION_GATE_COMMAND = SERVER_PREFIX + DECISION_ROOT
FILLS_EXPORT_COMMAND = "ops:us-v5-fills-e3 --from 2026-11-10 --to 2026-11-27"
FILLS_READ_GATE_COMMAND = SERVER_PREFIX + FILLS_ROOT
P2_RAW_GATE_COMMAND = SERVER_PREFIX + P2_ROOT + "raw/"
P2_ALL_GATE_COMMAND = SERVER_PREFIX + P2_ROOT + "all/"
P2_SUMS_GATE_COMMAND = SERVER_PREFIX + P2_ROOT + "SHA256SUMS"

_SSH = (
    "/usr/bin/ssh -i /home/kayla/.ssh/id_ed25519_linux_hk "
    "-o IdentitiesOnly=yes "
    "-o UserKnownHostsFile=/home/kayla/.ssh/known_hosts_hk "
    "-o StrictHostKeyChecking=yes"
)
_HOST = "root@47.242.198.62"


@dataclass(frozen=True)
class Operation:
    form_id: str
    gate_command: str
    argv: list[str]
    destination: Path | None
    pass_fds: tuple[int, ...] = ()


def _rsync(form_id: str, source: str, destination: Path,
           *, filters: tuple[str, ...] = ()) -> Operation:
    command = SERVER_PREFIX + source
    argv = [
        "/usr/bin/rsync", "-a", "--checksum", "--safe-links", "-e", _SSH,
        *filters, f"{_HOST}:{source}", str(destination),
    ]
    return Operation(form_id, command, argv, destination)


def build_p1_plan(stage: Path, *, days=TRADING_DAYS) -> list[Operation]:
    days = tuple(days)
    if any(day not in TRADING_DAYS for day in days):
        raise FormRefused("day is outside the frozen R-04 set")
    operations = [
        _rsync(
            "R-04-" + day.replace("-", ""), US_1M_ROOT + day + "/",
            stage / "us-1m" / day,
        )
        for day in days
    ]
    operations.append(_rsync(
        "R-05", DECISION_ROOT, stage / "decision-inputs" / "us-v5",
        filters=(
            "--include=SHA256SUMS",
            *tuple(f"--include={day}.jsonl.gz" for day in TRADING_DAYS),
            "--exclude=*",
        ),
    ))
    operations.append(Operation(
        "R-06", FILLS_EXPORT_COMMAND,
        ["/usr/bin/ssh", "-i", "/home/kayla/.ssh/id_ed25519_linux_hk",
         "-o", "IdentitiesOnly=yes", "-o",
         "UserKnownHostsFile=/home/kayla/.ssh/known_hosts_hk", "-o",
         "StrictHostKeyChecking=yes", _HOST, FILLS_EXPORT_COMMAND],
        None,
    ))
    operations.append(_rsync(
        "R-06-READ", FILLS_ROOT, stage / "fills",
        filters=("--include=US_V5_FILLS_E3_V2.json", "--include=SHA256SUMS", "--exclude=*"),
    ))
    return operations


def build_p2_plan(stage: Path) -> list[Operation]:
    filters = (
        "--include=*/", "--include=2026-11.jsonl.gz",
        "--include=2026-11.jsonl.gz.MANIFEST.json", "--exclude=*",
    )
    root = stage
    return [
        _rsync("R-16-RAW", P2_ROOT + "raw/", root / "raw", filters=filters),
        _rsync("R-16-ALL", P2_ROOT + "all/", root / "all", filters=filters),
        _rsync("R-16-SUMS", P2_ROOT + "SHA256SUMS", root / "SHA256SUMS"),
    ]


def build_plan(phase: str, stage: Path) -> list[Operation]:
    if phase == "p1":
        return build_p1_plan(stage)
    if phase == "p2":
        return build_p2_plan(stage)
    raise FormRefused("phase must be p1 or p2")


_ALLOWED = frozenset(
    [SERVER_PREFIX + US_1M_ROOT + day + "/" for day in TRADING_DAYS]
    + [DECISION_GATE_COMMAND, FILLS_EXPORT_COMMAND, FILLS_READ_GATE_COMMAND,
       P2_RAW_GATE_COMMAND, P2_ALL_GATE_COMMAND, P2_SUMS_GATE_COMMAND]
)


def is_allowed_gate_command(command: str) -> bool:
    return command in _ALLOWED
