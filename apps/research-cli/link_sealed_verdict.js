#!/usr/bin/env node
'use strict';
/**
 * 回链绑定封存研究结论锁（海外导入规格修订 9，runtime-research-loop.linkSealedVerdict）：desk 研究队列来的题（DQ-…）
 * 还在 PENDING 时，指向同 case 的一把封存结论锁（OSV-… / ASV-…），回程 sealedVerdicts 的那一行就带上 deskLink。
 *
 *   [QRP_DATA_DIR=<台账副本>] node apps/research-cli/link_sealed_verdict.js \
 *     --link-id RRL-… --result-id OSV-… --expected-file-sha256 <64 位> [--dry-run 1] [--recorded-at <ISO>]
 *
 * --dry-run 1 只核对并打印将写的行，不写账本。先在台账副本上试，真实台账由协调会话合并后写（先备份）。
 * 只追加一行回链；不写采用记录（封存结论不是 Owner 的决定），不改锁、判据或证据，没有生产动作。
 */
const loop = require('../../services/runtime-research-loop');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

try {
  const f = flags(process.argv.slice(2));
  for (const k of ['link-id', 'result-id', 'expected-file-sha256']) if (!f[k]) throw new Error(`MISSING_FLAG:${k}`);
  for (const k of Object.keys(f)) if (!['link-id', 'result-id', 'expected-file-sha256', 'dry-run', 'recorded-at'].includes(k)) throw new Error(`UNKNOWN_FLAG:${k}`);
  if (f['dry-run'] !== undefined && f['dry-run'] !== '1') throw new Error(`BAD_ARGUMENTS:dry-run=${f['dry-run']}`);
  const row = loop.linkSealedVerdict(f['link-id'], { result_id: f['result-id'], expected_file_sha256: f['expected-file-sha256'] },
    { dryRun: f['dry-run'] === '1', ...(f['recorded-at'] ? { recorded_at: f['recorded-at'] } : {}) });
  process.stdout.write(`${JSON.stringify({
    dry_run: Boolean(row.dryRun), replay: Boolean(row.replayHit), link_id: row.link_id, desk_candidate_ref: row.desk_candidate_ref,
    research_question_ref: row.research_question_ref, result_ref: row.result_ref, result_hash: row.result_hash, conclusion: row.conclusion,
    adoption_state: row.adoption_state, recorded_at: row.recorded_at, link_hash: row.link_hash, production_effect: 'NONE',
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
