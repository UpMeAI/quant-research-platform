'use strict';

/**
 * Q1（T3：趋势期间推迟 TIME stop，对当前 D）的登记项。
 * 内容与改造前写死在导入器里的逐项相同——K2 引用、候选臂键、判据 G1／P1–P4／F1–F3、必填常数
 * （δ* 0.15、δ_g 0、Bonferroni 0.9833）、样本外必须复用（带 OOS_REUSED_FOR_SELECTION）、没有归因块。
 * 规格：docs/contracts/US_V5_M2_Q1_RESULT_V1_IMPORT_PROFILE.md（已冻结，不改）。
 */
const {
  need, field, ci, finite, isObject, preferZh, E, bound, firstFinite, fmtR, fmtPct, fmtUsd, criteriaOf, baselineIdOf, REASON_WORDS,
  armSummaries, stressBlock, edgeLabel, resolveReasons,
} = require('../common');
const { q1Basis } = require('./basis');

const DELTA_STAR = 0.15; // K2 判据，冻结，看见结果后不改
const DELTA_G = 0;
const MIN_AFFECTED = 30;
const MIN_BLOCKS = 10;
const BONFERRONI_LEVEL = 0.9833;
const K2_REF = 'docs/contracts/US_V5_M2_Q1_T3_DEFERRED_TIME_STOP_K2_V1.md';
const K2_SHA256 = '84c96c2843b196046ec17045b20e4dcaf02e0117e8291243a23b3be51990bb02';
const OOS_REUSE_LABEL = '复测（当年用于挑选 T3 的样本，不是独立样本外）';
const OOS_REUSE_DEFAULT = Object.freeze({ reused: { from: '2023-01-03', to: '2026-10-02' }, source: 'K2 裁定 4' });
const T3_OF = Object.freeze({ SUPPORTED: 'PASS', NOT_PASSED: 'FAIL', INSUFFICIENT: 'INSUFFICIENT' });

const CRITERIA = Object.freeze({
  G1: { kind: 'met', title: '样本够不够' }, P1: { kind: 'met', title: '受影响交易的平均改善' },
  P2: { kind: 'met', title: '期末资本与回撤' }, P3: { kind: 'met', title: '账户年化对数增长差' },
  P4: { kind: 'met', title: '开发期方向与高费用下不输' },
  F1: { kind: 'triggered', title: '改善的上沿低于最低改善量' }, F2: { kind: 'triggered', title: 'P1 成立但 P2 或 P4 不成立' },
  F3: { kind: 'triggered', title: '账户层面的上沿不高于 0' },
});

const REASON_WORDS_Q1 = Object.freeze({
  OOS_REUSED_FOR_SELECTION: '样本外复用：2023-01-03 至 2026-10-02 是 T3 研究的样本外，本次是复测，不是独立样本外',
  SAMPLE_LT_30: '主样本受影响交易少于 30 笔',
  G1_NOT_MET: '样本不够（G1 不满足）',
  CI_STRADDLES_DELTA: '改善的区间跨过最低改善量',
  CI_G_STRADDLES_ZERO: '账户年化对数增长差的区间跨过 0',
  U_G_AT_OR_BELOW_ZERO: '账户年化对数增长差的上沿不高于 0（F3）',
  STRESS_SCENARIO_MISSING: '压力场景有缺（缺场景按不足处理）',
});

/** 总体 S（主）与 B（次）。K2 正文写 comparison.D 为主总体，裁定写 S 与 B；三种位置都认。 */
function populationsOf(c) {
  const p = isObject(c.populations) ? c.populations : {};
  return { S: p.S || c.S || c.D, B: p.B || c.B };
}

/** 98.33% 区间的两端：verdict 里有就用，没有就取 comparison 里对应的区间。只读取，不推算。 */
function boundsOf(doc) {
  const v = doc.verdict;
  const { S } = populationsOf(doc.comparison);
  const g = isObject(doc.comparison.g_vs_baseline) ? doc.comparison.g_vs_baseline : {};
  return {
    L_D: firstFinite(v.L_D, v.L_R, bound(isObject(S) ? S.ci_98_33 : null, 0)), U_D: firstFinite(v.U_D, v.U_R, bound(isObject(S) ? S.ci_98_33 : null, 1)),
    L_g: firstFinite(v.L_g, bound(g.ci_98_33, 0)), U_g: firstFinite(v.U_g, bound(g.ci_98_33, 1)),
  };
}

