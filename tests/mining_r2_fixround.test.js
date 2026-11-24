'use strict';
/**
 * QRP #157 review fix round (plan-coord 2026-11-23, independent review QRP157_SCORER_REVIEW_20261123.md). Red first.
 *   FX1  concurrent arrivals: an exclusive lock per directory (two arrivals at once: one refuses, the chain stays valid; JS never takes over an existing lock; the lock is released on success and on error)
 *   FX2  at-rest modes: nothing the arrival writes is group- or world-readable; seal-init-r2.sh makes a 0700 directory
 *   FX3  chain anchor: the chain head is written to a lane ledger after each arrival; a rollback, a consistent rewrite of the last day and a rewrite of an earlier day with re-chained successors are refused
 *   FX4  gate wiring: score/rescore CLI maps --require-arrival-chain to requireChain (end to end), run.sh passes the flag in BOTH branches (the old regex ran past the end of the branch)
 *   FX5  R1 before R2 (strict gate): an R2 score is refused until an R1 round of the market has an open row (or every R1 round is terminal); the prior-live (R1) directory's chain is verified
 *   FX7  run.sh: arrive and score/rescore exclude each other (HOLDOUT_ARRIVAL_IN_PROGRESS / HOLDOUT_SCORE_IN_PROGRESS), fail closed when docker ps fails
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const A = () => require('../services/mining-sandbox/round-runner/arrival');
const ARR = path.join(ROOT, 'services/mining-sandbox/round-runner/arrival.js');
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const range = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const OPEN = range('2026-12-21', '2027-02-26').filter((d) => weekday(d) !== 0 && weekday(d) !== 6 && d !== '2027-01-01');
const DAYS = OPEN.filter((d) => d > '2026-12-31');
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
const nextOpenOf = (day) => OPEN.find((d) => d > day) || addDays(day, 3);
const windowOfDay = (day) => ({ window_from: day === DAYS[0] ? '2027-01-01T00:00:00+08:00' : `${day}T09:00:00+08:00`, window_to: `${nextOpenOf(day)}T09:00:00+08:00` });
const readinessOf = (day) => ({ schema: 'R2_DAY_EXPORT_READINESS_RECORD_V1', trade_date: day, probe_sha256: sha('probe-v2'), ready_via: 'POST_CLOSE_D', n_prices: 5260, n_basic: 5217, n_adj: 5229, n_cov: 1, probed_at: `${day}T16:00:00+08:00`, ...windowOfDay(day) });
function dayTexts(day) {
  const ids = ['S01.SH', 'S02.SH', 'S03.SH']; const csv = (stem, lines) => `${HEADERS[stem]}\n${lines.length ? `${lines.join('\n')}\n` : ''}`;
  return {
    prices_daily_stock: csv('prices_daily_stock', ids.map((s) => `pd:${s}:${day},${s},${day},1.5,2.5`)),
    market_daily_basic_observation_stock: csv('market_daily_basic_observation_stock', ids.map((s) => `db:${s}:${day},dbr:${s},${s},${day},"{""pe"": 1}"`)),
    adjustment_factor_observation_stock: csv('adjustment_factor_observation_stock', ids.map((s) => `af:${s}:${day},afr:${s},${s},${day},1`)),
    security_master_stock: csv('security_master_stock', ids.map((s) => `sm:${s}:${day},${s},${day},${s}`)),
    security_suspension_observation: csv('security_suspension_observation', []),
    security_suspension_day_coverage: csv('security_suspension_day_coverage', [`cv:${day},${day},3`]),
    industry_membership_sw2021: csv('industry_membership_sw2021', []),
  };
}
function dropRoot(days, { calendar = calendarCsv() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fx-drop-'));
  fs.writeFileSync(path.join(root, 'trading_calendar.csv'), calendar);
  for (const day of days) {
    const dir = path.join(root, compact(day)); fs.mkdirSync(dir);
    for (const [stem, text] of Object.entries(dayTexts(day))) fs.writeFileSync(path.join(dir, `${stem}.csv`), text);
    fs.writeFileSync(path.join(dir, 'READINESS.json'), `${JSON.stringify(readinessOf(day))}\n`);
  }
  return root;
}
function sealedDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fx-r2-'));
  const pending = `${JSON.stringify({ schema: 'HOLDOUT_SEAL_PENDING_V1', segment: 'R2', data: 'NONE_AT_SEAL_TIME', sealed_at: '2026-12-01T20:50:00+08:00' })}\n`;
  fs.writeFileSync(path.join(dir, 'SEAL_PENDING_V1.json'), pending);
  const line = `${sha(pending)}  SEAL_PENDING_V1.json\n`;
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), line); fs.writeFileSync(path.join(dir, 'SHA256SUMS.sealed'), line);
  return dir;
}
const chainOf = (dir) => fs.readFileSync(path.join(dir, 'ARRIVAL_CHAIN_V1.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
function drain(dir, source, o = {}) { const out = []; for (let i = 0; i < 100; i += 1) { const r = A().arrive({ dir, source, arrivedAt: '2027-03-01T20:30:00+08:00', ...o }); out.push(r.status); if (r.status !== 'ARRIVED') return out; } throw new Error('no stop'); }
const rechain = (d, f) => { const t = require('../services/trial-ledger'); let prev = null; const re = f(chainOf(d)).map((r, i) => { const body = { ...r, seq: i, prev_hash: prev }; delete body.record_hash; const rec = { ...body, record_hash: t.recordHash(body) }; prev = rec.record_hash; return rec; }); fs.writeFileSync(path.join(d, 'ARRIVAL_CHAIN_V1.jsonl'), `${re.map((r) => JSON.stringify(r)).join('\n')}\n`); };

/** Runs ONE arrive step in a child process (the way two containers would): prints the result JSON, or the error on stderr with exit 1. */
function childArrive(dir, root, env = {}) {
  const script = path.join(os.tmpdir(), `qrp-fx-arrive-${process.pid}.js`);
  fs.writeFileSync(script, `const a = require(${JSON.stringify(ARR)}); try { const r = a.arrive({ dir: process.argv[2], source: a.csvDayDropSource(process.argv[3]), arrivedAt: '2027-03-01T20:30:00+08:00' }); process.stdout.write(JSON.stringify(r)); } catch (e) { process.stderr.write(e.message); process.exitCode = 1; }`);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, dir, root], { env: { ...require('./_clean_env')(), ...env } });
    let out = ''; let err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => resolve({ status: c, out, err }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('FX1 concurrent arrivals: an exclusive lock per directory. Two arrivals at once: one refuses (MINE_RUNNER_ARRIVE_LOCKED), the chain stays valid and the next run continues; JS refuses every existing lock; the lock is released on success and on error', async () => {
  const dir = sealedDir(); const root = dropRoot(DAYS.slice(0, 4));
  const first = childArrive(dir, root, { QRP_ARRIVE_TEST_HOLD_MS: '1500' });
  await sleep(500);
  const second = await childArrive(dir, root);
  assert.notEqual(second.status, 0); assert.match(second.err, /MINE_RUNNER_ARRIVE_LOCKED/);
  const one = await first; assert.equal(one.status, 0, one.err);
  assert.equal(JSON.parse(one.out).status, 'ARRIVED');
  assert.equal(A().verifyChain(dir).rows, 1);
  assert.equal(fs.existsSync(path.join(dir, A().LOCK_FILE)), false, 'released after success');
  drain(dir, A().csvDayDropSource(root));
  assert.equal(A().verifyChain(dir).days.length, 4, 'the chain continues and is valid');
  // a burst of six arrivals at once: every one either arrives or is refused LOCKED; the chain is valid, one row per step
  const dir2 = sealedDir(); const root2 = dropRoot(DAYS.slice(0, 5));
  const res = await Promise.all([1, 2, 3, 4, 5, 6].map(() => childArrive(dir2, root2, { QRP_ARRIVE_TEST_HOLD_MS: '200' })));
  for (const r of res) assert.ok(r.status === 0 || /MINE_RUNNER_ARRIVE_LOCKED/.test(r.err), r.err);
  assert.ok(res.some((r) => r.status === 0));
  assert.doesNotThrow(() => A().verifyChain(dir2));
  // lock states
  const dir3 = sealedDir(); const src3 = A().csvDayDropSource(dropRoot(DAYS.slice(0, 2)));
  const lock = path.join(dir3, A().LOCK_FILE);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  assert.throws(() => A().arrive({ dir: dir3, source: src3 }), code(/MINE_RUNNER_ARRIVE_LOCKED/), 'a fresh lock is respected');
  const old = new Date(Date.now() - 3 * 3600e3); fs.utimesSync(lock, old, old);
  assert.throws(() => A().arrive({ dir: dir3, source: src3 }), code(/MINE_RUNNER_ARRIVE_LOCKED/), 'JS never removes an existing lock, including a stale one');
  assert.equal(fs.existsSync(lock), true);
  fs.rmSync(lock);
  assert.throws(() => A().arrive({ dir: dir3, source: src3, day: DAYS[3] }), code(/MINE_RUNNER_ARRIVE_ORDER|NOT_OPEN_DAY/));
  assert.equal(fs.existsSync(lock), false, 'released on error');
  assert.ok(A().LOCK_STALE_MS >= 15 * 60e3 && A().LOCK_STALE_MS <= 6 * 3600e3);
});

test('FX1b stale locks: JS never takes over; run.sh removes an old lock only after docker ps proves no arrival container, then starts exactly one arrival', async () => {
  const dir = sealedDir(); const root = dropRoot(DAYS.slice(0, 3));
  const script = path.join(os.tmpdir(), `qrp-fx-arrive-kill-${process.pid}.js`);
  fs.writeFileSync(script, `const a = require(${JSON.stringify(ARR)}); a.arrive({ dir: process.argv[2], source: a.csvDayDropSource(process.argv[3]), arrivedAt: '2027-03-01T20:30:00+08:00' });`);
  const victim = spawn(process.execPath, [script, dir, root], { env: { ...require('./_clean_env')(), QRP_ARRIVE_TEST_HOLD_MS: '8000' } });
  await sleep(800); victim.kill('SIGKILL'); await new Promise((r) => victim.on('close', r));
  const lock = path.join(dir, A().LOCK_FILE);
  assert.ok(fs.existsSync(lock), 'a killed arrival cannot release its lock');
  assert.throws(() => A().arrive({ dir, source: A().csvDayDropSource(root) }), code(/MINE_RUNNER_ARRIVE_LOCKED/), 'fresh: refused for a bounded time');
  assert.ok(A().LOCK_STALE_MS <= 30 * 60e3, 'the bound is at most 30 minutes');
  // run.sh: the same lock file in the holdout directory blocks score only while it is fresh (exit 75), the container is gone (docker ps lists nothing)
  const s = runShSandbox();
  fs.copyFileSync(lock, path.join(s.holdout('R1'), '.arrival.lock'));
  const blocked = s.run(['score', 'R']); assert.equal(blocked.status, 75); assert.match(blocked.err, /HOLDOUT_ARRIVAL_IN_PROGRESS/);
  const old = new Date(Date.now() - (A().LOCK_STALE_MS + 60e3)); fs.utimesSync(lock, old, old); fs.utimesSync(path.join(s.holdout('R1'), '.arrival.lock'), old, old);
  const free = s.run(['score', 'R']); assert.equal(free.status, 0, free.err); assert.equal(runs(s.calls()).length, 1);
  assert.throws(() => A().arrive({ dir, source: A().csvDayDropSource(root) }), code(/MINE_RUNNER_ARRIVE_LOCKED/), 'library callers cannot perform a racy takeover');
  const staleRun = runShSandbox(); const staleRunLock = path.join(staleRun.holdout('R1'), '.arrival.lock'); fs.writeFileSync(staleRunLock, '{}'); fs.utimesSync(staleRunLock, old, old);
  const recovered = staleRun.run(['arrive']); assert.equal(recovered.status, 0, recovered.err); assert.equal(fs.existsSync(staleRunLock), false, 'run.sh removed the stale lock before starting the container');
  const active = runShSandbox({ ps: 'rf1116-holdout-arrive\n' }); const activeLock = path.join(active.holdout('R1'), '.arrival.lock'); fs.writeFileSync(activeLock, '{}'); fs.utimesSync(activeLock, old, old);
  const refused = active.run(['arrive']); assert.equal(refused.status, 75); assert.equal(fs.existsSync(activeLock), true, 'an active arrival owns even an old lock');
  // the documented bound
  const doc = fs.readFileSync(path.join(ROOT, 'deploy/research-lane/round-runner/DEPLOY.md'), 'utf8');
  assert.match(doc, /a lock older than 30 minutes[^\n]*(taken over|stale)/i);
});

test('FX2 at rest: nothing the arrival writes is group- or world-readable (files 0600), even under umask 022; seal-init-r2.sh makes a 0700 directory with no group/world bits on its files', () => {
  const prior = process.umask(0o022);
  try {
    const dir = sealedDir(); fs.chmodSync(dir, 0o700);
    drain(dir, A().csvDayDropSource(dropRoot(DAYS.slice(0, 2))));
    const written = fs.readdirSync(dir).filter((n) => !['SEAL_PENDING_V1.json', 'SHA256SUMS.sealed'].includes(n));
    assert.ok(written.length > 15);
    for (const n of written) assert.equal(fs.statSync(path.join(dir, n)).mode & 0o077, 0, `${n}: mode ${(fs.statSync(path.join(dir, n)).mode & 0o777).toString(8)}`);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'the directory mode is the operator\'s, not changed');
  } finally { process.umask(prior); }
  const sh = path.join(ROOT, 'deploy/research-lane/round-runner/seal-init-r2.sh');
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fx-seal-')), 'rf1116-cn-a-daily-holdout-r2');
  const r = spawnSync('bash', [sh, target], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Shanghai' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(target).mode & 0o777, 0o700);
  for (const n of fs.readdirSync(target)) assert.equal(fs.statSync(path.join(target, n)).mode & 0o077, 0, n);
});

// ── FX3 ──────────────────────────────────────────────────────────────────────────────────────
const ANCH = () => require('../services/mining-rounds/arrival-anchor');
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fx-data-')); process.env.QRP_DATA_DIR = d; return d; };
const anchorOf = (dir) => { const rows = chainOf(dir); const h = rows[rows.length - 1]; return { seq: h.seq, record_hash: h.record_hash }; };

test('FX3a anchor ledger: HOLDOUT_ARRIVAL_ANCHOR_V1 rows (segment, seq, record_hash, last_day), append-only, idempotent for the same row, refused below the last anchor or with another hash at an anchored seq', () => {
  freshData();
  const an = ANCH();
  assert.deepEqual(an.anchorsOf('R2'), []);
  const h1 = sha('h1'); const h2 = sha('h2'); const h3 = sha('h3');
  const r1 = an.record({ segment: 'R2', seq: 3, recordHash: h1, lastDay: '2027-01-06', anchoredBy: 'TEST' });
  assert.equal(r1.schema, 'HOLDOUT_ARRIVAL_ANCHOR_V1');
  assert.equal(an.record({ segment: 'R2', seq: 3, recordHash: h1, lastDay: '2027-01-06', anchoredBy: 'TEST' }).record_hash, r1.record_hash, 'the same anchor again is a no-op');
  assert.equal(an.anchorsOf('R2').length, 1);
  an.record({ segment: 'R2', seq: 5, recordHash: h2, lastDay: '2027-01-08', anchoredBy: 'TEST' });
  assert.throws(() => an.record({ segment: 'R2', seq: 4, recordHash: h3, lastDay: '2027-01-07', anchoredBy: 'TEST' }), code(/MINE_ANCHOR_BELOW_LAST/));
  assert.throws(() => an.record({ segment: 'R2', seq: 3, recordHash: h3, lastDay: '2027-01-06', anchoredBy: 'TEST' }), code(/MINE_ANCHOR_CONFLICT/));
  assert.throws(() => an.record({ segment: 'R9', seq: 1, recordHash: h1, lastDay: null, anchoredBy: 'TEST' }), code(/MINE_ANCHOR_SEGMENT/));
  assert.throws(() => an.record({ segment: 'R2', seq: 6, recordHash: 'nothex', lastDay: null, anchoredBy: 'TEST' }), code(/MINE_ANCHOR_INVALID/));
  assert.deepEqual(an.anchorsOf('R2').map((r) => r.seq), [3, 5]);
  assert.deepEqual(an.anchorsOf('R1'), [], 'per segment');
  assert.ok(an.LEDGER().endsWith('holdout_arrival_anchors.jsonl'));
});

test('FX3b verifyChain with anchors: a rolled-back last day (ROLLBACK), a consistent rewrite of the last day (REWRITE), a rewrite of an earlier day with every later row re-chained (REWRITE) are refused; an unanchored head is UNANCHORED in strict mode; arrive refuses the same', () => {
  const build = () => { const d = sealedDir(); drain(d, A().csvDayDropSource(dropRoot(DAYS.slice(0, 5)))); return d; };
  const good = build(); const anchors = [anchorOf(good)];
  assert.doesNotThrow(() => A().verifyChain(good, { anchors }));
  assert.equal(A().verifyChain(good, { anchors }).head_seq, 5);
  // last day rolled back completely: row, SUMS lines, files
  const rolled = build(); const rolledAnchors = [anchorOf(rolled)];
  const last = chainOf(rolled).pop();
  fs.writeFileSync(path.join(rolled, 'ARRIVAL_CHAIN_V1.jsonl'), `${chainOf(rolled).slice(0, -1).map((r) => JSON.stringify(r)).join('\n')}\n`);
  for (const f of last.files) fs.rmSync(path.join(rolled, f.name));
  fs.writeFileSync(path.join(rolled, 'SHA256SUMS'), fs.readFileSync(path.join(rolled, 'SHA256SUMS'), 'utf8').split('\n').filter((l) => l && !last.files.some((f) => l.endsWith(`  ${f.name}`))).join('\n') + '\n');
  assert.doesNotThrow(() => A().verifyChain(rolled), 'without an anchor the rollback is not visible (the review\'s probe P2)');
  assert.throws(() => A().verifyChain(rolled, { anchors: rolledAnchors }), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:ROLLBACK/));
  // consistent rewrite of the last day: file, SUMS line, row sha, record hash
  const rew = build(); const rewAnchors = [anchorOf(rew)];
  const lastRow = chainOf(rew).pop(); const prices = lastRow.files.find((f) => f.name.startsWith('prices_daily_stock_'));
  const forged = `${fs.readFileSync(path.join(rew, prices.name), 'utf8')}pd:S99:x,S99.SH,${lastRow.trade_date},9,9\n`;
  fs.writeFileSync(path.join(rew, prices.name), forged);
  fs.writeFileSync(path.join(rew, 'SHA256SUMS'), fs.readFileSync(path.join(rew, 'SHA256SUMS'), 'utf8').split('\n').map((l) => (l.endsWith(`  ${prices.name}`) ? `${sha(forged)}  ${prices.name}` : l)).join('\n'));
  rechain(rew, (rs) => rs.map((r) => (r.seq === lastRow.seq ? { ...r, files: r.files.map((f) => (f.name === prices.name ? { ...f, sha256: sha(forged) } : f)) } : r)));
  assert.doesNotThrow(() => A().verifyChain(rew), 'consistent: only the anchor can tell');
  assert.throws(() => A().verifyChain(rew, { anchors: rewAnchors }), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:REWRITE/));
  // an earlier day rewritten and every later row re-chained
  const early = build(); const earlyAnchors = [anchorOf(early)];
  const row2 = chainOf(early)[2]; const p2 = row2.files.find((f) => f.name.startsWith('prices_daily_stock_'));
  const forged2 = `${fs.readFileSync(path.join(early, p2.name), 'utf8')}pd:S98:x,S98.SH,${row2.trade_date},9,9\n`;
  fs.writeFileSync(path.join(early, p2.name), forged2);
  fs.writeFileSync(path.join(early, 'SHA256SUMS'), fs.readFileSync(path.join(early, 'SHA256SUMS'), 'utf8').split('\n').map((l) => (l.endsWith(`  ${p2.name}`) ? `${sha(forged2)}  ${p2.name}` : l)).join('\n'));
  rechain(early, (rs) => rs.map((r) => (r.seq === 2 ? { ...r, files: r.files.map((f) => (f.name === p2.name ? { ...f, sha256: sha(forged2) } : f)) } : r)));
  assert.doesNotThrow(() => A().verifyChain(early));
  assert.throws(() => A().verifyChain(early, { anchors: earlyAnchors }), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:REWRITE/));
  // an anchor in the middle is checked too
  const mid = build(); const midAnchors = [{ seq: 2, record_hash: chainOf(mid)[2].record_hash }, anchorOf(mid)];
  assert.doesNotThrow(() => A().verifyChain(mid, { anchors: midAnchors }));
  assert.throws(() => A().verifyChain(mid, { anchors: [{ seq: 2, record_hash: sha('not the row') }, anchorOf(mid)] }), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:REWRITE/), 'every anchor is checked, not only the last');
  // strict: rows beyond the last anchor = UNANCHORED (the anchor step has not run for them yet)
  assert.throws(() => A().verifyChain(good, { anchors: [{ seq: 3, record_hash: chainOf(good)[3].record_hash }], requireAnchor: true }), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:UNANCHORED/));
  assert.throws(() => A().verifyChain(good, { anchors: [], requireAnchor: true }), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:UNANCHORED/), 'a chain with no anchor at all');
  assert.doesNotThrow(() => A().verifyChain(good, { anchors, requireAnchor: true }));
  // arrive verifies against the anchors before it appends
  const src = A().csvDayDropSource(dropRoot(DAYS.slice(0, 7)));
  assert.throws(() => A().arrive({ dir: rolled, source: src, anchors: rolledAnchors }), code(/ROLLBACK/));
  // the anchors are checked BEFORE the calendar step writes anything: a rolled-back chain and a source whose calendar has new rows leave the directory untouched
  const listing = (d) => Object.fromEntries(fs.readdirSync(d).sort().map((n) => [n, sha(fs.readFileSync(path.join(d, n)))]));
  const before = listing(rolled);
  assert.throws(() => A().arrive({ dir: rolled, source: A().csvDayDropSource(dropRoot(DAYS.slice(0, 7), { calendar: calendarCsv('2027-03-05') })), anchors: rolledAnchors }), code(/ROLLBACK/));
  assert.deepEqual(listing(rolled), before, 'nothing written (no calendar part, no lock left)');
  assert.throws(() => A().arrive({ dir: rew, source: src, anchors: rewAnchors }), code(/REWRITE/));
  assert.equal(A().arrive({ dir: good, source: src, anchors }).status, 'ARRIVED');
  assert.equal(A().arrive({ dir: good, source: src, anchors }).seq, 7, 'the old anchor is below the new head: fine');
});

