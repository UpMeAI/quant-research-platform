'use strict';

/**
 * 留出段打分（RF1116 §3.6；P2 规格 §1 第 7 步；MINING_ROUNDS_V1「P2 requirements」：执行器是留出段结果的唯一生产者，经 neutralizeForScoring 产出）。
 * 只给执行器（./index.js）用：输入是开过留出段之后建的 HOLDOUT 面板，输出是 G-MINE 的候选结果对象（字段见 FACTOR_LIBRARY_V1 §4），
 * 交 services/mining-rounds/gate-records 的 recordGateResult 去判、去记。
 *
 *   先中性化：因子值先过 ../scoring 的 neutralizedValues（即求值器的 neutralizeForScoring，行业 + 市值，只在股票池里），结果带 neutralization 戳；
 *   打分日：决策日在留出段里、标签（H 或 2H 个交易日后的开盘）也在留出段里（面板到留出段终点为止，所以最后 H 天没有标签）。
 *   3  ic_mean = 逐日 rank IC 的均值；icir = 每隔 H 天（不重叠的持有期）取一天的 IC，均值 ÷ 样本标准差；
 *   4  quintile_mean_returns：在不重叠的打分日按中性化后的因子分五组（组 1 最低），各组 H 日收益的均值，再对各期取均值；
 *   5  ic_double_horizon = 持有期 2H 的逐日 rank IC 均值；
 *   6  net_of_cost：不重叠的打分日调仓，只做多池里前 20%，等权；成本按 G-COST 的 CN_A 下限（佣金 2.5 + 滑点 10 bps，单边）、卖出另加印花税 5 bps（2023-08-28 起，R1.7 接受）；
 *      涨跌停按 V6 实盘的板块规则（R1.7）：开盘涨停买不进、开盘跌停卖不出（limit_events 计数）；
 *      基准 = 池里等权（不计成本）；年化超额 = (Π(1+净) / Π(1+基准))^(242 / 持有天数) − 1；
 *   1  DSR（R1.3）：在前推验证折的月度配对差（组合净收益 − 基准）上算，N = 本族累计尝试数（验证折约 33 个月）；
 *   2  PBO：本轮所有交去打分的候选的逐日超额（log(1 + 组合 − 基准)）做 CSCV（overfit.pbo），pbo_scope = ROUND_CANDIDATE_SET；不足 4 个候选 → NOT_APPLICABLE；
 *   7  边际贡献、8 与库内因子的相关性（R1.4）：读登记过的现有因子序列（FACTOR_SERIES_V1）；对不上个股的（ETF 级）、没给的照实 UNKNOWN；
 *   9  机制（R1.5）：留出段开启之前写的机制登记；没有登记的 mechanism null（门判 MINE_MECHANISM_UNKNOWN），写原因。
 * 算不出的一律写 null 或 UNKNOWN 与原因，不填 0、不跳过。
 */
const segs = require('../segments');
const scoring = require('../scoring');
const overfit = require('../../trial-ledger/overfit');
const costGate = require('../../cost-gate');
const factorLib = require('../../factor-library');
const limits = require('../price-limits');

const NET = Object.freeze({
  long_only: true, top_fraction: 0.2, benchmark: 'EQUAL_WEIGHT_UNIVERSE', trading_days_per_year: 242,
  cost: Object.freeze({ commission_bps: costGate.FLOORS.CN_A.commission_bps_min, slippage_bps: costGate.FLOORS.CN_A.slippage_bps_min, stamp_duty_on_sell: true, stamp_duty_bps: 5 }),
  limit_moves: 'MODELLED_V6_BOARD_BANDS',
});
const QUINTILES = 5;

class HoldoutScoreError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new HoldoutScoreError(`MINE_HOLDOUT_SCORE_${code}`, detail); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs) => { if (xs.length < 2) return null; const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };

/** window = 这一轮留出段的窗口 { from, to }；不给就是 segments.js 的 HOLDOUT（R1），与之前逐字相同（RF1116 第二段修订：R2 给解析出来的窗口）。 */
function assertHoldoutPanel(panel, window = segs.SEGMENTS.HOLDOUT) {
  const h = window; const d = panel && panel.dates;
  if (!panel || panel.segment !== 'HOLDOUT' || !d || !d.length || d[d.length - 1] !== h.to) fail('NOT_HOLDOUT_PANEL', `${panel && panel.segment}:${d && d[d.length - 1]}`);
}

