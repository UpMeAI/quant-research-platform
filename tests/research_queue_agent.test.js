'use strict';
/**
 * AUTONOMOUS_RESEARCH_QUEUE_V1 Q2：无工具代理运行时、闸口的客户端侧、旗舰质量闸与 pro 回落、队列接缝（AQ-10、11、13 的代理侧、21、34、36、48）。
 * 先红后绿；网关一律用假的（进程内桩或临时 unix socket 上的桩服务），不连 DeepSeek、不读任何密钥。
 *   AQ-34  代理的环境里没有 DEEPSEEK*、没有任何密钥形状的值（有就拒启）；代理只通过 unix socket 说话；源码里没有 child_process / net / https / dns / vm / eval / fetch；
 *   ★RQ15 (a)  请求体的键恰好是 model、messages、max_tokens、temperature、response_format、stream；没有 tools / functions / 联网 / 文件 / 网址；max_tokens ≤ 4000；temperature 0；
 *   AQ-48  flash 在同一任务上两次独立「尝试」（首答 + 允许的 1 次修订）都被验证器拒 → 恰好一次 deepseek-v4-pro（RQ_AGENT_PRO_FALLBACK，带质量闸记录）；pro 也失败 → BLOCKED_DETERMINISTIC + 补救；
 *   AQ-10  网关类别 → 队列状态：QUOTA → WAITING_QUOTA、CREDENTIAL → WAITING_CREDENTIAL（一次告警）、PROVIDER → 重试到第 6 次后 WAITING_PROVIDER、DETERMINISTIC → BLOCKED_DETERMINISTIC；
 *   AQ-21  结果、产物里没有 sk-… 形状的字串，也没有网关回显的密钥；
 *   AQ-23/36  脏包在发出任何调用之前拒；代理主机与任务的 market 对不上就拒。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

/** 异步跑子进程：同进程里的桩网关要能响应，不能用 spawnSync 堵住事件循环。 */
function runNode(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { env });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const F = require('./_rq_agent_fixture');
const V = require('../services/research-queue-agent');

const DIR = path.join(__dirname, '..', 'services', 'research-queue-agent');
const triageNone = () => ({ route: 'NORMAL_NO_PRIOR', cite_seal_sha256: [] });

const okResp = (obj, model = 'deepseek-flash') => ({ ok: true, status: 200, data: { model, choices: [{ message: { role: 'assistant', content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }], usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } } } });
const errResp = (rq_class, rq_code, status, extra = {}) => ({ ok: false, status, error: { rq_class, rq_code, message: 'x', retry_after_s: null, ...extra } });

function mockClient(script) {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(JSON.parse(JSON.stringify(req)));
      const r = script.shift();
      if (r === undefined) throw new Error('mock client: no more scripted responses');
      return typeof r === 'function' ? r(req) : r;
    },
  };
}

const cardTask = (over = {}) => ({ task_id: 'RQT-LINUX-20261122-aaaa1111', host: 'LINUX', agent_host: 'LINUX', kind: 'AI_REVIEW_CARD', market: 'CN_A', template_id: 'AI_REVIEW_CARD_V1', template_sha256: F.sha('tpl'), attempt_no: 1, ...over });
const checkTask = (over = {}) => ({ ...cardTask({ kind: 'AI_CHECK', template_id: 'AI_CHECK_V1' }), ...over });
const cardBundle = (over = {}) => ({ schema: 'RQ_AGENT_BUNDLE_V1', market: 'CN_A', week_id: '2026-W47', pack: F.makePack(), registry: F.makeRegistry(), ...over });
const checkBundle = (over = {}) => ({ schema: 'RQ_AGENT_BUNDLE_V1', market: 'CN_A', week_id: '2026-W47', pack: F.makePack(), ...over });
const opts = (client, over = {}) => ({ client, env: {}, host: 'LINUX', triage: triageNone, now: () => '2026-11-22T21:40:00+08:00', ...over });

/* ---------------------------------------------------------------- 请求体：无工具 */
test('tool-less: the request body keys are exactly the six plain-completion keys, max_tokens <= 4000, temperature 0, JSON mode, no tools of any kind', async () => {
  const client = mockClient([okResp(F.makeCard())]);
  const r = await V.runAgentTask(cardTask(), cardBundle(), opts(client));
  assert.equal(r.status, 'DONE');
  const req = client.calls[0];
  assert.deepEqual(Object.keys(req.body).sort(), ['max_tokens', 'messages', 'model', 'response_format', 'stream', 'temperature']);
  assert.equal(req.body.model, 'deepseek-flash');
  assert.equal(req.body.stream, false);
  assert.equal(req.body.temperature, 0);
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  assert.ok(Number.isInteger(req.body.max_tokens) && req.body.max_tokens <= 4000 && req.body.max_tokens > 0);
  assert.deepEqual(req.body.messages.map((m) => m.role), ['system', 'user']);
  for (const m of req.body.messages) assert.equal(typeof m.content, 'string');
  const text = JSON.stringify(req);
  for (const bad of ['"tools"', 'tool_choice', '"functions"', 'web_search', '"file"', 'image_url']) assert.equal(text.includes(bad), false, bad);
  assert.equal(req.purpose, 'RQ_AGENT');
  assert.equal(req.task_id, cardTask().task_id);
  assert.equal(req.admission_sha256, F.sha(V.prompts.CARD_SYSTEM_TEXT));
  assert.equal(req.body.messages[0].content, V.prompts.CARD_SYSTEM_TEXT);
});

