'use strict';
const fs = require('node:fs');
const { sha256 } = require('../desk-review-routing/canonical');
// Explicit, caller-selected delivered artifacts. Never discovers remote inputs,
// reads credentials, computes a market view, or substitutes another period.
function readFacts({ period, output, sources }) {
  const facts = [], states = [];
  for (const source of sources) {
    try {
      const bytes = fs.readFileSync(source.file);
      if (!/^[a-f0-9]{64}$/.test(source.sha256) || sha256(bytes) !== source.sha256) throw Error('SOURCE_HASH');
      const doc = JSON.parse(bytes);
      if (doc[source.periodField] !== period) { states.push({ ledger: source.ledger, status: 'INPUT_STALE' }); continue; }
      facts.push({ id: `F${facts.length + 1}`, ledger: source.ledger, sourceFile: source.file, sourceSha256: source.sha256, data: doc });
      states.push({ ledger: source.ledger, status: 'READY' });
    } catch { states.push({ ledger: source.ledger, status: 'INPUT_MISSING' }); }
  }
  return { period, output, facts, states, inputState: !states.length || states.some((s) => s.status === 'INPUT_MISSING') ? 'INPUT_MISSING' : states.some((s) => s.status === 'INPUT_STALE') ? 'INPUT_STALE' : 'READY' };
}
module.exports = { readFacts };
