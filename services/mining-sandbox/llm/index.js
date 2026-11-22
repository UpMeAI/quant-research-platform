'use strict';

/**
 * 大模型生成方 AI_MINED_LLM 的纯函数部分（RF1116 §3.1、§3.3、§3.5；★M (a) 钉版本、★K (b) 研究专用密钥；任务书 93a93509 + 补充 2 5ab7b720）。
 *
 * 本模块不连网络、不读密钥、不写台账、不引数据 / 打分 / 留出段 / 门：它只做
 *   1 配置：config/mining_llm_generator.v1.json（模型钉在配置里，不是代码常数；发布日不得晚于留出段起点；坏了就拒）；
 *   2 提示词：只由生成方视图（键白名单，同 GP）、冻结空间的读数元数据与算子、登记表里配置点名的机制的经济逻辑组成，没有预测指令；
 *   3 请求：普通对话补全，请求体键固定，不带 tools / 联网 / 文件 / 网址；
 *   4 应答：模型名核对（对不上就等待、不用那批公式）、公式逐行取出（DSL 解析由执行器做）；
 *   5 交换目录：执行器（--network none）与网络那一步（services/mining-llm-step，唯一连网的容器）之间只靠这个目录里的文件说话。
 * 错误码 MINE_LLM_*。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dsl = require('../dsl');
const segs = require('../segments');

const CONFIG_PATH = 'config/mining_llm_generator.v1.json';
const CONFIG_FILE = path.join(__dirname, '..', '..', '..', CONFIG_PATH);
const VIEW_KEYS = Object.freeze(['round_id', 'market', 'space', 'holding_periods', 'mining_scores', 'tried_formulas']);
const SCORE_KEYS = Object.freeze(['candidate_id', 'formula', 'mining_segment_score']);
/** 请求体的键：只有这五个。 */
const REQUEST_KEYS = Object.freeze(['model', 'messages', 'max_tokens', 'temperature', 'stream']);
const REQUEST_SECTION_KEYS = Object.freeze(['temperature', 'max_tokens', 'timeout_ms']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOT_REPORTED = 'NOT_REPORTED';

class LlmError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new LlmError(`MINE_LLM_${code}`, detail); };
const need = (c, code, detail) => { if (!c) fail(code, detail); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v) => Number.isInteger(v) && v >= 1;

// ── 1 配置 ───────────────────────────────────────────────────────────────

/**
 * 读并核配置。bytes 给了就核这份字节（测试与执行器的「开轮之后配置变了」用），否则读仓库里的文件。
 * @returns {{config: object, sha256: string, path: string}}
 */
