'use strict';

/**
 * Host wiring for the W24 LAB_E2E_JOB_V1 heavy run.
 *
 * This module owns only host seams: synchronous docker invocation (injected in
 * tests), Linux TRL request/receipt exchange, the QRP var cutover guard,
 * promotion-result persistence, and HEAVY_DRIVER_V1's result. It does not own
 * the lab decisions, queue state transitions, docker/systemd supervision, or a
 * database connection factory.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const labDefault = require('./index');
const experimentLaunch = require('./experiment-launch');
const promotionDefault = require('../promotion-engine');
const backtester = require('./backtester');
const verifierConfig = require('../../config/independent_verifier.v1.json');
const { canonicalJson: canonical, prettyJson } = require('../k2-freeze-program/common');

const EXIT = Object.freeze({ COMPLETE: 0, FAILURE: 1, GUARD_DISK: 3, PREDICTED_DISK: 4, PAUSE: 75, INVALID_CONFIG: 64, INVALID_RESUME: 65, REFUSED: 66 });
const GIB = 2 ** 30;
const SHA64 = /^[0-9a-f]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_.:+-]+$/;
const REQUIRED_ENV = Object.freeze(['RQ_TASK_ID', 'RQ_ATTEMPT_DIR', 'RQ_RUN_DIR', 'RQ_PAUSE_FILE', 'RQ_GATES_FILE', 'RQ_CONTAINER_PREFIX', 'RQ_RESUME', 'DOCKER_HOST', 'LC_ALL', 'LANG', 'QRP_DATA_DIR']);
const FROZEN_DEFAULTS = Object.freeze({ bhyAlpha: 0.05, participationCap: 0.10, PORTFOLIO_WEIGHT: 0.2, DEFAULT_INITIAL_NAV: 1e8, DEFAULT_QUANTILE: 0.2, COST_RESERVE: 0.003 });
const ACTUAL_DEFAULTS = () => ({ bhyAlpha: verifierConfig.bhyAlpha, participationCap: verifierConfig.participationCap, PORTFOLIO_WEIGHT: backtester.PORTFOLIO_WEIGHT,
  DEFAULT_INITIAL_NAV: backtester.DEFAULT_INITIAL_NAV, DEFAULT_QUANTILE: backtester.DEFAULT_QUANTILE, COST_RESERVE: backtester.COST_RESERVE });

class DriverError extends Error {
  constructor(code, detail = null, exit = EXIT.INVALID_CONFIG) {
    super(detail === null ? code : `${code}:${detail}`);
    this.code = code; this.detail = detail; this.exit = exit;
  }
}
const fail = (code, detail, exit) => { throw new DriverError(code, detail, exit); };
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const under = (root, file) => { const r = path.resolve(root); const f = path.resolve(file); return f === r || f.startsWith(`${r}${path.sep}`); };
const safeReason = (s) => String(s === undefined || s === null ? 'UNKNOWN' : s).replace(/[\r\n]/g, ' ').slice(0, 160);

function writeCreateOnly(file, bytes, mode = 0o444, existsCode = 'ARTIFACT_EXISTS') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pending = `${file}.new`;
  let fd = null;
  try {
    fd = fs.openSync(pending, 'wx', mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, mode);
    fs.closeSync(fd); fd = null;
    fs.linkSync(pending, file); // atomic create-only publication; link refuses an existing destination
    fs.unlinkSync(pending);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    try { fs.unlinkSync(pending); } catch { /* absent or another writer owns it */ }
    if (e && e.code === 'EEXIST') throw new DriverError(existsCode);
    throw e;
  }
}

/** Create-only result. The queue supervisor stores these exact bytes verbatim. */
function writeDriverResult(file, result) {
  const baseKeys = ['exit', 'sessions_done', 'sessions_total', 'last_date', 'reason'];
  if (!isObj(result) || !baseKeys.every((k) => Object.prototype.hasOwnProperty.call(result, k))) fail('DRIVER_RESULT_INVALID');
  const allowed = new Set([...baseKeys, 'dbReadOnlyProbe']);
  if (Object.keys(result).some((k) => !allowed.has(k))) fail('DRIVER_RESULT_INVALID');
  try { writeCreateOnly(file, Buffer.from(`${canonical(result)}\n`), 0o444, 'DRIVER_RESULT_EXISTS'); } catch (e) { if (e.code === 'DRIVER_RESULT_EXISTS') throw e; throw e; }
}

