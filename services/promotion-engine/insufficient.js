'use strict';

/**
 * INSUFFICIENT resolution (PLAN_V1_1_AMENDMENT_1 section 4.2) and the monthly recheck (4.3). Deterministic: a function of the K2 terms, the
 * evidence inputs and as_of. Every starred value (horizon, probability threshold, budget share, resume fraction, recheck count) is read from the
 * K2's insufficient_policy, never from a constant in this file. 暂停 is a third conclusion: it is never 不做 and never goes to the failure library.
 */
const { isObj, num, round6, isInt, isDate } = require('./common');

/** K2s frozen before this instant keep their own text until their review endpoint (AMENDMENT_1 section 4.3). */
const CUTOFF = '2026-11-23T01:13:00+08:00';
const isLegacyK2 = (frozenAt) => Date.parse(frozenAt) < Date.parse(CUTOFF);

/**
 * Pre-cutoff K2s at their review endpoint (plan-coord ruling 11-23 (2)): the AMENDMENT_1 section 4.2 starred defaults verbatim, frozen 11-23 for all of them
 * at once. No per-item tuning: a legacy K2's terms may not carry a different policy.
 */
const AMENDMENT_1_DEFAULT_POLICY = Object.freeze({
  source: 'PLAN_V1_1_AMENDMENT_1_AI_RESEARCH_LAB', amendment_sha256_prefix: '0e2f3181', decision_id: 'PLAN-V1-20261123-01',
  horizon_months: 12, p_threshold: 0.5, budget_share_max: 0.2, resume_sample_fraction: 0.5, max_failed_rechecks: 3,
});
const POLICY_VALUE_KEYS = Object.freeze(['horizon_months', 'p_threshold', 'budget_share_max', 'resume_sample_fraction', 'max_failed_rechecks']);
/** @returns {{policy: object|null, source: string, invalid?: string}} the policy that judges this K2. */
function effectivePolicy(terms) {
  if (!isLegacyK2(terms.k2_frozen_at)) return terms.insufficient_policy ? { policy: terms.insufficient_policy, source: 'K2_FROZEN_POLICY' } : { policy: null, source: 'K2_FROZEN_POLICY' };
  const own = terms.insufficient_policy;
  if (own && POLICY_VALUE_KEYS.some((k) => own[k] !== AMENDMENT_1_DEFAULT_POLICY[k])) return { policy: null, source: 'AMENDMENT_1_DEFAULT_POLICY', invalid: 'PROMOTION_LEGACY_POLICY_TUNING_NOT_ALLOWED' };
  return { policy: { ...AMENDMENT_1_DEFAULT_POLICY, next_review_endpoint: terms.next_review_endpoint || (own && own.next_review_endpoint) || undefined }, source: 'AMENDMENT_1_DEFAULT_POLICY' };
}

const POLICY_KEYS = Object.freeze(['horizon_months', 'p_threshold', 'budget_share_max', 'resume_sample_fraction', 'max_failed_rechecks', 'next_review_endpoint']);

/** @returns {string[]} PROMOTION_POLICY_INVALID codes */
function validatePolicy(p) {
  if (!isObj(p)) return ['PROMOTION_POLICY_INVALID:policy'];
  const codes = [];
  for (const k of Object.keys(p)) if (!POLICY_KEYS.includes(k)) codes.push(`PROMOTION_POLICY_INVALID:extra:${k}`);
  if (!(num(p.horizon_months) && p.horizon_months > 0)) codes.push('PROMOTION_POLICY_INVALID:horizon_months');
  for (const k of ['p_threshold', 'budget_share_max', 'resume_sample_fraction']) if (!(num(p[k]) && p[k] > 0 && p[k] <= 1)) codes.push(`PROMOTION_POLICY_INVALID:${k}`);
  if (!(isInt(p.max_failed_rechecks) && p.max_failed_rechecks >= 1)) codes.push('PROMOTION_POLICY_INVALID:max_failed_rechecks');
  if ('next_review_endpoint' in p && validateEndpoint(p.next_review_endpoint)) codes.push('PROMOTION_POLICY_INVALID:next_review_endpoint');
  return codes;
}

function validateEndpoint(e) {
  if (!isObj(e)) return 'type';
  if (e.kind === 'DATE') return isDate(e.value) ? null : 'value';
  if (e.kind === 'SAMPLE_N') return isInt(e.value) && e.value > 0 ? null : 'value';
  return 'kind';
}

/** DATE: as_of's CST date has reached the endpoint. SAMPLE_N: the observed sample has reached it. */
function endpointReached(endpoint, { asOf, observedN }) {
  if (!isObj(endpoint)) return false;
  if (endpoint.kind === 'DATE') return asOf.slice(0, 10) >= endpoint.value;
  return num(observedN) && observedN >= endpoint.value;
}

