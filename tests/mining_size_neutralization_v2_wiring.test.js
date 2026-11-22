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
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTH = 'TEST_SIZE_V2_WIRING_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const rounds = require('../services/mining-rounds');
const records = require('../services/mining-rounds/gate-records');
const neutralization = require('../services/mining-rounds/neutralization');
const vault = require('../services/holdout-vault');
const gate = require('../services/mining-gate');
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

/** 记一条空记录再关轮（释放这个市场的开轮名额）。 */
const finish = (r, id) => { records.recordGateResult({ round_id: r.round_id, candidate_id: id, candidate: {} }); rounds.closeRound(r.round_id); };

test('N2 openRound：不给版本 → RANK_GAUSS_V2 写进清单；不认识的版本拒', () => {
  const { r, id } = openedRound('CN_A', '2027-02-02T02:00:00Z', { scoring_neutralization: undefined });
  assert.equal(rounds.roundHead(r.round_id).scoring_neutralization, 'RANK_GAUSS_V2');
  finish(r, id);
  assert.equal(neutralization.neutralizationOf(rounds.roundHead(r.round_id)), 'RANK_GAUSS_V2');
  assert.throws(() => rounds.openRound({ market: 'US', space: { space_ref: 'MS-X', sha256: sha('x'), freeze: { path: 'f', sha256: sha('f') } }, holding_periods: [5], generator: GP,
    holdout: { from: '2026-07-01', to: '2026-10-31' }, openedAt: '2027-02-03T02:00:00Z', ...R1, scoring_neutralization: 'RANK_V9' }), /MINE_ROUND_NEUTRALIZATION_INVALID/);
});

test('N4 逐候选记录按轮的版本读门槛文件：V2 的轮读 v2（FREEZE_2 之后 FROZEN，冻结页核对通过，九项都跑），V1 的轮读 v1；结果的戳与轮不符 → 拒', () => {
  const v2 = openedRound('CN_A', '2027-03-02T02:00:00Z', { scoring_neutralization: undefined });
  const a = records.recordGateResult({ round_id: v2.r.round_id, candidate_id: v2.id, candidate: { holdout: { neutralization: { version: 'RANK_GAUSS_V2' } } } });
  assert.deepEqual([a.thresholds_file.path, a.thresholds_used.state, a.thresholds_used.size_exposure_abs_max], ['config/mining_gate_thresholds.v2.json', 'FROZEN', 0.1]);
  assert.ok(!a.codes.some((c) => c.startsWith('MINE_THRESHOLDS_')) && a.codes.includes('MINE_DSR_UNKNOWN'), 'frozen page check passes; the items run and fail closed on the empty result');
  rounds.closeRound(v2.r.round_id);
  const v1 = openedRound('US', '2027-03-03T02:00:00Z', { scoring_neutralization: 'LINEAR_RAW_V1' });
  const b = records.recordGateResult({ round_id: v1.r.round_id, candidate_id: v1.id, candidate: { holdout: { neutralization: { version: 'LINEAR_RAW_V1' } } } });
  assert.deepEqual([b.thresholds_file.path, b.thresholds_used.size_exposure_abs_max], ['config/mining_gate_thresholds.v1.json', undefined]);
  rounds.closeRound(v1.r.round_id);
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

test('N2 口子：新开的轮只能是 RANK_GAUSS_V2；不在名单里的轮写 LINEAR_RAW_V1，除非测试的环境开关，否则 openRound 拒、neutralizationOf 不认', () => {
  const flag = process.env.QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION;
  delete process.env.QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION;
  try {
    assert.throws(() => rounds.openRound({ market: 'US', space: { space_ref: 'MS-L', sha256: sha('l'), freeze: { path: 'f', sha256: sha('f') } }, holding_periods: [5], generator: GP,
      holdout: { from: '2026-07-01', to: '2026-10-31' }, openedAt: '2027-04-03T02:00:00Z', ...R1, scoring_neutralization: 'LINEAR_RAW_V1' }), /MINE_ROUND_NEUTRALIZATION_INVALID/);
    assert.throws(() => neutralization.neutralizationOf({ round_id: 'MR-CN_A-2027-04-0123456789', scoring_neutralization: 'LINEAR_RAW_V1' }), /MINE_RUNNER_NEUTRALIZATION_UNKNOWN/);
    assert.equal(neutralization.neutralizationOf({ round_id: 'MR-CN_A-2026-11-2a1d2c9c82' }), 'LINEAR_RAW_V1');
  } finally { if (flag !== undefined) process.env.QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION = flag; }
});

/** 合成的 FROZEN v2 门槛文件 + 合成冻结页（页里写着 FROZEN 与七个数）。 */
function frozenV2({ omitFromPage = null, patch = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'size-v2-root-'));
  fs.mkdirSync(path.join(root, 'docs', 'freeze'), { recursive: true });
  const vals = { ic_mean_min: 0.02, icir_min: 0.3, monotonicity_min: 0.9, decay_ratio_min: 0.5, marginal_ir_delta_min: 0, marginal_intercept_t_min: 2, size_exposure_abs_max: 0.1 };
  const body = `# synthetic FREEZE_2\n\n状态：**FROZEN。**\n\n${Object.entries(vals).filter(([k]) => k !== omitFromPage).map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n')}\n`;
  const rel = 'docs/freeze/SYNTHETIC_FREEZE_2.md';
  fs.writeFileSync(path.join(root, rel), body);
  const doc = { ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'mining_gate_thresholds.v2.json'), 'utf8')), state: 'FROZEN', frozen_ref: { path: rel, sha256: sha(body) }, ...patch };
  const file = path.join(root, 'mining_gate_thresholds.v2.json'); fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
  return { root, file, doc };
}
const goodResult = (id, exposure) => ({ candidate_id: id, factor_id: id, market: 'CN_A', holdout: { neutralization: { industry: 'APPLIED', size: 'APPLIED', version: 'RANK_GAUSS_V2' } },
  size_exposure: { statistic: 'MEAN_DAILY_SPEARMAN_VS_LOG_TOTAL_MV', value: exposure, days: 40, neutralization_version: 'RANK_GAUSS_V2' } });

