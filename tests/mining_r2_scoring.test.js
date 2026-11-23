'use strict';
/**
 * RF1116 second CN_A holdout segment (R2): SCORING a round on R2 (plan-coord 2026-11-23: R2 must be scorable in 2027 with no session). Red first, synthetic data only.
 * The end-to-end test runs the existing mining fixture's holdout directory as if it were R2's: the directory gets a pending seal (nothing sealed but SEAL_PENDING_V1.json, the data
 * "arrives" after the seal) and the round gets a resolution record whose window is the fixture's holdout days (written straight into the ledger: the resolver is unit-tested
 * on a synthetic 2027 calendar in tests/mining_segment_resolution.test.js). R1 behaviour is unchanged: the same directory with an R1 seal still fails the sealed-median anchor.
 *   - the scoring window of a round is the resolved window (vault open, directory check, panel, G-MINE results, access log label, not-before date);
 *   - R2 runs the directory check in deferred-seal mode: every file sha-checked, the pending line still there, floors as R1, but no sealed rows to anchor the median share;
 *   - holdout-scoring and the panel builder take the window as a parameter and behave exactly as before without it.
 */
const { dataRoot } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AUTH = 'TEST_R2_SCORING_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const { makeMiningDataFixture } = require('./_mining_data_fixture');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const holdoutScoring = require('../services/mining-sandbox/round-runner/holdout-scoring');
const rounds = require('../services/mining-rounds');
const vault = require('../services/holdout-vault');
const ledger = require('../packages/ledger');
const trials = require('../services/trial-ledger');
const { R1, reviewAll } = require('./_mining_manifest');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2score-fx-')));
const SPACE = runner.loadFrozenSpace().space;
const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2score-data-')); process.env.QRP_DATA_DIR = d; return d; };
const COV = Object.freeze({ min_names_per_day: 5 });
const KNOWN = ['rank((-ret_1d))', 'zscore((-ret_1d))', 'rank((-ts_mean(ret_1d,5)))', 'rank(pb)', 'rank(ts_delta(close_hfq,1))', 'zscore(turnover_f)'];
const knownGen = { mode: 'AI_MINED_GP', seed: 0, params: { batch_size: 40 }, nextBatch: (view, { n }) => KNOWN.slice(view.mining_scores.length, view.mining_scores.length + n) };
const res = () => require('../services/mining-rounds/segment-resolution');
const R1W = Object.freeze({ from: '2026-10-19', to: '2026-12-31' }); // R1's window (segments.js HOLDOUT): the default of the panel builder and the scorer
// A window inside the fixture's holdout days, standing in for R2's resolved window. It differs from R1's at BOTH ends, so scoring code that falls back to R1's constants is visible.
const WINDOW = Object.freeze({ from: '2026-11-02', to: '2026-12-15' });
const R2REF = 'lane:rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-r2';
const runDirOf = (out, id) => path.join(out, 'rounds', id.replace(/[^A-Za-z0-9_-]/g, '_'));

/**
 * R2's directory the way production produces it: the fixture's holdout days inside WINDOW are dropped per day (CSV_DAY_DROP), and the ARRIVAL PROGRAM writes the sealed directory
 * (pending seal, header-only base files, per-day parts, SHA256SUMS lines, the hash chain). Rows before WINDOW.from go to a separate "prior" directory (the R1 directory's role: ordinary
 * LIVE history for the feed day and the lookbacks); rows after WINDOW.to are not dropped. thin: { stem, day, keep } drops all but `keep` rows of one table on one day (before arrival);
 * stopAfter: the arrival stops at that day (the chain is then short of the window).
 */
