'use strict';

/**
 * RF1116 R2: the DATA ARRIVAL program and its hash chain (plan-coord 2026-11-23).
 *
 * R2's data does not exist when the segment is sealed (services/mining-rounds/holdout-segments.js; deploy/.../seal-init-r2.sh). A program copies each new SSE trading day from
 * V6's canonical daily data (read-only) into the R2 directory and is the ONLY writer of it. Every arriving file is recorded in an append-only chain,
 * ARRIVAL_CHAIN_V1.jsonl in the same directory (HOLDOUT_ARRIVAL_V1: seq, kind CALENDAR | DAY, trade_date, files [{name, sha256, rows}], source, arrived_at, prev_hash,
 * record_hash). The scorer verifies the whole chain against the directory (verifyChain): any gap, edit, or out-of-order day makes scoring refuse (MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID),
 * and days that have not arrived yet are MINE_RUNNER_HOLDOUT_INCOMPLETE:arrival:<day>.
 *
 *   layout     the spec's layout (RF1116_CN_A_LANE_EXPORT_SPEC_V1): a base file per table that is HEADER ONLY and one part per table and day, <table>_<YYYYMMDD>.csv, which the data
 *              adapter already reads (base first, then the dated parts); trading_calendar.csv first (chain row 0), later calendar rows as trading_calendar_<YYYYMMDD>.csv.
 *              The chain file is not listed in SHA256SUMS (it grows); every other file after the sealed line is listed and named by exactly one chain row.
 *   next day   always the next SSE open day of the calendar in the directory after the last arrived day (the first is the first open day after 2026-12-31). A gap, an earlier day or a
 *              closed day is refused; an arrived day is a no-op. The calendar comes first: nothing else arrives until it is there.
 *   a day      is written only if the source has all six tables for it, each header equals the base header, every row is that day's (trade_date; business_date for the master), and
 *              prices is not empty. Files are written whole (temp + rename), SHA256SUMS lines appended, the chain row last (the commit point). Every step is idempotent and compares
 *              bytes, so a crash between steps is healed by the next run; a different file on disk is MINE_RUNNER_ARRIVE_CONFLICT.
 *   sources    CSV_DAY_DROP (a V6-side read-only job drops <root>/trading_calendar.csv and <root>/<YYYYMMDD>/<table>.csv) and PG_PSQL (the spec's queries per day through psql with a
 *              read-only role; the queries and the psql arguments are tested, no database is).
 * Errors MINE_RUNNER_ARRIVE_*; verification errors MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:<reason>.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const adapter = require('../data-adapter');
const trials = require('../../trial-ledger');

const CHAIN_FILE = 'ARRIVAL_CHAIN_V1.jsonl';
const SCHEMA = 'HOLDOUT_ARRIVAL_V1';
const SEGMENT = 'R2';
const PENDING = 'SEAL_PENDING_V1.json';
const CAL_STEM = 'trading_calendar';
const START_AFTER = '2026-12-31'; // R2's start rule (holdout-segments.js): the first trading day after it
const SUFFIX = /^_(\d{8})\.csv$/;
const T = (stem, dateCol) => Object.freeze({ stem, dateCol });
const TABLES = Object.freeze([T('prices_daily_stock', 'trade_date'), T('market_daily_basic_observation_stock', 'trade_date'), T('adjustment_factor_observation_stock', 'trade_date'),
  T('security_master_stock', 'business_date'), T('security_suspension_observation', 'trade_date'), T('security_suspension_day_coverage', 'trade_date')]);

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
const atomicWrite = (file, bytes) => { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, file); };

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
function verifyChain(dir, { window = null, startAfter = START_AFTER, tolerateUnchained = false } = {}) {
  const rows = chainRows(dir);
  if (rows === null) invalid('NO_CHAIN');
  if (!rows.length) invalid('EMPTY');
  const sums = readSums(dir);
  const sealed = sealedNamesOf(dir) || new Set([PENDING]);
  const named = new Set();
  rows.forEach((r, i) => {
    if (!r || r.schema !== SCHEMA || r.segment !== SEGMENT) invalid('SCHEMA', i);
    if (r.seq !== i || r.prev_hash !== (i ? rows[i - 1].record_hash : null)) invalid('SEQ', i);
    const { record_hash: h, ...body } = r;
    if (h !== rowHash(body)) invalid('RECORD_HASH', i);
    if (i === 0 && r.kind !== 'CALENDAR') invalid('SCHEMA', 'first row is not the calendar');
    if (r.kind !== 'CALENDAR' && r.kind !== 'DAY') invalid('SCHEMA', `kind ${r.kind}`);
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
      const first = !rows.slice(0, i).some((x) => x.kind === 'DAY');
      for (const t of TABLES) {
        const part = `${t.stem}_${compact(r.trade_date)}.csv`;
        if (!names.includes(part)) invalid('MISSING_TABLE', `${r.trade_date}:${t.stem}`);
        if (first !== names.includes(`${t.stem}.csv`)) invalid('FILE_NAME', `${t.stem}.csv base file on ${first ? 'a later' : 'the first'} day`);
      }
      if (names.length !== TABLES.length * (first ? 2 : 1)) invalid('FILE_NAME', names.join(','));
    }
  });
  const unchained = sums.entries.map((e) => e.name).filter((n) => !sealed.has(n) && !named.has(n));
  if (unchained.length && !tolerateUnchained) invalid('UNCHAINED', unchained.join(','));
  // days against the calendar of the directory
  const cal = openDaysOfDir(dir);
  const dayRows = rows.filter((r) => r.kind === 'DAY');
  const expected = expectedDaysOf(cal.days, startAfter);
  dayRows.forEach((r, i) => {
    if (r.trade_date !== expected[i]) invalid(expected[i] !== undefined && r.trade_date < expected[i] ? 'ORDER' : 'GAP', `${r.trade_date} vs ${expected[i]}`);
  });
  const days = dayRows.map((r) => r.trade_date);
  if (window) {
    const need = cal.days.filter((d) => d >= window.from && d <= window.to);
    const missing = need.find((d) => !days.includes(d));
    if (missing !== undefined) throw new ArrivalError('MINE_RUNNER_HOLDOUT_INCOMPLETE', `arrival:${missing}`);
  }
  return { rows: rows.length, days, last_day: days.length ? days[days.length - 1] : null, head_hash: rows[rows.length - 1].record_hash, unchained };
}

// ── the arrival program ─────────────────────────────────────────────────────────────────────────

const csvLines = (buf) => buf.toString('utf8').split('\n').filter((l) => l !== '');
function checkDay(day, files, base) {
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
      adapter.internals.forEachCsvRow(tmp, (r) => { rows += 1; if (r[t.dateCol] !== day) fail('ROW_DATE', `${t.stem}:${r[t.dateCol]}`); });
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
function appendChain(dir, body) {
  const rows = chainRows(dir) || [];
  const row = { schema: SCHEMA, segment: SEGMENT, seq: rows.length, ...body, prev_hash: rows.length ? rows[rows.length - 1].record_hash : null };
  const rec = { ...row, record_hash: rowHash(row) };
  fs.appendFileSync(path.join(dir, CHAIN_FILE), `${JSON.stringify(rec)}\n`);
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

/**
 * One step of the arrival: the calendar (first, and when it has rows the directory lacks), else the next open day. Idempotent.
 * @param {{dir: string, source: {driver: string, calendar: () => Buffer|null, day: (d: string) => {files: Object<string, Buffer>}|null}, arrivedAt?: string,
 *          day?: string, windowEnd?: string, startAfter?: string}} o
 * @returns {{status: 'ARRIVED', kind: 'CALENDAR'|'DAY', seq: number, day?: string} | {status: 'NOOP'|'NOT_AVAILABLE'|'NOT_YET'|'COMPLETE', what?: string}}
 */
