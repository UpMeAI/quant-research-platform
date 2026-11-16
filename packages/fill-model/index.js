'use strict';

/**
 * 统一成交模型库 FILL_MODEL_LIBRARY_V1 —— 引擎建模验收合同 ENGINE_MODELING_ACCEPTANCE_V1 §2.2（Owner 2026-11-17 00:15 签字，
 * 签字文本 8d214ddf，签字页 d1d61283），实施规格 FILL_MODEL_LIBRARY_V1_SPEC（90814c60）§2。合同 docs/contracts/FILL_MODEL_LIBRARY_V1.md。
 *
 * 十二条规则，全部是纯函数：输入只到决策时刻 t 为止，不读 t 之后的任何数据，也不读当天的汇总量；不读行情、不写文件、没有依赖。
 * 时间一律是毫秒数（调用方换算时区），不读宿主时钟。价格方向：BUY 加滑点、SELL 减滑点；按最小价位对齐时，对齐方向不利于自己。
 * 这一份是唯一的源码：V6 与 smartflow 原样拷到 vendor/fill-model/（tools/fill-model-vendor），按 PIN.json 钉住。
 */

const MINUTE_MS = 60000;
const SIDES = Object.freeze(['BUY', 'SELL']);
const DIRECTIONS = Object.freeze(['DOWN', 'UP']);
const POSITIONS = Object.freeze(['LONG', 'SHORT']);
/** TIERED_LIMIT_STOP 的默认档位：2% 挂 60 秒，再 4% 挂 300 秒，再市价（smartflow touch-exit-policy.js:41–42，声明的锁定测试核对）。 */
const DEFAULT_TIERS = Object.freeze({ t1Pct: 2, t1TimeoutS: 60, t2Pct: 4, t2TimeoutS: 300 });
/** PREV_DAY_VOLUME_CAP 的默认参与率（附录 1 §3 的 10% 量上限）。 */
const DEFAULT_PARTICIPATION = 0.1;

