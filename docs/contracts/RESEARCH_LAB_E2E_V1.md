# RESEARCH_LAB_E2E_V1: AI Quant Research Lab end to end (W24)

Authority: `PLAN_V1_1_AMENDMENT_1_AI_RESEARCH_LAB.md` section 3 (frozen, sha256 `0e2f3181…`, DECISION_ID PLAN-V1-20261123-01); parent plan V1.1 W04 (lineage check). Code: `services/research-lab-e2e/`, `services/independent-verifier/{access-log,launcher}.js`, `tools/research-lab-compute-estimate.js`. `production_effect: NONE`. No clock (as_of is in the job), no randomness, no network; existing services are called, none is re-implemented.

## Chain (fixed order; each step links one primary artifact `steps/NN_NAME/...` to the previous by sha256)

1 CARD (AQ agent result `RQ_AGENT_RESULT_V1`, re-validated with `validateCard`) - 2 IDEA (`FACTOR_IDEA_V1`, `validateIdeaRecord`, route must be the generator path) - 3 MECHANISM (register triage; `NOT_DO_SETTLED` and the other refused routes stop) - 4 DSL (the AI's batch parsed by the MINING_SPACE_V1 DSL) - 5 K2_DRAFT - 6 K2_FREEZE (`k2-freeze-program` prepare, TRL receipt by the Mac registrar, finalize; then the frozen PROMOTION_TERMS_V1 and the K2's `ROBUSTNESS_DECLARATION_SHA256` line) - 7 EXPERIMENT (RF1116 round on dev + validation, read back through the runner files and the trial ledger) - 8 VERIFY (V-1..V-6) - 9 VERDICT (promotion engine S0, S1, S2) - 10 SEAL (`FAILURE_LIBRARY`, `FORWARD_SHADOW`, `PAUSE`; `AWAIT_HOLDOUT` before the holdout) - 11 FEEDBACK (one fact appended to the next `REVIEW_AI_FACT_PACK_V1`; generator-facing: pass/fail/pending and reason codes only).

`run(job, services)` returns `status` `COMPLETE` | `REFUSED` (reason `LAB_<STEP>_<CODE>`, run stops) | `WAITING_EXTERNAL` (`waiting`: `TRL_RECEIPT`, `PROMOTION_TERMS`, `HOLDOUT_SCORING`, `VERIFIER_EVIDENCE`, `NEXT_FACT_PACK`, ...; not a failure).

## Seams (host side, `services`)

- `k2.ctx(phase)`, `k2.register(prepared)`: K2 freeze context and the Mac registrar receipt.
- PROMOTION_TERMS_V1 (Q3b, QRP #148): written by the K2 freeze program in the same event as the K2 and named on the freeze page (`promotion_terms.file`, sha256); the lab reads it back, re-checks the sha and the K2 binding and validates it with the engine's own validator. The registered star values for AI-authored terms arrive as `ctx.promotionTermsStar` (`config/promotion_terms_star.v1.json`, Q3b follow-up) in `services.k2.ctx`. Frozen terms never name stage evidence shas: each stage's `PROMOTION_STAGE_EVIDENCE_V1` goes to the engine separately, chained by `prior_output_sha256` (S0 -> S1 -> S2). A freeze without a terms file is `WAITING_EXTERNAL:PROMOTION_TERMS`.
- `experiment.execute({formulas, as_of})`: the lane runs the round-runner CLI; tests run the runner in process.
- `evidence.verifier(view)`: the verifier inputs that have no producer in QRP yet (causality evidence, DSR/PBO/BHY provenance, cost runs and fills, robustness results, S2 evidence body). Absent: `WAITING_EXTERNAL:VERIFIER_EVIDENCE`. The lab fixes candidate, K2 and access log itself; the provider cannot override them.
- `nextPack()`: the base next-week fact pack the feedback fact is appended to.

## Holdout timing (RF1116)

Before `2027-01-01T00:00:00+08:00` the expected terminal state is `FROZEN_AWAITING_HOLDOUT` (steps 8 and 10 `PENDING_HOLDOUT`, step 9 holds the S0/S1 verdict). A candidate not selected by the validation rule ends `NOT_SELECTED_BY_VALIDATION` (seal `FAILURE_LIBRARY`, basis: the runner rule). From 2027-01-01 the run waits for the exempt scorer's G-MINE records, then runs the verifier and the engine.

## Access log and read lock (W20)

`access-log.js` writes the hash-chained rows V-2 parses. Launchers: the AQ agent CLI (`review-agent`) and the round-runner `generate` command (`mining-generator`) call `launcher.lockGenerator` (write only the output dir, read nothing under the holdout dirs; a refused read is logged as a refused generator `HOLDOUT_READ`, which V-2 flags). `generate`/`select` log the panel range actually read. The round runner's scoring is exempt: before the vault open it takes `authority.grantHoldoutRead` per selected candidate and logs one `HOLDOUT_READ` (candidate id = `candidateSha256Of({roundId, candidateId, formula})`); a read before 2027-01-01 or a second read is refused. A same-open rescore (R1.8) logs a `READ`, not a second `HOLDOUT_READ`.

## Acceptance checker (`check`), PASS/FAIL per condition

C1 complete lineage (11 links re-hashed, priors, report equals chain; awaiting holdout past 2027-01-01 fails) - C2 every attempt (generation log, lineage, trial ledger) - C3 no generator holdout access (V-2 on the mining log; the review agent's log may name only `REVIEW_FACT_PACK_V1`) - C4 verdict rebuilt twice from stored inputs, equal to each other and to the stored bytes - C5 feedback fact in the next pack (`next_pack` from the producer, else the lab's own output, reported as `next_pack_source`).

## Files

`LAB_E2E_JOB_V1`, `LAB_CHAIN_V1` (chain.json), `LAB_LINEAGE_V1` (lineage.json: chain, attempts, access-log summaries, verdict bytes, candidate, terminal), `LAB_ACCEPTANCE_V1`, `LAB_VERDICT_V1`, `LAB_FEEDBACK_V1`, `LAB_K2_BINDING_V1`, `LAB_EXPERIMENT_V1`, `LAB_SEAL_V1`, `LAB_COMPUTE_ESTIMATE_V1`.
