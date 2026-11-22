#!/usr/bin/env node
'use strict';

/**
 * Mutation check for K2_FREEZE_PROGRAM_V1 (AQ-37 "mutation-pinned"): one small change per guard, the named test file must go red (KILLED).
 *   node tools/k2-freeze-program-mutation-check.js [--only M07,M12] [--write docs/evidence/k2-freeze-program-mutation-v1/MUTATION_RESULTS.json [--merge]]
 * Runs a baseline first (must be green), then each mutant against ONE test file, serially, restoring the file in a finally block.
 * On the Mac run it as one serial task: ~/bin/heavy-run --light --label <who/what> -- node tools/k2-freeze-program-mutation-check.js
 * Refuses to run with uncommitted changes in the mutated files. Edits only repository source files; no network.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const T1 = 'tests/k2_freeze_program_validators.test.js';
const T2 = 'tests/k2_freeze_program_pipeline.test.js';
const T3 = 'tests/k2_freeze_program_support.test.js';
const D = 'services/k2-freeze-program';
const VAL = `${D}/validators.js`;
const IDX = `${D}/index.js`;
const SCH = `${D}/schema.js`;
const TPL = `${D}/templates.js`;
const GATE = `${D}/program_freeze_gate.js`;
const BND = `${D}/bundle.js`;

/** Each mutant: `find` occurs exactly once in `file`; it is replaced by `replace`; `tests` is the one test file that must fail. */
const MUTANTS = [
  { id: 'M01', guard: 'V1: a draft cannot request deviation codes', file: SCH, find: "else if (draft.deviation_codes.length) codes.push('PREREG_SCHEMA_DEVIATION_NOT_ALLOWED');", replace: '', tests: [T1] },
  { id: 'M02', guard: 'V1: free text cannot carry forged tokens', file: SCH, find: 'if (FORBIDDEN_TEXT.test(v)) codes.push', replace: 'if (false) codes.push', tests: [T1] },
  { id: 'M03', guard: 'V1: desk items are all required', file: SCH, find: "if (typeof d[k] !== 'string' || !d[k].trim()) codes.push(", replace: 'if (false) codes.push(', tests: [T1] },
  { id: 'M04', guard: 'V2: parameter ranges are enforced', file: TPL, find: "const inRange = spec.type === 'enum' ? spec.values.includes(v) : v >= spec.min && v <= spec.max;", replace: 'const inRange = true;', tests: [T1] },
  { id: 'M05', guard: 'V2: no free text in the decision table', file: TPL, find: "if (k !== 'template_id' && k !== 'params') codes.push(", replace: 'if (false) codes.push(', tests: [T1] },
  { id: 'M06', guard: 'power tool rounds the sample size up', file: `${D}/power.js`, find: 'return Math.ceil(round6((z / effect) ** 2));', replace: 'return Math.floor(round6((z / effect) ** 2));', tests: [T3] },
  { id: 'M07', guard: 'V3: n_required must equal the tool', file: VAL, find: 'if (p.n_required !== n) codes.push(', replace: 'if (false) codes.push(', tests: [T1] },
  { id: 'M08', guard: 'V3: numbers in the criteria text must be tool or table numbers', file: VAL, find: 'if (!allowed.has(Number(tok))) codes.push(', replace: 'if (false) codes.push(', tests: [T1] },
  { id: 'M09', guard: 'V4: settled, shadow-running and live routes are refused', file: VAL, find: "const REFUSED_ROUTES = Object.freeze(['NOT_DO_SETTLED', 'ATTACH_TO_SHADOW', 'QUARTERLY_ABLATION']);", replace: 'const REFUSED_ROUTES = Object.freeze([]);', tests: [T1] },
  { id: 'M10', guard: 'V5: N/A code must be one of the five classes', file: VAL, find: 'if (!causality.NOT_APPLICABLE_CODES.includes(decl.na[0]))', replace: 'if (false)', tests: [T1] },
  { id: 'M11', guard: 'V5: evidence code sha must be the pinned one', file: VAL, find: 'else if (pinned !== doc.code_sha)', replace: 'else if (false)', tests: [T1] },
  { id: 'M12', guard: 'V5: every function passes T-C1..T-C3', file: VAL, find: "if (fn[t] !== 'PASS') codes.push(", replace: 'if (false) codes.push(', tests: [T1] },
  { id: 'M13', guard: 'V6: a parity refusal is a refusal', file: VAL, find: "  } catch (e) { return [codeOf(e)]; }\n};\n\nfunction componentsOf", replace: "  } catch (e) { return []; }\n};\n\nfunction componentsOf", tests: [T1] },
  { id: 'M14', guard: 'V7: parameters are scalars or identifiers, never expressions', file: VAL, find: 'if (!IDENT.test(k) || !scalar) codes.push(', replace: 'if (false) codes.push(', tests: [T1] },
  { id: 'M15', guard: 'V7: components must be registered ids', file: VAL, find: 'else if (!sets[c.kind].has(c.id)) codes.push(', replace: 'else if (false) codes.push(', tests: [T1] },
  { id: 'M16', guard: 'V8: no first read of an UNSEEN segment (P3)', file: VAL, find: "if (labels.includes('UNSEEN')) codes.push(", replace: 'if (false) codes.push(', tests: [T1] },
  { id: 'M17', guard: 'V8: no new data fetch', file: VAL, find: "if (s.new_data_fetch) codes.push('PREREG_DATA_NEW_FETCH');", replace: '', tests: [T1] },
  { id: 'M18', guard: 'V8: data must be on this host', file: VAL, find: 'if (!inv.has(key)) codes.push(', replace: 'if (false) codes.push(', tests: [T1] },
  { id: 'M19', guard: 'V9: TRL rows strictly before the freeze time (AQ-40)', file: VAL, find: 'if (row && !(Date.parse(row.registered_at) < frozen)) late.push(', replace: 'if (row && !(Date.parse(row.registered_at) <= frozen)) late.push(', tests: [T2] },
  { id: 'M20', guard: 'V9: G-TRIAL-PRE check runs', file: VAL, find: 'try { trialGates.internals.checkPre(entry, Buffer.from(text), rows); }', replace: 'try { /* skipped */ }', tests: [T1] },
  { id: 'M21', guard: 'V10: no network for the agent', file: VAL, find: "else if (r.network.egress !== 'NONE') codes.push(", replace: 'else if (false) codes.push(', tests: [T1] },
  { id: 'M22', guard: 'V10: canaries must be unreadable', file: VAL, find: "else if (cn.probes.some((p) => p.readable !== false)) codes.push('PREREG_ISOLATION_CANARY');", replace: '', tests: [T1] },
  { id: 'M23', guard: 'V10: bundle from the deterministic builder', file: VAL, find: 'b.builder !== bundleBuilder.BUILDER ||', replace: 'false ||', tests: [T1] },
  { id: 'M24', guard: 'V11: weekly cap', file: VAL, find: '>= rf1118.CAPS.per_week) codes.push', replace: '>= rf1118.CAPS.per_week + 1) codes.push', tests: [T2] },
  { id: 'M25', guard: 'V11: monthly cap', file: VAL, find: '>= rf1118.CAPS.per_month) codes.push', replace: '>= rf1118.CAPS.per_month + 1) codes.push', tests: [T2] },
  { id: 'M26', guard: 'V11: arms cap', file: VAL, find: 'if (counted > rf1118.CAPS.arms_per_freeze)', replace: 'if (counted > rf1118.CAPS.arms_per_freeze + 1)', tests: [T2] },
  { id: 'M27', guard: 'V11: market and host agree', file: VAL, find: 'if (isAi(draft) && draft.authored_by.host !== MARKET_HOST[draft.market]) codes.push(', replace: 'if (false) codes.push(', tests: [T1] },
  { id: 'M28', guard: 'V12: an existing different freeze is never overwritten', file: VAL, find: 'if (existing && existing.k2_sha256 !== k2Sha) codes.push(', replace: 'if (false) codes.push(', tests: [T1] },
  { id: 'M29', guard: 'V13: one queue line per freeze', file: VAL, find: "if (queueLine.count(ctx.queueLogText || '', k2Sha) >= 1) return [", replace: 'if (false) return [', tests: [T1] },
  { id: 'M30', guard: 'V14: prompt, schema and model must be admitted', file: VAL, find: 'if (!hit) return [', replace: 'if (false) return [', tests: [T1] },
  { id: 'M31', guard: 'gate: RF1118 must be bound', file: IDX, find: "if (!rf1118.isBound(frozen)) return { code: 'PREREG_RF1118_NOT_FROZEN' };", replace: '', tests: [T2] },
  { id: 'M32', guard: 'gate: DRAFT_ONLY mode never freezes', file: IDX, find: "if ((ctx.freezeMode || 'PROGRAM') !== 'PROGRAM') return", replace: 'if (false) return', tests: [T2] },
  { id: 'M33', guard: 'gate: a downgraded class never freezes', file: IDX, find: "if (down.includes('*') || classes.some((c) => down.includes(c))) return", replace: 'if (false) return', tests: [T2] },
  { id: 'M34', guard: 'at most 3 revisions', file: IDX, find: 'draft.revision > MAX_REVISION)', replace: 'draft.revision > MAX_REVISION + 1)', tests: [T2] },
  { id: 'M35', guard: 'artifacts are written read-only', file: IDX, find: "fs.writeFileSync(file, bytes, { mode: 0o444, flag: 'wx' });\n      fs.chmodSync(file, 0o444);\n      written.push(file);", replace: "fs.writeFileSync(file, bytes, { mode: 0o644, flag: 'wx' });\n      fs.chmodSync(file, 0o644);\n      written.push(file);", tests: [T2] },
  { id: 'M36', guard: 'a draft that changed after prepare is refused', file: IDX, find: "const preparedMismatch = phase === 'FINALIZE' && Boolean(prepared) &&", replace: "const preparedMismatch = false && Boolean(prepared) &&", tests: [T1] },
  { id: 'M37', guard: 'refusal files are written read-only', file: IDX, find: "if (!fs.existsSync(file)) { fs.writeFileSync(file, bytes, { mode: 0o444, flag: 'wx' }); fs.chmodSync(file, 0o444); }", replace: "if (!fs.existsSync(file)) { fs.writeFileSync(file, bytes, { mode: 0o644, flag: 'wx' }); fs.chmodSync(file, 0o644); }", tests: [T2] },
  { id: 'M38', guard: 'importer gate: report sha must match the page', file: GATE, find: "need(sha256(report) === block.report_sha256 && sha256(report) === fp.report.sha256, 'REPORT_MISMATCH', entry.id);", replace: '', tests: [T3] },
  { id: 'M39', guard: 'importer gate: exactly one queue line', file: GATE, find: "need(lines.length === 1, 'QUEUE_LINE_DUPLICATE', `${entry.id}:${lines.length}`);", replace: '', tests: [T3] },
  { id: 'M40', guard: 'importer gate: unreadable queue log is not "no line"', file: GATE, find: "need(typeof log === 'string', 'QUEUE_LOG_UNAVAILABLE', entry.id);", replace: '', tests: [T3] },
  { id: 'M41', guard: 'importer gate: not before RF1118', file: GATE, find: "need(Date.parse(block.k2_frozen_at) >= Date.parse(effectiveFrom), 'BEFORE_RF1118', `${entry.id}:${block.k2_frozen_at}`);", replace: '', tests: [T3] },
  { id: 'M42', guard: 'importer gate: all 14 results pass', file: GATE, find: "need(ok, 'REPORT_NOT_ALL_PASS', `${entry.id}:${r.v}:${r.state}`);", replace: '', tests: [T3] },
  { id: 'M43', guard: 'importer gate: binding on a non-program K2 is refused', file: GATE, find: "need(entry.freeze_program === undefined || entry.freeze_program === null, 'BINDING_ON_UNGATED', entry.id);", replace: '', tests: [T3] },
  { id: 'M44', guard: 'bundle: forbidden path segments', file: BND, find: 'return parts.some((p) => FORBIDDEN_SEGMENT.test(p)) ||', replace: 'return false ||', tests: [T3] },
  { id: 'M45', guard: 'bundle: symlinks resolved before the check', file: BND, find: "need(!relReal.startsWith('..') && !forbidden(relReal), 'BUNDLE_SOURCE_FORBIDDEN', `resolved: ${relReal}`);", replace: '', tests: [T3] },
  { id: 'M46', guard: 'bundle: canary content refused', file: BND, find: "need(!bytes.includes(TOKEN_PREFIX), 'BUNDLE_CANARY_FOUND', relGiven);", replace: '', tests: [T3] },
  { id: 'M47', guard: 'canary: a missing canary is unknown, not unreadable', file: `${D}/canary.js`, find: 'else { out.push({ label, readable: null }); unknown.push(label); }', replace: 'else { out.push({ label, readable: false }); }', tests: [T3] },
  { id: 'M48', guard: 'registrar: arm k2 sha must equal the request', file: `${D}/registrar.js`, find: "need(spec.k2_sha256 === request.k2_sha256, 'REGISTRAR_K2_SHA256_MISMATCH', String(spec.config_label));", replace: '', tests: [T3] },
  { id: 'M49', guard: 'registrar: only research-arm roles', file: `${D}/registrar.js`, find: "need(ROLES.includes(spec.role), 'REGISTRAR_ROLE_NOT_ALLOWED', String(spec.role));", replace: '', tests: [T3] },
  { id: 'M50', guard: 'revocation never overwrites a revocation', file: `${D}/revocation.js`, find: "if (fs.existsSync(file)) fail('REVOCATION_EXISTS', draftId);", replace: '', tests: [T2] },
  { id: 'M51', guard: 'RF1118 weekly cap constant', file: `${D}/rf1118.js`, find: 'per_week: 2,', replace: 'per_week: 3,', tests: [T2] },
  { id: 'M53', guard: 'V9: skew classification needs both offsets', file: VAL, find: "kind = diff <= Math.abs(offsets.registrar_offset_ms) + Math.abs(offsets.program_offset_ms) + tolerance ? 'SKEW_POSSIBLE' : 'ORDERING_ERROR';", replace: "kind = 'SKEW_POSSIBLE';", tests: [T1] },
  { id: 'M54', guard: 'V14: flash by default, other models need a quality-gate record', file: VAL, find: 'if (a.model !== FLASH_MODEL && !a.quality_gate_record_id) return', replace: 'if (false) return', tests: [T1] },
  { id: 'M55', guard: 'V1: a human-authored claim needs an identity', file: SCH, find: "codes.push('PREREG_SCHEMA_AUTHOR_IDENTITY_MISSING');", replace: '', tests: [T1] },
  { id: 'M52', guard: 'queue line: append is idempotent by k2 sha', file: `${D}/queue_line.js`, find: 'if (count(logText, m[2]) >= 1) return { text: logText, appended: false };', replace: '', tests: [T2] },
];

