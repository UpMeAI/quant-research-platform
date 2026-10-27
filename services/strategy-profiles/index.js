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
const producers = require('../strategy-diagnostics/producers');

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
  // CRYPTO_Q0_RESULT_V1 增补 1 冻结说明 1 第 1 条：同一 case 的后继结果 schema（如 C17 的 V2 替代 V1，按导入规格 §8 带 supersedes 导入）
  if (raw.successor_result_schemas !== undefined) {
    if (raw.projection_shape === 'LEGACY_V1') fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.successor_result_schemas:not allowed with LEGACY_V1`);
    const list = c.array(raw, 'successor_result_schemas');
    if (!list.length || !list.every(isText) || list.includes(raw.baseline_result_schema)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.successor_result_schemas:string[] other than baseline_result_schema`);
  }
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
  validateReadings(raw, ref);
  if (raw.m2_rounds !== undefined) validateM2Rounds(raw, ref);
  return deepFreeze(JSON.parse(JSON.stringify(raw)));
}

const M2_READINGS = Object.freeze(['C17_GAP_V1', 'QS_RESULT_V1']);
const M2_COST_KINDS = Object.freeze(['OWN', 'MERGED']);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * CRYPTO_Q0_RESULT_V1 增补 2 §2：加密 M2 轮次（可选键，只有 C17_V2 与 Quick Shot V3 写）。这里只查形状；
 * 文件 sha256、K2 文字与文件数字的一致性由 services/m2-rounds 在导入与读取时核对。
 */
function validateM2Rounds(raw, ref) {
  if (raw.projection_shape === 'LEGACY_V1') fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.m2_rounds:not allowed with LEGACY_V1`);
  const rounds = checker(ref).array(raw, 'm2_rounds');
  if (!rounds.length) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.m2_rounds:non-empty array`);
  const seen = new Set();
  rounds.forEach((spec, i) => {
    const where = `${ref}.m2_rounds[${i}]`;
    if (!isObject(spec)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}:object`);
    const c = checker(where);
    if (!Number.isInteger(spec.round) || spec.round < 1 || seen.has(spec.round)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.round:unique positive integer`);
    seen.add(spec.round);
    if (!ISO_DAY.test(c.text(spec, 'frozen_on'))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.frozen_on:YYYY-MM-DD`);
    if (!M2_READINGS.includes(c.text(spec, 'reading'))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.reading:${M2_READINGS.join('|')}`);
    c.text(spec, 'baseline_result_id'); c.text(spec, 'evidence_dir');
    const files = labelled(spec.files, `${where}.files`, ['role', 'name', 'sha256']);
    files.forEach((file, j) => { if (!SHA256.test(file.sha256)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.files[${j}].sha256:sha256`); });
    if (files.filter((file) => file.role === 'DECOMPOSITION' || file.role === 'RESULT').length !== 1) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.files:exactly one DECOMPOSITION or RESULT`);
    if (files.filter((file) => file.role === 'CANDIDATE_K2').length !== 1) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.files:exactly one CANDIDATE_K2`);
    c.text(c.object(spec, 'decomposition'), 'gap_note_zh');
    const components = c.object(spec, 'components');
    for (const [id, words] of Object.entries(components)) {
      if (!isObject(words) || !isText(words.label_zh) || !(words.treatment_zh === null || isText(words.treatment_zh))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.components.${id}:{label_zh, treatment_zh|null}`);
    }
    const candidate = c.object(spec, 'candidate');
    const cc = checker(`${where}.candidate`);
    ['name_zh', 'scope_zh', 'unchanged_zh', 'history_note_zh', 'btc_note_zh'].forEach((key) => cc.text(candidate, key));
    labelled(candidate.rules, `${where}.candidate.rules`, ['id', 'label_zh', 'text_zh']);
    labelled(candidate.rows, `${where}.candidate.rows`, ['segment', 'label_zh']);
    const forward = c.object(spec, 'forward');
    const cf = checker(`${where}.forward`);
    cf.text(forward, 'observation_id'); cf.text(forward, 'do_title_zh'); cf.text(forward, 'dont_zh');
    if (!ISO_DAY.test(cf.text(forward, 'look_not_before'))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.forward.look_not_before:YYYY-MM-DD`);
    if (!Number.isInteger(forward.min_closed) || forward.min_closed < 1) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.forward.min_closed:positive integer`);
    for (const key of ['plan_zh', 'do_zh', 'extra_zh']) {
      if (!cf.array(forward, key).every(isText)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.forward.${key}:string[]`);
    }
    const cost = c.object(spec, 'cost');
    const cc2 = checker(`${where}.cost`);
    if (!M2_COST_KINDS.includes(cc2.text(cost, 'kind'))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.cost.kind:${M2_COST_KINDS.join('|')}`);
    cc2.text(cost, 'component'); cc2.text(cost, 'open_title_zh');
    (cost.kind === 'OWN' ? ['title_zh', 'frozen_zh', 'why_zh', 'observation_id', 'adoption_zh'] : ['open_note_zh', 'merged_zh']).forEach((key) => cc2.text(cost, key));
  });
}

