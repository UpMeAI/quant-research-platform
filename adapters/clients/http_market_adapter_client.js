'use strict';
/**
 * 远程 Market Adapter 客户端(设计 §5.2 `adapters/clients/` · §14.1 合同 · §25 传输层)。
 *
 * 为什么需要它:市场特有的 PIT 数据、回测内核与执行能力**留在各自市场仓库**(§5),
 * 平台不搬也不复制。跨仓调用必然是进程外的(REST / CLI job / queue,§25 待冻结),
 * 因此平台侧需要一个"把 §14.1 六函数翻译成远程调用"的客户端 —— 平台核心不知道传输层存在,
 * 它拿到的仍然只是一个满足合同的 adapter 对象。
 *
 * 边界:
 *   - 本客户端**只**携带远端研究服务的调用令牌,永不接触 broker/DB 凭证(§13/§18);
 *   - 全部方法返回 Promise —— 平台核心一律 await(见 market_adapter_contract 调用约定);
 *   - 远端非 2xx / 契约字段缺失 → 抛错,绝不返回半成品让上游静默入账(fail-closed)。
 *
 * 用法:
 *   const { createHttpMarketAdapterClient } = require('./adapters/clients/http_market_adapter_client');
 *   registerAdapter(await createHttpMarketAdapterClient({
 *     baseUrl: 'https://ashare-v5.internal/research-adapter', token: process.env.QRP_ADAPTER_TOKEN_CN_A,
 *   }));
 */
const { ADAPTER_FNS, OPTIONAL_ADAPTER_FNS, validateAdapter } = require('../../packages/contracts/market_adapter_contract');

const DEFAULT_TIMEOUT_MS = 120000; // 回测/WFO 是长任务;超时显式失败,不静默截断

async function _call(cfg, fnName, args) {
  const url = `${String(cfg.baseUrl).replace(/\/$/, '')}/${fnName}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.token ? { 'X-Adapter-Token': cfg.token } : {}),
      },
      body: JSON.stringify({ args }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(`ADAPTER_TRANSPORT_ERROR:${fnName}:${e.name === 'AbortError' ? 'TIMEOUT' : e.message}`);
  } finally { clearTimeout(timer); }

  const text = await res.text();
  if (!res.ok) throw new Error(`ADAPTER_REMOTE_ERROR:${fnName}:${res.status}:${text.slice(0, 300)}`);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`ADAPTER_BAD_JSON:${fnName}`); }
  if (body && body.error) throw new Error(`ADAPTER_REMOTE_ERROR:${fnName}:${body.error}`);
  if (!('result' in body)) throw new Error(`ADAPTER_MISSING_RESULT_ENVELOPE:${fnName}`);
  return body.result;
}

/**
 * 建立远程适配器客户端。启动时拉取一次 manifest 并跑合同校验 —— 合同不齐当场失败,
 * 不允许"能连上就算接入"(§18 Fail Closed)。
 */
async function createHttpMarketAdapterClient(cfg = {}) {
  if (!cfg.baseUrl) throw new Error('ADAPTER_CLIENT_MISSING_BASE_URL');
  const manifest = cfg.manifest || await _call(cfg, 'manifest', []);
  if (!manifest || !manifest.market_id) throw new Error('ADAPTER_CLIENT_MANIFEST_INVALID');

  const client = {
    manifest,
    transport: { kind: 'HTTP_JSON_RPC_V1', baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs || DEFAULT_TIMEOUT_MS },
  };
  for (const fn of ADAPTER_FNS) client[fn] = (...args) => _call(cfg, fn, args);
  // 可选能力:远端 manifest 用 optional_capabilities 声明它实现了哪些;未声明的**不挂**,
  // 平台侧因此显式降级为 UNSUPPORTED,而不是调用后才发现远端 404。
  for (const fn of OPTIONAL_ADAPTER_FNS) {
    if ((manifest.optional_capabilities || []).includes(fn)) client[fn] = (...args) => _call(cfg, fn, args);
  }

  const v = validateAdapter(client);
  if (!v.ok) throw new Error(`ADAPTER_CLIENT_CONTRACT_VIOLATION:${v.problems.join(',')}`);
  return client;
}

module.exports = { createHttpMarketAdapterClient, DEFAULT_TIMEOUT_MS };
