'use strict';

/**
 * K3 的候选对比类别：外部封存的「原版对候选」比较（US_V5 M2 Q1、Q2……）进入 QRP 的位置。
 *
 * 与 Q0 基线评价（services/baseline-evaluation）同一套封存纪律：研究会话在 Mac 上产出
 * `US_V5_M2_Q<n>_RESULT_V1`（一个 JSON 加旁边的 sha256 文件），QRP 只读导入——
 *   1. `importCandidateComparison`（命令行，完成权威）校验封存文件，并追加一条
 *      `COMPARISON_EVALUATION_LOCK_V1`：Result Lock 的 `CANDIDATE_COMPARISON_V1` 类别
 *      （SUPPORTED / NOT_PASSED / INSUFFICIENT），引用一份已存在且是当前的 Q0 基线锁；
 *   2. `readProjection(s)`（页面）每次现场复验文件 sha256，再投影成「研究与对比」里每题一张的卡。
 *
 * 题目之间不同的东西（K2 引用、候选臂键、判据集与必填常数、样本外期望、是否要归因块）都在 registry.js 登记，
 * 本文件只有与题目无关的引擎。Q1 的登记项逐项复现改造前的写死行为（同一份真实文件得到同一个 result_id 和同一份投影）。
 *
 * 不重算业务数字：这里只做封存校验、一致性校验和人话标签；只拒绝「标签比证据强」「证据链断了」
 * 「把前向并入结论」「把复用的样本外说成独立」。没有 HTTP 写入口，不用交易凭证，不写生产参数或账本。
 * 规则出处：docs/contracts/US_V5_M2_Q1_RESULT_V1_IMPORT_PROFILE.md（Q1，已冻结）与
 * docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2.md（按题目登记、Q2 登记项）。
 *
 * 题目按策略分组：锁上的 case_ref／strategy_ref 与比较对象都取自策略档案（services/strategy-profiles），
 * 一题属于哪条策略见 registry.js。未登记的 strategy_ref 导入时直接拒绝、页面上失败关闭。
 */
const fs = require('fs');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const profiles = require('../strategy-profiles');
const registry = require('./registry');
const {
  baseline, K3Error, fail, need, isObject, sha256, canonical, authority, reasonText, digests, stressRole, hasNoSeries,
  BASE_KEYS, SUMMARY_KEYS, E, pick, edgeLabel, criteriaOf, baselineIdOf, forwardRows, incompleteStressScenarios,
  stressBlock, accountBlock, forwardBlock, linesOf,
} = require('./common');
const { DELTA_STAR, DELTA_G, MIN_AFFECTED, MIN_BLOCKS, K2_REF, K2_SHA256, OOS_REUSE_LABEL } = require('./questions/q1');

const EVAL_CLASS = 'CANDIDATE_COMPARISON_V1';
const CASE_REF = baseline.CASE_REF;
const STRATEGY_REF = baseline.STRATEGY_REF;
const STATES = baseline.STATES;
const DEFAULT_ENTRY = registry.get(registry.DEFAULT_QUESTION);
// 改造前的导出（Q1 的常量），保持不变
const { schema: RESULT_SCHEMA, question_ref: QUESTION_REF, top_level: TOP_LEVEL, run_gates: RUN_GATES, blocks: BLOCKS } = DEFAULT_ENTRY;

const LEDGER = () => path.join(dataDir('research'), 'comparison_evaluations.jsonl');

// ── 封存文件 ────────────────────────────────────────────────────────────────────

/** 只为错误码起名字：不验证内容，读不出来就当默认题。 */
function sniffEntry(file, bySchema) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return bySchema(raw && raw.identity && raw.identity.schema);
  } catch { return null; }
}

/**
 * 与 Q0 同一套封存读取；错误码前缀由 `Q0_RESULT_` 换成 `<题目>_RESULT_`。
 * 题目由 `options.question` 指定，否则按 `identity.schema` 判断；认不出的 schema 当默认题，
 * 由整文件校验报 `Q1_RESULT_SCHEMA_UNSUPPORTED`（改造前的行为）。
 * `options.program` 是某条策略的题组（registry.forStrategy）：给了就只在这组题里找；没给时 `question` 按默认题组、schema 按全部登记题目找。
 */
