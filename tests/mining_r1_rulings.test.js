'use strict';
/**
 * 协调会话裁定 R1（RF1116_RULING_R1_20261117.md，ce254328…，2026-11-17）在 P2 执行器与 P1 轮次上的落地（P2c）。先红后绿，全部是合成数据。
 *   R1.1 每次尝试都是一行试验台账（P2b 已做，合同里引 R1.1）；
 *   R1.2 验证折选择规则冻结进清单（数据，不是常量）；每份清单 rulings 引裁定页，仓库 docs/freeze/ 有逐字节副本；
 *   R1.3 DSR 在前推验证折的月度收益上算，N = 本族累计尝试数（≥ 24 个月才算得出）；
 *   R1.4 第 7、8 项要的现有因子序列：读登记过的导出（FACTOR_SERIES_V1），能对上个股的算，对不上的照实写 UNKNOWN；
 *   R1.5 第 9 项：留出段开启之前写机制登记（带时间戳、只追加、过 G-MECH 去重），没有登记的照样打分、第 9 项不过并写原因；命令行 mechanisms；
 *   R1.6 每个市场最多同时开 2 个只生成的轮次；每段留出段最多给 2 轮用，第 3 轮起要新的（在旧段之后）；留出段开启次数按族累计并写进轮次记录；
 *   R1.7 涨跌停按 V6 实盘的板块规则：涨停开盘买不进、跌停开盘卖不出（第 6 项扣成本净值用它）。
 */
const { dataRoot } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const AUTH = 'TEST_R1_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const { makeMiningDataFixture, internals: fxi } = require('./_mining_data_fixture');
const { R1, R1_RULING, R1_SELECTION_RULE } = require('./_mining_manifest');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const selector = require('../services/mining-sandbox/round-runner/selector');
const holdoutScoring = require('../services/mining-sandbox/round-runner/holdout-scoring');
const limits = require('../services/mining-sandbox/price-limits');
const factorSeries = require('../services/mining-sandbox/factor-series');
const rounds = require('../services/mining-rounds');
const mechanisms = require('../services/mining-rounds/mechanisms');
const vault = require('../services/holdout-vault');
const gateRecords = require('../services/mining-rounds/gate-records');
const gate = require('../services/mining-gate');
const trials = require('../services/trial-ledger');
const factorLib = require('../services/factor-library');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'services/mining-sandbox/round-runner/cli.js');
const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r1-fx-')));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r1-data-')); process.env.QRP_DATA_DIR = d; return d; };
const HOLDOUT_SUMS_SHA = sha(fs.readFileSync(path.join(fx.dirs.holdout, 'SHA256SUMS')));
const COV = Object.freeze({ min_names_per_day: 5 });
const KNOWN = ['rank((-ret_1d))', 'zscore((-ret_1d))', 'rank((-ts_mean(ret_1d,5)))', 'rank(pb)', 'rank(ts_delta(close_hfq,1))', 'zscore(turnover_f)'];
const knownGen = { mode: 'AI_MINED_GP', seed: 0, params: { batch_size: 40 }, nextBatch: (view, { n }) => KNOWN.slice(view.mining_scores.length, view.mining_scores.length + n) };
const GP = Object.freeze({ mode: 'AI_MINED_GP', gp_seed: 1 });
const H1 = Object.freeze({ from: '2026-10-19', to: '2026-12-31' });
const runDirOf = (out, id) => path.join(out, 'rounds', id.replace(/[^A-Za-z0-9_-]/g, '_'));
const roundTrials = (roundId) => [...trials.heads().values()].filter((t) => t.role === 'MINED_CANDIDATE' && t.mining && t.mining.round_id === roundId);
const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
/** 开到选择为止（GP 换成已知的六个公式，跑得快、结果可控）。 */
function toSelection(out, { openedAt = '2026-11-21T02:00:00Z', manifest = null } = {}) {
  const r = manifest ? rounds.openRound(manifest) : runner.requestRound({ generator: GP, cap: KNOWN.length, openedAt });
  runner.sealHoldout({ roundId: r.round_id, dataRef: 'synthetic:holdout', dataSha256: HOLDOUT_SUMS_SHA });
  runner.internals.withGenerator(knownGen, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV }));
  const sel = runner.select({ roundId: r.round_id, sources: sources(), outDir: out });
  return { r, sel };
}

test('R1.2：清单带 rulings（裁定页路径 + sha，docs/freeze/ 有逐字节副本）与冻结的选择规则（数据）；缺了、副本不对、规则不对都拒绝；选择读清单里的规则', () => {
  const copy = fs.readFileSync(path.join(ROOT, 'docs/freeze/RF1116_RULING_R1_20261117.md'));
  assert.equal(sha(copy), R1_RULING.sha256);
  assert.ok(copy.toString('utf8').includes('R1.2') && copy.toString('utf8').includes('R1.6') && copy.toString('utf8').includes('R1.8') && copy.toString('utf8').includes('R1.9') && copy.toString('utf8').includes('R1.11'), 'revision 3 of the ruling');
  assert.deepEqual(selector.RULE, R1_SELECTION_RULE, 'selector.RULE is the R1.2 rule, written as data');
  assert.ok(Object.isFrozen(selector.RULE) && Object.isFrozen(selector.RULE.folds));
  freshData();
  const r = runner.requestRound({ generator: GP, cap: KNOWN.length, openedAt: '2026-11-20T02:00:00Z' });
  assert.deepEqual(r.rulings, [R1_RULING]);
  assert.deepEqual(r.selection_rule, R1_SELECTION_RULE);
  assert.notEqual(rounds.manifestSha({ ...r, selection_rule: { ...r.selection_rule, positive_folds_min: 5 } }), rounds.manifestSha(r), 'the rule is part of the pre-registration');
  const f = runner.loadFrozenSpace();
  const base = { market: 'CN_A', space: { space_ref: f.space.space_ref, sha256: f.space.sha256, freeze: f.freeze }, holding_periods: [5], generator: GP, holdout: H1, cap: 6, openedAt: '2026-11-22T02:00:00Z' };
  freshData();
  assert.throws(() => rounds.openRound({ ...base, selection_rule: R1_SELECTION_RULE }), code(/MINE_ROUND_RULINGS_REQUIRED/));
  assert.throws(() => rounds.openRound({ ...base, ...R1, rulings: [{ ...R1_RULING, sha256: 'f'.repeat(64) }] }), code(/MINE_ROUND_RULING_COPY_INVALID/));
  assert.throws(() => rounds.openRound({ ...base, ...R1, rulings: [{ path: 'artifacts/coordinator/NOT_THERE.md', sha256: R1_RULING.sha256 }] }), code(/MINE_ROUND_RULING_COPY_INVALID/));
  assert.throws(() => rounds.openRound({ ...base, rulings: [R1_RULING] }), code(/MINE_ROUND_SELECTION_RULE_REQUIRED/));
  for (const bad of [{ positive_folds_min: 7 }, { mean_ic_gt: 'zero' }, { folds: [R1_SELECTION_RULE.folds[1], R1_SELECTION_RULE.folds[0]] },
    { folds: [{ fold: 1, from: '2024-01-02', to: '2024-07-31' }, { fold: 2, from: '2024-07-01', to: '2024-12-31' }] }, { schema: 'OTHER' }]) {
    assert.throws(() => rounds.openRound({ ...base, ...R1, selection_rule: { ...R1_SELECTION_RULE, ...bad } }), code(/MINE_ROUND_SELECTION_RULE_INVALID/), JSON.stringify(bad));
  }
  // 同样的六个公式：R1.2 的规则选得出反转公式；清单里写一条更严的规则，选择就照它（读清单，不读常量）
  const outA = freshData(); const a = toSelection(outA);
  assert.ok(a.sel.selected.includes(`${a.r.round_id}:A001`));
  assert.deepEqual(a.sel.rule, R1_SELECTION_RULE);
  const outB = freshData();
  const strict = { ...R1_SELECTION_RULE, mean_ic_gt: 0.9 };
  const b = toSelection(outB, { manifest: { ...base, ...R1, selection_rule: strict } });
  assert.deepEqual(b.sel.selected, []);
  assert.deepEqual(b.sel.rule, strict);
  assert.deepEqual(rounds.selectionOf(b.r.round_id).rule, strict);
});

