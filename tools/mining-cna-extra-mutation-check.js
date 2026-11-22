#!/usr/bin/env node
'use strict';

/**
 * RF1116 修订 2026-11（A 股加一轮）两处计数的变异检查：对 monthlyCapOf / excludedFromHoldoutCount 的每个条件各做一个小改动，核对 tests/mining_cna_extra_round.test.js 一定变红。
 *   node tools/mining-cna-extra-mutation-check.js [--only N01,N07] [--write docs/evidence/rf1116-cna-extra-round-v1/MUTATION_RESULTS.json [--merge]]
 * 做法同 tools/mining-llm-mutation-check.js（先跑基线必须全绿，逐个变异、无论如何还原；变红 = 杀死，仍然全绿 = 幸存）。
 * 在 Mac 上用 ~/bin/heavy-run --light --label <who/what> -- node tools/mining-cna-extra-mutation-check.js 跑。
 * 有一个等价变异没做：让 MINE_ROUND_HOLDOUT_SEGMENT_OPENED 也看「计数的轮」——被排除的轮从不开启留出段，所以行为等价。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NEW = 'tests/mining_cna_extra_round.test.js';
const RRC = 'services/mining-rounds/index.js';

/** 每个变异：file 里的 find 恰好出现一次，换成 replace；tests 是要跑的测试文件。 */
const MUTANTS = [
  { id: 'N01', guard: 'monthly exception applies only to its month', file: RRC, find: 'e.market === market && e.month === month', replace: 'e.market === market', tests: [NEW] },
  { id: 'N02', guard: 'monthly exception applies only to its market', file: RRC, find: 'e.market === market && e.month === month', replace: 'e.month === month', tests: [NEW] },
  { id: 'N03', guard: 'the exception cap is exactly 3', file: RRC, find: "market: 'CN_A', month: '2026-11', rounds_per_month: 3,", replace: "market: 'CN_A', month: '2026-11', rounds_per_month: 4,", tests: [NEW] },
  { id: 'N04', guard: 'the exception is read (monthlyCapOf ignores nothing)', file: RRC, find: 'return x ? x.rounds_per_month : LIMITS.rounds_per_month;', replace: 'return LIMITS.rounds_per_month;', tests: [NEW] },
  { id: 'N05', guard: 'the global monthly limit stays 2', file: RRC, find: 'candidates_per_round: 200, rounds_per_month: 2,', replace: 'candidates_per_round: 200, rounds_per_month: 3,', tests: [NEW] },
  { id: 'N06', guard: 'openRound uses monthlyCapOf', file: RRC, find: 'length < monthlyCapOf(o.market, month)', replace: 'length < LIMITS.rounds_per_month', tests: [NEW] },
  { id: 'N07', guard: 'only FAILED_EVALUATION rounds are left out of the holdout count', file: RRC, find: "if (r.status !== 'FAILED_EVALUATION' || r.holdout_opens) return false;", replace: 'if (r.holdout_opens) return false;', tests: [NEW] },
  { id: 'N08', guard: 'a round with holdout_opens on its row still counts', file: RRC, find: "if (r.status !== 'FAILED_EVALUATION' || r.holdout_opens) return false;", replace: "if (r.status !== 'FAILED_EVALUATION') return false;", tests: [NEW] },
  { id: 'N09', guard: 'a round with a vault open row still counts', file: RRC, find: "if (require('../holdout-vault').openLog(r.round_id).length) return false;\n", replace: '', tests: [NEW] },
  { id: 'N10', guard: 'a missing selection row is unknown, not 0 (still counts)', file: RRC, find: 'return sel !== null && Array.isArray(sel.selected) && sel.selected.length === 0;', replace: 'return sel === null || (Array.isArray(sel.selected) && sel.selected.length === 0);', tests: [NEW] },
  { id: 'N11', guard: 'a round that selected candidates still counts', file: RRC, find: 'return sel !== null && Array.isArray(sel.selected) && sel.selected.length === 0;', replace: 'return sel !== null && Array.isArray(sel.selected);', tests: [NEW] },
  { id: 'N12', guard: 'FAILED_PARTIAL is not left out', file: RRC, find: "if (r.status !== 'FAILED_EVALUATION' || r.holdout_opens) return false;", replace: "if (!['FAILED_EVALUATION', 'FAILED_PARTIAL'].includes(r.status) || r.holdout_opens) return false;", tests: [NEW] },
  { id: 'N13', guard: 'the holdout count uses the exclusion', file: RRC, find: 'need(sharing.filter((r) => !excludedFromHoldoutCount(r)).length < LIMITS.rounds_per_holdout,', replace: 'need(sharing.length < LIMITS.rounds_per_holdout,', tests: [NEW] },
  { id: 'N14', guard: 'a segment still serves at most 2 counted rounds', file: RRC, find: 'need(sharing.filter((r) => !excludedFromHoldoutCount(r)).length < LIMITS.rounds_per_holdout,', replace: 'need(sharing.filter((r) => !excludedFromHoldoutCount(r)).length < LIMITS.rounds_per_holdout + 1,', tests: [NEW] },
  { id: 'N15', guard: 'the cited page sha is checked against the repo copy', file: RRC, find: "sha256: '571e145e21ab46854fbf5b8c94da3784a3045e98f9fcde32d0167364159b43aa',", replace: "sha256: '571e145e21ab46854fbf5b8c94da3784a3045e98f9fcde32d0167364159b43ab',", tests: [NEW] },
  { id: 'N16', guard: 'an unopened-holdout rule still refuses a new round on an opened segment', file: RRC, find: "need(!sharing.some((r) => r.holdout_opens || vault.openLog(r.round_id).length), 'MINE_ROUND_HOLDOUT_SEGMENT_OPENED'", replace: "need(true, 'MINE_ROUND_HOLDOUT_SEGMENT_OPENED'", tests: [NEW] },
];

