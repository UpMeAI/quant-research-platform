'use strict';
/**
 * 挖掘沙箱的数据适配器（RF1116 P2；导出规格 rev 2 的 CSV；冻结的空间 0d3556fa 的读数与时钟；冻结准备 §2.3 的股票池）。先红后绿，全部是合成数据。
 *   - 次日开盘可用：t 日的行只喂 t+1 开盘的决策；t 日的 daily_basic 用在 t 日的决策上 → 拒绝（看未来的反例）；
 *   - 后复权价 = 原始价 × 同一天的复权因子；
 *   - 同一 (证券, 日期) 的多个修订：LIVE 目录取次一交易日 09:00 之前入库的最新修订，迟到的不用；HISTORY（车道副本）都没赶上就取最早入库的（回补，计数）；
 *   - 股票池：不含北交所；当天 ST、上市不满 120 个交易日、当天停牌的不进池；
 *   - 申万 2021 一级行业按 effective_from 截断，修订按入库时刻；
 *   - 挖掘段的面板只到挖掘段终点；留出段目录只能进留出段打分的面板；
 *   - 车道副本的读法可换（适配器模块），默认读导出规格的 CSV 目录；每个文件都核 SHA256SUMS。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { makeMiningDataFixture, FACTS } = require('./_mining_data_fixture');
const adapter = require('../services/mining-sandbox/data-adapter');
const segments = require('../services/mining-sandbox/segments');

const ROOT = path.join(__dirname, '..');
const SPACE = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json'), 'utf8'));
const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-mining-data-')));
const lane = () => adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' });
const tail = () => adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' });
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const cell = (panel, reading, date, sec) => {
  const i = panel.dates.indexOf(date); const j = panel.codes.indexOf(sec);
  assert.ok(i >= 0 && j >= 0, `${date} ${sec} in panel`);
  return reading === null ? { i, j } : panel.readings[reading][i][j];
};
const csvRows = (dir, file) => {
  const out = []; adapter.internals.forEachCsvRow(path.join(dir, file), (r) => out.push(r)); return out;
};
const prevOpen = (d) => fx.calendar[fx.calendar.indexOf(d) - 1];

test('分段取自冻结的留出段页（0fefcd24）：挖掘段、前推验证折、锁定留出段', () => {
  const page = fs.readFileSync(path.join(ROOT, segments.FREEZE_PAGE.path));
  assert.equal(crypto.createHash('sha256').update(page).digest('hex'), segments.FREEZE_PAGE.sha256);
  const text = page.toString('utf8');
  for (const [zh, key] of [['挖掘段', 'MINING'], ['前推验证折', 'VALIDATION'], ['锁定留出段', 'HOLDOUT']]) {
    const s = segments.SEGMENTS[key];
    assert.ok(text.split('\n').some((l) => l.startsWith(`| ${zh} | ${s.from} → ${s.to} |`)), `${zh} ${s.from} → ${s.to}`);
  }
  assert.equal(segments.segmentOf('2023-12-29'), 'MINING');
  assert.equal(segments.segmentOf('2024-01-02'), 'VALIDATION');
  assert.equal(segments.segmentOf('2026-10-19'), 'HOLDOUT');
  assert.equal(segments.segmentOf('2027-01-04'), null);
});

test('CSV：带引号的 JSON、NULL 与空串分开；每个文件核 SHA256SUMS，不在清单里或 sha 不对都拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-csv-'));
  const f = path.join(dir, 'x.csv');
  fs.writeFileSync(f, 'a,b,c\n1,"{""k"": ""v,w""}",\n2,"",z\r\n');
  const rows = []; adapter.internals.forEachCsvRow(f, (r) => rows.push(r));
  assert.deepEqual(rows, [{ a: '1', b: '{"k": "v,w"}', c: null }, { a: '2', b: '', c: 'z' }]);

  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-tamper-'));
  for (const n of fs.readdirSync(fx.dirs.tail)) fs.copyFileSync(path.join(fx.dirs.tail, n), path.join(copy, n));
  const src = adapter.csvDirSource(copy, { mode: 'LIVE', label: 'copy' });
  assert.equal(src.sums_sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(copy, 'SHA256SUMS'))).digest('hex'));
  fs.appendFileSync(path.join(copy, 'trading_calendar.csv'), '2027-01-04,A_SHARE,SSE,t,2026-12-31,2026-12-31 00:00:00+08,2026-12-31 00:00:00+08,x,1,v,READY\n');
  assert.throws(() => src.forEach('calendar', () => {}), code(/MINE_DATA_SHA256SUMS_MISMATCH/));
  const sums = fs.readFileSync(path.join(copy, 'SHA256SUMS'), 'utf8').split('\n').filter((l) => !l.endsWith('trading_calendar.csv')).join('\n');
  fs.writeFileSync(path.join(copy, 'SHA256SUMS'), sums);
  assert.throws(() => adapter.csvDirSource(copy, { mode: 'LIVE', label: 'copy' }).forEach('calendar', () => {}), code(/MINE_DATA_FILE_NOT_IN_SHA256SUMS/));
  assert.throws(() => adapter.csvDirSource(copy, { mode: 'SOMETIMES', label: 'copy' }), code(/MINE_DATA_SOURCE_MODE/));
  assert.throws(() => adapter.csvDirSource(path.join(copy, 'nope'), { mode: 'LIVE', label: 'copy' }), code(/MINE_DATA_SOURCE_DIR/));
});

test('看未来的反例：t 日的 daily_basic 用在 t 日的决策上被拒；面板里它只出现在 t+1 开盘的决策上', () => {
  const t = FACTS.lookAhead.date; const t1 = fx.calendar[fx.calendar.indexOf(t) + 1];
  for (const clock of ['CLOSE_DATED_NEXT_OPEN_USABLE', 'BAR_CLOSE']) {
    assert.throws(() => adapter.assertUsable({ trade_date: t, clock }, t, fx.calendar), code(/MINE_DATA_LOOK_AHEAD/));
    assert.throws(() => adapter.assertUsable({ trade_date: t, clock }, prevOpen(t), fx.calendar), code(/MINE_DATA_LOOK_AHEAD/));
    assert.doesNotThrow(() => adapter.assertUsable({ trade_date: t, clock }, t1, fx.calendar));
  }
  assert.throws(() => adapter.assertUsable({ trade_date: t, clock: 'OBSERVED_AT' }, t1, fx.calendar), code(/MINE_DATA_CLOCK_UNSUPPORTED/));
  const p = adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'MINING', from: '2022-03-01', to: '2022-03-31' });
  assert.notEqual(cell(p, 'pb', t, FACTS.lookAhead.code), FACTS.lookAhead.pb);
  assert.equal(cell(p, 'pb', t1, FACTS.lookAhead.code), FACTS.lookAhead.pb);
  const raw = csvRows(fx.dirs.lane, 'prices_daily_stock.csv').find((r) => r.security_id === 'S01.SH' && r.trade_date === prevOpen(t));
  assert.equal(cell(p, 'ret_1d', t, 'S01.SH'), Number(raw.close) / Number(raw.previous_close) - 1);
  assert.equal(cell(p, 'amount', t, 'S01.SH'), Number(raw.turnover_amount_cny));
  assert.ok(p.dates.every((d) => d >= '2022-03-01' && d <= '2022-03-31'));
});

test('后复权价 = 原始价 × 同一天的复权因子（拆股前后连续）；执行价标签 = 当天开盘原始价 × 当天因子', () => {
  const { code: sec, date } = FACTS.split;
  const p = adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'MINING', from: '2022-06-20', to: '2022-07-15' });
  const prices = csvRows(fx.dirs.lane, 'prices_daily_stock.csv').filter((r) => r.security_id === sec);
  const factors = csvRows(fx.dirs.lane, 'adjustment_factor_observation_stock.csv').filter((r) => r.security_id === sec);
  const at = (rows, d, k) => Number(rows.find((r) => r.trade_date === d)[k]);
  const d1 = fx.calendar[fx.calendar.indexOf(date) + 1];
  for (const k of ['close', 'open', 'high', 'low']) {
    assert.equal(cell(p, `${k}_hfq`, d1, sec), at(prices, date, k) * at(factors, date, 'adjustment_factor'));
    assert.equal(cell(p, `${k}_hfq`, date, sec), at(prices, prevOpen(date), k) * at(factors, prevOpen(date), 'adjustment_factor'));
  }
  const jump = cell(p, 'close_hfq', d1, sec) / cell(p, 'close_hfq', date, sec);
  assert.ok(jump > 0.9 && jump < 1.1, `hfq continuous across the split (${jump})`);
  const { i, j } = cell(p, null, date, sec);
  assert.equal(p.labels.exec_open[i][j], at(prices, date, 'open') * at(factors, date, 'adjustment_factor'));
});

test('修订：LIVE 取次一交易日 09:00 前入库的最新修订、迟到的不用；HISTORY 都没赶上取最早入库的（回补计数）；非 READY 的行不用', () => {
  const p = adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'VALIDATION', from: '2026-09-01', to: '2026-10-16' });
  const r = FACTS.liveRevision;
  assert.equal(cell(p, 'pb', fx.calendar[fx.calendar.indexOf(r.date) + 1], r.code), r.rev1.pb);
  const late = FACTS.liveLate;
  assert.ok(Number.isNaN(cell(p, 'pb', fx.calendar[fx.calendar.indexOf(late.date) + 1], late.code)));
  assert.ok(!Number.isNaN(cell(p, 'total_mv', fx.calendar[fx.calendar.indexOf(late.date) + 1], 'S01.SH')));
  assert.ok(p.manifest.counts.daily_basic.late_unused >= 1);

  const h = adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'MINING', from: '2021-05-01', to: '2021-08-31' });
  const b = FACTS.backfillRevision;
  assert.equal(cell(h, 'pb', fx.calendar[fx.calendar.indexOf(b.date) + 1], b.code), b.rev1.pb);
  assert.ok(h.manifest.counts.daily_basic.backfill > 0);
  assert.ok(Number.isNaN(cell(h, 'close_hfq', fx.calendar[fx.calendar.indexOf(FACTS.conflict.date) + 1], FACTS.conflict.code)));
  assert.ok(h.manifest.counts.prices_daily.quality_skipped >= 1);
  assert.deepEqual(h.manifest.rules.accepted_quality, ['READY']);
  assert.deepEqual(h.manifest.sources.map((s) => [s.label, s.mode]), [['lane', 'HISTORY'], ['tail', 'LIVE']]);
});

test('股票池：不含北交所；当天 ST、上市不满 120 个交易日、当天停牌的不进池；其余进池', () => {
  const p = adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'MINING', from: '2020-06-01', to: '2023-12-29' });
  assert.ok(!p.codes.includes(FACTS.bse));
  const inU = (d, sec) => { const { i, j } = cell(p, null, d, sec); return p.universe[i][j]; };
  assert.equal(inU('2022-03-01', FACTS.st.code), false);
  assert.equal(inU('2022-07-04', FACTS.st.code), true);
  const n = FACTS.newListing; const li = fx.calendar.indexOf(n.listing);
  assert.equal(inU(fx.calendar[li + 119], n.code), false);
  assert.equal(inU(fx.calendar[li + 120], n.code), true);
  assert.equal(inU(FACTS.suspended.from, FACTS.suspended.code), false);
  assert.equal(inU(FACTS.suspended.to, FACTS.suspended.code), false);
  assert.equal(inU(fx.calendar[fx.calendar.indexOf(FACTS.suspended.to) + 1], FACTS.suspended.code), true);
  assert.equal(inU('2020-06-01', 'S09.SH'), true); // 2019-07-22 上市：日历从 2019-06-03 起数
  assert.equal(inU('2022-03-01', 'S01.SH'), true);
});

test('行业：申万 2021 一级，按 effective_from 截断（旧成员的修订 2 写了 effective_to）；二级不用；市值 = 前一交易日的 total_mv', () => {
  const p = adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'MINING', from: '2023-06-15', to: '2023-07-31' });
  const ind = (d, sec) => { const { i, j } = cell(p, null, d, sec); return p.industry[i][j]; };
  // ★RF1116_INDUSTRY_END_INCLUSIVE (a)：effective_to 含当天（旧成员的修订 2 写的是最后一个交易日 lastOld）
  assert.equal(prevOpen(FACTS.reclass.date), FACTS.reclass.lastOld);
  assert.equal(ind(FACTS.reclass.lastOld, FACTS.reclass.code), FACTS.reclass.from, 'the last day still belongs to the old industry');
  assert.equal(ind(FACTS.reclass.date, FACTS.reclass.code), FACTS.reclass.to);
  assert.equal(ind('2023-07-03', 'S01.SH'), '801010');
  assert.equal(ind(FACTS.membershipEnds.date, FACTS.membershipEnds.code), '801080', 'effective_to is inclusive');
  const after = fx.calendar[fx.calendar.indexOf(FACTS.membershipEnds.date) + 1];
  assert.equal(ind(after, FACTS.membershipEnds.code), null, 'no industry from the next trading day');
  const { i, j } = cell(p, null, '2023-07-03', 'S01.SH');
  assert.equal(p.size[i][j], p.readings.total_mv[i][j]);
  assert.ok(Number.isFinite(p.size[i][j]));
});

test('分段：挖掘段的面板只到挖掘段终点；留出段目录只能进留出段的面板；读数要有映射、时钟要是次日开盘可用的', () => {
  assert.throws(() => adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'MINING', from: '2023-12-01', to: '2024-01-05' }), code(/MINE_DATA_SEGMENT_RANGE/));
  assert.throws(() => adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'VALIDATION', from: '2026-09-01', to: '2026-10-19' }), code(/MINE_DATA_SEGMENT_RANGE/));
  assert.throws(() => adapter.buildPanel({ sources: [lane()], space: SPACE, segment: 'SOMETHING', from: '2021-01-04', to: '2021-02-01' }), code(/MINE_DATA_SEGMENT_UNKNOWN/));
  const holdout = adapter.csvDirSource(fx.dirs.holdout, { mode: 'LIVE', label: 'holdout', holdout: true });
  assert.throws(() => adapter.buildPanel({ sources: [lane(), tail(), holdout], space: SPACE, segment: 'VALIDATION', from: '2026-09-01', to: '2026-10-16' }),
    code(/MINE_DATA_HOLDOUT_SOURCE_OUTSIDE_HOLDOUT/));
  const hp = adapter.buildPanel({ sources: [lane(), tail(), holdout], space: SPACE, segment: 'HOLDOUT', from: '2026-09-01', to: '2026-12-31' });
  assert.equal(hp.dates[hp.dates.length - 1], '2026-12-31');
  assert.equal(hp.segment, 'HOLDOUT');
  const m = adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'MINING', from: '2023-11-01', to: '2023-12-29' });
  assert.equal(m.segment, 'MINING');
  assert.equal(m.dates[m.dates.length - 1], '2023-12-29');
  assert.deepEqual(Object.keys(m.readings).sort(), SPACE.readings.map((r) => r.name).sort());
  const bad = (patch) => ({ ...SPACE, readings: [...SPACE.readings.slice(0, 1), { ...SPACE.readings[1], ...patch }] });
  assert.throws(() => adapter.buildPanel({ sources: [lane()], space: bad({ name: 'close_qfq' }), segment: 'MINING', from: '2021-01-04', to: '2021-02-01' }), code(/MINE_DATA_READING_UNMAPPED/));
  assert.throws(() => adapter.buildPanel({ sources: [lane()], space: bad({ pit_available_at: 'OBSERVED_AT (live)' }), segment: 'MINING', from: '2021-01-04', to: '2021-02-01' }),
    code(/MINE_DATA_CLOCK_UNSUPPORTED/));
  assert.throws(() => adapter.buildPanel({ sources: [lane()], space: bad({ dataset_id: 'V6_CN_STOCK_DAILY_BASIC' }), segment: 'MINING', from: '2021-01-04', to: '2021-02-01' }),
    code(/MINE_DATA_READING_UNMAPPED/));
});

/** 把一个目录的日历改写成别的样子（重算 SHA256SUMS）。 */
function withCalendar(src, mapRows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-cal-'));
  for (const n of fs.readdirSync(src)) fs.copyFileSync(path.join(src, n), path.join(dir, n));
  const rows = csvRows(dir, 'trading_calendar.csv');
  const { cols, out } = mapRows(rows);
  fs.writeFileSync(path.join(dir, 'trading_calendar.csv'), require('./_mining_data_fixture').internals.csv(cols, out));
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.csv')).sort();
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${files.map((n) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, n))).digest('hex')}  ${n}`).join('\n')}\n`);
  return dir;
}

