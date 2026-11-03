'use strict';
/**
 * Q6（US_V5 M2 第二轮第 2 步：D+A25+T3+M-1 对当前 D）的登记项：候选对比导入规格 V2 附录 4。
 * 规则出处：冻结的第 2 步 K2（1fc9c18b…）与协调会话 US_V5_ROUND2_ITEMS_1_4_K2_FREEZE_1 第 1 项（★1–★6 全按推荐）。
 * 账本在临时目录（tests/_env），不碰 var/ledger；结果文件是 tests/_q6_fixture.js 的合成文件。
 * 差距分解与 Q0 压力补充的锁直接写进临时账本（同 tests/_us_v5_r2_fixture.js 对 Q1–Q5 锁的做法），只带本题要读的字段。
 */
require('./_env');
const test = require('node:test');
const { beforeEach } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const q0 = require('../services/baseline-evaluation');
const cc = require('../services/candidate-comparison');
const gap = require('../services/gap-decomposition');
const supp = require('../services/baseline-stress-supplement');
const fx0 = require('./_q0_fixture');
const fx4 = require('./_q4_fixture');
const fx5 = require('./_q5_fixture');
const fx6 = require('./_q6_fixture');

const ROOT = path.join(__dirname, '..');
const { Q6 } = cc.QUESTIONS;
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const rejects = (code) => (error) => { assert.equal(error.code, code, error.message); return true; };

let CTX;
const imp = (file, extra = {}) => cc.importCandidateComparison(file, { registeredBy: AUTHORITY, allowNonActual: true, ...extra });
const write6 = (fn) => fx6.write(fx6.result(CTX, fn));
const refuses6 = (fn, code) => assert.throws(() => imp(write6(fn)), rejects(code), code);
const project6 = (fn) => cc.buildProjection(imp(write6(fn)), { allowNonActual: true, question: 'Q6' });
const block = (projection, key) => projection.blocks.find((item) => item.key === key);
const extra = (projection, key) => projection.extra_cards.find((item) => item.key === key);
const rowOf = (doc, scenario) => doc.stress.rows.find((row) => row.scenario === scenario);

/** 差距分解与压力补充的锁行：只带 Q6 要读的字段（锁存在、sha256、是否当前、准入结论、原版臂来源、基线）。 */
function seedLock(ledger, row) {
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.appendFileSync(ledger, `${JSON.stringify(row)}\n`);
  return { result_id: row.result_id, sha256: row.file_sha256 };
}
const gapRow = (salt, extra = {}) => {
  const fileSha = fx6.hex(`gap${salt}`);
  return { schema: 'GAP_DECOMPOSITION_LOCK_V1', record_type: 'GAP_DECOMPOSITION_V1', result_id: `GAP-${fileSha.slice(0, 16)}`, case_ref: q0.CASE_REF,
    strategy_ref: q0.STRATEGY_REF, baseline_result_id: CTX.q0Id, base_arm_ref: { result_id: CTX.lock5.result_id, arm: 'CANDIDATE_T3_ON_A25' },
    decision: 'CANDIDATE', file_sha256: fileSha, ...extra };
};
const suppRow = (salt, extra = {}) => {
  const fileSha = fx6.hex(`q0s${salt}`);
  return { schema: 'BASELINE_STRESS_SUPPLEMENT_LOCK_V1', record_type: 'BASELINE_STRESS_SUPPLEMENT_V1', result_id: `Q0S-${fileSha.slice(0, 16)}`,
    case_ref: q0.CASE_REF, strategy_ref: q0.STRATEGY_REF, baseline_result_id: CTX.q0Id, scenario: 'WINDOW_2020_02_19_04_30', file_sha256: fileSha, ...extra };
};

