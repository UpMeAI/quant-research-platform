'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const trials = require('../services/trial-ledger');
const gate = require('../services/k2-freeze-program/program_freeze_gate');
const { read } = require('../packages/ledger');
const panel = require('../services/panel-labels');
const reader = require('../services/panel-labels/reader');
const fx = require('./_panel_labels_fixture');

/**
 * W18 part 2, acceptance R-2 and R-3 (contract section 7.1 LB-4, LB-5; RF1118 star P1 / P3; W05 ruling: marks come from the trial ledger only), as narrowed and fixed by
 * W18_ALL_CANDIDATE_PANEL_CONTRACT_V1_FREEZE_1_NOTE_1 and the independent review (P1-1 .. P1-3):
 *   - every read, at every stage, is bound to a K2: ctx.k2Bytes must hash to k2Ref.sha256 and the trial ledger must hold a REGISTRATION row (family, K2 sha) for EACH declared family;
 *   - the read time is the host clock (ctx.now, default the ledger clock); request.readAt is not trusted, the SEEN mark is stamped with the host clock;
 *   - SEEN readable; UNSEEN only as the bound coordinator-frozen K2's own first read; FORWARD_RESERVED: a non-holder is refused, and the holder is refused too
 *     (FORWARD_READ_TIME_NOT_IN_LEDGER: the ledger holds no declared read time, so this version never converts a reservation to FORWARD_READ);
 *   - a read whose [from, to] contains ANY family's FORWARD_RESERVED day of the market is refused unless the requester is that family's holder (labels are per market, marks per family);
 *   - the range test (exitAt, else maturesAt, not after `to`) holds for every label state.
 */
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, code);
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const marksOf = (family) => read(trials.SEGMENTS()).filter((m) => m.family_id === family);
const labelsOf = (out) => out.rows.map((r) => r.label.state);
const PROGRAM = fx.k2('K2-PROGRAM', 'K2_FREEZE_PROGRAM_V1');
const SOMEONE = fx.k2('K2-SOMEONE', 'SOMEONE_ELSE');
const NO_FREEZER = fx.k2('K2-NO-FREEZER', null);
const COORD_OTHER = fx.k2('K2-COORD-OTHER', 'COORDINATOR');
let n = 0;
const fam = (tag) => { n += 1; return `W18_GATE_${tag}_${process.pid}_${n}`; };
// the market wide FORWARD scan sees every family's marks, so every test starts from an empty trial ledger
test.beforeEach(() => { for (const f of [trials.TRIALS(), trials.SEGMENTS()]) fs.rmSync(f, { force: true }); });
const mark = (family, label, extra = {}) => trials.markSegments({ family_id: family, market: 'CN_A', from: '2026-11-01', to: '2026-11-30', label, reason: 'W18 stage gate fixture', ...extra },
  { registeredBy: fx.AUTH, registeredAt: '2026-11-01T00:00:00.000Z' });

function world(securities = ['600000.SH']) {
  const store = panel.createStore({ dir: path.join(fx.tmp('w18-gate-'), 'labels') });
  const record = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: securities.map((securityId) => ({ securityId })) });
  const provider = fx.cnProvider();
  for (const s of securities) fx.setCnW1(provider, s, 10, 10.5);
  fx.setCnW1(provider, 'CSI300', 4000, 4040);
  panel.materialize({ records: [record], windows: ['W1S'], provider, store, now: '2026-11-04T00:00:00.000Z' });
  const ctx = fx.ctxFor(store);
  return { store, record, provider, ctx, request: (family, o = {}) => fx.request(family, [record], o) };
}

test('R-2 / R-3 a SEEN range is readable by a bound K2; the read appends a read record (LB-5) and a SEEN mark whose source is the read record sha256; segmentsFor then shows SEEN from that mark; a replay adds a record but no second mark', () => {
  const w = world(); const F = fam('SEEN'); fx.bind(F);
  const out = panel.readLabels(w.request(F), w.ctx);
  assert.deepEqual(labelsOf(out), ['VALUE']);
  const [rec] = lines(w.ctx.readLedgerFile);
  for (const k of ['readerRole', 'k2Ref', 'stage', 'families', 'from', 'to', 'windows', 'readAt', 'rowsReturned', 'sha256']) assert.ok(k in rec, `read record has ${k}`);
  assert.deepEqual([rec.readerRole, rec.stage, rec.families, rec.from, rec.to, rec.windows, rec.readAt, rec.rowsReturned], [fx.EVALUATOR, 'SEEN', [F], '2026-11-01', '2026-11-30', ['W1S'], fx.NOW, 1]);
  assert.deepEqual(rec.k2Ref, fx.COORD);
  assert.equal(rec.sha256, panel.readRecordHashOf(rec), 'the record sha256 is the hash of the record content');
  const marks = marksOf(F);
  assert.equal(marks.length, 1);
  assert.deepEqual([marks[0].label, marks[0].from, marks[0].to, marks[0].market, marks[0].seen_kind], ['SEEN', '2026-11-01', '2026-11-30', 'CN_A', null]);
  assert.equal(marks[0].source_refs[0].kind, 'PANEL_LABEL_READ');
  assert.equal(marks[0].source_refs[0].read_record_sha256, rec.sha256);
  const { pieces } = trials.segmentsFor(F, '2026-11-01', '2026-11-30');
  assert.deepEqual(pieces.map((p) => [p.from, p.to, p.label, p.source === marks[0].mark_id]), [['2026-11-01', '2026-11-30', 'SEEN', true]]);

  panel.readLabels(w.request(F), { ...w.ctx, now: () => '2027-01-02T00:00:00.000Z' });
  assert.equal(lines(w.ctx.readLedgerFile).length, 2, 'the replay is a read and is recorded');
  assert.equal(marksOf(F).length, 1, 'the same read replayed produces one mark only');
  panel.readLabels(w.request(F, { to: '2026-11-20' }), w.ctx);
  assert.equal(marksOf(F).length, 2, 'a different range is a different read and gets its own mark');
});

