'use strict';
/**
 * L0 Governance & Identity —— 全局 ID 规则 + 生命周期状态机(产品设计 2026-08-22 §7/§8)。
 *
 * 身份铁律(§21.1 P0 准出):
 *   - 每个 Strategy / Bundle / Release / Activation 有全局唯一 ID 与 immutable hash;
 *   - ID 前缀固定,跨市场不复用命名空间;
 *   - 版本对象不可变:改动 = 新版本,append-only。
 */
const { hash } = require('../ledger');

// ── 全局 ID 前缀(§8 Domain Model) ─────────────────────────────────────────
const ID_PREFIX = Object.freeze({
  STRATEGY_FAMILY: 'FAM',
  MODULE: 'MOD',
  BUNDLE: 'BND',
  HYPOTHESIS: 'HYP',
  EXPERIMENT: 'EXP',
  DATASET_SNAPSHOT: 'DSS',
  RACE: 'RACE',
  SHADOW: 'SHD',
  NEGATIVE_RESULT: 'NEG',
  PROMOTION_CANDIDATE: 'PC',
  STRATEGY_RELEASE: 'REL',
  ACTIVATION: 'ACT',
  ROLLBACK: 'RBK',
  RUNTIME: 'RT',
});

function newId(prefix, seedObj) {
  if (!Object.values(ID_PREFIX).includes(prefix)) throw new Error(`BAD_ID_PREFIX:${prefix}`);
  return `${prefix}-${hash(seedObj)}`;
}

// ── Bundle / Release 状态(§8 StrategyBundleManifest,6 态) ─────────────────
const BUNDLE_STATUSES = Object.freeze(['RESEARCH', 'CHALLENGER', 'SHADOW', 'CANARY', 'ACTIVE', 'RETIRED']);
const BUNDLE_TRANSITIONS = Object.freeze({
  RESEARCH: ['CHALLENGER', 'RETIRED'],
  CHALLENGER: ['SHADOW', 'RETIRED'],
  SHADOW: ['CANARY', 'ACTIVE', 'RETIRED'],   // ACTIVE 仅经 Control Plane Activation(带 activationRef)
  CANARY: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['RETIRED'],
  RETIRED: [],
});

// ── Module 生命周期(保留 Phase 2 演进阶梯 —— 市场无关治理资产,§1) ─────────
const MODULE_LIFECYCLE = Object.freeze([
  'DRAFT', 'PREREGISTERED', 'BACKTESTED', 'OOS_VALIDATED', 'ROBUSTNESS_VALIDATED',
  'RACE_WINNER', 'BUNDLE_VALIDATED', 'CHALLENGER', 'SHADOW', 'CANARY',
  'PROMOTION_REVIEW', 'ACTIVE', 'DEGRADED', 'RETIRED',
  'REJECTED', 'ARCHIVED_NEGATIVE_RESULT',
]);
const MODULE_TRANSITIONS = Object.freeze({
  DRAFT: ['PREREGISTERED', 'REJECTED', 'ARCHIVED_NEGATIVE_RESULT'],
  PREREGISTERED: ['BACKTESTED', 'REJECTED', 'ARCHIVED_NEGATIVE_RESULT'],
  BACKTESTED: ['OOS_VALIDATED', 'REJECTED', 'ARCHIVED_NEGATIVE_RESULT'],
  OOS_VALIDATED: ['ROBUSTNESS_VALIDATED', 'REJECTED', 'ARCHIVED_NEGATIVE_RESULT'],
  ROBUSTNESS_VALIDATED: ['RACE_WINNER', 'REJECTED', 'ARCHIVED_NEGATIVE_RESULT'],
  RACE_WINNER: ['BUNDLE_VALIDATED', 'REJECTED', 'ARCHIVED_NEGATIVE_RESULT'],
  BUNDLE_VALIDATED: ['CHALLENGER', 'REJECTED', 'ARCHIVED_NEGATIVE_RESULT'],
  CHALLENGER: ['SHADOW', 'REJECTED', 'ARCHIVED_NEGATIVE_RESULT'],
  SHADOW: ['CANARY', 'PROMOTION_REVIEW', 'REJECTED', 'ARCHIVED_NEGATIVE_RESULT'],
  CANARY: ['PROMOTION_REVIEW', 'REJECTED', 'ARCHIVED_NEGATIVE_RESULT'],
  PROMOTION_REVIEW: ['ACTIVE', 'REJECTED', 'ARCHIVED_NEGATIVE_RESULT'],
  ACTIVE: ['DEGRADED', 'RETIRED'],
  DEGRADED: ['ACTIVE', 'RETIRED'],   // DEGRADED 只触发 Research Review,不按短期 PnL 自动回滚(§19.2)
  RETIRED: [], REJECTED: [], ARCHIVED_NEGATIVE_RESULT: [],
});

const MODULE_TYPES = Object.freeze(['UNIVERSE', 'REGIME', 'THEME', 'SELECTION', 'TIMING', 'RISK', 'EXIT']);

/** 校验一次状态迁移是否走合法边;进入 ACTIVE 必须携带 activationRef(No Automatic Promotion)。 */
function checkTransition(transitions, from, to, { activationRef } = {}) {
  const allowed = transitions[from] || [];
  if (!allowed.includes(to)) return { ok: false, reason: 'ILLEGAL_TRANSITION', from, to, allowed };
  if (to === 'ACTIVE' && !activationRef) return { ok: false, reason: 'ACTIVE_REQUIRES_ACTIVATION_RECORD' };
  return { ok: true };
}

module.exports = {
  ID_PREFIX, newId,
  BUNDLE_STATUSES, BUNDLE_TRANSITIONS,
  MODULE_LIFECYCLE, MODULE_TRANSITIONS, MODULE_TYPES,
  checkTransition,
};
