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
 *   6  net_of_cost：不重叠的打分日调仓，只做多池里前 20%，等权；成本按 G-COST 的 CN_A 下限（佣金 2.5 + 滑点 10 bps，单边）、卖出另加印花税 5 bps；
 *      基准 = 池里等权（不计成本）；年化超额 = (Π(1+净) / Π(1+基准))^(242 / 持有天数) − 1。涨跌停买卖不到没有建模（导出里没有涨跌停价），记在 limit_moves；
 *   1  DSR：按月的配对差（组合净收益 − 基准，按决策日的月份累计）进 overfit.deflatedSharpe，N = 本族累计尝试数；留出段只有约 3 个月，T < 24 → UNKNOWN（照实写）；
 *   2  PBO：本轮所有交去打分的候选的逐日超额（log(1 + 组合 − 基准)）做 CSCV（overfit.pbo），pbo_scope = ROUND_CANDIDATE_SET；不足 4 个候选 → NOT_APPLICABLE；
 *   7  边际贡献、8 与库内因子的相关性：库里 CN_A 因子的序列不在车道数据里 → 输入留空、写原因（门判 MINE_MARGINAL_INPUT / MINE_CORRELATION_LIBRARY_INCOMPLETE）；
 *   9  机制：GP 不登记机制 → mechanism null（门判 MINE_MECHANISM_UNKNOWN）。
 * 算不出的一律写 null 或 UNKNOWN 与原因，不填 0、不跳过。
 */
const segs = require('../segments');
const scoring = require('../scoring');
const overfit = require('../../trial-ledger/overfit');
const costGate = require('../../cost-gate');
const factorLib = require('../../factor-library');

const NET = Object.freeze({
  long_only: true, top_fraction: 0.2, benchmark: 'EQUAL_WEIGHT_UNIVERSE', trading_days_per_year: 242,
  cost: Object.freeze({ commission_bps: costGate.FLOORS.CN_A.commission_bps_min, slippage_bps: costGate.FLOORS.CN_A.slippage_bps_min, stamp_duty_on_sell: true, stamp_duty_bps: 5 }),
  limit_moves: 'NOT_MODELLED_NO_LIMIT_PRICES_IN_EXPORT',
});
const QUINTILES = 5;

class HoldoutScoreError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new HoldoutScoreError(`MINE_HOLDOUT_SCORE_${code}`, detail); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs) => { if (xs.length < 2) return null; const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };

function assertHoldoutPanel(panel) {
  const h = segs.SEGMENTS.HOLDOUT; const d = panel && panel.dates;
  if (!panel || panel.segment !== 'HOLDOUT' || !d || !d.length || d[d.length - 1] !== h.to) fail('NOT_HOLDOUT_PANEL', `${panel && panel.segment}:${d && d[d.length - 1]}`);
}

/** 留出段的打分日下标（决策日在留出段里）。 */
const holdoutDays = (panel) => panel.dates.map((d, t) => (d >= segs.SEGMENTS.HOLDOUT.from ? t : -1)).filter((t) => t >= 0);

/** 一个候选的持仓模拟：返回逐期净收益、基准、逐日超额与按月的配对差。 */
function longOnly(values, panel, H, days) {
  const ex = panel.labels.exec_open; const N = panel.codes.length;
  const rebalance = days.filter((_, k) => k % H === 0);
  const periods = []; const daily = []; const months = new Map();
  let held = new Set();
  for (const t of rebalance) {
    if (t + H >= panel.dates.length) break;
    const names = [];
    for (let j = 0; j < N; j += 1) if (panel.universe[t][j] && isNum(values[t][j]) && ex[t][j] > 0 && ex[t + H][j] > 0) names.push(j);
    if (names.length < scoring.MIN_NAMES) continue;
    names.sort((a, b) => values[t][b] - values[t][a] || a - b);
    const top = names.slice(0, Math.max(1, Math.floor(NET.top_fraction * names.length)));
    const next = new Set(top);
    const bought = top.filter((j) => !held.has(j)).length / top.length;
    const sold = held.size ? [...held].filter((j) => !next.has(j)).length / held.size : 0;
    const c = NET.cost; const cost = (bought * (c.commission_bps + c.slippage_bps) + sold * (c.commission_bps + c.slippage_bps + c.stamp_duty_bps)) / 1e4;
    const gross = mean(top.map((j) => ex[t + H][j] / ex[t][j] - 1));
    const bench = mean(names.map((j) => ex[t + H][j] / ex[t][j] - 1));
    periods.push({ t, net: gross - cost, bench });
    for (let s = t; s < t + H; s += 1) {
      const step = (js) => mean(js.filter((j) => ex[s][j] > 0 && ex[s + 1][j] > 0).map((j) => ex[s + 1][j] / ex[s][j] - 1));
      const p = step(top); const b = step(names);
      if (isNum(p) && isNum(b)) daily.push({ t: s, excess: Math.log1p(p - (s === t ? cost : 0) - b) });
    }
    const m = panel.dates[t].slice(0, 7);
    const cur = months.get(m) || { net: 1, bench: 1 };
    months.set(m, { net: cur.net * (1 + gross - cost), bench: cur.bench * (1 + bench) });
    held = next;
  }
  const prod = (k) => periods.reduce((a, p) => a * (1 + p[k]), 1);
  const span = periods.length * H;
  const annualized = periods.length ? (prod('net') / prod('bench')) ** (NET.trading_days_per_year / span) - 1 : null;
  return { periods, daily, monthly_d: [...months.values()].map((x) => x.net - x.bench), annualized_excess: isNum(annualized) ? annualized : null };
}

