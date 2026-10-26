'use strict';

/**
 * K3：外部产出的封存基线评价（US_V5 M2 Q0）进入 QRP 的位置。
 *
 * 研究会话在 Mac 上产出 `US_V5_M2_Q0_RESULT_V1`（一个 JSON 加旁边的 sha256 文件）。QRP 只读导入：
 *   1. `importBaselineEvaluation`（命令行，完成权威）校验封存文件并追加一条 `BASELINE_EVALUATION_LOCK_V1`——
 *      Result Lock 的基线类别 `BASELINE_EVALUATION_V1`（SUPPORTED / NOT_PASSED / INSUFFICIENT，比较对象
 *      取自策略档案：一个市场基准加现金）。每个 case 只锁一次，改锁必须引用缺陷并写原因，旧锁保留；
 *   2. `readProjection`（页面）每次现场复验文件 sha256，再把结果投影成「结论」和六块「回测结论卡」。
 *      文件漂移、缺失、封存校验失败、复现性证明缺失或判定越过算术证据，整卡失败关闭。
 *
 * 页面不重算：所有数字来自结果文件。这里只做封存校验、一致性校验和人话标签。没有 HTTP 写入口，
 * 不使用交易凭证，不写生产参数或账本。
 *
 * 按策略不同的值（case、结果 schema、比较对象、底线、相位词、分段词、研究计划与题目队列）都从策略档案
 * （services/strategy-profiles）按 strategy_ref 取：导入按 `strategyRef` 或结果文件的 schema 找档案，页面按锁上的 strategy_ref 找。
 * 未登记的 strategy_ref 失败关闭，不写账本。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const profiles = require('../strategy-profiles');
const m4Scope = require('../strategy-profiles/m4_scope');
const detailNotes = require('../strategy-detail-notes');

const EVAL_CLASS = 'BASELINE_EVALUATION_V1';
// 改造前单策略接口的默认参数与导出常量：取注册表的默认档案（registry.default_strategy_ref），不在代码里写死
const DEFAULT_PROFILE = profiles.defaultProfile();
const RESULT_SCHEMA = DEFAULT_PROFILE.baseline_result_schema;
const CASE_REF = DEFAULT_PROFILE.case_ref;
const STRATEGY_REF = DEFAULT_PROFILE.strategy_ref;
const TOP_LEVEL = Object.freeze(['identity', 'inputs', 'gates', 'arms', 'stats', 'stress', 'half_kelly',
  'formula_table', 'verdict', 'diagnosis_items', 'reproducibility']);
const STATES = Object.freeze(['SUPPORTED', 'NOT_PASSED', 'INSUFFICIENT']);
const comparatorKeys = (profile) => profile.comparators.map((item) => item.key);
const armsOf = (profile) => [['D', '本策略'], ...profile.comparators.map((item) => [item.key, item.label_zh])];
const DELTA_R = 0.10; // 计划 §3 冻结，看见结果后不改
const DELTA_G = 0;
const MIN_TRADES = 30;
/** 主数字那一行：样本外、基础成本 5 bps、生产相位（结论区块的主数字与修订 5 E1.2 半凯利 p、b 的来源行）。 */
const isMainRow = (row) => Boolean(row) && row.segment === 'OOS' && row.cost_bps === 5 && row.phase === 'PRODUCTION';
/**
 * 非 LEGACY_V1 档案的 Q0 读法（CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE §2）：主数字行、费用词、相位说明、普查列、半凯利字段、
 * 前向行、资金费排除与披露都取自档案的 q0_reading。LEGACY_V1（US_V5）返回 null，走改造前的读法，输出不变。
 */
const readingOf = (profile) => (profiles.isLegacyShape(profile) ? null : profile.q0_reading);
/** 主数字那一行的判别：LEGACY_V1 按 5 bps；其他档案按 q0_reading.main_row 的 segment / cost / phase（§3.2）。 */
function mainRowTest(profile) {
  const reading = readingOf(profile);
  if (!reading) return isMainRow;
  const { segment, cost, phase } = reading.main_row;
  return (row) => Boolean(row) && row.segment === segment && row.cost === cost && row.phase === phase;
}
const mainRowOf = (doc, profile) => ((doc.stats && Array.isArray(doc.stats.rows) ? doc.stats.rows : []).find(mainRowTest(profile)) || null);
/** `a.b.c` 形式的路径（q0_reading.market_g_path）；途中不是对象就返回 undefined。 */
const atPath = (doc, dotted) => String(dotted).split('.').reduce((value, key) => (isObject(value) ? value[key] : undefined), doc);
/** 非 LEGACY 档案的规则状态词（§4.1）。 */
const RULE_STATUS_WORDS = Object.freeze({ IMPLEMENTED: '已实现', NOT_IMPLEMENTED: '未实现', APPROXIMATED: '已知近似', NOT_APPLICABLE: '不适用' });
const FLOOR_USD = DEFAULT_PROFILE.floor.value;
const BLOCKS = Object.freeze([
  ['period', '回测周期与覆盖'], ['account', '账户结果'], ['winrate', '胜率与赔率'],
  ['stress', '压力测试'], ['kelly', '半凯利'], ['verdict', '三态结论与判据'],
]);
const SEGMENT_LABELS = DEFAULT_PROFILE.segment_words;
const SOURCE_LABELS = Object.freeze({
  DATA: '数据', SELECTION: '选标的', ENTRY_EXIT: '进出规则', RISK: '风控', INSTRUMENT: '工具', EXECUTION: '执行',
});
/** 研究计划里的题目队列（标题与改造前的排队文案），按策略档案取。 */
const experimentsOf = (profile) => profile.research_program.queue;
const EXPERIMENTS = experimentsOf(DEFAULT_PROFILE);
const REASON_WORDS = Object.freeze({
  ENGINE_APPROXIMATION: '研究引擎只是当前 D 的近似',
  A0_NOT_PASSED: '引擎对齐关卡 A0 未通过',
  SAMPLE_LT_30: '成熟交易少于 30 笔',
  CI_STRADDLES_DELTA: '每笔净 R 的 95% 区间跨过门槛 +0.10 R（这一条本身不足以判定）',
  COVERAGE_INSUFFICIENT: '历史覆盖不足',
  CI_G_STRADDLES_ZERO: '相对比较对象的年化对数增长差，95% 区间跨过 0（这一条本身不足以判定）',
  U_G_AT_OR_BELOW_ZERO: '相对比较对象的年化对数增长差，95% 区间上沿不高于门槛 0',
  U_R_AT_OR_BELOW_DELTA: '每笔净 R 的 95% 区间上沿不高于门槛 +0.10 R',
  G1_NOT_MET: '样本不够（G1 不满足）',
  STRESS_SCENARIO_MISSING: '压力场景有缺（缺场景按不足处理）',
});
const NON_ACTUAL_PATH = /(^|[\\/._-])(fixture|demo|mock|synthetic)([\\/._-]|$)/i;

// ── 页面文字的小工具（只改写法，不改数字）────────────────────────────────────────────

const signOf = (value) => (value < 0 ? '−' : '');
/** 百分比，一位小数，负号用「−」：−30.7%。 */
const pct1 = (value) => `${signOf(value)}${(Math.abs(value) * 100).toFixed(1)}%`;
/** R 值，两位小数，带正负号：+0.27 R、−0.02 R。 */
const rText = (value) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)} R`;
/** 金额，两位小数、千位逗号、负号用「−」，后接档案币种：−50.59 USDT。 */
const moneyText = (value, currency) => `${signOf(value)}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
/** 计数与整数：千位逗号。 */
const intText = (value) => Number(value).toLocaleString('en-US');

/**
 * 把原因码分成「已登记的（有中文说明）」和「未登记的」：页面主内容只写中文说明，不写原样的英文码；
 * 未登记的码放进折叠的技术详情，主内容只写个数。`wordMaps` 靠前的优先。
 */
function resolveReasons(codes, ...wordMaps) {
  const known = [];
  const unknown = [];
  for (const code of Array.isArray(codes) ? codes : []) {
    const text = wordMaps.map((map) => map && map[code]).find(Boolean);
    if (text) known.push({ code, text }); else unknown.push(String(code));
  }
  return { known, unknown };
}

/**
 * 诊断清单等自由文本里的数字：四位以上小数写成两位，USD 写成「美元」。只改写法，不改数；
 * 时间戳（三位毫秒）、版本号、代码里的数字不动。
 */
function plainNumbers(text) {
  return String(text)
    .replace(/(?<![\d.])(-?\d+)\.(\d{4,})(?!\d)/g, (_, whole, fraction) => Number(`${whole}.${fraction}`).toFixed(2))
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*USD(?![A-Za-z])/g, '$1 美元');
}

const LEDGER = () => path.join(dataDir('research'), 'baseline_evaluations.jsonl');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

class K3Error extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new K3Error(code, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };

function authority(recordedBy) {
  need(recordedBy, 'BASELINE_LOCK_REGISTERED_BY_REQUIRED');
  const expected = process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  need(expected, 'BASELINE_LOCK_AUTHORITY_NOT_CONFIGURED');
  need(recordedBy === expected, 'BASELINE_LOCK_REGISTERED_BY_NOT_AUTHORIZED');
}

// ── 封存文件 ────────────────────────────────────────────────────────────────────

/** 读封存文件及旁边的 `<file>.sha256`；内容与旁证不一致、缺任何顶层字段都失败关闭。 */
function readSealed(file, { allowNonActual = false, topLevel = TOP_LEVEL } = {}) {
  need(typeof file === 'string' && path.isAbsolute(file), 'Q0_RESULT_PATH_MUST_BE_ABSOLUTE');
  let real;
  try { real = fs.realpathSync(file); } catch { fail('Q0_RESULT_MISSING', file); }
  if (!allowNonActual) need(!NON_ACTUAL_PATH.test(real), 'Q0_RESULT_NON_ACTUAL_SOURCE', real);
  const bytes = fs.readFileSync(real);
  need(bytes.length > 0, 'Q0_RESULT_EMPTY', real);
  const sidecar = `${real}.sha256`;
  let expected;
  try { expected = /^([0-9a-f]{64})\b/.exec(fs.readFileSync(sidecar, 'utf8').trim()); } catch { fail('Q0_RESULT_SHA256_FILE_MISSING', sidecar); }
  need(expected, 'Q0_RESULT_SHA256_FILE_UNREADABLE', sidecar);
  const actual = sha256(bytes);
  need(actual === expected[1], 'Q0_RESULT_SHA256_MISMATCH', `${expected[1].slice(0, 12)}…≠${actual.slice(0, 12)}…`);
  let doc;
  try { doc = JSON.parse(bytes.toString('utf8')); } catch { fail('Q0_RESULT_NOT_JSON', real); }
  need(isObject(doc), 'Q0_RESULT_NOT_OBJECT');
  const missing = topLevel.filter((key) => doc[key] === undefined || doc[key] === null);
  need(!missing.length, 'Q0_RESULT_TOP_LEVEL_MISSING', missing.join(','));
  const stat = fs.statSync(real);
  return { file: real, sidecar, sha256: actual, size: bytes.length, mtimeMs: stat.mtimeMs, doc };
}

// ── 整文件一致性（失败关闭）──────────────────────────────────────────────────────

