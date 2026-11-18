'use strict';
/**
 * 第 1 轮的第二个数据原因（2026-11-18 车道探针）：V6 的 market_daily_basic_observation.values 每个字段是 { state, value }，
 * 适配器原来 Number(对象) → NaN，七个 daily_basic 读数（含市值 total_mv）全是 NaN，市值中性化把每个值都变成 NaN。先红后绿，合成数据：
 *   - V6 形状与裸数形状的同一份夹具：七个读数与市值逐格相同；PRESENT 取值、ZERO 取 0、MISSING 是 NaN 并计入 counts.daily_basic.value_missing；
 *   - V6 形状的夹具上金丝雀算得出分。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'TEST_ROUND_RUNNER_AUTHORITY';
const { makeMiningDataFixture } = require('./_mining_data_fixture');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const segs = require('../services/mining-sandbox/segments');

const panelOf = (fx) => adapter.buildPanel({ sources: [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })],
  space: runner.loadFrozenSpace().space, segment: 'MINING', from: segs.SEGMENTS.MINING.from, to: segs.SEGMENTS.MINING.to });
const flat = panelOf(makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-dbs-flat-')), { basicShape: 'FLAT' }));
const v6 = panelOf(makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-dbs-v6-')), { basicShape: 'V6' }));
const BASIC = ['turnover_f', 'total_mv', 'circ_mv', 'pe_ttm', 'pb', 'ps_ttm', 'dv_ttm'];
const finiteCells = (m) => m.reduce((n, row) => n + row.filter(Number.isFinite).length, 0);

test('V6 的 { state, value } 形状：七个 daily_basic 读数与市值和裸数形状逐格相同，且真有数', () => {
  for (const k of BASIC) {
    const name = Object.keys(v6.readings).find((r) => r === k) || k;
    if (v6.readings[name]) {
      assert.ok(finiteCells(v6.readings[name]) > 0, `${k}: some finite cells`);
      assert.deepEqual(v6.readings[name].map((row) => row.map((x) => (Number.isFinite(x) ? x : null))), flat.readings[name].map((row) => row.map((x) => (Number.isFinite(x) ? x : null))), k);
    }
  }
  assert.ok(finiteCells(v6.size) > 0, 'size (total_mv) has finite cells');
  assert.deepEqual(v6.size.map((row) => row.map((x) => (Number.isFinite(x) ? x : null))), flat.size.map((row) => row.map((x) => (Number.isFinite(x) ? x : null))));
});

test('V6 形状：MISSING 字段计入 counts.daily_basic.value_missing（与裸数形状的空值同数）；金丝雀算得出分', () => {
  assert.equal(typeof v6.manifest.counts.daily_basic.value_missing, 'number');
  assert.equal(v6.manifest.counts.daily_basic.value_missing, flat.manifest.counts.daily_basic.value_missing);
  const c = runner.checkCanary(v6, { min_names_per_day: 5 });
  assert.ok(Number.isFinite(c.formulas[0].score) && c.formulas[0].min_share >= 0.9, JSON.stringify(c.formulas[0]));
});
