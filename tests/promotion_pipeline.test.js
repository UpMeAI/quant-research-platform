'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const experiments = require('../services/experiment-orchestrator');
const shadow = require('../services/shadow-control');
const registry = require('../services/strategy-registry');
const controlPlane = require('../services/strategy-control-plane');
const binding = require('../services/strategy-control-plane/runtime_binding');
const stub = require('../adapters/ashare-local/paper_runtime_stub');
const { RUNTIME_ID } = require('../adapters/ashare-local/market_facts');
const migration = require('../services/strategy-control-plane/migration');
const { setupExperiment } = require('./_fixture');

const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

/** 夹具:实验锁定指定 verdict + 影子样本达标,返回可进发布的引用。 */
function promotable(verdict = 'CHALLENGER_WINS') {
  const fx = setupExperiment({ min_forward_evidence: 2 });
  experiments.recordResult(fx.exp.experiment_id, { verdict });
  const run = shadow.openShadowRun({
    champion_ref: fx.champRef, challenger_ref: fx.chalRef, race_ref: 'RACE-T', experiment_ref: fx.exp.experiment_id,
  });
  shadow.recordObservation(run.shadow_id, { key: 'd1', business_date: 'd1', champion_output: [], challenger_output: [] });
  shadow.recordObservation(run.shadow_id, { key: 'd2', business_date: 'd2', champion_output: [], challenger_output: ['600001.SH'] });
  return { ...fx, shadowId: run.shadow_id };
}

function candidateOf(fx) {
  return controlPlane.createPromotionCandidate({
    release_candidate_ref: fx.chalRef, market: 'CN_A', experiment_ref: fx.exp.experiment_id,
    research_evidence_refs: ['ev1'], shadow_forward_refs: [fx.shadowId], rollback_ref: fx.champRef,
  });
}

test('Promotion Gates:未锁结果 / 非胜者 / 影子样本不足 → 拒绝', () => {
  const fx0 = setupExperiment({ min_forward_evidence: 2 });
  assert.throws(() => controlPlane.createPromotionCandidate({
    release_candidate_ref: fx0.chalRef, market: 'CN_A', experiment_ref: fx0.exp.experiment_id,
    research_evidence_refs: ['e'], shadow_forward_refs: ['SHD-x'], rollback_ref: fx0.champRef,
  }), /PROMOTION_EXPERIMENT_NOT_LOCKED/);

  const fxHold = promotable('CHAMPION_HOLDS');
  assert.throws(() => candidateOf(fxHold), /PROMOTION_VERDICT_NOT_WINNER/);

  const fxWin = promotable();
  const insufficient = shadow.openShadowRun({
    champion_ref: fxWin.champRef, challenger_ref: fxWin.chalRef, race_ref: 'R', experiment_ref: fxWin.exp.experiment_id,
  });
  assert.throws(() => candidateOf({ ...fxWin, shadowId: insufficient.shadow_id }), /PROMOTION_SHADOW_INSUFFICIENT/);
});

