'use strict';
/**
 * 合成的 C17_V2_M2_Q0_RESULT_V1（CRYPTO_Q0_RESULT_V1 增补 1 §7.7 的负例夹具）：从 QS 夹具改成 C17 文件的形状——
 * 系列项只有 derived_sha256 / minute_sha256、inputs.manifests、identity.engine_sha256、A0 未通过（带原因与残差）、近似引擎标签、
 * NOT_IMPLEMENTED 规则、uncapped_state、没有普查、max_loss_usdt、simulated:false 的补充行、非主流近似臂、对象形的停止事件、
 * 前向的已平／未平与子行、current_rule 固定臂。数字是合成的，没有经济含义；CI 不读真实文件。
 */
const qs = require('./_qs_q0_fixture');

const { hex } = qs;
const LABEL = '研究引擎近似的当前 D（缺：60 秒成交观测、扫描时刻成交价）';

function result(patch = (doc) => doc) {
  const doc = qs.result((base) => {
    base.identity.schema = 'C17_V2_M2_Q0_RESULT_V1';
    base.identity.strategy_ref = 'C17_V2_4000USDT';
    base.identity.config = { capital_usdt: 3000, base_risk_usdt: 150.75, resamples: 10000 };
    base.identity.engine_sha256 = { production: hex('production-engine'), research: hex('research-engine'), research_branch: 'research/fixture (NEVER MERGE)' };
    base.identity.inertness_ref = 'FIXTURE_INERTNESS.json sha256 fixture';
    delete base.identity.supersedes;
    delete base.identity.change_note_zh;
    base.inputs.series = ['BTCUSDT', 'ETHUSDT'].map((symbol) => ({
      symbol, role: 'traded', source_host: 'fixture', source_ref: `fixture/${symbol}`,
      derived_sha256: { a: hex(`${symbol}-derived`) }, minute_sha256: { a: hex(`${symbol}-minute`) },
    }));
    base.inputs.manifests = { 'fixture/manifest.json': hex('manifest') };
    delete base.inputs.census;
    base.gates.A0 = { state: 'FAILED', ref: 'FIXTURE_A0.json', diagnostic_zh: '合成夹具：出场观测不一致', residuals_missing_zh: ['60 秒成交观测', '扫描时刻成交价'] };
    base.gates.INERTNESS = { state: 'PASSED', ref: 'FIXTURE_INERTNESS.json' };
    base.gates.rules = [
      { rule: 'C17-U2', status: 'NOT_IMPLEMENTED', code_ref: 'policy.js:1', note_zh: '主臂只交易 BTC / ETH' },
      { rule: 'C17-E1', status: 'APPROXIMATED', code_ref: 'worker.js:2', note_zh: '合成近似：每 10 分钟扫描的差另列 ENGINE_SCAN_EVERY_10MIN' },
      { rule: 'C17-R2', status: 'NOT_APPLICABLE', code_ref: 'budget.js:3', note_zh: 'A19 共享，只引用不复算' },
    ];
    Object.assign(base.verdict, {
      label_zh: LABEL, uncapped_state: 'INSUFFICIENT', mean_R: 0.098, reason_codes: ['CI_STRADDLES_DELTA', 'ENGINE_APPROXIMATION_A0_FAILED_F3'],
      engine_approximation: { flag: true, missing: ['C17-U2'], approximations: ['C17-E1'], a0_residuals_zh: ['60 秒成交观测', '扫描时刻成交价'] },
    });
    base.stats.rows.forEach((row) => { if (row.segment === 'OOS' && row.cost === 'BASE' && row.phase === 'PRODUCTION') row.mean_R = 0.098; });
    const money = (row) => { if (row.max_loss_usd !== undefined) { row.max_loss_usdt = row.max_loss_usd; delete row.max_loss_usd; } return row; };
    base.stress.rows = base.stress.rows.map(money).map((row) => ({ ...row, ...(row.max_loss_usdt !== undefined ? { max_drawdown: 0.3, circuit_trips: 7 } : {}) }));
    const supplementary = (scenario, extra) => ({ scenario, label: scenario, max_loss_usdt: 50, max_drawdown: 0.2, circuit_trips: 1, longest_underwater_sessions: 5, recovered: false, n: 10,
      mean_R: 0.05, status: 'SUPPLEMENTARY_NOT_IN_CONCLUSION', in_headline: false, ...extra });
    base.stress.rows.push(
      supplementary('BOUNDARY_K5_OFF', { simulated: false, kind: 'RULE_BOUNDARY', max_loss_usdt: 9999, end_capital: 1400 }),
      supplementary('ENGINE_SCAN_EVERY_10MIN', { simulated: false, kind: 'APPROXIMATION_SIZE', end_capital: 2600, n: 130, mean_R: 0.12345 }),
      supplementary('NON_MAJOR_APPROXIMATION_ARM', { simulated: true, end_capital: 1100 }),
      supplementary('NON_MAJOR_ARM_MAJORS_ONLY_SAME_WINDOW', { simulated: true, end_capital: 1050 }),
    );
    const armRow = (end, extra) => ({ n: 40, mean_R: 0.01, mean_R_ci: [-0.07, 0.09], win_rate: 0.495, end_capital: end, max_drawdown: 0.418, ...extra });
    base.non_major_arm = {
      status: 'SUPPLEMENTARY_NOT_IN_CONCLUSION', simulated: true, in_headline: false, window: { start: '2024-10-04', end: '2026-09-30' },
      universe: { kind: 'FIXTURE_PROXY', symbols: ['AAAUSDT', 'BBBUSDT'] }, dataset_used: [], trades: [],
      with_non_majors: armRow(1100, { non_major_trades: 20, non_major_mean_R: -0.0114 }), majors_only_same_window: armRow(1050, { non_major_trades: 0, non_major_mean_R: null }),
      approximations_zh: ['合成夹具：代理标的池'],
    };
    base.halt_events = {
      OOS: { events: [], stop_weeks: 0, rule_1b: 'NOT_EVALUABLE_SHARED_OVERSEAS_BUCKET' },
      IS: { events: [{ rule: 'RULE_1_DRAWDOWN_AT_STOP_LINE', at: '2022-05-09T00:00:00.000Z', period_to: '2022-05-08', drawdown_pct: 50.08889093, closed: 395, expectancy_R: -0.0019, expectancy_t: -0.03 }],
        stop_weeks: 34, rule_1b: 'NOT_EVALUABLE_SHARED_OVERSEAS_BUCKET' },
    };
    base.half_kelly.floor_usd = 1800;
    base.half_kelly.replay = {
      half_kelly: { end_capital_ci: [3000, 3000], p_below_floor: 0, max_drawdown: 0, note: '半凯利 = 0：不支持按凯利加仓' },
      current_rule: { end_capital_ci: [2075.95, 23589.02], p_below_floor: 0.0695, max_drawdown: 0.359, note: '合成夹具：现行定仓' },
    };
    base.forward = {
      in_verdict: false, ledger: 'C17_V2_4000USDT', window_from: '2026-10-07', trades: 15, closed: 13, open: 2, net_usdt: -670.5689548, mean_R: -0.51636663,
      current_d_full_from_2026_10_20: { closed: 2, net_usdt: -171.59160814, mean_R: -1.13825279 }, note_zh: '合成夹具：前向说明',
    };
    return base;
  });
  return patch(doc) || doc;
}

module.exports = { result, write: qs.write, hex, fileSha: qs.fileSha, LABEL };
