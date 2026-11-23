#!/usr/bin/env node
'use strict';

/**
 * RF1116 second CN_A holdout segment (R2) registry: mutation check of its guards. Each mutant changes one condition of holdout-segments.js, the segment selection and
 * counting in mining-rounds, the vault, the runner, the CLI wiring or run.sh, and tests/mining_holdout_segment_registry.test.js must go red.
 *   node tools/mining-holdout-segments-mutation-check.js [--only H01,H07] [--head <sha>] [--write docs/evidence/rf1116-holdout-segment-registry-v1/MUTATION_RESULTS.json [--merge]]
 * Baseline must be green; every mutant is restored whatever happens; red = KILLED, still green = SURVIVED.
 * Run it on a COPY of the tree (the lane's test host: ~/bin-v6q0/linux-test, inside the ci-node image); it rewrites source files while it runs and refuses to run in a git
 * checkout that has uncommitted changes in the mutated files. Outside a git checkout pass --head <sha> for the provenance field.
 * Equivalent mutants not made: the legacy `segment.segment === undefined` clause of the vault's seal check (an R2 block on an R1 round already fails on from / to).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const T = 'tests/mining_holdout_segment_registry.test.js';
const REG = 'services/mining-rounds/holdout-segments.js';
const RRC = 'services/mining-rounds/index.js';
const VLT = 'services/holdout-vault/index.js';
const RUN = 'services/mining-sandbox/round-runner/index.js';
const CLI = 'services/mining-sandbox/round-runner/cli.js';
const SH = 'deploy/research-lane/round-runner/run.sh';

/** Each mutant: `find` occurs exactly once in `file`, replaced by `replace`; `tests` are the files that must go red. */
const m = (id, guard, file, find, replace) => ({ id, guard, file, find, replace, tests: [T] });
const MUTANTS = [
  m('H01', 'R1 serves 2026-11 and earlier only', REG, "months: Object.freeze({ from: null, to: '2026-11' })", "months: Object.freeze({ from: null, to: '2026-12' })"),
  m('H02', 'R2 serves 2026-12 onwards', REG, "months: Object.freeze({ from: '2026-12', to: null })", "months: Object.freeze({ from: '2027-01', to: null })"),
  m('H03', 'R2 starts after 2026-12-31', REG, "start: Object.freeze({ rule: 'FIRST_TRADING_DAY_AFTER', after: '2026-12-31' })", "start: Object.freeze({ rule: 'FIRST_TRADING_DAY_AFTER', after: '2027-01-04' })"),
  m('H04', 'R2 is 54 trading days long', REG, "length_trading_days: 54,\n    sealed_dir: 'rf1116-cn-a-daily-holdout-r2'", "length_trading_days: 53,\n    sealed_dir: 'rf1116-cn-a-daily-holdout-r2'"),
  m('H05', 'the registry is per market', REG, 'e.market === market && (e.months.from === null', '(e.months.from === null'),
  m('H06', 'the R1 manifest block is exactly { from, to }', REG, 'if (entry.window) return { from: entry.window.from, to: entry.window.to };', 'if (entry.window) return { segment: entry.id, from: entry.window.from, to: entry.window.to };'),
  m('H07', 'the R2 end is UNKNOWN, never guessed', REG, 'length_trading_days: entry.length_trading_days, from: UNKNOWN, to: UNKNOWN };', "length_trading_days: entry.length_trading_days, from: UNKNOWN, to: '2027-03-31' };"),
  m('H08', 'the start is strictly after the rule date', REG, 'cal.findIndex((d) => d > entry.start.after)', 'cal.findIndex((d) => d >= entry.start.after)'),
  m('H09', 'the end is the 54th day counting the start', REG, 'const last = i + entry.length_trading_days - 1;', 'const last = i + entry.length_trading_days;'),
  m('H10', 'fewer than 54 listed days -> end UNKNOWN', REG, 'if (last >= cal.length) return', 'if (last > cal.length) return'),
  m('H11', 'a window is resolved only with both ends', REG, "DATE.test(h.from || '') && DATE.test(h.to || '');", "DATE.test(h.from || '');"),
  m('H12', 'the R2 cutoff rule: the start is strictly after the rule date', REG, 'h.start_after >= cutoff', 'h.start_after > cutoff'),
  m('H13', 'a ref names its directory by the last path component', REG, ".split('/').pop();", ".split('/').shift();"),
  m('H14', 'a stored R2 block must match the registry rule', REG, 'return e && e.start && h.start_after === e.start.after && h.length_trading_days === e.length_trading_days ? e : null;', 'return e && e.start ? e : null;'),
  m('H15', 'the month picks the segment', RRC, 'holdoutSegments.entryForMonth(month, o.market)', "holdoutSegments.entryForMonth('2026-11', o.market)"),
  m('H16', 'no segment for the market and month -> refused', RRC, "if (auto) need(entry, 'MINE_ROUND_HOLDOUT_SEGMENT_UNSELECTABLE'", "if (auto && entry) need(entry, 'MINE_ROUND_HOLDOUT_SEGMENT_UNSELECTABLE'"),
  m('H17', 'an explicit window is refused after registry rows exist', RRC, 'need(!prior.some((r) => r.holdout && r.holdout.segment !== undefined),', 'need(true,'),
  m('H18', 'an unregistered window in the ledger -> fail closed', RRC, 'need(!stray,', 'need(true,'),
  m('H19', 'no opening backwards onto an earlier segment', RRC, 'need(!owned.some((x) => x.e.number > entry.number),', 'need(true,'),
  m('H20', 'rounds are counted per segment', RRC, 'const mine = owned.filter((x) => x.e === entry).map((x) => x.r);', 'const mine = owned.map((x) => x.r);'),
  m('H21', 'the counting method leaves out unevaluated FAILED_EVALUATION rounds', RRC, 'need(mine.filter((r) => !excludedFromHoldoutCount(r)).length < LIMITS.rounds_per_holdout,', 'need(mine.length < LIMITS.rounds_per_holdout,'),
  m('H22', 'a segment serves at most 2 counted rounds', RRC, "need(mine.filter((r) => !excludedFromHoldoutCount(r)).length < LIMITS.rounds_per_holdout, 'MINE_ROUND_HOLDOUT_EXHAUSTED', entry.id);", "need(mine.filter((r) => !excludedFromHoldoutCount(r)).length <= LIMITS.rounds_per_holdout, 'MINE_ROUND_HOLDOUT_EXHAUSTED', entry.id);"),
  m('H23', 'an opened segment takes no new rounds', RRC, 'need(!mine.some((r) => r.holdout_opens || vault.openLog(r.round_id).length),', 'need(true,'),
  m('H24', 'opened-ness is per segment', RRC, '!mine.some((r) => r.holdout_opens || vault.openLog(r.round_id).length)', '!prior.some((r) => r.holdout_opens || vault.openLog(r.round_id).length)'),
  m('H25', 'the R2 manifest block keeps its segment id and rule', RRC, 'holdout: auto ? JSON.parse(JSON.stringify(holdout)) : {', 'holdout: auto ? { from: holdout.from, to: holdout.to } : {'),
  m('H26', 'the segment check runs for registry rounds', RRC, 'if (auto) checkSegmentUsable(entry, prior, o.market);', 'if (false) checkSegmentUsable(entry, prior, o.market);'),
  m('H27', 'the LLM cutoff rule is checked', RRC, 'need(holdoutSegments.startsAfter(holdout, g.model_knowledge_cutoff),', 'need(true || holdoutSegments.startsAfter(holdout, g.model_knowledge_cutoff),'),
  m('H28', 'the vault refuses to open an unresolved window', VLT, "need(holdoutSegments.isResolved(r.holdout), 'MINE_HOLDOUT_SEGMENT_END_UNKNOWN',", "need(true, 'MINE_HOLDOUT_SEGMENT_END_UNKNOWN',"),
  m('H29', 'seal compares the whole registry block', VLT, 'isDeepStrictEqual(segment, r.holdout)', 'segment.from === r.holdout.from'),
  m('H30', 'the seal row records the registry block', VLT, 'segment: registered ? { ...r.holdout } : { from: segment.from, to: segment.to }', 'segment: { from: segment.from, to: segment.to }'),
  m('H31', 'score refuses an unresolved window', RUN, "assertWindowResolved(r);\n  if (accessLog) assertHoldoutDate(scoredAt);", 'if (accessLog) assertHoldoutDate(scoredAt);'),
  m('H32', 'rescore refuses an unresolved window', RUN, "assertWindowResolved(r);\n  need(r.status === 'SCORING'", "need(r.status === 'SCORING'"),
  m('H33', 'a ref naming the other segment is refused', RUN, 'if (entry && owner) need(owner.id === entry.id,', 'if (entry && owner) need(true,'),
  m('H34', 'requestRound lets the registry choose', RUN, '    cap, openedAt: openedAt || undefined,', '    holdout: { from: segs.SEGMENTS.HOLDOUT.from, to: segs.SEGMENTS.HOLDOUT.to }, cap, openedAt: openedAt || undefined,'),
  m('H35', 'the CLI checks the ref before the round opens', CLI, "runner.assertHoldoutRef({ openedAt: o['opened-at'] || null, dataRef: o['holdout-ref'] });", 'void 0;'),
  m('H36', 'run.sh defaults to R1', SH, '"${RF1116_HOLDOUT_SEGMENT:-R1}" in', '"${RF1116_HOLDOUT_SEGMENT:-R2}" in'),
  m('H37', 'run.sh refuses an unknown segment', SH, '*) echo "run.sh: unknown RF1116_HOLDOUT_SEGMENT: ${RF1116_HOLDOUT_SEGMENT} (R1 or R2)" >&2; exit 64 ;;', '*) ;;'),
  m('H38', 'the cited R2 page sha is checked against the repo copy', REG, "sha256: 'b97f9916b20ba5a6ba8c8db8e5a6e5e750578a02c6635c812d4bbd2b01993dab',", "sha256: 'b97f9916b20ba5a6ba8c8db8e5a6e5e750578a02c6635c812d4bbd2b01993dac',"),
];

