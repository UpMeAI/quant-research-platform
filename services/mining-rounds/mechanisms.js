'use strict';

/**
 * 挖掘候选的机制登记 MINING_MECHANISM_V1（协调会话裁定 R1.5，ce254328…，2026-11-17；G-MINE 第 9 项）。
 *
 * 过了验证折的每个候选（本轮选择记录 MINING_SELECTION_V1 里的编号），在留出段开启之前写一条：
 *   - mechanism_id 必须在仓库钉住的机制登记表里（services/research-mechanism-register，MINE_MECHANISM_ID_NOT_REGISTERED）；
 *   - 经济逻辑与预期失效方式都要写（MINE_MECHANISM_FIELDS）；写的是公式的经济逻辑，不是市场预测；
 *   - written_at 是北京时间（+08:00），不晚于登记时刻（MINE_MECHANISM_WRITTEN_AT，修订 4：不容忍）；registered_at 是系统时刻；
 *     打分时第 9 项要 written_at ≤ registered_at < 留出段开启的 opened_at（不是打分时刻），否则不过；
 *   - 过 G-MECH 的同机制去重：分诊查询（as_of = written_at）的路由是 NOT_DO_SETTLED → 拒绝（MINE_MECHANISM_NOT_DO_SETTLED）；
 *     路由、登记表 sha、引到的封存 sha 都写进这一行；本轮已有别的候选登记了同一个机制 → 写进 same_mechanism_in_round（披露，不拒）；
 *   - 每个候选只一条、只追加（MINE_MECHANISM_DUPLICATE）；留出段一开就不能再写（MINE_MECHANISM_AFTER_HOLDOUT_OPEN）；
 *     不是本轮过了验证折的候选 → MINE_MECHANISM_CANDIDATE_NOT_SELECTED。
 * 执行器打分时把这一行交给 G-MINE（mechanism：机制编号、两段文字、written_at、本行 hash）；没有登记的候选照样打分，mechanism 为 null，
 * 原因写 NO_MECHANISM_REGISTERED_BEFORE_OPEN，第 9 项不过。台账 research/mining_mechanisms.jsonl。
 *
 * 协调会话复审 MECHANISM_REVIEW_V1（R1.5「打分之前由协调会话复审这批机制」，修订 5 f904e0fe…）：台账 research/mining_mechanism_reviews.jsonl，只追加。
 *   - 机制集合 sha（mechanismSetSha）：本轮选择记录 hash + 选择记录里每个候选（按编号排序）的机制登记行 hash（没登记的为 null）的规范 JSON 的 sha256；
 *   - recordReview：裁决文件给 mechanism_set_sha256（必须等于现在的集合，复审人看的就是这一份）、reviewer（自由文本，不核身份）、
 *     verdicts [{candidate_id, verdict: APPROVED | REJECTED, note?}]（候选必须在选择记录里、各一次；APPROVED 要有登记）；留出段开启之后不能再写；
 *   - 同一轮再复审是新的一行（supersedes 指向上一行），最新的那一行算数；执行器打分之前核它（round-runner reviewedMechanisms）。
 */
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const { validateRecord } = require('../../schemas');
const trials = require('../trial-ledger');
const mech = require('../research-mechanism-register');

const SCHEMA = 'MINING_MECHANISM_V1';
const LEDGER = () => path.join(dataDir('research'), 'mining_mechanisms.jsonl');
const REVIEW_SCHEMA = 'MECHANISM_REVIEW_V1';
const REVIEWS = () => path.join(dataDir('research'), 'mining_mechanism_reviews.jsonl');
const VERDICTS = Object.freeze(['APPROVED', 'REJECTED']);
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
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
  // 修订 4 写明：written_at 不得晚于登记时刻（不再容忍 5 分钟）；打分时 G-MINE 第 9 项再核登记早于留出段开启（门的 checkMechanism）
  need(Number.isFinite(Date.parse(stamp)) && BEIJING.test(m.written_at || '') && Date.parse(m.written_at) <= Date.parse(stamp), 'MINE_MECHANISM_WRITTEN_AT', String(m.written_at));
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

