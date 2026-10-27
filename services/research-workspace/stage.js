'use strict';

/**
 * 策略总览的「研究进度」：每条 Desk 策略一份，回答「这条策略的研究走到了哪一步」——
 * M1 体检包、A0 引擎对齐、Q0 回测结论、方案对比几题、采用决定、还有哪些题待研究。
 *
 * 事实只取自 QRP 的权威登记与账本，这里只计数、套固定句式，不重算、不判定：
 * - 策略档案注册表（config/strategy_profiles.v1.json）：是否接入、M1 体检包（证据清单 sha256 现场核对）、研究计划的题目队列；
 * - M4 范围（config/m4_scope.v1.json，经 runtime-research-loop 的 platform_m4）：已列入、尚未接入的策略；
 * - var/ledger/research/：baseline_evaluations（Q0 锁与替代链；结论与 A0 取自锁定文件的投影）、comparison_evaluations（对比锁）、
 *   adoption_decisions（每个结果的有效记录）、hypotheses 与 experiments（只经 Desk case 的研究问题回链归属到策略；
 *   没有回链的平台工程样例不算任何一条策略的题）；
 * - runtime-research-loop 的 case：运行态 case 与冻结基线关系。
 * 结果与页面上选的是哪条策略无关；总览卡片、页头计数和详情页头的接入标签读同一份对象。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const profiles = require('../strategy-profiles');
const producers = require('../strategy-diagnostics/producers');
const baselineEvaluation = require('../baseline-evaluation');
const candidateComparison = require('../candidate-comparison');
const adoption = require('../research-adoption');
const adoptionView = require('../research-adoption/overview');
const detailNotes = require('../strategy-detail-notes');
const experiments = require('../experiment-orchestrator');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const M1_WORDS = Object.freeze({
  REGISTERED: 'M1 体检包已登记',
  NO_PRODUCER: 'M1 体检包已登记，QRP 尚无它的诊断生产者',
  MANIFEST_DRIFT: 'M1 体检清单与登记不一致',
  MANIFEST_MISSING: 'M1 体检清单缺失',
});
const Q0_WORDS = Object.freeze({
  NOT_IMPORTED: 'Q0 尚未锁定',
  INVALID: 'Q0 已有封存结果，但校验未通过',
  MISSING: 'Q0 已有封存结果，但文件或旁证缺失',
});
const PHASE_WORDS = Object.freeze({
  RUNNING: () => '进行中，K2 已冻结',
  QUEUED: (item) => `排队，等 ${item.waiting_on.join('、')} 锁定`,
  READY_FOR_K2: () => '待立题，等 K2 冻结',
  DESK_LINK: () => 'Desk 研究问题，尚无锁定结果',
});
const BROKEN = new Set(['INVALID', 'MISSING']);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const refs = (items) => items.map((item) => item.question_ref).join('、');

function a0Text(a0) {
  if (!a0) return 'A0 未记录';
  if (a0.state === 'PASSED') return `A0 通过${a0.basis_zh ? `（按 ${a0.basis_zh}）` : ''}`;
  return a0.state === 'NOT_PASSED' || a0.state === 'FAILED' ? 'A0 未通过' : 'A0 状态待解释';
}

function q0Text(q0) {
  if (q0.state !== 'LOCKED_VERIFIED') return Q0_WORDS[q0.state] || 'Q0 状态待解释';
  const replaced = q0.superseded_result_ids.length;
  return `Q0 ${q0.verdict_label}${replaced ? `（替代过 ${replaced} 份旧锁）` : ''}`;
}

/** 已锁定对比的结论分布，按出现顺序：「证据不足 5」「有支持证据 1、证据不足 4」。 */
function verdictTally(locked) {
  const counts = new Map();
  for (const card of locked) counts.set(card.verdict_label, (counts.get(card.verdict_label) || 0) + 1);
  return [...counts].map(([label, n]) => `${label} ${n}`).join('、');
}

/**
 * 一条策略的研究进度，从已读出的事实推出（纯函数，测试直接喂事实）。
 * facts：{ profile, m4, current_case, baseline_of_case, m1, q0, comparisons, rounds, open }；没有档案时 m1、q0 为 null、comparisons 为空。
 *   comparisons[]：{ question_ref, state, verdict_label, result_id, adoption }，adoption 是 research-adoption/overview 的 adoptionOf 结果；
 *   open[]：{ question_ref, title_zh, phase, waiting_on }，phase ∈ RUNNING／QUEUED／READY_FOR_K2／DESK_LINK。
 */
