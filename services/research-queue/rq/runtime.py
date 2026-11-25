"""Task runtimes. ProcessRuntime: detached wrapper process (survives the consumer). SystemdRuntime: the same wrapper in a transient user unit
with cgroup caps (Linux). Liveness and exit are read from files the wrapper writes, so any consumer can adopt a running attempt."""
import dataclasses
import json
import os
import pathlib
import signal
import subprocess
import sys
import time

PKG_PARENT = str(pathlib.Path(__file__).resolve().parent.parent)
BASE_ENV = ("PATH", "HOME", "LANG", "LC_ALL")
SECRET_NAME = ("KEY", "TOKEN", "SECRET", "PASSWORD", "DEEPSEEK")
WEIGHT_PROPS = {  # §3.6 caps for Linux tasks
    "W2": ["CPUQuota=600%", "MemoryMax=24G", "Nice=19", "IOSchedulingClass=idle", "CPUAffinity=0-7 16-23"],
    "W1": ["CPUQuota=400%", "MemoryMax=8G", "Nice=10"],
    "W0": ["CPUQuota=100%", "MemoryMax=2G", "Nice=10"], "NET": ["CPUQuota=50%", "MemoryMax=512M", "Nice=10"],
}


@dataclasses.dataclass
class RuntimeStatus:
    started: bool
    alive: bool
    exit: dict = None


def has_prior_driver_result(attempt_dir, attempt_no=None):
    """A heavy run resumes only after an earlier attempt actually reached its driver."""
    current = pathlib.Path(attempt_dir)
    if attempt_no is None:
        prefix = "attempt-"
        if not current.name.startswith(prefix):
            return False
        attempt_no = current.name[len(prefix):]
    try:
        number = int(attempt_no)
    except (TypeError, ValueError):
        return False
    if number <= 1:
        return False
    for prior_no in range(1, number):
        result = current.parent / ("attempt-%d" % prior_no) / "driver-result.json"
        if not result.is_symlink() and result.is_file():
            return True
    return False


def child_env(cfg, attempt_dir, task_id, attempt_no):
    """The only environment a task sees: PATH/HOME/LANG, configured extras, RQ_* ids. Secret-looking names never pass (AQ-34)."""
    names = set(BASE_ENV) | set(cfg.env_allowlist)
    env = {k: os.environ[k] for k in names if k in os.environ and not any(s in k.upper() for s in SECRET_NAME)}
    d = pathlib.Path(attempt_dir)
    env.update(RQ_TASK_ID=task_id, RQ_ATTEMPT_NO=str(attempt_no), RQ_ATTEMPT_DIR=str(d), RQ_RUN_DIR=str(d.parent),
               RQ_PAUSE_FILE=str(d / "PAUSE"), RQ_GATES_FILE=str(d / "GATES"), RQ_CONTAINER_PREFIX="rq-task-%s-" % task_id,
               RQ_RESUME="1" if has_prior_driver_result(d, attempt_no) else "0", TZ="Asia/Shanghai", PYTHONPATH=PKG_PARENT)
    return env


def _ps(pid):
    r = subprocess.run(["ps", "-o", "stat=,command=", "-p", str(pid)], capture_output=True, text=True)
    return r.stdout.strip()


class ProcessRuntime:
    name = "process"

    def __init__(self):
        self._procs = {}

    def start(self, cfg, attempt_dir, argv, task_id, attempt_no, weight_class="W0"):
        d = pathlib.Path(attempt_dir)
        d.mkdir(parents=True, exist_ok=True)
        env = child_env(cfg, d, task_id, attempt_no)
        cmd = [sys.executable, "-m", "rq.wrapper", str(d), "--"] + list(argv)
        self._launch(cmd, env, d, weight_class)
        end = time.time() + 10
        while time.time() < end and not (d / "run.pid").exists():
            time.sleep(0.02)

    def _launch(self, cmd, env, d, weight_class):
        self._procs[str(d)] = subprocess.Popen(cmd, env=env, start_new_session=True, stdin=subprocess.DEVNULL,
                                               stdout=open(d / "wrapper.out", "ab"), stderr=subprocess.STDOUT)

    def status(self, attempt_dir):
        d = pathlib.Path(attempt_dir)
        p = self._procs.get(str(d))
        if p is not None:
            p.poll()  # reap
        ex = d / "exit.json"
        if ex.exists():
            try:
                return RuntimeStatus(True, False, json.loads(ex.read_text()))
            except ValueError:
                pass
        pidf = d / "run.pid"
        if not pidf.exists():
            return RuntimeStatus(False, False, None)
        out = _ps(pidf.read_text().strip())
        alive = bool(out) and not out.startswith("Z") and str(d) in out
        return RuntimeStatus(True, alive, None)

    def stop(self, attempt_dir):
        pidf = pathlib.Path(attempt_dir) / "run.pid"
        if not pidf.exists():
            return
        try:
            os.killpg(int(pidf.read_text().strip()), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, ValueError):
            pass

    def stop_all(self):
        for d in list(self._procs):
            self.stop(d)
            self._procs[d].wait()


class SystemdRuntime(ProcessRuntime):
    """Linux: `systemd-run --user` transient unit in research.slice with the §3.6 caps. run_cmd(argv) -> (rc, out) is injectable."""
    name = "systemd-user"

    def __init__(self, run_cmd=None):
        super().__init__()
        self.run_cmd = run_cmd or (lambda argv: (lambda r: (r.returncode, r.stdout))(subprocess.run(argv, capture_output=True, text=True)))

    def command(self, unit, cmd, env, weight_class):
        props = WEIGHT_PROPS.get(weight_class, WEIGHT_PROPS["W0"])
        c = ["systemd-run", "--user", "--unit=" + unit, "--slice=research.slice", "--collect", "--quiet"]
        for p in props:
            c += ["-p", p]
        for k, v in sorted(env.items()):
            c += ["--setenv=%s=%s" % (k, v)]
        return c + ["--"] + cmd

    def start(self, cfg, attempt_dir, argv, task_id, attempt_no, weight_class="W0"):
        d = pathlib.Path(attempt_dir)
        d.mkdir(parents=True, exist_ok=True)
        env = child_env(cfg, d, task_id, attempt_no)
        unit = "rq-task-%s-a%d" % (task_id, attempt_no)
        cmd = [sys.executable, "-m", "rq.wrapper", str(d), "--"] + list(argv)
        rc, out = self.run_cmd(self.command(unit, cmd, env, weight_class))
        if rc != 0:
            raise OSError("systemd-run failed: " + str(out)[:200])
        end = time.time() + 10
        while time.time() < end and not (d / "run.pid").exists():
            time.sleep(0.05)

    def stop(self, attempt_dir):
        self.run_cmd(["systemctl", "--user", "kill", "--signal=SIGKILL", "rq-task-" + pathlib.Path(attempt_dir).parent.name + "-a" + pathlib.Path(attempt_dir).name.split("-")[1] + ".service"])
        super().stop(attempt_dir)


def make_runtime(cfg):
    return SystemdRuntime() if cfg.runtime == "systemd-user" else ProcessRuntime()