test('日历（导出规格 rev 3：canonical_calendar_observation，market 恒为 A_SHARE、交易所在 exchange）：开市日只认 SSE；两所不一致的日子列进清单；没有 exchange 列才看 market', () => {
  const rows = csvRows(fx.dirs.lane, 'trading_calendar.csv');
  assert.ok(rows.every((r) => r.market === 'A_SHARE') && rows.some((r) => r.exchange === 'SZSE'), 'fixture is rev 3');
  const p = adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'MINING', from: '2021-04-01', to: '2021-04-30' });
  const d = FACTS.calendarDisagree.date;
  assert.ok(p.dates.includes(d), 'SSE open day kept although SZSE says closed');
  assert.deepEqual(p.manifest.calendar.exchange, 'SSE');
  assert.deepEqual(p.manifest.calendar.sse_szse_disagreements, [d]);
  assert.equal(p.dates.length, fx.calendar.filter((x) => x >= '2021-04-01' && x <= '2021-04-30').length);
  // 只有 SZSE 行 → 没有开市日来源，拒绝（不拿深交所顶替）
  const szseOnly = withCalendar(fx.dirs.lane, (rs) => ({ cols: Object.keys(rs[0]), out: rs.filter((r) => r.exchange === 'SZSE') }));
  const tailNoCal = withCalendar(fx.dirs.tail, (rs) => ({ cols: Object.keys(rs[0]), out: rs.filter((r) => r.exchange === 'SZSE') }));
  assert.throws(() => adapter.buildPanel({ sources: [adapter.csvDirSource(szseOnly, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(tailNoCal, { mode: 'LIVE', label: 'tail' })],
    space: SPACE, segment: 'MINING', from: '2021-04-01', to: '2021-04-30' }), code(/MINE_DATA_CALENDAR_MISSING:SSE/));
  // 旧写法（没有 exchange 列、market = SSE）照样能读；有 exchange 列时不看 market
  const legacy = (src) => withCalendar(src, (rs) => ({ cols: ['calendar_date', 'market', 'is_open', 'first_available_at', 'ingested_at', 'source_record_id', 'revision', 'schema_version', 'quality_state'],
    out: rs.filter((r) => r.exchange === 'SSE').map((r) => ({ ...r, market: 'SSE' })) }));
  const lp = adapter.buildPanel({ sources: [adapter.csvDirSource(legacy(fx.dirs.lane), { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(legacy(fx.dirs.tail), { mode: 'LIVE', label: 'tail' })],
    space: SPACE, segment: 'MINING', from: '2021-04-01', to: '2021-04-30' });
  assert.deepEqual(lp.dates, p.dates);
  // 同一 (日期, 交易所) 有晚入库的修订：取它（2021-04-08 的 SSE 修订 2 改成休市）
  const amend = (src) => withCalendar(src, (rs) => ({ cols: Object.keys(rs[0]), out: [...rs, { ...rs.find((r) => r.calendar_date === '2021-04-08' && r.exchange === 'SSE'),
    is_open: 'f', revision: '2', first_available_at: '2026-04-01 12:00:00+08', source_record_id: 'cal:2021-04-08:SSE:r2' }] }));
  const ap = adapter.buildPanel({ sources: [adapter.csvDirSource(amend(fx.dirs.lane), { mode: 'HISTORY', label: 'lane' }), tail()], space: SPACE, segment: 'MINING', from: '2021-04-01', to: '2021-04-30' });
  assert.ok(p.dates.includes('2021-04-08') && !ap.dates.includes('2021-04-08'), 'the later calendar revision wins');
});

test('只有 SSE 的日历（车道副本的 BASE 库：每个日历日一行 SSE、没有 SZSE，勘误 1 / ★RF1116_CAL_MIN (a)）照样能读：开市日一样、没有两所不一致可列；runner 的留出段核对也只看 SSE', () => {
  const sseOnly = (src) => withCalendar(src, (rs) => ({ cols: Object.keys(rs[0]), out: rs.filter((r) => r.exchange === 'SSE') }));
  const laneSse = sseOnly(fx.dirs.lane);
  assert.ok(csvRows(laneSse, 'trading_calendar.csv').every((r) => r.exchange === 'SSE'));
  for (const [segment, from, to] of [['MINING', '2021-04-01', '2021-04-30'], ['VALIDATION', '2026-09-01', '2026-10-16']]) {
    const both = adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment, from, to });
    // 车道副本只有 SSE（BASE），验证尾段与留出段照导出规格 rev 3 有两所；全只有 SSE 也一样
    for (const srcs of [[adapter.csvDirSource(laneSse, { mode: 'HISTORY', label: 'lane' }), tail()],
      [adapter.csvDirSource(laneSse, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(sseOnly(fx.dirs.tail), { mode: 'LIVE', label: 'tail' })]]) {
      const p = adapter.buildPanel({ sources: srcs, space: SPACE, segment, from, to });
      assert.deepEqual(p.dates, both.dates, `${segment}: same open days`);
      assert.equal(p.manifest.calendar.exchange, 'SSE');
    }
  }
  const pAll = adapter.buildPanel({ sources: [adapter.csvDirSource(laneSse, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(sseOnly(fx.dirs.tail), { mode: 'LIVE', label: 'tail' })],
    space: SPACE, segment: 'MINING', from: '2021-04-01', to: '2021-04-30' });
  assert.deepEqual(pAll.manifest.calendar.sse_szse_disagreements, [], 'nothing to compare without SZSE rows, and nothing is required');
  // 留出段目录的核对（runner.holdoutDirCheck）只看 READY 的 SSE 行
  const runner = require('../services/mining-sandbox/round-runner');
  const holdSse = sseOnly(fx.dirs.holdout);
  const seal = { data_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(holdSse, 'SHA256SUMS'))).digest('hex'), segment: { from: '2026-10-19', to: '2026-12-31' } };
  const c = runner.holdoutDirCheck(holdSse, seal, { minNamesPerDay: 5 });
  assert.equal(c.calendar_to, '2026-12-31');
});

