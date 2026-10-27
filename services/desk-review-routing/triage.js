'use strict';

/**
 * Research 分诊 RESEARCH_TRIAGE_V1（desk 复盘闭环修订 7，2026-10-27 冻结 FREEZE_1，D1–D3 ★a）：desk 复盘候选不再等 Owner 挑选，
 * 由 Research 分诊——立题（OPEN_QUESTION，研究类）、转工程修复（FIX，工程类）、并入（MERGE）、判不做（CLOSE）。行为类不在研究队列里，归 Owner。
 *
 * 账本：QRP 数据目录 research/desk_triage.jsonl（QRP_DATA_DIR，默认 var/ledger；gitignored）。只追加；改正写新一行并 supersedes，
 * 只能在 desk 采用之前（desk 周档里已有这条记录的登记行之后，desk 不再采用新的一行）。desk 事实（候选号、题目）只进这本本机账本，
 * 不进 QRP 的 git、文档或证据包（修订 6 §6.3：QRP 是公开仓库）。
 *
 * 判不做与并入必须带 RESEARCH_TRIAGE_CODES@v1 的码和证据；码表里没有「样本不足」一类（Owner 10-02、10-12：样本不足不能当不做的理由）。
 * desk 编周档时按同样的规则再核一遍（desk ops/review-loop/triage.cjs），不合规的只列为「未采用」，不改候选。
 * 回程导出（return.js）把每个候选当前有效的一行按 desk 契约的字段带到 desk：triage[]。
 */
const { dataDir, append, read } = require('../../packages/ledger');
const { contentHash } = require('./canonical');
const routing = require('./index');

const SCHEMA = 'RESEARCH_TRIAGE_V1';
const LEDGER = () => dataDir('research', 'desk_triage.jsonl');
const OUTCOMES = Object.freeze(['OPEN_QUESTION', 'FIX', 'MERGE', 'CLOSE']);
/** RESEARCH_TRIAGE_CODES@v1：码 → 所属结果（与 desk ops/review-loop/triage.cjs 同表）。 */
const CODES = Object.freeze({
  NO_RECURRENCE: 'CLOSE', PARITY_MATCHED: 'CLOSE', AS_DESIGNED: 'CLOSE', ALREADY_FIXED: 'CLOSE', SUBJECT_RETIRED: 'CLOSE',
  COVERED_BY_QUESTION: 'MERGE', COVERED_BY_CANDIDATE: 'MERGE',
});
const CODE_ZH = Object.freeze({
  NO_RECURRENCE: '之后的扫描没有再出现', PARITY_MATCHED: '对账重跑已一致', AS_DESIGNED: '契约本来如此', ALREADY_FIXED: '别处已修好',
  SUBJECT_RETIRED: '账本或规则已退役', COVERED_BY_QUESTION: '已有研究问题覆盖', COVERED_BY_CANDIDATE: '已有复盘候选覆盖',
});
const FIX_REPOS = Object.freeze(['Ashare-V6', 'smartflow', 'portfolio-desk']);
const RESEARCH_TYPES = Object.freeze(['PARAMETER', 'RULE']);
const ENGINEERING_TYPES = Object.freeze(['DATA', 'EXECUTION']);
/** desk 修订 2 §4.4：职责类发现每周都列，「之后没有再出现」不能关闭它们。 */
const WEEKLY_TRIGGERS = Object.freeze(['F16', 'F17', 'F18']);
/** desk V1 §5.4 的指令词与两个预测词：依据只写事实。desk 编周档时用完整词表再扫一遍。 */
const DIRECTIVE = Object.freeze(['建议', '应该', '下周', '明天', '最好', '预计', '将会']);
const CANDIDATE_ID = /^RLC-(CN|US|CRYPTO)-\d{4}W\d{2}-[1-9]\d*$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BEIJING = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?\+08:00$/;

