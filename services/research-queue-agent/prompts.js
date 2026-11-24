'use strict';
/**
 * 提示词（sha 钉住，§5.6）与提示词准入。系统文本在代码里；config/research_queue_prompt_admissions.v1.json 列出已准入的 sha，
 * 测试核对两者一致，网关只转发 sha 在准入表里的系统消息。改文本 = 改 sha = 新的准入条目。
 */
const { sha256 } = require('./canon');

const CHECK_SYSTEM_TEXT = [
  'You check whether a research task\'s evidence covers every row of a frozen evidence matrix. Use only FACTS; cite fact ids. Do not predict prices, returns, directions, probabilities, sizes or market impact. Do not say whether a strategy should be adopted or rejected. Do not compute new numbers. Output only the JSON schema.',
  '',
  'The user message is a JSON object {task_id, facts, evidence_matrix}. facts[] are {id, source, at, value}; evidence_matrix[] are {req_id, text, gate_result, reason, fact_ids}.',
  'Output exactly one JSON object with keys verdict, items, hold_reasons, unknowns and no others:',
  '- verdict: "CONSISTENT" or "HOLD". CONSISTENT only if every item is COVERED or NA_CONFIRMED and hold_reasons is empty.',
  '- items: one entry per evidence_matrix row, exactly once each, as {req_id, status, fact_ids, note_zh}. status is COVERED, GAP, CONTRADICTION or NA_CONFIRMED. fact_ids lists the fact ids you rely on (required unless status is GAP). note_zh is one short Chinese sentence; any number in it must appear in a cited fact.',
  '- hold_reasons: for HOLD, entries {code, req_id, fact_ids, remediation_zh}; code is one of HOLD_MISSING_EVIDENCE, HOLD_CONTRADICTION, HOLD_SCOPE_DRIFT, HOLD_UNREGISTERED_TRIAL, HOLD_WINDOW_BREACH, HOLD_PROVENANCE.',
  '- unknowns: list of short Chinese strings for things the facts do not settle.',
].join('\n');

const CARD_SYSTEM_TEXT = [
  'You write a weekly review card from FACTS only. Use only FACTS; cite fact ids. Do not predict prices, returns, directions, probabilities, sizes or market impact. Do not say whether a strategy should be adopted or rejected. Do not compute new numbers. Do not write formulas, thresholds or weights. Output only the JSON schema.',
  '',
  'The user message is a JSON object {market, week_id, facts, repeated_pattern_counts, registry}. registry lists the registered mechanisms {mechanism_id, layer, decision_point}, the registered readings {id, pit_available_at, origin} and the registered holding_periods.',
  'Output exactly one JSON object with keys market, week_id, supporting, opposing, unknowns, repeated_patterns, factor_ideas, no_idea_reason, question_proposals and no others. market and week_id are copied from the input.',
  '- supporting, opposing, unknowns: lists of {text_zh, fact_ids}; fact_ids is non-empty. text_zh is one short Chinese sentence; any number in it must appear in a cited fact.',
  '- repeated_patterns: {pattern_key, note_zh, count, fact_ids}; pattern_key and count are copied from repeated_pattern_counts.',
  '- factor_ideas: 1 to 5 entries {fact_ids, mechanism, readings, holding_periods, question_zh, expected_failure_zh}. fact_ids has at least 2 ids. mechanism is an existing SELECTION_TIMING mechanism_id from the registry, or {"NEW": {"proposed_id", "title_zh", "description_zh", "layer": "SELECTION_TIMING", "decision_point"}} where proposed_id starts with SEL. and decision_point is SELECT, DIRECTION or ENTRY. readings are ids from registry.readings only; holding_periods come from registry.holding_periods. question_zh is a Chinese question to test, with no direction. expected_failure_zh says when the mechanism should not work. An idea has no formula, no operator, no numbers, no direction and no prediction.',
  '- no_idea_reason: null when factor_ideas is not empty; otherwise {text_zh, fact_ids} citing why no finding this week touches selection or timing.',
  '- question_proposals: at most 2 entries {mechanism_id (an existing id or "NEW"), layer, decision_point, market, question_zh (a question, no direction), fact_ids}.',
].join('\n');

const MECH_NOTE_SYSTEM_TEXT = [
  'You write mechanism notes for RF1116 candidates. Use only the supplied pack. Do not predict prices, returns, direction, probability or market impact. Do not decide approval, registration or timestamps. Output one JSON object only.',
  'Copy round_id and batch_no. Output exactly {round_id,batch_no,notes}. Include every candidate exactly once. Each note has exactly {candidate_id,outcome,mechanism_id,economic_logic_zh,failure_mode_zh,fields_cited,no_mechanism_code,proposal}.',
  'outcome NOTE uses one mechanism_id from mechanisms, 20-160 Chinese characters of economic logic, 10-100 Chinese characters of failure mode, and a non-empty subset of that candidate fields. Other conditional fields are null.',
  'outcome NO_MECHANISM uses one of DEGENERATE, MIXED_UNITS, NEAR_ZERO_DENOMINATOR, MECHANICAL_ONLY, NONE_FITS. outcome NEW_MECHANISM_PROPOSAL uses proposal {title_zh,description_zh}. Never invent a number not in that candidate formula.',
].join('\n');

const MECH_REVIEW_SYSTEM_TEXT = [
  'You review whether each RF1116 mechanism note is textually consistent with its formula and registered mechanism description. Use only the supplied pack. Do not predict markets, decide registration, inspect scores or write timestamps. Output one JSON object only.',
  'Copy round_id and batch_no. Output exactly {round_id,batch_no,items}. Include every candidate exactly once. Each item is exactly {candidate_id,status,code,note_zh}.',
  'status is CONSISTENT or HOLD. CONSISTENT has code null. HOLD code is one of HOLD_LOGIC_FORMULA_MISMATCH, HOLD_MECHANISM_MISMATCH, HOLD_FAILURE_MODE_EMPTY, HOLD_PREDICTIVE_CLAIM. note_zh is at most 80 Chinese characters and may use only numbers present in that candidate formula.',
].join('\n');

const TEXTS = { AI_CHECK: CHECK_SYSTEM_TEXT, AI_REVIEW_CARD: CARD_SYSTEM_TEXT, AI_MECH_NOTE: MECH_NOTE_SYSTEM_TEXT, AI_MECH_REVIEW: MECH_REVIEW_SYSTEM_TEXT };

function loadAdmissions() {
  const file = require('../../config/research_queue_prompt_admissions.v1.json');
  const entries = file.entries;
  const shas = new Set();
  const byKind = {};
  for (const e of entries) {
    if (shas.has(e.system_sha256)) throw new Error(`RQ_ADMISSION_DUPLICATE_SHA: ${e.prompt_id}`);
    shas.add(e.system_sha256);
    if (TEXTS[e.kind] !== undefined && sha256(TEXTS[e.kind]) !== e.system_sha256) throw new Error(`RQ_ADMISSION_SHA_MISMATCH: ${e.prompt_id}`);
    if (e.state === 'ADMITTED') byKind[e.kind] = e;
  }
  return { entries, byKind };
}

module.exports = { CHECK_SYSTEM_TEXT, CARD_SYSTEM_TEXT, MECH_NOTE_SYSTEM_TEXT, MECH_REVIEW_SYSTEM_TEXT, TEXTS, loadAdmissions };
