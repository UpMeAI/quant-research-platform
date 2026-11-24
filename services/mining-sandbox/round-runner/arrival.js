'use strict';

/**
 * RF1116 holdout DATA ARRIVAL: the program and its hash chain (plan-coord 2026-11-23). Serves R2 (no data at seal time) and R1 (the sealed export ends at D1 = 2026-11-17; the days after it arrive here).
 *
 * A program copies each new SSE trading day from V6's canonical daily data (exported read-only by deploy/research-lane/r2-day-export) into the segment's holdout directory and is the ONLY
 * writer of it. Every arriving file is recorded in an append-only chain, ARRIVAL_CHAIN_V1.jsonl in the same directory (HOLDOUT_ARRIVAL_V1: seq, segment, kind CALENDAR | DAY, trade_date,
 * files [{name, sha256, rows}], readiness, source, arrived_at, prev_hash, record_hash). The scorer verifies the whole chain against the directory (verifyChain): any gap, edit, or
 * out-of-order day makes scoring refuse (MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID), and days that have not arrived yet are MINE_RUNNER_HOLDOUT_INCOMPLETE:arrival:<day>.
 *
 *   profiles   R2: sealed PENDING (SEAL_PENDING_V1.json only), the calendar arrives first (chain row 0), every base file is header only, start rule 2026-12-31.
 *              R1: sealed with data (SHA256SUMS.sealed lists the six daily tables and the calendar), the calendar is sealed (no calendar row), the sealed base files are never touched, only
 *              the industry table (absent from the sealed export) gets a header-only base file; days after 2026-11-17 only.
 *   layout     the spec's layout (RF1116_CN_A_LANE_EXPORT_SPEC_V1): one part per table and day, <table>_<YYYYMMDD>.csv, which the data adapter already reads (base first, then the dated
 *              parts); later R2 calendar rows as trading_calendar_<YYYYMMDD>.csv. Seven tables: the six daily ones and the industry membership (export spec rev 5 change 2), whose rows belong
 *              to a day by first_available_at: [previous part's upper bound, 09:00+08 of the next open day), the first part of a segment from its industryFrom; the window is recorded in the chain row
 *              (window_from, window_to) and consecutive rows are contiguous; a header-only part is normal.
 *              The chain file is not listed in SHA256SUMS (it grows); every other file after the sealed lines is listed and named by exactly one chain row.
 *   next day   always the next SSE open day of the calendar in the directory after the last arrived day. A gap, an earlier day or a closed day is refused; an arrived day is a no-op.
 *   a day      is written only if the source has all seven tables and the readiness record for it, each header equals the base header, every row is that day's (trade_date; business_date for the
 *              master; the first_available_at window for industry), and prices is not empty. Files are written whole (temp + rename), SHA256SUMS lines appended, the chain row last (the
 *              commit point). Every step is idempotent and compares bytes, so a crash between steps is healed by the next run; a different file on disk is MINE_RUNNER_ARRIVE_CONFLICT.
 *   readiness  the exporter's READINESS.json (probe R2_DAY_EXPORT_READINESS_V2: ready_via POST_CLOSE_D | NEXT_PREMARKET, name counts) is validated and recorded in the chain row.
 *   sources    CSV_DAY_DROP: the day directories r2-day-export drops (read-only here). The lane never connects to V6: there is no database driver (plan-coord: the lane must never touch the V6 production DB).
 *              The SQL of the export lives in deploy/research-lane/r2-day-export/sql/ and is run by the V6-side job only.
 * Errors MINE_RUNNER_ARRIVE_*; verification errors MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:<reason>.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const adapter = require('../data-adapter');
const trials = require('../../trial-ledger');

const CHAIN_FILE = 'ARRIVAL_CHAIN_V1.jsonl';
const SCHEMA = 'HOLDOUT_ARRIVAL_V1';
const PENDING = 'SEAL_PENDING_V1.json';
const CAL_STEM = 'trading_calendar';
const READINESS_FILE = 'READINESS.json';
const READY_VIA = Object.freeze(['POST_CLOSE_D', 'NEXT_PREMARKET']);
const READINESS_SCHEMA = 'R2_DAY_EXPORT_READINESS_RECORD_V1';
const START_AFTER = '2026-12-31'; // R2's start rule (holdout-segments.js): the first trading day after it
const SUFFIX = /^_(\d{8})\.csv$/;
/**
 * The two segments this program serves. R2: the directory is sealed PENDING (no data at seal time), the calendar arrives first, every base file is header only.
 * R1: the directory was sealed on 2026-11-18 with data through D1 = 2026-11-17 (EXPORT_MANIFEST.json of the sealed export); the sealed manifest lists the calendar, which already runs to
 * 2026-12-31, so no calendar row; only the days after D1 arrive, the sealed base files are never touched, and only the industry table (absent from the sealed export) gets a base file.
 * industryFrom: the lower bound of the first industry part (export spec rev 5 change 2: first_available_at from 2026-10-17 00:00+08 for R1; the day after the start rule for R2).
 */
