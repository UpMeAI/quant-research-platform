#!/usr/bin/env bash
# RF1116 P2 round runner on the research lane (rootless Docker, user kayla). See DEPLOY.md in this directory.
#   run.sh generate <gp_seed> <holdout_sha256>    steps 1-5 (open, seal, generate, mining score, validation selection)
#   run.sh resume   <round_id>                    continue generation of an open round after a crash, then select
#   run.sh mechanisms <round_id> [registrations.jsonl]  R1.5: list the validation survivors; register their mechanisms (before the open)
#   run.sh score    <round_id>                    steps 6-9 (check holdout dir, open vault once, score, G-MINE records, close)
# Both phases: --network none, read-only root fs, all capabilities dropped, no new privileges, uid 1000, CPU/memory/pid limits,
# data mounts read-only, exactly one writable mount (/out). The holdout directory is mounted only by "score".
set -euo pipefail

LANE=/srv/research-lane/rf1116-mining
IMAGE="${RF1116_RUNNER_IMAGE:?set RF1116_RUNNER_IMAGE=qrp-round-runner:<commit12>}"
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/1000/docker.sock}"
LANE_COPY="$LANE/data/rf1116-cn-a-lane-copy-20200601-20260928"
VAL_TAIL="$LANE/data/rf1116-cn-a-daily-20260929-20261016"
HOLDOUT="$LANE/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019"
OUT="$LANE/out"
FACTOR_SERIES="$LANE/data/rf1116-cn-a-live-factor-series"
HOLDOUT_REF="lane:rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019"
AUTHORITY=RF1116_MINING_RUNNER

cmd="${1:?generate|resume|mechanisms|score}"
case "$cmd" in
  generate)
    seed="${2:?gp_seed}"; sums="${3:?sha256 of the holdout SHA256SUMS at seal time}"
    docker run --rm --name "rf1116-generate-$seed" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 6 --memory 24g --memory-swap 24g --pids-limit 256 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$LANE_COPY:/data/lane:ro" -v "$VAL_TAIL:/data/tail:ro" -v "$OUT:/out:rw" "$IMAGE" generate --out /out --lane /data/lane --tail /data/tail --seed "$seed" --holdout-ref "$HOLDOUT_REF" --holdout-sha256 "$sums"
    ;;
  resume)
    round="${2:?round_id}"
    docker run --rm --name "rf1116-resume" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 6 --memory 24g --memory-swap 24g --pids-limit 256 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$LANE_COPY:/data/lane:ro" -v "$VAL_TAIL:/data/tail:ro" -v "$OUT:/out:rw" "$IMAGE" generate --out /out --lane /data/lane --tail /data/tail --resume "$round"
    ;;
  mechanisms)
    round="${2:?round_id}"; reg="${3:-/dev/null}"
    docker run --rm --name "rf1116-mechanisms" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 1 --memory 2g --memory-swap 2g --pids-limit 64 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$OUT:/out:rw" -v "$reg:/data/mechanisms.jsonl:ro" "$IMAGE" mechanisms --out /out --round "$round" --register /data/mechanisms.jsonl
    ;;
  score)
    round="${2:?round_id}"
    docker run --rm --name "rf1116-score" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 6 --memory 24g --memory-swap 24g --pids-limit 256 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$LANE_COPY:/data/lane:ro" -v "$VAL_TAIL:/data/tail:ro" -v "$HOLDOUT:/data/holdout:ro" -v "$FACTOR_SERIES:/data/factor-series:ro" -v "$OUT:/out:rw" "$IMAGE" score --out /out --round "$round" --lane /data/lane --tail /data/tail --holdout /data/holdout --factor-series /data/factor-series
    ;;
  *) echo "usage: run.sh generate <gp_seed> <holdout_sha256> | resume <round_id> | mechanisms <round_id> [file] | score <round_id>" >&2; exit 64 ;;
esac