test('R1.6：每个市场最多同时开 2 个只生成的轮次；每轮各开一次留出段，开启次数按族累计写进轮次与开启记录；一段留出段最多 2 轮用，第 3 轮要新段（在旧段之后）', () => {
  freshData();
  const sp = (n) => ({ space_ref: `MS-R16-${n}`, sha256: sha(`r16-space-${n}`), freeze: { path: `f-${n}`, sha256: sha(`r16-freeze-${n}`) } });
  const open = (n, at, holdout = H1) => rounds.openRound({ market: 'CN_A', space: sp(n), holding_periods: [5], generator: GP, holdout, openedAt: at, ...R1 });
  const a = open(1, '2026-11-17T04:00:00Z'); const b = open(2, '2026-11-18T04:00:00Z');
  assert.deepEqual([a.status, b.status], ['OPEN', 'OPEN'], 'two generation-only rounds at once');
  assert.throws(() => open(3, '2026-12-01T04:00:00Z', { from: '2027-01-04', to: '2027-03-31' }), code(/MINE_ROUND_ALREADY_OPEN/), 'a third concurrent round');
  assert.equal(rounds.LIMITS.open_rounds_per_market, 2);
  assert.equal(rounds.LIMITS.rounds_per_holdout, 2);
  const cand = (r, k) => rounds.recordCandidate(r.round_id, { candidate_id: `${r.round_id}:A00${k}`, formula_canonical: `rank(ts_mean(pb,${k}))`, formula_sha256: sha(`rank(ts_mean(pb,${k}))`),
    holding_period: 5, mining_score: 0.01 }, { registeredBy: AUTH });
  cand(a, 5); cand(b, 5);
  for (const r of [a, b]) vault.seal({ round_id: r.round_id, segment: H1, data_ref: 'synthetic', data_sha256: sha('h'), sealedBy: 'TEST' });
  vault.open({ round_id: a.round_id, candidate_ids: [`${a.round_id}:A005`], openedBy: 'TEST' });
  vault.open({ round_id: b.round_id, candidate_ids: [`${b.round_id}:A005`], openedBy: 'TEST' });
  assert.throws(() => vault.open({ round_id: a.round_id, candidate_ids: [`${a.round_id}:A005`], openedBy: 'TEST' }), code(/MINE_HOLDOUT_ALREADY_OPENED/));
  assert.deepEqual(vault.openLog(a.round_id).map((x) => x.segment_open_index), [1]);
  assert.deepEqual(vault.openLog(b.round_id).map((x) => x.segment_open_index), [2]);
  assert.deepEqual(rounds.roundHead(a.round_id).holdout_opens, { segment: { ...H1 }, family_ids: ['MINE:CN_A:H5'], count: 1 });
  assert.deepEqual(rounds.roundHead(b.round_id).holdout_opens, { segment: { ...H1 }, family_ids: ['MINE:CN_A:H5'], count: 2 });
  const stubRecord = (r) => gateRecords.internals.withGate(() => ({ pass: false, codes: ['SYNTHETIC'], items: [] }),
    () => gateRecords.recordGateResult({ round_id: r.round_id, candidate_id: `${r.round_id}:A005`, candidate: {} }));
  stubRecord(a); stubRecord(b);
  assert.equal(rounds.closeRound(a.round_id).holdout_opens.count, 1, 'the counter stays on the closed row');
  rounds.closeRound(b.round_id);
  assert.throws(() => open(3, '2027-01-04T04:00:00Z'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED/), 'a third round may not reuse 10-19 → 12-31');
  assert.throws(() => open(3, '2027-01-04T04:00:00Z', { from: '2026-12-01', to: '2027-02-26' }), code(/MINE_ROUND_HOLDOUT_MOVED/), 'overlapping the old segment');
  assert.throws(() => open(3, '2027-01-04T04:00:00Z', { from: '2026-06-01', to: '2026-09-30' }), code(/MINE_ROUND_HOLDOUT_MOVED/), 'before the old segment');
  const H2 = { from: '2027-01-04', to: '2027-03-31' };
  const c = open(3, '2027-01-04T04:00:00Z', H2);
  assert.deepEqual(c.holdout, H2);
  assert.equal(open(4, '2027-01-05T04:00:00Z', H2).holdout.from, '2027-01-04');
});

test('R1.3：DSR 在前推验证折的月度收益上算，N = 本族累计尝试数；≥ 24 个月过 DSR 的输入核对，不足 24 个月是 UNKNOWN', () => {
  const series = (n, mu) => Array.from({ length: n }, (_, k) => mu + 0.02 * Math.sin(k * 1.7 + 0.3));
  const fam = [0.1, 0.25, -0.05, 0.3, 0.15, 0.2, 0.05];
  const ok = holdoutScoring.dsrFromValidation({ monthly_d: series(33, 0.01), N: 12, familySharpes: fam });
  assert.equal(ok.segment, 'VALIDATION_FOLDS');
  assert.equal(ok.t_months, 33);
  assert.ok(Number.isFinite(ok.dsr), String(ok.dsr));
  const short = holdoutScoring.dsrFromValidation({ monthly_d: series(20, 0.01), N: 12, familySharpes: fam });
  assert.deepEqual([short.dsr.value, short.dsr.reason], ['UNKNOWN', 'T_LT_24']);
  const item1 = (dsr) => gate.checkDsr({ overfit: { dsr, n_trials: 12 } }, { familyTrialCount: 12 }).codes;
  assert.ok(!item1(ok.dsr).includes('MINE_DSR_UNKNOWN'));
  assert.ok(item1(short.dsr).includes('MINE_DSR_UNKNOWN'));
  assert.ok(item1(ok.dsr).every((c) => c !== 'MINE_DSR_N_NOT_CUMULATIVE'));
});

