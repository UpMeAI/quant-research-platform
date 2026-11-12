#!/usr/bin/env node
'use strict';

/** Thin CLI over the canonical followup converters.  It exists so the Owner's
 * dry-run and real-run commands differ only by --dry-run true|false. */
const fs = require('fs');
const crypto = require('crypto');
const ledger = require('../services/trial-ledger');
const followups = require('../services/trial-ledger/followups');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i] || !argv[i].startsWith('--') || argv[i + 1] == null) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function run({ mode, inputs, inputsSha256, registeredBy, dryRun }) {
  const bytes = fs.readFileSync(inputs);
  if (sha256(bytes) !== inputsSha256) throw new Error('FOLLOWUP_INPUT_SHA256_MISMATCH');
  const source = JSON.parse(bytes.toString('utf8'));
  if (source.schema !== 'QRP_TRIAL_LEDGER_FOLLOWUP_INPUTS_V1') throw new Error('FOLLOWUP_INPUT_SCHEMA_MISMATCH');
  if (mode === 'forward-reserved') {
    const marks = followups.forwardReservedFromRegistry({
      file: source.registry.path, sha256: source.registry.sha256,
      familyMap: source.familyMap, openEndedTo: source.registry.openEndedTo,
    });
    const rows = ledger.markSegments(marks, { registeredBy, dryRun });
    return { mode, dry_run: dryRun, rows, summary: Object.fromEntries([...new Set(rows.map((r) => r.family_id))].sort().map((f) => [f, rows.filter((r) => r.family_id === f).length])) };
  }
  if (mode === 'uncounted-history') {
    const specs = followups.uncountedHistorySpecs(source.uncountedHistory);
    const before = Object.fromEntries([...new Set(specs.map((s) => s.family_id))].sort().map((f) => [f, ledger.count(f)]));
    const rows = ledger.register(specs, { registeredBy, mode: 'BACK_REGISTERED', dryRun });
    const projected = ledger.heads([...ledger.trialRows(), ...rows]);
    const afterRows = [...projected.values()];
    const after = Object.fromEntries(Object.keys(before).map((f) => [f, ledger.count(f, { rows: afterRows })]));
    return { mode, dry_run: dryRun, rows, before, after };
  }
  throw new Error(`FOLLOWUP_MODE_INVALID:${mode}`);
}

function main(argv) {
  const f = flags(argv);
  for (const key of ['mode', 'inputs', 'inputs-sha256', 'registered-by', 'dry-run']) if (!f[key]) throw new Error(`MISSING_FLAG:${key}`);
  if (f['dry-run'] !== 'true' && f['dry-run'] !== 'false') throw new Error('DRY_RUN_MUST_BE_TRUE_OR_FALSE');
  const out = run({ mode: f.mode, inputs: f.inputs, inputsSha256: f['inputs-sha256'], registeredBy: f['registered-by'], dryRun: f['dry-run'] === 'true' });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { run };
