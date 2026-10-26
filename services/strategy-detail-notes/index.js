'use strict';

/**
 * 策略详情页的说明登记（CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_5）。
 *
 * 事实来源是 `config/strategy_detail_notes.v1.json`，按 strategy_ref 一项，只放说明文字与登记状态，不放数字：
 *   - comparators：比较对象的定义（E2.1）与分红口径（E2.2）。口径按锁定结果文件的 sha256 绑定，
 *     结果文件没登记就是「分红口径未记录」，页面不自行判定；
 *   - stress_scenarios：缺场景／无效输入行的白话原因与能否补（E5），按 scenario + 类别对上才用；
 *   - research_queue：研究队列表每题的研究部分、中文题名与来源（E7.1）；修订 6 再加基线行的名称、每题所属轮次与各轮名称；
 *     修订 7 再加组合题的 combines（组合了哪几题），总览的一句话结论据此数「已采用的改进」；
 *   - code_names：内部代号 → 中文题名（E7.2），页面把主内容里的代号换掉，代号只留在折叠的技术详情里。
 * 字段缺失或类型不符，require 时就抛出，进程不继续；查不到的策略返回 null（页面照旧，不借用别的策略的说明）。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'config', 'strategy_detail_notes.v1.json');
const CONTRACT = 'QRP_STRATEGY_DETAIL_NOTES_V1';
const SHA256 = /^[0-9a-f]{64}$/;
const BASES = Object.freeze({ TOTAL_RETURN: '含分红（复权价）', PRICE_RETURN: '价格收益，不含分红' });
const NOT_RECORDED = '分红口径未记录';
const KINDS = Object.freeze(['MISSING', 'INVALID_INPUT']);
const FILL_STATES = Object.freeze(['FILLABLE', 'NOT_FILLABLE']);
const PROJECTS = Object.freeze({ REGISTERED: '已立项', NOT_REGISTERED: '未立项' });

class StrategyDetailNotesError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new StrategyDetailNotesError(code, detail); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const text = (object, key, where) => { if (!isText(object[key])) fail('STRATEGY_DETAIL_NOTES_FIELD', `${where}.${key}`); return object[key]; };

function validateStrategy(ref, raw) {
  if (!isObject(raw)) fail('STRATEGY_DETAIL_NOTES_FIELD', ref);
  const comparators = raw.comparators || {};
  if (!isObject(comparators)) fail('STRATEGY_DETAIL_NOTES_FIELD', `${ref}.comparators`);
  for (const [key, item] of Object.entries(comparators)) {
    const where = `${ref}.comparators.${key}`;
    if (!isObject(item)) fail('STRATEGY_DETAIL_NOTES_FIELD', where);
    text(item, 'definition_zh', where);
    (item.dividend_basis || []).forEach((entry, i) => {
      const at = `${where}.dividend_basis[${i}]`;
      if (!isObject(entry) || !SHA256.test(entry.result_sha256 || '')) fail('STRATEGY_DETAIL_NOTES_FIELD', `${at}.result_sha256`);
      if (!BASES[entry.basis]) fail('STRATEGY_DETAIL_NOTES_FIELD', `${at}.basis:${Object.keys(BASES).join('|')}`);
      // 口径必须有依据（引擎 file:line 或结果文件字段），不能只写结论
      if (!Array.isArray(entry.evidence) || !entry.evidence.length || !entry.evidence.every(isText)) fail('STRATEGY_DETAIL_NOTES_FIELD', `${at}.evidence`);
    });
  }
  (raw.stress_scenarios || []).forEach((row, i) => {
    const where = `${ref}.stress_scenarios[${i}]`;
    if (!isObject(row)) fail('STRATEGY_DETAIL_NOTES_FIELD', where);
    text(row, 'scenario', where); text(row, 'plain_reason_zh', where);
    if (!KINDS.includes(row.kind)) fail('STRATEGY_DETAIL_NOTES_FIELD', `${where}.kind:${KINDS.join('|')}`);
    const fill = row.fill;
    if (!isObject(fill) || !FILL_STATES.includes(fill.state)) fail('STRATEGY_DETAIL_NOTES_FIELD', `${where}.fill.state:${FILL_STATES.join('|')}`);
    if (fill.state === 'FILLABLE' && !PROJECTS[fill.project]) fail('STRATEGY_DETAIL_NOTES_FIELD', `${where}.fill.project:${Object.keys(PROJECTS).join('|')}`);
    if (fill.state === 'NOT_FILLABLE') text(fill, 'reason_zh', `${where}.fill`);
  });
  if (raw.research_queue !== undefined) {
    const queue = raw.research_queue;
    if (!isObject(queue) || !isObject(queue.questions)) fail('STRATEGY_DETAIL_NOTES_FIELD', `${ref}.research_queue`);
    text(queue, 'source_zh', `${ref}.research_queue`);
    for (const [question, item] of Object.entries(queue.questions)) {
      const where = `${ref}.research_queue.questions.${question}`;
      if (!isObject(item)) fail('STRATEGY_DETAIL_NOTES_FIELD', where);
      text(item, 'part_zh', where); text(item, 'name_zh', where);
      // 修订 6 H4.3：所属研究计划轮次（可选，正整数）；名称在 rounds 里登记
      if (item.round !== undefined && !(Number.isInteger(item.round) && item.round > 0)) fail('STRATEGY_DETAIL_NOTES_FIELD', `${where}.round`);
      if (item.round !== undefined && queue.rounds !== undefined && !isText((queue.rounds || {})[String(item.round)])) fail('STRATEGY_DETAIL_NOTES_FIELD', `${ref}.research_queue.rounds.${item.round}`);
      // 修订 7 J1.1：组合题登记它组合了哪几题（都要在本队列里登记过）；总览的一句话结论按此把「已采用的改进」去重
      if (item.combines !== undefined && !(Array.isArray(item.combines) && item.combines.length >= 2
        && item.combines.every((other) => other !== question && isObject(queue.questions[other])))) fail('STRATEGY_DETAIL_NOTES_FIELD', `${where}.combines`);
    }
    if (queue.rounds !== undefined && (!isObject(queue.rounds) || !Object.values(queue.rounds).every(isText))) fail('STRATEGY_DETAIL_NOTES_FIELD', `${ref}.research_queue.rounds`);
    if (queue.baseline !== undefined) {
      if (!isObject(queue.baseline)) fail('STRATEGY_DETAIL_NOTES_FIELD', `${ref}.research_queue.baseline`);
      text(queue.baseline, 'name_zh', `${ref}.research_queue.baseline`); text(queue.baseline, 'part_zh', `${ref}.research_queue.baseline`);
    }
  }
  const names = raw.code_names || {};
  if (!isObject(names)) fail('STRATEGY_DETAIL_NOTES_FIELD', `${ref}.code_names`);
  for (const [code, name] of Object.entries(names)) {
    if (!/^[A-Z][A-Z0-9]*$/.test(code) || !isText(name)) fail('STRATEGY_DETAIL_NOTES_FIELD', `${ref}.code_names.${code}`);
  }
  return raw;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

function validate(doc) {
  if (!isObject(doc) || doc.contract !== CONTRACT || !isObject(doc.strategies)) fail('STRATEGY_DETAIL_NOTES_CONTRACT_INVALID', doc && doc.contract);
  for (const [ref, raw] of Object.entries(doc.strategies)) validateStrategy(ref, raw);
  return deepFreeze(JSON.parse(JSON.stringify(doc)));
}

const NOTES = validate(JSON.parse(fs.readFileSync(FILE, 'utf8')));

/** 一条策略的说明；没登记返回 null。 */
const forStrategy = (strategyRef) => (strategyRef && NOTES.strategies[strategyRef]) || null;

