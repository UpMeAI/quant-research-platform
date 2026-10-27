#!/usr/bin/env node
'use strict';
/**
 * 按策略档案补开运行态 case（复盘闭环修订 6 D6 ★；QRP 一侧说明 §2 第 2 条）。每个字段取自档案、当前 Q0 基线锁与档案登记的 M1 证据包；
 * 必填字段没有真实来源时拒绝并写出缺哪个字段（CASE_FACT_MISSING:<字段>），不开 case。
 *
 *   node apps/research-cli/open_profile_case.js --strategy US_CORE_9000USD_3X_GATEOBS [--dry-run]
 *
 * --dry-run  只打印将要写入的 openCase 输入，不写账。
 * 不带 --dry-run 会写 cases.jsonl（只追加；已存在同一 case 时原样返回）。case 的来源路径按本检出的仓库根写，只在主检出上运行。
 */
const profileCases = require('../../services/runtime-research-loop/profile_cases');

try {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const rest = argv.filter((item) => item !== '--dry-run');
  if (rest.length !== 2 || rest[0] !== '--strategy' || !rest[1]) throw new Error('USAGE:--strategy <strategy_ref> [--dry-run]');
  const out = dryRun ? { dry_run: true, input: profileCases.caseInputFor(rest[1]) } : profileCases.ensureProfileCase(rest[1]);
  process.stdout.write(`${JSON.stringify(out)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
