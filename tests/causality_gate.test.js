'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const gate = require('../services/causality-gate');
const overseas = require('../services/overseas-sealed-verdicts');
const ashare = require('../services/ashare-sealed-verdicts');
const { read } = require('../packages/ledger');

/**
 * G-CAUSAL（研究框架修订 2026-11-12 草稿 rev 1 §3.4）：导入器的因果门。先红后绿，只用合成登记与合成证据。
 * 门只会拒绝导入，从不改写结论；生效时刻取冻结页 FREEZE_1（2026-11-15T22:47:42+08:00），单元测试另行注入生效时刻。
 */
const AUTH = 'TEST_CAUSALITY_AUTHORITY';
const EFF = '2026-11-16T00:00:00+08:00';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const CODE = 'c'.repeat(40);
const FN = 'smartflow:src/features/f.js#f';
const FN2 = 'smartflow:src/features/g.js#g';
const RULING_SHA = 'e'.repeat(64);

function fnRecord(id, patch = {}) {
  const [p, entry] = id.slice(id.indexOf(':') + 1).split('#');
  return { function_id: id, path: p, entry, runner: 'node', file_sha256: 'f'.repeat(64),
    inputs: [{ name: 'bars', file: 'bars.json', file_sha256: 'b'.repeat(64), rows: 60, availability: { rule: 'DATE_AT', field: 'date', time: '15:00', tz: '+08:00' } }],
    cut_points: ['2025-01-10T07:00:00.000Z'], t_c1: 'PASS', t_c2: 'PASS', t_c3: 'PASS', fail_reasons: {}, mismatches: [], ...patch };
}
function evidence({ k2Sha, functions = [fnRecord(FN)], patch = {} }) {
  const doc = { schema: 'CAUSALITY_EVIDENCE_V1', contract_ref: gate.CONTRACT_REF, study_ref: 'R99_K2_V1', k2_sha256: k2Sha, code_repo: 'smartflow', code_sha: CODE, harness_version: '1.0.0',
    harness_sha256: 'a'.repeat(64), seed: gate.SEED, cut_points_per_function: gate.CUT_POINTS, manifest_sha256: 'd'.repeat(64), functions, unknown: {},
    production_effect: 'NONE', registered_by: 'TEST', registered_at: '2026-11-15T14:00:00Z', ...patch };
  doc.record_hash = gate.recordHash(doc);
  return doc;
}
const k2Of = (lines) => `# R99 K2\n\n## 0\n${lines.join('\n')}\n`;
const K2_DEFAULT = k2Of([`- 新增函数：\`CF:${FN}\``]);
const runLog = (extra = { smartflow_run_commit: CODE }) => Buffer.from(JSON.stringify({ schema: 'RESEARCH_RUN_LOG_V1', k2_sha256: 'x', runs: [], ...extra }));

/** 直接调门：entry 与按 sha256 复验后的字节。 */
function direct({ k2Text = K2_DEFAULT, doc, docFn, entryPatch = {}, log = runLog(), ruling = null, effectiveFrom = EFF } = {}) {
  const k2 = Buffer.from(k2Text);
  const ev = doc !== undefined ? doc : evidence({ k2Sha: sha(k2), ...(docFn ? { functions: docFn } : {}) });
  const evBytes = ev === null ? null : Buffer.from(JSON.stringify(ev));
  const entry = { id: 'C17-R99', kind: 'RESULT', sealed_on: '2026-11-20', k2: { sha256: sha(k2) }, k2_frozen_at: '2026-11-17T10:00:00+08:00',
    ...(evBytes ? { causality_evidence: { sha256: sha(evBytes) } } : {}), ...entryPatch };
  return gate.check(entry, { k2Bytes: () => k2, evidenceBytes: () => evBytes, runLogBytes: () => log, rulingBytes: () => (ruling ? Buffer.from(ruling) : null) }, { effectiveFrom });
}

