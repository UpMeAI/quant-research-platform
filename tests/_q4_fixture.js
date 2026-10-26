'use strict';
/**
 * 合成的 US_V5_M2_Q4_RESULT_V1，只用于测试 Q4 登记项和页面。数字没有经济含义；路径带 fixture 字样，
 * 导入器默认把它当「非实际来源」拒绝，只有测试显式放行。
 *
 * 默认形状 = Q4 K2 裁定 1–7 的样子：
 *   - 主卡：候选臂 CANDIDATE_COOLDOWN_ON_OPEN（A25：冷却只在开仓时武装），优势结论 INSUFFICIENT（配对 g 的 95% 区间跨过 0，
 *     G1 成立），压力有缺；oos_reuse:true 且带 OOS_REUSED_FOR_SELECTION（风控维度行「供 Q4 立题」）；
 *   - 敞口：两臂必填字段，另有冷却挡下的信号数（两臂）与候选未武装的冷却数，都按开盘扫描与其他扫描分开；没有归因块；
 *   - report_only_dimensions：四行只报不判（in_verdict:false）。
 */
const fx1 = require('./_q1_fixture');
const fx2 = require('./_q2_fixture');
const q4 = require('../services/candidate-comparison/questions/q4');

const hex = fx1.hex;

const dim = (key, label, end, g, ci) => ({ key, label_zh: label, end_capital: end, n: 120, mean_R: 0.05, max_drawdown: 0.17,
  g_vs_baseline: { value: g, ci_95: ci }, changed_entries: 33, in_verdict: false });

/** q0Doc 与 q0Sha 是已导入 Q0 锁定的那份文件；Q4 的原版臂必须逐项等于它的 D 臂。 */
function result(q0Doc, q0Sha, q0ResultId, overrides = {}) {
  const transform = (doc) => {
    doc.identity.schema = 'US_V5_M2_Q4_RESULT_V1';
    doc.identity.k2 = { ref: q4.K2_REF, sha256: q4.K2_SHA256 };
    doc.gates = Object.fromEntries(['ACCEPTANCE', 'INPUTS', 'BASELINE_REPRO', 'COOLDOWN_PARITY', 'INERT_Q0F', 'INERT_Q2', 'INERT_Q3', 'PROBE']
      .map((name) => [name, { state: 'PASSED' }]));
    doc.arms.CANDIDATE_COOLDOWN_ON_OPEN = doc.arms.CANDIDATE_1X;
    delete doc.arms.CANDIDATE_1X;
    for (const row of doc.stress.rows) {
      if (row.arms && row.arms.CANDIDATE_1X) { row.arms.CANDIDATE_COOLDOWN_ON_OPEN = row.arms.CANDIDATE_1X; delete row.arms.CANDIDATE_1X; }
    }
    delete doc.attribution;
    doc.comparison = {
      baseline_result_id: q0ResultId,
      question_zh: '把 24 h 冷却改为只在真正开仓时武装（A25），完整账户的对数增长是更好还是更差？',
      candidate_label_zh: '候选 冷却只在开仓时武装：没有开仓的信号都不武装冷却，其余全部相同',
      g_vs_baseline: { value: 0.011, ci_95: [-0.008, 0.030] },
      criteria: {
        G1: { met: true, baseline_oos_trades: 111, candidate_oos_trades: 129, changed_entries: 40 }, P_G: { met: false }, F3: { triggered: false },
      },
      secondary: {
        literal: { n: 129, mean_R: 0.09, ci_95: [-0.15, 0.33] },
        paired: { n_paired: 100, mean_dR: 0, ci_95: [0, 0], n_baseline_only: 11, n_candidate_only: 29 },
      },
      exposure: {
        BASELINE: { avg_notional_usd: 1786, time_in_market_ratio: 0.41, notional_cap_rejections: 54, notional_cap_reductions: 62, avg_actual_risk_usd: 35,
          cooldown_blocked_signals: { open_scan: 283, other: 1235 } },
        CANDIDATE_COOLDOWN_ON_OPEN: { avg_notional_usd: 1800, time_in_market_ratio: 0.45, notional_cap_rejections: 70, notional_cap_reductions: 66, avg_actual_risk_usd: 35,
          cooldown_blocked_signals: { open_scan: 24, other: 82 },
          arms_not_set: { gate_refusal: { open_scan: 251, other: 498 }, other_no_open: { open_scan: 757, other: 1571 } } },
      },
    };
    doc.verdict = {
      class: 'CANDIDATE_COMPARISON_V1', state: 'INSUFFICIENT', reason_codes: ['OOS_REUSED_FOR_SELECTION', 'CI_G_STRADDLES_ZERO', 'STRESS_SCENARIO_MISSING'],
      L_g: -0.008, U_g: 0.030, delta_g: 0, delta_R: 0.10, engine_approximation: { flag: false, missing: [] },
    };
    doc.oos_reuse = true;
    doc.oos_reuse_detail = { reason_zh: '计划 §5.2 的风控维度行「供 Q4 立题」；Q0 的「完全去掉冷却」行在定题时可见；A25 的签字文本也引用了这一行；本题是那一行的收窄版本' };
    doc.forward = { rows: [], reason_zh: 'HK 没有这条规则的前向影子' };
    doc.report_only_dimensions = [
      dim('NO_24H_COOLDOWN', '完全去掉 24 h 冷却', 4038.14, 0.04, [-0.01, 0.09]),
      dim('MAX_POSITIONS_5', '同时持仓 3 → 5', 3417.93, 0, [0, 0]),
      dim('RISK_UNIT_90', '单元风险 60 → 90', 3321.59, -0.008, [-0.02, 0.004]),
      dim('GATE_REFUSAL_ONLY_UNARM', '只撤销入场闸门拒绝造成的冷却', 3700.5, 0.02, [-0.02, 0.06]),
    ];
    doc.reproducibility = { command: 'node run-q4.js', runs: [{ sha256: hex('q4-run') }, { sha256: hex('q4-run') }], identical: true };
  };
  return fx2.result(q0Doc, q0Sha, q0ResultId, (doc) => {
    transform(doc);
    if (typeof overrides === 'function') overrides(doc);
    else Object.assign(doc, overrides);
    return doc;
  });
}

module.exports = { result, write: fx1.write, hex };
