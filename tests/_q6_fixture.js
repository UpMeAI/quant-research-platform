'use strict';
/**
 * 合成的 US_V5_M2_R2_STEP2_COMBINED_V1（Q6），只用于测试 Q6 登记项和页面。形状照封存文件（smartflow
 * research/us-v5-m2-r2-step2-run @d25df862，0510c7da…）；压力行、做 / 不做与停放统计的数字照首轮报告，没有经济含义。
 * 路径带 fixture 字样，导入器默认把它当「非实际来源」拒绝，只有测试显式放行。
 *
 * 默认形状 = 第 2 步 K2 与冻结记录 ★1–★6 (a) 的样子：
 *   - 原版臂 BASELINE_T3_A25 = Q5 夹具的候选臂（同一组输入生成，逐项相同），`identity.baseline_arm_ref` 指向调用方给的 Q5 锁；
 *     候选臂 CANDIDATE_M1_ON_T3_A25 借用 Q5 夹具的原版臂数字（只为形状）；现金臂只有摘要（同封存文件）；
 *   - 优势结论 SUPPORTED（G1′ 成立，95% 区间下沿 > 0），压力有缺；oos_reuse:true；
 *   - do_or_not = DO（N1–N4 都不成立）；recommendation = null；2008 只停放 SPY 上界行；forward_spec = K2 §7 原文。
 * ctx = { q0Id, q0Sha, lock4, lock5, gap: {result_id, sha256}, q0s: {result_id, sha256} }。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fx5 = require('./_q5_fixture');
const q6 = require('../services/candidate-comparison/questions/q6');

const hex = fx5.hex;
const BASE = 'BASELINE_T3_A25';
const CAND = 'CANDIDATE_M1_ON_T3_A25';
const ROOT = path.join(__dirname, '..');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** K2 §7 原文：从仓库里的 K2 副本切出来（同研究会话运行器的 forwardSpec）。 */
function forwardSpec() {
  const text = fs.readFileSync(path.join(ROOT, q6.K2_REF), 'utf8');
  const slice = text.slice(text.indexOf('## 7. 前向影子'), text.indexOf('## 8. 结果文件与 QRP'));
  return { section: '§7', sha256: sha256(slice), text_zh: slice.trim() };
}

const cooldown = () => ({ cooldown_blocked_signals: { open_scan: 19, other: 80 },
  arms_not_set: { gate_refusal: { open_scan: 255, other: 500 }, other_no_open: { open_scan: 757, other: 1579 } } });

/** 压力格：两臂各一格；`minEq`、`dd` 进 N3。 */
const cell = (end, loss, dd, under, minEq) => ({ max_loss_usd: loss, max_drawdown: dd, longest_underwater_sessions: under, recovered: false, end_capital: end,
  simulated: false, min_equity: minEq, floor_1800_touched: minEq < 1800, rule1_50pct_touched: dd >= 0.5 });
const row = (scenario, label, base, cand) => ({ scenario, label, simulated: false, arms: { [BASE]: base, [CAND]: cand },
  diff: { max_loss_usd: cand.max_loss_usd - base.max_loss_usd, end_capital: cand.end_capital - base.end_capital,
    longest_underwater_sessions: cand.longest_underwater_sessions - base.longest_underwater_sessions }, diff_rule_zh: '候选 − 基线' });

