'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * SIGNAL_REGISTRY_V1（docs/contracts/SIGNAL_REGISTRY_V1.md）：美股、加密的信号登记簿。
 *
 * 夹具 tests/fixtures/signal-registry/inbox 由 tests/support/build-signal-registry-fixture.js 从 desk 收件箱生成：四本账本的最新记分牌、
 * 全部成交台账按字节复制（自带哈希可验），周复盘与期末快照是只留登记簿所需字段的投影。var/evidence/signal-registry-2026-11-01 是
 * 同一批输入在完整文件上的一次运行（来源全部 VERIFIED）。
 */

const R = require('../services/signal-registry');
const { compareRegistry } = require('../services/signal-registry/conformance');
const { validateRecord } = require('../schemas');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'signal-registry', 'inbox');
const EVIDENCE = path.join(ROOT, 'var', 'evidence', 'signal-registry-2026-11-01');
const clone = (v) => JSON.parse(JSON.stringify(v));

const inputs = () => Object.keys(R.BOOKS).map((id) => R.readBookInputs(FIXTURE, id));
const boardsOf = (ins) => Object.fromEntries(ins.map((i) => [i.ledgerId, i.scoreboard.json]));

// -- 1. the four books against their scoreboards ---------------------------------------------------------------------------

test('T1 四本账本：登记簿对记分牌两边都有的 752 个字段 0 差异；行与证据目录里完整文件那次运行逐字相同；结构符合 schema', () => {
  const ins = inputs();
  const reg = R.buildRegistry(ins);
  const report = compareRegistry(reg, boardsOf(ins));
  assert.deepEqual(report.books.map((b) => [b.ledgerId, b.compared, b.differences.length]), [
    ['US_V5_ETF_3000USD', 319, 0], ['US_CORE_9000USD_3X_GATEOBS', 46, 0], ['C17_V2_4000USDT', 326, 0], ['QUICK_SHOT_V3_1000USDT', 61, 0]]);
  assert.equal(report.compared, 752);
  assert.equal(report.differences, 0);

  assert.ok(validateRecord(reg, 'SIGNAL_REGISTRY_V1').ok);
  const allRows = [...reg.rows, ...reg.books.flatMap((b) => b.blocks.map((x) => x.rollup))];
  for (const row of allRows) assert.ok(validateRecord(row, 'SIGNAL_REGISTRY_ROW_V1').ok, row.rowId);
  assert.deepEqual(reg.rows.map((r) => r.rowId), [
    'US_V5_ETF_3000USD|-|V5_SIGNAL:TREND:BUY',
    'C17_V2_4000USDT|BTC_ETH|C17_SIGNAL_AND_RANKING+TREND',
    'C17_V2_4000USDT|NON_MAJOR|C17_SIGNAL_AND_RANKING+TREND',
    'QUICK_SHOT_V3_1000USDT|-|QUICK_SHOT_RULES_V3+QS_V3_SIGNAL_BEARISH+FORWARD_EVIDENCE_TUNING_V1_INSUFFICIENT',
    'QUICK_SHOT_V3_1000USDT|-|QUICK_SHOT_RULES_V3+QS_V3_SIGNAL_BULLISH+FORWARD_EVIDENCE_TUNING_V1_INSUFFICIENT',
  ]);
  // US_CORE 是轮动账本：没有往返交易，只有汇总行。
  const core = reg.books.find((b) => b.ledgerId === 'US_CORE_9000USD_3X_GATEOBS');
  assert.equal(core.blocks[0].rowsState, R.CODES.NO_ROUND_TRIP);
  assert.equal(core.blocks[0].rollup.windows.bookSinceStart.costs.fee.amount, 4.5);

  const evidence = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'SIGNAL_REGISTRY_V1.json'), 'utf8'));
  assert.equal(R.contentHash(evidence), evidence.hash);
  assert.equal(R.canonicalJson(reg.rows), R.canonicalJson(evidence.rows));
  const noSources = (books) => books.map((b) => ({ ...b, sources: null }));
  assert.equal(R.canonicalJson(noSources(reg.books)), R.canonicalJson(noSources(evidence.books)));
  for (const b of evidence.books) {
    assert.equal(b.sources.scoreboard.hashState, 'VERIFIED');
    for (const s of [...b.sources.tradeLedgers, ...b.sources.strategyReviews]) assert.equal(s.hashState, 'VERIFIED');
  }
  const conf = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'SIGNAL_REGISTRY_V1.conformance.json'), 'utf8'));
  assert.equal(conf.registryHash, evidence.hash);
  assert.equal(conf.compared, 752);
  assert.equal(conf.differences, 0);
});