const SHARED_DISPLAY_ZH = '共享，未复算';
const STRESS_COLUMN_FORMATS = Object.freeze(['PCT', 'INT', 'MONEY']);

/** 数组里每一项都是对象、带齐 keys 里的文字字段；空数组不行。 */
function labelled(list, where, keys) {
  if (!Array.isArray(list) || !list.length) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}:non-empty array`);
  list.forEach((item, i) => {
    if (!isObject(item)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}[${i}]:object`);
    const ci = checker(`${where}[${i}]`);
    keys.forEach((key) => ci.text(item, key));
  });
  return list;
}

/**
 * CRYPTO_Q0_RESULT_V1 增补 1 §1.3 的可选读法键（C17_V2 用；QS 不写，行为不变）：标的说明、压力金额字段、压力另加的列、
 * 允许 simulated:false 的补充行类别、结论区块的补充行、顶层补充臂、停止事件词、R 与概率的小数位、前向子行。
 */
function validateAddendum1(reading, ref) {
  const where = `${ref}.q0_reading`;
  const c = checker(where);
  if (reading.stress_money_field !== undefined) c.text(reading, 'stress_money_field');
  if (reading.stress_columns !== undefined) {
    labelled(reading.stress_columns, `${where}.stress_columns`, ['field', 'label_zh']).forEach((item, i) => {
      if (!STRESS_COLUMN_FORMATS.includes(item.format)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.stress_columns[${i}].format:${STRESS_COLUMN_FORMATS.join('|')}`);
    });
  }
  if (reading.supplementary_kinds !== undefined) c.words(reading, 'supplementary_kinds');
  if (reading.conclusion_supplementary !== undefined) labelled(reading.conclusion_supplementary, `${where}.conclusion_supplementary`, ['scenario', 'label_zh']);
  if (reading.supplementary_arm !== undefined) {
    const arm = c.object(reading, 'supplementary_arm');
    const ca = checker(`${where}.supplementary_arm`);
    ca.text(arm, 'field'); ca.text(arm, 'title_zh');
    labelled(arm.rows, `${where}.supplementary_arm.rows`, ['field', 'label_zh', 'stress_scenario']);
  }
  if (reading.halt_events !== undefined) {
    const halt = c.object(reading, 'halt_events');
    const ch = checker(`${where}.halt_events`);
    ch.words(halt, 'rule_words'); ch.words(halt, 'rule_1b_words');
  }
  if (reading.r_digits !== undefined && ![2, 3].includes(reading.r_digits)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.r_digits:2|3`);
}
const SUCCESSOR_READING_KEYS = Object.freeze(['phase_words', 'phase_note_zh', 'supplementary_kinds', 'supplementary_kind_notes_zh',
  'conclusion_supplementary', 'supersedes_object', 'superseded_note_zh']);
const SUPPLEMENTARY_LINE_FORMS = Object.freeze(['END_ONLY']);

/**
 * CRYPTO_Q0_RESULT_V1 增补 1 冻结说明 2（C17 V2）：按后继结果 schema 取值的读法（successor_readings.<schema>）。
 * 只对那个 schema 的封存文件生效，与档案自身的读法合并；没有这一项的 schema（V1）读法不变。
 */
function validateSuccessorReadings(raw, reading, ref) {
  if (raw.successor_readings === undefined) return;
  const all = checker(ref).object(raw, 'successor_readings');
  for (const [schema, entry] of Object.entries(all)) {
    const where = `${ref}.successor_readings.${schema}`;
    if (!(raw.successor_result_schemas || []).includes(schema)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}:schema 不在 successor_result_schemas`);
    if (!isObject(entry) || !Object.keys(entry).length) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}:non-empty object`);
    const extra = Object.keys(entry).filter((key) => !SUCCESSOR_READING_KEYS.includes(key));
    if (extra.length) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.${extra[0]}:不认识（${SUCCESSOR_READING_KEYS.join('|')}）`);
    const c = checker(where);
    if (entry.phase_words !== undefined) c.words(entry, 'phase_words');
    const phases = { ...raw.phase_words, ...(entry.phase_words || {}) };
    if (!isText(phases[reading.main_row.phase])) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.phase_words.${reading.main_row.phase}:主数字那一行没有对应的词`);
    if (entry.phase_note_zh !== undefined) c.text(entry, 'phase_note_zh');
    if (entry.supplementary_kinds !== undefined) c.words(entry, 'supplementary_kinds');
    if (entry.supplementary_kind_notes_zh !== undefined) {
      const kinds = { ...(reading.supplementary_kinds || {}), ...(entry.supplementary_kinds || {}) };
      for (const kind of Object.keys(c.words(entry, 'supplementary_kind_notes_zh'))) {
        if (!kinds[kind]) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.supplementary_kind_notes_zh.${kind}:不是登记的补充行类别`);
      }
    }
    if (entry.conclusion_supplementary !== undefined) {
      labelled(entry.conclusion_supplementary, `${where}.conclusion_supplementary`, ['scenario', 'label_zh']).forEach((item, i) => {
        if (item.form !== undefined && !SUPPLEMENTARY_LINE_FORMS.includes(item.form)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.conclusion_supplementary[${i}].form:${SUPPLEMENTARY_LINE_FORMS.join('|')}`);
      });
    }
    if (entry.supersedes_object !== undefined && entry.supersedes_object !== true) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.supersedes_object:true`);
    if (entry.superseded_note_zh !== undefined) c.text(entry, 'superseded_note_zh');
  }
}

const hasNumber = (value) => (typeof value === 'number' ? true
  : value && typeof value === 'object' ? Object.values(value).some(hasNumber) : false);

/**
 * CRYPTO_Q0_RESULT_V1 §2.3：按策略取值的 Q0 读法（q0_reading）、共享约束（shared_constraints）与 M1 生产者（m1_evidence.producer）。
 * LEGACY_V1 档案（US_V5）一项都不得带，保证它的读法与输出不变；非 LEGACY 档案必须带 q0_reading。
 */
function validateReadings(raw, ref) {
  const legacy = raw.projection_shape === 'LEGACY_V1';
  if (legacy) {
    for (const key of ['q0_reading', 'shared_constraints']) if (raw[key] !== undefined) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.${key}:not allowed with LEGACY_V1`);
    if (raw.m1_evidence.producer !== undefined) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.m1_evidence.producer:not allowed with LEGACY_V1`);
    return;
  }
  if (raw.m1_evidence.producer !== undefined && !producers.isRegistered(raw.m1_evidence.producer)) {
    fail('DIAGNOSTIC_PRODUCER_NOT_REGISTERED', `${ref}.m1_evidence.producer:${raw.m1_evidence.producer}`);
  }
  const reading = checker(ref).object(raw, 'q0_reading');
  const c = checker(`${ref}.q0_reading`);
  // US_CORE_Q0_RESULT_V1 §2.3.1：主指标形态，缺省按 PER_TRADE_R（Quick Shot 的读法不变）
  const kind = metricKind(reading, ref);
  const main = c.object(reading, 'main_row');
  const cm = checker(`${ref}.q0_reading.main_row`);
  if (main.cost_field !== undefined) cm.text(main, 'cost_field');
  const costWords = c.words(reading, 'cost_words');
  // 主数字那一行的三个键都必须有词，页面才能写出标签
  for (const [key, words] of [['segment', raw.segment_words], ['cost', costWords], ['phase', raw.phase_words]]) {
    if (!Object.prototype.hasOwnProperty.call(words, cm.text(main, key))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.main_row.${key}:${main[key]} 没有对应的词`);
  }
  if (reading.phase_note_zh !== undefined) c.text(reading, 'phase_note_zh');
  const columns = c.array(reading, 'census_columns');
  // 增补 1 §1.3：census_columns 可以是空数组（不读 inputs.census，第 1 块改写标的说明），此时必须带 universe_note_zh
  if (!columns.length && !isText(reading.universe_note_zh)) fail('STRATEGY_PROFILE_FIELD_MISSING', `${ref}.q0_reading.census_columns.*`);
  if (reading.universe_note_zh !== undefined) c.text(reading, 'universe_note_zh');
  columns.forEach((item, i) => {
    if (!isObject(item)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.census_columns[${i}]:object`);
    const cc = checker(`${ref}.q0_reading.census_columns[${i}]`);
    cc.text(item, 'field'); cc.text(item, 'label_zh');
  });
  if (kind === 'PER_TRADE_R') c.text(reading, 'market_g_path'); else validateGapReading(reading, ref);
  const kelly = c.object(reading, 'kelly');
  const ck = checker(`${ref}.q0_reading.kelly`);
  ck.text(kelly, 'floor_field');
  if (kelly.mode !== undefined && !KELLY_MODES.includes(kelly.mode)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.kelly.mode:${KELLY_MODES.join('|')}`);
  if (kind === 'G_GAP' && kelly.mode === undefined) fail('STRATEGY_PROFILE_FIELD_MISSING', `${ref}.q0_reading.kelly.mode`);
  if (kelly.mode === 'NOT_APPLICABLE') validateKellyNotApplicable(kelly, ref);
  else validateKellyFixed(kelly, raw, ref, ck);
  if (kelly.probability_digits !== undefined && ![1, 2].includes(kelly.probability_digits)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.kelly.probability_digits:1|2`);
  validateForward(reading, ref);
  validateDisplay(reading, ref);
  validateAddendum1(reading, ref);
  validateSuccessorReadings(raw, reading, ref);
  if (reading.funding_exclusion !== undefined) {
    const funding = c.object(reading, 'funding_exclusion');
    const cf = checker(`${ref}.q0_reading.funding_exclusion`);
    cf.text(funding, 'count_field'); cf.text(funding, 'share_field'); cf.text(funding, 'rule_ref_zh');
  }
  if (reading.disclosures_zh !== undefined) {
    c.array(reading, 'disclosures_zh').forEach((text, i) => { if (!isText(text)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.disclosures_zh[${i}]:string`); });
  }
  validateShared(raw, ref);
}

