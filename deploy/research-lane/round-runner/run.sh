#!/usr/bin/env bash
# RF1116 P2 round runner on the research lane (rootless Docker, user kayla). See DEPLOY.md in this directory.
#   run.sh generate <gp_seed> <holdout_sha256>    steps 1-5 (open, seal, generate, mining score, validation selection)
#   run.sh resume   <round_id>                    continue generation of an open round after a crash, then select
#   run.sh mechanisms <round_id> [registrations.jsonl]  R1.5: list the validation survivors and the mechanism-set sha; register their mechanisms (before the open)
#   run.sh review   <round_id> <verdicts.json>    R1.5: the coordinator's review (MECHANISM_REVIEW_V1); score refuses without it
#   run.sh score    <round_id>                    steps 6-9 (check holdout dir, open vault once, score, G-MINE records, close)
#   run.sh rescore  <round_id> <reason> <crash.log>  R1.8: exactly one same-selection rescore after a crash past the open
#   run.sh fail-evaluation <round_id> <reason> <evidence_sha256>  ★RF1116_ROUND1_STATE (a): close a round that was never evaluated (holdout never opened)
#   run.sh llm-ping                               RF1116 LLM_GEN: one non-formula request to the model endpoint through the LLM step container (opens no round, writes no formula, counts nothing in N)
#   run.sh generate-llm <holdout_sha256>          RF1116 LLM_GEN: steps 1-5 with AI_MINED_LLM (probe, open, seal, generate through the LLM step, validation selection); exit 75 = waiting (key absent, quota, ...), 3 = stopped (caps)
#   run.sh resume-llm   <round_id>                RF1116 LLM_GEN: continue an open LLM round after a waiting state, then select
# Every phase except the LLM step: --network none, read-only root fs, all capabilities dropped, no new privileges, uid 1000, CPU/memory/pid limits,
# data mounts read-only, exactly one writable mount (/out). The holdout directory is mounted only by "score".
# The LLM step (services/mining-llm-step) is the only container with a network (bridge; the process locks egress to the model host, port 443). It mounts exactly two things:
# the research-only key file (read-only) and the exchange directory $OUT/llm-exchange. It never sees data, the ledger, the holdout or any environment variable.
# The generate container for an LLM round stays --network none and talks to the step only through the exchange directory.
set -euo pipefail

LANE=/srv/research-lane/rf1116-mining
IMAGE="${RF1116_RUNNER_IMAGE:?set RF1116_RUNNER_IMAGE=qrp-round-runner:<commit12>}"
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/1000/docker.sock}"
LANE_COPY="$LANE/data/rf1116-cn-a-lane-copy-20200601-20260928"
VAL_TAIL="$LANE/data/rf1116-cn-a-daily-20260929-20261016"
HOLDOUT="$LANE/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019"
R1_HOLDOUT="$LANE/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019"   # the R1 directory itself, whichever segment this run is for
OUT="$LANE/out"
KEY_FILE="/home/kayla/.config/qrp-research-key/deepseek-research.env"
EXCHANGE="$OUT/llm-exchange"
FACTOR_SERIES="$LANE/data/rf1116-cn-a-live-factor-series"
HOLDOUT_REF="lane:rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019"
DAYDROP="$LANE/r2-daydrop"   # R2 data arrival: the V6-side read-only job drops trading_calendar.csv and <YYYYMMDD>/<table>.csv here
# Holdout segment of this run (RF1116 R2 amendment; services/mining-rounds/holdout-segments.js). The default R1 is exactly the three lines above, unchanged.
# The round's segment is chosen by the code from the month the round opens in; this switch only names the sealed directory and its ref, and the code refuses a ref
# that names the other segment's directory before any round is opened (MINE_RUNNER_HOLDOUT_REF_MISMATCH). December rounds run with RF1116_HOLDOUT_SEGMENT=R2.
case "${RF1116_HOLDOUT_SEGMENT:-R1}" in
  R1) ;;
  R2) HOLDOUT="$LANE/holdout-sealed/rf1116-cn-a-daily-holdout-r2"; HOLDOUT_REF="lane:rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-r2" ;;
  *) echo "run.sh: unknown RF1116_HOLDOUT_SEGMENT: ${RF1116_HOLDOUT_SEGMENT} (R1 or R2)" >&2; exit 64 ;;