/**
 * 不重算业务，只拒绝「标签越过算术证据」和「缺复现证明」：
 *   - 复现：两次运行输出 sha256 相等，且就是封存文件之外声明的同一值；
 *   - δ 与比较对象是计划冻结值；
 *   - SUPPORTED 须有 L_R > δ 且 L_g > δ_g、样本 ≥ 30 笔、引擎不是近似、A0 与规则清单无缺口；
 *   - NOT_PASSED 须有 U_R ≤ δ 或 U_g ≤ δ_g；INSUFFICIENT 随时允许（保守方向）；
 *   - 极端熊市这类模拟场景必须标 simulated，不能冒充可交易历史。
 */
function approximationFromGates(doc) {
  const gates = isObject(doc.gates) ? doc.gates : {};
  const missing = [];
  if (!isObject(gates.A0) || gates.A0.state !== 'PASSED') missing.push('A0 对齐关卡未通过');
  const rules = Array.isArray(gates.rules) ? gates.rules : [];
  if (!rules.length) missing.push('规则清单缺失');
  for (const rule of rules) if (isObject(rule) && rule.status === 'NOT_IMPLEMENTED') missing.push(`规则未实现：${rule.rule || '未命名'}`);
  return missing;
}

/** F1 的 missing:true，或研究会话文件里的 status = MISSING_SCENARIO / INVALID_INPUT：这一行没有跑出任何序列。 */
const NO_SERIES_STATUS = Object.freeze({ MISSING_SCENARIO: 'MISSING', INVALID_INPUT: 'INVALID_INPUT' });
const hasNoSeries = (row) => row.missing === true || Object.prototype.hasOwnProperty.call(NO_SERIES_STATUS, row.status);

/**
 * 压力表里的行分四种角色（冻结说明 2 G2）：
 *   STRESS 计划 §5.2 在当前 D 上跑的压力场景（费用、滑点、扫描相位、区间重放、极端下跌）——只有它们进「最大损失」和 AC8；
 *   REFERENCE 当前 D 参照行 `BASELINE`；RISK_DIMENSION 风控维度行 `RISK_*`（Q4 的输入，只报不判）；
 *   SUPPLEMENTARY 补充情景（`status: SUPPLEMENTARY_NOT_IN_CONCLUSION`）。
 */
const stressRole = (row) => {
  if (row.status === 'SUPPLEMENTARY_NOT_IN_CONCLUSION') return 'SUPPLEMENTARY';
  if (row.scenario === 'BASELINE') return 'REFERENCE';
  if (/^RISK_/.test(String(row.scenario || ''))) return 'RISK_DIMENSION';
  return 'STRESS';
};
const HAS_CHINESE = /[\u4e00-\u9fff]/;
/** 有中文变体就用中文变体（G1）：`<key>_zh` 非空时取它，否则取 `<key>`。 */
const preferZh = (object, key) => {
  const zh = object && object[`${key}_zh`];
  return typeof zh === 'string' && zh.trim() ? zh : object && object[key];
};

/** 结果文件属于哪条策略：显式给了档案就用它；否则按文件的 schema 找，找不到时交给默认档案，由 schema 校验拒绝。 */
const profileForDoc = (doc) => profiles.byBaselineSchema(isObject(doc) && isObject(doc.identity) ? doc.identity.schema : null) || DEFAULT_PROFILE;

/**
 * 非 LEGACY 档案的规则清单（§4.1）：状态只认四个词；每条已知近似必须带 code_ref 与 note_zh（披露偏差大小，冻结裁定 2 G4）；
 * verdict.engine_approximation.approximations 与已知近似规则的 id 集合相等。已知近似不算缺口（§4.2 ★(a)）。
 */
function checkRules(doc, approximation) {
  const rules = isObject(doc.gates) && Array.isArray(doc.gates.rules) ? doc.gates.rules : [];
  rules.forEach((rule, index) => {
    need(isObject(rule) && Object.prototype.hasOwnProperty.call(RULE_STATUS_WORDS, rule.status), 'Q0_RULE_STATUS_UNKNOWN',
      `gates.rules[${index}]${isObject(rule) ? `:${rule.rule}=${rule.status}` : ''}`);
    if (rule.status === 'APPROXIMATED') {
      need(isText(rule.code_ref) && isText(rule.note_zh), 'Q0_APPROXIMATION_SIZE_NOT_DISCLOSED', rule.rule || `gates.rules[${index}]`);
    }
  });
  const approximated = rules.filter((rule) => rule.status === 'APPROXIMATED').map((rule) => rule.rule);
  const declared = approximation.approximations;
  need(approximated.length === declared.length && new Set(declared).size === declared.length && approximated.every((id) => declared.includes(id)),
    'Q0_ENGINE_APPROXIMATIONS_MISMATCH', `规则清单 ${approximated.join(',') || '无'} ≠ 声明 ${declared.join(',') || '无'}`);
}

/** §3.3：结论与主数字同源——判据区间、笔数逐值等于主数字行，G 区间逐值等于 market_g_path 指向的 ci。 */
function checkVerdictFromMainRow(doc, profile) {
  const verdict = doc.verdict;
  const main = mainRowOf(doc, profile);
  need(main, 'Q0_VERDICT_NOT_FROM_MAIN_ROW', '主数字行缺失');
  const g = atPath(doc, readingOf(profile).market_g_path);
  const unequal = [];
  if (!(Array.isArray(main.mean_R_ci) && main.mean_R_ci[0] === verdict.L_R && main.mean_R_ci[1] === verdict.U_R)) unequal.push('L_R/U_R ≠ 主数字行 mean_R_ci');
  if (main.n !== verdict.n_trades) unequal.push('n_trades ≠ 主数字行 n');
  if (!(isObject(g) && Array.isArray(g.ci) && g.ci[0] === verdict.L_g && g.ci[1] === verdict.U_g)) unequal.push(`L_g/U_g ≠ ${readingOf(profile).market_g_path}.ci`);
  need(!unequal.length, 'Q0_VERDICT_NOT_FROM_MAIN_ROW', unequal.join('；'));
}

/** §8 新增检查 1：被替代的运行只作为记录写在文件里（state、结果 sha256、原因），不得指向本文件自己。 */
function checkSupersedes(identity, fileSha256) {
  if (identity.supersedes === undefined) return;
  need(Array.isArray(identity.supersedes) && identity.supersedes.every((item) => isObject(item) && item.state === 'SUPERSEDED'
    && /^[0-9a-f]{64}$/.test(item.result_sha256 || '') && item.result_sha256 !== fileSha256 && isText(item.reason_zh)), 'Q0_SUPERSEDES_INVALID');
}

/** `fileSha256`（可选）：封存文件的 sha256，用于 §8 的「supersedes 不得含本文件」。 */
function validateWhole(doc, profile = profileForDoc(doc), { fileSha256 = null } = {}) {
  const legacy = profiles.isLegacyShape(profile);
  const repro = doc.reproducibility;
  need(isObject(repro) && typeof repro.command === 'string' && repro.command && Array.isArray(repro.runs)
    && repro.runs.length >= 2 && repro.runs.every((run) => isObject(run) && /^[0-9a-f]{64}$/.test(run.sha256 || ''))
    && new Set(repro.runs.map((run) => run.sha256)).size === 1 && repro.identical === true,
  'Q0_RESULT_NOT_REPRODUCED');
  const identity = doc.identity;
  need(isObject(identity) && identity.schema === profile.baseline_result_schema, 'Q0_RESULT_SCHEMA_UNSUPPORTED', identity && identity.schema);

  const verdict = doc.verdict;
  need(isObject(verdict) && verdict.class === EVAL_CLASS, 'Q0_VERDICT_CLASS_UNSUPPORTED', verdict && verdict.class);
  need(STATES.includes(verdict.state), 'Q0_VERDICT_STATE_UNSUPPORTED', verdict.state);
  const comparators = comparatorKeys(profile);
  need(Array.isArray(verdict.comparators) && comparators.every((name) => verdict.comparators.includes(name))
    && verdict.comparators.length === comparators.length, 'Q0_VERDICT_COMPARATORS_CHANGED');
  need(verdict.delta_R === DELTA_R && verdict.delta_g === DELTA_G, 'Q0_VERDICT_DELTA_CHANGED', `${verdict.delta_R}/${verdict.delta_g}`);
  need(verdict.ci_method === 'MONTHLY_BLOCK_BOOTSTRAP_95', 'Q0_VERDICT_CI_METHOD_CHANGED', verdict.ci_method);
  const approximation = verdict.engine_approximation;
  if (legacy) {
    need(isObject(approximation) && typeof approximation.flag === 'boolean'
      && Array.isArray(approximation.missing), 'Q0_VERDICT_ENGINE_APPROXIMATION_MISSING');
  } else {
    // §4.1：非 LEGACY 档案读 approximations（数组）；missing 可省略，省略按 [] 读
    need(isObject(approximation) && typeof approximation.flag === 'boolean' && Array.isArray(approximation.approximations)
      && (approximation.missing === undefined || Array.isArray(approximation.missing)), 'Q0_VERDICT_ENGINE_APPROXIMATION_MISSING');
    checkRules(doc, approximation);
    checkVerdictFromMainRow(doc, profile);
    checkSupersedes(identity, fileSha256);
  }
  const gapped = approximationFromGates(doc);
  if (gapped.length) need(verdict.engine_approximation.flag === true, 'Q0_ENGINE_APPROXIMATION_NOT_DECLARED', gapped.join('；'));

  if (verdict.state === 'SUPPORTED') {
    need(finite(verdict.L_R) && finite(verdict.L_g) && verdict.L_R > DELTA_R && verdict.L_g > DELTA_G,
      'Q0_VERDICT_SUPPORTED_WITHOUT_EVIDENCE', `L_R=${verdict.L_R} L_g=${verdict.L_g}`);
    need(Number.isInteger(verdict.n_trades) && verdict.n_trades >= MIN_TRADES, 'Q0_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL', verdict.n_trades);
    need(verdict.engine_approximation.flag === false && !gapped.length, 'Q0_VERDICT_SUPPORTED_ON_APPROXIMATE_ENGINE');
  }
  const stressRows = isObject(doc.stress) && Array.isArray(doc.stress.rows) ? doc.stress.rows : [];
  if (verdict.state === 'SUPPORTED') {
    // G3（修订版）：优势评价与压力评价、采用条件是三件事（§6.7）。压力场景缺场景或无效输入时，SUPPORTED 照常导入，
    // 但文件必须自己写明压力不完整（reason_codes 含 STRESS_SCENARIO_MISSING），不能让「有支持证据」把它盖住。
    const incomplete = stressRows.filter((row) => isObject(row) && hasNoSeries(row) && stressRole(row) === 'STRESS').map((row) => row.scenario);
    if (incomplete.length) {
      need(Array.isArray(verdict.reason_codes) && verdict.reason_codes.includes('STRESS_SCENARIO_MISSING'),
        'Q0_VERDICT_SUPPORTED_HIDES_INCOMPLETE_STRESS', incomplete.join(','));
    }
  }
  if (verdict.state === 'NOT_PASSED') {
    need((finite(verdict.U_R) && verdict.U_R <= DELTA_R) || (finite(verdict.U_g) && verdict.U_g <= DELTA_G),
      'Q0_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE', `U_R=${verdict.U_R} U_g=${verdict.U_g}`);
  }

  for (const row of stressRows) {
    // 缺场景行（F1）没有跑出任何序列，不存在「把模拟当真实」的风险，名称里带「熊市」也不要求 simulated:true。
    if (isObject(row) && !hasNoSeries(row) && /bear|熊|synthetic|模拟/i.test(`${row.scenario || ''}${row.label || ''}`)) {
      need(row.simulated === true, 'Q0_STRESS_SIMULATED_NOT_FLAGGED', row.scenario);
    }
  }
  return gapped;
}

