'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const panel = require('../services/panel-labels');
const fx = require('./_panel_labels_fixture');

/**
 * W18 part 2 (W18_ALL_CANDIDATE_PANEL_CONTRACT_V1_FREEZE_1 section 7.2, LB-1, LB-6, LB-7; acceptance R-4, R-5): label shape, window table, maturity.
 * The label is a result fact computed from prices by a deterministic program; an immature label has no return key; every label carries its window and maturity date.
 */
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, code);
const RETURN_KEYS = ['grossReturn', 'benchmarkReturn', 'excessReturn'];
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);

function cnWorld() {
  const record = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: '600000.SH' }] });
  const provider = fx.cnProvider();
  provider.set('600000.SH', 'OPEN', '2026-11-03T01:30:00.000Z', 10);
  provider.set('600000.SH', 'CLOSE', '2026-11-09T07:00:00.000Z', 10.5, '2026-11-09T07:30:00.000Z');
  provider.set('CSI300', 'OPEN', '2026-11-03T01:30:00.000Z', 4000);
  provider.set('CSI300', 'CLOSE', '2026-11-09T07:00:00.000Z', 4080, '2026-11-09T07:30:00.000Z');
  return { record, row: record.rows[0], provider };
}

test('R-5 an immature label is UNKNOWN / LABEL_NOT_MATURED with no return key, is never 0, and the provider is not asked for a price; after maturity a new row is appended and the old row is not touched', () => {
  const { record, row, provider } = cnWorld();
  const store = panel.createStore({ dir: tmp('w18-lab-') });
  const early = panel.computeLabel({ record, row, windowId: 'W5S', provider, now: '2026-11-06T10:00:00.000Z' });
  assert.equal(early.state, 'UNKNOWN');
  assert.equal(early.reasonCode, 'LABEL_NOT_MATURED');
  for (const k of RETURN_KEYS) assert.equal(k in early, false, `${k} must not exist before maturity`);
  assert.equal(early.maturesAt, '2026-11-09T07:30:00.000Z');
  assert.equal(early.windowId, 'W5S');
  assert.equal(provider.calls.length, 0, 'no price read before maturesAt');
  assert.notEqual(early.grossReturn, 0);

  const a = panel.materialize({ records: [record], windows: ['W5S'], provider, store, now: '2026-11-06T10:00:00.000Z' });
  assert.deepEqual([a.written, a.skipped], [1, 0]);
  const firstBytes = fs.readFileSync(store.file, 'utf8');
  const replay = panel.materialize({ records: [record], windows: ['W5S'], provider, store, now: '2026-11-06T11:00:00.000Z' });
  assert.deepEqual([replay.written, replay.skipped], [0, 1], 'an unchanged immature label is not written again');

  const late = panel.materialize({ records: [record], windows: ['W5S'], provider, store, now: '2026-11-10T00:00:00.000Z' });
  assert.deepEqual([late.written, late.skipped], [1, 0]);
  const rows = fx.rowsOf(store);
  assert.equal(rows.length, 2);
  assert.equal(fs.readFileSync(store.file, 'utf8').startsWith(firstBytes), true, 'append only: the old row is byte for byte unchanged');
  assert.equal(rows[0].state, 'UNKNOWN');
  assert.equal(rows[1].state, 'VALUE');
  close(rows[1].grossReturn, 0.05);
  assert.equal(rows[1].maturedAt, '2026-11-09T07:30:00.000Z');
  assert.equal(rows[1].maturedAt >= rows[1].maturesAt, true);
  assert.equal(fx.rowsOf(store).filter((x) => x.candidateId === row.candidateId && x.windowId === 'W5S').pop().state, 'VALUE');
  const again = panel.materialize({ records: [record], windows: ['W5S'], provider, store, now: '2026-11-11T00:00:00.000Z' });
  assert.deepEqual([again.written, again.skipped], [0, 1], 'a matured label is never rewritten');
  assert.equal(fx.rowsOf(store).length, 2);
  for (const r of fx.rowsOf(store).filter((x) => x.state !== 'VALUE')) assert.equal(RETURN_KEYS.some((k) => k in r), false);
});

