'use strict';
/**
 * RF1116 R2: the DATA ARRIVAL program and its hash chain (plan-coord 2026-11-23). R2's data does not exist at seal time; a program copies each new SSE trading day from V6's
 * canonical daily data (read-only) into the R2 directory and is the ONLY writer of it. Every arriving file is recorded in an append-only chain (ARRIVAL_CHAIN_V1.jsonl: seq,
 * kind, trade_date, files {name, sha256, rows}, prev_hash, record_hash); the scorer verifies the chain and any gap, edit or out-of-order day makes scoring refuse. Red first,
 * synthetic data.
 *   - the day files are the spec's per-day parts `<table>_<YYYYMMDD>.csv` (the base `<table>.csv` is header only), lines appended to SHA256SUMS after the sealed line;
 *   - the next day is always the next SSE open day of the calendar file; a day is written only if its rows are that day's, the header matches, and prices is not empty;
 *   - a crash between the files and the chain row is healed by the next run (every step is idempotent and compares bytes);
 *   - the source is a driver: CSV_DAY_DROP (day files dropped by a V6-side read-only job) and PG_PSQL (the spec's queries per day; tested for text and args, not against a database).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
// lazy: on the base commit the module does not exist, so each test fails on its own assertion
const A = () => require('../services/mining-sandbox/round-runner/arrival');
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const range = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const OPEN = range('2026-12-21', '2027-02-26').filter((d) => weekday(d) !== 0 && weekday(d) !== 6 && d !== '2027-01-01');
const DAYS = OPEN.filter((d) => d > '2026-12-31'); // 2027-01-04, 01-05, ...
const compact = (d) => d.replace(/-/g, '');
const CAL_COLS = 'calendar_date,market,exchange,is_open,previous_open_date,first_available_at,ingested_at,source_record_id,revision,schema_version,quality_state';
const calendarCsv = (to = '2027-02-26') => `${CAL_COLS}\n${range('2026-12-21', to).map((d) => [d, 'A_SHARE', 'SSE', OPEN.includes(d) ? 't' : 'f', '', '2026-12-15 08:00:00+08', '2026-12-15 08:00:00+08', `cal:${d}`, 1, 'synthetic-v1', 'READY'].join(',')).join('\n')}\n`;
const HEADERS = {
  prices_daily_stock: 'record_id,security_id,trade_date,open,close',
  market_daily_basic_observation_stock: 'record_id,raw_record_id,security_id,trade_date,values',
  adjustment_factor_observation_stock: 'record_id,raw_record_id,security_id,trade_date,adjustment_factor',
  security_master_stock: 'record_id,security_id,business_date,ticker',
  security_suspension_observation: 'record_id,security_id,trade_date,suspension_type',
  security_suspension_day_coverage: 'coverage_id,trade_date,provider_row_count',
};
/** One day's files as the V6-side job would drop them (verbatim CSV text per table). */
function dayTexts(day, { rows = 3, wrongDate = null, emptyPrices = false, header = {} } = {}) {
  const ids = Array.from({ length: rows }, (_, i) => `S0${i + 1}.SH`);
  const d = (t) => (wrongDate && t === wrongDate.table ? wrongDate.date : day);
  const csv = (stem, lines) => `${header[stem] || HEADERS[stem]}\n${lines.length ? `${lines.join('\n')}\n` : ''}`;
  return {
    prices_daily_stock: csv('prices_daily_stock', emptyPrices ? [] : ids.map((s) => `pd:${s}:${day},${s},${d('prices_daily_stock')},1.5,2.5`)),
    market_daily_basic_observation_stock: csv('market_daily_basic_observation_stock', ids.map((s) => `db:${s}:${day},dbr:${s},${s},${d('market_daily_basic_observation_stock')},"{""pe"": 1, ""pb"": 2}"`)),
    adjustment_factor_observation_stock: csv('adjustment_factor_observation_stock', ids.map((s) => `af:${s}:${day},afr:${s},${s},${d('adjustment_factor_observation_stock')},1`)),
    security_master_stock: csv('security_master_stock', ids.map((s) => `sm:${s}:${day},${s},${d('security_master_stock')},${s}`)),
    security_suspension_observation: csv('security_suspension_observation', []),
    security_suspension_day_coverage: csv('security_suspension_day_coverage', [`cv:${day},${d('security_suspension_day_coverage')},${rows}`]),
  };
}
/** A CSV_DAY_DROP root: calendar plus one directory per day (YYYYMMDD) with the six files. opts per day: { [day]: dayTexts options | null (not dropped yet) } */
function dropRoot(days, opts = {}, { calendar = calendarCsv() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2drop-'));
  if (calendar !== null) fs.writeFileSync(path.join(root, 'trading_calendar.csv'), calendar);
  for (const day of days) {
    if (opts[day] === null) continue;
    const dir = path.join(root, compact(day)); fs.mkdirSync(dir);
    for (const [stem, text] of Object.entries(dayTexts(day, opts[day] || {}))) fs.writeFileSync(path.join(dir, `${stem}.csv`), text);
  }
  return root;
}
/** The pending-sealed R2 directory seal-init-r2.sh leaves (made here so the test needs no shell). */
function sealedDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2arr-'));
  const pending = `${JSON.stringify({ schema: 'HOLDOUT_SEAL_PENDING_V1', segment: 'R2', data: 'NONE_AT_SEAL_TIME', sealed_at: '2026-12-01T20:50:00+08:00' })}\n`;
  fs.writeFileSync(path.join(dir, 'SEAL_PENDING_V1.json'), pending);
  const line = `${sha(pending)}  SEAL_PENDING_V1.json\n`;
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), line); fs.writeFileSync(path.join(dir, 'SHA256SUMS.sealed'), line);
  return dir;
}
const chainOf = (dir) => fs.readFileSync(path.join(dir, 'ARRIVAL_CHAIN_V1.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, sha(fs.readFileSync(path.join(dir, n)))]));
/** Runs arrive until it stops; returns the statuses. */
function drain(dir, source, o = {}) { const out = []; for (let i = 0; i < 200; i += 1) { const r = A().arrive({ dir, source, arrivedAt: '2027-03-01T20:30:00+08:00', ...o }); out.push(r.status); if (r.status !== 'ARRIVED') return { out, last: r }; } throw new Error('arrive did not stop'); }

test('AR0 format: the tables, the chain file name, the row schema', () => {
  const a = A();
  assert.equal(a.CHAIN_FILE, 'ARRIVAL_CHAIN_V1.jsonl');
  assert.deepEqual(a.TABLES.map((t) => t.stem), Object.keys(HEADERS));
  assert.deepEqual(a.TABLES.map((t) => t.dateCol), ['trade_date', 'trade_date', 'trade_date', 'business_date', 'trade_date', 'trade_date']);
  assert.ok(Object.isFrozen(a.TABLES));
  const hold = require('../services/mining-sandbox/round-runner').HOLDOUT_TABLES;
  for (const t of a.TABLES) assert.ok(hold.includes(`${t.stem}.csv`), `${t.stem} is a table the directory check requires`);
});

test('AR1 calendar first: the first run delivers trading_calendar.csv (chain row 0, listed after the sealed line); nothing else until it is there', () => {
  const dir = sealedDir();
  const none = A().arrive({ dir, source: A().csvDayDropSource(dropRoot(DAYS, {}, { calendar: null })), arrivedAt: '2027-01-04T20:30:00+08:00' });
  assert.equal(none.status, 'NOT_AVAILABLE');
  assert.equal(none.what, 'CALENDAR');
  assert.equal(fs.existsSync(path.join(dir, 'ARRIVAL_CHAIN_V1.jsonl')), false);
  const root = dropRoot(DAYS);
  const r = A().arrive({ dir, source: A().csvDayDropSource(root), arrivedAt: '2027-01-04T20:30:00+08:00' });
  assert.deepEqual([r.status, r.kind, r.seq], ['ARRIVED', 'CALENDAR', 0]);
  const [row] = chainOf(dir);
  assert.deepEqual([row.schema, row.segment, row.seq, row.kind, row.trade_date, row.prev_hash], ['HOLDOUT_ARRIVAL_V1', 'R2', 0, 'CALENDAR', null, null]);
  assert.deepEqual(row.files.map((f) => [f.name, f.sha256]), [['trading_calendar.csv', sha(fs.readFileSync(path.join(root, 'trading_calendar.csv')))]]);
  assert.equal(row.arrived_at, '2027-01-04T20:30:00+08:00');
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  assert.equal(sums.length, 2);
  assert.match(sums[0], /SEAL_PENDING_V1\.json$/);
  assert.equal(sums[1], `${row.files[0].sha256}  trading_calendar.csv`);
  assert.equal(fs.readFileSync(path.join(dir, 'SHA256SUMS.sealed'), 'utf8'), `${sums[0]}\n`, 'the sealed file is never touched');
});

test('AR2 first day: header-only base files plus the day parts, SUMS lines after the sealed one, chain row 1 linked to row 0', () => {
  const dir = sealedDir(); const src = A().csvDayDropSource(dropRoot(DAYS.slice(0, 3)));
  A().arrive({ dir, source: src });
  const r = A().arrive({ dir, source: src });
  assert.deepEqual([r.status, r.kind, r.day, r.seq], ['ARRIVED', 'DAY', DAYS[0], 1]);
  for (const stem of Object.keys(HEADERS)) {
    assert.equal(fs.readFileSync(path.join(dir, `${stem}.csv`), 'utf8'), `${HEADERS[stem]}\n`, `${stem}: base is header only`);
    assert.equal(fs.readFileSync(path.join(dir, `${stem}_${compact(DAYS[0])}.csv`), 'utf8'), dayTexts(DAYS[0])[stem], `${stem}: the day part is the source's bytes`);
  }
  const rows = chainOf(dir);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1].seq, rows[1].kind, rows[1].trade_date, rows[1].prev_hash], [1, 'DAY', DAYS[0], rows[0].record_hash]);
  assert.equal(rows[1].files.length, 12, 'six base files and six parts on the first day');
  assert.deepEqual(rows[1].files.find((f) => f.name === `prices_daily_stock_${compact(DAYS[0])}.csv`).rows, 3);
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  assert.equal(sums.length, 1 + 1 + 12, 'sealed line, calendar, twelve day-1 files');
  for (const f of rows[1].files) assert.ok(sums.includes(`${f.sha256}  ${f.name}`), f.name);
  assert.deepEqual(A().verifyChain(dir).days, [DAYS[0]]);
  // the second day adds only the six parts
  A().arrive({ dir, source: src });
  assert.equal(chainOf(dir)[2].files.length, 6);
  assert.deepEqual(A().verifyChain(dir).days, [DAYS[0], DAYS[1]]);
});

