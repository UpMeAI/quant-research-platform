'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gate = require('../services/causality-gate');
const costGate = require('../services/cost-gate');
const addendum = require('../services/research-framework-amendment-20261112-addendum-1');
const trials = require('../services/trial-ledger');
const core = require('../tools/causality-harness/lib/core');

/**
 * A1（研究框架修订 2026-11-12 附录 1 §1、§1.1）：成交函数纳入因果门。先红后绿，只用合成登记、合成运行日志与合成证据。
 * 范围：K2 冻结不早于附录 1 的 EFFECTIVE_FROM，且 G-COST 门内（台账登记的角色与阶段）至少一行——范围判断用成本门自己的分类。
 *   - K2 写 `G-CAUSAL N/A: <码>` → CAUSALITY_SCOPE_FILL_NOT_EXEMPT，只有 RISK_K_OR_ACCOUNT_LAYER 放行（§1；协调会话 11-16 裁定）；
 *   - K2 的 CF 函数在证据里没有一个标 role: FILL → CAUSALITY_FILL_FUNCTIONS_MISSING；
 *   - 附录 1 冻结页未绑定 → CAUSALITY_FREEZE_UNBOUND；
 *   - 范围之外（K2 早于生效时刻、门内没有行、全是只看信号）→ 与今天逐字节相同。
 * G-CAUSAL 的生效时刻取 FREEZE_1（不注入）；附录 1 的冻结页按成本门的测试接口换成一页合成的已绑定冻结页。
 */
const AUTH = 'TEST_A1_AUTHORITY';
const BOUND = Object.freeze({ path: 'artifacts/coordinator/SYNTH_ADDENDUM_FREEZE_1.md', sha256: 'a'.repeat(64), state: 'FREEZE_1', texts: [{ id: 'DRAFT_REV_1', sha256: 'b'.repeat(64) }] });
/** 合成的未绑定冻结页（附录 1 冻结前的形状；冻结后模块已绑定，失败即关仍要测）。 */
const UNBOUND = Object.freeze({ path: addendum.FREEZE.path, sha256: addendum.PENDING, state: addendum.PENDING, texts: [{ id: 'DRAFT_REV_1', sha256: addendum.PENDING }] });
const FAMILY = 'C17_V2_4000USDT';
const STUDY = 'R99-A1-SYNTH';
const CODE = 'c'.repeat(40);
const FILL = 'smartflow:src/replay/fill.js#fillPrice';
const FEAT = 'smartflow:src/features/f.js#f';
const AFTER = '2026-11-17T10:00:00+08:00';
const BEFORE = '2026-11-16T10:00:00+08:00';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ARMS = [
  { config_label: 'T', role: 'VERDICT_ARM', stage: 'BOOK', rule_config: { a1: true } },
  { config_label: 'S', role: 'SIGNAL_TEST', stage: 'SIGNAL', rule_config: { a1: true, ic: 1 } },
];
const k2Of = (lines) => `# R99 A1 K2（合成）\n\n## 0\n${lines.join('\n')}\n`;
const idOf = (label, study) => trials.trialIdOf({ family_id: FAMILY, study_ref: study, config_label: label });

function fnRecord(id, patch = {}) {
  const [p, entry] = id.slice(id.indexOf(':') + 1).split('#');
  return { function_id: id, path: p, entry, runner: 'node', file_sha256: 'f'.repeat(64),
    inputs: [{ name: 'bars', file: 'bars.json', file_sha256: 'b'.repeat(64), rows: 60, availability: { rule: 'DATE_AT', field: 'date', time: '15:00', tz: '+08:00' } }],
    cut_points: ['2025-01-10T07:00:00.000Z'], t_c1: 'PASS', t_c2: 'PASS', t_c3: 'PASS', fail_reasons: {}, mismatches: [], ...patch };
}
function evidence(k2Sha, functions) {
  const doc = { schema: 'CAUSALITY_EVIDENCE_V1', contract_ref: gate.CONTRACT_REF, study_ref: 'R99_A1_K2_V1', k2_sha256: k2Sha, code_repo: 'smartflow', code_sha: CODE, harness_version: '1.0.0',
    harness_sha256: 'a'.repeat(64), seed: gate.SEED, cut_points_per_function: gate.CUT_POINTS, manifest_sha256: 'd'.repeat(64), functions, unknown: {},
    production_effect: 'NONE', registered_by: 'TEST', registered_at: '2026-11-17T12:00:00Z' };
  doc.record_hash = gate.recordHash(doc);
  return doc;
}
const runRow = (study) => ([label, kind]) => ({ family_id: FAMILY, config_label: label, trial_id: idOf(label, study), verdict_metric_kind: kind, cost_model_ref: 'REPLAY_CORE_PROFILE_COSTS' });
const GATED_RUNS = [['T', 'NET_RETURN_SERIES'], ['S', 'IC']];
const SIGNAL_RUNS = [['S', 'IC']];

