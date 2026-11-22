'use strict';

/**
 * S4 stage evidence producer (W24b; "portfolio increment: marginal net contribution, tail, overlap"). From the replay output's portfolio with and without the candidate:
 *   marginal_net_contribution  annualised paired daily net difference with - without, 95% interval from month blocks
 *   tail_ok                    CVaR5 of the portfolio with the candidate is not worse than without
 *   stress_ok                  every stress scenario's delta (with - without) is not negative
 *   overlap.holdings           mean holdings overlap (Jaccard) over the run; overlap.risk  absolute correlation of the candidate's increment over the baseline with the existing book's daily net
 *   race                       the RACE_V2 partition of the layer (RISK or SELECTION_TIMING)
 * Plan-coord ruling 11-23: S4 refuses `S4_STAR_MISSING:max_overlap` until config/promotion_terms_star.v1.json (ctx.promotionTermsStar) registers the overlap threshold for the layer.
 */
const replayOutput = require('./replay-output');
const stats = require('./stats');
const { isObj } = require('./common');

/** @returns {{body: object} | {refusal: string}} */
function produce({ replay, terms, star }) {
  const layer = isObj(star) && isObj(star.by_layer) ? star.by_layer[terms.layer] : null;
  const th = isObj(layer) && isObj(layer.thresholds) && isObj(layer.thresholds.s4) ? layer.thresholds.s4 : null;
  if (!th || typeof th.max_overlap !== 'number') return { refusal: 'S4_STAR_MISSING:max_overlap' };
  const bad = replayOutput.check(replay);
  const pf = replay && replay.portfolio;
  if (bad || !isObj(pf) || !Array.isArray(pf.with) || !Array.isArray(pf.without) || !Array.isArray(pf.stress) || !Array.isArray(pf.holdings_overlap)) return { refusal: bad || 'REPLAY_OUTPUT_INVALID' };
  if (pf.with.length !== pf.without.length || pf.with.some((x, i) => x.date !== pf.without[i].date)) return { refusal: 'REPLAY_PORTFOLIO_NOT_ALIGNED' };
  const diff = stats.annualCi(pf.with.map((x, i) => ({ date: x.date, v: x.net - pf.without[i].net })));
  const cd = replay.arms.candidate.daily; const bd = replay.arms.baseline.daily;
  const cand = cd.map((x, i) => (x.gross - x.cost) - (bd[i].gross - bd[i].cost)); // the candidate's increment over the baseline: does it just repeat the existing book?
  const book = pf.without.map((x) => x.net);
  const n = Math.min(cand.length, book.length);
  return { body: { n: diff.n, marginal_net_contribution: { estimate: diff.estimate, ci: diff.ci },
    tail_ok: stats.cvar5(pf.with.map((x) => x.net)) >= stats.cvar5(book), stress_ok: pf.stress.every((s) => s.delta >= 0),
    overlap: { holdings: stats.mean(pf.holdings_overlap.map((x) => x.jaccard)), risk: Math.abs(stats.corr(cand.slice(0, n), book.slice(0, n))) },
    race: { partition: terms.layer === 'RISK' ? 'RISK' : 'SELECTION_TIMING' } } };
}

module.exports = { produce };
