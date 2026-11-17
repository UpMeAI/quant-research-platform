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
