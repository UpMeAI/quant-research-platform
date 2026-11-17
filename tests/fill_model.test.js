'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fm = require('../packages/fill-model');

/**
 * 统一成交模型库（FILL_MODEL_LIBRARY_V1，ENGINE_MODELING_ACCEPTANCE_V1 §2.2，签字文本 8d214ddf，规格 90814c60 §2、§4）：
 * 十二条规则各一个正例、一个反例（合成数据），加 §2.2 第 4 条的两个节奏反例。先红后绿。
 */
const T0 = Date.parse('2026-01-05T09:30:00+08:00');
const M = 60000;
const bar = (i, o, h, l, c) => ({ startMs: T0 + i * M, open: o, high: h, low: l, close: c });

test('十二条规则都在，分价格与顺序九条、节奏三条；源码纯：不 require 任何东西（series 只 require ./index），不读宿主时钟', () => {
  assert.deepEqual([...fm.PRICE_RULES], ['NEXT_OPEN', 'GAP_THROUGH_LEVEL_AT_OPEN', 'SAME_BAR_STOP_FIRST', 'LIMIT_CROSS_ONE_TICK', 'PREV_DAY_VOLUME_CAP',
    'TOUCH_MINUTE_CLOSE', 'TICKER_LAST_PLUS_SLIPPAGE', 'MARKET_AFTER_POLL', 'TIERED_LIMIT_STOP']);
  assert.deepEqual([...fm.CADENCE_RULES], ['POLL_EVERY', 'FORMING_BAR_AS_OF_POLL', 'SCAN_SCHEDULE']);
  for (const r of fm.RULES) assert.equal(typeof fm[r], 'function', r);
  const dir = path.join(__dirname, '..', 'packages', 'fill-model');
  const index = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
  const series = fs.readFileSync(path.join(dir, 'series.js'), 'utf8');
  assert.deepEqual(index.match(/require\(/g), null);
  assert.deepEqual(series.match(/require\([^)]*\)/g), ["require('./index')"]);
  for (const src of [index, series]) assert.equal(/Date\.now|new Date\(\)|process\.|fs\.|Math\.random/.test(src), false);
});

test('NEXT_OPEN：用下一根的开盘价，买加滑点、卖减滑点，按价位不利对齐；反例：不用决策那根的收盘价，也不朝有利方向取整', () => {
  assert.equal(fm.NEXT_OPEN({ nextOpen: 10, slippageBps: 10, side: 'BUY', tick: 0.01 }), 10.01);
  assert.equal(fm.NEXT_OPEN({ nextOpen: 10, slippageBps: 10, side: 'SELL', tick: 0.01 }), 9.99);
  // 10.0005 买入向上对齐到 10.001（不是四舍五入到 10.000）；卖出 9.9995 向下到 9.999
  assert.equal(fm.NEXT_OPEN({ nextOpen: 10, slippageBps: 0.5, side: 'BUY', tick: 0.001 }), 10.001);
  assert.equal(fm.NEXT_OPEN({ nextOpen: 10, slippageBps: 0.5, side: 'SELL', tick: 0.001 }), 9.999);
  // 封在涨跌停带内
  assert.equal(fm.NEXT_OPEN({ nextOpen: 11, slippageBps: 10, side: 'BUY', tick: 0.01, limits: { up: 11, down: 9 } }), 11);
  const decisionClose = 9.5;
  assert.notEqual(fm.NEXT_OPEN({ nextOpen: 10, slippageBps: 10, side: 'BUY', tick: 0.01 }), fm.NEXT_OPEN({ nextOpen: decisionClose, slippageBps: 10, side: 'BUY', tick: 0.01 }));
});

test('GAP_THROUGH_LEVEL_AT_OPEN：开盘已经穿过价位的按开盘价成交；反例：没穿过的不适用，穿过的不按价位成交（价位比开盘有利）', () => {
  assert.deepEqual(fm.GAP_THROUGH_LEVEL_AT_OPEN({ level: 100, open: 97, direction: 'DOWN' }), { filled: true, price: 97 });
  assert.deepEqual(fm.GAP_THROUGH_LEVEL_AT_OPEN({ level: 100, open: 103, direction: 'UP' }), { filled: true, price: 103 });
  assert.deepEqual(fm.GAP_THROUGH_LEVEL_AT_OPEN({ level: 100, open: 101, direction: 'DOWN' }), { filled: false, reason: 'NOT_GAPPED' });
  assert.notEqual(fm.GAP_THROUGH_LEVEL_AT_OPEN({ level: 100, open: 97, direction: 'DOWN' }).price, 100);
});