function arrive({ dir, source, arrivedAt = null, day = null, windowEnd = null, startAfter = START_AFTER } = {}) {
  const sealed = sealedNamesOf(dir);
  if (!fs.existsSync(path.join(dir, PENDING)) || !sealed || !sealed.has(PENDING) || !readSums(dir).byName.has(PENDING)) fail('NOT_SEALED', dir);
  const at = arrivedAt || stamp();
  const srcRef = { driver: source.driver };
  const existing = chainRows(dir);
  if (existing) verifyChain(dir, { startAfter, tolerateUnchained: true });
  // 1. the calendar
  const calBuf = source.calendar();
  if (!existing) {
    if (!calBuf) return { status: 'NOT_AVAILABLE', what: 'CALENDAR' };
    putFile(dir, `${CAL_STEM}.csv`, calBuf); faultAt('AFTER_FILES');
    const f = fileEntry(`${CAL_STEM}.csv`, calBuf, csvLines(calBuf).length - 1);
    putSums(dir, [f]); faultAt('AFTER_SUMS');
    const row = appendChain(dir, { kind: 'CALENDAR', trade_date: null, files: [f], source: srcRef, arrived_at: at });
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
        const merged = expectedDaysOf(openDaysOfDir(tmp).days, startAfter);
        const arrived = existing.filter((r) => r.kind === 'DAY').map((r) => r.trade_date);
        if (!arrived.every((d, i) => merged[i] === d)) fail('CALENDAR_CONFLICT', `arrived days no longer fit the calendar`);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      putFile(dir, name, bytes); faultAt('AFTER_FILES');
      const f = fileEntry(name, bytes, delta.length);
      putSums(dir, [f]); faultAt('AFTER_SUMS');
      const row = appendChain(dir, { kind: 'CALENDAR', trade_date: null, files: [f], source: srcRef, arrived_at: at });
      return { status: 'ARRIVED', kind: 'CALENDAR', seq: row.seq };
    }
  }
  // 2. the next open day
  const cal = openDaysOfDir(dir);
  const arrivedDays = existing.filter((r) => r.kind === 'DAY').map((r) => r.trade_date);
  const last = arrivedDays.length ? arrivedDays[arrivedDays.length - 1] : null;
  if (day !== null && arrivedDays.includes(day)) return { status: 'NOOP', what: day };
  if (day !== null && !cal.days.includes(day)) fail('NOT_OPEN_DAY', day);
  if (windowEnd && last !== null && last >= windowEnd) return { status: 'COMPLETE', what: last };
  const next = expectedDaysOf(cal.days, startAfter).find((d) => last === null || d > last);
  if (day !== null && day !== next) fail('ORDER', `${day} is not the next open day (${next})`);
  if (next === undefined) return { status: 'NOT_YET', what: last };
  const got = source.day(next);
  if (!got) return { status: 'NOT_AVAILABLE', what: next };
  const baseHeaders = {};
  for (const t of TABLES) { const f = path.join(dir, `${t.stem}.csv`); if (fs.existsSync(f)) baseHeaders[t.stem] = csvLines(fs.readFileSync(f))[0]; }
  const checked = checkDay(next, got.files, baseHeaders);
  if (!checked) return { status: 'NOT_AVAILABLE', what: next };
  // healing: orphan files of this day that are not what the source delivers are refused (putFile); orphans of any other name are refused here
  const pendingNames = new Set(TABLES.flatMap((t) => [`${t.stem}.csv`, `${t.stem}_${compact(next)}.csv`]));
  for (const n of verifyChain(dir, { startAfter, tolerateUnchained: true }).unchained) if (!pendingNames.has(n)) fail('CONFLICT', `unchained ${n}`);
  const first = arrivedDays.length === 0;
  const files = [];
  if (first) for (const t of TABLES) { const b = Buffer.from(`${checked[t.stem].header}\n`); putFile(dir, `${t.stem}.csv`, b); files.push(fileEntry(`${t.stem}.csv`, b, 0)); }
  for (const t of TABLES) { const name = `${t.stem}_${compact(next)}.csv`; putFile(dir, name, checked[t.stem].buf); files.push(fileEntry(name, checked[t.stem].buf, checked[t.stem].rows)); }
  faultAt('AFTER_FILES');
  putSums(dir, files); faultAt('AFTER_SUMS');
  const row = appendChain(dir, { kind: 'DAY', trade_date: next, files, source: srcRef, arrived_at: at });
  return { status: 'ARRIVED', kind: 'DAY', day: next, seq: row.seq };
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
      return { files };
    },
  };
}

