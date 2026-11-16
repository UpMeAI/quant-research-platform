'use strict';

/**
 * KG 数据集登记表的 QRP 钉版 —— RESEARCH_LIVE_PARITY_V1 ★5 (a)（Owner 2026-11-17 00:23 签字：签字页 f0fe8e5c，签字文本 ceb35505）。
 *
 * 同 V6、smartflow：登记表 data/registry/datasets.v1.json 与扫描器 scripts/registry/dataset-registry-scan.cjs 从 KG 的一个提交原样拷到
 * config/dataset-registry/，按 PIN.json 的 sha256 钉住；PIN 与生产两端（V6、smartflow）钉的同一个提交、同一组 sha256。
 * 读的时候逐个文件复验 sha256，漂移、缺文件、登记表版本与 PIN 不符都失败即关（DATASET_REGISTRY_*）。G-PARITY 以这里为「生产的 PIN」。
 * 重钉：tools/dataset-registry-repin/repin.js（从 KG 新提交拷两个文件、改 PIN.json，并把换下来的那一份挪进 history/）。
 *
 * 历史（协调会话 2026-11-17 01:2x 裁定）：每一份钉过的登记表都按 sha 留在 history/<版本>-<sha 前 8 位>/（datasets.v1.json 与扫描器），
 * history/HISTORY.json 列出它们与 sha256；读的时候同样逐个文件复验。G-PARITY 用它放行按旧版本写的 DATA 记号：
 * 记号的 @版本#sha 在历史里，且这个数据集的一致性字段（FINGERPRINT_FIELDS）从那一版到现在没变（那一版没有或为 null 的字段不算变）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'config', 'dataset-registry');
const REGISTRY_FILE = 'datasets.v1.json';
const SCANNER_FILE = 'dataset-registry-scan.cjs';
/** 登记表级的新 PIT 语义清单（KG 1.13.0 起有；G-PARITY 认它登记的新值）。 */
const REGISTRY_PIT_LIST_FIELD = 'pitSemantics';
const HISTORY_DIR = 'history';
const HISTORY_FILE = 'HISTORY.json';
const HISTORY_SCHEMA = 'DATASET_REGISTRY_HISTORY_V1';
/** 数据集的一致性字段（裁定第 1 条）：从记号的版本到现在，这些字段（那一版写了的）不能变。producedBy 没有时取 producer。 */
// pitSemanticsBySeries：KG 1.14.0 起的混合数据集（协调会话 2026-11-17 裁定）；旧版本没有不算变
// pitHistoricalClock：KG 1.14.0 起（协调会话审阅意见 2026-11-17），只比 rule 与 bySeries，detail 的文字不算
const FINGERPRINT_FIELDS = Object.freeze(['id', 'owner', 'producedBy', 'pitSemantics', 'vendor', 'priceBasis', 'pitSemanticsBySeries', 'pitHistoricalClock']);

