'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const code = (re) => (error) => { assert.match(error.message, re); return true; };
const freshData = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3b-data-'));
  process.env.QRP_DATA_DIR = dir;
  return dir;
};

test('P3B-7 resolutionOf refuses a ledger row whose canonical record hash does not match', () => {
  freshData();
  const resolution = require('../services/mining-rounds/segment-resolution');
  const ledger = require('../packages/ledger');
  const body = {
    schema: 'HOLDOUT_SEGMENT_RESOLUTION_V1', segment: 'R2', market: 'CN_A',
    rule: { start_rule: 'FIRST_TRADING_DAY_AFTER', start_after: '2026-12-31', length_trading_days: 54 },
    calendar: { exchange: 'SSE', files: [{ name: 'trading_calendar.csv', sha256: sha('calendar') }], sums_sha256: sha('sums'), rows_read: 108, last_date: '2027-04-30' },
    window: { from: '2027-01-04', to: '2027-03-18', days: 54, days_sha256: sha('days') },
    resolved_at: '2027-01-20T10:00:00+08:00', resolved_by: 'TEST',
  };
  ledger.append(resolution.LEDGER(), { ...body, record_hash: sha('forged') });
  assert.throws(() => resolution.resolutionOf('R2'), code(/MINE_SEGMENT_RESOLUTION_INVALID:record_hash/));
});

test('P3B-7 holdout check refuses a calendar revision whose in-window open-day hash differs from the resolution record', () => {
  freshData();
  const { makeMiningDataFixture } = require('./_mining_data_fixture');
  const adapter = require('../services/mining-sandbox/data-adapter');
  const runner = require('../services/mining-sandbox/round-runner');
  const resolution = require('../services/mining-rounds/segment-resolution');
  const ledger = require('../packages/ledger');
  const trials = require('../services/trial-ledger');

  const fixture = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3b-calendar-')));
  const dir = fixture.dirs.holdout;
  const original = adapter.openDaysOf([adapter.csvDirSource(dir, { mode: 'LIVE', label: 'holdout', holdout: true })]).days;
  const from = original[1];
  const to = original[original.length - 2];
  const counted = original.filter((day) => day >= from && day <= to);
  const body = {
    schema: 'HOLDOUT_SEGMENT_RESOLUTION_V1', segment: 'R2', market: 'CN_A',
    rule: { start_rule: 'FIRST_TRADING_DAY_AFTER', start_after: '2026-12-31', length_trading_days: counted.length },
    calendar: { exchange: 'SSE', files: [{ name: 'trading_calendar.csv', sha256: sha('original-calendar') }], sums_sha256: sha('original-sums'), rows_read: 1, last_date: to },
    window: { from, to, days: counted.length, days_sha256: sha(counted.join('\n')) },
    resolved_at: '2027-01-20T10:00:00+08:00', resolved_by: 'TEST',
  };
  ledger.append(resolution.LEDGER(), { ...body, record_hash: trials.recordHash(body) });

  const calendarFile = path.join(dir, 'trading_calendar.csv');
  const rows = fs.readFileSync(calendarFile, 'utf8').trimEnd().split('\n').map((line) => line.split(','));
  const columns = rows[0];
  const dateColumn = columns.indexOf('calendar_date');
  const exchangeColumn = columns.indexOf('exchange');
  const openColumn = columns.indexOf('is_open');
  const changedDay = counted[Math.floor(counted.length / 2)];
  const changed = rows.find((row, index) => index > 0 && row[dateColumn] === changedDay && row[exchangeColumn] === 'SSE' && row[openColumn] === 't');
  assert.ok(changed, `fixture has an open SSE row for ${changedDay}`);
  changed[openColumn] = 'f';
  const calendarBytes = `${rows.map((row) => row.join(',')).join('\n')}\n`;
  fs.writeFileSync(calendarFile, calendarBytes);
  const sumsFile = path.join(dir, 'SHA256SUMS');
  const sums = fs.readFileSync(sumsFile, 'utf8').split('\n').map((line) => (line.endsWith('  trading_calendar.csv') ? `${sha(calendarBytes)}  trading_calendar.csv` : line)).join('\n');
  fs.writeFileSync(sumsFile, sums);

  const seal = { data_sha256: sha(fs.readFileSync(sumsFile)), segment: { from, to } };
  assert.throws(() => runner.holdoutDirCheck(dir, seal, { minNamesPerDay: 1, segment: 'R2' }), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:calendar_changed/));
});

test('P3B-8 top-level deferred-seal anchor is derived from all per-file bases and reports MIXED', () => {
  const { anchorLabelOf } = require('../services/mining-sandbox/round-runner').internals;
  assert.equal(anchorLabelOf(
    { prices: { anchor_basis: 'R1_OPEN_RECORD' }, basic: { anchor_basis: 'OWN_DAYS_MEDIAN' } },
    { prices: { anchor_basis: 'R1_OPEN_RECORD' } },
    { pb: { anchor_basis: 'R1_OPEN_RECORD' } },
  ), 'MIXED');
  assert.equal(anchorLabelOf({ prices: { anchor_basis: 'R1_OPEN_RECORD' } }, {}, {}), 'R1_OPEN_RECORD');
  assert.equal(anchorLabelOf({ prices: { anchor_basis: 'OWN_DAYS_MEDIAN' } }, {}, {}), 'OWN_DAYS_MEDIAN');
});

function runnerSandbox(startedAt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3b-runsh-'));
  const lane = path.join(root, 'lane');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'docker.log');
  fs.mkdirSync(bin);
  for (const dir of ['holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019', 'holdout-sealed/rf1116-cn-a-daily-holdout-r2', 'out', 'data']) fs.mkdirSync(path.join(lane, dir), { recursive: true });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
echo "$*" >> "${log}"
case "$1" in
  ps) printf 'rf1116-holdout-arrive\\n';;
  inspect) printf '%s\\n' "$STUB_STARTED_AT";;
  *) exit 0;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RF1116_RUNNER_IMAGE: 'qrp:test', RF1116_LANE_FOR_TESTS: lane, STUB_STARTED_AT: startedAt };
  const result = spawnSync('bash', [path.join(ROOT, 'deploy/research-lane/round-runner/run.sh'), 'score', 'R'], { env, encoding: 'utf8' });
  return { result, calls: fs.readFileSync(log, 'utf8') };
}

test('P3B-13 an arrival container older than 60 minutes is an alerting exit 76 and is never killed', () => {
  const { result, calls } = runnerSandbox('2000-01-01T00:00:00.000000000Z');
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stderr, /HOLDOUT_ARRIVAL_STUCK/);
  assert.match(result.stderr, /alert/i);
  assert.match(calls, /inspect/);
  assert.doesNotMatch(calls, /^(kill|stop|rm|restart)\b/m);
});