function readSealed(file, options = {}) {
  const program = options.program || null;
  const getQuestion = program ? program.get : registry.get;
  const bySchema = program ? program.bySchema : registry.entryBySchema;
  const hinted = options.question ? getQuestion(options.question) : null;
  need(!options.question || hinted, 'COMPARISON_QUESTION_NOT_REGISTERED', options.question);
  const rename = (error, entry) => {
    if (error instanceof K3Error && /^Q0_RESULT_/.test(error.code)) return new K3Error(error.code.replace(/^Q0_RESULT_/, `${entry.code_prefix}_RESULT_`), error.detail);
    return error;
  };
  let sealed;
  try { sealed = baseline.readSealed(file, { allowNonActual: options.allowNonActual, topLevel: ['identity'] }); } catch (error) {
    throw rename(error, hinted || sniffEntry(file, bySchema) || DEFAULT_ENTRY);
  }
  const entry = hinted || bySchema(sealed.doc.identity && sealed.doc.identity.schema) || DEFAULT_ENTRY;
  // 显式指定了题目而文件是别的题目的：先报 schema 不符，不要报一串别的题目的顶层字段缺失
  if (hinted && sealed.doc.identity && sealed.doc.identity.schema !== hinted.schema) fail(E(hinted, 'RESULT_SCHEMA_UNSUPPORTED'), sealed.doc.identity.schema);
  const missing = entry.top_level.filter((key) => sealed.doc[key] === undefined || sealed.doc[key] === null);
  need(!missing.length, E(entry, 'RESULT_TOP_LEVEL_MISSING'), missing.join(','));
  return { ...sealed, entry };
}

// ── 整文件一致性（失败关闭）──────────────────────────────────────────────────────

const detailPresent = (detail) => (typeof detail === 'string' ? Boolean(detail.trim())
  : isObject(detail) && Object.values(detail).some((value) => typeof value === 'string' && value.trim()));

