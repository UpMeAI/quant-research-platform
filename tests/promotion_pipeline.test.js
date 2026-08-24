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
async function promotable(verdict = 'CHALLENGER_WINS') {
  const fx = await setupExperiment({ min_forward_evidence: 2 });
  experiments.recordResult(fx.exp.experiment_id, { verdict });
  const run = shadow.openShadowRun({
    champion_ref: fx.champRef, challenger_ref: fx.chalRef, race_ref: 'RACE-T', experiment_ref: fx.exp.experiment_id,
  });
  shadow.recordObservation(run.shadow_id, { key: 'd1', business_date: 'd1', champion_output: [], challenger_output: [] });
  shadow.recordObservation(run.shadow_id, { key: 'd2', business_date: 'd2', champion_output: [], challenger_output: ['600001.SH'] });
  return { ...fx, shadowId: run.shadow_id };
}

async function candidateOf(fx) {
  return controlPlane.createPromotionCandidate({
    release_candidate_ref: fx.chalRef, market: 'CN_A', experiment_ref: fx.exp.experiment_id,
    research_evidence_refs: ['ev1'], shadow_forward_refs: [fx.shadowId], rollback_ref: fx.champRef,
  });
}

test('Promotion Gates:未锁结果 / 非胜者 / 影子样本不足 → 拒绝', async () => {
  const fx0 = await setupExperiment({ min_forward_evidence: 2 });
  await assert.rejects(async () => controlPlane.createPromotionCandidate({
    release_candidate_ref: fx0.chalRef, market: 'CN_A', experiment_ref: fx0.exp.experiment_id,
    research_evidence_refs: ['e'], shadow_forward_refs: ['SHD-x'], rollback_ref: fx0.champRef,
  }), /PROMOTION_EXPERIMENT_NOT_LOCKED/);

  const fxHold = await promotable('CHAMPION_HOLDS');
  await assert.rejects(async () => candidateOf(fxHold), /PROMOTION_VERDICT_NOT_WINNER/);

  const fxWin = await promotable();
  const insufficient = shadow.openShadowRun({
    champion_ref: fxWin.champRef, challenger_ref: fxWin.chalRef, race_ref: 'R', experiment_ref: fxWin.exp.experiment_id,
  });
  await assert.rejects(async () => candidateOf({ ...fxWin, shadowId: insufficient.shadow_id }), /PROMOTION_SHADOW_INSUFFICIENT/);
});

