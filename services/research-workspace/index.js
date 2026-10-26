'use strict';

/**
 * Research Web 的人类可读 canonical projection。
 *
 * 这里只翻译与编排既有生产者已经给出的事实：
 * - Desk/市场仓生产运行事实；
 * - runtime-research-loop 生产 case、研究回链与产品里程碑事实；
 * - QRP 各服务生产工程研究对象。
 *
 * 本层不重算策略、不判定采用、不写任何账本，也不把工程样例冒充 Desk 当前策略。
 *
 * 策略详情按所选 strategy_ref 取策略档案（services/strategy-profiles）：诊断、回测、对比和前向观察都只读这条策略自己的档案；
 * 没有登记档案的策略（含 Desk 目录里没有的）详情写「该策略尚未接入研究」，不显示任何别的策略的数字。
 */
const path = require('path');
const runtimeResearchLoop = require('../runtime-research-loop');
const registry = require('../strategy-registry');
const experiments = require('../experiment-orchestrator');
const races = require('../race-orchestrator');
const shadow = require('../shadow-control');
const controlPlane = require('../strategy-control-plane');
const migration = require('../strategy-control-plane/migration');
const runtimeStatus = require('../runtime-status');
const deskStrategyDirectory = require('../desk-strategy-directory');
const strategyDiagnostics = require('../strategy-diagnostics');
const baselineEvaluation = require('../baseline-evaluation');
const candidateComparison = require('../candidate-comparison');
const hkForward = require('../hk-forward-observations');
const profiles = require('../strategy-profiles');
const detailNotes = require('../strategy-detail-notes');
const adoption = require('../research-adoption');
const adoptionView = require('../research-adoption/overview');
const detailSummary = require('./summary');
const { listAdapters } = require('../../adapters/registry');

const ACCEPTANCE_REF = 'docs/contracts/CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_2.md';
const NOT_REGISTERED_LABEL = '该策略尚未接入研究';
/** 非 LEGACY 档案已锁 Q0、运行态 case 还没建立时的接入状态（页头、目录卡片同一写法）。 */
const BASELINE_LOCKED_LABEL = 'Q0 回测结论已锁定；运行态 case 尚未建立';

const NAVIGATION = Object.freeze([
  { route: 'strategies', label: '策略总览', question: 'Desk 当前有哪些运行、观察和历史策略？' },
  { route: 'experiments', label: '研究队列', question: '哪些 Desk 问题正在研究，原版与候选方案是否已有锁定结论？' },
  { route: 'shadow', label: '前向观察', question: '锁定结论是否进入前向观察，样本是否足够？' },
  { route: 'promotion', label: '复盘与采用', question: '结论是否回到 Desk，用户如何决定，对生产有什么影响？' },
  { route: 'runtime-status', label: '数据与运行状态', question: '实际输入是否新鲜、完整、可回放，Research 有哪些权限？' },
]);

const COMPATIBILITY_ROUTES = Object.freeze({
  'runtime-research-loop': { route: 'strategy-detail', section: 'health' },
  races: { route: 'experiments', section: 'comparison' },
});

const MARKET_CATALOG = Object.freeze([
  { market_ref: 'CN_A', aliases: ['CN_A', 'CN'], label: 'A 股', short_label: 'A股' },
  { market_ref: 'US_EQUITY', aliases: ['US_EQUITY', 'US'], label: '美股', short_label: '美股' },
  { market_ref: 'CRYPTO', aliases: ['CRYPTO'], label: '加密', short_label: '加密' },
]);

const PRODUCT_STAGE_WORDS = Object.freeze({
  NOT_VERIFIED: '尚未验证', CONTROLLED_VERIFIED: '受控环境已验证', TARGET_DELIVERED: '目标环境已交付',
  OUT_OF_SCOPE: '本轮不做', REVOKED: '已撤销', INVALIDATED_BY_UPSTREAM: '因上游变化失效',
});

const CONCLUSION_WORDS = Object.freeze({
  PENDING: '尚无结论', PASS: '支持候选方案', FAIL: '不支持候选方案', INSUFFICIENT: '证据不足',
  INCONCLUSIVE: '无法判定', CHALLENGER_WINS: '候选方案更优', CHAMPION_WINS: '原版更优',
});

const ADOPTION_WORDS = Object.freeze({
  NOT_DECIDED: 'Desk 尚未决定', ADOPTED: 'Desk 已采用', NOT_ADOPTED: 'Desk 不采用', OBSERVING: '继续观察',
});

function marketPresentation(marketRef) {
  const found = MARKET_CATALOG.find((entry) => entry.aliases.includes(marketRef));
  return found || { market_ref: marketRef || null, aliases: [], label: '市场名称待登记', short_label: '未知市场' };
}

/**
 * 修订 4 的平台级 M4 范围（runtime-research-loop 的 platform_m4）翻成页面文字：M4 一行、M5 一行、未立项的方向、
 * A4.2 五条策略各自的状态。没有接入的条目只写「已列入 M4 范围，尚未接入」，不给阶段零值。
 */
function m4ScopeView(platform) {
  if (!platform) return null;
  return {
    title: `M4 范围：${platform.direction.label_zh}`,
    state: platform.state, state_label: words(platform.state, PRODUCT_STAGE_WORDS),
    m5_state: platform.m5.state, m5_state_label: words(platform.m5.state, PRODUCT_STAGE_WORDS),
    other_directions: platform.other_directions.map((item) => ({ label: item.label_zh, state: item.state, state_label: item.state_label_zh })),
    rule_label: '平台级 M4 需要首案 M3 已通过、至少一条范围内策略用真实证据完成自己的 M1–M3，且新策略与首案用的是同一套已验收的注册表与页面；五条全部通过才算支持全部五条。',
    first_case_label: `首案 M3：${words(platform.first_case.m3_state, PRODUCT_STAGE_WORDS)}`,
    items: platform.items.map((item) => ({
      id: item.id, batch: item.batch, label: item.label_zh, currency: item.currency, identity_note: item.identity_note_zh,
      state: item.state, state_label: item.state_label,
      stages: item.stages ? item.stages.map((stage) => ({ stage: stage.stage, state: stage.state, state_label: words(stage.state, PRODUCT_STAGE_WORDS) })) : null,
      m4_state_label: item.m4_state ? words(item.m4_state, PRODUCT_STAGE_WORDS) : null,
    })),
    supports_all_items: platform.supports_all_items,
  };
}

function strategyPresentation(strategyRef, strategyDirectory = new Map()) {
  const found = strategyDirectory.get(strategyRef);
  if (!found) return {
    label: 'Desk 策略（名称暂不可读取）', book_label: '', full_label: 'Desk 策略（名称暂不可读取）',
    role_label: '策略目录未提供此对象',
  };
  return {
    label: found.name, book_label: '', full_label: found.name,
    role_label: found.lifecycle.label,
  };
}

function words(value, dictionary, fallback = '状态待解释') {
  if (value === null || value === undefined || value === '') return '未知';
  return dictionary[value] || fallback;
}

function modeWords(mode) {
  return ({ OFF: '未运行', SHADOW: '影子观察', PAPER: '模拟运行', LIVE: '实盘运行' })[mode] || '运行模式未知';
}

function qualityWords(status) {
  return ({ VALID: '数据完整', DEGRADED: '数据不完整', INVALID: '数据无效', STALE: '数据过期', UNKNOWN: '数据质量未知', MISSING: '数据缺失' })[status] || '数据质量未知';
}

