'use strict';

/**
 * G-CAUSAL 因果门 —— 研究框架修订（2026-11-12）§3.4，按 FREEZE_1（c9742ea0…，2026-11-15T22:47:42+08:00）冻结：草稿修订 1（d7f85a87…）
 * 加冻结审阅 rev 3（d943d342…）的 G1–G20，全部取 (a)。合同 docs/contracts/CAUSALITY_EVIDENCE_V1.md。
 *
 * 接进海外与 A 股封存结论导入器（同一套 importVerdicts），在原有校验与 G-TRIAL 门之后运行。
 * 门只会拒绝导入（失败即关，错误码 CAUSALITY_*），从不改写结论，也不会因此判「不做」。
 *
 *   过门的题（封存导入 RESULT / READING，K2 在修订生效之后冻结）：
 *     - K2 文本声明范围：每个新增或重算函数写成 `CF:<function_id>`；不适用的写一行「G-CAUSAL N/A: <码>」（§3.2 的五类）；
 *       两样都没有、两样都有、或写了不适用却又绑了证据 → 拒绝；
 *     - entry.causality_evidence 按 sha256 绑定一份 CAUSALITY_EVIDENCE_V1：record_hash 复算一致；k2_sha256 等于这份 K2；
 *       code_sha 等于运行日志（entry.run_log，RESEARCH_RUN_LOG_V1）里 `<code_repo>_run_commit`；种子与截点数是冻结值；unknown 为空；
 *     - K2 写出的函数集合与证据 functions[] 的集合相等，每个函数 T-C1、T-C2、T-C3 全为 PASS；
 *     - 偏差只能出自 entry.causality_ruling（一页按 sha256 绑定的协调会话裁定，写法同 trial_gates_ruling）：
 *       放行的只是裁定逐个写明、且证据里确实是 FAIL 的「函数 × 测试」，记 DEVIATION_ACCEPTED，不记 PASS；
 *       RULED_LAG（§3.3「裁定写明滞后规则」）的输入也只能出自同一页裁定。
 *   不过门的题：照原样导入，锁行不加字段。绑了证据的（§3.6 补跑、§3.7 上线前核对）只核完整性，结果原样记进锁（只报，不拒绝 FAIL）。
 *
 * 生效时刻取冻结页（E13 / G14 同一个常量，在 services/research-framework-amendment-20261112，与 G-MECH 共用）：此刻及之后冻结的 K2 过门，此前已冻结的不追溯。
 * 证据要写出 contract_ref（本冻结页的路径 + sha256 前缀），过门时核对。
 *
 * A1（研究框架修订 2026-11-12 附录 1 §1、§1.1，成交函数纳入因果门）：过门的题里，K2 冻结不早于附录 1 的生效时刻（FILL_EFFECTIVE_FROM，
 * ../research-framework-amendment-20261112-addendum-1，与 G-COST 同一个常量），且 G-COST 门内至少一行（范围判断用 ../cost-gate 的 costGatedScope，不另写）：
 *   - 附录 1 冻结页未绑定 → CAUSALITY_FREEZE_UNBOUND；
 *   - K2 写 `G-CAUSAL N/A: <码>` → CAUSALITY_SCOPE_FILL_NOT_EXEMPT，只有 RISK_K_OR_ACCOUNT_LAYER 放行（§1「不适用：风控层调 k、账户层」；协调会话 11-16 裁定，以 §1 为准）；
 *   - K2 的 CF 函数在证据里没有一个标 role: FILL → CAUSALITY_FILL_FUNCTIONS_MISSING。
 * 范围之外照旧，返回值逐字节不变；范围之内返回值多一个 fill_scope 块。证据函数的 role 可选（FUNCTION_ROLES），不写的现有证据照旧有效。
 *
 * 门的裁定读范围（A 股导入规格 V1 修订 6；R-XM-1 ★IMP1 (a)，协调会话 2026-11-17）：K2 两样都没写（本来报 SCOPE_MISSING）时，
 * entry.causality_ruling = { spec, scope_not_applicable: <§3.2 五类之一> }，一页按 sha256 绑定的协调会话裁定把它读作「G-CAUSAL N/A: <码>」。
 *   - 页上要写出 DEVIATION_ACCEPTED、CAUSALITY_SCOPE_MISSING 与「G-CAUSAL N/A: <码>」，缺一个 → RULING_TEXT_DOES_NOT_STATE；
 *   - 事实要成立：K2 里确实没有 CF 也没有 N/A（否则 RULING_FACT_NOT_HOLD），不绑证据（否则 SCOPE_CONFLICT）；A1 范围内只放过 RISK_K_OR_ACCOUNT_LAYER；
 *   - 不和函数偏差、滞后规则混写（RULING_INVALID）；
 *   - 锁里记 DEVIATION_ACCEPTED（不记 NOT_APPLICABLE，也不记 PASS），带不适用码、偏差与裁定页 sha256。
 * 没有登记 scope_not_applicable 的题，代码路径与返回值逐字节不变。
 */
