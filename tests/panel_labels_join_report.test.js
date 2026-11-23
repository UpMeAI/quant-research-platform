'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const trials = require('../services/trial-ledger');
const panel = require('../services/panel-labels');
const fx = require('./_panel_labels_fixture');

/**
 * W18 part 2, acceptance R-6 .. R-10 (contract section 7.1 LB-2, LB-8, section 7.3 ES-1..ES-4, section 8.2) and the independent review fix round (NOTE_1 item 1, P2 (c) and (d), P3):
 * join by (candidateId, recordHash), a record hash that is the one canonical JSON function of the W07 digest vectors, the panel files never written (observed, not assumed),
 * the report template (a sample size only on a structured line with its method; event clustering mandatory for scan books), truncated candidates without labels,
 * and the four questions as tables without a conclusion. Report flows read the table through readLabels.
 */
const tmp = fx.tmp;
const sha256File = (f) => fx.sha(fs.readFileSync(f));
const SECURITIES = ['600001.SH', '600002.SH'];
const RETURN_KEYS = ['grossReturn', 'benchmarkReturn', 'excessReturn'];
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, code);

function cnLabelled(securities = SECURITIES) {
  const record = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: securities.map((securityId) => ({ securityId })) });
  const provider = fx.cnProvider();
  for (const s of securities) fx.setCnW1(provider, s, 10, 10.5);
  fx.setCnW1(provider, 'CSI300', 4000, 4040);
  const store = panel.createStore({ dir: path.join(tmp('w18-join-'), 'labels') });
  panel.materialize({ records: [record], windows: ['W1S'], provider, store, now: '2026-11-04T00:00:00.000Z' });
  return { record, provider, store };
}

test('R-6 labels join to the panel only by (candidateId, recordHash): a record written again with another hash is UNKNOWN / PANEL_RECORD_MISMATCH (no return key); a record with the same security and date but another id is not used; the exact version is found among several versions of one candidate', () => {
  const { record, store } = cnLabelled();
  const labels = fx.rowsOf(store);
  const ok = panel.joinLabels({ labels, panelRecords: [record] });
  assert.deepEqual(ok.map((j) => [j.candidateId, j.state, j.panel.securityId]), record.rows.map((r) => [r.candidateId, 'VALUE', r.securityId]));
  assert.equal(ok[0].panel.sessionDate, '2026-11-02');

  // the record was written again with another output: same candidateId, another recordHash
  const again = fx.rewritten(record);
  assert.equal(again.rows[0].candidateId, record.rows[0].candidateId);
  assert.notEqual(again.recordHash, record.recordHash);
  const bad = panel.joinLabels({ labels, panelRecords: [again] });
  for (const j of bad) {
    assert.deepEqual([j.state, j.reasonCode], ['UNKNOWN', 'PANEL_RECORD_MISMATCH']);
    assert.equal(RETURN_KEYS.some((k) => k in j || k in j.label), false, 'a mismatched label shows no return');
    assert.equal(j.mismatchDetail, 'RECORD_HASH_DIFFERS');
    assert.equal(j.panel, null);
  }
  // both versions supplied, the newer first: the label finds the version it was computed against (the key is the pair, not the id)
  const both = panel.joinLabels({ labels, panelRecords: [again, record] });
  assert.deepEqual(both.map((j) => j.state), ['VALUE', 'VALUE']);
  assert.equal(both.every((j) => j.panelRecordHash === record.recordHash), true);
  // content changed under a stale hash field: the stated hash would match the label, the recomputed one does not
  for (const j of panel.joinLabels({ labels, panelRecords: [fx.tampered(record)] })) assert.deepEqual([j.state, j.reasonCode, j.mismatchDetail], ['UNKNOWN', 'PANEL_RECORD_MISMATCH', 'RECORD_CONTENT_HASH_INVALID']);
  // same security, same date, different evaluation (different evaluatedAt => different ids): the labels do not move onto it
  const other = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T08:00:00.000Z', candidates: SECURITIES.map((securityId) => ({ securityId })) });
  assert.notEqual(other.rows[0].candidateId, record.rows[0].candidateId);
  for (const j of panel.joinLabels({ labels, panelRecords: [other] })) assert.deepEqual([j.state, j.reasonCode, j.mismatchDetail, j.panel], ['UNKNOWN', 'PANEL_RECORD_MISMATCH', 'CANDIDATE_ID_NOT_IN_PANEL', null]);
  assert.equal(labels.every((l) => l.panelRecordHash === record.recordHash), true);
});

