#!/usr/bin/env node
'use strict';
/**
 * 把研究会话封存的 US_V5_M2_R2_GAP_DECOMPOSITION_V1 导入 QRP 并锁定（描述记录 GAP_DECOMPOSITION_V1，
 * US_V5_M2_Q0_RESULT_V1 导入规格增补 1 第 1 部分）。
 *
 *   QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_gap_decomposition.js \
 *     --file /abs/path/US_V5_M2_R2_GAP_DECOMPOSITION_V1.json --registered-by V8_1_COORDINATOR \
 *     [--supersedes <result_id> --defect-ref <ref> --reason "<text>"]
 *
 * 只读取封存文件和旁边的 .sha256，只追加一条 GAP_DECOMPOSITION_LOCK_V1；同一文件重复导入是幂等重放。
 * 引用的 Q0 基线、Q5 的当前 D 臂、Q1–Q5 都必须是已存在且当前的锁。这是描述，不是结论：没有三态，不进采用一览。
 * 没有下单、激活、生产参数写入，也不在 Web 暴露。
 */
const gap = require('../../services/gap-decomposition');

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
  const lock = gap.importGapDecomposition(f.file, {
    registeredBy: f['registered-by'], supersedes: f.supersedes || null, defectRef: f['defect-ref'] || null, reason: f.reason || null,
  });
  process.stdout.write(`${JSON.stringify({
    result_id: lock.result_id, record_type: lock.record_type, baseline_result_id: lock.baseline_result_id, base_arm_ref: lock.base_arm_ref,
    cited_result_ids: lock.cited_result_ids, decision: lock.decision, oos_reuse: lock.oos_reuse, file_sha256: lock.file_sha256, locked_at: lock.locked_at,
    replay: Boolean(lock.replayHit), production_effect: 'NONE',
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
