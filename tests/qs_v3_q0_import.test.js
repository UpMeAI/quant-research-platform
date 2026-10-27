'use strict';
/**
 * CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE §11（Quick Shot V3 的长历史 Q0 导入、页面与 M1 成本模型）：
 *   - 负例与校验器负例用合成夹具 tests/_qs_q0_fixture.js（CI 不读真实文件）；
 *   - 真实文件（Mac research-data/qrp_crypto_v1/）的导入与逐字页面断言：文件不在本机时跳过（跳过不算通过）。
 * 账本在临时目录（tests/_env），不碰 var/ledger、var/evidence。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const AUTHORITY = 'QS_Q0_TEST_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const profiles = require('../services/strategy-profiles');
const k3 = require('../services/baseline-evaluation');
const workspace = require('../services/research-workspace');
const costModels = require('../services/strategy-diagnostics/cost_models');
const diagnostics = require('../services/strategy-diagnostics');
const producers = require('../services/strategy-diagnostics/producers');
const { result, write, hex, fileSha } = require('./_qs_q0_fixture');

const QS = profiles.mustGet('QUICK_SHOT_V3_1000USDT');
const CASE = QS.case_ref;
const PRODUCTION = JSON.parse(fs.readFileSync(profiles.FILE, 'utf8'));
const REAL_DIR = process.env.QRP_QS_Q0_REAL_DIR || '/Users/kaylame/KaylaProject/research-data/qrp_crypto_v1/q0-qs';
const REAL = path.join(REAL_DIR, 'QS_V3_M2_Q0_RESULT_V1.json');
const REAL_SUPERSEDED_1 = path.join(REAL_DIR, 'superseded-1', 'QS_V3_M2_Q0_RESULT_V1.json');
const REAL_NO_AUDIT = path.join(REAL_DIR, 'superseded-2-no-audit', 'QS_V3_M2_Q0_RESULT_V1.json');
const REAL_M1 = process.env.QRP_QS_M1_REAL_DIR || '/Users/kaylame/KaylaProject/research-data/qrp_crypto_v1/m1-qs';
const HAVE_REAL = fs.existsSync(REAL) && fs.existsSync(REAL_SUPERSEDED_1) && fs.existsSync(REAL_NO_AUDIT);
const HAVE_DESK = Boolean(process.env.QRP_DESK_ROOT) && fs.existsSync(path.join(process.env.QRP_DESK_ROOT || '', 'src', 'operation-review.js'));
const SKIP_REAL = HAVE_REAL ? false : '真实 Quick Shot Q0 文件不在本机（QRP_QS_Q0_REAL_DIR）；跳过不算通过';
const SKIP_PAGE = HAVE_REAL && HAVE_DESK ? false : '真实 Q0 文件或 Desk 目录（QRP_DESK_ROOT）不在本机；页面断言跳过不算通过';
const CHROME = [process.env.QRP_TEST_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((file) => fs.existsSync(file));
const SKIP_BROWSER = SKIP_PAGE || (CHROME ? false : '本机没有 Chrome（可用 QRP_TEST_CHROME 指定）；浏览器布局未验证，跳过不算通过');
const QS_DETAIL = '#strategy-detail?strategy=QUICK_SHOT_V3_1000USDT';
/** 真实 Quick Shot 锁（临时账本里导入一次）与它的工作台模型。 */
async function realModel(strategyRef = QS.strategy_ref) {
  if (!k3.headLock(CASE)) k3.importBaselineEvaluation(REAL, { registeredBy: AUTHORITY, strategyRef: QS.strategy_ref });
  k3.clearCache();
  return workspace.readModel({ strategyRef });
}
// §11.5：Quick Shot 页面不得出现的 US 词与数字
const US_WORDS = ['美元', 'US$', 'SPY', '1,800', '5 bps', '相位 ±60 分钟', '120 分钟', '规则清单无缺口', 'Q0-24fb86c3609f7ef3', 'RRC-US-V5'];
const QS_NUMBERS = ['USDT', '698.67', 'Q0-bd83dd6ec1754dbc', '949.4', '−50.59', 'A19', '2,102', '1,911'];

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

const project = (doc, file = null) => {
  const sealed = file ? k3.readSealed(file, { allowNonActual: true }) : { doc, sha256: hex('synthetic'), file: '/synthetic', size: 1 };
  return k3.project(sealed, { strategy_ref: QS.strategy_ref, result_id: 'Q0-test', locked_at: 't', locked_by: 't', inputs_digest: 'x', engine_digest: 'x' }, QS);
};
const block = (projection, key) => projection.blocks.find((item) => item.key === key);
const refuses = (patch, code, detail) => assert.throws(() => k3.validateWhole(result(patch), QS, { fileSha256: hex('this-file') }), (error) => {
  assert.equal(error.code, code);
  if (detail) assert.match(error.detail || '', detail);
  return true;
});

// ── §11.7 负例（合成夹具） ─────────────────────────────────────────────────────────