// ---- Poisson accrual: P(reach min_sample_n within the horizon at the observed event rate) ----
const logsumexp = (xs) => { const m = Math.max(...xs); return m + Math.log(xs.reduce((a, x) => a + Math.exp(x - m), 0)); };

/** P(X >= need) for X ~ Poisson(lambda), exact term-by-term in log space; rounded to 6 decimals so the result does not depend on the last ulp. */
function poissonUpperTail(lambda, need) {
  if (need <= 0) return 1;
  if (!(lambda > 0)) return 0;
  // log pmf(k) = k ln(lambda) - lambda - ln(k!)
  const lf = [0];
  const logPmf = (k) => { while (lf.length <= k) lf.push(lf[lf.length - 1] + Math.log(lf.length)); return k * Math.log(lambda) - lambda - lf[k]; };
  if (need <= lambda) { // lower sum is the short side
    const terms = []; for (let k = 0; k < need; k++) terms.push(logPmf(k));
    return round6(Math.max(0, 1 - Math.exp(logsumexp(terms))));
  }
  const terms = [];
  let peak = -Infinity;
  for (let k = need; ; k++) {
    const lp = logPmf(k);
    terms.push(lp); if (lp > peak) peak = lp;
    if (k > lambda && lp < peak - 60) break; // past the mode and 26 orders of magnitude down
    if (k > need + 5e6) break;
  }
  return round6(Math.min(1, Math.exp(logsumexp(terms))));
}

function pReach({ observedN, minN, ratePerMonth, horizonMonths }) {
  return poissonUpperTail(ratePerMonth * horizonMonths, minN - observedN);
}

/** Smallest event rate (per month) at which the probability reaches the threshold; bisection, deterministic. */
function rateTarget({ observedN, minN, horizonMonths, threshold, from }) {
  const at = (r) => pReach({ observedN, minN, ratePerMonth: r, horizonMonths });
  let lo = Math.max(0, from); let hi = Math.max(lo * 2, 1);
  for (let i = 0; i < 80 && at(hi) < threshold; i++) hi *= 2;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (at(mid) >= threshold) hi = mid; else lo = mid; }
  return round6(hi);
}

const costShare = (cost, budget) => {
  const parts = [];
  for (const k of ['model_cost_cny', 'core_hours']) if (num(budget[k]) && budget[k] > 0) parts.push(cost[k] / budget[k]);
  return parts.length ? Math.max(...parts) : Infinity;
};

/** @returns {string[]} codes for the section 4.2 inputs. */
function validateInputs(ins) {
  const codes = [];
  if (!isObj(ins)) return ['PROMOTION_INSUFFICIENT_INPUTS_MISSING'];
  const ci = ins.effect_ci;
  if (!isObj(ci) || !num(ci.lower) || !num(ci.upper) || ci.lower > ci.upper) codes.push('PROMOTION_INSUFFICIENT_INPUTS_INVALID:effect_ci');
  if (!(isInt(ins.observed_sample_n) && ins.observed_sample_n >= 0)) codes.push('PROMOTION_INSUFFICIENT_INPUTS_INVALID:observed_sample_n');
  if (!(num(ins.events_per_month) && ins.events_per_month >= 0)) codes.push('PROMOTION_INSUFFICIENT_INPUTS_INVALID:events_per_month');
  for (const k of ['cost_to_continue', 'market_monthly_budget']) {
    const c = ins[k];
    if (!isObj(c) || !num(c.model_cost_cny) || !num(c.core_hours) || c.model_cost_cny < 0 || c.core_hours < 0) codes.push(`PROMOTION_INSUFFICIENT_INPUTS_INVALID:${k}`);
  }
  if (typeof ins.mechanism_prior_class !== 'string') codes.push('PROMOTION_INSUFFICIENT_INPUTS_INVALID:mechanism_prior_class');
  return codes;
}

/**
 * @param {{terms: object, inputs: object, asOf: string}} a
 * @returns {{verdictCodes: string[], invalid?: string[], resolution: object|null, nextAction: string}}
 */