/** 半凯利（固定风险臂，QS 的读法）：两臂、阈值、第一个阈值等于档案底线。 */
function validateKellyFixed(kelly, raw, ref, ck) {
  const fixed = ck.object(kelly, 'fixed_arm');
  checker(`${ref}.q0_reading.kelly.fixed_arm`).text(fixed, 'key');
  checker(`${ref}.q0_reading.kelly.fixed_arm`).text(fixed, 'label_zh');
  const thresholds = ck.array(kelly, 'thresholds');
  if (!thresholds.length) fail('STRATEGY_PROFILE_FIELD_MISSING', `${ref}.q0_reading.kelly.thresholds.*`);
  thresholds.forEach((item, i) => {
    if (!isObject(item)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.kelly.thresholds[${i}]:object`);
    const ct = checker(`${ref}.q0_reading.kelly.thresholds[${i}]`);
    ct.text(item, 'field'); ct.number(item, 'value'); ct.text(item, 'label_zh');
  });
  if (thresholds[0].value !== raw.floor.value) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.kelly.thresholds[0].value:${thresholds[0].value}≠floor.value ${raw.floor.value}`);
  if (new Set(thresholds.map((item) => item.field)).size !== thresholds.length) fail('STRATEGY_PROFILE_DUPLICATE', `${ref}.q0_reading.kelly.thresholds.field`);
}

const METRIC_KINDS = Object.freeze(['PER_TRADE_R', 'G_GAP']);
const KELLY_MODES = Object.freeze(['FIXED_RISK', 'NOT_APPLICABLE']);
const FORWARD_KINDS = Object.freeze(['NET', 'EQUITY']);
const REASON_CODE = /^[A-Z][A-Z0-9_]*$/;
const HAS_CHINESE = /[\u4e00-\u9fff]/;
const metricKind = (reading, ref) => {
  if (reading.metric === undefined) return 'PER_TRADE_R';
  const metric = checker(`${ref}.q0_reading`).object(reading, 'metric');
  const kind = checker(`${ref}.q0_reading.metric`).text(metric, 'kind');
  if (!METRIC_KINDS.includes(kind)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.metric.kind:${METRIC_KINDS.join('|')}`);
  if (kind === 'G_GAP' && !Number.isInteger(checker(`${ref}.q0_reading.metric`).number(metric, 'min_months'))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.metric.min_months:integer`);
  return kind;
};

/** US_CORE_Q0_RESULT_V1 §2.3.2：G_GAP 档案的 g 路径（市场与现金各 point/ci、月数）与按持有段的胜率读法。 */
function validateGapReading(reading, ref) {
  const c = checker(`${ref}.q0_reading`);
  const paths = c.object(reading, 'g_paths');
  const cp = checker(`${ref}.q0_reading.g_paths`);
  for (const key of ['market', 'cash']) {
    const item = cp.object(paths, key);
    checker(`${ref}.q0_reading.g_paths.${key}`).text(item, 'point');
    checker(`${ref}.q0_reading.g_paths.${key}`).text(item, 'ci');
  }
  cp.text(paths, 'months');
  const winrate = c.object(reading, 'winrate');
  const cw = checker(`${ref}.q0_reading.winrate`);
  if (cw.text(winrate, 'basis') !== 'EPISODES') fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.winrate.basis:EPISODES`);
  cw.text(winrate, 'tier'); cw.text(winrate, 'label_zh');
  if (winrate.other_tiers !== undefined) {
    cw.array(winrate, 'other_tiers').forEach((item, i) => {
      if (!isObject(item)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.winrate.other_tiers[${i}]:object`);
      checker(`${ref}.q0_reading.winrate.other_tiers[${i}]`).text(item, 'tier');
      checker(`${ref}.q0_reading.winrate.other_tiers[${i}]`).text(item, 'label_zh');
    });
  }
}

