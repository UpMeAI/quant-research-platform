'use strict';
/**
 * W24 (PLAN_V1_1_AMENDMENT_1 section 3, access log and read lock; contract docs/contracts/INDEPENDENT_VERIFIER_V1.md "Who takes the process lock"). Red first.
 *   - the access-log writer writes the hash-chained rows the verifier's V-2 parses; a deferred writer buffers until the round's file is known;
 *   - generator launchers take the W20 read lock: a generator reading a holdout dir is refused AND logged; the principal must be a generator;
 *   - round-runner wiring: generate/select log their panel reads as `mining-generator`; the round-runner scoring is exempt from the lock but takes the
 *     once-per-candidate grant and logs one HOLDOUT_READ per selected candidate; a second read is refused; a read before 2027-01-01T00:00+08:00 is refused;
 *   - the AQ agent CLI takes the lock and logs its fact-pack read as `review-agent`.
 * Synthetic data only. One file, one process (the lock cannot be lifted inside a process, so the lock tests run in child processes).
 */
const { dataRoot } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const cleanEnv = require('./_clean_env');

const AUTH = 'TEST_W24_ACCESS_LOG_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const { makeMiningDataFixture, internals: fixtureInternals } = require('./_mining_data_fixture');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const rounds = require('../services/mining-rounds');
const accessLog = require('../services/independent-verifier/access-log');
const authority = require('../services/independent-verifier/authority');
const { runners } = require('../services/independent-verifier/stages');
const { SEGMENTS } = require('../services/mining-sandbox/segments');
const F = require('./_rq_agent_fixture');

const ROOT = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const fx = makeMiningDataFixture(tmp('qrp-w24-fx-'));
const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
const freshData = () => { const d = tmp('qrp-w24-data-'); process.env.QRP_DATA_DIR = d; return d; };
const COV = Object.freeze({ min_names_per_day: 5 });
const KNOWN = ['rank((-ret_1d))', 'zscore((-ret_1d))', 'rank((-ts_mean(ret_1d,5)))', 'rank(pb)'];
const knownGen = { mode: 'AI_MINED_GP', seed: 0, params: { batch_size: 40 }, nextBatch: (view, { n }) => KNOWN.slice(view.mining_scores.length, view.mining_scores.length + n) };
/** V-2 on a log file, the way the verifier runs it (reused, not re-implemented). */
function v2Codes(file, { asOf = '2027-01-06', candidateSha256 = 'a'.repeat(64) } = {}) {
  const bytes = fs.readFileSync(file);
  const bundle = { candidateSha256, asOf, familyId: 'CN_A_H5', v2: { accessLog: { path: 'log', sha256: sha(bytes) } } };
  return runners.V2(bundle, { readBytes: () => bytes, authority: { ledgerFile: path.join(tmp('w24-grants-'), 'none.jsonl') } }, authority.loadConfig()).codes;
}

/* -------------------------------------------------------------------- the writer */

test('access-log writer: rows are {seq, principal, op, dataset, from, to, prev, hash} in a hash chain the verifier parses; a second writer on the same file continues the chain', () => {
  const file = path.join(tmp('w24-log-'), 'access_log.jsonl');
  const w = accessLog.writer(file);
  const a = w.record({ principal: 'mining-generator', op: 'READ', dataset: 'CN_A_MINING_SPACE_PANEL', from: '2020-06-01', to: '2023-12-29' });
  assert.equal(a.seq, 1);
  assert.equal(a.prev, '0'.repeat(64));
  const b = accessLog.writer(file).record({ principal: 'mining-generator', op: 'READ', dataset: 'CN_A_MINING_SPACE_PANEL', from: '2020-06-01', to: '2026-10-16' });
  assert.deepEqual([b.seq, b.prev], [2, a.hash]);
  const parsed = require('../services/independent-verifier/stages').internals.parseAccessLog(fs.readFileSync(file));
  assert.equal(parsed.length, 2);
  assert.equal(accessLog.verifyBytes(fs.readFileSync(file)).ok, true);
  const bad = fs.readFileSync(file, 'utf8').replace('2023-12-29', '2023-12-28');
  assert.equal(accessLog.verifyBytes(Buffer.from(bad)).ok, false, 'an edited row breaks the chain');
  assert.throws(() => w.record({ principal: 'mining-generator', op: 'WRITE', dataset: 'x', from: '2020-06-01', to: '2020-06-02' }), code(/ACCESS_LOG_ROW_INVALID/));
  assert.throws(() => w.record({ principal: 'mining-generator', op: 'READ', dataset: 'x', from: '2020-06-03', to: '2020-06-02' }), code(/ACCESS_LOG_ROW_INVALID/));
});

