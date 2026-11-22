'use strict';

/**
 * Stage evaluators S0-S6 (PLAN_V1_1_AMENDMENT_1 section 1.1). Each is a pure function of (evidence body, K2 terms) and returns
 * { verdict, codes } or { invalid: codes }. The verdict is the engine's, computed from the numbers: an evidence file never states its own verdict.
 * FAIL needs sufficient evidence that is negative; anything short of PASS without that is INSUFFICIENT (not a rejection).
 * The thresholds come from the K2 terms (frozen before the result was seen); the only constants here are existing frozen gates reused from
 * ../trial-ledger/overfit (DSR_MIN), ../shadow-control/paper-validation (STATES), ../race-orchestrator/v2 (PARTITIONS) and ../cost-gate (G-COST).
 */
const { isObj, isText, isCstStamp, num, isInt, SHA64 } = require('./common');
const overfit = require('../trial-ledger/overfit');
const paperValidation = require('../shadow-control/paper-validation');
const raceV2 = require('../race-orchestrator/v2');
const costGate = require('../cost-gate');
const { FIXED_RATES } = require('../k2-freeze-program/power');
const k2Validators = require('../k2-freeze-program/validators');

/** A mining candidate's holdout is read once, no earlier than this instant (RF1116: after 12-31; AMENDMENT_1 section 1.1 S5). */
const MINED_HOLDOUT_NOT_BEFORE = '2027-01-01T00:00:00+08:00';
/** K2_DRAFT_V1 scope.live_class values (schema.js keeps them module-private). */
const LIVE_CLASSES = Object.freeze(['NONE', 'NEEDS_SIGNATURE']);
const S6_REQUIRED_GATES = Object.freeze(['cost', 'causality', 'overfit']);
const SIGNAL_METRICS = Object.freeze(['RANK_IC_INCREMENT', 'GROUP_NET_RETURN', 'CONDITIONAL_NET_RETURN']);

const ciOk = (ci) => isObj(ci) && num(ci.lower) && num(ci.upper) && ci.lower <= ci.upper && ci.level === FIXED_RATES.ci_level;
const sampleOk = (n) => isInt(n) && n >= 0;
const pass = (...codes) => ({ verdict: 'PASS', codes });
const fail = (...codes) => ({ verdict: 'FAIL', codes });
const insufficient = (...codes) => ({ verdict: 'INSUFFICIENT', codes });
const invalid = (...codes) => ({ invalid: codes });

function s0(b) {
  if (!isObj(b) || !['REGISTERED', 'PENDING', 'DUPLICATE', 'PREDICTION_CLAIM'].includes(b.state)) return invalid('PROMOTION_S0_STATE_INVALID');
  if (!Array.isArray(b.fact_refs) || !b.fact_refs.length || !b.fact_refs.every(isText)) return invalid('PROMOTION_S0_FACT_REFS_MISSING');
  if (!Array.isArray(b.mechanism_ids) || !b.mechanism_ids.length || !b.mechanism_ids.every(isText)) return invalid('PROMOTION_S0_MECHANISM_IDS_MISSING');
  if (b.state === 'REGISTERED') return pass('S0_MECHANISM_REGISTERED_AND_UNIQUE');
  if (b.state === 'PENDING') return insufficient('S0_MECHANISM_REGISTRATION_PENDING');
  if (b.state === 'DUPLICATE') return fail('S0_G_MECH_DUPLICATE_MECHANISM');
  return fail('S0_PREDICTION_CLAIM_NOT_ALLOWED');
}

function s1(b) {
  const v = isObj(b) ? b.validators : null;
  if (!isObj(v) || k2Validators.ORDER.some((id) => !['PASS', 'FAIL', 'NOT_RUN'].includes(v[id])) || Object.keys(v).length !== k2Validators.ORDER.length) return invalid('PROMOTION_S1_VALIDATORS_INCOMPLETE');
  const failed = k2Validators.ORDER.filter((id) => v[id] === 'FAIL');
  if (failed.length) return fail(...failed.map((id) => `S1_VALIDATOR_FAILED:${id}`));
  const notRun = k2Validators.ORDER.filter((id) => v[id] === 'NOT_RUN');
  if (notRun.length) return insufficient(...notRun.map((id) => `S1_VALIDATOR_NOT_RUN:${id}`));
  return pass('S1_ALL_VALIDATORS_PASS');
}

