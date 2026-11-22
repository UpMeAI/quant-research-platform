'use strict';
/**
 * RF1116 修订「评分的市值中性化 V2」接线测试（补 tests/mining_size_neutralization_v2.test.js 的 T1–T8，那份是冻结的验收，不改）：
 *   N2 轮次清单写版本、openRound 不认识的版本拒；N4 逐候选记录按轮的版本读门槛文件（V2 → v2，第 1、2 轮 → v1），结果戳与轮不符就拒；
 *   N3 scoring.sizeExposure 的口径（手算）；第 8 项的码在门里、不在别处。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const AUTH = 'TEST_SIZE_V2_WIRING_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const rounds = require('../services/mining-rounds');
const records = require('../services/mining-rounds/gate-records');
const neutralization = require('../services/mining-rounds/neutralization');
const vault = require('../services/holdout-vault');
const scoring = require('../services/mining-sandbox/scoring');
const { R1, nextHoldout } = require('./_mining_manifest');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const GP = { mode: 'AI_MINED_GP', gp_seed: 3 };
let n = 0;
function openedRound(market, openedAt, extra = {}) {
  n += 1;
  const r = rounds.openRound({ market, space: { space_ref: `MS-W${n}`, sha256: sha(`s-${n}`), freeze: { path: `f-${n}`, sha256: sha(`f-${n}`) } }, holding_periods: [5], generator: GP,
    holdout: nextHoldout(rounds, market, { from: '2026-07-01', to: '2026-10-31' }), openedAt, ...R1, ...extra });
  const id = `${r.round_id}:C001`; const f = `rank(ts_mean(close,${n + 3}))`;
  rounds.recordCandidate(r.round_id, { candidate_id: id, formula_canonical: f, formula_sha256: sha(f), holding_period: 5, mining_score: 0 }, { registeredBy: AUTH, registeredAt: openedAt });
  vault.seal({ round_id: r.round_id, segment: r.holdout, data_ref: `lane:/w/${n}`, data_sha256: sha(`h-${n}`), sealedBy: 'VAULT' });
  vault.open({ round_id: r.round_id, candidate_ids: [id], openedBy: 'SELECTOR' });
  return { r, id };
}

test('N2 openRound：不给版本 → RANK_GAUSS_V2 写进清单；不认识的版本拒', () => {
  const { r } = openedRound('CN_A', '2027-02-02T02:00:00Z', { scoring_neutralization: undefined });
  assert.equal(rounds.roundHead(r.round_id).scoring_neutralization, 'RANK_GAUSS_V2');
  assert.equal(neutralization.neutralizationOf(rounds.roundHead(r.round_id)), 'RANK_GAUSS_V2');
  assert.throws(() => rounds.openRound({ market: 'US', space: { space_ref: 'MS-X', sha256: sha('x'), freeze: { path: 'f', sha256: sha('f') } }, holding_periods: [5], generator: GP,
    holdout: { from: '2026-07-01', to: '2026-10-31' }, openedAt: '2027-02-03T02:00:00Z', ...R1, scoring_neutralization: 'RANK_V9' }), /MINE_ROUND_NEUTRALIZATION_INVALID/);
});

test('N4 逐候选记录按轮的版本读门槛文件：V2 的轮读 v2（冻结页之前 PENDING_FREEZE → 只给 MINE_THRESHOLDS_UNFROZEN），V1 的轮读 v1；结果的戳与轮不符 → 拒', () => {
  const v2 = openedRound('CN_A', '2027-03-02T02:00:00Z', { scoring_neutralization: undefined });
  const a = records.recordGateResult({ round_id: v2.r.round_id, candidate_id: v2.id, candidate: { holdout: { neutralization: { version: 'RANK_GAUSS_V2' } } } });
  assert.deepEqual([a.thresholds_file.path, a.thresholds_used.state, a.thresholds_used.size_exposure_abs_max, a.codes], ['config/mining_gate_thresholds.v2.json', 'PENDING_FREEZE', 0.1, ['MINE_THRESHOLDS_UNFROZEN']]);
  const v1 = openedRound('US', '2027-03-03T02:00:00Z', { scoring_neutralization: 'LINEAR_RAW_V1' });
  const b = records.recordGateResult({ round_id: v1.r.round_id, candidate_id: v1.id, candidate: { holdout: { neutralization: { version: 'LINEAR_RAW_V1' } } } });
  assert.deepEqual([b.thresholds_file.path, b.thresholds_used.size_exposure_abs_max], ['config/mining_gate_thresholds.v1.json', undefined]);
  const v1b = openedRound('CRYPTO', '2027-03-04T02:00:00Z', { scoring_neutralization: 'LINEAR_RAW_V1' });
  assert.throws(() => records.recordGateResult({ round_id: v1b.r.round_id, candidate_id: v1b.id, candidate: { holdout: { neutralization: { version: 'RANK_GAUSS_V2' } } } }), /MINE_GATE_RECORD_NEUTRALIZATION_MISMATCH/);
});

test('N3 sizeExposure（手算）：值与 log 市值同序 → +1，反序 → −1；只数池里、值与前推收益都有限、市值 > 0 的名字；少于 MIN_NAMES 的日子不算；days 是算得出的天数', () => {
  const N = scoring.MIN_NAMES + 4; const T = 4;
  const size = Array.from({ length: T }, () => Array.from({ length: N }, (_, j) => Math.exp(10 + j)));
  const universe = Array.from({ length: T }, () => Array.from({ length: N }, () => true));
  const fwd = Array.from({ length: T }, () => Array.from({ length: N }, () => 0.01));
  const up = Array.from({ length: T }, () => Array.from({ length: N }, (_, j) => j));
  const down = up.map((r) => r.map((v) => -v));
  const panel = { size, universe };
  const e1 = scoring.sizeExposure(up, panel, fwd, [0, 1, 2], 'RANK_GAUSS_V2');
  assert.equal(e1.statistic, 'MEAN_DAILY_SPEARMAN_VS_LOG_TOTAL_MV');
  assert.ok(Math.abs(e1.value - 1) < 1e-12);
  assert.deepEqual([e1.days, e1.neutralization_version], [3, 'RANK_GAUSS_V2']);
  assert.ok(Math.abs(scoring.sizeExposure(down, panel, fwd, [0, 1, 2], 'RANK_GAUSS_V2').value + 1) < 1e-12);
  const thin = up.map((r, t) => (t === 1 ? r.map((v, j) => (j < 3 ? v : NaN)) : r));
  assert.equal(scoring.sizeExposure(thin, panel, fwd, [0, 1, 2], 'RANK_GAUSS_V2').days, 2);
  assert.deepEqual(scoring.sizeExposure(up, panel, fwd, [], 'RANK_GAUSS_V2'), { statistic: 'MEAN_DAILY_SPEARMAN_VS_LOG_TOTAL_MV', value: null, days: 0, neutralization_version: 'RANK_GAUSS_V2' });
});
