'use strict';

/**
 * 因子库的相关性与去重 —— 研究框架修订 2026-11-16 草稿（ddeb2eea）§2.2 correlation、§2.3 相关性去重。纯函数：不读行情、不写文件、不改输入。
 *
 *   面板 panel：[{ date, values: { <证券>: 数 | null } }]，一期一行；null、缺键、非有限数都算「这一期没有这只证券的值」，从不当 0。
 *   - crossSectionalSpearman：每期取两边都有值的证券算 Spearman（平均秩），不足 MIN_ASSETS 只的期跳过，各期取算术平均；一期都没有 → UNKNOWN。
 *   - factorReturnSeries：每期把因子值做截面 z 分，因子收益 = 当期收益对 z 分的 OLS 斜率（有截距）；returnSeriesCorrelation：两条序列按日期对齐的 Pearson。
 *   - maxAbsCorrelation：去重读的 |ρ| = 两种相关绝对值的较大者；任一读不到 → UNKNOWN（失败即关，不拿另一个顶替）。
 *   - dedupeDecision：|ρ| > RHO_MAX（严格大于）算冲突。KEEP_ONE：挖掘段 ICIR 比每个冲突的已有因子都高才留新的，打平或读不到 ICIR 留已有的；
 *     ORTHOGONALISE：对冲突的已有因子正交化后再测，算一次新尝试。旧规则因子只作基准，去重决定从不改写任何规则。
 *   - orthogonalise：每期把候选与已有因子都做截面 z 分，候选对已有因子（可多个，加截距）做 OLS，取残差；结果标 new_attempt（计入 N）。
 */

const UNKNOWN = 'UNKNOWN';
/** 一期截面最少的证券数：少于它的期不算相关、不做回归。 */
const MIN_ASSETS = 5;
/** 因子收益相关最少的对齐期数。 */
const MIN_PERIODS = 12;
const DECISIONS = Object.freeze(['NO_CONFLICT', 'KEEP_NEW', 'KEEP_EXISTING', 'ORTHOGONALISE', 'ORTHOGONALISED', 'CORRELATION_UNKNOWN']);
const MODES = Object.freeze(['KEEP_ONE', 'ORTHOGONALISE']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const unknown = (reason, extra = {}) => ({ value: UNKNOWN, reason, ...extra });
const valueOf = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

/** 平均秩（1 起），并列取平均。 */
function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[order[k][1]] = r;
    i = j + 1;
  }
  return out;
}

/** Pearson；任一边方差为零时 null（读不到，不是 0）。 */
function pearson(a, b) {
  if (a.length !== b.length || a.length < 2) return null;
  const ma = mean(a); const mb = mean(b);
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < a.length; i += 1) { const da = a[i] - ma; const db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

const spearman = (a, b) => pearson(ranks(a), ranks(b));

/** 两期同日的公共证券（两边都是有限数），按代码排序。 */
function common(rowA, rowB) {
  const ids = Object.keys(rowA.values || {}).filter((id) => isNum(rowA.values[id]) && rowB.values && isNum(rowB.values[id]));
  return ids.sort();
}

function byDate(panel) {
  const m = new Map();
  for (const row of panel) {
    if (!row || typeof row.date !== 'string') throw new TypeError('panel: 每一期要写 date');
    if (m.has(row.date)) throw new TypeError(`panel: 日期重复 ${row.date}`);
    m.set(row.date, row);
  }
  return m;
}

/** 截面值相关：每期 Spearman 的各期均值。 */
function crossSectionalSpearman(panelA, panelB, { minAssets = MIN_ASSETS } = {}) {
  const b = byDate(panelB);
  const rhos = []; const skipped = [];
  for (const rowA of [...byDate(panelA).values()].sort((x, y) => (x.date < y.date ? -1 : 1))) {
    const rowB = b.get(rowA.date);
    if (!rowB) { skipped.push({ date: rowA.date, reason: 'DATE_MISSING' }); continue; }
    const ids = common(rowA, rowB);
    if (ids.length < minAssets) { skipped.push({ date: rowA.date, reason: `ASSETS_LT_${minAssets}` }); continue; }
    const rho = spearman(ids.map((id) => rowA.values[id]), ids.map((id) => rowB.values[id]));
    if (rho === null) { skipped.push({ date: rowA.date, reason: 'ZERO_VARIANCE' }); continue; }
    rhos.push(rho);
  }
  if (!rhos.length) return unknown('NO_COMPARABLE_DATE', { dates_used: 0, dates_skipped: skipped });
  return { value: mean(rhos), dates_used: rhos.length, dates_skipped: skipped };
}

function zscores(xs) {
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length);
  return sd > 0 ? xs.map((x) => (x - m) / sd) : null;
}

