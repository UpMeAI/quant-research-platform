'use strict';
/**
 * 留出段开启前的目录核对：逐日核 daily_basic 每个读数的取值状态，不只数行（独立复审第二轮，2026-11-18；协调会话：必须在打分之前合并）。
 * V6 的 daily_basic 有整天某个字段全是 MISSING 的日子（真实行夹具：2026-09-29、10-08、10-09 的 turnover_rate_f 与 dv_ttm 每只都 MISSING）；
 * 只数行的话这样的留出段照样过，开启就花掉了。先红后绿，用真实行夹具（tests/fixtures/mining-real-rows-20261118，钉 sha）当一个封存的留出段目录：
 *   - 核的是面板真读的交易日：每个决策日的前一个开市日（段从 10-13 起 → 交易日 10-12..10-15；10-16 的 daily_basic 不喂任何决策日）；
 *   - 只数 LIVE 截止（次一开市日 09:00 +08）之前入库的、最新的那个修订（与面板同一个函数）；晚到的修订不算（复审 #127 P1-1）；
 *   - 每个读数：每天状态读得出数（PRESENT / ZERO）的名字数 ≥ 封存那一份各日中位数的 0.9（★RF1116_FIELD_FLOOR_SHARE）；只数状态、不读数（P2-2）；
 *     封存那一份里一天都没有 → 拒；total_mv（市值中性化要用）另要 ≥ 每天的名字数下限；
 *   - values 解析不过 → 开启之前就拒（P2-1）；协调会话的排除文件（sha 钉住）列出的（日, 字段）不判、照实写进结果（P3-1）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'TEST_ROUND_RUNNER_AUTHORITY';
const runner = require('../services/mining-sandbox/round-runner');
const adapter = require('../services/mining-sandbox/data-adapter');
const { forEachCsvRow } = require('../services/mining-sandbox/data-adapter/csv');

const FIXTURE = path.join(__dirname, 'fixtures', 'mining-real-rows-20261118');
const FIXTURE_SUMS_SHA256 = 'b6c7becb35cb90392d06a021c626ae5f9d8a790accbb9472bc8f88c1a32da088'; // 与 mining_real_rows.test.js 同一份
const BASIC = 'market_daily_basic_observation_stock.csv';
const PRICES = 'prices_daily_stock.csv';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const LATE = '2026-10-20 02:00:00+00'; // 远在任何一天的截止（次一开市日 09:00 +08）之后
const MISSING = { state: 'MISSING', value: null };

const readRows = (file) => { const rows = []; forEachCsvRow(file, (r) => rows.push(r)); return rows; };
const writeRows = (file, cols, rows) => fs.writeFileSync(file, `${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')}\n`);
const resum = (dir) => {
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.csv')).sort();
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${files.map((n) => `${sha256(fs.readFileSync(path.join(dir, n)))}  ${n}`).join('\n')}\n`);
};
/**
 * 真实行夹具的副本当留出段目录，封存那一份 = 改完 sealed 之后的 SHA256SUMS。
 *   sealed：{ [file]: (rows) => rows }，封存之前改；appended：{ [part file]: rows }，封存之后补导的部分（带日期后缀，只追加）。
 */
