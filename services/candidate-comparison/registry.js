'use strict';

/**
 * 候选对比的题目登记（按题目 id）。每个登记项写明：K2 路径与 sha256、候选臂键、判据集与必填常数、
 * 样本外期望（含原因码规则）、是否必须有归因块／敞口披露。导入器与页面只读这里，不再写死任何一题。
 * 新增一题 = 在 questions/ 里加一个登记项并在这里登记，随冻结的导入规格一起合并。
 */
const { Q1 } = require('./questions/q1');
const { Q2 } = require('./questions/q2');
const { Q3 } = require('./questions/q3');

const QUESTIONS = Object.freeze({ Q1, Q2, Q3 });
/** 队列顺序：页面上每个已锁定的题目一张卡，按这个顺序排。 */
const ORDER = Object.freeze(Object.values(QUESTIONS).sort((a, b) => a.queue_order - b.queue_order).map((entry) => entry.question_ref));
const DEFAULT_QUESTION = 'Q1'; // 改造前唯一的一题；没有别的提示时错误码与空状态都按它

/**
 * 研究计划里各题的先后关系：Q2 可与 Q1 并行，Q3 在 Q1 之后，Q4 的运行排在 Q3 封存之后
 * （US_V5_M2_RESEARCH_PROGRAM_V1 的队列表；Q3 K2 裁定 7）。题目现在处在哪一步不写死文案，从锁、登记项和这张表推出：
 *   LOCKED／INVALID／MISSING   有封存结果（已锁定、校验失败、文件缺失）；
 *   RUNNING                    K2 已冻结（已有登记项），还没有封存结果；
 *   QUEUED                     K2 还没冻结，前置题没有都锁定，写明在等谁；
 *   READY_FOR_K2               K2 还没冻结，前置题都已锁定，等冻结 K2；
 *   null                       计划里没有这一题，调用方不改它的文案。
 */
const PLAN = Object.freeze({ Q1: Object.freeze([]), Q2: Object.freeze([]), Q3: Object.freeze(['Q1']), Q4: Object.freeze(['Q3']) });

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

module.exports = { QUESTIONS, ORDER, DEFAULT_QUESTION, PLAN, queueState, get, bySchema };