function validateEnv(env) {
  for (const key of REQUIRED_ENV) if (typeof env[key] !== 'string' || env[key] === '') fail('DRIVER_ENV_MISSING', key);
  for (const key of ['RQ_ATTEMPT_DIR', 'RQ_RUN_DIR', 'RQ_PAUSE_FILE', 'RQ_GATES_FILE', 'QRP_DATA_DIR']) if (!path.isAbsolute(env[key])) fail('DRIVER_ENV_PATH_INVALID', key);
  if (!/^[A-Za-z0-9_.:-]+$/.test(env.RQ_TASK_ID)) fail('DRIVER_TASK_ID_INVALID');
  if (env.RQ_CONTAINER_PREFIX !== `rq-task-${env.RQ_TASK_ID}-`) fail('DRIVER_CONTAINER_PREFIX_INVALID');
  if (!['0', '1'].includes(env.RQ_RESUME)) fail('DRIVER_RESUME_FLAG_INVALID');
}

function validateConfig(config, job, env) {
  if (!isObj(config) || !isObj(config.witness) || !path.isAbsolute(config.witness.path || '') || !SHA64.test(config.witness.sha256 || '')) fail('INVALID_DRIVER_CONFIG');
  if (!isObj(config.experiment) || typeof config.experiment.image !== 'string' || !/@sha256:[0-9a-f]{64}$/.test(config.experiment.image)) fail('INVALID_DRIVER_CONFIG');
  if (!isObj(config.registrar) || !path.isAbsolute(config.registrar.executable || '') || !path.isAbsolute(config.registrar.requestOutbox || '') || !path.isAbsolute(config.registrar.receiptInbox || '')) fail('INVALID_DRIVER_CONFIG');
  for (const [name, file] of [['requestOutbox', config.registrar.requestOutbox], ['receiptInbox', config.registrar.receiptInbox]]) {
    if (!under(env.RQ_RUN_DIR, file)) fail('DRIVER_PATH_OUTSIDE_RUN', `registrar.${name}`);
  }
  if (!isObj(config.disk) || !Number.isSafeInteger(config.disk.floorBytes) || config.disk.floorBytes !== 150 * GIB || !Number.isSafeInteger(config.disk.predictedPeakBytes) || config.disk.predictedPeakBytes < 0) fail('INVALID_DRIVER_CONFIG');
  if (!isObj(config.db) || !['NONE', 'READ_ONLY'].includes(config.db.mode)) fail('INVALID_DRIVER_CONFIG');
  if (!isObj(job) || job.schema !== 'LAB_E2E_JOB_V1' || typeof job.card_id !== 'string' || !job.card_id || !under(env.RQ_RUN_DIR, job.out_dir || '')) fail('INVALID_DRIVER_CONFIG');
  if (config.experiment.cardId !== job.card_id) fail('INVALID_DRIVER_CONFIG');
  if (config.constants && canonical(config.constants) !== canonical(FROZEN_DEFAULTS)) fail('INVALID_DRIVER_CONFIG');
}

function defaultsMatch() { return canonical(ACTUAL_DEFAULTS()) === canonical(FROZEN_DEFAULTS); }

/**
 * Fail-closed guard for the one authoritative QRP var. Writability is injected
 * in tests because chmod/access semantics vary for privileged CI users.
 */
function guardDataDir(config, { qrpDataDir, isWritable = null } = {}) {
  if (!isObj(config) || typeof config.authoritativeDir !== 'string' || !Array.isArray(config.candidates) || !config.candidates.length) fail('QRP_VAR_GUARD_INVALID');
  const authority = path.resolve(config.authoritativeDir); const selected = path.resolve(qrpDataDir || '');
  if (authority !== selected) fail('QRP_VAR_AUTHORITY_MISMATCH');
  const writable = isWritable || ((p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } });
  const candidates = config.candidates.map((c) => ({ ...c, resolved: path.resolve(c.path || '') }));
  if (new Set(candidates.map((c) => c.resolved)).size !== candidates.length || !candidates.some((c) => c.resolved === authority)) fail('QRP_VAR_GUARD_INVALID');
  if (candidates.filter((c) => writable(c.resolved)).length > 1) fail('QRP_VAR_DUAL_WRITABLE');
  if (!writable(authority)) fail('QRP_VAR_AUTHORITY_NOT_WRITABLE');
  const a = candidates.find((c) => c.resolved === authority);
  if (a.manifest) {
    let bytes;
    try { bytes = fs.readFileSync(a.manifest); } catch { fail('QRP_VAR_MANIFEST_MISMATCH'); }
    for (const c of candidates) {
      if (c === a || !c.manifest) continue;
      let other; try { other = fs.readFileSync(c.manifest); } catch { fail('QRP_VAR_MANIFEST_MISMATCH'); }
      if (!bytes.equals(other)) fail('QRP_VAR_MANIFEST_MISMATCH');
    }
  }
  return authority;
}

