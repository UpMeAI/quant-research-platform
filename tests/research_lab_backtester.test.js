'use strict';
/**
 * W24b QRP-native factor-portfolio backtester (plan-coord NOTE_1 6b3be10d, 11-23): writes LAB_REPLAY_OUTPUT_V1 from the CN_A tables the RF1116 round runner reads (dev + validation),
 * rules fixed (daily or weekly rebalance, top quantile, equal weight, next-open fills, V-4 price limits and participation cap, registry r3 costs). Red first; fixture data only.
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeMiningDataFixture } = require('./_mining_data_fixture');
const R = require('./_lab_replay_fixture');
const P = require('./_promotion_fixture');
const adapter = require('../services/mining-sandbox/data-adapter');
const limits = require('../services/mining-sandbox/price-limits');
const costGate = require('../services/cost-gate');
const authority = require('../services/independent-verifier/authority');
const { canonicalJson } = require('../services/trial-ledger');
const replayOutput = require('../services/research-lab-e2e/replay-output');
const s3 = require('../services/research-lab-e2e/s3-evidence');
const s4 = require('../services/research-lab-e2e/s4-evidence');
const costRuns = require('../services/research-lab-e2e/cost-runs');
const bt = require('../services/research-lab-e2e/backtester');

const FORMULA = 'rank((-ret_1d))';
const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-bt-fx-')));
const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
const book = (from = '2020-06-01', n = 1700, seed = 11) => { const rnd = R.mulberry32(seed); return R.weekdays(from, n).map((date) => ({ date, net: 0.0002 + (rnd() - 0.5) * 0.008 })); };
const base = (over = {}) => ({ formula: FORMULA, sources: sources(), rules: { rebalance: 'WEEKLY', initialNav: 1e6 }, existingBook: book(), candidateId: 'AIP-CNA-001', market: 'CN_A', costBook: 'STOCK_BOOK', costModelRef: 'BT_TEST_COSTS_V1', ...over });
/** The fixture's codes are synthetic (S01.SH): V-4's boardOf reads the board from the code prefix, so the fixture codes are mapped to real-format codes of the same board for S3's constraints check. */
const BOARD_CODE = { MAIN_SH: '600', MAIN_SZ: '000', STAR: '688', CHINEXT: '300' };
const REAL = new Map([['S01.SH', 'MAIN_SH'], ['S02.SH', 'MAIN_SH'], ['S03.SH', 'STAR'], ['S04.SZ', 'MAIN_SZ'], ['S05.SZ', 'CHINEXT'], ['S06.SZ', 'MAIN_SZ'], ['S07.SH', 'MAIN_SH'], ['S08.SZ', 'CHINEXT'],
  ['S09.SH', 'STAR'], ['S10.SZ', 'MAIN_SZ'], ['S11.SH', 'MAIN_SH'], ['S12.SZ', 'MAIN_SZ'], ['T01.SH', 'MAIN_SH'], ['P01.SZ', 'MAIN_SZ'], ['N01.SZ', 'CHINEXT']]);
const realCode = (c) => `${BOARD_CODE[REAL.get(c)]}${c.slice(1, 3).padStart(3, '0')}.${c.split('.')[1]}`;
const realTrades = (trades) => trades.map((t) => ({ ...t, code: realCode(t.code) }));
const realReplay = (r) => ({ ...r, trades: realTrades(r.trades) });
const STAR = { by_layer: { ALPHA: { thresholds: { s4: { max_overlap: 0.6 } } } } };

let shared = null;
const weekly = () => { if (!shared) shared = bt.run(base()); return shared; };

