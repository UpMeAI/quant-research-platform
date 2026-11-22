#!/usr/bin/env node
'use strict';

/**
 * 网络那一步的命令行（容器 rf1116-llm-step 的入口；run.sh 的 llm-step / llm-ping；见 DEPLOY.md「大模型一步」）。
 *
 *   serve --exchange DIR [--key-file FILE] [--poll-ms N]   常驻：答交换目录里的请求（执行器容器 --network none，只写请求文件）
 *   ping  --exchange DIR [--key-file FILE]                 探活：一条不含公式的请求；结果写进 DIR/ping-*.json；不开轮、不写台账、不计 N
 *
 * --key-file 默认是配置里的容器内路径（研究专用密钥，只读挂进来）。stdout 一行 JSON（从不含密钥、不含模型写的内容）。
 * 退出码：0 成功；75 等待（密钥不在、额度 / 限流 / 版本对不上 / 接口不可用）；2 出错（选项不认识、请求体不合规）。
 */
const step = require('./index');
const llm = require('../mining-sandbox/llm');

const OPTIONS = Object.freeze({ serve: ['exchange', 'key-file', 'poll-ms'], ping: ['exchange', 'key-file'] });

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(OPTIONS, cmd)) { const e = new Error(`MINE_LLM_STEP_COMMAND_UNKNOWN:${cmd}`); e.code = 'MINE_LLM_STEP_COMMAND_UNKNOWN'; throw e; }
  const o = {};
  for (let k = 0; k < rest.length; k += 2) {
    const key = rest[k].replace(/^--/, '');
    if (!rest[k].startsWith('--') || !OPTIONS[cmd].includes(key)) { const e = new Error(`MINE_LLM_STEP_OPTION_UNKNOWN:${cmd} ${rest[k]}`); e.code = 'MINE_LLM_STEP_OPTION_UNKNOWN'; throw e; }
    if (rest[k + 1] === undefined) { const e = new Error(`MINE_LLM_STEP_OPTION_VALUE_MISSING:${rest[k]}`); e.code = 'MINE_LLM_STEP_OPTION_VALUE_MISSING'; throw e; }
    o[key] = rest[k + 1];
  }
  if (!o.exchange) { const e = new Error('MINE_LLM_STEP_OPTION_REQUIRED:--exchange'); e.code = 'MINE_LLM_STEP_OPTION_REQUIRED'; throw e; }
  return { cmd, o };
}

async function main(argv) {
  const { cmd, o } = parseArgs(argv);
  const { config } = llm.loadConfig();
  const keyFile = o['key-file'] || config.key.container_path;
  step.lockEgress({ host: config.endpoint.host, port: config.endpoint.port });
  if (cmd === 'serve') return step.serve({ dir: o.exchange, keyFile, config, pollMs: o['poll-ms'] === undefined ? null : Number(o['poll-ms']) });
  const r = await step.ping({ dir: o.exchange, config, keyFile });
  process.stdout.write(`${JSON.stringify({ command: 'ping', ...r })}\n`);
  if (r.outcome === 'OK') return undefined;
  process.exitCode = String(r.outcome).startsWith('WAITING_') ? 75 : 2;
  return undefined;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`${JSON.stringify({ error: e.code || 'MINE_LLM_STEP_FAILED', message: step.redact(e.message) })}\n`);
    process.exitCode = 2;
  });
}

module.exports = { OPTIONS, parseArgs, main };
