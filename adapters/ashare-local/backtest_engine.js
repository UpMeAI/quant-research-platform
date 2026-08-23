'use strict';
/**
 * A 股本地信号层回测引擎 —— 迁移自 Ashare-V5 services/phase2/vpq_lab_engine(PG 版 → 文件 PIT 版)。
 *
 * 回测口径显式(与源仓一致):
 *   - GOOD 信号收盘进、持有 FWD_DAYS 个交易日收盘出,等权;
 *   - 单边成本 costPerSide(市场事实默认 0.1%)进出各计一次,均摊在持有期;
 *   - 无持仓日收益 0(现金);
 *   - PIT:逐 (标的, 日) 评测只用 ≤ 当日的 bar(量能基线/分位均如此);
 *   - 这是**信号层收益对比**,不是完整组合模拟(仓位/风控/Gate 归 Bundle 层与 Runtime)。
 */
const { FWD_DAYS, classifyPattern, variantJudge } = require('./strategy_vpq');
const market = require('./market_facts');

/**
 * 逐 (标的, 日) 对全部变体判 pattern(ratio/分位基线只算一次;PIT:只用 ≤ 当日 bar)。
 * @returns rows [{ inst, d, i, fwd, patterns: {variantKey: GOOD|BAD|NEUTRAL} }]
 */
function evaluateVariants(byInst, variants, { dateFrom = null, dateTo = null } = {}) {
  const rows = [];
  for (const [inst, series] of byInst) {
    for (let i = 60; i < series.length - FWD_DAYS; i++) {
      const d = series[i].d;
      if (dateFrom && d < dateFrom) continue;
      if (dateTo && d > dateTo) continue;
      const vols = series.slice(0, i + 1).map((b) => b.vol).filter((v) => Number.isFinite(v) && v > 0);
      if (vols.length < 60) continue;
      const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
      const ratio = avg(vols.slice(-5)) / avg(vols.slice(-60));
      const trailing = [];
      for (let j = Math.max(60, i - 59); j <= i; j++) {
        const w = series.slice(0, j + 1).map((b) => b.vol).filter((v) => Number.isFinite(v) && v > 0);
        if (w.length >= 60) trailing.push(avg(w.slice(-5)) / avg(w.slice(-60)));
      }
      if (trailing.length < 20) continue;
      const sorted = [...trailing].sort((a, b) => a - b);
      const patterns = {};
      for (const v of variants) patterns[v.key] = classifyPattern(series, i, variantJudge(v, ratio, sorted));
      rows.push({ inst, d, i, fwd: (series[i + FWD_DAYS].close - series[i].close) / series[i].close, patterns });
    }
  }
  return rows;
}

/** GOOD/BAD 信号精度(与 Race 同口径)。 */
function precision(rows, variantKey) {
  const good = rows.filter((r) => r.patterns[variantKey] === 'GOOD');
  const bad = rows.filter((r) => r.patterns[variantKey] === 'BAD');
  return {
    good_count: good.length, bad_count: bad.length,
    good_precision: good.length ? good.filter((r) => r.fwd > 0).length / good.length : null,
    bad_precision: bad.length ? bad.filter((r) => r.fwd < 0).length / bad.length : null,
    avg_fwd_on_good: good.length ? good.reduce((s, r) => s + r.fwd, 0) / good.length : null,
  };
}

/**
 * 信号层净值回测:GOOD 收盘进,FWD_DAYS 收盘出,等权,双边成本。
 * @returns { dates[], nav[], summary { cumRet, maxDrawdown, tradeCount, costPerSide } }
 */
function backtestCurve(byInst, rows, variantKey, { costPerSide = market.defaultCostPerSide } = {}) {
  const allDates = [...new Set([...byInst.values()].flatMap((s) => s.map((b) => b.d)))].sort();
  const active = new Map(); // date -> [{inst, holdDay, entryIdx}]
  let tradeCount = 0;
  for (const r of rows) {
    if (r.patterns[variantKey] !== 'GOOD') continue;
    tradeCount++;
    const series = byInst.get(r.inst);
    for (let k = 1; k <= FWD_DAYS; k++) {
      const dd = series[r.i + k].d;
      if (!active.has(dd)) active.set(dd, []);
      active.get(dd).push({ inst: r.inst, holdDay: k, entryIdx: r.i });
    }
  }
  const dates = []; const nav = [];
  let cur = 1;
  let peak = 1; let maxDD = 0;
  const roundTripCost = costPerSide * 2;
  for (const d of allDates) {
    const pos = active.get(d) || [];
    let dayRet = 0;
    if (pos.length) {
      let sum = 0;
      for (const p of pos) {
        const series = byInst.get(p.inst);
        const i = p.entryIdx + p.holdDay;
        const r = (series[i].close - series[i - 1].close) / series[i - 1].close;
        // 成本均摊在持有期(显式近似;逐日计权成本归 Bundle 层精算)
        sum += r - roundTripCost / FWD_DAYS;
      }
      dayRet = sum / pos.length;
    }
    cur *= 1 + dayRet;
    peak = Math.max(peak, cur);
    maxDD = Math.min(maxDD, cur / peak - 1);
    dates.push(d); nav.push(Number(cur.toFixed(6)));
  }
  return { dates, nav, summary: { cumRet: Number((cur - 1).toFixed(6)), maxDrawdown: Number(maxDD.toFixed(6)), tradeCount, costPerSide } };
}

/** 宽基基准净值(市场事实 benchmark),对齐给定 dates。bars 由调用方从 PIT 仓库取。 */
function benchmarkCurve(benchBars, dates) {
  const closeOf = new Map(benchBars.map((r) => [r.d, r.close]));
  const nav = []; let cur = 1; let prev = null;
  let peak = 1; let maxDD = 0;
  for (const d of dates) {
    const c = closeOf.get(d);
    if (c != null && prev != null) cur *= c / prev;
    if (c != null) prev = c;
    peak = Math.max(peak, cur); maxDD = Math.min(maxDD, cur / peak - 1);
    nav.push(Number(cur.toFixed(6)));
  }
  return { nav, summary: { cumRet: Number((cur - 1).toFixed(6)), maxDrawdown: Number(maxDD.toFixed(6)) } };
}

/** 分段(IS/OOS)累计收益。 */
function segStats(dates, nav, from, to) {
  let start = null; let end = null;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] >= from && start == null) start = i === 0 ? 1 : nav[i - 1];
    if (dates[i] <= to) end = nav[i];
  }
  if (start == null || end == null) return { cumRet: null };
  return { cumRet: Number((end / start - 1).toFixed(6)) };
}

module.exports = { evaluateVariants, precision, backtestCurve, benchmarkCurve, segStats, FWD_DAYS };