/** 因子收益序列：每期收益对截面 z 分的 OLS 斜率。returnPanel 的值是这一期之后持有期的收益（由调用方按 PIT 对齐）。 */
function factorReturnSeries(factorPanel, returnPanel, { minAssets = MIN_ASSETS } = {}) {
  const r = byDate(returnPanel);
  const out = [];
  for (const row of [...byDate(factorPanel).values()].sort((x, y) => (x.date < y.date ? -1 : 1))) {
    const ret = r.get(row.date);
    if (!ret) continue;
    const ids = common(row, ret);
    if (ids.length < minAssets) continue;
    const z = zscores(ids.map((id) => row.values[id]));
    if (!z) continue;
    const y = ids.map((id) => ret.values[id]);
    const my = mean(y);
    // z 均值 0、方差 1（总体）：斜率 = Σ z (y − ȳ) / Σ z²
    const slope = z.reduce((s, zi, i) => s + zi * (y[i] - my), 0) / z.reduce((s, zi) => s + zi * zi, 0);
    out.push({ date: row.date, value: slope });
  }
  return out;
}

/** 两条因子收益序列按日期对齐的 Pearson。 */
function returnSeriesCorrelation(seriesA, seriesB, { minPeriods = MIN_PERIODS } = {}) {
  const b = new Map(seriesB.filter((p) => isNum(p.value)).map((p) => [p.date, p.value]));
  const pairs = seriesA.filter((p) => isNum(p.value) && b.has(p.date)).map((p) => [p.value, b.get(p.date)]);
  if (pairs.length < minPeriods) return unknown(`PERIODS_LT_${minPeriods}`, { periods: pairs.length });
  const rho = pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  return rho === null ? unknown('ZERO_VARIANCE', { periods: pairs.length }) : { value: rho, periods: pairs.length };
}

/** 去重读的 |ρ|：两种相关绝对值的较大者；任一读不到即 UNKNOWN。 */
function maxAbsCorrelation(rhoCrossSection, rhoReturns) {
  const a = valueOf(rhoCrossSection); const b = valueOf(rhoReturns);
  if (!isNum(a)) return unknown('CROSS_SECTION_UNKNOWN');
  if (!isNum(b)) return unknown('RETURNS_UNKNOWN');
  return { value: Math.max(Math.abs(a), Math.abs(b)) };
}

/**
 * 去重决定（§2.3）。
 * @param {{factor_id: string, icir_mining: number|null, orthogonalised_against?: string[]}} candidate
 * @param {{factor_id: string, icir_mining: number|null, rho_cross_section: *, rho_returns: *}[]} existing  候选与库内每个因子的两种相关
 * @param {number} threshold  默认 RHO_MAX（index.js 的 DEDUPE，冻结前标 PENDING_FREEZE）
 * @param {'KEEP_ONE'|'ORTHOGONALISE'} mode
 */
function dedupeDecision({ candidate, existing, threshold, mode = 'KEEP_ONE' }) {
  if (!candidate || typeof candidate.factor_id !== 'string') throw new TypeError('dedupeDecision: candidate.factor_id');
  if (!Array.isArray(existing)) throw new TypeError('dedupeDecision: existing 必须是数组');
  if (!MODES.includes(mode)) throw new TypeError(`dedupeDecision: mode ${mode}`);
  const rhoMax = isNum(threshold) ? threshold : require('./index').DEDUPE.RHO_MAX;
  const pairs = existing.map((e) => {
    const m = maxAbsCorrelation(e.rho_cross_section, e.rho_returns);
    return { factor_id: e.factor_id, rho_max: m.value, rho_reason: m.reason || null, conflict: isNum(m.value) ? m.value > rhoMax : null };
  });
  const base = { candidate_id: candidate.factor_id, threshold: rhoMax, rule: 'ABS_RHO_GT_THRESHOLD', mode, pairs };
  if (pairs.some((p) => p.conflict === null)) {
    return { ...base, conflicts: [], decision: 'CORRELATION_UNKNOWN', keep: null, reason: 'CORRELATION_UNKNOWN', counts_as_new_attempt: false };
  }
  const conflicts = pairs.filter((p) => p.conflict).map((p) => p.factor_id);
  const already = Array.isArray(candidate.orthogonalised_against) ? candidate.orthogonalised_against : [];
  if (!conflicts.length) return { ...base, conflicts, decision: 'NO_CONFLICT', keep: candidate.factor_id, reason: null, counts_as_new_attempt: already.length > 0 };
  if (already.length && conflicts.every((id) => already.includes(id))) {
    return { ...base, conflicts, decision: 'ORTHOGONALISED', keep: candidate.factor_id, reason: 'CONFLICTS_ORTHOGONALISED', counts_as_new_attempt: true };
  }
  if (mode === 'ORTHOGONALISE') {
    return { ...base, conflicts, decision: 'ORTHOGONALISE', keep: null, orthogonalise_against: conflicts, reason: null, counts_as_new_attempt: true };
  }
  const ours = candidate.icir_mining;
  const theirs = existing.filter((e) => conflicts.includes(e.factor_id));
  if (!isNum(ours) || theirs.some((e) => !isNum(e.icir_mining))) {
    return { ...base, conflicts, decision: 'KEEP_EXISTING', keep: conflicts.length === 1 ? conflicts[0] : conflicts, reason: 'ICIR_UNKNOWN', counts_as_new_attempt: false };
  }
  const best = Math.max(...theirs.map((e) => e.icir_mining));
  if (ours > best) return { ...base, conflicts, decision: 'KEEP_NEW', keep: candidate.factor_id, reason: 'ICIR_HIGHER', counts_as_new_attempt: false };
  return { ...base, conflicts, decision: 'KEEP_EXISTING', keep: conflicts.length === 1 ? conflicts[0] : conflicts,
    reason: ours === best ? 'ICIR_TIE_EXISTING_WINS' : 'ICIR_LOWER', counts_as_new_attempt: false };
}

