'use strict';

/**
 * A 股研究模块登记（QRP_ASHARE_RESEARCH_MODULES_V1，Owner 2026-11-07；队列 #21）。
 *
 * 事实来源是 `config/ashare_research_modules.v1.json`（研究会话登记，QRP #59；形状由
 * tests/ashare_research_modules.test.js 校验）。本模块只读、只校验页面要用的字段，不改写、不补数据：
 *   - parent：整本账本（desk_book），两块的上级，只计一次；
 *   - modules：按 order 排的研究模块（名称、簿、组件、研究线、方向、现行规则）；
 *   - verdicts：封存结论，decision 只取 verdict_rule.values（做 / 不做），statistical_label 不是结论；
 *   - in_progress / q0：仍在研究的题，没有 decision，带预计日期和判定规则；
 *   - coverage_gaps：还没有研究线的范围，带占位符「待交付 · X」。
 * 字段缺失或类型不符，require 时就抛出，进程不继续（与 strategy-detail-notes 等登记相同）。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'config', 'ashare_research_modules.v1.json');
const CONTRACT = 'QRP_ASHARE_RESEARCH_MODULES_V1';
const PENDING_PREFIX = '待交付 · ';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class AshareResearchModulesError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new AshareResearchModulesError(code, detail); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const text = (object, key, where) => { if (!isText(object[key])) fail('ASHARE_RESEARCH_MODULES_FIELD', `${where}.${key}`); return object[key]; };
const list = (object, key, where) => { if (!Array.isArray(object[key])) fail('ASHARE_RESEARCH_MODULES_FIELD', `${where}.${key}`); return object[key]; };

function validateOpen(item, where, values) {
  if (!isObject(item) || item.state !== 'IN_PROGRESS') fail('ASHARE_RESEARCH_MODULES_FIELD', `${where}.state`);
  text(item, 'state_label_zh', where);
  // 仍在研究：不得带结论
  if ('decision' in item) fail('ASHARE_RESEARCH_MODULES_OPEN_HAS_DECISION', where);
  if (item.decided_by_zh !== undefined && !values.every((value) => String(item.decided_by_zh).includes(value))) {
    fail('ASHARE_RESEARCH_MODULES_FIELD', `${where}.decided_by_zh`);
  }
}

function validate(doc) {
  if (!isObject(doc) || doc.contract !== CONTRACT) fail('ASHARE_RESEARCH_MODULES_CONTRACT_INVALID', doc && doc.contract);
  const rule = doc.verdict_rule;
  if (!isObject(rule) || !Array.isArray(rule.values) || !rule.values.length || !rule.values.every(isText)) fail('ASHARE_RESEARCH_MODULES_FIELD', 'verdict_rule.values');
  text(rule, 'in_progress_label_zh', 'verdict_rule');
  const parent = doc.parent;
  if (!isObject(parent) || parent.counted_once !== true) fail('ASHARE_RESEARCH_MODULES_FIELD', 'parent.counted_once');
  text(parent, 'desk_book', 'parent'); text(parent, 'label_zh', 'parent');
  const modules = list(doc, 'modules', '$');
  if (!modules.length) fail('ASHARE_RESEARCH_MODULES_FIELD', 'modules');
  const ids = new Set();
  modules.forEach((item, i) => {
    const where = `modules[${i}]`;
    if (!isObject(item) || !Number.isInteger(item.order)) fail('ASHARE_RESEARCH_MODULES_FIELD', `${where}.order`);
    for (const key of ['module_id', 'label_zh', 'book', 'component', 'research_line', 'direction_zh']) text(item, key, where);
    if (ids.has(item.module_id)) fail('ASHARE_RESEARCH_MODULES_DUPLICATE', item.module_id);
    ids.add(item.module_id);
    list(item, 'verdicts', where).forEach((verdict, j) => {
      const at = `${where}.verdicts[${j}]`;
      if (!isObject(verdict) || verdict.state !== 'CONCLUDED') fail('ASHARE_RESEARCH_MODULES_FIELD', `${at}.state`);
      text(verdict, 'id', at); text(verdict, 'title_zh', at);
      if (!rule.values.includes(verdict.decision)) fail('ASHARE_RESEARCH_MODULES_DECISION', `${at}.decision:${rule.values.join('|')}`);
      // 统计标签不是结论
      if (rule.values.includes(verdict.statistical_label)) fail('ASHARE_RESEARCH_MODULES_DECISION', `${at}.statistical_label`);
    });
    list(item, 'in_progress', where).forEach((open, j) => {
      const at = `${where}.in_progress[${j}]`;
      validateOpen(open, at, rule.values);
      text(open, 'id', at); text(open, 'title_zh', at);
      if (open.expected_by !== undefined && !DAY.test(open.expected_by)) fail('ASHARE_RESEARCH_MODULES_FIELD', `${at}.expected_by`);
    });
    list(item, 'coverage_gaps', where).forEach((gap, j) => {
      const at = `${where}.coverage_gaps[${j}]`;
      if (!isObject(gap)) fail('ASHARE_RESEARCH_MODULES_FIELD', at);
      text(gap, 'id', at); text(gap, 'label_zh', at);
      if (gap.placeholder_zh !== undefined && !String(gap.placeholder_zh).startsWith(PENDING_PREFIX)) fail('ASHARE_RESEARCH_MODULES_FIELD', `${at}.placeholder_zh`);
    });
  });
  if (doc.q0 !== undefined) {
    validateOpen(doc.q0, 'q0', rule.values);
    text(doc.q0, 'title_zh', 'q0');
    if (!Array.isArray(doc.q0.applies_to) || !doc.q0.applies_to.every((id) => ids.has(id))) fail('ASHARE_RESEARCH_MODULES_FIELD', 'q0.applies_to');
  }
  return deepFreeze(JSON.parse(JSON.stringify(doc)));
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

const REGISTRY = validate(JSON.parse(fs.readFileSync(FILE, 'utf8')));

/** 这本 Desk 账本拆出的研究模块登记；不是登记里的上级账本返回 null。 */
const forDeskBook = (deskBook, registry = REGISTRY) => (deskBook && registry.parent.desk_book === deskBook ? registry : null);

module.exports = { FILE, CONTRACT, PENDING_PREFIX, REGISTRY, validate, forDeskBook, AshareResearchModulesError };
