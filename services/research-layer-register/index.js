'use strict';

/**
 * 研究题的层登记（QRP_RESEARCH_LAYER_REGISTER_V1；三层分工合同 V1 §2.1，Owner 2026-11-08）。
 *
 * 事实来源是 `config/research_layer_register.v1.json`。本模块只读、只校验，并回答「这道题属于哪一层」：
 *   - layers：合同 §1 的三层（RISK、SELECTION_TIMING、ACCOUNT）、Note 2 §1 的四个标签（DIAGNOSTIC_BASELINE、DIAGNOSTIC、
 *     NA_ENGINEERING、NA_EXECUTION）和 UNDECIDED，八个代码一个不多一个不少；
 *   - contract_ref：合同正文与 Note 1、Note 2 的路径和 sha256；
 *   - entries：一题一条，strategy_ref + id 对上页面里的研究题；reason_zh 一行并写明节号；
 *     deviations（可选）只挂合同登记过的不符项（D1、D11……），页面在该题旁写一条小注。
 * 没有登记的题返回占位「待交付 · 层登记」，code = null，不猜。
 * 字段缺失或类型不符，require 时就抛出，进程不继续（与 ashare-research-modules 等登记相同）。
 * 页面只排版：层、计数和那一行字都由这里给出。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'config', 'research_layer_register.v1.json');
const CONTRACT = 'QRP_RESEARCH_LAYER_REGISTER_V1';
const CONTRACT_PATH = 'artifacts/coordinator/THREE_LAYER_STRATEGY_FRAMEWORK_V1_FREEZE_1.md';
const CONTRACT_SHA_PREFIX = 'a5437476';
/** 合同 §1 的三层 + Note 2 §1 的四个标签 + 待定；计数行按这个顺序写。 */
const LAYER_CODES = Object.freeze(['SELECTION_TIMING', 'RISK', 'ACCOUNT', 'DIAGNOSTIC_BASELINE', 'DIAGNOSTIC', 'NA_ENGINEERING', 'NA_EXECUTION', 'UNDECIDED']);
const CONTRACT_LAYERS = Object.freeze(['RISK', 'SELECTION_TIMING', 'ACCOUNT']);
const NOTE_TAGS = Object.freeze(['DIAGNOSTIC_BASELINE', 'DIAGNOSTIC', 'NA_ENGINEERING', 'NA_EXECUTION']);
/** 合同的补充页：按 id 要求登记路径与 sha256 前缀（Note 2 定了四个标签与读法，没有它层集合不成立）。 */
const NOTES = Object.freeze({
  NOTE_1: Object.freeze({ path: 'artifacts/coordinator/THREE_LAYER_STRATEGY_FRAMEWORK_V1_FREEZE_1_NOTE_1.md', sha_prefix: '04e8259d' }),
  NOTE_2: Object.freeze({ path: 'artifacts/coordinator/THREE_LAYER_STRATEGY_FRAMEWORK_V1_FREEZE_1_NOTE_2.md', sha_prefix: 'b61b051f' }),
});
const PENDING_LABEL = '待交付 · 层登记';
const SHA64 = /^[0-9a-f]{64}$/;

class ResearchLayerRegisterError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new ResearchLayerRegisterError(code, detail); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const text = (object, key, where) => { if (!isText(object[key])) fail('RESEARCH_LAYER_FIELD', `${where}.${key}`); return object[key]; };
const keyOf = (strategyRef, id) => `${strategyRef}\u0000${id}`;