test('冻结页绑定：EFFECTIVE_FROM 取 FREEZE_1 的时刻（与 G-MECH 同一个常量）；现行海外与 A 股登记表都在此前冻结或封存，没有一题过门、也没有一题绑证据，锁行不加字段', () => {
  assert.equal(gate.EFFECTIVE_FROM, '2026-11-15T22:47:42+08:00');
  assert.deepEqual([gate.FREEZE.ref, gate.FREEZE.sha256_prefix, gate.FREEZE.draft_sha256_prefix, gate.FREEZE.review_sha256_prefix],
    ['artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_FREEZE_1.md', 'c9742ea0', 'd7f85a87', 'd943d342']);
  assert.equal(gate.CONTRACT_REF, 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_FREEZE_1.md@c9742ea0');
  // E13 / G14 是同一个常量：机制门（PR #84）在场时两者必须相等
  let mech = null;
  try { mech = require('../services/research-mechanism-register/gate'); } catch { /* #84 未合并 */ }
  if (mech && mech.EFFECTIVE_FROM !== null) assert.equal(mech.EFFECTIVE_FROM, gate.EFFECTIVE_FROM);
  const reasons = new Set();
  for (const entry of [...overseas.ENTRIES, ...ashare.ENTRIES]) {
    const scope = gate.applies(entry);
    assert.equal(scope.applies, false, entry.id);
    reasons.add(scope.reason);
    assert.equal(entry.causality_evidence, undefined, entry.id);
    assert.equal(entry.causality_ruling, undefined, entry.id);
  }
  assert.deepEqual([...reasons].sort(), ['FROZEN_BEFORE_AMENDMENT', 'NO_K2', 'SEALED_BEFORE_AMENDMENT']);
  assert.equal(gate.applies({ id: 'x', kind: 'RESULT', k2: { sha256: 'a'.repeat(64) }, k2_frozen_at: '2026-11-15T22:47:42+08:00' }).applies, true);
  assert.equal(gate.applies({ id: 'x', kind: 'RESULT', k2: { sha256: 'a'.repeat(64) }, k2_frozen_at: '2026-11-15T22:47:41+08:00' }).applies, false);
  assert.throws(() => gate.applies({ id: 'x', kind: 'RESULT', k2: { sha256: 'a'.repeat(64) }, sealed_on: '2026-11-15' }), /CAUSALITY_K2_FROZEN_AT_MISSING/);
  // 注入生效时刻后，只有封存导入（RESULT / READING）且 K2 冻结不早于生效时刻的题过门
  const e = { id: 'x', kind: 'RESULT', k2: { sha256: 'a'.repeat(64) } };
  assert.deepEqual(gate.applies({ ...e, k2_frozen_at: '2026-11-17T00:00:00+08:00' }, EFF), { applies: true, reason: 'FROZEN_AFTER_AMENDMENT' });
  assert.equal(gate.applies({ ...e, k2_frozen_at: '2026-11-15T23:59:59+08:00' }, EFF).applies, false);
  assert.equal(gate.applies({ ...e, kind: 'STATUS', k2_frozen_at: '2026-11-17T00:00:00+08:00' }, EFF).reason, 'NOT_A_SEAL');
  assert.equal(gate.applies({ ...e, kind: 'DRAFT' }, EFF).reason, 'DRAFT_NOT_FROZEN');
  assert.throws(() => gate.applies({ ...e, sealed_on: '2026-11-16' }, EFF), /CAUSALITY_K2_FROZEN_AT_MISSING/);
  assert.equal(gate.applies({ ...e, sealed_on: '2026-11-15' }, EFF).reason, 'SEALED_BEFORE_AMENDMENT');
  assert.throws(() => gate.applies({ ...e, k2_frozen_at: '2026-11-17 10:00' }, EFF), /CAUSALITY_K2_FROZEN_AT_INVALID/);
});

test('过门：K2 写出的函数都在证据里、三项全 PASS、code_sha 等于运行日志的 <repo>_run_commit → PASS，锁里记证据 sha256 与逐函数状态', () => {
  const r = direct({});
  assert.equal(r.applies, true);
  assert.equal(r.state, 'PASS');
  assert.equal(r.code_sha, CODE);
  assert.deepEqual(r.functions, [{ function_id: FN, t_c1: 'PASS', t_c2: 'PASS', t_c3: 'PASS' }]);
  assert.equal(gate.runCommitKey('ashare-v6'), 'ashare_v6_run_commit');
});

test('范围声明：两样都没有、两样都有、不适用的码不在 §3.2 五类、写了不适用又绑了证据，一律拒绝；只写不适用且不绑证据 → NOT_APPLICABLE', () => {
  assert.throws(() => direct({ k2Text: k2Of(['- 没有声明']) }), /CAUSALITY_SCOPE_MISSING/);
  assert.throws(() => direct({ k2Text: k2Of([`\`CF:${FN}\``, 'G-CAUSAL N/A: ABLATION']) }), /CAUSALITY_SCOPE_CONFLICT/);
  assert.throws(() => direct({ k2Text: k2Of(['G-CAUSAL N/A: ABLATION', 'G-CAUSAL N/A: COST_EXECUTION']), doc: null }), /CAUSALITY_SCOPE_CONFLICT/);
  assert.throws(() => direct({ k2Text: k2Of(['G-CAUSAL N/A: LOOKS_FINE']), doc: null }), /CAUSALITY_SCOPE_CODE_INVALID/);
  assert.throws(() => direct({ k2Text: k2Of(['G-CAUSAL N/A: ABLATION']) }), /CAUSALITY_SCOPE_CONFLICT/);
  const na = direct({ k2Text: k2Of(['G-CAUSAL N/A: ABLATION']), doc: null });
  assert.deepEqual([na.state, na.not_applicable_code], ['NOT_APPLICABLE', 'ABLATION']);
  for (const code of gate.NOT_APPLICABLE_CODES) assert.equal(direct({ k2Text: k2Of([`G-CAUSAL N/A: ${code}`]), doc: null }).state, 'NOT_APPLICABLE');
  assert.throws(() => direct({ k2Text: k2Of(['`CF:not-an-id`']) }), /CAUSALITY_K2_FUNCTION_ID_INVALID/);
});

test('证据失败即关：没绑、与 K2 不符、改过字节、unknown 非空、种子或截点数不是冻结值、工具版本不认、函数集合不等', () => {
  assert.throws(() => direct({ doc: null }), /CAUSALITY_EVIDENCE_MISSING/);
  assert.throws(() => direct({ doc: evidence({ k2Sha: 'f'.repeat(64) }) }), /CAUSALITY_EVIDENCE_K2_MISMATCH/);
  const k2 = Buffer.from(K2_DEFAULT);
  const forged = evidence({ k2Sha: sha(k2) });
  forged.functions[0].t_c2 = 'FAIL';
  assert.throws(() => direct({ doc: forged }), /CAUSALITY_EVIDENCE_RECORD_HASH_MISMATCH/);
  assert.throws(() => direct({ doc: evidence({ k2Sha: sha(k2), patch: { code_sha: null, unknown: { code_sha: 'WORKTREE_DIRTY' } } }) }), /CAUSALITY_EVIDENCE_UNKNOWN/);
  assert.throws(() => direct({ doc: evidence({ k2Sha: sha(k2), patch: { code_sha: null } }) }), /CAUSALITY_EVIDENCE_CODE_SHA_INVALID/);
  assert.throws(() => direct({ doc: evidence({ k2Sha: sha(k2), patch: { seed: 1 } }) }), /CAUSALITY_EVIDENCE_PARAMS_NOT_FROZEN/);
  assert.throws(() => direct({ doc: evidence({ k2Sha: sha(k2), patch: { cut_points_per_function: 5 } }) }), /CAUSALITY_EVIDENCE_PARAMS_NOT_FROZEN/);
  assert.throws(() => direct({ doc: evidence({ k2Sha: sha(k2), patch: { harness_version: '0.9.0' } }) }), /CAUSALITY_HARNESS_VERSION_UNKNOWN/);
  assert.throws(() => direct({ doc: evidence({ k2Sha: sha(k2), patch: { production_effect: 'LIVE' } }) }), /CAUSALITY_EVIDENCE_PRODUCTION_EFFECT_INVALID/);
  assert.throws(() => direct({ doc: evidence({ k2Sha: sha(k2), patch: { contract_ref: 'draft@d7f85a87' } }) }), /CAUSALITY_EVIDENCE_CONTRACT_MISMATCH/);
  assert.throws(() => direct({ docFn: [fnRecord(FN2)] }), /CAUSALITY_FUNCTION_NOT_IN_EVIDENCE/);
  assert.throws(() => direct({ docFn: [fnRecord(FN), fnRecord(FN2)] }), /CAUSALITY_FUNCTION_NOT_IN_K2/);
  assert.throws(() => direct({ docFn: [fnRecord(FN), fnRecord(FN)] }), /CAUSALITY_EVIDENCE_FUNCTION_DUPLICATE/);
  assert.throws(() => direct({ docFn: [fnRecord('qrp:src/f.js#f')], k2Text: k2Of(['`CF:qrp:src/f.js#f`']) }), /CAUSALITY_EVIDENCE_FUNCTION_REPO_MISMATCH/);
  assert.throws(() => direct({ docFn: [fnRecord(FN, { t_c1: 'FAIL', fail_reasons: {} })] }), /CAUSALITY_EVIDENCE_FAIL_REASON_INVALID/);
  assert.throws(() => direct({ docFn: [fnRecord(FN, { t_c1: 'SKIPPED' })] }), /CAUSALITY_EVIDENCE_STATUS_INVALID/);
  assert.throws(() => direct({ doc: { schema: 'CAUSALITY_EVIDENCE_V1' } }), /CAUSALITY_EVIDENCE_SCHEMA_INVALID/);
});

test('运行代码：运行日志缺失、没有 <repo>_run_commit、与证据的 code_sha 不同，都拒绝', () => {
  assert.throws(() => direct({ log: null }), /CAUSALITY_RUN_LOG_MISSING/);
  assert.throws(() => direct({ log: runLog({ ashare_v6_run_commit: CODE }) }), /CAUSALITY_RUN_LOG_CODE_SHA_MISSING:C17-R99:smartflow_run_commit/);
  assert.throws(() => direct({ log: runLog({ smartflow_run_commit: 'd'.repeat(40) }) }), /CAUSALITY_CODE_SHA_MISMATCH/);
  assert.throws(() => direct({ log: Buffer.from('{"schema":"OTHER"}') }), /CAUSALITY_RUN_LOG_INVALID/);
});

test('FAIL 拒绝导入；偏差只能出自按 sha256 绑定的裁定页：裁定写明的「函数 × 测试」记 DEVIATION_ACCEPTED（不记 PASS），裁定写了却不成立的拒绝', () => {
  const failing = [fnRecord(FN, { t_c2: 'FAIL', fail_reasons: { t_c2: 'MISMATCH:3' } })];
  assert.throws(() => direct({ docFn: failing }), /CAUSALITY_FUNCTION_NOT_PASS:C17-R99:smartflow:src\/features\/f\.js#f:T-C2:MISMATCH:3/);
  const spec = { sha256: RULING_SHA, ref: 'artifacts/coordinator/R99_GCAUSAL_RULING.md' };
  const text = `# 裁定\n${FN} 的 T-C2 记 DEVIATION_ACCEPTED，理由……\n`;
  const ok = direct({ docFn: failing, ruling: text, entryPatch: { causality_ruling: { spec, deviations: [{ function_id: FN, test: 't_c2' }] } } });
  assert.equal(ok.state, 'DEVIATION_ACCEPTED');
  assert.deepEqual(ok.deviations, [{ function_id: FN, test: 't_c2', fail_reason: 'MISMATCH:3' }]);
  assert.equal(ok.ruling_sha256, RULING_SHA);
  // 裁定原文没写测试名 / 没写 DEVIATION_ACCEPTED → 拒绝
  assert.throws(() => direct({ docFn: failing, ruling: `${FN} DEVIATION_ACCEPTED`, entryPatch: { causality_ruling: { spec, deviations: [{ function_id: FN, test: 't_c2' }] } } }), /CAUSALITY_RULING_TEXT_DOES_NOT_STATE:C17-R99:T-C2/);
  assert.throws(() => direct({ docFn: failing, ruling: `${FN} T-C2`, entryPatch: { causality_ruling: { spec, deviations: [{ function_id: FN, test: 't_c2' }] } } }), /CAUSALITY_RULING_TEXT_DOES_NOT_STATE:C17-R99:DEVIATION_ACCEPTED/);
  // 裁定放行的是 T-C1，证据里 T-C1 是 PASS → 事实不成立
  assert.throws(() => direct({ docFn: failing, ruling: `${text} T-C1`, entryPatch: { causality_ruling: { spec, deviations: [{ function_id: FN, test: 't_c2' }, { function_id: FN, test: 't_c1' }] } } }), /CAUSALITY_RULING_FACT_NOT_HOLD:C17-R99:smartflow:src\/features\/f\.js#f:T-C1/);
  // 裁定页缺失
  assert.throws(() => direct({ docFn: failing, entryPatch: { causality_ruling: { spec, deviations: [{ function_id: FN, test: 't_c2' }] } } }), /CAUSALITY_RULING_FILE_MISSING/);
});

test('RULED_LAG（§3.3「裁定写明滞后规则」）：没有裁定或裁定没列这个「函数 × 输入」就拒绝；列了、sha256 对得上才过', () => {
  const lagged = [fnRecord(FN, { inputs: [{ name: 'reports', file: 'r.json', file_sha256: 'b'.repeat(64), rows: 8, availability: { rule: 'RULED_LAG', field: 'end_date', time: '00:00', tz: '+08:00', lag_seconds: 86400 * 45, ruling_sha256: RULING_SHA } }] })];
  assert.throws(() => direct({ docFn: lagged }), /CAUSALITY_LAG_RULE_NOT_RULED/);
  const spec = { sha256: RULING_SHA, ref: 'r' };
  const r = direct({ docFn: lagged, ruling: `RULED_LAG ${FN} reports 45 天`, entryPatch: { causality_ruling: { spec, lag_rules: [{ function_id: FN, input: 'reports' }] } } });
  assert.equal(r.state, 'PASS');
  assert.throws(() => direct({ docFn: lagged, ruling: `RULED_LAG ${FN} reports`, entryPatch: { causality_ruling: { spec: { sha256: 'd'.repeat(64) }, lag_rules: [{ function_id: FN, input: 'reports' }] } } }), /CAUSALITY_LAG_RULE_NOT_RULED/);
  assert.throws(() => direct({ ruling: `RULED_LAG ${FN} reports`, entryPatch: { causality_ruling: { spec, lag_rules: [{ function_id: FN, input: 'reports' }] } } }), /CAUSALITY_RULING_FACT_NOT_HOLD/);
});

test('不过门的题（修订前冻结）绑了证据：只核完整性，FAIL 原样记下、不拒绝（§3.6 补跑、§3.7 上线前核对只报）；改过的证据照样拒绝；不过门的题带裁定拒绝', () => {
  const failing = [fnRecord(FN, { t_c1: 'FAIL', fail_reasons: { t_c1: 'MISMATCH:9' } })];
  const r = direct({ docFn: failing, effectiveFrom: null });
  assert.deepEqual([r.applies, r.report_only, r.reason], [false, true, 'AMENDMENT_NOT_FROZEN']);
  assert.deepEqual(r.functions, [{ function_id: FN, t_c1: 'FAIL', t_c2: 'PASS', t_c3: 'PASS' }]);
  assert.equal(r.code_sha_matches_run_log, true);
  assert.equal(direct({ docFn: failing, effectiveFrom: null, log: null }).code_sha_matches_run_log, null);
  const before = direct({ docFn: failing, entryPatch: { k2_frozen_at: '2026-11-12T07:58:23+08:00' } });
  assert.deepEqual([before.applies, before.report_only, before.reason], [false, true, 'FROZEN_BEFORE_AMENDMENT']);
  const k2 = Buffer.from(K2_DEFAULT);
  const forged = evidence({ k2Sha: sha(k2), functions: failing });
  forged.functions[0].t_c1 = 'PASS';
  delete forged.functions[0].fail_reasons.t_c1;
  assert.throws(() => direct({ doc: forged, effectiveFrom: null }), /CAUSALITY_EVIDENCE_RECORD_HASH_MISMATCH/);
  assert.throws(() => direct({ effectiveFrom: null, entryPatch: { causality_ruling: { spec: { sha256: RULING_SHA }, deviations: [] } } }), /CAUSALITY_RULING_ON_UNGATED_ENTRY/);
  assert.deepEqual(direct({ doc: null, effectiveFrom: null }), { applies: false, reason: 'AMENDMENT_NOT_FROZEN' });
});

// ── 导入器（海外封存结论，A 股共用同一套 checkEntry） ──────────────────────────

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();

/** 合成 smartflow 仓库：第 1 次提交是运行代码，第 2 次提交放封存结果、K2、运行日志与因果证据（code_sha = 第 1 次提交）。 */
function importerFixture({ withEvidence = true, cf = true, evidencePatch = {} } = {}) {
  const repo = tmp('qrp-cg-sf-'); const art = tmp('qrp-cg-art-');
  git(repo, 'init', '-q');
  fs.mkdirSync(path.join(repo, 'trading-system-v2/src/features'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'trading-system-v2/src/features/f.js'), 'module.exports.f = (b) => b;\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'code');
  const code = git(repo, 'rev-parse', 'HEAD');
  const k2Text = k2Of([cf ? `- 新增函数：\`CF:${FN}\`` : '- 无声明']);
  const ev = evidence({ k2Sha: sha(k2Text), patch: { code_sha: code, ...evidencePatch } });
  const files = {
    'trading-system-v2/docs/evidence/r99/RESULT.json': `${JSON.stringify({ verdict: { decision: '做', evidence_strength: '证据不足', allowed_use: '前向影子', text_zh: '合成' } })}\n`,
    'trading-system-v2/docs/R99_K2.md': k2Text,
    'trading-system-v2/docs/evidence/r99/RUN_LOG.json': `${JSON.stringify({ schema: 'RESEARCH_RUN_LOG_V1', k2_sha256: sha(k2Text), smartflow_run_commit: code, runs: [] })}\n`,
    'trading-system-v2/docs/evidence/r99/CAUSALITY_EVIDENCE_V1.json': `${JSON.stringify(ev, null, 1)}\n`,
  };
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); }
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seal');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const sf = (rel) => ({ source: 'smartflow', commit, path: `trading-system-v2/${rel}`, sha256: sha(files[`trading-system-v2/${rel}`]), ref: `smartflow@x:${rel}` });
  const entry = {
    id: 'C17-R99-CAUSAL', label_zh: 'R99', strategy_ref: 'C17_V2_4000USDT', kind: 'RESULT', sealed_on: '2026-11-10', title_zh: '合成题（因果门）', k2_frozen_at: '2026-11-09T20:00:00+08:00',
    file: sf('docs/evidence/r99/RESULT.json'), k2: sf('docs/R99_K2.md'), freeze: null, run_log: sf('docs/evidence/r99/RUN_LOG.json'),
    ...(withEvidence ? { causality_evidence: sf('docs/evidence/r99/CAUSALITY_EVIDENCE_V1.json') } : {}),
    read: { decision: 'verdict.decision', strength: 'verdict.evidence_strength', use: 'verdict.allowed_use', text: 'verdict.text_zh' }, expect: '做',
  };
  const out = tmp('qrp-cg-ev-');
  overseas.stageEvidence({ smartflowRoot: repo, artifactsRoot: art, out, entries: [entry] });
  return { entry, out, code };
}

test.beforeEach(() => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  try { fs.rmSync(overseas.LEDGER()); } catch { /* 首次 */ }
  overseas.clearCache();
});

test('导入器：修订前冻结、没绑证据的题照原样导入，锁行不带 causality_gate；绑了证据的题证据进 refs，锁里记只报结果', () => {
  const plain = importerFixture({ withEvidence: false });
  const [row] = overseas.importVerdicts(plain.out, { registeredBy: AUTH, entries: [plain.entry] });
  assert.equal(row.causality_gate, undefined);
  assert.ok(!row.refs.some((r) => r.role === 'CAUSALITY_EVIDENCE'));
  fs.rmSync(overseas.LEDGER());
  const bound = importerFixture();
  const [lock] = overseas.importVerdicts(bound.out, { registeredBy: AUTH, entries: [bound.entry] });
  assert.equal(lock.decision, '做'); // 门不改结论
  assert.ok(lock.refs.some((r) => r.role === 'CAUSALITY_EVIDENCE' && r.sha256 === bound.entry.causality_evidence.sha256));
  assert.deepEqual([lock.causality_gate.applies, lock.causality_gate.report_only, lock.causality_gate.reason, lock.causality_gate.code_sha_matches_run_log], [false, true, 'FROZEN_BEFORE_AMENDMENT', true]);
  assert.equal(lock.causality_gate.contract_ref, gate.CONTRACT_REF);
  assert.equal(read(overseas.LEDGER()).length, 1);
});

test('导入器：注入生效时刻后过门——证据齐全 → 锁里记 PASS；K2 没声明范围、或没绑证据 → 整批拒绝，台账不写', () => {
  const opts = (fx) => ({ registeredBy: AUTH, entries: [fx.entry], causalityGate: { effectiveFrom: '2026-11-01T00:00:00+08:00' } });
  const ok = importerFixture();
  const [lock] = overseas.importVerdicts(ok.out, opts(ok));
  assert.equal(lock.causality_gate.state, 'PASS');
  assert.equal(lock.causality_gate.code_sha, ok.code);
  fs.rmSync(overseas.LEDGER());
  const noScope = importerFixture({ cf: false });
  assert.throws(() => overseas.importVerdicts(noScope.out, opts(noScope)), /CAUSALITY_SCOPE_MISSING/);
  const noEvidence = importerFixture({ withEvidence: false });
  assert.throws(() => overseas.importVerdicts(noEvidence.out, opts(noEvidence)), /CAUSALITY_EVIDENCE_MISSING/);
  const wrongCode = importerFixture({ evidencePatch: { code_sha: 'd'.repeat(40) } });
  assert.throws(() => overseas.importVerdicts(wrongCode.out, opts(wrongCode)), /CAUSALITY_CODE_SHA_MISMATCH/);
  assert.equal(fs.existsSync(overseas.LEDGER()) ? read(overseas.LEDGER()).length : 0, 0);
});
