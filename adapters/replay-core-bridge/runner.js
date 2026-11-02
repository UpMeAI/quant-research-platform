#!/usr/bin/env node
'use strict';
/**
 * Replay-core 桥接子进程(QRP 侧代码,运行在钉住的 smartflow 检出上)。
 *
 *   node runner.js --root <smartflow 根> --job <job.json> --out <output 文件> --receipt <receipt 文件>
 *   node runner.js --root <smartflow 根> --probe <US_V5|C17|CARRY>     打印钉版所需的哈希(换钉时用)
 *
 * 只做四件事,不含回放逻辑:
 *   1. 校验核心目录哈希(独立复算 + 核心自报两道)、hooks 版本、已加载策略文件哈希,任一不符拒跑;
 *   2. 读 job 指向的载荷(v8 序列化,只是数据),核对 sha256;
 *   3. 用 smartflow 自己的输入构造器(usV5Input 同形输入 / c17Input / carryInput)拼 REPLAY_CORE_INPUT_V1;
 *   4. Core.run → 用核心自己的 canonBytes 写出 REPLAY_CORE_OUTPUT_V1 的规范字节。
 * 子进程环境由父进程裁成最小集(无凭证);若 smartflow 模块在加载时往环境里注入了新变量(如读 .env),拒跑且只报个数。
 */
const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const { PIN, sha256Hex, coreDirHash, layout, loadedPackageFiles, assertCore } = require('./core_pin');

const JOB_KIND = 'QRP_REPLAY_CORE_JOB_V1';
const PAYLOAD_KIND = 'QRP_REPLAY_CORE_PAYLOAD_V1';
const RECEIPT_KIND = 'QRP_REPLAY_CORE_RUN_RECEIPT_V1';

// C17 的研究口径里唯一允许的配置叠加:按资产的止盈倍数与冷却(与 smartflow live replay 的 withTakeProfit 同一处配置)。
// hooks 在运行时比对输入里记录的止盈倍数,叠加不一致即由 hooks 自己拒跑。
const C17_OVERLAY_FIELDS = Object.freeze(['tpMultiplier', 'cooldown15M']);
const C17_CONFIG_MODULE = 'agent/v5-agent-config.js';

/** 各策略的输入构造:只调用 smartflow 的导出,不复制其逻辑。 */
const BUILDERS = Object.freeze({
  US_V5(mod, payload) {
    const input = payload.input;
    if (!input || input.hooksId !== mod.HOOKS_ID) throw new Error(`HOOKS_VERSION_MISMATCH:input=${input && input.hooksId}`);
    if (Object.prototype.hasOwnProperty.call(input, 'hooks')) throw new Error('PAYLOAD_CARRIES_HOOKS');
    return { ...input, hooks: mod.US_V5_HOOKS };
  },
  C17(mod, payload, pkgRoot) {
    const overlay = payload.configOverlay || {};
    const unknownTop = Object.keys(overlay).filter((k) => k !== 'ASSET_PARAMS');
    if (unknownTop.length) throw new Error(`CONFIG_OVERLAY_UNSUPPORTED:${unknownTop.join(',')}`);
    const CONFIG = require(path.join(pkgRoot, C17_CONFIG_MODULE));
    for (const [asset, fields] of Object.entries(overlay.ASSET_PARAMS || {})) {
      if (!CONFIG.ASSET_PARAMS[asset]) throw new Error(`CONFIG_OVERLAY_UNKNOWN_ASSET:${asset}`);
      for (const [field, value] of Object.entries(fields)) {
        if (!C17_OVERLAY_FIELDS.includes(field)) throw new Error(`CONFIG_OVERLAY_UNSUPPORTED:${asset}.${field}`);
        CONFIG.ASSET_PARAMS[asset][field] = value;
        if (CONFIG.ASSET_PARAMS[asset][field] !== value) throw new Error(`CONFIG_OVERLAY_NOT_APPLIED:${asset}.${field}`);
      }
    }
    return mod.c17Input(payload.dataset, payload.opts);
  },
  CARRY(mod, payload) {
    return mod.carryInput(payload.data, payload.win, payload.capital, payload.opts);
  },
});

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) throw new Error(`USAGE:${argv[i]}`);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opts.root) throw new Error('USAGE:--root');
  return opts;
}

