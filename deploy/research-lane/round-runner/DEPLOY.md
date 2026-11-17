# RF1116 P2 round runner — research lane deployment (GP only)

The coordinator deploys this. Nothing here is run from the Mac. The runner covers MINING_ROUNDS_V1 "P2 requirements" and P2 spec §1:
- it runs in a rootless container;
- data mounts are read-only;
- the container has no network (GP needs none);
- there is one writable output directory;
- the holdout directory is mounted only in the scoring phase.

## Host, users, paths

- **Host:** the Linux research lane. The user is `kayla` (uid 1000, no sudo), running rootless Docker at `DOCKER_HOST=unix:///run/user/1000/docker.sock`.
- **Container user:** `1000:1000`, the image's `node` user. Under rootless Docker it maps to host subuid **100999**, never root.
- **Never mount `/srv/backup`** or anything under `/srv/v6-prod` into this container.

| path | contents | owner / mode | mount |
|---|---|---|---|
| `/srv/research-lane/rf1116-mining/code/` | QRP checkout at the reviewed merge commit (build context) | kayla, 0755 | not mounted (baked into the image) |
| `/srv/research-lane/rf1116-mining/data/rf1116-cn-a-lane-copy-20200601-20260928/` | the lane copy in export spec rev 2 CSV layout (see below). `HISTORY` source | kayla, dirs 0755 / files 0644 | `/data/lane:ro` |
| `/srv/research-lane/rf1116-mining/data/rf1116-cn-a-daily-20260929-20261016/` | validation tail export (spec §1, first directory), with `SHA256SUMS` and `EXPORT_MANIFEST.json`. `LIVE` source | kayla, 0755 / 0644 | `/data/tail:ro` |
| `/srv/research-lane/rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019/` | holdout export (spec §1, second directory) plus `SHA256SUMS.sealed` | kayla, **0700** until hand-over | `/data/holdout:ro`, **`score` only** |
| `/srv/research-lane/rf1116-mining/data/rf1116-cn-a-live-factor-series/` | R1.4: the existing CN_A factor series in `FACTOR_SERIES_V1` (`factor_series.csv`, `unit_membership.csv`, `SHA256SUMS`), from the coordinator's registered export | kayla, 0755 / 0644 | `/data/factor-series:ro`, **`score` only**; if it is missing or unsigned, `score` refuses before the open |
| `/srv/research-lane/rf1116-mining/out/` | `qrp-data/` (mining rounds, trials, holdout vault, G-MINE records) and `rounds/<round_id>/` (`attempts.jsonl`, `generate.json`, `selection.json`, `score.json`) | container uid 1000 (host 100999) | `/out:rw`, the only writable mount |

**`out/qrp-data/` persists across rounds and is never deleted.** It holds the cumulative N of family `MINE:CN_A:H5`. Container-written files belong to host uid 100999, so kayla can read them but cannot remove them.

### Lane copy layout

- **Files and columns:** the same file names and columns as export spec **rev 3** §2 (`RF1116_CN_A_LANE_EXPORT_SPEC_V1.a24afab2.md`, which replaces rev 2):
  - `prices_daily_stock.csv`
  - `market_daily_basic_observation_stock.csv`
  - `adjustment_factor_observation_stock.csv`
  - `security_master_stock.csv`
  - `security_suspension_observation.csv`
  - `security_suspension_day_coverage.csv`
  - `trading_calendar.csv`
- **Dates:** trade dates 2020-06-01 → 2026-09-28.
- **Calendar (rev 3 §2.2):** `trading_calendar.csv` comes from `canonical_calendar_observation`.
  - It holds one row per (date, exchange) for **both SSE and SZSE**, with `market` = `A_SHARE` and the exchange in `exchange`, covering 2019-06-01 → 2026-12-31.
  - The same file is in every directory (lane copy, validation tail, holdout).
  - The runner takes open days from SSE rows only and lists any SSE/SZSE disagreement in the panel manifest.
  - Starting at 2019-06-01 is what makes the 120-session listing rule work from the first mining day.
- **Security master (rev 3 §2.1):** `security_master_stock.csv` comes from `canonical_security_observation`. It has the rev 2 column names plus `record_id`, `revision` and `allow_new_risk`, and holds each security's last row before the directory's first date plus every row inside it. (The legacy `security_master` and `trading_calendar` tables are empty in the live DB.)
- **Integrity:** `SHA256SUMS` comes from `shasum -a 256 *.csv`.
- **Source:** it is exported read-only from the lane's replay copy with the same queries, no vendor re-fetch.
- **Other formats:** a different reader can be plugged in with `--lane-adapter <module>` (a module exporting `createSource(dir, opts)`). No adapter is needed when the layout above is used.

