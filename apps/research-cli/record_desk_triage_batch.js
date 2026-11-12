#!/usr/bin/env node
'use strict';
/**
 * 把 Research 已明确裁定的多条分诊一次记入 RESEARCH_TRIAGE_V1。
 * 本命令不从 desk 候选推断结果；输入必须逐条给出 outcome、依据与 Research 裁定。
 * 默认拒绝运行：只读核对必须带 --dry-run，真实写 QRP 本地台账必须带 --confirm-write。
 *
 *   node apps/research-cli/record_desk_triage_batch.js --input /abs/decisions.json --desk-root /abs/desk-mirror --dry-run
 */
const fs = require('fs');
const path = require('path');
const triage = require('../../services/desk-review-routing/triage');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length;) {
    const key = argv[i];
    if (key === '--dry-run' || key === '--confirm-write') { out[key.slice(2)] = true; i += 1; continue; }
    if (!['--input', '--desk-root'].includes(key) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`BAD_ARGUMENTS:${key}`);
    out[key.slice(2)] = argv[i + 1];
    i += 2;
  }
  return out;
}

const summary = (row) => ({ record_id: row.record_id, record_hash: row.record_hash, candidate_id: row.candidate_id, outcome: row.outcome,
  reason_code: row.reason_code, queue_file: row.queue_file });

try {
  const f = flags(process.argv.slice(2));
  if (!f.input) throw new Error('INPUT_REQUIRED');
  if (Boolean(f['dry-run']) === Boolean(f['confirm-write'])) throw new Error('CHOOSE_EXACTLY_ONE:--dry-run|--confirm-write');
  let payload;
  try { payload = JSON.parse(fs.readFileSync(path.resolve(f.input), 'utf8')); } catch (error) { throw new Error(`INPUT_NOT_JSON:${error.message}`); }
  if (!payload || payload.schema !== 'RESEARCH_TRIAGE_BATCH_INPUT_V1' || !Array.isArray(payload.decisions) || payload.decisions.length === 0) {
    throw new Error('INPUT_CONTRACT_INVALID');
  }
  const rows = f['dry-run']
    ? triage.prepareTriageBatch(payload.decisions, { deskRoot: f['desk-root'] })
    : triage.recordTriageBatch(payload.decisions, { deskRoot: f['desk-root'] });
  process.stdout.write(`${JSON.stringify({ mode: f['dry-run'] ? 'DRY_RUN' : 'WRITE', would_write: Boolean(f['dry-run']), count: rows.length,
    records: rows.map(summary), production_effect: 'NONE' })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