test('§11.7 合成夹具本身：整文件通过，六块可读，读法按 q0_reading 走', () => {
  const projection = project(result());
  assert.deepEqual(projection.blocks.map((item) => `${item.key}:${item.state}`),
    ['period:AVAILABLE', 'account:AVAILABLE', 'winrate:AVAILABLE', 'stress:AVAILABLE', 'kelly:AVAILABLE', 'verdict:AVAILABLE']);
  assert.equal(projection.conclusion.main_number.label, '样本外每笔扣费后净 R 均值（基础成本，h+1 开盘成交；门槛 +0.10 R）');
  assert.equal(block(projection, 'stress').data.headline.max_loss_usd, 130.125);
  assert.equal(block(projection, 'stress').data.counts.same_as_reference, 1);
  assert.equal(block(projection, 'stress').data.rows.find((row) => row.scenario === 'RISK_OPEN_CAP_100').same_as_reference, true);
  assert.equal(block(projection, 'stress').data.rows.find((row) => row.scenario === 'RISK_MARGIN_15').same_as_reference, false);
});

test('§11.7 规则清单：近似集合不等、近似缺披露、未知状态各被拒绝；NOT_IMPLEMENTED 而 flag=false 仍拒绝（不回归）', () => {
  refuses((doc) => { doc.verdict.engine_approximation.approximations = ['QS-E1', 'QS-X2']; }, 'Q0_ENGINE_APPROXIMATIONS_MISMATCH');
  refuses((doc) => { doc.verdict.engine_approximation.approximations = []; }, 'Q0_ENGINE_APPROXIMATIONS_MISMATCH');
  refuses((doc) => { doc.gates.rules[1].note_zh = null; }, 'Q0_APPROXIMATION_SIZE_NOT_DISCLOSED', /QS-E1/);
  refuses((doc) => { doc.gates.rules[1].code_ref = ''; }, 'Q0_APPROXIMATION_SIZE_NOT_DISCLOSED');
  refuses((doc) => { doc.gates.rules[0].status = 'PARTIAL'; }, 'Q0_RULE_STATUS_UNKNOWN', /QS-S1=PARTIAL/);
  refuses((doc) => { doc.gates.rules.push({ rule: 'QS-X9', status: 'NOT_IMPLEMENTED', code_ref: 'x.js:1' }); }, 'Q0_ENGINE_APPROXIMATION_NOT_DECLARED', /QS-X9/);
  refuses((doc) => { delete doc.verdict.engine_approximation.approximations; }, 'Q0_VERDICT_ENGINE_APPROXIMATION_MISSING');
  // §4.2 ★(a)：已知近似不算缺口——flag=false 的文件照常通过，结论不封顶
  assert.deepEqual(k3.validateWhole(result(), QS), []);
});

test('§11.7 结论与主数字同源：判据区间、笔数、G 区间任一与主数字行不等 → Q0_VERDICT_NOT_FROM_MAIN_ROW', () => {
  refuses((doc) => { doc.verdict.L_R = -0.11; }, 'Q0_VERDICT_NOT_FROM_MAIN_ROW', /L_R\/U_R/);
  refuses((doc) => { doc.verdict.n_trades = 119; }, 'Q0_VERDICT_NOT_FROM_MAIN_ROW', /n_trades/);
  refuses((doc) => { doc.stats.g_vs_btc.OOS.ci = [-0.4, 0.51]; }, 'Q0_VERDICT_NOT_FROM_MAIN_ROW', /stats\.g_vs_btc\.OOS\.ci/);
  refuses((doc) => { doc.stats.rows = doc.stats.rows.filter((row) => !(row.segment === 'OOS' && row.cost === 'BASE' && row.phase === 'PRODUCTION')); }, 'Q0_VERDICT_NOT_FROM_MAIN_ROW', /主数字行缺失/);
});

test('§11.7 supersedes：项无效或含本文件 sha → Q0_SUPERSEDES_INVALID', () => {
  refuses((doc) => { doc.identity.supersedes[0].state = 'REPLACED'; }, 'Q0_SUPERSEDES_INVALID');
  refuses((doc) => { doc.identity.supersedes[0].result_sha256 = 'abc'; }, 'Q0_SUPERSEDES_INVALID');
  refuses((doc) => { doc.identity.supersedes[0].reason_zh = ' '; }, 'Q0_SUPERSEDES_INVALID');
  refuses((doc) => { doc.identity.supersedes[0].result_sha256 = hex('this-file'); }, 'Q0_SUPERSEDES_INVALID');
  refuses((doc) => { doc.identity.supersedes = { state: 'SUPERSEDED' }; }, 'Q0_SUPERSEDES_INVALID');
});

test('§11.7 压力：缺场景行带数字 → 压力块无效；数字字段缺失 → 通过；SAME_AS_BASELINE 对不上参照或没有参照 → 无效', () => {
  const stressOf = (patch) => block(project(result(patch)), 'stress');
  const present = stressOf((doc) => { doc.stress.rows[3].max_loss_usd = 0; });
  assert.equal(present.state, 'NOT_BACKTESTED');
  assert.match(present.reason, /缺场景／无效输入行的数字必须是 null/);
  assert.equal(stressOf((doc) => { doc.stress.rows[3].max_loss_usd = null; }).state, 'AVAILABLE');
  const absent = stressOf();
  assert.equal(absent.state, 'AVAILABLE');
  assert.equal(absent.data.rows[3].kind, 'MISSING');
  assert.equal(absent.data.rows[3].reason, '合成夹具没有 1m 缓存');
  assert.match(stressOf((doc) => { doc.stress.rows[4].end_capital = 1500.01; }).reason, /end_capital 与参照行 BASELINE 不一致/);
  assert.match(stressOf((doc) => { doc.stress.rows.shift(); }).reason, /没有参照行 BASELINE/);
  // LEGACY_V1（US_V5）不认 SAME_AS_BASELINE：读法只对非 LEGACY 档案生效
  const legacy = k3.buildBlocks(result(), [], profiles.mustGet('US_V5_ETF_3000USD')).find((item) => item.key === 'stress');
  assert.equal(legacy.state, 'NOT_BACKTESTED');
});

