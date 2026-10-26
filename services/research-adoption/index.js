'use strict';

/**
 * 研究结论的采用决定（CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_6 H1）。
 *
 * 追加式记录 `RESEARCH_ADOPTION_DECISION_V1`，存在 QRP 账本 `research/adoption_decisions.jsonl`。两类：
 *   DECISION        Owner 的决定：ADOPT（采用，纸面账户执行）／NOT_ADOPTED（不采用，现行规则不变）／
 *                   NOT_APPLICABLE（不适用，只用于基线评价与随机对照）；带后续去向、Owner 原话、决定时间、
 *                   协调会话的建议与理由，以及决定记录文件的路径与 sha256（写入时现场核对）；
 *   RECOMMENDATION  还没有决定、只有协调会话的建议与理由；页面写「待 Owner 决定」。
 * 对象按 `result_id`（随机对照再加 `part`，例如 Q3 结果里的 Q3A／Q3A2）定位；每个对象最多一条有效记录，
 * 有效记录 = 最后追加的那条。已有有效「决定」时，新记录必须写 `supersedes` = 那条决定的 record_id；
 * 有效记录只是「建议」时，新记录可以直接接上（写了 `supersedes` 就必须对得上）。历史行一律不改。
 *
 * 失败关闭：写入人不是完成权威（QRP_PRODUCT_MILESTONE_AUTHORITY）、result_id 未知、结果不在锁定状态（封存文件校验失败或已被取代）、
 * 缺字段、重复决定却没有 supersedes，一律拒绝，账本不写。这里不改任何研究结果、判据、锁或证据，也不产生生产动作。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const baseline = require('../baseline-evaluation');
const comparison = require('../candidate-comparison');

const SCHEMA = 'RESEARCH_ADOPTION_DECISION_V1';
const KINDS = Object.freeze(['DECISION', 'RECOMMENDATION']);
const DECISIONS = Object.freeze(['ADOPT', 'NOT_ADOPTED', 'NOT_APPLICABLE']);
const RECOMMENDATIONS = Object.freeze(['ADOPT', 'NOT_ADOPTED']);
const DECIDED_BY = 'OWNER';
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256 = /^[0-9a-f]{64}$/;

const LEDGER = () => path.join(dataDir('research'), 'adoption_decisions.jsonl');

class AdoptionError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new AdoptionError(code, detail); };
const need = (ok, code, detail) => { if (!ok) fail(code, detail); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, (key, item) => (isObject(item) ? Object.keys(item).sort().reduce((out, k) => { out[k] = item[k]; return out; }, {}) : item));
const keyOf = (resultId, part) => `${resultId}|${part || ''}`;

function authority(writtenBy) {
  need(isText(writtenBy), 'ADOPTION_WRITTEN_BY_REQUIRED');
  const expected = process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  need(isText(expected), 'ADOPTION_AUTHORITY_NOT_CONFIGURED');
  need(writtenBy === expected, 'ADOPTION_WRITTEN_BY_NOT_AUTHORIZED', writtenBy);
}

/**
 * 记录指向的对象：一份当前的基线锁（只能 NOT_APPLICABLE），或一份当前的对比锁（主卡：ADOPT／NOT_ADOPTED；
 * 随机对照部分 `part`：只能 NOT_APPLICABLE）。锁必须现场复验为 LOCKED_VERIFIED，且没有被同题的新锁取代。
 */