test('SAME_BAR_STOP_FIRST：只碰止盈判止盈；反例：同一根两个都碰到判止损，不判止盈', () => {
  assert.equal(fm.SAME_BAR_STOP_FIRST({ high: 106, low: 99, stop: 95, target: 105, position: 'LONG' }), 'TARGET');
  assert.equal(fm.SAME_BAR_STOP_FIRST({ high: 106, low: 94, stop: 95, target: 105, position: 'LONG' }), 'STOP');
  assert.equal(fm.SAME_BAR_STOP_FIRST({ high: 106, low: 94, stop: 105, target: 95, position: 'SHORT' }), 'STOP');
  assert.equal(fm.SAME_BAR_STOP_FIRST({ high: 101, low: 99, stop: 95, target: 105, position: 'LONG' }), 'NONE');
});

test('LIMIT_CROSS_ONE_TICK：越过限价一个价位才成交、成交价为限价；反例：只碰到限价不成交', () => {
  assert.deepEqual(fm.LIMIT_CROSS_ONE_TICK({ limit: 10, tick: 0.01, high: 10.2, low: 9.99, side: 'BUY' }), { filled: true, price: 10 });
  assert.deepEqual(fm.LIMIT_CROSS_ONE_TICK({ limit: 10, tick: 0.01, high: 10.2, low: 10, side: 'BUY' }), { filled: false, reason: 'NOT_CROSSED_BY_ONE_TICK' });
  assert.deepEqual(fm.LIMIT_CROSS_ONE_TICK({ limit: 10, tick: 0.01, high: 10, low: 9.8, side: 'SELL' }).filled, false);
  assert.deepEqual(fm.LIMIT_CROSS_ONE_TICK({ limit: 10, tick: 0.01, high: 10.01, low: 9.8, side: 'SELL' }).filled, true);
});

test('PREV_DAY_VOLUME_CAP：按前一交易日量 × 0.1 封顶、按手取整；反例：读不到前一日量就不成交（PREV_VOLUME_MISSING），不回退到当天量', () => {
  assert.deepEqual(fm.PREV_DAY_VOLUME_CAP({ prevDayVolume: 1_000_000, desired: 50_000, lotSize: 100 }), { quantity: 50_000, capped: false, cap: 100_000 });
  assert.deepEqual(fm.PREV_DAY_VOLUME_CAP({ prevDayVolume: 123_456, desired: 50_000, lotSize: 100 }), { quantity: 12_300, capped: true, cap: 12_300, reason: 'PREV_DAY_VOLUME_CAP' });
  const missing = fm.PREV_DAY_VOLUME_CAP({ prevDayVolume: undefined, todayVolume: 9_000_000, desired: 50_000, lotSize: 100 });
  assert.deepEqual(missing, { quantity: 0, capped: true, reason: 'PREV_VOLUME_MISSING' });
});

test('TOUCH_MINUTE_CLOSE：按触价那一分钟的收盘价加减滑点；反例：不按价位、也不按后一分钟的价格', () => {
  assert.equal(fm.TOUCH_MINUTE_CLOSE({ minuteClose: 3.5, slippageBps: 10, side: 'SELL', tick: 0.001 }), 3.496);
  assert.equal(fm.TOUCH_MINUTE_CLOSE({ minuteClose: 200, slippageBps: 5, side: 'BUY', tick: 0.01 }), 200.1);
  assert.notEqual(fm.TOUCH_MINUTE_CLOSE({ minuteClose: 3.5, slippageBps: 10, side: 'SELL', tick: 0.001 }), 3.52);
});

