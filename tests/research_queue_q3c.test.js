'use strict';
/**
 * AUTONOMOUS_RESEARCH_QUEUE_V1 Q3c, agent side of the queue seam: the consumer stages in/task.json + in/bundle.json (`cli.js stage`) and re-validates the agent's
 * result.json itself (`cli.js validate`), never trusting a validator block the agent wrote. Pure validators, no model call, no key.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./_rq_agent_fixture');
const V = require('../services/research-queue-agent');
const { validateResult } = require('../services/research-queue-agent/validate-result');
const { stageFiles } = require('../services/research-queue-agent/stage');
const { canonicalJson } = require('../services/research-queue-agent/canon');

const CLI = path.join(__dirname, '..', 'services', 'research-queue-agent', 'cli.js');
const NOW = () => '2026-11-24T12:00:00+08:00';
const task = (over = {}) => ({ task_id: 'RQT-LINUX-20261122-aaaa1111', host: 'LINUX', agent_host: 'LINUX', kind: 'AI_REVIEW_CARD', market: 'CN_A', template_id: 'T-AI-REVIEW-CARD-V1-LINUX-CN_A', template_sha256: F.sha('tpl'), attempt_no: 1, ...over });
const checkTask = (over = {}) => task({ kind: 'AI_CHECK', template_id: 'T-AI-CHECK-V1-LINUX-CN_A', ...over });
const cardBundle = (over = {}) => ({ schema: 'RQ_AGENT_BUNDLE_V1', market: 'CN_A', week_id: '2026-W47', pack: F.makePack(), registry: F.makeRegistry(), ...over });
const checkBundle = (over = {}) => ({ schema: 'RQ_AGENT_BUNDLE_V1', market: 'CN_A', week_id: '2026-W47', pack: F.makePack(), ...over });
const ok = (obj) => ({ ok: true, status: 200, data: { model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }], usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } } } });
const client = (obj) => ({ async chat() { return ok(obj); } });
const run = (t, b, obj) => V.runAgentTask(t, b, { client: client(obj), env: {}, host: 'LINUX', triage: () => ({ route: 'NORMAL_NO_PRIOR', cite_seal_sha256: [] }), now: NOW });
const clone = (o) => JSON.parse(JSON.stringify(o));

test('validate: a genuine card result passes; the check is on the content, not on any block the agent wrote', async () => {
  const t = task(); const b = cardBundle();
  const res = await run(t, b, F.makeCard());
  assert.equal(res.status, 'DONE');
  const v = validateResult({ task: t, bundle: b, result: res });
  assert.deepEqual(v.codes, []);
  assert.equal(v.ok, true);
  assert.match(v.output_sha256, /^[0-9a-f]{64}$/);
  // a forged self-certificate changes nothing, in either direction
  assert.equal(validateResult({ task: t, bundle: b, result: { ...clone(res), validator: { ok: true, sha256: 'a'.repeat(64) } } }).ok, true);
});

test('validate: forged "validator pass" on an invalid result is refused (card citing an unknown fact, tampered idea records, wrong sha, wrong task, wrong status)', async () => {
  const t = task(); const b = cardBundle();
  const res = await run(t, b, F.makeCard());
  const forge = (mut) => { const r = clone(res); r.validator = { ok: true, sha256: 'b'.repeat(64) }; mut(r); return validateResult({ task: t, bundle: b, result: r }); };
  let v = forge((r) => { r.outputs.card.supporting[0].fact_ids = ['F-999']; r.outputs.card_sha256 = F.sha(canonicalJson(r.outputs.card)); });
  assert.equal(v.ok, false);
  assert.ok(v.codes.includes('CARD_FACT_UNKNOWN'), JSON.stringify(v.codes));
  v = forge((r) => { r.outputs.card.supporting[0].text_zh = '下周将上涨'; r.outputs.card_sha256 = F.sha(canonicalJson(r.outputs.card)); });
  assert.equal(v.ok, false);
  v = forge((r) => { r.outputs.card_sha256 = '0'.repeat(64); });
  assert.deepEqual(v.codes.filter((c) => c === 'RESULT_CARD_SHA_MISMATCH'), ['RESULT_CARD_SHA_MISMATCH']);
  v = forge((r) => { r.outputs.factor_ideas = r.outputs.factor_ideas.slice(1); });
  assert.ok(v.codes.includes('RESULT_IDEAS_MISMATCH'), JSON.stringify(v.codes));
  v = forge((r) => { r.task_id = 'RQT-LINUX-20261122-bbbb2222'; });
  assert.ok(v.codes.includes('RESULT_TASK_MISMATCH'));
  v = forge((r) => { r.status = 'WAITING'; });
  assert.ok(v.codes.includes('RESULT_NOT_DONE'));
  v = forge((r) => { r.outputs.card.prompt_admission_sha256 = '0'.repeat(64); });
  assert.ok(v.codes.includes('RESULT_PROMPT_NOT_ADMITTED'));
  v = forge((r) => { r.outputs.card.model = 'some-other-model'; });
  assert.ok(v.codes.includes('RESULT_MODEL_NOT_ALLOWED'));
  v = forge((r) => { r.note = `leaked sk-${'a'.repeat(24)}`; });
  assert.ok(v.codes.includes('RESULT_SECRET_SHAPED'));
  assert.equal(validateResult({ task: t, bundle: b, result: null }).ok, false);
  assert.equal(validateResult({ task: t, bundle: b, result: { schema: 'X' } }).ok, false);
});

test('validate: a check report result passes; a report that skips an evidence-matrix row or names a state is refused', async () => {
  const t = checkTask(); const b = checkBundle();
  const res = await run(t, b, F.makeCheckReport());
  assert.equal(res.status, 'DONE', JSON.stringify(res));
  assert.equal(validateResult({ task: t, bundle: b, result: res }).ok, true);
  const bad = clone(res);
  bad.outputs.check_report.items = bad.outputs.check_report.items.slice(1);
  bad.outputs.check_report_sha256 = F.sha(canonicalJson(bad.outputs.check_report));
  bad.validator = { ok: true, sha256: 'c'.repeat(64) };
  const v = validateResult({ task: t, bundle: b, result: bad });
  assert.equal(v.ok, false);
  assert.ok(v.codes.some((c) => c.startsWith('CHECK_')), JSON.stringify(v.codes));
});

test('validate: the validator module is pure (no fs, child_process, net, clock)', () => {
  for (const f of ['validate-result.js', 'stage.js']) {
    const src = fs.readFileSync(path.join(path.dirname(CLI), f), 'utf8');
    assert.equal(/require\(['"](fs|child_process|net|http|https|dns|vm|worker_threads)['"]\)/.test(src), false, f);
    assert.equal(/Date\.now|new Date\(\)/.test(src), false, f);
  }
});

test('stage: card input = a fact pack, wrapped into RQ_AGENT_BUNDLE_V1 with the registry view; check input = the bundle itself; task.json carries exactly the seam columns', () => {
  const pack = { schema: 'REVIEW_AI_FACT_PACK_V1', week: '2026-W47', market: 'CN_A', facts: F.makePack().facts, code_counts: F.makePack().code_counts };
  const row = { task_id: 'RQT-LINUX-20261122-aaaa1111', host: 'LINUX', agent_host: 'LINUX', kind: 'AI_REVIEW_CARD', market: 'CN_A', template_id: 'T-AI-REVIEW-CARD-V1-LINUX-CN_A', template_sha256: F.sha('t'), attempt_no: 2, extra: 'ignored' };
  const s = stageFiles({ row, input: pack, buildRegistry: () => F.makeRegistry() });
  assert.deepEqual(Object.keys(s.task).sort(), ['agent_host', 'attempt_no', 'host', 'kind', 'market', 'task_id', 'template_id', 'template_sha256']);
  assert.equal(s.bundle.schema, 'RQ_AGENT_BUNDLE_V1');
  assert.equal(s.bundle.market, 'CN_A');
  assert.equal(s.bundle.week_id, '2026-W47');
  assert.deepEqual(s.bundle.pack.facts, pack.facts);
  assert.ok(s.bundle.registry && Array.isArray(s.bundle.registry.mechanisms));
  const deskPack = { contract: 'REVIEW_AI_FACT_PACK_V1', weekId: '2026-W47', market: 'CN_A', facts: pack.facts, code_counts: pack.code_counts };
  const desk = stageFiles({ row, input: deskPack, buildRegistry: () => F.makeRegistry() });
  assert.equal(desk.bundle.week_id, '2026-W47', 'the canonical desk pack uses weekId, not week');
  const cb = checkBundle();
  const c = stageFiles({ row: { ...row, kind: 'AI_CHECK' }, input: cb });
  assert.deepEqual(c.bundle, cb);
  assert.throws(() => stageFiles({ row, input: { ...pack, market: 'US_EQUITY' }, buildRegistry: () => F.makeRegistry() }), /RQ_STAGE_MARKET_MISMATCH/);
  assert.throws(() => stageFiles({ row: { ...row, kind: 'AI_PREREG' }, input: pack }), /RQ_STAGE_KIND_UNSUPPORTED/);
  assert.throws(() => stageFiles({ row, input: { market: 'CN_A' } }), /RQ_STAGE_INPUT_INVALID/);
});

test('cli stage / validate: files in, JSON out; validate exits 0 with ok=false on a bad result (the consumer reads the verdict), never prints a key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q3c-'));
  const t = task(); const b = cardBundle();
  const res = await run(t, b, F.makeCard());
  const w = (n, o) => { const p = path.join(dir, n); fs.writeFileSync(p, JSON.stringify(o)); return p; };
  const args = (r) => [CLI, 'validate', '--task', w('task.json', t), '--bundle', w('bundle.json', b), '--result', w(r.name, r.body)];
  const good = spawnSync(process.execPath, args({ name: 'good.json', body: res }), { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).ok, true);
  const bad = clone(res); bad.outputs.card.supporting[0].fact_ids = ['F-999']; bad.outputs.card_sha256 = F.sha(canonicalJson(bad.outputs.card));
  const r2 = spawnSync(process.execPath, args({ name: 'bad.json', body: bad }), { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).ok, false);
  const r3 = spawnSync(process.execPath, [CLI, 'validate', '--task', path.join(dir, 'nope.json'), '--bundle', path.join(dir, 'bundle.json'), '--result', path.join(dir, 'good.json')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.notEqual(r3.status, 0, 'unreadable input is a crash, not a pass');
  const out = path.join(dir, 'in');
  const pack = { schema: 'REVIEW_AI_FACT_PACK_V1', week: '2026-W47', market: 'CN_A', facts: F.makePack().facts, code_counts: F.makePack().code_counts };
  const st = spawnSync(process.execPath, [CLI, 'stage', '--row-json', JSON.stringify(t), '--input', w('pack.json', pack), '--out', out], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(st.status, 0, st.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'task.json'))).task_id, t.task_id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'bundle.json'))).schema, 'RQ_AGENT_BUNDLE_V1');
  assert.equal(fs.existsSync(`${out}.tmp`), false);
});
