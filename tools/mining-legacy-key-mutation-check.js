#!/usr/bin/env node
'use strict';

/**
 * Mutation check of the legacy round row rule (schemas/index.js LEGACY_ABSENT_FIELDS; tests/mining_legacy_round_rows.test.js must go red for each mutant).
 *   node tools/mining-legacy-key-mutation-check.js [--head <sha>] [--write docs/evidence/rf1116-legacy-round-key-v1/MUTATION_RESULTS.json]
 * One equivalent mutant is not made: looking the table up by MINING_ROUND_V1 instead of by the row's schema. No other schema has the field (test L5 pins that premise), so it
 * cannot relax anything else; SCHEMAS is frozen, so a test cannot add a schema to show the difference.
 * Run it on a COPY of the tree (~/bin-v6q0/linux-test, ci-node image); it rewrites source files while it runs and restores them whatever happens.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const T = 'tests/mining_legacy_round_rows.test.js';
const SCH = 'schemas/index.js';
const NEU = 'services/mining-rounds/neutralization.js';
const m = (id, guard, file, find, replace) => ({ id, guard, file, find, replace, tests: [T] });
const MUTANTS = [
  m('K01', 'the key may be absent only for the listed rounds (matched by round_id)', SCH, 'if (legacy && legacy.includes(rec.round_id)) continue;', 'if (legacy) continue;'),
  m('K02', 'the legacy check is applied (absent stays MISSING otherwise)', SCH, 'if (legacy && legacy.includes(rec.round_id)) continue;', 'if (false) continue;'),
  m('K03', 'the list holds exactly rounds 1 and 2', SCH, "scoring_neutralization: Object.freeze(['MR-CN_A-2026-11-e1ab63a27b', 'MR-CN_A-2026-11-2a1d2c9c82']),", "scoring_neutralization: Object.freeze(['MR-CN_A-2026-11-e1ab63a27b', 'MR-CN_A-2026-11-2a1d2c9c82', 'MR-CN_A-2026-11-a6cb823f86']),"),
  m('K04', 'the list is frozen', SCH, "scoring_neutralization: Object.freeze(['MR-CN_A-2026-11-e1ab63a27b', 'MR-CN_A-2026-11-2a1d2c9c82']),", "scoring_neutralization: ['MR-CN_A-2026-11-e1ab63a27b', 'MR-CN_A-2026-11-2a1d2c9c82'],"),
  m('K06', 'the legacy table is for this field only (no general optionality)', SCH, 'const legacy = LEGACY_ABSENT_FIELDS[schemaName] && LEGACY_ABSENT_FIELDS[schemaName][field];', 'const legacy = LEGACY_ABSENT_FIELDS[schemaName] && Object.values(LEGACY_ABSENT_FIELDS[schemaName])[0];'),
  m('K07', 'neutralizationOf uses the same list as the validator', NEU, "require('../../schemas').LEGACY_ABSENT_FIELDS.MINING_ROUND_V1.scoring_neutralization;", "Object.freeze(['MR-CN_A-2026-11-e1ab63a27b', 'MR-CN_A-2026-11-2a1d2c9c82']);"),
  m('K08', 'LEGACY_ABSENT_FIELDS is exported', SCH, 'module.exports = { SCHEMAS, LEGACY_ABSENT_FIELDS, validateRecord, validateLedger };', 'module.exports = { SCHEMAS, validateRecord, validateLedger };'),
];

function listFailures(out) { return [...new Set((out.match(/^not ok \d+ - .+$/gm) || []).map((l) => l.replace(/^not ok \d+ - /, '')))]; }
function runTests(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  return { status: r.status, failing: listFailures(`${r.stdout || ''}\n${r.stderr || ''}`) };
}
const arg = (argv, k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);

function main(argv) {
  const outFile = arg(argv, '--write');
  let head = arg(argv, '--head');
  try {
    if (!head) head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ...new Set(MUTANTS.map((x) => x.file))], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (dirty) { process.stderr.write(`refusing to run: uncommitted changes in mutated files:\n${dirty}\n`); return 2; }
  } catch { if (!head) { process.stderr.write('not a git checkout: pass --head <sha>\n'); return 2; } }
  const base = runTests([T]);
  if (base.status !== 0) { process.stderr.write(`baseline is not green: ${JSON.stringify(base.failing)}\n`); return 2; }
  const results = [];
  for (const x of MUTANTS) {
    const abs = path.join(ROOT, x.file);
    const original = fs.readFileSync(abs, 'utf8');
    const count = original.split(x.find).length - 1;
    if (count !== 1) { process.stderr.write(`${x.id}: find text occurs ${count} times in ${x.file}\n`); results.push({ id: x.id, guard: x.guard, file: x.file, result: 'BAD_MUTANT', occurrences: count }); continue; }
    let r;
    try { fs.writeFileSync(abs, original.replace(x.find, () => x.replace)); r = runTests(x.tests); } finally { fs.writeFileSync(abs, original); }
    const killed = r.status !== 0;
    results.push({ id: x.id, guard: x.guard, file: x.file, tests: x.tests, result: killed ? 'KILLED' : 'SURVIVED', failing: r.failing.slice(0, 5), head });
    process.stdout.write(`${x.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${x.guard}${killed ? `  <- ${r.failing[0] || `exit ${r.status}`}` : ''}\n`);
  }
  const summary = { schema: 'MINING_LEGACY_KEY_MUTATION_RESULTS_V1', baseline: 'GREEN', mutants: results.length, killed: results.filter((x) => x.result === 'KILLED').length,
    survived: results.filter((x) => x.result === 'SURVIVED').map((x) => x.id), bad: results.filter((x) => x.result === 'BAD_MUTANT').map((x) => x.id), heads: [head], results };
  if (outFile) { fs.mkdirSync(path.dirname(path.join(ROOT, outFile)), { recursive: true }); fs.writeFileSync(path.join(ROOT, outFile), `${JSON.stringify(summary, null, 2)}\n`); }
  process.stdout.write(`${JSON.stringify({ mutants: summary.mutants, killed: summary.killed, survived: summary.survived, bad: summary.bad, heads: summary.heads })}\n`);
  return summary.survived.length || summary.bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { MUTANTS };
