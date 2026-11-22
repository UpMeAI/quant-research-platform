'use strict';

/**
 * 大模型生成方的网络那一步（RF1116 §3.5「网络只许连模型接口」；★K (b) 研究专用密钥只挂进这一步；任务书 93a93509 + 补充 2）。
 *
 * 这是整个沙箱里唯一连网的容器（deploy/research-lane/round-runner/run.sh 的 llm-step）：它只挂两样东西 —— 研究专用密钥文件（只读）和交换目录（可写），
 * 没有数据、没有台账、没有留出段。执行器容器（--network none）把请求写进交换目录，这一步答，执行器再读。
 *   - 请求体在发之前再核一遍（services/mining-sandbox/llm 的 checkRequestBody）：普通对话补全，没有 tools / 联网 / 文件 / 网址；
 *   - 进程出网锁（lockEgress）：只许连配置里的主机的 443 口，别的主机、http、net、tls、dgram、fetch 一律在进程里就拒；
 *   - 密钥只从挂进来的 env 文件读，从不写文件、不进日志、不进错误信息（上游回显的也打码）；
 *   - 失败态：密钥不在 → WAITING_KEY_ABSENT；402 → WAITING_QUOTA；429 → WAITING_RATE_LIMITED（不推断成并发上限）；401 / 403 → WAITING_KEY_REJECTED；
 *     5xx 与网络错误 → WAITING_PROVIDER_UNAVAILABLE；400 / 422 → STOPPED_REQUEST_INVALID。原始错误照留（打码、截断）。每个请求最多发一次，不自动重试；
 *   - 上一次在调用途中崩了（.inflight 还在、没有应答）→ 不再发，记 WAITING_STEP_CRASHED_MID_CALL（调用可能已经计费，由执行器按上界计量）。
 * 本模块不读也不写模型名：模型来自配置（services/mining-sandbox/llm）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const llm = require('../mining-sandbox/llm');

const RAW_ERROR_MAX = 2000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── 出网锁 ───────────────────────────────────────────────────────────────

class EgressError extends Error {
  constructor(detail) { super(`MINE_LLM_EGRESS_REFUSED:${detail}`); this.code = 'MINE_LLM_EGRESS_REFUSED'; this.detail = detail; }
}
let LOCK = null;

/** 本进程只许连 host:port（https）。不能解除。 */
function lockEgress({ host, port }) {
  if (LOCK) { if (LOCK.host !== String(host).toLowerCase() || LOCK.port !== port) throw new EgressError('ALREADY_LOCKED_TO_ANOTHER_TARGET'); return LOCK; }
  LOCK = Object.freeze({ host: String(host).toLowerCase(), port });
  const allowed = (h, p) => typeof h === 'string' && h.toLowerCase() === LOCK.host && Number(p) === LOCK.port;
  const refuse = (what) => { throw new EgressError(what); };
  const connectTarget = (args) => {
    let a = args[0];
    if (Array.isArray(a)) a = a[0]; // Socket.connect 收到的是 net 内部规范化过的 [options, cb]
    if (a !== null && typeof a === 'object') return a.path ? { path: a.path } : { host: a.host || 'localhost', port: a.port };
    if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(a) };
    return { path: String(a) };
  };
  const guardConnect = (what) => (args) => {
    const t = connectTarget(args);
    if (t.path || !allowed(t.host, t.port)) refuse(`${what}:${t.path ? `path:${t.path}` : `${t.host}:${t.port}`}`);
  };
  const wrap = (obj, name, check) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function guarded(...args) { check(args); return orig.apply(this, args); };
  };
  const requestTarget = (defaultProtocol, args) => {
    const [first, second] = args;
    let protocol = defaultProtocol; let hostname; let prt;
    const take = (o) => { if (o.protocol) protocol = o.protocol; if (o.hostname || o.host) hostname = o.hostname || o.host; if (o.port) prt = o.port; };
    if (typeof first === 'string' || first instanceof URL) {
      let u; try { u = new URL(String(first)); } catch { return refuse('request:URL_INVALID'); }
      protocol = u.protocol; hostname = u.hostname; prt = u.port || undefined;
      if (second && typeof second === 'object') take(second);
    } else if (first && typeof first === 'object') take(first);
    return { protocol, host: hostname || 'localhost', port: Number(prt || (protocol === 'https:' ? 443 : 80)) };
  };
  const guardRequest = (what, def) => (args) => {
    const t = requestTarget(def, args);
    if (t.protocol !== 'https:' || !allowed(t.host, t.port)) refuse(`${what}:${t.protocol}//${t.host}:${t.port}`);
  };
  wrap(https, 'request', guardRequest('https.request', 'https:'));
  wrap(https, 'get', guardRequest('https.get', 'https:'));
  wrap(http, 'request', guardRequest('http.request', 'http:'));
  wrap(http, 'get', guardRequest('http.get', 'http:'));
  wrap(net, 'connect', guardConnect('net.connect'));
  wrap(net, 'createConnection', guardConnect('net.createConnection'));
  wrap(tls, 'connect', guardConnect('tls.connect'));
  wrap(net.Socket.prototype, 'connect', guardConnect('socket.connect'));
  dgram.createSocket = () => refuse('dgram');
  globalThis.fetch = () => Promise.reject(new EgressError('fetch'));
  return LOCK;
}

