'use strict';

/**
 * K3：外部产出的封存基线评价（US_V5 M2 Q0）进入 QRP 的位置。
 *
 * 研究会话在 Mac 上产出 `US_V5_M2_Q0_RESULT_V1`（一个 JSON 加旁边的 sha256 文件）。QRP 只读导入：
 *   1. `importBaselineEvaluation`（命令行，完成权威）校验封存文件并追加一条 `BASELINE_EVALUATION_LOCK_V1`——
 *      Result Lock 的基线类别 `BASELINE_EVALUATION_V1`（SUPPORTED / NOT_PASSED / INSUFFICIENT，比较对象
 *      SPY_BUY_HOLD / CASH）。每个 case 只锁一次，改锁必须引用缺陷并写原因，旧锁保留；
 *   2. `readProjection`（页面）每次现场复验文件 sha256，再把结果投影成「结论」和六块「回测结论卡」。
 *      文件漂移、缺失、封存校验失败、复现性证明缺失或判定越过算术证据，整卡失败关闭。
 *
 * 页面不重算：所有数字来自结果文件。这里只做封存校验、一致性校验和人话标签。没有 HTTP 写入口，
 * 不使用交易凭证，不写生产参数或账本。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');

const RESULT_SCHEMA = 'US_V5_M2_Q0_RESULT_V1';
const EVAL_CLASS = 'BASELINE_EVALUATION_V1';
const CASE_REF = 'RRC-US-V5-3000-V8-1-M0';
const STRATEGY_REF = 'US_V5_ETF_3000USD';
const PLAN_REF = 'docs/contracts/US_V5_M2_RESEARCH_PROGRAM_V1.md';
const AMENDMENT_REF = 'docs/contracts/US_V5_M2_RESEARCH_PROGRAM_V1_AMENDMENT_1.md';
const TOP_LEVEL = Object.freeze(['identity', 'inputs', 'gates', 'arms', 'stats', 'stress', 'half_kelly',
  'formula_table', 'verdict', 'diagnosis_items', 'reproducibility']);
const STATES = Object.freeze(['SUPPORTED', 'NOT_PASSED', 'INSUFFICIENT']);
const COMPARATORS = Object.freeze(['SPY_BUY_HOLD', 'CASH']);
const ARMS = Object.freeze([['D', '本策略'], ['SPY_BUY_HOLD', 'SPY 买入持有'], ['CASH', '现金']]);
const DELTA_R = 0.10; // 计划 §3 冻结，看见结果后不改
const DELTA_G = 0;
const MIN_TRADES = 30;
const FLOOR_USD = 1800;
const BLOCKS = Object.freeze([
  ['period', '回测周期与覆盖'], ['account', '账户结果'], ['winrate', '胜率与赔率'],
  ['stress', '压力测试'], ['kelly', '半凯利'], ['verdict', '三态结论与判据'],
]);
const SEGMENT_LABELS = Object.freeze({ 'IS-a': '开发期 A', 'IS-b': '开发期 B', OOS: '样本外' });
const PHASE_LABELS = Object.freeze({ PRODUCTION: '生产相位', PLUS_60MIN: '相位 +60 分钟', MINUS_60MIN: '相位 −60 分钟' });
const SOURCE_LABELS = Object.freeze({
  DATA: '数据', SELECTION: '选标的', ENTRY_EXIT: '进出规则', RISK: '风控', INSTRUMENT: '工具', EXECUTION: '执行',
});
const EXPERIMENTS = Object.freeze({
  Q1: { title: 'T3：处于趋势时推迟 5 日 TIME stop', status: '排队：Q0 锁定之后开始（验收已签，HK 前向影子在跑）' },
  Q2: { title: '收益来自信号还是杠杆', status: '排队：可与 Q1 并行' },
  Q3: { title: '选对象了吗：对比简单基准', status: '排队：Q1 之后' },
  Q4: { title: '风险预算、集中度、冷却与熔断', status: '候选形成后立题' },
});
const REASON_WORDS = Object.freeze({
  ENGINE_APPROXIMATION: '研究引擎只是当前 D 的近似',
  A0_NOT_PASSED: '引擎对齐关卡 A0 未通过',
  SAMPLE_LT_30: '成熟交易少于 30 笔',
  CI_STRADDLES_DELTA: '区间跨过判定门槛',
  COVERAGE_INSUFFICIENT: '历史覆盖不足',
  CI_G_STRADDLES_ZERO: '年化对数增长区间跨过 0',
  STRESS_SCENARIO_MISSING: '压力场景有缺（缺场景按不足处理）',
});
const NON_ACTUAL_PATH = /(^|[\\/._-])(fixture|demo|mock|synthetic)([\\/._-]|$)/i;

const LEDGER = () => path.join(dataDir('research'), 'baseline_evaluations.jsonl');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

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
function readSealed(file, { allowNonActual = false } = {}) {
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
  const missing = TOP_LEVEL.filter((key) => doc[key] === undefined || doc[key] === null);
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

function validateWhole(doc) {
  const repro = doc.reproducibility;
  need(isObject(repro) && typeof repro.command === 'string' && repro.command && Array.isArray(repro.runs)
    && repro.runs.length >= 2 && repro.runs.every((run) => isObject(run) && /^[0-9a-f]{64}$/.test(run.sha256 || ''))
    && new Set(repro.runs.map((run) => run.sha256)).size === 1 && repro.identical === true,
  'Q0_RESULT_NOT_REPRODUCED');
  const identity = doc.identity;
  need(isObject(identity) && identity.schema === RESULT_SCHEMA, 'Q0_RESULT_SCHEMA_UNSUPPORTED', identity && identity.schema);

  const verdict = doc.verdict;
  need(isObject(verdict) && verdict.class === EVAL_CLASS, 'Q0_VERDICT_CLASS_UNSUPPORTED', verdict && verdict.class);
  need(STATES.includes(verdict.state), 'Q0_VERDICT_STATE_UNSUPPORTED', verdict.state);
  need(Array.isArray(verdict.comparators) && COMPARATORS.every((name) => verdict.comparators.includes(name))
    && verdict.comparators.length === COMPARATORS.length, 'Q0_VERDICT_COMPARATORS_CHANGED');
  need(verdict.delta_R === DELTA_R && verdict.delta_g === DELTA_G, 'Q0_VERDICT_DELTA_CHANGED', `${verdict.delta_R}/${verdict.delta_g}`);
  need(verdict.ci_method === 'MONTHLY_BLOCK_BOOTSTRAP_95', 'Q0_VERDICT_CI_METHOD_CHANGED', verdict.ci_method);
  need(isObject(verdict.engine_approximation) && typeof verdict.engine_approximation.flag === 'boolean'
    && Array.isArray(verdict.engine_approximation.missing), 'Q0_VERDICT_ENGINE_APPROXIMATION_MISSING');
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

function periodBlock(doc, gapped) {
  const segments = doc.inputs && doc.inputs.segments;
  need(Array.isArray(segments) && segments.length, 'MISSING', 'inputs.segments');
  const census = doc.inputs.census;
  need(Array.isArray(census) && census.length, 'MISSING', 'inputs.census');
  const verdict = doc.verdict;
  const missing = [...new Set([...(verdict.engine_approximation.missing || []), ...gapped])];
  return {
    segments: segments.map((segment) => ({
      id: field(segment, 'id', 'segment.id', 'string'), label: SEGMENT_LABELS[segment.id] || segment.id,
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

function accountBlock(doc) {
  const out = [];
  let dates = null;
  for (const [key, label] of ARMS) {
    const arm = doc.arms[key];
    need(isObject(arm), 'MISSING', `arms.${key}`);
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
      recovered: field(summary, 'recovered', `arms.${key}.summary.recovered`, 'bool'),
      sessions: equity.values.length, trades: Array.isArray(arm.trades) ? arm.trades.length : null,
    });
  }
  return { arms: out, start: dates[0], end: dates[dates.length - 1] };
}

function winrateBlock(doc) {
  const rows = doc.stats && doc.stats.rows;
  need(Array.isArray(rows) && rows.length, 'MISSING', 'stats.rows');
  const table = doc.formula_table;
  need(isObject(table) && table.kind === 'FORMULA_NOT_BACKTEST' && Array.isArray(table.cells) && table.cells.length,
    'INVALID', 'formula_table 必须标 FORMULA_NOT_BACKTEST');
  const hasPlus = rows.some((row) => row && row.phase === 'PLUS_60MIN');
  const hasMinus = rows.some((row) => row && row.phase === 'MINUS_60MIN');
  const merged = hasPlus && !hasMinus; // 120 分钟扫描下 −60 与 +60 是同一组时刻，研究会话只列一行
  return {
    notes: merged ? ['相位 ±60 分钟：扫描间隔 120 分钟时，提前 60 分钟与推后 60 分钟落在同一组时刻，所以只列一行。'] : [],
    rows: rows.map((row) => {
      const win = field(row, 'win_rate', 'stats.win_rate');
      need(win >= 0 && win <= 1, 'INVALID', 'stats.win_rate 不在 0–1');
      need(Number.isInteger(row.n) && row.n >= 0, 'INVALID', 'stats.n');
      return {
        segment: field(row, 'segment', 'stats.segment', 'string'), segment_label: SEGMENT_LABELS[row.segment] || row.segment,
        cost_bps: field(row, 'cost_bps', 'stats.cost_bps'), phase: field(row, 'phase', 'stats.phase', 'string'),
        phase_label: merged && row.phase === 'PLUS_60MIN' ? '相位 ±60 分钟' : (PHASE_LABELS[row.phase] || row.phase), n: row.n, win_rate: win,
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

const STRESS_NUMBERS = ['max_loss_usd', 'longest_underwater_sessions', 'recovered', 'end_capital'];
const KNOWN_STRESS_STATUS = Object.freeze(['MISSING_SCENARIO', 'INVALID_INPUT', 'SUPPLEMENTARY_NOT_IN_CONCLUSION']);

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
function stressBlock(doc) {
  const stress = doc.stress;
  const rows = stress && stress.rows;
  need(Array.isArray(rows) && rows.length, 'MISSING', 'stress.rows');
  const mapped = rows.map((row, index) => {
    const where = `stress.rows[${index}]`;
    need(isObject(row), 'INVALID', where);
    const scenario = field(row, 'scenario', `${where}.scenario`, 'string');
    const labelText = preferZh(row, 'label');
    const label = typeof labelText === 'string' && labelText ? labelText : scenario;
    const role = stressRole(row);
    need(row.status === undefined || KNOWN_STRESS_STATUS.includes(row.status), 'INVALID', `${where}.status=${row.status} 不认识`);
    if (hasNoSeries(row)) {
      // 原因语言（冻结说明 2 G1）：先 missing_reason（F1 的冻结字段），再 reason_zh，最后 reason。
      const reasonRaw = [row.missing_reason, row.reason_zh, row.reason].find((item) => typeof item === 'string' && item.trim());
      need(reasonRaw, 'MISSING', `${where}.reason`);
      need(STRESS_NUMBERS.every((key) => row[key] === null), 'INVALID', `${where} 缺场景／无效输入行的数字必须是 null，不能用 0 或估计值补位`);
      const kind = row.status === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'MISSING';
      const kindLabel = kind === 'INVALID_INPUT' ? '无效输入' : '缺场景';
      // 页面会写「<类别>：<原因>」；原因文本自己已带同一个前缀时去掉，避免「无效输入：无效输入：…」。
      const reason = reasonRaw.trim().replace(new RegExp(`^${kindLabel}[：:]\\s*`), '');
      return {
        scenario, label, role, kind, missing: kind === 'MISSING', invalid_input: kind === 'INVALID_INPUT',
        kind_label: kindLabel, reason, missing_reason: reason,
        simulated: false, in_headline: false,
        max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: null, note: null,
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
  };
  const incomplete = counts.missing + counts.invalid_input > 0;
  return {
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

function kellyBlock(doc) {
  const k = doc.half_kelly;
  need(isObject(k), 'MISSING', 'half_kelly');
  need(isObject(k.replay), 'MISSING', 'half_kelly.replay');
  const side = (name) => {
    const part = k.replay[name];
    need(isObject(part), 'MISSING', `half_kelly.replay.${name}`);
    const p = field(part, 'p_below_floor', `half_kelly.replay.${name}.p_below_floor`);
    need(p >= 0 && p <= 1, 'INVALID', `half_kelly.replay.${name}.p_below_floor 不在 0–1`);
    return {
      end_capital_ci: ci(part.end_capital_ci, `half_kelly.replay.${name}.end_capital_ci`),
      max_drawdown: field(part, 'max_drawdown', `half_kelly.replay.${name}.max_drawdown`),
      p_below_floor: p,
    };
  };
  const f = field(k, 'f_half', 'half_kelly.f_half');
  const supported = f > 0;
  need(k.supported === undefined || k.supported === supported, 'INVALID', 'half_kelly.supported 与 f_half 不一致');
  need(k.floor_usd === undefined || k.floor_usd === FLOOR_USD, 'INVALID', 'half_kelly.floor_usd 不是 Rule 1b 的 1,800');
  return {
    p: field(k, 'p', 'half_kelly.p'), p_ci: ci(k.p_ci, 'half_kelly.p_ci'), b: field(k, 'b', 'half_kelly.b'), b_ci: ci(k.b_ci, 'half_kelly.b_ci'),
    f_star: field(k, 'f_star', 'half_kelly.f_star'), f_half: f, supported,
    floor_usd: FLOOR_USD, half_kelly: side('half_kelly'), fixed_60: side('fixed_60'),
    note: '研究计算，不是仓位建议；现行仓位规则不变',
  };
}

function verdictBlock(doc, gapped) {
  const v = doc.verdict;
  const reasons = (Array.isArray(v.reason_codes) ? v.reason_codes : []).map((code) => ({ code, text: REASON_WORDS[code] || `原因码 ${code}` }));
  return {
    class: v.class, state: v.state, delta_R: DELTA_R, delta_g: DELTA_G,
    L_R: v.L_R === undefined ? null : v.L_R, U_R: v.U_R === undefined ? null : v.U_R,
    L_g: v.L_g === undefined ? null : v.L_g, U_g: v.U_g === undefined ? null : v.U_g,
    n_trades: v.n_trades === undefined ? null : v.n_trades, comparators: v.comparators.map((name) => (name === 'CASH' ? '现金' : 'SPY 买入持有')),
    ci_method: '按月分块 bootstrap 95%', reasons,
    engine_label: typeof v.label === 'string' && v.label.trim() ? v.label.trim() : null,
    engine_approximation: v.engine_approximation.flag, engine_missing: [...new Set([...(v.engine_approximation.missing || []), ...gapped])],
  };
}

function reasonText(error) {
  if (!(error instanceof K3Error)) return `结果文件无法读取（${error.message}）`;
  if (error.code === 'MISSING') return `结果文件缺 ${error.detail}`;
  if (error.code === 'INVALID') return `结果文件字段无效：${error.detail}`;
  return `${error.code}${error.detail ? `：${error.detail}` : ''}`;
}

function buildBlocks(doc, gapped) {
  const builders = {
    period: () => periodBlock(doc, gapped), account: () => accountBlock(doc), winrate: () => winrateBlock(doc),
    stress: () => stressBlock(doc), kelly: () => kellyBlock(doc), verdict: () => verdictBlock(doc, gapped),
  };
  return BLOCKS.map(([key, title]) => {
    try { return { key, title, state: 'AVAILABLE', reason: null, data: builders[key]() }; } catch (error) {
      return { key, title, state: 'NOT_BACKTESTED', reason: reasonText(error), data: null };
    }
  });
}

function diagnosisList(doc) {
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
        const reason = preferZh(item, 'no_topic_reason') || null;
        need(Boolean(experiment) !== Boolean(reason), 'INVALID', `diagnosis_items[${index}] 须二选一：proposed_experiment 或 no_topic_reason`);
        const queue = experiment ? EXPERIMENTS[experiment] || { title: experiment, status: '实验状态未登记' } : null;
        return {
          id: item.id || `D${index + 1}`, source, source_label: SOURCE_LABELS[source], facts,
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

/** C1：三态结论 + 一个主数字及其区间 + 一个最大的限制。尚未回测时写「尚未回测」和原因，不写「证据不足」。 */
function conclusionOf(verdictBlock_, doc, completeness = null) {
  if (!verdictBlock_ || verdictBlock_.state !== 'AVAILABLE') {
    return {
      state: 'NOT_BACKTESTED', label: '尚未回测', reason: verdictBlock_ ? verdictBlock_.reason : '没有封存结果',
      main_number: null, biggest_limit: '没有完整回测结果前，页面不给策略优劣结论。',
    };
  }
  const v = verdictBlock_.data;
  const labels = { SUPPORTED: '有支持证据', NOT_PASSED: '未通过', INSUFFICIENT: '证据不足' };
  let limit;
  if (v.engine_approximation) limit = `使用的是${v.engine_label || `研究引擎近似的当前 D（缺：${v.engine_missing.join('；') || '未列出'}）`}，结论最高只能是证据不足。`;
  else if (Number.isInteger(v.n_trades) && v.n_trades < MIN_TRADES) limit = `样本外只有 ${v.n_trades} 笔成熟交易，少于 ${MIN_TRADES} 笔。`;
  else if (v.reasons.length) limit = `${v.reasons[0].text}。`;
  else limit = '本结论只对已回测的区间和费用口径成立，不外推到之后的市场。';
  const oos = (doc.stats.rows || []).find((row) => row.segment === 'OOS' && row.cost_bps === 5 && row.phase === 'PRODUCTION');
  const main = oos && Array.isArray(oos.mean_R_ci) && oos.mean_R_ci.length === 2
    ? { label: '样本外每笔扣费后净 R 均值（5 bps，生产相位）', value: oos.mean_R, ci: { lo: oos.mean_R_ci[0], hi: oos.mean_R_ci[1] }, unit: 'R' } : null;
  return { state: v.state, label: labels[v.state], reason: null, main_number: main, biggest_limit: limit, completeness };
}