test('deferred writer: rows recorded before the round id is known are buffered and flushed, in order, when the file is bound; binding twice is refused', () => {
  const dir = tmp('w24-deferred-');
  const d = accessLog.deferred();
  d.record({ principal: 'mining-generator', op: 'READ', dataset: 'A', from: '2020-06-01', to: '2020-06-30' });
  d.record({ principal: 'mining-generator', op: 'READ', dataset: 'B', from: '2020-07-01', to: '2020-07-31' });
  d.bind(path.join(dir, 'log.jsonl'));
  d.record({ principal: 'mining-generator', op: 'READ', dataset: 'C', from: '2020-08-01', to: '2020-08-31' });
  assert.deepEqual(lines(path.join(dir, 'log.jsonl')).map((r) => [r.seq, r.dataset]), [[1, 'A'], [2, 'B'], [3, 'C']]);
  assert.throws(() => d.bind(path.join(dir, 'other.jsonl')), code(/ACCESS_LOG_ALREADY_BOUND/));
});

test('candidateSha256Of is a pure function of round, candidate and canonical formula', () => {
  const a = accessLog.candidateSha256Of({ roundId: 'MR-X', candidateId: 'MR-X:A001', formula: 'rank((-ret_1d))' });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, accessLog.candidateSha256Of({ roundId: 'MR-X', candidateId: 'MR-X:A001', formula: 'rank((-ret_1d))' }));
  assert.notEqual(a, accessLog.candidateSha256Of({ roundId: 'MR-X', candidateId: 'MR-X:A001', formula: 'rank(pb)' }));
});

/* -------------------------------------------------------------------- the launcher lock (child processes: the lock cannot be lifted) */

function child(script, env = {}) {
  return spawnSync(process.execPath, ['-e', script], { env: { ...cleanEnv(), ...env }, encoding: 'utf8', cwd: ROOT });
}

