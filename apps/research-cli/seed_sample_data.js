#!/usr/bin/env node
'use strict';
/**
 * 样本数据种子器(SAMPLE_SYNTHETIC)。
 * 用法:node apps/research-cli/seed_sample_data.js --market CN_A [--force]
 * 仅供平台链路演示与确定性测试;真实行情走 Ashare-V5 research-adapter 或 ingestBars(source=真实源)。
 */
const args = process.argv.slice(2);
const marketId = args.includes('--market') ? args[args.indexOf('--market') + 1] : 'CN_A';
const force = args.includes('--force');

if (marketId !== 'CN_A') {
  console.error(`仅支持 CN_A(收到 ${marketId});其他市场按 §14.1 合同接入各自 adapter`);
  process.exit(1);
}

const pit = require('../../adapters/ashare-local/pit_store');
const { generateSampleBars } = require('../../adapters/ashare-local/sample_data');

const before = pit.coverage();
if (before.barCount > 0 && !force) {
  console.log(`PIT 仓库已有数据(${before.barCount} bars,${before.dateFrom}..${before.dateTo},sources=${before.sources.join(',')});跳过。--force 可追加重灌`);
  process.exit(0);
}
const { bars, stockIds } = generateSampleBars();
pit.ingestBars(bars, { source: 'SAMPLE_SYNTHETIC' });
const after = pit.coverage();
console.log(`已生成样本宇宙:${stockIds.length} 只股票 + 基准;共 ${after.barCount} bars,${after.dateFrom}..${after.dateTo}`);
console.log('⚠ source=SAMPLE_SYNTHETIC —— 演示/测试数据,不是真实行情');
