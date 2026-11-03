'use strict';
/**
 * 合成的 US_V5 M2 第二轮两类描述记录，只用于测试导入器与页面（Q0 导入规格增补 1）：
 *   - US_V5_M2_R2_GAP_DECOMPOSITION_V1（差距分解，记录类型 GAP_DECOMPOSITION_V1）；
 *   - US_V5_M2_Q0_STRESS_SUPPLEMENT_V1（Q0 压力补充，记录类型 BASELINE_STRESS_SUPPLEMENT_V1）。
 * 形状照封存文件（smartflow research/us-v5-m2-r2-run @74cf5ca1）；数字照首轮报告，没有经济含义。
 * 路径带 fixture 字样，导入器默认把它当「非实际来源」拒绝，只有测试显式放行。
 *
 * Q1–Q5 的锁直接写进临时账本（与 m2_round_import.test.js 的基线锁同一做法）：每一题一份最小的封存文件
 * （identity + arms，带 .sha256），锁行只带导入器要读的字段。Q0 锁走真实导入（tests/_q0_fixture.js 加两行压力行）。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fx0 = require('./_q0_fixture');
const gap = require('../services/gap-decomposition');
const supplement = require('../services/baseline-stress-supplement');

const hex = fx0.hex;
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const ROW_2020 = Object.freeze({
  scenario: 'WINDOW_2020_02_19_04_30', label: '区间重放 2020-02-19 → 04-30（新账本）', max_loss_usd: null, max_drawdown: null,
  longest_underwater_sessions: null, recovered: null, end_capital: null, simulated: false, window: ['2020-02-19', '2020-04-30'], n: 0,
  mean_R: null, mean_R_ci: [null, null], g_vs_spy: 0.703544, g_vs_spy_ci: [-1.434535, 4.049133], status: 'INVALID_INPUT', missing: true,
  missing_reason: '无效输入：封存缓存从 2019-06-03 起，地板要信号序列 250 根日线，2020-05-29 前没有可交易载体，区间重放 0 笔（AC8 记为缺场景）',
});
const ROW_2008 = Object.freeze({
  scenario: 'EXTREME_DOWNTURN_2008', label: '2008-09 → 2009-03 极端下跌：缺场景', status: 'MISSING_SCENARIO', missing: true, simulated: false,
  missing_reason: '3× 载体当时还没上市', max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: null,
});

/** Q0 夹具：把区间重放 2020 换成真实 Q0 的「无效输入」行，再加 2008 缺场景行。 */
function q0Doc() {
  return fx0.result((doc) => {
    doc.stress.rows = doc.stress.rows.filter((row) => row.scenario !== 'REPLAY_2020_02_19_2020_04_30' && row.scenario !== 'EXTREME_BEAR_2008');
    doc.stress.rows.splice(1, 0, clone(ROW_2020));
    doc.stress.rows.push(clone(ROW_2008));
    return doc;
  });
}

