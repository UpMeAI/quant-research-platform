'use strict';
/**
 * 因子库的相关性与去重（研究框架修订 2026-11-16 已签字修订（签字文本 fd22876f）§2.3；P0）：
 *   - 截面值相关 = 每期截面 Spearman 取各期均值；因子收益相关 = 两条因子收益序列的 Pearson；去重读两者 |ρ| 的较大者；
 *   - |ρ| > 0.7（严格大于）才算冲突：二者留一（挖掘段 ICIR 高的留，打平留库里已有的），或对已有因子截面正交化（取残差）；
 *   - 正交化后的版本标为一次新尝试（计入 N）；读不到相关或 ICIR 时失败即关。
 * 只用合成面板；P0 不读任何真实行情。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');

const corr = require('../services/factor-library/correlation');
const { DEDUPE } = require('../services/factor-library');

const ASSETS = Array.from({ length: 12 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
const DATES = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'];
/** 合成面板：value(date index, asset index)。 */
const panel = (fn, dates = DATES, assets = ASSETS) => dates.map((date, d) => ({ date, values: Object.fromEntries(assets.map((a, i) => [a, fn(d, i)])) }));
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('Spearman：同序 = 1、反序 = −1、并列取平均秩；方差为零时读不到（null）', () => {
  close(corr.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  close(corr.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  close(corr.spearman([1, 2, 2, 3], [1, 2, 3, 4]), corr.pearson([1, 2.5, 2.5, 4], [1, 2, 3, 4]));
  assert.equal(corr.spearman([1, 1, 1], [1, 2, 3]), null);
});

test('截面 Spearman 取各期均值：只用两边都有限的证券；不足最少证券数的期跳过；一期都没有时 UNKNOWN', () => {
  const a = panel((d, i) => i);
  const same = corr.crossSectionalSpearman(a, panel((d, i) => 2 * i + d));
  close(same.value, 1);
  assert.equal(same.dates_used, 4);
  // 第 0、1 期同序，第 2、3 期反序 → 均值 0
  const mixed = corr.crossSectionalSpearman(a, panel((d, i) => (d < 2 ? i : -i)));
  close(mixed.value, 0);
  // 缺值不当 0：一半证券缺值，剩下的仍同序
  const holes = corr.crossSectionalSpearman(a, panel((d, i) => (i % 2 ? null : i)));
  close(holes.value, 1);
  const thin = corr.crossSectionalSpearman(a, panel((d, i) => (i < 3 ? i : null)));
  assert.equal(thin.value, corr.UNKNOWN);
  assert.equal(thin.reason, 'NO_COMPARABLE_DATE');
  assert.equal(thin.dates_skipped.length, 4);
});

test('因子收益序列：每期收益对截面 z 分的回归斜率；两条序列按日期对齐取 Pearson，期数不足时 UNKNOWN', () => {
  const dates = Array.from({ length: 16 }, (_, d) => `2026-${String(1 + Math.floor(d / 4)).padStart(2, '0')}-${String(5 + 7 * (d % 4)).padStart(2, '0')}`);
  const f = panel((d, i) => i, dates);
  const r = panel((d, i) => (d % 2 ? 0.01 : 0.03) * i, dates);
  const series = corr.factorReturnSeries(f, r);
  assert.equal(series.length, 16);
  assert.ok(series.every((p) => p.value > 0));
  const g = panel((d, i) => 3 * i + 1, dates);
  close(corr.returnSeriesCorrelation(series, corr.factorReturnSeries(g, r)).value, 1, 1e-9);
  assert.equal(corr.returnSeriesCorrelation(series.slice(0, 5), series.slice(0, 5)).value, corr.UNKNOWN);
});

test('|ρ| 取截面值相关与因子收益相关的较大者；任一读不到即 UNKNOWN', () => {
  close(corr.maxAbsCorrelation(0.5, -0.8).value, 0.8);
  close(corr.maxAbsCorrelation(-0.71, 0.2).value, 0.71);
  assert.equal(corr.maxAbsCorrelation(0.5, corr.UNKNOWN).value, corr.UNKNOWN);
  assert.equal(corr.maxAbsCorrelation({ value: corr.UNKNOWN, reason: 'x' }, 0.1).value, corr.UNKNOWN);
});

test('去重门槛 0.7（严格大于才冲突，冻结前标 PENDING_FREEZE）：0.69 不冲突，0.70 不冲突，0.71 冲突', () => {
  assert.equal(DEDUPE.RHO_MAX, 0.7);
  assert.equal(DEDUPE.state, 'PENDING_FREEZE');
  const lib = (rho) => [{ factor_id: 'CN_A.MOM.OLD', icir_mining: 0.4, rho_cross_section: rho, rho_returns: 0.1 }];
  const cand = { factor_id: 'CN_A.MINED.NEW', icir_mining: 0.5 };
  assert.equal(corr.dedupeDecision({ candidate: cand, existing: lib(0.69) }).decision, 'NO_CONFLICT');
  assert.equal(corr.dedupeDecision({ candidate: cand, existing: lib(0.7) }).decision, 'NO_CONFLICT');
  const hit = corr.dedupeDecision({ candidate: cand, existing: lib(0.71) });
  assert.deepEqual(hit.conflicts, ['CN_A.MOM.OLD']);
  assert.equal(hit.decision, 'KEEP_NEW');
  assert.equal(hit.keep, 'CN_A.MINED.NEW');
  // 截面值只有 0.69，但因子收益相关 −0.71：取较大者，冲突
  const viaReturns = corr.dedupeDecision({ candidate: cand, existing: [{ factor_id: 'CN_A.MOM.OLD', icir_mining: 0.4, rho_cross_section: 0.69, rho_returns: -0.71 }] });
  assert.equal(viaReturns.decision, 'KEEP_NEW');
  close(viaReturns.pairs[0].rho_max, 0.71);
});

test('二者留一：ICIR 低的新因子不留；打平时留库里已有的；ICIR 读不到时也留已有的（失败即关）', () => {
  const existing = [{ factor_id: 'CN_A.MOM.OLD', icir_mining: 0.4, rho_cross_section: 0.71, rho_returns: 0.2 }];
  const lower = corr.dedupeDecision({ candidate: { factor_id: 'N', icir_mining: 0.39 }, existing });
  assert.equal(lower.decision, 'KEEP_EXISTING');
  assert.equal(lower.keep, 'CN_A.MOM.OLD');
  const tie = corr.dedupeDecision({ candidate: { factor_id: 'N', icir_mining: 0.4 }, existing });
  assert.equal(tie.decision, 'KEEP_EXISTING');
  assert.equal(tie.reason, 'ICIR_TIE_EXISTING_WINS');
  const unknown = corr.dedupeDecision({ candidate: { factor_id: 'N', icir_mining: null }, existing });
  assert.equal(unknown.decision, 'KEEP_EXISTING');
  assert.equal(unknown.reason, 'ICIR_UNKNOWN');
  // 和两个已有因子都冲突：要比两个都高才留新的
  const two = [...existing, { factor_id: 'CN_A.MOM.OLD2', icir_mining: 0.6, rho_cross_section: 0.1, rho_returns: 0.8 }];
  assert.equal(corr.dedupeDecision({ candidate: { factor_id: 'N', icir_mining: 0.5 }, existing: two }).decision, 'KEEP_EXISTING');
  assert.equal(corr.dedupeDecision({ candidate: { factor_id: 'N', icir_mining: 0.61 }, existing: two }).decision, 'KEEP_NEW');
  // 相关读不到：不判去留
  const unk = corr.dedupeDecision({ candidate: { factor_id: 'N', icir_mining: 0.9 }, existing: [{ factor_id: 'X', icir_mining: 0.1, rho_cross_section: corr.UNKNOWN, rho_returns: 0.1 }] });
  assert.equal(unk.decision, 'CORRELATION_UNKNOWN');
});

test('正交化：对已有因子做截面残差，残差与已有因子逐期不相关；正交化版本标为一次新尝试', () => {
  const existing = panel((d, i) => Math.sin(i + d) * 3 + i);
  const noise = (d, i) => ((i * 7919 + d * 104729) % 13) / 13 - 0.5;
  const candidate = panel((d, i) => 0.9 * (Math.sin(i + d) * 3 + i) + noise(d, i));
  assert.ok(corr.crossSectionalSpearman(candidate, existing).value > 0.7);
  const orth = corr.orthogonalise({ factor_id: 'CN_A.MINED.R001_C007', panel: candidate },
    [{ factor_id: 'CN_A.MOM.RS60_MARKET_PCT', panel: existing }]);
  assert.equal(orth.new_attempt, true);
  assert.equal(orth.counts_toward_n, true);
  assert.equal(orth.parent_factor_id, 'CN_A.MINED.R001_C007');
  assert.equal(orth.factor_id, 'CN_A.MINED.R001_C007.ORTH');
  assert.deepEqual(orth.orthogonalised_against, ['CN_A.MOM.RS60_MARKET_PCT']);
  for (const [d, row] of orth.panel.entries()) {
    const ids = Object.keys(row.values);
    const r = corr.pearson(ids.map((a) => row.values[a]), ids.map((a) => existing[d].values[a]));
    assert.ok(Math.abs(r) < 1e-9, `第 ${d} 期残差与已有因子相关 ${r}`);
  }
  // 去重选「正交化」：冲突的已有因子都要正交化掉，结果也标新尝试
  const viaOrth = corr.dedupeDecision({ candidate: { factor_id: 'CN_A.MINED.R001_C007', icir_mining: 0.2 },
    existing: [{ factor_id: 'CN_A.MOM.RS60_MARKET_PCT', icir_mining: 0.5, rho_cross_section: 0.9, rho_returns: 0.5 }], mode: 'ORTHOGONALISE' });
  assert.equal(viaOrth.decision, 'ORTHOGONALISE');
  assert.deepEqual(viaOrth.orthogonalise_against, ['CN_A.MOM.RS60_MARKET_PCT']);
  assert.equal(viaOrth.counts_as_new_attempt, true);
  // 已经正交化过的版本重新读相关：冲突都在已正交化名单里 → ORTHOGONALISED，仍是新尝试
  const after = corr.dedupeDecision({ candidate: { factor_id: orth.factor_id, icir_mining: 0.2, orthogonalised_against: orth.orthogonalised_against },
    existing: [{ factor_id: 'CN_A.MOM.RS60_MARKET_PCT', icir_mining: 0.5, rho_cross_section: 0.75, rho_returns: 0.1 }] });
  assert.equal(after.decision, 'ORTHOGONALISED');
  assert.equal(after.counts_as_new_attempt, true);
});

test('纯函数：输入面板不被改写', () => {
  const a = panel((d, i) => i); const b = panel((d, i) => -i);
  const snap = JSON.stringify([a, b]);
  corr.crossSectionalSpearman(a, b);
  corr.orthogonalise({ factor_id: 'X', panel: a }, [{ factor_id: 'Y', panel: b }]);
  corr.factorReturnSeries(a, b);
  assert.equal(JSON.stringify([a, b]), snap);
});
