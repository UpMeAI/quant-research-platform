'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fx = require('./_k2_freeze_fixture');
const prog = require('../services/k2-freeze-program');
const star = require('../services/k2-freeze-program/terms_star');
const { fromSpec } = require('../services/k2-freeze-program/ctx_files');
const insufficient = require('../services/promotion-engine/insufficient');

/**
 * Q3c: config/promotion_terms_star.v1.json = the starred default values, copied verbatim from the frozen plan texts with a source reference each (V1.1 text af34af38,
 * Amendment 1 0e2f3181). A value without a source in those texts is not in the file; a layer whose definition is not frozen yet is not usable.
 */
const FILE = path.join(__dirname, '..', 'config', 'promotion_terms_star.v1.json');
const raw = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

test('terms star file: schema, the two source documents by full sha, every value carries a source reference', () => {
  const f = raw();
  assert.equal(f.schema, 'PROMOTION_TERMS_STAR_V1');
  assert.ok(f.sources.V1_1.sha256.startsWith('af34af38'));
  assert.equal(f.sources.V1_1.sha256.length, 64);
  assert.equal(f.sources.AMENDMENT_1.sha256, '0e2f3181d98902f28b67c53ffd068a32e35e96bb75c1b32b62eb3ab9f45bde43');
  for (const [name, p] of Object.entries(f.insufficient_policy.values)) assert.ok(f.insufficient_policy.sources[name] && f.insufficient_policy.sources[name].doc === 'AMENDMENT_1', name);
  for (const [layer, l] of Object.entries(f.layers)) {
    if (!l.usable) { assert.ok(typeof l.reason === 'string' && l.reason, `${layer} unusable needs a reason`); continue; }
    for (const k of ['min_economic_value', 'thresholds.s3.cost_multiple']) assert.ok(l.sources[k] && f.sources[l.sources[k].doc] && l.sources[k].section && l.sources[k].quote, `${layer}.${k}`);
  }
  assert.ok(Array.isArray(f.not_set) && f.not_set.some((x) => /max_overlap/.test(x)), 'S4 max_overlap has no source value and is recorded as not set');
});

test('terms star values are exactly the frozen texts: alpha delta-g 2 pp per year, cost x2, policy 12 months / 0.5 / 20% / 0.5 / 3; no overlap threshold invented', () => {
  const s = star.load();
  assert.deepEqual(s.by_layer.ALPHA, { min_economic_value: { metric: 'DELTA_G_PER_YEAR', value: 0.02 }, thresholds: { s3: { cost_multiple: 2 } } });
  assert.deepEqual(s.insufficient_policy, { horizon_months: 12, p_threshold: 0.5, budget_share_max: 0.2, resume_sample_fraction: 0.5, max_failed_rechecks: 3 });
  const d = insufficient.AMENDMENT_1_DEFAULT_POLICY;
  for (const k of Object.keys(s.insufficient_policy)) assert.equal(s.insufficient_policy[k], d[k], `engine default ${k}`);
  assert.equal(s.by_layer.RISK.gate, 'NON_INFERIORITY_FALLBACK', 'V1.1 5.2 B fallback until CVaR5 is defined (plan-coord 11-23)');
  assert.deepEqual(s.by_layer.RISK.min_economic_value, { metrics: ['NON_INFERIORITY_D8', 'TOUCH_PROBABILITY_DIFF_X06'], value: 0 });
  assert.deepEqual(s.by_layer.RISK.thresholds, { s3: { cost_multiple: 2, max_growth_sacrifice: 0.01 } });
  assert.equal(s.by_layer.EXECUTION, undefined, 'V1.1 5.2 C names no economic-value number: stays refused');
  assert.equal('s4' in s.by_layer.ALPHA.thresholds, false);
  const f = raw();
  assert.equal(f.layers.RISK.usable, true);
  assert.equal(f.layers.RISK.fallback_quote, '在此之前，风险题沿用现行的门：不劣于对照（D8，d38f87a9）或触线概率差（X06）');
  assert.equal(f.layers.RISK.cvar5.defined, false);
  assert.equal(f.layers.RISK.cvar5.recorded.min_economic_value.value, 0.1, 'the 10% value is recorded for when CVaR5 is defined');
  assert.equal(f.layers.EXECUTION.usable, false);
});

