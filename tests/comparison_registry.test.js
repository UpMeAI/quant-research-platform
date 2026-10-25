'use strict';
require('./_env');
const test = require('node:test');
const { beforeEach } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const q0 = require('../services/baseline-evaluation');
const cc = require('../services/candidate-comparison');
const fx0 = require('./_q0_fixture');
const fx1 = require('./_q1_fixture');
const fx2 = require('./_q2_fixture');

const ROOT = path.join(__dirname, '..');
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const { Q1, Q2 } = cc.QUESTIONS;

let Q0;
beforeEach(() => {
  for (const ledger of [q0.LEDGER(), cc.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); cc.clearCache();
  const doc = fx0.result();
  const lock = q0.importBaselineEvaluation(fx0.write(doc), { registeredBy: AUTHORITY, allowNonActual: true });
  Q0 = { doc, id: lock.result_id, sha: lock.file_sha256 };
});

const make2 = (fn) => fx2.result(Q0.doc, Q0.sha, Q0.id, fn);
const write2 = (fn, options) => fx2.write(make2(fn), options);
const imp = (file, extra = {}) => cc.importCandidateComparison(file, { registeredBy: AUTHORITY, allowNonActual: true, ...extra });
const refuses2 = (fn, code, extra = {}) => assert.throws(() => imp(write2(fn), extra), (error) => error.code === code, code);
const project2 = (fn) => cc.buildProjection(imp(write2(fn)), { allowNonActual: true, question: 'Q2' });
const block = (projection, key) => projection.blocks.find((item) => item.key === key);
const setCriteria = (doc, name, value) => { doc.comparison.criteria[name] = value; };

// ── 登记项本身 ──────────────────────────────────────────────────────────────────

test('登记项：按题目 id 登记，队列顺序 Q1、Q2；K2 路径与 sha256 对得上仓库里冻结的 K2 文件，导入规格文件存在', () => {
  assert.deepEqual(cc.ORDER, ['Q1', 'Q2']);
  assert.deepEqual(Object.keys(cc.QUESTIONS), ['Q1', 'Q2']);
  assert.equal(new Set(Object.values(cc.QUESTIONS).map((entry) => entry.schema)).size, 2, 'schema 唯一');
  for (const entry of Object.values(cc.QUESTIONS)) {
    assert.equal(sha256File(entry.k2.ref), entry.k2.sha256, `${entry.question_ref} 的 K2 sha256 要等于冻结文件的实际 sha256`);
    assert.ok(fs.existsSync(path.join(ROOT, entry.profile_ref)), `${entry.question_ref} 的导入规格文件存在：${entry.profile_ref}`);
    assert.match(entry.k2.sha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.code_prefix, entry.question_ref);
    assert.ok(entry.candidate.keys.includes(entry.candidate.key));
    assert.ok(entry.top_level.includes('oos_reuse') && entry.top_level.includes('comparison'));
    assert.equal(typeof entry.constants, 'function');
    assert.equal(typeof entry.checkVerdict, 'function');
    // 每个块都有构造器（通用的三块加登记项自己的）
    const generic = ['account', 'stress', 'forward'];
    const own = Object.keys(entry.builders(entry, {}));
    for (const [key] of entry.blocks) assert.ok(generic.includes(key) || own.includes(key), `${entry.question_ref} 的块 ${key} 没有构造器`);
  }
  assert.equal(Q2.k2.sha256.slice(0, 8), '660237c8');
  assert.equal(Q1.k2.sha256.slice(0, 8), '84c96c28');
  assert.equal(cc.registry.bySchema('US_V5_M2_Q2_RESULT_V1'), Q2);
  assert.equal(cc.registry.bySchema('US_V5_M2_Q9_RESULT_V1'), null);
});

test('登记项的内容：Q1 = 改造前写死的值；Q2 = K2 裁定 4–6', () => {
  assert.equal(Q1.candidate.key, 'CANDIDATE_T3');
  assert.deepEqual(Object.keys(Q1.criteria), ['G1', 'P1', 'P2', 'P3', 'P4', 'F1', 'F2', 'F3']);
  assert.deepEqual([Q1.oos_reuse.expected, Q1.oos_reuse.reason_code], [true, 'OOS_REUSED_FOR_SELECTION']);
  assert.equal(Q1.attribution.required, false);
  assert.equal(Q1.mirror.field, 't3_state');
  assert.equal(Q1.run_gates.length, 7);

  assert.equal(Q2.candidate.key, 'CANDIDATE_1X');
  assert.deepEqual(Object.keys(Q2.criteria), ['G1', 'P_G', 'F3']);
  assert.deepEqual([Q2.oos_reuse.expected, Q2.oos_reuse.reason_code, Q2.oos_reuse.detail_required], [false, 'OOS_REUSED_FOR_SELECTION', true]);
  assert.equal(Q2.attribution.required, true);
  assert.equal(Q2.exposure.required, true);
  assert.equal(Q2.mirror, null);
  assert.deepEqual([...Q2.run_gates], ['ACCEPTANCE', 'INPUTS', 'BASELINE_REPRO', 'INERT_Q0F', 'INERT_Q1', 'ROUTING_CENSUS', 'ATTRIBUTION_RECONCILE', 'PROBE']);
  assert.ok(Q2.top_level.includes('attribution') && !Q1.top_level.includes('attribution'));
  assert.equal(Q2.edge_labels.SUPPORTED, '完整账户的对数增长更好（不等于信号 alpha 更大）');
});

// ── Q1 的登记项逐项复现今天的行为 ────────────────────────────────────────────────

test('真实的 Q1 封存文件：同一个 result_id、同一份锁字段、同一份投影（对照改造前导出的金标）', () => {
  const q0File = path.join(ROOT, 'var/evidence/us-v5-m2-q0-current-2026-10-25/US_V5_M2_Q0_RESULT_V1.json');
  const q1File = path.join(ROOT, 'var/evidence/us-v5-m2-q1-2026-10-25/US_V5_M2_Q1_RESULT_V1.json');
  for (const ledger of [q0.LEDGER(), cc.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.importBaselineEvaluation(q0File, { registeredBy: AUTHORITY });
  const lock = cc.importCandidateComparison(q1File, { registeredBy: AUTHORITY });
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'q1_real_projection.json'), 'utf8'));
  assert.equal(lock.result_id, 'Q1-52d8296ffb10626b');
  assert.equal(lock.result_id, golden.result_id);
  assert.deepEqual(Object.keys(lock).sort(), golden.lock_keys);
  assert.equal(lock.question_ref, 'Q1');
  assert.equal(lock.verdict_state, 'INSUFFICIENT');
  assert.equal(lock.t3_state, 'INSUFFICIENT');
  assert.equal(lock.k2_ref, Q1.k2.ref);
  assert.equal(lock.profile_ref, 'docs/contracts/US_V5_M2_Q1_RESULT_V1_IMPORT_PROFILE.md');
  assert.equal(cc.importCandidateComparison(q1File, { registeredBy: AUTHORITY }).replayHit, true, '同一文件重放幂等');

  const projection = cc.buildProjection(lock);
  const { title_zh: title, ...rest } = projection;
  assert.equal(title, '候选对比：T3 对原版');
  const normalized = { ...rest, source: { ...rest.source, file_ref: '<path>', locked_at: '<t>', locked_by: '<who>' } };
  assert.deepEqual(normalized, golden.projection, '改造后的 Q1 投影必须与改造前逐字段相同（只多了 title_zh）');
  assert.ok(projection.blocks.every((item) => item.state === 'AVAILABLE'));
  // 也走自动判断：不指定题目，按 identity.schema 找到 Q1
  assert.equal(cc.readSealed(q1File).entry, Q1);
  assert.equal(cc.readSealed(q1File, { question: 'Q1' }).entry, Q1);
});

