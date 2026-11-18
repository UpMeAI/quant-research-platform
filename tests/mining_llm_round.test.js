'use strict';
/**
 * RF1116 P2：大模型生成方经执行器跑一轮（合成数据 + 假的 DeepSeek：tests/fixtures/mining-llm/fake-step.js 在子进程里跑真的网络那一步，transport 是假的）。
 * 冻结的验收（续 mining_llm_generator.test.js 的 A1–A10）：
 *   B1 开轮：模型、知识截止日（= 发布日）、配置的 sha、钉住的版本、本轮的 token 上限都从配置写进轮次清单（预登记）；调用方另给模型 → MINE_RUNNER_LLM_MODEL_NOT_PINNED；
 *      GP 轮的清单不变（没有 llm 块）；开轮到生成之间配置变了 → MINE_RUNNER_LLM_CONFIG_CHANGED（失败即关，不是等待）。
 *   B2 校验与计数：每行都过 DSL 解析；解析不过的 PARSE_REFUSED、已试过的 DEDUPED，都记试验台账、都计入 N 和每轮 200；每次只要「剩下的上限」那么多；到上限停、不补。
 *   B3 反馈只有挖掘段分数：后一次调用的提示词带前几批的挖掘段分数与已试公式；验证折选择（selection.json）、留出段的任何东西都不进提示词；交换目录的请求只有固定几个键。
 *   B4 计量：每次调用一行 MINING_LLM_CALL_V1（用量、计入的 token、模型名、版本、请求 sha）；发之前「已用 + 这次的上界」超过本轮上限 → STOPPED_TOKEN_CAP，不发；调用次数上限 → STOPPED_CALL_CAP。
 *   B5 等待态：密钥不在、额度 / 限流、模型对不上 → 记一行（原始错误照留）、本轮留在 OPEN、不选择、不重试；续跑（--resume）从下一个尝试接着来；N 只算真的尝试。
 *   B6 命令行：开新轮之前先探活；网络那一步不答、没有密钥 → 退出码 75，一轮都不开、N 不变；探活过了才开轮、生成、选择（退出码 0）；续跑的生成方式要和轮次一致。
 *   B7 密钥从不出现在输出目录、台账、交换目录或命令行输出里。
 */
const { dataRoot } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const AUTH = 'TEST_LLM_ROUND_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const { makeMiningDataFixture } = require('./_mining_data_fixture');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const rounds = require('../services/mining-rounds');
const trials = require('../services/trial-ledger');
const llm = require('../services/mining-sandbox/llm');
const segs = require('../services/mining-sandbox/segments');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'services/mining-sandbox/round-runner/cli.js');
const FAKE_STEP = path.join(__dirname, 'fixtures/mining-llm/fake-step.js');
const FAKE_KEY = 'sk-fake-research-key-1111-DO-NOT-USE-b2c4d6';
const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-llm-round-fx-')));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.code || e.message, re); return true; };
const HOLDOUT_SUMS_SHA = sha(fs.readFileSync(path.join(fx.dirs.holdout, 'SHA256SUMS')));
const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-llm-round-data-')); process.env.QRP_DATA_DIR = d; return d; };
const roundTrials = (id) => [...trials.heads().values()].filter((t) => t.role === 'MINED_CANDIDATE' && t.mining && t.mining.round_id === id);
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const runDirOf = (out, id) => path.join(out, 'rounds', id.replace(/[^A-Za-z0-9_-]/g, '_'));
const COV = Object.freeze({ min_names_per_day: 5 });
const LLM_OPTS = Object.freeze({ pollMs: 10, waitPolls: 3000 });
const walkFiles = (d, out = []) => { if (!fs.existsSync(d)) return out; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkFiles(p, out); else out.push(p); } return out; };
const noKeyIn = (dirs, extra = []) => {
  for (const d of dirs) for (const f of walkFiles(d)) assert.ok(!fs.readFileSync(f).includes(FAKE_KEY), `key leaked into ${f}`);
  for (const s of extra) assert.ok(!String(s).includes(FAKE_KEY), 'key leaked into output');
};
const keyFile = () => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-llm-key-')), 'deepseek-research.env'); fs.writeFileSync(f, `DEEPSEEK_RESEARCH_API_KEY=${FAKE_KEY}\n`); fs.chmodSync(f, 0o600); return f; };
const promptText = (body) => body.messages.map((m) => m.content).join('\n');

