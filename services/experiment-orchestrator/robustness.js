'use strict';
/**
 * Robustness(§9 冻结项「参数扰动 / 子样本 / 数据源 / 时间相位 / 执行压力」·
 * §10.1 Race Board Robustness 轴 · §16.3 步骤 4)。
 *
 * 与 WFO 同理:鲁棒性是市场无关的研究协议(L3),平台侧编排,只经 §14.1
 * adapter.run_backtest 重复受控回测;每个维度都在**同一 OOS 窗口**上做扰动,
 * Champion 与 Challenger 每次同跑同窗口(受控比较,§10)。
 *
 * 诚实边界:
 *   - 只报机械事实(各扰动下 challenger 是否仍优于 champion、指标离散度),
 *     不发明「稳健/不稳健」阈值 —— 判据属实验预注册(§9);
 *   - 无法执行的维度(如只有单一数据源)标 NOT_APPLICABLE,不伪造通过。
 */
const path = require('path');
const { dataDir, hash, now, append, read } = require('../../packages/ledger');
const { getAdapter } = require('../../adapters/registry');

const ROBUSTNESS_LEDGER = () => path.join(dataDir('research'), 'robustness_reports.jsonl');

function _metric(a, side, m) {
  const p = a.precision_oos ? a.precision_oos[side] : a.precision[side];
  if (p && p[m] != null) return p[m];
  const seg = a.summary?.oos?.[side];
  return seg && seg[m] != null ? seg[m] : null;
}

function _trial(adapter, spec, label, patch) {
  try {
    const a = adapter.run_backtest({ ...spec, ...patch, sample: { ...spec.sample, ...(patch.sample || {}) } });
    const champion = _metric(a, 'champion', spec.primary_metric);
    const challenger = _metric(a, 'challenger', spec.primary_metric);
    return {
      label, status: 'EVALUATED', champion, challenger,
      challenger_better: champion != null && challenger != null ? challenger > champion : null,
      result_hash: a.result_hash,
    };
  } catch (e) {
    return { label, status: 'FAILED', reason: String(e.message || e) };
  }
}

function _dispersion(trials) {
  const vals = trials.map((t) => t.challenger).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return {
    n: vals.length, min: Number(sorted[0].toFixed(6)), max: Number(sorted[sorted.length - 1].toFixed(6)),
    median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(6)),
    mean: Number(mean.toFixed(6)),
    spread: Number((sorted[sorted.length - 1] - sorted[0]).toFixed(6)),
  };
}

