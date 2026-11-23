'use strict';
/**
 * RF1116 second CN_A holdout segment (R2): the END-RESOLUTION record and the program that writes it (plan-coord 2026-11-23: "a program that resolves R2's end from the SSE
 * calendar when it is published, and writes a record, which says which calendar it read and which date it counted"). Red first, synthetic data only.
 *   - adapter.openDaysOf: the SSE open days of a set of sources, read exactly as buildPanel reads them;
 *   - runner.resolveSegment: reads the R2 directory's trading_calendar.csv (sha-checked), counts 54 open days after 2026-12-31, appends one HOLDOUT_SEGMENT_RESOLUTION_V1 row;
 *     not enough listed days -> NOT_READY (no row); idempotent; a different window after a row exists -> refused (the window never moves);
 *   - segment-resolution.windowOf(round): the scoring window of a round (R1 / explicit windows from the manifest, R2 from the record, otherwise null);
 *   - seal-init-r2.sh: the pending seal directory the 12-01 start needs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const AUTH = 'TEST_SEGMENT_RESOLUTION_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const { makeMiningDataFixture } = require('./_mining_data_fixture');
const { R1 } = require('./_mining_manifest');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const rounds = require('../services/mining-rounds');
const ledger = require('../packages/ledger');
const trials = require('../services/trial-ledger');

const ROOT = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-segres-data-')); process.env.QRP_DATA_DIR = d; return d; };
// lazy: on the base commit the module does not exist, so each test fails on its own assertion
const res = () => require('../services/mining-rounds/segment-resolution');
const UNKNOWN = 'UNKNOWN / CALENDAR_NOT_PUBLISHED';
const CAL_COLS = ['calendar_date', 'market', 'exchange', 'is_open', 'previous_open_date', 'first_available_at', 'ingested_at', 'source_record_id', 'revision', 'schema_version', 'quality_state'];
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const range = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
/** A directory the way the export program leaves it: trading_calendar.csv for SSE and SZSE, SHA256SUMS listing it. rows: [{ date, sse, szse?, quality?, revision?, at? }] */
function calendarDir(rowsIn, { listed = true, tamper = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2-caldir-'));
  const lines = [CAL_COLS.join(',')];
  for (const r of rowsIn) {
    for (const [exchange, open] of [['SSE', r.sse], ['SZSE', r.szse === undefined ? r.sse : r.szse]]) {
      lines.push([r.date, 'A_SHARE', exchange, open ? 't' : 'f', '', r.at || '2026-12-15 08:00:00+08', '2026-12-15 08:00:00+08', `cal:${r.date}:${exchange}:${r.revision || 1}`, r.revision || 1, 'synthetic-v1', r.quality || 'READY'].join(','));
    }
  }
  const bytes = `${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(dir, 'trading_calendar.csv'), bytes);
  if (listed) fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha(bytes)}  trading_calendar.csv\n`);
  else fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha('other')}  other.csv\n`);
  if (tamper) fs.writeFileSync(path.join(dir, 'trading_calendar.csv'), `${bytes}# edited\n`);
  return { dir, bytes };
}
/** Weekdays from `from` to `to` are open (no holidays except 2027-01-01, a Friday). */
const synthetic = (from, to) => range(from, to).map((d) => ({ date: d, sse: weekday(d) !== 0 && weekday(d) !== 6 && d !== '2027-01-01' }));
const openDays = (rows) => rows.filter((r) => r.sse).map((r) => r.date);

test('RS0 adapter.openDaysOf reads the SSE open days exactly as buildPanel does (same days, same last date)', () => {
  const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-segres-fx-')));
  const sources = [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' }),
    adapter.csvDirSource(fx.dirs.holdout, { mode: 'LIVE', label: 'holdout', holdout: true })];
  const space = runner.loadFrozenSpace().space;
  const panel = adapter.buildPanel({ sources, space, segment: 'HOLDOUT', from: '2023-01-03', to: '2026-12-31' });
  const o = adapter.openDaysOf(sources);
  assert.equal(o.exchange, 'SSE');
  assert.equal(o.days.length, panel.manifest.calendar.open_days_in_sources);
  assert.equal(o.last_date, panel.manifest.calendar.last_date);
  assert.deepEqual(o.days, [...o.days].sort(), 'ascending');
  assert.ok(Number.isInteger(o.rows) && o.rows > 0);
});