test('R-6 the read path applies the same join: a record written again, or altered under its hash, comes back UNKNOWN / PANEL_RECORD_MISMATCH', () => {
  const { record, store } = cnLabelled();
  for (const variant of [fx.rewritten(record), fx.tampered(record)]) {
    const rows = fx.readJoined({ store, records: [variant], windows: ['W1S'] });
    assert.deepEqual(rows.map((r) => [r.state, r.reasonCode]), [['UNKNOWN', 'PANEL_RECORD_MISMATCH'], ['UNKNOWN', 'PANEL_RECORD_MISMATCH']]);
    assert.equal(rows.some((r) => RETURN_KEYS.some((k) => k in r || k in r.label)), false);
  }
  assert.deepEqual(fx.readJoined({ store, records: [record], windows: ['W1S'] }).map((r) => r.state), ['VALUE', 'VALUE']);
});

/* ------------------------------------------------------------------------------- recordHash = the W07 canonical JSON function (NOTE_1 item 1) */

const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'w18-panel-labels', 'id-digest-vectors.w07-a7efd031.json'), 'utf8')).vectors;
const canon = (x) => trials.canonicalJson(x);
/** The digest input object of a W07 vector: evidenceRefs ordered and de-duplicated by canonical text, ruleRefs sorted and de-duplicated (see the vectors file, "how"). */
const digestInput = (v) => ({
  block: v.block, bookKey: v.bookKey, contract: 'PICK_TRADE_PLANS_V1_SUPPLEMENT_1', decisionCutoff: v.decisionCutoff,
  evidenceRefs: [...new Map(v.evidenceRefs.map((e) => [canon(e), e])).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]),
  market: v.market, producer: v.producer, ruleRefs: [...new Set(v.ruleRefs)].sort(), securityId: v.securityId, targetSession: v.targetSession,
});
/** A second, independent canonicalizer written the way the W07 vectors were made (python json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)). */
function pyCanonical(x) {
  if (Array.isArray(x)) return `[${x.map(pyCanonical).join(',')}]`;
  if (x !== null && typeof x === 'object') return `{${Object.keys(x).sort((a, b) => { const A = [...a]; const B = [...b]; for (let i = 0; i < Math.min(A.length, B.length); i += 1) { const d = A[i].codePointAt(0) - B[i].codePointAt(0); if (d) return d; } return A.length - B.length; }).map((k) => `${JSON.stringify(k)}:${pyCanonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}

test('recordHash is the W07 canonical JSON function: the QRP canonical JSON reproduces every W07 vector bit for bit (unicode and floats included), and recordHashOf verifies a record that carries the W07 digest as its recordHash', () => {
  assert.equal(VECTORS.length, 3);
  for (const v of VECTORS) {
    const input = digestInput(v);
    assert.equal(canon(input), v.canonicalJson, `${v.name}: canonical JSON text`);
    assert.equal(fx.sha(canon(input)), v.planInputDigest, `${v.name}: sha256 of the UTF-8 bytes`);
    assert.equal(panel.recordHashOf({ ...input, recordHash: v.planInputDigest }), v.planInputDigest, `${v.name}: the hash excludes the recordHash field itself`);
    assert.notEqual(panel.recordHashOf({ ...input, extraEnvelopeField: 'x', recordHash: v.planInputDigest }), v.planInputDigest, `${v.name}: any other field changes the hash`);
  }
  assert.ok(VECTORS.some((v) => /é中/.test(v.canonicalJson)) && VECTORS.some((v) => /68250\.5/.test(v.canonicalJson)), 'the vectors cover non-ASCII text and a float');
});

test('a panel record hashed by an independent python-style canonicalizer (unicode ids, floats, nested arrays) is verified by the join; labels computed against it join as values', () => {
  const rec = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: '600001.SH',
    features: [{ name: 'ƒ_é中', state: 'VALUE', value: 68250.5, knownAt: '2026-11-02T06:00:00.000Z' }, { name: 'z', state: 'VALUE', value: [0.1, -3, 'Ω'], knownAt: '2026-11-02T06:00:00.000Z' }] }] });
  const { recordHash: stated, ...rest } = rec;
  assert.equal(fx.sha(pyCanonical(rest)), stated, 'the fixture hash (QRP canonical JSON) equals the independent canonicalizer');
  const provider = fx.cnProvider(); fx.setCnW1(provider, '600001.SH', 10, 10.5); fx.setCnW1(provider, 'CSI300', 4000, 4040);
  const store = panel.createStore({ dir: path.join(tmp('w18-py-'), 'labels') });
  panel.materialize({ records: [rec], windows: ['W1S'], provider, store, now: '2026-11-04T00:00:00.000Z' });
  assert.deepEqual(fx.readJoined({ store, records: [rec], windows: ['W1S'] }).map((r) => r.state), ['VALUE']);
});

