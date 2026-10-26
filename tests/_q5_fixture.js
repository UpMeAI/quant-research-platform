'use strict';
/**
 * 合成的 US_V5_M2_Q5_RESULT_V1，只用于测试 Q5 登记项和页面。数字没有经济含义；路径带 fixture 字样，
 * 导入器默认把它当「非实际来源」拒绝，只有测试显式放行。
 *
 * 默认形状 = Q5 K2 与裁定 ★1–★4 (a) 的样子：
 *   - 原版臂 BASELINE_A25 = Q4 夹具的候选臂（同一组输入生成，逐项相同），`identity.baseline_arm_ref` 指向调用方给的 Q4 锁；
 *     候选臂 CANDIDATE_T3_ON_A25 借用 Q4 夹具的原版臂数字（只为形状）；
 *   - 优势结论 INSUFFICIENT（95% 区间跨过 0，G1 成立：改变的入场 + 出场 = 40），压力有缺；oos_reuse:true；
 *   - 敞口两臂都有冷却计数；reference_rows 三行只报不判；recommendation 按 ★3 (a) 六项核对，前 4 项全「是」→ ADOPT。
 */
const fx4 = require('./_q4_fixture');
const q5 = require('../services/candidate-comparison/questions/q5');

const hex = fx4.hex;
const BASE = 'BASELINE_A25';
const CAND = 'CANDIDATE_T3_ON_A25';
const Q4_ARM = 'CANDIDATE_COOLDOWN_ON_OPEN';

const cooldown = (a, b) => ({ cooldown_blocked_signals: { open_scan: a, other: b },
  arms_not_set: { gate_refusal: { open_scan: 251, other: 498 }, other_no_open: { open_scan: 757, other: 1571 } } });

const refRow = (key, label, end, g, ci) => ({ key, label_zh: label, end_capital: end, n: 120, mean_R: 0.05, max_drawdown: 0.17,
  g_vs_spy: { value: -0.1, ci_95: [-0.25, 0.05] }, g_vs_baseline: { value: g, ci_95: ci }, changed_vs_baseline: { entries: 20, exits: 15, total: 35 }, in_verdict: false });

const checks = (yes = [true, true, true, true]) => [
  { id: 1, item_zh: 'OOS 配对 g 点估计 > 0', yes: yes[0], facts_zh: '配对 g 0.011' },
  { id: 2, item_zh: '候选 OOS 最大回撤 ≤ 基线', yes: yes[1], facts_zh: '最大回撤 12% 对 13.6%' },
  { id: 3, item_zh: '成本与相位稳健', yes: yes[2], facts_zh: '15 bps 与相位 +60 分钟两行候选期末都不低于基线' },
  { id: 4, item_zh: '机制成立', yes: yes[3], facts_zh: '同一入场的入场价、止损、股数与初始风险全部相同' },
  { id: 5, counter: true, item_zh: '反证（只列出）：IS 配对 g 的方向', facts_zh: 'IS 配对 g −0.02' },
  { id: 6, counter: true, item_zh: '反证（只列出）：HK T3 前向影子受影响笔', facts_zh: 'B 流 2 笔 ΔR 合计 −2.16' },
];

/**
 * q0Doc／q0Sha／q0ResultId 是已导入的 Q0 锁；q4Lock 是已导入的 Q4 锁（它的候选臂是本题的原版臂）。
 * overrides 是函数时在默认形状上改；是对象时浅合并。
 */
