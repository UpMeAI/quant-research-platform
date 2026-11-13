'use strict';
// Deterministic delivery only under coordinator 2026-11-14 binding-pending ruling.
const path = require('node:path');
const { readWeeklySealedInputs } = require('./weekly-sealed-input');
const { run } = require('./index');
const { persistReport } = require('./runner');
const { sha256, canonicalJson } = require('../desk-review-routing/canonical');
async function runWeeklyPending({ period, requests, stores, root = path.resolve(__dirname, '../../var/ai-review'), fetchFn = globalThis.fetch }) {
  const packs = readWeeklySealedInputs({ period, requests, ...(stores ? { stores } : {}) });
  const rows = [];
  for (const [index, pack] of packs.entries()) {
    // Hash source identity, never put caller-controlled identifiers in paths.
    const identity = { entryId: pack.entryId ?? null, resultId: pack.resultId ?? null, strategyRef: pack.strategyRef ?? null };
    if (!pack.entryId || !pack.resultId || !pack.strategyRef) identity.invalidRequestIndex = index;
    const namespace = `ledger-${sha256(canonicalJson(identity))}`;
    // The core's pending branch precedes budget/key/network paths even for READY inputs.
    const result = await run({ pack, enabled: true, fetchFn });
    if (result.status !== 'WEEKLY_BINDING_PENDING' || result.comparison !== null) throw Error('WEEKLY_PENDING_CONTRACT');
    rows.push(persistReport({ root, period, namespace, output: 'WEEKLY_RECONCILIATION', result }));
  }
  return rows;
}
module.exports = { runWeeklyPending };