test('AR3 the next day is the next open day of the calendar: a gap, an earlier day or a closed day is refused; an arrived day is a no-op; nothing is written on a refusal', () => {
  const dir = sealedDir(); const src = A().csvDayDropSource(dropRoot(DAYS.slice(0, 6)));
  A().arrive({ dir, source: src }); A().arrive({ dir, source: src }); // calendar, day 1
  const snap = snapshot(dir);
  assert.throws(() => A().arrive({ dir, source: src, day: DAYS[2] }), code(/MINE_RUNNER_ARRIVE_ORDER/), 'skipping day 2');
  assert.throws(() => A().arrive({ dir, source: src, day: '2027-01-02' }), code(/MINE_RUNNER_ARRIVE_NOT_OPEN_DAY/), 'a Saturday');
  assert.throws(() => A().arrive({ dir, source: src, day: '2027-01-01' }), code(/MINE_RUNNER_ARRIVE_NOT_OPEN_DAY/), 'the holiday');
  assert.deepEqual(snapshot(dir), snap, 'refusals write nothing');
  assert.equal(A().arrive({ dir, source: src, day: DAYS[0] }).status, 'NOOP', 'an arrived day again');
  assert.deepEqual(snapshot(dir), snap);
  assert.equal(A().arrive({ dir, source: src, day: DAYS[1] }).seq, 2, 'the right next day is accepted');
});