test('T2 来源核对照实写出：成交台账停在毛值的三笔（资金费交付后才落定），4733 的资金费由记分牌期末窗口重述；快照持仓与期末未平一致', () => {
  const reg = R.buildRegistry(inputs());
  const c17 = reg.books.find((b) => b.ledgerId === 'C17_V2_4000USDT');
  assert.deepEqual(c17.sourceChecks.divergences.map((d) => `${d.kind}:${d.tradeId || d.rowId}`), [
    'TRADE_LEDGER_GROSS_REVIEW_NET:4733', 'TRADE_LEDGER_GROSS_REVIEW_NET:4739', 'TRADE_LEDGER_GROSS_REVIEW_NET:4749',
    'COST_RESTATED_BY_SCOREBOARD_WINDOW:C17_V2_4000USDT|BTC_ETH|*', 'COST_RESTATED_BY_SCOREBOARD_WINDOW:C17_V2_4000USDT|BTC_ETH|C17_SIGNAL_AND_RANKING+TREND']);
  const t = Object.fromEntries(c17.trades.map((x) => [x.tradeId, x]));
  assert.equal(t['4749'].outcomeSource, 'SCOREBOARD_STATE_TAG'); // 标签里是本期净值，不用台账那份毛值
  assert.equal(t['4733'].outcomeSource, 'STRATEGY_REVIEW');
  assert.equal(t['4730'].outcomeSource, 'TRADE_LEDGER');
  for (const b of reg.books) assert.equal(b.sourceChecks.snapshotOpenLots.state, 'MATCH', b.ledgerId);
  const btc = reg.rows.find((r) => r.rowId === 'C17_V2_4000USDT|BTC_ETH|C17_SIGNAL_AND_RANKING+TREND');
  assert.equal(btc.windows.bookSinceStart.costsSource, 'SCOREBOARD_WINDOW:funding');
  assert.equal(btc.windows.currentVersion.costsSource, 'TRADE_ROWS');
});

test('T3 一致性检查会报出差异：改记分牌一个窗口的笔数、一个状态格、一笔标签的结果，各自报在对应路径上', () => {
  const ins = inputs();
  const reg = R.buildRegistry(ins);
  const boards = clone(boardsOf(ins));
  boards.QUICK_SHOT_V3_1000USDT.windows.currentVersion.closed += 1;
  const part = boards.C17_V2_4000USDT.parts.find((p) => p.partId === 'NON_MAJOR');
  part.stateSplit.windows.currentVersion.axes.price.cells[0].open += 1;
  const tag = part.stateSplit.tags.find((x) => x.outcome);
  tag.outcome.netPnl += 0.01;
  const report = compareRegistry(reg, boards);
  assert.deepEqual(report.books.flatMap((b) => b.differences.map((d) => d.path)), [
    'C17_V2_4000USDT:NON_MAJOR.stateSplit.currentVersion.price.TREND.open',
    `C17_V2_4000USDT:NON_MAJOR.trade.${tag.tradeId}.pnl`,
    'QUICK_SHOT_V3_1000USDT.windows.currentVersion.closed',
  ]);
});

test('T4 来源失败即关：完整文件的自带哈希不符就拒；投影只登记原文件哈希', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigreg-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const file = path.join(dir, 'SMARTFLOW_CRYPTO', 'trades', 'QUICK_SHOT_V3_1000USDT', 'TRADE_LEDGER_2026-10-07.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.events[0].price += 1;
  fs.writeFileSync(file, JSON.stringify(j));
  assert.throws(() => R.readBookInputs(dir, 'QUICK_SHOT_V3_1000USDT'), /SOURCE_HASH_MISMATCH/);
  const ins = R.readBookInputs(FIXTURE, 'QUICK_SHOT_V3_1000USDT');
  assert.ok(ins.reviews.every((r) => r.ref.hashState === 'PROJECTION_DECLARED' && /^[0-9a-f]{64}$/.test(r.ref.hash)));
  assert.throws(() => R.readBookInputs(FIXTURE, 'US_V5_ETF_6000USD'), /BOOK_NOT_IN_SCOPE/);
});

// -- 2. the rules on synthetic books ---------------------------------------------------------------------------------------

const QS = 'QUICK_SHOT_V3_1000USDT';
const PERIOD = '2026-11-01';
const T0 = Date.parse('2026-10-07T00:00:00Z');
const H = 3600000;
const ref = (file) => ({ file, contract: null, hash: '0'.repeat(64), hashState: 'VERIFIED' });

