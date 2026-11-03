'use strict';

/**
 * 封存研究结论锁 `SEALED_RESEARCH_RESULT_LOCK_V1` —— Carry V2 导入档案（docs/contracts/CARRY_V2_RESULT_IMPORT_PROFILE_V1.md，
 * 487cf360…，协调会话 CARRY_V2_RESULT_IMPORT_PROFILE_V1_FREEZE_1 b54b03e2… 冻结）§0、§1、§4 的导入器。
 *
 * 导入的是封存结论原样（INSUFFICIENT → 前向 form (a)，首查 2027-12-31），不重新评价，不重算任何数。只做核对，只追加一条锁：
 *   §0 前提：M1 回执两遍都全部通过且逐字节相同；A0-2 … A0-5 回执全部通过，两遍的核对回执在 A0-5 里都是 BYTE_IDENTICAL；
 *   §1 绑定：接入封存包（smartflow 研究分支 docs/evidence/carry-qrp-v1/SEAL.json）列出的每个回执按 sha256 现场复核；
 *       钉版 smartflow 的封存文件（VERDICT、W1/W2/FULL、DATA、TESTS、FORWARD_SETUP、RESULT V1/V2、V1 历史证据）按 M1-1 回执的
 *       sha256 现场复核，VERDICT 另按档案 §1 的全值；
 *   §4 失败关闭：A0 不全 BYTE_IDENTICAL、M1 不全通过、任何 sha256 不符、锁或 M1 回执里出现前向数值键，一律拒绝。
 * 本轮只有导入器（协调会话在台账副本上试导入，再写真实台账）；档案 §2 的档案项与 §3 的页面另行实现，
 * 在那之前页面照 A4.4 第 2 条显示「已列入 M4 范围，尚未接入」。没有 HTTP 写入口，不下单，不改生产参数。
 */
const fs = require('fs');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const baseline = require('../baseline-evaluation');
const m4 = require('../strategy-profiles/m4_scope');

const { K3Error, need, sha256, canonical, authority, isObject } = baseline.internals;
const SHA64 = /^[0-9a-f]{64}$/;
const isText = (value) => typeof value === 'string' && value.trim() !== '';

