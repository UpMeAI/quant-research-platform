'use strict';

/**
 * 白名单算子的实现（研究框架修订 2026-11-16 §3.2；P1）。只有一份实现：求值器（./index.js）按列、按行调用这里的一维函数；
 * 因果证据（docs/evidence/mining-operators-v1，tools/causality-harness，role FEATURE）调用同一批函数的「行」形入口（ROWS）。
 *
 *   时序（每个标的沿日期，窗口止于当天，只用当天及以前）：ts_mean、ts_std（样本标准差）、ts_delta、ts_rank（当天值在窗口里的分位，0–1）、ts_corr；
 *     窗口不满 n 个有效值时输出 NaN。
 *   截面（每一天跨标的，只用当天的值）：rank（分位 0–1，并列取平均名次）、zscore、按行业中性化（减行业均值）、按市值中性化（对 log 市值回归取残差）。
 *   逐元素：sign、abs、log（非正数 → NaN）；四则与一元负号（除数为 0 → NaN）。
 * 缺值一律是 NaN，只传播、不补。
 */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nan = (n) => new Array(n).fill(NaN);

// ── 时序：values 是一个标的按日期排好的数组 ─────────────────────────────

function window(values, i, n) {
  if (i + 1 < n) return null;
  const w = values.slice(i + 1 - n, i + 1);
  return w.every(isNum) ? w : null;
}
const mean = (w) => w.reduce((a, b) => a + b, 0) / w.length;
function std(w) { const m = mean(w); return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (w.length - 1)); }

const tsMean = (values, n) => values.map((_, i) => { const w = window(values, i, n); return w ? mean(w) : NaN; });
const tsStd = (values, n) => values.map((_, i) => { const w = window(values, i, n); return w ? std(w) : NaN; });
const tsDelta = (values, n) => values.map((v, i) => (i >= n && isNum(v) && isNum(values[i - n]) ? v - values[i - n] : NaN));
function tsRank(values, n) {
  return values.map((_, i) => {
    const w = window(values, i, n);
    if (!w) return NaN;
    const x = w[w.length - 1];
    const below = w.filter((v) => v < x).length; const same = w.filter((v) => v === x).length;
    return (below + (same - 1) / 2) / (n - 1);
  });
}
function tsCorr(x, y, n) {
  return x.map((_, i) => {
    const a = window(x, i, n); const b = window(y, i, n);
    if (!a || !b) return NaN;
    const ma = mean(a); const mb = mean(b);
    let sab = 0; let saa = 0; let sbb = 0;
    for (let k = 0; k < n; k += 1) { sab += (a[k] - ma) * (b[k] - mb); saa += (a[k] - ma) ** 2; sbb += (b[k] - mb) ** 2; }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
  });
}

// ── 截面：values 是同一天各标的的值 ─────────────────────────────────

function csRank(values) {
  const idx = values.map((v, i) => [v, i]).filter(([v]) => isNum(v)).sort((a, b) => a[0] - b[0]);
  const out = nan(values.length);
  if (idx.length < 2) return out;
  for (let s = 0; s < idx.length;) {
    let e = s; while (e + 1 < idx.length && idx[e + 1][0] === idx[s][0]) e += 1;
    const r = (s + e) / 2 / (idx.length - 1);
    for (let k = s; k <= e; k += 1) out[idx[k][1]] = r;
    s = e + 1;
  }
  return out;
}
function csZscore(values) {
  const w = values.filter(isNum);
  if (w.length < 2) return nan(values.length);
  const m = mean(w); const sd = std(w);
  return values.map((v) => (isNum(v) && sd > 0 ? (v - m) / sd : NaN));
}
/** 减去同一天同行业的均值（行业缺失 → NaN）。 */
function csNeutralizeIndustry(values, industries) {
  const groups = new Map();
  values.forEach((v, i) => { const g = industries[i]; if (isNum(v) && typeof g === 'string' && g) { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(v); } });
  return values.map((v, i) => { const g = groups.get(industries[i]); return isNum(v) && g ? v - mean(g) : NaN; });
}
/** 对同一天的 log 市值做一元回归，取残差（市值缺失或非正 → NaN）。 */
function csNeutralizeSize(values, sizes) {
  const pts = values.map((v, i) => [v, isNum(sizes[i]) && sizes[i] > 0 ? Math.log(sizes[i]) : NaN, i]).filter(([v, s]) => isNum(v) && isNum(s));
  const out = nan(values.length);
  if (pts.length < 3) return out;
  const my = mean(pts.map((p) => p[0])); const mx = mean(pts.map((p) => p[1]));
  const sxx = pts.reduce((a, p) => a + (p[1] - mx) ** 2, 0);
  const beta = sxx > 0 ? pts.reduce((a, p) => a + (p[1] - mx) * (p[0] - my), 0) / sxx : 0;
  for (const [v, s, i] of pts) out[i] = v - (my + beta * (s - mx));
  return out;
}

