'use strict';

/**
 * G-MINE 逐候选记录 MINING_GATE_RECORD_V1（RF1116 §3.6；协调会话 2026-11-17 裁定 3 与其补充）。G-MINE 求值这条路自己写：
 *   recordGateResult 在这里调用 G-MINE（services/mining-gate 的 evaluate）求值，再写一行记录；调用方给的只是候选结果对象，
 *   「过没过」由门算，不收调用方报的数。过 = 门判 pass 且九项全过。
 *   门的 ctx 全由这里定，不收调用方的：门槛只读 QRP git 里钉住的 config/mining_gate_thresholds.v1.json（调用方给门槛 →
 *   MINE_GATE_RECORD_THRESHOLDS_FROM_CALLER，给别的 ctx 键 → MINE_GATE_RECORD_CTX_NOT_ACCEPTED）；本族 N 取试验台账的累计数；
 *   数据段标记取试验台账；因子库、机制登记表用仓库里钉住的那份（门的默认）。记录写下门槛文件的 sha256 与用到的数。
 *   FROZEN 的门槛总要核仓库里的冻结页（services/mining-gate 的 verifyFreezeRef），核不过整条记不过（MINE_THRESHOLDS_FREEZE_REF_INVALID）。
 * 每轮每个候选一行、只追加：挂本轮这个候选的试验台账行（trial_id + record_hash）和留出段开启记录（record_hash）；
 * 只有本轮已开留出段（状态 SCORING）、且候选在开启记录里，才能记；同一候选第二次 → MINE_GATE_RECORD_DUPLICATE。
 * 关轮（./index.js closeRound）只从这些记录数「过了几个」。台账 research/mining_gate_records.jsonl。
 * VOID（裁定 R1.8、R1.12）：轮次以 FAILED_RESCORE / FAILED_PARTIAL 关了，已写的记录保留原行，另追加一行 MINING_GATE_RECORD_VOID_V1（指向原行 hash）；
 *   recordsOf 默认不返回 VOID 的记录，也不返回 FAILED_* 轮次的任何记录（轮次行先写，VOID 行后写，中间崩了也不计数）；审计用 { includeVoid: true }。
 */
const crypto = require('crypto');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const { validateRecord } = require('../../schemas');
const trials = require('../trial-ledger');

const SCHEMA = 'MINING_GATE_RECORD_V1';
const VOID_SCHEMA = 'MINING_GATE_RECORD_VOID_V1';
const fs = require('fs');
const THRESHOLDS_REL = 'config/mining_gate_thresholds.v1.json';
const THRESHOLDS_V2_REL = 'config/mining_gate_thresholds.v2.json';
const THRESHOLD_KEYS = Object.freeze(['ic_mean_min', 'icir_min', 'monotonicity_min', 'decay_ratio_min', 'marginal_ir_delta_min', 'marginal_intercept_t_min']);
const SIZE_EXPOSURE_KEY = 'size_exposure_abs_max';
// 版本跟着轮走（修订 SIZE_V2 N4）：V2 的轮读 v2 文件，第 1、2 轮（LINEAR_RAW_V1）读 v1 文件。thresholdsFile 只给测试换（同一份换到两种版本）。
const THRESHOLDS_BY_VERSION = Object.freeze({
  LINEAR_RAW_V1: Object.freeze({ rel: THRESHOLDS_REL, schema: 'MINING_GATE_THRESHOLDS_V1', keys: THRESHOLD_KEYS }),
  RANK_GAUSS_V2: Object.freeze({ rel: THRESHOLDS_V2_REL, schema: 'MINING_GATE_THRESHOLDS_V2', keys: Object.freeze([...THRESHOLD_KEYS, SIZE_EXPOSURE_KEY]) }),
});
let thresholdsFile = null;
const LEDGER = () => path.join(dataDir('research'), 'mining_gate_records.jsonl');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

class GateRecordError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const need = (c, code, detail) => { if (!c) throw new GateRecordError(code, detail); };

const realGate = () => require('../mining-gate');
let evaluateGate = (candidate, ctx) => realGate().evaluate(candidate, ctx);