test('RS1 resolveSegment R2: counts 54 open days after 2026-12-31 and records the window with the calendar it read and the dates it counted', () => {
  freshData();
  const rows = synthetic('2026-12-21', '2027-04-30');
  const { dir, bytes } = calendarDir(rows);
  const days = openDays(rows).filter((d) => d > '2026-12-31');
  const out = runner.resolveSegment({ segmentId: 'R2', dir, resolvedBy: 'TEST', resolvedAt: '2027-01-20T10:00:00+08:00' });
  assert.equal(out.status, 'RESOLVED');
  assert.equal(out.created, true);
  const rec = out.record;
  assert.equal(rec.schema, 'HOLDOUT_SEGMENT_RESOLUTION_V1');
  assert.deepEqual([rec.segment, rec.market], ['R2', 'CN_A']);
  assert.deepEqual(rec.window, { from: days[0], to: days[53], days: 54, days_sha256: sha(days.slice(0, 54).join('\n')) });
  assert.equal(rec.window.from, '2027-01-04', '2027-01-01 is closed in the synthetic calendar, 01-02 and 01-03 are a weekend');
  assert.deepEqual(rec.rule, { start_rule: 'FIRST_TRADING_DAY_AFTER', start_after: '2026-12-31', length_trading_days: 54, freeze: require('../services/mining-rounds/holdout-segments').REGISTRY[1].freeze });
  assert.deepEqual(rec.calendar.files, [{ name: 'trading_calendar.csv', sha256: sha(bytes) }]);
  assert.equal(rec.calendar.sums_sha256, sha(fs.readFileSync(path.join(dir, 'SHA256SUMS'))));
  assert.equal(rec.calendar.exchange, 'SSE');
  assert.equal(rec.calendar.last_date, '2027-04-30');
  assert.equal(rec.calendar.rows_read, rows.length * 2, 'SSE and SZSE rows');
  assert.deepEqual([rec.resolved_by, rec.resolved_at], ['TEST', '2027-01-20T10:00:00+08:00']);
  assert.equal(res().resolutionOf('R2').record_hash, rec.record_hash);
  assert.equal(ledger.read(res().LEDGER()).length, 1);
});

test('RS2 not ready: fewer than 54 listed open days after the start, or none after 2026-12-31 -> NOT_READY, no row', () => {
  freshData();
  const full = synthetic('2026-12-21', '2027-04-30'); const days = openDays(full).filter((d) => d > '2026-12-31');
  const short = calendarDir(full.filter((r) => r.date <= days[52]));
  const a = runner.resolveSegment({ segmentId: 'R2', dir: short.dir });
  assert.equal(a.status, 'NOT_READY');
  assert.match(a.reason, /53/);
  const none = calendarDir(synthetic('2026-11-02', '2026-12-31'));
  assert.equal(runner.resolveSegment({ segmentId: 'R2', dir: none.dir }).status, 'NOT_READY');
  assert.equal(res().resolutionOf('R2'), null);
  assert.equal(fs.existsSync(res().LEDGER()) ? ledger.read(res().LEDGER()).length : 0, 0);
});

test('RS3 idempotent: the second run returns the same record and writes nothing', () => {
  freshData();
  const { dir } = calendarDir(synthetic('2026-12-21', '2027-04-30'));
  const first = runner.resolveSegment({ segmentId: 'R2', dir, resolvedAt: '2027-01-20T10:00:00+08:00' });
  const again = runner.resolveSegment({ segmentId: 'R2', dir, resolvedAt: '2027-02-01T10:00:00+08:00' });
  assert.deepEqual([again.status, again.created, again.record.record_hash], ['RESOLVED', false, first.record.record_hash]);
  assert.equal(ledger.read(res().LEDGER()).length, 1);
});

