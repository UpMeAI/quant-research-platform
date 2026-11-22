'use strict';

/**
 * V-3 statistics adapter (W24, plan-coord ruling 11-23 (4)): the round's G-MINE records and the runner's score.json -> the verifier's `v3` block with provenance in the #146 format.
 * DSR and PBO are the values the round runner computed with the trial ledger's overfit module (score.json results[].overfit); the adapter does not recompute them. It checks the
 * score.json against the ledger's G-MINE record (record hash and codes must match the ones the runner wrote beside the results), and for each statistic writes the small run file
 * { trialRecordId, statistic, value } that V-3 re-hashes, with the candidate's trial-ledger record id (TRL-...).
 * BHY needs one raw p-value per candidate of the round: the one-sided normal tail of the holdout IC t-statistic (icir x sqrt(periods)), through overfit.normCdf; the index is the candidate's.
 * Unknown stays unknown: a statistic that is not a number has no provenance file and V-3 answers UNSOURCED_STATISTIC.
 */
const path = require('path');
const crypto = require('crypto');
const trials = require('../trial-ledger');
const overfit = require('../trial-ledger/overfit');
const gateRecords = require('../mining-rounds/gate-records');
const { fs } = require('./common');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const err = (code, d) => Object.assign(new Error(d === undefined ? code : `${code}:${d}`), { code });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const dirOf = (outDir, roundId) => path.join(outDir, 'rounds', roundId.replace(/[^A-Za-z0-9_-]/g, '_'));

const pValue = (r) => (isNum(r.holdout.icir) && r.holdout.icir_periods > 0 ? 1 - overfit.normCdf(r.holdout.icir * Math.sqrt(r.holdout.icir_periods)) : 1);

/** @returns {{v3: object, files: {path: string, bytes: Buffer}[]}} */
function fromRound({ roundId, candidateId, outDir, scoreFile = null, priorHoldoutFailures = [] }) {
  const records = gateRecords.recordsOf(roundId);
  const rec = records.find((r) => r.candidate_id === candidateId);
  if (!rec) throw err('V3_ADAPTER_NO_GATE_RECORD', candidateId);
  const file = scoreFile || path.join(dirOf(outDir, roundId), 'score.json');
  let score;
  try { score = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw err('V3_ADAPTER_SCORE_FILE_MISSING'); }
  const results = score.results || [];
  const mine = results.find((r) => r.candidate_id === candidateId);
  // score.json is bound to the ledger by the record hashes the runner wrote into it next to the results (the G-MINE record is the ledger's row; gate_result_sha256 is the gate's own output, not the candidate result)
  const bound = (score.records || []).find((x) => x.candidate_id === candidateId);
  if (!mine || !bound || bound.record_hash !== rec.record_hash || JSON.stringify(bound.codes) !== JSON.stringify(rec.codes)) throw err('V3_ADAPTER_SCORE_FILE_NOT_THE_RECORDED_RESULT', candidateId);
  const pValues = results.map(pValue);
  const index = results.findIndex((r) => r.candidate_id === candidateId);
  const o = mine.overfit;
  const dsr = isNum(o.dsr) ? o.dsr : null; const pbo = isNum(o.pbo) ? o.pbo : null;
  const files = []; const provenance = {};
  const record = (name, value) => {
    if (!isNum(value)) return;
    const body = Buffer.from(`${trials.canonicalJson({ trialRecordId: rec.trial_id, statistic: name, value })}\n`);
    const rel = `v3/${name}-${sha(`${candidateId}:${name}`).slice(0, 12)}.json`;
    files.push({ path: rel, bytes: body });
    provenance[name] = { trialRecordId: rec.trial_id, run: { path: rel, sha256: sha(body) } };
  };
  record('dsr', dsr); record('pbo', pbo); record('bhy', pValues[index]);
  const v3 = { familyTrialCount: rec.family_trial_count, overfit: { dsr, n_trials: o.n_trials, pbo, pbo_scope: o.pbo_scope, bhy: { pValues, index } }, provenance, priorHoldoutFailures };
  return { v3, files };
}

const holdoutScoring = () => require('../mining-sandbox/round-runner/holdout-scoring');

/**
 * Pre-holdout form (the ladder runs S2..S4 and the verifier on dev + validation before S5): the same statistics from the validation folds only, nothing from the holdout.
 *   DSR  holdout-scoring.dsrFromValidation on the candidate's validation monthly paired differences (N = the family's trial count, family Sharpes from the round)
 *   PBO  overfit.pbo (CSCV) on the round candidates' validation monthly matrix; NOT_APPLICABLE or unknown stays unknown (no provenance, V-3 answers UNSOURCED_STATISTIC)
 *   BHY  one-sided normal tail of the validation IC t-statistic over the folds, one raw p per round candidate
 * Provenance: the candidate's trial-ledger registration id (TRL-...) and a hashed run file { trialRecordId, statistic, value }.
 */
function fromSelection({ selection, candidateId, trialId, familyTrialCount, priorHoldoutFailures = [] }) {
  const cands = selection.candidates;
  const mine = cands.find((c) => c.candidate_id === candidateId);
  if (!mine || !mine.validation_book) throw err('V3_ADAPTER_CANDIDATE_UNKNOWN', candidateId);
  const sharpes = cands.map((c) => (c.validation_book ? c.validation_book.sr : null)).filter(isNum);
  const d = holdoutScoring().dsrFromValidation({ monthly_d: mine.validation_book.monthly_d, N: familyTrialCount, familySharpes: sharpes });
  const len = Math.min(...cands.filter((c) => c.validation_book).map((c) => c.validation_book.monthly_d.length));
  const R = Array.from({ length: len }, (_, t) => cands.filter((c) => c.validation_book).map((c) => c.validation_book.monthly_d[t]));
  let pbo; try { pbo = R.length ? overfit.pbo(R) : { value: 'NOT_APPLICABLE' }; } catch { pbo = { value: 'UNKNOWN' }; }
  const pOf = (c) => {
    const f = c.fold_ic.filter((x) => isNum(x.ic_mean) && x.ic_days > 0); const k = f.length;
    if (k < 2) return 1;
    const m = f.reduce((a, x) => a + x.ic_mean, 0) / k; const sd = Math.sqrt(f.reduce((a, x) => a + (x.ic_mean - m) ** 2, 0) / (k - 1));
    return sd > 0 ? 1 - overfit.normCdf(m / (sd / Math.sqrt(k))) : (m > 0 ? 0 : 1);
  };
  const pValues = cands.map(pOf); const index = cands.findIndex((c) => c.candidate_id === candidateId);
  const dsr = isNum(d.dsr) ? d.dsr : null; const pboV = isNum(pbo.value) ? pbo.value : null;
  const files = []; const provenance = {};
  const record = (name, value) => {
    if (!isNum(value)) return;
    const body = Buffer.from(`${trials.canonicalJson({ trialRecordId: trialId, statistic: name, value })}\n`);
    const rel = `v3/${name}-${sha(`${candidateId}:${name}`).slice(0, 12)}.json`;
    files.push({ path: rel, bytes: body }); provenance[name] = { trialRecordId: trialId, run: { path: rel, sha256: sha(body) } };
  };
  record('dsr', dsr); record('pbo', pboV); record('bhy', pValues[index]);
  return { v3: { familyTrialCount, overfit: { dsr, n_trials: familyTrialCount, pbo: pboV, pbo_scope: 'ROUND_CANDIDATE_SET', bhy: { pValues, index } }, provenance, priorHoldoutFailures }, files };
}

module.exports = { fromRound, fromSelection, pValue };