beforeEach(() => {
  for (const ledger of [q0.LEDGER(), cc.LEDGER(), gap.LEDGER(), supp.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); cc.clearCache();
  const q0Doc = fx0.result();
  const lock0 = q0.importBaselineEvaluation(fx0.write(q0Doc), { registeredBy: AUTHORITY, allowNonActual: true });
  CTX = { q0Doc, q0Id: lock0.result_id, q0Sha: lock0.file_sha256 };
  CTX.lock4 = imp(fx4.write(fx4.result(q0Doc, CTX.q0Sha, CTX.q0Id)));
  CTX.lock5 = imp(fx5.write(fx5.result(q0Doc, CTX.q0Sha, CTX.q0Id, CTX.lock4)));
  CTX.gap = seedLock(gap.LEDGER(), gapRow(''));
  CTX.q0s = seedLock(supp.LEDGER(), suppRow(''));
});

// ── 登记项 ──────────────────────────────────────────────────────────────────────

test('Q6 登记项：K2 是 smartflow 冻结文本的逐字节副本，§7 两个 sha256 由它切出；原版臂来自 Q5 的候选臂；判据 G1′／P_G／F3；11 个运行门；队列在 Q5 之后', () => {
  assert.equal(sha(Q6.k2.ref), '1fc9c18bed82ba7e19a4c3e5afb29bcc7b051bcf2134ad8cdc179468920671ad');
  assert.equal(Q6.k2.sha256, '1fc9c18bed82ba7e19a4c3e5afb29bcc7b051bcf2134ad8cdc179468920671ad');
  const spec = fx6.result(CTX).forward_spec;
  assert.equal(spec.sha256, '8e696d9e6d4d060649b604a619aa0c7817c03750193f5508486458665a35bfd7', '同封存文件 forward_spec.sha256');
  assert.equal(crypto.createHash('sha256').update(spec.text_zh).digest('hex'), Q6.forward_spec.text_sha256);
  assert.equal(Q6.forward_spec.sha256, spec.sha256);
  assert.equal(Q6.freeze.sha256, 'e4bcc0cc81144327bf983b0d50d47b19eaff997b807ce9beb3d95bb3ed2574e3');
  assert.equal(Q6.profile_ref, 'docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_4.md');
  assert.ok(fs.existsSync(path.join(ROOT, Q6.profile_ref)));
  assert.equal(Q6.schema, 'US_V5_M2_R2_STEP2_COMBINED_V1');
  assert.equal(Q6.queue_order, 6);
  assert.equal(Q6.candidate.key, 'CANDIDATE_M1_ON_T3_A25');
  assert.deepEqual([...Q6.baseline_arm.keys], ['BASELINE_T3_A25']);
  assert.deepEqual({ ...Q6.baseline_arm.ref }, { question_ref: 'Q5', arm: 'CANDIDATE_T3_ON_A25' });
  assert.deepEqual(Object.keys(Q6.criteria), ['G1_prime', 'P_G', 'F3']);
  assert.deepEqual([...Q6.run_gates], ['ACCEPTANCE', 'INPUTS', 'INERT_TEST', 'ENGINE_STRIP', 'PARITY_M1_OFF', 'BASELINE_REPRO_D', 'M1_FLAT_SPY_IDENTITY',
    'CASH_IDENTITY', 'SPY_FEES', 'REPRO', 'MEM']);
  assert.deepEqual([Q6.oos_reuse.expected, Q6.oos_reuse.reason_code, Q6.oos_reuse.detail_required], [true, 'OOS_REUSED_FOR_SELECTION', true]);
  assert.deepEqual(Q6.report_only.rows.map((row) => row.key), ['REF_D', 'REF_D_A25', 'CANDIDATE_VS_REF_D']);
  assert.deepEqual(Object.keys(Q6.cited), ['GAP', 'Q0S', 'Q4']);
  assert.deepEqual(cc.registry.PLAN.Q6, ['Q5']);
  assert.deepEqual(cc.ORDER, ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']);
});

// ── 导入 ────────────────────────────────────────────────────────────────────────

test('Q6 默认文件导入通过：锁 Q6-<sha16>，D 的基线仍是 Q0；主卡各块可读；参照行与做 / 不做各一张卡，不进结论；重放幂等', () => {
  const file = write6();
  const lock = imp(file);
  assert.match(lock.result_id, /^Q6-[0-9a-f]{16}$/);
  assert.equal(lock.result_id, `Q6-${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)}`);
  assert.equal(lock.question_ref, 'Q6');
  assert.equal(lock.verdict_state, 'SUPPORTED');
  assert.equal(lock.baseline_result_id, CTX.q0Id, 'D 的基线锁仍是 Q0');
  assert.equal(lock.oos_reuse, true);
  assert.match(lock.inputs_digest, /^[0-9a-f]{64}$/);
  assert.match(lock.engine_digest, /^[0-9a-f]{64}$/);
  assert.equal(imp(file).replayHit, true);

  const projection = cc.buildProjection(lock, { allowNonActual: true, question: 'Q6' });
  assert.equal(projection.state, 'LOCKED_VERIFIED', projection.reason);
  for (const item of projection.blocks) assert.equal(item.state, 'AVAILABLE', `${item.key}: ${item.reason}`);
  assert.match(JSON.stringify(block(projection, 'account').data.arms[0]), /原版（当前 D/);
  assert.doesNotMatch(block(projection, 'question').data.oos_reuse.detail_zh, /IS_USED_AS_SIGN_FILTER|OOS_REUSED_FOR_SELECTION/, '主内容不出现原样的英文原因码');
  const g1 = block(projection, 'criteria').data.rows.find((row) => row.key === 'G1′');
  assert.equal(g1.flag, true);
  assert.match(g1.text, /原版 122 笔；候选 122 笔；候选持有 SPY 956 个 session/);
  assert.match(block(projection, 'verdict').data.basis.main[0], /G1′ 成立/);
  // 2008 只停放 SPY 上界行单列，不进压力评价的完整性，也不算「已执行」
  const stress = block(projection, 'stress').data;
  const bound = stress.rows.find((row) => row.scenario === 'SPY_PARK_2008_BOUND');
  assert.equal(bound.kind, 'BOUND');
  assert.equal(bound.bound.below_1800, true);
  assert.equal(stress.counts.bound, 1);
  assert.equal(stress.counts.missing, 2);
  const lines = projection.completeness.lines.map((line) => line.text);
  assert.match(lines.find((text) => text.startsWith('压力评价不完整')), /缺场景 2 个/);
  assert.match(lines.find((text) => text.startsWith('采用条件')), /US_V5_M1_SHADOW/);
  // 前向：只有冻结的 §7 规则，没有行
  const forward = block(projection, 'forward').data;
  assert.deepEqual(forward.rows, []);
  assert.equal(forward.spec.sha256, Q6.forward_spec.sha256);
  assert.match(forward.reason_zh, /尚未开始/);

  const refs = extra(projection, 'reference_rows');
  assert.equal(refs.state, 'AVAILABLE', refs.reason);
  assert.deepEqual(refs.data.rows.map((row) => [row.key, row.changed_entries, row.n]), [['REF_D', 98, null], ['REF_D_A25', 44, null], ['CANDIDATE_VS_REF_D', null, null]]);
  const card = extra(projection, 'do_or_not');
  assert.equal(card.state, 'AVAILABLE', card.reason);
  assert.equal(card.data.class, 'DO_OR_NOT');
  assert.deepEqual([card.data.decision, card.data.decision_zh], ['DO', '做']);
  assert.match(card.data.allowed_use_zh, /不是生产采用/);
  assert.deepEqual(card.data.checks.map((check) => [check.id, check.triggered]), [['N1', false], ['N2', false], ['N3', false], ['N4', false]]);
  assert.equal(card.data.recommendation, null);
  assert.ok(card.data.disclosures.length >= 1);
  assert.ok(card.data.lines.some((line) => /收回率 76\.71%/.test(line.text)), JSON.stringify(card.data.lines));
  const exposure = block(projection, 'exposure').data;
  const rows = Object.fromEntries(exposure.extra_rows.map((row) => [row.key, row]));
  assert.equal(rows['arms_not_set.gate_refusal.open_scan'].baseline, 255, '两臂都是 A25：原版也有未武装的冷却数');
  assert.equal(rows.spy_mean_notional_usd.baseline, null, 'SPY 名义只有候选有');
  assert.equal(rows.spy_mean_notional_usd.candidate, 3736.6165);
});

test('Q6 原版臂来源（附录 3 第 2 节读法）：缺引用、臂名不对、sha256 不符、摘要与 Q5 候选臂不同都拒绝', () => {
  refuses6((doc) => { doc.identity.baseline_arm_ref = null; }, 'Q6_BASELINE_ARM_REF_MISSING');
  refuses6((doc) => { doc.identity.baseline_arm_ref = { ...doc.identity.baseline_arm_ref, arm: 'BASELINE_A25' }; }, 'Q6_BASELINE_ARM_REF_MISSING');
  refuses6((doc) => { doc.identity.baseline_arm_ref = { ...doc.identity.baseline_arm_ref, result_id: 'Q5-0000000000000000' }; }, 'Q6_BASELINE_ARM_REF_LOCK_NOT_FOUND');
  refuses6((doc) => { doc.identity.baseline_arm_ref = { ...doc.identity.baseline_arm_ref, sha256: fx6.hex('other') }; }, 'Q6_BASELINE_ARM_REF_SHA256_MISMATCH');
  refuses6((doc) => { const arm = doc.arms[fx6.BASE]; arm.summary.end_capital += 1; arm.equity.values[arm.equity.values.length - 1] += 1; }, 'Q6_BASELINE_ARM_DIFFERS_FROM_REF');
});

test('Q6 引用的锁（＋）：差距分解、压力补充、Q4 都要有锁、sha256 相符、是当前的锁；差距分解必须是「有候选」且原版臂同为 Q5 那把锁', () => {
  refuses6((doc) => { delete doc.identity.cited_results.Q0S; }, 'Q6_CITED_RESULTS_INCOMPLETE');
  refuses6((doc) => { doc.identity.cited_results.GAP = { result_id: 'GAP-0000000000000000', sha256: fx6.hex('none') }; }, 'Q6_CITED_RESULT_LOCK_NOT_FOUND');
  refuses6((doc) => { doc.identity.cited_results.Q0S = { ...doc.identity.cited_results.Q0S, sha256: fx6.hex('other') }; }, 'Q6_CITED_RESULT_SHA256_MISMATCH');
  // INPUTS 门里写的 sha256 与引用不符（＋）
  refuses6((doc) => { doc.gates.INPUTS.sealed.find((item) => item.input === 'GAP').expect = fx6.hex('other'); }, 'Q6_INPUTS_SEALED_MISMATCH');
  // 参照行 D+A25 的来源必须是引用的 Q4 锁（＋）
  refuses6((doc) => { doc.reference_rows[1].source_result_id = 'Q4-0000000000000000'; }, 'Q6_REFERENCE_ROW_SOURCE_MISMATCH');
  // 差距分解被取代以后，引用旧锁的文件拒绝；新的当前锁若是「无候选」或原版臂不是 Q5 那把锁，也拒绝
  const citeGap = (lock) => (doc) => {
    doc.identity.cited_results.GAP = lock;
    Object.assign(doc.gates.INPUTS.sealed.find((item) => item.input === 'GAP'), { expect: lock.sha256, now: lock.sha256 });
  };
  const noCandidate = seedLock(gap.LEDGER(), gapRow('-2', { decision: 'NO_CANDIDATE' }));
  refuses6(null, 'Q6_CITED_RESULT_NOT_CURRENT');
  refuses6(citeGap(noCandidate), 'Q6_CITED_GAP_NOT_CANDIDATE');
  const otherBase = seedLock(gap.LEDGER(), gapRow('-3', { base_arm_ref: { result_id: 'Q5-0000000000000000', arm: 'CANDIDATE_T3_ON_A25' } }));
  refuses6(citeGap(otherBase), 'Q6_CITED_GAP_BASE_ARM_DIFFERS');
  const current = seedLock(gap.LEDGER(), gapRow('-4'));
  assert.equal(imp(write6(citeGap(current))).question_ref, 'Q6', '引用当前的差距分解锁时照常导入');
});

test('Q6 判据（G1′、★1 (a)）：有支持证据要求两臂成熟交易各 ≥ 30 且候选持有 SPY ≥ 30 个 session；标签与文件里的数不一致拒绝', () => {
  refuses6((doc) => { doc.comparison.criteria.G1_prime.candidate_sessions_holding_spy = 20; doc.comparison.criteria.G1_prime.met = false; }, 'Q6_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses6((doc) => { doc.comparison.criteria.G1_prime.candidate_sessions_holding_spy = 20; }, 'Q6_CRITERIA_INCONSISTENT');
  refuses6((doc) => { doc.comparison.criteria.P_G.met = false; }, 'Q6_CRITERIA_INCONSISTENT');
  refuses6((doc) => { doc.verdict.delta_g = 0.01; }, 'Q6_VERDICT_DELTA_CHANGED');
  refuses6((doc) => { delete doc.gates.M1_FLAT_SPY_IDENTITY; }, 'Q6_RUN_GATE_NOT_PASSED');
  refuses6((doc) => { doc.oos_reuse = false; }, 'Q6_OOS_REUSE_MUST_BE_DECLARED');
  refuses6((doc) => { doc.identity.k2.freeze.item = 4; }, 'Q6_K2_FREEZE_MISMATCH');
});

test('Q6 做 / 不做（K2 §6.1、★3 (a)、★4 (a)）：N1–N4 逐条与文件里的数一致；结论按顺序推出；「做」的允许用途只是前向影子', () => {
  // N2：IS 配对 g ≤ 0 而没写触发
  refuses6((doc) => { doc.comparison.is.paired_g.g = -0.01; }, 'Q6_DO_OR_NOT_INCONSISTENT');
  // N3：2020 行候选最低权益 < 1,800 而行里没写触发
  refuses6((doc) => { rowOf(doc, 'WINDOW_2020_02_19_04_30').arms[fx6.CAND].min_equity = 1700; }, 'Q6_DO_OR_NOT_INCONSISTENT');
  // N3 的行与压力表里候选那一格不同
  refuses6((doc) => { doc.verdict.do_or_not.checks[2].rows[0].min_equity = 2500; }, 'Q6_DO_OR_NOT_INCONSISTENT');
  // N3 少一行真实历史行
  refuses6((doc) => { doc.verdict.do_or_not.checks[2].rows.pop(); }, 'Q6_DO_OR_NOT_INCONSISTENT');
  // N4 成立却判「做」
  refuses6((doc) => { const arms = rowOf(doc, 'COST_15BPS').arms; arms[fx6.CAND].end_capital = 3000; rowOf(doc, 'COST_15BPS').diff.end_capital = 3000 - arms[fx6.BASE].end_capital; }, 'Q6_DO_OR_NOT_INCONSISTENT');
  refuses6((doc) => { doc.verdict.do_or_not.decision = 'DO_PAPER_SHADOW'; }, 'Q6_DO_OR_NOT_INCONSISTENT');
  refuses6((doc) => { doc.verdict.do_or_not.allowed_use_zh = '作为新 D 部署'; }, 'Q6_DO_OR_NOT_ALLOWED_USE');
  refuses6((doc) => { delete doc.verdict.do_or_not; }, 'Q6_DO_OR_NOT_MISSING');
  // 不做（N2 触发）：照锁，卡片写「不做」与触发的那一条
  const notDo = project6((doc) => { doc.comparison.is.paired_g.g = -0.01; fx6.decide(doc); });
  const card = extra(notDo, 'do_or_not').data;
  assert.deepEqual([card.decision, card.decision_zh, card.triggered], ['NOT_DO', '不做', ['N2']]);
  assert.match(card.allowed_use_zh, /^无/);
});

test('Q6 §6.3 核对：只在「做（纸面 / 影子）」时有，第 1–4 项写是 / 否、第 5、6 项只列出；其余结论不许带', () => {
  const paper = (doc) => {
    doc.verdict.state = 'INSUFFICIENT'; doc.verdict.rule = 'UNDECIDED'; doc.verdict.L_g = -0.01; doc.comparison.g_vs_baseline.ci_95 = [-0.01, 0.217746];
    doc.comparison.criteria.P_G = { met: false, L_g: -0.01 }; doc.verdict.reason_codes = ['OOS_REUSED_FOR_SELECTION', 'CI_G_STRADDLES_ZERO', 'STRESS_SCENARIO_MISSING'];
    fx6.decide(doc);
  };
  refuses6(paper, 'Q6_RECOMMENDATION_MISSING');
  refuses6((doc) => { paper(doc); doc.recommendation = fx6.recommendation(); doc.recommendation.checks.pop(); }, 'Q6_RECOMMENDATION_CHECKS_INCOMPLETE');
  refuses6((doc) => { doc.recommendation = fx6.recommendation(); }, 'Q6_RECOMMENDATION_NOT_ALLOWED');
  const card = extra(project6((doc) => { paper(doc); doc.recommendation = fx6.recommendation(); }), 'do_or_not').data;
  assert.equal(card.decision, 'DO_PAPER_SHADOW');
  assert.deepEqual(card.recommendation.checks.map((check) => [check.id, check.mark]), [[1, '是'], [2, '是'], [3, '是'], [4, '是'], [5, '只列出'], [6, '只列出']]);
});

test('Q6 前向规则、上界行、参照行、披露：§7 原文不符、上界行与自己的数不一致、披露为空都拒绝', () => {
  refuses6((doc) => { doc.forward_spec.text_zh += '（改过）'; }, 'Q6_FORWARD_SPEC_MISMATCH');
  refuses6((doc) => { delete doc.forward_spec; }, 'Q6_RESULT_TOP_LEVEL_MISSING');
  refuses6((doc) => { rowOf(doc, 'SPY_PARK_2008_BOUND').below_1800 = false; }, 'Q6_BOUND_ROW_INVALID');
  refuses6((doc) => { rowOf(doc, 'SPY_PARK_2008_BOUND').in_verdict = true; }, 'Q6_BOUND_ROW_INVALID');
  refuses6((doc) => { doc.reference_rows = doc.reference_rows.filter((row) => row.key !== 'REF_D_A25'); }, 'Q6_REFERENCE_ROW_MISSING');
  refuses6((doc) => { doc.reference_rows[2].in_verdict = true; }, 'Q6_REFERENCE_ROW_IN_VERDICT');
  refuses6((doc) => { doc.disclosures_zh = []; }, 'Q6_DISCLOSURES_MISSING');
});

// ── 页面 ────────────────────────────────────────────────────────────────────────

const PAGE = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
function pageApi() {
  const element = (id) => ({ id, innerHTML: '', textContent: '', addEventListener() {}, querySelector() { return null; }, focus() {}, scrollIntoView() {} });
  const sandbox = {
    document: { getElementById: element, title: '' }, location: { hash: '#home' }, window: { addEventListener() {} },
    fetch: () => new Promise(() => {}), requestAnimationFrame() {}, URLSearchParams, Intl, encodeURIComponent, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${SCRIPT}\n;globalThis.__api = { CMP_RENDER, cmpBlock, renderExtraCard };`, sandbox);
  return sandbox.__api;
}

test('页面：做 / 不做卡写结论、证据强度、允许用途与 N1–N4；压力表另起一行 2008 只停放 SPY 上界；前向块写「尚未开始」与冻结的 §7', () => {
  const projection = project6();
  const api = pageApi();
  const card = api.renderExtraCard(extra(projection, 'do_or_not'), { all: true });
  assert.match(card, /class="backtest comparison do-or-not"/);
  assert.match(card, /结论：做/);
  assert.match(card, /不是生产采用/);
  for (const id of ['N1', 'N2', 'N3', 'N4']) assert.match(card, new RegExp(`<td>${id}</td>`));
  assert.doesNotMatch(card, /待 Owner 决定（建议/, '不是 Q5 的采用建议卡');
  const stress = api.CMP_RENDER.stress(block(projection, 'stress').data, {});
  assert.match(stress, /<tr class="bound-row"><td>2008-09 → 2009-03「只停放 SPY」上界行/);
  assert.match(stress, /最低 [^<（]*1,596（低于 1,800）/);
  const forward = api.cmpBlock(projection, block(projection, 'forward'), 7, { strategyRef: 'US_V5_ETF_3000USD' });
  assert.match(forward, /尚未开始/);
  assert.match(forward, /前向影子（唯一干净的确认窗口；规则现在冻结）/);
});
