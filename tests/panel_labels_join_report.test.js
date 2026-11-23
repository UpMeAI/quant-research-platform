'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const authority = require('../services/independent-verifier/authority');
const panel = require('../services/panel-labels');
const fx = require('./_panel_labels_fixture');

/**
 * W18 part 2, acceptance R-6 .. R-10 (contract section 7.1 LB-2, LB-8, section 7.3 ES-1..ES-4, section 8.2): join by id and hash only, the panel files are never written,
 * the report template refuses a sample size without a clustering method, truncated candidates have no label, and the four questions each produce a table without a conclusion.
 */
const AUTH = 'W18_TEST_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha256File = (f) => fx.sha(fs.readFileSync(f));
const EVALUATOR = authority.loadConfig().holdoutScorerPrincipal;
const SECURITIES = ['600001.SH', '600002.SH'];
const RETURN_KEYS = ['grossReturn', 'benchmarkReturn', 'excessReturn'];

function cnLabelled(securities = SECURITIES) {
  const record = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: securities.map((securityId) => ({ securityId })) });
  const provider = fx.cnProvider();
  for (const s of securities) fx.setCnW1(provider, s, 10, 10.5);
  fx.setCnW1(provider, 'CSI300', 4000, 4040);
  const store = panel.createStore({ dir: path.join(tmp('w18-join-'), 'labels') });
  panel.materialize({ records: [record], windows: ['W1S'], provider, store, now: '2026-11-04T00:00:00.000Z' });
  return { record, provider, store };
}

test('R-6 labels join to the panel only by candidateId and panelRecordHash: a record whose hash no longer matches is UNKNOWN / PANEL_RECORD_MISMATCH (no return key); a record with the same security and date but another id is not used; nothing is guessed', () => {
  const { record, store } = cnLabelled();
  const ok = panel.joinLabels({ labels: store.rows(), panelRecords: [record] });
  assert.deepEqual(ok.map((j) => [j.candidateId, j.state, j.panel.securityId]), record.rows.map((r) => [r.candidateId, 'VALUE', r.securityId]));
  assert.equal(ok[0].panel.sessionDate, '2026-11-02');

  // the record was written again with another output: same candidateId, another recordHash
  const bad = panel.joinLabels({ labels: store.rows(), panelRecords: [fx.rewritten(record)] });
  for (const j of bad) {
    assert.deepEqual([j.state, j.reasonCode], ['UNKNOWN', 'PANEL_RECORD_MISMATCH']);
    assert.equal(RETURN_KEYS.some((k) => k in j || k in j.label), false, 'a mismatched label shows no return');
    assert.equal(j.mismatchDetail, 'RECORD_HASH_DIFFERS');
  }
  // content changed under a stale hash field: the stated hash would match the label, the recomputed one does not
  const stale = panel.joinLabels({ labels: store.rows(), panelRecords: [fx.tampered(record)] });
  for (const j of stale) assert.deepEqual([j.state, j.reasonCode, j.mismatchDetail], ['UNKNOWN', 'PANEL_RECORD_MISMATCH', 'RECORD_CONTENT_HASH_INVALID']);
  // same security, same date, different evaluation (different evaluatedAt => different ids): the labels do not move onto it
  const other = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T08:00:00.000Z', candidates: SECURITIES.map((securityId) => ({ securityId })) });
  assert.notEqual(other.rows[0].candidateId, record.rows[0].candidateId);
  const guess = panel.joinLabels({ labels: store.rows(), panelRecords: [other] });
  for (const j of guess) assert.deepEqual([j.state, j.reasonCode, j.mismatchDetail, j.panel], ['UNKNOWN', 'PANEL_RECORD_MISMATCH', 'CANDIDATE_ID_NOT_IN_PANEL', null]);
  // the label rows carry the hash they were computed against
  assert.equal(store.rows().every((l) => l.panelRecordHash === record.recordHash), true);
});

test('R-6 the read path applies the same join: a mismatched record comes back UNKNOWN / PANEL_RECORD_MISMATCH', () => {
  const { record, store } = cnLabelled();
  const labelsDir = path.dirname(store.file);
  const ctx = { store, holdoutDirs: [labelsDir], accessLogFile: path.join(tmp('w18-j6-'), 'a.jsonl'), readLedgerFile: path.join(tmp('w18-j6b-'), 'r.jsonl'), registeredBy: AUTH };
  const req = { principal: EVALUATOR, k2Ref: { id: 'K2', sha256: 'b'.repeat(64) }, stage: 'SEEN', market: 'CN', families: ['W18_JOIN_F'], from: '2026-11-01', to: '2026-11-30', windows: ['W1S'], readAt: '2026-11-05T00:00:00.000Z' };
  const out = panel.readLabels({ ...req, panelRecords: [fx.tampered(record)] }, ctx);
  assert.deepEqual(out.rows.map((r) => [r.state, r.reasonCode]), [['UNKNOWN', 'PANEL_RECORD_MISMATCH'], ['UNKNOWN', 'PANEL_RECORD_MISMATCH']]);
  const good = panel.readLabels({ ...req, panelRecords: [record] }, ctx);
  assert.deepEqual(good.rows.map((r) => r.state), ['VALUE', 'VALUE']);
});

