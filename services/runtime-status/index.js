'use strict';
/**
 * Runtime Status(§13.1 只读回读面 / §17 Runtime Status 页)。
 *
 * 边界:平台**只读**各 Market Runtime 的版本、健康、绩效与持仓摘要;
 * 一律经 Market Adapter 的可选只读能力获取,adapter 未实现即显式 UNSUPPORTED,
 * 绝不用平台自己的台账冒充 Runtime 真相(§13:Runtime 才拥有执行真相)。
 */
const { getAdapter } = require('../../adapters/registry');
const { RUNTIME_INTERFACE } = require('../../packages/contracts/runtime_contract');
const binding = require('../strategy-control-plane/runtime_binding');

async function _readonly(marketId, fnName) {
  const adapter = getAdapter(marketId);
  if (typeof adapter[fnName] !== 'function') {
    return { status: 'UNSUPPORTED', reason: `ADAPTER_LACKS_${fnName.toUpperCase()}`, reasonCn: `该市场 adapter 未实现 ${fnName};平台不臆造 Runtime 真相` };
  }
  try { return await adapter[fnName](); }
  catch (e) { return { status: 'ERROR', reason: String(e.message || e) }; }
}

/**
 * capabilities 也可能是远程调用(§25 传输层)。一个市场适配器不可达
 * **不得**让整个 Runtime Status 页 500 —— 该市场标 UNREACHABLE,其余市场照常可读(§19.1)。
 */
async function capabilities(marketId) {
  try { return await getAdapter(marketId).runtime_capabilities(); }
  catch (e) {
    return {
      runtime_id: null, market_id: marketId, status: 'UNREACHABLE',
      reason: String(e.message || e),
      reasonCn: '市场适配器不可达 —— 平台不臆造 Runtime 能力,也不因单市场故障中断其他市场只读',
      environments_supported: [], broker_connection: false, real_order: 0,
    };
  }
}
async function activeRelease(marketId) { return _readonly(marketId, 'runtime_active_release'); }
async function positionsReadonly(marketId) { return _readonly(marketId, 'runtime_positions_readonly'); }
async function performanceSummary(marketId) { return _readonly(marketId, 'runtime_performance_summary'); }
async function health(marketId) { return _readonly(marketId, 'runtime_health'); }

/**
 * §13.1 Runtime 最小接口覆盖度:把合同里的八个语义端点逐项映射到本平台的落点,
 * 未落地的显式 NOT_IMPLEMENTED —— RUNTIME_INTERFACE 不再是无人引用的死常量。
 */
function interfaceCoverage(marketId) {
  const adapter = getAdapter(marketId);
  const has = (fn) => typeof adapter[fn] === 'function';
  const map = {
    capabilities: has('runtime_capabilities') ? 'ADAPTER:runtime_capabilities' : null,
    active_release: has('runtime_active_release') ? 'ADAPTER:runtime_active_release' : null,
    validate_release: has('validate_release') ? 'ADAPTER:validate_release' : null,
    activate_release: 'PULL_BASED:runtime_binding.runtimePendingActivations+runtimeAck(§12.2)',
    rollback: 'CONTROL_PLANE:rollback → ROLLBACK_RESTORE Activation(由 Runtime 拉取生效)',
    health: has('runtime_health') ? 'ADAPTER:runtime_health' : null,
    performance_summary: has('runtime_performance_summary') ? 'ADAPTER:runtime_performance_summary' : null,
    positions_readonly: has('runtime_positions_readonly') ? 'ADAPTER:runtime_positions_readonly' : null,
  };
  const coverage = {};
  for (const name of RUNTIME_INTERFACE) coverage[name] = map[name] || 'NOT_IMPLEMENTED';
  return {
    contract: 'RUNTIME_INTERFACE_V1(§13.1)',
    coverage,
    implemented_count: Object.values(coverage).filter((v) => v !== 'NOT_IMPLEMENTED').length,
    total: RUNTIME_INTERFACE.length,
  };
}

/** §17 Runtime Status 页的单次聚合读取(含平台侧待拉取/未到生效日队列)。 */
async function runtimeStatus(marketId, o = {}) {
  const caps = await capabilities(marketId);
  return {
    market: marketId,
    runtime_id: caps.runtime_id,
    capabilities: caps,
    interface_coverage: interfaceCoverage(marketId),
    active_release: await activeRelease(marketId),
    health: await health(marketId),
    performance_summary: await performanceSummary(marketId),
    positions: await positionsReadonly(marketId),
    // runtime_id 不可知时无法查激活队列 —— 给空队列 + 明确原因,不假装"没有待拉取项"
    pending_pull: caps.runtime_id ? binding.runtimePendingActivations(caps.runtime_id, o) : [],
    scheduled_not_yet_effective: caps.runtime_id ? binding.runtimeScheduledActivations(caps.runtime_id, o) : [],
    queue_status: caps.runtime_id ? 'READ' : 'UNKNOWN_RUNTIME_UNREACHABLE',
    readOnlyCn: caps.status === 'UNREACHABLE'
      ? caps.reasonCn
      : '平台只读;激活由 Runtime 主动拉取并验证 hash 后生效(§12.2)',
  };
}

module.exports = {
  capabilities, activeRelease, positionsReadonly, performanceSummary, health,
  interfaceCoverage, runtimeStatus,
};