/** 本轮的机制集合：选择记录里每个候选（按编号排序）与它的机制登记行 hash（没登记的 null），以及这份集合的 sha256。 */
function mechanismSetSha(roundId) {
  const sel = require('./index').selectionOf(roundId);
  need(sel, 'MINE_MECHANISM_REVIEW_NO_SELECTION', roundId);
  const items = [...sel.selected].sort().map((id) => { const m = mechanismOf(roundId, id); return { candidate_id: id, registration_hash: m ? m.record_hash : null }; });
  return { sha256: require('crypto').createHash('sha256').update(trials.canonicalJson({ round_id: roundId, selection_record_hash: sel.record_hash, items })).digest('hex'),
    selection_record_hash: sel.record_hash, items };
}
const reviewsOf = (roundId) => read(REVIEWS()).filter((x) => x.schema === REVIEW_SCHEMA && x.round_id === roundId);
/** 最新的复审行（只追加，最后一行算数）；没有 → null。 */
const latestReview = (roundId) => { const all = reviewsOf(roundId); return all.length ? all[all.length - 1] : null; };

/**
 * 协调会话写一行复审（只追加）。
 * @param {{mechanism_set_sha256: string, reviewer: string, verdicts: Array<{candidate_id: string, verdict: 'APPROVED'|'REJECTED', note?: string}>}} v
 * @param {{reviewedAt?: string}} opts reviewed_at 默认现在，不能在将来；recorded_at 总是系统时刻
 */
function recordReview(roundId, v = {}, { reviewedAt = null } = {}) {
  const rounds = require('./index');
  const r = rounds.roundHead(roundId);
  need(r, 'MINE_MECHANISM_REVIEW_ROUND_NOT_FOUND', roundId);
  need(!require('../holdout-vault').openLog(roundId).length && (r.status === 'OPEN' || r.status === 'CAP_REACHED'), 'MINE_MECHANISM_REVIEW_AFTER_HOLDOUT_OPEN', `${roundId}:${r.status}`);
  const set = mechanismSetSha(roundId);
  need(v.mechanism_set_sha256 === set.sha256, 'MINE_MECHANISM_REVIEW_SET_CHANGED', `${roundId}: reviewed ${String(v.mechanism_set_sha256).slice(0, 12)}, current ${set.sha256.slice(0, 12)}`);
  need(isText(v.reviewer), 'MINE_MECHANISM_REVIEW_REVIEWER_REQUIRED', roundId);
  const selected = new Set(set.items.map((x) => x.candidate_id));
  const list = Array.isArray(v.verdicts) ? v.verdicts : [];
  need(list.length > 0 && list.every((x) => x && selected.has(x.candidate_id) && VERDICTS.includes(x.verdict) && (x.note === undefined || x.note === null || typeof x.note === 'string'))
    && new Set(list.map((x) => x.candidate_id)).size === list.length, 'MINE_MECHANISM_REVIEW_INVALID', roundId);
  for (const x of list) if (x.verdict === 'APPROVED') need(mechanismOf(roundId, x.candidate_id), 'MINE_MECHANISM_REVIEW_APPROVED_UNREGISTERED', x.candidate_id);
  const stamp = now();
  const at = reviewedAt || stamp;
  need(INSTANT.test(at) && Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.parse(stamp), 'MINE_MECHANISM_REVIEW_AT', String(at));
  const prior = latestReview(roundId);
  const body = {
    schema: REVIEW_SCHEMA, round_id: roundId, selection_record_hash: set.selection_record_hash, mechanism_set_sha256: set.sha256, items: set.items,
    verdicts: [...list].sort((a, b) => (a.candidate_id < b.candidate_id ? -1 : 1)).map((x) => ({ candidate_id: x.candidate_id, verdict: x.verdict, note: typeof x.note === 'string' ? x.note.slice(0, 2000) : null })),
    reviewer: v.reviewer, reviewed_at: at, recorded_at: stamp, supersedes: prior ? prior.record_hash : null,
  };
  const rec = { ...body, record_hash: trials.recordHash(body) };
  const res = validateRecord(rec, REVIEW_SCHEMA);
  need(res.ok, 'MINE_MECHANISM_REVIEW_SCHEMA_INVALID', res.problems.join(','));
  return append(REVIEWS(), rec);
}

/** 只给测试用：临时把 G-MECH 的路由换成给定值（合成 NOT_DO_SETTLED），回调结束还原。 */
function withRoute(route, cb) { const prior = routeOverride; routeOverride = route; try { return cb(); } finally { routeOverride = prior; } }

module.exports = { SCHEMA, LEDGER, REVIEW_SCHEMA, REVIEWS, VERDICTS, MechanismError, registerMechanism, mechanismOf, mechanismsOf,
  mechanismSetSha, recordReview, reviewsOf, latestReview, internals: { withRoute } };
