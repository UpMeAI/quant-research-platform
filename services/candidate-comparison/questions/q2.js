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
 */
const {
  fail, need, field, ci, finite, isObject, preferZh, E, bound, firstFinite, fmtPct, criteriaOf, baselineIdOf, REASON_WORDS,
  pick, BASE_KEYS, edgeLabel,
} = require('../common');

const DELTA_G = 0;
const DELTA_R = 0.10;
const MIN_TRADES = 30;
const K2_REF = 'docs/contracts/US_V5_M2_Q2_SIGNAL_VS_LEVERAGE_K2_V1.md';
const K2_SHA256 = '660237c8823a5961c70ca78c8685343adb34ff2b35f192146d630a508f45ff6a';
const RECONCILE_TOLERANCE = 1e-6; // K2：对账残差 ≤ 1e-6 USD，否则 BLOCKED (ENGINE_PARITY)
const PNL_LINK_TOLERANCE = 1e-3; // 基线臂 summary 的期末资本只存到小数点后 4 位

const CRITERIA = Object.freeze({
  G1: { kind: 'met', title: '样本够不够' },
  P_G: { kind: 'met', title: '账户年化对数增长差' },
  F3: { kind: 'triggered', title: '账户层面的上沿不高于 0' },
});

const REASON_WORDS_Q2 = Object.freeze({
  G1_NOT_MET: '样本不够（G1 不满足）',
  SAMPLE_LT_30: '样本少于 30 笔',
  CI_G_STRADDLES_ZERO: '账户年化对数增长差的区间跨过 0',
  U_G_AT_OR_BELOW_ZERO: '账户年化对数增长差的上沿不高于 0（F3）',
  STRESS_SCENARIO_MISSING: '压力场景有缺（缺场景按不足处理）',
});

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

/** 95% 区间的两端：verdict 里有就用，没有就取 comparison.g_vs_baseline.ci_95。只读取，不推算。 */
function boundsOf(doc) {
  const v = doc.verdict;
  const g = isObject(doc.comparison.g_vs_baseline) ? doc.comparison.g_vs_baseline : {};
  return { L_g: firstFinite(v.L_g, bound(g.ci_95, 0)), U_g: firstFinite(v.U_g, bound(g.ci_95, 1)) };
}

function constants(entry, doc) {
  const verdict = doc.verdict;
  need(verdict.delta_g === DELTA_G && verdict.delta_R === DELTA_R, E(entry, 'VERDICT_DELTA_CHANGED'), `${verdict.delta_g}/${verdict.delta_R}`);
  need(isObject(doc.comparison), E(entry, 'COMPARISON_MISSING'));
}

/** 标签不能越过算术证据（K2 裁定 4）。 */
function checkVerdict(entry, doc, flags) {
  const verdict = doc.verdict;
  const { L_g, U_g } = boundsOf(doc);
  if (verdict.state === 'SUPPORTED') {
    need(flags.G1.flag === true && flags.P_G.flag === true && flags.F3.flag === false, E(entry, 'VERDICT_SUPPORTED_WITHOUT_EVIDENCE'), 'criteria');
    need(finite(U_g) && U_g > DELTA_G, E(entry, 'VERDICT_SUPPORTED_VIOLATES_F3'), `U_g=${U_g}`);
    need(finite(L_g) && L_g > DELTA_G, E(entry, 'VERDICT_SUPPORTED_WITHOUT_EVIDENCE'), `L_g=${L_g}`);
    // G1：两臂 OOS 成熟交易各 ≥ 30，被改换载体的入场 ≥ 30；数字必须写在 criteria.G1 里
    const g1 = flags.G1.item;
    need(['baseline_oos_trades', 'candidate_oos_trades', 'changed_entries'].every((key) => finite(g1[key]) && g1[key] >= MIN_TRADES),
      E(entry, 'VERDICT_SUPPORTED_SAMPLE_TOO_SMALL'),
      `baseline=${g1.baseline_oos_trades} candidate=${g1.candidate_oos_trades} changed=${g1.changed_entries}`);
    need(!(isObject(verdict.engine_approximation) && verdict.engine_approximation.flag === true), E(entry, 'VERDICT_SUPPORTED_ON_APPROXIMATE_ENGINE'));
  }
  if (verdict.state === 'NOT_PASSED') {
    // K2 三态：G1 不成立时一律证据不足；NOT_PASSED 只有 F3 式否决（U_g ≤ 0）
    need(flags.G1.flag === true, E(entry, 'VERDICT_NOT_PASSED_WITHOUT_EVIDENCE'), 'G1 不成立时只能判证据不足');
    need(finite(U_g) && U_g <= DELTA_G && flags.F3.flag === true, E(entry, 'VERDICT_NOT_PASSED_WITHOUT_EVIDENCE'), `U_g=${U_g}`);
  }
}

