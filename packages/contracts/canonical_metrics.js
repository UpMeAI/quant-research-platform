'use strict';
/**
 * CanonicalRaceMetrics —— 各市场原生回测结果统一归一后的赛马指标形状(§10.1 Race Board 七轴)。
 * adapter.normalize_result 必须产出本形状;Race Board 只消费 canonical,不读市场原生结构。
 */
const AXES = Object.freeze({
  absolute: ['cumRet', 'nav_end', 'tradeCount'],
  risk: ['maxDrawdown'],
  relative: ['benchmarkExcess'],
  trading_quality: ['good_precision', 'bad_precision', 'good_count', 'bad_count', 'costPerSide'],
  robustness: ['is_cumRet', 'oos_cumRet'],
  operational: ['deterministic', 'result_hash'],
  capacity: [],   // MVP 声明轴存在;容量模型属 P4(§21)
});

/** 宽松校验:七轴对象齐全即可;缺数值字段标 null 不抛(样本不足只描述)。 */
function validateCanonicalMetrics(m) {
  const problems = [];
  if (!m || typeof m !== 'object') return { ok: false, problems: ['METRICS_NOT_OBJECT'] };
  for (const axis of Object.keys(AXES)) if (m[axis] === undefined) problems.push(`METRICS_MISSING_AXIS:${axis}`);
  return { ok: problems.length === 0, problems };
}

module.exports = { AXES, validateCanonicalMetrics };
