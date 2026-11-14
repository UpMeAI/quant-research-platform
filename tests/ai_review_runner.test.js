'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDailyLedgers } = require('../services/ai-review/runner');
const pack = ledger => ({ period: '2026-11-12', output: 'DAILY', ledger, coverage: 'DESK_DAILY_THREE_SOURCE_SLICE', inputState: 'READY', states: [], facts: [{ id: 'F1', value: null, text: '记录金额 12.5' }] });
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q70-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyFile = path.join(root, 'synthetic-key'); fs.writeFileSync(keyFile, 'fake', { mode: 0o600 });
  let calls = 0;
  const options = { root, enabled: true, keyFile, budget: { perCall: 4000, day: 32000, month: 64000 }, fetchFn: async () => { calls++; return response('记录金额 12.5'); } };
  return { options, calls: () => calls };
}
const response = text => ({ ok: true, json: async () => ({ id: 'fake', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, choices: [{ message: { content: JSON.stringify({ claims: [{ text, refs: ['F1'] }], directions: [] }) } }] }) });
function delivered(row) {
  const json = JSON.parse(fs.readFileSync(row.jsonFile));
  assert.deepEqual(json, row.result);
  const md = fs.readFileSync(row.markdownFile, 'utf8');
  assert.match(md, /DESK_DAILY_THREE_SOURCE_SLICE/);
  assert.equal(json.weeklyComparison, null);
  assert.equal(json.weeklyComparisonAvailability, 'NOT_IMPLEMENTED');
  return { json, md };
}
test('runner persists off, budget, missing key and stale states without fetch or invented zeros', async t => {
  const { options, calls } = setup(t);
  for (const [extra, input, status] of [
    [{ enabled: false }, {}, 'DISABLED'], [{ budget: null }, {}, 'BLOCKED:BUDGET'],
    [{ keyFile: path.join(options.root, 'absent') }, {}, 'BLOCKED:LLM_UNAVAILABLE'],
    [{}, { inputState: 'INPUT_STALE', states: [{ status: 'INPUT_STALE', reason: 'SESSION_DATE' }] }, 'INPUT_STALE'],
  ]) {
    const [row] = await runDailyLedgers({ ...options, ...extra, packs: [{ ...pack('ASHARE_V6_PAPER:INDEX'), ...input }] });
    const { json, md } = delivered(row);
    assert.equal(json.status, status); assert.equal(json.facts[0].value, null);
    assert.deepEqual(json.states, input.states || []); assert.match(md, /null/);
  }
  assert.equal(calls(), 0);
  assert.equal(fs.existsSync(path.join(options.root, 'usage.jsonl')), false);
});
test('runner isolates same-period ledgers, keeps missing book independent and caches each', async t => {
  const { options, calls } = setup(t);
  const packs = [pack('ASHARE_V6_PAPER:INDEX'), { ...pack('US_V5_ETF_3000USD'), inputState: 'INPUT_MISSING' }, pack('ASHARE_V6_PAPER:STOCK')];
  const rows = await runDailyLedgers({ ...options, packs });
  assert.deepEqual(rows.map(r => r.result.status), ['ACCEPTED', 'INPUT_MISSING', 'ACCEPTED']);
  assert.equal(new Set(rows.map(r => r.jsonFile)).size, 3); rows.forEach(delivered);
  await runDailyLedgers({ ...options, packs }); assert.equal(calls(), 2);
  const usage = fs.readFileSync(path.join(options.root, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(usage.filter(r => r.event === 'RESERVED').length, 2);
  assert.equal(new Set(usage.map(r => r.ledger)).size, 2);
});
test('runner retries once, caches failures, and never exposes quarantined text', async t => {
  const { options } = setup(t); let calls = 0;
  const args = { ...options, packs: [pack('ASHARE_V6_PAPER:INDEX')], fetchFn: async () => { calls++; throw Error('synthetic failure'); } };
  delivered((await runDailyLedgers(args))[0]); await runDailyLedgers(args); assert.equal(calls, 2);
  const [row] = await runDailyLedgers({ ...options, packs: [pack('ASHARE_V6_PAPER:STOCK')], fetchFn: async () => response('预计上涨') });
  const { json, md } = delivered(row); assert.equal(json.status, 'QUARANTINED');
  assert.equal(JSON.stringify(json).includes('预计上涨'), false); assert.equal(md.includes('预计上涨'), false);
});
test('runner rejects untrusted ledger paths and wrong coverage without fetching', async t => {
  const { options, calls } = setup(t);
  const rows = await runDailyLedgers({ ...options, packs: [pack('../../escape'), { ...pack('ASHARE_V6_PAPER:INDEX'), coverage: 'COMPLETE' }, pack(null)] });
  assert.ok(rows.every(r => r.result.status === 'INPUT_MISSING'));
  assert.ok(rows.every(r => r.jsonFile.startsWith(options.root + path.sep)));
  assert.equal(calls(), 0);
});
test('runner preflight recovery consumes no claim and budgets remain shared between books', async t => {
  const { options, calls } = setup(t);
  const packs = [pack('ASHARE_V6_PAPER:INDEX'), pack('ASHARE_V6_PAPER:STOCK')];
  await runDailyLedgers({ ...options, packs, budget: null });
  const rows = await runDailyLedgers({ ...options, packs, budget: { perCall: 4000, day: 4000, month: 4000 } });
  assert.deepEqual(rows.map(r => r.result.status), ['ACCEPTED', 'BLOCKED:BUDGET']);
  assert.equal(calls(), 1); rows.forEach(delivered);
  const recovered = await runDailyLedgers({ ...options, packs });
  assert.ok(recovered.every(r => r.result.status === 'ACCEPTED'));
  assert.equal(calls(), 2);
});
test('runner preserves producer rejection reasons when unsupported scope is blocked', async t => {
  const { options, calls } = setup(t);
  const states = [{ ledger: 'CARRY_V2_SHADOW_10000USDT', status: 'INPUT_MISSING', reason: 'NAV_CONTRACT_NOT_REGISTERED' }];
  const [row] = await runDailyLedgers({ ...options, packs: [{ ...pack('CARRY_V2_SHADOW_10000USDT'), inputState: 'INPUT_MISSING', states }] });
  assert.equal(row.result.states[0].reason, 'NAV_CONTRACT_NOT_REGISTERED');
  assert.equal(row.result.states.at(-1).reason, 'DAILY_SCOPE_INVALID');
  assert.equal(calls(), 0);
});