test('R1.7：涨跌停按 V6 实盘的板块规则（price_limit_history_v1：主板 10%，主板 ST 5% 到 2026-07-06、之后 10%；创业板、科创板 20%）；价格四舍五入到分；涨停开盘买不进、跌停开盘卖不出', () => {
  assert.equal(limits.bandOf({ board: 'MAIN', st: false, date: '2026-10-20' }).pct, 0.10);
  assert.equal(limits.bandOf({ board: 'MAIN', st: true, date: '2026-07-03' }).pct, 0.05);
  assert.equal(limits.bandOf({ board: 'MAIN', st: true, date: '2026-07-06' }).pct, 0.10);
  assert.deepEqual([limits.bandOf({ board: 'CHINEXT', st: false, date: '2026-10-20' }).pct, limits.bandOf({ board: 'CHINEXT', st: false, date: '2026-10-20' }).source], [0.20, 'V6']);
  assert.deepEqual([limits.bandOf({ board: 'CHINEXT', st: true, date: '2025-03-03' }).pct, limits.bandOf({ board: 'CHINEXT', st: true, date: '2025-03-03' }).source], [0.20, 'RESEARCH_EXTENSION']);
  assert.equal(limits.bandOf({ board: 'CHINEXT', st: false, date: '2020-07-01' }).pct, 0.10);
  assert.equal(limits.bandOf({ board: 'STAR', st: false, date: '2024-05-06' }).pct, 0.20);
  assert.throws(() => limits.bandOf({ board: 'BSE', st: false, date: '2026-10-20' }), code(/MINE_LIMIT_BOARD_UNSUPPORTED/));
  assert.equal(limits.boardOf('300750.SZ', 'MAIN'), 'CHINEXT', 'V6 classifies by the code prefix');
  assert.equal(limits.boardOf('688981.SH', 'MAIN'), 'STAR');
  assert.equal(limits.boardOf('600000.SH', 'STAR'), 'MAIN');
  assert.equal(limits.boardOf('S03.SH', 'STAR'), 'STAR', 'non-numeric synthetic codes fall back to the master board');
  assert.deepEqual(limits.limitPrices(10.005, 0.10), { up: 11.01, down: 9 });
  assert.equal(limits.canBuy({ open: 11.0, prevClose: 10, pct: 0.10 }), false, 'open at the limit-up price');
  assert.equal(limits.canBuy({ open: 10.99, prevClose: 10, pct: 0.10 }), true);
  assert.equal(limits.canSell({ open: 9.0, prevClose: 10, pct: 0.10 }), false, 'open at the limit-down price');
  assert.equal(limits.canSell({ open: 9.01, prevClose: 10, pct: 0.10 }), true);
  assert.equal(limits.canBuy({ open: NaN, prevClose: 10, pct: 0.10 }), false, 'no open = suspended = not tradable');

  // 手算：X9 在 t=0 涨停开盘买不进，t=2 才买进；t=4 换仓时 X8 跌停开盘卖不出、留到 t=6
  const dates = []; for (let d = '2026-12-14'; d <= '2026-12-31'; d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)) if (![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) dates.push(d);
  const T = dates.length; const N = 10; const codes = Array.from({ length: N }, (_, j) => `X${j}`);
  const grow = (j) => 1 + 0.001 * (j + 1);
  const ex = dates.map((_, t) => codes.map((_, j) => 10 * grow(j) ** t));
  const openRaw = dates.map((_, t) => codes.map((_, j) => (t === 0 && j === 9 ? 11.0 : t === 4 && j === 8 ? 9.0 : 10.0)));
  const panel = { segment: 'HOLDOUT', dates, codes, readings: { pb: dates.map((_, t) => codes.map((_, j) => (t < 4 ? j : -j))) }, industry: dates.map(() => codes.map(() => '801010')),
    size: dates.map(() => codes.map(() => 1e9)), universe: dates.map(() => codes.map(() => true)), board: codes.map(() => 'MAIN'), st: dates.map(() => codes.map(() => false)),
    labels: { exec_open: ex, open_raw: openRaw, prev_close_raw: dates.map(() => codes.map(() => 10)) } };
  const parsed = require('../services/mining-sandbox/dsl').parse('pb', require('../services/mining-sandbox/space').dslSpaceOf(JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json'), 'utf8'))));
  const H = 2; const s = holdoutScoring.scoreCandidate(parsed, panel, { holding_period: H });
  const fwd = (j) => grow(j) ** H - 1; const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
  const c = holdoutScoring.NET.cost; const one = (c.commission_bps + c.slippage_bps) / 1e4; const sell = one + c.stamp_duty_bps / 1e4;
  const net = [mean([fwd(8)]) - one, mean([fwd(8), fwd(9)]) - 0.5 * one, mean([fwd(8), fwd(0), fwd(1)]) - (2 / 3) * one - 0.5 * sell, mean([fwd(0), fwd(1)]) - (1 / 3) * sell,
    mean([fwd(0), fwd(1)]), mean([fwd(0), fwd(1)])];
  const bench = net.map(() => mean(codes.map((_, j) => fwd(j))));
  const prod = (xs) => xs.reduce((a, x) => a * (1 + x), 1);
  const want = (prod(net) / prod(bench)) ** (242 / (net.length * H)) - 1;
  assert.equal(s.net_of_cost.periods, 6);
  assert.ok(Math.abs(s.net_of_cost.annualized_excess - want) < 1e-12, `${s.net_of_cost.annualized_excess} vs ${want}`);
  assert.deepEqual(s.net_of_cost.limit_events, { entry_blocked_limit_up: 1, exit_carried_limit_down: 1, entry_blocked_no_open: 0, exit_carried_no_open: 0 });
  assert.equal(s.net_of_cost.limit_moves, 'MODELLED_V6_BOARD_BANDS');
  const { open_raw: _o, ...noLimits } = panel.labels;
  assert.throws(() => holdoutScoring.scoreCandidate(parsed, { ...panel, labels: noLimits }, { holding_period: H }), code(/MINE_HOLDOUT_SCORE_LIMIT_INPUT_MISSING/));
  // 适配器给出的面板带这几项
  const hp = adapter.buildPanel({ sources: [...sources(), adapter.csvDirSource(fx.dirs.holdout, { mode: 'LIVE', label: 'holdout', holdout: true })], space: JSON.parse(fs.readFileSync(path.join(ROOT,
    'docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json'), 'utf8')), segment: 'HOLDOUT', from: '2026-09-01', to: '2026-12-31' });
  const j = hp.codes.indexOf('S01.SH'); const i = hp.dates.indexOf('2026-10-20');
  const raw = []; adapter.internals.forEachCsvRow(path.join(fx.dirs.holdout, 'prices_daily_stock.csv'), (r) => { if (r.security_id === 'S01.SH' && r.trade_date === '2026-10-20') raw.push(r); });
  assert.deepEqual([hp.labels.open_raw[i][j], hp.labels.prev_close_raw[i][j]], [Number(raw[0].open), Number(raw[0].previous_close)]);
  assert.equal(hp.board[hp.codes.indexOf('S03.SH')], 'STAR');
  assert.equal(hp.st[i][j], false);
});

/**
 * 合成的现有因子序列导出（FACTOR_SERIES_V1）：比较集里的 11 个（个股级 1、3、4、5、13，单元级 6、8–12；6 与 12 同值，同 V6）全给，
 * 再给一个 ETF 级（第 14 个，R1.9 排除）与一个只存前几名的（第 7 个，排除）；第 3 个有一行入库迟到。
 */
function makeFactorSeries() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-factor-series-'));
  const days = fx.calendar.filter((d) => d >= '2026-09-01' && d <= '2026-12-31');
  const codes = ['S01.SH', 'S02.SH', 'S03.SH', 'S04.SZ', 'S05.SZ', 'S06.SZ', 'S07.SH', 'S08.SZ', 'S09.SH', 'S10.SZ', 'S11.SH', 'S12.SZ', 'T01.SH', 'P01.SZ', 'N01.SZ'];
  const units = ['SW2021:801010', 'SW2021:801030', 'SW2021:801050', 'SW2021:801080'];
  const rows = []; const members = [];
  const noise = (k, d, c) => (parseInt(sha(`${k}|${d}|${c}`).slice(0, 8), 16) / 0xffffffff) - 0.5;
  const STOCK = ['CN_A.MOM.RS60_MARKET_PCT', 'CN_A.QUALITY.STRUCTURAL_SCORE', 'CN_A.GROWTH.NETPROFIT_YOY_PCT', 'CN_A.VALUE.VALUATION_GATE_INV', 'CN_A.SENT.ANALYST_REVISION_BREADTH'];
  const UNIT = ['CN_A_IND.MOM.INDUSTRY_RS60_PCT', 'CN_A_IND.MOM.TREND_BREADTH', 'CN_A_IND.VP.VOLUME_EXPANSION_PCT', 'CN_A_IND.MOM.LEADER_RS20_Q90', 'CN_A_IND.COMPOSITE.MAINLINE_SCORE_V7'];
  for (const d of days) {
    const at = `${d} 18:40:00+08`;
    codes.forEach((c, n) => {
      STOCK.forEach((fid, k) => rows.push({ factor_id: fid, grain: 'STOCK', business_date: d, key: c, value: ((k === 0 ? n * 7 : 0) + noise(k, d, c) * 10).toFixed(4),
        first_available_at: fid === 'CN_A.QUALITY.STRUCTURAL_SCORE' && d === '2026-10-20' && c === 'S01.SH' ? '2026-10-22 08:00:00+08' : at }));
      members.push({ business_date: d, security_id: c, unit_key: units[n % units.length] });
    });
    for (const u of units) {
      UNIT.forEach((fid, k) => rows.push({ factor_id: fid, grain: 'UNIT', business_date: d, key: u, value: (50 + noise(10 + k, d, u) * 40).toFixed(4), first_available_at: at }));
      rows.push({ factor_id: 'CN_A.MAINLINE.UNIT_SCORE', grain: 'UNIT', business_date: d, key: u, value: (50 + noise(14, d, u) * 40).toFixed(4), first_available_at: at }); // = 第 12 个
    }
    rows.push({ factor_id: 'CN_A_ETF.MOM.SECTOR_ETF_REALIZED_MOM20', grain: 'ETF', business_date: d, key: '512480.SH', value: noise(20, d, 'e').toFixed(4), first_available_at: at });
    rows.push({ factor_id: 'CN_A.COMPOSITE.STOCK_BOOK_V4', grain: 'STOCK', business_date: d, key: 'S01.SH', value: '80', first_available_at: at });
  }
  fs.writeFileSync(path.join(dir, 'factor_series.csv'), fxi.csv(['factor_id', 'grain', 'business_date', 'key', 'value', 'first_available_at'], rows));
  fs.writeFileSync(path.join(dir, 'unit_membership.csv'), fxi.csv(['business_date', 'security_id', 'unit_key'], members));
  const files = ['factor_series.csv', 'unit_membership.csv'];
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${files.map((n) => `${sha(fs.readFileSync(path.join(dir, n)))}  ${n}`).join('\n')}\n`);
  return dir;
}

test('R1.4：现有因子序列（FACTOR_SERIES_V1）按 business_date 收盘记、次一交易日开盘起用（迟到的行不用）；单元级按成员映射到个股；ETF 级对不上个股；最小二乘截距 t 手算一致', () => {
  const dir = makeFactorSeries();
  const fs1 = factorSeries.loadFactorSeries(dir);
  assert.equal(fs1.factor_ids.length, 13);
  const hp = adapter.buildPanel({ sources: [...sources(), adapter.csvDirSource(fx.dirs.holdout, { mode: 'LIVE', label: 'holdout', holdout: true })], space: JSON.parse(fs.readFileSync(path.join(ROOT,
    'docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json'), 'utf8')), segment: 'HOLDOUT', from: '2026-09-01', to: '2026-12-31' });
  const p = factorSeries.stockPanel(fs1, 'CN_A.QUALITY.STRUCTURAL_SCORE', hp);
  const row = (d) => p.find((x) => x.date === d);
  assert.equal(row('2026-10-21').values['S01.SH'], undefined, 'the 10-20 row arrived after 10-21 09:00, so the 10-21 open cannot use it');
  assert.ok(Number.isFinite(row('2026-10-21').values['S02.SH']));
  assert.ok(Number.isFinite(row('2026-10-20').values['S01.SH']), 'the 10-19 row feeds the 10-20 open');
  const u = factorSeries.stockPanel(fs1, 'CN_A_IND.COMPOSITE.MAINLINE_SCORE_V7', hp);
  assert.equal(u.find((x) => x.date === '2026-10-21').values['S01.SH'], u.find((x) => x.date === '2026-10-21').values['S05.SZ'], 'members of one unit share its value');
  assert.throws(() => factorSeries.stockPanel(fs1, 'CN_A_ETF.MOM.SECTOR_ETF_REALIZED_MOM20', hp), code(/MINE_FACTOR_SERIES_GRAIN_NOT_STOCK_MAPPABLE/));
  assert.equal(factorSeries.stockPanel(fs1, 'CN_A_IND.NOT.IN_THE_EXPORT', hp), null, 'absent factor');
  // 截距 t：y = 0.5 + 2x + e，一个解释变量时与闭式一致
  const x = Array.from({ length: 40 }, (_, k) => Math.sin(k)); const y = x.map((v, k) => 0.5 + 2 * v + 0.1 * Math.cos(3 * k));
  const t = holdoutScoring.internals.olsInterceptT(y, x.map((v) => [v]));
  const n = x.length; const mx = x.reduce((a, b) => a + b, 0) / n; const my = y.reduce((a, b) => a + b, 0) / n;
  const sxx = x.reduce((a, v) => a + (v - mx) ** 2, 0); const beta = x.reduce((a, v, k) => a + (v - mx) * (y[k] - my), 0) / sxx; const alpha = my - beta * mx;
  const s2 = y.reduce((a, v, k) => a + (v - alpha - beta * x[k]) ** 2, 0) / (n - 2); const se = Math.sqrt(s2 * (1 / n + (mx * mx) / sxx));
  assert.ok(Math.abs(t.intercept - alpha) < 1e-10 && Math.abs(t.t - alpha / se) < 1e-8, JSON.stringify(t));
});

test('R1.5 机制登记 + R1.3 / R1.4 / R1.6 进 G-MINE 记录：留出段开启之前写、只追加、过 G-MECH；没登记的照样打分、第 9 项不过并写原因；命令行 mechanisms 列出幸存者并登记', () => {
  const out = freshData();
  const { r, sel } = toSelection(out);
  const id = r.round_id; const [first, second, ...rest] = sel.selected;
  assert.ok(first && second, `need two survivors (${sel.selected.length})`);
  // 命令行：列出幸存者与登记状态
  const env = { QRP_DATA_DIR: out, QRP_PRODUCT_MILESTONE_AUTHORITY: AUTH };
  const list = cli(['mechanisms', '--out', out, '--round', id], env);
  assert.equal(list.status, 0, list.stderr);
  const listed = JSON.parse(list.stdout);
  assert.deepEqual(listed.survivors.map((x) => x.candidate_id), sel.selected);
  assert.ok(listed.survivors.every((x) => x.registered === false && x.formula === roundTrials(id).find((t) => t.mining.candidate_id === x.candidate_id).rule_config.formula));
  const M = { mechanism_id: 'SEL.MEANREV.SWING_BAND', economic_logic_zh: '前一日的过度反应在随后几日部分回吐（合成测试文本）', failure_mode_zh: '趋势行情里反转失效（合成测试文本）', written_at: '2026-11-17T09:00:00+08:00' };
  const reg = mechanisms.registerMechanism(id, { candidate_id: first, ...M }, { writtenBy: AUTH });
  assert.equal(reg.schema, 'MINING_MECHANISM_V1');
  assert.equal(reg.gmech.route === 'NOT_DO_SETTLED', false);
  assert.ok(/^[0-9a-f]{64}$/.test(reg.gmech.register_sha256));
  assert.deepEqual(reg.same_mechanism_in_round, []);
  assert.throws(() => mechanisms.registerMechanism(id, { candidate_id: first, ...M }, { writtenBy: AUTH }), code(/MINE_MECHANISM_DUPLICATE/));
  const notSurvivor = sel.candidates.find((c) => !c.selected);
  if (notSurvivor) assert.throws(() => mechanisms.registerMechanism(id, { candidate_id: notSurvivor.candidate_id, ...M }, { writtenBy: AUTH }), code(/MINE_MECHANISM_CANDIDATE_NOT_SELECTED/));
  assert.throws(() => mechanisms.registerMechanism(id, { candidate_id: second, ...M, mechanism_id: 'SEL.NOT.REGISTERED' }, { writtenBy: AUTH }), code(/MINE_MECHANISM_ID_NOT_REGISTERED/));
  assert.throws(() => mechanisms.registerMechanism(id, { candidate_id: second, ...M, failure_mode_zh: '' }, { writtenBy: AUTH }), code(/MINE_MECHANISM_FIELDS/));
  assert.throws(() => mechanisms.registerMechanism(id, { candidate_id: second, ...M, written_at: '2026-11-21 14:00' }, { writtenBy: AUTH }), code(/MINE_MECHANISM_WRITTEN_AT/));
  assert.throws(() => mechanisms.registerMechanism(id, { candidate_id: second, ...M, written_at: '2099-01-01T00:00:00+08:00' }, { writtenBy: AUTH }), code(/MINE_MECHANISM_WRITTEN_AT/));
  assert.throws(() => mechanisms.internals.withRoute('NOT_DO_SETTLED', () => mechanisms.registerMechanism(id, { candidate_id: second, ...M }, { writtenBy: AUTH })), code(/MINE_MECHANISM_NOT_DO_SETTLED/));
  // 命令行登记第二个（同一机制 → 去重披露）
  const file = path.join(out, 'mechanisms-input.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ candidate_id: second, ...M, written_at: '2026-11-17T09:05:00+08:00' })}\n`);
  const regCli = cli(['mechanisms', '--out', out, '--round', id, '--register', file], env);
  assert.equal(regCli.status, 0, regCli.stderr);
  assert.deepEqual(mechanisms.mechanismOf(id, second).same_mechanism_in_round, [first]);
  // 打分：带现有因子序列
  const fsDir = makeFactorSeries();
  const s = runner.scoreHoldout({ roundId: id, sources: sources(), holdoutDir: fx.dirs.holdout, outDir: out, factorSeriesDir: fsDir, scoredAt: '2027-01-06T10:00:00+08:00', holdoutFloor: COV });
  assert.equal(s.opened, true);
  assert.throws(() => mechanisms.registerMechanism(id, { candidate_id: rest[0] || first, ...M }, { writtenBy: AUTH }), code(/MINE_MECHANISM_AFTER_HOLDOUT_OPEN|MINE_MECHANISM_DUPLICATE/));
  const score = JSON.parse(fs.readFileSync(path.join(runDirOf(out, id), 'score.json'), 'utf8'));
  const res = new Map(score.results.map((x) => [x.candidate_id, x]));
  assert.equal(res.get(first).mechanism.mechanism_id, M.mechanism_id);
  assert.equal(res.get(first).mechanism.written_at, M.written_at);
  assert.equal(res.get(first).mechanism.registration_hash, mechanisms.mechanismOf(id, first).record_hash);
  for (const other of rest) {
    assert.equal(res.get(other).mechanism, null);
    assert.equal(res.get(other).mechanism_reason, 'NO_MECHANISM_REGISTERED_BEFORE_OPEN');
  }
  const recs = new Map(gateRecords.recordsOf(id).map((x) => [x.candidate_id, x]));
  assert.ok(!recs.get(first).codes.includes('MINE_MECHANISM_UNKNOWN'));
  assert.ok(!recs.get(first).codes.includes('MINE_MECHANISM_AFTER_HOLDOUT'), 'registered before the open (R1.5 rev 4)');
  assert.equal(res.get(first).mechanism.registered_at, mechanisms.mechanismOf(id, first).registered_at);
  assert.equal(res.get(first).holdout.opened_at, vault.openLog(id)[0].opened_at, 'item 9 compares with the open, not the scoring time');
  for (const other of rest) assert.ok(recs.get(other).codes.includes('MINE_MECHANISM_UNKNOWN'));
  // R1.3：DSR 在验证折上（≥ 24 个月），不再是 UNKNOWN
  for (const x of score.results) {
    assert.equal(x.overfit.dsr_segment, 'VALIDATION_FOLDS');
    assert.ok(x.overfit.dsr_t_months >= 24, String(x.overfit.dsr_t_months));
    assert.equal(x.overfit.n_trials, KNOWN.length);
  }
  for (const x of recs.values()) assert.ok(!x.codes.includes('MINE_DSR_UNKNOWN') && !x.codes.includes('MINE_DSR_N_NOT_CUMULATIVE'), x.codes.join(','));
  const selFile = JSON.parse(fs.readFileSync(path.join(runDirOf(out, id), 'selection.json'), 'utf8'));
  assert.ok(selFile.candidates.every((c) => c.validation_book.months >= 24 && c.validation_book.monthly_d.length === c.validation_book.months));
  const famSr = selFile.candidates.map((c) => c.validation_book.sr).filter((x) => typeof x === 'number');
  for (const x of score.results) {
    const want = holdoutScoring.dsrFromValidation({ monthly_d: selFile.candidates.find((c) => c.candidate_id === x.candidate_id).validation_book.monthly_d, N: rounds.familyN('CN_A', 5), familySharpes: famSr });
    assert.deepEqual(x.overfit.dsr, want.dsr, 'DSR = validation monthly series, N = family count, family SRs = every evaluated candidate');
  }
  // R1.4 + R1.9：比较集 = 覆盖全部股票截面的 LIVE_IN_RULE 因子（11 个）；ETF 级与只存前十名的不进，原因写进结果与每条 G-MINE 记录
  const set = factorLib.comparisonFactorIds(factorLib.LIBRARY, 'CN_A');
  const EXCLUDED = ['CN_A.COMPOSITE.STOCK_BOOK_V4', 'CN_A.MOM.RS20_UNIT_PCT', 'CN_A_ETF.MOM.SECTOR_ETF_REALIZED_MOM20'];
  const pairs = new Map(res.get(first).correlation.pairs.map((q) => [q.factor_id, q]));
  assert.deepEqual([...pairs.keys()].sort(), set);
  for (const id of EXCLUDED) assert.ok(!pairs.has(id), `${id} does not enter item 8`);
  for (const [fid, q] of pairs) {
    assert.ok(Number.isFinite(q.rho_cross_section.value), `${fid} cross-section`);
    assert.ok(Number.isFinite(q.rho_returns.value), `${fid} returns`);
  }
  assert.deepEqual(res.get(first).marginal.book_factor_ids, set, 'item 7 regresses on the same set');
  assert.ok(Number.isFinite(res.get(first).marginal.intercept_t), 'item 7 is computed once every compared factor has a series');
  assert.deepEqual(res.get(first).marginal.collinear_dropped, ['CN_A_IND.COMPOSITE.MAINLINE_SCORE_V7'], 'factor 12 duplicates factor 6 (same unit score) and is dropped from the OLS, disclosed');
  for (const x of recs.values()) {
    assert.deepEqual(x.excluded_factors.map((e) => e.factor_id).sort(), EXCLUDED, 'every record names the excluded factors');
    assert.ok(x.excluded_factors.every((e) => e.ruling === 'R1.9' && /ETF|TOP_TEN/.test(e.reason)));
    for (const c of ['MINE_CORRELATION_UNKNOWN', 'MINE_CORRELATION_LIBRARY_INCOMPLETE', 'MINE_MARGINAL_INPUT', 'MINE_MARGINAL_BOOK_MISMATCH']) assert.ok(!x.codes.includes(c), `${x.candidate_id}:${c}`);
  }
  assert.deepEqual(res.get(first).correlation.excluded_factors.map((e) => e.factor_id).sort(), EXCLUDED);
  // R1.6：留出段开启次数写进结果
  assert.equal(res.get(first).holdout.segment_open_index, 1);
  assert.equal(rounds.roundHead(id).holdout_opens.count, 1);
  // R1.7：第 6 项按板块规则建模了涨跌停
  assert.equal(res.get(first).net_of_cost.limit_moves, 'MODELLED_V6_BOARD_BANDS');
  process.env.QRP_DATA_DIR = dataRoot;
});

