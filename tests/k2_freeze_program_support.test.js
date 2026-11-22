'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const fx = require('./_k2_freeze_fixture');

const prog = require('../services/k2-freeze-program');
const templates = require('../services/k2-freeze-program/templates');
const power = require('../services/k2-freeze-program/power');
const bundle = require('../services/k2-freeze-program/bundle');
const canary = require('../services/k2-freeze-program/canary');
const registrar = require('../services/k2-freeze-program/registrar');
const pfGate = require('../services/k2-freeze-program/program_freeze_gate');
const overseas = require('../services/overseas-sealed-verdicts');

/**
 * Q3 supporting pieces of AUTONOMOUS_RESEARCH_QUEUE_V1: K2_DECISION_TABLE_TEMPLATES_V1, power tool, bundle builder, canary (AQ-38),
 * TRL registrar CLI, importer acceptance of program freeze pages (RF1118 C3, AQ-39), and the CLI exit codes.
 */
const { baseDraft, baseCtx, tmp, sha } = fx;
const ROOT = path.join(__dirname, '..');

test('K2_DECISION_TABLE_TEMPLATES_V1: a frozen library with a pinned sha; every template has typed, ranged parameters and no free text', () => {
  const lib = templates.LIBRARY;
  assert.equal(lib.schema, 'K2_DECISION_TABLE_TEMPLATES_V1');
  assert.ok(lib.templates.length >= 3);
  assert.equal(templates.librarySha256(lib), lib.library_sha256);
  assert.match(lib.library_sha256, /^[0-9a-f]{64}$/);
  for (const t of lib.templates) {
    assert.match(t.template_id, /^DT-[A-Z0-9-]+-V1$/);
    assert.deepEqual(t.outcomes, ['PASS', 'FAIL', 'INSUFFICIENT']);
    for (const spec of Object.values(t.params)) assert.ok(spec.type === 'enum' ? Array.isArray(spec.values) : Number.isFinite(spec.min) && Number.isFinite(spec.max));
  }
  assert.deepEqual(templates.validate({ template_id: 'DT-DELTA-VS-BASELINE-V1', params: { alpha: 0.05, power_target: 0.8, min_sample_n: 32, min_effect_sd: 0.5, ci_level: 0.95 } }), []);
  assert.deepEqual(templates.validate({ template_id: 'DT-DELTA-VS-BASELINE-V1', params: { alpha: 0.5, power_target: 0.8, min_sample_n: 32, min_effect_sd: 0.5, ci_level: 0.95 } }), ['PREREG_DECISION_TABLE_PARAM_RANGE:alpha']);
  assert.deepEqual(templates.validate({ template_id: 'DT-DELTA-VS-BASELINE-V1', params: { alpha: 0.05, power_target: 0.8, min_sample_n: 32.5, min_effect_sd: 0.5, ci_level: 0.95 } }), ['PREREG_DECISION_TABLE_PARAM_TYPE:min_sample_n']);
  assert.deepEqual(templates.validate({ template_id: 'DT-DELTA-VS-BASELINE-V1', params: { alpha: 0.05, power_target: 0.8, min_sample_n: 32, min_effect_sd: 0.5 } }), ['PREREG_DECISION_TABLE_PARAM_MISSING:ci_level']);
  assert.deepEqual(templates.validate({ template_id: 'DT-DELTA-VS-BASELINE-V1', params: { alpha: 0.05, power_target: 0.8, min_sample_n: 32, min_effect_sd: 0.5, ci_level: 0.95, extra: 1 } }), ['PREREG_DECISION_TABLE_PARAM_UNKNOWN:extra']);
  assert.deepEqual(templates.validate({ template_id: 'DT-DELTA-VS-BASELINE-V1', params: { alpha: 0.05, power_target: 0.8, min_sample_n: 32, min_effect_sd: 0.5, ci_level: 0.93 } }), ['PREREG_DECISION_TABLE_PARAM_RANGE:ci_level']);
  // a tampered library (one range widened) no longer matches its pinned sha
  const widened = JSON.parse(JSON.stringify(lib));
  widened.templates[0].params.alpha.max = 0.5;
  assert.notEqual(templates.librarySha256(widened), lib.library_sha256);
  assert.throws(() => templates.assertPinned(widened), /PREREG_DECISION_TABLE_LIBRARY_PIN_MISMATCH/);
});