test('tool-less: the user message is the bundle facts only (JSON); the registry view is in it for cards; nothing is fetched', async () => {
  const client = mockClient([okResp(F.makeCard())]);
  await V.runAgentTask(cardTask(), cardBundle(), opts(client));
  const user = JSON.parse(client.calls[0].body.messages[1].content);
  assert.deepEqual(Object.keys(user).sort(), ['facts', 'registry', 'repeated_pattern_counts', 'week_id', 'market'].sort());
  assert.equal(user.facts.length, 5);
});

test('AQ-34 static: runtime sources import no process, network, vm or worker builtins; fs only in cli.js and registries.js; http only in gateway-client.js over a socketPath', () => {
  const FORBIDDEN = ['child_process', 'net', 'tls', 'https', 'dns', 'dgram', 'vm', 'worker_threads', 'cluster', 'http2', 'readline', 'repl', 'inspector', 'os'];
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('cli.js') && files.includes('gateway-client.js') && files.includes('agent.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1].replace(/^node:/, ''));
    for (const m of reqs) {
      assert.equal(FORBIDDEN.includes(m), false, `${f} requires ${m}`);
      if (m === 'fs') assert.ok(['cli.js', 'registries.js'].includes(f), `${f} requires fs`);
      if (m === 'http') assert.equal(f, 'gateway-client.js');
    }
    assert.equal(/\beval\s*\(|new Function\s*\(|process\.binding|\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(src), false, `${f} has a dynamic or network call`);
  }
  const gc = fs.readFileSync(path.join(DIR, 'gateway-client.js'), 'utf8');
  assert.match(gc, /socketPath/);
  assert.equal(/https?:\/\//.test(gc.replace(/\/\/.*$/gm, '')), false, 'gateway-client has a URL literal');
});

test('AQ-34 agents keyless: a DEEPSEEK* variable, an API-key name, or a key-shaped value in the environment refuses to start (before any call)', async () => {
  for (const env of [{ DEEPSEEK_RESEARCH_API_KEY: 'x' }, { DEEPSEEK_REVIEW_API_KEY: '' }, { SOME_API_KEY: 'x' }, { FOO: 'sk-' + 'a'.repeat(30) }, { deepseek_base_url: 'x' }]) {
    const client = mockClient([okResp(F.makeCard())]);
    await assert.rejects(() => V.runAgentTask(cardTask(), cardBundle(), opts(client, { env })), /RQ_AGENT_ENV_HAS_KEY/);
    assert.equal(client.calls.length, 0);
  }
  const client = mockClient([okResp(F.makeCard())]);
  assert.equal((await V.runAgentTask(cardTask(), cardBundle(), opts(client, { env: { PATH: '/usr/bin', HOME: '/home/x', NODE_ENV: 'production' } }))).status, 'DONE');
});

/* ---------------------------------------------------------------- 流程：修订、质量闸、pro 回落 */
test('revision: an invalid first answer is re-asked once with the validator error codes only; the revision passes', async () => {
  const bad = F.makeCard({ factor_ideas: [] });                    // CARD_ZERO_IDEAS_NO_REASON
  const client = mockClient([okResp(bad), okResp(F.makeCard())]);
  const r = await V.runAgentTask(cardTask(), cardBundle(), opts(client));
  assert.equal(r.status, 'DONE');
  assert.equal(client.calls.length, 2);
  const msgs = client.calls[1].body.messages;
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(msgs[3].content, /CARD_ZERO_IDEAS_NO_REASON/);
  assert.equal(msgs[3].content.includes('F-001'), false, 'the re-ask carries codes, not facts');
  assert.equal(client.calls[1].purpose, 'RQ_AGENT');
  assert.deepEqual(r.calls.map((c) => [c.purpose, c.model, c.attempt, c.revision, c.validator_codes.length > 0]), [['RQ_AGENT', 'deepseek-flash', 1, 0, true], ['RQ_AGENT', 'deepseek-flash', 1, 1, false]]);
});

test('AQ-48 two failed flash attempts (first answer + 1 revision each) -> exactly one pro call with the quality-gate record; a valid pro answer completes', async () => {
  const bad = F.makeCard({ factor_ideas: [] });
  const records = [];
  const client = mockClient([okResp(bad), okResp(bad), okResp('{nope'), okResp(bad), okResp(F.makeCard(), 'deepseek-v4-pro')]);
  const r = await V.runAgentTask(cardTask(), cardBundle(), opts(client, { writeQualityRecord: (rec) => records.push(rec) }));
  assert.equal(r.status, 'DONE');
  assert.equal(client.calls.length, 5);
  assert.deepEqual(client.calls.slice(0, 4).map((c) => [c.purpose, c.body.model]), Array(4).fill(['RQ_AGENT', 'deepseek-flash']));
  const pro = client.calls[4];
  assert.equal(pro.purpose, 'RQ_AGENT_PRO_FALLBACK');
  assert.equal(pro.body.model, 'deepseek-v4-pro');
  assert.deepEqual(pro.body.messages.map((m) => m.role), ['system', 'user'], 'the pro attempt is a fresh single call');
  assert.equal(pro.quality_gate.schema, 'RQ_FLASH_QUALITY_GATE_RECORD_V1');
  assert.equal(pro.quality_gate.task_id, cardTask().task_id);
  assert.equal(pro.quality_gate.model, 'deepseek-flash');
  assert.deepEqual(pro.quality_gate.failures.map((f) => f.attempt_no), [1, 2]);
  for (const f of pro.quality_gate.failures) { assert.ok(f.validator_codes.length > 0); assert.match(f.output_sha256, /^[0-9a-f]{64}$/); }
  assert.match(pro.quality_gate.record_id, /^QG-[0-9a-f]{16}$/);
  assert.equal(r.quality_gate.record_id, pro.quality_gate.record_id);
  assert.equal(records.length, 1);
  assert.equal(r.outputs.factor_ideas[0].model, 'deepseek-v4-pro');
});

test('AQ-48 pro failing too -> BLOCKED_DETERMINISTIC with a remediation (prompt/template/validator), no second pro call; a check also reports CHECKER_DEFECT', async () => {
  const bad = { verdict: 'CONSISTENT', items: [], hold_reasons: [], unknowns: [] };
  const client = mockClient([okResp(bad), okResp(bad), okResp(bad), okResp(bad), okResp(bad, 'deepseek-v4-pro')]);
  const r = await V.runAgentTask(checkTask(), checkBundle(), opts(client));
  assert.equal(r.status, 'BLOCKED_DETERMINISTIC');
  assert.equal(r.reason_code, 'RQ_PRO_FALLBACK_FAILED');
  assert.equal(r.defect_code, 'CHECKER_DEFECT');
  assert.equal(r.remediation.kind, 'PROMPT_TEMPLATE_OR_VALIDATOR_FIX');
  assert.equal(client.calls.filter((c) => c.purpose === 'RQ_AGENT_PRO_FALLBACK').length, 1);
  const card = mockClient([okResp('x'), okResp('x'), okResp('x'), okResp('x'), okResp('x', 'deepseek-v4-pro')]);
  const rc = await V.runAgentTask(cardTask(), cardBundle(), opts(card));
  assert.equal(rc.status, 'BLOCKED_DETERMINISTIC');
  assert.equal(rc.defect_code, undefined);
});

test('AQ-48 the gateway refusing the pro call (no record accepted) is a deterministic block, never a second try', async () => {
  const bad = F.makeCard({ factor_ideas: [] });
  const client = mockClient([okResp(bad), okResp(bad), okResp(bad), okResp(bad), errResp('DETERMINISTIC', 'RQ_QUALITY_GATE_INVALID', 403)]);
  const r = await V.runAgentTask(cardTask(), cardBundle(), opts(client));
  assert.equal(r.status, 'BLOCKED_DETERMINISTIC');
  assert.equal(r.reason_code, 'RQ_QUALITY_GATE_INVALID');
  assert.equal(client.calls.length, 5);
});

test('AQ-48 a flash pass on the second attempt never calls pro; the kind never switches to pro by default', async () => {
  const bad = F.makeCard({ factor_ideas: [] });
  const client = mockClient([okResp(bad), okResp(bad), okResp(F.makeCard())]);
  const r = await V.runAgentTask(cardTask(), cardBundle(), opts(client));
  assert.equal(r.status, 'DONE');
  assert.equal(client.calls.some((c) => c.purpose === 'RQ_AGENT_PRO_FALLBACK'), false);
  assert.equal(client.calls[2].body.messages.length, 2, 'attempt 2 starts from a fresh first answer');
  assert.equal(r.outputs.factor_ideas[0].model, 'deepseek-flash');
});

/* ---------------------------------------------------------------- AQ-10 网关类别 -> 队列状态 */
test('AQ-10 gateway classes: 402 -> WAITING_QUOTA, 401 -> WAITING_CREDENTIAL with one alert, 5xx/429 -> RETRY with Retry-After, 400 -> BLOCKED_DETERMINISTIC, peak -> DEFER; none consume a quality attempt', async () => {
  const quota = await V.runAgentTask(cardTask(), cardBundle(), opts(mockClient([errResp('QUOTA', 'RQ_UPSTREAM_QUOTA', 402)])));
  assert.deepEqual([quota.status, quota.wait_state], ['WAITING', 'WAITING_QUOTA']);
  const cred = await V.runAgentTask(cardTask(), cardBundle(), opts(mockClient([errResp('CREDENTIAL', 'RQ_UPSTREAM_AUTH', 401)])));
  assert.deepEqual([cred.status, cred.wait_state, cred.alert], ['WAITING', 'WAITING_CREDENTIAL', 'RQ_CREDENTIAL']);
  const absent = await V.runAgentTask(cardTask(), cardBundle(), opts(mockClient([errResp('CREDENTIAL', 'RQ_CREDENTIAL_ABSENT', 503)])));
  assert.deepEqual([absent.status, absent.wait_state, absent.reason_code], ['WAITING', 'WAITING_CREDENTIAL', 'RQ_CREDENTIAL_ABSENT']);
  const rate = await V.runAgentTask(cardTask(), cardBundle(), opts(mockClient([errResp('PROVIDER', 'RQ_UPSTREAM_RATE', 429, { retry_after_s: 17 })])));
  assert.deepEqual([rate.status, rate.retry_after_s, rate.provider_error], ['RETRY', 17, true]);
  const fiveXx = await V.runAgentTask(cardTask(), cardBundle(), opts(mockClient([errResp('PROVIDER', 'RQ_UPSTREAM_5XX', 503)])));
  assert.equal(fiveXx.status, 'RETRY');
  const det = await V.runAgentTask(cardTask(), cardBundle(), opts(mockClient([errResp('DETERMINISTIC', 'RQ_UPSTREAM_INVALID', 422)])));
  assert.deepEqual([det.status, det.reason_code], ['BLOCKED_DETERMINISTIC', 'RQ_UPSTREAM_INVALID']);
  const peak = await V.runAgentTask(cardTask(), cardBundle(), opts(mockClient([errResp('DETERMINISTIC', 'RQ_PEAK_REFUSED', 403)])));
  assert.deepEqual([peak.status, peak.reason_code], ['DEFER', 'RQ_PEAK_REFUSED']);
  const mid = mockClient([okResp(F.makeCard({ factor_ideas: [] })), errResp('QUOTA', 'RQ_UPSTREAM_QUOTA', 402)]);
  const r = await V.runAgentTask(cardTask(), cardBundle(), opts(mid));
  assert.equal(r.status, 'WAITING');
  assert.equal(mid.calls.some((c) => c.purpose === 'RQ_AGENT_PRO_FALLBACK'), false);
});

test('AQ-10 queue seam: 6 provider tries then WAITING_PROVIDER, one credential alert, quota waits; never FAILED', () => {
  const S = V.queueSeam;
  const retry = { status: 'RETRY', provider_error: true, retry_after_s: null, reason_code: 'RQ_UPSTREAM_5XX' };
  const seq = [1, 2, 3, 4, 5].map((n) => S.transitionFor(retry, { provider_tries: n }));
  for (const t of seq) assert.deepEqual([t.to_state, t.not_before_s > 0], ['READY', true]);
  assert.ok(seq.every((t, i) => i === 0 || t.not_before_s >= seq[i - 1].not_before_s));
  assert.ok(seq[4].not_before_s <= 3600);
  assert.equal(S.transitionFor(retry, { provider_tries: 6 }).to_state, 'WAITING_PROVIDER');
  assert.equal(S.transitionFor({ ...retry, retry_after_s: 120 }, { provider_tries: 1 }).not_before_s, 120);
  const c = S.transitionFor({ status: 'WAITING', wait_state: 'WAITING_CREDENTIAL', alert: 'RQ_CREDENTIAL', reason_code: 'RQ_UPSTREAM_AUTH' }, {});
  assert.deepEqual([c.to_state, c.alert], ['WAITING_CREDENTIAL', 'RQ_CREDENTIAL']);
  assert.equal(S.transitionFor({ status: 'WAITING', wait_state: 'WAITING_QUOTA' }, {}).to_state, 'WAITING_QUOTA');
  assert.equal(S.transitionFor({ status: 'BLOCKED_DETERMINISTIC', reason_code: 'X' }, {}).to_state, 'BLOCKED_DETERMINISTIC');
  assert.equal(S.transitionFor({ status: 'DONE' }, {}).to_state, 'EVIDENCE_WRITTEN');
  for (const r of [{ status: 'RETRY', provider_error: true }, { status: 'WAITING', wait_state: 'WAITING_QUOTA' }, { status: 'DEFER' }, { status: 'BLOCKED_DETERMINISTIC' }]) {
    assert.notEqual(S.transitionFor(r, { provider_tries: 9 }).to_state, 'FAILED');
  }
  assert.throws(() => S.transitionFor({ status: 'WAT' }, {}), /RQ_SEAM_RESULT_INVALID/);
});

test('queue seam: the task row is the section 3.2 subset; market and agent_host must agree (AQ-36); only AI_REVIEW_CARD and AI_CHECK run here; AI_PREREG is Q3', () => {
  const S = V.queueSeam;
  assert.equal(S.parseAgentTask(cardTask()).task_id, cardTask().task_id);
  assert.throws(() => S.parseAgentTask({ ...cardTask(), market: 'US_EQUITY' }), /RQ_AGENT_HOST_MISMATCH/);
  assert.throws(() => S.parseAgentTask({ ...cardTask(), market: 'NONE' }), /RQ_AGENT_MARKET_INVALID/);
  assert.throws(() => S.parseAgentTask({ ...cardTask(), kind: 'AI_PREREG' }), /RQ_AGENT_KIND_UNSUPPORTED/);
  assert.throws(() => S.parseAgentTask({ ...cardTask(), kind: 'K2_RUN' }), /RQ_AGENT_KIND_UNSUPPORTED/);
  assert.throws(() => S.parseAgentTask({ ...cardTask(), task_id: 'x' }), /RQ_SEAM_TASK_INVALID/);
  const us = S.parseAgentTask({ ...cardTask(), market: 'US_EQUITY', host: 'LINUX', agent_host: 'HK' });
  assert.equal(us.agent_host, 'HK');
});

test('AQ-36 the agent refuses to run on the wrong host: CN_A on HK, US_EQUITY on Linux', async () => {
  const client = mockClient([okResp(F.makeCard())]);
  await assert.rejects(() => V.runAgentTask(cardTask(), cardBundle(), opts(client, { host: 'HK' })), /RQ_AGENT_HOST_MISMATCH/);
  const us = checkTask({ market: 'US_EQUITY', agent_host: 'HK' });
  await assert.rejects(() => V.runAgentTask(us, checkBundle({ market: 'US_EQUITY', pack: F.makePack({ market: 'US_EQUITY' }) }), opts(client, { host: 'LINUX' })), /RQ_AGENT_HOST_MISMATCH/);
  assert.equal(client.calls.length, 0);
});

test('AQ-23 a pack behind the provenance firewall is refused before any call', async () => {
  const pack = F.makePack();
  pack.facts[0].source.path = 'qrp/var/mining/out/r1/x.json';
  const client = mockClient([okResp(F.makeCard())]);
  const r = await V.runAgentTask(cardTask(), cardBundle({ pack }), opts(client));
  assert.deepEqual([r.status, r.reason_code], ['BLOCKED_DETERMINISTIC', 'PACK_FIREWALL_SOURCE']);
  assert.equal(client.calls.length, 0);
});

/* ---------------------------------------------------------------- 产物 */
test('card task outputs: card, idea records with code fields, routes, proposals, and the P0 metric', async () => {
  const nu = F.goodIdea({ mechanism: { NEW: { proposed_id: 'SEL.LIQUIDITY.AMIHUD_TILT', title_zh: '流动性冲击', description_zh: '成交额骤降后的个股后续表现', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } } });
  const lib = F.goodIdea({ readings: ['CN_A.MOM.RS60_MARKET_PCT', 'CN_A.VOL.REALIZED_20'] });
  const card = F.makeCard({ factor_ideas: [F.goodIdea(), nu, lib] });
  const r = await V.runAgentTask(cardTask(), cardBundle(), opts(mockClient([okResp(card)])));
  assert.equal(r.status, 'DONE');
  assert.equal(r.outputs.card.schema, 'REVIEW_AI_CARD_V1');
  assert.match(r.outputs.card_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.outputs.factor_ideas.map((i) => i.idea_id), ['FI-CN_A-2026-W47-1', 'FI-CN_A-2026-W47-2', 'FI-CN_A-2026-W47-3']);
  for (const i of r.outputs.factor_ideas) { assert.equal(i.card_sha256, r.outputs.card_sha256); assert.equal(i.prompt_admission_sha256, F.sha(V.prompts.CARD_SYSTEM_TEXT)); }
  assert.deepEqual(r.outputs.idea_routes.map((x) => x.state), ['GENERATOR_VIEW_PENDING', 'WAITING_MECHANISM_ADMISSION', 'PREREG_PROPOSED']);
  assert.deepEqual(r.outputs.proposals.map((p) => p.schema), ['MECHANISM_PROPOSAL_V1', 'AI_PREREG_PROPOSAL_V1']);
  assert.equal(r.outputs.proposals[0].state, 'WAITING_EXTERNAL:MECHANISM_ADMISSION');
  assert.deepEqual(r.outputs.metrics, { market: 'CN_A', week_id: '2026-W47', ideas: 3, no_idea_reason_cited: false, routes: { GENERATOR_VIEW_PENDING: 1, WAITING_MECHANISM_ADMISSION: 1, PREREG_PROPOSED: 1 } });
});

test('card task: zero ideas with a cited reason is recorded in the metric', async () => {
  const card = F.makeCard({ factor_ideas: [], no_idea_reason: { text_zh: '本周没有触及选股或择时的发现', fact_ids: ['F-001'] } });
  const r = await V.runAgentTask(cardTask(), cardBundle(), opts(mockClient([okResp(card)])));
  assert.equal(r.status, 'DONE');
  assert.deepEqual(r.outputs.factor_ideas, []);
  assert.equal(r.outputs.metrics.no_idea_reason_cited, true);
});

test('check task output: RQ_CHECK_REPORT_V1 with schema, task id, admission and model; the report never changes a task state (no state field)', async () => {
  const r = await V.runAgentTask(checkTask(), checkBundle(), opts(mockClient([okResp(F.makeCheckReport())])));
  assert.equal(r.status, 'DONE');
  const rep = r.outputs.check_report;
  assert.equal(rep.schema, 'RQ_CHECK_REPORT_V1');
  assert.equal(rep.task_id, checkTask().task_id);
  assert.equal(rep.prompt_admission_sha256, F.sha(V.prompts.CHECK_SYSTEM_TEXT));
  assert.equal(rep.model, 'deepseek-flash');
  assert.equal(rep.verdict, 'CONSISTENT');
  assert.equal('state' in rep || 'task_state' in rep || 'promote' in rep, false);
  assert.equal(r.outputs.card, undefined);
});

test('check task: a pack over the per-call token budget is split by matrix row, one call per part, and merged (HOLD if any part holds)', async () => {
  const part1 = { verdict: 'CONSISTENT', items: [{ req_id: 'R1', status: 'COVERED', fact_ids: ['F-001'], note_zh: '有记录' }], hold_reasons: [], unknowns: [] };
  const part2 = { verdict: 'HOLD', items: [{ req_id: 'R2', status: 'GAP', fact_ids: [], note_zh: '缺少样本记录' }], hold_reasons: [{ code: 'HOLD_MISSING_EVIDENCE', req_id: 'R2', fact_ids: [], remediation_zh: '补样本量记录' }], unknowns: ['样本量'] };
  const client = mockClient([okResp(part1), okResp(part2)]);
  const r = await V.runAgentTask(checkTask(), checkBundle(), opts(client, { maxPackTokens: 100 }));
  assert.equal(r.status, 'DONE');
  assert.equal(client.calls.length, 2);
  assert.equal(r.outputs.check_report.verdict, 'HOLD');
  assert.deepEqual(r.outputs.check_report.items.map((i) => i.req_id), ['R1', 'R2']);
  assert.equal(r.outputs.check_report.hold_reasons.length, 1);
  assert.deepEqual(r.outputs.check_report.unknowns, ['样本量']);
});

test('AQ-48 only one pro call per task even when a split check has two failing parts: the second part is blocked, never given a second pro', async () => {
  const bad = { verdict: 'CONSISTENT', items: [], hold_reasons: [], unknowns: [] };
  const good1 = { verdict: 'CONSISTENT', items: [{ req_id: 'R1', status: 'COVERED', fact_ids: ['F-001'], note_zh: '有记录' }], hold_reasons: [], unknowns: [] };
  const client = mockClient([okResp(bad), okResp(bad), okResp(bad), okResp(bad), okResp(good1, 'deepseek-v4-pro'), okResp(bad), okResp(bad), okResp(bad), okResp(bad)]);
  const r = await V.runAgentTask(checkTask(), checkBundle(), opts(client, { maxPackTokens: 100 }));
  assert.deepEqual([r.status, r.reason_code], ['BLOCKED_DETERMINISTIC', 'RQ_PRO_ALREADY_USED']);
  assert.equal(client.calls.filter((c) => c.purpose === 'RQ_AGENT_PRO_FALLBACK').length, 1);
  assert.equal(client.calls.length, 9);
});

test('check task: a pack with an author row equal to the checker admission is refused before any call (AQ-44)', async () => {
  const author = { kind: 'AI_PREREG', prompt_admission_sha256: F.sha(V.prompts.CHECK_SYSTEM_TEXT), model: 'deepseek-flash' };
  const client = mockClient([okResp(F.makeCheckReport())]);
  const r = await V.runAgentTask(checkTask(), checkBundle({ pack: F.makePack({ author }) }), opts(client));
  assert.deepEqual([r.status, r.reason_code], ['BLOCKED_DETERMINISTIC', 'PACK_AUTHOR_IS_CHECKER']);
  assert.equal(client.calls.length, 0);
});

test('kinds outside Q2 are blocked, not attempted', async () => {
  const client = mockClient([]);
  await assert.rejects(() => V.runAgentTask(cardTask({ kind: 'AI_PREREG' }), cardBundle(), opts(client)), /RQ_AGENT_KIND_UNSUPPORTED/);
});

/* ---------------------------------------------------------------- AQ-21 */
test('AQ-21 results carry no raw provider text: a gateway error message that contains a key-shaped string never reaches the result', async () => {
  const leak = 'sk-' + 'Q'.repeat(40);
  const r = await V.runAgentTask(cardTask(), cardBundle(), opts(mockClient([errResp('DETERMINISTIC', 'RQ_UPSTREAM_INVALID', 400, { message: `bad ${leak}` })])));
  assert.equal(JSON.stringify(r).includes(leak), false);
  assert.equal(/sk-[A-Za-z0-9]{16,}/.test(JSON.stringify(r)), false);
  const echoed = okResp(F.makeCard({ supporting: [{ text_zh: `见 ${leak}`, fact_ids: ['F-001'] }] }));
  const echoedClient = mockClient([echoed, okResp(F.makeCard())]);
  const r2 = await V.runAgentTask(cardTask(), cardBundle(), opts(echoedClient));
  assert.equal(/sk-[A-Za-z0-9]{16,}/.test(JSON.stringify(r2)), false);
  assert.equal(echoedClient.calls.length, 2, 'a key-shaped answer is rejected by the validator and re-asked');
  assert.ok(r2.calls[0].validator_codes.includes('CARD_SECRET_SHAPED'));
});

/* ---------------------------------------------------------------- 网关客户端（真 unix socket） */
function withSocketServer(handler, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-agent-test-'));
  const sock = path.join(dir, 'gw.sock');
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { const body = Buffer.concat(chunks).toString(); seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, body); });
  });
  return new Promise((resolve, reject) => srv.listen(sock, async () => {
    try { resolve(await fn({ sock, seen, dir })); } catch (e) { reject(e); } finally { srv.close(); }
  }));
}