test('AR4 availability: a day the source does not have yet is NOT_AVAILABLE (the daily timer retries), no calendar day beyond the last is NOT_YET, the end of the window is COMPLETE', () => {
  const dir = sealedDir();
  const src = A().csvDayDropSource(dropRoot(DAYS.slice(0, 2), { [DAYS[2]]: null }, { calendar: calendarCsv(DAYS[2]) }));
  assert.deepEqual(drain(dir, src).out, ['ARRIVED', 'ARRIVED', 'ARRIVED', 'NOT_AVAILABLE']);
  assert.equal(A().arrive({ dir, source: src }).what, DAYS[2]);
  assert.equal(chainOf(dir).length, 3);
  const dir2 = sealedDir();
  const only = A().csvDayDropSource(dropRoot(DAYS, {}, { calendar: calendarCsv(DAYS[1]) }));
  assert.deepEqual(drain(dir2, only).out, ['ARRIVED', 'ARRIVED', 'ARRIVED', 'NOT_YET']);
  const dir3 = sealedDir(); const full = A().csvDayDropSource(dropRoot(DAYS));
  const end = DAYS[3];
  const res = drain(dir3, full, { windowEnd: end });
  assert.deepEqual(res.out, ['ARRIVED', 'ARRIVED', 'ARRIVED', 'ARRIVED', 'ARRIVED', 'COMPLETE']);
  assert.equal(chainOf(dir3).filter((r) => r.kind === 'DAY').pop().trade_date, end);
});

