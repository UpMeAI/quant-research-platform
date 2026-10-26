'use strict';

/**
 * V8.1 产品里程碑修订 4 的 M4 范围（config/m4_scope.v1.json，紧挨着策略档案注册表）：
 * 当期 M4 方向、未立项的方向、A4.2 的五条策略与批次、首案、复用合同。页面与里程碑记录只读这里。
 * 校验失败在 require 时抛出原因码，进程不继续（同策略档案注册表）。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'config', 'm4_scope.v1.json');
const CONTRACT = 'QRP_M4_SCOPE_V1';
const SHA256 = /^[0-9a-f]{64}$/;
const CURRENCIES = Object.freeze(['USD', 'USDT', 'CNY']);
const NOT_ONBOARDED_LABEL = '已列入 M4 范围，尚未接入';

const fail = (code, detail) => { const error = new Error(detail ? `${code}:${detail}` : code); error.code = code; error.detail = detail || null; throw error; };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

function validate(doc) {
  if (!isObject(doc) || doc.contract !== CONTRACT) fail('M4_SCOPE_CONTRACT_INVALID', doc && doc.contract);
  for (const key of ['acceptance_ref', 'first_case_strategy_ref']) if (!isText(doc[key])) fail('M4_SCOPE_FIELD_MISSING', key);
  if (!SHA256.test(doc.acceptance_sha256 || '')) fail('M4_SCOPE_FIELD_MISSING', 'acceptance_sha256');
  if (!isObject(doc.direction) || !isText(doc.direction.key) || !isText(doc.direction.label_zh)) fail('M4_SCOPE_FIELD_MISSING', 'direction');
  if (!Array.isArray(doc.other_directions) || doc.other_directions.some((item) => !isObject(item)
    || !isText(item.key) || !isText(item.label_zh) || !isText(item.state) || !isText(item.state_label_zh))) fail('M4_SCOPE_FIELD_MISSING', 'other_directions');
  const acceptance = doc.registry_acceptance;
  if (!isObject(acceptance) || !isText(acceptance.ref) || !SHA256.test(acceptance.sha256 || '')) fail('M4_SCOPE_FIELD_MISSING', 'registry_acceptance');
  if (!Array.isArray(doc.items) || !doc.items.length) fail('M4_SCOPE_FIELD_MISSING', 'items');
  doc.items.forEach((item, index) => {
    if (!isObject(item) || !isText(item.id) || !isText(item.label_zh) || !Number.isInteger(item.batch) || item.batch < 1) fail('M4_SCOPE_FIELD_MISSING', `items[${index}]`);
    if (!CURRENCIES.includes(item.currency)) fail('M4_SCOPE_FIELD_TYPE', `items[${index}].currency`);
    if (item.strategy_ref !== null && !isText(item.strategy_ref)) fail('M4_SCOPE_FIELD_TYPE', `items[${index}].strategy_ref`);
    // 身份未定的条目必须写明何时确定
    if (item.strategy_ref === null && !isText(item.identity_note_zh)) fail('M4_SCOPE_FIELD_MISSING', `items[${index}].identity_note_zh`);
  });
  const ids = doc.items.map((item) => item.id);
  const refs = doc.items.map((item) => item.strategy_ref).filter(Boolean);
  if (new Set(ids).size !== ids.length || new Set(refs).size !== refs.length) fail('M4_SCOPE_DUPLICATE');
  if (refs.includes(doc.first_case_strategy_ref)) fail('M4_SCOPE_FIRST_CASE_IN_ITEMS', doc.first_case_strategy_ref);
  return Object.freeze(JSON.parse(JSON.stringify(doc)));
}

function load(file = FILE) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail('M4_SCOPE_FILE_UNREADABLE', `${file}:${error.code || error.message}`); }
  return validate(doc);
}

let active = load();

/** 只给测试用：换上另一份已校验的范围，返回原来那份。 */
function use(scope) {
  if (!scope || scope.contract !== CONTRACT) fail('M4_SCOPE_CONTRACT_INVALID', 'use');
  const previous = active;
  active = scope;
  return previous;
}

const current = () => active;
const itemFor = (strategyRef) => (strategyRef ? active.items.find((item) => item.strategy_ref === strategyRef) || null : null);

module.exports = { FILE, CONTRACT, NOT_ONBOARDED_LABEL, validate, load, use, current, itemFor };
