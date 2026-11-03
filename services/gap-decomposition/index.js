'use strict';

/**
 * 差距分解描述记录 `GAP_DECOMPOSITION_V1`（US_V5_M2_Q0_RESULT_V1 导入规格增补 1 第 1 部分）。
 *
 * 规则出处：冻结的差距分解 K2（docs/contracts/US_V5_M2_R2_GAP_DECOMPOSITION_K2_V1.md，a161c523…）「QRP 需要的」一节、
 * 勘误 1（c17802e3…）、协调会话 US_V5_M2_R2_K2_FREEZE_1（5501741d…）★6 (a)；原版臂来源按候选对比导入规格 V2 附录 3 第 2 节读。
 *
 * 研究会话封存 `US_V5_M2_R2_GAP_DECOMPOSITION_V1`（一个 JSON 加旁边的 .sha256）。QRP 只读导入：
 *   1. `importGapDecomposition`（命令行，完成权威）校验封存文件，追加一条 `GAP_DECOMPOSITION_LOCK_V1`，
 *      result_id = `GAP-<文件 sha256 前 16 位>`；每个 case 一条，改锁须引用缺陷并写原因（旧锁保留）；
 *   2. `readProjections`（页面）每次现场复验文件 sha256，投影成 Q0 卡片下面的一张卡「差距分解（描述，不是结论）」：
 *      排名表（带功效列）、功效、第 2 步准入表。
 *
 * 这是描述，不是结论：文件不许带三态（任何 `verdict` / `verdict_state` 键都拒绝），锁不进采用一览、不算「待 Owner 决定」，
 * 也不是候选对比锁。页面不重算：所有数字来自文件，只做四舍五入与正负号排版；准入表只核对「标签与文件里的数一致」。
 * 没有 HTTP 写入口，不写生产参数、账本以外的任何东西。
 */
const fs = require('fs');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const baseline = require('../baseline-evaluation');
const comparison = require('../candidate-comparison');
const profiles = require('../strategy-profiles');

const { K3Error, fail, need, isObject, sha256, canonical, authority, reasonText } = baseline.internals;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const SHA64 = /^[0-9a-f]{64}$/;

const IMPORT_PROFILE_ID = 'docs/contracts/US_V5_M2_Q0_RESULT_V1_IMPORT_PROFILE_ADDENDUM_1.md';
const FREEZE = Object.freeze({ ref: 'artifacts/coordinator/US_V5_M2_R2_K2_FREEZE_1.md（不在 git 里，按 sha256 绑定）', sha256: '5501741d93de625685fda2013deb560c71227c5100c7d8da50647ea351bc46ba' });

/** 登记项（增补 1 §1.1）：只有 US_V5 有这一类记录。 */
const ENTRY = Object.freeze({
  record_type: 'GAP_DECOMPOSITION_V1', lock_schema: 'GAP_DECOMPOSITION_LOCK_V1', id_prefix: 'GAP', code_prefix: 'GAP',
  strategy_ref: 'US_V5_ETF_3000USD',
  schema: 'US_V5_M2_R2_GAP_DECOMPOSITION_V1', result_kind: 'DESCRIPTIVE_DECOMPOSITION',
  title_zh: '差距分解（描述，不是结论）',
  k2: Object.freeze({ ref: 'docs/contracts/US_V5_M2_R2_GAP_DECOMPOSITION_K2_V1.md', sha256: 'a161c5234f07d6cef182ccf21837be100a82be8f18b0184d6e393598814437cc' }),
  erratum: Object.freeze({ ref: 'docs/contracts/US_V5_M2_R2_GAP_DECOMPOSITION_K2_V1_ERRATUM_1.md', sha256: 'c17802e332a91d7ac539d1bb684427e0375f02c7bb0ae9a5aceed3728b019161' }),
  freeze: FREEZE,
  import_profile_id: IMPORT_PROFILE_ID,
  top_level: Object.freeze(['identity', 'oos_reuse', 'oos_reuse_detail', 'gates', 'window', 'decomposition', 'ranking', 'power', 'step2_admission', 'reproducibility']),
  // K2 第 3 节 YAML 的 12 个运行门（结果报告第 5 节「门」）
  run_gates: Object.freeze(['ACCEPTANCE', 'INPUTS', 'ENGINE_FILES', 'RECON_D', 'RECON_B', 'IDENTITY', 'FEE_CROSSCHECK', 'EXIT_COUNTS', 'IS_REPRO', 'IS_RECON', 'REPRO', 'MEM']),
  // ★7 (a)：当前 D = Q5 的候选臂 D+A25+T3
  base_arm: Object.freeze({ question_ref: 'Q5', arm: 'CANDIDATE_T3_ON_A25' }),
  cited: Object.freeze(['Q1', 'Q2', 'Q3', 'Q4', 'Q5']),
  oos_reuse: Object.freeze({ expected: true, reason_code: 'OOS_REUSED_FOR_SELECTION' }),
  // ★9 (a)：准入按 1.96，2.80 一并报告；菜单只有 M-1（★8）
  thresholds: Object.freeze({ checks_1_96: 1.96, checks_2_80: 2.80 }),
  decisions: Object.freeze(['CANDIDATE', 'NO_CANDIDATE']),
});

