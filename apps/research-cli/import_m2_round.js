#!/usr/bin/env node
'use strict';
/**
 * 把加密 M2 一轮的封存结果导入 QRP 并锁定（CRYPTO_Q0_RESULT_V1 导入规格增补 2，类别 M2_ROUND_LOCK_V1）。
 *
 *   QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_m2_round.js \
 *     --strategy C17_V2_4000USDT --round 1 --dir var/evidence/c17-v2-m2-r1-2026-10-27 --registered-by V8_1_COORDINATOR \
 *     [--supersedes <result_id> --defect-ref <ref> --reason "<text>"]
 *
 * 策略必须已登记、档案的 m2_rounds 里有这一轮；`--dir` 不给时用档案的 evidence_dir（相对仓库根）。
 * 每个角色文件的 sha256 必须等于档案登记（旁边有 .sha256 时也要一致）；基线必须是这条策略当前的 Q0 锁。
 * 只追加一条 M2_ROUND_LOCK_V1；同一组文件重复导入是幂等重放。没有下单、激活、生产参数写入，也不在 Web 暴露。
 */
const path = require('path');
const m2Rounds = require('../../services/m2-rounds');

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
  if (!f.strategy) throw new Error('MISSING_FLAG:strategy');
  if (!f.round) throw new Error('MISSING_FLAG:round');
  const lock = m2Rounds.importRound({
    strategyRef: f.strategy, round: Number(f.round), dir: f.dir ? path.resolve(f.dir) : null, registeredBy: f['registered-by'],
    supersedes: f.supersedes || null, defectRef: f['defect-ref'] || null, reason: f.reason || null,
  });
  process.stdout.write(`${JSON.stringify({
    result_id: lock.result_id, strategy_ref: lock.strategy_ref, round: lock.round, baseline_result_id: lock.baseline_result_id,
    files: lock.files.length, k2_sha256: lock.k2_sha256, locked_at: lock.locked_at, replay: Boolean(lock.replayHit), production_effect: 'NONE',
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