// ── 敞口披露与归因（必填，缺或不自洽就拒绝）───────────────────────────────────────

function exposureOf(entry, doc) {
  const fromDoc = [doc.comparison.exposure, doc.verdict.exposure].find(isObject);
  if (fromDoc) return fromDoc;
  const base = pick(doc.arms, BASE_KEYS);
  const cand = pick(doc.arms, entry.candidate.keys);
  return isObject(base) && isObject(base.exposure) && isObject(cand) && isObject(cand.exposure)
    ? { BASELINE: base.exposure, [entry.candidate.key]: cand.exposure } : null;
}

const EXPOSURE_COUNTS = Object.freeze(['notional_cap_rejections', 'notional_cap_reductions']);

function validateExposure(entry, doc) {
  const exposure = exposureOf(entry, doc);
  need(exposure, E(entry, 'EXPOSURE_DISCLOSURE_MISSING'), 'comparison.exposure');
  for (const [label, keys] of [['BASELINE', BASE_KEYS], [entry.candidate.key, entry.candidate.keys]]) {
    const arm = pick(exposure, keys);
    need(isObject(arm), E(entry, 'EXPOSURE_DISCLOSURE_MISSING'), `exposure.${label}`);
    need(finite(arm.avg_notional_usd) && arm.avg_notional_usd >= 0, E(entry, 'EXPOSURE_DISCLOSURE_INVALID'), `${label}.avg_notional_usd`);
    need(finite(arm.time_in_market_ratio) && arm.time_in_market_ratio >= 0 && arm.time_in_market_ratio <= 1, E(entry, 'EXPOSURE_DISCLOSURE_INVALID'), `${label}.time_in_market_ratio`);
    for (const key of EXPOSURE_COUNTS) need(Number.isInteger(arm[key]) && arm[key] >= 0, E(entry, 'EXPOSURE_DISCLOSURE_INVALID'), `${label}.${key}`);
  }
}

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
  validateExposure(entry, doc);
  validateAttribution(entry, doc);
}

// ── 块 ──────────────────────────────────────────────────────────────────────────

const positionOf = (interval, mean, delta) => {
  if (interval && finite(interval.lo) && finite(interval.hi)) {
    if (interval.lo > delta) return `95% 区间整体在 +${delta.toFixed(2)} R 之上`;
    if (interval.hi < delta) return `95% 区间整体在 +${delta.toFixed(2)} R 之下`;
    return `95% 区间跨过 +${delta.toFixed(2)} R`;
  }
  if (finite(mean)) return mean >= delta ? `点估计在 +${delta.toFixed(2)} R 之上（无区间）` : `点估计在 +${delta.toFixed(2)} R 之下（无区间）`;
  return null;
};
const optionalCi = (value) => (Array.isArray(value) && value.length === 2 && value.every(finite) && value[0] <= value[1] ? { lo: value[0], hi: value[1] } : null);
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

function detailText(detail) {
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (!isObject(detail)) return null;
  const parts = Object.entries(detail)
    .filter(([key, value]) => typeof value === 'string' && value.trim() && !/_sha256$|^sha256$/.test(key)).map(([, value]) => value.trim());
  return parts.length ? parts.join('；') : null;
}