const ENTRY = Object.freeze({
  record_type: 'CARRY_V2_SEALED_RESULT_V1', lock_schema: 'SEALED_RESEARCH_RESULT_LOCK_V1', id_prefix: 'SRR-CARRY',
  m4_item: 'CARRY_V2', strategy_ref: 'CARRY_V2_SHADOW_10000USDT', case_ref: 'RRC-CARRY-V2-10000USDT-V8-1-M0',
  seal_kind: 'CARRY_V2_QRP_ONBOARDING_SEAL_V1',
  smartflow_commit: '8d97cbdec0a775fd9fe8cc75643da34fffebe9bc',
  import_profile: Object.freeze({ ref: 'docs/contracts/CARRY_V2_RESULT_IMPORT_PROFILE_V1.md', sha256: '487cf3602485bed7c95225c108eb36048aa2ea666ef7a38f6090de01870a60a7' }),
  import_profile_freeze: Object.freeze({ ref: 'artifacts/coordinator/CARRY_V2_RESULT_IMPORT_PROFILE_V1_FREEZE_1.md（不在 git 里，按 sha256 绑定）', sha256: 'b54b03e2ca7fc19a74938c213a057082a6ebcd8052d48c469e27526055edf5aa' }),
  k2: Object.freeze({ ref: 'smartflow:research/carry-v2-qrp-onboarding-k2@82753e30:trading-system-v2/docs/CARRY_V2_QRP_ONBOARDING_K2_DRAFT_V1.md', sha256: '319a055d58e0c1d3fe1d4042cf592680deaca7e097d8e398c42bc1bfc19cc1ba' }),
  k2_freeze: Object.freeze({ ref: 'artifacts/coordinator/CARRY_V2_QRP_ONBOARDING_K2_FREEZE_1.md（不在 git 里，按 sha256 绑定）', sha256: '6a5a6c0790ea4937256a7699b9360340acd26c01abe9b07ba9d6fa752fb5cdd1' }),
  verdict: Object.freeze({ path: 'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_VERDICT.json', sha256: '25123e19d3f89c424c2bea8e4e87677d2d14c2ba18a0c109db53d3372ea847ac',
    result: 'INSUFFICIENT', next: 'FORWARD_VALIDATION_B7_FORM_A' }),
  // 档案 §1 表的 smartflow 文件（相对 trading-system-v2/），sha256 取 M1-1 回执里核过的值
  sealed_files: Object.freeze([
    'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_VERDICT.json', 'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_W1.json',
    'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_W2.json', 'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_FULL.json',
    'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_DATA.json', 'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_TESTS.json',
    'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_FORWARD_SETUP.json', 'docs/CRYPTO_FUNDING_BASIS_CARRY_RESEARCH_RESULT_V2.md',
    'docs/CRYPTO_FUNDING_BASIS_CARRY_RESEARCH_RESULT_V1.md',
    'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_RESEARCH_V1_DATA.json', 'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_RESEARCH_V1_DATA_A1.json',
    'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_RESEARCH_V1_IS_RUN1.json', 'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_RESEARCH_V1_IS.json',
    'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_RESEARCH_V1_OOS.json', 'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_RESEARCH_V1_TESTS.json',
    'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_RESEARCH_V1_VERDICT.json', 'docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_RESEARCH_V1_FUNDING_REGIME.json',
  ]),
  // 两遍都必须有的回执（SEAL.json 的 role）；A0-5 里这些相对路径必须 BYTE_IDENTICAL
  pass_receipts: Object.freeze({ M1: 'm1/m1.receipt.json', A0_2: 'a0-2/a0-2.check.json', A0_3: 'a0-3/a0-3.check.json', A0_4: 'a0-4/a0-4.check.json' }),
  jobs: 70, windows: Object.freeze(['IS', 'OOS', 'W1', 'W2', 'FULL']), verdict_objects: 6,
  // 档案 §3 第 6 条（K2 §6.2）
  seen_data: '§B3: 2020-01 → 2026-09 全部已看',
  data_uses: Object.freeze(['V1_IS', 'V1_OOS', 'V1_FUNDING_REGIME_POST_HOC', 'V2_W1', 'V2_W2', 'V2_FULL', 'QRP_PR48_JOBS (reproduction only)', 'ONBOARDING_A0 (reproduction only)']),
  segment_marks: Object.freeze({ V1_IS: 'HISTORY_V1', V1_OOS: 'HISTORY_V1', V2_W1: 'SEEN_DATA', V2_W2: 'SEEN_DATA_DECISION', V2_FULL: 'REPORT_ONLY', FORWARD_A: 'FORWARD_OOS', FORWARD_B: 'FORWARD_EXECUTION_NO_VERDICT' }),
  forward_calendar: Object.freeze({ a: Object.freeze({ f_start: '2026-10-02T16:00:00Z', first_look: '2027-12-31', last_look: '2030-09-30', state: 'NOT_DUE' }),
    b: Object.freeze({ label: 'PAPER_SHADOW · NO_CAPITAL · NO_VERDICT' }) }),
  // 档案 §4 第 2 条：前向数值字段（权益、余额、收益、年化、X、CI、资金费或利息金额）；与 M1 的 denied_keys 同一份
  forward_value_keys: Object.freeze(['equity', 'cash', 'amount', 'amountFref', 'a7', 'negRun', 'tau', 'S', 'F', 'w', 'q', 'd', 'MB', 'pliq', 'markClose', 'markPrice',
    'fundingRate', 'basis', 'fRef', 'baseCash', 'y', 'dtb3', 'interest', 'fees', 'balance', 'X', 'CI', 'ci', 'annualized', 'return']),
});

const LEDGER = () => path.join(dataDir('research'), 'sealed_research_results.jsonl');
const E = (code) => `SEALED_RESULT_${code}`;

const readJson = (file, code) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw new K3Error(code, `${path.basename(file)}:${error.code || error.message}`); }
};
const fileSha = (file) => sha256(fs.readFileSync(file));

/** 任一层出现前向数值键即拒绝（档案 §4 第 2、5 条）。 */
function assertNoForwardValues(value, where, keys = ENTRY.forward_value_keys) {
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoForwardValues(item, `${where}[${index}]`, keys)); return; }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    need(!keys.includes(key), E('FORWARD_VALUE_FIELD'), `${where}.${key}`);
    assertNoForwardValues(item, `${where}.${key}`, keys);
  }
}

/** 封存包：SEAL.json 与它列出的每个文件（sha256 现场复核）。 */
function readBundle(dir, entry = ENTRY) {
  need(typeof dir === 'string' && path.isAbsolute(dir), E('BUNDLE_PATH_MUST_BE_ABSOLUTE'));
  const sealFile = path.join(dir, 'SEAL.json');
  need(fs.existsSync(sealFile), E('BUNDLE_SEAL_MISSING'), sealFile);
  const seal = readJson(sealFile, E('BUNDLE_SEAL_UNREADABLE'));
  need(seal.kind === entry.seal_kind, E('BUNDLE_KIND_UNSUPPORTED'), seal.kind);
  need(isObject(seal.k2) && seal.k2.sha256 === entry.k2.sha256, E('K2_SHA_MISMATCH'), isObject(seal.k2) ? seal.k2.sha256 : null);
  need(isObject(seal.k2_freeze) && seal.k2_freeze.sha256 === entry.k2_freeze.sha256, E('K2_FREEZE_SHA_MISMATCH'), isObject(seal.k2_freeze) ? seal.k2_freeze.sha256 : null);
  need(seal.smartflow_commit === entry.smartflow_commit, E('SMARTFLOW_COMMIT_MISMATCH'), seal.smartflow_commit);
  need(Array.isArray(seal.files) && seal.files.length > 0, E('BUNDLE_FILES_MISSING'));
  const files = {};
  for (const item of seal.files) {
    need(isObject(item) && isText(item.file) && !item.file.includes('..') && SHA64.test(item.sha256 || ''), E('BUNDLE_FILE_ENTRY_INVALID'), item && item.file);
    const full = path.join(dir, item.file);
    need(fs.existsSync(full), E('BUNDLE_FILE_MISSING'), item.file);
    need(fileSha(full) === item.sha256, E('FILE_SHA_MISMATCH'), item.file);
    files[item.file] = { ...item, full };
  }
  return { dir, seal, sealSha256: fileSha(sealFile), files };
}

