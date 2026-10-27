'use strict';

/**
 * 回程文件 QRP_RESEARCH_RETURN_V1（复盘闭环修订 6 主稿 §5.1，D8 ★；契约归 desk，生产者 QRP）：QRP 自己四本账本的投影，不带新的判断。
 *   - decisions[]：每个结果对象（result_id + part）当前的有效采用记录（services/research-adoption 的 effective()），
 *     带它指向的锁（基线锁／对比锁）的类别、三态、文件 sha256、锁定时刻与 K2 引用；有 desk 回链（links.jsonl 里 result_hash／result_ref 对上）
 *     时带 deskLink，来源记 DESK_REVIEW，否则 QRP_PROGRAM；
 *   - questions[]：研究计划里还没有封存结果的题（研究进度 stage.js 的 open 清单，状态词同页面：进行中／排队，等谁／待立题）；
 *     desk 研究队列来的题（DQ-…）还没有 QRP 的 K2，挑选状态归 desk，不在这里回传；
 *   - sources[]：四本账本字节的 sha256（文件不存在为 null）与行数。
 * 不改任何锁、判据或采用记录；只写调用方给的输出目录里的一份新文件（已存在就拒绝覆盖）。
 */
const fs = require('fs');
const path = require('path');
const { dataDir, read } = require('../../packages/ledger');
const { contentHash, sha256 } = require('./canonical');
const deskRouting = require('./index');

const CONTRACT = 'QRP_RESEARCH_RETURN_V1';
const LEDGERS = Object.freeze([
  'research/adoption_decisions.jsonl', 'research/baseline_evaluations.jsonl',
  'research/comparison_evaluations.jsonl', 'runtime-research-loop/links.jsonl',
]);

class ReturnExportError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new ReturnExportError(code, detail); };

function sourceOf(ledger) {
  const file = dataDir(...ledger.split('/'));
  let bytes = null;
  try { bytes = fs.readFileSync(file); } catch { bytes = null; }
  return { ledger, sha256: bytes ? sha256(bytes) : null, rows: bytes ? read(file).length : 0 };
}

const text = (value) => (typeof value === 'string' && value.trim() ? value : null);
const qOrder = (ref) => { const match = /^Q(\d+)$/.exec(ref || ''); return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER; };
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function titleOf(profile, notes, questionRef) {
  const queue = notes && notes.research_queue;
  if (questionRef === 'Q0') return text(queue && queue.baseline && queue.baseline.name_zh);
  const item = queue && queue.questions && queue.questions[questionRef];
  const plan = profile && profile.research_program.queue[questionRef];
  return text(item && item.name_zh) || text(plan && plan.title);
}

/** 回链按锁对上：result_hash = 锁文件 sha256，或 result_ref = QRP:<result_id>:LOCKED；只认 desk 研究队列来的回链。 */
function deskLinkOf(links, lock) {
  const ref = `QRP:${lock.result_id}:LOCKED`;
  const found = links.filter((link) => link.result_hash === lock.file_sha256 || link.result_ref === ref)
    .map((link) => deskRouting.deskOriginOf(link)).filter(Boolean)
    .sort((a, b) => compare(a.linkId, b.linkId))[0];
  return found ? { candidateId: found.candidateId, questionKey: found.questionKey, linkId: found.linkId } : null;
}

function decisionRows({ links }) {
  const adoption = require('../research-adoption');
  const baseline = require('../baseline-evaluation');
  const comparison = require('../candidate-comparison');
  const profiles = require('../strategy-profiles');
  const detailNotes = require('../strategy-detail-notes');
  const rows = [...adoption.effective().values()].map((record) => {
    const base = baseline.baselineFor(record.result_id);
    const cmp = base ? null : comparison.comparisonFor(record.result_id);
    const lock = base || cmp;
    if (!lock) fail('RETURN_LOCK_NOT_FOUND', record.result_id);
    const profile = profiles.get(record.strategy_ref);
    const notes = detailNotes.forStrategy(record.strategy_ref);
    const decided = record.kind === 'DECISION';
    const rec = record.coordinator_recommendation || null;
    const deskLink = deskLinkOf(links, lock);
    return {
      recordId: record.record_id, recordHash: record.record_hash, kind: record.kind,
      strategyRef: record.strategy_ref, caseRef: record.case_ref, questionRef: record.question_ref,
      questionTitleZh: titleOf(profile, notes, record.question_ref),
      resultId: record.result_id, part: record.part || null,
      lock: {
        class: base ? 'BASELINE' : 'COMPARISON', verdictState: lock.verdict_state, fileSha256: lock.file_sha256,
        lockedAt: lock.locked_at, k2Ref: text(lock.k2_ref),
      },
      decision: decided ? record.decision : null,
      recommendation: decided ? null : (rec ? rec.recommendation : null),
      recommendationReasonZh: decided ? null : text(rec && rec.reason_zh),
      ownerWords: decided ? text(record.owner_words) : null,
      decidedAt: decided ? record.decided_at : null,
      followUpZh: decided ? text(record.follow_up_zh) : null,
      deskLink, origin: deskLink ? 'DESK_REVIEW' : 'QRP_PROGRAM',
    };
  });
  return rows.sort((a, b) => compare(a.strategyRef, b.strategyRef) || qOrder(a.questionRef) - qOrder(b.questionRef)
    || compare(a.questionRef, b.questionRef) || compare(a.part || '', b.part || '') || compare(a.resultId, b.resultId));
}