test('命令行与容器：mechanisms 一步（不挂数据、不挂留出段、不出网）；score 可以挂现有因子序列（只读）；R1.1 写进合同', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'deploy/research-lane/round-runner/run.sh'), 'utf8');
  const runs = sh.split('\n').filter((l) => /^\s*docker run /.test(l));
  const mech = runs.filter((l) => / mechanisms /.test(l));
  assert.equal(mech.length, 1);
  for (const flag of ['--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 1000:1000']) assert.ok(mech[0].includes(flag), flag);
  assert.ok(!mech[0].includes('$HOLDOUT:') && !mech[0].includes('/data/lane') && !mech[0].includes('/data/tail'));
  assert.ok(mech[0].includes(':/data/mechanisms.jsonl:ro'));
  const score = runs.filter((l) => / score /.test(l));
  assert.ok(score.every((l) => l.includes('$FACTOR_SERIES:/data/factor-series:ro') && l.includes('--factor-series /data/factor-series')));
  assert.ok(require('../services/mining-sandbox/round-runner/cli').OPTIONS.mechanisms.includes('register'));
  const contract = fs.readFileSync(path.join(ROOT, 'docs/contracts/MINING_SANDBOX_V1.md'), 'utf8') + fs.readFileSync(path.join(ROOT, 'docs/contracts/MINING_ROUNDS_V1.md'), 'utf8');
  for (const k of ['R1.1', 'R1.2', 'R1.3', 'R1.4', 'R1.5', 'R1.6', 'R1.7', 'R1.8', 'R1.9', 'R1.10', 'R1.11', 'R1.12', 'FAILED_PARTIAL', '705e2e6a']) assert.ok(contract.includes(k), k);
  const rescoreLine = runs.filter((l) => / rescore /.test(l));
  assert.equal(rescoreLine.length, 1, 'run.sh rescore (R1.8)');
  assert.ok(rescoreLine[0].includes('-v "$HOLDOUT:/data/holdout:ro"') && rescoreLine[0].includes(':/data/crash.log:ro') && rescoreLine[0].includes('--network none'));
  assert.ok(fs.readFileSync(path.join(ROOT, 'services/mining-sandbox/round-runner/selector.js'), 'utf8').includes('FROZEN by R1.2'));
});