test('R-4 a label without windowId, or a matured label without maturedAt, is refused LABEL_WINDOW_OR_MATURITY_MISSING; a tampered hash is refused', () => {
  const { record, row, provider } = cnWorld();
  const store = panel.createStore({ dir: tmp('w18-lab4-') });
  const matured = panel.computeLabel({ record, row, windowId: 'W5S', provider, now: '2026-11-10T00:00:00.000Z' });
  assert.equal(matured.state, 'VALUE');
  const rehash = (l) => ({ ...l, labelHash: panel.labelHashOf(l) });
  const { windowId: _w, ...noWindow } = matured;
  refuses(() => store.append(rehash(noWindow)), 'LABEL_WINDOW_OR_MATURITY_MISSING');
  const { maturedAt: _m, ...noMatured } = matured;
  refuses(() => store.append(rehash(noMatured)), 'LABEL_WINDOW_OR_MATURITY_MISSING');
  refuses(() => store.append(rehash({ ...matured, maturedAt: null })), 'LABEL_WINDOW_OR_MATURITY_MISSING');
  const { maturesAt: _s, ...noMatures } = matured;
  refuses(() => store.append(rehash(noMatures)), 'LABEL_WINDOW_OR_MATURITY_MISSING');
  refuses(() => store.append(rehash({ ...matured, windowLength: 7 })), 'LABEL_WINDOW_NOT_ALLOWED');
  refuses(() => store.append({ ...matured, grossReturn: 0.5 }), 'LABEL_HASH_MISMATCH');
  assert.equal(fs.existsSync(store.file), false, 'refused labels leave no file');
  store.append(matured);
  assert.equal(fx.rowsOf(store).length, 1);
  refuses(() => store.append(rehash({ ...matured, grossReturn: 0.07, excessReturn: 0.05 })), 'LABEL_MATURED_VALUE_CHANGED');
  refuses(() => store.append(rehash({ ...matured, state: 'UNKNOWN', reasonCode: 'LABEL_NOT_MATURED', maturedAt: null, grossReturn: undefined, benchmarkReturn: undefined, excessReturn: undefined })), 'LABEL_APPEND_REGRESSION');
  assert.equal(fx.rowsOf(store).length, 1);
});

test('label shape: candidateId and panelRecordHash point at the panel; closed state and reason vocabulary; no model, probability, capital or order field', () => {
  const { record, row, provider } = cnWorld();
  const l = panel.computeLabel({ record, row, windowId: 'W5S', provider, now: '2026-11-10T00:00:00.000Z' });
  assert.deepEqual(Object.keys(l).sort(), ['benchmarkReturn', 'candidateId', 'computedAt', 'entryAt', 'entryBasis', 'excessReturn', 'exitAt', 'grossReturn', 'labelHash', 'maturedAt', 'maturesAt',
    'panelRecordHash', 'priceSourceRef', 'reasonCode', 'researchOnly', 'schema', 'state', 'windowId', 'windowLength', 'windowUnit']);
  assert.equal(l.candidateId, row.candidateId);
  assert.equal(l.panelRecordHash, record.recordHash);
  assert.equal(l.entryBasis, 'NEXT_SESSION_OPEN');
  assert.deepEqual([l.windowId, l.windowUnit, l.windowLength], ['W5S', 'SESSION', 5]);
  assert.deepEqual([l.entryAt, l.exitAt], ['2026-11-03T01:30:00.000Z', '2026-11-09T07:00:00.000Z']);
  close(l.grossReturn, 0.05);
  close(l.benchmarkReturn, 0.02);
  close(l.excessReturn, 0.03);
  assert.equal(l.priceSourceRef.priceMethod, 'RAW_OPEN_AND_CLOSE_TIMES_HISTORICAL_ADJ_FACTOR_V1', 'CN uses the B13 method');
  assert.equal(l.priceSourceRef.benchmarkId, 'CSI300');
  assert.equal(l.priceSourceRef.pricedInstrument, '600000.SH');
  assert.equal(l.researchOnly, true);
  assert.equal('productionEffect' in l, false, 'no production effect field: a label is a research fact');
  assert.equal(l.labelHash, panel.labelHashOf(l));
  assert.equal(JSON.stringify(l).match(/(model|prob|capital|order|broker|position|rank|score)/i), null);
  // recomputation: same inputs and a later clock give the same hash (computedAt is outside the hash)
  const again = panel.computeLabel({ record, row, windowId: 'W5S', provider, now: '2026-12-01T00:00:00.000Z' });
  assert.equal(again.labelHash, l.labelHash);
  assert.notEqual(again.computedAt, l.computedAt);
  // the vocabulary is closed
  assert.deepEqual([...panel.vocab.STATES], ['VALUE', 'UNKNOWN', 'NOT_APPLICABLE']);
  assert.deepEqual([...panel.vocab.REASON_CODES].sort(), ['BENCHMARK_PRICE_UNAVAILABLE', 'EXCESS_BENCHMARK_UNAVAILABLE', 'INSTRUMENT_DELISTED_IN_WINDOW', 'LABEL_NOT_MATURED', 'PANEL_RECORD_MISMATCH', 'PRICE_UNAVAILABLE']);
});