// ── 区块（各自失败只影响自己）────────────────────────────────────────────────────

const ci = (value, code) => {
  need(Array.isArray(value) && value.length === 2 && value.every(finite) && value[0] <= value[1], 'INVALID', code);
  return { lo: value[0], hi: value[1] };
};
const field = (parent, key, label, type = 'finite') => {
  const value = parent && parent[key];
  if (value === undefined || value === null) fail('MISSING', label || key);
  if (type === 'finite') need(finite(value), 'INVALID', label || key);
  if (type === 'string') need(typeof value === 'string' && value, 'INVALID', label || key);
  if (type === 'bool') need(typeof value === 'boolean', 'INVALID', label || key);
  return value;
};

function periodBlock(doc, gapped, profile) {
  const segments = doc.inputs && doc.inputs.segments;
  need(Array.isArray(segments) && segments.length, 'MISSING', 'inputs.segments');
  const census = doc.inputs.census;
  need(Array.isArray(census) && census.length, 'MISSING', 'inputs.census');
  const verdict = doc.verdict;
  const missing = [...new Set([...(verdict.engine_approximation.missing || []), ...gapped])];
  const reading = readingOf(profile);
  if (reading) return periodBlockReading(doc, profile, reading, missing);
  return {
    segments: segments.map((segment) => ({
      id: field(segment, 'id', 'segment.id', 'string'), label: profile.segment_words[segment.id] || segment.id,
      start: field(segment, 'start', 'segment.start', 'string'), end: field(segment, 'end', 'segment.end', 'string'),
      sessions: field(segment, 'sessions'), tradable_carriers: field(segment, 'tradable_carriers'),
      pool_overlap_ratio: field(segment, 'pool_overlap_ratio'),
    })),
    census: census.map((row) => ({ year: field(row, 'year'), tradable_carriers: field(row, 'tradable_carriers') })),
    engine: verdict.engine_approximation.flag
      ? {
        label: typeof verdict.label === 'string' && verdict.label.trim() ? verdict.label.trim()
          : `研究引擎近似${missing.length ? `（缺：${missing.join('；')}）` : ''}`,
        approximation: true, missing,
      }
      : { label: '当前 D（引擎对齐关卡 A0 通过，规则清单无缺口）', approximation: false, missing: [] },
  };
}

const GATE_STATE_WORDS = Object.freeze({ PASSED: '通过', FAILED: '未通过' });

/** 关卡的一行技术详情（只进折叠区）：状态 + 文件自带的数字，或单个数字，或「无」。 */
function gateLine(key, gate) {
  if (finite(gate)) return `${key} = ${intText(gate)}`;
  if (!isObject(gate)) return `${key}：${String(gate)}`;
  const entries = Object.entries(gate).filter(([name]) => name !== 'state');
  const numbers = entries.filter(([, value]) => finite(value)).map(([name, value]) => `${name} = ${intText(value)}`);
  const head = gate.state !== undefined ? (GATE_STATE_WORDS[gate.state] || String(gate.state)) : (entries.length ? '' : '无');
  return `${key}：${head}${numbers.length ? `${head ? '（' : ''}${numbers.join('；')}${head ? '）' : ''}` : ''}`;
}

/**
 * 第 1 块，非 LEGACY 档案（§4.3、§4.4、§10）：分段的可交易载体／标的池重叠可省略（省略不显示）；普查列取自档案；
 * 引擎标签头取 verdict.label_zh（G1）；规则清单按状态计数并逐条列出已知近似；A0 与其他关卡；共享约束只写文字。
 */
function periodBlockReading(doc, profile, reading, missing) {
  const verdict = doc.verdict;
  const gates = isObject(doc.gates) ? doc.gates : {};
  const rules = Array.isArray(gates.rules) ? gates.rules : [];
  const optional = (segment, key) => (segment[key] === undefined || segment[key] === null ? {} : { [key]: field(segment, key) });
  const columns = reading.census_columns.map((column) => ({ field: column.field, label_zh: column.label_zh }));
  const approximated = rules.filter((rule) => rule.status === 'APPROXIMATED');
  const head = preferZh(verdict, 'label');
  const headText = typeof head === 'string' && head.trim() ? head.trim() : '当前 D';
  const counts = Object.keys(RULE_STATUS_WORDS).map((status) => [status, rules.filter((rule) => rule.status === status).length]);
  const ruleCounts = Object.fromEntries(counts);
  const sharedRule = (ref) => rules.find((rule) => rule.rule === ref) || null;
  return {
    segments: doc.inputs.segments.map((segment) => ({
      id: field(segment, 'id', 'segment.id', 'string'), label: profile.segment_words[segment.id] || segment.id,
      start: field(segment, 'start', 'segment.start', 'string'), end: field(segment, 'end', 'segment.end', 'string'),
      sessions: field(segment, 'sessions'), ...optional(segment, 'tradable_carriers'), ...optional(segment, 'pool_overlap_ratio'),
    })),
    census_columns: columns,
    census: doc.inputs.census.map((row) => ({ year: field(row, 'year'), values: columns.map((column) => field(row, column.field, `inputs.census.${column.field}`)) })),
    engine: verdict.engine_approximation.flag
      ? { label: typeof head === 'string' && head.trim() ? head.trim() : `研究引擎近似${missing.length ? `（缺：${missing.join('；')}）` : ''}`, approximation: true, missing }
      : {
        label: approximated.length ? `${headText}（引擎对齐关卡 A0 通过；长历史已知近似 ${approximated.length} 条，见规则清单）` : `${headText}（引擎对齐关卡 A0 通过，规则清单无缺口）`,
        approximation: false, missing: [],
      },
    a0: { text_zh: `引擎对齐关卡 A0：${isObject(gates.A0) && gates.A0.state === 'PASSED' ? '通过' : '未通过'}`, ref: isObject(gates.A0) && isText(gates.A0.ref) ? gates.A0.ref : null },
    rules: {
      title: `规则清单（${counts.filter(([, n]) => n > 0).map(([status, n]) => `${RULE_STATUS_WORDS[status]} ${n}`).join(' · ') || '空'}）`,
      counts: ruleCounts,
      approximated: approximated.map((rule) => ({ rule: rule.rule, note_zh: rule.note_zh, code_ref: rule.code_ref })),
      not_implemented: rules.filter((rule) => rule.status === 'NOT_IMPLEMENTED').map((rule) => ({ rule: rule.rule, note_zh: rule.note_zh || null, code_ref: rule.code_ref || null })),
    },
    gates: Object.keys(gates).filter((key) => key !== 'A0' && key !== 'rules').map((key) => gateLine(key, gates[key])),
    // §10：共享约束只写文字，不显示任何预算数字；规则清单里对应的规则必须是 NOT_APPLICABLE（只引用不复算）
    shared_constraints: (profile.shared_constraints || []).map((item) => {
      const rule = sharedRule(item.rule_ref);
      const consistent = Boolean(rule) && rule.status === 'NOT_APPLICABLE';
      const peers = item.peers.map((ref) => (m4Scope.itemFor(ref) || {}).label_zh || ref);
      return {
        key: item.key, rule_ref: item.rule_ref, consistent,
        text_zh: consistent ? `${item.label_zh}：与 ${peers.join('、')} ${item.display_zh}（规则 ${item.rule_ref}）` : `${item.label_zh}：共享约束与规则清单不一致（规则 ${item.rule_ref}）`,
      };
    }),
  };
}

/**
 * 修订 5 勘误 1 E3：「期末是否回到最高点」的读数——区间内权益的最高点（第一次到达的那天）、期末距最高点的幅度、
 * 最高点之后过了几个交易日。这是对已封存权益序列的确定性读数（取最大值、所在日期、期末与最大值之比），不是研究统计量；页面只显示。
 */
function peakReadout(equity) {
  const values = equity.values;
  let at = 0;
  values.forEach((value, index) => { if (value > values[at]) at = index; });
  const end = values[values.length - 1];
  return { value: values[at], date: equity.dates[at], end, gap: end / values[at] - 1, sessions_since: values.length - 1 - at };
}

/**
 * 账户结果。修订 5 E2：比较对象的定义与分红口径取自说明登记（services/strategy-detail-notes），口径按这份结果文件的 sha256 绑定；
 * 没登记写「分红口径未记录」并列进待验证问题清单（见 project）。没有说明登记的策略不加这一项。
 */
function accountBlock(doc, profile, context = {}) {
  const out = [];
  let dates = null;
  const reading = readingOf(profile);
  const cashKey = profiles.comparator(profile, 'CASH').key;
  for (const [key, label] of armsOf(profile)) {
    const arm = doc.arms[key];
    need(isObject(arm), 'MISSING', `arms.${key}`);
    // §4.4：非 LEGACY 档案的现金臂可以没有权益序列——只显示它的 summary，不画序列，也不拿 D 的日期去补
    if (reading && key === cashKey && arm.equity === undefined) {
      out.push({ ...summaryOnly(arm.summary, `arms.${key}.summary`), key, label, peak: null, sessions: null, trades: null, summary_only: true });
      continue;
    }
    const equity = arm.equity;
    need(isObject(equity) && Array.isArray(equity.dates) && Array.isArray(equity.values)
      && equity.dates.length === equity.values.length && equity.values.length >= 2
      && equity.values.every((value) => finite(value) && value > 0), 'INVALID', `arms.${key}.equity`);
    if (dates) need(canonical(dates) === canonical(equity.dates), 'INVALID', `arms.${key}.equity.dates 与其他臂不一致`);
    dates = equity.dates;
    const summary = arm.summary;
    need(isObject(summary), 'MISSING', `arms.${key}.summary`);
    const end = field(summary, 'end_capital', `arms.${key}.summary.end_capital`);
    need(Math.abs(end - equity.values[equity.values.length - 1]) <= 1e-6 * Math.max(1, Math.abs(end)),
      'INVALID', `arms.${key}.summary.end_capital 与权益序列末点不一致`);
    out.push({
      key, label, end_capital: end, cagr: field(summary, 'cagr', `arms.${key}.summary.cagr`),
      max_drawdown: field(summary, 'max_drawdown', `arms.${key}.summary.max_drawdown`),
      longest_underwater_sessions: field(summary, 'longest_underwater_sessions', `arms.${key}.summary.longest_underwater_sessions`),
      recovered: field(summary, 'recovered', `arms.${key}.summary.recovered`, 'bool'), peak: peakReadout(equity),
      sessions: equity.values.length, trades: Array.isArray(arm.trades) ? arm.trades.length : null,
    });
  }
  const notes = context.notes
    ? profile.comparators.map((item) => {
      const note = detailNotes.comparatorNote(context.notes, item.key, context.file_sha256);
      return note && { ...note, label: item.label_zh };
    }).filter(Boolean)
    : [];
  const extra = reading ? accountExtras(doc, profile, reading, out) : {};
  return { arms: out, start: dates[0], end: dates[dates.length - 1], ...(notes.length ? { comparator_notes: notes } : {}), ...extra };
}