test('AR5 a day is validated before anything is written: wrong header, a row of another day, empty prices, a missing table, an unsealed directory', () => {
  const bad = (opts, re) => {
    const dir = sealedDir(); const root = dropRoot(DAYS.slice(0, 2), { [DAYS[1]]: opts });
    const src = A().csvDayDropSource(root);
    A().arrive({ dir, source: src }); A().arrive({ dir, source: src }); // calendar and day 1 are fine
    const snap = snapshot(dir);
    assert.throws(() => A().arrive({ dir, source: src }), code(re));
    assert.deepEqual(snapshot(dir), snap, JSON.stringify(opts));
    assert.equal(chainOf(dir).length, 2);
  };
  bad({ header: { prices_daily_stock: 'record_id,security_id,trade_date,open,closing' } }, /MINE_RUNNER_ARRIVE_HEADER/);
  bad({ wrongDate: { table: 'market_daily_basic_observation_stock', date: '2027-01-04' } }, /MINE_RUNNER_ARRIVE_ROW_DATE/);
  bad({ wrongDate: { table: 'security_master_stock', date: '2027-01-06' } }, /MINE_RUNNER_ARRIVE_ROW_DATE/);
  bad({ emptyPrices: true }, /MINE_RUNNER_ARRIVE_EMPTY_DAY/);
  const root = dropRoot(DAYS.slice(0, 1)); fs.rmSync(path.join(root, compact(DAYS[0]), 'security_master_stock.csv'));
  const dirM = sealedDir(); A().arrive({ dir: dirM, source: A().csvDayDropSource(root) });
  assert.equal(A().arrive({ dir: dirM, source: A().csvDayDropSource(root) }).status, 'NOT_AVAILABLE', 'a day with a missing file is not there yet');
  const unsealed = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2arr-unsealed-'));
  assert.throws(() => A().arrive({ dir: unsealed, source: A().csvDayDropSource(dropRoot(DAYS.slice(0, 1))) }), code(/MINE_RUNNER_ARRIVE_NOT_SEALED/));
  assert.deepEqual(fs.readdirSync(unsealed), []);
});

test('AR6 crash healing: files written but no chain row (or SUMS lines missing) is completed by the next run, byte for byte, without duplicates; a different file on disk is refused', () => {
  for (const point of ['AFTER_FILES', 'AFTER_SUMS']) {
    const dir = sealedDir(); const src = A().csvDayDropSource(dropRoot(DAYS.slice(0, 2)));
    A().arrive({ dir, source: src });
    assert.throws(() => A().internals.withFault(point, () => A().arrive({ dir, source: src })), code(/MINE_RUNNER_ARRIVE_TEST_FAULT/));
    assert.equal(chainOf(dir).length, 1, 'no chain row for the unfinished day');
    const r = A().arrive({ dir, source: src });
    assert.deepEqual([r.status, r.day, r.seq], ['ARRIVED', DAYS[0], 1], point);
    const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
    assert.equal(new Set(sums.map((l) => l.split('  ')[1])).size, sums.length, 'no name listed twice');
    assert.deepEqual(A().verifyChain(dir).days, [DAYS[0]]);
  }
  const dir = sealedDir(); const src = A().csvDayDropSource(dropRoot(DAYS.slice(0, 2)));
  A().arrive({ dir, source: src });
  assert.throws(() => A().internals.withFault('AFTER_FILES', () => A().arrive({ dir, source: src })), code(/TEST_FAULT/));
  fs.appendFileSync(path.join(dir, `prices_daily_stock_${compact(DAYS[0])}.csv`), 'x\n');
  assert.throws(() => A().arrive({ dir, source: src }), code(/MINE_RUNNER_ARRIVE_CONFLICT/), 'a file on disk that is not what the source delivers');
});