const LEDGER = () => path.join(dataDir('research'), 'gap_decompositions.jsonl');
const E = (code) => `${ENTRY.code_prefix}_${code}`;

// ── 数字排版（只排版，不重算）────────────────────────────────────────────────────

const minus = (value) => (value < 0 ? '−' : '');
const signed = (value, digits = 4) => (finite(value) ? `${value > 0 ? '+' : minus(value)}${Math.abs(value).toFixed(digits)}` : '—');
const plain = (value, digits = 4) => (finite(value) ? `${minus(value)}${Math.abs(value).toFixed(digits)}` : '—');
const money = (value) => (finite(value) ? `${value > 0 ? '+' : minus(value)}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
const moneyPlain = (value) => (finite(value) ? `${minus(value)}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
const share = (value) => (finite(value) ? `${minus(value)}${Math.abs(value * 100).toFixed(1)}%` : '—');
const count = (value) => (finite(value) ? Number(value).toLocaleString('en-US') : '—');
const yes = (value) => (value === true ? '是' : value === false ? '否' : '—');

// ── 封存文件 ────────────────────────────────────────────────────────────────────

/** 与 Q0 同一套封存读取；错误码前缀 `Q0_RESULT_` 换成 `GAP_RESULT_`。 */
function readSealed(file, { allowNonActual = false } = {}) {
  let sealed;
  try { sealed = baseline.readSealed(file, { allowNonActual, topLevel: ENTRY.top_level }); } catch (error) {
    if (error instanceof K3Error && /^Q0_RESULT_/.test(error.code)) throw new K3Error(error.code.replace(/^Q0_RESULT_/, `${ENTRY.code_prefix}_RESULT_`), error.detail);
    throw error;
  }
  return sealed;
}

/** 文件任何位置出现 `verdict` 或 `verdict_state` 键 → 带了三态（K2「不允许的字段」）。 */
function verdictPath(value, where = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) { const hit = verdictPath(value[i], `${where}[${i}]`); if (hit) return hit; }
    return null;
  }
  if (!isObject(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'verdict' || key === 'verdict_state') return `${where}${where ? '.' : ''}${key}`;
    const hit = verdictPath(item, `${where}${where ? '.' : ''}${key}`);
    if (hit) return hit;
  }
  return null;
}

// ── 整文件一致性（失败关闭；不读账本）─────────────────────────────────────────────

