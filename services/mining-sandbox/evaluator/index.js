'use strict';

/**
 * DSL 求值器（研究框架修订 2026-11-16 §3.2；P1）：在一个按时点截断好的面板上算一条已解析的公式（../dsl 的 parse 结果）。
 *
 * 面板：{ dates: [YYYY-MM-DD…]（升序）, codes: [标的…], readings: { 读数: number[日期][标的] }, industry?: string[日期][标的], size?: number[日期][标的] }。
 *   读数的值在交给求值器之前已经按各自的 PIT 可得时刻截断（A 股取 V6 特征库与 known-at 截断后的日线读数，§3.2）；求值器只往回看，不补值。
 * 每个算子都调用 ./operators.js 的同一份实现（因果证据也测这一份）。输出与面板同形：number[日期][标的]，缺值为 NaN。
 * 只算因子值；不读行情文件、不写台账、不调用模型接口、不打分（打分在挖掘段，留出段归 holdout-vault）。
 */
const ops = require('./operators');
const dsl = require('../dsl');

class EvalError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new EvalError(`MINE_EVAL_${code}`, detail); };

function checkPanel(p) {
  if (!p || !Array.isArray(p.dates) || !Array.isArray(p.codes) || !p.readings || typeof p.readings !== 'object') fail('PANEL_INVALID');
  for (let i = 1; i < p.dates.length; i += 1) if (!(p.dates[i - 1] < p.dates[i])) fail('PANEL_DATES_NOT_ASCENDING', p.dates[i]);
  const shapeOk = (m) => Array.isArray(m) && m.length === p.dates.length && m.every((row) => Array.isArray(row) && row.length === p.codes.length);
  for (const [k, m] of Object.entries(p.readings)) if (!shapeOk(m)) fail('PANEL_SHAPE', k);
  for (const k of ['industry', 'size']) if (p[k] !== undefined && !shapeOk(p[k])) fail('PANEL_SHAPE', k);
}

const byColumn = (m, f) => {
  const T = m.length; const N = T ? m[0].length : 0;
  const out = Array.from({ length: T }, () => new Array(N));
  for (let j = 0; j < N; j += 1) { const col = f(m.map((row) => row[j]), j); for (let t = 0; t < T; t += 1) out[t][j] = col[t]; }
  return out;
};

/**
 * @param {{tree: object}} parsed  ../dsl 的 parse 结果（必须先过解析与空间核对）
 * @param {object} panel
 * @returns {{dates: string[], codes: string[], values: number[][], canonical: string}}
 */
function evaluate(parsed, panel) {
  if (!parsed || !parsed.tree || typeof parsed.canonical !== 'string') fail('NOT_PARSED');
  checkPanel(panel);
  const T = panel.dates.length; const N = panel.codes.length;
  const filled = (v) => Array.from({ length: T }, () => new Array(N).fill(v));
  function ev(n) {
    if (n.op === 'reading') { const m = panel.readings[n.name]; if (!m) fail('READING_MISSING', n.name); return m; }
    if (n.op === 'const') return filled(n.value);
    if (Object.prototype.hasOwnProperty.call(ops.TIME_SERIES, n.op)) {
      const f = ops.TIME_SERIES[n.op];
      const win = n.args[n.args.length - 1].value;
      if (n.op === 'ts_corr') { const a = ev(n.args[0]); const b = ev(n.args[1]); return byColumn(a, (col, j) => f(col, b.map((row) => row[j]), win)); }
      return byColumn(ev(n.args[0]), (col) => f(col, win));
    }
    if (Object.prototype.hasOwnProperty.call(ops.CROSS_SECTION, n.op)) {
      const f = ops.CROSS_SECTION[n.op];
      const x = ev(n.args[0]);
      if (n.op === 'neutralize_industry') { if (!panel.industry) fail('INDUSTRY_MISSING'); return x.map((row, t) => f(row, panel.industry[t])); }
      if (n.op === 'neutralize_size') { if (!panel.size) fail('SIZE_MISSING'); return x.map((row, t) => f(row, panel.size[t])); }
      return x.map((row) => f(row));
    }
    const g = ops.ELEMENTWISE[n.op];
    if (!g) fail('OPERATOR_UNKNOWN', n.op);
    const args = n.args.map(ev);
    return args[0].map((row, t) => row.map((v, j) => g(v, args[1] ? args[1][t][j] : undefined)));
  }
  return { dates: [...panel.dates], codes: [...panel.codes], values: ev(parsed.tree), canonical: parsed.canonical };
}

