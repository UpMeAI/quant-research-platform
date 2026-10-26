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
const fx1 = require('./_q1_fixture');
const fx2 = require('./_q2_fixture');
const fx3 = require('./_q3_fixture');
const { quantileRows } = require('../services/candidate-comparison/questions/random_control');

const ROOT = path.join(__dirname, '..');
const { Q1, Q2, Q3 } = cc.QUESTIONS;

let Q0;
beforeEach(() => {
  for (const ledger of [q0.LEDGER(), cc.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); cc.clearCache();
  const doc = fx0.result();
  const lock = q0.importBaselineEvaluation(fx0.write(doc), { registeredBy: AUTHORITY, allowNonActual: true });
  Q0 = { doc, id: lock.result_id, sha: lock.file_sha256 };
});

const make3 = (fn) => fx3.result(Q0.doc, Q0.sha, Q0.id, fn);
const write3 = (fn, options) => fx3.write(make3(fn), options);
const imp = (file, extra = {}) => cc.importCandidateComparison(file, { registeredBy: AUTHORITY, allowNonActual: true, ...extra });
const refuses3 = (fn, code) => assert.throws(() => imp(write3(fn)), (error) => error.code === code, code);
const project3 = (fn) => cc.buildProjection(imp(write3(fn)), { allowNonActual: true, question: 'Q3' });
const block = (projection, key) => projection.blocks.find((item) => item.key === key);
const part = (projection, key) => projection.extra_cards[0].data.parts.find((item) => item.key === key);
const reset = () => fs.rmSync(cc.LEDGER(), { force: true });
/** 同一份 Q0 基线下每个 Q3 结果只能锁一次：同一个测试里要再导入，先清掉 Q3 台账。 */
const fresh = (fn) => { reset(); cc.clearCache(); return project3(fn); };
const setCriteria = (doc, name, value) => { doc.comparison.criteria[name] = value; };
const withPart = (doc, key, patch) => {
  const target = key === 'Q3A' ? doc.random_control : doc.random_control.random_instrument;
  patch(target);
};

// ── 登记项 ──────────────────────────────────────────────────────────────────────

test('Q3 登记项：K2 sha256 对得上冻结文件；候选臂、判据集、常数、样本外期望、敞口、归因、随机对照、参照臂都按 K2 裁定', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, Q3.k2.ref))).digest('hex');
  assert.equal(sha, Q3.k2.sha256);
  assert.equal(Q3.k2.sha256.slice(0, 8), '56d16406');
  assert.ok(fs.existsSync(path.join(ROOT, Q3.profile_ref)));
  assert.equal(Q3.schema, 'US_V5_M2_Q3_RESULT_V1');
  assert.equal(Q3.queue_order, 3);
  assert.equal(Q3.candidate.key, 'CANDIDATE_SECTOR_RS');
  assert.deepEqual(Object.keys(Q3.criteria), ['G1', 'P_G', 'F3']);
  assert.deepEqual([...Q3.run_gates], ['ACCEPTANCE', 'INPUTS', 'BASELINE_REPRO', 'INERT_Q0F', 'INERT_Q1', 'INERT_Q2', 'RANDOM_IDENTITY', 'RS_TABLE_PARITY', 'PROBE']);
  assert.deepEqual([Q3.oos_reuse.expected, Q3.oos_reuse.required_code, Q3.oos_reuse.reason_code, Q3.oos_reuse.detail_required],
    [false, 'OOS_PREVIOUSLY_EVALUATED_SAME_RULE', 'OOS_REUSED_FOR_SELECTION', true]);
  assert.equal(Q3.attribution.required, false);
  assert.equal(Q3.exposure.required, true);
  assert.deepEqual([...Q3.exposure.extra_counts.candidate], ['sector_rs_refusals', 'reorder_instants']);
  assert.equal(Q3.mirror, null);
  assert.ok(Q3.top_level.includes('random_control') && !Q3.top_level.includes('attribution'));
  assert.equal(Q3.random_control.class, 'RANDOM_SELECTION_CONTROL_V1');
  assert.deepEqual([Q3.random_control.support_at, Q3.random_control.fail_at, Q3.random_control.min_choice_points, Q3.random_control.seed_first, Q3.random_control.full_seeds],
    [0.75, 0.50, 30, 20261025, 1000]);
  assert.equal(Q3.reference_arms[0].note_zh, '价格收益，不含分红');
  assert.equal(Q3.extra_cards.length, 1);
  assert.equal(cc.registry.bySchema('US_V5_M2_Q3_RESULT_V1'), Q3);
  // Q1 与 Q2 的登记项没有被动过
  assert.equal(Q1.extra_cards, undefined);
  assert.equal(Q2.extra_cards, undefined);
  assert.equal(Q1.reference_arms, undefined);
  assert.equal(Q2.reference_arms, undefined);
});

