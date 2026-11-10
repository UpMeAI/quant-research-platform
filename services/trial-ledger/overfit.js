'use strict';

/**
 * 过拟合校正的纯函数 —— 研究框架修订（2026-11-10，过拟合控制）§3，冻结页 1（★1–★17 取 (a)）。
 *
 *   ŜR、γ3、γ4、PSR、期望最大夏普 SR0、DSR（§3.2）；PBO（CSCV，§3.3）；BHY、Holm（§3.4、§4.3）；
 *   ★5 的 Bonferroni 回退（§3.5）；判定表「过拟合校正」一列（§3.5）。
 *
 * 只算统计量，不读台账、不写文件、不改任何结论以外的东西。算不出时返回 { value: 'UNKNOWN', reason }，不填 0，不估。
 * 正态分布函数不用查表系数：Φ 用 erf 的幂级数（|x| ≤ 3）与 erfc 的连分式（|x| > 3），Φ⁻¹ 用牛顿迭代反解 Φ。
 */

const EULER_GAMMA = 0.5772156649; // §3.2 原文的取值
const E = 2.718281828; // §3.2 原文的取值
const UNKNOWN = 'UNKNOWN';
const unknown = (reason) => Object.freeze({ value: UNKNOWN, reason });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── 正态分布 ────────────────────────────────────────────────────────────────────

function erfSeries(z) {
  // erf(z) = 2/√π · Σ (−1)^n z^(2n+1) / (n! (2n+1))
  let term = z; let sum = z;
  for (let n = 1; n < 200; n += 1) {
    term *= -z * z / n;
    const add = term / (2 * n + 1);
    sum += add;
    if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
  }
  return (2 / Math.sqrt(Math.PI)) * sum;
}

function erfcContinuedFraction(z) {
  // erfc(z) = exp(−z²)/√π · 1/(z + (1/2)/(z + 1/(z + (3/2)/(z + 2/(z + …)))))，z > 0
  let f = z;
  for (let k = 120; k >= 1; k -= 1) f = z + (k / 2) / f;
  return Math.exp(-z * z) / Math.sqrt(Math.PI) / f;
}

/** 标准正态分布函数 Φ(x)。 */
function normCdf(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const z = Math.abs(x) / Math.SQRT2;
  if (Math.abs(x) <= 3) return 0.5 * (1 + Math.sign(x) * erfSeries(z));
  const tail = 0.5 * erfcContinuedFraction(z);
  return x > 0 ? 1 - tail : tail;
}

const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** 标准正态分位数 Φ⁻¹(p)，0 < p < 1：从 0 起牛顿迭代反解 Φ，步子过大时减半。 */
function normInv(p) {
  if (!(p > 0 && p < 1)) throw new RangeError(`normInv: p 必须在 (0, 1) 内：${p}`);
  if (p === 0.5) return 0;
  // 尾部初值：Φ⁻¹(p) ≈ ±√(−2 ln q)（q 为较小尾概率），中段从 0 起
  const q = Math.min(p, 1 - p);
  let x = q < 0.1 ? Math.sign(p - 0.5) * Math.sqrt(-2 * Math.log(q)) * 0.9 : 0;
  for (let i = 0; i < 100; i += 1) {
    const err = normCdf(x) - p;
    let step = err / Math.max(normPdf(x), 1e-300);
    if (Math.abs(step) > 1) step = Math.sign(step);
    x -= step;
    if (Math.abs(step) < 1e-15 * Math.max(1, Math.abs(x))) break;
  }
  return x;
}

// ── 矩与夏普（§3.2） ────────────────────────────────────────────────────────────