test('power tool: deterministic closed form; known values; invalid input refuses', () => {
  assert.equal(power.zInv(0.975), 1.959964);
  assert.equal(power.zInv(0.8), 0.841621);
  assert.equal(power.requiredN({ effect_size_sd: 0.5, alpha: 0.05, power_target: 0.8 }), 32);
  assert.equal(power.requiredN({ effect_size_sd: 0.2, alpha: 0.05, power_target: 0.8 }), 197);
  assert.equal(power.requiredN({ effect_size_sd: 0.5, alpha: 0.05, power_target: 0.9 }), 43);
  assert.equal(power.requiredN({ effect_size_sd: 0.3, alpha: 0.01, power_target: 0.8 }), 130);
  assert.equal(power.requiredN({ effect_size_sd: 0.5, alpha: 0.05, power_target: 0.8 }), power.requiredN({ effect_size_sd: 0.5, alpha: 0.05, power_target: 0.8 }));
  for (const bad of [{ effect_size_sd: 0, alpha: 0.05, power_target: 0.8 }, { effect_size_sd: 0.5, alpha: 0, power_target: 0.8 }, { effect_size_sd: 0.5, alpha: 0.05, power_target: 1 },
    { effect_size_sd: -1, alpha: 0.05, power_target: 0.8 }, { effect_size_sd: NaN, alpha: 0.05, power_target: 0.8 }, { effect_size_sd: 0.5, alpha: '0.05', power_target: 0.8 }]) {
    assert.throws(() => power.requiredN(bad), /PREREG_POWER_INPUT_INVALID/);
  }
});

function sourceTree() {
  const root = tmp('k2prog-src-');
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); return rel; };
  return { root, put };
}