function s2(b, t) {
  if (!isObj(b) || !SIGNAL_METRICS.includes(b.metric_kind) || !ciOk(b.ci) || !num(b.estimate) || !sampleOk(b.n) || !(b.dsr === null || num(b.dsr)) || typeof b.decay_ok !== 'boolean') return invalid('PROMOTION_S2_EVIDENCE_INVALID');
  const enough = b.n >= t.min_sample_n;
  if (enough && b.ci.upper < 0) return fail('S2_CI_UPPER_BELOW_ZERO');
  const why = [];
  if (!enough) why.push('S2_SAMPLE_BELOW_MIN');
  if (!(b.ci.lower > 0)) why.push('S2_CI_CROSSES_ZERO');
  if (b.dsr === null) why.push('S2_DSR_UNKNOWN'); else if (b.dsr < overfit.DSR_MIN) why.push('S2_DSR_BELOW_MIN');
  if (!b.decay_ok) why.push('S2_DECAY_NOT_OK');
  return why.length ? insufficient(...why) : pass('S2_CI_LOWER_ABOVE_ZERO', 'S2_DSR_AT_OR_ABOVE_MIN');
}

function s3(b, t) {
  const risk = t.layer === 'RISK';
  const primary = isObj(b) ? (risk ? b.cvar5_improvement : b.delta_g) : null;
  const th = isObj(t.thresholds.s3) ? t.thresholds.s3 : {};
  if (!isObj(b) || !sampleOk(b.n) || !isObj(primary) || !num(primary.estimate) || !ciOk(primary.ci) || !isObj(b.cost_x2) || !num(b.cost_x2.multiple) || !num(b.cost_x2.delta_g_ci_lower) || typeof b.constraints_ok !== 'boolean' || !isText(b.cost_model_ref)) return invalid('PROMOTION_S3_EVIDENCE_INVALID');
  if (!num(th.cost_multiple)) return invalid('PROMOTION_TERMS_MISSING:thresholds.s3.cost_multiple');
  if (b.cost_x2.multiple !== th.cost_multiple) return invalid('PROMOTION_S3_COST_MULTIPLE_MISMATCH');
  let sacrifice = null;
  if (risk) {
    sacrifice = b.growth_sacrifice;
    if (!isObj(sacrifice) || !num(sacrifice.estimate) || !ciOk(sacrifice.ci)) return invalid('PROMOTION_S3_EVIDENCE_INVALID');
    if (!num(th.max_growth_sacrifice)) return invalid('PROMOTION_TERMS_MISSING:thresholds.s3.max_growth_sacrifice');
  }
  try { costGate.assessCostModel({ cost_model_ref: b.cost_model_ref, cost_breakdown: b.cost_breakdown }, t.market === 'US_EQUITY' ? 'US' : t.market); } catch (e) { return invalid(`PROMOTION_S3_COST_GATE:${String(e.message).slice(0, 120)}`); }
  const min = t.min_economic_value.value;
  const enough = b.n >= t.min_sample_n;
  if (enough) {
    if (primary.ci.upper < 0) return fail('S3_CI_UPPER_BELOW_ZERO');
    if (primary.ci.upper < min) return fail('S3_ECONOMIC_VALUE_BELOW_MIN_WITH_SUFFICIENT_SAMPLE');
    if (risk && sacrifice.estimate > th.max_growth_sacrifice) return fail('S3_GROWTH_SACRIFICE_ABOVE_MAX');
  }
  const why = [];
  if (!enough) why.push('S3_SAMPLE_BELOW_MIN');
  if (!(primary.estimate >= min)) why.push('S3_POINT_ESTIMATE_BELOW_MIN');
  if (!(primary.ci.lower > 0)) why.push('S3_CI_LOWER_NOT_ABOVE_ZERO');
  if (!(b.cost_x2.delta_g_ci_lower > 0)) why.push('S3_COST_X2_NOT_ROBUST');
  if (!b.constraints_ok) why.push('S3_RISK_CONSTRAINT_NOT_MET');
  return why.length ? insufficient(...why) : pass('S3_ECONOMIC_AND_STATISTICAL_THRESHOLDS_MET', 'S3_COST_X2_ROBUST');
}

