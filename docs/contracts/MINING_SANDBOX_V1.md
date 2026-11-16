# MINING_SANDBOX_V1 — DSL, evaluator, search space, operator causality, isolation (RF1116 §3, P1 part 1)

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
  - **Live PIT or historical clock** (registry 1.14.0 `pitHistoricalClock`; coordinator review note). Mining is next-open only and history is dated by the historical clock, so the head token of `pit_available_at` may be either the live token above or the dataset's historical clock:
    - `{rule}`: the rule;
    - `{bySeries}`: `bySeries[series]`, with `series` required. For example, `V6_CN_STOCK_DAILY_BARS` maps `daily` → `BAR_CLOSE` and `adj_factor` → `CLOSE_DATED_NEXT_OPEN_USABLE`.

    Anything else gives `MINE_SPACE_READING_PIT_MISMATCH`.
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
