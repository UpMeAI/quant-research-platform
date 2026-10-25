'use strict';
/**
 * 远程市场适配器注册面(设计 §5.2 `adapters/clients/` · §14.1 合同 · §20 M2 跨仓接入)。
 *
 * 为什么存在:市场特有的 PIT 数据、回测内核、成本/执行模型**留在各自市场仓库**(§5),
 * 平台不搬也不复制。因此"平台支持哪些市场"是一个**部署期配置**问题,不是代码问题 ——
 * 本模块把 env 配置翻译成 §14.1 合同对象并注册,平台核心全程只看到合同。
 *
 * 已知市场归属(每个市场的实现仓库):
 *   CN_A       → UpMeAI/Ashare-V5   research-adapter/(REST server 已就位)
 *   US_EQUITY  → wendy926/smartflow trading-system-v2/research-adapter/us/(已实现;部署待配置)
 *   CRYPTO     → wendy926/smartflow research-adapter/(待实现)
 *
 * 边界(§13/§18):
 *   - 平台只持有各远端**研究服务的调用令牌**,永不接触 broker/DB 凭证;
 *   - 未配置 baseUrl 的市场 = 未接入,直接跳过(平台后续查询该市场会拿到
 *     MARKET_ADAPTER_NOT_REGISTERED,而不是一个假装能用的空适配器);
 *   - 已配置但连不通 / 合同不齐 / market_id 不符 = **抛错**,绝不降级注册(Fail Closed)。
 */
const { createHttpMarketAdapterClient } = require('./http_market_adapter_client');

/** 市场 → 环境变量名。新增市场只在这里加一行,核心零改动。 */
const REMOTE_MARKET_ENV = Object.freeze({
  CN_A: { baseUrl: 'QRP_ADAPTER_BASE_URL_CN_A', token: 'QRP_ADAPTER_TOKEN_CN_A' },
  US_EQUITY: { baseUrl: 'QRP_ADAPTER_BASE_URL_US_EQUITY', token: 'QRP_ADAPTER_TOKEN_US_EQUITY' },
  CRYPTO: { baseUrl: 'QRP_ADAPTER_BASE_URL_CRYPTO', token: 'QRP_ADAPTER_TOKEN_CRYPTO' },
});

/**
 * 建立单个远程市场客户端,并校验它自称的 market_id 与我们配置的槽位一致。
 *
 * 为什么要校验 market_id:配置错端口/错环境时,远端会返回**另一个市场**的 manifest。
 * 若不校验,平台会把 CRYPTO 的回测内核注册成 US_EQUITY —— 这类错配在赛马结果里
 * 无法事后分辨(指标形状完全一样),必须在注册那一刻拒绝。
 */
async function createRemoteMarketClient(marketId, cfg = {}) {
  if (!cfg.baseUrl) throw new Error(`REMOTE_MARKET_MISSING_BASE_URL:${marketId}`);
  const client = await createHttpMarketAdapterClient(cfg);
  if (client.manifest.market_id !== marketId) {
    throw new Error(
      `REMOTE_MARKET_ID_MISMATCH:expected=${marketId}:got=${client.manifest.market_id}:baseUrl=${cfg.baseUrl}`,
    );
  }
  return client;
}

/**
 * 按 env 注册全部已配置的远程市场。
 *
 * @returns {{registered:string[], skipped:string[]}} registered=已注册 market_id;
 *          skipped=未配置 baseUrl 因而未接入的市场。任一"已配置但失败"的市场直接抛错。
 */
async function registerConfiguredRemoteMarkets(opts = {}) {
  const env = opts.env || process.env;
  const register = opts.register || require('../registry').registerAdapter;
  const registered = [];
  const skipped = [];

  for (const [marketId, keys] of Object.entries(REMOTE_MARKET_ENV)) {
    const baseUrl = env[keys.baseUrl];
    if (!baseUrl) { skipped.push(marketId); continue; }
    const client = await createRemoteMarketClient(marketId, {
      baseUrl,
      token: env[keys.token],
      timeoutMs: opts.timeoutMs,
    });
    register(client);
    registered.push(marketId);
  }
  return { registered, skipped };
}

module.exports = { REMOTE_MARKET_ENV, createRemoteMarketClient, registerConfiguredRemoteMarkets };
