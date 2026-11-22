'use strict';
/**
 * W24 producers for the 12-01 acceptance (plan-coord ruling 11-23 (4)): the S2 evidence adapter (round-runner selection.json -> PROMOTION_STAGE_EVIDENCE_V1) and the
 * V-3 statistics adapter (trial-ledger DSR/PBO/BHY with provenance in the #146 format). No statistic is computed here that a service already computes.
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const W = require('./_lab_fixture');
const P = require('./_promotion_fixture');
const s2 = require('../services/research-lab-e2e/s2-evidence');
const v3 = require('../services/research-lab-e2e/v3-statistics');
const engine = require('../services/promotion-engine');
const { runners } = require('../services/independent-verifier/stages');
const authority = require('../services/independent-verifier/authority');

const sha = W.sha;
let round = null;
function scored() { if (!round) { process.env.QRP_DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'qrp-w24-ad-')); round = W.scoredRound(); } return round; }

test('S2 adapter: selection.json -> a valid S2 body (RANK_IC_INCREMENT, 95% interval over the fold means, n = IC days, DSR unknown before the holdout); the engine accepts it', () => {
  const r = scored();
  const id = r.selected[0];
  const a = s2.fromSelection({ selection: r.selection, candidateId: id, minSampleN: 200 });
  assert.equal(a.classification, 'SELECTED');
  assert.equal(a.body.metric_kind, 'RANK_IC_INCREMENT');
  assert.equal(a.body.ci.level, 0.95);
  assert.ok(a.body.ci.lower <= a.body.estimate && a.body.estimate <= a.body.ci.upper);
  assert.equal(a.body.dsr, null);
  assert.equal(typeof a.body.decay_ok, 'boolean');
  assert.ok(a.body.n > 200);
  const terms = P.terms({ candidate_id: 'CAND-AD-1', min_sample_n: 200 });
  const ev = { ...s2.evidence(terms, a.body, sha('prev-S1')), insufficient_inputs: P.insuff() };
  const res = engine.evaluate({ candidate_id: terms.candidate_id, requested_stage: 'S2', terms, evidence: ev, history: [...P.historyBefore('S2')], as_of: P.AS_OF });
  assert.notEqual(res.verdict, 'INVALID_INPUT', JSON.stringify(res.reasonCodes));
  assert.ok(res.reasonCodes.includes('S2_DSR_UNKNOWN') || res.verdict === 'INSUFFICIENT', JSON.stringify(res));
});

test('S2 adapter: not selected is FAIL when folds and samples are sufficient, INSUFFICIENT when they are too few (ruling 3)', () => {
  const r = scored();
  const notSelected = r.selection.candidates.find((c) => !c.selected);
  assert.ok(notSelected, 'the fixture round has a candidate the rule rejects');
  assert.equal(s2.fromSelection({ selection: r.selection, candidateId: notSelected.candidate_id, minSampleN: 200 }).classification, 'FAIL');
  assert.equal(s2.fromSelection({ selection: r.selection, candidateId: notSelected.candidate_id, minSampleN: 10 ** 9 }).classification, 'INSUFFICIENT');
  const fewFolds = JSON.parse(JSON.stringify(r.selection));
  const c = fewFolds.candidates.find((x) => x.candidate_id === notSelected.candidate_id);
  c.fold_ic = c.fold_ic.map((f, i) => (i < 3 ? { ...f, ic_mean: null, ic_days: 0 } : f));
  assert.equal(s2.fromSelection({ selection: fewFolds, candidateId: c.candidate_id, minSampleN: 200 }).classification, 'INSUFFICIENT');
  assert.throws(() => s2.fromSelection({ selection: r.selection, candidateId: 'nope', minSampleN: 1 }), /S2_ADAPTER_CANDIDATE_UNKNOWN/);
});

test('V-3 adapter: trial-ledger DSR / PBO / BHY with the trial record id and a hashed run file for each (the #146 provenance format); V-3 finds no UNSOURCED_STATISTIC', () => {
  const r = scored();
  const id = r.selected[0];
  const out = v3.fromRound({ roundId: r.roundId, candidateId: id, outDir: r.outDir });
  assert.equal(out.v3.familyTrialCount, W.SCORED_FORMULAS.length);
  assert.equal(out.v3.overfit.n_trials, out.v3.familyTrialCount);
  assert.equal(out.v3.overfit.pbo_scope, 'ROUND_CANDIDATE_SET');
  for (const k of ['dsr', 'pbo', 'bhy']) {
    const p = out.v3.provenance[k];
    assert.match(p.trialRecordId, /^TRL-[0-9a-f]{16}$/, k);
    const f = out.files.find((x) => x.path === p.run.path);
    assert.equal(sha(f.bytes), p.run.sha256, `${k} run file is re-hashable`);
    assert.equal(JSON.parse(f.bytes.toString('utf8')).statistic, k);
  }
  const files = new Map(out.files.map((f) => [f.path, f.bytes]));
  const bundle = { cfg: authority.loadConfig(), candidateId: id, mechanism: { id: 'X', dedupeDecision: 'NORMAL_NO_PRIOR' }, v3: out.v3 };
  const res = runners.V3(bundle, { readBytes: (ref) => files.get(ref.path) || null }, authority.loadConfig());
  assert.equal(res.codes.includes('UNSOURCED_STATISTIC'), false, JSON.stringify(res.codes));
  const tampered = new Map(files); const p0 = out.v3.provenance.dsr.run.path; tampered.set(p0, Buffer.from(tampered.get(p0).toString('utf8').replace(/"value":[^,}]+/, '"value":0.123')));
  assert.deepEqual(runners.V3(bundle, { readBytes: (ref) => tampered.get(ref.path) || null }, authority.loadConfig()).codes, ['UNSOURCED_STATISTIC']);
});

test('V-3 adapter refuses a candidate that has no gate record (holdout not scored)', () => {
  const r = scored();
  assert.throws(() => v3.fromRound({ roundId: r.roundId, candidateId: `${r.roundId}:A999`, outDir: r.outDir }), /V3_ADAPTER_NO_GATE_RECORD/);
});
