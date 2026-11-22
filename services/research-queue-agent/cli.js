#!/usr/bin/env node
'use strict';
/**
 * 代理命令行（任务进程）：读 task.json 与 bundle.json，经本机 unix socket 调网关，把 result.json 与产物写到 --out。
 *   node cli.js --task task.json --bundle bundle.json --out <dir> --socket /run/rq-gw.sock --host LINUX|HK [--triage triage.json] [--max-pack-tokens n]
 * W24：本进程是生成方（review-agent）：启动后立刻上 W20 的读锁（写只许 --out 的上一级目录，因为先写临时目录再改名；读不许进留出段数据目录），
 *   并把它读的事实包写进访问记录 access_log.jsonl（与 result.json 同目录）。读留出段目录被拒 → 记一行 refused 的 HOLDOUT_READ，只写这份记录，退出码 5。
 * 只要写出了 result.json 就退出 0（状态在 result.status 里，由队列消费者按 queue-seam.transitionFor 处理）；退出码非 0 只表示用法错误或拒启（环境里有密钥）。
 * 环境里有 DEEPSEEK* / 密钥形状的值 → 拒启、什么也不写。输出先写临时目录再改名。
 */
const fs = require('fs');
const path = require('path');
const { assertKeylessEnv, runAgentTask } = require('./agent');
const { createGatewayClient } = require('./gateway-client');
const { canonicalJson } = require('./canon');
const { lockGenerator } = require('../independent-verifier/launcher');

function usage(msg) { process.stderr.write(`RQ_CLI_USAGE: ${msg}\n`); process.exit(2); }

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k.startsWith('--') || argv[i + 1] === undefined) usage(`bad argument ${k}`);
    o[k.slice(2)] = argv[i + 1];
  }
  return o;
}

/** 代理读到的是哪几天的事实：事实包里 `at` 的日期范围；一个日期都读不出就取任务号里的日期。 */
function factPackRead(bundle, task) {
  const days = ((bundle && bundle.pack && bundle.pack.facts) || []).map((f) => (f && typeof f.at === 'string' ? f.at.slice(0, 10) : '')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const m = /^RQT-(?:LINUX|HK)-(\d{4})(\d{2})(\d{2})-/.exec((task && task.task_id) || '');
  const fallback = m ? `${m[1]}-${m[2]}-${m[3]}` : '1970-01-01';
  return { dataset: 'REVIEW_FACT_PACK_V1', from: days.length ? days[0] : fallback, to: days.length ? days[days.length - 1] : fallback };
}

/** Consumer-side subcommands (Q3c): `stage` writes in/task.json + in/bundle.json, `validate` re-validates a result. Both print JSON; a validation verdict is exit 0, a crash is not. */
function consumerCommand(sub, argv) {
  const a = args(argv);
  const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  if (sub === 'stage') {
    for (const k of ['row-json', 'input', 'out']) if (!a[k]) usage(`--${k} is required`);
    const { stageFiles } = require('./stage');
    const { buildRegistryView } = require('./registries');
    const s = stageFiles({ row: JSON.parse(a['row-json']), input: readJson(a.input), buildRegistry: (market) => buildRegistryView({ market }) });
    fs.mkdirSync(a.out, { recursive: true });
    for (const [name, doc] of [['task.json', s.task], ['bundle.json', s.bundle]]) {
      fs.writeFileSync(path.join(a.out, `${name}.tmp`), `${canonicalJson(doc)}\n`);
      fs.renameSync(path.join(a.out, `${name}.tmp`), path.join(a.out, name));
    }
    process.stdout.write(`${canonicalJson({ staged: true, task_id: s.task.task_id })}\n`);
    return;
  }
  for (const k of ['task', 'bundle', 'result']) if (!a[k]) usage(`--${k} is required`);
  const { validateResult } = require('./validate-result');
  const task = readJson(a.task); const bundle = readJson(a.bundle);
  let result = null;
  try { result = readJson(a.result); } catch (e) { process.stdout.write(`${canonicalJson({ ok: false, codes: ['RESULT_UNPARSEABLE'], output_sha256: null })}\n`); return; }
  process.stdout.write(`${canonicalJson(validateResult({ task, bundle, result }))}\n`);
}

async function main() {
  if (['stage', 'validate'].includes(process.argv[2])) { consumerCommand(process.argv[2], process.argv.slice(3)); return; }
  try { assertKeylessEnv(process.env); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(3); }
  const a = args(process.argv.slice(2));
  for (const k of ['task', 'bundle', 'out', 'socket', 'host']) if (!a[k]) usage(`--${k} is required`);
  if (!['LINUX', 'HK'].includes(a.host)) usage('--host must be LINUX or HK');
  const tmp = `${a.out}.tmp-${process.pid}`;
  fs.mkdirSync(tmp, { recursive: true });
  const lock = lockGenerator({ principal: 'review-agent', allowWriteRoot: path.dirname(path.resolve(a.out)), accessLogFile: path.join(tmp, 'access_log.jsonl') });
  let task; let bundle;
  try {
    task = JSON.parse(fs.readFileSync(a.task, 'utf8'));
    bundle = JSON.parse(fs.readFileSync(a.bundle, 'utf8'));
  } catch (e) {
    if (e && e.code === 'VERIFIER_HOLDOUT_READ_REFUSED') { fs.renameSync(tmp, a.out); process.stderr.write(`${e.code}: ${String(e.message).slice(0, 300)}\n`); process.exit(5); }
    fs.rmSync(tmp, { recursive: true, force: true }); // a failed start leaves nothing behind
    throw e;
  }
  lock.recordRead(factPackRead(bundle, task));
  const table = a.triage ? JSON.parse(fs.readFileSync(a.triage, 'utf8')) : null;
  const triage = table ? ({ mechanism_id, market }) => table[`${market}:${mechanism_id}`] || null : undefined;
  const qg = [];
  let result;
  try {
    result = await runAgentTask(task, bundle, { client: createGatewayClient({ socketPath: a.socket }), env: process.env, host: a.host, triage, writeQualityRecord: (r) => qg.push(r),
      maxPackTokens: a['max-pack-tokens'] ? Number(a['max-pack-tokens']) : undefined });
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); process.stderr.write(`${e.code || 'RQ_AGENT_ERROR'}: ${String(e.message).slice(0, 300)}\n`); process.exit(4); }

  const w = (name, text) => fs.writeFileSync(path.join(tmp, name), text);
  const jsonl = (rows) => rows.map((r) => canonicalJson(r)).join('\n') + (rows.length ? '\n' : '');
  const o = result.outputs || {};
  if (o.card) {
    w('card.json', `${canonicalJson(o.card)}\n`);
    w('factor_ideas.jsonl', jsonl(o.factor_ideas));
    w('idea_routes.jsonl', jsonl(o.idea_routes));
    w('proposals.jsonl', jsonl(o.proposals));
  }
  if (o.check_report) w('check_report.json', `${canonicalJson(o.check_report)}\n`);
  if (qg.length) w('quality_gate.json', `${canonicalJson(qg)}\n`);
  w('result.json', `${canonicalJson(result)}\n`);
  fs.renameSync(tmp, a.out);
  process.stdout.write(`status=${result.status} task_id=${result.task_id}\n`);
}

main();
