'use strict';
require('./_env');
const test = require('node:test');
const { beforeEach } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const q0 = require('../services/baseline-evaluation');
const q1 = require('../services/candidate-comparison');
const fx0 = require('./_q0_fixture');
const fx1 = require('./_q1_fixture');

let Q0;
beforeEach(() => {
  for (const ledger of [q0.LEDGER(), q1.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); q1.clearCache();
  const doc = fx0.result();
  const lock = q0.importBaselineEvaluation(fx0.write(doc), { registeredBy: AUTHORITY, allowNonActual: true });
  Q0 = { doc, id: lock.result_id, sha: lock.file_sha256 };
});

const make = (fn) => fx1.result(Q0.doc, Q0.sha, Q0.id, fn);
const write = (fn, options) => fx1.write(make(fn), options);
const imp = (file, extra = {}) => q1.importCandidateComparison(file, { registeredBy: AUTHORITY, allowNonActual: true, ...extra });
const refuses = (fn, code) => assert.throws(() => imp(write(fn)), (error) => error.code === code, code);
const project = (fn) => q1.buildProjection(imp(write(fn)), { allowNonActual: true });
const block = (projection, key) => projection.blocks.find((item) => item.key === key);
const BLOCK_KEYS = ['question', 'account', 'effect', 'criteria', 'stress', 'verdict', 'forward'];
const asState = (verdict, t3, state) => { verdict.state = state; verdict.t3_state = t3; };

test('尚未导入：整节是「尚未完成」和原因，七块各自写原因，不用 0 补位，也不等于证据不足', () => {
  const projection = q1.readProjection('NO-SUCH-CASE');
  assert.equal(projection.state, 'NOT_IMPORTED');
  assert.equal(projection.reason, '研究会话尚未交付封存的对比结果');
  assert.equal(projection.verdict_state, null);
  assert.deepEqual(projection.blocks.map((item) => item.key), BLOCK_KEYS);
  assert.ok(projection.blocks.every((item) => item.state === 'NOT_COMPLETED' && item.data === null && item.reason === projection.reason));
  assert.equal(projection.production_effect, 'NONE');
});

test('导入：封存校验、结果锁、引用 Q0 基线锁；同一文件重放幂等；七块按固定顺序全部可用', () => {
  const file = write();
  const lock = imp(file);
  assert.equal(lock.schema, 'COMPARISON_EVALUATION_LOCK_V1');
  assert.equal(lock.eval_class, 'CANDIDATE_COMPARISON_V1');
  assert.equal(lock.question_ref, 'Q1');
  assert.equal(lock.verdict_state, 'SUPPORTED');
  assert.equal(lock.t3_state, 'PASS');
  assert.equal(lock.baseline_result_id, Q0.id);
  assert.equal(lock.oos_reuse, true);
  assert.match(lock.result_id, /^Q1-[0-9a-f]{16}$/);
  assert.match(lock.inputs_digest, /^[0-9a-f]{64}$/);
  assert.match(lock.engine_digest, /^[0-9a-f]{64}$/);
  assert.equal(lock.production_effect, 'NONE');
  assert.equal(imp(file).replayHit, true);
  assert.equal(q1.locks(q1.CASE_REF).length, 1);

  const projection = q1.buildProjection(lock, { allowNonActual: true });
  assert.equal(projection.state, 'LOCKED_VERIFIED');
  assert.equal(projection.verdict_label, '有支持证据');
  assert.deepEqual(projection.blocks.map((item) => item.key), BLOCK_KEYS);
  assert.ok(projection.blocks.every((item) => item.state === 'AVAILABLE' && item.data), JSON.stringify(projection.blocks.map((item) => [item.key, item.reason])));
  assert.deepEqual(projection.baseline, { result_id: Q0.id, current: true });
  assert.equal(projection.source.file_sha256, lock.file_sha256);
  assert.equal(projection.source.baseline_result_id, Q0.id);
});

test('不重算：页面数字原样来自文件；账户差只是两个已报数字的差，P1–P4／F1–F3 的真假读文件、不重判', () => {
  const projection = project();
  const account = block(projection, 'account').data;
  assert.deepEqual(account.arms.map((arm) => arm.key), ['BASELINE', 'CANDIDATE_T3'], 'A4 D3.2：对比卡账户表只列原版和候选，SPY 与现金只在回测结论卡');
  assert.equal(account.benchmark_note_zh, '基准见回测结论卡');
  const [base, cand] = account.arms;
  assert.equal(base.end_capital, Q0.doc.arms.D.summary.end_capital);
  assert.equal(cand.deferred_sessions, 37);
  assert.equal(account.diff_vs_baseline.end_capital, cand.end_capital - base.end_capital);
  assert.equal(account.start, '2023-01-03');

  const effect = block(projection, 'effect').data;
  assert.equal(effect.S.n_aff, 34);
  assert.equal(effect.S.blocks, 12);
  assert.equal(effect.S.mean_dR, 0.31);
  assert.deepEqual(effect.S.ci_98_33, { lo: 0.10, hi: 0.52 });
  assert.equal(effect.B.n_aff, 9);
  assert.equal(effect.g.value, 0.021);
  assert.equal(effect.secondary.n_time_exits, 23);

  const criteria = block(projection, 'criteria').data.rows;
  assert.deepEqual(criteria.map((row) => row.key), ['G1', 'P1', 'P2', 'P3', 'P4', 'F1', 'F2', 'F3']);
  assert.deepEqual(criteria.map((row) => row.state_label), ['成立', '成立', '成立', '成立', '成立', '未触发', '未触发', '未触发']);
  assert.match(criteria.find((row) => row.key === 'P2').text, /期末资本 \$.+ 对 \$.+；最大回撤/);
  assert.match(criteria.find((row) => row.key === 'P1').text, /下沿 \+0\.10 R/);
  assert.match(criteria.find((row) => row.key === 'P4').text, /高费用期末资本 \$8,200 对 \$8,000/);
  assert.match(criteria.find((row) => row.key === 'F1').text, /最低改善量 \+0\.15 R/);
});

test('优势结论、压力评价、采用条件三行分开：SUPPORTED + 压力有缺 + 样本外复测，三行都在，互不折叠', () => {
  const projection = project();
  const lines = projection.completeness.lines;
  assert.deepEqual(lines.map((line) => line.kind), ['edge', 'stress', 'adoption']);
  assert.equal(lines[0].text, '优势结论：有支持证据');
  assert.match(lines[1].text, /^压力评价不完整：缺场景 1 个、无效输入 1 个（/);
  assert.match(lines[1].text, /极端下跌 2008：缺场景/);
  assert.match(lines[1].text, /区间重放：2020-02-19 至 2020-04-30：无效输入/);
  assert.doesNotMatch(lines[1].text, /候选臂缺项/, '补充行的 T3 臂缺项是 K2 规定的，不算压力不完整');
  assert.equal(lines[2].text, '采用条件：未满足（独立样本不足，等前向成熟；必要压力缺失，§6.7）');
  assert.equal(projection.completeness.complete, false);
  assert.equal(projection.completeness.adoption_met, false);
  assert.deepEqual(block(projection, 'verdict').data.completeness.lines, lines);
});

test('压力完整、样本外仍是复测：只有优势结论和采用条件两行，采用条件只写独立样本不足', () => {
  const projection = project((doc) => {
    doc.stress.rows = doc.stress.rows.filter((row) => !['WINDOW_2020_02_19_04_30', 'EXTREME_DOWNTURN_2008'].includes(row.scenario));
    doc.verdict.reason_codes = ['OOS_REUSED_FOR_SELECTION'];
  });
  const lines = projection.completeness.lines;
  assert.deepEqual(lines.map((line) => line.kind), ['edge', 'adoption']);
  assert.equal(lines[1].text, '采用条件：未满足（独立样本不足，等前向成熟）');
  assert.equal(projection.completeness.complete, true);
});

test('压力行：每行两臂各一格加差；缺场景／无效输入没有数字；补充行候选臂缺项只报原版；角色计数分开', () => {
  const stress = block(project(), 'stress').data;
  const byScenario = Object.fromEntries(stress.rows.map((row) => [row.scenario, row]));
  assert.equal(byScenario.COST_15BPS.baseline.end_capital, 8000);
  assert.equal(byScenario.COST_15BPS.candidate.end_capital, 8200);
  assert.equal(byScenario.COST_15BPS.diff.end_capital, 200);
  assert.equal(byScenario.COST_15BPS.diff.max_loss_usd, -10);
  assert.equal(byScenario.EXTREME_DOWNTURN_2008.kind, 'MISSING');
  assert.equal(byScenario.EXTREME_DOWNTURN_2008.baseline, null);
  assert.match(byScenario.EXTREME_DOWNTURN_2008.reason, /^2007–2009 行业 ETF/, '原因前缀「缺场景：」不重复');
  assert.equal(byScenario.WINDOW_2020_02_19_04_30.kind, 'INVALID_INPUT');
  const supplementary = byScenario.SPY_QQQ_SYNTHETIC_2008;
  assert.equal(supplementary.kind, 'SUPPLEMENTARY');
  assert.equal(supplementary.simulated, true);
  assert.equal(supplementary.candidate_missing, true);
  assert.equal(supplementary.diff, null);
  assert.equal(supplementary.baseline.max_loss_usd, 2400);
  assert.match(supplementary.candidate.reason, /dailyRead/);
  assert.deepEqual(stress.counts, { executed: 3, simulated: 1, missing: 1, invalid_input: 1, candidate_missing: 0, reference: 1, risk_dimension: 1 });
});

test('候选臂在压力场景行缺项：算压力不完整，单独写「候选臂缺项」，文件必须自己写明 STRESS_SCENARIO_MISSING', () => {
  const candidateMissing = (doc) => {
    const target = doc.stress.rows.find((row) => row.scenario === 'COST_15BPS');
    target.arms.CANDIDATE_T3 = { missing: true, ...fx1.NULLS, missing_reason: '候选臂这一行没跑出来' };
    delete target.diff;
  };
  const projection = project(candidateMissing);
  assert.match(projection.completeness.lines[1].text, /候选臂缺项 1 个（.*费用 15 bps 双边：候选臂缺项）/);
  assert.equal(block(projection, 'stress').data.counts.candidate_missing, 1);
  fs.rmSync(q1.LEDGER(), { force: true });
  refuses((doc) => { candidateMissing(doc); doc.verdict.reason_codes = ['OOS_REUSED_FOR_SELECTION']; }, 'Q1_VERDICT_SUPPORTED_HIDES_INCOMPLETE_STRESS');
});

test('压力有缺而 SUPPORTED 不写 STRESS_SCENARIO_MISSING：拒绝；INSUFFICIENT 不受此限', () => {
  refuses((doc) => { doc.verdict.reason_codes = ['OOS_REUSED_FOR_SELECTION']; }, 'Q1_VERDICT_SUPPORTED_HIDES_INCOMPLETE_STRESS');
  const projection = project((doc) => { asState(doc.verdict, 'INSUFFICIENT', 'INSUFFICIENT'); doc.verdict.reason_codes = ['OOS_REUSED_FOR_SELECTION']; });
  assert.equal(projection.verdict_state, 'INSUFFICIENT');
  assert.equal(projection.verdict_label, '证据不足');
});

test('样本外复用（AC5）：oos_reuse 必须声明为 true 且带 OOS_REUSED_FOR_SELECTION，不能把复测说成独立样本外', () => {
  refuses((doc) => { doc.oos_reuse = false; }, 'Q1_OOS_REUSE_MUST_BE_DECLARED');
  refuses((doc) => { doc.verdict.reason_codes = ['STRESS_SCENARIO_MISSING']; }, 'Q1_OOS_REUSE_NOT_DECLARED');
  refuses((doc) => { delete doc.oos_reuse; }, 'Q1_RESULT_TOP_LEVEL_MISSING');
  refuses((doc) => { doc.oos_reuse = 'true'; }, 'Q1_OOS_REUSE_MISSING');
  const question = block(project(), 'question').data;
  assert.equal(question.oos_reuse.label, '复测（当年用于挑选 T3 的样本，不是独立样本外）');
  assert.deepEqual(question.oos_reuse.reused, { from: '2023-01-03', to: '2026-10-02' });
  assert.equal(question.oos_reuse.independent.length, 2);
  assert.equal(question.baseline_result_id, Q0.id);
});

test('前向只报不判：任何一行 in_verdict 不是 false 都拒绝；前向行带来源哈希并标「前向，只报不判」', () => {
  refuses((doc) => { doc.forward[0].in_verdict = true; }, 'Q1_FORWARD_IN_VERDICT');
  refuses((doc) => { delete doc.forward[1].in_verdict; }, 'Q1_FORWARD_IN_VERDICT');
  refuses((doc) => { doc.forward = 'x'; }, 'Q1_FORWARD_ROWS_MISSING');
  const forward = block(project(), 'forward').data;
  assert.match(forward.label, /^前向，只报不判/);
  assert.deepEqual(forward.rows.map((row) => row.stream), ['B', 'S']);
  assert.ok(forward.rows.every((row) => row.in_verdict === false && /^[0-9a-f]{64}$/.test(row.file_sha256)));
  assert.match(forward.rows[1].facts.join(' '), /S_RUN_BLOCKED/);
});

test('前向放在 comparison 下也认（K2 正文写法）；顶层优先；两处都没有拒绝', () => {
  const moved = project((doc) => { doc.comparison.forward = doc.forward; delete doc.forward; });
  assert.equal(block(moved, 'forward').data.rows.length, 2);
  fs.rmSync(q1.LEDGER(), { force: true });
  refuses((doc) => { delete doc.forward; }, 'Q1_FORWARD_ROWS_MISSING');
  refuses((doc) => { doc.forward = { rows: 'x' }; }, 'Q1_FORWARD_ROWS_MISSING');
});

test('标签不能越过算术证据：SUPPORTED 须各判据成立、L_D>0、L_g>0、U_D≥δ*、样本≥30 笔且≥10 块、引擎不是近似', () => {
  refuses((doc) => { doc.verdict.U_g = -0.001; }, 'Q1_VERDICT_SUPPORTED_VIOLATES_F3');
  refuses((doc) => { doc.verdict.U_g = 0; }, 'Q1_VERDICT_SUPPORTED_VIOLATES_F3');
  refuses((doc) => { doc.verdict.L_D = 0; }, 'Q1_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses((doc) => { doc.verdict.L_g = 0; }, 'Q1_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses((doc) => { doc.verdict.U_D = 0.149; }, 'Q1_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses((doc) => { doc.comparison.criteria.P2 = { met: false }; doc.verdict.P2 = { met: false }; }, 'Q1_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses((doc) => { doc.comparison.criteria.F2 = { triggered: true }; }, 'Q1_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses((doc) => { doc.comparison.populations.S.n_aff = 29; }, 'Q1_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL');
  refuses((doc) => { doc.comparison.populations.S.blocks = 9; }, 'Q1_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL');
  refuses((doc) => { doc.verdict.engine_approximation = { flag: true, missing: ['x'] }; }, 'Q1_VERDICT_SUPPORTED_ON_APPROXIMATE_ENGINE');
  refuses((doc) => { delete doc.verdict.L_D; delete doc.comparison.populations.S.ci_98_33; }, 'Q1_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
});

test('区间两端：verdict 里没有 L_D／U_D／L_g／U_g 时取 comparison 里对应的 98.33% 区间，只读取、不推算', () => {
  const projection = project((doc) => { for (const key of ['L_D', 'U_D', 'L_g', 'U_g']) delete doc.verdict[key]; });
  const verdict = block(projection, 'verdict').data;
  assert.deepEqual(verdict.D_98_33, { lo: 0.10, hi: 0.52 });
  assert.deepEqual(verdict.g_98_33, { lo: 0.002, hi: 0.045 });
  refuses((doc) => { for (const key of ['L_D', 'U_D', 'L_g', 'U_g']) delete doc.verdict[key]; doc.comparison.g_vs_baseline.ci_98_33 = [-0.03, 0]; }, 'Q1_VERDICT_SUPPORTED_VIOLATES_F3');
});

test('NOT_PASSED 须有 F1／F2／F3 之一的证据；INSUFFICIENT 随时允许；BLOCKED 不出结论', () => {
  refuses((doc) => asState(doc.verdict, 'FAIL', 'NOT_PASSED'), 'Q1_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE');
  const f1 = project((doc) => { asState(doc.verdict, 'FAIL', 'NOT_PASSED'); doc.verdict.U_D = 0.1; doc.verdict.L_D = -0.3; doc.comparison.criteria.F1 = { triggered: true }; doc.comparison.criteria.P1 = { met: false }; });
  assert.equal(f1.verdict_label, '未通过');
  assert.equal(f1.completeness.lines[0].text, '优势结论：未通过');
  fs.rmSync(q1.LEDGER(), { force: true });
  const f3 = project((doc) => { asState(doc.verdict, 'FAIL', 'NOT_PASSED'); doc.verdict.U_g = -0.01; doc.comparison.criteria.F3 = { triggered: true }; doc.comparison.criteria.P3 = { met: false }; });
  assert.equal(f3.verdict_state, 'NOT_PASSED');
  fs.rmSync(q1.LEDGER(), { force: true });
  const f2 = project((doc) => { asState(doc.verdict, 'FAIL', 'NOT_PASSED'); doc.comparison.criteria.P4 = { met: false }; doc.comparison.criteria.F2 = { triggered: true, which: 'P4' }; });
  assert.equal(block(f2, 'criteria').data.rows.find((row) => row.key === 'F2').text, '否决：P1 成立，但 P2 或 P4 不成立。不成立的是 P4。');
  fs.rmSync(q1.LEDGER(), { force: true });
  const insufficient = project((doc) => { asState(doc.verdict, 'INSUFFICIENT', 'INSUFFICIENT'); doc.comparison.populations.S.n_aff = 12; doc.comparison.criteria.G1 = { met: false }; });
  assert.equal(insufficient.verdict_label, '证据不足');
  refuses((doc) => { doc.verdict.t3_state = 'BLOCKED'; }, 'Q1_BLOCKED_HAS_NO_VERDICT');
  refuses((doc) => { doc.verdict.t3_state = 'FAIL'; }, 'Q1_T3_STATE_MISMATCH');
  refuses((doc) => { doc.verdict.state = 'MAYBE'; }, 'Q1_VERDICT_STATE_UNSUPPORTED');
  refuses((doc) => { doc.verdict.class = 'BASELINE_EVALUATION_V1'; }, 'Q1_VERDICT_CLASS_UNSUPPORTED');
});

test('判据逐项：缺项拒绝，两处（comparison 与 verdict）都写时必须一致；冻结值 δ*、δ_g、98.33% 不能改', () => {
  refuses((doc) => { delete doc.comparison.criteria.P3; }, 'Q1_CRITERIA_INCOMPLETE');
  refuses((doc) => { doc.comparison.criteria.P1 = {}; }, 'Q1_CRITERIA_INCOMPLETE');
  refuses((doc) => { doc.verdict.P1 = { met: false }; }, 'Q1_CRITERIA_DISAGREE');
  const both = project((doc) => { doc.verdict.P1 = true; doc.verdict.F3 = false; });
  assert.equal(both.state, 'LOCKED_VERIFIED');
  refuses((doc) => { doc.verdict.delta_star = 0.1; }, 'Q1_VERDICT_DELTA_CHANGED');
  refuses((doc) => { doc.verdict.delta_g = 0.01; }, 'Q1_VERDICT_DELTA_CHANGED');
  refuses((doc) => { doc.comparison.bonferroni.level = 0.95; }, 'Q1_BONFERRONI_LEVEL_CHANGED');
  refuses((doc) => { delete doc.comparison.populations.S; }, 'Q1_PRIMARY_POPULATION_MISSING');
});

test('总体 S／B 也认 comparison.S／B 与 comparison.D 的写法（K2 正文）', () => {
  const projection = project((doc) => {
    const { S, B } = doc.comparison.populations;
    delete doc.comparison.populations;
    doc.comparison.D = S; doc.comparison.B = B;
  });
  assert.equal(block(projection, 'effect').data.S.n_aff, 34);
  assert.equal(block(projection, 'effect').data.B.n_aff, 9);
});

test('运行门：K2 点名的七道门都在且 PASSED；其他带 state 的门不能是别的状态', () => {
  for (const name of q1.RUN_GATES) refuses((doc) => { doc.gates[name] = { state: 'FAILED' }; }, 'Q1_RUN_GATE_NOT_PASSED');
  refuses((doc) => { delete doc.gates.TWIN_PARITY; }, 'Q1_RUN_GATE_NOT_PASSED');
  refuses((doc) => { doc.gates.EXTRA = { state: 'BLOCKED' }; }, 'Q1_RUN_GATE_NOT_PASSED');
  assert.equal(project((doc) => { doc.gates.EXTRA = { state: 'PASSED' }; doc.gates.rules = [{ rule: 'x' }]; }).state, 'LOCKED_VERIFIED');
});

test('基线链：必须引用已存在且当前的 Q0 锁，原版臂逐项等于 Q0 的 D 臂', () => {
  const other = 'Q0-0000000000000000';
  refuses((doc) => { doc.identity.baseline_result_id = other; doc.identity.baseline.result_id = other; doc.comparison.baseline_result_id = other; }, 'Q1_BASELINE_LOCK_NOT_FOUND');
  refuses((doc) => { doc.comparison.baseline_result_id = other; }, 'Q1_BASELINE_RESULT_ID_DISAGREES');
  refuses((doc) => { delete doc.identity.baseline_result_id; delete doc.identity.baseline; delete doc.comparison.baseline_result_id; }, 'Q1_BASELINE_RESULT_ID_MISSING');
  refuses((doc) => { doc.identity.baseline.sha256 = fx1.hex('not-the-q0-file'); }, 'Q1_BASELINE_SHA256_MISMATCH');
  refuses((doc) => { doc.arms.BASELINE.summary.cagr = 0.5; }, 'Q1_BASELINE_ARM_DIFFERS_FROM_Q0');
  refuses((doc) => { doc.arms.BASELINE.summary.recovered = false; }, 'Q1_BASELINE_ARM_DIFFERS_FROM_Q0');
  refuses((doc) => { delete doc.arms.BASELINE; }, 'Q1_BASELINE_ARM_MISSING');
  // 只写 identity.baseline_result_id（裁定 5 的写法）也行
  assert.equal(project((doc) => { delete doc.identity.baseline; delete doc.comparison.baseline_result_id; }).state, 'LOCKED_VERIFIED');
});

test('基线被取代后，引用旧基线的 Q1 文件拒绝（Q1_BASELINE_NOT_CURRENT）；引用新基线的接受', () => {
  const replaced = fx0.result((doc) => { doc.verdict.n_trades = 82; });
  const lock = q0.importBaselineEvaluation(fx0.write(replaced), {
    registeredBy: AUTHORITY, allowNonActual: true, supersedes: Q0.id, defectRef: 'DEFECT-TEST', reason: '测试：基线被取代',
  });
  refuses(() => {}, 'Q1_BASELINE_NOT_CURRENT');
  const projection = q1.buildProjection(imp(fx1.write(fx1.result(replaced, lock.file_sha256, lock.result_id))), { allowNonActual: true });
  assert.equal(projection.state, 'LOCKED_VERIFIED');
  assert.equal(projection.source.baseline_result_id, lock.result_id);
  assert.equal(projection.baseline.current, true);

  // 之后基线再被取代：已锁定的 Q1 页面仍可读，但标出「所引用的基线已不是当前」
  const third = fx0.result((doc) => { doc.verdict.n_trades = 83; });
  q0.importBaselineEvaluation(fx0.write(third), {
    registeredBy: AUTHORITY, allowNonActual: true, supersedes: lock.result_id, defectRef: 'DEFECT-TEST-2', reason: '测试：再次取代',
  });
  const stale = q1.buildProjection(q1.headLock(), { allowNonActual: true });
  assert.equal(stale.state, 'LOCKED_VERIFIED');
  assert.equal(stale.baseline.current, false);
});

test('封存与身份：缺旁证、旁证不符、非实际路径、相对路径、缺顶层字段、未复现、K2／schema／kind 不符都拒绝', () => {
  assert.throws(() => imp(write(undefined, { sidecar: false })), (error) => error.code === 'Q1_RESULT_SHA256_FILE_MISSING');
  assert.throws(() => imp(write(undefined, { tamperSidecar: true })), (error) => error.code === 'Q1_RESULT_SHA256_MISMATCH');
  assert.throws(() => q1.importCandidateComparison(write(), { registeredBy: AUTHORITY }), (error) => error.code === 'Q1_RESULT_NON_ACTUAL_SOURCE');
  assert.throws(() => imp('relative/Q1.json'), (error) => error.code === 'Q1_RESULT_PATH_MUST_BE_ABSOLUTE');
  assert.throws(() => imp('/no/such/Q1.json'), (error) => error.code === 'Q1_RESULT_MISSING');
  for (const key of q1.TOP_LEVEL) refuses((doc) => { delete doc[key]; }, 'Q1_RESULT_TOP_LEVEL_MISSING');
  refuses((doc) => { doc.reproducibility.identical = false; }, 'Q1_RESULT_NOT_REPRODUCED');
  refuses((doc) => { doc.reproducibility.runs[1].sha256 = fx1.hex('other-run'); }, 'Q1_RESULT_NOT_REPRODUCED');
  refuses((doc) => { doc.identity.schema = 'US_V5_M2_Q0_RESULT_V1'; }, 'Q1_RESULT_SCHEMA_UNSUPPORTED');
  refuses((doc) => { doc.identity.result_kind = 'BASELINE'; }, 'Q1_RESULT_KIND_UNSUPPORTED');
  refuses((doc) => { doc.identity.k2.sha256 = fx1.hex('edited-k2'); }, 'Q1_K2_SHA_MISMATCH');
});

test('一题只锁一次；改锁须指向当前锁并引用缺陷和原因，旧锁保留；导入只由完成权威执行', () => {
  const first = imp(write());
  const second = write((doc) => { doc.diagnosis_items[0].facts = ['改过的事实']; });
  assert.throws(() => imp(second), (error) => error.code === 'COMPARISON_ALREADY_LOCKED');
  assert.throws(() => imp(second, { supersedes: 'Q1-0000000000000000', defectRef: 'D', reason: 'r' }), (error) => error.code === 'COMPARISON_ALREADY_LOCKED');
  assert.throws(() => imp(second, { supersedes: first.result_id }), (error) => error.code === 'COMPARISON_SUPERSEDE_REQUIRES_DEFECT_AND_REASON');
  const replaced = imp(second, { supersedes: first.result_id, defectRef: 'DEFECT-Q1-1', reason: '测试：改锁' });
  assert.equal(replaced.supersedes_ref, first.result_id);
  assert.equal(q1.locks(q1.CASE_REF).length, 2);
  assert.equal(q1.headLock().result_id, replaced.result_id);
  assert.equal(q1.comparisonFor(first.result_id).result_id, first.result_id);

  fs.rmSync(q1.LEDGER(), { force: true });
  assert.throws(() => imp(write(), { supersedes: 'Q1-0000000000000000', defectRef: 'D', reason: 'r' }), (error) => error.code === 'COMPARISON_SUPERSEDE_TARGET_NOT_FOUND');
  assert.throws(() => q1.importCandidateComparison(write(), { allowNonActual: true }), (error) => error.code === 'BASELINE_LOCK_REGISTERED_BY_REQUIRED');
  assert.throws(() => q1.importCandidateComparison(write(), { registeredBy: 'SOMEONE_ELSE', allowNonActual: true }), (error) => error.code === 'BASELINE_LOCK_REGISTERED_BY_NOT_AUTHORIZED');
  assert.equal(q1.locks().length, 0);
});

test('锁定后文件被改动、删除或旁证丢失：整节失败关闭，七块都不再显示任何数字', () => {
  const file = write();
  const lock = imp(file);
  const failed = (projection, state) => {
    assert.equal(projection.state, state);
    assert.equal(projection.verdict_state, null);
    assert.ok(projection.blocks.every((item) => item.state === 'NOT_COMPLETED' && item.data === null));
    assert.match(projection.reason, /^结果文件校验失败：/);
  };
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"SUPPORTED"', '"NOT_PASSED"'));
  failed(q1.buildProjection(lock, { allowNonActual: true }), 'INVALID');
  fs.rmSync(`${file}.sha256`);
  failed(q1.buildProjection(lock, { allowNonActual: true }), 'MISSING');
  fs.rmSync(file);
  failed(q1.buildProjection(lock, { allowNonActual: true }), 'MISSING');
});

test('改写文件并同步改写旁证（哈希对得上）：与锁里的 sha256 不符，同样失败关闭', () => {
  const file = write();
  const lock = imp(file);
  const bytes = Buffer.from(`${fs.readFileSync(file, 'utf8')} `);
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.sha256`, `${require('node:crypto').createHash('sha256').update(bytes).digest('hex')}  Q1_RESULT.json\n`);
  const projection = q1.buildProjection(lock, { allowNonActual: true });
  assert.equal(projection.state, 'INVALID');
  assert.equal(projection.reason_code, 'Q1_RESULT_DRIFTED_AFTER_LOCK');
});

test('区块各自失败：缺一块只让该块写「尚未完成：原因」，其他块照常；压力表读不出来时压力评价按不完整处理', () => {
  const effect = project((doc) => { delete doc.comparison.populations.B; });
  assert.equal(block(effect, 'effect').state, 'NOT_COMPLETED');
  assert.match(block(effect, 'effect').reason, /comparison\.populations\.B/);
  assert.ok(effect.blocks.filter((item) => item.key !== 'effect').every((item) => item.state === 'AVAILABLE'));
  assert.equal(effect.verdict_state, 'SUPPORTED');

  fs.rmSync(q1.LEDGER(), { force: true });
  const inconsistent = project((doc) => { doc.stress.rows.find((row) => row.scenario === 'COST_15BPS').diff.end_capital += 1; });
  assert.equal(block(inconsistent, 'stress').state, 'NOT_COMPLETED');
  assert.match(block(inconsistent, 'stress').reason, /diff 与两臂数字（候选 − 基线）不一致/);
  assert.ok(inconsistent.blocks.filter((item) => item.key !== 'stress').every((item) => item.state === 'AVAILABLE'));
  assert.match(inconsistent.completeness.lines[1].text, /^压力评价不完整：压力表无法读取/);
  assert.match(inconsistent.completeness.lines[2].text, /必要压力缺失，§6\.7/);
  assert.equal(block(inconsistent, 'criteria').data.rows.find((row) => row.key === 'P4').text.includes('高费用期末资本'), false, '压力块读不出来时不引用其中的数字');

  fs.rmSync(q1.LEDGER(), { force: true });
  const account = project((doc) => { doc.arms.CANDIDATE_T3.summary.end_capital += 5; });
  assert.equal(block(account, 'account').state, 'NOT_COMPLETED');
  assert.match(block(account, 'account').reason, /end_capital 与权益序列末点不一致/);
});

test('压力行状态不自洽只让压力块无效：缺场景行带数字、无效输入缺原因、未知状态、补充行没标 in_headline:false、基线臂缺项', () => {
  const broken = (fn, pattern) => {
    fs.rmSync(q1.LEDGER(), { force: true });
    const stress = block(project(fn), 'stress');
    assert.equal(stress.state, 'NOT_COMPLETED');
    assert.match(stress.reason, pattern);
  };
  broken((doc) => { doc.stress.rows.find((row) => row.scenario === 'EXTREME_DOWNTURN_2008').end_capital = 0; }, /数字必须是 null/);
  broken((doc) => { delete doc.stress.rows.find((row) => row.scenario === 'WINDOW_2020_02_19_04_30').reason; }, /reason/);
  broken((doc) => { doc.stress.rows.find((row) => row.scenario === 'COST_15BPS').status = 'WEIRD'; }, /status=WEIRD 不认识/);
  broken((doc) => { doc.stress.rows.find((row) => row.scenario === 'SPY_QQQ_SYNTHETIC_2008').in_headline = true; }, /in_headline:false/);
  broken((doc) => { doc.stress.rows.find((row) => row.scenario === 'COST_15BPS').arms.BASELINE = { missing: true, ...fx1.NULLS, missing_reason: 'x' }; }, /原版是比较的基准/);
  broken((doc) => { doc.stress.rows.find((row) => row.scenario === 'COST_15BPS').arms.CANDIDATE_T3 = { missing: true, ...fx1.NULLS, max_loss_usd: 0, missing_reason: 'x' }; }, /缺项的数字必须是 null/);
  // 模拟场景没标 simulated 是文件级拒绝
  refuses((doc) => { doc.stress.rows.find((row) => row.scenario === 'SPY_QQQ_SYNTHETIC_2008').simulated = false; }, 'Q1_STRESS_SIMULATED_NOT_FLAGGED');
});

test('缓存：文件指纹或锁变化立即重建，未变时成功结果缓存 10 分钟，失败只缓存 15 秒', () => {
  const file = write();
  imp(file);
  let clock = 1_000_000;
  let builds = 0;
  const reader = q1.createProjectionReader({
    now: () => clock, build: (lock) => { builds += 1; return q1.buildProjection(lock, { allowNonActual: true }); },
  });
  assert.equal(reader.read().state, 'LOCKED_VERIFIED');
  clock += 60_000; reader.read();
  assert.equal(builds, 1);
  clock += 10 * 60_000; reader.read();
  assert.equal(builds, 2);
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')} `);
  assert.equal(reader.read().state, 'INVALID');
  assert.equal(builds, 3);
  clock += 5_000; reader.read();
  assert.equal(builds, 3);
  clock += 20_000; reader.read();
  assert.equal(builds, 4);
});

test('命令行：只对完成权威开放；封存文件路径带 fixture 字样时拒绝，错误码写到 stderr 且不落账', () => {
  const cli = path.join(__dirname, '..', 'apps', 'research-cli', 'import_candidate_comparison.js');
  const env = { ...process.env, QRP_PRODUCT_MILESTONE_AUTHORITY: AUTHORITY };
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  const missing = run([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /MISSING_FLAG:file/);
  const refused = run(['--file', write(), '--registered-by', AUTHORITY]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Q1_RESULT_NON_ACTUAL_SOURCE/);
  const unauthorized = run(['--file', write(), '--registered-by', 'SOMEONE_ELSE']);
  assert.equal(unauthorized.status, 1);
  assert.match(unauthorized.stderr, /BASELINE_LOCK_REGISTERED_BY_NOT_AUTHORIZED|Q1_RESULT_NON_ACTUAL_SOURCE/);
  assert.equal(q1.locks().length, 0);
});

test('Q0 导入行为不变：共享的内部工具没有放宽 Q0 的顶层字段要求，Q0 不要求 oos_reuse', () => {
  const file = fx0.write(fx0.result((doc) => { delete doc.reproducibility; }));
  assert.throws(() => q0.readSealed(file, { allowNonActual: true }), (error) => error.code === 'Q0_RESULT_TOP_LEVEL_MISSING');
  const ok = q0.readSealed(fx0.write(fx0.result()), { allowNonActual: true });
  assert.equal(ok.doc.identity.schema, 'US_V5_M2_Q0_RESULT_V1');
  assert.equal(ok.doc.oos_reuse, undefined);
});
