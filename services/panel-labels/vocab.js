'use strict';

/**
 * Closed vocabularies of the W18 part 2 label table (W18_ALL_CANDIDATE_PANEL_CONTRACT_V1_FREEZE_1 section 7.2 and 9 W-7; docs/contracts/PANEL_LABELS_V1.md).
 * The window table lists ALLOWED values only. There is no pre-selected window anywhere in this module: every K2 picks its own windows and freezes them in its text.
 */
const crypto = require('crypto');
const { canonicalJson } = require('../trial-ledger');

class PanelLabelError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail === undefined ? null : detail; }
}
const fail = (code, detail) => { throw new PanelLabelError(code, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Panel market codes (CANDIDATE_PANEL_V1 `market`). */
const MARKETS = Object.freeze(['CN', 'US', 'CRYPTO']);
/** The names the trial ledger uses for a market in DATA_SEGMENT_MARK_V1 `market` (the mechanism register's aliases): a mark is of this market when its `market` is one of them. */
const MARKET_MARK_NAMES = Object.freeze({ CN: Object.freeze(['CN_A', 'CN']), US: Object.freeze(['US_EQUITY', 'US']), CRYPTO: Object.freeze(['CRYPTO', 'CRYPTO_USDM_PERP']) });
/** TM-0 calendar zones of the contract: the market's local date is the session date. */
const TIME_ZONE = Object.freeze({ CN: 'Asia/Shanghai', US: 'America/New_York', CRYPTO: 'UTC' });

/** W-7: allowed windows per market, sessions for CN and US, hours for crypto. Allowed values, not a choice. */
const WINDOW_TABLE = Object.freeze({
  CN: Object.freeze({ unit: 'SESSION', lengths: Object.freeze([1, 5, 10, 20]) }),
  US: Object.freeze({ unit: 'SESSION', lengths: Object.freeze([1, 5, 10, 20]) }),
  CRYPTO: Object.freeze({ unit: 'HOUR', lengths: Object.freeze([4, 24, 72]) }),
});
const UNIT_LETTER = Object.freeze({ SESSION: 'S', HOUR: 'H' });
const windowIdOf = (unit, length) => `W${length}${UNIT_LETTER[unit]}`;
/** A window is allowed when some market lists it (the label table row carries no market; the market was checked when the label was computed). */
const isAllowedWindow = (unit, length) => Object.values(WINDOW_TABLE).some((w) => w.unit === unit && w.lengths.includes(length));

/** @returns {{windowId: string, unit: string, length: number}} refuses a window the market's table does not list */
function parseWindowId(market, windowId) {
  const table = WINDOW_TABLE[market];
  need(table, 'LABEL_PANEL_INPUT_INVALID', `market:${market}`);
  const m = /^W([1-9]\d*)([SH])$/.exec(String(windowId));
  if (m && UNIT_LETTER[table.unit] === m[2] && table.lengths.includes(Number(m[1]))) return { windowId, unit: table.unit, length: Number(m[1]) };
  return fail('LABEL_WINDOW_NOT_ALLOWED', `${market}:${windowId}`);
}

/** Entry reference price method (closed). CN follows B13 (next session open); US and crypto take the first complete bar open after evaluatedAt. */
const ENTRY_BASIS = Object.freeze({ CN: 'NEXT_SESSION_OPEN', US: 'FIRST_COMPLETE_BAR_OPEN_AFTER_EVALUATION', CRYPTO: 'FIRST_COMPLETE_BAR_OPEN_AFTER_EVALUATION' });
const CN_PRICE_METHOD = 'RAW_OPEN_AND_CLOSE_TIMES_HISTORICAL_ADJ_FACTOR_V1';

/** Benchmarks of LOSS_ATTRIBUTION V1 item 1: CSI 300 for CN, SPY (QQQ for Nasdaq type holdings) for US, BTC for crypto. The first entry is the market's own benchmark. */
const BENCHMARKS = Object.freeze({ CN: Object.freeze(['CSI300']), US: Object.freeze(['SPY', 'QQQ']), CRYPTO: Object.freeze(['BTC']) });

const STATES = Object.freeze(['VALUE', 'UNKNOWN', 'NOT_APPLICABLE']);
/** Label level reason codes (closed). Report level codes live in report.js. */
const REASON_CODES = Object.freeze(['LABEL_NOT_MATURED', 'PRICE_UNAVAILABLE', 'INSTRUMENT_DELISTED_IN_WINDOW', 'PANEL_RECORD_MISMATCH', 'BENCHMARK_PRICE_UNAVAILABLE', 'EXCESS_BENCHMARK_UNAVAILABLE']);
const FOUR_STATES = Object.freeze(['UNKNOWN', 'NOT_PROVIDED', 'NOT_APPLICABLE']);
const RETURN_KEYS = Object.freeze(['grossReturn', 'benchmarkReturn', 'excessReturn']);

/** Label reads: the declared stage of the reading K2 (LB-4, LB-5). */
const READ_STAGES = Object.freeze(['SEEN', 'UNSEEN_FIRST_READ', 'FORWARD']);
const READ_DATASET = 'PANEL_LABELS_V1';

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const isIso = (v) => typeof v === 'string' && ISO_Z.test(v) && !Number.isNaN(Date.parse(v));
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const iso = (ms) => new Date(ms).toISOString();

/** The market's local calendar date of an instant (TM-0). */
function localDate(market, instant) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE[market], year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const by = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${by.year}-${by.month}-${by.day}`;
}

module.exports = {
  PanelLabelError, fail, need, sha256, canonicalJson, MARKETS, MARKET_MARK_NAMES, TIME_ZONE, WINDOW_TABLE, windowIdOf, isAllowedWindow, parseWindowId, ENTRY_BASIS, CN_PRICE_METHOD,
  BENCHMARKS, STATES, REASON_CODES, FOUR_STATES, RETURN_KEYS, READ_STAGES, READ_DATASET, DATE, SHA64, isIso, isText, isObj, iso, localDate,
};