test('§11.7 半凯利：floor_usd ≠ 600 或缺失、f*≤0 或 L_R≤0 而 f_half>0、缺第二个阈值 → 半凯利块无效', () => {
  const kellyOf = (patch) => block(project(result(patch)), 'kelly');
  assert.match(kellyOf((doc) => { doc.half_kelly.floor_usd = 500; }).reason, /floor_usd 不是 Rule 1b 的 600 USDT/);
  assert.match(kellyOf((doc) => { delete doc.half_kelly.floor_usd; }).reason, /缺 half_kelly\.floor_usd/);
  assert.match(kellyOf((doc) => { doc.half_kelly.f_half = 0.01; }).reason, /f_star ≤ 0 时 f_half 必须为 0/);
  assert.match(kellyOf((doc) => { doc.half_kelly.f_star = 0.05; doc.half_kelly.f_half = 0.01; }).reason, /L_R ≤ 0 时 f_half 必须为 0/);
  assert.match(kellyOf((doc) => { delete doc.half_kelly.replay.fixed_7_2.p_below_book_stop_750; }).reason, /fixed_7_2\.p_below_book_stop_750/);
  assert.match(kellyOf((doc) => { doc.half_kelly.replay.half_kelly.p_below_book_stop_750 = 1.2; }).reason, /不在 0–1/);
  const ok = kellyOf();
  assert.equal(ok.state, 'AVAILABLE');
  assert.equal(ok.data.fixed.resamples, 2000);
  assert.deepEqual(ok.data.fixed.thresholds.map((item) => [item.value, item.p]), [[600, 0.3], [750, 0.45]]);
});

test('§11.7 前向：in_verdict=true 或账本不是本策略 → 只有前向一行无效，结论不变', () => {
  const baseline = project(result());
  for (const patch of [(doc) => { doc.forward.in_verdict = true; }, (doc) => { doc.forward.ledger = 'C17_V2_4000USDT'; }]) {
    const projection = project(result(patch));
    const account = block(projection, 'account');
    assert.equal(account.state, 'AVAILABLE');
    assert.equal(account.data.forward.valid, false);
    assert.match(account.data.forward.text_zh, /^前向记录无效：/);
    assert.deepEqual(projection.conclusion, baseline.conclusion);
    assert.deepEqual(block(projection, 'verdict'), block(baseline, 'verdict'));
  }
  assert.equal(block(baseline, 'account').data.forward.text_zh,
    '前向记录（PAPER 账本 QUICK_SHOT_V3_1000USDT，只报不判，不进结论）：4 笔，净 −12.35 USDT，每笔均值 −0.43 R。');
});

test('§11.7 资金费排除：主数字行缺 excluded_funding_missing → 胜率块无效；其他行缺时空着', () => {
  const winrate = (patch) => block(project(result(patch)), 'winrate');
  const missing = winrate((doc) => { delete doc.stats.rows[1].excluded_funding_missing; delete doc.stats.rows[1].excluded_share; });
  assert.equal(missing.state, 'NOT_BACKTESTED');
  assert.match(missing.reason, /excluded_funding_missing（主数字行）/);
  const other = winrate((doc) => { delete doc.stats.rows[0].excluded_funding_missing; delete doc.stats.rows[0].excluded_share; });
  assert.equal(other.state, 'AVAILABLE');
  assert.equal(other.data.rows[0].funding_excluded, null);
});

test('§11.7 G3 不回归：SUPPORTED 且压力缺场景而无 STRESS_SCENARIO_MISSING → Q0_VERDICT_SUPPORTED_HIDES_INCOMPLETE_STRESS', () => {
  const supported = (doc, codes) => {
    doc.stats.rows[1].mean_R_ci = [0.15, 0.5];
    doc.verdict.L_R = 0.15; doc.verdict.L_g = 0.01; doc.stats.g_vs_btc.OOS.ci = [0.01, 0.5];
    doc.verdict.state = 'SUPPORTED'; doc.verdict.reason_codes = codes;
  };
  refuses((doc) => supported(doc, []), 'Q0_VERDICT_SUPPORTED_HIDES_INCOMPLETE_STRESS', /EXIT_GRANULARITY_1M/);
  assert.deepEqual(k3.validateWhole(result((doc) => supported(doc, ['STRESS_SCENARIO_MISSING'])), QS), []);
});