test('an extra envelope field the hash does not cover is a clear refusal: the join says which field, and the label job refuses to label such a record', () => {
  const { record, store } = cnLabelled();
  const withEnvelope = { ...record, writtenAt: '2026-11-02T07:31:00.000Z' };
  for (const j of panel.joinLabels({ labels: fx.rowsOf(store), panelRecords: [withEnvelope] })) {
    assert.deepEqual([j.state, j.reasonCode, j.mismatchDetail, j.mismatchField], ['UNKNOWN', 'PANEL_RECORD_MISMATCH', 'RECORD_HASH_EXCLUDES_FIELD', 'writtenAt']);
  }
  const provider = fx.cnProvider(); fx.setCnW1(provider, '600001.SH', 10, 10.5);
  const fresh = panel.createStore({ dir: path.join(tmp('w18-env-'), 'labels') });
  const job = (records) => panel.materialize({ records, windows: ['W1S'], provider, store: fresh, now: '2026-11-04T00:00:00.000Z' });
  refuses(() => job([withEnvelope]), 'LABEL_PANEL_RECORD_HASH_INVALID');
  refuses(() => job([fx.tampered(record)]), 'LABEL_PANEL_RECORD_HASH_INVALID');
  assert.equal(fs.existsSync(fresh.file), false, 'nothing was labelled against a record that does not match its hash');
});

/* ------------------------------------------------------------------------------------------------------------------------------ R-7 */

function spyWrites(run) {
  const written = [];
  const names = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'copyFileSync', 'truncateSync', 'createWriteStream', 'openSync'];
  const orig = {};
  for (const name of names) {
    orig[name] = fs[name];
    fs[name] = function spy(p, ...rest) { if (name !== 'openSync' || /[wa+]/.test(String(rest[0] === undefined ? 'r' : rest[0]))) written.push(path.resolve(String(p))); return orig[name].call(this, p, ...rest); };
  }
  try { run(); } finally { for (const name of names) fs[name] = orig[name]; }
  return written;
}

test('R-7 part 2 never writes a panel file: observed (every write call is recorded while the label job and the controlled read run, none touches the panel directory, which is read only), the file bytes are unchanged, and the observer is shown to see writes', () => {
  const { record, provider } = cnLabelled();
  const base = tmp('w18-r7-');
  const panelDir = path.join(base, 'panel'); fs.mkdirSync(panelDir);
  const panelFile = path.join(panelDir, 'panel.jsonl');
  fs.writeFileSync(panelFile, `${JSON.stringify(record)}\n`);
  const before = sha256File(panelFile);
  fs.chmodSync(panelFile, 0o444); fs.chmodSync(panelDir, 0o555);
  const labelsDir = path.join(base, 'labels');
  const store = panel.createStore({ dir: labelsDir });
  let rows;
  try {
    const written = spyWrites(() => {
      const loaded = fs.readFileSync(panelFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      panel.materialize({ records: loaded, windows: ['W1S'], provider, store, now: '2026-11-04T00:00:00.000Z' });
      rows = fx.readJoined({ store, records: loaded, windows: ['W1S'] });
    });
    assert.equal(rows.length, 2);
    assert.ok(written.some((p) => p === store.file), 'the observer sees the label file written');
    assert.ok(written.length >= 3, `the observer saw ${written.length} writes`);
    assert.deepEqual(written.filter((p) => p === panelDir || p.startsWith(`${panelDir}${path.sep}`)), [], 'no write call touched the panel directory');
    // control: a write into the panel directory would be seen (and refused by the read only directory)
    const control = spyWrites(() => { try { fs.writeFileSync(path.join(panelDir, 'x.jsonl'), 'x'); } catch { /* read only */ } });
    assert.ok(control.length >= 1 && control.every((p) => p === path.join(panelDir, 'x.jsonl')), 'the observer sees the write attempt (once per layer: Node versions differ)');
    assert.equal(sha256File(panelFile), before, 'the panel file is byte for byte unchanged');
  } finally { fs.chmodSync(panelDir, 0o755); fs.chmodSync(panelFile, 0o644); }
});

test('R-7 no producer or desk code reads the label table (static scan finds a planted reader; the real producer trees are scanned by git grep in the report)', () => {
  const dir = tmp('w18-r7s-');
  const producer = path.join(dir, 'producer'); fs.mkdirSync(path.join(producer, 'src'), { recursive: true });
  fs.writeFileSync(path.join(producer, 'src', 'panel.js'), "'use strict';\nmodule.exports = { write: () => 1 };\n");
  assert.deepEqual(panel.staticScan.findLabelTableReaders(producer), []);
  fs.writeFileSync(path.join(producer, 'src', 'peek.js'), "const labels = require('../../quant-research-platform/services/panel-labels');\n");
  fs.writeFileSync(path.join(producer, 'src', 'peek2.js'), "const f = '/var/ledger/research/panel_labels/labels.jsonl';\n");
  const hits = panel.staticScan.findLabelTableReaders(producer).map((h) => path.basename(h.file)).sort();
  assert.deepEqual(hits, ['peek.js', 'peek2.js']);
  const src = path.join(__dirname, '..', 'services', 'panel-labels');
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.js') && x !== 'store.js' && x !== 'reader.js')) {
    assert.equal(/\bfs\.(writeFile|appendFile|createWriteStream|rename|unlink|rm|mkdir|copyFile|truncate)(Sync)?\(|fs\.promises/.test(fs.readFileSync(path.join(src, f), 'utf8')), false, `${f} does not write files`);
  }
});

/* ------------------------------------------------------------------------------------------------------------------------------ R-8 */

function c17Records(count, { epoch = () => 'E1', outcome = () => 'NOT_SELECTED_RANK' } = {}) {
  const day = '2026-11-03';
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.parse(`${day}T00:00:00.000Z`) + i * 600000).toISOString();
    const features = [{ name: 'signalEpoch', state: 'VALUE', value: epoch(i), knownAt: at }];
    return fx.panelRecord({ producer: 'SMARTFLOW_CRYPTO', market: 'CRYPTO', book: 'C17', sessionDate: day, evaluatedAt: at, candidates: [{ securityId: 'BTCUSDT', finalOutcome: outcome(i), features }] });
  });
}
function joinedCrypto(records, windows = ['W4H']) {
  const store = panel.createStore({ dir: path.join(tmp('w18-es-'), 'labels') });
  panel.materialize({ records, windows, provider: fx.fixtureProvider.create({}), store, now: '2026-11-03T00:00:00.000Z' });
  return fx.readJoined({ store, records, windows, market: 'CRYPTO' });
}