const PROFILES = Object.freeze({
  R1: Object.freeze({ segment: 'R1', startAfter: '2026-11-17', industryFrom: '2026-10-17T00:00:00+08:00', calendarArrives: false }),
  R2: Object.freeze({ segment: 'R2', startAfter: START_AFTER, industryFrom: '2027-01-01T00:00:00+08:00', calendarArrives: true }),
});
const profileOf = (segment = 'R2') => PROFILES[segment] || fail('SEGMENT', String(segment));
const T = (stem, dateCol) => Object.freeze({ stem, dateCol });
// dateCol null: the industry membership has no trade date; its rows belong to a day by first_available_at (see windowOf)
const TABLES = Object.freeze([T('prices_daily_stock', 'trade_date'), T('market_daily_basic_observation_stock', 'trade_date'), T('adjustment_factor_observation_stock', 'trade_date'),
  T('security_master_stock', 'business_date'), T('security_suspension_observation', 'trade_date'), T('security_suspension_day_coverage', 'trade_date'), T('industry_membership_sw2021', null)]);

class ArrivalError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new ArrivalError(`MINE_RUNNER_ARRIVE_${code}`, detail); };
const invalid = (reason, detail) => { throw new ArrivalError('MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID', detail === undefined ? reason : `${reason}:${detail}`); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const compact = (d) => d.replace(/-/g, '');
const stamp = () => new Date(Date.now() + 8 * 3600e3).toISOString().replace(/\.\d{3}Z$/, '+08:00');
const rowHash = (row) => trials.recordHash(row);

let fault = null;
const withFault = (point, cb) => { const prior = fault; fault = point; try { return cb(); } finally { fault = prior; } };
const faultAt = (point) => { if (fault === point) fail('TEST_FAULT', point); };

// ── SHA256SUMS and the chain ─────────────────────────────────────────────────────────────────────

function readSums(dir) {
  const f = path.join(dir, 'SHA256SUMS');
  const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
  const entries = lines.map((l) => { const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l); if (!m) invalid('SUMS', `line ${l.slice(0, 40)}`); return { sha: m[1], name: m[2], line: l }; });
  return { entries, byName: new Map(entries.map((e) => [e.name, e.sha])) };
}
function sealedNamesOf(dir) {
  const f = path.join(dir, 'SHA256SUMS.sealed');
  if (!fs.existsSync(f)) return null;
  return new Set(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => /^([0-9a-f]{64}) [ *](.+)$/.exec(l)).filter(Boolean).map((m) => m[2]));
}
function chainRows(dir) {
  const f = path.join(dir, CHAIN_FILE);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return invalid('PARSE'); } });
}
// at rest nothing the arrival writes is group- or world-readable (review 2026-11-23): 0600 whatever the umask; the directory's own mode is the operator's (0700, like R1); the score hand-over chmods it at score time
const FILE_MODE = 0o600;
const atomicWrite = (file, bytes) => { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, bytes, { mode: FILE_MODE }); fs.chmodSync(tmp, FILE_MODE); fs.renameSync(tmp, file); };

/**
 * One arrival at a time per directory (review 2026-11-23: two arrivals corrupted the chain irreversibly). An exclusive lock file in the directory, taken with O_EXCL, held for the whole step.
 * Library code never removes an existing lock: a stale-lock takeover based on stat+unlink can delete a replacement lock won by another process. run.sh is the recovery authority: after proving no
 * rf1116-holdout-arrive container exists it removes a lock older than LOCK_STALE_MS. score/rescore look at the same file and refuse HOLDOUT_ARRIVAL_IN_PROGRESS while it is fresh.
 */
const LOCK_FILE = '.arrival.lock';
const LOCK_STALE_MS = 30 * 60 * 1000;
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function withArrivalLock(dir, fn) {
  const lock = path.join(dir, LOCK_FILE);
  const take = () => { const fd = fs.openSync(lock, 'wx', FILE_MODE); try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { fs.closeSync(fd); } };
  try { take(); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    fail('LOCKED', lock);
  }
  try {
    if (process.env.QRP_ARRIVE_TEST_HOLD_MS) sleepMs(Number(process.env.QRP_ARRIVE_TEST_HOLD_MS)); // tests only: hold the lock so a second arrival can be tried against it
    return fn();
  } finally { fs.rmSync(lock, { force: true }); }
}