test('AR7 verifyChain: a good chain passes; every kind of tampering is caught (edited file, deleted or reordered or edited row, missing SUMS line, unchained file, skipped day, out-of-order day)', () => {
  const build = () => { const dir = sealedDir(); drain(dir, A().csvDayDropSource(dropRoot(DAYS.slice(0, 5)))); return dir; };
  const good = build();
  const v = A().verifyChain(good);
  assert.deepEqual([v.days.length, v.last_day, v.rows], [5, DAYS[4], 6]);
  assert.equal(v.head_hash, chainOf(good)[5].record_hash);
  const invalid = (mutate, re, label) => { const dir = build(); mutate(dir); assert.throws(() => A().verifyChain(dir), code(re), label); };
  const rewriteChain = (dir, f) => fs.writeFileSync(path.join(dir, 'ARRIVAL_CHAIN_V1.jsonl'), `${f(chainOf(dir)).map((r) => JSON.stringify(r)).join('\n')}\n`);
  invalid((d) => fs.appendFileSync(path.join(d, `prices_daily_stock_${compact(DAYS[2])}.csv`), '\n'), /MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:FILE_SHA/, 'an edited day file');
  invalid((d) => rewriteChain(d, (rows) => rows.filter((r) => r.seq !== 3)), /MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:SEQ/, 'a deleted row');
  invalid((d) => rewriteChain(d, (rows) => [rows[0], rows[1], rows[3], rows[2], rows[4], rows[5]]), /MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:SEQ/, 'two rows swapped');
  invalid((d) => rewriteChain(d, (rows) => rows.map((r) => (r.seq === 2 ? { ...r, arrived_at: '2027-01-01T00:00:00+08:00' } : r))), /MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:RECORD_HASH/, 'an edited row');
  invalid((d) => rewriteChain(d, (rows) => rows.map((r) => (r.seq === 2 ? { ...r, files: r.files.map((f, i) => (i === 0 ? { ...f, sha256: sha('x') } : f)) } : r))), /MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:RECORD_HASH/, 'a row whose file hash was changed');
  invalid((d) => fs.writeFileSync(path.join(d, 'SHA256SUMS'), fs.readFileSync(path.join(d, 'SHA256SUMS'), 'utf8').split('\n').filter((l) => !l.includes(`security_master_stock_${compact(DAYS[1])}`)).join('\n') + '\n'), /MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:SUMS/, 'a file the chain names but SUMS does not list');
  invalid((d) => { const t = 'extra,1\n'; fs.writeFileSync(path.join(d, 'prices_daily_stock_20270199.csv'), t); fs.appendFileSync(path.join(d, 'SHA256SUMS'), `${sha(t)}  prices_daily_stock_20270199.csv\n`); }, /MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:UNCHAINED/, 'a file in SUMS that no chain row names');
  invalid((d) => fs.rmSync(path.join(d, 'ARRIVAL_CHAIN_V1.jsonl')), /MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:NO_CHAIN/, 'no chain at all');
  // a skipped open day: re-chain rows 3.. as if day 3 had never arrived (a consistent forgery of the chain, caught by the calendar)
  invalid((d) => {
    const rows = chainOf(d); const skipped = rows.filter((r) => r.trade_date !== DAYS[2]);
    let prev = null; const re = skipped.map((r, i) => { const body = { ...r, seq: i, prev_hash: prev }; delete body.record_hash; const rec = { ...body, record_hash: require('../services/trial-ledger').recordHash(body) }; prev = rec.record_hash; return rec; });
    fs.writeFileSync(path.join(d, 'ARRIVAL_CHAIN_V1.jsonl'), `${re.map((r) => JSON.stringify(r)).join('\n')}\n`);
    for (const f of rows.find((r) => r.trade_date === DAYS[2]).files) fs.rmSync(path.join(d, f.name));
    fs.writeFileSync(path.join(d, 'SHA256SUMS'), fs.readFileSync(path.join(d, 'SHA256SUMS'), 'utf8').split('\n').filter((l) => !l.includes(`_${compact(DAYS[2])}.csv`)).join('\n') + '\n');
  }, /MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:GAP/, 'a consistent chain with a skipped open day');
  // window: complete, incomplete at the tail (not arrived yet), and a window that starts before the first arrived day
  assert.doesNotThrow(() => A().verifyChain(good, { window: { from: DAYS[0], to: DAYS[4] } }));
  assert.throws(() => A().verifyChain(good, { window: { from: DAYS[0], to: DAYS[6] } }), code(new RegExp(`MINE_RUNNER_HOLDOUT_INCOMPLETE:arrival:${DAYS[5]}`)));
  assert.doesNotThrow(() => A().verifyChain(good, { window: { from: DAYS[2], to: DAYS[3] } }), 'days outside the window are not the window');
});