test('发布流水线:兼容前禁 Release;Founder 唯一批准;激活参数 fail-closed;Pull+ACK 闭环', async () => {
  const fx = await promotable();
  const cand = await candidateOf(fx);

  // 兼容性检查前不能出 Release
  assert.throws(() => controlPlane.createRelease(cand.candidate_id), /RELEASE_REQUIRES_COMPATIBILITY_PASS/);
  const { compatibility } = await controlPlane.runCompatibilityCheck(cand.candidate_id);
  assert.equal(compatibility.compatible, true);
  const release = controlPlane.createRelease(cand.candidate_id);
  assert.ok(release.release_hash);

  // Founder 唯一批准人;决定枚举
  assert.throws(() => controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'OPERATOR' }), /REVIEW_REQUIRES_FOUNDER/);
  assert.throws(() => controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_LIVE', { reviewer: 'FOUNDER' }), /BAD_REVIEW_DECISION/);
  // 批准前不能激活
  await assert.rejects(async () => controlPlane.requestActivation(release.release_id, {
    target_runtime_id: RUNTIME_ID, effective_from: TOMORROW,
  }), /ACTIVATION_REQUIRES_APPROVAL/);
  controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });

  // 激活参数 fail-closed
  await assert.rejects(async () => controlPlane.requestActivation(release.release_id, {
    target_runtime_id: RUNTIME_ID, environment: 'LIVE', effective_from: TOMORROW,
  }), /ENVIRONMENT_NOT_ALLOWED_IN_MVP/);
  await assert.rejects(async () => controlPlane.requestActivation(release.release_id, {
    target_runtime_id: RUNTIME_ID, effective_from: YESTERDAY,
  }), /EFFECTIVE_FROM_MUST_BE_FUTURE/);
  await assert.rejects(async () => controlPlane.requestActivation(release.release_id, {
    target_runtime_id: 'RT-UNKNOWN', effective_from: TOMORROW,
  }), /RUNTIME_UNKNOWN/);

  // hash 不匹配的 ACK → ACK_REJECTED,绝不 ACTIVE
  const actBad = await controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  const badAck = await binding.runtimeAck(actBad.activation_id, { runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: 'deadbeefdeadbeef' , health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false }});
  assert.equal(badAck.ok, false);
  assert.equal(controlPlane.activationHead(actBad.activation_id).activation_status, 'ACK_REJECTED');

  // Bundle 未到 SHADOW 态时 ACK 显式失败(状态机守门,不静默)
  const actEarly = await controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  await assert.rejects(async () => binding.runtimeAck(actEarly.activation_id, {
    runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash, health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false },
  }), /BUNDLE_ACTIVATE_FAILED/);

  // 正常路径:Bundle 走到 SHADOW 后,到生效日拉取 + 验哈希 + ACK → ACTIVE
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'CHALLENGER', {});
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'SHADOW', {});
  const actOk = await controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  const pulled = await stub.pullAndAck({ today: TOMORROW });
  const mine = pulled.results.find((r) => r.activation_id === actOk.activation_id);
  assert.equal(mine.action, 'ACK_ACTIVE');
  assert.equal(controlPlane.activationHead(actOk.activation_id).activation_status, 'ACTIVE');
  const bundle = registry.bundleHead(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version);
  assert.equal(bundle.status, 'ACTIVE');
  assert.equal(bundle.activationRef, actOk.activation_id);

  // Rollback:ECONOMIC 无 Founder 只触发研究复核(不自动回滚)
  const trig = controlPlane.rollback({ type: 'ECONOMIC', activation_ref: actOk.activation_id });
  assert.equal(trig.status, 'RESEARCH_REVIEW_TRIGGERED');
  assert.equal(controlPlane.activationHead(actOk.activation_id).activation_status, 'ACTIVE'); // 未被自动回滚
  // OPERATIONAL:当前版本 ROLLED_BACK + 当前 bundle RETIRED
  const rbk = controlPlane.rollback({ type: 'OPERATIONAL', activation_ref: actOk.activation_id, reasonCn: '运行故障' });
  assert.equal(controlPlane.activationHead(actOk.activation_id).activation_status, 'ROLLED_BACK');
  // 切回目标必须是**真实 Release**,不是 bundle ref(审计缺陷回归)
  if (rbk.restored_release_ref) {
    assert.ok(controlPlane.releaseHead(rbk.restored_release_ref), 'restored_release_ref 必须能在 Release 台账查到');
    assert.match(rbk.restored_release_ref, /^REL-/);
  } else {
    assert.equal(rbk.restore_status, 'NO_PREVIOUS_RELEASE_TO_RESTORE');
  }
});

test('Rollback 闭环:切回必须经 Runtime 拉取 + 验哈希 + 健康检查才真正恢复(§12.3/§13.1)', async () => {
  // v1 上线 → ACTIVE
  const fx1 = await promotable();
  const c1 = await candidateOf(fx1);
  await controlPlane.runCompatibilityCheck(c1.candidate_id);
  const rel1 = controlPlane.createRelease(c1.candidate_id);
  controlPlane.reviewCandidate(c1.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
  registry.transitionBundle(fx1.chalBundle.bundle_id, fx1.chalBundle.bundle_version, 'CHALLENGER', {});
  registry.transitionBundle(fx1.chalBundle.bundle_id, fx1.chalBundle.bundle_version, 'SHADOW', {});
  const act1 = await controlPlane.requestActivation(rel1.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  await binding.runtimeAck(act1.activation_id, {
    runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: rel1.release_hash,
    health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false },
  });
  assert.equal(controlPlane.activeReleaseIdFor(RUNTIME_ID), rel1.release_id);

  // v2 上线 → previous_release_ref 必须指向 v1 这个真实 Release
  const fx2 = await promotable();
  const c2 = await candidateOf(fx2);
  await controlPlane.runCompatibilityCheck(c2.candidate_id);
  const rel2 = controlPlane.createRelease(c2.candidate_id);
  controlPlane.reviewCandidate(c2.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
  registry.transitionBundle(fx2.chalBundle.bundle_id, fx2.chalBundle.bundle_version, 'CHALLENGER', {});
  registry.transitionBundle(fx2.chalBundle.bundle_id, fx2.chalBundle.bundle_version, 'SHADOW', {});
  const act2 = await controlPlane.requestActivation(rel2.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  assert.equal(act2.previous_release_ref, rel1.release_id);
  await binding.runtimeAck(act2.activation_id, {
    runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: rel2.release_hash,
    health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false },
  });
  assert.equal(controlPlane.activeReleaseIdFor(RUNTIME_ID), rel2.release_id);

  // 回滚 v2:生成 ROLLBACK_RESTORE Activation,Runtime 必须拉得到
  const rbk = controlPlane.rollback({ type: 'OPERATIONAL', activation_ref: act2.activation_id, today: TOMORROW });
  assert.equal(rbk.restored_release_ref, rel1.release_id);
  assert.ok(rbk.restore_activation_ref, '必须生成回滚恢复 Activation,而不是只写台账');
  assert.equal(rbk.restore_status, 'PENDING_RUNTIME_PULL');
  const pending = binding.runtimePendingActivations(RUNTIME_ID, { today: TOMORROW });
  const restore = pending.find((a) => a.activation_id === rbk.restore_activation_ref);
  assert.ok(restore, '恢复 Activation 必须进入 Runtime 待拉取集');
  assert.equal(restore.activation_kind, 'ROLLBACK_RESTORE');
  assert.equal(restore.release_id, rel1.release_id);
  assert.equal(registry.bundleHead(fx2.chalBundle.bundle_id, fx2.chalBundle.bundle_version).status, 'RETIRED');

  // 哈希不符 → 恢复也 fail-closed
  const bad = await binding.runtimeAck(restore.activation_id, {
    runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: 'deadbeefdeadbeef',
    health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false },
  });
  assert.equal(bad.ok, false);
  assert.equal(controlPlane.activationHead(restore.activation_id).activation_status, 'ACK_REJECTED');
  assert.equal(controlPlane.activeReleaseIdFor(RUNTIME_ID), null, '恢复未成功前不得有生效版本(不静默留旧)');

  // 重新发起回滚 → 正常 ACK → 真的切回 v1
  const rbk2 = controlPlane.rollback({ type: 'OPERATIONAL', activation_ref: act2.activation_id, today: TOMORROW });
  const ok = await binding.runtimeAck(rbk2.restore_activation_ref, {
    runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: rel1.release_hash,
    health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false },
  });
  assert.equal(ok.ok, true);
  assert.equal(controlPlane.activeReleaseIdFor(RUNTIME_ID), rel1.release_id, 'Runtime 必须真的回到 last-known-good');
});

