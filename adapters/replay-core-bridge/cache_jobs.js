#!/usr/bin/env node
'use strict';
/**
 * 真实研究缓存 → QRP_REPLAY_CORE_JOB_V1 作业(QRP 侧代码,运行在钉住的 smartflow 检出上;子进程,最小环境)。
 *
 *   node cache_jobs.js --root <smartflow 根> --source <来源> --args <参数 JSON 文件> --out <作业目录>
 *
 * 来源(都是 smartflow 自己的 layer-2 golden 入口,scripts/lib/replay-core-golden/tier2.js,原样不改):
 *   CARRY           { data, windows?, dtb3? }      carry 研究归档(fetch-log.jsonl + 归档文件)→ carryTier2:跑数器自己的
 *                                                   windowLines / windowLinesV2,每个 sleeve 一次核心运行
 *   C17_CACHE       { cache, scenarios? }          loadFuturesDataset 缓存 → c17Tier2:冻结评估窗,每个情景一次
 *   C17_AGENT_LIVE  { cache }                      C17_AGENT 线上回放的 parity 缓存 → c17AgentTier2:每次调用(臂 × 止盈期)一次
 *   C17_V2_LIVE     { cache, records? }            C17_V2 线上回放的 parity 缓存与名单记录 → c17V2Tier2
 *   US_V5_RECORDS   { records, from, to, bookEquity, bookStart, timeRule | ruleEnv }
 *                                                   决策输入日志目录 → usV5Tier2:账本回放交给出场规则的持仓
 *
 * 做法与 golden_capture.js 相同:输入构造器在 tier2 加载前包一层、Core.run 按属性调用,smartflow 文件一字不改。
 * 每次核心运行写成一个作业(载荷 = 构造器参数),并记下 harness 自跑输出规范字节的 sha256;tier2 自己的判定
 * (核心对旧引擎是否逐字节一致)原样记入清单。缓存只读,不拉数;清单已存在即拒写,不覆盖研究产物。
 */
const fs = require('fs');
const path = require('path');
const { PIN, sha256Hex, layout, assertCore, loadedPackageFiles } = require('./core_pin');
const { writeJob } = require('./index');
const { configTracker } = require('./golden_capture');
const { C17_DATASET_REF_KIND } = require('./runner');

const MANIFEST_KIND = 'QRP_REPLAY_CORE_CACHE_JOBS_V1';
const TIER2 = 'scripts/lib/replay-core-golden/tier2.js';

const manifestFile = (source) => `cache-jobs-${source}.json`;

const need = (a, keys) => { for (const k of keys) if (a[k] === undefined || a[k] === null || a[k] === '') throw new Error(`USAGE:${k}`); };

/**
 * US_V5 扫描记录:按决策输入日志自己的目录变量(resolveDir 读 US_DECISION_INPUTS_DIR)读 [from, to];
 * 目录没对上、有损坏文件、或一条记录都没有,一律拒绝(smartflow golden CLI 传的 US_DECISION_INPUT_DIR 会被 resolveDir 忽略而落到缺省目录)。
 */
function usV5Records(req, a) {
  const inputs = req('src/services/us-decision-input-log.js');
  const env = { US_DECISION_INPUTS_DIR: path.resolve(a.records) };
  if (inputs.resolveDir(env) !== path.resolve(a.records)) throw new Error('US_V5_RECORDS_DIR_NOT_HONOURED');
  const { bySession, corrupt } = inputs.readRecords('us-v5', { from: a.from, to: a.to, env });
  if (corrupt.length) throw new Error(`US_V5_RECORDS_CORRUPT:${corrupt.map((c) => c.session).join(',')}`);
  const records = [...bySession.values()].flat();
  if (!records.length) throw new Error(`US_V5_RECORDS_EMPTY:${a.from}..${a.to}`);
  return records;
}

