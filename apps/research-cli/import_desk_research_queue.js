#!/usr/bin/env node
'use strict';
/**
 * 导入 desk 研究队列 REVIEW_LOOP_RESEARCH_QUEUE_V1（复盘闭环修订 6 主稿 §4.3；QRP 一侧说明 §2 第 1 条）。只读 desk checkout，
 * 每个 questionKey 在 runtime-research-loop 的 links.jsonl 里只登记一条回链；以后的周什么也不写。只写 QRP 数据目录（QRP_DATA_DIR，默认 var/ledger）。
 *
 *   node apps/research-cli/import_desk_research_queue.js [--file REVIEW_LOOP_RESEARCH_QUEUE_2026-W43.json] [--desk-root /abs/portfolio-desk] [--open-cases]
 *
 * --file        不给 = docs/review-loop/research-queue/ 里最新的一份（按周与修订号）；
 * --desk-root   不给 = QRP_DESK_ROOT，再不给 = 与 QRP 同级的 portfolio-desk；
 * --open-cases  某行的策略还没有运行态 case 时，按策略档案的事实补开（写 cases.jsonl；运行上的一步，由协调会话在主检出上做）。
 *               case 的来源路径按本检出的仓库根写，所以只在主检出 /Users/kaylame/KaylaProject/quant-research-platform 上运行。
 * 输出一行 JSON 摘要（登记、未变、拒收的行及原因码）；文件级核对不过时整份拒收，退出码 1，什么也不写。
 */
const routing = require('../../services/desk-review-routing');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`BAD_ARGUMENTS:${key}`);
    if (key === '--open-cases') { out['open-cases'] = true; continue; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`BAD_ARGUMENTS:${key}`);
    out[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

try {
  const f = flags(process.argv.slice(2));
  for (const key of Object.keys(f)) if (!['file', 'desk-root', 'open-cases'].includes(key)) throw new Error(`UNKNOWN_FLAG:${key}`);
  const summary = routing.importQueue({ deskRoot: f['desk-root'], file: f.file || null, openCases: Boolean(f['open-cases']) });
  process.stdout.write(`${JSON.stringify({ ...summary, production_effect: 'NONE' })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
