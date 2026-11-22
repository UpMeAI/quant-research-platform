import hashlib, json, os, pathlib, sys, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "research-queue"))
from rq import core, config, templates, producer, consumer, pause, status, guard, complete, runtime  # noqa: E402

STUB = str(pathlib.Path(__file__).with_name("stub_task.py"))
PY = sys.executable
CST = core.CST


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def at(h, m=0, day=24, month=11, s=0):
    """A CST time. 2026-11-24 is a Tuesday, 2026-11-28 a Saturday, 2026-11-23 a Monday."""
    import datetime as dt
    return dt.datetime(2026, month, day, h, m, s, tzinfo=CST)


def tpl(template_id, **over):
    t = {
        "template_id": template_id, "version": 1, "kinds": ["STUB"], "producer_host": "LINUX", "run_host": "LINUX",
        "agent_host": "LINUX", "weight_class": "W0", "io_class": "NONE",
        "argv": [PY, STUB, "{mode}"], "params": {"mode": "^[A-Za-z0-9_]+$"},
        "inputs": [], "outputs": ["result.json"], "expected_duration_s": 60,
        "evidence_matrix": {"id": "EM-STUB", "sha256": sha("em-stub")}, "authority_shas": [],
        "prompt_admission_sha256": None, "idempotent": True, "transient_budget": 2,
        "completion": "SELF_VALIDATED", "requires_trl": False, "markets": ["NONE"], "subject_keys": ["n"],
    }
    t.update(over)
    return t


def gen_tpl():
    return tpl("T-STUB-GEN-V1", kinds=["MINING_GENERATE"], idempotent=False,
               argv=[PY, STUB, "generate", "{round_id}"], params={"round_id": "^[A-Za-z0-9-]+$"},
               recovery_argv=[PY, STUB, "resume", "{round_id}"], recovery_max=2)


def score_tpl():
    return tpl("T-STUB-SCORE-V1", kinds=["MINING_SCORE"], idempotent=False,
               argv=[PY, STUB, "score", "{round_id}"], params={"round_id": "^[A-Za-z0-9-]+$"},
               recovery_argv=[PY, STUB, "rescore", "{round_id}"], recovery_max=1)


def net_tpl(tid="T-STUB-NET-V1", **over):
    d = dict(kinds=["AI_REVIEW_CARD"], weight_class="NET", agent_host="BY_MARKET", run_host="BY_MARKET", markets=["CN_A", "US_EQUITY", "CRYPTO"], producer_host="BY_MARKET")
    d.update(over)
    return tpl(tid, **d)


def registry(templates_list, pin=True):
    pins = [{"template_id": t["template_id"], "template_sha256": templates.template_sha256(t)} for t in templates_list] if pin else []
    return templates.Registry(templates_list, pins)


def req(tid_or_tpl, subject=None, params=None, market="NONE", **over):
    t = tid_or_tpl if isinstance(tid_or_tpl, dict) else {"template_id": tid_or_tpl}
    r = {"template_id": t["template_id"], "template_sha256": templates.template_sha256(t) if "version" in t else "x",
         "market": market, "subject": subject or {"n": 1}, "params": params if params is not None else {"mode": "ok"}, "inputs": [], "depends_on": [],
         "priority": 50}
    r.update(over)
    return r


class Base(unittest.TestCase):
    host = "LINUX"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = pathlib.Path(self._tmp.name)
        self.cfg = config.Config(host=self.host, root=self.root, lease_ttl_s=600, env_allowlist=["STUB_SLEEP"])
        self.conn = core.connect(self.cfg.db_path)
        core.migrate(self.conn)
        self.t0 = at(10, 0, day=28)  # Saturday: no V6 windows

    def admit(self, reg, request, now=None):
        return producer.admit(self.conn, self.cfg, reg, request, now or self.t0)

    def row(self, task_id):
        self.conn.row_factory = __import__("sqlite3").Row
        try:
            return self.conn.execute("select * from task where task_id=?", (task_id,)).fetchone()
        finally:
            self.conn.row_factory = None

    def state(self, task_id):
        return self.row(task_id)["state"]


def drive(base, rt, now, task_id, timeout=20, **kw):
    """Tick the consumer at a fixed (fake) time until the task leaves CLAIMED/RUNNING."""
    import time
    end = time.time() + timeout
    while time.time() < end:
        consumer.tick(base.conn, base.cfg, rt, now, **kw)
        if base.state(task_id) not in ("CLAIMED", "RUNNING"):
            return base.state(task_id)
        time.sleep(0.1)
    raise AssertionError("task still %s" % base.state(task_id))