test('a return of exactly 0 is a value; a missing price is UNKNOWN / PRICE_UNAVAILABLE; a delisting in the window is NOT_APPLICABLE; a missing benchmark keeps the gross return and says why', () => {
  const rec = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: 'FLAT.SH' }, { securityId: 'GONE.SH' }, { securityId: 'NOPX.SH' }, { securityId: 'NOBM.SH' }] });
  const p = fx.cnProvider({ delisted: { 'GONE.SH': '2026-11-03T05:00:00.000Z' } });
  for (const s of ['FLAT.SH', 'GONE.SH', 'NOBM.SH']) fx.setCnW1(p, s, 10, 10);
  fx.setCnW1(p, 'CSI300', 4000, 4040);
  p.set('NOPX.SH', 'OPEN', '2026-11-03T01:30:00.000Z', 10);
  const now = '2026-11-04T00:00:00.000Z';
  const [flat, gone, nopx, nobm] = rec.rows.map((row) => panel.computeLabel({ record: rec, row, windowId: 'W1S', provider: p, now }));
  assert.equal(flat.state, 'VALUE');
  assert.equal(flat.grossReturn, 0);
  close(flat.excessReturn, -0.01);
  assert.deepEqual([gone.state, gone.reasonCode], ['NOT_APPLICABLE', 'INSTRUMENT_DELISTED_IN_WINDOW']);
  assert.deepEqual([nopx.state, nopx.reasonCode], ['UNKNOWN', 'PRICE_UNAVAILABLE']);
  for (const l of [gone, nopx]) assert.equal(RETURN_KEYS.some((k) => k in l), false);
  const p2 = fx.cnProvider();
  fx.setCnW1(p2, 'NOBM.SH', 10, 10.1);
  const l = panel.computeLabel({ record: rec, row: rec.rows[3], windowId: 'W1S', provider: p2, now });
  assert.equal(l.state, 'VALUE');
  close(l.grossReturn, 0.01);
  assert.deepEqual(l.benchmarkReturn, { state: 'UNKNOWN', reasonCode: 'BENCHMARK_PRICE_UNAVAILABLE' });
  assert.deepEqual(l.excessReturn, { state: 'UNKNOWN', reasonCode: 'EXCESS_BENCHMARK_UNAVAILABLE' });
  assert.ok(nobm.state === 'VALUE');
});