function listFailures(out) {
  return [...new Set((out.match(/^✖ .+$/gm) || []).map((l) => l.replace(/ \(\d+(\.\d+)?ms\)$/, '')).filter((l) => !/^✖ tests\//.test(l)))];
}
function runTests(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  return { status: r.status, failing: listFailures(`${r.stdout || ''}\n${r.stderr || ''}`) };
}

function main(argv) {
  const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
  const outFile = argv.includes('--write') ? argv[argv.indexOf('--write') + 1] : null;
  const merge = argv.includes('--merge'); // keep the other entries of the existing results file, replace the ones re-run (a targeted re-run after a test fix)
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...new Set(MUTANTS.map((m) => m.file))], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) { process.stderr.write(`refusing to run: uncommitted changes in mutated files:\n${dirty}\n`); return 2; }
  const files = [...new Set(MUTANTS.flatMap((m) => m.tests))];
  const base = runTests(files);
  if (base.status !== 0) { process.stderr.write(`baseline is not green: ${JSON.stringify(base.failing)}\n`); return 2; }
  const results = [];
  for (const m of MUTANTS.filter((x) => !only || only.has(x.id))) {
    const abs = path.join(ROOT, m.file);
    const original = fs.readFileSync(abs, 'utf8');
    const count = original.split(m.find).length - 1;
    if (count !== 1) { process.stderr.write(`${m.id}: find text occurs ${count} times in ${m.file}\n`); results.push({ id: m.id, guard: m.guard, file: m.file, result: 'BAD_MUTANT', occurrences: count }); continue; }
    let r;
    try { fs.writeFileSync(abs, original.replace(m.find, () => m.replace)); r = runTests(m.tests); } finally { fs.writeFileSync(abs, original); }
    const killed = r.status !== 0;
    results.push({ id: m.id, guard: m.guard, file: m.file, tests: m.tests, result: killed ? 'KILLED' : 'SURVIVED', failing: r.failing.slice(0, 5), head, ...(m.expect ? { note: m.expect } : {}) });
    process.stdout.write(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${m.guard}${killed ? `  <- ${r.failing[0] || `exit ${r.status}`}` : ''}\n`);
  }
  let all = results;
  if (merge && outFile && fs.existsSync(path.join(ROOT, outFile))) {
    const prior = JSON.parse(fs.readFileSync(path.join(ROOT, outFile), 'utf8')).results.filter((x) => !results.some((y) => y.id === x.id));
    all = [...prior, ...results].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  const summary = { schema: 'MINING_CNA_EXTRA_ROUND_MUTATION_RESULTS_V1', baseline: 'GREEN', mutants: all.length, killed: all.filter((x) => x.result === 'KILLED').length,
    survived: all.filter((x) => x.result === 'SURVIVED').map((x) => x.id), bad: all.filter((x) => x.result === 'BAD_MUTANT').map((x) => x.id), heads: [...new Set(all.map((x) => x.head).filter(Boolean))], results: all };
  if (outFile) { fs.mkdirSync(path.dirname(path.join(ROOT, outFile)), { recursive: true }); fs.writeFileSync(path.join(ROOT, outFile), `${JSON.stringify(summary, null, 2)}\n`); }
  process.stdout.write(`${JSON.stringify({ mutants: summary.mutants, killed: summary.killed, survived: summary.survived, bad: summary.bad, heads: summary.heads })}\n`);
  return summary.survived.length || summary.bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { MUTANTS, listFailures };