test('run: replay passes replay-output.check, the six arms are aligned, perturbation ids are exact, timing sits outside the replay', () => {
  const out = weekly();
  assert.equal(out.refusal, undefined);
  const r = out.replay;
  assert.equal(r.schema, 'LAB_REPLAY_OUTPUT_V1');
  assert.equal(replayOutput.check(r), null);
  assert.deepEqual([r.candidate_id, r.market, r.cost_book, r.cost_model_ref], ['AIP-CNA-001', 'CN_A', 'STOCK_BOOK', 'BT_TEST_COSTS_V1']);
  assert.deepEqual(r.perturbations.map((p) => p.id), ['PARAM_MINUS_20', 'PARAM_PLUS_20']);
  const dates = r.arms.candidate.daily.map((x) => x.date);
  assert.ok(dates.length > 1000, String(dates.length));
  for (const arm of [r.arms.baseline.daily, ...r.perturbations.map((p) => p.daily)]) assert.deepEqual(arm.map((x) => x.date), dates);
  assert.equal(r.portfolio.with.length, r.portfolio.without.length);
  assert.deepEqual(r.portfolio.without.map((x) => x.date), dates, 'portfolio on the common dates of the arms and the book');
  assert.equal('timing' in r, false);
  const t = out.timing;
  assert.deepEqual(Object.keys(t.arm_ms).sort(), ['baseline', 'candidate', 'param_minus_20', 'param_plus_20', 'portfolio_with', 'portfolio_without']);
  assert.ok(t.panel_ms >= 0 && t.total_ms >= t.panel_ms);
  assert.notDeepEqual(r.arms.candidate.daily, r.arms.baseline.daily, 'the factor changes the book');
  const g = (a) => a.map((x) => x.gross).join();
  assert.notEqual(g(r.perturbations[0].daily), g(r.perturbations[1].daily));
  assert.notEqual(g(r.perturbations[0].daily), g(r.arms.candidate.daily));
});

test('run is deterministic: the replay bytes are identical across runs (timing excluded)', () => {
  const a = canonicalJson(weekly().replay); const b = canonicalJson(bt.run(base()).replay);
  assert.equal(a, b);
});

test('baseline is the same rules without the factor: another formula leaves it unchanged', () => {
  const other = bt.run(base({ formula: 'zscore((-ret_1d))' }));
  assert.deepEqual(other.replay.arms.baseline.daily, weekly().replay.arms.baseline.daily);
});

test('weekly rebalance decides on the first trading day of the week (Monday), daily rebalances every day', () => {
  const wk = (d) => { const t = Date.parse(`${d}T00:00:00Z`); const dow = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - dow * 864e5).toISOString().slice(0, 10); };
  const dates = weekly().replay.arms.candidate.daily.map((x) => x.date);
  const first = new Set(dates.filter((d, i) => i === 0 || wk(d) !== wk(dates[i - 1])));
  const trades = weekly().replay.trades;
  assert.ok(trades.length > 50);
  const off = trades.filter((t) => !first.has(t.date)); // only carried remainders (capped buys, blocked fills) trade off the decision day
  assert.ok(off.length <= trades.length * 0.05, `weekly trades off the decision day: ${off.length} of ${trades.length}`);
  const daily = bt.run(base({ rules: { rebalance: 'DAILY', initialNav: 1e6 } })).replay;
  assert.ok(new Set(daily.trades.map((t) => t.date)).size > new Set(trades.map((t) => t.date)).size * 2);
});

test('executed trades respect V-4: fills tradable at the price limit, participation within the cap; trade shape', () => {
  const r = weekly().replay;
  const cap = authority.loadConfig().participationCap;
  assert.equal(s3.constraintsOk(realTrades(r.trades), 'CN_A'), true);
  for (const t of r.trades) {
    assert.deepEqual(Object.keys(t).sort(), ['code', 'date', 'notional', 'open', 'participation', 'prev_close', 'side', 'st']);
    assert.ok(['BUY', 'SELL'].includes(t.side) && t.notional > 0 && t.participation > 0 && t.participation <= cap, JSON.stringify(t));
    assert.equal(typeof t.st, 'boolean');
  }
  assert.ok(r.trades.some((t) => t.side === 'BUY') && r.trades.some((t) => t.side === 'SELL'));
});