test('a price whose availability is after the evaluation clock is not used (provider honours asOf); a provider that returns one anyway is refused', () => {
  const rec = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: 'LATE.SH' }] });
  const p = fx.cnProvider();
  p.set('LATE.SH', 'OPEN', '2026-11-03T01:30:00.000Z', 10);
  p.set('LATE.SH', 'CLOSE', '2026-11-03T07:00:00.000Z', 11, '2026-11-05T00:00:00.000Z');
  const l = panel.computeLabel({ record: rec, row: rec.rows[0], windowId: 'W1S', provider: p, now: '2026-11-04T00:00:00.000Z' });
  assert.deepEqual([l.state, l.reasonCode], ['UNKNOWN', 'PRICE_UNAVAILABLE']);
  const rogue = { ...p, providerId: 'ROGUE', price: () => ({ state: 'VALUE', value: 11, availableAt: '2026-11-05T00:00:00.000Z', sourceRef: 'x' }) };
  refuses(() => panel.computeLabel({ record: rec, row: rec.rows[0], windowId: 'W1S', provider: rogue, now: '2026-11-04T00:00:00.000Z' }), 'LABEL_PROVIDER_FUTURE_PRICE');
});

test('US and crypto entry basis: the first complete bar open after evaluatedAt; windows count sessions (US) or hours (crypto); the benchmark follows the market', () => {
  const us = fx.panelRecord({ producer: 'SMARTFLOW_US', market: 'US', book: 'US_V5', sessionDate: '2026-11-03', evaluatedAt: '2026-11-03T15:07:00.000Z', candidates: [{ securityId: 'XLK', carrierId: 'TQQQ' }] });
  const cr = fx.panelRecord({ producer: 'SMARTFLOW_CRYPTO', market: 'CRYPTO', book: 'C17', sessionDate: '2026-11-03', evaluatedAt: '2026-11-03T10:20:00.000Z', candidates: [{ securityId: 'ETHUSDT' }] });
  const p = fx.fixtureProvider.create({ sessions: { US: fx.fixtureProvider.weekdaySessions('US', '2026-11-02', 20) } });
  p.set('TQQQ', 'OPEN', '2026-11-03T15:10:00.000Z', 50);
  p.set('TQQQ', 'CLOSE', '2026-11-03T21:00:00.000Z', 51, '2026-11-03T21:30:00.000Z');
  p.set('SPY', 'OPEN', '2026-11-03T15:10:00.000Z', 400);
  p.set('SPY', 'CLOSE', '2026-11-03T21:00:00.000Z', 404, '2026-11-03T21:30:00.000Z');
  p.set('QQQ', 'OPEN', '2026-11-03T15:10:00.000Z', 300);
  p.set('QQQ', 'CLOSE', '2026-11-03T21:00:00.000Z', 309, '2026-11-03T21:30:00.000Z');
  p.set('ETHUSDT', 'OPEN', '2026-11-03T11:00:00.000Z', 2000);
  p.set('ETHUSDT', 'CLOSE', '2026-11-03T15:00:00.000Z', 2100, '2026-11-03T15:01:00.000Z');
  p.set('BTC', 'OPEN', '2026-11-03T11:00:00.000Z', 30000);
  p.set('BTC', 'CLOSE', '2026-11-03T15:00:00.000Z', 30300, '2026-11-03T15:01:00.000Z');
  const u = panel.computeLabel({ record: us, row: us.rows[0], windowId: 'W1S', provider: p, now: '2026-11-04T00:00:00.000Z' });
  assert.equal(u.entryBasis, 'FIRST_COMPLETE_BAR_OPEN_AFTER_EVALUATION');
  assert.deepEqual([u.entryAt, u.exitAt], ['2026-11-03T15:10:00.000Z', '2026-11-03T21:00:00.000Z']);
  assert.equal(u.priceSourceRef.pricedInstrument, 'TQQQ', 'the carrier is priced when the row names one');
  assert.equal(u.priceSourceRef.benchmarkId, 'SPY');
  close(u.grossReturn, 0.02);
  close(u.benchmarkReturn, 0.01);
  const q = panel.computeLabel({ record: us, row: us.rows[0], windowId: 'W1S', provider: p, now: '2026-11-04T00:00:00.000Z', benchmarkKey: 'QQQ' });
  assert.equal(q.priceSourceRef.benchmarkId, 'QQQ');
  close(q.benchmarkReturn, 0.03);
  refuses(() => panel.computeLabel({ record: us, row: us.rows[0], windowId: 'W1S', provider: p, now: '2026-11-04T00:00:00.000Z', benchmarkKey: 'BTC' }), 'LABEL_BENCHMARK_NOT_ALLOWED');
  const c = panel.computeLabel({ record: cr, row: cr.rows[0], windowId: 'W4H', provider: p, now: '2026-11-04T00:00:00.000Z' });
  assert.equal(c.entryBasis, 'FIRST_COMPLETE_BAR_OPEN_AFTER_EVALUATION');
  assert.deepEqual([c.windowUnit, c.windowLength], ['HOUR', 4]);
  assert.deepEqual([c.entryAt, c.exitAt, c.maturesAt], ['2026-11-03T11:00:00.000Z', '2026-11-03T15:00:00.000Z', '2026-11-03T15:01:00.000Z']);
  close(c.grossReturn, 0.05);
  close(c.benchmarkReturn, 0.01);
  assert.equal(c.priceSourceRef.benchmarkId, 'BTC');
});