test('FX3c holdout-anchor CLI and run.sh: arrive prints the chain head (chain_seq, chain_head, last_day); `holdout-anchor` writes it to the lane ledger from a container that holds only the ledger (no holdout directory); run.sh arrive runs the two steps; arrive-check and arrive verify against the anchors', () => {
  const cli = require('../services/mining-sandbox/round-runner/cli');
  assert.ok(cli.OPTIONS['holdout-anchor'] && ['out', 'segment', 'arrival-json'].every((o) => cli.OPTIONS['holdout-anchor'].includes(o)));
  freshData();
  const dir = sealedDir(); const root = dropRoot(DAYS.slice(0, 3));
  const out = cli.main(['holdout-arrive', '--segment', 'R2', '--holdout', dir, '--driver', 'csv-day-drop', '--source', root]);
  assert.equal(out.chain_seq, 3); assert.match(out.chain_head, /^[0-9a-f]{64}$/); assert.equal(out.last_day, DAYS[2]);
  // `holdout-anchor` as the lane runs it: its own process (the runner locks writes to --out), the ledger under <out>/qrp-data
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fx-anchor-out-')); fs.mkdirSync(path.join(outDir, 'qrp-data'));
  const CLI = path.join(ROOT, 'services/mining-sandbox/round-runner/cli.js');
  const anchorCli = (args) => { const r = spawnSync(process.execPath, [CLI, 'holdout-anchor', '--out', outDir, ...args], { encoding: 'utf8', env: { ...require('./_clean_env')(), QRP_DATA_DIR: path.join(outDir, 'qrp-data'), QRP_PRODUCT_MILESTONE_AUTHORITY: 'TEST_FIXROUND' } }); return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr }; };
  const a1 = anchorCli(['--segment', 'R2', '--arrival-json', JSON.stringify(out)]);
  assert.equal(a1.status, 0, a1.err);
  assert.deepEqual([a1.out.command, a1.out.status, a1.out.seq, a1.out.record_hash], ['holdout-anchor', 'ANCHORED', 3, out.chain_head]);
  assert.equal(anchorCli(['--segment', 'R2', '--arrival-json', JSON.stringify(out)]).out.status, 'ALREADY_ANCHORED');
  const wrongSeg = anchorCli(['--segment', 'R1', '--arrival-json', JSON.stringify(out)]); assert.equal(wrongSeg.status, 2); assert.match(wrongSeg.err, /MINE_RUNNER_ANCHOR_SEGMENT/);
  assert.equal(anchorCli(['--segment', 'R2', '--arrival-json', JSON.stringify({ command: 'holdout-arrive', segment: 'R2', chain_seq: null, chain_head: null, last_day: null })]).out.status, 'NOTHING_TO_ANCHOR');
  const ledgerRows = fs.readFileSync(path.join(outDir, 'qrp-data/research/holdout_arrival_anchors.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual([ledgerRows.length, ledgerRows[0].schema, ledgerRows[0].seq, ledgerRows[0].chain_record_hash, ledgerRows[0].last_day], [1, 'HOLDOUT_ARRIVAL_ANCHOR_V1', 3, out.chain_head, DAYS[2]]);
  process.env.QRP_DATA_DIR = path.join(outDir, 'qrp-data'); // the anchors now exist: arrive reads them
  // check-complete and arrive read the anchors
  const rolled = chainOf(dir).slice(0, -1); fs.writeFileSync(path.join(dir, 'ARRIVAL_CHAIN_V1.jsonl'), `${rolled.map((r) => JSON.stringify(r)).join('\n')}\n`);
  assert.throws(() => cli.main(['holdout-arrive', '--segment', 'R2', '--holdout', dir, '--driver', 'csv-day-drop', '--source', root]), code(/ROLLBACK|UNCHAINED/));
  assert.throws(() => cli.main(['holdout-arrive', '--segment', 'R2', '--holdout', dir, '--check-complete', 'true']), code(/ROLLBACK/), 'arrive-check refuses a rolled-back chain too');
  const sh = fs.readFileSync(path.join(ROOT, 'deploy/research-lane/round-runner/run.sh'), 'utf8');
  const block = (name) => sh.split(new RegExp(`^  ${name}\\)\\n`, 'm'))[1].split(/^    ;;$/m)[0];
  const arriveBlock = block('arrive\\|r2-arrive');
  assert.match(arriveBlock, /rf1116-holdout-arrive"/); assert.match(arriveBlock, /rf1116-holdout-anchor"/);
  const anchorLine = arriveBlock.split('\n').find((l) => l.includes('--name "rf1116-holdout-anchor"'));
  for (const f of ['--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 1000:1000', '-v "$OUT:/out:rw"', 'holdout-anchor --out /out --segment']) assert.ok(anchorLine.includes(f), f);
  assert.ok(!anchorLine.includes('/data/holdout') && !anchorLine.includes('DAYDROP'), 'the anchor container sees no holdout data');
  assert.match(block('arrive-check'), /--user 0:0/, 'arrive-check reads the 0700 directory as its owner');
  assert.match(block('arrive-check'), /-v "\$OUT:\/out:ro"/);
});

// ── FX7 run.sh exclusion (behavioural, stub docker) ───────────────────────────────────────────
function runShSandbox({ ps = '', psFail = false, arriveOut = null, arriveRc = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fx-runsh-'));
  const lane = path.join(root, 'lane'); const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  for (const d of ['holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019', 'holdout-sealed/rf1116-cn-a-daily-holdout-r2', 'out', 'data', 'holdout-daydrop/R1', 'holdout-daydrop/R2']) fs.mkdirSync(path.join(lane, d), { recursive: true });
  const log = path.join(root, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
echo "$*" >> "${log}"
case "$1" in
  ps) [ -n "$STUB_PS_FAIL" ] && exit 1; printf '%s' "$STUB_PS"; exit 0;;
  run) case "$*" in *holdout-arrive\\ *|*"--name rf1116-holdout-arrive "*) [ -n "$STUB_ARRIVE_OUT" ] && echo "$STUB_ARRIVE_OUT"; exit \${STUB_ARRIVE_RC:-0};; esac; exit 0;;
esac
exit 0
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RF1116_RUNNER_IMAGE: 'qrp-round-runner:test', RF1116_LANE_FOR_TESTS: lane, STUB_PS: ps, STUB_PS_FAIL: psFail ? '1' : '', STUB_ARRIVE_OUT: arriveOut || '', STUB_ARRIVE_RC: String(arriveRc), DOCKER_HOST: 'unix:///nonexistent' };
  const run = (args, extra = {}) => { const r = spawnSync('bash', [path.join(ROOT, 'deploy/research-lane/round-runner/run.sh'), ...args], { env: { ...env, ...extra }, encoding: 'utf8' }); return { status: r.status, out: r.stdout, err: r.stderr }; };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { lane, run, calls, holdout: (seg = 'R1') => path.join(lane, seg === 'R1' ? 'holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019' : 'holdout-sealed/rf1116-cn-a-daily-holdout-r2') };
}
const runs = (calls) => calls.filter((c) => c.startsWith('run '));