test('Rollback fail-closed:无前任 Release 不得伪装成功;ECONOMIC 需先有研究复核', async () => {
  const fx = await promotable();
  const cand = await candidateOf(fx);
  await controlPlane.runCompatibilityCheck(cand.candidate_id);
  const release = controlPlane.createRelease(cand.candidate_id);
  controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
  const act = await controlPlane.requestActivation(release.release_id, { target_runtime_id: 'RT-CN_A-PAPER-ISOLATED', effective_from: TOMORROW })
    .catch((e) => e);
  assert.match(String(act.message || ''), /RUNTIME_UNKNOWN/); // 未知 runtime 直接拒绝

  // Founder 批准的 ECONOMIC 回滚:没有前置研究复核记录 → 拒绝
  const act2 = await controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  assert.throws(
    () => controlPlane.rollback({ type: 'ECONOMIC', activation_ref: act2.activation_id, approved_by: 'FOUNDER' }),
    /ECONOMIC_ROLLBACK_REQUIRES_PRIOR_RESEARCH_REVIEW/,
  );
  controlPlane.rollback({ type: 'ECONOMIC', activation_ref: act2.activation_id });          // 先触发研究复核
  const done = controlPlane.rollback({ type: 'ECONOMIC', activation_ref: act2.activation_id, approved_by: 'FOUNDER', today: TOMORROW });
  assert.equal(done.schema, 'ROLLBACK_RECORD_V1');
  assert.equal(done.approved_by, 'FOUNDER');
});

test('Runtime Binding:runtime 身份不匹配拒绝;NACK 显式拒绝', async () => {
  const fx = await promotable();
  const cand = await candidateOf(fx);
  await controlPlane.runCompatibilityCheck(cand.candidate_id);
  const release = controlPlane.createRelease(cand.candidate_id);
  controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
  const act = await controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });

  assert.equal(binding.runtimePendingActivations('RT-OTHER', { today: TOMORROW }).length, 0);
  assert.ok(binding.runtimePendingActivations(RUNTIME_ID, { today: TOMORROW }).some((a) => a.activation_id === act.activation_id));
  await assert.rejects(async () => binding.runtimeAck(act.activation_id, { runtime_id: 'RT-OTHER', today: TOMORROW, verified_release_hash: release.release_hash , health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false }}), /ACK_RUNTIME_MISMATCH/);

  const nack = binding.runtimeNack(act.activation_id, { runtime_id: RUNTIME_ID, reasonCn: '健康检查失败' });
  assert.equal(nack.ok, true);
  assert.equal(controlPlane.activationHead(act.activation_id).activation_status, 'RUNTIME_REJECTED');
  // NACK 后不可再 ACK
  await assert.rejects(async () => binding.runtimeAck(act.activation_id, { runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash , health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false }}), /ACTIVATION_NOT_PENDING/);
});

