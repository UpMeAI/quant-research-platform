'use strict';

/**
 * 挖掘候选的机制登记 MINING_MECHANISM_V1（协调会话裁定 R1.5，ce254328…，2026-11-17；G-MINE 第 9 项）。
 *
 * 过了验证折的每个候选（本轮选择记录 MINING_SELECTION_V1 里的编号），在留出段开启之前写一条：
 *   - mechanism_id 必须在仓库钉住的机制登记表里（services/research-mechanism-register，MINE_MECHANISM_ID_NOT_REGISTERED）；
 *   - 经济逻辑与预期失效方式都要写（MINE_MECHANISM_FIELDS）；写的是公式的经济逻辑，不是市场预测；
 *   - written_at 是北京时间（+08:00），不晚于登记时刻（MINE_MECHANISM_WRITTEN_AT）；registered_at 是系统时刻；
 *   - 过 G-MECH 的同机制去重：分诊查询（as_of = written_at）的路由是 NOT_DO_SETTLED → 拒绝（MINE_MECHANISM_NOT_DO_SETTLED）；
 *     路由、登记表 sha、引到的封存 sha 都写进这一行；本轮已有别的候选登记了同一个机制 → 写进 same_mechanism_in_round（披露，不拒）；
 *   - 每个候选只一条、只追加（MINE_MECHANISM_DUPLICATE）；留出段一开就不能再写（MINE_MECHANISM_AFTER_HOLDOUT_OPEN）；
 *     不是本轮过了验证折的候选 → MINE_MECHANISM_CANDIDATE_NOT_SELECTED。
 * 执行器打分时把这一行交给 G-MINE（mechanism：机制编号、两段文字、written_at、本行 hash）；没有登记的候选照样打分，mechanism 为 null，
 * 原因写 NO_MECHANISM_REGISTERED_BEFORE_OPEN，第 9 项不过。台账 research/mining_mechanisms.jsonl。
 */
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const { validateRecord } = require('../../schemas');
const trials = require('../trial-ledger');
const mech = require('../research-mechanism-register');

const SCHEMA = 'MINING_MECHANISM_V1';
const LEDGER = () => path.join(dataDir('research'), 'mining_mechanisms.jsonl');
const BEIJING = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?\+08:00$/;
const MARKET_OF = Object.freeze({ CN_A: 'CN_A', US: 'US_EQUITY', CRYPTO: 'CRYPTO' });

class MechanismError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const need = (c, code, detail) => { if (!c) throw new MechanismError(code, detail); };
const isText = (v) => typeof v === 'string' && v.trim() !== '';

let routeOverride = null;

const mechanismsOf = (roundId) => read(LEDGER()).filter((x) => x.schema === SCHEMA && x.round_id === roundId);
const mechanismOf = (roundId, candidateId) => mechanismsOf(roundId).find((x) => x.candidate_id === candidateId) || null;

/**
 * @param {{candidate_id, mechanism_id, economic_logic_zh, failure_mode_zh, written_at}} m
 * @param {{writtenBy: string, registeredAt?: string}} opts
 */
function registerMechanism(roundId, m = {}, { writtenBy, registeredAt = null } = {}) {
  const rounds = require('./index');
  const vault = require('../holdout-vault');
  const r = rounds.roundHead(roundId);
  need(r, 'MINE_MECHANISM_ROUND_NOT_FOUND', roundId);
  need(!vault.openLog(roundId).length && (r.status === 'OPEN' || r.status === 'CAP_REACHED'), 'MINE_MECHANISM_AFTER_HOLDOUT_OPEN', `${roundId}:${r.status}`);
  const sel = rounds.selectionOf(roundId);
  need(sel && sel.selected.includes(m.candidate_id), 'MINE_MECHANISM_CANDIDATE_NOT_SELECTED', `${roundId}:${m.candidate_id}`);
  need(!mechanismOf(roundId, m.candidate_id), 'MINE_MECHANISM_DUPLICATE', `${roundId}:${m.candidate_id}`);
  need(mech.isRegistered(m.mechanism_id), 'MINE_MECHANISM_ID_NOT_REGISTERED', m.mechanism_id);
  need(isText(m.economic_logic_zh) && isText(m.failure_mode_zh), 'MINE_MECHANISM_FIELDS', m.candidate_id);
  need(isText(writtenBy), 'MINE_MECHANISM_WRITTEN_BY_REQUIRED');
  const stamp = registeredAt || now();
  need(BEIJING.test(m.written_at || '') && Date.parse(m.written_at) <= Date.parse(stamp) + 5 * 60e3, 'MINE_MECHANISM_WRITTEN_AT', String(m.written_at));
  const table = mech.query({ mechanism_ids: [m.mechanism_id], market: MARKET_OF[r.market] || r.market }, { asOf: m.written_at });
  const route = routeOverride || table.route;
  need(route !== 'NOT_DO_SETTLED', 'MINE_MECHANISM_NOT_DO_SETTLED', `${m.mechanism_id}:${(table.cite_seal_sha256 || []).join(',')}`);
  const body = {
    schema: SCHEMA, round_id: roundId, candidate_id: m.candidate_id, mechanism_id: m.mechanism_id, economic_logic_zh: m.economic_logic_zh, failure_mode_zh: m.failure_mode_zh,
    written_at: m.written_at, written_by: writtenBy, registered_at: stamp, selection_record_hash: sel.record_hash,
    gmech: { route, register_sha256: table.register.sha256, cite_seal_sha256: [...(table.cite_seal_sha256 || [])], as_of: m.written_at },
    same_mechanism_in_round: mechanismsOf(roundId).filter((x) => x.mechanism_id === m.mechanism_id).map((x) => x.candidate_id),
  };
  const rec = { ...body, record_hash: trials.recordHash(body) };
  const v = validateRecord(rec, SCHEMA);
  need(v.ok, 'MINE_MECHANISM_SCHEMA_INVALID', v.problems.join(','));
  return append(LEDGER(), rec);
}

/** 只给测试用：临时把 G-MECH 的路由换成给定值（合成 NOT_DO_SETTLED），回调结束还原。 */
function withRoute(route, cb) { const prior = routeOverride; routeOverride = route; try { return cb(); } finally { routeOverride = prior; } }

module.exports = { SCHEMA, LEDGER, MechanismError, registerMechanism, mechanismOf, mechanismsOf, internals: { withRoute } };
