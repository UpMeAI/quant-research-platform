# AI review V1 — implementation checkpoint, not release acceptance

Scope: QRP standalone review only. No API/UI import, admission import, trading
rule, production installation, other repository, or real model call is changed.

## Implemented core

- `services/ai-review/index.js`: disabled by default, lazy mode-600 owner-owned
  non-symlink key file; fixed HTTPS endpoint/model; bounded one retry; per-period
  claim and same-input cache; serialized append-only reservations and API usage;
  missing limits block with `BLOCKED:BUDGET` before credential access or fetch.
- Deterministic checker requires known references and exact normalized numbers
  from those references, excludes provenance IDs as numeric evidence, applies a
  versioned forbidden-word union and question-only research-direction shape.
  Failed checks are quarantined and omitted from readable Markdown.
- `input.js`: explicit local source hash and observation-date binding. It is an
  input primitive, **not** the completed producer-specific acceptance adapter.
- Existing canonical serialization and ledger append are reused. No model SDK.

The word list includes desk `ops/qc/a96-industry-rules.cjs` TIMING_WORDS and
the retired KG `insight.market_impact` directional vocabulary. A keyword checker
does not prove semantic absence of all possible predictions. Further adversarial
fixtures and output-structure restrictions remain required before release.

## Deterministic evidence

Initial test execution failed with `MODULE_NOT_FOUND` at test import. Seven
core tests then passed. Two additional tests first failed `true !== false`
(provenance IDs authorizing numbers, IEEE-754 integer rounding), then passed
after provenance exclusion and decimal-string normalization. Current targeted
suite: nine passed, zero failed. Only synthetic fetch/key fixtures are used.

Real local inbox dry-run, read-only: 2026-11-09 through 2026-11-12 A-share paper
trade-ledger artifacts were individually hashed and supplied to a fixed fake
response. Four checker passes. Private input packs and Markdown remain only
under ignored `var/ai-review/<date>/`; these contain private desk facts and must
not enter this public repository. This narrow smoke test does **not** satisfy
the all-ledger, decomposition and reconciliation acceptance.

## Remaining work (release validity false)

Daily adapter checkpoint: `desk-input.js` now binds delivered trades, NAV and
per-book loss attribution to both byte/payload hashes, schema, producer, session,
ledger and part. It requires a trusted producer validator; malformed/missing or
stale books cannot suppress other books. Seven adapter tests plus core/report
tests pass 18/18 after two red transitions (missing module and null request).
Synthetic fixtures use an injected validator and do not claim full producer
schema acceptance. Real Desk validation rejected three incomplete synthetic
documents as expected. Full real-input acceptance remains pending. Carry is not
registered in this NAV contract. READY applies only to the explicit
DESK_DAILY_THREE_SOURCE_SLICE coverage, not complete daily review coverage.

Ledger delivery slice: `runner.js` now accepts the adapter's daily packs and
persists `DAILY.report.json/.md` under `<period>/ledger-<sha256(identity)>/`.
The registered-book check reuses the adapter registry; identity never becomes a
path segment. Model attempt/cache artifacts use the same per-book namespace;
root-level locking and usage reservations remain shared. Deterministic snapshots
are separate from model cache, so missing budgets, keys and inputs can recover
without consuming the period claim. Disabled legacy `run()` remains unchanged;
only the explicit runner delivers disabled reports. Facts retain null/missing
values, source states and slice coverage; weekly comparison is null with availability NOT_IMPLEMENTED.

Daily inbox continuation: `daily-inbox.js` reuses the registered books and reads
only exact delivered paths for an explicit date. Real local validation of
11-09..11-12 yielded 6 READY US three-source slices and 22 INPUT_MISSING packs;
6 fixed fake responses passed checking and 28 report pairs are private/ignored.
Complete daily readiness is false on all four days: local CN V2/CRYPTO/rule
artifacts are absent; US NAV/V2 are absent on 11-12; carry NAV is unregistered.
Related checks: 31/31. Final serial heavy-run: 605 total, 579 pass, zero fail,
26 existing skips. The cumulative rule-change schema does not bind daily time coverage, so an
empty/missing snapshot cannot prove no change. See AI_REVIEW_DAILY_INBOX_EVIDENCE.md.

Daily command continuation: `apps/research-cli/ai_review_daily.js` composes the
existing inbox/runner and persists a coverage manifest. Default date is CST;
default model is off and budget unconfigured. Complete daily coverage is required
before model calls, even if a three-source pack is READY. The daily 22:40 CST
launchd example under `ops/ai-review/` remains disabled/uninstalled, with no
credentials/budget. Weekly CLI/scheduling and #58 alerts remain unimplemented.
Related checks: 36/36; plist syntax OK. Full regression did not start because
heavy-run load gate remained closed; own queue request was cancelled. Full
regression remains pending. See `ops/ai-review/PRECHECK.md` for the exact rerun
command, verification and remaining gates.

Next exact action: bind actual complete daily producer artifacts and required
rule/change streams under versioned acceptance before weekly reconciliation.
Do not invoke a real model, access credentials, install schedules or treat this
three-source slice as completed all-ledger/reconciliation acceptance. Related+vocabulary checks: 28/28 pass; final heavy-run full regression:
602 total, 576 pass, 0 fail, 26 external-input skips. Interrupted
core locks and multi-file crash consistency remain unverified release work.

Follow-up: Markdown now includes the supplied deterministic facts with their
provenance and all accepted research-direction fields. Only ACCEPTED notes with
a passing checker render model text. Report tests first failed at missing module,
then the core plus report suite passed 11/11. The new explicit runner supplies deterministic delivery for early exits;
complete input adapters remain pending.

1. Accept delivered inputs through their authoritative producer contracts;
   build per-ledger daily/weekly packs for every requested ledger, including
   attribution, decomposition, rule changes, NAV and fills. Do not let a missing
   ledger suppress valid ledgers. Existing routing validates queue/week hashes;
   existing forward registration alone is not a delivered forward stream.
2. Bind sealed-verdict trial evidence and implement deterministic comparison
   projection. Model must not classify or calculate the reconciliation result.
3. Daily runner now delivers deterministic blocked/off reports. Still pending:
   computed differences, safe handling of partial writes and interrupted locks,
   and complete canonical source acceptance.
4. Reuse mechanism lookup when available; otherwise preserve DEDUPE_PENDING.
   Wire alert event to #58 without notification enabled by default.
5. Daily CLI and disabled/uninstalled CST template now exist. Weekly CLI and
   scheduling artifacts remain pending. Complete
   all-ledger real-input dry-run and regression evidence; no installation here.
6. Owner budget approval and deployed 3-trading-day + 1-week observation remain
   external pending gates. No ready PR / PR_OPEN / LIVE claim is appropriate.

## Budget proposal (not configuration)

The four sampled single-ledger input packs each measure 984 UTF-8 bytes before
system prompt. They are not representative of seven-ledger weekly payloads.
Provisional review caps: 12,000 total tokens per call, 120,000 daily, 1,500,000
monthly, **pending complete pack measurements and Owner selection**. No price
or cost claim is made without verified provider pricing. Production has no
default limits: all three must be explicitly supplied, otherwise zero requests.
Reservations intentionally charge the per-call upper bound even on transport
failure; actual tokens are separately preserved from provider responses.

## Compact continuation

Base: a076ca9a3c7e1ec25d62acd996bb5b47cf79541c. Branch:
`codex/q70-ai-review`. Next: producer acceptance adapters and deterministic
comparison projection; retain frozen task acceptance. Do not repeat a real API
call, inspect real credentials, commit private facts, install jobs, or deploy.
