'use strict';

/**
 * 按策略取值的档案注册表（QRP_MULTI_STRATEGY_PROFILE_REGISTRY_ACCEPTANCE_V1）。
 *
 * 事实来源是 `config/strategy_profiles.v1.json`：每条策略一项，写明 case、市场、币种、比较对象、底线、
 * 基线结果 schema、导入档案、对比导入档案、相位词与分段词、成本模型、M1 证据位置、前向观察来源键和页面显示名。
 * 导入器、诊断、研究工作台、对比题注册、前向观察与页面都从这里按 strategy_ref 取值，不再写死。
 *
 * R1.3：字段缺失或类型不符，校验失败并给出原因码；模块在 require 时就加载，校验失败直接抛出，进程不继续。
 * R3：查不到的 strategy_ref 一律返回 null（`get`）或抛 `STRATEGY_PROFILE_NOT_REGISTERED`（`mustGet`），不回落到别的策略。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'config', 'strategy_profiles.v1.json');
const CONTRACT = 'QRP_STRATEGY_PROFILES_V1';
const CURRENCIES = Object.freeze(['USD', 'USDT', 'CNY']);
const COMPARATOR_ROLES = Object.freeze(['MARKET', 'CASH']);
/** 可选：LEGACY_V1 = 投影沿用改造前的字段名与页面措辞（US_V5，输出由 D1 逐字节冻结）；不写 = 投影带上档案自己的币种与说明。 */
const PROJECTION_SHAPES = Object.freeze(['LEGACY_V1']);
const SHA256 = /^[0-9a-f]{64}$/;

