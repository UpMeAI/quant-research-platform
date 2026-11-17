'use strict';

/**
 * 留出段保管服务（研究框架修订 2026-11-16，签字 fd22876f / 39f8c17c，§3.4；§8.2 services/holdout-vault；§8.3 第 9 条；P1）。
 *
 *   封存（seal）：每轮一次，写留出段的起止与数据的 sha256（数据本身不进 QRP）；起止必须等于轮次清单里冻结的留出段。
 *   开启（open）：每轮只开一次，本轮生成结束之后，把过了验证折的候选一次性交去打分；每个候选只读一次（同一次里不能重复），
 *     只能是本轮登记过的 MINED_CANDIDATE；开启即把轮次转为 SCORING（之后不能再记候选），每次开启都写日志。同一轮第二次开 → MINE_HOLDOUT_ALREADY_OPENED。
 *   生成方接触不到这里：生成方只拿 services/mining-rounds 的 generatorView（挖掘段分数与已试公式），没有任何读留出段、验证折或打分结果的入口。
 * 台账 research/holdout_vault.jsonl（只追加）；错误码 MINE_HOLDOUT_*。
 */
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const { validateRecord } = require('../../schemas');
const trials = require('../trial-ledger');
const rounds = require('../mining-rounds');

const SEAL_SCHEMA = 'HOLDOUT_SEAL_V1';
const OPEN_SCHEMA = 'HOLDOUT_OPEN_V1';
const LEDGER = () => path.join(dataDir('research'), 'holdout_vault.jsonl');
const SHA64 = /^[0-9a-f]{64}$/;

class HoldoutError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const need = (c, code, detail) => { if (!c) throw new HoldoutError(code, detail); };
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const rows = (schema, roundId) => read(LEDGER()).filter((r) => r.schema === schema && r.round_id === roundId);

function write(body, schema) {
  const rec = { ...body, record_hash: trials.recordHash(body) };
  const v = validateRecord(rec, schema);
  need(v.ok, 'MINE_HOLDOUT_SCHEMA_INVALID', v.problems.join(','));
  return append(LEDGER(), rec);
}

/** 封存本轮的留出段（每轮一次）。 */
function seal({ round_id: roundId, segment, data_ref: dataRef, data_sha256: dataSha, sealedBy, sealedAt = null } = {}) {
  const r = rounds.roundHead(roundId);
  need(r, 'MINE_HOLDOUT_ROUND_NOT_FOUND', roundId);
  need(segment && segment.from === r.holdout.from && segment.to === r.holdout.to, 'MINE_HOLDOUT_SEGMENT_MISMATCH', `${roundId}:${r.holdout.from}..${r.holdout.to}`);
  need(isText(dataRef) && SHA64.test(dataSha || '') && isText(sealedBy), 'MINE_HOLDOUT_SEAL_INVALID', roundId);
  need(!rows(SEAL_SCHEMA, roundId).length, 'MINE_HOLDOUT_ALREADY_SEALED', roundId);
  return write({ schema: SEAL_SCHEMA, round_id: roundId, market: r.market, segment: { from: segment.from, to: segment.to }, data_ref: dataRef, data_sha256: dataSha,
    sealed_by: sealedBy, sealed_at: sealedAt || now() }, SEAL_SCHEMA);
}

/**
 * 开启（每轮一次）：交出数据的引用与 sha，记下这次读了哪些候选；轮次转为 SCORING。
 * @returns {{round_id, data_ref, data_sha256, segment, candidate_ids}}
 */
function open({ round_id: roundId, candidate_ids: ids, openedBy, openedAt = null, checks = null } = {}) {
  const r = rounds.roundHead(roundId);
  need(r, 'MINE_HOLDOUT_ROUND_NOT_FOUND', roundId);
  const [s] = rows(SEAL_SCHEMA, roundId);
  need(s, 'MINE_HOLDOUT_NOT_SEALED', roundId);
  need(!rows(OPEN_SCHEMA, roundId).length, 'MINE_HOLDOUT_ALREADY_OPENED', roundId);
  need(isText(openedBy), 'MINE_HOLDOUT_OPENED_BY_REQUIRED');
  need(Array.isArray(ids) && ids.length && ids.every(isText), 'MINE_HOLDOUT_CANDIDATES_REQUIRED', roundId);
  need(new Set(ids).size === ids.length, 'MINE_HOLDOUT_CANDIDATE_READ_TWICE', roundId);
  const known = new Set([...trials.heads().values()].filter((t) => t.role === 'MINED_CANDIDATE' && t.mining && t.mining.round_id === roundId).map((t) => t.mining.candidate_id));
  for (const id of ids) need(known.has(id), 'MINE_HOLDOUT_CANDIDATE_UNKNOWN', `${roundId}:${id}`);
  rounds.beginScoring(roundId);
  write({ schema: OPEN_SCHEMA, round_id: roundId, seal_hash: s.record_hash, candidate_ids: [...ids], opened_by: openedBy, opened_at: openedAt || now(),
    pre_open_checks: checks && typeof checks === 'object' ? JSON.parse(JSON.stringify(checks)) : null }, OPEN_SCHEMA); // 开启之前执行器做过的核对（覆盖下限等）
  return { round_id: roundId, data_ref: s.data_ref, data_sha256: s.data_sha256, segment: { ...s.segment }, candidate_ids: [...ids] };
}

/** 开启日志（审计用）。 */
const openLog = (roundId) => rows(OPEN_SCHEMA, roundId);
/** 本轮的封存记录（只读；P2 执行器在开启之前用它核留出段目录的 sha）。 */
const sealOf = (roundId) => rows(SEAL_SCHEMA, roundId)[0] || null;

module.exports = { SEAL_SCHEMA, OPEN_SCHEMA, LEDGER, HoldoutError, seal, open, openLog, sealOf };
