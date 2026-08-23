'use strict';
/**
 * A 股 Paper Runtime Stub(MVP 演示用)。
 *
 * ⚠ 这是平台侧的**模拟 Runtime**,只为在本仓内闭合 §12.2 pull-based 激活协议:
 *   Pull(runtimePendingActivations)→ 本地重算/核对 release_hash → ACK / NACK。
 * 生产形态:真实 A 股 Paper Runtime 位于 UpMeAI/Ashare-V5(L8 外部层),
 * 它以同一协议拉取 Activation,本 stub 不产生任何订单/持仓/Paper 账本效应
 * (real_order=0,brokerConnection=false —— 见 runtime_capabilities)。
 */
const binding = require('../../services/strategy-control-plane/runtime_binding');
const controlPlane = require('../../services/strategy-control-plane');
const { RUNTIME_ID } = require('./market_facts');

/**
 * 模拟一次 Runtime 拉取周期:
 *   1. 拉取本 runtime 名下 PENDING_RUNTIME_PULL 的 Activation;
 *   2. 对每条:核对环境(本 stub 只支持 PAPER)、按台账 Release 重演 hash 校验;
 *   3. 校验通过 → ACK(附 health_check);不通过 → NACK。
 * 返回逐条处理结果,便于 CLI/测试断言。
 */
function pullAndAck({ runtimeId = RUNTIME_ID, tamperHash = null } = {}) {
  const pending = binding.runtimePendingActivations(runtimeId);
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
      runtime_id: runtimeId,
      verified_release_hash: verified,
      health_check: { status: 'HEALTHY', checks: ['config_loaded', 'hash_verified', 'paper_ledger_isolated'], real_order: 0 },
    });
    results.push({ activation_id: act.activation_id, action: r.ok ? 'ACK_ACTIVE' : 'ACK_REJECTED', ...r });
  }
  return { runtime_id: runtimeId, pulled: pending.length, results };
}

module.exports = { pullAndAck };