/** summary 原样（期末资本、年化、最大回撤、最长水下期、是否回到最高点），不从序列推。 */
function summaryOnly(summary, where) {
  need(isObject(summary), 'MISSING', where);
  return {
    end_capital: field(summary, 'end_capital', `${where}.end_capital`), cagr: field(summary, 'cagr', `${where}.cagr`),
    max_drawdown: field(summary, 'max_drawdown', `${where}.max_drawdown`),
    longest_underwater_sessions: field(summary, 'longest_underwater_sessions', `${where}.longest_underwater_sessions`),
    recovered: field(summary, 'recovered', `${where}.recovered`, 'bool'),
  };
}

/**
 * 前向行（§7.1，只报不判）：检查只让这一行无效，不影响结论；前向数字永不进判据、主数字、压力或半凯利。
 * 返回 { valid, text_zh, raw }。
 */
function forwardRow(forward, profile, spec) {
  const fail_ = (reason) => ({ valid: false, text_zh: `前向记录无效：${reason}`, raw: isObject(forward) ? forward : null });
  if (!isObject(forward)) return fail_('结果文件缺 forward');
  if (forward.in_verdict !== false) return fail_(`in_verdict 应为 false（实际 ${JSON.stringify(forward.in_verdict)}）`);
  if (forward.ledger !== profile.strategy_ref) return fail_(`账本 ${forward.ledger || '未写'} 不是本策略`);
  if (!Number.isInteger(forward.trades) || forward.trades < 0) return fail_('trades 不是非负整数');
  const net = forward[spec.net_field];
  if (!finite(net)) return fail_(`${spec.net_field} 不是有限数`);
  if (!finite(forward.mean_R)) return fail_('mean_R 不是有限数');
  return {
    valid: true,
    text_zh: `前向记录（PAPER 账本 ${forward.ledger}，只报不判，不进结论）：${forward.trades} 笔，净 ${moneyText(net, profile.currency)}，每笔均值 ${rText(forward.mean_R)}。`,
    raw: { ledger: forward.ledger, trades: forward.trades, [spec.net_field]: net, mean_R: forward.mean_R },
  };
}

/** 非 LEGACY 档案第 2 块的其余字段（§4.4、§7）：本策略逐笔记录行数、开发期账户（折叠只报）、前向行。 */
function accountExtras(doc, profile, reading, arms) {
  const main = reading.main_row.segment;
  const d = arms.find((arm) => arm.key === 'D');
  const dev = Object.keys(profile.segment_words).filter((id) => id !== main && isObject(doc.arms[id])).map((id) => {
    const word = profile.segment_words[id];
    const segmentArms = armsOf(profile).filter(([key]) => isObject(doc.arms[id][key]))
      .map(([key, label]) => ({ key, label, ...summaryOnly(doc.arms[id][key].summary, `arms.${id}.${key}.summary`) }));
    return { segment: id, title: `${word}账户（${word}，只报）`, arms: segmentArms };
  });
  return {
    ...(d && Number.isInteger(d.trades) ? { trades_line_zh: `本策略逐笔记录 ${d.trades} 行；主统计的笔数见胜率表。` } : {}),
    ...(dev.length ? { dev_accounts: dev } : {}),
    ...(reading.forward ? { forward: forwardRow(doc.forward, profile, reading.forward) } : {}),
  };
}

function winrateBlock(doc, profile) {
  const rows = doc.stats && doc.stats.rows;
  need(Array.isArray(rows) && rows.length, 'MISSING', 'stats.rows');
  const table = doc.formula_table;
  need(isObject(table) && table.kind === 'FORMULA_NOT_BACKTEST' && Array.isArray(table.cells) && table.cells.length,
    'INVALID', 'formula_table 必须标 FORMULA_NOT_BACKTEST');
  const reading = readingOf(profile);
  if (reading) return winrateBlockReading(rows, table, profile, reading);
  const hasPlus = rows.some((row) => row && row.phase === 'PLUS_60MIN');
  const hasMinus = rows.some((row) => row && row.phase === 'MINUS_60MIN');
  const merged = hasPlus && !hasMinus; // 120 分钟扫描下 −60 与 +60 是同一组时刻，研究会话只列一行
  // 修订 5 E4：开发期折叠控件上的笔数——各开发期段在主数字同一口径（5 bps、生产相位）那一行的笔数，原样取，不相加
  const devCounts = rows.filter((row) => row && row.segment !== 'OOS' && row.cost_bps === 5 && row.phase === 'PRODUCTION' && Number.isInteger(row.n))
    .map((row) => ({ segment: row.segment, label: profile.segment_words[row.segment] || row.segment, n: row.n }));
  return {
    notes: merged ? ['相位 ±60 分钟：扫描间隔 120 分钟时，提前 60 分钟与推后 60 分钟落在同一组时刻，所以只列一行。'] : [],
    dev_counts: { rows: devCounts, basis_zh: `5 bps，${profile.phase_words.PRODUCTION || '生产相位'}` },
    rows: rows.map((row) => {
      const win = field(row, 'win_rate', 'stats.win_rate');
      need(win >= 0 && win <= 1, 'INVALID', 'stats.win_rate 不在 0–1');
      need(Number.isInteger(row.n) && row.n >= 0, 'INVALID', 'stats.n');
      return {
        segment: field(row, 'segment', 'stats.segment', 'string'), segment_label: profile.segment_words[row.segment] || row.segment,
        cost_bps: field(row, 'cost_bps', 'stats.cost_bps'), phase: field(row, 'phase', 'stats.phase', 'string'),
        phase_label: merged && row.phase === 'PLUS_60MIN' ? '相位 ±60 分钟' : (profile.phase_words[row.phase] || row.phase), n: row.n, win_rate: win,
        payoff: row.payoff === null ? null : field(row, 'payoff', 'stats.payoff'),
        mean_R: field(row, 'mean_R', 'stats.mean_R'), mean_R_ci: ci(row.mean_R_ci, 'stats.mean_R_ci'),
      };
    }),
    formula: {
      note: '公式推算，不是回测', kind: table.kind,
      cells: table.cells.map((cell) => ({
        win_rate: field(cell, 'win_rate', 'formula_table.win_rate'), payoff: field(cell, 'payoff', 'formula_table.payoff'),
        expected_growth: field(cell, 'expected_growth', 'formula_table.expected_growth'),
      })),
    },
  };
}

const formulaOf = (table) => ({
  note: '公式推算，不是回测', kind: table.kind,
  cells: table.cells.map((cell) => ({
    win_rate: field(cell, 'win_rate', 'formula_table.win_rate'), payoff: field(cell, 'payoff', 'formula_table.payoff'),
    expected_growth: field(cell, 'expected_growth', 'formula_table.expected_growth'),
  })),
});

/** §5.6：资金费缺失排除的笔数（整数 ≥ 0）与占比（0–1）；主数字行缺这两个字段 → 本块无效，其他行缺时空着。 */
function fundingExclusion(row, spec, isMain, where) {
  const count = row[spec.count_field];
  const share = row[spec.share_field];
  if ((count === undefined || count === null) && (share === undefined || share === null)) {
    need(!isMain, 'MISSING', `${where}.${spec.count_field}（主数字行）`);
    return null;
  }
  need(Number.isInteger(count) && count >= 0, 'INVALID', `${where}.${spec.count_field}`);
  need(finite(share) && share >= 0 && share <= 1, 'INVALID', `${where}.${spec.share_field} 不在 0–1`);
  return { count, share };
}

/**
 * 第 3 块，非 LEGACY 档案（§3.2、§5.6）：费用按 `cost` 与档案的 cost_words 写；相位说明取档案的 phase_note_zh，
 * 不套用 US 的「相位 ±60 分钟」合并说明；开发期笔数按主数字同一口径；资金费缺失排除单列一栏。
 */
function winrateBlockReading(rows, table, profile, reading) {
  const isMain = mainRowTest(profile);
  const { main_row: main, cost_words: costWords, funding_exclusion: funding } = reading;
  const devCounts = rows.filter((row) => row && row.segment !== main.segment && row.cost === main.cost && row.phase === main.phase && Number.isInteger(row.n))
    .map((row) => ({ segment: row.segment, label: profile.segment_words[row.segment] || row.segment, n: row.n }));
  return {
    notes: reading.phase_note_zh ? [reading.phase_note_zh] : [],
    dev_counts: { rows: devCounts, basis_zh: `${costWords[main.cost]}，${profile.phase_words[main.phase]}` },
    ...(funding ? { funding_exclusion: { rule_ref_zh: funding.rule_ref_zh } } : {}),
    rows: rows.map((row, index) => {
      const where = `stats.rows[${index}]`;
      const win = field(row, 'win_rate', 'stats.win_rate');
      need(win >= 0 && win <= 1, 'INVALID', 'stats.win_rate 不在 0–1');
      need(Number.isInteger(row.n) && row.n >= 0, 'INVALID', 'stats.n');
      const cost = field(row, 'cost', 'stats.cost', 'string');
      return {
        segment: field(row, 'segment', 'stats.segment', 'string'), segment_label: profile.segment_words[row.segment] || row.segment,
        cost, cost_label: costWords[cost] || cost, phase: field(row, 'phase', 'stats.phase', 'string'),
        phase_label: profile.phase_words[row.phase] || row.phase, n: row.n, win_rate: win,
        payoff: row.payoff === null ? null : field(row, 'payoff', 'stats.payoff'),
        mean_R: field(row, 'mean_R', 'stats.mean_R'), mean_R_ci: ci(row.mean_R_ci, 'stats.mean_R_ci'),
        ...(funding ? { funding_excluded: fundingExclusion(row, funding, isMain(row), where) } : {}),
      };
    }),
    formula: formulaOf(table),
  };
}

const STRESS_NUMBERS = ['max_loss_usd', 'longest_underwater_sessions', 'recovered', 'end_capital'];
const KNOWN_STRESS_STATUS = Object.freeze(['MISSING_SCENARIO', 'INVALID_INPUT', 'SUPPLEMENTARY_NOT_IN_CONCLUSION']);
/** §5.4：非 LEGACY 档案另认 SAME_AS_BASELINE（与当前 D 参照相同）。 */
const SAME_AS_BASELINE = 'SAME_AS_BASELINE';
/** §5.5：风控维度行与参照行「相同」只比较文件里两行的这些字段，不计算。 */
const SAME_AS_REFERENCE_FIELDS = Object.freeze(['max_loss_usd', 'longest_underwater_sessions', 'recovered', 'end_capital', 'n', 'mean_R']);
const optionalFinite = (row, key) => (finite(row[key]) ? row[key] : null);

/**
 * 压力行有四类：
 *   - 已执行：有数字，`simulated:false`，可进「最大损失」主数字（除非行自己写了 `in_headline:false`）；
 *   - 模拟／补充：有数字，`simulated:true`；`status:SUPPLEMENTARY_NOT_IN_CONCLUSION` 的补充行必须同时 `in_headline:false`，永不进主数字；
 *   - 缺场景：`missing:true`（F1）或 `status:MISSING_SCENARIO`，没有序列，数字全为 null；
 *   - 无效输入：`status:INVALID_INPUT`（例如 2020 年窗口里没有载体通过流动性底线），同样全为 null。
 * 缺场景和无效输入页面写「缺场景：原因」「无效输入：原因」，不让整块变空，也不计为已执行的压力。
 * 原因语言（冻结说明 2 G1）：`missing_reason`（F1 的冻结字段）→ `reason_zh` → `reason`；缺原因、带了数字都只让压力块无效。
 * 「最大损失」只取 §5.2 压力场景（G2）：参照行 `BASELINE`、风控维度行 `RISK_*`、补充行、模拟行、缺场景和无效输入都不进，但都留在表里。
 */
