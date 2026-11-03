#!/usr/bin/env node
'use strict';
/**
 * 跨仓字节一致性证明的取证端(QRP 侧代码,运行在钉住的 smartflow 检出上;子进程,最小环境)。
 *
 *   node golden_capture.js --root <smartflow 根> --golden G1|G2|G3 --out <目录>
 *
 * 跑 smartflow 自己的 layer-1 golden 用例(scripts/lib/replay-core-golden/layer1.js,原样不改),并在进程内记录:
 *   - 每次 Core.run 的输入构造参数 → 写成 QRP_REPLAY_CORE_JOB_V1 作业 + v8 载荷(与适配器 run_backtest 接收的同一形态);
 *   - 每次 Core.run 输出规范字节的 sha256(harness 自跑的结果);
 *   - 每个用例新侧投影的 sha256,与已提交的 golden 回执(pin.json 钉住文件 sha256)逐条比对。
 * 记录手段是包一层导出函数(输入构造器在 golden 模块加载前替换,Core.run 按属性调用),smartflow 文件一字不改。
 * 产出不进仓库:载荷含策略参数;仓库里只放哈希回执。
 */
const fs = require('fs');
const path = require('path');
const { PIN, sha256Hex, layout, assertCore } = require('./core_pin');
const { writeJob } = require('./index');
const { C17_OVERLAY_FIELDS } = require('./runner');

const CAPTURE_KIND = 'QRP_REPLAY_CORE_GOLDEN_CAPTURE_V1';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['root', 'golden', 'out']) if (!opts[k]) throw new Error(`USAGE:--${k}`);
  if (!PIN.golden_receipts[opts.golden]) throw new Error(`USAGE:--golden ${opts.golden}`);
  return opts;
}

function committedReceipts(pkgRoot, golden) {
  const ref = PIN.golden_receipts[golden];
  const bytes = fs.readFileSync(path.join(pkgRoot, ref.file));
  if (sha256Hex(bytes) !== ref.sha256) throw new Error(`GOLDEN_RECEIPT_SHA256_MISMATCH:${golden}`);
  const doc = JSON.parse(bytes.toString('utf8'));
  if (doc.coreVersionHash !== PIN.core.version_hash) throw new Error(`GOLDEN_RECEIPT_CORE_MISMATCH:${golden}`);
  return new Map(doc.receipts.map((r) => [r.window.split(' ')[0], r]));
}

/** C17 的配置叠加:与加载时的配置比,只允许 ASSET_PARAMS 的止盈/冷却变动,其余任何漂移都拒绝(不能被作业重现)。 */
function configTracker(CONFIG) {
  const pristine = JSON.parse(JSON.stringify(CONFIG));
  const others = Object.keys(pristine).filter((k) => k !== 'ASSET_PARAMS');
  return function overlayNow() {
    for (const k of others) if (JSON.stringify(CONFIG[k]) !== JSON.stringify(pristine[k])) throw new Error(`GOLDEN_CONFIG_DRIFT_UNSUPPORTED:${k}`);
    const overlay = {};
    for (const [asset, p] of Object.entries(CONFIG.ASSET_PARAMS)) {
      const base = pristine.ASSET_PARAMS[asset] || {};
      for (const field of Object.keys({ ...base, ...p })) {
        if (JSON.stringify(p[field]) === JSON.stringify(base[field])) continue;
        if (!C17_OVERLAY_FIELDS.includes(field)) throw new Error(`GOLDEN_CONFIG_DRIFT_UNSUPPORTED:ASSET_PARAMS.${asset}.${field}`);
        overlay[asset] = { ...(overlay[asset] || {}), [field]: p[field] };
      }
    }
    return Object.keys(overlay).length ? { ASSET_PARAMS: overlay } : {};
  };
}

function capture(opts) {
  const { pkgRoot, coreDir } = layout(opts.root);
  assertCore(coreDir);
  const strategy = PIN.golden_receipts[opts.golden].strategy;
  fs.mkdirSync(opts.out, { recursive: true });
  const Core = require(coreDir);
  const mods = Object.fromEntries(Object.entries(PIN.strategies).map(([s, spec]) => [s, require(path.join(pkgRoot, spec.module))]));
  for (const [s, mod] of Object.entries(mods)) if (mod.HOOKS_ID !== PIN.strategies[s].hooks_id) throw new Error(`HOOKS_VERSION_MISMATCH:${s}`);
  const overlayNow = configTracker(require(path.join(pkgRoot, 'agent/v5-agent-config.js')));

  const pending = new WeakMap();
  const wrap = (mod, fn, before, after) => {
    const orig = mod[fn];
    mod[fn] = function wrapped(...args) {
      const job = before ? before(args) : null;
      const input = orig.apply(this, args);
      pending.set(input, job || after(input));
      return input;
    };
  };
  wrap(mods.US_V5, 'usV5Input', null, (input) => writeJob(opts.out, 'US_V5', { input: Core.hashable(input) }));
  wrap(mods.C17, 'c17Input', ([dataset, o]) => writeJob(opts.out, 'C17', { dataset, opts: o, configOverlay: overlayNow() }));
  wrap(mods.CARRY, 'carryInput', ([data, win, capital, o]) => writeJob(opts.out, 'CARRY', { data, win, capital, opts: o }));

  let runs = null;
  const origRun = Core.run;
  Core.run = function wrappedRun(input, options = {}) {
    const job = pending.get(input);
    if (!job) throw new Error('GOLDEN_UNCAPTURED_CORE_RUN');
    const out = origRun.call(this, input, options);
    runs.push({ job: { ...job, options: options.skipInputHash === true ? { skipInputHash: true } : {} }, harness_output_sha256: sha256Hex(Core.canonBytes(out)) });
    return out;
  };

  const committed = committedReceipts(pkgRoot, opts.golden);
  const { layer1Cases } = require(path.join(pkgRoot, 'scripts/lib/replay-core-golden/layer1.js'));
  const cases = [];
  for (const c of layer1Cases(opts.golden)) {
    runs = [];
    const r = c.run();
    const rec = committed.get(c.id);
    cases.push({
      case_id: c.id,
      committed_new_sha256: rec ? rec.newSha256 : null,
      harness_new_sha256: r.comparison.newSha256,
      harness_verdict: r.comparison.verdict,
      runs,
    });
    if (runs.some((x) => x.job.strategy !== strategy)) throw new Error(`GOLDEN_STRATEGY_MISMATCH:${c.id}`);
  }
  const manifest = {
    kind: CAPTURE_KIND,
    golden: opts.golden,
    strategy,
    core_version_hash: PIN.core.version_hash,
    committed_receipt_sha256: PIN.golden_receipts[opts.golden].sha256,
    committed_cases: committed.size,
    env: { node: process.versions.node, platform: process.platform, arch: process.arch },
    cases,
  };
  fs.writeFileSync(path.join(opts.out, `capture-${opts.golden}.json`), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

function main(argv) {
  try {
    const m = capture(parseArgs(argv));
    process.stdout.write(`${m.golden} cases=${m.cases.length} runs=${m.cases.reduce((s, c) => s + c.runs.length, 0)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${String(e && e.message).split('\n')[0]}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { CAPTURE_KIND, capture, configTracker };
