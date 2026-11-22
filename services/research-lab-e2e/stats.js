'use strict';

/**
 * Small deterministic statistics for the W24b producers: paired daily series from the replay output, month-block 95% intervals (Student t on the monthly means, the same
 * method as the S2 adapter), CVaR5. Nothing a service already computes is recomputed here; the verdict is always the engine's.
 */
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045];
const DAYS_PER_YEAR = 252;
const tOf = (df) => (df < 1 ? Infinity : df <= T975.length ? T975[df - 1] : 2.0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

/** [{date, v}] -> month means in date order. */
function monthly(series) {
  const by = new Map();
  for (const { date, v } of series) { const k = date.slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(v); }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, vs]) => ({ month, mean: mean(vs), days: vs.length }));
}

/** Annualised mean of a daily series with a 95% interval from the month blocks. */
function annualCi(series) {
  const est = mean(series.map((x) => x.v)) * DAYS_PER_YEAR;
  const m = monthly(series);
  const se = m.length >= 2 ? (sd(m.map((x) => x.mean)) / Math.sqrt(m.length)) * DAYS_PER_YEAR : 0;
  const half = m.length >= 2 ? tOf(m.length - 1) * se : 0;
  return { estimate: est, ci: { lower: est - half, upper: est + half, level: 0.95 }, months: m.length, n: series.length };
}

/** Mean of the worst ceil(5%) values. */
function cvar5(values) {
  const s = [...values].sort((a, b) => a - b);
  const k = Math.max(1, Math.ceil(0.05 * s.length));
  return mean(s.slice(0, k));
}

/** Paired net difference A - B with every cost scaled by `mult`; null when the dates are not aligned. */
function paired(a, b, mult = 1) {
  if (a.length !== b.length || a.some((x, i) => x.date !== b[i].date)) return null;
  return a.map((x, i) => ({ date: x.date, v: (x.gross - mult * x.cost) - (b[i].gross - mult * b[i].cost) }));
}

const corr = (x, y) => {
  const mx = mean(x); const my = mean(y);
  const sxy = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  const sx = Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0)); const sy = Math.sqrt(y.reduce((s, v) => s + (v - my) ** 2, 0));
  return sx > 0 && sy > 0 ? sxy / (sx * sy) : 0;
};

module.exports = { DAYS_PER_YEAR, T975, tOf, mean, sd, monthly, annualCi, cvar5, paired, corr };
