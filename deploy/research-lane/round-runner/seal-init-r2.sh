#!/bin/bash
# RF1116 second CN_A holdout segment (R2): the PENDING seal. At 12-01 R2 has no data (its window starts after 2026-12-31), so what is sealed is only a statement that the directory
# and the rule existed before any data: SEAL_PENDING_V1.json, its SHA256SUMS line, and SHA256SUMS.sealed (a copy of that one line). The data files arrive later and are APPENDED to
# SHA256SUMS by the export program; the scorer's directory check then treats the sealed line as the sealed prefix (it must still be there, unchanged).
#
#   seal-init-r2.sh <directory>     creates <directory> with the three files and prints the sha256 of SHA256SUMS.sealed (the <holdout_sha256> that `run.sh generate-llm` takes)
# Idempotent: when the directory already holds SEAL_PENDING_V1.json and SHA256SUMS.sealed it prints that sha256 and changes nothing. A directory that exists and is anything else is not
# touched (exit 3). The directory and files are world-readable (the scorer container runs as another uid); writing stays with the owner.
set -euo pipefail
DIR="${1:?usage: seal-init-r2.sh <R2 sealed directory>}"
if [ -e "$DIR" ]; then
  if [ -f "$DIR/SEAL_PENDING_V1.json" ] && [ -f "$DIR/SHA256SUMS.sealed" ]; then
    sha256sum "$DIR/SHA256SUMS.sealed" | cut -d' ' -f1
    exit 0
  fi
  echo "seal-init-r2: $DIR exists and is not a seal-init directory; not touching it" >&2
  exit 3
fi
mkdir -p "$DIR"
sealed_at="$(TZ=Asia/Shanghai date +%Y-%m-%dT%H:%M:%S+08:00)"
printf '{"schema":"HOLDOUT_SEAL_PENDING_V1","segment":"R2","market":"CN_A","data":"NONE_AT_SEAL_TIME","start_rule":"FIRST_TRADING_DAY_AFTER","start_after":"2026-12-31","length_trading_days":54,"end":"UNKNOWN / CALENDAR_NOT_PUBLISHED","sealed_at":"%s"}\n' "$sealed_at" > "$DIR/SEAL_PENDING_V1.json"
( cd "$DIR" && sha256sum SEAL_PENDING_V1.json > SHA256SUMS && cp SHA256SUMS SHA256SUMS.sealed )
chmod 0755 "$DIR"
chmod 0644 "$DIR/SEAL_PENDING_V1.json" "$DIR/SHA256SUMS" "$DIR/SHA256SUMS.sealed"
sha256sum "$DIR/SHA256SUMS.sealed" | cut -d' ' -f1
