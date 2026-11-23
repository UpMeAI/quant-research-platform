'use strict';
/**
 * Synthetic CANDIDATE_PANEL_V1 records and fixture price series for the W18 part 2 tests (docs/contracts/PANEL_LABELS_V1.md).
 * The numbers have no economic meaning. A panel record here has only the fields the label join reads; the part 1 producers own the real shape.
 */
const crypto = require('crypto');
const { canonicalJson } = require('../services/trial-ledger');
const fixtureProvider = require('../services/panel-labels/fixture-provider');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
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

module.exports = { sha, panelRecord, candidateRow, tampered, rewritten, recordHashOf, cnProvider, setCnW1, CN_CLOSE_AVAILABLE, fixtureProvider };
