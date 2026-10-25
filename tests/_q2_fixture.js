'use strict';
/**
 * 合成的 US_V5_M2_Q2_RESULT_V1，只用于测试 Q2 登记项和页面。数字没有经济含义；路径带 fixture 字样，
 * 导入器默认把它当「非实际来源」拒绝，只有测试显式放行。
 *
 * 默认形状 = Q2 K2 裁定 4–5 的样子：判定只按配对 g（单变体、95% 区间、没有 Bonferroni）；oos_reuse:false 并写理由；
 * 前向为空并写原因；有归因块（对上**基线臂**的净盈亏，残差 0，监管费日进位差单列）和两臂敞口披露。
 * 优势结论 SUPPORTED，但压力有缺（缺场景、无效输入、补充行候选臂缺项），所以页面应写出「优势结论 / 压力评价不完整 / 采用条件」三行
 * ——采用条件里没有「独立样本不足」，因为 Q2 的样本外没有被复用。
 */
const fx1 = require('./_q1_fixture');
const q2 = require('../services/candidate-comparison/questions/q2');

const hex = fx1.hex;
const COLUMNS = [
  { key: 'PARENT_SIGNAL', label_zh: '母序列信号' }, { key: 'LEVERAGE_PATH', label_zh: '杠杆与路径' },
  { key: 'SINGLE_STOCK_2X', label_zh: '单股 2×（不可分）' }, { key: 'COST', label_zh: '费用（含在成交价里的 5 bps／边）' },
  { key: 'REG_FEE', label_zh: '监管费（逐笔未进位）' },
];
const CLASSES = [
  { class: 'INDEX', n: 9, parts: [40, 2, null, -6, -0.4] }, { class: 'SECTOR', n: 49, parts: [55, 5, null, -20, -1.3] },
  { class: 'LEVERAGED_3X_SECTOR', n: 24, parts: [90, -35, null, -12, -0.8] },
  { class: 'SINGLE_STOCK_2X', n: 27, parts: [null, null, 30, -14, -0.9] }, { class: 'INVERSE', n: 3, parts: [-4, -1, null, -2, -0.1] },
];

