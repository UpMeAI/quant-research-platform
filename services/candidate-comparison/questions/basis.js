'use strict';

/**
 * D1（UX 修订 4）：对比卡的「判定依据」——触发本结论的那条判据，写明指标、比较对象、区间、门槛。
 * 只读文件里的数字和位置，不重算；与结论自洽（导入时已拒绝越过算术证据的标签）。
 *   Q2／Q3b（配对 g，G1 先判）：INSUFFICIENT 且 G1 不成立 → G1 的实有笔数对门槛笔数，g 区间并列；G1 成立 → 区间跨门槛；
 *                              NOT_PASSED → 上沿不高于门槛；SUPPORTED → 下沿高于门槛。
 *   Q1（K2 §6.1 判定顺序）：G1 → F1／F2／F3（未通过）→ P1、P3（有支持证据）。
 */
const { finite, pct1, rText } = require('../common');

/** 区间在门槛上的位置，人话。 */
const placeOf = (lo, hi, threshold) => (hi <= threshold ? (hi < threshold ? '上沿低于门槛' : '上沿不高于门槛') : (lo > threshold ? '下沿高于门槛' : '区间跨过门槛'));
const FROZEN = '门槛在看到结果前已冻结';
const lines = (...items) => items.filter(Boolean);

/** 配对 g 一类（Q2、Q3b）。 */
function pairedBasis({ state, flags, L_g, U_g, delta_g, min_trades, changed_label }) {
  const item = flags.G1.item;
  const gLine = finite(L_g) && finite(U_g)
    ? `候选相对原版的年化对数增长差 95% 区间 ${pct1(L_g)} 至 ${pct1(U_g)}，${placeOf(L_g, U_g, delta_g)} ${delta_g}` : null;
  const short = [];
  if (finite(item.baseline_oos_trades) && item.baseline_oos_trades < min_trades) short.push(`原版样本外成熟交易 ${item.baseline_oos_trades} 笔`);
  if (finite(item.candidate_oos_trades) && item.candidate_oos_trades < min_trades) short.push(`候选样本外成熟交易 ${item.candidate_oos_trades} 笔`);
  if (finite(item.changed_entries) && item.changed_entries < min_trades) short.push(`${changed_label} ${item.changed_entries} 笔`);
  const g1Line = `G1 不成立：${short.length ? `${short.join('、')}，低于门槛 ${min_trades} 笔` : '样本不够（笔数没有写明）'}`;
  if (state === 'INSUFFICIENT' && flags.G1.flag !== true) return { title: '判定依据', main: [g1Line], also: lines(gLine), frozen_zh: FROZEN };
  const g1Note = state === 'SUPPORTED' ? `；G1 成立（${changed_label} ${finite(item.changed_entries) ? item.changed_entries : '—'} 笔，门槛 ${min_trades} 笔）` : '';
  return { title: '判定依据', main: lines(gLine && `${gLine}${g1Note}`), also: [], frozen_zh: FROZEN };
}

/** Q1（T3）：判据 G1、P1–P4、F1–F3。 */
function q1Basis({ state, flags, L_D, U_D, L_g, U_g, population, delta_star, delta_g, min_affected, min_blocks }) {
  const dLine = finite(L_D) && finite(U_D)
    ? `受影响交易的每笔平均改善 98.33% 区间 ${rText(L_D)} 至 ${rText(U_D)}，${flags.F1.flag === true ? `上沿低于最低改善量 +${delta_star.toFixed(2)} R` : `${placeOf(L_D, U_D, 0)} 0`}` : null;
  const gLine = finite(L_g) && finite(U_g)
    ? `候选相对原版的年化对数增长差 98.33% 区间 ${pct1(L_g)} 至 ${pct1(U_g)}，${placeOf(L_g, U_g, delta_g)} ${delta_g}` : null;
  const f2Line = flags.F2.flag === true ? 'P1 成立，但 P2 或 P4 不成立' : null;
  const short = [];
  const nAff = population && finite(population.n_aff) ? population.n_aff : undefined;
  const blocks = population ? [population.blocks, population.n_blocks].find(finite) : undefined;
  const baseTrades = flags.G1.item.baseline_oos_trades;
  if (finite(baseTrades) && baseTrades < 30) short.push(`基线样本外成熟交易 ${baseTrades} 笔，低于门槛 30 笔`);
  if (finite(nAff) && nAff < min_affected) short.push(`主样本受影响交易 ${nAff} 笔，低于门槛 ${min_affected} 笔`);
  if (finite(blocks) && blocks < min_blocks) short.push(`入场块 ${blocks} 个，低于门槛 ${min_blocks} 个`);
  const g1Line = `G1 不成立：${short.length ? short.join('；') : '样本不够（笔数没有写明）'}`;
  const gFired = finite(U_g) && U_g <= delta_g;
  if (state === 'NOT_PASSED') {
    return {
      title: '判定依据', main: lines(flags.F1.flag === true ? dLine : null, f2Line, gFired ? gLine : null),
      also: lines(flags.F1.flag === true ? null : dLine, gFired ? null : gLine), frozen_zh: FROZEN,
    };
  }
  if (state === 'SUPPORTED') return { title: '判定依据', main: lines(dLine, gLine), also: [], frozen_zh: FROZEN };
  if (flags.G1.flag !== true) return { title: '判定依据', main: [g1Line], also: lines(dLine, gLine), frozen_zh: FROZEN };
  return {
    title: '判定依据', main: lines(flags.P1.flag === true ? null : dLine, flags.P3.flag === true ? null : gLine),
    also: lines(flags.P1.flag === true ? dLine : null, flags.P3.flag === true ? gLine : null), frozen_zh: FROZEN,
  };
}

module.exports = { placeOf, pairedBasis, q1Basis, FROZEN };