function caseStatusWords(status) {
  return ({
    M1_BLOCKED_NATIVE_BUNDLE_AND_COMPLETE_COSTS: '完整体检尚未就绪',
    M1_READY: '已具备完整体检条件',
  })[status] || '按技术状态查看';
}

function technicalRef(value, label) {
  return value ? { label, value } : null;
}

function humanCase(caseRec, productCase, strategyDirectory) {
  const market = marketPresentation(caseRec.market);
  const strategy = strategyPresentation(caseRec.strategy_ref, strategyDirectory);
  const baseline = caseRec.baseline ? strategyPresentation(caseRec.baseline.strategy_ref, strategyDirectory) : null;
  return {
    market: { label: market.label, short_label: market.short_label },
    strategy: {
      label: strategy.label, book_label: strategy.book_label, role_label: strategy.role_label,
      full_label: strategy.full_label,
    },
    runtime: {
      mode_label: modeWords(caseRec.runtime_lane.mode),
      real_order_label: caseRec.runtime_lane.real_order === 0 ? '不会真实下单' : '具有真实下单能力',
      as_of: caseRec.runtime_lane.as_of,
      state_label: caseStatusWords(caseRec.status),
      production_effect_label: caseRec.production_effect === 'NONE' ? '不影响生产' : '生产影响待核对',
    },
    data_quality: {
      state: caseRec.data_quality.status,
      label: qualityWords(caseRec.data_quality.status),
      as_of: caseRec.data_quality.as_of,
      known_at: caseRec.data_quality.known_at,
      freshness: { ...caseRec.data_quality.freshness },
    },
    baseline: caseRec.baseline ? {
      label: baseline.label, book_label: baseline.book_label, role_label: baseline.role_label,
      full_label: baseline.full_label,
      frozen_at: caseRec.baseline.frozen_at,
      expected_state: caseRec.baseline.expected_baseline?.state || 'UNKNOWN',
    } : null,
    product_stages: (productCase?.stages || []).map((stage) => ({
      stage: stage.stage, label: stage.label, state: stage.state,
      state_label: words(stage.state, PRODUCT_STAGE_WORDS),
      environment_label: stage.evidence?.delivery_environment === 'TARGET_DELIVERED'
        ? '目标交付环境' : stage.evidence?.delivery_environment === 'CONTROLLED_PENDING_RELEASE'
          ? '受控验收环境' : '尚无环境证据',
      user_result: stage.evidence?.user_result || null,
    })),
    links: (caseRec.links || []).map((link) => ({
      question_label: link.research_question_label || 'Desk 研究问题（名称待登记）',
      conclusion: link.conclusion,
      conclusion_label: words(link.conclusion, CONCLUSION_WORDS),
      adoption_state: link.adoption_state,
      adoption_label: words(link.adoption_state, ADOPTION_WORDS),
      has_frozen_experiment: Boolean(link.experiment_freeze_hash),
      has_locked_result: Boolean(link.result_hash),
      technical: [
        technicalRef(link.link_id, '闭环 link ID'),
        technicalRef(link.desk_candidate_ref, 'Desk candidate ID'),
        technicalRef(link.research_question_ref, '研究问题 ID'),
        technicalRef(link.experiment_ref, '实验 ID'),
        technicalRef(link.experiment_freeze_hash, '实验冻结 hash'),
        technicalRef(link.result_ref, '锁定结果引用'),
        technicalRef(link.result_hash, '锁定结果 hash'),
      ].filter(Boolean),
    })),
    source_files: (caseRec.data_quality.source_refs || []).map((sourceRef) => ({
      label: sourceLabel(sourceRef), file_name: path.basename(sourceRef), state_label: '已登记为首案实际输入',
      technical: technicalRef(sourceRef, '原始文件路径'),
    })),
    isolation: {
      can_order: caseRec.isolation.research_can_order,
      can_activate: caseRec.isolation.research_can_activate,
      can_write_runtime: caseRec.isolation.research_can_write_runtime,
      label: 'Research 只读：不能下单、不能激活、不能写运行态',
    },
    technical: [
      technicalRef(caseRec.case_id, '研究 case ID'),
      technicalRef(caseRec.strategy_ref, 'Desk 账本 ID'),
      technicalRef(caseRec.runtime_lane.version_ref, '运行版本引用'),
      technicalRef(caseRec.runtime_lane.source_ref, '当前运行输入'),
      technicalRef(caseRec.runtime_lane.source_hash, '当前运行输入 SHA-256'),
      technicalRef(caseRec.baseline_ref, '冻结基线 ID'),
      technicalRef(caseRec.baseline?.source_ref, '冻结基线来源'),
      technicalRef(caseRec.baseline?.source_hash, '冻结基线 SHA-256'),
      technicalRef(caseRec.acceptance_ref, '闭环验收合同'),
    ].filter(Boolean),
  };
}

function sourceLabel(sourceRef) {
  const file = path.basename(sourceRef || '');
  if (file.startsWith('POSITION_LEDGER_SNAPSHOT')) return '持仓快照';
  if (file.startsWith('STRATEGY_REVIEW')) return '策略复盘';
  if (file.startsWith('TRADE_LEDGER')) return '成交账本';
  return '实际输入文件';
}

function blockerList(primary, caseRec, profile = null) {
  if (!primary || !caseRec) return [];
  const freshness = primary.data_quality.freshness || {};
  const blockers = [];
  if (freshness.native_scan_bundle === 'MISSING') blockers.push({
    key: 'native_scan_bundle', label: `缺少${profile ? ` ${profile.display_name} ` : ''}原生扫描包`,
    impact: '无法证明回放走的是原策略完整扫描路径。', next: '由 Smartflow 交付同一历史时点的原生扫描 bundle。',
  });
  if (freshness.benchmark_bars === 'MISSING') blockers.push({
    key: 'benchmark_bars', label: '缺少适用基准行情',
    impact: '无法把策略结果与适当基准放在同一历史时点比较。', next: '补齐并冻结对应窗口的 benchmark bars。',
  });
  if (freshness.complete_signed_costs === 'MISSING_REGULATORY_FEES') blockers.push({
    key: 'complete_signed_costs', label: '净成本缺监管费用',
    impact: '当前成本口径不完整，不能形成可锁定的净收益结论。', next: '补齐监管费用模型并重新对账。',
  });
  const requirements = [
    { key: 'native_scan_bundle', label: '原生扫描包状态未确认', ready: ['AVAILABLE', 'PRESENT', 'VALID', 'COMPLETE'],
      impact: '当前状态不是已确认可用，不能证明原策略完整路径可回放。', next: '由原生产者明确交付并验证原生扫描 bundle。' },
    { key: 'benchmark_bars', label: '基准行情状态未确认', ready: ['AVAILABLE', 'PRESENT', 'VALID', 'COMPLETE'],
      impact: '当前状态不是已确认可用，不能形成同一历史时点的适当基准比较。', next: '由数据生产者明确交付并冻结 benchmark bars。' },
    { key: 'complete_signed_costs', label: '完整净成本状态未确认', ready: ['COMPLETE', 'COMPLETE_SIGNED_MODEL_COSTS'],
      impact: '当前状态不是已确认完整，不能形成可锁定的净收益结论。', next: '由费用权威确认完整费用范围并重新对账。' },
  ];
  for (const requirement of requirements) {
    const alreadyExplained = blockers.some((item) => item.key === requirement.key);
    if (!alreadyExplained && !requirement.ready.includes(freshness[requirement.key])) blockers.push({
      key: requirement.key, label: requirement.label, impact: requirement.impact,
      next: `${requirement.next} 当前技术状态：${freshness[requirement.key] || '未提供'}。`,
    });
  }
  if (caseRec.data_quality.status !== 'VALID' && blockers.length === 0) blockers.push({
    key: 'data_quality', label: '数据质量尚未明确有效',
    impact: `canonical 数据质量为 ${caseRec.data_quality.status || '未提供'}，不得推定体检就绪。`,
    next: '先由原数据生产者把数据质量收敛为 VALID。',
  });
  if (caseRec.status !== 'M1_READY' && blockers.length === 0) blockers.push({
    key: 'canonical_readiness', label: '运行／研究 case 尚未宣告 M1 就绪',
    impact: '展示层不能根据局部字段替代 canonical case 的就绪判断。',
    next: '由运行／研究协调层在完整证据齐备后将 case 明确更新为 M1_READY。',
  });
  return blockers;
}

