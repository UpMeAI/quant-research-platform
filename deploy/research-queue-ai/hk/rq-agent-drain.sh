#!/bin/sh
# AUTONOMOUS_RESEARCH_QUEUE_V1 §3.6, HK rq-agent.service (oneshot, started by rq-agent.timer in the off-peak hours; Q3c). Drains the spool: runs the tool-less agent once
# for every staged task that has no output yet, writes its output under the spool's out/, and exits. User=rq-agent, no network but the gateway's unix socket, no key.
# in/ is mounted read-only; out/ is the only writable place. `in/.pause` (written by the root pause authority while the queue is paused) stops the drain.
# An agent failure becomes out/<id>/agent-error.json {exit_code}; the consumer-side client turns it into a structured deterministic error. Old outputs are pruned here (the agent owns them).
set -u
SPOOL="${RQ_SPOOL_DIR:-/var/lib/rq-spool}"
NODE="${RQ_NODE:-/opt/node22/bin/node}"
CLI="${RQ_AGENT_CLI:-/opt/research-queue/current/services/research-queue-agent/cli.js}"
SOCK="${RQ_GW_SOCKET:-/run/rq-gw/rq-gw.sock}"
[ -e "$SPOOL/in/.pause" ] && exit 0
for d in "$SPOOL"/in/*/; do
  [ -d "$d" ] || continue
  id=$(basename "$d")
  [ -e "$SPOOL/out/$id" ] && continue
  [ -e "$SPOOL/in/.pause" ] && exit 0
  [ -f "$d/task.json" ] && [ -f "$d/bundle.json" ] || continue
  if "$NODE" "$CLI" --task "$d/task.json" --bundle "$d/bundle.json" --out "$SPOOL/out/$id" --socket "$SOCK" --host HK; then
    :
  else
    rc=$?
    mkdir -p "$SPOOL/out/$id"
    printf '{"exit_code":%s}\n' "$rc" > "$SPOOL/out/$id/agent-error.json"
  fi
done
find "$SPOOL/out" -mindepth 1 -maxdepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
exit 0
