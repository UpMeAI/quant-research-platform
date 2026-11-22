'use strict';

/**
 * QRP-native factor-portfolio backtester (plan-coord decision 11-23, NOTE_1 6b3be10d). It WRITES LAB_REPLAY_OUTPUT_V1 (replay-output.js) for a frozen CN_A formula from the same tables
 * the RF1116 round runner reads (dev + validation segments, data-adapter buildPanel, frozen MINING_SPACE_V1, the DSL evaluator, scoring.neutralizedValues the way `select` does).
 * No external replay core, no V6 Q0 engine, no database, no network; no clock in the output (wall time is measured with hrtime and returned OUTSIDE `replay`, so the replay bytes are deterministic).
 *
 * Rules (fixed, frozen in the K2): rebalance DAILY or WEEKLY (decision day = the first trading day of the week, normally Monday); hold the top `quantile` (default 0.2) of the neutralised
 * factor values of the day's pool (universe, open price present, value finite), equal weight at entry; decision at the open of day t, fill at that same open (the panel's convention: the
 * reading of day t is the previous day's row, so the fill at open t is the "next open" after the signal). Execution reuses holdout-scoring `longOnly`: names that stay in the target are kept
 * (no drift trading), names that leave are sold, new names are bought; a buy at limit-up or a sell at limit-down does not execute (price-limits canBuy / canSell, V6 board bands; no open
 * price likewise) and is retried the next day; a trade is capped at the participation cap (authority.loadConfig().participationCap) of the trading day's own traded amount (turnover_amount_cny
 * of day t) and the remainder is carried to the following days. `trades` lists executed trades only.
 * Costs: registry r3 through cost-runs.produce on each day's trades (no rate lives here); the daily `cost` is the day's charged cost as a fraction of the NAV at that day's open, and `gross` is
 * the log growth of the NAV from that open to the next open before the day's cost (so net = gross - cost, the S3 convention). Unfilled cash earns nothing; buys keep COST_RESERVE of NAV in cash.
 *
 * Six arms in one process: baseline (the same rules on the equal-weight universe, no factor), candidate, PARAM_MINUS_20 / PARAM_PLUS_20 (quantile x0.8 / x1.2), and the portfolio with and without
 * the candidate. Arms and trades are restricted to the dates common with the existing book, so every series in the replay is on the same dates.
 *
 * portfolio.holdings_overlap: the field name {date, jaccard} is kept for the S4 producer's schema, but per NOTE_1 the measure is |rho| of daily net returns of the candidate against the existing
 * portfolio: jaccard = |rolling 60-day correlation of the candidate net and the book net|. s4-evidence.js measures overlap.holdings and overlap.risk both as the full-sample |corr|.
 * portfolio.with = (1 - PORTFOLIO_WEIGHT) * book + PORTFOLIO_WEIGHT * candidate net, where the candidate's log net is converted to a simple return (expm1) to match the book's daily net returns.
 * portfolio.stress: two windows fixed by the data, the book's worst 20-day window and the market's (the equal-weight baseline's gross) worst 20-day window; delta = sum over the window of with - without.
 */
const fs = require('fs');
const adapter = require('../mining-sandbox/data-adapter');
const segs = require('../mining-sandbox/segments');
const dsl = require('../mining-sandbox/dsl');
const scoring = require('../mining-sandbox/scoring');
const limits = require('../mining-sandbox/price-limits');
const runner = require('../mining-sandbox/round-runner');
const { NEW_ROUND_NEUTRALIZATION } = require('../mining-rounds/neutralization');
const costGate = require('../cost-gate');
const authority = require('../independent-verifier/authority');
const costRuns = require('./cost-runs');