function validate(doc) {
  if (!isObject(doc) || doc.contract !== CONTRACT) fail('RESEARCH_LAYER_CONTRACT_INVALID', doc && doc.contract);
  const ref = doc.contract_ref;
  if (!isObject(ref) || ref.path !== CONTRACT_PATH) fail('RESEARCH_LAYER_FIELD', 'contract_ref.path');
  if (!SHA64.test(ref.sha256 || '') || !ref.sha256.startsWith(CONTRACT_SHA_PREFIX)) fail('RESEARCH_LAYER_FIELD', 'contract_ref.sha256');
  if (!Array.isArray(ref.notes)) fail('RESEARCH_LAYER_FIELD', 'contract_ref.notes');
  for (const [id, want] of Object.entries(NOTES)) {
    const note = ref.notes.find((item) => isObject(item) && item.id === id);
    if (!note || note.path !== want.path || !SHA64.test(note.sha256 || '') || !note.sha256.startsWith(want.sha_prefix)) fail('RESEARCH_LAYER_FIELD', `contract_ref.notes.${id}`);
  }
  const layers = doc.layers;
  if (!isObject(layers)) fail('RESEARCH_LAYER_FIELD', 'layers');
  const codes = Object.keys(layers);
  if (codes.length !== LAYER_CODES.length || !LAYER_CODES.every((code) => codes.includes(code))) fail('RESEARCH_LAYER_SET', codes.join('|'));
  for (const code of codes) {
    if (!isObject(layers[code])) fail('RESEARCH_LAYER_FIELD', `layers.${code}`);
    text(layers[code], 'label_zh', `layers.${code}`);
  }
  if (!Array.isArray(doc.entries) || !doc.entries.length) fail('RESEARCH_LAYER_FIELD', 'entries');
  const seen = new Set();
  doc.entries.forEach((entry, i) => {
    const where = `entries[${i}]`;
    if (!isObject(entry)) fail('RESEARCH_LAYER_FIELD', where);
    for (const key of ['strategy_ref', 'id', 'layer', 'reason_zh', 'classified_by']) text(entry, key, where);
    if (!LAYER_CODES.includes(entry.layer)) fail('RESEARCH_LAYER_UNKNOWN', `${where}.layer:${entry.layer}`);
    if (entry.deviations !== undefined) {
      if (!Array.isArray(entry.deviations) || !entry.deviations.length) fail('RESEARCH_LAYER_FIELD', `${where}.deviations`);
      entry.deviations.forEach((item, j) => {
        if (!isObject(item) || !/^D\d+$/.test(item.ref || '')) fail('RESEARCH_LAYER_FIELD', `${where}.deviations[${j}].ref`);
        text(item, 'label_zh', `${where}.deviations[${j}]`); text(item, 'note_zh', `${where}.deviations[${j}]`);
      });
    }
    // 一行，并写明对应合同的哪一节
    if (/[\r\n]/.test(entry.reason_zh) || !/§\d/.test(entry.reason_zh)) fail('RESEARCH_LAYER_FIELD', `${where}.reason_zh`);
    const key = keyOf(entry.strategy_ref, entry.id);
    if (seen.has(key)) fail('RESEARCH_LAYER_DUPLICATE', `${entry.strategy_ref}/${entry.id}`);
    seen.add(key);
  });
  return deepFreeze(JSON.parse(JSON.stringify(doc)));
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

const REGISTER = validate(JSON.parse(fs.readFileSync(FILE, 'utf8')));

function indexOf(register) {
  return new Map(register.entries.map((entry) => [keyOf(entry.strategy_ref, entry.id), entry]));
}
const INDEX = indexOf(REGISTER);

/** 占位：没有登记的题。code 为 null，页面照写这几个字。 */
const pending = () => ({ code: null, label_zh: PENDING_LABEL, registered: false });

/** 这道题的层：{ code, label_zh, registered: true, reason_zh, classified_by }；没登记返回占位。 */
function layerOf(strategyRef, id, register = REGISTER) {
  const index = register === REGISTER ? INDEX : indexOf(register);
  const entry = strategyRef && id ? index.get(keyOf(strategyRef, id)) : null;
  if (!entry) return pending();
  return {
    code: entry.layer, label_zh: register.layers[entry.layer].label_zh, registered: true,
    reason_zh: entry.reason_zh, classified_by: entry.classified_by,
    // 只挂在合同登记过不符项的题上（没有时不加这个键）
    ...(entry.deviations ? { deviations: entry.deviations.map((item) => ({ ref: item.ref, label_zh: item.label_zh, note_zh: item.note_zh })) } : {}),
  };
}

/** 按层计数（同一 strategy_ref + id 只算一次）。items：[{ strategy_ref, id, layer }]。 */
function countsOf(items) {
  const seen = new Set();
  const counts = Object.fromEntries([...LAYER_CODES, 'PENDING'].map((code) => [code, 0]));
  for (const item of items) {
    const key = keyOf(item.strategy_ref, item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    counts[item.layer && item.layer.code ? item.layer.code : 'PENDING'] += 1;
  }
  return { total: seen.size, ...counts };
}

/**
 * 计数行：「研究按层（共 N 题，含详情页）：选股择时 N · 风控 N · 账户 N · 诊断（全策略基线） N · 诊断 N · 不适用（工程） N ·
 * 不适用（执行） N · 待定 N」，有未登记的题再加「· 待交付层登记 N」。
 */
function countsLine(counts, register = REGISTER) {
  const parts = LAYER_CODES.map((code) => `${register.layers[code].label_zh} ${counts[code]}`);
  if (counts.PENDING) parts.push(`待交付层登记 ${counts.PENDING}`);
  return `研究按层（共 ${counts.total} 题，含详情页）：${parts.join(' · ')}`;
}

module.exports = {
  FILE, CONTRACT, CONTRACT_PATH, CONTRACT_SHA_PREFIX, LAYER_CODES, CONTRACT_LAYERS, NOTE_TAGS, NOTES, PENDING_LABEL, REGISTER,
  validate, layerOf, countsOf, countsLine, ResearchLayerRegisterError,
};
