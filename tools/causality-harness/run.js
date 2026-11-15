#!/usr/bin/env node
'use strict';

/**
 * G-CAUSAL 公用工具命令行（修订草稿 §3.5）。
 *
 *   node tools/causality-harness/run.js --manifest <清单> --registered-by <会话> [--out <证据.json>] [--code-root <目录>]
 *        [--extra-code-root <目录>]… [--python <解释器>] [--timeout-ms <毫秒>] [--isolation MODULE_RELOAD|PROCESS_PER_CALL]
 *
 * 不写 --out 时只打印结果。证据写一次不改（目标已存在即拒绝），旁边写 .sha256。
 * 退出码：0 = 每个函数三项全 PASS 且 unknown 为空；2 = 有 FAIL 或 unknown（证据照写，供只报与缺陷流程）；1 = 清单或运行错误。
 */
const core = require('./lib/core');

function parse(argv) {
  const opts = { extraCodeRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(`missing value for ${a}`); i += 1; return v; };
    if (a === '--manifest') opts.manifest = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--registered-by') opts.registeredBy = next();
    else if (a === '--code-root') opts.codeRoot = next();
    else if (a === '--extra-code-root') opts.extraCodeRoots.push(next());
    else if (a === '--python') opts.python = next();
    else if (a === '--timeout-ms') opts.timeoutMs = Number(next());
    else if (a === '--isolation') opts.isolation = next();
    else throw new Error(`unknown flag ${a}`);
  }
  if (!opts.manifest || !opts.registeredBy) throw new Error('usage: run.js --manifest <file> --registered-by <name> [--out <file>]');
  return opts;
}

function main() {
  let opts;
  try { opts = parse(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); return 1; }
  const doc = core.runManifest(opts.manifest, opts);
  for (const f of doc.functions) {
    const why = Object.entries(f.fail_reasons).map(([k, v]) => `${k}=${v}`).join(' ');
    process.stdout.write(`${f.t_c1} ${f.t_c2} ${f.t_c3}  ${f.function_id}  cuts=${f.cut_points.length} calls=${f.calls}${why ? `  ${why}` : ''}\n`);
  }
  for (const [k, v] of Object.entries(doc.unknown)) process.stdout.write(`UNKNOWN ${k}=${v}\n`);
  if (opts.out) process.stdout.write(`evidence ${opts.out} sha256=${core.writeEvidence(opts.out, doc)} record_hash=${doc.record_hash}\n`);
  const pass = doc.functions.every((f) => f.t_c1 === 'PASS' && f.t_c2 === 'PASS' && f.t_c3 === 'PASS') && !Object.keys(doc.unknown).length;
  return pass ? 0 : 2;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { process.stderr.write(`${e.code || 'ERROR'} ${e.message}\n`); process.exitCode = 1; }
}

module.exports = { parse };
