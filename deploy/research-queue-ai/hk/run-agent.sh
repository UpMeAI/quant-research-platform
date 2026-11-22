#!/bin/sh
# AUTONOMOUS_RESEARCH_QUEUE_V1 rev 4 §3.6 (HK agent task, NET). Started by the queue consumer's wrapper with no arguments, as a child of
# rq-consumer.service: User=research-queue, NoNewPrivileges, empty capability set, IPAddressDeny=any, AF_UNIX only, research.slice.
# No systemctl, no polkit, no sudo, no second unit: the only reachable thing outside the attempt directory is the gateway's unix socket.
# in = $RQ_ATTEMPT_DIR/in/{task.json,bundle.json}; out = $RQ_ATTEMPT_DIR/out (must not exist); result.json is published to $RQ_ATTEMPT_DIR/result.json.
# Nothing is staged here: no in/task.json means a structured refusal (exit 66). No environment file, no key (the agent refuses to start if it sees one).
set -eu
ATT="${RQ_ATTEMPT_DIR:?RQ_ATTEMPT_DIR is required}"
if [ ! -f "$ATT/in/task.json" ] || [ ! -f "$ATT/in/bundle.json" ]; then
  echo "RQ_AGENT_INPUT_NOT_STAGED: $ATT/in/task.json and bundle.json are required" >&2
  exit 66
fi
rc=0
/opt/node22/bin/node /opt/research-queue/current/services/research-queue-agent/cli.js \
  --task "$ATT/in/task.json" --bundle "$ATT/in/bundle.json" --out "$ATT/out" --socket /run/rq-gw/rq-gw.sock --host HK || rc=$?
if [ "$rc" -eq 0 ] && [ -f "$ATT/out/result.json" ]; then
  cp "$ATT/out/result.json" "$ATT/result.json"
fi
exit "$rc"