/** 起一个假的网络那一步（子进程）。 */
function startStep(out, responses, { key = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-llm-step-'));
  const scenario = path.join(d, 'scenario.json'); fs.writeFileSync(scenario, JSON.stringify({ responses }));
  const calls = path.join(d, 'calls.jsonl'); const err = path.join(d, 'stderr.log');
  const child = spawn(process.execPath, [FAKE_STEP, path.join(out, 'llm-exchange'), scenario, calls, key ? keyFile() : '/nonexistent/deepseek-research.env'],
    { stdio: ['ignore', 'ignore', fs.openSync(err, 'w')] });
  return { child, calls: () => lines(calls), stderr: () => fs.readFileSync(err, 'utf8'), stop: () => new Promise((res) => { if (child.exitCode !== null) res(); else { child.on('exit', res); child.kill('SIGTERM'); } }) };
}
const C1 = ['rank(pb)', 'zscore((-ret_1d))', 'nope(close_hfq)', 'rank(close)', 'Here are ten formulas:', 'rank( pb )', 'rank((-ts_mean(ret_1d,5)))', 'zscore(turnover_f)',
  'rank(ts_delta(close_hfq,1))', 'rank(dv_ttm)', 'rank(ps_ttm)'];
const C2 = ['rank(pe_ttm)', 'rank(ps_ttm)', 'zscore(amount)', 'rank(ts_std(ret_1d,20))', 'rank(circ_mv)', 'rank((-total_mv))', 'zscore(ts_mean(turnover_f,5))', 'rank(abs(ret_1d))',
  'rank(ts_rank(close_hfq,20))', 'zscore(log(amount))'];
const C3 = ['rank(ts_corr(close_hfq,amount,20))', 'rank(sign(ret_1d))', 'rank(ts_mean(ret_1d,60))', 'zscore(pb)', 'zscore(dv_ttm)'];
const openLlm = (o = {}) => {
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_LLM' }, openedAt: '2026-12-01T02:00:00Z', coverageFloor: COV, ...o });
  runner.sealHoldout({ roundId: r.round_id, dataRef: 'synthetic:holdout', dataSha256: HOLDOUT_SUMS_SHA });
  return r;
};
const gen = (out, roundId, o = {}) => runner.generate({ roundId, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV, llm: LLM_OPTS, ...o });

test('B1 开轮：模型与上限从配置写进清单；调用方不能换模型；GP 轮清单不变；开轮后配置变了 → MINE_RUNNER_LLM_CONFIG_CHANGED', () => {
  freshData();
  const { config, sha256 } = llm.loadConfig();
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_LLM' }, openedAt: '2026-12-01T02:00:00Z', coverageFloor: COV });
  const g = r.generator;
  assert.deepEqual([g.mode, g.model, g.model_knowledge_cutoff, g.gp_seed], ['AI_MINED_LLM', 'deepseek-v4-pro', '2026-08-13', null]);
  assert.deepEqual(g.llm, { config_path: 'config/mining_llm_generator.v1.json', config_sha256: sha256, provider: 'DEEPSEEK', served_version: 'DeepSeek-V4-Pro-0813',
    release_date: '2026-08-13', tokens_per_round: config.limits.tokens_per_round, calls_per_round: config.limits.calls_per_round,
    formulas_per_call: config.batch.formulas_per_call, max_tokens: config.request.max_tokens });
  assert.equal(r.cap, 200);
  assert.ok(r.holdout.from > g.model_knowledge_cutoff);
  for (const m of [{ model: 'deepseek-flash', model_knowledge_cutoff: '2026-10-17' }, { model: 'deepseek-v4-pro', model_knowledge_cutoff: '2026-09-30' }]) {
    assert.throws(() => runner.requestRound({ generator: { mode: 'AI_MINED_LLM', ...m }, openedAt: '2026-12-02T02:00:00Z' }), code(/MINE_RUNNER_LLM_MODEL_NOT_PINNED/));
  }
  freshData();
  const gp = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, openedAt: '2026-12-01T02:00:00Z' });
  assert.deepEqual(Object.keys(gp.generator).sort(), ['gp_seed', 'mode', 'model', 'model_knowledge_cutoff'], 'GP manifest unchanged');
  // 开轮之后配置变了（换了版本、改了上限）：生成拒绝，不进等待
  const out = freshData();
  const r2 = openLlm();
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/mining_llm_generator.v1.json'), 'utf8'));
  raw.limits.tokens_per_round += 1;
  assert.throws(() => runner.internals.withLlmConfig(Buffer.from(JSON.stringify(raw)), () => gen(out, r2.round_id)), code(/MINE_RUNNER_LLM_CONFIG_CHANGED/));
  assert.equal(roundTrials(r2.round_id).length, 0);
});