// ── Q2 的登记项 ─────────────────────────────────────────────────────────────────

test('Q2 导入：按 identity.schema 找到登记项，锁里写 Q2 的 K2 与导入规格；Q1 与 Q2 的锁在同一台账里各管各的', () => {
  const q1Doc = fx1.result(Q0.doc, Q0.sha, Q0.id);
  const lock1 = imp(fx1.write(q1Doc));
  const lock2 = imp(write2());
  assert.equal(lock2.schema, 'COMPARISON_EVALUATION_LOCK_V1');
  assert.match(lock2.result_id, /^Q2-[0-9a-f]{16}$/);
  assert.equal(lock2.question_ref, 'Q2');
  assert.equal(lock2.verdict_state, 'SUPPORTED');
  assert.equal(lock2.t3_state, null);
  assert.equal(lock2.oos_reuse, false);
  assert.equal(lock2.k2_ref, Q2.k2.ref);
  assert.equal(lock2.profile_ref, Q2.profile_ref);
  assert.equal(lock2.baseline_result_id, Q0.id);
  assert.equal(cc.headLock(cc.CASE_REF, 'Q1').result_id, lock1.result_id);
  assert.equal(cc.headLock(cc.CASE_REF, 'Q2').result_id, lock2.result_id);
  assert.equal(cc.locks(cc.CASE_REF).length, 2);
  // 同一题只锁一次：再导入另一份 Q2 要 supersede；Q1 的锁不受影响
  assert.throws(() => imp(write2((doc) => { doc.diagnosis_items[0].facts = ['改过']; })), (error) => error.code === 'COMPARISON_ALREADY_LOCKED');
  assert.equal(cc.headLock(cc.CASE_REF, 'Q1').result_id, lock1.result_id);
  const replay = imp(write2());
  assert.equal(replay.replayHit, true);
});