test('AQ-38 bundle builder: whitelist of kinds, deterministic bytes and sha, no timestamps from the host clock; forbidden sources and canary content are refused', () => {
  const { root, put } = sourceTree();
  const files = [
    { kind: 'CANDIDATE_FACTS', path: put('facts/candidate.json', '{"candidate":"RLC-1"}\n') },
    { kind: 'MECHANISM_REGISTER', path: put('reg/mechanisms.json', '{"mechanisms":[]}\n') },
    { kind: 'DATA_CATALOG', path: put('catalog/catalog.json', '{"series":[]}\n') },
  ];
  const a = bundle.build({ market: 'CN_A', root, files, outDir: tmp('k2prog-b-'), builtAt: '2026-11-24T09:00:00+08:00' });
  const b = bundle.build({ market: 'CN_A', root, files: [...files].reverse(), outDir: tmp('k2prog-b-'), builtAt: '2026-11-24T09:00:00+08:00' });
  assert.equal(a.builder, 'K2_BUNDLE_BUILDER_V1');
  assert.equal(a.sha256, b.sha256, 'input order does not matter');
  assert.deepEqual(fs.readdirSync(a.dir).sort(), fs.readdirSync(b.dir).sort());
  assert.ok(fs.readFileSync(path.join(a.dir, 'MANIFEST.json')).equals(fs.readFileSync(path.join(b.dir, 'MANIFEST.json'))));
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.dir, 'MANIFEST.json'))).files.length, 3);
  assert.throws(() => bundle.build({ market: 'CN_A', root, files: [{ kind: 'MINING_OUT', path: put('mining/out/x.json', '{}\n') }], outDir: tmp(), builtAt: '2026-11-24T09:00:00+08:00' }), /BUNDLE_KIND_NOT_ALLOWED/);
  for (const bad of ['sealed_research_results/r.json', 'holdout-vault/v.json', 'mining-sandbox/out/c.json', 'race/results.json', 'paper/ledger.json', 'production/db.json', 'x/restore_20260901/t.json']) {
    assert.throws(() => bundle.build({ market: 'CN_A', root, files: [{ kind: 'CANDIDATE_FACTS', path: put(bad, '{}\n') }], outDir: tmp(), builtAt: '2026-11-24T09:00:00+08:00' }), /BUNDLE_SOURCE_FORBIDDEN/, bad);
  }
  assert.throws(() => bundle.build({ market: 'CN_A', root, files: [{ kind: 'CANDIDATE_FACTS', path: 'facts/missing.json' }], outDir: tmp(), builtAt: '2026-11-24T09:00:00+08:00' }), /BUNDLE_SOURCE_MISSING/);
  assert.throws(() => bundle.build({ market: 'CN_A', root, files: [{ kind: 'CANDIDATE_FACTS', path: '../escape.json' }], outDir: tmp(), builtAt: '2026-11-24T09:00:00+08:00' }), /BUNDLE_SOURCE_FORBIDDEN/);
  // a symlink inside the allowed tree that points into a forbidden one is refused after resolving
  put('sealed_research_results/s.json', '{}\n');
  fs.mkdirSync(path.join(root, 'facts'), { recursive: true });
  fs.symlinkSync(path.join(root, 'sealed_research_results/s.json'), path.join(root, 'facts/link.json'));
  assert.throws(() => bundle.build({ market: 'CN_A', root, files: [{ kind: 'CANDIDATE_FACTS', path: 'facts/link.json' }], outDir: tmp(), builtAt: '2026-11-24T09:00:00+08:00' }), /BUNDLE_SOURCE_FORBIDDEN/);
  // canary token inside an allowed file
  const tok = canary.TOKEN_PREFIX;
  assert.throws(() => bundle.build({ market: 'CN_A', root, files: [{ kind: 'CANDIDATE_FACTS', path: put('facts/tainted.json', `{"x":"${tok}:L1"}\n`) }], outDir: tmp(), builtAt: '2026-11-24T09:00:00+08:00' }), /BUNDLE_CANARY_FOUND/);
  // unknown market
  assert.throws(() => bundle.build({ market: 'MOON', root, files, outDir: tmp(), builtAt: '2026-11-24T09:00:00+08:00' }), /BUNDLE_MARKET_INVALID/);
});

test('AQ-38 sealed canary: the start self-test passes only when planted canaries in sealed-like dirs cannot be read', { skip: process.getuid && process.getuid() === 0 ? 'root can read 0000 files' : false }, () => {
  const base = tmp('k2prog-canary-');
  const dirA = path.join(base, 'sealed_research_results');
  const dirB = path.join(base, 'holdout-vault');
  const fileA = canary.plant(dirA, 'sealed-like-1');
  const fileB = canary.plant(dirB, 'sealed-like-2');
  assert.ok(fs.readFileSync(fileA, 'utf8').startsWith(canary.TOKEN_PREFIX));
  // readable -> the self-test throws and names the label
  assert.throws(() => canary.selfTest([{ label: 'sealed-like-1', file: fileA }, { label: 'sealed-like-2', file: fileB }]), /PREREG_ISOLATION_CANARY_READABLE:sealed-like-1,sealed-like-2/);
  try {
    fs.chmodSync(dirA, 0o000);
    fs.chmodSync(fileB, 0o000);
    const out = canary.selfTest([{ label: 'sealed-like-1', file: fileA }, { label: 'sealed-like-2', file: fileB }]);
    assert.deepEqual(out, { self_test: 'PASS', probes: [{ label: 'sealed-like-1', readable: false }, { label: 'sealed-like-2', readable: false }] });
    // a missing canary is UNKNOWN, not "unreadable": the self-test refuses
    assert.throws(() => canary.selfTest([{ label: 'gone', file: path.join(base, 'nope', 'x') }]), /PREREG_ISOLATION_CANARY_UNKNOWN:gone/);
  } finally { fs.chmodSync(dirA, 0o755); fs.chmodSync(fileB, 0o644); }
});

