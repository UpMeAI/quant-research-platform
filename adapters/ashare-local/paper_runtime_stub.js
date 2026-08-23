'use strict';
/**
 * A 股 Paper Runtime Stub(MVP 演示用)。
 *
 * ⚠ 这是平台侧的**模拟 Runtime**,只为在本仓内闭合 §12.2 pull-based 激活协议:
 *   到生效日 Pull(runtimePendingActivations)→ 本地重算/核对 release_hash → ACK / NACK。
 * 生产形态:真实 A 股 Paper Runtime 位于 UpMeAI/Ashare-V5(L8 外部层),
 * 它以同一协议拉取 Activation,本 stub 不产生任何订单/持仓/Paper 账本效应
 * (real_order=0,brokerConnection=false —— 见 runtime_capabilities)。
 */
const binding = require('../../services/strategy-control-plane/runtime_binding');
const controlPlane = require('../../services/strategy-control-plane');
const { RUNTIME_ID } = require('./market_facts');

/**
 * 模拟一次 Runtime 拉取周期:
 *   1. 拉取本 runtime 名下**已到生效日**且 PENDING_RUNTIME_PULL 的 Activation;
 *   2. 对每条:核对环境(本 stub 只支持 PAPER)、按台账 Release 重演 hash 校验;
 *   3. 校验通过 → ACK(附 health_check);不通过 → NACK。
 * @param {string} today 模拟的业务日(默认真实今日);未到生效日的 Activation 不会被拉到。
 */
function pullAndAck({ runtimeId = RUNTIME_ID, today = null, tamperHash = null } = {}) {
  const opts = today ? { today } : {};
  const pending = binding.runtimePendingActivations(runtimeId, opts);
  const scheduled = binding.runtimeScheduledActivations(runtimeId, opts);
  const results = [];
  for (const act of pending) {
    if (act.environment !== 'PAPER') {
      results.push({ activation_id: act.activation_id, action: 'NACK', ...binding.runtimeNack(act.activation_id, { runtime_id: runtimeId, reasonCn: `stub 仅支持 PAPER,收到 ${act.environment}` }) });
      continue;
    }
    // 真实 Runtime 在此处会用本地拉到的 release 副本重算内容哈希;
    // stub 直接读取台账 release_hash 模拟「校验一致」;tamperHash 用于测试 fail-closed 路径。
    const release = controlPlane.releaseHead(act.release_id);
    const verified = tamperHash || (release ? release.release_hash : 'MISSING_RELEASE');
    const r = binding.runtimeAck(act.activation_id, {
      runtime_id: runtimeId, ...opts,
      verified_release_hash: verified,
      health_check: { status: 'HEALTHY', checks: ['config_loaded', 'hash_verified', 'paper_ledger_isolated'], real_order: 0 },
    });
    results.push({ activation_id: act.activation_id, action: r.ok ? 'ACK_ACTIVE' : 'ACK_REJECTED', ...r });
  }
  return {
    runtime_id: runtimeId,
    business_date: opts.today || new Date().toISOString().slice(0, 10),
    pulled: pending.length,
    scheduled_not_yet_effective: scheduled.map((a) => ({ activation_id: a.activation_id, effective_from: a.effective_from })),
    results,
  };
}

// ── §13.1 Runtime 只读面(stub 侧最小实现;生产由 Ashare-V5 Runtime 提供)──────────
/** GET /runtime/active-release —— 当前已加载生效的 Release。 */
function activeRelease({ runtimeId = RUNTIME_ID } = {}) {
  const acts = controlPlane.listActivations()
    .filter((r) => r.schema === 'ACTIVATION_RECORD_V1' && r.target_runtime_id === runtimeId);
  const head = new Map();
  for (const a of acts) head.set(a.activation_id, a);
  const active = [...head.values()].filter((a) => a.activation_status === 'ACTIVE');
  if (!active.length) return { runtime_id: runtimeId, active_release: null, reasonCn: '尚无生效 Release' };
  const latest = active[active.length - 1];
  return {
    runtime_id: runtimeId,
    active_release: latest.release_id,
    release_hash: latest.release_hash,
    effective_from: latest.effective_from,
    environment: latest.environment,
    activation_ref: latest.activation_id,
  };
}

/**
 * GET /runtime/positions-readonly —— 只读持仓摘要。
 * stub 无真实持仓来源:诚实返回 UNAVAILABLE,不伪造 0 持仓
 * (0 持仓与「拿不到持仓」是两件事;生产由 Ashare-V5 Paper 账本回答)。
 */
function positionsReadonly({ runtimeId = RUNTIME_ID } = {}) {
  return {
    runtime_id: runtimeId, status: 'UNAVAILABLE',
    reason: 'STUB_HAS_NO_POSITION_TRUTH',
    reasonCn: 'MVP stub 不持有持仓真相;生产由 Ashare-V5 Paper 账本提供,平台只读',
    positions: null,
  };
}

/** GET /runtime/performance-summary —— 只读绩效摘要(同上:stub 无真相,不伪造)。 */
function performanceSummary({ runtimeId = RUNTIME_ID } = {}) {
  return {
    runtime_id: runtimeId, status: 'UNAVAILABLE',
    reason: 'STUB_HAS_NO_PERFORMANCE_TRUTH',
    reasonCn: 'MVP stub 不持有 NAV/成交真相;生产由 Ashare-V5 Paper Runtime 提供,平台只读',
    summary: null,
  };
}

/** GET /runtime/health —— 运行健康(stub 恒定健康,并回报安全不变量)。 */
function health({ runtimeId = RUNTIME_ID } = {}) {
  return { runtime_id: runtimeId, status: 'HEALTHY', real_order: 0, broker_connection: false, checkedAt: new Date().toISOString() };
}

module.exports = { pullAndAck, activeRelease, positionsReadonly, performanceSummary, health };