test('RS4 the window never moves: a later calendar that counts different days is refused after a record exists', () => {
  freshData();
  const rows = synthetic('2026-12-21', '2027-04-30');
  runner.resolveSegment({ segmentId: 'R2', dir: calendarDir(rows).dir });
  const revised = rows.map((r) => (r.date === '2027-01-20' ? { ...r, sse: false } : r)); // the exchange closes a day inside the window
  assert.throws(() => runner.resolveSegment({ segmentId: 'R2', dir: calendarDir(revised).dir }), code(/MINE_SEGMENT_RESOLUTION_CONFLICT/));
  assert.equal(ledger.read(res().LEDGER()).length, 1);
  // the pure ledger rule too: a different window is refused, the same window is a no-op
  const rec = res().resolutionOf('R2');
  const { record_hash: _h, ...body } = rec;
  assert.equal(res().record({ ...body }).record_hash, rec.record_hash);
  assert.throws(() => res().record({ ...body, window: { ...body.window, to: addDays(body.window.to, 1) } }), code(/MINE_SEGMENT_RESOLUTION_CONFLICT/));
});

test('RS5 calendar facts: only SSE, only READY rows, the latest revision of a day wins', () => {
  freshData();
  const base = synthetic('2026-12-21', '2027-05-14');
  const days = openDays(base).filter((d) => d > '2026-12-31');
  const rows = base.map((r) => {
    if (r.date === days[3]) return { ...r, szse: true, sse: false }; // SZSE open, SSE closed: not an open day
    if (r.date === days[5]) return [r, { ...r, quality: 'DEGRADED', revision: 2, at: '2026-12-16 08:00:00+08', sse: false }]; // a non-READY row does not close it
    return r;
  }).flat();
  const closedLater = rows.map((r) => (r.date === days[7] ? { ...r } : r));
  closedLater.push({ date: days[7], sse: false, revision: 2, at: '2026-12-20 08:00:00+08' }); // revision 2 closes day 7
  const { dir } = calendarDir(closedLater);
  const out = runner.resolveSegment({ segmentId: 'R2', dir });
  const counted = openDays(base).filter((d) => d > '2026-12-31' && d !== days[3] && d !== days[7]);
  assert.equal(out.status, 'RESOLVED');
  assert.deepEqual([out.record.window.from, out.record.window.to], [counted[0], counted[53]]);
  assert.equal(out.record.window.days_sha256, sha(counted.slice(0, 54).join('\n')));
});

test('RS6 refusals: calendar file edited after SHA256SUMS, calendar not listed, a segment without a start rule, an unknown segment; nothing is written', () => {
  freshData();
  const rows = synthetic('2026-12-21', '2027-04-30');
  assert.throws(() => runner.resolveSegment({ segmentId: 'R2', dir: calendarDir(rows, { tamper: true }).dir }), code(/SHA256SUMS_MISMATCH/));
  assert.throws(() => runner.resolveSegment({ segmentId: 'R2', dir: calendarDir(rows, { listed: false }).dir }), code(/FILE_NOT_IN_SHA256SUMS/));
  const good = calendarDir(rows).dir;
  assert.throws(() => runner.resolveSegment({ segmentId: 'R1', dir: good }), code(/MINE_RUNNER_SEGMENT_NOT_RESOLVABLE/));
  assert.throws(() => runner.resolveSegment({ segmentId: 'R9', dir: good }), code(/MINE_RUNNER_SEGMENT_NOT_RESOLVABLE/));
  assert.throws(() => runner.resolveSegment({ segmentId: 'R2', dir: path.join(good, 'nope') }), /SOURCE_DIR/);
  assert.equal(res().resolutionOf('R2'), null);
});

test('RS7 windowOf(round): R1 and explicit windows from the manifest; R2 null until its record exists, then the recorded window and the record hash', () => {
  freshData();
  const mk = (at, holdout) => rounds.openRound({ market: 'CN_A', space: { space_ref: 'MS-WIN', sha256: sha(`win-${at}`), freeze: { path: 'f', sha256: sha('f') } }, holding_periods: [5], generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, ...(holdout ? { holdout } : {}), openedAt: at, ...R1 });
  const explicit = mk('2026-11-18T05:49:16+08:00', { from: '2026-10-19', to: '2026-12-31' });
  assert.deepEqual(res().windowOf(explicit), { from: '2026-10-19', to: '2026-12-31', segment: null, resolution_record_hash: null });
  rounds.failEvaluation(explicit.round_id, { reason: 'x', evidenceSha256: sha('e') });
  const dec = mk('2026-12-01T20:50:00+08:00');
  assert.equal(dec.holdout.segment, 'R2');
  assert.equal(res().windowOf(dec), null);
  const { dir } = calendarDir(synthetic('2026-12-21', '2027-04-30'));
  const r = runner.resolveSegment({ segmentId: 'R2', dir });
  assert.deepEqual(res().windowOf(dec), { from: r.record.window.from, to: r.record.window.to, segment: 'R2', resolution_record_hash: r.record.record_hash });
  assert.equal(res().windowOf({ holdout: { segment: 'R9', from: UNKNOWN, to: UNKNOWN } }), null);
});