function validateWhole(entry, doc) {
  const repro = doc.reproducibility;
  need(isObject(repro) && typeof repro.command === 'string' && repro.command && Array.isArray(repro.runs)
    && repro.runs.length >= 2 && repro.runs.every((run) => isObject(run) && /^[0-9a-f]{64}$/.test(run.sha256 || ''))
    && new Set(repro.runs.map((run) => run.sha256)).size === 1 && repro.identical === true,
  E(entry, 'RESULT_NOT_REPRODUCED'));

  const identity = doc.identity;
  need(isObject(identity) && identity.schema === entry.schema, E(entry, 'RESULT_SCHEMA_UNSUPPORTED'), identity && identity.schema);
  need(identity.result_kind === 'CHALLENGER_VS_BASELINE', E(entry, 'RESULT_KIND_UNSUPPORTED'), identity.result_kind);
  const k2sha = isObject(identity.k2) ? identity.k2.sha256 : identity.k2_sha256;
  need(k2sha === entry.k2.sha256, E(entry, 'K2_SHA_MISMATCH'), k2sha);
  baselineIdOf(entry, doc);

  // 运行门任一不过，K2 规定是 BLOCKED、不出结论；所以带结论的文件里 K2 点名的运行门必须都在且 PASSED，
  // 文件里其他带 state 的门也不能是别的状态。
  for (const name of entry.run_gates) {
    need(isObject(doc.gates) && isObject(doc.gates[name]) && doc.gates[name].state === 'PASSED', E(entry, 'RUN_GATE_NOT_PASSED'), name);
  }
  for (const [name, gate] of Object.entries(doc.gates)) {
    need(!isObject(gate) || typeof gate.state !== 'string' || gate.state === 'PASSED', E(entry, 'RUN_GATE_NOT_PASSED'), name);
  }

  const verdict = doc.verdict;
  need(isObject(verdict) && verdict.class === EVAL_CLASS, E(entry, 'VERDICT_CLASS_UNSUPPORTED'), verdict && verdict.class);
  if (entry.mirror) need(verdict[entry.mirror.field] !== 'BLOCKED', E(entry, entry.mirror.blocked_code));
  need(STATES.includes(verdict.state), E(entry, 'VERDICT_STATE_UNSUPPORTED'), verdict.state);
  if (entry.mirror) {
    need(verdict[entry.mirror.field] === entry.mirror.map[verdict.state], E(entry, entry.mirror.mismatch_code), `${verdict.state}/${verdict[entry.mirror.field]}`);
  }
  entry.constants(entry, doc);
  const codes = Array.isArray(verdict.reason_codes) ? verdict.reason_codes : [];

  // AC5：样本外复用。Q1 的 K2 裁定 4 把它定为 true 且必须带原因码；Q2 是 false，带原因码反而矛盾，且要写理由。
  const oos = entry.oos_reuse;
  need(typeof doc.oos_reuse === 'boolean', E(entry, 'OOS_REUSE_MISSING'));
  if (oos.expected) {
    need(doc.oos_reuse === true, E(entry, 'OOS_REUSE_MUST_BE_DECLARED'));
    need(codes.includes(oos.reason_code), E(entry, 'OOS_REUSE_NOT_DECLARED'));
  } else {
    need(doc.oos_reuse === false, E(entry, 'OOS_REUSE_MUST_BE_FALSE'));
    need(!codes.includes(oos.reason_code), E(entry, 'OOS_REUSE_CONTRADICTS_CODE'));
    // Q3b：没有复用来选择，但同一规则已在同一窗口评价过——不当新样本外，必须带这个原因码（K2 裁定 4）
    if (oos.required_code) need(codes.includes(oos.required_code), E(entry, 'OOS_PREVIOUS_EVALUATION_NOT_DECLARED'), oos.required_code);
  }
  if (oos.detail_required) need(detailPresent(doc.oos_reuse_detail), E(entry, 'OOS_REUSE_DETAIL_MISSING'));

  // 前向只报不判，任何一行都不能进结论。
  const forward = forwardRows(doc);
  need(Array.isArray(forward), E(entry, 'FORWARD_ROWS_MISSING'));
  forward.forEach((row, index) => need(isObject(row) && row.in_verdict === false, E(entry, 'FORWARD_IN_VERDICT'), `rows[${index}]`));

  const flags = criteriaOf(entry, doc);
  entry.checkVerdict(entry, doc, flags);

  // 模拟场景标注（同 Q0）；缺场景行没有序列，不要求。
  const stressRows = isObject(doc.stress) && Array.isArray(doc.stress.rows) ? doc.stress.rows : [];
  for (const row of stressRows) {
    if (isObject(row) && !hasNoSeries(row) && /bear|熊|synthetic|模拟/i.test(`${row.scenario || ''}${row.label || ''}`)) {
      need(row.simulated === true, E(entry, 'STRESS_SIMULATED_NOT_FLAGGED'), row.scenario);
    }
  }
  // 压力不完整时，SUPPORTED 的文件必须自己写明，不能让「有支持证据」把它盖住（同 Q0 G3）。
  const incomplete = incompleteStressScenarios(entry, stressRows);
  if (verdict.state === 'SUPPORTED' && incomplete.length) {
    need(codes.includes('STRESS_SCENARIO_MISSING'), E(entry, 'VERDICT_SUPPORTED_HIDES_INCOMPLETE_STRESS'), incomplete.join(','));
  }
  if (entry.validateExtras) entry.validateExtras(entry, doc);
  return { incomplete };
}

// ── 区块（各自失败只影响自己）────────────────────────────────────────────────────

function buildBlocks(entry, doc) {
  const builders = {
    account: () => accountBlock(entry, doc), stress: () => stressBlock(entry, doc), forward: () => forwardBlock(doc),
    ...entry.builders(entry, doc),
  };
  return entry.blocks.map(([key, title]) => {
    try { return { key, title, state: 'AVAILABLE', reason: null, data: builders[key]() }; } catch (error) {
      return { key, title, state: 'NOT_COMPLETED', reason: reasonText(error), data: null };
    }
  });
}

// ── 投影 ────────────────────────────────────────────────────────────────────────

/** 主卡之后的独立卡片（登记项的 `extra_cards`，如 Q3 的随机选择对照）：自己的结论，各自失败只坏自己。 */
function buildExtraCards(entry, doc) {
  return entry.extra_cards.map((spec) => {
    try { return { key: spec.key, title_zh: spec.title_zh, state: 'AVAILABLE', reason: null, data: spec.build(entry, doc) }; } catch (error) {
      return { key: spec.key, title_zh: spec.title_zh, state: 'NOT_COMPLETED', reason: reasonText(error), data: null };
    }
  });
}