function stageOf(facts) {
  const locked = facts.comparisons.filter((card) => card.state === 'LOCKED_VERIFIED');
  const broken = facts.comparisons.filter((card) => BROKEN.has(card.state));
  const decisions = adoptionView.summaryOf(locked.map((card) => ({ role: 'COMPARISON', adoption: card.adoption })));
  const q0Locked = Boolean(facts.q0 && facts.q0.state === 'LOCKED_VERIFIED');
  const hasRecord = Boolean(facts.profile || facts.current_case || facts.baseline_of_case);
  const openCount = facts.open.length;

  let code;
  if (!hasRecord) code = facts.m4 && facts.m4.state === 'IN_SCOPE_NOT_ONBOARDED' ? 'M4_PENDING' : 'NOT_CONNECTED';
  else if (!facts.profile && !facts.current_case) code = 'FROZEN_BASELINE';
  else if (!facts.q0 || facts.q0.state === 'NOT_IMPORTED') code = 'CONNECTED';
  else if (!q0Locked) code = 'Q0_INVALID';
  else if (!locked.length) code = 'Q0_LOCKED';
  else code = decisions.decided ? 'DECIDED' : 'COMPARED';

  const openSuffix = openCount ? `，${openCount} 题待研究` : '';
  const decidedText = decisions.decided
    ? `已决定 ${decisions.decided} 题（${[decisions.adopted ? `采用 ${decisions.adopted}` : null, decisions.not_adopted ? `不采用 ${decisions.not_adopted}` : null].filter(Boolean).join('、')}）`
      + (decisions.pending ? `，待决定 ${decisions.pending} 题` : '')
    : `待 Owner 决定 ${decisions.pending} 题`;
  const compared = () => `Q0 ${facts.q0.verdict_label}；方案对比 ${locked.length} 题已锁定，${decidedText}${openCount ? `；${openCount} 题待研究` : ''}`;
  const headline = {
    NOT_CONNECTED: () => '尚未接入 Research',
    M4_PENDING: () => `${facts.m4.state_label}（第 ${facts.m4.batch} 批）`,
    FROZEN_BASELINE: () => '作为冻结基线关联，不接收新的研究结论',
    CONNECTED: () => `已接入，Q0 尚未锁定${openSuffix}`,
    Q0_INVALID: () => q0Text(facts.q0),
    Q0_LOCKED: () => `Q0 ${facts.q0.verdict_label}${facts.q0.a0 && facts.q0.a0.state !== 'PASSED' ? `（${a0Text(facts.q0.a0)}）` : ''}；方案对比尚未开始${openSuffix}`,
    COMPARED: compared,
    DECIDED: compared,
  }[code]();

  // 卡片上的四行；只给有档案或运行态 case 的策略（冻结基线、未接入只有一句话）
  const steps = facts.profile || facts.current_case ? [
    {
      key: 'BASELINE', label_zh: '体检与基线',
      text_zh: [facts.m1 ? M1_WORDS[facts.m1.state] : 'M1 体检包未登记', facts.q0 && q0Locked ? a0Text(facts.q0.a0) : null,
        facts.q0 ? q0Text(facts.q0) : Q0_WORDS.NOT_IMPORTED].filter(Boolean).join(' · '),
    },
    {
      key: 'COMPARISON', label_zh: '方案对比',
      text_zh: [locked.length ? `${locked.length} 题已锁定（${refs(locked)}${facts.rounds ? `，${facts.rounds} 轮` : ''}）：${verdictTally(locked)}` : '尚未开始',
        broken.length ? `${broken.length} 题封存结果校验未通过（${refs(broken)}）` : null].filter(Boolean).join('；'),
    },
    {
      key: 'ADOPTION', label_zh: '采用决定',
      text_zh: locked.length ? [
        decisions.adopted ? `采用 ${decisions.adopted}（${refs(locked.filter((card) => card.adoption.decision === 'ADOPT'))}）` : null,
        decisions.not_adopted ? `不采用 ${decisions.not_adopted}（${refs(locked.filter((card) => card.adoption.decision === 'NOT_ADOPTED'))}）` : null,
        decisions.pending ? `待 Owner 决定 ${decisions.pending}（${refs(locked.filter((card) => card.adoption.state !== 'DECIDED'))}）` : null,
      ].filter(Boolean).join('、') : '还没有可决定的对比结果',
    },
    {
      key: 'OPEN', label_zh: '待研究',
      text_zh: openCount ? facts.open.map((item) => `${item.question_ref ? `${item.question_ref} ` : ''}${item.title_zh}（${PHASE_WORDS[item.phase](item)}）`).join('；')
        : '研究计划里没有排队的题',
    },
  ] : [];

  return {
    code, has_record: hasRecord, headline_zh: headline, steps,
    counts: {
      q0_locked: q0Locked, comparisons_locked: locked.length, comparisons_broken: broken.length, rounds: facts.rounds,
      decided: decisions.decided, adopted: decisions.adopted, not_adopted: decisions.not_adopted, pending: decisions.pending, open: openCount,
    },
    technical: [
      facts.q0 && facts.q0.result_id ? { label: 'Q0 锁', value: facts.q0.result_id } : null,
      ...(facts.q0 ? facts.q0.superseded_result_ids.map((id) => ({ label: '已替代的 Q0 锁', value: id })) : []),
      ...locked.map((card) => ({ label: `${card.question_ref} 锁`, value: card.result_id })),
    ].filter(Boolean),
  };
}

