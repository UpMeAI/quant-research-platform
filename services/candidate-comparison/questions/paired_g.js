'use strict';

/**
 * 「只按账户层面配对 g 判」的那一类题目（Q2、Q3b）共用的登记项部件：冻结常数、判定规则（G1 先判，Q2 K2 勘误 1）、
 * 敞口披露、效应块、判据块、三态结论块。与题目有关的文字（G1 里「改变的入场」怎么叫、样本外的说法、敞口说明……）
 * 由登记项的 `texts` 给出；Q2 的文字与抽出之前逐字相同。
 *
 *   - 判定（单变体，95% 区间，没有 Bonferroni）：G1 不成立 → 一律 INSUFFICIENT；G1 成立时 L_g > 0 → SUPPORTED，
 *     U_g ≤ 0 → NOT_PASSED，其余 INSUFFICIENT；次指标（候选臂自身每笔净 R 对 +0.10 R）只报不判；
 *   - 冻结常数 δ_g 0、δ_R 0.10；
 *   - 敞口披露必填：两臂的平均名义金额、在场时间占比、名义上限拒绝与削减次数（登记项可加每臂必填的计数，Q3b 加行业 RS 的拒绝数与重排时点数）。
 */
const {
  fail, need, field, ci, finite, isObject, preferZh, E, bound, firstFinite, fmtPct, criteriaOf, baselineIdOf, REASON_WORDS,
  pick, BASE_KEYS, edgeLabel, resolveReasons,
} = require('../common');
const { pairedBasis } = require('./basis');

const DELTA_G = 0;
const DELTA_R = 0.10;
const MIN_TRADES = 30;

const CRITERIA = Object.freeze({
  G1: { kind: 'met', title: '样本够不够' },
  P_G: { kind: 'met', title: '账户年化对数增长差' },
  F3: { kind: 'triggered', title: '账户层面的上沿不高于 0' },
});