/** 在临时目录 r2-records-fixture-XXXX 下写 <name> 及旁边的 .sha256；返回路径。 */
function write(doc, name = 'RESULT.json', { tamperSidecar = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-records-fixture-'));
  const file = path.join(dir, name);
  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.sha256`, `${tamperSidecar ? hex('wrong') : sha256(bytes)}  ${name}\n`);
  return file;
}

/**
 * Q1–Q5 的锁：每题一份最小封存文件，锁行直接追加进候选对比账本。`arms` 给 Q5 的 CANDIDATE_T3_ON_A25 一个摘要（期末 4,505.8844）。
 * 返回 { Q1: {result_id, sha256, file}, … }。
 */
function seedComparisons(cc, { caseRef, strategyRef, baselineResultId, endCapital = 4505.8844, questions = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'], salt = '' } = {}) {
  const out = {};
  for (const question of questions) {
    const doc = {
      identity: { schema: `US_V5_M2_${question}_RESULT_V1`, salt: `${question}${salt}` },
      arms: question === 'Q5'
        ? { CANDIDATE_T3_ON_A25: { summary: { end_capital: endCapital, cagr: 0.113184, max_drawdown: 0.119862, longest_underwater_sessions: 247, recovered: false } } }
        : { D: { summary: { end_capital: 3417.93 } } },
    };
    const file = write(doc, `US_V5_M2_${question}_RESULT_V1.json`);
    const fileSha = sha256(fs.readFileSync(file));
    const row = {
      schema: 'COMPARISON_EVALUATION_LOCK_V1', result_id: `${question}-${fileSha.slice(0, 16)}`, case_ref: caseRef, strategy_ref: strategyRef,
      question_ref: question, baseline_result_id: baselineResultId, file_ref: fs.realpathSync(file), file_sha256: fileSha,
    };
    fs.mkdirSync(path.dirname(cc.LEDGER()), { recursive: true });
    fs.appendFileSync(cc.LEDGER(), `${JSON.stringify(row)}\n`);
    out[question] = { result_id: row.result_id, sha256: fileSha, file: row.file_ref };
  }
  return out;
}

const gate = (extra = {}) => ({ ...extra, pass: true, state: 'PASSED' });
const power = (g, se, z, cls, mde80) => ({ g, se, z, mde80, mde50: Math.round(mde80 / 2.8 * 1.96 * 1e6) / 1e6, class: cls,
  class_zh: { BORDERLINE: '边界（1.96–2.80）', DETECTABLE_80: '80% 功效可检测', NOT_DETECTABLE: '不可检测' }[cls] });
const rank = (rank_, block, log, usd, g, share, pw, isG, same, name) => ({
  rank: rank_, block, log, usd, g, share_of_gap: share, ...(pw ? { power: pw } : {}), name_zh: name, is_g: isG, is_same_sign: same, kind_zh: '—', levers: [],
});

/**
 * 差距分解。ctx = { q0Id, q0Sha, cited }（cited 来自 seedComparisons）。overrides 是函数时在默认形状上改。
 * 默认形状 = 首轮报告：当前 D 对 SPY 年化 g 0.0862；A1+A2 g 0.1454、SE 0.0532、z 2.73 → 按 1.96 准入（候选 D+A25+T3+M-1），按 2.80 不准入；
 * 反过来的约定 z 1.73（敏感性，不参与准入）。
 */
function gapDoc(ctx, overrides = null) {
  const q5 = ctx.cited.Q5;
  const doc = {
    identity: {
      schema: 'US_V5_M2_R2_GAP_DECOMPOSITION_V1', result_kind: 'DESCRIPTIVE_DECOMPOSITION', record_type: 'GAP_DECOMPOSITION_V1',
      baseline_result_id: ctx.q0Id,
      base_arm_ref: { result_id: q5.result_id, arm: 'CANDIDATE_T3_ON_A25', sha256: q5.sha256 },
      cited_results: Object.fromEntries(Object.entries(ctx.cited).map(([key, item]) => [key, { result_id: item.result_id, sha256: item.sha256 }])),
      current_d_zh: '当前 D = D+A25+T3（★7 (a)）',
      k2: { file: 'trading-system-v2/docs/US_V5_M2_R2_GAP_DECOMPOSITION_K2_V1.md', sha256: gap.ENTRY.k2.sha256, smartflow: 'research/us-v5-m2-r2-k2-final @056e5b9d',
        freeze: { file: 'artifacts/coordinator/US_V5_M2_R2_K2_FREEZE_1.md', sha256: gap.ENTRY.freeze.sha256 } },
      erratum: { file: 'trading-system-v2/docs/US_V5_M2_R2_GAP_DECOMPOSITION_K2_V1_ERRATUM_1.md', sha256: gap.ENTRY.erratum.sha256 },
      smartflow_commit: '61b7284e3f71decd5a95b4fcb865ae53fb31a1a5', node: 'v18.20.8',
      engine_files: { 'scripts/research/us-v5-m2-q5.js': hex('q5-engine') },
      readings: { '★1': '(a′)', '★6': '(a)', '★9': '(a)' },
      command: 'node scripts/research/us-v5-m2-r2-gap.js …',
    },
    oos_reuse: true,
    oos_reuse_detail: { reason_code: 'OOS_REUSED_FOR_SELECTION', reused_window: ['2023-01-03', '2026-10-23'], reason_zh: 'OOS 已被 Q0–Q5 读过整段；本题的输出用于给第 2 步选块，不是新鲜样本外' },
    gates: {
      ...Object.fromEntries(gap.ENTRY.run_gates.map((name) => [name, gate()])),
      INPUTS: gate({ sealed: [{ result: 'Q0', result_id: ctx.q0Id, expect: ctx.q0Sha, now: ctx.q0Sha, equal: true },
        ...Object.entries(ctx.cited).map(([key, item]) => ({ result: key, result_id: item.result_id, expect: item.sha256, now: item.sha256, equal: true }))] }),
    },
    window: {
      oos: { from: '2023-01-03', to: '2026-10-23', sessions: 956, intervals: 956, start_day: '2022-12-30', k2_intervals: 955 },
      is: { from: '2020-01-02', to: '2022-12-30', sessions: 756, intervals: 756, start_day: '2019-12-31' },
    },
    decomposition: {
      SPY: {
        intervals: 956, annualization: '252 / 956', sessions: 956, x_bar: 0.365689, end_benchmark: 6248.0811, end_current_d: 4505.8844,
        total: { log: 0.32689, usd: 1742.1967, g: 0.086168, power: power(0.086168, 0.071943, 1.1977, 'NOT_DETECTABLE', 0.201439) },
      },
    },
    ranking: {
      table: 'OOS 对 SPY，对数口径，从大到小',
      rows: [
        rank(1, 'A1', 0.393792, 1540.8775, 0.103803, 1.2047, power(0.103803, 0.048046, 2.1605, 'BORDERLINE', 0.134529), 0.032132, true, '空仓日：一笔都不持有的 session 上基准的收益'),
        rank(2, 'A2', 0.157692, 573.9417, 0.041567, 0.4824, power(0.041567, 0.020487, 2.0289, 'BORDERLINE', 0.057365), 0.019364, true, '在场日未投入'),
        rank(3, 'C', 0.065783, 243.1771, 0.01734, 0.2012, power(0.01734, 0.001684, 10.2951, 'DETECTABLE_80', 0.004716), 0.012083, true, '费用：滑点 5 bps / 边、监管费'),
        rank(4, 'P', 0.000438, -36.4992, 0.000115, 0.0013, power(0.000115, 0.017824, 0.0065, 'NOT_DETECTABLE', 0.049909), -0.042517, false, '载体路径'),
        rank(5, 'START_FEE', -0.0005, -1.5, -0.000132, -0.0015, null, -0.000167, null, '基准起点费用'),
        rank(6, 'A3', -0.107561, -408.2313, -0.028353, -0.329, power(-0.028353, 0.016654, 1.7024, 'NOT_DETECTABLE', 0.046632), 0.013134, false, '杠杆'),
        rank(7, 'S', -0.182753, -629.6043, -0.048173, -0.5591, power(-0.048173, 0.047875, 1.0062, 'NOT_DETECTABLE', 0.13405), 0.022218, false, '选对象'),
      ],
      a_split_rows: [
        { block: 'AVG_SHORT', log: 0.460517, usd: 1769.4399, g: 0.121392, share_of_gap: 1.4088, power: power(0.121392, 0.039313, 3.0878, 'DETECTABLE_80', 0.110077), name_zh: 'A 内部切分：平均敞口不足', is_g: 0.049925, is_same_sign: true },
        { block: 'TIMING', log: -0.016595, usd: -62.852, g: -0.004374, share_of_gap: -0.0508, power: power(-0.004374, 0.027052, 0.1617, 'NOT_DETECTABLE', 0.075745), name_zh: 'A 内部切分：敞口时点', is_g: 0.014705, is_same_sign: false },
      ],
    },
    power: {
      account: { A1_A2: { se: 0.053241, ci95: [0.041072, 0.249072], months: 46 } },
      vs_spy_visibility: { se_total: 0.071943, mde80: 0.201439, mde50: 0.141007 },
      per_trade: { n: 122, sd_R: 1.9418, mde80_R: 0.4847, mde50_R: 0.3393, n_for_0_10R_80: 2867, n_for_0_10R_50: 1405 },
      optimistic_note_zh: '真实改动还会带来连锁入场，跟踪误差只会更大；这里的 MDE 是乐观的下界',
    },
    step2_admission: {
      rule_ref: 'K2 §6 第 1–7 条（★9 (a)：|g| ≥ 1.96·SE；2.80 一并报告）', table: 'OOS 对 SPY，对数口径',
      menu: { 'M-1': { name_zh: '闲置现金停放 SPY', blocks: ['A1', 'A2'], candidate: 'D+A25+T3+M-1' } },
      group: { blocks: ['A1', 'A2'], g: 0.14537, se: 0.053241, z: 2.7304, g_is: 0.051496, boot_ci95: [0.041072, 0.249072], g_annualized_955: 0.145522, z_955: 2.7333 },
      checks_1_96: { positive: true, significant: true, is_same_sign: true, admitted: true },
      checks_2_80: { positive: true, significant: false, is_same_sign: true, admitted: false },
      decision: 'CANDIDATE', candidate: 'D+A25+T3+M-1', decision_zh: '候选 = D+A25+T3+M-1', decision_2_80_zh: '按 2.80 不准入（无候选）', no_candidate_text_zh: null,
      sensitivity_reversed_convention: {
        g: 0.126206, se: 0.072943, z: 1.7302, g_is: 0.041452,
        checks_1_96: { positive: true, significant: false, is_same_sign: true, admitted: false },
        checks_2_80: { positive: true, significant: false, is_same_sign: true, admitted: false },
        note_zh: '★3 (a) 反过来的约定下同一块组（A1 + A2′）的读数；只作敏感性，不参与准入',
      },
      research_gaps: [],
    },
    reproducibility: { command: 'node scripts/research/us-v5-m2-r2-gap.js …', runs: [{ sha256: hex('gap-run') }, { sha256: hex('gap-run') }], identical: true },
  };
  if (typeof overrides === 'function') overrides(doc);
  return doc;
}

const suppRow = (end, loss, dd, underwater, n, meanR, extra = {}) => ({
  scenario: 'WINDOW_2020_02_19_04_30', label: '区间重放 2020-02-19 → 04-30（新账本）', max_loss_usd: loss, max_drawdown: dd, longest_underwater_sessions: underwater,
  recovered: false, end_capital: end, simulated: false, window: ['2020-02-19', '2020-04-30'], n, mean_R: meanR, mean_R_ci: [null, null],
  g_vs_spy: 0.55232, g_vs_spy_ci: [-1.434535, 3.085082], spy_return_pct: -13.2712, trades: [], applicability_zh: ['成交按扫描报价加 5 bps：崩盘期真实滑点更大'], ...extra,
});

/**
 * Q0 压力补充。ctx = { q0Id, q0Sha, q5Id }。默认形状 = 首轮报告：原版 D 期末 2,909.5764、最大亏损 90.4236、2 笔；
 * 当前 D 参照 2,943.2523、56.7477、2 笔；区间内 SPY −13.2712%。
 */
function supplementDoc(ctx, overrides = null) {
  const doc = {
    identity: {
      schema: 'US_V5_M2_Q0_STRESS_SUPPLEMENT_V1', result_kind: 'BASELINE_STRESS_SUPPLEMENT', record_type: 'BASELINE_STRESS_SUPPLEMENT_V1',
      baseline_result_id: ctx.q0Id, baseline_sha256: ctx.q0Sha, scenario: 'WINDOW_2020_02_19_04_30',
      input_route: 'FLOOR_ATTESTATION_LOCAL_DAILY', floor_attestation: { file: 'FLOOR_ATTESTATION_Q0S.json', sha256: hex('attest') },
      k2: { file: 'trading-system-v2/docs/US_V5_M2_Q0_STRESS_SUPPLEMENT_2020_K2_V1.md', sha256: supplement.ENTRY.k2.sha256, smartflow: 'research/us-v5-m2-r2-k2-final @056e5b9d',
        freeze: { file: 'artifacts/coordinator/US_V5_M2_R2_K2_FREEZE_1.md', sha256: supplement.ENTRY.freeze.sha256 } },
      smartflow_commit: '54f0394388a3c2b40a0f815a302d8514b8f44642', node: 'v18.20.8', engine_files: { 'scripts/research/us-v5-m2-q0s.js': hex('q0s-engine') },
      command: 'node scripts/research/us-v5-m2-q0s.js …',
    },
    inputs: { cache_manifest: { file: 'INPUTS_MANIFEST_A1.json', sha256: hex('manifest') }, attestation_series: [] },
    gates: Object.fromEntries(supplement.ENTRY.run_gates.map((name) => [name, gate()])),
    row: suppRow(2909.5764, 90.4236, 0.030141, 50, 2, -1.1396),
    reference_rows: [suppRow(2943.2523, 56.7477, 0.018916, 51, 2, -1.1658, {
      label_zh: '当前 D（D+A25+T3）参照：只报，不进 Q0、不进 Q5', ref: { result_id: ctx.q5Id, arm: 'CANDIDATE_T3_ON_A25' }, in_any_lock: false,
    })],
    q0_row_before: clone(ROW_2020),
    oos_reuse: false,
    window_history_zh: 'Q0–Q5 把这一行记为无效输入，0 笔；这一窗口从未被任何臂交易过，也从未用来选过任何规则',
    disclosures_zh: ['本补充只描述损失，不出三态，不设通过线，不声称功效'],
    reproducibility: { command: 'node scripts/research/us-v5-m2-q0s.js …', runs: [{ sha256: hex('q0s-run') }, { sha256: hex('q0s-run') }], identical: true },
  };
  if (typeof overrides === 'function') overrides(doc);
  return doc;
}

module.exports = { q0Doc, write, seedComparisons, gapDoc, supplementDoc, hex, clone, sha256, ROW_2020, ROW_2008 };
