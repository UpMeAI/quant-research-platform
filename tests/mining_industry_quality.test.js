'use strict';
/**
 * ★RF1116_INDUSTRY_QUALITY（第 1 轮缺陷的数据原因，2026-11-18）：V6 把每一行行业成员都写成 DEGRADED
 * （Ashare-V6 src/data-runtime/canonicalize.js:460，sourceReconciliationState PRIMARY_ONLY，单一来源 Tushare index_member_all），
 * 车道副本与验证尾段也都是 100% DEGRADED。面板的行业成员收 READY 与 DEGRADED；其余各表仍只收 READY；面板清单写明。先红后绿，合成数据。
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
const ready = panelOf(makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-iq-ready-')), { industryQuality: 'READY' }));
const v6 = panelOf(makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-iq-v6-')), { industryQuality: 'DEGRADED' }));

test('行业成员收 DEGRADED（V6 的每一行都是）：与 READY 的面板逐格相同，金丝雀算得出分', () => {
  assert.ok(v6.manifest.counts.industry.rows > 0, 'DEGRADED industry rows enter the panel');
  assert.equal(v6.manifest.counts.industry.rows, ready.manifest.counts.industry.rows);
  assert.deepEqual(v6.industry, ready.industry, 'same industries cell by cell');
  const c = runner.checkCanary(v6, { min_names_per_day: 5 }); // 合成数据只有十几只（生产下限 2,000）
  assert.ok(Number.isFinite(c.formulas[0].score) && c.formulas[0].ic_days >= c.min_ic_days);
});

test('面板清单写明行业成员收的质量；其余各表仍只收 READY', () => {
  assert.deepEqual(v6.manifest.rules.accepted_quality, ['READY']);
  assert.deepEqual(v6.manifest.rules.industry_accepted_quality, ['READY', 'DEGRADED']);
  const conflict = panelOf(makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-iq-conflict-')), { industryQuality: 'CONFLICT' }));
  assert.equal(conflict.manifest.counts.industry.rows, 0, 'CONFLICT (or anything else) is still refused');
});