/**
 * 直接调因果门。lines：K2 §0；functions：证据里的函数（null = 不绑证据）；runs：运行日志的行；freeze：附录 1 冻结页（成本门的默认读法）。
 * 每份 K2 一个题号（STUDY 加 K2 sha 前缀），按 K2 现场预登记 T 与 S。
 */
function a1({ lines, functions = null, runs = GATED_RUNS, frozenAt = AFTER, freeze = BOUND, kind = 'RESULT' }) {
  const k2 = Buffer.from(k2Of(lines));
  const k2Sha = sha(k2);
  const study = `${STUDY}-${k2Sha.slice(0, 8)}`;
  trials.register(ARMS.map((a) => ({ family_id: FAMILY, market: 'CRYPTO_USDM_PERP', study_ref: study, k2_sha256: k2Sha, ...a })), { registeredBy: AUTH, registeredAt: '2026-11-17T09:00:00+08:00' });
  const evBytes = functions ? Buffer.from(JSON.stringify(evidence(k2Sha, functions))) : null;
  const log = Buffer.from(JSON.stringify({ schema: 'RESEARCH_RUN_LOG_V1', k2_sha256: k2Sha, smartflow_run_commit: CODE, runs: runs.map(runRow(study)) }));
  const entry = { id: 'C17-R99-A1', kind, strategy_ref: FAMILY, sealed_on: '2026-11-20', k2: { sha256: k2Sha }, k2_frozen_at: frozenAt,
    ...(evBytes ? { causality_evidence: { sha256: sha(evBytes) } } : {}) };
  return costGate.internals.withDefaults({ freeze }, () => gate.check(entry, { k2Bytes: () => k2, evidenceBytes: () => evBytes, runLogBytes: () => log, rulingBytes: () => null }));
}
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === `CAUSALITY_${code}`, code);

test.beforeEach(() => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  try { fs.rmSync(trials.TRIALS()); } catch { /* 首次 */ }
});

test('常量：A1 读附录 1 的生效时刻与冻结页（与 G-COST 同一个模块），不早于 G-CAUSAL 自己的 FREEZE_1；函数角色是可选字段，FILL 是其中一个值', () => {
  assert.equal(gate.FILL_EFFECTIVE_FROM, addendum.EFFECTIVE_FROM);
  assert.equal(gate.EFFECTIVE_FROM, '2026-11-15T22:47:42+08:00'); // FREEZE_1 不变
  assert.ok(Date.parse(gate.FILL_EFFECTIVE_FROM) >= Date.parse(gate.EFFECTIVE_FROM));
  assert.ok(gate.FUNCTION_ROLES.includes('FILL'));
  assert.equal(gate.FILL_ROLE, 'FILL');
  assert.equal(gate.FILL_EXEMPT_NA, 'RISK_K_OR_ACCOUNT_LAYER');
});

// 协调会话 11-16 裁定（以 §1 为准）：A1 范围内只有 RISK_K_OR_ACCOUNT_LAYER 能免测，其余四个不适用码各拒一次；消融题要把成交函数写成 CF 行（可按代码 sha 引用以前的证据）
for (const code of ['COST_EXECUTION', 'ABLATION', 'DEFECT_OR_ENGINEERING', 'DESCRIPTIVE_NO_PERFORMANCE']) {
  test(`A1 范围内：K2 写 G-CAUSAL N/A: ${code} → 拒绝 SCOPE_FILL_NOT_EXEMPT`, () => {
    assert.ok(gate.NOT_APPLICABLE_CODES.includes(code));
    refuses(() => a1({ lines: [`G-CAUSAL N/A: ${code}`] }), 'SCOPE_FILL_NOT_EXEMPT');
  });
}

test('A1 范围内：CF 函数在证据里没有一个标 role: FILL → 拒绝 FILL_FUNCTIONS_MISSING；标了 FILL → PASS，锁里记成交函数', () => {
  refuses(() => a1({ lines: [`\`CF:${FEAT}\``], functions: [fnRecord(FEAT)] }), 'FILL_FUNCTIONS_MISSING');
  refuses(() => a1({ lines: [`\`CF:${FEAT}\``], functions: [fnRecord(FEAT, { role: 'FEATURE' })] }), 'FILL_FUNCTIONS_MISSING');
  const r = a1({ lines: [`\`CF:${FEAT}\``, `\`CF:${FILL}\``], functions: [fnRecord(FEAT, { role: 'FEATURE' }), fnRecord(FILL, { role: 'FILL' })] });
  assert.equal(r.state, 'PASS');
  assert.deepEqual(r.fill_scope, { applies: true, effective_from: addendum.EFFECTIVE_FROM, freeze_sha256: BOUND.sha256, cost_gated_runs: 1, fill_functions: [FILL] });
});

test('A1 范围内：附录 1 冻结页未绑定（PENDING_FREEZE）→ 失败即关 FREEZE_UNBOUND，哪怕 K2 与证据都对', () => {
  refuses(() => a1({ lines: [`\`CF:${FILL}\``], functions: [fnRecord(FILL, { role: 'FILL' })], freeze: UNBOUND }), 'FREEZE_UNBOUND');
  refuses(() => a1({ lines: ['G-CAUSAL N/A: COST_EXECUTION'], freeze: UNBOUND }), 'FREEZE_UNBOUND');
});

