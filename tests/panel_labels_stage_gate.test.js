'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const trials = require('../services/trial-ledger');
const authority = require('../services/independent-verifier/authority');
const { read } = require('../packages/ledger');
const panel = require('../services/panel-labels');
const fx = require('./_panel_labels_fixture');

/**
 * W18 part 2, acceptance R-2 and R-3 (contract section 7.1 LB-4, LB-5; RF1118 star P1 / P3; W05 ruling: marks come from the trial ledger only).
 * A read is gated by trial-ledger segmentsFor: SEEN readable; UNSEEN only as the registered K2's own first read and never for a program frozen K2;
 * FORWARD_RESERVED only for its holder after its declared read time, then FORWARD_READ. Every read appends a read record and a DATA_SEGMENT_MARK_V1 SEEN mark.
 */
const AUTH = 'W18_TEST_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, code);
const EVALUATOR = authority.loadConfig().holdoutScorerPrincipal;

const K2_BYTES = new Map();
function k2(id, frozenBy) {
  const text = `# ${id}\n\n## 0. file head\n\n- **作者与冻结者**：design agent drafted, 冻结者 ${frozenBy}，2026-11-23T00:00:00+08:00。\n`;
  const sha256 = sha(text);
  K2_BYTES.set(sha256, Buffer.from(text));
  return { id, sha256 };
}
const COORD = k2('K2-COORD', 'COORDINATOR');
const PROGRAM = k2('K2-PROGRAM', 'K2_FREEZE_PROGRAM_V1');
const COORD_OTHER = k2('K2-COORD-OTHER', 'COORDINATOR');

function world() {
  const work = tmp('w18-gate-');
  const labelsDir = path.join(work, 'labels');
  const store = panel.createStore({ dir: labelsDir });
  const record = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: '600000.SH' }] });
  const provider = fx.cnProvider();
  fx.setCnW1(provider, '600000.SH', 10, 10.5);
  fx.setCnW1(provider, 'CSI300', 4000, 4040);
  panel.materialize({ records: [record], windows: ['W1S'], provider, store, now: '2026-11-04T00:00:00.000Z' });
  const ctx = { store, holdoutDirs: [labelsDir], accessLogFile: path.join(work, 'access.jsonl'), readLedgerFile: path.join(work, 'reads.jsonl'), registeredBy: AUTH, k2Bytes: (ref) => K2_BYTES.get(ref.sha256) || null };
  const request = (family, o = {}) => ({ principal: EVALUATOR, k2Ref: COORD, stage: 'SEEN', market: 'CN', families: [family], from: '2026-11-01', to: '2026-11-30', windows: ['W1S'],
    readAt: '2026-11-05T00:00:00.000Z', panelRecords: [record], ...o });
  return { work, ctx, record, request };
}
const mark = (family, label, extra = {}) => trials.markSegments({ family_id: family, market: 'CN_A', from: '2026-11-01', to: '2026-11-30', label, reason: 'W18 stage gate fixture', ...extra }, { registeredBy: AUTH, registeredAt: '2026-11-01T00:00:00.000Z' });
const register = (family, k2Ref) => trials.register({ family_id: family, market: 'CN_A', study_ref: 'W18_STAGE', k2_sha256: k2Ref.sha256, stage: 'SIGNAL', role: 'SIGNAL_TEST', config_label: `c-${family}-${k2Ref.id}`, rule_config: { family, k2: k2Ref.id } },
  { registeredBy: AUTH, registeredAt: '2026-11-01T00:00:00.000Z' });
const marksOf = (family) => read(trials.SEGMENTS()).filter((m) => m.family_id === family);
const labelsOf = (out) => out.rows.map((r) => r.label.state);

