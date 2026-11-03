#!/usr/bin/env node
'use strict';
/**
 * Carry V2 接入 A0-4「回填重组」(smartflow CARRY_V2_QRP_ONBOARDING_K2_DRAFT_V1 §4.1 R-A0-PATH ★a,FREEZE_1)。
 * QRP 侧代码,运行在钉住的 smartflow 检出上;由 apps/research-cli/carry_v2_onboarding.js 以最小环境的子进程启动。
 *
 *   node carry_backfill.js --root <smartflow 根> --args <参数 JSON 文件> --out <输出目录>
 *   args: { data, dtb3: { dir, rel } | null, windows: ['IS','OOS','W1','W2','FULL'], jobs: [作业目录…], dataEvidence: <v2-gates 输出> | null }
 *
 * 冻结跑数器(scripts/research/funding-basis-carry-run.js)自己的 windowLines / windowLinesV2 原样运行。它每调用一次
 * simulateSleeve,旧引擎不算,改为:
 *   1. 用写作业的同一载荷({ legacy: { input, opts } },index.payloadBytes)求 v8 字节的 sha256,在作业清单里按载荷
 *      sha256 对号(不按调用顺序);对不上即拒绝(BACKFILL_JOB_NOT_FOUND);
 *   2. 经 runJob(与适配器 run_backtest 同一子进程路径)重跑该作业;输出 sha256 必须等于清单里 harness 自跑的 sha256;
 *   3. 输出的 native 按 restoreNative 还原成旧引擎返回的同一形状交回跑数器。
 * 线的汇总、bootstrap、判定都由跑数器自己做(唯一产出者);这里只把 V2 窗口按 v2Run 的形状写成证据,交 v2-result。
 * 进程与顺序照写作业端:一组窗口(IS、OOS 一组;W1、W2、FULL 一组)在一个新进程里按写作业时的顺序各算一遍。
 * 原因:载荷的 v8 字节随进程里对象形状的演变而变(例如 R4 的 idleRate 0.05 把同形 opts 的字段表示从小整数推广为
 * 双精度,其后同形对象里的 0 按双精度序列化),同一进程里把一个窗口算两遍,第二遍的载荷字节就对不上写作业时的字节。
 * 所以 G3(同一计算两遍)用两个新进程:A 遍只记结果;B 遍(args.again = A 遍回执)再算一遍,与 A 遍比,并写证据。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PIN, sha256Hex, layout, assertCore } = require('./core_pin');
const bridge = require('./index');
const CacheJobs = require('./cache_jobs');

const RECEIPT_KIND = 'QRP_CARRY_V2_A0_BACKFILL_V1';
const SOURCE = 'CARRY';
const RUNNER = 'scripts/research/funding-basis-carry-run.js';
const LIB = 'scripts/research/funding-basis-carry-lib.js';
const TIER2 = 'scripts/lib/replay-core-golden/tier2.js';
const V1_WINDOWS = Object.freeze(['IS', 'OOS']);
const V2_WINDOWS = Object.freeze(['W1', 'W2', 'FULL']);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

/**
 * 作业输出(规范 JSON 解析后)的 native → 旧引擎 simulateSleeve 返回的同一形状。
 * 规范字节把类型化数组写成数组;旧引擎的 equity 是 Float64Array、held 是 Uint8Array,这里按原类型还原。
 * 只换容器类型,不改任何数值:equity 每项必须是有限数,held 每项必须是 0…255 的整数,否则拒绝(RESTORE_SHAPE)。
 */
