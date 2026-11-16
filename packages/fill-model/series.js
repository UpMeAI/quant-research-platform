'use strict';

/**
 * 十二条规则沿时间序列的用法（G-CAUSAL 的 T-C1 / T-C2 按它跑，证据 role: FILL；引擎回放也可以照这个样子逐行调用规则）。
 *
 * 每个函数收一条按时间升序的序列，返回与它逐行对齐的读数：第 j 行的读数只用第 0…j 行（行的可得时点 = 字段 time 或 date 的那一刻）。
 * 一行算不出时记 { error: <码> }，不抛错（一行的坏数据不能连带别的行）。参数是写死的合成值，只为证明规则不读未来。
 *   分钟线 minutes：[{ time: 这根 1 分钟线的结束时刻（ISO，带时区）, open, high, low, close, volume }]
 *   日线 daily：[{ date: YYYY-MM-DD, open, high, low, close, volume }]
 *   成交 ticks：[{ time: 成交时刻（ISO，带时区）, price }]
 */
const fm = require('./index');

const MINUTE_MS = fm.MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const endMs = (row) => Date.parse(row.time);
const minuteBar = (row) => ({ startMs: endMs(row) - MINUTE_MS, open: row.open, high: row.high, low: row.low, close: row.close });
const each = (rows, fn) => rows.map((_, j) => { try { return fn(j); } catch (e) { return { error: e.code || 'ERROR' }; } });
/** 一行所在的上海交易日的某个时刻（毫秒）。 */
const cnAt = (row, hhmm) => Date.parse(`${row.time.slice(0, 10)}T${hhmm}:00+08:00`);

/** 第 j 天按第 j 天的开盘价 +10 bp 买（第 j − 1 天收盘后定的计划），价位 0.001 不利对齐。 */
const NEXT_OPEN = (daily) => each(daily, (j) => (j === 0 ? null : fm.NEXT_OPEN({ nextOpen: daily[j].open, slippageBps: 10, side: 'BUY', tick: 0.001 })));

/** 止损价 = 前一天的最低价；第 j 天开盘已经跌穿的按开盘价成交。 */
const GAP_THROUGH_LEVEL_AT_OPEN = (daily) => each(daily, (j) => {
  if (j === 0) return null;
  const r = fm.GAP_THROUGH_LEVEL_AT_OPEN({ level: daily[j - 1].low, open: daily[j].open, direction: 'DOWN' });
  return r.filled ? r.price : null;
});

/** 多头：止损 = 上一分钟收盘 × 0.998，止盈 × 1.002；这一分钟两个都碰到判止损。 */
const SAME_BAR_STOP_FIRST = (minutes) => each(minutes, (j) => (j === 0 ? null
  : fm.SAME_BAR_STOP_FIRST({ high: minutes[j].high, low: minutes[j].low, stop: minutes[j - 1].close * 0.998, target: minutes[j - 1].close * 1.002, position: 'LONG' })));

/** 买入限价 = 上一分钟收盘 − 0.01，最小价位 0.01；这一分钟要越过一个价位才成交。 */
const LIMIT_CROSS_ONE_TICK = (minutes) => each(minutes, (j) => {
  if (j === 0) return null;
  const limit = Number((Math.round(minutes[j - 1].close * 100) / 100 - 0.01).toFixed(2));
  const r = fm.LIMIT_CROSS_ONE_TICK({ limit, tick: 0.01, high: minutes[j].high, low: minutes[j].low, side: 'BUY' });
  return r.filled ? r.price : null;
});

/** 第 j 天想成交 500,000 股（每手 100），上限 = 第 j − 1 天成交量 × 0.1；第 0 天读不到前一天量就不成交。 */
const PREV_DAY_VOLUME_CAP = (daily) => each(daily, (j) => fm.PREV_DAY_VOLUME_CAP({ prevDayVolume: j === 0 ? undefined : daily[j - 1].volume, desired: 500000, lotSize: 100 }));

/** 卖出价位 = 上一分钟收盘 × 0.999；这一分钟碰到就按这一分钟收盘价 −10 bp 成交。 */
const TOUCH_MINUTE_CLOSE = (minutes) => each(minutes, (j) => (j > 0 && minutes[j].low <= minutes[j - 1].close * 0.999
  ? fm.TOUCH_MINUTE_CLOSE({ minuteClose: minutes[j].close, slippageBps: 10, side: 'SELL' }) : null));

/** 每笔成交时按最新成交价 +5 bp 买（扫描时刻 = 这笔成交的时刻）。 */
const TICKER_LAST_PLUS_SLIPPAGE = (ticks) => each(ticks, (j) => fm.TICKER_LAST_PLUS_SLIPPAGE({ last: ticks[j].price, slippageBps: 5, side: 'BUY' }));

