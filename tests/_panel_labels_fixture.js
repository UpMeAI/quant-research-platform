'use strict';
/**
 * Synthetic CANDIDATE_PANEL_V1 records, fixture price series, K2 bytes and the controlled-read plumbing for the W18 part 2 tests (docs/contracts/PANEL_LABELS_V1.md).
 * The numbers have no economic meaning. A panel record here has only the fields the label join reads; the part 1 producers own the real shape.
 * The label table is read only through readLabels (the report flows below go through it); `rowsOf` is a test side look at the file, the way a host operator would.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalJson } = require('../services/trial-ledger');
const trials = require('../services/trial-ledger');
const authority = require('../services/independent-verifier/authority');
const fixtureProvider = require('../services/panel-labels/fixture-provider');
const panel = require('../services/panel-labels');

const AUTH = 'W18_TEST_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const EVALUATOR = authority.loadConfig().holdoutScorerPrincipal;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SELECTED_OUTCOMES = ['SELECTED', 'SELECTED_SCALED'];

const LAYERS = (outcome) => ['SELECTION_TIMING', 'RISK', 'ACCOUNT', 'EXECUTION'].map((layer) => ({ layer, state: 'EVALUATED', outcome: outcome === 'BLOCKED_ACCOUNT' && layer === 'ACCOUNT' ? 'BLOCKED' : 'PASSED', checks: [] }));

function candidateRow({ evaluationPointId, securityId, finalOutcome = 'SELECTED', rank = 1, planned = false, carrierId = null, features = null }) {
  const feats = features || [{ name: 'f1', state: 'VALUE', value: 1.5, knownAt: '2026-11-02T06:00:00.000Z' }];
  const c12 = sha(canonicalJson({ evaluationPointId, securityId, features: feats })).slice(0, 12);
  const row = {
    candidateId: `${evaluationPointId}:${securityId}:${c12}`, securityId, instrumentClass: 'STOCK', stageReached: 'FINAL', features: feats,
    rawScore: { name: 'score', value: 1 }, rank: { value: rank, scope: 'BOOK', rankedCount: 10 }, layers: LAYERS(finalOutcome), finalOutcome,
    selected: SELECTED_OUTCOMES.includes(finalOutcome),
    planLink: planned ? { planId: `PLAN-${securityId}`, freezeId: 'FRZ-1' } : { state: 'NOT_APPLICABLE', reasonCode: 'REJECTED_BEFORE_PLAN_STAGE' },
    journalRef: { state: 'NOT_APPLICABLE', reasonCode: 'JOURNAL_ROW_DEDUPED' }, rowGaps: [],
  };
  if (carrierId) row.carrierId = carrierId;
  return row;
}

const recordHashOf = (rec) => { const { recordHash: _omit, ...rest } = rec; return sha(canonicalJson(rest)); };

/**
 * @param {{producer?: string, market?: string, book?: string, sessionDate: string, evaluatedAt: string, candidates: object[], truncation?: object}} o
 *   candidates: [{securityId, finalOutcome?, rank?, planned?, carrierId?, features?}]
 */
function panelRecord({ producer = 'ASHARE_V6', market = 'CN', book = 'CN_STOCK', sessionDate, evaluatedAt, candidates, truncation = null }) {
  const e12 = sha(canonicalJson({ contract: 'CANDIDATE_PANEL_V1', producer, market, sessionDate, bookKey: book, evaluatedAt })).slice(0, 12);
  const evaluationPointId = `${producer}:${market}:${sessionDate}:PANEL:${book}:${e12}`;
  const rows = candidates.map((c) => candidateRow({ evaluationPointId, ...c }));
  const rec = {
    contract: 'CANDIDATE_PANEL_V1', producer, market, book, ledgerId: book, ruleModule: null, sessionDate, evaluationPointId, evaluatedAt, decisionCutoff: evaluatedAt,
    ruleRefs: [], codeDigest: {}, dataBindings: [], rows,
    truncation: truncation || { state: 'NOT_TRUNCATED', keptCount: rows.length, totalCount: rows.length, droppedByOutcome: [], limitRows: 2000, limitBytes: 8388608 },
    researchOnly: true, realOrder: 0, brokerWrite: false,
  };
  rec.recordHash = recordHashOf(rec);
  return rec;
}

/** The same record with one byte of content changed and the hash field left as it was written (content that no longer matches its own stated hash). */
const tampered = (rec) => ({ ...rec, rows: rec.rows.map((r, i) => (i === 0 ? { ...r, rawScore: { name: 'score', value: 2 } } : r)) });
/** The same candidates written again with a different output and a freshly computed hash (the label was computed against the earlier version: same candidateId, other recordHash). */
const rewritten = (rec) => { const next = tampered(rec); next.recordHash = recordHashOf(next); return next; };