const byRole = (bundle, role, pass = null) => Object.values(bundle.files).filter((f) => f.role === role && (pass === null || f.pass === pass));
function receipt(bundle, role, pass) {
  const hits = byRole(bundle, role, pass);
  need(hits.length === 1, E('RECEIPT_MISSING'), `${role}${pass ? ` pass ${pass}` : ''}`);
  return { ...hits[0], doc: readJson(hits[0].full, E('RECEIPT_UNREADABLE')) };
}

/** 档案 §0 前提：每一项都现场从回执读，不信 SEAL.json 自报的结论。 */
function checkPrecondition(bundle, entry = ENTRY) {
  const m1 = [1, 2].map((p) => receipt(bundle, 'M1', p));
  for (const r of m1) {
    need(isObject(r.doc.pass) && r.doc.pass.all === true, E('M1_NOT_PASSED'), `pass ${r.pass}`);
    need(r.doc.M1_1 && r.doc.M1_1.mismatched === 0 && r.doc.M1_1.missing === 0, E('M1_NOT_PASSED'), `pass ${r.pass} M1-1`);
    assertNoForwardValues(r.doc, `M1 pass ${r.pass}`, entry.forward_value_keys);
  }
  need(m1[0].sha256 === m1[1].sha256, E('M1_NOT_REPRODUCED'));
  for (const p of [1, 2]) {
    const a2 = receipt(bundle, 'A0_2', p).doc;
    need(isObject(a2.pass) && a2.pass.all === true && a2.verdict && a2.verdict.identical === true, E('A0_NOT_BYTE_IDENTICAL'), `A0-2 pass ${p}`);
    const a3 = receipt(bundle, 'A0_3', p).doc;
    need(a3.pass === true && a3.jobs_total === entry.jobs && Object.values(a3.groups || {}).every((g) => g.harness_verdict === 'BYTE_IDENTICAL'
      && g.rerun_verdict === 'BYTE_IDENTICAL' && g.different === 0), E('A0_NOT_BYTE_IDENTICAL'), `A0-3 pass ${p}`);
    const a4 = receipt(bundle, 'A0_4', p).doc;
    need(isObject(a4.pass) && a4.pass.all === true && a4.jobs_used === entry.jobs && a4.jobs_unused === 0
      && entry.windows.every((w) => a4.windows && a4.windows[w] && a4.windows[w].pass === true && a4.windows[w].resultsSha256 === a4.windows[w].sealed)
      && a4.verdict && a4.verdict.identical === true && Array.isArray(a4.verdict.rows) && a4.verdict.rows.length === entry.verdict_objects,
    E('A0_NOT_BYTE_IDENTICAL'), `A0-4 pass ${p}`);
  }
  const a5 = receipt(bundle, 'A0_5', null).doc;
  need(a5.pass === true && a5.different === 0 && a5.missing === 0, E('A0_NOT_BYTE_IDENTICAL'), 'A0-5');
  for (const rel of Object.values(entry.pass_receipts)) {
    const row = (a5.rows || []).find((x) => x.file === rel);
    need(row && row.verdict === 'BYTE_IDENTICAL', E('A0_NOT_BYTE_IDENTICAL'), `A0-5 ${rel}`);
  }
  return { m1: m1[0].doc, a4: receipt(bundle, 'A0_4', 1).doc, a5 };
}

