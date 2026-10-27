'use strict';

/**
 * Desk 复盘 → QRP 研究问题 → 采用结论回到 Desk 的 QRP 一侧（复盘闭环验收 V1 修订 6 主稿 §4、§5、§6.3，D6–D8 ★；
 * QRP 一侧说明 docs/DESK_REVIEW_ROUTING_QRP_SIDE_NOTE_2026-10-27.draft.md）。
 *
 * 只读 desk：本机 desk checkout（QRP_DESK_ROOT，默认与 QRP 同级的 portfolio-desk，同 services/desk-strategy-directory）里
 *   - `docs/review-loop/research-queue/REVIEW_LOOP_RESEARCH_QUEUE_<周>[_R<n>].json`（REVIEW_LOOP_RESEARCH_QUEUE_V1，desk 契约，生产者 COORDINATOR）；
 *   - `docs/review-loop/REVIEW_LOOP_WEEK_*.json`（REVIEW_LOOP_WEEK_V1；可选块 researchReturns[] 引用 QRP 采用记录）。
 * QRP 自己只写一处：导入时按 questionKey 在 runtime-research-loop 的 links.jsonl 登记一条回链（QRP_DATA_DIR，gitignored）。
 * Owner 挑选、出现周数、题目原文这些 desk 状态一律不存：显示时现读最新一份队列（QRP 闭环验收 D1「不复制 Desk 状态机」）。
 * QRP 仓库是公开的：这里读到的 desk 事实不进 git、文档或证据包（§6.3）。
 *
 * 复盘闭环修订 7（2026-10-27 冻结 FREEZE_1）：候选不再等 Owner 挑选，由 Research 分诊（./triage.js）。队列也列工程类候选（只进分诊清单，
 * 不建回链）；状态词先看 Owner 的选择，再看队列里的 triage 块。队列与周档从 QRP_DESK_REVIEW_LOOP_ROOT（Mac 上的复盘镜像，定时周编推送的
 * 那个提交）读，没设时照旧读 QRP_DESK_ROOT。
 */
const fs = require('fs');
const path = require('path');
const { canonicalJson, contentHash, sha256 } = require('./canonical');

const DEFAULT_DESK_ROOT = path.resolve(__dirname, '../../../portfolio-desk');
const WEEK_DIR = path.join('docs', 'review-loop');
const QUEUE_DIR = path.join('docs', 'review-loop', 'research-queue');
const QUEUE_FILE = /^REVIEW_LOOP_RESEARCH_QUEUE_(\d{4})-W(\d{2})(?:_R([1-9]\d*))?\.json$/;
const WEEK_FILE = /^REVIEW_LOOP_WEEK_(\d{4})-W(\d{2})(?:_R([1-9]\d*))?\.json$/;
const QUEUE_CONTRACT = 'REVIEW_LOOP_RESEARCH_QUEUE_V1';
const QUEUE_CONSTANTS = Object.freeze({
  schemaVersion: 1, contract: QUEUE_CONTRACT, producer: 'COORDINATOR', routes: 'REVIEW_LOOP_DEFAULT_ROUTES@v1',
  interpretation: 'RESEARCH_INTAKE_FACTS_NOT_ORDERS', realOrder: 0, brokerWrite: false,
});
const QUESTION_KEY = /^RQK-[0-9a-f]{16}$/;
const CANDIDATE_ID = /^RLC-(CN|US|CRYPTO)-\d{4}W\d{2}-[1-9]\d*$/;
const WEEK_ID = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PICKS = Object.freeze([null, 'RESEARCH', 'MERGE', 'DONT', 'LATER']);
const EVIDENCE_PREFIX = 'portfolio-desk:docs/review-loop/research-queue/';

