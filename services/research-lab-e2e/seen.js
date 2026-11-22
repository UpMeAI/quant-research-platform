'use strict';

/**
 * W05 semantics for the review card (plan-coord ruling 11-23 (1)): what the review agent read is development information. The fact range of the card is SEEN for every
 * candidate derived from it and is recorded in the lineage. A candidate's final test segment (the RF1116 holdout or the forward period) must never overlap a SEEN range.
 * A card whose facts overlap the RF1116 holdout (the W47 card, 2026-11-20) cannot use that holdout: its final test is the forward period after the card date (amendment 1.1 S5).
 */
const { SEGMENTS } = require('../mining-sandbox/segments');

const addDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;

/** Rows of the review agent's access log -> SEEN ranges (one per read, merged by identical range). */
function seenRangesOf(rows) {
  const out = [];
  for (const r of rows) {
    if (r.op !== 'READ') continue; // a refused attempt read nothing
    if (!out.some((x) => x.from === r.from && x.to === r.to)) out.push({ from: r.from, to: r.to, source: 'REVIEW_CARD' });
  }
  return out;
}

/** @returns {{kind: 'HOLDOUT', from: string, to: string} | {kind: 'FORWARD', from: string, reason: string}} */
function finalTestOf(seenRanges) {
  const holdout = SEGMENTS.HOLDOUT;
  const hit = seenRanges.filter((r) => overlaps(r, holdout));
  if (!hit.length) return { kind: 'HOLDOUT', from: holdout.from, to: holdout.to };
  const last = seenRanges.reduce((m, r) => (r.to > m ? r.to : m), '');
  return { kind: 'FORWARD', from: addDay(last), reason: 'SEEN_OVERLAPS_RF1116_HOLDOUT' };
}

/** DATA_SEGMENT_MARK_V1 rows for trial-ledger segmentsFor (the verifier's V-2 unseenClaim): the holdout UNSEEN, then every SEEN range on top (later marks win). */
function marksFor({ familyId, seenRanges }) {
  const mark = (id, from, to, label) => ({ schema: 'DATA_SEGMENT_MARK_V1', mark_id: id, family_id: familyId, from, to, label, seen_kind: null });
  return [mark('SEG-LAB-HOLDOUT', SEGMENTS.HOLDOUT.from, SEGMENTS.HOLDOUT.to, 'UNSEEN'), ...seenRanges.map((r, i) => mark(`SEG-LAB-SEEN-${i + 1}`, r.from, r.to, 'SEEN'))];
}

module.exports = { seenRangesOf, finalTestOf, marksFor, overlaps };
