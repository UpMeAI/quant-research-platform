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
 * 打分之前的中性化（§3.6「先中性化」，§8.3 第 12 条）：每一天先减行业均值，再对 log 市值回归取残差。G-MINE 的 IC 类读数只认带
 * neutralization { industry: 'APPLIED', size: 'APPLIED' } 的结果（services/mining-gate 的 NEUTRALIZED）。行业或市值缺失 → 拒绝，不跳过。
 */
function neutralizeForScoring(result, panel) {
  if (!result || !Array.isArray(result.values)) fail('NOT_EVALUATED');
  if (!panel || !panel.industry) fail('INDUSTRY_MISSING');
  if (!panel.size) fail('SIZE_MISSING');
  const values = result.values.map((row, t) => ops.CROSS_SECTION.neutralize_size(ops.CROSS_SECTION.neutralize_industry(row, panel.industry[t]), panel.size[t]));
  return { ...result, values, neutralization: { industry: 'APPLIED', size: 'APPLIED' } };
}

/** 解析 + 求值（space 是冻结的 MINING_SPACE_V1 的读数、常数、窗口）。 */
const run = (text, space, panel) => evaluate(dsl.parse(text, space), panel);

module.exports = { EvalError, evaluate, run, neutralizeForScoring };
