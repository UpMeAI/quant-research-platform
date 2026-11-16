'use strict';
/**
 * 协调会话裁定（2026-11-17）：挖掘沙箱只用历史数据、按 P-14 次日开盘决策，所以挖掘空间的读数在有 pitHistoricalClock 的数据集上
 * 必须声明历史时钟（rule、bySeries[series]，或多序列取最保守的那个）；声明实时 PIT（例如两个 V6 股票数据集的 OBSERVED_AT）→
 * MINE_SPACE_READING_LIVE_CLOCK_IN_HISTORY。没有 pitHistoricalClock 的数据集照旧收实时 PIT。先红后绿，用真钉着的 1.14.0。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const space = require('../services/mining-sandbox/space');

const ROOT = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const EVIDENCE = fs.readFileSync(path.join(ROOT, 'docs', 'evidence', 'mining-operators-v1', 'CAUSALITY_EVIDENCE_V1.json'));
const PROOF = { evidence: JSON.parse(EVIDENCE), evidenceBytes: EVIDENCE };
const spaceOf = (readings) => Buffer.from(JSON.stringify({ schema: 'MINING_SPACE_V1', space_ref: 'MS-HISTORY-ONLY', market: 'CN_A', readings,
  operators: ['rank'], constants: [1], lookbacks: [5], holding_periods: [5], max_tokens: 20, max_depth: 5,
  operator_evidence: { path: 'docs/evidence/mining-operators-v1/CAUSALITY_EVIDENCE_V1.json', sha256: sha(EVIDENCE) } }));
const ok = (r) => space.parseSpace(spaceOf([r]), PROOF);

test('有历史时钟的数据集：读数声明实时 PIT → LIVE_CLOCK_IN_HISTORY；声明历史时钟 → 过；没有历史时钟的数据集照旧收实时 PIT', () => {
  const basic = { name: 'turnover_f', dataset_id: 'V6_CN_STOCK_DAILY_BASIC' };
  assert.throws(() => ok({ ...basic, pit_available_at: 'OBSERVED_AT (ingest instant)' }), code(/MINE_SPACE_READING_LIVE_CLOCK_IN_HISTORY:turnover_f:OBSERVED_AT.*CLOSE_DATED_NEXT_OPEN_USABLE/));
  assert.equal(ok({ ...basic, pit_available_at: 'CLOSE_DATED_NEXT_OPEN_USABLE (backfill convention)' }).readings[0].name, 'turnover_f');
  assert.equal(ok({ name: 'csi', dataset_id: 'V6_CSI300_INDEX_DAILY', pit_available_at: 'OBSERVED_AT (no historical clock registered)' }).readings[0].name, 'csi');
  const hfq = { name: 'close_hfq', dataset_id: 'V6_CN_STOCK_DAILY_BARS', series: ['daily', 'adj_factor'] };
  assert.throws(() => ok({ ...hfq, pit_available_at: 'OBSERVED_AT (live ingest)' }), code(/MINE_SPACE_READING_LIVE_CLOCK_IN_HISTORY:close_hfq/));
  assert.throws(() => ok({ name: 'ret_1d', dataset_id: 'V6_CN_STOCK_DAILY_BARS', pit_available_at: 'OBSERVED_AT' }), code(/MINE_SPACE_READING_LIVE_CLOCK_IN_HISTORY:ret_1d/));
  assert.equal(ok({ ...hfq, pit_available_at: 'CLOSE_DATED_NEXT_OPEN_USABLE' }).readings[0].name, 'close_hfq');
  assert.throws(() => ok({ ...hfq, pit_available_at: 'BAR_CLOSE' }), code(/MINE_SPACE_READING_PIT_MISMATCH:close_hfq:BAR_CLOSE≠CLOSE_DATED_NEXT_OPEN_USABLE/));
});

const COORDINATOR_DIR = path.resolve(process.env.QRP_COORDINATOR_DIR || path.join(ROOT, '..', 'artifacts', 'coordinator'));
const DRAFT_3 = path.join(COORDINATOR_DIR, 'MINING_SPACE_V1_CN_A_R1.draft.bee978ed.json');
const DRAFT_4_SHA = '0d3556fa97f17d3a67b350e7f74c12fb521ca1fb60c293121601f7eb95f96637';
// DRAFT_4 的只读副本（按 sha 命名）
const DRAFT_4 = path.join(COORDINATOR_DIR, `MINING_SPACE_V1_CN_A_R1.draft.${DRAFT_4_SHA.slice(0, 8)}.json`);

test('空间草稿：DRAFT_3（全是 OBSERVED_AT）被拒（LIVE_CLOCK_IN_HISTORY）；DRAFT_4（历史时钟）过', { skip: fs.existsSync(DRAFT_3) && fs.existsSync(DRAFT_4) ? false : '协调会话目录里没有 DRAFT_3 / DRAFT_4' }, () => {
  assert.equal(sha(fs.readFileSync(DRAFT_3)), 'bee978ed5d1f98460dab2914cd9a6aedc14413301f92e89cb62865ffa258a16b');
  assert.throws(() => space.parseSpace(fs.readFileSync(DRAFT_3), PROOF), code(/MINE_SPACE_READING_LIVE_CLOCK_IN_HISTORY:close_hfq/));
  const bytes = fs.readFileSync(DRAFT_4);
  assert.equal(sha(bytes), DRAFT_4_SHA);
  const s = space.parseSpace(bytes, PROOF);
  assert.equal(s.space_ref, 'MINING_SPACE_V1:CN_A:R1:DRAFT_4');
  assert.deepEqual([...new Set(s.readings.map((r) => r.pit_available_at.split(' ')[0]))].sort(), ['BAR_CLOSE', 'CLOSE_DATED_NEXT_OPEN_USABLE']);
});
