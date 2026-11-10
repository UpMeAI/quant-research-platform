'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const golden = require('./golden/overfit_independent.json');
const o = require('../services/trial-ledger/overfit');

// 金值来源：
//   (P) 已发表的算例：Bailey 与 López de Prado《The Deflated Sharpe Ratio》数值例（年化 SR 2.5、5 年日度 T = 1250、N = 100、
//       年化 V = 0.5、γ3 = −3、γ4 = 10 → 日度 SR0 ≈ 0.1132、DSR ≈ 0.9004）；修订 §3.2 的倍数表（N = 2…200）。
//   (I) 独立实现：tests/golden/overfit_independent.py（Python 标准库 statistics.NormalDist、itertools，与 overfit.js 分开写）的输出。
//   (A) 解析构造：PBO = 0（一列在每块都最好）与 PBO = 1（各列总收益相同，训练段最好的在检验段必然最差）。
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const series = ({ T, a, b, c }) => Array.from({ length: T }, (_, t) => a * Math.sin(t * 1.7) + b * Math.cos(t * 0.3) + c);

test('(I) Φ 与 Φ⁻¹ 对 Python statistics.NormalDist 一致到 1e-12', () => {
  for (const [x, v] of Object.entries(golden.normal.cdf)) close(o.normCdf(Number(x)), v, 1e-12, `Φ(${x})`);
  for (const [p, v] of Object.entries(golden.normal.inv)) close(o.normInv(Number(p)), v, 1e-9, `Φ⁻¹(${p})`);
  assert.throws(() => o.normInv(0), RangeError);
  assert.throws(() => o.normInv(1), RangeError);
});

test('(P) DSR：Bailey–López de Prado 数值例 SR0 ≈ 0.1132、DSR ≈ 0.9004', () => {
  const sr = 2.5 / Math.sqrt(250);
  const sr0 = o.expectedMaxSharpe(100, 0.5 / 250);
  close(sr0, 0.1132, 5e-4, 'SR0');
  close(o.psr({ sr, srStar: sr0, T: 1250, skew: -3, kurt: 10 }), 0.9004, 1e-3, 'DSR');
});

test('(P) 修订 §3.2 倍数表：N = 2…200（两位小数；N = 10 公式给 1.5746，表写 1.58，差在舍入，容差 0.01）', () => {
  const table = { 2: 0.52, 10: 1.58, 20: 1.90, 50: 2.28, 100: 2.53, 200: 2.77 };
  for (const [N, v] of Object.entries(table)) close(o.expectedMaxMultiplier(Number(N)), v, 0.01, `N=${N}`);
  assert.equal(o.expectedMaxMultiplier(1), 0);
  assert.equal(o.expectedMaxSharpe(1, 0.3), 0, 'N = 1 时 SR0 = 0');
  assert.throws(() => o.expectedMaxMultiplier(0), RangeError);
});

test('(I) ŜR、γ3、γ4、PSR(0)、V、SR0、DSR 对独立实现一致', () => {
  const g = golden.dsr_case;
  const d = series(g.series);
  const m = o.moments(d);
  close(m.sr, g.sr, 1e-12, 'ŜR'); close(m.skew, g.skew, 1e-10, 'γ3'); close(m.kurt, g.kurt, 1e-10, 'γ4');
  const r = o.deflatedSharpe({ d, N: g.N, familySharpes: g.family_sharpes });
  close(r.V, g.V, 1e-14, 'V'); close(r.sr0, g.sr0, 1e-10, 'SR0'); close(r.psr0, g.psr0, 1e-10, 'PSR(0)'); close(r.dsr, g.dsr, 1e-10, 'DSR');
});

test('DSR 边界：N = 1 → SR0 = 0、DSR = PSR(0)；T < 24、根号下 ≤ 0、已知 ŜR < 5 → UNKNOWN', () => {
  const d = series({ T: 60, a: 0.012, b: 0.005, c: 0.0035 });
  const one = o.deflatedSharpe({ d, N: 1, familySharpes: [0.1, 0.2, 0.3, 0.4, 0.5] });
  assert.equal(one.sr0, 0);
  assert.equal(one.dsr, one.psr0);
  const short = o.deflatedSharpe({ d: d.slice(0, 23), N: 10, familySharpes: [0.1, 0.2, 0.3, 0.4, 0.5] });
  assert.deepEqual([short.dsr.value, short.dsr.reason], ['UNKNOWN', 'T_LT_24']);
  const few = o.deflatedSharpe({ d, N: 10, familySharpes: [0.1, 0.2, 0.3, 0.4] });
  assert.deepEqual([few.dsr.value, few.dsr.reason], ['UNKNOWN', 'KNOWN_SR_LT_5']);
  assert.equal(o.psr({ sr: 1, srStar: 0, T: 60, skew: 3, kurt: 1 }).reason, 'PSR_RADICAND_NOT_POSITIVE');
  const flat = o.deflatedSharpe({ d: new Array(30).fill(0), N: 10, familySharpes: [0.1, 0.2, 0.3, 0.4, 0.5] });
  assert.equal(flat.dsr.value, 'UNKNOWN', '月度差全为 0（入场没变）→ ŜR 算不出');
  assert.equal(o.moments([0.1]).sr.reason, 'T_LT_2');
});