test('R-2 / R-3 a SEEN range is readable; the read appends a read record (LB-5) and a SEEN mark whose source is the read record sha256; segmentsFor then shows SEEN from that mark; a replay adds a record but no second mark', () => {
  const w = world();
  const F = 'W18_GATE_SEEN';
  const out = panel.readLabels(w.request(F), w.ctx);
  assert.deepEqual(labelsOf(out), ['VALUE']);
  const [rec] = lines(w.ctx.readLedgerFile);
  for (const k of ['readerRole', 'k2Ref', 'stage', 'families', 'from', 'to', 'windows', 'readAt', 'rowsReturned', 'sha256']) assert.ok(k in rec, `read record has ${k}`);
  assert.deepEqual([rec.readerRole, rec.stage, rec.families, rec.from, rec.to, rec.windows, rec.readAt, rec.rowsReturned], [EVALUATOR, 'SEEN', [F], '2026-11-01', '2026-11-30', ['W1S'], '2026-11-05T00:00:00.000Z', 1]);
  assert.deepEqual(rec.k2Ref, COORD);
  assert.equal(rec.sha256, panel.readRecordHashOf(rec), 'the record sha256 is the hash of the record content');
  const marks = marksOf(F);
  assert.equal(marks.length, 1);
  assert.deepEqual([marks[0].label, marks[0].from, marks[0].to, marks[0].market, marks[0].seen_kind], ['SEEN', '2026-11-01', '2026-11-30', 'CN_A', null]);
  assert.equal(marks[0].source_refs[0].kind, 'PANEL_LABEL_READ');
  assert.equal(marks[0].source_refs[0].read_record_sha256, rec.sha256);
  const { pieces } = trials.segmentsFor(F, '2026-11-01', '2026-11-30');
  assert.deepEqual(pieces.map((p) => [p.from, p.to, p.label, p.source === marks[0].mark_id]), [['2026-11-01', '2026-11-30', 'SEEN', true]]);

  panel.readLabels(w.request(F, { readAt: '2026-11-06T00:00:00.000Z' }), w.ctx);
  assert.equal(lines(w.ctx.readLedgerFile).length, 2, 'the replay is a read and is recorded');
  assert.equal(marksOf(F).length, 1, 'the same read replayed produces one mark only');
  panel.readLabels(w.request(F, { windows: ['W1S'], from: '2026-11-01', to: '2026-11-20' }), w.ctx);
  assert.equal(marksOf(F).length, 2, 'a different range is a different read and gets its own mark');
});

test('R-2 an UNSEEN range: a program frozen K2 is refused LABEL_READ_UNSEEN_NOT_PERMITTED (nothing returned, nothing marked); a K2 that is not registered for the family, an unreadable K2 and a SEEN-stage request are refused too; the registered coordinator-frozen K2 reads it once and the range turns SEEN', () => {
  const w = world();
  const F = 'W18_GATE_UNSEEN';
  mark(F, 'UNSEEN');
  register(F, COORD); register(F, PROGRAM);
  const before = marksOf(F).length;
  const unseen = (o) => w.request(F, { stage: 'UNSEEN_FIRST_READ', ...o });
  refuses(() => panel.readLabels(unseen({ k2Ref: PROGRAM }), w.ctx), 'LABEL_READ_UNSEEN_NOT_PERMITTED');
  refuses(() => panel.readLabels(unseen({ k2Ref: COORD_OTHER }), w.ctx), 'LABEL_READ_UNSEEN_NOT_PERMITTED');
  refuses(() => panel.readLabels(unseen({ k2Ref: { id: 'K2-GONE', sha256: sha('gone') } }), w.ctx), 'LABEL_READ_UNSEEN_NOT_PERMITTED');
  refuses(() => panel.readLabels(w.request(F, { stage: 'SEEN' }), w.ctx), 'LABEL_READ_UNSEEN_NOT_PERMITTED');
  assert.equal(marksOf(F).length, before, 'a refused read marks nothing');
  assert.equal(lines(w.ctx.readLedgerFile).length, 0, 'a refused read leaves no read record');
  assert.equal(trials.segmentsFor(F, '2026-11-01', '2026-11-30').pieces[0].label, 'UNSEEN');
  const refused = lines(w.ctx.accessLogFile).filter((r) => r.op === 'HOLDOUT_READ_REFUSED');
  assert.equal(refused.length, 4);
  assert.equal(refused.every((r) => r.code === 'LABEL_READ_UNSEEN_NOT_PERMITTED' && r.dataset === 'PANEL_LABELS_V1'), true);

  const ok = panel.readLabels(unseen({ k2Ref: COORD }), w.ctx);
  assert.deepEqual(labelsOf(ok), ['VALUE']);
  assert.deepEqual(trials.segmentsFor(F, '2026-11-01', '2026-11-30').pieces.map((p) => [p.from, p.to, p.label]), [['2026-11-01', '2026-11-30', 'SEEN']], 'R-3: after the read the range is SEEN');
  assert.equal(marksOf(F).filter((m) => m.label === 'SEEN').length, 1);
  // once SEEN, the same data is development information: a program frozen K2 may read it as SEEN, and nobody can claim it as an UNSEEN first read again
  assert.deepEqual(labelsOf(panel.readLabels(w.request(F, { k2Ref: PROGRAM, stage: 'SEEN' }), w.ctx)), ['VALUE']);
});

