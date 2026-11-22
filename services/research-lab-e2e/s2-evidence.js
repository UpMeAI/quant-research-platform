'use strict';

/**
 * S2 evidence adapter (W24, plan-coord ruling 11-23 (4)): round-runner selection.json -> PROMOTION_STAGE_EVIDENCE_V1 body for stage S2.
 * Nothing new is judged here: the verdict is the engine's. The adapter only reads what the runner already measured:
 *   estimate  the candidate's mean neutralised daily rank IC over the validation segment (selection.json mean_ic)
 *   ci        95% interval of the mean over the validation folds (Student t on the fold means, k-1 degrees of freedom); the fold means are what the runner exposes
 *   n         IC days
 *   dsr       null before the holdout (G-MINE computes it at scoring), so S2 is INSUFFICIENT until the V-3 adapter's DSR exists
 *   decay_ok  the runner's own stability rule (positive folds >= the round's rule)
 * classification of a candidate the validation rule rejected (ruling 3): FAIL (不做) with reason S2_NOT_SELECTED_BY_VALIDATION, unless too few folds or samples,
 * which is INSUFFICIENT and goes through amendment section 4.2.
 */
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const err = (code, d) => Object.assign(new Error(d === undefined ? code : `${code}:${d}`), { code });

function fromSelection({ selection, candidateId, minSampleN }) {
  const c = (selection.candidates || []).find((x) => x.candidate_id === candidateId);
  if (!c) throw err('S2_ADAPTER_CANDIDATE_UNKNOWN', candidateId);
  const folds = c.fold_ic.filter((f) => isNum(f.ic_mean) && f.ic_days > 0);
  const k = folds.length;
  const mean = k ? folds.reduce((a, f) => a + f.ic_mean, 0) / k : 0;
  const estimate = isNum(c.mean_ic) ? c.mean_ic : mean;
  let half = 0;
  if (k >= 2) {
    const sd = Math.sqrt(folds.reduce((a, f) => a + (f.ic_mean - mean) ** 2, 0) / (k - 1));
    half = (T975[k - 2] || 1.96) * sd / Math.sqrt(k);
  }
  const n = c.ic_days;
  const decayOk = c.positive_folds >= selection.rule.positive_folds_min;
  const body = { metric_kind: 'RANK_IC_INCREMENT', estimate, ci: { lower: estimate - half, upper: estimate + half, level: 0.95 }, n, dsr: null, decay_ok: decayOk };
  const tooFew = k < selection.rule.folds.length || n < minSampleN;
  const classification = c.selected ? 'SELECTED' : (tooFew ? 'INSUFFICIENT' : 'FAIL');
  return { body, classification, folds_with_data: k };
}

const evidence = (terms, body, priorOutputSha256) => ({ schema: 'PROMOTION_STAGE_EVIDENCE_V1', candidate_id: terms.candidate_id, stage: 'S2', k2_sha256: terms.k2_sha256,
  prior_output_sha256: priorOutputSha256, validator: { first_failed: null }, body });

module.exports = { fromSelection, evidence };
