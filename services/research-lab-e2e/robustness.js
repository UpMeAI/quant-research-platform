'use strict';

/**
 * V-5 robustness results (W24b): exactly the tests the K2 declared before the result was seen (the declaration's sha256 is the `ROBUSTNESS_DECLARATION_SHA256` line of the frozen K2).
 * Supported metrics, all annualised paired net excess of the candidate over the baseline (daily net = gross - multiple x cost):
 *   NET_EXCESS_ANNUAL              at the test's own cost multiplier (cost x2 and the like), computed from the same series, no re-run
 *   WORST_NET_EXCESS_ANNUAL        the minimum over the replay's parameter-perturbation arms
 *   WORST_HALF_NET_EXCESS_ANNUAL   the minimum over the first and the second half of the sample
 *   delta_g_ci_lower               (the metric the Q3b K2 fixtures declare) the lower bound of the 95% month-block interval of the annualised paired net excess: at the test's cost
 *                                  multiplier (COST_MULTIPLIER), the minimum over the perturbation arms (PARAM_PERTURBATION), the minimum over the two halves (SUB_PERIOD)
 * Anything else is refused (never guessed). The verifier judges each value against the declared op and threshold.
 */
const replayOutput = require('./replay-output');
const stats = require('./stats');
const authority = require('../independent-verifier/authority');
const { canonicalJson, sha256, isObj } = require('./common');

const annual = (pairs) => stats.mean(pairs.map((x) => x.v)) * stats.DAYS_PER_YEAR;

/** @returns {{v5: {declaration, results}} | {refusal: string}} */
function produce({ replay, declaration, k2Text }) {
  const cfg = authority.loadConfig();
  const m = new RegExp(`^${cfg.robustness.declarationLine}: ([0-9a-f]{64})\\s*$`, 'm').exec(String(k2Text));
  if (!m || m[1] !== sha256(canonicalJson(declaration))) return { refusal: 'ROBUSTNESS_DECLARATION_NOT_IN_K2' };
  const bad = replayOutput.check(replay);
  if (bad) return { refusal: bad };
  const tests = isObj(declaration) && Array.isArray(declaration.tests) ? declaration.tests : [];
  const base = replay.arms.baseline.daily; const cand = replay.arms.candidate.daily;
  const results = [];
  for (const t of tests) {
    let value;
    if (t.metric === 'delta_g_ci_lower') {
      const lower = (p) => stats.annualCi(p).ci.lower;
      if (t.kind === 'COST_MULTIPLIER') value = lower(stats.paired(cand, base, typeof t.multiplier === 'number' ? t.multiplier : 1));
      else if (t.kind === 'PARAM_PERTURBATION') {
        const arms = Array.isArray(replay.perturbations) ? replay.perturbations : [];
        if (!arms.length) return { refusal: 'ROBUSTNESS_PERTURBATION_RUNS_MISSING' };
        const ps = arms.map((a) => stats.paired(a.daily, base, 1));
        if (ps.includes(null)) return { refusal: 'REPLAY_ARMS_NOT_ALIGNED' };
        value = Math.min(...ps.map(lower));
      } else if (t.kind === 'SUB_PERIOD') { const p = stats.paired(cand, base, 1); const h = Math.floor(p.length / 2); value = Math.min(lower(p.slice(0, h)), lower(p.slice(h))); }
      else return { refusal: `ROBUSTNESS_KIND_UNSUPPORTED:${t.kind}` };
    } else if (t.metric === 'NET_EXCESS_ANNUAL') value = annual(stats.paired(cand, base, typeof t.multiplier === 'number' ? t.multiplier : 1));
    else if (t.metric === 'WORST_NET_EXCESS_ANNUAL') {
      const arms = Array.isArray(replay.perturbations) ? replay.perturbations : [];
      if (!arms.length) return { refusal: 'ROBUSTNESS_PERTURBATION_RUNS_MISSING' };
      const vs = arms.map((a) => { const p = stats.paired(a.daily, base, 1); return p ? annual(p) : null; });
      if (vs.includes(null)) return { refusal: 'REPLAY_ARMS_NOT_ALIGNED' };
      value = Math.min(...vs);
    } else if (t.metric === 'WORST_HALF_NET_EXCESS_ANNUAL') {
      const p = stats.paired(cand, base, 1); const h = Math.floor(p.length / 2);
      value = Math.min(annual(p.slice(0, h)), annual(p.slice(h)));
    } else return { refusal: `ROBUSTNESS_METRIC_UNSUPPORTED:${t.metric}` };
    results.push({ id: t.id, value });
  }
  return { v5: { declaration, results } };
}

module.exports = { produce };
