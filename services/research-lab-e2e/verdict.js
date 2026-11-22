'use strict';

/**
 * Steps 8 to 10 (verifier V-1..V-6, promotion-engine verdict, seal) as pure functions. The verifier and the engine are called, not re-implemented:
 *   decide({bundle, verifierCtx, request, priorEngine?, engine?})   verifier first (stops at its first failing check, reason LAB_VERIFY_<V code>), then the engine
 *                                                                   for the requested stage, then the seal destination from the engine's nextAction.
 *   assembleBundle({chain, evidence, asOf})                         the verifier input: candidate, K2 and access log come from the chain; the evidence provider supplies the rest.
 *   preHoldout(inputs, engine)                                      before the holdout is read: engine S0 and S1 only, terminal FROZEN_AWAITING_HOLDOUT (or NOT_SELECTED).
 * Same inputs give the same bytes: canonical JSON, no clock. The verdict text never carries a metric: reason codes and engine summaries only.
 */
const engineDefault = require('../promotion-engine');
const verifierMod = require('../independent-verifier');
const { sha256, text, HOLDOUT_NOT_BEFORE, isObj } = require('./common');

const SCHEMA = 'LAB_VERDICT_V1';
const TERMINAL_OF = Object.freeze({ FORWARD_SHADOW: 'SEALED_FORWARD_SHADOW', FAILURE_LIBRARY: 'SEALED_FAILURE_LIBRARY', PAUSE: 'PAUSED' });

const summary = (r) => ({ stage: r.stage, verdict: r.verdict, nextAction: r.nextAction, reasonCodes: r.reasonCodes, output_sha256: r.output_sha256 });

/** Seal destination from the engine's own nextAction: FAIL goes to the failure library, 暂停 pauses (never the failure library), everything that continues is forward shadow. */
function sealOf(res) {
  if (res.nextAction === 'FIX_INPUT') return null;
  const destination = res.nextAction === 'SEAL_NOT_DO_TO_FAILURE_LIBRARY' ? 'FAILURE_LIBRARY' : res.nextAction === 'PAUSE_UNTIL_RESUME_CONDITION' ? 'PAUSE' : 'FORWARD_SHADOW';
  return { destination, basis: { engine_stage: res.stage, engine_output_sha256: res.output_sha256, next_action: res.nextAction }, resolution: res.resolution || null };
}

function assembleBundle({ chain, evidence, asOf }) {
  const e = isObj(evidence) ? evidence : {};
  const v1 = isObj(e.v1) ? e.v1 : {};
  return {
    ...e, schema: 'INDEPENDENT_VERIFIER_INPUT_V1', candidateId: chain.candidateId, candidateSha256: chain.candidateSha256, market: chain.market, familyId: chain.familyId, asOf,
    mechanism: { id: chain.mechanismId, dedupeDecision: chain.dedupeDecision }, v1: { ...v1, files: { ...(isObj(v1.files) ? v1.files : {}), k2: chain.k2 } },
    v2: { accessLog: chain.accessLog, unseenClaim: null, segmentMarks: [] },
  };
}

