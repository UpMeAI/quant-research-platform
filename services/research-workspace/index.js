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
const { listAdapters } = require('../../adapters/registry');

const ACCEPTANCE_REF = 'docs/contracts/CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_2.md';

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

function blockerList(primary, caseRec) {
  if (!primary || !caseRec) return [];
  const freshness = primary.data_quality.freshness || {};
  const blockers = [];
  if (freshness.native_scan_bundle === 'MISSING') blockers.push({
    key: 'native_scan_bundle', label: '缺少 US_V5 原生扫描包',
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
 * 待验证问题清单里对应某个已登记对比题（Q1、Q2……）的那一条：有对比结果时写结论并链到「研究与对比」，
 * 没有就按登记项的等待文案写（登记项没写就不动）。只改对应那几条的 status 与 link，其余原样；清单读不出来时不动。
 */
function linkComparison(diagnosis, comparisons, strategyRef) {
  if (!diagnosis || diagnosis.state !== 'AVAILABLE') return diagnosis;
  const link = { label: '查看研究与对比', section: 'research', strategy_ref: strategyRef };
  const byQuestion = new Map(comparisons.map((projection) => [projection.question_ref, projection]));
  const statusOf = (question) => {
    const projection = byQuestion.get(question);
    const state = projection ? projection.state : 'NOT_IMPORTED';
    const STATUS = {
      LOCKED_VERIFIED: () => `已完成：${projection.verdict_label}（见研究与对比）`,
      INVALID: () => '已有封存的对比结果，但校验未通过（见研究与对比）',
      MISSING: () => '已有封存的对比结果，但文件或旁证缺失（见研究与对比）',
      NOT_IMPORTED: () => candidateComparison.registry.get(question).pending_status_zh,
    };
    return STATUS[state] ? STATUS[state]() : null;
  };
  return {
    ...diagnosis,
    items: diagnosis.items.map((item) => {
      const question = item.experiment && item.experiment.id;
      if (!question || !candidateComparison.registry.get(question)) return item;
      const status = statusOf(question);
      return status ? { ...item, experiment: { ...item.experiment, status }, link } : item;
    }),
  };
}

/**
 * D4（UX 修订 4）：研究区的状态必须和已锁定的对比结果一致。
 * 「研究问题：Q1、Q2 已锁定；Q3、Q4 进行中（来源：Q0 诊断，协调会话立题）；尚未回到 Desk」——
 * 已锁定的取自对比结果的锁；其余取自 Q0 诊断清单里已立题的实验（QRP 只知道「已立题、未锁定」，写作「进行中」）。
 * 没有任何已锁定的对比结果时返回 null，页面保持原来的写法。
 */
function researchSummary(comparisons, diagnosis, returnedToDesk) {
  const locked = comparisons.filter((card) => card.state === 'LOCKED_VERIFIED').map((card) => card.question_ref);
  const broken = comparisons.filter((card) => card.state === 'INVALID' || card.state === 'MISSING').map((card) => card.question_ref);
  if (!locked.length && !broken.length) return null;
  const proposed = [...new Set((diagnosis && diagnosis.state === 'AVAILABLE' ? diagnosis.items : [])
    .map((item) => item.experiment && item.experiment.id).filter(Boolean))].sort();
  const have = new Set([...locked, ...broken]);
  const running = proposed.filter((id) => !have.has(id));
  const parts = [];
  if (locked.length) parts.push(`${locked.join('、')} 已锁定`);
  if (broken.length) parts.push(`${broken.join('、')} 已有封存结果但校验未通过`);
  if (running.length) parts.push(`${running.join('、')} 进行中（来源：Q0 诊断，协调会话立题）`);
  parts.push(returnedToDesk ? `已有 ${returnedToDesk} 项回到 Desk` : '尚未回到 Desk');
  return `研究问题：${parts.join('；')}`;
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
  const canonicalDiagnosticCase = selectedCurrentCase?.case_id === 'RRC-US-V5-3000-V8-1-M0'
    && selectedCurrentCase?.strategy_ref === 'US_V5_ETF_3000USD';
  const candidateDiagnostic = suppliedDiagnostic === undefined
    ? (canonicalDiagnosticCase ? strategyDiagnostics.readDiagnostic() : null)
    : suppliedDiagnostic;
  const diagnostic = selectedCurrentCase && candidateDiagnostic
    && candidateDiagnostic.case_ref === selectedCurrentCase.case_id
    && candidateDiagnostic.strategy_ref === selectedCurrentCase.strategy_ref ? candidateDiagnostic : null;
  const blockers = diagnostic?.state === 'VERIFIED' ? [] : blockerList(primary, selectedCurrentCase);
  if (diagnostic && diagnostic.state !== 'VERIFIED') blockers.unshift({
    key: 'm1_diagnostic_package', label: 'M1 原版诊断输入不可用',
    impact: `canonical 诊断返回 ${diagnostic.state}：${diagnostic.reason_code || '原因未提供'}。`,
    next: diagnostic.missing_artifact
      ? `由 ${diagnostic.responsible_party || '原生产者'} 补齐 ${diagnostic.missing_artifact}，然后重新校验内容封印。`
      : '由原生产者修复明确的数据或内容漂移后重新校验；不得以零值替代。',
  });
  const readiness = diagnostic?.state === 'VERIFIED' ? 'DIAGNOSTIC_AVAILABLE' : readinessOf(selectedCurrentCase, blockers);

  // K3：回测结论只来自 QRP 导入并锁定的封存结果；没有 case、没有导入、文件校验失败都是「尚未回测」。
  const baselineProjection = suppliedBaseline !== undefined ? suppliedBaseline
    : (selectedCurrentCase?.case_id === baselineEvaluation.CASE_REF ? baselineEvaluation.readProjection()
      : baselineEvaluation.emptyProjection('NOT_CONNECTED', selectedCurrentCase
        ? '这项策略的基线回测尚未立题' : '这项策略尚未接入 Research，没有回测'));

  // 候选对比（Q1、Q2……）同样只来自导入并锁定的封存结果；每个已锁定的题目一张卡，没有交付、文件校验失败都是「尚未完成」。
  const comparisonProjections = (() => {
    if (suppliedComparison !== undefined) return Array.isArray(suppliedComparison) ? suppliedComparison : [suppliedComparison];
    return selectedCurrentCase?.case_id === candidateComparison.CASE_REF ? candidateComparison.readProjections()
      : [candidateComparison.emptyProjection('NOT_CONNECTED', '这项策略没有候选对比')];
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
  const researchText = researchSummary(comparisonProjections, baselineProjection.diagnosis, selectedLockedLinks.length);
  // 页头标签、概览卡片和研究区开头读同一个对象：有已锁定的对比结果就写实际状态，不再写「暂无研究问题」
  if (researchText && selectedStrategy) selectedStrategy.research = { ...selectedStrategy.research, code: 'RESULT_LOCKED', label: researchText };
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
    summary: '这个 Desk 策略尚无运行／研究 case；平台不会用其他策略或工程样例替代。',
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

  const hkForwardForSelected = selectedStrategyRef
    ? hkForward.forStrategy(selectedStrategyRef, { shadowRuns }) : { state: 'AVAILABLE', items: [], verified_at: null };
  const hkItems = annotateHkItems(hkForwardForSelected.items, comparisonProjections);
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
    diagnosis_list: linkComparison(baselineProjection.diagnosis, comparisonProjections, selectedStrategyRef),
    comparisons: comparisonProjections.map((projection) => ({
      question: '原版和候选放在同一账户里比，候选有没有更好？',
      ...projection,
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
        : '尚无属于这项策略的前向观察。',
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
            label: 'US_V5 原生扫描记录', file_name: `${diagnostic.source_status.scans.files} 个 session 文件 · ${diagnostic.source_status.scans.records} 条记录`,
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
