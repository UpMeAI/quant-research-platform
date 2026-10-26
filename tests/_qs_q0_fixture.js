'use strict';
/**
 * 合成的 QS_V3_M2_Q0_RESULT_V1（CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE §11.7 的负例夹具）：形状与 Quick Shot V3 的封存文件相同
 * （cost 词、approximations、SAME_AS_BASELINE、缺场景行没有数字字段、floor_usd + fixed_7_2 + 第二个阈值、forward、supersedes），
 * 数字是合成的，没有经济含义；CI 不读真实文件。路径带 fixture 字样，导入器默认按「非实际来源」拒绝，只有测试显式放行。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hex = (seed) => crypto.createHash('sha256').update(seed).digest('hex');
const DATES = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04'];
const series = (start, steps) => steps.reduce((values, step) => [...values, Math.round(values[values.length - 1] * (1 + step) * 1e6) / 1e6], [start]);

function result(patch = (doc) => doc) {
  const d = series(1000, [0.01, -0.004, 0.006]);
  const btc = series(1000, [0.02, -0.01, 0.003]);
  const summary = (values, extra = {}) => ({ end_capital: values[values.length - 1], cagr: 0.2, max_drawdown: 0.1, longest_underwater_sessions: 3, recovered: false, ...extra });
  const cash = { end_capital: 1000, cagr: 0, max_drawdown: 0, longest_underwater_sessions: 0, recovered: true };
  const row = (segment, cost, phase, extra) => ({
    segment, cost, phase, n: 120, excluded_funding_missing: 3, excluded_share: 0.025, win_rate: 0.35, payoff: 2.4,
    mean_R: 0.2, mean_R_ci: [-0.1, 0.5], end_capital: 1500, g: 0.2, cagr: 0.2, max_drawdown: 0.2, longest_underwater_sessions: 100, recovered: false, ...extra,
  });
  const doc = {
    identity: {
      schema: 'QS_V3_M2_Q0_RESULT_V1', strategy_ref: 'QUICK_SHOT_V3_1000USDT', smartflow_commit: 'a'.repeat(40),
      engine_files: { 'scripts/research/qrp-crypto-v1/qs-q0.js': hex('engine') },
      config: { capital_usdt: 1000, resamples: 2000 }, command: 'node qs-q0.js core --fixture', seed: 1,
      supersedes: [{ state: 'SUPERSEDED', smartflow_commit: 'b'.repeat(40), result_sha256: hex('run-1'), reason_zh: '合成夹具：第一次运行的实现缺陷' }],
      change_note_zh: '合成夹具：只改实现，不改读法',
    },
    inputs: {
      series: [{ symbol: 'AAAUSDT', role: 'traded', source_host: 'fixture', source_ref: 'fixture/AAAUSDT', sha256: hex('AAA') }],
      census: [{ year: 2024, tradable_contracts: 300, liquid_contracts_20m: 290 }],
      segments: [{ id: 'IS', start: '2020-01-01', end: '2023-12-31', sessions: 1461 }, { id: 'OOS', start: '2024-01-01', end: '2024-01-04', sessions: 4 }],
    },
    gates: {
      A0: { state: 'PASSED', ref: 'QS_V3_A0_RESULT.json sha256 fixture' }, PREFILTER_SAFE: { state: 'PASSED', checked_hours: 10, missed: 0 }, signals: 12, skips: {},
      rules: [
        { rule: 'QS-S1', status: 'IMPLEMENTED', code_ref: 'rules.js:1', note_zh: null },
        { rule: 'QS-E1', status: 'APPROXIMATED', code_ref: 'service.js:2', note_zh: '合成近似：入场价读法，A0 窗口偏差 ±0.1 R' },
        { rule: 'QS-C5', status: 'NOT_APPLICABLE', code_ref: 'budget.js:3', note_zh: 'A19 共享，只引用不复算' },
      ],
    },
    arms: {
      D: { equity: { dates: DATES, values: d }, summary: summary(d), trades: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      BTC_BUY_HOLD: { equity: { dates: DATES, values: btc }, summary: summary(btc) },
      CASH: { summary: cash },
      IS: { D: { summary: summary(d) }, BTC_BUY_HOLD: { summary: summary(btc) }, CASH: { summary: cash } },
    },
    stats: {
      rows: [
        row('IS', 'BASE', 'PRODUCTION', { n: 40, excluded_funding_missing: 1, excluded_share: 0.024 }),
        row('OOS', 'BASE', 'PRODUCTION'), row('OOS', 'BASE', 'PLUS_60MIN', { mean_R: 0.15 }), row('OOS', 'FEES_X2', 'PRODUCTION', { mean_R: 0.17 }),
      ],
      g_vs_btc: { OOS: { g_D: 0.2, g_BTC: 0.18, diff: 0.02, ci: [-0.4, 0.5] } },
    },
    stress: {
      rows: [
        { scenario: 'BASELINE', label: '当前 D 参照', max_loss_usd: 100, longest_underwater_sessions: 30, recovered: false, end_capital: 1500, n: 120, mean_R: 0.2, simulated: false },
        { scenario: 'FEES_X2', label: '手续费 ×2', max_loss_usd: 120.456, longest_underwater_sessions: 40, recovered: false, end_capital: 1400, n: 120, mean_R: 0.17, simulated: false },
        { scenario: 'SCAN_PHASE_PLUS_60MIN', label: '晚一小时成交（h+2 开盘）', max_loss_usd: 130.125, longest_underwater_sessions: 41, recovered: false, end_capital: 1300, n: 119, mean_R: 0.15, simulated: false },
        { scenario: 'EXIT_GRANULARITY_1M', label: '出场粒度 1m 对 1h', status: 'MISSING_SCENARIO', missing: true, simulated: false, missing_reason: '缺场景：合成夹具没有 1m 缓存' },
        { scenario: 'HALT_HONORED', label: '第一次停止即停：与当前 D 参照相同', status: 'SAME_AS_BASELINE', end_capital: 1500, simulated: false },
        { scenario: 'RISK_OPEN_CAP_100', label: '风控维度：总上限 50 → 100（只报不判）', max_loss_usd: 100, longest_underwater_sessions: 30, recovered: false, end_capital: 1500, n: 120, mean_R: 0.2, simulated: false },
        { scenario: 'RISK_MARGIN_15', label: '风控维度：保证金 10 → 15（只报不判）', max_loss_usd: 900, longest_underwater_sessions: 30, recovered: false, end_capital: 2000, n: 120, mean_R: 0.2, simulated: false },
        { scenario: 'RISK_NO_BOOK_STOP', label: '风控维度：去掉账本止损，与当前 D 参照相同', status: 'SAME_AS_BASELINE', end_capital: 1500, simulated: false },
      ],
    },
    half_kelly: {
      p: 0.35, p_ci: [0.25, 0.45], b: 2.4, b_ci: [2.3, 2.5], f_star: -0.06, f_half: 0, floor_usd: 600,
      replay: {
        half_kelly: { end_capital_ci: [1000, 1000], p_below_floor: 0, p_below_book_stop_750: 0, max_drawdown: 0, note: '半凯利 = 0：不支持按凯利加仓' },
        fixed_7_2: { end_capital_ci: [200, 4000], p_below_floor: 0.3, p_below_book_stop_750: 0.45, max_drawdown: 0.2, note: '固定每笔 7.2 USDT 风险（现行）' },
      },
    },
    formula_table: { kind: 'FORMULA_NOT_BACKTEST', risk_fraction: 0.0072, cells: [{ win_rate: 0.3, payoff: 2, expected_R: -0.1, expected_growth: -0.001 }] },
    verdict: {
      class: 'BASELINE_EVALUATION_V1', state: 'INSUFFICIENT', comparators: ['BTC_BUY_HOLD', 'CASH'], ci_method: 'MONTHLY_BLOCK_BOOTSTRAP_95',
      delta_R: 0.1, delta_g: 0, L_R: -0.1, U_R: 0.5, L_g: -0.4, U_g: 0.5, n_trades: 120, reason_codes: ['CI_STRADDLES_DELTA'], label_zh: '当前 D',
      engine_approximation: { flag: false, approximations: ['QS-E1'] },
    },
    halt_events: { OOS: [], IS: [] },
    diagnosis_items: [{ id: 'QS-D1', source: 'ENTRY_EXIT', facts_zh: ['合成夹具：止损占多数'], proposed_experiment: null, no_topic_reason: '合成夹具，不立题' }],
    forward: { in_verdict: false, ledger: 'QUICK_SHOT_V3_1000USDT', trades: 4, net_usdt: -12.345, mean_R: -0.43 },
    reproducibility: { command: 'node qs-q0.js core --fixture', runs: [{ sha256: hex('run') }, { sha256: hex('run') }], identical: true },
  };
  return patch(doc) || doc;
}

/** 在临时目录 qs-q0-import-fixture-XXXX 下写 RESULT.json 及旁边的 .sha256；返回路径。 */
function write(doc = result()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-q0-import-fixture-'));
  const file = path.join(dir, 'RESULT.json');
  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.sha256`, `${crypto.createHash('sha256').update(bytes).digest('hex')}  RESULT.json\n`);
  return file;
}

const fileSha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

module.exports = { result, write, hex, fileSha };