test('P1-2 the read time is the host clock: request.readAt is ignored, the read record and the SEEN mark carry ctx.now(); without ctx.now the ledger clock is used', () => {
  const w = world(); const F = fam('CLOCK'); fx.bind(F);
  panel.readLabels(w.request(F, { readAt: '2000-01-01T00:00:00.000Z' }), { ...w.ctx, now: () => '2026-12-05T08:09:10.111Z' });
  const [rec] = lines(w.ctx.readLedgerFile);
  assert.equal(rec.readAt, '2026-12-05T08:09:10.111Z');
  assert.equal(marksOf(F)[0].registered_at, '2026-12-05T08:09:10.111Z');
  const G = fam('CLOCK2'); fx.bind(G);
  const before = Date.now();
  const { now: _n, ...noClock } = w.ctx;
  panel.readLabels(w.request(G, { readAt: '1999-01-01T00:00:00.000Z' }), noClock);
  const stamped = marksOf(G)[0].registered_at;
  assert.ok(Date.parse(stamped) >= before - 1 && Date.parse(stamped) <= Date.now() + 1, `ledger clock ${stamped}`);
  assert.equal(lines(w.ctx.readLedgerFile)[1].readAt, stamped);
  refuses(() => panel.readLabels(w.request(G), { ...w.ctx, now: () => 'noon' }), 'LABEL_READ_CONTEXT_INVALID');
});

test('P1-1 every read is bound to a K2 for EVERY declared family, at every stage: byte mismatch, unreadable K2, a family the K2 is not registered for, all refused LABEL_READ_K2_NOT_BOUND with nothing recorded or marked', () => {
  const w = world(); const A = fam('BOUND_A'); const B = fam('BOUND_B'); const C = fam('BOUND_C');
  fx.bind(A); fx.bind(B); fx.bind(C, COORD_OTHER);
  const before = marksOf(A).length;
  const bound = (o = {}, ctx = w.ctx) => panel.readLabels(w.request(A, o), ctx);
  // family binding: K2 registered for A and B, not for C, and only for A with the other K2
  assert.equal(bound({ families: [A, B] }).rows.length, 1, 'bound for both families');
  refuses(() => bound({ families: [A, B, C] }), 'LABEL_READ_K2_NOT_BOUND');
  refuses(() => bound({ families: [fam('UNREGISTERED')] }), 'LABEL_READ_K2_NOT_BOUND');
  refuses(() => bound({ k2Ref: COORD_OTHER }), 'LABEL_READ_K2_NOT_BOUND');
  // byte binding (R06)
  refuses(() => bound({}, { ...w.ctx, k2Bytes: () => Buffer.from('some other K2 text') }), 'LABEL_READ_K2_NOT_BOUND');
  refuses(() => bound({}, { ...w.ctx, k2Bytes: () => null }), 'LABEL_READ_K2_NOT_BOUND');
  const { k2Bytes: _k, ...noBytes } = w.ctx;
  refuses(() => bound({}, noBytes), 'LABEL_READ_K2_NOT_BOUND');
  // the same at the other stages
  refuses(() => bound({ stage: 'UNSEEN_FIRST_READ', k2Ref: COORD_OTHER }), 'LABEL_READ_K2_NOT_BOUND');
  refuses(() => bound({ stage: 'FORWARD', forward: { shadowRef: 'SH-X' }, k2Ref: COORD_OTHER }), 'LABEL_READ_K2_NOT_BOUND');
  assert.equal(marksOf(A).length, before + 1, 'only the one passed read marked');
  assert.equal(lines(w.ctx.readLedgerFile).length, 1, 'refused reads leave no read record');
  const refused = lines(w.ctx.accessLogFile).filter((r) => r.op === 'HOLDOUT_READ_REFUSED');
  assert.equal(refused.length, 8);
  assert.equal(refused.every((r) => r.code === 'LABEL_READ_K2_NOT_BOUND'), true);
});

