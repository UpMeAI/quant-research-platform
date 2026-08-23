'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const shadow = require('../services/shadow-control');
const experiments = require('../services/experiment-orchestrator');
const { setupExperiment } = require('./_fixture');

function openRun(min = 3) {
  const fx = setupExperiment({ min_forward_evidence: min });
  const run = shadow.openShadowRun({
    champion_ref: fx.champRef, challenger_ref: fx.chalRef,
    race_ref: 'RACE-T', experiment_ref: fx.exp.experiment_id,
  });
  return { fx, run };
}

test('Shadow:开启需要冻结完好的实验;min_forward_evidence 来自实验预注册', () => {
  const { run } = openRun(7);
  assert.equal(run.min_forward_evidence, 7);
  assert.equal(run.virtual_ledger_ref, `VL-${run.shadow_id}`);
  assert.throws(() => shadow.openShadowRun({
    champion_ref: 'a', challenger_ref: 'b', race_ref: 'c', experiment_ref: 'EXP-NOPE',
  }), /SHADOW_REJECTED_EXPERIMENT/);
});

test('Shadow:观察幂等(同 key 跳过);agree 也计入前向样本;Virtual Ledger 独立记账', () => {
  const { run } = openRun(3);
  const obs = { key: '2026-06-01', business_date: '2026-06-01', champion_output: ['600001.SH'], challenger_output: ['600001.SH'] };
  const r1 = shadow.recordObservation(run.shadow_id, obs);
  assert.equal(r1.agree, true);
  const r2 = shadow.recordObservation(run.shadow_id, obs);
  assert.equal(r2.idempotent_skip, true);
  assert.equal(shadow.sufficiency(run.shadow_id).forward_sample_count, 1);
  assert.equal(shadow.virtualLedger(run.shadow_id).length, 1);
});

test('Shadow:样本不足 DESCRIBE_ONLY,足量 CLAIM_ELIGIBLE', () => {
  const { run } = openRun(3);
  shadow.recordObservation(run.shadow_id, { key: 'd1', business_date: 'd1', champion_output: [], challenger_output: [] });
  shadow.recordObservation(run.shadow_id, { key: 'd2', business_date: 'd2', champion_output: [], challenger_output: ['600001.SH'] });
  assert.equal(shadow.sufficiency(run.shadow_id).claim_status, 'DESCRIBE_ONLY');
  shadow.recordObservation(run.shadow_id, { key: 'd3', business_date: 'd3', champion_output: [], challenger_output: [] });
  const s = shadow.sufficiency(run.shadow_id);
  assert.equal(s.claim_status, 'CLAIM_ELIGIBLE');
  assert.equal(s.disagreement_count, 1);
});

test('Shadow:经 adapter 的同 PIT 观察可入账;halt 后拒绝新观察;停止条件枚举', () => {
  const { fx, run } = openRun(3);
  const artifact = experiments.runBacktest(fx.exp.experiment_id);
  const evalDate = artifact.dates[artifact.dates.length - 1];
  const obs = shadow.observeViaAdapter(run.shadow_id, evalDate);
  assert.equal(obs.business_date, evalDate);
  assert.throws(() => shadow.haltShadowRun(run.shadow_id, 'BECAUSE'), /BAD_STOP_CONDITION/);
  shadow.haltShadowRun(run.shadow_id, 'OPERATIONAL_ERROR_OR_DUPLICATE', '测试停机');
  assert.throws(() => shadow.recordObservation(run.shadow_id, { key: 'x', business_date: 'x', champion_output: [], challenger_output: [] }), /SHADOW_NOT_RUNNING/);
});
