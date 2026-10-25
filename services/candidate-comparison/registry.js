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

const get = (questionRef) => QUESTIONS[questionRef] || null;
const bySchema = (schema) => Object.values(QUESTIONS).find((entry) => entry.schema === schema) || null;

module.exports = { QUESTIONS, ORDER, DEFAULT_QUESTION, get, bySchema };