test('participation cap binds: a large book is capped at the cap of the day\'s traded amount and the remainder is carried to the next days', () => {
  const r = bt.run(base({ rules: { rebalance: 'WEEKLY', initialNav: 5e9 } })).replay;
  const cap = authority.loadConfig().participationCap;
  const atCap = r.trades.filter((t) => t.participation > cap * 0.999);
  assert.ok(atCap.length > 10, `trades at the cap: ${atCap.length}`);
  assert.ok(r.trades.every((t) => t.participation <= cap));
  const buyDays = (code) => new Set(r.trades.filter((t) => t.code === code && t.side === 'BUY').map((t) => t.date)).size;
  const codes = [...new Set(r.trades.map((t) => t.code))];
  assert.ok(codes.some((c) => buyDays(c) >= 2), 'the remainder of a capped buy is carried to later days');
  assert.equal(s3.constraintsOk(realTrades(r.trades), 'CN_A'), true);
});

/* ---- a hand-made panel: limit-up entry, limit-down exit, carried remainder ---- */
function tiny({ T = 10, open = (t, j) => 10, amount = () => 1e8, values = (t, j) => 10 - j } = {}) {
  const codes = ['600001.SH', '600002.SH', '600003.SH', '600004.SH', '600005.SH', '600006.SH'];
  const dates = R.weekdays('2025-03-03', T);
  const grid = (f) => dates.map((_, t) => codes.map((_, j) => f(t, j)));
  const o = grid(open);
  const panel = { segment: 'VALIDATION', dates, codes, universe: grid(() => true), board: codes.map((c) => limits.boardOf(c)), st: grid(() => false),
    readings: { amount: grid(amount) }, labels: { exec_open: o, open_raw: o, prev_close_raw: grid((t, j) => (t === 0 ? 10 : o[t - 1][j])) } };
  return { panel, values: grid(values), codes, dates };
}
const sim = (x, rule) => bt.internals.simulateArm({ panel: x.panel, values: x.values, rule: { rebalance: 'DAILY', quantile: 0.2, initialNav: 1e6, ...rule }, startIndex: 0, universeOnly: false });

test('limit-up at the entry open: no buy that day; the buy happens the first day the open is below the limit', () => {
  const x = tiny({ open: (t, j) => (j === 0 && t === 0 ? 11 : 10) }); // main board +10%: 11.00 is the limit
  const out = sim(x, {});
  const buys = out.trades.filter((t) => t.side === 'BUY');
  assert.equal(buys[0].date, x.dates[1]);
  assert.ok(!out.trades.some((t) => t.date === x.dates[0]));
});

test('limit-down at the exit open: the sell does not execute that day and is carried', () => {
  // name 0 is the pick until day 3, then name 1; name 0 opens at the limit-down (9.00 after 10) on day 3
  const x = tiny({ open: (t, j) => (j === 0 && t === 3 ? 9 : j === 0 && t > 3 ? 9 : 10), values: (t, j) => (t < 3 ? 10 - j : j === 1 ? 10 : 5 - j) });
  const out = sim(x, {});
  const sells0 = out.trades.filter((t) => t.code === x.codes[0] && t.side === 'SELL');
  assert.ok(sells0.length >= 1);
  assert.equal(out.trades.some((t) => t.date === x.dates[3] && t.code === x.codes[0] && t.side === 'SELL'), false, 'blocked at the limit-down open');
  assert.equal(sells0[0].date, x.dates[4], 'carried to the next day');
  assert.ok(out.events.exit_carried_limit_down >= 1);
});

test('participation cap on the tiny panel: 1,000,000 target, cap 10% of 4,000,000 = 400,000 a day, filled over three days', () => {
  const x = tiny({ amount: () => 4e6 });
  const out = sim(x, {});
  const buys = out.trades.filter((t) => t.side === 'BUY' && t.code === x.codes[0]);
  assert.deepEqual(buys.map((t) => Math.round(t.notional)), [400000, 400000, 200000].map((n, i) => (i === 2 ? Math.round(buys[2].notional) : n)));
  assert.ok(buys[0].participation <= 0.1 && buys[0].participation > 0.0999);
  assert.equal(buys.length, 3);
});

