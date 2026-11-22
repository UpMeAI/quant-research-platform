'use strict';
/**
 * RF1116 P2：大模型生成方 AI_MINED_LLM（签字 fd22876f §3.1、§3.3、§3.5；★M (a) deepseek-v4-pro、★K (b) 研究专用密钥，Owner 2026-11-17 d4c05dd7；
 * 留出段冻结页 0fefcd24 的「模型规则」；任务书 RF1116_LLM_GEN_BRIEF_20261118 93a93509 + 补充 2 5ab7b720；协调会话 11-18 15:4x 的六条）。
 * 先红后绿，全部用假的 DeepSeek（mock transport）和假的密钥；不连网络。本文件是单元层；执行器端到端见 mining_llm_round.test.js。
 *
 * 冻结的验收（实现之前写定，不为通过而放宽）：
 *   A1 模型钉在配置里，不是代码常数：config/mining_llm_generator.v1.json 写 provider / api_model deepseek-v4-pro / served_version DeepSeek-V4-Pro-0813 /
 *      release_date 2026-08-13（≤ 留出段起点 2026-10-19 = segments 的 HOLDOUT.from）/ knowledge_cutoff null（官方没公布，以发布日代替）/ 两个官方来源 / 签字出处；
 *      services/ 下的代码里没有模型名字面量；配置坏了（发布日晚于留出段起点、端点不是 https://api.deepseek.com、少字段）一律拒。
 *   A2 只是普通的对话补全：请求体的键恰好是 model、messages、max_tokens、temperature、stream（false）；消息只有 system / user 两种角色、内容是字符串；
 *      带 tools、functions、联网搜索、文件、网址、response_format……任何别的键、或消息里带图片 / 文件 / 网址部件 → 在发出之前拒（网络那一步也再核一次）。
 *   A3 应答的模型名：等于 api_model → 记 served_version NOT_REPORTED；等于钉住的版本（不分大小写和标点）→ 照记；别的 → WAITING_MODEL_MISMATCH，不用它的公式。
 *   A4 留出段看不见：提示词只由 generatorView（键白名单，同 GP）、冻结空间的读数元数据与算子、机制登记表的 mechanisms[]（不读 entries[] 的结论）组成；
 *      不含验证折、留出段的日期，不含结论字样；模块不引台账、数据、打分、留出段、门，也不引任何网络模块。
 *   A5 只取前 n 行、逐行原样交给执行器的 DSL 解析（空行、```围栏行不算公式）；多给的行只计数、不当尝试。
 *   A6 没有预测指令：提示词不含「预测、预判、看涨、看跌、predict、forecast、bullish、bearish」一类字样，只要公式文本。
 *   A7 密钥：只从挂进来的 env 文件读 DEEPSEEK_RESEARCH_API_KEY；文件不在、不是普通文件、组或其他人可读、没有这个变量 → WAITING_KEY_ABSENT，一次网络都不连；
 *      密钥从不出现在任何输出、文件、错误信息里（上游回显也打码）。
 *   A8 失败态：402 → WAITING_QUOTA、429 → WAITING_RATE_LIMITED（不推断成并发上限）、401/403 → WAITING_KEY_REJECTED、5xx 与网络错误 → WAITING_PROVIDER_UNAVAILABLE、
 *      400/422 → STOPPED_REQUEST_INVALID；原始错误照留（截断、打码）；每个请求最多发一次，不自动重试。
 *   A9 网络那一步只连 api.deepseek.com:443：进程里别的主机（http/https/net/tls/fetch）一律拒。
 *   A10 探活（ping）：一条不含公式的请求，结果写进交换目录；不开轮、不写台账、不计 N。
 */
const { dataRoot } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const llm = require('../services/mining-sandbox/llm');
const step = require('../services/mining-llm-step');
const dsl = require('../services/mining-sandbox/dsl');
const spaceMod = require('../services/mining-sandbox/space');
const segs = require('../services/mining-sandbox/segments');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config/mining_llm_generator.v1.json');
const SPACE = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json'), 'utf8'));
const REGISTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/research_mechanism_register.v1.json'), 'utf8'));
const FAKE_KEY = 'sk-fake-research-key-0000-DO-NOT-USE-7f3a91';
const code = (re) => (e) => { assert.match(e.code || e.message, re); return true; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const keyFile = (mode = 0o600, text = `DEEPSEEK_RESEARCH_API_KEY=${FAKE_KEY}\n`) => { const f = path.join(tmp('qrp-llm-key-'), 'deepseek-research.env'); fs.writeFileSync(f, text); fs.chmodSync(f, mode); return f; };
const walkFiles = (d, out = []) => { if (!fs.existsSync(d)) return out; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkFiles(p, out); else out.push(p); } return out; };
const noKeyIn = (dirs) => { for (const d of dirs) for (const f of walkFiles(d)) assert.ok(!fs.readFileSync(f, 'utf8').includes(FAKE_KEY), `key leaked into ${f}`); };