test('R-2 an UNSEEN range: a program frozen K2, a K2 with an unknown freezer and a K2 without a freezer line are refused LABEL_READ_UNSEEN_NOT_PERMITTED (nothing returned, nothing marked); so is a SEEN-stage request; the bound coordinator-frozen K2 reads it once and the range turns SEEN', () => {
  const w = world(); const F = fam('UNSEEN');
  mark(F, 'UNSEEN');
  for (const k of [fx.COORD, PROGRAM, SOMEONE, NO_FREEZER]) fx.bind(F, k);
  const before = marksOf(F).length;
  const unseen = (o) => w.request(F, { stage: 'UNSEEN_FIRST_READ', ...o });
  refuses(() => panel.readLabels(unseen({ k2Ref: PROGRAM }), w.ctx), 'LABEL_READ_UNSEEN_NOT_PERMITTED');
  refuses(() => panel.readLabels(unseen({ k2Ref: SOMEONE }), w.ctx), 'LABEL_READ_UNSEEN_NOT_PERMITTED');
  refuses(() => panel.readLabels(unseen({ k2Ref: NO_FREEZER }), w.ctx), 'LABEL_READ_UNSEEN_NOT_PERMITTED');
  refuses(() => panel.readLabels(w.request(F, { stage: 'SEEN' }), w.ctx), 'LABEL_READ_UNSEEN_NOT_PERMITTED');
  assert.equal(marksOf(F).length, before, 'a refused read marks nothing');
  assert.equal(lines(w.ctx.readLedgerFile).length, 0, 'a refused read leaves no read record');
  assert.equal(trials.segmentsFor(F, '2026-11-01', '2026-11-30').pieces[0].label, 'UNSEEN');
  const refused = lines(w.ctx.accessLogFile).filter((r) => r.op === 'HOLDOUT_READ_REFUSED');
  assert.equal(refused.length, 4);
  assert.equal(refused.every((r) => r.code === 'LABEL_READ_UNSEEN_NOT_PERMITTED' && r.dataset === 'PANEL_LABELS_V1'), true);

  const ok = panel.readLabels(unseen({ k2Ref: fx.COORD }), w.ctx);
  assert.deepEqual(labelsOf(ok), ['VALUE']);
  assert.deepEqual(trials.segmentsFor(F, '2026-11-01', '2026-11-30').pieces.map((p) => [p.from, p.to, p.label]), [['2026-11-01', '2026-11-30', 'SEEN']], 'R-3: after the read the range is SEEN');
  assert.equal(marksOf(F).filter((m) => m.label === 'SEEN').length, 1);
  // once SEEN, the same data is development information: a bound program frozen K2 may read it as SEEN
  assert.deepEqual(labelsOf(panel.readLabels(w.request(F, { k2Ref: PROGRAM, stage: 'SEEN' }), w.ctx)), ['VALUE']);
});

test('R-2 FORWARD_RESERVED, first version (NOTE_1 item 3): a non-holder is refused; the holder is refused at any clock because the ledger holds no declared read time (FORWARD_READ_TIME_NOT_IN_LEDGER); no FORWARD_READ mark is ever written; a stage FORWARD request is closed even with no reservation', () => {
  const w = world(); const F = fam('FORWARD'); fx.bind(F);
  mark(F, 'FORWARD_RESERVED', { from: '2026-11-01', to: '2026-12-31', shadow_ref: 'SH-A' });
  const fwd = (o) => w.request(F, { stage: 'FORWARD', forward: { shadowRef: 'SH-A' }, ...o });
  refuses(() => panel.readLabels(w.request(F, { stage: 'SEEN' }), w.ctx), 'LABEL_READ_FORWARD_NOT_PERMITTED');
  refuses(() => panel.readLabels(fwd({ forward: { shadowRef: 'SH-B' } }), w.ctx), 'LABEL_READ_FORWARD_NOT_PERMITTED');
  refuses(() => panel.readLabels(fwd({ forward: undefined }), w.ctx), 'LABEL_READ_FORWARD_NOT_PERMITTED');
  for (const clock of ['2026-11-05T00:00:00.000Z', '2026-12-02T00:00:00.000Z', '2030-01-01T00:00:00.000Z']) {
    refuses(() => panel.readLabels(fwd({}), { ...w.ctx, now: () => clock }), 'FORWARD_READ_TIME_NOT_IN_LEDGER');
    refuses(() => panel.readLabels(fwd({ forward: { shadowRef: 'SH-A', declaredReadAt: '2026-11-01T00:00:00.000Z' } }), { ...w.ctx, now: () => clock }), 'FORWARD_READ_TIME_NOT_IN_LEDGER');
  }
  assert.equal(marksOf(F).length, 1, 'only the reservation: nothing was marked');
  assert.equal(lines(w.ctx.readLedgerFile).length, 0);
  const { reservations } = trials.segmentsFor(F, '2026-11-01', '2026-12-31');
  assert.deepEqual(reservations.map((r) => [r.label, r.shadow_ref]), [['FORWARD_RESERVED', 'SH-A']]);
  // a stage FORWARD request with nothing reserved in its range is closed too
  const G = fam('FORWARD_NONE'); fx.bind(G);
  refuses(() => panel.readLabels(w.request(G, { stage: 'FORWARD', forward: { shadowRef: 'SH-A' } }), w.ctx), 'FORWARD_READ_TIME_NOT_IN_LEDGER');
});

