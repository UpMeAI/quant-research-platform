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

Next exact action: add a per-ledger report runner with namespace isolation and
persist deterministic reports for budget/input/unavailable states; prove no
ledger overwrites another and no blocked input causes a fetch. Then bind actual
complete daily producer artifacts before attempting weekly reconciliation.
Do not call all packs with the same run() root: its claim/cache key currently
contains only period and output. Do not invoke a real model, access credentials,
install schedules or treat these adapters as completed all-ledger acceptance.

Follow-up: Markdown now includes the supplied deterministic facts with their
provenance and all accepted research-direction fields. Only ACCEPTED notes with
a passing checker render model text. Report tests first failed at missing module,
then the core plus report suite passed 11/11. Early disabled/budget/input exits
still need a deterministic report delivery wrapper; this rendering change does
not claim that delivery or the complete input adapters are implemented.

1. Accept delivered inputs through their authoritative producer contracts;
   build per-ledger daily/weekly packs for every requested ledger, including
   attribution, decomposition, rule changes, NAV and fills. Do not let a missing
   ledger suppress valid ledgers. Existing routing validates queue/week hashes;
   existing forward registration alone is not a delivered forward stream.
2. Bind sealed-verdict trial evidence and implement deterministic comparison
   projection. Model must not classify or calculate the reconciliation result.
3. Persist deterministic reports for disabled/unavailable/budget/input states;
   complete Markdown rendering for directions and differences, safe handling of
   partial writes and interrupted locks. Enforce canonical source schemas.
4. Reuse mechanism lookup when available; otherwise preserve DEDUPE_PENDING.
   Wire alert event to #58 without notification enabled by default.
5. Provide CLI and uninstalled CST daily/weekly scheduling artifacts. Complete
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