test('Q2 的页面投影：九块按固定顺序；优势结论写「完整账户的对数增长更好」；采用条件里没有「独立样本不足」', () => {
  const projection = project2();
  assert.equal(projection.question_ref, 'Q2');
  assert.equal(projection.title_zh, '候选对比：1× 载体对原版（收益来自信号还是杠杆）');
  assert.deepEqual(projection.blocks.map((item) => item.key), ['question', 'account', 'effect', 'exposure', 'criteria', 'stress', 'attribution', 'verdict', 'forward']);
  assert.ok(projection.blocks.every((item) => item.state === 'AVAILABLE'), JSON.stringify(projection.blocks.map((item) => [item.key, item.reason])));
  assert.equal(projection.verdict_label, '完整账户的对数增长更好（不等于信号 alpha 更大）');
  const lines = projection.completeness.lines;
  assert.deepEqual(lines.map((line) => line.kind), ['edge', 'stress', 'adoption']);
  assert.equal(lines[0].text, '优势结论：完整账户的对数增长更好（不等于信号 alpha 更大）');
  assert.match(lines[1].text, /^压力评价不完整：缺场景 1 个、无效输入 1 个（/);
  assert.equal(lines[2].text, '采用条件：未满足（必要压力缺失，§6.7）');
  assert.equal(projection.completeness.adoption_met, false);

  const account = block(projection, 'account').data;
  assert.deepEqual(account.arms.map((arm) => [arm.key, arm.label]), [['BASELINE', '原版（当前 D）'], ['CANDIDATE_1X', '候选 1× 载体'], ['SPY_BUY_HOLD', 'SPY 买入持有'], ['CASH', '现金']]);
  assert.ok(account.arms.every((arm) => arm.deferred_sessions === null));
  const question = block(projection, 'question').data;
  assert.deepEqual(question.populations, []);
  assert.equal(question.oos_reuse.flag, false);
  assert.match(question.oos_reuse.detail_zh, /没有用于选择载体杠杆.*同一窗口被其他 US_V5 研究读过/);
  assert.equal(block(projection, 'forward').data.reason_zh, 'HK 没有 1× 路由的前向影子');
  assert.deepEqual(block(projection, 'forward').data.rows, []);
});

test('Q2 完整压力时：只有优势结论一行（没有样本外复用，也就没有「采用条件」行）', () => {
  const projection = project2((doc) => {
    doc.stress.rows = doc.stress.rows.filter((row) => !['WINDOW_2020_02_19_04_30', 'EXTREME_DOWNTURN_2008'].includes(row.scenario));
    doc.verdict.reason_codes = [];
  });
  assert.deepEqual(projection.completeness.lines.map((line) => line.kind), ['edge']);
  assert.equal(projection.completeness.complete, true);
  assert.equal(projection.completeness.adoption_met, true);
});

test('Q2 的判据与效应块：g 只有 95% 区间；次指标对 +0.10 R 标位置、不参与判定；路由、单股 2× 另列', () => {
  const projection = project2();
  const effect = block(projection, 'effect').data;
  assert.equal(effect.layout, 'paired_g');
  assert.deepEqual(effect.g, { value: 0.021, ci_95: { lo: 0.004, hi: 0.039 } });
  assert.equal(effect.delta_R, 0.10);
  assert.equal(effect.secondary.literal.position_zh, '95% 区间跨过 +0.10 R');
  assert.equal(effect.secondary.paired.position_zh, '95% 区间跨过 +0.10 R');
  assert.deepEqual([effect.secondary.paired.n_paired, effect.secondary.paired.n_baseline_only, effect.secondary.paired.n_candidate_only], [80, 20, 14]);
  assert.match(effect.secondary.not_in_verdict_zh, /不参与判定/);
  assert.equal(effect.routing.changed_entries, 45);
  assert.equal(effect.routing.fallback_to_next, 3);
  assert.deepEqual(effect.routing.single_stock_2x, { treatment_zh: '保持原 2× 载体，两臂相同', n: 27 });
  assert.equal(effect.bonferroni, undefined, '单变体，没有 Bonferroni');

  const criteria = block(projection, 'criteria').data.rows;
  assert.deepEqual(criteria.map((row) => row.key), ['G1', 'P_G', 'F3']);
  assert.deepEqual(criteria.map((row) => row.state_label), ['成立', '成立', '未触发']);
  assert.match(criteria[0].text, /两臂样本外成熟交易各 ≥ 30 笔，被改换载体的入场 ≥ 30 笔。原版 112 笔；候选 108 笔；被改换载体的入场 45 笔。/);
  assert.match(criteria[1].text, /95% 区间的下沿要大于 0。下沿 0\.40%。/);
  assert.match(criteria[2].text, /上沿不高于 0。上沿 3\.90%。/);

  const verdict = block(projection, 'verdict').data;
  assert.equal(verdict.layout, 'paired_g');
  assert.deepEqual(verdict.g_95, { lo: 0.004, hi: 0.039 });
  assert.match(verdict.method_zh, /只按账户层面配对的年化对数增长差判定/);
  assert.match(verdict.caveat_zh, /不等于信号 alpha 更大/);
  assert.deepEqual(verdict.reasons.map((item) => item.code), ['STRESS_SCENARIO_MISSING']);
});

