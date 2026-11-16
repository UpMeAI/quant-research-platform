'use strict';

/**
 * MINING_SPACE_V1 —— 每轮开跑前冻结的搜索空间（研究框架修订 2026-11-16 §3.2；P1）。
 *
 *   { schema: 'MINING_SPACE_V1', space_ref, market, readings: [{ name, dataset_id, pit_available_at }], operators: [白名单子集],
 *     constants: [数…], lookbacks: [1…250 的整数…], holding_periods: [交易日…], max_tokens: ≤ 20, max_depth: ≤ 5,
 *     operator_evidence: { path, sha256 } }
 *
 * - 读数只用已登记的（dataset_id 在钉住的数据集登记表里，pit_available_at 以登记表的 PIT 记号开头；混合数据集写 series），每个写 PIT 可得时刻；算子是 DSL 白名单的子集，且每个都在绑定的因果证据里（CAUSALITY_EVIDENCE_V1，role FEATURE，
 *   T-C1、T-C2、T-C3 全 PASS）——「新增算子要先证」；回看 ≤ 250；记号 ≤ 20、嵌套 ≤ 5 只能收紧不能放宽。
 * - 冻结：清单字节的 sha256 写进冻结页（页上写出 sha256、MINING_SPACE_V1 与 FROZEN）；台账行与轮次清单引用这个 sha。轮中改空间就是新的一轮。
 * 错误码 MINE_SPACE_*；只读、不写。
 */
const crypto = require('crypto');
const dsl = require('./dsl');
const { validateRecord } = require('../../schemas');

const SCHEMA = 'MINING_SPACE_V1';
const MARKETS = Object.freeze(['CN_A', 'US', 'CRYPTO']);
const SHA64 = /^[0-9a-f]{64}$/;
const OPERATORS_PATH = 'qrp:services/mining-sandbox/evaluator/operators.js';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

class SpaceError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new SpaceError(`MINE_SPACE_${code}`, detail); };
const need = (c, code, detail) => { if (!c) fail(code, detail); };
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 解析并核对一份搜索空间。
 * @param {Buffer} bytes
 * @param {{evidence: {functions: Array<{function_id: string, role?: string, t_c1: string, t_c2: string, t_c3: string}>}, evidenceBytes: Buffer}} proof
 *   绑定的算子因果证据（解析好的对象与原始字节；字节的 sha256 必须等于 operator_evidence.sha256）
 */
function parseSpace(bytes, proof, { registry = null } = {}) {
  need(Buffer.isBuffer(bytes), 'BYTES_MISSING');
  let s;
  try { s = JSON.parse(bytes.toString('utf8')); } catch { return fail('NOT_JSON'); }
  need(s && s.schema === SCHEMA && isText(s.space_ref), 'SCHEMA_INVALID');
  const v = validateRecord(s, SCHEMA);
  need(v.ok, 'SCHEMA_INVALID', v.problems.join(','));
  need(MARKETS.includes(s.market), 'MARKET_INVALID', s.market);
  need(Array.isArray(s.readings) && s.readings.length, 'READINGS_MISSING');
  const names = new Set();
  const reg = registry || require('../dataset-registry').pinned();
  for (const r of s.readings) {
    need(r && /^[a-z][a-z0-9_]*$/.test(r.name || '') && isText(r.dataset_id) && isText(r.pit_available_at) && (r.series === undefined || isText(r.series)), 'READING_INVALID', JSON.stringify(r));
    need(!Object.prototype.hasOwnProperty.call(dsl.OPERATORS, r.name), 'READING_SHADOWS_OPERATOR', r.name);
    need(!names.has(r.name), 'READING_DUPLICATE', r.name); names.add(r.name);
    checkReadingRegistered(r, reg);
  }
  need(Array.isArray(s.operators) && s.operators.length, 'OPERATORS_MISSING');
  for (const o of s.operators) need(Object.prototype.hasOwnProperty.call(dsl.OPERATORS, o), 'OPERATOR_NOT_WHITELISTED', o);
  need(Array.isArray(s.constants) && s.constants.every(isNum), 'CONSTANTS_INVALID');
  need(Array.isArray(s.lookbacks) && s.lookbacks.length && s.lookbacks.every((n) => Number.isInteger(n) && n >= 1 && n <= dsl.MAX_LOOKBACK), 'LOOKBACKS_INVALID');
  need(Array.isArray(s.holding_periods) && s.holding_periods.length && s.holding_periods.every((n) => Number.isInteger(n) && n >= 1), 'HOLDING_PERIODS_INVALID');
  need(Number.isInteger(s.max_tokens) && s.max_tokens >= 1 && s.max_tokens <= dsl.MAX_TOKENS, 'MAX_TOKENS_INVALID', s.max_tokens);
  need(Number.isInteger(s.max_depth) && s.max_depth >= 1 && s.max_depth <= dsl.MAX_DEPTH, 'MAX_DEPTH_INVALID', s.max_depth);
  // 新增算子要先证：每个算子在绑定的证据里，role FEATURE，三项全 PASS
  need(s.operator_evidence && isText(s.operator_evidence.path) && SHA64.test(s.operator_evidence.sha256 || ''), 'OPERATOR_EVIDENCE_MISSING');
  need(proof && Buffer.isBuffer(proof.evidenceBytes) && sha256(proof.evidenceBytes) === s.operator_evidence.sha256, 'OPERATOR_EVIDENCE_SHA_MISMATCH');
  // 证据的函数是 qrp:services/mining-sandbox/evaluator/operators.js#ROWS.<算子>（求值器与证据测的是同一份实现）
  const proven = new Map((proof.evidence.functions || []).filter((f) => f.function_id.startsWith(`${OPERATORS_PATH}#ROWS.`)).map((f) => [f.function_id.split('#ROWS.')[1], f]));
  for (const o of s.operators) {
    const f = proven.get(o);
    need(f && f.role === 'FEATURE' && f.t_c1 === 'PASS' && f.t_c2 === 'PASS' && f.t_c3 === 'PASS', 'OPERATOR_NOT_PROVEN_CAUSAL', o);
  }
  return Object.freeze({ ...s, sha256: sha256(bytes) });
}