/**
 * 第 k − 2 分钟收完时低于上一分钟收盘 × 0.999 → 轮询在第 k − 1 分钟开始后 1 秒发现、随即发市价单 → 按其后第一根（第 k 根）的开盘价 +5 bp 成交。
 * 读数对齐到成交那一分钟。
 */
const MARKET_AFTER_POLL = (minutes) => each(minutes, (k) => {
  if (k < 3 || !(minutes[k - 2].low <= minutes[k - 3].close * 0.999)) return null;
  const r = fm.MARKET_AFTER_POLL({ pollAtMs: minuteBar(minutes[k - 1]).startMs + 1000, minuteBars: minutes.slice(0, k + 1).map(minuteBar), slippageBps: 5, side: 'BUY' });
  return r.filled ? r.price : null;
});

/** 多头止损 = 第 0 分钟开盘 × 0.995；第一根低价碰到它的分钟收完时触发，按 2% / 60 秒、4% / 300 秒、市价分级平仓。读数只看到第 j 分钟为止。 */
const TIERED_LIMIT_STOP = (minutes) => each(minutes, (j) => {
  const seen = minutes.slice(0, j + 1);
  const triggerPrice = minutes[0].open * 0.995;
  const hit = seen.findIndex((m) => m.low <= triggerPrice);
  if (hit < 0) return null;
  const r = fm.TIERED_LIMIT_STOP({ triggerPrice, triggerAtMs: endMs(seen[hit]), side: 'SELL', minuteBars: seen.map(minuteBar) });
  return r.filled ? { tier: r.tier, price: r.price } : null;
});

/** 上海交易时段内每 60 秒轮询一次；第 j 笔成交时，读数 = 不晚于它的最后一次轮询看到的价格（两次轮询之间先碰到又回来的看不到）。 */
const POLL_EVERY = (ticks) => each(ticks, (j) => {
  const t = endMs(ticks[j]);
  const polls = fm.POLL_EVERY({ windows: [{ startMs: cnAt(ticks[j], '09:30'), endMs: cnAt(ticks[j], '11:30') }, { startMs: cnAt(ticks[j], '13:00'), endMs: cnAt(ticks[j], '15:00') }], intervalMs: MINUTE_MS });
  const last = polls.filter((p) => p <= t).pop();
  if (last === undefined) return null;
  return fm.priceAtPoll(ticks.slice(0, j + 1).map((x) => ({ atMs: endMs(x), price: x.price })), last);
});

/** 第 j 分钟收完时轮询，重建正在形成的 1 小时线（对齐到每小时的 :30），只用到第 j 分钟为止的分钟线。 */
const FORMING_BAR_AS_OF_POLL = (minutes) => each(minutes, (j) => fm.FORMING_BAR_AS_OF_POLL({ minuteBars: minutes.slice(0, j + 1).map(minuteBar), pollAtMs: endMs(minutes[j]), barIntervalMs: HOUR_MS, anchorMs: 30 * MINUTE_MS }));

/** 上海时段 09:30–15:00 的 COMPLETED_1H 节奏（:31 分）；第 j 分钟收完时的读数 = 此前最近一轮的时刻、种类和它读到的那根 1 小时线的收盘价。 */
const SCAN_SCHEDULE = (minutes) => each(minutes, (j) => {
  const t = endMs(minutes[j]);
  const rounds = fm.SCAN_SCHEDULE({ kind: 'COMPLETED_1H', openMs: cnAt(minutes[j], '09:30'), closeMs: cnAt(minutes[j], '15:00') }).filter((r) => r.atMs <= t);
  const round = rounds.pop();
  if (!round) return null;
  if (round.kind !== 'EXECUTING') return { atMs: round.atMs, kind: round.kind };
  const lastMinute = minutes.slice(0, j + 1).filter((m) => endMs(m) <= round.barEndMs).pop();
  return { atMs: round.atMs, kind: round.kind, barClose: lastMinute ? lastMinute.close : null };
});

module.exports = {
  NEXT_OPEN, GAP_THROUGH_LEVEL_AT_OPEN, SAME_BAR_STOP_FIRST, LIMIT_CROSS_ONE_TICK, PREV_DAY_VOLUME_CAP, TOUCH_MINUTE_CLOSE, TICKER_LAST_PLUS_SLIPPAGE,
  MARKET_AFTER_POLL, TIERED_LIMIT_STOP, POLL_EVERY, FORMING_BAR_AS_OF_POLL, SCAN_SCHEDULE,
};