class TriageError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new TriageError(code, detail); };
const text = (value) => typeof value === 'string' && value.trim() !== '';
const orNull = (value) => (value === undefined ? null : value);

const isRepo = (e, { needPath = false, clause = false } = {}) => e && e.kind === 'REPO' && text(e.repo) && HEX40.test(e.commit || '')
  && (!needPath || text(e.path)) && (!clause || text(e.clause));
const isFile = (e) => e && e.kind === 'FILE' && text(e.file) && HEX64.test(e.hash || '') && text(e.path);
const isScan = (e) => e && e.kind === 'SCAN' && /^\d{4}-W\d{2}$/.test(e.weekId || '') && text(e.file) && HEX64.test(e.hash || '');

/** 一条证据按 desk 契约的形状（缺的字段补 null，多的字段不带）。 */
function evidenceItem(e) {
  if (!e || typeof e !== 'object') fail('TRIAGE_EVIDENCE_INVALID', JSON.stringify(e));
  if (e.kind === 'SCAN') return { kind: 'SCAN', weekId: e.weekId, file: e.file, hash: e.hash };
  if (e.kind === 'FILE') return { kind: 'FILE', file: e.file, hash: e.hash, path: e.path };
  if (e.kind === 'REPO') return { kind: 'REPO', repo: e.repo, path: orNull(e.path), commit: e.commit, clause: orNull(e.clause) };
  return fail('TRIAGE_EVIDENCE_INVALID', `kind=${e.kind}`);
}

/** 账本行 → desk 回程 triage[] 的一行（字段与 desk qrp-research-return.v1 一致）。 */
function deskRow(row) {
  return {
    recordId: row.record_id, recordHash: row.record_hash, candidateId: row.candidate_id, questionKey: row.question_key,
    queueFile: row.queue_file, queueSha256: row.queue_sha256, outcome: row.outcome, reasonCode: row.reason_code, questionRef: row.question_ref,
    strategyRef: row.strategy_ref, mergedInto: row.merged_into, fixRef: row.fix_ref, evidence: row.evidence, basisZh: row.basis_zh,
    recordedBy: row.recorded_by, sessionRef: row.session_ref, at: row.triaged_at, supersedes: row.supersedes,
  };
}

function ledgerRows() { return read(LEDGER()).filter((row) => row.schema === SCHEMA); }

/** 每个候选当前有效的一行：没被 supersedes 的、最晚的一行。按分诊时刻排序，同一时刻按记账先后。 */
function effectiveTriage() {
  const rows = ledgerRows();
  const superseded = new Set(rows.map((row) => row.supersedes).filter(Boolean));
  const latest = new Map();
  rows.forEach((row, index) => { if (!superseded.has(row.record_id)) latest.set(row.candidate_id, { row, index }); });
  return [...latest.values()].sort((a, b) => Date.parse(a.row.triaged_at) - Date.parse(b.row.triaged_at) || a.index - b.index).map((item) => item.row);
}

/** 队列行是否还等 Research 分诊（修订 7 的 triage 块；修订 7 之前的队列：OPEN、Owner 没选）。 */
const waitsForTriage = (entry) => (entry.triage ? entry.triage.state === 'PENDING' : entry.deskState === 'OPEN' && entry.ownerPick && entry.ownerPick.choice === null);

