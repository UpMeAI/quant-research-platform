# r2-day-export: install notes for ops-coord (V6 host)

What it is: a read-only job on the V6 host that copies finished V6 trading days into the lane's drop directory, one directory per day, so the lane's arrival program (`run.sh arrive`, `services/mining-sandbox/round-runner/arrival.js`) can write them into the sealed holdout directory with its hash chain. QRP never touches V6; V6 only exports. Written by LLM_GEN for plan-coord, 2026-11-23. Tests (`tests/rf1116_r2_day_export.test.js`) cover text, arguments and refusals with a stub `psql`; nothing has run against a database.

## What it does

- `--segment R1`: the open days after the sealed R1 export's D1 (2026-11-17) up to 2026-12-31. The first run after install fills 2026-11-18 onward (every open day that is ready and not exported yet, in calendar order); later runs add the new day. No calendar file (R1's calendar was sealed).
- `--segment R2`: the first 54 SSE open days after 2026-12-31 (the first real day is 2027-01-04), plus `trading_calendar.csv` (replaced atomically on every run; the arrival program delivers only the rows that are new).
- `--segment all` (the unit): R1 then R2. `--day YYYY-MM-DD --segment R1|R2` exports one day and refuses (exit 3) a day that is not an SSE open day of the window (`REFUSED_NOT_OPEN_DAY`, `REFUSED_OUTSIDE_WINDOW`) or whose POST_CLOSE is not ready (`REFUSED_NOT_READY`).
- A day is exported only when V6's POST_CLOSE of that day finished, by `R2_DAY_EXPORT_READINESS_V1.sql` (ops-coord, byte-identical, sha256 `cf8380f097714bed9d9fb38303ecf9f94864ec28ffb8233d8a3a1f1806871b14`, first 8 hex `cf8380f0`), and its prices query returns rows. Output: `<drop>/<R1|R2>/<YYYYMMDD>/` with the seven tables (`prices_daily_stock`, `market_daily_basic_observation_stock`, `adjustment_factor_observation_stock`, `security_master_stock`, `security_suspension_observation`, `security_suspension_day_coverage`, `industry_membership_sw2021`) and a `SHA256SUMS` of them, written under a `.tmp-` name and renamed. An exported day is never exported again.
- The SQL is `sql/*.sql`, generated from the arrival program's PG query set (`arrival.js pgQueries`, export spec section 2; industry per export spec rev 5 change 2): one producer, a test compares them byte for byte.
- Industry membership per day = rows whose `first_available_at` is in [previous open day + 1 00:00+08, day + 1 00:00+08); the first R1 part reaches back to 2026-10-17 00:00+08 (spec rev 5 change 2), the first R2 part starts 2027-01-01. A header-only file is normal. No `effective_from` cut per day (deviation from the spec's single-export wording, asked of plan-coord).

## Read-only

`PGOPTIONS='-c default_transaction_read_only=on'` is passed into the container by the script for every psql call (`docker exec -e PGOPTIONS=...`) and the script refuses to run unless `SHOW default_transaction_read_only` says `on` (exit 2, `NOT_READ_ONLY`). The script text has no statement that changes the session's read-only state and sends only SELECT and `COPY (SELECT ...) TO STDOUT`. It uses V6's own existing DB account; no new role.

## Install

1. Files (all from this directory; keep them together):
   ```sh
   install -d /srv/research-lane/rf1116-mining/ops/r2-day-export/sql ~/.config/rf1116 ~/.config/systemd/user
   install -m 0755 r2-day-export.sh /srv/research-lane/rf1116-mining/ops/r2-day-export/
   install -m 0644 R2_DAY_EXPORT_READINESS_V1.sql SHA256SUMS /srv/research-lane/rf1116-mining/ops/r2-day-export/
   install -m 0644 sql/*.sql /srv/research-lane/rf1116-mining/ops/r2-day-export/sql/
   install -m 0644 r2-day-export.service r2-day-export.timer ~/.config/systemd/user/
   (cd /srv/research-lane/rf1116-mining/ops/r2-day-export && sha256sum -c SHA256SUMS)   # every line OK
   ```
2. Drop directories. The lane arrival container (root of the rootless daemon = the lane user) mounts them read-only: they must be readable by that user.
   ```sh
   install -d -m 0755 /srv/research-lane/rf1116-mining/holdout-daydrop/R1 /srv/research-lane/rf1116-mining/holdout-daydrop/R2
   ```
3. Connection: copy `r2-day-export.env.example` to `~/.config/rf1116/r2-day-export.env` and fill `R2EXP_PG_CONTAINER`, `R2EXP_PG_USER`, `R2EXP_PG_DB` (V6 Postgres container, V6's own DB user and database; read from the live Linux host after the cutover, not hard-coded). The unit runs as `kayla` on the same host as V6's Postgres and the lane (rootless docker, `DOCKER_HOST=unix:///run/user/%U/docker.sock` is in the unit); the script does not copy over a network and never writes under `/srv/v6-prod`. The only docker form it uses is `docker exec -i -e PGOPTIONS=... <container> sh -c '... psql ...'` (SQL on stdin, every call under `timeout`, any non-zero rc stops the run).
4. Acceptance probe, `default_transaction_read_only`: one write in a rolled-back transaction must fail with SQLSTATE 25006 under the same command line the unit uses:
   ```sh
   set -a; . ~/.config/rf1116/r2-day-export.env; set +a
   printf 'BEGIN; CREATE TABLE r2exp_ro_probe (i int); ROLLBACK;\n' | docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$R2EXP_PG_CONTAINER" sh -c 'psql -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -U "$0" -d "$1" -f -' "$R2EXP_PG_USER" "$R2EXP_PG_DB"
   # expected: ERROR:  25006: cannot execute CREATE TABLE in a read-only transaction   (and nothing is created)
   ```
5. Smoke, one real day (an R1 day whose POST_CLOSE finished):
   ```sh
   R2EXP_ENV_FILE=~/.config/rf1116/r2-day-export.env /srv/research-lane/rf1116-mining/ops/r2-day-export/r2-day-export.sh --segment R1 --day 2026-11-19
   ls /srv/research-lane/rf1116-mining/holdout-daydrop/R1/20261119   # seven csv + SHA256SUMS
   ```
6. Enable: `systemctl --user daemon-reload && systemctl --user enable --now r2-day-export.timer`. The timer runs 21:15 and 23:45 CST (after the post-close chain, 18:10-20:45) and 07:30 (retry), `Persistent=true`.

## Exit codes and what to do

| exit | meaning | action |
|---|---|---|
| 0 | done, caught up, or days still waiting for V6's POST_CLOSE | none (the evening state) |
| 2 | psql failed, an export query failed, or the session is not read-only | read the journal; nothing is written for the failing day |
| 3 | `--day` refused (manual runs only) | the printed code says why |
| 4 | a day has been waiting for more than 3 days (not ready, or no prices rows) | the unit fails: alert. The arrival program takes days in calendar order and stops at a missing day, and the scorer refuses an R1/R2 directory with a missing day (`MINE_RUNNER_HOLDOUT_INCOMPLETE:arrival:<day>`). A coordinator ruling is needed for a day V6 will never finish |

Known case before install: V6's POST_CLOSE of 2026-11-18 was BLOCKED (ops-coord readiness check 2026-11-23), so R1's 2026-11-18 is `WAITING` from the first run and the job exits 4 until it is resolved.

## Lane side (not this job)

`run.sh arrive` (`RF1116_HOLDOUT_SEGMENT=R1|R2`) reads `<lane>/holdout-daydrop/<segment>` and is the only writer of the holdout directory; `run.sh arrive-check` names the open days still missing after the window end (exit 4). Their timers belong to the arrival/score timer briefs, not to this directory.
