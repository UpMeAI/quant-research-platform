'use strict';

/**
 * S5 on the holdout is 3-way (plan-coord 11-23; Owner rule: insufficient is never a rejection):
 *   G-MINE PASS                                              -> S5 PASS (CLAIM_ELIGIBLE)
 *   G-MINE FAIL with the sample the K2 requires              -> S5 FAIL (STOPPED_NEGATIVE, 不做)
 *   G-MINE outcome short of sample or power                  -> S5 INSUFFICIENT (RUNNING_DESCRIBE_ONLY), resolved through amendment section 4.2 (做 or 暂停)
 * "Sufficient" here: the holdout produced at least the K2's min_sample_n IC days (an unknown day count is not enough). The K2's power terms are the same min_sample_n
 * (the power tool's n_required is copied into it by the freeze program). Names per day are covered by the runner's own holdout floor checks before the open.
 */
const path = require('path');
const fs = require('fs');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function fromScore({ record, result, minSampleN }) {
  const days = result && result.holdout ? result.holdout.ic_days : null;
  return { pass: Boolean(record && record.pass), sufficient: isNum(days) && days >= minSampleN };
}

/** The default reader: the G-MINE record from the ledger and the runner's score.json in the round's run directory. */
function readDefault({ roundId, candidateId, runDir, minSampleN }) {
  const record = require('../mining-rounds/gate-records').recordsOf(roundId).find((x) => x.candidate_id === candidateId);
  let result = null;
  try { result = JSON.parse(fs.readFileSync(path.join(runDir, 'score.json'), 'utf8')).results.find((x) => x.candidate_id === candidateId); } catch { /* unknown stays unknown */ }
  return fromScore({ record, result, minSampleN });
}

const STATE = Object.freeze({ PASS: 'CLAIM_ELIGIBLE', FAIL: 'STOPPED_NEGATIVE', INSUFFICIENT: 'RUNNING_DESCRIBE_ONLY' });
const stateOf = (o) => (o.pass ? STATE.PASS : o.sufficient ? STATE.FAIL : STATE.INSUFFICIENT);

module.exports = { fromScore, readDefault, stateOf, STATE };