/** 解小规模正规方程（高斯消元，部分主元）；奇异返回 null。 */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * 截面正交化：候选 z 分对已有因子 z 分（加截距）做 OLS，取残差。某只证券缺任何一个已有因子的值，这一期它没有残差（不写这只证券）。
 * @returns {{factor_id, parent_factor_id, orthogonalised_against, new_attempt: true, counts_toward_n: true, panel, dates_skipped}}
 */
function orthogonalise(candidate, existingList, { minAssets = MIN_ASSETS } = {}) {
  if (!candidate || typeof candidate.factor_id !== 'string' || !Array.isArray(candidate.panel)) throw new TypeError('orthogonalise: candidate { factor_id, panel }');
  if (!Array.isArray(existingList) || !existingList.length) throw new TypeError('orthogonalise: 至少一个已有因子');
  const maps = existingList.map((e) => byDate(e.panel));
  const panel = []; const skipped = [];
  for (const row of [...byDate(candidate.panel).values()].sort((x, y) => (x.date < y.date ? -1 : 1))) {
    const rows = maps.map((m) => m.get(row.date));
    if (rows.some((r) => !r)) { skipped.push({ date: row.date, reason: 'DATE_MISSING' }); continue; }
    const ids = Object.keys(row.values || {}).filter((id) => isNum(row.values[id]) && rows.every((r) => r.values && isNum(r.values[id]))).sort();
    if (ids.length < Math.max(minAssets, existingList.length + 2)) { skipped.push({ date: row.date, reason: `ASSETS_LT_${minAssets}` }); continue; }
    const y = zscores(ids.map((id) => row.values[id]));
    const xs = rows.map((r) => zscores(ids.map((id) => r.values[id])));
    if (!y || xs.some((x) => !x)) { skipped.push({ date: row.date, reason: 'ZERO_VARIANCE' }); continue; }
    const X = ids.map((_, i) => [1, ...xs.map((x) => x[i])]);
    const k = X[0].length;
    const XtX = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (__, b) => X.reduce((s, r) => s + r[a] * r[b], 0)));
    const Xty = Array.from({ length: k }, (_, a) => X.reduce((s, r, i) => s + r[a] * y[i], 0));
    const beta = solve(XtX, Xty);
    if (!beta) { skipped.push({ date: row.date, reason: 'COLLINEAR' }); continue; }
    panel.push({ date: row.date, values: Object.fromEntries(ids.map((id, i) => [id, y[i] - X[i].reduce((s, x, j) => s + x * beta[j], 0)])) });
  }
  return {
    factor_id: `${candidate.factor_id}.ORTH`, parent_factor_id: candidate.factor_id,
    orthogonalised_against: existingList.map((e) => e.factor_id), new_attempt: true, counts_toward_n: true,
    method: 'CROSS_SECTIONAL_OLS_RESIDUAL_ON_ZSCORES', panel, dates_skipped: skipped,
  };
}

module.exports = {
  UNKNOWN, MIN_ASSETS, MIN_PERIODS, DECISIONS, MODES,
  ranks, pearson, spearman, crossSectionalSpearman, factorReturnSeries, returnSeriesCorrelation, maxAbsCorrelation, dedupeDecision, orthogonalise,
};