test('W-7 window table lists allowed values only and never a default: any window must be declared; values outside the table are refused', () => {
  assert.deepEqual(panel.vocab.WINDOW_TABLE.CN, { unit: 'SESSION', lengths: [1, 5, 10, 20] });
  assert.deepEqual(panel.vocab.WINDOW_TABLE.US, { unit: 'SESSION', lengths: [1, 5, 10, 20] });
  assert.deepEqual(panel.vocab.WINDOW_TABLE.CRYPTO, { unit: 'HOUR', lengths: [4, 24, 72] });
  assert.equal(Object.isFrozen(panel.vocab.WINDOW_TABLE), true);
  assert.equal(JSON.stringify(panel.vocab).toLowerCase().includes('default'), false, 'no default window anywhere in the vocabulary');
  const { record, provider } = cnWorld();
  const store = panel.createStore({ dir: tmp('w18-lab7-') });
  refuses(() => panel.materialize({ records: [record], provider, store, now: '2026-11-10T00:00:00.000Z' }), 'LABEL_WINDOWS_NOT_DECLARED');
  refuses(() => panel.materialize({ records: [record], windows: [], provider, store, now: '2026-11-10T00:00:00.000Z' }), 'LABEL_WINDOWS_NOT_DECLARED');
  refuses(() => panel.computeLabel({ record, row: record.rows[0], windowId: 'W7S', provider, now: '2026-11-10T00:00:00.000Z' }), 'LABEL_WINDOW_NOT_ALLOWED');
  refuses(() => panel.computeLabel({ record, row: record.rows[0], windowId: 'W4H', provider, now: '2026-11-10T00:00:00.000Z' }), 'LABEL_WINDOW_NOT_ALLOWED');
  assert.equal(fs.existsSync(store.file), false);
});

