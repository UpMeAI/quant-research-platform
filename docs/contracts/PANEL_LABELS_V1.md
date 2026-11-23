# PANEL_LABELS_V1 — W18 part 2: research side label join for the all candidate panel

Source (authoritative, frozen): `W18_ALL_CANDIDATE_PANEL_CONTRACT_V1_FREEZE_1.md` (plan-coord, 2026-11-23T11:30:51+08:00, sha256 `cc8e3724bf3d142313f9a4e0abd048b445a43d837cf2f848100d3a7e66e20826`), sections 7, 8.2 and 10 conditions 2, 3, 4, 6, as read and narrowed by its `..._FREEZE_1_NOTE_1.md` (plan-coord 12:50:39, sha256 `8592acdf553c369a7363378d9f95093409bde0481656a6c1bebe5d0b7f4a52c4`).
This page records how QRP implements them; it changes no acceptance. Part 1 (the `CANDIDATE_PANEL_V1` producers in Ashare-V6, smartflow, portfolio-desk) is not in this repository.
Code: `services/panel-labels/`. Tests: `tests/panel_labels_{label,isolation,stage_gate,join_report,store}.test.js` with `tests/_panel_labels_fixture.js` and the W07 digest vectors `tests/fixtures/w18-panel-labels/id-digest-vectors.w07-a7efd031.json` (a copy of Ashare-V6 `test/fixtures/pick-plan-supplement-1/id-digest-vectors.json` at a7efd031). No model, no prediction, no order, no network, no database.

## Recorded gaps of this version (NOTE_1 item 6, not omissions)

- **No label writing job and no real price provider exist.** There is no real price source bound and no scheduled job; real labels will not exist before 11-25. This version ships the computation against an injected provider, the validated and hash chained write side (`store.append`), and the controlled read. The label directory has no writer process yet: what the OS level user and file permissions for that job must be is host evidence, not code acceptance.
- **R-2 narrowing:** a holder of a `FORWARD_RESERVED` range is refused too (`FORWARD_READ_TIME_NOT_IN_LEDGER`); "the holder after the declared read time passes, and the range turns `FORWARD_READ`" is **not implemented** in this version, because the ledger holds no declared read time and a requester's own claim could be forged. Stage `FORWARD` is closed. It opens when the reservation record carries a declared read time (from a sha bound freeze page).
- **R-10 second half** (a real matured window, a real reading) and S-1 (panel complete) wait for part 1 deployments, real prices and one matured window.
- The human delay question has no data source: its table carries `NOT_PROVIDED / HUMAN_ACTION_TIME_NOT_IN_PANEL_OR_LABEL`.

## What a label is

A result fact computed by a deterministic program from prices (LB-1): what a panel candidate's price did over a declared window after the evaluation. Append only. A label is never written into a panel file, a decision record or the desk (LB-2); the panel files are read only here (a test observes every write call while the label job and the read run).

