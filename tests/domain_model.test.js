'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { BUNDLE_TRANSITIONS, MODULE_TRANSITIONS, checkTransition } = require('../packages/domain-model');
const registry = require('../services/strategy-registry');
const { setupBundles } = require('./_fixture');

test('Bundle 状态机:非法跳转拒绝;ACTIVE 必须携带 activationRef', () => {
  assert.equal(checkTransition(BUNDLE_TRANSITIONS, 'RESEARCH', 'ACTIVE').ok, false);
  assert.equal(checkTransition(BUNDLE_TRANSITIONS, 'RESEARCH', 'CHALLENGER').ok, true);
  const noRef = checkTransition(BUNDLE_TRANSITIONS, 'SHADOW', 'ACTIVE', {});
  assert.equal(noRef.ok, false);
  assert.equal(noRef.reason, 'ACTIVE_REQUIRES_ACTIVATION_RECORD');
  assert.equal(checkTransition(BUNDLE_TRANSITIONS, 'SHADOW', 'ACTIVE', { activationRef: 'ACT-x' }).ok, true);
  assert.equal(checkTransition(BUNDLE_TRANSITIONS, 'RETIRED', 'ACTIVE', { activationRef: 'ACT-x' }).ok, false);
});

test('Module 状态机:演进阶梯逐级;PROMOTION_REVIEW→ACTIVE 需 activationRef', () => {
  assert.equal(checkTransition(MODULE_TRANSITIONS, 'DRAFT', 'ACTIVE', { activationRef: 'a' }).ok, false);
  assert.equal(checkTransition(MODULE_TRANSITIONS, 'PROMOTION_REVIEW', 'ACTIVE', {}).ok, false);
  assert.equal(checkTransition(MODULE_TRANSITIONS, 'PROMOTION_REVIEW', 'ACTIVE', { activationRef: 'a' }).ok, true);
});

test('Registry:未注册市场拒绝;bundle 重复注册产生新版本(append-only)', () => {
  const bad = registry.registerBundle({ bundle_id: 'B', market: 'US', module_refs: ['m#v1'] });
  assert.equal(bad.ok, false);
  const b = setupBundles();
  const again = registry.registerBundle({
    bundle_id: b.chalBundle.bundle_id, market: 'CN_A', module_refs: b.chalBundle.module_refs,
  });
  assert.equal(again.ok, true);
  assert.equal(again.record.bundle_version, b.chalBundle.bundle_version + 1);
  // Champion 注册幂等
  const champAgain = registry.registerChampionBundle({
    market: 'CN_A', bundle_id: 'BND-T-CHAMPION', module_refs: b.chalBundle.module_refs,
  });
  assert.equal(champAgain.unchanged, true);
});

test('Registry:transitionBundle 拒绝无 activationRef 的 SHADOW→ACTIVE', () => {
  const b = setupBundles();
  registry.transitionBundle(b.chalBundle.bundle_id, b.chalBundle.bundle_version, 'CHALLENGER', {});
  registry.transitionBundle(b.chalBundle.bundle_id, b.chalBundle.bundle_version, 'SHADOW', {});
  const r = registry.transitionBundle(b.chalBundle.bundle_id, b.chalBundle.bundle_version, 'ACTIVE', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ACTIVE_REQUIRES_ACTIVATION_RECORD');
});

test('注册即绕过守卫的洞已封:新 Bundle/Module 不得以 ACTIVE 入册(§12/§18)', () => {
  const bad = registry.registerBundle({
    bundle_id: 'BND-BYPASS-ACTIVE', market: 'CN_A', module_refs: ['MOD-X#v1'], status: 'ACTIVE',
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /ILLEGAL_INITIAL_BUNDLE_STATUS/);

  for (const s of ['CHALLENGER', 'SHADOW', 'CANARY']) {
    assert.equal(registry.registerBundle({
      bundle_id: `BND-BYPASS-${s}`, market: 'CN_A', module_refs: ['MOD-X#v1'], status: s,
    }).ok, false, `${s} 不应可作为初始状态`);
  }
  // RESEARCH 正常
  assert.equal(registry.registerBundle({
    bundle_id: 'BND-OK', market: 'CN_A', module_refs: ['MOD-X#v1'], status: 'RESEARCH',
  }).ok, true);

  // 模块同理
  const badMod = registry.registerModule({
    module_id: 'MOD-BYPASS', market: 'CN_A', module_type: 'TIMING', code_ref: 'x', status: 'ACTIVE',
  });
  assert.equal(badMod.ok, false);
  assert.match(badMod.reason, /ILLEGAL_INITIAL_MODULE_STATUS/);

  // §16.1 Champion 导入是唯一豁免,且必须留下导入标记(与新发布可区分)
  const champ = registry.registerChampionBundle({
    market: 'CN_A', bundle_id: 'BND-CHAMP-IMPORT', module_refs: ['MOD-X#v1'],
  });
  assert.equal(champ.ok, true);
  assert.equal(champ.record.status, 'ACTIVE');
  assert.equal(champ.record.activationRef, 'CHAMPION_IMPORT_EXISTING_RUNTIME_STATE');
});