test('the label program is deterministic and has no model, network or database dependency', () => {
  const dir = path.join(__dirname, '..', 'services', 'panel-labels');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(/require\(['"](https?|net|dns|child_process|pg|mysql2?|sqlite3?)['"]\)|fetch\(|XMLHttpRequest|Math\.random|Date\.now\(|new Date\(\)/.test(src), false, `${f}: clock, randomness and network are injected, not read`);
  }
});

/* ------------------------------------------------------------------------------------------------------------------------------------------
 * Independent review fix round (NOTE_1): behaviours that the first round left unguarded. Each test below names the guard it pins.
 * ---------------------------------------------------------------------------------------------------------------------------------------- */
const rehash = (l) => ({ ...l, labelHash: panel.labelHashOf(l) });
const matured = () => { const w = cnWorld(); return { ...w, label: panel.computeLabel({ record: w.record, row: w.row, windowId: 'W5S', provider: w.provider, now: '2026-11-10T00:00:00.000Z' }) }; };

test('maturity boundary: the label matures exactly at maturesAt (not one millisecond before)', () => {
  const { record, row, provider } = cnWorld();
  const at = (now) => panel.computeLabel({ record, row, windowId: 'W5S', provider, now });
  assert.equal(at('2026-11-09T07:30:00.000Z').state, 'VALUE', 'now == maturesAt is mature');
  const before = at('2026-11-09T07:29:59.999Z');
  assert.deepEqual([before.state, before.reasonCode], ['UNKNOWN', 'LABEL_NOT_MATURED']);
});

test('store: a return key on a label that has no value is refused, even a 0 and even a four-state object', () => {
  const { label } = matured();
  const store = panel.createStore({ dir: tmp('w18-lab-l3-') });
  const unknown = { ...label, state: 'UNKNOWN', reasonCode: 'PRICE_UNAVAILABLE', maturedAt: null, entryAt: null, exitAt: null };
  delete unknown.grossReturn; delete unknown.benchmarkReturn; delete unknown.excessReturn;
  for (const extra of [{ grossReturn: 0 }, { benchmarkReturn: { state: 'UNKNOWN', reasonCode: 'BENCHMARK_PRICE_UNAVAILABLE' } }, { excessReturn: 0.01 }]) {
    refuses(() => store.append(rehash({ ...unknown, ...extra })), 'LABEL_RETURN_ON_NON_VALUE');
  }
  assert.equal(fs.existsSync(store.file), false);
  store.append(rehash(unknown));
  assert.equal(fx.rowsOf(store).length, 1, 'the same row without a return key is accepted');
});

test('store: no model, probability, capital, order, broker, position or production effect key, at the top or inside priceSourceRef', () => {
  const { label } = matured();
  const store = panel.createStore({ dir: tmp('w18-lab-l8-') });
  for (const key of ['modelScore', 'probability', 'capitalAllocation', 'orderId', 'brokerRef', 'positionSize', 'productionEffect']) {
    refuses(() => store.append(rehash({ ...label, [key]: 'NONE' })), 'LABEL_FORBIDDEN_FIELD');
    refuses(() => store.append(rehash({ ...label, priceSourceRef: { ...label.priceSourceRef, [key]: 1 } })), 'LABEL_FORBIDDEN_FIELD');
  }
  assert.equal(fs.existsSync(store.file), false);
});

test('store: a label that is not research only, or whose clocks are incoherent, is refused (maturedAt >= maturesAt, computedAt >= maturedAt)', () => {
  const { label } = matured();
  const store = panel.createStore({ dir: tmp('w18-lab-coh-') });
  refuses(() => store.append(rehash({ ...label, researchOnly: false })), 'LABEL_NOT_RESEARCH_ONLY');
  const { researchOnly: _r, ...noFlag } = label;
  refuses(() => store.append(rehash(noFlag)), 'LABEL_NOT_RESEARCH_ONLY');
  refuses(() => store.append(rehash({ ...label, maturedAt: '2026-11-09T07:29:59.999Z' })), 'LABEL_MATURITY_INCOHERENT');
  refuses(() => store.append(rehash({ ...label, computedAt: '2026-11-09T07:29:59.999Z' })), 'LABEL_MATURITY_INCOHERENT');
  refuses(() => store.append(rehash({ ...label, computedAt: 'yesterday' })), 'LABEL_MATURITY_INCOHERENT');
  assert.equal(fs.existsSync(store.file), false);
  assert.ok(store.append(rehash({ ...label, computedAt: label.maturedAt })), 'computedAt == maturedAt is coherent');
});

test('CN price method: a provider that does not declare the B13 method for CN is refused; the other markets take the provider method', () => {
  const { record, row, provider } = cnWorld();
  const wrong = { ...provider, priceMethod: () => 'RAW_CLOSE_ONLY' };
  refuses(() => panel.computeLabel({ record, row, windowId: 'W5S', provider: wrong, now: '2026-11-10T00:00:00.000Z' }), 'LABEL_PRICE_METHOD_NOT_ALLOWED');
  const right = { ...provider, priceMethod: (m) => (m === 'CN' ? 'RAW_OPEN_AND_CLOSE_TIMES_HISTORICAL_ADJ_FACTOR_V1' : 'X') };
  assert.equal(panel.computeLabel({ record, row, windowId: 'W5S', provider: right, now: '2026-11-10T00:00:00.000Z' }).state, 'VALUE');
});

test('entry never before the evaluation: a provider whose entryAt precedes evaluatedAt is refused; entry exactly at evaluatedAt is allowed', () => {
  const { record, row, provider } = cnWorld();
  const early = { ...provider, entryAt: () => '2026-11-02T07:29:59.999Z' };
  refuses(() => panel.computeLabel({ record, row, windowId: 'W5S', provider: early, now: '2026-11-10T00:00:00.000Z' }), 'LABEL_PROVIDER_INVALID');
  provider.set('600000.SH', 'OPEN', record.evaluatedAt, 10);
  provider.set('CSI300', 'OPEN', record.evaluatedAt, 4000);
  const exact = { ...provider, entryAt: () => record.evaluatedAt, exitAt: () => '2026-11-09T07:00:00.000Z' };
  assert.equal(panel.computeLabel({ record, row, windowId: 'W5S', provider: exact, now: '2026-11-10T00:00:00.000Z' }).entryAt, record.evaluatedAt, 'the label shows the instant the entry price was taken');
  const flat = { ...provider, exitAt: () => '2026-11-02T07:30:00.000Z' };
  refuses(() => panel.computeLabel({ record, row, windowId: 'W5S', provider: flat, now: '2026-11-10T00:00:00.000Z' }), 'LABEL_PROVIDER_INVALID');
});

test('maturedAt is when the data became available: the latest availableAt of the entry, exit and benchmark prices, never earlier than maturesAt', () => {
  const rec = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: '600000.SH' }] });
  const build = (exitAvail, benchAvail, entryAvail = '2026-11-03T01:30:00.000Z') => {
    const p = fx.cnProvider();
    p.set('600000.SH', 'OPEN', '2026-11-03T01:30:00.000Z', 10, entryAvail);
    p.set('600000.SH', 'CLOSE', '2026-11-03T07:00:00.000Z', 10.5, exitAvail);
    p.set('CSI300', 'OPEN', '2026-11-03T01:30:00.000Z', 4000);
    p.set('CSI300', 'CLOSE', '2026-11-03T07:00:00.000Z', 4040, benchAvail);
    return panel.computeLabel({ record: rec, row: rec.rows[0], windowId: 'W1S', provider: p, now: '2026-11-04T00:00:00.000Z' }).maturedAt;
  };
  assert.equal(build('2026-11-03T09:00:00.000Z', '2026-11-03T07:30:00.000Z'), '2026-11-03T09:00:00.000Z', 'exit price available after maturesAt');
  assert.equal(build('2026-11-03T07:30:00.000Z', '2026-11-03T10:00:00.000Z'), '2026-11-03T10:00:00.000Z', 'benchmark price available last');
  assert.equal(build('2026-11-03T07:30:00.000Z', '2026-11-03T07:30:00.000Z', '2026-11-03T11:00:00.000Z'), '2026-11-03T11:00:00.000Z', 'entry price available last');
  assert.equal(build('2026-11-03T07:10:00.000Z', '2026-11-03T07:10:00.000Z'), '2026-11-03T07:30:00.000Z', 'prices available before maturesAt: matured at maturesAt');
});