test('B2 / B3 / B4 / B7 一轮（上限 24）：每行过 DSL；拒的、重的都计入 N；每次只要剩下的；反馈只有挖掘段分数；每次调用计量；密钥不落盘', async () => {
  const out = freshData();
  const r = openLlm({ cap: 24 });
  const s = startStep(out, [{ content: C1 }, { content: C2 }, { content: C3 }]);
  let g;
  try { g = gen(out, r.round_id); } finally { await s.stop(); }
  assert.equal(g.total, 24);
  assert.deepEqual([g.status, g.llm.state, g.llm.halted], ['CAP_REACHED', null, false]);
  assert.equal(g.attempts.scored + g.attempts.unscorable + g.attempts.parse_refused + g.attempts.deduped, 24);
  assert.deepEqual([g.attempts.parse_refused, g.attempts.deduped], [3, 1], 'refused: nope(), an unregistered reading, chatter; deduped: rank( pb ). Overflow lines (call 1 rank(ps_ttm), call 3 zscore(dv_ttm)) are not attempts');
  const rows = roundTrials(r.round_id);
  assert.equal(rows.length, 24);
  assert.equal(rounds.familyN('CN_A', 5), 24, 'every attempt counts in N');
  const by = (a) => rows.filter((t) => (t.rule_config.attempt || 'SCORED') === a).map((t) => t.rule_config.formula).sort();
  assert.deepEqual(by('PARSE_REFUSED'), ['Here are ten formulas:', 'nope(close_hfq)', 'rank(close)'].sort());
  assert.ok(rows.every((t) => t.mining.generator === 'AI_MINED_LLM'));
  // 网络那一步看到的：三次，每次只是普通补全、模型钉住；第三次只要剩下的 4 个
  const calls = s.calls();
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.deepEqual(Object.keys(c.body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
    assert.deepEqual([c.body.model, c.body.stream, c.auth_ok, c.url], ['deepseek-v4-pro', false, true, 'https://api.deepseek.com/chat/completions']);
    const t = promptText(c.body);
    for (const d of [segs.SEGMENTS.VALIDATION.from, segs.SEGMENTS.VALIDATION.to, segs.SEGMENTS.HOLDOUT.from, segs.SEGMENTS.HOLDOUT.to]) assert.ok(!t.includes(d), d);
  }
  assert.match(promptText(calls[0].body), /exactly 10 /); assert.match(promptText(calls[2].body), /exactly 4 /);
  // 反馈：第二次的提示词带第一批的挖掘段分数（取自试验台账）与已试公式（含被拒的原文）
  const t2 = promptText(calls[1].body);
  const first = rows.filter((t) => t.mining.candidate_id <= `${r.round_id}:A010`);
  for (const t of first) assert.ok(t2.includes(t.rule_config.formula), t.rule_config.formula);
  for (const t of first.filter((x) => typeof x.metrics.mining_segment_score === 'number')) assert.ok(t2.includes(llm.formatScore(t.metrics.mining_segment_score)), t.rule_config.formula);
  assert.equal((promptText(calls[0].body).match(/\(none yet\)/g) || []).length, 2, 'nothing scored or tried before the first call');
  // 计量
  const callRows = rounds.llmCalls(r.round_id);
  assert.equal(callRows.length, 3);
  assert.deepEqual(callRows.map((c) => [c.seq, c.final, c.outcome, c.tokens_metered, c.tokens_basis, c.model_reported, c.served_version]),
    [[1, true, 'OK', 1500, 'USAGE', 'deepseek-v4-pro', 'NOT_REPORTED'], [2, true, 'OK', 1500, 'USAGE', 'deepseek-v4-pro', 'NOT_REPORTED'], [3, true, 'OK', 1500, 'USAGE', 'deepseek-v4-pro', 'NOT_REPORTED']]);
  assert.deepEqual(callRows.map((c) => [c.n_requested, c.formulas_returned, c.lines_overflow]), [[10, 10, 1], [10, 10, 0], [4, 4, 1]]);
  assert.ok(callRows.every((c) => c.request_sha256 === sha(JSON.stringify(calls[c.seq - 1].body)) && c.config_sha256 === llm.loadConfig().sha256));
  assert.deepEqual(callRows[0].usage, { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1200, reasoning_tokens: null });
  assert.deepEqual(rounds.llmUsage(r.round_id), { calls: 3, tokens_metered: 4500, last_outcome: 'OK' });
  const gj = JSON.parse(fs.readFileSync(path.join(runDirOf(out, r.round_id), 'generate.json'), 'utf8'));
  assert.deepEqual([gj.generator.mode, gj.generator.model, gj.generator.config_sha256], ['AI_MINED_LLM', 'deepseek-v4-pro', llm.loadConfig().sha256]);
  assert.deepEqual([gj.llm.calls, gj.llm.tokens_metered, gj.llm.tokens_per_round, gj.llm.state], [3, 4500, r.generator.llm.tokens_per_round, null]);
  // 交换目录的请求只有固定几个键
  const reqs = fs.readdirSync(path.join(out, 'llm-exchange')).filter((n) => n.endsWith('.req.json'));
  assert.equal(reqs.length, 3);
  for (const n of reqs) assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(out, 'llm-exchange', n), 'utf8'))).sort(), ['body', 'key', 'kind', 'request_sha256', 'round_id', 'schema', 'written_at']);
  noKeyIn([out], [JSON.stringify(g), s.stderr()]);

  // B3：第二轮（同月）看不到第一轮的验证折选择；能看到它试过的公式（只有公式），本轮的分数一开始是空的
  const sel = runner.select({ roundId: r.round_id, sources: sources(), outDir: out });
  const selText = fs.readFileSync(path.join(runDirOf(out, r.round_id), 'selection.json'), 'utf8');
  const rB = openLlm({ openedAt: '2026-12-02T02:00:00Z', cap: 3 });
  const s2 = startStep(out, [{ content: ['rank(ts_mean(pb,20))', 'zscore(ts_delta(pb,5))', 'rank(ts_std(turnover_f,60))'] }]);
  try { gen(out, rB.round_id); } finally { await s2.stop(); }
  const tB = promptText(s2.calls()[0].body);
  for (const t of rows) assert.ok(tB.includes(t.rule_config.formula), 'tried formulas of the earlier round');
  for (const t of rows.filter((x) => typeof x.metrics.mining_segment_score === 'number')) assert.ok(!tB.includes(llm.formatScore(t.metrics.mining_segment_score)), 'no score of another round');
  for (const c of sel.candidates) {
    const vals = [c.mean_ic, ...(c.fold_ic || []).map((f) => f.ic_mean)].filter((v) => typeof v === 'number' && Math.abs(v) > 1e-6);
    for (const v of vals) assert.ok(!tB.includes(llm.formatScore(v)), `validation statistic ${v} leaked`);
  }
  for (const w of ['selected', 'validation', 'fold', 'holdout']) assert.ok(!tB.toLowerCase().includes(w), w);
  assert.ok(selText.length > 0);
});

