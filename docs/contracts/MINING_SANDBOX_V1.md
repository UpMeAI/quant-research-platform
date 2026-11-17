# MINING_SANDBOX_V1 — DSL, evaluator, search space, operator causality, isolation (RF1116 §3, P1 part 1); data adapter, scoring, GP (P2)

Source: `artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261116_FACTOR_LIBRARY_AI_MINING.signed.fd22876f.md`
(sha256 `fd22876f…0c80`, signature page `39f8c17c…`), §3.1–3.6, §8.1 row P1, §8.2, §8.3 items 6, 7, 11, 12.

Code: `services/mining-sandbox/` (`dsl/`, `evaluator/`, `space.js`, `isolation.js`). Runs on the research lane only; it reads no market
files itself, writes no ledger and calls no model API. Rounds, trial-ledger rows, the holdout vault and the `AI_MINED_CANDIDATE`
input category are part 2.

## DSL (`dsl/`)

Formulas are text, e.g. `rank(ts_mean(close, 20) / ts_std(close, 20))`. Both generators (`AI_MINED_LLM`, `AI_MINED_GP`) produce only this.

| item | rule | refusal |
|---|---|---|
| operators | cross-section `rank`, `zscore`, `neutralize_industry`, `neutralize_size`; time series `ts_mean`, `ts_std`, `ts_delta`, `ts_rank`, `ts_corr`; `sign`, `abs`, `log`; `+ - * /` and unary minus | `MINE_DSL_OPERATOR_NOT_WHITELISTED`, `MINE_DSL_OPERATOR_NOT_IN_SPACE` |
| length | ≤ 20 tokens; a token is an operator name, a reading, a number or an arithmetic operator (parentheses and commas don't count) | `MINE_DSL_TOO_LONG` |
| nesting | ≤ 5 levels of operators (readings, constants and windows are level 0) | `MINE_DSL_TOO_DEEP` |
| readings | only those in the frozen space | `MINE_DSL_READING_UNREGISTERED` |
| constants | only the registered grid | `MINE_DSL_CONSTANT_NOT_IN_GRID` |
| windows | a literal integer from the registered lookbacks, ≤ 250, and at least the operator's minimum | `MINE_DSL_LOOKBACK_INVALID` |

All refusals happen at parse time. `parse()` returns the tree, a canonical form and its sha256 (used for dedupe and the "already tried" list).

## Evaluator (`evaluator/`)

- **Input.** It takes a panel (dates × codes) whose readings are already cut at their PIT availability, and it only looks back. Time-series windows end on the current day, and an incomplete window gives NaN. Cross-section operators use only the current day. Missing values propagate as NaN and are never filled.
- **One implementation.** The evaluator and the causality evidence call the same functions in `evaluator/operators.js`.
- **Neutralization before scoring.** `neutralizeForScoring` subtracts the industry mean, then takes the residual of a regression on log size, and stamps `neutralization {industry: APPLIED, size: APPLIED}`. G-MINE items 3–5 (IC/ICIR, monotonicity, decay) refuse holdout readings without that stamp with `MINE_NOT_NEUTRALIZED` (§3.6, §8.3 item 12).

## Search space `MINING_SPACE_V1` (`space.js`)

- **Contents.** Registered readings (each with dataset id and PIT availability), a subset of the operator whitelist, a constant grid, lookbacks ≤ 250, holding periods, and `max_tokens` ≤ 20 / `max_depth` ≤ 5. The two limits can only be tightened.
- **Readings must be registered** (coordinator, 2026-11-17).
  - **Dataset:** each `dataset_id` must be in the pinned KG dataset registry (`services/dataset-registry`), otherwise `MINE_SPACE_READING_UNREGISTERED`.
  - **PIT token:** `pit_available_at` must start with the registry's PIT token for that dataset, a whole token (e.g. `OBSERVED_AT …`), otherwise `MINE_SPACE_READING_PIT_MISMATCH`. A dataset with no PIT in the registry is refused the same way.
  - **Mixed datasets** (no `pitSemantics`, a `pitSemanticsBySeries` map): the reading must carry a `series` from the map, and the PIT is checked against that series. A missing series gives `MINE_SPACE_READING_SERIES_REQUIRED` and an unknown one `…_SERIES_UNKNOWN`. A `series` on a non-mixed dataset gives `…_SERIES_NOT_ALLOWED`.
  - **History only on datasets with a historical clock** (coordinator ruling, 2026-11-17: the sandbox uses history only, and decisions are next-open under P-14).
    - **Datasets with a historical clock** (registry 1.14.0 `pitHistoricalClock`): the head token of `pit_available_at` must be that clock:
      - `{rule}`: the rule;
      - `{bySeries}`: `bySeries[series]`, with `series` required. For example, `V6_CN_STOCK_DAILY_BARS` maps `daily` → `BAR_CLOSE` and `adj_factor` → `CLOSE_DATED_NEXT_OPEN_USABLE`.

      Declaring the live PIT instead (e.g. `OBSERVED_AT` on the two V6 stock datasets) gives **`MINE_SPACE_READING_LIVE_CLOCK_IN_HISTORY`**. Any other token gives `MINE_SPACE_READING_PIT_MISMATCH`.
    - **Datasets without a historical clock** keep the live-PIT rule above, unchanged.
    - **Drafts:** the coordinator's DRAFT_3 (all `OBSERVED_AT`) is refused; DRAFT_4 (historical clocks, `0d3556fa…`) passes.
  - **Readings built from several series.** `series` may be an array of two or more series, on a dataset whose live PIT is single and whose historical clock is per series (e.g. back-adjusted prices = `daily` × `adj_factor`). The declared clock must be the most conservative (latest usable) of those series' clocks. Arrays are not allowed on live-mixed datasets.
  - **Clock order** (only orders that can be justified; earlier → later usable):
    - `BAR_CLOSE` → `CLOSE_DATED_NEXT_OPEN_USABLE`: usable at the bar's close, versus usable only at the next open;
    - `NEXT_DAY_0000_CST` → `NEXT_TRADING_DAY_0900_CST`: the next trading day is never before the next calendar day, and 09:00 is after 00:00.

    A multi-series reading whose clocks are not all equal and not all in one of these chains is refused with `MINE_SPACE_READING_CLOCK_ORDER_UNDEFINED`.
- **Operators need proof first.** `operator_evidence {path, sha256}` binds the operator causality evidence. Every operator in the space must appear there as `role: FEATURE` with T-C1, T-C2 and T-C3 all PASS, otherwise `MINE_SPACE_OPERATOR_NOT_PROVEN_CAUSAL`.
- **Freeze.** The freeze page must state the space's sha256, `MINING_SPACE_V1` and `FROZEN`. Changing the space mid-round makes it a new round.

## Operator causality evidence (`docs/evidence/mining-operators-v1/`)

- **What it is.** `tools/causality-harness` was run on synthetic fixtures (`make-fixtures.js`). All 12 operators are `role: FEATURE` with T-C1, T-C2 and T-C3 PASS.
- **Re-run rule.** The test checks that `operators.js` at the evidence's `code_sha` equals the current file. Changing an operator means re-running the evidence.
- **Counter-example.** A deliberate t+1 peek (`tests/fixtures/mining-sandbox/peek`) fails both T-C1 and T-C2.

## Isolation (`isolation.js`)

- **Lockdown.** `lockdown({allowRoot})` is called once when a sandbox process starts. After that, every fs write entry point outside `allowRoot` throws `MINE_SANDBOX_WRITE_REFUSED`. That covers the sync, callback and promise forms, `open` with write flags and `createWriteStream`.
- **Coverage.** This includes the QRP ledger (`packages/ledger.append`), `config/`, and the V6 or smartflow checkouts. There is no unlock.
- **Imports.** Sandbox modules import neither the ledger nor any network module.
- **Network.** Network egress (model API only) is enforced by the research lane, not here.

## Segments (`segments.js`)

The three segments come from the frozen holdout page `docs/freeze/RF1116_HOLDOUT_CN_A_R1_FREEZE_1.md` (`0fefcd24…`, issued 2026-11-17T10:57:06+08:00). A test checks the dates against the page.

| segment | decision days | who sees it |
|---|---|---|
| `MINING` | 2020-06-01 → 2023-12-29 | scoring and the generator (through the generator view) |
| `VALIDATION` | 2024-01-02 → 2026-10-16 | the runner's selector only |
| `HOLDOUT` | 2026-10-19 → 2026-12-31 | the runner's holdout scoring only, after `holdout-vault.open` |

A segment is a range of decision days (trades at the open). Labels must fall inside the same segment, so the last H signal days of each segment have no label.

## Data adapter (`data-adapter/`) — P2

Reads the CSV directories of export spec rev 2 (`RF1116_CN_A_LANE_EXPORT_SPEC_V1`, `744c453e…`) into the evaluator's panel. It reads files only: no writes, no network, no ledger.

**Sources**
- `csvDirSource(dir, {mode, label, holdout})` reads one export directory. While it reads each file, it computes the file's sha256 and checks it against `SHA256SUMS` afterwards.
  - A file not listed gives `MINE_DATA_FILE_NOT_IN_SHA256SUMS`; a wrong sha gives `MINE_DATA_SHA256SUMS_MISMATCH`.
  - `sums_sha256` is the sha256 of the `SHA256SUMS` file itself (the holdout seal records it).
- `mode`:
  - `HISTORY` is the lane copy (backfilled history, 2020-06-01 → 2026-09-28);
  - `LIVE` is a directory exported from production with real ingestion times (the validation tail and the holdout).
- `holdout: true` marks the holdout directory. Such a source can only go into a `HOLDOUT` panel (`MINE_DATA_HOLDOUT_SOURCE_OUTSIDE_HOLDOUT`).
- **The lane-copy reader is pluggable.** `loadSource({dir, mode, label, adapter})` loads a module that exports `createSource(dir, {mode, label, holdout})` and returns the same interface (`has`, `forEach`, `label`, `mode`, `holdout`). Without `adapter`, it uses the CSV reader.

**Panel** (`buildPanel({sources, space, segment, from, to})`)
- `dates` are decision days: the open days of the SSE calendar in the sources.
  - Under export spec rev 3 (`a24afab2…`), the calendar comes from `canonical_calendar_observation`. There `market` is always `A_SHARE`, and the exchange is in `exchange`, with one row each for SSE and SZSE.
  - The adapter reads `exchange`, and falls back to `market` only when the column is absent. Per (date, exchange) it takes the row ingested last.
  - Only SSE rows define open days. No SSE rows gives `MINE_DATA_CALENDAR_MISSING:SSE`; SZSE is never substituted.
  - Dates where SSE and SZSE `is_open` disagree are listed in `manifest.calendar.sse_szse_disagreements`.
- **Next open only.** `readings[r][i][j]` is the value usable at the open of `dates[i]`: the row dated on the previous trading day.
  - Both historical clocks in the frozen space mean "a day-t row feeds only the t+1 open": `BAR_CLOSE` (daily bars) and `CLOSE_DATED_NEXT_OPEN_USABLE` (adjustment factor, `daily_basic`).
  - Any other clock gives `MINE_DATA_CLOCK_UNSUPPORTED`.
  - `assertUsable` refuses any earlier use with `MINE_DATA_LOOK_AHEAD`. For example, a day-t `daily_basic` row used for a day-t decision is refused.
  - A missing row is `NaN`. Nothing is carried forward.
- **Readings**
  - `*_hfq` = raw price × the same day's `adjustment_factor_observation` factor;
  - `ret_1d` = `close / previous_close − 1`;
  - `amount` = `turnover_amount_cny`;
  - the `daily_basic` readings come from its `values` JSON.

  A reading whose name, dataset or series differs from this map gives `MINE_DATA_READING_UNMAPPED`.
- **Revisions of one (security, date)**
  - Among rows ingested before 09:00 Asia/Shanghai on the next trading day, take the one ingested last (on a tie, the higher revision).
  - If none made the cutoff:
    - a `LIVE` source does not use the row (`counts.*.late_unused`);
    - a `HISTORY` source takes the state known at the earliest ingestion instant, with the highest revision recorded at that instant (`counts.*.backfill`). The P-14 backfill convention is pending the coordinator's ruling.
  - Rows whose `quality_state` is not `READY` are not used (`counts.*.quality_skipped`).
- **Universe** (`universe[i][j]`, freeze prep §2.3)
  - Included: main boards, ChiNext and STAR. BSE securities are not in the panel at all.
  - Excluded on the decision day: ST, listed fewer than 120 trading days (counted on the trading calendar), suspended for the full session, not `LISTED`, or delisted.
  - The security master snapshot used is the latest one on or before the decision day.
  - Export spec rev 3 puts the same calendar, 2019-06-01 → 2026-12-31, in every directory, so the 120-day count works from the start of the mining segment.
- **Industry** (`industry[i][j]`)
  - SW2021 level 1 `industry_code`.
  - A membership applies when `effective_from` ≤ day < `effective_to`, with revisions chosen by ingestion time as above: a revision ingested after the decision day's 09:00 is not used for that day (a test pins a later-ingested code change).
  - Membership history is backfilled, so it always falls back to the earliest recorded state.
  - When several memberships cover a day, the latest `effective_from` wins.
- **Size.** `size` is the previous day's `total_mv`.
- **Labels.** `labels.exec_open` is the decision day's back-adjusted open (that day's raw open × that day's factor). It is used only to compute forward returns for scoring.
- **Segment range**
  - A `MINING` panel lies entirely inside the mining segment.
  - `VALIDATION` and `HOLDOUT` panels may start at the mining start (lookback history) but never run past their own end.
  - Otherwise `MINE_DATA_SEGMENT_RANGE`.
- **Manifest.** `manifest` records the sources (label, mode, `SHA256SUMS` sha), the rules and the counts.

## Mining-segment scoring (`scoring/`) — P2

- **The score.** `miningScore(parsed, panel, {holding_period})` is the mining-segment score written into the trial row as `metrics.mining_segment_score`. It is computed as follows:
  1. the factor goes through `neutralizeForScoring` (industry, then size), only over names in the universe;
  2. the daily Spearman rank IC is taken against the open-to-open forward return over H days;
  3. the score is the mean over days, or `null` with fewer than 20 IC days.
- **Mining segment only.** A panel that is not a `MINING` panel inside the mining dates gives `MINE_SCORE_NOT_MINING_SEGMENT`. The generator's fitness therefore cannot read validation or holdout data.
- **Names per day.** A day with fewer than 5 names has no IC.

## GP generator `AI_MINED_GP` (`gp/`) — P2

- **Search.**
  - The first batch is grown at random.
  - Later batches breed from this round's scored candidates. Parents are chosen by tournament, and children come from subtree crossover or from subtree, point, window or hoist mutation.
  - Every output passes `dsl.parse` against the frozen space and is emitted in canonical form.
- **Fitness.** Fitness = mining-segment score − `length_penalty_per_token` (0.0005) × tokens. Parameters are frozen in `GP_PARAMS` (`AI_MINED_GP_PARAMS_V1`).
- **Generator view only.**
  - Input is limited to the generator view: `round_id`, `market`, `space`, `holding_periods`, `mining_scores` (`candidate_id`, `formula`, `mining_segment_score`) and `tried_formulas`.
  - Any other field gives `MINE_GP_VIEW_FIELD_NOT_ALLOWED`.
  - The module imports only `../dsl` and `crypto`: no data, scoring, vault or gate, and no network.
- **Deterministic.** `nextBatch(view, {n})` is a pure function of the seed, the parameters, the space and the view. Each batch's random seed is sha256(`AI_MINED_GP|seed|attempts so far`). The same seed, space and mining data give a byte-identical formula list, and a round resumed from the ledger continues the same way.
- **Novelty.** A child whose canonical form was already tried is redrawn up to `novelty_retries` (25) times. After that it is emitted anyway, and the runner counts it as a deduplicated attempt.

## Generators (`generators/`) — P2

- **GP.** `generatorFor(roundGenerator, {space, holdingPeriod})` builds the GP from `gp_seed`.
- **LLM.** `AI_MINED_LLM` gives `MINE_LLM_NOT_ENABLED`. The research key (★K (b)) has not been placed, so no key is read, no network is used and no LLM round is opened.
- **Anything else** gives `MINE_GENERATOR_UNKNOWN`.

## Round runner (`round-runner/`) — P2

It runs only inside the research lane's rootless container (`deploy/research-lane/round-runner/`, see its `DEPLOY.md`).
- `start` refuses to run unless `QRP_DATA_DIR` lies inside the output directory (`MINE_RUNNER_DATA_DIR_OUTSIDE_OUTPUT`). It then calls `lockdown`, so the process can write only the output directory.
- It is the one sandbox module that calls the QRP front doors (`mining-rounds`, `holdout-vault`, `gate-records`). It never imports `packages/ledger`.

| step | what | interface |
|---|---|---|
| 1 | open: frozen space `docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json` + freeze page `4ec642b9…` (sha checked, `parseSpace`, `verifyFreeze`), holding period 5, `AI_MINED_GP` with `gp_seed`, cap ≤ 200, frozen holdout. A request for `AI_MINED_LLM` gives `MINE_LLM_NOT_ENABLED` before `openRound` | `requestRound` → `openRound` |
| 2 | seal: the holdout directory's reference and the sha256 of its `SHA256SUMS`. The generation container does not mount the holdout | `sealHoldout` → `holdout-vault.seal` |
| 3–4 | generate from `generatorView` only, then score on the mining segment; every attempt is one trial row (below); stop at the cap, no top-up | `generate` → `recordCandidate` |
| 5 | select on the walk-forward folds into `<out>/rounds/<id>/selection.json`, plus one append-only `MINING_SELECTION_V1` row (the file's sha + selected ids) | `select` → `recordSelection` |
| 6 | check the selection row and the holdout directory, then open the vault once | `scoreHoldout` → `holdout-vault.open` |
| 7 | score through `holdout-scoring.js` only, which uses `neutralizeForScoring` | `roundResults` |
| 8 | one G-MINE record per opened candidate | `recordGateResult` |
| 9 | close; the pass count is derived from the records | `close` → `closeRound` |

**Coverage first** (P2 review item 4)
- Before the round is opened (CLI) and before any attempt is recorded (`generate`), the mining panel must have at least `COVERAGE_FLOOR.min_names_per_day` = **2,000** names per decision day, counting names in the universe with a finite `close_hfq`; the first day is exempt.
- Otherwise it refuses with `MINE_RUNNER_COVERAGE_BELOW_FLOOR`. An empty or half-exported lane copy therefore cannot write 200 unscored attempts into N.

**Attempts** (RF1116 §3.3, P2 spec §2 and §4 item 5)
- **Every attempt is one trial row,** written through `recordCandidate`, and counts toward the cap of 200 and toward N.
  - `PARSE_REFUSED`: the raw text, with the `MINE_DSL_*` code in `rule_config.refusal`, and no score.
  - `DEDUPED`: the canonical form was already tried in this market. No score.
  - Both carry `rule_config.attempt` and `rule_config.attempt_id`, so each is a distinct rule config in N.
  - Everything else is scored on the mining segment.
- **Ids.** Candidate ids are `<round_id>:A<nnn>`.
- **Audit log.** `attempts.jsonl` in the run directory lists every attempt.

**Selection** (`selector.js`, `VALIDATION_SELECTION_V1`)
- **Folds.** The folds are the 11-10 §7.2 test windows over the validation segment: six half-years, 2024H1 … 2026-07-01 → 2026-10-16.
- **Per fold.** Each fold gets the mean neutralized daily rank IC.
- **Default rule** (pending coordinator review):
  - the mean IC over the whole validation segment is > 0;
  - the fold mean is positive in ≥ ⌈2/3 × folds⌉ folds;
  - the mining score is > 0.
- **Where results go.**
  - The fold statistics go to `selection.json` only, never to the trial ledger or `generatorView`.
  - The ledger gets one `MINING_SELECTION_V1` row: the file's sha and the selected ids, no statistics.
- **After selection** the round's generation is closed (`MINE_RUNNER_GENERATION_CLOSED`, and `recordCandidate` gives `MINE_ROUND_GENERATION_CLOSED`).

**Holdout hand-over** (P2 review items 1–3). `scoreHoldout` does all of the following before `holdout-vault.open`:
- **Selection.** The `MINING_SELECTION_V1` row must exist, and `selection.json` must hash to its sha (`MINE_RUNNER_SELECTION_FILE_MISMATCH`). Ids come from the row; formulas come from the trial rows.
- **Manifest.** Either `sha256(SHA256SUMS)` equals the sealed sha, or `SHA256SUMS.sealed` hashes to it and every sealed line is still present (completion exports are append-only, as `<table>_<YYYYMMDD>.csv`).
- **Files** (`holdoutDirCheck`, a pure function of the directory and the seal):
  - every CSV in the directory is listed (`…_FILE_UNLISTED`);
  - every listed file exists and hashes to its line (`…_FILE_MISSING`, `…_FILE_SHA_MISMATCH`);
  - all 7 tables are present (`…_TABLE_MISSING`).
- **Completeness.**
  - The SSE calendar reaches the holdout end.
  - The calendar's READY SSE rows reach the holdout end.
  - For every SSE open day in the holdout, the prices, daily_basic and adjustment-factor tables have READY rows for at least `HOLDOUT_FLOOR.min_names_per_day` (**4,000**, export spec rev 3 §3) **distinct `security_id`s**.
    - Names are counted, not rows (re-review G5).
    - `.BJ` ids are excluded, as in the panel.
    - The mining-panel universe floor `COVERAGE_FLOOR` stays at 2,000, because the 2020 universe is about 3,800.
  - Each day also reaches at least half of the median of the **sealed** days: the days covered by the files listed in `SHA256SUMS.sealed`, which cannot move after sealing (re-review G5c).
    - A thin completion export can therefore no longer pull its own median down.
    - If the sealed files hold no holdout day, it refuses with `…_HOLDOUT_SEALED_DAYS_EMPTY`.
  - The refusal is `…_HOLDOUT_INCOMPLETE:<file>:<day>:<names>`. The floor used goes into the open record's `pre_open_checks`, and the generate-phase floor into the round row's `data_checks`.
  - Export spec rev 3 ships the full calendar in every export, so the calendar alone proves nothing.

Any failure refuses without spending the single open. A second open gives `MINE_HOLDOUT_ALREADY_OPENED`.

**Recovery after the open (R1.8).** If the runner dies between `holdout-vault.open` and the last G-MINE record, the round stays `SCORING`, and `scoreHoldout` is refused (`MINE_HOLDOUT_ALREADY_OPENED`).
- **The one rescore.** `rescore` (CLI `rescore`, run.sh `rescore <round_id> <reason> <crash.log>`) allows exactly one same-selection rescore. It reruns every pre-open check through `prepareScoring`, which is shared with the first attempt. It also recomputes `inputs_sha256`:
  - the selection row and file;
  - the holdout manifest and `SHA256SUMS.sealed`;
  - the factor series;
  - the data sources;
  - the code files;
  - the floor;
  - the mechanism registrations.
- **The vault event.** The vault then records the second event, which requires everything unchanged and no G-MINE record, and the same candidates are scored.
- **A second crash** closes the round as `FAILED_RESCORE` on the next call (`MINE_RUNNER_RESCORE_FAILED`). Afterwards everything is refused (`MINE_RUNNER_ROUND_FAILED_RESCORE`).
- **A crash after the first record** cannot be rescored (`MINE_HOLDOUT_RESCORE_RECORDS_EXIST`).

**Holdout scoring** (`holdout-scoring.js`; the runner is its only caller)
- **Scoring days.** Decision days are inside the holdout, and so are the labels.
- **IC.** `ic_mean` is the mean daily rank IC; `icir` is mean ÷ sd over every H-th day (non-overlapping).
- **Quintiles and decay.** Quintile means are taken on the non-overlapping days; `ic_double_horizon` is the IC at 2H.
- **Net of cost**
  - Long-only top 20%, equal weight, rebalanced every H days.
  - Cost per side is commission 2.5 + slippage 10 bps (the G-COST CN_A floor), plus 5 bps stamp duty on sells.
  - Measured against the equal-weight universe, annualized over 242 days.
  - Limit-up and limit-down fills are not modelled, because the export has no limit prices.
- **DSR** comes from monthly paired differences with N = the family's cumulative count. With about 3 holdout months it is `UNKNOWN` (`T_LT_24`).
- **PBO** is CSCV over the opened candidates' daily log excess returns (`ROUND_CANDIDATE_SET`); with fewer than 4 candidates it is `NOT_APPLICABLE`.
- **Marginal and correlation** inputs are left empty with a reason, because the library's CN_A factor series are not in the lane data.
- **Mechanism** is `null`, because GP registers none.
- **Effect.** G-MINE therefore records `pass: false` for every GP candidate until those inputs exist.

## Coordinator ruling R1 in the runner (2026-11-17, revision 2 `d80ce988…`, which adds R1.8)

- **R1.1.** Every attempt is a trial row (see "Round runner").
- **R1.2.** `requestRound` writes `rulings` (the R1 page, verified against `docs/freeze/RF1116_RULING_R1_20261117.md`) and `selection_rule` = `selector.RULE` into the manifest. `selector.RULE` is FROZEN by R1.2, written as data. `select` reads the rule from the round row, never from the constant.
- **R1.3 DSR on the validation folds.**
  - `select` runs the same long-only book as the holdout, with limits and costs, over the validation decision days. It writes each candidate's monthly paired differences and SR (`validation_book`) into `selection.json`, which is sha-pinned by the selection row.
  - At scoring, `dsrFromValidation` computes DSR with N = the family's cumulative count at that moment, and the family SRs = every evaluated candidate's validation SR.
  - It is recorded as `overfit.dsr_segment: VALIDATION_FOLDS` with `dsr_t_months`. With fewer than 24 months it is `UNKNOWN` (`T_LT_24`). Items 3–5 stay on the holdout.
- **R1.4 Existing factor series** (`factor-series/`, `FACTOR_SERIES_V1`).
  - **Input.** `score --factor-series DIR` reads `factor_series.csv` (factor_id, grain STOCK|UNIT|ETF, business_date, key, value, first_available_at) and `unit_membership.csv`. Each is checked against SHA256SUMS before the open.
  - **Clock.** A value dated D feeds only the next trading day's open, and only if `first_available_at` is before that day's 09:00. UNIT values map to stocks through the same day's membership.
  - **Item 8.** For every same-market library factor it gives the cross-sectional Spearman and the factor-return correlation (daily OLS slopes against next-open returns) over the holdout scoring days.
  - **Item 7.** It gives the intercept t of the candidate's factor returns regressed on every book factor's returns.
  - **What stays UNKNOWN.** ETF-grain factors are `ETF_GRAIN_NOT_MAPPABLE_TO_STOCKS`; missing factors are `FACTOR_SERIES_ABSENT` or `…_NOT_PROVIDED`. Item 7 stays null while any book factor lacks a series. Since `CN_A_ETF.MOM.SECTOR_ETF_REALIZED_MOM20` is a CN_A library and book factor, items 7–8 cannot pass for stock-level candidates until the coordinator rules on its comparison set.
- **R1.5.** `run.sh mechanisms <round_id> [registrations.jsonl]` (CLI `mechanisms`) lists the survivors (ids from the selection row, formulas from the trial rows) with their registration state, and registers a JSONL file.
  - Before the open, `scoreHoldout` attaches each candidate's registration (`mechanism`: id, texts, `written_at`, `registration_hash`).
  - A candidate without one is still scored, with `mechanism: null` and `mechanism_reason: NO_MECHANISM_REGISTERED_BEFORE_OPEN`, and item 9 fails.
- **R1.6.** The result carries `holdout.segment_open_index`.
- **R1.7 Limits** (`price-limits.js`, copied from V6 83ab3af1).
  - **Bands.** `config/v6/market-rules/price_limit_history_v1.json:105–116`; anything but ST reads NORMAL (`price-limit-history.js:69–90`). Main board 10%. Main-board ST 5% until 2026-07-06, then 10%. ChiNext and STAR 20%.
  - **Board.** From the code prefix (`kernel/security/classifier.js:29–32`), falling back to the master board for non-V6 codes.
  - **Limit price.** `roundToFen(previous_close × (1 ± band))` (`price-limit-band.js:47–48, 61–64`).
  - **Fills.** A buy is blocked if the open ≥ limit-up − 0.005, and a sell is carried if the open ≤ limit-down + 0.005 (`paper-simulator.js:89, 122`). With no open, neither fills. Counts go in `net_of_cost.limit_events`.
  - **Where V6 differs.**
    - V6 registers ChiNext and STAR only from 2026-07-06. Two `RESEARCH_EXTENSION` records cover earlier validation dates: ChiNext 20% from 2020-08-24 (10% / ST 5% before), and STAR 20% throughout.
    - The ruling text says main-board ST 5%. V6's own table says 10% from 2026-07-06, and the ruling defers to V6 item by item.
  - **Panel inputs.** The panel carries `labels.open_raw`, `labels.prev_close_raw`, `board` and `st`.