test('N3/N4 记录路径（FROZEN v2、合成冻结页）：V2 的结果暴露 0.03 → 第 8 项没有市值码；0.5 → MINE_SIZE_EXPOSURE_ABOVE_MAX；没有 size_exposure → _UNKNOWN；冻结页核对过', () => {
  const t = frozenV2();
  const one = (exposure) => {
    const { r, id } = openedRound('CN_A', `2027-0${5 + (n % 3)}-0${(n % 8) + 1}T02:00:00Z`, { scoring_neutralization: undefined });
    const cand = goodResult(id, exposure); if (exposure === undefined) delete cand.size_exposure;
    const rec = gate.internals.withFreezeRoot(t.root, () => records.internals.withThresholdsFile(t.file, () => records.recordGateResult({ round_id: r.round_id, candidate_id: id, candidate: cand })));
    rounds.closeRound(r.round_id);
    return rec;
  };
  const codes = (rec) => rec.codes.filter((c) => /^MINE_SIZE_EXPOSURE_/.test(c));
  const ok = one(0.03);
  assert.deepEqual([ok.thresholds_file.path === undefined, ok.thresholds_used.state, ok.thresholds_used.size_exposure_abs_max, codes(ok), ok.codes.includes('MINE_THRESHOLDS_FREEZE_REF_INVALID')], [false, 'FROZEN', 0.1, [], false]);
  assert.deepEqual(codes(one(0.5)), ['MINE_SIZE_EXPOSURE_ABOVE_MAX']);
  assert.deepEqual(codes(one(undefined)), ['MINE_SIZE_EXPOSURE_UNKNOWN']);
});

test('冻结页核对覆盖 size_exposure_abs_max：页里少了这一行 → PAGE_VALUE_MISSING:size_exposure_abs_max；块里这个数不是有限数 → MINE_THRESHOLDS_INVALID；缺了这个数的 V2 候选 → 第 8 项 UNKNOWN', () => {
  const good = frozenV2();
  const block = (t) => ({ ...t.doc });
  gate.internals.withFreezeRoot(good.root, () => assert.equal(gate.verifyFreezeRef(block(good)), null));
  const missing = frozenV2({ omitFromPage: 'size_exposure_abs_max' });
  gate.internals.withFreezeRoot(missing.root, () => assert.equal(gate.verifyFreezeRef(block(missing)), 'PAGE_VALUE_MISSING:size_exposure_abs_max'));
  const bad = block(good); bad.size_exposure_abs_max = 'lenient';
  assert.deepEqual(gate.evaluate(goodResult('X', 0.03), { thresholds: bad, familyTrialCount: 1 }).codes, ['MINE_THRESHOLDS_INVALID']);
  const noKey = block(good); delete noKey.size_exposure_abs_max;
  const r = gate.evaluate(goodResult('X', 0.03), { thresholds: noKey, familyTrialCount: 1 });
  assert.deepEqual(r.items.find((i) => i.item === 8).codes.filter((c) => /^MINE_SIZE_EXPOSURE_/.test(c)), ['MINE_SIZE_EXPOSURE_UNKNOWN']);
});

test('执行器启动拒绝带着测试口子 QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION（生产没有这个口子）', () => {
  const runner = require('../services/mining-sandbox/round-runner');
  const flag = process.env.QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION;
  process.env.QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION = '1';
  try { assert.throws(() => runner.start({ outDir: os.tmpdir() }), /MINE_RUNNER_TEST_SEAM_SET/); } finally { if (flag === undefined) delete process.env.QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION; else process.env.QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION = flag; }
});
