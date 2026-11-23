# PANEL_LABELS_V1 — W18 part 2: research side label join for the all candidate panel

Source (authoritative, frozen): `W18_ALL_CANDIDATE_PANEL_CONTRACT_V1_FREEZE_1.md` (plan-coord, 2026-11-23T11:30:51+08:00, sha256 `cc8e3724bf3d142313f9a4e0abd048b445a43d837cf2f848100d3a7e66e20826`), sections 7, 8.2 and 10 conditions 2, 3, 4, 6.
This page records how QRP implements them; it changes no acceptance. Part 1 (the `CANDIDATE_PANEL_V1` producers in Ashare-V6, smartflow, portfolio-desk) is not in this repository.
Code: `services/panel-labels/`. Tests: `tests/panel_labels_{label,isolation,stage_gate,join_report}.test.js` with `tests/_panel_labels_fixture.js`. `production_effect: NONE`; no model, no prediction, no order, no network, no database.

## What a label is

A result fact computed by a deterministic program from prices (LB-1): what a panel candidate's price did over a declared window after the evaluation. Append only. A label is never written into a panel file, a decision record or the desk (LB-2); the panel files are read only here.

| field | note |
|---|---|
| `candidateId`, `panelRecordHash` | the only join keys to part 1 |
| `windowId`, `windowUnit`, `windowLength` | `W5S` = 5 sessions, `W24H` = 24 hours; allowed values are the W-7 table below |
| `entryBasis` | CN `NEXT_SESSION_OPEN` (B13 method `RAW_OPEN_AND_CLOSE_TIMES_HISTORICAL_ADJ_FACTOR_V1`); US and crypto `FIRST_COMPLETE_BAR_OPEN_AFTER_EVALUATION` |
| `entryAt`, `exitAt` | instants the prices were taken; `null` unless the label has a value |
| `grossReturn`, `benchmarkReturn`, `excessReturn` | present only when `state = VALUE`; `grossReturn` is exit close over entry open minus 1, no cost (W-8). A benchmark that is missing keeps `grossReturn` and writes `{state: UNKNOWN, reasonCode}` for the other two |
| `maturesAt` | window end plus the provider's availability lag, computed from the calendar before any price exists |
| `maturedAt` | actual availability, never before `maturesAt`; `null` unless `VALUE` (= B13 `label_available_at`) |
| `state`, `reasonCode` | `VALUE` / `UNKNOWN` / `NOT_APPLICABLE`; reasons `LABEL_NOT_MATURED`, `PRICE_UNAVAILABLE`, `INSTRUMENT_DELISTED_IN_WINDOW`, `PANEL_RECORD_MISMATCH`, `BENCHMARK_PRICE_UNAVAILABLE`, `EXCESS_BENCHMARK_UNAVAILABLE` |
| `priceSourceRef`, `computedAt`, `labelHash` | provider id and version, price method, priced instrument (the row's `carrierId` when it has one), benchmark id, per price source refs. `labelHash` excludes `computedAt`, so a recomputation has the same hash |
| `researchOnly: true`, `productionEffect: NONE` | no model, probability, capital or order key is accepted (`LABEL_FORBIDDEN_FIELD`) |

Rules: before `maturesAt` the label is `UNKNOWN / LABEL_NOT_MATURED` with no return key, never 0, and the provider is not asked for a price (LB-6). A matured label is a new row; the old row is untouched; a matured value is never rewritten or turned back into a gap (`LABEL_MATURED_VALUE_CHANGED`, `LABEL_APPEND_REGRESSION`). A row without `windowId`, `maturesAt`, or (when `VALUE`) `maturedAt` is refused `LABEL_WINDOW_OR_MATURITY_MISSING` (LB-7). A truncated panel candidate has no row, so no label; the label job lists the count (LB-8).

W-7 allowed windows (values to choose from, not a default; every K2 declares its own, and `materialize` refuses a call that declares none, `LABEL_WINDOWS_NOT_DECLARED`): CN and US `SESSION` 1, 5, 10, 20; crypto `HOUR` 4, 24, 72. Benchmarks: CN `CSI300`; US `SPY` (`QQQ` only when the caller asks); crypto `BTC`.

## Price provider (injected)

`computeLabel` takes a provider; there is no network or file access in the label code. Interface (see `label.js`): `providerId`, `providerVersion`, `priceMethod(market)`, `entryAt`, `exitAt`, `availabilityLagMs` (calendar only), `price({market, instrumentKey, at, field: OPEN|CLOSE, asOf})` returning `{state: VALUE, value, availableAt, sourceRef}` or `{state: UNAVAILABLE, reasonCode}`. A price that is available after `asOf` must come back unavailable; a provider that returns one anyway is refused (`LABEL_PROVIDER_FUTURE_PRICE`).
Shipped: `fixture-provider.js` (explicit tables, for tests). **No real provider is shipped.** A real one needs: the market calendar and session open and close instants (CN, US with DST and half days; crypto bars), the availability lag per market, point in time prices with their `availableAt`, CN open and close adjusted by the B13 method, delisting dates, and the benchmark series (CSI 300, SPY, QQQ, BTC). QRP has no US or crypto price store; the CN export reader `services/mining-sandbox/data-adapter` (raw price times the same day adjustment factor) is a segment bound panel builder, not a price series API.

## Isolation (R-1, LB-3, condition 3)

No new permission system. The label directory is registered as a controlled data directory of the existing W20 authority layer (`services/independent-verifier/authority.js`; hosts list it in `QRP_HOLDOUT_DATA_DIRS`, tests pass `holdoutDirs`). Then:

- `authority.authorize({action: READ_FILE})` refuses `mining-generator` and `review-agent` (`HOLDOUT_DIR_READ_REFUSED`) and any unregistered principal, a K2 drafter included (`VERIFIER_PRINCIPAL_UNKNOWN`); only the evaluator principal (the config's `holdoutScorerPrincipal`, `holdout-scorer`) is allowed. `WRITE_FILE` on the directory is refused for every runtime principal.
- a generator launcher process takes the existing process lock (`launcher.lockGenerator`): the file read and the write are refused at the fs layer, and the refusal is logged.
- `readLabels` calls that layer; it does not decide who may read. It refuses a directory that is not registered (`LABEL_STORE_NOT_PROTECTED`), because the authority layer allows reads of directories it does not control.
- every read appends a read record (LB-5) to the read ledger and an `op: READ, dataset: PANEL_LABELS_V1` row to the W24 hash chained access log; every refusal appends `op: HOLDOUT_READ_REFUSED` with the code (the access log has no other refusal op).

OS level isolation (users, mounts) is host evidence (`tools/independent-verifier-host-evidence.js`) and is not verified here.

## Controlled read and stage gate (R-2, R-3, LB-4, LB-5)

`readLabels(request, ctx)`: request `{principal, k2Ref {id, sha256}, stage, market, families, from, to, windows, readAt, panelRecords, forward?}`. Stage is the K2's declared stage: `SEEN`, `UNSEEN_FIRST_READ`, `FORWARD`. For every family the gate calls `trials.segmentsFor`:

- SEEN: readable.
- UNSEEN: only stage `UNSEEN_FIRST_READ`, only for a K2 whose bytes (`ctx.k2Bytes`) match its sha256, whose section 0 says `冻结者 COORDINATOR` (not `K2_FREEZE_PROGRAM_V1`, not unknown), and which has a registration row in the trial ledger for that family; else `LABEL_READ_UNSEEN_NOT_PERMITTED`.
- FORWARD_RESERVED days (a later FORWARD_READ of the same shadow closes them): stage `FORWARD`, `forward.shadowRef` equal to the one holder, else `LABEL_READ_FORWARD_NOT_PERMITTED`; `readAt` not before `forward.declaredReadAt`, else `LABEL_READ_FORWARD_BEFORE_READ_TIME`.

A passed read appends the read record `{readerRole, k2Ref, stage, families, from, to, windows, readAt, rowsReturned, sha256, ...}` (`sha256` = hash of the record; extra keys `rowsSha256`, `readKey`, `forward`), then one `DATA_SEGMENT_MARK_V1` per family through the existing `trials.markSegments`: `SEEN` over `[from, to]` with `source_refs[0] = {kind: PANEL_LABEL_READ, read_record_sha256, read_key}`, plus `FORWARD_READ` over the reserved days the holder read. Replaying the same read (same `readKey`) appends a read record but no second mark. If a mark cannot be written, no row is returned and an abort row is appended. Only labels whose evaluation date is inside `[from, to]` and, when they have a value, whose window ends inside `to` are returned; the gate therefore covers every price shown.
The join (R-6) is by `candidateId` and `panelRecordHash` only; a hash that differs, a record whose content no longer matches its own `recordHash`, or a candidate not in the supplied records gives `UNKNOWN / PANEL_RECORD_MISMATCH` with `mismatchDetail` and no return key.

## Report checks (ES-1..ES-4, R-8, R-9, R-10)

`report.js`: `describeSample` counts rows, dates, events (a run of the same `signalEpoch` feature, else of the same `finalOutcome`, on consecutive evaluation points of a book; an absent evaluation point ends the run), industries (`NOT_APPLICABLE` for crypto, `UNKNOWN / INDUSTRY_NOT_IN_PANEL` when the panel has no `industry` feature) and window overlap (sessions need a caller supplied `sessionGap`, otherwise `UNKNOWN / SESSION_CALENDAR_NOT_PROVIDED`); the effective sample size is `N/A`. `checkReportTemplate` fails a report that writes a sample size or N without `聚类方法：` containing `DATE`, and a report that turns insufficient power into 不做. `truncationSummary` / `renderReport` write `截断 N 个，无标签`. `questionTables` gives one table each for signal increment, filter quality, account constraint and human delay: counts and means of matured labels, unknown rows counted apart, no conclusion key. The human delay axis is `NOT_PROVIDED / HUMAN_ACTION_TIME_NOT_IN_PANEL_OR_LABEL`: neither the panel nor the label carries a human action time.

## Tests

One file at a time (not the full suite): `node --test tests/panel_labels_label.test.js` and the other three. Per the ops-coord rule they run on the Linux research box through `~/bin-v6q0/linux-test`, never on the Mac.

## Not done in this slice

- R-10 second half (a real matured window, a real reading) and S-1 (panel complete) wait for part 1 deployments, real prices and one matured window.
- No real price provider (above). Part 1 files are read as parsed records handed to `readLabels`; reading `reports/candidate-panel/...jsonl.gz` is the caller's job.
- A distinct evaluator principal would need a change of `config/independent_verifier.v1.json` and its pinned sha256 in `authority.js` (a protected decision table); this slice reuses `holdout-scorer`.