/** Star default (plan-coord to confirm): the candidate's weight in the portfolio with the candidate. */
const PORTFOLIO_WEIGHT = 0.2;
/** Star default: the reference NAV in CNY the arms are run at (the participation cap is relative to the day's traded amount, so the size matters). */
const DEFAULT_INITIAL_NAV = 1e8;
const DEFAULT_QUANTILE = 0.2;
const COST_RESERVE = 0.003; // share of NAV kept in cash when buying, so the day's cost is paid from cash
const DUST = 1e-3; // a gap smaller than this share of the target is not traded
const STRESS_DAYS = 20;
const OVERLAP_WINDOW = 60;
const ARM_KEYS = Object.freeze(['baseline', 'candidate', 'param_minus_20', 'param_plus_20', 'portfolio_with', 'portfolio_without']);

class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === 'string' && DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;

/* ------------------------------------------------------------------ existing book */

/** @returns {string|null} refusal code */
function validateBook(book) {
  if (!Array.isArray(book) || !book.length) return 'BACKTEST_BOOK_EMPTY';
  for (const x of book) {
    if (!x || typeof x !== 'object' || !validDate(x.date)) return 'BACKTEST_BOOK_DATE_INVALID';
    if (!isNum(x.net)) return 'BACKTEST_BOOK_NOT_FINITE';
  }
  for (let i = 1; i < book.length; i += 1) {
    if (book[i].date === book[i - 1].date) return 'BACKTEST_BOOK_DUPLICATE_DATE';
    if (book[i].date < book[i - 1].date) return 'BACKTEST_BOOK_NOT_SORTED';
  }
  return null;
}

/**
 * Read a read-only exported daily net series of the existing CN_A book: CSV `date,net` (header required) or JSON [{date, net}]. Validated: sorted, finite, no duplicate dates.
 * @returns {{book: Array<{date: string, net: number}>} | {refusal: string}}
 */
function readExistingBook({ file } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { refusal: 'BACKTEST_BOOK_UNREADABLE' }; }
  let book;
  if (/\.json$/i.test(String(file))) {
    try { book = JSON.parse(text); } catch (e) { return { refusal: 'BACKTEST_BOOK_UNREADABLE' }; }
    if (!Array.isArray(book)) return { refusal: 'BACKTEST_BOOK_UNREADABLE' };
    book = book.map((x) => (x && typeof x === 'object' ? { date: x.date, net: x.net } : x));
  } else {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lines.length || lines[0].trim() !== 'date,net') return { refusal: 'BACKTEST_BOOK_HEADER_INVALID' };
    book = lines.slice(1).map((l) => { const [date, net, ...rest] = l.split(','); return { date: (date || '').trim(), net: rest.length || net === undefined || net.trim() === '' ? NaN : Number(net) }; });
  }
  const bad = validateBook(book);
  return bad ? { refusal: bad } : { book };
}

/* ------------------------------------------------------------------ one arm */

const weekKey = (d) => { const t = Date.parse(`${d}T00:00:00Z`); const dow = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - dow * 864e5).toISOString().slice(0, 10); };
/** Decision days: every trading day, or the first trading day of each week. */
const isRebalanceDay = (rebalance, dates, t) => rebalance === 'DAILY' || t === 0 || weekKey(dates[t]) !== weekKey(dates[t - 1]);

/**
 * Simulate one arm from startIndex to the second last panel day (the last day has no next open to mark to).
 * @param {{panel: object, values: number[][]|null, rule: {rebalance: string, quantile: number, initialNav: number, participationCap?: number}, startIndex: number, universeOnly: boolean,
 *   cost?: {book: string, ref: string}}} a
 * @returns {{daily: Array<{date, gross, cost}>, trades: object[], nav_start: number[], cost_cny: number[], trades_per_day: number[], events: object}}
 */
