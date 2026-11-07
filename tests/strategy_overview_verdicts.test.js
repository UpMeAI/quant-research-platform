'use strict';

require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workspace = require('../services/research-workspace');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));

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

test('队列 #21：A 股父账本只计一次，策略总览拆成宽基 ETF 与个股／行业 ETF 两个研究模块', async () => {
  const model = await workspace.readModel();
  const overview = model.views.strategies.overview;
  const ashare = overview.parents.find((item) => item.strategy_ref === 'ASHARE_V6_PAPER');

  assert.ok(ashare, 'A 股父账本应保留为唯一上级');
  assert.equal(overview.system_strategy_count, model.strategy_directory.strategies.length);
  assert.equal(overview.display_module_count, model.strategy_directory.strategies.length + 1);
  assert.deepEqual(ashare.modules.map((item) => [item.module_ref, item.book_ref, item.component, item.name]), [
    ['ASHARE_V6_PAPER:INDEX', 'INDEX_BOOK', 'INDEX', '宽基 ETF'],
    ['ASHARE_V6_PAPER:STOCK', 'STOCK_BOOK', 'STOCK', '个股 / 行业 ETF'],
  ]);
  assert.ok(ashare.modules.every((item) => item.parent_strategy_ref === 'ASHARE_V6_PAPER'));
  assert.equal(overview.parents.filter((item) => item.strategy_ref === 'ASHARE_V6_PAPER').length, 1);
});

test('队列 #21：做／不做由服务投影给出，US_CORE、C17、Quick Shot 的摘要不把统计标签当结论', async () => {
  const model = await workspace.readModel();
  const cards = model.views.strategies.overview.cards;
  const byRef = new Map(cards.map((item) => [item.strategy_ref, item]));

  for (const ref of ['US_CORE_9000USD_3X_GATEOBS', 'C17_V2_4000USDT', 'QUICK_SHOT_V3_1000USDT']) {
    const card = byRef.get(ref);
    assert.ok(card, ref);
    assert.deepEqual([card.verdict.code, card.verdict.label_zh], ['DO', '做']);
    assert.doesNotMatch(card.summary_zh, /证据不足|区间|Q0/);
  }

  const shadow = byRef.get('CARRY_V2_SHADOW_10000USDT');
  assert.deepEqual([shadow.verdict.code, shadow.verdict.label_zh, shadow.verdict.qualifier_zh], ['DONT', '不做', '影子观察，不影响持仓']);
});

test('队列 #21：A 股研究数据未登记时显示待交付，不回退到尚未接入', async () => {
  const model = await workspace.readModel();
  const ashare = model.views.strategies.overview.parents.find((item) => item.strategy_ref === 'ASHARE_V6_PAPER');
  const researchText = JSON.stringify(ashare.modules.map((item) => item.research));

  assert.match(researchText, /待交付 · R-ETF-1 研究状态/);
  assert.match(researchText, /待交付 · R-STK-1 研究状态/);
  assert.doesNotMatch(researchText, /尚未接入/);
});

test('队列 #21：页面首层只显示做／不做，统计结论留在折叠详情并附证据不足说明', async () => {
  const model = await workspace.readModel();
  const sample = model.views.strategies.overview.cards.find((item) => item.strategy_ref === 'US_CORE_9000USD_3X_GATEOBS');
  sample.research.detail = { headline_zh: 'Q0 证据不足', steps: [] };
  sample.research.has_insufficient_statistics = true;
  const html = await renderOverview(model);
  const main = withoutDetails(html);

  assert.match(main, />做</);
  assert.match(main, />不做</);
  assert.match(main, /宽基 ETF/);
  assert.match(main, /个股 \/ 行业 ETF/);
  assert.doesNotMatch(main, /Q0 证据不足|证据不足（A0/);
  assert.doesNotMatch(html, /尚未接入/);
  assert.match(html, /统计与研究详情/);
  assert.match(html, /证据不足 = 95% 区间跨过了事先冻结的门槛/);
});