// ── 密钥 ─────────────────────────────────────────────────────────────────

/**
 * 从挂进来的 env 文件读密钥。文件不在 / 不是普通文件 / 组或其他人可读 / 没有这个变量 → WAITING_KEY_ABSENT（reason 不带密钥）。
 * @returns {{ok: true, key: string} | {ok: false, outcome: 'WAITING_KEY_ABSENT', reason: string}}
 */
function readKey({ file, variable }) {
  const absent = (reason) => ({ ok: false, outcome: 'WAITING_KEY_ABSENT', reason });
  let st;
  try { st = fs.statSync(file); } catch { return absent('FILE_ABSENT'); }
  if (!st.isFile()) return absent('NOT_A_FILE');
  if ((st.mode & 0o077) !== 0) return absent('MODE_TOO_OPEN');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return absent('UNREADABLE'); }
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw.replace(/\r$/, ''));
    if (!m || m[1] !== variable) continue;
    let v = m[2];
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    if (v) return { ok: true, key: v };
  }
  return absent('VARIABLE_ABSENT');
}

// ── 一次模型调用 ─────────────────────────────────────────────────────────

/** 原始错误：打码（密钥原文、Bearer、sk- 开头的串），截断。 */
function redact(text, key = null) {
  let t = String(text);
  if (key) t = t.split(key).join('[REDACTED]');
  t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
  return t.length > RAW_ERROR_MAX ? `${t.slice(0, RAW_ERROR_MAX)}…[truncated ${t.length - RAW_ERROR_MAX} chars]` : t;
}

