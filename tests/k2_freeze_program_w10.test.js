'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./_k2_freeze_fixture');

const prog = require('../services/k2-freeze-program');
const proposal = require('../services/k2-freeze-program/proposed');

const V2 = 'K2_DRAFT_V2_PROPOSED';
const SEL = 'SEL.CARRY.FUNDING_BASIS';
const RISK = 'RISK.POLICY_SECTOR.SECTOR_K';
const READ = 'TEST.READING';

function proposed(layer = 'RISK') {
  const d = fx.baseDraft({
    schema: V2,
    layer,
    authored_by: { kind: 'HUMAN_SESSION', session_ref: 'w10-acceptance' },
    universe: { definition_zh: '全 A 股可交易普通股', availability_zh: '只用当时可得标的', entry_rule_zh: '按登记规则进入', exit_rule_zh: '退市或不可交易时退出' },
    holding_period: { prediction_window_zh: '一个研究观察窗口', holding_period_zh: '按登记出场规则持有', rebalance_frequency_zh: '每日检查', exit_rule_ref: 'CN_A.RULE.CONCURRENCY' },
    regime: { applicability_zh: '全状态适用并按状态分组报告', use: 'DIAGNOSTIC_ONLY' },
    evaluation_boundaries: {
      development: { from: '2024-01-02', to: '2024-06-30' },
      validation: { from: '2024-07-01', to: '2024-12-31' },
      final_test: { from: '2025-01-01', to: '2025-06-30' },
      forward: { from: '2025-07-01', to: '2025-12-31' },
    },
    costs: { assumptions_zh: '沿用登记账本的手续费、滑点与人工操作假设' },
    drawdown: { policy_zh: '沿用已签回撤、亏损预算和尾部风险约束' },
  });
  delete d.authored_by.schema_sha256;
  if (layer === 'SELECTION_TIMING') {
    d.section0.mechanism_ids = [SEL];
    d.promotion_terms = { ...d.promotion_terms, layer: 'ALPHA', min_economic_value: fx.TERMS_STAR.by_layer.ALPHA.min_economic_value };
  } else if (layer === 'RISK') d.section0.mechanism_ids = [RISK];
  else if (layer === 'ACCOUNT') d.section0.mechanism_ids = [fx.MECH_OK];
  else {
    d.section0.mechanism_ids = [];
    delete d.promotion_terms;
  }
  return d;
}

function withReading(draft, className) {
  draft.arms[1].rule_config.components.push({ kind: 'READING', id: READ });
  return { registeredComponents: { readings: { [READ]: className === undefined ? {} : { class: className } }, ruleParts: [] } };
}

function exact(draft, code, ctxOver = {}, validator = 'V4') {
  const res = prog.prepare(draft, fx.baseCtx(ctxOver));
  assert.equal(res.state, 'REFUSED');
  assert.deepEqual(fx.failing(res), [validator]);
  assert.deepEqual(res.codes, [code]);
  assert.deepEqual(fx.codesOf(res, validator), [code]);
}

test('W10 layer structure refusals have one exact V1 code each', () => {
  const missing = proposed(); delete missing.layer;
  exact(missing, 'PREREG_LAYER_MISSING', {}, 'V1');
  const undecided = proposed(); undecided.layer = 'UNDECIDED';
  exact(undecided, 'PREREG_LAYER_UNDECIDED', {}, 'V1');
  const invalid = proposed(); invalid.layer = 'ALPHA';
  exact(invalid, 'PREREG_LAYER_INVALID:ALPHA', {}, 'V1');
  const notString = proposed(); notString.layer = ['RISK'];
  exact(notString, 'PREREG_LAYER_TYPE', {}, 'V1');
});

