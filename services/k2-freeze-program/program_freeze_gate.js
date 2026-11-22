'use strict';

/**
 * Importer acceptance of program freeze pages (RF1118 C3, AQ-39). Wired into the sealed-verdict importers' checkEntry after G-PARITY.
 * A K2 whose section 0 says `冻结者 K2_FREEZE_PROGRAM_V1` is accepted only with: the freeze page (sha256 bound), the validation report whose sha256 the
 * page names and whose 14 results all pass, k2_frozen_at equal to the page's and not before RF1118 took effect, and exactly one K2_PROGRAM_FROZEN
 * queue line for that K2 sha that also names this page. Anything missing is a refusal (K2_FREEZE_PROGRAM_*); an unreadable queue log is
 * QUEUE_LOG_UNAVAILABLE, not "no line". A K2 frozen by the coordinator, or before this section existed, is untouched: the lock row gains no field.
 */
const { ProgramError, sha256, isObj, SHA64 } = require('./common');
const ROBUSTNESS_LINE = require('../../config/independent_verifier.v1.json').robustness.declarationLine;
const rf1118 = require('./rf1118');
const queueLine = require('./queue_line');

const FROZEN_BY_LABEL = '**作者与冻结者**：';
const PROGRAM = 'K2_FREEZE_PROGRAM_V1';
const VALIDATORS = Object.freeze(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14']);
const NA_ALLOWED = Object.freeze({ V10: 'HUMAN_AUTHORED', V14: 'HUMAN_AUTHORED' });

const fail = (code, detail) => { throw new ProgramError(`K2_FREEZE_PROGRAM_${code}`, detail); };
const need = (c, code, detail) => { if (!c) fail(code, detail); };
const BLOCK = /```json K2_PROGRAM_FREEZE_PAGE_V1\n([\s\S]*?)\n```/;

function frozenByOf(text) {
  const at = text.indexOf(FROZEN_BY_LABEL);
  if (at < 0) return null;
  const line = text.slice(at + FROZEN_BY_LABEL.length).split('\n')[0];
  if (line.includes(`冻结者 ${PROGRAM}`)) return PROGRAM;
  if (line.includes('冻结者 COORDINATOR')) return 'COORDINATOR';
  return fail('FROZEN_BY_INVALID', line.slice(0, 60));
}

/**
 * @param {object} entry  registry entry; entry.freeze_program = { page: {sha256, ...spec}, report: {sha256, ...spec} } for program-frozen K2s
 * @param {{k2Bytes?: () => Buffer, pageBytes?: () => Buffer|null, reportBytes?: () => Buffer|null, queueLogText?: () => string|null}} files
 * @param {{effectiveFrom?: string}} [opts]
 */
function check(entry, { k2Bytes, pageBytes = () => null, reportBytes = () => null, queueLogText = () => null } = {}, { effectiveFrom = rf1118.EFFECTIVE_FROM } = {}) {
  if (!entry.k2 || entry.kind === 'DRAFT') return { applies: false, reason: entry.k2 ? 'DRAFT_NOT_FROZEN' : 'NO_K2' };
  const text = k2Bytes().toString('utf8');
  const by = frozenByOf(text);
  if (by !== PROGRAM) {
    need(entry.freeze_program === undefined || entry.freeze_program === null, 'BINDING_ON_UNGATED', entry.id);
    return { applies: false, reason: by === null ? 'NOT_PROGRAM_FROZEN' : 'COORDINATOR_FREEZE' };
  }
  const fp = entry.freeze_program;
  need(isObj(fp) && isObj(fp.page) && isObj(fp.report), 'PAGE_MISSING', entry.id);
  const page = pageBytes();
  need(page, 'PAGE_MISSING', `${entry.id}:bytes`);
  need(sha256(page) === fp.page.sha256, 'PAGE_SHA256_MISMATCH', entry.id);
  const m = BLOCK.exec(page.toString('utf8'));
  need(m, 'PAGE_INVALID', entry.id);
  let block;
  try { block = JSON.parse(m[1]); } catch { fail('PAGE_INVALID', `${entry.id}:json`); }
  need(isObj(block) && block.schema === 'K2_PROGRAM_FREEZE_PAGE_V1' && block.frozen_by === PROGRAM, 'PAGE_INVALID', `${entry.id}:fields`);
  need(block.k2_sha256 === entry.k2.sha256, 'K2_SHA256_MISMATCH', entry.id);
  // Q3b: the freeze event also froze the candidate's PROMOTION_TERMS_V1 and the K2 carries the V-5 declaration line; a page without either is refused
  need(isObj(block.promotion_terms) && typeof block.promotion_terms.sha256 === 'string' && SHA64.test(block.promotion_terms.sha256), 'TERMS_SHA_MISSING', entry.id);
  need(typeof block.robustness_declaration_sha256 === 'string' && SHA64.test(block.robustness_declaration_sha256), 'ROBUSTNESS_SHA_MISSING', entry.id);
  const decl = new RegExp(`^${ROBUSTNESS_LINE}: ([0-9a-f]{64})\\s*$`, 'm').exec(text);
  need(decl && decl[1] === block.robustness_declaration_sha256, 'ROBUSTNESS_K2_LINE_MISMATCH', entry.id);
  const report = reportBytes();
  need(report, 'REPORT_MISSING', entry.id);
  need(sha256(report) === block.report_sha256 && sha256(report) === fp.report.sha256, 'REPORT_MISMATCH', entry.id);
  let doc;
  try { doc = JSON.parse(report.toString('utf8')); } catch { fail('REPORT_INVALID', `${entry.id}:json`); }
  need(isObj(doc) && doc.schema === 'K2_PREREG_VALIDATION_REPORT_V1' && doc.k2_sha256 === block.k2_sha256 && Array.isArray(doc.results), 'REPORT_INVALID', entry.id);
  const ids = doc.results.map((r) => r.v);
  need(ids.length === VALIDATORS.length && VALIDATORS.every((v, i) => ids[i] === v), 'REPORT_NOT_ALL_PASS', `${entry.id}:validators`);
  for (const r of doc.results) {
    const ok = r.state === 'PASS' || (r.state === 'NOT_APPLICABLE' && NA_ALLOWED[r.v] === r.reason);
    need(ok, 'REPORT_NOT_ALL_PASS', `${entry.id}:${r.v}:${r.state}`);
  }
  need(doc.all_pass === true, 'REPORT_NOT_ALL_PASS', `${entry.id}:all_pass`);
  need(doc.promotion_terms_sha256 === block.promotion_terms.sha256 && doc.robustness_declaration_sha256 === block.robustness_declaration_sha256, 'REPORT_MISMATCH', `${entry.id}:q3b_shas`);
  need(entry.k2_frozen_at === block.k2_frozen_at, 'FROZEN_AT_MISMATCH', `${entry.id}:${entry.k2_frozen_at}≠${block.k2_frozen_at}`);
  need(block.rf1118 && block.rf1118.sha256 === rf1118.FREEZE.sha256, 'RF1118_NOT_BOUND', entry.id);
  need(Date.parse(block.k2_frozen_at) >= Date.parse(effectiveFrom), 'BEFORE_RF1118', `${entry.id}:${block.k2_frozen_at}`);
  const log = queueLogText();
  need(typeof log === 'string', 'QUEUE_LOG_UNAVAILABLE', entry.id);
  const lines = queueLine.parse(log).filter((l) => l.k2_sha256 === block.k2_sha256);
  need(lines.length !== 0, 'QUEUE_LINE_MISSING', entry.id);
  need(lines.length === 1, 'QUEUE_LINE_DUPLICATE', `${entry.id}:${lines.length}`);
  need(lines[0].page_sha256 === fp.page.sha256 && lines[0].draft_id === block.draft_id && lines[0].market === block.market, 'QUEUE_LINE_MISSING', `${entry.id}:line_differs`);
  return { applies: true, state: 'PASS', frozen_by: PROGRAM, k2_sha256: block.k2_sha256, k2_frozen_at: block.k2_frozen_at, page_sha256: fp.page.sha256, report_sha256: block.report_sha256,
    promotion_terms_sha256: block.promotion_terms.sha256, robustness_declaration_sha256: block.robustness_declaration_sha256, program_sha256: block.program_sha256, authored_by: block.authored_by, trial_ids: block.trial_ids, rf1118_sha256: block.rf1118.sha256, queue_line: { host: lines[0].host, market: lines[0].market } };
}

module.exports = { PROGRAM, VALIDATORS, FROZEN_BY_LABEL, check };
