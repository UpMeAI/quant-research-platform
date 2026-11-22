'use strict';

/**
 * Evidence provider from a replay output (W24b): assembles what the orchestrator's `services.evidence.verifier(view)` returns from the producers.
 *   fromReplay({replay, terms, star, declaration, k2Text, s2Body}) -> { stages: {S2, S3, S4}, bundle: {v4, v5} } or { refusal }
 * v1 (causality) and v3 (statistics, ./v3-statistics.js) are added by the caller. S4 without the star value is `stages.S4.refusal` (a wait).
 * replayNeeds tells ops what the real run must produce in the W24 slot.
 */
const replayOutput = require('./replay-output');
const s3 = require('./s3-evidence');
const s4 = require('./s4-evidence');
const costRuns = require('./cost-runs');
const robustness = require('./robustness');

function fromReplay({ replay, terms, star, declaration, k2Text, s2Body }) {
  const bad = replayOutput.check(replay);
  if (bad) return { refusal: bad };
  const c = costRuns.produce({ replay }); if (c.refusal) return { refusal: c.refusal };
  const r = robustness.produce({ replay, declaration, k2Text }); if (r.refusal) return { refusal: r.refusal };
  const e3 = s3.produce({ replay, terms }); if (e3.refusal) return { refusal: e3.refusal };
  const e4 = s4.produce({ replay, terms, star });
  return { stages: { S2: { body: s2Body }, S3: { body: e3.body }, S4: e4.refusal ? { refusal: e4.refusal } : { body: e4.body } }, bundle: { v4: c.v4, v5: r.v5 } };
}

/** What the replay core must deliver (LAB_REPLAY_OUTPUT_V1) for one candidate: arm runs, and which declared tests need no re-run. */
function replayNeeds({ declaration }) {
  const tests = declaration.tests || [];
  const perturb = tests.some((t) => t.kind === 'PARAM_PERTURBATION');
  const arm_runs = [{ id: 'baseline' }, { id: 'candidate' }, ...(perturb ? [{ id: 'PARAM_MINUS_20' }, { id: 'PARAM_PLUS_20' }] : []), { id: 'portfolio_with' }, { id: 'portfolio_without' }];
  return { schema: 'LAB_REPLAY_NEEDS_V1', arm_runs, derived_without_rerun: tests.filter((t) => t.kind === 'COST_MULTIPLIER' || t.kind === 'SUB_PERIOD').map((t) => t.id) };
}

module.exports = { fromReplay, replayNeeds };