const crypto = require('crypto');
const { validateRecord } = require('../../schemas');
const { canonicalJson } = require('../trial-ledger');
const amendment = require('../research-framework-amendment-20261112');
const addendum1 = require('../research-framework-amendment-20261112-addendum-1');
/** 成本门晚加载：只在过门的题判 A1 范围时才读（它在加载时要读适配器目录）。 */
const costGate = () => require('../cost-gate');

const SCHEMA = 'CAUSALITY_EVIDENCE_V1';
/** 冻结页（E1：path + sha256）与生效时刻，都从共用模块读：G-MECH（E13）与 G-CAUSAL（G14）是同一个常量，不各自另写。 */
const { FREEZE } = amendment;
const CONTRACT_REF = `${FREEZE.path}@${FREEZE.sha256.slice(0, 8)}`;
/** 修订生效时刻（K2 冻结不早于它才过门）。 */
const EFFECTIVE_FROM = amendment.EFFECTIVE_FROM;
/** ★3 (a)：每个函数 20 个截点，种子 20261112。 */
const SEED = 20261112;
const CUT_POINTS = 20;
const HARNESS_VERSIONS = Object.freeze(['1.0.0']);
const TESTS = Object.freeze(['t_c1', 't_c2', 't_c3']);
const TEST_LABEL = Object.freeze({ t_c1: 'T-C1', t_c2: 'T-C2', t_c3: 'T-C3' });
const STATUSES = Object.freeze(['PASS', 'FAIL']);
const RUNNERS = Object.freeze(['node', 'python']);
const AVAILABILITY_RULES = Object.freeze(['FIELD', 'DATE_AT', 'RULED_LAG']);
/** §3.2「不适用」五类。 */
const NOT_APPLICABLE_CODES = Object.freeze(['RISK_K_OR_ACCOUNT_LAYER', 'ABLATION', 'COST_EXECUTION', 'DEFECT_OR_ENGINEERING', 'DESCRIPTIVE_NO_PERFORMANCE']);
const SHA64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[a-z0-9][a-z0-9-]*$/;
/** function_id = <仓库>:<相对路径>#<入口>，例如 ashare-v6:src/research/pvs/structure.js#classifyStructureSeries。 */
const FUNCTION_ID = /^[a-z0-9][a-z0-9-]*:[A-Za-z0-9_./-]+#[A-Za-z0-9_.$]+$/;
const CF_IN_TEXT = /`CF:([^`\s]+)`/g;
const NA_IN_TEXT = /G-CAUSAL N\/A:\s*([A-Z_]+)/g;
/** 门的裁定读范围时：K2 里任何形式的「G-CAUSAL N/A」（全角冒号、括号、小写、全角斜杠、换行）都算 K2 写了范围（审阅 #119 FIX-2）。 */
const NA_LOOSE = /G-CAUSAL\s*N\s*[\/／]\s*A/i;
const MAX_MISMATCHES = 20;
/** A1：附录 1 的生效时刻（不早于 FREEZE_1）；证据函数可选的角色（修订 §3.2 列的四类加成交函数）。 */
const FILL_EFFECTIVE_FROM = addendum1.EFFECTIVE_FROM;
const FUNCTION_ROLES = Object.freeze(['SIGNAL', 'FEATURE', 'SCORE', 'FILTER', 'FILL']);
const FILL_ROLE = 'FILL';
/** A1 范围内唯一放行的不适用码（附录 1 §1）；COST_EXECUTION、ABLATION、DEFECT_OR_ENGINEERING、DESCRIPTIVE_NO_PERFORMANCE 都拒绝。 */
const FILL_EXEMPT_NA = 'RISK_K_OR_ACCOUNT_LAYER';

class CausalityGateError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new CausalityGateError(`CAUSALITY_${code}`, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
need(Date.parse(FILL_EFFECTIVE_FROM) >= Date.parse(EFFECTIVE_FROM), 'EFFECTIVE_FROM_INVALID', `FILL_EFFECTIVE_FROM ${FILL_EFFECTIVE_FROM} < ${EFFECTIVE_FROM}`); // A1 的范围在 G-CAUSAL 的范围之内
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isoAt = (v) => typeof v === 'string' && /[zZ]|[+-]\d{2}:\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const recordHash = (doc) => { const { record_hash: _omit, ...rest } = doc; return sha256(canonicalJson(rest)); };
/** RESEARCH_RUN_LOG_V1 里运行代码 sha 的键：ashare-v6 → ashare_v6_run_commit，smartflow → smartflow_run_commit。 */
const runCommitKey = (repo) => `${repo.replace(/-/g, '_')}_run_commit`;

// ── 证据文件 ────────────────────────────────────────────────────────────────────

function checkFunction(doc, fn, i) {
  const at = `functions[${i}]`;
  need(isObj(fn) && FUNCTION_ID.test(fn.function_id || ''), 'EVIDENCE_FUNCTION_ID_INVALID', `${at}:${fn && fn.function_id}`);
  need(fn.function_id.startsWith(`${doc.code_repo}:`), 'EVIDENCE_FUNCTION_REPO_MISMATCH', fn.function_id);
  need(RUNNERS.includes(fn.runner) && isText(fn.path) && isText(fn.entry), 'EVIDENCE_FUNCTION_INVALID', fn.function_id);
  need(fn.function_id === `${doc.code_repo}:${fn.path}#${fn.entry}`, 'EVIDENCE_FUNCTION_ID_INVALID', `${fn.function_id}≠${fn.path}#${fn.entry}`);
  need(Array.isArray(fn.inputs) && fn.inputs.length, 'EVIDENCE_INPUTS_INVALID', fn.function_id);
  for (const input of fn.inputs) {
    need(isObj(input) && isText(input.name) && SHA64.test(input.file_sha256 || '') && Number.isInteger(input.rows), 'EVIDENCE_INPUTS_INVALID', `${fn.function_id}:${input && input.name}`);
    need(isObj(input.availability) && AVAILABILITY_RULES.includes(input.availability.rule), 'EVIDENCE_AVAILABILITY_INVALID', `${fn.function_id}:${input.name}`);
    if (input.availability.rule === 'RULED_LAG') need(SHA64.test(input.availability.ruling_sha256 || ''), 'EVIDENCE_AVAILABILITY_INVALID', `${fn.function_id}:${input.name}:ruling_sha256`);
  }
  need(Array.isArray(fn.cut_points) && fn.cut_points.every(isoAt), 'EVIDENCE_CUT_POINTS_INVALID', fn.function_id);
  for (const t of TESTS) need(STATUSES.includes(fn[t]), 'EVIDENCE_STATUS_INVALID', `${fn.function_id}:${t}:${fn[t]}`);
  need(Array.isArray(fn.mismatches) && fn.mismatches.length <= MAX_MISMATCHES, 'EVIDENCE_MISMATCHES_INVALID', fn.function_id);
  need(isObj(fn.fail_reasons), 'EVIDENCE_FUNCTION_INVALID', `${fn.function_id}:fail_reasons`);
  for (const t of TESTS) need((fn[t] === 'FAIL') === isText(fn.fail_reasons[t]), 'EVIDENCE_FAIL_REASON_INVALID', `${fn.function_id}:${t}`);
  need(fn.role === undefined || FUNCTION_ROLES.includes(fn.role), 'EVIDENCE_FUNCTION_ROLE_INVALID', `${fn.function_id}:${fn.role}`);
}