test('launcher: a generator process that reads the holdout dir is refused (VERIFIER_HOLDOUT_READ_REFUSED) and the refusal is logged as a generator HOLDOUT_READ that V-2 flags; writes outside the output dir stay refused', () => {
  const work = tmp('w24-lock-'); const holdout = path.join(work, 'holdout'); const out = path.join(work, 'out');
  fs.mkdirSync(holdout); fs.mkdirSync(out); fs.writeFileSync(path.join(holdout, 'prices.csv'), 'x\n'); fs.writeFileSync(path.join(work, 'elsewhere.txt'), 'y\n');
  const logFile = path.join(out, 'access_log.jsonl');
  const r = child(`
    const fs = require('fs');
    const launcher = require('./services/independent-verifier/launcher');
    const lock = launcher.lockGenerator({ principal: 'mining-generator', allowWriteRoot: ${JSON.stringify(out)}, accessLogFile: ${JSON.stringify(logFile)}, holdoutDirs: [${JSON.stringify(holdout)}] });
    const seen = {};
    try { fs.readFileSync(${JSON.stringify(path.join(holdout, 'prices.csv'))}); seen.read = 'ALLOWED'; } catch (e) { seen.read = e.code; }
    try { fs.readdirSync(${JSON.stringify(holdout)}); seen.readdir = 'ALLOWED'; } catch (e) { seen.readdir = e.code; }
    try { fs.writeFileSync(${JSON.stringify(path.join(work, 'x.txt'))}, 'z'); seen.write = 'ALLOWED'; } catch (e) { seen.write = e.code; }
    seen.other = fs.readFileSync(${JSON.stringify(path.join(work, 'elsewhere.txt'))}, 'utf8').trim();
    lock.recordRead({ dataset: 'CN_A_MINING_SPACE_PANEL', from: '2020-06-01', to: '2023-12-29' });
    process.stdout.write(JSON.stringify(seen));
  `, { QRP_DATA_DIR: path.join(out, 'data') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { read: 'VERIFIER_HOLDOUT_READ_REFUSED', readdir: 'VERIFIER_HOLDOUT_READ_REFUSED', write: 'MINE_SANDBOX_WRITE_REFUSED', other: 'y' });
  const rows = lines(logFile);
  assert.deepEqual(rows.map((x) => [x.principal, x.op, Boolean(x.refused)]), [['mining-generator', 'HOLDOUT_READ', true], ['mining-generator', 'HOLDOUT_READ', true], ['mining-generator', 'READ', false]]);
  assert.equal(rows[0].code, 'VERIFIER_HOLDOUT_READ_REFUSED');
  assert.deepEqual([rows[0].from, rows[0].to], [SEGMENTS.HOLDOUT.from, SEGMENTS.HOLDOUT.to]);
  assert.equal(accessLog.verifyBytes(fs.readFileSync(logFile)).ok, true);
  assert.ok(v2Codes(logFile).includes('V2_GENERATOR_HOLDOUT_READ') || v2Codes(logFile).includes('GENERATOR_HOLDOUT_READ'), 'V-2 flags a generator holdout read attempt');
});

test('launcher: only generator principals take the lock; the holdout scorer and unknown names are refused; the holdout dirs also come from QRP_HOLDOUT_DATA_DIRS', () => {
  const work = tmp('w24-lock2-'); const out = path.join(work, 'out'); const holdout = path.join(work, 'h');
  fs.mkdirSync(out); fs.mkdirSync(holdout); fs.writeFileSync(path.join(holdout, 'a.csv'), 'x\n');
  const run = (principal, env = {}) => child(`
    const l = require('./services/independent-verifier/launcher');
    try { l.lockGenerator({ principal: ${JSON.stringify(principal)}, allowWriteRoot: ${JSON.stringify(out)}, accessLogFile: ${JSON.stringify(path.join(out, 'l.jsonl'))} }); process.stdout.write('LOCKED'); } catch (e) { process.stdout.write(e.code || e.message); }
    try { require('fs').readFileSync(${JSON.stringify(path.join(holdout, 'a.csv'))}); process.stdout.write(' READ_OK'); } catch (e) { process.stdout.write(' ' + e.code); }
  `, env);
  assert.match(run('holdout-scorer').stdout, /^VERIFIER_PRINCIPAL_NOT_GENERATOR/);
  assert.match(run('somebody').stdout, /^VERIFIER_PRINCIPAL_NOT_GENERATOR/);
  assert.equal(run('review-agent', { QRP_HOLDOUT_DATA_DIRS: holdout }).stdout, 'LOCKED VERIFIER_HOLDOUT_READ_REFUSED');
});

test('process lock: onRefuse is called with the refused path (additive option of the W20 lock)', () => {
  const work = tmp('w24-lock3-'); const out = path.join(work, 'out'); const holdout = path.join(work, 'h');
  fs.mkdirSync(out); fs.mkdirSync(holdout); fs.writeFileSync(path.join(holdout, 'a.csv'), 'x\n');
  const r = child(`
    const lock = require('./services/independent-verifier/process-lock');
    const seen = [];
    lock.lockProcess({ allowWriteRoot: ${JSON.stringify(out)}, denyReadRoots: [${JSON.stringify(holdout)}], onRefuse: (p) => seen.push(require('path').basename(p)) });
    try { require('fs').readFileSync(${JSON.stringify(path.join(holdout, 'a.csv'))}); } catch (e) { seen.push(e.code); }
    process.stdout.write(JSON.stringify(seen));
  `);
  assert.equal(r.stdout, JSON.stringify(['a.csv', 'VERIFIER_HOLDOUT_READ_REFUSED']));
});

/* -------------------------------------------------------------------- round-runner wiring */

test('round runner: generate and select log their panel reads as mining-generator, inside the mining and validation segments; V-2 passes on the log and no holdout row exists', () => {
  const out = freshData();
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: KNOWN.length, openedAt: '2026-11-21T02:00:00Z' });
  runner.sealHoldout({ roundId: r.round_id, dataRef: 'synthetic:holdout', dataSha256: sha(fs.readFileSync(path.join(fx.dirs.holdout, 'SHA256SUMS'))) });
  const file = runner.accessLogFile(out, r.round_id);
  assert.equal(path.dirname(file), path.join(out, 'rounds', r.round_id.replace(/[^A-Za-z0-9_-]/g, '_')));
  const log = accessLog.writer(file);
  runner.internals.withGenerator(knownGen, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV, accessLog: log }));
  runner.select({ roundId: r.round_id, sources: sources(), outDir: out, accessLog: log });
  const rows = lines(file);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.principal === 'mining-generator' && x.op === 'READ' && x.dataset === 'CN_A_MINING_SPACE_PANEL'));
  assert.ok(rows[0].to <= SEGMENTS.MINING.to && rows[0].from >= SEGMENTS.MINING.from, JSON.stringify(rows[0]));
  assert.ok(rows[1].to <= SEGMENTS.VALIDATION.to, JSON.stringify(rows[1]));
  assert.ok(rows[1].to > SEGMENTS.MINING.to, 'the selection panel runs through the validation segment');
  assert.deepEqual(v2Codes(file, { asOf: '2026-12-01' }), []);
});

