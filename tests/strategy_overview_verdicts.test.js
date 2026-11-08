'use strict';
/**
 * 队列 #21 策略总览（services/research-workspace/strategy-overview.js + apps/research-web）：
 *   - A 股两个研究模块、顺序、名称、簿 / 组件、研究线、方向、上级全部取自 config/ashare_research_modules.v1.json（QRP #59），
 *     代码和页面里没有第二份；
 *   - 结论只写「做」或「不做」：A 股取 state = CONCLUDED 的 verdicts[].decision（R-ETF-1 = 做），仍在研究的题（R-STK-1）
 *     没有结论，进「研究进行中」，写数据里的预计日期和判定规则；统计标签只在折叠详情里；
 *   - 行业 ETF 显示数据给的占位，不并进 R-STK-1；缺数据写「待交付 · X」，不写「尚未接入」；
 *   - 美股、加密沿用 #60：摘要不拿「证据不足」当结论。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workspace = require('../services/research-workspace');
const overviewService = require('../services/research-workspace/strategy-overview');
const registryService = require('../services/ashare-research-modules');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'ashare_research_modules.v1.json'), 'utf8'));
const PARENT = DATA.parent.desk_book;
const specOf = (id) => DATA.modules.find((item) => item.module_id === id);
const R_ETF_1_NOTE = '生产上线待 Owner 签字（INDEX_SLEEVE v6）；VG 前向影子 11-09 起';

async function renderOverview(model) {
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = {
    id, innerHTML: '', textContent: '', addEventListener() {}, querySelector() { return null; }, focus() {}, scrollIntoView() {},
  });
  const sandbox = {
    document: { getElementById: element, title: '' }, location: { hash: '#strategies' }, window: { addEventListener() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(model)) }),
    requestAnimationFrame() {}, URLSearchParams, Intl, encodeURIComponent, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return elements.workspace.innerHTML;
}

function withoutDetails(html) {
  let out = html;
  for (let guard = 0; guard < 20 && /<details/.test(out); guard += 1) {
    out = out.replace(/<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/g, '');
  }
  return out;
}

const ashareOf = (model) => model.views.strategies.overview.parents.find((item) => item.strategy_ref === PARENT);
const moduleOf = (model, id) => ashareOf(model).modules.find((item) => item.module_id === id);

test('队列 #21：A 股父账本只计一次，两个研究模块的顺序、名称、簿 / 组件、研究线、方向都取自登记', async () => {
  const model = await workspace.readModel();
  const overview = model.views.strategies.overview;
  const ashare = ashareOf(model);

  assert.ok(ashare, 'A 股父账本应保留为唯一上级');
  assert.equal(overview.parents.filter((item) => item.strategy_ref === PARENT).length, 1);
  assert.equal(overview.system_strategy_count, model.strategy_directory.strategies.length);
  assert.equal(overview.display_module_count, model.strategy_directory.strategies.length - 1 + DATA.modules.length);
  assert.deepEqual([ashare.split, ashare.counted_once, ashare.name, ashare.note_zh], [true, true, DATA.parent.label_zh, DATA.parent.note_zh]);
  const fromData = [...DATA.modules].sort((a, b) => a.order - b.order)
    .map((item) => [item.module_id, item.book, item.component, item.label_zh, item.research_line, item.direction_zh]);
  assert.deepEqual(ashare.modules.map((item) => [item.module_ref, item.book_ref, item.component, item.name, item.research_ref, item.research_direction_zh]), fromData);
  assert.deepEqual(fromData, [
    ['CN_A_BROAD_ETF', 'INDEX_BOOK', 'INDEX', '宽基 ETF', 'R-ETF-1', '网格 / 均值回归'],
    ['CN_A_STOCK_SECTOR_ETF', 'STOCK_BOOK', 'STOCK', '个股 / 行业 ETF', 'R-STK-1', '趋势跟踪'],
  ]);
  assert.ok(ashare.modules.every((item) => item.parent_strategy_ref === PARENT && item.parent_label_zh === DATA.parent.label_zh));
  // 各模块都显示运行状态（来自 Desk）与现行规则（来自登记）
  for (const item of ashare.modules) {
    assert.equal(item.runtime_zh, ashare.runtime_zh);
    assert.ok(item.runtime_zh.length > 0);
    assert.ok(item.rule_zh.startsWith(specOf(item.module_id).production_rule.key), item.module_id);
  }
  // 卡片计数与分组一致，上级不另算一项
  const { counts } = overview;
  assert.equal(counts.do + counts.dont + counts.researching, overview.display_module_count);
  assert.deepEqual(overview.sections.map((item) => [item.key, item.title_zh, item.cards.length]),
    [['do', '做', counts.do], ['dont', '不做', counts.dont], ['researching', '研究进行中', counts.researching]]);
  assert.equal(overview.cards.filter((item) => item.parent_strategy_ref === PARENT).length, DATA.modules.length);
});

test('队列 #21：代码与页面里没有 A 股模块的第二份登记（名称、研究线、预计日期只在 config 里）', () => {
  const sources = {
    'services/research-workspace/strategy-overview.js': fs.readFileSync(path.join(ROOT, 'services', 'research-workspace', 'strategy-overview.js'), 'utf8'),
    'apps/research-web/index.html': PAGE,
  };
  const fromData = [PARENT, DATA.parent.label_zh, ...DATA.modules.flatMap((item) => [
    item.module_id, item.label_zh, item.research_line, item.direction_zh,
    ...item.in_progress.flatMap((open) => [open.id, open.expected_by]),
    ...item.coverage_gaps.map((gap) => gap.placeholder_zh),
  ])].filter(Boolean);
  for (const [file, source] of Object.entries(sources)) {
    for (const value of fromData) assert.equal(source.includes(value), false, `${file} hard-codes ${value}`);
  }
});

test('队列 #21：宽基 ETF 取封存结论 R-ETF-1 = 做，并注明生产上线待签字、VG 前向影子起始日；统计标签只在详情', async () => {
  const model = await workspace.readModel();
  const overview = model.views.strategies.overview;
  const etf = moduleOf(model, 'CN_A_BROAD_ETF');
  const sealed = specOf('CN_A_BROAD_ETF').verdicts.find((item) => item.id === 'R-ETF-1');

  assert.equal(sealed.state, 'CONCLUDED');
  assert.deepEqual([etf.verdict.code, etf.verdict.label_zh, etf.verdict.source_ref, etf.verdict.sealed_on], ['DO', sealed.decision, 'R-ETF-1', sealed.sealed_on]);
  assert.equal(sealed.decision, '做');
  assert.equal(etf.verdict.qualifier_zh, R_ETF_1_NOTE);
  assert.equal(etf.summary_zh, `做 · ${R_ETF_1_NOTE}`);
  assert.ok(overview.groups.do.includes(etf));
  assert.equal(etf.research.state, 'CONCLUDED');
  for (const text of [etf.summary_zh, etf.verdict.qualifier_zh, etf.research.summary_zh]) {
    assert.doesNotMatch(text, /INSUFFICIENT|证据不足/);
  }
  // 统计标签与逐只读法只在折叠详情里
  assert.deepEqual(etf.research.detail.verdicts.map((item) => [item.id, item.decision, item.statistical_label]), [['R-ETF-1', '做', 'INSUFFICIENT']]);
  assert.equal(etf.research.detail.verdicts[0].statistical_label_zh, 'INSUFFICIENT（证据不足）');
  assert.equal(etf.research.detail.verdicts[0].per_item_zh.length, sealed.per_etf.length);
  assert.equal(etf.research.has_insufficient_statistics, true);
  // 同模块仍在研究的题：没有结论，写数据里的预计日期与规则
  const open = specOf('CN_A_BROAD_ETF').in_progress;
  assert.deepEqual(etf.research.in_progress.map((item) => [item.id, item.state_label_zh, item.expected_zh, item.conversion_rule_zh]),
    open.map((item) => [item.id, '研究进行中', `预计 ${item.expected_by}`, item.decided_by_zh]));
});

test('队列 #21：个股 / 行业 ETF 的 R-STK-1 仍在研究——没有结论，进研究进行中，预计日期与做 / 不做规则取自数据；行业 ETF 单列占位', async () => {
  const model = await workspace.readModel();
  const overview = model.views.strategies.overview;
  const stock = moduleOf(model, 'CN_A_STOCK_SECTOR_ETF');
  const spec = specOf('CN_A_STOCK_SECTOR_ETF');
  const line = spec.in_progress.find((item) => item.id === 'R-STK-1');

  assert.equal(spec.verdicts.length, 0);
  assert.equal(stock.verdict, null);
  assert.ok(overview.groups.researching.includes(stock));
  assert.equal(overview.groups.do.includes(stock) || overview.groups.dont.includes(stock), false);
  assert.equal(stock.research.state, 'RESEARCHING');
  assert.equal(stock.research.summary_zh, `研究进行中 · ${line.title_zh}`);
  assert.equal(stock.research.expected_zh, `预计 ${line.expected_by}`);
  assert.equal(stock.research.expected_zh, '预计 2026-11-14');
  assert.equal(stock.research.conversion_rule_zh, line.decided_by_zh);
  assert.match(stock.research.conversion_rule_zh, /做/);
  assert.match(stock.research.conversion_rule_zh, /不做/);
  assert.equal(stock.research.detail, null, 'no sealed verdict → no statistical detail');
  // 行业 ETF：数据给的占位，不并进 R-STK-1
  assert.deepEqual(stock.research.gaps.map((item) => [item.id, item.label_zh, item.placeholder_zh]), [['CN_A_SECTOR_ETF', '行业 ETF', '待交付 · 行业 ETF 研究线']]);
  assert.equal(stock.research_ref, 'R-STK-1');
  assert.doesNotMatch(`${stock.research.summary_zh}${stock.research.conversion_rule_zh}`, /行业 ETF/);
  assert.equal(stock.research.in_progress.some((item) => /行业 ETF/.test(item.title_zh)), false);
  // Q0 覆盖整本：挂在上级，只出现一次
  const ashare = ashareOf(model);
  assert.deepEqual(ashare.in_progress.map((item) => [item.id, item.state_label_zh, item.title_zh]), [['Q0', DATA.q0.state_label_zh, DATA.q0.title_zh]]);
  assert.equal(ashare.in_progress[0].expected_zh, `预计 ${DATA.q0.expected_end.slice(0, 10)} ${DATA.q0.expected_end.slice(11, 16)}（估计，未封存）`);
  assert.equal(ashare.modules.some((item) => item.research.in_progress.some((open) => open.id === 'Q0')), false);
});

test('队列 #21：做 / 不做由服务投影给出，US_CORE、C17、Quick Shot 的摘要不把统计标签当结论', async () => {
  const model = await workspace.readModel();
  const cards = model.views.strategies.overview.cards;
  const byRef = new Map(cards.filter((item) => item.kind === 'STRATEGY').map((item) => [item.strategy_ref, item]));

  for (const ref of ['US_CORE_9000USD_3X_GATEOBS', 'C17_V2_4000USDT', 'QUICK_SHOT_V3_1000USDT']) {
    const card = byRef.get(ref);
    assert.ok(card, ref);
    assert.deepEqual([card.verdict.code, card.verdict.label_zh], ['DO', '做']);
    assert.doesNotMatch(card.summary_zh, /证据不足|区间|Q0/);
  }

  const shadow = byRef.get('CARRY_V2_SHADOW_10000USDT');
  assert.deepEqual([shadow.verdict.code, shadow.verdict.label_zh, shadow.verdict.qualifier_zh], ['DONT', '不做', '影子观察，不影响持仓']);
});

test('队列 #21：数据缺的地方写「待交付 · X」，不回退到「尚未接入」', async () => {
  const model = await workspace.readModel();
  const researchText = JSON.stringify(ashareOf(model));
  assert.doesNotMatch(researchText, /尚未接入/);

  // 登记里缺研究线状态、缺预计日期与规则、缺占位文字时，投影自己补「待交付 · X」，不借用别的模块，也不写结论
  const directory = { strategies: model.strategy_directory.strategies };
  const thin = registryService.validate({
    ...DATA,
    modules: [
      { ...specOf('CN_A_BROAD_ETF'), verdicts: [], in_progress: [], coverage_gaps: [{ id: 'GAP_X', label_zh: '某范围', state: 'NOT_INITIATED' }] },
      { ...specOf('CN_A_STOCK_SECTOR_ETF'), in_progress: [{ id: 'R-STK-1', title_zh: 'R-STK-1', state: 'IN_PROGRESS', state_label_zh: '研究进行中' }] },
    ],
  });
  const built = overviewService.buildOverview(directory, { registryFor: (ref) => registryService.forDeskBook(ref, thin) });
  const [etf, stock] = built.parents.find((item) => item.strategy_ref === PARENT).modules;
  assert.deepEqual([etf.verdict, etf.research.state, etf.research.summary_zh], [null, 'PENDING_DELIVERY', '待交付 · R-ETF-1 研究状态']);
  assert.deepEqual(etf.research.gaps.map((item) => item.placeholder_zh), ['待交付 · 某范围']);
  assert.deepEqual([stock.verdict, stock.research.expected_zh, stock.research.conversion_rule_zh], [null, '待交付 · 预计日期', '待交付 · 做 / 不做转换规则']);
  assert.doesNotMatch(JSON.stringify(built), /尚未接入/);
  assert.equal(built.counts.researching, 2 + model.views.strategies.overview.counts.researching - 1);

  // 研究会话的登记写错（仍在研究的题带了结论）时，require 期就拒绝，不展示
  assert.throws(() => registryService.validate({
    ...DATA, modules: [{ ...specOf('CN_A_STOCK_SECTOR_ETF'), in_progress: [{ ...specOf('CN_A_STOCK_SECTOR_ETF').in_progress[0], decision: '做' }] }],
  }), /ASHARE_RESEARCH_MODULES_OPEN_HAS_DECISION/);
  assert.throws(() => registryService.validate({
    ...DATA, modules: [{ ...specOf('CN_A_BROAD_ETF'), verdicts: [{ ...specOf('CN_A_BROAD_ETF').verdicts[0], decision: 'INSUFFICIENT' }] }],
  }), /ASHARE_RESEARCH_MODULES_DECISION/);
});

test('队列 #21：页面首层只显示做 / 不做 / 研究进行中，统计标签留在折叠详情并附证据不足说明；上级只出现一次', async () => {
  const model = await workspace.readModel();
  const sample = model.views.strategies.overview.cards.find((item) => item.strategy_ref === 'US_CORE_9000USD_3X_GATEOBS');
  sample.research.detail = { kind: 'STAGE', headline_zh: 'Q0 证据不足', steps: [] };
  sample.research.has_insufficient_statistics = true;
  const html = await renderOverview(model);
  const main = withoutDetails(html);

  assert.match(main, /<h2 id="do-title">做<\/h2>/);
  assert.match(main, /<h2 id="dont-title">不做<\/h2>/);
  assert.match(main, /<h2 id="researching-title">研究进行中<\/h2>/);
  assert.match(main, />宽基 ETF</);
  assert.match(main, />个股 \/ 行业 ETF</);
  assert.ok(main.includes(R_ETF_1_NOTE), 'R-ETF-1 note on the card');
  assert.ok(main.includes('预计 2026-11-14'), 'R-STK-1 expected date on the card');
  assert.ok(main.includes(`转为结论：${specOf('CN_A_STOCK_SECTOR_ETF').in_progress[0].decided_by_zh.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}`));
  assert.ok(main.includes('行业 ETF：待交付 · 行业 ETF 研究线'));
  assert.doesNotMatch(main, /INSUFFICIENT|Q0 证据不足|证据不足（A0/);
  // 上级账本只出现一次（标题），模块卡上只写「上级：…」
  assert.equal((main.match(new RegExp(`<h2 id="parent-${PARENT}-title">`, 'g')) || []).length, 1);
  assert.equal((main.match(/上级：/g) || []).length, DATA.modules.length);
  assert.doesNotMatch(html, /尚未接入/);
  assert.match(html, /统计与研究详情/);
  assert.match(html, /INSUFFICIENT（证据不足）/);
  assert.match(html, /证据不足 = 95% 区间跨过了事先冻结的门槛/);
  // 宽基 ETF 在「做」一节，个股 / 行业 ETF 在「研究进行中」一节
  const sectionOf = (name) => {
    const at = main.indexOf(`>${name}</h3>`);
    return ['do', 'dont', 'researching'].filter((key) => main.indexOf(`id="${key}-title"`) < at).pop();
  };
  assert.equal(sectionOf('宽基 ETF'), 'do');
  assert.equal(sectionOf('个股 / 行业 ETF'), 'researching');
});

test('A 股整本账本的接入标签按两个研究模块写（详情页头同一句），不写「尚未接入」', async () => {
  const model = await workspace.readModel();
  const parent = model.strategy_directory.strategies.find((item) => item.strategy_ref === PARENT);
  assert.equal(parent.research_stage.code, 'MODULES_REGISTERED');
  assert.equal(parent.research.label, parent.research_stage.headline_zh);
  assert.match(parent.research.label, /^2 个研究模块（宽基 ETF：R-ETF-1 已封存「做」；个股 \/ 行业 ETF：R-STK-1 研究进行中）；Q0 研究进行中$/);
  assert.doesNotMatch(JSON.stringify(parent), /尚未接入/);
});

test('A 股详情页：没有档案也不写「该策略尚未接入研究」，回测结论写 Q0 进行中与预计时间（取自登记）', async () => {
  const model = await workspace.readModel({ strategyRef: PARENT });
  const detail = model.views['strategy-detail'];
  const q0 = DATA.q0;
  const expected = `Q0 基线回测${q0.state_label_zh}（第 ${q0.phase} 阶段，预计 ${q0.expected_end.slice(0, 16).replace('T', ' ')}，估计，未封存）；两个研究模块的结论与进度见策略总览`;
  assert.equal(detail.profile_state, 'NOT_REGISTERED');
  assert.equal(detail.profile_label, expected);
  assert.ok(JSON.stringify(detail.backtest).includes(expected));
  assert.doesNotMatch(JSON.stringify([detail.profile_label, detail.backtest]), /尚未接入/);
});
