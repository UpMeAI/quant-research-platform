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
const fx5 = require('./_q5_fixture');

const ROOT = path.join(__dirname, '..');
const { Q5 } = cc.QUESTIONS;

let Q0;
let LOCK4;
const imp = (file, extra = {}) => cc.importCandidateComparison(file, { registeredBy: AUTHORITY, allowNonActual: true, ...extra });
beforeEach(() => {
  for (const ledger of [q0.LEDGER(), cc.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); cc.clearCache();
  const doc = fx0.result();
  const lock = q0.importBaselineEvaluation(fx0.write(doc), { registeredBy: AUTHORITY, allowNonActual: true });
  Q0 = { doc, id: lock.result_id, sha: lock.file_sha256 };
  LOCK4 = imp(fx4.write(fx4.result(Q0.doc, Q0.sha, Q0.id)));
});

const write5 = (fn, lock4 = LOCK4) => fx5.write(fx5.result(Q0.doc, Q0.sha, Q0.id, lock4, fn));
const refuses5 = (fn, code) => assert.throws(() => imp(write5(fn)), (error) => error.code === code, code);
const project5 = (fn) => cc.buildProjection(imp(write5(fn)), { allowNonActual: true, question: 'Q5' });
const block = (projection, key) => projection.blocks.find((item) => item.key === key);
const extra = (projection, key) => projection.extra_cards.find((item) => item.key === key);

// ── 登记项 ──────────────────────────────────────────────────────────────────────

test('Q5 登记项：K2 sha256 对得上冻结文件；原版臂来自 Q4 的候选臂；G1 读改变的入场 + 出场；运行门、样本外、参照行按 K2 裁定', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, Q5.k2.ref))).digest('hex');
  assert.equal(sha, Q5.k2.sha256);
  assert.ok(fs.existsSync(path.join(ROOT, Q5.profile_ref)));
  assert.equal(Q5.schema, 'US_V5_M2_Q5_RESULT_V1');
  assert.equal(Q5.queue_order, 5);
  assert.equal(Q5.candidate.key, 'CANDIDATE_T3_ON_A25');
  assert.deepEqual([...Q5.baseline_arm.keys], ['BASELINE_A25']);
  assert.deepEqual({ ...Q5.baseline_arm.ref }, { question_ref: 'Q4', arm: 'CANDIDATE_COOLDOWN_ON_OPEN' });
  assert.equal(Q5.g1_changed_key, 'changed_total');
  assert.deepEqual(Object.keys(Q5.criteria), ['G1', 'P_G', 'F3']);
  assert.deepEqual([...Q5.run_gates], ['ACCEPTANCE', 'INPUTS', 'ENGINE_FILES_UNCHANGED', 'COMPOSE_KEYS', 'PARITY_T3_OFF', 'PARITY_A25_OFF', 'BASELINE_REPRO_D', 'NOCD_T3_REPRO']);
  assert.deepEqual([Q5.oos_reuse.expected, Q5.oos_reuse.reason_code, Q5.oos_reuse.detail_required], [true, 'OOS_REUSED_FOR_SELECTION', true]);
  assert.equal(Q5.attribution.required, false);
  assert.deepEqual(Q5.report_only.rows.map((row) => row.key), ['REF_D', 'REF_D_T3', 'COMBINED_VS_D']);
  assert.deepEqual(cc.registry.PLAN.Q5, ['Q1', 'Q4']);
});

// ── 导入 ────────────────────────────────────────────────────────────────────────

test('Q5 默认文件导入通过：原版是 D+A25；主卡各块可读；参照行与建议核对表各一张卡，不进结论', () => {
  const lock = imp(write5());
  assert.equal(lock.question_ref, 'Q5');
  assert.equal(lock.baseline_result_id, Q0.id, 'D 的基线锁仍是 Q0');
  assert.equal(lock.oos_reuse, true);
  const projection = cc.buildProjection(lock, { allowNonActual: true, question: 'Q5' });
  assert.equal(projection.state, 'LOCKED_VERIFIED');
  for (const item of projection.blocks) assert.equal(item.state, 'AVAILABLE', `${item.key}: ${item.reason}`);
  const account = block(projection, 'account').data;
  assert.match(JSON.stringify(account), /原版（D\+A25/);
  const refs = extra(projection, 'reference_rows');
  assert.equal(refs.state, 'AVAILABLE', refs.reason);
  assert.deepEqual(refs.data.rows.map((row) => [row.key, row.changed_entries, row.n]), [['REF_D', 35, 120], ['REF_D_T3', 35, 120], ['COMBINED_VS_D', 80, null]]);
  assert.ok(refs.data.rows.every((row) => row.in_verdict === false));
  const rec = extra(projection, 'recommendation');
  assert.equal(rec.state, 'AVAILABLE', rec.reason);
  assert.equal(rec.data.applicable, true);
  assert.equal(rec.data.recommendation, 'ADOPT');
  assert.deepEqual(rec.data.checks.filter((check) => check.counter).map((check) => check.id), [5, 6]);
  const exposure = block(projection, 'exposure').data;
  const rows = Object.fromEntries(exposure.extra_rows.map((row) => [row.key, row]));
  assert.equal(rows['arms_not_set.gate_refusal.open_scan'].baseline, 251, '两臂都是 A25：原版也有未武装的冷却数');
  const criteria = block(projection, 'criteria').data.rows.find((row) => row.key === 'G1');
  assert.match(criteria.text, /改变的入场与出场 40 笔/);
});