/** n 笔已平的 QS 交易（第 i 笔第 i 小时开、开后 1 小时平），pnl(i)、prov(i) 给每笔的结果与费用来源；一张只有自起始窗的记分牌。 */
function synthetic({ n, pnl = (i) => (i % 3 === 0 ? -1 : 2), prov = () => ({ fee: 'MODELLED', funding: 'MEASURED', slippage: 'MODELLED' }),
  ledgerState = () => 'MEASURED', signal = () => 'QS_V3_SIGNAL_BULLISH', sbCosts = null }) {
  const events = [];
  const reviews = [];
  for (let i = 0; i < n; i += 1) {
    const lot = `${QS}:XUSDT:${i + 1}`;
    const decision = (codes) => ({ planId: null, signalId: null, reasonCodes: codes, ruleRef: null });
    events.push({ eventId: `${QS}:${i + 1}:OPEN`, lotId: lot, instrument: { id: 'XUSDT' }, purpose: 'OPEN', executedAt: new Date(T0 + i * H).toISOString(),
      decision: decision(['QUICK_SHOT_RULES_V3', signal(i)]), realized: { state: 'NOT_APPLICABLE' } });
    events.push({ eventId: `${QS}:${i + 1}:CLOSE`, lotId: lot, instrument: { id: 'XUSDT' }, purpose: 'CLOSE', executedAt: new Date(T0 + i * H + H).toISOString(),
      decision: decision(['QS_V3_EXIT_STOP_3PCT']), realized: { state: ledgerState(i), currencyAmount: pnl(i), r: pnl(i) / 2 } });
    const p = prov(i);
    reviews.push({ tradeId: String(i + 1), pnl: pnl(i), rMultiple: pnl(i) / 2, costs: { fee: p.fee === 'UNKNOWN' ? null : 0.1, funding: p.funding === 'UNKNOWN' ? null : 0.01, slippage: 0.2 },
      costProvenance: p });
  }
  const frame = { state: 'MEASURED', reasonCode: null, from: new Date(T0).toISOString(), to: '2026-11-02T00:00:00.000Z', segmentIds: [`${QS}:S1`],
    closed: n, costs: sbCosts };
  const none = { state: 'NOT_APPLICABLE', reasonCode: 'NOT_APPLICABLE:NO_PREVIOUS_VERSION', from: null, to: null, segmentIds: [] };
  const sb = { contract: 'STRATEGY_SCOREBOARD_V1', ledgerId: QS, period: { to: PERIOD, clock: 'UTC_DAYS' }, generatedAt: '2026-11-02T00:20:00.000Z',
    book: { state: 'RUNNING', startedAt: new Date(T0).toISOString() }, bindings: { strategyReview: { hash: '0'.repeat(64) } },
    windows: { bookSinceStart: frame, currentVersion: frame, previousVersion: none } };
  return { ledgerId: QS, scoreboard: { json: sb, ref: ref('sb') }, ledgers: [{ json: { events }, ref: ref('tl') }],
    reviews: [{ json: { tradeReviews: reviews }, ref: ref('rv') }], snapshot: null };
}

test('T5 下限：已平 29 笔只给赚亏笔数与 INSUFFICIENT_SAMPLE；30 笔才出胜率、平均 R、t 与每笔期望金额（_like，2 位）', () => {
  const w29 = R.buildBook(synthetic({ n: 29 })).book.blocks[0].rollup.windows.bookSinceStart;
  assert.deepEqual([w29.closed, w29.wins, w29.losses, w29.flats], [29, 19, 10, 0]);
  for (const k of ['winRate', 'avgR', 'expectancyT', 'expectancyAmount_like']) assert.equal(w29[k].state, 'INSUFFICIENT_SAMPLE', k);
  assert.equal(w29.expectancyAmount_like.value, null);
  const w30 = R.buildBook(synthetic({ n: 30 })).book.blocks[0].rollup.windows.bookSinceStart;
  assert.deepEqual(w30.winRate, { value: 0.6667, state: 'MEASURED', reasonCode: null });
  assert.deepEqual(w30.avgR, { value: 0.5, state: 'MEASURED', reasonCode: null });
  assert.equal(w30.expectancyT.state, 'MEASURED');
  assert.deepEqual(w30.expectancyAmount_like, { value: 1, state: 'MEASURED', reasonCode: null, basis: 'NET', currency: 'USDT' });
});

test('T6 未知费用不补 0：一笔资金费 UNKNOWN → 该项 NOT_MEASURED、金额 null、口径 GROSS；没有毛值就整窗 UNKNOWN，不拿净值顶', () => {
  const unknownFunding = (i) => ({ fee: 'MODELLED', funding: i === 3 ? 'UNKNOWN' : 'MEASURED', slippage: 'MODELLED' });
  const g = R.buildBook(synthetic({ n: 5, prov: unknownFunding, ledgerState: () => 'MEASURED_GROSS' })).book.blocks[0].rollup.windows.bookSinceStart;
  assert.equal(g.state, 'MEASURED');
  assert.equal(g.pnlBasis, 'GROSS');
  assert.deepEqual(g.costs.funding, { state: 'NOT_MEASURED', amount: null, reasonCode: 'FUNDING_NOT_RECORDED' });
  assert.equal(g.costs.fee.amount, 0.5);
  // GROSS 口径要每笔的毛值；台账给的是净值、复盘不带毛值 → 整窗 UNKNOWN，各项为 null（与记分牌 emptyWindow 同）。
  const w = R.buildBook(synthetic({ n: 5, prov: unknownFunding })).book.blocks[0].rollup.windows.bookSinceStart;
  assert.deepEqual([w.state, w.reasonCode, w.closed, w.winRate, w.costs], ['UNKNOWN', R.CODES.PNL_NOT_RECORDED, null, null, null]);
});