class DeskRoutingError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new DeskRoutingError(code, detail); };
const need = (ok, code, detail) => { if (!ok) fail(code, detail); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

const deskRootOf = (deskRoot = process.env.QRP_DESK_ROOT || DEFAULT_DESK_ROOT) => path.resolve(deskRoot);
/** 修订 7 §4.4：研究队列与周档的根——显式参数，再是复盘镜像，再是 desk checkout。策略目录不走这里。 */
const reviewLoopRootOf = (deskRoot) => path.resolve(deskRoot || process.env.QRP_DESK_REVIEW_LOOP_ROOT || process.env.QRP_DESK_ROOT || DEFAULT_DESK_ROOT);
const RESEARCH_TYPES = Object.freeze(['PARAMETER', 'RULE']);

/** 按 (年, 周, 修订号) 排序；文件名就是顺序，不看 mtime。 */
function orderOf(name, pattern) {
  const match = pattern.exec(name);
  return match ? [Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : 0] : null;
}
const byOrder = (pattern) => (a, b) => {
  const left = orderOf(a, pattern);
  const right = orderOf(b, pattern);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
};

function listQueueFiles(deskRoot) {
  const dir = path.join(reviewLoopRootOf(deskRoot), QUEUE_DIR);
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  return names.filter((name) => QUEUE_FILE.test(name)).sort(byOrder(QUEUE_FILE));
}

function listWeekFiles(deskRoot) {
  const dir = path.join(reviewLoopRootOf(deskRoot), WEEK_DIR);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((name) => WEEK_FILE.test(name)).sort(byOrder(WEEK_FILE));
}

function checkEntry(entry, index) {
  const at = `entries[${index}]`;
  need(isObject(entry), 'DESK_QUEUE_ENTRY_INVALID', at);
  need(QUESTION_KEY.test(entry.questionKey || ''), 'DESK_QUEUE_ENTRY_INVALID', `${at}.questionKey`);
  need(CANDIDATE_ID.test(entry.candidateId || ''), 'DESK_QUEUE_ENTRY_INVALID', `${at}.candidateId`);
  need(/^[A-Z][A-Z0-9_]*$/.test(entry.ledgerId || ''), 'DESK_QUEUE_ENTRY_INVALID', `${at}.ledgerId`);
  need(WEEK_ID.test(entry.firstWeek || ''), 'DESK_QUEUE_ENTRY_INVALID', `${at}.firstWeek`);
  // 修订 7 §4.5：工程类候选没有研究问题句（null）。
  need(isText(entry.questionZh) || (!RESEARCH_TYPES.includes(entry.candidateType) && entry.questionZh === null), 'DESK_QUEUE_ENTRY_INVALID', `${at}.questionZh`);
  need(isObject(entry.ownerPick) && PICKS.includes(entry.ownerPick.choice), 'DESK_QUEUE_ENTRY_INVALID', `${at}.ownerPick.choice`);
  need(entry.mergedInto === null || isText(entry.mergedInto), 'DESK_QUEUE_ENTRY_INVALID', `${at}.mergedInto`);
}

/**
 * 读一份研究队列并核对（失败关闭）：文件级常量、payload hash（desk 深排序 hash）、sourceWeek（周档在 docs/review-loop/ 下、
 * 文件字节的 sha256 与 sourceWeek.sha256 相等、周档自己的 hash 字段等于 sourceWeek.hash 且能按同一算法复算），
 * 以及每行导入要用的字段。`file` 不给 = 目录里最新的一份（按周与修订号）。
 */
function readQueue({ deskRoot, file = null } = {}) {
  const root = reviewLoopRootOf(deskRoot);
  let name = file;
  if (!name) {
    const files = listQueueFiles(root);
    need(files, 'DESK_QUEUE_DIR_MISSING', path.join(root, QUEUE_DIR));
    need(files.length, 'DESK_QUEUE_NONE', path.join(root, QUEUE_DIR));
    name = files[files.length - 1];
  }
  name = path.basename(name);
  need(QUEUE_FILE.test(name), 'DESK_QUEUE_FILE_NAME_INVALID', name);
  const full = path.join(root, QUEUE_DIR, name);
  let bytes;
  try { bytes = fs.readFileSync(full); } catch { fail('DESK_QUEUE_FILE_MISSING', full); }
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { fail('DESK_QUEUE_NOT_JSON', name); }
  need(isObject(payload), 'DESK_QUEUE_NOT_JSON', name);
  for (const [key, value] of Object.entries(QUEUE_CONSTANTS)) need(payload[key] === value, 'DESK_QUEUE_CONTRACT_INVALID', `${key}=${JSON.stringify(payload[key])}`);
  need(WEEK_ID.test(payload.weekId || ''), 'DESK_QUEUE_CONTRACT_INVALID', 'weekId');
  need(HEX64.test(payload.hash || ''), 'DESK_QUEUE_HASH_INVALID', name);
  let recomputed;
  try { recomputed = contentHash(payload); } catch (error) { fail('DESK_QUEUE_HASH_INVALID', error.message); }
  need(recomputed === payload.hash, 'DESK_QUEUE_HASH_MISMATCH', `${name}:${payload.hash.slice(0, 12)}…≠${recomputed.slice(0, 12)}…`);

  const week = payload.sourceWeek;
  need(isObject(week) && WEEK_FILE.test(week.file || '') && path.basename(week.file) === week.file, 'DESK_QUEUE_SOURCE_WEEK_INVALID', 'sourceWeek.file');
  need(HEX64.test(week.sha256 || '') && HEX64.test(week.hash || ''), 'DESK_QUEUE_SOURCE_WEEK_INVALID', 'sourceWeek.sha256/hash');
  const weekFile = path.join(root, WEEK_DIR, week.file);
  let weekBytes;
  try { weekBytes = fs.readFileSync(weekFile); } catch { fail('DESK_QUEUE_SOURCE_WEEK_MISSING', week.file); }
  need(sha256(weekBytes) === week.sha256, 'DESK_QUEUE_SOURCE_WEEK_SHA256_MISMATCH', week.file);
  let weekPayload;
  try { weekPayload = JSON.parse(weekBytes.toString('utf8')); } catch { fail('DESK_QUEUE_SOURCE_WEEK_NOT_JSON', week.file); }
  need(isObject(weekPayload) && weekPayload.hash === week.hash, 'DESK_QUEUE_SOURCE_WEEK_HASH_MISMATCH', week.file);
  let weekRecomputed;
  try { weekRecomputed = contentHash(weekPayload); } catch { weekRecomputed = null; }
  need(weekRecomputed === weekPayload.hash, 'DESK_QUEUE_SOURCE_WEEK_HASH_MISMATCH', `${week.file}（周档 hash 复算不符）`);

  need(Array.isArray(payload.entries), 'DESK_QUEUE_CONTRACT_INVALID', 'entries');
  payload.entries.forEach(checkEntry);
  const keys = payload.entries.map((entry) => entry.questionKey);
  need(new Set(keys).size === keys.length, 'DESK_QUEUE_ENTRY_INVALID', 'questionKey 重复');
  return { file: name, path: full, sha256: sha256(bytes), payload };
}

/** 一条回链的 link_id：RRL- + sha256(canonical {case_ref, questionKey}) 前 16 位。同一 case 的同一问题跨周只有一个。 */
const linkIdOf = (caseRef, questionKey) => `RRL-${sha256(canonicalJson({ case_ref: caseRef, questionKey })).slice(0, 16)}`;
const evidenceRefOf = (file, questionKey) => `${EVIDENCE_PREFIX}${file}#${questionKey}`;
/** 回链来自 desk 研究队列时，取出它的 questionKey 与首次出现的队列文件；不是的返回 null。 */
function deskOriginOf(link) {
  const match = /^portfolio-desk:docs\/review-loop\/research-queue\/(REVIEW_LOOP_RESEARCH_QUEUE_[^#/]+\.json)#(RQK-[0-9a-f]{16})$/.exec((link && link.desk_evidence_ref) || '');
  if (!match || !CANDIDATE_ID.test(link.desk_candidate_ref || '')) return null;
  return { file: match[1], questionKey: match[2], candidateId: link.desk_candidate_ref, linkId: link.link_id };
}

/**
 * 「并入」时回链挂到那个已有的 QRP 题（主稿 §4.3、QRP 一侧说明 §2 第 1 条）：只在首次登记时 Owner 已选 MERGE、
 * 且 mergedInto 是这条策略研究计划里的题号时才用它；否则（未挑选、并入 desk 候选号等）写 DQ-<questionKey>。
 */
function questionRefOf(entry, profile) {
  const pick = entry.ownerPick || {};
  const queue = (profile && profile.research_program && profile.research_program.queue) || {};
  if (pick.choice === 'MERGE' && isText(entry.mergedInto) && Object.prototype.hasOwnProperty.call(queue, entry.mergedInto)) return entry.mergedInto;
  return `DQ-${entry.questionKey}`;
}

/**
 * 导入一份研究队列（默认最新一份）。每行：按 ledgerId 找策略档案（strategy_ref）→ 确认运行态 case 存在（`openCases` 为真时按档案事实补开）
 * → link_id 已存在什么也不写；不存在就用 registerReviewQuestion 登记一条。某行登记不了（档案未登记、case 开不了）记入 refused 并继续下一行。
 * 文件级核对不过时整份拒收，什么也不写。返回摘要（只给调用方看，不落盘）。
 */
function importQueue({ deskRoot, file = null, openCases = false, recordedAt = null, caseOptions = {} } = {}) {
  const loop = require('../runtime-research-loop');
  const profiles = require('../strategy-profiles');
  const profileCases = require('../runtime-research-loop/profile_cases');
  const queue = readQueue({ deskRoot, file });
  const out = {
    queue: { file: queue.file, sha256: queue.sha256, weekId: queue.payload.weekId, revision: queue.payload.revision, entries: queue.payload.entries.length },
    registered: [], unchanged: [], refused: [], engineering: [],
  };
  for (const entry of queue.payload.entries) {
    const row = { questionKey: entry.questionKey, candidateId: entry.candidateId, ledgerId: entry.ledgerId };
    // 修订 7 §4.5：工程类候选只进分诊清单，不登记成研究问题。
    if (!RESEARCH_TYPES.includes(entry.candidateType)) { out.engineering.push(row); continue; }
    const profile = profiles.list().find((item) => item.strategy_ref === entry.ledgerId) || null;
    if (!profile) { out.refused.push({ ...row, code: 'DESK_QUEUE_ENTRY_STRATEGY_NOT_REGISTERED' }); continue; }
    let caseRec = loop.listCases().find((item) => item.case_id === profile.case_ref) || null;
    if (!caseRec && openCases) {
      try { caseRec = profileCases.ensureProfileCase(profile.strategy_ref, caseOptions); } catch (error) {
        out.refused.push({ ...row, code: 'DESK_QUEUE_ENTRY_CASE_NOT_OPENED', reason: error.message });
        continue;
      }
    }
    if (!caseRec) { out.refused.push({ ...row, code: 'DESK_QUEUE_ENTRY_CASE_NOT_OPEN', reason: `${profile.case_ref}（加 --open-cases 按档案补开）` }); continue; }
    const linkId = linkIdOf(profile.case_ref, entry.questionKey);
    if (loop.listLinks().some((link) => link.link_id === linkId)) { out.unchanged.push({ ...row, linkId }); continue; }
    const link = loop.registerReviewQuestion(profile.case_ref, {
      link_id: linkId, desk_candidate_ref: entry.candidateId, desk_evidence_ref: evidenceRefOf(queue.file, entry.questionKey),
      desk_evidence_hash: queue.sha256, research_question_ref: questionRefOf(entry, profile), ...(recordedAt ? { recorded_at: recordedAt } : {}),
    });
    out.registered.push({ ...row, linkId: link.link_id, caseRef: link.case_ref, researchQuestionRef: link.research_question_ref });
  }
  return out;
}

// ── 显示时现读（失败软化：读不到、校验不过一律当作没有，不抛错）────────────────────────────────

/** 最新一份能通过核对的研究队列的行（Map：questionKey → 行）；没有或读不出来返回空 Map。 */
function newestQueueEntries({ deskRoot } = {}) {
  try {
    const files = listQueueFiles(deskRoot) || [];
    for (const name of [...files].reverse()) {
      try {
        const queue = readQueue({ deskRoot, file: name });
        return new Map(queue.payload.entries.map((entry) => [entry.questionKey, entry]));
      } catch { /* 这一份不过，退到上一份 */ }
    }
  } catch { /* 目录读不出来 */ }
  return new Map();
}

/**
 * 这条 desk 候选现在的状态词（修订 7 §5.2）：Owner 的选择优先（原话记在 desk），再看队列的 triage 块——
 * 待研究分诊（到期日；过期写已逾期几天）、研究已立题、并入、研究判不做（码的中文）、转工程修复。词表之外返回 null。
 */
function pickWords(entry, { now = new Date() } = {}) {
  if (!entry || !isObject(entry.ownerPick)) return null;
  const choice = entry.ownerPick.choice;
  if (choice !== null) {
    const owner = { DONT: 'Owner 不做', RESEARCH: 'Owner 立研究，待冻结 K2', MERGE: `并入 ${entry.mergedInto || '（并入对象未写）'}`, LATER: 'Owner 先放着' };
    return Object.prototype.hasOwnProperty.call(owner, choice) ? owner[choice] : null;
  }
  const t = entry.triage;
  if (!t || t.state === 'PENDING') {
    if (!t || !t.dueBy) return '待研究分诊';
    const { monthDay } = require('./triage');
    const late = Math.floor((now.getTime() - Date.parse(t.dueBy)) / 86400000);
    return now.getTime() >= Date.parse(t.dueBy) ? `待研究分诊，已逾期 ${late} 天` : `待研究分诊（${monthDay(t.dueBy)} 前）`;
  }
  if (t.state !== 'APPLIED') return null;
  const { CODE_ZH } = require('./triage');
  const words = {
    OPEN_QUESTION: `研究已立题${t.questionRef ? ` ${t.questionRef}` : ''}，待冻结 K2`, MERGE: `并入 ${t.mergedInto || '（并入对象未写）'}`,
    CLOSE: `研究判不做：${CODE_ZH[t.reasonCode] || t.reasonCode}`, FIX: `转工程修复（${t.fixRef ? t.fixRef.repo : '仓库未写'}）`,
  };
  return Object.prototype.hasOwnProperty.call(words, t.outcome) ? words[t.outcome] : null;
}

/**
 * 一条 desk 来的回链在页面上怎么写：题名（最新队列的 questionZh）、来源「Desk 复盘 <候选号> · <首次出现的周>」、状态（Owner 挑选）。
 * 不是 desk 研究队列来的回链返回 null；最新队列里没有这一题时题名与状态写明「最新一份 Desk 研究队列未列出」。
 */
function deskQuestionView(link, entries) {
  const origin = deskOriginOf(link);
  if (!origin) return null;
  const entry = entries.get(origin.questionKey) || null;
  return {
    question_key: origin.questionKey, candidate_id: origin.candidateId,
    title_zh: entry ? entry.questionZh : 'Desk 研究问题（最新一份 Desk 研究队列未列出）',
    source_zh: entry ? `Desk 复盘 ${entry.candidateId} · ${entry.firstWeek}` : `Desk 复盘 ${origin.candidateId}`,
    state_zh: entry ? pickWords(entry) || '挑选状态未登记' : '最新一份 Desk 研究队列未列出',
  };
}

/**
 * desk 周档 researchReturns[] 里引用到的 QRP 采用记录（Set：`record_id|record_hash`）。只认文件名合规、payload hash 复算一致的周档；
 * 读不出来、hash 不符、没有这个块都当作没有引用。
 */
function returnCitations({ deskRoot } = {}) {
  const cited = new Set();
  try {
    const root = reviewLoopRootOf(deskRoot);
    for (const name of listWeekFiles(root)) {
      try {
        const payload = JSON.parse(fs.readFileSync(path.join(root, WEEK_DIR, name), 'utf8'));
        if (!isObject(payload) || !Array.isArray(payload.researchReturns) || contentHash(payload) !== payload.hash) continue;
        for (const row of payload.researchReturns) {
          if (isObject(row) && isText(row.recordId) && HEX64.test(row.recordHash || '')) cited.add(`${row.recordId}|${row.recordHash}`);
        }
      } catch { /* 这一份读不出来，跳过 */ }
    }
  } catch { /* desk 根读不出来 */ }
  return cited;
}

/**
 * 「已有 N 项回到 Desk」（主稿 §5.3）：这条策略 kind = DECISION 的 QRP 采用记录里，被某份 desk 周档 researchReturns[] 引用、
 * recordId 与 recordHash 都一致的，按结果对象（result_id + part）计数——同一对象改过决定、新旧两条都被引用时只算一项。
 */
function returnedToDeskCount(records, cited) {
  const items = new Set();
  for (const row of records) {
    if (row.kind === 'DECISION' && cited.has(`${row.record_id}|${row.record_hash}`)) items.add(`${row.result_id}|${row.part || ''}`);
  }
  return items.size;
}

module.exports = {
  DEFAULT_DESK_ROOT, QUEUE_DIR, WEEK_DIR, QUEUE_CONTRACT, EVIDENCE_PREFIX, DeskRoutingError,
  deskRootOf, reviewLoopRootOf, listQueueFiles, listWeekFiles, readQueue, linkIdOf, evidenceRefOf, deskOriginOf, questionRefOf, importQueue,
  newestQueueEntries, pickWords, deskQuestionView, returnCitations, returnedToDeskCount,
};