test('B5 等待态：额度用完（402）→ WAITING_QUOTA，本轮留在 OPEN、只发一次、原始错误照留；续跑从第 11 个尝试接着来', async () => {
  const out = freshData();
  const r = openLlm({ cap: 20 });
  const s = startStep(out, [{ content: C2 }, { status: 402, json: { error: { message: 'Insufficient Balance', type: 'unknown_error' } } }]);
  let g;
  try { g = gen(out, r.round_id); } finally { await s.stop(); }
  assert.deepEqual([g.status, g.llm.state, g.llm.halted, g.total], ['OPEN', 'WAITING_QUOTA', true, 10]);
  assert.equal(s.calls().length, 2, 'no retry after the quota error');
  const last = rounds.llmCalls(r.round_id).slice(-1)[0];
  assert.deepEqual([last.seq, last.final, last.outcome, last.http_status, last.tokens_metered], [2, true, 'WAITING_QUOTA', 402, 0]);
  assert.match(last.raw_error, /Insufficient Balance/);
  assert.equal(rounds.llmState(r.round_id).outcome, 'WAITING_QUOTA');
  assert.equal(rounds.roundHead(r.round_id).status, 'OPEN');
  assert.equal(rounds.selectionOf(r.round_id), null, 'no selection while waiting');
  assert.equal(rounds.familyN('CN_A', 5), 10);
  const gj = JSON.parse(fs.readFileSync(path.join(runDirOf(out, r.round_id), 'generate.json'), 'utf8'));
  assert.deepEqual([gj.status, gj.llm.state], ['OPEN', 'WAITING_QUOTA']);
  // 续跑（Owner 充值之后，人工 resume）
  const s2 = startStep(out, [{ content: C3.concat(C1) }]);
  let g2;
  try { g2 = gen(out, r.round_id); } finally { await s2.stop(); }
  assert.deepEqual([g2.status, g2.total, g2.llm.state], ['CAP_REACHED', 20, null]);
  assert.equal(s2.calls().length, 1);
  assert.deepEqual(rounds.llmCalls(r.round_id).map((c) => [c.seq, c.outcome]), [[1, 'OK'], [2, 'WAITING_QUOTA'], [3, 'OK']]);
  assert.deepEqual(roundTrials(r.round_id).map((t) => t.mining.candidate_id).sort().slice(10, 12), [`${r.round_id}:A011`, `${r.round_id}:A012`]);
  assert.equal(rounds.familyN('CN_A', 5), 20);
});