/** 解析并核对一份证据（字节已按 sha256 复验）。不对 FAIL 拒绝，只核结构与 record_hash。 */
function parseEvidence(bytes, where = 'evidence') {
  let doc;
  try { doc = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)); } catch { return fail('EVIDENCE_NOT_JSON', where); }
  need(isObj(doc) && doc.schema === SCHEMA, 'EVIDENCE_SCHEMA_INVALID', where);
  const v = validateRecord(doc, SCHEMA);
  need(v.ok, 'EVIDENCE_SCHEMA_INVALID', `${where}:${v.problems.join(',')}`);
  need(doc.record_hash === recordHash(doc), 'EVIDENCE_RECORD_HASH_MISMATCH', where);
  need(doc.production_effect === 'NONE', 'EVIDENCE_PRODUCTION_EFFECT_INVALID', where);
  need(isText(doc.contract_ref), 'EVIDENCE_SCHEMA_INVALID', `${where}:contract_ref`);
  need(isText(doc.study_ref) && SHA64.test(doc.k2_sha256) && SHA64.test(doc.manifest_sha256) && SHA64.test(doc.harness_sha256), 'EVIDENCE_SCHEMA_INVALID', `${where}:sha256`);
  need(REPO.test(doc.code_repo), 'EVIDENCE_SCHEMA_INVALID', `${where}:code_repo`);
  need(doc.code_sha === null ? isText(doc.unknown.code_sha) : SHA40.test(doc.code_sha), 'EVIDENCE_CODE_SHA_INVALID', where);
  need(isoAt(doc.registered_at) && isText(doc.registered_by), 'EVIDENCE_SCHEMA_INVALID', `${where}:registered`);
  need(doc.functions.length, 'EVIDENCE_NO_FUNCTIONS', where);
  doc.functions.forEach((fn, i) => checkFunction(doc, fn, i));
  const ids = doc.functions.map((f) => f.function_id);
  need(new Set(ids).size === ids.length, 'EVIDENCE_FUNCTION_DUPLICATE', where);
  return doc;
}

