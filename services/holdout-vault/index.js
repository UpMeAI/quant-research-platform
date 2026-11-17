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
const RESCORE_SCHEMA = 'HOLDOUT_RESCORE_V1';
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
function open({ round_id: roundId, candidate_ids: ids, openedBy, openedAt = null, checks = null, selection_record_hash: selectionRecordHash = null, inputs_sha256: inputsSha = null } = {}) {
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
  // R1.6：这段留出段在本族（同市场）里被开了第几次（含这一次），写进开启记录与轮次记录
  const sameSegment = (x) => x.market === r.market && x.segment.from === s.segment.from && x.segment.to === s.segment.to;
  const sealsHere = new Set(read(LEDGER()).filter((x) => x.schema === SEAL_SCHEMA && sameSegment(x)).map((x) => x.round_id));
  const index = read(LEDGER()).filter((x) => x.schema === OPEN_SCHEMA && sealsHere.has(x.round_id)).length + 1;
  rounds.beginScoring(roundId, { holdoutOpens: { segment: { ...s.segment }, family_ids: [...r.family_ids], count: index } });
  write({ schema: OPEN_SCHEMA, round_id: roundId, seal_hash: s.record_hash, candidate_ids: [...ids], opened_by: openedBy, opened_at: openedAt || now(), segment_open_index: index,
    pre_open_checks: checks && typeof checks === 'object' ? JSON.parse(JSON.stringify(checks)) : null, // 开启之前执行器做过的核对（覆盖下限等）
    selection_record_hash: selectionRecordHash, inputs_sha256: inputsSha }, OPEN_SCHEMA); // R1.8：重打分要对得上这两个
  return { round_id: roundId, data_ref: s.data_ref, data_sha256: s.data_sha256, segment: { ...s.segment }, candidate_ids: [...ids], segment_open_index: index };
}

/**
 * 协调会话裁定 R1.8：留出段开启之后、最后一条 G-MINE 记录写完之前崩溃 → 允许恰好一次 RESCORE_SAME_SELECTION，记成第二个事件（原因 + 日志）。条件全部满足：
 *   1 选集的台账行（MINING_SELECTION_V1）逐字节没变：它的 record_hash 重算得出、且等于开启记录写下的那一个；SHA256SUMS.sealed 与其余输入
 *     （执行器算的 inputs_sha256：留出段清单、封存清单、选择文件、现有因子序列、数据源、代码、下限、机制登记）与开启时一样；
 *   2 第一次尝试没有写下任何 G-MINE 记录；
 *   3 同样的输入，打分是确定的（执行器同一份代码、同样的输入；测试核「崩溃后重打分 = 一次跑完」）。
 * 只许一次（MINE_HOLDOUT_RESCORE_ONCE）；轮次要在 SCORING。
 */
function recordRescore({ round_id: roundId, reason, log = '', inputs_sha256: inputsSha, rescoredBy, rescoredAt = null } = {}) {
  const r = rounds.roundHead(roundId);
  need(r, 'MINE_HOLDOUT_ROUND_NOT_FOUND', roundId);
  need(r.status === 'SCORING', 'MINE_HOLDOUT_RESCORE_NOT_SCORING', `${roundId}:${r.status}`);
  const [o] = rows(OPEN_SCHEMA, roundId);
  need(o, 'MINE_HOLDOUT_NOT_OPENED', roundId);
  need(!rows(RESCORE_SCHEMA, roundId).length, 'MINE_HOLDOUT_RESCORE_ONCE', roundId);
  need(isText(reason) && isText(rescoredBy), 'MINE_HOLDOUT_RESCORE_INVALID', roundId);
  need(!require('../mining-rounds/gate-records').recordsOf(roundId).length, 'MINE_HOLDOUT_RESCORE_RECORDS_EXIST', roundId);
  const sel = rounds.selectionOf(roundId);
  const { record_hash: selHash, ...selBody } = sel || {};
  need(sel && trials.recordHash(selBody) === selHash && selHash === o.selection_record_hash, 'MINE_HOLDOUT_RESCORE_SELECTION_CHANGED', roundId);
  need(isText(inputsSha) && inputsSha === o.inputs_sha256, 'MINE_HOLDOUT_RESCORE_INPUTS_CHANGED', roundId);
  const text = String(log || '');
  return write({ schema: RESCORE_SCHEMA, round_id: roundId, kind: 'RESCORE_SAME_SELECTION', open_hash: o.record_hash, selection_record_hash: selHash, inputs_sha256: inputsSha,
    reason, log_sha256: require('crypto').createHash('sha256').update(text).digest('hex'), log_excerpt: text.slice(0, 4000), rescored_by: rescoredBy, rescored_at: rescoredAt || now() }, RESCORE_SCHEMA);
}
const rescoreLog = (roundId) => rows(RESCORE_SCHEMA, roundId);

/** 开启日志（审计用）。 */
const openLog = (roundId) => rows(OPEN_SCHEMA, roundId);
/** 本轮的封存记录（只读；P2 执行器在开启之前用它核留出段目录的 sha）。 */
const sealOf = (roundId) => rows(SEAL_SCHEMA, roundId)[0] || null;

module.exports = { SEAL_SCHEMA, OPEN_SCHEMA, RESCORE_SCHEMA, LEDGER, HoldoutError, seal, open, openLog, sealOf, recordRescore, rescoreLog };
