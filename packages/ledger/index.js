'use strict';
/**
 * 平台共享台账内核 —— append-only JSONL + 内容哈希。
 * 迁移自 Ashare-V5 services/phase2/* 各模块内联的 _hash/_append/_read/_heads(收敛为单一实现,禁分叉)。
 *
 * 铁律:
 *   - 台账 append-only;修正 = 追加新行,不改历史行;
 *   - 内容哈希(sha256 前 16 位)用于冻结域校验与幂等键;
 *   - 数据目录可用 QRP_DATA_DIR 覆盖(测试隔离用)。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

function dataDir(...sub) {
  const base = process.env.QRP_DATA_DIR || path.join(ROOT, 'var', 'ledger');
  return path.join(base, ...sub);
}

function hash(o) { return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16); }
function now() { return new Date().toISOString(); }

/** 进程内单调 uid(时间戳+序号)—— 供 ID 生成种子,杜绝同毫秒内容哈希碰撞。 */
let _seq = 0;
function uid() { return `${Date.now().toString(36)}-${(_seq++).toString(36)}`; }

/**
 * 入账即校验(§18 Contract / Fail Closed)。
 *
 * 审计发现:此前只有离线 `schemas/validate.js` 事后扫描,写入路径本身零校验 ——
 * 适配器返回畸形对象(甚至 Promise)会被静默写进台账。现在:
 *   - 带 schema 且**已登记** → 必须通过字段/类型校验,否则抛错,绝不落盘;
 *   - 带 schema 但**未登记** → 抛错(未登记域对象不得混入台账);
 *   - 不带 schema → 视为适配器自有的市场原始数据(如日线 bar),放行。
 * schemas 只依赖纯常量,不回依赖 ledger —— 无循环 require。
 */
function _assertContract(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('LEDGER_RECORD_NOT_OBJECT');
  if (typeof rec.then === 'function') throw new Error('LEDGER_RECORD_IS_PROMISE(适配器返回值必须先 await)');
  if (!rec.schema) return;
  // 延迟 require:schemas 目录属平台合同层,ledger 是其下游
  const { SCHEMAS, validateRecord } = require('../../schemas');
  if (!SCHEMAS[rec.schema]) throw new Error(`LEDGER_UNKNOWN_SCHEMA:${rec.schema}`);
  const v = validateRecord(rec, rec.schema);
  if (!v.ok) throw new Error(`LEDGER_SCHEMA_VIOLATION:${rec.schema}:${v.problems.join(',')}`);
}

function append(file, rec) {
  _assertContract(rec);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  return rec;
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** 取每个 id 的最新行(head)。 */
function heads(rows, idKey) {
  const m = new Map();
  for (const r of rows) if (r[idKey]) m.set(r[idKey], r);
  return m;
}

module.exports = { ROOT, dataDir, hash, now, uid, append, read, heads, _assertContract };