function resolve({ terms, inputs, asOf }) {
  const bad = validateInputs(inputs);
  if (bad.length) return { invalid: bad };
  const legacy = isLegacyK2(terms.k2_frozen_at);
  const eff = effectivePolicy(terms);
  const policy = eff.policy;
  const ep = terms.review_endpoint;
  const reached = endpointReached(ep, { asOf, observedN: inputs.observed_sample_n });
  const infoItem = (p) => ({ market: terms.market, mechanism_prior_class: inputs.mechanism_prior_class, effect_ci: inputs.effect_ci, min_economic_value: terms.min_economic_value.value, p_reach: p });

  if (legacy && !reached) {
    if (!ep) return { invalid: ['PROMOTION_REVIEW_ENDPOINT_MISSING'] };
    return {
      verdictCodes: ['PROMOTION_LEGACY_K2_OWN_TEXT'], nextAction: 'RUN_TO_REVIEW_ENDPOINT',
      resolution: { conclusion: '做', code: 'LEGACY_K2_CONTINUE_TO_ENDPOINT', review_endpoint: ep, action_at_endpoint: 'REJUDGE_UNDER_SECTION_4_2', rule: 'K2_OWN_TEXT_UNTIL_ENDPOINT' },
    };
  }
  if (eff.invalid) return { invalid: [eff.invalid] };
  if (!policy) return { invalid: ['PROMOTION_POLICY_MISSING'] };

  const minN = terms.min_sample_n;
  const p = pReach({ observedN: inputs.observed_sample_n, minN, ratePerMonth: inputs.events_per_month, horizonMonths: policy.horizon_months });
  const base = { rule: 'SECTION_4_2', policy_source: eff.source, legacy_judged_at_endpoint: legacy, p_reach: p, min_sample_n: minN, observed_sample_n: inputs.observed_sample_n };
  const pause = (code, resume, extra = {}) => ({
    verdictCodes: [code], nextAction: 'PAUSE_UNTIL_RESUME_CONDITION',
    resolution: { ...base, conclusion: '暂停', code, resume_condition: resume, recheck: { cadence: 'MONTHLY', max_failed_rechecks: policy.max_failed_rechecks, on_exhaustion: 'PAUSE_ESCALATE_TO_OWNER' }, ...extra },
  });

  // 1. value: the whole 95% interval is below the minimum economic value
  if (inputs.effect_ci.upper < terms.min_economic_value.value) {
    return pause('PAUSE_LOW_VALUE', { kind: 'NEW_MECHANISM_EVIDENCE_OR_DATA_BASIS_CHANGE' }, { ci_upper: inputs.effect_ci.upper, min_economic_value: terms.min_economic_value.value });
  }
  // 2. power: P(reach min_sample_n within the horizon) below the threshold
  if (p < policy.p_threshold) {
    return pause('PAUSE_LOW_POWER', {
      kind: 'SAMPLE_FRACTION_OR_RATE_RECOVERY', sample_fraction: policy.resume_sample_fraction, sample_n_target: Math.ceil(policy.resume_sample_fraction * minN),
      rate_target_per_month: rateTarget({ observedN: inputs.observed_sample_n, minN, horizonMonths: policy.horizon_months, threshold: policy.p_threshold, from: inputs.events_per_month }), p_threshold: policy.p_threshold,
    }, { horizon_months: policy.horizon_months });
  }
  // 3. budget: continuing costs more than the share of the market's monthly research budget
  const share = round6(costShare(inputs.cost_to_continue, inputs.market_monthly_budget));
  if (share > policy.budget_share_max) {
    return pause('PAUSE_BUDGET', { kind: 'NEXT_MONTHLY_BUDGET_QUEUE_BY_INFORMATION_VALUE', budget_share_max: policy.budget_share_max }, { budget_share: share });
  }
  // 4. continue: 做, with a review endpoint
  const next = reached ? (policy.next_review_endpoint || terms.next_review_endpoint) : ep;
  if (!next) return { invalid: ['PROMOTION_REVIEW_ENDPOINT_MISSING'] };
  return {
    verdictCodes: ['CONTINUE_FORWARD_SHADOW_OR_SAMPLE'], nextAction: 'RUN_TO_REVIEW_ENDPOINT',
    resolution: { ...base, conclusion: '做', code: 'CONTINUE_FORWARD_SHADOW_OR_SAMPLE', review_endpoint: next, action_at_endpoint: 'REJUDGE_UNDER_SECTION_4_2', budget_share: share, info_value_item: infoItem(p) },
  };
}

/**
 * Monthly recheck of a paused result (section 4.3). The caller keeps the history of earlier rechecks and hands it back. A paused item that
 * keeps failing is escalated, never converted: the result stays 暂停 and plan-coord puts the question to the Owner.
 */