test('B5 等待态：密钥不在 → WAITING_KEY_ABSENT、一次网络都不连、N 不变；限流 429 → WAITING_RATE_LIMITED；模型名对不上 → WAITING_MODEL_MISMATCH、那批公式不用', async () => {
  const out = freshData();
  const r = openLlm({ cap: 10 });
  const s = startStep(out, [{ content: C1 }], { key: false });
  let g;
  try { g = gen(out, r.round_id); } finally { await s.stop(); }
  assert.deepEqual([g.status, g.llm.state, g.total], ['OPEN', 'WAITING_KEY_ABSENT', 0]);
  assert.equal(s.calls().length, 0);
  assert.equal(rounds.familyN('CN_A', 5), 0);
  assert.deepEqual(rounds.llmCalls(r.round_id).map((c) => [c.outcome, c.tokens_metered, c.final]), [['WAITING_KEY_ABSENT', 0, true]]);
  const s2 = startStep(out, [{ status: 429, json: { error: { message: 'Rate Limit Reached' } } }]);
  try { g = gen(out, r.round_id); } finally { await s2.stop(); }
  assert.deepEqual([g.llm.state, g.total, s2.calls().length], ['WAITING_RATE_LIMITED', 0, 1]);
  assert.match(rounds.llmState(r.round_id).raw_error, /Rate Limit Reached/);
  const s3 = startStep(out, [{ content: C2, model: 'deepseek-v4-pro-1201' }]);
  try { g = gen(out, r.round_id); } finally { await s3.stop(); }
  assert.deepEqual([g.llm.state, g.total], ['WAITING_MODEL_MISMATCH', 0]);
  assert.equal(rounds.familyN('CN_A', 5), 0, 'formulas from a mismatched model are not used');
  const mm = rounds.llmState(r.round_id);
  assert.deepEqual([mm.model_reported, mm.tokens_metered, mm.final], ['deepseek-v4-pro-1201', 1500, true]);
  noKeyIn([out]);
});

