'use strict';
/** Synthetic fixtures for the promotion engine tests (AMENDMENT_1 section 1). No ledger, no clock. Must be required after ./_env. */
const crypto = require('crypto');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const K2_SHA = 'a'.repeat(64);
const AS_OF = '2026-12-01T10:00:00+08:00';
const NEW_K2_FROZEN_AT = '2026-11-24T10:00:00+08:00'; // after the 2026-11-23T01:13+08:00 cut-off
const LEGACY_K2_FROZEN_AT = '2026-11-20T10:00:00+08:00'; // before it

const POLICY = Object.freeze({ horizon_months: 12, p_threshold: 0.5, budget_share_max: 0.2, resume_sample_fraction: 0.5, max_failed_rechecks: 3 });

function terms(over = {}) {
  const base = {
    schema: 'PROMOTION_TERMS_V1', candidate_id: 'CAND-W16-001', market: 'CN_A', layer: 'ALPHA', k2_sha256: K2_SHA, k2_frozen_at: NEW_K2_FROZEN_AT,
    mechanism_ids: ['ACCT.CONCURRENCY.NON_MAJOR_CAP'], min_sample_n: 200,
    min_economic_value: { metric: 'DELTA_G_PER_YEAR', value: 0.02 },
    thresholds: { s3: { cost_multiple: 2, max_growth_sacrifice: 0.01 }, s4: { max_overlap: 0.6 } },
    insufficient_policy: { ...POLICY },
    review_endpoint: { kind: 'DATE', value: '2027-03-01' },
    stage_evidence: {},
  };
  return { ...base, ...over };
}

const ci = (lower, upper) => ({ lower, upper, level: 0.95 });
const VALIDATORS_OK = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`V${i + 1}`, 'PASS']));

/** inputs for the section 4.2 resolution; default resolves to the continue path (做). */
function insuff(over = {}) {
  return {
    effect_ci: ci(-0.005, 0.04), observed_sample_n: 120, events_per_month: 20,
    cost_to_continue: { model_cost_cny: 100, core_hours: 5 }, market_monthly_budget: { model_cost_cny: 1000, core_hours: 100 },
    mechanism_prior_class: 'NORMAL_NO_PRIOR', ...over,
  };
}