/** Only the two variants the scoring tests need (partial = what was sealed, complete = sealed plus the date-suffixed completion files). */
function holdoutDir() {
  const root = tmp('w24-holdout-'); const v = { partial: path.join(root, 'partial'), complete: path.join(root, 'complete') };
  for (const d of Object.values(v)) fs.mkdirSync(d);
  const CUT = '2026-11-17';
  for (const name of fs.readdirSync(fx.dirs.holdout).filter((n) => n.endsWith('.csv'))) {
    const rows = []; adapter.internals.forEachCsvRow(path.join(fx.dirs.holdout, name), (r) => rows.push(r));
    const cols = rows.length ? Object.keys(rows[0]) : fs.readFileSync(path.join(fx.dirs.holdout, name), 'utf8').split('\n')[0].split(',');
    const isCal = name === 'trading_calendar.csv'; const day = (r) => r.trade_date || r.business_date;
    const early = isCal ? rows : rows.filter((r) => day(r) <= CUT); const late = isCal ? [] : rows.filter((r) => day(r) > CUT);
    for (const d of Object.values(v)) fs.writeFileSync(path.join(d, name), fixtureInternals.csv(cols, early));
    if (!isCal) fs.writeFileSync(path.join(v.complete, name.replace(/\.csv$/, '_20270105.csv')), fixtureInternals.csv(cols, late));
  }
  const files = fs.readdirSync(v.partial).filter((n) => n.endsWith('.csv')).sort();
  fs.writeFileSync(path.join(v.partial, 'SHA256SUMS'), `${files.map((n) => `${sha(fs.readFileSync(path.join(v.partial, n)))}  ${n}`).join('\n')}\n`);
  fs.copyFileSync(path.join(v.partial, 'SHA256SUMS'), path.join(v.complete, 'SHA256SUMS.sealed'));
  const cf = fs.readdirSync(v.complete).filter((n) => n.endsWith('.csv')).sort();
  fs.writeFileSync(path.join(v.complete, 'SHA256SUMS'), `${cf.map((n) => `${sha(fs.readFileSync(path.join(v.complete, n)))}  ${n}`).join('\n')}\n`);
  return { ...v, sealSha: sha(fs.readFileSync(path.join(v.partial, 'SHA256SUMS'))) };
}

