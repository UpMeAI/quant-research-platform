'use strict';

/**
 * 研究框架修订 2026-11-12 · 附录 1（成交函数纳入因果门 A1、G-COST A2）的冻结页绑定与生效时刻。做法同 ../research-framework-amendment-20261112。
 *
 * 冻结页在协调会话目录，不在 git 里，按 path + sha256 绑定。附录 1 已于 2026-11-16T22:07:39+08:00 由协调会话冻结（FREEZE_1）：
 * 冻结页 sha256 a3329481…，它冻结的文本是草稿修订 1（sha256 d64e88af…，同字节副本 …draft.d64e88af.md）。
 * G-COST（A2）与因果门的成交函数（A1）读同一个常量。冻结页没绑定时（PENDING_FREEZE），在范围内的题一律拒绝（COST_MODEL_FREEZE_UNBOUND）。
 *
 * EFFECTIVE_FROM：冻结页写定。冻结在 2026-11-17 00:00 CST 之前完成，所以取此刻（协调会话裁定：晚于此刻冻结则取冻结时刻）。
 */
const PENDING = 'PENDING_FREEZE';
const SHA64 = /^[0-9a-f]{64}$/;

const FREEZE = Object.freeze({
  path: 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_ADDENDUM_1_FREEZE_1.md',
  sha256: 'a33294818b799f67c5d0c23008d0434735e9e0ce7516d8028816e7c307de43c1',
  state: 'FREEZE_1',
  texts: Object.freeze([
    Object.freeze({ id: 'DRAFT_REV_1', path: 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_ADDENDUM_1_FILL_COST.draft.md',
      sha256: 'd64e88afa4fb5a5206d6beceaa073362d5e4dcc0d4835393bfffee2607d5aee0' }),
  ]),
});
const EFFECTIVE_FROM = '2026-11-17T00:00:00+08:00';

/** 冻结页是否已绑定：冻结页与它冻结的每份文本都有 sha256，state 不是 PENDING_FREEZE。 */
const isBound = (freeze = FREEZE) => Boolean(freeze) && SHA64.test(freeze.sha256 || '') && freeze.state !== PENDING
  && Array.isArray(freeze.texts) && freeze.texts.length > 0 && freeze.texts.every((t) => SHA64.test((t && t.sha256) || ''));

module.exports = { FREEZE, EFFECTIVE_FROM, PENDING, isBound };