/** 留出段的打分日下标（决策日在留出段里）。 */
const holdoutDays = (panel, window = segs.SEGMENTS.HOLDOUT) => panel.dates.map((d, t) => (d >= window.from ? t : -1)).filter((t) => t >= 0);

/**
 * 一个候选的只做多持仓（第 6 项；R1.3 的验证折月度序列也用它）。days = 打分日下标；每隔 H 个打分日调仓：
 *   目标 = 池里、因子有数、当天有开盘价的名字里前 20%（等权）；
 *   涨跌停（R1.7，../../price-limits，照 V6 实盘的板块规则）：要买的开盘涨停 → 不买；要卖的开盘跌停 → 卖不出、留着；没有开盘价同理；
 *   成本：买入的权重 × (佣金 + 滑点)，卖出的权重 × (佣金 + 滑点 + 印花税)；收益按持有期末（或之前最后一个有价的日子）的后复权开盘价算；
 *   基准 = 池里当天有开盘价的名字等权（不计成本）。
 * 返回逐期净收益与基准、逐日超额（PBO 用）、按月的配对差（DSR 用）、年化超额、涨跌停事件数。
 */
function longOnly(values, panel, H, days) {
  const ex = panel.labels.exec_open; const N = panel.codes.length; const T = panel.dates.length;
  const L = panel.labels;
  if (!Array.isArray(L.open_raw) || !Array.isArray(L.prev_close_raw) || !Array.isArray(panel.board) || !Array.isArray(panel.st)) fail('LIMIT_INPUT_MISSING');
  const band = (t, j) => limits.bandOf({ board: panel.board[j], st: panel.st[t][j], date: panel.dates[t] }).pct;
  const quote = (t, j) => ({ open: L.open_raw[t][j], prevClose: L.prev_close_raw[t][j], pct: band(t, j) });
  const lastEx = (j, a, b) => { for (let s = b; s > a; s -= 1) if (ex[s][j] > 0) return ex[s][j]; return null; };
  const rebalance = days.filter((_, k) => k % H === 0);
  const periods = []; const daily = []; const months = new Map();
  const events = { entry_blocked_limit_up: 0, exit_carried_limit_down: 0, entry_blocked_no_open: 0, exit_carried_no_open: 0 };
  let held = [];
  for (const t of rebalance) {
    if (t + H >= T) break;
    const bench = []; const pool = [];
    for (let j = 0; j < N; j += 1) {
      if (!panel.universe[t][j] || !(ex[t][j] > 0)) continue;
      bench.push(j);
      if (isNum(values[t][j])) pool.push(j);
    }
    if (pool.length < scoring.MIN_NAMES) continue;
    pool.sort((a, b) => values[t][b] - values[t][a] || a - b);
    const target = pool.slice(0, Math.max(1, Math.floor(NET.top_fraction * pool.length)));
    const tgt = new Set(target);
    const keep = []; let sold = 0;
    for (const j of held) {
      if (tgt.has(j)) { keep.push(j); continue; }
      const q = quote(t, j);
      if (limits.canSell(q)) { sold += 1; continue; }
      keep.push(j); if (isNum(q.open) && q.open > 0) events.exit_carried_limit_down += 1; else events.exit_carried_no_open += 1;
    }
    let bought = 0;
    for (const j of target) {
      if (keep.includes(j)) continue;
      const q = quote(t, j);
      if (!limits.canBuy(q)) { if (isNum(q.open) && q.open > 0) events.entry_blocked_limit_up += 1; else events.entry_blocked_no_open += 1; continue; }
      keep.push(j); bought += 1;
    }
    const c = NET.cost;
    const cost = ((keep.length ? bought / keep.length : 0) * (c.commission_bps + c.slippage_bps) + (held.length ? sold / held.length : 0) * (c.commission_bps + c.slippage_bps + c.stamp_duty_bps)) / 1e4;
    const ret = (j) => { const p1 = lastEx(j, t, t + H); return ex[t][j] > 0 && p1 ? p1 / ex[t][j] - 1 : null; };
    const gross = keep.length ? mean(keep.map(ret).filter(isNum)) : 0;
    const b = mean(bench.map(ret).filter(isNum));
    if (!isNum(gross) || !isNum(b)) { held = keep; continue; }
    periods.push({ t, net: gross - cost, bench: b, held: keep.length });
    for (let s = t; s < t + H; s += 1) {
      const step = (js) => mean(js.filter((j) => ex[s][j] > 0 && ex[s + 1][j] > 0).map((j) => ex[s + 1][j] / ex[s][j] - 1));
      const p = keep.length ? step(keep) : 0; const q = step(bench);
      if (isNum(p) && isNum(q)) daily.push({ t: s, excess: Math.log1p(p - (s === t ? cost : 0) - q) });
    }
    const m = panel.dates[t].slice(0, 7);
    const cur = months.get(m) || { net: 1, bench: 1 };
    months.set(m, { net: cur.net * (1 + gross - cost), bench: cur.bench * (1 + b) });
    held = keep;
  }
  const prod = (k) => periods.reduce((a, p) => a * (1 + p[k]), 1);
  const span = periods.length * H;
  const annualized = periods.length ? (prod('net') / prod('bench')) ** (NET.trading_days_per_year / span) - 1 : null;
  return { periods, daily, monthly_d: [...months.values()].map((x) => x.net - x.bench), months: [...months.keys()], annualized_excess: isNum(annualized) ? annualized : null, events };
}