function writeRequest(file, request) {
  const bytes = Buffer.from(`${canonical(request)}\n`);
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(bytes)) fail('TRL_REQUEST_REPLAY_MISMATCH');
    return;
  }
  writeCreateOnly(file, bytes, 0o444, 'TRL_REQUEST_EXISTS');
}

/** k2.register: request goes to the registrar outbox; only its matching receipt is read from the run inbox. */
function makeRegistrar(config) {
  return function register(prepared) {
    try { fs.accessSync(config.executable, fs.constants.X_OK); } catch { throw new DriverError('LINUX_REGISTRAR_UNAVAILABLE'); }
    const request = prepared && prepared.trl_request; const want = prepared && prepared.prepared && prepared.prepared.request_sha256;
    if (!isObj(request) || !SHA64.test(want || '') || sha256(Buffer.from(canonical(request))) !== want) throw new DriverError('TRL_REQUEST_INVALID');
    writeRequest(path.join(config.requestOutbox, `${want}.json`), request);
    const file = path.join(config.receiptInbox, `${want}.json`);
    if (!fs.existsSync(file)) return null;
    let receipt; try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new DriverError('TRL_RECEIPT_INVALID'); }
    if (!isObj(receipt) || receipt.schema !== 'TRIAL_REGISTRATION_RECEIPT_V1' || receipt.request_sha256 !== want || !Array.isArray(receipt.rows)) throw new DriverError('TRL_RECEIPT_INVALID');
    return receipt;
  };
}

function safePromotionPath(dataDir, kind, name) {
  if (!SAFE_SEGMENT.test(name) || name.includes('..')) fail('PROMOTION_PATH_INVALID');
  const file = path.resolve(dataDir, 'research', 'promotion', kind, name);
  if (!under(dataDir, file)) fail('PROMOTION_PATH_INVALID');
  return file;
}

