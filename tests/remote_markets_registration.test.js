'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const local = require('../adapters/ashare-local');
const { ADAPTER_FNS, OPTIONAL_ADAPTER_FNS } = require('../packages/contracts/market_adapter_contract');
const { registerConfiguredRemoteMarkets, createRemoteMarketClient, REMOTE_MARKET_ENV } =
  require('../adapters/clients/remote_markets');

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
}

/**
 * 最小 §14.1 REST 适配器桩(与 Ashare-V5 research-adapter/server.js 同一传输合同):
 * POST {baseUrl}/{fn} ← {args} → {result}。
 */
function stubAdapterServer(marketId, { optional = [] } = {}) {
  return http.createServer((req, res) => {
    const fn = req.url.replace(/^\//, '');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (fn === 'manifest') {
        return send({ result: {
          market_id: marketId, adapter_version: `${marketId.toLowerCase()}/0.0.1`,
          repo_ref: 'stub', supported_asset_types: ['STOCK'], capabilities: ['snapshot'],
          trading_calendar_ref: 'stub', data_contract_version: 'V1',
          cost_model_version: 'C1', execution_model_version: 'E1',
          transport: 'HTTP_JSON_RPC_V1', optional_capabilities: optional,
        } });
      }
      if (ADAPTER_FNS.includes(fn) || optional.includes(fn)) return send({ result: { fn, marketId } });
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `UNKNOWN_ADAPTER_FN:${fn}` }));
    });
  });
}

test('未配置 baseUrl 的市场被跳过,不产生假适配器', async () => {
  const seen = [];
  const out = await registerConfiguredRemoteMarkets({ env: {}, register: (a) => seen.push(a) });
  assert.equal(out.registered.length, 0);
  assert.deepEqual(out.skipped.sort(), Object.keys(REMOTE_MARKET_ENV).sort());
  assert.equal(seen.length, 0);
});

test('已配置的 US_EQUITY / CRYPTO 各自注册,可选能力按 manifest 声明挂载', async () => {
  const us = stubAdapterServer('US_EQUITY', { optional: ['regime_labels'] });
  const crypto = stubAdapterServer('CRYPTO');
  const usUrl = await listen(us);
  const cryptoUrl = await listen(crypto);
  try {
    const seen = [];
    const out = await registerConfiguredRemoteMarkets({
      env: { QRP_ADAPTER_BASE_URL_US_EQUITY: usUrl, QRP_ADAPTER_BASE_URL_CRYPTO: cryptoUrl },
      register: (a) => seen.push(a),
    });
    assert.deepEqual(out.registered.sort(), ['CRYPTO', 'US_EQUITY']);
    assert.ok(out.skipped.includes('CN_A'));
    assert.equal(seen.length, 2);

    const usClient = seen.find((a) => a.manifest.market_id === 'US_EQUITY');
    for (const fn of ADAPTER_FNS) assert.equal(typeof usClient[fn], 'function', `必需函数缺失:${fn}`);
    assert.equal(typeof usClient.regime_labels, 'function', '已声明的可选能力应挂载');

    const cryptoClient = seen.find((a) => a.manifest.market_id === 'CRYPTO');
    // 未声明 optional_capabilities → 不挂载,平台显式降级 UNSUPPORTED,而不是调用后 404
    for (const fn of OPTIONAL_ADAPTER_FNS) assert.equal(cryptoClient[fn], undefined, `未声明的可选能力不应挂载:${fn}`);
  } finally { us.close(); crypto.close(); }
});

test('远端 manifest 的 market_id 与配置槽位不符 → 拒绝注册(防错配端口把 CRYPTO 当 US_EQUITY)', async () => {
  const server = stubAdapterServer('CRYPTO');
  const url = await listen(server);
  try {
    await assert.rejects(
      () => createRemoteMarketClient('US_EQUITY', { baseUrl: url }),
      /REMOTE_MARKET_ID_MISMATCH:expected=US_EQUITY:got=CRYPTO/,
    );
  } finally { server.close(); }
});

test('已配置但连不通 → 抛错,不静默跳过', async () => {
  await assert.rejects(
    () => registerConfiguredRemoteMarkets({
      env: { QRP_ADAPTER_BASE_URL_CRYPTO: 'http://127.0.0.1:1' },
      register: () => {}, timeoutMs: 2000,
    }),
    /ADAPTER_TRANSPORT_ERROR:manifest/,
  );
});

test('内置 CN_A 本地适配器与远程合同同形(合同两侧一致)', () => {
  for (const fn of ADAPTER_FNS) assert.equal(typeof local[fn], 'function', `本地适配器缺必需函数:${fn}`);
  assert.equal(local.manifest.market_id, 'CN_A');
});