/** R1.3：DSR 在前推验证折的月度配对差上算，N = 本族累计尝试数；familySharpes = 本轮各候选验证折月度序列的 ŜR。≥ 24 个月才算得出。 */
function dsrFromValidation({ monthly_d: d, N, familySharpes }) {
  if (!Array.isArray(d)) fail('DSR_INPUT', 'monthly_d');
  if (!Number.isInteger(N) || N < 1) fail('FAMILY_N_UNKNOWN', N);
  const r = overfit.deflatedSharpe({ d, N, familySharpes: (familySharpes || []).filter(isNum) });
  return { dsr: r.dsr, t_months: d.length, sr: r.sr, segment: 'VALIDATION_FOLDS', n_trials: N };
}

/** 最小二乘截距的 t（有截距；X 是每期一行的解释变量）。奇异或自由度不够 → null。 */
function olsInterceptT(y, X) {
  const n = y.length; const k = (X[0] || []).length + 1;
  if (n <= k) return null;
  const rows = X.map((x) => [1, ...x]);
  const XtX = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => rows.reduce((s, r) => s + r[a] * r[b], 0)));
  const Xty = Array.from({ length: k }, (_, a) => rows.reduce((s, r, i) => s + r[a] * y[i], 0));
  const inv = invert(XtX);
  if (!inv) return null;
  const beta = inv.map((row) => row.reduce((s, v, b) => s + v * Xty[b], 0));
  const resid = y.map((v, i) => v - rows[i].reduce((s, x, a) => s + x * beta[a], 0));
  const s2 = resid.reduce((s, e) => s + e * e, 0) / (n - k);
  const se = Math.sqrt(s2 * inv[0][0]);
  return se > 0 ? { intercept: beta[0], se, t: beta[0] / se, n, k } : null;
}
function invert(A) {
  const n = A.length; const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c += 1) {
    let p = c; for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c]; for (let j = 0; j < 2 * n; j += 1) M[c][j] /= d;
    for (let r = 0; r < n; r += 1) if (r !== c) { const f = M[r][c]; if (f) for (let j = 0; j < 2 * n; j += 1) M[r][j] -= f * M[c][j]; }
  }
  return M.map((row) => row.slice(n));
}

const UNK = (reason) => ({ value: overfit.UNKNOWN, reason });
/** 面板 → 因子库相关函数要的格式（[{ date, values }]），只取 days 这些日子、池里、有数的名字。 */
const libPanel = (matrix, panel, days) => days.map((t) => ({ date: panel.dates[t], values: Object.fromEntries(panel.codes.map((c, j) => [c, matrix[t][j]])
  .filter(([, v], j) => panel.universe[t][j] && isNum(v))) }));

