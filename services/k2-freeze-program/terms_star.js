'use strict';

/**
 * Q3c: the registered starred values of PROMOTION_TERMS_V1 (config/promotion_terms_star.v1.json), loaded and checked for the K2 freeze program.
 * Every value must carry a source reference into one of the two frozen plan texts (V1.1 af34af38, Amendment 1 0e2f3181) and equal the number written there under its
 * unit (pp and percent are divided by 100); a layer that is not usable (metric not yet defined, no number in the text) is left out, so an AI-authored draft in it is refused.
 * The result is ctx.promotionTermsStar = { insufficient_policy, by_layer: { LAYER: { min_economic_value, thresholds } } }. Pure apart from reading the one file.
 */
const fs = require('fs');
const path = require('path');
const { fail, isObj, SHA64, canonicalJson } = require('./common');
const { METRIC_OF, RISK_FALLBACK_METRICS } = require('../promotion-engine/terms');

const FILE = path.join(__dirname, '..', '..', 'config', 'promotion_terms_star.v1.json');
const SOURCE_SHA = Object.freeze({ V1_1: /^af34af38[0-9a-f]{56}$/, AMENDMENT_1: /^0e2f3181d98902f28b67c53ffd068a32e35e96bb75c1b32b62eb3ab9f45bde43$/ });
const UNITS = Object.freeze({ pp: (n) => n / 100, percent: (n) => n / 100, months: (n) => n, count: (n) => n, multiple: (n) => n, non_inferiority: () => 0 });

function checkValue(sources, key, value) {
  const s = isObj(sources) ? sources[key] : null;
  if (!isObj(s) || !['V1_1', 'AMENDMENT_1'].includes(s.doc) || typeof s.section !== 'string' || typeof s.quote !== 'string' || !s.quote) fail('TERMS_STAR_UNSOURCED', key);
  const wordsOk = s.unit === 'non_inferiority' ? s.quote.includes('不劣于对照') : s.quote.includes(String(s.quote_number));
  if (!UNITS[s.unit] || typeof s.quote_number !== 'number' || !wordsOk) fail('TERMS_STAR_UNSOURCED', `${key}:quote`);
  if (UNITS[s.unit](s.quote_number) !== value) fail('TERMS_STAR_VALUE_NOT_VERBATIM', `${key}:${value}`);
}

const leaves = (obj, prefix, out = []) => {
  for (const [k, v] of Object.entries(obj)) { if (isObj(v)) leaves(v, `${prefix}.${k}`, out); else out.push([`${prefix}.${k}`, v]); }
  return out;
};

/** @param {object} f the parsed file @returns {{insufficient_policy: object, by_layer: object}} */
function parse(f) {
  if (!isObj(f) || f.schema !== 'PROMOTION_TERMS_STAR_V1') fail('TERMS_STAR_SCHEMA');
  for (const [k, re] of Object.entries(SOURCE_SHA)) if (!isObj(f.sources) || !isObj(f.sources[k]) || !SHA64.test(f.sources[k].sha256 || '') || !re.test(f.sources[k].sha256)) fail('TERMS_STAR_SOURCE_SHA', k);
  const pol = f.insufficient_policy;
  if (!isObj(pol) || !isObj(pol.values)) fail('TERMS_STAR_SCHEMA', 'insufficient_policy');
  for (const [k, v] of Object.entries(pol.values)) checkValue(pol.sources, k, v);
  const byLayer = {};
  for (const [layer, l] of Object.entries(isObj(f.layers) ? f.layers : {})) {
    if (!METRIC_OF[layer]) fail('TERMS_STAR_SCHEMA', `layer ${layer}`);
    if (l.usable !== true) { if (typeof l.reason !== 'string' || !l.reason) fail('TERMS_STAR_SCHEMA', `${layer}.reason`); if (isObj(l.recorded)) { checkValue(l.sources, 'min_economic_value', l.recorded.min_economic_value.value); for (const [k, v] of leaves(l.recorded.thresholds, 'thresholds')) checkValue(l.sources, k, v); } continue; }
    const m = l.min_economic_value;
    const fallback = l.gate === 'NON_INFERIORITY_FALLBACK';
    const metricOk = fallback ? (isObj(m) && Array.isArray(m.metrics) && m.metrics.length > 0 && m.metrics.every((x) => RISK_FALLBACK_METRICS.includes(x)) && layer === 'RISK') : (isObj(m) && m.metric === METRIC_OF[layer]);
    if (!metricOk || typeof m.value !== 'number') fail('TERMS_STAR_SCHEMA', `${layer}.min_economic_value`);
    checkValue(l.sources, 'min_economic_value', m.value);
    if (!isObj(l.thresholds)) fail('TERMS_STAR_SCHEMA', `${layer}.thresholds`);
    for (const [k, v] of leaves(l.thresholds, 'thresholds')) checkValue(l.sources, k, v);
    if (l.gate !== undefined && l.gate !== 'NON_INFERIORITY_FALLBACK') fail('TERMS_STAR_SCHEMA', `${layer}.gate`);
    if (l.gate && (!l.fallback_quote || !l.cvar5 || l.cvar5.defined !== false)) fail('TERMS_STAR_SCHEMA', `${layer}.fallback`);
    byLayer[layer] = { min_economic_value: m, thresholds: l.thresholds, ...(l.gate ? { gate: l.gate } : {}) };
  }
  return { insufficient_policy: pol.values, by_layer: byLayer };
}

const load = (file = FILE) => parse(JSON.parse(fs.readFileSync(file, 'utf8')));
const sha256OfFile = (file = FILE) => require('./common').sha256(fs.readFileSync(file));

module.exports = { FILE, parse, load, sha256OfFile, canonicalJson };