test('R-8 the same security over 144 C17 scans is 144 rows, 1 date and 1 event; a new signal epoch or a changed outcome starts a new event; an evaluation point where the security is absent breaks the event', () => {
  const joined = joinedCrypto(c17Records(144));
  const s = panel.report.describeSample(joined);
  assert.deepEqual([s.rows, s.dates, s.events], [144, 1, 1]);
  assert.deepEqual(s.industries, { state: 'NOT_APPLICABLE', reasonCode: 'CRYPTO_HAS_NO_INDUSTRY_CLUSTER' });
  assert.deepEqual(s.effectiveSampleSize, { state: 'N/A', reasonCode: 'NO_ESTIMATOR_DECLARED' }, 'not 0, not a pass');
  assert.deepEqual(s.clusterMethods, ['DATE', 'EVENT']);
  const epochs = panel.report.describeSample(joinedCrypto(c17Records(144, { epoch: (i) => (i < 72 ? 'E1' : 'E2') })));
  assert.deepEqual([epochs.rows, epochs.dates, epochs.events], [144, 1, 2]);

  // V6 style: consecutive evaluation points of the book, same security, same final outcome
  const mk = (date, cands) => fx.panelRecord({ sessionDate: date, evaluatedAt: `${date}T07:30:00.000Z`, candidates: cands });
  const recs = [
    mk('2026-11-02', [{ securityId: 'A', finalOutcome: 'SELECTED' }, { securityId: 'B', finalOutcome: 'SELECTED' }, { securityId: 'C', finalOutcome: 'SELECTED' }]),
    mk('2026-11-03', [{ securityId: 'A', finalOutcome: 'SELECTED' }, { securityId: 'B', finalOutcome: 'SELECTED' }]),
    mk('2026-11-04', [{ securityId: 'A', finalOutcome: 'NOT_SELECTED_RANK' }, { securityId: 'B', finalOutcome: 'SELECTED' }, { securityId: 'C', finalOutcome: 'SELECTED' }]),
    mk('2026-11-05', [{ securityId: 'A', finalOutcome: 'SELECTED' }, { securityId: 'B', finalOutcome: 'SELECTED' }]),
  ];
  const store = panel.createStore({ dir: path.join(tmp('w18-es2-'), 'labels') });
  panel.materialize({ records: recs, windows: ['W1S'], provider: fx.cnProvider(), store, now: '2026-11-02T00:00:00.000Z' });
  const joinedV6 = fx.readJoined({ store, records: recs, windows: ['W1S'] });
  const v6 = panel.report.describeSample(joinedV6);
  assert.deepEqual([v6.rows, v6.dates], [10, 4]);
  assert.equal(v6.events, 3 + 1 + 2, 'A: SELECTED x2, NOT_SELECTED_RANK, SELECTED = 3 events; B: 1 event; C: present, absent, present = 2 events');
  assert.deepEqual(v6.clusterMethods, ['DATE'], 'a daily book is not a scan book');
  assert.deepEqual(v6.industries, { state: 'UNKNOWN', reasonCode: 'INDUSTRY_NOT_IN_PANEL' });
  // window overlap: the session calendar is an input, not a guess
  const noCal = panel.report.describeSample(joinedV6, { windows: ['W1S'] });
  assert.deepEqual(noCal.windowOverlap, [{ windowId: 'W1S', state: 'UNKNOWN', reasonCode: 'SESSION_CALENDAR_NOT_PROVIDED' }]);
  const gap = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
  const withCal = panel.report.describeSample(joinedV6, { windows: ['W1S', 'W5S'], sessionGap: gap });
  assert.deepEqual(withCal.windowOverlap, [{ windowId: 'W1S', state: 'NON_OVERLAPPING', minEvaluationGap: 1, lag: 0 }, { windowId: 'W5S', state: 'OVERLAPPING', minEvaluationGap: 1, lag: 4 }]);
});

