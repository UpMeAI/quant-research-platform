'use strict';

/**
 * S4 stage evidence producer (W24b; "portfolio increment: marginal net contribution, tail, overlap"). From the replay output's portfolio with and without the candidate:
 *   marginal_net_contribution  annualised paired daily net difference with - without, 95% interval from month blocks
 *   tail_ok                    CVaR5 of the portfolio with the candidate is not worse than without
 *   stress_ok                  every stress scenario's delta (with - without) is not negative
 *   overlap.holdings, overlap.risk  both the full-sample absolute correlation of the candidate's daily net with the existing book's daily net, paired by date (NOTE_1 6b3be10d: the overlap is
 *                      |rho| of daily net returns of the candidate against the existing portfolio). The replay's `holdings_overlap` series (field name kept, values |rolling rho|) is validated but not
 *                      averaged here.
 *   race                       the RACE_V2 partition of the layer (RISK or SELECTION_TIMING)
 * Plan-coord ruling 11-23: S4 refuses `S4_STAR_MISSING:max_overlap` until config/promotion_terms_star.v1.json (ctx.promotionTermsStar) registers the overlap threshold for the layer.
 */
const replayOutput = require('./replay-output');
const stats = require('./stats');
const { isObj } = require('./common');

const IDLE_BELOW = 0.2; // plan-coord 11-23: below 20% active days the S4 result carries limitation EXISTING_BOOK_MOSTLY_IDLE

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
  const candBy = new Map(replay.arms.candidate.daily.map((x) => [x.date, x.gross - x.cost]));
  const joint = pf.without.filter((x) => candBy.has(x.date));
  if (joint.length < 2) return { refusal: 'REPLAY_PORTFOLIO_NOT_ALIGNED' };
  const rho = Math.abs(stats.corr(joint.map((x) => candBy.get(x.date)), joint.map((x) => x.net))); // does the candidate just repeat the existing book?
  const book = pf.without.map((x) => x.net);
  // the existing book may be idle most days (the stock book is idle on 80.7% of replay days): the low overlap against an idle book is real but must be visible. The decision stays on the marginal contribution.
  const activeShare = pf.without.length ? pf.without.filter((x) => x.net !== 0).length / pf.without.length : 0;
  return { body: { ...(activeShare < IDLE_BELOW ? { limitation: 'EXISTING_BOOK_MOSTLY_IDLE' } : {}), existing_book_active_share: activeShare, n: diff.n, marginal_net_contribution: { estimate: diff.estimate, ci: diff.ci },
    tail_ok: stats.cvar5(pf.with.map((x) => x.net)) >= stats.cvar5(book), stress_ok: pf.stress.every((s) => s.delta >= 0),
    overlap: { holdings: rho, risk: rho },
    race: { partition: terms.layer === 'RISK' ? 'RISK' : 'SELECTION_TIMING' } } };
}

module.exports = { produce };
