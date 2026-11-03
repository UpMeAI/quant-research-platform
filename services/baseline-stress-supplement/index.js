'use strict';

/**
 * Q0 压力补充记录 `BASELINE_STRESS_SUPPLEMENT_V1`（US_V5_M2_Q0_RESULT_V1 导入规格增补 1 第 2 部分）。
 *
 * 规则出处：冻结的 2020 压力补充 K2（docs/contracts/US_V5_M2_Q0_STRESS_SUPPLEMENT_2020_K2_V1.md，cc945872…）「结果文件」与
 * 「QRP 需要的」两节、协调会话 US_V5_M2_R2_K2_FREEZE_1（5501741d…）：路线 (d) 附条件批准，★3–★5 按推荐，`oos_reuse: false`。
 *
 * 研究会话把 Q0 压力表里一行「无效输入 / 缺场景」另行补跑并封存 `US_V5_M2_Q0_STRESS_SUPPLEMENT_V1`。QRP 只读导入：
 *   1. `importStressSupplement`（命令行，完成权威）只做核对、不重算，追加一条 `BASELINE_STRESS_SUPPLEMENT_LOCK_V1`，
 *      result_id = `Q0S-<文件 sha256 前 16 位>`；同一 (Q0 基线, 场景) 只能有一条，改锁同 Q0 走 supersedes + 缺陷 + 原因；
 *   2. `readProjections` + `attach`（页面）每次现场复验文件 sha256，把补充挂在 Q0 卡片压力表那一行下面：
 *      「补充（另行封存，Q0S-…）：…」一行，再一行灰字「当前 D（D+A25+T3）参照：…」。
 *
 * 不重封 Q0：Q0 的锁、文件、三态结论、页面主数字（最大损失）、「已执行 N 个压力场景」的计数、压力结论与采用条件都只按 Q0 文件算；
 * 压力评价那一行后面只加一句「2020 区间另有补充，见压力表」。参照行只显示，不进任何锁的计数。没有 HTTP 写入口。
 */
const fs = require('fs');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const baseline = require('../baseline-evaluation');
const comparison = require('../candidate-comparison');
const profiles = require('../strategy-profiles');

const { K3Error, fail, need, isObject, sha256, canonical, authority, reasonText, hasNoSeries } = baseline.internals;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const SHA64 = /^[0-9a-f]{64}$/;

const IMPORT_PROFILE_ID = 'docs/contracts/US_V5_M2_Q0_RESULT_V1_IMPORT_PROFILE_ADDENDUM_1.md';

/** 登记项（增补 1 §2.1）：只有 US_V5 有这一类记录。 */
const ENTRY = Object.freeze({
  record_type: 'BASELINE_STRESS_SUPPLEMENT_V1', lock_schema: 'BASELINE_STRESS_SUPPLEMENT_LOCK_V1', id_prefix: 'Q0S',
  strategy_ref: 'US_V5_ETF_3000USD',
  schema: 'US_V5_M2_Q0_STRESS_SUPPLEMENT_V1', result_kind: 'BASELINE_STRESS_SUPPLEMENT',
  k2: Object.freeze({ ref: 'docs/contracts/US_V5_M2_Q0_STRESS_SUPPLEMENT_2020_K2_V1.md', sha256: 'cc945872a4210a7ec524a727dc186e2e29051d9200e8a2cf949076ac5645c59a' }),
  freeze: Object.freeze({ ref: 'artifacts/coordinator/US_V5_M2_R2_K2_FREEZE_1.md（不在 git 里，按 sha256 绑定）', sha256: '5501741d93de625685fda2013deb560c71227c5100c7d8da50647ea351bc46ba' }),
  import_profile_id: IMPORT_PROFILE_ID,
  report_ref: 'smartflow trading-system-v2/docs/US_V5_M2_Q0_STRESS_SUPPLEMENT_V1.md',
  top_level: Object.freeze(['identity', 'inputs', 'gates', 'row', 'reference_rows', 'q0_row_before', 'oos_reuse', 'window_history_zh', 'reproducibility']),
  // K2 运行门（结果报告第 2 节，11 个）
  run_gates: Object.freeze(['ACCEPTANCE', 'INPUTS', 'ATTEST_DATES_ONLY', 'ATTEST_OVERLAP', 'ATTEST_COUNT', 'ENGINE_INERT', 'OPTION_INERT_2022', 'FLOOR_VALID', 'SIGNALS_UNCHANGED', 'REPRO', 'MEM']),
  // FREEZE 1：路线 (d) 批准；协调会话已裁定 2008 不可补
  input_routes: Object.freeze(['FLOOR_ATTESTATION_LOCAL_DAILY']),
  not_fillable: Object.freeze(['EXTREME_DOWNTURN_2008']),
  // ★5 (a)：当前 D 参照行 = Q5 的候选臂
  reference_ref: Object.freeze({ question_ref: 'Q5', arm: 'CANDIDATE_T3_ON_A25' }),
  supplement_note_zh: '2020 区间另有补充，见压力表',
});