test('Q3 导入：锁里写 Q3 的 K2 与导入规格增补；结论是 Q3b 的；Q1、Q2、Q3 的锁在同一台账里各管各的', () => {
  const lock1 = imp(fx1.write(fx1.result(Q0.doc, Q0.sha, Q0.id)));
  const lock2 = imp(fx2.write(fx2.result(Q0.doc, Q0.sha, Q0.id)));
  const lock3 = imp(write3());
  assert.match(lock3.result_id, /^Q3-[0-9a-f]{16}$/);
  assert.equal(lock3.question_ref, 'Q3');
  assert.equal(lock3.verdict_state, 'SUPPORTED');
  assert.equal(lock3.t3_state, null);
  assert.equal(lock3.oos_reuse, false);
  assert.equal(lock3.k2_ref, Q3.k2.ref);
  assert.equal(lock3.profile_ref, 'docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_1.md');
  assert.equal(cc.locks(cc.CASE_REF).length, 3);
  assert.deepEqual(['Q1', 'Q2', 'Q3'].map((question) => cc.headLock(cc.CASE_REF, question).result_id), [lock1.result_id, lock2.result_id, lock3.result_id]);
  assert.equal(imp(write3()).replayHit, true);
  assert.throws(() => imp(write3((doc) => { doc.diagnosis_items[0].facts = ['改过']; })), (error) => error.code === 'COMPARISON_ALREADY_LOCKED');
  assert.deepEqual(cc.ORDER, ['Q1', 'Q2', 'Q3', 'Q4']);
});

test('Q3 主卡：八块按固定顺序（没有归因块）；优势结论是 Q3b 的；采用条件里没有「独立样本不足」；原因码有中文', () => {
  const projection = project3();
  assert.equal(projection.question_ref, 'Q3');
  assert.equal(projection.title_zh, '候选对比：行业 RS 排序层对原版（选对象了吗）');
  assert.deepEqual(projection.blocks.map((item) => item.key), ['question', 'account', 'effect', 'exposure', 'criteria', 'stress', 'verdict', 'forward']);
  assert.ok(projection.blocks.every((item) => item.state === 'AVAILABLE'), JSON.stringify(projection.blocks.map((item) => [item.key, item.reason])));
  assert.equal(projection.verdict_label, '完整账户的对数增长更好（不等于信号 alpha 更大）');
  assert.deepEqual(projection.completeness.lines.map((line) => line.kind), ['edge', 'stress', 'adoption']);
  assert.equal(projection.completeness.lines[2].text, '采用条件：未满足（必要压力缺失，§6.7）');
  const question = block(projection, 'question').data;
  assert.equal(question.oos_reuse.flag, false);
  assert.equal(question.oos_reuse.pill_zh, '同窗复测，不是新的样本外');
  assert.equal(question.oos_reuse.tone, 'DEGRADED');
  assert.match(question.oos_reuse.label, /RS-1 已在同一窗口（2023-01-01 → 2026-09-30）评价过同一规则/);
  assert.match(question.oos_reuse.detail_zh, /排序参数在 RS-1 签署时冻结.*随机名次对照在第 59\.5／68 百分位/);
  const reasons = block(projection, 'verdict').data.reasons;
  assert.deepEqual(reasons.map((item) => item.code), ['OOS_PREVIOUSLY_EVALUATED_SAME_RULE', 'STRESS_SCENARIO_MISSING']);
  assert.match(reasons[0].text, /本题是在当前 D 上的复测（结论不因此封顶）/);
  const criteria = block(projection, 'criteria').data.rows;
  assert.match(criteria[0].text, /且改变的入场（只在一臂出现的「序列 \+ 扫描时点」入场）≥ 30 笔。原版 112 笔；候选 104 笔；改变的入场 41 笔。/);
  assert.match(block(projection, 'verdict').data.method_zh, /先判 G1：G1 不成立一律证据不足/);
  assert.equal(block(projection, 'effect').data.routing, null, 'routing 不适用');
});

test('Q3 的原因码中文标签：G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT 在 Q2 与 Q3 里都有，只在文件带这个码时才显示', () => {
  const insufficient = (doc) => {
    doc.verdict.state = 'INSUFFICIENT'; doc.verdict.L_g = -0.05; doc.verdict.U_g = -0.002;
    doc.comparison.g_vs_baseline.ci_95 = [-0.05, -0.002];
    setCriteria(doc, 'G1', { met: false, baseline_oos_trades: 112, candidate_oos_trades: 104, changed_entries: 12 });
    setCriteria(doc, 'P_G', { met: false }); setCriteria(doc, 'F3', { triggered: true });
    doc.verdict.reason_codes = ['OOS_PREVIOUSLY_EVALUATED_SAME_RULE', 'G1_NOT_MET', 'G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT'];
  };
  const projection = project3(insufficient);
  const reasons = block(projection, 'verdict').data.reasons;
  assert.deepEqual(reasons.map((item) => item.code), ['OOS_PREVIOUSLY_EVALUATED_SAME_RULE', 'G1_NOT_MET', 'G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT']);
  assert.equal(reasons[2].text, 'G1 不成立，而账户年化对数增长差的上沿不高于 0：照报上沿，作待验证的事实，不是经济上的反证（Q2 K2 勘误 1）');
  assert.ok(reasons.every((item) => !item.text.startsWith('原因码')));
  assert.equal(Q2.reason_words.G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT, Q3.reason_words.G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT);
  assert.equal(Q1.reason_words.G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT, undefined, 'Q1 没有这个码，不加');
  reset();
  // G1 先判：G1 不成立时 NOT_PASSED 也拒绝（Q2 勘误 1）
  refuses3((doc) => { insufficient(doc); doc.verdict.state = 'NOT_PASSED'; }, 'Q3_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE');
});

