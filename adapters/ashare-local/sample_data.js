'use strict';
/**
 * 确定性样本行情生成器(SAMPLE_SYNTHETIC)。
 *
 * 用途边界(诚实标注):
 *   - 仅供平台链路演示与确定性测试;source='SAMPLE_SYNTHETIC',**不是**真实行情;
 *   - 生产接入真实数据走 ingestBars(source='TUSHARE' 等)或 Ashare-V5 research-adapter,本模块不冒充;
 *   - 种子固定 → 任何机器重跑得到逐字节相同的宇宙(回测/赛马结果可复现)。
 */
const market = require('./market_facts');

/** mulberry32 —— 确定性 PRNG(无外部依赖)。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从 startDate 起生成 n 个「交易日」(跳过周末;样本数据显式近似,不建真实节假日表)。 */
function tradingDates(startDate, n) {
  const dates = [];
  const d = new Date(`${startDate}T00:00:00Z`);
  while (dates.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/**
 * 生成样本宇宙:stockCount 只股票 + 1 个基准指数。
 * 量价结构含「放量突破 / 缩量回踩」区段,保证 VPQ 类策略在样本上有非零信号覆盖。
 */
function generateSampleBars({ stockCount = 20, days = 170, startDate = '2026-01-05', seed = 20260823 } = {}) {
  const dates = tradingDates(startDate, days);
  const bars = [];

  const stockIds = [];
  for (let s = 0; s < stockCount; s++) stockIds.push(`600${String(s).padStart(3, '0')}.SH`);

  for (const inst of stockIds) {
    const rnd = mulberry32(seed + stockIds.indexOf(inst) * 7919);
    let close = 8 + rnd() * 30;
    const baseVol = 1e6 * (0.5 + rnd() * 3);
    for (let i = 0; i < dates.length; i++) {
      // 周期性量能 regime:每 40 天一段放量脉冲,期间价格带正漂移(制造可判定形态)
      const phase = i % 40;
      const pulse = phase >= 30 && phase < 35;
      const dry = phase >= 35;
      const drift = pulse ? 0.004 : (dry ? -0.001 : 0.0005);
      const ret = drift + (rnd() - 0.5) * 0.03;
      close = Math.max(1, close * (1 + ret));
      const high = close * (1 + rnd() * 0.015);
      const vol = baseVol * (pulse ? 1.8 + rnd() : (dry ? 0.5 + rnd() * 0.2 : 0.9 + rnd() * 0.4));
      bars.push({ instrument_id: inst, d: dates[i], close: Number(close.toFixed(3)), high: Number(high.toFixed(3)), vol: Math.round(vol) });
    }
  }

  // 基准指数(市场事实声明的 benchmark)
  const rndB = mulberry32(seed * 31);
  let idx = 3800;
  for (const d of dates) {
    idx = Math.max(100, idx * (1 + 0.0002 + (rndB() - 0.5) * 0.012));
    bars.push({ instrument_id: market.benchmark, d, close: Number(idx.toFixed(2)), high: Number((idx * 1.004).toFixed(2)), vol: 1 });
  }
  return { bars, dates, stockIds, benchmark: market.benchmark };
}

module.exports = { generateSampleBars, tradingDates, mulberry32 };
