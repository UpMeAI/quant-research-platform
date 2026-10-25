'use strict';

/**
 * Q2（收益来自信号还是杠杆：Q2a 归因 + Q2b 1× 载体对当前 D）的登记项，出自冻结的 Q2 K2（660237c8…）裁定 4–6。
 *
 *   - 判定只按账户层面配对 g（单变体，95% 区间，没有 Bonferroni）：L_g > 0 → SUPPORTED，U_g ≤ 0 → NOT_PASSED，其余
 *     INSUFFICIENT；G1 不成立时只能是 INSUFFICIENT。每笔净 R 对 +0.10 R 只报告、不参与判定；
 *   - 候选臂 CANDIDATE_1X；判据集 G1、P_G、F3；必填常数 δ_g 0、δ_R 0.10；
 *   - oos_reuse 必须是 false（并写 oos_reuse_detail），带 OOS_REUSED_FOR_SELECTION 反而矛盾；
 *   - 必须有归因块 attribution（Q2a）：各行加总对上基线臂的净盈亏，残差 0，监管费按日进位差单列一行；
 *   - 必须披露两臂的敞口（平均名义金额、在场时间占比、名义上限拒绝与削减次数）；
 *   - SUPPORTED 的人话是「完整账户的对数增长更好（不等于信号 alpha 更大）」。
 * 规格：docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2.md。
 * 与 Q3b 共用的部分（常数、判定、敞口、效应／判据／结论块）在 paired_g.js，本文件只留 Q2 自己的：归因块、文字、登记项。
 */
const {
  fail, need, finite, isObject, preferZh, E, pick, BASE_KEYS,
} = require('../common');
const paired = require('./paired_g');

const { DELTA_G, DELTA_R, MIN_TRADES } = paired;
const K2_REF = 'docs/contracts/US_V5_M2_Q2_SIGNAL_VS_LEVERAGE_K2_V1.md';
const K2_SHA256 = '660237c8823a5961c70ca78c8685343adb34ff2b35f192146d630a508f45ff6a';
const RECONCILE_TOLERANCE = 1e-6; // K2：对账残差 ≤ 1e-6 USD，否则 BLOCKED (ENGINE_PARITY)
const PNL_LINK_TOLERANCE = 1e-3; // 基线臂 summary 的期末资本只存到小数点后 4 位

const COMPONENT_LABELS = Object.freeze({
  PARENT_SIGNAL: '母序列信号', SIGNAL: '母序列信号',
  LEVERAGE_PATH: '杠杆与路径', LEVERAGE_AND_PATH: '杠杆与路径',
  SINGLE_STOCK_2X: '单股 2×（不可分）', SINGLE_STOCK_2X_INSEPARABLE: '单股 2×（不可分）',
  COST: '费用（含在成交价里的 5 bps／边）', COST_SLIPPAGE: '费用（含在成交价里的 5 bps／边）', SLIPPAGE: '费用（含在成交价里的 5 bps／边）',
  REG_FEE: '监管费（逐笔未进位）', REGULATORY_FEE: '监管费（逐笔未进位）',
});
const CLASS_LABELS = Object.freeze({
  INDEX: '指数', SECTOR: '行业', LEVERAGED_3X_SECTOR: '3× 行业', SECTOR_3X: '3× 行业', SINGLE_STOCK_2X: '单股 2×', INVERSE: '反向',
});

// ── 归因（Q2a，必填；敞口披露在 paired_g.js）──────────────────────────────────────

const sumOf = (values) => values.reduce((total, value) => total + value, 0);
const near = (left, right, tolerance) => Math.abs(left - right) <= tolerance;