test('costs: the daily cost is the day\'s cost-runs price of that day\'s trades over the day\'s opening NAV; the total equals cost-runs.produce on all trades (G-COST COMPLETE)', () => {
  const out = bt.run(base());
  const r = out.replay; const d = out.diagnostics.candidate;
  const priced = costRuns.produce({ replay: r });
  const total = priced.v4.runs[0].cost_breakdown.items.reduce((s, i) => s + i.amount, 0);
  const mine = r.arms.candidate.daily.reduce((s, x, i) => s + x.cost * d.nav_start[i], 0);
  assert.ok(Math.abs(mine - total) < 1e-6 * Math.max(1, total), `${mine} vs ${total}`);
  assert.ok(total > 0);
  const cov = costGate.coverage.assessCoverage({ items: priced.v4.runs[0].cost_breakdown.items, books: r.cost_book, flags: r.cost_flags }, 'CN_A');
  assert.equal(cov.state, 'COMPLETE', JSON.stringify(cov));
  r.arms.candidate.daily.forEach((x, i) => { assert.ok(x.cost >= 0 && Number.isFinite(x.gross)); if (!d.trades_per_day[i]) assert.equal(x.cost, 0); });
});

test('portfolio: without = the book on the common dates, with = (1-w) book + w candidate net, stress windows from the data, overlap series is |rolling 60-day rho|', () => {
  const r = weekly().replay; const w = bt.PORTFOLIO_WEIGHT;
  assert.equal(w, 0.2);
  const bk = new Map(book().map((x) => [x.date, x.net]));
  r.portfolio.without.forEach((x) => assert.equal(x.net, bk.get(x.date)));
  r.portfolio.with.forEach((x, i) => {
    const c = r.arms.candidate.daily[i]; const net = Math.expm1(c.gross - c.cost);
    assert.ok(Math.abs(x.net - ((1 - w) * bk.get(x.date) + w * net)) < 1e-12, x.date);
  });
  assert.deepEqual(r.portfolio.stress.map((s) => s.id), ['STRESS_BOOK_WORST_20D', 'STRESS_MARKET_WORST_20D']);
  r.portfolio.stress.forEach((s) => assert.ok(Number.isFinite(s.delta)));
  const ho = r.portfolio.holdings_overlap;
  assert.equal(ho.length, r.portfolio.with.length - 59);
  ho.forEach((x) => assert.ok(x.jaccard >= 0 && x.jaccard <= 1 && /^\d{4}-\d{2}-\d{2}$/.test(x.date)));
});

test('the output feeds S3 and S4 without refusal; S4 overlap is the full-sample |corr(candidate net, book net)| for both holdings and risk', () => {
  const r = realReplay(weekly().replay);
  const t = P.terms({ candidate_id: 'AIP-CNA-001' });
  const a = s3.produce({ replay: r, terms: t });
  assert.equal(a.refusal, undefined, JSON.stringify(a));
  assert.equal(a.body.constraints_ok, true);
  const b = s4.produce({ replay: r, terms: t, star: STAR });
  assert.equal(b.refusal, undefined, JSON.stringify(b));
  const net = r.arms.candidate.daily.map((x) => x.gross - x.cost); const bk = r.portfolio.without.map((x) => x.net);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const mx = mean(net); const my = mean(bk);
  const rho = Math.abs(net.reduce((s, v, i) => s + (v - mx) * (bk[i] - my), 0) / Math.sqrt(net.reduce((s, v) => s + (v - mx) ** 2, 0) * bk.reduce((s, v) => s + (v - my) ** 2, 0)));
  assert.ok(Math.abs(b.body.overlap.risk - rho) < 1e-9 && Math.abs(b.body.overlap.holdings - rho) < 1e-9, `${b.body.overlap.risk} ${b.body.overlap.holdings} ${rho}`);
});