test('生效日门控:未到 effective_from 不可拉取、不可 ACK;到期后正常加载(§16.3-10/§22)', async () => {
  const fx = await promotable();
  const cand = await candidateOf(fx);
  await controlPlane.runCompatibilityCheck(cand.candidate_id);
  const release = controlPlane.createRelease(cand.candidate_id);
  controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'CHALLENGER', {});
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'SHADOW', {});
  const act = await controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });

  // 生效日前:不在 pending 拉取集,只在 scheduled 可见
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(binding.runtimePendingActivations(RUNTIME_ID, { today }).some((a) => a.activation_id === act.activation_id), false);
  assert.ok(binding.runtimeScheduledActivations(RUNTIME_ID, { today }).some((a) => a.activation_id === act.activation_id));
  // 即使绕过 pull 直接 ACK 也 fail-closed
  await assert.rejects(async () => binding.runtimeAck(act.activation_id, {
    runtime_id: RUNTIME_ID, today, verified_release_hash: release.release_hash, health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false },
  }), /ACTIVATION_NOT_YET_EFFECTIVE/);
  assert.equal(controlPlane.activationHead(act.activation_id).activation_status, 'PENDING_RUNTIME_PULL');
  // stub 在生效日前拉取:本 Activation 不在其中(其他用例的即刻生效恢复项不算)
  const pulledToday = await stub.pullAndAck({ today });
  assert.equal(pulledToday.results.some((r) => r.activation_id === act.activation_id), false);

  // 到生效日:可拉取并 ACTIVE
  const r = await binding.runtimeAck(act.activation_id, { runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash , health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false }});
  assert.equal(r.ok, true);
  assert.equal(controlPlane.activationHead(act.activation_id).activation_status, 'ACTIVE');
});

test('No Silent Migration:生效即产迁移裁定;拿不到持仓真相必须 UNAVAILABLE 而非默认无需 replan', async () => {
  const fx = await promotable();
  const cand = await candidateOf(fx);
  await controlPlane.runCompatibilityCheck(cand.candidate_id);
  const release = controlPlane.createRelease(cand.candidate_id);
  controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'CHALLENGER', {});
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'SHADOW', {});
  const act = await controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  const r = await binding.runtimeAck(act.activation_id, { runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash , health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false }});

  // stub 无持仓真相 → 诚实 UNAVAILABLE,replan 计数为 null(不是 0)
  assert.equal(r.migration.schema, 'MIGRATION_ASSESSMENT_V1');
  assert.equal(r.migration.status, 'UNAVAILABLE');
  assert.equal(r.migration.replan_required_count, null);
  assert.equal(r.migration.migration_policy, 'NEW_TRADEPLANS_ONLY_REPLAN_REQUIRED_FOR_EXISTING');
  assert.ok(migration.listMigrationRecords(act.activation_id).length >= 1);
});

test('No Silent Migration:有持仓真相时逐仓产 REPLAN_REQUIRED,零自动迁移', async () => {
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
    const fx = await promotable();
    const cand = await candidateOf(fx);
    await controlPlane.runCompatibilityCheck(cand.candidate_id);
    const release = controlPlane.createRelease(cand.candidate_id);
    controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
    registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'CHALLENGER', {});
    registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'SHADOW', {});
    const act = await controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
    const r = await binding.runtimeAck(act.activation_id, { runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash , health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false }});

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

test('ACK 健康检查 fail-closed:缺失/不健康/违反安全不变量一律不激活(§12/§18)', async () => {
  const mk = async () => {
    const fx = await promotable();
    const cand = await candidateOf(fx);
    await controlPlane.runCompatibilityCheck(cand.candidate_id);
    const release = controlPlane.createRelease(cand.candidate_id);
    controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
    registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'CHALLENGER', {});
    registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'SHADOW', {});
    const act = await controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
    return { release, act };
  };

  const cases = [
    [undefined, /HEALTH_CHECK_MISSING/],
    [{ status: 'UNHEALTHY', real_order: 0, broker_connection: false }, /HEALTH_STATUS_NOT_HEALTHY/],
    [{ status: 'HEALTHY', real_order: 7, broker_connection: false }, /SAFETY_INVARIANT_REAL_ORDER/],
    [{ status: 'HEALTHY', real_order: 0, broker_connection: true }, /SAFETY_INVARIANT_BROKER_CONNECTION_ENABLED/],
  ];
  for (const [hc, re] of cases) {
    const { release, act } = await mk();
    const r = await binding.runtimeAck(act.activation_id, {
      runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash, health_check: hc,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'HEALTH_CHECK_FAILED');
    assert.match(r.problems.join(','), re);
    assert.equal(controlPlane.activationHead(act.activation_id).activation_status, 'ACK_REJECTED');
  }
});