function listFailures(out) {
  return [...new Set((out.match(/^\s*✖ .+$/gm) || []).map((l) => l.trim().replace(/ \(\d+(\.\d+)?ms\)$/, '')))];
}
function runTests(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  return { status: r.status, failing: listFailures(`${r.stdout || ''}\n${r.stderr || ''}`) };
}

function main(argv) {
  const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
  const outFile = argv.includes('--write') ? argv[argv.indexOf('--write') + 1] : null;
  const merge = argv.includes('--merge');
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...new Set(MUTANTS.map((m) => m.file))], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) { process.stderr.write(`refusing to run: uncommitted changes in mutated files:\n${dirty}\n`); return 2; }
  for (const t of [T1, T2, T3]) { // baseline: one file at a time
    const base = runTests([t]);
    if (base.status !== 0) { process.stderr.write(`baseline is not green (${t}): ${JSON.stringify(base.failing)}\n`); return 2; }
  }
  const results = [];
  for (const m of MUTANTS.filter((x) => !only || only.has(x.id))) {
    const abs = path.join(ROOT, m.file);
    const original = fs.readFileSync(abs, 'utf8');
    const count = original.split(m.find).length - 1;
    if (count !== 1) { process.stderr.write(`${m.id}: find text occurs ${count} times in ${m.file}\n`); results.push({ id: m.id, guard: m.guard, file: m.file, result: 'BAD_MUTANT', occurrences: count }); continue; }
    let r;
    try { fs.writeFileSync(abs, original.replace(m.find, () => m.replace)); r = runTests(m.tests); } finally { fs.writeFileSync(abs, original); }
    const killed = r.status !== 0;
    results.push({ id: m.id, guard: m.guard, file: m.file, tests: m.tests, result: killed ? 'KILLED' : 'SURVIVED', failing: r.failing.slice(0, 5), head });
    process.stdout.write(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${m.guard}${killed ? `  <- ${r.failing[0] || `exit ${r.status}`}` : ''}\n`);
  }
  let all = results;
  if (merge && outFile && fs.existsSync(path.join(ROOT, outFile))) {
    const prior = JSON.parse(fs.readFileSync(path.join(ROOT, outFile), 'utf8')).results.filter((x) => !results.some((y) => y.id === x.id));
    all = [...prior, ...results].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  const summary = { schema: 'K2_FREEZE_PROGRAM_MUTATION_RESULTS_V1', baseline: 'GREEN', mutants: all.length, killed: all.filter((x) => x.result === 'KILLED').length,
    survived: all.filter((x) => x.result === 'SURVIVED').map((x) => x.id), bad: all.filter((x) => x.result === 'BAD_MUTANT').map((x) => x.id), heads: [...new Set(all.map((x) => x.head).filter(Boolean))], results: all };
  if (outFile) { fs.mkdirSync(path.dirname(path.join(ROOT, outFile)), { recursive: true }); fs.writeFileSync(path.join(ROOT, outFile), `${JSON.stringify(summary, null, 2)}\n`); }
  process.stdout.write(`${JSON.stringify({ mutants: summary.mutants, killed: summary.killed, survived: summary.survived, bad: summary.bad, heads: summary.heads })}\n`);
  return summary.survived.length || summary.bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { MUTANTS, listFailures };