/** R1.8 的一轮：选到选择记录为止（同一个 openedAt → 同一个轮次编号，干净的一轮与崩溃重打分的一轮可以逐条比）。 */
function rescoreRound() {
  const out = freshData();
  const { r, sel } = toSelection(out, { openedAt: '2026-11-23T02:00:00Z' });
  const args = { roundId: r.round_id, sources: sources(), holdoutDir: fx.dirs.holdout, outDir: out, scoredAt: '2027-01-06T10:00:00+08:00', holdoutFloor: COV };
  return { out, r, sel, args };
}
const recordsKey = (id) => gateRecords.recordsOf(id).map((x) => [x.candidate_id, x.pass, x.codes.join(','), x.gate_result_sha256]); // 试验台账行的 hash 带登记时刻，两轮本来就不同

test('R1.8：留出段开启之后崩溃，恰好一次同选集重打分；记成留出段保管的第二个事件；再崩以 FAILED_RESCORE 关轮；第三次拒绝', () => {
  // 干净的一轮（对照）
  const clean = rescoreRound();
  runner.scoreHoldout(clean.args);
  const want = recordsKey(clean.r.round_id);
  const cleanClose = runner.close({ roundId: clean.r.round_id });
  assert.ok(want.length >= 2);
  // 崩在开启之后、任何记录之前 → 正常 score 被拒（不开第二次）→ 重打分一次：记录与干净的一轮逐条相同
  const a = rescoreRound();
  assert.throws(() => runner.internals.withFault('AFTER_OPEN', () => runner.scoreHoldout(a.args)), code(/MINE_RUNNER_TEST_FAULT/));
  assert.deepEqual([vault.openLog(a.r.round_id).length, gateRecords.recordsOf(a.r.round_id).length, rounds.roundHead(a.r.round_id).status], [1, 0, 'SCORING']);
  assert.throws(() => runner.scoreHoldout(a.args), code(/MINE_HOLDOUT_ALREADY_OPENED/));
  const res = runner.rescore({ ...a.args, reason: 'container OOM after open (synthetic)', log: 'synthetic crash log\nline 2' });
  assert.equal(res.rescored, true);
  assert.deepEqual(recordsKey(a.r.round_id), want, 'same inputs, same records as the clean run');
  const [ev] = vault.rescoreLog(a.r.round_id);
  assert.equal(ev.schema, 'HOLDOUT_RESCORE_V1');
  assert.equal(ev.kind, 'RESCORE_SAME_SELECTION');
  assert.equal(ev.reason, 'container OOM after open (synthetic)');
  assert.equal(ev.log_sha256, sha('synthetic crash log\nline 2'));
  assert.equal(ev.open_hash, vault.openLog(a.r.round_id)[0].record_hash);
  assert.equal(ev.selection_record_hash, rounds.selectionOf(a.r.round_id).record_hash);
  assert.equal(ev.inputs_sha256, vault.openLog(a.r.round_id)[0].inputs_sha256);
  const closed = runner.close({ roundId: a.r.round_id });
  assert.deepEqual([closed.status, closed.gmine_passes], ['CLOSED', cleanClose.gmine_passes]);
  assert.throws(() => runner.rescore({ ...a.args, reason: 'again', log: 'x' }), code(/MINE_RUNNER_ROUND_NOT_SCORING|MINE_HOLDOUT_RESCORE_ONCE/));

  // 第一次已经写了 G-MINE 记录 → 不许重打分
  const b = rescoreRound();
  assert.throws(() => runner.internals.withFault('AFTER_FIRST_RECORD', () => runner.scoreHoldout(b.args)), code(/MINE_RUNNER_TEST_FAULT/));
  assert.equal(gateRecords.recordsOf(b.r.round_id).length, 1);
  assert.throws(() => runner.rescore({ ...b.args, reason: 'crash', log: 'x' }), code(/MINE_RUNNER_RESCORE_RECORDS_EXIST/));
  assert.equal(vault.rescoreLog(b.r.round_id).length, 0);
  assert.equal(rounds.roundHead(b.r.round_id).status, 'FAILED_PARTIAL', 'R1.12 (rev 4): any record written means FAILED_PARTIAL, never a rescore');
  assert.throws(() => vault.recordRescore({ round_id: b.r.round_id, reason: 'r', log: '', inputs_sha256: vault.openLog(b.r.round_id)[0].inputs_sha256, rescoredBy: 'TEST' }),
    code(/MINE_HOLDOUT_RESCORE_NOT_SCORING/), 'the vault refuses too');

  // 选择记录变了、或封存的清单变了 → 拒绝
  const c = rescoreRound();
  assert.throws(() => runner.internals.withFault('AFTER_OPEN', () => runner.scoreHoldout(c.args)), code(/MINE_RUNNER_TEST_FAULT/));
  const selLedger = path.join(c.out, 'research', 'mining_selections.jsonl');
  const original = fs.readFileSync(selLedger, 'utf8');
  const row = JSON.parse(original.trim()); row.selected = row.selected.slice(0, 1);
  fs.writeFileSync(selLedger, `${JSON.stringify(row)}\n`);
  assert.throws(() => runner.rescore({ ...c.args, reason: 'crash', log: 'x' }), code(/MINE_HOLDOUT_RESCORE_SELECTION_CHANGED/));
  fs.writeFileSync(selLedger, original);
  const changed = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r18-sums-'));
  for (const n of fs.readdirSync(fx.dirs.holdout)) fs.copyFileSync(path.join(fx.dirs.holdout, n), path.join(changed, n));
  fs.writeFileSync(path.join(changed, 'SHA256SUMS.sealed'), fs.readFileSync(path.join(changed, 'SHA256SUMS'), 'utf8').replace(/^[0-9a-f]{8}/, '00000000'));
  assert.throws(() => runner.rescore({ ...c.args, holdoutDir: changed, reason: 'crash', log: 'x' }), code(/MINE_RUNNER_HOLDOUT_SHA_MISMATCH|MINE_HOLDOUT_RESCORE_INPUTS_CHANGED|SEALED/));
  assert.equal(vault.rescoreLog(c.r.round_id).length, 0, 'a refused rescore writes no event');

  // 重打分时又崩 → 下一次以 FAILED_RESCORE 关轮（不写记录，尝试照旧计入 N）；第三次拒绝
  const d = rescoreRound();
  const nBefore = rounds.familyN('CN_A', 5);
  assert.throws(() => runner.internals.withFault('AFTER_OPEN', () => runner.scoreHoldout(d.args)), code(/MINE_RUNNER_TEST_FAULT/));
  assert.throws(() => runner.internals.withFault('AFTER_RESCORE_EVENT', () => runner.rescore({ ...d.args, reason: 'crash 1', log: 'x' })), code(/MINE_RUNNER_TEST_FAULT/));
  assert.equal(vault.rescoreLog(d.r.round_id).length, 1);
  assert.throws(() => vault.recordRescore({ round_id: d.r.round_id, reason: 'again', log: '', inputs_sha256: vault.openLog(d.r.round_id)[0].inputs_sha256, rescoredBy: 'TEST' }),
    code(/MINE_HOLDOUT_RESCORE_ONCE/), 'the vault itself allows one rescore event');
  assert.throws(() => runner.rescore({ ...d.args, reason: 'crash 2', log: 'y' }), code(/MINE_RUNNER_RESCORE_FAILED/));
  const failed = rounds.roundHead(d.r.round_id);
  assert.deepEqual([failed.status, failed.gmine_passes, gateRecords.recordsOf(d.r.round_id).length], ['FAILED_RESCORE', 0, 0]);
  assert.equal(failed.gmine_basis.failed_rescore.reason, 'crash 2');
  assert.deepEqual([failed.gmine_basis.records, failed.gmine_basis.record_hashes], [0, []], 'no G-MINE record counts for a failed rescore');
  assert.equal(rounds.familyN('CN_A', 5), nBefore, 'its attempts stay in N');
  assert.throws(() => runner.rescore({ ...d.args, reason: 'crash 3', log: 'z' }), code(/MINE_RUNNER_ROUND_FAILED_RESCORE/));
  assert.throws(() => runner.scoreHoldout(d.args), code(/MINE_RUNNER_ROUND_FAILED_RESCORE/));
  assert.throws(() => runner.close({ roundId: d.r.round_id }), code(/MINE_ROUND_NOT_OPEN/));
  process.env.QRP_DATA_DIR = dataRoot;
});