function project(sealed, lock) {
  const { doc, entry } = sealed;
  validateWhole(entry, doc);
  const blocks = buildBlocks(entry, doc);
  const verdict = blocks.find((block) => block.key === 'verdict');
  const completeness = linesOf(entry, blocks.find((block) => block.key === 'stress'), doc.verdict.state, doc.oos_reuse === true);
  if (verdict.state === 'AVAILABLE') verdict.data.completeness = completeness;
  const head = baseline.headLock(lock.case_ref);
  return {
    state: 'LOCKED_VERIFIED', reason: null, class: EVAL_CLASS, question_ref: lock.question_ref, title_zh: entry.title_zh, result_id: lock.result_id,
    verdict_state: doc.verdict.state, verdict_label: edgeLabel(entry, doc.verdict.state), blocks, completeness,
    ...(entry.extra_cards ? { extra_cards: buildExtraCards(entry, doc) } : {}),
    baseline: { result_id: lock.baseline_result_id, current: Boolean(head && head.result_id === lock.baseline_result_id) },
    source: {
      result_id: lock.result_id, file_ref: sealed.file, file_sha256: sealed.sha256, size: sealed.size, locked_at: lock.locked_at,
      locked_by: lock.locked_by, k2_ref: entry.k2.ref, profile_ref: entry.profile_ref, baseline_result_id: lock.baseline_result_id,
      inputs_digest: lock.inputs_digest, engine_digest: lock.engine_digest,
    },
    production_effect: 'NONE',
  };
}

const EMPTY_TEXT = '研究会话尚未交付封存的对比结果';

/** 没有结果、校验失败时的投影；`extra.question_ref` 指定是哪一题（默认 Q1）。 */
function emptyProjection(state, reason = EMPTY_TEXT, extra = {}) {
  const entry = registry.get(extra.question_ref) || DEFAULT_ENTRY;
  return {
    state, reason, class: EVAL_CLASS, question_ref: entry.question_ref, title_zh: entry.title_zh, result_id: null, verdict_state: null, verdict_label: null,
    blocks: entry.blocks.map(([key, title]) => ({ key, title, state: 'NOT_COMPLETED', reason, data: null })),
    completeness: null, baseline: null, source: null, production_effect: 'NONE', ...extra,
  };
}

// ── Result Lock（候选对比类别）─────────────────────────────────────────────────────

function locks(caseRef = null, questionRef = null) {
  return read(LEDGER()).filter((row) => (!caseRef || row.case_ref === caseRef) && (!questionRef || row.question_ref === questionRef));
}
const headLock = (caseRef = CASE_REF, questionRef = QUESTION_REF) => {
  const rows = locks(caseRef, questionRef);
  return rows.length ? rows[rows.length - 1] : null;
};
const comparisonFor = (resultId) => locks().find((row) => row.result_id === resultId) || null;

/** 引用的基线必须是已存在的、当前的 Q0 基线锁，且原版臂与 Q0 的 D 臂逐项相同（运行门 BASELINE_REPRO 的落地核对）。 */
function checkBaseline(entry, doc, caseRef) {
  const id = baselineIdOf(entry, doc);
  const lock = baseline.baselineFor(id);
  need(lock && lock.case_ref === caseRef, E(entry, 'BASELINE_LOCK_NOT_FOUND'), id);
  const declared = isObject(doc.identity.baseline) ? doc.identity.baseline.sha256 : null;
  need(declared === null || declared === undefined || declared === lock.file_sha256, E(entry, 'BASELINE_SHA256_MISMATCH'), id);
  const head = baseline.headLock(caseRef);
  need(head && head.result_id === id, E(entry, 'BASELINE_NOT_CURRENT'), `${id} 已被 ${head ? head.result_id : '无'} 取代`);
  let q0;
  try { q0 = baseline.readSealed(lock.file_ref, { allowNonActual: true }); } catch (error) { fail(E(entry, 'BASELINE_FILE_UNREADABLE'), `${id}:${error.code || error.message}`); }
  need(q0.sha256 === lock.file_sha256, E(entry, 'BASELINE_FILE_DRIFTED'), id);
  const comparisonBase = pick(doc.arms, BASE_KEYS);
  const q0Base = q0.doc.arms && q0.doc.arms.D;
  need(isObject(comparisonBase) && isObject(comparisonBase.summary) && isObject(q0Base) && isObject(q0Base.summary), E(entry, 'BASELINE_ARM_MISSING'));
  for (const key of SUMMARY_KEYS) {
    const left = comparisonBase.summary[key];
    const right = q0Base.summary[key];
    const same = typeof left === 'number' && typeof right === 'number' ? Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(right)) : left === right;
    need(same, E(entry, 'BASELINE_ARM_DIFFERS_FROM_Q0'), `${key}: ${left} ≠ ${right}`);
  }
  return lock;
}