/**
 * R1.4：第 7、8 项要的现有因子（库里同市场的 LIVE_IN_RULE）：给了现有因子序列（../../factor-series，FACTOR_SERIES_V1）就算——
 *   8 每个库内因子：截面 Spearman（每天）与因子收益相关（每天对次日开盘到开盘收益的截面 OLS 斜率），只在留出段的打分日上；
 *   7 候选的因子收益对现有账本每个因子的因子收益做 OLS，取截距的 t（wfo_net_ir_delta 不算，写 null）。
 * 个股级直接用；单元级（申万单元）按单元成员映射到个股；ETF 级对不上个股 → UNKNOWN（ETF_GRAIN_NOT_MAPPABLE_TO_STOCKS）；没给 → FACTOR_SERIES_ABSENT。
 * 现有账本里有一个因子没有序列，第 7 项就不算（intercept_t null，原因列出缺的），不拿剩下的凑。
 */
function libraryComparison(values, panel, days, { market, factorSeries: fsrc = null }) {
  const corr = require('../../factor-library/correlation');
  const series = require('../factor-series');
  // R1.9：第 7、8 项只和覆盖全部股票截面的 LIVE_IN_RULE 因子比；排除的写进结果
  const libIds = factorLib.comparisonFactorIds(factorLib.LIBRARY, market);
  const book = libIds;
  const excluded = factorLib.comparisonExclusions(market);
  const ex = panel.labels.exec_open;
  const ret1 = panel.dates.map((_, t) => panel.codes.map((_, j) => (t + 1 < panel.dates.length && ex[t][j] > 0 && ex[t + 1][j] > 0 ? ex[t + 1][j] / ex[t][j] - 1 : NaN)));
  const cand = libPanel(values, panel, days); const retP = libPanel(ret1, panel, days);
  const candRet = corr.factorReturnSeries(cand, retP);
  const retSeries = new Map();
  const pairs = libIds.map((fid) => {
    if (!fsrc) return { factor_id: fid, rho_cross_section: UNK('FACTOR_SERIES_NOT_PROVIDED'), rho_returns: UNK('FACTOR_SERIES_NOT_PROVIDED') };
    let fp;
    try { fp = series.stockPanel(fsrc, fid, panel); } catch (e) {
      if (e.code === 'MINE_FACTOR_SERIES_GRAIN_NOT_STOCK_MAPPABLE') return { factor_id: fid, rho_cross_section: UNK('ETF_GRAIN_NOT_MAPPABLE_TO_STOCKS'), rho_returns: UNK('ETF_GRAIN_NOT_MAPPABLE_TO_STOCKS') };
      throw e;
    }
    if (fp === null) return { factor_id: fid, rho_cross_section: UNK('FACTOR_SERIES_ABSENT'), rho_returns: UNK('FACTOR_SERIES_ABSENT') };
    const want = new Set(days.map((t) => panel.dates[t]));
    const fh = fp.filter((r) => want.has(r.date));
    const fRet = corr.factorReturnSeries(fh, retP);
    retSeries.set(fid, fRet);
    return { factor_id: fid, rho_cross_section: corr.crossSectionalSpearman(cand, fh), rho_returns: corr.returnSeriesCorrelation(candRet, fRet) };
  });
  const missing = book.filter((id) => !retSeries.has(id));
  let marginal = { book_factor_ids: book, wfo_net_ir_delta: null, intercept_t: null, unknown_reason: null, periods: 0, collinear_dropped: [], excluded_factors: excluded };
  if (missing.length) marginal.unknown_reason = `BOOK_FACTOR_SERIES_MISSING:${missing.join(',')}`;
  else {
    const maps = book.map((id) => new Map(retSeries.get(id).map((p) => [p.date, p.value])));
    const rows = candRet.filter((p) => isNum(p.value) && maps.every((m) => isNum(m.get(p.date))));
    // 逐期完全相同的解释变量（第 6 个「所在单元分」与第 12 个单元分在 V6 里同值）只留第一个，丢掉的照实写
    const keep = []; const dropped = [];
    book.forEach((id, k) => {
      const col = rows.map((p) => maps[k].get(p.date));
      if (keep.some((j) => rows.every((p, i) => maps[j].get(p.date) === col[i]))) dropped.push(id); else keep.push(k);
    });
    const fit = olsInterceptT(rows.map((p) => p.value), rows.map((p) => keep.map((k) => maps[k].get(p.date))));
    marginal = { ...marginal, intercept_t: fit ? fit.t : null, unknown_reason: fit ? null : 'OLS_SINGULAR_OR_TOO_FEW_PERIODS', periods: rows.length, collinear_dropped: dropped };
  }
  return { correlation: { pairs, orthogonalised_against: [], new_attempt: false, excluded_factors: excluded, source: fsrc ? { sums_sha256: fsrc.sums_sha256 } : null }, marginal };
}

