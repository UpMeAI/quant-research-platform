"""Pause hooks (§3.5): one pause authority per host. Windows, the blackout calendar and brakes decide; the pauser touches only allowlisted names.

A pause is not a crash: the task goes RUNNING -> PAUSED with its lease extended before anything is frozen, and PAUSED -> RUNNING after thaw.
It replaces rf1116-window-pause (★RQ8): the four rf1116 container names are paused here too, by window and blackout only.
"""
import collections
import datetime as dt
import json
import os
import pathlib
import re
import shutil
import subprocess

from . import core

# Names the pause authority must never touch (documented here, enforced by the allowlist: anything not allowed is refused).
NEVER_TOUCH = ("ashare-v6-", "c3fwd-", "q73", "postgres", "pm2", "portfolio-desk")
LINUX_WINDOWS = (("0630", "0800", "RF1116_0630"), ("0915", "1530", "TRADING_SESSION"), ("1810", "2130", "POST_CLOSE_TAIL"))
LINUX_IO_WINDOW = ("0015", "0115", "EVE_EXPORT")
HK_ALLOWED = ("1045", "2145")
BRAKE_HOLD = dt.timedelta(minutes=10)
Blackout = collections.namedtuple("Blackout", "id start end hosts mode")


def _hm(now):
    return now.strftime("%H%M")


def window_reason(host, now, io=False):
    """Return a reason string if tasks of this host must not run at `now`, else None. Times are CST."""
    t = _hm(now)
    if host == "LINUX":
        if now.weekday() < 5:
            for a, b, name in LINUX_WINDOWS:
                if a <= t < b:
                    return "WINDOW:" + name
            if io and LINUX_IO_WINDOW[0] <= t < LINUX_IO_WINDOW[1]:
                return "WINDOW:" + LINUX_IO_WINDOW[2]
        return None
    if not (HK_ALLOWED[0] <= t < HK_ALLOWED[1]):
        if now.weekday() == 0 and "0955" <= t < "1045":
            return "WINDOW:HK_MON_REVIEW_SCAN"
        return "WINDOW:HK_OUTSIDE_NET_WINDOW"
    return None


# ---------------------------------------------------------------- blackouts
def parse_blackouts(doc):
    out = []
    for e in (doc or {}).get("entries", []):
        if e.get("mode") not in ("FREEZE", "STOP") or not e.get("id") or not e.get("hosts"):
            raise ValueError("bad blackout entry: %r" % (e,))
        s, t = core.parse_iso(e["start"]), core.parse_iso(e["end"])
        if t <= s:
            raise ValueError("blackout ends before it starts: " + e["id"])
        out.append(Blackout(e["id"], s, t, tuple(e["hosts"]), e["mode"]))
    return out


def load_blackouts(path):
    if not path or not pathlib.Path(path).exists():
        return []
    return parse_blackouts(json.loads(pathlib.Path(path).read_text()))


def blackout_at(blackouts, host, now):
    for b in blackouts or []:
        if host in b.hosts and b.start <= now < b.end:
            return b
    return None


# ---------------------------------------------------------------- brakes
class ProcSensors:
    """Real sensors from /proc and statvfs. Any that cannot be read returns None (UNKNOWN, never CLEAR)."""
    def __init__(self, cfg):
        self.cfg = cfg

    def mem_available_gib(self):
        try:
            for line in open("/proc/meminfo"):
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 2**20
        except OSError:
            return None

    def load5(self):
        try:
            return float(open("/proc/loadavg").read().split()[1])
        except (OSError, IndexError, ValueError):
            return None

    def _free(self, path):
        try:
            return shutil.disk_usage(path).free / 2**30
        except OSError:
            return None

    def lane1_free_gib(self):
        return self._free(self.cfg.lane1_path)

    def disk_free_gib(self):
        return self._free("/")

    def pm2_recent_restart(self):
        try:
            r = subprocess.run(["pm2", "jlist"], capture_output=True, text=True, timeout=10)
            procs = json.loads(r.stdout[r.stdout.index("["):])
        except (OSError, ValueError, subprocess.SubprocessError):
            return None
        now_ms = core.now_cst().timestamp() * 1000
        return any(now_ms - p.get("pm2_env", {}).get("pm_uptime", 0) < BRAKE_HOLD.total_seconds() * 1000 for p in procs)

    def nvme_read_await_ms_20min(self):
        """Mean read latency over the last 20 minutes from /proc/diskstats samples kept in the pause state file."""
        try:
            for line in open("/proc/diskstats"):
                f = line.split()
                if f[2] == self.cfg.io_device:
                    reads, ms = int(f[3]), int(f[6])
                    break
            else:
                return None
        except (OSError, IndexError, ValueError):
            return None
        p = self.cfg.state_dir / "io-samples.json"
        try:
            samples = json.loads(p.read_text())
        except (OSError, ValueError):
            samples = []
        now = core.now_cst().timestamp()
        samples = [s for s in samples if now - s[0] <= 3600] + [[now, reads, ms]]
        p.write_text(json.dumps(samples))
        old = [s for s in samples if now - s[0] >= 20 * 60]
        if not old:
            return None
        base = old[-1]
        return (ms - base[2]) / (reads - base[1]) if reads > base[1] else 0.0


