'use strict';
/**
 * 合成的 US_V5_M2_Q3_RESULT_V1，只用于测试 Q3 登记项和页面。数字没有经济含义；路径带 fixture 字样，
 * 导入器默认把它当「非实际来源」拒绝，只有测试显式放行。
 *
 * 默认形状 = Q3 K2 裁定 1–6 的样子：
 *   - Q3b（主卡）：优势结论 SUPPORTED（配对 g，95%，G1 成立），压力有缺；oos_reuse:false 且带 OOS_PREVIOUSLY_EVALUATED_SAME_RULE；
 *     敞口披露两臂，候选臂另有行业 RS 的拒绝数与重排时点数；没有归因块；
 *   - random_control：Q3a（候选顺序随机，OOS 选择点 7 个 → G1 不成立 → 证据不足，只跑 200 个种子作描述）与
 *     Q3a2（随机标的，选择点 = 每笔开仓，≥ 30，1,000 个种子，胜过 81% → 有支持证据），各自的结论、与 Q3b 无关；
 *   - 参照臂 reference_arms.EQUAL_WEIGHT_1X_BUY_HOLD（价格收益，不含分红）。
 */
const fx1 = require('./_q1_fixture');
const fx2 = require('./_q2_fixture');
const q3 = require('../services/candidate-comparison/questions/q3');

const hex = fx1.hex;
const QUANTILES_G = { p05: -0.052, p25: -0.021, p50: 0.003, p75: 0.028, p95: 0.066 };
const QUANTILES_R = { p05: -0.21, p25: -0.09, p50: 0.02, p75: 0.13, p95: 0.27 };

/** 随机对照的一部分：oos／is 是选择点数，n 是种子数，share 是基线 g 胜过的种子比例。 */
function part({ oos, is, n, state, share, codes = [], rule = 'G1' }) {
  return {
    seeds: { rule: 'seed_i = 20261025 + i，i = 0…n−1，运行前固定', n, first: 20261025, last: 20261025 + n - 1 },
    choice_points: {
      definition_zh: '同一扫描时点至少一笔开仓，同时另有一个通过全部信号级闸门的同时点候选被容量规则拒绝', oos, is, rows: [],
    },
    distribution: { g: { ...QUANTILES_G }, net_R: { ...QUANTILES_R } },
    baseline: { g: -0.016, net_R: -0.0162, share_beaten_g: share, share_beaten_net_R: 0.5, percentile_g: share * 100 },
    verdict: { class: 'RANDOM_SELECTION_CONTROL_V1', state, rule, reason_codes: codes },
  };
}

/** q0Doc 与 q0Sha 是已导入 Q0 锁定的那份文件；Q3 的原版臂必须逐项等于它的 D 臂。 */
function result(q0Doc, q0Sha, q0ResultId, overrides = {}) {
  const transform = (doc) => {
    const dates = doc.arms.BASELINE.equity.dates;
    doc.identity.schema = 'US_V5_M2_Q3_RESULT_V1';
    doc.identity.k2 = { ref: q3.K2_REF, sha256: q3.K2_SHA256 };
    doc.gates = Object.fromEntries(['ACCEPTANCE', 'INPUTS', 'BASELINE_REPRO', 'INERT_Q0F', 'INERT_Q1', 'INERT_Q2', 'RANDOM_IDENTITY', 'RS_TABLE_PARITY', 'PROBE']
      .map((name) => [name, { state: 'PASSED' }]));
    doc.arms.CANDIDATE_SECTOR_RS = doc.arms.CANDIDATE_1X;
    delete doc.arms.CANDIDATE_1X;
    for (const row of doc.stress.rows) {
      if (row.arms && row.arms.CANDIDATE_1X) { row.arms.CANDIDATE_SECTOR_RS = row.arms.CANDIDATE_1X; delete row.arms.CANDIDATE_1X; }
    }
    const equalWeight = doc.arms.SPY_BUY_HOLD.equity.values.map((value, index) => Math.round(value * (1 + 0.002 * index) * 1e6) / 1e6);
    doc.reference_arms = {
      EQUAL_WEIGHT_1X_BUY_HOLD: {
        reference: true, label_zh: '15 只 1× 多头等权买入持有',
        equity: { dates, values: equalWeight },
        summary: { end_capital: equalWeight[equalWeight.length - 1], cagr: 0.14, max_drawdown: 0.19, longest_underwater_sessions: 40, recovered: true },
      },
    };
    delete doc.attribution;
    doc.comparison = {
      baseline_result_id: q0ResultId,
      question_zh: '加上行业 RS 排序层（13 只行业 ETF 对 SPY 的 63／126 日超额收益，取前 4），完整账户是更好还是更差？',
      candidate_label_zh: '候选 行业 RS 排序：基线线加排序层，其余全部相同',
      g_vs_baseline: { value: 0.018, ci_95: [0.003, 0.034] },
      criteria: {
        G1: { met: true, baseline_oos_trades: 112, candidate_oos_trades: 104, changed_entries: 41 }, P_G: { met: true }, F3: { triggered: false },
      },
      secondary: {
        literal: { n: 104, mean_R: 0.13, ci_95: [0.03, 0.23] },
        paired: { n_paired: 70, mean_dR: 0.04, ci_95: [-0.04, 0.12], n_baseline_only: 24, n_candidate_only: 14 },
      },
      exposure: {
        BASELINE: { avg_notional_usd: 1450, time_in_market_ratio: 0.42, notional_cap_rejections: 54, notional_cap_reductions: 7, avg_actual_risk_usd: 52 },
        CANDIDATE_SECTOR_RS: {
          avg_notional_usd: 1390, time_in_market_ratio: 0.39, notional_cap_rejections: 49, notional_cap_reductions: 6, avg_actual_risk_usd: 51,
          sector_rs_refusals: 31, reorder_instants: 12,
        },
      },
    };
    doc.verdict = {
      class: 'CANDIDATE_COMPARISON_V1', state: 'SUPPORTED', reason_codes: ['OOS_PREVIOUSLY_EVALUATED_SAME_RULE', 'STRESS_SCENARIO_MISSING'],
      L_g: 0.003, U_g: 0.034, delta_g: 0, delta_R: 0.10, engine_approximation: { flag: false, missing: [] },
    };
    doc.oos_reuse = false;
    doc.oos_reuse_detail = {
      reason_zh: '排序参数在 RS-1 签署时冻结，没有用 2023–2026 这段数据挑选；进入 A23 前向是「证据不足 → 前向」的常设规则，不是因为结果好',
      same_rule_zh: 'RS-1 已在 2023-01-01 → 2026-09-30 评价过同一规则（INSUFFICIENT，随机名次对照在第 59.5／68 百分位）；本题是在当前 D 上的复测',
    };
    doc.forward = { rows: [], reason_zh: 'A23 未开启，HK 没有排序层前向' };
    doc.random_control = {
      ...part({ oos: 7, is: 2, n: 200, state: 'INSUFFICIENT', share: 0.62, codes: ['G1_NOT_MET'] }),
      random_instrument: part({ oos: 112, is: 40, n: 1000, state: 'SUPPORTED', share: 0.81 }),
    };
    doc.reproducibility = { command: 'node run-q3.js --seed 20261025', runs: [{ sha256: hex('q3-run') }, { sha256: hex('q3-run') }], identical: true };
  };
  return fx2.result(q0Doc, q0Sha, q0ResultId, (doc) => {
    transform(doc);
    if (typeof overrides === 'function') overrides(doc);
    else Object.assign(doc, overrides);
    return doc;
  });
}

module.exports = { result, write: fx1.write, hex, part };