test('(I) PBO：两个合成矩阵对独立的 Python CSCV 一致（12,870 种组合，去掉最早 T mod 16 天）', () => {
  const R1 = Array.from({ length: 101 }, (_, t) => Array.from({ length: 5 }, (_, c) => (((t * 7 + c * 13 + ((t * c) % 11)) % 17) - 8) / 64));
  const p1 = o.pbo(R1);
  assert.equal(p1.combinations, 12870);
  assert.equal(p1.droppedRows, 101 % 16);
  close(p1.value, golden.pbo_case.pbo, 1e-15, 'PBO case 1');
  const R2 = Array.from({ length: 170 }, (_, t) => Array.from({ length: 6 }, (_, c) => (((t * t * 3 + c * 5 * t + c * c * 7 + 4 * t) % 23) - 11 + (c === 2 ? 0.5 : 0)) / 128));
  close(o.pbo(R2).value, golden.pbo_case_mid.pbo, 1e-15, 'PBO case 2');
});

test('(A) PBO 解析构造：一列处处最好 → 0；各列总收益相同 → 1；配置 < 4 不适用；每块不足 1 天 UNKNOWN', () => {
  const dominant = Array.from({ length: 64 }, (_, t) => [0.001 + (t % 3) * 1e-4, ((t * 5) % 7) * 1e-4, ((t * 3) % 5) * 1e-4, 0]);
  assert.equal(o.pbo(dominant).value, 0);
  // 各列 16 块的块和是同一组数的不同排列（步长 2c + 1 与 16 互素） → 列总收益相同，训练段越好检验段越差
  const vals = [3, -1, 4, 1, -5, 9, 2, -6, 5, 3.5, -5.5, 8, 9.5, -7, 2.5, 0.5];
  const n = 5; const size = 3;
  const R = [];
  for (let s = 0; s < 16; s += 1) for (let r = 0; r < size; r += 1) R.push(Array.from({ length: n }, (_, c) => (r === 0 ? vals[(s * (2 * c + 1) + c * 7) % 16] / 64 : 0)));
  assert.equal(o.pbo(R).value, 1);
  assert.equal(o.pbo(R.map((row) => row.slice(0, 3))).value, 'NOT_APPLICABLE');
  assert.equal(o.pbo(R.slice(0, 15)).value, 'UNKNOWN');
  // 并列：训练段并列取列序号小的；名次并列取平均
  assert.equal(o.internals.averageRank([1, 2, 2, 3], 1), 2.5);
});

test('(I) BHY 与 Holm 对独立实现一致；单调、≤ 1', () => {
  const { p, bhy, holm } = golden.multiple_testing;
  o.bhy(p).forEach((v, i) => close(v, bhy[i], 1e-15, `BHY[${i}]`));
  o.holm(p).forEach((v, i) => close(v, holm[i], 1e-15, `Holm[${i}]`));
  assert.deepEqual(o.bhy([0.9]), [0.9]);
  assert.throws(() => o.bhy([]), TypeError);
  assert.throws(() => o.holm([1.2]), TypeError);
});

