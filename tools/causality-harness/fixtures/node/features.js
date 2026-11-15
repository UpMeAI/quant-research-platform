'use strict';

/**
 * 合成夹具（修订草稿 §3.3「必须失败的夹具」）：每项测试一对，红的故意不因果，绿的是同一读数的因果写法。
 * 只用合成数据（../data），不含任何生产公式、参数或真实行情。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

// ── T-C1：草稿点名的两个必须失败的夹具 ─────────────────────────────────────────

/** 红：参与率 = 当日到此刻的累计成交量 / 当日全天成交量（全天分母）。 */
function participationFullDay(minutes) {
  const total = new Map();
  for (const m of minutes) total.set(m.day, (total.get(m.day) || 0) + m.volume);
  const cum = new Map();
  return minutes.map((m) => { cum.set(m.day, (cum.get(m.day) || 0) + m.volume); return cum.get(m.day) / total.get(m.day); });
}

/** 绿：当日到此刻的累计成交量 / 前 3 个已收完交易日的平均全天量。 */
function participationPriorDays(minutes) {
  const done = [];
  let day = null; let cum = 0;
  return minutes.map((m) => {
    if (m.day !== day) { if (day !== null) done.push(cum); day = m.day; cum = 0; }
    cum += m.volume;
    const prev = done.slice(-3);
    return prev.length < 3 ? null : cum / (prev.reduce((a, b) => a + b, 0) / 3);
  });
}

/** 红：顶分型记在顶那根 K 线上，要靠下一根确认（事后确认的分型）。 */
function fractalAtPeak(bars) {
  return bars.map((b, i) => i > 0 && i + 1 < bars.length && b.high > bars[i - 1].high && b.high > bars[i + 1].high);
}

/** 绿：同一个分型，记在确认它的那根 K 线上。 */
function fractalAtConfirmation(bars) {
  return bars.map((b, i) => i > 1 && bars[i - 1].high > bars[i - 2].high && bars[i - 1].high > b.high);
}

// ── T-C2：截断看不出、换掉未来才看得出 ──────────────────────────────────────────

/** 红：下一根的方向；最后一根退回本根阴阳。单边上涨、根根收阳的夹具上两者一致，T-C1 看不出。 */
function nextBarDirectionWithFallback(bars) {
  return bars.map((b, i) => (bars[i + 1] ? Math.sign(bars[i + 1].close - b.close) : Math.sign(b.close - b.open)));
}

/** 绿：上一根到这一根的方向。 */
function priorBarDirection(bars) {
  return bars.map((b, i) => (i > 0 ? Math.sign(b.close - bars[i - 1].close) : Math.sign(b.close - b.open)));
}

// ── T-C3：绕过给定输入 ──────────────────────────────────────────────────────────

const expandingMean = (bars) => { let s = 0; return bars.map((b, i) => { s += b.close; return s / (i + 1); }); };

/** 红：先试夹具目录外的「全量历史缓存」和数据库端口，吞掉错误再退回只用给定输入。读数本身因果，T-C1、T-C2 都过。 */
function expandingMeanWithCache(bars) {
  try { JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'outside', 'full_history.json'), 'utf8')); } catch { /* 退回 */ }
  try { const s = net.connect(5432, '127.0.0.1'); s.on('error', () => {}); s.destroy(); } catch { /* 退回 */ }
  return expandingMean(bars);
}

/** 绿：从夹具目录读一个静态参数（允许），别的都不读。 */
function expandingMeanFixtureParams(bars) {
  const { scale } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'params.json'), 'utf8'));
  return expandingMean(bars).map((v) => v * scale);
}

// ── 逐时点（AT_POINT）与面板（KEYED） ─────────────────────────────────────────

/** 红：居中 5 日均线（读 t+1、t+2）。 */
function centeredMeanAt(bars, t) {
  const w = bars.slice(Math.max(0, t - 2), t + 3);
  return w.reduce((a, b) => a + b.close, 0) / w.length;
}

/** 绿：截至 t 的 5 日均线。 */
function trailingMeanAt(bars, t) {
  const w = bars.slice(Math.max(0, t - 4), t + 1);
  return w.reduce((a, b) => a + b.close, 0) / w.length;
}

/** 红：横截面排序前先用全样本均值归一化（全样本归一化）。 */
function rankByFullSampleZ(panel) {
  const mean = new Map(); const n = new Map();
  for (const r of panel) { mean.set(r.code, (mean.get(r.code) || 0) + r.close); n.set(r.code, (n.get(r.code) || 0) + 1); }
  return rankWithin(panel, (r) => r.close / (mean.get(r.code) / n.get(r.code)));
}

/** 绿：同日横截面，按当日相对前一日的涨幅排序。 */
function rankByDailyReturn(panel) {
  const last = new Map();
  return rankWithin(panel, (r) => { const p = last.get(r.code); last.set(r.code, r.close); return p ? r.close / p - 1 : 0; });
}

function rankWithin(panel, score) {
  const byDate = new Map();
  for (const r of panel) { const s = score(r); if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push({ code: r.code, s }); }
  const out = [];
  for (const [date, rows] of byDate) {
    rows.sort((a, b) => b.s - a.s || (a.code < b.code ? -1 : 1));
    rows.forEach((x, i) => out.push({ date, code: x.code, rank: i + 1 }));
  }
  return out;
}

// ── 隔离：跨调用的缓存 ──────────────────────────────────────────────────────────

const memo = new Map();
/** 红（隔离）：居中 5 日均线，按日期记在模块里。各次调用若共用模块状态，前缀调用读到的是整段调用留下的值，T-C1 就看不出。 */
function memoCenteredMean(bars) {
  return bars.map((b, i) => {
    if (!memo.has(b.date)) { const w = bars.slice(Math.max(0, i - 2), i + 3); memo.set(b.date, w.reduce((a, x) => a + x.close, 0) / w.length); }
    return memo.get(b.date);
  });
}

/** 红（隔离）：同上，记在全局变量上。 */
function globalMemoCenteredMean(bars) {
  if (!globalThis.__causalityFixtureMemo) globalThis.__causalityFixtureMemo = new Map();
  const m = globalThis.__causalityFixtureMemo;
  return bars.map((b, i) => {
    if (!m.has(b.date)) { const w = bars.slice(Math.max(0, i - 2), i + 3); m.set(b.date, w.reduce((a, x) => a + x.close, 0) / w.length); }
    return m.get(b.date);
  });
}

module.exports = {
  memoCenteredMean, globalMemoCenteredMean,
  participationFullDay, participationPriorDays, fractalAtPeak, fractalAtConfirmation, nextBarDirectionWithFallback, priorBarDirection,
  expandingMeanWithCache, expandingMeanFixtureParams, centeredMeanAt, trailingMeanAt, rankByFullSampleZ, rankByDailyReturn,
};
