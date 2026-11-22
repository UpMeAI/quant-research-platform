'use strict';
/**
 * 网关客户端：代理唯一的出口，只说话给本机的 unix socket（socketPath），没有主机名、没有 URL、没有 Authorization。
 * 每次调用最多发一次，不自动重试（重试是队列的事，§3.7）。返回 {ok, status, data} 或 {ok:false, status, error:{rq_class, rq_code, message, retry_after_s}}。
 */
const http = require('http');
const { canonicalJson } = require('./canon');

const err = (code, detail) => Object.assign(new Error(`${code}: ${detail}`), { code });

function createGatewayClient({ socketPath, timeoutMs = 200000 } = {}) {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || socketPath.includes('://') || socketPath.length > 107) throw err('RQ_GATEWAY_SOCKET_INVALID', String(socketPath));

  const request = (method, urlPath, headers, body) => new Promise((resolve) => {
    const fail = (code, status = 0, cls = 'PROVIDER') => resolve({ ok: false, status, error: { rq_class: cls, rq_code: code, message: code, retry_after_s: null } });
    const req = http.request({ socketPath, path: urlPath, method, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* handled below */ }
        if (res.statusCode === 200 && j !== null && typeof j === 'object') return resolve({ ok: true, status: 200, data: j });
        const e = j && j.error && typeof j.error === 'object' ? j.error : {};
        resolve({ ok: false, status: res.statusCode, error: {
          rq_class: typeof e.rq_class === 'string' ? e.rq_class : (res.statusCode >= 500 ? 'PROVIDER' : 'DETERMINISTIC'),
          rq_code: typeof e.rq_code === 'string' ? e.rq_code : 'RQ_GATEWAY_BAD_REPLY',
          message: typeof e.message === 'string' ? e.message.slice(0, 300) : '',
          retry_after_s: Number.isInteger(e.retry_after_s) ? e.retry_after_s : null,
        } });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); fail('RQ_GATEWAY_TIMEOUT'); });
    req.on('error', () => fail('RQ_GATEWAY_UNREACHABLE'));
    req.end(body || undefined);
  });

  return {
    chat({ purpose, task_id, admission_sha256, quality_gate, body }) {
      const headers = { 'Content-Type': 'application/json', 'X-RQ-Purpose': purpose, 'X-RQ-Task-Id': task_id, 'X-RQ-Prompt-Admission': admission_sha256 };
      if (quality_gate) {
        headers['X-RQ-Quality-Gate-Id'] = quality_gate.record_id;
        headers['X-RQ-Quality-Gate-Record'] = Buffer.from(canonicalJson(quality_gate)).toString('base64url');
      }
      return request('POST', '/chat/completions', headers, JSON.stringify(body));
    },
    balance: () => request('GET', '/user/balance', {}, null),
  };
}

module.exports = { createGatewayClient };