test('FX7 run.sh: arrive and score/rescore exclude each other (the lock file and the containers); a docker ps that fails stops everything (exit 74); a stale lock does not block', () => {
  const crash = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fx-crash-')), 'crash.log'); fs.writeFileSync(crash, 'test crash\n');
  // score / rescore refuse while an arrival holds the lock or its container runs
  for (const cmd of [['score', 'R'], ['rescore', 'R', 'reason', crash]]) {
    const lock = runShSandbox(); fs.writeFileSync(path.join(lock.holdout('R1'), '.arrival.lock'), '{}');
    const a = lock.run(cmd); assert.equal(a.status, 75, a.err); assert.match(a.err, /HOLDOUT_ARRIVAL_IN_PROGRESS/); assert.equal(runs(lock.calls()).length, 0, `${cmd[0]}: docker run not called`);
    const ctr = runShSandbox({ ps: 'rf1116-holdout-arrive\n' });
    const b = ctr.run(cmd); assert.equal(b.status, 75, b.err); assert.match(b.err, /HOLDOUT_ARRIVAL_IN_PROGRESS/); assert.equal(runs(ctr.calls()).length, 0);
    const stale = runShSandbox(); const lf = path.join(stale.holdout('R1'), '.arrival.lock'); fs.writeFileSync(lf, '{}'); const old = new Date(Date.now() - 3 * 3600e3); fs.utimesSync(lf, old, old);
    const c = stale.run(cmd); assert.equal(c.status, 0, c.err); assert.equal(runs(stale.calls()).length, 1, 'a stale lock does not block');
    const fail = runShSandbox({ psFail: true });
    const d = fail.run(cmd); assert.equal(d.status, 74, d.err); assert.equal(runs(fail.calls()).length, 0, 'unreadable docker ps is not "nothing running"');
  }
  // the lock of the OTHER segment does not block this one
  const seg = runShSandbox(); fs.writeFileSync(path.join(seg.holdout('R2'), '.arrival.lock'), '{}');
  assert.equal(seg.run(['score', 'R']).status, 0, 'an R2 arrival does not block an R1 score');
  const seg2 = runShSandbox(); fs.writeFileSync(path.join(seg2.holdout('R2'), '.arrival.lock'), '{}');
  assert.equal(seg2.run(['score', 'R'], { RF1116_HOLDOUT_SEGMENT: 'R2' }).status, 75, 'but it blocks an R2 score');
  // arrive refuses while a score or rescore container runs
  for (const names of ['rf1116-score\n', 'rf1116-rescore\n']) {
    const s = runShSandbox({ ps: names }); const r = s.run(['arrive']);
    assert.equal(r.status, 75, r.err); assert.match(r.err, /HOLDOUT_SCORE_IN_PROGRESS/); assert.equal(runs(s.calls()).length, 0);
  }
  const f2 = runShSandbox({ psFail: true }); assert.equal(f2.run(['arrive']).status, 74);
  for (const names of ['rf1116-holdout-arrive\n', 'rf1116-score\n', 'rf1116-rescore\n']) {
    const s = runShSandbox({ ps: names }); const r = s.run(['resolve-segment'], { RF1116_HOLDOUT_SEGMENT: 'R2' });
    assert.equal(r.status, 75, `${names.trim()}: ${r.err}`); assert.equal(runs(s.calls()).length, 0, 'resolver must not race arrival or scoring');
  }
  // arrive: step 1 (writer) then step 2 (anchor) with step 1's JSON; a failed step 1 is not anchored
  const head = JSON.stringify({ command: 'holdout-arrive', segment: 'R1', status: 'NOT_AVAILABLE', arrived: ['2026-11-18'], last_day: '2026-11-18', chain_seq: 0, chain_head: sha('h') });
  const ok = runShSandbox({ arriveOut: head }); const r1 = ok.run(['arrive']);
  assert.equal(r1.status, 0, r1.err);
  const rr = runs(ok.calls()); assert.equal(rr.length, 2);
  assert.ok(rr[0].includes('--name rf1116-holdout-arrive ') && rr[0].includes('holdout-arrive --segment R1'));
  assert.ok(rr[1].includes('--name rf1116-holdout-anchor ') && rr[1].includes('holdout-anchor --out /out --segment R1 --arrival-json') && rr[1].includes(sha('h')));
  assert.match(r1.out, /"chain_head"/, 'run.sh prints the arrival JSON');
  const bad = runShSandbox({ arriveOut: head, arriveRc: 2 }); const r2 = bad.run(['arrive']);
  assert.equal(r2.status, 2); assert.equal(runs(bad.calls()).length, 1, 'no anchor after a failed arrival');
});