esac
AUTHORITY=RF1116_MINING_RUNNER

# File arguments become absolute paths before they reach "-v": Docker reads a bare name ("verdicts.json") as a volume
# name, mounts an empty directory and leaves a stray volume. A missing file stops here; docker is never called.
abs_file() {
  local p
  p="$(realpath -e -- "$1" 2>/dev/null)" || { echo "run.sh: no such file: $1" >&2; exit 66; }
  [ -f "$p" ] || [ "$p" = /dev/null ] || { echo "run.sh: not a regular file: $1" >&2; exit 66; }
  printf '%s' "$p"
}
# 复审 #127 P3-1：协调会话的字段排除文件（HOLDOUT_FIELD_EXCLUSIONS_V1）与它的 sha256，只读挂进去；不给就什么都不排除
field_exclusions() {
  EXM=(); EXO=()
  if [ -n "${1:-}" ]; then
    local f; f="$(abs_file "$1")"; [ -n "${2:-}" ] || { echo "run.sh: field exclusions need their sha256" >&2; exit 64; }
    EXM=(-v "$f:/data/field-exclusions.json:ro"); EXO=(--field-exclusions /data/field-exclusions.json --field-exclusions-sha256 "$2")
  fi
}
# RF1116 R2 amendment: an R2 round is scored with the R1 holdout directory as ordinary LIVE history (the feed day 2026-12-31 and the lookbacks live there; R1's holdout has been
# scored by then). R1 runs mount nothing extra.
prior_live() {
  PRIORM=(); PRIORO=()
  if [ "${RF1116_HOLDOUT_SEGMENT:-R1}" = R2 ]; then
    PRIORM=(-v "$R1_HOLDOUT:/data/prior-live:ro"); PRIORO=(--prior-live /data/prior-live)
  fi
}


# RF1116 LLM_GEN. The exchange directory is created by the runner image (mode 0777: the generate container and the step container are different host uids).
llm_init() {
  docker run --rm --name "rf1116-llm-init" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 1 --memory 2g --memory-swap 2g --pids-limit 64 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$OUT:/out:rw" "$IMAGE" llm-init --out /out
}
# Docker's -v CREATES A DIRECTORY for a missing host path, which would turn the key path into a directory (and break the Owner's installer).
# So the key mount exists only when the key file does; without it the step reports FILE_ABSENT and the run waits (exit 75).
llm_key_mount() { KEYM=(); if [ -f "$KEY_FILE" ]; then KEYM=(-v "$KEY_FILE:/run/secrets/deepseek-research.env:ro"); fi; }
# One LLM run at a time. A second run would withdraw the live run's unanswered request (llm-init), or stop its step container (the EXIT trap).
# It fails closed: if docker ps itself fails the container list is unknown, which is not the same as "none running" (exit 74).
llm_busy_check() {
  local busy
  busy="$(docker ps -q --filter name=rf1116-llm-step --filter name=rf1116-generate-llm)" || { echo "run.sh: cannot list containers (docker ps failed); not starting an LLM run" >&2; exit 74; }
  if [ -n "$busy" ]; then
    echo "run.sh: another LLM run is active (rf1116-llm-step or rf1116-generate-llm is running); wait for it or stop it first" >&2
    exit 73
  fi
}
# The step runs as container root (rootless Docker: host uid 1000 = the key file's owner), so it can read the 0600 key file without any capability.
# Once it is up, an EXIT trap stops it: when run.sh exits, and after SIGTERM, SIGHUP or SIGINT as soon as the foreground docker run returns
# (bash defers a trap until the foreground command ends). SIGKILL skips it. The trap is set only after "docker run -d" succeeded, so a failed start
# (for example a name already in use) never stops somebody else's container.
llm_step_up() {
  llm_key_mount
  docker run -d --rm --name "rf1116-llm-step" --network bridge --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL --security-opt no-new-privileges --user 0:0 --cpus 1 --memory 1g --memory-swap 1g --pids-limit 64 ${KEYM[@]+"${KEYM[@]}"} -v "$EXCHANGE:/exchange:rw" --entrypoint node "$IMAGE" services/mining-llm-step/cli.js serve --exchange /exchange
  trap 'docker stop rf1116-llm-step > /dev/null 2>&1 || true' EXIT
  trap 'exit 143' TERM HUP INT
}

