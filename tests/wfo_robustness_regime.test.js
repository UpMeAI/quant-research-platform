'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const experiments = require('../services/experiment-orchestrator');
const races = require('../services/race-orchestrator');
const { planFolds } = require('../services/experiment-orchestrator/wfo');
const localAdapter = require('../adapters/ashare-local');
const { setupExperiment } = require('./_fixture');

test('WFO fold 切分:train/test 不重叠且滚动前进', () => {
  const dates = Array.from({ length: 100 }, (_, i) => `D${String(i).padStart(3, '0')}`);
  const folds = planFolds(dates, { train_days: 40, test_days: 20, step_days: 20 });
  assert.ok(folds.length >= 2);
  for (const f of folds) {
    assert.ok(f.train_to < f.test_from);                     // 不重叠
    assert.ok(f.train_from < f.train_to && f.test_from < f.test_to);
  }
  for (let i = 1; i < folds.length; i++) assert.ok(folds[i].train_from > folds[i - 1].train_from); // 前进
});

test('WFO:只在预注册网格内选参,test 段结果才计入结论;缺配置/缺网格 fail-closed', async () => {
  const noCfg = await setupExperiment({ spec: { sample: { oos_start: '2026-06-01', is_end: '2026-06-01' } } });
  await assert.rejects(async () => experiments.runWalkForward(noCfg.exp.experiment_id), /WFO_MISSING_PREREGISTERED_CONFIG/);
  const noGrid = await setupExperiment({ spec: { parameter_grid: [] } });
  await assert.rejects(async () => experiments.runWalkForward(noGrid.exp.experiment_id), /WFO_MISSING_PARAMETER_GRID/);

  const { exp } = await setupExperiment();
  const rep = await experiments.runWalkForward(exp.experiment_id);
  assert.equal(rep.schema, 'WFO_REPORT_V1');
  assert.ok(rep.fold_count >= 1);
  const gridKeys = rep.parameter_grid.map((g) => JSON.stringify(g));
  for (const f of rep.folds.filter((x) => x.status === 'EVALUATED')) {
    assert.ok(gridKeys.includes(JSON.stringify(f.selected_params)));  // 选参必在预注册网格内
    assert.ok(f.train_to < f.test_from);                              // 训练段不污染测试段
    assert.ok(f.test_result_hash);
  }
  assert.ok(rep.challenger_win_fraction === null || (rep.challenger_win_fraction >= 0 && rep.challenger_win_fraction <= 1));
  assert.equal(experiments.wfoReportFor(exp.experiment_id).report_hash, rep.report_hash);
});

test('Robustness:五维齐全,不可执行维度诚实标注,不发明阈值', async () => {
  const { exp } = await setupExperiment();
  const rep = await experiments.runRobustness(exp.experiment_id);
  assert.equal(rep.schema, 'ROBUSTNESS_REPORT_V1');
  for (const dim of ['parameter_perturbation', 'subsample_universe', 'time_phase', 'execution_stress', 'data_source']) {
    assert.ok(rep.dimensions[dim], `缺维度 ${dim}`);
    assert.ok(['EVALUATED', 'NOT_APPLICABLE', 'NOT_IMPLEMENTED'].includes(rep.dimensions[dim].status));
  }
  // 单一数据源样本 → data_source 必须诚实标 NOT_APPLICABLE,而不是「通过」
  assert.equal(rep.dimensions.data_source.status, 'NOT_APPLICABLE');
  // 成本压力下双方同窗口对比,结论只是机械事实
  assert.equal(rep.dimensions.execution_stress.trials.length, 2);
  assert.ok(rep.challenger_better_fraction === null || (rep.challenger_better_fraction >= 0 && rep.challenger_better_fraction <= 1));
  assert.ok(!('verdict' in rep));   // 不发明稳健/不稳健裁定
});

test('Regime 分解:paired sample 落台账并按 adapter 标注拆解', async () => {
  const { exp } = await setupExperiment();
  const artifact = await experiments.runBacktest(exp.experiment_id);
  const race = races.openRace({ race_type: 'STAGE_RACE', experiment_ref: exp.experiment_id });
  races.submitPairedSamples(race.race_id, artifact.paired_rows_oos);
  assert.equal(races.pairedSamples(race.race_id).length, artifact.paired_rows_oos.length); // 原始样本可回溯

  const m = (side) => ({
    good_precision: artifact.precision_oos[side].good_precision,
    bad_precision: artifact.precision_oos[side].bad_precision,
    good_count: artifact.precision_oos[side].good_count,
  });
  const closed = await races.closeRace(race.race_id, { championMetrics: m('champion'), challengerMetrics: m('challenger'), canonical: localAdapter.normalize_result(artifact) });
  const rb = closed.result.regime_breakdown;
  assert.equal(rb.status, 'EVALUATED');
  assert.ok(rb.regime_count >= 1);
  assert.ok(rb.regime_model);                                   // 标明 Regime 口径来源
  for (const [regime, cell] of Object.entries(rb.by_regime)) {
    assert.ok(cell.sample_count > 0, `${regime} 空桶`);
    assert.ok('champion' in cell && 'challenger' in cell);
  }
});

