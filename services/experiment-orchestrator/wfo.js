'use strict';
/**
 * Walk-Forward Optimization(§9 Sample: IS/OOS/**WFO** · §16.3 步骤 4 · §21 P1 准出)。
 *
 * 定位:WFO 是**市场无关的研究协议**(L3),因此编排在平台侧,只经 §14.1
 * adapter.run_backtest 逐窗口调用市场能力;adapter 不需要知道什么是 WFO。
 *
 * 语义(防过拟合的关键):
 *   - 每个 fold:在 train 窗口内**只用预注册 parameter_grid** 选参(禁运行后追加参数);
 *   - 选中的参数在紧邻的 test 窗口上评测,test 结果才计入 WFO 结论;
 *   - train 与 test 严格不重叠且时间前后相接(滚动前进);
 *   - 每个 fold 的 Champion 用同一 train/test 窗口跑,保证受控比较(§10);
 *   - 结论只报机械事实(challenger 在多少比例 fold 的 test 段优于 champion),
 *     不发明阈值、不宣称经济有效(阈值属实验预注册,§9)。
 */
const path = require('path');
const { dataDir, hash, now, append, read } = require('../../packages/ledger');
const { getAdapter } = require('../../adapters/registry');

const WFO_LEDGER = () => path.join(dataDir('research'), 'wfo_reports.jsonl');

/** 从冻结 spec 推导 fold 切分(按交易日序号,非自然日)。 */
function planFolds(dates, { train_days, test_days, step_days, folds }) {
  const plan = [];
  const step = step_days || test_days;
  let start = 0;
  while (plan.length < (folds || Infinity)) {
    const trainFrom = start;
    const trainTo = start + train_days - 1;
    const testFrom = trainTo + 1;
    const testTo = testFrom + test_days - 1;
    if (testTo >= dates.length) break;
    plan.push({
      fold: plan.length + 1,
      train_from: dates[trainFrom], train_to: dates[trainTo],
      test_from: dates[testFrom], test_to: dates[testTo],
    });
    start += step;
  }
  return plan;
}

function _metric(artifact, side, metricName) {
  const p = artifact.precision_oos ? artifact.precision_oos[side] : artifact.precision[side];
  if (p && p[metricName] != null) return p[metricName];
  const seg = artifact.summary?.oos?.[side];
  if (seg && seg[metricName] != null) return seg[metricName];
  return null;
}

/**
 * 执行 WFO。要求 spec.sample.wfo = { train_days, test_days, step_days?, folds? }
 * 且 spec.parameter_grid 非空(选参空间必须预注册)。
 */
function runWalkForward(experimentId) {
  const experiments = require('./index'); // 延迟 require:避免与主模块循环加载
  const v = experiments.verifyFreeze(experimentId);
  if (!v.ok) throw new Error(`WFO_REJECTED:${v.reason}`);
  const spec = v.spec;
  const cfg = spec.sample?.wfo;
  if (!cfg || !cfg.train_days || !cfg.test_days) throw new Error('WFO_MISSING_PREREGISTERED_CONFIG'); // 冻结域内必须给出
  const grid = spec.parameter_grid;
  if (!Array.isArray(grid) || !grid.length) throw new Error('WFO_MISSING_PARAMETER_GRID'); // 禁运行后追加参数

  const adapter = getAdapter(spec.market);
  const baseline = adapter.run_backtest({ ...spec, sample: { ...spec.sample, window_from: null, window_to: null } });
  // 只在**可评测区间**内切 fold(预热期/前向窗口尾部不参与,否则 fold 内无可判样本)
  const ev = baseline.evaluable_range;
  const dates = ev ? baseline.dates.filter((d) => d >= ev.from && d <= ev.to) : baseline.dates;
  const folds = planFolds(dates, cfg);
  if (!folds.length) throw new Error(`WFO_INSUFFICIENT_DATES:${dates.length}(可评测区间 ${ev ? `${ev.from}..${ev.to}` : 'n/a'})`);

  const base = { ...spec.execution_model?.challenger_variant };
  const foldResults = [];
  for (const f of folds) {
    // 1) train 段:预注册网格内选参(primary metric 最优)
    const trials = grid.map((g) => {
      const variant = { ...base, ...g, key: 'CHALLENGER' };
      try {
        const a = adapter.run_backtest({
          ...spec,
          execution_model: { ...spec.execution_model, challenger_variant: variant },
          sample: { ...spec.sample, window_from: f.train_from, window_to: f.train_to, oos_start: f.train_from },
        });
        return { params: g, train_score: _metric(a, 'challenger', spec.primary_metric) };
      } catch (e) {
        return { params: g, train_score: null, error: String(e.message || e) }; // 窗口内无可判样本 = 该点不可选,不静默当 0
      }
    });
    const ranked = trials.filter((t) => t.train_score != null).sort((a, b) => b.train_score - a.train_score);
    if (!ranked.length) { foldResults.push({ ...f, status: 'NO_TRAINABLE_SAMPLE' }); continue; }
    const selected = ranked[0];

    // 2) test 段:用选中的参数,与 Champion 同窗口受控对比
    const t = adapter.run_backtest({
      ...spec,
      execution_model: { ...spec.execution_model, challenger_variant: { ...base, ...selected.params, key: 'CHALLENGER' } },
      sample: { ...spec.sample, window_from: f.test_from, window_to: f.test_to, oos_start: f.test_from },
    });
    const champion = _metric(t, 'champion', spec.primary_metric);
    const challenger = _metric(t, 'challenger', spec.primary_metric);
    foldResults.push({
      ...f, status: 'EVALUATED',
      selected_params: selected.params,
      train_score: Number(selected.train_score.toFixed(6)),
      test_champion: champion, test_challenger: challenger,
      test_challenger_better: champion != null && challenger != null ? challenger > champion : null,
      test_result_hash: t.result_hash,
    });
  }

  const evaluated = foldResults.filter((f) => f.status === 'EVALUATED' && f.test_challenger_better != null);
  const wins = evaluated.filter((f) => f.test_challenger_better).length;
  const paramSet = new Set(evaluated.map((f) => JSON.stringify(f.selected_params)));
  const report = {
    schema: 'WFO_REPORT_V1',
    experiment_ref: experimentId,
    market: spec.market,
    primary_metric: spec.primary_metric,
    config: cfg,
    parameter_grid: grid,
    folds: foldResults,
    fold_count: foldResults.length,
    evaluated_fold_count: evaluated.length,
    challenger_win_folds: wins,
    challenger_win_fraction: evaluated.length ? Number((wins / evaluated.length).toFixed(4)) : null,
    selected_parameter_stability: evaluated.length ? Number((1 / paramSet.size).toFixed(4)) : null,
    stabilityCn: `${paramSet.size} 组不同参数在 ${evaluated.length} 个 fold 被选中(越少越稳定)`,
    claimCn: evaluated.length
      ? '仅陈述机械事实:test 段逐 fold 胜出比例与选参稳定性;是否达标由实验预注册判据裁定'
      : '样本不足以形成任何 WFO 结论(DESCRIBE_ONLY)',
    ranAt: now(),
  };
  report.report_hash = hash({ ...report, ranAt: null });
  return append(WFO_LEDGER(), report);
}

function wfoReportFor(experimentId) {
  const rows = read(WFO_LEDGER()).filter((r) => r.experiment_ref === experimentId);
  return rows.length ? rows[rows.length - 1] : null;
}

module.exports = { runWalkForward, wfoReportFor, planFolds, WFO_LEDGER };
