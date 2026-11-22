'use strict';

/** PROMOTION_TERMS_V1: what a K2 freezes for the promotion engine (market, layer, minimum economic value, sample size, thresholds, the section 4.2 policy, the review endpoint, the stage evidence files). */
const { isObj, isText, SHA64, isCstStamp, num, isInt } = require('./common');
const { validatePolicy, validateEndpoint, isLegacyK2 } = require('./insufficient');

const MARKETS = Object.freeze(['CN_A', 'US_EQUITY', 'CRYPTO']);
const LAYERS = Object.freeze(['ALPHA', 'RISK', 'EXECUTION']);
const METRIC_OF = Object.freeze({ ALPHA: 'DELTA_G_PER_YEAR', EXECUTION: 'DELTA_G_PER_YEAR', RISK: 'CVAR5_IMPROVEMENT' });
/** V1.1 5.2 B fallback metrics for the RISK layer until CVaR5 is defined (plan-coord 11-23): the D8 non-inferiority gate (d38f87a9) or the X06 touch-probability difference. Min 0 = not worse than control. CVAR5_IMPROVEMENT stays reserved (the K2 freeze program's star values refuse it). */
const RISK_FALLBACK_METRICS = Object.freeze(['NON_INFERIORITY_D8', 'TOUCH_PROBABILITY_DIFF_X06']);
const metricsOf = (layer) => (layer === 'RISK' ? [METRIC_OF.RISK, ...RISK_FALLBACK_METRICS] : [METRIC_OF[layer]]);
const KEYS = Object.freeze(['schema', 'candidate_id', 'market', 'layer', 'k2_sha256', 'k2_frozen_at', 'terms_frozen_at', 'next_review_endpoint', 'legacy', 'frozen_by', 'source_k2_refs', 'mechanism_ids', 'min_sample_n', 'min_economic_value', 'thresholds', 'insufficient_policy', 'review_endpoint', 'stage_evidence']);
const REQUIRED = Object.freeze(['schema', 'candidate_id', 'market', 'layer', 'k2_frozen_at', 'mechanism_ids', 'min_sample_n', 'min_economic_value', 'thresholds']);
const S3_KEYS = Object.freeze(['cost_multiple', 'max_growth_sacrifice']);

/** @returns {string[]} reason codes (empty = valid) */
const REF_FIELDS = Object.freeze(['min_economic_value', 'min_sample_n', 'review_endpoint']);

/**
 * @param {object} t
 * @param {{asOf?: string}} [opts] asOf: the evaluation time, for the legacy rule (a)
 */