test('★5 回退：B = max(10,000, 400·N)、α = 0.05/N、种子同 K2、可复现；明显为正过、明显为零不过', () => {
  const pos = series({ T: 48, a: 0.01, b: 0.004, c: 0.02 });
  const r1 = o.bonferroniFallback({ d: pos, N: 30, seed: 20261110 });
  assert.deepEqual([r1.B, r1.alpha, r1.rank], [12000, 0.05 / 30, 10]);
  assert.equal(r1.pass, true);
  assert.deepEqual(o.bonferroniFallback({ d: pos, N: 30, seed: 20261110 }), r1, '同种子同结果');
  const zeroMean = series({ T: 48, a: 0.01, b: 0.004, c: 0 });
  assert.equal(o.bonferroniFallback({ d: zeroMean, N: 1, seed: 7 }).pass, false);
  assert.equal(o.bonferroniFallback({ d: [0.1], N: 3, seed: 1 }).pass, false, 'T < 2：下界 UNKNOWN，不过');
  assert.equal(o.bonferroniFallback({ d: pos, N: 1, seed: 1 }).B, 10000);
  assert.throws(() => o.bonferroniFallback({ d: pos, N: 2, seed: 1.5 }), TypeError);
});

test('月度配对差：按月求和后相减，首尾不满月照算；不配对、乱序失败', () => {
  const t = [{ date: '2026-01-30', logret: 0.01 }, { date: '2026-02-02', logret: 0.02 }, { date: '2026-02-03', logret: -0.005 }];
  const b = [{ date: '2026-01-30', logret: 0.004 }, { date: '2026-02-02', logret: 0.01 }, { date: '2026-02-03', logret: 0 }];
  const d = o.monthlyPairedDiff(t, b);
  assert.deepEqual(d.map((x) => x.month), ['2026-01', '2026-02']);
  close(d[0].d, 0.006, 1e-15, 'Jan'); close(d[1].d, 0.005, 1e-15, 'Feb');
  assert.throws(() => o.monthlyPairedDiff(t, b.slice(1)), /NOT_PAIRED/);
  assert.throws(() => o.monthlyPairedDiff([t[1], t[0]], [b[1], b[0]]), /NOT_ASCENDING/);
});

test('N̂ = ρ̄ + (1 − ρ̄)·N，只取重叠 ≥ 24 个月的对', () => {
  const months = Array.from({ length: 30 }, (_, i) => `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  const a = Object.fromEntries(months.map((m, i) => [m, Math.sin(i)]));
  const b = Object.fromEntries(months.map((m, i) => [m, Math.sin(i)]));
  const r = o.effectiveN(10, { a, b });
  close(r.rhoBar, 1, 1e-12, 'ρ̄'); close(r.nHat, 1, 1e-12, 'N̂');
  const shortB = Object.fromEntries(months.slice(0, 20).map((m, i) => [m, Math.cos(i)]));
  assert.equal(o.effectiveN(10, { a, shortB }).nHat.value, 'UNKNOWN');
});

test('判定表「过拟合校正」：只降「做 · 有支持证据」到「做 · 证据不足」；从不判不做、从不升级', () => {
  const verdicts = [
    { decision: '做', strength: 'SUPPORTED' }, { decision: '做', strength: '有支持证据' }, { decision: '做', strength: 'INSUFFICIENT' },
    { decision: '做', strength: '证据不足' }, { decision: '不做', strength: 'SUPPORTED' }, { decision: '不做', strength: 'INSUFFICIENT' }, { decision: '不做', strength: null },
  ];
  const checks = [];
  for (const dsr of [0.99, 0.95, 0.94, 0.2, { value: 'UNKNOWN' }]) {
    for (const pboValue of [0.1, 0.5, 0.51, 'NOT_APPLICABLE', 'UNKNOWN']) {
      for (const fallback of [null, { pass: true }, { pass: false }]) checks.push({ dsr: typeof dsr === 'number' ? dsr : 'UNKNOWN', pbo: pboValue, fallback });
    }
  }
  for (const v of verdicts) {
    for (const c of checks) {
      const out = o.overfitColumn(v, c);
      assert.equal(out.decision, v.decision, '结论（做 / 不做）永远不变');
      const supported = v.decision === '做' && (v.strength === 'SUPPORTED' || v.strength === '有支持证据');
      if (!supported) { assert.equal(out.downgraded, false); assert.equal(out.strength, v.strength, '其他结论原样'); continue; }
      const dsrOk = typeof c.dsr === 'number' ? c.dsr >= 0.95 : Boolean(c.fallback && c.fallback.pass);
      const pboOk = typeof c.pbo === 'number' ? c.pbo <= 0.5 : c.pbo !== 'UNKNOWN';
      assert.equal(out.downgraded, !(dsrOk && pboOk), JSON.stringify(c));
      if (out.downgraded) { assert.equal(out.strength, 'INSUFFICIENT'); assert.equal(out.allowed_use, 'FORWARD_SHADOW_ONLY'); assert.equal(out.original.strength, v.strength); }
    }
  }
});