// ── 范围与裁定 ──────────────────────────────────────────────────────────────────

/** K2 文本里的范围声明：`CF:<function_id>` 与「G-CAUSAL N/A: <码>」。 */
function declaration(k2Text) {
  const cf = [...new Set([...k2Text.matchAll(CF_IN_TEXT)].map((m) => m[1]))];
  const na = [...new Set([...k2Text.matchAll(NA_IN_TEXT)].map((m) => m[1]))];
  return { cf, na };
}

const sealing = (entry) => entry.kind === 'RESULT' || entry.kind === 'READING';

/** 这一题是否过门。effectiveFrom 默认取冻结页的生效时刻；传 null（只在测试里）时没有题过门。 */
function applies(entry, effectiveFrom = EFFECTIVE_FROM) {
  if (!entry.k2 || entry.kind === 'DRAFT') return { applies: false, reason: entry.k2 ? 'DRAFT_NOT_FROZEN' : 'NO_K2' };
  if (!sealing(entry)) return { applies: false, reason: 'NOT_A_SEAL' };
  if (effectiveFrom === null) return { applies: false, reason: 'AMENDMENT_NOT_FROZEN' };
  need(isoAt(effectiveFrom), 'EFFECTIVE_FROM_INVALID', String(effectiveFrom));
  const eff = Date.parse(effectiveFrom);
  if (entry.k2_frozen_at !== undefined && entry.k2_frozen_at !== null) {
    need(isoAt(entry.k2_frozen_at), 'K2_FROZEN_AT_INVALID', `${entry.id}:${entry.k2_frozen_at}`);
    const after = Date.parse(entry.k2_frozen_at) >= eff;
    return { applies: after, reason: after ? 'FROZEN_AFTER_AMENDMENT' : 'FROZEN_BEFORE_AMENDMENT' };
  }
  const effDate = new Date(eff + 8 * 3600e3).toISOString().slice(0, 10); // 生效日（CST）
  need(!(typeof entry.sealed_on === 'string' && entry.sealed_on >= effDate), 'K2_FROZEN_AT_MISSING', entry.id);
  return { applies: false, reason: 'SEALED_BEFORE_AMENDMENT' };
}

