#!/usr/bin/env node
'use strict';
/**
 * 记一条 Research 分诊 RESEARCH_TRIAGE_V1（desk 复盘闭环修订 7 §3.3，2026-10-27 冻结 FREEZE_1）：只写 QRP 本机账本
 * research/desk_triage.jsonl（QRP_DATA_DIR，默认 var/ledger；gitignored），不碰 desk、不碰 git。读最新一份 desk 研究队列（复盘镜像
 * QRP_DESK_REVIEW_LOOP_ROOT，没设时 QRP_DESK_ROOT）。任何一项不合规就拒收，退出码 1，什么也不写。
 *
 *   node apps/research-cli/record_desk_triage.js --candidate RLC-CN-2000W01-1 --outcome CLOSE --code AS_DESIGNED \
 *        --evidence '[{"kind":"REPO","repo":"portfolio-desk","path":"docs/X.md","commit":"<40 hex>","clause":"§3"}]' \
 *        --basis '一句事实' --at 2026-11-03T10:00:00+08:00 [--session local_…] [--supersedes RTR-…] [--desk-root DIR]
 *   立题：--outcome OPEN_QUESTION --question-ref DQ-RQK-…（或研究计划里的新题号）
 *   转工程修复：--outcome FIX --fix-repo Ashare-V6|smartflow|portfolio-desk --fix-ref <任务、分支或 PR>
 *   并入：--outcome MERGE --code COVERED_BY_QUESTION|COVERED_BY_CANDIDATE --merged-into <题号或 RLC-…> [--evidence …]
 */
const triage = require('../../services/desk-review-routing/triage');

const KNOWN = ['candidate', 'outcome', 'code', 'question-ref', 'merged-into', 'fix-repo', 'fix-ref', 'evidence', 'basis', 'at', 'session', 'supersedes', 'desk-root'];

try {
  const argv = process.argv.slice(2);
  const f = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${key}`);
    if (!KNOWN.includes(key.slice(2))) throw new Error(`UNKNOWN_FLAG:${key}`);
    f[key.slice(2)] = argv[i + 1];
  }
  let evidence = [];
  if (f.evidence) {
    try { evidence = JSON.parse(f.evidence); } catch { throw new Error('TRIAGE_EVIDENCE_NOT_JSON'); }
    if (!Array.isArray(evidence)) throw new Error('TRIAGE_EVIDENCE_NOT_JSON');
  }
  const row = triage.recordTriage({
    candidateId: f.candidate, outcome: f.outcome, reasonCode: f.code || null, questionRef: f['question-ref'] || null, mergedInto: f['merged-into'] || null,
    fixRef: f['fix-repo'] || f['fix-ref'] ? { repo: f['fix-repo'], ref: f['fix-ref'] } : null, evidence, basisZh: f.basis, at: f.at,
    sessionRef: f.session || null, supersedes: f.supersedes || null,
  }, { deskRoot: f['desk-root'] });
  process.stdout.write(`${JSON.stringify({ record_id: row.record_id, record_hash: row.record_hash, candidate_id: row.candidate_id, outcome: row.outcome,
    reason_code: row.reason_code, queue_file: row.queue_file, production_effect: 'NONE' })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