test('R-8 / ES-1 report template: a sample size or N in any wording is valid only on one structured line that states the number and its method together; row counts must be called rows', () => {
  const check = (t, o) => panel.report.checkReportTemplate(t, o);
  const NO_METHOD = { ok: false, violations: ['SAMPLE_SIZE_WITHOUT_CLUSTER_METHOD'] };
  for (const text of ['样本量 144', 'N = 144', 'sample size 144', 'Sample Size: 144', 'n=144', 'N 144', 'N：12', 'N为12', '有效N为12', '有效 N 12', '有效样本 12', '样本数 144', 'effective n = 12',
    '有效样本量 12，来自 144 个标签', '有效样本量 N/A（未声明估计方法）', '样本数 144\n聚类方法：DATE+EVENT', '聚类方法：DATE+EVENT\n有效样本量：12', '有效样本量 1\n聚类方法：DATE+EVENT']) {
    assert.deepEqual(check(text), NO_METHOD, text);
  }
  for (const text of ['行数 144', '日期数 1；事件数 1', 'N/A', 'in 144 rows', '事件数 144', '未关联行数 0']) {
    assert.equal(check(text).ok, true, text);
  }
  assert.equal(check('有效样本量：12；聚类方法：DATE+EVENT').ok, true);
  assert.equal(check('有效样本量：N/A；聚类方法：DATE；原因：NO_ESTIMATOR_DECLARED').ok, true);
  assert.equal(check('有效样本量：12;聚类方法：DATE').ok, true, 'an ASCII semicolon is accepted');
  assert.deepEqual(check('有效样本量：12；聚类方法：EVENT'), { ok: false, violations: ['CLUSTER_METHOD_MISSING_DATE'] }, 'date is the minimum clustering (ES-2)');
  // ES-2: scan books must cluster by event as well
  const scan = (book, method, o) => check(`账本：${book}\n有效样本量：12；聚类方法：${method}`, o);
  for (const book of ['C17', 'US_V5', 'QUICK_SHOT']) {
    assert.deepEqual(scan(book, 'DATE'), { ok: false, violations: ['CLUSTER_METHOD_MISSING_EVENT'] }, book);
    assert.equal(scan(book, 'DATE+EVENT').ok, true, book);
  }
  assert.equal(scan('CN_STOCK', 'DATE').ok, true, 'a daily book may cluster by date only');
  assert.deepEqual(check('有效样本量：12；聚类方法：DATE', { books: ['C17'] }), { ok: false, violations: ['CLUSTER_METHOD_MISSING_EVENT'] }, 'the books may also come from the caller');
  assert.equal(check('账本：C17, CN_STOCK\n行数 3').ok, true, 'a scan book report that states no sample size needs no method');
  // ES-3
  assert.deepEqual(check('功效不足，结论：不做'), { ok: false, violations: ['POWER_INSUFFICIENT_MUST_NOT_BE_NOT_DO'] }, 'insufficient power is 做 (forward shadow), never 不做');
  assert.equal(check('功效不足，结论：做（前向影子）').ok, true);
});

