'use strict';

/**
 * RF1116 holdout data arrival: the external ANCHOR of the hash chain (#157 independent review 2026-11-23, plan-coord fix round).
 *
 * The chain (round-runner/arrival.js, ARRIVAL_CHAIN_V1.jsonl) lives in the directory it protects: whoever can rewrite the directory can rewrite a consistent chain. After every arrival the head
 * {segment, seq, record_hash, last_day} is appended to a lane ledger (research/holdout_arrival_anchors.jsonl, HOLDOUT_ARRIVAL_ANCHOR_V1), written by a container that holds only that ledger
 * (`run.sh arrive` runs it after the writer; the lane ledger is owned by the container uid, not by the account that can write the holdout directory). verifyChain (arrive, arrive-check, score) refuses a
 * chain whose head seq is below the last anchor (ROLLBACK) or whose row at an anchored seq has another record_hash (REWRITE). It is not the holdout vault and holds no data.
 *
 *   anchorsOf(segment)   the rows of a segment, ascending by seq
 *   pairsOf(segment)     the same as { seq, record_hash } pairs for verifyChain
 *   record(o)            the one writer: the same anchor again is a no-op, a seq below the last anchor is MINE_ANCHOR_BELOW_LAST, another hash at an anchored seq is MINE_ANCHOR_CONFLICT
 * Error codes MINE_ANCHOR_*.
 */
const path = require('path');
const { dataDir, append, read } = require('../../packages/ledger');
const { validateRecord } = require('../../schemas');
const trials = require('../trial-ledger');

const SCHEMA = 'HOLDOUT_ARRIVAL_ANCHOR_V1';
const LEDGER = () => path.join(dataDir('research'), 'holdout_arrival_anchors.jsonl');
const SEGMENTS = Object.freeze(['R1', 'R2']);
const SHA64 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class AnchorError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const need = (c, code, detail) => { if (!c) throw new AnchorError(code, detail); };

/** The anchors of a segment, ascending by seq. */
function anchorsOf(segment) {
  return read(LEDGER()).filter((r) => r.schema === SCHEMA && r.segment === segment).sort((a, b) => a.seq - b.seq);
}

/** The one writer. Returns the row (the existing one for the same anchor again). */
function record({ segment, seq, recordHash, lastDay = null, anchoredBy, anchoredAt = null } = {}) {
  need(SEGMENTS.includes(segment), 'MINE_ANCHOR_SEGMENT', String(segment));
  need(Number.isInteger(seq) && seq >= 0 && SHA64.test(recordHash || '') && (lastDay === null || DATE.test(lastDay)) && typeof anchoredBy === 'string' && anchoredBy, 'MINE_ANCHOR_INVALID', `${seq}:${recordHash}`);
  const rows = anchorsOf(segment);
  const same = rows.find((r) => r.seq === seq);
  if (same) { need(same.chain_record_hash === recordHash, 'MINE_ANCHOR_CONFLICT', `${segment} seq ${seq}: anchored ${same.chain_record_hash.slice(0, 12)}, now ${recordHash.slice(0, 12)}`); return same; }
  const last = rows.length ? rows[rows.length - 1].seq : -1;
  need(seq > last, 'MINE_ANCHOR_BELOW_LAST', `${segment}: seq ${seq} is below the last anchor ${last}`);
  // the row's own record_hash is over its body; the anchored chain row's hash is the separate field chain_record_hash
  const row = { schema: SCHEMA, segment, seq, chain_record_hash: recordHash, last_day: lastDay, anchored_by: anchoredBy, anchored_at: anchoredAt || new Date(Date.now() + 8 * 3600e3).toISOString().replace(/\.\d{3}Z$/, '+08:00') };
  const out = { ...row, record_hash: trials.recordHash(row) };
  const v = validateRecord(out, SCHEMA);
  need(v.ok, 'MINE_ANCHOR_INVALID', v.problems.join(','));
  return append(LEDGER(), out);
}

/** The anchors of a segment in the shape verifyChain takes: { seq, record_hash } (the hash of the chain row). */
const pairsOf = (segment) => anchorsOf(segment).map((r) => ({ seq: r.seq, record_hash: r.chain_record_hash }));

module.exports = { SCHEMA, LEDGER, AnchorError, anchorsOf, pairsOf, record };