function stressBlock(doc, context = {}, profile = profileForDoc(doc)) {
  const stress = doc.stress;
  const rows = stress && stress.rows;
  need(Array.isArray(rows) && rows.length, 'MISSING', 'stress.rows');
  const legacy = !readingOf(profile);
  const reference = rows.find((row) => isObject(row) && row.scenario === 'BASELINE') || null;
  const mapped = rows.map((row, index) => {
    const where = `stress.rows[${index}]`;
    need(isObject(row), 'INVALID', where);
    const scenario = field(row, 'scenario', `${where}.scenario`, 'string');
    const labelText = preferZh(row, 'label');
    const label = typeof labelText === 'string' && labelText ? labelText : scenario;
    const role = stressRole(row);
    need(row.status === undefined || KNOWN_STRESS_STATUS.includes(row.status) || (!legacy && row.status === SAME_AS_BASELINE),
      'INVALID', `${where}.status=${row.status} 不认识`);
    if (row.status === SAME_AS_BASELINE) {
      // §5.4 ★(a)：不从参照行抄任何数字，只核对文件自己的 end_capital 与参照行相同；不进最大损失，不算缺场景，单独计数
      need(reference, 'INVALID', `${where} 写「与当前 D 参照相同」，但压力表没有参照行 BASELINE`);
      const end = field(row, 'end_capital', `${where}.end_capital`);
      need(finite(reference.end_capital) && Math.abs(end - reference.end_capital) <= 1e-6, 'INVALID', `${where}.end_capital 与参照行 BASELINE 不一致`);
      return {
        scenario, label, role, kind: 'SAME_AS_REFERENCE', missing: false, invalid_input: false, kind_label: '与当前 D 参照相同',
        reason: null, missing_reason: null, simulated: false, in_headline: false,
        max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: end, n: null, mean_R: null, note: null,
      };
    }
    if (hasNoSeries(row)) {
      // 原因语言（冻结说明 2 G1）：先 missing_reason（F1 的冻结字段），再 reason_zh，最后 reason。
      const reasonRaw = [row.missing_reason, row.reason_zh, row.reason].find((item) => typeof item === 'string' && item.trim());
      need(reasonRaw, 'MISSING', `${where}.reason`);
      // §5.3：非 LEGACY 档案的数字字段不存在按 null 读；存在且不是 null 仍无效。LEGACY_V1 维持「必须显式 null」
      need(STRESS_NUMBERS.every((key) => row[key] === null || (!legacy && row[key] === undefined)), 'INVALID', `${where} 缺场景／无效输入行的数字必须是 null，不能用 0 或估计值补位`);
      const kind = row.status === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'MISSING';
      const kindLabel = kind === 'INVALID_INPUT' ? '无效输入' : '缺场景';
      // 页面会写「<类别>：<原因>」；原因文本自己已带同一个前缀时去掉，避免「无效输入：无效输入：…」。
      const reason = reasonRaw.trim().replace(new RegExp(`^${kindLabel}[：:]\\s*`), '');
      // 修订 5 E5：白话原因与能否补取自说明登记（协调会话登记的补充计划），scenario 与类别对上才用；页面不自行判断
      const note = detailNotes.stressNote(context.notes, scenario, kind);
      return {
        scenario, label, role, kind, missing: kind === 'MISSING', invalid_input: kind === 'INVALID_INPUT',
        kind_label: kindLabel, reason, missing_reason: reason,
        plain_reason_zh: note ? note.plain_reason_zh : null, fill: note ? note.fill : null,
        simulated: false, in_headline: false,
        max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: null, note: null,
        ...(legacy ? {} : { n: null, mean_R: null }),
      };
    }
    need(row.missing === undefined || row.missing === false, 'INVALID', `${where}.missing`);
    const simulated = field(row, 'simulated', 'stress.simulated', 'bool');
    const supplementary = row.status === 'SUPPLEMENTARY_NOT_IN_CONCLUSION';
    if (supplementary) {
      need(simulated === true && row.in_headline === false, 'INVALID', `${where} 补充行必须 simulated:true 且 in_headline:false`);
    }
    need(row.in_headline === undefined || typeof row.in_headline === 'boolean', 'INVALID', `${where}.in_headline`);
    return {
      scenario, label, role, kind: supplementary ? 'SUPPLEMENTARY' : (simulated ? 'SIMULATED' : 'EXECUTED'),
      missing: false, invalid_input: false, kind_label: null, reason: null, missing_reason: null,
      max_loss_usd: field(row, 'max_loss_usd', 'stress.max_loss_usd'),
      longest_underwater_sessions: field(row, 'longest_underwater_sessions', 'stress.longest_underwater_sessions'),
      recovered: field(row, 'recovered', 'stress.recovered', 'bool'), end_capital: field(row, 'end_capital', 'stress.end_capital'),
      simulated, in_headline: role === 'STRESS' && !simulated && row.in_headline !== false,
      note: simulated ? '模拟序列，不是可交易历史' : null,
      // §5.5：非 LEGACY 档案另报文件自带的笔数与每笔均值 R；风控维度行与参照行逐项相同时标「与参照相同」
      ...(legacy ? {} : {
        n: Number.isInteger(row.n) ? row.n : null, mean_R: optionalFinite(row, 'mean_R'),
        same_as_reference: role === 'RISK_DIMENSION' && Boolean(reference)
          && SAME_AS_REFERENCE_FIELDS.every((key) => row[key] !== undefined && row[key] === reference[key]),
      }),
    };
  });
  const candidates = mapped.filter((row) => row.in_headline);
  const worst = candidates.reduce((best, row) => (!best || row.max_loss_usd > best.max_loss_usd ? row : best), null);
  const stressRowsOnly = mapped.filter((row) => row.role === 'STRESS');
  const counts = {
    executed: stressRowsOnly.filter((row) => row.kind === 'EXECUTED').length,
    simulated: mapped.filter((row) => row.simulated).length,
    missing: stressRowsOnly.filter((row) => row.kind === 'MISSING').length,
    invalid_input: stressRowsOnly.filter((row) => row.kind === 'INVALID_INPUT').length,
    reference: mapped.filter((row) => row.role === 'REFERENCE').length,
    risk_dimension: mapped.filter((row) => row.role === 'RISK_DIMENSION').length,
    ...(legacy ? {} : { same_as_reference: stressRowsOnly.filter((row) => row.kind === 'SAME_AS_REFERENCE').length }),
  };
  const incomplete = counts.missing + counts.invalid_input > 0;
  return {
    // §5.2：非 LEGACY 档案的压力金额写两位小数（单位取档案币种）；US_V5 仍是整数
    ...(legacy ? {} : { money_digits: 2 }),
    rows: mapped,
    headline: worst ? { scenario: worst.scenario, label: worst.label, max_loss_usd: worst.max_loss_usd } : null,
    counts,
    evaluation: {
      complete: !incomplete,
      text: incomplete
        ? `压力评价不完整：缺场景 ${counts.missing} 个、无效输入 ${counts.invalid_input} 个；缺场景按「不足」处理（AC8），模拟和补充行不参与压力结论。`
        : null,
      original: (() => {
        const text = preferZh(stress, 'conclusion');
        return typeof text === 'string' && text.trim() ? text.trim() : null;
      })(),
      original_is_chinese: HAS_CHINESE.test(String(preferZh(stress, 'conclusion') || '')),
    },
  };
}

/**
 * 半凯利的底线取自策略档案（数值 + 币种 + 说明）。LEGACY_V1 档案（US_V5）沿用改造前的字段名 `floor_usd`（投影由 D1 冻结）；
 * 其他档案写 `floor: { value, currency, rule_label_zh }`，页面据此写币种和底线说明，不套用 US_V5 的措辞。
 */
function kellyBlock(doc, profile) {
  const k = doc.half_kelly;
  need(isObject(k), 'MISSING', 'half_kelly');
  need(isObject(k.replay), 'MISSING', 'half_kelly.replay');
  const reading = readingOf(profile);
  if (reading) return kellyBlockReading(doc, k, profile, reading);
  const side = (name) => {
    const part = k.replay[name];
    need(isObject(part), 'MISSING', `half_kelly.replay.${name}`);
    const p = field(part, 'p_below_floor', `half_kelly.replay.${name}.p_below_floor`);
    need(p >= 0 && p <= 1, 'INVALID', `half_kelly.replay.${name}.p_below_floor 不在 0–1`);
    return {
      end_capital_ci: ci(part.end_capital_ci, `half_kelly.replay.${name}.end_capital_ci`),
      max_drawdown: field(part, 'max_drawdown', `half_kelly.replay.${name}.max_drawdown`),
      p_below_floor: p, resamples: Number.isInteger(part.resamples) && part.resamples > 0 ? part.resamples : null,
    };
  };
  const f = field(k, 'f_half', 'half_kelly.f_half');
  const supported = f > 0;
  need(k.supported === undefined || k.supported === supported, 'INVALID', 'half_kelly.supported 与 f_half 不一致');
  const { floor } = profile;
  const legacy = profiles.isLegacyShape(profile);
  const declared = legacy ? k.floor_usd : k.floor;
  need(declared === undefined || declared === floor.value, 'INVALID', `half_kelly.${legacy ? 'floor_usd' : 'floor'} 不是 ${floor.rule_label_zh}`);
  // 修订 5 E1.2：p、b 与「胜率与赔率」表主数字那一行（样本外、生产相位、5 bps）完全相同时才写明来源行；只比对，不另算
  const p = field(k, 'p', 'half_kelly.p');
  const b = field(k, 'b', 'half_kelly.b');
  const main = ((doc.stats && doc.stats.rows) || []).find(isMainRow);
  const sourceRow = main && main.win_rate === p && main.payoff === b
    ? { segment_label: profile.segment_words.OOS || 'OOS', phase_label: profile.phase_words.PRODUCTION || 'PRODUCTION', cost_bps: main.cost_bps } : null;
  const rule = k.basis_zh;
  return {
    p, p_ci: ci(k.p_ci, 'half_kelly.p_ci'), b, b_ci: ci(k.b_ci, 'half_kelly.b_ci'),
    f_star: field(k, 'f_star', 'half_kelly.f_star'), f_half: f, supported,
    source_row: sourceRow, rule_zh: typeof rule === 'string' && rule.trim() ? rule.trim() : null,
    ...(legacy ? { floor_usd: floor.value } : { floor: { value: floor.value, currency: floor.currency, rule_label_zh: floor.rule_label_zh } }),
    half_kelly: side('half_kelly'), fixed_60: side('fixed_60'),
    note: '研究计算，不是仓位建议；现行仓位规则不变',
  };
}

/**
 * 第 5 块，非 LEGACY 档案（§6）：底线读 q0_reading.kelly.floor_field（必须等于档案底线，缺失即无效）；固定风险臂读
 * replay.<fixed_arm.key>；两臂都要有 thresholds 列出的每个概率（0–1）；f* ≤ 0 或 L_R ≤ 0 时 f_half 必须为 0（不重算）。
 * 重抽条数取 identity.config.resamples（有才写）。
 */