function readinessOf(caseRec, blockers) {
  if (!caseRec) return 'NO_ACTUAL_CASE';
  return caseRec.status === 'M1_READY' && caseRec.data_quality.status === 'VALID' && blockers.length === 0
    ? 'READY' : 'BLOCKED';
}

function technicalSampleSummary({ adapters, families, modules, bundles, hypotheses, experimentRows, raceRows, shadowRuns, candidates, releases, activations, migrations, runtimes }) {
  return {
    title: '平台工程与历史样例',
    notice: '以下对象用于验证 QRP 工程链路，不是 Desk 当前首案，不影响当前策略与生产。',
    groups: [
      { label: '市场适配与策略登记', count: adapters.length + families.length + modules.length + bundles.length,
        technical_ids: [...adapters.map((x) => x.market_id), ...families.map((x) => x.family_id), ...modules.map((x) => x.module_id), ...bundles.map((x) => x.bundle_id)] },
      { label: '研究问题与实验', count: hypotheses.length + experimentRows.length,
        technical_ids: [...hypotheses.map((x) => x.hypothesis_id), ...experimentRows.map((x) => x.experiment_id)] },
      { label: '方案对比', count: raceRows.length, technical_ids: raceRows.map((x) => x.race_id) },
      { label: '前向观察', count: shadowRuns.length, technical_ids: shadowRuns.map((x) => x.shadow_id) },
      { label: '采用、发布与迁移记录', count: candidates.length + releases.length + activations.length + migrations.length,
        technical_ids: [...candidates.map((x) => x.candidate_id), ...releases.map((x) => x.release_id),
          ...activations.map((x) => x.activation_id), ...migrations.map((x) => x.migration_id || x.activation_ref)] },
      { label: 'Runtime 工程状态', count: runtimes.length, technical_ids: runtimes.map((x) => x.runtime_id) },
    ],
    raw_readonly_endpoints: ['strategies', 'experiments', 'races', 'shadow', 'promotion', 'runtime-status'].map((name) => `/api/${name}`),
  };
}

/**
 * 一道题现在处在哪一步，写成人话。状态从锁、登记项（K2 是否已冻结）和研究计划的先后关系推出
 * （candidate-comparison/registry.js 的 queueState），不写死「排队：Q1 之后」这类文案；计划里没有的题返回 null。
 */
function queueText(state) {
  if (!state) return null;
  return {
    RUNNING: '进行中：K2 已冻结，等研究会话交付封存的对比结果（见研究与对比）',
    QUEUED: `排队：${state.waiting_on.join('、')} 锁定之后开始`,
    READY_FOR_K2: '待立题：前置题已锁定，等 K2 冻结后开始',
  }[state.phase] || null;
}

/**
 * 待验证问题清单里对应某个实验题（Q1、Q2……）的那一条：有封存结果时写结论并链到「研究与对比」，
 * 没有就按队列状态写（已冻结 K2 = 进行中；否则排队或待立题，写明在等谁）。只改对应那几条的 status 与 link，其余原样；
 * 清单读不出来或这项策略没有候选对比时不动。
 */
function linkComparison(diagnosis, comparisons, strategyRef, program = candidateComparison.registry.forStrategy(strategyRef)) {
  if (!diagnosis || diagnosis.state !== 'AVAILABLE') return diagnosis;
  if (comparisons.length && comparisons.every((projection) => projection.state === 'NOT_CONNECTED')) return diagnosis;
  const link = { label: '查看研究与对比', section: 'research', strategy_ref: strategyRef };
  const byQuestion = new Map(comparisons.map((projection) => [projection.question_ref, projection]));
  const statusOf = (question) => {
    const state = program ? program.queueState(question, comparisons) : null;
    if (!state) return null;
    const projection = byQuestion.get(question);
    const STATUS = {
      LOCKED: () => `已完成：${projection.verdict_label}（见研究与对比）`,
      INVALID: () => '已有封存的对比结果，但校验未通过（见研究与对比）',
      MISSING: () => '已有封存的对比结果，但文件或旁证缺失（见研究与对比）',
    };
    return STATUS[state.phase] ? STATUS[state.phase]() : queueText(state);
  };
  return {
    ...diagnosis,
    items: diagnosis.items.map((item) => {
      const question = item.experiment && item.experiment.id;
      if (!question) return item;
      const status = statusOf(question);
      if (!status) return item;
      return { ...item, experiment: { ...item.experiment, status }, ...(byQuestion.has(question) ? { link } : {}) };
    }),
  };
}

/**
 * D4（UX 修订 4）：研究区的状态必须和已锁定的对比结果一致。
 * 「研究问题：Q1、Q2 已锁定；Q3 进行中；Q4 排队，等 Q3 锁定（来源：Q0 诊断，协调会话立题）；尚未回到 Desk」——
 * 已锁定的取自对比结果的锁；其余取自 Q0 诊断清单里已立题的实验，再按登记项（K2 已冻结＝进行中）与研究计划的先后关系（排队，等谁）推出。
 * 没有任何已锁定的对比结果时返回 null，页面保持原来的写法。
 */
function researchSummary(comparisons, diagnosis, returnedToDesk, program = null) {
  const locked = comparisons.filter((card) => card.state === 'LOCKED_VERIFIED').map((card) => card.question_ref);
  const broken = comparisons.filter((card) => card.state === 'INVALID' || card.state === 'MISSING').map((card) => card.question_ref);
  if (!locked.length && !broken.length) return null;
  const proposed = [...new Set((diagnosis && diagnosis.state === 'AVAILABLE' ? diagnosis.items : [])
    .map((item) => item.experiment && item.experiment.id).filter(Boolean))].sort();
  const have = new Set([...locked, ...broken]);
  const pending = proposed.filter((id) => !have.has(id)).map((id) => (program && program.queueState(id, comparisons)) || { question: id, phase: 'RUNNING', waiting_on: [] });
  const running = pending.filter((state) => state.phase === 'RUNNING').map((state) => state.question);
  // 已冻结 K2 的写「进行中」；还没冻结的按计划写排队（等谁）或待立题，不一律写「进行中」
  const unlocked = [];
  if (running.length) unlocked.push(`${running.join('、')} 进行中`);
  for (const state of pending.filter((item) => item.phase === 'QUEUED')) unlocked.push(`${state.question} 排队，等 ${state.waiting_on.join('、')} 锁定`);
  for (const state of pending.filter((item) => item.phase === 'READY_FOR_K2')) unlocked.push(`${state.question} 待立题，前置题已锁定，等 K2 冻结`);
  if (unlocked.length) unlocked[unlocked.length - 1] += '（来源：Q0 诊断，协调会话立题）';
  const parts = [];
  if (locked.length) parts.push(`${locked.join('、')} 已锁定`);
  if (broken.length) parts.push(`${broken.join('、')} 已有封存结果但校验未通过`);
  parts.push(...unlocked);
  parts.push(returnedToDesk ? `已有 ${returnedToDesk} 项回到 Desk` : '尚未回到 Desk');
  return `研究问题：${parts.join('；')}`;
}

