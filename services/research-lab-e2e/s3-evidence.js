'use strict';

/**
 * S3 stage evidence producer (W24b; amendment 1.1 S3 "full strategy: fixed entry, exit, fill and cost"). From the replay output of the frozen candidate:
 *   ALPHA / EXECUTION  delta_g: annualised paired daily net growth difference candidate - baseline, 95% interval from month blocks; cost_x2: the same with every cost scaled by the
 *                      K2's own multiple (terms.thresholds.s3.cost_multiple), its interval lower bound; n = paired days
 *   RISK               cvar5_improvement: monthly CVaR5 of the daily net, candidate - baseline, interval over the months; growth_sacrifice: max(0, -delta_g) with its interval
 *   constraints_ok     every fill tradable at its price limit and within the verifier configuration's participation cap (same functions as V-4)
 *   cost_model_ref, cost_breakdown from the cost runs (W22 shape, registry r3 coverage)
 * The engine judges the numbers against the K2's terms.
 */
const replayOutput = require('./replay-output');
const stats = require('./stats');
const costRuns = require('./cost-runs');
const authority = require('../independent-verifier/authority');
const limits = require('../mining-sandbox/price-limits');

function constraintsOk(trades, market) {
  const cap = authority.loadConfig().participationCap;
  for (const f of trades) {
    if (!(f.participation <= cap)) return false;
    if (market === 'CN_A') {
      const { pct } = limits.bandOf({ board: limits.boardOf(f.code), st: f.st === true, date: f.date });
      const can = f.side === 'BUY' ? limits.canBuy({ open: f.open, prevClose: f.prev_close, pct }) : limits.canSell({ open: f.open, prevClose: f.prev_close, pct });
      if (!can) return false;
    }
  }
  return true;
}

/** @returns {{body: object} | {refusal: string}} */
function produce({ replay, terms }) {
  const bad = replayOutput.check(replay);
  if (bad) return { refusal: bad };
  const mult = terms && terms.thresholds && terms.thresholds.s3 && terms.thresholds.s3.cost_multiple;
  if (typeof mult !== 'number') return { refusal: 'S3_TERMS_COST_MULTIPLE_MISSING' };
  const cost = costRuns.produce({ replay });
  if (cost.refusal) return { refusal: cost.refusal };
  const b = replay.arms.baseline.daily; const c = replay.arms.candidate.daily;
  const d1 = stats.annualCi(stats.paired(c, b, 1));
  const dx = stats.annualCi(stats.paired(c, b, mult));
  const run = cost.v4.runs[0];
  const common = { n: d1.n, cost_x2: { multiple: mult, delta_g_ci_lower: dx.ci.lower }, cost_model_ref: run.cost_model_ref, cost_breakdown: run.cost_breakdown, constraints_ok: constraintsOk(replay.trades, replay.market) };
  if (terms.layer !== 'RISK') return { body: { ...common, delta_g: { estimate: d1.estimate, ci: d1.ci } } };
  const month = (arm) => { const by = new Map(); arm.forEach((x) => { const k = x.date.slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(x.gross - x.cost); }); return by; };
  const mb = month(b); const mc = month(c);
  const diffs = [...mb.keys()].sort().map((k) => stats.cvar5(mc.get(k)) - stats.cvar5(mb.get(k)));
  const est = stats.mean(diffs);
  const half = diffs.length >= 2 ? stats.tOf(diffs.length - 1) * stats.sd(diffs) / Math.sqrt(diffs.length) : 0;
  const pos = (x) => Math.max(0, x);
  return { body: { ...common, cvar5_improvement: { estimate: est, ci: { lower: est - half, upper: est + half, level: 0.95 } },
    growth_sacrifice: { estimate: pos(-d1.estimate), ci: { lower: pos(-d1.ci.upper), upper: pos(-d1.ci.lower), level: 0.95 } } } };
}

module.exports = { produce, constraintsOk };