/** 冻结常数：δ*、δ_g、Bonferroni 水平不能改（改了就是看过结果后动了门槛）。 */
function constants(entry, doc) {
  const verdict = doc.verdict;
  need(verdict.delta_star === DELTA_STAR && verdict.delta_g === DELTA_G, E(entry, 'VERDICT_DELTA_CHANGED'), `${verdict.delta_star}/${verdict.delta_g}`);
  const comparison = doc.comparison;
  need(isObject(comparison), E(entry, 'COMPARISON_MISSING'));
  need(isObject(comparison.bonferroni) && finite(comparison.bonferroni.level)
    && Math.abs(comparison.bonferroni.level - BONFERRONI_LEVEL) < 5e-5, E(entry, 'BONFERRONI_LEVEL_CHANGED'), comparison.bonferroni && comparison.bonferroni.level);
}

/** 标签不能越过算术证据（K2 §6.1 判定顺序 + F3）。 */
function checkVerdict(entry, doc, flags) {
  const verdict = doc.verdict;
  const { S: primary } = populationsOf(doc.comparison);
  need(isObject(primary), E(entry, 'PRIMARY_POPULATION_MISSING'));
  const { L_D, U_D, L_g, U_g } = boundsOf(doc);
  const nAff = firstFinite(primary.n_aff, NaN);
  const blocks = firstFinite(primary.blocks, primary.n_blocks, NaN);

  if (verdict.state === 'SUPPORTED') {
    need(['G1', 'P1', 'P2', 'P3', 'P4'].every((name) => flags[name].flag === true)
      && ['F1', 'F2', 'F3'].every((name) => flags[name].flag === false), E(entry, 'VERDICT_SUPPORTED_WITHOUT_EVIDENCE'), 'criteria');
    // F3：账户层面的上沿不高于 0 时不得 SUPPORTED（K2 裁定 3）
    need(finite(U_g) && U_g > DELTA_G, E(entry, 'VERDICT_SUPPORTED_VIOLATES_F3'), `U_g=${U_g}`);
    need(finite(L_D) && L_D > 0 && finite(L_g) && L_g > DELTA_G && finite(U_D) && U_D >= DELTA_STAR,
      E(entry, 'VERDICT_SUPPORTED_WITHOUT_EVIDENCE'), `L_D=${L_D} U_D=${U_D} L_g=${L_g}`);
    need(nAff >= MIN_AFFECTED && blocks >= MIN_BLOCKS, E(entry, 'VERDICT_SUPPORTED_SAMPLE_TOO_SMALL'), `n_aff=${nAff} blocks=${blocks}`);
    need(!(isObject(verdict.engine_approximation) && verdict.engine_approximation.flag === true), E(entry, 'VERDICT_SUPPORTED_ON_APPROXIMATE_ENGINE'));
  }
  if (verdict.state === 'NOT_PASSED') {
    const f1 = finite(U_D) && U_D < DELTA_STAR;
    const f2 = flags.P1.flag === true && (flags.P2.flag === false || flags.P4.flag === false);
    const f3 = finite(U_g) && U_g <= DELTA_G;
    need(f1 || f2 || f3, E(entry, 'VERDICT_NOT_PASSED_WITHOUT_EVIDENCE'), `U_D=${U_D} U_g=${U_g}`);
  }
}

function population(raw, key, where) {
  need(isObject(raw), 'MISSING', `${where}.${key}`);
  need(Number.isInteger(raw.n_aff) && raw.n_aff >= 0, 'INVALID', `${where}.${key}.n_aff`);
  const blocks = raw.blocks !== undefined ? raw.blocks : raw.n_blocks;
  need(Number.isInteger(blocks) && blocks >= 0, 'INVALID', `${where}.${key}.blocks`);
  return {
    key, n_aff: raw.n_aff, blocks, n_total: Number.isInteger(raw.n_total) ? raw.n_total : null,
    n_zero: Number.isInteger(raw.n_zero) ? raw.n_zero : null, mean_dR: field(raw, 'mean_dR', `${where}.${key}.mean_dR`),
    ci_95: ci(raw.ci_95, `${where}.${key}.ci_95`), ci_98_33: ci(raw.ci_98_33, `${where}.${key}.ci_98_33`),
    mde: finite(raw.mde) ? raw.mde : null,
  };
}