const arrival = require('../services/mining-sandbox/round-runner/arrival');
const INDUSTRY_HEADER = 'record_id,security_id,industry_standard,industry_level,industry_code,industry_name,effective_from,effective_to,first_available_at,ingested_at,source_record_id,revision,schema_version,quality_state';
let currentStartAfter = '2026-12-31'; let currentPrior = null;
function r2Dir({ thin = null, stopAfter = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2dir-'));
  const dropDir = path.join(root, 'drop'); const priorDir = path.join(root, 'prior'); const dir = path.join(root, 'r2');
  for (const p of [dropDir, priorDir, dir]) fs.mkdirSync(p);
  const cal = adapter.openDaysOf([adapter.csvDirSource(fx.dirs.holdout, { mode: 'LIVE', label: 'fx', holdout: true })]).days;
  const days = cal.filter((d) => d >= WINDOW.from && d <= WINDOW.to);
  const startAfter = cal[cal.indexOf(days[0]) - 1];
  const priorSums = [];
  for (const d of days) { const dd = path.join(dropDir, d.replace(/-/g, '')); fs.mkdirSync(dd, { recursive: true }); fs.writeFileSync(path.join(dd, 'industry_membership_sw2021.csv'), `${INDUSTRY_HEADER}\n`); fs.writeFileSync(path.join(dd, 'READINESS.json'), `${JSON.stringify({ schema: 'R2_DAY_EXPORT_READINESS_RECORD_V1', trade_date: d, probe_sha256: sha('probe-v2'), ready_via: 'POST_CLOSE_D', n_prices: 5260, n_basic: 5217, n_adj: 5229, n_cov: 1, probed_at: '2027-04-01T21:15:00+08:00', window_from: d === days[0] ? '2027-01-01T00:00:00+08:00' : `${d}T09:00:00+08:00`, window_to: `${cal.find((x) => x > d) || new Date(Date.parse(`${d}T00:00:00Z`) + 3 * 864e5).toISOString().slice(0, 10)}T09:00:00+08:00` })}\n`); } // the seventh table: no new membership rows in the fixture window = a header-only part
  for (const t of arrival.TABLES.filter((x) => x.dateCol)) {
    const lines = fs.readFileSync(path.join(fx.dirs.holdout, `${t.stem}.csv`), 'utf8').split('\n').filter(Boolean);
    const idx = lines[0].split(',').indexOf(t.dateCol);
    const before = []; const byDay = new Map(days.map((d) => [d, []]));
    for (const l of lines.slice(1)) { const d = l.split(',')[idx]; if (d < WINDOW.from) before.push(l); else if (byDay.has(d)) byDay.get(d).push(l); }
    for (const [d, rows] of byDay) {
      const keep = thin && thin.stem === t.stem && thin.day === d ? rows.slice(0, thin.keep) : rows;
      const dd = path.join(dropDir, d.replace(/-/g, '')); fs.mkdirSync(dd, { recursive: true });
      fs.writeFileSync(path.join(dd, `${t.stem}.csv`), `${lines[0]}\n${keep.length ? `${keep.join('\n')}\n` : ''}`);
    }
    const pb = Buffer.from(`${lines[0]}\n${before.length ? `${before.join('\n')}\n` : ''}`);
    fs.writeFileSync(path.join(priorDir, `${t.stem}.csv`), pb); priorSums.push(`${sha(pb)}  ${t.stem}.csv`);
  }
  const calBytes = fs.readFileSync(path.join(fx.dirs.holdout, 'trading_calendar.csv'));
  fs.writeFileSync(path.join(dropDir, 'trading_calendar.csv'), calBytes);
  fs.writeFileSync(path.join(priorDir, 'trading_calendar.csv'), calBytes); priorSums.push(`${sha(calBytes)}  trading_calendar.csv`);
  fs.writeFileSync(path.join(priorDir, 'SHA256SUMS'), `${priorSums.join('\n')}\n`);
  const pending = `${JSON.stringify({ schema: 'HOLDOUT_SEAL_PENDING_V1', segment: 'R2', data: 'NONE_AT_SEAL_TIME', sealed_at: '2026-12-01T20:50:00+08:00' })}\n`;
  fs.writeFileSync(path.join(dir, 'SEAL_PENDING_V1.json'), pending);
  const pendingLine = `${sha(pending)}  SEAL_PENDING_V1.json\n`;
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.sealed'), pendingLine); fs.writeFileSync(path.join(dir, 'SHA256SUMS'), pendingLine);
  const src = arrival.csvDayDropSource(dropDir);
  for (let i = 0; i < 400; i += 1) {
    const r = arrival.arrive({ dir, source: src, startAfter, windowEnd: stopAfter || WINDOW.to, arrivedAt: '2027-04-01T20:30:00+08:00' });
    if (r.status !== 'ARRIVED') break;
  }
  currentStartAfter = startAfter; currentPrior = priorDir;
  return { dir, sealSha: sha(pendingLine), priorDir, startAfter, days };
}
/** The sources a scoring run of an R2 round is given: lane, tail and the "prior" directory (the R1 directory's role). */
const srcs = () => [...sources(), adapter.csvDirSource(currentPrior, { mode: 'LIVE', label: 'prior-live' })];

/** A resolution row written straight into the ledger (what resolveSegment writes for a real 2027 calendar, with the fixture's days as the window). */
function forgeResolution(window = WINDOW, startAfter = currentStartAfter) {
  const body = { schema: 'HOLDOUT_SEGMENT_RESOLUTION_V1', segment: 'R2', market: 'CN_A',
    rule: { start_rule: 'FIRST_TRADING_DAY_AFTER', start_after: startAfter, length_trading_days: 54, freeze: require('../services/mining-rounds/holdout-segments').REGISTRY[1].freeze },
    calendar: { exchange: 'SSE', files: [{ name: 'trading_calendar.csv', sha256: sha('cal') }], sums_sha256: sha('sums'), rows_read: 10, last_date: window.to },
    window: { from: window.from, to: window.to, days: 54, days_sha256: sha('days') }, resolved_at: '2027-01-20T10:00:00+08:00', resolved_by: 'TEST' };
  fs.mkdirSync(path.dirname(res().LEDGER()), { recursive: true });
  ledger.append(res().LEDGER(), { ...body, record_hash: trials.recordHash(body) });
  return res().resolutionOf('R2');
}

test('RC1 scoring on R2, end to end: refused while the window is unrecorded; with the record the open, the directory check, the panel and the results use the resolved window', () => {
  const out = freshData();
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 2 }, cap: KNOWN.length, openedAt: '2026-12-01T20:50:00+08:00' });
  assert.equal(r.holdout.segment, 'R2');
  const d = r2Dir();
  runner.sealHoldout({ roundId: r.round_id, dataRef: R2REF, dataSha256: d.sealSha });
  const g = runner.internals.withGenerator(knownGen, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV }));
  assert.equal(g.attempts.scored, KNOWN.length);
  const sel = runner.select({ roundId: r.round_id, sources: sources(), outDir: out });
  assert.ok(sel.selected.length >= 1);
  reviewAll(r.round_id);
  const score = () => runner.scoreHoldout({ roundId: r.round_id, sources: srcs(), holdoutDir: d.dir, outDir: out, scoredAt: '2027-04-06T10:00:00+08:00', holdoutFloor: COV });
  assert.throws(score, code(/MINE_RUNNER_HOLDOUT_SEGMENT_END_UNKNOWN/), 'no resolution record, no read');
  assert.equal(vault.openLog(r.round_id).length, 0);
  const rec = forgeResolution();
  const s = score();
  assert.equal(s.opened, true);
  assert.equal(s.records.length, sel.selected.length);
  const [open] = vault.openLog(r.round_id);
  assert.deepEqual(open.pre_open_checks.segment_window, { from: WINDOW.from, to: WINDOW.to, segment: 'R2', resolution_record_hash: rec.record_hash });
  assert.deepEqual([open.pre_open_checks.holdout_dir.trade_dates.from, open.pre_open_checks.holdout_dir.trade_dates.to], ['2026-10-30', '2026-12-14'], 'the feed days of the window, not of R1');
  assert.deepEqual([open.pre_open_checks.holdout_dir.seal_mode, open.pre_open_checks.holdout_dir.anchor], ['DEFERRED_PENDING_SEAL', 'OWN_DAYS_MEDIAN']);
  const scoreFile = JSON.parse(fs.readFileSync(path.join(runDirOf(out, r.round_id), 'score.json'), 'utf8'));
  assert.ok(scoreFile.results.length >= 1);
  for (const x of scoreFile.results) assert.deepEqual([x.holdout.segment, x.holdout.from, x.holdout.to], ['HOLDOUT', WINDOW.from, WINDOW.to]);
  assert.equal(rounds.roundHead(r.round_id).status, 'SCORING');
  assert.equal(runner.close({ roundId: r.round_id }).status, 'CLOSED');
});

