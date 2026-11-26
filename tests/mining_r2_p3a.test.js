'use strict';

/**
 * #157 P3A independent regression tests (brief items 1-6, 10 and 12).
 * Synthetic data only. This file intentionally does not reuse the broad R2 fixture so each
 * escaped condition has one small, deterministic reproducer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'services/mining-sandbox/round-runner/cli.js');
const PROBE_SHA = '57e26c0379ad86008fdea0f035108104761434dfc009dc80d358987a6fddb582';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const arrival = () => require('../services/mining-sandbox/round-runner/arrival');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const compact = (d) => d.replace(/-/g, '');

const TABLES = Object.freeze({
  prices_daily_stock: ['record_id,security_id,trade_date,open,close', (d) => `p1,S1.SH,${d},10,11`],
  market_daily_basic_observation_stock: ['record_id,security_id,trade_date,values', (d) => `b1,S1.SH,${d},"{""pb"":1}"`],
  adjustment_factor_observation_stock: ['record_id,security_id,trade_date,adjustment_factor', (d) => `a1,S1.SH,${d},1`],
  security_master_stock: ['record_id,security_id,business_date,ticker', (d) => `m1,S1.SH,${d},S1`],
  security_suspension_observation: ['record_id,security_id,trade_date,suspension_type', () => null],
  security_suspension_day_coverage: ['coverage_id,trade_date,provider_row_count', (d) => `c1,${d},1`],
  industry_membership_sw2021: ['record_id,security_id,industry_standard,industry_level,first_available_at', () => 'i1,S1.SH,SW2021,L1,2027-01-01T00:00:00+08:00'],
});
const CAL_HEADER = 'calendar_date,market,exchange,is_open,previous_open_date,first_available_at,ingested_at,source_record_id,revision,schema_version,quality_state';
const calRow = (date, { ingested = '2026-12-30 12:00:00+08', revision = 1, quality = 'READY', open = true } = {}) =>
  [date, 'A_SHARE', 'SSE', open ? 't' : 'f', '', '2026-12-30 09:00:00+08', ingested, `cal:${date}:${revision}`, revision, 'synthetic-v1', quality].join(',');
const calendar = (dates, opts = {}) => `${CAL_HEADER}\n${dates.map((d) => calRow(d, opts[d] || {})).join('\n')}\n`;

function readiness(day, next = '2027-01-05') {
  return `${JSON.stringify({
    schema: 'R2_DAY_EXPORT_READINESS_RECORD_V1', trade_date: day, probe_sha256: PROBE_SHA, ready_via: 'POST_CLOSE_D',
    n_prices: 5000, n_basic: 5000, n_adj: 5000, n_cov: 1, probed_at: `${day}T16:00:00+08:00`,
    window_from: '2027-01-01T00:00:00+08:00', window_to: `${next}T09:00:00+08:00`,
  })}\n`;
}

function writeDay(root, day) {
  const dir = path.join(root, compact(day));
  fs.mkdirSync(dir);
  for (const [stem, [header, rowOf]] of Object.entries(TABLES)) {
    const row = rowOf(day);
    fs.writeFileSync(path.join(dir, `${stem}.csv`), `${header}\n${row === null ? '' : `${row}\n`}`);
  }
  fs.writeFileSync(path.join(dir, 'READINESS.json'), readiness(day));
  const names = [...Object.keys(TABLES).map((s) => `${s}.csv`), 'READINESS.json'];
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${names.map((n) => `${sha(fs.readFileSync(path.join(dir, n)))}  ${n}`).join('\n')}\n`);
  return dir;
}

function dropRoot(cal, days = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3a-drop-'));
  fs.writeFileSync(path.join(root, 'trading_calendar.csv'), cal);
  for (const d of days) writeDay(root, d);
  return root;
}

function sealedDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3a-hold-'));
  const pending = `${JSON.stringify({ schema: 'HOLDOUT_SEAL_PENDING_V1', segment: 'R2', data: 'NONE_AT_SEAL_TIME', sealed_at: '2026-12-31T20:00:00+08:00' })}\n`;
  fs.writeFileSync(path.join(dir, 'SEAL_PENDING_V1.json'), pending);
  const sums = `${sha(pending)}  SEAL_PENDING_V1.json\n`;
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.sealed'), sums);
  return dir;
}

const chainFile = (dir) => path.join(dir, 'ARRIVAL_CHAIN_V1.jsonl');
const chain = (dir) => fs.readFileSync(chainFile(dir), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
function writeRechained(dir, mutate) {
  const ledger = require('../services/trial-ledger');
  let prev = null;
  const rows = chain(dir).map((row, i) => {
    const body = { ...row }; delete body.record_hash;
    mutate(body, i);
    body.seq = i; body.prev_hash = prev;
    const rec = { ...body, record_hash: ledger.recordHash(body) };
    prev = rec.record_hash;
    return rec;
  });
  fs.writeFileSync(chainFile(dir), `${rows.map(JSON.stringify).join('\n')}\n`);
}
function validDayDir() {
  const dir = sealedDir();
  const root = dropRoot(calendar(['2026-12-31', '2027-01-04', '2027-01-05'], { '2026-12-31': { open: false } }), ['2027-01-04']);
  arrival().arrive({ dir, source: arrival().csvDayDropSource(root), arrivedAt: '2027-01-04T20:00:00+08:00' });
  arrival().arrive({ dir, source: arrival().csvDayDropSource(root), arrivedAt: '2027-01-04T20:01:00+08:00' });
  return { dir, root };
}

test('P3A-1 verifier requires CSV_DAY_DROP, non-null readiness and the pinned V2 probe sha', () => {
  const { dir } = validDayDir();
  writeRechained(dir, (r) => { if (r.kind === 'DAY') { r.source = { driver: 'MANUAL' }; r.readiness = null; } });
  assert.throws(() => arrival().verifyChain(dir), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:SCHEMA/));

  const valid = validDayDir().dir;
  writeRechained(valid, (r) => { if (r.kind === 'DAY') r.readiness.probe_sha256 = '0'.repeat(64); });
  assert.throws(() => arrival().verifyChain(valid), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:SCHEMA/));
});

test('P3A-2 only a final non-newline unparsable chain fragment heals; mid-file corruption remains invalid', () => {
  for (const keep of [7, 41]) {
    const { dir, root } = validDayDir();
    const bytes = fs.readFileSync(chainFile(dir));
    const priorNewline = bytes.lastIndexOf(10, bytes.length - 2);
    fs.writeFileSync(chainFile(dir), bytes.subarray(0, priorNewline + 1 + keep));
    const out = arrival().arrive({ dir, source: arrival().csvDayDropSource(root), arrivedAt: '2027-01-04T21:00:00+08:00' });
    assert.deepEqual([out.status, out.kind, out.day], ['ARRIVED', 'DAY', '2027-01-04']);
    assert.equal(chain(dir).length, 2);
    assert.doesNotThrow(() => arrival().verifyChain(dir));
  }

  const firstDir = sealedDir();
  const firstRoot = dropRoot(calendar(['2026-12-31', '2027-01-04'], { '2026-12-31': { open: false } }));
  arrival().arrive({ dir: firstDir, source: arrival().csvDayDropSource(firstRoot), arrivedAt: '2027-01-04T19:00:00+08:00' });
  fs.writeFileSync(chainFile(firstDir), fs.readFileSync(chainFile(firstDir)).subarray(0, 29));
  assert.equal(arrival().arrive({ dir: firstDir, source: arrival().csvDayDropSource(firstRoot), arrivedAt: '2027-01-04T19:01:00+08:00' }).kind, 'CALENDAR');
  assert.equal(chain(firstDir).length, 1, 'the torn first commit heals from the empty prior chain state');

  const { dir, root } = validDayDir();
  const lines = fs.readFileSync(chainFile(dir), 'utf8').split('\n');
  lines[0] = lines[0].slice(0, 12);
  fs.writeFileSync(chainFile(dir), lines.join('\n'));
  assert.throws(() => arrival().arrive({ dir, source: arrival().csvDayDropSource(root) }), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:PARSE/));
});

test('P3A-3 calendar deltas use sequence names and ignore an ingested_at-only change', () => {
  const dir = sealedDir();
  const c1 = calendar(['2026-12-31', '2027-01-04'], { '2026-12-31': { open: false } });
  const c2 = calendar(['2026-12-31', '2027-01-04', '2027-01-05'], { '2026-12-31': { open: false } });
  const c3 = calendar(['2026-12-31', '2027-01-04', '2027-01-05', '2027-01-06'], { '2026-12-31': { open: false } });
  arrival().arrive({ dir, source: arrival().csvDayDropSource(dropRoot(c1)), arrivedAt: '2027-01-04T20:00:00+08:00' });
  arrival().arrive({ dir, source: arrival().csvDayDropSource(dropRoot(c2)), arrivedAt: '2027-01-04T20:01:00+08:00' });
  arrival().arrive({ dir, source: arrival().csvDayDropSource(dropRoot(c3)), arrivedAt: '2027-01-04T20:02:00+08:00' });
  assert.deepEqual(chain(dir).map((r) => r.files[0].name), ['trading_calendar.csv', 'trading_calendar_0001.csv', 'trading_calendar_0002.csv']);

  const onlyIngest = sealedDir();
  arrival().arrive({ dir: onlyIngest, source: arrival().csvDayDropSource(dropRoot(c1)), arrivedAt: '2027-01-04T20:00:00+08:00' });
  const changed = calendar(['2026-12-31', '2027-01-04'], {
    '2026-12-31': { open: false, ingested: '2027-01-04 19:00:00+08' },
    '2027-01-04': { ingested: '2027-01-04 19:00:00+08' },
  });
  const out = arrival().arrive({ dir: onlyIngest, source: arrival().csvDayDropSource(dropRoot(changed)), arrivedAt: '2027-01-04T20:03:00+08:00' });
  assert.equal(out.status, 'NOT_AVAILABLE');
  assert.equal(chain(onlyIngest).length, 1, 'ingested_at alone is not a semantic calendar delta');
});

test('P3A-4 CSV_DAY_DROP refuses a tampered, incompletely listed, or extra per-day file', () => {
  const day = '2027-01-04';
  const root = dropRoot(calendar([day]), [day]);
  const src = arrival().csvDayDropSource(root);
  assert.ok(src.day(day));
  fs.appendFileSync(path.join(root, compact(day), 'prices_daily_stock.csv'), 'tampered\n');
  assert.equal(src.day(day), null);

  const unlisted = dropRoot(calendar([day]), [day]);
  fs.writeFileSync(path.join(unlisted, compact(day), 'EXTRA.csv'), 'x\n');
  assert.equal(arrival().csvDayDropSource(unlisted).day(day), null);

  const missing = dropRoot(calendar([day]), [day]);
  const sf = path.join(missing, compact(day), 'SHA256SUMS');
  fs.writeFileSync(sf, fs.readFileSync(sf, 'utf8').split('\n').filter((l) => !l.endsWith('READINESS.json')).join('\n'));
  assert.equal(arrival().csvDayDropSource(missing).day(day), null);
});

test('P3A-5 calendar_date and arrived-at are validated before either can influence a path', () => {
  const adapter = require('../services/mining-sandbox/data-adapter');
  const source = {
    has: (name) => name === 'calendar',
    forEach: (_name, cb) => cb({ calendar_date: '../outside', market: 'A_SHARE', exchange: 'SSE', is_open: 't', first_available_at: '2027-01-01 08:00:00+08', revision: 1, quality_state: 'READY' }),
  };
  assert.throws(() => adapter.openDaysOf([source]), code(/MINE_DATA_CALENDAR_DATE_INVALID/));

  const dir = sealedDir(); const root = dropRoot(calendar(['2027-01-04']));
  const before = fs.readdirSync(dir).sort();
  assert.throws(() => arrival().arrive({ dir, source: arrival().csvDayDropSource(root), arrivedAt: '2027-01-04/../../escape' }), code(/MINE_RUNNER_ARRIVE_ARRIVED_AT/));
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'invalid timestamp writes no arrival file');
});

test('P3A-6 arrive-check missing SHA256SUMS is an error, and unknown windows carry explicit null fields', () => {
  const cleanEnv = require('./_clean_env');
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3a-nosums-'));
  const env = { ...cleanEnv(), QRP_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3a-ledger-')) };
  const p = spawnSync(process.execPath, [CLI, 'holdout-arrive', '--segment', 'R1', '--holdout', bad, '--check-complete', 'true'], { encoding: 'utf8', env });
  assert.equal(p.status, 2, `${p.stdout}\n${p.stderr}`);
  assert.ok(JSON.parse(p.stderr).error, 'exit 2 carries an error JSON document');

  process.env.QRP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3a-window-ledger-'));
  const cli = require('../services/mining-sandbox/round-runner/cli');
  const unknown = cli.main(['holdout-arrive', '--segment', 'R2', '--holdout', sealedDir(), '--check-complete', 'true']);
  assert.deepEqual(unknown, { command: 'holdout-arrive', segment: 'R2', status: 'WINDOW_END_UNKNOWN', window_end: null, last_day: null, missing: [] });
});

test('P3A-10 calendar SQL selects READY first, then latest first_available_at, then revision', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'deploy/research-lane/r2-day-export/sql/trading_calendar.sql'), 'utf8');
  assert.match(sql, /quality_state\s*=\s*'READY'/i);
  assert.match(sql, /ORDER BY\s+calendar_date,\s*exchange,\s*first_available_at\s+DESC,\s*revision\s+DESC/i);

  // Minimal deterministic SQL stub: the newest revision is not READY, so the exported row must
  // instead be the READY row with the latest availability timestamp.
  const rows = [
    { quality_state: 'READY', first_available_at: '2027-01-01T08:00:00Z', revision: 1 },
    { quality_state: 'READY', first_available_at: '2027-01-01T09:00:00Z', revision: 1 },
    { quality_state: 'CONFLICT', first_available_at: '2027-01-01T10:00:00Z', revision: 9 },
  ];
  const selected = rows.filter((r) => r.quality_state === 'READY').sort((a, b) => b.first_available_at.localeCompare(a.first_available_at) || b.revision - a.revision)[0];
  assert.deepEqual(selected, rows[1]);
});

test('P3A-12 industry manifest counts deduplicate the same canonical membership across sources', () => {
  const { makeMiningDataFixture } = require('./_mining_data_fixture');
  const adapter = require('../services/mining-sandbox/data-adapter');
  const space = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json'), 'utf8'));
  const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3a-industry-')), { stocks: 1, industryQuality: 'READY' });
  const panel = () => adapter.buildPanel({
    sources: [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })],
    space, segment: 'MINING', from: '2021-04-01', to: '2021-04-30',
  });
  const before = panel();
  const name = 'industry_membership_sw2021.csv';
  fs.copyFileSync(path.join(fx.dirs.tail, name), path.join(fx.dirs.lane, name));
  const sumsFile = path.join(fx.dirs.lane, 'SHA256SUMS');
  const lines = fs.readFileSync(sumsFile, 'utf8').split('\n').filter(Boolean).filter((l) => !l.endsWith(name));
  lines.push(`${sha(fs.readFileSync(path.join(fx.dirs.lane, name)))}  ${name}`);
  fs.writeFileSync(sumsFile, `${lines.join('\n')}\n`);
  const overlapped = panel();
  assert.ok(before.manifest.counts.industry.rows > 0);
  assert.equal(overlapped.manifest.counts.industry.rows, before.manifest.counts.industry.rows);
  assert.deepEqual(overlapped.manifest.counts.industry.by_quality, before.manifest.counts.industry.by_quality);
});
