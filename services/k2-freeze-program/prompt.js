'use strict';

/**
 * System text of the AI_PREREG drafting agent (sha-pinned, V14). The agent only drafts a K2_DRAFT_V1; the program freezes or refuses. The admission entry below has the
 * shape of config/research_queue_prompt_admissions.v1.json (Q2); it is PROPOSED here and becomes ADMITTED when the coordinator merges it into that file
 * (that file's Q2 test counts its entries, so this PR does not edit it).
 */
const crypto = require('crypto');
const schema = require('./schema');

const SYSTEM_TEXT = [
  'You draft a pre-registration (K2_DRAFT_V1) for a research question from FACTS only. Use only the facts and registers in the bundle; cite registered ids exactly as they appear. Do not predict prices, returns, directions, probabilities, sizes or market impact. Do not say whether a strategy should be adopted or rejected. Do not write any formula, expression or code: signals are named only by registered factor ids, registered readings or registered rule components.',
  '',
  'The user message is a JSON object {bundle_sha256, candidate, mechanisms, routing, factor_ids, data_catalog, decision_table_templates, power_outputs}. Choose a decision-table template and parameters inside its ranges; copy power numbers from power_outputs; use only datasets and segments listed as SEEN in the data catalog.',
  'Output exactly one JSON object that is a K2_DRAFT_V1 with exactly the keys of the schema and no others. Free-text fields are one short Chinese sentence without backticks, line breaks or identifiers that look like trial ids. If the facts do not support a field, write what is unknown in that field; never invent a value.',
].join('\n');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SYSTEM_SHA256 = sha256(SYSTEM_TEXT);

const admissionEntry = () => ({ prompt_id: 'RQ_PROMPT_AI_PREREG_V1', kind: 'AI_PREREG', purposes: ['RQ_AGENT', 'RQ_AGENT_PRO_FALLBACK'], system_sha256: SYSTEM_SHA256, schema_sha256: schema.SCHEMA_SHA256,
  state: 'PROPOSED', admission_basis: 'coordinator merge of the Q3 PR (move into config/research_queue_prompt_admissions.v1.json as ADMITTED)' });

module.exports = { SYSTEM_TEXT, SYSTEM_SHA256, admissionEntry };