/** A source directory view: the SSE open days the directory's own calendar lists (same reading as the panel builder). */
function openDaysOfDir(dir) {
  const src = adapter.csvDirSource(dir, { mode: 'LIVE', label: 'arrival', holdout: true });
  return adapter.openDaysOf([src]);
}
const expectedDaysOf = (openDays, startAfter) => openDays.filter((d) => d > startAfter);

/**
 * Verifies the chain against the directory. Throws MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:<SEQ | RECORD_HASH | SCHEMA | FILE_NAME | MISSING_TABLE | FILE_SHA | SUMS | DUPLICATE | UNCHAINED | GAP | ORDER | NO_CHAIN | EMPTY>.
 * With a window: the days of the window must all have arrived (the first DAY row is the window's first day, no gap), and days missing at the END are
 * MINE_RUNNER_HOLDOUT_INCOMPLETE:arrival:<day> (not there yet, not tampering). tolerateUnchained (for the arrival program itself): names listed in SHA256SUMS but in no chain row are
 * returned instead of refused, so a crash between the SUMS and the chain row can be healed.
 * @returns {{rows: number, days: string[], last_day: string|null, head_hash: string, unchained: string[]}}
 */
function verifyChain(dir, { segment = 'R2', window = null, startAfter = undefined, tolerateUnchained = false, anchors = null, requireAnchor = false } = {}) {
  const profile = profileOf(segment);
  const after = startAfter === undefined ? profile.startAfter : startAfter;
  const rows = chainRows(dir);
  if (rows === null) invalid('NO_CHAIN');
  if (!rows.length) invalid('EMPTY');
  const sums = readSums(dir);
  const sealedFileNames = sealedNamesOf(dir);
  if (!sealedFileNames && !profile.calendarArrives) invalid('SUMS', 'no SHA256SUMS.sealed');
  const sealed = sealedFileNames || new Set([PENDING]);
  const needsBase = (t) => !sealed.has(`${t.stem}.csv`); // a table the sealed manifest already lists keeps its sealed base file
  const named = new Set();
  rows.forEach((r, i) => {
    if (!r || r.schema !== SCHEMA || r.segment !== profile.segment) invalid('SCHEMA', i);
    if (r.seq !== i || r.prev_hash !== (i ? rows[i - 1].record_hash : null)) invalid('SEQ', i);
    const { record_hash: h, ...body } = r;
    if (h !== rowHash(body)) invalid('RECORD_HASH', i);
    if (i === 0 && profile.calendarArrives && r.kind !== 'CALENDAR') invalid('SCHEMA', 'first row is not the calendar');
    if (r.kind !== 'CALENDAR' && r.kind !== 'DAY') invalid('SCHEMA', `kind ${r.kind}`);
    if (r.kind === 'CALENDAR' && !profile.calendarArrives) invalid('SCHEMA', 'a calendar row in a segment whose calendar was sealed');
    if (!Array.isArray(r.files) || !r.files.length) invalid('SCHEMA', `files ${i}`);
    for (const f of r.files) {
      if (!f || typeof f.name !== 'string' || typeof f.sha256 !== 'string') invalid('SCHEMA', `file ${i}`);
      if (named.has(f.name)) invalid('DUPLICATE', f.name);
      named.add(f.name);
      const full = path.join(dir, f.name);
      if (!fs.existsSync(full) || sha256(fs.readFileSync(full)) !== f.sha256) invalid('FILE_SHA', f.name);
      if (sums.byName.get(f.name) !== f.sha256) invalid('SUMS', f.name);
    }
    const names = r.files.map((f) => f.name);
    if (r.kind === 'CALENDAR') {
      const ok = i === 0 ? names.length === 1 && names[0] === `${CAL_STEM}.csv` : names.length === 1 && SUFFIX.test(names[0].slice(CAL_STEM.length)) && names[0].startsWith(CAL_STEM);
      if (!ok) invalid('FILE_NAME', names.join(','));
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.trade_date || '')) invalid('SCHEMA', `trade_date ${i}`);
      // the readiness record is part of every DAY row (null only for a source that has none, the PG driver)
      if (r.readiness === undefined || (r.readiness !== null && (typeof r.readiness !== 'object' || !READY_VIA.includes(r.readiness.ready_via)))) invalid('SCHEMA', `readiness ${i}`);
      if (r.readiness === null && r.source && r.source.driver === 'CSV_DAY_DROP') invalid('SCHEMA', `readiness ${i}: a dropped day carries its readiness record`);
      // the industry window recorded in the row: contiguous with the previous DAY row (the first from the segment's industryFrom), upper bound 09:00+08 of a later date
      if (!ISO_ST.test(r.window_from || '') || !ISO_ST.test(r.window_to || '') || !r.window_to.endsWith('T09:00:00+08:00') || r.window_to.slice(0, 10) <= r.trade_date) invalid('SCHEMA', `window `);
      const prevDay = rows.slice(0, i).filter((x) => x.kind === 'DAY').pop();
      if (r.window_from !== (prevDay ? prevDay.window_to : profile.industryFrom)) invalid('WINDOW', `${r.trade_date}: ${r.window_from} does not continue the previous part`);
      const first = !rows.slice(0, i).some((x) => x.kind === 'DAY');
      let expectedNames = 0;
      for (const t of TABLES) {
        const part = `${t.stem}_${compact(r.trade_date)}.csv`;
        if (!names.includes(part)) invalid('MISSING_TABLE', `${r.trade_date}:${t.stem}`);
        const wantsBase = first && needsBase(t);
        if (wantsBase !== names.includes(`${t.stem}.csv`)) invalid('FILE_NAME', `${t.stem}.csv base file on ${first ? 'the first day where the sealed manifest has it' : 'a later day'}`);
        expectedNames += wantsBase ? 2 : 1;
      }
      if (names.length !== expectedNames) invalid('FILE_NAME', names.join(','));
    }
  });
  // the anchors (review 2026-11-23): the chain head was written to a lane ledger after every arrival. A head below the last anchor is a rollback; a row at an anchored seq with another hash is a rewrite
  // (a consistent rewrite of the last day, or of an earlier day with every later row re-chained, changes the hash the anchor holds). Strict mode also refuses rows beyond the last anchor.
  const anchored = (anchors || []).filter((a) => a && Number.isInteger(a.seq));
  const maxAnchor = anchored.length ? Math.max(...anchored.map((a) => a.seq)) : -1;
  if (rows.length - 1 < maxAnchor) invalid('ROLLBACK', `head seq ${rows.length - 1} is below the anchored seq ${maxAnchor}`);
  for (const a of anchored) if (rows[a.seq].record_hash !== a.record_hash) invalid('REWRITE', `row ${a.seq} is not the anchored one`);
  if (requireAnchor && rows.length - 1 > maxAnchor) invalid('UNANCHORED', `head seq ${rows.length - 1}, last anchored seq ${maxAnchor}`);
  const unchained = sums.entries.map((e) => e.name).filter((n) => !sealed.has(n) && !named.has(n));
  if (unchained.length && !tolerateUnchained) invalid('UNCHAINED', unchained.join(','));
  // days against the calendar of the directory
  const cal = openDaysOfDir(dir);
  const dayRows = rows.filter((r) => r.kind === 'DAY');
  const expected = expectedDaysOf(cal.days, after);
  dayRows.forEach((r, i) => {
    if (r.trade_date !== expected[i]) invalid(expected[i] !== undefined && r.trade_date < expected[i] ? 'ORDER' : 'GAP', `${r.trade_date} vs ${expected[i]}`);
  });
  // with a calendar that knows a later open day, the upper bound is that day's 09:00+08
  for (const r of dayRows) { const nx = cal.days.find((d) => d > r.trade_date); if (nx && r.window_to.slice(0, 10) !== nx) invalid('WINDOW', `${r.trade_date}: window_to ${r.window_to} is not 09:00+08 of the next open day ${nx}`); }
  const days = dayRows.map((r) => r.trade_date);
  if (window) {
    const need = cal.days.filter((d) => d >= window.from && d <= window.to && d > after); // days up to the sealed export's D1 (R1) are in the sealed files, not in the chain
    const missing = need.find((d) => !days.includes(d));
    if (missing !== undefined) throw new ArrivalError('MINE_RUNNER_HOLDOUT_INCOMPLETE', `arrival:${missing}`);
  }
  return { rows: rows.length, head_seq: rows.length - 1, days, last_day: days.length ? days[days.length - 1] : null, head_hash: rows[rows.length - 1].record_hash, unchained };
}