function holdout(segment, { sealed = {}, appended = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-hff-'));
  for (const f of fs.readdirSync(FIXTURE)) if (f.endsWith('.csv')) fs.copyFileSync(path.join(FIXTURE, f), path.join(dir, f));
  for (const [file, fn] of Object.entries(sealed)) {
    const rows = readRows(path.join(dir, file)); const cols = Object.keys(rows[0]);
    writeRows(path.join(dir, file), cols, fn(rows));
  }
  resum(dir);
  fs.copyFileSync(path.join(dir, 'SHA256SUMS'), path.join(dir, 'SHA256SUMS.sealed'));
  for (const [part, rows] of Object.entries(appended)) { writeRows(path.join(dir, part), Object.keys(rows[0]), rows); }
  if (Object.keys(appended).length) resum(dir);
  return { dir, seal: { data_sha256: sha256(fs.readFileSync(path.join(dir, 'SHA256SUMS.sealed'))), segment } };
}
/** daily_basic 的某些行改 values（fn(r, v) 返回 true 才写回）。 */
const basicEdit = (fn) => (rows) => rows.map((r) => { const v = JSON.parse(r.values); return fn(r, v) ? { ...r, values: JSON.stringify(v) } : r; });
/** 一行的晚到修订：revision + 1、入库时刻在截止之后。 */
const lateRevisionOf = (r, values) => ({ ...r, record_id: `${r.record_id}:late`, revision: String(Number(r.revision || 0) + 1), first_available_at: LATE, ingested_at: LATE, values: JSON.stringify(values) });

const FULL = { from: '2026-10-13', to: '2026-10-16' }; // 读的交易日 10-12..10-15，七个字段都有
const MIN = { minNamesPerDay: 20 }; // 夹具每天二十几只
const DAY = '2026-10-14';

test('夹具钉住：真实行夹具的 SHA256SUMS sha 与逐个文件都对得上（本文件单跑也核输入）', () => {
  assert.equal(sha256(fs.readFileSync(path.join(FIXTURE, 'SHA256SUMS'))), FIXTURE_SUMS_SHA256);
  for (const line of fs.readFileSync(path.join(FIXTURE, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)) {
    const [h, file] = line.split(/\s+/);
    assert.equal(sha256(fs.readFileSync(path.join(FIXTURE, file))), h, file);
  }
});

test('字段状态下限：七个字段都齐的几天过；结果写明读的交易日、每个字段逐日可用名字数、字段下限 0.9 与没有排除', () => {
  const h = holdout(FULL);
  const c = runner.holdoutDirCheck(h.dir, h.seal, MIN);
  const keys = ['turnover_rate_f', 'total_mv', 'circ_mv', 'pe_ttm', 'pb', 'ps_ttm', 'dv_ttm'];
  assert.deepEqual(Object.keys(c.field_states_per_day).sort(), [...keys].sort());
  for (const k of keys) {
    const s = c.field_states_per_day[k];
    assert.ok(s.min > 0 && s.median >= s.min && s.sealed_median > 0 && Array.isArray(s.excluded_days) && !s.excluded_days.length, `${k} ${JSON.stringify(s)}`);
  }
  assert.ok(c.field_states_per_day.total_mv.min >= 20);
  assert.deepEqual([c.trade_dates.from, c.trade_dates.to], ['2026-10-12', '2026-10-15']);
  assert.equal(c.field_floor.min_share_of_sealed_median, 0.9);
  assert.equal(c.field_exclusions, null);
});

test('真实数据：2026-09-29 的 turnover_rate_f / dv_ttm 每只都 MISSING → 读到这一天的留出段（从 09-30 起）被拒（只数行会过）', () => {
  const h = holdout({ from: '2026-09-30', to: '2026-10-16' });
  assert.throws(() => runner.holdoutDirCheck(h.dir, h.seal, MIN), code(/MINE_RUNNER_HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:(turnover_rate_f|dv_ttm):2026-09-29:0$/));
});

test('total_mv：某一天每只都 MISSING 拒；某一天可用的不到名字数下限也拒', () => {
  const allGone = holdout(FULL, { sealed: { [BASIC]: basicEdit((r, v) => { if (r.trade_date !== DAY) return false; v.total_mv = MISSING; return true; }) } });
  assert.throws(() => runner.holdoutDirCheck(allGone.dir, allGone.seal, MIN), code(/HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:total_mv:2026-10-14:0$/));
  let n = 0;
  const someGone = holdout(FULL, { sealed: { [BASIC]: basicEdit((r, v) => { if (r.trade_date !== DAY || n >= 10) return false; n += 1; v.total_mv = MISSING; return true; }) } });
  assert.throws(() => runner.holdoutDirCheck(someGone.dir, someGone.seal, MIN), code(/HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:total_mv:2026-10-14:1\d$/));
});

test('某个字段在封存那一份里一天都没有可用值 → 拒（中位数是 0 时相对下限不起作用）', () => {
  const h = holdout(FULL, { sealed: { [BASIC]: basicEdit((r, v) => { v.pb = MISSING; return true; }) } });
  assert.throws(() => runner.holdoutDirCheck(h.dir, h.seal, MIN), code(/MINE_RUNNER_HOLDOUT_FIELD_EMPTY:market_daily_basic_observation_stock\.csv:pb$/));
});

test('复审 P1-1：准时的修订 total_mv MISSING、截止之后才到的修订 PRESENT → 拒（面板那天读不到市值）', () => {
  const fix = (rows) => {
    const out = basicEdit((r, v) => { if (r.trade_date !== DAY) return false; v.total_mv = MISSING; return true; })(rows);
    return [...out, ...rows.filter((r) => r.trade_date === DAY).map((r) => lateRevisionOf(r, JSON.parse(r.values)))];
  };
  const h = holdout(FULL, { sealed: { [BASIC]: fix } });
  assert.throws(() => runner.holdoutDirCheck(h.dir, h.seal, MIN), code(/HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:total_mv:2026-10-14:0$/));
});

test('复审 P1-1 镜像：准时的修订 PRESENT、截止之后的修订 MISSING → 过（面板读的是准时那一行）', () => {
  const fix = (rows) => [...rows, ...rows.filter((r) => r.trade_date === DAY).map((r) => { const v = JSON.parse(r.values); v.total_mv = MISSING; return lateRevisionOf(r, v); })];
  const h = holdout(FULL, { sealed: { [BASIC]: fix } });
  const c = runner.holdoutDirCheck(h.dir, h.seal, MIN);
  assert.ok(c.field_states_per_day.total_mv.min >= 20, JSON.stringify(c.field_states_per_day.total_mv));
});

test('复审 P1-1（行数那一圈）：某一天的日线全都截止之后才入库 → 拒（面板那天没有行情）', () => {
  const h = holdout(FULL, { sealed: { [PRICES]: (rows) => rows.map((r) => (r.trade_date === DAY ? { ...r, first_available_at: LATE, known_at: LATE, ingested_at: LATE } : r)) } });
  assert.throws(() => runner.holdoutDirCheck(h.dir, h.seal, MIN), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:prices_daily_stock\.csv:2026-10-14:0$/));
});

test('复审 P2-1：一行 values 不是 JSON → 开启之前就拒（面板会在开启之后才抛）', () => {
  let done = false;
  const h = holdout(FULL, { sealed: { [BASIC]: (rows) => rows.map((r) => { if (done || r.trade_date !== '2026-10-13') return r; done = true; return { ...r, values: r.values.slice(0, 20) }; }) } });
  assert.throws(() => runner.holdoutDirCheck(h.dir, h.seal, MIN), code(/MINE_RUNNER_HOLDOUT_FIELD_VALUES_INVALID:market_daily_basic_observation_stock\.csv:2026-10-13:/));
});

test('复审 P2-2：只数状态——PRESENT 就算，不把 value 读成数；未知状态（DEGRADED）不算', () => {
  const odd = holdout(FULL, { sealed: { [BASIC]: basicEdit((r, v) => { if (r.trade_date !== DAY) return false; v.pb = { state: 'PRESENT', value: 'n/a' }; return true; }) } });
  assert.ok(runner.holdoutDirCheck(odd.dir, odd.seal, MIN).field_states_per_day.pb.min >= 20);
  const degraded = holdout(FULL, { sealed: { [BASIC]: basicEdit((r, v) => { if (r.trade_date !== DAY) return false; v.pb = { state: 'DEGRADED', value: 1 }; return true; }) } });
  assert.throws(() => runner.holdoutDirCheck(degraded.dir, degraded.seal, MIN), code(/HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:pb:2026-10-14:0$/));
});

test('复审 P2-4（★RF1116_FIELD_FLOOR_SHARE = 0.9）：一个字段缺 13 只（约 46%）→ 拒；缺 2 只 → 过', () => {
  const missingN = (n) => { let k = 0; return basicEdit((r, v) => { if (r.trade_date !== DAY || k >= n) return false; k += 1; v.turnover_rate_f = MISSING; return true; }); };
  const many = holdout(FULL, { sealed: { [BASIC]: missingN(13) } });
  assert.throws(() => runner.holdoutDirCheck(many.dir, many.seal, MIN), code(/HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:turnover_rate_f:2026-10-14:\d+$/));
  const few = holdout(FULL, { sealed: { [BASIC]: missingN(2) } });
  assert.ok(runner.holdoutDirCheck(few.dir, few.seal, MIN).field_states_per_day.turnover_rate_f.min >= 20);
});

test('复审 P3-2：核的是喂决策日的交易日——第一个决策日的前一天（10-12）要核；最后一天（10-16）的 daily_basic 不喂任何决策日，不核', () => {
  const before = holdout(FULL, { sealed: { [BASIC]: basicEdit((r, v) => { if (r.trade_date !== '2026-10-12') return false; v.total_mv = MISSING; return true; }) } });
  assert.throws(() => runner.holdoutDirCheck(before.dir, before.seal, MIN), code(/HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:total_mv:2026-10-12:0$/));
  const lastDay = holdout(FULL, { sealed: { [BASIC]: basicEdit((r, v) => { if (r.trade_date !== '2026-10-16') return false; v.total_mv = MISSING; return true; }) } });
  assert.ok(runner.holdoutDirCheck(lastDay.dir, lastDay.seal, MIN).field_states_per_day.total_mv.min >= 20);
});

test('复审 P3-2：第一个决策日的前一天在之前的 LIVE 源（验证尾段）里也核；没给那个源 → 那一天没有行，拒', () => {
  const drop = (rows) => rows.filter((r) => r.trade_date !== '2026-10-12');
  const h = holdout(FULL, { sealed: { [BASIC]: drop, [PRICES]: drop, 'adjustment_factor_observation_stock.csv': drop } });
  assert.throws(() => runner.holdoutDirCheck(h.dir, h.seal, MIN), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:prices_daily_stock\.csv:2026-10-12:0$/));
  const tail = adapter.csvDirSource(FIXTURE, { mode: 'LIVE', label: 'tail' });
  const c = runner.holdoutDirCheck(h.dir, h.seal, { ...MIN, priorSources: [tail] });
  assert.deepEqual(c.trade_dates.prior_sources, ['tail']);
  assert.ok(c.field_states_per_day.total_mv.min >= 20);
  const history = adapter.csvDirSource(FIXTURE, { mode: 'HISTORY', label: 'lane' });
  assert.throws(() => runner.holdoutDirCheck(h.dir, h.seal, { ...MIN, priorSources: [history] }), code(/HOLDOUT_INCOMPLETE:prices_daily_stock\.csv:2026-10-12:0$/), 'only LIVE sources feed the check');
});

