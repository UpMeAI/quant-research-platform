'use strict';
/**
 * QRP_MULTI_STRATEGY_PROFILE_REGISTRY_ACCEPTANCE_V1 D3：
 *   - 测试档案（tests/fixtures，USDT、BTC_BUY_HOLD + CASH）的导入、诊断、渲染都按它自己的值走；
 *   - 未登记的 strategy_ref：导入拒绝且账本、证据目录不写（R3.1），页面写「该策略尚未接入研究」（R3.2）；
 *   - 注册表校验的负例：字段缺失或类型不符给出原因码，进程不继续（R1.3）。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'strategy_profile.fixture_crypto_usdt.json'), 'utf8'));
delete FIXTURE._comment;
const PRODUCTION = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'strategy_profiles.v1.json'), 'utf8'));
const AUTHORITY = 'STRATEGY_PROFILE_TEST_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

// 一个只登记测试策略和一条没有档案的加密策略的 Desk 目录（页面要先在 Desk 目录里找到策略）
const DESK = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-profile-desk-'));
fs.mkdirSync(path.join(DESK, 'src', 'panel'), { recursive: true });
fs.writeFileSync(path.join(DESK, 'src', 'operation-review.js'),
  "module.exports = { OPERATION_REVIEW_BOOKS: { CRYPTO: { FIXTURE_CRYPTO_USDT: 'PAPER', C17_V2_4000USDT: 'PAPER' } } };\n");
fs.writeFileSync(path.join(DESK, 'src', 'panel', 'read-model.js'), [
  'module.exports = { EFFECTIVE_FROM: {}, CLOSED_BOOKS: {}, closedBook: () => false, runOffBook: () => false,',
  "  notYetEffective: () => false, bookLifecycle: () => ({ state: 'OPEN' }) };", ''].join('\n'));
fs.writeFileSync(path.join(DESK, 'src', 'panel', 'glossary.js'),
  "module.exports = { explain: (ref) => ({ FIXTURE_CRYPTO_USDT: '测试加密账本（600 USDT 底线）', C17_V2_4000USDT: '加密 C17 账本' })[ref] || ref };\n");
process.env.QRP_DESK_ROOT = DESK;

const profiles = require('../services/strategy-profiles');
const k3 = require('../services/baseline-evaluation');
const comparison = require('../services/candidate-comparison');
const diagnostics = require('../services/strategy-diagnostics');
const costModels = require('../services/strategy-diagnostics/cost_models');
const hkForward = require('../services/hk-forward-observations');
const loop = require('../services/runtime-research-loop');
const workspace = require('../services/research-workspace');
const { result, write } = require('./_q0_fixture');

const PAGE = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
const withFixture = () => profiles.validate({ ...PRODUCTION, profiles: [...PRODUCTION.profiles, FIXTURE] });
profiles.use(withFixture());

/** 测试档案的 Q0 结果：同一套结构，换成 BTC_BUY_HOLD、USDT 底线和测试 schema，去掉 US_V5 的字样。 */
function fixtureResult(patch = (doc) => doc) {
  return result((doc) => {
    doc.identity.schema = FIXTURE.baseline_result_schema;
    doc.arms.BTC_BUY_HOLD = doc.arms.SPY_BUY_HOLD;
    delete doc.arms.SPY_BUY_HOLD;
    doc.verdict.comparators = ['BTC_BUY_HOLD', 'CASH'];
    delete doc.half_kelly.floor_usd;
    doc.half_kelly.floor = FIXTURE.floor.value;
    doc.stress.rows[2].label = '规则边界情景：合成的 BTC 序列；模拟序列，不是可交易历史';
    doc.diagnosis_items = [{ id: 'DX1', source: 'ENTRY_EXIT', facts: ['资金费为负的小时里开仓更多'], proposed_experiment: 'Q1', no_topic_reason: null }];
    return patch(doc);
  });
}