test('R-2 a reservation that a FORWARD_READ mark already closed (written elsewhere) is spent for everyone; the part still reserved stays closed', () => {
  const w = world(); const F = fam('FORWARD_SPENT'); fx.bind(F);
  mark(F, 'FORWARD_RESERVED', { from: '2026-11-01', to: '2026-12-31', shadow_ref: 'SH-A' });
  mark(F, 'FORWARD_READ', { from: '2026-11-01', to: '2026-11-30', shadow_ref: 'SH-A' });
  assert.deepEqual(labelsOf(panel.readLabels(w.request(F, { to: '2026-11-30' }), w.ctx)), ['VALUE']);
  refuses(() => panel.readLabels(w.request(F, { to: '2026-12-31' }), w.ctx), 'LABEL_READ_FORWARD_NOT_PERMITTED');
});

test('NOTE_1 item 4: a read whose range contains ANY family\'s reserved day of the market is refused unless the requester is that family\'s holder; other markets and days outside the range do not block', () => {
  const w = world();
  const A = fam('XFAM_A'); const B = fam('XFAM_B'); fx.bind(A);
  mark(B, 'FORWARD_RESERVED', { from: '2026-11-15', to: '2026-12-31', shadow_ref: 'SH-B' }); // B is not declared by the request
  refuses(() => panel.readLabels(w.request(A, { stage: 'SEEN' }), w.ctx), 'LABEL_READ_FORWARD_NOT_PERMITTED');
  refuses(() => panel.readLabels(w.request(A, { stage: 'FORWARD', forward: { shadowRef: 'SH-A' } }), w.ctx), 'LABEL_READ_FORWARD_NOT_PERMITTED');
  refuses(() => panel.readLabels(w.request(A, { stage: 'FORWARD', forward: { shadowRef: 'SH-B' } }), w.ctx), 'FORWARD_READ_TIME_NOT_IN_LEDGER');
  assert.deepEqual(labelsOf(panel.readLabels(w.request(A, { to: '2026-11-14' }), w.ctx)), ['VALUE'], 'the range ends before the reserved days');
  // market aliases of the ledger count as the same market; another market does not
  const Cn = fam('XFAM_CN_ALIAS'); const Us = fam('XFAM_US');
  mark(Cn, 'FORWARD_RESERVED', { market: 'CN', from: '2026-11-01', to: '2026-11-03', shadow_ref: 'SH-C' });
  refuses(() => panel.readLabels(w.request(A, { from: '2026-11-01', to: '2026-11-03' }), w.ctx), 'LABEL_READ_FORWARD_NOT_PERMITTED');
  const w2 = world(); const D = fam('XFAM_D'); fx.bind(D);
  mark(Us, 'FORWARD_RESERVED', { market: 'US_EQUITY', from: '2026-11-01', to: '2026-11-30', shadow_ref: 'SH-U' });
  const lonely = (to) => panel.readLabels(w2.request(D, { from: '2026-11-04', to }), w2.ctx);
  assert.ok(lonely('2026-11-14'), 'a US reservation does not block a CN read (and CN reservations ended by 11-03)');
});

