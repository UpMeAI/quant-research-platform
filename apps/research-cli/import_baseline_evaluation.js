#!/usr/bin/env node
'use strict';
/**
 * 把研究会话封存的 US_V5_M2_Q0_RESULT_V1 导入 QRP 并锁定（K3，基线类别 BASELINE_EVALUATION_V1）。
 *
 *   QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_baseline_evaluation.js \
 *     --file /abs/path/US_V5_M2_Q0_RESULT_V1.json --registered-by V8_1_COORDINATOR \
 *     [--strategy <strategy_ref>] [--supersedes <result_id> --defect-ref <ref> --reason "<text>"]
 *
 * 策略档案（config/strategy_profiles.v1.json）：给了 `--strategy` 就必须已登记，未登记直接拒绝（STRATEGY_PROFILE_NOT_REGISTERED），
 * 账本与证据目录都不写；不给时按结果文件的 schema 找所属策略。
 *
 * 只读取封存文件和旁边的 .sha256，只追加一条 BASELINE_EVALUATION_LOCK_V1；同一文件重复导入是幂等重放。
 * case 已有另一份锁定时拒绝，改锁须引用缺陷并写原因。没有下单、激活、生产参数写入，也不在 Web 暴露。
 */
const baseline = require('../../services/baseline-evaluation');

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
  const lock = baseline.importBaselineEvaluation(f.file, {
    registeredBy: f['registered-by'], strategyRef: f.strategy || null, supersedes: f.supersedes || null, defectRef: f['defect-ref'] || null, reason: f.reason || null,
  });
  process.stdout.write(`${JSON.stringify({
    result_id: lock.result_id, verdict_state: lock.verdict_state, file_sha256: lock.file_sha256,
    inputs_digest: lock.inputs_digest, engine_digest: lock.engine_digest, locked_at: lock.locked_at,
    replay: Boolean(lock.replayHit), production_effect: 'NONE',
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
