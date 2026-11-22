"""Evaluators for the install-time cap proofs (AQ-17H on HK, AQ-17L on Linux). deploy/research-queue/cap-proof.sh gathers the measurements."""


def _need(m, keys):
    return ["%s missing" % k for k in keys if k not in m or m[k] is None]


def evaluate(host, m):
    """Return a list of failures (empty = pass). Missing evidence is a failure."""
    if host == "LINUX":
        errs = _need(m, ["cpu_seconds", "window_s", "quota_cpus", "burner_cpus", "oom_kill", "cgroup_parent_result"])
        if errs:
            return errs
        if m["cpu_seconds"] > 1.05 * m["quota_cpus"] * m["window_s"]:
            errs.append("cpu_seconds %.1f exceeds 1.05 x quota" % m["cpu_seconds"])
        if m["burner_cpus"] <= m["quota_cpus"]:
            errs.append("burner_cpus must exceed the quota to prove a cap")
        if m["oom_kill"] < 1:
            errs.append("oom_kill: the memory cap did not fire")
        return errs
    errs = _need(m, ["cpu_seconds", "window_s", "oom_kill", "peak_bytes", "pm2_restarts", "new_error_lines", "load5", "agent_tcp_connect", "db_from_rq"])
    if errs:
        return errs
    if m["cpu_seconds"] > 1.05 * m["window_s"]:
        errs.append("cpu_seconds %.1f exceeds 1.05 x window (1 CPU)" % m["cpu_seconds"])
    if m["oom_kill"] < 1 or m["peak_bytes"] > 512 * 2**20:
        errs.append("oom_kill/peak_bytes: need oom_kill >= 1 with peak <= 512 MiB")
    if m["pm2_restarts"] != 0:
        errs.append("pm2_restarts must be 0")
    if m["new_error_lines"] != 0:
        errs.append("new_error_lines must be 0")
    if not m["load5"] < 3.0:
        errs.append("load5 must be < 3.0")
    if m["agent_tcp_connect"] != "EPERM":
        errs.append("agent_tcp_connect must fail with EPERM")
    if m["db_from_rq"] != "UNREACHABLE":
        errs.append("db_from_rq must be UNREACHABLE")
    return errs