function kellyBlockReading(doc, k, profile, reading) {
  const { floor } = profile;
  const spec = reading.kelly;
  const declared = k[spec.floor_field];
  need(declared !== undefined && declared !== null, 'MISSING', `half_kelly.${spec.floor_field}`);
  need(declared === floor.value, 'INVALID', `half_kelly.${spec.floor_field} 不是 ${floor.rule_label_zh}`);
  const config = isObject(doc.identity) && isObject(doc.identity.config) ? doc.identity.config : {};
  const resamples = Number.isInteger(config.resamples) && config.resamples > 0 ? config.resamples : null;
  const side = (name) => {
    const part = k.replay[name];
    need(isObject(part), 'MISSING', `half_kelly.replay.${name}`);
    const thresholds = spec.thresholds.map((threshold) => {
      const p = field(part, threshold.field, `half_kelly.replay.${name}.${threshold.field}`);
      need(p >= 0 && p <= 1, 'INVALID', `half_kelly.replay.${name}.${threshold.field} 不在 0–1`);
      return { field: threshold.field, value: threshold.value, label_zh: threshold.label_zh, p };
    });
    return {
      end_capital_ci: ci(part.end_capital_ci, `half_kelly.replay.${name}.end_capital_ci`),
      max_drawdown: field(part, 'max_drawdown', `half_kelly.replay.${name}.max_drawdown`),
      thresholds, note_zh: typeof part.note === 'string' && part.note.trim() ? part.note.trim() : null,
    };
  };
  const f = field(k, 'f_half', 'half_kelly.f_half');
  const fStar = field(k, 'f_star', 'half_kelly.f_star');
  const supported = f > 0;
  need(k.supported === undefined || k.supported === supported, 'INVALID', 'half_kelly.supported 与 f_half 不一致');
  need(!(fStar <= 0 && f !== 0), 'INVALID', 'f_star ≤ 0 时 f_half 必须为 0');
  need(!(finite(doc.verdict.L_R) && doc.verdict.L_R <= 0 && f !== 0), 'INVALID', 'L_R ≤ 0 时 f_half 必须为 0（K2 §5）');
  const p = field(k, 'p', 'half_kelly.p');
  const b = field(k, 'b', 'half_kelly.b');
  const main = mainRowOf(doc, profile);
  const sourceRow = main && main.win_rate === p && main.payoff === b
    ? { segment_label: profile.segment_words[main.segment], phase_label: profile.phase_words[main.phase], cost_label: reading.cost_words[main.cost] } : null;
  const rule = k.basis_zh;
  return {
    p, p_ci: ci(k.p_ci, 'half_kelly.p_ci'), b, b_ci: ci(k.b_ci, 'half_kelly.b_ci'), f_star: fStar, f_half: f, supported,
    source_row: sourceRow, rule_zh: typeof rule === 'string' && rule.trim() ? rule.trim() : null,
    floor: { value: floor.value, currency: floor.currency, rule_label_zh: floor.rule_label_zh },
    thresholds: spec.thresholds.map((threshold) => ({ field: threshold.field, value: threshold.value, label_zh: threshold.label_zh })),
    half_kelly: side('half_kelly'),
    fixed: { ...side(spec.fixed_arm.key), key: spec.fixed_arm.key, label_zh: spec.fixed_arm.label_zh, resamples },
    note: '研究计算，不是仓位建议；现行仓位规则不变',
  };
}

/** 判据在门槛上的位置：上沿不高于门槛／下沿高于门槛／区间跨过门槛。 */
const positionOf = (lo, hi, threshold) => (hi <= threshold ? 'AT_OR_BELOW' : (lo > threshold ? 'ABOVE' : 'STRADDLES'));

/**
 * 判据逐条（V1 §5.1）：每笔扣费后净 R 均值对门槛 +0.10 R；账户年化对数增长差对门槛 0——
 * 这条差是相对档案里的市场基准的（US_V5：SPY 买入持有，真实文件里它与压力表基线行的 g_vs_spy 是同一组数；
 * 文件可用 `verdict.g_comparator` 另行声明）；相对现金的差（`vs_cash`）并列照报，不参与判定规则。页面不重算：点估计和区间都是文件里的数。
 */
function criteriaRows(v, profile, main = null) {
  const cash = profiles.comparator(profile, 'CASH');
  // §3.3：非 LEGACY 档案的 verdict 没有 mean_R 时，R 行的点估计取主数字行（同一次运行）的 mean_R
  const pointR = finite(v.mean_R) ? v.mean_R : (readingOf(profile) && main && finite(main.mean_R) ? main.mean_R : null);
  const comparator = (v.g_comparator === cash.key ? cash : profiles.comparator(profile, 'MARKET')).label_zh;
  const rows = [];
  if (finite(v.L_R) && finite(v.U_R)) {
    rows.push({
      key: 'R', label: `每笔扣费后净 R 均值（门槛 +${DELTA_R.toFixed(2)} R）`, short: '每笔扣费后净 R 均值', unit: 'R',
      point: pointR, ci: { lo: v.L_R, hi: v.U_R }, threshold: DELTA_R, position: positionOf(v.L_R, v.U_R, DELTA_R),
      fired: v.U_R <= DELTA_R, decisive: true,
    });
  }
  if (finite(v.L_g) && finite(v.U_g)) {
    rows.push({
      key: 'G', label: `相对 ${comparator}的年化对数增长差（95% 区间，门槛 ${DELTA_G}）`, short: `相对 ${comparator}的账户年化对数增长差`, unit: 'pct',
      point: finite(v.g) ? v.g : null, ci: { lo: v.L_g, hi: v.U_g }, threshold: DELTA_G, position: positionOf(v.L_g, v.U_g, DELTA_G),
      fired: v.U_g <= DELTA_G, decisive: true,
    });
  }
  const vsCash = v.vs_cash;
  if (isObject(vsCash) && finite(vsCash.L) && finite(vsCash.U) && v.g_comparator !== cash.key) {
    rows.push({
      key: 'G_CASH', label: `相对${cash.label_zh}的年化对数增长差（95% 区间，门槛 ${DELTA_G}）`, short: `相对${cash.label_zh}的账户年化对数增长差`, unit: 'pct',
      point: finite(vsCash.g) ? vsCash.g : null, ci: { lo: vsCash.L, hi: vsCash.U }, threshold: DELTA_G, position: positionOf(vsCash.L, vsCash.U, DELTA_G),
      fired: false, decisive: false,
    });
  }
  return rows;
}

function verdictBlock(doc, gapped, profile) {
  const v = doc.verdict;
  const resolved = resolveReasons(v.reason_codes, REASON_WORDS);
  return {
    class: v.class, state: v.state, delta_R: DELTA_R, delta_g: DELTA_G,
    L_R: v.L_R === undefined ? null : v.L_R, U_R: v.U_R === undefined ? null : v.U_R,
    L_g: v.L_g === undefined ? null : v.L_g, U_g: v.U_g === undefined ? null : v.U_g,
    mean_R: finite(v.mean_R) ? v.mean_R : null, g: finite(v.g) ? v.g : null,
    n_trades: v.n_trades === undefined ? null : v.n_trades,
    comparators: v.comparators.map((name) => (name === profiles.comparator(profile, 'CASH').key ? profiles.comparator(profile, 'CASH') : profiles.comparator(profile, 'MARKET')).label_zh),
    ci_method: '按月分块 bootstrap 95%', criteria: criteriaRows(v, profile, mainRowOf(doc, profile)), reasons: resolved.known, unknown_reason_codes: resolved.unknown,
    engine_label: (() => { const label = readingOf(profile) ? preferZh(v, 'label') : v.label; return typeof label === 'string' && label.trim() ? label.trim() : null; })(),
    engine_approximation: v.engine_approximation.flag, engine_missing: [...new Set([...(v.engine_approximation.missing || []), ...gapped])],
  };
}

function reasonText(error) {
  if (!(error instanceof K3Error)) return `结果文件无法读取（${error.message}）`;
  if (error.code === 'MISSING') return `结果文件缺 ${error.detail}`;
  if (error.code === 'INVALID') return `结果文件字段无效：${error.detail}`;
  return `${error.code}${error.detail ? `：${error.detail}` : ''}`;
}

/** context（可选）：`notes` = 这条策略的说明登记，`file_sha256` = 锁定结果文件的 sha256（分红口径按它绑定）。 */
function buildBlocks(doc, gapped, profile = profileForDoc(doc), context = {}) {
  const builders = {
    period: () => periodBlock(doc, gapped, profile), account: () => accountBlock(doc, profile, context), winrate: () => winrateBlock(doc, profile),
    stress: () => stressBlock(doc, context, profile), kelly: () => kellyBlock(doc, profile), verdict: () => verdictBlock(doc, gapped, profile),
  };
  return BLOCKS.map(([key, title]) => {
    try { return { key, title, state: 'AVAILABLE', reason: null, data: builders[key]() }; } catch (error) {
      return { key, title, state: 'NOT_BACKTESTED', reason: reasonText(error), data: null };
    }
  });
}

function diagnosisList(doc, profile = profileForDoc(doc)) {
  const items = doc.diagnosis_items;
  if (!Array.isArray(items)) return { state: 'NOT_BACKTESTED', reason: '结果文件缺 diagnosis_items', items: [] };
  try {
    return {
      state: 'AVAILABLE', reason: null,
      items: items.map((item, index) => {
        need(isObject(item), 'INVALID', `diagnosis_items[${index}]`);
        const source = field(item, 'source', `diagnosis_items[${index}].source`, 'string');
        need(SOURCE_LABELS[source], 'INVALID', `diagnosis_items[${index}].source=${source}`);
        const factList = Array.isArray(item.facts_zh) && item.facts_zh.length ? item.facts_zh : item.facts;
        const facts = Array.isArray(factList) ? factList.map((fact) => (typeof fact === 'string' ? fact : fact && fact.text)).filter(Boolean) : [];
        need(facts.length, 'MISSING', `diagnosis_items[${index}].facts`);
        const experiment = item.proposed_experiment || null;
        const rawReason = preferZh(item, 'no_topic_reason') || null;
        const reason = rawReason ? plainNumbers(rawReason) : null;
        need(Boolean(experiment) !== Boolean(reason), 'INVALID', `diagnosis_items[${index}] 须二选一：proposed_experiment 或 no_topic_reason`);
        const queue = experiment ? experimentsOf(profile)[experiment] || { title: experiment, status: '实验状态未登记' } : null;
        return {
          id: item.id || `D${index + 1}`, source, source_label: SOURCE_LABELS[source], facts: facts.map(plainNumbers),
          experiment: experiment ? { id: experiment, title: queue.title, status: queue.status } : null, no_topic_reason: reason,
          state_label: '待验证，不是结论',
        };
      }),
    };
  } catch (error) { return { state: 'NOT_BACKTESTED', reason: reasonText(error), items: [] }; }
}

const EDGE_LABELS = Object.freeze({ SUPPORTED: '有支持证据', NOT_PASSED: '未通过', INSUFFICIENT: '证据不足' });
const trimKind = (label) => String(label).replace(/[：:](缺场景|无效输入)$/, '');