/** Persist every engine decision for the monthly pause re-check. */
function persistingEngine(engine, { dataDir, resume = false } = {}) {
  if (!engine || typeof engine.evaluate !== 'function' || !path.isAbsolute(dataDir || '')) fail('PROMOTION_HOST_INVALID');
  return {
    ...engine,
    evaluate(request) {
      const candidate = request && request.candidate_id; const stage = request && request.requested_stage; const asOf = request && request.as_of;
      for (const s of [candidate, stage, asOf]) if (typeof s !== 'string' || !SAFE_SEGMENT.test(s) || s.includes('..')) fail('PROMOTION_PATH_INVALID');
      if (!isObj(request.terms)) fail('PROMOTION_TERMS_INVALID');
      const resultFile = safePromotionPath(dataDir, 'results', `${candidate}.${stage}.${asOf}.json`);
      if (fs.existsSync(resultFile)) {
        if (!resume) throw new DriverError('PROMOTION_RESULT_EXISTS');
        let stored;
        try { stored = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { throw new DriverError('PROMOTION_RESULT_INVALID'); }
        const termsSha = sha256(prettyJson(request.terms));
        const evidenceSha = isObj(request.evidence) ? sha256(prettyJson(request.evidence)) : null;
        if (!isObj(stored) || stored.candidate_id !== candidate || stored.stage !== stage || stored.as_of !== asOf || !isObj(stored.inputs)
          || stored.inputs.terms_sha256 !== termsSha || stored.inputs.evidence_sha256 !== evidenceSha) throw new DriverError('PROMOTION_RESULT_REPLAY_MISMATCH');
        return stored;
      }
      const termsBytes = prettyJson(request.terms); const termsFile = safePromotionPath(dataDir, 'terms', sha256(termsBytes));
      if (fs.existsSync(termsFile)) {
        if (!fs.readFileSync(termsFile).equals(termsBytes)) fail('PROMOTION_TERMS_SHA_COLLISION');
      } else writeCreateOnly(termsFile, termsBytes, 0o444, 'PROMOTION_TERMS_EXISTS');
      const result = engine.evaluate(request);
      writeCreateOnly(resultFile, prettyJson(result), 0o444, 'PROMOTION_RESULT_EXISTS');
      return result;
    },
  };
}

function validateResume(job, resume) {
  const outDir = job.out_dir; const entries = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  if (!resume) {
    if (entries.length) throw new DriverError('INVALID_RUN_DIR_REUSED', null, EXIT.INVALID_RESUME);
    return;
  }
  const expDir = path.join(outDir, 'steps', '07_EXPERIMENT'); const exp = path.join(expDir, 'experiment.json');
  if (fs.existsSync(expDir) && !fs.existsSync(exp)) throw new DriverError('INVALID_PARTIAL_EXPERIMENT', null, EXIT.INVALID_RESUME);
  if (fs.existsSync(exp)) {
    try {
      const x = JSON.parse(fs.readFileSync(exp, 'utf8'));
      const required = ['generation_log.jsonl', 'generate.json', 'selection.json', 'access_log.jsonl'];
      if (!isObj(x) || x.schema !== 'LAB_EXPERIMENT_V1' || !isObj(x.files)) throw new Error('schema');
      for (const name of required) {
        const ref = x.files[name]; const file = path.join(expDir, name);
        if (!isObj(ref) || !SHA64.test(ref.sha256 || '') || !fs.existsSync(file) || sha256(fs.readFileSync(file)) !== ref.sha256) throw new Error(name);
      }
    } catch { throw new DriverError('INVALID_PARTIAL_EXPERIMENT', null, EXIT.INVALID_RESUME); }
  }
  const chainFile = path.join(outDir, 'chain.json');
  if (!fs.existsSync(chainFile)) return; // T1 before chain finalization: steps 1-6 are deterministic; step 7 was validated above.
  let chain; try { chain = JSON.parse(fs.readFileSync(chainFile, 'utf8')); } catch { throw new DriverError('INVALID_RESUME_STATE', null, EXIT.INVALID_RESUME); }
  if (chain.status !== 'WAITING_EXTERNAL') throw new DriverError('INVALID_RESUME_STATE', null, EXIT.INVALID_RESUME);
}

function diskAvailableBytes(dir) {
  if (typeof fs.statfsSync !== 'function') fail('DISK_PROBE_UNAVAILABLE');
  const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize);
}

function validateDbProbe(db, probe) {
  if (!isObj(probe) || typeof probe.role !== 'string' || !['ROLE_DEFAULT', 'OPTIONS', 'WAIVED'].includes(probe.source) || typeof probe.transactionReadOnly !== 'boolean' || !(probe.writeAttemptSqlstate === null || typeof probe.writeAttemptSqlstate === 'string')) fail('DB_READ_ONLY_PROBE_INVALID');
  if (probe.source === 'WAIVED') {
    if (!isObj(db.waiver) || typeof db.waiver.reason !== 'string' || !db.waiver.reason || !SHA64.test(db.waiver.pinRecordSha256 || '')) fail('DB_READ_ONLY_WAIVER_INVALID');
    return true;
  }
  return probe.transactionReadOnly === true && probe.writeAttemptSqlstate === '25006';
}

function resultOf(exit, reason, job, dbReadOnlyProbe = undefined) {
  return { exit, sessions_done: exit === EXIT.COMPLETE ? 1 : 0, sessions_total: 1, last_date: exit === EXIT.COMPLETE ? job.as_of.slice(0, 10) : null, reason,
    ...(dbReadOnlyProbe === undefined ? {} : { dbReadOnlyProbe }) };
}

function waitReason(waiting) {
  const code = safeReason(waiting);
  if (code === 'WAITING_QUOTA') return code;
  if (code === 'WAITING_CREDENTIAL' || /^WAITING_KEY_(ABSENT|REJECTED)$/.test(code)) return 'WAITING_CREDENTIAL';
  if (code === 'WAITING_PROVIDER' || /^WAITING_(PROVIDER_UNAVAILABLE|RATE_LIMITED|STEP_NO_RESPONSE)$/.test(code)) return 'WAITING_PROVIDER';
  return `WAITING_EXTERNAL:${code}`;
}