function simulateArm({ panel, values, rule, startIndex, universeOnly, cost = { book: 'STOCK_BOOK', ref: 'BACKTEST_COSTS' } }) {
  const { dates, codes } = panel; const T = dates.length; const N = codes.length;
  const ex = panel.labels.exec_open; const openRaw = panel.labels.open_raw; const prevRaw = panel.labels.prev_close_raw;
  const amountRows = panel.readings && panel.readings.amount;
  if (!Array.isArray(amountRows) || amountRows.length !== T) refuse('BACKTEST_PANEL_AMOUNT_MISSING');
  const cap = isNum(rule.participationCap) ? rule.participationCap : authority.loadConfig().participationCap;
  const capNotional = (amount) => { let n = Math.floor(cap * amount * 100) / 100; while (n / amount > cap) n -= 0.01; return n; };
  const quote = (t, j) => ({ open: openRaw[t][j], prevClose: prevRaw[t][j], pct: limits.bandOf({ board: panel.board[j], st: panel.st[t][j], date: dates[t] }).pct });
  const units = new Float64Array(N); const last = new Float64Array(N); const want = new Float64Array(N);
  const active = new Set();
  let cash = rule.initialNav;
  const daily = []; const trades = []; const navStart = []; const costCny = []; const perDay = [];
  const events = { entry_blocked_limit_up: 0, exit_carried_limit_down: 0, entry_blocked_no_open: 0, exit_carried_no_open: 0, no_traded_amount: 0, capped_trades: 0 };
  const mark = (t) => { let v = 0; for (const j of active) { if (ex[t][j] > 0) last[j] = ex[t][j]; v += units[j] * last[j]; } return v; };
  for (let t = startIndex; t < T - 1; t += 1) {
    const nav = cash + mark(t);
    if (!(nav > 0)) refuse('BACKTEST_NAV_NONPOSITIVE');
    if (isRebalanceDay(rule.rebalance, dates, t)) {
      const pool = [];
      for (let j = 0; j < N; j += 1) if (panel.universe[t][j] && ex[t][j] > 0 && (universeOnly || isNum(values[t][j]))) pool.push(j);
      if (pool.length >= scoring.MIN_NAMES) {
        if (!universeOnly) pool.sort((a, b) => values[t][b] - values[t][a] || a - b);
        const k = universeOnly ? pool.length : Math.max(1, Math.floor(rule.quantile * pool.length));
        const tgt = new Set(pool.slice(0, k));
        for (const j of active) if (!tgt.has(j)) want[j] = 0;
        for (const j of tgt) {
          const held = units[j] > 0 ? units[j] * last[j] : 0;
          if (want[j] > 0) continue; // already wanted (a carried entry keeps its target)
          want[j] = held > 0 ? held : nav / k; // a carried exit that is picked again is simply kept
          active.add(j);
        }
      }
    }
    // execution: sells first, then buys, each name by index
    const todays = [];
    const order = [...active].sort((a, b) => a - b);
    const tradeOne = (j, side, notional, amount) => {
      todays.push({ date: dates[t], code: codes[j], st: panel.st[t][j] === true, side, notional, open: openRaw[t][j], prev_close: prevRaw[t][j], participation: notional / amount });
    };
    for (const j of order) {
      if (!(want[j] === 0 && units[j] > 0)) continue;
      const q = quote(t, j); const px = ex[t][j];
      if (!limits.canSell(q)) { if (isNum(q.open) && q.open > 0) events.exit_carried_limit_down += 1; else events.exit_carried_no_open += 1; continue; }
      const amount = amountRows[t + 1][j];
      if (!(amount > 0)) { events.no_traded_amount += 1; continue; }
      const value = units[j] * px; const n = Math.min(value, capNotional(amount));
      if (!(n > 0)) continue;
      if (n < value) events.capped_trades += 1;
      units[j] = n >= value ? 0 : units[j] - n / px; cash += n;
      tradeOne(j, 'SELL', n, amount);
    }
    for (const j of order) {
      if (!(want[j] > 0)) continue;
      const px = ex[t][j]; const value = units[j] > 0 ? units[j] * (px > 0 ? px : last[j]) : 0;
      const gap = want[j] - value;
      if (!(gap > DUST * want[j])) continue;
      const q = quote(t, j);
      if (!limits.canBuy(q)) { if (isNum(q.open) && q.open > 0) events.entry_blocked_limit_up += 1; else events.entry_blocked_no_open += 1; continue; }
      const amount = amountRows[t + 1][j];
      if (!(amount > 0)) { events.no_traded_amount += 1; continue; }
      const n = Math.min(gap, capNotional(amount), cash - COST_RESERVE * nav);
      if (!(n > 0)) continue;
      if (n < gap && n >= capNotional(amount)) events.capped_trades += 1;
      units[j] += n / px; last[j] = px; cash -= n;
      tradeOne(j, 'BUY', n, amount);
    }
    for (const j of order) if (want[j] === 0 && !(units[j] > 0)) { active.delete(j); want[j] = 0; }
    let dayCost = 0;
    if (todays.length) {
      const priced = costRuns.produce({ replay: { trades: todays, market: 'CN_A', cost_book: cost.book, cost_flags: {}, cost_model_ref: cost.ref } });
      if (priced.refusal) refuse(priced.refusal);
      dayCost = priced.v4.runs[0].cost_breakdown.items.reduce((s, i) => s + i.amount, 0);
    }
    const v1 = cash + mark(t + 1);
    cash -= dayCost;
    daily.push({ date: dates[t], gross: Math.log(v1 / nav), cost: dayCost / nav });
    navStart.push(nav); costCny.push(dayCost); perDay.push(todays.length);
    for (const x of todays) trades.push(x);
  }
  return { daily, trades, nav_start: navStart, cost_cny: costCny, trades_per_day: perDay, events };
}