test('round runner scoring: exempt from the lock, but takes the once-per-candidate grant and logs one HOLDOUT_READ per selected candidate; a read before 2027-01-01T00:00+08:00 and a second read are refused', () => {
  const out = freshData();
  const hv = holdoutDir();
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 4 }, cap: KNOWN.length, openedAt: '2026-11-21T02:00:00Z' });
  runner.sealHoldout({ roundId: r.round_id, dataRef: 'synthetic:holdout', dataSha256: hv.sealSha });
  const file = runner.accessLogFile(out, r.round_id);
  const log = accessLog.writer(file);
  runner.internals.withGenerator(knownGen, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV, accessLog: log }));
  const sel = runner.select({ roundId: r.round_id, sources: sources(), outDir: out, accessLog: log });
  require('./_mining_manifest').reviewAll(r.round_id);
  const score = (scoredAt) => runner.scoreHoldout({ roundId: r.round_id, sources: sources(), holdoutDir: hv.complete, outDir: out, scoredAt, holdoutFloor: COV, accessLog: log });
  assert.throws(() => score('2026-12-31T23:59:00+08:00'), code(/MINE_RUNNER_HOLDOUT_BEFORE_SEAL_END/));
  assert.equal(lines(file).filter((x) => x.op === 'HOLDOUT_READ').length, 0, 'a refused read before the date logs no read and spends no grant');
  assert.equal(authority.holdoutReadsOf('a'.repeat(64)).length, 0);
  const s = score('2027-01-06T10:00:00+08:00');
  assert.equal(s.opened, true);
  const reads = lines(file).filter((x) => x.op === 'HOLDOUT_READ');
  assert.deepEqual(reads.map((x) => x.principal), sel.selected.map(() => 'holdout-scorer'));
  const trial = new Map([...require('../services/trial-ledger').heads().values()].filter((t) => t.mining && t.mining.round_id === r.round_id).map((t) => [t.mining.candidate_id, t.rule_config.formula]));
  assert.deepEqual(reads.map((x) => x.candidateSha256).sort(), sel.selected.map((id) => accessLog.candidateSha256Of({ roundId: r.round_id, candidateId: id, formula: trial.get(id) })).sort());
  assert.ok(reads.every((x) => x.from === SEGMENTS.HOLDOUT.from && x.to === SEGMENTS.HOLDOUT.to));
  for (const x of reads) assert.equal(authority.holdoutReadsOf(x.candidateSha256).length, 1, 'the grant ledger has exactly one entry per candidate');
  assert.throws(() => score('2027-01-07T10:00:00+08:00'), code(/HOLDOUT_SECOND_READ_REFUSED|MINE_HOLDOUT_ALREADY_OPENED/));
  assert.equal(lines(file).filter((x) => x.op === 'HOLDOUT_READ').length, reads.length, 'a refused second read adds no read row');
  assert.ok(accessLog.verifyBytes(fs.readFileSync(file)).ok);
});