test('续跑（--resume）用的覆盖下限也写进台账（轮次行的 data_checks.resumes）', () => {
  const out = freshData();
  const r = runner.requestRound({ generator: GP, cap: KNOWN.length, openedAt: '2026-11-24T02:00:00Z' });
  runner.sealHoldout({ roundId: r.round_id, dataRef: 'synthetic:holdout', dataSha256: HOLDOUT_SUMS_SHA });
  const res = cli(['generate', '--out', out, '--lane', fx.dirs.lane, '--tail', fx.dirs.tail, '--resume', r.round_id, '--min-names-per-day', '5'],
    { QRP_DATA_DIR: out, QRP_PRODUCT_MILESTONE_AUTHORITY: AUTH });
  assert.equal(res.status, 0, res.stderr);
  const head = rounds.roundHead(r.round_id);
  assert.equal(head.data_checks.resumes.length, 1);
  assert.deepEqual(head.data_checks.resumes[0].min_names_per_day, { value: 5, default: 2000, overridden: true });
  assert.ok(/T.*Z$/.test(head.data_checks.resumes[0].at));
  assert.deepEqual(head.data_checks.coverage_floor, { min_names_per_day: 2000, default: 2000, overridden: false }, 'the open-time record is kept');
  process.env.QRP_DATA_DIR = dataRoot;
});

// ---------- 裁定 R1 修订 4（705e2e6a…，#115 审阅之后）：R1.5、R1.6 的本意写明，R1.12 新增 ----------
const spaceOf = (tag, n) => ({ space_ref: `MS-${tag}-${n}`, sha256: sha(`${tag}-space-${n}`), freeze: { path: `f-${tag}-${n}`, sha256: sha(`${tag}-freeze-${n}`) } });
const openOn = (tag) => (n, at, holdout = H1) => rounds.openRound({ market: 'CN_A', space: spaceOf(tag, n), holding_periods: [5], generator: GP, holdout, openedAt: at, ...R1 });
const H2 = Object.freeze({ from: '2027-01-04', to: '2027-03-31' });
const H3 = Object.freeze({ from: '2027-04-01', to: '2027-06-30' });
const oneCandidate = (r, k = 5) => rounds.recordCandidate(r.round_id, { candidate_id: `${r.round_id}:A00${k}`, formula_canonical: `rank(ts_mean(pb,${k}))`,
  formula_sha256: sha(`rank(ts_mean(pb,${k}))`), holding_period: 5, mining_score: 0.01 }, { registeredBy: AUTH });
