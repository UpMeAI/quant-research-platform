#!/usr/bin/env node
'use strict';
/**
 * 把 Carry V2 接入封存包导入 QRP 并锁定（封存研究结论锁 SEALED_RESEARCH_RESULT_LOCK_V1，
 * docs/contracts/CARRY_V2_RESULT_IMPORT_PROFILE_V1.md 487cf360…，FREEZE_1）。
 *
 *   QRP_PRODUCT_MILESTONE_AUTHORITY=<完成权威> [QRP_DATA_DIR=<台账副本>] node apps/research-cli/import_carry_v2_result.js \
 *     --bundle /abs/path/carry-qrp-v1 --smartflow-root /abs/path/smartflow@8d97cbde --registered-by <完成权威> \
 *     [--supersedes <result_id> --defect-ref <ref> --reason "<text>"]
 *
 * 只做核对，不重算；导入前提（A0 全部 BYTE_IDENTICAL、M1 全部通过）不成立即拒绝。先在台账副本上试导入（QRP_DATA_DIR），
 * 真实台账由协调会话写。没有下单、激活、生产参数写入，也不在 Web 暴露。
 */
const sealed = require('../../services/sealed-research-results');

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
  for (const k of ['bundle', 'smartflow-root', 'registered-by']) if (!f[k]) throw new Error(`MISSING_FLAG:${k}`);
  const lock = sealed.importSealedResult(f.bundle, {
    smartflowRoot: f['smartflow-root'], registeredBy: f['registered-by'], supersedes: f.supersedes || null, defectRef: f['defect-ref'] || null, reason: f.reason || null,
  });
  process.stdout.write(`${JSON.stringify({
    result_id: lock.result_id, case_ref: lock.case_ref, strategy_ref: lock.strategy_ref, verdict_result: lock.verdict_result, verdict_next: lock.verdict_next,
    first_look: lock.first_look, bundle_sha256: lock.bundle_sha256, sealed_files: lock.sealed_files.length, receipts: lock.receipts.length,
    reproduction: lock.reproduction, lock_hash: lock.lock_hash, locked_at: lock.locked_at, replay: Boolean(lock.replayHit), production_effect: 'NONE',
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