/**
 * entry.causality_ruling：{ spec, deviations?: [{ function_id, test }], lag_rules?: [{ function_id, input }] }。
 * 裁定页按 sha256 复验后，原文必须写出 DEVIATION_ACCEPTED / RULED_LAG、每个函数 id 与测试名。
 */
function rulingOf(entry, rulingBytes) {
  const r = entry.causality_ruling;
  if (r === undefined || r === null) return null;
  if (isObj(r) && r.scope_not_applicable !== undefined) return scopeRulingOf(entry, r, rulingBytes);
  need(isObj(r) && r.spec && SHA64.test(r.spec.sha256 || '') && (r.deviations || r.lag_rules), 'RULING_INVALID', entry.id);
  const deviations = r.deviations || [];
  const lagRules = r.lag_rules || [];
  need(Array.isArray(deviations) && deviations.every((d) => isObj(d) && FUNCTION_ID.test(d.function_id || '') && TESTS.includes(d.test)), 'RULING_DEVIATIONS_INVALID', entry.id);
  need(new Set(deviations.map((d) => `${d.function_id}|${d.test}`)).size === deviations.length, 'RULING_DEVIATIONS_INVALID', `${entry.id}:duplicate`);
  need(Array.isArray(lagRules) && lagRules.every((l) => isObj(l) && FUNCTION_ID.test(l.function_id || '') && isText(l.input)), 'RULING_LAG_RULES_INVALID', entry.id);
  const bytes = rulingBytes();
  need(bytes, 'RULING_FILE_MISSING', entry.id);
  const text = bytes.toString('utf8');
  const words = [...(deviations.length ? ['DEVIATION_ACCEPTED'] : []), ...(lagRules.length ? ['RULED_LAG'] : []),
    ...deviations.flatMap((d) => [d.function_id, TEST_LABEL[d.test]]), ...lagRules.flatMap((l) => [l.function_id, l.input])];
  for (const w of words) need(text.includes(w), 'RULING_TEXT_DOES_NOT_STATE', `${entry.id}:${w}`);
  return { ref: r.spec.ref || null, sha256: r.spec.sha256, deviations, lagRules };
}

/** 门的裁定读范围（A 股导入规格 V1 修订 6）：只有 spec 与 scope_not_applicable 两个键；码在 §3.2 五类里；页上写明三处原文。 */
const SCOPE_MISSING_CODE = 'CAUSALITY_SCOPE_MISSING';
function scopeRulingOf(entry, r, rulingBytes) {
  need(r.spec && SHA64.test(r.spec.sha256 || '') && Object.keys(r).every((k) => k === 'spec' || k === 'scope_not_applicable'), 'RULING_INVALID', entry.id);
  need(NOT_APPLICABLE_CODES.includes(r.scope_not_applicable), 'RULING_SCOPE_CODE_INVALID', `${entry.id}:${r.scope_not_applicable}`);
  const bytes = rulingBytes();
  need(bytes, 'RULING_FILE_MISSING', entry.id);
  const text = bytes.toString('utf8');
  const readAs = `G-CAUSAL N/A: ${r.scope_not_applicable}`;
  for (const w of ['DEVIATION_ACCEPTED', SCOPE_MISSING_CODE, readAs]) need(text.includes(w), 'RULING_TEXT_DOES_NOT_STATE', `${entry.id}:${w}`);
  return { ref: r.spec.ref || null, sha256: r.spec.sha256, deviations: [], lagRules: [], scopeNotApplicable: r.scope_not_applicable, readAs };
}