test('matured values do not change: gross return, entryAt, exitAt, and a numeric benchmark or excess return are fixed; a benchmark that was missing may be added later', () => {
  const rec = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: 'NOBM.SH' }] });
  const noBench = fx.cnProvider(); fx.setCnW1(noBench, 'NOBM.SH', 10, 10.1);
  const withBench = fx.cnProvider(); fx.setCnW1(withBench, 'NOBM.SH', 10, 10.1); fx.setCnW1(withBench, 'CSI300', 4000, 4040);
  const at = (provider, now) => panel.computeLabel({ record: rec, row: rec.rows[0], windowId: 'W1S', provider, now });
  const first = at(noBench, '2026-11-04T00:00:00.000Z');
  assert.deepEqual(first.benchmarkReturn, { state: 'UNKNOWN', reasonCode: 'BENCHMARK_PRICE_UNAVAILABLE' });
  const store = panel.createStore({ dir: tmp('w18-lab-s2-') });
  store.append(first);
  const upgraded = at(withBench, '2026-11-05T00:00:00.000Z');
  assert.equal(typeof upgraded.benchmarkReturn, 'number');
  assert.ok(store.append(upgraded), 'a missing benchmark may be filled in by a later row');
  assert.equal(fx.rowsOf(store).length, 2);
  for (const patch of [{ grossReturn: 0.5 }, { entryAt: '2026-11-03T01:31:00.000Z' }, { exitAt: '2026-11-03T07:01:00.000Z' }, { benchmarkReturn: 0.5 }, { excessReturn: 0.5 }]) {
    refuses(() => store.append(rehash({ ...upgraded, ...patch })), 'LABEL_MATURED_VALUE_CHANGED');
  }
  refuses(() => store.append(rehash({ ...upgraded, benchmarkReturn: { state: 'UNKNOWN', reasonCode: 'BENCHMARK_PRICE_UNAVAILABLE' } })), 'LABEL_MATURED_VALUE_CHANGED');
  refuses(() => store.append(rehash({ ...upgraded, excessReturn: { state: 'UNKNOWN', reasonCode: 'EXCESS_BENCHMARK_UNAVAILABLE' } })), 'LABEL_MATURED_VALUE_CHANGED');
  assert.equal(fx.rowsOf(store).length, 2, 'every refusal left the table as it was');
});