/**
 * 导入并锁定。同一文件重复导入是幂等重放；同一题已有另一份锁定时拒绝（防挑最好一次），
 * 除非显式 `supersedes` 指向当前锁并给出 `defectRef` 与 `reason`（旧锁保留）。
 * 题目按 `identity.schema` 判断，`question` 可显式指定（与文件不符则拒绝）。
 * 策略档案：给了 `strategyRef` 就必须已登记（R3.1，未登记在读文件之前就拒绝，账本不写），且题目必须属于这条策略；
 * 没给时取这一题所属的策略。case 默认取档案的 case_ref。
 */
function importCandidateComparison(file, {
  registeredBy, strategyRef = null, question = null, caseRef = null, allowNonActual = false, supersedes = null, defectRef = null, reason = null, lockedAt = null,
} = {}) {
  authority(registeredBy);
  const pinned = strategyRef === null ? null : profiles.mustGet(strategyRef);
  const sealed = readSealed(file, { allowNonActual, question, program: pinned ? registry.forStrategy(pinned.strategy_ref) : null });
  const { entry } = sealed;
  const profile = pinned || registry.ownerOf(entry);
  need(profile, 'STRATEGY_PROFILE_NOT_REGISTERED', `${entry.question_ref}:${entry.profile_ref}`);
  need(registry.forStrategy(profile.strategy_ref).get(entry.question_ref) === entry, 'COMPARISON_QUESTION_NOT_REGISTERED', `${profile.strategy_ref}:${entry.question_ref}`);
  caseRef = caseRef || profile.case_ref;
  validateWhole(entry, sealed.doc);
  const baselineLock = checkBaseline(entry, sealed.doc, caseRef);
  const resultId = `${entry.question_ref}-${sealed.sha256.slice(0, 16)}`;
  const head = headLock(caseRef, entry.question_ref);
  if (head && head.result_id === resultId) return { ...head, replayHit: true };
  if (head) {
    need(supersedes === head.result_id, 'COMPARISON_ALREADY_LOCKED', head.result_id);
    need(defectRef && reason, 'COMPARISON_SUPERSEDE_REQUIRES_DEFECT_AND_REASON');
  } else need(!supersedes, 'COMPARISON_SUPERSEDE_TARGET_NOT_FOUND', supersedes);
  const core = {
    schema: 'COMPARISON_EVALUATION_LOCK_V1', result_id: resultId, case_ref: caseRef, strategy_ref: profile.strategy_ref, question_ref: entry.question_ref,
    eval_class: EVAL_CLASS, verdict_state: sealed.doc.verdict.state, t3_state: entry.mirror ? sealed.doc.verdict[entry.mirror.field] : null,
    baseline_result_id: baselineLock.result_id, oos_reuse: sealed.doc.oos_reuse === true,
    file_ref: sealed.file, file_sha256: sealed.sha256, file_size: sealed.size, ...digests(sealed.doc),
    k2_ref: entry.k2.ref, profile_ref: entry.profile_ref, supersedes_ref: supersedes, defect_ref: defectRef, supersede_reason: reason,
    production_effect: 'NONE', locked_by: registeredBy,
  };
  const body = { ...core, locked_at: lockedAt || now() };
  body.lock_hash = sha256(canonical(body));
  return append(LEDGER(), body);
}

// ── 页面读取（指纹＋TTL 缓存，同 Q0）──────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 15 * 1000;

