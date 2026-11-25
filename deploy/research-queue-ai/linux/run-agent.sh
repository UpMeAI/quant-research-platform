#!/bin/sh
# AUTONOMOUS_RESEARCH_QUEUE_V1 rev 4 §3.6 (Linux agent task, NET): rootless container, no network, no key, no environment.
#   run-agent.sh [<in-dir (task.json, bundle.json)> <out-dir (must not exist; the agent writes it)>]
# As a queue task (Q3b templates) it is started with no arguments by the consumer's wrapper: in = $RQ_ATTEMPT_DIR/in, out = $RQ_ATTEMPT_DIR/out, and a finished
# result.json is published to $RQ_ATTEMPT_DIR/result.json, where the consumer reads it. Nothing is staged here: no in/task.json means a structured refusal (exit 66).
# RQ_AGENT_IMAGE is the lane image built from the merged commit (node:22-bookworm-slim base); it is not defaulted here.
set -eu
IN="${1:-${RQ_ATTEMPT_DIR:?in dir or RQ_ATTEMPT_DIR}/in}"
OUT="${2:-${RQ_ATTEMPT_DIR:?out dir or RQ_ATTEMPT_DIR}/out}"
: "${RQ_AGENT_IMAGE:?RQ_AGENT_IMAGE is required}"
: "${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}"
if [ ! -f "$IN/task.json" ] || [ ! -f "$IN/bundle.json" ]; then
  echo "RQ_AGENT_INPUT_NOT_STAGED: $IN/task.json and bundle.json are required" >&2
  exit 66
fi
mkdir -p "$(dirname "$OUT")"
rc=0
# In a rootless daemon, container uid 0 maps to the unprivileged host user. It is
# required for the host-owned 0600 gateway socket and attempt directory; the
# container still has no host root, no capabilities, no network, and a read-only root.
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 --memory 512m --cpus 0.5 \
  -v "$IN:/in:ro" -v "$(dirname "$OUT"):/out:rw" -v "$XDG_RUNTIME_DIR/rq-gw.sock:/run/rq-gw.sock" \
  --workdir /app --entrypoint node "$RQ_AGENT_IMAGE" services/research-queue-agent/cli.js \
  --task /in/task.json --bundle /in/bundle.json --out "/out/$(basename "$OUT")" --socket /run/rq-gw.sock --host LINUX || rc=$?
if [ "$rc" -eq 0 ] && [ -z "${1:-}" ] && [ -f "$OUT/result.json" ]; then
  cp "$OUT/result.json" "${RQ_ATTEMPT_DIR}/result.json"
fi
exit "$rc"
