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
OUT_PARENT=$(dirname "$OUT")
OUT_NAME=$(basename "$OUT")
mkdir -p "$OUT_PARENT"
if [ -d "$OUT" ] || [ -f "$OUT" ] || [ -L "$OUT" ]; then
  echo "RQ_AGENT_OUTPUT_EXISTS: $OUT" >&2
  exit 73
fi
# Rootless Docker maps container uid 1000 to a subordinate host uid. Give only this
# private exchange directory write permission, then move the completed output into
# the attempt directory; never widen the permissions of the attempt itself.
EXCHANGE=$(mktemp -d "$OUT_PARENT/.rq-agent-out.XXXXXX")
chmod 0777 "$EXCHANGE"
cleanup() {
  if [ -d "$EXCHANGE" ]; then
    docker run --rm --network none --user 1000:1000 -v "$EXCHANGE:/clean:rw" \
      --entrypoint sh "$RQ_AGENT_IMAGE" -c 'find /clean -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +' >/dev/null 2>&1 || true
    rmdir "$EXCHANGE" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM
rc=0
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --memory 512m --cpus 0.5 \
  -v "$IN:/in:ro" -v "$EXCHANGE:/out:rw" -v "$XDG_RUNTIME_DIR/rq-gw.sock:/run/rq-gw.sock" \
  --workdir /app --entrypoint node "$RQ_AGENT_IMAGE" services/research-queue-agent/cli.js \
  --task /in/task.json --bundle /in/bundle.json --out "/out/$OUT_NAME" --socket /run/rq-gw.sock --host LINUX || rc=$?
if [ "$rc" -eq 0 ]; then
  if [ ! -d "$EXCHANGE/$OUT_NAME" ]; then
    echo "RQ_AGENT_OUTPUT_MISSING: $OUT_NAME" >&2
    rc=74
  else
    mv "$EXCHANGE/$OUT_NAME" "$OUT"
  fi
fi
if [ "$rc" -eq 0 ] && [ -z "${1:-}" ] && [ -f "$OUT/result.json" ]; then
  cp "$OUT/result.json" "${RQ_ATTEMPT_DIR}/result.json"
fi
exit "$rc"