| field | note |
|---|---|
| `candidateId`, `panelRecordHash` | the only join keys to part 1 (as the pair) |
| `windowId`, `windowUnit`, `windowLength` | `W5S` = 5 sessions, `W24H` = 24 hours; allowed values are the W-7 table below; a window of the wrong unit for the market is refused |
| `entryBasis` | CN `NEXT_SESSION_OPEN` (B13 method `RAW_OPEN_AND_CLOSE_TIMES_HISTORICAL_ADJ_FACTOR_V1`, required of the CN provider); US and crypto `FIRST_COMPLETE_BAR_OPEN_AFTER_EVALUATION` |
| `entryAt`, `exitAt` | instants the prices were taken (entry never before `evaluatedAt`); `null` unless the label has a value |
| `grossReturn`, `benchmarkReturn`, `excessReturn` | present only when `state = VALUE` (a return key on any other state is refused); `grossReturn` is exit close over entry open minus 1, no cost (W-8). A missing benchmark keeps `grossReturn` and writes `{state: UNKNOWN, reasonCode}` for the other two; it may be filled by a later row |
| `maturesAt` | window end plus the provider's availability lag, computed from the calendar before any price exists |
| `maturedAt` | the latest `availableAt` of the entry, exit and benchmark prices, never earlier than `maturesAt`; `null` unless `VALUE` (= B13 `label_available_at`) |
| `state`, `reasonCode` | `VALUE` / `UNKNOWN` / `NOT_APPLICABLE`; reasons `LABEL_NOT_MATURED`, `PRICE_UNAVAILABLE`, `INSTRUMENT_DELISTED_IN_WINDOW`, `PANEL_RECORD_MISMATCH`, `BENCHMARK_PRICE_UNAVAILABLE`, `EXCESS_BENCHMARK_UNAVAILABLE` |
| `priceSourceRef`, `computedAt`, `labelHash` | provider id and version, price method, priced instrument (the row's `carrierId` when it has one), benchmark id, per price source refs. `labelHash` excludes `computedAt`, so a recomputation has the same hash |
| `researchOnly: true` | required. No model, probability, capital, order, broker, position or production effect key is accepted (`LABEL_FORBIDDEN_FIELD`) |

Rules: before `maturesAt` (a label matures exactly at `maturesAt`) the label is `UNKNOWN / LABEL_NOT_MATURED` with no return key, never 0, and the provider is not asked for a price (LB-6). A matured label is a new row; the old row is untouched; a matured value, entry and exit instants and numeric benchmark and excess are never rewritten or turned back into a gap (`LABEL_MATURED_VALUE_CHANGED`, `LABEL_APPEND_REGRESSION`). A row without `windowId`, `maturesAt`, or (when `VALUE`) `maturedAt` is refused `LABEL_WINDOW_OR_MATURITY_MISSING` (LB-7). Clock coherence is checked at append: `maturedAt >= maturesAt`, `computedAt >= maturedAt` (`LABEL_MATURITY_INCOHERENT`). A truncated panel candidate has no row, so no label; the label job lists the count (LB-8).

W-7 allowed windows (values to choose from, not a default; every K2 declares its own, and `materialize` refuses a call that declares none, `LABEL_WINDOWS_NOT_DECLARED`): CN and US `SESSION` 1, 5, 10, 20; crypto `HOUR` 4, 24, 72. Benchmarks: CN `CSI300`; US `SPY` (`QQQ` only when the caller asks); crypto `BTC`.

## The label table (write side)

`store.js`: one file `labels.jsonl`, created 0600 in a directory created 0700. Every line is `{seq, prev, label, hash}` with `hash = sha256(canonicalJson({seq, prev, label}))`, `prev` the previous hash (64 zeros first): the access log's chain. A store that finds the chain broken refuses to append, and the controlled read refuses (`LABEL_STORE_CHAIN_BROKEN`) before anything is recorded or returned. The store object has `dir`, `file` and `append` only: **no read path is exported**; the table is read only by `readLabels`, after the authority call. The label job `materialize` refuses a panel record whose content does not match its own `recordHash` (`LABEL_PANEL_RECORD_HASH_INVALID`).

## Price provider (injected)

`computeLabel` takes a provider; there is no network or file access in the label code. Interface (see `label.js`): `providerId`, `providerVersion`, `priceMethod(market)`, `entryAt`, `exitAt`, `availabilityLagMs` (calendar only), `price({market, instrumentKey, at, field: OPEN|CLOSE, asOf})` returning `{state: VALUE, value, availableAt, sourceRef}` or `{state: UNAVAILABLE, reasonCode}`. A price that is available after `asOf` must come back unavailable; a provider that returns one anyway is refused (`LABEL_PROVIDER_FUTURE_PRICE`).
Shipped: `fixture-provider.js` (explicit tables, for tests). **No real provider is shipped.** A real one needs: the market calendar and session open and close instants (CN, US with DST and half days; crypto bars), the availability lag per market, point in time prices with their `availableAt`, CN open and close adjusted by the B13 method, delisting dates, and the benchmark series (CSI 300, SPY, QQQ, BTC). QRP has no US or crypto price store; the CN export reader `services/mining-sandbox/data-adapter` (raw price times the same day adjustment factor) is a segment bound panel builder, not a price series API.

## Isolation (R-1, LB-3, condition 3)

No new permission system. The label directory is registered as a controlled data directory of the existing W20 authority layer (`services/independent-verifier/authority.js`) through the **host list** `QRP_HOLDOUT_DATA_DIRS`, the same list the generator process lock reads. The caller's context cannot name protected directories or the config: `readLabels` passes the authority layer only `{holdoutDirs: <host list>, repoRoot}`, and a `holdoutDirs`, `config`, `repoRoot` or `ledgerFile` in the context is ignored. Then:

- `authority.authorize({action: READ_FILE})` refuses `mining-generator` and `review-agent` (`HOLDOUT_DIR_READ_REFUSED`) and any unregistered principal, a K2 drafter included (`VERIFIER_PRINCIPAL_UNKNOWN`); only the evaluator principal (the config's `holdoutScorerPrincipal`, `holdout-scorer`) is allowed. `WRITE_FILE` on the directory is refused for every runtime principal.
- a generator launcher process takes the existing process lock (`launcher.lockGenerator`): the file read and the write are refused at the fs layer, the evaluator role used inside such a process too, and the refusal is logged.
- `readLabels` calls that layer; it does not decide who may read. It refuses a directory that is not on the host list (`LABEL_STORE_NOT_PROTECTED`, whatever the context says), because the authority layer allows reads of directories it does not control.
- every read appends a read record (LB-5) to the read ledger (0600) and an `op: READ, dataset: PANEL_LABELS_V1` row to the W24 hash chained access log; every refusal appends `op: HOLDOUT_READ_REFUSED` with the code (the access log has no other refusal op).

OS level isolation (users, mounts) is host evidence (`tools/independent-verifier-host-evidence.js`) and is not verified here.

## Controlled read and stage gate (R-2, R-3, LB-4, LB-5)

`readLabels(request, ctx)`: request `{principal, k2Ref {id, sha256}, stage, market, families, from, to, windows, panelRecords, forward?}`; ctx `{store, accessLogFile, readLedgerFile, registeredBy, k2Bytes, now?}`. A `readAt` in the request is **ignored**: the read time is `ctx.now()` (default the ledger clock) and the SEEN mark's `registered_at` is the same value. Stage is the K2's declared stage: `SEEN`, `UNSEEN_FIRST_READ`, `FORWARD` (closed in this version). The gate, in this order, for every stage:

1. **K2 binding:** `ctx.k2Bytes(k2Ref)` must hash to `k2Ref.sha256`, and the trial ledger must hold a `REGISTRATION` row with that K2 sha256 for EACH declared family; else `LABEL_READ_K2_NOT_BOUND`.
2. **FORWARD_RESERVED (NOTE_1 items 3, 4):** labels are per market, marks per family. Every family the ledger holds marks for in this market (names `CN_A`/`CN`, `US_EQUITY`/`US`, `CRYPTO`/`CRYPTO_USDM_PERP`) and every declared family is examined with `trials.segmentsFor`: a reserved day in `[from, to]` (not closed by a later `FORWARD_READ` of the same shadow) refuses the whole read with `LABEL_READ_FORWARD_NOT_PERMITTED` unless the requester is that family's holder (stage `FORWARD`, `forward.shadowRef`); a holder is refused with `FORWARD_READ_TIME_NOT_IN_LEDGER`; a stage `FORWARD` request is refused that way even when nothing is reserved. No `FORWARD_READ` mark is ever written by this version.
3. **UNSEEN:** only stage `UNSEEN_FIRST_READ`, and only for the bound K2 whose section 0 says `冻结者 COORDINATOR` (a program frozen K2, `K2_FREEZE_PROGRAM_V1`, and any other or missing freezer are refused); else `LABEL_READ_UNSEEN_NOT_PERMITTED`. The freezer line is read the way `program_freeze_gate.js` reads it; a parity test holds the two together.
4. **SEEN:** readable.

A passed read appends the read record `{readerRole, k2Ref, stage, families, from, to, windows, readAt, rowsReturned, sha256, ...}` (`sha256` = hash of the record; extra keys `rowsSha256`, `readKey`), then one `DATA_SEGMENT_MARK_V1` per family through the existing `trials.markSegments`: `SEEN` over `[from, to]` with `source_refs[0] = {kind: PANEL_LABEL_READ, read_record_sha256, read_key}`, market taken from the family's registration row. Replaying the same read (same `readKey`) appends a read record but no second mark. If a mark cannot be written, no row is returned and an abort row is appended.
**Range:** a label is returned only when its evaluation date is in `[from, to]`, its record is of the requested market, and its window has ended inside the range: `exitAt`, else `maturesAt`, on or before `to` (market local date), **for every state** (VALUE, NOT_APPLICABLE, PRICE_UNAVAILABLE, not matured).
**Join (R-6):** by the pair `(candidateId, recordHash)` only. `recordHash` is the sha256 of the record without its `recordHash` field, serialised by the one canonical JSON function of the W07 digest vectors (keys in code point order, UTF-8, no whitespace; reproduced by `trial-ledger` `canonicalJson` against all three vectors in the tests). A pair that is absent, a record whose content no longer matches its own hash, or a candidate in no supplied record gives `UNKNOWN / PANEL_RECORD_MISMATCH` with `mismatchDetail` (`RECORD_HASH_DIFFERS`, `RECORD_CONTENT_HASH_INVALID`, `CANDIDATE_ID_NOT_IN_PANEL`) and no return key. A producer envelope field added outside the hash gives `RECORD_HASH_EXCLUDES_FIELD` and names the field in `mismatchField`.
Known divergence risk: Python's `repr` of a float with an exponent (`1e-07`) differs from JavaScript (`1e-7`); the W07 vectors contain none, and the cross-producer vectors in the producers' PRs are what proves a producer's hash.

## Report checks (ES-1..ES-4, R-8, R-9, R-10)

`report.js`: `describeSample` counts rows, dates, events (a run of the same `signalEpoch` feature, else of the same `finalOutcome`, on consecutive evaluation points of a book; an absent evaluation point ends the run), industries (`NOT_APPLICABLE` for crypto, `UNKNOWN / INDUSTRY_NOT_IN_PANEL` when the panel has no `industry` feature) and window overlap (sessions need a caller supplied `sessionGap`, otherwise `UNKNOWN / SESSION_CALENDAR_NOT_PROVIDED`); the effective sample size is `N/A`.
`checkReportTemplate(text, {books})` (ES-1, ES-2, ES-3): a sample size in any wording (样本量, 样本数, 有效样本, 有效N, `sample size`, `n=12`, `N 12`) must be on one structured line `有效样本量：<N/A|number>；聚类方法：<METHODS>` that states the number and its method together, else `SAMPLE_SIZE_WITHOUT_CLUSTER_METHOD`; the method must include `DATE` (`CLUSTER_METHOD_MISSING_DATE`) and, for a scan book (C17, US_V5, QUICK_SHOT, from the `账本：` line or `options.books`), `EVENT` (`CLUSTER_METHOD_MISSING_EVENT`); a report that turns insufficient power into 不做 fails.
`truncationSummary` / `renderReport` write `截断 N 个，无标签` and name inconsistent truncation objects. `questionTables` gives one table each for signal increment, filter quality, account constraint and human delay: counts and means of matured labels, unknown rows counted apart, no conclusion key.

## Tests

One file at a time (not the full suite). Per the ops-coord rule they run on the Linux research box through `~/bin-v6q0/linux-test` (outside its protected measurement windows), never on the Mac: `node --test tests/panel_labels_label.test.js` and the other four. Report flows in the tests read the table through `readLabels`; `fixture.rowsOf` is a test side look at the file, as a host operator would have.