test('T7 记分牌期末重述只在整窗同一组交易时用；按信号拆出的子集不借记分牌的数，照样 NOT_MEASURED', () => {
  const stale = (i) => ({ fee: 'MODELLED', funding: i === 0 ? 'UNKNOWN' : 'MEASURED', slippage: 'MODELLED' });
  const sbCosts = { fee: { state: 'MODELLED', amount: 0.4, reasonCode: null }, funding: { state: 'MEASURED', amount: 0.04, reasonCode: null },
    slippage: { state: 'MODELLED', amount: 0.8, reasonCode: null } };
  const built = R.buildBook(synthetic({ n: 4, prov: stale, sbCosts, ledgerState: (i) => (i < 2 ? 'MEASURED_GROSS' : 'MEASURED'),
    signal: (i) => (i < 2 ? 'QS_V3_SIGNAL_BEARISH' : 'QS_V3_SIGNAL_BULLISH') }));
  const rollup = built.book.blocks[0].rollup.windows.bookSinceStart;
  assert.deepEqual(rollup.costs.funding, sbCosts.funding);
  assert.equal(rollup.costsSource, 'SCOREBOARD_WINDOW:funding');
  const bear = built.rows.find((r) => r.signalKey.includes('BEARISH')).windows.bookSinceStart;
  assert.equal(bear.costs.funding.state, 'NOT_MEASURED');
  assert.equal(bear.costsSource, 'TRADE_ROWS');
  const bull = built.rows.find((r) => r.signalKey.includes('BULLISH')).windows.bookSinceStart;
  assert.equal(bull.costs.funding.amount, 0.02);
  // 夹具的记分牌两窗同一组交易：汇总行两窗都重述，信号行一窗也不重述。
  assert.deepEqual(built.book.sourceChecks.divergences.filter((d) => d.kind === 'COST_RESTATED_BY_SCOREBOARD_WINDOW')
    .map((d) => [d.rowId, d.window, d.staleTradeIds]), [[`${QS}|-|*`, 'bookSinceStart', ['1']], [`${QS}|-|*`, 'currentVersion', ['1']]]);
});

test('T8 结果来源次序：记分牌标签 > 口径相符的成交台账 > 周复盘行；台账停在毛值的那笔取复盘净值并记分歧', () => {
  const inp = synthetic({ n: 3, ledgerState: (i) => (i === 1 ? 'MEASURED_GROSS' : 'MEASURED') });
  inp.reviews[0].json.tradeReviews[1].pnl = 1.5;
  inp.scoreboard.json.stateSplit = { state: 'ACTIVE', reasonCode: null, since: new Date(T0).toISOString(), mapping: null, axisKeys: {},
    tags: [{ tradeId: '3', axes: {}, outcome: { closedAt: new Date(T0 + 3 * H).toISOString(), netPnl: 2.25, resultR: 1.125, pnlBasis: 'NET' } }],
    windows: { bookSinceStart: { state: 'MEASURED', from: null, to: null, segmentIds: [], axes: null }, currentVersion: { state: 'MEASURED', from: null, to: null, segmentIds: [], axes: null } } };
  const b = R.buildBook(inp).book;
  assert.deepEqual(b.trades.map((t) => [t.tradeId, t.pnl, t.outcomeSource]), [['1', -1, 'TRADE_LEDGER'], ['2', 1.5, 'STRATEGY_REVIEW'], ['3', 2.25, 'SCOREBOARD_STATE_TAG']]);
  assert.deepEqual(b.sourceChecks.divergences.map((d) => d.kind), ['TRADE_LEDGER_GROSS_REVIEW_NET', 'TRADE_LEDGER_VS_SCOREBOARD_TAG']);
});

test('T9 命令行：在夹具上 0 差异退出 0，只读、不写台账', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sigreg-cli-'));
  const res = spawnSync(process.execPath, [path.join(ROOT, 'apps', 'research-cli', 'build_signal_registry.js'), '--inbox', FIXTURE,
    '--out', path.join(out, 'r.json'), '--conformance-out', path.join(out, 'c.json')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const line = JSON.parse(res.stdout);
  assert.deepEqual([line.rows, line.conformance.compared, line.conformance.differences, line.production_effect], [5, 752, 0, 'NONE']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'c.json'), 'utf8')).differences, 0);
});