// ── 投影 ────────────────────────────────────────────────────────────────────────

function project(sealed, lock) {
  const { doc } = sealed;
  const gapped = validateWhole(doc);
  const blocks = buildBlocks(doc, gapped);
  const verdict = blocks.find((block) => block.key === 'verdict');
  const completeness = completenessOf(blocks.find((block) => block.key === 'stress'), doc.verdict.state);
  if (verdict.state === 'AVAILABLE') verdict.data.completeness = completeness;
  return {
    state: 'LOCKED_VERIFIED', result_id: lock.result_id, class: EVAL_CLASS, verdict_state: doc.verdict.state,
    conclusion: conclusionOf(verdict, doc, completeness), blocks, diagnosis: diagnosisList(doc),
    source: {
      result_id: lock.result_id, file_ref: sealed.file, file_sha256: sealed.sha256, size: sealed.size,
      locked_at: lock.locked_at, locked_by: lock.locked_by, plan_ref: PLAN_REF, amendment_ref: AMENDMENT_REF,
      inputs_digest: lock.inputs_digest, engine_digest: lock.engine_digest,
    },
    production_effect: 'NONE',
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
 * 导入并锁定。同一文件重复导入是幂等重放；case 已有另一份锁定时拒绝（防挑最好一次），
 * 除非显式 `supersedes` 指向当前锁并给出 `defectRef` 与 `reason`（旧锁保留）。
 */
function importBaselineEvaluation(file, {
  registeredBy, caseRef = CASE_REF, allowNonActual = false, supersedes = null, defectRef = null, reason = null, lockedAt = null,
} = {}) {
  authority(registeredBy);
  const sealed = readSealed(file, { allowNonActual });
  validateWhole(sealed.doc);
  const resultId = `Q0-${sealed.sha256.slice(0, 16)}`;
  const head = headLock(caseRef);
  if (head && head.result_id === resultId) return { ...head, replayHit: true };
  if (head) {
    need(supersedes === head.result_id, 'BASELINE_ALREADY_LOCKED', head.result_id);
    need(defectRef && reason, 'BASELINE_SUPERSEDE_REQUIRES_DEFECT_AND_REASON');
  } else need(!supersedes, 'BASELINE_SUPERSEDE_TARGET_NOT_FOUND', supersedes);
  const core = {
    schema: 'BASELINE_EVALUATION_LOCK_V1', result_id: resultId, case_ref: caseRef, strategy_ref: STRATEGY_REF, eval_class: EVAL_CLASS,
    verdict_state: sealed.doc.verdict.state, file_ref: sealed.file, file_sha256: sealed.sha256, file_size: sealed.size,
    ...digests(sealed.doc), plan_ref: PLAN_REF, amendment_ref: AMENDMENT_REF,
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
    const sealed = readSealed(lock.file_ref, { allowNonActual });
    if (sealed.sha256 !== lock.file_sha256) fail('Q0_RESULT_DRIFTED_AFTER_LOCK', `${lock.file_sha256.slice(0, 12)}…≠${sealed.sha256.slice(0, 12)}…`);
    return project(sealed, lock);
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

module.exports = {
  RESULT_SCHEMA, EVAL_CLASS, CASE_REF, STRATEGY_REF, TOP_LEVEL, STATES, DELTA_R, DELTA_G, MIN_TRADES, FLOOR_USD,
  BLOCKS, EXPERIMENTS, LEDGER, readSealed, validateWhole, buildBlocks, diagnosisList, conclusionOf, project,
  emptyProjection, completenessOf, importBaselineEvaluation, headLock, locks, baselineFor, createProjectionReader, readProjection,
  clearCache, fingerprintOf, buildProjection,
};