// ── 逐元素 ─────────────────────────────────────────────────────

const ELEMENTWISE = Object.freeze({
  sign: (a) => (isNum(a) ? Math.sign(a) : NaN),
  abs: (a) => (isNum(a) ? Math.abs(a) : NaN),
  log: (a) => (isNum(a) && a > 0 ? Math.log(a) : NaN),
  neg: (a) => (isNum(a) ? -a : NaN),
  add: (a, b) => (isNum(a) && isNum(b) ? a + b : NaN),
  sub: (a, b) => (isNum(a) && isNum(b) ? a - b : NaN),
  mul: (a, b) => (isNum(a) && isNum(b) ? a * b : NaN),
  div: (a, b) => (isNum(a) && isNum(b) && b !== 0 ? a / b : NaN),
});

const TIME_SERIES = Object.freeze({ ts_mean: tsMean, ts_std: tsStd, ts_delta: tsDelta, ts_rank: tsRank, ts_corr: tsCorr });
const CROSS_SECTION = Object.freeze({ rank: csRank, zscore: csZscore, neutralize_industry: csNeutralizeIndustry, neutralize_size: csNeutralizeSize });

/**
 * 「行」形入口（给 tools/causality-harness 调，output.align ALIGNED / KEYED）：
 *   时序：f(rows, n)，rows = 一个标的按日期排好的 [{ date, value[, y] }]，返回与 rows 逐行对齐的数组；
 *   截面：f(rows)，rows = [{ date, code, value[, industry][, size] }]，返回 [{ date, code, value }]（每一天一组）。
 */
function byDate(rows) { const m = new Map(); for (const r of rows) { if (!m.has(r.date)) m.set(r.date, []); m.get(r.date).push(r); } return m; }
function crossSectionRows(fn, extra) {
  return (rows) => {
    const out = [];
    for (const [date, day] of byDate(rows)) {
      const vals = fn(day.map((r) => r.value), ...(extra ? [day.map((r) => r[extra])] : []));
      day.forEach((r, i) => out.push({ date, code: r.code, value: vals[i] }));
    }
    return out;
  };
}
const ROWS = Object.freeze({
  ts_mean: (rows, n) => tsMean(rows.map((r) => r.value), n),
  ts_std: (rows, n) => tsStd(rows.map((r) => r.value), n),
  ts_delta: (rows, n) => tsDelta(rows.map((r) => r.value), n),
  ts_rank: (rows, n) => tsRank(rows.map((r) => r.value), n),
  ts_corr: (rows, n) => tsCorr(rows.map((r) => r.value), rows.map((r) => r.y), n),
  rank: crossSectionRows(csRank),
  zscore: crossSectionRows(csZscore),
  neutralize_industry: crossSectionRows(csNeutralizeIndustry, 'industry'),
  neutralize_size: crossSectionRows(csNeutralizeSize, 'size'),
  sign: (rows) => rows.map((r) => ELEMENTWISE.sign(r.value)),
  abs: (rows) => rows.map((r) => ELEMENTWISE.abs(r.value)),
  log: (rows) => rows.map((r) => ELEMENTWISE.log(r.value)),
});

module.exports = { TIME_SERIES, CROSS_SECTION, ELEMENTWISE, ROWS, internals: { window, mean, std } };
