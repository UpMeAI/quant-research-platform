#!/bin/sh
# AUTONOMOUS_RESEARCH_QUEUE_V1 rev 4 §3.6 (Linux agent task, NET): rootless container, no network, no key, no environment.
#   run-agent.sh <in-dir (task.json, bundle.json)> <out-dir (must not exist; the agent writes it)>
# RQ_AGENT_IMAGE is the lane image built from the merged commit (node:22-bookworm-slim base); it is not defaulted here.
set -eu
IN="${1:?in dir}"; OUT="${2:?out dir}"
: "${RQ_AGENT_IMAGE:?RQ_AGENT_IMAGE is required}"
: "${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}"
mkdir -p "$(dirname "$OUT")"
exec docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --memory 512m --cpus 0.5 \
  -v "$IN:/in:ro" -v "$(dirname "$OUT"):/out:rw" -v "$XDG_RUNTIME_DIR/rq-gw.sock:/run/rq-gw.sock" \
  --workdir /app --entrypoint node "$RQ_AGENT_IMAGE" services/research-queue-agent/cli.js \
  --task /in/task.json --bundle /in/bundle.json --out "/out/$(basename "$OUT")" --socket /run/rq-gw.sock --host LINUX
