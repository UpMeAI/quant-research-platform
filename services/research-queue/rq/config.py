"""Host configuration and the install-manifest check (AQ-27). No secrets live in a config file."""
import dataclasses
import getpass
import hashlib
import json
import os
import pathlib
import sys

from . import core, guard

HOSTS = ("LINUX", "HK")


@dataclasses.dataclass
class Config:
    host: str
    root: pathlib.Path
    state_dir: pathlib.Path = None
    runs_dir: pathlib.Path = None
    inbox_dir: pathlib.Path = None
    outbox_dir: pathlib.Path = None
    db_path: pathlib.Path = None
    lease_ttl_s: int = 600
    heartbeat_s: int = 60
    loop_interval_s: float = 5.0
    worker: str = "rq-consumer"
    runtime: str = "process"                      # process | systemd-user
    process_pause_unit: str = "rq-consumer.service"
    templates_path: str = None
    pins_path: str = None
    blackouts_path: str = None
    gateway_db: str = None
    install_manifest: str = None
    env_allowlist: list = dataclasses.field(default_factory=list)
    lane1_path: str = "/srv/research-lane"
    io_device: str = "nvme2n1"
    apply_windows: bool = True                    # tests only; production keeps it True
    gateway_socket: str = None

    def __post_init__(self):
        if self.host not in HOSTS:
            raise ValueError("host must be LINUX or HK")
        self.root = pathlib.Path(self.root)
        self.state_dir = pathlib.Path(self.state_dir) if self.state_dir else self.root / "state"
        self.runs_dir = pathlib.Path(self.runs_dir) if self.runs_dir else self.root / "runs"
        self.inbox_dir = pathlib.Path(self.inbox_dir) if self.inbox_dir else self.root / "inbox"
        self.outbox_dir = pathlib.Path(self.outbox_dir) if self.outbox_dir else self.root / "outbox"
        self.db_path = pathlib.Path(self.db_path) if self.db_path else self.state_dir / "queue.sqlite"
        for p in (self.root, self.state_dir, self.runs_dir, self.inbox_dir, self.outbox_dir, self.db_path, self.gateway_db, self.templates_path):
            if p:
                guard.check_path(p)
        for d in (self.state_dir, self.runs_dir, self.inbox_dir, self.outbox_dir):
            d.mkdir(parents=True, exist_ok=True)

    @property
    def status_path(self):
        return self.state_dir / "status.json"

    def to_dict(self):
        d = dataclasses.asdict(self)
        return {k: (str(v) if isinstance(v, pathlib.Path) else v) for k, v in d.items()}

    @classmethod
    def load(cls, path):
        d = json.loads(pathlib.Path(path).read_text())
        known = {f.name for f in dataclasses.fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in known})


def _code_sha256():
    h = hashlib.sha256()
    pkg = pathlib.Path(__file__).parent
    for p in sorted(list(pkg.glob("*.py")) + [pkg / "schema.sql"]):
        h.update(p.name.encode() + b"\0" + p.read_bytes() + b"\0")
    return h.hexdigest()


def actual_environment(cfg):
    return {"host_role": cfg.host, "python_major_minor": "%d.%d" % sys.version_info[:2], "home": os.path.expanduser("~"),
            "user": getpass.getuser(), "executable": os.path.realpath(sys.executable), "schema_sha256": core.schema_sha256(),
            "code_sha256": _code_sha256()}


def build_manifest(cfg):
    """The install manifest the coordinator freezes at install time (written once, then compared on every start)."""
    return actual_environment(cfg)


def verify_environment(manifest, cfg):
    actual = actual_environment(cfg)
    return ["%s: manifest %r != actual %r" % (k, manifest.get(k), actual[k]) for k in actual if manifest.get(k) != actual[k]]