/** 列出目录下的全部文件（不存在时为空）。 */
function listing(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

/** 在没有 DOM 的 vm 里运行页面脚本本身，取回 #workspace 的 HTML（同 research_web_render.test.js）。 */
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

// US_V5 的值（以及测试档案的值）不得出现在别的策略的页面上（R3.3）
const US_V5_VALUES = [/SPY/, /1,800/, /US\$/, /US_V5/, /RRC-US-V5/, /美元/];

test('生产注册表：只有 US_V5 一项，值与改造前代码一致；测试档案不在生产注册表里', () => {
  const live = profiles.load();
  assert.deepEqual(live.profiles.map((item) => item.strategy_ref), ['US_V5_ETF_3000USD']);
  const us = live.profiles[0];
  assert.equal(us.case_ref, 'RRC-US-V5-3000-V8-1-M0');
  assert.equal(us.currency, 'USD');
  assert.deepEqual(us.comparators.map((item) => [item.key, item.label_zh]), [['SPY_BUY_HOLD', 'SPY 买入持有'], ['CASH', '现金']]);
  assert.deepEqual(us.floor, { value: 1800, currency: 'USD', rule_label_zh: 'Rule 1b 的 1,800' });
  assert.equal(us.cost_model_id, 'US_V5_M1_RESEARCH_COST_V1');
  assert.equal(us.baseline_result_schema, 'US_V5_M2_Q0_RESULT_V1');
  assert.deepEqual(us.phase_words, { PRODUCTION: '生产相位', PLUS_60MIN: '相位 +60 分钟', MINUS_60MIN: '相位 −60 分钟' });
  assert.deepEqual(us.segment_words, { 'IS-a': '开发期 A', 'IS-b': '开发期 B', OOS: '样本外' });
  assert.doesNotMatch(fs.readFileSync(profiles.FILE, 'utf8'), /FIXTURE/);
  assert.equal(costModels.resolve(us.cost_model_id).MODEL_ID, 'US_V5_M1_RESEARCH_COST_V1');
});

test('R1.3 注册表校验负例：缺字段、类型不符、币种不支持、底线币种不符、比较对象角色、重复、默认未登记，各有原因码', () => {
  const variant = (mutate) => {
    const doc = JSON.parse(JSON.stringify({ ...PRODUCTION, profiles: [...PRODUCTION.profiles, FIXTURE] }));
    mutate(doc, doc.profiles[1]);
    return () => profiles.validate(doc);
  };
  const refuses = (mutate, code, detail) => assert.throws(variant(mutate), (error) => {
    assert.equal(error.code, code);
    if (detail) assert.match(error.detail, detail);
    return true;
  });
  refuses((doc, fx) => { delete fx.currency; }, 'STRATEGY_PROFILE_FIELD_MISSING', /^FIXTURE_CRYPTO_USDT\.currency$/);
  refuses((doc, fx) => { delete fx.case_ref; }, 'STRATEGY_PROFILE_FIELD_MISSING', /case_ref/);
  refuses((doc, fx) => { delete fx.m1_evidence.manifest_ref; }, 'STRATEGY_PROFILE_FIELD_MISSING', /m1_evidence\.manifest_ref/);
  refuses((doc, fx) => { delete fx.research_program.default_question; }, 'STRATEGY_PROFILE_FIELD_MISSING', /default_question/);
  refuses((doc, fx) => { fx.comparators = 'BTC_BUY_HOLD'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /comparators:array/);
  refuses((doc, fx) => { fx.floor.value = '600'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /floor\.value/);
  refuses((doc, fx) => { fx.phase_words.PRODUCTION = 7; }, 'STRATEGY_PROFILE_FIELD_TYPE', /phase_words\.PRODUCTION/);
  refuses((doc, fx) => { fx.m1_evidence.manifest_sha256 = 'abc'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /manifest_sha256/);
  refuses((doc, fx) => { fx.currency = 'EUR'; fx.floor.currency = 'EUR'; }, 'STRATEGY_PROFILE_CURRENCY_UNSUPPORTED');
  refuses((doc, fx) => { fx.floor.currency = 'USD'; }, 'STRATEGY_PROFILE_FLOOR_CURRENCY_MISMATCH');
  refuses((doc, fx) => { fx.comparators[1].role = 'MARKET'; }, 'STRATEGY_PROFILE_COMPARATOR_ROLES');
  refuses((doc, fx) => { fx.strategy_ref = 'US_V5_ETF_3000USD'; }, 'STRATEGY_PROFILE_DUPLICATE', /strategy_ref/);
  refuses((doc, fx) => { fx.case_ref = doc.profiles[0].case_ref; }, 'STRATEGY_PROFILE_DUPLICATE', /case_ref/);
  refuses((doc, fx) => { fx.comparison_import_profile_ids = [doc.profiles[0].comparison_import_profile_ids[0]]; }, 'STRATEGY_PROFILE_DUPLICATE', /comparison_import_profile_id/);
  refuses((doc) => { doc.default_strategy_ref = 'NOT_REGISTERED'; }, 'STRATEGY_PROFILE_DEFAULT_NOT_REGISTERED');
  refuses((doc) => { doc.contract = 'OTHER'; }, 'STRATEGY_PROFILES_CONTRACT_INVALID');
  refuses((doc, fx) => { fx.projection_shape = 'V0'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /projection_shape/);
});

test('R1.3 校验失败时进程不继续：注册表缺字段，Research API 模块加载即失败并给出原因码', () => {
  const file = path.join(ROOT, 'config', 'strategy_profiles.v1.json');
  const broken = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete broken.profiles[0].currency;
  const script = `
    const fs = require('fs'); const real = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) { return p === ${JSON.stringify(file)} ? ${JSON.stringify(JSON.stringify(broken))} : real.call(this, p, ...rest); };
    require(${JSON.stringify(path.join(ROOT, 'apps', 'research-api', 'index.js'))});
    console.log('API_LOADED');`;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env } });
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout, /API_LOADED/);
  assert.match(run.stderr, /STRATEGY_PROFILE_FIELD_MISSING:US_V5_ETF_3000USD\.currency/);
});

test('测试档案的导入：按结果 schema 找到 FIXTURE_CRYPTO_USDT，锁上的 case、策略、计划都是它自己的', () => {
  fs.rmSync(k3.LEDGER(), { force: true });
  const file = write(fixtureResult());
  const lock = k3.importBaselineEvaluation(file, { registeredBy: AUTHORITY, allowNonActual: true });
  assert.equal(lock.strategy_ref, 'FIXTURE_CRYPTO_USDT');
  assert.equal(lock.case_ref, 'RRC-FIXTURE-CRYPTO-USDT');
  assert.equal(lock.plan_ref, FIXTURE.research_program.plan_ref);
  // 显式给 strategyRef 是同一份锁（幂等重放）
  assert.equal(k3.importBaselineEvaluation(file, { registeredBy: AUTHORITY, strategyRef: 'FIXTURE_CRYPTO_USDT', allowNonActual: true }).replayHit, true);
  // 用 US_V5 的比较对象写的文件在测试档案下被拒绝
  const spy = write(fixtureResult((doc) => { doc.verdict.comparators = ['SPY_BUY_HOLD', 'CASH']; }));
  assert.throws(() => k3.importBaselineEvaluation(spy, { registeredBy: AUTHORITY, strategyRef: 'FIXTURE_CRYPTO_USDT', allowNonActual: true }),
    (error) => error.code === 'Q0_VERDICT_COMPARATORS_CHANGED');

  const projection = k3.buildProjection(k3.headLock('RRC-FIXTURE-CRYPTO-USDT'), { allowNonActual: true });
  assert.equal(projection.state, 'LOCKED_VERIFIED');
  const block = (key) => projection.blocks.find((item) => item.key === key).data;
  assert.deepEqual(block('account').arms.map((arm) => arm.label), ['本策略', 'BTC 买入持有', '现金']);
  assert.deepEqual(block('kelly').floor, { value: 600, currency: 'USDT', rule_label_zh: '测试档案的 600 USDT 底线' });
  assert.equal(block('kelly').floor_usd, undefined);
  assert.deepEqual(block('period').segments.map((item) => item.label), ['开发期甲', '开发期乙', '测试样本外']);
  assert.ok(block('winrate').rows.some((row) => row.phase_label === '收盘小时相位'));
  assert.deepEqual(block('verdict').comparators, ['BTC 买入持有', '现金']);
  assert.match(block('verdict').criteria.find((row) => row.key === 'G').label, /^相对 BTC 买入持有的年化对数增长差/);
  assert.equal(projection.diagnosis.items[0].experiment.title, '测试题：资金费过滤');
  assert.equal(projection.source.plan_ref, FIXTURE.research_program.plan_ref);
  const json = JSON.stringify(projection);
  for (const pattern of [/SPY/, /1800/, /US_V5/, /RRC-US-V5/]) assert.doesNotMatch(json, pattern);
});

test('测试档案的诊断：按它自己的档案取证据与成本模型；成本模型没有模块时失败关闭，不借用 US_V5 的', () => {
  assert.throws(() => costModels.resolve(FIXTURE.cost_model_id), (error) => error.code === 'DIAGNOSTIC_COST_MODEL_NOT_REGISTERED');
  const diagnostic = diagnostics.readDiagnostic({ strategyRef: 'FIXTURE_CRYPTO_USDT' });
  assert.equal(diagnostic.state, 'INVALID');
  assert.equal(diagnostic.reason_code, 'DIAGNOSTIC_COST_MODEL_NOT_REGISTERED');
  assert.equal(diagnostic.strategy_ref, 'FIXTURE_CRYPTO_USDT');
  assert.equal(diagnostic.schema, 'FIXTURE_CRYPTO_M1_STRATEGY_DIAGNOSTIC_V1');
  assert.doesNotMatch(JSON.stringify(diagnostic), /US_V5_ETF|RRC-US-V5|SPY/);
  // 未登记的策略：不建诊断
  const unknown = diagnostics.readDiagnostic({ strategyRef: 'NOT_REGISTERED_STRATEGY' });
  assert.equal(unknown.reason_code, 'STRATEGY_PROFILE_NOT_REGISTERED');
  assert.equal(unknown.strategy_ref, 'NOT_REGISTERED_STRATEGY');
  assert.equal(unknown.schema, null);
  // 前向观察：测试档案没有自己的那一组；未登记策略读不到任何一组（US_V5 的条目不会挂到别的策略下）
  assert.deepEqual(hkForward.forStrategy('FIXTURE_CRYPTO_USDT').items, []);
  assert.equal(hkForward.forStrategy('US_V5_ETF_6000USD').state, 'NOT_REGISTERED');
  assert.equal(hkForward.forStrategy('US_V5_ETF_3000USD').items.length, 2);
});

test('测试档案的渲染：策略详情按 strategy 参数取测试档案，金额写 USDT、比较对象写 BTC，没有 US_V5 的值', async () => {
  loop.openCase({
    case_id: 'RRC-FIXTURE-CRYPTO-USDT', strategy_ref: 'FIXTURE_CRYPTO_USDT', market: 'CRYPTO',
    runtime_lane: { source_ref: 'FIXTURE:SCAN', source_hash: 'a'.repeat(64), version_ref: 'FIXTURE@1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
    baseline: {
      baseline_id: 'BASELINE-FIXTURE-CRYPTO', strategy_ref: 'FIXTURE_CRYPTO_USDT', market: 'CRYPTO', version_ref: 'FIXTURE@0',
      source_ref: 'FIXTURE:BASELINE', source_hash: 'b'.repeat(64), expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
      frozen_at: '2026-10-24T20:01:00Z',
    },
    cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
    data_quality: { status: 'VALID', as_of: '2026-10-23', known_at: '2026-10-24T20:00:00Z', source_refs: ['FIXTURE:SCAN'], freshness: { state: 'CURRENT', age_seconds: 0 } },
    isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
    opened_at: '2026-10-24T20:02:00Z',
  });
  // 测试文件的路径带 fixture 字样，页面读取时按「非实际来源」拒绝；这里把显式放行后的投影交给工作台（同其他页面测试）
  const baseline = k3.buildProjection(k3.headLock('RRC-FIXTURE-CRYPTO-USDT'), { allowNonActual: true });
  const model = await workspace.readModel({ strategyRef: 'FIXTURE_CRYPTO_USDT', baseline });
  const detail = model.views['strategy-detail'];
  assert.equal(detail.currency, 'USDT');
  assert.equal(detail.profile_state, undefined);
  assert.equal(detail.backtest.state, 'LOCKED_VERIFIED');
  // 诊断按测试档案读（失败关闭，见上一条）；失败投影不带 case_ref，工作台不挂到详情上（与 US_V5 的现有行为相同），也不会挂 US_V5 的诊断
  assert.equal(detail.health.diagnostic, null);
  assert.equal(detail.health.delivery_truth, null);
  const html = await renderPage(model, '#strategy-detail?strategy=FIXTURE_CRYPTO_USDT');
  assert.match(html, /BTC 买入持有/);
  assert.match(html, /跌破 600 USDT 的概率/);
  assert.match(html, /测试样本外/);
  assert.match(html, /按现行固定风险/);
  assert.match(html, /底线：测试档案的 600 USDT 底线。/);
  assert.match(html, /测试样本外每笔扣费后净 R 均值（5 bps，收盘小时相位；门槛 \+0\.10 R）/);
  for (const pattern of US_V5_VALUES) assert.doesNotMatch(html, pattern);
});

test('R3.1 未登记的 strategy_ref：基线与对比导入（服务和命令行）都拒绝并给原因码，账本与证据目录不写', () => {
  const file = write(fixtureResult());
  const evidenceBefore = listing(path.dirname(file));
  const ledgerBefore = listing(process.env.QRP_DATA_DIR);
  assert.throws(() => k3.importBaselineEvaluation(file, { registeredBy: AUTHORITY, strategyRef: 'NOT_REGISTERED_STRATEGY', allowNonActual: true }),
    (error) => error.code === 'STRATEGY_PROFILE_NOT_REGISTERED' && error.detail === 'NOT_REGISTERED_STRATEGY');
  assert.throws(() => comparison.importCandidateComparison(file, { registeredBy: AUTHORITY, strategyRef: 'NOT_REGISTERED_STRATEGY', allowNonActual: true }),
    (error) => error.code === 'STRATEGY_PROFILE_NOT_REGISTERED');
  // 已登记但没有对比题的策略：对比导入同样拒绝
  assert.throws(() => comparison.importCandidateComparison(file, { registeredBy: AUTHORITY, strategyRef: 'FIXTURE_CRYPTO_USDT', allowNonActual: true }),
    (error) => error.code === 'COMPARISON_QUESTION_NOT_REGISTERED');
  assert.deepEqual(listing(process.env.QRP_DATA_DIR), ledgerBefore);
  assert.deepEqual(listing(path.dirname(file)), evidenceBefore);

  for (const cli of ['import_baseline_evaluation.js', 'import_candidate_comparison.js']) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-profile-cli-'));
    const run = spawnSync(process.execPath, [path.join(ROOT, 'apps', 'research-cli', cli), '--file', file, '--registered-by', AUTHORITY, '--strategy', 'NOT_REGISTERED_STRATEGY'],
      { encoding: 'utf8', env: { ...process.env, QRP_DATA_DIR: dataDir, QRP_PRODUCT_MILESTONE_AUTHORITY: AUTHORITY } });
    assert.equal(run.status, 1, cli);
    assert.match(run.stderr, /^STRATEGY_PROFILE_NOT_REGISTERED:NOT_REGISTERED_STRATEGY/, cli);
    assert.deepEqual(listing(dataDir), [], `${cli} 不得写账本`);
  }
  assert.deepEqual(listing(path.dirname(file)), evidenceBefore);
});

test('R3.2 页面打开未登记的策略：写「该策略尚未接入研究」，不报错、不显示别的策略的数字', async () => {
  const desk = await workspace.readModel({ strategyRef: 'C17_V2_4000USDT' });
  const deskDetail = desk.views['strategy-detail'];
  assert.equal(deskDetail.profile_state, 'NOT_REGISTERED');
  assert.equal(deskDetail.profile_label, '该策略尚未接入研究');
  assert.equal(deskDetail.backtest.state, 'NOT_CONNECTED');
  assert.equal(deskDetail.health.diagnostic, null);
  const deskHtml = await renderPage(desk, '#strategy-detail?strategy=C17_V2_4000USDT');
  assert.match(deskHtml, /<h2 id="conclusion-title">尚未回测：该策略尚未接入研究<\/h2>/);
  assert.doesNotMatch(deskHtml, /role="alert"/);
  for (const pattern of [...US_V5_VALUES, /BTC 买入持有/, /600 USDT/, /FIXTURE/]) assert.doesNotMatch(deskHtml, pattern);

  const unknown = await workspace.readModel({ strategyRef: 'NOT_A_DESK_STRATEGY' });
  assert.equal(unknown.views['strategy-detail'].state, 'UNKNOWN_STRATEGY');
  const unknownHtml = await renderPage(unknown, '#strategy-detail?strategy=NOT_A_DESK_STRATEGY');
  assert.match(unknownHtml, /role="status"[^>]*><h3 id="not-onboarded-title">该策略尚未接入研究<\/h3>/);
  assert.doesNotMatch(unknownHtml, /role="alert"/);
  for (const pattern of [...US_V5_VALUES, /BTC/, /USDT/]) assert.doesNotMatch(unknownHtml, pattern);
});