test('R-8 the rendered report passes its own template: counts, the books, one structured sample line, N/A for the estimate, the cluster method, the overlap lines and the truncation line', () => {
  const records = c17Records(144);
  const joined = joinedCrypto(records);
  const text = panel.report.renderReport({ joined, panelRecords: records, windows: ['W4H'] });
  assert.deepEqual(panel.report.checkReportTemplate(text), { ok: true, violations: [] }, text);
  assert.match(text, /账本：C17/);
  assert.match(text, /行数 144/);
  assert.match(text, /日期数 1/);
  assert.match(text, /事件数 1/);
  assert.match(text, /^有效样本量：N\/A；聚类方法：DATE\+EVENT；原因：NO_ESTIMATOR_DECLARED$/m);
  assert.match(text, /窗口重叠：W4H 重叠/);
  assert.equal(/样本量 *[:：]? *\d/.test(text) || /\bN *= *\d/.test(text), false, 'the rendered report never calls the row count a sample size');
  // a book that is a scan book cannot be reported with a date-only method
  const edited = text.replace('聚类方法：DATE+EVENT', '聚类方法：DATE');
  assert.deepEqual(panel.report.checkReportTemplate(edited), { ok: false, violations: ['CLUSTER_METHOD_MISSING_EVENT'] });
});

/* ------------------------------------------------------------------------------------------------------------------------------ R-9 */

test('R-9 candidates cut by the panel truncation have no label: the label table holds only kept rows, orphan labels are detected, and the report says how many were cut', () => {
  const kept = Array.from({ length: 12 }, (_, i) => ({ securityId: `60000${i}.SH`.padStart(9, '0'), rank: i + 1 }));
  const truncation = { state: 'TRUNCATED', keptCount: 12, totalCount: 15, droppedByOutcome: [{ finalOutcome: 'NOT_SELECTED_RANK', count: 3 }], limitRows: 12, limitBytes: 8388608 };
  const record = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: kept, truncation });
  const provider = fx.cnProvider();
  for (const c of kept) fx.setCnW1(provider, c.securityId, 10, 10.1);
  fx.setCnW1(provider, 'CSI300', 4000, 4040);
  const store = panel.createStore({ dir: path.join(tmp('w18-r9-'), 'labels') });
  const res = panel.materialize({ records: [record], windows: ['W1S'], provider, store, now: '2026-11-04T00:00:00.000Z' });
  assert.equal(res.written, 12);
  assert.deepEqual(res.truncated, [{ evaluationPointId: record.evaluationPointId, truncatedNoLabel: 3 }]);
  const labels = fx.rowsOf(store);
  const ids = new Set(record.rows.map((r) => r.candidateId));
  assert.equal(labels.every((l) => ids.has(l.candidateId)), true);
  assert.deepEqual(panel.orphanLabels(labels, [record]), []);
  const stray = { ...labels[0], candidateId: `${record.evaluationPointId}:DROPPED:abcdef123456` };
  assert.deepEqual(panel.orphanLabels([stray], [record]).map((l) => l.candidateId), [stray.candidateId]);
  const joined = fx.readJoined({ store, records: [record], windows: ['W1S'] });
  const text = panel.report.renderReport({ joined, panelRecords: [record], windows: ['W1S'] });
  assert.match(text, /截断 3 个，无标签/);
  assert.equal(panel.report.checkReportTemplate(text).ok, true);
});

test('truncation checks (TR-3, TR-4): the cut count must equal the dropped counts, kept must equal the rows present, the truncation object must exist; each problem is named per evaluation point', () => {
  let ep = 0;
  const rec = (rows, truncation) => ({ evaluationPointId: `EP-${(ep += 1)}`, rows: rows.map((r) => ({ candidateId: r })), ...(truncation === undefined ? {} : { truncation }) });
  const ok = rec(['a', 'b'], { state: 'NOT_TRUNCATED', keptCount: 2, totalCount: 2, droppedByOutcome: [] });
  const cut = rec(['a', 'b'], { state: 'TRUNCATED', keptCount: 2, totalCount: 5, droppedByOutcome: [{ finalOutcome: 'X', count: 2 }, { finalOutcome: 'Y', count: 1 }] });
  assert.deepEqual(panel.report.truncationSummary([ok, cut]), { truncatedNoLabel: 3, records: [
    { evaluationPointId: ok.evaluationPointId, truncatedNoLabel: 0, droppedByOutcome: [] },
    { evaluationPointId: cut.evaluationPointId, truncatedNoLabel: 3, droppedByOutcome: cut.truncation.droppedByOutcome }], problems: [] });
  const inconsistent = rec(['a', 'b'], { state: 'TRUNCATED', keptCount: 2, totalCount: 5, droppedByOutcome: [{ finalOutcome: 'X', count: 2 }] });
  assert.deepEqual(panel.report.truncationSummary([inconsistent]).problems, [{ evaluationPointId: inconsistent.evaluationPointId, code: 'TRUNCATION_COUNTS_INCONSISTENT' }]);
  const keptWrong = rec(['a', 'b'], { state: 'TRUNCATED', keptCount: 3, totalCount: 5, droppedByOutcome: [{ finalOutcome: 'X', count: 2 }] });
  assert.deepEqual(panel.report.truncationSummary([keptWrong]).problems, [{ evaluationPointId: keptWrong.evaluationPointId, code: 'TRUNCATION_KEPT_COUNT_DIFFERS_FROM_ROWS' }]);
  const missing = rec(['a'], undefined);
  const s = panel.report.truncationSummary([missing]);
  assert.deepEqual(s.problems, [{ evaluationPointId: missing.evaluationPointId, code: 'TRUNCATION_OBJECT_MISSING' }]);
  assert.deepEqual([s.truncatedNoLabel, s.records], [0, []]);
  // the rendered report shows the problems and keeps counting
  const text = panel.report.renderReport({ joined: [], panelRecords: [inconsistent, keptWrong, cut] });
  assert.match(text, /截断记录问题：TRUNCATION_COUNTS_INCONSISTENT/);
  assert.match(text, /截断记录问题：TRUNCATION_KEPT_COUNT_DIFFERS_FROM_ROWS/);
  assert.match(text, /截断 8 个，无标签/);
});

