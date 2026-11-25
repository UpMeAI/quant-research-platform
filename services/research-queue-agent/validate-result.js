'use strict';
/**
 * Q3c: re-validation of an agent's result.json by the TRUSTED consumer side (the research-queue user, in its own short-lived node process; never by the agent).
 * The agent's own `validator` block is never trusted: mechanism results must carry the frozen self-validation certificate, but this consumer treats it as data and
 * cross-checks it against the named output sha and bytes it hashes itself. A result completes a task only if this function's independent checks say ok.
 * Pure: no fs, no clock, no network, no model. Same inputs, same answer. It re-runs the deterministic validators of the agent itself (card, idea records, check report,
 * pack firewall) over the result's outputs, against the task and bundle the CONSUMER staged, and compares the derived records and shas.
 * Not covered here (needs the gateway ledger, which the consumer cannot read on HK): the per-call ledger match of the evidence matrix (EM-04).
 */
const { canonicalJson, sha256, isObj, SHA64, SECRET_SHAPED } = require('./canon');
const { checkPack } = require('./facts');
const { validateCard } = require('./card');
const { checkNotePack, checkMechanismRegister, validateNoteOutput } = require('./mech-note');
const { checkReviewPack, validateReviewOutput } = require('./mech-review');
const { validateCheckReport } = require('./check-report');
const { buildIdeaRecords, packSha } = require('./factor-idea');
const { parseAgentTask } = require('./queue-seam');
const { MODELS } = require('./agent');
const prompts = require('./prompts');

const CHECK_BODY_KEYS = ['verdict', 'items', 'hold_reasons', 'unknowns'];

/**
 * @param {{task: object, bundle: object, result: any}} a  task/bundle as staged by the consumer; result as written by the agent (untrusted)
 * @returns {{ok: boolean, codes: string[], output_sha256: string|null}}
 */
