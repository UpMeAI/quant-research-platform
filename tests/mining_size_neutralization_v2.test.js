'use strict';
/**
 * RF1116 修订 · 评分的市值中性化 V2（草稿 artifacts/coordinator/RF1116_AMENDMENT_SIZE_NEUTRALIZATION_20261118.draft.md §3，冻结之前是红测试）。
 * 缺陷：V1（减行业均值 → 对 log(total_mv) 一元线性回归取残差）对右偏的原始量级不起作用——-r4 尾段两天，总市值残差与对数市值的秩相关 −0.92、
 * 后复权收盘价 −0.70、成交额取负 +0.59（evidence/rf1116-round2-mechanisms-aqua-20261118/，SHA256SUMS 3cd26241）。
 * 合成截面（600 只、12 个行业、对数市值 = 21.3 + 指数分布(均值 1.2)，右偏，三天）复现这张表；V2 = 排名高斯 → 减行业均值 → 对排名高斯后的 total_mv 回归。
 * 第 1、2 轮按 LINEAR_RAW_V1，输出逐字节不变；新开的轮写 RANK_GAUSS_V2；G-MINE 第 8 项加市值暴露检查（★S2 默认 0.10）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'TEST_ROUND_RUNNER_AUTHORITY';
const evaluator = require('../services/mining-sandbox/evaluator');
const runner = require('../services/mining-sandbox/round-runner');
const rounds = require('../services/mining-rounds');
const gate = require('../services/mining-gate');

const ROOT = path.join(__dirname, '..');
const V1 = 'LINEAR_RAW_V1';
const V2 = 'RANK_GAUSS_V2';
const ROUND_1 = 'MR-CN_A-2026-11-e1ab63a27b';
const ROUND_2 = 'MR-CN_A-2026-11-2a1d2c9c82';
const SIZE_EXPOSURE_ABS_MAX = 0.10; // ★S2 默认
const GOLDEN_V1_SHA = 'bafb15bdb358c8b71d7711cada0248168b2c1d76bee1e1fa920bb54907ca374e'; // 现行代码（2c72c95）在下面夹具上的 V1 输出
const THRESHOLDS_V1_SHA = 'f8c495a942f04a440d780c6d85cb1235f9c0ec073fbcb3fd415c2ec4b5cf5343'; // config/mining_gate_thresholds.v1.json 不动

// ── 合成截面（确定性）────────────────────────────────────────────────
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function fixture(seed, n = 600, days = 3) {
  const r = mulberry32(seed); const nrm = () => { const u = 1 - r(); const v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const IND = Array.from({ length: 12 }, (_, k) => `IND${k}`);
  const ind = []; const size = []; const lx = []; const f = { total_mv: [], hfq: [], neg_amount: [], neg_turnover: [] };
  for (let t = 0; t < days; t += 1) {
    const it = []; const st = []; const lt = []; const row = { total_mv: [], hfq: [], neg_amount: [], neg_turnover: [] };
    for (let j = 0; j < n; j += 1) {
      const x = 21.3 + (-Math.log(1 - r())) * 1.2;
      it.push(IND[Math.floor(r() * IND.length)]); st.push(Math.exp(x)); lt.push(x);
      row.total_mv.push(Math.exp(x)); row.hfq.push(Math.exp(0.6 * x + 0.9 * nrm())); row.neg_amount.push(-Math.exp(x + 0.8 * nrm())); row.neg_turnover.push(-Math.exp(0.7 * nrm() - 0.1 * (x - 22.5)));
    }
    ind.push(it); size.push(st); lx.push(lt); for (const k of Object.keys(f)) f[k].push(row[k]);
  }
  return { panel: { industry: ind, size }, lx, f };
}
function ranks(xs) { const idx = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const rr = new Array(xs.length); for (let s = 0; s < idx.length;) { let e = s; while (e + 1 < idx.length && idx[e + 1][0] === idx[s][0]) e += 1; for (let k = s; k <= e; k += 1) rr[idx[k][1]] = (s + e) / 2; s = e + 1; } return rr; }
function spearman(x, y) { const rx = ranks(x); const ry = ranks(y); const m = (x.length - 1) / 2; let a = 0; let b = 0; let c = 0; for (let i = 0; i < x.length; i += 1) { a += (rx[i] - m) * (ry[i] - m); b += (rx[i] - m) ** 2; c += (ry[i] - m) ** 2; } return a / Math.sqrt(b * c); }
/** 逐日 Spearman(中性化后的值, log total_mv) 的均值（只取有限值）。 */
function exposure(values, lx) {
  const e = values.map((row, t) => { const xs = []; const ys = []; row.forEach((v, j) => { if (Number.isFinite(v)) { xs.push(v); ys.push(lx[t][j]); } }); return spearman(xs, ys); });
  return e.reduce((a, b) => a + b, 0) / e.length;
}
const FX = fixture(20261118);
const neutralize = (key, version) => evaluator.neutralizeForScoring({ values: FX.f[key] }, FX.panel, { neutralization: version });

