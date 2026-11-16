'use strict';

/**
 * 研究框架修订 2026-11-12 · 附录 1（成交函数纳入因果门 A1、G-COST A2）的冻结页绑定与生效时刻。做法同 ../research-framework-amendment-20261112。
 *
 * 冻结页在协调会话目录，不在 git 里，按 path + sha256 绑定。附录还没冻结：FREEZE 的 sha256 与 state 都是 PENDING_FREEZE，
 * 它冻结的文本（草稿修订 1）的 sha256 也是 PENDING_FREEZE。冻结之后补一次提交，从冻结页写入两处 sha256、state 与 EFFECTIVE_FROM。
 * 冻结前，G-COST 对在范围内的题一律拒绝（COST_MODEL_FREEZE_UNBOUND）；A1（因果门的成交函数）以后读同一个常量。
 *
 * EFFECTIVE_FROM：协调会话裁定，冻结若在 2026-11-17 00:00 CST 之前完成取此刻，否则取冻结时刻。
 */
const PENDING = 'PENDING_FREEZE';
const SHA64 = /^[0-9a-f]{64}$/;

const FREEZE = Object.freeze({
  path: 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_ADDENDUM_1_FREEZE_1.md',
  sha256: PENDING,
  state: PENDING,
  texts: Object.freeze([
    Object.freeze({ id: 'DRAFT_REV_1', path: 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_ADDENDUM_1_FILL_COST.draft.md', sha256: PENDING }),
  ]),
});
const EFFECTIVE_FROM = '2026-11-17T00:00:00+08:00';

/** 冻结页是否已绑定：冻结页与它冻结的每份文本都有 sha256，state 不是 PENDING_FREEZE。 */
const isBound = (freeze = FREEZE) => Boolean(freeze) && SHA64.test(freeze.sha256 || '') && freeze.state !== PENDING
  && Array.isArray(freeze.texts) && freeze.texts.length > 0 && freeze.texts.every((t) => SHA64.test((t && t.sha256) || ''));

module.exports = { FREEZE, EFFECTIVE_FROM, PENDING, isBound };