/** 块构造器（与题目有关的四块：问题、受影响交易的改善、判据逐条、三态结论）。 */
function builders(entry, doc) {
  return {
    question() {
      const c = doc.comparison;
      const question = preferZh(c, 'question');
      need(typeof question === 'string' && question.trim(), 'MISSING', 'comparison.question');
      const detail = isObject(doc.identity.oos_reuse) ? doc.identity.oos_reuse : {};
      const stated = isObject(detail.reused) ? detail.reused : detail;
      const reused = stated.from && stated.to ? { from: stated.from, to: stated.to } : OOS_REUSE_DEFAULT.reused;
      const candidate = preferZh(c, 'candidate_label');
      return {
        question: question.trim(),
        candidate: typeof candidate === 'string' && candidate.trim() ? candidate.trim() : '候选 T3：趋势期间到期的 5 日时间止损推迟，之后每个扫描时点复查',
        populations: [
          { key: 'S', role: '主样本', label: '信号级总体 S：每个通过闸门的趋势买入信号各算一笔（主）' },
          { key: 'B', role: '次要样本', label: '基线账本的时间止损出场 B（次，照报不判）' },
        ],
        oos_reuse: { label: OOS_REUSE_LABEL, reused, independent: Array.isArray(detail.independent) ? detail.independent : [], from_k2: !(stated.from && stated.to) },
        baseline_result_id: baselineIdOf(entry, doc),
      };
    },

    effect() {
      const c = doc.comparison;
      const pops = populationsOf(c);
      const g = c.g_vs_baseline;
      need(isObject(g), 'MISSING', 'comparison.g_vs_baseline');
      const secondary = isObject(c.secondary) ? c.secondary : null;
      return {
        S: population(pops.S, 'S', 'comparison.populations'), B: population(pops.B, 'B', 'comparison.populations'),
        g: { value: field(g, 'value', 'comparison.g_vs_baseline.value'), ci_95: ci(g.ci_95, 'comparison.g_vs_baseline.ci_95'), ci_98_33: ci(g.ci_98_33, 'comparison.g_vs_baseline.ci_98_33') },
        bonferroni: '多重比较：T3 是从三个变体里选出来的，主判据用 98.33% 区间（Bonferroni），95% 区间并列',
        secondary: secondary ? {
          mean_dR_all_time_exits: finite(secondary.mean_dR_all_time_exits) ? secondary.mean_dR_all_time_exits : null,
          n_time_exits: Number.isInteger(secondary.n_time_exits) ? secondary.n_time_exits : null,
          by_reason: Array.isArray(secondary.by_reason) ? secondary.by_reason.filter((row) => isObject(row)).map((row) => ({ reason: String(row.reason), n: row.n, mean_dR: row.mean_dR })) : [],
        } : null,
      };
    },

    /**
     * P1–P4 / F1–F3 的人话。数字只取文件里已有的：区间取 verdict／comparison 里的 98.33% 两端，
     * 期末资本与回撤取两臂 summary，高费用取 COST_15BPS 压力行；取不到就只写成立与否，不补、不推算。
     */
    criteria() {
      const flags = criteriaOf(entry, doc);
      const { L_D, U_D, L_g, U_g } = boundsOf(doc);
      const { S } = populationsOf(doc.comparison);
      const arms = (() => { try { return armSummaries(entry, doc); } catch { return null; } })();
      const base = arms && arms[0];
      const cand = arms && arms[1];
      // 高费用那一行只取通过了压力块校验的数字；压力块读不出来就不显示这几个数。
      let stressRows = [];
      try { stressRows = stressBlock(entry, doc).rows; } catch { stressRows = []; }
      const costRow = stressRows.find((row) => row.scenario === 'COST_15BPS' && row.kind === 'EXECUTED' && !row.candidate_missing);
      const costBase = costRow && costRow.baseline;
      const costCand = costRow && costRow.candidate;
      const has = (...values) => values.every(finite);
      const f = flags;
      const lines = {
        G1: () => `样本要够：基线样本外成熟交易 ≥ 30 笔，主样本受影响交易 ≥ ${MIN_AFFECTED} 笔且分布在 ≥ ${MIN_BLOCKS} 个入场块。`
          + `${finite(f.G1.item.baseline_oos_trades) ? `基线 ${f.G1.item.baseline_oos_trades} 笔；` : ''}${isObject(S) && has(S.n_aff) ? `主样本受影响 ${S.n_aff} 笔${finite(firstFinite(S.blocks, S.n_blocks)) ? `、${firstFinite(S.blocks, S.n_blocks)} 个块` : ''}。` : ''}`,
        P1: () => `受影响交易的平均改善，98.33% 区间的下沿要大于 0。${has(L_D) ? `下沿 ${fmtR(L_D)}。` : ''}`,
        P2: () => `候选的样本外期末资本要高于原版，且最大回撤不超过原版 + 1.0 个百分点。${cand && base ? `期末资本 ${fmtUsd(cand.end_capital)} 对 ${fmtUsd(base.end_capital)}；最大回撤 ${fmtPct(cand.max_drawdown)} 对 ${fmtPct(base.max_drawdown)}。` : ''}`,
        P3: () => `候选相对原版的年化对数增长差，98.33% 区间的下沿要大于 0。${has(L_g) ? `下沿 ${fmtPct(L_g)}。` : ''}`,
        P4: () => `开发期的改善点估计不为负，且 15 bps 高费用下候选的样本外期末资本不低于原版。${costBase && costCand && has(costBase.end_capital, costCand.end_capital) ? `高费用期末资本 ${fmtUsd(costCand.end_capital)} 对 ${fmtUsd(costBase.end_capital)}。` : ''}`,
        F1: () => `否决：改善的 98.33% 区间上沿低于最低改善量 +${DELTA_STAR.toFixed(2)} R。${has(U_D) ? `上沿 ${fmtR(U_D)}。` : ''}`,
        F2: () => `否决：P1 成立，但 P2 或 P4 不成立。${typeof f.F2.item.which === 'string' && f.F2.item.which ? `不成立的是 ${f.F2.item.which}。` : ''}`,
        F3: () => `否决：账户年化对数增长差的 98.33% 区间上沿不高于 0。${has(U_g) ? `上沿 ${fmtPct(U_g)}。` : ''}`,
      };
      return {
        rows: Object.entries(entry.criteria).map(([key, spec]) => {
          const flag = f[key].flag;
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
      const range = (lo, hi) => (finite(lo) && finite(hi) ? { lo, hi } : null);
      const { L_D, U_D, L_g, U_g } = boundsOf(doc);
      const { S } = populationsOf(doc.comparison);
      return {
        class: v.class, state: v.state, label: edgeLabel(entry, v.state), t3_state: v.t3_state, delta_star: DELTA_STAR, delta_g: DELTA_G,
        basis: q1Basis({
          state: v.state, flags: criteriaOf(entry, doc), L_D, U_D, L_g, U_g, population: isObject(S) ? S : null,
          delta_star: DELTA_STAR, delta_g: DELTA_G, min_affected: MIN_AFFECTED, min_blocks: MIN_BLOCKS,
        }),
        D_98_33: range(L_D, U_D), g_98_33: range(L_g, U_g), n_aff: isObject(S) && Number.isInteger(S.n_aff) ? S.n_aff : null,
        blocks: isObject(S) && Number.isInteger(firstFinite(S.blocks, S.n_blocks)) ? firstFinite(S.blocks, S.n_blocks) : null, fail_label: typeof preferZh(v, 'fail_label') === 'string' ? preferZh(v, 'fail_label') : null,
        reasons: resolved.known, unknown_reason_codes: resolved.unknown, bonferroni: '98.33%（Bonferroni）',
      };
    },
  };
}

const Q1 = Object.freeze({
  question_ref: 'Q1',
  code_prefix: 'Q1',
  schema: 'US_V5_M2_Q1_RESULT_V1',
  queue_order: 1,
  title_zh: '候选对比：T3 对原版',
  k2: Object.freeze({ ref: K2_REF, sha256: K2_SHA256 }),
  profile_ref: 'docs/contracts/US_V5_M2_Q1_RESULT_V1_IMPORT_PROFILE.md',
  pending_status_zh: 'K2 已冻结，等研究会话交付封存的对比结果（见研究与对比）',
  top_level: Object.freeze(['identity', 'inputs', 'gates', 'arms', 'stats', 'stress', 'half_kelly',
    'formula_table', 'verdict', 'diagnosis_items', 'reproducibility', 'comparison', 'oos_reuse']),
  candidate: Object.freeze({ key: 'CANDIDATE_T3', keys: Object.freeze(['CANDIDATE_T3', 'T3']), label_zh: '候选 T3', deferred_sessions: true }),
  run_gates: Object.freeze(['ACCEPTANCE', 'INPUTS', 'BASELINE_REPRO', 'INERT_Q0F', 'INERT_TWINS', 'TWIN_PARITY', 'PROBE']),
  mirror: Object.freeze({ field: 't3_state', map: T3_OF, mismatch_code: 'T3_STATE_MISMATCH', blocked_code: 'BLOCKED_HAS_NO_VERDICT' }),
  oos_reuse: Object.freeze({
    expected: true, reason_code: 'OOS_REUSED_FOR_SELECTION', detail_required: false, label_zh: OOS_REUSE_LABEL,
    adoption_zh: '独立样本不足，等前向成熟',
  }),
  attribution: Object.freeze({ required: false }),
  exposure: Object.freeze({ required: false }),
  criteria: CRITERIA,
  blocks: Object.freeze([
    ['question', '这个对比在问什么'], ['account', '账户结果：原版与候选'], ['effect', '受影响交易的改善'],
    ['criteria', '判据逐条'], ['stress', '压力：两臂逐行对比'], ['verdict', '三态结论与采用条件'], ['forward', '前向观察'],
  ]),
  reason_words: REASON_WORDS_Q1,
  edge_labels: null,
  constants,
  checkVerdict,
  builders,
});

module.exports = {
  Q1, DELTA_STAR, DELTA_G, MIN_AFFECTED, MIN_BLOCKS, K2_REF, K2_SHA256, OOS_REUSE_LABEL,
};
