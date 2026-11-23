"""Entry points: python -m rq --config rq.json <command>. Each command is one pass (timers) or a loop (consumer-run)."""
import argparse
import json
import os
import sys
import time

from . import complete, config, consumer, core, pause, producer, relay, runtime, status, templates

EXIT_ENV_MISMATCH = 78


def _open(cfg):
    conn = core.connect(cfg.db_path)
    core.migrate(conn)
    return conn


def _registry(cfg):
    return templates.Registry.load(cfg.templates_path, cfg.pins_path)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="rq")
    ap.add_argument("--config", default=os.environ.get("RQ_CONFIG"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    for c in ("migrate", "producer-tick", "complete-tick", "pause-tick", "status", "verify-chain", "env-manifest"):
        sub.add_parser(c)
    cr = sub.add_parser("consumer-run")
    cr.add_argument("--once", action="store_true")
    a = sub.add_parser("cancel")
    a.add_argument("task_id")
    a.add_argument("--reason", required=True)
    a = sub.add_parser("clear-safety-stop")
    a.add_argument("task_id")
    a = sub.add_parser("reset-circuit")
    a.add_argument("template_id")
    args = ap.parse_args(argv)
    cfg = config.Config.load(args.config)
    now = core.now_cst()
    if args.cmd == "env-manifest":
        print(json.dumps(config.build_manifest(cfg), indent=1, sort_keys=True))
        return 0
    if cfg.install_manifest and args.cmd in ("consumer-run", "producer-tick", "pause-tick"):
        errs = config.verify_environment(json.load(open(cfg.install_manifest)), cfg)
        if errs:
            sys.stderr.write("ENV_MISMATCH " + "; ".join(errs) + "\n")
            return EXIT_ENV_MISMATCH
    conn = _open(cfg)
    if args.cmd == "migrate":
        return 0
    if args.cmd == "producer-tick":
        probes = None
        if cfg.gateway_socket:
            from .probes import GatewayProbes
            probes = GatewayProbes(cfg.gateway_socket)
        # W05: the host marks the pack it admits when RQ_SEEN_MARK_QRP_ROOT names a QRP checkout (apps/research-cli/review_pack_seen.js); unset = not configured here
        print(json.dumps(producer.tick(conn, cfg, _registry(cfg), now, probes, seen_marker=relay.NodeSeenMarker.from_env(os.environ))))
        status.write(conn, cfg, now)
    elif args.cmd == "complete-tick":
        print(json.dumps(complete.tick(conn, cfg, now)))
    elif args.cmd == "pause-tick":
        pauser = pause.Pauser(host=cfg.host)
        print(json.dumps(pause.tick(conn, cfg, now, pauser, pause.ProcSensors(cfg), pause.load_blackouts(cfg.blackouts_path), runtime=runtime.make_runtime(cfg)), default=str))
    elif args.cmd == "status":
        print(json.dumps(status.write(conn, cfg, now), indent=1))
    elif args.cmd == "verify-chain":
        ok, bad = core.verify_chain(conn)
        print(json.dumps({"ok": ok, "bad_seq": bad}))
        return 0 if ok else 1
    elif args.cmd == "consumer-run":
        rt = runtime.make_runtime(cfg)
        sensors = pause.ProcSensors(cfg) if os.path.exists("/proc/meminfo") else None
        while True:
            consumer.tick(conn, cfg, rt, core.now_cst(), sensors=sensors)
            if args.once:
                return 0
            time.sleep(cfg.loop_interval_s)
    elif args.cmd == "cancel":
        core.transition(conn, args.task_id, "CANCELLED", actor="coordinator", now=now, reason=args.reason)
    elif args.cmd == "clear-safety-stop":
        core.transition(conn, args.task_id, "READY", actor="coordinator", now=now, reason="CLEARED_BY_COORDINATOR")
    elif args.cmd == "reset-circuit":
        core.reset_circuit(conn, args.template_id, actor="coordinator", now=now)
    return 0