/** 各来源:策略、参数校验(补缺省)、调用 tier2 的入口。inject 只给测试与已在内存里的数据用(tier2 同样接受)。 */
const SOURCES = Object.freeze({
  CARRY: {
    strategy: 'CARRY',
    check: (a) => { need(a, ['data']); return { ...a, windows: a.windows || ['IS', 'OOS'], dtb3: a.dtb3 || null }; },
    run: (T2, a) => T2.carryTier2({ dataDir: a.data, windows: a.windows, dtb3: a.dtb3, evidence: null, ...(a.symbols ? { symbols: a.symbols } : {}) }),
  },
  C17_CACHE: {
    strategy: 'C17',
    check: (a) => { need(a, ['cache']); return { ...a, scenarios: a.scenarios || ['BASE', 'ADVERSE'] }; },
    run: (T2, a, inject) => T2.c17Tier2({ cacheDir: inject.dataset ? null : a.cache, dataset: inject.dataset || null, scenarios: a.scenarios }),
  },
  C17_AGENT_LIVE: {
    strategy: 'C17',
    check: (a) => { need(a, ['cache']); return { ...a }; },
    run: (T2, a, inject, pkgRoot) => T2.c17AgentTier2({ cacheDir: a.cache, appRoot: pkgRoot, loadDataset: inject.loadDataset || null, at: 0 }),
  },
  C17_V2_LIVE: {
    strategy: 'C17',
    check: (a) => { need(a, ['cache']); return { ...a }; },
    run: (T2, a, inject, pkgRoot) => T2.c17V2Tier2({ cacheDir: inject.dataset ? null : a.cache, appRoot: pkgRoot, recordsDir: a.records ? path.resolve(a.records) : undefined,
      loadDataset: inject.loadDataset || null, dataset: inject.dataset || null, at: 0 }),
  },
  US_V5_RECORDS: {
    strategy: 'US_V5',
    check: (a, injected) => {
      need(a, ['records', 'from', 'to']);
      if (!a.timeRule && !a.ruleEnv) throw new Error('USAGE:timeRule|ruleEnv');
      if (!injected) need(a, ['bookEquity', 'bookStart']);
      return { ...a };
    },
    run: (T2, a, inject, pkgRoot, req) => {
      const R = req('scripts/lib/strategy-review.js');
      // 出场时间规则显式给出(或给出生产环境里决定它的变量),不读本进程环境:子进程环境只有 PATH / TZ
      const timeRule = a.timeRule || req('src/services/us-v5-exit-rules.js').timeRuleConfig(a.ruleEnv);
      if (inject.records) {
        return T2.usV5Tier2({ records: inject.records, StrategyModule: inject.StrategyModule, book: inject.book, sessions: inject.sessions,
          timeRule, windowSessions: inject.windowSessions || inject.sessions });
      }
      const { resolveV5Book } = req('src/services/us-v5-book.js');
      return T2.usV5Tier2({ records: usV5Records(req, a), StrategyModule: req('src/strategies/us-v5-strategy.js'),
        book: resolveV5Book({ US_V5_BOOK_EQUITY: String(a.bookEquity), US_V5_BOOK_START_AT: a.bookStart }), sessions: R.sessionsBetween(a.from, a.to), timeRule });
    },
  },
});

function checkArgs(source, args, injected = false) {
  const spec = SOURCES[source];
  if (!spec) throw new Error(`CACHE_SOURCE_UNSUPPORTED:${source}`);
  return spec.check({ ...(args || {}) }, injected);
}

function assertFresh(out, source) {
  if (fs.existsSync(path.join(out, manifestFile(source)))) throw new Error(`CACHE_JOBS_EXIST:${source}`);
}

/** 一组作业的总判定:每个作业的输出 sha256(runOf 给出)与清单里 harness 自跑的 sha256 逐个比。 */
function verdictOf(jobs, runOf) {
  const rows = jobs.map((j) => {
    const sha = runOf(j);
    return { job_file: j.job_file, harness_output_sha256: j.harness_output_sha256, output_sha256: sha, verdict: sha === j.harness_output_sha256 ? 'BYTE_IDENTICAL' : 'DIFFERENT' };
  });
  const identical = rows.filter((r) => r.verdict === 'BYTE_IDENTICAL').length;
  return { verdict: rows.length === 0 ? 'NO_JOBS' : identical === rows.length ? 'BYTE_IDENTICAL' : 'DIFFERENT', identical, different: rows.length - identical, rows };
}

/** tier2 回执 → 清单里的一行(只留判定与哈希;差异明细只留前 20 条)。 */
const harnessRow = (r) => ({
  window: r.window, verdict: r.verdict, old_sha256: r.oldSha256, new_sha256: r.newSha256, diff_count: r.diffCount,
  diffs: (r.diffs || []).slice(0, 20), trades: r.trades === undefined ? null : r.trades,
  sleeves: Array.isArray(r.sleeves) ? r.sleeves.length : null, script_sha256: r.scriptSha256 || null,
});

const identityOf = (r) => ({ ...(r.dataManifestSha256 ? { dataManifestSha256: r.dataManifestSha256 } : {}), ...(r.inputIdentity || {}) });

/** 真实 C17_CACHE 只携带钉住的缓存引用；测试注入和其他 C17 来源保持原来的内存数据载荷。 */
function c17Payload(source, cacheDir, dataset, opts, injected, configOverlay) {
  if (source !== 'C17_CACHE' || injected) return { dataset, opts, configOverlay };
  if (!dataset || !/^[0-9a-f]{64}$/.test(String(dataset.manifestFileSha256 || ''))) {
    throw new Error('C17_DATASET_MANIFEST_SHA256_MISSING');
  }
  return {
    datasetRef: {
      kind: C17_DATASET_REF_KIND,
      cache_dir: path.resolve(cacheDir),
      manifest_file_sha256: dataset.manifestFileSha256,
    },
    opts,
    configOverlay,
  };
}

/**
 * 在钉住的 smartflow 上跑一个来源,写作业与清单,返回清单。
 * prepare(req) 只在测试里用:在构造器包好之后加载 smartflow 的合成夹具,返回 { args, inject }。
 */
