'use strict';
/**
 * 合成的 US_CORE_M2_Q0_RESULT_V1（US_CORE_Q0_RESULT_V1_IMPORT_PROFILE §11.8 的负例夹具）：形状与美股核心轮动的封存文件相同
 * （G_GAP：没有 R，主指标是样本外年化对数增长差；cost_bps；episodes；A0 两种读法；附近似说明的已实现规则；
 * 风控高亮行 RISK_RULE1B_HONORED；半凯利 NOT_APPLICABLE；arms_is；REFERENCE 参照臂；EQUITY 前向），数字是合成的，没有经济含义；
 * CI 不读真实文件。路径带 fixture 字样，导入器默认按「非实际来源」拒绝，只有测试显式放行。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hex = (seed) => crypto.createHash('sha256').update(seed).digest('hex');
const RULING = '50823436049d05ef5901f0047916f82a806a0c488f526a93eb64277272c3d94e';
const DATES = ['2018-01-02', '2018-01-03', '2018-01-04', '2018-01-05'];
const series = (start, steps) => steps.reduce((values, step) => [...values, Math.round(values[values.length - 1] * (1 + step) * 1e6) / 1e6], [start]);

function result(patch = (doc) => doc) {
  const d = series(9000, [0.02, -0.01, 0.015]);
  const spy = series(9000, [0.01, -0.004, 0.006]);
  const summary = (values, extra = {}) => ({ end_capital: values[values.length - 1], cagr: 0.2, g: 0.18, max_drawdown: 0.1, longest_underwater_sessions: 3, recovered: false, ...extra });
  const cash = { end_capital: 9000, cagr: 0, g: 0, max_drawdown: 0, longest_underwater_sessions: 0, recovered: true };
  const episodes = { lev: { n: 40, win_rate: 0.4, payoff: 3.5, mean_return: 0.06, mean_win: 0.3, mean_loss: -0.08, mean_days: 90 }, bench: { n: 30, win_rate: 0.5, payoff: 1.2, mean_return: 0.01, mean_win: 0.05, mean_loss: -0.03, mean_days: 20 } };
  const row = (segment, cost, phase, extra = {}) => ({
    segment, cost_bps: cost, phase, n_sessions: 2000, g: 0.2, cagr: 0.22, max_drawdown: 0.4, max_loss_usd: 9000, longest_underwater_sessions: 400, recovered: false,
    recovered_from_max_drawdown: true, end_capital: 40000, g_spy: 0.13, g_diff_spy: 0.07, g_diff_spy_ci: [-0.1, 0.25], g_ci: [-0.05, 0.45], g_diff_cash: 0.2,
    months: 105, switches: 120, fees_usd: 100, data_gaps: 0, episodes, mean_R: null, mean_R_ci: null, engine: 'REPLAYCORE', ...extra,
  });
  const main = row('OOS', 5, 'NEXT_OPEN');
  const doc = {
    identity: {
      schema: 'US_CORE_M2_Q0_RESULT_V1', label_zh: '当前 D', strategy_ref: 'US_CORE_9000USD_3X_GATEOBS', case_ref: 'RRC-US-CORE-9000-V8-1-M0',
      smartflow_commit: 'f'.repeat(40), engine_files: { 'scripts/research/us-core-bucket-lib.js': 'a'.repeat(40) },
      a0_ruling_1_sha256: RULING, a0_result_sha256: hex('a0'), config: { equity: 9000, floor_usd: 5400 }, seed: 1,
    },
    inputs: {
      series: [{ symbol: 'SPY', role: 'parent', source_host: 'smartflow-repo', source_ref: 'research/us-core-bear-stress/data/SPY.json', range: { from: '1993-01-29', to: '2026-09-30' }, rows: 8475, sha256: hex('spy') }],
      census: [{ year: 2018, sessions: 251, upro_sessions: 251, tqqq_sessions: 251, tradable_carriers: 2 }],
      segments: [
        { id: 'IS', start: '2010-02-11', end: '2017-12-29', sessions: 1986, months: 95, tradable_carriers: 2, pool_overlap_ratio: 1 },
        { id: 'OOS', start: '2018-01-02', end: '2026-09-30', sessions: 2198, months: 105, tradable_carriers: 2, pool_overlap_ratio: 1 },
      ],
    },
    gates: {
      A0: { state: 'PASSED', basis: 'A0 ruling 1', passed_checks: '5 / 5', k2_literal: { state: 'FAILED', passed_checks: '3 / 5' },
        unknown_counts: { 'A0-1': 2, 'A0-2': 1, 'A0-3': 0 }, result_sha256: hex('a0'), rows: { 'A0-1': { state: 'PASSED', counts: { MATCHED: 3 } } } },
      TWIN_PARITY: { state: 'PASSED', sessions: 4184 },
      rules: [
        { rule: 'UC-S1', status: 'IMPLEMENTED', code_ref: 'src/workers/us-core-rotation-worker.js:338-358' },
        { rule: 'UC-D1', status: 'IMPLEMENTED', code_ref: 'src/workers/us-core-rotation-worker.js:221-258', approximation: '合成：Yahoo 事后修订开盘价' },
        { rule: 'UC-G1', status: 'NOT_APPLICABLE', code_ref: 'src/services/carry-risk.js:300-302', reason: '合成：只观察' },
      ],
    },
    arms: {
      D: { role: 'STRATEGY', equity: { dates: DATES, values: d }, summary: summary(d) },
      SPY_BUY_HOLD: { role: 'MARKET', basis: 'TOTAL_RETURN_ADJCLOSE', equity: { dates: DATES, values: spy }, summary: summary(spy, { recovered: true }) },
      CASH: { role: 'CASH', equity: { dates: DATES, values: DATES.map(() => 9000) }, summary: cash },
      REF_SPY_PRICE_ONLY: { role: 'REFERENCE', equity: { dates: DATES, values: spy }, summary: summary(spy) },
    },
    arms_is: { D: { summary: summary(d) }, SPY_BUY_HOLD: { summary: summary(spy) }, CASH: { summary: cash } },
    trades: { OOS: [], IS: [] },
    stats: { rows: [row('IS', 5, 'NEXT_OPEN'), row('IS', 15, 'NEXT_OPEN'), main, row('OOS', 15, 'NEXT_OPEN'), row('OOS', 5, 'NEXT_CLOSE')] },
    stress: { rows: [
      { scenario: 'BASELINE', label: 'Current D', max_loss_usd: 9000, max_drawdown: 0.4, longest_underwater_sessions: 400, recovered: false, end_capital: 40000, simulated: false },
      { scenario: 'COST_15BPS', label: 'OOS, 15 bp per side', max_loss_usd: 9500, max_drawdown: 0.42, longest_underwater_sessions: 410, recovered: false, end_capital: 38000, simulated: false },
      { scenario: 'PHASE_NEXT_CLOSE', label: 'OOS, next close', max_loss_usd: 12000.4, max_drawdown: 0.45, longest_underwater_sessions: 420, recovered: false, end_capital: 45000, simulated: false },
      { scenario: 'EXTREME_DOWNTURN_2008', label: 'Extreme downturn', missing: true, missing_reason: '合成：没有可交易的 3x 载体', max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: null, simulated: false },
      { scenario: 'SUPPLEMENTARY_SYNTHETIC_3X_2000_2002', label: '规则边界情景：合成 3x；模拟序列，不是可交易历史', max_loss_usd: 6000, max_drawdown: 0.7, longest_underwater_sessions: 500, recovered: false, end_capital: 2700, simulated: true, in_headline: false, status: 'SUPPLEMENTARY_NOT_IN_CONCLUSION' },
      { scenario: 'RISK_RULE1B_HONORED', label: 'OOS; halt after 40%', max_loss_usd: 4800, max_drawdown: 0.44, longest_underwater_sessions: 900, recovered: false, end_capital: 6100, simulated: false, report_only: true,
        halt_events: [{ session: '2019-05-28', equity: 6500, peak: 11000, drawdown: 0.4090909, effect: 'NEW_ENTRIES_REFUSED_FROM_NEXT_SESSION' }] },
      { scenario: 'RISK_PRE_U6_MACRO', label: 'OOS; pre-U6', max_loss_usd: 9000, max_drawdown: 0.4, longest_underwater_sessions: 400, recovered: false, end_capital: 40000, simulated: false, report_only: true },
    ] },
    half_kelly: { state: 'NOT_APPLICABLE', reason: '合成：没有每笔风险单位', floor_usd: 5400, p_below_floor: 0.2, p_end_below_start: 0.05, paths: 1000,
      method: 'OOS monthly block bootstrap of D daily log returns, 9,000 start', rule1b_events: { OOS: [{ session: '2019-05-28', equity: 6500, peak: 11000, drawdown: 0.41 }], FULL: [] } },
    formula_table: { kind: 'FORMULA_NOT_BACKTEST', basis: 'per 3x episode', cells: [{ win_rate: 0.4, payoff: 2, loss_per_episode: 0.08, expected_growth: 0.01 }] },
    verdict: {
      class: 'BASELINE_EVALUATION_V1', state: 'INSUFFICIENT', comparators: ['SPY_BUY_HOLD', 'CASH'], ci_method: 'MONTHLY_BLOCK_BOOTSTRAP_95',
      delta_R: null, delta_g: 0, L_g: -0.1, U_g: 0.25, L_g_cash: -0.05, U_g_cash: 0.45, g_diff_spy: 0.07, g_D: 0.2, g_spy: 0.13, n_months: 105, n_trades: 120,
      reason_codes: ['CI_STRADDLES_DELTA', 'OOS_REUSED_IN_DEVELOPMENT'], engine_approximation: { flag: false, missing: [] }, oos_reuse: true,
    },
    diagnosis_items: [{ id: 'DX-RISK-1', source: 'RISK', facts_zh: ['合成：Rule 1b 停止记录写不进本账本。'], facts: ['synthetic'], proposed_experiment: null, no_topic_reason: '合成夹具，不立题' }],
    forward: { in_verdict: false, book: 'US_CORE_9000USD_3X_GATEOBS', from: '2026-10-08', to: '2026-10-23', start_equity: 9000, end_equity: 8100, return: -0.1 },
    reproducibility: { command: 'node q0.js core --fixture', runs: [{ sha256: hex('run') }, { sha256: hex('run') }], identical: true },
  };
  return patch(doc) || doc;
}

/** 在临时目录 us-core-q0-import-fixture-XXXX 下写 RESULT.json 及旁边的 .sha256；返回路径。 */
function write(doc = result()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-core-q0-import-fixture-'));
  const file = path.join(dir, 'RESULT.json');
  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.sha256`, `${crypto.createHash('sha256').update(bytes).digest('hex')}  RESULT.json\n`);
  return file;
}

const fileSha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

module.exports = { result, write, hex, fileSha, RULING };