test('AR8 the calendar can be updated later: new or changed rows arrive as a dated part (a calendar row of an already arrived day cannot close it)', () => {
  const dir = sealedDir(); const early = calendarCsv(DAYS[2]);
  const src1 = A().csvDayDropSource(dropRoot(DAYS.slice(0, 5), {}, { calendar: early }));
  drain(dir, src1);
  assert.equal(chainOf(dir).filter((r) => r.kind === 'DAY').length, 3);
  const src2 = A().csvDayDropSource(dropRoot(DAYS.slice(0, 5)));
  const r = A().arrive({ dir, source: src2, arrivedAt: '2027-01-08T20:30:00+08:00' });
  assert.deepEqual([r.status, r.kind], ['ARRIVED', 'CALENDAR']);
  const part = chainOf(dir).filter((x) => x.kind === 'CALENDAR')[1];
  assert.deepEqual(part.files.map((f) => f.name), ['trading_calendar_20270108.csv']);
  const text = fs.readFileSync(path.join(dir, 'trading_calendar_20270108.csv'), 'utf8').split('\n').filter(Boolean);
  assert.equal(text[0], CAL_COLS);
  assert.ok(text.length > 1 && text.slice(1).every((l) => l.split(',')[0] > DAYS[2]), 'only the rows that were not there');
  drain(dir, src2);
  assert.equal(chainOf(dir).filter((x) => x.kind === 'DAY').length, 5);
  assert.equal(A().verifyChain(dir).days.length, 5);
  // the same calendar again: nothing to deliver
  assert.equal(A().arrive({ dir, source: src2, arrivedAt: '2027-01-09T20:30:00+08:00' }).status, 'NOT_AVAILABLE', 'no calendar delta; the next day is not dropped yet');
  // a revised calendar that closes an arrived day is refused (the chain would no longer fit the calendar); nothing is written
  const closes = `${calendarCsv()}${DAYS[1]},A_SHARE,SSE,f,,2027-01-09 08:00:00+08,2027-01-09 08:00:00+08,cal:${DAYS[1]}:2,2,synthetic-v1,READY\n`;
  const snap = snapshot(dir);
  assert.throws(() => A().arrive({ dir, source: A().csvDayDropSource(dropRoot(DAYS.slice(0, 5), {}, { calendar: closes })), arrivedAt: '2027-01-10T20:30:00+08:00' }), code(/MINE_RUNNER_ARRIVE_CALENDAR_CONFLICT/));
  assert.deepEqual(snapshot(dir), snap);
  // and a calendar part nobody chained is caught by the verifier
  const t = `${CAL_COLS}\n${DAYS[1]},A_SHARE,SSE,f,,2027-01-09 08:00:00+08,2027-01-09 08:00:00+08,cal:${DAYS[1]}:2,2,synthetic-v1,READY\n`;
  fs.writeFileSync(path.join(dir, 'trading_calendar_20270110.csv'), t);
  fs.appendFileSync(path.join(dir, 'SHA256SUMS'), `${sha(t)}  trading_calendar_20270110.csv\n`);
  assert.throws(() => A().verifyChain(dir), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:UNCHAINED/));

});