test('FX8 resolve-segment on the 0700 R2 directory: run.sh opens ONLY names plus calendar bytes (directory 0755, calendar/SHA 0644), traps before opening, and closes again on failure', () => {
  const s = runShSandbox();
  const dir = s.holdout('R2');
  fs.chmodSync(dir, 0o700);
  for (const n of ['trading_calendar.csv', 'trading_calendar_20270110.csv', 'SHA256SUMS', 'prices_daily_stock_20270104.csv', 'SEAL_PENDING_V1.json']) { fs.writeFileSync(path.join(dir, n), 'x\n'); fs.chmodSync(path.join(dir, n), 0o600); }
  const watch = path.join(s.lane, 'watch.log');
  const stubDocker = path.join(s.lane, '..', 'bin', 'docker');
  fs.writeFileSync(stubDocker, `#!/bin/bash
case "$1" in
  ps) exit 0;;
  run) mode=$(stat -c %a "${dir}" 2>/dev/null || stat -f %Lp "${dir}"); [ $((8#$mode & 0044)) -eq 0044 ] || { echo "opendir: EACCES" >&2; exit 13; }; for p in "${dir}" "${dir}"/*; do m=$(stat -c %a "$p" 2>/dev/null || stat -f %Lp "$p"); echo "$m $(basename "$p")" >> "${watch}"; done; exit \${STUB_RC:-0};;
esac
exit 0
`, { mode: 0o755 });
  const modes = () => Object.fromEntries(fs.readdirSync(dir).map((n) => [n, (fs.statSync(path.join(dir, n)).mode & 0o777).toString(8)]));
  const r = s.run(['resolve-segment'], { RF1116_HOLDOUT_SEGMENT: 'R2' });
  assert.equal(r.status, 0, r.err);
  const seen = fs.readFileSync(watch, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' '));
  const at = (name) => seen.find((x) => x[1] === name)[0];
  assert.equal(at(path.basename(dir)), '755');
  assert.equal(at('trading_calendar.csv'), '644'); assert.equal(at('trading_calendar_20270110.csv'), '644'); assert.equal(at('SHA256SUMS'), '644');
  assert.equal(at('prices_daily_stock_20270104.csv'), '600', 'a data file is never opened'); assert.equal(at('SEAL_PENDING_V1.json'), '600');
  const after = modes();
  assert.equal((fs.statSync(dir).mode & 0o777).toString(8), '700');
  assert.deepEqual(after, { 'trading_calendar.csv': '600', 'trading_calendar_20270110.csv': '600', SHA256SUMS: '600', 'prices_daily_stock_20270104.csv': '600', 'SEAL_PENDING_V1.json': '600' });
  // a failing container: closed again
  const bad = s.run(['resolve-segment'], { RF1116_HOLDOUT_SEGMENT: 'R2', STUB_RC: '3' });
  assert.equal(bad.status, 3);
  assert.equal((fs.statSync(dir).mode & 0o777).toString(8), '700');
  assert.equal(modes().SHA256SUMS, '600');
});