/* ------------------------------------------------------------------------------------------------------------------------------ R-10 */

function questionWorld() {
  const cands = [
    { securityId: 'A1', finalOutcome: 'SELECTED', planned: true, gross: 0.05 }, { securityId: 'A2', finalOutcome: 'SELECTED_SCALED', planned: true, gross: 0.03 },
    { securityId: 'B1', finalOutcome: 'NOT_SELECTED_RANK', gross: -0.01 }, { securityId: 'B2', finalOutcome: 'NOT_SELECTED_RANK', gross: -0.02 },
    { securityId: 'C1', finalOutcome: 'REJECTED_FILTER', gross: -0.015 }, { securityId: 'D1', finalOutcome: 'BLOCKED_ACCOUNT', gross: 0.04 },
    { securityId: 'D2', finalOutcome: 'BLOCKED_RISK', gross: -0.03 }, { securityId: 'N1', finalOutcome: 'NOT_EVALUABLE', gross: null },
  ];
  const record = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: cands.map(({ gross: _g, ...c }) => c) });
  const provider = fx.cnProvider();
  for (const c of cands) if (c.gross !== null) fx.setCnW1(provider, c.securityId, 100, Math.round(100 * (1 + c.gross) * 1e9) / 1e9);
  fx.setCnW1(provider, 'CSI300', 4000, 4040);
  const store = panel.createStore({ dir: path.join(tmp('w18-r10-'), 'labels') });
  panel.materialize({ records: [record], windows: ['W1S'], provider, store, now: '2026-11-04T00:00:00.000Z' });
  return fx.readJoined({ store, records: [record], windows: ['W1S'] });
}
const find = (table, group) => table.rows.find((r) => r.group === group);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('R-10 (synthetic half) the four section 3.2 questions each produce a table from panel plus labels: counts and means only, unknown kept apart from zero, no conclusion; the human delay axis is NOT_PROVIDED because no source carries it', () => {
  const tables = panel.report.questionTables(questionWorld());
  assert.deepEqual(Object.keys(tables), ['SIGNAL_INCREMENT', 'FILTER_QUALITY', 'ACCOUNT_CONSTRAINT', 'HUMAN_DELAY']);
  for (const t of Object.values(tables)) {
    assert.ok(Array.isArray(t.columns) && t.columns.length > 3 && Array.isArray(t.rows) && t.rows.length >= 2, t.id);
    assert.equal(/(conclusion|verdict|significan|recommend|pValue|better|worse|pass|fail)/i.test(JSON.stringify(t)), false, `${t.id} states no conclusion`);
  }
  const s = tables.SIGNAL_INCREMENT;
  const sel = find(s, 'SELECTED'); const all = find(s, 'ALL_CANDIDATES');
  assert.deepEqual([sel.windowId, sel.rows, sel.valueRows, sel.unknownRows, sel.dates], ['W1S', 2, 2, 0, 1]);
  close(sel.meanGrossReturn, 0.04);
  close(sel.meanExcessReturn, 0.03);
  assert.deepEqual([all.rows, all.valueRows, all.unknownRows], [8, 7, 1], 'the candidate without a price is counted as unknown, not as a zero return');
  close(all.meanGrossReturn, 0.045 / 7);

  const f = tables.FILTER_QUALITY;
  assert.deepEqual([find(f, 'NOT_SELECTED_RANK').rows, find(f, 'REJECTED_FILTER').rows, find(f, 'SELECTED').rows], [2, 1, 2]);
  close(find(f, 'NOT_SELECTED_RANK').meanGrossReturn, -0.015);

  const a = tables.ACCOUNT_CONSTRAINT;
  close(find(a, 'BLOCKED_ACCOUNT').meanGrossReturn, 0.04);
  close(find(a, 'BLOCKED_RISK').meanGrossReturn, -0.03);
  assert.deepEqual(find(a, 'BLOCKED_EXECUTION'), { group: 'BLOCKED_EXECUTION', windowId: 'W1S', rows: 0, valueRows: 0, unknownRows: 0, dates: 0,
    meanGrossReturn: { state: 'UNKNOWN', reasonCode: 'NO_VALUE_ROWS' }, meanExcessReturn: { state: 'UNKNOWN', reasonCode: 'NO_VALUE_ROWS' } }, 'an empty group is unknown, not 0');

  const h = tables.HUMAN_DELAY;
  assert.deepEqual([find(h, 'PLAN_LINKED').rows, find(h, 'NOT_PLAN_LINKED').rows], [2, 6]);
  assert.deepEqual(find(h, 'PLAN_LINKED').humanActionDelay, { state: 'NOT_PROVIDED', reasonCode: 'HUMAN_ACTION_TIME_NOT_IN_PANEL_OR_LABEL' });
});