function listFailures(out) {
  const spec = (out.match(/^✖ .+$/gm) || []).map((l) => l.replace(/ \(\d+(\.\d+)?ms\)$/, '')).filter((l) => !/^✖ tests\//.test(l));
  const tap = (out.match(/^not ok \d+ - .+$/gm) || []).map((l) => l.replace(/^not ok \d+ - /, ''));
  return [...new Set([...spec, ...tap])];
}
function runTests(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  return { status: r.status, failing: listFailures(`${r.stdout || ''}\n${r.stderr || ''}`) };
}
const arg = (argv, k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);

function main(argv) {
  const only = arg(argv, '--only') ? new Set(arg(argv, '--only').split(',')) : null;
  const outFile = arg(argv, '--write');
  const merge = argv.includes('--merge'); // keep the other entries of the existing results file, replace the ones re-run
  let head = arg(argv, '--head');
  try {
    if (!head) head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ...new Set(MUTANTS.map((x) => x.file))], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (dirty) { process.stderr.write(`refusing to run: uncommitted changes in mutated files:\n${dirty}\n`); return 2; }
  } catch { if (!head) { process.stderr.write('not a git checkout: pass --head <sha>\n'); return 2; } }
  const files = [...new Set(MUTANTS.flatMap((x) => x.tests))];
  const base = runTests(files);
  if (base.status !== 0) { process.stderr.write(`baseline is not green: ${JSON.stringify(base.failing)}\n`); return 2; }
  const results = [];
  for (const x of MUTANTS.filter((y) => !only || only.has(y.id))) {
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
  let all = results;
  if (merge && outFile && fs.existsSync(path.join(ROOT, outFile))) {
    const prior = JSON.parse(fs.readFileSync(path.join(ROOT, outFile), 'utf8')).results.filter((x) => !results.some((y) => y.id === x.id));
    all = [...prior, ...results].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  const summary = { schema: 'MINING_HOLDOUT_SEGMENTS_MUTATION_RESULTS_V1', baseline: 'GREEN', mutants: all.length, killed: all.filter((x) => x.result === 'KILLED').length,
    survived: all.filter((x) => x.result === 'SURVIVED').map((x) => x.id), bad: all.filter((x) => x.result === 'BAD_MUTANT').map((x) => x.id), heads: [...new Set(all.map((x) => x.head).filter(Boolean))], results: all };
  if (outFile) { fs.mkdirSync(path.dirname(path.join(ROOT, outFile)), { recursive: true }); fs.writeFileSync(path.join(ROOT, outFile), `${JSON.stringify(summary, null, 2)}\n`); }
  process.stdout.write(`${JSON.stringify({ mutants: summary.mutants, killed: summary.killed, survived: summary.survived, bad: summary.bad, heads: summary.heads })}\n`);
  return summary.survived.length || summary.bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { MUTANTS, listFailures };
