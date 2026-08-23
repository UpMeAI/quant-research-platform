'use strict';
/**
 * Result Lock 内核(§18 Result Lock / §9 预注册)—— 迁移自 Phase 2 experiment_registry 的冻结语义,
 * 收敛为可被任何服务复用的通用能力:
 *
 *   freeze(fields, spec)      —— 对冻结域计算 freeze_hash;
 *   verifyFrozen(fields, firstRow) —— 重算冻结域 hash,与首行一致才允许被引用;
 *   单结果锁由调用方台账实现(状态 RESULT_LOCKED 后拒绝再次登记)。
 *
 * 语义:运行后想改任何冻结域 = 实验作废,必须开新实验;结果每实验只登记一次(防挑最好一次)。
 */
const { hash } = require('../ledger');

function freeze(freezeFields, spec) {
  const frozen = {};
  for (const f of freezeFields) frozen[f] = spec[f] ?? null;
  return { frozen, freeze_hash: hash(frozen) };
}

function verifyFrozen(freezeFields, firstRow) {
  const frozen = {};
  for (const f of freezeFields) frozen[f] = firstRow[f] ?? null;
  return hash(frozen) === firstRow.freeze_hash;
}

module.exports = { freeze, verifyFrozen };
