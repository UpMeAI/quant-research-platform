'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_SHA256, buildDocument, resolvedArms } = require('../tools/build-k2-arms-catalogue-v2');

const REVIEW = [
  ['OSV:QS-Q4', 'QUICK_SHOT_V3_1000USDT'],
  ['OSV:C17-N6', 'C17_V2_4000USDT'],
  ['OSV:US5-N5', 'US_V5_ETF_3000USD'],
  ['OSV:UC-U13-30M', 'US_CORE_9000USD_3X_GATEOBS'],
  ['OSV:UC-N1', 'US_CORE_9000USD_3X_GATEOBS'],
  ['OSV:US5-D5-V1', 'US_V5_ETF_3000USD'],
  ['OSV:US5-D5-V2', 'US_V5_ETF_3000USD'],
  ['OSV:C17-X05', 'C17_V2_4000USDT'],
  ['OSV:US5-R8', 'US_V5_ETF_3000USD'],
  ['OSV:C17-R8', 'C17_V2_4000USDT'],
  ['ASV:CN-R-ETF-1-A1', 'INDEX_BOOK'],
  ['ASV:CN-PVS-0', 'ASHARE_V6_PAPER'],
];

test('R-1111-ARMS resolves exactly the 12 REVIEW studies into 99 source-pinned arms', () => {
  const input = { schema: 'K2_ARMS_CATALOGUE_V1', studies: REVIEW.map(([study_ref, family_id]) => ({
    study_ref, family_id, status: 'REVIEW', review_reason: 'pending', k2_sha256: 'a'.repeat(64), k2_file: '/tmp/K2.md',
  })) };
  const before = JSON.stringify(input);
  const out = buildDocument(input, V1_SHA256);
  assert.equal(JSON.stringify(input), before, 'pinned input must not be mutated');
  assert.equal(out.schema, 'K2_ARMS_CATALOGUE_V2');
  assert.equal(out.supersedes_sha256, V1_SHA256);
  assert.equal(out.studies.filter((s) => s.status === 'REVIEW').length, 0);
  assert.equal(out.studies.reduce((n, s) => n + s.arms.length, 0), 99);
  assert.ok(out.studies.every((s) => s.ruling === 'R-1111-ARMS'));
});

test('mechanical combinations and inherited variants use the frozen duplicate hashes', () => {
  const n6 = resolvedArms({ study_ref: 'OSV:C17-N6', family_id: 'C17_V2_4000USDT' });
  assert.deepEqual(n6.find((a) => a.config_label === 'COMBINATION_NO_ADMISSION').rule_config,
    n6.find((a) => a.config_label === 'D_NOW').rule_config);

  const n1 = resolvedArms({ study_ref: 'OSV:UC-N1', family_id: 'US_CORE_9000USD_3X_GATEOBS' });
  assert.deepEqual(n1.find((a) => a.config_label === 'COMBINATION_E').rule_config,
    n1.find((a) => a.config_label === 'E_ONLY').rule_config);

  const v1 = resolvedArms({ study_ref: 'OSV:US5-D5-V1', family_id: 'US_V5_ETF_3000USD' });
  const v2 = resolvedArms({ study_ref: 'OSV:US5-D5-V2', family_id: 'US_V5_ETF_3000USD' });
  assert.deepEqual(v2.find((a) => a.config_label === 'T_NOK_V1_INHERITED').rule_config,
    v1.find((a) => a.config_label === 'T_NOK').rule_config);
  assert.deepEqual(v2.find((a) => a.config_label === 'LADDER_MIN_OF_BOTH').rule_config,
    v2.find((a) => a.config_label === 'C_V2').rule_config);
});

test('role rulings preserve N semantics: fills are STRESS and PVS rows are SIGNAL_TEST', () => {
  const fills = resolvedArms({ study_ref: 'OSV:UC-U13-30M', family_id: 'US_CORE_9000USD_3X_GATEOBS' });
  assert.equal(fills.length, 6);
  assert.ok(fills.every((a) => a.role === 'STRESS'));

  const pvs = resolvedArms({ study_ref: 'ASV:CN-PVS-0', family_id: 'ASHARE_V6_PAPER' });
  assert.equal(pvs.length, 11);
  assert.ok(pvs.every((a) => a.role === 'SIGNAL_TEST' && a.stage === 'SIGNAL'));

  const n5 = resolvedArms({ study_ref: 'OSV:US5-N5', family_id: 'US_V5_ETF_3000USD' });
  assert.equal(n5.length, 28);
  assert.equal(n5.filter((a) => a.config_label.includes('GRID_A_M_0_5')).length, 1, 'm*=0.5 is the grid point, not an extra arm');
});

test('wrong pinned input hash fails closed', () => {
  assert.throws(() => buildDocument({ schema: 'K2_ARMS_CATALOGUE_V1', studies: [] }, '0'.repeat(64)), /CATALOGUE_V1_SHA256_MISMATCH/);
});