def evaluate_brakes(host, sensors, state, now):
    """Return {brake: CLEAR|TRIPPED|UNKNOWN}. `state` carries the HK 10-clear-minutes hold and is mutated."""
    def judge(v, tripped):
        return "UNKNOWN" if v is None else ("TRIPPED" if tripped(v) else "CLEAR")

    if host == "LINUX":
        return {"IO_AWAIT": judge(sensors.nvme_read_await_ms_20min(), lambda v: v > 10.0),
                "MEM": judge(sensors.mem_available_gib(), lambda v: v < 16.0),
                "LANE1_FREE": judge(sensors.lane1_free_gib(), lambda v: v < 200.0)}
    b = {"LOAD5": judge(sensors.load5(), lambda v: v > 3.0), "MEM": judge(sensors.mem_available_gib(), lambda v: v < 1.5),
         "PM2_RESTART": judge(sensors.pm2_recent_restart(), lambda v: v is True), "DISK": judge(sensors.disk_free_gib(), lambda v: v < 20.0)}
    if "TRIPPED" in b.values():
        state["last_trip"] = core.iso(now)
    elif state.get("last_trip") and now - core.parse_iso(state["last_trip"]) < BRAKE_HOLD:
        b["HOLD_10MIN"] = "TRIPPED"
    return b


def pause_reason(host, row, now, blackouts, brakes, claim=False, windows=True):
    """Why this task must not run now (None = may run). claim=True also applies claim-only gates and treats UNKNOWN brakes as closed."""
    bo = blackout_at(blackouts, host, now)
    if bo:
        return "BLACKOUT:" + bo.id
    io = row["io_class"] in ("LANE1_DB", "LANE1_FILES")
    if windows:
        w = window_reason(host, now, io=io)
        if w:
            return w
    bad = ("TRIPPED", "UNKNOWN") if claim else ("TRIPPED",)
    b = brakes or {}
    if host == "HK":
        for k, v in b.items():
            if v in bad:
                return "BRAKE:" + k
        return None
    if io and b.get("IO_AWAIT") in bad:
        return "BRAKE:IO_AWAIT"
    if row["weight_class"] == "W2" and b.get("MEM") in bad:
        return "BRAKE:MEM"
    if claim and io and b.get("LANE1_FREE") in bad:
        return "BRAKE:LANE1_FREE"
    return None


# ---------------------------------------------------------------- allowlist and pauser
_UNIT_OK = (re.compile(r"rq-task-[A-Za-z0-9_.@:-]+\.service"), re.compile(r"rq-agent[A-Za-z0-9_.@-]*\.service"), re.compile(r"rq-consumer\.service"))
_DOCKER_OK = (re.compile(r"rq-task-[A-Za-z0-9_.-]+"), re.compile(r"rq-agent[A-Za-z0-9_.-]*"))
_RF1116 = (re.compile(r"rf1116-generate-[A-Za-z0-9_.-]+"), re.compile(r"rf1116-resume"), re.compile(r"rf1116-score"), re.compile(r"rf1116-rescore"))


def allowed_target(host, kind, name):
    pats = _UNIT_OK if kind == "unit" else (_DOCKER_OK + (_RF1116 if host == "LINUX" else ())) if kind == "docker" else ()
    return any(p.fullmatch(name) for p in pats)


class PauseFailed(Exception):
    pass


def _default_run(argv):
    env = dict(os.environ)
    env.setdefault("DOCKER_HOST", "unix:///run/user/%d/docker.sock" % os.getuid())
    r = subprocess.run(argv, capture_output=True, text=True, env=env, timeout=30)
    return r.returncode, r.stdout


class Pauser:
    def __init__(self, run_cmd=None, host="LINUX"):
        self.run, self.host = run_cmd or _default_run, host

    def _do(self, verb, kind, name):
        if not allowed_target(self.host, kind, name):
            raise ValueError("pause target not allowlisted: %s %s" % (kind, name))
        if kind == "unit":
            argv = ["systemctl"] + (["--user"] if self.host == "LINUX" else []) + [verb, name]
        else:
            argv = ["docker", "pause" if verb == "freeze" else "unpause", name]
        rc, out = self.run(argv)
        if rc != 0:
            raise PauseFailed("%s failed (%d)" % (" ".join(argv), rc))

    def freeze(self, kind, name):
        self._do("freeze", kind, name)

    def thaw(self, kind, name):
        self._do("thaw", kind, name)

    def containers(self):
        rc, out = self.run(["docker", "ps", "--format", "{{.Names}} {{.State}}"])
        res = []
        for line in (out or "").replace(";", "\n").splitlines():
            p = line.split()
            if len(p) == 2 and allowed_target(self.host, "docker", p[0]):
                res.append((p[0], p[1]))
        return res


