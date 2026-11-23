'use strict';
/**
 * #147 W24 host driver. Frozen acceptance: AQ_HEAVY_RUN_TEMPLATES_V1_FREEZE_1
 * 554d137e plus ADDENDUM_1..6. All host effects are injected; this file never
 * starts docker/systemd, opens a network connection, or connects to a database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const driver = require('../services/research-lab-e2e/host-driver');
const launch = require('../services/research-lab-e2e/experiment-launch');
const backtester = require('../services/research-lab-e2e/backtester');
const verifierConfig = require('../config/independent_verifier.v1.json');

// Copied from W24_STAR_DEFAULTS_FREEZE_V1.md f180443f, never derived from code.
const FROZEN_DEFAULTS_FIXTURE = Object.freeze({
  bhyAlpha: 0.05,
  participationCap: 0.10,
  PORTFOLIO_WEIGHT: 0.2,
  DEFAULT_INITIAL_NAV: 1e8,
  DEFAULT_QUANTILE: 0.2,
  COST_RESERVE: 0.003,
});
const REQUIRED_ENV = Object.freeze({
  RQ_TASK_ID: 'RQT-LINUX-20261124-abcddcba',
  RQ_PAUSE_FILE: '/run/user/1000/rq/pause',
  RQ_GATES_FILE: '/run/user/1000/rq/gates.json',
  RQ_CONTAINER_PREFIX: 'rq-task-RQT-LINUX-20261124-abcddcba-',
  RQ_RESUME: '0',
  DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
  LC_ALL: 'C.UTF-8',
  LANG: 'C.UTF-8',
});
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(over = {}) {
  const root = tmp('qrp-q147');
  const attempt = path.join(root, 'attempt-1'); fs.mkdirSync(attempt);
  const runDir = path.join(root, 'run'); fs.mkdirSync(runDir);
  const outDir = path.join(runDir, 'lab'); fs.mkdirSync(outDir);
  const dataDir = path.join(root, 'qrp-var'); fs.mkdirSync(dataDir);
  const witness = path.join(root, 'W24_STAR_DEFAULTS_FREEZE_V1.md');
  fs.writeFileSync(witness, 'frozen witness\n');
  const registrar = path.join(root, 'k2_trl_registrar.js'); fs.writeFileSync(registrar, '#!/usr/bin/env node\n'); fs.chmodSync(registrar, 0o755);
  const requestOutbox = path.join(runDir, 'outbox', 'trl-requests');
  const receiptInbox = path.join(runDir, 'inbox', 'trl-receipts');
  const env = {
    ...REQUIRED_ENV,
    RQ_ATTEMPT_DIR: attempt,
    RQ_RUN_DIR: runDir,
    QRP_DATA_DIR: dataDir,
  };
  const job = { schema: 'LAB_E2E_JOB_V1', card_id: 'RQT-LINUX-20261124-abcddcba', market: 'CN_A', as_of: '2026-11-24T09:00:00+08:00', out_dir: outDir, files: {} };
  const config = {
    witness: { path: witness, sha256: sha(fs.readFileSync(witness)) },
    constants: FROZEN_DEFAULTS_FIXTURE,
    registrar: { executable: registrar, requestOutbox, receiptInbox },
    experiment: {
      cardId: job.card_id,
      image: 'qrp-round-runner@sha256:' + 'a'.repeat(64),
      laneCopy: '/srv/research-lane/rf1116-mining/data/lane',
      valTail: '/srv/research-lane/rf1116-mining/data/tail',
      outDir: '/srv/research-lane/rf1116-mining/out/w24',
      holdoutRef: 'lane:rf1116-mining/holdout-sealed/x',
      holdoutSha256: 'b'.repeat(64),
      authority: 'V8_1_COORDINATOR',
    },
    dataGuard: { authoritativeDir: dataDir, candidates: [{ path: dataDir }] },
    disk: { floorBytes: 150 * (2 ** 30), predictedPeakBytes: 20 * (2 ** 30) },
    db: { mode: 'NONE' },
  };
  return { root, attempt, runDir, outDir, dataDir, witness, registrar, requestOutbox, receiptInbox, env, job, config, ...over };
}

function run(f, over = {}) {
  const effects = {
    labRun: () => ({ status: 'COMPLETE', terminal_state: 'FROZEN_AWAITING_HOLDOUT' }),
    dockerRun: () => ({ status: 0, stdout: '{"round_id":"MR-CN_A-W24"}\n', stderr: '' }),
    availableBytes: () => f.config.disk.floorBytes + f.config.disk.predictedPeakBytes + 1,
    isWritable: (p) => p === f.dataDir,
    ...over,
  };
  return driver.runDriver({ job: f.job, baseServices: {}, config: f.config, env: f.env, effects });
}

test('W24 constants in QRP equal the literal frozen witness fixture', () => {
  assert.deepEqual({
    bhyAlpha: verifierConfig.bhyAlpha,
    participationCap: verifierConfig.participationCap,
    PORTFOLIO_WEIGHT: backtester.PORTFOLIO_WEIGHT,
    DEFAULT_INITIAL_NAV: backtester.DEFAULT_INITIAL_NAV,
    DEFAULT_QUANTILE: backtester.DEFAULT_QUANTILE,
    COST_RESERVE: backtester.COST_RESERVE,
  }, FROZEN_DEFAULTS_FIXTURE);
});

test('P2 is a FILE_SHA witness, not parsed config: a mismatch waits before the chain, a match runs', () => {
  const bad = fixture(); bad.config.witness.sha256 = '0'.repeat(64);
  let called = 0;
  const a = run(bad, { labRun: () => { called += 1; return { status: 'COMPLETE' }; } });
  assert.deepEqual([a.exit, a.reason, called], [75, 'WAITING_EXTERNAL:HEAVY_PRECONDITION', 0]);
  assert.equal(readJson(path.join(bad.attempt, 'driver-result.json')).reason, 'WAITING_EXTERNAL:HEAVY_PRECONDITION');

  const good = fixture();
  const b = run(good, { labRun: () => { called += 1; return { status: 'COMPLETE', terminal_state: 'FROZEN_AWAITING_HOLDOUT' }; } });
  assert.deepEqual([b.exit, called], [0, 1]);
});

test('closed HEAVY_DRIVER_V1 exits always write driver-result first with exact base fields', () => {
  const cases = [
    ['complete', {}, { labRun: () => ({ status: 'COMPLETE', terminal_state: 'FROZEN_AWAITING_FORWARD' }) }, 0, 'COMPLETE:FROZEN_AWAITING_FORWARD'],
    ['wait', {}, { labRun: () => ({ status: 'WAITING_EXTERNAL', waiting: 'TRL_RECEIPT' }) }, 75, 'WAITING_EXTERNAL:TRL_RECEIPT'],
    ['floor', {}, { availableBytes: () => 150 * (2 ** 30) - 1 }, 3, 'GUARD_DISK_FLOOR'],
    ['peak', {}, { availableBytes: () => 150 * (2 ** 30) + 20 * (2 ** 30) - 1 }, 4, 'PREDICTED_DISK_FLOOR'],
    ['bad-config', { experiment: { image: '' } }, {}, 64, 'INVALID_DRIVER_CONFIG'],
    ['bad-resume', {}, {}, 65, 'INVALID_RESUME_STATE'],
    ['refused', {}, { labRun: () => ({ status: 'REFUSED', reason_code: 'LAB_DSL_INVALID' }) }, 66, 'REFUSED:LAB_DSL_INVALID'],
    ['unexpected', {}, { labRun: () => { throw new Error('boom'); } }, 1, 'UNEXPECTED:boom'],
  ];
  for (const [name, patch, effects, exit, reason] of cases) {
    const f = fixture(); Object.assign(f.config, patch);
    if (name === 'bad-resume') {
      f.env.RQ_RESUME = '1';
      fs.writeFileSync(path.join(f.outDir, 'chain.json'), '{"status":"REFUSED"}\n');
    }
    const r = run(f, effects);
    assert.equal(r.exit, exit, name);
    const result = readJson(path.join(f.attempt, 'driver-result.json'));
    assert.deepEqual(Object.keys(result).sort(), ['exit', 'last_date', 'reason', 'sessions_done', 'sessions_total'], name);
    assert.deepEqual([result.exit, result.reason], [exit, reason], name);
    assert.equal((fs.statSync(path.join(f.attempt, 'driver-result.json')).mode & 0o777), 0o444, name);
  }
});

test('quota/provider/credential generator waits remain waiting, never FAILED', () => {
  for (const waiting of ['WAITING_QUOTA', 'WAITING_PROVIDER', 'WAITING_CREDENTIAL']) {
    const f = fixture();
    const e = Object.assign(new Error(`EXPERIMENT_LAUNCH_WAITING:${waiting}`), { code: 'EXPERIMENT_LAUNCH_WAITING', detail: waiting });
    const r = run(f, { labRun: () => { throw e; } });
    assert.deepEqual([r.exit, r.reason], [75, waiting]);
  }
});

test('host experiment service sends exactly containerSpec argv to the injected synchronous docker runner', () => {
  const f = fixture(); const calls = [];
  const r = run(f, {
    dockerRun: (argv) => { calls.push(argv); return { status: 0, stdout: '{"round_id":"MR-CN_A-W24"}\n', stderr: '' }; },
    labRun: (_job, services) => { services.experiment.execute({ formulas: ['rank(pb)'] }); return { status: 'COMPLETE', terminal_state: 'FROZEN_AWAITING_HOLDOUT' }; },
  });
  assert.equal(r.exit, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], launch.containerSpec(f.config.experiment).argv);
  assert.equal(JSON.stringify(calls[0]).includes('holdout-sealed/'), false, 'the sealed holdout is a ref, never a mount');
});

test('Linux registrar seam writes one request and reads only the matching receipt from the run inbox', () => {
  const f = fixture();
  const reg = driver.makeRegistrar(f.config.registrar);
  const prepared = { trl_request: { schema: 'TRIAL_REGISTRATION_REQUEST_V1', draft_id: 'D1' }, prepared: { request_sha256: '' } };
  prepared.prepared.request_sha256 = sha(Buffer.from(driver.canonical(prepared.trl_request)));
  assert.equal(reg(prepared), null);
  const requestFile = path.join(f.requestOutbox, `${prepared.prepared.request_sha256}.json`);
  assert.equal(fs.existsSync(requestFile), true);
  assert.equal((fs.statSync(requestFile).mode & 0o777), 0o444);
  const receipt = { schema: 'TRIAL_REGISTRATION_RECEIPT_V1', request_sha256: prepared.prepared.request_sha256, rows: [] };
  fs.mkdirSync(f.receiptInbox, { recursive: true });
  fs.writeFileSync(path.join(f.receiptInbox, `${prepared.prepared.request_sha256}.json`), JSON.stringify(receipt));
  assert.deepEqual(reg(prepared), receipt);

  fs.writeFileSync(path.join(f.receiptInbox, `${'f'.repeat(64)}.json`), JSON.stringify({ ...receipt, request_sha256: 'f'.repeat(64) }));
  assert.deepEqual(reg(prepared), receipt, 'an unrelated receipt is ignored');
});

test('missing Linux registrar has a distinct step-6 wait, not a manual fallback', () => {
  const f = fixture(); fs.rmSync(f.registrar);
  const reg = driver.makeRegistrar(f.config.registrar);
  assert.throws(() => reg({ prepared: { request_sha256: 'a'.repeat(64) }, trl_request: {} }), (e) => e.code === 'LINUX_REGISTRAR_UNAVAILABLE');
});

test('QRP data guard refuses dual writers and manifest mismatch; one writer and a read-only Mac backup pass', () => {
  const f = fixture(); const mac = path.join(f.root, 'mac-var'); fs.mkdirSync(mac);
  const linuxManifest = path.join(f.root, 'linux.sha256'); const macManifest = path.join(f.root, 'mac.sha256');
  fs.writeFileSync(linuxManifest, 'same\n'); fs.writeFileSync(macManifest, 'same\n');
  const cfg = { authoritativeDir: f.dataDir, candidates: [{ path: f.dataDir, manifest: linuxManifest }, { path: mac, manifest: macManifest }] };
  assert.throws(() => driver.guardDataDir(cfg, { qrpDataDir: f.dataDir, isWritable: () => true }), (e) => e.code === 'QRP_VAR_DUAL_WRITABLE');
  assert.equal(driver.guardDataDir(cfg, { qrpDataDir: f.dataDir, isWritable: (p) => p === f.dataDir }), f.dataDir);
  fs.writeFileSync(macManifest, 'different\n');
  assert.throws(() => driver.guardDataDir(cfg, { qrpDataDir: f.dataDir, isWritable: (p) => p === f.dataDir }), (e) => e.code === 'QRP_VAR_MANIFEST_MISMATCH');
  fs.writeFileSync(macManifest, 'same\n');
  assert.equal(driver.guardDataDir(cfg, { qrpDataDir: f.dataDir, isWritable: (p) => p === f.dataDir }), f.dataDir, 'read-only Mac copy is allowed');
});

test('the exact engine connection probe gates DB work; PGOPTIONS is never accepted as proof', () => {
  const falseProbe = { role: 'qrp_lab', source: 'OPTIONS', transactionReadOnly: false, writeAttemptSqlstate: null };
  const bad = fixture(); bad.config.db = { mode: 'READ_ONLY' }; bad.env.PGOPTIONS = '-c default_transaction_read_only=on';
  let started = 0;
  const a = run(bad, { dbReadOnlyProbe: () => falseProbe, labRun: () => { started += 1; return { status: 'COMPLETE' }; } });
  assert.deepEqual([a.exit, a.reason, started], [75, 'WAITING_EXTERNAL:DB_NOT_READ_ONLY', 0]);
  assert.deepEqual(readJson(path.join(bad.attempt, 'driver-result.json')).dbReadOnlyProbe, falseProbe);

  const good = fixture(); good.config.db = { mode: 'READ_ONLY' };
  const trueProbe = { role: 'qrp_lab', source: 'ROLE_DEFAULT', transactionReadOnly: true, writeAttemptSqlstate: '25006' };
  const b = run(good, { dbReadOnlyProbe: () => trueProbe, labRun: () => { started += 1; return { status: 'COMPLETE', terminal_state: 'FROZEN_AWAITING_HOLDOUT' }; } });
  assert.deepEqual([b.exit, started], [0, 1]);
  assert.deepEqual(readJson(path.join(good.attempt, 'driver-result.json')).dbReadOnlyProbe, trueProbe);

  const waived = fixture(); waived.config.db = { mode: 'READ_ONLY', waiver: { reason: 'frozen exception' } };
  assert.equal(run(waived, { dbReadOnlyProbe: () => ({ role: 'qrp_lab', source: 'WAIVED', transactionReadOnly: false, writeAttemptSqlstate: null }) }).exit, 64, 'WAIVED without pinRecordSha256 is refused');
});

test('resume is allowed for an external wait and safe pre-experiment partial work, but not a refusal or partial experiment', () => {
  const waiting = fixture(); waiting.env.RQ_RESUME = '1';
  fs.writeFileSync(path.join(waiting.outDir, 'chain.json'), '{"status":"WAITING_EXTERNAL"}\n');
  assert.equal(run(waiting).exit, 0);

  const preExperiment = fixture(); preExperiment.env.RQ_RESUME = '1';
  fs.mkdirSync(path.join(preExperiment.outDir, 'steps', '06_K2_FREEZE'), { recursive: true });
  fs.writeFileSync(path.join(preExperiment.outDir, 'steps', '06_K2_FREEZE', 'k2_binding.json'), '{}\n');
  assert.equal(run(preExperiment).exit, 0);

  const partialExperiment = fixture(); partialExperiment.env.RQ_RESUME = '1';
  fs.mkdirSync(path.join(partialExperiment.outDir, 'steps', '07_EXPERIMENT'), { recursive: true });
  fs.writeFileSync(path.join(partialExperiment.outDir, 'steps', '07_EXPERIMENT', 'selection.json'), '{}\n');
  assert.deepEqual([run(partialExperiment).exit, readJson(path.join(partialExperiment.attempt, 'driver-result.json')).reason], [65, 'INVALID_PARTIAL_EXPERIMENT']);
});

test('promotion results and terms are create-only 0444 under QRP_DATA_DIR; a second non-resume evaluation is refused', () => {
  const f = fixture();
  const terms = { schema: 'PROMOTION_TERMS_V1', candidate_id: 'CAND-1', k2_sha256: 'a'.repeat(64) };
  const engine = { evaluate: (req) => ({ schema: 'PROMOTION_RESULT_V1', candidate_id: req.candidate_id, stage: req.requested_stage, verdict: 'INSUFFICIENT', output_sha256: 'b'.repeat(64) }) };
  const wrapped = driver.persistingEngine(engine, { dataDir: f.dataDir, resume: false });
  const req = { candidate_id: 'CAND-1', requested_stage: 'S2', as_of: f.job.as_of, terms };
  const result = wrapped.evaluate(req);
  assert.equal(result.verdict, 'INSUFFICIENT');
  const resultPath = path.join(f.dataDir, 'research', 'promotion', 'results', `CAND-1.S2.${f.job.as_of}.json`);
  const termsBytes = driver.prettyJson(terms); const termsPath = path.join(f.dataDir, 'research', 'promotion', 'terms', sha(termsBytes));
  for (const file of [resultPath, termsPath]) {
    assert.equal(fs.existsSync(file), true, file);
    assert.equal((fs.statSync(file).mode & 0o777), 0o444, file);
    assert.equal(path.resolve(file).startsWith(`${path.resolve(f.dataDir)}${path.sep}`), true, file);
  }
  assert.throws(() => wrapped.evaluate(req), (e) => e.code === 'PROMOTION_RESULT_EXISTS');
  const replay = driver.persistingEngine(engine, { dataDir: f.dataDir, resume: true });
  assert.deepEqual(replay.evaluate(req), result, 'resume reuses byte-identical output without rewriting it');
});

test('driver-result is create-only: a second writer cannot replace the first bytes', () => {
  const f = fixture(); const file = path.join(f.attempt, 'driver-result.json');
  driver.writeDriverResult(file, { exit: 75, sessions_done: 0, sessions_total: 1, last_date: null, reason: 'WAITING_EXTERNAL:TRL_RECEIPT' });
  const before = fs.readFileSync(file);
  assert.throws(() => driver.writeDriverResult(file, { exit: 0, sessions_done: 1, sessions_total: 1, last_date: '2026-11-24', reason: 'COMPLETE' }), (e) => e.code === 'DRIVER_RESULT_EXISTS');
  assert.equal(fs.readFileSync(file).equals(before), true);
});