const beijing = (ms) => new Date(ms + 8 * 3600e3).toISOString().replace(/\.\d+Z$/, '+08:00');

test('R1.6（修订 4）：同一段留出段只在第一次开启之前可以由 2 个只生成的轮次共用；任何一轮开启过，这个市场这一段不再开新轮；没开启就关的轮不算开启', () => {
  freshData();
  const open = openOn('r16b');
  const a = open(1, '2026-11-17T04:00:00Z');
  oneCandidate(a);
  vault.seal({ round_id: a.round_id, segment: H1, data_ref: 'synthetic', data_sha256: sha('h'), sealedBy: 'TEST' });
  vault.open({ round_id: a.round_id, candidate_ids: [`${a.round_id}:A005`], openedBy: 'TEST' });
  assert.equal(rounds.roundHead(a.round_id).status, 'SCORING');
  // 复审的情形：A 在 SCORING，B 开在同一段上
  assert.throws(() => open(2, '2026-11-18T04:00:00Z'), code(/MINE_ROUND_HOLDOUT_SEGMENT_OPENED:CN_A:2026-10-19\.\.2026-12-31/));
  assert.equal(rounds.roundsOf('CN_A').length, 1, 'nothing written');
  // 早于 R1.6 的轮次行没有 holdout_opens：留出段保管的开启记录照样算开启
  const ledger = require('../packages/ledger');
  const { record_hash: _old, ...legacy } = { ...rounds.roundHead(a.round_id), holdout_opens: null };
  ledger.append(rounds.LEDGER(), { ...legacy, record_hash: trials.recordHash(legacy) });
  assert.equal(rounds.roundHead(a.round_id).holdout_opens, null);
  assert.throws(() => open(2, '2026-11-18T04:00:00Z'), code(/MINE_ROUND_HOLDOUT_SEGMENT_OPENED/), 'the vault open row counts without holdout_opens');
  // 开过的段在关轮之后照样不能再用
  gateRecords.internals.withGate(() => ({ pass: false, codes: ['SYNTHETIC'], items: [] }), () => gateRecords.recordGateResult({ round_id: a.round_id, candidate_id: `${a.round_id}:A005`, candidate: {} }));
  rounds.closeRound(a.round_id);
  assert.throws(() => open(2, '2026-11-18T04:00:00Z'), code(/MINE_ROUND_HOLDOUT_SEGMENT_OPENED/));
  // 新段照常
  assert.equal(open(2, '2026-11-18T04:00:00Z', H2).status, 'OPEN');

  // 对照：没开启留出段就关的轮，这一段还没被看过，第二轮可以共用
  freshData();
  const open2 = openOn('r16c');
  const x = open2(1, '2026-11-17T04:00:00Z');
  rounds.closeRound(x.round_id);
  assert.deepEqual([rounds.roundHead(x.round_id).gmine_passes, vault.openLog(x.round_id).length], [0, 0]);
  assert.equal(open2(2, '2026-11-18T04:00:00Z').holdout.from, H1.from);
  // 开启之前共用同一段的两轮：先开的那一轮开启之后，另一轮照样开自己的那一次
  freshData();
  const open3 = openOn('r16d');
  const p = open3(1, '2026-11-17T04:00:00Z'); const q = open3(2, '2026-11-18T04:00:00Z');
  for (const r of [p, q]) { oneCandidate(r); vault.seal({ round_id: r.round_id, segment: H1, data_ref: 'synthetic', data_sha256: sha('h'), sealedBy: 'TEST' }); }
  vault.open({ round_id: p.round_id, candidate_ids: [`${p.round_id}:A005`], openedBy: 'TEST' });
  assert.equal(vault.open({ round_id: q.round_id, candidate_ids: [`${q.round_id}:A005`], openedBy: 'TEST' }).segment_open_index, 2);
  process.env.QRP_DATA_DIR = dataRoot;
});

test('R1.5（修订 4）：机制的 written_at 不晚于登记时刻；打分时登记必须早于留出段开启，晚于开启的第 9 项不过（复审的情形：写成时刻比开启晚 4 分钟）', () => {
  const out = freshData();
  const { r, sel } = toSelection(out, { openedAt: '2026-11-24T02:00:00Z' });
  const id = r.round_id; const [first, second] = sel.selected;
  assert.ok(first && second, `need two survivors (${sel.selected.length})`);
  const M = { mechanism_id: 'SEL.MEANREV.SWING_BAND', economic_logic_zh: '合成测试文本', failure_mode_zh: '合成测试文本' };
  // 复审的情形：written_at 比现在（登记时刻）晚 4 分钟 → 登记就拒绝（以前容忍 5 分钟）
  const later = beijing(Date.now() + 4 * 60e3);
  assert.throws(() => mechanisms.registerMechanism(id, { candidate_id: first, ...M, written_at: later }, { writtenBy: AUTH }), code(/MINE_MECHANISM_WRITTEN_AT/));
  const stamp = '2026-11-17T06:00:00.000Z';
  assert.throws(() => mechanisms.registerMechanism(id, { candidate_id: first, ...M, written_at: '2026-11-17T14:00:01+08:00' }, { writtenBy: AUTH, registeredAt: stamp }), code(/MINE_MECHANISM_WRITTEN_AT/), 'one second late');
  assert.equal(mechanisms.registerMechanism(id, { candidate_id: first, ...M, written_at: '2026-11-17T14:00:00+08:00' }, { writtenBy: AUTH, registeredAt: stamp }).registered_at, stamp, 'equal is allowed');
  // 登记时刻在开启之后（台账里的 registered_at 晚于开启记录的 opened_at）→ 第 9 项不过
  const future = Date.now() + 4 * 60e3;
  mechanisms.registerMechanism(id, { candidate_id: second, ...M, written_at: beijing(future) }, { writtenBy: AUTH, registeredAt: new Date(future).toISOString() });
  runner.scoreHoldout({ roundId: id, sources: sources(), holdoutDir: fx.dirs.holdout, outDir: out, scoredAt: '2027-01-06T10:00:00+08:00', holdoutFloor: COV });
  const [open] = vault.openLog(id);
  assert.ok(Date.parse(mechanisms.mechanismOf(id, second).registered_at) > Date.parse(open.opened_at));
  const recs = new Map(gateRecords.recordsOf(id).map((x) => [x.candidate_id, x]));
  const item9 = (cid) => recs.get(cid).items.find((i) => i.item === 9);
  assert.equal(item9(second).pass, false);
  assert.ok(recs.get(second).codes.includes('MINE_MECHANISM_AFTER_HOLDOUT'), recs.get(second).codes.join(','));
  assert.ok(!recs.get(first).codes.includes('MINE_MECHANISM_AFTER_HOLDOUT'), 'registered before the open');
  process.env.QRP_DATA_DIR = dataRoot;
});

/** 一轮走到 FAILED_RESCORE（只用 P1 的服务：选择记录 → 封存 → 开启 → 一次重打分事件 → 又崩）。 */
function toFailedRescore(r) {
  oneCandidate(r);
  const sel = rounds.recordSelection(r.round_id, { selection_sha256: sha(`sel-${r.round_id}`), selected: [`${r.round_id}:A005`], evaluated: 1 });
  vault.seal({ round_id: r.round_id, segment: r.holdout, data_ref: 'synthetic', data_sha256: sha('h'), sealedBy: 'TEST' });
  vault.open({ round_id: r.round_id, candidate_ids: [`${r.round_id}:A005`], openedBy: 'TEST', selection_record_hash: sel.record_hash, inputs_sha256: sha('inputs') });
  vault.recordRescore({ round_id: r.round_id, reason: 'crash 1', log: 'x', inputs_sha256: sha('inputs'), rescoredBy: 'TEST' });
  return rounds.failRescore(r.round_id, { reason: 'crash 2' });
}