function captureCacheJobs(root, source, args, out, { prepare = null } = {}) {
  const spec = SOURCES[source];
  if (!spec) throw new Error(`CACHE_SOURCE_UNSUPPORTED:${source}`);
  const { pkgRoot, coreDir } = layout(path.resolve(root));
  assertCore(coreDir);
  fs.mkdirSync(out, { recursive: true });
  assertFresh(out, source);

  const envBefore = new Set(Object.keys(process.env));
  const req = (rel) => require(path.join(pkgRoot, rel));
  const Core = require(coreDir);
  if (Core.coreVersion().hash !== PIN.core.version_hash) throw new Error(`CORE_VERSION_MISMATCH:self=${Core.coreVersion().hash.slice(0, 8)}`);
  const mods = Object.fromEntries(Object.entries(PIN.strategies).map(([s, sp]) => [s, require(path.join(pkgRoot, sp.module))]));
  for (const [s, mod] of Object.entries(mods)) if (mod.HOOKS_ID !== PIN.strategies[s].hooks_id) throw new Error(`HOOKS_VERSION_MISMATCH:${s}`);
  const overlayNow = configTracker(req('agent/v5-agent-config.js'));

  // 输入构造器:包在 tier2 及其依赖加载之前(它们按解构取用);每个构造出的输入对应一个待写作业
  const pending = new WeakMap();
  const wrap = (mod, fn, toPayload) => {
    const orig = mod[fn];
    mod[fn] = function wrapped(...a) {
      const payload = toPayload ? toPayload(a) : null;
      const input = orig.apply(this, a);
      pending.set(input, payload || { input: Core.hashable(input) });
      return input;
    };
  };
  wrap(mods.US_V5, 'usV5Input', null);
  wrap(mods.C17, 'c17Input', ([dataset, o]) => c17Payload(source, args && args.cache, dataset, o, Boolean(prepare), overlayNow()));
  wrap(mods.CARRY, 'carryInput', ([data, win, capital, o]) => ({ data, win, capital, opts: o }));
  wrap(mods.CARRY, 'carryInputFromLegacy', ([legacy, o]) => ({ legacy: { input: legacy, opts: o } }));

  const jobs = [];
  const origRun = Core.run;
  Core.run = function wrappedRun(input, options = {}) {
    const payload = pending.get(input);
    if (!payload) throw new Error('CACHE_JOBS_UNCAPTURED_CORE_RUN');
    const result = origRun.call(this, input, options);
    const job = writeJob(out, spec.strategy, payload, options.skipInputHash === true ? { skipInputHash: true } : {});
    const jobFile = `${source}-${String(jobs.length + 1).padStart(4, '0')}.job.json`;
    fs.writeFileSync(path.join(out, jobFile), `${JSON.stringify(job)}\n`);
    jobs.push({ job_file: jobFile, payload_sha256: job.payload_sha256, options: job.options, harness_output_sha256: sha256Hex(Core.canonBytes(result)) });
    return result;
  };

  const prepared = prepare ? prepare(req) : null;
  const inject = (prepared && prepared.inject) || {};
  const a = checkArgs(source, prepared ? prepared.args : args, Boolean(prepared && prepared.inject));
  const T2 = req(TIER2);
  const receipts = spec.run(T2, a, inject, pkgRoot, req);
  const injected = Object.keys(process.env).filter((k) => !envBefore.has(k));
  if (injected.length) throw new Error(`SMARTFLOW_ENV_INJECTED:${injected.length}`);

  const harness = receipts.map(harnessRow);
  const loaded = loadedPackageFiles(pkgRoot, coreDir);
  const manifest = {
    kind: MANIFEST_KIND,
    source,
    strategy: spec.strategy,
    profile: PIN.strategies[spec.strategy].profile,
    core_version_hash: PIN.core.version_hash,
    smartflow_commit: PIN.smartflow.commit,
    hooks_id: PIN.strategies[spec.strategy].hooks_id,
    smartflow_loaded_files: { sha256: loaded.hash, count: loaded.files.length },
    env: { node: process.versions.node, platform: process.platform, arch: process.arch },
    args: JSON.parse(JSON.stringify(a)),
    injected_data: prepared && prepared.inject ? Object.keys(prepared.inject).sort() : [],
    source_identity: [...new Map(receipts.map((r) => [JSON.stringify(identityOf(r)), identityOf(r)])).values()],
    harness_verdict: harness.length === 0 ? 'NO_HARNESS' : harness.every((h) => h.verdict === 'BYTE_IDENTICAL') ? 'BYTE_IDENTICAL'
      : harness.some((h) => h.verdict === 'FAIL') ? 'FAIL' : 'EXPLAINED',
    harness,
    jobs,
  };
  fs.writeFileSync(path.join(out, manifestFile(source)), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['root', 'source', 'args', 'out']) if (!opts[k]) throw new Error(`USAGE:--${k}`);
  return opts;
}

function main(argv) {
  try {
    const o = parseArgs(argv);
    const m = captureCacheJobs(o.root, o.source, JSON.parse(fs.readFileSync(o.args, 'utf8')), o.out);
    process.stdout.write(`${m.source} harness=${m.harness_verdict} windows=${m.harness.length} jobs=${m.jobs.length}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${String(e && e.message).split('\n')[0]}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { MANIFEST_KIND, SOURCES, manifestFile, checkArgs, assertFresh, verdictOf, usV5Records, c17Payload, captureCacheJobs };