test('gateway client: posts to /chat/completions over the unix socket with the X-RQ headers, maps upstream errors to classes, never retries', async () => {
  await withSocketServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-rq-task-id'] === 'RQT-LINUX-20261122-bbbb2222') { res.statusCode = 429; res.setHeader('retry-after', '9'); res.end(JSON.stringify({ error: { rq_code: 'RQ_UPSTREAM_RATE', rq_class: 'PROVIDER', message: 'slow', retry_after_s: 9 } })); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: {} }));
  }, async ({ sock, seen }) => {
    const c = V.createGatewayClient({ socketPath: sock });
    const ok = await c.chat({ purpose: 'RQ_AGENT', task_id: 'RQT-LINUX-20261122-aaaa1111', admission_sha256: 'a'.repeat(64), body: { model: 'deepseek-flash', messages: [] } });
    assert.equal(ok.ok, true);
    assert.equal(seen[0].url, '/chat/completions');
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].headers['x-rq-purpose'], 'RQ_AGENT');
    assert.equal(seen[0].headers['x-rq-prompt-admission'], 'a'.repeat(64));
    assert.equal(seen[0].headers.authorization, undefined);
    const rate = await c.chat({ purpose: 'RQ_AGENT', task_id: 'RQT-LINUX-20261122-bbbb2222', admission_sha256: 'a'.repeat(64), body: {} });
    assert.deepEqual([rate.ok, rate.error.rq_class, rate.error.retry_after_s], [false, 'PROVIDER', 9]);
    assert.equal(seen.length, 2);
    const pro = await c.chat({ purpose: 'RQ_AGENT_PRO_FALLBACK', task_id: 'RQT-LINUX-20261122-aaaa1111', admission_sha256: 'a'.repeat(64), body: {},
      quality_gate: { record_id: 'QG-0123456789abcdef', task_id: 'x' } });
    assert.equal(seen[2].headers['x-rq-quality-gate-id'], 'QG-0123456789abcdef');
    assert.deepEqual(JSON.parse(Buffer.from(seen[2].headers['x-rq-quality-gate-record'], 'base64url').toString()), { record_id: 'QG-0123456789abcdef', task_id: 'x' });
    assert.equal(pro.ok, true);
  });
  const down = V.createGatewayClient({ socketPath: path.join(os.tmpdir(), 'rq-no-such.sock') });
  const r = await down.chat({ purpose: 'RQ_AGENT', task_id: 'RQT-LINUX-20261122-aaaa1111', admission_sha256: 'a'.repeat(64), body: {} });
  assert.deepEqual([r.ok, r.error.rq_class, r.error.rq_code], [false, 'PROVIDER', 'RQ_GATEWAY_UNREACHABLE']);
  assert.throws(() => V.createGatewayClient({ socketPath: 'http://api.deepseek.com' }), /RQ_GATEWAY_SOCKET_INVALID/);
  assert.throws(() => V.createGatewayClient({}), /RQ_GATEWAY_SOCKET_INVALID/);
});