class FillModelError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new FillModelError(`FILL_MODEL_${code}`, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (v) => isNum(v) && v > 0;
const isNonNeg = (v) => isNum(v) && v >= 0;

/** 最小价位的小数位数（0.01 → 2，0.001 → 3，1 → 0）。 */
function tickDecimals(tick) {
  const s = String(tick);
  const e = /e-(\d+)$/.exec(s);
  if (e) return Number(e[1]);
  return s.includes('.') ? s.split('.')[1].length : 0;
}
/** 按最小价位对齐，方向不利于自己：BUY 向上取整，SELL 向下取整。 */
function alignToTick(price, tick, side) {
  need(isPos(price) && isPos(tick) && SIDES.includes(side), 'ARGUMENT_INVALID', 'alignToTick');
  const n = price / tick;
  const k = side === 'BUY' ? Math.ceil(n - 1e-9) : Math.floor(n + 1e-9);
  return Number((k * tick).toFixed(tickDecimals(tick)));
}
/** 价格加减滑点（bps），可选按最小价位对齐、封在涨跌停带内。 */
function slipped(price, { slippageBps = 0, side, tick = null, limits = null }) {
  need(isPos(price) && isNonNeg(slippageBps) && SIDES.includes(side), 'ARGUMENT_INVALID', `slipped:${price}:${slippageBps}:${side}`);
  let p = side === 'BUY' ? price * (1 + slippageBps / 10000) : price * (1 - slippageBps / 10000);
  if (tick !== null) p = alignToTick(p, tick, side);
  if (limits) p = side === 'BUY' ? Math.min(p, limits.up) : Math.max(p, limits.down);
  return p;
}

// ── 价格和顺序规则 ────────────────────────────────────────────────────────────────

/** NEXT_OPEN：下一根 K 线的开盘价加减滑点；按最小价位不利对齐；可选封在涨跌停带内（V6 开盘计划）。 */
function NEXT_OPEN({ nextOpen, slippageBps = 0, side, tick = null, limits = null }) {
  return slipped(nextOpen, { slippageBps, side, tick, limits });
}

/**
 * GAP_THROUGH_LEVEL_AT_OPEN：开盘已经穿过价位的，按开盘价成交；否则不适用（交给盘中的价位规则）。
 * direction：价格向下穿过价位（多头止损、空头止盈）为 DOWN，向上为 UP。
 */
function GAP_THROUGH_LEVEL_AT_OPEN({ level, open, direction }) {
  need(isPos(level) && isPos(open) && DIRECTIONS.includes(direction), 'ARGUMENT_INVALID', 'GAP_THROUGH_LEVEL_AT_OPEN');
  const gapped = direction === 'DOWN' ? open <= level : open >= level;
  return gapped ? { filled: true, price: open } : { filled: false, reason: 'NOT_GAPPED' };
}

/** SAME_BAR_STOP_FIRST：同一根 K 线止损与止盈都碰到时判止损。返回 STOP / TARGET / NONE。 */
function SAME_BAR_STOP_FIRST({ high, low, stop, target, position }) {
  need(isPos(high) && isPos(low) && high >= low && isPos(stop) && isPos(target) && POSITIONS.includes(position), 'ARGUMENT_INVALID', 'SAME_BAR_STOP_FIRST');
  const stopHit = position === 'LONG' ? low <= stop : high >= stop;
  const targetHit = position === 'LONG' ? high >= target : low <= target;
  if (stopHit) return 'STOP';
  return targetHit ? 'TARGET' : 'NONE';
}

/** LIMIT_CROSS_ONE_TICK：价格要越过限价一个价位才算成交（只碰到不算）；成交价为限价。 */
function LIMIT_CROSS_ONE_TICK({ limit, tick, high, low, side }) {
  need(isPos(limit) && isPos(tick) && isPos(high) && isPos(low) && high >= low && SIDES.includes(side), 'ARGUMENT_INVALID', 'LIMIT_CROSS_ONE_TICK');
  const crossed = side === 'BUY' ? low <= limit - tick + 1e-12 : high >= limit + tick - 1e-12;
  return crossed ? { filled: true, price: limit } : { filled: false, reason: 'NOT_CROSSED_BY_ONE_TICK' };
}

/**
 * PREV_DAY_VOLUME_CAP：可成交数量 ≤ 前一交易日成交量（已按拆分系数换算）× 参与率，按每手股数向下取整。
 * 读不到前一交易日量就不成交（PREV_VOLUME_MISSING），不回退到当天量：函数不接受当天量。
 */
function PREV_DAY_VOLUME_CAP({ prevDayVolume, participation = DEFAULT_PARTICIPATION, desired, lotSize = 1 }) {
  need(isNonNeg(desired) && isPos(lotSize) && isPos(participation) && participation <= 1, 'ARGUMENT_INVALID', 'PREV_DAY_VOLUME_CAP');
  if (!isNonNeg(prevDayVolume)) return { quantity: 0, capped: true, reason: 'PREV_VOLUME_MISSING' };
  const cap = Math.floor((prevDayVolume * participation) / lotSize + 1e-9) * lotSize;
  const want = Math.floor(desired / lotSize + 1e-9) * lotSize;
  return want <= cap ? { quantity: want, capped: false, cap } : { quantity: cap, capped: true, cap, reason: 'PREV_DAY_VOLUME_CAP' };
}

/** TOUCH_MINUTE_CLOSE：触价那一分钟的收盘价加减滑点（A 股指数簿 ±10 bp、US_CORE +5 bp）。 */
function TOUCH_MINUTE_CLOSE({ minuteClose, slippageBps = 0, side, tick = null }) {
  return slipped(minuteClose, { slippageBps, side, tick });
}

/** TICKER_LAST_PLUS_SLIPPAGE：扫描时刻的最新成交价加减滑点（C17、Quick Shot 的入场）。 */
function TICKER_LAST_PLUS_SLIPPAGE({ last, slippageBps = 0, side }) {
  return slipped(last, { slippageBps, side });
}

/**
 * MARKET_AFTER_POLL：轮询发现触发以后才发单，按其后第一根 1 分钟线（开始时刻严格晚于轮询时刻）的开盘价加减滑点成交。
 * minuteBars：[{ startMs, open }]，按时间升序。
 */
function MARKET_AFTER_POLL({ pollAtMs, minuteBars, slippageBps = 0, side }) {
  need(isNum(pollAtMs) && Array.isArray(minuteBars), 'ARGUMENT_INVALID', 'MARKET_AFTER_POLL');
  const bar = minuteBars.find((b) => b.startMs > pollAtMs);
  if (!bar) return { filled: false, reason: 'NO_BAR_AFTER_POLL' };
  return { filled: true, price: slipped(bar.open, { slippageBps, side }), barStartMs: bar.startMs };
}

/**
 * TIERED_LIMIT_STOP：触发后先挂偏离 t1Pct 的限价单 t1TimeoutS 秒，再挂 t2Pct 的 t2TimeoutS 秒，仍未成交就改市价单（其后第一根 1 分钟线的开盘价）。
 * 多头止损是 SELL（限价 = 触发价 ×(1 − pct)），空头止损是 BUY（×(1 + pct)）。限价单：开盘已经优于限价按开盘价，否则区间碰到限价按限价。
 * minuteBars：[{ startMs, open, high, low }]，按时间升序；只用开始时刻不早于触发时刻的分钟线。
 */
function TIERED_LIMIT_STOP({ triggerPrice, triggerAtMs, side, minuteBars, tiers = DEFAULT_TIERS }) {
  need(isPos(triggerPrice) && isNum(triggerAtMs) && SIDES.includes(side) && Array.isArray(minuteBars), 'ARGUMENT_INVALID', 'TIERED_LIMIT_STOP');
  need(isPos(tiers.t1Pct) && isPos(tiers.t1TimeoutS) && isPos(tiers.t2Pct) && isPos(tiers.t2TimeoutS), 'ARGUMENT_INVALID', 'tiers');
  const after = minuteBars.filter((b) => b.startMs >= triggerAtMs);
  const t1End = triggerAtMs + tiers.t1TimeoutS * 1000;
  const t2End = t1End + tiers.t2TimeoutS * 1000;
  const windows = [{ tier: 1, pct: tiers.t1Pct, from: triggerAtMs, to: t1End }, { tier: 2, pct: tiers.t2Pct, from: t1End, to: t2End }];
  for (const w of windows) {
    const limit = side === 'SELL' ? triggerPrice * (1 - w.pct / 100) : triggerPrice * (1 + w.pct / 100);
    for (const b of after.filter((x) => x.startMs >= w.from && x.startMs < w.to)) {
      if (side === 'SELL' ? b.open >= limit : b.open <= limit) return { filled: true, tier: w.tier, price: b.open, limit, barStartMs: b.startMs };
      if (side === 'SELL' ? b.high >= limit : b.low <= limit) return { filled: true, tier: w.tier, price: limit, limit, barStartMs: b.startMs };
    }
  }
  const market = after.find((b) => b.startMs >= t2End);
  return market ? { filled: true, tier: 'MARKET', price: market.open, barStartMs: market.startMs } : { filled: false, reason: 'NO_BAR_AFTER_TIERS' };
}

// ── 节奏规则 ──────────────────────────────────────────────────────────────────

/** POLL_EVERY(interval)：只在实盘的交易时段窗口内，从窗口开始起每 intervalMs 一次（含窗口终点）。windows：[{ startMs, endMs }]。 */
function POLL_EVERY({ windows, intervalMs }) {
  need(Array.isArray(windows) && isPos(intervalMs), 'ARGUMENT_INVALID', 'POLL_EVERY');
  const out = [];
  for (const w of windows) {
    need(isNum(w.startMs) && isNum(w.endMs) && w.endMs >= w.startMs, 'ARGUMENT_INVALID', 'POLL_EVERY:window');
    for (let t = w.startMs; t <= w.endMs; t += intervalMs) out.push(t);
  }
  return out;
}

/** 轮询看到的价格：不晚于轮询时刻的最后一笔成交（ticks：[{ atMs, price }] 升序）。两次轮询之间先碰到又回来的价格看不到。 */
function priceAtPoll(ticks, pollAtMs) {
  let seen = null;
  for (const t of ticks) { if (t.atMs > pollAtMs) break; seen = t.price; }
  return seen;
}

/**
 * FORMING_BAR_AS_OF_POLL(barInterval)：按轮询时刻重建正在形成的那根大 K 线。只用开始时刻不早于这根大 K 线开始、
 * 且在轮询时刻之前已经收完（开始 + 1 分钟 ≤ 轮询时刻）的 1 分钟线。anchorMs：大 K 线的对齐起点（例如美股 1 小时线对齐 09:30）。
 */
function FORMING_BAR_AS_OF_POLL({ minuteBars, pollAtMs, barIntervalMs, anchorMs = 0 }) {
  need(Array.isArray(minuteBars) && isNum(pollAtMs) && isPos(barIntervalMs) && isNum(anchorMs), 'ARGUMENT_INVALID', 'FORMING_BAR_AS_OF_POLL');
  const startMs = anchorMs + Math.floor((pollAtMs - anchorMs) / barIntervalMs) * barIntervalMs;
  const used = minuteBars.filter((b) => b.startMs >= startMs && b.startMs + MINUTE_MS <= pollAtMs);
  if (!used.length) return null;
  return { startMs, open: used[0].open, high: Math.max(...used.map((b) => b.high)), low: Math.min(...used.map((b) => b.low)), close: used[used.length - 1].close, minutes: used.length };
}

/**
 * SCAN_SCHEDULE(spec)：实盘的扫描时刻序列。
 *   { kind: 'INTERVAL', startMs, endMs, intervalMs }：从 startMs 起每 intervalMs 一次（C17 每 10 分钟）；
 *   { kind: 'COMPLETED_1H', openMs, closeMs, lagMs = 60000, barMs = 3600000 }：开盘后 lagMs 一轮只管出场（09:31），
 *     之后每根在收盘前收完的 1 小时线结束后 lagMs 一轮执行（10:31 … 15:31；提前收盘 13:00 只有 10:31、11:31、12:31）；
 *   { kind: 'ROUND_ROBIN_BATCHES', startMs, endMs, everyMs, batches }：每 everyMs 一批，batches 批轮完（Quick Shot：每分钟一批、6 批）。
 */
function SCAN_SCHEDULE(spec) {
  need(spec && typeof spec === 'object', 'ARGUMENT_INVALID', 'SCAN_SCHEDULE');
  if (spec.kind === 'INTERVAL') {
    need(isNum(spec.startMs) && isNum(spec.endMs) && isPos(spec.intervalMs), 'ARGUMENT_INVALID', 'SCAN_SCHEDULE:INTERVAL');
    const out = [];
    for (let t = spec.startMs; t <= spec.endMs; t += spec.intervalMs) out.push({ atMs: t, kind: 'SCAN' });
    return out;
  }
  if (spec.kind === 'COMPLETED_1H') {
    const lagMs = spec.lagMs === undefined ? MINUTE_MS : spec.lagMs;
    const barMs = spec.barMs === undefined ? 60 * MINUTE_MS : spec.barMs;
    need(isNum(spec.openMs) && isNum(spec.closeMs) && spec.closeMs > spec.openMs && isNonNeg(lagMs) && isPos(barMs), 'ARGUMENT_INVALID', 'SCAN_SCHEDULE:COMPLETED_1H');
    const out = [{ atMs: spec.openMs + lagMs, kind: 'EXITS_ONLY' }];
    for (let start = spec.openMs; start + barMs <= spec.closeMs; start += barMs) out.push({ atMs: start + barMs + lagMs, kind: 'EXECUTING', barStartMs: start, barEndMs: start + barMs });
    return out;
  }
  if (spec.kind === 'ROUND_ROBIN_BATCHES') {
    need(isNum(spec.startMs) && isNum(spec.endMs) && isPos(spec.everyMs) && Number.isInteger(spec.batches) && spec.batches > 0, 'ARGUMENT_INVALID', 'SCAN_SCHEDULE:ROUND_ROBIN_BATCHES');
    const out = [];
    for (let t = spec.startMs, i = 0; t <= spec.endMs; t += spec.everyMs, i += 1) out.push({ atMs: t, kind: 'BATCH', batch: i % spec.batches });
    return out;
  }
  return fail('ARGUMENT_INVALID', `SCAN_SCHEDULE:kind ${spec.kind}`);
}

const PRICE_RULES = Object.freeze(['NEXT_OPEN', 'GAP_THROUGH_LEVEL_AT_OPEN', 'SAME_BAR_STOP_FIRST', 'LIMIT_CROSS_ONE_TICK', 'PREV_DAY_VOLUME_CAP',
  'TOUCH_MINUTE_CLOSE', 'TICKER_LAST_PLUS_SLIPPAGE', 'MARKET_AFTER_POLL', 'TIERED_LIMIT_STOP']);
const CADENCE_RULES = Object.freeze(['POLL_EVERY', 'FORMING_BAR_AS_OF_POLL', 'SCAN_SCHEDULE']);
const RULES = Object.freeze([...PRICE_RULES, ...CADENCE_RULES]);
const VERSION = '1.0.0';

module.exports = {
  VERSION, RULES, PRICE_RULES, CADENCE_RULES, SIDES, DIRECTIONS, POSITIONS, DEFAULT_TIERS, DEFAULT_PARTICIPATION, MINUTE_MS, FillModelError,
  NEXT_OPEN, GAP_THROUGH_LEVEL_AT_OPEN, SAME_BAR_STOP_FIRST, LIMIT_CROSS_ONE_TICK, PREV_DAY_VOLUME_CAP, TOUCH_MINUTE_CLOSE, TICKER_LAST_PLUS_SLIPPAGE,
  MARKET_AFTER_POLL, TIERED_LIMIT_STOP, POLL_EVERY, FORMING_BAR_AS_OF_POLL, SCAN_SCHEDULE,
  alignToTick, priceAtPoll,
};