cmd="${1:?generate|resume|mechanisms|review|score|rescore|fail-evaluation|llm-ping|generate-llm|resume-llm}"
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
    round="${2:?round_id}"; reg="$(abs_file "${3:-/dev/null}")"
    docker run --rm --name "rf1116-mechanisms" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 1 --memory 2g --memory-swap 2g --pids-limit 64 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$OUT:/out:rw" -v "$reg:/data/mechanisms.jsonl:ro" "$IMAGE" mechanisms --out /out --round "$round" --register /data/mechanisms.jsonl
    ;;
  review)
    round="${2:?round_id}"; verdicts="$(abs_file "${3:?verdicts.json}")"
    docker run --rm --name "rf1116-review" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 1 --memory 2g --memory-swap 2g --pids-limit 64 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$OUT:/out:rw" -v "$verdicts:/data/verdicts.json:ro" "$IMAGE" review --out /out --round "$round" --file /data/verdicts.json
    ;;
  rescore)
    round="${2:?round_id}"; reason="${3:?crash reason}"; crashlog="$(abs_file "${4:?crash log file}")"; field_exclusions "${5:-}" "${6:-}"; prior_live
    docker run --rm --name "rf1116-rescore" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 6 --memory 24g --memory-swap 24g --pids-limit 256 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$LANE_COPY:/data/lane:ro" -v "$VAL_TAIL:/data/tail:ro" -v "$HOLDOUT:/data/holdout:ro" -v "$FACTOR_SERIES:/data/factor-series:ro" -v "$crashlog:/data/crash.log:ro" ${EXM[@]+"${EXM[@]}"} ${PRIORM[@]+"${PRIORM[@]}"} -v "$OUT:/out:rw" "$IMAGE" rescore --out /out --round "$round" --lane /data/lane --tail /data/tail --holdout /data/holdout --factor-series /data/factor-series --reason "$reason" --crash-log /data/crash.log ${EXO[@]+"${EXO[@]}"} ${PRIORO[@]+"${PRIORO[@]}"}
    ;;
  fail-evaluation)
    round="${2:?round_id}"; reason="${3:?reason}"; evidence="${4:?evidence sha256}"
    docker run --rm --name "rf1116-fail-evaluation" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 1 --memory 2g --memory-swap 2g --pids-limit 64 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$OUT:/out:rw" "$IMAGE" fail-evaluation --out /out --round "$round" --reason "$reason" --evidence-sha256 "$evidence"
    ;;
  score)
    round="${2:?round_id}"; field_exclusions "${3:-}" "${4:-}"; prior_live
    docker run --rm --name "rf1116-score" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 6 --memory 24g --memory-swap 24g --pids-limit 256 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$LANE_COPY:/data/lane:ro" -v "$VAL_TAIL:/data/tail:ro" -v "$HOLDOUT:/data/holdout:ro" -v "$FACTOR_SERIES:/data/factor-series:ro" ${EXM[@]+"${EXM[@]}"} ${PRIORM[@]+"${PRIORM[@]}"} -v "$OUT:/out:rw" "$IMAGE" score --out /out --round "$round" --lane /data/lane --tail /data/tail --holdout /data/holdout --factor-series /data/factor-series ${EXO[@]+"${EXO[@]}"} ${PRIORO[@]+"${PRIORO[@]}"}
    ;;
  llm-ping)
    llm_busy_check
    llm_init
    llm_key_mount
    docker run --rm --name "rf1116-llm-ping" --network bridge --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL --security-opt no-new-privileges --user 0:0 --cpus 1 --memory 1g --memory-swap 1g --pids-limit 64 ${KEYM[@]+"${KEYM[@]}"} -v "$EXCHANGE:/exchange:rw" --entrypoint node "$IMAGE" services/mining-llm-step/cli.js ping --exchange /exchange
    ;;
  generate-llm)
    sums="${2:?sha256 of the holdout SHA256SUMS at seal time}"
    llm_busy_check
    llm_init
    llm_step_up
    set +e
    docker run --rm --name "rf1116-generate-llm" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 6 --memory 24g --memory-swap 24g --pids-limit 256 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$LANE_COPY:/data/lane:ro" -v "$VAL_TAIL:/data/tail:ro" -v "$OUT:/out:rw" "$IMAGE" generate --generator AI_MINED_LLM --out /out --lane /data/lane --tail /data/tail --holdout-ref "$HOLDOUT_REF" --holdout-sha256 "$sums"
    rc=$?
    set -e
    exit "$rc"
    ;;
  resume-llm)
    round="${2:?round_id}"
    llm_busy_check
    llm_init
    llm_step_up
    set +e
    docker run --rm --name "rf1116-generate-llm-resume" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 6 --memory 24g --memory-swap 24g --pids-limit 256 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$LANE_COPY:/data/lane:ro" -v "$VAL_TAIL:/data/tail:ro" -v "$OUT:/out:rw" "$IMAGE" generate --generator AI_MINED_LLM --out /out --lane /data/lane --tail /data/tail --resume "$round"
    rc=$?
    set -e
    exit "$rc"
    ;;
  seal-init-r2)
    # the pending seal directory for the R2 holdout (no data exists at 12-01): SEAL_PENDING_V1.json + SHA256SUMS + SHA256SUMS.sealed; prints the sha256 that generate-llm takes. Idempotent.
    "$(cd "$(dirname "$0")" && pwd)/seal-init-r2.sh" "$LANE/holdout-sealed/rf1116-cn-a-daily-holdout-r2"
    ;;
  r2-arrive)
    # RF1116 R2 data arrival: the ONLY writer of the R2 directory (rf1116-cn-a-daily-holdout-r2). Reads the day files the V6-side job dropped in $DAYDROP (read-only), writes the per-day
    # parts, SHA256SUMS lines and the hash chain ARRIVAL_CHAIN_V1.jsonl, and loops until nothing is left, so the daily timer catches up after a missed day. The ledger is mounted read-only
    # (the resolution record gives the window end). No network. Container root is the host owner of the directory (rootless Docker), with no capabilities.
    [ "${RF1116_HOLDOUT_SEGMENT:-R1}" = R2 ] || { echo "run.sh: r2-arrive needs RF1116_HOLDOUT_SEGMENT=R2" >&2; exit 64; }
    docker run --rm --name "rf1116-r2-arrive" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --cap-drop ALL --security-opt no-new-privileges --user 0:0 --cpus 1 --memory 2g --memory-swap 2g --pids-limit 64 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$HOLDOUT:/data/holdout:rw" -v "$DAYDROP:/data/daydrop:ro" -v "$OUT:/out:ro" "$IMAGE" r2-arrive --holdout /data/holdout --driver csv-day-drop --source /data/daydrop
    ;;
  resolve-segment)
    # RF1116 R2: resolve the segment's window from the R2 directory's SSE calendar and write the end-resolution record; NOT_READY (exit 0) until the calendar lists enough days.
    # It reads the calendar file only (no prices, no holdout rows), so the window-pause timer does not pause it.
    [ "${RF1116_HOLDOUT_SEGMENT:-R1}" = R2 ] || { echo "run.sh: resolve-segment needs RF1116_HOLDOUT_SEGMENT=R2" >&2; exit 64; }
    docker run --rm --name "rf1116-resolve-segment" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --cpus 1 --memory 2g --memory-swap 2g --pids-limit 64 -e QRP_DATA_DIR=/out/qrp-data -e QRP_PRODUCT_MILESTONE_AUTHORITY="$AUTHORITY" -v "$HOLDOUT:/data/holdout:ro" -v "$OUT:/out:rw" "$IMAGE" resolve-segment --out /out --segment R2 --holdout /data/holdout
    ;;
  *) echo "usage: run.sh generate <gp_seed> <holdout_sha256> | llm-ping | generate-llm <holdout_sha256> | resume-llm <round_id> | resume <round_id> | mechanisms <round_id> [file] | review <round_id> <verdicts.json> | score <round_id> [field-exclusions.json <sha256>] | rescore <round_id> <reason> <crash.log> [field-exclusions.json <sha256>] | fail-evaluation <round_id> <reason> <evidence_sha256>" >&2; exit 64 ;;
esac