const CN_CLOSE_AVAILABLE = (date) => `${date}T07:30:00.000Z`;

/** CN fixture world: weekday sessions from 2026-11-02, the CN adjusted-price method, a 30 minute availability lag. */
function cnProvider(extra = {}) {
  return fixtureProvider.create({ sessions: { CN: fixtureProvider.weekdaySessions('CN', '2026-11-02', 40) }, ...extra });
}

/** Entry open at the next session open and exit close at the window end for a CN instrument on the W1S window of a 2026-11-02 evaluation. */
function setCnW1(provider, instrument, open, close) {
  provider.set(instrument, 'OPEN', '2026-11-03T01:30:00.000Z', open);
  provider.set(instrument, 'CLOSE', '2026-11-03T07:00:00.000Z', close, CN_CLOSE_AVAILABLE('2026-11-03'));
  return provider;
}

/* ------------------------------------------------------------------ the controlled read plumbing */

/** Register a directory as controlled for the existing authority layer the way a host does: QRP_HOLDOUT_DATA_DIRS (the list the generator process lock reads too). */
function protect(dir) {
  const cur = (process.env.QRP_HOLDOUT_DATA_DIRS || '').split(path.delimiter).filter(Boolean);
  if (!cur.includes(dir)) { cur.push(dir); process.env.QRP_HOLDOUT_DATA_DIRS = cur.join(path.delimiter); }
}

const K2_BYTES = new Map();
/** A K2 whose section 0 names its freezer; the bytes are kept so ctx.k2Bytes can hand them out. `frozenBy` null leaves the line out. */
function k2(id, frozenBy) {
  const line = frozenBy === null ? '- (no freezer line)' : `- **作者与冻结者**：design agent drafted, 冻结者 ${frozenBy}，2026-11-23T00:00:00+08:00。`;
  const text = `# ${id}\n\n## 0. file head\n\n${line}\n`;
  const sha256 = sha(text);
  K2_BYTES.set(sha256, Buffer.from(text));
  return { id, sha256 };
}
const k2Bytes = (ref) => K2_BYTES.get(ref.sha256) || null;
const COORD = k2('K2-COORD', 'COORDINATOR');

/** A REGISTRATION row of the trial ledger for (family, K2): what binds a K2 to a family. */
function bind(family, k2Ref = COORD, market = 'CN_A') {
  return trials.register({ family_id: family, market, study_ref: 'W18_FIXTURE', k2_sha256: k2Ref.sha256, stage: 'SIGNAL', role: 'SIGNAL_TEST', config_label: `c-${family}-${k2Ref.id}`, rule_config: { family, k2: k2Ref.id } },
    { registeredBy: AUTH, registeredAt: '2026-11-01T00:00:00.000Z' });
}

const NOW = '2026-12-31T00:00:00.000Z';
/** A read context for a label store: the store directory is registered, the clock is fixed, K2 bytes come from the fixture K2 registry. */
function ctxFor(store, extra = {}) {
  protect(store.dir);
  const work = tmp('w18-ctx-');
  return { store, accessLogFile: path.join(work, 'access.jsonl'), readLedgerFile: path.join(work, 'reads.jsonl'), registeredBy: AUTH, k2Bytes, now: () => NOW, ...extra };
}

/** A valid read request; `family` must be bound to the K2 (bind) unless the test is about the binding. */
function request(family, panelRecords, extra = {}) {
  return { principal: EVALUATOR, k2Ref: COORD, stage: 'SEEN', market: 'CN', families: [family], from: '2026-11-01', to: '2026-11-30', windows: ['W1S'], panelRecords, ...extra };
}

let seq = 0;
/** The report flows: bind a fresh family, read through readLabels (principal, gate, join), hand back the joined rows. */
function readJoined({ store, records, windows, market = 'CN', from = '2026-11-01', to = '2026-12-31', ctx = null }) {
  seq += 1;
  const family = `W18_FIXTURE_FAMILY_${process.pid}_${seq}`;
  bind(family);
  return panel.readLabels(request(family, records, { market, windows, from, to }), ctx || ctxFor(store)).rows;
}

/** Test side look at the label file (the host operator's view): the labels in append order. */
function rowsOf(store) {
  if (!fs.existsSync(store.file)) return [];
  return fs.readFileSync(store.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).label);
}

module.exports = {
  AUTH, EVALUATOR, NOW, sha, tmp, panelRecord, candidateRow, tampered, rewritten, recordHashOf, cnProvider, setCnW1, CN_CLOSE_AVAILABLE, fixtureProvider, protect, k2, k2Bytes, COORD, bind, ctxFor, request,
  readJoined, rowsOf,
};
