'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const races = require('../services/race-orchestrator');
const experiments = require('../services/experiment-orchestrator');
const { setupExperiment } = require('./_fixture');

const SPEC = {
  primary_metric: 'good_precision',
  guardrails: [
    { id: 'G1', rule: 'NOT_WORSE_THAN_CHAMPION_BY', metric: 'bad_precision', value: 0.10 },
    { id: 'G2', rule: 'AT_LEAST_FRACTION_OF_CHAMPION', metric: 'good_count', value: 0.5 },
  ],
};

test('裁决器:胜/守/负/不可判 四种机械结论', () => {
  const win = races.adjudicate(SPEC, {
    championMetrics: { good_precision: 0.5, bad_precision: 0.6, good_count: 100 },
    challengerMetrics: { good_precision: 0.55, bad_precision: 0.58, good_count: 80 },
  });
  assert.equal(win.verdict, 'CHALLENGER_WINS');

  const hold = races.adjudicate(SPEC, {
    championMetrics: { good_precision: 0.5, bad_precision: 0.6, good_count: 100 },
    challengerMetrics: { good_precision: 0.5, bad_precision: 0.6, good_count: 100 },
  });
  assert.equal(hold.verdict, 'CHAMPION_HOLDS');

  // primary 更好但 guardrail 违约 → NEGATIVE_RESULT(守卫优先)
  const neg = races.adjudicate(SPEC, {
    championMetrics: { good_precision: 0.5, bad_precision: 0.6, good_count: 100 },
    challengerMetrics: { good_precision: 0.9, bad_precision: 0.4, good_count: 100 },
  });
  assert.equal(neg.verdict, 'NEGATIVE_RESULT');
  assert.deepEqual(neg.guardrail_breaches, ['G1']);

  const inc = races.adjudicate(SPEC, {
    championMetrics: { bad_precision: 0.6, good_count: 100 },
    challengerMetrics: { good_precision: 0.9, bad_precision: 0.6, good_count: 100 },
  });
  assert.equal(inc.verdict, 'INCONCLUSIVE');
});

test('守卫 fail-closed:指标缺失=违约;未知规则抛错', () => {
  const r = races.adjudicate(SPEC, {
    championMetrics: { good_precision: 0.5, bad_precision: 0.6 },   // 缺 good_count
    challengerMetrics: { good_precision: 0.6, bad_precision: 0.6 },
  });
  assert.equal(r.verdict, 'NEGATIVE_RESULT');
  assert.ok(r.guardrail_breaches.includes('G2'));
  assert.throws(() => races.adjudicate(
    { primary_metric: 'x', guardrails: [{ id: 'GX', rule: 'VIBES', metric: 'x', value: 1 }] },
    { championMetrics: { x: 1 }, challengerMetrics: { x: 2 } },
  ), /UNKNOWN_GUARDRAIL_RULE/);
});

test('Race 控制变量:缺边 paired sample 拒绝;PORTFOLIO_RACE 不在 MVP', async () => {
  const { exp } = await setupExperiment();
  assert.throws(() => races.openRace({ race_type: 'PORTFOLIO_RACE', experiment_ref: exp.experiment_id }), /PORTFOLIO_RACE_NOT_IN_MVP/);
  const race = races.openRace({ race_type: 'STAGE_RACE', experiment_ref: exp.experiment_id });
  assert.throws(() => races.submitPairedSamples(race.race_id, []), /EMPTY_PAIRED_SAMPLES/);
  assert.throws(() => races.submitPairedSamples(race.race_id, [{ key: 'k', champion_output: 'GOOD' }]), /PAIRED_SAMPLE_MISSING:challenger_output/);
});

test('closeRace:预注册裁决 + Result Lock 写回实验;二次关闭拒绝', async () => {
  const { exp } = await setupExperiment();
  const artifact = await experiments.runBacktest(exp.experiment_id);
  const race = races.openRace({ race_type: 'STAGE_RACE', experiment_ref: exp.experiment_id });
  races.submitPairedSamples(race.race_id, artifact.paired_rows_oos);
  const m = (side) => ({
    good_precision: artifact.precision_oos[side].good_precision,
    bad_precision: artifact.precision_oos[side].bad_precision,
    good_count: artifact.precision_oos[side].good_count,
  });
  const closed = await races.closeRace(race.race_id, { championMetrics: m('champion'), challengerMetrics: m('challenger') });
  assert.ok(['CHALLENGER_WINS', 'CHAMPION_HOLDS', 'NEGATIVE_RESULT', 'INCONCLUSIVE'].includes(closed.result.conclusion));
  assert.ok(closed.result.result_hash);
  assert.equal(experiments.experimentHead(exp.experiment_id).status, 'RESULT_LOCKED');
  await assert.rejects(async () => races.closeRace(race.race_id, { championMetrics: m('champion'), challengerMetrics: m('challenger') }), /RACE_NOT_SAMPLED/);
});