/**
 * 读数要在钉住的数据集登记表里（协调会话 2026-11-17）：dataset_id 已登记；pit_available_at 以登记表的 PIT 记号开头（记号之后不能再接 A–Z 0–9 _）。
 * 混合数据集（没有 pitSemantics、有 pitSemanticsBySeries）要写表里的 series，按那个序列核；非混合数据集不许写 series。
 */
const absentField = (v) => v === undefined || v === null;
function checkReadingRegistered(r, reg) {
  const ds = reg.datasets.get(r.dataset_id);
  need(ds, 'READING_UNREGISTERED', `${r.dataset_id}@${reg.registry_version}`);
  const bySeries = ds.pitSemanticsBySeries;
  const mixed = absentField(ds.pitSemantics) && bySeries !== null && typeof bySeries === 'object' && Object.keys(bySeries).length > 0;
  let pit;
  if (mixed) {
    need(r.series !== undefined, 'READING_SERIES_REQUIRED', `${r.name}:${r.dataset_id}`);
    need(Object.prototype.hasOwnProperty.call(bySeries, r.series), 'READING_SERIES_UNKNOWN', `${r.name}:${r.series}`);
    pit = [bySeries[r.series]];
  } else {
    need(r.series === undefined, 'READING_SERIES_NOT_ALLOWED', `${r.name}:${r.dataset_id}`);
    need(!absentField(ds.pitSemantics), 'READING_PIT_MISMATCH', `${r.name}:registry has no pitSemantics for ${r.dataset_id}`);
    pit = Array.isArray(ds.pitSemantics) ? ds.pitSemantics : [ds.pitSemantics];
  }
  const head = /^([A-Z][A-Z0-9_]*)(?![A-Za-z0-9_])/.exec(r.pit_available_at);
  need(head && pit.includes(head[1]), 'READING_PIT_MISMATCH', `${r.name}:${head ? head[1] : r.pit_available_at.slice(0, 24)}≠${pit.join(',')}`);
}

/** 冻结页核对：页上写出清单 sha256、MINING_SPACE_V1 与 FROZEN（同 RACE_MANIFEST_V1 的冻结写法）。 */
function verifyFreeze(space, freeze) {
  need(freeze && isText(freeze.path) && Buffer.isBuffer(freeze.bytes) && SHA64.test(freeze.sha256 || ''), 'FREEZE_MISSING');
  need(sha256(freeze.bytes) === freeze.sha256, 'FREEZE_SHA_MISMATCH', freeze.path);
  const text = freeze.bytes.toString('utf8');
  need(text.includes(space.sha256) && text.includes(SCHEMA) && /\bFROZEN\b/.test(text), 'NOT_FROZEN', freeze.path);
  return { path: freeze.path, sha256: freeze.sha256 };
}

/** 给 DSL 用的那几项（读数名、常数、窗口、算子子集、长度与深度上限）。 */
const dslSpaceOf = (s) => ({ readings: s.readings.map((r) => r.name), constants: [...s.constants], lookbacks: [...s.lookbacks], operators: [...s.operators],
  max_tokens: s.max_tokens, max_depth: s.max_depth });

module.exports = { SCHEMA, MARKETS, OPERATORS_PATH, SpaceError, parseSpace, verifyFreeze, dslSpaceOf };
