'use strict';
/**
 * Runtime Status(§13.1 只读回读面 / §17 Runtime Status 页)。
 *
 * 边界:平台**只读**各 Market Runtime 的版本、健康、绩效与持仓摘要;
 * 一律经 Market Adapter 的可选只读能力获取,adapter 未实现即显式 UNSUPPORTED,
 * 绝不用平台自己的台账冒充 Runtime 真相(§13:Runtime 才拥有执行真相)。
 */
const { getAdapter } = require('../../adapters/registry');
const binding = require('../strategy-control-plane/runtime_binding');

function _readonly(marketId, fnName) {
  const adapter = getAdapter(marketId);
  if (typeof adapter[fnName] !== 'function') {
    return { status: 'UNSUPPORTED', reason: `ADAPTER_LACKS_${fnName.toUpperCase()}`, reasonCn: `该市场 adapter 未实现 ${fnName};平台不臆造 Runtime 真相` };
  }
  try { return adapter[fnName](); }
  catch (e) { return { status: 'ERROR', reason: String(e.message || e) }; }
}

function capabilities(marketId) { return getAdapter(marketId).runtime_capabilities(); }
function activeRelease(marketId) { return _readonly(marketId, 'runtime_active_release'); }
function positionsReadonly(marketId) { return _readonly(marketId, 'runtime_positions_readonly'); }
function performanceSummary(marketId) { return _readonly(marketId, 'runtime_performance_summary'); }
function health(marketId) { return _readonly(marketId, 'runtime_health'); }

/** §17 Runtime Status 页的单次聚合读取(含平台侧待拉取/未到生效日队列)。 */
function runtimeStatus(marketId, o = {}) {
  const caps = capabilities(marketId);
  return {
    market: marketId,
    runtime_id: caps.runtime_id,
    capabilities: caps,
    active_release: activeRelease(marketId),
    health: health(marketId),
    performance_summary: performanceSummary(marketId),
    positions: positionsReadonly(marketId),
    pending_pull: binding.runtimePendingActivations(caps.runtime_id, o),
    scheduled_not_yet_effective: binding.runtimeScheduledActivations(caps.runtime_id, o),
    readOnlyCn: '平台只读;激活由 Runtime 主动拉取并验证 hash 后生效(§12.2)',
  };
}

module.exports = { capabilities, activeRelease, positionsReadonly, performanceSummary, health, runtimeStatus };