class StrategyProfileError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new StrategyProfileError(code, detail); };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** 必填字段：缺失报 FIELD_MISSING，类型不符报 FIELD_TYPE；detail 写 `<strategy_ref>.<字段路径>`。 */
function checker(where) {
  const missing = (key) => fail('STRATEGY_PROFILE_FIELD_MISSING', `${where}.${key}`);
  const wrong = (key, expected) => fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.${key}:${expected}`);
  const present = (object, key) => object[key] !== undefined && object[key] !== null;
  return {
    text(object, key) { if (!present(object, key)) missing(key); if (!isText(object[key])) wrong(key, 'string'); return object[key]; },
    object(object, key) { if (!present(object, key)) missing(key); if (!isObject(object[key])) wrong(key, 'object'); return object[key]; },
    array(object, key) { if (!present(object, key)) missing(key); if (!Array.isArray(object[key])) wrong(key, 'array'); return object[key]; },
    number(object, key) {
      if (!present(object, key)) missing(key);
      if (typeof object[key] !== 'number' || !Number.isFinite(object[key]) || object[key] <= 0) wrong(key, 'positive number');
      return object[key];
    },
    words(object, key) {
      const map = this.object(object, key);
      if (!Object.keys(map).length) missing(`${key}.*`);
      for (const [id, word] of Object.entries(map)) if (!isText(word)) wrong(`${key}.${id}`, 'string');
      return map;
    },
  };
}

function validateProfile(raw, index) {
  if (!isObject(raw)) fail('STRATEGY_PROFILE_FIELD_TYPE', `profiles[${index}]:object`);
  const head = checker(`profiles[${index}]`);
  const ref = head.text(raw, 'strategy_ref');
  const c = checker(ref);
  c.text(raw, 'case_ref'); c.text(raw, 'market'); c.text(raw, 'display_name');
  if (raw.projection_shape !== undefined && !PROJECTION_SHAPES.includes(raw.projection_shape)) {
    fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.projection_shape:${PROJECTION_SHAPES.join('|')}`);
  }
  const currency = c.text(raw, 'currency');
  if (!CURRENCIES.includes(currency)) fail('STRATEGY_PROFILE_CURRENCY_UNSUPPORTED', `${ref}:${currency}`);

  const comparators = c.array(raw, 'comparators');
  comparators.forEach((item, i) => {
    if (!isObject(item)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.comparators[${i}]:object`);
    const ci = checker(`${ref}.comparators[${i}]`);
    ci.text(item, 'key'); ci.text(item, 'label_zh');
    if (!COMPARATOR_ROLES.includes(ci.text(item, 'role'))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.comparators[${i}].role:${COMPARATOR_ROLES.join('|')}`);
  });
  // 基线评价的两条判据各要一个比较对象：一个市场基准、一个现金。
  for (const role of COMPARATOR_ROLES) {
    if (comparators.filter((item) => item.role === role).length !== 1) fail('STRATEGY_PROFILE_COMPARATOR_ROLES', `${ref}:${role}`);
  }
  if (new Set(comparators.map((item) => item.key)).size !== comparators.length) fail('STRATEGY_PROFILE_DUPLICATE', `${ref}.comparators`);

  const floor = c.object(raw, 'floor');
  const cf = checker(`${ref}.floor`);
  cf.number(floor, 'value'); cf.text(floor, 'rule_label_zh');
  if (cf.text(floor, 'currency') !== currency) fail('STRATEGY_PROFILE_FLOOR_CURRENCY_MISMATCH', `${ref}:${floor.currency}≠${currency}`);

  c.text(raw, 'baseline_result_schema'); c.text(raw, 'import_profile_id');
  c.array(raw, 'comparison_import_profile_ids').forEach((id, i) => { if (!isText(id)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.comparison_import_profile_ids[${i}]:string`); });
  c.words(raw, 'phase_words'); c.words(raw, 'segment_words');
  c.text(raw, 'cost_model_id');
  const m1 = c.object(raw, 'm1_evidence');
  const cm = checker(`${ref}.m1_evidence`);
  cm.text(m1, 'manifest_ref'); cm.text(m1, 'diagnostic_schema');
  if (!SHA256.test(cm.text(m1, 'manifest_sha256'))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.m1_evidence.manifest_sha256:sha256`);
  c.text(raw, 'forward_observation_source_key');

  const program = c.object(raw, 'research_program');
  const cp = checker(`${ref}.research_program`);
  cp.text(program, 'plan_ref'); cp.text(program, 'amendment_ref');
  if (program.default_question === undefined) fail('STRATEGY_PROFILE_FIELD_MISSING', `${ref}.research_program.default_question`);
  if (program.default_question !== null && !isText(program.default_question)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.research_program.default_question:string|null`);
  const queue = cp.object(program, 'queue');
  for (const [question, item] of Object.entries(queue)) {
    if (!isObject(item)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.research_program.queue.${question}:object`);
    const cq = checker(`${ref}.research_program.queue.${question}`);
    cq.text(item, 'title'); cq.text(item, 'status');
    cq.array(item, 'after').forEach((before) => { if (!queue[before]) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.research_program.queue.${question}.after:${before}`); });
  }
  if (program.default_question && !queue[program.default_question]) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.research_program.default_question:${program.default_question}`);
  return deepFreeze(JSON.parse(JSON.stringify(raw)));
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

/** 整个注册表：合同名、默认策略已登记、各档案字段齐全，且 strategy_ref／case／结果 schema／对比导入档案互不重复。 */
function validate(doc) {
  if (!isObject(doc) || doc.contract !== CONTRACT || !Array.isArray(doc.profiles)) fail('STRATEGY_PROFILES_CONTRACT_INVALID', doc && doc.contract);
  const profiles = doc.profiles.map(validateProfile);
  const unique = (label, values) => {
    const seen = new Set();
    for (const value of values) { if (seen.has(value)) fail('STRATEGY_PROFILE_DUPLICATE', `${label}:${value}`); seen.add(value); }
  };
  unique('strategy_ref', profiles.map((item) => item.strategy_ref));
  unique('case_ref', profiles.map((item) => item.case_ref));
  unique('baseline_result_schema', profiles.map((item) => item.baseline_result_schema));
  unique('comparison_import_profile_id', profiles.flatMap((item) => item.comparison_import_profile_ids));
  if (!profiles.some((item) => item.strategy_ref === doc.default_strategy_ref)) fail('STRATEGY_PROFILE_DEFAULT_NOT_REGISTERED', doc.default_strategy_ref);
  return Object.freeze({ contract: CONTRACT, default_strategy_ref: doc.default_strategy_ref, profiles: Object.freeze(profiles) });
}

function load(file = FILE) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail('STRATEGY_PROFILES_FILE_UNREADABLE', `${file}:${error.code || error.message}`); }
  return validate(doc);
}

let active = load();

/** 只给测试用：换上另一份已校验的注册表（例如生产注册表加 tests/fixtures 里的测试档案），返回原来那份。 */
function use(registry) {
  if (!registry || registry.contract !== CONTRACT || !Array.isArray(registry.profiles)) fail('STRATEGY_PROFILES_CONTRACT_INVALID', 'use');
  const previous = active;
  active = registry;
  return previous;
}

const list = () => active.profiles;
const find = (predicate) => active.profiles.find(predicate) || null;
const get = (strategyRef) => (strategyRef ? find((item) => item.strategy_ref === strategyRef) : null);
const byCase = (caseRef) => (caseRef ? find((item) => item.case_ref === caseRef) : null);
const byBaselineSchema = (schema) => (schema ? find((item) => item.baseline_result_schema === schema) : null);
/** 一个对比导入档案只属于一条策略（validate 保证不重复）。 */
const byComparisonProfile = (profileRef) => (profileRef ? find((item) => item.comparison_import_profile_ids.includes(profileRef)) : null);
const defaultProfile = () => get(active.default_strategy_ref);

function mustGet(strategyRef) {
  const profile = get(strategyRef);
  if (!profile) fail('STRATEGY_PROFILE_NOT_REGISTERED', strategyRef || '(empty)');
  return profile;
}

const isLegacyShape = (profile) => profile.projection_shape === 'LEGACY_V1';
const comparator = (profile, role) => profile.comparators.find((item) => item.role === role);
const comparatorLabel = (profile, key) => (profile.comparators.find((item) => item.key === key) || {}).label_zh;

module.exports = {
  FILE, CONTRACT, CURRENCIES, StrategyProfileError, validate, load, use, list, get, mustGet, byCase, byBaselineSchema,
  byComparisonProfile, defaultProfile, isLegacyShape, comparator, comparatorLabel,
};