/** ŜR = mean/sd（sd 分母 T − 1，不年化）；γ3 = m3/m2^1.5，γ4 = m4/m2²（m_k 分母 T；γ4 是峰度本身，正态 = 3）。 */
function moments(series) {
  if (!Array.isArray(series) || !series.every(isNum)) throw new TypeError('moments: 序列必须是有限数的数组');
  const T = series.length;
  if (T < 2) return { T, mean: T ? series[0] : null, sd: null, sr: unknown('T_LT_2'), skew: unknown('T_LT_2'), kurt: unknown('T_LT_2') };
  const mean = series.reduce((a, b) => a + b, 0) / T;
  let s2 = 0; let s3 = 0; let s4 = 0;
  for (const x of series) { const d = x - mean; s2 += d * d; s3 += d * d * d; s4 += d * d * d * d; }
  const m2 = s2 / T; const m3 = s3 / T; const m4 = s4 / T;
  const sd = Math.sqrt(s2 / (T - 1));
  if (!(sd > 0)) return { T, mean, sd, sr: unknown('ZERO_VARIANCE'), skew: unknown('ZERO_VARIANCE'), kurt: unknown('ZERO_VARIANCE') };
  return { T, mean, sd, sr: mean / sd, skew: m3 / m2 ** 1.5, kurt: m4 / (m2 * m2) };
}

/** PSR(SR*) = Φ((ŜR − SR*)·√(T − 1) / √(1 − γ3·ŜR + (γ4 − 1)/4·ŜR²))；根号下 ≤ 0 → UNKNOWN。 */
function psr({ sr, srStar = 0, T, skew, kurt }) {
  if (![sr, srStar, T, skew, kurt].every(isNum)) return unknown('PSR_INPUT_UNKNOWN');
  if (T < 2) return unknown('T_LT_2');
  const radicand = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (!(radicand > 0)) return unknown('PSR_RADICAND_NOT_POSITIVE');
  return normCdf(((sr - srStar) * Math.sqrt(T - 1)) / Math.sqrt(radicand));
}

/** 方括号里的倍数：(1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))；N = 1 → 0。 */
function expectedMaxMultiplier(N) {
  if (!Number.isInteger(N) || N < 1) throw new RangeError(`N 必须是 ≥ 1 的整数：${N}`);
  if (N === 1) return 0;
  return (1 - EULER_GAMMA) * normInv(1 - 1 / N) + EULER_GAMMA * normInv(1 - 1 / (N * E));
}

/** SR0 = √V · 倍数（§3.2）；N = 1 时 SR0 = 0。 */
function expectedMaxSharpe(N, V) {
  if (N === 1) return 0;
  if (!isNum(V) || V < 0) return unknown('V_UNKNOWN');
  return Math.sqrt(V) * expectedMaxMultiplier(N);
}

/** 样本方差（分母 n − 1）。 */
function sampleVariance(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
}

const MIN_T = 24;
const MIN_KNOWN_SR = 5;

/**
 * DSR = PSR(SR0)（§3.2）。
 * @param {number[]} d      判定臂的月度配对差序列（§3.1）
 * @param {number}   N      本族原始试验计数（★2，不用 N̂）
 * @param {number[]} familySharpes 本族已知 ŜR 的账本级试验（含本题各臂）的 ŜR，一配置一个
 * T < 24、根号下 ≤ 0、已知 ŜR < 5 个 → DSR = UNKNOWN（改用 ★5 回退）。
 */
function deflatedSharpe({ d, N, familySharpes }) {
  const m = moments(d);
  const known = (familySharpes || []).filter(isNum);
  const V = known.length >= MIN_KNOWN_SR ? sampleVariance(known) : null;
  const base = { T: m.T, sr: m.sr, skew: m.skew, kurt: m.kurt, N, V: V === null ? unknown(`KNOWN_SR_LT_${MIN_KNOWN_SR}`) : V, knownSr: known.length };
  const psr0 = isNum(m.sr) ? psr({ sr: m.sr, srStar: 0, T: m.T, skew: m.skew, kurt: m.kurt }) : unknown('SR_UNKNOWN');
  if (m.T < MIN_T) return { ...base, psr0, sr0: V === null ? unknown(`KNOWN_SR_LT_${MIN_KNOWN_SR}`) : expectedMaxSharpe(N, V), dsr: unknown(`T_LT_${MIN_T}`) };
  if (!isNum(m.sr)) return { ...base, psr0, sr0: unknown('SR_UNKNOWN'), dsr: unknown(m.sr.reason) };
  if (V === null) return { ...base, psr0, sr0: unknown(`KNOWN_SR_LT_${MIN_KNOWN_SR}`), dsr: unknown(`KNOWN_SR_LT_${MIN_KNOWN_SR}`) };
  const sr0 = expectedMaxSharpe(N, V);
  const dsr = psr({ sr: m.sr, srStar: sr0, T: m.T, skew: m.skew, kurt: m.kurt });
  return { ...base, psr0, sr0, dsr };
}

