#!/bin/sh
# AUTONOMOUS_RESEARCH_QUEUE_V1 §3.6, HK agent task (Q3c). The queue's NET task process on HK: hand the staged task to rq-agent.service through a spool, wait for the
# result, publish it where the consumer reads it. Runs as a child of rq-consumer.service (User=research-queue); it has no network, no key, no systemctl, no polkit and no sudo.
#   in  = $RQ_ATTEMPT_DIR/in/{task.json,bundle.json}  (staged by the consumer)
#   out = $RQ_SPOOL_DIR/in/<task>-a<n>/   consumer writes (owner), rq-agent reads (group, read only)
#         $RQ_SPOOL_DIR/out/<task>-a<n>/  rq-agent writes (result.json and artifacts, or agent-error.json), the consumer reads
# On success the artifacts go to $RQ_ATTEMPT_DIR/out and result.json to $RQ_ATTEMPT_DIR/result.json. No staged input: exit 66 (RQ_AGENT_INPUT_NOT_STAGED).
# Failure is written as error.json {class, code}: agent crash = D AGENT_EXIT_<n> (exit 70); no answer in time = T1 SPOOL_TIMEOUT (exit 75, the task goes back to READY).
set -eu
ATT="${RQ_ATTEMPT_DIR:?RQ_ATTEMPT_DIR is required}"
SPOOL="${RQ_SPOOL_DIR:-/var/lib/rq-spool}"
POLL="${RQ_SPOOL_POLL_S:-2}"
TIMEOUT="${RQ_SPOOL_TIMEOUT_S:-1800}"
ID="${RQ_TASK_ID:?RQ_TASK_ID is required}-a${RQ_ATTEMPT_NO:?RQ_ATTEMPT_NO is required}"
if [ ! -f "$ATT/in/task.json" ] || [ ! -f "$ATT/in/bundle.json" ]; then
  echo "RQ_AGENT_INPUT_NOT_STAGED: $ATT/in/task.json and bundle.json are required" >&2
  exit 66
fi
fail() { printf '{"class":"%s","code":"%s"}\n' "$1" "$2" > "$ATT/error.json"; rm -rf "$SPOOL/in/$ID"; exit "$3"; }
if [ ! -d "$SPOOL/in/$ID" ] && [ ! -d "$SPOOL/out/$ID" ]; then
  TMP="$SPOOL/in/.tmp-$ID"
  rm -rf "$TMP"
  mkdir "$TMP"
  cp "$ATT/in/task.json" "$ATT/in/bundle.json" "$TMP/"
  mv "$TMP" "$SPOOL/in/$ID"
fi
START=$(date +%s)
while :; do
  if [ -f "$SPOOL/out/$ID/result.json" ]; then
    mkdir -p "$ATT/out"
    cp -R "$SPOOL/out/$ID/." "$ATT/out/"
    cp "$SPOOL/out/$ID/result.json" "$ATT/result.json"
    rm -rf "$SPOOL/in/$ID"
    exit 0
  fi
  if [ -f "$SPOOL/out/$ID/agent-error.json" ]; then
    N=$(sed -n 's/.*"exit_code": *\([0-9][0-9]*\).*/\1/p' "$SPOOL/out/$ID/agent-error.json" | head -n 1)
    fail D "AGENT_EXIT_${N:-UNKNOWN}" 70
  fi
  NOW=$(date +%s)
  if [ $((NOW - START)) -ge "$TIMEOUT" ]; then
    fail T1 SPOOL_TIMEOUT 75
  fi
  sleep "$POLL"
done
