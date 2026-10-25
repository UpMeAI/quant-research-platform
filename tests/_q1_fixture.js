'use strict';
/**
 * 合成的 US_V5_M2_Q1_RESULT_V1，只用于测试 Q1 导入器和页面。数字没有经济含义；路径带 fixture 字样，
 * 导入器默认把它当「非实际来源」拒绝，只有测试显式放行。真实 Q1 文件落地后，测试仍用它，不换成真实数字。
 *
 * 默认形状 = 研究会话最可能交付的那一种：优势结论 SUPPORTED，但压力有缺（缺场景、无效输入、补充行候选臂缺项），
 * 且样本外是复测（oos_reuse）——所以页面应写出三行：优势结论 / 压力评价不完整 / 采用条件未满足。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const q0 = require('./_q0_fixture');
const comparison = require('../services/candidate-comparison');

const hex = q0.hex;
const clone = (value) => JSON.parse(JSON.stringify(value));

const cell = (end_capital, max_loss_usd, longest_underwater_sessions, recovered = true) => ({ max_loss_usd, longest_underwater_sessions, recovered, end_capital });
const diffOf = (base, cand) => ({
  max_loss_usd: cand.max_loss_usd - base.max_loss_usd, end_capital: cand.end_capital - base.end_capital,
  longest_underwater_sessions: cand.longest_underwater_sessions - base.longest_underwater_sessions,
});
const row = (scenario, label, base, cand, extra = {}) => ({ scenario, label, simulated: false, arms: { BASELINE: base, CANDIDATE_T3: cand }, diff: diffOf(base, cand), ...extra });
const NULLS = { max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: null };

/** q0Doc 与 q0Sha 是已导入 Q0 锁定的那份文件；Q1 的原版臂必须逐项等于它的 D 臂。 */
function result(q0Doc, q0Sha, q0ResultId, overrides = {}) {
  const dates = q0Doc.arms.D.equity.dates;
  const baseValues = q0Doc.arms.D.equity.values;
  const candValues = baseValues.map((value, index) => Math.round(value * (1 + 0.004 * index) * 1e6) / 1e6);
  const spyValues = q0Doc.arms.SPY_BUY_HOLD.equity.values;
  const cashValues = q0Doc.arms.CASH.equity.values;
  const candSummary = {
    end_capital: candValues[candValues.length - 1], cagr: 0.33, max_drawdown: 0.052, longest_underwater_sessions: 2, recovered: true,
  };
  const base = {
    identity: {
      schema: 'US_V5_M2_Q1_RESULT_V1', result_kind: 'CHALLENGER_VS_BASELINE', d_version: 'US_V5_ETF_3000USD@2382c2d1',
      smartflow_commit: q0Doc.identity.smartflow_commit, engine_files: clone(q0Doc.identity.engine_files),
      baseline_result_id: q0ResultId, baseline: { result_id: q0ResultId, sha256: q0Sha },
      k2: { ref: comparison.K2_REF, sha256: comparison.K2_SHA256 }, t3_acceptance_sha256: hex('t3-acceptance'),
      oos_reuse: { reused: { from: '2023-01-03', to: '2026-10-02' }, independent: ['缓存尾段 2026-10-03 至 10-23', 'HK 前向 B 流与 S 流'] },
      command: 'node run-q1.js --seed 20261004', seed: 20261004,
    },
    inputs: clone(q0Doc.inputs),
    gates: {
      ACCEPTANCE: { state: 'PASSED' }, INPUTS: { state: 'PASSED' }, BASELINE_REPRO: { state: 'PASSED', label_zh: '不设新选项时逐字节复现 Q0 的 D 臂' },
      INERT_Q0F: { state: 'PASSED' }, INERT_TWINS: { state: 'PASSED' }, TWIN_PARITY: { state: 'PASSED' }, PROBE: { state: 'PASSED' },
    },
    arms: {
      window: { start: dates[0], end: dates[dates.length - 1] },
      BASELINE: { equity: { dates, values: baseValues }, summary: clone(q0Doc.arms.D.summary), trades: [{ id: 1 }, { id: 2 }] },
      CANDIDATE_T3: { equity: { dates, values: candValues }, summary: candSummary, trades: [{ id: 1 }, { id: 2 }], deferred_sessions: 37 },
      SPY_BUY_HOLD: { equity: { dates, values: spyValues }, summary: clone(q0Doc.arms.SPY_BUY_HOLD.summary) },
      CASH: { equity: { dates, values: cashValues }, summary: clone(q0Doc.arms.CASH.summary) },
    },
    stats: { rows: [{ arm: 'BASELINE', segment: 'OOS', cost_bps: 5, phase: 'PRODUCTION', n: 81 }, { arm: 'CANDIDATE_T3', segment: 'OOS', cost_bps: 5, phase: 'PRODUCTION', n: 80 }] },
    stress: {
      rows: [
        row('COST_15BPS', '费用 15 bps 双边', cell(8000, 600, 35), cell(8200, 590, 33)),
        row('SCAN_PHASE_PLUS_60MIN', '扫描相位 +60 分钟', cell(2900, 900, 60, false), cell(3000, 850, 55, false)),
        row('WINDOW_2022_01_03_10_31', '区间重放：2022-01-03 至 2022-10-31', cell(3100, 700, 80), cell(3200, 650, 75)),
        row('RISK_NO_24H_COOLDOWN', '风控维度：不设 24 小时冷却', cell(8600, 650, 33), cell(8700, 640, 31)),
        row('BASELINE', '当前 D 参照行', cell(9000, 500, 30), cell(9300, 480, 28)),
        {
          scenario: 'WINDOW_2020_02_19_04_30', label: '区间重放：2020-02-19 至 2020-04-30', status: 'INVALID_INPUT', simulated: false,
          reason: '无效输入：2020 年 2 月前后 1h 序列有 38% 缺口，按 Owner 规则不补数', ...NULLS,
        },
        {
          scenario: 'EXTREME_DOWNTURN_2008', label: '极端下跌 2008', status: 'MISSING_SCENARIO', simulated: false,
          reason: '缺场景：2007–2009 行业 ETF 日线在 Mac 与 HK 均无，按 Owner 规则不重新拉取', ...NULLS,
        },
        {
          scenario: 'SPY_QQQ_SYNTHETIC_2008', label: '规则边界情景：只含 SPY / QQQ 合成载体；模拟序列', status: 'SUPPLEMENTARY_NOT_IN_CONCLUSION',
          simulated: true, in_headline: false,
          arms: { BASELINE: cell(600, 2400, 160, false), CANDIDATE_T3: { missing: true, ...NULLS, missing_reason: '取不到 dailyRead：这是 Q0 运行器里独立的日线简化循环，没有 1h 序列' } },
        },
      ],
    },
    half_kelly: clone(q0Doc.half_kelly),
    formula_table: clone(q0Doc.formula_table),
    comparison: {
      baseline_result_id: q0ResultId, candidate_arm: 'T3', population: 'S',
      question_zh: '把趋势期间到期的 5 日时间止损推迟，能不能改善完整账户的扣费后结果？',
      populations: {
        S: { n_aff: 34, blocks: 12, n_total: 60, n_zero: 26, mean_dR: 0.31, ci_95: [0.18, 0.44], ci_98_33: [0.10, 0.52], mde: 0.2 },
        B: { n_aff: 9, blocks: 5, n_total: 23, n_zero: 14, mean_dR: 0.2, ci_95: [-0.1, 0.5], ci_98_33: [-0.2, 0.6], mde: 0.5 },
      },
      g_vs_baseline: { value: 0.021, ci_95: [0.005, 0.04], ci_98_33: [0.002, 0.045] },
      bonferroni: { level: 0.9833, variants: 3 },
      criteria: {
        G1: { met: true, baseline_oos_trades: 111 }, P1: { met: true }, P2: { met: true }, P3: { met: true }, P4: { met: true },
        F1: { triggered: false }, F2: { triggered: false }, F3: { triggered: false },
      },
      secondary: { mean_dR_all_time_exits: 0.1, n_time_exits: 23, by_reason: [{ reason: 'TIME', n: 23, mean_dR: 0.1 }] },
      per_trade: [{ id: 'S-1', delta_R: 0.4, deferred_sessions: 3, block: 1 }, { id: 'S-2', delta_R: 0, deferred_sessions: 0, block: 1 }],
    },
    forward: [
      { stream: 'B', file: 'time-stop-shadow.jsonl', file_sha256: hex('forward-b'), line: 1, text_zh: 'B 流第 1 行：孪生按 T3 推迟 2 个 session', in_verdict: false, deferred_sessions: 2 },
      { stream: 'S', file: 'time-stop-shadow-s.jsonl', file_sha256: hex('forward-s'), line: 4, status: 'S_RUN_BLOCKED', in_verdict: false },
    ],
    oos_reuse: true,
    verdict: {
      class: 'CANDIDATE_COMPARISON_V1', state: 'SUPPORTED', t3_state: 'PASS', delta_star: 0.15, delta_g: 0,
      L_D: 0.10, U_D: 0.52, L_g: 0.002, U_g: 0.045, reason_codes: ['OOS_REUSED_FOR_SELECTION', 'STRESS_SCENARIO_MISSING'],
      engine_approximation: { flag: false, missing: [] },
    },
    diagnosis_items: [{ id: 'Q1X1', source: 'ENTRY_EXIT', facts: ['推迟后 34 笔受影响交易'], proposed_experiment: null, no_topic_reason: '本题已判' }],
    reproducibility: { command: 'node run-q1.js --seed 20261004', runs: [{ sha256: hex('q1-run') }, { sha256: hex('q1-run') }], identical: true },
  };
  return typeof overrides === 'function' ? overrides(base) || base : { ...base, ...overrides };
}

/** 在临时目录 q0-import-fixture-XXXX 下写 RESULT.json 及旁边的 .sha256；返回路径。 */
function write(doc, { sidecar = true, tamperSidecar = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q0-import-fixture-'));
  const file = path.join(dir, 'Q1_RESULT.json');
  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  fs.writeFileSync(file, bytes);
  if (sidecar) fs.writeFileSync(`${file}.sha256`, `${tamperSidecar ? hex('wrong') : crypto.createHash('sha256').update(bytes).digest('hex')}  Q1_RESULT.json\n`);
  return file;
}

module.exports = { result, write, hex, cell, row, NULLS, clone };