function result(q0Doc, q0Sha, q0ResultId, q4Lock, overrides = {}) {
  return fx4.result(q0Doc, q0Sha, q0ResultId, (doc) => {
    doc.identity.schema = 'US_V5_M2_Q5_RESULT_V1';
    doc.identity.k2 = { ref: q5.K2_REF, sha256: q5.K2_SHA256 };
    doc.identity.baseline_arm_ref = q4Lock ? { result_id: q4Lock.result_id, arm: Q4_ARM, sha256: q4Lock.file_sha256 } : null;
    doc.gates = Object.fromEntries(['ACCEPTANCE', 'INPUTS', 'ENGINE_FILES_UNCHANGED', 'COMPOSE_KEYS', 'PARITY_T3_OFF', 'PARITY_A25_OFF', 'BASELINE_REPRO_D', 'NOCD_T3_REPRO']
      .map((name) => [name, { state: 'PASSED' }]));
    const base = doc.arms[Q4_ARM];
    const cand = { ...doc.arms.BASELINE, deferred_sessions: 4.05, deferred_trades: 21 };
    delete doc.arms[Q4_ARM]; delete doc.arms.BASELINE;
    doc.arms = { window: doc.arms.window, [BASE]: { ...base, baseline_arm_ref: doc.identity.baseline_arm_ref }, [CAND]: cand,
      ...Object.fromEntries(Object.entries(doc.arms).filter(([key]) => key !== 'window')) };
    for (const row of doc.stress.rows) {
      if (!row.arms) continue;
      let b = row.arms[Q4_ARM]; let c = row.arms.BASELINE;
      if (b && b.missing) [b, c] = [c, b]; // 真实的 Q5：补充行是候选（T3）缺项，原版（A25）有数
      row.arms = { [BASE]: b, [CAND]: c };
      if (row.diff && b && c && !c.missing) {
        row.diff = { ...row.diff, max_loss_usd: c.max_loss_usd - b.max_loss_usd, end_capital: c.end_capital - b.end_capital,
          longest_underwater_sessions: c.longest_underwater_sessions - b.longest_underwater_sessions };
      }
    }
    delete doc.report_only_dimensions;
    const exposure = doc.comparison.exposure;
    doc.comparison = {
      ...doc.comparison,
      question_zh: 'A25 生效后，再加 T3（趋势中推迟 5 日时间止损），完整账户的对数增长是更好还是更差？',
      candidate_label_zh: '候选 D+A25+T3：在 D+A25 上，处于趋势时推迟 5 日时间止损',
      baseline_arm_ref: doc.identity.baseline_arm_ref,
      criteria: {
        G1: { met: true, baseline_oos_trades: 129, candidate_oos_trades: 122, changed_entries: 18, changed_exits: 22, changed_total: 40, deferred_trades: 21 },
        P_G: { met: false }, F3: { triggered: false },
      },
      exposure: {
        [BASE]: { ...exposure[Q4_ARM] },
        [CAND]: { avg_notional_usd: 1850, time_in_market_ratio: 0.55, notional_cap_rejections: 160, notional_cap_reductions: 70, avg_actual_risk_usd: 36, ...cooldown(20, 80) },
      },
    };
    doc.comparison.exposure[BASE] = { ...doc.comparison.exposure[BASE], arms_not_set: cooldown(0, 0).arms_not_set };
    doc.oos_reuse_detail = { reason_zh: '2023-01-03 → 2026-10-02 是 T3 研究的 OOS；A25 的 Q4 在同一 OOS 上做过评价；本题的点估计在定题时已经可见' };
    doc.forward = { rows: [], reason_zh: 'HK 的 T3 前向影子跑在原版 D 上，只报不判' };
    doc.reference_rows = [
      refRow('REF_D', '原版 D（Q0 的 D 臂）', 3417.93, -0.04, [-0.1, 0.02]),
      refRow('REF_D_T3', 'D+T3（Q1 的候选臂）', 3795.65, -0.01, [-0.06, 0.04]),
      { key: 'COMBINED_VS_D', label_zh: '组合 D+A25+T3 对原版 D', end_capital: 4505.88, reference_end_capital: 3417.93,
        g_vs_reference: { value: 0.07, ci_95: [-0.01, 0.16] }, changed_vs_reference: { entries: 60, exits: 20, total: 80 }, in_verdict: false },
    ];
    doc.recommendation = { rule_ref: 'K2 ★3 (a)', checks: checks(), recommendation: 'ADOPT', recommendation_zh: '建议采用（纸面账户执行）',
      market_analysis_zh: ['机制：趋势未破不按时间离场。'], decided_by: 'OWNER' };
    doc.reproducibility = { command: 'node run-q5.js', runs: [{ sha256: hex('q5-run') }, { sha256: hex('q5-run') }], identical: true };
    if (typeof overrides === 'function') overrides(doc);
    else Object.assign(doc, overrides);
    return doc;
  });
}

module.exports = { result, write: fx4.write, hex, checks, BASE, CAND };