/** 两题共用的原因码中文：G1 先判（Q2 K2 勘误 1）加上 Q2 的既有说法。 */
const REASON_WORDS_PAIRED_G = Object.freeze({
  G1_NOT_MET: '样本不够（G1 不满足）',
  SAMPLE_LT_30: '样本少于 30 笔',
  CI_G_STRADDLES_ZERO: '账户年化对数增长差的区间跨过 0',
  U_G_AT_OR_BELOW_ZERO: '账户年化对数增长差的上沿不高于 0（F3）',
  STRESS_SCENARIO_MISSING: '压力场景有缺（缺场景按不足处理）',
  G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT: 'G1 不成立，而账户年化对数增长差的上沿不高于 0：照报上沿，作待验证的事实，不是经济上的反证（Q2 K2 勘误 1）',
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

/** 标签不能越过算术证据（G1 先判；SUPPORTED 需要 G1 的三个样本数各 ≥ 30；NOT_PASSED 需要 G1 成立）。 */
function checkVerdict(entry, doc, flags) {
  const verdict = doc.verdict;
  const { L_g, U_g } = boundsOf(doc);
  if (verdict.state === 'SUPPORTED') {
    need(flags.G1.flag === true && flags.P_G.flag === true && flags.F3.flag === false, E(entry, 'VERDICT_SUPPORTED_WITHOUT_EVIDENCE'), 'criteria');
    need(finite(U_g) && U_g > DELTA_G, E(entry, 'VERDICT_SUPPORTED_VIOLATES_F3'), `U_g=${U_g}`);
    need(finite(L_g) && L_g > DELTA_G, E(entry, 'VERDICT_SUPPORTED_WITHOUT_EVIDENCE'), `L_g=${L_g}`);
    // G1：两臂 OOS 成熟交易各 ≥ 30，改变的入场 ≥ 30；数字必须写在 criteria.G1 里
    const g1 = flags.G1.item;
    need(['baseline_oos_trades', 'candidate_oos_trades', 'changed_entries'].every((key) => finite(g1[key]) && g1[key] >= MIN_TRADES),
      E(entry, 'VERDICT_SUPPORTED_SAMPLE_TOO_SMALL'),
      `baseline=${g1.baseline_oos_trades} candidate=${g1.candidate_oos_trades} changed=${g1.changed_entries}`);
    need(!(isObject(verdict.engine_approximation) && verdict.engine_approximation.flag === true), E(entry, 'VERDICT_SUPPORTED_ON_APPROXIMATE_ENGINE'));
  }
  if (verdict.state === 'NOT_PASSED') {
    // G1 不成立时一律证据不足；NOT_PASSED 只有 F3 式否决（U_g ≤ 0）
    need(flags.G1.flag === true, E(entry, 'VERDICT_NOT_PASSED_WITHOUT_EVIDENCE'), 'G1 不成立时只能判证据不足');
    need(finite(U_g) && U_g <= DELTA_G && flags.F3.flag === true, E(entry, 'VERDICT_NOT_PASSED_WITHOUT_EVIDENCE'), `U_g=${U_g}`);
  }
}

// ── 敞口披露（必填，缺或不合规就拒绝）──────────────────────────────────────────────

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
  const extra = entry.exposure.extra_counts || { baseline: [], candidate: [] };
  for (const [label, keys, extras] of [['BASELINE', BASE_KEYS, extra.baseline], [entry.candidate.key, entry.candidate.keys, extra.candidate]]) {
    const arm = pick(exposure, keys);
    need(isObject(arm), E(entry, 'EXPOSURE_DISCLOSURE_MISSING'), `exposure.${label}`);
    need(finite(arm.avg_notional_usd) && arm.avg_notional_usd >= 0, E(entry, 'EXPOSURE_DISCLOSURE_INVALID'), `${label}.avg_notional_usd`);
    need(finite(arm.time_in_market_ratio) && arm.time_in_market_ratio >= 0 && arm.time_in_market_ratio <= 1, E(entry, 'EXPOSURE_DISCLOSURE_INVALID'), `${label}.time_in_market_ratio`);
    for (const key of [...EXPOSURE_COUNTS, ...extras]) need(Number.isInteger(arm[key]) && arm[key] >= 0, E(entry, 'EXPOSURE_DISCLOSURE_INVALID'), `${label}.${key}`);
  }
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

/** 共用的块构造器：问题、效应、敞口、判据、三态结论。`texts` 来自登记项。 */
function builders(entry, doc) {
  const texts = entry.texts;
  return {
    question() {
      const c = doc.comparison;
      const question = preferZh(c, 'question');
      need(typeof question === 'string' && question.trim(), 'MISSING', 'comparison.question');
      const candidate = preferZh(c, 'candidate_label');
      const detail = detailText(doc.oos_reuse_detail);
      return {
        question: question.trim(),
        candidate: typeof candidate === 'string' && candidate.trim() ? candidate.trim() : texts.candidate_default,
        populations: [],
        oos_reuse: { flag: false, label: texts.oos_label, detail_zh: detail, independent: [], ...(texts.oos_pill ? { pill_zh: texts.oos_pill, tone: texts.oos_tone } : {}) },
        baseline_result_id: baselineIdOf(entry, doc),
      };
    },

    /** 主判据 g 只有 95% 区间（单变体，没有 Bonferroni）；每笔净 R 是次指标，只报告不判；路由（有就列）。 */
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
      const extras = entry.exposure.extra_counts || { baseline: [], candidate: [] };
      const rowOf = (arm, extraKeys) => ({
        avg_notional_usd: field(arm, 'avg_notional_usd', 'exposure.avg_notional_usd'),
        time_in_market_ratio: field(arm, 'time_in_market_ratio', 'exposure.time_in_market_ratio'),
        notional_cap_rejections: field(arm, 'notional_cap_rejections', 'exposure.notional_cap_rejections'),
        notional_cap_reductions: field(arm, 'notional_cap_reductions', 'exposure.notional_cap_reductions'),
        avg_actual_risk_usd: finite(arm.avg_actual_risk_usd) ? arm.avg_actual_risk_usd : null,
        ...Object.fromEntries(extraKeys.map((key) => [key, field(arm, key, `exposure.${key}`)])),
      });
      const base = rowOf(pick(exposure, BASE_KEYS), extras.baseline);
      const cand = rowOf(pick(exposure, entry.candidate.keys), extras.candidate);
      // 敞口表里登记项另加的行（Q3b：行业 RS 的拒绝数与重排时点数）；原版臂没有排序层，没有写就是「—」
      const extraRows = (entry.exposure.extra_rows || []).map((spec) => ({
        key: spec.key, label: spec.label_zh, unit: spec.unit_zh,
        baseline: finite(pick(exposure, BASE_KEYS)[spec.key]) ? pick(exposure, BASE_KEYS)[spec.key] : null,
        candidate: field(pick(exposure, entry.candidate.keys), spec.key, `exposure.${spec.key}`),
      }));
      return {
        baseline: base, candidate: cand,
        diff: {
          avg_notional_usd: cand.avg_notional_usd - base.avg_notional_usd,
          time_in_market_ratio: cand.time_in_market_ratio - base.time_in_market_ratio,
          notional_cap_rejections: cand.notional_cap_rejections - base.notional_cap_rejections,
          notional_cap_reductions: cand.notional_cap_reductions - base.notional_cap_reductions,
          avg_actual_risk_usd: base.avg_actual_risk_usd !== null && cand.avg_actual_risk_usd !== null ? cand.avg_actual_risk_usd - base.avg_actual_risk_usd : null,
        },
        ...(extraRows.length ? { extra_rows: extraRows } : {}),
        note_zh: texts.exposure_note,
      };
    },

    criteria() {
      const flags = criteriaOf(entry, doc);
      const { L_g, U_g } = boundsOf(doc);
      const g1 = flags.G1.item;
      const has = (...values) => values.every(finite);
      const lines = {
        G1: () => `${texts.g1_rule}`
          + `${has(g1.baseline_oos_trades) ? `原版 ${g1.baseline_oos_trades} 笔；` : ''}${has(g1.candidate_oos_trades) ? `候选 ${g1.candidate_oos_trades} 笔；` : ''}${has(g1.changed_entries) ? `${texts.changed_label} ${g1.changed_entries} 笔。` : ''}`,
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

    verdict() {
      const v = doc.verdict;
      const resolved = resolveReasons(v.reason_codes, entry.reason_words, REASON_WORDS);
      const { L_g, U_g } = boundsOf(doc);
      return {
        layout: 'paired_g',
        class: v.class, state: v.state, label: edgeLabel(entry, v.state), delta_g: DELTA_G, delta_R: DELTA_R,
        basis: pairedBasis({ state: v.state, flags: criteriaOf(entry, doc), L_g, U_g, delta_g: DELTA_G, min_trades: MIN_TRADES, changed_label: texts.changed_label }),
        g_95: finite(L_g) && finite(U_g) ? { lo: L_g, hi: U_g } : null, fail_label: typeof preferZh(v, 'fail_label') === 'string' ? preferZh(v, 'fail_label') : null,
        reasons: resolved.known, unknown_reason_codes: resolved.unknown,
        method_zh: texts.method,
        caveat_zh: '「有支持证据」在这里的意思是完整账户的对数增长更好，不等于信号 alpha 更大（低暴露、小回撤不自动称 alpha）。',
      };
    },
  };
}

module.exports = {
  DELTA_G, DELTA_R, MIN_TRADES, CRITERIA, REASON_WORDS_PAIRED_G, boundsOf, constants, checkVerdict, exposureOf, validateExposure,
  builders, detailText, count, fail,
};
