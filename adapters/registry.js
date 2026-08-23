'use strict';
/**
 * Market Adapter 注册表(§14)—— 平台核心与市场适配器之间的唯一入口。
 * 注册即校验合同(fail-closed:合同不齐拒绝注册);核心侧禁止绕过注册表直连市场实现。
 *
 * 内置注册:
 *   CN_A → adapters/ashare-local(平台内置的 A 股本地适配器,样本数据/演示与测试用)。
 * 生产形态下 A 股适配器由 Ashare-V5 仓库 research-adapter/ 实现同一合同(§5/§20 M2),
 * 经传输层(REST/CLI job,§25 待冻结)接入 —— 合同语义两侧一致。
 */
const { validateAdapter } = require('../packages/contracts/market_adapter_contract');

const _adapters = new Map();

function registerAdapter(adapter) {
  const v = validateAdapter(adapter);
  if (!v.ok) throw new Error(`ADAPTER_CONTRACT_VIOLATION:${v.problems.join(',')}`);
  _adapters.set(adapter.manifest.market_id, adapter);
  return adapter;
}

function getAdapter(marketId) {
  const a = _adapters.get(marketId);
  if (!a) throw new Error(`MARKET_ADAPTER_NOT_REGISTERED:${marketId}`);
  return a;
}

function hasAdapter(marketId) { return _adapters.has(marketId); }
function listAdapters() { return [..._adapters.values()].map((a) => a.manifest); }

registerAdapter(require('./ashare-local'));

module.exports = { registerAdapter, getAdapter, hasAdapter, listAdapters };