/** 默认 transport：https（出网锁之后只有配置里的主机能连）。 */
function httpsTransport({ url, method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const d = u.completion_tokens_details;
  return { prompt_tokens: num(u.prompt_tokens), completion_tokens: num(u.completion_tokens), total_tokens: num(u.total_tokens),
    prompt_cache_hit_tokens: num(u.prompt_cache_hit_tokens), prompt_cache_miss_tokens: num(u.prompt_cache_miss_tokens), reasoning_tokens: d && typeof d === 'object' ? num(d.reasoning_tokens) : null };
}

const EMPTY = Object.freeze({ sent: false, http_status: null, content: null, model: null, finish_reason: null, system_fingerprint: null, usage: null, raw_error: null, reason: null, response_sha256: null });
const classify = (status) => {
  if (status === 402) return 'WAITING_QUOTA';
  if (status === 429) return 'WAITING_RATE_LIMITED';
  if (status === 401 || status === 403) return 'WAITING_KEY_REJECTED';
  if (status >= 500 || status === 408 || status === 425) return 'WAITING_PROVIDER_UNAVAILABLE';
  return 'STOPPED_REQUEST_INVALID';
};

/**
 * 调一次模型（最多发一次，不重试）。发之前先核请求体。
 * @param {{body: object, config: object, key: string, transport?: Function}} o
 */
async function callModel({ body, config, key, transport = httpsTransport }) {
  try { llm.checkRequestBody(body, config); } catch (e) {
    if (!(e instanceof llm.LlmError)) throw e;
    return { ...EMPTY, outcome: 'STOPPED_REQUEST_INVALID', raw_error: redact(e.message, key) };
  }
  const text = JSON.stringify(body);
  let res;
  try {
    res = await transport({ url: config.endpoint.url, method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: text, timeoutMs: config.request.timeout_ms });
  } catch (e) {
    return { ...EMPTY, sent: true, outcome: 'WAITING_PROVIDER_UNAVAILABLE', raw_error: redact(`${e && (e.code || e.name) || 'ERROR'}: ${e && e.message}`, key) };
  }
  const bodyText = typeof res.body === 'string' ? res.body : '';
  const base = { ...EMPTY, sent: true, http_status: res.status, response_sha256: bodyText ? sha256(bodyText) : null };
  if (res.status !== 200) return { ...base, outcome: classify(res.status), raw_error: redact(bodyText || `HTTP ${res.status}`, key) };
  let j;
  try { j = JSON.parse(bodyText); } catch { return { ...base, outcome: 'WAITING_PROVIDER_UNAVAILABLE', raw_error: redact(bodyText || 'EMPTY_BODY', key), reason: 'RESPONSE_NOT_JSON' }; }
  const choice = j && Array.isArray(j.choices) ? j.choices[0] : null;
  if (!choice || typeof choice !== 'object') return { ...base, outcome: 'WAITING_PROVIDER_UNAVAILABLE', raw_error: redact(bodyText, key), reason: 'RESPONSE_SHAPE' };
  const content = choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
  return { ...base, outcome: 'OK', content, model: typeof j.model === 'string' ? j.model : null, finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    system_fingerprint: typeof j.system_fingerprint === 'string' ? j.system_fingerprint : null, usage: normalizeUsage(j.usage) };
}

// ── 交换目录 ─────────────────────────────────────────────────────────────

/**
 * 答交换目录里还没有应答的请求（每个请求最多答一次；已有应答的不重答）。
 * @returns {Promise<number>} 这一遍里真正发出去的调用数
 */
async function answerPending({ dir, config, keyFile, transport = httpsTransport, now = () => new Date().toISOString() }) {
  let sent = 0; let keyState = null;
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.req.json')).sort();
  for (const name of names) {
    const base = name.slice(0, -'.req.json'.length);
    const resFile = path.join(dir, `${base}.res.json`); const inflight = path.join(dir, `${base}.inflight`);
    if (fs.existsSync(resFile)) continue;
    const req = llm.readJson(path.join(dir, name));
    if (!req || req.schema !== 'MINING_LLM_REQUEST_V1' || typeof req.key !== 'string') continue; // 没写完或不是我们的文件：不理
    const respond = (r) => llm.writeAtomic(resFile, `${JSON.stringify({ schema: 'MINING_LLM_RESPONSE_V1', key: req.key, kind: req.kind, round_id: req.round_id, request_sha256: req.request_sha256, answered_at: now(), ...EMPTY, ...r })}\n`);
    if (req.request_sha256 !== sha256(JSON.stringify(req.body))) { respond({ outcome: 'STOPPED_REQUEST_INVALID', raw_error: 'MINE_LLM_REQUEST_SHA_MISMATCH' }); continue; }
    try { llm.checkRequestBody(req.body, config); } catch (e) {
      if (!(e instanceof llm.LlmError)) throw e;
      respond({ outcome: 'STOPPED_REQUEST_INVALID', raw_error: e.message });
      continue;
    }
    if (fs.existsSync(inflight)) { respond({ outcome: 'WAITING_STEP_CRASHED_MID_CALL', sent: true, reason: 'INFLIGHT_MARKER_WITHOUT_RESPONSE' }); continue; }
    if (!keyState) keyState = readKey({ file: keyFile, variable: config.key.variable });
    if (!keyState.ok) { respond({ outcome: keyState.outcome, reason: keyState.reason }); keyState = null; continue; }
    fs.writeFileSync(inflight, `${JSON.stringify({ started_at: now() })}\n`);
    const r = await callModel({ body: req.body, config, key: keyState.key, transport });
    respond(r);
    try { fs.unlinkSync(inflight); } catch { /* 应答已写好，标记留着也无妨 */ }
    if (r.sent) sent += 1;
  }
  return sent;
}

/** 探活：一条不含公式的请求；结果写进交换目录（ping-*.json），不写台账、不计 N、不含任何公式。 */
async function ping({ dir, config, keyFile, transport = httpsTransport, at = new Date().toISOString() }) {
  const key = readKey({ file: keyFile, variable: config.key.variable });
  if (!key.ok) return { outcome: key.outcome, reason: key.reason };
  const body = llm.pingRequest(config);
  const r = await callModel({ body, config, key: key.key, transport });
  let outcome = r.outcome; let modelReported = r.model; let servedVersion = null;
  if (r.outcome === 'OK') {
    const m = llm.checkResponseModel(r.model, config);
    modelReported = m.model_reported; servedVersion = m.served_version;
    if (!m.ok) outcome = m.outcome;
  }
  const record = { schema: 'MINING_LLM_PING_V1', at, outcome, round_id: null, formulas: 0, model_requested: config.model.api_model, model_reported: modelReported, served_version: servedVersion,
    http_status: r.http_status, usage: r.usage, content_chars: r.content === null ? null : r.content.length, raw_error: r.raw_error, request_sha256: sha256(JSON.stringify(body)) };
  fs.mkdirSync(dir, { recursive: true });
  llm.writeAtomic(path.join(dir, `ping-${String(at).replace(/[^0-9A-Za-z]/g, '')}.json`), `${JSON.stringify(record)}\n`);
  return { outcome, model_reported: modelReported, served_version: servedVersion, usage: r.usage, http_status: r.http_status, raw_error: r.raw_error, reason: r.reason };
}

/** 常驻：一直答交换目录里的请求，直到被停（docker stop）。 */
function serve({ dir, keyFile, transport = httpsTransport, pollMs = null, config = null }) {
  const cfg = config || llm.loadConfig().config;
  lockEgress({ host: cfg.endpoint.host, port: cfg.endpoint.port });
  fs.mkdirSync(dir, { recursive: true });
  const every = pollMs || cfg.exchange.poll_ms;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
  const loop = async () => {
    for (;;) {
      try { await answerPending({ dir, config: cfg, keyFile, transport }); } catch (e) {
        process.stderr.write(`${JSON.stringify({ error: e && e.code ? e.code : 'MINE_LLM_STEP_FAILED', message: redact(e && e.message) })}\n`);
      }
      await new Promise((r) => setTimeout(r, every));
    }
  };
  return loop();
}

module.exports = { RAW_ERROR_MAX, EgressError, lockEgress, readKey, redact, httpsTransport, callModel, answerPending, ping, serve };