test('RC1b R2 crash after the open: the one rescore uses the same resolved window and writes the results on it (R1.8)', () => {
  const out = freshData();
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 2 }, cap: KNOWN.length, openedAt: '2026-12-01T20:50:00+08:00' });
  const d = r2Dir();
  runner.sealHoldout({ roundId: r.round_id, dataRef: R2REF, dataSha256: d.sealSha });
  runner.internals.withGenerator(knownGen, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV }));
  runner.select({ roundId: r.round_id, sources: sources(), outDir: out });
  reviewAll(r.round_id);
  const rec = forgeResolution();
  const args = { roundId: r.round_id, sources: srcs(), holdoutDir: d.dir, outDir: out, scoredAt: '2027-04-06T10:00:00+08:00', holdoutFloor: COV };
  assert.throws(() => runner.internals.withFault('AFTER_OPEN', () => runner.scoreHoldout(args)), code(/MINE_RUNNER_TEST_FAULT/));
  assert.equal(rounds.roundHead(r.round_id).status, 'SCORING');
  const rs = runner.rescore({ ...args, reason: 'crash (synthetic)', log: 'x' });
  assert.equal(rs.rescored, true);
  assert.ok(rs.records.length >= 1);
  const file = JSON.parse(fs.readFileSync(path.join(runDirOf(out, r.round_id), 'score.rescore.json'), 'utf8'));
  for (const x of file.results) assert.deepEqual([x.holdout.from, x.holdout.to], [WINDOW.from, WINDOW.to]);
  assert.equal(vault.rescoreLog(r.round_id).length, 1);
  assert.equal(res().resolutionOf('R2').record_hash, rec.record_hash, 'the resolution row is untouched');
});

test('RC2 deferred seal: the R2 directory (pending line sealed, data appended) passes for a registry round; the same directory for an R1 round still fails the sealed-median anchor', () => {
  freshData();
  const d = r2Dir();
  const r2 = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: 2, openedAt: '2026-12-01T20:50:00+08:00' });
  runner.sealHoldout({ roundId: r2.round_id, dataRef: R2REF, dataSha256: d.sealSha });
  forgeResolution();
  const c = runner.verifyHoldoutDir(r2.round_id, d.dir, { minNamesPerDay: 5, priorSources: srcs() });
  assert.deepEqual([c.trade_dates.from, c.trade_dates.to], ['2026-10-30', '2026-12-14']);
  const sealedDays = JSON.stringify(c).match(/"sealed_days":(\d+)/g);
  assert.ok(sealedDays && sealedDays.length > 0 && sealedDays.every((x) => x === '"sealed_days":0'), 'nothing was sealed with rows');
  freshData();
  const r1 = rounds.openRound({ market: 'CN_A', space: { space_ref: 'MS-R1', sha256: sha('r1'), freeze: { path: 'f', sha256: sha('f') } }, holding_periods: [5], generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, holdout: { ...R1W }, openedAt: '2026-11-18T05:49:16+08:00', ...R1 });
  vault.seal({ round_id: r1.round_id, segment: { ...R1W }, data_ref: 'synthetic', data_sha256: d.sealSha, sealedBy: 'TEST' });
  assert.throws(() => runner.verifyHoldoutDir(r1.round_id, d.dir, { minNamesPerDay: 5, priorSources: sources() }), code(/MINE_RUNNER_HOLDOUT_SEALED_DAYS_EMPTY/), 'R1 is unchanged');
});