function targetOf(resultId, part, { allowNonActual = false } = {}) {
  need(isText(resultId), 'ADOPTION_FIELD_MISSING', 'result_id');
  const base = baseline.baselineFor(resultId);
  if (base) {
    need(!part, 'ADOPTION_PART_NOT_ALLOWED', `${resultId}:${part}`);
    const head = baseline.headLock(base.case_ref);
    need(head && head.result_id === resultId, 'ADOPTION_RESULT_NOT_LOCKED', `${resultId} 已被 ${head && head.result_id} 取代`);
    const projection = baseline.buildProjection(base, { allowNonActual });
    need(projection.state === 'LOCKED_VERIFIED', 'ADOPTION_RESULT_NOT_LOCKED', `${resultId}:${projection.state}`);
    return { role: 'BASELINE', lock: base, question_ref: 'Q0', part: null };
  }
  const lock = comparison.comparisonFor(resultId);
  need(lock, 'ADOPTION_RESULT_UNKNOWN', resultId);
  const head = comparison.headLock(lock.case_ref, lock.question_ref);
  need(head && head.result_id === resultId, 'ADOPTION_RESULT_NOT_LOCKED', `${resultId} 已被 ${head && head.result_id} 取代`);
  const projection = comparison.buildProjection(lock, { allowNonActual, question: lock.question_ref });
  need(projection.state === 'LOCKED_VERIFIED', 'ADOPTION_RESULT_NOT_LOCKED', `${resultId}:${projection.state}`);
  if (part) {
    const program = comparison.registry.forStrategy(lock.strategy_ref);
    const entry = program && program.get(lock.question_ref);
    const parts = entry && entry.random_control ? entry.random_control.parts.map((spec) => spec.key) : [];
    need(parts.includes(part), 'ADOPTION_PART_UNKNOWN', `${resultId}:${part}`);
    return { role: 'CONTROL', lock, question_ref: lock.question_ref, part };
  }
  return { role: 'COMPARISON', lock, question_ref: lock.question_ref, part: null };
}

function checkRecommendation(value, where) {
  need(isObject(value), 'ADOPTION_FIELD_MISSING', where);
  need(RECOMMENDATIONS.includes(value.recommendation), 'ADOPTION_FIELD_INVALID', `${where}.recommendation:${RECOMMENDATIONS.join('|')}`);
  need(isText(value.reason_zh), 'ADOPTION_FIELD_MISSING', `${where}.reason_zh`);
  return { recommendation: value.recommendation, reason_zh: value.reason_zh.trim() };
}

/** 决定记录文件：绝对路径、存在、sha256 与声明一致（写入时现场核对）。 */
function checkEvidence(ref) {
  need(isObject(ref), 'ADOPTION_FIELD_MISSING', 'evidence_ref');
  need(isText(ref.path) && path.isAbsolute(ref.path), 'ADOPTION_FIELD_INVALID', 'evidence_ref.path 须为绝对路径');
  need(SHA256.test(ref.sha256 || ''), 'ADOPTION_FIELD_INVALID', 'evidence_ref.sha256');
  let bytes;
  try { bytes = fs.readFileSync(ref.path); } catch { fail('ADOPTION_EVIDENCE_MISSING', ref.path); }
  need(sha256(bytes) === ref.sha256, 'ADOPTION_EVIDENCE_SHA256_MISMATCH', ref.path);
  return { path: ref.path, sha256: ref.sha256 };
}

function records() {
  return read(LEDGER()).filter((row) => row.schema === SCHEMA);
}
/** 每个对象（result_id + part）的有效记录：最后追加的那条。 */
function effective(rows = records()) {
  const out = new Map();
  for (const row of rows) out.set(keyOf(row.result_id, row.part), row);
  return out;
}

/**
 * 写一条采用记录（DECISION 或 RECOMMENDATION）。`input` 的字段见文件头；写入人必须是完成权威。
 * 返回写入的记录。任何校验不过都抛 AdoptionError，账本不写。
 */
