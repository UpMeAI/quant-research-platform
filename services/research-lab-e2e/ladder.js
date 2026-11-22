'use strict';

/**
 * The promotion ladder S2 to S4 after S0 and S1 (steps 8 to 10 of the chain): each stage's PROMOTION_STAGE_EVIDENCE_V1 goes to the engine separately, chained by
 * prior_output_sha256 (frozen terms never name evidence). Stops at the first non-PASS stage. The S4 result is what the verifier's V-6 reads (ctx.promotionEngine.s4);
 * V-6 only runs when S3 passed. A stage whose producer refused (S4 without the star value) is a wait, not a verdict.
 */
const STAGE_ORDER = ['S2', 'S3', 'S4'];

function run({ engine, terms, asOf, prior, stages }) {
  const history = [...prior];
  let prev = prior[prior.length - 1].output_sha256;
  const results = []; let lastRequest = null; let waiting = null; let invalid = null;
  for (const stage of STAGE_ORDER) {
    const st = stages[stage];
    if (!st) break;
    if (st.refusal) { waiting = st.refusal; break; }
    const request = { candidate_id: terms.candidate_id, requested_stage: stage, terms, as_of: asOf, history: [...history],
      evidence: { schema: 'PROMOTION_STAGE_EVIDENCE_V1', candidate_id: terms.candidate_id, stage, k2_sha256: terms.k2_sha256, prior_output_sha256: prev, validator: { first_failed: null }, body: st.body,
        ...(st.insufficient_inputs ? { insufficient_inputs: st.insufficient_inputs } : {}) } };
    const r = engine.evaluate(request);
    results.push(r); lastRequest = request;
    if (r.verdict === 'INVALID_INPUT') { invalid = r.reasonCodes[0]; break; }
    history.push({ stage, verdict: r.verdict, output_sha256: r.output_sha256 });
    prev = r.output_sha256;
    if (r.verdict !== 'PASS') break;
  }
  const s3 = results.find((r) => r.stage === 'S3'); const s4 = results.find((r) => r.stage === 'S4');
  return { results, lastRequest, reachedS3: Boolean(s3 && s3.verdict === 'PASS'), waiting, invalid,
    s4: s4 ? { verdict: s4.verdict === 'INVALID_INPUT' ? 'INVALID' : s4.verdict, reasonCodes: s4.reasonCodes, sha256: s4.output_sha256 } : null };
}

module.exports = { STAGE_ORDER, run };
