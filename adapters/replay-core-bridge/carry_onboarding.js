'use strict';
/**
 * Carry V2 接入 QRP 的判据核对(smartflow CARRY_V2_QRP_ONBOARDING_K2_DRAFT_V1 §4.2 A0-2 … A0-5,FREEZE_1)。
 * 这里不加载 smartflow 模块:冻结跑数器与 jest 都以最小环境的子进程在钉住的检出上原样运行(只读,不写钉版的 docs/evidence),
 * 本模块只比哈希与对象。M1 / A0-1 见 carry_m1.js,A0-4 回填见 carry_backfill.js。
 *
 *   A0-2  v2-gates、v2-run W1/W2/FULL、jest 两套、v2-result 原样复跑;D1–D4、G-C1(V1 IS / OOS 逐字节)、G-C2,
 *         三个 resultsSha256,六个判定对象与封存 VERDICT 的 stableJson 相等,jest 53 / 53。
 *   A0-3  QRP 写出 / 重跑的 CARRY 作业:harness 与重跑全 BYTE_IDENTICAL,清单与作业哈希 = PR #48 证明的值。
 *   A0-4  回填重组:五个窗口 resultsSha256 = 封存值;回填证据交 v2-result,六个对象 = 封存 VERDICT。
 *   A0-5  两遍:全部输出逐字节相同;不相同的只允许是写明的易变字段(generatedAt、jest 计时、含它们的文件的 sha256)。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { PIN, layout } = require('./core_pin');
const { childEnv } = require('./index');

const SPEC = require('./carry_v2_onboarding_spec.json');
const RUNNER = 'scripts/research/funding-basis-carry-run.js';
const JEST = 'node_modules/jest/bin/jest.js';
const TEST_FILES = Object.freeze(['tests/scripts/funding-basis-carry.test.js', 'tests/scripts/funding-basis-carry-v2.test.js']);
const QRP_ROOT = path.join(__dirname, '..', '..');
/** 回填的进程分组 = 写作业时的分组与窗口顺序(PR #48 / A0-3:IS、OOS 一组;W1、W2、FULL 一组)。 */
const BACKFILL_GROUPS = Object.freeze({ IS_OOS: ['IS', 'OOS'], W1_W2_FULL: ['W1', 'W2', 'FULL'] });

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** 键排序的 JSON(比较用;输入都是 JSON 解析出的值)。 */
function stableText(v) {
  if (Array.isArray(v)) return `[${v.map(stableText).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableText(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** 两个值第一批不同的叶子路径(诊断用)。 */
function diffPaths(a, b, at = '$', out = [], limit = 20) {
  if (out.length >= limit) return out;
  const obj = (x) => x && typeof x === 'object';
  if (obj(a) && obj(b) && Array.isArray(a) === Array.isArray(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) diffPaths(a[k], b[k], `${at}.${k}`, out, limit);
    return out;
  }
  if (stableText(a) !== stableText(b)) out.push(at);
  return out;
}

/** PR #48 证明里的 jobs_sha256:Python json.dumps([[payload_sha256, harness_output_sha256], …])(默认分隔符)的 sha256。 */
function jobsSha256(jobs) {
  const text = `[${jobs.map((j) => `[${JSON.stringify(j.payload_sha256)}, ${JSON.stringify(j.harness_output_sha256)}]`).join(', ')}]`;
  return sha256(Buffer.from(text, 'utf8'));
}

/** 六个判定对象逐个比(stableJson 等价)。 */
function compareVerdict(produced, sealed, objects = SPEC.verdict_objects) {
  const rows = objects.map((k) => ({ object: k, identical: stableText(produced[k]) === stableText(sealed[k]), diffs: stableText(produced[k]) === stableText(sealed[k]) ? [] : diffPaths(produced[k], sealed[k], `$.${k}`) }));
  return { identical: rows.every((r) => r.identical), rows };
}

/** 判定的关键数(K2 §4.2 A0-4 原值)与 VERDICT.verdict 逐字节比。 */
function expectedVerdictFigures(v, want = SPEC.verdict_expected) {
  const c = v.criteria || {};
  const got = {
    result: v.result, failingK: v.failingK, next: v.next,
    K1: c.K1 && { X: c.K1.X, L: c.K1.L, U: c.K1.U }, K2: c.K2 && { W1: c.K2.W1, W2: c.K2.W2 }, K3: c.K3 && { W1: c.K3.W1, W2: c.K3.W2 },
    K4: c.K4 && c.K4.value, K5: c.K5 && c.K5.value,
  };
  return { identical: stableText(got) === stableText(want), got };
}

/** 钉版跑数器 CLI(最小环境,cwd = 钉版包根)。 */
function runnerCli(root, argv, { timeoutMs = 60 * 60 * 1000 } = {}) {
  const { pkgRoot } = layout(path.resolve(root));
  const r = spawnSync(process.execPath, [path.join(pkgRoot, RUNNER), ...argv], { cwd: pkgRoot, env: childEnv(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 });
  return { status: r.status, error: r.error ? String(r.error.code || r.error.message) : null, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim().split('\n').slice(-3).join(' | ') };
}

/** jest 两套(V1 27 + V2 26),JSON 输出;返回 testsGate 同口径的投影。 */
function runJest(root, outFile, cacheDir) {
  const { pkgRoot } = layout(path.resolve(root));
  const r = spawnSync(process.execPath, [path.join(pkgRoot, JEST), ...TEST_FILES, '--json', `--outputFile=${path.resolve(outFile)}`, '--runInBand', `--cacheDirectory=${path.resolve(cacheDir)}`],
    { cwd: pkgRoot, env: { ...childEnv(), NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 1 << 26 });
  if (!fs.existsSync(outFile)) return { status: r.status, projection: null, stderr: String(r.stderr || '').trim().split('\n').slice(-3).join(' | ') };
  return { status: r.status, projection: testsProjection(readJson(outFile)) };
}

/** jest JSON 中与 G1 有关、且两遍应逐字节相同的部分(计时与绝对路径除外)。 */
function testsProjection(t) {
  return {
    numPassedTests: t.numPassedTests, numFailedTests: t.numFailedTests, numTotalTests: t.numTotalTests, success: t.success,
    suites: (t.testResults || []).map((s) => ({ name: path.basename(s.name || s.testFilePath || ''), status: s.status,
      tests: (s.assertionResults || []).map((a) => ({ title: a.fullName || a.title, status: a.status })) })).sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
}

function testsPass(p, want = SPEC.tests_expected) {
  return Boolean(p) && p.numPassedTests === want.passed && p.numFailedTests === want.failed
    && want.suites.every((n) => p.suites.some((s) => s.name === n && s.status === 'passed'));
}

/** 封存证据(钉版检出的 docs/evidence,只读)。 */
function sealedEvidence(root) {
  const { pkgRoot } = layout(path.resolve(root));
  const read = (k) => readJson(path.join(pkgRoot, SPEC.sealed_evidence[k]));
  return { pkgRoot, read };
}

/**
 * A0-2:冻结跑数器原样复跑(不经 QRP)。work 目录写跑数器的输出与核对回执 a0-2.check.json。
 */
function a0Runner({ root, data, dtb3Dir, dtb3Rel, work }) {
  fs.mkdirSync(work, { recursive: true });
  const f = (n) => path.join(work, n);
  const { read } = sealedEvidence(root);
  const steps = [];
  const step = (name, argv) => { const r = runnerCli(root, argv); steps.push({ step: name, status: r.status, error: r.error, stderr: r.status === 0 ? '' : r.stderr }); return r.status === 0; };

  const out = { kind: 'QRP_CARRY_V2_A0_2_RUNNER_CHECK_V1', smartflow_commit: PIN.smartflow.commit, env: { node: process.versions.node, platform: process.platform, arch: process.arch }, steps };
  const gatesOk = step('v2-gates', ['v2-gates', '--data', data, '--dtb3-data', dtb3Dir, '--dtb3', dtb3Rel, '--out', f('V2_DATA.json')]);
  if (gatesOk) {
    const g = readJson(f('V2_DATA.json'));
    const gc1 = g.GC1 || {};
    out.gates = {
      D: g.gates.Dpass, manifests: g.gates.manifests, GC1: g.gates.GC1, GC2: g.gates.GC2, sameAsV1: g.gates.sameAsV1,
      v1Data_manifestSha256: g.v1Data.manifestSha256, dtb3_sha256: g.dtb3.file.sha256,
      GC1_windows: Object.fromEntries(['IS', 'OOS'].map((w) => [w, { regeneratedResultsSha256: gc1.windows && gc1.windows[w] && gc1.windows[w].regeneratedResultsSha256,
        allSixLinesIdentical: gc1.windows && gc1.windows[w] && gc1.windows[w].allSixLinesIdentical,
        sealed_prefix: SPEC.sealed_results.V1[w] }])),
      GC1_v1Verdict: gc1.v1Verdict && { criteriaIdentical: gc1.v1Verdict.criteriaIdentical, v1Result: gc1.v1Verdict.v1Result, regeneratedResult: gc1.v1Verdict.regeneratedResult },
    };
    out.gates.pass = ['W1', 'W2', 'FULL'].every((w) => g.gates.Dpass[w] === true) && g.gates.manifests.DATA === true && g.gates.manifests.DATA_A1 === true
      && g.gates.GC1.pass === true && Object.values(g.gates.GC2).every((x) => x.pass === true)
      && ['IS', 'OOS'].every((w) => out.gates.GC1_windows[w].allSixLinesIdentical === true && String(out.gates.GC1_windows[w].regeneratedResultsSha256).startsWith(SPEC.sealed_results.V1[w]))
      && Boolean(out.gates.GC1_v1Verdict && out.gates.GC1_v1Verdict.criteriaIdentical)
      && g.v1Data.manifestSha256 === SPEC.data.manifest_sha256;
  }
  out.windows = {};
  for (const w of ['W1', 'W2', 'FULL']) {
    const ok = gatesOk && step(`v2-run ${w}`, ['v2-run', '--window', w, '--data', data, '--dtb3-data', dtb3Dir, '--data-evidence', f('V2_DATA.json'), '--out', f(`V2_${w}.json`)]);
    if (!ok) { out.windows[w] = { pass: false }; continue; }
    const e = readJson(f(`V2_${w}.json`));
    const sealed = read(`V2_${w}`).resultsSha256;
    out.windows[w] = { resultsSha256: e.resultsSha256, sealed: sealed, G2: e.gates.G2.pass, G3: e.gates.G3.pass, G4: e.gates.G4.pass,
      pass: e.resultsSha256 === sealed && sealed.startsWith(SPEC.sealed_results.V2[w]) && e.gates.G3.pass === true && e.gates.G2.pass === true && e.gates.G4.pass === true };
  }
  const jest = runJest(root, f('V2_TESTS.json'), path.join(work, '.jest-cache'));
  out.tests = { status: jest.status, projection_sha256: jest.projection ? sha256(stableText(jest.projection)) : null,
    passed: jest.projection && jest.projection.numPassedTests, failed: jest.projection && jest.projection.numFailedTests, pass: testsPass(jest.projection) };
  if (jest.projection) fs.writeFileSync(f('V2_TESTS.projection.json'), `${JSON.stringify(jest.projection, null, 1)}\n`);
  const allRuns = ['W1', 'W2', 'FULL'].every((w) => fs.existsSync(f(`V2_${w}.json`)));
  const resultOk = allRuns && fs.existsSync(f('V2_TESTS.json')) && step('v2-result', ['v2-result', '--data-evidence', f('V2_DATA.json'), '--w1', f('V2_W1.json'), '--w2', f('V2_W2.json'), '--full', f('V2_FULL.json'), '--tests', f('V2_TESTS.json'), '--out', f('V2_VERDICT.json')]);
  if (resultOk) {
    const v = readJson(f('V2_VERDICT.json'));
    out.verdict = { ...compareVerdict(v, read('V2_VERDICT')), figures: expectedVerdictFigures(v.verdict) };
  } else out.verdict = { identical: false };
  out.pass = {
    gates: Boolean(out.gates && out.gates.pass),
    runs: ['W1', 'W2', 'FULL'].every((w) => out.windows[w].pass),
    tests: out.tests.pass,
    verdict: Boolean(out.verdict.identical && out.verdict.figures && out.verdict.figures.identical),
  };
  out.pass.all = Object.values(out.pass).every(Boolean);
  fs.writeFileSync(f('a0-2.check.json'), `${JSON.stringify(out, null, 1)}\n`);
  return out;
}

/**
 * A0-3:QRP 作业的清单与重跑回执 vs PR #48 的 Linux 证明。groups: { IS_OOS: { dir, run }, W1_W2_FULL: { dir, run } }。
 */
function a0Jobs({ groups, out, proofFile = path.join(QRP_ROOT, SPEC.pr48.proof_ref) }) {
  const proof = readJson(proofFile);
  const rows = {};
  for (const [g, spec] of Object.entries(SPEC.pr48.groups)) {
    const given = groups[g];
    const mBytes = fs.readFileSync(path.join(given.dir, 'cache-jobs-CARRY.json'));
    const m = JSON.parse(mBytes.toString('utf8'));
    const run = readJson(given.run);
    const p = proof.sources.find((s) => s.run === spec.run);
    const row = {
      windows: m.harness.map((h) => h.window), jobs: m.jobs.length, expected_jobs: spec.jobs,
      harness_verdict: m.harness_verdict, harness_windows: m.harness.map((h) => ({ window: h.window, verdict: h.verdict, new_sha256: h.new_sha256, sleeves: h.sleeves })),
      rerun_verdict: run.verdict, identical: run.identical, different: run.different,
      manifest_sha256: sha256(mBytes), jobs_sha256: jobsSha256(m.jobs),
      pr48: { manifest_sha256: p.manifest_sha256, jobs_sha256: p.jobs_sha256, windows_new_sha256: p.windows.map((w) => w.new_sha256) },
      data_manifest: m.source_identity, pin: { core: m.core_version_hash, hooks: m.hooks_id, smartflow: m.smartflow_commit },
    };
    row.pass = row.jobs === spec.jobs && row.harness_verdict === 'BYTE_IDENTICAL' && row.rerun_verdict === 'BYTE_IDENTICAL' && row.identical === spec.jobs && row.different === 0
      && run.manifest_sha256 === row.manifest_sha256
      && row.manifest_sha256 === p.manifest_sha256 && row.jobs_sha256 === p.jobs_sha256
      && stableText(row.harness_windows.map((h) => h.new_sha256)) === stableText(row.pr48.windows_new_sha256)
      && m.core_version_hash === PIN.core.version_hash && m.hooks_id === PIN.strategies.CARRY.hooks_id && m.smartflow_commit === PIN.smartflow.commit;
    rows[g] = row;
  }
  const res = { kind: 'QRP_CARRY_V2_A0_3_JOBS_CHECK_V1', proof_ref: SPEC.pr48.proof_ref, proof_sha256: sha256(fs.readFileSync(proofFile)), groups: rows,
    jobs_total: Object.values(rows).reduce((n, r) => n + r.jobs, 0), pass: Object.values(rows).every((r) => r.pass) };
  if (out) fs.writeFileSync(out, `${JSON.stringify(res, null, 1)}\n`);
  return res;
}

/**
 * A0-4 的判据:回填(B 遍)回执的五个 resultsSha256 = 封存值,G3(A、B 两个新进程)通过,70 个作业全用上;
 * 回填证据经 v2-result,六个对象 = 封存 VERDICT。dir = carry_backfill.js 的输出目录(两组 × A/B 四份回执);
 * dataEvidence / tests = 同一遍 A0-2 的 v2-gates 输出与 jest JSON。
 */
function a0BackfillVerdict({ root, dir, dataEvidence, tests, groups = BACKFILL_GROUPS }) {
  const { read } = sealedEvidence(root);
  const receipts = Object.fromEntries(Object.keys(groups).map((g) => [g, readJson(path.join(dir, `a0-4-backfill.${g}.B.json`))]));
  const sealedFull = {
    IS: read('V1_IS').resultsSha256, OOS: read('V1_OOS').resultsSha256,
    W1: read('V2_W1').resultsSha256, W2: read('V2_W2').resultsSha256, FULL: read('V2_FULL').resultsSha256,
  };
  const windows = {};
  for (const [g, wins] of Object.entries(groups)) {
    for (const w of wins) {
      const r = receipts[g].windows.find((x) => x.window === w);
      const prefix = SPEC.sealed_results[['IS', 'OOS'].includes(w) ? 'V1' : 'V2'][w];
      windows[w] = { group: g, resultsSha256: r ? r.resultsSha256 : null, sealed: sealedFull[w], G3: Boolean(r && r.G3 && r.G3.pass), sleeves: r ? r.sleeves : 0,
        pass: Boolean(r) && r.resultsSha256 === sealedFull[w] && sealedFull[w].startsWith(prefix) && r.G3.pass && r.jobs_same_both_passes };
    }
  }
  const used = Object.values(receipts).reduce((n, r) => n + r.jobs_used, 0);
  const unused = Object.values(receipts).reduce((n, r) => n + r.jobs_unused, 0);
  const out = { kind: 'QRP_CARRY_V2_A0_4_BACKFILL_CHECK_V1',
    receipts: Object.fromEntries(Object.keys(groups).flatMap((g) => ['A', 'B'].map((p) => [`${g}.${p}`, sha256(fs.readFileSync(path.join(dir, `a0-4-backfill.${g}.${p}.json`)))]))),
    jobs_used: used, jobs_unused: unused, windows };
  const f = (n) => path.join(dir, n);
  const r = runnerCli(root, ['v2-result', '--data-evidence', dataEvidence, '--w1', f('CARRY_V2_W1.backfill.json'), '--w2', f('CARRY_V2_W2.backfill.json'), '--full', f('CARRY_V2_FULL.backfill.json'), '--tests', tests, '--out', f('V2_VERDICT.backfill.json')]);
  out.v2_result = { status: r.status, stderr: r.status === 0 ? '' : r.stderr };
  if (r.status === 0) {
    const v = readJson(f('V2_VERDICT.backfill.json'));
    out.verdict = { ...compareVerdict(v, read('V2_VERDICT')), figures: expectedVerdictFigures(v.verdict) };
  } else out.verdict = { identical: false };
  out.pass = {
    windows: Object.values(windows).every((w) => w.pass),
    jobs_all_used: unused === 0 && used === Object.values(SPEC.pr48.groups).reduce((n, g) => n + g.jobs, 0),
    verdict: Boolean(out.verdict.identical && out.verdict.figures && out.verdict.figures.identical),
  };
  out.pass.all = Object.values(out.pass).every(Boolean);
  fs.writeFileSync(f('a0-4.check.json'), `${JSON.stringify(out, null, 1)}\n`);
  return out;
}

// ---- A0-5:两遍逐字节 -------------------------------------------------------------------------------------------------

/** 易变字段(写明):只有这些可以在两遍之间不同;其余一律逐字节。 */
const VOLATILE = Object.freeze([
  { file: /(^|\/)V2_(DATA|W1|W2|FULL)\.json$/, paths: ['generatedAt'], why: 'runner writes the wall-clock time' },
  { file: /(^|\/)CARRY_V2_(W1|W2|FULL)\.backfill\.json$/, paths: ['generatedAt'], why: 'v2Run shape carries the wall-clock time' },
  { file: /(^|\/)V2_VERDICT(\.backfill)?\.json$/, paths: ['inputs.dataEvidence.sha256', 'inputs.windows.W1.sha256', 'inputs.windows.W2.sha256', 'inputs.windows.FULL.sha256', 'inputs.tests.sha256'],
    why: 'sha256 of input files that contain generatedAt / jest timings (K2 A0-6)' },
  { file: /(^|\/)V2_TESTS\.json$/, projection: true, why: 'jest JSON carries timings and absolute paths; compared through the G1 projection (V2_TESTS.projection.json)' },
]);

function listFiles(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== '.jest-cache') listFiles(dir, p, out); } else out.push(p);
  }
  return out;
}

function dropPath(obj, dotted) {
  const keys = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) { if (!cur || typeof cur !== 'object') return; cur = cur[keys[i]]; }
  if (cur && typeof cur === 'object') delete cur[keys[keys.length - 1]];
}

/** 两遍目录逐文件比:BYTE_IDENTICAL / IDENTICAL_EXCEPT_VOLATILE / DIFFERENT / MISSING。 */
function sealCompare(dir1, dir2) {
  const a = listFiles(dir1);
  const b = listFiles(dir2);
  const names = [...new Set([...a, ...b])].sort();
  const rows = names.map((n) => {
    const p1 = path.join(dir1, n);
    const p2 = path.join(dir2, n);
    if (!fs.existsSync(p1) || !fs.existsSync(p2)) return { file: n, verdict: 'MISSING', in: fs.existsSync(p1) ? 'pass1' : 'pass2' };
    const b1 = fs.readFileSync(p1);
    const b2 = fs.readFileSync(p2);
    const s1 = sha256(b1);
    if (s1 === sha256(b2)) return { file: n, verdict: 'BYTE_IDENTICAL', sha256: s1 };
    const rule = VOLATILE.find((v) => v.file.test(n));
    if (!rule) return { file: n, verdict: 'DIFFERENT', sha256: [s1, sha256(b2)] };
    if (rule.projection) return { file: n, verdict: 'PROJECTION_COMPARED', why: rule.why };
    const j1 = JSON.parse(b1.toString('utf8'));
    const j2 = JSON.parse(b2.toString('utf8'));
    for (const p of rule.paths) { dropPath(j1, p); dropPath(j2, p); }
    const same = stableText(j1) === stableText(j2);
    return { file: n, verdict: same ? 'IDENTICAL_EXCEPT_VOLATILE' : 'DIFFERENT', volatile: rule.paths, why: rule.why, ...(same ? {} : { diffs: diffPaths(j1, j2) }) };
  });
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  return {
    kind: 'QRP_CARRY_V2_A0_5_TWICE_V1', files: rows.length,
    byte_identical: count('BYTE_IDENTICAL'), identical_except_volatile: count('IDENTICAL_EXCEPT_VOLATILE'), projection_compared: count('PROJECTION_COMPARED'),
    different: count('DIFFERENT'), missing: count('MISSING'),
    volatile_rules: VOLATILE.map((v) => ({ file: String(v.file), paths: v.paths || null, projection: Boolean(v.projection), why: v.why })),
    rows,
    pass: count('DIFFERENT') === 0 && count('MISSING') === 0 && rows.length > 0,
  };
}

module.exports = {
  SPEC, TEST_FILES, VOLATILE, BACKFILL_GROUPS, stableText, diffPaths, jobsSha256, compareVerdict, expectedVerdictFigures, runnerCli, runJest, testsProjection, testsPass,
  a0Runner, a0Jobs, a0BackfillVerdict, sealCompare, listFiles,
};
