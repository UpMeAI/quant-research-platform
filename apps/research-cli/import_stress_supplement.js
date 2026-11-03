#!/usr/bin/env node
'use strict';
/**
 * 把研究会话封存的 US_V5_M2_Q0_STRESS_SUPPLEMENT_V1 导入 QRP 并锁定（Q0 压力补充 BASELINE_STRESS_SUPPLEMENT_V1，
 * US_V5_M2_Q0_RESULT_V1 导入规格增补 1 第 2 部分）。
 *
 *   QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_stress_supplement.js \
 *     --file /abs/path/US_V5_M2_Q0_STRESS_SUPPLEMENT_V1.json --registered-by V8_1_COORDINATOR \
 *     [--supersedes <result_id> --defect-ref <ref> --reason "<text>"]
 *
 * 只做核对，不重算；只读取封存文件和旁边的 .sha256，只追加一条 BASELINE_STRESS_SUPPLEMENT_LOCK_V1，不改 Q0 的锁。
 * 同一 (Q0 基线, 场景) 只能有一条；同一文件重复导入是幂等重放。没有下单、激活、生产参数写入，也不在 Web 暴露。
 */
const supplement = require('../../services/baseline-stress-supplement');

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
  const lock = supplement.importStressSupplement(f.file, {
    registeredBy: f['registered-by'], supersedes: f.supersedes || null, defectRef: f['defect-ref'] || null, reason: f.reason || null,
  });
  process.stdout.write(`${JSON.stringify({
    result_id: lock.result_id, record_type: lock.record_type, baseline_result_id: lock.baseline_result_id, scenario: lock.scenario,
    input_route: lock.input_route, reference_result_ids: lock.reference_result_ids, oos_reuse: lock.oos_reuse, file_sha256: lock.file_sha256,
    locked_at: lock.locked_at, replay: Boolean(lock.replayHit), production_effect: 'NONE',
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
