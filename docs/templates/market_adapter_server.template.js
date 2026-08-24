'use strict';
/**
 * §14.1 Market Adapter REST 服务端骨架(模板 —— 复制到**市场仓库**后使用)。
 *
 * 本文件位于 docs/templates/,平台运行时不加载它:市场特有实现属于各自市场仓库(设计 §5)。
 * 复制路径示例:wendy926/smartflow → research-adapter/server.js。
 *
 * 传输合同(§25 已冻结):POST {baseUrl}/{fn} ← { args: [...] } → { result: ... }
 * 与平台侧 adapters/clients/http_market_adapter_client.js 严格对应。
 *
 * 使用方式:
 *   1. 在同目录实现 index.js,导出 manifest 与 §14.1 六个必需函数(+ 已实现的可选函数);
 *   2. 按需修改下方 ADAPTER_MODULE / 默认端口;
 *   3. ADAPTER_TOKEN=xxx node research-adapter/server.js
 *
 * 零额外依赖(node:http),Node >= 18。
 */
const http = require('http');

const ADAPTER_MODULE = './index'; // ← 指向本市场的适配器实现
const adapter = require(ADAPTER_MODULE);

const PORT = Number(process.env.ADAPTER_PORT || 7801);
const HOST = process.env.ADAPTER_HOST || '127.0.0.1';
const TOKEN = process.env.ADAPTER_TOKEN || '';
const MAX_BODY_BYTES = 1024 * 1024; // args 只是 spec/日期,不需要大 body

/**
 * 显式白名单:六个必需函数 + 已实现的可选函数。
 * 不要用 Object.keys(adapter) 反射 —— 适配器模块通常还导出常量与内部件,
 * 反射会把它们意外暴露成远程端点。
 */
const EXPOSED_FNS = Object.freeze([
  'snapshot', 'run_backtest', 'run_shadow', 'validate_release',
  'runtime_capabilities', 'normalize_result',
  // 可选(实现了才留,且必须同时写进 manifest.optional_capabilities,否则平台不挂载):
  'regime_labels',
  'runtime_active_release', 'runtime_positions_readonly',
  'runtime_performance_summary', 'runtime_health',
]);

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  // 鉴权先于路由:未授权者连「哪些 fn 存在」都不该探测到。
  if (TOKEN && req.headers['x-adapter-token'] !== TOKEN) return send(res, 401, { error: 'UNAUTHORIZED' });

  const fn = String(req.url || '').replace(/^\//, '').split('?')[0];

  if (fn === 'manifest') return send(res, 200, { result: adapter.manifest });
  if (!EXPOSED_FNS.includes(fn)) return send(res, 404, { error: `UNKNOWN_ADAPTER_FN:${fn}` });
  if (typeof adapter[fn] !== 'function') return send(res, 500, { error: `ADAPTER_FN_NOT_IMPLEMENTED:${fn}` });

  let args;
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    args = body.args === undefined ? [] : body.args;
    if (!Array.isArray(args)) return send(res, 400, { error: 'ARGS_MUST_BE_ARRAY' });
  } catch (e) {
    return send(res, 400, { error: `BAD_REQUEST_BODY:${e.message}` });
  }

  try {
    const result = await adapter[fn](...args);
    return send(res, 200, { result });
  } catch (e) {
    // 只回 message:栈/路径/凭证不出进程边界。
    return send(res, 500, { error: `ADAPTER_FN_ERROR:${fn}:${e && e.message ? e.message : 'UNKNOWN'}` });
  }
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: `ADAPTER_SERVER_ERROR:${e && e.message}` }));
  });
}

if (require.main === module) {
  const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
  if (!TOKEN && !LOOPBACK.includes(HOST)) {
    // 对外绑定却无鉴权 = 裸奔。拒绝启动而不是"先跑起来再说"(§18 Fail Closed)。
    console.error(JSON.stringify({ error: 'REFUSING_TO_START_WITHOUT_TOKEN_ON_NON_LOOPBACK', host: HOST }));
    process.exit(78); // EX_CONFIG
  }
  createServer().listen(PORT, HOST, () => {
    console.log(JSON.stringify({
      market_id: adapter.manifest.market_id,
      adapter_version: adapter.manifest.adapter_version,
      transport: adapter.manifest.transport || 'HTTP_JSON_RPC_V1',
      bind: `${HOST}:${PORT}`,
      auth: TOKEN ? 'TOKEN' : 'NONE(loopback)',
      exposed: EXPOSED_FNS.length + 1, // +manifest
      real_order: 0,
    }));
  });
}

module.exports = { createServer, EXPOSED_FNS, PORT, HOST };
