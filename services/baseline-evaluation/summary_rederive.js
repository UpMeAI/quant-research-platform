'use strict';

/**
 * 封存摘要由权益序列重算并核对（METRIC_DEFINITIONS_V1 §5、§6、§8）。
 *
 * 以前导入器只核 `end_capital` 等于序列末点；`cagr`、`max_drawdown`、`longest_underwater_sessions`、`recovered`
 * 与自己的序列不符也照收（缺陷 D-QRP-02）。这里按契约把它们从序列重算一遍：
 *   - cagr = 末点 / 起始资本 的 (A / T) 次方 − 1，T = 序列的标记个数（封存结果的第一个标记就是起始资本），A = 市场的年化因子（美股 252，加密 365）；
 *   - max_drawdown = 相对运行峰值的最大落差，峰值从起始资本起算，正小数；
 *   - longest_underwater_sessions = 连续严格低于运行峰值的最长会话数（等于峰值算已回到）；
 *   - recovered = 最后一个标记不在水下。
 * 文件里的摘要取到 6 位小数，所以小数项的容差是 5e-7；计数和布尔必须相等。
 *
 * 起始资本取自 `summary.start_capital`。没有这个字段的臂（现有 US_CORE、Quick Shot、C17 的导入规格没有要求它）无法确定基点，
 * 不重算，行为和以前相同；`check` 返回 `checked: false` 和原因，调用方不把它当成「已核对」。
 * 本模块只做核对，不产生任何展示数字，也不改结果文件。
 */

/** METRIC_DEFINITIONS_V1 §2：策略档案的 `market` → 年化因子。没有登记的市场不重算。 */
const ANNUAL_FACTOR = Object.freeze({ US_EQUITY: 252, CRYPTO_USDM_PERP: 365 });
const TOLERANCE = 5e-7;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** 从权益序列算出契约的四个摘要项。values 全为正的有限数，起始资本为正。 */
function summaryFromSeries(values, startCapital, annualFactor) {
  let peak = startCapital;
  let maxDrawdown = 0;
  let run = 0;
  let longest = 0;
  for (const value of values) {
    if (value >= peak) {
      peak = value;
      longest = Math.max(longest, run);
      run = 0;
    } else {
      run += 1;
      maxDrawdown = Math.max(maxDrawdown, 1 - value / peak);
    }
  }
  longest = Math.max(longest, run);
  const growth = values[values.length - 1] / startCapital;
  return {
    cagr: Math.pow(growth, annualFactor / values.length) - 1,
    max_drawdown: maxDrawdown,
    longest_underwater_sessions: longest,
    recovered: run === 0,
  };
}

/**
 * @returns {{checked: boolean, reason: string|null, problems: Array<{field, stored, derived}>}}
 */
function check(values, summary, market) {
  if (summary.start_capital === undefined) return { checked: false, reason: 'NO_START_CAPITAL', problems: [] };
  if (!finite(summary.start_capital) || summary.start_capital <= 0) {
    return { checked: true, reason: null, problems: [{ field: 'start_capital', stored: summary.start_capital, derived: 'a positive number' }] };
  }
  const annualFactor = ANNUAL_FACTOR[market];
  if (!annualFactor) return { checked: false, reason: `NO_ANNUAL_FACTOR:${market}`, problems: [] };
  const derived = summaryFromSeries(values, summary.start_capital, annualFactor);
  const problems = [];
  for (const field of ['cagr', 'max_drawdown']) {
    if (!(Math.abs(summary[field] - derived[field]) <= TOLERANCE)) problems.push({ field, stored: summary[field], derived: derived[field] });
  }
  for (const field of ['longest_underwater_sessions', 'recovered']) {
    if (summary[field] !== derived[field]) problems.push({ field, stored: summary[field], derived: derived[field] });
  }
  return { checked: true, reason: null, problems };
}

/** need() 用的文字：第一处不符。 */
function describe(problems) {
  const { field, stored, derived } = problems[0];
  const text = (v) => (typeof v === 'number' ? Number(v.toPrecision(9)) : v);
  return { field, detail: `文件 ${text(stored)}，由权益序列重算 ${text(derived)}` };
}

module.exports = { ANNUAL_FACTOR, TOLERANCE, summaryFromSeries, check, describe };