test('T1 V1 复现发现：原始量级经线性中性化后仍带市值暴露（总市值 ≤ −0.8，后复权价位 ≤ −0.5，成交额取负 ≥ +0.7）', () => {
  assert.ok(exposure(neutralize('total_mv', V1).values, FX.lx) <= -0.8);
  assert.ok(exposure(neutralize('hfq', V1).values, FX.lx) <= -0.5);
  assert.ok(exposure(neutralize('neg_amount', V1).values, FX.lx) >= 0.7);
});

test('T2 V2（排名高斯 → 减行业均值 → 对排名高斯后的 total_mv 回归）：四种读数的暴露绝对值都 ≤ 0.10', () => {
  for (const key of ['total_mv', 'hfq', 'neg_amount', 'neg_turnover']) {
    const e = exposure(neutralize(key, V2).values, FX.lx);
    assert.ok(Math.abs(e) <= 0.10, `${key}: ${e}`);
  }
});

test('T3 V1 输出逐字节等于现行代码（黄金值）', () => {
  const out = {}; for (const key of Object.keys(FX.f)) out[key] = neutralize(key, V1).values;
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(out)).digest('hex'), GOLDEN_V1_SHA);
});

test('T4 不给版本 → MINE_EVAL_NEUTRALIZATION_REQUIRED；不认识的版本 → MINE_EVAL_NEUTRALIZATION_UNKNOWN', () => {
  assert.throws(() => evaluator.neutralizeForScoring({ values: FX.f.total_mv }, FX.panel), /MINE_EVAL_NEUTRALIZATION_REQUIRED/);
  assert.throws(() => evaluator.neutralizeForScoring({ values: FX.f.total_mv }, FX.panel, { neutralization: 'RANK_V9' }), /MINE_EVAL_NEUTRALIZATION_UNKNOWN/);
});

test('T5 戳：V1 写 version LINEAR_RAW_V1；V2 写 version、pre_transform、size_regressor；industry、size 两项照旧', () => {
  assert.deepEqual(neutralize('total_mv', V1).neutralization, { industry: 'APPLIED', size: 'APPLIED', version: V1, pre_transform: 'NONE', size_regressor: 'LOG_TOTAL_MV' });
  assert.deepEqual(neutralize('total_mv', V2).neutralization, { industry: 'APPLIED', size: 'APPLIED', version: V2, pre_transform: 'RANK_GAUSS', size_regressor: 'RANK_GAUSS_TOTAL_MV' });
});

test('T6 版本跟着轮走：第 1、2 轮按名单是 V1；写了字段的按字段；都没有 → MINE_RUNNER_NEUTRALIZATION_UNKNOWN；新开的轮写 RANK_GAUSS_V2', () => {
  assert.deepEqual([...runner.LEGACY_LINEAR_RAW_V1_ROUNDS].sort(), [ROUND_1, ROUND_2].sort());
  assert.equal(runner.neutralizationOf({ round_id: ROUND_1 }), V1);
  assert.equal(runner.neutralizationOf({ round_id: ROUND_2 }), V1);
  assert.equal(runner.neutralizationOf({ round_id: 'MR-CN_A-2026-12-0123456789', scoring_neutralization: V2 }), V2);
  assert.throws(() => runner.neutralizationOf({ round_id: 'MR-CN_A-2026-12-0123456789' }), /MINE_RUNNER_NEUTRALIZATION_UNKNOWN/);
  assert.throws(() => runner.neutralizationOf({ round_id: ROUND_2, scoring_neutralization: V2 }), /MINE_RUNNER_NEUTRALIZATION_UNKNOWN|MINE_RUNNER_NEUTRALIZATION_LEGACY_CONFLICT/);
  process.env.QRP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-size-v2-'));
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, cap: 2, openedAt: '2026-11-18T05:49:16+08:00' });
  assert.equal(rounds.roundHead(r.round_id).scoring_neutralization, V2);
});