test('window unit per market: a window of the wrong unit is refused even when its length is allowed for the market (sessions for CN and US, hours for crypto)', () => {
  for (const [market, id] of [['CN', 'W5H'], ['CN', 'W20H'], ['US', 'W1H'], ['US', 'W10H'], ['CRYPTO', 'W24S'], ['CRYPTO', 'W4S'], ['CRYPTO', 'W72S']]) {
    refuses(() => panel.vocab.parseWindowId(market, id), 'LABEL_WINDOW_NOT_ALLOWED');
  }
  assert.deepEqual(panel.vocab.parseWindowId('CN', 'W5S'), { windowId: 'W5S', unit: 'SESSION', length: 5 });
  assert.deepEqual(panel.vocab.parseWindowId('CRYPTO', 'W24H'), { windowId: 'W24H', unit: 'HOUR', length: 24 });
  const { record, row, provider } = cnWorld();
  refuses(() => panel.computeLabel({ record, row, windowId: 'W5H', provider, now: '2026-11-10T00:00:00.000Z' }), 'LABEL_WINDOW_NOT_ALLOWED');
});

test('the store offers no read path: the object has only dir, file and append, and the package exports no table reader', () => {
  const store = panel.createStore({ dir: tmp('w18-lab-api-') });
  assert.deepEqual(Object.keys(store).sort(), ['append', 'dir', 'file']);
  for (const name of ['rows', 'heads', 'readAll', 'read', 'load', 'readRows', 'readEntries']) assert.equal(name in store, false, name);
  for (const name of Object.keys(panel)) assert.equal(/^(rows|heads|read(All|Rows|Entries|Store|Table))$/.test(name), false, `package export ${name}`);
  assert.equal(typeof panel.readLabels, 'function', 'readLabels is the one read');
});