function validateResult({ task, bundle, result, promptAdmissions, mechanismRegisterBytes }) {
  const codes = [];
  const add = (c) => { if (c) codes.push(c); };
  const done = () => { const u = [...new Set(codes)]; return { ok: u.length === 0, codes: u, output_sha256: u.length === 0 ? sha256(canonicalJson(result.outputs)) : null }; };
  const fail = (c) => ({ ok: false, codes: [c], output_sha256: null });
  let t;
  try { t = parseAgentTask(task); } catch (e) { return fail('RESULT_TASK_INVALID'); }
  if (!isObj(result) || result.schema !== 'RQ_AGENT_RESULT_V1') return fail('RESULT_SCHEMA_INVALID');
  if (result.task_id !== t.task_id || result.kind !== t.kind) add('RESULT_TASK_MISMATCH');
  if (result.status !== 'DONE') add('RESULT_NOT_DONE');
  if (SECRET_SHAPED.test(JSON.stringify(result))) add('RESULT_SECRET_SHAPED');
  if (!isObj(bundle) || bundle.schema !== 'RQ_AGENT_BUNDLE_V1' || bundle.market !== t.market || !isObj(bundle.pack) || bundle.pack.market !== t.market) { add('RESULT_BUNDLE_INVALID'); return done(); }
  const o = isObj(result.outputs) ? result.outputs : null;
  if (!o) { add('RESULT_OUTPUT_MISSING'); return done(); }
  const adm = promptAdmissions || prompts.loadAdmissions();
  const want = adm.byKind[t.kind];
  if (!want) { add('RESULT_PROMPT_NOT_ADMITTED'); return done(); }
  const models = [MODELS.FLASH, MODELS.PRO];
  try {
    if (t.kind === 'AI_MECH_NOTE' || t.kind === 'AI_MECH_REVIEW') {
      const isNote = t.kind === 'AI_MECH_NOTE';
      const pc = isNote ? checkNotePack(bundle.pack) : checkReviewPack(bundle.pack);
      for (const e of pc.errors) add(e.code);
      const key = isNote ? 'mechanism_notes' : 'mechanism_review';
      const wrapped = o[key];
      if (!isObj(wrapped)) { add('RESULT_OUTPUT_MISSING'); return done(); }
      const schema = isNote ? 'RF1116_MECH_NOTE_OUTPUT_V1' : 'RF1116_MECH_REVIEW_OUTPUT_V1';
      if (wrapped.schema !== schema || wrapped.task_id !== t.task_id) add('RESULT_MECH_OUTPUT_INVALID');
      if (wrapped.prompt_admission_sha256 !== want.system_sha256) add('RESULT_PROMPT_NOT_ADMITTED');
      if (!models.includes(wrapped.model)) add('RESULT_MODEL_NOT_ALLOWED');
      const { schema: _s, task_id: _t, prompt_admission_sha256: _p, model: _m, ...body } = wrapped;
      let registerAuthority = null;
      if (isNote) {
        const rc = checkMechanismRegister(mechanismRegisterBytes, bundle.pack.pins.register_sha256);
        for (const e of rc.errors) add(e.code);
        if (!rc.ok) return done();
        registerAuthority = rc;
      }
      const v = isNote ? validateNoteOutput(body, bundle.pack, registerAuthority) : validateReviewOutput(body, bundle.pack);
      for (const e of v.errors) add(e.code);
      const outputSha256 = sha256(canonicalJson(wrapped));
      const namedSha256 = o[`${key}_sha256`];
      if (outputSha256 !== namedSha256) add('RESULT_MECH_SHA_MISMATCH');
      const certificate = result.validator;
      if (!isObj(certificate)) add('RESULT_VALIDATOR_MISSING');
      else {
        if (certificate.ok !== true) add('RESULT_VALIDATOR_NOT_OK');
        if (!SHA64.test(certificate.sha256 || '') || certificate.sha256 !== namedSha256 || certificate.sha256 !== outputSha256) add('RESULT_VALIDATOR_SHA_MISMATCH');
      }
      return done();
    }
    const isCard = t.kind === 'AI_REVIEW_CARD';
    for (const e of checkPack(bundle.pack, { purpose: isCard ? 'CARD' : 'CHECK', check_admission_sha256: adm.byKind.AI_CHECK && adm.byKind.AI_CHECK.system_sha256, author_required: !!bundle.author_required, maxTokens: isCard ? undefined : Infinity }).errors) add(e.code);
    if (isCard) {
      const c = o.card;
      if (!isObj(c)) { add('RESULT_OUTPUT_MISSING'); return done(); }
      if (c.schema !== 'REVIEW_AI_CARD_V1' || c.task_id !== t.task_id) add('RESULT_CARD_INVALID');
      if (c.prompt_admission_sha256 !== want.system_sha256) add('RESULT_PROMPT_NOT_ADMITTED');
      if (!models.includes(c.model)) add('RESULT_MODEL_NOT_ALLOWED');
      const { schema: _s, task_id: _t, prompt_admission_sha256: _p, model: _m, ...body } = c;
      if (typeof bundle.week_id !== 'string' || !isObj(bundle.registry)) { add('RESULT_BUNDLE_INVALID'); return done(); }
      const vctx = { pack: bundle.pack, registry: bundle.registry, market: t.market, week_id: bundle.week_id, existing_idea_count: bundle.existing_idea_count || 0 };
      const v = validateCard(body, vctx);
      for (const e of v.errors) add(e.code);
      const cardSha = sha256(canonicalJson(c));
      if (cardSha !== o.card_sha256) add('RESULT_CARD_SHA_MISMATCH');
      if (v.ok) {
        const ideas = buildIdeaRecords(c, vctx, { card_sha256: cardSha, prompt_admission_sha256: c.prompt_admission_sha256, model: c.model });
        if (canonicalJson(ideas) !== canonicalJson(o.factor_ideas)) add('RESULT_IDEAS_MISMATCH');
        if (!Array.isArray(o.idea_routes) || o.idea_routes.length !== ideas.length) add('RESULT_ROUTES_MISMATCH');
      }
    } else {
      const r = o.check_report;
      if (!isObj(r)) { add('RESULT_OUTPUT_MISSING'); return done(); }
      if (r.schema !== 'RQ_CHECK_REPORT_V1' || r.task_id !== t.task_id) add('RESULT_CHECK_REPORT_INVALID');
      if (r.prompt_admission_sha256 !== want.system_sha256) add('RESULT_PROMPT_NOT_ADMITTED');
      if (!models.includes(r.model)) add('RESULT_MODEL_NOT_ALLOWED');
      const body = Object.fromEntries(CHECK_BODY_KEYS.filter((k) => k in r).map((k) => [k, r[k]]));
      for (const e of validateCheckReport(body, bundle.pack).errors) add(e.code);
      if (sha256(canonicalJson(r)) !== o.check_report_sha256) add('RESULT_CHECK_REPORT_SHA_MISMATCH');
      if (packSha(bundle.pack) !== o.fact_pack_sha256) add('RESULT_PACK_SHA_MISMATCH');
    }
  } catch (e) { add('RESULT_VALIDATOR_ERROR'); }
  return done();
}

module.exports = { validateResult };
