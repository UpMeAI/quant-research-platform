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
const WINDOW = Object.freeze({ from: '2026-10-19', to: '2026-12-31' }); // the fixture's holdout days, standing in for R2's resolved window
const R2REF = 'lane:rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-r2';
const runDirOf = (out, id) => path.join(out, 'rounds', id.replace(/[^A-Za-z0-9_-]/g, '_'));

/** The fixture's complete holdout directory with R2's seal: SEAL_PENDING_V1.json is the only sealed file, the data files are listed after it (appended, as the export program does). */
function r2Dir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2dir-'));
  for (const n of fs.readdirSync(fx.dirs.holdout)) if (n !== 'SHA256SUMS.sealed') fs.copyFileSync(path.join(fx.dirs.holdout, n), path.join(dir, n));
  const pending = `${JSON.stringify({ schema: 'HOLDOUT_SEAL_PENDING_V1', segment: 'R2', data: 'NONE_AT_SEAL_TIME', sealed_at: '2026-12-01T20:50:00+08:00' })}\n`;
  fs.writeFileSync(path.join(dir, 'SEAL_PENDING_V1.json'), pending);
  const pendingLine = `${sha(pending)}  SEAL_PENDING_V1.json\n`;
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.sealed'), pendingLine);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), pendingLine + fs.readFileSync(path.join(fx.dirs.holdout, 'SHA256SUMS'), 'utf8'));
  return { dir, sealSha: sha(pendingLine) };
}
/** A resolution row written straight into the ledger (what resolveSegment writes for a real 2027 calendar, with the fixture's days as the window). */
function forgeResolution(window = WINDOW) {
  const body = { schema: 'HOLDOUT_SEGMENT_RESOLUTION_V1', segment: 'R2', market: 'CN_A',
    rule: { start_rule: 'FIRST_TRADING_DAY_AFTER', start_after: '2026-12-31', length_trading_days: 54, freeze: require('../services/mining-rounds/holdout-segments').REGISTRY[1].freeze },
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
  const score = () => runner.scoreHoldout({ roundId: r.round_id, sources: sources(), holdoutDir: d.dir, outDir: out, scoredAt: '2027-04-06T10:00:00+08:00', holdoutFloor: COV });
  assert.throws(score, code(/MINE_RUNNER_HOLDOUT_SEGMENT_END_UNKNOWN/), 'no resolution record, no read');
  assert.equal(vault.openLog(r.round_id).length, 0);
  const rec = forgeResolution();
  const s = score();
  assert.equal(s.opened, true);
  assert.equal(s.records.length, sel.selected.length);
  const [open] = vault.openLog(r.round_id);
  assert.deepEqual(open.pre_open_checks.segment_window, { from: WINDOW.from, to: WINDOW.to, segment: 'R2', resolution_record_hash: rec.record_hash });
  assert.equal(open.pre_open_checks.holdout_dir.trade_dates.from, '2026-10-16');
  const scoreFile = JSON.parse(fs.readFileSync(path.join(runDirOf(out, r.round_id), 'score.json'), 'utf8'));
  assert.ok(scoreFile.results.length >= 1);
  for (const x of scoreFile.results) assert.deepEqual([x.holdout.segment, x.holdout.from, x.holdout.to], ['HOLDOUT', WINDOW.from, WINDOW.to]);
  assert.equal(rounds.roundHead(r.round_id).status, 'SCORING');
  assert.equal(runner.close({ roundId: r.round_id }).status, 'CLOSED');
});

