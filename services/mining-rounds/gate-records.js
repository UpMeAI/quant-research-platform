'use strict';

/**
 * G-MINE 逐候选记录 MINING_GATE_RECORD_V1（RF1116 §3.6；协调会话 2026-11-17 裁定 3）。G-MINE 求值这条路自己写：
 *   recordGateResult 在这里调用 G-MINE（services/mining-gate 的 evaluate）求值，再写一行记录；调用方给的只是候选结果对象，
 *   「过没过」由门算，不收调用方报的数。过 = 门判 pass 且九项全过。
 * 每轮每个候选一行、只追加：挂本轮这个候选的试验台账行（trial_id + record_hash）和留出段开启记录（record_hash）；
 * 只有本轮已开留出段（状态 SCORING）、且候选在开启记录里，才能记；同一候选第二次 → MINE_GATE_RECORD_DUPLICATE。
 * 关轮（./index.js closeRound）只从这些记录数「过了几个」。台账 research/mining_gate_records.jsonl。
 */
const crypto = require('crypto');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const { validateRecord } = require('../../schemas');
const trials = require('../trial-ledger');

const SCHEMA = 'MINING_GATE_RECORD_V1';
const LEDGER = () => path.join(dataDir('research'), 'mining_gate_records.jsonl');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

class GateRecordError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const need = (c, code, detail) => { if (!c) throw new GateRecordError(code, detail); };

const realGate = () => require('../mining-gate');
let evaluateGate = (candidate, ctx) => realGate().evaluate(candidate, ctx);

const recordsOf = (roundId) => read(LEDGER()).filter((r) => r.schema === SCHEMA && r.round_id === roundId);

/**
 * 求值并记一行。
 * @param {{round_id: string, candidate_id: string, candidate: object, ctx?: object, recordedAt?: string}} o  ctx 原样交给 G-MINE（门槛块、因子库等）
 */
function recordGateResult({ round_id: roundId, candidate_id: candidateId, candidate, ctx = {}, recordedAt = null } = {}) {
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
  const result = evaluateGate(candidate, ctx);
  const items = (result.items || []).map((i) => ({ item: i.item, key: i.key, pass: i.pass === true }));
  const pass = result.pass === true && items.length === realGate().ITEMS.length && items.every((i) => i.pass);
  const body = {
    schema: SCHEMA, round_id: roundId, candidate_id: candidateId, trial_id: trial.trial_id, trial_record_hash: trial.record_hash, holdout_open_hash: open.record_hash,
    gate_result_sha256: sha256(trials.canonicalJson(result)), thresholds: result.thresholds || null, pass, codes: [...(result.codes || [])], items, recorded_at: recordedAt || now(),
  };
  const rec = { ...body, record_hash: trials.recordHash(body) };
  const v = validateRecord(rec, SCHEMA);
  need(v.ok, 'MINE_GATE_RECORD_SCHEMA_INVALID', v.problems.join(','));
  return append(LEDGER(), rec);
}

/** 只给测试用：临时换掉 G-MINE 的求值（合成九项结果），回调结束还原。 */
function withGate(fn, cb) {
  const prior = evaluateGate;
  evaluateGate = fn;
  try { return cb(); } finally { evaluateGate = prior; }
}

module.exports = { SCHEMA, LEDGER, GateRecordError, recordGateResult, recordsOf, internals: { withGate } };