// ── 读事实 ────────────────────────────────────────────────────────────────────────

/** M1：档案登记的证据清单在不在、sha256 是否与登记一致、诊断生产者是否已登记。不跑完整体检（那在详情页「体检与证据」）。 */
function m1Of(profile) {
  const evidence = profile.m1_evidence;
  let bytes;
  try { bytes = fs.readFileSync(path.join(REPO_ROOT, evidence.manifest_ref)); } catch (error) { return { state: 'MANIFEST_MISSING' }; }
  if (sha256(bytes) !== evidence.manifest_sha256) return { state: 'MANIFEST_DRIFT' };
  const producer = evidence.producer === undefined && profiles.isLegacyShape(profile) ? producers.LEGACY_DEFAULT : evidence.producer;
  return { state: producers.isRegistered(producer) ? 'REGISTERED' : 'NO_PRODUCER' };
}

/** Q0：当前锁（替代链的最后一把）的投影；结论词、A0 取自投影，替代过的旧锁取自账本。 */
function q0Of(profile) {
  const chain = baselineEvaluation.locks(profile.case_ref);
  const projection = baselineEvaluation.readProjection(profile.case_ref);
  const head = chain.length ? chain[chain.length - 1] : null;
  return {
    state: projection.state, result_id: head ? head.result_id : null,
    verdict_label: projection.state === 'LOCKED_VERIFIED' ? projection.conclusion.label : null,
    a0: projection.state === 'LOCKED_VERIFIED' ? projection.a0 || null : null,
    superseded_result_ids: chain.slice(0, -1).map((row) => row.result_id),
  };
}

/** Desk case 回链里还没有锁定结果的研究问题；题名与是否已锁取自 hypotheses／experiments 账本（回链没写时）。 */
function deskQuestions(cases) {
  const hypotheses = new Map(experiments.listHypotheses().map((row) => [row.hypothesis_id, row]));
  const experimentRows = new Map(experiments.listExperiments().map((row) => [row.experiment_id, row]));
  return cases.flatMap((item) => item.links || [])
    .filter((link) => !link.result_hash && !(link.experiment_ref && (experimentRows.get(link.experiment_ref) || {}).status === 'RESULT_LOCKED'))
    .map((link) => ({
      question_ref: null, phase: 'DESK_LINK', waiting_on: [],
      title_zh: link.research_question_label || (hypotheses.get(link.research_question_ref) || {}).research_question || '研究问题（名称待登记）',
    }));
}