/** §2.3.4：半凯利不适用——不得带固定风险臂与阈值；改报的概率字段不重复。 */
function validateKellyNotApplicable(kelly, ref) {
  for (const key of ['fixed_arm', 'thresholds']) if (kelly[key] !== undefined) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.kelly.${key}:not allowed with NOT_APPLICABLE`);
  const probabilities = checker(`${ref}.q0_reading.kelly`).array(kelly, 'probabilities');
  if (!probabilities.length) fail('STRATEGY_PROFILE_FIELD_MISSING', `${ref}.q0_reading.kelly.probabilities.*`);
  probabilities.forEach((item, i) => {
    if (!isObject(item)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.kelly.probabilities[${i}]:object`);
    const cp = checker(`${ref}.q0_reading.kelly.probabilities[${i}]`);
    cp.text(item, 'field'); cp.text(item, 'label_zh');
  });
  if (new Set(probabilities.map((item) => item.field)).size !== probabilities.length) fail('STRATEGY_PROFILE_DUPLICATE', `${ref}.q0_reading.kelly.probabilities.field`);
  if (kelly.events !== undefined) {
    const events = checker(`${ref}.q0_reading.kelly`).object(kelly, 'events');
    checker(`${ref}.q0_reading.kelly.events`).text(events, 'path');
    checker(`${ref}.q0_reading.kelly.events`).text(events, 'label_zh');
  }
}