test('RC3 deferred seal still checks everything else: a file edited after the listing, an unlisted csv, the pending line removed or edited, a missing calendar day', () => {
  freshData();
  const r2 = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: 2, openedAt: '2026-12-01T20:50:00+08:00' });
  const base = r2Dir();
  runner.sealHoldout({ roundId: r2.round_id, dataRef: R2REF, dataSha256: base.sealSha });
  forgeResolution();
  const copy = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2dir-var-')); for (const n of fs.readdirSync(base.dir)) fs.copyFileSync(path.join(base.dir, n), path.join(dir, n)); return dir; };
  const check = (dir) => runner.verifyHoldoutDir(r2.round_id, dir, { minNamesPerDay: 5, priorSources: srcs() });
  const edited = copy(); fs.appendFileSync(path.join(edited, 'prices_daily_stock.csv'), '\n'); assert.throws(() => check(edited), code(/MINE_RUNNER_HOLDOUT_FILE_SHA_MISMATCH/));
  const unlisted = copy(); fs.writeFileSync(path.join(unlisted, 'extra.csv'), 'x'); assert.throws(() => check(unlisted), code(/MINE_RUNNER_HOLDOUT_FILE_UNLISTED/));
  const noPending = copy(); fs.writeFileSync(path.join(noPending, 'SHA256SUMS'), fs.readFileSync(path.join(noPending, 'SHA256SUMS'), 'utf8').split('\n').slice(1).join('\n'));
  assert.throws(() => check(noPending), code(/MINE_RUNNER_HOLDOUT_SEALED_FILES_CHANGED/));
  const noSealed = copy(); fs.rmSync(path.join(noSealed, 'SHA256SUMS.sealed')); assert.throws(() => check(noSealed), code(/MINE_RUNNER_HOLDOUT_SHA_MISMATCH/));
  const noPendingFile = copy(); fs.rmSync(path.join(noPendingFile, 'SEAL_PENDING_V1.json')); assert.throws(() => check(noPendingFile), code(/MINE_RUNNER_HOLDOUT_FILE_MISSING/));
  // a window that the calendar does not cover is incomplete, as for R1
  freshData();
  const late = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 4 }, cap: 2, openedAt: '2026-12-01T20:50:00+08:00' });
  runner.sealHoldout({ roundId: late.round_id, dataRef: R2REF, dataSha256: base.sealSha });
  forgeResolution({ from: '2026-10-19', to: '2027-03-18' });
  assert.throws(() => runner.verifyHoldoutDir(late.round_id, base.dir, { minNamesPerDay: 5, priorSources: srcs() }), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE/));
});

test('RC3b deferred seal still catches a thin day: the anchor is the data\'s own median of days, so a day far below it is incomplete', () => {
  freshData();
  const r2 = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: 2, openedAt: '2026-12-01T20:50:00+08:00' });
  const thin = r2Dir({ thin: { stem: 'prices_daily_stock', day: '2026-12-08', keep: 6 } }); // 6 of 16 names on one day, delivered that way (the chain is valid)
  runner.sealHoldout({ roundId: r2.round_id, dataRef: R2REF, dataSha256: thin.sealSha });
  forgeResolution(WINDOW, thin.startAfter);
  assert.throws(() => runner.verifyHoldoutDir(r2.round_id, thin.dir, { minNamesPerDay: 5, priorSources: srcs() }), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:prices_daily_stock\.csv/));
  const ok = r2Dir();
  assert.doesNotThrow(() => runner.verifyHoldoutDir(r2.round_id, ok.dir, { minNamesPerDay: 5, priorSources: srcs() }), 'the untouched directory passes');
});

test('RC9 the arrival chain is part of the check: a consistent edit (file and SHA256SUMS line both changed), no chain, and days that have not arrived yet are each refused', () => {
  freshData();
  const r2 = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: 2, openedAt: '2026-12-01T20:50:00+08:00' });
  const base = r2Dir();
  runner.sealHoldout({ roundId: r2.round_id, dataRef: R2REF, dataSha256: base.sealSha });
  forgeResolution(WINDOW, base.startAfter);
  const check = (dir) => runner.verifyHoldoutDir(r2.round_id, dir, { minNamesPerDay: 5, priorSources: srcs() });
  assert.doesNotThrow(() => check(base.dir));
  const copy = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2dir-chain-')); for (const n of fs.readdirSync(base.dir)) fs.copyFileSync(path.join(base.dir, n), path.join(dir, n)); return dir; };
  // the edit is consistent with SHA256SUMS, so only the chain can see it
  const edited = copy(); const part = path.join(edited, `prices_daily_stock_${base.days[3].replace(/-/g, '')}.csv`);
  const old = sha(fs.readFileSync(part)); fs.appendFileSync(part, '\n'); const nu = sha(fs.readFileSync(part));
  fs.writeFileSync(path.join(edited, 'SHA256SUMS'), fs.readFileSync(path.join(edited, 'SHA256SUMS'), 'utf8').replace(old, nu));
  assert.throws(() => check(edited), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:FILE_SHA/));
  const noChain = copy(); fs.rmSync(path.join(noChain, 'ARRIVAL_CHAIN_V1.jsonl'));
  assert.throws(() => check(noChain), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:NO_CHAIN/));
  const unchained = copy(); const extra = 'record_id,security_id,trade_date,open,high\n'; fs.writeFileSync(path.join(unchained, 'prices_daily_stock_20261231.csv'), extra);
  fs.appendFileSync(path.join(unchained, 'SHA256SUMS'), `${sha(extra)}  prices_daily_stock_20261231.csv\n`);
  assert.throws(() => check(unchained), code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:UNCHAINED/));
  // the arrival stopped early: the window is not complete yet (not tampering)
  const short = r2Dir({ stopAfter: '2026-12-10' });
  assert.throws(() => check(short.dir), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:arrival:2026-12-11/));
});