class DatasetRegistryError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new DatasetRegistryError(`DATASET_REGISTRY_${code}`, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const absent = (v) => v === undefined || v === null;
/** 规范 JSON（键排序）：比较字段值用，对象键的顺序不算变。 */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * 读 QRP 钉住的登记表（每次都复验字节）。
 * @param {{dir?: string}} [o] 只给测试用：换一个目录（例如漂移的副本）
 */
function pinned({ dir = DIR } = {}) {
  const pinFile = path.join(dir, 'PIN.json');
  need(fs.existsSync(pinFile), 'FILE_MISSING', 'PIN.json');
  let pin;
  try { pin = JSON.parse(fs.readFileSync(pinFile, 'utf8')); } catch { return fail('PIN_INVALID', 'NOT_JSON'); }
  need(pin && /^[0-9a-f]{40}$/.test(pin.commit || '') && pin.files && /^[0-9a-f]{64}$/.test(pin.files[REGISTRY_FILE] || '') && typeof pin.registry_version === 'string',
    'PIN_INVALID', dir);
  const bytes = {};
  for (const [file, hash] of Object.entries(pin.files)) {
    const f = path.join(dir, file);
    need(fs.existsSync(f), 'FILE_MISSING', file);
    const b = fs.readFileSync(f);
    need(sha256(b) === hash, 'PIN_DRIFT', file);
    bytes[file] = b;
  }
  const registry = JSON.parse(bytes[REGISTRY_FILE].toString('utf8'));
  need(registry.version === pin.registry_version, 'VERSION_MISMATCH', `${registry.version}≠${pin.registry_version}`);
  need(Array.isArray(registry.datasets), 'PIN_INVALID', 'datasets');
  const datasets = new Map(registry.datasets.map((d) => [d.id, d]));
  need(datasets.size === registry.datasets.length, 'DATASET_DUPLICATE', dir);
  return Object.freeze({
    repository: pin.repository, commit: pin.commit, registry_version: pin.registry_version, registry_sha256: pin.files[REGISTRY_FILE],
    datasets, registry, pit_semantics: Array.isArray(registry[REGISTRY_PIT_LIST_FIELD]) ? [...registry[REGISTRY_PIT_LIST_FIELD]] : [],
    production_pins: Array.isArray(pin.production_pins) ? pin.production_pins : [],
  });
}

/** 读一份登记表副本（目录里的 datasets.v1.json 与扫描器，按给定的 sha256 复验）。 */
function readCopy(dir, files, version, where) {
  const bytes = {};
  for (const [file, hash] of Object.entries(files)) {
    const f = path.join(dir, file);
    need(fs.existsSync(f), 'FILE_MISSING', `${where}:${file}`);
    const b = fs.readFileSync(f);
    need(sha256(b) === hash, 'PIN_DRIFT', `${where}:${file}`);
    bytes[file] = b;
  }
  const registry = JSON.parse(bytes[REGISTRY_FILE].toString('utf8'));
  need(registry.version === version, 'VERSION_MISMATCH', `${where}:${registry.version}≠${version}`);
  const datasets = new Map(registry.datasets.map((d) => [d.id, d]));
  need(datasets.size === registry.datasets.length, 'DATASET_DUPLICATE', where);
  return { registry, datasets };
}

/**
 * 钉过的登记表的历史：Map「版本#sha256」→ { registry_version, registry_sha256, commit, dir, datasets, registry, pit_semantics }。
 * 每份副本逐个文件复验；HISTORY.json 缺了即失败即关（历史从 1.11.0 起就在）。
 */
function history({ dir = DIR } = {}) {
  const file = path.join(dir, HISTORY_DIR, HISTORY_FILE);
  need(fs.existsSync(file), 'FILE_MISSING', `${HISTORY_DIR}/${HISTORY_FILE}`);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fail('HISTORY_INVALID', 'NOT_JSON'); }
  need(doc && doc.schema === HISTORY_SCHEMA && Array.isArray(doc.entries), 'HISTORY_INVALID', file);
  const out = new Map();
  for (const e of doc.entries) {
    need(e && typeof e.version === 'string' && /^[0-9a-f]{40}$/.test(e.commit || '') && e.files && /^[0-9a-f]{64}$/.test(e.files[REGISTRY_FILE] || '')
      && e.dir === `${e.version}-${e.files[REGISTRY_FILE].slice(0, 8)}`, 'HISTORY_INVALID', JSON.stringify(e && e.dir));
    // 扫描器的 sha256 每条必填（协调会话 2026-11-17 02:0x；1.11.0 那条本来就带）
    need(/^[0-9a-f]{64}$/.test(e.files[SCANNER_FILE] || ''), 'HISTORY_INVALID', `${e.dir}:${SCANNER_FILE} sha256 missing`);
    const key = `${e.version}#${e.files[REGISTRY_FILE]}`;
    need(!out.has(key), 'HISTORY_INVALID', `duplicate ${key}`);
    const copy = readCopy(path.join(dir, HISTORY_DIR, e.dir), e.files, e.version, `${HISTORY_DIR}/${e.dir}`);
    out.set(key, Object.freeze({ registry_version: e.version, registry_sha256: e.files[REGISTRY_FILE], commit: e.commit, dir: e.dir, ...copy,
      pit_semantics: Array.isArray(copy.registry[REGISTRY_PIT_LIST_FIELD]) ? [...copy.registry[REGISTRY_PIT_LIST_FIELD]] : [] }));
  }
  return out;
}

/** 一份登记表有没有某个数据集字段（任何一个数据集带这个键，哪怕值是 null）。 */
const hasField = (reg, field) => [...reg.datasets.values()].some((e) => e && Object.prototype.hasOwnProperty.call(e, field));

/** 数据集从旧版本到现在变了哪些一致性字段：旧版本没有或为 null 的字段不算变。 */
function changedFields(older, current) {
  const clock = (c) => (c && typeof c === 'object' ? { rule: c.rule ?? null, bySeries: c.bySeries ?? null } : c);
  const value = (e, f) => (f === 'producedBy' ? (e.producedBy !== undefined ? e.producedBy : e.producer) : f === 'pitHistoricalClock' ? clock(e[f]) : e[f]);
  return FINGERPRINT_FIELDS.filter((f) => !absent(value(older, f)) && canonical(value(older, f)) !== canonical(value(current, f)));
}

module.exports = { DIR, REGISTRY_FILE, SCANNER_FILE, REGISTRY_PIT_LIST_FIELD, HISTORY_DIR, HISTORY_FILE, HISTORY_SCHEMA, FINGERPRINT_FIELDS, DatasetRegistryError,
  pinned, history, hasField, changedFields, internals: { readCopy, canonical } };
