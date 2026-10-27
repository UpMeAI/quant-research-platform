'use strict';
/**
 * 策略总览的研究进度（services/research-workspace/stage.js）。
 * 一、推导：给定事实（档案、M4 范围、case 关系、M1、Q0、对比、采用、待研究）→ 进度代码、结论句、卡片四行、计数，逐字断言。
 * 二、读模型：临时账本里导入 Q0／Q1 锁与采用记录，确认每条策略的进度只取自自己的登记与账本、与所选策略无关；
 *     页头计数数到每一条有研究记录的策略；总览卡片显示进度，不再出现「建立关联」「运行态 case 尚未建立」「暂无研究问题」。
 * 记录全部写在测试自己的临时账本里（夹具结果拷到不带 fixture 字样的路径，页面读取时按真实路径校验）。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const { dataRoot } = require('./_env');
const loop = require('../services/runtime-research-loop');
const workspace = require('../services/research-workspace');
const stage = require('../services/research-workspace/stage');
const q0 = require('../services/baseline-evaluation');
const cc = require('../services/candidate-comparison');
const adoption = require('../services/research-adoption');
const overview = require('../services/research-adoption/overview');
const experiments = require('../services/experiment-orchestrator');
const fx0 = require('./_q0_fixture');
const fx1 = require('./_q1_fixture');
const fxC17 = require('./_c17_q0_fixture');

const US_V5 = cc.STRATEGY_REF;
const C17 = 'C17_V2_4000USDT';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));

// ── 一、推导（纯函数）──────────────────────────────────────────────────────────────

const decided = (decision) => ({ kind: 'DECISION', decision, decided_at: '2026-10-26T18:00:00+08:00', follow_up_zh: '后续', record_id: `ADR-${decision}` });
const card = (question, extra = {}) => ({
  question_ref: question, state: 'LOCKED_VERIFIED', verdict_label: '证据不足', result_id: `${question}-0000000000000000`,
  adoption: overview.adoptionOf(null), ...extra,
});
const facts = (extra = {}) => ({
  profile: true, m4: null, current_case: false, baseline_of_case: false, m1: { state: 'REGISTERED' },
  q0: { state: 'LOCKED_VERIFIED', verdict_label: '证据不足', a0: { state: 'PASSED', basis_zh: null }, result_id: 'Q0-aaaaaaaaaaaaaaaa', superseded_result_ids: [] },
  comparisons: [], rounds: null, open: [], ...extra,
});
const stepText = (result) => Object.fromEntries(result.steps.map((step) => [step.label_zh, step.text_zh]));

test('推导：没有档案、没有 case 的策略——未接入；列入 M4 范围的写批次；都不算研究记录、没有卡片四行', () => {
  const none = stage.stageOf({ ...facts({ profile: false, m1: null, q0: null }) });
  assert.equal(none.code, 'NOT_CONNECTED');
  assert.equal(none.headline_zh, '尚未接入 Research');
  assert.equal(none.has_record, false);
  assert.deepEqual(none.steps, []);
  const m4 = stage.stageOf(facts({ profile: false, m1: null, q0: null, m4: { state: 'IN_SCOPE_NOT_ONBOARDED', state_label: '已列入 M4 范围，尚未接入', batch: 3 } }));
  assert.equal(m4.code, 'M4_PENDING');
  assert.equal(m4.headline_zh, '已列入 M4 范围，尚未接入（第 3 批）');
  assert.equal(m4.has_record, false);
});

test('推导：只作为别的 case 的冻结基线——算研究记录，一句话，不给卡片四行', () => {
  const result = stage.stageOf(facts({ profile: false, m1: null, q0: null, baseline_of_case: true }));
  assert.equal(result.code, 'FROZEN_BASELINE');
  assert.equal(result.has_record, true);
  assert.equal(result.headline_zh, '作为冻结基线关联，不接收新的研究结论');
  assert.deepEqual(result.steps, []);
});

test('推导：已登记档案、Q0 没锁——已接入，Q0 尚未锁定；不写 A0、不写任何结论', () => {
  const result = stage.stageOf(facts({ q0: { state: 'NOT_IMPORTED', verdict_label: null, a0: null, result_id: null, superseded_result_ids: [] } }));
  assert.equal(result.code, 'CONNECTED');
  assert.equal(result.headline_zh, '已接入，Q0 尚未锁定');
  assert.deepEqual(stepText(result), {
    体检与基线: 'M1 体检包已登记 · Q0 尚未锁定', 方案对比: '尚未开始', 采用决定: '还没有可决定的对比结果', 待研究: '研究计划里没有排队的题',
  });
  assert.equal(result.counts.q0_locked, false);
});

test('推导：Q0 封存结果校验失败——写失败，不写结论词', () => {
  for (const [state, text] of [['INVALID', 'Q0 已有封存结果，但校验未通过'], ['MISSING', 'Q0 已有封存结果，但文件或旁证缺失']]) {
    const result = stage.stageOf(facts({ q0: { state, verdict_label: null, a0: null, result_id: 'Q0-bbbbbbbbbbbbbbbb', superseded_result_ids: [] } }));
    assert.equal(result.code, 'Q0_INVALID');
    assert.equal(result.headline_zh, text);
    assert.doesNotMatch(JSON.stringify(result), /证据不足|未通过（|A0 通过/);
  }
});

test('推导：Q0 已锁、A0 未通过、替代过旧锁、计划里一题待立题——结论句先写 Q0 与 A0，再写对比与待研究', () => {
  const result = stage.stageOf(facts({
    m1: { state: 'NO_PRODUCER' },
    q0: { state: 'LOCKED_VERIFIED', verdict_label: '证据不足', a0: { state: 'FAILED', basis_zh: null }, result_id: 'Q0-cccccccccccccccc', superseded_result_ids: ['Q0-dddddddddddddddd'] },
    open: [{ question_ref: 'Q4', title_zh: '风控维度', phase: 'READY_FOR_K2', waiting_on: [] }],
  }));
  assert.equal(result.code, 'Q0_LOCKED');
  assert.equal(result.headline_zh, 'Q0 证据不足（A0 未通过）；方案对比尚未开始，1 题待研究');
  assert.deepEqual(stepText(result), {
    体检与基线: 'M1 体检包已登记，QRP 尚无它的诊断生产者 · A0 未通过 · Q0 证据不足（替代过 1 份旧锁）',
    方案对比: '尚未开始', 采用决定: '还没有可决定的对比结果', 待研究: 'Q4 风控维度（待立题，等 K2 冻结）',
  });
  assert.deepEqual(result.technical, [{ label: 'Q0 锁', value: 'Q0-cccccccccccccccc' }, { label: '已替代的 Q0 锁', value: 'Q0-dddddddddddddddd' }]);
});

test('推导：A0 按裁定通过时写依据；A0 通过时结论句不提 A0', () => {
  const result = stage.stageOf(facts({ q0: { ...facts().q0, a0: { state: 'PASSED', basis_zh: 'A0 裁定 1' } } }));
  assert.equal(result.headline_zh, 'Q0 证据不足；方案对比尚未开始');
  assert.equal(stepText(result)['体检与基线'], 'M1 体检包已登记 · A0 通过（按 A0 裁定 1） · Q0 证据不足');
});

test('推导：五题已锁定、两轮、采用与不采用混合、一题只有建议、一题校验失败、一题排队——计数取自采用记录的有效那条', () => {
  const recommendation = { kind: 'RECOMMENDATION', coordinator_recommendation: { recommendation: 'ADOPT', reason_zh: '理由' }, record_id: 'ADR-REC' };
  const result = stage.stageOf(facts({
    q0: { ...facts().q0, verdict_label: '未通过' },
    comparisons: [
      card('Q1', { adoption: overview.adoptionOf(decided('ADOPT')) }),
      card('Q2', { adoption: overview.adoptionOf(decided('NOT_ADOPTED')) }),
      card('Q3', { verdict_label: '有支持证据', adoption: overview.adoptionOf(decided('NOT_ADOPTED')) }),
      card('Q4', { adoption: overview.adoptionOf(decided('ADOPT')) }),
      card('Q5', { adoption: overview.adoptionOf(recommendation) }),
      { question_ref: 'Q6', state: 'INVALID', verdict_label: null, result_id: null, adoption: overview.adoptionOf(null) },
    ],
    rounds: 2,
    open: [{ question_ref: 'Q7', title_zh: '下一题', phase: 'QUEUED', waiting_on: ['Q6'] }],
  }));
  assert.equal(result.code, 'DECIDED');
  assert.equal(result.headline_zh, 'Q0 未通过；方案对比 5 题已锁定，已决定 4 题（采用 2、不采用 2），待决定 1 题；1 题待研究');
  assert.deepEqual(stepText(result), {
    体检与基线: 'M1 体检包已登记 · A0 通过 · Q0 未通过',
    方案对比: '5 题已锁定（Q1、Q2、Q3、Q4、Q5，2 轮）：证据不足 4、有支持证据 1；1 题封存结果校验未通过（Q6）',
    采用决定: '采用 2（Q1、Q4）、不采用 2（Q2、Q3）、待 Owner 决定 1（Q5）',
    待研究: 'Q7 下一题（排队，等 Q6 锁定）',
  });
  assert.deepEqual(result.counts, {
    q0_locked: true, comparisons_locked: 5, comparisons_broken: 1, rounds: 2, decided: 4, adopted: 2, not_adopted: 2, pending: 1, open: 1,
  });
});

test('推导：已锁定对比、还没有任何决定——写「待 Owner 决定 N 题」，进度代码 COMPARED', () => {
  const result = stage.stageOf(facts({ comparisons: [card('Q1'), card('Q2')], open: [{ question_ref: 'Q3', title_zh: '第三题', phase: 'RUNNING', waiting_on: [] }] }));
  assert.equal(result.code, 'COMPARED');
  assert.equal(result.headline_zh, 'Q0 证据不足；方案对比 2 题已锁定，待 Owner 决定 2 题；1 题待研究');
  assert.equal(stepText(result)['待研究'], 'Q3 第三题（进行中，K2 已冻结）');
});

test('推导：页头计数句——有研究记录的每一条都数到，再按走到的一步细分；没有记录时如实写', () => {
  const stages = [
    stage.stageOf(facts({ comparisons: [card('Q1', { adoption: overview.adoptionOf(decided('ADOPT')) })] })),
    stage.stageOf(facts()), stage.stageOf(facts()), stage.stageOf(facts()),
    stage.stageOf(facts({ profile: false, m1: null, q0: null, baseline_of_case: true })),
    stage.stageOf(facts({ q0: { state: 'NOT_IMPORTED', verdict_label: null, a0: null, result_id: null, superseded_result_ids: [] } })),
    stage.stageOf(facts({ profile: false, m1: null, q0: null, m4: { state: 'IN_SCOPE_NOT_ONBOARDED', state_label: '已列入 M4 范围，尚未接入', batch: 3 } })),
    stage.stageOf(facts({ profile: false, m1: null, q0: null })),
  ];
  const counts = stage.countsOf(stages);
  assert.deepEqual(counts, { with_record: 6, q0_locked: 4, q0_invalid: 0, compared: 1, decided: 1, connected_without_q0: 1, frozen_baseline: 1, m4_pending: 1 });
  assert.equal(stage.countsSentence(counts),
    '其中 6 个有研究记录：4 个已锁定 Q0 回测结论（1 个已有锁定的方案对比、1 个已有 Owner 采用决定），1 个已接入、Q0 尚未锁定，1 个作为冻结基线关联；另有 1 个已列入 M4 范围、尚未接入。');
  assert.equal(stage.countsSentence(stage.countsOf([stages[7]])), '目前没有策略有研究记录。');
});

// ── 二、读模型（临时账本）────────────────────────────────────────────────────────────

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
let copies = 0;
/** 夹具结果（及旁边的 .sha256）拷到不带 fixture 字样的路径，页面读取时按真实路径校验。 */
function actualCopy(file) {
  const dir = path.join(dataRoot, `stage-results-${copies += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(file));
  fs.copyFileSync(file, target);
  fs.copyFileSync(`${file}.sha256`, `${target}.sha256`);
  return target;
}

loop.openCase({
  case_id: cc.CASE_REF, strategy_ref: US_V5, market: 'US_EQUITY',
  runtime_lane: { source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64), version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
  baseline: {
    baseline_id: 'BASELINE-STAGE-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY', version_ref: 'US_V5_ETF_6000USD@frozen-old',
    source_ref: 'SMARTFLOW:SIGNED_RESEARCH:US_V5_ETF_6000USD', source_hash: 'b'.repeat(64), expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
    frozen_at: '2026-10-24T20:01:00Z',
  },
  cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
  data_quality: { status: 'VALID', as_of: '2026-10-23', known_at: '2026-10-24T20:00:00Z', source_refs: ['SMARTFLOW:US_V5_SCAN_RECORD_V2'], freshness: { state: 'CURRENT', age_seconds: 0 } },
  isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
  opened_at: '2026-10-24T20:02:00Z',
});

const HYPOTHESIS = { research_question: 'Desk 复盘：开盘冷却是否该延长', expected_mechanism: 'm', failure_condition: 'f', primary_metric: 'g', guardrails: ['dd'] };
// 平台工程样例：没有任何 case 回链，不属于任何一条策略
experiments.registerHypothesis({ ...HYPOTHESIS, hypothesis_id: 'HYP-ENGINEERING-SAMPLE', research_question: '平台工程样例：量能分位' });
const deskHypothesis = experiments.registerHypothesis({ ...HYPOTHESIS, hypothesis_id: 'HYP-STAGE-DESK' });
loop.registerReviewQuestion(cc.CASE_REF, {
  link_id: 'RRL-STAGE-TEST', desk_candidate_ref: 'RLC-US-STAGE-01', desk_evidence_ref: 'REVIEW_LOOP_WEEK_V1:2026-W43:R9#candidate',
  desk_evidence_hash: 'e'.repeat(64), research_question_ref: deskHypothesis.hypothesis_id, recorded_at: '2026-10-24T20:03:00Z',
});

const doc0 = fx0.result();
const lock0 = q0.importBaselineEvaluation(actualCopy(fx0.write(doc0)), { registeredBy: AUTHORITY });
const lock1 = cc.importCandidateComparison(actualCopy(fx1.write(fx1.result(doc0, lock0.file_sha256, lock0.result_id))), { registeredBy: AUTHORITY });
const evidenceFile = path.join(dataRoot, 'stage-adoption-evidence.md');
fs.writeFileSync(evidenceFile, 'Owner 决定记录（测试）\n');
adoption.recordAdoption({
  result_id: lock1.result_id, decision: 'ADOPT', follow_up_zh: '纳入组合候选', decided_by: 'OWNER', owner_words: '这个采用', decided_at: '2026-10-26T21:00:00+08:00',
  coordinator_recommendation: { recommendation: 'ADOPT', reason_zh: '依据见对比卡' }, evidence_ref: { path: evidenceFile, sha256: sha(fs.readFileSync(evidenceFile)) },
}, { writtenBy: AUTHORITY });
q0.importBaselineEvaluation(actualCopy(fxC17.write(fxC17.result())), { registeredBy: AUTHORITY, strategyRef: C17 });

async function renderOverview(model) {
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = {
    id, innerHTML: '', textContent: '', addEventListener() {}, querySelector() { return null; }, focus() {}, scrollIntoView() {},
  });
  const sandbox = {
    document: { getElementById: element, title: '' }, location: { hash: '#strategies' }, window: { addEventListener() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(model)) }),
    requestAnimationFrame() {}, URLSearchParams, Intl, encodeURIComponent, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return elements.workspace.innerHTML;
}
const byRef = (model) => new Map(model.strategy_directory.strategies.map((item) => [item.strategy_ref, item]));

test('读模型：每条策略的进度取自自己的档案、锁和采用记录——选哪条策略，总览上的进度与页头那句都逐字相同', async () => {
  const selections = [null, US_V5, C17, 'QUICK_SHOT_V3_1000USDT', 'ASHARE_V6_PAPER', 'US_V5_ETF_6000USD'];
  const models = [];
  for (const strategyRef of selections) models.push(await workspace.readModel({ strategyRef }));
  const stages = models.map((model) => JSON.stringify(model.strategy_directory.strategies.map((item) => [item.strategy_ref, item.research_stage])));
  assert.ok(stages.every((value) => value === stages[0]), '研究进度随所选策略变化');
  assert.ok(models.every((model) => model.views.strategies.answer === models[0].views.strategies.answer), '页头那句随所选策略变化');
  // 选了别的策略时，US_V5 的卡片也照实写对比与采用（缺陷：曾写「已接入，暂无研究问题」）
  const html = await renderOverview(models[2]);
  assert.doesNotMatch(html, /暂无研究问题|建立关联|运行态 case 尚未建立/);
});

test('读模型：US_V5——Q0 结论与 A0 取自锁定文件的投影，对比与采用取自账本，Desk 回链的研究问题算待研究，平台工程样例不算', async () => {
  const model = await workspace.readModel({ strategyRef: C17 });
  const projection = q0.readProjection(cc.CASE_REF);
  assert.equal(projection.state, 'LOCKED_VERIFIED');
  assert.deepEqual(projection.a0, { state: doc0.gates.A0.state, basis_zh: null });
  const us = byRef(model).get(US_V5).research_stage;
  const verdict = projection.conclusion.label;
  assert.equal(us.code, 'DECIDED');
  assert.equal(us.counts.comparisons_locked, 1);
  assert.equal(us.counts.adopted, 1);
  assert.match(us.headline_zh, new RegExp(`^Q0 ${verdict}；方案对比 1 题已锁定，已决定 1 题（采用 1）；\\d+ 题待研究$`));
  const steps = stepText(us);
  assert.equal(steps['体检与基线'], `M1 体检包已登记 · A0 ${doc0.gates.A0.state === 'PASSED' ? '通过' : '未通过'} · Q0 ${verdict}`);
  assert.match(steps['方案对比'], /^1 题已锁定（Q1，1 轮）：/);
  assert.equal(steps['采用决定'], '采用 1（Q1）');
  assert.match(steps['待研究'], /Desk 复盘：开盘冷却是否该延长（Desk 研究问题，尚无锁定结果）/);
  assert.doesNotMatch(JSON.stringify(model.strategy_directory.strategies.map((item) => item.research_stage)), /平台工程样例/);
  assert.ok(us.technical.some((row) => row.value === lock0.result_id) && us.technical.some((row) => row.value === lock1.result_id));
});

test('读模型：C17——没有运行态 case 也照锁写 Q0、A0 未通过、计划里的待立题；接入标签与总览卡片是同一句', async () => {
  const model = await workspace.readModel({ strategyRef: C17 });
  const c17 = byRef(model).get(C17);
  assert.equal(c17.research_stage.code, 'Q0_LOCKED');
  assert.match(c17.research_stage.headline_zh, /^Q0 [^；]+（A0 未通过）；方案对比尚未开始，1 题待研究$/);
  assert.match(stepText(c17.research_stage)['待研究'], /^Q4 风控维度：[^（]+（待立题，等 K2 冻结）$/);
  assert.equal(c17.research.label, c17.research_stage.headline_zh);
  assert.equal(model.context.subtitle.endsWith(c17.research_stage.headline_zh), true);
});

test('读模型：页头数到每一条有研究记录的策略（四条已登记档案 + 冻结基线），细分与卡片一致；总览卡片显示结论句与四行', async () => {
  const model = await workspace.readModel();
  const counts = model.strategy_directory.counts.research_stage;
  assert.deepEqual(counts, { with_record: 5, q0_locked: 2, q0_invalid: 0, compared: 1, decided: 1, connected_without_q0: 2, frozen_baseline: 1, m4_pending: 1 });
  assert.equal(model.strategy_directory.counts.research_connected, 5);
  assert.equal(model.views.strategies.answer,
    'Desk 共登记 8 个系统策略：6 个运行或观察中，2 个历史或收尾；其中 5 个有研究记录：2 个已锁定 Q0 回测结论（1 个已有锁定的方案对比、1 个已有 Owner 采用决定），2 个已接入、Q0 尚未锁定，1 个作为冻结基线关联；另有 1 个已列入 M4 范围、尚未接入。');
  const html = await renderOverview(model);
  for (const item of model.strategy_directory.strategies) {
    assert.ok(html.includes(`Research：${item.research_stage.headline_zh}</p>`), `${item.strategy_ref} 卡片缺结论句`);
  }
  const withSteps = model.strategy_directory.strategies.filter((item) => item.research_stage.steps.length).length;
  assert.equal((html.match(/<dl class="stage-steps">/g) || []).length, withSteps);
  assert.equal(withSteps, 4);
  assert.doesNotMatch(html, /建立关联|运行态 case 尚未建立|暂无研究问题/);
});
