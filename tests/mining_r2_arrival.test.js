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
  industry_membership_sw2021: 'record_id,security_id,industry_standard,industry_level,first_available_at',
};
/** One day's files as the V6-side job would drop them (verbatim CSV text per table). `industry`: the day's membership rows (default none: a header-only part is normal). */
function dayTexts(day, { rows = 3, wrongDate = null, emptyPrices = false, header = {}, industry = [] } = {}) {
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
    industry_membership_sw2021: csv('industry_membership_sw2021', industry),
  };
}
/** The readiness record the exporter writes with a day (R2_DAY_EXPORT_READINESS_V2 row + the probe's sha256). */
// the industry window of a day (plan-coord 2026-11-23): [previous part's upper bound, 09:00+08 of the next open day); the first day of a segment starts at the segment's lower bound
const nextOpenOf = (day) => [...new Set([...R1_CAL_OPEN, ...OPEN])].sort().find((d) => d > day) || addDays(day, 3);
const windowOfDay = (day) => ({ window_from: (day === '2026-11-18' || day === DAYS[0]) ? (day < '2027' ? '2026-10-17T00:00:00+08:00' : '2027-01-01T00:00:00+08:00') : `${day}T09:00:00+08:00`, window_to: `${nextOpenOf(day)}T09:00:00+08:00` });
const readinessOf = (day) => ({ schema: 'R2_DAY_EXPORT_READINESS_RECORD_V1', trade_date: day, probe_sha256: sha('probe-v2'), ready_via: 'POST_CLOSE_D', n_prices: 5260, n_basic: 5217, n_adj: 5229, n_cov: 1, probed_at: `${day}T16:00:00+08:00`, ...windowOfDay(day) });
/** A CSV_DAY_DROP root: calendar plus one directory per day (YYYYMMDD) with the six files. opts per day: { [day]: dayTexts options | null (not dropped yet) } */
function dropRoot(days, opts = {}, { calendar = calendarCsv() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2drop-'));
  if (calendar !== null) fs.writeFileSync(path.join(root, 'trading_calendar.csv'), calendar);
  for (const day of days) {
    if (opts[day] === null) continue;
    const dir = path.join(root, compact(day)); fs.mkdirSync(dir);
    for (const [stem, text] of Object.entries(dayTexts(day, opts[day] || {}))) fs.writeFileSync(path.join(dir, `${stem}.csv`), text);
    const rdOpt = (opts[day] || {}).readiness;
    if (rdOpt !== 'omit') fs.writeFileSync(path.join(dir, 'READINESS.json'), `${JSON.stringify({ ...readinessOf(day), ...(rdOpt || {}) })}\n`);
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
  assert.deepEqual(a.TABLES.map((t) => t.dateCol), ['trade_date', 'trade_date', 'trade_date', 'business_date', 'trade_date', 'trade_date', null], 'industry rows carry no day: their window is first_available_at');
  assert.ok(Object.isFrozen(a.TABLES));
  const hold = require('../services/mining-sandbox/round-runner').HOLDOUT_TABLES;
  for (const t of a.TABLES.filter((x) => x.dateCol)) assert.ok(hold.includes(`${t.stem}.csv`), `${t.stem} is a table the directory check requires`);
  assert.ok(!hold.includes('industry_membership_sw2021.csv'), 'the industry supplement is optional for the directory check (R1 was sealed without it)');
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
  assert.equal(rows[1].files.length, 14, 'seven base files and seven parts on the first day (the industry membership is the seventh table)');
  assert.deepEqual(rows[1].files.find((f) => f.name === `prices_daily_stock_${compact(DAYS[0])}.csv`).rows, 3);
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  assert.equal(sums.length, 1 + 1 + 14, 'sealed line, calendar, fourteen day-1 files');
  for (const f of rows[1].files) assert.ok(sums.includes(`${f.sha256}  ${f.name}`), f.name);
  assert.deepEqual(A().verifyChain(dir).days, [DAYS[0]]);
  // the second day adds only the seven parts
  A().arrive({ dir, source: src });
  assert.equal(chainOf(dir)[2].files.length, 7);
  assert.deepEqual(A().verifyChain(dir).days, [DAYS[0], DAYS[1]]);
});

test('AR2b industry membership: the seventh table, rows by first_available_at window (first R2 part from 2027-01-01 00:00+08; later parts from the day after the previous open day), a header-only part is normal, a part may carry rows of a weekend', () => {
  const dir = sealedDir();
  const ind = { [DAYS[0]]: { industry: ['ind:w,S01.SH,SW2021,L1,2027-01-01 00:00:00+08', 'ind:x,S02.SH,SW2021,L1,2027-01-03 12:00:00+08', `ind:y,S03.SH,SW2021,L1,${DAYS[0]} 20:00:00+08`] }, [DAYS[1]]: { industry: [] }, [DAYS[4]]: { industry: [`ind:z,S01.SH,SW2021,L1,${addDays(DAYS[3], 1)} 09:00:00+08`] } };
  const src = A().csvDayDropSource(dropRoot(DAYS.slice(0, 5), ind));
  const res = drain(dir, src);
  assert.deepEqual(res.out, ['ARRIVED', 'ARRIVED', 'ARRIVED', 'ARRIVED', 'ARRIVED', 'ARRIVED', 'NOT_AVAILABLE'], 'calendar, five days, then the sixth is not dropped yet');
  const stem = 'industry_membership_sw2021';
  assert.equal(fs.readFileSync(path.join(dir, `${stem}.csv`), 'utf8'), `${HEADERS[stem]}\n`, 'the industry base file is header only');
  assert.equal(fs.readFileSync(path.join(dir, `${stem}_${compact(DAYS[0])}.csv`), 'utf8'), dayTexts(DAYS[0], ind[DAYS[0]])[stem]);
  assert.equal(fs.readFileSync(path.join(dir, `${stem}_${compact(DAYS[1])}.csv`), 'utf8'), `${HEADERS[stem]}\n`, 'a day without new members: header-only part');
  const row = chainOf(dir).find((r) => r.trade_date === DAYS[0]);
  assert.equal(row.files.find((f) => f.name === `${stem}_${compact(DAYS[0])}.csv`).rows, 3);
  assert.deepEqual(A().verifyChain(dir).days, DAYS.slice(0, 5));
  // a chain row that lacks the industry part is MISSING_TABLE
  const d2 = sealedDir(); drain(d2, A().csvDayDropSource(dropRoot(DAYS.slice(0, 2))));
  const rows = chainOf(d2); const t = require('../services/trial-ledger');
  let prev = null; const re = rows.map((r, i) => { const body = { ...r, seq: i, prev_hash: prev, files: r.files.filter((f) => !f.name.startsWith(stem)) }; delete body.record_hash; const rec = { ...body, record_hash: t.recordHash(body) }; prev = rec.record_hash; return rec; });
  fs.writeFileSync(path.join(d2, 'ARRIVAL_CHAIN_V1.jsonl'), `${re.map((r) => JSON.stringify(r)).join('\n')}\n`);
  assert.throws(() => A().verifyChain(d2), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:(MISSING_TABLE|UNCHAINED)/));
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
  // industry rows must lie in the day's first_available_at window [previous part's upper bound, 09:00+08 of the next open day): DAYS[1] = 2027-01-05, window [2027-01-05 09:00, 2027-01-06 09:00)
  bad({ industry: ['ind:a,S01.SH,SW2021,L1,2027-01-04 23:59:59+08'] }, /MINE_RUNNER_ARRIVE_ROW_WINDOW/);
  bad({ industry: ['ind:b,S01.SH,SW2021,L1,2027-01-06 09:00:00+08'] }, /MINE_RUNNER_ARRIVE_ROW_WINDOW/);
  bad({ industry: ['ind:c,S01.SH,SW2021,L1,'] }, /MINE_RUNNER_ARRIVE_ROW_WINDOW/);
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
  // a stray file listed in SHA256SUMS that no chain row names is not "healed": the next run refuses
  const dir2 = sealedDir(); const src2 = A().csvDayDropSource(dropRoot(DAYS.slice(0, 3)));
  A().arrive({ dir: dir2, source: src2 }); A().arrive({ dir: dir2, source: src2 });
  const stray = 'record_id\nx\n'; fs.writeFileSync(path.join(dir2, 'zzz_stray.csv'), stray); fs.appendFileSync(path.join(dir2, 'SHA256SUMS'), `${sha(stray)}  zzz_stray.csv\n`);
  assert.throws(() => A().arrive({ dir: dir2, source: src2 }), code(/MINE_RUNNER_ARRIVE_CONFLICT:unchained zzz_stray\.csv/));
  assert.equal(chainOf(dir2).length, 2);
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
  const rechain = (d, rows) => { let prev = null; const re = rows.map((r, i) => { const body = { ...r, seq: i, prev_hash: prev }; delete body.record_hash; const rec = { ...body, record_hash: require('../services/trial-ledger').recordHash(body) }; prev = rec.record_hash; return rec; }); fs.writeFileSync(path.join(d, 'ARRIVAL_CHAIN_V1.jsonl'), `${re.map((r) => JSON.stringify(r)).join('\n')}\n`); };
  invalid((d) => rechain(d, chainOf(d).map((r) => (r.seq === 2 ? { ...r, files: [...r.files, r.files[0]] } : r))), /MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:DUPLICATE/, 'a file named twice');
  invalid((d) => rechain(d, chainOf(d).map((r) => (r.seq === 3 ? { ...r, files: r.files.filter((f) => !f.name.startsWith('security_master_stock')) } : r))), /MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:MISSING_TABLE/, 'a day without one of its tables');
  // (a careful forger also re-windows the later rows, so only the calendar can tell)
  // a skipped open day: re-chain rows 3.. as if day 3 had never arrived (a consistent forgery of the chain, caught by the calendar)
  invalid((d) => {
    const rows = chainOf(d); const skipped = rows.filter((r) => r.trade_date !== DAYS[2]);
    let prev = null; let prevTo = null; const re = skipped.map((r, i) => { const body = { ...r, seq: i, prev_hash: prev }; delete body.record_hash;
      if (r.kind === 'DAY') { if (prevTo) body.window_from = prevTo; prevTo = body.window_to; } const rec = { ...body, record_hash: require('../services/trial-ledger').recordHash(body) }; prev = rec.record_hash; return rec; });
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
  const ctx = { industryFrom: '2027-01-01T00:00:00+08:00', industryTo: '2027-01-05T09:00:00+08:00' };
  const qs = a.pgQueries('2027-01-04', ctx);
  assert.deepEqual(qs.map((q) => q.stem), Object.keys(HEADERS));
  for (const q of qs) {
    assert.ok(/^SELECT /.test(q.sql), q.stem);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i.test(q.sql), `${q.stem}: read-only`);
    if (q.stem !== 'industry_membership_sw2021') assert.ok(q.sql.includes("'2027-01-04'"), `${q.stem}: the day`); // industry is a first_available_at window, checked below
  }
  assert.match(qs[0].sql, /FROM prices_daily WHERE trade_date = '2027-01-04' AND security_id IN \(SELECT DISTINCT security_id FROM canonical_security_observation WHERE asset_class = 'STOCK' AND security_id IS NOT NULL\)/);
  assert.match(qs[3].sql, /FROM canonical_security_observation WHERE asset_class = 'STOCK' AND security_id IS NOT NULL AND business_date = '2027-01-04'/);
  // industry (export spec rev 5 change 2): the membership rows that became available in [industryFrom 00:00+08, day + 1 00:00+08); no effective_from cut per day
  assert.match(qs[6].sql, /^SELECT record_id, security_id, industry_standard, industry_level, industry_code, industry_name, effective_from, effective_to, first_available_at, ingested_at, source_record_id, revision, schema_version, quality_state FROM industry_membership WHERE first_available_at >= TIMESTAMPTZ '2027-01-01 00:00:00\+08' AND first_available_at < TIMESTAMPTZ '2027-01-05 09:00:00\+08' ORDER BY security_id, industry_standard, industry_level, effective_from, revision$/);
  assert.ok(!/effective_from <=/.test(qs[6].sql));
  assert.throws(() => a.pgQueries('2027-01-04'), code(/INDUSTRY_FROM/), 'the lower bound is required');
  assert.throws(() => a.pgQueries('2027-01-04', { industryFrom: ctx.industryFrom }), code(/INDUSTRY_TO/), 'the upper bound is required');
  assert.equal(a.pgDaySource({ run: () => Buffer.from('') }).day('2027-01-04', { industryFrom: ctx.industryFrom, industryTo: null }), null, 'the next open day (the window end) is not known yet: the day is not available');
  assert.match(a.pgCalendarQuery(), /FROM canonical_calendar_observation WHERE calendar_date >= '2019-06-01' AND calendar_date <= '2027-12-31'/);
  const args = a.psqlArgs('SELECT 1');
  assert.deepEqual(args.slice(0, 5), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c']);
  assert.equal(args[5], '\\copy (SELECT 1) TO STDOUT WITH (FORMAT csv, HEADER true)');
  const asked = [];
  const run = (sql) => { asked.push(sql); const stem = Object.keys(HEADERS).find((s) => qs.find((q) => q.stem === s && q.sql === sql)); return Buffer.from(stem ? dayTexts('2027-01-04')[stem] : calendarCsv()); };
  const src = a.pgDaySource({ run });
  assert.equal(src.driver, 'PG_PSQL');
  assert.ok(src.calendar().toString().startsWith(CAL_COLS));
  const got = src.day('2027-01-04', ctx);
  assert.deepEqual(Object.keys(got.files), Object.keys(HEADERS));
  assert.equal(asked.length, 1 + 7);
  const emptyPrices = a.pgDaySource({ run: (sql) => Buffer.from(/prices_daily/.test(sql) ? `${HEADERS.prices_daily_stock}\n` : dayTexts('2027-01-04').security_master_stock) });
  assert.equal(emptyPrices.day('2027-01-04', ctx), null, 'no prices yet = the day is not available');
  // the same core accepts it (calendar, then the first day; the stub returns day 2027-01-04 for every query)
  const dir = sealedDir(); a.arrive({ dir, source: src }); assert.equal(a.arrive({ dir, source: src }).day, '2027-01-04');
  assert.deepEqual(a.verifyChain(dir).days, ['2027-01-04']);
});

test('AR10 CLI r2-arrive and run.sh: the arrival is a command that loops until nothing is left, reads the window end from the resolution record, and its container is the only one that writes the R2 directory', () => {
  const cli = require('../services/mining-sandbox/round-runner/cli');
  assert.ok(cli.OPTIONS['r2-arrive'], 'the R2 command stays');
  for (const o of ['holdout', 'driver', 'source', 'arrived-at']) assert.ok(cli.OPTIONS['r2-arrive'].includes(o), o);
  for (const o of ['holdout', 'driver', 'source', 'arrived-at', 'segment', 'check-complete']) assert.ok(cli.OPTIONS['holdout-arrive'].includes(o), o);
  const sh = fs.readFileSync(path.join(__dirname, '..', 'deploy/research-lane/round-runner/run.sh'), 'utf8');
  assert.match(sh, /^  arrive\|r2-arrive\)/m, 'one case: `arrive` for the segment of RF1116_HOLDOUT_SEGMENT, `r2-arrive` kept for R2');
  const line = sh.split('\n').find((l) => l.includes('--name "rf1116-holdout-arrive"'));
  assert.ok(line, 'the container line');
  for (const f of ['--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 0:0', '-v "$HOLDOUT:/data/holdout:rw"', '-v "$DAYDROP:/data/daydrop:ro"', '-v "$OUT:/out:ro"', 'holdout-arrive --segment "${RF1116_HOLDOUT_SEGMENT:-R1}" --holdout /data/holdout --driver csv-day-drop --source /data/daydrop']) assert.ok(line.includes(f), f);
  assert.ok(!line.includes('/data/lane') && !line.includes('$FACTOR_SERIES'), 'it sees no other data');
  assert.match(sh, /^DAYDROP="\$LANE\/holdout-daydrop\/\$\{RF1116_HOLDOUT_SEGMENT:-R1\}"/m, 'one drop directory per segment');
  assert.match(sh, /^  score\)[\s\S]*?--require-arrival-chain/m, 'score always requires the arrival chain (R1: the hand supplement path is closed in production)');
  assert.match(sh, /^  rescore\)[\s\S]*?--require-arrival-chain/m);
  // every other container keeps the sealed directory read-only
  for (const l of sh.split('\n').filter((x) => /^\s*docker run /.test(x) && !x.includes('rf1116-holdout-arrive'))) assert.ok(!l.includes('$HOLDOUT:/data/holdout:rw'), l.slice(0, 80));
});

