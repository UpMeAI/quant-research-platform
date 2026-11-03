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
 *   1. 按载荷对号(不按调用顺序):这次调用的载荷({ legacy: { input, opts }, kind, strategy },与写作业端同形)与每个作业的载荷
 *      (载荷文件先按清单里的 payload_sha256 逐字节核过,再 v8 反序列化)各求「内容 sha256」(contentDigest:与 V8 内部表示无关的
 *      规范写法),相等才算同一载荷;对不上即拒绝(BACKFILL_JOB_NOT_FOUND)。原始 v8 字节是否也相同另记(raw_identical,只作诊断)。
 *      为什么不直接比 v8 字节:写作业端的字节取决于那个进程里的对象形状与字符串表示(11-03 Linux 实测:同一内容,'CARRY'
 *      在本文件里是双字节串、在写作业端是单字节串,字节就不同),同内容不同字节;判定只认内容。
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

const v8 = require('v8');
const { PAYLOAD_KIND } = require('./runner');

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

/**
 * 载荷的内容 sha256:与 V8 内部表示无关(小整数 / 双精度、单字节 / 双字节串、元素种类都不影响),内容不同则不同。
 * 写法(带类型标记,按插入顺序):null n;undefined u;数组空位 h;布尔 T/F;数 d<Object.is -0 写 -0,否则 String(x)>;
 * 串 s<JSON>;数组 [ … ];类型化数组 A<构造名>[ … ];Map M{ k=>v … }(插入顺序);普通对象 {k:v …}(插入顺序)。
 * 其他类型(函数、Date、Set、类实例、非有限数以外的一切)拒绝,不猜。
 */
function contentDigest(value) {
  const h = crypto.createHash('sha256');
  let buf = '';
  const put = (t) => { buf += t; if (buf.length > 65536) { h.update(buf); buf = ''; } };
  const walk = (v) => {
    if (v === null) { put('n'); return; }
    switch (typeof v) {
      case 'undefined': put('u'); return;
      case 'boolean': put(v ? 'T' : 'F'); return;
      case 'number': put(`d${Object.is(v, -0) ? '-0' : String(v)};`); return;
      case 'string': put(`s${JSON.stringify(v)}`); return;
      case 'object': break;
      default: throw new Error(`CONTENT_DIGEST_UNSUPPORTED:${typeof v}`);
    }
    if (Array.isArray(v)) {
      put('[');
      for (let i = 0; i < v.length; i += 1) { if (i in v) walk(v[i]); else put('h'); put(','); }
      put(']');
      return;
    }
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      put(`A${v.constructor.name}[`);
      for (let i = 0; i < v.length; i += 1) { walk(v[i]); put(','); }
      put(']');
      return;
    }
    if (v instanceof Map) {
      put('M{');
      for (const [k, x] of v) { walk(k); put('=>'); walk(x); put(','); }
      put('}');
      return;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error(`CONTENT_DIGEST_UNSUPPORTED:${v.constructor ? v.constructor.name : 'object'}`);
    put('{');
    for (const k of Object.keys(v)) { put(`${JSON.stringify(k)}:`); walk(v[k]); put(','); }
    put('}');
  };
  walk(value);
  h.update(buf);
  return h.digest('hex');
}

/**
 * 作业目录 → 按载荷内容 sha256 的索引(另留原始字节 sha256)。清单必须是本钉版的 CARRY 清单;每个载荷文件先按清单的
 * payload_sha256 逐字节核过再反序列化;同一内容两个不同输出即拒绝。
 */
function jobIndex(dirs) {
  const byContent = new Map();
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
      const job = JSON.parse(fs.readFileSync(path.join(dir, j.job_file), 'utf8'));
      if (job.payload_sha256 !== j.payload_sha256) throw new Error(`CACHE_JOB_CHANGED:${j.job_file}`);
      const raw = fs.readFileSync(path.join(dir, job.payload_file));
      if (sha256Hex(raw) !== j.payload_sha256) throw new Error(`PAYLOAD_SHA256_MISMATCH:${j.job_file}`);
      const content = contentDigest(v8.deserialize(raw));
      const prev = byContent.get(content);
      if (prev && prev.harness_output_sha256 !== j.harness_output_sha256) throw new Error(`BACKFILL_PAYLOAD_AMBIGUOUS:${content.slice(0, 16)}`);
      if (!prev) byContent.set(content, { dir, job_file: j.job_file, payload_sha256: j.payload_sha256, content_sha256: content, harness_output_sha256: j.harness_output_sha256 });
    }
  }
  return { byContent, manifests };
}

