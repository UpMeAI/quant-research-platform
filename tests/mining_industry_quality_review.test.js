'use strict';
/**
 * 独立复审（2026-11-18，REVIEW.md 12a23861）M-4 与 L-6，接 ★RF1116_INDUSTRY_QUALITY (a)。先红后绿，合成数据：
 *   - M-4：面板清单记行业成员按质量的行数（by_quality）与被滤掉的行数（quality_skipped），并写明这份行业数据的局限
 *     （industry_limits：单一来源、没有第二来源核对；SW2021 的成员回溯到上市日，2021 年之前的分类是事后重述的历史）；
 *   - L-6：其余各表仍只收 READY：日线、复权因子、daily_basic、证券主表、停牌、交易日历里写成 DEGRADED 的行都不用。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'TEST_ROUND_RUNNER_AUTHORITY';
const { makeMiningDataFixture } = require('./_mining_data_fixture');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const segs = require('../services/mining-sandbox/segments');
const { forEachCsvRow } = require('../services/mining-sandbox/data-adapter/csv');

const panelOf = (dirs) => adapter.buildPanel({ sources: [adapter.csvDirSource(dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(dirs.tail, { mode: 'LIVE', label: 'tail' })],
  space: runner.loadFrozenSpace().space, segment: 'MINING', from: segs.SEGMENTS.MINING.from, to: segs.SEGMENTS.MINING.to });
const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-iqr-')));
const base = panelOf(fx.dirs);

/** 读一张 CSV（同适配器的读法），把 pred 为真的行的 quality_state 改成 DEGRADED，按 RFC 4180 写回副本。返回改了几行。 */
const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function degrade(dir, file, pred) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return 0;
  const rows = []; forEachCsvRow(p, (r) => rows.push(r));
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]); let n = 0;
  const lines = [cols.join(','), ...rows.map((r) => { if (pred(r)) { r.quality_state = 'DEGRADED'; n += 1; } return cols.map((c) => cell(r[c])).join(','); })];
  fs.writeFileSync(p, `${lines.join('\n')}\n`);
  // 副本的 SHA256SUMS 跟着改（适配器逐文件核 sha）
  const sums = path.join(dir, 'SHA256SUMS'); const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  fs.writeFileSync(sums, fs.readFileSync(sums, 'utf8').split('\n').map((l) => (l.endsWith(` ${file}`) || l.endsWith(`*${file}`) ? `${sha}  ${file}` : l)).join('\n'));
  return n;
}
/** 夹具目录的副本，在两个目录里都改同一张表。 */
function variant(file, pred) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-iqr-v-'));
  const dirs = {}; let n = 0;
  for (const k of ['lane', 'tail']) { dirs[k] = path.join(root, k); fs.cpSync(fx.dirs[k], dirs[k], { recursive: true }); n += degrade(dirs[k], file, pred); }
  assert.ok(n > 0, `${file}: some rows were degraded`);
  return panelOf(dirs);
}
const X = base.codes.find((c, j) => base.universe.some((row) => row[j])); // 一只在池里待过的股票
const jX = base.codes.indexOf(X);

test('M-4 面板清单：行业成员按质量的行数、被滤掉的行数，与局限 industry_limits', () => {
  const c = base.manifest.counts.industry;
  assert.ok(c.by_quality && c.by_quality.DEGRADED > 0 && c.by_quality.DEGRADED === c.rows, JSON.stringify(c));
  assert.equal(c.by_quality.READY, 0);
  assert.equal(c.quality_skipped, 0);
  assert.deepEqual(base.manifest.industry_limits, ['SINGLE_SOURCE_NOT_RECONCILED', 'HISTORY_BACKDATED_BY_SOURCE', 'END_DATE_INCLUSIVE_V6_READS_EXCLUSIVE']);
  assert.equal(base.manifest.rules.industry_effective_to, 'INCLUSIVE');
  const conflict = panelOf(makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-iqr-c-')), { industryQuality: 'CONFLICT' }).dirs);
  assert.equal(conflict.manifest.counts.industry.rows, 0);
  assert.ok(conflict.manifest.counts.industry.quality_skipped > 0, 'refused rows are counted');
  assert.deepEqual(conflict.manifest.industry_limits, [], 'no industry row used: nothing to disclose');
  const ready = panelOf(makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-iqr-r-')), { industryQuality: 'READY' }).dirs);
  assert.deepEqual(ready.manifest.industry_limits, ['HISTORY_BACKDATED_BY_SOURCE', 'END_DATE_INCLUSIVE_V6_READS_EXCLUSIVE'], 'READY rows: not single-source; still backdated before 2021; end dates read inclusive'); 
});

test('L-6 日线写成 DEGRADED 的行不用（quality_skipped 增加，那只的后复权收盘价全是 NaN）', () => {
  const p = variant('prices_daily_stock.csv', (r) => r.security_id === X);
  assert.ok(p.manifest.counts.prices_daily.quality_skipped > base.manifest.counts.prices_daily.quality_skipped);
  const j = p.codes.indexOf(X);
  assert.ok(j < 0 || p.readings.close_hfq.every((row) => !Number.isFinite(row[j])), 'no close for the degraded name');
});

test('L-6 复权因子写成 DEGRADED 的行不用', () => {
  const p = variant('adjustment_factor_observation_stock.csv', (r) => r.security_id === X);
  assert.ok(p.manifest.counts.adj_factor.quality_skipped > base.manifest.counts.adj_factor.quality_skipped);
});

test('L-6 daily_basic 写成 DEGRADED 的行不用（那只的 pb 全是 NaN）', () => {
  const p = variant('market_daily_basic_observation_stock.csv', (r) => r.security_id === X);
  assert.ok(p.manifest.counts.daily_basic.quality_skipped > base.manifest.counts.daily_basic.quality_skipped);
  const j = p.codes.indexOf(X);
  assert.ok(j < 0 || p.readings.pb.every((row) => !Number.isFinite(row[j])));
});

test('L-6 证券主表写成 DEGRADED 的行不用（那只不进股票池）', () => {
  const p = variant('security_master_stock.csv', (r) => r.security_id === X);
  const j = p.codes.indexOf(X);
  assert.ok(j < 0 || p.universe.every((row) => !row[j]), 'never in the universe');
  assert.ok(base.universe.some((row) => row[jX]), 'it was in the universe before');
});

test('L-6 停牌写成 DEGRADED 的行不用；交易日历写成 DEGRADED 的那天不是开市日', () => {
  const susp = []; forEachCsvRow(path.join(fx.dirs.tail, 'security_suspension_observation.csv'), (r) => susp.push(r));
  forEachCsvRow(path.join(fx.dirs.lane, 'security_suspension_observation.csv'), (r) => susp.push(r));
  const s = susp.find((r) => r.suspension_type === 'S' && base.dates.includes(r.trade_date));
  assert.ok(s, 'the fixture has an in-segment suspension');
  const p = variant('security_suspension_observation.csv', (r) => r.security_id === s.security_id && r.trade_date === s.trade_date);
  assert.ok(p.manifest.counts.suspension.rows < base.manifest.counts.suspension.rows);
  const D = base.dates[Math.floor(base.dates.length / 2)];
  const c = variant('trading_calendar.csv', (r) => r.calendar_date === D);
  assert.ok(!c.dates.includes(D) && base.dates.includes(D), `${D} is not an open day once its calendar rows are DEGRADED`);
});