/** 把一段归因做成「各栏之和 + 日进位差 = 账户净盈亏」，残差 0。 */
function segment(accountPnl, window) {
  const byClass = CLASSES.map((item) => ({
    class: item.class, n_trades: item.n,
    usd: Object.fromEntries(COLUMNS.map((column, index) => [column.key, item.parts[index]])),
    r: Object.fromEntries(COLUMNS.map((column, index) => [column.key, item.parts[index] === null ? null : item.parts[index] / 60])),
  }));
  const total = (key, scale = 1) => {
    const values = byClass.map((row) => (scale === 1 ? row.usd[key] : row.r[key])).filter((value) => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const totalUsd = Object.fromEntries(COLUMNS.map((column) => [column.key, total(column.key)]));
  const sumOfColumns = Object.values(totalUsd).filter((value) => value !== null).reduce((sum, value) => sum + value, 0);
  const regDailyRounding = accountPnl - sumOfColumns; // 日进位差本来就是对账的那一行
  return {
    window, by_class: byClass,
    total: { n_trades: 112, usd: totalUsd, r: Object.fromEntries(COLUMNS.map((column) => [column.key, total(column.key, 'r')])) },
    reconcile: { account_pnl: accountPnl, sum_components: sumOfColumns + regDailyRounding, residual: 0, reg_daily_rounding: regDailyRounding },
  };
}

/** q0Doc 与 q0Sha 是已导入 Q0 锁定的那份文件；Q2 的原版臂必须逐项等于它的 D 臂。 */
function result(q0Doc, q0Sha, q0ResultId, overrides = {}) {
  const transform = (doc) => {
    const baseValues = doc.arms.BASELINE.equity.values;
    const baselinePnl = baseValues[baseValues.length - 1] - baseValues[0];
    doc.identity.schema = 'US_V5_M2_Q2_RESULT_V1';
    doc.identity.k2 = { ref: q2.K2_REF, sha256: q2.K2_SHA256 };
    delete doc.identity.t3_acceptance_sha256;
    delete doc.identity.oos_reuse;
    doc.gates = Object.fromEntries(['ACCEPTANCE', 'INPUTS', 'BASELINE_REPRO', 'INERT_Q0F', 'INERT_Q1', 'ROUTING_CENSUS', 'ATTRIBUTION_RECONCILE', 'PROBE']
      .map((name) => [name, { state: 'PASSED' }]));
    doc.arms.CANDIDATE_1X = doc.arms.CANDIDATE_T3;
    delete doc.arms.CANDIDATE_T3;
    delete doc.arms.CANDIDATE_1X.deferred_sessions;
    for (const row of doc.stress.rows) {
      if (row.arms && row.arms.CANDIDATE_T3) { row.arms.CANDIDATE_1X = row.arms.CANDIDATE_T3; delete row.arms.CANDIDATE_T3; }
    }
    doc.comparison = {
      baseline_result_id: q0ResultId,
      question_zh: '同样的信号与同样的风险定仓，把杠杆载体换成同一敞口的 1× 载体，完整账户是更好还是更差？',
      candidate_label_zh: '候选 1× 载体：同一批信号，载体改为通过地板的最低 |杠杆| 行（再比 ADV，再比代码）；单股 2× 保持原载体',
      g_vs_baseline: { value: 0.021, ci_95: [0.004, 0.039] },
      criteria: {
        G1: { met: true, baseline_oos_trades: 112, candidate_oos_trades: 108, changed_entries: 45 }, P_G: { met: true }, F3: { triggered: false },
      },
      secondary: {
        literal: { n: 108, mean_R: 0.12, ci_95: [0.02, 0.22] },
        paired: { n_paired: 80, mean_dR: 0.03, ci_95: [-0.05, 0.11], n_baseline_only: 20, n_candidate_only: 14 },
      },
      routing: {
        changed_entries: 45, fallback_to_next: 3, single_stock_2x: { treatment_zh: '保持原 2× 载体，两臂相同', n: 27 },
        by_class: [{ class: '3× 行业', n: 24 }, { class: '反向', n: 3 }], by_route: [{ route: 'TECL→XLK', n: 4 }, { route: 'SPXU→SH', n: 2 }],
      },
      exposure: {
        BASELINE: { avg_notional_usd: 1450, time_in_market_ratio: 0.42, notional_cap_rejections: 54, notional_cap_reductions: 7, avg_actual_risk_usd: 52 },
        CANDIDATE_1X: { avg_notional_usd: 2100, time_in_market_ratio: 0.55, notional_cap_rejections: 90, notional_cap_reductions: 15, avg_actual_risk_usd: 44 },
      },
    };
    doc.verdict = {
      class: 'CANDIDATE_COMPARISON_V1', state: 'SUPPORTED', reason_codes: ['STRESS_SCENARIO_MISSING'],
      L_g: 0.004, U_g: 0.039, delta_g: 0, delta_R: 0.10, engine_approximation: { flag: false, missing: [] },
    };
    doc.oos_reuse = false;
    doc.oos_reuse_detail = {
      reason_zh: '2023–2026 没有用于选择载体杠杆：「选最高杠杆」是实施时的读法签字，没有找到在这段数据上比较杠杆的回测选择',
      other_studies_zh: '同一窗口被其他 US_V5 研究读过（计划 §3 已披露）',
    };
    doc.forward = { rows: [], reason_zh: 'HK 没有 1× 路由的前向影子' };
    doc.attribution = {
      columns: COLUMNS,
      oos: segment(baselinePnl, ['2023-01-03', '2026-10-23']),
      is: segment(120.5, ['2020-01-02', '2022-12-30']),
      fill_limits: {
        rejections: [{ reason: 'BOOK_NOTIONAL_CAP' }, { reason: 'BOOK_NOTIONAL_CAP' }, { reason: 'BOOK_CAP_FULL' }], reductions: [{ id: 1 }, { id: 2 }],
        note_zh: '被拒信号在信号级影子交易里怎么走，USD 只按 60 USD / R 作示意',
      },
      definitions_zh: ['母序列信号 = 风险 USD × R_母', '杠杆与路径 = 载体中间价毛利 − 母序列信号'],
    };
    doc.reproducibility = { command: 'node run-q2.js --seed 20261025', runs: [{ sha256: hex('q2-run') }, { sha256: hex('q2-run') }], identical: true };
  };
  return fx1.result(q0Doc, q0Sha, q0ResultId, (doc) => {
    transform(doc);
    if (typeof overrides === 'function') overrides(doc);
    else Object.assign(doc, overrides);
    return doc;
  });
}

module.exports = { result, write: fx1.write, hex, segment, COLUMNS };