/* ---------------------------------------------------------------- CLI 端到端（假网关在 unix socket 上）+ AQ-21 扫描 */
test('CLI end to end: reads the task and bundle files, talks to a stub gateway on a unix socket, writes result/card/ideas/routes/proposals; no key-shaped string anywhere (AQ-21)', async () => {
  const fakeKey = 'sk-' + 'Z9y8X7w6V5u4'.repeat(3);
  await withSocketServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: JSON.stringify(F.makeCard({ factor_ideas: [F.goodIdea(), F.goodIdea({ mechanism: { NEW: { proposed_id: 'SEL.LIQUIDITY.AMIHUD_TILT', title_zh: '流动性冲击', description_zh: '成交额骤降后的个股后续表现', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } } })] })) } }], usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1, completion_tokens: 1 } }));
  }, async ({ sock, dir }) => {
    const inDir = path.join(dir, 'in');
    const out = path.join(dir, 'out');
    fs.mkdirSync(inDir);
    fs.writeFileSync(path.join(inDir, 'task.json'), JSON.stringify(cardTask()));
    fs.writeFileSync(path.join(inDir, 'bundle.json'), JSON.stringify(cardBundle()));
    const cli = path.join(DIR, 'cli.js');
    const env = { PATH: process.env.PATH, HOME: dir };
    const run = (extra = [], e = env) => runNode([cli, '--task', path.join(inDir, 'task.json'), '--bundle', path.join(inDir, 'bundle.json'), '--out', out, '--socket', sock, '--host', 'LINUX', ...extra], e);
    const keyed = await run([], { ...env, DEEPSEEK_RESEARCH_API_KEY: fakeKey });
    assert.equal(keyed.status, 3, 'refused at start, before any file is read');
    assert.match(keyed.stderr, /RQ_AGENT_ENV_HAS_KEY/);
    assert.equal(keyed.stderr.includes(fakeKey), false);
    assert.equal(fs.existsSync(out), false, 'a refused start writes nothing');
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    const names = fs.readdirSync(out).sort();
    assert.deepEqual(names, ['access_log.jsonl', 'card.json', 'factor_ideas.jsonl', 'idea_routes.jsonl', 'proposals.jsonl', 'result.json']); // W24: the generator launcher's access log sits next to the result
    const result = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'));
    assert.equal(result.schema, 'RQ_AGENT_RESULT_V1');
    assert.equal(result.status, 'DONE');
    assert.equal(fs.readFileSync(path.join(out, 'factor_ideas.jsonl'), 'utf8').trim().split('\n').length, 2);
    for (const n of names) {
      const t = fs.readFileSync(path.join(out, n), 'utf8');
      assert.equal(/sk-[A-Za-z0-9]{16,}/.test(t), false, n);
      assert.equal(t.includes(fakeKey), false, n);
    }
    assert.equal(/sk-[A-Za-z0-9]{16,}/.test(r.stdout + r.stderr), false);
    const noSock = await runNode([cli, '--task', path.join(inDir, 'task.json'), '--bundle', path.join(inDir, 'bundle.json'), '--out', path.join(dir, 'out2')], env);
    assert.notEqual(noSock.status, 0);
    assert.match(noSock.stderr, /RQ_CLI_USAGE/);
  });
});