test('B4 上限：发之前「已用 + 这次的上界」超过本轮 token 上限 → STOPPED_TOKEN_CAP、不发；调用次数到上限 → STOPPED_CALL_CAP', async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/mining_llm_generator.v1.json'), 'utf8'));
  const big = { prompt_tokens: 30000, completion_tokens: 10000, total_tokens: 40000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 30000 };
  const capped = JSON.parse(JSON.stringify(raw)); capped.limits.tokens_per_round = 60000;
  const out = freshData();
  await runner.internals.withLlmConfig(Buffer.from(JSON.stringify(capped)), async () => {
    const r = openLlm({ cap: 40 });
    assert.equal(r.generator.llm.tokens_per_round, 60000);
    const s = startStep(out, [{ content: C2, usage: big }]);
    let g;
    try { g = gen(out, r.round_id); } finally { await s.stop(); }
    assert.deepEqual([g.llm.state, g.llm.halted, g.total, g.status], ['STOPPED_TOKEN_CAP', true, 10, 'OPEN']);
    assert.equal(s.calls().length, 1, 'the second call is not sent');
    assert.equal(fs.readdirSync(path.join(out, 'llm-exchange')).filter((n) => n.endsWith('.req.json')).length, 1, 'no request written for it');
    const st = rounds.llmState(r.round_id);
    assert.deepEqual([st.outcome, st.final, st.tokens_metered], ['STOPPED_TOKEN_CAP', false, 0]);
    assert.ok(rounds.llmUsage(r.round_id).tokens_metered <= 60000);
  });
  const calls1 = JSON.parse(JSON.stringify(raw)); calls1.limits.calls_per_round = 1;
  const out2 = freshData();
  await runner.internals.withLlmConfig(Buffer.from(JSON.stringify(calls1)), async () => {
    const r = openLlm({ cap: 40 });
    const s = startStep(out2, [{ content: C2 }]);
    let g;
    try { g = gen(out2, r.round_id); } finally { await s.stop(); }
    assert.deepEqual([g.llm.state, g.total, s.calls().length], ['STOPPED_CALL_CAP', 10, 1]);
  });
});

test('B6 命令行：开新轮之前先探活；网络那一步不答或没有密钥 → 退出码 75、一轮都不开；探活过了才开轮、生成到上限、选择；续跑的生成方式要和轮次一致', async () => {
  const base = (out) => ['generate', '--generator', 'AI_MINED_LLM', '--out', out, '--lane', fx.dirs.lane, '--tail', fx.dirs.tail, '--min-names-per-day', '5',
    '--holdout-ref', 'synthetic:holdout', '--holdout-sha256', HOLDOUT_SUMS_SHA, '--llm-poll-ms', '10'];
  const env = (out) => ({ ...process.env, QRP_DATA_DIR: path.join(out, 'qrp-data'), QRP_PRODUCT_MILESTONE_AUTHORITY: AUTH });
  const cliAsync = (args, e) => new Promise((res) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: e }); let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.on('exit', (status) => res({ status, stdout, stderr }));
  });
  // 网络那一步没起：探活等不到 → 75，没开轮
  const o1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-llm-cli-'));
  const a = spawnSync(process.execPath, [CLI, ...base(o1), '--llm-wait-seconds', '1'], { env: env(o1), encoding: 'utf8' });
  assert.equal(a.status, 75, a.stderr);
  const ao = JSON.parse(a.stdout);
  assert.deepEqual([ao.command, ao.round_id, ao.status, ao.llm_state], ['generate', null, 'WAITING', 'WAITING_STEP_NO_RESPONSE']);
  assert.ok(!fs.existsSync(path.join(o1, 'qrp-data', 'research', 'mining_rounds.jsonl')), 'no round opened');
  assert.equal(fs.statSync(path.join(o1, 'llm-exchange')).mode & 0o777, 0o777, 'exchange dir is shared with the step container (a different host uid)');
  // 没有密钥：探活答 WAITING_KEY_ABSENT → 75，没开轮
  const o2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-llm-cli-'));
  const s2 = startStep(o2, [{ content: ['OK'] }], { key: false });
  const b = await cliAsync([...base(o2), '--llm-wait-seconds', '20'], env(o2)); await s2.stop();
  assert.equal(b.status, 75, b.stderr);
  assert.deepEqual([JSON.parse(b.stdout).llm_state, JSON.parse(b.stdout).round_id], ['WAITING_KEY_ABSENT', null]);
  assert.ok(!fs.existsSync(path.join(o2, 'qrp-data', 'research', 'mining_rounds.jsonl')));
  assert.equal(s2.calls().length, 0);
  // 都好：探活 → 开轮 → 生成到 12 → 选择
  const o3 = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-llm-cli-'));
  const s3 = startStep(o3, [{ content: ['OK'] }, { content: C2 }, { content: C3 }]);
  const c = await cliAsync([...base(o3), '--cap', '12', '--llm-wait-seconds', '60', '--opened-at', '2026-12-01T02:00:00Z'], env(o3)); await s3.stop();
  assert.equal(c.status, 0, c.stderr);
  const co = JSON.parse(c.stdout);
  assert.deepEqual([co.command, co.status, co.total], ['generate', 'CAP_REACHED', 12]);
  assert.equal(co.ping.outcome, 'OK');
  const calls = s3.calls();
  assert.equal(calls.length, 3);
  assert.ok(!/formula/i.test(promptText(calls[0].body)), 'the first call is the non-formula ping');
  process.env.QRP_DATA_DIR = path.join(o3, 'qrp-data');
  assert.equal(rounds.familyN('CN_A', 5), 12, 'the ping counts nothing in N');
  assert.equal(rounds.llmCalls(co.round_id).length, 2, 'the ping is not a round call');
  assert.ok(rounds.selectionOf(co.round_id));
  // 续跑：生成方式和轮次不一致 → 拒；--seed 不给大模型
  const d = spawnSync(process.execPath, [CLI, 'generate', '--generator', 'AI_MINED_GP', '--out', o3, '--lane', fx.dirs.lane, '--tail', fx.dirs.tail, '--min-names-per-day', '5', '--resume', co.round_id],
    { env: env(o3), encoding: 'utf8' });
  assert.equal(d.status, 2); assert.equal(JSON.parse(d.stderr).error, 'MINE_RUNNER_GENERATOR_MISMATCH');
  const e = spawnSync(process.execPath, [CLI, ...base(o3), '--seed', '3'], { env: env(o3), encoding: 'utf8' });
  assert.equal(e.status, 2); assert.equal(JSON.parse(e.stderr).error, 'MINE_RUNNER_OPTION_NOT_FOR_LLM');
  noKeyIn([o1, o2, o3], [a.stdout, a.stderr, b.stdout, b.stderr, c.stdout, c.stderr, s3.stderr()]);
});