function fingerprintOf(lock) {
  if (!lock) return 'NO_LOCK';
  const stat = (file) => { try { const item = fs.statSync(file); return `${item.size}:${item.mtimeMs}`; } catch (error) { return `ERR:${error.code}`; } };
  const head = baseline.headLock(lock.case_ref);
  return `${lock.lock_hash}|${stat(lock.file_ref)}|${stat(`${lock.file_ref}.sha256`)}|${head ? head.lock_hash : 'NO_BASELINE'}`;
}

function buildProjection(lock, { allowNonActual = false, question = QUESTION_REF } = {}) {
  if (!lock) return emptyProjection('NOT_IMPORTED', EMPTY_TEXT, { question_ref: question });
  const program = registry.forStrategy(lock.strategy_ref);
  if (!program) return emptyProjection('INVALID', `结果文件校验失败：策略 ${lock.strategy_ref} 没有登记`, { question_ref: question, reason_code: 'STRATEGY_PROFILE_NOT_REGISTERED' });
  const entry = program.get(lock.question_ref);
  if (!entry) return emptyProjection('INVALID', `结果文件校验失败：题目 ${lock.question_ref} 没有登记`, { question_ref: question, reason_code: 'COMPARISON_QUESTION_NOT_REGISTERED' });
  try {
    const sealed = readSealed(lock.file_ref, { allowNonActual, question: lock.question_ref, program });
    if (sealed.sha256 !== lock.file_sha256) fail(E(entry, 'RESULT_DRIFTED_AFTER_LOCK'), `${lock.file_sha256.slice(0, 12)}…≠${sealed.sha256.slice(0, 12)}…`);
    return project(sealed, lock);
  } catch (error) {
    const missing = error instanceof K3Error && /MISSING/.test(error.code);
    return emptyProjection(missing ? 'MISSING' : 'INVALID', `结果文件校验失败：${reasonText(error)}`, { question_ref: entry.question_ref, reason_code: error.code || 'UNKNOWN' });
  }
}

function createProjectionReader({
  now: clock = Date.now, ttlMs = CACHE_TTL_MS, failureTtlMs = FAILURE_TTL_MS, head = headLock,
  build = (lock, question) => buildProjection(lock, { question }),
} = {}) {
  const cache = new Map();
  return {
    read(caseRef = CASE_REF, question = QUESTION_REF) {
      const lock = head(caseRef, question);
      const stamp = fingerprintOf(lock);
      const key = `${caseRef}|${question}`;
      const hit = cache.get(key);
      if (hit && hit.stamp === stamp && clock() - hit.at < (hit.result.state === 'LOCKED_VERIFIED' ? ttlMs : failureTtlMs)) return hit.result;
      const result = build(lock, question);
      cache.set(key, { at: clock(), stamp, result });
      return result;
    },
    /**
     * 这个 case 所属策略的每个已锁定题目一张卡，按队列顺序；第一题（US_V5：Q1）没有结果时也给一张「尚未完成」的卡。
     * case 不属于任何已登记的策略时没有卡（失败关闭，不借用别的策略的题）。
     */
    readAll(caseRef = CASE_REF) {
      const profile = profiles.byCase(caseRef);
      const program = profile && registry.forStrategy(profile.strategy_ref);
      if (!program) return [];
      return program.ORDER.filter((question) => question === program.DEFAULT_QUESTION || head(caseRef, question)).map((question) => this.read(caseRef, question));
    },
    clear() { cache.clear(); },
  };
}

const defaultReader = createProjectionReader();
const readProjection = (caseRef = CASE_REF, question = QUESTION_REF) => defaultReader.read(caseRef, question);
const readProjections = (caseRef = CASE_REF) => defaultReader.readAll(caseRef);
const clearCache = () => defaultReader.clear();

module.exports = {
  RESULT_SCHEMA, EVAL_CLASS, QUESTION_REF, CASE_REF, STRATEGY_REF, TOP_LEVEL, K2_REF, K2_SHA256, RUN_GATES, DELTA_STAR, DELTA_G,
  MIN_AFFECTED, MIN_BLOCKS, BLOCKS, OOS_REUSE_LABEL, LEDGER, registry, QUESTIONS: registry.QUESTIONS, ORDER: registry.ORDER,
  readSealed, validateWhole, buildBlocks, linesOf, project, emptyProjection,
  importCandidateComparison, headLock, locks, comparisonFor, createProjectionReader, readProjection, readProjections, clearCache,
  fingerprintOf, buildProjection,
};
