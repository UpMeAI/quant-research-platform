'use strict';
// Explicit, uninstalled daily delivery entry point. No discovery or producer calls.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sha256, canonicalJson } = require('../desk-review-routing/canonical');
const { isRegisteredDailyLedger } = require('./desk-input');
const { run } = require('./index');
const { renderReport } = require('./report');

function replace(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
async function runDailyLedgers({ packs, root = path.resolve(__dirname, '../../var/ai-review'), ...options }) {
  if (!Array.isArray(packs)) throw Error('DAILY_PACKS_INVALID');
  const results = [];
  for (const original of packs) {
    if (!original || !/^\d{4}-\d{2}-\d{2}$/.test(original.period) || original.output !== 'DAILY' || !Array.isArray(original.facts)) throw Error('DAILY_PACK_INVALID');
    const ledger = typeof original.ledger === 'string' ? original.ledger : null;
    const valid = isRegisteredDailyLedger(ledger) && original.coverage === 'DESK_DAILY_THREE_SOURCE_SLICE';
    const pack = { ...original, ledger, states: Array.isArray(original.states) ? original.states : [],
      ...(valid ? {} : { inputState: 'INPUT_MISSING', states: [{ ledger, status: 'INPUT_MISSING', reason: 'DAILY_SCOPE_INVALID' }] }) };
    // No source-controlled path segments, including ledger IDs, enter filesystem paths.
    const namespace = `ledger-${sha256(canonicalJson(ledger))}`;
    const result = await run({ ...options, root, pack, namespace });
    const dir = path.join(root, pack.period, namespace);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Delivery snapshots are separate from immutable model attempts/cache. A missing
    // budget/key/input can recover; rendering never changes the once-per-period claim.
    const jsonFile = path.join(dir, 'DAILY.report.json');
    const markdownFile = path.join(dir, 'DAILY.report.md');
    replace(markdownFile, renderReport(result));
    replace(jsonFile, JSON.stringify(result, null, 2));
    results.push({ result, jsonFile, markdownFile });
  }
  return results;
}
module.exports = { runDailyLedgers };