function checkAdmission(doc) {
  const s = doc.step2_admission;
  const bad = (detail) => fail(E('ADMISSION_INCONSISTENT'), detail);
  need(isObject(s) && isObject(s.menu) && isObject(s.group) && isObject(s.checks_1_96) && isObject(s.checks_2_80), E('ADMISSION_INCONSISTENT'), 'step2_admission 缺块');
  const menu = s.menu['M-1'];
  need(isObject(menu) && Array.isArray(menu.blocks) && isText(menu.candidate) && Object.keys(s.menu).length === 1, E('ADMISSION_INCONSISTENT'), '菜单只登记 M-1（★8 (a)）');
  if (canonical(s.group.blocks) !== canonical(menu.blocks)) bad(`group.blocks ${canonical(s.group.blocks)} ≠ M-1 ${canonical(menu.blocks)}`);
  const reading = (name, g, se, gIs, checks, threshold) => {
    need([g, se, gIs].every(finite), E('ADMISSION_INCONSISTENT'), `${name}：g / SE / IS g 必须是数`);
    const parts = ['positive', 'significant', 'is_same_sign', 'admitted'];
    need(parts.every((key) => typeof checks[key] === 'boolean'), E('ADMISSION_INCONSISTENT'), `${name}：四项必须是 true / false`);
    if (checks.positive !== (g > 0)) bad(`${name}.positive`);
    if (checks.is_same_sign !== (gIs > 0)) bad(`${name}.is_same_sign`);
    // 显著：g ≥ 门槛·SE（★9 (a)）。文件里的数已取整，正好落在门槛上（差 ≤ 1e-6）时两种标签都接受
    const margin = g - threshold * se;
    if (Math.abs(margin) > 1e-6 && checks.significant !== (margin >= 0)) bad(`${name}.significant`);
    if (checks.admitted !== (checks.positive && checks.significant && checks.is_same_sign)) bad(`${name}.admitted`);
  };
  reading('checks_1_96', s.group.g, s.group.se, s.group.g_is, s.checks_1_96, ENTRY.thresholds.checks_1_96);
  reading('checks_2_80', s.group.g, s.group.se, s.group.g_is, s.checks_2_80, ENTRY.thresholds.checks_2_80);
  const sens = s.sensitivity_reversed_convention;
  need(isObject(sens) && isObject(sens.checks_1_96) && isObject(sens.checks_2_80), E('ADMISSION_INCONSISTENT'), 'sensitivity_reversed_convention 缺块（★3 (a)）');
  reading('sensitivity.checks_1_96', sens.g, sens.se, sens.g_is, sens.checks_1_96, ENTRY.thresholds.checks_1_96);
  reading('sensitivity.checks_2_80', sens.g, sens.se, sens.g_is, sens.checks_2_80, ENTRY.thresholds.checks_2_80);
  // 运行门都过了，就只能是「有候选」或「无候选」；有候选 ⇔ 按 1.96 准入，候选就是 M-1 的名字
  need(ENTRY.decisions.includes(s.decision), E('ADMISSION_INCONSISTENT'), `decision=${s.decision}`);
  if ((s.decision === 'CANDIDATE') !== s.checks_1_96.admitted) bad(`decision=${s.decision} 与按 1.96 准入=${s.checks_1_96.admitted} 不一致`);
  if (s.candidate !== (s.checks_1_96.admitted ? menu.candidate : null)) bad(`candidate=${s.candidate}`);
  need(Array.isArray(s.research_gaps), E('ADMISSION_INCONSISTENT'), 'research_gaps');
}

function checkRanking(doc) {
  const rows = doc.ranking && doc.ranking.rows;
  need(Array.isArray(rows) && rows.length, E('RANKING_INVALID'), 'ranking.rows');
  rows.forEach((row, index) => {
    need(isObject(row) && isText(row.block) && ['log', 'usd', 'g', 'share_of_gap'].every((key) => finite(row[key])) && row.rank === index + 1, E('RANKING_INVALID'), `ranking.rows[${index}]`);
    if (row.power !== undefined) need(isObject(row.power) && ['se', 'z', 'mde80'].every((key) => finite(row.power[key])) && isText(row.power.class_zh), E('RANKING_INVALID'), `ranking.rows[${index}].power`);
    if (index) need(rows[index - 1].log >= row.log, E('RANKING_INVALID'), `ranking.rows 不是按对数贡献从大到小（第 ${index + 1} 行）`);
  });
  const total = doc.decomposition && doc.decomposition.SPY;
  need(isObject(total) && finite(total.end_current_d) && finite(total.end_benchmark) && isObject(total.total) && finite(total.total.g)
    && isObject(total.total.power) && finite(total.total.power.se), E('RANKING_INVALID'), 'decomposition.SPY');
}

