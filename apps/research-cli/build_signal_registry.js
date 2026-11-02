#!/usr/bin/env node
'use strict';
/**
 * 建 SIGNAL_REGISTRY_V1（美股、加密信号登记簿，规格 docs/contracts/SIGNAL_REGISTRY_V1.md）并对记分牌做一致性比较。
 *
 *   node apps/research-cli/build_signal_registry.js --inbox <desk inbox 根目录> [--books US_V5_ETF_3000USD,C17_V2_4000USDT] \
 *     [--period-to 2026-11-01] [--out SIGNAL_REGISTRY_V1.json] [--conformance-out SIGNAL_REGISTRY_V1.conformance.json]
 *
 * 只读收件箱里已交付的文件（记分牌、成交台账、周复盘、持仓快照），不联网、不取数、不写台账、不碰生产参数。
 * 与记分牌有任何一处不同就退出码 1（差异写在一致性文件里）。
 */
const fs = require('fs');
const path = require('path');
const registry = require('../../services/signal-registry');
const { compareRegistry } = require('../../services/signal-registry/conformance');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
const write = (file, payload) => { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`); };

try {
  const f = flags(process.argv.slice(2));
  if (!f.inbox) throw new Error('MISSING_FLAG:inbox');
  const root = path.resolve(f.inbox);
  const ids = f.books ? f.books.split(',') : Object.keys(registry.BOOKS);
  const inputs = ids.map((id) => registry.readBookInputs(root, id, { periodTo: f['period-to'] || null }));
  const reg = registry.buildRegistry(inputs);
  const report = compareRegistry(reg, Object.fromEntries(inputs.map((i) => [i.ledgerId, i.scoreboard.json])));
  if (f.out) write(f.out, reg);
  if (f['conformance-out']) write(f['conformance-out'], report);
  process.stdout.write(`${JSON.stringify({
    schema: reg.schema, hash: reg.hash, books: reg.books.map((b) => `${b.ledgerId}@${b.period.to}`), rows: reg.rows.length,
    conformance: { compared: report.compared, differences: report.differences },
    sourceDivergences: reg.books.reduce((n, b) => n + b.sourceChecks.divergences.length, 0), production_effect: 'NONE',
  })}\n`);
  if (report.differences > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