function runLogCommit(entry, runLogBytes, repo) {
  const bytes = runLogBytes();
  if (!bytes) return { present: false, value: null };
  let doc;
  try { doc = JSON.parse(bytes.toString('utf8')); } catch { return fail('RUN_LOG_NOT_JSON', entry.id); }
  need(isObj(doc) && doc.schema === 'RESEARCH_RUN_LOG_V1', 'RUN_LOG_INVALID', entry.id);
  const value = doc[runCommitKey(repo)];
  return { present: true, key: runCommitKey(repo), value: typeof value === 'string' ? value : null };
}

const summary = (doc) => doc.functions.map((f) => ({ function_id: f.function_id, t_c1: f.t_c1, t_c2: f.t_c2, t_c3: f.t_c3 }));

/**
 * A1 的范围（附录 1 §1.1）：附录 1 生效之后冻结、G-COST 门内至少一行的 RESULT。范围之外返回 null（调用方什么都不加）。
 * 范围之内而附录 1 冻结页未绑定 → 失败即关。
 */
function fillScope(entry, runLogBytes) {
  const s = costGate().costGatedScope(entry, runLogBytes);
  if (!s.applies || !s.cost_gated_runs) return null;
  need(s.freeze_bound, 'FREEZE_UNBOUND', `${entry.id}:${s.freeze.path}:${s.freeze.state}`);
  return { applies: true, effective_from: s.effective_from, freeze_sha256: s.freeze.sha256, cost_gated_runs: s.cost_gated_runs };
}

/**
 * 导入器调用：原有校验与 G-TRIAL 门都通过之后。
 * @param {object} entry 登记表一题
 * @param {{k2Bytes: () => Buffer, evidenceBytes: () => Buffer|null, runLogBytes: () => Buffer|null, rulingBytes: () => Buffer|null}} files 按 sha256 复验后的字节
 * @param {{effectiveFrom?: string|null}} [opts] 只给测试用；导入器不传，取 EFFECTIVE_FROM
 */
