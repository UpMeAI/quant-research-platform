'use strict';
/**
 * ★e 门槛 FROZEN（RF1116 §3.6；协调会话 2026-11-17：草稿 PR，Owner 答复 ★H1/★H2/★K 之后才转 ready，与空间、留出段一起冻结）。先红后绿。
 *   - config/mining_gate_thresholds.v1.json：state FROZEN，六个数不变；frozen_ref.path 指向仓库里的冻结页副本
 *     docs/freeze/RF1116_GMINE_THRESHOLDS_FREEZE_1.md（字节与协调会话签发的页一致；签发之前是草稿 6584693f 的字节，PLACEHOLDER），
 *     coordinator_path 写协调会话那一页的路径。
 *   - 冻结页核对（每台机器一样，不读协调目录）：FROZEN 时仓库里那一页要在、sha256 等于 frozen_ref.sha256、页里写着 FROZEN 和这六个数；
 *     否则 MINE_THRESHOLDS_FREEZE_REF_INVALID。草稿占位写的是 DRAFT → 被拒（正确：草稿不能放行）。
 *   - 门默认读文件时、逐候选记录（权威路径）都核这一页；单元测试自带门槛块的 evaluate 不核（ctx.checkFreeze 才核）。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTH = 'TEST_MINING_GATE_FREEZE_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const gate = require('../services/mining-gate');
const records = require('../services/mining-rounds/gate-records');
const rounds = require('../services/mining-rounds');
const vault = require('../services/holdout-vault');

const ROOT = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const CONFIG = path.join(ROOT, 'config', 'mining_gate_thresholds.v1.json');
const PAGE = 'docs/freeze/RF1116_GMINE_THRESHOLDS_FREEZE_1.md';
const DRAFT_SHA = '6584693fea54f028153c7cda697a0b3d03329d26dc967122993fc5c026de838b';
const VALUES = { ic_mean_min: 0.02, icir_min: 0.3, monotonicity_min: 0.9, decay_ratio_min: 0.5, marginal_intercept_t_min: 2, marginal_ir_delta_min: 0 };

/** 合成的冻结页（FROZEN + 六个数）放在一个临时「仓库根」下的 docs/freeze/；返回根与 sha。 */
function syntheticRoot(values = VALUES, { frozen = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmine-freeze-'));
  fs.mkdirSync(path.join(root, 'docs', 'freeze'), { recursive: true });
  const body = `# RF1116 · G-MINE ★e · FREEZE_1 (synthetic)\n\n状态：**${frozen ? 'FROZEN' : 'DRAFT'}。**\n\n| 项 | 值 |\n|---|---|\n${Object.entries(values).map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n')}\n`;
  fs.writeFileSync(path.join(root, PAGE), body);
  return { root, sha: sha(Buffer.from(body)) };
}
const configWith = (patch) => {
  const doc = { ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')), ...patch };
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gmine-thr-')), 'mining_gate_thresholds.v1.json');
  fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
  return p;
};
const thresholdsOf = (file) => { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return { ...d }; };

test('仓库里的门槛文件：FROZEN，六个数不变，frozen_ref 指向仓库里的冻结页副本（现在是草稿 6584693f 的字节，PLACEHOLDER）', () => {
  const doc = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(doc.state, 'FROZEN');
  for (const [k, v] of Object.entries(VALUES)) assert.equal(doc[k], v, k);
  assert.deepEqual([doc.frozen_ref.path, doc.frozen_ref.sha256, doc.frozen_ref.coordinator_path], [PAGE, DRAFT_SHA, 'artifacts/coordinator/RF1116_GMINE_THRESHOLDS_FREEZE_1.md']);
  assert.equal(sha(fs.readFileSync(path.join(ROOT, PAGE))), DRAFT_SHA);
  assert.equal(gate.THRESHOLDS.state, 'FROZEN');
});

test('草稿占位被拒：页在、sha 对，但写的是 DRAFT 不是 FROZEN → MINE_THRESHOLDS_FREEZE_REF_INVALID（PAGE_NOT_FROZEN）；门与逐候选记录都失败即关', () => {
  assert.equal(gate.verifyFreezeRef(gate.THRESHOLDS), 'PAGE_NOT_FROZEN');
  const r = gate.evaluate({ candidate_id: 'X' });
  assert.deepEqual([r.pass, r.codes, r.thresholds.freeze_check], [false, ['MINE_THRESHOLDS_FREEZE_REF_INVALID'], 'PAGE_NOT_FROZEN']);
});

test('合成的 FROZEN 页：sha 对、写着 FROZEN 与六个数 → 门按这六个数判；逐候选记录写下这些数与门槛文件的 sha', () => {
  const s = syntheticRoot();
  const cfg = configWith({ frozen_ref: { path: PAGE, sha256: s.sha, coordinator_path: 'synthetic' } });
  const t = thresholdsOf(cfg);
  gate.internals.withFreezeRoot(s.root, () => {
    assert.equal(gate.verifyFreezeRef(t), null);
    const r = gate.evaluate({ candidate_id: 'X', holdout: { ic_mean: 0.019 } }, { thresholds: t, checkFreeze: true, familyTrialCount: 1, marks: [] });
    assert.equal(r.codes.includes('MINE_THRESHOLDS_FREEZE_REF_INVALID'), false);
    assert.equal(r.items.length, 9); // 九项都判了
    assert.ok(r.codes.includes('MINE_IC_BELOW_MIN')); // 0.019 < 0.02
  });
  // 逐候选记录（权威路径）：用这份文件、这一页
  const sha8 = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
  const r0 = rounds.openRound({ market: 'CN_A', space: { space_ref: 'MS-F', sha256: sha8('s'), freeze: { path: 'f', sha256: sha8('f') } }, holding_periods: [5],
    generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, holdout: { from: '2026-07-01', to: '2026-10-31' }, openedAt: '2027-01-02T02:00:00Z' });
  const id = `${r0.round_id}:C001`; const f = 'rank(close)';
  rounds.recordCandidate(r0.round_id, { candidate_id: id, formula_canonical: f, formula_sha256: sha(f), holding_period: 5, mining_score: 0 }, { registeredBy: AUTH, registeredAt: r0.opened_at });
  vault.seal({ round_id: r0.round_id, segment: { from: '2026-07-01', to: '2026-10-31' }, data_ref: 'lane:/h', data_sha256: sha8('h'), sealedBy: 'VAULT' });
  vault.open({ round_id: r0.round_id, candidate_ids: [id], openedBy: 'SELECTOR' });
  const rec = gate.internals.withFreezeRoot(s.root, () => records.internals.withThresholdsFile(cfg, () => records.recordGateResult({ round_id: r0.round_id, candidate_id: id, candidate: {} })));
  assert.equal(rec.codes.includes('MINE_THRESHOLDS_FREEZE_REF_INVALID'), false);
  assert.equal(rec.codes.includes('MINE_THRESHOLDS_UNFROZEN'), false);
  assert.deepEqual([rec.thresholds_used.state, rec.thresholds_used.ic_mean_min, rec.thresholds_file.sha256], ['FROZEN', 0.02, sha(fs.readFileSync(cfg))]);
});

test('冻结页不对 → MINE_THRESHOLDS_FREEZE_REF_INVALID：sha 不符、页不在、页里少了或写错一个数、路径出了 docs/freeze/；没冻结的照旧 UNFROZEN', () => {
  const s = syntheticRoot();
  const base = thresholdsOf(configWith({ frozen_ref: { path: PAGE, sha256: s.sha } }));
  gate.internals.withFreezeRoot(s.root, () => {
    assert.equal(gate.verifyFreezeRef({ ...base, frozen_ref: { path: PAGE, sha256: 'f'.repeat(64) } }), 'PAGE_SHA_MISMATCH');
    assert.equal(gate.verifyFreezeRef({ ...base, frozen_ref: { path: 'docs/freeze/NOT_THERE.md', sha256: s.sha } }), 'PAGE_MISSING');
    assert.equal(gate.verifyFreezeRef({ ...base, frozen_ref: { path: '../outside.md', sha256: s.sha } }), 'PATH_INVALID');
    assert.equal(gate.verifyFreezeRef({ ...base, frozen_ref: { path: 'config/mining_gate_thresholds.v1.json', sha256: s.sha } }), 'PATH_INVALID');
    assert.equal(gate.verifyFreezeRef({ ...base, ic_mean_min: 0.03 }), 'PAGE_VALUE_MISSING:ic_mean_min');
    const r = gate.evaluate({}, { thresholds: { ...base, frozen_ref: { path: PAGE, sha256: 'f'.repeat(64) } }, checkFreeze: true });
    assert.deepEqual([r.codes, r.thresholds.freeze_check], [['MINE_THRESHOLDS_FREEZE_REF_INVALID'], 'PAGE_SHA_MISMATCH']);
  });
  const draftLike = syntheticRoot(VALUES, { frozen: false });
  gate.internals.withFreezeRoot(draftLike.root, () => assert.equal(gate.verifyFreezeRef({ ...base, frozen_ref: { path: PAGE, sha256: draftLike.sha } }), 'PAGE_NOT_FROZEN'));
  // 没冻结（临时的 PENDING 副本）：照旧 MINE_THRESHOLDS_UNFROZEN，不读页
  const pending = thresholdsOf(configWith({ state: 'PENDING_FREEZE', frozen_ref: null }));
  assert.deepEqual(gate.evaluate({}, { thresholds: pending, checkFreeze: true }).codes, ['MINE_THRESHOLDS_UNFROZEN']);
  // 单元测试自带的 FROZEN 门槛块：不要求 checkFreeze 时不核页（逐候选记录总是核）
  assert.equal(gate.evaluate({}, { thresholds: { ...base, frozen_ref: { path: PAGE, sha256: 'f'.repeat(64) } } }).codes.includes('MINE_THRESHOLDS_FREEZE_REF_INVALID'), false);
});
