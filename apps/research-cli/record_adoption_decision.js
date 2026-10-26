#!/usr/bin/env node
'use strict';
/**
 * 写一条研究结论的采用记录 RESEARCH_ADOPTION_DECISION_V1（UX 修订 6 H1），只有协调会话的完成权威能写。
 *
 *   QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/record_adoption_decision.js \
 *     --input /abs/path/decision.json --written-by V8_1_COORDINATOR
 *
 * decision.json（DECISION）：
 *   { "result_id": "Q1-…", "decision": "ADOPT|NOT_ADOPTED", "follow_up_zh": "…", "decided_by": "OWNER",
 *     "owner_words": "Owner 原话，逐字", "decided_at": "2026-10-26T21:00:00+08:00",
 *     "coordinator_recommendation": { "recommendation": "ADOPT|NOT_ADOPTED", "reason_zh": "…" },
 *     "evidence_ref": { "path": "/abs/path/决定记录文件", "sha256": "…" }, "supersedes": null }
 * 基线（Q0-…）与随机对照（Q3-… 加 "part": "Q3A"）只能写 "decision": "NOT_APPLICABLE"（可不写建议）。
 * RECOMMENDATION：{ "kind": "RECOMMENDATION", "result_id": "Q2-…", "coordinator_recommendation": { … } }。
 * 改决定：追加新记录并写 "supersedes": "<旧 record_id>"，旧记录保留。只追加一行账本，不改研究结果、锁或证据，没有生产动作。
 */
const fs = require('fs');
const adoption = require('../../services/research-adoption');

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
  if (!f.input) throw new Error('MISSING_FLAG:input');
  const input = JSON.parse(fs.readFileSync(f.input, 'utf8'));
  const record = adoption.recordAdoption(input, { writtenBy: f['written-by'] });
  process.stdout.write(`${JSON.stringify({
    record_id: record.record_id, kind: record.kind, result_id: record.result_id, part: record.part, decision: record.decision,
    supersedes: record.supersedes, written_at: record.written_at, record_hash: record.record_hash, production_effect: 'NONE',
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