/**
 * 一个候选的留出段读数（不含 PBO 与 DSR 的族内部分；roundResults 补上）。
 * @param {object} parsed  dsl.parse 的结果
 * @param {object} panel   HOLDOUT 面板（开过留出段之后建的）
 */
function scoreCandidate(parsed, panel, { holding_period: H }) {
  assertHoldoutPanel(panel);
  const neu = scoring.neutralizedValues(parsed, panel);
  if (!neu.neutralization || neu.neutralization.industry !== 'APPLIED' || neu.neutralization.size !== 'APPLIED') fail('NOT_NEUTRALIZED');
  const days = holdoutDays(panel);
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
  return {
    holdout: {
      segment: 'HOLDOUT', from: segs.SEGMENTS.HOLDOUT.from, to: segs.SEGMENTS.HOLDOUT.to, holding_period: H, neutralization: neu.neutralization,
      ic_mean: icDays.length ? mean(icDays) : null, ic_days: icDays.length, icir: isNum(icSd) && icSd > 0 ? mean(nonOverlap) / icSd : null, icir_non_overlapping: true,
      icir_periods: nonOverlap.length, quintile_mean_returns: quintiles, ic_double_horizon: at(ic2).filter(isNum).length ? mean(at(ic2).filter(isNum)) : null,
    },
    net_of_cost: { long_only: NET.long_only, top_fraction: NET.top_fraction, benchmark: NET.benchmark, cost: { ...NET.cost }, annualized_excess: book.annualized_excess,
      periods: book.periods.length, limit_moves: NET.limit_moves },
    series: { daily_excess: book.daily, monthly_d: book.monthly_d },
  };
}

/**
 * 本轮交去打分的全部候选：逐个 scoreCandidate，再补 PBO（本轮候选集上的 CSCV）与 DSR（N = 本族累计尝试数），拼成 G-MINE 的候选结果对象。
 * @param {Array<{candidate_id, parsed, formula}>} candidates
 * @returns {Array<object>} 与 candidates 同序
 */
function roundResults(candidates, panel, { holding_period: H, market, familyTrialCount, scoredAt }) {
  if (!Number.isInteger(familyTrialCount) || familyTrialCount < 1) fail('FAMILY_N_UNKNOWN', familyTrialCount);
  const scored = candidates.map((c) => ({ c, s: scoreCandidate(c.parsed, panel, { holding_period: H }) }));
  // PBO：行 = 所有候选都有超额的那些天，列 = 候选
  const dayKeys = scored.map(({ s }) => new Map(s.series.daily_excess.map((x) => [x.t, x.excess])));
  const commonDays = [...new Set(dayKeys.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b).filter((t) => dayKeys.every((m) => m.has(t)));
  const R = commonDays.map((t) => dayKeys.map((m) => m.get(t)));
  let pbo;
  try { pbo = R.length ? overfit.pbo(R) : { value: 'NOT_APPLICABLE', reason: 'NO_COMMON_DAYS' }; } catch (e) { pbo = { value: overfit.UNKNOWN, reason: e.message }; }
  const sharpes = scored.map(({ s }) => overfit.moments(s.series.monthly_d).sr).filter(isNum);
  const libBook = factorLib.bookFactorIds(factorLib.LIBRARY, market);
  return scored.map(({ c, s }) => {
    const dsr = overfit.deflatedSharpe({ d: s.series.monthly_d, N: familyTrialCount, familySharpes: sharpes });
    return {
      schema: 'MINED_CANDIDATE_RESULT_V1', candidate_id: c.candidate_id, factor_id: c.candidate_id, market, formula: c.formula, generator: 'AI_MINED_GP',
      holdout: { ...s.holdout, scored_at: scoredAt },
      net_of_cost: s.net_of_cost,
      overfit: { dsr: isNum(dsr.dsr) ? dsr.dsr : dsr.dsr, dsr_t_months: dsr.T, n_trials: familyTrialCount, pbo: isNum(pbo.value) ? pbo.value : pbo, pbo_scope: 'ROUND_CANDIDATE_SET',
        pbo_rows: R.length, pbo_candidates: candidates.length },
      marginal: { book_factor_ids: libBook, wfo_net_ir_delta: null, intercept_t: null, unknown_reason: 'BOOK_FACTOR_SERIES_NOT_IN_LANE_DATA' },
      correlation: { pairs: [], orthogonalised_against: [], new_attempt: false, unknown_reason: 'LIBRARY_FACTOR_VALUES_NOT_IN_LANE_DATA' },
      mechanism: null,
    };
  });
}

module.exports = { NET, QUINTILES, HoldoutScoreError, assertHoldoutPanel, holdoutDays, scoreCandidate, roundResults, internals: { longOnly } };