function stressRows() {
  return [
    row('BASELINE', '当前 D 参照（生产时间表，5 bps + 监管费）', cell(4505.8844, 400.9, 0.119862, 247, 2999.66), cell(6878.8118, 1087.9, 0.219315, 168, 2980.3548)),
    row('COST_15BPS', '费用 15 bps / 边', cell(3767.2327, 650, 0.150854, 270, 2878.82), cell(5513.3106, 1087.9668, 0.236767, 220, 2977.379)),
    row('COST_SLIPPAGE_X2', '滑点 ×2', cell(4087.0, 500, 0.13, 260, 2900), cell(6028.07, 1168.69, 0.233474, 193, 2975.55)),
    row('SCAN_PHASE_PLUS_60MIN', '扫描相位 +60 分钟', cell(3265.4115, 700, 0.204685, 300, 2835.43), cell(5300.8272, 841.35, 0.195541, 272, 2977.7804)),
    row('WINDOW_2020_02_19_04_30', '区间重放 2020-02-19 → 04-30（新账本）', cell(2943.2523, 56.7477, 0.018916, 51, 2943.2523), cell(2613.2327, 997.64, 0.332547, 51, 2002.3602)),
    row('WINDOW_2022_01_03_10_31', '区间重放 2022-01-03 → 10-31（新账本）', cell(2605.2357, 394.76, 0.138356, 200, 2601.929), cell(2461.638, 731.18, 0.249178, 200, 2272.5933)),
    row('RISK_UNIT_90', '单元风险 60 → 90', cell(4400, 420, 0.13, 250, 2990), cell(6785.05, 1101.5, 0.22, 176, 2974.4)),
    { scenario: 'EXTREME_DOWNTURN_2008', label: '2008-09 → 2009-03 极端下跌（完整账本）：缺场景', status: 'MISSING_SCENARIO', missing: true, simulated: false,
      missing_reason: '两臂的完整账本都需要 2007–2009 行业 ETF 日线，按 Owner 规则不取数（同 Q5）', both_arms_zh: '两臂相同' },
    {
      scenario: 'SPY_PARK_2008_BOUND', label: '2008-09 → 2009-03「只停放 SPY」上界行（★5）：上界情景，不是本策略的回放', simulated_bound: true, simulated: true,
      in_verdict: false, window: ['2008-09-02', '2009-03-31'], source: { file: 'research/us-core-bear-stress/data/SPY.json', sha256: hex('spy-json'), column: 'close（价格，不含分红）' },
      start_capital: 3000, end_capital: 1862.9649, min_equity: 1595.6561, min_equity_day: '2009-03-09', max_drawdown: 0.468115, max_loss_usd: 1404.3439,
      longest_underwater_sessions: 146, recovered: false, below_1800: true, first_day_below_1800: '2008-11-20', rule1_50pct_touched: false, spy_price_return_pct: -37.8701,
      sessions: 146, method_zh: '假设 US_V5 全程空仓，3,000 在 2008-09-02 收盘全部买入 SPY，之后只持有；不取数',
    },
    { scenario: 'EXTREME_BEAR_2008_SPY_QQQ_SYNTH_SUPPLEMENT', label: '2008 SPY / QQQ 合成补充：缺场景', status: 'MISSING_SCENARIO', missing: true, simulated: false,
      missing_reason: '补充行是独立的日线简化循环，取不到 T3 需要的 dailyRead（同 Q5）', both_arms_zh: '两臂相同' },
  ];
}

const N3_SCENARIOS = ['BASELINE', 'IS_2020_01_02_2022_12_30', 'WINDOW_2022_01_03_10_31', 'WINDOW_2020_02_19_04_30', 'COST_15BPS', 'SCAN_PHASE_PLUS_60MIN'];

/** 按文件自己的数写 N1–N4 与做 / 不做（同研究会话运行器的 §6.1 顺序）；测试改了数之后再调一次让它自洽。 */
function decide(doc) {
  const v = doc.verdict;
  const c = doc.comparison;
  const rowOf = (scenario) => doc.stress.rows.find((item) => item.scenario === scenario);
  const n3rows = N3_SCENARIOS.map((scenario) => {
    const arm = scenario === 'IS_2020_01_02_2022_12_30' ? doc.stress.is_rows[CAND] : rowOf(scenario).arms[CAND];
    const below = arm.min_equity < 1800; const rule1 = arm.max_drawdown >= 0.5;
    return { scenario, min_equity: arm.min_equity, max_drawdown: arm.max_drawdown, below_1800: below, rule1_50pct: rule1, triggered: below || rule1 };
  });
  const c15 = rowOf('COST_15BPS').arms; const ph = rowOf('SCAN_PHASE_PLUS_60MIN').arms;
  const checks = [
    { id: 'N1', rule_zh: 'OOS 主比较 U_g ≤ 0（G1′ 成立时）', triggered: c.criteria.G1_prime.met && v.U_g <= 0, facts_zh: `配对 g ${c.g_vs_baseline.value}` },
    { id: 'N2', rule_zh: 'IS 配对 g 点估计 ≤ 0（★3）', triggered: c.is.paired_g.g <= 0, facts_zh: `IS 配对 g ${c.is.paired_g.g}` },
    { id: 'N3', rule_zh: '任一真实历史行里候选日标记权益 < 1,800，或自起点峰值回撤 ≥ 50%（★3）', triggered: n3rows.some((item) => item.triggered), rows: n3rows,
      facts_zh: n3rows.map((item) => `${item.scenario}：最低 ${item.min_equity}`).join('；') },
    { id: 'N4', rule_zh: 'COST_15BPS 或 SCAN_PHASE_PLUS_60MIN 行里候选期末 < 基线期末（★3）',
      triggered: c15[CAND].end_capital < c15[BASE].end_capital || ph[CAND].end_capital < ph[BASE].end_capital, facts_zh: `15 bps：候选 ${c15[CAND].end_capital} 对基线 ${c15[BASE].end_capital}` },
  ];
  const triggered = checks.filter((item) => item.triggered).map((item) => item.id);
  const decision = triggered.length ? 'NOT_DO' : (v.L_g > 0 ? 'DO' : 'DO_PAPER_SHADOW');
  const shadow = '只用于前向影子账本 US_V5_M1_SHADOW（§7）与 RECOMMENDATION；不是生产采用（M-1 进生产属第 1 类修订，需 Owner 签字）';
  v.do_or_not = {
    decision, decision_zh: { NOT_DO: '不做', DO: '做', DO_PAPER_SHADOW: '做（纸面 / 影子）' }[decision], triggered,
    strength_zh: { NOT_DO: `触发 ${triggered.join('、')}`, DO: '有支持证据（受选择影响：OOS 已用于选块；收回率 76.7132%）', DO_PAPER_SHADOW: '证据不足（受选择影响；收回率 76.7132%）' }[decision],
    allowed_use_zh: { NOT_DO: '无；现行规则不变；结果进总表与第二轮总结', DO: shadow, DO_PAPER_SHADOW: shadow }[decision],
    order_zh: '先判运行门；任一 N1–N4 成立 → 不做；否则 L_g > 0 → 做；否则 → 做（纸面 / 影子）', checks,
  };
  return doc;
}