test('P1-3 the range test holds for every label state: a label whose window ends (exitAt, else maturesAt) after `to` is not returned, whether it is VALUE, NOT_APPLICABLE, PRICE_UNAVAILABLE or immature', () => {
  const store = panel.createStore({ dir: path.join(fx.tmp('w18-range-'), 'labels') });
  const settled = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: ['OK.SH', 'GONE.SH', 'NOPX.SH'].map((securityId) => ({ securityId })) });
  const late = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T08:00:00.000Z', candidates: [{ securityId: 'LATE.SH' }] });
  const p = fx.cnProvider({ delisted: { 'GONE.SH': '2026-11-03T05:00:00.000Z' } });
  for (const s of ['OK.SH', 'GONE.SH', 'LATE.SH']) fx.setCnW1(p, s, 10, 10.5);
  fx.setCnW1(p, 'CSI300', 4000, 4040);
  p.set('NOPX.SH', 'OPEN', '2026-11-03T01:30:00.000Z', 10);
  panel.materialize({ records: [settled], windows: ['W1S'], provider: p, store, now: '2026-11-04T00:00:00.000Z' });
  panel.materialize({ records: [late], windows: ['W1S'], provider: p, store, now: '2026-11-03T03:00:00.000Z' }); // immature: UNKNOWN / LABEL_NOT_MATURED
  const states = fx.rowsOf(store).map((l) => `${l.state}/${l.reasonCode}`).sort();
  assert.deepEqual(states, ['NOT_APPLICABLE/INSTRUMENT_DELISTED_IN_WINDOW', 'UNKNOWN/LABEL_NOT_MATURED', 'UNKNOWN/PRICE_UNAVAILABLE', 'VALUE/null']);
  const F = fam('RANGE'); fx.bind(F);
  const read = (to) => panel.readLabels(fx.request(F, [settled, late], { to }), fx.ctxFor(store)).rows.map((r) => `${r.state}/${r.reasonCode}`).sort();
  assert.deepEqual(read('2026-11-02'), [], 'nothing whose window ends on 11-03 is returned, whatever its state');
  assert.deepEqual(read('2026-11-03'), states);
  // a long availability lag puts maturesAt on the next calendar day: a label without exitAt is cut by maturesAt, a value by exitAt
  const lagged = fx.cnProvider({ lagMs: { CN: 20 * 3600000 } });
  fx.setCnW1(lagged, 'OK.SH', 10, 10.5); lagged.set('OK.SH', 'CLOSE', '2026-11-03T07:00:00.000Z', 10.5, '2026-11-04T03:00:00.000Z');
  const rec = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: 'OK.SH' }, { securityId: 'MISSING.SH' }] });
  const store2 = panel.createStore({ dir: path.join(fx.tmp('w18-range2-'), 'labels') });
  panel.materialize({ records: [rec], windows: ['W1S'], provider: lagged, store: store2, now: '2026-11-05T00:00:00.000Z' });
  const G = fam('RANGE2'); fx.bind(G);
  const cut = (to) => panel.readLabels(fx.request(G, [rec], { to }), fx.ctxFor(store2)).rows.map((r) => r.state).sort();
  assert.deepEqual(cut('2026-11-03'), ['VALUE'], 'the value (exit 11-03) is inside; the unavailable label (matures 11-04) is not');
  assert.deepEqual(cut('2026-11-04'), ['UNKNOWN', 'VALUE']);
});

test('market and window filters: records of another market are not returned; only the requested windows are', () => {
  const store = panel.createStore({ dir: path.join(fx.tmp('w18-filter-'), 'labels') });
  const record = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: '600000.SH' }] });
  const p = fx.cnProvider(); fx.setCnW1(p, '600000.SH', 10, 10.5); fx.setCnW1(p, 'CSI300', 4000, 4040);
  p.set('600000.SH', 'CLOSE', '2026-11-09T07:00:00.000Z', 11, '2026-11-09T07:30:00.000Z'); p.set('CSI300', 'CLOSE', '2026-11-09T07:00:00.000Z', 4080, '2026-11-09T07:30:00.000Z');
  p.set('600000.SH', 'OPEN', '2026-11-03T01:30:00.000Z', 10);
  panel.materialize({ records: [record], windows: ['W1S', 'W5S'], provider: p, store, now: '2026-11-10T00:00:00.000Z' });
  const ctx = fx.ctxFor(store);
  const F = fam('FILTER'); const Fus = fam('FILTER_US'); const Fcr = fam('FILTER_CR');
  fx.bind(F); fx.bind(Fus, fx.COORD, 'US_EQUITY'); fx.bind(Fcr, fx.COORD, 'CRYPTO'); // the K2 is registered in the market it reads (NOTE_2 item 2)
  const familyOf = { CN: F, US: Fus, CRYPTO: Fcr };
  const ids = (o) => panel.readLabels(fx.request(familyOf[o.market || 'CN'], [record], { ...o }), ctx).rows.map((r) => r.windowId);
  assert.deepEqual(ids({ windows: ['W1S'], to: '2026-12-31' }), ['W1S']);
  assert.deepEqual(ids({ windows: ['W5S'], to: '2026-12-31' }), ['W5S']);
  assert.deepEqual(ids({ windows: ['W1S', 'W5S'], to: '2026-12-31' }), ['W1S', 'W5S']);
  // the same candidates read as market US: the records are CN, so nothing comes back
  assert.deepEqual(ids({ market: 'US', windows: ['W1S'], to: '2026-12-31' }), []);
  assert.deepEqual(ids({ market: 'CRYPTO', windows: ['W4H'], to: '2026-12-31' }), []);
});

