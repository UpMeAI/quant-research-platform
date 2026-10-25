#!/usr/bin/env node
'use strict';
/**
 * 把研究会话封存的 US_V5_M2_Q<n>_RESULT_V1（Q1、Q2……）导入 QRP 并锁定（K3，候选对比类别 CANDIDATE_COMPARISON_V1）。
 *
 *   QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_candidate_comparison.js \
 *     --file /abs/path/US_V5_M2_Q2_RESULT_V1.json --registered-by V8_1_COORDINATOR \
 *     [--question Q2] [--supersedes <result_id> --defect-ref <ref> --reason "<text>"]
 *
 * 题目按文件里的 identity.schema 判断（services/candidate-comparison/registry.js 登记）；`--question` 可显式指定，
 * 与文件不符则拒绝。只读取封存文件和旁边的 .sha256，只追加一条 COMPARISON_EVALUATION_LOCK_V1；同一文件重复导入是幂等重放。
 * 引用的 Q0 基线必须是已存在且当前的基线锁。同一题已有另一份锁定时拒绝，改锁须引用缺陷并写原因。
 * 没有下单、激活、生产参数写入，也不在 Web 暴露。
 */
const comparison = require('../../services/candidate-comparison');

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
  if (!f.file) throw new Error('MISSING_FLAG:file');
  const lock = comparison.importCandidateComparison(f.file, {
    registeredBy: f['registered-by'], question: f.question || null, supersedes: f.supersedes || null, defectRef: f['defect-ref'] || null, reason: f.reason || null,
  });
  process.stdout.write(`${JSON.stringify({
    result_id: lock.result_id, question_ref: lock.question_ref, verdict_state: lock.verdict_state, baseline_result_id: lock.baseline_result_id, oos_reuse: lock.oos_reuse,
    file_sha256: lock.file_sha256, inputs_digest: lock.inputs_digest, engine_digest: lock.engine_digest, locked_at: lock.locked_at,
    replay: Boolean(lock.replayHit), production_effect: 'NONE',
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
