'use strict';

// metric-reference -- the executable reading of docs/contracts/METRIC_DEFINITIONS_V1.draft.md.
//
// Test support only. No production file requires it: a value has one producer (the book's exporter, or the QRP baseline
// evaluation), and this file exists so that the producers can be held to one number on a fixed input. It is written to be
// read next to the contract, section by section, and to reproduce the sealed US_V5_M2 Q1/Q2 summaries (cagr, max_drawdown,
// longest_underwater_sessions, recovered, g and its 95% interval) bit for bit -- see the evidence note.
//
// Pure functions, float64, no rounding inside. Rounding is the exporter's, six decimals, at the file boundary (§10).

const MARKETS = Object.freeze(['CN', 'US', 'CRYPTO']);

/** §2 sample floors. Below them a ratio is INSUFFICIENT_SAMPLE, never a number. */
const MIN_RETURNS_FOR_RATIO = 20;
const MIN_BLOCKS_FOR_INTERVAL = 2;

/** §7 frozen constants of the paired g interval. */
const BOOTSTRAP = Object.freeze({ resamples: 10000, seed: 20261025, lowerRank: 0.025, upperRank: 0.975 });

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** mulberry32: the PRNG every frozen bootstrap in the system uses (smartflow replay-us-v5-holding-swap.js `rng`). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * §3 The series. `marks` has one entry per clock session, in order. A mark is MEASURED when it carries a finite positive
 * equity. Anything else is a gap: it is never carried forward and never zero (§9).
 * NAV_k = equity_k / capital0; the base (capital0, NAV 1) precedes mark 0 and is itself a measured point.
 */
function navPoints(series) {
  return series.marks.map((mark) => {
    const measured = mark.state === 'MEASURED' && finite(mark.equity) && mark.equity > 0;
    return { day: mark.day, measured, nav: measured ? mark.equity / series.capital0 : null };
  });
}

/** §4 The return sample: one simple return per pair of consecutive measured points (the base counts as measured). */
function returnSample(points) {
  const returns = [];
  let prev = 1;
  let prevMeasured = true;
  for (const point of points) {
    if (point.measured && prevMeasured) returns.push(point.nav / prev - 1);
    prev = point.measured ? point.nav : prev;
    prevMeasured = point.measured;
  }
  return returns;
}

const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
const sampleSd = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) * (v - m), 0) / (xs.length - 1));
};

/** §6 Drawdown and §8 underwater, from the base: peak starts at NAV 1 (the capital the book began with). */
function pathOf(points) {
  let peak = 1;
  let maxDrawdown = 0;
  let maxFall = 0;
  let run = 0;
  let longestUnderwater = 0;
  let inEpisode = false;
  let lastMeasured = null;
  const drawdowns = [];
  for (const point of points) {
    if (!point.measured) {
      // A gap neither opens nor closes an episode; inside one it is a session still under water.
      if (inEpisode) run += 1;
      drawdowns.push(null);
      continue;
    }
    if (point.nav >= peak) {
      peak = point.nav;
      longestUnderwater = Math.max(longestUnderwater, run);
      run = 0;
      inEpisode = false;
    } else {
      run += 1;
      inEpisode = true;
    }
    const dd = 1 - point.nav / peak;
    maxDrawdown = Math.max(maxDrawdown, dd);
    maxFall = Math.max(maxFall, peak - point.nav);
    drawdowns.push(dd);
    lastMeasured = point;
  }
  // An episode still open at the last measured mark counts to that mark; sessions after it were never observed.
  const trailing = trailingGapCount(points);
  if (inEpisode) run -= trailing;
  longestUnderwater = Math.max(longestUnderwater, run);
  return { maxDrawdown, maxFall, drawdowns, longestUnderwater, recovered: lastMeasured ? !inEpisode : null, lastMeasured, peak };
}

function trailingGapCount(points) {
  let n = 0;
  for (let i = points.length - 1; i >= 0 && !points[i].measured; i -= 1) n += 1;
  return n;
}

