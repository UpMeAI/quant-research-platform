# INDEPENDENT_VERIFIER_V1 — W20 independent verifier (V-1 to V-6), authority enforcement, host evidence

Source: `PLAN_V1_1_AMENDMENT_1_AI_RESEARCH_LAB.md` section 2 (frozen, sha256 `0e2f3181…45de43`), parent plan V1.1 W20 row, section 2.5 and section 5.3.
RF1116 (holdout sealed until 2026-12-31, read once) and RF1118 (programs freeze, the AI only drafts) are unchanged; this contract only reads them.

Code: `services/independent-verifier/` (`index.js` orchestrator, `stages.js`, `authority.js`, `process-lock.js`), `config/independent_verifier.v1.json`,
`tools/independent-verifier-host-evidence.js`. `production_effect: NONE`. It writes no ledger except the holdout-read grants (`verifier_holdout_reads.jsonl`).

## Order (fixed; the first failing stage stops the run and names itself in the reason code `V<n>_<CODE>`)

| stage | check | reused, not re-implemented |
|---|---|---|
| V1 | time causality + research/live parity | `services/causality-gate` (G-CAUSAL), `services/parity-gate` |
| V2 | sample isolation: generator reads never past the validation segment end; holdout read at most once per frozen candidate and not before 2026-12-31; a claimed UNSEEN window holds no SEEN day | `services/mining-sandbox/segments`, `services/trial-ledger` `segmentsFor` (W05 labels), holdout-read grants in `authority.js` |
| V3 | multiple testing: DSR, PBO, BHY with the trial-family N; near-duplicate resubmission after a holdout failure | `trial-ledger/overfit` `DSR_MIN`/`PBO_MAX`/`bhy` (G-MINE reads the same constants; the G-MINE service itself is not required, see `tests/mining_gate.test.js` guard), `factor-library` `DEDUPE.RHO_MAX` |
| V4 | cost and trading constraints | `services/cost-gate` (`assessCostModel` floors, `coverage.requireComplete` from #143), `mining-sandbox/price-limits`, participation cap |
| V5 | robustness exactly as the frozen K2 declares (cost x2, parameter perturbation, sub-period) | the K2 carries `ROBUSTNESS_DECLARATION_SHA256: <sha256 of canonicalJson(declaration)>` |
| V6 | portfolio increment (S4) | promotion engine S4 (W16, parallel PR); file contract below until it lands |

V6 runs only when the input says `reachedS3: true`; otherwise it is recorded `NOT_RUN` and the generator verdict is decided by V1 to V5.
Every stage fails closed: an exception inside a stage is `V<n>_STAGE_ERROR`, never a pass.

## Input `INDEPENDENT_VERIFIER_INPUT_V1` (JSON; referenced files are `{path, sha256}` and re-hashed before use)

`candidateId`, `candidateSha256` (the frozen candidate), `market`, `familyId`, `asOf` (date, input not clock), `reachedS3`, `mechanism {id, dedupeDecision}`,
`v1 {entry, files {k2, causalityEvidence?, runLog?, ruling?, k2Notes?}}`, `v2 {accessLog, unseenClaim?, segmentMarks?}`,
`v3 {familyTrialCount, overfit {dsr, n_trials, pbo, pbo_scope, bhy {pValues, index}}, provenance {dsr, pbo, bhy: {trialRecordId, run: {path, sha256}}}, priorHoldoutFailures [{candidateId, mechanismId, familyId, nTrialsAtFailure, rho?}]}`,
`v4 {market, runs [{cost_model_ref, cost_book, cost_flags, cost_breakdown}], fills [{date, code, st, side, open, prevClose, participation}]}`,
`v5 {declaration {tests [{id, kind, metric, op, threshold, multiplier?}]}, results [{id, value}]}`, `v6 {s4Contract}`.

Access log: JSONL, one row per read `{seq, principal, op: READ|HOLDOUT_READ, dataset, from, to, candidateSha256?, prev, hash}`;
`hash = sha256(canonicalJson(row without hash))`, `prev` = previous `hash` (first row all zeros), `seq` from 1. A log belongs to one candidate lineage.

V6 file contract (until W16 lands; same shape the engine will return): `{candidateId, s4Evidence: {verdict: PASS|FAIL|INSUFFICIENT|INVALID, reasonCodes, sha256}}`.
**TODO(W16 seam):** when the promotion engine merges, pass `ctx.promotionEngine.s4({candidateId})` (already honoured in `stages.js` `v6`) and drop the file.

Statistic provenance (plan-coord ruling 11-23, item 4): V-3 takes DSR, PBO and BHY from upstream without recomputing them, but each must carry the trial-ledger record id (`TRL-<16 hex>`)
and the file of the run that computed it (re-hashed; the file holds `{trialRecordId, statistic: dsr|pbo|bhy, value}`, `value` for bhy is the candidate's raw p-value). Missing, malformed, sha-mismatched or
value-mismatched provenance gives `V3_UNSOURCED_STATISTIC` and nothing else from V-3.

## Outputs

- Generator-facing, exact key set `candidateId`, `verdict` (`pass`|`fail`), `reasonCodes` (strings `V[1-6]_[A-Z0-9_]+`). No metric of any kind, no detail text.
- Internal report `INDEPENDENT_VERIFIER_REPORT_V1` (`bundleSha256`, per-stage status, codes and readings) for plan-coord and the ledger only.
- Same input gives byte-identical bytes (canonical JSON, no clock, no randomness).

## Authority (amendment 2.2 and 2.3)

Generator identities: `mining-generator`, `review-agent`. Unknown principals are refused.

| forbidden action | code |
|---|---|
| write verifier code or config, decision tables, holdout dirs | `VERIFIER_WRITE_REFUSED` |
| change a frozen decision table or threshold | `FROZEN_TABLE_CHANGE_REFUSED` |
| ask for holdout metrics, metrics past the validation segment, or verdict detail | `HOLDOUT_METRICS_REFUSED` |
| generator reads the holdout data dir (authorisation layer) | `HOLDOUT_DIR_READ_REFUSED` |
| generator process reads the holdout data dir (process lock, `process-lock.js`) | `VERIFIER_HOLDOUT_READ_REFUSED` |
| second holdout read for the same frozen candidate | `HOLDOUT_SECOND_READ_REFUSED` |
| config bytes differ from the pin in `authority.js` | `VERIFIER_CONFIG_PIN_MISMATCH` (verifier refuses to run) |

A resubmission after a holdout failure (same mechanism id, or factor correlation above `factor-library` `DEDUPE.RHO_MAX`) must keep the original family id,
carry a mechanism dedupe decision, and a cumulative trial count above the count at the failure: `V3_RESUBMISSION_FAMILY_SPLIT`, `V3_RESUBMISSION_NOT_DEDUPED`, `V3_RESUBMISSION_N_NOT_CUMULATIVE`.

## Who takes the process lock (plan-coord ruling 11-23, item 3; wired in W24)

- Locked (`process-lock.js`): the generator launchers, i.e. the LLM mining generator (LLM_GEN) and the AQ review/prereg agent runs.
- Exempt: the round runner's scoring, the trusted evaluator. It must still write one access-log entry (`op: HOLDOUT_READ`, with `candidateSha256`) for each holdout read, and take the grant via
  `authority.grantHoldoutRead`; both feed the once-per-candidate check in V-2.
- Emitters (W24 wiring, plan-coord ruling item 2): the K2 templates get the `ROBUSTNESS_DECLARATION_SHA256` line through the Q3b follow-up; the generator launchers write the access log.

## Host evidence (run by ops-coord at install, not by this PR)

`node tools/independent-verifier-host-evidence.js --generator-uid U --generator-gids G[,G] --protected PATH... --holdout-dir DIR... [--generator-pid P] [--sandbox-pid S]`
prints `INDEPENDENT_VERIFIER_HOST_EVIDENCE_V1` (file permissions, Linux mountinfo, sandbox network interfaces). UNKNOWN is never PASS; exit code 1 on any FAIL.
The model-gateway egress allowlist is deliberately UNKNOWN (not checked) until ops-coord supplies the nft ruleset format at install.
Holdout dirs are host-specific and come from arguments or `QRP_HOLDOUT_DATA_DIRS`; no host or secret is stored in the repository.

## Defaults (marked in the config)

`bhyAlpha` 0.05 and `participationCap` 0.10 are the RACE_V2 guardrail defaults, accepted as star defaults by plan-coord (ruling 11-23, item 1); they are frozen in the W24 freeze record before the first formal run. No code change.
