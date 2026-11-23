'use strict';

/**
 * Label to panel join (contract section 7.1 LB-2, section 8.2 R-6, R-9): ONLY by candidateId and panelRecordHash. The security and the date are never used to find a record.
 * A record whose hash differs from the label's, or whose content no longer matches its own stated hash, or that does not hold the candidate, makes the label
 * UNKNOWN / PANEL_RECORD_MISMATCH with no return key. The panel records are read only; nothing here writes to them.
 */
const v = require('./vocab');

const { sha256, canonicalJson } = v;

/** recordHash of a panel record: sha256 of the canonical JSON of the record without `recordHash` (contract section 2.1, same way as the scan record hash). */
function recordHashOf(record) {
  const { recordHash: _h, ...rest } = record;
  return sha256(canonicalJson(rest));
}

/** candidateId -> { record, row }. */
function indexPanel(panelRecords) {
  const idx = new Map();
  for (const record of panelRecords || []) for (const row of (record && record.rows) || []) idx.set(row.candidateId, { record, row });
  return idx;
}

/** The part of the panel the join shows next to a label (a copy of fields, nothing computed). */
function viewOf({ record, row }) {
  return {
    evaluationPointId: record.evaluationPointId, market: record.market, book: record.book, sessionDate: record.sessionDate, evaluatedAt: record.evaluatedAt,
    securityId: row.securityId, carrierId: row.carrierId || null, instrumentClass: row.instrumentClass ?? null, finalOutcome: row.finalOutcome, selected: row.selected,
    rank: row.rank ?? null, planLink: row.planLink ?? null, features: row.features || [],
  };
}

const stripReturns = (label) => { const out = { ...label }; for (const k of v.RETURN_KEYS) delete out[k]; return out; };

function mismatch(label, detail) {
  return {
    candidateId: label.candidateId, panelRecordHash: label.panelRecordHash, windowId: label.windowId, state: 'UNKNOWN', reasonCode: 'PANEL_RECORD_MISMATCH', mismatchDetail: detail,
    label: { ...stripReturns(label), state: 'UNKNOWN', reasonCode: 'PANEL_RECORD_MISMATCH' }, panel: null,
  };
}

/**
 * @param {{labels: object[], panelRecords: object[], verifyRecordHash?: boolean}} o
 *   verifyRecordHash (true unless set to false): also recompute each record's hash from its content. The contract (ID-P6) requires the producers' canonical JSON to match
 *   QRP's bit for bit; until the shared fixture proves it, a producer difference shows up here as RECORD_CONTENT_HASH_INVALID, loudly, never as a silent join.
 */
function joinLabels({ labels, panelRecords, verifyRecordHash = true } = {}) {
  const idx = indexPanel(panelRecords);
  const verified = new Map();
  const contentOk = (record) => {
    if (!verifyRecordHash) return true;
    if (!verified.has(record)) verified.set(record, recordHashOf(record) === record.recordHash);
    return verified.get(record);
  };
  return labels.map((label) => {
    const hit = idx.get(label.candidateId);
    if (!hit) return mismatch(label, 'CANDIDATE_ID_NOT_IN_PANEL');
    if (hit.record.recordHash !== label.panelRecordHash) return mismatch(label, 'RECORD_HASH_DIFFERS');
    if (!contentOk(hit.record)) return mismatch(label, 'RECORD_CONTENT_HASH_INVALID');
    const out = { candidateId: label.candidateId, panelRecordHash: label.panelRecordHash, windowId: label.windowId, state: label.state, reasonCode: label.reasonCode, label, panel: viewOf(hit) };
    if (label.state === 'VALUE') for (const k of v.RETURN_KEYS) out[k] = label[k];
    return out;
  });
}

/** Labels whose candidate is in no panel record (a truncated candidate has no row, so it must have no label: R-9). */
function orphanLabels(labels, panelRecords) {
  const idx = indexPanel(panelRecords);
  return labels.filter((l) => !idx.has(l.candidateId));
}

module.exports = { recordHashOf, indexPanel, viewOf, joinLabels, orphanLabels };
