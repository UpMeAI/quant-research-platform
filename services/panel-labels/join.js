'use strict';

/**
 * Label to panel join (contract section 7.1 LB-2, section 8.2 R-6, R-9; NOTE_1 item 1): ONLY by the pair (candidateId, recordHash). The security and the date are never used
 * to find a record. A label whose pair is not among the supplied records, whose record content no longer matches its own `recordHash`, or whose candidate is in no supplied
 * record, is UNKNOWN / PANEL_RECORD_MISMATCH with no return key and a `mismatchDetail` that says which. The panel records are read only; nothing here writes to them.
 *
 * recordHash (NOTE_1 item 1) = sha256 of the record without its `recordHash` field, serialised by the one canonical JSON function (keys in code point order, UTF-8, no whitespace)
 * that the W07 digest vectors use. The vectors are reproduced by trial-ledger canonicalJson in tests/panel_labels_join_report.test.js.
 */
const v = require('./vocab');

const { sha256, canonicalJson } = v;
const pairKey = (candidateId, recordHash) => `${candidateId}\u0000${recordHash}`;

function recordHashOf(record) {
  const { recordHash: _h, ...rest } = record;
  return sha256(canonicalJson(rest));
}

/**
 * Why a record does not match its own stated hash. null when it does.
 * A single top-level field that, taken out, makes the stated hash come out right is an envelope field the producer added outside the hash (RECORD_HASH_EXCLUDES_FIELD).
 * @returns {null|{detail: string, field?: string}}
 */
function diagnoseRecord(record) {
  if (recordHashOf(record) === record.recordHash) return null;
  for (const field of Object.keys(record)) {
    if (field === 'recordHash') continue;
    const copy = { ...record };
    delete copy[field];
    if (recordHashOf(copy) === record.recordHash) return { detail: 'RECORD_HASH_EXCLUDES_FIELD', field };
  }
  return { detail: 'RECORD_CONTENT_HASH_INVALID' };
}

/** @returns {{byPair: Map, byId: Map}} (candidateId, recordHash) -> {record, row}; candidateId -> every {record, row} that holds it */
function indexPanel(panelRecords) {
  const byPair = new Map();
  const byId = new Map();
  for (const record of panelRecords || []) {
    for (const row of (record && record.rows) || []) {
      const hit = { record, row };
      byPair.set(pairKey(row.candidateId, record.recordHash), hit);
      if (!byId.has(row.candidateId)) byId.set(row.candidateId, []);
      byId.get(row.candidateId).push(hit);
    }
  }
  return { byPair, byId };
}

/** The record version a label was computed against, else any version of the candidate (used only to date a mismatched label), else null. */
const exactHit = (idx, label) => idx.byPair.get(pairKey(label.candidateId, label.panelRecordHash)) || null;
const anyHit = (idx, label) => exactHit(idx, label) || (idx.byId.get(label.candidateId) || [])[0] || null;

/** The part of the panel the join shows next to a label (a copy of fields, nothing computed). */
function viewOf({ record, row }) {
  return {
    evaluationPointId: record.evaluationPointId, market: record.market, book: record.book, sessionDate: record.sessionDate, evaluatedAt: record.evaluatedAt,
    securityId: row.securityId, carrierId: row.carrierId || null, instrumentClass: row.instrumentClass ?? null, finalOutcome: row.finalOutcome, selected: row.selected,
    rank: row.rank ?? null, planLink: row.planLink ?? null, features: row.features || [],
  };
}

const stripReturns = (label) => { const out = { ...label }; for (const k of v.RETURN_KEYS) delete out[k]; return out; };

function mismatch(label, detail, field) {
  const out = {
    candidateId: label.candidateId, panelRecordHash: label.panelRecordHash, windowId: label.windowId, state: 'UNKNOWN', reasonCode: 'PANEL_RECORD_MISMATCH', mismatchDetail: detail,
    label: { ...stripReturns(label), state: 'UNKNOWN', reasonCode: 'PANEL_RECORD_MISMATCH' }, panel: null,
  };
  if (field !== undefined) out.mismatchField = field;
  return out;
}

/**
 * @param {{labels: object[], panelRecords: object[], verifyRecordHash?: boolean}} o
 *   verifyRecordHash (true unless set to false): recompute each record's hash from its content. A producer whose canonical JSON differs from the W07 function is shown here,
 *   loudly, as RECORD_CONTENT_HASH_INVALID, never as a silent join.
 */
function joinLabels({ labels, panelRecords, verifyRecordHash = true } = {}) {
  const idx = indexPanel(panelRecords);
  const verdicts = new Map();
  const diagnosis = (record) => {
    if (!verdicts.has(record)) verdicts.set(record, verifyRecordHash ? diagnoseRecord(record) : null);
    return verdicts.get(record);
  };
  return labels.map((label) => {
    const hit = exactHit(idx, label);
    if (!hit) return mismatch(label, idx.byId.has(label.candidateId) ? 'RECORD_HASH_DIFFERS' : 'CANDIDATE_ID_NOT_IN_PANEL');
    const bad = diagnosis(hit.record);
    if (bad) return mismatch(label, bad.detail, bad.field);
    const out = { candidateId: label.candidateId, panelRecordHash: label.panelRecordHash, windowId: label.windowId, state: label.state, reasonCode: label.reasonCode, label, panel: viewOf(hit) };
    if (label.state === 'VALUE') for (const k of v.RETURN_KEYS) out[k] = label[k];
    return out;
  });
}

/** Labels whose candidate is in no panel record (a truncated candidate has no row, so it must have no label: R-9). */
function orphanLabels(labels, panelRecords) {
  const idx = indexPanel(panelRecords);
  return labels.filter((l) => !idx.byId.has(l.candidateId));
}

module.exports = { recordHashOf, diagnoseRecord, indexPanel, anyHit, viewOf, joinLabels, orphanLabels };
