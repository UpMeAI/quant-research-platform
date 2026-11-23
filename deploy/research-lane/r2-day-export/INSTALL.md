# r2-day-export: install notes for ops-coord (V6 host)

What it is: a read-only job on the V6 host that copies finished V6 trading days into the lane's drop directory, one directory per day, so the lane's arrival program (`run.sh arrive`, `services/mining-sandbox/round-runner/arrival.js`) can write them into the sealed holdout directory with its hash chain. QRP never touches V6; V6 only exports. Written by LLM_GEN for plan-coord, 2026-11-23. Tests (`tests/rf1116_r2_day_export.test.js`) cover text, arguments and refusals with a stub `psql`; nothing has run against a database.

## What it does

- `--segment R1`: the open days after the sealed R1 export's D1 (2026-11-17) up to 2026-12-31. The first run after install fills 2026-11-18 onward (every open day that is ready and not exported yet, in calendar order); later runs add the new day. No calendar file (R1's calendar was sealed).
- `--segment R2`: the first 54 SSE open days after 2026-12-31 (the first real day is 2027-01-04), plus `trading_calendar.csv` (replaced atomically on every run; the arrival program delivers only the rows that are new).
- `--segment all` (the unit): R1 then R2. `--day YYYY-MM-DD --segment R1|R2` exports one day and refuses (exit 3) a day that is not an SSE open day of the window (`REFUSED_NOT_OPEN_DAY`, `REFUSED_OUTSIDE_WINDOW`) or whose POST_CLOSE is not ready (`REFUSED_NOT_READY`).
- A day is exported only when V6's POST_CLOSE of that day finished, by `R2_DAY_EXPORT_READINESS_V2.sql` (ops-coord; plan-coord ruling 2026-11-23 option (b); byte-identical, sha256 `57e26c0379ad86008fdea0f035108104761434dfc009dc80d358987a6fddb582`, first 8 hex `57e26c03`; V1 `cf8380f0` is superseded). It returns one row `trade_date|ready_via|n_prices|n_basic|n_adj|n_cov` or none: >= 4000 non-BJ names in each of prices, daily_basic and adjustment factor, a coverage row, and POST_CLOSE(D) OK (`POST_CLOSE_D`) or the next PREMARKET's DATA_REFRESH OK (`NEXT_PREMARKET`). The result is never cached: it is re-run for every day on every tick, and its row is written to `READINESS.json` in the day directory (the arrival program records it in the chain row), and its prices query returns rows. Output: `<drop>/<R1|R2>/<YYYYMMDD>/` with the seven tables (`prices_daily_stock`, `market_daily_basic_observation_stock`, `adjustment_factor_observation_stock`, `security_master_stock`, `security_suspension_observation`, `security_suspension_day_coverage`, `industry_membership_sw2021`) and a `SHA256SUMS` of them, written under a `.tmp-` name and renamed. An exported day is never exported again.
- The SQL is `sql/*.sql`, generated from the arrival program's PG query set (`arrival.js pgQueries`, export spec section 2; industry per export spec rev 5 change 2): one producer, a test compares them byte for byte.
- Industry membership per day = rows whose `first_available_at` is in [the previous part's upper bound, 09:00+08 of the next SSE open day after the day) (plan-coord 2026-11-23: contiguous, no gap, no overlap; a part holds every row the panel may count for the day). The first R1 part starts at 2026-10-17 00:00+08, the first R2 part at 2027-01-01 00:00+08; 12-31 closes at 2027-01-04 09:00+08. A header-only file is normal. No `effective_from` cut per day and the column is exported untouched: the data adapter applies `effective_from <= decision day < effective_to` itself (point in time). The window goes into `READINESS.json` (`window_from`, `window_to`) and into the arrival chain row; the arrival program checks contiguity and, when its calendar knows the next open day, the upper bound. A test (DX15) shows that the concatenation of the per-day parts equals one export over the whole window on a synthetic ledger with rows whose `effective_from` is after their `first_available_at`.
- The readiness probe is one file: `R2EXP_READY_SQL` (default: the V2 copy next to the script); its sha256 goes into every `READINESS.json`.

## Read-only

`PGOPTIONS='-c default_transaction_read_only=on'` is passed into the container by the script for every psql call (`docker exec -e PGOPTIONS=...`) and the script refuses to run unless `SHOW default_transaction_read_only` says `on` (exit 2, `NOT_READ_ONLY`). The script text has no statement that changes the session's read-only state and sends only SELECT and `COPY (SELECT ...) TO STDOUT`. It uses V6's own existing DB account; no new role.

## Install

1. Files (all from this directory; keep them together):
   ```sh
   install -d /srv/research-lane/rf1116-mining/ops/r2-day-export/sql ~/.config/rf1116 ~/.config/systemd/user
   install -m 0755 r2-day-export.sh /srv/research-lane/rf1116-mining/ops/r2-day-export/
   install -m 0644 R2_DAY_EXPORT_READINESS_V2.sql SHA256SUMS /srv/research-lane/rf1116-mining/ops/r2-day-export/
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
6. Enable: `systemctl --user daemon-reload && systemctl --user enable --now r2-day-export.timer`. The timer runs on open days (Mon..Fri) at 08:20, 16:00 and 21:40 CST, `Persistent=false`, `RandomizedDelaySec=0`.

## V6 windows and the point-in-time cutoff

V6 runs on the same host; research stays out of its windows on weekdays (ops-coord 2026-11-23). The script therefore runs **only in 08:20-09:05, 15:40-18:05 and 21:35-00:10 CST on weekdays** and otherwise exits 0 with `OUTSIDE_SLOT` without a docker call (forbidden windows: 06:30-08:00, 09:15-15:30, 18:10-21:30, 00:15-01:15; weekends: any time, not into Monday 00:15). Every psql call is clamped to the end of the slot (`timeout`), and no new day starts after it (`SLOT_ENDED`, the next slot resumes).

A day D is exported only when the next SSE open day after D has reached 09:00+08 (`WAITING_CUTOFF` before that; `--day` refuses with `REFUSED_BEFORE_CUTOFF`): the scorer's panel counts only rows that were in by then, so the export holds every row it may count. The 16:00 run is the one that exports D-1; the 08:20 run catches up what the 16:00 and 21:40 runs could not. `R2EXP_PIT_CUTOFF=0` switches the rule off (plan-coord's call, asked 2026-11-23).

## Exit codes and what to do

| exit | meaning | action |
|---|---|---|
| 0 | done, caught up, or days still waiting for V6's POST_CLOSE | none (the evening state) |
| 2 | psql failed, an export query failed, or the session is not read-only | read the journal; nothing is written for the failing day |
| 3 | `--day` refused (manual runs only) | the printed code says why |
| 4 | a day has been waiting for more than 3 days (not ready, or no prices rows) | the unit fails: alert. The arrival program takes days in calendar order and stops at a missing day, and the scorer refuses an R1/R2 directory with a missing day (`MINE_RUNNER_HOLDOUT_INCOMPLETE:arrival:<day>`). A coordinator ruling is needed for a day V6 will never finish |

Known case before install: V6's POST_CLOSE of 2026-11-18 was BLOCKED but its data was backfilled by 11-19 07:01 and the 11-19 PREMARKET ran DATA_REFRESH SUCCEEDED, so V2 makes 2026-11-18 ready via `NEXT_PREMARKET` (about one BLOCKED day per 15 trading days; 11-02 was the same). The first run after install therefore exports 11-18 with `ready_via` recorded.

## Lane side (not this job)

`run.sh arrive` (`RF1116_HOLDOUT_SEGMENT=R1|R2`) reads `<lane>/holdout-daydrop/<segment>` and is the only writer of the holdout directory; `run.sh arrive-check` names the open days still missing after the window end (exit 4). Their timers belong to the arrival/score timer briefs, not to this directory.