function factsOf(strategyRef, { cases, m4Items }) {
  const profile = profiles.get(strategyRef);
  const ownCases = cases.filter((item) => item.strategy_ref === strategyRef);
  const base = {
    profile: Boolean(profile), m4: m4Items.find((item) => item.strategy_ref === strategyRef) || null,
    current_case: ownCases.length > 0, baseline_of_case: cases.some((item) => item.baseline && item.baseline.strategy_ref === strategyRef),
    m1: null, q0: null, comparisons: [], rounds: null, open: deskQuestions(ownCases),
  };
  if (!profile) return base;
  const program = candidateComparison.registry.forStrategy(strategyRef);
  const projections = candidateComparison.readProjections(profile.case_ref);
  const records = adoption.effective(adoption.records().filter((row) => row.strategy_ref === strategyRef));
  const notes = detailNotes.forStrategy(strategyRef);
  const meta = (question) => (notes && notes.research_queue && notes.research_queue.questions[question]) || {};
  const comparisons = projections.filter((card) => card.state !== 'NOT_IMPORTED' && card.state !== 'NOT_CONNECTED').map((card) => ({
    question_ref: card.question_ref, state: card.state, verdict_label: card.verdict_label, result_id: card.result_id,
    adoption: adoptionView.adoptionOf(card.state === 'LOCKED_VERIFIED' ? records.get(adoption.keyOf(card.result_id)) : null),
  }));
  const rounds = new Set(comparisons.filter((card) => card.state === 'LOCKED_VERIFIED').map((card) => meta(card.question_ref).round).filter(Number.isInteger));
  const queued = Object.keys(profile.research_program.queue).map((question) => program && program.queueState(question, projections))
    .filter((state) => state && PHASE_WORDS[state.phase])
    .map((state) => ({ ...state, question_ref: state.question, title_zh: meta(state.question).name_zh || profile.research_program.queue[state.question].title }));
  return { ...base, m1: m1Of(profile), q0: q0Of(profile), comparisons, rounds: rounds.size || null, open: [...queued, ...base.open] };
}

/** 目录里每条策略的研究进度（Map：strategy_ref → stageOf 的结果）。`cases` 取自 runtime-research-loop，`m4Items` 取自它的 platform_m4。 */
function readStages({ strategies, cases = [], m4Items = [] }) {
  return new Map(strategies.map((item) => [item.strategy_ref, stageOf(factsOf(item.strategy_ref, { cases, m4Items }))]));
}

/** 页头计数：有研究记录的策略数，按走到的一步细分。 */
function countsOf(stages) {
  const list = [...stages];
  const count = (predicate) => list.filter(predicate).length;
  return {
    with_record: count((stage) => stage.has_record),
    q0_locked: count((stage) => stage.counts.q0_locked),
    q0_invalid: count((stage) => stage.code === 'Q0_INVALID'),
    compared: count((stage) => stage.counts.comparisons_locked > 0),
    decided: count((stage) => stage.counts.decided > 0),
    connected_without_q0: count((stage) => stage.code === 'CONNECTED'),
    frozen_baseline: count((stage) => stage.code === 'FROZEN_BASELINE'),
    m4_pending: count((stage) => stage.code === 'M4_PENDING'),
  };
}

/** 页头那句里关于 Research 的部分，由计数套句式。 */
function countsSentence(counts) {
  if (!counts.with_record) return `目前没有策略有研究记录${counts.m4_pending ? `；${counts.m4_pending} 个已列入 M4 范围、尚未接入` : ''}。`;
  const detail = [
    counts.q0_locked ? `${counts.q0_locked} 个已锁定 Q0 回测结论${counts.compared ? `（${[`${counts.compared} 个已有锁定的方案对比`, counts.decided ? `${counts.decided} 个已有 Owner 采用决定` : null].filter(Boolean).join('、')}）` : ''}` : null,
    counts.q0_invalid ? `${counts.q0_invalid} 个 Q0 封存结果校验未通过` : null,
    counts.connected_without_q0 ? `${counts.connected_without_q0} 个已接入、Q0 尚未锁定` : null,
    counts.frozen_baseline ? `${counts.frozen_baseline} 个作为冻结基线关联` : null,
  ].filter(Boolean).join('，');
  return `其中 ${counts.with_record} 个有研究记录：${detail}${counts.m4_pending ? `；另有 ${counts.m4_pending} 个已列入 M4 范围、尚未接入` : ''}。`;
}

module.exports = { M1_WORDS, stageOf, factsOf, readStages, countsOf, countsSentence };