function recordAdoption(input, { writtenBy, allowNonActual = false, writtenAt = null } = {}) {
  authority(writtenBy);
  need(isObject(input), 'ADOPTION_FIELD_MISSING', 'input');
  const kind = input.kind || 'DECISION';
  need(KINDS.includes(kind), 'ADOPTION_FIELD_INVALID', `kind:${KINDS.join('|')}`);
  const part = input.part === undefined || input.part === null ? null : input.part;
  need(part === null || isText(part), 'ADOPTION_FIELD_INVALID', 'part');
  const target = targetOf(input.result_id, part, { allowNonActual });

  let fields;
  if (kind === 'DECISION') {
    need(DECISIONS.includes(input.decision), 'ADOPTION_FIELD_INVALID', `decision:${DECISIONS.join('|')}`);
    // NOT_APPLICABLE 只用于基线与随机对照；它们也只能是 NOT_APPLICABLE
    if (target.role === 'COMPARISON') need(input.decision !== 'NOT_APPLICABLE', 'ADOPTION_NOT_APPLICABLE_ONLY_FOR_BASELINE_OR_CONTROL', input.result_id);
    else need(input.decision === 'NOT_APPLICABLE', 'ADOPTION_BASELINE_OR_CONTROL_MUST_BE_NOT_APPLICABLE', keyOf(input.result_id, part));
    need(isText(input.follow_up_zh), 'ADOPTION_FIELD_MISSING', 'follow_up_zh');
    need(input.decided_by === DECIDED_BY, 'ADOPTION_FIELD_INVALID', `decided_by 须为 ${DECIDED_BY}`);
    need(isText(input.owner_words), 'ADOPTION_FIELD_MISSING', 'owner_words');
    need(isText(input.decided_at) && ISO_TIME.test(input.decided_at) && Number.isFinite(Date.parse(input.decided_at)), 'ADOPTION_FIELD_INVALID', 'decided_at（ISO 8601，带时区）');
    const recommendation = input.decision === 'NOT_APPLICABLE' && (input.coordinator_recommendation === undefined || input.coordinator_recommendation === null)
      ? null : checkRecommendation(input.coordinator_recommendation, 'coordinator_recommendation');
    fields = {
      decision: input.decision, follow_up_zh: input.follow_up_zh.trim(), decided_by: DECIDED_BY, owner_words: input.owner_words,
      decided_at: input.decided_at, coordinator_recommendation: recommendation, evidence_ref: checkEvidence(input.evidence_ref),
    };
  } else {
    need(target.role === 'COMPARISON', 'ADOPTION_RECOMMENDATION_ONLY_FOR_COMPARISON', keyOf(input.result_id, part));
    for (const key of ['decision', 'decided_by', 'owner_words', 'decided_at']) need(input[key] === undefined || input[key] === null, 'ADOPTION_RECOMMENDATION_HAS_DECISION_FIELD', key);
    fields = {
      decision: null, follow_up_zh: null, decided_by: null, owner_words: null, decided_at: null,
      coordinator_recommendation: checkRecommendation(input.coordinator_recommendation, 'coordinator_recommendation'),
      evidence_ref: input.evidence_ref === undefined || input.evidence_ref === null ? null : checkEvidence(input.evidence_ref),
    };
  }

  // 撤销规则：已有有效决定 → 必须 supersedes 它；有效记录只是建议 → 可直接接上，写了就必须对得上；没有有效记录 → 不能写 supersedes
  const current = effective().get(keyOf(input.result_id, part)) || null;
  const supersedes = input.supersedes === undefined || input.supersedes === null ? null : input.supersedes;
  if (current && current.kind === 'DECISION') need(supersedes === current.record_id, 'ADOPTION_DECISION_EXISTS', `${current.record_id}（改决定须 supersedes 它）`);
  else if (current) need(supersedes === null || supersedes === current.record_id, 'ADOPTION_SUPERSEDES_MISMATCH', `${supersedes}≠${current.record_id}`);
  else need(supersedes === null, 'ADOPTION_SUPERSEDES_TARGET_NOT_FOUND', supersedes);

  const lock = target.lock;
  const core = {
    schema: SCHEMA, kind, result_id: input.result_id, part, case_ref: lock.case_ref, strategy_ref: lock.strategy_ref, question_ref: target.question_ref,
    ...fields, supersedes, production_effect: 'NONE', written_by: writtenBy, written_at: writtenAt || now(),
  };
  const recordId = `ADR-${sha256(canonical(core)).slice(0, 16)}`;
  const body = { ...core, record_id: recordId };
  body.record_hash = sha256(canonical(body));
  return append(LEDGER(), body);
}

module.exports = {
  SCHEMA, KINDS, DECISIONS, RECOMMENDATIONS, DECIDED_BY, LEDGER, AdoptionError, recordAdoption, records, effective, keyOf, targetOf,
};