// ── N̂（只披露） ────────────────────────────────────────────────────────────────

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n; const mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < n; i += 1) { const da = a[i] - ma; const db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/**
 * N̂ = ρ̄ + (1 − ρ̄)·N；ρ̄ = 两两试验月度 d 序列相关系数的平均，只取重叠 ≥ 24 个月的对。
 * @param {Object<string, Object<string, number>>} seriesByTrial  trial_id → { 'YYYY-MM': d }
 */
function effectiveN(N, seriesByTrial, minOverlap = MIN_T) {
  const ids = Object.keys(seriesByTrial || {}).sort();
  const rhos = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = seriesByTrial[ids[i]]; const b = seriesByTrial[ids[j]];
      const months = Object.keys(a).filter((k) => k in b).sort();
      if (months.length < minOverlap) continue;
      const rho = pearson(months.map((k) => a[k]), months.map((k) => b[k]));
      if (rho !== null) rhos.push(rho);
    }
  }
  if (!rhos.length) return { nHat: unknown('NO_PAIR_WITH_OVERLAP_GE_24'), rhoBar: unknown('NO_PAIR_WITH_OVERLAP_GE_24'), pairs: 0 };
  const rhoBar = rhos.reduce((x, y) => x + y, 0) / rhos.length;
  return { nHat: rhoBar + (1 - rhoBar) * N, rhoBar, pairs: rhos.length };
}

// ── 月度配对差（§3.1） ──────────────────────────────────────────────────────────

/**
 * d_t = 当月 T 的日对数收益之和 − 当月 B 的日对数收益之和。首尾不满月照算；日历月按账本的交易日（加密按 UTC 日期）。
 * @param {{date: string, logret: number}[]} t  判定臂日序列（date 为 YYYY-MM-DD，加密用 UTC 日期）
 * @param {{date: string, logret: number}[]} b  基线日序列；两边日期必须逐日一致（配对）
 */
function monthlyPairedDiff(t, b) {
  if (!Array.isArray(t) || !Array.isArray(b) || t.length !== b.length) throw new Error('TRIAL_LEDGER_SERIES_NOT_PAIRED:length');
  const months = new Map();
  for (let i = 0; i < t.length; i += 1) {
    const dt = t[i]; const db = b[i];
    if (!dt || !db || dt.date !== db.date || !/^\d{4}-\d{2}-\d{2}$/.test(dt.date)) throw new Error(`TRIAL_LEDGER_SERIES_NOT_PAIRED:${i}`);
    if (!isNum(dt.logret) || !isNum(db.logret)) throw new Error(`TRIAL_LEDGER_SERIES_NOT_FINITE:${dt.date}`);
    if (i && dt.date <= t[i - 1].date) throw new Error(`TRIAL_LEDGER_SERIES_NOT_ASCENDING:${dt.date}`);
    const key = dt.date.slice(0, 7);
    const row = months.get(key) || { t: 0, b: 0 };
    row.t += dt.logret; row.b += db.logret;
    months.set(key, row);
  }
  return [...months.entries()].map(([month, row]) => ({ month, d: row.t - row.b }));
}

// ── PBO：组合对称交叉验证（§3.3） ───────────────────────────────────────────────

const PBO_BLOCKS = 16;
const PBO_MIN_CONFIGS = 4;

function combinations(n, k) {
  const out = []; const pick = [];
  (function rec(start) {
    if (pick.length === k) { out.push(pick.slice()); return; }
    for (let i = start; i <= n - (k - pick.length); i += 1) { pick.push(i); rec(i + 1); pick.pop(); }
  }(0));
  return out;
}

/** 从差到好 1…n 的名次，并列取平均名次。 */
function averageRank(values, index) {
  const v = values[index];
  let below = 0; let equal = 0;
  for (const x of values) { if (x < v) below += 1; else if (x === v) equal += 1; }
  return below + (equal + 1) / 2;
}