/** 执行五维鲁棒性检验(OOS 窗口内)。 */
function runRobustness(experimentId) {
  const experiments = require('./index'); // 延迟 require:避免与主模块循环加载
  const v = experiments.verifyFreeze(experimentId);
  if (!v.ok) throw new Error(`ROBUSTNESS_REJECTED:${v.reason}`);
  const spec = v.spec;
  const adapter = getAdapter(spec.market);
  const oosStart = spec.sample?.oos_start;
  if (!oosStart) throw new Error('ROBUSTNESS_MISSING_OOS_START');
  const baseSpec = { ...spec, sample: { ...spec.sample, window_from: oosStart, window_to: null } };
  const baseline = adapter.run_backtest(baseSpec);
  const dates = baseline.dates;
  const dims = {};

  // 1) 参数扰动:预注册网格内逐点(禁网格外新参数)
  const grid = Array.isArray(spec.parameter_grid) ? spec.parameter_grid : [];
  const baseVariant = { ...spec.execution_model?.challenger_variant };
  dims.parameter_perturbation = grid.length
    ? {
      status: 'EVALUATED',
      trials: grid.map((g) => _trial(adapter, baseSpec, `params:${JSON.stringify(g)}`, {
        execution_model: { ...spec.execution_model, challenger_variant: { ...baseVariant, ...g, key: 'CHALLENGER' } },
      })),
    }
    : { status: 'NOT_APPLICABLE', reasonCn: '实验未预注册 parameter_grid —— 无合法扰动空间(不得运行后追加)' };
  if (dims.parameter_perturbation.trials) dims.parameter_perturbation.dispersion = _dispersion(dims.parameter_perturbation.trials);

  // 2) 子样本(宇宙):按 stride 切成互不重叠的两个半宇宙
  dims.subsample_universe = {
    status: 'EVALUATED',
    trials: [
      _trial(adapter, baseSpec, 'universe:odd', { universe: { ...spec.universe, skip: 0, stride: 2 } }),
      _trial(adapter, baseSpec, 'universe:even', { universe: { ...spec.universe, skip: 1, stride: 2 } }),
    ],
  };

  // 3) 时间相位:OOS 段前后半 + 起点平移
  const mid = dates[Math.floor(dates.length / 2)];
  dims.time_phase = {
    status: 'EVALUATED',
    trials: [
      _trial(adapter, baseSpec, `time:first_half(${oosStart}..${mid})`, { sample: { window_from: oosStart, window_to: mid } }),
      _trial(adapter, baseSpec, `time:second_half(${mid}..)`, { sample: { window_from: mid, window_to: null } }),
      _trial(adapter, baseSpec, 'time:shift+5d', { sample: { window_from: dates[Math.min(5, dates.length - 1)], window_to: null } }),
    ],
  };

  // 4) 执行压力:成本 ×2 / ×3(边际是否被成本吃掉)
  const c0 = Number(spec.costs?.cost_per_side ?? 0.001);
  dims.execution_stress = {
    status: 'EVALUATED',
    trials: [
      _trial(adapter, baseSpec, `cost x2 (${c0 * 2})`, { costs: { ...spec.costs, cost_per_side: c0 * 2 } }),
      _trial(adapter, baseSpec, `cost x3 (${c0 * 3})`, { costs: { ...spec.costs, cost_per_side: c0 * 3 } }),
    ],
  };

  // 5) 数据源:快照声明的来源数 < 2 → 无法做跨源对比,诚实标 NOT_APPLICABLE
  const snap = experiments.snapshotHead(spec.dataset_snapshot_ref);
  const sources = snap?.coverage?.sources || [];
  dims.data_source = sources.length > 1
    ? { status: 'NOT_IMPLEMENTED', reasonCn: `快照含 ${sources.length} 个来源,跨源重放需 adapter 支持按源过滤(未实现,不伪造结果)` }
    : { status: 'NOT_APPLICABLE', sources, reasonCn: '数据快照只有单一来源,无法做跨源鲁棒性对比' };

  const allTrials = Object.values(dims).flatMap((d) => d.trials || []);
  const decidable = allTrials.filter((t) => t.challenger_better != null);
  const report = {
    schema: 'ROBUSTNESS_REPORT_V1',
    experiment_ref: experimentId,
    market: spec.market,
    primary_metric: spec.primary_metric,
    baseline: {
      champion: _metric(baseline, 'champion', spec.primary_metric),
      challenger: _metric(baseline, 'challenger', spec.primary_metric),
      result_hash: baseline.result_hash,
    },
    dimensions: dims,
    trial_count: allTrials.length,
    decidable_trial_count: decidable.length,
    challenger_better_count: decidable.filter((t) => t.challenger_better).length,
    challenger_better_fraction: decidable.length
      ? Number((decidable.filter((t) => t.challenger_better).length / decidable.length).toFixed(4)) : null,
    failed_trial_count: allTrials.filter((t) => t.status === 'FAILED').length,
    claimCn: '只陈述各扰动下的机械对比与离散度;是否算稳健由实验预注册判据裁定,本报告不发明阈值',
    ranAt: now(),
  };
  report.report_hash = hash({ ...report, ranAt: null });
  return append(ROBUSTNESS_LEDGER(), report);
}

function robustnessReportFor(experimentId) {
  const rows = read(ROBUSTNESS_LEDGER()).filter((r) => r.experiment_ref === experimentId);
  return rows.length ? rows[rows.length - 1] : null;
}

module.exports = { runRobustness, robustnessReportFor, ROBUSTNESS_LEDGER };