/** Drive one W24 job and always write the closed HEAVY_DRIVER_V1 result. */
function runDriver({ job, baseServices = {}, config, env = process.env, effects = {} } = {}) {
  let outcome; let dbProbe;
  try {
    validateEnv(env); validateConfig(config, job, env);
    const resultFile = path.join(env.RQ_ATTEMPT_DIR, 'driver-result.json');
    if (fs.existsSync(resultFile)) throw new DriverError('DRIVER_RESULT_EXISTS', null, EXIT.INVALID_RESUME);
    if (!defaultsMatch()) outcome = resultOf(EXIT.PAUSE, 'WAITING_EXTERNAL:HEAVY_PRECONDITION', job);
    else {
      let witnessOk = false; try { witnessOk = sha256(fs.readFileSync(config.witness.path)) === config.witness.sha256; } catch { witnessOk = false; }
      if (!witnessOk) outcome = resultOf(EXIT.PAUSE, 'WAITING_EXTERNAL:HEAVY_PRECONDITION', job);
    }
    if (!outcome) {
      guardDataDir(config.dataGuard, { qrpDataDir: env.QRP_DATA_DIR, isWritable: effects.isWritable });
      validateResume(job, env.RQ_RESUME === '1');
      const available = (effects.availableBytes || (() => diskAvailableBytes(env.RQ_RUN_DIR)))();
      if (!Number.isFinite(available)) fail('DISK_PROBE_INVALID');
      if (available < config.disk.floorBytes) outcome = resultOf(EXIT.GUARD_DISK, 'GUARD_DISK_FLOOR', job);
      else if (available < config.disk.floorBytes + config.disk.predictedPeakBytes) outcome = resultOf(EXIT.PREDICTED_DISK, 'PREDICTED_DISK_FLOOR', job);
    }
    if (!outcome && config.db.mode === 'READ_ONLY') {
      const probeFn = effects.dbReadOnlyProbe || baseServices.dbReadOnlyProbe;
      if (typeof probeFn !== 'function') fail('DB_READ_ONLY_PROBE_MISSING');
      dbProbe = probeFn();
      if (!validateDbProbe(config.db, dbProbe)) outcome = resultOf(EXIT.PAUSE, 'WAITING_EXTERNAL:DB_NOT_READ_ONLY', job, dbProbe);
    }
    if (!outcome) {
      const dockerRun = effects.dockerRun;
      if (typeof dockerRun !== 'function') fail('DOCKER_RUN_REQUIRED');
      const services = {
        ...baseServices,
        k2: { ...(baseServices.k2 || {}), register: makeRegistrar(config.registrar) },
        experiment: experimentLaunch.dockerExecutor({ ...config.experiment, run: dockerRun }),
        engine: persistingEngine(baseServices.engine || promotionDefault, { dataDir: env.QRP_DATA_DIR, resume: env.RQ_RESUME === '1' }),
      };
      const ran = (effects.labRun || labDefault.run)(job, services);
      if (ran.status === 'COMPLETE') outcome = resultOf(EXIT.COMPLETE, `COMPLETE:${safeReason(ran.terminal_state)}`, job, dbProbe);
      else if (ran.status === 'WAITING_EXTERNAL') outcome = resultOf(EXIT.PAUSE, waitReason(ran.waiting), job, dbProbe);
      else if (ran.status === 'REFUSED') outcome = resultOf(EXIT.REFUSED, `REFUSED:${safeReason(ran.reason_code)}`, job, dbProbe);
      else outcome = resultOf(EXIT.FAILURE, `UNEXPECTED:LAB_STATUS_${safeReason(ran.status)}`, job, dbProbe);
    }
  } catch (e) {
    if (e && e.code === 'EXPERIMENT_LAUNCH_WAITING') outcome = resultOf(EXIT.PAUSE, waitReason(e.detail || 'WAITING'), job || { as_of: '' }, dbProbe);
    else if (e instanceof DriverError) outcome = resultOf(e.exit, e.code, job || { as_of: '' }, dbProbe);
    else outcome = resultOf(EXIT.FAILURE, `UNEXPECTED:${safeReason(e && e.message)}`, job || { as_of: '' }, dbProbe);
  }
  const resultFile = env && env.RQ_ATTEMPT_DIR ? path.join(env.RQ_ATTEMPT_DIR, 'driver-result.json') : null;
  if (resultFile) writeDriverResult(resultFile, outcome);
  return outcome;
}

module.exports = { EXIT, GIB, FROZEN_DEFAULTS, DriverError, canonical, prettyJson, sha256, defaultsMatch, guardDataDir, makeRegistrar, persistingEngine, validateResume, writeDriverResult, runDriver,
  internals: { validateEnv, validateConfig, validateDbProbe, diskAvailableBytes, safePromotionPath } };
