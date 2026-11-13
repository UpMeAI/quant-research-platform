'use strict';
// Sealed evidence only. No forward arithmetic, adoption, writer, or model caller.
const { STORES, sealedRows } = require('../desk-review-routing/sealed');
const { internals: { boundFiles } } = require('../overseas-sealed-verdicts');
const { canonicalJson } = require('../desk-review-routing/canonical');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const reasonOf = error => /^[A-Z][A-Z0-9_]*$/.test(error?.code || '') ? error.code : 'SEALED_SOURCE_UNAVAILABLE';
function readWeeklySealedInputs({ period, requests, stores = STORES }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period || '') || !Number.isFinite(Date.parse(period)) || new Date(period).toISOString().slice(0, 10) !== period || !Array.isArray(requests)) throw Error('WEEKLY_SEALED_ARGUMENTS');
  // Read each producer ledger once. Never fall back to an older lock if its head
  // fails validation or does not match the caller's explicit result identity.
  const snapshots = stores.map(source => {
    try { return { ...source, heads: new Map(source.locks().map(lock => [lock.entry_id, lock])) }; }
    catch { return { ...source, heads: null }; }
  });
  return requests.map(request => {
    const base = { period, output: 'WEEKLY_RECONCILIATION', inputState: 'INPUT_MISSING', weeklyReady: false,
      comparison: null, contextOnly: true, tradeAuthority: false, sealedSourceState: 'MISSING', facts: [] };
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)
          || ['entryId', 'resultId', 'strategyRef'].some(k => typeof request[k] !== 'string' || !request[k])
          || Object.keys(request).some(k => !['entryId', 'resultId', 'strategyRef'].includes(k))) fail('SEALED_REQUEST_INVALID');
      Object.assign(base, request);
      const matches = snapshots.flatMap(source => source.entries.filter(entry => entry.id === request.entryId).map(entry => ({ source, entry })));
      if (matches.length !== 1) fail('SEALED_ENTRY_NOT_REGISTERED');
      const { source, entry } = matches[0];
      if (entry.kind !== 'RESULT') fail('SEALED_NOT_RESULT');
      if (entry.strategy_ref !== request.strategyRef) fail('SEALED_STRATEGY_BINDING');
      if (!source.heads) fail('SEALED_LOCKS_UNAVAILABLE');
      const lock = source.heads.get(entry.id);
      if (!lock) fail('SEALED_LOCK_MISSING');
      if (lock.result_id !== request.resultId) fail('SEALED_CURRENT_RESULT_MISMATCH');
      if (lock.kind !== 'RESULT') fail('SEALED_NOT_RESULT');
      if (lock.strategy_ref !== entry.strategy_ref) fail('SEALED_STRATEGY_BINDING');
      if (lock.sealed_on !== entry.sealed_on || !/^\d{4}-\d{2}-\d{2}$/.test(lock.sealed_on || '')) fail('SEALED_DATE_BINDING');
      if (lock.sealed_on > period) fail('SEALED_AFTER_PERIOD');
      const refs = lock.refs;
      const expected = boundFiles(entry).map(({ role, spec }) => ({ role, ref: spec.ref, sha256: spec.sha256 }));
      const signature = rows => rows.map(r => canonicalJson({ role: r.role, ref: r.ref, sha256: r.sha256 })).sort();
      if (!Array.isArray(refs) || refs.some(r => !r || typeof r.file_ref !== 'string')
          || canonicalJson(signature(refs)) !== canonicalJson(signature(expected))
          || !refs.some(r => r.role === 'FILE' && r.file_ref === lock.file_ref && r.sha256 === lock.file_sha256)) fail('SEALED_REFERENCE_BINDING');
      // The canonical producer verifies every referenced byte/sidecar and applies
      // its registered projection, including the special multi-line X08 ruling.
      const rows = sealedRows({ stores: [{ ...source, entries: [entry], locks: () => [lock] }] });
      return { ...base, sealedSourceState: 'VERIFIED', reason: 'WEEKLY_BINDING_PENDING',
        facts: rows.map((row, i) => ({ id: `S${i + 1}`, sourceContract: source.store.lockSchema,
          sourceResultId: row.id, sourceEntryId: entry.id, sourceSha256: row.sha256,
          sourceFile: row.resultFile, sourceCommit: row.commit, sealedAt: row.sealedAt,
          strategyRef: row.book, sourceBindings: refs,
          data: { verdict: row.verdict, verdictState: row.verdictState } })) };
    } catch (error) { return { ...base, reason: reasonOf(error) }; }
  });
}
module.exports = { readWeeklySealedInputs };