test('行业的可得时刻：晚入库的修订（改了行业代码）在它入库之前的决策日不用；回补的历史取最早入库那一刻的', () => {
  const r = FACTS.industryRevision;
  const v = adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'VALIDATION', from: '2026-09-01', to: '2026-10-16' });
  const ind = (p, day) => { const { i, j } = cell(p, null, day, r.code); return p.industry[i][j]; };
  assert.equal(ind(v, '2026-10-12'), r.before, 'cutoff 10-12 09:00 is before the 10:00 revision');
  assert.equal(ind(v, '2026-10-13'), r.after);
  const m = adapter.buildPanel({ sources: [lane(), tail()], space: SPACE, segment: 'MINING', from: '2023-06-01', to: '2023-06-30' });
  assert.equal(ind(m, '2023-06-01'), r.before, 'history falls back to the earliest recorded state, not the later revision');
});

test('车道副本的读法可换：loadSource 按适配器模块的 createSource 建源；默认是导出规格的 CSV 目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-adapter-mod-'));
  const mod = path.join(dir, 'lane-adapter.js');
  fs.writeFileSync(mod, `'use strict';\nconst a = require(${JSON.stringify(path.join(ROOT, 'services/mining-sandbox/data-adapter'))});\n`
    + 'let calls = 0;\nmodule.exports = { createSource: (d, o) => { calls += 1; return { ...a.csvDirSource(d, o), adapter: "custom" }; }, calls: () => calls };\n');
  const s = adapter.loadSource({ dir: fx.dirs.lane, mode: 'HISTORY', label: 'lane', adapter: mod });
  assert.equal(s.adapter, 'custom');
  assert.equal(require(mod).calls(), 1);
  assert.equal(adapter.loadSource({ dir: fx.dirs.lane, mode: 'HISTORY', label: 'lane' }).kind, 'CSV_DIR');
  const broken = path.join(dir, 'broken.js'); fs.writeFileSync(broken, 'module.exports = {};\n');
  assert.throws(() => adapter.loadSource({ dir: fx.dirs.lane, mode: 'HISTORY', label: 'lane', adapter: broken }), code(/MINE_DATA_ADAPTER_INVALID/));
  const p = adapter.buildPanel({ sources: [s, tail()], space: SPACE, segment: 'MINING', from: '2021-01-04', to: '2021-02-26' });
  assert.ok(p.codes.length > 10);
});