test('TICKER_LAST_PLUS_SLIPPAGE：按扫描时刻的最新成交价加减滑点；反例：滑点方向不利于自己（买不能便宜、卖不能贵）', () => {
  assert.ok(Math.abs(fm.TICKER_LAST_PLUS_SLIPPAGE({ last: 100, slippageBps: 5, side: 'BUY' }) - 100.05) < 1e-9);
  assert.ok(Math.abs(fm.TICKER_LAST_PLUS_SLIPPAGE({ last: 100, slippageBps: 5, side: 'SELL' }) - 99.95) < 1e-9);
  assert.ok(fm.TICKER_LAST_PLUS_SLIPPAGE({ last: 100, slippageBps: 5, side: 'BUY' }) > 100);
});

test('MARKET_AFTER_POLL：轮询发现以后才发单，按其后第一根 1 分钟线的开盘价成交；反例：不用轮询时刻所在那一分钟（已经开始）的开盘价', () => {
  const bars = [bar(0, 10, 10.1, 9.9, 10), bar(1, 10.2, 10.3, 10.1, 10.2), bar(2, 10.5, 10.6, 10.4, 10.5)];
  const r = fm.MARKET_AFTER_POLL({ pollAtMs: T0 + M + 1000, minuteBars: bars, slippageBps: 0, side: 'BUY' });
  assert.deepEqual(r, { filled: true, price: 10.5, barStartMs: T0 + 2 * M });
  assert.notEqual(r.price, 10.2);
  assert.deepEqual(fm.MARKET_AFTER_POLL({ pollAtMs: T0 + 2 * M + 1000, minuteBars: bars, side: 'BUY' }), { filled: false, reason: 'NO_BAR_AFTER_POLL' });
});

test('TIERED_LIMIT_STOP：2% 挂 60 秒 → 4% 挂 300 秒 → 市价；反例：第一档超时以后回来的价格不按第一档成交', () => {
  assert.deepEqual(fm.DEFAULT_TIERS, { t1Pct: 2, t1TimeoutS: 60, t2Pct: 4, t2TimeoutS: 300 });
  // #110：触发在第 −1 分钟里（不在整分钟上），第一根可成交的是第 0 分钟（与 MARKET_AFTER_POLL 同一口径，见下一条）
  const at = T0 - 30000;
  // 第一档：限价 98，第 0 分钟高价 98.5 → 按 98 成交
  const l1 = 100 * (1 - 2 / 100);
  assert.deepEqual(fm.TIERED_LIMIT_STOP({ triggerPrice: 100, triggerAtMs: at, side: 'SELL', minuteBars: [bar(0, 97, 98.5, 96, 97)] }), { filled: true, tier: 1, price: l1, limit: l1, barStartMs: T0 });
  // 第 0 分钟够不着 98；第 1 分钟（第一档已过期）高价到 99：不按第一档的 98，按第二档 96 的限价单——开盘 97 已优于 96，按开盘价
  const r = fm.TIERED_LIMIT_STOP({ triggerPrice: 100, triggerAtMs: at, side: 'SELL', minuteBars: [bar(0, 95, 97, 94, 95), bar(1, 97, 99, 96.5, 98)] });
  assert.deepEqual([r.tier, r.price], [2, 97]);
  // 两档都没成交（一直在 95 以下）→ 第 6 分钟（60 + 300 秒之后）按开盘价市价成交
  const low = Array.from({ length: 7 }, (_, i) => bar(i, 94, 95, 93, 94));
  assert.deepEqual(fm.TIERED_LIMIT_STOP({ triggerPrice: 100, triggerAtMs: at, side: 'SELL', minuteBars: low }), { filled: true, tier: 'MARKET', price: 94, barStartMs: T0 + 6 * M });
});

/** #110 前（QRP 76f3a41d）的 TIERED_LIMIT_STOP：档位窗口从触发时刻起，开始时刻不早于触发时刻的分钟线都算（对照用）。 */
function tieredBefore({ triggerPrice, triggerAtMs, side, minuteBars, tiers = fm.DEFAULT_TIERS }) {
  const after = minuteBars.filter((b) => b.startMs >= triggerAtMs);
  const t1End = triggerAtMs + tiers.t1TimeoutS * 1000; const t2End = t1End + tiers.t2TimeoutS * 1000;
  for (const w of [{ tier: 1, pct: tiers.t1Pct, from: triggerAtMs, to: t1End }, { tier: 2, pct: tiers.t2Pct, from: t1End, to: t2End }]) {
    const limit = side === 'SELL' ? triggerPrice * (1 - w.pct / 100) : triggerPrice * (1 + w.pct / 100);
    for (const b of after.filter((x) => x.startMs >= w.from && x.startMs < w.to)) {
      if (side === 'SELL' ? b.open >= limit : b.open <= limit) return { filled: true, tier: w.tier, price: b.open, limit, barStartMs: b.startMs };
      if (side === 'SELL' ? b.high >= limit : b.low <= limit) return { filled: true, tier: w.tier, price: limit, limit, barStartMs: b.startMs };
    }
  }
  const market = after.find((b) => b.startMs >= t2End);
  return market ? { filled: true, tier: 'MARKET', price: market.open, barStartMs: market.startMs } : { filled: false, reason: 'NO_BAR_AFTER_TIERS' };
}