/**
 * 一个候选的留出段读数（不含 PBO 与 DSR 的族内部分；roundResults 补上）。
 * @param {object} parsed  dsl.parse 的结果
 * @param {object} panel   HOLDOUT 面板（开过留出段之后建的）
 */
function scoreCandidate(parsed, panel, { holding_period: H, neutralization, window = segs.SEGMENTS.HOLDOUT }) {
  assertHoldoutPanel(panel, window);
  const neu = scoring.neutralizedValues(parsed, panel, { neutralization }); // 本轮的版本，必须给（修订 SIZE_V2 N2）
  if (!neu.neutralization || neu.neutralization.industry !== 'APPLIED' || neu.neutralization.size !== 'APPLIED') fail('NOT_NEUTRALIZED');
  const days = holdoutDays(panel, window);
  const at = (series) => days.map((t) => series[t]);
  const fwd = scoring.forwardReturns(panel, H); const fwd2 = scoring.forwardReturns(panel, 2 * H);
  const ic = scoring.dailyRankIc(neu.values, fwd, panel.universe); const ic2 = scoring.dailyRankIc(neu.values, fwd2, panel.universe);
  const icDays = at(ic).filter(isNum);
  const nonOverlap = days.filter((_, k) => k % H === 0).map((t) => ic[t]).filter(isNum);
  const icSd = sd(nonOverlap);
  const q = Array.from({ length: QUINTILES }, () => []);
  for (const t of days.filter((_, k) => k % H === 0)) {
    const names = panel.codes.map((_, j) => j).filter((j) => panel.universe[t][j] && isNum(neu.values[t][j]) && isNum(fwd[t][j]));
    if (names.length < QUINTILES) continue;
    names.sort((a, b) => neu.values[t][a] - neu.values[t][b] || a - b);
    const groups = Array.from({ length: QUINTILES }, () => []);
    names.forEach((j, r) => groups[Math.min(QUINTILES - 1, Math.floor((r * QUINTILES) / names.length))].push(fwd[t][j]));
    groups.forEach((g, k) => q[k].push(mean(g)));
  }
  const quintiles = q.every((g) => g.length) ? q.map(mean) : null;
  const book = longOnly(neu.values, panel, H, days);
  const sizeExposure = scoring.sizeExposure(neu.values, panel, fwd, days, neu.neutralization.version); // 修订 SIZE_V2 N3：与 IC 同一份中性化后的值、同一批名字
  const comparison = { values: neu.values, days };
  return {
    holdout: {
      segment: 'HOLDOUT', from: window.from, to: window.to, holding_period: H, neutralization: neu.neutralization,
      ic_mean: icDays.length ? mean(icDays) : null, ic_days: icDays.length, icir: isNum(icSd) && icSd > 0 ? mean(nonOverlap) / icSd : null, icir_non_overlapping: true,
      icir_periods: nonOverlap.length, quintile_mean_returns: quintiles, ic_double_horizon: at(ic2).filter(isNum).length ? mean(at(ic2).filter(isNum)) : null,
    },
    net_of_cost: { long_only: NET.long_only, top_fraction: NET.top_fraction, benchmark: NET.benchmark, cost: { ...NET.cost }, annualized_excess: book.annualized_excess,
      periods: book.periods.length, limit_moves: NET.limit_moves, limit_events: book.events },
    size_exposure: sizeExposure,
    series: { daily_excess: book.daily, monthly_d: book.monthly_d },
    comparison,
  };
}