function validateWhole(doc) {
  const hit = verdictPath(doc);
  need(!hit, E('VERDICT_NOT_ALLOWED'), `${hit}：差距分解是描述，不出三态`);
  const identity = doc.identity;
  need(isObject(identity) && identity.schema === ENTRY.schema, E('RESULT_SCHEMA_UNSUPPORTED'), identity && identity.schema);
  need(identity.result_kind === ENTRY.result_kind && identity.record_type === ENTRY.record_type, E('RESULT_KIND_UNSUPPORTED'), `${identity.result_kind}/${identity.record_type}`);
  need(isObject(identity.k2) && identity.k2.sha256 === ENTRY.k2.sha256, E('K2_SHA_MISMATCH'), isObject(identity.k2) ? identity.k2.sha256 : null);
  need(isObject(identity.erratum) && identity.erratum.sha256 === ENTRY.erratum.sha256, E('ERRATUM_SHA_MISMATCH'), isObject(identity.erratum) ? identity.erratum.sha256 : null);
  need(isObject(identity.k2.freeze) && identity.k2.freeze.sha256 === ENTRY.freeze.sha256, E('FREEZE_SHA_MISMATCH'), isObject(identity.k2.freeze) ? identity.k2.freeze.sha256 : null);
  need(/^[0-9a-f]{40}$/.test(identity.smartflow_commit || ''), E('SMARTFLOW_COMMIT_MISSING'));

  for (const name of ENTRY.run_gates) {
    need(isObject(doc.gates) && isObject(doc.gates[name]) && doc.gates[name].state === 'PASSED', E('RUN_GATE_NOT_PASSED'), name);
  }
  for (const [name, item] of Object.entries(doc.gates)) {
    need(!isObject(item) || typeof item.state !== 'string' || item.state === 'PASSED', E('RUN_GATE_NOT_PASSED'), name);
  }
  const repro = doc.reproducibility;
  need(isObject(repro) && isText(repro.command) && Array.isArray(repro.runs) && repro.runs.length >= 2
    && repro.runs.every((run) => isObject(run) && SHA64.test(run.sha256 || '')) && new Set(repro.runs.map((run) => run.sha256)).size === 1
    && repro.identical === true, E('RESULT_NOT_REPRODUCED'));

  // ★5 (a)：样本外复用必须写明
  need(doc.oos_reuse === true, E('OOS_REUSE_MUST_BE_DECLARED'));
  need(isObject(doc.oos_reuse_detail) && doc.oos_reuse_detail.reason_code === ENTRY.oos_reuse.reason_code, E('OOS_REUSE_NOT_DECLARED'), ENTRY.oos_reuse.reason_code);
  need(isText(doc.oos_reuse_detail.reason_zh), E('OOS_REUSE_DETAIL_MISSING'));

  checkRanking(doc);
  checkAdmission(doc);
}

// ── 账本核对（基线、原版臂来源、引用的 Q1–Q5）──────────────────────────────────────

function checkBaseline(doc, caseRef) {
  const id = doc.identity.baseline_result_id;
  const lock = baseline.baselineFor(id);
  need(lock && lock.case_ref === caseRef, E('BASELINE_LOCK_NOT_FOUND'), id);
  const head = baseline.headLock(caseRef);
  need(head && head.result_id === id, E('BASELINE_NOT_CURRENT'), `${id} 已被 ${head ? head.result_id : '无'} 取代`);
  const sealed = isObject(doc.gates.INPUTS) && Array.isArray(doc.gates.INPUTS.sealed) ? doc.gates.INPUTS.sealed.find((item) => isObject(item) && item.result === 'Q0') : null;
  need(sealed && sealed.result_id === id && sealed.expect === lock.file_sha256, E('BASELINE_SHA256_MISMATCH'), `INPUTS 门里 Q0 的 sha256 与锁 ${id} 不同`);
  let q0;
  try { q0 = baseline.readSealed(lock.file_ref, { allowNonActual: true, topLevel: [] }); } catch (error) { fail(E('BASELINE_FILE_UNREADABLE'), `${id}:${error.code || error.message}`); }
  need(q0.sha256 === lock.file_sha256, E('BASELINE_FILE_DRIFTED'), id);
  return lock;
}