test('发布流水线:兼容前禁 Release;Founder 唯一批准;激活参数 fail-closed;Pull+ACK 闭环', () => {
  const fx = promotable();
  const cand = candidateOf(fx);

  // 兼容性检查前不能出 Release
  assert.throws(() => controlPlane.createRelease(cand.candidate_id), /RELEASE_REQUIRES_COMPATIBILITY_PASS/);
  const { compatibility } = controlPlane.runCompatibilityCheck(cand.candidate_id);
  assert.equal(compatibility.compatible, true);
  const release = controlPlane.createRelease(cand.candidate_id);
  assert.ok(release.release_hash);

  // Founder 唯一批准人;决定枚举
  assert.throws(() => controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'OPERATOR' }), /REVIEW_REQUIRES_FOUNDER/);
  assert.throws(() => controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_LIVE', { reviewer: 'FOUNDER' }), /BAD_REVIEW_DECISION/);
  // 批准前不能激活
  assert.throws(() => controlPlane.requestActivation(release.release_id, {
    target_runtime_id: RUNTIME_ID, effective_from: TOMORROW,
  }), /ACTIVATION_REQUIRES_APPROVAL/);
  controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });

  // 激活参数 fail-closed
  assert.throws(() => controlPlane.requestActivation(release.release_id, {
    target_runtime_id: RUNTIME_ID, environment: 'LIVE', effective_from: TOMORROW,
  }), /ENVIRONMENT_NOT_ALLOWED_IN_MVP/);
  assert.throws(() => controlPlane.requestActivation(release.release_id, {
    target_runtime_id: RUNTIME_ID, effective_from: YESTERDAY,
  }), /EFFECTIVE_FROM_MUST_BE_FUTURE/);
  assert.throws(() => controlPlane.requestActivation(release.release_id, {
    target_runtime_id: 'RT-UNKNOWN', effective_from: TOMORROW,
  }), /RUNTIME_UNKNOWN/);

  // hash 不匹配的 ACK → ACK_REJECTED,绝不 ACTIVE
  const actBad = controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  const badAck = binding.runtimeAck(actBad.activation_id, { runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: 'deadbeefdeadbeef' });
  assert.equal(badAck.ok, false);
  assert.equal(controlPlane.activationHead(actBad.activation_id).activation_status, 'ACK_REJECTED');

  // Bundle 未到 SHADOW 态时 ACK 显式失败(状态机守门,不静默)
  const actEarly = controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  assert.throws(() => binding.runtimeAck(actEarly.activation_id, {
    runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash,
  }), /BUNDLE_ACTIVATE_FAILED/);

  // 正常路径:Bundle 走到 SHADOW 后,到生效日拉取 + 验哈希 + ACK → ACTIVE
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'CHALLENGER', {});
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'SHADOW', {});
  const actOk = controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  const pulled = stub.pullAndAck({ today: TOMORROW });
  const mine = pulled.results.find((r) => r.activation_id === actOk.activation_id);
  assert.equal(mine.action, 'ACK_ACTIVE');
  assert.equal(controlPlane.activationHead(actOk.activation_id).activation_status, 'ACTIVE');
  const bundle = registry.bundleHead(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version);
  assert.equal(bundle.status, 'ACTIVE');
  assert.equal(bundle.activationRef, actOk.activation_id);

  // Rollback:ECONOMIC 无 Founder 只触发研究复核;OPERATIONAL 直接切回并 retire 当前 bundle
  const trig = controlPlane.rollback({ type: 'ECONOMIC', activation_ref: actOk.activation_id });
  assert.equal(trig.status, 'RESEARCH_REVIEW_TRIGGERED');
  assert.equal(controlPlane.activationHead(actOk.activation_id).activation_status, 'ACTIVE'); // 未被自动回滚
  const rbk = controlPlane.rollback({ type: 'OPERATIONAL', activation_ref: actOk.activation_id, reasonCn: '运行故障' });
  assert.equal(rbk.restored_release_ref, fx.champRef);
  assert.equal(controlPlane.activationHead(actOk.activation_id).activation_status, 'ROLLED_BACK');
  assert.equal(registry.bundleHead(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version).status, 'RETIRED');
});

test('Runtime Binding:runtime 身份不匹配拒绝;NACK 显式拒绝', () => {
  const fx = promotable();
  const cand = candidateOf(fx);
  controlPlane.runCompatibilityCheck(cand.candidate_id);
  const release = controlPlane.createRelease(cand.candidate_id);
  controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
  const act = controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });

  assert.equal(binding.runtimePendingActivations('RT-OTHER', { today: TOMORROW }).length, 0);
  assert.ok(binding.runtimePendingActivations(RUNTIME_ID, { today: TOMORROW }).some((a) => a.activation_id === act.activation_id));
  assert.throws(() => binding.runtimeAck(act.activation_id, { runtime_id: 'RT-OTHER', today: TOMORROW, verified_release_hash: release.release_hash }), /ACK_RUNTIME_MISMATCH/);

  const nack = binding.runtimeNack(act.activation_id, { runtime_id: RUNTIME_ID, reasonCn: '健康检查失败' });
  assert.equal(nack.ok, true);
  assert.equal(controlPlane.activationHead(act.activation_id).activation_status, 'RUNTIME_REJECTED');
  // NACK 后不可再 ACK
  assert.throws(() => binding.runtimeAck(act.activation_id, { runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash }), /ACTIVATION_NOT_PENDING/);
});

