'use strict';

/**
 * RF1116 second CN_A holdout segment (R2): the program that resolves a segment's end from the SSE calendar and writes the end-resolution record
 * (services/mining-rounds/segment-resolution.js). It reads the segment directory's trading_calendar.csv (SHA256SUMS-checked by the source reader), counts the open days after the
 * start rule's date, and when the calendar lists enough of them appends ONE HOLDOUT_SEGMENT_RESOLUTION_V1 row that says which calendar it read and which days it counted.
 * It reads no price, no basic and no holdout rows. Not enough listed days: NOT_READY, nothing written (a timer runs it again). A second run with the same calendar is a no-op;
 * a calendar that counts a different window after a row exists is MINE_SEGMENT_RESOLUTION_CONFLICT (the window never moves). Errors MINE_RUNNER_SEGMENT_*.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const adapter = require('../data-adapter');
const holdoutSegments = require('../../mining-rounds/holdout-segments');
const resolution = require('../../mining-rounds/segment-resolution');
const rounds = require('../../mining-rounds');
const trials = require('../../trial-ledger');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
class SegmentResolveError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const CALENDAR_SEQUENCE_SUFFIXED = /^_\d{4}\.csv$/;
const stamp = () => new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');

/**
 * The resolved window is UNSEEN data (W05; verifier V-2; the lab): dates nobody marked count as SEEN, so without a mark every UNSEEN claim over R2's days would be refused.
 * Written through the existing trials.markSegments (the marks API is untouched), once per family of the rounds that sit on the segment; a later run marks families that were
 * not there yet and writes nothing else. No round on the segment: nothing to mark.
 */
function ensureUnseenMarks(rec, entry) {
  const families = [...new Set(rounds.roundsOf(entry.market).filter((r) => r.holdout && r.holdout.segment === rec.segment).flatMap((r) => r.family_ids))].sort();
  // only days nobody marked yet (trials.segmentsFor: unmarked days are the SEEN default): a mark someone wrote on purpose, SEEN or UNSEEN, is never overwritten, and a rerun writes nothing
  const unmarked = (f) => trials.segmentsFor(f, rec.window.from, rec.window.to).pieces.filter((p) => p.source === 'UNMARKED_DEFAULT_SEEN');
  const todo = families.flatMap((f) => unmarked(f).map((p) => ({
    family_id: f, market: entry.market, from: p.from, to: p.to, label: 'UNSEEN',
    reason: `RF1116 ${rec.segment} holdout window (end-resolution record ${rec.record_hash.slice(0, 12)}): data that did not exist when the candidates were frozen`, source_refs: [`HOLDOUT_SEGMENT_RESOLUTION_V1:${rec.record_hash}`],
  })));
  return todo.length ? trials.markSegments(todo, { registeredBy: process.env.QRP_PRODUCT_MILESTONE_AUTHORITY }) : [];
}

/**
 * @param {{segmentId: string, dir: string, resolvedBy?: string, resolvedAt?: string}} o
 * @returns {{status: 'RESOLVED', created: boolean, segment: string, window: object, record: object} | {status: 'NOT_READY', segment: string, reason: string, calendar_last_date: string}}
 */
function resolveSegment({ segmentId, dir, resolvedBy = 'round-runner', resolvedAt = null } = {}) {
  const entry = holdoutSegments.REGISTRY.find((e) => e.id === segmentId);
  if (!entry || !entry.start) throw new SegmentResolveError('MINE_RUNNER_SEGMENT_NOT_RESOLVABLE', String(segmentId));
  const src = adapter.csvDirSource(dir, { mode: 'LIVE', label: 'holdout-resolve', holdout: true });
  const cal = adapter.openDaysOf([src]); // each calendar file is sha-checked against SHA256SUMS while it is read
  const w = holdoutSegments.resolveWindow(entry, cal.days);
  if (w.status !== 'RESOLVED') {
    const listed = cal.days.filter((d) => d > entry.start.after).length;
    return { status: 'NOT_READY', segment: segmentId, reason: `listed ${listed} open days after ${entry.start.after}, need ${entry.length_trading_days}`, calendar_last_date: cal.last_date };
  }
  const counted = cal.days.filter((d) => d >= w.from && d <= w.to);
  if (counted.length !== entry.length_trading_days) throw new SegmentResolveError('MINE_RUNNER_SEGMENT_COUNT', `${counted.length}`);
  const stem = 'trading_calendar';
  const files = [`${stem}.csv`, ...fs.readdirSync(dir).filter((n) => n.startsWith(stem) && CALENDAR_SEQUENCE_SUFFIXED.test(n.slice(stem.length))).sort()]
    .map((name) => ({ name, sha256: sha256(fs.readFileSync(path.join(dir, name))) }));
  const existing = resolution.resolutionOf(segmentId);
  const rec = resolution.record({
    segment: segmentId, market: entry.market,
    rule: { start_rule: entry.start.rule, start_after: entry.start.after, length_trading_days: entry.length_trading_days, freeze: entry.freeze },
    calendar: { exchange: cal.exchange, files, sums_sha256: sha256(fs.readFileSync(path.join(dir, 'SHA256SUMS'))), rows_read: cal.rows, last_date: cal.last_date },
    window: { from: w.from, to: w.to, days: counted.length, days_sha256: sha256(counted.join('\n')) },
    resolved_at: resolvedAt || stamp(), resolved_by: resolvedBy,
  });
  const marks = ensureUnseenMarks(rec, entry);
  return { status: 'RESOLVED', created: !existing, segment: segmentId, window: { from: rec.window.from, to: rec.window.to }, record: rec, unseen_marks: marks.length };
}

module.exports = { resolveSegment, SegmentResolveError };
