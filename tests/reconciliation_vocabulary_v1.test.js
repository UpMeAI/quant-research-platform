'use strict';
// RECONCILIATION_VOCABULARY_V1 (frozen 2026-10-31) -- quant-research-platform mapping test.
//
// QRP produces and reads no source-reconciliation state. Two unrelated vocabularies here share the word:
// the account/cash reconciliation of a strategy-diagnostics package (MATCHED) and the replay-parity words
// (MATCHED / DIVERGED / UNKNOWN). Both are registered as other domains in the frozen contract (single source: Ashare-V6 docs/contracts; this repository carries a byte-identical copy); this file pins that
// they stay that, and that no source-reconciliation token arrives. It changes no behaviour.
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'contracts', 'RECONCILIATION_VOCABULARY_V1.json'), 'utf8'));
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const sorted = (values) => [...values].sort();
const keysOf = (id) => contract.vocabularies.find((item) => item.vocabulary === id).rows.map((row) => row.old);
const AUTHORITATIVE = contract.authoritative.storedValues.map((item) => item.value);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, out); } else if (/\.(?:js|mjs|cjs|json|html|py)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const productionFiles = contract.scanCoverage['quant-research-platform'].dirs.flatMap((dir) => walk(path.join(ROOT, dir)));
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

test('the contract copy is sealed and QRP declares no source-reconciliation role', () => {
  const body = { ...contract }; delete body.payloadSha256;
  assert.equal(contract.payloadSha256, crypto.createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex'),
    'the copy was edited without re-sealing; compare payloadSha256 with the other three repositories');
  assert.equal(contract.status, 'FROZEN');
  assert.equal(contract.singleSource.byteIdenticalCopies['quant-research-platform'], 'docs/contracts/RECONCILIATION_VOCABULARY_V1.json');
  assert.equal(contract.repoScopes['quant-research-platform'].sourceReconciliation, 'NONE');
});

test('no QRP production file names a source-reconciliation token', () => {
  const token = /source_?[rR]econciliation|SOURCE_RECONCILIATION|\b(?:MINOR_DIFFERENCE|MAJOR_CONFLICT|PRIMARY_ONLY|SECONDARY_ONLY|ALL_MISSING|SECONDARY_PENDING)\b/;
  const found = productionFiles.filter((file) => token.test(fs.readFileSync(file, 'utf8'))).map(rel).sort();
  assert.deepEqual(found, contract.scanCoverage['quant-research-platform'].sourceTokenFiles,
    'QRP now touches a source-reconciliation token: register the producer or consumer in the contract inventory first');
});

test('every inventory entry for this repository still points at its code', () => {
  for (const item of contract.inventory.filter((entry) => entry.repo === 'quant-research-platform')) {
    assert.ok(fs.existsSync(path.join(ROOT, item.file)), `${item.id}: ${item.file} is gone`);
    assert.ok(read(item.file).includes(item.anchor), `${item.id}: anchor not found in ${item.file}: ${item.anchor}`);
    for (const value of item.values) assert.ok(keysOf(item.vocabulary).includes(value), `${item.id}: ${value} is not in ${item.vocabulary}`);
  }
});

test('the only reconciliation_state QRP writes is the account word MATCHED, and it is not a source-reconciliation value', () => {
  const holders = productionFiles.filter((file) => /\breconciliation_?[sS]tate\b/.test(read(rel(file)))).map(rel).sort();
  assert.deepEqual(holders, contract.repoScopes['quant-research-platform'].reconciliationStateFiles);
  const literals = [...read(holders[0]).matchAll(/\breconciliation_state\s*:\s*'([A-Z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual(sorted(new Set(literals)), sorted(keysOf('QRP_ACCOUNT_RECONCILIATION')));
  assert.deepEqual(keysOf('QRP_ACCOUNT_RECONCILIATION').filter((value) => AUTHORITATIVE.includes(value)), [],
    'MATCHED is not one of the six source-reconciliation values (it is also the V6 core_pool_evaluation word: RV-D8)');
});

test('the replay-parity words are the registered ones', () => {
  const html = read('apps/research-web/index.html');
  const words = html.match(/PARITY_WORDS=\{([^}]*)\}/)[1].split(',').map((entry) => entry.split(':')[0].trim());
  assert.deepEqual(sorted(words), sorted(keysOf('QRP_ENGINE_PARITY')));
});