/** §6.3 的核对（只在「做（纸面 / 影子）」时有）：第 1–4 项写是 / 否，第 5、6 项只列出。 */
const recommendation = () => ({
  rule_ref: 'K2 §6.3', record_kind: 'RECOMMENDATION',
  checks: [
    { id: 1, item_zh: 'OOS 配对 g 点估计 > 0', yes: true, facts_zh: '配对 g 0.05' },
    { id: 2, item_zh: '收回率 ≥ 50%', yes: true, facts_zh: '收回率 60%' },
    { id: 3, item_zh: '成本与相位稳健（N4 不成立）', yes: true, facts_zh: '两行候选期末都高于基线' },
    { id: 4, item_zh: '机制成立：M1_FLAT_SPY_IDENTITY 通过', yes: true, facts_zh: '通过' },
    { id: 5, list_only: true, item_zh: '只列出：反过来的约定下块组 z 1.73', facts_zh: 'z 1.73' },
    { id: 6, list_only: true, item_zh: '只列出：2008 上界行是否低于 1,800', yes: true, facts_zh: '最低权益 1595.66' },
  ],
  market_analysis_zh: ['现金拖累与「现金指数化」。', '样本为什么短。', '纸面执行的成本。'],
  recommendation_zh: '证据不足 → 做（纸面 / 影子）：只开带标注的前向影子账本 US_V5_M1_SHADOW（§7），不是生产采用', decided_by: 'OWNER',
});

