'use strict';

/**
 * RF1118 (AI pre-registration amendment, revision 2) freeze-page binding. Same approach as ../research-framework-amendment-20261112:
 * the freeze page lives in the coordinator directory, not in git, and is bound by path + sha256. EFFECTIVE_FROM is the single constant the page states.
 * The caps are RF1118 star P4 (a), all six stars are (a).
 */
const SHA64 = /^[0-9a-f]{64}$/;

const FREEZE = Object.freeze({
  path: 'artifacts/coordinator/RF1118_AI_PREREG_AMENDMENT_FREEZE_1.md',
  sha256: 'ae8f24910c62dd0c2a14c52b6d1cb8fc2913297f52cc396fbee0985fb7092309',
  state: 'FREEZE_1',
  texts: Object.freeze([
    Object.freeze({ id: 'REV_2', path: 'artifacts/coordinator/RF1118_AI_PREREG_AMENDMENT.draft.61e7c280.md', sha256: '61e7c280ad8b3e7fec244f772ea8f7c470395c4fc84abcfebf61770a5efc0155' }),
  ]),
});
const EFFECTIVE_FROM = '2026-11-18T15:48:18+08:00';
/** Star P4 (a): per market, per CST week (Monday start) and per CST month; arms that count in N per freeze. */
const CAPS = Object.freeze({ per_week: 2, per_month: 6, arms_per_freeze: 20 });

/**
 * The "class" a downgrade (RF1118 section 3) applies to. One named rule, used nowhere else: a later RF1118 note changes it here only.
 * plan-coord ruling 11-22: <market>:<mechanism-layer-prefix>, e.g. CN_A:ACCT; '*' in ctx.downgradedClasses means every class.
 */
const DOWNGRADE_CLASS_RULE = '<market>:<mechanism-layer-prefix>';
const classOf = (market, mechanismId) => `${market}:${String(mechanismId).split('.')[0]}`;

const isBound = (freeze = FREEZE) => Boolean(freeze) && SHA64.test(freeze.sha256 || '') && freeze.state === 'FREEZE_1'
  && Array.isArray(freeze.texts) && freeze.texts.length > 0 && freeze.texts.every((t) => SHA64.test((t && t.sha256) || ''));

module.exports = { FREEZE, EFFECTIVE_FROM, CAPS, DOWNGRADE_CLASS_RULE, classOf, isBound };