/**
 * 优势结论、压力评价、采用条件分开写（V8.1 §6.7；冻结说明 2 G3）：
 * 压力场景（G2）缺场景或无效输入时，压力评价不完整，采用条件不满足，**无论优势结论是什么**；
 * 这两行永远写在页面的主内容里，不折叠、不并进优势结论。压力块读不出来时同样按不完整处理。
 */
function completenessOf(stressBlock_, verdictState) {
  const edgeLine = `优势结论：${EDGE_LABELS[verdictState] || verdictState}`;
  if (!stressBlock_ || stressBlock_.state !== 'AVAILABLE') {
    return {
      complete: false, edge_line: edgeLine,
      stress_line: `压力评价不完整：压力表无法读取（${stressBlock_ ? stressBlock_.reason : '没有压力表'}）`,
      adoption_line: '采用条件：未满足（必要压力缺失，§6.7）', missing: [], invalid_input: [],
    };
  }
  const rows = stressBlock_.data.rows.filter((row) => row.role === 'STRESS');
  const missing = rows.filter((row) => row.kind === 'MISSING').map((row) => trimKind(row.label));
  const invalid = rows.filter((row) => row.kind === 'INVALID_INPUT').map((row) => trimKind(row.label));
  if (!missing.length && !invalid.length) return { complete: true, edge_line: edgeLine, stress_line: null, adoption_line: null, missing, invalid_input: invalid };
  return {
    complete: false, edge_line: edgeLine,
    stress_line: `压力评价不完整：缺场景 ${missing.length} 个、无效输入 ${invalid.length} 个（${[...missing.map((name) => `${name}：缺场景`), ...invalid.map((name) => `${name}：无效输入`)].join('；')}）`,
    adoption_line: '采用条件：未满足（必要压力缺失，§6.7）', missing, invalid_input: invalid,
  };
}

/** 判据行的一句话：指标、区间、在门槛上的位置。 */
function criterionLine(row) {
  const place = {
    AT_OR_BELOW: row.ci.hi < row.threshold ? '上沿低于门槛' : '上沿不高于门槛', ABOVE: '下沿高于门槛', STRADDLES: '区间跨过门槛',
  }[row.position];
  const fmt = row.unit === 'R' ? rText : pct1;
  const threshold = row.unit === 'R' ? `+${row.threshold.toFixed(2)} R` : String(row.threshold);
  const point = row.unit === 'R' && row.point !== null ? `${rText(row.point)}，` : '';
  return `${row.short} ${point}95% 区间 ${fmt(row.ci.lo)} 至 ${fmt(row.ci.hi)}，${place} ${threshold}`;
}

/**
 * D1（UX 修订 4）：结论依据。写明触发本结论的那条判据——指标、比较对象、区间、门槛，门槛在看到结果前已冻结：
 *   NOT_PASSED   触发的那条（上沿不高于门槛），另一条判据的数字并列在后面；
 *   INSUFFICIENT 不足的原因：引擎近似、样本笔数对门槛笔数、或区间跨门槛（区间对门槛）；
 *   SUPPORTED    下沿高于门槛的那两条。
 * 只读文件里的数字和位置，不重算；与结论自洽（导入时已拒绝越过算术证据的标签）。
 */
function basisOf(v) {
  const rows = v.criteria;
  const decisive = rows.filter((row) => row.decisive);
  const rest = (picked) => rows.filter((row) => !picked.includes(row));
  let main = [];
  let also = [];
  if (v.state === 'NOT_PASSED') {
    const fired = decisive.filter((row) => row.fired);
    main = fired.map(criterionLine);
    also = rest(fired).map(criterionLine);
  } else if (v.state === 'SUPPORTED') {
    main = decisive.filter((row) => row.position === 'ABOVE').map(criterionLine);
    also = rest(decisive.filter((row) => row.position === 'ABOVE')).map(criterionLine);
  } else {
    if (v.engine_approximation) main.push(`使用的是${v.engine_label || `研究引擎近似的当前 D（缺：${v.engine_missing.join('；') || '未列出'}）`}，结论最高只能是证据不足`);
    if (Number.isInteger(v.n_trades) && v.n_trades < MIN_TRADES) main.push(`样本外成熟交易 ${v.n_trades} 笔，少于门槛 ${MIN_TRADES} 笔`);
    const straddling = decisive.filter((row) => row.position === 'STRADDLES');
    main.push(...straddling.map(criterionLine));
    also = rest(straddling).map(criterionLine);
  }
  return { title: '判定依据', main, also, frozen_zh: '门槛在看到结果前已冻结' };
}

/**
 * 限制：结论与限制不得相互矛盾。NOT_PASSED 时这一行叫「其他限制」，只列与结论不冲突的限制
 * （压力评价不完整、近似引擎、样本少），不再写「区间跨过门槛」这类「证据不足」的理由。
 */
function limitOf(v, completeness) {
  if (v.state === 'NOT_PASSED') {
    const parts = [];
    if (completeness && !completeness.complete) {
      parts.push(`压力评价不完整：缺场景 ${completeness.missing.length} 个、无效输入 ${completeness.invalid_input.length} 个`);
    }
    if (v.engine_approximation) parts.push(`使用的是${v.engine_label || `研究引擎近似的当前 D（缺：${v.engine_missing.join('；') || '未列出'}）`}`);
    if (Number.isInteger(v.n_trades) && v.n_trades < MIN_TRADES) parts.push(`样本外只有 ${v.n_trades} 笔成熟交易，少于 ${MIN_TRADES} 笔`);
    return { label: '其他限制', text: `${parts.length ? parts.join('；') : '本结论只对已回测的区间和费用口径成立，不外推到之后的市场'}。` };
  }
  if (v.engine_approximation) return { label: '最大的限制', text: `使用的是${v.engine_label || `研究引擎近似的当前 D（缺：${v.engine_missing.join('；') || '未列出'}）`}，结论最高只能是证据不足。` };
  if (Number.isInteger(v.n_trades) && v.n_trades < MIN_TRADES) return { label: '最大的限制', text: `样本外只有 ${v.n_trades} 笔成熟交易，少于 ${MIN_TRADES} 笔。` };
  // 区间跨门槛的说法取自判据行本身（与「判定依据」同一份数字），不取通用原因码的措辞：原因码不分是哪一条判据
  const straddling = (v.criteria || []).filter((row) => row.decisive && row.position === 'STRADDLES');
  if (straddling.length) return { label: '最大的限制', text: `${straddling.map((row) => row.short).join('、')}的 95% 区间跨过判定门槛，现有样本不足以判定。` };
  if (v.reasons.length) return { label: '最大的限制', text: `${v.reasons[0].text}。` };
  return { label: '最大的限制', text: '本结论只对已回测的区间和费用口径成立，不外推到之后的市场。' };
}

/** C1：三态结论 + 一个主数字及其区间 + 判定依据 + 限制。尚未回测时写「尚未回测」和原因，不写「证据不足」。 */
function conclusionOf(verdictBlock_, doc, completeness = null, profile = profileForDoc(doc)) {
  if (!verdictBlock_ || verdictBlock_.state !== 'AVAILABLE') {
    return {
      state: 'NOT_BACKTESTED', label: '尚未回测', reason: verdictBlock_ ? verdictBlock_.reason : '没有封存结果',
      main_number: null, biggest_limit: '没有完整回测结果前，页面不给策略优劣结论。', limit_label: '最大的限制', basis: null,
    };
  }
  const v = verdictBlock_.data;
  const labels = { SUPPORTED: '有支持证据', NOT_PASSED: '未通过', INSUFFICIENT: '证据不足' };
  const limit = limitOf(v, completeness);
  const reading = readingOf(profile);
  if (reading) return conclusionReading(v, doc, completeness, profile, reading, labels, limit);
  const oos = (doc.stats.rows || []).find(isMainRow);
  const main = oos && Array.isArray(oos.mean_R_ci) && oos.mean_R_ci.length === 2
    ? { label: `${profile.segment_words.OOS || 'OOS'}每笔扣费后净 R 均值（5 bps，${profile.phase_words.PRODUCTION || 'PRODUCTION'}；门槛 +0.10 R）`, value: oos.mean_R, ci: { lo: oos.mean_R_ci[0], hi: oos.mean_R_ci[1] }, unit: 'R' } : null;
  return {
    state: v.state, label: labels[v.state], reason: null, main_number: main, basis: basisOf(v),
    limit_label: limit.label, biggest_limit: limit.text, completeness,
  };
}

/**
 * 非 LEGACY 档案的结论区块（§3.2–§3.4、§5.6）：主数字取 q0_reading.main_row 那一行，标签写它的分段词、费用词、相位词；
 * 主数字下面一行写资金费缺失排除；判定依据下面「另须知道」写档案的 disclosures_zh（冻结 K2 的文字，不是数字）。
 */
function conclusionReading(v, doc, completeness, profile, reading, labels, limit) {
  const row = mainRowOf(doc, profile);
  const { main_row: key, funding_exclusion: funding } = reading;
  const label = `${profile.segment_words[key.segment]}每笔扣费后净 R 均值（${reading.cost_words[key.cost]}，${profile.phase_words[key.phase]}；门槛 +${DELTA_R.toFixed(2)} R）`;
  const main = row && Array.isArray(row.mean_R_ci) && row.mean_R_ci.length === 2
    ? { label, value: row.mean_R, ci: { lo: row.mean_R_ci[0], hi: row.mean_R_ci[1] }, unit: 'R' } : null;
  const excluded = funding && row && Number.isInteger(row[funding.count_field]) && finite(row[funding.share_field])
    ? `主统计不计资金费缺失的 ${row[funding.count_field]} 笔（占 ${pct1(row[funding.share_field])}，${funding.rule_ref_zh}）` : null;
  const basis = basisOf(v);
  return {
    state: v.state, label: labels[v.state], reason: null, main_number: main,
    ...(main ? {} : { main_number_missing_zh: `结果文件缺${label.replace(/（.*$/, '')}那一行` }),
    ...(excluded ? { main_number_note_zh: excluded } : {}),
    basis: reading.disclosures_zh && reading.disclosures_zh.length ? { ...basis, know_zh: [...reading.disclosures_zh] } : basis,
    limit_label: limit.label, biggest_limit: limit.text, completeness,
  };
}

/**
 * 修订 5 E2.2：比较对象的分红口径没有登记（结果文件换了、或从未核实）时，页面写「分红口径未记录」，并把这一项列进待验证问题清单。
 * 只加一条说明，不判定口径。
 */
function withUnrecordedBasis(diagnosis, accountBlock_) {
  const notes = accountBlock_ && accountBlock_.state === 'AVAILABLE' ? accountBlock_.data.comparator_notes || [] : [];
  const missing = notes.filter((note) => note.dividend === 'NOT_RECORDED');
  if (!missing.length || !diagnosis || diagnosis.state !== 'AVAILABLE') return diagnosis;
  return {
    ...diagnosis,
    items: [...diagnosis.items, ...missing.map((note) => ({
      id: `BASIS-${note.key}`, source: 'DATA', source_label: SOURCE_LABELS.DATA,
      facts: [`${note.label}的分红口径在结果文件与说明登记里都没有记录，页面写「${detailNotes.NOT_RECORDED}」；须按引擎实际用的价格序列核实后登记`],
      experiment: null, no_topic_reason: '口径待核实，不是研究题', state_label: '待验证，不是结论',
    }))],
  };
}

// ── 投影 ────────────────────────────────────────────────────────────────────────

