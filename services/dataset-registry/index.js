'use strict';

/**
 * KG 数据集登记表的 QRP 钉版 —— RESEARCH_LIVE_PARITY_V1 ★5 (a)（Owner 2026-11-17 00:23 签字：签字页 f0fe8e5c，签字文本 ceb35505）。
 *
 * 同 V6、smartflow：登记表 data/registry/datasets.v1.json 与扫描器 scripts/registry/dataset-registry-scan.cjs 从 KG 的一个提交原样拷到
 * config/dataset-registry/，按 PIN.json 的 sha256 钉住；PIN 与生产两端（V6、smartflow）钉的同一个提交、同一组 sha256。
 * 读的时候逐个文件复验 sha256，漂移、缺文件、登记表版本与 PIN 不符都失败即关（DATASET_REGISTRY_*）。G-PARITY 以这里为「生产的 PIN」。
 * 重钉：从 KG 新提交拷两个文件，改 PIN.json 的 commit、sha256、registry_version 与 production_pins。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'config', 'dataset-registry');
const REGISTRY_FILE = 'datasets.v1.json';
/** 登记表级的新 PIT 语义清单（KG 还没有这个字段；有了以后 G-PARITY 认它登记的新值）。 */
const REGISTRY_PIT_LIST_FIELD = 'pitSemantics';

class DatasetRegistryError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new DatasetRegistryError(`DATASET_REGISTRY_${code}`, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

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

module.exports = { DIR, REGISTRY_FILE, REGISTRY_PIT_LIST_FIELD, DatasetRegistryError, pinned };