test('#110 同一口径：整分钟时刻发出的单子，那一分钟（已开始）不成交——MARKET_AFTER_POLL 用其后开始的第一根，TIERED_LIMIT_STOP 的档位也从那一根算起（反例：76f3a41d 的分级止损用了触发那一分钟）', () => {
  const at = T0; // 触发 / 轮询恰在整分钟上（回放的轮询都在整分钟上）
  const bars = [bar(0, 99, 99.5, 97, 98), bar(1, 95, 96, 94, 95), bar(2, 96.5, 97, 96, 96.5), ...Array.from({ length: 6 }, (_, i) => bar(3 + i, 94, 95, 93, 94))];
  const market = fm.MARKET_AFTER_POLL({ pollAtMs: at, minuteBars: bars, side: 'SELL' });
  assert.equal(market.barStartMs, T0 + M);
  const tiered = fm.TIERED_LIMIT_STOP({ triggerPrice: 100, triggerAtMs: at, side: 'SELL', minuteBars: bars });
  // 第一档（98）只看第 1 分钟：开盘 95、高 96 够不着；第二档（96）第 2 分钟开盘 96.5 已优于 96 → 按开盘价
  assert.deepEqual(tiered, { filled: true, tier: 2, price: 96.5, limit: 100 * (1 - 4 / 100), barStartMs: T0 + 2 * M });
  assert.deepEqual(tieredBefore({ triggerPrice: 100, triggerAtMs: at, side: 'SELL', minuteBars: bars }).barStartMs, T0); // 改前：用了第 0 分钟的开盘价 99
  // 两档都没成交 → 市价在第一根可成交分钟起 60 + 300 秒之后：第 7 分钟
  const low = Array.from({ length: 9 }, (_, i) => bar(i, 94, 95, 93, 94));
  assert.equal(fm.TIERED_LIMIT_STOP({ triggerPrice: 100, triggerAtMs: at, side: 'SELL', minuteBars: low }).barStartMs, T0 + 7 * M);
});

test('#110 不在整分钟上的触发：改前改后逐字节一致（2,000 组随机分钟线，两个方向，档位是整分钟的 60 秒 / 300 秒）', () => {
  let seed = 110;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let n = 0; n < 2000; n += 1) {
    const side = n % 2 ? 'BUY' : 'SELL';
    let p = 100;
    const bars = Array.from({ length: 12 }, (_, i) => { const o = p * (1 + (rnd() - 0.5) * 0.06); const c = o * (1 + (rnd() - 0.5) * 0.04);
      const b = bar(i, o, Math.max(o, c) * (1 + rnd() * 0.03), Math.min(o, c) * (1 - rnd() * 0.03), c); p = c; return b; });
    const triggerAtMs = T0 - M + 1 + Math.floor(rnd() * (M - 1)); // 第 −1 分钟里，不在整分钟上
    const args = { triggerPrice: 100, triggerAtMs, side, minuteBars: bars };
    assert.equal(JSON.stringify(fm.TIERED_LIMIT_STOP(args)), JSON.stringify(tieredBefore(args)));
  }
});

