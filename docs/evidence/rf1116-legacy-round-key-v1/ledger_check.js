'use strict';
// On a COPY of the lane's research ledger (never the live one): can rounds 2 and 3 be moved on (beginScoring writes a new head row)?
//   QRP_DATA_DIR=<copy dir, with research/mining_rounds.jsonl> node ledger_check.js
// Before this change: round 2 -> MINE_ROUND_SCHEMA_INVALID:MISSING:scoring_neutralization, round 3 fine. After: both fine; round 2's new row still has no key.
const path = require('path');
const rounds = require(path.join(__dirname, '..', '..', '..', 'services/mining-rounds'));
const neutralization = require(path.join(__dirname, '..', '..', '..', 'services/mining-rounds/neutralization'));
const ho = { segment: { from: '2026-10-19', to: '2026-12-31' }, family_ids: ['MINE:CN_A:H5'], count: 1 };
for (const id of ['MR-CN_A-2026-11-2a1d2c9c82', 'MR-CN_A-2026-11-a6cb823f86']) {
  const before = rounds.roundHead(id);
  let result; try { rounds.beginScoring(id, { holdoutOpens: ho }); result = 'beginScoring OK (on the copy)'; } catch (e) { result = String(e.message).split('\n')[0]; }
  const after = rounds.roundHead(id);
  console.log(JSON.stringify({ round_id: id, status_before: before.status, key_before: Object.prototype.hasOwnProperty.call(before, 'scoring_neutralization'), result, status_after: after.status,
    key_after: Object.prototype.hasOwnProperty.call(after, 'scoring_neutralization'), neutralization: neutralization.neutralizationOf(after) }));
}
