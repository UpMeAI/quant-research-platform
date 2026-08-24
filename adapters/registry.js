'use strict';
/**
 * Market Adapter 注册表(§14)—— 平台核心与市场适配器之间的唯一入口。
 * 注册即校验合同(fail-closed:合同不齐拒绝注册);核心侧禁止绕过注册表直连市场实现。
 *
 * 内置注册:
 *   CN_A → adapters/ashare-local(平台内置的 A 股本地适配器,样本数据/演示与测试用)。
 * 生产形态下各市场适配器由**各自市场仓库**实现同一合同(§5/§20 M2),
 * 经 REST 传输层接入(§25 已冻结为 HTTP_JSON_RPC_V1)—— 合同语义两侧一致:
 *   CN_A → UpMeAI/Ashare-V5 research-adapter/;US_EQUITY / CRYPTO → wendy926/smartflow。
 * 接入方式见 adapters/clients/remote_markets.js(按 env 配置注册,未配置即未接入)。
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
