#!/bin/bash
# RF1116 r2-day-export (plan-coord 2026-11-23): the V6-side, READ-ONLY job that exports trading days of V6's canonical data into the drop directory the lane's arrival program reads
# (CSV_DAY_DROP, services/mining-sandbox/round-runner/arrival.js). It never writes to V6: every statement is a SELECT or COPY (SELECT ...) TO STDOUT, the session is
# default_transaction_read_only=on (PGOPTIONS, checked before anything else); nothing in this script changes the session's read-only state.
#
#   r2-day-export.sh [--segment R1|R2|all] [--day YYYY-MM-DD]
#
#   R1   the days after the sealed export's D1 (2026-11-17) up to 2026-12-31 (catch-up: every open day that is ready and not exported yet, in calendar order, so the first run after
#        install fills 11-18.. and later runs add the new day). The R1 calendar was sealed: not exported.
#   R2   the first 54 SSE open days after 2026-12-31, plus trading_calendar.csv (the arrival program takes the calendar first).
#   A day is exported only if it is an SSE open day of the segment's window AND the day is ready by R2_DAY_EXPORT_READINESS_V2.sql (ops-coord; plan-coord ruling 11-23 option (b); byte-identical; >= 4000 names in the three tables, a coverage row, POST_CLOSE(D) OK or the next PREMARKET OK; its row is recorded in READINESS.json) AND its
#   prices query returns rows. One directory per day, <drop>/<segment>/<YYYYMMDD>/, written under a temp name and renamed (the lane never sees a partial day), with a SHA256SUMS of its
#   seven tables; an exported day is never exported again (idempotent). The SQL is the arrival program's PG query set (sql/*.sql, one producer: tests compare it with arrival.js pgQueries).
#
# Exit codes: 0 done / caught up / days still waiting for V6's POST_CLOSE; 2 psql failed or the session is not read-only; 3 a refusal (--day: not an open day of the window, not ready);
#             4 a day has been waiting for more than 3 days (the alert: the unit fails and ops-coord looks).
# Configuration (r2-day-export.env, see r2-day-export.env.example): R2EXP_PG_CONTAINER, R2EXP_PG_USER, R2EXP_PG_DB (the V6 Postgres container, V6's own existing DB account and database), R2EXP_DROP_ROOT,
# R2EXP_TIMEOUT (seconds per psql call, default 600). The only docker form is `docker exec -i -e PGOPTIONS=... <container> sh -c '... psql ...'` (ops-coord, same closed exception as #122 RULING_1 D3):
# the SQL comes on stdin, every call runs under `timeout`, any non-zero rc stops the run (fail closed). R2EXP_TODAY (YYYY-MM-DD, CST) is for tests.
set -euo pipefail
export LC_ALL=C
umask 022
HERE="$(cd "$(dirname "$0")" && pwd)"

SEGMENT=all; DAY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --segment) SEGMENT="${2:?--segment needs R1, R2 or all}"; shift 2 ;;
    --day) DAY="${2:?--day needs YYYY-MM-DD}"; shift 2 ;;
    *) echo "usage: r2-day-export.sh [--segment R1|R2|all] [--day YYYY-MM-DD]" >&2; exit 64 ;;
  esac