/** 门：只看第 8 项里的市值暴露码；门槛块自带（单元测试，不核冻结页）。 */
const THRESHOLDS_V2 = Object.freeze({ state: 'FROZEN', ic_mean_min: 0.02, icir_min: 0.3, monotonicity_min: 0.9, decay_ratio_min: 0.5, marginal_ir_delta_min: 0, marginal_intercept_t_min: 2, size_exposure_abs_max: SIZE_EXPOSURE_ABS_MAX,
  frozen_ref: { path: 'artifacts/coordinator/SYNTHETIC_TEST_FREEZE.md', sha256: 'e'.repeat(64), frozen_at: '2026-11-20T10:00:00+08:00' } });
const SIZE_CODES = /^MINE_SIZE_EXPOSURE_/;
function sizeCodes(sizeExposure, version = V2) {
  const c = { candidate_id: 'X:A001', factor_id: 'X:A001', market: 'CN_A', holdout: { neutralization: { industry: 'APPLIED', size: 'APPLIED', version } } };
  if (sizeExposure !== undefined) c.size_exposure = sizeExposure;
  const res = gate.evaluate(c, { thresholds: THRESHOLDS_V2, familyTrialCount: 1 });
  const item8 = res.items.find((i) => i.item === 8);
  assert.ok(item8, JSON.stringify(res.codes));
  return { codes: item8.codes.filter((x) => SIZE_CODES.test(x)), item8 };
}
const exp = (value, days = 40) => ({ statistic: 'MEAN_DAILY_SPEARMAN_VS_LOG_TOTAL_MV', value, days, neutralization_version: V2 });

test('T7 G-MINE 第 8 项的市值暴露：0.5 → ABOVE_MAX；缺失、非有限、天数不够 → UNKNOWN；0.03 → 不挡；V1 结果 → 不判（NOT_APPLICABLE_ROUND_FROZEN_V1）', () => {
  assert.deepEqual(sizeCodes(exp(0.5)).codes, ['MINE_SIZE_EXPOSURE_ABOVE_MAX']);
  assert.deepEqual(sizeCodes(exp(-0.5)).codes, ['MINE_SIZE_EXPOSURE_ABOVE_MAX']);
  assert.deepEqual(sizeCodes(undefined).codes, ['MINE_SIZE_EXPOSURE_UNKNOWN']);
  assert.deepEqual(sizeCodes(exp(Number.NaN)).codes, ['MINE_SIZE_EXPOSURE_UNKNOWN']);
  assert.deepEqual(sizeCodes(exp(0.03, 3)).codes, ['MINE_SIZE_EXPOSURE_UNKNOWN']);
  assert.deepEqual(sizeCodes(exp(0.03)).codes, []);
  const legacy = sizeCodes(exp(-0.9), V1);
  assert.deepEqual(legacy.codes, []);
  assert.equal(legacy.item8.detail.size_exposure_check, 'NOT_APPLICABLE_ROUND_FROZEN_V1');
});

test('T8 门槛文件：v2 新建（六个数与 v1 逐个相等，加 size_exposure_abs_max ∈ (0, 1)）；v1 文件字节不变', () => {
  const v1Bytes = fs.readFileSync(path.join(ROOT, 'config/mining_gate_thresholds.v1.json'));
  assert.equal(crypto.createHash('sha256').update(v1Bytes).digest('hex'), THRESHOLDS_V1_SHA);
  const v1 = JSON.parse(v1Bytes);
  const v2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/mining_gate_thresholds.v2.json'), 'utf8'));
  assert.equal(v2.schema, 'MINING_GATE_THRESHOLDS_V2');
  for (const k of ['ic_mean_min', 'icir_min', 'monotonicity_min', 'decay_ratio_min', 'marginal_ir_delta_min', 'marginal_intercept_t_min']) assert.equal(v2[k], v1[k], k);
  assert.ok(Number.isFinite(v2.size_exposure_abs_max) && v2.size_exposure_abs_max > 0 && v2.size_exposure_abs_max < 1);
  assert.ok(['PENDING_FREEZE', 'FROZEN'].includes(v2.state));
});