const VIEW = Object.freeze({
  round_id: 'MR-CN_A-2026-12-abc', market: 'CN_A', space: { space_ref: SPACE.space_ref, sha256: 'a'.repeat(64) }, holding_periods: [5],
  mining_scores: [{ candidate_id: 'MR-CN_A-2026-12-abc:A001', formula: 'rank(pb)', mining_segment_score: 0.0123 },
    { candidate_id: 'MR-CN_A-2026-12-abc:A002', formula: 'nope(x)', mining_segment_score: null }],
  tried_formulas: ['nope(x)', 'rank(pb)', 'zscore((-ret_1d))'],
});
const MINING = Object.freeze({ ...segs.SEGMENTS.MINING });
const promptOf = (o = {}) => llm.buildPrompt({ view: VIEW, space: SPACE, mechanisms: llm.mechanismsFor(REGISTER, llm.loadConfig().config.prompt.mechanisms), holdingPeriod: 5, n: 10,
  miningSegment: MINING, config: llm.loadConfig().config, ...o });
const okJson = (content, model = 'deepseek-v4-pro', usage = { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1200 }) => ({
  id: 'x', object: 'chat.completion', created: 1, model, system_fingerprint: 'fp_test', usage,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
/** 假的 transport：记下每次请求（不记密钥本身，只记它对不对），按顺序给应答。 */
function mockTransport(replies) {
  const calls = []; let k = 0;
  const fn = async (req) => {
    calls.push({ url: req.url, method: req.method, header_names: Object.keys(req.headers).sort(), auth_ok: req.headers.Authorization === `Bearer ${FAKE_KEY}`, body: JSON.parse(req.body) });
    const r = replies[Math.min(k, replies.length - 1)]; k += 1;
    if (r.throw) { const e = new Error(`${r.throw} socket hang up`); e.code = r.throw; throw e; }
    return { status: r.status, body: r.body !== undefined ? r.body : JSON.stringify(r.json) };
  };
  fn.calls = calls;
  return fn;
}

test('A1 模型钉在配置里：deepseek-v4-pro / DeepSeek-V4-Pro-0813，发布日 2026-08-13 不晚于留出段起点 2026-10-19；代码里没有模型名；配置坏了就拒', () => {
  const { config, sha256, path: p } = llm.loadConfig();
  assert.equal(p, 'config/mining_llm_generator.v1.json');
  assert.equal(sha256, sha(fs.readFileSync(CONFIG_FILE)));
  const m = config.model;
  assert.deepEqual([m.provider, m.api_model, m.served_version, m.release_date, m.knowledge_cutoff, m.cutoff_used, m.holdout_start],
    ['DEEPSEEK', 'deepseek-v4-pro', 'DeepSeek-V4-Pro-0813', '2026-08-13', null, '2026-08-13', '2026-10-19']);
  assert.ok(m.release_date <= m.holdout_start, 'served version released on or before the holdout start');
  assert.equal(m.holdout_start, segs.SEGMENTS.HOLDOUT.from, 'the holdout start is the frozen one');
  assert.deepEqual([...m.sources].sort(), ['https://api-docs.deepseek.com/quick_start/pricing', 'https://api-docs.deepseek.com/updates']);
  assert.match(m.signed_ref, /fd22876f/); assert.match(m.signed_ref, /★M \(a\)/);
  assert.equal(config.endpoint.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(config.key.variable, 'DEEPSEEK_RESEARCH_API_KEY');
  assert.ok(Number.isInteger(config.limits.empty_replies_stop) && config.limits.empty_replies_stop >= 1, 'consecutive empty replies stop the round');
  assert.equal(config.ping, undefined, 'the probe uses the production max_tokens (review 2026-11-22 #2)');
  assert.ok(!config.prompt.mechanisms.ids.includes('SEL.VALUE.MARGIN_RANK'), 'needs mainline members and implied growth: not expressible with the 13 frozen readings');
  assert.equal(config.key.host_path, '/home/kayla/.config/qrp-research-key/deepseek-research.env');
  // 留出段冻结页写的就是这个版本
  const page = fs.readFileSync(path.join(ROOT, 'docs/freeze/RF1116_HOLDOUT_CN_A_R1_FREEZE_1.md'), 'utf8');
  assert.ok(page.includes(m.api_model) && page.includes(m.served_version.replace(/^DeepSeek-/, '')));
  // 不是代码常数
  const js = walkFiles(path.join(ROOT, 'services')).filter((f) => f.endsWith('.js'));
  for (const f of js) { const s = fs.readFileSync(f, 'utf8'); for (const lit of ['deepseek-v4-pro', 'V4-Pro-0813', 'api.deepseek.com']) assert.ok(!s.includes(lit), `${path.relative(ROOT, f)} hard-codes ${lit}`); }
  // 坏配置
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const bad = (mut, re) => { const c = JSON.parse(JSON.stringify(raw)); mut(c); assert.throws(() => llm.loadConfig({ bytes: Buffer.from(JSON.stringify(c)) }), code(re)); };
  bad((c) => { c.model.release_date = '2026-10-20'; c.model.cutoff_used = '2026-10-20'; }, /MINE_LLM_CONFIG_RELEASE_AFTER_HOLDOUT/);
  bad((c) => { c.model.holdout_start = '2026-10-26'; }, /MINE_LLM_CONFIG_INVALID/);
  bad((c) => { c.model.cutoff_used = '2026-07-01'; }, /MINE_LLM_CONFIG_INVALID/);
  bad((c) => { c.endpoint.url = 'http://api.deepseek.com/chat/completions'; }, /MINE_LLM_CONFIG_INVALID/);
  bad((c) => { c.endpoint.url = 'https://api.example.com/chat/completions'; }, /MINE_LLM_CONFIG_INVALID/);
  bad((c) => { delete c.model.api_model; }, /MINE_LLM_CONFIG_INVALID/);
  bad((c) => { c.limits.tokens_per_round = 0; }, /MINE_LLM_CONFIG_INVALID/);
  bad((c) => { c.limits.empty_replies_stop = 0; }, /MINE_LLM_CONFIG_INVALID/);
  bad((c) => { delete c.limits.empty_replies_stop; }, /MINE_LLM_CONFIG_INVALID/);
  bad((c) => { c.request.tools = []; }, /MINE_LLM_CONFIG_INVALID/);
});

test('A2 只是普通对话补全：请求体恰好 model / messages / max_tokens / temperature / stream:false；tools、联网、文件、网址一律在发出之前拒', () => {
  const { config } = llm.loadConfig();
  const p = promptOf();
  const body = llm.buildRequest({ messages: p.messages, config });
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
  assert.deepEqual([body.model, body.stream, body.max_tokens], [config.model.api_model, false, config.request.max_tokens]);
  assert.ok(body.messages.every((x) => ['system', 'user'].includes(x.role) && typeof x.content === 'string' && Object.keys(x).sort().join() === 'content,role'));
  assert.doesNotThrow(() => llm.checkRequestBody(body, config));
  for (const k of ['tools', 'tool_choice', 'functions', 'function_call', 'web_search', 'search', 'enable_search', 'plugins', 'files', 'file_ids', 'attachments', 'url', 'urls',
    'response_format', 'retrieval', 'logprobs', 'n']) {
    assert.throws(() => llm.checkRequestBody({ ...body, [k]: [] }, config), code(/MINE_LLM_REQUEST_FIELD_NOT_ALLOWED/), k);
  }
  assert.throws(() => llm.checkRequestBody({ ...body, model: 'deepseek-flash' }, config), code(/MINE_LLM_REQUEST_MODEL_NOT_PINNED/));
  assert.throws(() => llm.checkRequestBody({ ...body, stream: true }, config), code(/MINE_LLM_REQUEST_FIELD_NOT_ALLOWED/));
  assert.throws(() => llm.checkRequestBody({ ...body, max_tokens: config.request.max_tokens + 1 }, config), code(/MINE_LLM_REQUEST_MAX_TOKENS/));
  for (const content of [[{ type: 'text', text: 'x' }], [{ type: 'image_url', image_url: { url: 'https://x' } }], [{ type: 'file', file: { file_id: 'f' } }]]) {
    assert.throws(() => llm.checkRequestBody({ ...body, messages: [{ role: 'user', content }] }, config), code(/MINE_LLM_REQUEST_MESSAGE_INVALID/));
  }
  for (const m of [{ role: 'tool', content: 'x' }, { role: 'assistant', content: 'x', tool_calls: [] }, { role: 'user', content: 'x', name: 'web' }]) {
    assert.throws(() => llm.checkRequestBody({ ...body, messages: [m] }, config), code(/MINE_LLM_REQUEST_MESSAGE_INVALID/));
  }
});

test('A4 / A6 提示词：只由生成方视图、读数元数据、算子与机制的经济逻辑组成；不含验证折、留出段与结论；没有预测指令；视图多一个字段就拒', () => {
  const { config } = llm.loadConfig();
  const p = promptOf();
  const text = p.messages.map((x) => x.content).join('\n');
  for (const r of SPACE.readings) { assert.ok(text.includes(r.name), r.name); assert.ok(text.includes(r.pit_available_at), `${r.name} PIT`); }
  for (const o of SPACE.operators) assert.ok(text.includes(`${o}(`), o);
  for (const c of SPACE.constants) assert.ok(text.includes(String(c)));
  assert.ok(text.includes(SPACE.lookbacks.join(', ')));
  const sel = config.prompt.mechanisms;
  const mech = REGISTER.mechanisms.filter((m) => m.layer === sel.layer && m.decision_point === sel.decision_point && sel.ids.includes(m.mechanism_id));
  assert.equal(mech.length, sel.ids.length, 'every configured id is a registered SELECT mechanism');
  assert.ok(mech.length >= 5);
  assert.throws(() => llm.mechanismsFor(REGISTER, { ...sel, ids: [...sel.ids, 'SEL.NOT.REGISTERED'] }), code(/MINE_LLM_CONFIG_INVALID/));
  assert.throws(() => llm.mechanismsFor(REGISTER, { ...sel, ids: ['ACCT.KELLY.CAP_M'] }), code(/MINE_LLM_CONFIG_INVALID/), 'not a SELECT mechanism');
  for (const m of mech) { assert.ok(text.includes(m.mechanism_id), m.mechanism_id); assert.ok(text.includes(m.description_zh)); }
  for (const m of REGISTER.mechanisms.filter((x) => !mech.includes(x))) assert.ok(!text.includes(m.mechanism_id), `${m.mechanism_id} is not a configured mechanism`);
  for (const s of VIEW.mining_scores) assert.ok(text.includes(s.formula));
  assert.ok(text.includes('0.0123'));
  for (const f of VIEW.tried_formulas) assert.ok(text.includes(f));
  assert.ok(text.includes(MINING.from) && text.includes(MINING.to), 'the mining segment is named');
  for (const d of [segs.SEGMENTS.VALIDATION.from, segs.SEGMENTS.VALIDATION.to, segs.SEGMENTS.HOLDOUT.from, segs.SEGMENTS.HOLDOUT.to, config.model.release_date]) {
    assert.ok(!text.includes(d), `prompt names ${d}`);
  }
  for (const w of ['holdout', 'validation', 'fold', 'G-MINE', 'gmine', 'DO_INSUFFICIENT', 'NOT_DO', 'verdict', 'paper', 'race', '留出', '验证折', '赛马', '模拟盘', '结论']) {
    assert.ok(!text.toLowerCase().includes(w.toLowerCase()), `prompt carries «${w}»`);
  }
  for (const w of ['predict', 'forecast', 'bullish', 'bearish', 'will rise', 'will fall', 'future price', '预测', '预判', '看涨', '看跌', '涨跌方向', '择时']) {
    assert.ok(!text.toLowerCase().includes(w), `predictive wording «${w}»`);
  }
  assert.match(text, /formula/i); assert.match(p.messages[0].content, /one formula per line/i);
  assert.equal(p.sha256, promptOf().sha256, 'pure: same inputs, same prompt');
  const bytes = p.messages.reduce((a, m) => a + Buffer.byteLength(m.content, 'utf8'), 0);
  assert.ok(llm.estimateTokens(p.messages) >= bytes, 'the token bound is at least one token per byte (digit-heavy lines tokenize near that)');
  // 登记表的 entries[]（带封存结论）不进提示词
  const sentinel = 'SENTINEL_ENTRY_CONCLUSION_7731';
  const reg = { ...REGISTER, entries: [{ ...REGISTER.entries[0], reason_zh: sentinel, conclusion: { verdict: sentinel } }] };
  const p2 = promptOf({ mechanisms: llm.mechanismsFor(reg, config.prompt.mechanisms) });
  assert.ok(!p2.messages.map((x) => x.content).join('\n').includes(sentinel));
  // 视图白名单（同 GP）
  for (const k of ['validation', 'holdout', 'selection', 'gmine_passes', 'validation_scores', 'race', 'paper']) {
    assert.throws(() => promptOf({ view: { ...VIEW, [k]: [] } }), code(/MINE_LLM_VIEW_FIELD_NOT_ALLOWED/), k);
  }
  assert.throws(() => promptOf({ view: { ...VIEW, mining_scores: [{ ...VIEW.mining_scores[0], validation_ic: 0.2 }] } }), code(/MINE_LLM_VIEW_FIELD_NOT_ALLOWED/));
  // 模块只引这些（不引台账、数据、打分、留出段、门、网络）
  const src = fs.readFileSync(path.join(ROOT, 'services/mining-sandbox/llm/index.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((x) => x[1]).sort();
  assert.deepEqual(requires, ['../dsl', '../segments', 'crypto', 'fs', 'path'], 'segments: the frozen dates only, to check the config against the holdout start');
  assert.ok(!/\bfetch\s*\(/.test(src));
});

test('A5 应答解析：只取前 n 行、去掉空行与 ``` 围栏行，多给的只计数；行原样交出（DSL 解析由执行器做）', () => {
  const r = llm.parseFormulas('```text\nrank(pb)\r\n\n  zscore(turnover_f)  \nHere are more:\nrank(dv_ttm)\n```\n', 3);
  assert.deepEqual(r.formulas, ['rank(pb)', 'zscore(turnover_f)', 'Here are more:']);
  assert.deepEqual([r.lines_dropped, r.lines_overflow], [2, 1]);
  const one = llm.parseFormulas('```rank(pb)```\nrank(dv_ttm)\n```python\nzscore(pb)\n```', 5);
  assert.deepEqual([one.formulas, one.lines_dropped], [['```rank(pb)```', 'rank(dv_ttm)', 'zscore(pb)'], 2], 'a fence marker on its own is dropped; a formula inside a one-line fence is kept as written and counted');
  assert.deepEqual(llm.parseFormulas('', 5), { formulas: [], lines_dropped: 0, lines_overflow: 0 });
  assert.deepEqual(llm.parseFormulas(null, 5), { formulas: [], lines_dropped: 0, lines_overflow: 0 });
  // 交出去的行，解析不过的就是 PARSE_REFUSED（执行器记一行、计入 N）
  assert.throws(() => dsl.parse('Here are more:', spaceMod.dslSpaceOf(SPACE)), /MINE_DSL_/);
});

test('A3 应答的模型名：等于 api_model 记 NOT_REPORTED；等于钉住的版本照记；别的一律 WAITING_MODEL_MISMATCH', () => {
  const { config } = llm.loadConfig();
  assert.deepEqual(llm.checkResponseModel('deepseek-v4-pro', config), { ok: true, model_reported: 'deepseek-v4-pro', served_version: 'NOT_REPORTED' });
  for (const v of ['DeepSeek-V4-Pro-0813', 'deepseek-v4-pro-0813', 'deepseek_v4_pro_0813']) assert.deepEqual(llm.checkResponseModel(v, config), { ok: true, model_reported: v, served_version: v });
  for (const v of ['deepseek-v4-pro-1201', 'DeepSeek-V4-Pro-1119', 'deepseek-flash', 'deepseek-v4-flash', '', null, undefined, 42]) {
    const c = llm.checkResponseModel(v, config);
    assert.equal(c.ok, false, String(v)); assert.equal(c.outcome, 'WAITING_MODEL_MISMATCH');
  }
});

test('A7 密钥：只读挂进来的 env 文件；不在 / 不是文件 / 权限太宽 / 没有变量 → WAITING_KEY_ABSENT，原因不带密钥；0600 与 0400 都可以', () => {
  const variable = 'DEEPSEEK_RESEARCH_API_KEY';
  assert.deepEqual(step.readKey({ file: '/nonexistent/deepseek-research.env', variable }), { ok: false, outcome: 'WAITING_KEY_ABSENT', reason: 'FILE_ABSENT' });
  assert.deepEqual(step.readKey({ file: path.dirname(keyFile()), variable }), { ok: false, outcome: 'WAITING_KEY_ABSENT', reason: 'NOT_A_FILE' });
  for (const mode of [0o644, 0o640, 0o604]) assert.deepEqual(step.readKey({ file: keyFile(mode), variable }), { ok: false, outcome: 'WAITING_KEY_ABSENT', reason: 'MODE_TOO_OPEN' }, mode.toString(8));
  assert.deepEqual(step.readKey({ file: keyFile(0o600, 'OTHER=1\n'), variable }), { ok: false, outcome: 'WAITING_KEY_ABSENT', reason: 'VARIABLE_ABSENT' });
  assert.deepEqual(step.readKey({ file: keyFile(0o600, `${variable}=\n`), variable }), { ok: false, outcome: 'WAITING_KEY_ABSENT', reason: 'VARIABLE_ABSENT' });
  for (const mode of [0o600, 0o400]) { const k = step.readKey({ file: keyFile(mode), variable }); assert.equal(k.ok, true); assert.equal(k.key, FAKE_KEY); }
  for (const text of [`export ${variable}=${FAKE_KEY}\n`, `# research key\n${variable}="${FAKE_KEY}"\n`, `${variable}='${FAKE_KEY}'`]) assert.equal(step.readKey({ file: keyFile(0o600, text), variable }).key, FAKE_KEY);
  assert.ok(!JSON.stringify(step.readKey({ file: keyFile(0o644), variable })).includes(FAKE_KEY));
});

test('A8 失败态（假的 DeepSeek）：402 → WAITING_QUOTA、429 → WAITING_RATE_LIMITED、401 → WAITING_KEY_REJECTED、5xx / 网络 → WAITING_PROVIDER_UNAVAILABLE、400 / 422 → STOPPED_REQUEST_INVALID；原始错误照留、打码；只发一次', async () => {
  const { config } = llm.loadConfig();
  const body = llm.buildRequest({ messages: promptOf().messages, config });
  const call = async (reply) => { const t = mockTransport([reply]); const r = await step.callModel({ body, config, key: FAKE_KEY, transport: t }); return { r, t }; };
  const ok = await call({ status: 200, json: okJson('rank(pb)\nzscore(pb)') });
  assert.deepEqual([ok.r.outcome, ok.r.http_status, ok.r.content, ok.r.model, ok.r.finish_reason, ok.r.system_fingerprint], ['OK', 200, 'rank(pb)\nzscore(pb)', 'deepseek-v4-pro', 'stop', 'fp_test']);
  assert.deepEqual(ok.r.usage, { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1200, reasoning_tokens: null });
  assert.equal(ok.t.calls.length, 1);
  const c = ok.t.calls[0];
  assert.deepEqual([c.url, c.method, c.auth_ok], [config.endpoint.url, 'POST', true]);
  assert.deepEqual(c.header_names, ['Authorization', 'Content-Type']);
  assert.deepEqual(Object.keys(c.body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature'], 'outgoing body: plain completion, no tools');
  assert.equal(c.body.model, 'deepseek-v4-pro');
  const cases = [
    [{ status: 402, json: { error: { message: 'Insufficient Balance', type: 'unknown_error' } } }, 'WAITING_QUOTA', /Insufficient Balance/],
    [{ status: 429, json: { error: { message: 'Rate Limit Reached' } } }, 'WAITING_RATE_LIMITED', /Rate Limit Reached/],
    [{ status: 401, json: { error: { message: `Authentication Fails, Your api key: ****${FAKE_KEY.slice(-4)} is invalid; ${FAKE_KEY}` } } }, 'WAITING_KEY_REJECTED', /Authentication Fails/],
    [{ status: 403, body: 'forbidden' }, 'WAITING_KEY_REJECTED', /forbidden/],
    [{ status: 500, body: 'internal' }, 'WAITING_PROVIDER_UNAVAILABLE', /internal/],
    [{ status: 503, json: { error: { message: 'Server Overloaded' } } }, 'WAITING_PROVIDER_UNAVAILABLE', /Server Overloaded/],
    [{ throw: 'ECONNRESET' }, 'WAITING_PROVIDER_UNAVAILABLE', /ECONNRESET/],
    [{ throw: 'ETIMEDOUT' }, 'WAITING_PROVIDER_UNAVAILABLE', /ETIMEDOUT/],
    [{ status: 200, body: 'not json' }, 'WAITING_PROVIDER_UNAVAILABLE', /not json/],
    [{ status: 400, json: { error: { message: 'Invalid Format' } } }, 'STOPPED_REQUEST_INVALID', /Invalid Format/],
    [{ status: 422, json: { error: { message: 'Invalid Parameters' } } }, 'STOPPED_REQUEST_INVALID', /Invalid Parameters/],
  ];
  for (const [reply, outcome, raw] of cases) {
    const { r, t } = await call(reply);
    assert.equal(r.outcome, outcome, JSON.stringify(reply));
    assert.match(r.raw_error, raw);
    assert.ok(!r.raw_error.includes(FAKE_KEY), 'raw error redacted');
    assert.ok(!/concurren/i.test(JSON.stringify(r)), 'never reads a quota or rate error as a concurrency limit');
    assert.equal(t.calls.length, 1, `${outcome}: sent once, no retry`);
    assert.equal(r.content, null);
  }
  // 密钥原文打码，即使它不是 sk- 开头、也不在 Bearer 后面（上游回显的任何位置）
  const PLAIN = 'research-key-9f3a-plain-4411'; // no sk- anywhere in it, so only the exact-value redaction can catch it
  const echo = await step.callModel({ body, config, key: PLAIN, transport: mockTransport([{ status: 500, body: `upstream echo: key=${PLAIN}; again ${PLAIN}` }]) });
  assert.match(echo.raw_error, /upstream echo/);
  assert.ok(!echo.raw_error.includes(PLAIN), 'exact key value redacted wherever it appears');
  // 上游回显的是「掩码 + 末几位」：末位也不能留在原始错误里（进台账、交换文件）
  const masked = await call({ status: 401, json: { error: { message: `Authentication Fails, Your api key: ****${FAKE_KEY.slice(-4)} is invalid; ref sk-ab****${FAKE_KEY.slice(-6)}; tail ${FAKE_KEY.slice(-8)}` } } });
  assert.match(masked.r.raw_error, /Authentication Fails/);
  for (const frag of [FAKE_KEY.slice(-4), FAKE_KEY.slice(-6), FAKE_KEY.slice(-8)]) assert.ok(!masked.r.raw_error.includes(frag), `key suffix ${frag.length} chars redacted`);
  assert.ok(!masked.r.raw_error.includes('****'), 'masked-key echoes are removed');
  // 发出之前就拒：请求体多了键，transport 一次都不调
  const t = mockTransport([{ status: 200, json: okJson('rank(pb)') }]);
  const bad = await step.callModel({ body: { ...body, tools: [{ type: 'web_search' }] }, config, key: FAKE_KEY, transport: t });
  assert.equal(bad.outcome, 'STOPPED_REQUEST_INVALID'); assert.match(bad.raw_error, /MINE_LLM_REQUEST_FIELD_NOT_ALLOWED/);
  assert.equal(t.calls.length, 0);
  // 原始错误截断
  const long = await call({ status: 500, body: 'x'.repeat(20000) });
  assert.ok(long.r.raw_error.length <= step.RAW_ERROR_MAX + 40);
});

test('A9 网络那一步只连 api.deepseek.com:443：别的主机（https / http / net / tls / fetch）在进程里就拒', () => {
  const script = `
    const step = require(${JSON.stringify(path.join(ROOT, 'services/mining-llm-step'))});
    step.lockEgress({ host: 'api.deepseek.com', port: 443 });
    const out = {};
    const tryIt = (k, f) => { try { f(); out[k] = 'ALLOWED'; } catch (e) { out[k] = e.code || e.message; } };
    tryIt('https_other', () => require('https').request('https://example.com/x').on('error', () => {}).destroy());
    tryIt('https_other_obj', () => require('https').request({ hostname: 'example.com', port: 443, path: '/' }).on('error', () => {}).destroy());
    tryIt('http_any', () => require('http').request('http://api.deepseek.com/').on('error', () => {}).destroy());
    tryIt('net_ip', () => require('net').connect(443, '1.2.3.4').on('error', () => {}).destroy());
    tryIt('net_obj', () => require('net').connect({ host: 'example.com', port: 80 }).on('error', () => {}).destroy());
    tryIt('tls_other', () => require('tls').connect({ host: 'example.com', port: 443 }).on('error', () => {}).destroy());
    tryIt('deepseek_other_port', () => require('https').request('https://api.deepseek.com:8443/').on('error', () => {}).destroy());
    tryIt('deepseek', () => require('https').request('https://api.deepseek.com/chat/completions', { method: 'POST' }).on('error', () => {}).destroy());
    // a caller-supplied socket bypasses the net / tls wrappers: only the request-level guard sees the target
    const dg = require('dgram');
    tryIt('dgram_create', () => dg.createSocket('udp4'));
    tryIt('dgram_socket_send', () => { const u = new dg.Socket('udp4'); try { u.send(Buffer.from('x'), 9, '127.0.0.1'); } finally { u.close(); } });
    tryIt('dgram_socket_connect', () => { const u = new dg.Socket('udp4'); try { u.connect(9, '127.0.0.1'); } finally { u.close(); } });
    const { PassThrough } = require('stream');
    tryIt('https_custom_socket', () => require('https').request({ hostname: 'example.com', port: 443, createConnection: () => new PassThrough() }).on('error', () => {}).destroy());
    tryIt('http_custom_socket', () => require('http').request({ hostname: 'api.deepseek.com', port: 443, createConnection: () => new PassThrough() }).on('error', () => {}).destroy());
    const viaFetch = (u) => (typeof fetch === 'function' ? fetch(u).then(() => 'ALLOWED', (e) => e.code || (e.cause && e.cause.code) || e.message) : 'NO_FETCH');
    viaFetch('https://example.com/').then((f) => { out.fetch_other = f; return viaFetch('https://api.deepseek.com/'); })
      .then((f) => { out.fetch_deepseek = f; process.stdout.write(JSON.stringify(out)); process.exit(0); });
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  for (const k of ['https_other', 'https_other_obj', 'http_any', 'net_ip', 'net_obj', 'tls_other', 'deepseek_other_port', 'https_custom_socket', 'http_custom_socket', 'dgram_create', 'dgram_socket_send', 'dgram_socket_connect', 'fetch_other', 'fetch_deepseek']) assert.equal(out[k], 'MINE_LLM_EGRESS_REFUSED', k);
  // fetch is off even for the allowed host: the only sanctioned path is the step's https transport
  assert.equal(out.deepseek, 'ALLOWED');
});

test('A7 / A8 交换目录（网络那一步）：密钥不在 → WAITING_KEY_ABSENT、不连网；上次调用中途崩了 → 不再发、记 WAITING_STEP_CRASHED_MID_CALL；已答的不重答；请求体不对 → STOPPED_REQUEST_INVALID；密钥不落盘', async () => {
  const { config } = llm.loadConfig();
  const dir = tmp('qrp-llm-exchange-');
  const body = llm.buildRequest({ messages: promptOf().messages, config });
  const put = (key, b = body, kind = 'GENERATE') => llm.writeRequest(dir, { kind, key, round_id: kind === 'PING' ? null : 'MR-CN_A-2026-12-abc', body: b });
  put('MR-CN_A-2026-12-abc:C001');
  const t0 = mockTransport([{ status: 200, json: okJson('rank(pb)') }]);
  await step.answerPending({ dir, config, keyFile: '/nonexistent/key.env', transport: t0 });
  assert.equal(t0.calls.length, 0, 'no key: no network call');
  const r0 = llm.readResponse(dir, 'MR-CN_A-2026-12-abc:C001');
  assert.deepEqual([r0.outcome, r0.reason, r0.usage, r0.content], ['WAITING_KEY_ABSENT', 'FILE_ABSENT', null, null]);
  assert.equal(r0.request_sha256, sha(JSON.stringify(body)));
  // 已答的不重答
  const kf = keyFile();
  const t1 = mockTransport([{ status: 200, json: okJson('rank(pb)') }]);
  await step.answerPending({ dir, config, keyFile: kf, transport: t1 });
  assert.equal(t1.calls.length, 0);
  // 新请求：答一次
  put('MR-CN_A-2026-12-abc:C002');
  await step.answerPending({ dir, config, keyFile: kf, transport: t1 });
  assert.equal(t1.calls.length, 1);
  const r1 = llm.readResponse(dir, 'MR-CN_A-2026-12-abc:C002');
  assert.deepEqual([r1.outcome, r1.content, r1.model], ['OK', 'rank(pb)', 'deepseek-v4-pro']);
  assert.match(r1.response_sha256, /^[0-9a-f]{64}$/);
  // 调用中途崩了（inflight 标记还在、没有应答）：不再发
  put('MR-CN_A-2026-12-abc:C003');
  fs.writeFileSync(path.join(dir, `${llm.exchangeName('MR-CN_A-2026-12-abc:C003')}.inflight`), '{}');
  await step.answerPending({ dir, config, keyFile: kf, transport: t1 });
  assert.equal(t1.calls.length, 1, 'crashed mid-call: not sent again');
  assert.equal(llm.readResponse(dir, 'MR-CN_A-2026-12-abc:C003').outcome, 'WAITING_STEP_CRASHED_MID_CALL');
  // 请求体不对（交换目录里被改过）：不发
  put('MR-CN_A-2026-12-abc:C004', { ...body, tools: [] });
  await step.answerPending({ dir, config, keyFile: kf, transport: t1 });
  assert.equal(t1.calls.length, 1);
  assert.equal(llm.readResponse(dir, 'MR-CN_A-2026-12-abc:C004').outcome, 'STOPPED_REQUEST_INVALID');
  const f = path.join(dir, `${llm.exchangeName('MR-CN_A-2026-12-abc:C005')}.req.json`);
  put('MR-CN_A-2026-12-abc:C005');
  const req = JSON.parse(fs.readFileSync(f, 'utf8')); req.body.messages[1].content += ' tampered'; fs.writeFileSync(f, JSON.stringify(req));
  await step.answerPending({ dir, config, keyFile: kf, transport: t1 });
  assert.equal(t1.calls.length, 1);
  assert.equal(llm.readResponse(dir, 'MR-CN_A-2026-12-abc:C005').outcome, 'STOPPED_REQUEST_INVALID', 'request sha must match its body');
  noKeyIn([dir]);
});

test('A10 探活：一条不含公式的请求、结果写进交换目录；不开轮、不写台账、不计 N；命令行没有密钥 → 退出码 75、一次网络都不连', async () => {
  const { config } = llm.loadConfig();
  const ping = llm.pingRequest(config);
  assert.deepEqual(Object.keys(ping).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
  assert.equal(ping.max_tokens, config.request.max_tokens, 'the probe sends the production max_tokens, so a value the API refuses shows before a round is opened');
  const pt = ping.messages.map((m) => m.content).join('\n');
  for (const w of ['formula', 'DSL', 'rank', 'factor', '因子', '公式', ...SPACE.readings.map((r) => r.name)]) assert.ok(!pt.includes(w), `ping carries «${w}»`);
  const dir = tmp('qrp-llm-ping-');
  const before = walkFiles(dataRoot).length;
  const t = mockTransport([{ status: 200, json: okJson('OK', 'deepseek-v4-pro', { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 }) }]);
  const r = await step.ping({ dir, config, keyFile: keyFile(), transport: t, at: '2026-11-19T21:00:00+08:00' });
  assert.deepEqual([r.outcome, r.model_reported, r.served_version, r.usage.total_tokens], ['OK', 'deepseek-v4-pro', 'NOT_REPORTED', 13]);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].body, ping);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1); assert.match(files[0], /^ping-.*\.json$/);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.deepEqual([rec.schema, rec.outcome, rec.round_id, rec.formulas], ['MINING_LLM_PING_V1', 'OK', null, 0]);
  assert.equal(walkFiles(dataRoot).length, before, 'no ledger file written');
  const mm = await step.ping({ dir, config, keyFile: keyFile(), transport: mockTransport([{ status: 200, json: okJson('OK', 'deepseek-v4-pro-1201') }]), at: '2026-11-19T21:01:00+08:00' });
  assert.equal(mm.outcome, 'WAITING_MODEL_MISMATCH');
  noKeyIn([dir]);
  // 命令行：没有密钥 → 75，不连网（没有密钥就到不了 transport）
  const cliDir = tmp('qrp-llm-ping-cli-');
  const c = spawnSync(process.execPath, [path.join(ROOT, 'services/mining-llm-step/cli.js'), 'ping', '--exchange', cliDir, '--key-file', '/nonexistent/key.env'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(c.status, 75, c.stderr);
  const o = JSON.parse(c.stdout);
  assert.deepEqual([o.command, o.outcome, o.reason], ['ping', 'WAITING_KEY_ABSENT', 'FILE_ABSENT']);
  const u = spawnSync(process.execPath, [path.join(ROOT, 'services/mining-llm-step/cli.js'), 'ping', '--exchange', cliDir, '--bogus', 'x'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(u.status, 2); assert.equal(JSON.parse(u.stderr).error, 'MINE_LLM_STEP_OPTION_UNKNOWN');
});
