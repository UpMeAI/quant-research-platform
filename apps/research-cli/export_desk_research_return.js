#!/usr/bin/env node
'use strict';
/**
 * 导出回程文件 QRP_RESEARCH_RETURN_V1（复盘闭环修订 6 主稿 §5.1；QRP 一侧说明 §2 第 4 条）：QRP 采用记录、两本锁账本与回链账本的投影，
 * 不带新的判断，不改任何账本。
 *
 *   node apps/research-cli/export_desk_research_return.js --out /abs/dir
 *
 * --out 必填，没有默认目录（不默认写进 desk checkout）；文件名 QRP_RESEARCH_RETURN_<YYYYMMDDTHHMMZ>.json，同名已存在时拒绝。
 * 由协调会话把它放进 desk 的 docs/review-loop/research-return/ 并随周档提交。
 */
const returns = require('../../services/desk-review-routing/return');

try {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== '--out' || !argv[1] || argv[1].startsWith('--')) throw new Error('USAGE:--out <dir>');
  const result = returns.exportReturn({ outDir: argv[1] });
  process.stdout.write(`${JSON.stringify({
    file: result.file, sha256: result.sha256, hash: result.payload.hash,
    decisions: result.payload.decisions.length, questions: result.payload.questions.length, production_effect: 'NONE',
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