test('B8 run.sh（假的 docker）：llm-ping 先建交换目录再探活；generate-llm 依次建目录 → 起网络那一步（-d）→ 生成（--network none）→ 无论成败都停掉网络那一步；退出码照传（75 = 等待）', () => {
  const RUN_SH = path.join(ROOT, 'deploy/research-lane/round-runner/run.sh');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fake-docker-llm-'));
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho "$*" >> "$DOCKER_LOG"\ncase "$*" in *rf1116-generate-llm*) exit "${FAKE_GEN_EXIT:-0}" ;; esac\nexit 0\n', { mode: 0o755 });
  const run = (args, genExit = 0) => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-docker-log-')), 'log');
    const r = spawnSync('bash', [RUN_SH, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RF1116_RUNNER_IMAGE: 'qrp-round-runner:test', DOCKER_LOG: log, FAKE_GEN_EXIT: String(genExit) } });
    return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] };
  };
  const p = run(['llm-ping']);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.calls.length, 2);
  assert.match(p.calls[0], /--network none .* llm-init --out \/out$/);
  assert.match(p.calls[1], /--network bridge .*services\/mining-llm-step\/cli\.js ping --exchange \/exchange$/);
  for (const [args, extra] of [[['generate-llm', 'a'.repeat(64)], `--holdout-sha256 ${'a'.repeat(64)}`], [['resume-llm', 'MR-CN_A-2026-12-x'], '--resume MR-CN_A-2026-12-x']]) {
    for (const exit of [0, 75, 2]) {
      const r = run(args, exit);
      assert.equal(r.status, exit, `${args[0]} exit ${exit}: ${r.stderr}`);
      assert.equal(r.calls.length, 4, r.calls.join('\n'));
      assert.match(r.calls[0], /llm-init --out \/out$/);
      assert.match(r.calls[1], /^run -d --rm --name rf1116-llm-step --network bridge .*serve --exchange \/exchange$/);
      assert.match(r.calls[2], /--name rf1116-generate-llm(-resume)? --network none .*generate --generator AI_MINED_LLM /);
      assert.ok(r.calls[2].includes(extra), extra);
      assert.match(r.calls[3], /^stop rf1116-llm-step$/, 'the step is stopped whatever generate returns');
    }
  }
  assert.notEqual(run(['generate-llm']).status, 0, 'holdout sha required');
});