test('Q2 敞口披露：两臂的平均名义金额、在场时间占比、名义上限拒绝与削减次数，加差；缺或不合规就拒绝', () => {
  const exposure = block(project2(), 'exposure').data;
  assert.equal(exposure.baseline.avg_notional_usd, 1450);
  assert.equal(exposure.candidate.avg_notional_usd, 2100);
  assert.equal(exposure.diff.avg_notional_usd, 650);
  assert.equal(exposure.diff.notional_cap_rejections, 36);
  assert.equal(exposure.diff.notional_cap_reductions, 8);
  assert.equal(exposure.diff.avg_actual_risk_usd, -8);
  assert.ok(Math.abs(exposure.diff.time_in_market_ratio - 0.13) < 1e-12);

  refuses2((doc) => { delete doc.comparison.exposure; }, 'Q2_EXPOSURE_DISCLOSURE_MISSING');
  refuses2((doc) => { delete doc.comparison.exposure.CANDIDATE_1X; }, 'Q2_EXPOSURE_DISCLOSURE_MISSING');
  refuses2((doc) => { delete doc.comparison.exposure.BASELINE; }, 'Q2_EXPOSURE_DISCLOSURE_MISSING');
  refuses2((doc) => { doc.comparison.exposure.BASELINE.time_in_market_ratio = 1.2; }, 'Q2_EXPOSURE_DISCLOSURE_INVALID');
  refuses2((doc) => { doc.comparison.exposure.CANDIDATE_1X.notional_cap_rejections = 'many'; }, 'Q2_EXPOSURE_DISCLOSURE_INVALID');
  refuses2((doc) => { doc.comparison.exposure.CANDIDATE_1X.avg_notional_usd = -1; }, 'Q2_EXPOSURE_DISCLOSURE_INVALID');
  // 写在各臂自己下面也认
  fs.rmSync(cc.LEDGER(), { force: true });
  const moved = project2((doc) => {
    doc.arms.BASELINE.exposure = doc.comparison.exposure.BASELINE;
    doc.arms.CANDIDATE_1X.exposure = doc.comparison.exposure.CANDIDATE_1X;
    delete doc.comparison.exposure;
  });
  assert.equal(block(moved, 'exposure').data.candidate.avg_notional_usd, 2100);
});

test('Q2 冻结常数与身份：δ_g 0、δ_R 0.10 不能改；K2 sha256、schema、候选臂键认 Q2 的，不认 Q1 的；没有 Bonferroni 也不要求', () => {
  refuses2((doc) => { doc.verdict.delta_g = 0.01; }, 'Q2_VERDICT_DELTA_CHANGED');
  refuses2((doc) => { doc.verdict.delta_R = 0.15; }, 'Q2_VERDICT_DELTA_CHANGED');
  refuses2((doc) => { delete doc.verdict.delta_R; }, 'Q2_VERDICT_DELTA_CHANGED');
  refuses2((doc) => { doc.identity.k2.sha256 = Q1.k2.sha256; }, 'Q2_K2_SHA_MISMATCH');
  // Q2 的文件自称 Q1 的 schema：按 Q1 的登记项校验，Q1 的运行门它没有，拒绝
  refuses2((doc) => { doc.identity.schema = 'US_V5_M2_Q1_RESULT_V1'; doc.identity.k2.sha256 = Q1.k2.sha256; }, 'Q1_RUN_GATE_NOT_PASSED');
  refuses2((doc) => { doc.identity.result_kind = 'X'; }, 'Q2_RESULT_KIND_UNSUPPORTED');
  // 候选臂键：CANDIDATE_1X（也认 1X）；用 Q1 的 CANDIDATE_T3 键，候选臂读不到，账户块写「尚未完成」，其余块照常
  fs.rmSync(cc.LEDGER(), { force: true });
  assert.equal(block(project2((doc) => { doc.arms['1X'] = doc.arms.CANDIDATE_1X; delete doc.arms.CANDIDATE_1X; }), 'account').state, 'AVAILABLE');
  fs.rmSync(cc.LEDGER(), { force: true });
  const wrongKey = project2((doc) => { doc.arms.CANDIDATE_T3 = doc.arms.CANDIDATE_1X; delete doc.arms.CANDIDATE_1X; });
  assert.equal(block(wrongKey, 'account').state, 'NOT_COMPLETED');
  assert.match(block(wrongKey, 'account').reason, /arms\.CANDIDATE_1X/);
  fs.rmSync(cc.LEDGER(), { force: true });
  assert.equal(project2((doc) => { doc.comparison.bonferroni = { level: 0.95 }; }).state, 'LOCKED_VERIFIED', '单变体：Bonferroni 字段不是判据，有也不当它是');
});