/* ---------------------------------------------------------------- 部署静态检查（AQ-33 / AQ-34 的代码侧） */
const DEPLOY = path.join(__dirname, '..', 'deploy', 'research-queue-ai');
test('AQ-33/34 static: only the gateway units carry an EnvironmentFile; agent units and the agent launcher have none, no DEEPSEEK*, and no network', () => {
  const gw = ['linux/rq-deepseek-gateway.service', 'hk/rq-deepseek-gateway.service'];
  const agents = ['hk/rq-agent.service'];
  const read = (f) => fs.readFileSync(path.join(DEPLOY, f), 'utf8');
  assert.equal(/EnvironmentFile/.test(read('linux/rq-deepseek-gateway.service')), false, 'Linux gateway reads the key file itself (re-read per call), no env copy');
  assert.equal(/DEEPSEEK/.test(read('linux/rq-deepseek-gateway.service')), false);
  assert.match(read('hk/rq-deepseek-gateway.service'), /EnvironmentFile=-\/root\/\.config\/research-queue\/deepseek-review\.env/);
  assert.match(read('hk/rq-deepseek-gateway.service'), /User=rq-gw/);
  assert.match(read('linux/rq-deepseek-gateway.service'), /rq-gw\.sock/);
  for (const f of gw) { assert.match(read(f), /^ExecStart=.*rq_gateway\.py serve/m); assert.match(read(f), /--key-id (LINUX_RESEARCH|HK_REVIEW)/); }
  for (const f of agents) {
    const t = read(f);
    assert.equal(/EnvironmentFile/.test(t), false, f);
    assert.equal(/DEEPSEEK/.test(t), false, f);
    assert.match(t, /IPAddressDeny=any/);
    assert.match(t, /RestrictAddressFamilies=AF_UNIX/);
    assert.match(t, /User=rq-agent/);
  }
  const run = read('linux/run-agent.sh');
  for (const flag of ['--network none', '--read-only', '--cap-drop ALL', 'no-new-privileges', '--user 0:0', '--memory 512m', '--cpus 0.5', '/run/rq-gw.sock']) assert.ok(run.includes(flag), flag);
  assert.match(run, /rootless daemon, container uid 0 maps to the unprivileged host user/);
  assert.equal(/DEEPSEEK|--env-file|\s-e\s/.test(run), false, 'the agent container gets no environment');
  const all = fs.readdirSync(path.join(DEPLOY, 'linux')).concat(fs.readdirSync(path.join(DEPLOY, 'hk'))).length;
  assert.ok(all >= 4);
});

test('config: the shipped prompt admissions and the gateway config agree with the agent code (models, purposes, ceilings)', () => {
  const cfg = require('../config/rq_deepseek_gateway.v1.json');
  assert.deepEqual(V.agent.MODELS, { FLASH: cfg.purposes.RQ_AGENT.models[0], PRO: cfg.purposes.RQ_AGENT_PRO_FALLBACK.models[0] });
  assert.equal(V.agent.MAX_TOKENS, cfg.purposes.RQ_AGENT.max_tokens);
  const adm = require('../config/research_queue_prompt_admissions.v1.json');
  assert.equal(adm.entries.length, 5, 'AI_CHECK, AI_REVIEW_CARD, AI_PREREG, and two #149 mechanism prompts');
  assert.deepEqual(adm.entries.filter((e) => ['AI_MECH_NOTE', 'AI_MECH_REVIEW'].includes(e.kind)).map((e) => e.state), ['PENDING_ADMISSION', 'PENDING_ADMISSION']);
  for (const e of cfg.admissions || []) assert.fail('admissions live in their own file');
  assert.equal(cfg.prompt_admissions_file, 'research_queue_prompt_admissions.v1.json');
});
