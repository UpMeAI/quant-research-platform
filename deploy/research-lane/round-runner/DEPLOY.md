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
| `/srv/research-lane/rf1116-mining/data/rf1116-cn-a-lane-copy-20200601-20260928/` | the lane copy, exported by the lane-copy spec `RF1116_CN_A_LANE_COPY_EXPORT_SPEC_V1.f1b3a200.md` with its `RF1116_CN_A_LANE_COPY_EXPORT_SPEC_V1_ERRATA_1.md` (see below). `HISTORY` source | kayla, dirs 0755 / files **0444** | `/data/lane:ro` |
| `/srv/research-lane/rf1116-mining/data/rf1116-cn-a-daily-20260929-20261016/` | validation tail export (spec §1, first directory), with `SHA256SUMS` and `EXPORT_MANIFEST.json`. `LIVE` source. Round 1 (2026-11-18): the export directory is `rf1116-cn-a-daily-20260929-20261016-r4` (spec rev 4, `SHA256SUMS` sha256 `758323e8…`), and this path is a symlink to it, because `run.sh` names the path without the suffix; Docker follows the host symlink | kayla, 0755 / 0644 | `/data/tail:ro` |
| `/srv/research-lane/rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019/` | holdout export (spec §1, second directory) plus `SHA256SUMS.sealed`. Round 1: the Mac export `rf1116-cn-a-daily-holdout-from-20261019-r4` (spec rev 4, `D1` 2026-11-17), copied under this name without the suffix, because `run.sh`'s `HOLDOUT_REF` names it; the seal binds the content (`SHA256SUMS.sealed` sha256 `e64e2823…`) | kayla, **0700** until hand-over | `/data/holdout:ro`, **`score` only** |
| `/srv/research-lane/rf1116-mining/data/rf1116-cn-a-live-factor-series/` | R1.4: the existing CN_A factor series in `FACTOR_SERIES_V1` (`factor_series.csv`, `unit_membership.csv`, `SHA256SUMS`), from the coordinator's registered export | kayla, 0755 / 0644 | `/data/factor-series:ro`, **`score` only**; if it is missing or unsigned, `score` refuses before the open |
| `/srv/research-lane/rf1116-mining/ops/` | `rf1116-window-pause.sh` (see "Window pause") and its `window-pause.log`; run logs under `ops/logs/` | kayla, 0755 | not mounted |
| `/srv/research-lane/rf1116-mining/out/` | `qrp-data/` (mining rounds, trials, holdout vault, G-MINE records) and `rounds/<round_id>/` (`attempts.jsonl`, `generate.json`, `selection.json`, `score.json`) | container uid 1000 (host 100999) | `/out:rw`, the only writable mount |

**`out/qrp-data/` persists across rounds and is never deleted.** It holds the cumulative N of family `MINE:CN_A:H5`. Container-written files belong to host uid 100999, so kayla can read them but cannot remove them.

### Lane copy layout

- **Spec:** the lane copy follows `RF1116_CN_A_LANE_COPY_EXPORT_SPEC_V1.f1b3a200.md` as corrected by `RF1116_CN_A_LANE_COPY_EXPORT_SPEC_V1_ERRATA_1.md` (sha256 `a47a2ebbe201aa617c16d41b63bbee8e80dc3764d88f84aab13a45d2b265b014`). The validation tail and the holdout follow export spec **rev 4** (`RF1116_CN_A_LANE_EXPORT_SPEC_V1.33093147.md`, sha256 `33093147e8ff7be0815b1b7f1800cfd61edc05cab261d7839a52c9e2766e0ecd`). Rev 4 changes only the §3 checks and gives the holdout directory an end date `D1`; its SQL is that of rev 3 (`b523435d`, a note-only revision of `a24afab2`). The rev 3 exports of 2026-11-18 05:34 were void under rev 3 §3 and are not used.
- **Files and columns** (the same names and columns as export spec §2, unchanged from rev 3 to rev 4, plus industry membership):
  - `prices_daily_stock.csv`
  - `market_daily_basic_observation_stock.csv`
  - `adjustment_factor_observation_stock.csv`
  - `security_master_stock.csv`
  - `security_suspension_observation.csv`
  - `security_suspension_day_coverage.csv`
  - `trading_calendar.csv`
  - `industry_membership_sw2021.csv`