/** 按码核证据（与 desk 编周档时的核对同一套）。返回问题码或 null。 */
function evidenceProblem(input, entry, entries) {
  const ev = input.evidence;
  const has = (pred) => ev.some(pred);
  switch (input.reasonCode) {
    case 'NO_RECURRENCE': {
      if ((entry.triggerIds || []).some((t) => WEEKLY_TRIGGERS.includes(t))) return 'NO_RECURRENCE_ON_WEEKLY_TRIGGER';
      const last = (entry.findings || []).map((f) => f.weekId).sort().pop();
      const scans = ev.filter(isScan);
      if (!scans.length) return 'EVIDENCE';
      return scans.some((s) => s.weekId <= last) ? 'NO_RECURRENCE_SEEN' : null;
    }
    case 'PARITY_MATCHED': return has(isFile) ? null : 'EVIDENCE';
    case 'AS_DESIGNED': return has((e) => isRepo(e, { needPath: true, clause: true })) ? null : 'EVIDENCE';
    case 'ALREADY_FIXED': return has((e) => isRepo(e)) && has(isFile) ? null : 'EVIDENCE';
    case 'SUBJECT_RETIRED': return has((e) => isRepo(e, { needPath: true })) ? null : 'EVIDENCE';
    case 'COVERED_BY_QUESTION': return text(input.mergedInto) && has((e) => isRepo(e, { needPath: true })) ? null : 'EVIDENCE';
    default: {
      if (!CANDIDATE_ID.test(input.mergedInto || '') || input.mergedInto === entry.candidateId) return 'MERGE_TARGET';
      return entries.some((e) => e.candidateId === input.mergedInto) ? null : 'MERGE_TARGET';
    }
  }
}

/**
 * 记一条分诊（失败关闭：任何一项不合规就拒收，什么也不写）。读最新一份 desk 研究队列（复盘镜像或 desk checkout）。
 * @param {object} input  {candidateId, outcome, reasonCode?, questionRef?, mergedInto?, fixRef?, evidence?, basisZh, at, sessionRef?, supersedes?}
 * @returns {object} 写下的账本行
 */
function recordTriage(input, { deskRoot } = {}) {
  const queue = routing.readQueue({ deskRoot });
  const entries = queue.payload.entries;
  const entry = entries.find((e) => e.candidateId === input.candidateId);
  if (!entry) fail('TRIAGE_CANDIDATE_NOT_IN_QUEUE', `${input.candidateId}（${queue.file}）`);
  if (!OUTCOMES.includes(input.outcome)) fail('TRIAGE_OUTCOME_INVALID', input.outcome);
  const research = RESEARCH_TYPES.includes(entry.candidateType);
  if (!research && !ENGINEERING_TYPES.includes(entry.candidateType)) fail('TRIAGE_BEHAVIOR_IS_OWNERS', entry.candidateType);
  if ((input.outcome === 'OPEN_QUESTION' && !research) || (input.outcome === 'FIX' && research)) fail('TRIAGE_OUTCOME_TYPE_MISMATCH', `${input.outcome}:${entry.candidateType}`);
  const effective = effectiveTriage().find((row) => row.candidate_id === entry.candidateId) || null;
  if (input.supersedes) {
    if (!effective || effective.record_id !== input.supersedes) fail('TRIAGE_SUPERSEDES_NOT_CURRENT', input.supersedes);
  } else {
    if (effective) fail('TRIAGE_ALREADY_RECORDED', `${entry.candidateId}:${effective.record_id}（改正请带 --supersedes）`);
    if (!waitsForTriage(entry)) fail('TRIAGE_NOT_PENDING', `${entry.candidateId}:${entry.triage ? entry.triage.state : entry.deskState}`);
  }
  if (!text(input.basisZh)) fail('TRIAGE_BASIS_MISSING');
  const directive = DIRECTIVE.find((word) => input.basisZh.includes(word));
  if (directive) fail('TRIAGE_WORDING', directive);
  if (!BEIJING.test(String(input.at || '')) || !Number.isFinite(Date.parse(input.at))) fail('TRIAGE_AT_NOT_BEIJING_TIME', input.at);
  const evidence = (input.evidence || []).map(evidenceItem);
  let reasonCode = null;
  if (input.outcome === 'OPEN_QUESTION') {
    if (!text(input.questionRef)) fail('TRIAGE_QUESTION_REF_MISSING');
  } else if (input.outcome === 'FIX') {
    if (!input.fixRef || !FIX_REPOS.includes(input.fixRef.repo) || !text(input.fixRef.ref)) fail('TRIAGE_FIX_REF_INVALID', JSON.stringify(input.fixRef || null));
  } else {
    reasonCode = input.reasonCode;
    if (!Object.prototype.hasOwnProperty.call(CODES, reasonCode || '')) fail('TRIAGE_CODE_NOT_REGISTERED', reasonCode);
    if (CODES[reasonCode] !== input.outcome) fail('TRIAGE_CODE_OUTCOME', `${reasonCode}:${input.outcome}`);
    const problem = evidenceProblem({ ...input, evidence }, entry, entries);
    if (problem) fail(`TRIAGE_${problem}`, reasonCode);
  }
  const body = {
    candidateId: entry.candidateId, questionKey: entry.questionKey, queueFile: queue.file, queueSha256: queue.sha256, outcome: input.outcome,
    reasonCode, questionRef: input.outcome === 'OPEN_QUESTION' ? input.questionRef : null, strategyRef: input.outcome === 'OPEN_QUESTION' ? entry.ledgerId : null,
    mergedInto: input.outcome === 'MERGE' ? input.mergedInto : null, fixRef: input.outcome === 'FIX' ? { repo: input.fixRef.repo, ref: input.fixRef.ref } : null,
    evidence, basisZh: input.basisZh, recordedBy: 'RESEARCH', sessionRef: orNull(input.sessionRef), at: input.at, supersedes: orNull(input.supersedes),
  };
  const recordHash = contentHash(body);
  const row = {
    schema: SCHEMA, record_id: `RTR-${recordHash.slice(0, 16)}`, record_hash: recordHash, candidate_id: body.candidateId, question_key: body.questionKey,
    queue_file: body.queueFile, queue_sha256: body.queueSha256, outcome: body.outcome, reason_code: body.reasonCode, question_ref: body.questionRef,
    strategy_ref: body.strategyRef, merged_into: body.mergedInto, fix_ref: body.fixRef, evidence: body.evidence, basis_zh: body.basisZh,
    recorded_by: 'RESEARCH', session_ref: body.sessionRef, triaged_at: body.at, supersedes: body.supersedes, production_effect: 'NONE',
    written_at: new Date().toISOString(),
  };
  return append(LEDGER(), row);
}

