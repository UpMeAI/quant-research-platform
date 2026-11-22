'use strict';

/**
 * LAB_REPLAY_OUTPUT_V1: what the replay core hands the lab for a frozen candidate (a file contract; the real run happens in the W24 Linux slot).
 *   { schema, candidate_id, market, cost_model_ref, cost_book, cost_flags,
 *     arms: { baseline: { daily: [{date, gross, cost}] }, candidate: { daily: [...] } },       same dates, daily log growth gross of cost and the cost charged that day
 *     trades: [{date, code, st, side: BUY|SELL, notional, open, prev_close, participation}],   the candidate arm's fills
 *     perturbations: [{id, daily}],                                                             candidate under each declared parameter perturbation
 *     portfolio: { with: [{date, net}], without: [{date, net}], stress: [{id, delta}], holdings_overlap: [{date, jaccard}] } }
 */
const { isObj } = require('./common');

const isDaily = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => isObj(x) && /^\d{4}-\d{2}-\d{2}$/.test(x.date || '') && Number.isFinite(x.gross) && Number.isFinite(x.cost));

/** @returns {string|null} a refusal code, null when usable by S3/robustness */
function check(replay) {
  if (!isObj(replay) || replay.schema !== 'LAB_REPLAY_OUTPUT_V1' || !isObj(replay.arms) || !isObj(replay.arms.baseline) || !isObj(replay.arms.candidate)) return 'REPLAY_OUTPUT_INVALID';
  const b = replay.arms.baseline.daily; const c = replay.arms.candidate.daily;
  if (!isDaily(b) || !isDaily(c)) return 'REPLAY_OUTPUT_INVALID';
  if (b.length !== c.length || b.some((x, i) => x.date !== c[i].date)) return 'REPLAY_ARMS_NOT_ALIGNED';
  return null;
}

module.exports = { check, isDaily };
