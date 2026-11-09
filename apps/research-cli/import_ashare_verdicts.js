#!/usr/bin/env node
'use strict';
/**
 * A 股研究封存结论导入（ASHARE_SEALED_VERDICT_V1，docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1.md）。
 *
 *   node apps/research-cli/import_ashare_verdicts.js stage --ashare-v6-root /abs/Ashare-V6 --artifacts-root /abs/artifacts/coordinator --out /abs/var/evidence/ashare-verdicts-<date>
 *   QRP_PRODUCT_MILESTONE_AUTHORITY=<完成权威> [QRP_DATA_DIR=<台账副本>] node apps/research-cli/import_ashare_verdicts.js import --evidence /abs/var/evidence/ashare-verdicts-<date> --registered-by <完成权威>
 *
 * stage 只取字节并核 sha256；import 整批校验后追加锁，重复导入是幂等重放。没有下单、激活、生产参数写入，也没有 HTTP 写入口。
 */
const verdicts = require('../../services/ashare-sealed-verdicts');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

try {
  const [command, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (command === 'stage') {
    for (const k of ['ashare-v6-root', 'artifacts-root', 'out']) if (!f[k]) throw new Error(`MISSING_FLAG:${k}`);
    const manifest = verdicts.stageEvidence({ ashareV6Root: f['ashare-v6-root'], artifactsRoot: f['artifacts-root'], out: f.out });
    process.stdout.write(`${JSON.stringify({ staged: manifest.files.length, entries: manifest.entries.length, out: f.out })}\n`);
  } else if (command === 'import') {
    for (const k of ['evidence', 'registered-by']) if (!f[k]) throw new Error(`MISSING_FLAG:${k}`);
    for (const row of verdicts.importVerdicts(f.evidence, { registeredBy: f['registered-by'] })) {
      process.stdout.write(`${JSON.stringify({ result_id: row.result_id, entry_id: row.entry_id, strategy_ref: row.strategy_ref, kind: row.kind,
        decision: row.decision, sealed_on: row.sealed_on, file_sha256: row.file_sha256, replay: Boolean(row.replayHit), production_effect: 'NONE' })}\n`);
    }
  } else throw new Error(`UNKNOWN_COMMAND:${command || ''}（stage | import）`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