test('R1.8 的 FAILED_RESCORE：暂停规则把它当没过的已关轮；它不占开轮名额', () => {
  freshData();
  const open = openOn('r18p');
  const r1 = open(1, '2026-11-17T04:00:00Z'); rounds.closeRound(r1.round_id);
  const r2 = open(2, '2026-11-18T04:00:00Z'); rounds.closeRound(r2.round_id);
  const r3 = open(3, '2026-12-01T04:00:00Z', H2); const r4 = open(4, '2026-12-02T04:00:00Z', H2);
  assert.throws(() => open(9, '2027-01-04T04:00:00Z', H3), code(/MINE_ROUND_ALREADY_OPEN:CN_A:2/), 'r3 and r4 hold both slots');
  assert.equal(rounds.pauseState('CN_A').paused, false, 'two failed rounds only');
  assert.equal(toFailedRescore(r3).status, 'FAILED_RESCORE');
  // 暂停：r1、r2、r3 连续 3 轮没过（r3 是 FAILED_RESCORE）
  const pause = rounds.pauseState('CN_A');
  assert.deepEqual([pause.paused, pause.failed_rounds], [true, [r1.round_id, r2.round_id, r3.round_id]]);
  // 名额：r3 释放了，r4 仍占一个；用过的空间被暂停挡住，新空间可以开
  assert.throws(() => open(3, '2027-01-04T04:00:00Z', H3), code(/MINE_MARKET_PAUSED/));
  const r5 = open(5, '2027-01-04T04:00:00Z', H3);
  assert.deepEqual([r5.status, r5.resumed_after_pause], ['OPEN', [r1.round_id, r2.round_id, r3.round_id]]);
  process.env.QRP_DATA_DIR = dataRoot;
});

test('R1.12：写了一部分 G-MINE 记录之后崩溃 → 终态 FAILED_PARTIAL：0 个通过；已写的记录保留、标 VOID、不计数（暂停规则也不数）；尝试留在 N；释放开轮名额；留出段的开启照旧计数；只能从 SCORING 进入并写原因', () => {
  const passAll = () => ({ pass: true, codes: [], items: gate.ITEMS.map((i) => ({ item: i.item, key: i.key, pass: true })) });
  const b = rescoreRound(); const id = b.r.round_id;
  assert.ok(b.sel.selected.length >= 2, `need a partial set (${b.sel.selected.length})`);
  const n0 = rounds.familyN('CN_A', 5);
  assert.throws(() => gateRecords.internals.withGate(passAll, () => runner.internals.withFault('AFTER_FIRST_RECORD', () => runner.scoreHoldout(b.args))), code(/MINE_RUNNER_TEST_FAULT/));
  const [partial] = gateRecords.recordsOf(id);
  assert.deepEqual([gateRecords.recordsOf(id).length, partial.pass], [1, true], 'one record written, and it passed');
  // 只能从 SCORING、要写原因
  assert.throws(() => rounds.failPartial(id, { reason: '' }), code(/MINE_ROUND_FAILED_PARTIAL_REASON/));
  // 执行器：有记录 → 不重打分，以 FAILED_PARTIAL 关轮
  const reason = 'container killed after the first G-MINE record (synthetic)';
  assert.throws(() => runner.rescore({ ...b.args, reason, log: 'synthetic log' }), code(/MINE_RUNNER_RESCORE_RECORDS_EXIST/));
  const head = rounds.roundHead(id);
  assert.deepEqual([head.status, head.gmine_passes], ['FAILED_PARTIAL', 0]);
  assert.deepEqual([head.gmine_basis.records, head.gmine_basis.record_hashes], [0, []]);
  assert.deepEqual(head.gmine_basis.failed_partial, { reason, log_sha256: sha('synthetic log'), records_written: 1, candidates_opened: b.sel.selected.length,
    void_record_hashes: [partial.record_hash], ruling: 'R1.12' });
  assert.equal(vault.rescoreLog(id).length, 0, 'no rescore event');
  // VOID：原行保留，另记 VOID；默认读法不返回，带 includeVoid 才看得到
  assert.deepEqual(gateRecords.recordsOf(id), []);
  assert.deepEqual(gateRecords.recordsOf(id, { includeVoid: true }).map((x) => [x.record_hash, x.pass]), [[partial.record_hash, true]]);
  const [v] = gateRecords.voidsOf(id);
  assert.deepEqual([v.schema, v.voided_record_hash, v.candidate_id, v.round_status, v.ruling], ['MINING_GATE_RECORD_VOID_V1', partial.record_hash, partial.candidate_id, 'FAILED_PARTIAL', 'R1.12']);
  // 尝试留在 N；留出段的开启照旧计数
  assert.equal(rounds.familyN('CN_A', 5), n0);
  assert.deepEqual([vault.openLog(id).length, head.holdout_opens.count], [1, 1]);
  // 终态：不能再打分、重打分、关轮、记 G-MINE
  assert.throws(() => runner.rescore({ ...b.args, reason: 'again', log: 'x' }), code(/MINE_RUNNER_ROUND_FAILED_PARTIAL/));
  assert.throws(() => runner.scoreHoldout(b.args), code(/MINE_RUNNER_ROUND_FAILED_PARTIAL/));
  assert.throws(() => runner.close({ roundId: id }), code(/MINE_ROUND_NOT_OPEN/));
  assert.throws(() => rounds.failPartial(id, { reason: 'again' }), code(/MINE_ROUND_NOT_SCORING/));
  assert.throws(() => gateRecords.recordGateResult({ round_id: id, candidate_id: b.sel.selected[1], candidate: {} }), code(/MINE_GATE_RECORD_ROUND_NOT_SCORING/));
  // 这一段已开启过：不再开新轮（R1.6 修订 4）；新段上两轮可以同时开（FAILED_PARTIAL 不占名额）
  const open = openOn('r112');
  assert.throws(() => open(1, '2026-11-25T04:00:00Z'), code(/MINE_ROUND_HOLDOUT_SEGMENT_OPENED/));
  const r2 = open(2, '2026-12-01T04:00:00Z', H2);
  assert.throws(() => rounds.failPartial(r2.round_id, { reason: 'x' }), code(/MINE_ROUND_NOT_SCORING/), 'only from SCORING');
  const r3 = open(3, '2026-12-02T04:00:00Z', H2);
  assert.deepEqual([r2.status, r3.status], ['OPEN', 'OPEN']);
  // 暂停规则：FAILED_PARTIAL 按 0 个通过算，VOID 的通过记录不数
  rounds.closeRound(r2.round_id); rounds.closeRound(r3.round_id);
  const pause = rounds.pauseState('CN_A');
  assert.deepEqual([pause.paused, pause.failed_rounds], [true, [id, r2.round_id, r3.round_id]]);

  // 没写任何记录 → 走 R1.8 的重打分，不能 FAILED_PARTIAL；记录都写完了 → 正常关轮，也不能
  const c = rescoreRound();
  assert.throws(() => runner.internals.withFault('AFTER_OPEN', () => runner.scoreHoldout(c.args)), code(/MINE_RUNNER_TEST_FAULT/));
  assert.throws(() => rounds.failPartial(c.r.round_id, { reason: 'x' }), code(/MINE_ROUND_FAILED_PARTIAL_NO_RECORDS/));
  const d = rescoreRound();
  runner.scoreHoldout(d.args);
  assert.throws(() => rounds.failPartial(d.r.round_id, { reason: 'x' }), code(/MINE_ROUND_FAILED_PARTIAL_COMPLETE/));
  assert.equal(runner.close({ roundId: d.r.round_id }).status, 'CLOSED');
  // 重打分时写了一条又崩（R1.8 第二次崩溃）→ FAILED_RESCORE；那一条同样标 VOID、不计数
  const e = rescoreRound();
  assert.throws(() => runner.internals.withFault('AFTER_OPEN', () => runner.scoreHoldout(e.args)), code(/MINE_RUNNER_TEST_FAULT/));
  assert.throws(() => gateRecords.internals.withGate(passAll, () => runner.internals.withFault('AFTER_FIRST_RECORD', () => runner.rescore({ ...e.args, reason: 'crash 1', log: 'x' }))), code(/MINE_RUNNER_TEST_FAULT/));
  assert.throws(() => runner.rescore({ ...e.args, reason: 'crash 2', log: 'y' }), code(/MINE_RUNNER_RESCORE_FAILED/));
  const fr = rounds.roundHead(e.r.round_id);
  assert.deepEqual([fr.status, fr.gmine_passes, gateRecords.recordsOf(e.r.round_id).length, gateRecords.voidsOf(e.r.round_id).length], ['FAILED_RESCORE', 0, 0, 1]);
  assert.equal(fr.gmine_basis.failed_rescore.partial_records_ignored, 1);
  process.env.QRP_DATA_DIR = dataRoot;
});