test('TRL registrar CLI: registers a TRIAL_REGISTRATION_REQUEST_V1 through the ledger front door as PREREGISTERED, returns TRL ids and family N; replay is idempotent; wrong k2 sha, wrong mode or role refuse', () => {
  const d = baseDraft();
  const p = prog.prepare(d, baseCtx());
  const receipt = registrar.register(p.trl_request, { registeredBy: fx.AUTH, registeredAt: fx.REGISTERED_AT });
  assert.equal(receipt.schema, 'TRIAL_REGISTRATION_RECEIPT_V1');
  assert.equal(receipt.request_sha256, p.prepared.request_sha256);
  assert.equal(receipt.rows.length, 2);
  for (const r of receipt.rows) {
    assert.match(r.trial_id, /^TRL-[0-9a-f]{16}$/);
    assert.equal(r.registration_mode, 'PREREGISTERED');
    assert.equal(r.k2_sha256, p.k2_sha256);
    assert.equal(r.registered_at, fx.REGISTERED_AT);
  }
  assert.equal(receipt.family_n.family_id, d.family_id);
  assert.equal(receipt.family_n.n_distinct_configs, 1);
  const again = registrar.register(p.trl_request, { registeredBy: fx.AUTH, registeredAt: '2026-11-24T11:00:00+08:00' });
  assert.deepEqual(again.rows, receipt.rows);
  const bad = JSON.parse(JSON.stringify(p.trl_request));
  bad.specs[0].k2_sha256 = 'f'.repeat(64);
  assert.throws(() => registrar.register(bad, { registeredBy: fx.AUTH }), /REGISTRAR_K2_SHA256_MISMATCH/);
  const role = JSON.parse(JSON.stringify(p.trl_request));
  role.specs[0].role = 'UNCOUNTED_HISTORY';
  assert.throws(() => registrar.register(role, { registeredBy: fx.AUTH }), /REGISTRAR_ROLE_NOT_ALLOWED/);
  assert.throws(() => registrar.register(p.trl_request, { registeredBy: 'SOMEONE_ELSE' }), /TRIAL_LEDGER_REGISTERED_BY_NOT_AUTHORIZED/);
  assert.throws(() => registrar.register({ ...p.trl_request, schema: 'X' }, { registeredBy: fx.AUTH }), /REGISTRAR_REQUEST_INVALID/);
  // the CLI wraps the same function (separate data dir)
  const dir = tmp('k2prog-cli-');
  fs.writeFileSync(path.join(dir, 'req.json'), JSON.stringify(p.trl_request));
  const run = spawnSync(process.execPath, [path.join(ROOT, 'apps/research-cli/k2_trl_registrar.js'), '--request', path.join(dir, 'req.json'), '--registered-by', fx.AUTH, '--registered-at', fx.REGISTERED_AT],
    { env: { ...process.env, QRP_DATA_DIR: path.join(dir, 'data') }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).rows.length, 2);
});

// ── importer acceptance (RF1118 C3, AQ-39) ───────────────────────────────────────────────────────

