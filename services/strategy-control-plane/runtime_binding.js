'use strict';
/**
 * Runtime Binding(§12.2 Pull-based)—— 平台与市场 Runtime 之间的激活拉取/回执协议。
 *
 * 设计不变量:
 *   - 平台**不 push** Runtime;Runtime 主动拉取自己 runtime_id 名下 PENDING_RUNTIME_PULL
 *     的 Activation(runtimePendingActivations);
 *   - Runtime 本地校验 release_hash 后回 ACK(runtimeAck);hash 不一致 = fail-closed,
 *     Activation 标 ACK_REJECTED,绝不进 ACTIVE;
 *   - ACK 成功 → Activation ACTIVE + Registry Bundle 携 activationRef 进 ACTIVE
 *     (Bundle→ACTIVE 的唯一合法入口,见 packages/domain-model checkTransition);
 *   - Runtime 侧健康检查失败可回 NACK(runtimeNack),Activation 标 RUNTIME_REJECTED,
 *     等待 Operator/Founder 处置(不自动重试,不静默);
 *   - **生效日门控**(§16.3 步骤 10 / §22 Paper Publish):Runtime 只能在 effective_from
 *     当日或之后拉取并加载 Release;未到生效日的 Activation 只在 scheduled 列表可见,
 *     不进入 pending 拉取集,且 runtimeAck 直接 fail-closed —— 「已批准」≠「已生效」。
 */
const path = require('path');
const { dataDir, hash, now, uid, append, read } = require('../../packages/ledger');
const registry = require('../strategy-registry');
const controlPlane = require('./index');

const ACK_LEDGER = () => path.join(dataDir('control-plane'), 'runtime_acks.jsonl');

function _today(o = {}) { return o.today || new Date().toISOString().slice(0, 10); }

function _awaitingPull(runtimeId) {
  if (!runtimeId) throw new Error('RUNTIME_ID_REQUIRED');
  const m = new Map();
  for (const r of controlPlane.listActivations()) {
    if (r.schema === 'ACTIVATION_RECORD_V1' && r.activation_id) m.set(r.activation_id, r);
  }
  return [...m.values()].filter(
    (a) => a.target_runtime_id === runtimeId && a.activation_status === 'PENDING_RUNTIME_PULL'
  );
}

/**
 * Runtime 拉取:列出**已到生效日**且待拉取的 Activation(head 状态为准)。
 * effective_from 晚于当前业务日的不在此列 —— 见 runtimeScheduledActivations。
 */
function runtimePendingActivations(runtimeId, o = {}) {
  const today = _today(o);
  return _awaitingPull(runtimeId).filter((a) => String(a.effective_from) <= today);
}

/** 已批准但未到生效日的 Activation(只读可见,不可拉取;供 Runtime Status 与研究台展示)。 */
function runtimeScheduledActivations(runtimeId, o = {}) {
  const today = _today(o);
  return _awaitingPull(runtimeId).filter((a) => String(a.effective_from) > today);
}

function _bundleOf(ref) {
  const [bundleId, ver] = String(ref).split('#v');
  return { bundleId, version: ver ? Number(ver) : null, head: registry.bundleHead(bundleId, ver ? Number(ver) : null) };
}

/**
 * Runtime ACK:Runtime 拉到 Activation、按自身副本重算 release hash 后回执。
 * verified_release_hash 必须与 Release 台账一致(fail-closed);
 * 成功 → Activation ACTIVE + Bundle→ACTIVE(activationRef 绑定)。
 */
