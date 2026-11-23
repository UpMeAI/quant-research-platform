#!/usr/bin/env node
'use strict';
/**
 * W05「复盘已看过 = 开发信息」的命令行前门（plan-coord 裁定 11-23，W05_REVIEWED_IS_SEEN_RULING_V1）。事实包入库的程序（Mac 中继、主机上的队列生产者）把交付的包交给它，
 * 由它往试验台账写 SEEN 标记；中继与生产者只决定什么时候调、失败算什么，不自己写台账。写命令只有完成权威能执行（QRP_PRODUCT_MILESTONE_AUTHORITY，也可 --registered-by）。
 * 台账在 $QRP_DATA_DIR/research/（默认 var/ledger/research/，不进 git）。production_effect: NONE。
 *
 *   review_pack_seen.js mark     --file <包文件 | ->  [--registered-by <权威>] [--registered-at <ISO>] [--dry-run true]
 *        一份包（AI 复盘卡事实包 REVIEW_AI_FACT_PACK_V1 或人工周编 REVIEW_LOOP_WEEK_V1；- = 标准输入）：每个市场一条 SEEN 标记，按包内容 sha256 幂等。
 *   review_pack_seen.js backfill --archive <目录> [--archive <目录> …] [--expect <expected.json>] [--registered-by <权威>] [--registered-at <ISO>] [--dry-run true]
 *        从存档目录回填已交付过的包（只读）；expected.json = [{kind, week_id, revision?, market?}]，没有存档的列进 missing，不猜。
 *   review_pack_seen.js through  --market <CN_A|US_EQUITY|CRYPTO> [--as-of <ISO>]
 *        该市场复盘看到哪天（由标记推出，不另存）。
 *
 * 出错：退出码 1，标准错误第一个记号是错误码（REVIEW_PACK_SEEN_* 或 TRIAL_LEDGER_*）；用法错误退出码 2。成功只在标准输出写一行 JSON。
 */
const fs = require('fs');
const path = require('path');
const reviewSeen = require('../../services/trial-ledger/review_pack_seen');

function parse(argv) {
  const out = { archive: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k.startsWith('--') || argv[i + 1] === undefined) throw Object.assign(new Error(`BAD_ARGUMENTS:${k}`), { usage: true });
    if (k === '--archive') out.archive.push(argv[i + 1]); else out[k.slice(2)] = argv[i + 1];
  }
  return out;
}
const ALLOWED = Object.freeze({
  mark: ['file', 'registered-by', 'registered-at', 'dry-run'],
  backfill: ['archive', 'expect', 'registered-by', 'registered-at', 'dry-run'],
  through: ['market', 'as-of'],
});

function authorityOf(f) {
  const by = f['registered-by'] || process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  if (!by) throw Object.assign(new Error('TRIAL_LEDGER_AUTHORITY_NOT_CONFIGURED: QRP_PRODUCT_MILESTONE_AUTHORITY (or --registered-by) is required'), { code: 'TRIAL_LEDGER_AUTHORITY_NOT_CONFIGURED' });
  return by;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!ALLOWED[cmd]) throw Object.assign(new Error(`UNKNOWN_COMMAND:${cmd}`), { usage: true });
  const f = parse(rest);
  for (const k of Object.keys(f)) if (!ALLOWED[cmd].includes(k) && !(k === 'archive' && f.archive.length === 0)) throw Object.assign(new Error(`UNKNOWN_FLAG:${k}`), { usage: true });
  const common = () => ({ registeredBy: authorityOf(f), registeredAt: f['registered-at'] || null, dryRun: f['dry-run'] === 'true' });
  if (cmd === 'mark') {
    if (!f.file) throw Object.assign(new Error('MISSING_FLAG:file'), { usage: true });
    const bytes = f.file === '-' ? fs.readFileSync(0) : fs.readFileSync(path.resolve(f.file));
    return { marks: reviewSeen.markBytes(bytes, common()).map(reviewSeen.summary) };
  }
  if (cmd === 'backfill') {
    if (!f.archive.length) throw Object.assign(new Error('MISSING_FLAG:archive'), { usage: true });
    const expected = f.expect ? JSON.parse(fs.readFileSync(path.resolve(f.expect), 'utf8')) : [];
    return reviewSeen.backfill({ archives: f.archive.map((a) => path.resolve(a)), expected, ...common() });
  }
  if (!f.market) throw Object.assign(new Error('MISSING_FLAG:market'), { usage: true });
  return { market: f.market, reviewed_through: reviewSeen.reviewedThrough(f.market, { asOf: f['as-of'] || null }) };
}

try {
  process.stdout.write(`${JSON.stringify({ ...main(process.argv.slice(2)), production_effect: 'NONE' })}\n`);
} catch (error) {
  const code = error.code || (error.usage ? 'USAGE' : 'ERROR');
  process.stderr.write(`${/^[A-Z][A-Z0-9_]{2,}:/.test(error.message) || /^[A-Z][A-Z0-9_]{2,}$/.test(error.message) ? error.message : `${code}: ${error.message}`}\n`);
  process.exitCode = error.usage ? 2 : 1;
}
