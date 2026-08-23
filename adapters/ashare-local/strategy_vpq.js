'use strict';
/**
 * VolumePriceQuality(VPQ)形态判定 —— 迁移自 Ashare-V5
 * scripts/phase2_vertical_slice_volume_price.js(Champion/Challenger 同源判定,禁分叉)。
 *
 * Champion:固定阈值 volConfirmRatio=1.2 / volDryRatio=0.7 / stagnationPricePct=0.5(v0.4.0 冻结值)。
 * Challenger 族:自适应分位(标的自身 trailing 60 日 vol-ratio 分布 Q_hi/Q_lo)。
 * Pattern 逻辑双方完全一致,只换 volUp/volDry 判据 = changed_component 单一(§9 One Variable at a Time)。
 *
 * 变体形状:
 *   { key, type: 'FIXED',    volConfirmRatio, volDryRatio }
 *   { key, type: 'QUANTILE', qHi, qLo }
 */
const FWD_DAYS = 3;   // 前向窗口(预注册)
const CHAMP = Object.freeze({ volConfirmRatio: 1.2, volDryRatio: 0.7, stagnationPricePct: 0.5 });

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** 与源仓 timing_policy._volumePriceState 同构的 pattern 判定;volUp/volDry 判据可注入(受控变量)。 */
function classifyPattern(bars, i, { volUp, volDry }) {
  const last = bars[i], prev = bars[i - 1];
  const lastClose = last.close, prevClose = prev.close;
  const lastHigh = last.high != null ? last.high : last.close;
  const pricePct = prevClose > 0 ? ((lastClose - prevClose) / prevClose) * 100 : null;
  const closes20 = bars.slice(i - 20, i).map((b) => b.close);
  const high20 = Math.max(...closes20);
  const ma20 = closes20.reduce((s, v) => s + v, 0) / closes20.length;
  const aboveHigh20 = lastClose > high20;
  const nearHigh20 = !aboveHigh20 && high20 > 0 && (high20 - lastClose) / high20 <= 0.03;
  const stagnant = pricePct != null && Math.abs(pricePct) <= CHAMP.stagnationPricePct;

  let pattern = 'NONE';
  if (volUp && lastHigh > high20 && lastClose < high20) pattern = 'BREAKOUT_FAILED';
  else if (volUp && pricePct != null && pricePct < -CHAMP.stagnationPricePct) pattern = 'DISTRIBUTION_RISK';
  else if (volUp && stagnant) pattern = 'VOLUME_STAGNATION';
  else if (volUp && aboveHigh20 && pricePct > 0) pattern = 'BREAKOUT_VOLUME_CONFIRMED';
  else if (volDry && nearHigh20 && pricePct != null && pricePct <= 0) pattern = 'PULLBACK_VOLUME_DRY';
  else if (volDry && stagnant && lastClose >= ma20) pattern = 'DRY_STABILIZATION';
  else if (volUp && pricePct > 0) pattern = 'VOLUME_PRICE_ALIGNED';
  else if (volUp) pattern = 'VOLUME_WITHOUT_PRICE';
  else if (volDry) pattern = 'DRY';
  const GOOD = ['BREAKOUT_VOLUME_CONFIRMED', 'PULLBACK_VOLUME_DRY', 'DRY_STABILIZATION'];
  const BAD = ['BREAKOUT_FAILED', 'DISTRIBUTION_RISK', 'VOLUME_STAGNATION'];
  return GOOD.includes(pattern) ? 'GOOD' : (BAD.includes(pattern) ? 'BAD' : 'NEUTRAL');
}

function variantJudge(variant, ratio, sortedTrailing) {
  if (variant.type === 'FIXED') return { volUp: ratio >= variant.volConfirmRatio, volDry: ratio <= variant.volDryRatio };
  if (variant.type === 'QUANTILE') return { volUp: ratio >= quantile(sortedTrailing, variant.qHi), volDry: ratio <= quantile(sortedTrailing, variant.qLo) };
  throw new Error(`BAD_VARIANT_TYPE:${variant.type}`);
}

const CHAMPION_VARIANT = Object.freeze({ key: 'CHAMPION_FIXED', type: 'FIXED', volConfirmRatio: CHAMP.volConfirmRatio, volDryRatio: CHAMP.volDryRatio });

module.exports = { FWD_DAYS, CHAMP, quantile, classifyPattern, variantJudge, CHAMPION_VARIANT };