/**
 * PBO（CSCV）。
 * @param {number[][]} R  行 = 共同窗口的交易日（时间升序），列 = n 个配置的日对数收益
 * 去掉最早的 T mod 16 天，连续等分 16 块；对 C(16,8) = 12,870 种训练 J / 检验 J̄ 组合：训练段取对数收益之和最好的一列（并列取列序号小的），
 * ω = 它在 J̄ 上的名次 / (n + 1)，λ = ln(ω / (1 − ω))；PBO = #{λ ≤ 0} / 12,870。
 * 配置 < 4 → NOT_APPLICABLE（由 DSR 承担）；每块不足 1 天 → UNKNOWN。
 */
function pbo(R, { blocks = PBO_BLOCKS } = {}) {
  if (!Array.isArray(R) || !R.length) return { value: 'NOT_APPLICABLE', reason: 'NO_MATRIX' };
  const n = R[0].length;
  if (n < PBO_MIN_CONFIGS) return { value: 'NOT_APPLICABLE', reason: `CONFIGS_LT_${PBO_MIN_CONFIGS}`, configs: n };
  if (!R.every((row) => Array.isArray(row) && row.length === n && row.every(isNum))) throw new TypeError('pbo: 矩阵每行必须是同长的有限数数组');
  const T = R.length;
  const size = Math.floor(T / blocks);
  if (size < 1) return { ...unknown(`ROWS_LT_${blocks}`), configs: n, rows: T };
  const start = T % blocks;
  const blockSums = [];
  for (let s = 0; s < blocks; s += 1) {
    const sums = new Array(n).fill(0);
    for (let r = start + s * size; r < start + (s + 1) * size; r += 1) for (let c = 0; c < n; c += 1) sums[c] += R[r][c];
    blockSums.push(sums);
  }
  const combos = combinations(blocks, blocks / 2);
  let overfit = 0;
  const lambdas = [];
  for (const train of combos) {
    const inTrain = new Array(blocks).fill(false);
    for (const s of train) inTrain[s] = true;
    const is = new Array(n).fill(0); const oos = new Array(n).fill(0);
    for (let s = 0; s < blocks; s += 1) { const target = inTrain[s] ? is : oos; for (let c = 0; c < n; c += 1) target[c] += blockSums[s][c]; }
    let best = 0;
    for (let c = 1; c < n; c += 1) if (is[c] > is[best]) best = c;
    const omega = averageRank(oos, best) / (n + 1);
    const lambda = Math.log(omega / (1 - omega));
    lambdas.push(lambda);
    if (lambda <= 0) overfit += 1;
  }
  return { value: overfit / combos.length, combinations: combos.length, overfit, configs: n, rows: T, droppedRows: start, blockSize: size, lambdas };
}

// ── 多重检验（§3.4、§4.3） ──────────────────────────────────────────────────────

const checkP = (p) => { if (!Array.isArray(p) || !p.length || !p.every((x) => isNum(x) && x >= 0 && x <= 1)) throw new TypeError('p 值必须是 [0, 1] 内的数组'); };

/** BHY：c(m) = Σ 1/i；校正后 p_(i) = min_{j ≥ i} min(1, m·c(m)·p_(j)/j)。按原顺序返回。 */
function bhy(pValues) {
  checkP(pValues);
  const m = pValues.length;
  let cm = 0; for (let i = 1; i <= m; i += 1) cm += 1 / i;
  const order = pValues.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const adj = new Array(m);
  let running = 1;
  for (let k = m - 1; k >= 0; k -= 1) { running = Math.min(running, Math.min(1, (m * cm * order[k][0]) / (k + 1))); adj[order[k][1]] = running; }
  return adj;
}

/** Holm：校正后 p_(i) = max_{j ≤ i} min(1, (m − j + 1)·p_(j))。按原顺序返回。 */
function holm(pValues) {
  checkP(pValues);
  const m = pValues.length;
  const order = pValues.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const adj = new Array(m);
  let running = 0;
  for (let k = 0; k < m; k += 1) { running = Math.max(running, Math.min(1, (m - k) * order[k][0])); adj[order[k][1]] = running; }
  return adj;
}

// ── ★5 回退：按族 N 的 Bonferroni（§3.5） ───────────────────────────────────────

