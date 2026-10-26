'use strict';
/**
 * US_CORE_Q0_RESULT_V1_IMPORT_PROFILE §11（美股核心轮动的长历史 Q0 导入、页面与 M1 生产者）：
 *   - 负例与校验器负例用合成夹具 tests/_us_core_q0_fixture.js（CI 不读真实文件）；
 *   - 真实文件（Mac research-data/qrp_us_core_v1/）的导入与逐字页面断言：文件不在本机时跳过（跳过不算通过）。
 * 账本在临时目录（tests/_env），不碰 var/ledger、var/evidence。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const AUTHORITY = 'US_CORE_Q0_TEST_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const profiles = require('../services/strategy-profiles');
const k3 = require('../services/baseline-evaluation');
const workspace = require('../services/research-workspace');
const producers = require('../services/strategy-diagnostics/producers');
const usCoreProducer = require('../services/strategy-diagnostics/producers/US_CORE_M1_PRODUCER_V1');
const { result, write, hex } = require('./_us_core_q0_fixture');

const CORE = profiles.mustGet('US_CORE_9000USD_3X_GATEOBS');
const CASE = CORE.case_ref;
const PRODUCTION = JSON.parse(fs.readFileSync(profiles.FILE, 'utf8'));
const REAL_DIR = process.env.QRP_US_CORE_Q0_REAL_DIR || '/Users/kaylame/KaylaProject/research-data/qrp_us_core_v1/q0-9e682940';
const REAL = path.join(REAL_DIR, 'US_CORE_M2_Q0_RESULT_V1.json');
const REAL_M1 = process.env.QRP_US_CORE_M1_REAL_DIR || '/Users/kaylame/KaylaProject/research-data/qrp_us_core_v1/m1';
const HAVE_REAL = fs.existsSync(REAL);
const HAVE_DESK = Boolean(process.env.QRP_DESK_ROOT) && fs.existsSync(path.join(process.env.QRP_DESK_ROOT || '', 'src', 'operation-review.js'));
const SKIP_REAL = HAVE_REAL ? false : '真实 US_CORE Q0 文件不在本机（QRP_US_CORE_Q0_REAL_DIR）；跳过不算通过';
const SKIP_PAGE = HAVE_REAL && HAVE_DESK ? false : '真实 Q0 文件或 Desk 目录（QRP_DESK_ROOT）不在本机；页面断言跳过不算通过';
const CHROME = [process.env.QRP_TEST_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((file) => fs.existsSync(file));
const SKIP_BROWSER = SKIP_PAGE || (CHROME ? false : '本机没有 Chrome（可用 QRP_TEST_CHROME 指定）；浏览器布局未验证，跳过不算通过');
const CORE_DETAIL = '#strategy-detail?strategy=US_CORE_9000USD_3X_GATEOBS';

async function realModel(strategyRef = CORE.strategy_ref) {
  if (!k3.headLock(CASE)) k3.importBaselineEvaluation(REAL, { registeredBy: AUTHORITY, strategyRef: CORE.strategy_ref });
  k3.clearCache();
  return workspace.readModel({ strategyRef });
}
// §11.5：US_CORE 页不得出现的词；§11.6：US_V5 与 Quick Shot 页不得出现的 US_CORE 词与数字
const NOT_ON_CORE = ['USDT', 'BTC', '每笔扣费后净 R', '+0.10 R', '成熟交易', '5 bps', '相位 ±60 分钟', '120 分钟', 'h+1', '半凯利比例为 0', '采用率', 'Q0-24fb86c3609f7ef3', 'Q0-bd83dd6ec1754dbc',
  // 第 14 项 ★(a)：US_CORE 页不写海外桶的共享约束行；C17 的数字也不得出现
  '海外桶 Rule 1b：', '16,000', 'Q0-26691b6c3a2c4227', '7,737', '3,723.77'];
// C17 的真实 Q0 文件（有就导入临时账本，用来核对 US_CORE 与 C17 页面互不出现对方的数字）
const C17_REAL = path.join(process.env.QRP_C17_Q0_REAL_DIR || '/Users/kaylame/KaylaProject/research-data/qrp_crypto_v1/q0-c17', 'C17_V2_M2_Q0_RESULT_V1.json');
const CORE_WORDS = ['US_CORE_9000USD', '5,400', '61,200', '若照 Rule 1b 停止', 'Q0-c5b6fc7e1e29fff9'];

const PAGE = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
async function renderPage(model, hash) {
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = {
    id, innerHTML: '', textContent: '', addEventListener() {}, querySelector() { return null; }, focus() {}, scrollIntoView() {},
  });
  const sandbox = {
    document: { getElementById: element, title: '' }, location: { hash }, window: { addEventListener() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(model)) }),
    requestAnimationFrame() {}, URLSearchParams, Intl, encodeURIComponent, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return elements.workspace.innerHTML;
}
const textOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const withoutDetails = (html) => {
  let out = html;
  for (let guard = 0; guard < 50 && /<details/.test(out); guard += 1) out = out.replace(/<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/g, '');
  return out;
};

const project = (doc) => k3.project({ doc, sha256: hex('synthetic'), file: '/synthetic', size: 1 },
  { strategy_ref: CORE.strategy_ref, result_id: 'Q0-test', locked_at: 't', locked_by: 't', inputs_digest: 'x', engine_digest: 'x' }, CORE);
const block = (projection, key) => projection.blocks.find((item) => item.key === key);
const refuses = (patch, code, detail) => assert.throws(() => k3.validateWhole(result(patch), CORE, { fileSha256: hex('this-file') }), (error) => {
  assert.equal(error.code, code);
  if (detail) assert.match(error.detail || '', detail);
  return true;
});

// ── §11.8 负例（合成夹具） ─────────────────────────────────────────────────────────

test('§11.8 合成夹具本身：整文件通过，六块可读，读法按 G_GAP 走（主数字、判据两行、A0 一行、高亮、半凯利不适用）', () => {
  assert.deepEqual(k3.validateWhole(result(), CORE, { fileSha256: hex('this-file') }), []);
  const projection = project(result());
  assert.deepEqual(projection.blocks.map((item) => `${item.key}:${item.state}`),
    ['period:AVAILABLE', 'account:AVAILABLE', 'winrate:AVAILABLE', 'stress:AVAILABLE', 'kelly:AVAILABLE', 'verdict:AVAILABLE']);
  const c = projection.conclusion;
  assert.equal(c.main_number.label, '样本外年化对数增长差，相对 SPY 买入持有（每边 5 bp，下一开盘成交；门槛 0）');
  assert.equal(c.main_number.unit, 'pct_signed');
  assert.match(c.main_number_note_zh, /^样本外在开发时已用过：/);
  assert.deepEqual(c.basis.main, ['相对 SPY 买入持有的年化对数增长差 +7.0%，95% 区间 −10.0% 至 +25.0%，区间跨过门槛 0',
    '相对现金的年化对数增长 +20.0%，95% 区间 −5.0% 至 +45.0%，区间跨过门槛 0', '样本外 105 个月（门槛 30 个月）']);
  assert.equal(c.biggest_limit, '相对 SPY 买入持有与相对现金的年化对数增长，95% 区间都跨过门槛 0，现有样本不足以判定。');
  assert.equal(c.highlights[0].valid, true);
  assert.equal(c.highlights[0].text_zh, '样本外 2019-05-28 自起点峰值 11,000 回撤 40.9% 触发停止，之后不再开新仓，期末 6,100；现行主臂不执行停止，期末 40,000。');
  assert.equal(c.highlights[0].gap_zh, 'Q0 封存时（2026-10-26）的生产缺口（未修）：合成：Rule 1b 停止记录写不进本账本。');
  assert.equal(block(projection, 'period').data.a0.text_zh,
    '引擎对齐关卡 A0：按 A0 裁定 1 通过（5 / 5）；按 K2 原文 3 / 5（A0-1、A0-2 未通过：U6 在窗口中间才部署；09-28 的 ^TNX 收盘差一个 float32 步长）；未记录 3 项（A0-1 2、A0-2 1），不计入一致或不符');
  assert.equal(block(projection, 'period').data.engine.label, '当前 D（引擎对齐关卡 A0 按 A0 裁定 1 通过；规则清单无未实现项，1 条附近似说明）');
  assert.equal(block(projection, 'kelly').data.mode, 'NOT_APPLICABLE');
  const stress = block(projection, 'stress').data;
  assert.deepEqual(stress.headline, { scenario: 'PHASE_NEXT_CLOSE', label: '下一收盘成交', max_loss_usd: 12000.4, max_drawdown: 0.45 });
  assert.equal(stress.money_digits, 0);
  assert.equal(stress.rows.find((row) => row.scenario === 'RISK_PRE_U6_MACRO').same_as_reference, true);
  assert.equal(stress.rows.find((row) => row.scenario === 'RISK_RULE1B_HONORED').same_as_reference, false);
  assert.deepEqual(stress.counts, { executed: 2, simulated: 1, missing: 1, invalid_input: 0, reference: 1, risk_dimension: 2, same_as_reference: 0 });
  const verdict = block(projection, 'verdict').data;
  assert.equal(verdict.metric, 'G_GAP');
  assert.equal(verdict.n_trades, null);
  assert.deepEqual(verdict.reasons.map((item) => item.text), ['相对 SPY 买入持有的年化对数增长差，95% 区间跨过门槛 0（这一条本身不足以判定）', '样本外在开发时已用过']);
});

test('§11.8 判据：G_GAP 而 delta_R 有值；同源四项任一与主数字行不等；SUPPORTED 越过证据或月数不足；NOT_PASSED 无依据', () => {
  refuses((doc) => { doc.verdict.delta_R = 0.1; }, 'Q0_VERDICT_DELTA_CHANGED');
  refuses((doc) => { doc.verdict.delta_g = 0.01; }, 'Q0_VERDICT_DELTA_CHANGED');
  refuses((doc) => { doc.verdict.L_g = -0.11; }, 'Q0_VERDICT_NOT_FROM_MAIN_ROW', /L_g\/U_g/);
  refuses((doc) => { doc.verdict.U_g_cash = 0.5; }, 'Q0_VERDICT_NOT_FROM_MAIN_ROW', /L_g_cash/);
  refuses((doc) => { doc.verdict.n_months = 104; }, 'Q0_VERDICT_NOT_FROM_MAIN_ROW', /n_months/);
  refuses((doc) => { doc.verdict.g_diff_spy = 0.08; }, 'Q0_VERDICT_NOT_FROM_MAIN_ROW', /g_diff_spy/);
  refuses((doc) => { doc.stats.rows = doc.stats.rows.filter((row) => !(row.segment === 'OOS' && row.cost_bps === 5 && row.phase === 'NEXT_OPEN')); }, 'Q0_VERDICT_NOT_FROM_MAIN_ROW', /主数字行缺失/);
  const supported = (doc, lo, loCash, months = 105) => {
    const main = doc.stats.rows.find((row) => row.segment === 'OOS' && row.cost_bps === 5 && row.phase === 'NEXT_OPEN');
    main.g_diff_spy_ci = [lo, 0.25]; main.g_ci = [loCash, 0.45]; main.months = months;
    Object.assign(doc.verdict, { state: 'SUPPORTED', L_g: lo, L_g_cash: loCash, n_months: months, reason_codes: ['STRESS_SCENARIO_MISSING', 'OOS_REUSED_IN_DEVELOPMENT'] });
  };
  refuses((doc) => supported(doc, -0.01, 0.02), 'Q0_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses((doc) => supported(doc, 0.01, -0.02), 'Q0_VERDICT_SUPPORTED_WITHOUT_EVIDENCE');
  refuses((doc) => supported(doc, 0.01, 0.02, 29), 'Q0_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL');
  // G3 不回归：SUPPORTED、2008 缺场景而没有 STRESS_SCENARIO_MISSING
  refuses((doc) => { supported(doc, 0.01, 0.02); doc.verdict.reason_codes = ['OOS_REUSED_IN_DEVELOPMENT']; }, 'Q0_VERDICT_SUPPORTED_HIDES_INCOMPLETE_STRESS', /EXTREME_DOWNTURN_2008/);
  assert.deepEqual(k3.validateWhole(result((doc) => supported(doc, 0.01, 0.02)), CORE), []);
  refuses((doc) => { doc.verdict.state = 'NOT_PASSED'; }, 'Q0_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE');
});

test('§11.8 样本外复用、A0 两种读法、approximations、规则状态、补充行：各自的拒绝码（不回归的照旧）', () => {
  refuses((doc) => { doc.verdict.reason_codes = ['CI_STRADDLES_DELTA']; }, 'Q0_OOS_REUSE_NOT_DISCLOSED');
  refuses((doc) => { doc.verdict.oos_reuse = false; }, 'Q0_OOS_REUSE_NOT_DISCLOSED');
  assert.deepEqual(k3.validateWhole(result((doc) => { doc.verdict.oos_reuse = false; doc.verdict.reason_codes = ['CI_STRADDLES_DELTA']; }), CORE), []);
  refuses((doc) => { delete doc.gates.A0.k2_literal; }, 'Q0_A0_DUAL_READING_MISSING');
  refuses((doc) => { delete doc.gates.A0.unknown_counts; }, 'Q0_A0_DUAL_READING_MISSING');
  refuses((doc) => { doc.identity.a0_ruling_1_sha256 = hex('other-ruling'); }, 'Q0_A0_RULING_MISMATCH');
  refuses((doc) => { doc.gates.A0.result_sha256 = hex('other-a0'); }, 'Q0_A0_RULING_MISMATCH', /result_sha256/);
  // §4.1 ★(a)：没有 APPROXIMATED 时 approximations 缺失按 [] 读；有 APPROXIMATED 而缺失仍拒绝
  refuses((doc) => { doc.gates.rules[1].status = 'APPROXIMATED'; doc.gates.rules[1].note_zh = '合成'; }, 'Q0_VERDICT_ENGINE_APPROXIMATION_MISSING');
  refuses((doc) => { doc.gates.rules[0].status = 'PARTIAL'; }, 'Q0_RULE_STATUS_UNKNOWN');
  refuses((doc) => { doc.gates.rules.push({ rule: 'UC-X9', status: 'NOT_IMPLEMENTED', code_ref: 'x.js:1' }); }, 'Q0_ENGINE_APPROXIMATION_NOT_DECLARED', /UC-X9/);
  refuses((doc) => { doc.stress.rows[4].simulated = false; doc.stress.rows[4].status = undefined; doc.stress.rows[4].in_headline = undefined; }, 'Q0_STRESS_SIMULATED_NOT_FLAGGED');
  // 路径带 fixture 的文件按非实际来源拒绝（不回归）
  assert.throws(() => k3.importBaselineEvaluation(write(), { registeredBy: AUTHORITY, strategyRef: CORE.strategy_ref }), (error) => error.code === 'Q0_RESULT_NON_ACTUAL_SOURCE');
});

test('§11.8 半凯利不适用、风控高亮、前向：坏输入只让各自那一块或那一行无效，结论不变', () => {
  const kellyInvalid = (patch, pattern) => {
    const kelly = block(project(result(patch)), 'kelly');
    assert.equal(kelly.state, 'NOT_BACKTESTED');
    assert.match(kelly.reason, pattern);
  };
  kellyInvalid((doc) => { doc.half_kelly.state = 'COMPUTED'; }, /NOT_APPLICABLE/);
  kellyInvalid((doc) => { doc.half_kelly.floor_usd = 5000; }, /floor_usd/);
  kellyInvalid((doc) => { delete doc.half_kelly.floor_usd; }, /floor_usd/);
  kellyInvalid((doc) => { doc.half_kelly.p_below_floor = 1.2; }, /p_below_floor/);
  kellyInvalid((doc) => { doc.half_kelly.paths = 0; }, /paths/);
  kellyInvalid((doc) => { doc.half_kelly.rule1b_events.OOS = 'none'; }, /rule1b_events/);
  const highlight = (patch) => project(result(patch)).conclusion.highlights[0];
  assert.match(highlight((doc) => { doc.stress.rows = doc.stress.rows.filter((row) => row.scenario !== 'RISK_RULE1B_HONORED'); }).text_zh, /^风控高亮无效：压力表没有/);
  assert.match(highlight((doc) => { doc.stress.rows[5].report_only = false; }).text_zh, /不是只报不判/);
  assert.match(highlight((doc) => { doc.stress.rows[5].halt_events = []; }).text_zh, /没有 halt_events/);
  assert.match(highlight((doc) => { doc.stress.rows[0].end_capital = 39999; }).text_zh, /参照行 BASELINE/);
  assert.match(highlight((doc) => { doc.diagnosis_items[0].id = 'DX-OTHER'; }).text_zh, /诊断项 DX-RISK-1 不存在/);
  assert.equal(project(result((doc) => { doc.stress.rows[5].halt_events = []; })).conclusion.label, '证据不足');
  const forward = (patch) => block(project(result(patch)), 'account').data.forward;
  assert.equal(forward().text_zh, '前向记录（PAPER 账本 US_CORE_9000USD_3X_GATEOBS，只报不判，不进结论）：2026-10-08 → 2026-10-23，9,000 → 8,100（−10.0%）。');
  assert.match(forward((doc) => { doc.forward.in_verdict = true; }).text_zh, /^前向记录无效：in_verdict/);
  assert.match(forward((doc) => { doc.forward.book = 'US_V5_ETF_3000USD'; }).text_zh, /不是本策略/);
  assert.match(forward((doc) => { doc.forward.return = -0.2; }).text_zh, /return 与/);
  assert.equal(block(project(result((doc) => { doc.forward.in_verdict = true; })), 'verdict').state, 'AVAILABLE');
});

test('§11.9 档案校验器：G_GAP 读法缺项、半凯利不适用带阈值、主数字费用词不全、高亮不是 RISK_ 或太多、原因码键不合规、LEGACY 带新项，都拒绝', () => {
  const core = PRODUCTION.profiles.find((item) => item.strategy_ref === CORE.strategy_ref);
  const us = PRODUCTION.profiles.find((item) => item.strategy_ref === 'US_V5_ETF_3000USD');
  const reject = (mutate, code, detail) => {
    const doc = JSON.parse(JSON.stringify(PRODUCTION));
    mutate(doc.profiles.find((item) => item.strategy_ref === CORE.strategy_ref), doc.profiles.find((item) => item.strategy_ref === us.strategy_ref));
    assert.throws(() => profiles.validate(doc), (error) => { assert.equal(error.code, code); if (detail) assert.match(error.detail || '', detail); return true; });
  };
  assert.ok(core && profiles.validate(PRODUCTION));
  reject((p) => { p.q0_reading.metric.kind = 'PER_EPISODE'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /metric\.kind/);
  reject((p) => { delete p.q0_reading.g_paths; }, 'STRATEGY_PROFILE_FIELD_MISSING', /g_paths/);
  reject((p) => { delete p.q0_reading.metric.min_months; }, 'STRATEGY_PROFILE_FIELD_MISSING', /min_months/);
  reject((p) => { delete p.q0_reading.winrate; }, 'STRATEGY_PROFILE_FIELD_MISSING', /winrate/);
  reject((p) => { delete p.q0_reading.kelly.mode; }, 'STRATEGY_PROFILE_FIELD_MISSING', /kelly\.mode/);
  reject((p) => { p.q0_reading.kelly.thresholds = [{ field: 'p_below_floor', value: 5400, label_zh: 'x' }]; }, 'STRATEGY_PROFILE_FIELD_TYPE', /thresholds:not allowed/);
  reject((p) => { p.q0_reading.main_row.cost = '10'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /main_row\.cost/);
  reject((p) => { p.q0_reading.highlights[0].scenario = 'BASELINE'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /highlights\[0\]\.scenario/);
  reject((p) => { p.q0_reading.highlights = [1, 2, 3].map((i) => ({ key: `K${i}`, scenario: 'RISK_X', label_zh: 'x' })); }, 'STRATEGY_PROFILE_FIELD_TYPE', /at most 2/);
  reject((p) => { p.q0_reading.reason_words_zh['bad code'] = '中文'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /reason_words_zh/);
  reject((p) => { p.q0_reading.scenario_words_zh.BASELINE = 'English only'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /scenario_words_zh/);
  reject((p) => { p.q0_reading.a0.ruling_sha256 = 'abc'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /ruling_sha256/);
  reject((p) => { p.q0_reading.forward.kind = 'TRADES'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /forward\.kind/);
  reject((p, legacy) => { legacy.q0_reading = { metric: { kind: 'G_GAP' } }; }, 'STRATEGY_PROFILE_FIELD_TYPE', /LEGACY_V1/);
});

test('§11.10 M1：真实 M1 包——交接买入 units 与签署成本、12 个 mark、终点 7,836.21192664；合成：任一超容差 → 诊断失败关闭；US 成本模型文件不变', { skip: fs.existsSync(path.join(REAL_M1, 'MANIFEST.sha256')) ? false : 'M1 包不在本机（QRP_US_CORE_M1_REAL_DIR）；跳过不算通过' }, () => {
  assert.equal(producers.resolve('US_CORE_M1_PRODUCER_V1').build, usCoreProducer.build);
  const diagnostic = usCoreProducer.build({ root: REAL_M1, strategyRef: CORE.strategy_ref });
  assert.equal(diagnostic.state, 'VERIFIED');
  assert.equal(diagnostic.case_ref, CASE);
  assert.equal(diagnostic.closed_round_trips, 0);
  assert.deepEqual(diagnostic.fills.map((fill) => [fill.sleeve, fill.units, fill.signed_model.entry, fill.reason_code]),
    [['SPY', 29.259367449148, 2.25, 'BOOK_HANDOVER_OPEN'], ['QQQ', 54.634074299787, 2.25, 'BOOK_HANDOVER_OPEN']]);
  assert.equal(diagnostic.account.marks.length, 12);
  assert.equal(diagnostic.account.end, 7836.21192664);
  assert.equal(diagnostic.traced_decision.handover.decidedAtSession, '2026-10-07');
  assert.equal(diagnostic.traced_decision.holds.length, 12);
  assert.ok(diagnostic.limitations.some((text) => /HALTABLE/.test(text)));
  // 合成：账本里的买入费用差 1e-5 → US_CORE_M1_COST_MISMATCH
  assert.throws(() => usCoreProducer.reconcileFill({ asOf: '2026-10-08', sleeve: 'SPY', action: 'cash → lev', sellPrice: null, buyPrice: 153.72000122070312, buyFee: 2.25001, unitsAfter: 29.259367449148, cashAfter: 0 },
    { cash: 4500 }, { strategy_bps_each_side: 5, tolerance_usd: 1e-6, cat_rate_per_equivalent_share_each_side: 0.000003, commission_usd: 0 }, (value) => value), (error) => error.code === 'US_CORE_M1_COST_MISMATCH');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'services/strategy-diagnostics/cost_models/US_V5_M1_RESEARCH_COST_V1.js'))).digest('hex'),
    crypto.createHash('sha256').update(require('node:child_process').execFileSync('git', ['show', 'fd74149:services/strategy-diagnostics/cost_models/US_V5_M1_RESEARCH_COST_V1.js'], { cwd: ROOT })).digest('hex'));
});

test('§11.3 真实文件导入（临时账本）：result_id、case、三态、摘要；重复导入是幂等重放；挑错档案或未登记档案都拒绝，账本不写', { skip: SKIP_REAL }, () => {
  fs.rmSync(k3.LEDGER(), { force: true });
  assert.throws(() => k3.importBaselineEvaluation(REAL, { registeredBy: AUTHORITY, strategyRef: 'US_V5_ETF_3000USD' }), (error) => error.code === 'Q0_RESULT_SCHEMA_UNSUPPORTED');
  assert.throws(() => k3.importBaselineEvaluation(REAL, { registeredBy: AUTHORITY, strategyRef: 'US_CORE_NOT_REGISTERED' }), (error) => error.code === 'STRATEGY_PROFILE_NOT_REGISTERED');
  assert.equal(fs.existsSync(k3.LEDGER()), false);
  const lock = k3.importBaselineEvaluation(REAL, { registeredBy: AUTHORITY, strategyRef: CORE.strategy_ref });
  assert.equal(lock.result_id, 'Q0-c5b6fc7e1e29fff9');
  assert.equal(lock.strategy_ref, 'US_CORE_9000USD_3X_GATEOBS');
  assert.equal(lock.case_ref, 'RRC-US-CORE-9000-V8-1-M0');
  assert.equal(lock.verdict_state, 'INSUFFICIENT');
  assert.equal(lock.file_sha256, 'c5b6fc7e1e29fff97332f5ce7b033725f901f096111da5c1e7e7ad5fa4cc96e9');
  assert.equal(lock.inputs_digest, '0cec768be263bc62e6350b44173def1eb4222817b91171f4ec52c0de7f8a9824');
  assert.equal(lock.engine_digest, '5421c9dd36d1cc7ba490310b7cf0c2dda2dfb3a631bfc3b1a28b7356ac743d13');
  assert.equal(lock.supersedes_ref, null);
  const before = fs.readFileSync(k3.LEDGER());
  assert.equal(k3.importBaselineEvaluation(REAL, { registeredBy: AUTHORITY, strategyRef: CORE.strategy_ref }).replayHit, true);
  assert.deepEqual(fs.readFileSync(k3.LEDGER()), before);
  assert.equal(k3.locks(CASE).length, 1);
});

test('§11.4–§11.7 真实文件的页面（全部展开）：逐字断言；US_CORE 页不含 R、USDT、采用率；US_V5 与 QS 页不含 US_CORE 的词与数字；D5 计数', { skip: SKIP_PAGE }, async () => {
  const model = await realModel();
  const detail = model.views['strategy-detail'];
  assert.equal(detail.backtest.state, 'LOCKED_VERIFIED');
  assert.equal(detail.currency, 'USD');
  const html = await renderPage(model, `${CORE_DETAIL}&section=all`);
  const text = textOf(html);
  const has = (needle) => assert.ok(text.includes(needle), `页面缺：${needle}`);
  // §3.2 主数字与紧挨的样本外复用行
  has('样本外年化对数增长差，相对 SPY 买入持有（每边 5 bp，下一开盘成交；门槛 0）：+8.5%（95% 区间 −12.5% 至 +29.1%）');
  has('样本外在开发时已用过：这条规则 2026-08-15 在 2010–2026 的同一份数据上选出（oos_reuse = true）；真正没用过的只有 2026-10-01 起的前向。');
  // §3.4 判定依据与最大的限制
  has('相对 SPY 买入持有的年化对数增长差 +8.5%，95% 区间 −12.5% 至 +29.1%，区间跨过门槛 0');
  has('相对现金的年化对数增长 +22.0%，95% 区间 −4.7% 至 +48.7%，区间跨过门槛 0');
  has('样本外 105 个月（门槛 30 个月）');
  has('门槛在看到结果前已冻结');
  has('最大的限制：相对 SPY 买入持有与相对现金的年化对数增长，95% 区间都跨过门槛 0，现有样本不足以判定。');
  // §4.2 A0 一行；§4.1 引擎标签
  has('引擎对齐关卡 A0：按 A0 裁定 1 通过（5 / 5）；按 K2 原文 3 / 5（A0-1、A0-2 未通过：U6 在窗口中间才部署；09-28 的 ^TNX 收盘差一个 float32 步长）；未记录 42 项（A0-1 36、A0-2 6），不计入一致或不符');
  has('当前 D（引擎对齐关卡 A0 按 A0 裁定 1 通过；规则清单无未实现项，2 条附近似说明）');
  // §5.2 最大损失；§5.3 三行；§5.5 计数行
  has('最大损失：25,567 美元（场景：下一收盘成交；回撤 47.6%，复利后账户上的美元数）');
  has('优势结论：证据不足');
  has('压力评价不完整：缺场景 1 个、无效输入 0 个（极端下跌 2007–2009：缺场景）');
  has('采用条件：未满足（必要压力缺失，§6.7）');
  has('已执行 9 个压力场景，模拟或补充 2 个，缺场景 1 个，无效输入 0 个；另有当前 D 参照 1 行、风控维度 4 行（只报不判，不进最大损失）。缺场景和无效输入不计为已执行的压力。');
  has('模拟序列，不是可交易历史；模拟，不进结论');
  // §6.2 结论卡的高亮两行
  // US_CORE 冻结说明 1：§6.2 两行逐字（标题写明近似；缺口一行带封存日期前缀）
  has('若照 Rule 1b 停止（近似：只按 US_CORE 自己的曲线套 40% 线，停后不解除；真实规则看海外桶合计、由 Owner 解除，见研究题 R1B-1；只报不判，不进结论）：样本外 2019-05-28 自起点峰值 11,001 回撤 40.4% 触发停止，之后不再开新仓，期末 6,145；现行主臂不执行停止，期末 61,200。');
  has('Q0 封存时（2026-10-26）的生产缺口（未修）：Rule 1b 停止记录写不进 US_CORE_*_GATEOBS（new-entry-halt-writer.js:41-42,91，recordHaltForReview → NOT_A_HALTABLE_BOOK）。');
  assert.ok(!text.includes('若照 Rule 1b 停止（只报不判，不进结论）'), '标题不得省掉近似说明');
  // §7.2 半凯利
  has('半凯利：不适用——没有止损与每笔风险单位，仓位是整袖资本按档位持有');
  has('按样本外月度分块重抽 10,000 条路径：权益曾低于 5,400 美元（Rule 1b 40% 线）的概率 25.6%；期末低于起点 9,000 的概率 5.5%');
  has('样本外主臂越过 40% 线 13 次（第一次 2019-05-28）');
  has('研究计算，不是仓位建议；现行仓位规则不变。底线：Rule 1b 的 5,400（9,000 的 40% 线）。');
  // §8.1 持有段；§8.2 前向两句；§2.2 比较对象口径
  has('3x 持有段段数');
  has('前向记录（PAPER 账本 US_CORE_9000USD_3X_GATEOBS，只报不判，不进结论）：2026-10-08 → 2026-10-23，9,000 → 7,836（−12.9%）。');
  has('Q0 结果文件里带有前向记录（只报不判）；HK 前向影子：本策略尚未登记。');
  has('比较对象口径：SPY 买入持有按总收益（含分红）计（结果文件 basis = TOTAL_RETURN_ADJCLOSE）。');
  // §11.5 不得出现
  const main = textOf(withoutDetails(html));
  for (const word of NOT_ON_CORE) assert.ok(!text.includes(word), `US_CORE 页不得出现：${word}`);
  // §11.7 D5：页面不重算恰好一次；三行结论块恰好一次；主内容没有已登记的英文原因码
  assert.equal((html.match(/页面不重算/g) || []).length, (html.match(/数字取自已锁定的结果文件与采用记录，页面不重算/g) || []).length + 1, '回测与研究区一次，另加总览页签的来源行');
  assert.equal((html.match(/class="completeness"/g) || []).length, 1);
  for (const code of ['CI_STRADDLES_DELTA', 'OOS_REUSED_IN_DEVELOPMENT', 'G_VS_CASH_CI_STRADDLES_ZERO']) assert.ok(!main.includes(code), `主内容出现英文原因码 ${code}`);
  // §11.6：US_V5、Quick Shot 与 C17_V2 的详情页不得出现 US_CORE 的词与数字
  const c17 = profiles.mustGet('C17_V2_4000USDT');
  if (fs.existsSync(C17_REAL) && !k3.headLock(c17.case_ref)) k3.importBaselineEvaluation(C17_REAL, { registeredBy: AUTHORITY, strategyRef: c17.strategy_ref });
  for (const ref of ['US_V5_ETF_3000USD', 'QUICK_SHOT_V3_1000USDT', 'C17_V2_4000USDT']) {
    const other = textOf(await renderPage(await workspace.readModel({ strategyRef: ref }), `#strategy-detail?strategy=${ref}&section=all`));
    for (const word of CORE_WORDS) assert.ok(!other.includes(word), `${ref} 页出现了 US_CORE 的「${word}」`);
  }
});

test('修订 7 在 US_CORE 页上：总览的一句话与 6 张卡（没有采用率卡），卡片取自 US_CORE 的 Q0 锁，比较对象是 SPY 买入持有', { skip: SKIP_PAGE }, async () => {
  const model = await realModel();
  const summary = model.views['strategy-detail'].summary;
  assert.equal(summary.sentence_zh, '现行版本样本外期末 61,200，高于 SPY 买入持有的 29,161（证据不足；样本外在开发时已用过）；若照 Rule 1b 停止，2019-05-28 起不再开新仓，期末 6,145。');
  assert.deepEqual(summary.tiles.map((tile) => tile.key), ['end_capital', 'max_drawdown', 'winrate', 'half_kelly', 'rule1b', 'underwater']);
  const tile = (key) => summary.tiles.find((item) => item.key === key);
  assert.equal(tile('winrate').label_zh, '样本外 3x 持有段胜率与赔率');
  assert.equal(tile('winrate').n, 48);
  assert.equal(tile('half_kelly').not_applicable, true);
  assert.equal(tile('rule1b').halt_session, '2019-05-28');
  assert.equal(summary.adoption, null);
  const text = textOf(await renderPage(model, CORE_DETAIL));
  assert.ok(text.includes('样本外 · 每边 5 bp · 下一开盘成交，48 段'));
  assert.ok(text.includes('不适用权益曾低于 5,400 的概率 25.6%'));
  assert.ok(text.includes('生产缺口：停止记录写不进本账本（未修）'));
  assert.ok(!text.includes('采用率'));
});

const PROBE = (routes) => `<!doctype html><meta charset="utf-8"><title>probe</title><pre id="out">PENDING</pre><script>
const routes = ${JSON.stringify(routes)};
(async () => {
  const results = [];
  for (const [route, width] of routes) {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;left:0;top:0;border:0;height:800px;width:' + width + 'px';
    frame.src = '/' + route;
    document.body.appendChild(frame);
    await new Promise((resolve) => frame.addEventListener('load', resolve));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const doc = frame.contentDocument; const root = doc.documentElement;
    results.push({ route, width, height: root.scrollHeight, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, sections: doc.querySelectorAll('#workspace .detail-section').length, text: doc.getElementById('workspace').innerText.length });
    frame.remove();
  }
  document.getElementById('out').textContent = JSON.stringify(results);
})();
</script>`;

test('修订 7 J5.1 在 US_CORE 页上：1280 × 800 下总览 ≤ 1,600 px；390 px 宽下总览与各页签都没有整页横向滚动（真实 Q0 锁）', { skip: SKIP_BROWSER, timeout: 300000 }, async () => {
  const model = await realModel();
  const page = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'));
  const routes = [[CORE_DETAIL, 1280], ...['', '&section=runtime', '&section=health', '&section=research', '&section=forward', '&section=review', '&section=all'].map((extra) => [`${CORE_DETAIL}${extra}`, 390])];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__probe')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PROBE(routes)); return; }
    if (req.url.startsWith('/api/workspace')) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(model)); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-us-core-chrome-'));
  try {
    const stdout = await new Promise((resolve) => {
      const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        `--user-data-dir=${profileDir}`, '--virtual-time-budget=60000', '--dump-dom', `http://127.0.0.1:${server.address().port}/__probe`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = ''; child.stdout.on('data', (chunk) => { out += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      child.on('close', () => { clearTimeout(timer); resolve(out); });
    });
    const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(stdout);
    assert.ok(match && match[1] !== 'PENDING', '探针页没有跑完');
    const rows = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    assert.equal(rows.length, routes.length);
    for (const row of rows) assert.ok(row.sections >= 1 && row.text > 80, `${row.route} @${row.width} 没有渲染出页面（${row.text} 字）`);
    assert.ok(rows[0].height <= 1600, `US_CORE 总览 @1280：${rows[0].height} px > 1,600`);
    for (const row of rows.filter((item) => item.width === 390)) assert.ok(row.scrollWidth <= row.clientWidth, `${row.route} @390：整页横向宽度 ${row.scrollWidth} > ${row.clientWidth}`);
    console.log(`US_CORE J5.1: overview@1280 height=${rows[0].height}; 390: ${rows.slice(1).map((row) => `${row.route.split('&section=')[1] || 'overview'} ${row.scrollWidth}/${row.clientWidth}`).join(', ')}`);
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});
