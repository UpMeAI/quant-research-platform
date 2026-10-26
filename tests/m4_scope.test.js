'use strict';
/**
 * V8.1 产品里程碑修订 4（M4 范围：增加策略）A4.6 的确定性验收：
 *   1. 新 case 按 M0→M1→M2→M3 记录；A4.5 三项都满足时才能记平台级 M4；
 *   2. 负向：首案 M3 未 PASS 记 M4、新 case 跳阶段、用别的 case 的证据、未登记的策略、夹具当真实运行证据，都拒绝；
 *   3. 页面：未接入的范围内策略写「已列入 M4 范围，尚未接入」，平台 M4 一行 NOT_VERIFIED、M5 OUT_OF_SCOPE、A/B 方向「未立项」。
 * 只在测试进程的临时台账里记，测试档案与测试范围项只在进程内，不写 config。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const AUTHORITY = 'M4_SCOPE_TEST_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;
const DESK = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-m4-desk-'));
fs.mkdirSync(path.join(DESK, 'src', 'panel'), { recursive: true });
fs.writeFileSync(path.join(DESK, 'src', 'operation-review.js'), `module.exports = { OPERATION_REVIEW_BOOKS: {
  US: { US_V5_ETF_3000USD: 'PAPER' }, CRYPTO: { QUICK_SHOT_V3_1000USDT: 'PAPER', C17_V2_4000USDT: 'PAPER', CARRY_V2_SHADOW_10000USDT: 'PAPER', M4_TEST_STRATEGY_USDT: 'PAPER' } } };\n`);
fs.writeFileSync(path.join(DESK, 'src', 'panel', 'read-model.js'), [
  'module.exports = { EFFECTIVE_FROM: {}, CLOSED_BOOKS: {}, closedBook: () => false, runOffBook: () => false,',
  "  notYetEffective: () => false, bookLifecycle: () => ({ state: 'OPEN' }) };", ''].join('\n'));
fs.writeFileSync(path.join(DESK, 'src', 'panel', 'glossary.js'), `module.exports = { explain: (ref) => ({
  US_V5_ETF_3000USD: '美股 ETF 主策略账本', QUICK_SHOT_V3_1000USDT: 'Quick Shot V3 账本', C17_V2_4000USDT: '加密 C17 账本', CARRY_V2_SHADOW_10000USDT: '资金费率套利影子账本',
  M4_TEST_STRATEGY_USDT: 'M4 测试账本' })[ref] || ref };\n`);
process.env.QRP_DESK_ROOT = DESK;

const loop = require('../services/runtime-research-loop');
const diagnostics = require('../services/strategy-diagnostics');
const profiles = require('../services/strategy-profiles');
const m4Scope = require('../services/strategy-profiles/m4_scope');
const workspace = require('../services/research-workspace');
const { testProfile, installProfiles, PRODUCTION } = require('./_profile_fixture');

const ROOT = path.join(__dirname, '..');
const US = PRODUCTION.profiles[0];
const NEW_STRATEGY = 'M4_TEST_STRATEGY_USDT';
const NEW_CASE = 'RRC-M4-TEST-USDT-V8-1-M0';
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'strategy_profile.fixture_crypto_usdt.json'), 'utf8'));
delete FIXTURE._comment;
const PRODUCTION_SCOPE = m4Scope.current();
const PAGE = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));

function openCase(caseId, strategyRef, market) {
  return loop.openCase({
    case_id: caseId, strategy_ref: strategyRef, market,
    runtime_lane: { source_ref: `ACTUAL:${strategyRef}:SCAN`, source_hash: 'a'.repeat(64), version_ref: `${strategyRef}@1`, as_of: '2026-10-24T20:00:00Z', mode: 'PAPER', real_order: 0 },
    baseline: {
      baseline_id: `BASELINE-${caseId}`, strategy_ref: strategyRef, market, version_ref: `${strategyRef}@0`,
      source_ref: `ACTUAL:${strategyRef}:BASELINE`, source_hash: 'b'.repeat(64), expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
      frozen_at: '2026-10-24T20:01:00Z',
    },
    cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
    data_quality: { status: 'VALID', as_of: '2026-10-24', known_at: '2026-10-24T20:00:00Z', source_refs: [`ACTUAL:${strategyRef}:SCAN`], freshness: { state: 'CURRENT', age_seconds: 0 } },
    isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
    opened_at: '2026-10-24T20:02:00Z',
  });
}

/** 登记一份实际证据文件（不在 fixture 路径下），返回 evidence_id。 */
function evidence(caseRef, stage, kind, objectRef = null, dirName = 'm4-evidence') {
  const dir = path.join(process.env.QRP_DATA_DIR, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.createHash('sha256').update(caseRef).digest('hex').slice(0, 12)}-${stage}-${kind}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify({ caseRef, stage, kind })}\n`);
  return loop.registerProductEvidence({
    case_ref: caseRef, kind, source_ref: file, object_ref: objectRef || `ACTUAL:${caseRef}:${stage}:${kind}`,
    observed_at: '2026-10-25T10:00:00Z', registered_by: AUTHORITY,
  }).evidence_id;
}

/** M2/M3 的前提「本 case 的非 PENDING 锁定结果」：锁定结果回链的生产者有自己的测试，这里直接在临时台账写一行。 */
function lockedLink(caseRef) {
  const row = {
    link_id: `RRL-${caseRef}`, case_ref: caseRef, result_ref: `QRP:EXP-${caseRef}:RESULT_LOCKED`, result_hash: 'c'.repeat(64),
    conclusion: 'FAIL', adoption_state: 'NOT_DECIDED', production_effect: 'NONE', recorded_at: '2026-10-25T09:00:00Z',
  };
  fs.mkdirSync(path.dirname(loop.LINKS_LEDGER()), { recursive: true });
  fs.appendFileSync(loop.LINKS_LEDGER(), `${JSON.stringify(row)}\n`);
  return row.result_ref;
}

function stageInput(caseRef, stage, overrides = {}) {
  const e = (kind, objectRef) => evidence(caseRef, stage, kind, objectRef);
  const deskOutcome = `REVIEW_LOOP_WEEK_V1:${caseRef}:DONT:001`;
  return {
    case_ref: caseRef, stage, decision: 'PASS', evidence_mode: 'ACTUAL_USER_TASK', delivery_environment: 'CONTROLLED_PENDING_RELEASE',
    actual_entrypoint: `RESEARCH:strategy-detail?strategy=${caseRef}`, new_capability: `CAPABILITY:${stage}`, supported_scope: `SCOPE:${caseRef}`,
    user_operation: `USER_TASK:${stage}`, user_result: `USER_RESULT:${stage}`, exception_behavior: 'MISSING_SHOWN_AS_MISSING',
    user_evidence_refs: [e('USER_TASK')], technical_evidence_refs: [e('TECHNICAL_CHECK')],
    preparation_evidence_refs: stage === 'M0' ? [e('M0_PREPARATION')] : [],
    runtime_evidence_refs: stage === 'M1' ? [e('RUNTIME_NATIVE_REPLAY'), e('ACCOUNT_RECONCILIATION'), e('DECISION_FUNNEL')] : [],
    exception_evidence_refs: stage === 'M1' ? [e('EXCEPTION_SCENARIO')] : [],
    stress_evidence_refs: stage === 'M2' ? [e('STRESS_REPORT')] : [],
    comparison_evidence_refs: stage === 'M2' ? [e('COMPARISON_REPORT'), e('RESULT_REREAD')] : [],
    round_trip_evidence_refs: stage === 'M3' ? [e('DESK_ROUND_TRIP'), e('HISTORICAL_REREAD'), e('RESEARCH_ISOLATION'), e('DEDUPLICATION')] : [],
    reuse_evidence_refs: stage === 'M4' ? [e('REGISTRY_REUSE', 'QRP_MULTI_STRATEGY_PROFILE_REGISTRY_ACCEPTANCE_V1')] : undefined,
    result_ref: ['M2', 'M3'].includes(stage) ? `QRP:EXP-${caseRef}:RESULT_LOCKED` : null,
    desk_outcome_ref: stage === 'M3' ? deskOutcome : null,
    desk_outcome_evidence_ref: stage === 'M3' ? e('DESK_OUTCOME', deskOutcome) : null,
    release_evidence_ref: null, recorded_by: AUTHORITY,
    ...overrides,
  };
}
const record = (caseRef, stage, overrides) => loop.recordProductMilestone(stageInput(caseRef, stage, overrides));
const chainStates = (caseRef) => loop.readModel().product_delivery.cases.find((row) => row.case_ref === caseRef).stages.map((row) => `${row.stage}:${row.state}`);
const platform = () => loop.readModel().product_delivery.platform_m4;

async function renderPage(model, hash) {
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = {
    id, innerHTML: '', textContent: '', addEventListener() {}, querySelector() { return null; }, focus() {}, scrollIntoView() {},
  });
  const sandbox = {
    document: { getElementById: element, title: '' }, location: { hash }, window: { addEventListener() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(model)) }),
    requestAnimationFrame() {}, URLSearchParams, Intl, encodeURIComponent, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return elements.workspace.innerHTML;
}

// 测试档案（进程内）：一条范围内的测试策略 + tests/fixtures 的 FIXTURE_CRYPTO_USDT；测试范围 = A4.2 五条 + 这条测试策略
installProfiles(testProfile(NEW_STRATEGY, NEW_CASE), FIXTURE);
m4Scope.use(m4Scope.validate({
  ...PRODUCTION_SCOPE, items: [...PRODUCTION_SCOPE.items, { id: 'M4_TEST', batch: 9, label_zh: 'M4 测试策略', strategy_ref: NEW_STRATEGY, identity_note_zh: null, currency: 'USDT' }],
}));
// 档案 case 的 M1 要过原版诊断（闸本身的测试见 product_milestone_diagnostic_gate.test.js）：测试策略与 US_V5 桩成 VERIFIED，
// 夹具档案照常走真实诊断（它的成本模型没有模块，必须失败关闭）
const realDiagnostic = diagnostics.readFreshDiagnostic;
// 诊断的 case_ref 必须是本 case（CRYPTO_Q0_RESULT_V1 §9.5），桩也带上档案 case
diagnostics.readFreshDiagnostic = (strategyRef) => (strategyRef === FIXTURE.strategy_ref ? realDiagnostic(strategyRef)
  : { state: 'VERIFIED', case_ref: profiles.get(strategyRef).case_ref });
test.after(() => { diagnostics.readFreshDiagnostic = realDiagnostic; m4Scope.use(PRODUCTION_SCOPE); });
openCase(US.case_ref, US.strategy_ref, 'US_EQUITY');
openCase(NEW_CASE, NEW_STRATEGY, 'CRYPTO');

test('A4.1–A4.2 范围登记：唯一方向、A/B 方向未立项、五条策略按 Owner 批次、首案是 US_V5、复用合同 sha 现场一致', () => {
  const scope = m4Scope.load();
  assert.equal(scope.acceptance_sha256, crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, scope.acceptance_ref))).digest('hex'));
  assert.equal(scope.direction.label_zh, '同一工作台增加策略 / 市场');
  assert.deepEqual(scope.other_directions.map((item) => [item.label_zh, item.state_label_zh]), [['从 Cycle 线索进入 A/B 增量评价', '未立项']]);
  assert.deepEqual(scope.items.map((item) => [item.batch, item.strategy_ref, item.currency]), [
    [1, 'QUICK_SHOT_V3_1000USDT', 'USDT'], [1, 'C17_V2_4000USDT', 'USDT'], [2, null, 'CNY'], [2, null, 'USD'], [3, 'CARRY_V2_SHADOW_10000USDT', 'USDT'],
  ]);
  assert.equal(scope.first_case_strategy_ref, 'US_V5_ETF_3000USD');
  assert.equal(scope.registry_acceptance.sha256, crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, scope.registry_acceptance.ref))).digest('hex'));
  // 生产注册表：首案之外只有 Quick Shot V3（CRYPTO_Q0_RESULT_V1 冻结后登记），其余四条还没有档案
  assert.deepEqual(profiles.load().profiles.map((item) => item.strategy_ref), ['US_V5_ETF_3000USD', 'QUICK_SHOT_V3_1000USDT', 'C17_V2_4000USDT']);
  assert.throws(() => m4Scope.validate({ ...scope, items: [{ ...scope.items[2], identity_note_zh: null }] }), (error) => error.code === 'M4_SCOPE_FIELD_MISSING');
  assert.throws(() => m4Scope.validate({ ...scope, items: [{ ...scope.items[0], strategy_ref: 'US_V5_ETF_3000USD' }] }), (error) => error.code === 'M4_SCOPE_FIRST_CASE_IN_ITEMS');
});

test('A4.4 页面：平台 M4 一行 NOT_VERIFIED、M5 OUT_OF_SCOPE、A/B 方向未立项；未接入的范围内策略写「已列入 M4 范围，尚未接入」，不给零值', async () => {
  const model = await workspace.readModel({ strategyRef: 'CARRY_V2_SHADOW_10000USDT' });
  const detail = model.views['strategy-detail'];
  assert.equal(detail.m4_scope_label, '已列入 M4 范围，尚未接入');
  assert.equal(detail.m4_scope_batch, 3);
  assert.deepEqual(model.views['runtime-status'].milestones, []);
  const scope = model.views['runtime-status'].m4_scope;
  assert.equal(scope.state, 'NOT_VERIFIED');
  assert.equal(scope.m5_state, 'OUT_OF_SCOPE');
  const onboarded = new Set(['M4_TEST', 'QUICK_SHOT_V3', 'C17_V2']);
  assert.ok(scope.items.filter((item) => !onboarded.has(item.id)).every((item) => item.state_label === '已列入 M4 范围，尚未接入' && item.stages === null));
  // A4.4 第 1–2 条：Quick Shot V3 有了导入档案（CRYPTO_Q0_RESULT_V1），按它自己的 M0–M3 显示，不再写「尚未接入」
  const qs = scope.items.find((item) => item.id === 'QUICK_SHOT_V3');
  assert.equal(qs.state, 'ONBOARDED');
  assert.deepEqual(qs.stages.map((row) => `${row.stage}:${row.state}`), ['M0:NOT_VERIFIED', 'M1:NOT_VERIFIED', 'M2:NOT_VERIFIED', 'M3:NOT_VERIFIED']);
  assert.equal((await workspace.readModel({ strategyRef: 'QUICK_SHOT_V3_1000USDT' })).views['strategy-detail'].m4_scope_label, undefined);

  const detailHtml = await renderPage(model, '#strategy-detail?strategy=CARRY_V2_SHADOW_10000USDT&section=all');
  assert.match(detailHtml, /已列入 M4 范围，尚未接入/);
  assert.doesNotMatch(detailHtml, /尚未验证|NOT_VERIFIED/);
  const statusHtml = await renderPage(model, '#runtime-status?strategy=CARRY_V2_SHADOW_10000USDT');
  assert.match(statusHtml, /M4 范围：同一工作台增加策略 \/ 市场/);
  assert.match(statusHtml, /平台级 M4：尚未验证/);
  assert.match(statusHtml, /M5：本轮不做/);
  assert.match(statusHtml, /从 Cycle 线索进入 A\/B 增量评价：未立项/);
  // A4.2 其余四条还没有导入档案（Quick Shot V3 与本测试进程里加的测试范围项写「已接入」）
  assert.equal((statusHtml.match(/已列入 M4 范围，尚未接入/g) || []).length, 3);
  assert.equal(scope.items.filter((item) => item.state === 'IN_SCOPE_NOT_ONBOARDED').length, 3);
  assert.match(statusHtml, /第 1 批 · Quick Shot V3<\/strong>（USDT）：已接入，按本策略自己的 M0→M3 记录/);
  assert.match(statusHtml, /第 2 批 · Ashare-V6 个股账本（五段链）<\/strong>（CNY）：已列入 M4 范围，尚未接入<br><span class="muted-inline">策略身份在其 K2 冻结时确定/);
  for (const item of scope.items) assert.ok(!/零|0 \/ /.test(item.state_label));

  // 首案页面：它不在 A4.2 里，不带范围标签；阶段行里 M4 是平台级 NOT_VERIFIED，M5 仍 OUT_OF_SCOPE
  const usModel = await workspace.readModel({ strategyRef: US.strategy_ref });
  assert.equal(usModel.views['strategy-detail'].m4_scope_label, undefined);
  assert.deepEqual(usModel.views['runtime-status'].milestones.map((row) => `${row.stage}:${row.state}`),
    ['M0:NOT_VERIFIED', 'M1:NOT_VERIFIED', 'M2:NOT_VERIFIED', 'M3:NOT_VERIFIED', 'M4:NOT_VERIFIED', 'M5:OUT_OF_SCOPE']);
});

test('A4.6.2 负向：未登记的策略、不是档案 case、用别的 case 的证据、跳阶段、夹具当真实运行证据、M5，都拒绝', () => {
  // 未登记的策略记任何阶段
  openCase('RRC-CARRY-V2-SHADOW-10000USDT-V8-1-M0', 'CARRY_V2_SHADOW_10000USDT', 'CRYPTO');
  assert.throws(() => record('RRC-CARRY-V2-SHADOW-10000USDT-V8-1-M0', 'M0'), /PRODUCT_MILESTONE_STRATEGY_NOT_REGISTERED:CARRY_V2_SHADOW_10000USDT/);
  // 已登记的策略，但不是它档案里冻结的 case
  openCase('RRC-M4-TEST-OTHER-CASE', NEW_STRATEGY, 'CRYPTO');
  assert.throws(() => record('RRC-M4-TEST-OTHER-CASE', 'M0'), /PRODUCT_MILESTONE_CASE_NOT_PROFILE_CASE:RRC-M4-TEST-OTHER-CASE/);

  // 首案的 M0 已 PASS，新 case 也不能继承：跳过自己的 M0 记 M1 被拒绝
  record(US.case_ref, 'M0');
  assert.throws(() => record(NEW_CASE, 'M1'), /PRODUCT_MILESTONE_UPSTREAM_NOT_VERIFIED:M0/);
  // 用首案的证据给新 case 记阶段
  const usEvidence = stageInput(US.case_ref, 'M0');
  assert.throws(() => record(NEW_CASE, 'M0', { user_evidence_refs: usEvidence.user_evidence_refs }), /PRODUCT_EVIDENCE_CASE_MISMATCH/);
  assert.throws(() => record(NEW_CASE, 'M0', { preparation_evidence_refs: usEvidence.preparation_evidence_refs }), /PRODUCT_EVIDENCE_CASE_MISMATCH/);
  // 夹具当真实运行证据：fixture 路径的文件不能登记；带 FIXTURE 的证据引用不能用于记阶段
  const fixtureDir = path.join(process.env.QRP_DATA_DIR, 'fixture-runs');
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'replay.json'), '{"fixture":true}\n');
  assert.throws(() => loop.registerProductEvidence({
    case_ref: NEW_CASE, kind: 'RUNTIME_NATIVE_REPLAY', source_ref: path.join(fixtureDir, 'replay.json'),
    object_ref: 'REPLAY', observed_at: '2026-10-25T10:00:00Z', registered_by: AUTHORITY,
  }), /PRODUCT_EVIDENCE_NON_ACTUAL_SOURCE/);
  assert.throws(() => record(NEW_CASE, 'M0', { technical_evidence_refs: ['PE-FIXTURE-REPLAY'] }), /PRODUCT_MILESTONE_NON_ACTUAL_EVIDENCE_REF/);
  // tests/fixtures 的测试档案：以它命名的证据文件不能登记；即使证据文件不带夹具字样，M1 也必须过它自己的原版诊断，
  // 它没有成本模型模块，失败关闭
  openCase(FIXTURE.case_ref, FIXTURE.strategy_ref, 'CRYPTO');
  const named = path.join(process.env.QRP_DATA_DIR, 'm4-evidence', `${FIXTURE.case_ref}-M0-USER_TASK.json`);
  fs.mkdirSync(path.dirname(named), { recursive: true });
  fs.writeFileSync(named, '{"case":"fixture"}\n');
  assert.throws(() => loop.registerProductEvidence({
    case_ref: FIXTURE.case_ref, kind: 'USER_TASK', source_ref: named, object_ref: 'USER_TASK', observed_at: '2026-10-25T10:00:00Z', registered_by: AUTHORITY,
  }), /PRODUCT_EVIDENCE_NON_ACTUAL_SOURCE/);
  record(FIXTURE.case_ref, 'M0');
  assert.throws(() => record(FIXTURE.case_ref, 'M1'), /PRODUCT_MILESTONE_M1_DIAGNOSTIC_NOT_VERIFIED:INVALID:DIAGNOSTIC_PRODUCER_NOT_REGISTERED/);
  // M5 仍不在范围
  assert.throws(() => record(NEW_CASE, 'M5'), /PRODUCT_MILESTONE_STAGE_OUT_OF_SCOPE:M5/);
  // 什么都没写进新 case
  assert.deepEqual(chainStates(NEW_CASE).slice(0, 4), ['M0:NOT_VERIFIED', 'M1:NOT_VERIFIED', 'M2:NOT_VERIFIED', 'M3:NOT_VERIFIED']);
});

test('A4.6.1 正向与 A4.5：新 case 按 M0→M3 记录；首案 M3 未 PASS 时拒绝平台 M4；三项都满足才记 M4，首案 M3 撤销后平台 M4 失效', () => {
  for (const stage of ['M0', 'M1']) record(NEW_CASE, stage);
  lockedLink(NEW_CASE);
  for (const stage of ['M2', 'M3']) record(NEW_CASE, stage);
  assert.deepEqual(chainStates(NEW_CASE).slice(0, 4),
    ['M0:CONTROLLED_VERIFIED', 'M1:CONTROLLED_VERIFIED', 'M2:CONTROLLED_VERIFIED', 'M3:CONTROLLED_VERIFIED']);
  // 新 case 的进展不推出首案的 M3（A4.0.3）
  assert.deepEqual(chainStates(US.case_ref).slice(0, 4), ['M0:CONTROLLED_VERIFIED', 'M1:NOT_VERIFIED', 'M2:NOT_VERIFIED', 'M3:NOT_VERIFIED']);
  assert.equal(platform().state, 'NOT_VERIFIED');

  // A4.5.1：首案 M3 未 PASS，记平台 M4 被拒绝
  assert.throws(() => record(NEW_CASE, 'M4'), /PRODUCT_MILESTONE_M4_FIRST_CASE_M3_NOT_PASSED:NOT_VERIFIED/);
  // 首案走完自己的 M1→M3
  record(US.case_ref, 'M1');
  lockedLink(US.case_ref);
  record(US.case_ref, 'M2');
  const usM3 = record(US.case_ref, 'M3');
  // 首案自己不在 A4.2 里，不能记 M4 范围项；测试夹具档案也不在
  assert.throws(() => record(US.case_ref, 'M4'), /PRODUCT_MILESTONE_M4_STRATEGY_NOT_IN_SCOPE:US_V5_ETF_3000USD/);
  // A4.5.3：没有复用证据（注册表与页面已验收）不能记
  assert.throws(() => record(NEW_CASE, 'M4', { reuse_evidence_refs: [] }), /PRODUCT_MILESTONE_M4_REUSE_EVIDENCE_REQUIRED/);
  assert.throws(() => record(NEW_CASE, 'M4', { reuse_evidence_refs: [stageInput(NEW_CASE, 'M3').technical_evidence_refs[0]] }),
    /PRODUCT_MILESTONE_M4_REUSE_EVIDENCE_REQUIRED:REGISTRY_REUSE/);
  assert.equal(platform().state, 'NOT_VERIFIED');

  const m4 = record(NEW_CASE, 'M4');
  assert.equal(m4.stage, 'M4');
  assert.equal(m4.reuse_evidence_refs.length, 1);
  assert.ok(m4.acceptance_amendment_refs.includes(loop.PRODUCT_ACCEPTANCE_AMENDMENT_4_REF));
  assert.equal(record(NEW_CASE, 'M4').replayHit, true);
  let p = platform();
  assert.equal(p.state, 'CONTROLLED_VERIFIED');
  assert.deepEqual(p.passed_items, ['M4_TEST']);
  assert.equal(p.supports_all_items, false); // 只有五条（及这里的测试项）全部通过才算支持全部
  assert.ok(p.items.filter((item) => item.id !== 'M4_TEST' && item.id !== 'QUICK_SHOT_V3' && item.id !== 'C17_V2').every((item) => item.state === 'IN_SCOPE_NOT_ONBOARDED'));
  assert.deepEqual(chainStates(US.case_ref).slice(4), ['M4:CONTROLLED_VERIFIED', 'M5:OUT_OF_SCOPE']);

  // 首案 M3 撤销：平台 M4 派生回 NOT_VERIFIED，历史 M4 行保留
  loop.recordProductMilestone({
    case_ref: US.case_ref, stage: 'M3', decision: 'REVOKED', revokes_ref: usM3.evidence_id,
    defect_ref: 'DEFECT_ESCAPE:M4_SCOPE_TEST:001', revocation_reason: 'FIRST_CASE_ROUND_TRIP_INVALIDATED', recorded_by: AUTHORITY,
  });
  p = platform();
  assert.equal(p.state, 'NOT_VERIFIED');
  assert.equal(p.first_case.m3_state, 'REVOKED');
  assert.equal(p.items.find((item) => item.id === 'M4_TEST').m4_state, 'CONTROLLED_VERIFIED');
});

test('CRYPTO_Q0_RESULT_V1 §11.10：Quick Shot V3 的 case 按 M0→M3 用自己的证据记录；US_V5 的证据、别的 case 的诊断、跳阶段、诊断不是 VERIFIED 时的 M1 PASS 都拒绝', () => {
  const qs = profiles.mustGet('QUICK_SHOT_V3_1000USDT');
  openCase(qs.case_ref, qs.strategy_ref, 'CRYPTO_USDM_PERP');
  // 跳阶段：自己的 M0 没有 PASS 就记 M1
  assert.throws(() => record(qs.case_ref, 'M1'), /PRODUCT_MILESTONE_UPSTREAM_NOT_VERIFIED:M0/);
  // 用 US_V5 的证据给 Quick Shot 记阶段
  const usEvidence = stageInput(US.case_ref, 'M0');
  assert.throws(() => record(qs.case_ref, 'M0', { user_evidence_refs: usEvidence.user_evidence_refs }), /PRODUCT_EVIDENCE_CASE_MISMATCH/);
  record(qs.case_ref, 'M0');
  const stub = diagnostics.readFreshDiagnostic;
  try {
    // 诊断不是 VERIFIED（例如 M1 包还没拷进 var/evidence）：M1 PASS 拒绝
    diagnostics.readFreshDiagnostic = () => ({ state: 'MISSING', reason_code: 'QS_V3_M1_INPUT_PACKAGE_MISSING', case_ref: qs.case_ref });
    assert.throws(() => record(qs.case_ref, 'M1'), /PRODUCT_MILESTONE_M1_DIAGNOSTIC_NOT_VERIFIED:MISSING:QS_V3_M1_INPUT_PACKAGE_MISSING/);
    // VERIFIED 但属于别的 case（US_V5 的诊断不能充当 Quick Shot 的运行证据）
    diagnostics.readFreshDiagnostic = () => ({ state: 'VERIFIED', case_ref: US.case_ref });
    assert.throws(() => record(qs.case_ref, 'M1'), new RegExp(`PRODUCT_MILESTONE_M1_DIAGNOSTIC_CASE_MISMATCH:${US.case_ref}`));
  } finally { diagnostics.readFreshDiagnostic = stub; }
  record(qs.case_ref, 'M1');
  lockedLink(qs.case_ref);
  for (const stage of ['M2', 'M3']) record(qs.case_ref, stage);
  assert.deepEqual(chainStates(qs.case_ref).slice(0, 4),
    ['M0:CONTROLLED_VERIFIED', 'M1:CONTROLLED_VERIFIED', 'M2:CONTROLLED_VERIFIED', 'M3:CONTROLLED_VERIFIED']);
  const item = platform().items.find((row) => row.id === 'QUICK_SHOT_V3');
  assert.equal(item.case_ref, qs.case_ref);
  assert.deepEqual(item.stages.map((row) => row.state), ['CONTROLLED_VERIFIED', 'CONTROLLED_VERIFIED', 'CONTROLLED_VERIFIED', 'CONTROLLED_VERIFIED']);
});