/** 前向行：NET（QS：笔数、净额、每笔 R）或 EQUITY（US_CORE：起止权益与收益）。 */
function validateForward(reading, ref) {
  if (reading.forward === undefined) return;
  const forward = checker(`${ref}.q0_reading`).object(reading, 'forward');
  const cf = checker(`${ref}.q0_reading.forward`);
  const kind = forward.kind === undefined ? 'NET' : forward.kind;
  if (!FORWARD_KINDS.includes(kind)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.forward.kind:${FORWARD_KINDS.join('|')}`);
  if (kind === 'NET') cf.text(forward, 'net_field'); else cf.text(forward, 'ledger_field');
  if (forward.ledger_must_equal_strategy_ref !== true) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.forward.ledger_must_equal_strategy_ref:true`);
  if (forward.sub_rows !== undefined) labelled(forward.sub_rows, `${ref}.q0_reading.forward.sub_rows`, ['field', 'label_zh']);
}

/** §2.3.5–§2.3.8：A0 两种读法、风控高亮、样本外复用、原因词与场景名、参照臂与开发期账户路径。 */
function validateDisplay(reading, ref) {
  const c = checker(`${ref}.q0_reading`);
  if (reading.a0 !== undefined) {
    const a0 = c.object(reading, 'a0');
    if (a0.dual_reading !== true) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.a0.dual_reading:true`);
    if (!SHA256.test(checker(`${ref}.q0_reading.a0`).text(a0, 'ruling_sha256'))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.a0.ruling_sha256:sha256`);
    checker(`${ref}.q0_reading.a0`).text(a0, 'literal_note_zh');
  }
  if (reading.highlights !== undefined) {
    const highlights = c.array(reading, 'highlights');
    if (highlights.length > 2) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.highlights:at most 2`);
    highlights.forEach((item, i) => {
      if (!isObject(item)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.highlights[${i}]:object`);
      const ch = checker(`${ref}.q0_reading.highlights[${i}]`);
      ch.text(item, 'key'); ch.text(item, 'label_zh');
      if (!/^RISK_/.test(ch.text(item, 'scenario'))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.highlights[${i}].scenario:RISK_*`);
      if (item.diagnosis_id !== undefined) ch.text(item, 'diagnosis_id');
      // US_CORE 冻结说明 1：标题里的近似说明与缺口一行的封存日期前缀（可选，只写文字）
      if (item.approximation_note_zh !== undefined) ch.text(item, 'approximation_note_zh');
      if (item.gap_as_of_zh !== undefined) ch.text(item, 'gap_as_of_zh');
      // US_CORE 冻结说明 2：总览一句话与数字卡用的近似短句（可选，只写文字）
      if (item.approximation_short_zh !== undefined) ch.text(item, 'approximation_short_zh');
    });
    if (new Set(highlights.map((item) => item.key)).size !== highlights.length) fail('STRATEGY_PROFILE_DUPLICATE', `${ref}.q0_reading.highlights.key`);
  }
  if (reading.oos_reuse !== undefined) {
    const reuse = c.object(reading, 'oos_reuse');
    if (!REASON_CODE.test(checker(`${ref}.q0_reading.oos_reuse`).text(reuse, 'reason_code'))) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.oos_reuse.reason_code:CODE`);
    checker(`${ref}.q0_reading.oos_reuse`).text(reuse, 'text_zh');
  }
  if (reading.reason_words_zh !== undefined) {
    for (const [code, text] of Object.entries(c.object(reading, 'reason_words_zh'))) {
      if (!REASON_CODE.test(code) || !isText(text)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.reason_words_zh.${code}`);
    }
  }
  if (reading.scenario_words_zh !== undefined) {
    for (const [id, text] of Object.entries(c.object(reading, 'scenario_words_zh'))) {
      if (!isText(text) || !HAS_CHINESE.test(text)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.scenario_words_zh.${id}:中文`);
    }
  }
  if (reading.reference_arms !== undefined && typeof reading.reference_arms !== 'boolean') fail('STRATEGY_PROFILE_FIELD_TYPE', `${ref}.q0_reading.reference_arms:boolean`);
  if (reading.dev_arms_path !== undefined) c.text(reading, 'dev_arms_path');
}

