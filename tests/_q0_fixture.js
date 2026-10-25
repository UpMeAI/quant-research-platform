'use strict';
/**
 * 合成的 US_V5_M2_Q0_RESULT_V1，只用于测试导入器和页面。数字没有经济含义；路径带 fixture 字样，
 * 导入器默认把它当「非实际来源」拒绝，只有测试显式放行。真实结果文件落地后，测试仍用它，不换成真实数字。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hex = (seed) => crypto.createHash('sha256').update(seed).digest('hex');

function equity(start, steps) {
  const values = [start];
  for (const step of steps) values.push(Math.round(values[values.length - 1] * (1 + step) * 1e6) / 1e6);
  return values;
}

function result(overrides = {}) {
  const dates = ['2023-01-03', '2023-01-04', '2023-01-05', '2023-01-06', '2023-01-09', '2023-01-10'];
  const d = equity(3000, [0.01, -0.005, 0.012, 0.004, 0.002]);
  const spy = equity(3000, [0.002, -0.001, 0.003, 0.001, 0.0005]);
  const cash = equity(3000, [0, 0, 0, 0, 0]);
  const summary = (values, extra = {}) => ({
    end_capital: values[values.length - 1], cagr: 0.31, max_drawdown: 0.05, longest_underwater_sessions: 2, recovered: true, ...extra,
  });
  const base = {
    identity: {
      schema: 'US_V5_M2_Q0_RESULT_V1', plan_sha256: hex('plan'), amendment_sha256: hex('amendment'),
      smartflow_commit: '2382c2d14eb66c1cef5a7df35c7cdb543c507853',
      engine_files: { 'scripts/research/replay-us-v5-universe-comparison.js': hex('engine').slice(0, 40) },
      config: { book: { equity: 3000, riskUnit: 60, maxPositions: 3 } }, command: 'node run-q0.js --seed 7', seed: 7,
    },
    inputs: {
      series: [
        { symbol: 'MSFT', role: 'parent', source_host: 'mac', source_ref: 'research-data/x/MSFT.30min.json', range: { from: '2019-06-03', to: '2026-10-02' }, rows: 100, sha256: hex('MSFT') },
        { symbol: 'MSFU', role: 'carrier', source_host: 'mac', source_ref: 'research-data/x/MSFU.30min.json', range: { from: '2022-09-09', to: '2026-10-02' }, rows: 80, sha256: hex('MSFU') },
        { symbol: 'SPY', role: 'benchmark', source_host: 'mac', source_ref: 'research-data/x/SPY.30min.json', range: { from: '2019-06-03', to: '2026-10-02' }, rows: 120, sha256: hex('SPY') },
      ],
      census: [{ year: 2020, tradable_carriers: 67 }, { year: 2023, tradable_carriers: 75 }],
      segments: [
        { id: 'IS-a', start: '2020-01-02', end: '2022-08-08', sessions: 150, tradable_carriers: 67, pool_overlap_ratio: 0.5 },
        { id: 'IS-b', start: '2022-08-09', end: '2022-12-30', sessions: 100, tradable_carriers: 74, pool_overlap_ratio: 0.8 },
        { id: 'OOS', start: '2023-01-03', end: '2026-10-02', sessions: 900, tradable_carriers: 80, pool_overlap_ratio: 1 },
      ],
    },
    gates: {
      I1: { state: 'PASSED' }, A0: { state: 'PASSED', rows: [] },
      rules: [{ rule: 'A17 3000/60/3', status: 'IMPLEMENTED', code_ref: 'x.js:10' }, { rule: 'U1 换仓', status: 'IMPLEMENTED', code_ref: 'x.js:20' }],
    },
    arms: {
      D: { equity: { dates, values: d }, summary: summary(d), trades: [{ id: 1 }, { id: 2 }] },
      SPY_BUY_HOLD: { equity: { dates, values: spy }, summary: summary(spy, { cagr: 0.12 }) },
      CASH: { equity: { dates, values: cash }, summary: summary(cash, { cagr: 0, max_drawdown: 0, longest_underwater_sessions: 0 }) },
    },
    stats: {
      rows: [
        { segment: 'IS-a', cost_bps: 5, phase: 'PRODUCTION', n: 40, win_rate: 0.45, payoff: 1.8, mean_R: 0.08, mean_R_ci: [-0.05, 0.2], g: 0.2, cagr: 0.2, max_drawdown: 0.08, longest_underwater_sessions: 20, recovered: true, end_capital: 5100 },
        { segment: 'OOS', cost_bps: 5, phase: 'PRODUCTION', n: 81, win_rate: 0.5, payoff: 1.9, mean_R: 0.22, mean_R_ci: [0.12, 0.31], g: 0.3, cagr: 0.31, max_drawdown: 0.1, longest_underwater_sessions: 30, recovered: true, end_capital: 9000 },
        { segment: 'OOS', cost_bps: 15, phase: 'PRODUCTION', n: 81, win_rate: 0.48, payoff: 1.8, mean_R: 0.15, mean_R_ci: [0.05, 0.25], g: 0.2, cagr: 0.25, max_drawdown: 0.11, longest_underwater_sessions: 35, recovered: true, end_capital: 8000 },
        { segment: 'OOS', cost_bps: 5, phase: 'PLUS_60MIN', n: 79, win_rate: 0.47, payoff: 1.7, mean_R: -0.02, mean_R_ci: [-0.12, 0.08], g: -0.01, cagr: 0.0, max_drawdown: 0.15, longest_underwater_sessions: 60, recovered: false, end_capital: 2900 },
      ],
    },
    stress: {
      rows: [
        { scenario: 'FEES_15BPS', label: '费用 15 bps 双边', max_loss_usd: 600, longest_underwater_sessions: 35, recovered: true, end_capital: 8000, simulated: false },
        { scenario: 'REPLAY_2020_02_19_2020_04_30', label: '区间重放：2020-02-19 至 2020-04-30', max_loss_usd: 900, longest_underwater_sessions: 40, recovered: true, end_capital: 3100, simulated: false },
        { scenario: 'EXTREME_BEAR_2008_BOUNDARY_SYNTHETIC', label: '规则边界情景：只含 SPY / QQQ 合成载体，不是本策略标的池；模拟序列，不是可交易历史', max_loss_usd: 2400, longest_underwater_sessions: 160, recovered: false, end_capital: 600, simulated: true },
        {
          scenario: 'EXTREME_BEAR_2008', label: '极端熊市 2008', missing: true, simulated: false,
          missing_reason: '2007–2009 行业 ETF 日线在 Mac 与 HK 均无，按 Owner 规则不重新拉取',
          max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: null,
        },
      ],
    },
    half_kelly: {
      p: 0.5, p_ci: [0.42, 0.58], b: 1.9, b_ci: [1.5, 2.3], f_star: 0.24, f_half: 0.06, floor_usd: 1800,
      replay: {
        half_kelly: { end_capital_ci: [7000, 15000], max_drawdown: 0.18, p_below_floor: 0.07 },
        fixed_60: { end_capital_ci: [6000, 12000], max_drawdown: 0.12, p_below_floor: 0.03 },
      },
    },
    formula_table: {
      kind: 'FORMULA_NOT_BACKTEST',
      cells: [{ win_rate: 0.4, payoff: 2, expected_growth: -0.001 }, { win_rate: 0.5, payoff: 2, expected_growth: 0.004 }, { win_rate: 0.6, payoff: 2, expected_growth: 0.01 }],
    },
    verdict: {
      class: 'BASELINE_EVALUATION_V1', state: 'INSUFFICIENT', comparators: ['SPY_BUY_HOLD', 'CASH'], ci_method: 'MONTHLY_BLOCK_BOOTSTRAP_95',
      delta_R: 0.10, delta_g: 0, L_R: 0.12, U_R: 0.31, L_g: -0.01, U_g: 0.4, n_trades: 81, reason_codes: ['CI_STRADDLES_DELTA'],
      engine_approximation: { flag: false, missing: [] },
    },
    diagnosis_items: [
      { id: 'DX1', source: 'ENTRY_EXIT', facts: ['样本外 16 / 81 笔以 TIME stop 退出，T3 研究点估计同向为正'], proposed_experiment: 'Q1', no_topic_reason: null },
      { id: 'DX2', source: 'EXECUTION', facts: ['同一规则相隔 60 分钟的两个扫描相位差 1,893 USD'], proposed_experiment: null, no_topic_reason: '相位是执行条件，不立「选相位」的题' },
    ],
    reproducibility: { command: 'node run-q0.js --seed 7', runs: [{ sha256: hex('run') }, { sha256: hex('run') }], identical: true },
  };
  return typeof overrides === 'function' ? overrides(base) || base : { ...base, ...overrides };
}

/** 在临时目录 q0-import-fixture-XXXX 下写 RESULT.json 及旁边的 .sha256；返回路径。 */
function write(doc = result(), { sidecar = true, tamperSidecar = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q0-import-fixture-'));
  const file = path.join(dir, 'RESULT.json');
  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  fs.writeFileSync(file, bytes);
  if (sidecar) fs.writeFileSync(`${file}.sha256`, `${tamperSidecar ? hex('wrong') : crypto.createHash('sha256').update(bytes).digest('hex')}  RESULT.json\n`);
  return file;
}

module.exports = { result, write, hex };