/** 钉住的门槛文件：字节的 sha256 与门要用的那几项（结构不对 → 不记）。 */
function pinnedThresholds(version) {
  const spec = THRESHOLDS_BY_VERSION[version];
  need(spec, 'MINE_GATE_RECORD_NEUTRALIZATION_UNKNOWN', String(version));
  const bytes = fs.readFileSync(thresholdsFile || path.join(__dirname, '..', '..', spec.rel));
  let d = null;
  try { d = JSON.parse(bytes.toString('utf8')); } catch { /* 下面拒绝 */ }
  const okRef = (r) => r === null || (r && typeof r.path === 'string' && /^[0-9a-f]{64}$/.test(r.sha256 || ''));
  need(d && d.schema === spec.schema && ['PENDING_FREEZE', 'FROZEN'].includes(d.state) && okRef(d.frozen_ref)
    && spec.keys.every((k) => typeof d[k] === 'number' && Number.isFinite(d[k])), 'MINE_GATE_RECORD_THRESHOLDS_FILE_INVALID', spec.rel);
  const used = { state: d.state, frozen_ref: d.frozen_ref, ...Object.fromEntries(spec.keys.map((k) => [k, d[k]])) };
  return { file: { path: spec.rel, sha256: sha256(bytes) }, used, thresholds: { ...used, source: d.source || null } };
}

const voidsOf = (roundId) => read(LEDGER()).filter((r) => r.schema === VOID_SCHEMA && r.round_id === roundId);
/** 本轮的 G-MINE 记录。默认只给计数用的：VOID 的不给，FAILED_RESCORE / FAILED_PARTIAL 轮次的一条都不给；includeVoid 给全部原行（审计）。 */
function recordsOf(roundId, { includeVoid = false } = {}) {
  const all = read(LEDGER()).filter((r) => r.schema === SCHEMA && r.round_id === roundId);
  if (includeVoid) return all;
  const head = require('./index').roundHead(roundId);
  if (head && require('./index').FAILED_TERMINAL.includes(head.status)) return [];
  const voided = new Set(voidsOf(roundId).map((v) => v.voided_record_hash));
  return all.filter((r) => !voided.has(r.record_hash));
}

/**
 * 把本轮已写的记录标 VOID（只给 ./index.js 的 failRescore / failPartial 用，轮次行已经是 FAILED_* 之后调用）：每条没标过的追加一行，原行不动。
 */
function voidRecords(roundId, { roundStatus, reason, ruling, voidedAt = null } = {}) {
  const head = require('./index').roundHead(roundId);
  need(head && head.status === roundStatus && require('./index').FAILED_TERMINAL.includes(roundStatus), 'MINE_GATE_RECORD_VOID_ROUND_NOT_FAILED', `${roundId}:${head ? head.status : null}`);
  const done = new Set(voidsOf(roundId).map((v) => v.voided_record_hash));
  return recordsOf(roundId, { includeVoid: true }).filter((x) => !done.has(x.record_hash)).map((x) => {
    const body = { schema: VOID_SCHEMA, round_id: roundId, candidate_id: x.candidate_id, voided_record_hash: x.record_hash, round_status: roundStatus,
      reason: String(reason || ''), ruling, voided_at: voidedAt || now() };
    const rec = { ...body, record_hash: trials.recordHash(body) };
    const v = validateRecord(rec, VOID_SCHEMA);
    need(v.ok, 'MINE_GATE_RECORD_SCHEMA_INVALID', v.problems.join(','));
    return append(LEDGER(), rec);
  });
}

/**
 * 求值并记一行。
 * @param {{round_id: string, candidate_id: string, candidate: object, recordedAt?: string}} o  不收 ctx：给了任何键都拒绝
 */