test('RC2 deferred seal: the R2 directory (pending line sealed, data appended) passes for a registry round; the same directory for an R1 round still fails the sealed-median anchor', () => {
  freshData();
  const d = r2Dir();
  const r2 = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: 2, openedAt: '2026-12-01T20:50:00+08:00' });
  runner.sealHoldout({ roundId: r2.round_id, dataRef: R2REF, dataSha256: d.sealSha });
  forgeResolution();
  const c = runner.verifyHoldoutDir(r2.round_id, d.dir, { minNamesPerDay: 5, priorSources: sources() });
  assert.deepEqual([c.trade_dates.from, c.trade_dates.to], ['2026-10-16', '2026-12-30']);
  const sealedDays = JSON.stringify(c).match(/"sealed_days":(\d+)/g);
  assert.ok(sealedDays && sealedDays.length > 0 && sealedDays.every((x) => x === '"sealed_days":0'), 'nothing was sealed with rows');
  freshData();
  const r1 = rounds.openRound({ market: 'CN_A', space: { space_ref: 'MS-R1', sha256: sha('r1'), freeze: { path: 'f', sha256: sha('f') } }, holding_periods: [5], generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, holdout: { ...WINDOW }, openedAt: '2026-11-18T05:49:16+08:00', ...R1 });
  vault.seal({ round_id: r1.round_id, segment: { ...WINDOW }, data_ref: 'synthetic', data_sha256: d.sealSha, sealedBy: 'TEST' });
  assert.throws(() => runner.verifyHoldoutDir(r1.round_id, d.dir, { minNamesPerDay: 5, priorSources: sources() }), code(/MINE_RUNNER_HOLDOUT_SEALED_DAYS_EMPTY/), 'R1 is unchanged');
});

test('RC3 deferred seal still checks everything else: a file edited after the listing, an unlisted csv, the pending line removed or edited, a missing calendar day', () => {
  freshData();
  const r2 = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: 2, openedAt: '2026-12-01T20:50:00+08:00' });
  const base = r2Dir();
  runner.sealHoldout({ roundId: r2.round_id, dataRef: R2REF, dataSha256: base.sealSha });
  forgeResolution();
  const copy = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-r2dir-var-')); for (const n of fs.readdirSync(base.dir)) fs.copyFileSync(path.join(base.dir, n), path.join(dir, n)); return dir; };
  const check = (dir) => runner.verifyHoldoutDir(r2.round_id, dir, { minNamesPerDay: 5, priorSources: sources() });
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
  assert.throws(() => runner.verifyHoldoutDir(late.round_id, base.dir, { minNamesPerDay: 5, priorSources: sources() }), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE/));
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
  const same = adapter.buildPanel({ sources: all, space: SPACE, segment: 'HOLDOUT', from: '2023-01-03', to: '2026-12-31', holdoutWindow: { ...WINDOW } });
  assert.equal(JSON.stringify(same.manifest), JSON.stringify(dflt.manifest), 'an explicit window equal to R1 is the default, byte for byte');
  assert.throws(() => adapter.buildPanel({ sources: all, space: SPACE, segment: 'HOLDOUT', from: '2023-01-03', to: '2027-01-15' }), /SEGMENT_RANGE/);
  assert.throws(() => adapter.buildPanel({ sources: all, space: SPACE, segment: 'HOLDOUT', from: '2023-01-03', to: '2027-01-15', holdoutWindow: { from: '2027-01-04', to: '2027-01-15' } }), /CALENDAR_RANGE/);
  assert.throws(() => adapter.buildPanel({ sources: all, space: SPACE, segment: 'VALIDATION', from: '2023-01-03', to: '2026-10-16', holdoutWindow: { from: '2027-01-04', to: '2027-01-15' } }), /HOLDOUT_WINDOW_OUTSIDE_HOLDOUT/, 'the window parameter is for the holdout panel only');
  assert.deepEqual(holdoutScoring.holdoutDays(dflt), holdoutScoring.holdoutDays(dflt, { ...WINDOW }));
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
  assert.match(sh, /--prior-live \/data\/prior-live/);
  assert.match(sh, /-v "\$R1_HOLDOUT:\/data\/prior-live:ro"/);
  assert.ok(sh.includes('HOLDOUT="$LANE/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019"'));
  assert.ok(sh.includes('HOLDOUT_REF="lane:rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019"'));
  // the resolve container reads only: no network, read-only root, the R2 directory read-only, the ledger/out writable
  const line = sh.split('\n').find((l) => l.includes('--name "rf1116-resolve-segment"'));
  for (const f of ['--network none', '--read-only', '--cap-drop ALL', '-v "$HOLDOUT:/data/holdout:ro"']) assert.ok(line.includes(f), f);
});