function s4(b, t) {
  const th = isObj(t.thresholds.s4) ? t.thresholds.s4 : {};
  const m = isObj(b) ? b.marginal_net_contribution : null;
  if (!isObj(b) || !sampleOk(b.n) || !isObj(m) || !num(m.estimate) || !ciOk(m.ci) || typeof b.tail_ok !== 'boolean' || typeof b.stress_ok !== 'boolean'
    || !isObj(b.overlap) || !num(b.overlap.holdings) || !num(b.overlap.risk)) return invalid('PROMOTION_S4_EVIDENCE_INVALID');
  if (!num(th.max_overlap)) return invalid('PROMOTION_TERMS_MISSING:thresholds.s4.max_overlap');
  if ('race' in b) {
    const want = t.layer === 'RISK' ? 'RISK' : 'SELECTION_TIMING';
    if (!isObj(b.race) || !raceV2.PARTITIONS.includes(b.race.partition) || b.race.partition !== want) return invalid('PROMOTION_S4_RACE_PARTITION_MISMATCH');
  }
  if (Math.max(b.overlap.holdings, b.overlap.risk) > th.max_overlap) return fail('S4_OVERLAP_ABOVE_MAX');
  const enough = b.n >= t.min_sample_n;
  if (enough && m.ci.upper < 0) return fail('S4_MARGINAL_CI_UPPER_BELOW_ZERO');
  if (enough && !b.tail_ok) return fail('S4_TAIL_WORSE');
  const why = [];
  if (!enough) why.push('S4_SAMPLE_BELOW_MIN');
  if (!(m.ci.lower > 0)) why.push('S4_MARGINAL_CI_LOWER_NOT_ABOVE_ZERO');
  if (!b.tail_ok) why.push('S4_TAIL_NOT_CHECKED_OK');
  if (!b.stress_ok) why.push('S4_STRESS_NOT_OK');
  return why.length ? insufficient(...why) : pass('S4_MARGINAL_NET_CONTRIBUTION_POSITIVE', 'S4_OVERLAP_WITHIN_MAX');
}

function s5(b) {
  const h = isObj(b) ? b.holdout : null;
  if (!isObj(b) || !paperValidation.STATES.includes(b.paper_validation_state) || !isObj(h) || !['HUMAN', 'MINED'].includes(h.origin) || !isInt(h.read_count) || h.read_count < 0 || !(h.read_at === null || isCstStamp(h.read_at))) return invalid('PROMOTION_S5_EVIDENCE_INVALID');
  if (h.read_count > 1) return invalid('PROMOTION_S5_HOLDOUT_READ_AGAIN');
  if (h.read_count === 1 && h.read_at === null) return invalid('PROMOTION_S5_HOLDOUT_READ_AT_MISSING');
  if (h.origin === 'MINED' && h.read_count === 1 && Date.parse(h.read_at) < Date.parse(MINED_HOLDOUT_NOT_BEFORE)) return invalid('PROMOTION_S5_HOLDOUT_READ_BEFORE_1231');
  switch (b.paper_validation_state) {
    case 'CLAIM_ELIGIBLE': return pass('S5_PAPER_VALIDATION_CLAIM_ELIGIBLE');
    case 'STOPPED_NEGATIVE': return fail('S5_PAPER_VALIDATION_STOPPED_NEGATIVE');
    case 'PAUSED_RUN_FAULT': return invalid('PROMOTION_S5_RUN_FAULT');
    default: return insufficient(`S5_PAPER_VALIDATION_${b.paper_validation_state}`);
  }
}

function s6(b) {
  const g = isObj(b) ? b.auto_gates : null;
  if (!isObj(b) || !isObj(g) || S6_REQUIRED_GATES.some((k) => typeof g[k] !== 'boolean') || !LIVE_CLASSES.includes(b.signature_class) || !(b.signature_ref === null || isText(b.signature_ref))) return invalid('PROMOTION_S6_EVIDENCE_INVALID');
  const failed = Object.keys(g).sort().filter((k) => g[k] === false);
  if (failed.length) return fail(...failed.map((k) => `S6_AUTO_GATE_FAILED:${k}`));
  if (b.signature_class === 'NEEDS_SIGNATURE' && b.signature_ref === null) return { verdict: 'INSUFFICIENT', codes: ['S6_OWNER_SIGNATURE_PENDING'], external: 'AWAIT_OWNER_SIGNATURE' };
  return pass('S6_AUTO_GATES_PASS');
}

const EVALUATORS = Object.freeze({ S0: s0, S1: s1, S2: s2, S3: s3, S4: s4, S5: s5, S6: s6 });
module.exports = { EVALUATORS, MINED_HOLDOUT_NOT_BEFORE, S6_REQUIRED_GATES, SIGNAL_METRICS, SHA64 };