function recordGateResult({ round_id: roundId, candidate_id: candidateId, candidate, ctx = undefined, recordedAt = null } = {}) {
  if (ctx !== undefined) {
    need(!(ctx && Object.prototype.hasOwnProperty.call(ctx, 'thresholds')), 'MINE_GATE_RECORD_THRESHOLDS_FROM_CALLER', `${roundId}:${candidateId}`);
    const keys = ctx && typeof ctx === 'object' ? Object.keys(ctx) : ['(not an object)'];
    need(!keys.length, 'MINE_GATE_RECORD_CTX_NOT_ACCEPTED', keys.join(','));
  }
  const rounds = require('./index');
  const vault = require('../holdout-vault');
  const r = rounds.roundHead(roundId);
  need(r, 'MINE_GATE_RECORD_ROUND_NOT_FOUND', roundId);
  need(r.status === 'SCORING', 'MINE_GATE_RECORD_ROUND_NOT_SCORING', `${roundId}:${r.status}`);
  const [open] = vault.openLog(roundId);
  need(open && open.candidate_ids.includes(candidateId), 'MINE_GATE_RECORD_NOT_OPENED', `${roundId}:${candidateId}`);
  const trial = [...trials.heads().values()].find((t) => t.role === 'MINED_CANDIDATE' && t.mining && t.mining.round_id === roundId && t.mining.candidate_id === candidateId);
  need(trial, 'MINE_GATE_RECORD_TRIAL_MISSING', `${roundId}:${candidateId}`);
  need(!recordsOf(roundId).some((x) => x.candidate_id === candidateId), 'MINE_GATE_RECORD_DUPLICATE', `${roundId}:${candidateId}`);
  const version = require('./neutralization').neutralizationOf(r); // 本轮的中性化版本：定读哪份门槛、核候选的戳对得上
  const stamped = candidate && candidate.holdout && candidate.holdout.neutralization ? candidate.holdout.neutralization.version : undefined;
  need(stamped === undefined || stamped === version, 'MINE_GATE_RECORD_NEUTRALIZATION_MISMATCH', `${roundId}:${candidateId}:round=${version}:result=${stamped}`); // 没有戳的结果由门的第 8 项挡（UNKNOWN）
  const pinned = pinnedThresholds(version);
  const familyTrialCount = trials.count(trial.family_id).n_raw;
  // checkFreeze：FROZEN 时核仓库里的冻结页（docs/freeze/，sha 与 frozen_ref 一致、写着 FROZEN 与六个数），不过 → MINE_THRESHOLDS_FREEZE_REF_INVALID
  const result = evaluateGate(candidate, { thresholds: pinned.thresholds, familyTrialCount, marks: read(trials.SEGMENTS()), checkFreeze: true });
  const items = (result.items || []).map((i) => ({ item: i.item, key: i.key, pass: i.pass === true }));
  const pass = result.pass === true && items.length === realGate().ITEMS.length && items.every((i) => i.pass);
  const body = {
    schema: SCHEMA, round_id: roundId, candidate_id: candidateId, trial_id: trial.trial_id, trial_record_hash: trial.record_hash, holdout_open_hash: open.record_hash,
    gate_result_sha256: sha256(trials.canonicalJson(result)), thresholds_file: pinned.file, thresholds_used: pinned.used, family_trial_count: familyTrialCount,
    // R1.9（协调会话裁定 R1 修订 3）：第 7、8 项没有比的因子与原因，每条记录都写
    excluded_factors: require('../factor-library').comparisonExclusions(candidate && candidate.market ? candidate.market : trial.market),
    pass, codes: [...(result.codes || [])], items, recorded_at: recordedAt || now(),
  };
  const rec = { ...body, record_hash: trials.recordHash(body) };
  const v = validateRecord(rec, SCHEMA);
  need(v.ok, 'MINE_GATE_RECORD_SCHEMA_INVALID', v.problems.join(','));
  return append(LEDGER(), rec);
}

/** 只给测试用：临时换掉钉住的门槛文件路径（冻结 / 改过的合成文件），回调结束还原。 */
function withThresholdsFile(file, cb) {
  const prior = thresholdsFile;
  thresholdsFile = file;
  try { return cb(); } finally { thresholdsFile = prior; }
}

/** 只给测试用：临时换掉 G-MINE 的求值（合成九项结果），回调结束还原。 */
function withGate(fn, cb) {
  const prior = evaluateGate;
  evaluateGate = fn;
  try { return cb(); } finally { evaluateGate = prior; }
}

module.exports = { SCHEMA, VOID_SCHEMA, LEDGER, THRESHOLDS_REL, THRESHOLDS_V2_REL, GateRecordError, recordGateResult, recordsOf, voidsOf, voidRecords, internals: { withGate, withThresholdsFile, pinnedThresholds } };