function validateShared(raw, ref) {
  if (raw.shared_constraints === undefined) return;
  checker(ref).array(raw, 'shared_constraints').forEach((item, i) => {
    const where = `${ref}.shared_constraints[${i}]`;
    if (!isObject(item)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}:object`);
    // §10：共享约束只写文字，任何数字都不得出现（一条策略的数字不进另一条策略的页面，R3.3）
    if (hasNumber(item)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}:no numbers`);
    const cs = checker(where);
    cs.text(item, 'key'); cs.text(item, 'label_zh');
    // CRYPTO 增补 1 冻结说明 1 第 2 条：桶级规则只写一句原文（text_zh，含「共享，未复算」），没有规则清单里的对应条目时不写 rule_ref
    if (item.text_zh !== undefined) {
      if (!cs.text(item, 'text_zh').includes(SHARED_DISPLAY_ZH)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.text_zh:must contain ${SHARED_DISPLAY_ZH}`);
      if (item.rule_ref !== undefined) cs.text(item, 'rule_ref');
    } else cs.text(item, 'rule_ref');
    const peers = cs.array(item, 'peers');
    if (!peers.length || !peers.every(isText)) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.peers:string[]`);
    if (cs.text(item, 'display_zh') !== SHARED_DISPLAY_ZH) fail('STRATEGY_PROFILE_FIELD_TYPE', `${where}.display_zh:${SHARED_DISPLAY_ZH}`);
  });
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
  unique('baseline_result_schema', profiles.flatMap(resultSchemasOf));
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
/** 档案认的全部 Q0 结果 schema：主 schema 加后继 schema（冻结说明 1 第 1 条）。 */
function resultSchemasOf(profile) { return [profile.baseline_result_schema, ...(profile.successor_result_schemas || [])]; }
const byBaselineSchema = (schema) => (schema ? find((item) => resultSchemasOf(item).includes(schema)) : null);
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

/**
 * 增补 1 冻结说明 2：封存文件是后继 schema、档案为它登记了 successor_readings 时，返回合并了那份读法的档案
 * （phase_words 与 supplementary_kinds 按键合并，其余键覆盖 q0_reading 的同名键）；否则原样返回档案本身。
 */
const effective = new WeakMap();
function forSchema(profile, schema) {
  const entry = profile && profile.successor_readings && schema ? profile.successor_readings[schema] : undefined;
  if (!entry) return profile;
  if (!effective.has(profile)) effective.set(profile, new Map());
  const cache = effective.get(profile);
  if (!cache.has(schema)) {
    const { phase_words: phaseWords, supplementary_kinds: kinds, ...rest } = entry;
    const reading = { ...profile.q0_reading, ...rest, ...(kinds ? { supplementary_kinds: { ...(profile.q0_reading.supplementary_kinds || {}), ...kinds } } : {}) };
    cache.set(schema, deepFreeze(JSON.parse(JSON.stringify({ ...profile, phase_words: { ...profile.phase_words, ...(phaseWords || {}) }, q0_reading: reading }))));
  }
  return cache.get(schema);
}

module.exports = {
  FILE, CONTRACT, CURRENCIES, StrategyProfileError, validate, load, use, list, get, mustGet, byCase, byBaselineSchema, resultSchemasOf,
  byComparisonProfile, defaultProfile, isLegacyShape, comparator, comparatorLabel, forSchema,
};