/**
 * 比较对象的定义与分红口径（E2）。口径只认按这份结果文件 sha256 登记的那一条；没有登记写「分红口径未记录」。
 * 现金没有分红口径（`dividend_basis` 不写），返回 dividend_zh: null。没有登记定义的比较对象返回 null。
 */
function comparatorNote(notes, key, resultSha256) {
  const item = notes && notes.comparators && notes.comparators[key];
  if (!item) return null;
  if (!item.dividend_basis) return { key, definition_zh: item.definition_zh, dividend: null, dividend_zh: null };
  const entry = item.dividend_basis.find((row) => row.result_sha256 === resultSha256) || null;
  return {
    key, definition_zh: item.definition_zh,
    dividend: entry ? entry.basis : 'NOT_RECORDED', dividend_zh: entry ? BASES[entry.basis] : NOT_RECORDED,
    evidence: entry ? [...entry.evidence] : [],
  };
}

/** 缺场景／无效输入行的白话原因与能否补（E5）；scenario 与类别都对上才用，否则返回 null（页面写「能否补：未登记」）。 */
function stressNote(notes, scenario, kind) {
  const row = notes && (notes.stress_scenarios || []).find((item) => item.scenario === scenario && item.kind === kind);
  if (!row) return null;
  const { fill } = row;
  const label = fill.state === 'NOT_FILLABLE'
    ? `不可补：${fill.reason_zh}`
    : `可补，${PROJECTS[fill.project]}${isText(fill.plan_zh) ? `：${fill.plan_zh}` : ''}`;
  return { plain_reason_zh: row.plain_reason_zh, fill: { state: fill.state, project: fill.project || null, label_zh: label } };
}

module.exports = { FILE, CONTRACT, NOT_RECORDED, BASES, validate, forStrategy, comparatorNote, stressNote, StrategyDetailNotesError };