const monthDay = (iso) => new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(5, 10);

/**
 * 最新一份队列里等 Research 分诊、本机账本还没有分诊的候选（研究总览与 list_desk_triage 用）。读不到队列时为空。
 * @returns {{entries: object[], earliestDue: string|null, textZh: string}}
 */
function pendingTriage({ deskRoot, now = new Date() } = {}) {
  let entries = [];
  try { entries = routing.readQueue({ deskRoot }).payload.entries; } catch { entries = []; }
  const done = new Set(effectiveTriage().map((row) => row.candidate_id));
  const pending = entries.filter((e) => waitsForTriage(e) && !done.has(e.candidateId))
    .map((e) => ({ candidateId: e.candidateId, candidateType: e.candidateType, ledgerId: e.ledgerId, dueBy: e.triage ? e.triage.dueBy : null,
      overdue: Boolean(e.triage && e.triage.dueBy && Date.parse(e.triage.dueBy) <= now.getTime()), questionZh: e.questionZh || null }));
  const dues = pending.map((p) => p.dueBy).filter(Boolean).sort();
  const earliestDue = dues[0] || null;
  const textZh = pending.length
    ? `Desk 复盘待分诊 ${pending.length} 条${earliestDue ? `，最早 ${monthDay(earliestDue)} 到期` : ''}：${pending.map((p) => p.candidateId).join('、')}。`
    : 'Desk 复盘没有待分诊的候选。';
  return { entries: pending, earliestDue, textZh };
}

module.exports = { CODES, CODE_ZH, FIX_REPOS, LEDGER, OUTCOMES, SCHEMA, TriageError, deskRow, effectiveTriage, monthDay, pendingTriage, recordTriage, waitsForTriage };