/** 档案按锁上的 strategy_ref 取（未登记即抛错）；只有没写 strategy_ref 的锁（直接投影封存文件）才按文件的 schema 找。 */
function project(sealed, lock, profile = lock.strategy_ref ? profiles.mustGet(lock.strategy_ref) : profileForDoc(sealed.doc)) {
  const { doc } = sealed;
  const gapped = validateWhole(doc, profile, { fileSha256: sealed.sha256 });
  const blocks = buildBlocks(doc, gapped, profile, { notes: detailNotes.forStrategy(profile.strategy_ref), file_sha256: sealed.sha256 });
  const verdict = blocks.find((block) => block.key === 'verdict');
  const completeness = completenessOf(blocks.find((block) => block.key === 'stress'), doc.verdict.state);
  return {
    state: 'LOCKED_VERIFIED', result_id: lock.result_id, class: EVAL_CLASS, verdict_state: doc.verdict.state,
    conclusion: conclusionOf(verdict, doc, completeness, profile), blocks,
    diagnosis: withUnrecordedBasis(diagnosisList(doc, profile), blocks.find((block) => block.key === 'account')),
    source: {
      result_id: lock.result_id, file_ref: sealed.file, file_sha256: sealed.sha256, size: sealed.size,
      locked_at: lock.locked_at, locked_by: lock.locked_by, plan_ref: profile.research_program.plan_ref, amendment_ref: profile.research_program.amendment_ref,
      inputs_digest: lock.inputs_digest, engine_digest: lock.engine_digest,
      ...(readingOf(profile) ? supersededOf(doc.identity) : {}),
    },
    production_effect: 'NONE',
  };
}

/**
 * §8 ★(a)：被替代的运行只从结果文件的 identity.supersedes 显示一行「SUPERSEDED，不是结果」——不给 result_id，不显示数字，
 * 不进锁列表、题目列表或里程碑证据；原因与 change_note_zh 原文进技术详情。
 */
function supersededOf(identity) {
  const items = Array.isArray(identity.supersedes) ? identity.supersedes : [];
  if (!items.length) return {};
  return {
    superseded: items.map((item) => ({
      text_zh: `已替代的第一次运行（SUPERSEDED，不是结果）：代码 ${String(item.smartflow_commit || '未写').slice(0, 8)}，结果文件 ${item.result_sha256.slice(0, 8)}…`,
      result_sha256: item.result_sha256, smartflow_commit: item.smartflow_commit || null, reason_zh: item.reason_zh,
    })),
    ...(isText(identity.change_note_zh) ? { change_note_zh: identity.change_note_zh } : {}),
  };
}

function emptyProjection(state, reason, extra = {}) {
  return {
    state, reason, class: EVAL_CLASS,
    conclusion: { state: 'NOT_BACKTESTED', label: '尚未回测', reason, main_number: null, biggest_limit: '没有完整回测结果前，页面不给策略优劣结论。' },
    blocks: BLOCKS.map(([key, title]) => ({ key, title, state: 'NOT_BACKTESTED', reason, data: null })),
    diagnosis: { state: 'NOT_BACKTESTED', reason, items: [] }, source: null, production_effect: 'NONE', ...extra,
  };
}

// ── Result Lock（基线类别）─────────────────────────────────────────────────────────

function locks(caseRef = null) {
  return read(LEDGER()).filter((row) => !caseRef || row.case_ref === caseRef);
}
function headLock(caseRef = CASE_REF) {
  const rows = locks(caseRef);
  return rows.length ? rows[rows.length - 1] : null;
}
function baselineFor(resultId) {
  return locks().find((row) => row.result_id === resultId) || null;
}

function digests(doc) {
  const series = Array.isArray(doc.inputs && doc.inputs.series) ? doc.inputs.series : [];
  need(series.length && series.every((item) => isObject(item) && /^[0-9a-f]{64}$/.test(item.sha256 || '')
    && item.symbol && item.source_host && item.source_ref), 'Q0_INPUT_SERIES_INCOMPLETE');
  const inputs = series.map((item) => [item.symbol, item.role || '', item.source_host, item.source_ref, item.sha256]).sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
  const engine = doc.identity.engine_files;
  need(isObject(engine) && Object.keys(engine).length && Object.values(engine).every((value) => /^[0-9a-f]{40,64}$/.test(value)),
    'Q0_ENGINE_BLOBS_MISSING');
  const smartflow = doc.identity.smartflow_commit;
  need(/^[0-9a-f]{40}$/.test(smartflow || ''), 'Q0_SMARTFLOW_COMMIT_MISSING');
  return {
    inputs_digest: sha256(canonical(inputs)),
    engine_digest: sha256(canonical({ smartflow, files: Object.entries(engine).sort() })),
  };
}

/**
 * §8 新增检查 2：同一 case 已锁的任何文件在 identity.supersedes 里记着这份文件 → 拒绝（带 supersedes 也拒绝）。
 * 已锁文件读不出来时失败关闭，不跳过。
 */
function refuseSupersededFile(fileSha256, caseRef, allowNonActual) {
  for (const row of locks(caseRef)) {
    const locked = readSealed(row.file_ref, { allowNonActual, topLevel: [] });
    const items = isObject(locked.doc.identity) && Array.isArray(locked.doc.identity.supersedes) ? locked.doc.identity.supersedes : [];
    need(!items.some((item) => isObject(item) && item.result_sha256 === fileSha256), 'Q0_RESULT_IS_SUPERSEDED', `${fileSha256.slice(0, 12)}… 已被 ${row.result_id} 替代`);
  }
}

/**
 * 导入并锁定。同一文件重复导入是幂等重放；case 已有另一份锁定时拒绝（防挑最好一次），
 * 除非显式 `supersedes` 指向当前锁并给出 `defectRef` 与 `reason`（旧锁保留）。
 * 策略档案：给了 `strategyRef` 就必须已登记（R3.1，未登记在读文件之前就拒绝，账本不写）；没给时按结果文件的 schema 找。
 * case 默认取档案的 case_ref。
 */
function importBaselineEvaluation(file, {
  registeredBy, strategyRef = null, caseRef = null, allowNonActual = false, supersedes = null, defectRef = null, reason = null, lockedAt = null,
} = {}) {
  authority(registeredBy);
  const pinned = strategyRef === null ? null : profiles.mustGet(strategyRef);
  const sealed = readSealed(file, { allowNonActual });
  const profile = pinned || profileForDoc(sealed.doc);
  caseRef = caseRef || profile.case_ref;
  if (readingOf(profile)) refuseSupersededFile(sealed.sha256, caseRef, allowNonActual);
  validateWhole(sealed.doc, profile, { fileSha256: sealed.sha256 });
  const resultId = `Q0-${sealed.sha256.slice(0, 16)}`;
  const head = headLock(caseRef);
  if (head && head.result_id === resultId) return { ...head, replayHit: true };
  if (head) {
    need(supersedes === head.result_id, 'BASELINE_ALREADY_LOCKED', head.result_id);
    need(defectRef && reason, 'BASELINE_SUPERSEDE_REQUIRES_DEFECT_AND_REASON');
  } else need(!supersedes, 'BASELINE_SUPERSEDE_TARGET_NOT_FOUND', supersedes);
  const core = {
    schema: 'BASELINE_EVALUATION_LOCK_V1', result_id: resultId, case_ref: caseRef, strategy_ref: profile.strategy_ref, eval_class: EVAL_CLASS,
    verdict_state: sealed.doc.verdict.state, file_ref: sealed.file, file_sha256: sealed.sha256, file_size: sealed.size,
    ...digests(sealed.doc), plan_ref: profile.research_program.plan_ref, amendment_ref: profile.research_program.amendment_ref,
    supersedes_ref: supersedes, defect_ref: defectRef, supersede_reason: reason,
    production_effect: 'NONE', locked_by: registeredBy,
  };
  const body = { ...core, locked_at: lockedAt || now() };
  body.lock_hash = sha256(canonical(body));
  return append(LEDGER(), body);
}

// ── 页面读取（指纹＋TTL 缓存）─────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 15 * 1000;

function fingerprintOf(lock) {
  if (!lock) return 'NO_LOCK';
  const stat = (file) => { try { const item = fs.statSync(file); return `${item.size}:${item.mtimeMs}`; } catch (error) { return `ERR:${error.code}`; } };
  return `${lock.lock_hash}|${stat(lock.file_ref)}|${stat(`${lock.file_ref}.sha256`)}`;
}

function buildProjection(lock, { allowNonActual = false } = {}) {
  if (!lock) return emptyProjection('NOT_IMPORTED', '研究会话尚未交付封存的回测结果');
  try {
    const profile = profiles.mustGet(lock.strategy_ref);
    const sealed = readSealed(lock.file_ref, { allowNonActual });
    if (sealed.sha256 !== lock.file_sha256) fail('Q0_RESULT_DRIFTED_AFTER_LOCK', `${lock.file_sha256.slice(0, 12)}…≠${sealed.sha256.slice(0, 12)}…`);
    return project(sealed, lock, profile);
  } catch (error) {
    const missing = error instanceof K3Error && /MISSING/.test(error.code);
    return emptyProjection(missing ? 'MISSING' : 'INVALID', `结果文件校验失败：${reasonText(error)}`, { reason_code: error.code || 'UNKNOWN' });
  }
}

function createProjectionReader({ now: clock = Date.now, ttlMs = CACHE_TTL_MS, failureTtlMs = FAILURE_TTL_MS, head = headLock, build = buildProjection } = {}) {
  const cache = new Map();
  return {
    read(caseRef = CASE_REF) {
      const lock = head(caseRef);
      const stamp = fingerprintOf(lock);
      const hit = cache.get(caseRef);
      if (hit && hit.stamp === stamp && clock() - hit.at < (hit.result.state === 'LOCKED_VERIFIED' ? ttlMs : failureTtlMs)) return hit.result;
      const result = build(lock);
      cache.set(caseRef, { at: clock(), stamp, result });
      return result;
    },
    clear() { cache.clear(); },
  };
}

const defaultReader = createProjectionReader();
const readProjection = (caseRef = CASE_REF) => defaultReader.read(caseRef);
const clearCache = () => defaultReader.clear();

/** 同类的导入器（Q1 对比）复用的内部工具；不含任何会改变 Q0 行为的东西。 */
const internals = {
  K3Error, fail, need, field, ci, finite, isObject, sha256, canonical, authority, reasonText, digests,
  stressRole, hasNoSeries, preferZh, trimKind, HAS_CHINESE, STRESS_NUMBERS, KNOWN_STRESS_STATUS, NON_ACTUAL_PATH, peakReadout,
  REASON_WORDS, EDGE_LABELS, SOURCE_LABELS, EXPERIMENTS, SEGMENT_LABELS, resolveReasons, plainNumbers, pct1, rText,
  profileForDoc,
};

module.exports = {
  internals, RESULT_SCHEMA, EVAL_CLASS, CASE_REF, STRATEGY_REF, TOP_LEVEL, STATES, DELTA_R, DELTA_G, MIN_TRADES, FLOOR_USD,
  BLOCKS, EXPERIMENTS, LEDGER, isMainRow, mainRowTest, readSealed, validateWhole, buildBlocks, diagnosisList, conclusionOf, project,
  emptyProjection, completenessOf, importBaselineEvaluation, headLock, locks, baselineFor, createProjectionReader, readProjection,
  clearCache, fingerprintOf, buildProjection,
};
