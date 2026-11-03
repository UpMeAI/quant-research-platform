'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sealed = require('../services/sealed-research-results');
const profiles = require('../services/strategy-profiles');
const m4 = require('../services/strategy-profiles/m4_scope');
const { validateRecord } = require('../schemas');
const { read } = require('../packages/ledger');

const AUTH = 'TEST_CARRY_AUTHORITY';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 1)}\n`); };

/** 合成的钉版 smartflow 与接入封存包(形状同 carry_onboarding.js / carry_m1.js 的回执)。 */
function fixture({ tweak = {} } = {}) {
  const root = tmp('qrp-srr-sf-');
  const pkg = path.join(root, 'trading-system-v2');
  const rows = [];
  for (const rel of sealed.ENTRY.sealed_files) {
    const body = rel === sealed.ENTRY.verdict.path ? { verdict: { result: 'INSUFFICIENT', next: 'FORWARD_VALIDATION_B7_FORM_A', failingK: ['K1'] } } : `sealed ${rel}\n`;
    write(path.join(pkg, rel), body);
    rows.push({ group: 'x', path: rel, view: 'FILE', status: 'MATCH', sha256: sha(fs.readFileSync(path.join(pkg, rel))), recorded: [] });
  }
  const entry = { ...sealed.ENTRY, verdict: { ...sealed.ENTRY.verdict, sha256: sha(fs.readFileSync(path.join(pkg, sealed.ENTRY.verdict.path))) } };
  const dir = tmp('qrp-srr-bundle-');
  const m1 = { kind: 'QRP_CARRY_V2_M1_PACKAGE_V1', pass: { M1_1: true, M1_2: true, M1_3: true, A0_1: true, all: true },
    M1_1: { rows, mismatched: 0, missing: 0 }, M1_3: { records: 2301, fold: 'PASS', max_identity_residual_usdt: 0 }, M1_4: { rows_by_type: { MTM: 3 } }, ...(tweak.m1 || {}) };
  const windows = Object.fromEntries(sealed.ENTRY.windows.map((w) => [w, { pass: true, resultsSha256: `r${w}`, sealed: `r${w}` }]));
  const docs = {
    'm1.pass1.json': [m1, 'M1', 1], 'm1.pass2.json': [tweak.m1pass2 || m1, 'M1', 2],
    'a0-2.pass1.json': [{ pass: { all: true }, verdict: { identical: true } }, 'A0_2', 1], 'a0-2.pass2.json': [{ pass: { all: true }, verdict: { identical: true } }, 'A0_2', 2],
    'a0-3.pass1.json': [{ pass: true, jobs_total: 70, groups: { IS_OOS: { harness_verdict: 'BYTE_IDENTICAL', rerun_verdict: 'BYTE_IDENTICAL', different: 0 } } }, 'A0_3', 1],
    'a0-3.pass2.json': [{ pass: true, jobs_total: 70, groups: { IS_OOS: { harness_verdict: 'BYTE_IDENTICAL', rerun_verdict: 'BYTE_IDENTICAL', different: 0 } } }, 'A0_3', 2],
    'a0-4.pass1.json': [tweak.a04 || { pass: { all: true }, jobs_used: 70, jobs_unused: 0, windows, verdict: { identical: true, rows: [1, 2, 3, 4, 5, 6] } }, 'A0_4', 1],
    'a0-4.pass2.json': [{ pass: { all: true }, jobs_used: 70, jobs_unused: 0, windows, verdict: { identical: true, rows: [1, 2, 3, 4, 5, 6] } }, 'A0_4', 2],
    'a0-5.twice.json': [{ pass: true, different: 0, missing: 0, files: 9, byte_identical: 9,
      rows: Object.values(sealed.ENTRY.pass_receipts).map((file) => ({ file, verdict: tweak.a05verdict || 'BYTE_IDENTICAL' })) }, 'A0_5', null],
  };
  const files = [];
  for (const [name, [doc, role, pass]] of Object.entries(docs)) {
    write(path.join(dir, name), doc);
    files.push({ file: name, role, pass, sha256: sha(fs.readFileSync(path.join(dir, name))) });
  }
  write(path.join(dir, 'SEAL.json'), { kind: sealed.ENTRY.seal_kind, k2: { sha256: sealed.ENTRY.k2.sha256 }, k2_freeze: { sha256: sealed.ENTRY.k2_freeze.sha256 },
    smartflow_commit: sealed.ENTRY.smartflow_commit, files, ...(tweak.seal || {}) });
  return { root, pkg, dir, entry };
}

function withAuthority(fn) {
  const saved = process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  try { return fn(); } finally { if (saved === undefined) delete process.env.QRP_PRODUCT_MILESTONE_AUTHORITY; else process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = saved; }
}
const imp = (fx, opts = {}) => withAuthority(() => sealed.importSealedResult(fx.dir, { smartflowRoot: fx.root, registeredBy: AUTH, entry: fx.entry, lockedAt: '2026-11-08T00:00:00.000Z', ...opts }));

test('导入:前提成立 → 一条封存研究结论锁(结论原样、只有日历与计数),重复导入是重放;其他四条策略的档案与 M4 页面状态不变', () => {
  const profileBytes = fs.readFileSync(profiles.FILE);
  const refsBefore = profiles.list().map((p) => p.strategy_ref);
  const fx = fixture();
  const lock = imp(fx);
  assert.equal(lock.schema, 'SEALED_RESEARCH_RESULT_LOCK_V1');
  assert.deepEqual(validateRecord(lock), { ok: true, problems: [] });
  assert.equal(lock.result_id, `SRR-CARRY-${sha(fs.readFileSync(path.join(fx.dir, 'SEAL.json'))).slice(0, 16)}`);
  assert.deepEqual([lock.strategy_ref, lock.case_ref, lock.verdict_form, lock.verdict_result, lock.verdict_next, lock.first_look],
    ['CARRY_V2_SHADOW_10000USDT', 'RRC-CARRY-V2-10000USDT-V8-1-M0', '(a)', 'INSUFFICIENT', 'FORWARD_VALIDATION_B7_FORM_A', '2027-12-31']);
  assert.equal(lock.oos_reuse, true);
  assert.equal(lock.half_kelly, 'NOT_APPLICABLE');
  assert.equal(lock.segment_marks.V2_W2, 'SEEN_DATA_DECISION');
  assert.equal(lock.sealed_files.length, sealed.ENTRY.sealed_files.length);
  assert.equal(lock.receipts.length, 9);
  assert.equal(lock.production_effect, 'NONE');
  assert.doesNotThrow(() => sealed.assertNoForwardValues(lock, 'lock'));
  assert.equal(imp(fx).replayHit, true);
  assert.equal(read(sealed.LEDGER()).length, 1);
  // 档案 §4 第 4 条:不碰其他策略 —— 档案文件逐字节不变,M4 里 carry 仍是未接入的那一条
  assert.ok(fs.readFileSync(profiles.FILE).equals(profileBytes));
  assert.deepEqual(profiles.list().map((p) => p.strategy_ref), refsBefore);
  assert.ok(!refsBefore.includes('CARRY_V2_SHADOW_10000USDT'));
  assert.equal(m4.itemFor('CARRY_V2_SHADOW_10000USDT').id, 'CARRY_V2');
  assert.equal(m4.NOT_ONBOARDED_LABEL, '已列入 M4 范围，尚未接入');
  // 换包:不带 supersedes 拒绝;带缺陷与原因才换
  const fx2 = fixture({ tweak: { seal: { note: 'second' } } });
  assert.throws(() => imp(fx2), /SEALED_RESULT_ALREADY_LOCKED/);
  assert.throws(() => imp(fx2, { supersedes: lock.result_id }), /SUPERSEDE_REQUIRES_DEFECT_AND_REASON/);
  const next = imp(fx2, { supersedes: lock.result_id, defectRef: 'DEFECT-1', reason: 'test' });
  assert.equal(next.supersedes_ref, lock.result_id);
});

test('档案 §4 第 1 条:A0 不是全部 BYTE_IDENTICAL / M1 不全通过或两遍不同 → 拒绝导入', () => {
  assert.throws(() => imp(fixture({ tweak: { a04: { pass: { all: false }, jobs_used: 70, jobs_unused: 0, windows: {}, verdict: { identical: false } } } })), /SEALED_RESULT_A0_NOT_BYTE_IDENTICAL:A0-4 pass 1/);
  assert.throws(() => imp(fixture({ tweak: { a05verdict: 'IDENTICAL_EXCEPT_VOLATILE' } })), /SEALED_RESULT_A0_NOT_BYTE_IDENTICAL:A0-5/);
  assert.throws(() => imp(fixture({ tweak: { m1: { pass: { all: false } } } })), /SEALED_RESULT_M1_NOT_PASSED/);
  const fx = fixture();
  const m1 = JSON.parse(fs.readFileSync(path.join(fx.dir, 'm1.pass1.json'), 'utf8'));
  assert.throws(() => imp(fixture({ tweak: { m1pass2: { ...m1, cutoff: 'other' } } })), /SEALED_RESULT_M1_NOT_REPRODUCED/);
});

test('档案 §4 第 2、5 条:M1 回执里有前向数值键 → 拒绝导入', () => {
  assert.throws(() => imp(fixture({ tweak: { m1: { M1_4: { rows_by_type: { MTM: 3 }, sample: [{ equity: 5000 }] } } } })), /SEALED_RESULT_FORWARD_VALUE_FIELD:M1 pass 1\.M1_4\.sample\[0\]\.equity/);
  assert.throws(() => sealed.assertNoForwardValues({ forward_calendar: { a: { X: 0.01 } } }, 'lock'), /FORWARD_VALUE_FIELD:lock\.forward_calendar\.a\.X/);
});

test('档案 §4 第 3 条:封存包或钉版文件的 sha256 不符 → 拒绝导入;没有完成权威 → 拒绝', () => {
  const fx = fixture();
  fs.appendFileSync(path.join(fx.dir, 'a0-2.pass2.json'), ' ');
  assert.throws(() => imp(fx), /SEALED_RESULT_FILE_SHA_MISMATCH:a0-2.pass2.json/);
  const fy = fixture();
  fs.appendFileSync(path.join(fy.pkg, 'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_W2.json'), ' ');
  assert.throws(() => imp(fy), /SEALED_RESULT_FILE_SHA_MISMATCH:docs\/evidence\/CRYPTO_FUNDING_BASIS_CARRY_V2_W2.json/);
  const fz = fixture();
  assert.throws(() => sealed.importSealedResult(fz.dir, { smartflowRoot: fz.root, registeredBy: AUTH, entry: fz.entry }), /AUTHORITY_NOT_CONFIGURED/);
  // 真实条目:VERDICT 必须是档案 §1 的全值(合成文件不是)
  assert.throws(() => imp({ ...fz, entry: sealed.ENTRY }), /SEALED_RESULT_FILE_SHA_MISMATCH:docs\/evidence\/CRYPTO_FUNDING_BASIS_CARRY_V2_VERDICT.json ≠ 档案 §1/);
  const fk = fixture({ tweak: { seal: { k2: { sha256: '0'.repeat(64) } } } });
  assert.throws(() => imp(fk), /SEALED_RESULT_K2_SHA_MISMATCH/);
});