test('refusals: no existing book, an empty common window, bad rules, unknown cost book', () => {
  assert.equal(bt.run(base({ existingBook: null })).refusal, 'BACKTEST_EXISTING_BOOK_MISSING');
  assert.equal(bt.run(base({ existingBook: [] })).refusal, 'BACKTEST_EXISTING_BOOK_MISSING');
  assert.equal(bt.run(base({ existingBook: book('2010-01-04', 50) })).refusal, 'BACKTEST_NO_COMMON_DATES');
  assert.equal(bt.run(base({ rules: { rebalance: 'MONTHLY' } })).refusal, 'BACKTEST_RULES_INVALID:rebalance');
  assert.equal(bt.run(base({ rules: { rebalance: 'DAILY', quantile: 0.9 } })).refusal, 'BACKTEST_RULES_INVALID:quantile');
  assert.equal(bt.run(base({ market: 'US' })).refusal, 'BACKTEST_MARKET_UNSUPPORTED:US');
  assert.match(bt.run(base({ costBook: 'NOPE' })).refusal, /^COST_RUN_BOOK_UNKNOWN|^BACKTEST_COST_BOOK_UNKNOWN/);
});

/* ---- readExistingBook ---- */
const tmp = (name, text) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-bt-book-')), name); fs.writeFileSync(f, text); return f; };
test('readExistingBook: CSV and JSON read back the same rows; validation refuses unsorted, duplicate, non-finite, malformed and empty files', () => {
  const rows = [{ date: '2025-01-02', net: 0.001 }, { date: '2025-01-03', net: -0.002 }, { date: '2025-01-06', net: 0 }];
  const csv = bt.readExistingBook({ file: tmp('b.csv', `date,net\n${rows.map((x) => `${x.date},${x.net}`).join('\n')}\n`) });
  const json = bt.readExistingBook({ file: tmp('b.json', JSON.stringify(rows)) });
  assert.deepEqual(csv.book, rows); assert.deepEqual(json.book, rows);
  const bad = (name, text) => bt.readExistingBook({ file: tmp(name, text) }).refusal;
  assert.equal(bad('u.csv', 'date,net\n2025-01-03,0.1\n2025-01-02,0.1\n'), 'BACKTEST_BOOK_NOT_SORTED');
  assert.equal(bad('d.csv', 'date,net\n2025-01-02,0.1\n2025-01-02,0.2\n'), 'BACKTEST_BOOK_DUPLICATE_DATE');
  assert.equal(bad('n.csv', 'date,net\n2025-01-02,abc\n'), 'BACKTEST_BOOK_NOT_FINITE');
  assert.equal(bad('i.json', JSON.stringify([{ date: '2025-01-02', net: null }])), 'BACKTEST_BOOK_NOT_FINITE');
  assert.equal(bad('x.csv', 'date,net\n2025/01/02,0.1\n'), 'BACKTEST_BOOK_DATE_INVALID');
  assert.equal(bad('h.csv', 'day,value\n2025-01-02,0.1\n'), 'BACKTEST_BOOK_HEADER_INVALID');
  assert.equal(bad('e.csv', 'date,net\n'), 'BACKTEST_BOOK_EMPTY');
  assert.equal(bad('j.json', '{not json'), 'BACKTEST_BOOK_UNREADABLE');
  assert.equal(bt.readExistingBook({ file: path.join(os.tmpdir(), 'qrp-bt-nope.csv') }).refusal, 'BACKTEST_BOOK_UNREADABLE');
  assert.equal(bt.readExistingBook({}).refusal, 'BACKTEST_BOOK_UNREADABLE');
});

test('netFromEquity turns the DIAG-XM-1 equity curve into daily net returns dated by the later day, and refuses a broken curve', () => {
  const bt = require('../services/research-lab-e2e/backtester');
  const r = bt.netFromEquity({ dates: ['2026-01-02', '2026-01-05', '2026-01-06'], values: [1, 1.01, 0.9999] });
  assert.equal(r.refusal, undefined);
  assert.deepEqual(r.book.map((x) => x.date), ['2026-01-05', '2026-01-06']);
  assert.ok(Math.abs(r.book[0].net - 0.01) < 1e-12 && Math.abs(r.book[1].net - (0.9999 / 1.01 - 1)) < 1e-12);
  assert.equal(bt.netFromEquity({ dates: ['2026-01-02'], values: [1] }).refusal, 'BACKTEST_BOOK_EQUITY_INVALID');
  assert.equal(bt.netFromEquity({ dates: ['a', 'b'], values: [1, 0] }).refusal, 'BACKTEST_BOOK_EQUITY_INVALID');
});
