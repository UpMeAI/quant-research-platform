'use strict';

/**
 * Panel labels, part 2 of the all candidate panel (W18_ALL_CANDIDATE_PANEL_CONTRACT_V1_FREEZE_1 section 7, with NOTE_1; docs/contracts/PANEL_LABELS_V1.md).
 * Result facts only: a deterministic program computes, from injected price series, what happened after each panel candidate; the labels are append only, join to the
 * part 1 records by (candidateId, recordHash) only, are readable only through the controlled read (reader.js), and are never written back into a panel file,
 * a decision record or the desk. No model, no prediction, no order. There is no label writing job and no real price provider in this version (recorded gap, NOTE_1 item 6).
 */
const vocab = require('./vocab');
const label = require('./label');
const { createStore } = require('./store');
const join = require('./join');
const { readLabels, readRecordHashOf } = require('./reader');
const report = require('./report');
const staticScan = require('./static-scan');

/**
 * The host side label job: compute every kept row of every panel record for every DECLARED window and append what is new.
 * A window must be declared (W-7 lists allowed values, not a choice). A record whose content does not match its own recordHash is refused before anything is labelled
 * (LABEL_PANEL_RECORD_HASH_INVALID): a label must bind to a hash that verifies. Candidates the panel truncated have no row, so they get no label (LB-8); they are listed in `truncated`.
 * @param {{records: object[], windows: string[], provider: object, store: object, now: string, benchmarkFor?: (record: object, row: object) => string|undefined}} o
 * @returns {{written: number, skipped: number, truncated: {evaluationPointId: string, truncatedNoLabel: number}[]}}
 */
function materialize({ records, windows, provider, store, now, benchmarkFor = () => undefined } = {}) {
  vocab.need(Array.isArray(windows) && windows.length > 0 && windows.every(vocab.isText), 'LABEL_WINDOWS_NOT_DECLARED');
  vocab.need(Array.isArray(records), 'LABEL_PANEL_INPUT_INVALID', 'records');
  label.assertProvider(provider);
  for (const record of records) {
    const bad = join.diagnoseRecord(record);
    if (bad) vocab.fail('LABEL_PANEL_RECORD_HASH_INVALID', `${record.evaluationPointId}:${bad.detail}${bad.field ? `:${bad.field}` : ''}`);
  }
  let written = 0; let skipped = 0;
  const truncated = [];
  for (const record of records) {
    for (const row of record.rows || []) {
      for (const windowId of windows) {
        const l = label.computeLabel({ record, row, windowId, provider, now, benchmarkKey: benchmarkFor(record, row) });
        if (store.append(l)) written += 1; else skipped += 1;
      }
    }
    const t = record.truncation;
    if (t && t.state === 'TRUNCATED') truncated.push({ evaluationPointId: record.evaluationPointId, truncatedNoLabel: t.totalCount - t.keptCount });
  }
  return { written, skipped, truncated };
}

module.exports = {
  vocab, createStore, materialize, computeLabel: label.computeLabel, labelHashOf: label.labelHashOf, validateLabel: label.validateLabel,
  joinLabels: join.joinLabels, orphanLabels: join.orphanLabels, recordHashOf: join.recordHashOf, readLabels, readRecordHashOf, report, staticScan,
  PanelLabelError: vocab.PanelLabelError,
};