test('RC3c deferred seal needs the pending statement to be what was sealed: a sealed file that does not contain SEAL_PENDING_V1.json is refused', () => {
  freshData();
  const r2 = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: 2, openedAt: '2026-12-01T20:50:00+08:00' });
  const base = r2Dir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2dir-nopend-')); for (const n of fs.readdirSync(base.dir)) fs.copyFileSync(path.join(base.dir, n), path.join(dir, n));
  const priceLine = `${fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').find((l) => /prices_daily_stock\.csv$/.test(l))}\n`;
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.sealed'), priceLine);
  runner.sealHoldout({ roundId: r2.round_id, dataRef: R2REF, dataSha256: sha(priceLine) });
  forgeResolution();
  assert.throws(() => runner.verifyHoldoutDir(r2.round_id, dir, { minNamesPerDay: 5, priorSources: srcs() }), code(/MINE_RUNNER_HOLDOUT_SEAL_PENDING_MISSING/));
});

test('RC4 not-before and dataset label: a read is allowed from 2027-01-01 or the day after the resolved end, whichever is later; the access-log dataset names the segment', () => {
  const { notBeforeOf, datasetLabelOf } = runner.internals;
  assert.equal(notBeforeOf({ from: '2026-10-19', to: '2026-12-31', segment: null }), '2027-01-01T00:00:00+08:00', 'R1 as before');
  assert.equal(notBeforeOf({ from: '2027-01-04', to: '2027-03-18', segment: 'R2' }), '2027-03-19T00:00:00+08:00');
  assert.equal(notBeforeOf({ from: '2026-10-19', to: '2026-12-31', segment: 'R2' }), '2027-01-01T00:00:00+08:00', 'never earlier than 2027-01-01');
  assert.equal(datasetLabelOf({ segment: null }), 'CN_A_HOLDOUT_R1');
  assert.equal(datasetLabelOf({ segment: 'R2' }), 'CN_A_HOLDOUT_R2');
});

test('RC5 panel builder and scorer take the window as a parameter and are unchanged without it', () => {
  const holdoutSrc = adapter.csvDirSource(fx.dirs.holdout, { mode: 'LIVE', label: 'holdout', holdout: true });
  const all = [...sources(), holdoutSrc];
  const dflt = adapter.buildPanel({ sources: all, space: SPACE, segment: 'HOLDOUT', from: '2023-01-03', to: '2026-12-31' });
  const same = adapter.buildPanel({ sources: all, space: SPACE, segment: 'HOLDOUT', from: '2023-01-03', to: '2026-12-31', holdoutWindow: { ...R1W } });
  assert.equal(JSON.stringify(same.manifest), JSON.stringify(dflt.manifest), 'an explicit window equal to R1 is the default, byte for byte');
  assert.throws(() => adapter.buildPanel({ sources: all, space: SPACE, segment: 'HOLDOUT', from: '2023-01-03', to: '2027-01-15' }), /SEGMENT_RANGE/);
  assert.throws(() => adapter.buildPanel({ sources: all, space: SPACE, segment: 'HOLDOUT', from: '2023-01-03', to: '2027-01-15', holdoutWindow: { from: '2027-01-04', to: '2027-01-15' } }), /CALENDAR_RANGE/);
  assert.throws(() => adapter.buildPanel({ sources: all, space: SPACE, segment: 'VALIDATION', from: '2023-01-03', to: '2026-10-16', holdoutWindow: { from: '2027-01-04', to: '2027-01-15' } }), /HOLDOUT_WINDOW_OUTSIDE_HOLDOUT/, 'the window parameter is for the holdout panel only');
  assert.deepEqual(holdoutScoring.holdoutDays(dflt), holdoutScoring.holdoutDays(dflt, { ...R1W }));
  const shorter = holdoutScoring.holdoutDays(dflt, { from: '2026-12-01', to: '2026-12-31' });
  assert.ok(shorter.length > 0 && shorter.length < holdoutScoring.holdoutDays(dflt).length);
  assert.doesNotThrow(() => holdoutScoring.assertHoldoutPanel(dflt));
  assert.throws(() => holdoutScoring.assertHoldoutPanel(dflt, { from: '2026-10-19', to: '2026-12-30' }), /NOT_HOLDOUT_PANEL/, 'the panel must end on the window end');
});

