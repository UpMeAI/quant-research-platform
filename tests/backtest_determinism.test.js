'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const experiments = require('../services/experiment-orchestrator');
const { setupExperiment } = require('./_fixture');

test('回测决定论:同实验重跑 result_hash 相同且命中重放', () => {
  const { exp } = setupExperiment();
  const a1 = experiments.runBacktest(exp.experiment_id);
  const a2 = experiments.runBacktest(exp.experiment_id);
  assert.equal(a1.result_hash, a2.result_hash);
  assert.equal(a2.replayHit, true);
  assert.ok(a1.paired_rows_oos.length > 0);
  // 每条 paired row 双边输出齐全(受控比较前提)
  for (const r of a1.paired_rows_oos.slice(0, 20)) {
    assert.ok(r.key && r.champion_output && r.challenger_output);
  }
});

test('回测 PIT 前提:缺预注册 oos_start 拒绝', () => {
  const { exp } = setupExperiment({ spec: { sample: { is_end: null, oos_start: null } } });
  assert.throws(() => experiments.runBacktest(exp.experiment_id), /BACKTEST_MISSING_PREREGISTERED_OOS_START/);
});

test('DatasetSnapshot 决定论:同数据同 as_of → 同 snapshot_id / lineage_hash', () => {
  const s1 = experiments.captureDatasetSnapshot('CN_A');
  const s2 = experiments.captureDatasetSnapshot('CN_A');
  assert.equal(s1.snapshot_id, s2.snapshot_id);
  assert.equal(s1.lineage_hash, s2.lineage_hash);
});