/**
 * 原版臂来源（K2「身份」：读法同 Q5 的 baseline_arm_ref，附录 3 第 2 节第 2–8 条）：引用的形状、锁存在、sha256 相符、是当前的锁、
 * 同一个 Q0 基线、文件可读未漂移；第 8 条「摘要逐项相同」在这里只有一项可比——分解里当前 D 的期末资本等于所引那一臂的期末资本。
 */
function checkBaseArmRef(doc, caseRef, q0Id) {
  const spec = ENTRY.base_arm;
  const ref = doc.identity.base_arm_ref;
  need(isObject(ref) && isText(ref.result_id) && ref.arm === spec.arm && SHA64.test(ref.sha256 || ''), E('BASE_ARM_REF_MISSING'), `identity.base_arm_ref 必须是 {result_id, arm: ${spec.arm}, sha256}`);
  const refLock = comparison.comparisonFor(ref.result_id);
  need(refLock && refLock.case_ref === caseRef && refLock.question_ref === spec.question_ref, E('BASE_ARM_REF_LOCK_NOT_FOUND'), ref.result_id);
  need(ref.sha256 === refLock.file_sha256, E('BASE_ARM_REF_SHA256_MISMATCH'), ref.result_id);
  const head = comparison.headLock(caseRef, spec.question_ref);
  need(head && head.result_id === ref.result_id, E('BASE_ARM_REF_NOT_CURRENT'), `${ref.result_id} 已被 ${head ? head.result_id : '无'} 取代`);
  need(refLock.baseline_result_id === q0Id, E('BASE_ARM_REF_BASELINE_DIFFERS'), `${refLock.baseline_result_id}≠${q0Id}`);
  let refDoc;
  try { refDoc = baseline.readSealed(refLock.file_ref, { allowNonActual: true, topLevel: ['identity', 'arms'] }); } catch (error) {
    fail(E('BASE_ARM_REF_FILE_UNREADABLE'), `${ref.result_id}:${error.code || error.message}`);
  }
  need(refDoc.sha256 === refLock.file_sha256, E('BASE_ARM_REF_FILE_DRIFTED'), ref.result_id);
  const arm = refDoc.doc.arms && refDoc.doc.arms[spec.arm];
  need(isObject(arm) && isObject(arm.summary) && finite(arm.summary.end_capital), E('BASE_ARM_MISSING'), `${ref.result_id}.arms.${spec.arm}`);
  const left = doc.decomposition.SPY.end_current_d;
  const right = arm.summary.end_capital;
  need(Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(right)), E('BASE_ARM_DIFFERS_FROM_REF'), `end_capital: ${left} ≠ ${right}`);
  return refLock;
}

/** K2「身份」cited_results：Q1–Q5 各一条，锁存在、是那一题、sha256 相符、是当前的锁；Q5 就是原版臂来源那把锁。 */
function checkCited(doc, caseRef) {
  const cited = doc.identity.cited_results;
  need(isObject(cited) && canonical(Object.keys(cited).sort()) === canonical([...ENTRY.cited]), E('CITED_RESULTS_INCOMPLETE'), isObject(cited) ? Object.keys(cited).join(',') : null);
  const ids = [];
  for (const question of ENTRY.cited) {
    const item = cited[question];
    need(isObject(item) && isText(item.result_id) && SHA64.test(item.sha256 || ''), E('CITED_RESULTS_INCOMPLETE'), question);
    const lock = comparison.comparisonFor(item.result_id);
    need(lock && lock.case_ref === caseRef && lock.question_ref === question, E('CITED_RESULT_LOCK_NOT_FOUND'), `${question}:${item.result_id}`);
    need(lock.file_sha256 === item.sha256, E('CITED_RESULT_SHA256_MISMATCH'), `${question}:${item.result_id}`);
    const head = comparison.headLock(caseRef, question);
    need(head && head.result_id === item.result_id, E('CITED_RESULT_NOT_CURRENT'), `${item.result_id} 已被 ${head ? head.result_id : '无'} 取代`);
    ids.push(item.result_id);
  }
  need(cited[ENTRY.base_arm.question_ref].result_id === doc.identity.base_arm_ref.result_id, E('CITED_RESULT_DIFFERS_FROM_BASE_ARM'), `${cited[ENTRY.base_arm.question_ref].result_id}≠${doc.identity.base_arm_ref.result_id}`);
  return ids;
}

