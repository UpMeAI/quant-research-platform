#!/usr/bin/env node
'use strict';

/**
 * 声明锁的漂移核对（#110，ENGINE_MODELING_ACCEPTANCE_V1 §2.2 第 2 条）：协调会话每次部署之后，用新部署的提交核对一遍
 * config/fill_model_declarations.v1.json 的锁。只读（git show），不改声明。
 *
 *   node tools/fill-model-declarations/check-locks.js [--commit ashare-v6=<40 位提交号>] [--commit smartflow=<40 位提交号>]
 *
 * 不写 --commit 时核对声明里钉住的提交。每条锁一行；有 FAIL 或 SKIPPED 时退出码 1。
 */
const decl = require('../../services/fill-model-declarations');

if (require.main === module) {
  const args = process.argv.slice(2);
  const commits = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--commit') throw new Error(`unknown argument ${args[i]}`);
    const [repo, sha] = String(args[i + 1] || '').split('=');
    commits[repo] = sha;
    i += 1;
  }
  const results = decl.verifyLocks(decl.load(), { commits });
  for (const r of results) process.stdout.write(`${r.state}\t${r.repo}@${r.commit.slice(0, 8)}\t${r.id}\t${r.actual === undefined ? '' : r.actual}\t${r.reason || ''}\n`);
  process.exitCode = results.every((r) => r.state === 'PASS') ? 0 : 1;
}