/**
 * 一个窗口的线:跑数器自己的函数,simulateSleeve 换成「对号 → 重跑作业 → 还原」。
 * runJob(job, dir) → { receipt, output };used 收集每次调用对上的作业。
 */
function backfillLines({ L, runner, data, win, yields, index, runJob }) {
  const original = L.simulateSleeve;
  const calls = [];
  L.simulateSleeve = function backfilled(input, opts) {
    const payload = { legacy: { input, opts }, kind: PAYLOAD_KIND, strategy: SOURCE };
    const content = contentDigest(payload);
    const hit = index.byContent.get(content);
    if (!hit) throw new Error(`BACKFILL_JOB_NOT_FOUND:${content.slice(0, 16)}:call=${calls.length + 1}`);
    const job = JSON.parse(fs.readFileSync(path.join(hit.dir, hit.job_file), 'utf8'));
    if (job.payload_sha256 !== hit.payload_sha256) throw new Error(`CACHE_JOB_CHANGED:${hit.job_file}`);
    const { receipt, output } = runJob(job, hit.dir);
    if (receipt.payload_sha256 !== hit.payload_sha256) throw new Error(`BACKFILL_PAYLOAD_DIFFERENT:${hit.job_file}`);
    if (receipt.output_sha256 !== hit.harness_output_sha256) throw new Error(`BACKFILL_OUTPUT_DIFFERENT:${hit.job_file}`);
    const rawIdentical = bridge.payloadBytes(SOURCE, { legacy: { input, opts } }).sha256 === hit.payload_sha256;
    calls.push({ call: calls.length + 1, jobs_dir: path.basename(hit.dir), job_file: hit.job_file, payload_sha256: hit.payload_sha256, content_sha256: content,
      raw_identical: rawIdentical, output_sha256: receipt.output_sha256 });
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
  const used = new Set(windows.flatMap((w) => w.calls.map((c) => c.content_sha256)));
  const receipt = {
    kind: RECEIPT_KIND, group, pass, ...(prior ? { again_of_sha256: sha256Hex(fs.readFileSync(args.again)) } : {}),
    rule: 'K2 §4.1 R-A0-PATH ★a: job outputs (runJob, output sha256 = harness sha256) restored and handed back to the frozen runner',
    core_version_hash: PIN.core.version_hash, smartflow_commit: PIN.smartflow.commit, hooks_id: PIN.strategies.CARRY.hooks_id,
    env: { node: process.versions.node, platform: process.platform, arch: process.arch },
    runner_sha256: sha256Hex(fs.readFileSync(path.join(pkgRoot, RUNNER))), lib_sha256: sha256Hex(fs.readFileSync(path.join(pkgRoot, LIB))),
    data_manifest_sha256: manifestSha256, dtb3_sha256: dtb3 ? dtb3.file.sha256 : null,
    job_manifests: index.manifests,
    match_rule: 'payload content sha256 (contentDigest), job payload files verified byte-for-byte against payload_sha256; raw v8 byte identity recorded per call (raw_identical, diagnostic)',
    jobs_indexed: index.byContent.size, jobs_used: used.size, jobs_unused: [...index.byContent.keys()].filter((k) => !used.has(k)).length,
    calls_raw_identical: windows.reduce((n, w) => n + w.calls.filter((c) => c.raw_identical).length, 0), calls: windows.reduce((n, w) => n + w.calls.length, 0),
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

module.exports = { RECEIPT_KIND, V1_WINDOWS, V2_WINDOWS, restoreNative, contentDigest, jobIndex, backfillLines, windowOf, backfill };