test('RC6 CLI: resolve-segment is a command; score and rescore accept --prior-live (the R1 directory as ordinary history); the option is rejected elsewhere', () => {
  const CLI = path.join(__dirname, '..', 'services/mining-sandbox/round-runner/cli.js');
  // the runner insists that the ledger directory is inside its output directory (production: --out /out, QRP_DATA_DIR=/out/qrp-data)
  const outOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2cli-out-'));
  const callIn = (outDir, args) => require('child_process').spawnSync(process.execPath, [CLI, ...args], { env: { ...require('./_clean_env')(), QRP_DATA_DIR: path.join(outDir, 'qrp-data'), QRP_PRODUCT_MILESTONE_AUTHORITY: AUTH }, encoding: 'utf8' });
  const call = (args) => callIn(out, args);
  const cli = { OPTIONS: require('../services/mining-sandbox/round-runner/cli').OPTIONS };
  assert.ok(cli.OPTIONS['resolve-segment'] && cli.OPTIONS['resolve-segment'].includes('segment') && cli.OPTIONS['resolve-segment'].includes('holdout'));
  for (const c of ['score', 'rescore']) assert.ok(cli.OPTIONS[c].includes('prior-live'), c);
  assert.ok(!cli.OPTIONS.generate.includes('prior-live'));
  const { sourcesOf } = require('../services/mining-sandbox/round-runner/cli');
  assert.deepEqual(sourcesOf({ lane: fx.dirs.lane, tail: fx.dirs.tail }).map((s) => [s.label, s.mode, s.holdout]), [['lane', 'HISTORY', false], ['tail', 'LIVE', false]]);
  assert.deepEqual(sourcesOf({ lane: fx.dirs.lane, tail: fx.dirs.tail, 'prior-live': fx.dirs.holdout }).map((s) => [s.label, s.mode, s.holdout]),
    [['lane', 'HISTORY', false], ['tail', 'LIVE', false], ['prior-live', 'LIVE', false]], 'an earlier segment is ordinary LIVE history, not a holdout source');
  const out = outOf();
  const calDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2cli-'));
  const days = []; for (let d = '2026-12-21'; d <= '2027-04-30'; d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)) { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); days.push([d, w !== 0 && w !== 6 && d !== '2027-01-01']); }
  const lines = ['calendar_date,market,exchange,is_open,previous_open_date,first_available_at,ingested_at,source_record_id,revision,schema_version,quality_state'];
  for (const [d, open] of days) for (const ex of ['SSE', 'SZSE']) lines.push(`${d},A_SHARE,${ex},${open ? 't' : 'f'},,2026-12-15 08:00:00+08,2026-12-15 08:00:00+08,cal:${d}:${ex},1,synthetic-v1,READY`);
  const bytes = `${lines.join('\n')}\n`; fs.writeFileSync(path.join(calDir, 'trading_calendar.csv'), bytes); fs.writeFileSync(path.join(calDir, 'SHA256SUMS'), `${sha(bytes)}  trading_calendar.csv\n`);
  const run1 = call(['resolve-segment', '--out', out, '--segment', 'R2', '--holdout', calDir]);
  assert.equal(run1.status, 0, run1.stderr);
  const o = JSON.parse(run1.stdout);
  assert.deepEqual([o.command, o.status, o.created, o.segment], ['resolve-segment', 'RESOLVED', true, 'R2']);
  assert.equal(o.window.from, '2027-01-04');
  const run2 = call(['resolve-segment', '--out', out, '--segment', 'R2', '--holdout', calDir]);
  assert.equal(run2.status, 0, run2.stderr);
  assert.equal(JSON.parse(run2.stdout).created, false);
  const bad = call(['generate', '--prior-live', calDir]);
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stderr).error, 'MINE_RUNNER_OPTION_UNKNOWN');
  // a calendar that lists too few days: NOT_READY, exit 0, nothing recorded for a fresh ledger
  const out2 = outOf(); const thin = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2cli-thin-'));
  const thinBytes = `${lines.slice(0, 1 + 2 * 30).join('\n')}\n`; fs.writeFileSync(path.join(thin, 'trading_calendar.csv'), thinBytes); fs.writeFileSync(path.join(thin, 'SHA256SUMS'), `${sha(thinBytes)}  trading_calendar.csv\n`);
  const nr = callIn(out2, ['resolve-segment', '--out', out2, '--segment', 'R2', '--holdout', thin]);
  assert.equal(nr.status, 0, nr.stderr);
  assert.equal(JSON.parse(nr.stdout).status, 'NOT_READY');
  assert.equal(fs.existsSync(path.join(out2, 'qrp-data', 'research', 'holdout_segment_resolutions.jsonl')), false, 'nothing recorded');
});

test('RC7 run.sh: resolve-segment and seal-init-r2 are commands; score for R2 mounts the R1 directory read-only as --prior-live; R1 lines are unchanged', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', 'deploy/research-lane/round-runner/run.sh'), 'utf8');
  assert.match(sh, /seal-init-r2\)/);
  assert.match(sh, /seal-init-r2\.sh/);
  assert.match(sh, /resolve-segment\)/);
  assert.match(sh, /--name "rf1116-resolve-segment"/);
  assert.match(sh, /resolve-segment needs RF1116_HOLDOUT_SEGMENT=R2/);
  assert.match(sh, /^prior_live\(\) \{\n  PRIORM=\(\); PRIORO=\(\)\n  if \[ "\$\{RF1116_HOLDOUT_SEGMENT:-R1\}" = R2 \]; then/m);
  assert.match(sh, /--prior-live \/data\/prior-live/);
  assert.match(sh, /-v "\$R1_HOLDOUT:\/data\/prior-live:ro"/);
  assert.ok(sh.includes('HOLDOUT="$LANE/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019"'));
  assert.ok(sh.includes('HOLDOUT_REF="lane:rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019"'));
  // the resolve container reads only: no network, read-only root, the R2 directory read-only, the ledger/out writable
  const line = sh.split('\n').find((l) => l.includes('--name "rf1116-resolve-segment"'));
  for (const f of ['--network none', '--read-only', '--cap-drop ALL', '-v "$HOLDOUT:/data/holdout:ro"']) assert.ok(line.includes(f), f);
});