function frozenSet() {
  const d = baseDraft();
  const ctx = baseCtx();
  const p = prog.prepare(d, ctx);
  const receipts = fx.registerAt(p);
  const res = prog.finalize(d, receipts, { ...ctx, now: fx.NOW_FREEZE, ledgerRows: fx.ledgerRows() }, p.prepared);
  assert.equal(res.state, 'FROZEN', JSON.stringify(res.codes));
  const dir = path.join(ctx.outDir, d.draft_id);
  const text = fs.readFileSync(path.join(dir, `${d.draft_id}_K2_V1.frozen.${p.k2_sha256.slice(0, 8)}.md`));
  const page = fs.readFileSync(path.join(dir, `${d.draft_id}_K2_V1_FREEZE_PROGRAM_1.md`));
  const report = fs.readFileSync(path.join(dir, `${d.draft_id}_K2_V1_VALIDATION_REPORT_1.json`));
  const entry = { id: 'CN-AIP', kind: 'READING', k2: { sha256: sha(text) }, k2_frozen_at: fx.NOW_FREEZE, freeze_program: { page: { sha256: sha(page) }, report: { sha256: sha(report) } } };
  return { d, res, text, page, report, entry, line: `2026-11-24T10:06:00+08:00 ${res.queue_line}` };
}
const gateCheck = (s, { entry = s.entry, text = s.text, page = s.page, report = s.report, log = `${s.line}\n` } = {}, opts = {}) =>
  pfGate.check(entry, { k2Bytes: () => text, pageBytes: () => page, reportBytes: () => report, queueLogText: () => log }, opts);
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === `K2_FREEZE_PROGRAM_${code}`, code);

test('AQ-39 importer gate: a program-frozen K2 passes only with the page, the 14-pass report, matching shas, k2_frozen_at and exactly one K2_PROGRAM_FROZEN queue line', () => {
  const s = frozenSet();
  const ok = gateCheck(s);
  assert.equal(ok.applies, true);
  assert.equal(ok.state, 'PASS');
  assert.equal(ok.frozen_by, 'K2_FREEZE_PROGRAM_V1');
  assert.equal(ok.k2_sha256, s.entry.k2.sha256);
  assert.equal(ok.report_sha256, s.entry.freeze_program.report.sha256);
  assert.equal(ok.page_sha256, s.entry.freeze_program.page.sha256);
  assert.equal(ok.authored_by.kind, 'AI_PREREG_AGENT');
  // no binding at all
  const bare = { ...s.entry };
  delete bare.freeze_program;
  refuses(() => gateCheck(s, { entry: bare }), 'PAGE_MISSING');
  // report bytes changed after the page was written
  const forged = Buffer.from(s.report.toString().replace('"state": "PASS"', '"state": "PASS" '));
  refuses(() => gateCheck(s, { report: forged, entry: { ...s.entry, freeze_program: { ...s.entry.freeze_program, report: { sha256: sha(forged) } } } }), 'REPORT_MISMATCH');
  // a report with a REFUSED result (page recomputed would differ; here the page names the original report sha)
  const refused = JSON.parse(s.report.toString());
  refused.results[2].state = 'REFUSED';
  refused.results[2].codes = ['PREREG_POWER_MISMATCH'];
  const refusedBytes = Buffer.from(JSON.stringify(refused, null, 1));
  const pagePatched = Buffer.from(s.page.toString().split(s.entry.freeze_program.report.sha256).join(sha(refusedBytes)));
  refuses(() => gateCheck(s, { report: refusedBytes, page: pagePatched, entry: { ...s.entry, freeze_program: { page: { sha256: sha(pagePatched) }, report: { sha256: sha(refusedBytes) } } } }), 'REPORT_NOT_ALL_PASS');
  // queue line: none / two / log unavailable (unknown is not missing)
  refuses(() => gateCheck(s, { log: '' }), 'QUEUE_LINE_MISSING');
  refuses(() => gateCheck(s, { log: `${s.line}\n${s.line}\n` }), 'QUEUE_LINE_DUPLICATE');
  refuses(() => gateCheck(s, { log: null }), 'QUEUE_LOG_UNAVAILABLE');
  // the line must carry this page's sha
  refuses(() => gateCheck(s, { log: `${s.line.replace(/ [0-9a-f]{64} CN_A/, ` ${'0'.repeat(64)} CN_A`)}\n` }), 'QUEUE_LINE_MISSING');
  // k2_frozen_at must equal the page's
  refuses(() => gateCheck(s, { entry: { ...s.entry, k2_frozen_at: '2026-11-24T10:05:01+08:00' } }), 'FROZEN_AT_MISMATCH');
  // a K2 that does not match the page
  const other = Buffer.from(`${s.text.toString()}\n`);
  refuses(() => gateCheck(s, { text: other, entry: { ...s.entry, k2: { sha256: sha(other) } } }), 'K2_SHA256_MISMATCH');
});