test('W10 layer overreach refusals have distinct exact V4 codes', () => {
  const mismatch = proposed('RISK'); mismatch.section0.mechanism_ids = [SEL];
  exact(mismatch, `PREREG_LAYER_MECHANISM_MISMATCH:${SEL}:SELECTION_TIMING!=RISK`);

  const two = proposed('SELECTION_TIMING'); two.section0.mechanism_ids = [SEL, RISK];
  exact(two, 'PREREG_LAYER_MULTIPLE_MECHANISM_LAYERS:RISK,SELECTION_TIMING');

  const noClass = proposed('SELECTION_TIMING');
  exact(noClass, `PREREG_LAYER_READING_CLASS_MISSING:${READ}`, withReading(noClass));

  const wrongClass = proposed('SELECTION_TIMING');
  exact(wrongClass, `PREREG_LAYER_READING_CLASS_FORBIDDEN:SELECTION_TIMING:MARKET_STRUCTURE:${READ}`, withReading(wrongClass, 'MARKET_STRUCTURE'));

  const diagnosticTerms = proposed('DIAGNOSTIC'); diagnosticTerms.promotion_terms = fx.baseDraft().promotion_terms;
  exact(diagnosticTerms, 'PREREG_LAYER_PROMOTION_FORBIDDEN:DIAGNOSTIC');

  exact(proposed('ACCOUNT'), 'PREREG_LAYER_ACCOUNT_NOT_SUPPORTED');

  const unsettled = proposed('SELECTION_TIMING'); unsettled.promotion_terms = fx.baseDraft().promotion_terms;
  exact(unsettled, 'PREREG_LAYER_PROMOTION_PAIR_UNSETTLED:SELECTION_TIMING:RISK');
});

test('W10 proposed schema requires each genuinely new eleven-field key', () => {
  const d = proposed(); delete d.costs;
  exact(d, 'PREREG_FIELDS_MISSING:costs', {}, 'V1');
});

test('W10 accepted SELECTION_TIMING, RISK and DIAGNOSTIC drafts pass the complete prepare/finalize program', () => {
  for (const layer of ['SELECTION_TIMING', 'RISK', 'DIAGNOSTIC']) {
    const d = proposed(layer);
    const ctx = fx.baseCtx();
    const p = prog.prepare(d, ctx);
    assert.equal(p.state, 'WAITING_EXTERNAL', `${layer}: ${JSON.stringify(p.codes)}`);
    const receipt = fx.registerAt(p);
    const out = prog.finalize(d, receipt, { ...ctx, now: fx.NOW_FREEZE, ledgerRows: fx.ledgerRows() }, p.prepared);
    assert.equal(out.state, 'FROZEN', `${layer}: ${JSON.stringify(out.codes)}`);
    assert.deepEqual(fx.failing(out), []);
  }
});

test('W10 transition: a K2_DRAFT_V1 fixture remains accepted without proposed fields or layer', () => {
  const res = prog.prepare(fx.baseDraft(), fx.baseCtx());
  assert.equal(res.state, 'WAITING_EXTERNAL');
  assert.deepEqual(fx.failing(res), []);
});

test('W10 proposed schema and template are addressable by their shipped sha256 sidecars', () => {
  assert.match(proposal.SCHEMA_SHA256, /^[0-9a-f]{64}$/);
  assert.match(proposal.TEMPLATE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(proposal.SCHEMA.status, 'PROPOSED_NOT_FROZEN');
  assert.equal(proposal.TEMPLATE.status, 'PROPOSED_NOT_FROZEN');
  assert.deepEqual(proposal.NEW_KEYS, ['universe', 'holding_period', 'regime', 'evaluation_boundaries', 'costs', 'drawdown']);
});

test('W10 real-material spot check covers every layer-register row and every tracked K2 draft fixture without relaxing findings', () => {
  const report = require('../tools/k2-w10-layer-spot-check').audit();
  assert.equal(report.register.total, require('../services/research-layer-register').REGISTER.entries.length);
  assert.deepEqual([report.register.pass, report.register.refused], [43, 0]);
  assert.deepEqual([report.drafts.total, report.drafts.pass, report.drafts.refused], [5, 1, 4]);
  assert.deepEqual(report.drafts.reasons, { PREREG_LAYER_MISSING: 4 });
});