test('terms star loader refuses a file with an unsourced value or a changed source document sha', () => {
  const f = raw();
  const bad1 = JSON.parse(JSON.stringify(f)); delete bad1.layers.ALPHA.sources['min_economic_value'];
  assert.throws(() => star.parse(bad1), /TERMS_STAR_UNSOURCED/);
  const bad2 = JSON.parse(JSON.stringify(f)); bad2.sources.AMENDMENT_1.sha256 = 'f'.repeat(64);
  assert.throws(() => star.parse(bad2), /TERMS_STAR_SOURCE_SHA/);
  const bad3 = JSON.parse(JSON.stringify(f)); bad3.layers.ALPHA.min_economic_value.value = 0.03;
  assert.throws(() => star.parse(bad3), /TERMS_STAR_VALUE_NOT_VERBATIM/);
});

test('the bundle context supplies promotionTermsStar from the file; an AI draft in the ALPHA layer freezes with the star values, in RISK uses the V1.1 5.2 B non-inferiority fallback, the CVaR5 path and EXECUTION stay star_missing', () => {
  const ctx = fromSpec({ now: fx.NOW_PREPARE, host: 'LINUX', outDir: fx.tmp(), registerCommit: null });
  assert.deepEqual(ctx.promotionTermsStar, star.load());
  const s = star.load();
  const alpha = (d) => { d.promotion_terms = { layer: 'ALPHA', min_economic_value: s.by_layer.ALPHA.min_economic_value, thresholds: s.by_layer.ALPHA.thresholds, insufficient_policy: s.insufficient_policy, review_endpoint: { kind: 'DATE', value: '2026-12-31' } }; return d; };
  const base = (d) => prog.prepare(d, fx.baseCtx({ promotionTermsStar: s }));
  const ok = base(alpha(fx.baseDraft()));
  assert.equal(ok.state, 'WAITING_EXTERNAL', JSON.stringify(ok.codes));
  const cvar = fx.baseDraft();
  cvar.promotion_terms = { layer: 'RISK', min_economic_value: { metric: 'CVAR5_IMPROVEMENT', value: 0.1 }, thresholds: { s3: { cost_multiple: 2, max_growth_sacrifice: 0.01 } }, insufficient_policy: s.insufficient_policy, review_endpoint: { kind: 'DATE', value: '2026-12-31' } };
  Object.assign(cvar.decision_table, { template_id: 'DT-NON-INFERIORITY-V1', params: { ...cvar.decision_table.params, margin_sd: 0.2 } });
  cvar.desk_items.rule_ref = 'CN_A.RULE.CONCURRENCY';
  const r = base(cvar);
  assert.equal(r.state, 'REFUSED');
  assert.ok(r.codes.includes('PREREG_TERMS_VALUES_NOT_REGISTERED:star_missing'), 'the CVaR5 path stays star_missing: ' + JSON.stringify(r.codes));
  const ni = fx.baseDraft();
  ni.promotion_terms = { layer: 'RISK', min_economic_value: { metric: 'NON_INFERIORITY_D8', value: 0 }, thresholds: s.by_layer.RISK.thresholds, insufficient_policy: s.insufficient_policy, review_endpoint: { kind: 'DATE', value: '2026-12-31' } };
  Object.assign(ni.decision_table, { template_id: 'DT-NON-INFERIORITY-V1', params: { ...ni.decision_table.params, margin_sd: 0.2 } });
  ni.desk_items.rule_ref = 'CN_A.RULE.CONCURRENCY';
  assert.equal(base(ni).state, 'WAITING_EXTERNAL', JSON.stringify(base(ni).codes));
  const x06 = JSON.parse(JSON.stringify(ni)); x06.promotion_terms.min_economic_value = { metric: 'TOUCH_PROBABILITY_DIFF_X06', value: 0 };
  assert.equal(base(x06).state, 'WAITING_EXTERNAL', JSON.stringify(base(x06).codes));
  for (const [metric, value] of [['NON_INFERIORITY_D8', 0.01], ['TOUCH_PROBABILITY_DIFF_X06', 0.01]]) {
    const bad = JSON.parse(JSON.stringify(ni)); bad.promotion_terms.min_economic_value = { metric, value };
    assert.equal(base(bad).state, 'REFUSED', metric);
    assert.ok(base(bad).codes.some((c) => c === 'PROMOTION_TERMS_FALLBACK_MIN_NOT_ZERO' || c.startsWith('PREREG_TERMS_VALUES_NOT_REGISTERED')), `${metric} ${JSON.stringify(base(bad).codes)}`);
  }
  const wrongTable = fx.baseDraft();
  wrongTable.promotion_terms = ni.promotion_terms;
  assert.ok(base(wrongTable).codes.includes('PREREG_TERMS_RISK_NEEDS_NON_INFERIORITY'), 'a RISK draft keeps the non-inferiority table');
  const exec = fx.baseDraft();
  exec.promotion_terms = { layer: 'EXECUTION', min_economic_value: { metric: 'DELTA_G_PER_YEAR', value: 0.02 }, thresholds: { s3: { cost_multiple: 2 } }, insufficient_policy: s.insufficient_policy, review_endpoint: { kind: 'DATE', value: '2026-12-31' } };
  assert.ok(base(exec).codes.includes('PREREG_TERMS_VALUES_NOT_REGISTERED:star_missing'), 'EXECUTION stays refused');
  const tuned = alpha(fx.baseDraft()); tuned.promotion_terms.min_economic_value = { metric: 'DELTA_G_PER_YEAR', value: 0.01 };
  assert.ok(base(tuned).codes.includes('PREREG_TERMS_VALUES_NOT_REGISTERED:min_economic_value'));
});

