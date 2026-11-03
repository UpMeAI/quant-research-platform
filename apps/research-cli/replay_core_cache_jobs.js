#!/usr/bin/env node
'use strict';
/**
 * 从真实研究缓存写 replay-core 作业,并在本机重跑核对(适配器 adapters/replay-core-bridge,钉住的 smartflow 见 pin.json)。
 *
 *   QRP_SMARTFLOW_ROOT=<smartflow@pin,含 node_modules> \
 *   node apps/research-cli/replay_core_cache_jobs.js write --source CARRY --out <作业目录> --args <参数 JSON 文件>
 *   node apps/research-cli/replay_core_cache_jobs.js run   --source CARRY --out <作业目录> [--receipt <回执文件>]
 *
 * 来源与参数见 adapters/replay-core-bridge/cache_jobs.js(CARRY / C17_CACHE / C17_AGENT_LIVE / C17_V2_LIVE / US_V5_RECORDS)。
 * 只读缓存,不联网、不取数、不写台账、不碰生产参数。write:harness 判定不是 BYTE_IDENTICAL 时退出码 1;
 * run:任一作业输出与清单记录的 harness 字节不同,退出码 1。
 */
const fs = require('fs');
const path = require('path');
const bridge = require('../../adapters/replay-core-bridge');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  for (const k of ['source', 'out']) if (!f[k]) throw new Error(`MISSING_FLAG:${k}`);
  if (cmd === 'write') {
    if (!f.args) throw new Error('MISSING_FLAG:args');
    const m = bridge.writeCacheJobs(f.source, JSON.parse(fs.readFileSync(f.args, 'utf8')), f.out);
    process.stdout.write(`${m.source} harness=${m.harness_verdict} windows=${m.harness.length} jobs=${m.jobs.length}\n`);
    process.exitCode = m.harness_verdict === 'BYTE_IDENTICAL' ? 0 : 1;
  } else if (cmd === 'run') {
    const r = bridge.runCacheJobs(f.out, f.source);
    if (f.receipt) {
      fs.mkdirSync(path.dirname(path.resolve(f.receipt)), { recursive: true });
      fs.writeFileSync(f.receipt, `${JSON.stringify(r, null, 1)}\n`);
    }
    process.stdout.write(`${r.source} ${r.verdict} identical=${r.identical} different=${r.different} env=${r.env.platform}/${r.env.arch}/node${r.env.node}\n`);
    process.exitCode = r.verdict === 'BYTE_IDENTICAL' ? 0 : 1;
  } else {
    throw new Error('USAGE:write|run');
  }
} catch (e) {
  process.stderr.write(`${String(e && e.message).split('\n')[0]}\n`);
  process.exitCode = 2;
}
