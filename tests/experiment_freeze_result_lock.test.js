'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const experiments = require('../services/experiment-orchestrator');
const { setupExperiment } = require('./_fixture');

test('Hypothesis:缺失机制/失败条件/守卫拒绝注册', () => {
  assert.throws(() => experiments.registerHypothesis({ research_question: 'q' }), /HYPOTHESIS_MISSING_FIELD/);
  assert.throws(() => experiments.registerHypothesis({
    research_question: 'q', expected_mechanism: 'm', failure_condition: 'f', primary_metric: 'p', guardrails: [],
  }), /guardrails/);
});

test('冻结完整性:篡改台账首行冻结域 → verifyFreeze 拒绝', async () => {
  const { exp } = await setupExperiment();
  assert.equal(experiments.verifyFreeze(exp.experiment_id).ok, true);
  // 直接篡改台账(模拟越权改冻结域)
  const file = experiments.EXPERIMENTS_LEDGER();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const rows = lines.map((l) => JSON.parse(l));
  const idx = rows.findIndex((r) => r.experiment_id === exp.experiment_id);
  rows[idx].costs = { cost_per_side: 0 }; // 篡改成本
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const v = experiments.verifyFreeze(exp.experiment_id);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'FREEZE_HASH_MISMATCH');
  await assert.rejects(async () => experiments.runBacktest(exp.experiment_id), /BACKTEST_REJECTED/);
});

test('Result Lock:结果只登记一次;INVALIDATED 实验拒绝回测;已锁结果不可作废', async () => {
  const { exp } = await setupExperiment();
  const artifact = await experiments.runBacktest(exp.experiment_id);
  experiments.recordResult(exp.experiment_id, { verdict: 'CHAMPION_HOLDS' });
  assert.equal(experiments.experimentHead(exp.experiment_id).result.sample_evidence_ref, artifact.result_hash);
  assert.throws(() => experiments.recordResult(exp.experiment_id, { verdict: 'CHALLENGER_WINS' }), /ALREADY_LOCKED/);
  await assert.rejects(() => experiments.runBacktest(exp.experiment_id), /RESULT_ALREADY_LOCKED/);
  assert.throws(() => experiments.invalidateExperiment(exp.experiment_id), /CANNOT_INVALIDATE_LOCKED_RESULT/);

  const { exp: exp2 } = await setupExperiment();
  experiments.invalidateExperiment(exp2.experiment_id, '需要改冻结域,按规则开新实验');
  await assert.rejects(async () => experiments.runBacktest(exp2.experiment_id), /EXPERIMENT_INVALIDATED/);
});

test('Result Lock:verdict 必须在枚举内', async () => {
  const { exp } = await setupExperiment();
  assert.throws(() => experiments.recordResult(exp.experiment_id, { verdict: 'MAYBE' }), /RESULT_MISSING_VERDICT/);
});

test('Result Lock:只能绑定已完成回测的唯一产物 hash', async () => {
  const { exp } = await setupExperiment();
  assert.throws(() => experiments.recordResult(exp.experiment_id, { verdict: 'INCONCLUSIVE' }), /BACKTEST_NOT_COMPLETED/);
  const artifact = await experiments.runBacktest(exp.experiment_id);
  assert.throws(() => experiments.recordResult(exp.experiment_id, {
    verdict: 'INCONCLUSIVE', sample_evidence_ref: 'f'.repeat(64),
  }), /SAMPLE_EVIDENCE_MISMATCH/);
  const locked = experiments.recordResult(exp.experiment_id, {
    verdict: 'INCONCLUSIVE', sample_evidence_ref: artifact.result_hash,
  });
  assert.equal(locked.result_artifact_hash, artifact.result_hash);
});

test('NegativeResult 归档需要 hypothesis_ref + failure_reason', () => {
  assert.throws(() => experiments.archiveNegativeResult({ failure_reason: 'x' }), /NEGATIVE_MISSING_FIELD/);
  const rec = experiments.archiveNegativeResult({ hypothesis_ref: 'HYP-x', failure_reason: 'guardrail 违约' });
  assert.equal(rec.schema, 'NEGATIVE_RESULT_V1');
});