const LEDGER = () => path.join(dataDir('research'), 'baseline_stress_supplements.jsonl');
const E = (code) => `SUPPLEMENT_${code}`;

// ── 数字排版（只排版，不重算）────────────────────────────────────────────────────

const minus = (value) => (value < 0 ? '−' : '');
const usd2 = (value) => `${minus(value)}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct2 = (value) => `${minus(value)}${Math.abs(value).toFixed(2)}%`;

// ── 封存文件 ────────────────────────────────────────────────────────────────────

function readSealed(file, { allowNonActual = false } = {}) {
  try { return baseline.readSealed(file, { allowNonActual, topLevel: ENTRY.top_level }); } catch (error) {
    if (error instanceof K3Error && /^Q0_RESULT_/.test(error.code)) throw new K3Error(error.code.replace(/^Q0_RESULT_/, 'SUPPLEMENT_RESULT_'), error.detail);
    throw error;
  }
}

/** 压力行的数字（与 Q0 stress.rows 同形；补充行与参照行都必须是真实跑出的数）。 */
function checkRow(row, scenario, where, code) {
  need(isObject(row) && row.scenario === scenario, code, `${where}.scenario 必须是 ${scenario}`);
  need(['max_loss_usd', 'longest_underwater_sessions', 'end_capital'].every((key) => finite(row[key])) && typeof row.recovered === 'boolean'
    && Number.isInteger(row.n), code, `${where} 的最大亏损、最长水下、期末、是否回到水上、笔数必须是数`);
}

// ── 整文件一致性（失败关闭；不读账本）─────────────────────────────────────────────

function validateWhole(doc) {
  need(doc.verdict === undefined && !(isObject(doc.row) && doc.row.verdict !== undefined), E('VERDICT_NOT_ALLOWED'), '压力补充只描述损失，不出三态');
  const identity = doc.identity;
  need(isObject(identity) && identity.schema === ENTRY.schema, E('RESULT_SCHEMA_UNSUPPORTED'), identity && identity.schema);
  need(identity.result_kind === ENTRY.result_kind && identity.record_type === ENTRY.record_type, E('RESULT_KIND_UNSUPPORTED'), `${identity.result_kind}/${identity.record_type}`);
  need(isObject(identity.k2) && identity.k2.sha256 === ENTRY.k2.sha256, E('K2_SHA_MISMATCH'), isObject(identity.k2) ? identity.k2.sha256 : null);
  need(isObject(identity.k2.freeze) && identity.k2.freeze.sha256 === ENTRY.freeze.sha256, E('FREEZE_SHA_MISMATCH'), isObject(identity.k2.freeze) ? identity.k2.freeze.sha256 : null);
  need(/^[0-9a-f]{40}$/.test(identity.smartflow_commit || ''), E('SMARTFLOW_COMMIT_MISSING'));
  need(isText(identity.baseline_result_id) && SHA64.test(identity.baseline_sha256 || ''), E('BASELINE_MISMATCH'), 'identity.baseline_result_id / baseline_sha256');
  need(isText(identity.scenario), E('ROW_INVALID'), 'identity.scenario');
  need(!ENTRY.not_fillable.includes(identity.scenario), 'SCENARIO_NOT_FILLABLE', `${identity.scenario}：协调会话已裁定不可补`);
  need(ENTRY.input_routes.includes(identity.input_route), E('INPUT_ROUTE_NOT_FROZEN'), identity.input_route);
  need(isObject(identity.floor_attestation) && isText(identity.floor_attestation.file) && SHA64.test(identity.floor_attestation.sha256 || ''), E('INPUT_ROUTE_NOT_FROZEN'), 'identity.floor_attestation {file, sha256}');

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

  // 窗口此前从未被任何臂交易过（FREEZE 1）：oos_reuse 必须是 false，另写窗口历史
  need(doc.oos_reuse === false, E('OOS_REUSE_MUST_BE_FALSE'));
  need(isText(doc.window_history_zh), E('WINDOW_HISTORY_MISSING'));

  need(isObject(doc.row) && doc.row.simulated === false, E('ROW_SIMULATED'), '补充行必须是真实历史回放（simulated: false）');
  checkRow(doc.row, identity.scenario, 'row', E('ROW_INVALID'));
  need(Array.isArray(doc.reference_rows) && doc.reference_rows.length >= 1, E('REFERENCE_INVALID'), 'reference_rows');
  doc.reference_rows.forEach((row, index) => {
    const where = `reference_rows[${index}]`;
    checkRow(row, identity.scenario, where, E('REFERENCE_INVALID'));
    need(row.simulated === false && isObject(row.ref) && isText(row.ref.result_id) && row.ref.arm === ENTRY.reference_ref.arm, E('REFERENCE_INVALID'),
      `${where}.ref 必须是 {result_id, arm: ${ENTRY.reference_ref.arm}}`);
    need(row.in_any_lock === false, E('REFERENCE_IN_LOCK'), `${where}：参照行只显示，不进任何锁`);
  });
  need(isObject(doc.q0_row_before), E('Q0_ROW_BEFORE_DIFFERS'), 'q0_row_before');
}

// ── 账本核对（Q0 基线、Q0 的那一行、参照行所引的锁）────────────────────────────────

function checkAgainstLedger(doc, caseRef) {
  const { identity } = doc;
  const lock = baseline.baselineFor(identity.baseline_result_id);
  need(lock && lock.case_ref === caseRef && lock.file_sha256 === identity.baseline_sha256, E('BASELINE_MISMATCH'),
    `${identity.baseline_result_id} 不是现有的 Q0 锁，或 sha256 与锁记录不同`);
  const head = baseline.headLock(caseRef);
  need(head && head.result_id === lock.result_id, E('BASELINE_NOT_CURRENT'), `${lock.result_id} 已被 ${head ? head.result_id : '无'} 取代`);
  let q0;
  try { q0 = baseline.readSealed(lock.file_ref, { allowNonActual: true, topLevel: ['stress'] }); } catch (error) { fail(E('BASELINE_FILE_UNREADABLE'), `${lock.result_id}:${error.code || error.message}`); }
  need(q0.sha256 === lock.file_sha256, E('BASELINE_FILE_DRIFTED'), lock.result_id);
  const rows = Array.isArray(q0.doc.stress.rows) ? q0.doc.stress.rows : [];
  const same = rows.filter((row) => isObject(row) && row.scenario === identity.scenario);
  need(same.length === 1 && hasNoSeries(same[0]), E('SCENARIO_NOT_A_GAP_ROW'), `${identity.scenario} 在 Q0 文件里不是唯一一行「无效输入 / 缺场景」`);
  need(canonical(doc.q0_row_before) === canonical(same[0]), E('Q0_ROW_BEFORE_DIFFERS'), identity.scenario);
  for (const [index, row] of doc.reference_rows.entries()) {
    const ref = comparison.comparisonFor(row.ref.result_id);
    need(ref && ref.case_ref === caseRef && ref.question_ref === ENTRY.reference_ref.question_ref, E('REFERENCE_REF_NOT_FOUND'), `reference_rows[${index}].ref:${row.ref.result_id}`);
  }
  return lock;
}

// ── 锁 ──────────────────────────────────────────────────────────────────────────

function locks(caseRef = null) {
  return read(LEDGER()).filter((row) => row.schema === ENTRY.lock_schema && (!caseRef || row.case_ref === caseRef));
}
/** 同一 (Q0 基线, 场景) 的当前锁。 */
function headLock(caseRef, baselineResultId, scenario) {
  const rows = locks(caseRef).filter((row) => row.baseline_result_id === baselineResultId && row.scenario === scenario);
  return rows.length ? rows[rows.length - 1] : null;
}
/** 每个 (Q0 基线, 场景) 一条当前锁，按首次导入的先后。 */
function headLocks(caseRef) {
  const heads = new Map();
  for (const row of locks(caseRef)) heads.set(`${row.baseline_result_id}|${row.scenario}`, row);
  return [...heads.values()];
}

/**
 * 导入并锁定（命令行，完成权威）。只做核对，不重算；只追加，不改 Q0 的锁。同一文件重复导入是幂等重放；
 * 同一 (基线, 场景) 已有另一条时拒绝，改锁须 `supersedes` 指向当前锁并给出 `defectRef` 与 `reason`（旧锁保留）。
 */
function importStressSupplement(file, {
  registeredBy, strategyRef = ENTRY.strategy_ref, caseRef = null, allowNonActual = false, supersedes = null, defectRef = null, reason = null, lockedAt = null,
} = {}) {
  authority(registeredBy);
  const profile = profiles.mustGet(strategyRef);
  need(profile.strategy_ref === ENTRY.strategy_ref, E('STRATEGY_NOT_REGISTERED'), strategyRef);
  caseRef = caseRef || profile.case_ref;
  const sealed = readSealed(file, { allowNonActual });
  const { doc } = sealed;
  validateWhole(doc);
  const baselineLock = checkAgainstLedger(doc, caseRef);
  const resultId = `${ENTRY.id_prefix}-${sealed.sha256.slice(0, 16)}`;
  const head = headLock(caseRef, baselineLock.result_id, doc.identity.scenario);
  if (head && head.result_id === resultId) return { ...head, replayHit: true };
  if (head) {
    need(supersedes === head.result_id, E('ALREADY_LOCKED'), head.result_id);
    need(defectRef && reason, E('SUPERSEDE_REQUIRES_DEFECT_AND_REASON'));
  } else need(!supersedes, E('SUPERSEDE_TARGET_NOT_FOUND'), supersedes);
  const body = {
    schema: ENTRY.lock_schema, record_type: ENTRY.record_type, result_id: resultId, case_ref: caseRef, strategy_ref: profile.strategy_ref,
    baseline_result_id: baselineLock.result_id, scenario: doc.identity.scenario, input_route: doc.identity.input_route, oos_reuse: false,
    reference_result_ids: doc.reference_rows.map((row) => row.ref.result_id),
    file_ref: sealed.file, file_sha256: sealed.sha256, file_size: sealed.size, smartflow_commit: doc.identity.smartflow_commit,
    k2_ref: ENTRY.k2.ref, k2_sha256: ENTRY.k2.sha256, import_profile_id: ENTRY.import_profile_id,
    supersedes_ref: supersedes, defect_ref: defectRef, supersede_reason: reason, production_effect: 'NONE', locked_by: registeredBy,
    locked_at: lockedAt || now(),
  };
  body.lock_hash = sha256(canonical(body));
  return append(LEDGER(), body);
}

// ── 页面投影 ────────────────────────────────────────────────────────────────────

function project(sealed, lock) {
  const { doc } = sealed;
  validateWhole(doc);
  const r = doc.row;
  const spy = finite(r.spy_return_pct) ? `，区间内 SPY ${pct2(r.spy_return_pct)}` : '';
  return {
    state: 'LOCKED_VERIFIED', reason: null, record_type: ENTRY.record_type, result_id: lock.result_id, baseline_result_id: lock.baseline_result_id, scenario: lock.scenario,
    // K2「页面（★3 (a)）」的原句
    line_zh: `补充（另行封存，${lock.result_id}）：最大亏损 ${usd2(r.max_loss_usd)} USD，期末 ${usd2(r.end_capital)} USD，最长水下 ${r.longest_underwater_sessions} 个 session${spy}`,
    reference_lines_zh: doc.reference_rows.map((row) => `当前 D（D+A25+T3）参照：最大亏损 ${usd2(row.max_loss_usd)} USD，期末 ${usd2(row.end_capital)} USD，最长水下 ${row.longest_underwater_sessions} 个 session，${row.n} 笔；只报，不进 Q0、不进 Q5`),
    note_zh: '另行封存的补充：只描述损失，不出三态，不进最大损失与压力计数',
    window_history_zh: doc.window_history_zh,
    source: {
      result_id: lock.result_id, file_sha256: sealed.sha256, locked_at: lock.locked_at, baseline_result_id: lock.baseline_result_id,
      input_route: lock.input_route, k2: `${ENTRY.k2.ref} ${ENTRY.k2.sha256}`, freeze_sha256: ENTRY.freeze.sha256, report_ref: ENTRY.report_ref,
      import_profile_id: lock.import_profile_id,
    },
  };
}

function buildProjection(lock, { allowNonActual = true } = {}) {
  try {
    const sealed = readSealed(lock.file_ref, { allowNonActual });
    if (sealed.sha256 !== lock.file_sha256) fail(E('RESULT_DRIFTED_AFTER_LOCK'), `${lock.file_sha256.slice(0, 12)}…≠${sealed.sha256.slice(0, 12)}…`);
    return project(sealed, lock);
  } catch (error) {
    const missing = error instanceof K3Error && /MISSING/.test(error.code);
    return {
      state: missing ? 'MISSING' : 'INVALID', reason: reasonText(error), reason_code: error.code || 'UNKNOWN', record_type: ENTRY.record_type,
      result_id: lock.result_id, baseline_result_id: lock.baseline_result_id, scenario: lock.scenario,
      line_zh: `补充（另行封存，${lock.result_id}）：封存结果校验未通过（${reasonText(error)}）`, reference_lines_zh: [], note_zh: null,
    };
  }
}

const CACHE = new Map();
const statKey = (file) => { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch (error) { return `ERR:${error.code}`; } };

/** 这个 case 的补充（每个 (基线, 场景) 的当前锁一条）；每次读都现场复验文件 sha256。 */
function readProjections(caseRef) {
  return headLocks(caseRef).map((lock) => {
    const stamp = `${lock.lock_hash}|${statKey(lock.file_ref)}|${statKey(`${lock.file_ref}.sha256`)}`;
    const hit = CACHE.get(lock.result_id);
    if (hit && hit.stamp === stamp) return hit.result;
    const result = buildProjection(lock);
    CACHE.set(lock.result_id, { stamp, result });
    return result;
  });
}

/**
 * 把补充挂到 Q0 投影上（返回新对象，不改缓存里的 Q0 投影）。只挂基线就是这份 Q0 锁的补充；Q0 的主数字、计数、压力评价原样不动：
 *   - 压力块里场景相同的那一行多一个 `supplement`（补充行与参照行的句子）；
 *   - 有通过校验的补充时，压力块加 `supplement_note_zh`，结论的三行（completeness）加 `stress_supplement_zh`，页面接在压力评价那一行后面。
 * 没有补充时原样返回（投影形状不变）。
 */
function attach(projection, supplements) {
  if (!projection || projection.state !== 'LOCKED_VERIFIED' || !Array.isArray(supplements)) return projection;
  const mine = supplements.filter((item) => item.baseline_result_id === projection.result_id);
  if (!mine.length) return projection;
  const stress = (projection.blocks || []).find((block) => block.key === 'stress');
  if (!stress || stress.state !== 'AVAILABLE') return projection;
  const byScenario = new Map(mine.map((item) => [item.scenario, item]));
  const attached = stress.data.rows.filter((row) => byScenario.has(row.scenario));
  if (!attached.length) return projection;
  const verified = attached.some((row) => byScenario.get(row.scenario).state === 'LOCKED_VERIFIED');
  const data = {
    ...stress.data,
    rows: stress.data.rows.map((row) => (byScenario.has(row.scenario) ? { ...row, supplement: byScenario.get(row.scenario) } : row)),
    ...(verified ? { supplement_note_zh: ENTRY.supplement_note_zh } : {}),
  };
  const blocks = projection.blocks.map((block) => (block === stress ? { ...block, data } : block));
  const conclusion = verified && projection.conclusion && projection.conclusion.completeness && !projection.conclusion.completeness.complete
    ? { ...projection.conclusion, completeness: { ...projection.conclusion.completeness, stress_supplement_zh: ENTRY.supplement_note_zh } } : projection.conclusion;
  return { ...projection, blocks, conclusion };
}

const clearCache = () => CACHE.clear();

module.exports = {
  ENTRY, LEDGER, IMPORT_PROFILE_ID, readSealed, validateWhole, importStressSupplement, locks, headLock, headLocks, buildProjection, readProjections, attach, clearCache,
};
