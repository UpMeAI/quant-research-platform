'use strict';
require('./_env');
const test = require('node:test');
const { beforeEach } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const q0 = require('../services/baseline-evaluation');
const cc = require('../services/candidate-comparison');
const fx0 = require('./_q0_fixture');
const fx4 = require('./_q4_fixture');

const ROOT = path.join(__dirname, '..');
const { Q4 } = cc.QUESTIONS;

let Q0;
beforeEach(() => {
  for (const ledger of [q0.LEDGER(), cc.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); cc.clearCache();
  const doc = fx0.result();
  const lock = q0.importBaselineEvaluation(fx0.write(doc), { registeredBy: AUTHORITY, allowNonActual: true });
  Q0 = { doc, id: lock.result_id, sha: lock.file_sha256 };
});

const make4 = (fn) => fx4.result(Q0.doc, Q0.sha, Q0.id, fn);
const write4 = (fn, options) => fx4.write(make4(fn), options);
const imp = (file, extra = {}) => cc.importCandidateComparison(file, { registeredBy: AUTHORITY, allowNonActual: true, ...extra });
const refuses4 = (fn, code) => assert.throws(() => imp(write4(fn)), (error) => error.code === code, code);
const project4 = (fn) => cc.buildProjection(imp(write4(fn)), { allowNonActual: true, question: 'Q4' });
const block = (projection, key) => projection.blocks.find((item) => item.key === key);

// ── 登记项 ──────────────────────────────────────────────────────────────────────

test('Q4 登记项：K2 sha256 对得上冻结文件；候选臂、运行门、判据集、常数、样本外期望、敞口、只报行都按 K2 裁定', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, Q4.k2.ref))).digest('hex');
  assert.equal(sha, Q4.k2.sha256);
  assert.ok(fs.existsSync(path.join(ROOT, Q4.profile_ref)));
  assert.equal(Q4.schema, 'US_V5_M2_Q4_RESULT_V1');
  assert.equal(Q4.queue_order, 4);
  assert.equal(Q4.candidate.key, 'CANDIDATE_COOLDOWN_ON_OPEN');
  assert.deepEqual(Object.keys(Q4.criteria), ['G1', 'P_G', 'F3']);
  assert.deepEqual([...Q4.run_gates], ['ACCEPTANCE', 'INPUTS', 'BASELINE_REPRO', 'COOLDOWN_PARITY', 'INERT_Q0F', 'INERT_Q2', 'INERT_Q3', 'PROBE']);
  assert.deepEqual([Q4.oos_reuse.expected, Q4.oos_reuse.reason_code, Q4.oos_reuse.detail_required], [true, 'OOS_REUSED_FOR_SELECTION', true]);
  assert.equal(Q4.attribution.required, false);
  assert.equal(Q4.exposure.required, true);
  assert.deepEqual(Q4.report_only.rows.map((row) => row.key), ['NO_24H_COOLDOWN', 'MAX_POSITIONS_5', 'RISK_UNIT_90', 'GATE_REFUSAL_ONLY_UNARM']);
});

// ── 导入 ────────────────────────────────────────────────────────────────────────

test('Q4 默认文件导入通过：锁里写 oos_reuse=true；主卡各块可读；只报行单独一张卡，不进结论', () => {
  const lock = imp(write4());
  assert.equal(lock.question_ref, 'Q4');
  assert.equal(lock.oos_reuse, true);
  const projection = cc.buildProjection(lock, { allowNonActual: true, question: 'Q4' });
  assert.equal(projection.state, 'LOCKED_VERIFIED');
  for (const item of projection.blocks) assert.equal(item.state, 'AVAILABLE', `${item.key}: ${item.reason}`);
  const card = projection.extra_cards.find((item) => item.key === 'report_only_dimensions');
  assert.equal(card.state, 'AVAILABLE');
  assert.deepEqual(card.data.rows.map((row) => row.key), ['NO_24H_COOLDOWN', 'MAX_POSITIONS_5', 'RISK_UNIT_90', 'GATE_REFUSAL_ONLY_UNARM']);
  assert.ok(card.data.rows.every((row) => row.in_verdict === false));
  const adoption = projection.completeness.lines.find((line) => line.kind === 'adoption');
  assert.match(adoption.text, /A25 的 C6/);
});

test('Q4 敞口：嵌套的冷却计数进敞口表（原版没有 arms_not_set 写「—」）；形状坏了拒绝', () => {
  const projection = project4();
  const exposure = block(projection, 'exposure').data;
  const byKey = Object.fromEntries(exposure.extra_rows.map((row) => [row.key, row]));
  assert.equal(byKey['cooldown_blocked_signals.open_scan'].baseline, 283);
  assert.equal(byKey['cooldown_blocked_signals.open_scan'].candidate, 24);
  assert.equal(byKey['arms_not_set.gate_refusal.open_scan'].baseline, null);
  assert.equal(byKey['arms_not_set.gate_refusal.open_scan'].candidate, 251);
  refuses4((doc) => { delete doc.comparison.exposure.CANDIDATE_COOLDOWN_ON_OPEN.arms_not_set; }, 'Q4_EXPOSURE_DISCLOSURE_INVALID');
  refuses4((doc) => { doc.comparison.exposure.BASELINE.cooldown_blocked_signals.other = -1; }, 'Q4_EXPOSURE_DISCLOSURE_INVALID');
});

test('Q4 样本外：oos_reuse 写 false、缺原因码或缺理由都拒绝', () => {
  refuses4((doc) => { doc.oos_reuse = false; }, 'Q4_OOS_REUSE_MUST_BE_DECLARED');
  refuses4((doc) => { doc.verdict.reason_codes = doc.verdict.reason_codes.filter((code) => code !== 'OOS_REUSED_FOR_SELECTION'); }, 'Q4_OOS_REUSE_NOT_DECLARED');
  refuses4((doc) => { delete doc.oos_reuse_detail; }, 'Q4_OOS_REUSE_DETAIL_MISSING');
});

test('Q4 只报行：缺一行、in_verdict 不是 false、整块缺失都拒绝；数字读不出来只让这张卡写原因', () => {
  refuses4((doc) => { doc.report_only_dimensions = doc.report_only_dimensions.filter((row) => row.key !== 'RISK_UNIT_90'); }, 'Q4_REPORT_ONLY_ROW_MISSING');
  refuses4((doc) => { doc.report_only_dimensions[0].in_verdict = true; }, 'Q4_REPORT_ONLY_IN_VERDICT');
  refuses4((doc) => { delete doc.report_only_dimensions; }, 'Q4_RESULT_TOP_LEVEL_MISSING');
  const projection = project4((doc) => { doc.report_only_dimensions[1].g_vs_baseline = null; });
  const card = projection.extra_cards.find((item) => item.key === 'report_only_dimensions');
  assert.equal(card.state, 'NOT_COMPLETED');
  assert.equal(projection.state, 'LOCKED_VERIFIED', '只报行读不出来不影响主卡');
});

test('Q4 判定：G1 先判（勘误 1）；NOT_PASSED 要 G1 成立且 U_g ≤ 0；运行门少一道拒绝', () => {
  refuses4((doc) => { doc.verdict.state = 'NOT_PASSED'; doc.comparison.criteria.G1.met = false; doc.verdict.U_g = -0.001; doc.comparison.criteria.F3.triggered = true; },
    'Q4_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE');
  refuses4((doc) => { doc.verdict.state = 'SUPPORTED'; }, 'Q4_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses4((doc) => { delete doc.gates.COOLDOWN_PARITY; }, 'Q4_RUN_GATE_NOT_PASSED');
});