test('RC8 anchor: with an R1 open row its recorded medians are R2\'s anchor (the record hash is in the check record); without one the data\'s own median; a high R1 anchor makes a normal R2 directory incomplete', () => {
  freshData();
  const r1 = rounds.openRound({ market: 'CN_A', space: { space_ref: 'MS-R1A', sha256: sha('r1a'), freeze: { path: 'f', sha256: sha('f') } }, holding_periods: [5], generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, holdout: { ...R1W }, openedAt: '2026-11-18T05:49:16+08:00', ...R1 });
  const r2 = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: 2, openedAt: '2026-12-01T20:50:00+08:00' });
  const d = r2Dir();
  runner.sealHoldout({ roundId: r2.round_id, dataRef: R2REF, dataSha256: d.sealSha });
  forgeResolution();
  const check = () => runner.verifyHoldoutDir(r2.round_id, d.dir, { minNamesPerDay: 5, priorSources: srcs() });
  const own = check();
  assert.deepEqual([own.anchor, own.anchor_record_hash], ['OWN_DAYS_MEDIAN', null]);
  assert.ok(Object.values(own.rows_per_day).every((x) => x.anchor_basis === 'OWN_DAYS_MEDIAN'));
  // an R1 round and its open row (what R1's scoring records in January 2027)
  const openRow = (scale) => {
    const per = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, sealed_median_names: Math.round(v.median_names * scale), anchor_basis: undefined }]));
    const body = { schema: 'HOLDOUT_OPEN_V1', round_id: r1.round_id, seal_hash: sha('seal'), candidate_ids: ['x'], opened_by: 'TEST', opened_at: '2027-01-10T10:00:00+08:00', segment_open_index: 1,
      pre_open_checks: { holdout_dir: { rows_per_day: per(own.rows_per_day), label_rows_per_day: per(own.label_rows_per_day),
        field_states_per_day: Object.fromEntries(Object.entries(own.field_states_per_day).map(([k, v]) => [k, { ...v, sealed_median: Math.round(v.median * scale) }])) } }, selection_record_hash: null, inputs_sha256: null };
    ledger.append(vault.LEDGER(), { ...body, record_hash: trials.recordHash(body) });
    return trials.recordHash(body);
  };
  const h1 = openRow(1);
  const withR1 = check();
  assert.deepEqual([withR1.anchor, withR1.anchor_record_hash], ['R1_OPEN_RECORD', h1]);
  assert.ok(Object.values(withR1.rows_per_day).every((x) => x.anchor_basis === 'R1_OPEN_RECORD'));
  // a later R1 open row does not replace the first one
  openRow(100);
  assert.equal(check().anchor_record_hash, h1);
  // a high anchor (R1 had 100 times the names): the same R2 directory is incomplete
  freshData();
  const r1b = rounds.openRound({ market: 'CN_A', space: { space_ref: 'MS-R1B', sha256: sha('r1b'), freeze: { path: 'f', sha256: sha('f') } }, holding_periods: [5], generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, holdout: { ...R1W }, openedAt: '2026-11-18T05:49:16+08:00', ...R1 });
  const r2b = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: 2, openedAt: '2026-12-01T20:50:00+08:00' });
  runner.sealHoldout({ roundId: r2b.round_id, dataRef: R2REF, dataSha256: d.sealSha });
  forgeResolution();
  const per = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, sealed_median_names: v.median_names * 100 }]));
  const body = { schema: 'HOLDOUT_OPEN_V1', round_id: r1b.round_id, seal_hash: sha('seal'), candidate_ids: ['x'], opened_by: 'TEST', opened_at: '2027-01-10T10:00:00+08:00', segment_open_index: 1,
    pre_open_checks: { holdout_dir: { rows_per_day: per(own.rows_per_day), label_rows_per_day: per(own.label_rows_per_day), field_states_per_day: Object.fromEntries(Object.entries(own.field_states_per_day).map(([k, v]) => [k, { ...v, sealed_median: v.median * 100 }])) } }, selection_record_hash: null, inputs_sha256: null };
  ledger.append(vault.LEDGER(), { ...body, record_hash: trials.recordHash(body) });
  assert.throws(() => runner.verifyHoldoutDir(r2b.round_id, d.dir, { minNamesPerDay: 5, priorSources: srcs() }), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE/));
  // the field floor is anchored on R1's recorded field medians too: row medians normal, field medians 100 times higher = a field-floor refusal (the own-median anchor would pass)
  freshData();
  const r1c = rounds.openRound({ market: 'CN_A', space: { space_ref: 'MS-R1C', sha256: sha('r1c'), freeze: { path: 'f', sha256: sha('f') } }, holding_periods: [5], generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, holdout: { ...R1W }, openedAt: '2026-11-18T05:49:16+08:00', ...R1 });
  const r2c = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: 2, openedAt: '2026-12-01T20:50:00+08:00' });
  runner.sealHoldout({ roundId: r2c.round_id, dataRef: R2REF, dataSha256: d.sealSha });
  forgeResolution();
  const same = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, sealed_median_names: v.median_names }]));
  const bodyC = { schema: 'HOLDOUT_OPEN_V1', round_id: r1c.round_id, seal_hash: sha('seal'), candidate_ids: ['x'], opened_by: 'TEST', opened_at: '2027-01-10T10:00:00+08:00', segment_open_index: 1,
    pre_open_checks: { holdout_dir: { rows_per_day: same(own.rows_per_day), label_rows_per_day: same(own.label_rows_per_day), field_states_per_day: Object.fromEntries(Object.entries(own.field_states_per_day).map(([k, v]) => [k, { ...v, sealed_median: v.median * 100 }])) } }, selection_record_hash: null, inputs_sha256: null };
  ledger.append(vault.LEDGER(), { ...bodyC, record_hash: trials.recordHash(bodyC) });
  assert.throws(() => runner.verifyHoldoutDir(r2c.round_id, d.dir, { minNamesPerDay: 5, priorSources: srcs() }), code(/MINE_RUNNER_HOLDOUT_FIELD_INCOMPLETE/));
});

