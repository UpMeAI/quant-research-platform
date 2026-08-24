'use strict';
/**
 * CanonicalRaceMetrics —— 各市场原生回测结果统一归一后的赛马指标形状(§10.1 Race Board 七轴)。
 * adapter.normalize_result 必须产出本形状;Race Board 只消费 canonical,不读市场原生结构。
 */
const AXES = Object.freeze({
  absolute: ['cumRet', 'cagr', 'nav_end', 'tradeCount', 'max_dd_recovery_days'],
  risk: ['maxDrawdown', 'annualized_vol', 'calmar', 'sortino_like'],
  relative: ['benchmarkExcess', 'benchmark_cumRet'],
  trading_quality: ['good_precision', 'bad_precision', 'payoff_ratio', 'expectancy',
    'mae_avg_on_good', 'mfe_avg_on_good', 'signal_turnover_per_day', 'costPerSide'],
  robustness: ['is_cumRet', 'oos_cumRet', 'is_oos_decay'],
  operational: ['deterministic', 'result_hash', 'replayable'],
  capacity: ['status'],   // MVP 只声明状态(NOT_IMPLEMENTED_P4);容量模型属 §21 P4
  // §8 RaceResult.cost_breakdown / §9 Costs:成本必须逐项交代(合并 or 未建模),
  // 不允许用一个总费率冒充"手续费/滑点/冲击/funding/FX/流动性"全覆盖。
  cost_breakdown: ['model', 'components'],
});

/** 未实现的指标必须用显式状态串标注,禁止用 null/空对象冒充「已覆盖」。 */
const NOT_IMPLEMENTED_MARKERS = Object.freeze(['NOT_IMPLEMENTED_MVP', 'NOT_IMPLEMENTED_P4', 'UNSUPPORTED']);

/** 宽松校验:七轴对象齐全即可;缺数值字段标 null 不抛(样本不足只描述)。 */
function validateCanonicalMetrics(m) {
  const problems = [];
  if (!m || typeof m !== 'object') return { ok: false, problems: ['METRICS_NOT_OBJECT'] };
  for (const axis of Object.keys(AXES)) if (m[axis] === undefined) problems.push(`METRICS_MISSING_AXIS:${axis}`);
  return { ok: problems.length === 0, problems };
}

module.exports = { AXES, NOT_IMPLEMENTED_MARKERS, validateCanonicalMetrics };