## One-time setup

```sh
mkdir -p /srv/research-lane/rf1116-mining/{code,data,holdout-sealed,out}
git clone https://github.com/UpMeAI/quant-research-platform.git /srv/research-lane/rf1116-mining/code && git -C /srv/research-lane/rf1116-mining/code checkout --detach <merge-commit>
cd /srv/research-lane/rf1116-mining/code && DOCKER_HOST=unix:///run/user/1000/docker.sock \
  docker build --pull=false -f deploy/research-lane/round-runner/Dockerfile -t qrp-round-runner:<commit12> .
DOCKER_HOST=unix:///run/user/1000/docker.sock docker run --rm --user 0:0 --network none \
  -v /srv/research-lane/rf1116-mining/out:/out --entrypoint chown qrp-round-runner:<commit12> 1000:1000 /out   # out/ writable for container uid 1000
```

- **Base image, no network:** Docker Hub is blocked from the lane. The Dockerfile pins `node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392` (Node 22.23.3), which is the lane's local image.
  - Check it before building: `docker image inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}'` must print that digest.
  - If the image ever has to be reloaded, use the lane's saved copy `/srv/research-lane/images/node_22-bookworm-slim.tar`.
    - Its sha256 is `0fb2fe45b4ee389e7bc833dd21d1ea2292e90fa301bcfaab881cdff52e675edf` (read on the lane 2026-11-17, file dated 2026-11-03, 82,501,120 bytes).
    - Check the hash before `docker load -i`, then re-check the RepoDigest above.
  - Then build with `--pull=false`.
- **Dependencies:** `npm ci` installs nothing, because QRP has no dependencies and the lockfile pins that.

## Seal, then generate (steps 1–5)

**Before the first round**, put the holdout export in `holdout-sealed/…`, then record what is being sealed:

```sh
cd /srv/research-lane/rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019
cp SHA256SUMS SHA256SUMS.sealed && chmod 0700 . && sha256sum SHA256SUMS.sealed    # -> <holdout_sha256>
```

**Run** (one line; the seed is any integer, and it is written into the round manifest):

```sh
RF1116_RUNNER_IMAGE=qrp-round-runner:<commit12> /srv/research-lane/rf1116-mining/code/deploy/research-lane/round-runner/run.sh generate <gp_seed> <holdout_sha256>
```

The run does the following:
- **checks the data before anything is written:** it builds the mining-segment panel and requires at least **2,000** names per decision day (in the universe, with a back-adjusted close; the first day is exempt).
  - The floor that was used is written into the round row (`data_checks.coverage_floor`: value, default, `overridden`).
  - `--min-names-per-day` exists for synthetic tests only; never pass it on the lane.
  - Otherwise it refuses with `MINE_RUNNER_COVERAGE_BELOW_FLOOR:<day>:<n><2000>`. No round is opened and nothing enters N.
  - The 2020-06 universe is about 3,800 names before exclusions.
