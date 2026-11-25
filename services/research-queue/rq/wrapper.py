"""Attempt wrapper: `python -m rq.wrapper <attempt_dir> -- argv...`. Runs one task process, records pids and the exit.

The wrapper outlives the consumer (new session), so a consumer crash never kills a task. It writes run.pid, child.pid and, at the end,
exit.json (exit_code / exit_signal / usage). It never touches the queue database: only the consumer does.
"""
import json
import os
import pathlib
import resource
import subprocess
import sys
import time

SECRET_NAME = ("KEY", "TOKEN", "SECRET", "PASSWORD", "DEEPSEEK")


def _atomic(path, text):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def main(argv):
    d = pathlib.Path(argv[1])
    cmd = argv[argv.index("--") + 1:]
    (d / "work").mkdir(exist_ok=True)
    _atomic(d / "run.pid", str(os.getpid()))
    heavy_supervisor = len(cmd) >= 4 and cmd[1:4] == ["-m", "rq", "heavy-run"]
    env = {k: v for k, v in os.environ.items() if (k != "PYTHONPATH" or heavy_supervisor) and not any(s in k.upper() for s in SECRET_NAME)}
    env.update(RQ_ATTEMPT_DIR=str(d), TZ="Asia/Shanghai")
    started = time.time()
    with open(d / "stdout.log", "ab") as out, open(d / "stderr.log", "ab") as err:
        try:
            p = subprocess.Popen(cmd, cwd=str(d / "work"), env=env, stdout=out, stderr=err)
        except OSError as e:
            _atomic(d / "exit.json", json.dumps({"exit_code": 127, "exit_signal": None, "error": str(e), "ended_at": time.time()}))
            return 127
        _atomic(d / "child.pid", str(p.pid))
        rc = p.wait()
    ru = resource.getrusage(resource.RUSAGE_CHILDREN)
    info = {"exit_code": rc if rc >= 0 else None, "exit_signal": -rc if rc < 0 else None, "started_at": started, "ended_at": time.time(),
            "usage": {"source": "rusage", "max_rss_kb": ru.ru_maxrss, "cpu_user_s": ru.ru_utime, "cpu_sys_s": ru.ru_stime}}
    _atomic(d / "exit.json", json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