// ── Q3b：配对 g、G1 先判、样本外、敞口 ────────────────────────────────────────────

test('Q3b 判定同 Q2 加勘误 1：SUPPORTED 要 L_g > 0、G1 成立且三个样本数 ≥ 30；NOT_PASSED 要 U_g ≤ 0 且 G1 成立；INSUFFICIENT 随时允许', () => {
  refuses3((doc) => { doc.verdict.L_g = 0; }, 'Q3_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses3((doc) => { doc.verdict.U_g = 0; doc.verdict.L_g = -0.02; }, 'Q3_VERDICT_SUPPORTED_VIOLATES_F3');
  refuses3((doc) => { setCriteria(doc, 'G1', { met: false, baseline_oos_trades: 112, candidate_oos_trades: 104, changed_entries: 12 }); }, 'Q3_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses3((doc) => { doc.comparison.criteria.G1.changed_entries = 29; }, 'Q3_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL');
  refuses3((doc) => { delete doc.comparison.criteria.G1.candidate_oos_trades; }, 'Q3_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL');
  refuses3((doc) => { setCriteria(doc, 'F3', { triggered: true }); }, 'Q3_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses3((doc) => { delete doc.comparison.criteria.P_G; }, 'Q3_CRITERIA_INCOMPLETE');
  refuses3((doc) => { doc.verdict.delta_g = 0.01; }, 'Q3_VERDICT_DELTA_CHANGED');
  refuses3((doc) => { doc.verdict.delta_R = 0.15; }, 'Q3_VERDICT_DELTA_CHANGED');
  refuses3((doc) => { doc.identity.k2.sha256 = Q2.k2.sha256; }, 'Q3_K2_SHA_MISMATCH');
  refuses3((doc) => { doc.verdict.state = 'BLOCKED'; }, 'Q3_VERDICT_STATE_UNSUPPORTED');
  const notPassed = (doc) => {
    doc.verdict.state = 'NOT_PASSED'; doc.verdict.L_g = -0.05; doc.verdict.U_g = -0.002;
    doc.comparison.g_vs_baseline.ci_95 = [-0.05, -0.002]; setCriteria(doc, 'P_G', { met: false }); setCriteria(doc, 'F3', { triggered: true });
  };
  assert.equal(project3(notPassed).verdict_label, '未通过');
  reset();
  assert.equal(project3((doc) => { notPassed(doc); doc.verdict.state = 'INSUFFICIENT'; }).verdict_label, '证据不足');
});

test('Q3b 样本外：oos_reuse 必须 false；必须带 OOS_PREVIOUSLY_EVALUATED_SAME_RULE，不得带 OOS_REUSED_FOR_SELECTION；要写理由', () => {
  refuses3((doc) => { doc.oos_reuse = true; }, 'Q3_OOS_REUSE_MUST_BE_FALSE');
  refuses3((doc) => { doc.verdict.reason_codes = ['STRESS_SCENARIO_MISSING']; }, 'Q3_OOS_PREVIOUS_EVALUATION_NOT_DECLARED');
  refuses3((doc) => { doc.verdict.reason_codes = ['OOS_PREVIOUSLY_EVALUATED_SAME_RULE', 'OOS_REUSED_FOR_SELECTION', 'STRESS_SCENARIO_MISSING']; }, 'Q3_OOS_REUSE_CONTRADICTS_CODE');
  refuses3((doc) => { delete doc.oos_reuse_detail; }, 'Q3_OOS_REUSE_DETAIL_MISSING');
  // Q2 的样本外规则不变：Q2 带这个码不要求，也不禁止
  const q2 = imp(fx2.write(fx2.result(Q0.doc, Q0.sha, Q0.id, (doc) => { doc.verdict.reason_codes = ['OOS_PREVIOUSLY_EVALUATED_SAME_RULE', 'STRESS_SCENARIO_MISSING']; })));
  assert.equal(q2.question_ref, 'Q2');
});

test('Q3b 敞口披露：两臂必填；候选臂另有 sector_rs_refusals 与 reorder_instants（非负整数）；原版臂没写显示「—」', () => {
  const exposure = block(project3(), 'exposure').data;
  assert.deepEqual(exposure.extra_rows.map((row) => [row.key, row.baseline, row.candidate]), [['sector_rs_refusals', null, 31], ['reorder_instants', null, 12]]);
  assert.equal(exposure.candidate.sector_rs_refusals, 31);
  assert.equal(exposure.diff.avg_notional_usd, -60);
  reset();
  const zeros = block(project3((doc) => { doc.comparison.exposure.BASELINE.sector_rs_refusals = 0; doc.comparison.exposure.BASELINE.reorder_instants = 0; }), 'exposure').data;
  assert.deepEqual(zeros.extra_rows.map((row) => row.baseline), [0, 0]);
  refuses3((doc) => { delete doc.comparison.exposure; }, 'Q3_EXPOSURE_DISCLOSURE_MISSING');
  refuses3((doc) => { delete doc.comparison.exposure.CANDIDATE_SECTOR_RS.sector_rs_refusals; }, 'Q3_EXPOSURE_DISCLOSURE_INVALID');
  refuses3((doc) => { doc.comparison.exposure.CANDIDATE_SECTOR_RS.reorder_instants = -1; }, 'Q3_EXPOSURE_DISCLOSURE_INVALID');
  refuses3((doc) => { doc.comparison.exposure.CANDIDATE_SECTOR_RS.reorder_instants = 1.5; }, 'Q3_EXPOSURE_DISCLOSURE_INVALID');
  refuses3((doc) => { delete doc.comparison.exposure.BASELINE; }, 'Q3_EXPOSURE_DISCLOSURE_MISSING');
});

test('Q3 运行门：K2 点名的九道门都在且 PASSED；Q1 的孪生门与 Q2 的归因门不要求', () => {
  for (const name of Q3.run_gates) refuses3((doc) => { doc.gates[name] = { state: 'FAILED' }; }, 'Q3_RUN_GATE_NOT_PASSED');
  refuses3((doc) => { delete doc.gates.RS_TABLE_PARITY; }, 'Q3_RUN_GATE_NOT_PASSED');
  refuses3((doc) => { delete doc.gates.INERT_Q2; }, 'Q3_RUN_GATE_NOT_PASSED');
  assert.ok(!Q3.run_gates.includes('TWIN_PARITY') && !Q3.run_gates.includes('ATTRIBUTION_RECONCILE'));
  refuses3((doc) => { delete doc.random_control; }, 'Q3_RESULT_TOP_LEVEL_MISSING');
});

// ── 参照臂 ──────────────────────────────────────────────────────────────────────

test('参照臂 EQUAL_WEIGHT_1X_BUY_HOLD：只报不判；页面标「价格收益，不含分红」；缺了拒绝；也认放在 arms 里；读不出来只坏那一行', () => {
  const account = block(project3(), 'account').data;
  assert.deepEqual(account.arms.map((arm) => arm.key), ['BASELINE', 'CANDIDATE_SECTOR_RS'], '参照臂不在比较臂里（A4：SPY 与现金只在回测结论卡）');
  assert.equal(account.benchmark_note_zh, '基准见回测结论卡');
  assert.equal(account.reference_arms.length, 1);
  const [reference] = account.reference_arms;
  assert.deepEqual([reference.key, reference.label, reference.note_zh, reference.report_only], ['EQUAL_WEIGHT_1X_BUY_HOLD', '等权买入持有（15 只 1× 多头）', '价格收益，不含分红', true]);
  assert.equal(reference.cagr, 0.14);
  assert.equal(reference.unavailable_zh, undefined);
  assert.equal(account.diff_vs_baseline.end_capital, account.arms[1].end_capital - account.arms[0].end_capital, '差值只在候选与原版之间，参照臂不进');
  reset();
  refuses3((doc) => { delete doc.reference_arms; }, 'Q3_REFERENCE_ARM_MISSING');
  refuses3((doc) => { doc.reference_arms = {}; }, 'Q3_REFERENCE_ARM_MISSING');
  const inArms = project3((doc) => { doc.arms.EQUAL_WEIGHT_1X_BUY_HOLD = doc.reference_arms.EQUAL_WEIGHT_1X_BUY_HOLD; delete doc.reference_arms; });
  assert.equal(block(inArms, 'account').data.reference_arms[0].end_capital, account.reference_arms[0].end_capital);
  reset();
  const broken = project3((doc) => { delete doc.reference_arms.EQUAL_WEIGHT_1X_BUY_HOLD.summary.cagr; });
  assert.equal(block(broken, 'account').state, 'AVAILABLE', '参照行读不出来不让账户块失败');
  assert.match(block(broken, 'account').data.reference_arms[0].unavailable_zh, /reference_arms\.EQUAL_WEIGHT_1X_BUY_HOLD\.summary\.cagr/);
  reset();
  const drift = project3((doc) => { doc.reference_arms.EQUAL_WEIGHT_1X_BUY_HOLD.summary.end_capital += 5; });
  assert.match(block(drift, 'account').data.reference_arms[0].unavailable_zh, /与权益序列末点不一致/);
});

// ── 随机选择对照 ────────────────────────────────────────────────────────────────

test('随机对照卡：Q3a 只有 7 个选择点，G1 不成立，明说证据不足；Q3a2 胜过 81%，有支持证据；两者与 Q3b 的结论互不影响', () => {
  const projection = project3();
  assert.equal(projection.extra_cards.length, 1);
  const card = projection.extra_cards[0];
  assert.deepEqual([card.key, card.state, card.title_zh], ['random_control', 'AVAILABLE', '随机选择对照（Q3a 候选顺序随机；Q3a2 随机标的）']);
  assert.equal(card.data.class, 'RANDOM_SELECTION_CONTROL_V1');
  assert.deepEqual(card.data.parts.map((item) => item.key), ['Q3A', 'Q3A2']);

  const q3a = part(projection, 'Q3A');
  assert.equal(q3a.state, 'AVAILABLE');
  assert.equal(q3a.verdict_state, 'INSUFFICIENT');
  assert.equal(q3a.state_label, '证据不足（G1 不成立）');
  assert.equal(q3a.plain_zh, '选择点太少：OOS 7 个，200 个种子的运行只作描述，不判');
  assert.deepEqual(q3a.basis, { title: '判定依据', main: ['G1 不成立：OOS 选择点 7 个，低于门槛 30 个'], also: ['基线账户 g 胜过 62.0% 的随机种子（相等算一半），只作描述，不判'], frozen_zh: '门槛在看到结果前已冻结' });
  assert.deepEqual(q3a.g1, { met: false, oos: 7, is: 2, is_reason_zh: null, required: 30, definition_zh: '同一扫描时点至少一笔开仓，同时另有一个通过全部信号级闸门的同时点候选被容量规则拒绝' });
  assert.deepEqual([q3a.seeds.n, q3a.seeds.first, q3a.seeds.last], [200, 20261025, 20261224]);
  assert.deepEqual(q3a.reasons.map((item) => item.text), ['选择点太少（G1 不成立）']);

  const q3a2 = part(projection, 'Q3A2');
  assert.equal(q3a2.verdict_state, 'SUPPORTED');
  assert.equal(q3a2.state_label, '有支持证据');
  assert.equal(q3a2.tone, 'VALID');
  assert.equal(q3a2.plain_zh, '基线账户 g 胜过 81.0% 的随机种子（相等算一半）');
  assert.deepEqual(q3a2.basis.main, ['基线账户 g 胜过 81.0% 的随机种子（相等算一半），不低于门槛 75%；G1 成立（OOS 选择点 112 个，门槛 30 个）']);
  assert.deepEqual(q3a2.g1, { met: true, oos: 112, is: null, is_reason_zh: 'Q3a2 只跑样本外（K2 裁定 1），开发期不跑', required: 30, definition_zh: '同一扫描时点至少一笔开仓，同时另有一个通过全部信号级闸门的同时点候选被容量规则拒绝' }, 'Q3a2 只跑 OOS：is 为 null 带原因，G1 只数 OOS');
  assert.deepEqual([q3a2.seeds.n, q3a2.seeds.last], [1000, 20262024]);
  assert.equal(q3a2.statistic.share_beaten_g, 0.81);
  assert.equal(q3a2.baseline.g, -0.016);
  assert.equal(q3a2.net_R_position.share_beaten_net_R, 0.5);
  assert.match(q3a2.net_R_position.note_zh, /只报告，不参与判定/);
  assert.deepEqual(q3a2.distribution.g.map((row) => row.q), ['5%', '25%', '50%', '75%', '95%']);
  assert.equal(q3a2.distribution.g[2].value, 0.003);

  // 互不影响：Q3b 的结论还是 Q3b 自己的；随机对照的结论不出现在主卡里
  assert.equal(projection.verdict_state, 'SUPPORTED');
  assert.ok(!JSON.stringify(projection.blocks).includes('RANDOM_SELECTION_CONTROL_V1'));
  reset();
  // Q3b 未通过而随机对照有支持证据（反过来也行），两边都能导入
  const mixed = project3((doc) => {
    doc.verdict.state = 'NOT_PASSED'; doc.verdict.L_g = -0.05; doc.verdict.U_g = -0.002;
    doc.comparison.g_vs_baseline.ci_95 = [-0.05, -0.002]; setCriteria(doc, 'P_G', { met: false }); setCriteria(doc, 'F3', { triggered: true });
  });
  assert.equal(mixed.verdict_state, 'NOT_PASSED');
  assert.equal(part(mixed, 'Q3A2').verdict_state, 'SUPPORTED');
});

test('随机对照的三态：≥ 0.75 才可 SUPPORTED，≤ 0.50 才可 NOT_PASSED，G1 先判；比例与种子数不够就拒绝；INSUFFICIENT 随时允许', () => {
  const set = (patch) => (doc) => withPart(doc, 'Q3A2', patch);
  refuses3(set((p) => { p.baseline.share_beaten_g = 0.74; }), 'Q3_RANDOM_CONTROL_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  assert.equal(part(project3(set((p) => { p.baseline.share_beaten_g = 0.75; })), 'Q3A2').verdict_state, 'SUPPORTED');
  reset();
  refuses3(set((p) => { p.seeds = { rule: 'x', n: 200, first: 20261025, last: 20261224 }; }), 'Q3_RANDOM_CONTROL_SEEDS_INSUFFICIENT');
  refuses3(set((p) => { p.verdict.state = 'NOT_PASSED'; p.baseline.share_beaten_g = 0.51; }), 'Q3_RANDOM_CONTROL_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE');
  assert.equal(part(project3(set((p) => { p.verdict.state = 'NOT_PASSED'; p.baseline.share_beaten_g = 0.50; })), 'Q3A2').state_label, '未通过');
  reset();
  refuses3(set((p) => { p.verdict.state = 'NOT_PASSED'; p.baseline.share_beaten_g = 0.4; p.seeds.n = 999; p.seeds.last = 20262023; }), 'Q3_RANDOM_CONTROL_SEEDS_INSUFFICIENT');
  // G1 先判：选择点不够，只能是证据不足并写 G1_NOT_MET，不管比例多极端
  refuses3(set((p) => { p.choice_points.oos = 29; }), 'Q3_RANDOM_CONTROL_VERDICT_WITHOUT_G1');
  refuses3(set((p) => { p.choice_points.oos = 29; p.verdict.state = 'NOT_PASSED'; p.baseline.share_beaten_g = 0.1; }), 'Q3_RANDOM_CONTROL_VERDICT_WITHOUT_G1');
  refuses3(set((p) => { p.choice_points.oos = 29; p.verdict.state = 'INSUFFICIENT'; p.verdict.reason_codes = []; }), 'Q3_RANDOM_CONTROL_G1_NOT_DECLARED');
  refuses3((doc) => withPart(doc, 'Q3A', (p) => { p.verdict.state = 'SUPPORTED'; p.baseline.share_beaten_g = 0.9; p.seeds = { rule: 'x', n: 1000, first: 20261025, last: 20262024 }; }), 'Q3_RANDOM_CONTROL_VERDICT_WITHOUT_G1');
  assert.equal(part(project3(set((p) => { p.choice_points.oos = 30; p.baseline.share_beaten_g = 0.6; p.verdict.state = 'INSUFFICIENT'; })), 'Q3A2').g1.met, true);
  reset();
  // INSUFFICIENT 随时允许（过线也可以保守地判证据不足）
  assert.equal(part(project3(set((p) => { p.verdict.state = 'INSUFFICIENT'; })), 'Q3A2').verdict_state, 'INSUFFICIENT');
});

test('Q3a2 只跑样本外（K2 裁定 1）：is 为 null 且带 is_reason_zh 时接受，G1 只数 OOS 选择点；null 不带原因、Q3a 的 null、非整数仍拒绝；整数照旧接受', () => {
  // 默认夹具的 Q3a2 就是 is:null + is_reason_zh（见 _q3_fixture.js）
  const q3a2 = part(fresh(), 'Q3A2');
  assert.equal(q3a2.g1.is, null);
  assert.equal(q3a2.g1.is_reason_zh, 'Q3a2 只跑样本外（K2 裁定 1），开发期不跑');
  assert.equal(q3a2.g1.met, true);
  // G1 只数 OOS：开发期没有数，OOS 不够就是不成立
  const few = part(fresh((doc) => withPart(doc, 'Q3A2', (p) => { p.choice_points.oos = 12; p.verdict.state = 'INSUFFICIENT'; p.verdict.reason_codes = ['G1_NOT_MET']; })), 'Q3A2');
  assert.deepEqual([few.g1.met, few.g1.oos, few.g1.is], [false, 12, null]);
  assert.match(few.basis.main[0], /^G1 不成立：OOS 选择点 12 个，低于门槛 30 个$/);
  // 原因也可以用不带 _zh 的键
  assert.equal(part(fresh((doc) => withPart(doc, 'Q3A2', (p) => { delete p.choice_points.is_reason_zh; p.choice_points.is_reason = 'OOS only'; })), 'Q3A2').g1.is_reason_zh, 'OOS only');
  // null 必须带原因；原因不能是空串；只有 Q3a2 可以没有开发期选择点
  refuses3((doc) => withPart(doc, 'Q3A2', (p) => { delete p.choice_points.is_reason_zh; }), 'Q3_RANDOM_CONTROL_CHOICE_POINTS_INVALID');
  refuses3((doc) => withPart(doc, 'Q3A2', (p) => { p.choice_points.is_reason_zh = '  '; }), 'Q3_RANDOM_CONTROL_CHOICE_POINTS_INVALID');
  refuses3((doc) => withPart(doc, 'Q3A', (p) => { p.choice_points.is = null; p.choice_points.is_reason_zh = '不跑'; }), 'Q3_RANDOM_CONTROL_CHOICE_POINTS_INVALID');
  refuses3((doc) => withPart(doc, 'Q3A2', (p) => { p.choice_points.is = 'many'; }), 'Q3_RANDOM_CONTROL_CHOICE_POINTS_INVALID');
  refuses3((doc) => withPart(doc, 'Q3A2', (p) => { p.choice_points.is = -1; }), 'Q3_RANDOM_CONTROL_CHOICE_POINTS_INVALID');
  // 整数照旧接受（其他结果文件或以后的版本）
  assert.equal(part(fresh((doc) => withPart(doc, 'Q3A2', (p) => { p.choice_points.is = 40; delete p.choice_points.is_reason_zh; })), 'Q3A2').g1.is, 40);
});

test('随机对照的判定依据（A4 D1）：G1 不成立写笔数对门槛；成立时写比例对 75%／50% 线；原因码未登记的折叠，不在主内容写原码', () => {
  const dist = (share, state, codes = []) => part(fresh((doc) => withPart(doc, 'Q3A2', (p) => { p.baseline.share_beaten_g = share; p.verdict.state = state; p.verdict.reason_codes = codes; })), 'Q3A2');
  assert.match(dist(0.75, 'SUPPORTED').basis.main[0], /不低于门槛 75%；G1 成立（OOS 选择点 112 个，门槛 30 个）$/);
  assert.match(dist(0.50, 'NOT_PASSED').basis.main[0], /不高于门槛 50%；G1 成立/);
  assert.match(dist(0.62, 'INSUFFICIENT').basis.main[0], /介于门槛 50% 与 75% 之间，既不够支持也不够否定；G1 成立/);
  const unknown = dist(0.62, 'INSUFFICIENT', ['G1_NOT_MET_X', 'DESCRIPTIVE_ONLY', 'SOME_NEW_CODE']);
  assert.deepEqual(unknown.reasons.map((item) => item.text), ['种子运行只作描述，不判']);
  assert.deepEqual(unknown.unknown_reason_codes, ['G1_NOT_MET_X', 'SOME_NEW_CODE']);
});

test('随机对照的结构：两部分都必填；类别、种子起点、选择点、统计量、分布缺或被改都拒绝；G1 布尔与选择点不符拒绝', () => {
  refuses3((doc) => { delete doc.random_control.random_instrument; }, 'Q3_RANDOM_CONTROL_PART_MISSING');
  refuses3((doc) => { doc.random_control = 'x'; }, 'Q3_RANDOM_CONTROL_MISSING');
  refuses3((doc) => withPart(doc, 'Q3A', (p) => { p.verdict.class = 'CANDIDATE_COMPARISON_V1'; }), 'Q3_RANDOM_CONTROL_CLASS_UNSUPPORTED');
  refuses3((doc) => withPart(doc, 'Q3A2', (p) => { p.verdict.state = 'MAYBE'; }), 'Q3_RANDOM_CONTROL_STATE_UNSUPPORTED');
  refuses3((doc) => withPart(doc, 'Q3A', (p) => { p.seeds.first = 1; p.seeds.last = 200; }), 'Q3_RANDOM_CONTROL_SEEDS_CHANGED');
  refuses3((doc) => withPart(doc, 'Q3A', (p) => { p.seeds.last += 1; }), 'Q3_RANDOM_CONTROL_SEEDS_CHANGED');
  refuses3((doc) => withPart(doc, 'Q3A', (p) => { delete p.seeds; }), 'Q3_RANDOM_CONTROL_SEEDS_CHANGED');
  refuses3((doc) => withPart(doc, 'Q3A2', (p) => { p.choice_points.oos = 'many'; }), 'Q3_RANDOM_CONTROL_CHOICE_POINTS_INVALID');
  refuses3((doc) => withPart(doc, 'Q3A2', (p) => { delete p.choice_points; }), 'Q3_RANDOM_CONTROL_CHOICE_POINTS_INVALID');
  refuses3((doc) => withPart(doc, 'Q3A2', (p) => { p.choice_points.g1_met = false; }), 'Q3_RANDOM_CONTROL_G1_DISAGREES');
  refuses3((doc) => withPart(doc, 'Q3A', (p) => { p.choice_points.g1_met = true; }), 'Q3_RANDOM_CONTROL_G1_DISAGREES');
  refuses3((doc) => withPart(doc, 'Q3A2', (p) => { p.baseline.share_beaten_g = 1.2; }), 'Q3_RANDOM_CONTROL_STATISTIC_INVALID');
  refuses3((doc) => withPart(doc, 'Q3A2', (p) => { delete p.baseline.share_beaten_g; }), 'Q3_RANDOM_CONTROL_STATISTIC_INVALID');
  refuses3((doc) => withPart(doc, 'Q3A', (p) => { delete p.distribution; }), 'Q3_RANDOM_CONTROL_DISTRIBUTION_MISSING');
  refuses3((doc) => withPart(doc, 'Q3A', (p) => { delete p.distribution.g; }), 'Q3_RANDOM_CONTROL_DISTRIBUTION_MISSING');
  // 缺的是显示用的东西：不拒绝，页面照常（分位数写成数组也认；净 R 的分布可以没有）
  const arrays = project3((doc) => withPart(doc, 'Q3A2', (p) => {
    p.distribution = { g: [{ q: 0.05, value: -0.05 }, { q: 0.5, value: 0 }, { q: 0.95, value: 0.07 }] };
    delete p.baseline.net_R; delete p.baseline.share_beaten_net_R; delete p.baseline.percentile_g;
  }));
  const rows = part(arrays, 'Q3A2');
  assert.deepEqual(rows.distribution.g.map((row) => row.q), ['0.05%', '0.5%', '0.95%']);
  assert.deepEqual(rows.distribution.net_R, []);
  assert.equal(rows.baseline.net_R, null);
  assert.equal(rows.net_R_position.share_beaten_net_R, null);
  assert.equal(rows.statistic.percentile_g, null);
});

test('分位数表的读法：键 → 数 与 [{q,value}] 两种；p05／q50／min／max／median 给人话', () => {
  assert.deepEqual(quantileRows({ p05: -1, p50: 0, p95: 1, min: -3, max: 3, median: 0.1 }).map((row) => row.q), ['5%', '50%', '95%', '最小值', '最大值', '中位数']);
  assert.deepEqual(quantileRows({ q25: 1, q75: 2 }).map((row) => row.q), ['25%', '75%']);
  assert.deepEqual(quantileRows([{ p: 25, v: 1 }, { quantile: 'median', g: 2 }, { q: 'p90', value: 3 }, { q: 'bad', value: 'x' }]).map((row) => [row.q, row.value]),
    [['25%', 1], ['中位数', 2], ['90%', 3]]);
  assert.deepEqual(quantileRows('x'), []);
  assert.deepEqual(quantileRows(null), []);
});

test('随机对照一部分的显示读不出来：只坏这一部分，另一部分和 Q3b 主卡照常', () => {
  // 单元：直接对登记项的卡构造器给一份「Q3a 被删掉」的文件（导入时会被拒绝，所以绕过导入只测构造器）
  const doc = make3();
  delete doc.random_control.baseline;
  const card = Q3.extra_cards[0].build(Q3, doc);
  assert.equal(card.parts.find((item) => item.key === 'Q3A').state, 'NOT_COMPLETED');
  assert.match(card.parts.find((item) => item.key === 'Q3A').reason, /random_control|baseline|share|undefined|字段|缺/);
  assert.equal(card.parts.find((item) => item.key === 'Q3A2').state, 'AVAILABLE');
});

test('Q3 文件锁定后被改：只让 Q3 的主卡与随机对照卡失败关闭（没有额外卡片），Q1、Q2 不受影响', () => {
  const file1 = fx1.write(fx1.result(Q0.doc, Q0.sha, Q0.id));
  const lock1 = imp(file1);
  const file3 = write3();
  const lock3 = imp(file3);
  fs.writeFileSync(file3, `${fs.readFileSync(file3, 'utf8')} `);
  const bad = cc.buildProjection(lock3, { allowNonActual: true, question: 'Q3' });
  assert.equal(bad.state, 'INVALID');
  assert.equal(bad.question_ref, 'Q3');
  assert.equal(bad.reason_code, 'Q3_RESULT_SHA256_MISMATCH');
  assert.deepEqual(bad.blocks.map((item) => item.key), Q3.blocks.map(([key]) => key));
  assert.ok(bad.blocks.every((item) => item.state === 'NOT_COMPLETED' && item.data === null));
  assert.equal(bad.extra_cards, undefined);
  assert.equal(cc.buildProjection(lock1, { allowNonActual: true }).state, 'LOCKED_VERIFIED');
});

test('题目选择与错误码：Q3 文件按 identity.schema 找到 Q3 登记项，错误码前缀是 Q3_；Q2 的文件不会被当成 Q3', () => {
  assert.equal(cc.readSealed(write3(), { allowNonActual: true }).entry, Q3);
  assert.throws(() => imp(write3(undefined, { tamperSidecar: true })), (error) => error.code === 'Q3_RESULT_SHA256_MISMATCH');
  assert.throws(() => imp(write3((doc) => { delete doc.comparison; })), (error) => error.code === 'Q3_RESULT_TOP_LEVEL_MISSING');
  assert.throws(() => imp(write3(), { question: 'Q2' }), (error) => error.code === 'Q2_RESULT_SCHEMA_UNSUPPORTED');
  assert.throws(() => imp(fx2.write(fx2.result(Q0.doc, Q0.sha, Q0.id)), { question: 'Q3' }), (error) => error.code === 'Q3_RESULT_SCHEMA_UNSUPPORTED');
  assert.equal(imp(write3(), { question: 'Q3' }).question_ref, 'Q3');
  // 基线链同 Q1、Q2
  assert.throws(() => imp(write3((doc) => { doc.arms.BASELINE.summary.cagr = 0.5; })), (error) => error.code === 'Q3_BASELINE_ARM_DIFFERS_FROM_Q0');
});

test('读模型的卡片列表：Q1、Q2、Q3 按队列排，每个已锁定的题目一张主卡；Q3 的主卡带一张随机对照卡', () => {
  imp(fx1.write(fx1.result(Q0.doc, Q0.sha, Q0.id)));
  imp(fx2.write(fx2.result(Q0.doc, Q0.sha, Q0.id)));
  imp(write3());
  const cards = cc.createProjectionReader({ build: (lock, question) => cc.buildProjection(lock, { allowNonActual: true, question }) }).readAll();
  assert.deepEqual(cards.map((card) => [card.question_ref, card.state]), [['Q1', 'LOCKED_VERIFIED'], ['Q2', 'LOCKED_VERIFIED'], ['Q3', 'LOCKED_VERIFIED']]);
  assert.deepEqual(cards.map((card) => (card.extra_cards || []).length), [0, 0, 1]);
});
