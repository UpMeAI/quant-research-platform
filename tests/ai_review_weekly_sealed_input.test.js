'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { sha256 } = require('../services/desk-review-routing/canonical');
const overseas = require('../services/overseas-sealed-verdicts');
const { readWeeklySealedInputs } = require('../services/ai-review/weekly-sealed-input');
function setup(t, id = 'SYNTHETIC') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q70-sealed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = JSON.stringify({ verdict: '不做', state: 'INSUFFICIENT', unrelated: 'OTHER_UNIT_PRIVATE' });
  const file = path.join(dir, 'result.json'); fs.writeFileSync(file, raw); fs.writeFileSync(file + '.sha256', sha256(raw));
  const k2File = path.join(dir, 'k2.md'); fs.writeFileSync(k2File, 'synthetic K2'); fs.writeFileSync(k2File + '.sha256', sha256('synthetic K2'));
  const entry = { id, kind: 'RESULT', strategy_ref: 'US_V5_ETF_3000USD', sealed_on: '2026-11-10',
    file: { source: 'coordinator', path: 'result.json', sha256: sha256(raw), ref: 'RESULT' },
    k2: { source: 'coordinator', path: 'k2.md', sha256: sha256('synthetic K2'), ref: 'K2' },
    read: { decision: 'verdict', state: 'state' }, expect: '不做' };
  const lock = { entry_id: id, kind: 'RESULT', strategy_ref: entry.strategy_ref, sealed_on: entry.sealed_on,
    result_id: overseas.internals.resultIdOf(entry, overseas.STORE), file_ref: file, file_sha256: entry.file.sha256,
    refs: [{ role: 'FILE', ref: 'RESULT', sha256: entry.file.sha256, file_ref: file }, { role: 'K2', ref: 'K2', sha256: entry.k2.sha256, file_ref: k2File }] };
  const request = { entryId: id, strategyRef: entry.strategy_ref, resultId: lock.result_id };
  const stores = [{ market: null, store: overseas.STORE, entries: [entry], locks: () => [lock] }];
  const run = (extra = {}) => readWeeklySealedInputs({ period: '2026-11-12', requests: [request], stores, ...extra });
  return { dir, file, k2File, raw, entry, lock, request, stores, run };
}
test('weekly sealed input reuses canonical verdict but never claims complete comparison or leaks another unit', t => {
  const f = setup(t); const [result] = f.run();
  assert.equal(result.sealedSourceState, 'VERIFIED'); assert.equal(result.inputState, 'INPUT_MISSING');
  assert.equal(result.weeklyReady, false); assert.equal(result.comparison, null);
  assert.equal(result.reason, 'WEEKLY_BINDING_PENDING');
  assert.equal(result.facts[0].data.verdictState, 'INSUFFICIENT');
  assert.equal(result.facts[0].sourceSha256, f.entry.file.sha256);
  assert.equal(JSON.stringify(result).includes('OTHER_UNIT_PRIVATE'), false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.raw);
});
test('weekly binding isolates bad requests and rejects cross-strategy, replaced and non-result locks', t => {
  const f = setup(t);
  const rows = f.run({ requests: [null, { ...f.request, strategyRef: 'US_CORE_9000USD_3X_GATEOBS' }, { ...f.request, resultId: 'OLD' }, f.request] });
  assert.deepEqual(rows.map(r => r.sealedSourceState), ['MISSING', 'MISSING', 'MISSING', 'VERIFIED']);
  assert.equal(rows[1].reason, 'SEALED_STRATEGY_BINDING'); assert.equal(rows[2].reason, 'SEALED_CURRENT_RESULT_MISMATCH');
  f.entry.kind = 'STATUS'; f.lock.kind = 'STATUS'; assert.equal(f.run()[0].reason, 'SEALED_NOT_RESULT');
});
test('weekly binding rejects source, sidecar and required reference drift without blocking another request', t => {
  const bad = setup(t, 'BAD'), good = setup(t, 'GOOD');
  fs.appendFileSync(bad.file, ' ');
  const rows = good.run({ requests: [bad.request, good.request], stores: [{ ...good.stores[0], entries: [bad.entry, good.entry], locks: () => [bad.lock, good.lock] }] });
  assert.equal(rows[0].reason, 'OVERSEAS_VERDICT_SHA256_MISMATCH'); assert.equal(rows[1].sealedSourceState, 'VERIFIED');
  const missing = setup(t, 'MISSING'); fs.unlinkSync(missing.file + '.sha256');
  assert.equal(missing.run()[0].reason, 'OVERSEAS_VERDICT_SIDECAR_MISSING');
  const refs = setup(t, 'REFS'); refs.lock.refs.pop(); assert.equal(refs.run()[0].reason, 'SEALED_REFERENCE_BINDING');
});
test('weekly input excludes future sealed results and snapshots lock reads once per store', t => {
  const f = setup(t); let reads = 0;
  f.stores[0].locks = () => { reads++; return [f.lock]; };
  const rows = f.run({ period: '2026-11-09', requests: [f.request, f.request] });
  assert.equal(reads, 1); assert.ok(rows.every(r => r.reason === 'SEALED_AFTER_PERIOD'));
});
test('weekly source uses latest lock without fallback and rejects unbound result paths', t => {
  const f = setup(t), old = { ...f.lock, result_id: 'SUPERSEDED' };
  f.stores[0].locks = () => [old, f.lock];
  assert.equal(f.run({ requests: [{ ...f.request, resultId: old.result_id }] })[0].reason, 'SEALED_CURRENT_RESULT_MISMATCH');
  f.lock.file_ref = f.k2File;
  assert.equal(f.run()[0].reason, 'SEALED_REFERENCE_BINDING');
});
test('weekly input is pure read-only binding with no model path; source errors remain local', async t => {
  const f = setup(t); let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { calls++; throw Error('MODEL_CALL_FORBIDDEN'); };
  try {
    const [pack] = f.run();
    assert.equal(pack.sealedSourceState, 'VERIFIED');
    const report = await require('../services/ai-review').run({ pack, root: path.join(f.dir, 'reports'), enabled: true,
      keyFile: path.join(f.dir, 'absent-synthetic-key'), budget: { perCall: 10000, day: 10000, month: 10000 }, fetchFn: globalThis.fetch });
    assert.equal(report.status, 'WEEKLY_BINDING_PENDING');
    assert.equal(report.comparison, null);
    const forcedReady = await require('../services/ai-review').run({ pack: { ...pack, inputState: 'READY' }, enabled: true, fetchFn: globalThis.fetch });
    assert.equal(forcedReady.status, 'WEEKLY_BINDING_PENDING');
    assert.equal(fs.existsSync(path.join(f.dir, 'reports')), false);
    f.stores[0].locks = () => { throw Error('private-path-secret'); };
    const [bad] = f.run(); assert.equal(bad.reason, 'SEALED_LOCKS_UNAVAILABLE');
    assert.equal(JSON.stringify(bad).includes('private-path-secret'), false);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previousFetch; }
});