test('AQ-39 importer gate scope: coordinator-frozen and pre-RF1118 K2s are not program-frozen and keep their lock rows byte-identical; a binding on a K2 that is not program-frozen is refused; a frozen time before RF1118 is refused', () => {
  const s = frozenSet();
  const coord = Buffer.from(s.text.toString().replace('冻结者 K2_FREEZE_PROGRAM_V1', '冻结者 COORDINATOR'));
  const coordEntry = { id: 'x', kind: 'READING', k2: { sha256: sha(coord) }, k2_frozen_at: fx.NOW_FREEZE };
  assert.deepEqual(pfGate.check(coordEntry, { k2Bytes: () => coord }), { applies: false, reason: 'COORDINATOR_FREEZE' });
  const legacy = Buffer.from('# old K2\n\n## 0\n**机制**：x\n');
  assert.deepEqual(pfGate.check({ id: 'y', kind: 'RESULT', k2: { sha256: sha(legacy) } }, { k2Bytes: () => legacy }), { applies: false, reason: 'NOT_PROGRAM_FROZEN' });
  assert.deepEqual(pfGate.check({ id: 'y', kind: 'DRAFT' }, {}), { applies: false, reason: 'NO_K2' });
  refuses(() => pfGate.check({ ...coordEntry, freeze_program: s.entry.freeze_program }, { k2Bytes: () => coord }), 'BINDING_ON_UNGATED');
  refuses(() => gateCheck(s, {}, { effectiveFrom: '2026-11-24T10:05:01+08:00' }), 'BEFORE_RF1118');
});

test('AQ-39 importer wiring: overseas checkEntry/importVerdicts call the program gate; a K2 that says it is program-frozen but has no bound page is refused and nothing is written', () => {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();
  const s = frozenSet();
  const repo = tmp('k2prog-sf-');
  const art = tmp('k2prog-art-');
  git(repo, 'init', '-q');
  const k2Text = s.text.toString();
  const files = {
    'trading-system-v2/docs/evidence/aip/RESULT.json': `${JSON.stringify({ verdict: { decision: '做', evidence_strength: '证据不足', allowed_use: '前向影子', text_zh: '合成' } })}\n`,
    'trading-system-v2/docs/AIP_K2.md': k2Text,
  };
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); }
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seal');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const sf = (rel) => ({ source: 'smartflow', commit, path: `trading-system-v2/${rel}`, sha256: sha(files[`trading-system-v2/${rel}`]), ref: `smartflow@x:${rel}` });
  const entry = { id: 'C17-AIP', label_zh: 'AIP', strategy_ref: 'C17_V2_4000USDT', kind: 'RESULT', sealed_on: '2026-11-10', title_zh: '合成题', k2_frozen_at: '2026-11-09T20:00:00+08:00',
    file: sf('docs/evidence/aip/RESULT.json'), k2: sf('docs/AIP_K2.md'), freeze: null,
    read: { decision: 'verdict.decision', strength: 'verdict.evidence_strength', use: 'verdict.allowed_use', text: 'verdict.text_zh' }, expect: '做' };
  const out = tmp('k2prog-ev-');
  overseas.stageEvidence({ smartflowRoot: repo, artifactsRoot: art, out, entries: [entry] });
  try { fs.rmSync(overseas.LEDGER()); } catch { /* first */ }
  overseas.clearCache();
  assert.throws(() => overseas.importVerdicts(out, { registeredBy: fx.AUTH, entries: [entry] }), /K2_FREEZE_PROGRAM_PAGE_MISSING/);
  assert.equal(fs.existsSync(overseas.LEDGER()), false);
});