// ── FX4 gate wiring ──────────────────────────────────────────────────────────────────────────
test('FX4 gate wiring: CLI defaults fail closed, explicit false is the hand-export opt-out, and run.sh passes true in BOTH branches', () => {
  const runner = require('../services/mining-sandbox/round-runner');
  const cli = require('../services/mining-sandbox/round-runner/cli');
  const fx = require('./_mining_data_fixture').makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fx-mfx-')));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fx-cli-'));
  process.env.QRP_DATA_DIR = path.join(out, 'qrp-data'); fs.mkdirSync(process.env.QRP_DATA_DIR, { recursive: true });
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'TEST_FIXROUND';
  const lane = fx.dirs.lane; const tail = fx.dirs.tail; const hold = fx.dirs.holdout;
  const origScore = runner.scoreHoldout; const origRescore = runner.rescore; let seen = null;
  try {
    runner.scoreHoldout = (o) => { seen = o; throw new Error('STOP_SCORE'); };
    runner.rescore = (o) => { seen = o; throw new Error('STOP_RESCORE'); };
    const base = ['--out', out, '--round', 'R', '--lane', lane, '--tail', tail, '--holdout', hold];
    for (const [flag, want] of [[['--require-arrival-chain', 'true'], true], [[], true], [['--require-arrival-chain', 'false'], false]]) {
      seen = null; assert.throws(() => cli.main(['score', ...base, ...flag]), /STOP_SCORE/); assert.equal(seen.requireChain, want, `score ${flag.join(' ')}`);
      seen = null; assert.throws(() => cli.main(['rescore', ...base, '--reason', 'x', '--crash-log', path.join(out, 'crash.log'), ...flag]), /STOP_RESCORE|ENOENT/);
    }
    fs.writeFileSync(path.join(out, 'crash.log'), 'x');
    for (const [flag, want] of [[['--require-arrival-chain', 'true'], true], [[], true], [['--require-arrival-chain', 'false'], false]]) {
      seen = null; assert.throws(() => cli.main(['rescore', ...base, '--reason', 'x', '--crash-log', path.join(out, 'crash.log'), ...flag]), /STOP_RESCORE/); assert.equal(seen.requireChain, want, `rescore ${flag.join(' ')}`);
    }
  } finally { runner.scoreHoldout = origScore; runner.rescore = origRescore; }
  const sh = fs.readFileSync(path.join(ROOT, 'deploy/research-lane/round-runner/run.sh'), 'utf8');
  const block = (name) => sh.split(new RegExp(`^  ${name}\\)\\n`, 'm'))[1].split(/^    ;;$/m)[0];
  for (const name of ['score', 'rescore']) {
    const dockerLine = block(name).split('\n').find((l) => /^\s*docker run /.test(l));
    assert.ok(dockerLine.includes('--require-arrival-chain true'), `${name}: the flag is on the docker line of its own branch`);
  }
  assert.ok(!block('score').includes('rescore'), 'the score branch is bounded at its own end');
});

test('FX9 waiting classification: dependency, unanchored head and arrival lock are exit-75 WAITING; tamper remains exit 2', () => {
  const cli = require('../services/mining-sandbox/round-runner/cli');
  for (const e of [
    { code: 'MINE_RUNNER_PRIOR_SEGMENT_NOT_OPENED', message: 'MINE_RUNNER_PRIOR_SEGMENT_NOT_OPENED:R1' },
    { code: 'MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID', message: 'MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:UNANCHORED:head' },
    { code: 'MINE_RUNNER_ARRIVE_LOCKED', message: 'MINE_RUNNER_ARRIVE_LOCKED:/x/.arrival.lock' },
  ]) {
    const o = cli.errorOutcome(e); assert.equal(o.exitCode, 75); assert.equal(o.document.status, 'WAITING');
  }
  const tamper = cli.errorOutcome({ code: 'MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID', message: 'MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:REWRITE:head' });
  assert.equal(tamper.exitCode, 2); assert.equal(tamper.document.status, undefined);
});