function questionRows({ links, cases }) {
  const profiles = require('../strategy-profiles');
  const stage = require('../research-workspace/stage');
  const out = [];
  for (const profile of profiles.list()) {
    const facts = stage.factsOf(profile.strategy_ref, { cases: [], m4Items: [] });
    const caseLinks = links.filter((link) => cases.has(link.case_ref) && cases.get(link.case_ref).strategy_ref === profile.strategy_ref);
    for (const item of facts.open.filter((row) => row.question_ref)) {
      const origin = caseLinks.filter((link) => link.research_question_ref === item.question_ref)
        .map((link) => deskRouting.deskOriginOf(link)).filter(Boolean).sort((a, b) => compare(a.linkId, b.linkId))[0] || null;
      const deskLink = origin ? { candidateId: origin.candidateId, questionKey: origin.questionKey, linkId: origin.linkId } : null;
      out.push({
        strategyRef: profile.strategy_ref, questionRef: item.question_ref, titleZh: item.title_zh,
        stateZh: stage.PHASE_WORDS[item.phase](item), k2FrozenAt: null, expectedResultDate: null,
        deskLink, origin: deskLink ? 'DESK_REVIEW' : 'QRP_PROGRAM',
      });
    }
  }
  return out;
}

/** 四本账本里最晚的一行时刻（采用记录 written_at、锁 locked_at、回链 recorded_at）；一行都没有时为 null。 */
function asOfOf(rowsByLedger) {
  const times = rowsByLedger.flatMap((rows) => rows.map((row) => row.written_at || row.locked_at || row.recorded_at))
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  return times.length ? new Date(Math.max(...times.map((value) => Date.parse(value)))).toISOString() : null;
}

/** 组装回程 payload（不写文件）。`generatedAt` 默认现在。 */
function buildReturn({ generatedAt = new Date().toISOString() } = {}) {
  const loop = require('../runtime-research-loop');
  const links = loop.listLinks();
  const cases = new Map(loop.listCases().map((row) => [row.case_id, row]));
  const sources = LEDGERS.map(sourceOf);
  const asOf = asOfOf(LEDGERS.map((ledger) => read(dataDir(...ledger.split('/'))))) || generatedAt;
  const payload = {
    schemaVersion: 1, contract: CONTRACT, producer: 'QRP', generatedAt, asOf, sources,
    decisions: decisionRows({ links }), questions: questionRows({ links, cases }),
    interpretation: 'RESEARCH_RESULTS_AND_OWNER_DECISIONS_NOT_ORDERS', realOrder: 0, brokerWrite: false,
  };
  payload.hash = contentHash(payload);
  return payload;
}

/** QRP_RESEARCH_RETURN_<YYYYMMDDTHHMMZ>.json（UTC，取 generatedAt）。 */
function fileNameOf(generatedAt) {
  const stamp = new Date(generatedAt).toISOString().replace(/[-:]/g, '').slice(0, 13);
  return `QRP_RESEARCH_RETURN_${stamp}Z.json`;
}

/** 写到 `outDir`（必填，没有默认目录）；同名文件已存在时拒绝，不覆盖。返回 {file, sha256, payload}。 */
function exportReturn({ outDir, generatedAt } = {}) {
  if (typeof outDir !== 'string' || !outDir.trim()) fail('RETURN_OUT_DIR_REQUIRED');
  const payload = buildReturn(generatedAt ? { generatedAt } : {});
  const dir = path.resolve(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileNameOf(payload.generatedAt));
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  try { fs.writeFileSync(file, bytes, { flag: 'wx' }); } catch (error) {
    if (error.code === 'EEXIST') fail('RETURN_FILE_EXISTS', file);
    throw error;
  }
  return { file, sha256: sha256(bytes), payload };
}

module.exports = { CONTRACT, LEDGERS, ReturnExportError, buildReturn, exportReturn, fileNameOf };