// ── the arrival program ─────────────────────────────────────────────────────────────────────────

const csvLines = (buf) => buf.toString('utf8').split('\n').filter((l) => l !== '');
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** First line of a file without reading the rest (the sealed R1 base files are 40 to 160 MB). */
function firstLineOf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(65536); const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8'); const i = text.indexOf('\n');
    if (i < 0 && n === buf.length) fail('HEADER', `${path.basename(file)}: no header line in the first 64 KB`);
    return i < 0 ? text : text.slice(0, i);
  } finally { fs.closeSync(fd); }
}
/**
 * The first_available_at window of the industry part of one day (plan-coord 2026-11-23): [previous part's upper bound, 09:00+08 of the next SSE open day after the day). The first part of a segment
 * starts at its industryFrom; parts follow each other without a gap or an overlap, and a part holds every row the scorer's panel may count for the day (it counts only rows in by 09:00 on the next open
 * day). The exporter fixes the window (window_from, window_to in READINESS.json); the arrival program checks the contiguity and, when its calendar knows the next open day, the upper bound.
 */
const ISO_ST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
function checkDay(day, files, base, { window }) {
  const out = {};
  for (const t of TABLES) {
    const buf = files[t.stem];
    if (!Buffer.isBuffer(buf)) return null;
    const lines = csvLines(buf);
    if (!lines.length) fail('HEADER', `${t.stem}: empty file`);
    if (base[t.stem] !== undefined && base[t.stem] !== lines[0]) fail('HEADER', `${t.stem}`);
    const tmp = path.join(os.tmpdir(), `qrp-arrive-${process.pid}-${t.stem}.csv`);
    fs.writeFileSync(tmp, buf);
    let rows = 0;
    try {
      if (t.dateCol) adapter.internals.forEachCsvRow(tmp, (r) => { rows += 1; if (r[t.dateCol] !== day) fail('ROW_DATE', `${t.stem}:${r[t.dateCol]}`); });
      else {
        const w = { lo: Date.parse(window.from), hi: Date.parse(window.to) };
        adapter.internals.forEachCsvRow(tmp, (r) => {
          rows += 1;
          let at = NaN; try { at = adapter.internals.parseTs(r.first_available_at); } catch { /* refused below */ }
          if (!(at >= w.lo && at < w.hi)) fail('ROW_WINDOW', `${t.stem}:${r.first_available_at}`);
        });
      }
    } finally { fs.rmSync(tmp, { force: true }); }
    if (t.stem === 'prices_daily_stock' && rows === 0) fail('EMPTY_DAY', day);
    out[t.stem] = { buf, header: lines[0], rows };
  }
  return out;
}
/** Writes a file whole; an existing file must be byte-identical (idempotent healing), anything else is a conflict. */
function putFile(dir, name, bytes) {
  const f = path.join(dir, name);
  if (fs.existsSync(f)) { if (!fs.readFileSync(f).equals(bytes)) fail('CONFLICT', name); return; }
  atomicWrite(f, bytes);
}
function putSums(dir, files) {
  const sums = readSums(dir);
  const add = [];
  for (const f of files) {
    const have = sums.byName.get(f.name);
    if (have === undefined) add.push(`${f.sha256}  ${f.name}`);
    else if (have !== f.sha256) fail('CONFLICT', `SHA256SUMS ${f.name}`);
  }
  if (!add.length) return;
  const f = path.join(dir, 'SHA256SUMS');
  const cur = fs.readFileSync(f, 'utf8');
  atomicWrite(f, `${cur}${cur.endsWith('\n') || cur === '' ? '' : '\n'}${add.join('\n')}\n`);
}
function appendChain(dir, segment, body) {
  const rows = chainRows(dir) || [];
  const row = { schema: SCHEMA, segment, seq: rows.length, ...body, prev_hash: rows.length ? rows[rows.length - 1].record_hash : null };
  const rec = { ...row, record_hash: rowHash(row) };
  fs.appendFileSync(path.join(dir, CHAIN_FILE), `${JSON.stringify(rec)}\n`, { mode: FILE_MODE });
  return rec;
}
const fileEntry = (name, buf, rows) => ({ name, sha256: sha256(buf), rows });

