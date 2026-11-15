'use strict';

/**
 * 研究框架修订 2026-11-12（AI 角色边界、因果门 G-CAUSAL、机制去重）的冻结页绑定与生效时刻。
 *
 * 冻结页 FREEZE_1 在协调会话目录，不在 git 里，按 path + sha256 绑定（冻结审阅 E1）。它冻结两份文本：草稿修订 1 与冻结审阅修订 3，
 * 两份的 sha256 也写在这里。生效时刻 EFFECTIVE_FROM 是冻结页写出的唯一常量：G-MECH、ai_inputs、K2 §0 四行（E13）与 G-CAUSAL（G14）
 * 都从这里读，不各自另写（冻结页「E13 / G14 用同一个常量」）。从此刻起冻结的 K2（entry.k2_frozen_at ≥ EFFECTIVE_FROM）适用，之前的不追溯。
 */
const FREEZE = Object.freeze({
  path: 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_FREEZE_1.md',
  sha256: 'c9742ea070770c7f968e4ef46d3d10efae21a2e88e409290d74a7dc1110c5abc',
  state: 'FREEZE_1',
  texts: Object.freeze([
    Object.freeze({ id: 'DRAFT_REV_1', path: 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_CAUSALITY_MECHANISM_AI_ROLE.draft.md',
      sha256: 'd7f85a876303dec1744cd4cba2d49d997a29b4c5bec6bada003a63d18277bd25' }),
    Object.freeze({ id: 'FREEZE_REVIEW_REV_3', path: 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_FREEZE_REVIEW.md',
      sha256: 'd943d3422fea29e25572a0dc98f68266dca36a864a16cd3f89915cc2ba3338ff' }),
  ]),
});
const EFFECTIVE_FROM = '2026-11-15T22:47:42+08:00';

module.exports = { FREEZE, EFFECTIVE_FROM };