/** §2 to §8 for one book series. */
function seriesMetrics(series) {
  const A = series.annualFactor;
  const points = navPoints(series);
  const returns = returnSample(points);
  const path = pathOf(points);
  const measuredCount = points.filter((p) => p.measured).length;
  const out = {
    marks: points.length,
    measuredMarks: measuredCount,
    gapMarks: points.length - measuredCount,
    returnsUsed: returns.length,
    returnsExcluded: points.length - returns.length,
    zeroReturnDays: returns.filter((r) => r === 0).length,
  };
  if (!path.lastMeasured) {
    return { ...out, state: 'NO_MEASURED_MARK', totalReturn: null, cagr: null, annualVol: null, sharpe: null, maxDrawdown: null, maxDrawdownMoney: null, calmar: null,
      longestUnderwaterSessions: null, recovered: null, drawdowns: path.drawdowns };
  }
  // T: sessions from the base to the last measured mark, gaps inside counted (§5).
  const T = points.indexOf(path.lastMeasured) + 1;
  const last = path.lastMeasured.nav;
  const cagr = last > 0 ? Math.pow(last, A / T) - 1 : null;
  const enough = returns.length >= MIN_RETURNS_FOR_RATIO;
  const sd = returns.length > 1 ? sampleSd(returns) : null;
  const annualVol = enough && sd !== null ? sd * Math.sqrt(A) : null;
  const sharpe = enough && sd !== null && sd > 0 ? (mean(returns) / sd) * Math.sqrt(A) : null;
  return {
    ...out,
    state: enough ? 'MEASURED' : 'INSUFFICIENT_SAMPLE',
    sessionsSpanned: T,
    totalReturn: last - 1,
    cagr,
    annualVol,
    sharpe,
    maxDrawdown: path.maxDrawdown,
    maxDrawdownMoney: path.maxFall * series.capital0,
    calmar: cagr !== null && path.maxDrawdown > 0 ? cagr / path.maxDrawdown : null,
    longestUnderwaterSessions: path.longestUnderwater,
    recovered: path.recovered,
    drawdowns: path.drawdowns,
  };
}

/** §9 cost totals: the sum of the costs that are known; an unknown cost is counted, never added as 0. */
function costTotals(costs) {
  let known = 0;
  let unknown = 0;
  for (const cost of costs) {
    if (finite(cost)) known += cost; else unknown += 1;
  }
  return { knownSum: known, unknownDays: unknown, state: unknown === 0 ? 'COMPLETE' : 'PARTIAL', total: unknown === 0 ? known : null };
}

/**
 * §7 Paired g on the common marks of two arms that share a clock. Periods run between consecutive common measured points
 * (the base is common); a period that spans k > 1 sessions carries k, so g = A * sum(x) / sum(k) and a gap-free pair is
 * A * mean(x). Blocks are calendar months of the period's end day, in order of first appearance.
 */
function pairedG(candidate, baseline, annualFactor, options = {}) {
  const { resamples, seed, lowerRank, upperRank } = { ...BOOTSTRAP, ...options };
  const c = navPoints(candidate);
  const b = navPoints(baseline);
  const periods = [];
  let prevC = 1; let prevB = 1; let prevIdx = -1;
  for (let i = 0; i < c.length; i += 1) {
    if (!(c[i].measured && b[i].measured)) continue;
    periods.push({ month: c[i].day.slice(0, 7), x: Math.log(c[i].nav / prevC) - Math.log(b[i].nav / prevB), k: i - prevIdx });
    prevC = c[i].nav; prevB = b[i].nav; prevIdx = i;
  }
  if (!periods.length) return { state: 'NO_COMMON_MARK', g: null, ci95: null, periods: 0, sessions: 0, months: 0 };
  const sumX = periods.reduce((s, p) => s + p.x, 0);
  const sumK = periods.reduce((s, p) => s + p.k, 0);
  const g = annualFactor * (sumX / sumK);
  const order = []; const byMonth = new Map();
  for (const p of periods) {
    if (!byMonth.has(p.month)) { byMonth.set(p.month, { x: 0, k: 0 }); order.push(p.month); }
    const block = byMonth.get(p.month); block.x += p.x; block.k += p.k;
  }
  const blocks = order.map((m) => byMonth.get(m));
  const base = { g, periods: periods.length, sessions: sumK, months: blocks.length };
  if (blocks.length < MIN_BLOCKS_FOR_INTERVAL) return { ...base, state: 'INSUFFICIENT_BLOCKS', ci95: null };
  const rand = mulberry32(seed);
  const K = blocks.length;
  const draws = new Array(resamples);
  for (let r = 0; r < resamples; r += 1) {
    let x = 0; let k = 0;
    for (let j = 0; j < K; j += 1) { const block = blocks[Math.floor(rand() * K)]; x += block.x; k += block.k; }
    draws[r] = annualFactor * (x / k);
  }
  draws.sort((p, q) => p - q);
  const at = (rank) => draws[Math.min(draws.length - 1, Math.floor(rank * draws.length))];
  return { ...base, state: 'MEASURED', ci95: [at(lowerRank), at(upperRank)] };
}

module.exports = { MARKETS, BOOTSTRAP, MIN_RETURNS_FOR_RATIO, MIN_BLOCKS_FOR_INTERVAL, mulberry32, navPoints, returnSample, seriesMetrics, costTotals, pairedG };