test('R-7 the panel files are not changed by part 2 (bytes before and after), the label table is a separate file, and no producer or desk code reads the label table (static scan)', () => {
  const { record, provider, store } = cnLabelled();
  const dir = tmp('w18-r7-');
  const panelFile = path.join(dir, 'panel.jsonl');
  fs.writeFileSync(panelFile, `${JSON.stringify(record)}\n`);
  const before = sha256File(panelFile);
  const loaded = fs.readFileSync(panelFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const store2 = panel.createStore({ dir: path.join(dir, 'labels') });
  panel.materialize({ records: loaded, windows: ['W1S'], provider, store: store2, now: '2026-11-04T00:00:00.000Z' });
  panel.readLabels({ principal: EVALUATOR, k2Ref: { id: 'K2', sha256: 'c'.repeat(64) }, stage: 'SEEN', market: 'CN', families: ['W18_R7_F'], from: '2026-11-01', to: '2026-11-30', windows: ['W1S'],
    readAt: '2026-11-05T00:00:00.000Z', panelRecords: loaded }, { store: store2, holdoutDirs: [path.dirname(store2.file)], accessLogFile: path.join(dir, 'a.jsonl'), readLedgerFile: path.join(dir, 'r.jsonl'), registeredBy: AUTH });
  assert.equal(sha256File(panelFile), before, 'the panel file is byte for byte unchanged');
  assert.equal(store2.rows().length, 2);
  assert.equal(store.rows().length, 2);
  assert.equal(JSON.stringify(loaded[0]).includes('grossReturn'), false, 'no label field in the panel record');

  // static scan: a producer tree with no reader is clean; a planted reader is found
  const producer = path.join(dir, 'producer'); fs.mkdirSync(path.join(producer, 'src'), { recursive: true });
  fs.writeFileSync(path.join(producer, 'src', 'panel.js'), "'use strict';\nmodule.exports = { write: () => 1 };\n");
  assert.deepEqual(panel.staticScan.findLabelTableReaders(producer), []);
  fs.writeFileSync(path.join(producer, 'src', 'peek.js'), "const labels = require('../../quant-research-platform/services/panel-labels');\n");
  fs.writeFileSync(path.join(producer, 'src', 'peek2.js'), "const f = '/var/ledger/research/panel_labels/labels.jsonl';\n");
  const hits = panel.staticScan.findLabelTableReaders(producer).map((h) => path.basename(h.file)).sort();
  assert.deepEqual(hits, ['peek.js', 'peek2.js']);
  // and the part 2 code itself writes only its own files: the label table and the read ledgers
  const src = path.join(__dirname, '..', 'services', 'panel-labels');
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.js') && x !== 'store.js' && x !== 'reader.js')) {
    assert.equal(/\bfs\.(writeFile|appendFile|createWriteStream|rename|unlink|rm|mkdir|copyFile|truncate)(Sync)?\(|fs\.promises/.test(fs.readFileSync(path.join(src, f), 'utf8')), false, `${f} does not write files`);
  }
});

function c17Records(count, { epoch = () => 'E1', outcome = () => 'NOT_SELECTED_RANK' } = {}) {
  const day = '2026-11-03';
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.parse(`${day}T00:00:00.000Z`) + i * 600000).toISOString();
    const features = [{ name: 'signalEpoch', state: 'VALUE', value: epoch(i), knownAt: at }];
    return fx.panelRecord({ producer: 'SMARTFLOW_CRYPTO', market: 'CRYPTO', book: 'C17', sessionDate: day, evaluatedAt: at, candidates: [{ securityId: 'BTCUSDT', finalOutcome: outcome(i), features }] });
  });
}
function joinedFor(records, windows = ['W4H']) {
  const store = panel.createStore({ dir: path.join(tmp('w18-es-'), 'labels') });
  panel.materialize({ records, windows, provider: fx.fixtureProvider.create({}), store, now: '2026-11-03T00:00:00.000Z' });
  return panel.joinLabels({ labels: store.rows(), panelRecords: records });
}