const STOCKS = "SELECT DISTINCT security_id FROM canonical_security_observation WHERE asset_class = 'STOCK' AND security_id IS NOT NULL";
/** The spec's per-table queries (RF1116_CN_A_LANE_EXPORT_SPEC_V1 section 2) for ONE trading day: read-only SELECTs. */
function pgQueries(day) {
  const d = `'${day}'`;
  return [
    { stem: 'prices_daily_stock', sql: `SELECT record_id, security_id, trade_date, open, high, low, close, previous_close, volume_shares, turnover_amount_cny, adjustment_factor, adjustment_mode, value_states, first_available_at, known_at, ingested_at, source_record_id, revision, schema_version, quality_state FROM prices_daily WHERE trade_date = ${d} AND security_id IN (${STOCKS}) ORDER BY security_id, trade_date, source_record_id, revision` },
    { stem: 'market_daily_basic_observation_stock', sql: `SELECT record_id, raw_record_id, security_id, trade_date, "values", first_available_at, ingested_at, source_record_id, revision, schema_version, quality_state, source_reconciliation_state FROM market_daily_basic_observation WHERE trade_date = ${d} AND security_id IN (${STOCKS}) ORDER BY security_id, trade_date, source_record_id, revision` },
    { stem: 'adjustment_factor_observation_stock', sql: `SELECT record_id, raw_record_id, security_id, trade_date, adjustment_factor, value_state, first_available_at, ingested_at, source_record_id, revision, schema_version, quality_state FROM adjustment_factor_observation WHERE trade_date = ${d} AND security_id IN (${STOCKS}) ORDER BY security_id, trade_date, source_record_id, revision` },
    { stem: 'security_master_stock', sql: `SELECT record_id, security_id, business_date, ticker, security_code, exchange, board, asset_class, display_name, name_integrity, listing_date, delisting_date, listing_status, risk_warning_status, first_available_at, ingested_at, source_record_id, revision, schema_version, quality_state, allow_new_risk FROM canonical_security_observation WHERE asset_class = 'STOCK' AND security_id IS NOT NULL AND business_date = ${d} ORDER BY security_id, business_date, revision` },
    { stem: 'security_suspension_observation', sql: `SELECT record_id, security_id, trade_date, suspension_type, suspension_timing, full_session, first_available_at, ingested_at, source_record_id, revision, schema_version, quality_state FROM security_suspension_observation WHERE trade_date = ${d} ORDER BY security_id, trade_date, source_record_id, revision` },
    { stem: 'security_suspension_day_coverage', sql: `SELECT coverage_id, trade_date, provider_row_count, accepted_row_count, full_session_count, first_available_at, ingested_at, job_run_id, source_registry_version, quality_state FROM security_suspension_day_coverage WHERE trade_date = ${d} ORDER BY trade_date, coverage_id` },
  ];
}
/** The calendar query of the spec (section 2.2), the range extended to the end of 2027. */
const pgCalendarQuery = () => "SELECT DISTINCT ON (calendar_date, exchange) calendar_date, market, exchange, is_open, previous_open_date, first_available_at, ingested_at, source_record_id, revision, schema_version, quality_state FROM canonical_calendar_observation WHERE calendar_date >= '2019-06-01' AND calendar_date <= '2027-12-31' ORDER BY calendar_date, exchange, revision DESC, first_available_at DESC";
const psqlArgs = (sql) => ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', `\\copy (${sql}) TO STDOUT WITH (FORMAT csv, HEADER true)`];
/** Runs one query through psql (connection from the standard PG* environment, a read-only role). Not exercised by the tests. */
function psqlRunner({ psql = 'psql', env = process.env } = {}) {
  return (sql) => {
    const r = spawnSync(psql, psqlArgs(sql), { env, maxBuffer: 1024 * 1024 * 1024 });
    if (r.status !== 0) fail('PSQL', `${r.status}:${String(r.stderr || '').slice(0, 200)}`);
    return r.stdout;
  };
}
/** PG_PSQL: the spec's queries per day through `run(sql) -> CSV Buffer`. No prices rows for the day = the day is not available yet. */
function pgDaySource({ run }) {
  return {
    driver: 'PG_PSQL',
    calendar() { return run(pgCalendarQuery()); },
    day(d) {
      const files = {};
      for (const q of pgQueries(d)) files[q.stem] = run(q.sql);
      return csvLines(files.prices_daily_stock).length > 1 ? { files } : null;
    },
  };
}

module.exports = { CHAIN_FILE, SCHEMA, TABLES, START_AFTER, ArrivalError, verifyChain, arrive, csvDayDropSource, pgQueries, pgCalendarQuery, psqlArgs, psqlRunner, pgDaySource, internals: { withFault } };