/** Existing calendar lines (base and dated parts) of the directory, without headers. */
function calendarLinesOf(dir) {
  const names = fs.readdirSync(dir).filter((n) => n === `${CAL_STEM}.csv` || (n.startsWith(CAL_STEM) && SUFFIX.test(n.slice(CAL_STEM.length)))).sort();
  const lines = new Set(); let header = null;
  for (const n of names) { const l = csvLines(fs.readFileSync(path.join(dir, n))); if (header === null) header = l[0]; for (const x of l.slice(1)) lines.add(x); }
  return { header, lines };
}

const isCount = (n) => Number.isInteger(n) && n >= 0;
/**
 * The exporter's readiness record of one day (r2-day-export READINESS.json, probe R2_DAY_EXPORT_READINESS_V2.sql): which rule made the day ready (POST_CLOSE_D, or NEXT_PREMARKET for a day
 * whose POST_CLOSE was BLOCKED and backfilled) and the name counts at probe time. It is not data: it is recorded in the chain row (plan-coord condition iii), nothing is written to the directory.
 */
function checkReadiness(day, bytes, { expectedFrom, nextOpen }) {
  let o; try { o = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return fail('READINESS', `${day}: not JSON`); }
  if (!o || o.schema !== READINESS_SCHEMA || o.trade_date !== day || !READY_VIA.includes(o.ready_via) || !['n_prices', 'n_basic', 'n_adj', 'n_cov'].every((k) => isCount(o[k]))
      || !/^[0-9a-f]{64}$/.test(o.probe_sha256 || '') || typeof o.probed_at !== 'string') return fail('READINESS', `${day}: not a readiness record of this day`);
  // the industry window: contiguous with the previous part, upper bound = 09:00+08 of the next SSE open day (the calendar's when it knows one, else a later date)
  if (!ISO_ST.test(o.window_from || '') || !ISO_ST.test(o.window_to || '') || o.window_from !== expectedFrom) return fail('READINESS', `${day}: window_from ${o.window_from} is not the previous part's upper bound ${expectedFrom}`);
  if (!(o.window_to.endsWith('T09:00:00+08:00') && o.window_to.slice(0, 10) > day) || (nextOpen && o.window_to.slice(0, 10) !== nextOpen)) return fail('READINESS', `${day}: window_to ${o.window_to} is not 09:00+08 of the next open day`);
  return { readiness: { ready_via: o.ready_via, n_prices: o.n_prices, n_basic: o.n_basic, n_adj: o.n_adj, n_cov: o.n_cov, probe_sha256: o.probe_sha256, probed_at: o.probed_at, file_sha256: sha256(Buffer.from(bytes)) }, window: { from: o.window_from, to: o.window_to } };
}