/** 钉版 smartflow 的封存文件：sha256 = M1-1 回执里核过的值（VERDICT 另按档案 §1 的全值）。 */
function checkSealedFiles(smartflowRoot, m1, entry = ENTRY) {
  need(typeof smartflowRoot === 'string' && path.isAbsolute(smartflowRoot), E('SMARTFLOW_ROOT_MUST_BE_ABSOLUTE'));
  const pkg = path.join(smartflowRoot, 'trading-system-v2');
  return entry.sealed_files.map((rel) => {
    const row = m1.M1_1.rows.find((r) => r.path === rel && r.view === 'FILE');
    need(row && row.status === 'MATCH' && SHA64.test(row.sha256 || ''), E('SEALED_FILE_NOT_IN_M1'), rel);
    const full = path.join(pkg, rel);
    need(fs.existsSync(full), E('SEALED_FILE_MISSING'), rel);
    const actual = fileSha(full);
    need(actual === row.sha256, E('FILE_SHA_MISMATCH'), rel);
    if (rel === entry.verdict.path) need(actual === entry.verdict.sha256, E('FILE_SHA_MISMATCH'), `${rel} ≠ 档案 §1`);
    return { path: rel, sha256: actual };
  });
}

function headLock(caseRef) {
  const rows = read(LEDGER()).filter((row) => row.schema === ENTRY.lock_schema && row.case_ref === caseRef);
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * 导入（完成权威）：核对后追加一条 SEALED_RESEARCH_RESULT_LOCK_V1。同一封存包重复导入是幂等重放；
 * 换包须 supersedes 当前锁并带缺陷与原因。
 */
function importSealedResult(bundleDir, {
  smartflowRoot, registeredBy, supersedes = null, defectRef = null, reason = null, lockedAt = null, entry = ENTRY,
} = {}) {
  authority(registeredBy);
  const item = m4.itemFor(entry.strategy_ref);
  need(item && item.id === entry.m4_item, E('STRATEGY_NOT_IN_M4_SCOPE'), entry.strategy_ref);
  const bundle = readBundle(bundleDir, entry);
  const pre = checkPrecondition(bundle, entry);
  const sealedFiles = checkSealedFiles(smartflowRoot, pre.m1, entry);
  const verdict = readJson(path.join(smartflowRoot, 'trading-system-v2', entry.verdict.path), E('VERDICT_UNREADABLE')).verdict;
  need(isObject(verdict) && verdict.result === entry.verdict.result && verdict.next === entry.verdict.next, E('VERDICT_NOT_AS_SEALED'), verdict && verdict.result);

  const resultId = `${entry.id_prefix}-${bundle.sealSha256.slice(0, 16)}`;
  const head = headLock(entry.case_ref);
  if (head && head.result_id === resultId) return { ...head, replayHit: true };
  if (head) {
    need(supersedes === head.result_id, E('ALREADY_LOCKED'), head.result_id);
    need(defectRef && reason, E('SUPERSEDE_REQUIRES_DEFECT_AND_REASON'));
  } else need(!supersedes, E('SUPERSEDE_TARGET_NOT_FOUND'), supersedes);

  const body = {
    schema: entry.lock_schema, record_type: entry.record_type, result_id: resultId, case_ref: entry.case_ref, strategy_ref: entry.strategy_ref,
    verdict_form: '(a)', verdict_result: verdict.result, verdict_next: verdict.next, first_look: entry.forward_calendar.a.first_look,
    oos_reuse: true, seen_data: entry.seen_data, data_uses: [...entry.data_uses], segment_marks: { ...entry.segment_marks },
    forward_calendar: JSON.parse(JSON.stringify(entry.forward_calendar)), half_kelly: 'NOT_APPLICABLE',
    reproduction: { passes: 2, jobs: pre.a4.jobs_used, windows_identical: entry.windows.length, verdict_objects_identical: pre.a4.verdict.rows.length,
      a0_5_files: pre.a5.files, a0_5_byte_identical: pre.a5.byte_identical },
    sealed_files: sealedFiles,
    bundle_ref: bundleDir, bundle_sha256: bundle.sealSha256,
    receipts: Object.values(bundle.files).map((f) => ({ file: f.file, role: f.role || null, pass: f.pass || null, sha256: f.sha256 })),
    smartflow_commit: entry.smartflow_commit, k2_ref: entry.k2.ref, k2_sha256: entry.k2.sha256, k2_freeze_sha256: entry.k2_freeze.sha256,
    import_profile_id: entry.import_profile.ref, import_profile_sha256: entry.import_profile.sha256, import_profile_freeze_sha256: entry.import_profile_freeze.sha256,
    supersedes_ref: supersedes, defect_ref: defectRef, supersede_reason: reason, production_effect: 'NONE', locked_by: registeredBy,
    locked_at: lockedAt || now(),
  };
  assertNoForwardValues(body, 'lock', entry.forward_value_keys);
  body.lock_hash = sha256(canonical(body));
  return append(LEDGER(), body);
}

/** 当前锁（只读；没有锁返回 null）。 */
const currentLock = (caseRef = ENTRY.case_ref) => headLock(caseRef);

module.exports = { ENTRY, LEDGER, assertNoForwardValues, readBundle, checkPrecondition, checkSealedFiles, importSealedResult, currentLock };
