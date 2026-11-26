'use strict';

/**
 * RF1116 second CN_A holdout segment (R2): the END-RESOLUTION record (plan-coord 2026-11-23).
 *
 * R2's start is "the first trading day after 2026-12-31" and its length 54 trading days, so its window is known only once the SSE calendar lists that many open days. The round
 * manifest records the end as UNKNOWN / CALENDAR_NOT_PUBLISHED and never changes (it is pre-registration). The window is fixed by ONE append-only row per segment
 * (research/holdout_segment_resolutions.jsonl, HOLDOUT_SEGMENT_RESOLUTION_V1) that says which calendar was read (file names, sha256, SHA256SUMS sha256, rows read, last calendar
 * date) and which days were counted (first, last, 54 days, sha256 of the dates). The program that writes it is round-runner/resolve-segment.js (CLI `resolve-segment`).
 *
 *   resolutionOf(segmentId)   the row, or null
 *   windowOf(round)           the window a round is scored on: R1 and explicit windows from the manifest; R2 from the row; null while R2 is unresolved
 *   record(body)              the one writer: validates against the registry rule; the same window again is a no-op, a different window is refused (the window never moves)
 * Error codes MINE_SEGMENT_RESOLUTION_*.
 */
const path = require('path');
const { dataDir, append, read } = require('../../packages/ledger');
const { validateRecord } = require('../../schemas');
const trials = require('../trial-ledger');
const holdoutSegments = require('./holdout-segments');

const SCHEMA = 'HOLDOUT_SEGMENT_RESOLUTION_V1';
const LEDGER = () => path.join(dataDir('research'), 'holdout_segment_resolutions.jsonl');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA64 = /^[0-9a-f]{64}$/;

class SegmentResolutionError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const need = (c, code, detail) => { if (!c) throw new SegmentResolutionError(code, detail); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The row of a segment, or null. */
function resolutionOf(segmentId) {
  const rows = read(LEDGER()).filter((r) => r.schema === SCHEMA && r.segment === segmentId);
  if (!rows.length) return null;
  const rec = rows[0];
  need(SHA64.test(rec.record_hash || '') && trials.recordHash(rec) === rec.record_hash, 'MINE_SEGMENT_RESOLUTION_INVALID', 'record_hash');
  return rec;
}

/**
 * The window a round is scored on: { from, to, segment, resolution_record_hash }.
 * A round whose manifest block names real dates (R1, explicit windows) uses them; a registry round on R2 uses its resolution row; otherwise null (unresolved).
 */
function windowOf(round) {
  const h = round && round.holdout;
  if (holdoutSegments.isResolved(h)) return { from: h.from, to: h.to, segment: typeof h.segment === 'string' ? h.segment : null, resolution_record_hash: null };
  if (isObj(h) && typeof h.segment === 'string') {
    const rec = resolutionOf(h.segment);
    if (rec && DATE.test(rec.window.from) && DATE.test(rec.window.to)) return { from: rec.window.from, to: rec.window.to, segment: h.segment, resolution_record_hash: rec.record_hash };
  }
  return null;
}

/** Validates a resolution body against the registry rule of its segment. */
function check(body) {
  const entry = holdoutSegments.REGISTRY.find((e) => e.id === body.segment);
  need(entry && entry.start, 'MINE_SEGMENT_RESOLUTION_NOT_RESOLVABLE', String(body.segment));
  need(body.market === entry.market, 'MINE_SEGMENT_RESOLUTION_INVALID', `market:${body.market}`);
  need(isObj(body.rule) && body.rule.start_rule === entry.start.rule && body.rule.start_after === entry.start.after && body.rule.length_trading_days === entry.length_trading_days, 'MINE_SEGMENT_RESOLUTION_INVALID', 'rule');
  const w = body.window;
  need(isObj(w) && DATE.test(w.from || '') && DATE.test(w.to || '') && w.from <= w.to && w.from > entry.start.after, 'MINE_SEGMENT_RESOLUTION_INVALID', 'window');
  need(w.days === entry.length_trading_days && SHA64.test(w.days_sha256 || ''), 'MINE_SEGMENT_RESOLUTION_INVALID', 'window.days');
  const c = body.calendar;
  need(isObj(c) && typeof c.exchange === 'string' && c.exchange && Array.isArray(c.files) && c.files.length > 0 && c.files.every((f) => isObj(f) && typeof f.name === 'string' && SHA64.test(f.sha256 || ''))
    && SHA64.test(c.sums_sha256 || '') && Number.isInteger(c.rows_read) && DATE.test(c.last_date || '') && c.last_date >= w.to, 'MINE_SEGMENT_RESOLUTION_INVALID', 'calendar');
  need(typeof body.resolved_at === 'string' && body.resolved_at && typeof body.resolved_by === 'string' && body.resolved_by, 'MINE_SEGMENT_RESOLUTION_INVALID', 'resolved');
  return entry;
}

/**
 * The one writer. The same window for a segment that already has a row is a no-op (returns the existing row); a different window is MINE_SEGMENT_RESOLUTION_CONFLICT.
 * Returns the row. The row is written as { schema, segment, market, rule, calendar, window, resolved_at, resolved_by, record_hash }.
 */
function record(input) {
  const { record_hash: _h, schema: _s, ...rest } = input || {};
  check(rest);
  const existing = resolutionOf(rest.segment);
  if (existing) {
    const same = existing.window.from === rest.window.from && existing.window.to === rest.window.to && existing.window.days_sha256 === rest.window.days_sha256;
    need(same, 'MINE_SEGMENT_RESOLUTION_CONFLICT', `${rest.segment}: recorded ${existing.window.from}..${existing.window.to}, now ${rest.window.from}..${rest.window.to}`);
    return existing;
  }
  const body = { schema: SCHEMA, segment: rest.segment, market: rest.market, rule: rest.rule, calendar: rest.calendar, window: rest.window, resolved_at: rest.resolved_at, resolved_by: rest.resolved_by };
  const rec = { ...body, record_hash: trials.recordHash(body) };
  const v = validateRecord(rec, SCHEMA);
  need(v.ok, 'MINE_SEGMENT_RESOLUTION_INVALID', v.problems.join(','));
  return append(LEDGER(), rec);
}

module.exports = { SCHEMA, LEDGER, SegmentResolutionError, resolutionOf, windowOf, record };