function check(entry, { k2Bytes, evidenceBytes = () => null, runLogBytes = () => null, rulingBytes = () => null }, { effectiveFrom = EFFECTIVE_FROM } = {}) {
  const scope = applies(entry, effectiveFrom);
  const bound = Boolean(entry.causality_evidence);
  if (bound) need(SHA64.test(entry.causality_evidence.sha256 || ''), 'EVIDENCE_SPEC_INVALID', entry.id);
  const evidence = () => {
    const bytes = evidenceBytes();
    need(bytes, 'EVIDENCE_FILE_MISSING', entry.id);
    const doc = parseEvidence(bytes, entry.id);
    need(doc.k2_sha256 === entry.k2.sha256, 'EVIDENCE_K2_MISMATCH', entry.id);
    return doc;
  };

  if (!scope.applies) {
    need(!entry.causality_ruling, 'RULING_ON_UNGATED_ENTRY', entry.id);
    if (!bound) return { applies: false, reason: scope.reason };
    // §3.6 补跑 / §3.7 上线前核对：只核完整性，结果原样记下，FAIL 不拒绝导入
    const doc = evidence();
    const log = runLogCommit(entry, runLogBytes, doc.code_repo);
    return { applies: false, reason: scope.reason, report_only: true, evidence_sha256: entry.causality_evidence.sha256, evidence_record_hash: doc.record_hash, contract_ref: doc.contract_ref,
      harness_version: doc.harness_version, code_repo: doc.code_repo, code_sha: doc.code_sha, code_sha_matches_run_log: log.present && log.value ? log.value === doc.code_sha : null,
      unknown_keys: Object.keys(doc.unknown).sort(), functions: summary(doc) };
  }

  const fill = fillScope(entry, runLogBytes);
  const { cf, na } = declaration(k2Bytes().toString('utf8'));
  if (entry.causality_ruling && entry.causality_ruling.scope_not_applicable !== undefined) {
    // A 股导入规格 V1 修订 6：K2 两样都没写，按裁定页读作不适用；记 DEVIATION_ACCEPTED
    const ruling = rulingOf(entry, rulingBytes);
    need(!cf.length && !na.length, 'RULING_FACT_NOT_HOLD', `${entry.id}:K2_DECLARES_SCOPE:${[...cf.map((x) => `CF:${x}`), ...na].join(',')}`);
    const loose = NA_LOOSE.exec(k2Bytes().toString('utf8'));
    need(!loose, 'RULING_FACT_NOT_HOLD', `${entry.id}:K2_MENTIONS_NA:${loose ? loose[0].replace(/\s+/g, ' ') : ''}`);
    need(!bound, 'SCOPE_CONFLICT', `${entry.id}:N/A_WITH_EVIDENCE`);
    need(!fill || ruling.scopeNotApplicable === FILL_EXEMPT_NA, 'SCOPE_FILL_NOT_EXEMPT', `${entry.id}:${ruling.scopeNotApplicable}`);
    return { applies: true, state: 'DEVIATION_ACCEPTED', effective_from: effectiveFrom, not_applicable_code: ruling.scopeNotApplicable,
      deviation: { code: SCOPE_MISSING_CODE, read_as: ruling.readAs }, ruling_ref: ruling.ref, ruling_sha256: ruling.sha256, ...(fill ? { fill_scope: fill } : {}) };
  }
  need(!(cf.length && na.length) && na.length <= 1, 'SCOPE_CONFLICT', entry.id);
  if (na.length) {
    need(NOT_APPLICABLE_CODES.includes(na[0]), 'SCOPE_CODE_INVALID', `${entry.id}:${na[0]}`);
    need(!fill || na[0] === FILL_EXEMPT_NA, 'SCOPE_FILL_NOT_EXEMPT', `${entry.id}:${na[0]}`);
    need(!bound && !entry.causality_ruling, 'SCOPE_CONFLICT', `${entry.id}:N/A_WITH_EVIDENCE`);
    return { applies: true, state: 'NOT_APPLICABLE', effective_from: effectiveFrom, not_applicable_code: na[0], ...(fill ? { fill_scope: fill } : {}) };
  }
  need(cf.length, 'SCOPE_MISSING', entry.id);
  for (const id of cf) need(FUNCTION_ID.test(id), 'K2_FUNCTION_ID_INVALID', `${entry.id}:${id}`);
  need(bound, 'EVIDENCE_MISSING', entry.id);
  const doc = evidence();
  need(doc.contract_ref === CONTRACT_REF, 'EVIDENCE_CONTRACT_MISMATCH', `${entry.id}:${doc.contract_ref}`);
  need(doc.seed === SEED && doc.cut_points_per_function === CUT_POINTS, 'EVIDENCE_PARAMS_NOT_FROZEN', `${entry.id}:seed=${doc.seed},k=${doc.cut_points_per_function}`);
  need(HARNESS_VERSIONS.includes(doc.harness_version), 'HARNESS_VERSION_UNKNOWN', `${entry.id}:${doc.harness_version}`);
  const unknownKeys = Object.keys(doc.unknown);
  need(!unknownKeys.length, 'EVIDENCE_UNKNOWN', `${entry.id}:${unknownKeys.sort().join(',')}`);
  const log = runLogCommit(entry, runLogBytes, doc.code_repo);
  need(log.present, 'RUN_LOG_MISSING', entry.id);
  need(log.value, 'RUN_LOG_CODE_SHA_MISSING', `${entry.id}:${log.key}`);
  need(log.value === doc.code_sha, 'CODE_SHA_MISMATCH', `${entry.id}:${doc.code_sha}≠${log.value}`);
  const ids = doc.functions.map((f) => f.function_id);
  for (const id of cf) need(ids.includes(id), 'FUNCTION_NOT_IN_EVIDENCE', `${entry.id}:${id}`);
  for (const id of ids) need(cf.includes(id), 'FUNCTION_NOT_IN_K2', `${entry.id}:${id}`);
  const fillIds = doc.functions.filter((f) => f.role === FILL_ROLE).map((f) => f.function_id);
  if (fill) need(fillIds.length, 'FILL_FUNCTIONS_MISSING', `${entry.id}:${ids.join(',')}`);

  const ruling = rulingOf(entry, rulingBytes);
  const used = [];
  for (const fn of doc.functions) {
    for (const input of fn.inputs.filter((x) => x.availability.rule === 'RULED_LAG')) {
      const ok = ruling && ruling.lagRules.some((l) => l.function_id === fn.function_id && l.input === input.name) && input.availability.ruling_sha256 === ruling.sha256;
      need(ok, 'LAG_RULE_NOT_RULED', `${entry.id}:${fn.function_id}:${input.name}`);
    }
    for (const t of TESTS) {
      if (fn[t] === 'PASS') continue;
      const dev = ruling && ruling.deviations.find((d) => d.function_id === fn.function_id && d.test === t);
      need(dev, 'FUNCTION_NOT_PASS', `${entry.id}:${fn.function_id}:${TEST_LABEL[t]}:${fn.fail_reasons[t]}`);
      used.push({ function_id: fn.function_id, test: t, fail_reason: fn.fail_reasons[t] });
    }
  }
  if (ruling) {
    // 裁定写的每一条都要在证据里成立：放行的测试确实是 FAIL，滞后规则确实有对应的 RULED_LAG 输入
    for (const d of ruling.deviations) need(used.some((u) => u.function_id === d.function_id && u.test === d.test), 'RULING_FACT_NOT_HOLD', `${entry.id}:${d.function_id}:${TEST_LABEL[d.test]}`);
    for (const l of ruling.lagRules) {
      const fn = doc.functions.find((f) => f.function_id === l.function_id);
      need(fn && fn.inputs.some((x) => x.name === l.input && x.availability.rule === 'RULED_LAG'), 'RULING_FACT_NOT_HOLD', `${entry.id}:${l.function_id}:${l.input}`);
    }
  }
  return { applies: true, state: used.length ? 'DEVIATION_ACCEPTED' : 'PASS', effective_from: effectiveFrom, evidence_sha256: entry.causality_evidence.sha256,
    evidence_record_hash: doc.record_hash, contract_ref: doc.contract_ref, harness_version: doc.harness_version, code_repo: doc.code_repo, code_sha: doc.code_sha, functions: summary(doc),
    ...(used.length ? { deviations: used } : {}), ...(ruling ? { ruling_ref: ruling.ref, ruling_sha256: ruling.sha256 } : {}),
    ...(fill ? { fill_scope: { ...fill, fill_functions: fillIds } } : {}) };
}

module.exports = {
  SCHEMA, FREEZE, CONTRACT_REF, EFFECTIVE_FROM, FILL_EFFECTIVE_FROM, FUNCTION_ROLES, FILL_ROLE, FILL_EXEMPT_NA, SEED, CUT_POINTS, HARNESS_VERSIONS, TESTS, TEST_LABEL, STATUSES, RUNNERS, AVAILABILITY_RULES, NOT_APPLICABLE_CODES,
  FUNCTION_ID, SHA64, SHA40, MAX_MISMATCHES, NA_LOOSE, CausalityGateError, recordHash, runCommitKey, parseEvidence, declaration, applies, check,
  internals: { rulingOf, runLogCommit, fillScope },
};