function validate(t, { asOf = null } = {}) {
  if (!isObj(t)) return ['PROMOTION_TERMS_TYPE:terms'];
  const c = [];
  for (const k of Object.keys(t)) if (!KEYS.includes(k)) c.push(`PROMOTION_TERMS_EXTRA_KEY:${k}`);
  for (const k of REQUIRED) if (!(k in t)) c.push(`PROMOTION_TERMS_MISSING:${k}`);
  // plan-coord ruling 11-23 (1): the terms are frozen in the same event as their K2, bound by sha; never frozen after it
  const shaOk = typeof t.k2_sha256 === 'string' && SHA64.test(t.k2_sha256) && isCstStamp(t.terms_frozen_at) && isCstStamp(t.k2_frozen_at);
  if (t.legacy === true) {
    // plan-coord exception 11-23: a legacy K2 (frozen before the cut-off) may have terms frozen later, by plan-coord, copied verbatim from the K2 with a source ref each
    if (!shaOk) c.push('PROMOTION_TERMS_NOT_BOUND');
    else if (!isLegacyK2(t.k2_frozen_at)) c.push('PROMOTION_TERMS_LEGACY_NOT_ELIGIBLE');
    else {
      if (t.frozen_by !== 'plan-coord') c.push('PROMOTION_LEGACY_TERMS_FROZEN_BY');
      if (isCstStamp(asOf) && Date.parse(t.terms_frozen_at) > Date.parse(asOf)) c.push('PROMOTION_LEGACY_TERMS_AFTER_AS_OF');
      const refs = isObj(t.source_k2_refs) ? t.source_k2_refs : {};
      for (const k of REF_FIELDS) {
        const r = refs[k];
        if (!isObj(r) || r.k2_sha256 !== t.k2_sha256 || !isText(r.section)) c.push(`PROMOTION_LEGACY_TERMS_UNSOURCED:${k}`);
      }
      if (!('review_endpoint' in t)) c.push('PROMOTION_LEGACY_TERMS_UNSOURCED:review_endpoint');
    }
  } else if (!shaOk || Date.parse(t.terms_frozen_at) > Date.parse(t.k2_frozen_at)) c.push('PROMOTION_TERMS_NOT_BOUND');
  if ('legacy' in t && typeof t.legacy !== 'boolean') c.push('PROMOTION_TERMS_TYPE:legacy');
  if ('schema' in t && t.schema !== 'PROMOTION_TERMS_V1') c.push('PROMOTION_TERMS_ENUM:schema');
  if ('candidate_id' in t && !isText(t.candidate_id)) c.push('PROMOTION_TERMS_TYPE:candidate_id');
  if ('market' in t && !MARKETS.includes(t.market)) c.push('PROMOTION_TERMS_ENUM:market');
  if ('layer' in t && !LAYERS.includes(t.layer)) c.push('PROMOTION_TERMS_ENUM:layer');
  if ('k2_frozen_at' in t && !isCstStamp(t.k2_frozen_at)) c.push('PROMOTION_TERMS_TYPE:k2_frozen_at');
  if ('mechanism_ids' in t && !(Array.isArray(t.mechanism_ids) && t.mechanism_ids.length && t.mechanism_ids.every(isText))) c.push('PROMOTION_TERMS_TYPE:mechanism_ids');
  if ('min_sample_n' in t && !(isInt(t.min_sample_n) && t.min_sample_n > 0)) c.push('PROMOTION_TERMS_TYPE:min_sample_n');
  if ('min_economic_value' in t) {
    const m = t.min_economic_value;
    if (!isObj(m) || !num(m.value) || !(m.value >= 0)) c.push('PROMOTION_TERMS_TYPE:min_economic_value');
    else if (LAYERS.includes(t.layer) && !metricsOf(t.layer).includes(m.metric)) c.push('PROMOTION_TERMS_ENUM:min_economic_value.metric');
    else if (RISK_FALLBACK_METRICS.includes(m.metric) && m.value !== 0) c.push('PROMOTION_TERMS_FALLBACK_MIN_NOT_ZERO');
  }
  if ('thresholds' in t) {
    const th = t.thresholds;
    if (!isObj(th)) c.push('PROMOTION_TERMS_TYPE:thresholds');
    else {
      for (const k of Object.keys(th)) if (!['s3', 's4'].includes(k)) c.push(`PROMOTION_TERMS_EXTRA_KEY:thresholds.${k}`);
      if (isObj(th.s3)) {
        for (const k of Object.keys(th.s3)) if (!S3_KEYS.includes(k)) c.push(`PROMOTION_TERMS_EXTRA_KEY:thresholds.s3.${k}`);
        for (const k of S3_KEYS) if (k in th.s3 && !(num(th.s3[k]) && th.s3[k] > 0)) c.push(`PROMOTION_TERMS_TYPE:thresholds.s3.${k}`);
      } else if ('s3' in th) c.push('PROMOTION_TERMS_TYPE:thresholds.s3');
      if (isObj(th.s4)) {
        for (const k of Object.keys(th.s4)) if (k !== 'max_overlap') c.push(`PROMOTION_TERMS_EXTRA_KEY:thresholds.s4.${k}`);
        if ('max_overlap' in th.s4 && !(num(th.s4.max_overlap) && th.s4.max_overlap >= 0 && th.s4.max_overlap <= 1)) c.push('PROMOTION_TERMS_TYPE:thresholds.s4.max_overlap');
      } else if ('s4' in th) c.push('PROMOTION_TERMS_TYPE:thresholds.s4');
    }
  }
  if ('insufficient_policy' in t) c.push(...validatePolicy(t.insufficient_policy));
  if ('review_endpoint' in t && validateEndpoint(t.review_endpoint)) c.push('PROMOTION_TERMS_TYPE:review_endpoint');
  if ('next_review_endpoint' in t && validateEndpoint(t.next_review_endpoint)) c.push('PROMOTION_TERMS_TYPE:next_review_endpoint');
  if ('stage_evidence' in t) {
    if (!isObj(t.stage_evidence)) c.push('PROMOTION_TERMS_TYPE:stage_evidence');
    else for (const [s, ref] of Object.entries(t.stage_evidence)) if (!/^S[0-6]$/.test(s) || !isObj(ref) || !isText(ref.path) || !(typeof ref.sha256 === 'string' && SHA64.test(ref.sha256))) c.push(`PROMOTION_TERMS_TYPE:stage_evidence.${s}`);
  }
  return c;
}

module.exports = { MARKETS, LAYERS, METRIC_OF, RISK_FALLBACK_METRICS, metricsOf, validate };