/** 当前锁都还在、都是当前的（页面只报，不因此失败）。 */
function refsCurrent(lock) {
  const q5 = comparison.headLock(lock.case_ref, ENTRY.base_arm.question_ref);
  const cited = ENTRY.cited.every((question, index) => { const head = comparison.headLock(lock.case_ref, question); return head && head.result_id === lock.cited_result_ids[index]; });
  return Boolean(q5 && q5.result_id === lock.base_arm_ref.result_id && cited);
}

// ── 锁 ──────────────────────────────────────────────────────────────────────────

function locks(caseRef = null) {
  return read(LEDGER()).filter((row) => row.schema === ENTRY.lock_schema && (!caseRef || row.case_ref === caseRef));
}
function headLock(caseRef) {
  const rows = locks(caseRef);
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * 导入并锁定（命令行，完成权威）。同一文件重复导入是幂等重放；这个 case 已有另一份锁时拒绝（防挑最好一次），
 * 除非 `supersedes` 指向当前锁并给出 `defectRef` 与 `reason`（旧锁保留）。策略只能是登记项的 US_V5。
 */
function importGapDecomposition(file, {
  registeredBy, strategyRef = ENTRY.strategy_ref, caseRef = null, allowNonActual = false, supersedes = null, defectRef = null, reason = null, lockedAt = null,
} = {}) {
  authority(registeredBy);
  const profile = profiles.mustGet(strategyRef);
  need(profile.strategy_ref === ENTRY.strategy_ref, E('STRATEGY_NOT_REGISTERED'), strategyRef);
  caseRef = caseRef || profile.case_ref;
  const sealed = readSealed(file, { allowNonActual });
  const { doc } = sealed;
  validateWhole(doc);
  const baselineLock = checkBaseline(doc, caseRef);
  const refLock = checkBaseArmRef(doc, caseRef, baselineLock.result_id);
  const citedIds = checkCited(doc, caseRef);
  const resultId = `${ENTRY.id_prefix}-${sealed.sha256.slice(0, 16)}`;
  const head = headLock(caseRef);
  if (head && head.result_id === resultId) return { ...head, replayHit: true };
  if (head) {
    need(supersedes === head.result_id, E('ALREADY_LOCKED'), head.result_id);
    need(defectRef && reason, E('SUPERSEDE_REQUIRES_DEFECT_AND_REASON'));
  } else need(!supersedes, E('SUPERSEDE_TARGET_NOT_FOUND'), supersedes);
  const body = {
    schema: ENTRY.lock_schema, record_type: ENTRY.record_type, result_id: resultId, case_ref: caseRef, strategy_ref: profile.strategy_ref,
    baseline_result_id: baselineLock.result_id, base_arm_ref: { result_id: refLock.result_id, arm: ENTRY.base_arm.arm }, cited_result_ids: citedIds,
    oos_reuse: true, decision: doc.step2_admission.decision, file_ref: sealed.file, file_sha256: sealed.sha256, file_size: sealed.size,
    smartflow_commit: doc.identity.smartflow_commit, k2_ref: ENTRY.k2.ref, k2_sha256: ENTRY.k2.sha256, import_profile_id: ENTRY.import_profile_id,
    supersedes_ref: supersedes, defect_ref: defectRef, supersede_reason: reason, production_effect: 'NONE', locked_by: registeredBy,
    locked_at: lockedAt || now(),
  };
  body.lock_hash = sha256(canonical(body));
  return append(LEDGER(), body);
}

// ── 页面投影 ────────────────────────────────────────────────────────────────────

const POWER_ZH = (row) => (row.power ? [plain(row.power.se), plain(row.power.z, 2), plain(row.power.mde80), row.power.class_zh] : ['—', '—', '—', '—']);
const IS_ZH = (row) => `${signed(row.is_g)} · ${row.is_same_sign === true ? '同号' : row.is_same_sign === false ? '不同号' : '—'}`;

function rankingSection(doc) {
  const rows = doc.ranking.rows.map((row) => [row.block, row.name_zh || '', signed(row.g), money(row.usd), share(row.share_of_gap), ...POWER_ZH(row), IS_ZH(row)]);
  const split = (Array.isArray(doc.ranking.a_split_rows) ? doc.ranking.a_split_rows : []).filter(isObject)
    .map((row) => [row.block, row.name_zh || '', signed(row.g), money(row.usd), share(row.share_of_gap), ...POWER_ZH(row), IS_ZH(row)]);
  return {
    key: 'ranking', title_zh: '排名表（对 SPY 总收益，对数口径，从大到小；正数 = 基准在这一块领先）',
    columns_zh: ['块', '说明', '年化 g', 'USD', '占差距', 'SE', 'z', 'MDE80（功效）', '可检测性', 'IS g（同号）'],
    rows, split_title_zh: 'A 内部切分（描述）', split_rows: split,
    note_zh: '各块相加等于总差距；这是会计恒等式，不是因果，不出三态。',
  };
}

function powerSection(doc) {
  const p = doc.power;
  need(isObject(p) && isObject(p.vs_spy_visibility) && isObject(p.per_trade), 'INVALID', 'power');
  const v = p.vs_spy_visibility; const t = p.per_trade;
  const lines = [
    `账户层面「跑过 SPY」：总差距 SE ${plain(v.se_total)}，要在 95% 上看见需年化 g 差 ≥ MDE80 ${plain(v.mde80)}（80% 功效）/ MDE50 ${plain(v.mde50)}（50% 功效）。`,
    `每笔层面：${count(t.n)} 笔，净 R 标准差 ${plain(t.sd_R, 2)}，MDE80 ${plain(t.mde80_R)} R、MDE50 ${plain(t.mde50_R)} R；检测 +0.10 R 约需 ${count(t.n_for_0_10R_80)} 笔（80%）/ ${count(t.n_for_0_10R_50)} 笔（50%）。`,
    '各块的 MDE80 与可检测性见排名表的功效列。',
  ];
  if (isText(p.optimistic_note_zh)) lines.push(p.optimistic_note_zh);
  return { key: 'power', title_zh: '功效', lines_zh: lines };
}

function admissionSection(doc) {
  const s = doc.step2_admission;
  const menu = s.menu['M-1'];
  const group = `${s.group.blocks.join('+')}`;
  const row = (label, g, se, z, gIs, checks) => [label, signed(g), plain(se), plain(z, 2), signed(gIs), yes(checks.positive), yes(checks.significant), yes(checks.is_same_sign), checks.admitted ? '准入' : '不准入'];
  const sens = s.sensitivity_reversed_convention;
  const rows = [
    row(`${group} · 按 1.96`, s.group.g, s.group.se, s.group.z, s.group.g_is, s.checks_1_96),
    row(`${group} · 按 2.80`, s.group.g, s.group.se, s.group.z, s.group.g_is, s.checks_2_80),
    row('反过来的约定（★3 (a) 敏感性，不参与准入）· 按 1.96', sens.g, sens.se, sens.z, sens.g_is, sens.checks_1_96),
  ];
  const decision = s.decision === 'CANDIDATE' ? `第 2 步候选：${s.candidate}（按 1.96 准入）` : `第 2 步无候选${isText(s.no_candidate_text_zh) ? `：${s.no_candidate_text_zh}` : ''}`;
  const gaps = s.research_gaps.length ? `研究缺口：${s.research_gaps.map((item) => `${item.block}（z ${plain(item.z, 2)}）`).join('、')}，交协调会话另起 K2` : '研究缺口：无';
  return {
    key: 'admission', title_zh: `第 2 步准入（块组 ${group}：M-1 ${menu.name_zh}；§6 机械判定）`,
    columns_zh: ['读法', 'g', 'SE', 'z', 'IS g', 'g > 0', '≥ 门槛 × SE', 'IS 同号', '准入'],
    rows, decision_zh: `${decision}；${s.decision_2_80_zh || ''}`.replace(/；$/, ''), lines_zh: [gaps, isText(sens.note_zh) ? sens.note_zh : null].filter(Boolean),
    rule_ref_zh: s.rule_ref || null,
  };
}

function project(sealed, lock) {
  const { doc } = sealed;
  validateWhole(doc);
  const spy = doc.decomposition.SPY;
  const oos = doc.window && doc.window.oos;
  const sections = [rankingSection(doc), powerSection(doc), admissionSection(doc)];
  const head = baseline.headLock(lock.case_ref);
  return {
    state: 'LOCKED_VERIFIED', reason: null, record_type: ENTRY.record_type, result_id: lock.result_id, title_zh: ENTRY.title_zh,
    tag_zh: '描述，不是结论：不出三态，不进采用一览',
    lead_zh: `当前 D（D+A25+T3）对 SPY 总收益：样本外 ${oos ? `${oos.from} → ${oos.to}（${count(oos.intervals)} 个日区间）` : ''}年化 g 差 ${signed(spy.total.g)}（SE ${plain(spy.total.power.se)}），期末 ${moneyPlain(spy.end_current_d)} 对 ${moneyPlain(spy.end_benchmark)} USD。正数 = 基准领先。`,
    oos_note_zh: `样本外已复用（oos_reuse: true，${doc.oos_reuse_detail.reason_code}）：${doc.oos_reuse_detail.reason_zh}`,
    sections, admission: sections[2],
    baseline_current: Boolean(head && head.result_id === lock.baseline_result_id), refs_current: refsCurrent(lock),
    source: {
      result_id: lock.result_id, file_ref: sealed.file, file_sha256: sealed.sha256, locked_at: lock.locked_at, locked_by: lock.locked_by,
      baseline_result_id: lock.baseline_result_id, base_arm_ref: `${lock.base_arm_ref.result_id} · ${lock.base_arm_ref.arm}`, cited_result_ids: lock.cited_result_ids,
      k2: `${ENTRY.k2.ref} ${ENTRY.k2.sha256}`, erratum: `${ENTRY.erratum.ref} ${ENTRY.erratum.sha256}`, freeze_sha256: ENTRY.freeze.sha256,
      smartflow_commit: lock.smartflow_commit, import_profile_id: lock.import_profile_id,
    },
    production_effect: 'NONE',
  };
}

function invalidProjection(lock, state, error) {
  return {
    state, reason: `封存结果校验未通过：${reasonText(error)}`, reason_code: error.code || 'UNKNOWN', record_type: ENTRY.record_type,
    result_id: lock.result_id, title_zh: ENTRY.title_zh, production_effect: 'NONE',
  };
}

function buildProjection(lock, { allowNonActual = false } = {}) {
  try {
    const sealed = readSealed(lock.file_ref, { allowNonActual });
    if (sealed.sha256 !== lock.file_sha256) fail(E('RESULT_DRIFTED_AFTER_LOCK'), `${lock.file_sha256.slice(0, 12)}…≠${sealed.sha256.slice(0, 12)}…`);
    return project(sealed, lock);
  } catch (error) {
    const missing = error instanceof K3Error && /MISSING/.test(error.code);
    return invalidProjection(lock, missing ? 'MISSING' : 'INVALID', error);
  }
}

const CACHE = new Map();
const statKey = (file) => { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch (error) { return `ERR:${error.code}`; } };

/** 这个 case 的差距分解卡（只有已导入时才有；最多一张：当前锁）。每次读都现场复验文件 sha256。 */
function readProjections(caseRef) {
  const lock = headLock(caseRef);
  if (!lock) return [];
  const q0Head = baseline.headLock(caseRef);
  const stamp = [lock.lock_hash, statKey(lock.file_ref), statKey(`${lock.file_ref}.sha256`), q0Head ? q0Head.lock_hash : 'NO_BASELINE',
    ...ENTRY.cited.map((question) => { const head = comparison.headLock(caseRef, question); return head ? head.lock_hash || head.result_id : 'NONE'; })].join('|');
  const hit = CACHE.get(caseRef);
  if (hit && hit.stamp === stamp) return [hit.result];
  const result = buildProjection(lock, { allowNonActual: true });
  CACHE.set(caseRef, { stamp, result });
  return [result];
}

const clearCache = () => CACHE.clear();

module.exports = {
  ENTRY, LEDGER, IMPORT_PROFILE_ID, readSealed, validateWhole, importGapDecomposition, locks, headLock, buildProjection, readProjections, clearCache,
  internals: { signed, plain, money, moneyPlain, share, count, verdictPath },
};