function builders(entry, doc) {
  return {
    question() {
      const c = doc.comparison;
      const question = preferZh(c, 'question');
      need(typeof question === 'string' && question.trim(), 'MISSING', 'comparison.question');
      const candidate = preferZh(c, 'candidate_label');
      const detail = detailText(doc.oos_reuse_detail);
      return {
        question: question.trim(),
        candidate: typeof candidate === 'string' && candidate.trim() ? candidate.trim() : '候选 1× 载体：同一批信号，载体改为通过地板的最低 |杠杆| 行（再比 ADV，再比代码）；其余全部相同',
        populations: [],
        oos_reuse: { flag: false, label: '样本外没有被复用：2023–2026 没有用于选择载体杠杆', detail_zh: detail, independent: [] },
        baseline_result_id: baselineIdOf(entry, doc),
      };
    },

    /** 主判据 g 只有 95% 区间（单变体，没有 Bonferroni）；每笔净 R 是次指标，只报告不判；路由与单股 2× 的处理另列。 */
    effect() {
      const c = doc.comparison;
      const g = c.g_vs_baseline;
      need(isObject(g), 'MISSING', 'comparison.g_vs_baseline');
      const secondary = isObject(c.secondary) ? c.secondary : {};
      const literal = isObject(secondary.literal) ? secondary.literal : null;
      const paired = isObject(secondary.paired) ? secondary.paired : null;
      const routing = isObject(c.routing) ? c.routing : null;
      const literalCi = literal ? optionalCi(literal.ci_95) : null;
      const pairedCi = paired ? optionalCi(paired.ci_95) : null;
      const single = routing && isObject(routing.single_stock_2x) ? routing.single_stock_2x : null;
      return {
        layout: 'paired_g',
        g: { value: field(g, 'value', 'comparison.g_vs_baseline.value'), ci_95: ci(g.ci_95, 'comparison.g_vs_baseline.ci_95') },
        delta_R: DELTA_R,
        note_zh: '年化对数增长差按共同日标记配对，按月分块 bootstrap；单变体，不做多重比较校正',
        secondary: {
          literal: literal ? {
            n: count(literal.n), mean_R: finite(literal.mean_R) ? literal.mean_R : null, ci_95: literalCi, position_zh: positionOf(literalCi, literal.mean_R, DELTA_R),
          } : null,
          paired: paired ? {
            n_paired: count(paired.n_paired), mean_dR: finite(paired.mean_dR) ? paired.mean_dR : null, ci_95: pairedCi,
            n_baseline_only: count(paired.n_baseline_only), n_candidate_only: count(paired.n_candidate_only),
            position_zh: positionOf(pairedCi, paired.mean_dR, DELTA_R),
          } : null,
          not_in_verdict_zh: '次指标不参与判定，只报告',
        },
        routing: routing ? {
          changed_entries: count(routing.changed_entries), fallback_to_next: count(routing.fallback_to_next),
          single_stock_2x: single ? { treatment_zh: preferZh(single, 'treatment') || null, n: count(single.n) } : null,
          by_class: Array.isArray(routing.by_class) ? routing.by_class.filter(isObject).map((row) => ({ class: String(row.class), n: count(row.n) })) : [],
          by_route: Array.isArray(routing.by_route) ? routing.by_route.filter(isObject).map((row) => ({ route: String(row.route), n: count(row.n) })) : [],
        } : null,
      };
    },

    exposure() {
      const exposure = exposureOf(entry, doc);
      need(exposure, 'MISSING', 'comparison.exposure');
      const rowOf = (arm) => ({
        avg_notional_usd: field(arm, 'avg_notional_usd', 'exposure.avg_notional_usd'),
        time_in_market_ratio: field(arm, 'time_in_market_ratio', 'exposure.time_in_market_ratio'),
        notional_cap_rejections: field(arm, 'notional_cap_rejections', 'exposure.notional_cap_rejections'),
        notional_cap_reductions: field(arm, 'notional_cap_reductions', 'exposure.notional_cap_reductions'),
        avg_actual_risk_usd: finite(arm.avg_actual_risk_usd) ? arm.avg_actual_risk_usd : null,
      });
      const base = rowOf(pick(exposure, BASE_KEYS));
      const cand = rowOf(pick(exposure, entry.candidate.keys));
      return {
        baseline: base, candidate: cand,
        diff: {
          avg_notional_usd: cand.avg_notional_usd - base.avg_notional_usd,
          time_in_market_ratio: cand.time_in_market_ratio - base.time_in_market_ratio,
          notional_cap_rejections: cand.notional_cap_rejections - base.notional_cap_rejections,
          notional_cap_reductions: cand.notional_cap_reductions - base.notional_cap_reductions,
          avg_actual_risk_usd: base.avg_actual_risk_usd !== null && cand.avg_actual_risk_usd !== null ? cand.avg_actual_risk_usd - base.avg_actual_risk_usd : null,
        },
        note_zh: '同样 60 美元的风险单元下，1× 载体的名义金额更大，名义上限更常约束；这是改动本身的后果，照报',
      };
    },

    criteria() {
      const flags = criteriaOf(entry, doc);
      const { L_g, U_g } = boundsOf(doc);
      const g1 = flags.G1.item;
      const has = (...values) => values.every(finite);
      const lines = {
        G1: () => `样本要够：两臂样本外成熟交易各 ≥ ${MIN_TRADES} 笔，被改换载体的入场 ≥ ${MIN_TRADES} 笔。`
          + `${has(g1.baseline_oos_trades) ? `原版 ${g1.baseline_oos_trades} 笔；` : ''}${has(g1.candidate_oos_trades) ? `候选 ${g1.candidate_oos_trades} 笔；` : ''}${has(g1.changed_entries) ? `被改换载体的入场 ${g1.changed_entries} 笔。` : ''}`,
        P_G: () => `候选相对原版的年化对数增长差，95% 区间的下沿要大于 0。${has(L_g) ? `下沿 ${fmtPct(L_g, 2)}。` : ''}`,
        F3: () => `否决：账户年化对数增长差的 95% 区间上沿不高于 0。${has(U_g) ? `上沿 ${fmtPct(U_g, 2)}。` : ''}`,
      };
      return {
        rows: Object.entries(entry.criteria).map(([key, spec]) => {
          const flag = flags[key].flag;
          return {
            key, title: spec.title, kind: spec.kind, flag,
            state_label: spec.kind === 'met' ? (flag ? '成立' : '不成立') : (flag ? '触发' : '未触发'),
            tone: spec.kind === 'met' ? (flag ? 'ok' : 'bad') : (flag ? 'bad' : 'ok'),
            text: lines[key](),
          };
        }),
      };
    },

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

    verdict() {
      const v = doc.verdict;
      const reasons = (Array.isArray(v.reason_codes) ? v.reason_codes : [])
        .map((code) => ({ code, text: entry.reason_words[code] || REASON_WORDS[code] || `原因码 ${code}` }));
      const { L_g, U_g } = boundsOf(doc);
      return {
        layout: 'paired_g',
        class: v.class, state: v.state, label: edgeLabel(entry, v.state), delta_g: DELTA_G, delta_R: DELTA_R,
        g_95: finite(L_g) && finite(U_g) ? { lo: L_g, hi: U_g } : null, fail_label: typeof preferZh(v, 'fail_label') === 'string' ? preferZh(v, 'fail_label') : null,
        reasons,
        method_zh: '只按账户层面配对的年化对数增长差判定：95% 区间下沿大于 0 为有支持证据，上沿不高于 0 为未通过，其余为证据不足；单变体，不做多重比较校正。每笔净 R 对 +0.10 R 只报告，不参与判定。',
        caveat_zh: '「有支持证据」在这里的意思是完整账户的对数增长更好，不等于信号 alpha 更大（低暴露、小回撤不自动称 alpha）。',
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
  pending_status_zh: null,
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
  criteria: CRITERIA,
  blocks: Object.freeze([
    ['question', '这个对比在问什么'], ['account', '账户结果：原版与候选'], ['effect', '账户对数增长与每笔净 R'],
    ['exposure', '敞口变化披露（两臂）'], ['criteria', '判据逐条'], ['stress', '压力：两臂逐行对比'],
    ['attribution', 'Q2a 归因：收益从哪来（原版 OOS 账本）'], ['verdict', '三态结论与采用条件'], ['forward', '前向观察'],
  ]),
  reason_words: REASON_WORDS_Q2,
  edge_labels: Object.freeze({ SUPPORTED: '完整账户的对数增长更好（不等于信号 alpha 更大）' }),
  constants,
  checkVerdict,
  validateExtras,
  builders,
});

module.exports = { Q2, DELTA_G, DELTA_R, MIN_TRADES, K2_REF, K2_SHA256 };