function runtimeAck(activationId, o = {}) {
  const act = controlPlane.activationHead(activationId);
  if (!act) throw new Error('ACTIVATION_NOT_FOUND');
  if (act.activation_status !== 'PENDING_RUNTIME_PULL') throw new Error(`ACTIVATION_NOT_PENDING:${act.activation_status}`);
  if (!o.runtime_id) throw new Error('ACK_MISSING_RUNTIME_ID');
  if (o.runtime_id !== act.target_runtime_id) throw new Error(`ACK_RUNTIME_MISMATCH:${o.runtime_id}!=${act.target_runtime_id}`);
  if (!o.verified_release_hash) throw new Error('ACK_MISSING_VERIFIED_RELEASE_HASH');
  // 生效日门控(fail-closed):未到 effective_from 不允许加载,批准 ≠ 生效
  const today = _today(o);
  if (String(act.effective_from) > today) throw new Error(`ACTIVATION_NOT_YET_EFFECTIVE:${act.effective_from}>${today}`);

  const release = controlPlane.releaseHead(act.release_id);
  if (!release) throw new Error('ACTIVATION_RELEASE_NOT_FOUND');

  const hashOk = o.verified_release_hash === release.release_hash && release.release_hash === act.release_hash;
  const ack = {
    schema: 'RUNTIME_ACK_V1',
    ack_id: `ACK-${hash({ a: activationId, t: uid() })}`,
    activation_ref: activationId,
    runtime_id: o.runtime_id,
    environment: act.environment,
    verified_release_hash: o.verified_release_hash,
    expected_release_hash: release.release_hash,
    hash_verified: hashOk,
    health_check: o.health_check || null,
    ackedAt: now(),
  };
  append(ACK_LEDGER(), ack);

  if (!hashOk) {
    // Fail Closed:hash 不匹配绝不激活
    append(controlPlane.ACTIVATIONS_LEDGER(), {
      ...act, activation_status: 'ACK_REJECTED',
      runtime_ack: ack.ack_id,
      reject_reasonCn: `release_hash 校验失败:runtime 上报 ${o.verified_release_hash},台账 ${release.release_hash}`,
    });
    return { ok: false, reason: 'RELEASE_HASH_MISMATCH', ack };
  }

  const activated = append(controlPlane.ACTIVATIONS_LEDGER(), {
    ...act, activation_status: 'ACTIVE', runtime_ack: ack.ack_id, activatedAt: now(),
  });

  // Bundle → ACTIVE(唯一合法入口:携带 activationRef)
  const { bundleId, version, head } = _bundleOf(release.immutable_bundle_ref);
  let bundleTransition = null;
  if (head && head.status !== 'ACTIVE') {
    bundleTransition = registry.transitionBundle(bundleId, version, 'ACTIVE', {
      activationRef: activationId,
      approved_by: 'FOUNDER',
      effective_from: act.effective_from,
      by: 'CONTROL_PLANE_RUNTIME_BINDING',
      reason: `runtime_ack:${ack.ack_id}`,
    });
    if (!bundleTransition.ok) {
      // 台账态与 registry 态不一致 = 显式错误,不静默
      throw new Error(`BUNDLE_ACTIVATE_FAILED:${bundleTransition.reason}`);
    }
  }
  // No Silent Migration:生效即对既有持仓做迁移裁定(只产 REPLAN_REQUIRED,绝不自动迁移)
  const migration = require('./migration').assessMigration(activated, release);
  return { ok: true, activation: activated, ack, bundleTransition, migration };
}

/** Runtime NACK:健康检查/本地校验失败时显式拒绝(不自动重试,等人工处置)。 */
function runtimeNack(activationId, o = {}) {
  const act = controlPlane.activationHead(activationId);
  if (!act) throw new Error('ACTIVATION_NOT_FOUND');
  if (act.activation_status !== 'PENDING_RUNTIME_PULL') throw new Error(`ACTIVATION_NOT_PENDING:${act.activation_status}`);
  if (!o.runtime_id || o.runtime_id !== act.target_runtime_id) throw new Error('NACK_RUNTIME_MISMATCH');
  const nack = {
    schema: 'RUNTIME_NACK_V1',
    ack_id: `NACK-${hash({ a: activationId, t: uid() })}`,
    activation_ref: activationId,
    runtime_id: o.runtime_id,
    reasonCn: o.reasonCn || 'runtime 本地校验/健康检查失败',
    nackedAt: now(),
  };
  append(ACK_LEDGER(), nack);
  append(controlPlane.ACTIVATIONS_LEDGER(), { ...act, activation_status: 'RUNTIME_REJECTED', runtime_ack: nack.ack_id });
  return { ok: true, nack };
}

function listAcks(activationId = null) {
  return read(ACK_LEDGER()).filter((r) => !activationId || r.activation_ref === activationId);
}

module.exports = {
  runtimePendingActivations, runtimeScheduledActivations,
  runtimeAck, runtimeNack, listAcks, ACK_LEDGER,
};