/* ------------------------------------------------------------------------------------------------------------------------------------------
 * NOTE_2 (ES-1 wording): the delta review tried 26 phrasings of a sample size; 7 were flagged and these 19 were not. All of them must now go through the one structured line.
 * ---------------------------------------------------------------------------------------------------------------------------------------- */
const REVIEW_R12_UNCAUGHT = [
  '样本容量 144', '样本规模：144', '样本个数 144', '144 个样本', 'N≥30', 'N ≈ 120', 'N 约 120', 'n（有效）= 12', 'sample count 144', 'number of samples: 144', 'samples = 144',
  '有效观测数 144', '观测数为 144', '总样本 144', '独立样本 144 个', 'N is 144', 'N（行）144', 'the sample is 144 rows', 'we have 144 independent observations',
];
const NOTE_2_PATTERNS = ['样本容量 30', '样本规模 30', '样本数 30', '样本量 30', '30 个样本', '30个样本', 'N≥30', 'N>30', 'N＝30', 'N=30', 'N~30', 'N约30', 'N 30', 'sample size 30', 'Sample Count: 30', 'SAMPLE SIZE = 30'];

test('NOTE_2 / ES-1: the 19 phrasings the delta review found uncaught, and the NOTE_2 patterns, all need the structured line; the same words on the structured line pass; ordinary report lines are not flagged', () => {
  assert.equal(REVIEW_R12_UNCAUGHT.length, 19);
  const NO_METHOD = { ok: false, violations: ['SAMPLE_SIZE_WITHOUT_CLUSTER_METHOD'] };
  for (const text of [...REVIEW_R12_UNCAUGHT, ...NOTE_2_PATTERNS]) {
    assert.deepEqual(panel.report.checkReportTemplate(text), NO_METHOD, text);
    assert.deepEqual(panel.report.checkReportTemplate(`${text}\n聚类方法：DATE+EVENT`), NO_METHOD, `${text} (a method on another line does not count)`);
    assert.deepEqual(panel.report.checkReportTemplate(`行数 144\n${text}；聚类方法：DATE`), NO_METHOD, `${text} (inside another sentence it is not the structured line)`);
  }
  assert.equal(panel.report.checkReportTemplate('有效样本量：144；聚类方法：DATE+EVENT').ok, true);
  assert.equal(panel.report.checkReportTemplate('有效样本量：N/A；聚类方法：DATE+EVENT；原因：NO_ESTIMATOR_DECLARED').ok, true);
  // lines that are not sample size claims stay clean
  for (const text of ['行数 144', '日期数 1；事件数 1', 'N/A', 'in 144 rows', '事件数 144', '未关联行数 0', '样本区间 2026-11-01 至 2026-11-30', '样本外 不在范围', '窗口重叠：W4H 重叠，评价间隔 0.167，滞后 3.833',
    '账本：C17, CN_STOCK', '行业 未知（INDUSTRY_NOT_IN_PANEL）', '截断 3 个，无标签', 'The window is 4 hours', 'Sample window starts 2026-11-01']) {
    assert.equal(panel.report.checkReportTemplate(text).ok, true, text);
  }
});