test('R-8 the same security over 144 C17 scans is 144 rows, 1 date and 1 event; a new signal epoch or a changed outcome starts a new event; an evaluation point where the security is absent breaks the event', () => {
  const joined = joinedFor(c17Records(144));
  const s = panel.report.describeSample(joined);
  assert.deepEqual([s.rows, s.dates, s.events], [144, 1, 1]);
  assert.deepEqual(s.industries, { state: 'NOT_APPLICABLE', reasonCode: 'CRYPTO_HAS_NO_INDUSTRY_CLUSTER' });
  assert.deepEqual(s.effectiveSampleSize, { state: 'N/A', reasonCode: 'NO_ESTIMATOR_DECLARED' }, 'not 0, not a pass');
  assert.deepEqual(s.clusterMethods, ['DATE', 'EVENT']);
  const epochs = panel.report.describeSample(joinedFor(c17Records(144, { epoch: (i) => (i < 72 ? 'E1' : 'E2') })));
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
  const v6 = panel.report.describeSample(panel.joinLabels({ labels: store.rows(), panelRecords: recs }));
  assert.deepEqual([v6.rows, v6.dates], [10, 4]);
  assert.equal(v6.events, 3 + 1 + 2, 'A: SELECTED x2, NOT_SELECTED_RANK, SELECTED = 3 events; B: 1 event; C: present, absent, present = 2 events');
  assert.deepEqual(v6.industries, { state: 'UNKNOWN', reasonCode: 'INDUSTRY_NOT_IN_PANEL' });
  // window overlap: 20-session labels evaluated every session overlap; the session calendar is an input, not a guess
  const noCal = panel.report.describeSample(panel.joinLabels({ labels: store.rows(), panelRecords: recs }), { windows: ['W1S'] });
  assert.deepEqual(noCal.windowOverlap, [{ windowId: 'W1S', state: 'UNKNOWN', reasonCode: 'SESSION_CALENDAR_NOT_PROVIDED' }]);
  const gap = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
  const withCal = panel.report.describeSample(panel.joinLabels({ labels: store.rows(), panelRecords: recs }), { windows: ['W1S', 'W5S'], sessionGap: gap });
  assert.deepEqual(withCal.windowOverlap, [{ windowId: 'W1S', state: 'NON_OVERLAPPING', minEvaluationGap: 1, lag: 0 }, { windowId: 'W5S', state: 'OVERLAPPING', minEvaluationGap: 1, lag: 4 }]);
});

test('R-8 report template: a sample size or N without a clustering method fails validation; row counts must be called rows; N/A and a stated method pass', () => {
  const bad = (t) => panel.report.checkReportTemplate(t);
  assert.deepEqual(bad('样本量 144'), { ok: false, violations: ['SAMPLE_SIZE_WITHOUT_CLUSTER_METHOD'] });
  assert.deepEqual(bad('N = 144'), { ok: false, violations: ['SAMPLE_SIZE_WITHOUT_CLUSTER_METHOD'] });
  assert.deepEqual(bad('有效样本量 12，来自 144 个标签'), { ok: false, violations: ['SAMPLE_SIZE_WITHOUT_CLUSTER_METHOD'] });
  assert.equal(bad('行数 144').ok, true);
  assert.equal(bad('有效样本量 N/A（未声明估计方法）').violations[0], 'SAMPLE_SIZE_WITHOUT_CLUSTER_METHOD');
  assert.equal(bad('有效样本量 1\n聚类方法：DATE+EVENT').ok, true);
  assert.deepEqual(bad('有效样本量 1\n聚类方法：EVENT'), { ok: false, violations: ['CLUSTER_METHOD_MISSING_DATE'] }, 'date is the minimum clustering (ES-2)');
  assert.deepEqual(bad('功效不足，结论：不做'), { ok: false, violations: ['POWER_INSUFFICIENT_MUST_NOT_BE_NOT_DO'] }, 'ES-3: insufficient power is 做 (forward shadow), never 不做');
  assert.equal(bad('功效不足，结论：做（前向影子）').ok, true);
  const joined = joinedFor(c17Records(144));
  const text = panel.report.renderReport({ joined, panelRecords: c17Records(144), windows: ['W4H'] });
  assert.equal(panel.report.checkReportTemplate(text).ok, true, text);
  assert.match(text, /行数 144/);
  assert.match(text, /日期数 1/);
  assert.match(text, /事件数 1/);
  assert.match(text, /聚类方法：DATE\+EVENT/);
  assert.equal(/样本量 *[:：]? *\d/.test(text) || /\bN *= *\d/.test(text), false, 'the rendered report never calls the row count a sample size');
});

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
  const ids = new Set(record.rows.map((r) => r.candidateId));
  assert.equal(store.rows().every((l) => ids.has(l.candidateId)), true);
  assert.deepEqual(panel.orphanLabels(store.rows(), [record]), []);
  const stray = { ...store.rows()[0], candidateId: `${record.evaluationPointId}:DROPPED:abcdef123456` };
  assert.deepEqual(panel.orphanLabels([stray], [record]).map((l) => l.candidateId), [stray.candidateId]);
  const joined = panel.joinLabels({ labels: store.rows(), panelRecords: [record] });
  const text = panel.report.renderReport({ joined, panelRecords: [record], windows: ['W1S'] });
  assert.match(text, /截断 3 个，无标签/);
  assert.equal(panel.report.checkReportTemplate(text).ok, true);
  const inconsistent = { ...record, truncation: { ...truncation, droppedByOutcome: [{ finalOutcome: 'NOT_SELECTED_RANK', count: 2 }] } };
  assert.deepEqual(panel.report.truncationSummary([inconsistent]).problems, [{ evaluationPointId: record.evaluationPointId, code: 'TRUNCATION_COUNTS_INCONSISTENT' }]);
});

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
  return panel.joinLabels({ labels: store.rows(), panelRecords: [record] });
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
