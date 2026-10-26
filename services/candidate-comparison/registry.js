'use strict';

/**
 * 候选对比的题目登记（按题目 id）。每个登记项写明：K2 路径与 sha256、候选臂键、判据集与必填常数、
 * 样本外期望（含原因码规则）、是否必须有归因块／敞口披露。导入器与页面只读这里，不再写死任何一题。
 * 新增一题 = 在 questions/ 里加一个登记项并在这里登记，随冻结的导入规格一起合并。
 *
 * 题目按策略分组（QRP_MULTI_STRATEGY_PROFILE_REGISTRY_ACCEPTANCE_V1 R2）：一题属于哪条策略，由它的导入档案（`profile_ref`）
 * 列在哪条策略档案的 `comparison_import_profile_ids` 里决定；题目队列与先后关系取自该档案的 `research_program`。
 * `forStrategy(strategy_ref)` 给出一条策略自己的那组题；未登记的策略返回 null，不借用别的策略的题。
 */
const profiles = require('../strategy-profiles');
const { Q1 } = require('./questions/q1');
const { Q2 } = require('./questions/q2');
const { Q3 } = require('./questions/q3');
const { Q4 } = require('./questions/q4');

const ENTRIES = Object.freeze([Q1, Q2, Q3, Q4]);

/**
 * 一条策略的题组。研究计划里各题的先后关系（US_V5：Q2 可与 Q1 并行，Q3 在 Q1 之后，Q4 的运行排在 Q3 封存之后
 * ——US_V5_M2_RESEARCH_PROGRAM_V1 的队列表；Q3 K2 裁定 7）在档案的 `research_program.queue[*].after`。
 * 题目现在处在哪一步不写死文案，从锁、登记项和这张表推出：
 *   LOCKED／INVALID／MISSING   有封存结果（已锁定、校验失败、文件缺失）；
 *   RUNNING                    K2 已冻结（已有登记项），还没有封存结果；
 *   QUEUED                     K2 还没冻结，前置题没有都锁定，写明在等谁；
 *   READY_FOR_K2               K2 还没冻结，前置题都已锁定，等冻结 K2；
 *   null                       计划里没有这一题，调用方不改它的文案。
 */
function programOf(profile) {
  const QUESTIONS = Object.freeze(Object.fromEntries(ENTRIES
    .filter((entry) => profile.comparison_import_profile_ids.includes(entry.profile_ref))
    .map((entry) => [entry.question_ref, entry])));
  /** 队列顺序：页面上每个已锁定的题目一张卡，按这个顺序排。 */
  const ORDER = Object.freeze(Object.values(QUESTIONS).sort((a, b) => a.queue_order - b.queue_order).map((entry) => entry.question_ref));
  const DEFAULT_QUESTION = profile.research_program.default_question; // US_V5：改造前唯一的一题 Q1；没有别的提示时错误码与空状态都按它
  const PLAN = Object.freeze(Object.fromEntries(Object.entries(profile.research_program.queue).map(([question, item]) => [question, Object.freeze([...item.after])])));

  function queueState(question, projections = []) {
    const byQuestion = new Map(projections.map((projection) => [projection.question_ref, projection]));
    const own = byQuestion.get(question);
    const phaseOf = { LOCKED_VERIFIED: 'LOCKED', INVALID: 'INVALID', MISSING: 'MISSING' };
    if (own && phaseOf[own.state]) return { question, phase: phaseOf[own.state], waiting_on: [] };
    if (QUESTIONS[question]) return { question, phase: 'RUNNING', waiting_on: [] };
    if (!PLAN[question]) return null;
    const waiting = PLAN[question].filter((before) => !(byQuestion.get(before) && byQuestion.get(before).state === 'LOCKED_VERIFIED'));
    return { question, phase: waiting.length ? 'QUEUED' : 'READY_FOR_K2', waiting_on: waiting };
  }

  const get = (questionRef) => QUESTIONS[questionRef] || null;
  const bySchema = (schema) => Object.values(QUESTIONS).find((entry) => entry.schema === schema) || null;
  return Object.freeze({ strategy_ref: profile.strategy_ref, QUESTIONS, ORDER, DEFAULT_QUESTION, PLAN, queueState, get, bySchema });
}

const programs = new Map();
/** 一条策略自己的题组；未登记的 strategy_ref 返回 null。 */
function forStrategy(strategyRef) {
  const profile = profiles.get(strategyRef);
  if (!profile) return null;
  if (!programs.has(profile)) programs.set(profile, programOf(profile));
  return programs.get(profile);
}

/** 所有已登记的题目里按 schema 找（不限策略）；导入时再核对它属于哪条策略。 */
const entryBySchema = (schema) => ENTRIES.find((entry) => entry.schema === schema) || null;

/** 这一题属于哪条策略（它的导入档案登记在哪个策略档案里）；没有归属返回 null。 */
const ownerOf = (entry) => (entry ? profiles.byComparisonProfile(entry.profile_ref) : null);

// 改造前的单策略接口：默认档案（注册表的 default_strategy_ref）的那组题，供默认参数和既有调用方使用
const DEFAULT = forStrategy(profiles.defaultProfile().strategy_ref);

module.exports = {
  ENTRIES, forStrategy, ownerOf, entryBySchema, QUESTIONS: DEFAULT.QUESTIONS, ORDER: DEFAULT.ORDER, DEFAULT_QUESTION: DEFAULT.DEFAULT_QUESTION,
  PLAN: DEFAULT.PLAN, queueState: DEFAULT.queueState, get: DEFAULT.get, bySchema: DEFAULT.bySchema,
};