test('RC10 strict gate (--require-arrival-chain): an R2 score is refused until an R1 round of the market has an open row (or every R1 round is terminal); then the prior-live (R1) directory\'s chain must verify; without the strict flag nothing changes', () => {
  const out = freshData();
  // an R1 round first (an explicit-window round is refused once registry rounds exist)
  const r1 = rounds.openRound({ market: 'CN_A', space: { space_ref: 'MS-R1X', sha256: sha('r1x'), freeze: { path: 'f', sha256: sha('f') } }, holding_periods: [5], generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, holdout: { ...R1W }, openedAt: '2026-11-18T05:49:16+08:00', ...R1 });
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 2 }, cap: KNOWN.length, openedAt: '2026-12-01T20:50:00+08:00' });
  const d = r2Dir();
  runner.sealHoldout({ roundId: r.round_id, dataRef: R2REF, dataSha256: d.sealSha });
  runner.internals.withGenerator(knownGen, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV }));
  runner.select({ roundId: r.round_id, sources: sources(), outDir: out });
  reviewAll(r.round_id);
  forgeResolution();
  const strict = () => runner.scoreHoldout({ roundId: r.round_id, sources: srcs(), holdoutDir: d.dir, outDir: out, scoredAt: '2027-04-06T10:00:00+08:00', holdoutFloor: COV, requireChain: true });
  // an R1 round that has not been opened: refused before any holdout read
  assert.throws(strict, code(/MINE_RUNNER_PRIOR_SEGMENT_NOT_OPENED:R1/));
  assert.equal(vault.openLog(r.round_id).length, 0, 'nothing was opened');
  // an R1 open row: the precondition holds; the prior-live directory (no chain in this fixture) is refused next
  const body = { schema: 'HOLDOUT_OPEN_V1', round_id: r1.round_id, seal_hash: sha('seal'), candidate_ids: ['x'], opened_by: 'TEST', opened_at: '2027-01-10T10:00:00+08:00', segment_open_index: 1, pre_open_checks: {}, selection_record_hash: null, inputs_sha256: null };
  ledger.append(vault.LEDGER(), { ...body, record_hash: trials.recordHash(body) });
  assert.throws(strict, code(/MINE_RUNNER_HOLDOUT_ARRIVAL_INVALID:NO_CHAIN/));
  assert.equal(vault.openLog(r.round_id).length, 0);
  // without the flag the old behaviour: the score goes through
  const plain = runner.scoreHoldout({ roundId: r.round_id, sources: srcs(), holdoutDir: d.dir, outDir: out, scoredAt: '2027-04-06T10:00:00+08:00', holdoutFloor: COV });
  assert.equal(plain.opened, true);
});

test('RC11 the R1-before-R2 predicate: no R1 round = refused; an R1 round without an open row = refused; an open row = ok; every R1 round terminal = ok', () => {
  freshData();
  const open1 = (n) => rounds.openRound({ market: 'CN_A', space: { space_ref: `MS-P${n}`, sha256: sha(`p${n}`), freeze: { path: 'f', sha256: sha('f') } }, holding_periods: [5], generator: { mode: 'AI_MINED_GP', gp_seed: n }, holdout: { ...R1W }, openedAt: `2026-11-18T05:49:1${n}+08:00`, ...R1 });
  assert.deepEqual([runner.priorSegmentReady('CN_A').ok, runner.priorSegmentReady('CN_A').reason], [false, 'NO_R1_ROUND']);
  const a = open1(1);
  assert.deepEqual([runner.priorSegmentReady('CN_A').ok, runner.priorSegmentReady('CN_A').reason], [false, 'R1_NOT_OPENED']);
  rounds.failEvaluation(a.round_id, { reason: 'never evaluated', evidenceSha256: sha('e') });
  assert.equal(runner.priorSegmentReady('CN_A').ok, true, 'every R1 round terminal');
  const b = open1(2);
  assert.equal(runner.priorSegmentReady('CN_A').ok, false, 'a new R1 round that is neither opened nor terminal');
  const body = { schema: 'HOLDOUT_OPEN_V1', round_id: b.round_id, seal_hash: sha('seal'), candidate_ids: ['x'], opened_by: 'TEST', opened_at: '2027-01-10T10:00:00+08:00', segment_open_index: 1, pre_open_checks: {}, selection_record_hash: null, inputs_sha256: null };
  ledger.append(vault.LEDGER(), { ...body, record_hash: trials.recordHash(body) });
  assert.equal(runner.priorSegmentReady('CN_A').ok, true, 'an R1 round with an open row');
});
