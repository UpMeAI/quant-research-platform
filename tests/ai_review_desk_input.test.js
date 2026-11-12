'use strict';
// Q70 BRIEF §§2,4: delivered read-only facts, exact producer binding, per-ledger
// missing/stale isolation. Slice acceptance fixed before implementation:
// - all three selected source bytes/hash/date/identity must match;
// - canonical producer validator is mandatory and its rejection is preserved;
// - NAV parts and attribution parts use their distinct producer spelling;
// - no fallback, inferred fill partition, cross-ledger facts or model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sha256, contentHash } = require('../services/desk-review-routing/canonical');
const { readDeskDailyPacks } = require('../services/ai-review/desk-input');
const day = '2026-11-12';
const us = 'US_V5_ETF_3000USD';
function setup(t, ledgerId = us, partId = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q70-adapter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cn = ledgerId === 'ASHARE_V6_PAPER';
  const shared = { market: cn ? 'CN' : 'US', sessionDate: day, currency: cn ? 'CNY' : 'USD' };
  const docs = {
    trades: { ...shared, schemaVersion: 1, producer: cn ? 'ASHARE_V6' : 'SMARTFLOW_US', ledgerId, executionMode: 'PAPER', events: [], counts: { fills: 0 }, totals: { pnl: null } },
    nav: { ...shared, schemaVersion: 1, contract: 'BOOK_NAV_SERIES_V1', producer: cn ? 'ASHARE_V6' : 'SMARTFLOW_US', ledgerId, partId: partId ? `${partId}_BOOK` : null, points: [{ day, state: 'MISSING', nav: null }], summary: { state: 'NO_MEASURED_MARK' } },
    decomposition: { ...shared, schemaVersion: 2, producer: cn ? 'ASHARE_V6' : 'SMARTFLOW', lossAttribution: { plan: 'LOSS_ATTRIBUTION_V1@1', accountBasis: 'PAPER_BOOK_IS_THE_ACCOUNT', books: [{ ledgerId, ...(partId ? { partId } : {}), currency: shared.currency, windows: [], ruleVersion: { state: 'UNKNOWN', digest: null, reasonCode: 'MISSING' } }, { ledgerId: 'OTHER', windows: [{ value: 999 }] }] } },
  };
  const sources = {};
  function write(kind) {
    docs[kind].hash = contentHash(docs[kind]);
    const bytes = JSON.stringify(docs[kind]); const file = path.join(dir, `${kind}.json`);
    fs.writeFileSync(file, bytes); sources[kind] = { file, sha256: sha256(bytes) };
  }
  Object.keys(docs).forEach(write);
  const calls = [];
  // Adapter boundary fake, NOT certification of these abbreviated fixtures as
  // producer-valid. Production injects portfolio-desk/src/validate.validateContract.
  const validateContract = (...args) => { calls.push(args); return { ok: true, value: args[1] }; };
  const request = { ledgerId, partId, sources };
  const run = (extra = {}) => readDeskDailyPacks({ period: day, requests: [request], nowMs: Date.parse(`${day}T23:00:00Z`), validateContract, ...extra });
  return { docs, sources, write, request, run, calls };
}
test('daily adapter isolates a missing ledger; preserves unknown and zero with provenance', (t) => {
  const f = setup(t);
  const packs = f.run({ requests: [f.request, { ledgerId: 'C17_V2_4000USDT', sources: {} }] });
  assert.deepEqual(packs.map(p => p.inputState), ['READY', 'INPUT_MISSING']);
  assert.equal(packs[0].facts.length, 3); assert.equal(packs[1].facts.length, 0);
  assert.equal(packs[0].facts[0].data.counts.fills, 0);
  assert.equal(packs[0].facts[1].data.points[0].nav, null);
  assert.equal(JSON.stringify(packs[0]).includes('999'), false);
  assert.ok(packs[0].facts.every(fact => /^[a-f0-9]{64}$/.test(fact.sourceSha256)));
  assert.deepEqual(f.calls.map(c => c[0]), ['TRADE_LEDGER_V1', 'BOOK_NAV_SERIES_V1', 'REVIEW_DECOMPOSITION_V2']);
});
test('daily adapter fails closed without trusted validator or on its rejection', (t) => {
  const f = setup(t);
  assert.equal(f.run({ validateContract: undefined })[0].inputState, 'INPUT_MISSING');
  const pack = f.run({ validateContract: () => ({ ok: false, reason: 'SCHEMA_INVALID' }) })[0];
  assert.equal(pack.inputState, 'INPUT_MISSING'); assert.equal(pack.facts.length, 0);
  assert.equal(pack.states[0].reason, 'SCHEMA_INVALID');
});
test('daily adapter binds schema, producer, ledger, period and both hashes without fallback', (t) => {
  const cases = [
    ['trades', 'schemaVersion', 2, 'INPUT_MISSING'], ['nav', 'contract', 'OTHER', 'INPUT_MISSING'],
    ['trades', 'producer', 'SMARTFLOW_CRYPTO', 'INPUT_MISSING'], ['nav', 'ledgerId', 'US_CORE_9000USD_3X_GATEOBS', 'INPUT_MISSING'],
    ['nav', 'sessionDate', '2026-11-11', 'INPUT_STALE'], ['nav', 'partId', 'BTC_ETH', 'INPUT_MISSING'],
  ];
  for (const [kind, field, value, expected] of cases) {
    const f = setup(t); f.docs[kind][field] = value; f.write(kind);
    assert.equal(f.run()[0].inputState, expected, `${kind}.${field}`);
  }
  const f = setup(t); f.sources.nav.sha256 = '0'.repeat(64);
  assert.equal(f.run()[0].states[1].reason, 'SOURCE_HASH');
  const g = setup(t); const raw = JSON.stringify({ ...g.docs.nav, hash: '0'.repeat(64) });
  fs.writeFileSync(g.sources.nav.file, raw); g.sources.nav.sha256 = sha256(raw);
  assert.equal(g.run()[0].states[1].reason, 'PAYLOAD_HASH');
});
test('A-share part mappings preserve whole-ledger fills without asserting a partition', (t) => {
  const f = setup(t, 'ASHARE_V6_PAPER', 'INDEX');
  const pack = f.run()[0]; assert.equal(pack.inputState, 'READY');
  assert.equal(pack.ledger, 'ASHARE_V6_PAPER:INDEX');
  assert.equal(pack.facts[0].scope, 'LEDGER'); assert.equal(pack.facts[1].data.partId, 'INDEX_BOOK');
  assert.equal(pack.facts[2].data.book.partId, 'INDEX');
  f.docs.decomposition.lossAttribution.books[0].partId = 'STOCK'; f.write('decomposition');
  assert.equal(f.run()[0].inputState, 'INPUT_MISSING');
});
test('carry remains missing because this NAV contract does not register carry', (t) => {
  const f = setup(t); const pack = f.run({ requests: [{ ledgerId: 'CARRY_V2_SHADOW_10000USDT', sources: f.sources }] })[0];
  assert.equal(pack.inputState, 'INPUT_MISSING'); assert.equal(pack.facts.length, 0);
  assert.equal(pack.states[0].reason, 'NAV_CONTRACT_NOT_REGISTERED'); assert.equal(f.calls.length, 0);
});
test('stale and invalid books cannot suppress an independently valid book', (t) => {
  const good = setup(t); const stale = setup(t, 'US_CORE_9000USD_3X_GATEOBS');
  stale.docs.nav.sessionDate = '2026-11-11'; stale.write('nav');
  const packs = good.run({ requests: [stale.request, good.request] });
  assert.deepEqual(packs.map(p => p.inputState), ['INPUT_STALE', 'READY']);
  assert.ok(packs[1].facts.every(f => f.ledger === us));
  assert.equal(packs[1].facts[1].data.ledgerId, us);
  assert.equal(good.calls[0][2].nowMs, Date.parse(`${day}T23:00:00Z`));
});
