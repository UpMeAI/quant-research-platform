'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, run } = require('../services/ai-review');
const pack = { period: '2026-11-12', output: 'DAILY', facts: [{ id: 'F1', text: '记录金额 12.50', value: 12.5 }], inputState: 'READY' };
const note = { claims: [{ text: '记录金额 12.5', refs: ['F1'] }], directions: [] };
test('Q70 checker: references, exact numbers, forbidden words, question-only directions', () => {
  assert.equal(check(note, pack).ok, true);
  for (const n of [
    { ...note, claims: [{ text: '记录', refs: ['absent'] }] },
    { ...note, claims: [{ text: '记录金额 13', refs: ['F1'] }] },
    { ...note, claims: [{ text: '预计上涨', refs: ['F1'] }] },
    { ...note, directions: [{ question: '趋势有效', mechanism: '执行', control: '对照', requiredData: '记录', refs: ['F1'] }] },
  ]) assert.equal(check(n, pack).ok, false);
});
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q70-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyFile = path.join(root, 'test-key'); fs.writeFileSync(keyFile, 'synthetic-key', { mode: 0o600 });
  let calls = 0;
  const args = { root, pack, enabled: true, keyFile, budget: { perCall: 2000, day: 10000, month: 50000 }, fetchFn: async () => { calls++; return { ok: true, json: async () => ({ id: 'fake', choices: [{ message: { content: JSON.stringify(note) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) }; } };
  return { args, calls: () => calls };
}
test('Q70 off does not read key, create output, or fetch', async (t) => {
  const { args, calls } = setup(t); args.keyFile = '/missing'; args.enabled = false;
  assert.equal((await run(args)).status, 'DISABLED'); assert.equal(calls(), 0);
  assert.equal(fs.existsSync(path.join(args.root, 'usage.jsonl')), false);
});
test('Q70 budgets unconfigured or exceeded block with zero requests', async (t) => {
  const { args, calls } = setup(t);
  assert.equal((await run({ ...args, budget: null })).status, 'BLOCKED:BUDGET');
  assert.equal((await run({ ...args, budget: { perCall: 2000, day: 10, month: 10 } })).status, 'BLOCKED:BUDGET');
  assert.equal(calls(), 0);
});
test('Q70 missing key blocks while deterministic facts remain', async (t) => {
  const { args, calls } = setup(t); args.keyFile = '/missing';
  const r = await run(args); assert.equal(r.status, 'BLOCKED:LLM_UNAVAILABLE');
  assert.deepEqual(r.facts, pack.facts); assert.equal(calls(), 0);
});
test('Q70 accepted output cache and period once survive another invocation', async (t) => {
  const { args, calls } = setup(t);
  assert.equal((await run(args)).status, 'ACCEPTED');
  assert.equal((await run(args)).status, 'ACCEPTED'); assert.equal(calls(), 1);
  assert.equal((await run({ ...args, pack: { ...pack, facts: [...pack.facts, { id: 'F2', text: 'changed' }] } })).status, 'BLOCKED:PERIOD_ALREADY_ATTEMPTED');
  assert.equal(calls(), 1);
});
test('Q70 failure retries once then never repeats same period', async (t) => {
  const { args } = setup(t); let calls = 0;
  args.fetchFn = async () => { calls++; throw Error('synthetic-key sensitive failure'); };
  assert.equal((await run(args)).status, 'BLOCKED:LLM_UNAVAILABLE'); assert.equal(calls, 2);
  await run(args); assert.equal(calls, 2);
  assert.equal(fs.readFileSync(path.join(args.root, 'usage.jsonl'), 'utf8').includes('synthetic-key'), false);
});
test('Q70 failed check quarantines, does not retry or expose candidate in markdown', async (t) => {
  const { args } = setup(t); let calls = 0;
  args.fetchFn = async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ ...note, claims: [{ text: '预计上涨', refs: ['F1'] }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) }; };
  const r = await run(args); assert.equal(r.status, 'QUARANTINED'); assert.equal(calls, 1);
  assert.equal(fs.readFileSync(path.join(args.root, pack.period, 'DAILY.md'), 'utf8').includes('预计上涨'), false);
});
test('Q70 provenance identifiers cannot authorize invented business numbers', () => {
  assert.equal(check({ claims: [{ text: '金额 999', refs: ['F999'] }], directions: [] }, { facts: [{ id: 'F999', sourceFile: '/999.json', text: '无金额' }] }).ok, false);
});
test('Q70 numeric comparison preserves arbitrary decimal precision', () => {
  assert.equal(check({ claims: [{ text: '金额 9007199254740993', refs: ['F1'] }], directions: [] }, { facts: [{ id: 'F1', text: '金额 9007199254740992' }] }).ok, false);
});