test('AR9 PG_PSQL driver: the spec\'s queries per day (read-only, parameterised on the day), the calendar query, and a source built on an injected runner; psql arguments are built, nothing runs', () => {
  const a = A();
  const qs = a.pgQueries('2027-01-04');
  assert.deepEqual(qs.map((q) => q.stem), Object.keys(HEADERS));
  for (const q of qs) {
    assert.ok(/^SELECT /.test(q.sql), q.stem);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i.test(q.sql), `${q.stem}: read-only`);
    assert.ok(q.sql.includes("'2027-01-04'"), `${q.stem}: the day`);
  }
  assert.match(qs[0].sql, /FROM prices_daily WHERE trade_date = '2027-01-04' AND security_id IN \(SELECT DISTINCT security_id FROM canonical_security_observation WHERE asset_class = 'STOCK' AND security_id IS NOT NULL\)/);
  assert.match(qs[3].sql, /FROM canonical_security_observation WHERE asset_class = 'STOCK' AND security_id IS NOT NULL AND business_date = '2027-01-04'/);
  assert.match(a.pgCalendarQuery(), /FROM canonical_calendar_observation WHERE calendar_date >= '2019-06-01' AND calendar_date <= '2027-12-31'/);
  const args = a.psqlArgs('SELECT 1');
  assert.deepEqual(args.slice(0, 5), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c']);
  assert.equal(args[5], '\\copy (SELECT 1) TO STDOUT WITH (FORMAT csv, HEADER true)');
  const asked = [];
  const run = (sql) => { asked.push(sql); const stem = Object.keys(HEADERS).find((s) => qs.find((q) => q.stem === s && q.sql === sql)); return Buffer.from(stem ? dayTexts('2027-01-04')[stem] : calendarCsv()); };
  const src = a.pgDaySource({ run });
  assert.equal(src.driver, 'PG_PSQL');
  assert.ok(src.calendar().toString().startsWith(CAL_COLS));
  const got = src.day('2027-01-04');
  assert.deepEqual(Object.keys(got.files), Object.keys(HEADERS));
  assert.equal(asked.length, 1 + 6);
  const emptyPrices = a.pgDaySource({ run: (sql) => Buffer.from(/prices_daily/.test(sql) ? `${HEADERS.prices_daily_stock}\n` : dayTexts('2027-01-04').security_master_stock) });
  assert.equal(emptyPrices.day('2027-01-04'), null, 'no prices yet = the day is not available');
  // the same core accepts it (calendar, then the first day; the stub returns day 2027-01-04 for every query)
  const dir = sealedDir(); a.arrive({ dir, source: src }); assert.equal(a.arrive({ dir, source: src }).day, '2027-01-04');
  assert.deepEqual(a.verifyChain(dir).days, ['2027-01-04']);
});

test('AR10 CLI r2-arrive and run.sh: the arrival is a command that loops until nothing is left, reads the window end from the resolution record, and its container is the only one that writes the R2 directory', () => {
  const cli = require('../services/mining-sandbox/round-runner/cli');
  assert.ok(cli.OPTIONS['r2-arrive']);
  for (const o of ['holdout', 'driver', 'source', 'arrived-at']) assert.ok(cli.OPTIONS['r2-arrive'].includes(o), o);
  const sh = fs.readFileSync(path.join(__dirname, '..', 'deploy/research-lane/round-runner/run.sh'), 'utf8');
  assert.match(sh, /^  r2-arrive\)/m);
  const line = sh.split('\n').find((l) => l.includes('--name "rf1116-r2-arrive"'));
  assert.ok(line, 'the container line');
  for (const f of ['--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 0:0', '-v "$HOLDOUT:/data/holdout:rw"', '-v "$DAYDROP:/data/daydrop:ro"', '-v "$OUT:/out:ro"', 'r2-arrive --holdout /data/holdout --driver csv-day-drop --source /data/daydrop']) assert.ok(line.includes(f), f);
  assert.ok(!line.includes('/data/lane') && !line.includes('$FACTOR_SERIES'), 'it sees no other data');
  assert.match(sh, /^DAYDROP="\$LANE\/r2-daydrop"/m);
  // every other container keeps the sealed directory read-only
  for (const l of sh.split('\n').filter((x) => /^\s*docker run /.test(x) && !x.includes('rf1116-r2-arrive'))) assert.ok(!l.includes('$HOLDOUT:/data/holdout:rw'), l.slice(0, 80));
});