test('POLL_EVERY：只在时段窗口内每隔一段轮询；节奏反例（§2.2 第 4 条）：两次轮询之间先碰到又回来的价格，按轮询判不到', () => {
  const polls = fm.POLL_EVERY({ windows: [{ startMs: T0, endMs: T0 + 3 * M }, { startMs: T0 + 210 * M, endMs: T0 + 211 * M }], intervalMs: M });
  assert.deepEqual(polls, [T0, T0 + M, T0 + 2 * M, T0 + 3 * M, T0 + 210 * M, T0 + 211 * M]);
  const ticks = [{ atMs: T0, price: 100 }, { atMs: T0 + 20000, price: 95 }, { atMs: T0 + 40000, price: 100 }, { atMs: T0 + 70000, price: 100 }];
  const stop = 96;
  const seen = polls.slice(0, 2).map((p) => fm.priceAtPoll(ticks, p));
  assert.deepEqual(seen, [100, 100]);
  assert.equal(seen.some((p) => p <= stop), false); // 95 只在两次轮询之间出现过
  assert.equal(fm.priceAtPoll([{ atMs: T0 + 30000, price: 95 }], T0 + M) <= stop, true); // 正例：轮询时价格还在 95，判得到
});

test('FORMING_BAR_AS_OF_POLL：按轮询时刻重建正在形成的 1 小时线；节奏反例（§2.2 第 4 条）：第 n 分钟的高低价只用到第 n 分钟为止的分钟线', () => {
  const minutes = Array.from({ length: 60 }, (_, i) => bar(i, 100, i === 40 ? 120 : 101, i === 50 ? 80 : 99, 100));
  const atTen = fm.FORMING_BAR_AS_OF_POLL({ minuteBars: minutes, pollAtMs: T0 + 10 * M, barIntervalMs: 60 * M, anchorMs: T0 });
  assert.deepEqual(atTen, { startMs: T0, open: 100, high: 101, low: 99, close: 100, minutes: 10 }); // 第 40 分钟的 120、第 50 分钟的 80 还没出现
  const atFortyFive = fm.FORMING_BAR_AS_OF_POLL({ minuteBars: minutes, pollAtMs: T0 + 45 * M, barIntervalMs: 60 * M, anchorMs: T0 });
  assert.deepEqual([atFortyFive.high, atFortyFive.low, atFortyFive.minutes], [120, 99, 45]);
  // 轮询时还没收完的那一分钟不用
  assert.equal(fm.FORMING_BAR_AS_OF_POLL({ minuteBars: minutes, pollAtMs: T0 + 40 * M + 30000, barIntervalMs: 60 * M, anchorMs: T0 }).high, 101);
});

test('SCAN_SCHEDULE：COMPLETED_1H 在 :31 分，09:31 只管出场，提前收盘只有 10:31–12:31；反例：15:30–16:00 的半根不在收盘时判；按间隔与分批轮扫', () => {
  const ny = (hhmm) => Date.parse(`2026-11-16T${hhmm}:00-05:00`);
  const full = fm.SCAN_SCHEDULE({ kind: 'COMPLETED_1H', openMs: ny('09:30'), closeMs: ny('16:00') });
  assert.deepEqual(full.map((r) => [new Date(r.atMs).toISOString().slice(11, 16), r.kind]),
    [['14:31', 'EXITS_ONLY'], ['15:31', 'EXECUTING'], ['16:31', 'EXECUTING'], ['17:31', 'EXECUTING'], ['18:31', 'EXECUTING'], ['19:31', 'EXECUTING'], ['20:31', 'EXECUTING']]);
  assert.equal(full.some((r) => r.atMs === ny('16:01')), false);
  const early = fm.SCAN_SCHEDULE({ kind: 'COMPLETED_1H', openMs: ny('09:30'), closeMs: ny('13:00') }).filter((r) => r.kind === 'EXECUTING');
  assert.deepEqual(early.map((r) => r.atMs), [ny('10:31'), ny('11:31'), ny('12:31')]);
  assert.equal(fm.SCAN_SCHEDULE({ kind: 'INTERVAL', startMs: T0, endMs: T0 + 30 * M, intervalMs: 10 * M }).length, 4);
  const qs = fm.SCAN_SCHEDULE({ kind: 'ROUND_ROBIN_BATCHES', startMs: T0, endMs: T0 + 12 * M, everyMs: M, batches: 6 });
  assert.deepEqual(qs.filter((r) => r.batch === 0).map((r) => (r.atMs - T0) / M), [0, 6, 12]); // 每个标的每 6 分钟一次
  assert.throws(() => fm.SCAN_SCHEDULE({ kind: 'EVERY_TICK' }), /FILL_MODEL_ARGUMENT_INVALID/);
});