/** mulberry32：32 位种子的确定性均匀数（QRP 复算用；与种子同 K2）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Δg 的双侧 1 − 0.05/N 区间下界 > 0。B = max(10,000, 400·N)，种子同 K2。
 * 在月度配对差 d 上按月有放回重抽（即按月分块），统计量 = 重抽样本的均值（与 Δg 同号、同序：Δg 是 d 的正倍数）；
 * 下界取第 max(1, ⌊B·α/2⌋) 小的抽样值（α = 0.05/N）。
 */
function bonferroniFallback({ d, N, seed }) {
  if (!Number.isInteger(N) || N < 1) throw new RangeError(`N 必须是 ≥ 1 的整数：${N}`);
  if (!Number.isInteger(seed)) throw new TypeError('seed 必须是整数（同 K2）');
  if (!Array.isArray(d) || !d.every(isNum)) throw new TypeError('d 必须是有限数的数组');
  const T = d.length;
  const B = Math.max(10000, 400 * N);
  const alpha = 0.05 / N;
  const base = { method: 'BONFERRONI_BY_FAMILY_N', N, B, seed, alpha, T };
  if (T < 2) return { ...base, lower: unknown('T_LT_2'), pass: false };
  const rand = mulberry32(seed);
  const stats = new Float64Array(B);
  for (let b = 0; b < B; b += 1) {
    let sum = 0;
    for (let i = 0; i < T; i += 1) sum += d[Math.floor(rand() * T)];
    stats[b] = sum / T;
  }
  stats.sort();
  const k = Math.max(1, Math.floor((B * alpha) / 2));
  const lower = stats[k - 1];
  return { ...base, rank: k, lower, pass: lower > 0 };
}

// ── 判定表「过拟合校正」一列（§3.5） ───────────────────────────────────────────

const DSR_MIN = 0.95; // ★4 (a)
const PBO_MAX = 0.5; // ★6 (a)
const SUPPORTED = new Set(['SUPPORTED', '有支持证据']);
const DOWNGRADED_LABEL = '做 · 证据不足（过拟合校正）';

/**
 * 只对「做 · 有支持证据」加条件：DSR ≥ 0.95（DSR 为 UNKNOWN 时改用 ★5 回退）；适用时 PBO ≤ 0.5。
 * 不满足 → 降为「做 · 证据不足（过拟合校正）」，允许用途只剩前向影子。其他结论原样返回。
 * 永不把「不做」变成「做」，不把「证据不足」升为「有支持证据」，也不判「不做」。
 */
function overfitColumn(verdict, { dsr, pbo: pboValue, fallback } = {}) {
  const original = Object.freeze({ ...verdict });
  if (!(verdict && verdict.decision === '做' && SUPPORTED.has(verdict.strength))) {
    return { ...verdict, original, applied: false, downgraded: false, failed: [] };
  }
  const failed = [];
  if (isNum(dsr)) { if (!(dsr >= DSR_MIN)) failed.push(`DSR_LT_${DSR_MIN}`); } else if (!(fallback && fallback.pass === true)) failed.push('DSR_UNKNOWN_AND_BONFERRONI_FALLBACK_NOT_PASSED');
  if (isNum(pboValue)) { if (!(pboValue <= PBO_MAX)) failed.push(`PBO_GT_${PBO_MAX}`); } else if (pboValue === UNKNOWN || (pboValue && pboValue.value === UNKNOWN)) failed.push('PBO_APPLICABLE_BUT_UNKNOWN');
  if (!failed.length) return { ...verdict, original, applied: true, downgraded: false, failed };
  return { ...verdict, decision: '做', strength: 'INSUFFICIENT', label_zh: DOWNGRADED_LABEL, allowed_use: 'FORWARD_SHADOW_ONLY', original, applied: true, downgraded: true, failed };
}

module.exports = {
  EULER_GAMMA, E, UNKNOWN, MIN_T, MIN_KNOWN_SR, PBO_BLOCKS, PBO_MIN_CONFIGS, DSR_MIN, PBO_MAX, DOWNGRADED_LABEL,
  normCdf, normInv, moments, psr, expectedMaxMultiplier, expectedMaxSharpe, sampleVariance, deflatedSharpe, effectiveN,
  monthlyPairedDiff, pbo, bhy, holm, mulberry32, bonferroniFallback, overfitColumn,
  internals: { erfSeries, erfcContinuedFraction, combinations, averageRank, pearson },
};