function validateSegment(entry, segment, name, baselinePnl) {
  const where = `attribution.${name}`;
  const bad = (detail) => fail(E(entry, 'ATTRIBUTION_SEGMENT_INVALID'), detail);
  const nope = (detail) => fail(E(entry, 'ATTRIBUTION_DOES_NOT_RECONCILE'), detail);
  if (!isObject(segment)) bad(where);
  if (!(Array.isArray(segment.by_class) && segment.by_class.length)) bad(`${where}.by_class`);
  if (!(isObject(segment.total) && isObject(segment.total.usd))) bad(`${where}.total.usd`);
  const components = Object.keys(segment.total.usd);
  if (!components.length) bad(`${where}.total.usd 没有任何栏`);
  const cell = (container, key, label) => {
    if (!(isObject(container) && Object.prototype.hasOwnProperty.call(container, key))) bad(`${label}.${key}`);
    const value = container[key];
    if (!(value === null || finite(value))) bad(`${label}.${key}`);
    return value === null ? 0 : value; // null = 该类不适用（例如单股 2× 没有母序列拆分），加总时不计
  };
  segment.by_class.forEach((row, index) => {
    if (!(isObject(row) && typeof row.class === 'string' && row.class)) bad(`${where}.by_class[${index}].class`);
    components.forEach((key) => cell(row.usd, key, `${where}.by_class[${index}].usd`));
  });
  const totals = components.map((key) => cell(segment.total.usd, key, `${where}.total.usd`));
  components.forEach((key, index) => {
    const columnSum = sumOf(segment.by_class.map((row) => cell(row.usd, key, `${where}.by_class.usd`)));
    if (!near(totals[index], columnSum, RECONCILE_TOLERANCE)) nope(`${where}.${key}：各类相加 ${columnSum} ≠ 合计 ${totals[index]}`);
  });
  const rc = segment.reconcile;
  if (!isObject(rc)) bad(`${where}.reconcile`);
  for (const key of ['account_pnl', 'sum_components', 'residual', 'reg_daily_rounding']) if (!finite(rc[key])) bad(`${where}.reconcile.${key}`);
  // 监管费按日进位差是账户层面的单独一行，不能混进任何一栏
  if (components.some((key) => /DAILY.*ROUND|ROUND.*DAILY/i.test(key))) {
    fail(E(entry, 'ATTRIBUTION_DAILY_ROUNDING_NOT_SEPARATE'), `${where}.total.usd`);
  }
  const sum = sumOf(totals) + rc.reg_daily_rounding;
  if (!near(rc.sum_components, sum, RECONCILE_TOLERANCE)) nope(`${where}.sum_components ${rc.sum_components} ≠ 各栏加监管费日进位差 ${sum}`);
  if (!near(rc.residual, rc.account_pnl - rc.sum_components, RECONCILE_TOLERANCE)) nope(`${where}.residual ${rc.residual} ≠ 账户盈亏 − 各栏之和`);
  if (Math.abs(rc.residual) > RECONCILE_TOLERANCE) {
    fail(E(entry, 'ATTRIBUTION_RESIDUAL_NONZERO'), `${where}.residual=${rc.residual}`);
  }
  if (baselinePnl !== null && !near(rc.account_pnl, baselinePnl, PNL_LINK_TOLERANCE)) {
    fail(E(entry, 'ATTRIBUTION_NOT_BASELINE_PNL'), `${where}.account_pnl ${rc.account_pnl} ≠ 基线臂净盈亏 ${baselinePnl}`);
  }
}

/** 归因要对上的是**基线臂**的净盈亏（期末 − 期初），不是候选臂的；IS 段没有对应的臂，只核内部对账。 */
function validateAttribution(entry, doc) {
  const attribution = doc.attribution;
  need(isObject(attribution), E(entry, 'ATTRIBUTION_MISSING'));
  const base = pick(doc.arms, BASE_KEYS);
  const equity = isObject(base) && isObject(base.equity) ? base.equity.values : null;
  const end = isObject(base) && isObject(base.summary) ? base.summary.end_capital : null;
  need(Array.isArray(equity) && equity.length && finite(equity[0]) && finite(end), E(entry, 'ATTRIBUTION_NOT_BASELINE_PNL'), '基线臂权益序列缺失');
  validateSegment(entry, attribution.oos, 'oos', end - equity[0]);
  validateSegment(entry, attribution.is, 'is', null);
}

function validateExtras(entry, doc) {
  paired.validateExposure(entry, doc);
  validateAttribution(entry, doc);
}

// ── 块 ──────────────────────────────────────────────────────────────────────────

const count = paired.count;

/** Q2 自己的块构造器：归因表；其余（问题、效应、敞口、判据、结论）用 paired_g.js 里共用的，文字来自 `texts`。 */
function builders(entry, doc) {
  const shared = paired.builders(entry, doc);
  return {
    ...shared,
    attribution() {
      const attribution = doc.attribution;
      need(isObject(attribution), 'MISSING', 'attribution');
      const columnKeys = isObject(attribution.oos) && isObject(attribution.oos.total) && isObject(attribution.oos.total.usd) ? Object.keys(attribution.oos.total.usd) : [];
      need(columnKeys.length, 'MISSING', 'attribution.oos.total.usd');
      const declared = Array.isArray(attribution.columns) ? attribution.columns.filter(isObject) : [];
      const columns = columnKeys.map((key) => {
        const found = declared.find((item) => item.key === key);
        const label = found ? preferZh(found, 'label') : null;
        return { key, label: typeof label === 'string' && label ? label : (COMPONENT_LABELS[key] || key) };
      });
      const segment = (raw, name) => {
        need(isObject(raw), 'MISSING', `attribution.${name}`);
        const values = (container, where) => Object.fromEntries(columns.map((column) => {
          const value = container && container[column.key];
          return [column.key, finite(value) ? value : null];
        }));
        const window = Array.isArray(raw.window) && raw.window.length === 2 ? raw.window.map(String) : null;
        return {
          window,
          rows: raw.by_class.map((row) => ({
            class: row.class, label: typeof preferZh(row, 'label') === 'string' && preferZh(row, 'label') ? preferZh(row, 'label') : (CLASS_LABELS[row.class] || row.class),
            n_trades: count(row.n_trades), usd: values(row.usd), r: isObject(row.r) ? values(row.r) : null,
          })),
          total: { n_trades: count(raw.total.n_trades), usd: values(raw.total.usd), r: isObject(raw.total.r) ? values(raw.total.r) : null },
          account_pnl: raw.reconcile.account_pnl, sum_components: raw.reconcile.sum_components, residual: raw.reconcile.residual,
          reg_daily_rounding: raw.reconcile.reg_daily_rounding,
        };
      };
      const limits = isObject(attribution.fill_limits) ? attribution.fill_limits : null;
      const definitions = Array.isArray(attribution.definitions_zh) ? attribution.definitions_zh.filter((item) => typeof item === 'string')
        : (typeof attribution.definitions_zh === 'string' ? [attribution.definitions_zh] : []);
      return {
        columns, oos: segment(attribution.oos, 'oos'), is: segment(attribution.is, 'is'),
        fill_limits: limits ? {
          rejections: Array.isArray(limits.rejections) ? limits.rejections.length : (isObject(limits.rejections) ? limits.rejections : null),
          reductions: Array.isArray(limits.reductions) ? limits.reductions.length : (isObject(limits.reductions) ? limits.reductions : null),
          note_zh: preferZh(limits, 'note') || null,
        } : null,
        definitions,
        note_zh: '归因对的是原版臂的净盈亏：各栏之和加上监管费按日进位差，等于账户期末减期初，残差 0；这是描述，不出结论',
      };
    },
  };
}