/** evidence body per stage and verdict. */
const BODY = {
  S0: {
    PASS: { state: 'REGISTERED', fact_refs: ['FACT-1'], mechanism_ids: ['ACCT.CONCURRENCY.NON_MAJOR_CAP'] },
    FAIL: { state: 'DUPLICATE', fact_refs: ['FACT-1'], mechanism_ids: ['ACCT.CONCURRENCY.NON_MAJOR_CAP'] },
    INSUFFICIENT: { state: 'PENDING', fact_refs: ['FACT-1'], mechanism_ids: ['ACCT.CONCURRENCY.NON_MAJOR_CAP'] },
    INVALID_INPUT: { state: 'REGISTERED', fact_refs: [], mechanism_ids: ['ACCT.CONCURRENCY.NON_MAJOR_CAP'] },
  },
  S1: {
    PASS: { validators: { ...VALIDATORS_OK } },
    FAIL: { validators: { ...VALIDATORS_OK, V7: 'FAIL' } },
    INSUFFICIENT: { validators: { ...VALIDATORS_OK, V9: 'NOT_RUN' } },
    INVALID_INPUT: { validators: { V1: 'PASS' } },
  },
  S2: {
    PASS: { metric_kind: 'RANK_IC_INCREMENT', estimate: 0.02, ci: ci(0.005, 0.035), n: 300, dsr: 0.97, decay_ok: true },
    FAIL: { metric_kind: 'RANK_IC_INCREMENT', estimate: -0.02, ci: ci(-0.035, -0.005), n: 300, dsr: 0.2, decay_ok: true },
    INSUFFICIENT: { metric_kind: 'RANK_IC_INCREMENT', estimate: 0.01, ci: ci(-0.01, 0.03), n: 120, dsr: 0.9, decay_ok: true },
    INVALID_INPUT: { metric_kind: 'HIT_RATE', estimate: 0.01, ci: ci(0, 0.02), n: 300, dsr: 0.97, decay_ok: true },
  },
  S3: {
    PASS: { n: 300, delta_g: { estimate: 0.03, ci: ci(0.004, 0.056) }, cost_x2: { multiple: 2, delta_g_ci_lower: 0.001 }, cost_model_ref: 'REPLAY_CORE_PROFILE_COSTS', constraints_ok: true },
    FAIL: { n: 300, delta_g: { estimate: -0.01, ci: ci(-0.03, -0.002) }, cost_x2: { multiple: 2, delta_g_ci_lower: -0.04 }, cost_model_ref: 'REPLAY_CORE_PROFILE_COSTS', constraints_ok: true },
    INSUFFICIENT: { n: 120, delta_g: { estimate: 0.02, ci: ci(-0.01, 0.05) }, cost_x2: { multiple: 2, delta_g_ci_lower: -0.02 }, cost_model_ref: 'REPLAY_CORE_PROFILE_COSTS', constraints_ok: true },
    INVALID_INPUT: { n: 300, delta_g: { estimate: 0.03, ci: ci(0.004, 0.056) }, cost_x2: { multiple: 2, delta_g_ci_lower: 0.001 }, cost_model_ref: 'REPLAY_CORE_COSTS_NONE', constraints_ok: true },
  },
  S4: {
    PASS: { n: 300, marginal_net_contribution: { estimate: 0.02, ci: ci(0.003, 0.037) }, tail_ok: true, stress_ok: true, overlap: { holdings: 0.3, risk: 0.4 }, race: { partition: 'SELECTION_TIMING' } },
    FAIL: { n: 300, marginal_net_contribution: { estimate: 0.02, ci: ci(0.003, 0.037) }, tail_ok: true, stress_ok: true, overlap: { holdings: 0.9, risk: 0.4 }, race: { partition: 'SELECTION_TIMING' } },
    INSUFFICIENT: { n: 100, marginal_net_contribution: { estimate: 0.01, ci: ci(-0.02, 0.04) }, tail_ok: true, stress_ok: true, overlap: { holdings: 0.3, risk: 0.4 }, race: { partition: 'SELECTION_TIMING' } },
    INVALID_INPUT: { n: 300, marginal_net_contribution: { estimate: 0.02, ci: ci(0.003, 0.037) }, tail_ok: true, stress_ok: true, overlap: { holdings: 0.3, risk: 0.4 }, race: { partition: 'RISK' } }, // ALPHA candidate in the RISK partition
  },
  S5: {
    PASS: { paper_validation_state: 'CLAIM_ELIGIBLE', holdout: { origin: 'HUMAN', read_count: 1, read_at: '2026-11-30T10:00:00+08:00' } },
    FAIL: { paper_validation_state: 'STOPPED_NEGATIVE', holdout: { origin: 'HUMAN', read_count: 1, read_at: '2026-11-30T10:00:00+08:00' } },
    INSUFFICIENT: { paper_validation_state: 'RUNNING_DESCRIBE_ONLY', holdout: { origin: 'HUMAN', read_count: 0, read_at: null } },
    INVALID_INPUT: { paper_validation_state: 'CLAIM_ELIGIBLE', holdout: { origin: 'MINED', read_count: 2, read_at: '2027-01-05T10:00:00+08:00' } },
  },
  S6: {
    PASS: { auto_gates: { cost: true, causality: true, overfit: true }, signature_class: 'NONE', signature_ref: null },
    FAIL: { auto_gates: { cost: true, causality: true, overfit: false }, signature_class: 'NONE', signature_ref: null },
    INSUFFICIENT: { auto_gates: { cost: true, causality: true, overfit: true }, signature_class: 'NEEDS_SIGNATURE', signature_ref: null },
    INVALID_INPUT: { auto_gates: { cost: true }, signature_class: 'MAYBE', signature_ref: null },
  },
};
const STAGES = Object.keys(BODY);
const VERDICTS = ['PASS', 'FAIL', 'INSUFFICIENT', 'INVALID_INPUT'];

/** a previous-stage PASS history up to (not including) `stage`; output sha chains are deterministic strings. */
function historyBefore(stage) {
  const idx = STAGES.indexOf(stage);
  return STAGES.slice(0, idx).map((s) => ({ stage: s, verdict: 'PASS', output_sha256: sha(`prev-${s}`) }));
}

function evidence(stage, verdict, { terms: t = terms(), insufficient = null, over = {} } = {}) {
  const idx = STAGES.indexOf(stage);
  const e = {
    schema: 'PROMOTION_STAGE_EVIDENCE_V1', candidate_id: t.candidate_id, stage, k2_sha256: t.k2_sha256,
    prior_output_sha256: idx === 0 ? null : sha(`prev-${STAGES[idx - 1]}`),
    validator: { first_failed: null }, body: JSON.parse(JSON.stringify(BODY[stage][verdict])), ...over,
  };
  if (stage === 'S4' && verdict === 'INVALID_INPUT') e.prior_output_sha256 = sha('prev-S3');
  if (insufficient) e.insufficient_inputs = insufficient;
  return e;
}

/** a full request for `evaluate`. */
function request(stage, verdict, { terms: t = terms(), insufficient = verdict === 'INSUFFICIENT' ? insuff() : null, over = {}, evOver = {}, history } = {}) {
  return { candidate_id: t.candidate_id, requested_stage: stage, terms: t, terms_sha256: sha(JSON.stringify(t)), evidence: evidence(stage, verdict, { terms: t, insufficient, over: evOver }),
    evidence_sha256: sha(`${stage}-${verdict}`), history: history || historyBefore(stage), as_of: AS_OF, ...over };
}

module.exports = { sha, K2_SHA, AS_OF, NEW_K2_FROZEN_AT, LEGACY_K2_FROZEN_AT, POLICY, terms, ci, insuff, BODY, STAGES, VERDICTS, historyBefore, evidence, request };