test('CLI exit codes: k2_freeze_program prepare: 0 waiting, 65 refused, 66 waiting freeze; same files twice -> same stdout bytes', () => {
  const dir = tmp('k2prog-cli2-');
  const ctxFile = (over = {}) => {
    const c = baseCtx();
    const f = path.join(dir, `ctx-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ now: c.now, host: 'LINUX', outDir: path.join(dir, 'out'), bundle: c.bundle, receipt: c.receipt, admissions: c.admissions, registerCommit: fx.REGISTER_COMMIT,
      registerFile: require('../services/research-mechanism-register').FILE, inventory: [fx.DATASET], marks: [], ledgerRows: [], priorFreezes: [], queueLogText: '', ...over }));
    return f;
  };
  const run = (draft, ctx, cmd = 'prepare') => {
    const df = path.join(dir, 'draft.json');
    fs.writeFileSync(df, JSON.stringify(draft));
    return spawnSync(process.execPath, [path.join(ROOT, 'apps/research-cli/k2_freeze_program.js'), cmd, '--draft', df, '--ctx', ctx], { encoding: 'utf8', env: { ...process.env, QRP_DATA_DIR: path.join(dir, 'data') } });
  };
  const ok = run(baseDraft(), ctxFile());
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).state, 'WAITING_EXTERNAL');
  const bad = baseDraft();
  delete bad.section0;
  const refused = run(bad, ctxFile());
  assert.equal(refused.status, 65);
  assert.equal(JSON.parse(refused.stdout).state, 'REFUSED');
  const waiting = run(baseDraft(), ctxFile({ freezeMode: 'DRAFT_ONLY' }));
  assert.equal(waiting.status, 66);
  const usage = spawnSync(process.execPath, [path.join(ROOT, 'apps/research-cli/k2_freeze_program.js'), 'prepare'], { encoding: 'utf8' });
  assert.equal(usage.status, 64);
});

test('clock preflight parses chronyc, timedatectl and sntp status; unparseable is an error, never zero offset', () => {
  const cp = require('../services/k2-freeze-program/clock_preflight');
  assert.deepEqual(cp.parseOffset('System time     : 0.000123456 seconds fast of NTP time\n'), { offset_ms: 0.123456, source: 'chronyc' });
  assert.equal(cp.parseOffset('System time     : 0.5 seconds slow of NTP time').offset_ms, -500);
  assert.deepEqual(cp.parseOffset('       Offset: -1.5ms\n'), { offset_ms: -1.5, source: 'timedatectl' });
  assert.deepEqual(cp.parseOffset('+0.0123 +/- 0.0100 time.example 10.0.0.1'), { offset_ms: 12.3, source: 'sntp' });
  assert.throws(() => cp.parseOffset('no ntp here'), /CLOCK_PREFLIGHT_UNPARSEABLE/);
  const o = cp.clockOffsets({ registrarText: '+0.5 +/- 0.01 h', programText: 'System time : 0.2 seconds fast of NTP time', measuredAt: '2026-11-24T10:00:00+08:00' });
  assert.deepEqual([o.registrar_offset_ms, o.program_offset_ms, o.tolerance_ms], [500, 200, 1000]);
});

test('AI_PREREG prompt: sha pinned, admission entry has the Q2 shape and is PROPOSED (not edited into the Q2 admissions file); the system text forbids prediction and formulas', () => {
  const prompt = require('../services/k2-freeze-program/prompt');
  assert.equal(prompt.SYSTEM_SHA256, sha(prompt.SYSTEM_TEXT));
  const e = prompt.admissionEntry();
  assert.deepEqual([e.kind, e.state, e.system_sha256], ['AI_PREREG', 'PROPOSED', prompt.SYSTEM_SHA256]);
  const q2 = require('../config/research_queue_prompt_admissions.v1.json');
  assert.ok(!q2.entries.some((x) => x.kind === 'AI_PREREG'));
  assert.ok(!q2.entries.some((x) => x.system_sha256 === e.system_sha256));
  for (const w of ['Do not predict', 'Do not write any formula', 'should be adopted or rejected']) assert.ok(prompt.SYSTEM_TEXT.includes(w), w);
});