function result(ctx, overrides = null) {
  const q5 = fx5.result(ctx.q0Doc, ctx.q0Sha, ctx.q0Id, ctx.lock4);
  const doc = JSON.parse(JSON.stringify(q5));
  const ref = { result_id: ctx.lock5.result_id, arm: 'CANDIDATE_T3_ON_A25', sha256: ctx.lock5.file_sha256 };
  const cited = { GAP: ctx.gap, Q0S: ctx.q0s, Q4: { result_id: ctx.lock4.result_id, sha256: ctx.lock4.file_sha256 } };
  doc.identity = {
    ...doc.identity, schema: 'US_V5_M2_R2_STEP2_COMBINED_V1', result_kind: 'CHALLENGER_VS_BASELINE', question_no: 'Q6',
    baseline_result_id: ctx.q0Id, baseline_arm_ref: ref, cited_results: cited,
    k2: { file: 'trading-system-v2/docs/US_V5_M2_R2_STEP2_COMBINED_K2_DRAFT_V1.md', sha256: q6.K2_SHA256, smartflow: 'research/us-v5-m2-r2-step2-k2 @b9b92e19',
      freeze: { file: q6.FREEZE.file, item: q6.FREEZE.item, readings_zh: '★1–★6 全部按推荐' } },
    k2_step1: { expect: q6.STEP1.k2, now: q6.STEP1.k2 }, erratum_step1: { expect: q6.STEP1.erratum, now: q6.STEP1.erratum },
    smartflow_commit: 'a85b2e0267d67787538b27b666fb8a2bfab7df16', node: 'v18.20.8',
    engine_files: { 'scripts/research/replay-us-v5-universe-comparison.js': hex('q6-engine'), 'scripts/research/us-v5-m2-r2s2-park.js': hex('park') },
    criteria_set: ['G1_prime', 'P_G', 'F3'], delta_g: 0,
  };
  delete doc.identity.k2_sha256;
  doc.power_first = { mde80: 0.1491, mde50: 0.1044, se_step1: 0.053241, ceiling_g: 0.14537, ceiling_over_mde80: 0.975,
    expected_zh: '运行前写明：天花板 0.145 /年 < MDE80 0.149 /年，「证据不足 → 做（纸面 / 影子）」是预期结果',
    realized: { paired_g: 0.111518, se_boot: 0.054952, z: 2.0294, mde80_realized: 0.153867, forward_years_for_80pct_at_ceiling: 3.987 } };
  const sealed = (input, sha) => ({ input, expect: sha, now: sha, equal: true });
  doc.inputs = {
    sealed: [sealed('Q0', ctx.q0Sha), sealed('Q4', ctx.lock4.file_sha256), sealed('Q5', ctx.lock5.file_sha256), sealed('GAP', ctx.gap.sha256),
      sealed('Q0S', ctx.q0s.sha256), sealed('IS_LEDGER', hex('is-ledger')), sealed('ATTEST', hex('attest'))],
    manifest: { file: 'INPUTS_MANIFEST_A1.json', sha256: hex('manifest') },
    signals: { 'SCAN_MAIN_NOCD-SPY.json': hex('sig-spy'), 'SCAN_MAIN_NOCD-XLK.json': hex('sig-xlk') },
    signals_q4: { 'SCAN_PHASE_NOCD-SPY.json': hex('sig4-spy') },
    floor_attestation: { file: 'FLOOR_ATTESTATION_Q0S.json', sha256: hex('attest') },
    spy_json: { file: 'research/us-core-bear-stress/data/SPY.json', sha256: hex('spy-json') },
  };
  doc.gates = Object.fromEntries(q6.Q6.run_gates.map((name) => [name, { pass: true, state: 'PASSED' }]));
  doc.gates.INPUTS.sealed = doc.inputs.sealed;
  doc.arms = {
    window: { from: '2023-01-03', to: '2026-10-23' },
    [BASE]: { ...q5.arms.CANDIDATE_T3_ON_A25, label_zh: '原版：当前 D = D+A25+T3', baseline_arm_ref: ref },
    [CAND]: { ...q5.arms.BASELINE_A25, label_zh: '候选：D+A25+T3+M-1' },
    SPY_BUY_HOLD: q5.arms.SPY_BUY_HOLD,
    CASH: { reference: true, summary: q5.arms.CASH.summary },
  };
  delete doc.arms[BASE].deferred_sessions; delete doc.arms[BASE].deferred_trades;
  doc.stress = { rows: stressRows(), is_rows: {
    [BASE]: { scenario: 'IS_2020_01_02_2022_12_30', min_equity: 2962.1419, max_drawdown: 0.16325, end_capital: 3157.6214 },
    [CAND]: { scenario: 'IS_2020_01_02_2022_12_30', min_equity: 2060.0794, max_drawdown: 0.342288, end_capital: 3404.5294 },
  } };
  const exposure = { avg_notional_usd: 1909.59, time_in_market_ratio: 0.562762, notional_cap_rejections: 148, notional_cap_reductions: 71, avg_actual_risk_usd: 36.09, ...cooldown() };
  doc.comparison = {
    question_zh: '当前 D（D+A25+T3）只改一处——不用于持仓的现金停放到 SPY（M-1）——完整 3,000 账户的对数增长是否更好？',
    candidate_label_zh: '候选 D+A25+T3+M-1', baseline_result_id: ctx.q0Id, baseline_arm_ref: ref, candidate_arm: CAND,
    g_vs_baseline: { value: 0.111518, ci_95: [0.004875, 0.217746] },
    paired_g: { g: 0.111518, ci95: [0.004875, 0.217746], se_boot: 0.054952, z: 2.0294, sessions: 956, months: 46 },
    is: { paired_g: { g: 0.025096, ci95: [-0.190966, 0.229292] }, reuse: 'IS_USED_AS_SIGN_FILTER' },
    criteria: {
      G1_prime: { met: true, baseline_oos_trades: 122, candidate_oos_trades: 122, candidate_sessions_holding_spy: 956 },
      P_G: { met: true, L_g: 0.004875 }, F3: { triggered: false, U_g: 0.217746 },
    },
    vs_spy: { [CAND]: { g: 0.025351, ci_95: [-0.06, 0.11] }, [BASE]: { g: -0.086168, ci_95: [-0.226, 0.056] } },
    recovery: { ceiling_g: 0.14537, paired_g: 0.111518, recovery_ratio: 0.767132, recovery_pct: 76.7132,
      deductions: { total: 0.033852, dividends_g: 0.010482, spy_fees_g: 0.011918, waiting_cash_g_approx: -0.004958, rest_g: 0.01641 } },
    parking: { oos: { mean_parked_share: 0.757125, spy_fills: 229, spy_buys: 112, spy_sells: 117, spy_fees_usd: 213.878844, sessions_holding_spy: 956, sessions: 956,
      max_spy_notional_usd: 7171.7766, mean_spy_notional_usd: 3736.6165, entries_funded_by_spy_sale: 117, cash_short_inherited_from_d_instants: 0 } },
    exposure: {
      [BASE]: { ...exposure },
      [CAND]: { ...exposure, avg_notional_usd: 1913.62, spy_mean_notional_usd: 3736.6165, spy_max_notional_usd: 7171.7766, mean_parked_share: 0.757125 },
    },
    changed_vs_baseline: { entries: 0, exits: 0, total: 0 },
  };
  doc.verdict = {
    class: 'CANDIDATE_COMPARISON_V1', state: 'SUPPORTED', rule: 'P_G', label_zh: '有支持证据：完整账户的对数增长更好（受选择影响）',
    reason_codes: ['OOS_REUSED_FOR_SELECTION', 'STRESS_SCENARIO_MISSING'], baseline_result_id: ctx.q0Id, baseline_arm_ref: ref, candidate_arm: CAND,
    primary: 'PAIRED_G', g_vs_baseline: 0.111518, L_g: 0.004875, U_g: 0.217746, ci_level: 0.95, delta_g: 0, multiplicity_zh: '单一比较，不做多重比较校正',
  };
  doc.oos_reuse = true;
  doc.oos_reuse_detail = { reason_code: 'OOS_REUSED_FOR_SELECTION', reused_window: ['2023-01-03', '2026-10-23'], is_reuse: 'IS_USED_AS_SIGN_FILTER',
    window_2020_oos_reuse: false, reason_zh: '第 1 步在同一段 OOS 上准入 M-1；本题在 OOS 上的配对 g 几乎是同义反复' };
  doc.reference_rows = [
    { key: 'REF_D', label_zh: '原版 D（Q0 的 D 臂）', source_result_id: ctx.q0Id, end_capital: 3417.9316, max_drawdown: 0.191206,
      g_vs_spy: { g: -0.159013, ci_95: [-0.307223, -0.009591] }, g_vs_baseline: { value: -0.072845, ci_95: [-0.178204, 0.022265] },
      changed_vs_baseline: { entries: 81, exits: 17, total: 98 }, in_verdict: false },
    { key: 'REF_D_A25', label_zh: 'D+A25（Q4 候选臂 = Q5 基线臂）', source_result_id: ctx.lock4.result_id, end_capital: 4038.1435, max_drawdown: 0.136303,
      g_vs_spy: { g: -0.115058, ci_95: [-0.253465, 0.026872] }, g_vs_baseline: { value: -0.02889, ci_95: [-0.092547, 0.03777] },
      changed_vs_baseline: { entries: 19, exits: 25, total: 44 }, in_verdict: false },
    { key: 'CANDIDATE_VS_REF_D', label_zh: '候选对原版 D：A25 + T3 + M-1 合起来', end_capital: 6878.8118, reference_end_capital: 3417.9316,
      g_vs_reference: { value: 0.184363, ci_95: [0.03661, 0.332485] }, in_verdict: false },
  ];
  doc.recommendation = null;
  doc.forward_spec = forwardSpec();
  doc.production_note_zh = '「做」只触发带标注的前向影子账本 US_V5_M1_SHADOW；M-1 进生产属第 1 类修订，需 Owner 签字';
  doc.disclosures_zh = ['卫星账本空闲时持有指数 beta，与 US_LONGTERM、US_CORE 的指数敞口叠加', 'M-1 规则 6 让 SPY 不受 US_V5 任何风控约束'];
  delete doc.forward; delete doc.diagnosis_items;
  doc.reproducibility = { command: 'node scripts/research/us-v5-m2-r2-step2.js …', runs: [{ sha256: hex('q6-run') }, { sha256: hex('q6-run') }], identical: true };
  decide(doc);
  if (typeof overrides === 'function') overrides(doc);
  return doc;
}

module.exports = { result, decide, recommendation, write: fx5.write, hex, BASE, CAND, N3_SCENARIOS };