test('补导的带日期后缀部分（封存之后只追加）也进字段下限：补导那天 total_mv 齐 → 过；补导那天 total_mv 全 MISSING → 拒', () => {
  const day = '2026-10-15';
  const rowsOf = (fn) => readRows(path.join(FIXTURE, BASIC)).filter((r) => r.trade_date === day).map((r) => { const v = JSON.parse(r.values); fn(v); return { ...r, values: JSON.stringify(v) }; });
  const without = (rows) => rows.filter((r) => r.trade_date !== day);
  const ok = holdout(FULL, { sealed: { [BASIC]: without }, appended: { 'market_daily_basic_observation_stock_20261020.csv': rowsOf(() => {}) } });
  assert.ok(runner.holdoutDirCheck(ok.dir, ok.seal, MIN).field_states_per_day.total_mv.min >= 20);
  const bad = holdout(FULL, { sealed: { [BASIC]: without }, appended: { 'market_daily_basic_observation_stock_20261020.csv': rowsOf((v) => { v.total_mv = MISSING; }) } });
  assert.throws(() => runner.holdoutDirCheck(bad.dir, bad.seal, MIN), code(/HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:total_mv:2026-10-15:0$/));
});

test('复审 P3-1：排除文件（HOLDOUT_FIELD_EXCLUSIONS_V1，sha 钉住）列出的（日, 字段）不判、写进结果；没有文件什么都不排除；total_mv 不许排除', () => {
  const ROUND = 'MR-CN_A-2026-11-2a1d2c9c82';
  const gap = holdout(FULL, { sealed: { [BASIC]: basicEdit((r, v) => { if (r.trade_date !== DAY) return false; v.turnover_rate_f = MISSING; return true; }) } });
  assert.throws(() => runner.holdoutDirCheck(gap.dir, gap.seal, MIN), code(/HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:turnover_rate_f:2026-10-14:0$/));
  const write = (body) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-hfx-')), 'x.json'); fs.writeFileSync(f, JSON.stringify(body)); return { f, sha: sha256(fs.readFileSync(f)) }; };
  const doc = (exclusions, round = ROUND) => ({ schema: runner.FIELD_EXCLUSIONS_SCHEMA, round_id: round, ruling: { path: 'artifacts/coordinator/SYNTHETIC_RULING.md', sha256: 'a'.repeat(64) }, exclusions });
  const good = write(doc([{ trade_date: DAY, field: 'turnover_rate_f', reason: 'collection timing' }]));
  const ex = runner.loadFieldExclusions(good.f, good.sha, ROUND);
  const c = runner.holdoutDirCheck(gap.dir, gap.seal, { ...MIN, fieldExclusions: ex });
  assert.deepEqual(c.field_states_per_day.turnover_rate_f.excluded_days, [DAY]);
  assert.deepEqual(c.field_exclusions, { sha256: good.sha, ruling: { path: 'artifacts/coordinator/SYNTHETIC_RULING.md', sha256: 'a'.repeat(64) }, pairs: [{ trade_date: DAY, field: 'turnover_rate_f', reason: 'collection timing' }] });
  assert.throws(() => runner.loadFieldExclusions(good.f, 'b'.repeat(64), ROUND), code(/MINE_RUNNER_FIELD_EXCLUSIONS_SHA_MISMATCH/));
  assert.throws(() => runner.loadFieldExclusions(good.f, good.sha, 'MR-CN_A-2026-11-e1ab63a27b'), code(/MINE_RUNNER_FIELD_EXCLUSIONS_INVALID/));
  const mv = write(doc([{ trade_date: DAY, field: 'total_mv', reason: 'x' }]));
  assert.throws(() => runner.loadFieldExclusions(mv.f, mv.sha, ROUND), code(/MINE_RUNNER_FIELD_EXCLUSION_NOT_ALLOWED:2026-10-14:total_mv/));
  const offDay = write(doc([{ trade_date: '2026-10-16', field: 'turnover_rate_f', reason: 'x' }]));
  assert.throws(() => runner.holdoutDirCheck(gap.dir, gap.seal, { ...MIN, fieldExclusions: runner.loadFieldExclusions(offDay.f, offDay.sha, ROUND) }), code(/MINE_RUNNER_FIELD_EXCLUSION_DAY_UNKNOWN:2026-10-16:turnover_rate_f/));
});
