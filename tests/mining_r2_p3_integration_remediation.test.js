'use strict';

/** #157 P3 integration remediation V1. Synthetic files and stub-free fail-closed probes only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const arrival = () => require('../services/mining-sandbox/round-runner/arrival');
const adapter = () => require('../services/mining-sandbox/data-adapter');
const resolver = () => require('../services/mining-sandbox/round-runner/resolve-segment');
const trials = require('../services/trial-ledger');
const code = (re) => (error) => { assert.match(error.message, re); return true; };
const CAL_HEADER = 'calendar_date,market,exchange,is_open,previous_open_date,first_available_at,ingested_at,source_record_id,revision,schema_version,quality_state';
const cal = (days) => `${CAL_HEADER}\n${days.map((day) => `${day},A_SHARE,SSE,t,,2026-12-30 09:00:00+08,2026-12-30 12:00:00+08,cal:${day},1,synthetic-v1,READY`).join('\n')}\n`;

function writeSums(dir, names) {
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${names.map((name) => `${sha(fs.readFileSync(path.join(dir, name)))}  ${name}`).join('\n')}\n`);
}

test('P3R-1 four-digit parts are calendar-only; ordinary table parts remain YYYYMMDD', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3r-suffix-'));
  const header = 'record_id,security_id,trade_date,open,close';
  fs.writeFileSync(path.join(dir, 'prices_daily_stock.csv'), `${header}\np0,S0.SH,2027-01-04,1,2\n`);
  fs.writeFileSync(path.join(dir, 'prices_daily_stock_0001.csv'), `${header}\np1,S1.SH,2027-01-05,1,2\n`);
  writeSums(dir, ['prices_daily_stock.csv', 'prices_daily_stock_0001.csv']);
  const rows = [];
  adapter().csvDirSource(dir, { mode: 'LIVE', label: 'suffix' }).forEach('prices', (row) => rows.push(row.record_id));
  assert.deepEqual(rows, ['p0'], 'a calendar sequence suffix must not make an ordinary table part readable');
});

function sealedDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3r-hold-'));
  const pending = `${JSON.stringify({ schema: 'HOLDOUT_SEAL_PENDING_V1', segment: 'R2', data: 'NONE_AT_SEAL_TIME', sealed_at: '2026-12-31T20:00:00+08:00' })}\n`;
  fs.writeFileSync(path.join(dir, 'SEAL_PENDING_V1.json'), pending);
  const sums = `${sha(pending)}  SEAL_PENDING_V1.json\n`;
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.sealed'), sums);
  return dir;
}

function calendarRoot(bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3r-drop-'));
  fs.writeFileSync(path.join(root, 'trading_calendar.csv'), bytes);
  return root;
}

function twoCalendarRows() {
  const dir = sealedDir();
  const first = calendarRoot(cal(['2027-01-04']));
  const second = calendarRoot(cal(['2027-01-04', '2027-01-05']));
  arrival().arrive({ dir, source: arrival().csvDayDropSource(first), arrivedAt: '2027-01-04T20:00:00+08:00' });
  arrival().arrive({ dir, source: arrival().csvDayDropSource(second), arrivedAt: '2027-01-04T20:01:00+08:00' });
  return { dir, second };
}

test('P3R-2 a torn calendar-delta row is re-appended instead of leaving its part unchained', () => {
  const { dir, second } = twoCalendarRows();
  const chainFile = path.join(dir, arrival().CHAIN_FILE);
  const bytes = fs.readFileSync(chainFile);
  const last = bytes.lastIndexOf(10, bytes.length - 2);
  fs.writeFileSync(chainFile, bytes.subarray(0, last + 29));
  const result = arrival().arrive({ dir, source: arrival().csvDayDropSource(second), arrivedAt: '2027-01-04T20:02:00+08:00' });
  assert.deepEqual([result.status, result.kind, result.seq], ['ARRIVED', 'CALENDAR', 1]);
  assert.doesNotThrow(() => arrival().verifyChain(dir));
});

const PROBE_SHA = '57e26c0379ad86008fdea0f035108104761434dfc009dc80d358987a6fddb582';
const DAY_TABLES = {
  prices_daily_stock: 'record_id,security_id,trade_date,open,close\np,S1.SH,2027-01-04,1,2\n',
  market_daily_basic_observation_stock: 'record_id,security_id,trade_date,values\nb,S1.SH,2027-01-04,{}\n',
  adjustment_factor_observation_stock: 'record_id,security_id,trade_date,adjustment_factor\na,S1.SH,2027-01-04,1\n',
  security_master_stock: 'record_id,security_id,business_date,ticker\nm,S1.SH,2027-01-04,S1\n',
  security_suspension_observation: 'record_id,security_id,trade_date,suspension_type\n',
  security_suspension_day_coverage: 'coverage_id,trade_date,provider_row_count\nc,2027-01-04,1\n',
  industry_membership_sw2021: 'record_id,security_id,industry_standard,industry_level,first_available_at\n',
};

function validDayRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3r-day-'));
  const dir = path.join(root, '20270104'); fs.mkdirSync(dir);
  for (const [stem, bytes] of Object.entries(DAY_TABLES)) fs.writeFileSync(path.join(dir, `${stem}.csv`), bytes);
  fs.writeFileSync(path.join(dir, 'READINESS.json'), `${JSON.stringify({ schema: 'R2_DAY_EXPORT_READINESS_RECORD_V1', trade_date: '2027-01-04', probe_sha256: PROBE_SHA, ready_via: 'POST_CLOSE_D', n_prices: 5000, n_basic: 5000, n_adj: 5000, n_cov: 1, probed_at: '2027-01-04T16:00:00+08:00', window_from: '2027-01-01T00:00:00+08:00', window_to: '2027-01-05T09:00:00+08:00' })}\n`);
  const names = [...Object.keys(DAY_TABLES).map((stem) => `${stem}.csv`), 'READINESS.json'];
  writeSums(dir, names);
  return { root, dir };
}

test('P3R-3 the day directory, manifest, and every listed file are no-follow regular files', () => {
  const { root, dir } = validDayRoot();
  const sums = path.join(dir, 'SHA256SUMS');
  const external = path.join(root, 'external-sums'); fs.copyFileSync(sums, external);
  fs.unlinkSync(sums); fs.symlinkSync(external, sums);
  assert.equal(arrival().csvDayDropSource(root).day('2027-01-04'), null);

  const linked = validDayRoot();
  const linkedFile = path.join(linked.dir, 'prices_daily_stock.csv');
  const externalFile = path.join(linked.root, 'external-prices.csv'); fs.copyFileSync(linkedFile, externalFile);
  fs.unlinkSync(linkedFile); fs.symlinkSync(externalFile, linkedFile);
  assert.equal(arrival().csvDayDropSource(linked.root).day('2027-01-04'), null);

  const fifo = validDayRoot();
  const fifoFile = path.join(fifo.dir, 'prices_daily_stock.csv'); fs.unlinkSync(fifoFile);
  assert.equal(spawnSync('mkfifo', [fifoFile]).status, 0);
  assert.equal(arrival().csvDayDropSource(fifo.root).day('2027-01-04'), null);

  const aliased = validDayRoot();
  const dayLink = path.join(aliased.root, '20270105'); fs.symlinkSync(aliased.dir, dayLink);
  assert.equal(arrival().csvDayDropSource(aliased.root).day('2027-01-05'), null);
});

test('P3R-4 a bad prior state refuses before truncating a torn chain fragment', () => {
  const { dir, second } = twoCalendarRows();
  fs.appendFileSync(path.join(dir, 'trading_calendar.csv'), 'tampered\n');
  const chainFile = path.join(dir, arrival().CHAIN_FILE);
  const full = fs.readFileSync(chainFile); const last = full.lastIndexOf(10, full.length - 2);
  const torn = full.subarray(0, last + 29); fs.writeFileSync(chainFile, torn);
  assert.throws(() => arrival().arrive({ dir, source: arrival().csvDayDropSource(second), arrivedAt: '2027-01-04T20:02:00+08:00' }), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID/));
  assert.deepEqual(fs.readFileSync(chainFile), torn, 'refusal must preserve the forensic torn bytes');
});

test('P3R-5 a byte-identical readiness probe whose relative name starts with dash is hashed as a file', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3r-probe-'));
  fs.copyFileSync(path.join(ROOT, 'deploy/research-lane/r2-day-export/R2_DAY_EXPORT_READINESS_V2.sql'), path.join(cwd, '-probe.sql'));
  const env = { ...process.env, R2EXP_ENV_FILE: '/nonexistent', R2EXP_PG_CONTAINER: 'pg', R2EXP_PG_USER: 'reader', R2EXP_PG_DB: 'v6', R2EXP_DROP_ROOT: path.join(cwd, 'drop'), R2EXP_READY_SQL: '-probe.sql', R2EXP_TEST: '1', R2EXP_NOW: '2026-11-23T12:00:00+08:00' };
  const result = spawnSync('bash', [path.join(ROOT, 'deploy/research-lane/r2-day-export/r2-day-export.sh'), '--segment', 'R1'], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OUTSIDE_SLOT/);
});

test('R2R-1 the resolver records four-digit calendar sequence parts that contributed to the window', () => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'TEST_P3_REMEDIATION_V2';
  process.env.QRP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3r2-ledger-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3r2-resolve-'));
  const days = Array.from({ length: 54 }, (_, i) => new Date(Date.UTC(2027, 0, 4 + i)).toISOString().slice(0, 10));
  fs.writeFileSync(path.join(dir, 'trading_calendar.csv'), cal(days.slice(0, 27)));
  fs.writeFileSync(path.join(dir, 'trading_calendar_0001.csv'), cal(days.slice(27)));
  writeSums(dir, ['trading_calendar.csv', 'trading_calendar_0001.csv']);
  const result = resolver().resolveSegment({ segmentId: 'R2', dir, resolvedBy: 'TEST', resolvedAt: '2027-03-01T10:00:00+08:00' });
  assert.equal(result.status, 'RESOLVED');
  assert.deepEqual(result.record.calendar.files.map((file) => file.name), ['trading_calendar.csv', 'trading_calendar_0001.csv']);
});

function tornAfterPrefixMutation(mutate) {
  const { dir, second } = twoCalendarRows();
  const chainFile = path.join(dir, arrival().CHAIN_FILE);
  const rows = fs.readFileSync(chainFile, 'utf8').trimEnd().split('\n').map(JSON.parse);
  const body = { ...rows[0] }; delete body.record_hash;
  mutate(body);
  rows[0] = { ...body, record_hash: trials.recordHash(body) };
  const next = { ...rows[1], prev_hash: rows[0].record_hash }; delete next.record_hash;
  rows[1] = { ...next, record_hash: trials.recordHash(next) };
  const torn = Buffer.from(`${JSON.stringify(rows[0])}\n${JSON.stringify(rows[1]).slice(0, 29)}`);
  fs.writeFileSync(chainFile, torn);
  return { dir, second, chainFile, torn };
}

test('R2R-2 a semantically invalid but re-hashed prefix is refused before a torn tail is truncated', () => {
  const { dir, second, chainFile, torn } = tornAfterPrefixMutation((row) => { row.segment = 'R9'; });
  assert.throws(() => arrival().arrive({ dir, source: arrival().csvDayDropSource(second), arrivedAt: '2027-01-04T20:02:00+08:00' }), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID/));
  assert.deepEqual(fs.readFileSync(chainFile), torn, 'semantic refusal must preserve the forensic torn bytes');
});

test('R2R-3 a rename-away, substitute, and restore race cannot supply day-drop child bytes', () => {
  const original = validDayRoot();
  const substitute = validDayRoot();
  const substitutedPrices = Buffer.from(DAY_TABLES.prices_daily_stock.replace('p,S1.SH', 'attacker,S9.SH'));
  fs.writeFileSync(path.join(substitute.dir, 'prices_daily_stock.csv'), substitutedPrices);
  writeSums(substitute.dir, [...Object.keys(DAY_TABLES).map((stem) => `${stem}.csv`), 'READINESS.json']);
  const held = `${original.dir}.held`;
  const displaced = `${original.dir}.substitute`;
  const realReaddir = fs.readdirSync;
  const realOpen = fs.openSync;
  let swapped = false;
  fs.readdirSync = function patchedReaddir(target, ...args) {
    const listed = realReaddir.call(this, target, ...args);
    if (!swapped && target === original.dir) {
      fs.renameSync(original.dir, held);
      fs.renameSync(substitute.dir, original.dir);
      swapped = true;
    }
    return listed;
  };
  fs.openSync = function patchedOpen(target, ...args) {
    const fd = realOpen.call(this, target, ...args);
    if (swapped && target === path.join(original.dir, 'READINESS.json')) {
      fs.renameSync(original.dir, displaced);
      fs.renameSync(held, original.dir);
      swapped = false;
    }
    return fd;
  };
  try {
    assert.equal(arrival().csvDayDropSource(original.root).day('2027-01-04'), null);
  } finally {
    fs.readdirSync = realReaddir;
    fs.openSync = realOpen;
    if (swapped) {
      fs.renameSync(original.dir, displaced);
      fs.renameSync(held, original.dir);
    }
  }
});