/**
 * 打分之前的中性化（§3.6「先中性化」，§8.3 第 12 条；RF1116 修订「评分的市值中性化 V2」FREEZE_1 1aaf43e0 / 正文 f67701e9 §1 N1）。
 * 版本必须显式给（opts.neutralization），不设默认：不给 → MINE_EVAL_NEUTRALIZATION_REQUIRED；不认识 → MINE_EVAL_NEUTRALIZATION_UNKNOWN。
 *   LINEAR_RAW_V1（第 1、2 轮，冻结时的算法，输出逐字节不变）：每一天先减行业均值，再对 log 市值一元回归取残差（operators.js 的两个截面算子）。
 *   RANK_GAUSS_V2（新开的轮）：每一天，参与的名字 = 因子值有限、行业已知、total_mv 有限且 > 0（股票池由 scoring.scoringPanel 把池外的行业置空带进来）：
 *     1 g = Φ⁻¹((r + 0.5) / n)，r 是从 0 起的排名、并列取平均排名，n 是当天参与的名字数；
 *     2 减同一天同行业 g 的均值；
 *     3 对同一批名字的 total_mv 的排名高斯值做一元最小二乘，取残差（★S1 (a)）。参与的名字少于 3 → 当天全是 NaN。
 *   参考实现：evidence/rf1116-size-neutralization-v2-aqua-20261118/v2lib.js 的 v2Row（Acklam 反正态，T2 用它定的数）。
 * G-MINE 的「先中性化」只核戳里的 industry 与 size 两项；version、pre_transform、size_regressor 记做法。行业或市值缺失 → 拒绝，不跳过。
 */
const NEUTRALIZATIONS = Object.freeze({
  LINEAR_RAW_V1: Object.freeze({ industry: 'APPLIED', size: 'APPLIED', version: 'LINEAR_RAW_V1', pre_transform: 'NONE', size_regressor: 'LOG_TOTAL_MV' }),
  RANK_GAUSS_V2: Object.freeze({ industry: 'APPLIED', size: 'APPLIED', version: 'RANK_GAUSS_V2', pre_transform: 'RANK_GAUSS', size_regressor: 'RANK_GAUSS_TOTAL_MV' }),
});
const NEUTRALIZATION_VERSIONS = Object.freeze(Object.keys(NEUTRALIZATIONS));

/** Φ⁻¹(p)，0 < p < 1（Acklam 的有理逼近，与参考实现 v2lib.js 同一组系数）。 */
const ACKLAM = Object.freeze({
  a: [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00],
  b: [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01],
  c: [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00],
  d: [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00],
  low: 0.02425,
});
function invNorm(p) {
  const { a, b, c, d, low } = ACKLAM;
  if (p < low) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - low) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/** 排名高斯：从 0 起的平均排名 r → Φ⁻¹((r + 0.5) / n)。 */
function rankGauss(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const out = new Array(xs.length); const n = xs.length;
  for (let s = 0; s < idx.length;) {
    let e = s; while (e + 1 < idx.length && idx[e + 1][0] === idx[s][0]) e += 1;
    const g = invNorm(((s + e) / 2 + 0.5) / n);
    for (let k = s; k <= e; k += 1) out[idx[k][1]] = g;
    s = e + 1;
  }
  return out;
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** RANK_GAUSS_V2 的一天（见上）。 */
function rankGaussV2Row(values, industries, sizes) {
  const js = [];
  for (let j = 0; j < values.length; j += 1) if (isNum(values[j]) && typeof industries[j] === 'string' && industries[j] && isNum(sizes[j]) && sizes[j] > 0) js.push(j);
  const out = new Array(values.length).fill(NaN);
  if (js.length < 3) return out;
  const g = rankGauss(js.map((j) => values[j]));
  const groups = new Map();
  js.forEach((j, k) => { const key = industries[j]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(g[k]); });
  const mu = new Map([...groups].map(([k, v]) => [k, v.reduce((x, y) => x + y, 0) / v.length]));
  const y = js.map((j, k) => g[k] - mu.get(industries[j]));
  const x = rankGauss(js.map((j) => sizes[j]));
  const mx = x.reduce((p, q) => p + q, 0) / x.length; const my = y.reduce((p, q) => p + q, 0) / y.length;
  let sxx = 0; let sxy = 0;
  for (let k = 0; k < x.length; k += 1) { sxx += (x[k] - mx) ** 2; sxy += (x[k] - mx) * (y[k] - my); }
  const beta = sxx > 0 ? sxy / sxx : 0;
  js.forEach((j, k) => { out[j] = y[k] - (my + beta * (x[k] - mx)); });
  return out;
}

function neutralizeForScoring(result, panel, { neutralization } = {}) {
  if (neutralization === undefined || neutralization === null) fail('NEUTRALIZATION_REQUIRED');
  if (typeof neutralization !== 'string' || !Object.prototype.hasOwnProperty.call(NEUTRALIZATIONS, neutralization)) fail('NEUTRALIZATION_UNKNOWN', String(neutralization));
  if (!result || !Array.isArray(result.values)) fail('NOT_EVALUATED');
  if (!panel || !panel.industry) fail('INDUSTRY_MISSING');
  if (!panel.size) fail('SIZE_MISSING');
  const values = neutralization === 'LINEAR_RAW_V1'
    ? result.values.map((row, t) => ops.CROSS_SECTION.neutralize_size(ops.CROSS_SECTION.neutralize_industry(row, panel.industry[t]), panel.size[t]))
    : result.values.map((row, t) => rankGaussV2Row(row, panel.industry[t], panel.size[t]));
  return { ...result, values, neutralization: { ...NEUTRALIZATIONS[neutralization] } };
}

/** 解析 + 求值（space 是冻结的 MINING_SPACE_V1 的读数、常数、窗口）。 */
const run = (text, space, panel) => evaluate(dsl.parse(text, space), panel);

module.exports = { EvalError, evaluate, run, neutralizeForScoring, NEUTRALIZATIONS, NEUTRALIZATION_VERSIONS, internals: { invNorm, rankGauss, rankGaussV2Row } };