test('R-2 FORWARD_RESERVED: a non-holder is refused; the holder is refused before its declared read time and passes after it; the read turns the range FORWARD_READ and it stays SEEN for others; the part still reserved stays closed', () => {
  const w = world();
  const F = 'W18_GATE_FORWARD';
  mark(F, 'FORWARD_RESERVED', { from: '2026-11-01', to: '2026-12-31', shadow_ref: 'SH-A' });
  const fwd = (o) => w.request(F, { stage: 'FORWARD', forward: { shadowRef: 'SH-A', declaredReadAt: '2026-12-01T00:00:00.000Z' }, readAt: '2026-12-02T00:00:00.000Z', ...o });
  refuses(() => panel.readLabels(w.request(F, { stage: 'SEEN' }), w.ctx), 'LABEL_READ_FORWARD_NOT_PERMITTED');
  refuses(() => panel.readLabels(fwd({ forward: { shadowRef: 'SH-B', declaredReadAt: '2026-12-01T00:00:00.000Z' } }), w.ctx), 'LABEL_READ_FORWARD_NOT_PERMITTED');
  refuses(() => panel.readLabels(fwd({ readAt: '2026-11-05T00:00:00.000Z' }), w.ctx), 'LABEL_READ_FORWARD_BEFORE_READ_TIME');
  refuses(() => panel.readLabels(fwd({ forward: undefined }), w.ctx), 'LABEL_READ_FORWARD_NOT_PERMITTED');
  assert.equal(marksOf(F).length, 1, 'refusals mark nothing');
  assert.equal(lines(w.ctx.readLedgerFile).length, 0);

  const ok = panel.readLabels(fwd({ to: '2026-11-30' }), w.ctx);
  assert.deepEqual(labelsOf(ok), ['VALUE']);
  const { reservations, pieces } = trials.segmentsFor(F, '2026-11-01', '2026-12-31');
  assert.deepEqual(reservations.map((r) => [r.from, r.to, r.label, r.shadow_ref]), [['2026-11-01', '2026-12-31', 'FORWARD_RESERVED', 'SH-A'], ['2026-11-01', '2026-11-30', 'FORWARD_READ', 'SH-A']]);
  assert.deepEqual(pieces.map((p) => [p.from, p.to, p.label]), [['2026-11-01', '2026-11-30', 'SEEN'], ['2026-12-01', '2026-12-31', 'SEEN']]);
  const [rec] = lines(w.ctx.readLedgerFile);
  assert.deepEqual(rec.forward, { shadowRef: 'SH-A', declaredReadAt: '2026-12-01T00:00:00.000Z' });
  // the part that was read is spent; the rest of the reservation is still closed to everyone else
  assert.deepEqual(labelsOf(panel.readLabels(w.request(F, { stage: 'SEEN', to: '2026-11-30' }), w.ctx)), ['VALUE']);
  refuses(() => panel.readLabels(w.request(F, { stage: 'SEEN', to: '2026-12-31' }), w.ctx), 'LABEL_READ_FORWARD_NOT_PERMITTED');
});

test('a label is returned only when its whole window lies inside [from, to] (the read must not show prices after the range the gate checked); the request must name allowed windows and families', () => {
  const w = world();
  const F = 'W18_GATE_RANGE';
  assert.deepEqual(labelsOf(panel.readLabels(w.request(F, { to: '2026-11-02' }), w.ctx)), [], 'the window ends 2026-11-03, outside the range');
  assert.deepEqual(labelsOf(panel.readLabels(w.request(F, { to: '2026-11-03' }), w.ctx)), ['VALUE']);
  assert.deepEqual(labelsOf(panel.readLabels(w.request(F, { from: '2026-11-03', to: '2026-11-30' }), w.ctx)), [], 'the evaluation date is before the range');
  refuses(() => panel.readLabels(w.request(F, { windows: ['W7S'] }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { windows: [] }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { families: [] }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { stage: 'ANYTHING' }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { k2Ref: { id: 'x', sha256: 'nothex' } }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
  refuses(() => panel.readLabels(w.request(F, { from: '2026-11-30', to: '2026-11-01' }), w.ctx), 'LABEL_READ_REQUEST_INVALID');
});

test('a mark that cannot be written stops the read: no rows are returned and an abort row is appended', () => {
  const w = world();
  const F = 'W18_GATE_MARKFAIL';
  refuses(() => panel.readLabels(w.request(F), { ...w.ctx, registeredBy: 'not-the-authority' }), 'LABEL_READ_MARK_FAILED');
  const rows = lines(w.ctx.readLedgerFile);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].schema, 'PANEL_LABEL_READ_ABORTED_V1');
  assert.equal(rows[1].readRecordSha256, rows[0].sha256);
  assert.equal(marksOf(F).length, 0);
});