- opens a CN_A GP round with the frozen space `0d3556fa…`, freeze page `4ec642b9…`, holding period 5, cap 200 and holdout 2026-10-19 → 2026-12-31;
- seals the holdout (data_ref + `<holdout_sha256>`);
- generates and scores on the mining segment. **Every attempt is a trial row** (parse-refused and deduplicated included), and the run stops at 200;
- runs the validation-fold selection into `out/rounds/<round_id>/selection.json`, and appends one `MINING_SELECTION_V1` row (that file's sha256 and the selected ids) to the ledger. After this row exists, the round records no more attempts. At scoring time, the runner trusts only this row; the file in `out/` must match its sha.

It prints one JSON line with the `round_id`.

**Crashed mid-generation?**

```sh
run.sh resume <round_id>
```

The GP continues deterministically from the ledger. After `selection.json` exists, generation for that round is closed.

## Mechanisms (R1.5), before the hand-over

After `generate` has written the selection, list the survivors and register their mechanisms. The coordinator writes the JSONL: one line per survivor, `{candidate_id, mechanism_id, economic_logic_zh, failure_mode_zh, written_at}`, where `written_at` is Beijing time with `+08:00`.

```sh
RF1116_RUNNER_IMAGE=qrp-round-runner:<commit12> /srv/research-lane/rf1116-mining/code/deploy/research-lane/round-runner/run.sh mechanisms <round_id>                       # list
RF1116_RUNNER_IMAGE=qrp-round-runner:<commit12> /srv/research-lane/rf1116-mining/code/deploy/research-lane/round-runner/run.sh mechanisms <round_id> /path/to/mech.jsonl  # register
```

- **What it mounts.** The step mounts only `out/` (rw) and the JSONL (ro): no data, no holdout, no network.
- **Append-only.** Registrations cannot be changed, and are refused once the holdout is open. A survivor without one is still scored but fails G-MINE item 9.

## Hand-over and scoring (steps 6–9), only after the 2026-12-31 data is in

The completion export goes into **the same holdout directory**:
- new files are named `<table>_<YYYYMMDD>.csv`;
- `SHA256SUMS` is recomputed;
- `SHA256SUMS.sealed` is left untouched.

**Hand-over** is the only point where the runner gets the holdout:

```sh
chmod -R a+rX /srv/research-lane/rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019   # readable by container uid 1000
RF1116_RUNNER_IMAGE=qrp-round-runner:<commit12> /srv/research-lane/rf1116-mining/code/deploy/research-lane/round-runner/run.sh score <round_id>
```

**Checks before `holdout-vault.open`.** Before opening the vault, the runner reads the holdout directory once and checks:
1. **The manifest is the sealed one, append-only.** Either `sha256(SHA256SUMS)` equals the sealed sha, or `sha256(SHA256SUMS.sealed)` equals it and every sealed line is still in `SHA256SUMS`.
2. **Every file is listed and intact.**
   - Every CSV in the directory is listed (`…_FILE_UNLISTED`).
   - Every listed file exists and hashes to its line (`…_FILE_MISSING`, `…_FILE_SHA_MISMATCH`).
   - All 7 tables are present (`…_TABLE_MISSING`): prices, daily_basic, adjustment factor, security master, suspension, suspension day coverage, calendar.
3. **The data is complete.** Rev 3 always ships the full calendar to 2026-12-31, so the calendar alone proves nothing.
   - The calendar's READY SSE rows must reach 2026-12-31.
   - For every SSE open day 2026-10-19 → 2026-12-31, each of the prices, daily_basic and adjustment-factor tables must have READY rows for at least **2,000 distinct `security_id`s** (the same floor as generation). Names are counted, not rows, because rows include revisions.
   - Each table must also reach at least half of its own median day.
   - Otherwise it refuses with `…_HOLDOUT_INCOMPLETE:<file>:<day>:<names>`.
   - The floor used is written into the vault's open record (`pre_open_checks`).
4. **The selection is the recorded one.** The `MINING_SELECTION_V1` row exists, and `selection.json` matches its sha (`MINE_RUNNER_SELECTION_FILE_MISMATCH`). The formulas are taken from the trial rows, not from the file.

If any check fails it refuses, and the single open is not spent.

**Known limitation: no recovery after the open.** If the score container dies after `holdout-vault.open` but before every candidate's G-MINE record is written, the round stays in `SCORING`.
- A second `score` is refused (`MINE_HOLDOUT_ALREADY_OPENED`), and `close` is refused (`MINE_ROUND_GMINE_RESULT_MISSING`).
- That is deliberate: the single open is never repeated.
- Recovering such a round needs a coordinator ruling.
- The checks above exist so that every data problem stops the run before the open.

**After the checks** it does the following:
- opens the vault once;
- scores only through `neutralizeForScoring`;
- writes one `MINING_GATE_RECORD_V1` per candidate;
- closes the round.

## Limits and timing

| item | value |
|---|---|
| `--cpus` | 6 |
| `--memory` / `--memory-swap` | 24g / 24g (no swap) |
| `--pids-limit` | 256 |
| Node heap | 20 GiB (`--max-old-space-size=20480`) |
| root fs | read-only; `/tmp` is a 256 MiB tmpfs |
| network | `--network none` (GP). The LLM step is not built: `MINE_LLM_NOT_ENABLED` |

- **Shared host:** this host also carries V6 production. Run outside the V6 windows: 09:15–15:30 CST, the post-close chain, and the 06:30 PREMARKET.
- **Run time:** a full round is roughly 200 mining evaluations plus one validation pass. That takes hours, not minutes.
- **Monthly limit:** at most 2 rounds per market per month (Beijing time).
- **One open round per market:** a round stays open (`CAP_REACHED`) until it is scored in early 2027, so a second CN_A round cannot open before then.