/** 核心与策略侧模块按钉版加载;返回 { Core, mod, files }。enforce=false 只用于 --probe(换钉时读新哈希)。 */
function loadPinned(root, strategy, enforce = true) {
  const spec = PIN.strategies[strategy];
  if (!spec) throw new Error(`STRATEGY_UNSUPPORTED:${strategy}`);
  const { pkgRoot, coreDir } = layout(root);
  if (enforce) assertCore(coreDir);
  const envBefore = new Set(Object.keys(process.env));
  const Core = require(coreDir);
  const self = Core.coreVersion();
  if (enforce && self.hash !== PIN.core.version_hash) throw new Error(`CORE_VERSION_MISMATCH:self=${self.hash.slice(0, 8)}`);
  const mod = require(path.join(pkgRoot, spec.module));
  if (enforce && mod.HOOKS_ID !== spec.hooks_id) throw new Error(`HOOKS_VERSION_MISMATCH:pin=${spec.hooks_id}:module=${mod.HOOKS_ID}`);
  const injected = Object.keys(process.env).filter((k) => !envBefore.has(k));
  if (injected.length) throw new Error(`SMARTFLOW_ENV_INJECTED:${injected.length}`);
  return { Core, mod, files: loadedPackageFiles(pkgRoot, coreDir), pkgRoot };
}

function probe(root, strategy) {
  const { Core, mod, files } = loadPinned(root, strategy, false);
  const core = coreDirHash(layout(root).coreDir);
  return { strategy, core_version_hash: core.hash, core_file_count: core.fileCount, core_self_reported: Core.coreVersion().hash, hooks_id: mod.HOOKS_ID, strategy_files_sha256: files.hash, strategy_files: files.files.length };
}

function execute(opts) {
  const job = JSON.parse(fs.readFileSync(opts.job, 'utf8'));
  if (job.kind !== JOB_KIND) throw new Error(`JOB_KIND_INVALID:${job.kind}`);
  const spec = PIN.strategies[job.strategy];
  if (!spec) throw new Error(`STRATEGY_UNSUPPORTED:${job.strategy}`);
  const { Core, mod, files, pkgRoot } = loadPinned(opts.root, job.strategy);
  if (files.hash !== spec.strategy_files_sha256) throw new Error(`STRATEGY_FILES_MISMATCH:pin=${String(spec.strategy_files_sha256).slice(0, 8)}:loaded=${files.hash.slice(0, 8)}`);
  const payloadPath = path.resolve(path.dirname(opts.job), job.payload_file);
  const bytes = fs.readFileSync(payloadPath);
  if (sha256Hex(bytes) !== job.payload_sha256) throw new Error('PAYLOAD_SHA256_MISMATCH');
  const payload = v8.deserialize(bytes);
  if (payload.kind !== PAYLOAD_KIND || payload.strategy !== job.strategy) throw new Error('PAYLOAD_KIND_INVALID');
  const input = BUILDERS[job.strategy](mod, payload, pkgRoot);
  if (input.fillRule.id !== spec.profile) throw new Error(`PROFILE_MISMATCH:${input.fillRule.id}`);
  const output = Core.run(input, { skipInputHash: Boolean(job.options && job.options.skipInputHash === true) });
  const outBytes = Core.canonBytes(output);
  fs.writeFileSync(opts.out, outBytes);
  return {
    kind: RECEIPT_KIND,
    strategy: job.strategy,
    profile: output.profile,
    core_version_hash: output.coreVersion.hash,
    hooks_id: output.hooksId,
    strategy_files_sha256: files.hash,
    payload_sha256: job.payload_sha256,
    input_hash: output.inputHash,
    output_sha256: sha256Hex(outBytes),
    output_bytes: outBytes.length,
  };
}

function main(argv) {
  try {
    const opts = parseArgs(argv);
    if (opts.probe) { process.stdout.write(`${JSON.stringify(probe(opts.root, opts.probe))}\n`); return 0; }
    for (const k of ['job', 'out', 'receipt']) if (!opts[k]) throw new Error(`USAGE:--${k}`);
    fs.writeFileSync(opts.receipt, `${JSON.stringify(execute(opts))}\n`);
    return 0;
  } catch (e) {
    // 只回 message(不回栈):路径之外不带任何环境信息
    process.stderr.write(`${String(e && e.message).split('\n')[0]}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { JOB_KIND, PAYLOAD_KIND, RECEIPT_KIND, C17_OVERLAY_FIELDS };