function loadConfig({ bytes = null } = {}) {
  const buf = bytes || fs.readFileSync(CONFIG_FILE);
  let c;
  try { c = JSON.parse(buf.toString('utf8')); } catch { return fail('CONFIG_INVALID', 'NOT_JSON'); }
  need(isObj(c) && c.schema === 'MINING_LLM_GENERATOR_CONFIG_V1' && c.generator_mode === 'AI_MINED_LLM', 'CONFIG_INVALID', 'schema');
  const m = c.model;
  need(isObj(m) && ['provider', 'api_model', 'served_version', 'release_date', 'cutoff_used', 'holdout_start', 'signed_ref'].every((k) => isText(m[k])), 'CONFIG_INVALID', 'model');
  need(DATE.test(m.release_date) && DATE.test(m.cutoff_used) && DATE.test(m.holdout_start), 'CONFIG_INVALID', 'model dates');
  need(m.knowledge_cutoff === null || DATE.test(m.knowledge_cutoff), 'CONFIG_INVALID', 'knowledge_cutoff');
  need(Array.isArray(m.sources) && m.sources.length >= 1 && m.sources.every((u) => /^https:\/\//.test(u)), 'CONFIG_INVALID', 'sources');
  need(m.holdout_start === segs.SEGMENTS.HOLDOUT.from, 'CONFIG_INVALID', `holdout_start:${m.holdout_start}≠${segs.SEGMENTS.HOLDOUT.from}`);
  // 留出段整段在模型截止日之后：没有公布截止日就以发布日代替（★f 决定页，只会更保守）
  need(m.cutoff_used === (m.knowledge_cutoff || m.release_date), 'CONFIG_INVALID', 'cutoff_used');
  need(m.release_date <= m.holdout_start, 'CONFIG_RELEASE_AFTER_HOLDOUT', `${m.release_date}>${m.holdout_start}`);
  need(m.cutoff_used < m.holdout_start, 'CONFIG_RELEASE_AFTER_HOLDOUT', `${m.cutoff_used}>=${m.holdout_start}`);
  const e = c.endpoint;
  need(isObj(e) && isText(e.url) && isText(e.host) && Number.isInteger(e.port), 'CONFIG_INVALID', 'endpoint');
  let u; try { u = new URL(e.url); } catch { return fail('CONFIG_INVALID', 'endpoint.url'); }
  need(u.protocol === 'https:' && u.hostname === e.host && Number(u.port || 443) === e.port && e.port === 443 && !u.username && !u.password, 'CONFIG_INVALID', 'endpoint is https host:443 only');
  const k = c.key;
  need(isObj(k) && /^[A-Z][A-Z0-9_]*$/.test(k.variable || '') && path.isAbsolute(k.host_path || '') && path.isAbsolute(k.container_path || ''), 'CONFIG_INVALID', 'key');
  need(isObj(c.request) && Object.keys(c.request).every((x) => REQUEST_SECTION_KEYS.includes(x)) && REQUEST_SECTION_KEYS.every((x) => Number.isFinite(c.request[x])), 'CONFIG_INVALID', 'request');
  need(c.request.max_tokens >= 1 && c.request.timeout_ms >= 1000, 'CONFIG_INVALID', 'request range');
  need(isObj(c.batch) && isPosInt(c.batch.formulas_per_call) && c.batch.formulas_per_call <= 50, 'CONFIG_INVALID', 'batch');
  need(isObj(c.limits) && isPosInt(c.limits.tokens_per_round) && isPosInt(c.limits.calls_per_round) && isPosInt(c.limits.empty_replies_stop), 'CONFIG_INVALID', 'limits');
  need(isObj(c.exchange) && isPosInt(c.exchange.poll_ms) && isPosInt(c.exchange.wait_polls), 'CONFIG_INVALID', 'exchange');
  const p = c.prompt;
  need(isObj(p) && isText(p.version) && isObj(p.mechanisms) && isText(p.mechanisms.layer) && isText(p.mechanisms.decision_point) && Array.isArray(p.mechanisms.ids) && p.mechanisms.ids.length >= 1
    && isPosInt(p.max_line_chars), 'CONFIG_INVALID', 'prompt');
  return { config: c, sha256: sha256(buf), path: CONFIG_PATH };
}

/** 登记表里配置点名的机制（只取 mechanisms[]，不读 entries[] 的封存结论）。 */
function mechanismsFor(register, sel) {
  need(isObj(register) && Array.isArray(register.mechanisms) && isObj(sel) && Array.isArray(sel.ids), 'CONFIG_INVALID', 'mechanisms');
  const byId = new Map(register.mechanisms.map((m) => [m.mechanism_id, m]));
  return sel.ids.map((id) => {
    const m = byId.get(id);
    need(m && m.layer === sel.layer && m.decision_point === sel.decision_point && isText(m.description_zh), 'CONFIG_INVALID', `mechanism:${id}`);
    return { mechanism_id: m.mechanism_id, description_zh: m.description_zh };
  });
}

// ── 2 提示词 ─────────────────────────────────────────────────────────────

/** 挖掘段分数在提示词里的写法（4 位小数）。 */
const formatScore = (x) => Number(x).toFixed(4);
const oneLine = (s, max) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };

function checkView(view) {
  need(isObj(view), 'VIEW_INVALID');
  for (const k of Object.keys(view)) need(VIEW_KEYS.includes(k), 'VIEW_FIELD_NOT_ALLOWED', k);
  need(Array.isArray(view.mining_scores) && Array.isArray(view.tried_formulas), 'VIEW_INVALID', 'mining_scores/tried_formulas');
  for (const s of view.mining_scores) for (const k of Object.keys(s || {})) need(SCORE_KEYS.includes(k), 'VIEW_FIELD_NOT_ALLOWED', `mining_scores.${k}`);
}

const OPERATOR_NOTES = Object.freeze({
  rank: 'rank(x): cross-sectional rank of x across stocks on each day, 0 to 1',
  zscore: 'zscore(x): cross-sectional z-score of x on each day',
  neutralize_industry: 'neutralize_industry(x): x minus its industry mean on each day',
  neutralize_size: 'neutralize_size(x): residual of x after regressing on log market value on each day',
  ts_mean: 'ts_mean(x, n): mean of x over the last n days, per stock',
  ts_std: 'ts_std(x, n): sample standard deviation of x over the last n days, per stock',
  ts_delta: 'ts_delta(x, n): x today minus x n days ago, per stock',
  ts_rank: 'ts_rank(x, n): position of today\'s x within its own last n days, 0 to 1',
  ts_corr: 'ts_corr(x, y, n): correlation of x and y over the last n days, per stock',
  sign: 'sign(x): -1, 0 or 1',
  abs: 'abs(x): absolute value',
  log: 'log(x): natural log, undefined for values that are not positive',
});

/**
 * 提示词：纯函数，同样的输入 → 同样的字节。
 * @param {{view: object, space: object, mechanisms: object[], holdingPeriod: number, n: number, miningSegment: {from: string, to: string}, config: object}} o
 * @returns {{messages: {role: string, content: string}[], sha256: string, version: string}}
 */
function buildPrompt({ view, space, mechanisms, holdingPeriod, n, miningSegment, config } = {}) {
  checkView(view);
  need(isObj(space) && Array.isArray(space.readings) && Array.isArray(space.operators) && Array.isArray(space.constants) && Array.isArray(space.lookbacks), 'SPACE_INVALID');
  need(isPosInt(n) && isPosInt(holdingPeriod) && isObj(miningSegment) && DATE.test(miningSegment.from) && DATE.test(miningSegment.to), 'PROMPT_INPUT_INVALID');
  const max = config.prompt.max_line_chars;
  const maxTokens = Math.min(dsl.MAX_TOKENS, space.max_tokens || dsl.MAX_TOKENS); const maxDepth = Math.min(dsl.MAX_DEPTH, space.max_depth || dsl.MAX_DEPTH);
  const system = 'You write factor formulas in a small formula language for a research sandbox. '
    + 'Reply with formulas only: one formula per line, no numbering, no explanations, no code fences.';
  const scored = view.mining_scores.filter((s) => Number.isFinite(s.mining_segment_score) && typeof s.formula === 'string')
    .sort((a, b) => (b.mining_segment_score - a.mining_segment_score) || (a.candidate_id < b.candidate_id ? -1 : 1));
  const lines = [
    `Write exactly ${n} new formulas. Each formula must use only the readings, operators, constants and windows listed below.`,
    '',
    `Language: expressions such as rank(ts_mean(close_hfq, 20) / ts_std(close_hfq, 20)). Operators take expressions as arguments; the last argument n of a time-series operator is a window. Binary + - * / and a leading minus are allowed. At most ${maxTokens} tokens (operator names, readings, numbers and arithmetic signs; parentheses and commas do not count) and at most ${maxDepth} levels of nesting.`,
    '',
    'Operators:',
    ...space.operators.map((o) => `- ${OPERATOR_NOTES[o] || o}`),
    '',
    `Constants allowed: ${space.constants.join(', ')}`,
    `Windows allowed (n): ${space.lookbacks.join(', ')}`,
    '',
    'Readings (name; dataset; when a value becomes available):',
    ...space.readings.map((r) => `- ${r.name}; ${r.dataset_id}; ${r.pit_available_at}`),
    '',
    `Each formula is scored on daily data from ${miningSegment.from} to ${miningSegment.to}: the mean daily rank correlation (after industry and size neutralization) between its value and the stock's return over the following ${holdingPeriod} trading days.`,
    '',
    'Economic ideas to express (write each formula as one of these ideas, varying readings, windows and combinations):',
    ...mechanisms.map((m) => `- ${m.mechanism_id}: ${m.description_zh}`),
    '',
    'Scores of formulas already tried in this round (highest first):',
    ...(scored.length ? scored.map((s) => `${formatScore(s.mining_segment_score)}  ${oneLine(s.formula, max)}`) : ['(none yet)']),
    '',
    'Formulas already tried (do not repeat them or trivial rewrites of them):',
    ...(view.tried_formulas.length ? view.tried_formulas.map((f) => oneLine(f, max)) : ['(none yet)']),
  ];
  const messages = [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n') }];
  return { messages, sha256: sha256(JSON.stringify(messages)), version: config.prompt.version };
}

/** token 数的上界（不是计量：计量用接口报的用量）：每个 UTF-8 字节最多一个 token（数字多的行接近这个数），每条消息再加 8。 */
const estimateTokens = (messages) => messages.reduce((a, m) => a + Buffer.byteLength(m.content, 'utf8') + 8, 0);

// ── 3 请求 ───────────────────────────────────────────────────────────────

/** 请求体：普通对话补全。 */
function buildRequest({ messages, config, maxTokens = null }) {
  return { model: config.model.api_model, messages, max_tokens: maxTokens || config.request.max_tokens, temperature: config.request.temperature, stream: false };
}

/** 探活请求：一条不含公式的请求。max_tokens 用生产值（它只是上限，回答一个词花的一样多），这样接口不认这个值，开轮之前就看得到。 */
function pingRequest(config) {
  return buildRequest({ messages: [{ role: 'system', content: 'You are a connectivity check.' }, { role: 'user', content: 'Reply with the single word OK.' }], config });
}

/** 发出之前核请求体（网络那一步在发之前再核一遍）。 */
function checkRequestBody(body, config) {
  need(isObj(body), 'REQUEST_FIELD_NOT_ALLOWED', 'body');
  for (const k of Object.keys(body)) need(REQUEST_KEYS.includes(k), 'REQUEST_FIELD_NOT_ALLOWED', k);
  for (const k of REQUEST_KEYS) need(Object.prototype.hasOwnProperty.call(body, k), 'REQUEST_FIELD_NOT_ALLOWED', `missing:${k}`);
  need(body.stream === false, 'REQUEST_FIELD_NOT_ALLOWED', 'stream');
  need(body.model === config.model.api_model, 'REQUEST_MODEL_NOT_PINNED', String(body.model));
  need(Number.isInteger(body.max_tokens) && body.max_tokens >= 1 && body.max_tokens <= config.request.max_tokens, 'REQUEST_MAX_TOKENS', String(body.max_tokens));
  need(typeof body.temperature === 'number' && Number.isFinite(body.temperature), 'REQUEST_FIELD_NOT_ALLOWED', 'temperature');
  need(Array.isArray(body.messages) && body.messages.length >= 1, 'REQUEST_MESSAGE_INVALID', 'messages');
  for (const m of body.messages) {
    need(isObj(m) && Object.keys(m).sort().join() === 'content,role' && ['system', 'user'].includes(m.role) && typeof m.content === 'string', 'REQUEST_MESSAGE_INVALID', isObj(m) ? Object.keys(m).join() : typeof m);
  }
  return body;
}

// ── 4 应答 ───────────────────────────────────────────────────────────────

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * 应答里的模型名：等于 api_model → 接口没报版本（记 NOT_REPORTED）；等于钉住的版本（不分大小写和标点）→ 照记；别的 → WAITING_MODEL_MISMATCH。
 */
function checkResponseModel(model, config) {
  if (typeof model === 'string' && model === config.model.api_model) return { ok: true, model_reported: model, served_version: NOT_REPORTED };
  if (typeof model === 'string' && model !== '' && norm(model) === norm(config.model.served_version)) return { ok: true, model_reported: model, served_version: model };
  return { ok: false, outcome: 'WAITING_MODEL_MISMATCH', model_reported: typeof model === 'string' ? model : null, served_version: null };
}

/** 应答里的公式：去掉空行与 ``` 围栏行，逐行原样（去首尾空白），只取前 n 行，多的只计数。 */
function parseFormulas(content, n) {
  if (typeof content !== 'string' || !content.trim()) return { formulas: [], lines_dropped: 0, lines_overflow: 0 };
  const all = []; let dropped = 0;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    if (/^```[A-Za-z0-9_+-]*$/.test(line)) { dropped += 1; continue; } // 只丢单独成行的围栏标记；围栏里同一行的公式照样算一个尝试
    all.push(line);
  }
  return { formulas: all.slice(0, n), lines_dropped: dropped, lines_overflow: Math.max(0, all.length - n) };
}

/**
 * 生成方对象（纯函数，没有 I/O）：prepare 给出这一批的提示词与请求体，interpret 把应答变成这一批的公式与计量字段。
 * 交换目录的读写和台账计量由执行器做（round-runner）；本对象不知道文件、网络和台账。
 */
function createGenerator({ config, mechanisms, space, holdingPeriod }) {
  need(isObj(config) && Array.isArray(mechanisms) && isObj(space) && isPosInt(holdingPeriod), 'GENERATOR_OPTIONS_INVALID');
  const params = Object.freeze({ schema: 'AI_MINED_LLM_PARAMS_V1', prompt_version: config.prompt.version, formulas_per_call: config.batch.formulas_per_call,
    max_tokens: config.request.max_tokens, temperature: config.request.temperature, mechanism_ids: mechanisms.map((m) => m.mechanism_id) });
  function prepare(view, { n = config.batch.formulas_per_call } = {}) {
    const prompt = buildPrompt({ view, space, mechanisms, holdingPeriod, n, miningSegment: segs.SEGMENTS.MINING, config });
    const body = buildRequest({ messages: prompt.messages, config });
    checkRequestBody(body, config);
    return { prompt_sha256: prompt.sha256, body, request_sha256: sha256(JSON.stringify(body)), tokens_upper_bound: estimateTokens(prompt.messages) + body.max_tokens };
  }
  /** 应答（网络那一步的 OK 结果）→ { ok, model_reported, served_version, formulas, lines_dropped, lines_overflow }；版本对不上 → ok false，公式不用。 */
  function interpret(response, n) {
    const m = checkResponseModel(response.model, config);
    if (!m.ok) return { ok: false, outcome: m.outcome, model_reported: m.model_reported, served_version: null, formulas: [], lines_dropped: 0, lines_overflow: 0 };
    return { ok: true, outcome: 'OK', model_reported: m.model_reported, served_version: m.served_version, ...parseFormulas(response.content, n) };
  }
  return Object.freeze({ mode: 'AI_MINED_LLM', params, holdingPeriod, prepare, interpret });
}

// ── 5 交换目录 ───────────────────────────────────────────────────────────

const EXCHANGE_MODE = 0o1777; // 执行器容器与网络那一步容器在宿主机上是不同的 uid，目录要对两边都可写；粘滞位：各自只删自己的文件
const exchangeName = (key) => String(key).replace(/[^A-Za-z0-9_-]/g, '_');

/** 建交换目录（已有也行），模式 1777。 */
function ensureExchangeDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, EXCHANGE_MODE);
  return dir;
}
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** 写一个请求（已有同名文件就不重写）。kind: GENERATE | PING。 */
function writeRequest(dir, { kind, key, round_id: roundId, body }, { writtenAt = new Date().toISOString() } = {}) {
  need(['GENERATE', 'PING'].includes(kind) && isText(key) && isObj(body), 'EXCHANGE_REQUEST_INVALID', String(key));
  const file = path.join(dir, `${exchangeName(key)}.req.json`);
  const rec = { schema: 'MINING_LLM_REQUEST_V1', kind, key, round_id: roundId === undefined ? null : roundId, request_sha256: sha256(JSON.stringify(body)), body, written_at: writtenAt };
  if (!fs.existsSync(file)) writeAtomic(file, `${JSON.stringify(rec)}\n`);
  return { file, request_sha256: rec.request_sha256 };
}
/**
 * 撤回没人答的旧请求：写一个 WITHDRAWN_BY_RUNNER 应答，网络那一步见到应答就不再答（花了钱没有记账的口子就此堵上）。
 *   - roundId 不给：全部撤回（llm-init 做，在网络那一步容器起来之前：这时留在目录里的请求都属于已经结束的上一次运行）；
 *   - roundId 给了：只撤回本轮、GENERATE、键不是 keepKey 的（generate 在写新请求之前做；别的轮的请求、探活请求不动）。
 * @returns {string[]} 被撤回的键
 */
function withdrawUnanswered(dir, { roundId = null, keepKey = null, now = () => new Date().toISOString() } = {}) {
  const withdrawn = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.req.json')).sort()) {
    const req = readJson(path.join(dir, name));
    if (!req || req.schema !== 'MINING_LLM_REQUEST_V1' || typeof req.key !== 'string') continue;
    if (roundId !== null && (req.kind !== 'GENERATE' || req.round_id !== roundId || req.key === keepKey)) continue;
    if (readResponse(dir, req.key)) continue;
    if (fs.existsSync(path.join(dir, `${exchangeName(req.key)}.inflight`))) continue; // 调用途中的不撤回：可能已经计费，由 findCrashed / generate 按上界记账
    writeAtomic(path.join(dir, `${exchangeName(req.key)}.res.json`), `${JSON.stringify({ schema: 'MINING_LLM_RESPONSE_V1', key: req.key, kind: req.kind, round_id: req.round_id,
      request_sha256: req.request_sha256, answered_at: now(), outcome: 'WITHDRAWN_BY_RUNNER', sent: false, reason: roundId === null ? 'WITHDRAWN_AT_INIT' : 'PROMPT_CHANGED_BEFORE_ANSWER' })}\n`);
    withdrawn.push(req.key);
  }
  return withdrawn;
}
/**
 * 本轮调用途中崩了、还没记账的请求：没有应答而 .inflight 在，或者网络那一步答了 WAITING_STEP_CRASHED_MID_CALL；键不在 recordedKeys 里。
 * （步骤容器在调用途中被停、被杀，请求可能已经计费。）
 * @returns {{key: string, request_sha256: string, body: object, answered: boolean}[]}
 */
function findCrashed(dir, roundId, recordedKeys) {
  const recorded = new Set(recordedKeys);
  const out = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.req.json')).sort()) {
    const req = readJson(path.join(dir, name));
    if (!req || req.schema !== 'MINING_LLM_REQUEST_V1' || req.kind !== 'GENERATE' || req.round_id !== roundId || recorded.has(req.key)) continue;
    const res = readResponse(dir, req.key);
    const inflight = fs.existsSync(path.join(dir, `${exchangeName(req.key)}.inflight`));
    if ((!res && inflight) || (res && res.outcome === 'WAITING_STEP_CRASHED_MID_CALL')) out.push({ key: req.key, request_sha256: req.request_sha256, body: req.body, answered: Boolean(res) });
  }
  return out;
}
/** 读应答（没有 → null）。 */
function readResponse(dir, key) { return readJson(path.join(dir, `${exchangeName(key)}.res.json`)); }

/** 同步睡一会儿（只在执行器里等应答用；按轮询次数数，不按墙钟，所以 docker pause 期间不会超时）。 */
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/** 等应答：最多 waitPolls 次、每次 pollMs。没来 → null。 */
function waitResponse(dir, key, { pollMs, waitPolls }) {
  for (let i = 0; i <= waitPolls; i += 1) {
    const r = readResponse(dir, key);
    if (r) return r;
    if (i < waitPolls) sleepMs(pollMs);
  }
  return null;
}

module.exports = {
  CONFIG_PATH, VIEW_KEYS, SCORE_KEYS, REQUEST_KEYS, NOT_REPORTED, LlmError,
  loadConfig, mechanismsFor, createGenerator, formatScore, buildPrompt, estimateTokens, buildRequest, pingRequest, checkRequestBody, checkResponseModel, parseFormulas,
  exchangeName, ensureExchangeDir, writeAtomic, readJson, writeRequest, withdrawUnanswered, findCrashed, readResponse, waitResponse, sleepMs,
};
