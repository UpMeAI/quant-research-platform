'use strict';

/**
 * W05 semantics for the review card (plan-coord ruling 11-23, W05_REVIEWED_IS_SEEN_RULING_V1): what the review read is development information. The SEEN ranges are the SEEN marks
 * the trial ledger holds for the market (one per delivered review fact pack, written by the pack's entry point, see ../trial-ledger/review_pack_seen.js); this module reads them
 * and keeps no range algorithm of its own (no range is computed from the review agent's access log or from fact dates). Every SEEN range is development information for each
 * candidate derived from the card and is recorded in the lineage. A candidate's final test segment (the RF1116 holdout or the forward period) must never overlap a SEEN range.
 * A card whose facts overlap the RF1116 holdout (the W47 card, 2026-11-20) cannot use that holdout: its final test is the forward period after the last reviewed day (amendment 1.1 S5).
 */
const { SEGMENTS } = require('../mining-sandbox/segments');
const trials = require('../trial-ledger');
const reviewSeen = require('../trial-ledger/review_pack_seen');

/** The SEEN ranges of a market as of a time: the ledger's review-pack marks (read from the ledger, or from the rows given). */
function seenRangesOf({ market, asOf = null, marks = null }) {
  return reviewSeen.seenRanges(market, { asOf, marks }).map((r) => ({ from: r.from, to: r.to, source: 'REVIEW_CARD' }));
}

/** @returns {{kind: 'HOLDOUT', from: string, to: string} | {kind: 'FORWARD', from: string, reason: string}} */
function finalTestOf(seenRanges) {
  const holdout = SEGMENTS.HOLDOUT;
  if (!seenRanges.some((r) => reviewSeen.overlaps(r, holdout))) return { kind: 'HOLDOUT', from: holdout.from, to: holdout.to };
  return { kind: 'FORWARD', from: trials.addDay(reviewSeen.lastDay(seenRanges)), reason: 'SEEN_OVERLAPS_RF1116_HOLDOUT' };
}

/**
 * DATA_SEGMENT_MARK_V1 rows for trial-ledger segmentsFor (the verifier's V-2 unseenClaim): the holdout UNSEEN, then the ledger's SEEN marks on top (`marks`, rows as read from the
 * ledger; they are market-wide and win over the family's own marks). `seenRanges` (ranges given directly) is kept for callers that have no ledger rows.
 */
function marksFor({ familyId, market = null, seenRanges = [], marks = null }) {
  const mark = (id, from, to, label) => ({ schema: 'DATA_SEGMENT_MARK_V1', mark_id: id, family_id: familyId, market, from, to, label, seen_kind: null });
  const holdout = mark('SEG-LAB-HOLDOUT', SEGMENTS.HOLDOUT.from, SEGMENTS.HOLDOUT.to, 'UNSEEN');
  if (marks) return [holdout, ...marks];
  return [holdout, ...seenRanges.map((r, i) => mark(`SEG-LAB-SEEN-${i + 1}`, r.from, r.to, 'SEEN'))];
}

module.exports = { seenRangesOf, finalTestOf, marksFor, overlaps: reviewSeen.overlaps };
