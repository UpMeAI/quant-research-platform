'use strict';

/**
 * Step 11: the conclusion goes back into the next weekly review's fact pack (REVIEW_AI_FACT_PACK_V1) as one fact. Generator-facing: pass / fail / pending and
 * reason codes only, never a metric (amendment section 2.2). The pack is checked by the AQ agent's own checkPack before it is written.
 */
const { sha256, text, isObj } = require('./common');
const { checkPack } = require('../research-queue-agent/facts');

const FEEDBACK_SCHEMA = 'LAB_FEEDBACK_V1';
const nextFactId = (pack) => `F-${String(pack.facts.reduce((m, f) => Math.max(m, Number(/^F-(\d+)$/.exec(f.id || '')?.[1] || 0)), 0) + 1).padStart(3, '0')}`;

/** @returns {{ok: true, feedback_text, pack_text, fact} | {ok: false, reason_code}} */
function build({ cardId, asOf, labCandidateId, terminalState, verdict, reasonCodes, chainHeadSha256, basePack }) {
  if (!isObj(basePack) || !Array.isArray(basePack.facts)) return { ok: false, reason_code: 'LAB_FEEDBACK_BASE_PACK_INVALID' };
  const feedback = { schema: FEEDBACK_SCHEMA, card_id: cardId, lab_candidate_id: labCandidateId, terminal_state: terminalState, verdict, reason_codes: [...reasonCodes], chain_head_sha256: chainHeadSha256, as_of: asOf };
  const feedbackText = text(feedback);
  const fact = { id: nextFactId(basePack), source: { path: `lab/${cardId}/feedback.json`, sha256: sha256(feedbackText), pointer: '/' }, at: asOf,
    value: { candidate_id: labCandidateId, terminal_state: terminalState, verdict, reason_codes: [...reasonCodes] } };
  const pack = { ...basePack, facts: [...basePack.facts, fact] };
  const c = checkPack(pack, { purpose: 'CARD', maxTokens: Infinity });
  if (!c.ok) return { ok: false, reason_code: `LAB_FEEDBACK_PACK_INVALID_${c.errors[0].code}` };
  return { ok: true, feedback_text: feedbackText, pack_text: text(pack), fact };
}

/** The generator-facing class of a terminal state. INSUFFICIENT is never "fail". */
function verdictClass({ terminalState, engineVerdict }) {
  if (terminalState === 'FROZEN_AWAITING_HOLDOUT' || terminalState === 'PAUSED') return 'pending';
  if (terminalState === 'NOT_SELECTED_BY_VALIDATION' || terminalState === 'SEALED_FAILURE_LIBRARY') return 'fail';
  return engineVerdict === 'PASS' ? 'pass' : engineVerdict === 'FAIL' ? 'fail' : 'pending';
}

/** Is the feedback fact in this pack? (the acceptance checker's C5 test) */
function findIn(pack, feedbackSha256) {
  if (!isObj(pack) || !Array.isArray(pack.facts)) return null;
  return pack.facts.find((f) => isObj(f) && isObj(f.source) && f.source.sha256 === feedbackSha256) || null;
}

module.exports = { FEEDBACK_SCHEMA, build, verdictClass, findIn, checkPack };