const Q2 = Object.freeze({
  question_ref: 'Q2',
  code_prefix: 'Q2',
  schema: 'US_V5_M2_Q2_RESULT_V1',
  queue_order: 2,
  title_zh: '候选对比：1× 载体对原版（收益来自信号还是杠杆）',
  k2: Object.freeze({ ref: K2_REF, sha256: K2_SHA256 }),
  profile_ref: 'docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2.md',
  top_level: Object.freeze(['identity', 'inputs', 'gates', 'arms', 'stats', 'stress', 'half_kelly',
    'formula_table', 'verdict', 'diagnosis_items', 'reproducibility', 'comparison', 'oos_reuse', 'attribution']),
  candidate: Object.freeze({ key: 'CANDIDATE_1X', keys: Object.freeze(['CANDIDATE_1X', '1X']), label_zh: '候选 1× 载体', deferred_sessions: false }),
  run_gates: Object.freeze(['ACCEPTANCE', 'INPUTS', 'BASELINE_REPRO', 'INERT_Q0F', 'INERT_Q1', 'ROUTING_CENSUS', 'ATTRIBUTION_RECONCILE', 'PROBE']),
  mirror: null,
  oos_reuse: Object.freeze({
    expected: false, reason_code: 'OOS_REUSED_FOR_SELECTION', detail_required: true, label_zh: '样本外没有被复用', adoption_zh: null,
  }),
  attribution: Object.freeze({ required: true }),
  exposure: Object.freeze({ required: true }),
  criteria: paired.CRITERIA,
  texts: Object.freeze({
    candidate_default: '候选 1× 载体：同一批信号，载体改为通过地板的最低 |杠杆| 行（再比 ADV，再比代码）；其余全部相同',
    oos_label: '样本外没有被复用：2023–2026 没有用于选择载体杠杆',
    exposure_note: '同样 60 美元的风险单元下，1× 载体的名义金额更大，名义上限更常约束；这是改动本身的后果，照报',
    g1_rule: '样本要够：两臂样本外成熟交易各 ≥ 30 笔，被改换载体的入场 ≥ 30 笔。',
    changed_label: '被改换载体的入场',
    method: '只按账户层面配对的年化对数增长差判定：95% 区间下沿大于 0 为有支持证据，上沿不高于 0 为未通过，其余为证据不足；单变体，不做多重比较校正。每笔净 R 对 +0.10 R 只报告，不参与判定。',
  }),
  blocks: Object.freeze([
    ['question', '这个对比在问什么'], ['account', '账户结果：原版与候选'], ['effect', '账户对数增长与每笔净 R'],
    ['exposure', '敞口变化披露（两臂）'], ['criteria', '判据逐条'], ['stress', '压力：两臂逐行对比'],
    ['attribution', 'Q2a 归因：收益从哪来（原版 OOS 账本）'], ['verdict', '三态结论与采用条件'], ['forward', '前向观察'],
  ]),
  reason_words: paired.REASON_WORDS_PAIRED_G,
  edge_labels: Object.freeze({ SUPPORTED: '完整账户的对数增长更好（不等于信号 alpha 更大）' }),
  constants: paired.constants,
  checkVerdict: paired.checkVerdict,
  validateExtras,
  builders,
});

module.exports = { Q2, DELTA_G, DELTA_R, MIN_TRADES, K2_REF, K2_SHA256 };