test('Q5 原版臂来源：没有 Q4 锁、臂名不对、sha256 不符、摘要与 Q4 候选臂不同都拒绝', () => {
  refuses5((doc) => { doc.identity.baseline_arm_ref = null; }, 'Q5_BASELINE_ARM_REF_MISSING');
  refuses5((doc) => { doc.identity.baseline_arm_ref.arm = 'BASELINE'; }, 'Q5_BASELINE_ARM_REF_MISSING');
  refuses5((doc) => { doc.identity.baseline_arm_ref.result_id = 'Q4-0000000000000000'; }, 'Q5_BASELINE_ARM_REF_LOCK_NOT_FOUND');
  refuses5((doc) => { doc.identity.baseline_arm_ref.sha256 = fx5.hex('other'); }, 'Q5_BASELINE_ARM_REF_SHA256_MISMATCH');
  refuses5((doc) => { doc.arms.BASELINE_A25.summary.end_capital += 1; doc.arms.BASELINE_A25.equity.values[doc.arms.BASELINE_A25.equity.values.length - 1] += 1; },
    'Q5_BASELINE_ARM_DIFFERS_FROM_REF');
});

test('Q5 判定：SUPPORTED 的 G1 读改变的入场 + 出场（只看入场会误拒）；不足 30 拒绝；有结论时不许带建议', () => {
  const supported = (total) => (doc) => {
    doc.verdict.state = 'SUPPORTED'; doc.verdict.L_g = 0.01; doc.verdict.U_g = 0.09; doc.comparison.g_vs_baseline = { value: 0.05, ci_95: [0.01, 0.09] };
    doc.verdict.reason_codes = ['OOS_REUSED_FOR_SELECTION', 'STRESS_SCENARIO_MISSING'];
    Object.assign(doc.comparison.criteria.G1, { changed_entries: 5, changed_exits: total - 5, changed_total: total });
    doc.comparison.criteria.P_G.met = true;
    doc.recommendation = null;
  };
  assert.equal(imp(write5(supported(40))).verdict_state, 'SUPPORTED', '改变的入场只有 5 笔，但入场 + 出场 40 笔，G1 成立');
  for (const ledger of [cc.LEDGER()]) fs.rmSync(ledger, { force: true });
  cc.clearCache();
  LOCK4 = imp(fx4.write(fx4.result(Q0.doc, Q0.sha, Q0.id)));
  refuses5(supported(20), 'Q5_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL');
  refuses5((doc) => { supported(40)(doc); doc.recommendation = { checks: fx5.checks(), recommendation: 'ADOPT' }; }, 'Q5_RECOMMENDATION_NOT_ALLOWED');
  refuses5((doc) => { delete doc.gates.PARITY_A25_OFF; }, 'Q5_RUN_GATE_NOT_PASSED');
});

test('Q5 采用建议（★3 (a)）：证据不足时必须有；建议必须与前 4 项一致；反证不参与；有一项「否」就只能建议不采用', () => {
  refuses5((doc) => { doc.recommendation = null; }, 'Q5_RECOMMENDATION_MISSING');
  refuses5((doc) => { doc.recommendation.checks = doc.recommendation.checks.filter((check) => check.id !== 6); }, 'Q5_RECOMMENDATION_CHECKS_INCOMPLETE');
  refuses5((doc) => { doc.recommendation.checks = fx5.checks([true, false, true, true]); }, 'Q5_RECOMMENDATION_INCONSISTENT');
  const projection = project5((doc) => { doc.recommendation.checks = fx5.checks([true, true, false, true]); doc.recommendation.recommendation = 'NOT_ADOPTED';
    doc.recommendation.recommendation_zh = '建议不采用：第 3 项为「否」'; });
  assert.equal(extra(projection, 'recommendation').data.recommendation, 'NOT_ADOPTED');
});

test('Q5 参照行与敞口：缺一行、in_verdict 不是 false 拒绝；原版臂缺未武装的冷却数拒绝', () => {
  refuses5((doc) => { doc.reference_rows = doc.reference_rows.filter((row) => row.key !== 'REF_D_T3'); }, 'Q5_REFERENCE_ROW_MISSING');
  refuses5((doc) => { doc.reference_rows[2].in_verdict = true; }, 'Q5_REFERENCE_ROW_IN_VERDICT');
  refuses5((doc) => { delete doc.reference_rows; }, 'Q5_RESULT_TOP_LEVEL_MISSING');
  refuses5((doc) => { delete doc.comparison.exposure.BASELINE_A25.arms_not_set; }, 'Q5_EXPOSURE_DISCLOSURE_INVALID');
});
