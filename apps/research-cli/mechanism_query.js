#!/usr/bin/env node
'use strict';
/**
 * 机制分诊查询（研究框架修订 2026-11-12 §4.3、§4.4）：列出同机制、同市场的全部封存结论，给出路由读数，输出 MECHANISM_PRIOR_TABLE_V1。
 *
 *   mechanism_query.js --mechanism-id <id> [--mechanism-id <id> …] --market CN_A|US_EQUITY|CRYPTO --as-of <ISO +08:00>
 *                      [--owner-named true] [--register-commit <40 hex> [--repo <QRP 仓库>]] [--out <file.json>]
 *
 *   --register-commit：从这个提交读登记表（K2 冻结时用；G-MECH 只认带提交的表）。不给时读工作区的登记表，表里 commit = null。
 *   --as-of：K2 冻结时刻或分诊时刻；只取这之前登记的数据段标签（本机试验台账，只读）。
 *   --out：写出表的规范字节，stdout 打一行 sha256 与路由；不给时把表写到 stdout。
 *
 * 只读：不写台账、不写分诊记录、不改任何封存文件。参数未知或缺失时失败即关。production_effect: NONE。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const mech = require('../../services/research-mechanism-register');

const REPEATABLE = new Set(['mechanism-id']);
const ALLOWED = new Set(['mechanism-id', 'market', 'as-of', 'owner-named', 'register-commit', 'repo', 'out']);

function flags(argv) {
  const out = { 'mechanism-id': [] };
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    const key = argv[i].slice(2);
    if (!ALLOWED.has(key)) throw new Error(`UNKNOWN_FLAG:${key}`);
    if (REPEATABLE.has(key)) out[key].push(argv[i + 1]);
    else if (out[key] !== undefined) throw new Error(`DUPLICATE_FLAG:${key}`);
    else out[key] = argv[i + 1];
  }
  return out;
}

function main(argv) {
  const f = flags(argv);
  if (!f['mechanism-id'].length) throw new Error('MISSING_FLAG:mechanism-id');
  for (const key of ['market', 'as-of']) if (!f[key]) throw new Error(`MISSING_FLAG:${key}`);
  if (f['owner-named'] !== undefined && !['true', 'false'].includes(f['owner-named'])) throw new Error('BAD_FLAG_VALUE:owner-named');
  if (f.repo !== undefined && f['register-commit'] === undefined) throw new Error('FLAG_REQUIRES:repo→register-commit');
  let registerBytes;
  let registerCommit = null;
  if (f['register-commit'] !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(f['register-commit'])) throw new Error('BAD_FLAG_VALUE:register-commit');
    const repo = path.resolve(f.repo || path.join(__dirname, '..', '..'));
    registerBytes = execFileSync('git', ['-C', repo, 'show', `${f['register-commit']}:${mech.REGISTER_PATH}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    registerCommit = f['register-commit'];
  } else {
    registerBytes = fs.readFileSync(mech.FILE);
  }
  const table = mech.query({ mechanism_ids: f['mechanism-id'], market: f.market, owner_named: f['owner-named'] === 'true' },
    { registerBytes, registerCommit, asOf: f['as-of'] });
  const bytes = mech.tableBytes(table);
  if (f.out) {
    fs.writeFileSync(path.resolve(f.out), bytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    process.stdout.write(`${mech.TABLE_SCHEMA} sha256=${sha} route=${table.route} out=${path.resolve(f.out)}\n`);
  } else {
    process.stdout.write(bytes);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