test('RS8 record(): only registered rule-defined segments, a real 54-day window after the start rule, calendar evidence present', () => {
  freshData();
  const { dir } = calendarDir(synthetic('2026-12-21', '2027-04-30'));
  const ok = runner.resolveSegment({ segmentId: 'R2', dir }).record;
  const { record_hash: _h, ...body } = ok;
  // a fresh ledger for the negative cases
  for (const [label, patch] of [['segment R1', { segment: 'R1' }], ['segment R9', { segment: 'R9' }], ['window not dates', { window: { ...body.window, from: UNKNOWN } }],
    ['start not after the rule date', { window: { ...body.window, from: '2026-12-31' } }], ['wrong day count', { window: { ...body.window, days: 53 } }], ['from after to', { window: { ...body.window, from: '2027-05-01' } }],
    ['no calendar evidence', { calendar: undefined }], ['no files', { calendar: { ...body.calendar, files: [] } }], ['rule changed', { rule: { ...body.rule, length_trading_days: 55 } }]]) {
    freshData();
    assert.throws(() => res().record({ ...body, ...patch }), /MINE_SEGMENT_RESOLUTION_(INVALID|NOT_RESOLVABLE)/, label);
    assert.equal(fs.existsSync(res().LEDGER()) ? ledger.read(res().LEDGER()).length : 0, 0, label);
  }
});

test('RS9 seal-init-r2.sh: creates the pending seal directory once, prints the sha256 of SHA256SUMS.sealed, and a second run changes nothing', (t) => {
  const SH = path.join(ROOT, 'deploy/research-lane/round-runner/seal-init-r2.sh');
  if (spawnSync('sha256sum', ['--version']).status !== 0) { t.skip('no sha256sum on this host (the script runs on the Linux lane)'); return; }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-sealinit-'));
  const dir = path.join(parent, 'rf1116-cn-a-daily-holdout-r2');
  const run = () => spawnSync('bash', [SH, dir], { encoding: 'utf8' });
  const a = run();
  assert.equal(a.status, 0, a.stderr);
  const sealed = fs.readFileSync(path.join(dir, 'SHA256SUMS.sealed'));
  assert.equal(a.stdout.trim(), sha(sealed));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['SEAL_PENDING_V1.json', 'SHA256SUMS', 'SHA256SUMS.sealed']);
  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'SEAL_PENDING_V1.json'), 'utf8'));
  assert.deepEqual([pending.schema, pending.segment, pending.data, pending.start_rule, pending.start_after, pending.length_trading_days],
    ['HOLDOUT_SEAL_PENDING_V1', 'R2', 'NONE_AT_SEAL_TIME', 'FIRST_TRADING_DAY_AFTER', '2026-12-31', 54]);
  assert.match(pending.sealed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  assert.equal(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'), `${sha(fs.readFileSync(path.join(dir, 'SEAL_PENDING_V1.json')))}  SEAL_PENDING_V1.json\n`);
  assert.ok(sealed.equals(fs.readFileSync(path.join(dir, 'SHA256SUMS'))));
  const before = fs.readdirSync(dir).map((n) => [n, sha(fs.readFileSync(path.join(dir, n)))]);
  const b = run();
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout.trim(), a.stdout.trim(), 'the same sha again');
  assert.deepEqual(fs.readdirSync(dir).map((n) => [n, sha(fs.readFileSync(path.join(dir, n)))]), before, 'nothing rewritten');
  // a directory that exists but is not a seal-init directory is not touched
  const other = path.join(parent, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'x.csv'), 'x');
  const c = spawnSync('bash', [SH, other], { encoding: 'utf8' });
  assert.notEqual(c.status, 0);
  assert.deepEqual(fs.readdirSync(other), ['x.csv']);
});
