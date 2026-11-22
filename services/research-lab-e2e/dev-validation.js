'use strict';

/**
 * S2 to S4 on dev + validation (plan-coord NOTE_1 6b3be10d: the holdout only tests a candidate that already passed S3 and S4). Assembles, for the ladder and the verifier, everything
 * from the selection.json of the round, the backtester's replay output and the frozen K2, with the producers of this directory:
 *   stages S2 (selection adapter + validation DSR), S3, S4 (replay; S4 refuses without the star overlap value)
 *   v1 (V-1) the causality evidence composed from the certified operators and the K2's PIT data tokens, v3 from the validation folds, v4 cost runs and fills, v5 robustness results
 * `override.stages` / `override.v3` exist for fixtures whose synthetic data cannot reach real thresholds; they are never the default.
 */
const evidenceProvider = require('./evidence-provider');
const s2Evidence = require('./s2-evidence');
const v3Stats = require('./v3-statistics');
const causalityEvidence = require('./causality-evidence');
const { sha256, text } = require('./common');

const tokensOf = (k2Text) => [...String(k2Text).matchAll(/`(DATA:[^`]+)`/g)].map((m) => m[1]);

/** @returns {{refusal: string} | {stages, bundle, readBytes, gateOptions, v3files}} */
function build({ replay, terms, star, draft, k2Text, k2Sha256, k2FrozenAt, formula, selection, candidateId, trialId, familyTrialCount, asOf, gateOptions, override = {} }) {
  const adapted = s2Evidence.fromSelection({ selection, candidateId, minSampleN: terms.min_sample_n });
  let v3;
  try { v3 = override.v3 || v3Stats.fromSelection({ selection, candidateId, trialId, familyTrialCount }); } catch (e) { return { refusal: `V3_ADAPTER_${e.code || 'ERROR'}` }; }
  const dsr = v3.v3.overfit.dsr;
  const prod = evidenceProvider.fromReplay({ replay, terms, star, declaration: draft.robustness_declaration, k2Text, s2Body: { ...adapted.body, dsr: typeof dsr === 'number' ? dsr : null } });
  if (prod.refusal) return { refusal: prod.refusal };
  const stages = { ...prod.stages, ...(override.stages || {}) };
  let ce;
  try { ce = causalityEvidence.fromExpression({ formula, k2Sha256, dataInputs: tokensOf(k2Text) }); } catch (e) { return { refusal: String(e.code || e.message) }; }
  const runLog = Buffer.from(text({ schema: 'RESEARCH_RUN_LOG_V1', k2_sha256: k2Sha256, runs: [], [ce.run_commit_key]: ce.code_sha }));
  const files = new Map([['causality.json', ce.bytes], ['runlog.json', runLog], ...v3.files.map((f) => [f.path, f.bytes])]);
  const v1 = { entry: { id: draft.draft_id, kind: 'RESULT', sealed_on: String(asOf).slice(0, 10), k2: { sha256: k2Sha256 }, k2_frozen_at: k2FrozenAt, causality_evidence: { sha256: ce.sha256 } },
    files: { causalityEvidence: { path: 'causality.json', sha256: ce.sha256 }, runLog: { path: 'runlog.json', sha256: sha256(runLog) } } };
  return { stages, bundle: { v1, v3: v3.v3, v4: prod.bundle.v4, v5: prod.bundle.v5 }, readBytes: (ref) => files.get(ref.path) || null, gateOptions, files };
}

module.exports = { build, tokensOf };
