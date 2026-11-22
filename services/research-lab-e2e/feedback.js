'use strict';

/**
 * Step 11 (always the last step, whatever the terminal state): the conclusion goes to the queue intake as LAB_FEEDBACK_FACTS_V1 (plan-coord ruling 11-23 (6)); the Q1 producer
 * (services/research-queue/rq/producer.py merge_lab_feedback) merges it into the next card's fact pack with ids of its own, QRP only, no desk change.
 * Generator-facing (amendment section 2.2): pass / fail / pending and reason codes, never a metric. Each fact is checked by the AQ agent's own checkPack.
 */
const { sha256, text } = require('./common');
const { checkPack } = require('../research-queue-agent/facts');

const FEEDBACK_SCHEMA = 'LAB_FEEDBACK_V1';
const FACTS_SCHEMA = 'LAB_FEEDBACK_FACTS_V1';

/** @returns {{ok: true, feedback_text, facts_text, fact} | {ok: false, reason_code}} */
function build({ cardId, market, asOf, labCandidateId, terminalState, verdict, reasonCodes, chainHeadSha256 }) {
  const feedback = { schema: FEEDBACK_SCHEMA, card_id: cardId, lab_candidate_id: labCandidateId, terminal_state: terminalState, verdict, reason_codes: [...reasonCodes], chain_head_sha256: chainHeadSha256, as_of: asOf };
  const feedbackText = text(feedback);
  const fact = { source: { path: `lab/${cardId}/feedback.json`, sha256: sha256(feedbackText), pointer: '/' }, at: asOf, value: { candidate_id: labCandidateId, terminal_state: terminalState, verdict, reason_codes: [...reasonCodes] } };
  const c = checkPack({ facts: [{ id: 'F-001', ...fact }] }, { purpose: 'CARD', maxTokens: Infinity });
  if (!c.ok) return { ok: false, reason_code: `LAB_FEEDBACK_FACT_INVALID_${c.errors[0].code}` };
  return { ok: true, feedback_text: feedbackText, facts_text: text({ schema: FACTS_SCHEMA, card_id: cardId, market, as_of: asOf, facts: [fact] }), fact };
}

/** The generator-facing class of a terminal state. INSUFFICIENT is never "fail". */
function verdictClass({ terminalState, engineVerdict }) {
  if (['FROZEN_AWAITING_HOLDOUT', 'FROZEN_AWAITING_FORWARD', 'PAUSED'].includes(terminalState) || String(terminalState).startsWith('REFUSED_AT_')) return 'pending';
  if (['NOT_SELECTED_BY_VALIDATION', 'SEALED_FAILURE_LIBRARY', 'VERIFIER_FAIL'].includes(terminalState)) return 'fail';
  return engineVerdict === 'PASS' ? 'pass' : engineVerdict === 'FAIL' ? 'fail' : 'pending';
}

/** Is the feedback fact (by the sha of feedback.json) in this pack? (the acceptance checker's C5) */
function findIn(pack, feedbackSha256) {
  if (!pack || !Array.isArray(pack.facts)) return null;
  return pack.facts.find((f) => f && f.source && f.source.sha256 === feedbackSha256) || null;
}

module.exports = { FEEDBACK_SCHEMA, FACTS_SCHEMA, build, verdictClass, findIn, checkPack };
