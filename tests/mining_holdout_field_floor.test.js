'use strict';
/**
 * 留出段开启前的目录核对：逐日核 daily_basic 每个读数的取值状态，不只数行（独立复审第二轮，2026-11-18；协调会话：必须在打分之前合并）。
 * V6 的 daily_basic 有整天某个字段全是 MISSING 的日子（真实行夹具：2026-09-29、10-08、10-09 的 turnover_rate_f 与 dv_ttm 每只都 MISSING）；
 * 只数行的话这样的留出段照样过，开启就花掉了。先红后绿，用真实行夹具（tests/fixtures/mining-real-rows-20261118）当一个封存的留出段目录：
 *   - 每个 daily_basic 读数：每天可用（{ state, value } 按适配器的读法是有限数）的名字数 ≥ 封存那一份各日中位数的一半；封存那一份里一天都没有可用值 → 拒；
 *   - total_mv（市值中性化要用）另要 ≥ 每天的名字数下限。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'TEST_ROUND_RUNNER_AUTHORITY';
const runner = require('../services/mining-sandbox/round-runner');
const { forEachCsvRow } = require('../services/mining-sandbox/data-adapter/csv');

const FIXTURE = path.join(__dirname, 'fixtures', 'mining-real-rows-20261118');
const BASIC = 'market_daily_basic_observation_stock.csv';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** 真实行夹具的副本当留出段目录（可改 daily_basic），封存那一份 = 现在的 SHA256SUMS。 */
function holdout(segment, mutate = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-hff-'));
  for (const f of fs.readdirSync(FIXTURE)) if (f.endsWith('.csv') || f === 'SHA256SUMS') fs.copyFileSync(path.join(FIXTURE, f), path.join(dir, f));
  if (mutate) {
    const rows = []; forEachCsvRow(path.join(dir, BASIC), (r) => rows.push(r));
    const cols = Object.keys(rows[0]);
    rows.forEach((r, k) => { const v = JSON.parse(r.values); if (mutate(r, v, k)) r.values = JSON.stringify(v); });
    fs.writeFileSync(path.join(dir, BASIC), `${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')}\n`);
    const sums = path.join(dir, 'SHA256SUMS');
    fs.writeFileSync(sums, fs.readFileSync(sums, 'utf8').split('\n').map((l) => (l.endsWith(` ${BASIC}`) ? `${sha256(fs.readFileSync(path.join(dir, BASIC)))}  ${BASIC}` : l)).join('\n'));
  }
  fs.copyFileSync(path.join(dir, 'SHA256SUMS'), path.join(dir, 'SHA256SUMS.sealed'));
  return { dir, seal: { data_sha256: sha256(fs.readFileSync(path.join(dir, 'SHA256SUMS.sealed'))), segment } };
}
const FULL = { from: '2026-10-12', to: '2026-10-16' }; // 这几天七个字段都有
const MIN = { minNamesPerDay: 20 }; // 夹具每天二十几只

test('字段状态下限：七个字段都齐的几天过；结果里有每个字段逐日可用名字数（最少、中位、封存中位）', () => {
  const h = holdout(FULL);
  const c = runner.holdoutDirCheck(h.dir, h.seal, MIN);
  const keys = ['turnover_rate_f', 'total_mv', 'circ_mv', 'pe_ttm', 'pb', 'ps_ttm', 'dv_ttm'];
  assert.deepEqual(Object.keys(c.field_states_per_day).sort(), [...keys].sort());
  for (const k of keys) {
    const s = c.field_states_per_day[k];
    assert.ok(s.min > 0 && s.median >= s.min && s.sealed_median > 0, `${k} ${JSON.stringify(s)}`);
  }
  assert.ok(c.field_states_per_day.total_mv.min >= 20);
});

test('真实数据：2026-09-29 的 turnover_rate_f / dv_ttm 每只都 MISSING → 含这一天的留出段被拒（只数行会过）', () => {
  const h = holdout({ from: '2026-09-29', to: '2026-10-16' });
  assert.throws(() => runner.holdoutDirCheck(h.dir, h.seal, MIN), code(/MINE_RUNNER_HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:(turnover_rate_f|dv_ttm):2026-09-29:0$/));
});

test('total_mv：某一天每只都 MISSING 拒；某一天可用的不到名字数下限（仍 ≥ 中位数的一半）也拒', () => {
  const allGone = holdout(FULL, (r, v) => { if (r.trade_date === '2026-10-14') { v.total_mv = { state: 'MISSING', value: null }; return true; } return false; });
  assert.throws(() => runner.holdoutDirCheck(allGone.dir, allGone.seal, MIN), code(/HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:total_mv:2026-10-14:0$/));
  let n = 0;
  const someGone = holdout(FULL, (r, v) => { if (r.trade_date === '2026-10-14' && n < 10) { n += 1; v.total_mv = { state: 'MISSING', value: null }; return true; } return false; });
  assert.throws(() => runner.holdoutDirCheck(someGone.dir, someGone.seal, MIN), code(/HOLDOUT_FIELD_INCOMPLETE:market_daily_basic_observation_stock\.csv:total_mv:2026-10-14:1\d$/));
});

test('某个字段在封存那一份里一天都没有可用值 → 拒（中位数是 0 时相对下限不起作用）', () => {
  const h = holdout(FULL, (r, v) => { v.pb = { state: 'MISSING', value: null }; return true; });
  assert.throws(() => runner.holdoutDirCheck(h.dir, h.seal, MIN), code(/MINE_RUNNER_HOLDOUT_FIELD_EMPTY:market_daily_basic_observation_stock\.csv:pb$/));
});