- **Dates:** trade dates 2020-06-01 → 2026-09-28.
- **Calendar:** `trading_calendar.csv` comes from `canonical_calendar_observation`, with `market` = `A_SHARE` and the exchange in `exchange`, covering 2019-06-01 → 2026-12-31.
  - **The lane copy's calendar is SSE-only.** The BASE database holds one SSE row per calendar day (2,771 rows) and no SZSE rows. The coordinator's ruling ★RF1116_CAL_MIN (a) amends the calendar minimum to match. The export manifest records `SPEC_DEVIATION calendar_min_rows` and `CALENDAR_SZSE_ABSENT`.
  - The validation tail and the holdout come from the live database under export spec rev 4. The live `canonical_calendar_observation` is SSE-only as well (2,771 rows, 1,842 SSE open days, 0 SZSE rows). Rev 4 §3 records the SSE/SZSE check as N/A in each export manifest; rev 3's 3,600-row minimum assumed two exchanges and voided the first export.
  - **Nothing requires SZSE rows.** The runner takes open days from SSE rows only (`data-adapter/index.js:212–229`; the holdout check reads READY SSE rows). Where SZSE rows exist, any SSE/SZSE disagreement is listed in the panel manifest; where they do not, there is nothing to list. A test pins that an SSE-only calendar reads the same open days.
  - Starting at 2019-06-01 is what makes the 120-session listing rule work from the first mining day.
- **Security master (rev 3 §2.1):** `security_master_stock.csv` comes from `canonical_security_observation`. It has the rev 2 column names plus `record_id`, `revision` and `allow_new_risk`, and holds each security's last row before the directory's first date plus every row inside it. (The legacy `security_master` and `trading_calendar` tables are empty in the live DB.)
- **Integrity:** the lane copy's `SHA256SUMS` comes from `sha256sum *.csv EXPORT_MANIFEST.json STEP0.json`, so it also covers `EXPORT_MANIFEST.json` and `STEP0.json`. Files are 0444, directories 0755.
- **Source:** exported read-only, with no vendor re-fetch, from the BASE replay database **`ashare_v6_replay_c3fwd`** in the lane's `c3fwd-postgres` container. The spec named `ashare_v6_replay_c1`, which does not exist on that instance (errata 1 §1); the export manifest records `SPEC_DEVIATION db_name`.
- **Other formats:** a different reader can be plugged in with `--lane-adapter <module>` (a module exporting `createSource(dir, opts)`). No adapter is needed when the layout above is used.

## One-time setup

**Code on the lane.** GitHub reachability from the lane is unknown (Docker Hub is blocked there). Use one of:

- **(a) Default when GitHub is not reachable: `git archive` from the Mac.** Run this from the Mac's QRP checkout. It records the commit in `code/.QRP_COMMIT`:

  ```sh
  git -C <mac-qrp-checkout> fetch origin && git -C <mac-qrp-checkout> archive <merge-commit> | lx 'mkdir -p /srv/research-lane/rf1116-mining/code && tar -x -C /srv/research-lane/rf1116-mining/code'
  echo <merge-commit> | lx 'cat > /srv/research-lane/rf1116-mining/code/.QRP_COMMIT'
  ```
- **(b) When GitHub is reachable: clone on the lane.**

  ```sh
  git clone https://github.com/UpMeAI/quant-research-platform.git /srv/research-lane/rf1116-mining/code && git -C /srv/research-lane/rf1116-mining/code checkout --detach <merge-commit>
  git -C /srv/research-lane/rf1116-mining/code rev-parse HEAD > /srv/research-lane/rf1116-mining/code/.QRP_COMMIT
  ```

Then build the image and make `out/` writable:

```sh
mkdir -p /srv/research-lane/rf1116-mining/{code,data,holdout-sealed,out}
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

**Prerequisite: the lane copy.** Before the first `generate`, `data/rf1116-cn-a-lane-copy-20200601-20260928/` must exist. The coordinator exports it read-only per `RF1116_CN_A_LANE_COPY_EXPORT_SPEC_V1.f1b3a200.md` and its `…_ERRATA_1.md`: from `c3fwd-postgres` / `ashare_v6_replay_c3fwd` (the Q0 replay BASE), bounded 2020-06-01 → 2026-09-28, files 0444, with `EXPORT_MANIFEST.json`, `STEP0.json` and a `SHA256SUMS` covering all of them. It is not part of the 21:42 export.

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
- **records the floor on resume too:** on `resume`, the floor used is appended to the round row (`data_checks.resumes`).
- **checks the data before anything is written:** it builds the mining-segment panel and requires at least **2,000** names per decision day (in the universe, with a back-adjusted close; the first day is exempt).
  - The floor that was used is written into the round row (`data_checks.coverage_floor`: value, default, `overridden`).
  - `--min-names-per-day` exists for synthetic tests only; never pass it on the lane.
  - Otherwise it refuses with `MINE_RUNNER_COVERAGE_BELOW_FLOOR:<day>:<n><2000>`. No round is opened and nothing enters N.
  - The 2020-06 universe is about 3,800 names before exclusions.
- **checks that the panel can score at all (canary, added after round 1's defect of 2026-11-18, tightened after the independent review):** before any round is opened or resumed, and again inside `generate()`, `(-close_hfq)` is run through the candidates' own neutralization path. A scored day is 1 ≤ t ≤ days − H − 1.
  - On every scored day, the universe names with a finite neutralized value must number ≥ the coverage floor (**2,000**) and ≥ **0.9** × that day's coverage count (universe names with a finite `close_hfq`).
  - The mining score must be finite, with IC days ≥ **0.95** × the scored days.
  - Otherwise it refuses with `MINE_RUNNER_CANARY_UNSCORABLE:<formula>:<date>:neutralized=<n><max(<floor>,0.9x<coverage>)>` or `…:ic_days=<n><<min>`. No round is opened, no resume is recorded, nothing is sealed and nothing enters N.
  - `generate.json` carries the result (`canary`: per formula `min_named`, `min_named_date`, `min_share`, `min_share_date`, plus the thresholds). `generate()` computes it itself and ignores any value passed in.
  - Round 1 (`MR-CN_A-2026-11-e1ab63a27b`) had no usable industry-membership row. Scoring neutralization turned every value into NaN, and all 200 attempts had 0 IC days.
- **never records a null score as scored:** an attempt whose mining score is not a finite number is recorded as `UNSCORABLE`, with its `ic_days`.
  - Like a parse-refused or deduplicated attempt, it counts in N and is never selected.
  - `generate.json` counts it under `attempts.unscorable`.
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

### Window pause (rulings ★RF1116_GENERATE_WINDOW (a) and ★RF1116_SCORE_PAUSE (a))

Generation and scoring yield to V6 production on the lane, which carries V6 production from 2026-11-23. A kayla user timer runs a script every minute, Monday to Friday (CST):
- it `docker pause`s a running `rf1116-generate-*`, `rf1116-resume`, `rf1116-score` or `rf1116-rescore` container inside 06:30–08:00 (the ruling), 09:15–15:30 (the trading session) and 18:10–20:45 (the post-close chain), the V6 windows listed under "Limits and timing";
- it `docker unpause`s it outside them;
- each action is appended to `ops/window-pause.log`.

It touches no other container. `rf1116-mechanisms` and `rf1116-review` are not paused: they take 1 CPU / 2 GB and finish quickly. The runner has no wall-clock limits (the only clock read in `round-runner/index.js` is a timestamp), so a pause only delays a phase: the same seed gives the same trials, a paused `score` scores the same selection, and only the timestamps move. A pause is not a crash: a paused `score` stays one open of the holdout, and `rescore` (R1.8) is not involved.

The copies in this directory are what gets installed; after an install, the lane files must have these sha256. `rf1116-window-pause.sh` was `a887f774…` until ★RF1116_SCORE_PAUSE (a) added `rf1116-score` and `rf1116-rescore`; the two units are unchanged (sha256 first read on the lane 2026-11-18):

| file in this directory | installed at | sha256 |
|---|---|---|
| `rf1116-window-pause.sh` | `/srv/research-lane/rf1116-mining/ops/rf1116-window-pause.sh` | `4541bdee579422490961e746015c19340c4eedf247e6aa2f04903882cf652d0e` |
| `rf1116-window-pause.service` | `~kayla/.config/systemd/user/rf1116-window-pause.service` | `641ca7f630bd50a8f66709f8450c9dc905af1a95597077ed484fd75d6eeba268` |
| `rf1116-window-pause.timer` | `~kayla/.config/systemd/user/rf1116-window-pause.timer` | `4b32a7567cdeb8ff4bba977521067cc868ad94607c140884c463eaf007028c90` |

Install, or re-install after a change:

```sh
install -m 0755 deploy/research-lane/round-runner/rf1116-window-pause.sh /srv/research-lane/rf1116-mining/ops/
install -m 0644 deploy/research-lane/round-runner/rf1116-window-pause.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now rf1116-window-pause.timer
sha256sum /srv/research-lane/rf1116-mining/ops/rf1116-window-pause.sh ~/.config/systemd/user/rf1116-window-pause.{service,timer}   # must match the table
```

`tests/rf1116_window_pause.test.js` runs the script with stub `date` and `docker`. It checks which containers are paused, the window edges, weekends, and that this table holds the files' sha256.

The windows use weekdays only. On an exchange holiday the script still pauses in the windows, which costs time but nothing else.

## Mechanisms and their review (R1.5), before the hand-over

Under R1.5 the AQuA session writes the mechanisms and the coordinator reviews them. After `generate` has written the selection, the steps run in this order (`run.sh` stands for `RF1116_RUNNER_IMAGE=qrp-round-runner:<commit12> /srv/research-lane/rf1116-mining/code/deploy/research-lane/round-runner/run.sh`):

1. **List the survivors:** `run.sh mechanisms <round_id>`. It prints the survivors (ids from the selection row, formulas from the trial rows), their registration state, the current `mechanism_set_sha256` and the latest review.
2. **AQuA writes `mech.jsonl`:** one line per survivor it can explain, `{candidate_id, mechanism_id, economic_logic_zh, failure_mode_zh, written_at}`. `written_at` is Beijing time with `+08:00` and no later than the registration. `mechanism_id` must already be in the mechanism register (R1.10).
3. **Register them:** `run.sh mechanisms <round_id> mech.jsonl`. Append-only; refused once the holdout is open. A survivor without a registration is still scored but fails G-MINE item 9.
4. **The coordinator reviews:** `run.sh review <round_id> verdicts.json` writes one `MECHANISM_REVIEW_V1` row. The file is `{"mechanism_set_sha256": "<from step 1, after step 3>", "reviewer": "coordinator", "verdicts": [{"candidate_id": "…", "verdict": "APPROVED" | "REJECTED", "note": "…"}]}`.
   - It needs a verdict for every survivor before `score` will run. `APPROVED` needs a registration. `reviewer` is free text, not an identity check.
   - The set sha must equal the current registrations (`MINE_MECHANISM_REVIEW_SET_CHANGED`). If a registration is added after the review, review again.
   - A second review is a new row naming the one it replaces (`supersedes`); the latest row wins. Reviews are refused once the holdout is open.
5. **Only then score:** `run.sh score <round_id>` (next section). It refuses before the open, and the open is not spent, when the latest review is missing (`MINE_RUNNER_MECHANISM_REVIEW_MISSING`), does not cover every survivor (`…_INCOMPLETE`), no longer matches the registrations (`…_STALE`), was altered (`…_HASH_MISMATCH`) or is dated after the open (`…_AFTER_OPEN`). A `REJECTED` survivor is still scored and recorded, and fails item 9 (`MINE_MECHANISM_REJECTED`).

- **What these steps mount.** `mechanisms` and `review` mount only `out/` (rw) and the input file (ro): no data, no holdout, no network.
- **File arguments.** `run.sh` resolves `mech.jsonl`, `verdicts.json` and the rescore crash log with `realpath -e` before mounting, so a name relative to the current directory works. A missing file stops `run.sh` before Docker is called.

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
   - For every SSE open day 2026-10-19 → 2026-12-31, each of the prices, daily_basic and adjustment-factor tables must have READY rows for at least **4,000 distinct `security_id`s** (export spec rev 3 §3).
     - Names are counted, not rows, because rows include revisions.
     - `.BJ` ids are not counted, since the panel excludes BSE.
   - Each day must also reach at least half of the median of the **sealed** days, meaning the days in the files listed by `SHA256SUMS.sealed`, which cannot move after sealing. A thin completion export therefore cannot pull its own median down.
   - If the sealed files hold no holdout day, it refuses with `…_HOLDOUT_SEALED_DAYS_EMPTY`.
   - Otherwise it refuses with `…_HOLDOUT_INCOMPLETE:<file>:<day>:<names>`.
   - The floor used is written into the vault's open record (`pre_open_checks`).
4. **The selection is the recorded one.** The `MINING_SELECTION_V1` row exists, and `selection.json` matches its sha (`MINE_RUNNER_SELECTION_FILE_MISMATCH`). The formulas are taken from the trial rows, not from the file.

If any check fails it refuses, and the single open is not spent.

**Recovery after a crash past the open (R1.8 and R1.12, ruling R1 revision 5 `f904e0fe…`).** If the score container dies after `holdout-vault.open` but before the last G-MINE record, the round stays in `SCORING`, and `score` is refused (`MINE_HOLDOUT_ALREADY_OPENED`).

Exactly one rescore of the same selection is allowed:

```sh
RF1116_RUNNER_IMAGE=qrp-round-runner:<commit12> /srv/research-lane/rf1116-mining/code/deploy/research-lane/round-runner/run.sh rescore <round_id> "<crash reason>" /path/to/crash.log
```

- **It is accepted only if all of these hold:**
  - the selection row is byte-unchanged;
  - every input is the same as at the open (the holdout manifest and `SHA256SUMS.sealed`, `selection.json`, the factor series, the data sources, the code, the floor, the mechanism registrations and the mechanism review), compared through `inputs_sha256`;
  - the latest mechanism review predates the open;
  - the first attempt wrote **no** G-MINE record.

  Otherwise it is refused: `MINE_HOLDOUT_RESCORE_SELECTION_CHANGED`, `…_INPUTS_CHANGED` or `…_RECORDS_EXIST`.
- **What it records.** The rescore is the vault's second event (`HOLDOUT_RESCORE_V1`: the reason, the log's sha256 and its first 4,000 characters). Then the same candidates are scored and the round is closed.
- **If the rescore itself crashes,** the next `rescore` closes the round as **`FAILED_RESCORE`**. No G-MINE record counts, but the attempts stay in N. After that, any further attempt is refused.
- **R1.12a (revision 5):** a rescore that writes records and then crashes also closes as `FAILED_RESCORE`, not `FAILED_PARTIAL`. Every record of a failed round, including those its rescore wrote, is marked VOID and counted nowhere.
- **A crash after the first record** cannot be rescored (ruling R1.12, revision 5 `f904e0fe…`). The same `rescore` command closes the round as **`FAILED_PARTIAL`** with the reason and the log's sha256 (`MINE_RUNNER_RESCORE_RECORDS_EXIST`): 0 passes, the written G-MINE records kept and marked VOID, the attempts in N, the open-round slot released, the holdout open still counted (no new round on that segment). After that, any further attempt is refused.

**After the checks** it does the following:
- opens the vault once;
- scores only through `neutralizeForScoring`;
- writes one `MINING_GATE_RECORD_V1` per candidate;
- closes the round.

## A round that was never evaluated (★RF1116_ROUND1_STATE (a))

`run.sh fail-evaluation <round_id> <reason> <evidence_sha256>` closes the round as **`FAILED_EVALUATION`**. It appends one row and edits nothing, and it mounts only `out/`.
- **When it is allowed:** only from `OPEN` or `CAP_REACHED`, and only if the holdout was never opened. It needs a reason and the sha256 of the defect report.
- **What it records:** 0 passes. The seal and selection rows stay.
- **What it frees:** the open-round slot.
- **What still counts:**
  - the attempts stay in N (signed §3.3: never reset by round);
  - the round counts toward its month's 2 rounds;
  - the pause rule counts it as 0 passes.
- After it, no candidate can be recorded and the holdout cannot be opened or scored.

**Round 1** (`MR-CN_A-2026-11-e1ab63a27b`, 2026-11-18): every mining score was null because no industry-membership row entered the panel (fixed by the canary and the industry-quality change). Run this once, with the image redeployed from the merge that contains this command:

```sh
RF1116_RUNNER_IMAGE=qrp-round-runner:<commit12> /srv/research-lane/rf1116-mining/code/deploy/research-lane/round-runner/run.sh fail-evaluation MR-CN_A-2026-11-e1ab63a27b "RF1116 round 1 (2026-11-18): no industry-membership row entered the panel (V6 writes DEGRADED, the adapter accepted READY only), so every mining score was null; ROUND1_DEFECT_STOP" 3e3c70fcdc792e716c8fe09fc774c92427a636a8f3719b064fc95d4be89aa4f9
```

The evidence sha256 is that of `artifacts/coordinator/evidence/rf1116-round1-defect-aqua-20261118/ROUND1_DEFECT_REPORT.md` (read-only). It prints one JSON line: `status: FAILED_EVALUATION`, `gmine_passes: 0` and the row's `record_hash`. Round 2 is then November's last round. It may share the 2026-10-19 → 12-31 holdout, because round 1 never opened it.

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
- **Concurrent rounds (R1.6):** up to 2 generation-only rounds per market may be open at once and may share the holdout segment, but only before its first open. Still at most 2 rounds per market per month (`LIMITS.rounds_per_month`). Once any round has opened a segment, no new round can open on it (`MINE_ROUND_HOLDOUT_SEGMENT_OPENED`); the next round needs a new segment after 2026-12-31.
