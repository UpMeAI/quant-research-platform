'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const W = require('./_lab_fixture');
const lab = require('../services/research-lab-e2e');
const trials = require('../services/trial-ledger');
const reviewSeen = require('../services/trial-ledger/review_pack_seen');
const { read } = require('../packages/ledger');

/**
 * W05 ruling section 2 and 3 (AC9): the lab's card step is an entry point of the review fact pack (the pack the card was built from comes in through services.bundle()).
 * It writes the SEEN mark of the pack it consumes (idempotent by the pack sha256); the SEEN ranges of the lineage and the final test path are then read from the ledger marks,
 * not computed from the review agent's access log. A refused mark is a refused card.
 */
const packMarks = () => read(trials.SEGMENTS()).filter((r) => r.label === 'SEEN' && Array.isArray(r.source_refs) && r.source_refs.some((x) => x && x.kind === reviewSeen.KIND));
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('lab: the pack the card consumed is marked SEEN once; lineage seen_ranges and the final test come from that mark; the checker recomputes the same from the ledger', async () => {
  const w = await W.buildWorld({ factDate: W.W47_DATE });
  const res = lab.run(w.job, w.services);
  assert.equal(res.status, 'COMPLETE', JSON.stringify(res));
  const marks = packMarks();
  assert.equal(marks.length, 1, 'one mark for the one pack');
  assert.equal(marks[0].source_refs[0].sha256, reviewSeen.packSha256(w.services.bundle().pack), 'the source reference is the pack sha256');
  assert.deepEqual([marks[0].market, marks[0].from, marks[0].to], ['CN_A', W.W47_DATE, W.W47_DATE]);
  const lin = json(res.lineage_path);
  assert.deepEqual(lin.seen_ranges, [{ from: W.W47_DATE, to: W.W47_DATE, source: 'REVIEW_CARD' }], 'the lineage SEEN range is the ledger mark');
  assert.equal(lin.final_test.kind, 'FORWARD');
  const check = lab.check({ out_dir: w.outDir, as_of: w.job.as_of, services: w.services });
  assert.equal(check.overall, 'PASS', JSON.stringify(check.conditions));
});

test('lab: a refused mark is a refused card (no SEEN range is ever taken from the access log instead)', async () => {
  const w = await W.buildWorld({ factDate: W.W47_DATE });
  w.services.reviewSeen = { registeredBy: 'NOT_THE_AUTHORITY' };
  const res = lab.run(w.job, w.services);
  assert.equal(res.status, 'REFUSED');
  assert.equal(res.reason_code, 'LAB_CARD_SEEN_MARK_TRIAL_LEDGER_REGISTERED_BY_NOT_AUTHORIZED');
  assert.equal(packMarks().length, 0);
});