/**
 * 修订 5 E7.1：研究区开头的「研究队列」小表，每题一行——题号、研究部分、中文题名、来源、状态。
 * 题目与先后取自策略档案的研究计划队列；研究部分、中文题名与来源取自说明登记（services/strategy-detail-notes）；
 * 状态写已锁定的结论，否则按队列状态写（K2 已冻结 = 进行中）。没有说明登记、或研究还没接上 case（对比全是 NOT_CONNECTED）时
 * 返回 null，页面不加这张表。
 */
function researchQueue(profile, notes, comparisons, program) {
  const queue = notes && notes.research_queue;
  if (!profile || !queue || comparisons.every((card) => card.state === 'NOT_CONNECTED')) return null;
  const byQuestion = new Map(comparisons.map((card) => [card.question_ref, card]));
  const PHASE = {
    RUNNING: () => '进行中',
    INVALID: () => '已有封存结果，但校验未通过',
    MISSING: () => '已有封存结果，但文件或旁证缺失',
    QUEUED: (state) => `排队：等 ${state.waiting_on.join('、')} 锁定`,
    READY_FOR_K2: () => '待立题：前置题已锁定，等 K2 冻结',
  };
  const rows = Object.keys(profile.research_program.queue).map((question) => {
    const item = queue.questions[question] || null;
    const card = byQuestion.get(question);
    const state = program ? program.queueState(question, comparisons) : null;
    const status = card && card.state === 'LOCKED_VERIFIED' ? `已锁定：${card.verdict_label}`
      : (state && PHASE[state.phase] ? PHASE[state.phase](state) : '状态未登记');
    return {
      question_ref: question, part_zh: item ? item.part_zh : '未登记', name_zh: item ? item.name_zh : profile.research_program.queue[question].title,
      source_zh: (item && typeof item.source_zh === 'string' && item.source_zh) || queue.source_zh, status_zh: status, // 一题可写自己的来源（Q5：Owner 10-26 同意）
      locked: Boolean(card && card.state === 'LOCKED_VERIFIED'),
    };
  });
  return { title_zh: '研究队列', rows };
}

/** HK 前向影子的行已经被某个锁定结果读入时，状态写「已在 Q1 结果中读入 N 行（只报不判）」，不写「尚未导入」。 */
function annotateHkItems(items, comparisons) {
  return items.map((item) => {
    if (!item.forward_stream) return item;
    const readers = comparisons.filter((card) => card.state === 'LOCKED_VERIFIED').map((card) => {
      const block = (card.blocks || []).find((entry) => entry.key === 'forward');
      const rows = block && block.state === 'AVAILABLE' ? block.data.rows.filter((row) => row.stream === item.forward_stream) : [];
      return rows.length ? { question: card.question_ref, rows: rows.length } : null;
    }).filter(Boolean);
    if (!readers.length) return item;
    return { ...item, state_label: readers.map((reader) => `已在 ${reader.question} 结果中读入 ${reader.rows} 行（只报不判）`).join('；'), read_into: readers };
  });
}
const notImported = (items) => items.filter((item) => item.import_state === 'RUNNING_ON_HK_NOT_IMPORTED' && !item.read_into).length;
const readIn = (items) => items.filter((item) => item.read_into).length;
const hkSentence = (items, suffix = '') => `HK 上已在跑 ${items.length} 条前向影子（${[
  readIn(items) ? `${readIn(items)} 条已在对比结果中读入，只报不判` : null, notImported(items) ? `${notImported(items)} 条尚未导入${suffix}` : null,
].filter(Boolean).join('；') || '状态见下'}）`;