test('static: the round-runner CLI takes the generator lock after start() and before the first data read in generate, and passes the log to score and rescore', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'services/mining-sandbox/round-runner/cli.js'), 'utf8');
  const gen = cli.slice(cli.indexOf("if (cmd === 'generate')"), cli.indexOf("if (cmd === 'mechanisms')"));
  assert.ok(gen.indexOf('runner.start(') < gen.indexOf('lockGenerator(') && gen.indexOf('lockGenerator(') < gen.indexOf('adapter.buildPanel('), 'lock between start and the first panel read');
  assert.match(gen, /principal: 'mining-generator'/);
  assert.match(gen, /accessLog/);
  const tail = cli.slice(cli.indexOf("required(o, ['out', 'round', 'lane', 'tail', 'holdout'])"));
  assert.match(tail, /\.writer\(runner\.accessLogFile\(/);
  assert.equal((tail.match(/accessLog \}\)/g) || []).length >= 2, true, 'scoreHoldout and rescore both get it');
  assert.equal(/lockGenerator\(/.test(tail), false, 'the scorer is exempt from the lock');
});

/* -------------------------------------------------------------------- the AQ agent launcher */

function runNode(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { env });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const cardTask = () => ({ task_id: 'RQT-LINUX-20261122-aaaa1111', host: 'LINUX', agent_host: 'LINUX', kind: 'AI_REVIEW_CARD', market: 'CN_A', template_id: 'AI_REVIEW_CARD_V1', template_sha256: F.sha('tpl'), attempt_no: 1 });
const cardBundle = () => ({ schema: 'RQ_AGENT_BUNDLE_V1', market: 'CN_A', week_id: '2026-W47', pack: F.makePack(), registry: F.makeRegistry() });

test('AQ agent CLI: takes the lock, logs its fact-pack read as review-agent next to result.json; a bundle inside a holdout dir is refused and logged (exit 5, only the log is written)', async () => {
  const dir = tmp('w24-aq-');
  const sock = path.join(dir, 'gw.sock');
  const srv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: JSON.stringify(F.makeCard()) } }], usage: {} })); });
  });
  await new Promise((resolve) => srv.listen(sock, resolve));
  try {
    const inDir = path.join(dir, 'in'); fs.mkdirSync(inDir);
    fs.writeFileSync(path.join(inDir, 'task.json'), JSON.stringify(cardTask()));
    fs.writeFileSync(path.join(inDir, 'bundle.json'), JSON.stringify(cardBundle()));
    const cli = path.join(ROOT, 'services/research-queue-agent/cli.js');
    const env = { PATH: process.env.PATH, HOME: dir };
    const args = (out, bundle = path.join(inDir, 'bundle.json')) => [cli, '--task', path.join(inDir, 'task.json'), '--bundle', bundle, '--out', out, '--socket', sock, '--host', 'LINUX'];
    const ok = await runNode(args(path.join(dir, 'out')), env);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(fs.readdirSync(path.join(dir, 'out')).includes('access_log.jsonl'));
    const rows = lines(path.join(dir, 'out', 'access_log.jsonl'));
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].principal, rows[0].op, rows[0].dataset], ['review-agent', 'READ', 'REVIEW_FACT_PACK_V1']);
    assert.deepEqual([rows[0].from, rows[0].to], ['2026-11-20', '2026-11-20'], 'the span of the facts it was handed');
    assert.ok(accessLog.verifyBytes(fs.readFileSync(path.join(dir, 'out', 'access_log.jsonl'))).ok);

    const holdout = path.join(dir, 'holdout'); fs.mkdirSync(holdout);
    fs.writeFileSync(path.join(holdout, 'bundle.json'), JSON.stringify(cardBundle()));
    const refused = await runNode(args(path.join(dir, 'out2'), path.join(holdout, 'bundle.json')), { ...env, QRP_HOLDOUT_DATA_DIRS: holdout });
    assert.equal(refused.status, 5);
    assert.match(refused.stderr, /VERIFIER_HOLDOUT_READ_REFUSED/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'out2')), ['access_log.jsonl']);
    const rr = lines(path.join(dir, 'out2', 'access_log.jsonl'));
    assert.deepEqual([rr[0].principal, rr[0].op, rr[0].refused], ['review-agent', 'HOLDOUT_READ', true]);
  } finally { srv.close(); }
});