test('Regime 分解:adapter 未提供标注时显式 UNSUPPORTED(不臆造)', async () => {
  const adapter = require('../adapters/ashare-local');
  const original = adapter.regime_labels;
  delete adapter.regime_labels;
  try {
    const r = await races.computeRegimeBreakdown('CN_A', [{ key: 'k', d: '2026-06-01', champion_output: 'GOOD', challenger_output: 'GOOD', fwd: 0.01 }]);
    assert.equal(r.status, 'UNSUPPORTED');
  } finally { adapter.regime_labels = original; }
});

test('§9.1 Factor Lab:FactorDefinition 可注册并产出 IC/RankIC/衰减;因子层无生产动作权', async () => {
  const factors = require('../services/factor-lab');
  require('./_fixture').seedData();

  assert.throws(() => factors.registerFactor({ factor_id: 'F', market: 'CN_A', definition: {}, economic_rationale: 'x', direction: 'UP', horizons: [1] }), /FACTOR_BAD_DIRECTION/);
  assert.throws(() => factors.registerFactor({ factor_id: 'F', market: 'CN_A', definition: {}, economic_rationale: 'x', direction: 'HIGHER_IS_BETTER', horizons: [] }), /FACTOR_MISSING_FIELD:horizons/);

  const f = factors.registerFactor({
    factor_id: 'FAC-CN_A-REVERSAL5', market: 'CN_A',
    definition: { expr: 'REVERSAL_N', params: { n: 5 } },
    economic_rationale: '短期超跌反弹:过去 5 日跌幅越大,后续短窗口反弹概率越高',
    direction: 'HIGHER_IS_BETTER', horizons: [1, 3, 5],
  });
  assert.equal(f.version, 1);
  assert.equal(f.production_action_authority, 'NONE');  // §9.1:因子不直接产生生产动作

  const ev = await factors.evaluateFactor('FAC-CN_A-REVERSAL5', { universe: { cap: 8 } });
  assert.equal(ev.schema, 'FACTOR_EVALUATION_V1');
  for (const h of [1, 3, 5]) {
    const cell = ev.by_horizon[h];
    assert.equal(cell.horizon_days, h);
    assert.ok(cell.pair_count > 0, `horizon ${h} 应有可评样本`);
    assert.ok(cell.ic_mean === null || (cell.ic_mean >= -1 && cell.ic_mean <= 1));
    assert.ok(cell.rank_ic_mean === null || (cell.rank_ic_mean >= -1 && cell.rank_ic_mean <= 1));
  }
  assert.deepEqual(ev.decay.horizons, [1, 3, 5]);
  assert.equal(ev.correlation_to_refs.status, 'NOT_IMPLEMENTED_MVP'); // 不留空对象假装覆盖

  // 未实现 evaluate_factor 的市场 → 显式 UNSUPPORTED,不臆造 IC
  const local = require('../adapters/ashare-local');
  const { registerAdapter } = require('../adapters/registry');
  const noFactor = { ...local, manifest: { ...local.manifest, market_id: 'CN_A_NOFACTOR' } };
  delete noFactor.evaluate_factor;
  registerAdapter(noFactor);
  factors.registerFactor({
    factor_id: 'FAC-NOFACTOR', market: 'CN_A_NOFACTOR',
    definition: { expr: 'REVERSAL_N', params: { n: 5 } }, economic_rationale: 'x',
    direction: 'HIGHER_IS_BETTER', horizons: [1],
  });
  assert.equal((await factors.evaluateFactor('FAC-NOFACTOR')).status, 'UNSUPPORTED');

  // 未支持的因子表达式 fail-closed
  factors.registerFactor({
    factor_id: 'FAC-BAD', market: 'CN_A', definition: { expr: 'MAGIC_ALPHA' },
    economic_rationale: 'x', direction: 'HIGHER_IS_BETTER', horizons: [1],
  });
  await assert.rejects(() => factors.evaluateFactor('FAC-BAD'), /FACTOR_EXPR_UNSUPPORTED/);
});