test('bundle kinds include the terms star file; the promotion engine contract says stage evidence is passed by the caller, not named in the frozen terms', () => {
  assert.ok(require('../services/k2-freeze-program/bundle').KINDS.includes('PROMOTION_TERMS_STAR'));
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'contracts', 'PROMOTION_ENGINE_V1.md'), 'utf8');
  assert.match(doc, /stage evidence is passed by the caller/i);
  assert.match(doc, /evaluate\(\{[^}]*evidence/);
});

test('engine terms: RISK accepts NON_INFERIORITY_D8 and TOUCH_PROBABILITY_DIFF_X06 only with min 0; CVAR5_IMPROVEMENT stays valid but reserved; other layers do not take them', () => {
  const engine = require('../services/promotion-engine');
  const base = { schema: 'PROMOTION_TERMS_V1', candidate_id: 'C1', market: 'CN_A', layer: 'RISK', k2_sha256: 'a'.repeat(64), k2_frozen_at: '2026-11-24T10:05:00+08:00', terms_frozen_at: '2026-11-24T10:05:00+08:00',
    mechanism_ids: ['ACCT.CONCURRENCY.NON_MAJOR_CAP'], min_sample_n: 32, thresholds: { s3: { cost_multiple: 2 } } };
  const v = (over) => engine.validateTerms({ ...base, ...over });
  assert.deepEqual(v({ min_economic_value: { metric: 'NON_INFERIORITY_D8', value: 0 } }), []);
  assert.deepEqual(v({ min_economic_value: { metric: 'TOUCH_PROBABILITY_DIFF_X06', value: 0 } }), []);
  assert.deepEqual(v({ min_economic_value: { metric: 'CVAR5_IMPROVEMENT', value: 0.1 } }), [], 'a valid name at engine level; the freeze program refuses it (star_missing)');
  for (const metric of ['NON_INFERIORITY_D8', 'TOUCH_PROBABILITY_DIFF_X06']) {
    assert.ok(v({ min_economic_value: { metric, value: 0.05 } }).includes('PROMOTION_TERMS_FALLBACK_MIN_NOT_ZERO'), metric);
    assert.ok(v({ layer: 'ALPHA', min_economic_value: { metric, value: 0 } }).includes('PROMOTION_TERMS_ENUM:min_economic_value.metric'), `${metric} not for ALPHA`);
  }
  assert.ok(v({ min_economic_value: { metric: 'SOMETHING_ELSE', value: 0 } }).includes('PROMOTION_TERMS_ENUM:min_economic_value.metric'));
});