test('生效日门控:未到 effective_from 不可拉取、不可 ACK;到期后正常加载(§16.3-10/§22)', () => {
  const fx = promotable();
  const cand = candidateOf(fx);
  controlPlane.runCompatibilityCheck(cand.candidate_id);
  const release = controlPlane.createRelease(cand.candidate_id);
  controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'CHALLENGER', {});
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'SHADOW', {});
  const act = controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });

  // 生效日前:不在 pending 拉取集,只在 scheduled 可见
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(binding.runtimePendingActivations(RUNTIME_ID, { today }).some((a) => a.activation_id === act.activation_id), false);
  assert.ok(binding.runtimeScheduledActivations(RUNTIME_ID, { today }).some((a) => a.activation_id === act.activation_id));
  // 即使绕过 pull 直接 ACK 也 fail-closed
  assert.throws(() => binding.runtimeAck(act.activation_id, {
    runtime_id: RUNTIME_ID, today, verified_release_hash: release.release_hash,
  }), /ACTIVATION_NOT_YET_EFFECTIVE/);
  assert.equal(controlPlane.activationHead(act.activation_id).activation_status, 'PENDING_RUNTIME_PULL');
  // stub 在生效日前拉取:零 pending
  assert.equal(stub.pullAndAck({ today }).pulled, 0);

  // 到生效日:可拉取并 ACTIVE
  const r = binding.runtimeAck(act.activation_id, { runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash });
  assert.equal(r.ok, true);
  assert.equal(controlPlane.activationHead(act.activation_id).activation_status, 'ACTIVE');
});

test('No Silent Migration:生效即产迁移裁定;拿不到持仓真相必须 UNAVAILABLE 而非默认无需 replan', () => {
  const fx = promotable();
  const cand = candidateOf(fx);
  controlPlane.runCompatibilityCheck(cand.candidate_id);
  const release = controlPlane.createRelease(cand.candidate_id);
  controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'CHALLENGER', {});
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'SHADOW', {});
  const act = controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  const r = binding.runtimeAck(act.activation_id, { runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash });

  // stub 无持仓真相 → 诚实 UNAVAILABLE,replan 计数为 null(不是 0)
  assert.equal(r.migration.schema, 'MIGRATION_ASSESSMENT_V1');
  assert.equal(r.migration.status, 'UNAVAILABLE');
  assert.equal(r.migration.replan_required_count, null);
  assert.equal(r.migration.migration_policy, 'NEW_TRADEPLANS_ONLY_REPLAN_REQUIRED_FOR_EXISTING');
  assert.ok(migration.listMigrationRecords(act.activation_id).length >= 1);
});

test('No Silent Migration:有持仓真相时逐仓产 REPLAN_REQUIRED,零自动迁移', () => {
  const adapter = require('../adapters/ashare-local');
  const original = adapter.runtime_positions_readonly;
  adapter.runtime_positions_readonly = () => ({
    status: 'OK',
    positions: [
      { position_id: 'POS-1', instrument_id: '600001.SH', originating_release_ref: 'REL-OLD', quantity: 100 },
      { position_id: 'POS-2', instrument_id: '600002.SH', originating_release_ref: 'REL-OLD', quantity: 200 },
    ],
  });
  try {
    const fx = promotable();
    const cand = candidateOf(fx);
    controlPlane.runCompatibilityCheck(cand.candidate_id);
    const release = controlPlane.createRelease(cand.candidate_id);
    controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
    registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'CHALLENGER', {});
    registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'SHADOW', {});
    const act = controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
    const r = binding.runtimeAck(act.activation_id, { runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash });

    assert.equal(r.migration.status, 'ASSESSED');
    assert.equal(r.migration.replan_required_count, 2);
    const replans = migration.listReplanRequired(act.activation_id);
    assert.equal(replans.length, 2);
    for (const rp of replans) {
      assert.equal(rp.auto_migrated, false);                       // 绝不自动迁移
      assert.equal(rp.required_action, 'RESEARCH_OR_FOUNDER_DECISION');
      assert.equal(rp.originating_release_ref, 'REL-OLD');         // 仍绑定原始 release
    }
  } finally { adapter.runtime_positions_readonly = original; }
});