/**
 * One step of the arrival: R2: the calendar (first, and when it has rows the directory lacks); then the next open day. R1: the next open day after the sealed export's D1 (the calendar
 * is sealed and never delivered). Idempotent.
 * @param {{dir: string, segment?: 'R1'|'R2', source: {driver: string, calendar: () => Buffer|null, day: (d: string, ctx: {industryFrom: string}) => {files: Object<string, Buffer>}|null},
 *          arrivedAt?: string, day?: string, windowEnd?: string, startAfter?: string}} o
 * @returns {{status: 'ARRIVED', kind: 'CALENDAR'|'DAY', seq: number, day?: string} | {status: 'NOOP'|'NOT_AVAILABLE'|'NOT_YET'|'COMPLETE', what?: string}}
 */
function arrive(o = {}) { return withArrivalLock(o.dir, () => arriveLocked(o)); }
function arriveLocked({ dir, segment = 'R2', source, arrivedAt = null, day = null, windowEnd = null, startAfter = undefined, anchors = null } = {}) {
  const profile = profileOf(segment);
  const after = startAfter === undefined ? profile.startAfter : startAfter;
  const sealed = sealedNamesOf(dir);
  if (profile.calendarArrives) {
    if (!fs.existsSync(path.join(dir, PENDING)) || !sealed || !sealed.has(PENDING) || !readSums(dir).byName.has(PENDING)) fail('NOT_SEALED', dir);
  } else {
    // R1: sealed with data (the sealed manifest lists the calendar and the six daily tables); a pending-sealed directory is the other segment's
    const sums = fs.existsSync(path.join(dir, 'SHA256SUMS')) ? readSums(dir) : null;
    if (fs.existsSync(path.join(dir, PENDING)) || !sealed || !sums || !sealed.has(`${CAL_STEM}.csv`) || !sums.byName.has(`${CAL_STEM}.csv`) || ![...sealed].every((n) => sums.byName.has(n))) fail('NOT_SEALED', dir);
  }
  const at = arrivedAt || stamp();
  const srcRef = { driver: source.driver };
  const existing = chainRows(dir);
  if (existing) verifyChain(dir, { segment: profile.segment, startAfter: after, tolerateUnchained: true, anchors });
  const needsBase = (t) => !(sealed && sealed.has(`${t.stem}.csv`));
  // 1. the calendar (R2 only)
  const calBuf = profile.calendarArrives ? source.calendar() : null;
  if (profile.calendarArrives && !existing) {
    if (!calBuf) return { status: 'NOT_AVAILABLE', what: 'CALENDAR' };
    putFile(dir, `${CAL_STEM}.csv`, calBuf); faultAt('AFTER_FILES');
    const f = fileEntry(`${CAL_STEM}.csv`, calBuf, csvLines(calBuf).length - 1);
    putSums(dir, [f]); faultAt('AFTER_SUMS');
    const row = appendChain(dir, profile.segment, { kind: 'CALENDAR', trade_date: null, files: [f], source: srcRef, arrived_at: at });
    return { status: 'ARRIVED', kind: 'CALENDAR', seq: row.seq };
  }
  if (calBuf) {
    const have = calendarLinesOf(dir);
    const lines = csvLines(calBuf);
    if (have.header !== lines[0]) fail('HEADER', `${CAL_STEM}`);
    const delta = lines.slice(1).filter((l) => !have.lines.has(l));
    if (delta.length) {
      const name = `${CAL_STEM}_${compact(at.slice(0, 10))}.csv`;
      const bytes = Buffer.from(`${lines[0]}\n${delta.join('\n')}\n`);
      // the merged calendar must still fit what has arrived: build the directory as it would be and compare days
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-arrive-cal-'));
      try {
        const sums = readSums(dir);
        const keep = [...sums.entries.filter((e) => e.name === `${CAL_STEM}.csv` || (e.name.startsWith(CAL_STEM) && SUFFIX.test(e.name.slice(CAL_STEM.length))))];
        for (const e of keep) fs.copyFileSync(path.join(dir, e.name), path.join(tmp, e.name));
        fs.writeFileSync(path.join(tmp, name), bytes);
        fs.writeFileSync(path.join(tmp, 'SHA256SUMS'), `${[...keep.map((e) => e.line), `${sha256(bytes)}  ${name}`].join('\n')}\n`);
        const merged = expectedDaysOf(openDaysOfDir(tmp).days, after);
        const arrived = existing.filter((r) => r.kind === 'DAY').map((r) => r.trade_date);
        if (!arrived.every((d, i) => merged[i] === d)) fail('CALENDAR_CONFLICT', `arrived days no longer fit the calendar`);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      putFile(dir, name, bytes); faultAt('AFTER_FILES');
      const f = fileEntry(name, bytes, delta.length);
      putSums(dir, [f]); faultAt('AFTER_SUMS');
      const row = appendChain(dir, profile.segment, { kind: 'CALENDAR', trade_date: null, files: [f], source: srcRef, arrived_at: at });
      return { status: 'ARRIVED', kind: 'CALENDAR', seq: row.seq };
    }
  }
  // 2. the next open day
  const cal = openDaysOfDir(dir);
  const arrivedDays = (existing || []).filter((r) => r.kind === 'DAY').map((r) => r.trade_date);
  const last = arrivedDays.length ? arrivedDays[arrivedDays.length - 1] : null;
  if (day !== null && arrivedDays.includes(day)) return { status: 'NOOP', what: day };
  if (day !== null && !cal.days.includes(day)) fail('NOT_OPEN_DAY', day);
  if (windowEnd && last !== null && last >= windowEnd) return { status: 'COMPLETE', what: last };
  const next = expectedDaysOf(cal.days, after).find((d) => last === null || d > last);
  if (day !== null && day !== next) fail('ORDER', `${day} is not the next open day (${next})`);
  if (next === undefined) return { status: 'NOT_YET', what: last };
  // the industry window of this day starts where the previous part ended; it ends at 09:00+08 of the next open day (unknown to a calendar that ends here: R1's sealed one ends 2026-12-31)
  const dayRows = (existing || []).filter((r) => r.kind === 'DAY');
  const expectedFrom = dayRows.length ? dayRows[dayRows.length - 1].window_to : profile.industryFrom;
  const nextOpen = cal.days.find((d) => d > next);
  const ctx = { industryFrom: expectedFrom, industryTo: nextOpen ? `${nextOpen}T09:00:00+08:00` : null };
  const got = source.day(next, ctx);
  if (!got) return { status: 'NOT_AVAILABLE', what: next };
  // plan-coord condition (iii): the readiness rule that let the day through, and the window of its industry part, are part of the chain row
  const rd = got.readiness === undefined ? null : checkReadiness(next, got.readiness, { expectedFrom, nextOpen });
  const readiness = rd ? rd.readiness : null;
  const window = rd ? rd.window : (ctx.industryTo ? { from: ctx.industryFrom, to: ctx.industryTo } : null);
  if (!window) return { status: 'NOT_AVAILABLE', what: next };
  const baseHeaders = {};
  for (const t of TABLES) { const f = path.join(dir, `${t.stem}.csv`); if (fs.existsSync(f)) baseHeaders[t.stem] = firstLineOf(f); }
  const checked = checkDay(next, got.files, baseHeaders, { window });
  if (!checked) return { status: 'NOT_AVAILABLE', what: next };
  // healing: orphan files of this day that are not what the source delivers are refused (putFile); orphans of any other name are refused here
  const pendingNames = new Set(TABLES.flatMap((t) => [`${t.stem}.csv`, `${t.stem}_${compact(next)}.csv`]));
  const unchained = existing ? verifyChain(dir, { segment: profile.segment, startAfter: after, tolerateUnchained: true, anchors }).unchained : readSums(dir).entries.map((e) => e.name).filter((n) => !sealed.has(n));
  for (const n of unchained) if (!pendingNames.has(n)) fail('CONFLICT', `unchained ${n}`);
  const first = arrivedDays.length === 0;
  const files = [];
  if (first) for (const t of TABLES.filter(needsBase)) { const b = Buffer.from(`${checked[t.stem].header}\n`); putFile(dir, `${t.stem}.csv`, b); files.push(fileEntry(`${t.stem}.csv`, b, 0)); }
  for (const t of TABLES) { const name = `${t.stem}_${compact(next)}.csv`; putFile(dir, name, checked[t.stem].buf); files.push(fileEntry(name, checked[t.stem].buf, checked[t.stem].rows)); }
  faultAt('AFTER_FILES');
  putSums(dir, files); faultAt('AFTER_SUMS');
  const row = appendChain(dir, profile.segment, { kind: 'DAY', trade_date: next, files, readiness, window_from: window.from, window_to: window.to, source: srcRef, arrived_at: at });
  return { status: 'ARRIVED', kind: 'DAY', day: next, seq: row.seq };
}

/**
 * After the window end: which open days of the window (after the sealed export's D1) have not arrived. Read-only; the timer alerts on `complete: false` (CLI exit 4).
 * @returns {{complete: boolean, last_day: string|null, missing: string[]}}
 */
function checkComplete({ dir, segment = 'R2', windowEnd, startAfter = undefined } = {}) {
  const profile = profileOf(segment);
  const after = startAfter === undefined ? profile.startAfter : startAfter;
  const rows = chainRows(dir) || [];
  const days = rows.filter((r) => r.kind === 'DAY').map((r) => r.trade_date);
  const cal = fs.existsSync(path.join(dir, 'SHA256SUMS')) ? openDaysOfDir(dir) : { days: [] };
  const missing = expectedDaysOf(cal.days, after).filter((d) => d <= windowEnd && !days.includes(d));
  return { complete: missing.length === 0 && cal.days.some((d) => d >= windowEnd), last_day: days.length ? days[days.length - 1] : null, missing };
}

// ── sources ────────────────────────────────────────────────────────────────────────────────────

/** CSV_DAY_DROP: <root>/trading_calendar.csv and <root>/<YYYYMMDD>/<table>.csv, dropped by a read-only job on the V6 side. A day with any table missing is not there yet. */
function csvDayDropSource(root) {
  return {
    driver: 'CSV_DAY_DROP',
    calendar() { const f = path.join(root, `${CAL_STEM}.csv`); return fs.existsSync(f) ? fs.readFileSync(f) : null; },
    day(d) {
      const dir = path.join(root, compact(d));
      if (!fs.existsSync(dir)) return null;
      const files = {};
      for (const t of TABLES) { const f = path.join(dir, `${t.stem}.csv`); if (!fs.existsSync(f)) return null; files[t.stem] = fs.readFileSync(f); }
      const rf = path.join(dir, READINESS_FILE); if (!fs.existsSync(rf)) return null; // the exporter writes it with the day: a day without its readiness record is not there yet
      return { files, readiness: fs.readFileSync(rf) };
    },
  };
}


module.exports = { CHAIN_FILE, LOCK_FILE, LOCK_STALE_MS, SCHEMA, READINESS_FILE, READINESS_SCHEMA, TABLES, START_AFTER, PROFILES, ArrivalError, verifyChain, arrive, checkComplete, csvDayDropSource, internals: { withFault } };
