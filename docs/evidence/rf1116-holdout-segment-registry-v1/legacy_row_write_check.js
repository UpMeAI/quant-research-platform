'use strict';
// FINDING, not changed by this PR. On a COPY of the lane ledger: can the three November rounds still be moved on (beginScoring writes a new head row)?
//   QRP_DATA_DIR=<copy dir> node legacy_row_write_check.js
// Round 2 (opened 2026-11-18, before the scoring_neutralization field existed) has no such key in its row; write() validates every row with MINING_ROUND_V1,
// where an absent field is MISSING, so any later row for round 2 (SCORING, close, failures) is refused. Round 3 (has the key) is fine.
const path = require('path');
const rounds = require(path.join(__dirname, '..', '..', '..', 'services/mining-rounds'));
const ho = { segment: { from: '2026-10-19', to: '2026-12-31' }, family_ids: ['MINE:CN_A:H5'], count: 1 };
for (const id of ['MR-CN_A-2026-11-2a1d2c9c82', 'MR-CN_A-2026-11-a6cb823f86']) {
  const h = rounds.roundHead(id);
  const has = Object.prototype.hasOwnProperty.call(h, 'scoring_neutralization');
  let result; try { rounds.beginScoring(id, { holdoutOpens: ho }); result = 'beginScoring OK (on the copy)'; } catch (e) { result = String(e.message).split('\n')[0]; }
  console.log(JSON.stringify({ round_id: id, status: h.status, has_scoring_neutralization_key: has, result }));
}
