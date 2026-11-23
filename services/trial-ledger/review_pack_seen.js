'use strict';

/**
 * W05 (plan-coord ruling 11-23): a delivered review fact pack is development information. STUB for the red-first commit: every function is a harmless no-op, so the
 * acceptance tests in tests/review_pack_seen.test.js fail on their assertions. The implementation follows in the next commit.
 */
const KIND = 'REVIEW_FACT_PACK_V1';
const noop = () => [];

module.exports = {
  KIND,
  packSha256: () => null,
  describe: noop,
  markPack: noop,
  packMarks: noop,
  reviewedThrough: () => null,
  seenRanges: noop,
  dataStart: () => null,
  backfill: () => ({ marked: [], invalid: [], missing: [] }),
};