test('a label is returned only when its whole window lies inside [from, to]; the request must name allowed windows, families, a stage, a K2 sha256 and an ordered range', () => {
  const w = world(); const F = fam('RANGE_REQ'); fx.bind(F);
  assert.deepEqual(labelsOf(panel.readLabels(w.request(F, { to: '2026-11-02' }), w.ctx)), [], 'the window ends 2026-11-03, outside the range');
  assert.deepEqual(labelsOf(panel.readLabels(w.request(F, { to: '2026-11-03' }), w.ctx)), ['VALUE']);
  assert.deepEqual(labelsOf(panel.readLabels(w.request(F, { from: '2026-11-03', to: '2026-11-30' }), w.ctx)), [], 'the evaluation date is before the range');
  refuses(() => panel.readLabels(w.request(F, { windows: ['W7S'] }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { windows: ['W5H'] }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { windows: [] }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { families: [] }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { stage: 'ANYTHING' }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { k2Ref: { id: 'x', sha256: 'nothex' } }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { from: '2026-11-30', to: '2026-11-01' }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { forward: { shadowRef: '' } }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
});

test('a mark that cannot be written stops the read: no rows are returned and an abort row is appended', () => {
  const w = world(); const F = fam('MARKFAIL'); fx.bind(F);
  refuses(() => panel.readLabels(w.request(F), { ...w.ctx, registeredBy: 'not-the-authority' }), 'LABEL_READ_MARK_FAILED');
  const rows = lines(w.ctx.readLedgerFile);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].schema, 'PANEL_LABEL_READ_ABORTED_V1');
  assert.equal(rows[1].readRecordSha256, rows[0].sha256);
  assert.equal(marksOf(F).length, 0);
});

test('parity: the K2 freezer classification in the reader equals the K2 freeze program gate (program_freeze_gate.check) on the same K2 texts', () => {
  const head = (line) => `# K2\n\n## 0.\n\n${line}\n`;
  const texts = [
    [head('- **作者与冻结者**：agent，冻结者 COORDINATOR，2026-11-23。'), 'COORDINATOR'],
    [head('- **作者与冻结者**：agent，冻结者 K2_FREEZE_PROGRAM_V1，2026-11-23。'), 'K2_FREEZE_PROGRAM_V1'],
    [head('- **作者与冻结者**：agent，冻结者 SOMEONE_ELSE，2026-11-23。'), 'UNKNOWN'],
    [head('- **作者与冻结者**：agent，没写冻结者'), 'UNKNOWN'],
    [head('- no freezer line at all'), null],
    [head('- **作者与冻结者**：冻结者 COORDINATOR；曾由 冻结者 K2_FREEZE_PROGRAM_V1 起草'), 'K2_FREEZE_PROGRAM_V1'],
    [`${head('- **作者与冻结者**：冻结者 COORDINATOR')}\n- **作者与冻结者**：冻结者 K2_FREEZE_PROGRAM_V1\n`, 'COORDINATOR'],
    [head('- 冻结者 K2_FREEZE_PROGRAM_V1 (no label)'), null],
  ];
  const oracle = (text) => {
    try { return gate.check({ id: 'x', kind: 'RESULT', k2: { sha256: 'a'.repeat(64) } }, { k2Bytes: () => Buffer.from(text) }); } catch (e) { return { threw: e.code }; }
  };
  for (const [text, expected] of texts) {
    assert.equal(reader.frozenByOf(text), expected, text);
    const g = oracle(text);
    const viaGate = g.threw === 'K2_FREEZE_PROGRAM_PAGE_MISSING' ? 'K2_FREEZE_PROGRAM_V1' : g.threw === 'K2_FREEZE_PROGRAM_FROZEN_BY_INVALID' ? 'UNKNOWN'
      : g.reason === 'COORDINATOR_FREEZE' ? 'COORDINATOR' : g.reason === 'NOT_PROGRAM_FROZEN' ? null : `?${JSON.stringify(g)}`;
    assert.equal(viaGate, expected, `the gate classifies the same way: ${text}`);
  }
});

/* ------------------------------------------------------------------------------------------------------------------------------------------
 * NOTE_2 (plan-coord 13:34:47, sha256 74b99335), second fix round: UNSEEN across families, the K2's registered market, and the two test gaps of the delta review.
 * ---------------------------------------------------------------------------------------------------------------------------------------- */

test('NOTE_2 item 1: labels are per market, UNSEEN per family: a read whose range has an UNSEEN day of ANY family of the market is refused LABEL_READ_CROSS_FAMILY_UNSEEN (no SEEN mark, no read record, an access-log row); the family that holds the range reads it itself; a range with no foreign UNSEEN day reads', () => {
  const w = world(); const A = fam('XU_A'); const B = fam('XU_B'); const C = fam('XU_C'); const D = fam('XU_D');
  fx.bind(A); fx.bind(B);
  mark(B, 'UNSEEN'); // B's own range [11-01, 11-30]; A has no marks: its days are SEEN by default
  const before = [A, B].map((f) => marksOf(f).length);
  refuses(() => panel.readLabels(w.request(A, { stage: 'SEEN' }), w.ctx), 'LABEL_READ_CROSS_FAMILY_UNSEEN');
  refuses(() => panel.readLabels(w.request(A, { stage: 'UNSEEN_FIRST_READ' }), w.ctx), 'LABEL_READ_CROSS_FAMILY_UNSEEN');
  refuses(() => panel.readLabels(w.request(A, { from: '2026-11-20', to: '2026-11-25' }), w.ctx), 'LABEL_READ_CROSS_FAMILY_UNSEEN');
  assert.deepEqual([A, B].map((f) => marksOf(f).length), before, 'nothing was marked: B\'s unseen days were not burned');
  assert.equal(lines(w.ctx.readLedgerFile).length, 0, 'no read record');
  assert.equal(trials.segmentsFor(B, '2026-11-01', '2026-11-30').pieces[0].label, 'UNSEEN');
  const refused = lines(w.ctx.accessLogFile).filter((r) => r.op === 'HOLDOUT_READ_REFUSED');
  assert.equal(refused.length, 3);
  assert.equal(refused.every((r) => r.code === 'LABEL_READ_CROSS_FAMILY_UNSEEN' && r.dataset === 'PANEL_LABELS_V1'), true);
  // the holder reads its own range under the current stage rules (a SEEN-stage request is still refused; the first read is not)
  refuses(() => panel.readLabels(w.request(B, { stage: 'SEEN' }), w.ctx), 'LABEL_READ_UNSEEN_NOT_PERMITTED');
  assert.deepEqual(labelsOf(panel.readLabels(w.request(B, { stage: 'UNSEEN_FIRST_READ' }), w.ctx)), ['VALUE']);
  assert.deepEqual(trials.segmentsFor(B, '2026-11-01', '2026-11-30').pieces.map((p) => p.label), ['SEEN']);
  // once B's range is SEEN, A may read it (an already SEEN range reads)
  assert.deepEqual(labelsOf(panel.readLabels(w.request(A, { stage: 'SEEN' }), w.ctx)), ['VALUE']);
  // a foreign UNSEEN range outside the requested range does not block; neither does an UNSEEN range of another market
  fx.bind(C); fx.bind(D, fx.COORD, 'US_EQUITY');
  mark(C, 'UNSEEN', { from: '2026-12-01', to: '2026-12-31' });
  mark(D, 'UNSEEN', { market: 'US_EQUITY' });
  assert.deepEqual(labelsOf(panel.readLabels(w.request(A, { stage: 'SEEN', to: '2026-11-30' }), w.ctx)), ['VALUE'], 'C is UNSEEN only in December; D is another market');
  refuses(() => panel.readLabels(w.request(A, { stage: 'SEEN', to: '2026-12-31' }), w.ctx), 'LABEL_READ_CROSS_FAMILY_UNSEEN');
});

test('NOTE_2 item 2: the K2 registration market must equal request.market (aliases normalised): a CN_A family cannot read CRYPTO or US labels (LABEL_READ_MARKET_MISMATCH, nothing marked); the aliases of the ledger read as the same market', () => {
  const w = world(); const F = fam('MKT'); fx.bind(F);
  const before = marksOf(F).length;
  refuses(() => panel.readLabels(w.request(F, { market: 'CRYPTO', windows: ['W4H'] }), w.ctx), 'LABEL_READ_MARKET_MISMATCH');
  refuses(() => panel.readLabels(w.request(F, { market: 'US' }), w.ctx), 'LABEL_READ_MARKET_MISMATCH');
  assert.equal(marksOf(F).length, before, 'no SEEN mark under the wrong market');
  assert.equal(lines(w.ctx.readLedgerFile).length, 0);
  const refused = lines(w.ctx.accessLogFile).filter((r) => r.op === 'HOLDOUT_READ_REFUSED');
  assert.deepEqual(refused.map((r) => r.code), ['LABEL_READ_MARKET_MISMATCH', 'LABEL_READ_MARKET_MISMATCH']);
  // aliases: CN for CN, US_EQUITY and US for US, CRYPTO and CRYPTO_USDM_PERP for CRYPTO
  const alias = (registered, requested, windows) => { const G = fam(`MKT_${registered}`); fx.bind(G, fx.COORD, registered); return panel.readLabels(w.request(G, { market: requested, windows }), w.ctx).record.families; };
  assert.deepEqual(alias('CN', 'CN', ['W1S']).length, 1);
  assert.deepEqual(alias('US_EQUITY', 'US', ['W1S']).length, 1);
  assert.deepEqual(alias('US', 'US', ['W1S']).length, 1);
  assert.deepEqual(alias('CRYPTO', 'CRYPTO', ['W4H']).length, 1);
  assert.deepEqual(alias('CRYPTO_USDM_PERP', 'CRYPTO', ['W4H']).length, 1);
  const H = fam('MKT_US_AS_CN'); fx.bind(H, fx.COORD, 'US_EQUITY');
  refuses(() => panel.readLabels(w.request(H, {}), w.ctx), 'LABEL_READ_MARKET_MISMATCH');
  const J = fam('MKT_TWO'); const K = fam('MKT_TWO_B'); fx.bind(J); fx.bind(K, fx.COORD, 'CRYPTO');
  refuses(() => panel.readLabels(w.request(J, { families: [J, K] }), w.ctx), 'LABEL_READ_MARKET_MISMATCH', 'one wrong market among the declared families refuses the read');
});

test('stage FORWARD is closed even when nothing is reserved anywhere (the delta review\'s surviving mutant): FORWARD_READ_TIME_NOT_IN_LEDGER, nothing marked', () => {
  const w = world(); const F = fam('FWD_NONE'); fx.bind(F);
  assert.deepEqual(trials.segmentsFor(F, '2026-11-01', '2026-11-30').reservations, [], 'the ledger holds no reservation at all');
  assert.equal(read(trials.SEGMENTS()).length, 0);
  refuses(() => panel.readLabels(w.request(F, { stage: 'FORWARD', forward: { shadowRef: 'SH-ANY' } }), w.ctx), 'FORWARD_READ_TIME_NOT_IN_LEDGER');
  refuses(() => panel.readLabels(w.request(F, { stage: 'FORWARD' }), w.ctx), 'FORWARD_READ_TIME_NOT_IN_LEDGER');
  assert.equal(read(trials.SEGMENTS()).length, 0);
  assert.equal(lines(w.ctx.readLedgerFile).length, 0);
  assert.deepEqual(labelsOf(panel.readLabels(w.request(F, { stage: 'SEEN' }), w.ctx)), ['VALUE'], 'the same range reads at stage SEEN');
});

test('the SEEN mark carries the market of the K2 registration row: US_EQUITY for a US family, CRYPTO_USDM_PERP for a crypto family, not CN_A', () => {
  // US: real labels
  const usRecord = fx.panelRecord({ producer: 'SMARTFLOW_US', market: 'US', book: 'US_V5', sessionDate: '2026-11-03', evaluatedAt: '2026-11-03T15:07:00.000Z', candidates: [{ securityId: 'XLK' }] });
  const us = fx.fixtureProvider.create({ sessions: { US: fx.fixtureProvider.weekdaySessions('US', '2026-11-02', 20) } });
  us.set('XLK', 'OPEN', '2026-11-03T15:10:00.000Z', 50); us.set('XLK', 'CLOSE', '2026-11-03T21:00:00.000Z', 51, '2026-11-03T21:30:00.000Z');
  us.set('SPY', 'OPEN', '2026-11-03T15:10:00.000Z', 400); us.set('SPY', 'CLOSE', '2026-11-03T21:00:00.000Z', 404, '2026-11-03T21:30:00.000Z');
  const usStore = panel.createStore({ dir: path.join(fx.tmp('w18-gate-us-'), 'labels') });
  panel.materialize({ records: [usRecord], windows: ['W1S'], provider: us, store: usStore, now: '2026-11-04T00:00:00.000Z' });
  const F = fam('MARK_US'); fx.bind(F, fx.COORD, 'US_EQUITY');
  const outUs = panel.readLabels(fx.request(F, [usRecord], { market: 'US', windows: ['W1S'] }), fx.ctxFor(usStore));
  assert.deepEqual(labelsOf(outUs), ['VALUE']);
  assert.deepEqual(marksOf(F).map((m) => [m.label, m.market]), [['SEEN', 'US_EQUITY']]);
  // crypto: an immature label is still a returned row
  const crRecord = fx.panelRecord({ producer: 'SMARTFLOW_CRYPTO', market: 'CRYPTO', book: 'C17', sessionDate: '2026-11-03', evaluatedAt: '2026-11-03T10:20:00.000Z', candidates: [{ securityId: 'ETHUSDT' }] });
  const crStore = panel.createStore({ dir: path.join(fx.tmp('w18-gate-cr-'), 'labels') });
  panel.materialize({ records: [crRecord], windows: ['W4H'], provider: fx.fixtureProvider.create({}), store: crStore, now: '2026-11-03T11:00:00.000Z' });
  const G = fam('MARK_CRYPTO'); fx.bind(G, fx.COORD, 'CRYPTO_USDM_PERP');
  const outCr = panel.readLabels(fx.request(G, [crRecord], { market: 'CRYPTO', windows: ['W4H'] }), fx.ctxFor(crStore));
  assert.equal(outCr.rows.length, 1);
  assert.deepEqual(marksOf(G).map((m) => [m.label, m.market]), [['SEEN', 'CRYPTO_USDM_PERP']]);
});