test('Q2 判定只按配对 g：SUPPORTED 要 L_g > 0、G1 成立且样本 ≥ 30；NOT_PASSED 要 U_g ≤ 0 且 G1 成立；INSUFFICIENT 随时允许', () => {
  refuses2((doc) => { doc.verdict.L_g = 0; }, 'Q2_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses2((doc) => { doc.verdict.L_g = -0.01; doc.comparison.g_vs_baseline.ci_95 = [-0.01, 0.039]; }, 'Q2_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses2((doc) => { doc.verdict.U_g = 0; doc.verdict.L_g = -0.02; }, 'Q2_VERDICT_SUPPORTED_VIOLATES_F3');
  refuses2((doc) => { setCriteria(doc, 'G1', { met: false, baseline_oos_trades: 112, candidate_oos_trades: 108, changed_entries: 45 }); }, 'Q2_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses2((doc) => { setCriteria(doc, 'P_G', { met: false }); }, 'Q2_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses2((doc) => { setCriteria(doc, 'F3', { triggered: true }); }, 'Q2_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses2((doc) => { doc.comparison.criteria.G1.changed_entries = 29; }, 'Q2_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL');
  refuses2((doc) => { doc.comparison.criteria.G1.candidate_oos_trades = 12; }, 'Q2_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL');
  refuses2((doc) => { delete doc.comparison.criteria.G1.baseline_oos_trades; }, 'Q2_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL');
  refuses2((doc) => { doc.verdict.engine_approximation = { flag: true, missing: ['x'] }; }, 'Q2_VERDICT_SUPPORTED_ON_APPROXIMATE_ENGINE');
  refuses2((doc) => { delete doc.comparison.criteria.P_G; }, 'Q2_CRITERIA_INCOMPLETE');
  refuses2((doc) => { doc.verdict.P_G = { met: false }; }, 'Q2_CRITERIA_DISAGREE');
  // Q1 的判据集不是 Q2 的：Q2 文件带 P1–P4 不算数，缺 P_G 照样拒绝
  refuses2((doc) => { delete doc.comparison.criteria.P_G; doc.comparison.criteria.P1 = { met: true }; }, 'Q2_CRITERIA_INCOMPLETE');

  const notPassed = (doc) => {
    doc.verdict.state = 'NOT_PASSED'; doc.verdict.L_g = -0.05; doc.verdict.U_g = -0.002;
    doc.comparison.g_vs_baseline.ci_95 = [-0.05, -0.002]; setCriteria(doc, 'P_G', { met: false }); setCriteria(doc, 'F3', { triggered: true });
  };
  assert.equal(project2(notPassed).verdict_label, '未通过');
  fs.rmSync(cc.LEDGER(), { force: true });
  refuses2((doc) => { notPassed(doc); doc.verdict.U_g = 0.01; doc.comparison.g_vs_baseline.ci_95 = [-0.05, 0.01]; setCriteria(doc, 'F3', { triggered: false }); }, 'Q2_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE');
  refuses2((doc) => { notPassed(doc); setCriteria(doc, 'G1', { met: false, baseline_oos_trades: 112, candidate_oos_trades: 20, changed_entries: 10 }); }, 'Q2_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE');
  refuses2((doc) => { notPassed(doc); setCriteria(doc, 'F3', { triggered: false }); }, 'Q2_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE');

  const insufficient = project2((doc) => {
    doc.verdict.state = 'INSUFFICIENT'; doc.verdict.L_g = -0.01; doc.verdict.U_g = 0.03; doc.comparison.g_vs_baseline.ci_95 = [-0.01, 0.03];
    setCriteria(doc, 'P_G', { met: false });
  });
  assert.equal(insufficient.verdict_label, '证据不足');
  assert.equal(insufficient.completeness.lines[0].text, '优势结论：证据不足');
  refuses2((doc) => { doc.verdict.state = 'BLOCKED'; }, 'Q2_VERDICT_STATE_UNSUPPORTED');
  refuses2((doc) => { doc.verdict.class = 'BASELINE_EVALUATION_V1'; }, 'Q2_VERDICT_CLASS_UNSUPPORTED');
});

test('Q2 区间两端：verdict 里没有 L_g／U_g 时取 comparison.g_vs_baseline.ci_95，只读取不推算', () => {
  const projection = project2((doc) => { delete doc.verdict.L_g; delete doc.verdict.U_g; });
  assert.deepEqual(block(projection, 'verdict').data.g_95, { lo: 0.004, hi: 0.039 });
  fs.rmSync(cc.LEDGER(), { force: true });
  refuses2((doc) => { delete doc.verdict.L_g; delete doc.verdict.U_g; doc.comparison.g_vs_baseline.ci_95 = [-0.01, 0.039]; }, 'Q2_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
});

test('Q2 样本外：oos_reuse 必须是 false 且写理由；带 OOS_REUSED_FOR_SELECTION 反而矛盾', () => {
  refuses2((doc) => { doc.oos_reuse = true; }, 'Q2_OOS_REUSE_MUST_BE_FALSE');
  refuses2((doc) => { doc.verdict.reason_codes = ['OOS_REUSED_FOR_SELECTION', 'STRESS_SCENARIO_MISSING']; }, 'Q2_OOS_REUSE_CONTRADICTS_CODE');
  refuses2((doc) => { delete doc.oos_reuse_detail; }, 'Q2_OOS_REUSE_DETAIL_MISSING');
  refuses2((doc) => { doc.oos_reuse_detail = {}; }, 'Q2_OOS_REUSE_DETAIL_MISSING');
  refuses2((doc) => { doc.oos_reuse = 'false'; }, 'Q2_OOS_REUSE_MISSING');
  assert.equal(project2((doc) => { doc.oos_reuse_detail = '同一窗口被其他研究读过，但没有用于选择载体杠杆'; }).state, 'LOCKED_VERIFIED');
});

test('Q2 运行门：K2 点名的八道门都在且 PASSED（含 INERT_Q1、ROUTING_CENSUS、ATTRIBUTION_RECONCILE）；Q1 的孪生门不要求', () => {
  for (const name of Q2.run_gates) refuses2((doc) => { doc.gates[name] = { state: 'FAILED' }; }, 'Q2_RUN_GATE_NOT_PASSED');
  refuses2((doc) => { delete doc.gates.INERT_Q1; }, 'Q2_RUN_GATE_NOT_PASSED');
  refuses2((doc) => { delete doc.gates.ATTRIBUTION_RECONCILE; }, 'Q2_RUN_GATE_NOT_PASSED');
  assert.ok(!Q2.run_gates.includes('TWIN_PARITY'));
});

test('Q2 前向：K2 写 forward 为空并写原因；任何一行 in_verdict 不是 false 仍然拒绝', () => {
  assert.equal(project2((doc) => { doc.forward = []; }).state, 'LOCKED_VERIFIED');
  fs.rmSync(cc.LEDGER(), { force: true });
  refuses2((doc) => { doc.forward = { rows: [{ stream: 'B', file_sha256: fx2.hex('x'), in_verdict: true }] }; }, 'Q2_FORWARD_IN_VERDICT');
});

// ── 归因（Q2a）──────────────────────────────────────────────────────────────────

test('归因块必须有；各栏各类相加对上合计，合计加监管费日进位差对上账户盈亏，残差 0；对的是基线臂的净盈亏', () => {
  assert.ok(Q2.top_level.includes('attribution'));
  refuses2((doc) => { delete doc.attribution; }, 'Q2_RESULT_TOP_LEVEL_MISSING');
  refuses2((doc) => { doc.attribution = {}; }, 'Q2_ATTRIBUTION_SEGMENT_INVALID');
  refuses2((doc) => { delete doc.attribution.is; }, 'Q2_ATTRIBUTION_SEGMENT_INVALID');
  refuses2((doc) => { delete doc.attribution.oos.by_class; }, 'Q2_ATTRIBUTION_SEGMENT_INVALID');
  refuses2((doc) => { doc.attribution.oos.by_class[0].usd.COST = 'x'; }, 'Q2_ATTRIBUTION_SEGMENT_INVALID');
  refuses2((doc) => { delete doc.attribution.oos.by_class[1].usd.COST; }, 'Q2_ATTRIBUTION_SEGMENT_INVALID');
  refuses2((doc) => { delete doc.attribution.oos.reconcile; }, 'Q2_ATTRIBUTION_SEGMENT_INVALID');
  refuses2((doc) => { delete doc.attribution.oos.reconcile.reg_daily_rounding; }, 'Q2_ATTRIBUTION_SEGMENT_INVALID');
  // 某一类的某一栏改了，合计没改：各类相加 ≠ 合计
  refuses2((doc) => { doc.attribution.oos.by_class[0].usd.PARENT_SIGNAL += 1; }, 'Q2_ATTRIBUTION_DOES_NOT_RECONCILE');
  // 日进位差改了，sum_components 没跟着改
  refuses2((doc) => { doc.attribution.oos.reconcile.reg_daily_rounding += 0.5; }, 'Q2_ATTRIBUTION_DOES_NOT_RECONCILE');
  // 残差写成 0 但账户盈亏对不上各栏之和
  refuses2((doc) => { doc.attribution.oos.reconcile.account_pnl += 0.5; }, 'Q2_ATTRIBUTION_DOES_NOT_RECONCILE');
  // 残差如实写出来，但不是 0
  refuses2((doc) => { doc.attribution.oos.reconcile.account_pnl += 0.01; doc.attribution.oos.reconcile.residual = 0.01; }, 'Q2_ATTRIBUTION_RESIDUAL_NONZERO');
  // IS 段同样要对账
  refuses2((doc) => { doc.attribution.is.by_class[2].usd.LEVERAGE_PATH += 2; }, 'Q2_ATTRIBUTION_DOES_NOT_RECONCILE');
  // 监管费日进位差必须是单独一行，不能混在某一栏里
  refuses2((doc) => {
    for (const segment of [doc.attribution.oos, doc.attribution.is]) {
      segment.by_class.forEach((row) => { row.usd.REG_DAILY_ROUNDING = 0; });
      segment.total.usd.REG_DAILY_ROUNDING = 0;
    }
  }, 'Q2_ATTRIBUTION_DAILY_ROUNDING_NOT_SEPARATE');
});

test('归因要对上基线臂的净盈亏：对到候选臂的净盈亏（内部自洽）也拒绝；差 1e-3 USD 内认（臂 summary 只存 4 位小数）', () => {
  const base = Q0.doc.arms.D.equity.values;
  const baselinePnl = base[base.length - 1] - base[0];
  const shift = (doc, delta) => {
    for (const segment of [doc.attribution.oos]) {
      segment.reconcile.account_pnl += delta; segment.reconcile.sum_components += delta; segment.reconcile.reg_daily_rounding += delta;
    }
  };
  refuses2((doc) => shift(doc, 5), 'Q2_ATTRIBUTION_NOT_BASELINE_PNL');
  refuses2((doc) => {
    const cand = doc.arms.CANDIDATE_1X.equity.values;
    shift(doc, (cand[cand.length - 1] - cand[0]) - baselinePnl);
  }, 'Q2_ATTRIBUTION_NOT_BASELINE_PNL');
  assert.equal(project2((doc) => shift(doc, 5e-4)).state, 'LOCKED_VERIFIED');
});

test('归因块的页面数据：各栏标签、各类各栏 USD 与 R、合计、监管费日进位差单列、残差 0；不适用的栏是 null 不是 0', () => {
  const attribution = block(project2(), 'attribution').data;
  assert.deepEqual(attribution.columns.map((column) => column.label), ['母序列信号', '杠杆与路径', '单股 2×（不可分）', '费用（含在成交价里的 5 bps／边）', '监管费（逐笔未进位）']);
  assert.deepEqual(attribution.oos.rows.map((row) => row.label), ['指数', '行业', '3× 行业', '单股 2×', '反向']);
  const single = attribution.oos.rows.find((row) => row.class === 'SINGLE_STOCK_2X');
  assert.equal(single.usd.PARENT_SIGNAL, null);
  assert.equal(single.usd.SINGLE_STOCK_2X, 30);
  assert.equal(attribution.oos.total.usd.PARENT_SIGNAL, 40 + 55 + 90 - 4);
  assert.equal(attribution.oos.residual, 0);
  const base = Q0.doc.arms.D.equity.values;
  assert.ok(Math.abs(attribution.oos.account_pnl - (base[base.length - 1] - base[0])) < 1e-9);
  assert.ok(Math.abs(attribution.oos.sum_components - attribution.oos.account_pnl) < 1e-9);
  assert.deepEqual(attribution.is.window, ['2020-01-02', '2022-12-30']);
  assert.equal(attribution.fill_limits.rejections, 3);
  assert.equal(attribution.fill_limits.reductions, 2);
  assert.equal(attribution.definitions.length, 2);
});

// ── 题目的选择与错误码 ──────────────────────────────────────────────────────────

test('题目选择：按 identity.schema 自动判断；--question 与文件不符、未登记的题目都拒绝；错误码前缀跟着文件所属的题目', () => {
  const file = write2();
  assert.equal(cc.readSealed(file, { allowNonActual: true }).entry, Q2);
  assert.throws(() => imp(file, { question: 'Q1' }), (error) => error.code === 'Q1_RESULT_SCHEMA_UNSUPPORTED');
  assert.throws(() => imp(file, { question: 'Q9' }), (error) => error.code === 'COMPARISON_QUESTION_NOT_REGISTERED');
  assert.equal(imp(file, { question: 'Q2' }).question_ref, 'Q2');
  // 封存读取的错误（缺旁证、旁证不符、缺顶层字段）：Q2 文件报 Q2_ 前缀，Q1 文件仍是 Q1_ 前缀
  assert.throws(() => imp(write2(undefined, { sidecar: false })), (error) => error.code === 'Q2_RESULT_SHA256_FILE_MISSING');
  assert.throws(() => imp(write2(undefined, { tamperSidecar: true })), (error) => error.code === 'Q2_RESULT_SHA256_MISMATCH');
  assert.throws(() => imp(fx1.write(fx1.result(Q0.doc, Q0.sha, Q0.id), { tamperSidecar: true })), (error) => error.code === 'Q1_RESULT_SHA256_MISMATCH');
  assert.throws(() => imp(fx1.write(fx1.result(Q0.doc, Q0.sha, Q0.id, (doc) => { delete doc.forward; delete doc.comparison; }))), (error) => error.code === 'Q1_RESULT_TOP_LEVEL_MISSING');
  assert.throws(() => imp(write2((doc) => { delete doc.comparison; })), (error) => error.code === 'Q2_RESULT_TOP_LEVEL_MISSING');
  // 认不出的 schema：当默认题，由整文件校验报告（与改造前相同）
  assert.throws(() => imp(fx1.write(fx1.result(Q0.doc, Q0.sha, Q0.id, (doc) => { doc.identity.schema = 'US_V5_M2_Q9_RESULT_V1'; }))), (error) => error.code === 'Q1_RESULT_SCHEMA_UNSUPPORTED');
});

test('基线链对每一题都一样：必须是当前的 Q0 锁，原版臂等于 Q0 的 D 臂；错误码带本题前缀', () => {
  refuses2((doc) => { doc.arms.BASELINE.summary.cagr = 0.5; }, 'Q2_BASELINE_ARM_DIFFERS_FROM_Q0');
  refuses2((doc) => { doc.identity.baseline_result_id = 'Q0-0000000000000000'; doc.identity.baseline.result_id = 'Q0-0000000000000000'; doc.comparison.baseline_result_id = 'Q0-0000000000000000'; }, 'Q2_BASELINE_LOCK_NOT_FOUND');
  refuses2((doc) => { doc.identity.baseline.sha256 = fx2.hex('x'); }, 'Q2_BASELINE_SHA256_MISMATCH');
});

test('命令行：--question 指定题目，导入结果里写 question_ref；文件路径带 fixture 字样时拒绝', () => {
  const cli = path.join(ROOT, 'apps', 'research-cli', 'import_candidate_comparison.js');
  const env = { ...process.env, QRP_PRODUCT_MILESTONE_AUTHORITY: AUTHORITY };
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const refused = run(['--file', write2(), '--registered-by', AUTHORITY, '--question', 'Q2']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Q2_RESULT_NON_ACTUAL_SOURCE/);
  const unknown = run(['--file', write2(), '--registered-by', AUTHORITY, '--question', 'Q9']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /COMPARISON_QUESTION_NOT_REGISTERED|Q1_RESULT_NON_ACTUAL_SOURCE/);
  assert.equal(cc.locks().length, 0);
});

test('缓存按（case, 题目）分开：Q1 与 Q2 各自一份，互不覆盖；readProjections 给每个已锁定的题目一张卡并按队列排', () => {
  assert.deepEqual(cc.readProjections().map((card) => [card.question_ref, card.state]), [['Q1', 'NOT_IMPORTED']], '没有任何锁时只有第一题的「尚未完成」卡');
  imp(fx1.write(fx1.result(Q0.doc, Q0.sha, Q0.id)));
  imp(write2());
  cc.clearCache();
  const cards = cc.createProjectionReader({ build: (lock, question) => cc.buildProjection(lock, { allowNonActual: true, question }) }).readAll();
  assert.deepEqual(cards.map((card) => [card.question_ref, card.state, card.verdict_state]), [['Q1', 'LOCKED_VERIFIED', 'SUPPORTED'], ['Q2', 'LOCKED_VERIFIED', 'SUPPORTED']]);
  let builds = 0;
  const reader = cc.createProjectionReader({ now: () => 1_000_000, build: (lock, question) => { builds += 1; return cc.buildProjection(lock, { allowNonActual: true, question }); } });
  reader.read(cc.CASE_REF, 'Q1'); reader.read(cc.CASE_REF, 'Q2'); reader.read(cc.CASE_REF, 'Q1'); reader.read(cc.CASE_REF, 'Q2');
  assert.equal(builds, 2);
  // 只有 Q2 锁定、Q1 没有：仍然是 Q1 的空卡在前
  fs.rmSync(cc.LEDGER(), { force: true });
  imp(write2());
  assert.deepEqual(cc.createProjectionReader({ build: (lock, question) => cc.buildProjection(lock, { allowNonActual: true, question }) }).readAll().map((card) => [card.question_ref, card.state]),
    [['Q1', 'NOT_IMPORTED'], ['Q2', 'LOCKED_VERIFIED']]);
});

test('Q2 文件锁定后被改：只让 Q2 这张卡失败关闭，Q1 那张不受影响', () => {
  const file1 = fx1.write(fx1.result(Q0.doc, Q0.sha, Q0.id));
  const lock1 = imp(file1);
  const file2 = write2();
  const lock2 = imp(file2);
  fs.writeFileSync(file2, `${fs.readFileSync(file2, 'utf8')} `);
  const bad = cc.buildProjection(lock2, { allowNonActual: true });
  assert.equal(bad.state, 'INVALID');
  assert.equal(bad.question_ref, 'Q2');
  assert.equal(bad.title_zh, Q2.title_zh);
  assert.equal(bad.reason_code, 'Q2_RESULT_SHA256_MISMATCH');
  assert.deepEqual(bad.blocks.map((item) => item.key), Q2.blocks.map(([key]) => key));
  assert.ok(bad.blocks.every((item) => item.state === 'NOT_COMPLETED' && item.data === null));
  assert.equal(cc.buildProjection(lock1, { allowNonActual: true }).state, 'LOCKED_VERIFIED');
});