// ── R1 catch-up: the same program delivers the days after the sealed export's D1 (2026-11-17) into the SEALED R1 directory ────────────────────────────────────────────────
const R1_CAL_OPEN = range('2026-10-12', '2026-12-31').filter((d) => weekday(d) !== 0 && weekday(d) !== 6);
const R1_DAYS = R1_CAL_OPEN.filter((d) => d > '2026-11-17'); // 2026-11-18 .. 2026-12-31
const r1CalendarCsv = () => `${CAL_COLS}\n${range('2026-10-12', '2026-12-31').map((d) => [d, 'A_SHARE', 'SSE', R1_CAL_OPEN.includes(d) ? 't' : 'f', '', '2026-10-01 08:00:00+08', '2026-10-01 08:00:00+08', `cal:${d}`, 1, 'synthetic-v1', 'READY'].join(',')).join('\n')}\n`;
const R1_SEALED_TABLES = Object.keys(HEADERS).filter((s) => s !== 'industry_membership_sw2021');
/** The R1 directory as sealed on 11-18: six daily tables (base files with data through D1) plus the full calendar, SHA256SUMS == SHA256SUMS.sealed. No industry file. */
function sealedR1Dir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r1arr-'));
  const early = R1_CAL_OPEN.filter((d) => d >= '2026-10-19' && d <= '2026-11-17');
  const lines = [];
  for (const stem of R1_SEALED_TABLES) {
    const rows = early.map((d) => dayTexts(d)[stem].split('\n')[1]); // one data row per sealed day
    const text = `${HEADERS[stem]}\n${rows.join('\n')}\n`;
    fs.writeFileSync(path.join(dir, `${stem}.csv`), text); lines.push(`${sha(text)}  ${stem}.csv`);
  }
  const cal = r1CalendarCsv(); fs.writeFileSync(path.join(dir, 'trading_calendar.csv'), cal); lines.push(`${sha(cal)}  trading_calendar.csv`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`); fs.writeFileSync(path.join(dir, 'SHA256SUMS.sealed'), `${lines.join('\n')}\n`);
  return dir;
}
const R1 = { segment: 'R1' };

test('AR11 R1 catch-up: days 11-18.. arrive into the sealed R1 directory as parts; the sealed files and SHA256SUMS.sealed never move; the chain starts with a DAY row; industry gets a header-only base file and its first part reaches back to 2026-10-17', () => {
  const dir = sealedR1Dir(); const before = snapshot(dir);
  const ind = { [R1_DAYS[0]]: { industry: ['ind:r,S01.SH,SW2021,L1,2026-10-17 00:00:00+08', `ind:s,S02.SH,SW2021,L1,${R1_DAYS[0]} 10:00:00+08`] } };
  const src = A().csvDayDropSource(dropRoot(R1_DAYS, ind, { calendar: null }));
  const first = A().arrive({ dir, source: src, ...R1, arrivedAt: '2026-11-24T20:30:00+08:00' });
  assert.deepEqual([first.status, first.kind, first.day, first.seq], ['ARRIVED', 'DAY', R1_DAYS[0], 0], 'no calendar row: the calendar was sealed');
  const rows = chainOf(dir);
  assert.deepEqual([rows[0].segment, rows[0].kind, rows[0].trade_date, rows[0].prev_hash], ['R1', 'DAY', '2026-11-18', null]);
  assert.equal(rows[0].files.length, 8, 'seven parts and the header-only industry base');
  const now = snapshot(dir);
  for (const stem of R1_SEALED_TABLES) assert.equal(now[`${stem}.csv`], before[`${stem}.csv`], `${stem}: the sealed base file is untouched`);
  assert.equal(now['SHA256SUMS.sealed'], before['SHA256SUMS.sealed']);
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(sums.slice(0, 7), fs.readFileSync(path.join(dir, 'SHA256SUMS.sealed'), 'utf8').split('\n').filter(Boolean), 'the sealed lines are the first lines, unchanged');
  assert.equal(sums.length, 7 + 8);
  assert.equal(fs.readFileSync(path.join(dir, 'industry_membership_sw2021.csv'), 'utf8'), `${HEADERS.industry_membership_sw2021}\n`);
  assert.equal(fs.readFileSync(path.join(dir, `industry_membership_sw2021_${compact(R1_DAYS[0])}.csv`), 'utf8'), dayTexts(R1_DAYS[0], ind[R1_DAYS[0]]).industry_membership_sw2021);
  // the rest of the window, then COMPLETE
  const res = drain(dir, src, { ...R1, windowEnd: '2026-12-31' });
  assert.equal(res.out[res.out.length - 1], 'COMPLETE');
  assert.equal(res.out.length, R1_DAYS.length, 'one ARRIVED per remaining open day, then COMPLETE');
  const v = A().verifyChain(dir, { ...R1, window: { from: '2026-10-19', to: '2026-12-31' } });
  assert.deepEqual([v.days.length, v.last_day], [R1_DAYS.length, '2026-12-31']);
  assert.ok(chainOf(dir).every((r) => r.segment === 'R1' && r.kind === 'DAY'));
  // a chain row that says R2 is not an R1 chain
  assert.throws(() => A().verifyChain(dir), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:SCHEMA/), 'the default profile is R2');
});

test('AR12 R1 catch-up refusals: the same ORDER / HEADER / ROW_DATE / EMPTY_DAY rules, the header is the SEALED base file\'s, only a sealed R1 directory (with its calendar) is accepted, and R1 and R2 directories are not interchangeable', () => {
  const dir = sealedR1Dir(); const src = A().csvDayDropSource(dropRoot(R1_DAYS.slice(0, 4), {}, { calendar: null }));
  A().arrive({ dir, source: src, ...R1 });
  const snap = snapshot(dir);
  assert.throws(() => A().arrive({ dir, source: src, ...R1, day: R1_DAYS[2] }), code(/MINE_RUNNER_ARRIVE_ORDER/));
  assert.throws(() => A().arrive({ dir, source: src, ...R1, day: '2026-11-21' }), code(/MINE_RUNNER_ARRIVE_NOT_OPEN_DAY/), 'a Saturday');
  assert.deepEqual(snapshot(dir), snap);
  // a day whose header differs from the sealed base file's header
  const bad = sealedR1Dir(); const badSrc = A().csvDayDropSource(dropRoot(R1_DAYS.slice(0, 1), { [R1_DAYS[0]]: { header: { prices_daily_stock: 'record_id,security_id,trade_date,open,closing' } } }, { calendar: null }));
  const badSnap = snapshot(bad);
  assert.throws(() => A().arrive({ dir: bad, source: badSrc, ...R1 }), code(/MINE_RUNNER_ARRIVE_HEADER/));
  assert.deepEqual(snapshot(bad), badSnap);
  const wrong = sealedR1Dir(); const wrongSrc = A().csvDayDropSource(dropRoot(R1_DAYS.slice(0, 1), { [R1_DAYS[0]]: { wrongDate: { table: 'security_master_stock', date: '2026-11-19' } } }, { calendar: null }));
  assert.throws(() => A().arrive({ dir: wrong, source: wrongSrc, ...R1 }), code(/MINE_RUNNER_ARRIVE_ROW_DATE/));
  const empty = sealedR1Dir(); const emptySrc = A().csvDayDropSource(dropRoot(R1_DAYS.slice(0, 1), { [R1_DAYS[0]]: { emptyPrices: true } }, { calendar: null }));
  assert.throws(() => A().arrive({ dir: empty, source: emptySrc, ...R1 }), code(/MINE_RUNNER_ARRIVE_EMPTY_DAY/));
  // an industry row older than the first part's lower bound (2026-10-17 00:00+08) is refused
  const old = sealedR1Dir(); const oldSrc = A().csvDayDropSource(dropRoot(R1_DAYS.slice(0, 1), { [R1_DAYS[0]]: { industry: ['ind:o,S01.SH,SW2021,L1,2026-10-16 23:59:59+08'] } }, { calendar: null }));
  assert.throws(() => A().arrive({ dir: old, source: oldSrc, ...R1 }), code(/MINE_RUNNER_ARRIVE_ROW_WINDOW/));
  // not sealed / not an R1 directory / not interchangeable
  const unsealed = sealedR1Dir(); fs.rmSync(path.join(unsealed, 'SHA256SUMS.sealed'));
  assert.throws(() => A().arrive({ dir: unsealed, source: src, ...R1 }), code(/MINE_RUNNER_ARRIVE_NOT_SEALED/));
  const noCal = sealedR1Dir(); const lines = fs.readFileSync(path.join(noCal, 'SHA256SUMS'), 'utf8').split('\n').filter((l) => l && !l.includes('trading_calendar.csv')).join('\n') + '\n';
  fs.writeFileSync(path.join(noCal, 'SHA256SUMS'), lines); fs.writeFileSync(path.join(noCal, 'SHA256SUMS.sealed'), lines);
  assert.throws(() => A().arrive({ dir: noCal, source: src, ...R1 }), code(/MINE_RUNNER_ARRIVE_NOT_SEALED/), 'the sealed R1 manifest must list the calendar');
  assert.throws(() => A().arrive({ dir: sealedDir(), source: src, ...R1 }), code(/MINE_RUNNER_ARRIVE_NOT_SEALED/), 'a pending-sealed R2 directory is not R1');
  assert.throws(() => A().arrive({ dir: sealedR1Dir(), source: src }), code(/MINE_RUNNER_ARRIVE_NOT_SEALED/), 'an R1 directory is not R2');
  assert.throws(() => A().arrive({ dir: sealedR1Dir(), source: src, segment: 'R3' }), code(/MINE_RUNNER_ARRIVE_SEGMENT/));
});

test('AR13 checkComplete: after the window end, the days that have not arrived are named (R1 against the sealed calendar, R2 against the arrived calendar); complete = no missing day', () => {
  const dir = sealedR1Dir(); const src = A().csvDayDropSource(dropRoot(R1_DAYS.slice(0, 5), {}, { calendar: null }));
  drain(dir, src, R1);
  const c = A().checkComplete({ dir, ...R1, windowEnd: '2026-12-31' });
  assert.deepEqual([c.complete, c.last_day, c.missing.length, c.missing[0], c.missing[c.missing.length - 1]], [false, R1_DAYS[4], R1_DAYS.length - 5, R1_DAYS[5], '2026-12-31']);
  const full = sealedR1Dir(); drain(full, A().csvDayDropSource(dropRoot(R1_DAYS, {}, { calendar: null })), R1);
  assert.deepEqual(A().checkComplete({ dir: full, ...R1, windowEnd: '2026-12-31' }), { complete: true, last_day: '2026-12-31', missing: [] });
  // R2: needs the arrived calendar
  const r2 = sealedDir(); drain(r2, A().csvDayDropSource(dropRoot(DAYS.slice(0, 3))));
  const c2 = A().checkComplete({ dir: r2, windowEnd: DAYS[5] });
  assert.deepEqual([c2.complete, c2.last_day, c2.missing], [false, DAYS[2], DAYS.slice(3, 6)]);
  // the calendar has to reach the window end too: everything arrived up to the calendar's last day, window end beyond it = not complete
  const r2full = sealedDir(); drain(r2full, A().csvDayDropSource(dropRoot(OPEN.filter((d) => d > '2026-12-31'))));
  const beyond = A().checkComplete({ dir: r2full, windowEnd: '2027-03-05' });
  assert.deepEqual([beyond.complete, beyond.missing], [false, []], 'no day is missing but the calendar stops before the window end');
  const cli = require('../services/mining-sandbox/round-runner/cli');
  assert.ok(cli.OPTIONS['holdout-arrive'].includes('check-complete') && cli.OPTIONS['holdout-arrive'].includes('segment'));
  // the CLI: check-complete names the missing days (the process exits 4 on INCOMPLETE); holdout-arrive loops until nothing is left and reports the days
  const out = cli.main(['holdout-arrive', '--segment', 'R1', '--holdout', dir, '--check-complete', 'true']);
  assert.deepEqual([out.command, out.segment, out.status, out.window_end, out.last_day, out.missing.length], ['holdout-arrive', 'R1', 'INCOMPLETE', '2026-12-31', R1_DAYS[4], R1_DAYS.length - 5]);
  assert.equal(cli.main(['holdout-arrive', '--segment', 'R1', '--holdout', full, '--check-complete', 'true']).status, 'COMPLETE');
  const fresh = sealedR1Dir(); const root = dropRoot(R1_DAYS.slice(0, 3), {}, { calendar: null });
  const ran = cli.main(['holdout-arrive', '--segment', 'R1', '--holdout', fresh, '--driver', 'csv-day-drop', '--source', root]);
  assert.deepEqual([ran.command, ran.segment, ran.arrived, ran.status, ran.last_day, ran.window_end], ['holdout-arrive', 'R1', R1_DAYS.slice(0, 3), 'NOT_AVAILABLE', R1_DAYS[2], '2026-12-31']);
  // as a process: INCOMPLETE exits with 4 (the timer alerts on it), COMPLETE with 0
  const CLI = path.join(__dirname, '..', 'services/mining-sandbox/round-runner/cli.js');
  const env = { ...require('./_clean_env')(), QRP_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-arr-data-')) };
  const p4 = require('child_process').spawnSync(process.execPath, [CLI, 'holdout-arrive', '--segment', 'R1', '--holdout', dir, '--check-complete', 'true'], { env, encoding: 'utf8' });
  assert.equal(p4.status, 4, p4.stderr); assert.equal(JSON.parse(p4.stdout).status, 'INCOMPLETE');
  const p0 = require('child_process').spawnSync(process.execPath, [CLI, 'holdout-arrive', '--segment', 'R1', '--holdout', full, '--check-complete', 'true'], { env, encoding: 'utf8' });
  assert.equal(p0.status, 0, p0.stderr); assert.equal(JSON.parse(p0.stdout).status, 'COMPLETE');
  assert.throws(() => cli.main(['holdout-arrive', '--segment', 'R3', '--holdout', fresh, '--check-complete', 'true']), code(/MINE_RUNNER_OPTION_UNKNOWN/));
  assert.throws(() => cli.main(['holdout-arrive', '--holdout', fresh, '--driver', 'csv-day-drop']), code(/MINE_RUNNER_OPTION_REQUIRED/));
});

test('AR14 R1 scoring requires the chain (requireChain, run.sh --require-arrival-chain): a consistent edit of an arrived file (file and SHA256SUMS line) and a deleted chain are refused before any row is read; without the flag the old path is unchanged', () => {
  const runner = require('../services/mining-sandbox/round-runner');
  const build = () => { const d = sealedR1Dir(); drain(d, A().csvDayDropSource(dropRoot(R1_DAYS, {}, { calendar: null })), { ...R1, windowEnd: '2026-12-31' }); return d; };
  const seal = (d) => ({ data_sha256: sha(fs.readFileSync(path.join(d, 'SHA256SUMS.sealed'))), segment: { from: '2026-10-19', to: '2026-12-31' } });
  const check = (d, o = {}) => runner.holdoutDirCheck(d, seal(d), { minNamesPerDay: 1, ...o });
  // the synthetic directory has no validation tail, so every run stops at the row floors (after the chain stage): that error is the "chain accepted" signal
  const good = build();
  assert.throws(() => check(good, { requireChain: true }), code(/MINE_RUNNER_HOLDOUT_(INCOMPLETE|SEALED_DAYS_EMPTY)/), 'a valid R1 chain passes the chain stage (R1 profile, not the R2 one)');
  // a consistent edit: change an arrived day's file and its SHA256SUMS line
  const edited = build(); const name = `prices_daily_stock_${compact(R1_DAYS[3])}.csv`; const text = `${fs.readFileSync(path.join(edited, name), 'utf8')}pd:S99:x,S99.SH,${R1_DAYS[3]},9,9\n`;
  fs.writeFileSync(path.join(edited, name), text);
  fs.writeFileSync(path.join(edited, 'SHA256SUMS'), fs.readFileSync(path.join(edited, 'SHA256SUMS'), 'utf8').split('\n').map((l) => (l.endsWith(`  ${name}`) ? `${sha(text)}  ${name}` : l)).join('\n'));
  assert.throws(() => check(edited, { requireChain: true }), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:FILE_SHA/));
  assert.throws(() => check(edited), code(/MINE_RUNNER_HOLDOUT_(INCOMPLETE|SEALED_DAYS_EMPTY)/), 'the library default does not consult the chain');
  const noChain = build(); fs.rmSync(path.join(noChain, 'ARRIVAL_CHAIN_V1.jsonl'));
  assert.throws(() => check(noChain, { requireChain: true }), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:NO_CHAIN/));
  assert.throws(() => check(noChain), code(/MINE_RUNNER_HOLDOUT_(INCOMPLETE|SEALED_DAYS_EMPTY)/));
  // days missing at the end are INCOMPLETE:arrival, not tampering
  const short = sealedR1Dir(); drain(short, A().csvDayDropSource(dropRoot(R1_DAYS.slice(0, 5), {}, { calendar: null })), R1);
  assert.throws(() => check(short, { requireChain: true }), code(new RegExp(`MINE_RUNNER_HOLDOUT_INCOMPLETE:arrival:${R1_DAYS[5]}`)));
  const cli = require('../services/mining-sandbox/round-runner/cli');
  for (const c of ['score', 'rescore']) assert.ok(cli.OPTIONS[c].includes('require-arrival-chain'), c);
});

test('AR15 readiness (plan-coord condition iii): the exporter\'s READINESS.json is validated and recorded in the DAY chain row (ready_via, counts, probe sha, file sha); a day without it is not there yet; a record of another day, an unknown ready_via or a non-integer count is refused before anything is written; the verifier requires the field', () => {
  const dir = sealedDir(); const root = dropRoot(DAYS.slice(0, 3), { [DAYS[1]]: { readiness: { ready_via: 'NEXT_PREMARKET', n_prices: 5001 } } });
  const src = A().csvDayDropSource(root);
  drain(dir, src);
  const rows = chainOf(dir).filter((r) => r.kind === 'DAY');
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].readiness.ready_via, rows[0].readiness.n_prices, rows[0].readiness.n_cov, rows[0].readiness.probe_sha256], ['POST_CLOSE_D', 5260, 1, sha('probe-v2')]);
  assert.deepEqual([rows[1].readiness.ready_via, rows[1].readiness.n_prices], ['NEXT_PREMARKET', 5001]);
  assert.equal(rows[0].readiness.file_sha256, sha(fs.readFileSync(path.join(root, compact(DAYS[0]), 'READINESS.json'))));
  assert.ok(!fs.existsSync(path.join(dir, 'READINESS.json')) && !fs.readdirSync(dir).some((n) => n.includes('READINESS')), 'the record goes into the chain row, not into the directory');
  assert.equal(A().verifyChain(dir).days.length, 3);
  // a day whose record is missing is not available yet (nothing is written)
  const d2 = sealedDir(); const src2 = A().csvDayDropSource(dropRoot(DAYS.slice(0, 2), { [DAYS[0]]: { readiness: 'omit' } }));
  A().arrive({ dir: d2, source: src2 }); const snap = snapshot(d2);
  const na = A().arrive({ dir: d2, source: src2 }); assert.deepEqual([na.status, na.what], ['NOT_AVAILABLE', DAYS[0]]);
  assert.deepEqual(snapshot(d2), snap);
  // refused records
  const bad = (readiness, label) => {
    const d = sealedDir(); const s = A().csvDayDropSource(dropRoot(DAYS.slice(0, 1), { [DAYS[0]]: { readiness } }));
    A().arrive({ dir: d, source: s }); const before = snapshot(d);
    assert.throws(() => A().arrive({ dir: d, source: s }), code(/MINE_RUNNER_ARRIVE_READINESS/), label);
    assert.deepEqual(snapshot(d), before, label);
  };
  bad({ trade_date: DAYS[1] }, 'a record of another day');
  bad({ ready_via: 'SOMETIMES' }, 'an unknown ready_via');
  bad({ n_basic: 5217.5 }, 'a non-integer count');
  bad({ n_adj: -1 }, 'a negative count');
  bad({ probe_sha256: 'x' }, 'a probe sha that is not a sha256');
  bad({ schema: 'OTHER' }, 'another schema');
  // the industry window (plan-coord 2026-11-23): contiguous with the previous part, upper bound 09:00+08 of the next open day
  bad({ window_from: '2027-01-02T00:00:00+08:00' }, 'window_from that does not start where the previous part ended');
  bad({ window_to: `${DAYS[0]}T09:00:00+08:00` }, 'window_to not after the day');
  bad({ window_to: `${addDays(DAYS[0], 2)}T09:00:00+08:00` }, 'window_to that is not the next open day although the calendar knows it');
  bad({ window_to: `${nextOpenOf(DAYS[0])}T10:00:00+08:00` }, 'window_to that is not 09:00+08');
  bad({ window_to: `${nextOpenOf(DAYS[0])}T09:00:00Z` }, 'window_to in another offset');
  // the verifier: the field is required on every DAY row, and its ready_via must be a known one
  const rechain = (d, f) => { const t = require('../services/trial-ledger'); let prev = null; const re = f(chainOf(d)).map((r, i) => { const body = { ...r, seq: i, prev_hash: prev }; delete body.record_hash; const rec = { ...body, record_hash: t.recordHash(body) }; prev = rec.record_hash; return rec; }); fs.writeFileSync(path.join(d, 'ARRIVAL_CHAIN_V1.jsonl'), `${re.map((r) => JSON.stringify(r)).join('\n')}\n`); };
  const mk = () => { const d = sealedDir(); drain(d, A().csvDayDropSource(dropRoot(DAYS.slice(0, 2)))); return d; };
  const noField = mk(); rechain(noField, (rs) => rs.map((r) => { const { readiness, ...rest } = r; return rest; }));
  assert.throws(() => A().verifyChain(noField), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:SCHEMA/));
  const badVia = mk(); rechain(badVia, (rs) => rs.map((r) => (r.kind === 'DAY' ? { ...r, readiness: { ...r.readiness, ready_via: 'NEVER' } } : r)));
  assert.throws(() => A().verifyChain(badVia), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:SCHEMA/));
  const nulled = mk(); rechain(nulled, (rs) => rs.map((r) => (r.kind === 'DAY' ? { ...r, readiness: null } : r)));
  assert.throws(() => A().verifyChain(nulled), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:SCHEMA/), 'a dropped day cannot lose its record');
  const noWindow = mk(); rechain(noWindow, (rs) => rs.map((r) => { const { window_to, ...rest } = r; return rest; }));
  assert.throws(() => A().verifyChain(noWindow), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:SCHEMA/), 'the window is part of every DAY row');
  const gap = mk(); rechain(gap, (rs) => rs.map((r) => (r.kind === 'DAY' && r.seq === 2 ? { ...r, window_from: '2027-01-05T10:00:00+08:00' } : r)));
  assert.throws(() => A().verifyChain(gap), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:WINDOW/), 'a gap between two industry windows');
  const wrongTo = mk(); rechain(wrongTo, (rs) => rs.map((r) => (r.kind === 'DAY' && r.seq === 1 ? { ...r, window_to: `${addDays(DAYS[0], 2)}T09:00:00+08:00` } : r)));
  assert.throws(() => A().verifyChain(wrongTo), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:WINDOW/), 'an upper bound that is not the next open day');
  // an edited record without re-chaining is a hash mismatch
  const edited = mk(); fs.writeFileSync(path.join(edited, 'ARRIVAL_CHAIN_V1.jsonl'), chainOf(edited).map((r) => JSON.stringify(r.kind === 'DAY' && r.seq === 1 ? { ...r, readiness: { ...r.readiness, n_prices: 9999 } } : r)).join('\n') + '\n');
  assert.throws(() => A().verifyChain(edited), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:RECORD_HASH/));
});