/* ------------------------------------------------------------------ run */

const meanOf = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function corr(x, y) {
  const mx = meanOf(x); const my = meanOf(y); let sxy = 0; let sx = 0; let sy = 0;
  for (let i = 0; i < x.length; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
  return sx > 0 && sy > 0 ? sxy / Math.sqrt(sx * sy) : 0;
}
/** Start index of the worst `len`-day window (smallest sum), first on ties. */
function worstWindow(v, len) {
  let best = 0; let bestSum = Infinity; let s = 0;
  for (let i = 0; i < v.length; i += 1) { s += v[i]; if (i >= len) s -= v[i - len]; if (i >= len - 1 && s < bestSum) { bestSum = s; best = i - len + 1; } }
  return best;
}

function checkRules(rules) {
  const r = rules && typeof rules === 'object' ? rules : {};
  if (r.rebalance !== 'DAILY' && r.rebalance !== 'WEEKLY') refuse('BACKTEST_RULES_INVALID:rebalance');
  const quantile = r.quantile === undefined ? DEFAULT_QUANTILE : r.quantile;
  if (!isNum(quantile) || !(quantile > 0) || !(quantile <= 0.5)) refuse('BACKTEST_RULES_INVALID:quantile');
  const initialNav = r.initialNav === undefined ? DEFAULT_INITIAL_NAV : r.initialNav;
  if (!isNum(initialNav) || !(initialNav > 0)) refuse('BACKTEST_RULES_INVALID:initialNav');
  const neutralization = r.neutralization === undefined ? NEW_ROUND_NEUTRALIZATION : r.neutralization;
  if (typeof neutralization !== 'string') refuse('BACKTEST_RULES_INVALID:neutralization');
  return { rebalance: r.rebalance, quantile, initialNav, neutralization };
}

/**
 * @param {{formula: string, sources: object[], rules: {rebalance: 'DAILY'|'WEEKLY', quantile?: number, initialNav?: number, neutralization?: string}, existingBook: Array<{date, net}>|null,
 *   candidateId: string, market: 'CN_A', costBook: string, costModelRef: string}} a
 * @returns {{replay: object, timing: object, diagnostics: object} | {refusal: string}}
 */
function run({ formula, sources, rules, existingBook, candidateId, market = 'CN_A', costBook, costModelRef } = {}) {
  const t0 = process.hrtime.bigint();
  try {
    if (market !== 'CN_A') refuse(`BACKTEST_MARKET_UNSUPPORTED:${market}`);
    if (!Array.isArray(existingBook) || !existingBook.length) refuse('BACKTEST_EXISTING_BOOK_MISSING');
    const badBook = validateBook(existingBook);
    if (badBook) refuse(badBook);
    const rule = checkRules(rules);
    if (typeof candidateId !== 'string' || !candidateId || typeof costModelRef !== 'string' || !costModelRef) refuse('BACKTEST_INPUT_INVALID');
    const registry = costGate.coverage.loadRegistry();
    if (!registry.markets[market] || !registry.markets[market][costBook]) refuse(`BACKTEST_COST_BOOK_UNKNOWN:${costBook}`);
    if (!Array.isArray(sources) || !sources.length || sources.some((s) => s.holdout)) refuse('BACKTEST_SOURCES_INVALID');
    const f = runner.loadFrozenSpace();
    let parsed;
    try { parsed = dsl.parse(formula, f.dslSpace); } catch (e) { return { refusal: `BACKTEST_FORMULA_INVALID:${e.code || e.message}` }; }
    const tp = process.hrtime.bigint();
    const panel = adapter.buildPanel({ sources, space: f.space, segment: 'VALIDATION', from: segs.SEGMENTS.MINING.from, to: segs.SEGMENTS.VALIDATION.to });
    const neu = scoring.neutralizedValues(parsed, panel, { neutralization: rule.neutralization });
    const panelMs = ms(tp);
    // first day a book can be formed: a decision day with at least MIN_NAMES names with a finite value
    const T = panel.dates.length; let start = -1;
    for (let t = 0; t < T - 1 && start < 0; t += 1) {
      if (!isRebalanceDay(rule.rebalance, panel.dates, t)) continue;
      let n = 0; for (let j = 0; j < panel.codes.length; j += 1) if (panel.universe[t][j] && panel.labels.exec_open[t][j] > 0 && isNum(neu.values[t][j])) n += 1;
      if (n >= scoring.MIN_NAMES) start = t;
    }
    if (start < 0) refuse('BACKTEST_NO_TRADABLE_DAYS');
    const bookBy = new Map(existingBook.map((x) => [x.date, x.net]));
    const armMs = {};
    const arm = (key, quantile, universeOnly) => {
      const t = process.hrtime.bigint();
      const out = simulateArm({ panel, values: neu.values, rule: { rebalance: rule.rebalance, quantile, initialNav: rule.initialNav }, startIndex: start, universeOnly, cost: { book: costBook, ref: costModelRef } });
      armMs[key] = ms(t);
      return out;
    };
    const arms = { baseline: arm('baseline', rule.quantile, true), candidate: arm('candidate', rule.quantile, false),
      minus: arm('param_minus_20', rule.quantile * 0.8, false), plus: arm('param_plus_20', rule.quantile * 1.2, false) };
    // common dates with the book
    const keep = arms.candidate.daily.map((x, i) => (bookBy.has(x.date) ? i : -1)).filter((i) => i >= 0);
    if (!keep.length) refuse('BACKTEST_NO_COMMON_DATES');
    if (keep.length < Math.max(STRESS_DAYS, OVERLAP_WINDOW)) refuse('BACKTEST_TOO_FEW_DAYS');
    const dates = keep.map((i) => arms.candidate.daily[i].date); const dateSet = new Set(dates);
    const pick = (a) => keep.map((i) => a.daily[i]);
    const baselineDaily = pick(arms.baseline); const candDaily = pick(arms.candidate);
    const tPort = process.hrtime.bigint();
    const book = dates.map((d) => bookBy.get(d));
    const candNet = candDaily.map((x) => x.gross - x.cost); const candSimple = candNet.map(Math.expm1);
    const without = dates.map((date, i) => ({ date, net: book[i] }));
    armMs.portfolio_without = ms(tPort);
    const tWith = process.hrtime.bigint();
    const withC = dates.map((date, i) => ({ date, net: (1 - PORTFOLIO_WEIGHT) * book[i] + PORTFOLIO_WEIGHT * candSimple[i] }));
    const diff = withC.map((x, i) => x.net - without[i].net);
    const market20 = baselineDaily.map((x) => x.gross);
    const stress = [['STRESS_BOOK_WORST_20D', worstWindow(book, STRESS_DAYS)], ['STRESS_MARKET_WORST_20D', worstWindow(market20, STRESS_DAYS)]]
      .map(([id, s]) => ({ id, delta: diff.slice(s, s + STRESS_DAYS).reduce((a, b) => a + b, 0) }));
    const holdingsOverlap = [];
    for (let i = OVERLAP_WINDOW - 1; i < dates.length; i += 1) holdingsOverlap.push({ date: dates[i], jaccard: Math.abs(corr(candNet.slice(i - OVERLAP_WINDOW + 1, i + 1), book.slice(i - OVERLAP_WINDOW + 1, i + 1))) });
    armMs.portfolio_with = ms(tWith);
    const replay = {
      schema: 'LAB_REPLAY_OUTPUT_V1', candidate_id: candidateId, market, cost_model_ref: costModelRef, cost_book: costBook, cost_flags: {},
      arms: { baseline: { daily: baselineDaily }, candidate: { daily: candDaily } },
      trades: arms.candidate.trades.filter((x) => dateSet.has(x.date)),
      perturbations: [{ id: 'PARAM_MINUS_20', daily: pick(arms.minus) }, { id: 'PARAM_PLUS_20', daily: pick(arms.plus) }],
      portfolio: { with: withC, without, stress, holdings_overlap: holdingsOverlap },
    };
    const diagnostics = { candidate: { nav_start: keep.map((i) => arms.candidate.nav_start[i]), cost_cny: keep.map((i) => arms.candidate.cost_cny[i]), trades_per_day: keep.map((i) => arms.candidate.trades_per_day[i]), events: arms.candidate.events },
      panel: { dates: T, names: panel.codes.length, cells: T * panel.codes.length, start_date: panel.dates[start], common_dates: dates.length } };
    return { replay, timing: { arm_ms: Object.fromEntries(ARM_KEYS.map((k) => [k, Math.round((armMs[k] || 0) * 1000) / 1000])), panel_ms: Math.round(panelMs * 1000) / 1000, total_ms: Math.round(ms(t0) * 1000) / 1000 }, diagnostics };
  } catch (e) {
    if (e instanceof Refusal) return { refusal: e.code };
    throw e;
  }
}

/**
 * The DIAG-XM-1 replay series of the stock book are equity curves (arms.D.equity.dates / .values), not returns: daily net = values[i] / values[i-1] - 1, dated by the later day.
 * @returns {{book: {date, net}[]} | {refusal: string}}
 */
function netFromEquity({ dates, values }) {
  if (!Array.isArray(dates) || !Array.isArray(values) || dates.length !== values.length || dates.length < 2) return { refusal: 'BACKTEST_BOOK_EQUITY_INVALID' };
  if (values.some((v) => !(typeof v === 'number' && Number.isFinite(v) && v > 0))) return { refusal: 'BACKTEST_BOOK_EQUITY_INVALID' };
  const book = dates.slice(1).map((date, i) => ({ date, net: values[i + 1] / values[i] - 1 }));
  const bad = validateBook(book);
  return bad ? { refusal: bad } : { book };
}

module.exports = { netFromEquity, PORTFOLIO_WEIGHT, DEFAULT_INITIAL_NAV, DEFAULT_QUANTILE, COST_RESERVE, ARM_KEYS, run, readExistingBook, validateBook, internals: { simulateArm, isRebalanceDay, weekKey } };