# ---------------------------------------------------------------- tick
def state_path(cfg):
    return cfg.state_dir / "pause-state.json"


def load_state(cfg, path=None):
    try:
        return json.loads(pathlib.Path(path or state_path(cfg)).read_text())
    except (OSError, ValueError):
        return {}


def _target(cfg, attempt):
    runtime, unit = attempt
    if runtime == "systemd-user":
        return ("unit", unit + ".service")
    return ("unit", cfg.process_pause_unit)


def tick(conn, cfg, now, pauser, sensors, blackouts, state_file=None, runtime=None):
    """One pause-controller pass. Returns what it did."""
    path = pathlib.Path(state_file) if state_file else state_path(cfg)
    state = load_state(cfg, path)
    brakes = evaluate_brakes(cfg.host, sensors, state, now) if sensors is not None else {}
    state["brakes"], state["at"] = brakes, core.iso(now)
    res = {"paused": [], "thawed": [], "stopped": [], "failed": [], "brakes": brakes}
    cur = conn.execute("select t.*, a.runtime as a_runtime, a.unit_or_container as a_unit from task t left join attempt a on a.task_id=t.task_id and a.attempt_no=t.attempt_no"
                       " where t.state in ('RUNNING','PAUSED')")
    cols = [c[0] for c in cur.description]
    for r in cur.fetchall():
        row = dict(zip(cols, r))
        tid = row["task_id"]
        reason = pause_reason(cfg.host, row, now, blackouts, brakes, windows=getattr(cfg, "apply_windows", True))
        target = _target(cfg, (row["a_runtime"], row["a_unit"]))
        bo = blackout_at(blackouts, cfg.host, now)
        if bo and bo.mode == "STOP" and runtime is not None:
            d = cfg.runs_dir / tid / ("attempt-%d" % row["attempt_no"])
            runtime.stop(d)
            conn.execute("update attempt set ended_at=?, error_code=? where task_id=? and attempt_no=?", (core.iso(now), "BLACKOUT_STOP:" + bo.id, tid, row["attempt_no"]))
            core.transition(conn, tid, "READY", actor="rq-pause", now=now, reason="BLACKOUT_STOP:" + bo.id, fields={"not_before": core.iso(bo.end)})
            res["stopped"].append(tid)
        elif reason and row["state"] == "RUNNING":
            core.transition(conn, tid, "PAUSED", actor="rq-pause", now=now, reason=reason, fields={"lease_expires_at": core.iso(now + dt.timedelta(seconds=cfg.lease_ttl_s))})
            try:
                pauser.freeze(*target)
                res["paused"].append(tid)
            except (PauseFailed, ValueError):
                core.transition(conn, tid, "RUNNING", actor="rq-pause", now=now, reason="PAUSE_FAILED")
                res["failed"].append(tid)
        elif reason and row["state"] == "PAUSED":
            core.extend_lease(conn, tid, now, cfg.lease_ttl_s)
        elif not reason and row["state"] == "PAUSED":
            try:
                pauser.thaw(*target)
            except (PauseFailed, ValueError):
                res["failed"].append(tid)
                core.extend_lease(conn, tid, now, cfg.lease_ttl_s)
                continue
            core.transition(conn, tid, "RUNNING", actor="rq-pause", now=now, reason="THAW", fields={"lease_expires_at": core.iso(now + dt.timedelta(seconds=cfg.lease_ttl_s))})
            res["thawed"].append(tid)
    if cfg.host == "LINUX":
        want = window_reason("LINUX", now) or ("BLACKOUT" if blackout_at(blackouts, "LINUX", now) else None)
        want = None if not getattr(cfg, "apply_windows", True) and not blackout_at(blackouts, "LINUX", now) else want
        try:
            for name, st in pauser.containers():
                if not allowed_target("LINUX", "docker", name) or not name.startswith("rf1116-"):
                    continue
                if want and st == "running":
                    pauser.freeze("docker", name)
                    res["paused"].append(name)
                elif not want and st == "paused":
                    pauser.thaw("docker", name)
                    res["thawed"].append(name)
        except (PauseFailed, ValueError):
            res["failed"].append("rf1116")
    path.write_text(json.dumps(state))
    return res