async function readModel({
  caseRef = null, strategyRef = null, diagnostic: suppliedDiagnostic, baseline: suppliedBaseline, comparison: suppliedComparison,
} = {}) {
  const loop = runtimeResearchLoop.readModel();
  const casesById = new Map(loop.cases.map((item) => [item.case_id, item]));
  const requestedCase = caseRef ? casesById.get(caseRef) : null;
  const stableAsOf = requestedCase?.data_quality?.known_at
    || loop.cases.map((item) => item.data_quality?.known_at).filter(Boolean).sort().at(-1)
    || new Date().toISOString();
  const directory = deskStrategyDirectory.readModel({ cases: loop.cases, asOf: stableAsOf });
  const strategyByRef = new Map(directory.strategies.map((item) => [item.strategy_ref, item]));
  const selectedRaw = requestedCase
    || (strategyRef ? loop.cases.find((item) => item.strategy_ref === strategyRef) : null)
    || (loop.cases.length === 1 ? loop.cases[0] : null);
  const selectedStrategyRef = strategyRef || selectedRaw?.strategy_ref || directory.current[0]?.strategy_ref || null;
  const selectedStrategy = strategyByRef.get(selectedStrategyRef) || null;
  const selectedCurrentCase = selectedRaw?.strategy_ref === selectedStrategyRef ? selectedRaw : null;
  const baselineRelation = loop.cases.find((item) => item.baseline?.strategy_ref === selectedStrategyRef) || null;
  const productByCase = new Map(loop.product_delivery.cases.map((item) => [item.case_ref, item]));
  const primary = selectedCurrentCase
    ? humanCase(selectedCurrentCase, productByCase.get(selectedCurrentCase.case_id), strategyByRef) : null;
  // 所选策略的档案；没有登记的策略不读任何诊断、回测、对比或前向观察（R3）
  const profile = profiles.get(selectedStrategyRef);
  const program = profile ? candidateComparison.registry.forStrategy(profile.strategy_ref) : null;
  const profileCase = Boolean(profile) && selectedCurrentCase?.case_id === profile.case_ref;
  const canonicalDiagnosticCase = profileCase && selectedCurrentCase?.strategy_ref === profile.strategy_ref;
  const candidateDiagnostic = suppliedDiagnostic === undefined
    ? (canonicalDiagnosticCase ? strategyDiagnostics.readDiagnostic({ strategyRef: profile.strategy_ref }) : null)
    : suppliedDiagnostic;
  const diagnostic = selectedCurrentCase && candidateDiagnostic
    && candidateDiagnostic.case_ref === selectedCurrentCase.case_id
    && candidateDiagnostic.strategy_ref === selectedCurrentCase.strategy_ref ? candidateDiagnostic : null;
  const blockers = diagnostic?.state === 'VERIFIED' ? [] : blockerList(primary, selectedCurrentCase, profile);
  if (diagnostic && diagnostic.state !== 'VERIFIED') blockers.unshift({
    key: 'm1_diagnostic_package', label: 'M1 原版诊断输入不可用',
    impact: `canonical 诊断返回 ${diagnostic.state}：${diagnostic.reason_code || '原因未提供'}。`,
    next: diagnostic.missing_artifact
      ? `由 ${diagnostic.responsible_party || '原生产者'} 补齐 ${diagnostic.missing_artifact}，然后重新校验内容封印。`
      : '由原生产者修复明确的数据或内容漂移后重新校验；不得以零值替代。',
  });
  const readiness = diagnostic?.state === 'VERIFIED' ? 'DIAGNOSTIC_AVAILABLE' : readinessOf(selectedCurrentCase, blockers);

  // K3：回测结论只来自 QRP 导入并锁定的封存结果；没有 case、没有导入、文件校验失败都是「尚未回测」。
  // 非 LEGACY 档案（CRYPTO_Q0_RESULT_V1）的 Q0 锁按档案冻结的 case_ref 读：运行态 case 尚未建立时，回测结论照样显示（锁只按这个 case 键查）
  const profileBaselineCase = profileCase || (Boolean(profile) && !selectedCurrentCase && !profiles.isLegacyShape(profile));
  const baselineProjection = suppliedBaseline !== undefined ? suppliedBaseline
    : (profileBaselineCase ? baselineEvaluation.readProjection(profile.case_ref)
      : baselineEvaluation.emptyProjection('NOT_CONNECTED', !profile ? NOT_REGISTERED_LABEL
        : selectedCurrentCase ? '这项策略的基线回测尚未立题' : '这项策略尚未接入 Research，没有回测'));

  // 候选对比（Q1、Q2……）同样只来自导入并锁定的封存结果；每个已锁定的题目一张卡，没有交付、文件校验失败都是「尚未完成」。
  const comparisonProjections = (() => {
    if (suppliedComparison !== undefined) return Array.isArray(suppliedComparison) ? suppliedComparison : [suppliedComparison];
    return profileCase ? candidateComparison.readProjections(profile.case_ref)
      : [candidateComparison.emptyProjection('NOT_CONNECTED', profile ? '这项策略没有候选对比' : NOT_REGISTERED_LABEL)];
  })();

  const adapters = listAdapters();
  const families = registry.listFamilies();
  const modules = registry.listModules();
  const bundles = registry.listBundles();
  const hypotheses = experiments.listHypotheses();
  const experimentRows = experiments.listExperiments();
  const raceRows = races.listRaces();
  const shadowRuns = await Promise.all(shadow.listShadowRuns().map(async (item) => ({ ...item, sufficiency: await shadow.sufficiency(item.shadow_id) })));
  const candidates = controlPlane.listCandidates();
  const releases = controlPlane.listReleases();
  const activations = controlPlane.listActivations();
  const migrations = migration.listMigrationRecords();
  const runtimes = await Promise.all(adapters.map((adapter) => runtimeStatus.runtimeStatus(adapter.market_id)));

  const allHumanCases = loop.cases.map((item) => ({ raw: item, human: humanCase(item, productByCase.get(item.case_id), strategyByRef) }));
  const globalLinks = allHumanCases.flatMap(({ raw, human }) => human.links.map((link) => ({
    ...link, strategy_ref: raw.strategy_ref, strategy_name: strategyByRef.get(raw.strategy_ref)?.name || 'Desk 策略名称暂不可读取',
  })));
  const selectedLinks = primary?.links || [];
  const selectedLockedLinks = selectedLinks.filter((item) => item.has_locked_result);
  const researchText = researchSummary(comparisonProjections, baselineProjection.diagnosis, selectedLockedLinks.length, program);
  const notes = profile ? detailNotes.forStrategy(profile.strategy_ref) : null;
  const queueView = researchQueue(profile, notes, comparisonProjections, program);
  // 修订 6：采用决定（有效记录，按 result_id + part）；每张对比卡第一行写它，研究区开头给一览与采用率
  const decisions = profile ? adoption.effective(adoption.records().filter((row) => row.strategy_ref === profile.strategy_ref)) : new Map();
  const adoptionOverview = profile ? adoptionView.overviewOf({
    baselineProjection, comparisons: comparisonProjections, queue: notes && notes.research_queue, records: decisions,
  }) : null;
  // 页头标签、概览卡片和研究区开头读同一个对象：有已锁定的对比结果就写实际状态，不再写「暂无研究问题」
  if (researchText && selectedStrategy) selectedStrategy.research = { ...selectedStrategy.research, code: 'RESULT_LOCKED', label: researchText };
  // 非 LEGACY 档案已锁 Q0、运行态 case 还没建立：各处说法与上方的回测结论一致，不再写「尚未接入」「不显示研究结论」
  const baselineWithoutCase = !selectedCurrentCase && profileBaselineCase && baselineProjection.state === 'LOCKED_VERIFIED';
  if (baselineWithoutCase && !researchText && selectedStrategy) {
    selectedStrategy.research = { ...selectedStrategy.research, code: 'BASELINE_LOCKED', label: BASELINE_LOCKED_LABEL };
  }
  // 策略目录里的其他策略同一写法：非 LEGACY 档案已锁 Q0、还没有运行态 case 时，接入状态不再写「尚未接入 Research」
  // （CRYPTO_Q0_RESULT_V1 增补 1 §7 第 1 条「策略目录里 C17 的接入状态」）。只读锁定投影（带缓存），不重算
  for (const item of directory.strategies) {
    if (item === selectedStrategy || item.research.code !== 'NOT_CONNECTED') continue;
    const other = profiles.get(item.strategy_ref);
    if (!other || profiles.isLegacyShape(other) || loop.cases.some((row) => row.strategy_ref === item.strategy_ref)) continue;
    if (baselineEvaluation.readProjection(other.case_ref).state === 'LOCKED_VERIFIED') {
      item.research = { ...item.research, code: 'BASELINE_LOCKED', label: BASELINE_LOCKED_LABEL };
    }
  }
  const lockedLinks = globalLinks.filter((item) => item.has_locked_result);
  const linkedExperimentIds = new Set((selectedCurrentCase?.links || []).map((link) => link.experiment_ref).filter(Boolean));
  const selectedForward = shadowRuns.filter((item) => linkedExperimentIds.has(item.experiment_ref));
  const allExperimentIds = new Set(loop.cases.flatMap((item) => (item.links || []).map((link) => link.experiment_ref).filter(Boolean)));
  const globalForward = shadowRuns.filter((item) => allExperimentIds.has(item.experiment_ref));

  const hkGlobal = directory.strategies
    .flatMap((strategy) => hkForward.forStrategy(strategy.strategy_ref, { shadowRuns }).items.map((item) => ({ ...item, strategy_name: strategy.name })))
    .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
  const hkGlobalView = annotateHkItems(hkGlobal, comparisonProjections);

  const marketCoverage = MARKET_CATALOG.map((market) => {
    const marketStrategies = directory.strategies.filter((item) => market.aliases.includes(item.market_ref));
    return {
      label: market.label,
      state: directory.state === 'AVAILABLE' ? 'CONNECTED' : 'UNAVAILABLE',
      state_label: directory.state === 'AVAILABLE'
        ? `${marketStrategies.length} 个 Desk 系统策略` : directory.state_label,
      strategies: marketStrategies,
    };
  });

  const noCase = {
    state: 'NO_ACTUAL_CASE', title: '尚未接入 Research',
    summary: baselineWithoutCase
      ? '这项策略的 Q0 回测结论已锁定（见上方）；运行态研究 case 尚未建立，体检、研究问题与复盘要等它建立后才有。'
      : '这个 Desk 策略尚无运行／研究 case；平台不会用其他策略或工程样例替代。',
  };
  const m0ProductStage = primary?.product_stages.find((stage) => stage.stage === 'M0') || null;
  const m1ProductStage = primary?.product_stages.find((stage) => stage.stage === 'M1') || null;
  const healthSummary = readiness === 'DIAGNOSTIC_AVAILABLE'
    ? `${diagnostic.window.label} 的实际运行已完成原生回放、决策链核对和净账户对账。`
    : readiness !== 'READY'
      ? `最近实际运行的体检还不能完成：有 ${blockers.length} 项真实输入缺口。`
      : '已具备进入完整体检的输入条件。';
  const selectedHealth = primary ? {
    state: readiness,
    summary: healthSummary,
    answer: readiness === 'DIAGNOSTIC_AVAILABLE'
      ? `原版策略诊断已可用；${diagnostic.window.label} 的原生回放、决策链和净账户对账已验证。M1 产品状态仍为${m1ProductStage?.state_label || '尚未验证'}。`
      : readiness !== 'READY'
        ? `已接入 Research，但还不能完成 M1 体检：有 ${blockers.length} 项真实输入缺口。`
        : '已具备进入完整 M1 体检的输入条件。',
    blockers,
    diagnostic,
    product_stage: m1ProductStage,
    delivery_truth: diagnostic?.state === 'VERIFIED' ? {
      preparation: { state: 'EVIDENCE_AVAILABLE_NOT_PASS', label: 'M0 准备盘点', state_label: 'T01 与来源修订已有证据（不等于 PASS）' },
      owner_confirmation: { state: m0ProductStage?.state || 'NOT_VERIFIED', label: '负责人核对',
        state_label: m0ProductStage?.state === 'NOT_VERIFIED' ? '完成权威尚未登记' : m0ProductStage?.state_label },
      m1_capability: { state: 'AVAILABLE', label: 'M1 诊断能力', state_label: '本地受控环境可用' },
      m1_product: { state: m1ProductStage?.state || 'NOT_VERIFIED', label: 'M1 产品里程碑', state_label: m1ProductStage?.state_label || '尚未验证' },
      // 发布状态来自 M1 里程碑证据记录的交付环境，页面不另行断言。
      release: m1ProductStage?.state === 'TARGET_DELIVERED'
        ? { state: 'TARGET_DELIVERED', label: '发布状态', state_label: '目标环境已交付' }
        : m1ProductStage?.state === 'CONTROLLED_VERIFIED'
          ? { state: 'CONTROLLED_PENDING_RELEASE', label: '发布状态', state_label: '受控环境已验收，待按原授权发布' }
          : { state: 'NOT_RELEASED', label: '发布状态', state_label: '未发布到新的目标环境' },
    } : null,
    current: {
      title: primary.strategy.full_label, role: primary.strategy.role_label,
      mode_label: primary.runtime.mode_label, as_of: primary.runtime.as_of,
      data_quality_label: diagnostic?.state === 'VERIFIED' ? 'M1 诊断输入已完成内容校验' : primary.data_quality.label,
    },
    baseline: primary.baseline,
    next_step: diagnostic?.state === 'VERIFIED'
      ? '按页面顺序复核 MSFU 决策、账户与限制；产品 PASS 仍需 M0 有效证据和原完成权威登记。'
      : blockers[0]?.next || '执行原生完整回放、账户对账与决策漏斗核对。',
  } : baselineRelation ? {
    state: 'FROZEN_BASELINE',
    answer: '这本策略作为当前首案的旧实验冻结基线保留，不接收新的研究结论。',
    blockers: [], diagnostic: null, product_stage: null, delivery_truth: null, current: null, baseline: null,
    next_step: '返回其后继策略查看当前体检；历史基线保持冻结。',
  } : {
    state: noCase.state, answer: noCase.summary, blockers: [], diagnostic: null, product_stage: null, delivery_truth: null, current: null, baseline: null,
    next_step: '只有 Desk 复盘形成真实问题并按原队列接入后，才建立 Research case。',
  };

  const forwardItems = selectedForward.map((item) => ({
    state_label: item.status === 'RUNNING' ? '观察中' : '观察已停止',
    sample_label: `${item.sufficiency.forward_sample_count} / ${item.sufficiency.min_required} 个前向样本`,
    claim_label: item.sufficiency.claim_status === 'CLAIM_ELIGIBLE' ? '样本达到主张门槛' : '样本尚不足',
    technical: [technicalRef(item.shadow_id, '前向观察 ID'), technicalRef(item.virtual_ledger_ref, '虚拟账本 ID')].filter(Boolean),
  }));

  const platformM4 = loop.product_delivery.platform_m4 || null;
  const m4Item = platformM4 && selectedStrategyRef ? platformM4.items.find((item) => item.strategy_ref === selectedStrategyRef) || null : null;
  const hkForwardForSelected = selectedStrategyRef
    ? hkForward.forStrategy(selectedStrategyRef, { shadowRuns }) : { state: 'AVAILABLE', items: [], verified_at: null };
  const hkItems = annotateHkItems(hkForwardForSelected.items, comparisonProjections);
  // CRYPTO_Q0_RESULT_V1 §7.2：Q0 结果文件自带的前向记录（有效时）写进「前向观察」一句，不与 Q0 卡里的笔数矛盾
  const q0Forward = (() => {
    const account = baselineProjection.state === 'LOCKED_VERIFIED' ? (baselineProjection.blocks || []).find((block) => block.key === 'account') : null;
    const row = account && account.state === 'AVAILABLE' ? account.data.forward : null;
    return row && row.valid ? row : null;
  })();
  const strategyDetail = {
    question: '这项 Desk 策略现在如何运行、证据是否完整、Research 与复盘走到哪里？',
    state: selectedStrategy ? selectedStrategy.lifecycle.code : 'UNKNOWN_STRATEGY',
    strategy: selectedStrategy,
    case_role: primary ? 'CURRENT_CASE' : (baselineRelation ? 'FROZEN_BASELINE' : 'NOT_CONNECTED'),
    runtime: {
      answer: selectedStrategy
        ? `${selectedStrategy.market_label} · ${selectedStrategy.mode_label} · ${selectedStrategy.lifecycle.label}。`
        : '所选策略不在当前 Desk 权威目录中。',
      actual: primary?.runtime || null,
    },
    health: selectedHealth,
    conclusion: {
      question: '这条策略的回测结论是什么，凭什么？',
      ...baselineProjection.conclusion,
      result_state: baselineProjection.state, result_reason: baselineProjection.reason || null,
    },
    backtest: {
      state: baselineProjection.state, reason: baselineProjection.reason || null,
      blocks: baselineProjection.blocks, source: baselineProjection.source,
    },
    diagnosis_list: linkComparison(baselineProjection.diagnosis, comparisonProjections, selectedStrategyRef, program),
    comparisons: comparisonProjections.map((projection) => ({
      question: '原版和候选放在同一账户里比，候选有没有更好？',
      ...projection,
      ...(projection.state === 'LOCKED_VERIFIED' && profile ? { adoption: adoptionView.adoptionOf(decisions.get(adoption.keyOf(projection.result_id))) } : {}),
    })),
    recent_run: {
      title: '最近实际运行（纸面交易，真实行情）',
      account_label: '账户：纸面交易（真实行情），即本策略的真实账户',
      summary: selectedHealth ? selectedHealth.summary : null,
    },
    research: {
      state: selectedLinks.length ? 'HAS_RESEARCH_QUESTION' : (researchText ? 'HAS_LOCKED_RESULT' : (primary ? 'EMPTY' : noCase.state)),
      answer: researchText
        ? `${researchText}${selectedLinks.length ? `；另已关联 ${selectedLinks.length} 个 Desk 研究问题` : ''}。`
        : selectedLinks.length
          ? `已关联 ${selectedLinks.length} 个 Desk 研究问题。`
          : primary ? '已接入 Research，但 Desk 尚未登记真实研究问题。' : noCase.summary,
      has_sealed_result: Boolean(baselineProjection.state === 'LOCKED_VERIFIED' || comparisonProjections.some((card) => card.state === 'LOCKED_VERIFIED')),
      has_comparison: comparisonProjections.some((card) => card.state !== 'NOT_IMPORTED' && card.state !== 'NOT_CONNECTED'),
      source_label: '数据来自 QRP 导入并锁定的封存结果，页面不重算',
      items: selectedLinks,
      next_step: primary ? '在原 Desk 复盘队列形成明确问题后，冻结原版、样本、时点与成本口径。' : '先按原队列接入真实问题。',
    },
    forward: {
      state: forwardItems.length ? 'HAS_FORWARD_RUN' : 'EMPTY', items: forwardItems, // state 只表示 QRP 已导入的前向观察
      hk_state: hkItems.length ? 'HAS_HK_RUNNING' : (hkForwardForSelected.state === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'EMPTY'), hk_items: hkItems, hk_verified_at: hkForwardForSelected.verified_at,
      answer: forwardItems.length || hkItems.length
        ? [forwardItems.length ? `QRP 已导入 ${forwardItems.length} 条关联的前向观察` : null,
          hkItems.length ? hkSentence(hkItems) : null]
          .filter(Boolean).join('；') + '。'
        : (q0Forward ? `Q0 结果文件里带有前向记录${q0Forward.raw.trades !== undefined ? ` ${q0Forward.raw.trades} 笔` : ''}（只报不判）；HK 前向影子：本策略尚未登记。` : '尚无属于这项策略的前向观察。'),
    },
    review: {
      state: selectedLockedLinks.some((item) => item.adoption_state !== 'NOT_DECIDED') ? 'DECIDED'
        : (selectedLockedLinks.length ? 'AWAITING_DESK_DECISION' : 'EMPTY'),
      items: selectedLockedLinks,
      answer: selectedLockedLinks.length
        ? '锁定结论仍须回到 Desk，由用户记录是否采用。'
        : selectedLinks.length ? '研究问题尚未形成锁定结果，不能提前进入 Desk 采用处理。'
          : '尚未形成可回到 Desk 的锁定研究结论。',
      production_effect_label: primary?.runtime.production_effect_label || '未产生生产影响',
    },
    technical: [
      selectedStrategy ? technicalRef(selectedStrategy.strategy_ref, 'Desk 策略 ID') : null,
      selectedCurrentCase ? technicalRef(selectedCurrentCase.case_id, '研究 case ID') : null,
      baselineRelation ? technicalRef(baselineRelation.case_id, '关联首案 ID') : null,
    ].filter(Boolean),
    // 只加在需要的策略上（LEGACY_V1 档案的投影形状不变，US_V5 的 JSON 逐字节冻结，D1）：
    // 没有档案的策略标「该策略尚未接入研究」；页面金额默认按美元写，其他档案带上自己的币种。
    ...(!profile ? { profile_state: 'NOT_REGISTERED', profile_label: NOT_REGISTERED_LABEL } : {}),
    ...(profile && !profiles.isLegacyShape(profile) ? { currency: profile.currency } : {}),
    // 增补 1 §1.4：本档案页面上 R 值的小数位（只加在写了 r_digits 的档案上）
    ...(profile && !profiles.isLegacyShape(profile) && profile.q0_reading.r_digits ? { r_digits: profile.q0_reading.r_digits } : {}),
    ...(baselineWithoutCase ? { no_case_note_zh: '回测结论见上方：QRP 导入并锁定的 Q0 结果。运行态研究 case 尚未建立，所以还没有体检、研究问题与复盘。' } : {}),
    // 修订 5：研究队列小表（E7.1）与内部代号的中文题名（E7.2，页面换掉主内容里的代号）——只加在有说明登记的策略上
    ...(queueView ? { research_queue: queueView } : {}),
    ...(adoptionOverview ? { adoption_overview: adoptionOverview } : {}),
    // 修订 7 J1：默认页签「总览」——一句话结论（服务端模板）、关键数字卡、精简一览、现行规则与待办；只加在有档案的策略上
    ...(profile ? { summary: detailSummary.overviewOf({
      strategy: selectedStrategy, caseRec: selectedCurrentCase,
      conclusion: { ...baselineProjection.conclusion, result_state: baselineProjection.state, result_reason: baselineProjection.reason || null },
      backtest: baselineProjection, comparisons: comparisonProjections, overview: adoptionOverview,
      notesQueue: notes && notes.research_queue, queueView, isMain: baselineEvaluation.mainRowTest(profile),
      engineClause: !profiles.isLegacyShape(profile),
    }) } : {}),
    ...(notes && notes.code_names && Object.keys(notes.code_names).length ? { code_names: notes.code_names } : {}),
    // 修订 4 A4.4：列入 M4 范围、还没有接入的策略写「已列入 M4 范围，尚未接入」（只加在这些策略上）
    ...(m4Item && m4Item.state === 'IN_SCOPE_NOT_ONBOARDED' ? { m4_scope_label: m4Item.state_label, m4_scope_batch: m4Item.batch } : {}),
  };

  return {
    schema: 'RESEARCH_HUMAN_WORKSPACE_V2', acceptance_ref: ACCEPTANCE_REF,
    read_only: true,
    safety_label: '只读研究台 · 不下单、不激活、不写运行态',
    navigation: NAVIGATION,
    compatibility_routes: COMPATIBILITY_ROUTES,
    strategy_directory: directory,
    context: {
      title: selectedStrategy ? `${selectedStrategy.market_label} / ${selectedStrategy.name}` : 'Desk 策略目录',
      subtitle: selectedStrategy
        ? `${selectedStrategy.lifecycle.label} · ${selectedStrategy.mode_label} · ${selectedStrategy.research.label}`
        : directory.state_label,
      options: directory.strategies.map((item) => ({
        strategy_ref: item.strategy_ref, market_label: item.market_label, strategy_label: item.name,
        selected: item.strategy_ref === selectedStrategyRef,
      })),
      selected_strategy_ref: selectedStrategyRef,
      canonical_current_strategy_ref: loop.cases.length === 1 ? loop.cases[0].strategy_ref : null,
      selected_case_ref: selectedCurrentCase?.case_id || null,
      selected: primary,
      technical: selectedCurrentCase ? technicalRef(selectedCurrentCase.case_id, '当前研究 case ID') : null,
    },
    market_coverage: marketCoverage,
    views: {
      strategies: {
        question: NAVIGATION.find((item) => item.route === 'strategies').question,
        state: directory.state,
        answer: directory.state === 'AVAILABLE'
          ? `Desk 共登记 ${directory.strategies.length} 个系统策略：${directory.counts.current} 个运行或观察中，${directory.counts.history} 个历史或收尾；其中 ${directory.counts.research_connected} 个已与 Research 建立关联。`
          : 'Desk 权威策略目录暂时不可读取，页面不会用 QRP 工程对象代替。',
        next_step: directory.state === 'AVAILABLE' ? '选择一项策略，查看运行、体检、研究、前向观察和复盘的完整详情。' : '恢复 Desk 本地只读源后重试。',
      },
      'strategy-detail': strategyDetail,
      'runtime-research-loop': selectedHealth,
      experiments: {
        question: NAVIGATION.find((item) => item.route === 'experiments').question,
        state: globalLinks.length ? 'HAS_RESEARCH_QUESTION' : (loop.cases.length ? 'EMPTY' : noCase.state),
        answer: globalLinks.length
          ? `全部 Desk 策略当前共有 ${globalLinks.length} 个真实研究问题。`
          : '当前没有从 Desk 复盘登记进来的真实研究问题或锁定对比结果。',
        items: globalLinks,
        next_step: '先在原 Desk 复盘队列形成明确问题；只有 M1 输入就绪后才运行评价与压力检验。',
      },
      races: {
        state: globalLinks.some((item) => item.has_locked_result) ? 'HAS_LOCKED_RESULT' : 'EMPTY',
        items: globalLinks.filter((item) => item.has_frozen_experiment || item.has_locked_result),
      },
      shadow: {
        question: NAVIGATION.find((item) => item.route === 'shadow').question,
        hk_items: hkGlobalView,
        state: globalForward.length ? 'HAS_FORWARD_RUN' : 'EMPTY', // 只表示 QRP 已导入的前向观察；HK 上在跑的见 hk_items
        hk_state: hkGlobal.length ? 'HAS_HK_RUNNING' : 'EMPTY',
        answer: [
          globalForward.length ? `QRP 已导入 ${globalForward.length} 条与 Desk 锁定结果关联的前向观察` : null,
          hkGlobalView.length ? hkSentence(hkGlobalView, ' QRP') : null,
        ].filter(Boolean).join('；').concat(globalForward.length || hkGlobal.length ? '。' : '当前没有与 Desk 锁定结果关联的前向观察。'),
        items: globalForward.map((item) => ({
          state_label: item.status === 'RUNNING' ? '观察中' : '观察已停止',
          sample_label: `${item.sufficiency.forward_sample_count} / ${item.sufficiency.min_required} 个前向样本`,
          claim_label: item.sufficiency.claim_status === 'CLAIM_ELIGIBLE' ? '样本达到主张门槛' : '样本尚不足',
          technical: [technicalRef(item.shadow_id, '前向观察 ID'), technicalRef(item.virtual_ledger_ref, '虚拟账本 ID')].filter(Boolean),
        })),
        next_step: '只有锁定结果进入既有前向流程后，才开始累计独立样本。',
      },
      promotion: {
        question: NAVIGATION.find((item) => item.route === 'promotion').question,
        state: lockedLinks.some((item) => item.adoption_state !== 'NOT_DECIDED') ? 'DECIDED'
          : (lockedLinks.length ? 'AWAITING_DESK_DECISION' : 'EMPTY'),
        answer: lockedLinks.length
          ? '研究结论仍须回到 Desk 原复盘与采用流程；Research 不替用户作决定。'
          : globalLinks.length ? '研究问题尚未形成锁定结果，当前没有可回到 Desk 处理的项目。'
            : '当前还没有完成 Desk → Research → Desk 的真实往返。',
        items: lockedLinks,
        production_effect_label: loop.cases.some((item) => item.production_effect !== 'NONE') ? '存在需核对的生产影响' : '当前无生产影响',
        next_step: '形成有效锁定结论后，复用原 RSI/Desk 后续处理记录用户决定；未采用也是有效结论。',
      },
      'runtime-status': {
        question: NAVIGATION.find((item) => item.route === 'runtime-status').question,
        state: primary ? primary.data_quality.state : noCase.state,
        answer: primary
          ? diagnostic?.state === 'VERIFIED'
            ? `M1 诊断输入已完成内容校验：${diagnostic.source_status.package.files} 个文件、${diagnostic.source_status.scans.records} 条原生扫描记录，当前没有诊断输入缺口。`
            : `${primary.data_quality.label}：已登记 ${primary.source_files.length} 类实际输入，仍有 ${blockers.length} 项缺口。`
          : '请选择已接入 Research 的策略查看实际输入；Desk 策略目录本身不等于 QRP 运行输入。',
        sources: diagnostic?.state === 'VERIFIED' ? [
          {
            label: 'Desk 历史运行记录', file_name: `${diagnostic.source_status.package.groups.desk.files} 个账户、交易与决策文件`,
            state_label: '内容校验通过', technical: technicalRef(diagnostic.technical.package_sha256, '完整输入包 SHA-256'),
          },
          {
            label: `${profile.display_name} 原生扫描记录`, file_name: `${diagnostic.source_status.scans.files} 个 session 文件 · ${diagnostic.source_status.scans.records} 条记录`,
            state_label: '逐条记录 hash 通过', technical: technicalRef(diagnostic.native_replay.frozen_digest, '冻结策略 digest'),
          },
          {
            label: '原生回放与报告基准', file_name: `回放 ${diagnostic.native_replay.parity} · SPY 仅作报告比较`,
            state_label: '来源角色已隔离', technical: technicalRef(diagnostic.native_replay.document_hash, '原生回放文档 hash'),
          },
        ] : primary?.source_files || [], blockers,
        diagnostic_sources: diagnostic?.source_status || null,
        isolation: primary?.isolation || {
          can_order: false, can_activate: false, can_write_runtime: false,
          label: 'Research 只读：不能下单、不能激活、不能写运行态',
        },
        runtime_binding_label: primary
          ? diagnostic?.state === 'VERIFIED'
            ? '运行事实来自 Smartflow／Desk 只读包；Research 已验证包内容和账户等式，但不接管 Runtime。'
            : '当前首案尚未接入 QRP Runtime 状态接口；运行事实来自已登记的 Desk/Smartflow 文件。'
          : '所选策略尚无 QRP Runtime 绑定。',
        milestones: primary?.product_stages || [],
        m4_scope: m4ScopeView(loop.product_delivery.platform_m4),
        next_step: blockers[0]?.next || (primary ? '复核实际输入与原生回放的一致性。' : '选择已接入 Research 的策略。'),
      },
    },
    engineering_samples: technicalSampleSummary({
      adapters, families, modules, bundles, hypotheses, experimentRows, raceRows, shadowRuns,
      candidates, releases, activations, migrations, runtimes,
    }),
    authority: {
      runtime: '运行事实来自市场仓与 Desk 已登记输入。',
      research: '研究结论只来自 QRP 锁定结果。',
      review_and_adoption: '最终复盘与采用决定仍由 Desk 原流程记录。',
      cycle: 'Cycle 只作为研究证据引用，不产生交易权限。',
    },
    technical: {
      workspace_acceptance_ref: ACCEPTANCE_REF,
      desk_directory_provenance: directory.provenance,
      desk_directory_error: directory.error || null,
      upstream_spec_ref: loop.product_delivery.spec_ref,
      upstream_spec_sha256: loop.product_delivery.spec_sha256,
      product_acceptance_ref: loop.product_delivery.acceptance_ref,
      product_acceptance_amendment_refs: loop.product_delivery.acceptance_amendment_refs,
      completion_authority: loop.product_delivery.completion_authority,
    },
  };
}

module.exports = {
  ACCEPTANCE_REF, NAVIGATION, COMPATIBILITY_ROUTES, MARKET_CATALOG,
  marketPresentation, strategyPresentation, readModel,
};
