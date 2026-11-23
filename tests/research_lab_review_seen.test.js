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
  const c3 = check.conditions.find((c) => c.id === 'C3_NO_GENERATOR_HOLDOUT_ACCESS');
  assert.equal(c3.verdict, 'PASS', JSON.stringify(c3)); // C3 recomputes the SEEN ranges and the final test from the ledger marks
});

test('lab: a refused mark is a refused card (no SEEN range is ever taken from the access log instead)', async () => {
  const w = await W.buildWorld({ factDate: W.W47_DATE });
  w.services.reviewSeen = { registeredBy: 'NOT_THE_AUTHORITY' };
  const res = lab.run(w.job, w.services);
  assert.equal(res.status, 'REFUSED');
  assert.equal(res.reason_code, 'LAB_CARD_SEEN_MARK_TRIAL_LEDGER_REGISTERED_BY_NOT_AUTHORIZED');
  assert.equal(packMarks().length, 0);
});

/* Review fixes (plan-coord 11-23 14:00): the lab card step refuses a mark that cannot be read back, and a pack dated far after the run (the lab clock is the job as_of, no host clock). */
test('lab: a torn ledger tail refuses the card (REVIEW_PACK_SEEN_NOT_READBACK, nothing marked)', async () => {
  const w = await W.buildWorld({ factDate: W.W47_DATE });
  const file = trials.SEGMENTS();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"schema":"DATA_SEGMENT_MARK_V1","mark_id":"SEG-torn","family_id":"X","mar');
  const res = lab.run(w.job, w.services);
  assert.equal(res.status, 'REFUSED');
  assert.equal(res.reason_code, 'LAB_CARD_SEEN_MARK_REVIEW_PACK_SEEN_NOT_READBACK');
  assert.equal(packMarks().length, 0);
});

test('lab: a pack dated far after the run as_of is refused (CUTOFF_IN_FUTURE); services.reviewSeen.now moves the limit', async () => {
  const w = await W.buildWorld({ factDate: '2099-01-01' });
  const res = lab.run(w.job, w.services);
  assert.equal(res.status, 'REFUSED');
  assert.equal(res.reason_code, 'LAB_CARD_SEEN_MARK_REVIEW_PACK_SEEN_CUTOFF_IN_FUTURE');
  assert.equal(packMarks().length, 0);
  const w2 = await W.buildWorld({ factDate: '2099-01-01' });
  w2.services.reviewSeen = { now: () => Date.parse('2099-02-01T00:00:00+08:00') };
  let res2 = null;
  try { res2 = lab.run(w2.job, w2.services); } catch { res2 = { reason_code: 'THROWN_AFTER_THE_MARK' }; }
  assert.notEqual(res2.reason_code, 'LAB_CARD_SEEN_MARK_REVIEW_PACK_SEEN_CUTOFF_IN_FUTURE');
  assert.equal(packMarks().length, 1, 'with the clock after the pack the mark is written');
});