function recheck({ paused, terms, observed, history, asOf }) {
  const res = isObj(paused) && isObj(paused.resolution) ? paused.resolution : null;
  const out = (state, extra) => ({ state, ...extra });
  if (!res || res.conclusion !== '暂停' || !String(res.code).startsWith('PAUSE_')) return out('INVALID_INPUT', { reasonCodes: ['PROMOTION_RECHECK_NOT_PAUSED'] });
  const eff = effectivePolicy(terms);
  if (eff.invalid) return out('INVALID_INPUT', { reasonCodes: [eff.invalid] });
  const policy = eff.policy;
  if (!policy) return out('INVALID_INPUT', { reasonCodes: ['PROMOTION_POLICY_MISSING'] });
  if (!Array.isArray(history) || history.some((h) => !isObj(h) || typeof h.as_of !== 'string' || !['STILL_PAUSED', 'PAUSE_ESCALATE_TO_OWNER', 'RESUME'].includes(h.state))) return out('INVALID_INPUT', { reasonCodes: ['PROMOTION_RECHECK_HISTORY_INVALID'] });
  const last = history.length ? history[history.length - 1] : null;
  if (last && last.as_of.slice(0, 7) === asOf.slice(0, 7)) return out('INVALID_INPUT', { reasonCodes: ['PROMOTION_RECHECK_ALREADY_DONE_THIS_MONTH'] });
  if (last && !(Date.parse(last.as_of) < Date.parse(asOf))) return out('INVALID_INPUT', { reasonCodes: ['PROMOTION_RECHECK_NOT_AFTER_LAST'] });
  const o = isObj(observed) ? observed : {};
  let satisfied = false;
  const why = [];
  if (res.code === 'PAUSE_LOW_VALUE') {
    satisfied = typeof o.new_mechanism_evidence_ref === 'string' || typeof o.data_basis_change_ref === 'string';
    why.push(satisfied ? 'RESUME_NEW_EVIDENCE_OR_DATA_BASIS' : 'NO_NEW_MECHANISM_EVIDENCE_OR_DATA_BASIS_CHANGE');
  } else if (res.code === 'PAUSE_LOW_POWER') {
    if (!(isInt(o.observed_sample_n) && o.observed_sample_n >= 0 && num(o.events_per_month) && o.events_per_month >= 0)) return out('INVALID_INPUT', { reasonCodes: ['PROMOTION_RECHECK_OBSERVED_INVALID'] });
    const pNow = pReach({ observedN: o.observed_sample_n, minN: terms.min_sample_n, ratePerMonth: o.events_per_month, horizonMonths: policy.horizon_months });
    const byN = o.observed_sample_n >= Math.ceil(policy.resume_sample_fraction * terms.min_sample_n);
    const byRate = pNow >= policy.p_threshold;
    satisfied = byN || byRate;
    why.push(byN ? 'RESUME_SAMPLE_FRACTION_REACHED' : byRate ? 'RESUME_RATE_RECOVERED' : 'SAMPLE_AND_RATE_STILL_SHORT');
  } else {
    const ok = isObj(o.cost_to_continue) && isObj(o.market_monthly_budget) && num(o.cost_to_continue.model_cost_cny) && num(o.cost_to_continue.core_hours) && num(o.market_monthly_budget.model_cost_cny) && num(o.market_monthly_budget.core_hours);
    if (!ok) return out('INVALID_INPUT', { reasonCodes: ['PROMOTION_RECHECK_OBSERVED_INVALID'] });
    satisfied = round6(costShare(o.cost_to_continue, o.market_monthly_budget)) <= policy.budget_share_max;
    why.push(satisfied ? 'RESUME_BUDGET_FITS' : 'BUDGET_STILL_TOO_LARGE');
  }
  if (satisfied) return out('RESUME', { conclusion: null, failed_rechecks: 0, escalate: false, nextAction: 'REJUDGE_UNDER_SECTION_4_2', reasonCodes: why });
  let streak = 0;
  for (let i = history.length - 1; i >= 0 && history[i].state !== 'RESUME'; i--) streak++;
  const failed = streak + 1;
  if (failed >= policy.max_failed_rechecks) {
    return out('PAUSE_ESCALATE_TO_OWNER', { conclusion: '暂停', failed_rechecks: failed, escalate: true, nextAction: 'PLAN_COORD_RECOMMENDS_TO_OWNER', reasonCodes: [...why, 'PAUSE_ESCALATE_TO_OWNER', 'NO_AUTOMATIC_CONVERSION'] });
  }
  return out('STILL_PAUSED', { conclusion: '暂停', failed_rechecks: failed, escalate: false, nextAction: 'RECHECK_NEXT_MONTH', reasonCodes: why });
}

module.exports = { AMENDMENT_1_DEFAULT_POLICY, effectivePolicy, CUTOFF, isLegacyK2, validatePolicy, validateEndpoint, endpointReached, pReach, poissonUpperTail, rateTarget, costShare, validateInputs, resolve, recheck };