done
case "$SEGMENT" in R1|R2|all) ;; *) echo "r2-day-export: unknown segment $SEGMENT" >&2; exit 64 ;; esac
[[ -z "$DAY" || "$DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "r2-day-export: bad --day $DAY" >&2; exit 64; }
[ -z "$DAY" ] || [ "$SEGMENT" != all ] || { echo "r2-day-export: --day needs --segment R1 or R2" >&2; exit 64; }

ENV_FILE="${R2EXP_ENV_FILE:-/etc/rf1116/r2-day-export.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
: "${R2EXP_PG_CONTAINER:?R2EXP_PG_CONTAINER (the V6 Postgres container) is required}"
: "${R2EXP_PG_USER:?R2EXP_PG_USER is required}"
: "${R2EXP_PG_DB:?R2EXP_PG_DB is required}"
DROP_ROOT="${R2EXP_DROP_ROOT:-/srv/research-lane/rf1116-mining/holdout-daydrop}"
TODAY="${R2EXP_TODAY:-$(TZ=Asia/Shanghai date +%F)}"
STALE_DAYS=3
READY_SQL=R2_DAY_EXPORT_READINESS_V2.sql
STEMS="prices_daily_stock market_daily_basic_observation_stock adjustment_factor_observation_stock security_master_stock security_suspension_observation security_suspension_day_coverage industry_membership_sw2021"

# every statement goes through here, SQL on stdin: read-only session (PGOPTIONS passed into the container), no psqlrc, stop on the first error, a time limit, no other docker verb
pg() {
  timeout "${R2EXP_TIMEOUT:-600}" docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$R2EXP_PG_CONTAINER" sh -c 'u="$1"; d="$2"; shift 2; exec psql -X -q -v ON_ERROR_STOP=1 -U "$u" -d "$d" "$@"' sh "$R2EXP_PG_USER" "$R2EXP_PG_DB" "$@"
}
addday() { date -u -d "$1 + $2 day" +%F; }
ageof() { echo $(( ( $(date -u -d "$TODAY" +%s) - $(date -u -d "$1" +%s) ) / 86400 )); }
# a SQL template with @DAY@ @NEXT@ @LOWER@ filled in (comment lines dropped)
render() {
  local t; t="$(grep -v '^--' "$HERE/sql/$1.sql" | tr -d '\n')"
  t="${t//@DAY@/${2:-}}"; t="${t//@NEXT@/${3:-}}"; t="${t//@LOWER@/${4:-}}"
  printf '%s' "$t"
}
copy_to() { printf 'COPY (%s) TO STDOUT WITH (FORMAT csv, HEADER true);\n' "$(render "$@")" | pg -f -; }

ro="$(printf 'SHOW default_transaction_read_only;\n' | pg -At -f -)" || { echo "r2-day-export: psql failed" >&2; exit 2; }
[ "$ro" = on ] || { echo "NOT_READ_ONLY: the session reports default_transaction_read_only=$ro; refusing to run" >&2; exit 2; }

export_segment() {
  local seg="$1" START_AFTER FIRST_LOWER END MAXDAYS
  case "$seg" in
    R1) START_AFTER=2026-11-17; FIRST_LOWER=2026-10-17; END=2026-12-31; MAXDAYS=0 ;;
    R2) START_AFTER=2026-12-31; FIRST_LOWER=2027-01-01; END=; MAXDAYS=54 ;;
  esac
  local root="$DROP_ROOT/$seg" rc=0
  mkdir -p "$root"
  if [ -n "$DAY" ]; then
    if [[ "$DAY" < "$(addday "$START_AFTER" 1)" ]] || { [ -n "$END" ] && [[ "$DAY" > "$END" ]]; }; then echo "$seg REFUSED_OUTSIDE_WINDOW:$DAY"; return 3; fi
  fi
  local hi="$TODAY"; if [ -n "$END" ] && [[ "$END" < "$hi" ]]; then hi="$END"; fi
  local out; out="$(pg -At -v "lo=$(addday "$START_AFTER" 1)" -v "hi=$hi" -f - < "$HERE/sql/open_days.sql")" || { echo "r2-day-export: open-day query failed" >&2; return 2; }
  local days=(); local l
  while IFS= read -r l; do [ -n "$l" ] && days+=("$l"); done <<< "$out"
  if [ "$MAXDAYS" -gt 0 ] && [ "${#days[@]}" -gt "$MAXDAYS" ]; then days=("${days[@]:0:$MAXDAYS}"); fi
  if [ -n "$DAY" ]; then
    local found=0 d; for d in "${days[@]+"${days[@]}"}"; do [ "$d" = "$DAY" ] && found=1; done
    [ "$found" = 1 ] || { echo "$seg REFUSED_NOT_OPEN_DAY:$DAY"; return 3; }
  fi
  # R2: the arrival program takes the calendar first, so it is exported with every run (atomic replace; the arrival program delivers only the rows that are new)
  if [ "$seg" = R2 ]; then
    copy_to trading_calendar > "$root/.trading_calendar.tmp" || { rm -f "$root/.trading_calendar.tmp"; echo "r2-day-export: calendar query failed" >&2; return 2; }
    mv -f "$root/.trading_calendar.tmp" "$root/trading_calendar.csv"
  fi
  local i=0 D lower c tmp fin stem next stale=0
  for D in "${days[@]+"${days[@]}"}"; do
    if [ "$i" -eq 0 ]; then lower="$FIRST_LOWER"; else lower="$(addday "${days[$((i-1))]}" 1)"; fi
    i=$((i+1))
    if [ -n "$DAY" ] && [ "$D" != "$DAY" ]; then continue; fi
    c="${D//-/}"; fin="$root/$c"; tmp="$root/.tmp-$c"
    if [ -d "$fin" ]; then echo "$seg ALREADY_EXPORTED:$D"; continue; fi
    local ready; ready="$(pg -At -v "d=$D" -f - < "$HERE/R2_DAY_EXPORT_READINESS_V2.sql")" || { echo "$seg PROBE_FAILED:$D" >&2; return 2; }
    if [ -z "$ready" ]; then
      if [ -n "$DAY" ]; then echo "$seg REFUSED_NOT_READY:$D"; return 3; fi
      echo "$seg WAITING:$D"; [ "$(ageof "$D")" -gt "$STALE_DAYS" ] && stale=1; continue
    fi
    # the probe row: trade_date|ready_via|n_prices|n_basic|n_adj|n_cov; anything else is a failed probe (fail closed), not "not ready"
    local r_day r_via r_np r_nb r_na r_nc
    IFS='|' read -r r_day r_via r_np r_nb r_na r_nc <<< "$ready"
    if [ "$r_day" != "$D" ] || { [ "$r_via" != POST_CLOSE_D ] && [ "$r_via" != NEXT_PREMARKET ]; } || ! [[ "$r_np$r_nb$r_na$r_nc" =~ ^[0-9]+$ ]]; then echo "$seg PROBE_BAD_ROW:$D:$ready" >&2; return 2; fi
    next="$(addday "$D" 1)"
    rm -rf "$tmp"; mkdir "$tmp"
    for stem in $STEMS; do
      if ! copy_to "$stem" "$D" "$next" "$lower" > "$tmp/$stem.csv"; then rm -rf "$tmp"; echo "$seg EXPORT_FAILED:$D:$stem" >&2; return 2; fi
      [ -s "$tmp/$stem.csv" ] || { rm -rf "$tmp"; echo "$seg EXPORT_FAILED:$D:$stem:empty output" >&2; return 2; }
    done
    if [ "$(wc -l < "$tmp/prices_daily_stock.csv")" -le 1 ]; then
      rm -rf "$tmp"; echo "$seg NOT_AVAILABLE:$D"; [ "$(ageof "$D")" -gt "$STALE_DAYS" ] && stale=1; continue
    fi
    # the readiness record goes into the arrival-chain row (plan-coord condition iii): which rule made the day ready and the counts at probe time
    printf '{"schema":"R2_DAY_EXPORT_READINESS_RECORD_V1","trade_date":"%s","probe_sha256":"%s","ready_via":"%s","n_prices":%s,"n_basic":%s,"n_adj":%s,"n_cov":%s,"probed_at":"%s"}\n' "$D" "$(sha256sum "$HERE/$READY_SQL" | cut -d' ' -f1)" "$r_via" "$r_np" "$r_nb" "$r_na" "$r_nc" "$(TZ=Asia/Shanghai date +%FT%T+08:00)" > "$tmp/READINESS.json"
    ( cd "$tmp" && { for stem in $STEMS; do sha256sum "$stem.csv"; done; sha256sum READINESS.json; } > SHA256SUMS )
    mv "$tmp" "$fin"
    echo "$seg EXPORTED:$D"
  done
  [ "$stale" = 0 ] || rc=4
  return "$rc"
}

worst=0
for seg in R1 R2; do
  [ "$SEGMENT" = all ] || [ "$SEGMENT" = "$seg" ] || continue
  rc=0; export_segment "$seg" || rc=$?
  [ "$rc" -le "$worst" ] || worst="$rc"
done
exit "$worst"