test('§8 导入：被同 case 已锁文件替代的文件拒绝（带不带 supersedes 都拒绝）；另一份文件按「一个 case 只锁一次」拒绝', () => {
  fs.rmSync(k3.LEDGER(), { force: true });
  const first = write(result((doc) => { doc.identity.supersedes[0].result_sha256 = hex('placeholder'); }));
  const replaced = write(result((doc) => { doc.identity.change_note_zh = '另一份内容，用来被替代'; delete doc.identity.supersedes; }));
  const second = write(result((doc) => { doc.identity.supersedes[0].result_sha256 = fileSha(replaced); }));
  const lock = k3.importBaselineEvaluation(second, { registeredBy: AUTHORITY, strategyRef: QS.strategy_ref, allowNonActual: true });
  assert.equal(lock.case_ref, CASE);
  assert.equal(lock.supersedes_ref, null);
  for (const supersedes of [null, lock.result_id]) {
    assert.throws(() => k3.importBaselineEvaluation(replaced, { registeredBy: AUTHORITY, strategyRef: QS.strategy_ref, allowNonActual: true, supersedes, defectRef: 'D', reason: 'R' }),
      (error) => error.code === 'Q0_RESULT_IS_SUPERSEDED');
  }
  assert.throws(() => k3.importBaselineEvaluation(first, { registeredBy: AUTHORITY, strategyRef: QS.strategy_ref, allowNonActual: true }),
    (error) => error.code === 'BASELINE_ALREADY_LOCKED');
  assert.equal(k3.importBaselineEvaluation(second, { registeredBy: AUTHORITY, strategyRef: QS.strategy_ref, allowNonActual: true }).replayHit, true);
  assert.equal(k3.locks(CASE).length, 1);
  fs.rmSync(k3.LEDGER(), { force: true });
});

// ── §11.8 档案校验器负例 ───────────────────────────────────────────────────────────

