'use strict';

/**
 * RF1116 holdout segment registry (CN_A): the locked holdout segment is a registry entry, not a constant.
 *
 *   R1  2026-10-19 .. 2026-12-31 (54 trading days). Frozen page RF1116_HOLDOUT_CN_A_R1_FREEZE_1 (segments.js FREEZE_PAGE). Rounds opened in 2026-11 and earlier.
 *   R2  start = the first trading day after 2026-12-31, length = 54 trading days, end = the 54th trading day counting the start. Rounds opened in 2026-12 onwards.
 *       Signed by the Owner 2026-11-23 11:56 CST (defaults a/a/a), page RF1116_HOLDOUT_CN_A_R2_FREEZE_1 (plan-coord).
 *       The 2027 SSE calendar is not published far enough, so the end is recorded as UNKNOWN / CALENDAR_NOT_PUBLISHED. It is never estimated and no other calendar replaces it.
 *       A round on R2 can generate, validate and select; the holdout cannot be opened or scored while the end is UNKNOWN (holdout-vault open, round-runner score / rescore).
 *
 * A round that does not name a window (mining-rounds openRound) selects its segment by the month it opens in (Beijing time). Counting and limits stay in mining-rounds
 * (LIMITS.rounds_per_holdout, the extra-round amendment's counting method); this module is data and pure functions, no ledger access.
 * R1 values come from services/mining-sandbox/segments.js, unchanged: the R1 manifest block is exactly { from, to }, as before the registry.
 */
const segs = require('../mining-sandbox/segments');

const UNKNOWN = 'UNKNOWN / CALENDAR_NOT_PUBLISHED';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const REGISTRY = Object.freeze([
  Object.freeze({
    id: 'R1', number: 1, market: 'CN_A',
    months: Object.freeze({ from: null, to: '2026-11' }),
    window: Object.freeze({ from: segs.SEGMENTS.HOLDOUT.from, to: segs.SEGMENTS.HOLDOUT.to }),
    start: null,
    length_trading_days: 54,
    sealed_dir: 'rf1116-cn-a-daily-holdout-from-20261019', // what run.sh has always used
    freeze: segs.FREEZE_PAGE,
  }),
  Object.freeze({
    id: 'R2', number: 2, market: 'CN_A',
    months: Object.freeze({ from: '2026-12', to: null }),
    window: null,
    start: Object.freeze({ rule: 'FIRST_TRADING_DAY_AFTER', after: '2026-12-31' }),
    length_trading_days: 54,
    sealed_dir: 'rf1116-cn-a-daily-holdout-r2',
    // Cited until plan-coord freezes the page; then the frozen page and its sha256 replace this draft (same swap as the extra-round amendment).
    freeze: Object.freeze({
      path: 'artifacts/coordinator/RF1116_HOLDOUT_CN_A_R2_FREEZE_1.draft.md',
      sha256: 'b97f9916b20ba5a6ba8c8db8e5a6e5e750578a02c6635c812d4bbd2b01993dab',
      repo_copy: 'docs/evidence/rf1116-holdout-segment-registry-v1/RF1116_HOLDOUT_CN_A_R2_FREEZE_1.draft.md',
    }),
  }),
]);

/** The segment a round opening in `month` (YYYY-MM, Beijing time) uses; null when the market has no registry segment or the month is not a month. */
function entryForMonth(month, market) {
  if (typeof month !== 'string' || !MONTH.test(month) || typeof market !== 'string') return null;
  return REGISTRY.find((e) => e.market === market && (e.months.from === null || month >= e.months.from) && (e.months.to === null || month <= e.months.to)) || null;
}

/** The manifest `holdout` block for a segment. R1: exactly { from, to }. R2: the rule, with the unresolved window as UNKNOWN. */
function holdoutOf(entry) {
  if (entry.window) return { from: entry.window.from, to: entry.window.to };
  return { segment: entry.id, start_rule: entry.start.rule, start_after: entry.start.after, length_trading_days: entry.length_trading_days, from: UNKNOWN, to: UNKNOWN };
}

/** Which registry segment a stored round's `holdout` block belongs to (by segment id, or by the R1 window for rows written before the registry); null = not registered. */
function entryOfBlock(h) {
  if (!isObj(h)) return null;
  if (typeof h.segment === 'string') {
    const e = REGISTRY.find((x) => x.id === h.segment);
    return e && e.start && h.start_after === e.start.after && h.length_trading_days === e.length_trading_days ? e : null;
  }
  return REGISTRY.find((e) => e.window && h.from === e.window.from && h.to === e.window.to) || null;
}

/** True when the block names a real window (both ends are dates). R2 rows are never resolved at open: the calendar is not known then. */
const isResolved = (h) => isObj(h) && DATE.test(h.from || '') && DATE.test(h.to || '');

/**
 * Does the holdout start strictly after the model's knowledge cutoff? A window with a start date: start > cutoff. A rule-defined start (R2): the start is strictly after
 * the day the rule counts from, so start_after >= cutoff is enough (and the check stays exact: nothing is assumed about the unresolved day).
 */
const startsAfter = (h, cutoff) => (DATE.test(h.from || '') ? h.from > cutoff : h.start_after >= cutoff);

/**
 * The window of a segment given the SSE open days known so far (ascending ISO dates; unsorted input is sorted). Pure; the loader that feeds it is not part of this module.
 * R1: always resolved. R2: start = the first listed open day after the start rule's date; end = the 54th open day counting the start; fewer listed days -> the end is
 * UNKNOWN (never estimated). A day that is not listed is not an open day, and an open day beyond the listed ones is not guessed.
 */
function resolveWindow(entry, calendar) {
  if (entry.window) return { status: 'RESOLVED', from: entry.window.from, to: entry.window.to };
  const cal = [...new Set((Array.isArray(calendar) ? calendar : []).filter((d) => typeof d === 'string' && DATE.test(d)))].sort();
  const i = cal.findIndex((d) => d > entry.start.after);
  if (i < 0) return { status: UNKNOWN, from: UNKNOWN, to: UNKNOWN };
  const last = i + entry.length_trading_days - 1;
  if (last >= cal.length) return { status: UNKNOWN, from: cal[i], to: UNKNOWN };
  return { status: 'RESOLVED', from: cal[i], to: cal[last] };
}

/** The registry segment whose sealed directory a data ref names (the last path component of the ref), or null for refs that name no segment directory. */
function refOwner(dataRef) {
  if (typeof dataRef !== 'string') return null;
  const last = dataRef.replace(/\/+$/, '').split('/').pop();
  return REGISTRY.find((e) => e.sealed_dir === last) || null;
}

module.exports = { REGISTRY, UNKNOWN, entryForMonth, holdoutOf, entryOfBlock, isResolved, startsAfter, resolveWindow, refOwner };