function restoreNative(native) {
  if (!native || typeof native !== 'object' || Array.isArray(native)) throw new Error('RESTORE_SHAPE:native');
  const numbers = (a, field) => {
    if (!Array.isArray(a) || !a.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error(`RESTORE_SHAPE:${field}`);
    return a;
  };
  const equity = numbers(native.equity, 'equity');
  const held = numbers(native.held, 'held');
  if (!held.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error('RESTORE_SHAPE:held');
  for (const k of ['events', 'episodes']) if (!Array.isArray(native[k])) throw new Error(`RESTORE_SHAPE:${k}`);
  for (const k of ['counts', 'diag', 'acc', 'identity', 'params']) if (!native[k] || typeof native[k] !== 'object') throw new Error(`RESTORE_SHAPE:${k}`);
  return { ...native, equity: Float64Array.from(equity), held: Uint8Array.from(held) };
}

/** 作业目录 → 按载荷 sha256 的索引。清单必须是本钉版的 CARRY 清单;同一载荷两个不同输出即拒绝。 */
function jobIndex(dirs) {
  const bySha = new Map();
  const manifests = [];
  for (const dir of dirs) {
    const file = path.join(dir, CacheJobs.manifestFile(SOURCE));
    const bytes = fs.readFileSync(file);
    const m = JSON.parse(bytes.toString('utf8'));
    if (m.kind !== CacheJobs.MANIFEST_KIND || m.source !== SOURCE || m.strategy !== 'CARRY') throw new Error(`BACKFILL_MANIFEST_INVALID:${path.basename(dir)}`);
    if (m.core_version_hash !== PIN.core.version_hash) throw new Error(`CORE_VERSION_MISMATCH:manifest:${path.basename(dir)}`);
    if (m.hooks_id !== PIN.strategies.CARRY.hooks_id) throw new Error(`HOOKS_VERSION_MISMATCH:manifest:${path.basename(dir)}`);
    if (m.smartflow_commit !== PIN.smartflow.commit) throw new Error(`SMARTFLOW_COMMIT_MISMATCH:manifest:${path.basename(dir)}`);
    manifests.push({ dir: path.basename(dir), manifest_sha256: sha256Hex(bytes), jobs: m.jobs.length, harness_verdict: m.harness_verdict });
    for (const j of m.jobs) {
      const prev = bySha.get(j.payload_sha256);
      if (prev && prev.harness_output_sha256 !== j.harness_output_sha256) throw new Error(`BACKFILL_PAYLOAD_AMBIGUOUS:${j.payload_sha256.slice(0, 16)}`);
      if (!prev) bySha.set(j.payload_sha256, { dir, job_file: j.job_file, payload_sha256: j.payload_sha256, harness_output_sha256: j.harness_output_sha256 });
    }
  }
  return { bySha, manifests };
}

/**
 * 一个窗口的线:跑数器自己的函数,simulateSleeve 换成「对号 → 重跑作业 → 还原」。
 * runJob(job, dir) → { receipt, output };used 收集每次调用对上的作业。
 */
function backfillLines({ L, runner, data, win, yields, index, runJob }) {
  const original = L.simulateSleeve;
  const calls = [];
  L.simulateSleeve = function backfilled(input, opts) {
    const { sha256: payloadSha } = bridge.payloadBytes(SOURCE, { legacy: { input, opts } });
    const hit = index.bySha.get(payloadSha);
    if (!hit) throw new Error(`BACKFILL_JOB_NOT_FOUND:${payloadSha.slice(0, 16)}`);
    const job = JSON.parse(fs.readFileSync(path.join(hit.dir, hit.job_file), 'utf8'));
    if (job.payload_sha256 !== payloadSha) throw new Error(`CACHE_JOB_CHANGED:${hit.job_file}`);
    const { receipt, output } = runJob(job, hit.dir);
    if (receipt.output_sha256 !== hit.harness_output_sha256) throw new Error(`BACKFILL_OUTPUT_DIFFERENT:${hit.job_file}`);
    calls.push({ call: calls.length + 1, jobs_dir: path.basename(hit.dir), job_file: hit.job_file, payload_sha256: payloadSha, output_sha256: receipt.output_sha256 });
    return restoreNative(output.native);
  };
  try {
    const lines = yields ? runner.windowLinesV2(data, win, yields) : runner.windowLines(data, win);
    return { lines, calls };
  } finally {
    L.simulateSleeve = original;
  }
}

/** 窗口名或测试窗口 { name, start, end, idleFlat? } → { name, win, v2 }。真实运行只用名字。 */
function windowOf(L, w) {
  if (typeof w === 'string') {
    if (V1_WINDOWS.includes(w)) return { name: w, win: L.WINDOWS[w], v2: false };
    if (V2_WINDOWS.includes(w)) return { name: w, win: L.WINDOWS_V2[w], v2: true };
    throw new Error(`UNKNOWN_WINDOW:${w}`);
  }
  if (!w || !w.name || !Number.isFinite(w.start) || !Number.isFinite(w.end)) throw new Error('UNKNOWN_WINDOW:object');
  return { name: w.name, win: { name: w.name, start: w.start, end: w.end }, v2: w.idleFlat != null, idleFlat: w.idleFlat };
}

/** V2 窗口证据,按 v2Run 的形状(只换 lines 的来源);v2-result 读它。 */
function v2Evidence({ L, runner, name, win, pit, lines, G3, resultsSha256, dataEv, manifestSha256, dtb3File, code, acceptance }) {
  return {
    study: dataEv.study, kind: 'WINDOW_RUN', window: name,
    range: { start: iso(win.start), end: iso(win.end), days: (win.end - win.start) / L.DAY },
    acceptance, code,
    data: { v1ManifestSha256: manifestSha256, dtb3: dtb3File, D: dataEv.gates.D[name], GC2: dataEv.gates.GC2[name] },
    params: L.PARAMS, paramsV2: L.PARAMS_V2, costs: L.COSTS,
    benchmarks: { DTB3: L.benchmarkFromYields(pit.yields, win.start, win.end), FLAT_5PCT: L.benchmarkFromYields(L.flatYields(L.PARAMS_V2.FLAT_BENCHMARK_V1, win.start, win.end), win.start, win.end) },
    benchmarkDays: { columns: ['day', 'obsDate', 'dtb3', 'y'], rows: pit.detail.map((x) => [x.day, x.obsDate, x.dtb3, x.y]) },
    lines,
    gates: { ...runner.harnessGates(lines), G3 },
    resultsSha256,
    generatedAt: new Date().toISOString(), host: { node: process.version, platform: process.platform },
  };
}

/**
 * 回填全部窗口,写 V2 窗口证据与回执,返回回执。
 * inject.runJob 只给测试用(默认 bridge.runJob,钉住的根)。
 */
function backfill(root, args, out, inject = {}) {
  const { pkgRoot, coreDir } = layout(path.resolve(root));
  assertCore(coreDir);
  if (!args || !args.data || !Array.isArray(args.windows) || !args.windows.length || !Array.isArray(args.jobs) || !args.jobs.length) throw new Error('USAGE:args{data,windows,jobs}');
  fs.mkdirSync(out, { recursive: true });
  const group = args.group || 'GROUP';
  if (!/^[A-Za-z0-9_]+$/.test(group)) throw new Error('USAGE:args.group');
  const pass = args.again ? 'B' : 'A';
  const receiptFile = path.join(out, `a0-4-backfill.${group}.${pass}.json`);
  if (fs.existsSync(receiptFile)) throw new Error('BACKFILL_RECEIPT_EXISTS');
  const prior = args.again ? JSON.parse(fs.readFileSync(args.again, 'utf8')) : null;
  if (prior && (prior.kind !== RECEIPT_KIND || prior.pass !== 'A' || prior.group !== group)) throw new Error('BACKFILL_AGAIN_RECEIPT_INVALID');

  const envBefore = new Set(Object.keys(process.env));
  const req = (rel) => require(path.join(pkgRoot, rel));
  const L = req(LIB);
  const runner = req(RUNNER);
  const T2 = req(TIER2);
  const injected = Object.keys(process.env).filter((k) => !envBefore.has(k));
  if (injected.length) throw new Error(`SMARTFLOW_ENV_INJECTED:${injected.length}`);

  const index = jobIndex(args.jobs.map((d) => path.resolve(d)));
  const runJob = inject.runJob || ((job, dir) => bridge.runJob(job, dir, { smartflowRoot: path.resolve(root) }));
  const { data, manifestSha256 } = T2.loadAll(args.data);
  const wins = args.windows.map((w) => windowOf(L, w));
  const needsDtb3 = wins.some((w) => w.v2 && w.idleFlat == null);
  let dtb3 = null;
  let dataEv = null;
  let acceptance = null;
  let code = null;
  if (needsDtb3) {
    if (!args.dtb3 || !args.dataEvidence) throw new Error('USAGE:args{dtb3,dataEvidence} for W1/W2/FULL');
    dataEv = JSON.parse(fs.readFileSync(args.dataEvidence, 'utf8'));
    acceptance = runner.checkAcceptanceV2();
    if (runner.stableJson(dataEv.acceptance) !== runner.stableJson(acceptance)) throw new Error('BACKFILL_REFUSED:acceptance differs from the gates evidence');
    code = Object.fromEntries(Object.keys(dataEv.code).map((rel) => [rel, sha256Hex(fs.readFileSync(path.join(pkgRoot, rel)))]));
    if (runner.stableJson(dataEv.code) !== runner.stableJson(code)) throw new Error('BACKFILL_REFUSED:code differs from the gates evidence');
    if (manifestSha256 !== dataEv.v1Data.manifestSha256) throw new Error(`DATA_MANIFEST_MISMATCH:${manifestSha256}`);
    dtb3 = T2.loadDtb3(args.dtb3.dir, dataEv.dtb3.file.path);
    if (dtb3.file.sha256 !== dataEv.dtb3.file.sha256) throw new Error('DTB3_FILE_MISMATCH');
  }

  const windows = [];
  for (const w of wins) {
    let pit = null;
    let yields = null;
    if (w.v2) {
      if (w.idleFlat != null) yields = L.flatYields(w.idleFlat, w.win.start, w.win.end);
      else { pit = L.pointInTimeYields(dtb3.rows, w.win.start, w.win.end); yields = pit.yields; }
    }
    const first = backfillLines({ L, runner, data, win: w.win, yields, index, runJob });
    const resultsSha256 = sha256(runner.stableJson(first.lines));
    const row = { window: w.name, v2: w.v2, resultsSha256, sleeves: first.calls.length, calls: first.calls };
    if (!prior) { windows.push(row); continue; }
    const a = prior.windows.find((x) => x.window === w.name);
    const G3 = { pass: Boolean(a) && a.resultsSha256 === resultsSha256, resultsSha256, rule: 'two fresh processes (pass A, pass B) on the same jobs' };
    row.G3 = G3;
    row.jobs_same_both_passes = Boolean(a) && JSON.stringify(a.calls) === JSON.stringify(first.calls);
    if (w.v2 && pit) {
      const ev = v2Evidence({ L, runner, name: w.name, win: w.win, pit, lines: first.lines, G3: { pass: G3.pass, resultsSha256 }, resultsSha256, dataEv, manifestSha256, dtb3File: dtb3.file, code, acceptance });
      const evFile = `CARRY_V2_${w.name}.backfill.json`;
      fs.writeFileSync(path.join(out, evFile), `${JSON.stringify(ev, null, 1)}\n`);
      row.evidence_file = evFile;
    }
    windows.push(row);
  }
  const used = new Set(windows.flatMap((w) => w.calls.map((c) => c.payload_sha256)));
  const receipt = {
    kind: RECEIPT_KIND, group, pass, ...(prior ? { again_of_sha256: sha256Hex(fs.readFileSync(args.again)) } : {}),
    rule: 'K2 §4.1 R-A0-PATH ★a: job outputs (runJob, output sha256 = harness sha256) restored and handed back to the frozen runner',
    core_version_hash: PIN.core.version_hash, smartflow_commit: PIN.smartflow.commit, hooks_id: PIN.strategies.CARRY.hooks_id,
    env: { node: process.versions.node, platform: process.platform, arch: process.arch },
    runner_sha256: sha256Hex(fs.readFileSync(path.join(pkgRoot, RUNNER))), lib_sha256: sha256Hex(fs.readFileSync(path.join(pkgRoot, LIB))),
    data_manifest_sha256: manifestSha256, dtb3_sha256: dtb3 ? dtb3.file.sha256 : null,
    job_manifests: index.manifests,
    jobs_indexed: index.bySha.size, jobs_used: used.size, jobs_unused: [...index.bySha.keys()].filter((k) => !used.has(k)).length,
    windows,
    all_calls_matched: windows.every((w) => w.calls.length > 0),
    ...(prior ? { all_g3: windows.every((w) => w.G3.pass && w.jobs_same_both_passes) } : {}),
  };
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 1)}\n`);
  return receipt;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`USAGE:${argv[i]}`);
    o[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ['root', 'args', 'out']) if (!o[k]) throw new Error(`USAGE:--${k}`);
  return o;
}

function main(argv) {
  try {
    const o = parseArgs(argv);
    const r = backfill(o.root, JSON.parse(fs.readFileSync(o.args, 'utf8')), o.out);
    process.stdout.write(`${JSON.stringify({ group: r.group, pass: r.pass, windows: r.windows.map((w) => ({ window: w.window, resultsSha256: w.resultsSha256, G3: w.G3 ? w.G3.pass : null, sleeves: w.sleeves })), jobs_used: r.jobs_used, jobs_unused: r.jobs_unused })}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${String(e && e.message).split('\n')[0]}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { RECEIPT_KIND, V1_WINDOWS, V2_WINDOWS, restoreNative, jobIndex, backfillLines, windowOf, backfill };