test('A1 范围外，与今天逐字节相同：K2 早于附录 1 生效、门内没有行（全是只看信号）、READING；冻结页未绑定也不影响', () => {
  const na = (o) => a1({ lines: ['G-CAUSAL N/A: COST_EXECUTION'], freeze: UNBOUND, ...o });
  assert.deepEqual(na({ frozenAt: BEFORE }), { applies: true, state: 'NOT_APPLICABLE', effective_from: gate.EFFECTIVE_FROM, not_applicable_code: 'COST_EXECUTION' });
  assert.deepEqual(na({ runs: SIGNAL_RUNS }), { applies: true, state: 'NOT_APPLICABLE', effective_from: gate.EFFECTIVE_FROM, not_applicable_code: 'COST_EXECUTION' });
  assert.deepEqual(na({ kind: 'READING' }), { applies: true, state: 'NOT_APPLICABLE', effective_from: gate.EFFECTIVE_FROM, not_applicable_code: 'COST_EXECUTION' });
  const cf = a1({ lines: [`\`CF:${FEAT}\``], functions: [fnRecord(FEAT)], frozenAt: BEFORE, freeze: UNBOUND });
  assert.equal(cf.state, 'PASS');
  assert.equal(cf.fill_scope, undefined);
  assert.deepEqual(Object.keys(cf).sort(), ['applies', 'code_repo', 'code_sha', 'contract_ref', 'effective_from', 'evidence_record_hash', 'evidence_sha256', 'functions', 'harness_version', 'state']);
});

test('A1 范围内：K2 写 G-CAUSAL N/A: RISK_K_OR_ACCOUNT_LAYER（§1「不适用：风控层调 k、账户层」）照原样放过，记 NOT_APPLICABLE 与范围', () => {
  const r = a1({ lines: ['G-CAUSAL N/A: RISK_K_OR_ACCOUNT_LAYER'] });
  assert.deepEqual([r.state, r.not_applicable_code, r.fill_scope], ['NOT_APPLICABLE', 'RISK_K_OR_ACCOUNT_LAYER', { applies: true, effective_from: addendum.EFFECTIVE_FROM, freeze_sha256: BOUND.sha256, cost_gated_runs: 1 }]);
});

test('证据合同：函数的 role 可选；写了就必须是认得的值（否则 EVIDENCE_FUNCTION_ROLE_INVALID）；不写 role 的现有证据照旧有效', () => {
  const k2Sha = 'e'.repeat(64);
  const ok = gate.parseEvidence(Buffer.from(JSON.stringify(evidence(k2Sha, [fnRecord(FEAT)]))));
  assert.equal(ok.functions[0].role, undefined);
  assert.equal(gate.parseEvidence(Buffer.from(JSON.stringify(evidence(k2Sha, [fnRecord(FILL, { role: 'FILL' })])))).functions[0].role, 'FILL');
  refuses(() => gate.parseEvidence(Buffer.from(JSON.stringify(evidence(k2Sha, [fnRecord(FILL, { role: 'EXECUTION' })])))), 'EVIDENCE_FUNCTION_ROLE_INVALID');
});

/** 最小清单（同 tests/causality_harness.test.js 的 mini）。 */
function mini(extra) {
  const dir = tmp('qrp-a1-mini-');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'bars.json'), JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 2 + i)).toISOString().slice(0, 10), close: 10 + i }))));
  fs.writeFileSync(path.join(dir, 'f.js'), 'module.exports.f = (bars) => bars.map((b) => b.close);');
  const m = { schema: 'CAUSALITY_MANIFEST_V1', study_ref: 'MINI', k2_sha256: 'a'.repeat(64), code_repo: 'mini', fixture_dir: 'data',
    functions: [{ path: 'f.js', entry: 'f', inputs: [{ name: 'bars', file: 'bars.json', availability: { rule: 'DATE_AT', field: 'date', time: '15:00', tz: '+08:00' } }], call: { order: ['bars'] }, output: { align: 'ALIGNED', to: 'bars' }, ...extra }] };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return path.join(dir, 'manifest.json');
}

test('工具：清单的函数写了 role 就原样记进证据（门复验通过）；不写就不出现这个键；写了不认得的值直接报错', () => {
  const filled = core.runManifest(mini({ role: 'FILL' }), { registeredBy: 'TEST', k: 3 });
  assert.equal(filled.functions[0].role, 'FILL');
  assert.equal(gate.parseEvidence(Buffer.from(JSON.stringify(filled))).functions[0].role, 'FILL');
  const plain = core.runManifest(mini({}), { registeredBy: 'TEST', k: 3 });
  assert.equal('role' in plain.functions[0], false);
  assert.throws(() => core.runManifest(mini({ role: 'EXECUTION' }), { registeredBy: 'TEST', k: 3 }), /FUNCTION_ROLE_INVALID/);
});