/**
 * 本轮交去打分的全部候选：逐个 scoreCandidate，再补：
 *   1 DSR（R1.3）：在前推验证折的月度配对差上算（validation：候选编号 → { monthly_d }，familySharpes：本轮各候选验证折的 ŜR），N = 本族累计尝试数；
 *   2 PBO：本轮候选集上的 CSCV（留出段的逐日超额）；
 *   7、8（R1.4）：libraryComparison（给了现有因子序列才算得出）；
 *   9（R1.5）：mechanisms：候选编号 → 开启之前写的机制登记；没有的 mechanism null，写 mechanism_reason；登记时刻（registered_at）与
 *     留出段开启时刻（holdout.opened_at = 开启记录的 opened_at）一并交给门，门核登记早于开启（修订 4）；协调会话的复审裁决
 *     （review：MECHANISM_REVIEW_V1 的 verdict、行 hash、reviewed_at）放进 mechanism.review，REJECTED 的第 9 项不过；
 *   R1.6：segmentOpenIndex = 这段留出段在本族里第几次被开。
 * @param {Array<{candidate_id, parsed, formula}>} candidates
 * @returns {Array<object>} 与 candidates 同序
 */
function roundResults(candidates, panel, { holding_period: H, market, familyTrialCount, scoredAt, neutralization, validation = new Map(), familySharpes = [], mechanisms = new Map(),
  factorSeries = null, segmentOpenIndex = null, openedAt = null, review = null, window = segs.SEGMENTS.HOLDOUT }) {
  for (const c of candidates) if (c.generator !== 'AI_MINED_GP' && c.generator !== 'AI_MINED_LLM') fail('GENERATOR_MISSING', c.candidate_id); // 结果记的生成方式来自轮次清单，不默认
  if (!Number.isInteger(familyTrialCount) || familyTrialCount < 1) fail('FAMILY_N_UNKNOWN', familyTrialCount);
  const scored = candidates.map((c) => ({ c, s: scoreCandidate(c.parsed, panel, { holding_period: H, neutralization, window }) }));
  const dayKeys = scored.map(({ s }) => new Map(s.series.daily_excess.map((x) => [x.t, x.excess])));
  const commonDays = [...new Set(dayKeys.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b).filter((t) => dayKeys.every((m) => m.has(t)));
  const R = commonDays.map((t) => dayKeys.map((m) => m.get(t)));
  let pbo;
  try { pbo = R.length ? overfit.pbo(R) : { value: 'NOT_APPLICABLE', reason: 'NO_COMMON_DAYS' }; } catch (e) { pbo = { value: overfit.UNKNOWN, reason: e.message }; }
  return scored.map(({ c, s }) => {
    const v = validation.get(c.candidate_id);
    const dsr = v ? dsrFromValidation({ monthly_d: v.monthly_d, N: familyTrialCount, familySharpes }) : { dsr: UNK('VALIDATION_SERIES_MISSING'), t_months: 0, segment: 'VALIDATION_FOLDS' };
    const cmp = libraryComparison(s.comparison.values, panel, s.comparison.days, { market, factorSeries });
    const m = mechanisms.get(c.candidate_id) || null;
    return {
      schema: 'MINED_CANDIDATE_RESULT_V1', candidate_id: c.candidate_id, factor_id: c.candidate_id, market, formula: c.formula, generator: c.generator,
      holdout: { ...s.holdout, opened_at: openedAt, scored_at: scoredAt, segment_open_index: segmentOpenIndex },
      net_of_cost: s.net_of_cost,
      size_exposure: s.size_exposure,
      overfit: { dsr: dsr.dsr, dsr_segment: dsr.segment, dsr_t_months: dsr.t_months, n_trials: familyTrialCount, pbo: isNum(pbo.value) ? pbo.value : pbo, pbo_scope: 'ROUND_CANDIDATE_SET',
        pbo_rows: R.length, pbo_candidates: candidates.length },
      marginal: cmp.marginal,
      correlation: cmp.correlation,
      mechanism: m ? { mechanism_id: m.mechanism_id, economic_logic_zh: m.economic_logic_zh, failure_mode_zh: m.failure_mode_zh, written_at: m.written_at,
        registered_at: m.registered_at, registration_hash: m.record_hash,
        review: review && review.verdicts.has(c.candidate_id) ? { verdict: review.verdicts.get(c.candidate_id), review_hash: review.review_hash, reviewed_at: review.reviewed_at } : null } : null,
      mechanism_reason: m ? null : 'NO_MECHANISM_REGISTERED_BEFORE_OPEN',
    };
  });
}

module.exports = { NET, QUINTILES, HoldoutScoreError, assertHoldoutPanel, holdoutDays, scoreCandidate, roundResults, dsrFromValidation, libraryComparison, longOnly,
  internals: { longOnly, olsInterceptT } };