test('§11.8 档案校验器：LEGACY 带新项、非 LEGACY 缺 q0_reading、词不全、阈值与底线不等、共享约束含数字、生产者未登记，都拒绝', () => {
  const variant = (mutate) => {
    const doc = JSON.parse(JSON.stringify(PRODUCTION));
    mutate(doc.profiles[0], doc.profiles[1]);
    return () => profiles.validate(doc);
  };
  const rejects = (mutate, code, detail) => assert.throws(variant(mutate), (error) => {
    assert.equal(error.code, code);
    if (detail) assert.match(error.detail, detail);
    return true;
  });
  rejects((us, qs) => { us.q0_reading = qs.q0_reading; }, 'STRATEGY_PROFILE_FIELD_TYPE', /US_V5_ETF_3000USD\.q0_reading/);
  rejects((us, qs) => { us.shared_constraints = qs.shared_constraints; }, 'STRATEGY_PROFILE_FIELD_TYPE', /US_V5_ETF_3000USD\.shared_constraints/);
  rejects((us) => { us.m1_evidence.producer = 'US_V5_M1_PRODUCER_V1'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /US_V5_ETF_3000USD\.m1_evidence\.producer/);
  rejects((us, qs) => { delete qs.q0_reading; }, 'STRATEGY_PROFILE_FIELD_MISSING', /QUICK_SHOT_V3_1000USDT\.q0_reading$/);
  rejects((us, qs) => { delete qs.q0_reading.kelly; }, 'STRATEGY_PROFILE_FIELD_MISSING', /q0_reading\.kelly$/);
  rejects((us, qs) => { qs.q0_reading.main_row.cost = 'FEES_X3'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /main_row\.cost:FEES_X3/);
  rejects((us, qs) => { qs.q0_reading.main_row.phase = 'MINUS_60MIN'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /main_row\.phase/);
  rejects((us, qs) => { qs.q0_reading.kelly.thresholds[0].value = 750; }, 'STRATEGY_PROFILE_FIELD_TYPE', /thresholds\[0\]\.value/);
  rejects((us, qs) => { qs.q0_reading.kelly.thresholds[1].field = 'p_below_floor'; }, 'STRATEGY_PROFILE_DUPLICATE');
  rejects((us, qs) => { qs.q0_reading.kelly.thresholds[1].value = -1; }, 'STRATEGY_PROFILE_FIELD_TYPE', /thresholds\[1\]\.value/);
  rejects((us, qs) => { qs.shared_constraints[0].budget_l = 1600; }, 'STRATEGY_PROFILE_FIELD_TYPE', /shared_constraints\[0\]:no numbers/);
  rejects((us, qs) => { qs.shared_constraints[0].display_zh = '共享'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /display_zh/);
  rejects((us, qs) => { qs.m1_evidence.producer = 'QS_V9_M1_PRODUCER'; }, 'DIAGNOSTIC_PRODUCER_NOT_REGISTERED');
  // 生产者：LEGACY 默认 US 生产者；非 LEGACY 不写 → 失败关闭
  assert.equal(producers.resolve(undefined, { legacy: true }).id, 'US_V5_M1_PRODUCER_V1');
  assert.throws(() => producers.resolve(undefined, { legacy: false }), (error) => error.code === 'DIAGNOSTIC_PRODUCER_NOT_REGISTERED');
});

// ── §11.9 M1 成本模型 ─────────────────────────────────────────────────────────────

const MODEL = JSON.parse(fs.readFileSync(path.join(ROOT, QS.m1_evidence.manifest_ref), 'utf8')).cost_model;
function trade(overrides = {}) {
  const base = {
    id: 1, symbol: 'AAAUSDT', trade_type: 'LONG', notional: 240, quantity: 2400, entry_price: 0.1, exit_price: 0.097, margin_used: 10, liquidation_capped: 0,
    fee_entry_usdt: 0.096, fee_exit_usdt: 0.096, slippage_entry_usdt: 0.096, slippage_exit_usdt: 0.144, funding_usdt: 0.024,
    funding_state: 'MEASURED', funding_settlements: 2, gross_pnl: -7.2, status: 'CLOSED',
    detail: { signal: { quote24h: 500000000 }, exit: { slippagePerSide: 0.0006, fundingSettlements: [{ fundingRate: 0.00005 }, { fundingRate: 0.00005 }] } },
  };
  const row = { ...base, ...overrides };
  row.net_pnl = overrides.net_pnl !== undefined ? overrides.net_pnl
    : row.gross_pnl - row.fee_entry_usdt - row.fee_exit_usdt - row.slippage_entry_usdt - row.slippage_exit_usdt - (row.funding_usdt || 0);
  row.net_r = overrides.net_r !== undefined ? overrides.net_r : row.net_pnl / 7.2;
  return row;
}

test('§11.9 成本模型（合成）：三档滑点、资金费缺失为 null 不是 0、任一项超容差 → CRYPTO_M1_COST_MISMATCH；US 成本模型文件不变', () => {
  const model = costModels.resolve('CRYPTO_M1_RESEARCH_COST_V1');
  assert.deepEqual([2e9, 5e8, 1e8].map((quote) => model.slippageTier(quote, MODEL.slippage_tiers)), [0.0002, 0.0004, 0.0006]);
  const items = model.reconcileTrade(trade(), MODEL);
  assert.equal(items.slippage_entry.tier_rate, 0.0004);
  assert.equal(items.funding.state, 'MEASURED');
  assert.equal(items.slippage_exit.state, 'RECORDED_TIER_NOT_REDERIVED');
  // 空头：资金费号反向（收入为负）；强平封顶：毛亏损 = −保证金
  assert.equal(model.reconcileTrade(trade({ trade_type: 'SHORT', exit_price: 0.103, funding_usdt: -0.024 }), MODEL).funding.state, 'MEASURED');
  assert.equal(model.reconcileTrade(trade({ liquidation_capped: 1, exit_price: 0.05, gross_pnl: -10 }), MODEL).gross.state, 'RULE_CHECKED_LIQUIDATION_CAP');
  const missing = model.reconcileTrade(trade({ funding_state: 'FUNDING_MISSING', funding_usdt: null, net_pnl: -7.632 }), MODEL);
  assert.equal(missing.funding.state, 'MISSING');
  assert.equal(missing.funding.recorded, null);
  assert.notEqual(missing.funding.recorded, 0);
  assert.equal(missing.net.state, 'NOT_CHECKED_FUNDING_MISSING');
  const mismatch = (overrides, item) => assert.throws(() => model.reconcileTrade(trade(overrides), MODEL),
    (error) => error.code === 'CRYPTO_M1_COST_MISMATCH' && error.item === item && error.trade_id === 1);
  mismatch({ fee_entry_usdt: 0.097 }, 'fee_entry_usdt');
  mismatch({ slippage_entry_usdt: 0.144 }, 'slippage_entry_usdt');
  mismatch({ funding_usdt: 0.025 }, 'funding_usdt');
  mismatch({ funding_settlements: 3 }, 'funding_settlements');
  mismatch({ gross_pnl: -7.3, net_pnl: -7.656 }, 'gross_pnl');
  mismatch({ net_pnl: -7.6 }, 'net_pnl');
  mismatch({ net_r: -1.2 }, 'net_r');
  assert.deepEqual(model.accountEquation([trade(), trade({ id: 2 })], MODEL, 1000 + 2 * trade().net_pnl).residual, 0);
  assert.throws(() => model.accountEquation([trade()], MODEL, 990), (error) => error.code === 'CRYPTO_M1_COST_MISMATCH' && error.item === 'account_end');
  const us = fs.readFileSync(path.join(ROOT, 'services/strategy-diagnostics/cost_models/US_V5_M1_RESEARCH_COST_V1.js'));
  assert.equal(require('node:crypto').createHash('sha256').update(us).digest('hex'), '7b6bb96e390aa0cecbf502bf2d0a284b0dd0b08e4556a584c70b4a86bcd7ba00');
});

test('§11.9 真实 M1 包：10 笔逐项 ≤ 1e-6，账户终点 949.4090992，决策追踪 1000RATSUSDT → TARGET +2.60 R', { skip: fs.existsSync(path.join(REAL_M1, 'm1-manifest.json')) ? false : 'M1 包不在本机（QRP_QS_M1_REAL_DIR）；跳过不算通过' }, () => {
  const diagnostic = diagnostics.buildDiagnostic({ strategyRef: QS.strategy_ref, root: REAL_M1 });
  assert.equal(diagnostic.state, 'VERIFIED');
  assert.equal(diagnostic.case_ref, CASE);
  assert.equal(diagnostic.producer, 'QS_V3_M1_PRODUCER_V1');
  assert.equal(diagnostic.trades.length, 10);
  for (const row of diagnostic.trades) for (const item of Object.values(row.items)) if (item.residual !== null) assert.ok(Math.abs(item.residual) <= 1e-6);
  assert.ok(Math.abs(diagnostic.account.end - 949.4090992) <= 1e-6);
  assert.ok(Math.abs(diagnostic.account.sum_net_pnl - -50.5909008) <= 1e-6);
  assert.deepEqual([diagnostic.funding.measured, diagnostic.funding.missing, diagnostic.account.open_positions], [10, 0, 0]);
  assert.deepEqual([diagnostic.traced_decision.symbol, diagnostic.traced_decision.exit.reason, diagnostic.traced_decision.result.net_r], ['1000RATSUSDT', 'TARGET', 2.6]);
  assert.equal(diagnostic.package.source_manifest_sha256, '7c342a05db9959092d0a06b491060ffbf11472cb3b5c80a062940ccbbd40e080');
  assert.doesNotMatch(JSON.stringify(diagnostic.shared_constraints), /\d{3,}/); // A19 只写状态与引用，不带预算数字
  // 输入包没有拷进 var/evidence 时失败关闭，不用零值补
  assert.equal(diagnostics.readDiagnostic({ strategyRef: QS.strategy_ref, root: path.join(REAL_M1, 'not-copied') }).state, 'MISSING');
  assert.equal(diagnostics.readDiagnostic({ strategyRef: QS.strategy_ref, root: path.join(REAL_M1, 'db') }).reason_code, 'QS_V3_M1_INPUT_PACKAGE_FILES_MISMATCH');
});

// ── §11.3 / §11.4 / §11.5 / §11.6 真实文件 ──────────────────────────────────────────

test('§11.3 真实文件导入（临时账本）：result_id、case、三态、摘要；重复导入幂等；第一次运行与无审计封存各被拒绝', { skip: SKIP_REAL }, () => {
  fs.rmSync(k3.LEDGER(), { force: true });
  const lock = k3.importBaselineEvaluation(REAL, { registeredBy: AUTHORITY, strategyRef: QS.strategy_ref });
  assert.equal(lock.result_id, 'Q0-bd83dd6ec1754dbc');
  assert.equal(lock.strategy_ref, 'QUICK_SHOT_V3_1000USDT');
  assert.equal(lock.case_ref, 'RRC-QUICK-SHOT-V3-1000USDT-V8-1-M0');
  assert.equal(lock.verdict_state, 'INSUFFICIENT');
  assert.equal(lock.file_sha256, 'bd83dd6ec1754dbc0b3338aefd826f29aa4f885afc05dced80ae4c826bdbfd45');
  assert.equal(lock.inputs_digest, '195b9e9c5650e9d855dfaf73afdfa7cf8a92b7a32eedfe9af7d932adb38b0d30');
  assert.equal(lock.engine_digest, 'e01fc4491660ee672edb4dc7961d280371294eb8d90179823505fa50f653d3b1');
  assert.equal(lock.supersedes_ref, null);
  assert.equal(k3.importBaselineEvaluation(REAL, { registeredBy: AUTHORITY, strategyRef: QS.strategy_ref }).replayHit, true);
  for (const supersedes of [null, lock.result_id]) {
    assert.throws(() => k3.importBaselineEvaluation(REAL_SUPERSEDED_1, { registeredBy: AUTHORITY, strategyRef: QS.strategy_ref, supersedes, defectRef: 'D', reason: 'R' }),
      (error) => error.code === 'Q0_RESULT_IS_SUPERSEDED');
  }
  assert.throws(() => k3.importBaselineEvaluation(REAL_NO_AUDIT, { registeredBy: AUTHORITY, strategyRef: QS.strategy_ref }),
    (error) => error.code === 'BASELINE_ALREADY_LOCKED' && error.detail === 'Q0-bd83dd6ec1754dbc');
  assert.equal(k3.locks(CASE).length, 1);
});

test('§11.4–§11.6 真实文件的页面（全部展开）：逐字断言、QS 页不含 US 的词与数字、US 页不含 QS 的数字、D5 计数', { skip: SKIP_PAGE }, async () => {
  const model = await realModel();
  const detail = model.views['strategy-detail'];
  assert.equal(detail.backtest.state, 'LOCKED_VERIFIED');
  assert.equal(detail.currency, 'USDT');
  // 修订 7 J2：整页断言读「全部展开」视图
  const html = await renderPage(model, `${QS_DETAIL}&section=all`);
  const text = textOf(html);
  const has = (needle) => assert.ok(text.includes(needle), `页面缺：${needle}`);
  // §3.2 主数字与资金费排除行
  has('样本外每笔扣费后净 R 均值（基础成本，h+1 开盘成交；门槛 +0.10 R）：+0.19 R（95% 区间 −0.15 R 至 +0.52 R）');
  has('主统计不计资金费缺失的 13 笔（占 1.5%，R-FUND (a)）');
  // §3.4 判定依据三行与最大的限制
  has('每笔扣费后净 R 均值 +0.19 R，95% 区间 −0.15 R 至 +0.52 R，区间跨过门槛 +0.10 R');
  has('相对 BTC 买入持有的账户年化对数增长差 95% 区间 −70.2% 至 79.2%，区间跨过门槛 0');
  has('门槛在看到结果前已冻结');
  has('另须知道：样本外复用：2024-01-01 起的同一缓存已被调参研究 V1 用于选出 V3 参数');
  has('最大的限制：每笔扣费后净 R 均值、相对 BTC 买入持有的账户年化对数增长差的 95% 区间跨过判定门槛，现有样本不足以判定。');
  // §5.3 三行
  has('优势结论：证据不足');
  has('压力评价不完整：缺场景 1 个、无效输入 0 个（出场粒度 1m 对 1h：缺场景）');
  has('采用条件：未满足（必要压力缺失，§6.7）');
  has('缺场景：1m 缓存（/root/c17-swap-v1）不在冻结裁定 2 允许拷贝的输入范围内；A0 窗口里 1h 读法 8/9 出场原因相同（JCTUSDT：1h 读成 GAP，生产为 STOP）');
  // §5.2 最大损失；§5.4 计数行；§5.6 排除列
  has('最大损失：698.67 USDT（场景：晚一小时成交（h+2 开盘））');
  has('已执行 9 个压力场景（另有 1 个与当前 D 参照相同），模拟或补充 0 个，缺场景 1 个，无效输入 0 个；另有当前 D 参照 1 行、风控维度 4 行（只报不判，不进最大损失）。缺场景和无效输入不计为已执行的压力。');
  has('13 笔（1.5%）');
  has('1 笔（0.3%）');
  has('7.68 USDT');
  // §6.2 两张卡
  has('不支持按凯利加仓：区间下沿的半凯利比例为 0');
  has('按半凯利定仓期末资本区间1,000 USDT 至 1,000 USDT最大回撤0.0%跌破 600 USDT（Rule 1b 40% 线）的概率0.0%跌破 750 USDT（25% 账本止损线）的概率0.0%半凯利 = 0：不支持按凯利加仓');
  has('按现行固定每笔 7.2 USDT 风险重抽样路径，不是预测 · 重抽 10,000 条路径期末资本区间170 USDT 至 4,701 USDT最大回撤22.1%跌破 600 USDT（Rule 1b 40% 线）的概率31.4%跌破 750 USDT（25% 账本止损线）的概率49.7%');
  has('研究计算，不是仓位建议；现行仓位规则不变。底线：Rule 1b 的 600 USDT（1,000 USDT 的 40% 线）；另报 750 USDT（25% 账本止损线）。');
  // §7.2 两句
  has('前向记录（PAPER 账本 QUICK_SHOT_V3_1000USDT，只报不判，不进结论）：10 笔，净 −50.59 USDT，每笔均值 −0.70 R。');
  // 增补 2 D6：QS 的 HK 前向影子（从纸面账本推出）已登记，§7.2 那句的后半句换成 HK 运行句（Q0 前向记录半句保留）
  has('Q0 结果文件里带有前向记录 10 笔（只报不判）；HK 上已在跑 1 条前向影子（1 条尚未导入）。');
  // §8 SUPERSEDED 一行；§10 A19 一行；§4.3 引擎标签与规则清单
  has('已替代的第一次运行（SUPERSEDED，不是结果）：代码 3bcde85f，结果文件 50b3b14f…');
  assert.doesNotMatch(html, /Q0-50b3b14f/);
  has('A19 共享亏损预算：与 C17_V2 共享，未复算（规则 QS-C5）');
  has('当前 D（引擎对齐关卡 A0 通过；长历史已知近似 6 条，见规则清单）');
  has('规则清单（已实现 18 · 已知近似 6 · 不适用 3）');
  has('引擎对齐关卡 A0：通过');
  has('逐笔记录 869 行');
  // §11.5 QS 页不得出现 US 的词与数字
  for (const word of US_WORDS) assert.ok(!text.includes(word), `QS 页面不得出现：${word}`);
  // §11.6 UX 修订 4 D5
  const main = withoutDetails(html);
  for (const code of Object.keys(k3.internals.REASON_WORDS)) assert.ok(!main.includes(code), `主内容不得出现英文原因码 ${code}`);
  assert.match(html, /<section class="conclusion warn" data-state="INSUFFICIENT"[\s\S]*?判定依据/);
  const reread = (html.match(/页面不重算/g) || []).length;
  assert.equal(reread, (html.match(/数字取自已锁定的结果文件与采用记录，页面不重算/g) || []).length + 1, '回测与研究区一次，另加总览页签的来源行');
  assert.equal((html.match(/class="completeness"/g) || []).length, 1);

  // US_V5 页面（全部展开）不得出现 QS 的数字或 USDT
  const us = await realModel('US_V5_ETF_3000USD');
  const usHtml = await renderPage(us, '#strategy-detail?strategy=US_V5_ETF_3000USD&section=all');
  for (const word of QS_NUMBERS) assert.ok(!usHtml.includes(word), `US_V5 页面不得出现：${word}`);
});

test('修订 7 在 QS 页上：默认「总览」——一句话结论与数字卡取自 QS 的 Q0 锁，比较对象是 BTC 买入持有；页签只渲染自己；US 总览不含 QS 数字', { skip: SKIP_PAGE }, async () => {
  const model = await realModel();
  const summary = model.views['strategy-detail'].summary;
  assert.equal(summary.sentence_zh, '现行版本样本外期末 2,102，高于 BTC 买入持有的 1,911（证据不足）');
  assert.deepEqual(summary.tiles.map((tile) => tile.key), ['end_capital', 'max_drawdown', 'winrate', 'half_kelly', 'underwater']);
  const tile = (key) => summary.tiles.find((item) => item.key === key);
  assert.equal(tile('end_capital').comparator_label, 'BTC 买入持有');
  assert.deepEqual([tile('end_capital').own, tile('end_capital').comparator], [2101.61386385, 1910.56624285]);
  assert.equal(tile('winrate').row_zh, '样本外 · 基础成本 · h+1 开盘成交');
  assert.deepEqual([tile('winrate').win_rate, tile('winrate').payoff, tile('winrate').n], [0.34152047, 2.45731769, 855]);
  assert.deepEqual([tile('half_kelly').f_half, tile('half_kelly').supported], [0, false]);
  const html = await renderPage(model, QS_DETAIL);
  const text = textOf(html);
  assert.equal((html.match(/class="section detail-section"/g) || []).length, 1);
  assert.match(html, /id="detail-overview"/);
  for (const needle of ['现行版本样本外期末 2,102，高于 BTC 买入持有的 1,911（证据不足）', '2,102 USDT', 'BTC 买入持有 1,911 USDT；2024-01-01 至 2026-10-24',
    '22.1%', 'BTC 买入持有 53.0%', '34.2% · 2.46', '样本外 · 基础成本 · h+1 开盘成交，855 笔', '不支持按凯利加仓（区间下沿为 0）', '358 个 session']) {
    assert.ok(text.includes(needle), `总览缺：${needle}`);
  }
  for (const word of [...US_WORDS, 'bps', 'undefined', 'NaN']) assert.ok(!text.includes(word), `QS 总览不得出现：${word}`);
  // J2：每个页签只渲染自己
  for (const section of ['runtime', 'health', 'research', 'forward', 'review']) {
    const tab = await renderPage(model, `${QS_DETAIL}&section=${section}`);
    assert.equal((tab.match(/class="section detail-section"/g) || []).length, 1, section);
    assert.match(tab, new RegExp(`id="detail-${section}"`));
    for (const word of US_WORDS) assert.ok(!textOf(tab).includes(word), `QS ${section} 页签不得出现：${word}`);
  }
  const usHtml = await renderPage(await realModel('US_V5_ETF_3000USD'), '#strategy-detail?strategy=US_V5_ETF_3000USD');
  assert.match(usHtml, /id="detail-overview"/);
  for (const word of QS_NUMBERS) assert.ok(!usHtml.includes(word), `US_V5 总览不得出现：${word}`);
});

// 修订 7 J5.1 在 QS 页上（真浏览器、真实数据）：1280 × 800 下总览 ≤ 1,600 px；390 px 宽下各页签没有整页横向滚动
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

test('修订 7 J5.1 在 QS 页上：1280 × 800 下总览 ≤ 1,600 px；390 px 宽下总览与各页签都没有整页横向滚动（真实 Q0 锁）', { skip: SKIP_BROWSER, timeout: 300000 }, async () => {
  const model = await realModel();
  const page = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'));
  const routes = [[QS_DETAIL, 1280], ...['', '&section=runtime', '&section=health', '&section=research', '&section=forward', '&section=review', '&section=all'].map((extra) => [`${QS_DETAIL}${extra}`, 390])];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__probe')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PROBE(routes)); return; }
    if (req.url.startsWith('/api/workspace')) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(model)); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-qs-chrome-'));
  try {
    const stdout = await new Promise((resolve) => {
      const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        `--user-data-dir=${profile}`, '--virtual-time-budget=60000', '--dump-dom', `http://127.0.0.1:${server.address().port}/__probe`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = ''; child.stdout.on('data', (chunk) => { out += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      child.on('close', () => { clearTimeout(timer); resolve(out); });
    });
    const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(stdout);
    assert.ok(match && match[1] !== 'PENDING', '探针页没有跑完');
    const rows = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    assert.equal(rows.length, routes.length);
    // QS 的前向、复盘页签只有一两句（没有 HK 前向影子、没有 Desk 往返），渲染门槛按页头加一句算
    for (const row of rows) assert.ok(row.sections >= 1 && row.text > 80, `${row.route} @${row.width} 没有渲染出页面（${row.text} 字）`);
    assert.ok(rows[0].height <= 1600, `QS 总览 @1280：${rows[0].height} px > 1,600`);
    for (const row of rows.filter((item) => item.width === 390)) assert.ok(row.scrollWidth <= row.clientWidth, `${row.route} @390：整页横向宽度 ${row.scrollWidth} > ${row.clientWidth}`);
    console.log(`QS J5.1: overview@1280 height=${rows[0].height}; 390: ${rows.slice(1).map((row) => `${row.route.split('&section=')[1] || 'overview'} ${row.scrollWidth}/${row.clientWidth}`).join(', ')}`);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});