function decide({ bundle, verifierCtx, request, priorEngine = [], engine = engineDefault }) {
  if (!isObj(bundle) || !isObj(request) || !isObj(request.terms)) return { status: 'REFUSED', reason_code: 'LAB_VERIFY_INPUT_INVALID' };
  const k2 = bundle.v1 && bundle.v1.files && bundle.v1.files.k2;
  if (!k2 || k2.sha256 !== request.terms.k2_sha256) return { status: 'REFUSED', reason_code: 'LAB_VERIFY_K2_BINDING' };
  const verifier = verifierMod.verify(bundle, verifierCtx);
  if (verifier.generator.verdict !== 'pass') return { status: 'REFUSED', reason_code: `LAB_VERIFY_${verifier.generator.reasonCodes[0]}`, verifier };
  const res = engine.evaluate(request);
  if (res.verdict === 'INVALID_INPUT') return { status: 'REFUSED', reason_code: `LAB_VERDICT_${res.reasonCodes[0]}`, verifier, engine: res };
  const seal = sealOf(res);
  if (!seal) return { status: 'REFUSED', reason_code: 'LAB_SEAL_ENGINE_FIX_INPUT', verifier, engine: res };
  const verdict = {
    schema: SCHEMA, candidate: { candidate_id: request.terms.candidate_id, k2_sha256: request.terms.k2_sha256 }, terminal_state: TERMINAL_OF[seal.destination],
    engine: [...priorEngine, summary(res)], verifier: { generator: verifier.generator, report_sha256: sha256(verifierMod.serializeInternal(verifier.internal)) }, seal,
  };
  return { status: 'DECIDED', verifier, engine: res, seal, verdict, verdict_text: text(verdict) };
}

const s0Evidence = (terms, body) => ({ schema: 'PROMOTION_STAGE_EVIDENCE_V1', candidate_id: terms.candidate_id, stage: 'S0', k2_sha256: terms.k2_sha256, prior_output_sha256: null, validator: { first_failed: null }, body });
const s1Evidence = (terms, body, prior) => ({ schema: 'PROMOTION_STAGE_EVIDENCE_V1', candidate_id: terms.candidate_id, stage: 'S1', k2_sha256: terms.k2_sha256, prior_output_sha256: prior, validator: { first_failed: null }, body });

/** Engine S0 then S1 from the stored bodies (the same code builds the verdict and re-builds it for the acceptance checker). */
function engineS0S1({ terms, s0_body: s0, s1_body: s1, as_of: asOf }, engine = engineDefault) {
  const r0 = engine.evaluate({ candidate_id: terms.candidate_id, requested_stage: 'S0', terms, evidence: s0Evidence(terms, s0), history: [], as_of: asOf });
  if (r0.verdict !== 'PASS') return { ok: false, reason_code: `LAB_VERDICT_S0_${r0.verdict}${r0.reasonCodes[0] ? `_${r0.reasonCodes[0]}` : ''}`, results: [r0] };
  const r1 = engine.evaluate({ candidate_id: terms.candidate_id, requested_stage: 'S1', terms, evidence: s1Evidence(terms, s1, r0.output_sha256),
    history: [{ stage: 'S0', verdict: 'PASS', output_sha256: r0.output_sha256 }], as_of: asOf });
  if (r1.verdict !== 'PASS') return { ok: false, reason_code: `LAB_VERDICT_S1_${r1.verdict}${r1.reasonCodes[0] ? `_${r1.reasonCodes[0]}` : ''}`, results: [r0, r1] };
  return { ok: true, results: [r0, r1] };
}

/** The verdict before the holdout is read: S0 and S1 results, the terminal state, no verifier yet. @returns {{ok: boolean, reason_code?: string, verdict_text?: string}} */
function preHoldout(inputs, engine = engineDefault) {
  const out = engineS0S1(inputs, engine);
  if (!out.ok) return out;
  const verdict = { schema: SCHEMA, candidate: { candidate_id: inputs.terms.candidate_id, k2_sha256: inputs.terms.k2_sha256 }, terminal_state: inputs.terminal_state,
    engine: out.results.map(summary), verifier: null, seal: inputs.seal };
  return { ok: true, verdict, verdict_text: text(verdict), results: out.results };
}

const awaitingSeal = () => ({ destination: 'AWAIT_HOLDOUT', earliest_holdout_read: HOLDOUT_NOT_BEFORE });
const notSelectedSeal = () => ({ destination: 'FAILURE_LIBRARY', basis: { rule: 'RF1116_VALIDATION_SELECTION_RULE', engine_verdict: null } });

module.exports = { SCHEMA, TERMINAL_OF, summary, sealOf, assembleBundle, decide, engineS0S1, preHoldout, awaitingSeal, notSelectedSeal };
