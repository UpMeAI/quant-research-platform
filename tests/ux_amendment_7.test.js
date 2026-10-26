'use strict';
/**
 * UX 修订 7（CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_7）J5 确定性验收：策略详情按「总—分」重排。
 * J1 默认页签「总览」（服务端一句话结论、关键数字卡、精简一览、现行规则与待办）；J2 页签只渲染自己的内容，旧 section= 照旧；
 * J3 对比卡默认折叠成一行、卡内只有账户结果与结论默认展开、card= 定位；J4 去重；J5 长度、不丢信息（金样）、结构。
 * 夹具与采用记录都写在测试自己的临时账本里（tests/_a7_model.js），不写任何真实记录。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { STRATEGY, setup, modelOf, render, stable } = require('./_a7_model');
const { factSentences } = require('./_fact_sentences');
const summary = require('../services/research-workspace/summary');
const q0 = require('../services/baseline-evaluation');

const GOLDEN = path.join(__dirname, 'golden', 'a7_fact_sentences_before.json');
const CHROME = [process.env.QRP_TEST_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((file) => fs.existsSync(file));
const PAGE_FILE = path.join(__dirname, '..', 'apps', 'research-web', 'index.html');
const hashOf = (extra = '') => `#strategy-detail?strategy=${STRATEGY}${extra}`;
const between = (html, from, to) => { const start = html.indexOf(from); return start < 0 ? '' : html.slice(start, html.indexOf(to, start + from.length)); };
function mainContent(html) {
  let out = html;
  for (let guard = 0; guard < 50 && /<details/.test(out); guard += 1) out = out.replace(/<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/g, '');
  return out;
}
const sectionIds = (html) => [...html.matchAll(/<section class="section detail-section" id="(detail-\w+)"/g)].map((m) => m[1]);
/** 一张对比卡（含附属卡）：从它的折叠容器到下一张卡或「前向观察」页签为止。 */
function cardOf(html, question) {
  const start = html.indexOf(`<div class="cmp-fold" data-card="${question}"`);
  if (start < 0) return '';
  const ends = [html.indexOf('<div class="cmp-fold"', start + 10), html.indexOf('id="detail-forward"', start)].filter((at) => at > -1);
  return html.slice(start, ends.length ? Math.min(...ends) : undefined);
}
const foldOf = (fragment) => (/data-fold="(open|closed)"/.exec(fragment) || [])[1];

let shared = null;
/** 默认夹具：Q0–Q5 锁定，Q1、Q4、Q5 采用，Q2、Q3 不采用。 */
async function fixture() {
  if (!shared) { const { locks } = setup(); shared = { locks, model: await modelOf({ locks }) }; }
  return shared;
}

// ── J1 总览（第一层「总」）────────────────────────────────────────────────────────────

test('J1.1 / J5.4 一句话结论由服务端模板生成：期末对比较对象、结论、已采用的改进（组合题去重）、研究中期末最高的候选', async () => {
  const { model } = await fixture();
  const s = model.views['strategy-detail'].summary;
  assert.equal(s.sentence_zh, '现行版本样本外期末 3,069，高于 SPY 买入持有的 3,017（证据不足）；已采用 2 项改进（趋势中推迟时间止损、冷却只在开仓时武装），研究中期末最高的候选是 Q1「趋势中推迟时间止损」：3,131');
  // 没有采用记录：写待决定题数；只采用组合题 Q5：仍是两项改进（Q5 = Q4 + Q1），另有 4 题待决定
  const none = (await modelOf(setup({ decisions: {} }))).views['strategy-detail'].summary;
  assert.equal(none.sentence_zh, '现行版本样本外期末 3,069，高于 SPY 买入持有的 3,017（证据不足）；还没有采用任何改进，待 Owner 决定 5 题，研究中期末最高的候选是 Q1「趋势中推迟时间止损」：3,131');
  const comboOnly = (await modelOf(setup({ decisions: { Q5: ['ADOPT', '组合形式采用'] } }))).views['strategy-detail'].summary;
  assert.equal(comboOnly.sentence_zh, '现行版本样本外期末 3,069，高于 SPY 买入持有的 3,017（证据不足）；已采用 2 项改进（趋势中推迟时间止损、冷却只在开仓时武装），待 Owner 决定 4 题，研究中期末最高的候选是 Q1「趋势中推迟时间止损」：3,131');
  shared = null; // 上面重写过账本，后面的测试重新装默认夹具
});

test('J1.1 模板的其他分支：低于比较对象、期末最高的是组合题、没有候选高于现行版本、尚未回测（写状态与原因）', () => {
  const account = { start: '2023-01-03', end: '2026-10-23', arms: [{ key: 'D', label: '本策略', end_capital: 3417.9316 }, { key: 'SPY_BUY_HOLD', label: 'SPY 买入持有', end_capital: 6248.0811 }, { key: 'CASH', label: '现金', end_capital: 3000 }] };
  const conclusion = { result_state: 'LOCKED_VERIFIED', state: 'NOT_PASSED', label: '未通过' };
  const row = (q, decision, candidate) => ({ question_ref: q, role: 'COMPARISON', title_zh: `${q} 题名`, adoption: { state: decision ? 'DECIDED' : 'NONE', decision }, capital: { baseline: 3417.9316, candidate } });
  const questions = { Q1: { name_zh: '趋势中推迟时间止损' }, Q4: { name_zh: '冷却只在开仓时武装' }, Q5: { name_zh: '组合', combines: ['Q4', 'Q1'] }, Q2: { name_zh: '换载体' } };
  const overview = (rows, pending = 0) => ({ groups: [{ rows, summary: { pending } }], cumulative: null });
  // 真实一轮的形状：Q1、Q4、Q5 采用，Q5 期末最高（验收例句的形状）
  assert.equal(summary.sentenceOf({ conclusion, account, questions, overview: overview([row('Q1', 'ADOPT', 3795.65), row('Q2', 'NOT_ADOPTED', 3356.11), row('Q4', 'ADOPT', 4038.14), row('Q5', 'ADOPT', 4505.88)]) }),
    '现行版本样本外期末 3,418，低于 SPY 买入持有的 6,248（未通过）；已采用 2 项改进（趋势中推迟时间止损、冷却只在开仓时武装），研究中期末最高的是组合版本（Q5）：4,506');
  assert.equal(summary.sentenceOf({ conclusion, account, questions, overview: overview([row('Q2', null, 3356.11)], 1) }),
    '现行版本样本外期末 3,418，低于 SPY 买入持有的 6,248（未通过）；还没有采用任何改进，待 Owner 决定 1 题，研究中没有候选的期末高于现行版本');
  assert.equal(summary.sentenceOf({ conclusion, account, questions, overview: null }), '现行版本样本外期末 3,418，低于 SPY 买入持有的 6,248（未通过）');
  assert.equal(summary.sentenceOf({ conclusion: { result_state: 'NOT_IMPORTED', state: 'NOT_BACKTESTED', label: '尚未回测', reason: '研究会话尚未交付封存的回测结果' }, account: null, questions, overview: null }),
    '尚未回测：研究会话尚未交付封存的回测结果');
});

test('J1.2 / J5.4 关键数字卡：六张，数字原样取自锁定结果与采用一览（不重算），每张链到对应细节', async () => {
  const { model } = await fixture();
  const view = model.views['strategy-detail'];
  const tiles = Object.fromEntries(view.summary.tiles.map((tile) => [tile.key, tile]));
  assert.deepEqual(Object.keys(tiles), ['end_capital', 'max_drawdown', 'winrate', 'half_kelly', 'adoption_rate', 'underwater']);
  const block = (key) => view.backtest.blocks.find((item) => item.key === key).data;
  const own = block('account').arms.find((arm) => arm.key === 'D'); const spy = block('account').arms.find((arm) => arm.key === 'SPY_BUY_HOLD');
  assert.equal(tiles.end_capital.own, own.end_capital); assert.equal(tiles.end_capital.comparator, spy.end_capital);
  assert.equal(tiles.max_drawdown.own, own.max_drawdown); assert.equal(tiles.max_drawdown.comparator, spy.max_drawdown);
  const main = block('winrate').rows.find(q0.isMainRow);
  assert.deepEqual([tiles.winrate.win_rate, tiles.winrate.payoff, tiles.winrate.n], [main.win_rate, main.payoff, main.n]);
  assert.equal(tiles.half_kelly.f_half, block('kelly').f_half); assert.equal(tiles.half_kelly.supported, block('kelly').supported);
  const cumulative = view.adoption_overview.cumulative;
  assert.deepEqual([tiles.adoption_rate.adopted, tiles.adoption_rate.decided, tiles.adoption_rate.rate], [cumulative.adopted, cumulative.decided, cumulative.rate]);
  assert.deepEqual([tiles.underwater.sessions, tiles.underwater.recovered], [own.longest_underwater_sessions, own.recovered]);
  const { html } = await render(model, hashOf());
  const links = [...html.matchAll(/<a class="tile" data-tile="(\w+)" href="([^"]+)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]);
  assert.deepEqual(links, [
    ['end_capital', `${hashOf('&section=runtime&block=account')}`], ['max_drawdown', `${hashOf('&section=runtime&block=account')}`],
    ['winrate', `${hashOf('&section=runtime&block=winrate')}`], ['half_kelly', `${hashOf('&section=runtime&block=kelly')}`],
    ['adoption_rate', `${hashOf('&section=research')}`], ['underwater', `${hashOf('&section=runtime&block=account')}`],
  ]);
});

test('J1 默认打开就是「总览」：一句话结论、数字卡、精简一览（题号、中文题名、期末差值、统计结论、采用决定）、现行规则与待办；每行每项都能点进细节', async () => {
  const { model } = await fixture();
  const view = model.views['strategy-detail'];
  const { html } = await render(model, hashOf());
  assert.deepEqual(sectionIds(html), ['detail-overview'], '默认只渲染总览');
  assert.match(html, /<nav class="section-nav"[^>]*>(?:(?!<\/nav>).)*<a href="[^"]*section=overview" aria-current="page">总览<\/a>/);
  assert.ok(html.includes(`<p class="summary-sentence">${view.summary.sentence_zh}</p>`));
  // 精简一览：修订 6 的同一批行，只有五列
  const table = between(html, '<table class="compact-table">', '</table>');
  assert.deepEqual([...table.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((m) => m[1]), ['题号与中文题名', '样本外期末差值（候选 − 原版）', '统计结论', '采用决定']);
  const rows = view.adoption_overview.groups.flatMap((group) => group.rows);
  const bodyRows = [...table.matchAll(/<tr><td><a href="([^"]+)"><strong>([^<]+)<\/strong>/g)].map((m) => [m[2], m[1].replace(/&amp;/g, '&')]);
  assert.deepEqual(bodyRows.map(([q]) => q), rows.map((row) => row.question_ref), '行与修订 6 一览相同');
  assert.deepEqual(Object.fromEntries(bodyRows), {
    Q0: hashOf('&section=runtime&block=account'), Q1: hashOf('&section=research&card=Q1'), Q2: hashOf('&section=research&card=Q2'), Q3: hashOf('&section=research&card=Q3'),
    Q3a: hashOf('&section=research&card=Q3'), Q3a2: hashOf('&section=research&card=Q3'), Q4: hashOf('&section=research&card=Q4'), Q5: hashOf('&section=research&card=Q5'),
  });
  assert.match(table, /<strong>Q1<\/strong> 趋势中推迟时间止损<\/a><\/td><td>\+US\$61<\/td><td>有支持证据<\/td><td><strong>采用<\/strong><\/td>/);
  assert.match(table, /<strong>Q0<\/strong> 当前 D 原版评价<\/a><\/td><td>基线期末 US\$3,069<\/td><td>证据不足<\/td><td>不适用（基线）<\/td>/);
  assert.ok(html.includes(`累计：${view.adoption_overview.cumulative.text_zh}`));
  // 现行规则与待办
  const rules = between(html, '<div class="card rules">', '<details');
  assert.match(rules, /<strong>现行版本：<\/strong>美股 ETF 主策略账本（US_V5 · 3000 美元）：Desk 登记 \d{4}-\d{2}-\d{2} 起生效，模拟运行/);
  assert.match(rules, /<h4>已采用、待落地<\/h4><ul class="todo-list"><li><a href="[^"]*card=Q1">Q1 趋势中推迟时间止损<\/a>：Owner 2026-10-26 决定采用；后续：同一规则以 Q5 的组合形式采用<\/li>/);
  assert.match(rules, /<h4>待 Owner 决定<\/h4><p class="muted-note">没有待 Owner 决定的题。<\/p>/);
  assert.match(rules, /<h4>下一步研究<\/h4><ul class="todo-list"><li><a href="[^"]*card=Q2">Q2 换成 1 倍载体（收益来自信号还是杠杆）<\/a>：不采用；后续：现行载体不变<\/li>/);
  assert.match(rules, /部署状态不在 QRP 的记录里/);
  // 总览的主内容同样不出现内部代号（修订 5 E7.2 的规则用在新页签上）
  assert.doesNotMatch(mainContent(html), /(?<![A-Za-z0-9_])(?:T3|X1)(?![A-Za-z0-9_])/);
});

test('J1 没有研究档案的策略：总览只放回测结论区块（尚未回测与原因），不借用别的策略的数字', async () => {
  const { model } = await fixture();
  const other = JSON.parse(JSON.stringify(model));
  const view = other.views['strategy-detail'];
  delete view.summary;
  view.conclusion = { ...view.conclusion, state: 'NOT_BACKTESTED', label: '尚未回测', reason: '该策略尚未接入研究', main_number: null, basis: null, completeness: null };
  const { html } = await render(other, hashOf());
  assert.deepEqual(sectionIds(html), ['detail-overview']);
  assert.match(html, /<h2 id="conclusion-title">尚未回测：该策略尚未接入研究<\/h2>/);
  assert.doesNotMatch(html, /class="tiles"|compact-table|class="card rules"/);
});

// ── J2 页签只显示自己的内容 ───────────────────────────────────────────────────────────

test('J2 每个页签只渲染自己；旧 section= 链接照旧（runtime → 运行概览…）；runtime-research-loop → 体检；未知 section 回到总览；section=all 全部展开', async () => {
  const { model } = await fixture();
  const cases = [
    ['', ['detail-overview']], ['&section=overview', ['detail-overview']], ['&section=runtime', ['detail-runtime']], ['&section=health', ['detail-health']],
    ['&section=research', ['detail-research']], ['&section=forward', ['detail-forward']], ['&section=review', ['detail-review']],
    ['&section=nonsense', ['detail-overview']], ['&card=Q5', ['detail-research']], ['&block=kelly', ['detail-runtime']],
    ['&section=all', ['detail-overview', 'detail-runtime', 'detail-health', 'detail-research', 'detail-forward', 'detail-review']],
  ];
  for (const [extra, ids] of cases) {
    const { html } = await render(model, hashOf(extra));
    assert.deepEqual(sectionIds(html), ids, extra || '(默认)');
  }
  const loop = await render(model, `#runtime-research-loop?strategy=${STRATEGY}`);
  assert.deepEqual(sectionIds(loop.html), ['detail-health']);
  // 运行概览：回测结论区块在前，其后是回测结论卡（结论先行）；页签栏标出当前页签
  const runtime = (await render(model, hashOf('&section=runtime'))).html;
  assert.ok(runtime.indexOf('class="conclusion') < runtime.indexOf('aria-labelledby="backtest-title"'));
  assert.match(runtime, /<a href="[^"]*section=runtime" aria-current="page">运行概览<\/a>/);
  assert.equal((runtime.match(/aria-current="page"/g) || []).length, 1);
  // 策略卡片与切换策略：默认进总览
  const list = (await render(model, '#strategies')).html;
  assert.match(list, /class="strategy-card" href="#strategy-detail\?strategy=US_V5_ETF_3000USD&amp;section=overview"|class="strategy-card" href="#strategy-detail\?strategy=US_V5_ETF_3000USD&section=overview"/);
});

// ── J3 对比卡默认折叠成一行 ───────────────────────────────────────────────────────────

test('J3.1 对比卡默认折叠成一行：题号、中文题名、采用决定、期末（原版 → 候选、差值）、最大回撤变化、统计结论', async () => {
  const { model } = await fixture();
  const { html } = await render(model, hashOf('&section=research'));
  const view = model.views['strategy-detail'];
  for (const cmp of view.comparisons) {
    const card = cardOf(html, cmp.question_ref);
    assert.equal(foldOf(card), 'closed', `${cmp.question_ref} 默认折叠`);
    const line = between(card, '<span class="cmp-line">', '</button>');
    const account = cmp.blocks.find((block) => block.key === 'account').data;
    const name = view.research_queue.rows.find((row) => row.question_ref === cmp.question_ref).name_zh;
    const parts = line.split('<span class="sep"> · </span>');
    assert.equal(parts[0], `<span class="cmp-line"><strong>${cmp.question_ref}</strong> ${name}`);
    assert.equal(parts[1], `采用决定：${cmp.adoption.short_zh}`);
    const usd0 = (v) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
    assert.ok(parts[2].startsWith(`期末 ${usd0(account.arms[0].end_capital)} → ${usd0(account.arms[1].end_capital)}（`), parts[2]);
    assert.ok(parts[3].startsWith('最大回撤 ') && parts[3].includes('个百分点'), parts[3]);
    assert.equal(parts[4].replace('</span>', ''), `统计结论：${cmp.verdict_label}`);
  }
});

test('J3.2 卡内分块默认再折叠：只有「账户结果」和判据依据（三态结论与采用条件）默认展开；附属卡默认折叠；没有打开任何技术折叠', async () => {
  const { model } = await fixture();
  const { html } = await render(model, hashOf('&section=research'));
  for (const question of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) {
    const card = cardOf(html, question);
    const blocks = Object.fromEntries([...card.matchAll(/data-cmp-block="(\w+)"( data-fold="(open|closed)")?/g)].map((m) => [m[1], m[3] || 'one-line']));
    for (const [key, state] of Object.entries(blocks)) {
      const expected = key === 'account' || key === 'verdict' ? 'open' : key === 'forward' ? 'one-line' : 'closed';
      assert.equal(state, expected, `${question} ${key}`);
    }
    for (const m of card.matchAll(/<section class="backtest comparison (random-control|report-only|recommendation)"[^>]*data-fold="(\w+)"/g)) assert.equal(m[2], 'closed', `${question} ${m[1]}`);
  }
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/);
});

test('J3.3 card= 直接定位并展开那一张卡（其余仍折叠）；section=all 全部展开', async () => {
  const { model } = await fixture();
  const { html } = await render(model, hashOf('&section=research&card=Q5'));
  for (const question of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) assert.equal(foldOf(cardOf(html, question)), question === 'Q5' ? 'open' : 'closed', question);
  assert.match(cardOf(html, 'Q5'), /<button type="button" class="fold-toggle" aria-expanded="true"><span class="cmp-line">/);
  const all = (await render(model, hashOf('&section=all'))).html;
  assert.doesNotMatch(all, /data-fold="closed"/, '全部展开时没有收起的结构折叠');
  assert.doesNotMatch(all, /aria-expanded="false"/);
});

// ── J4 去重 ─────────────────────────────────────────────────────────────────────────

test('J4.1 策略名只在页头标题出现一次；J4.4 待验证问题清单按研究部分分组，每组一个小标题', async () => {
  const { model } = await fixture();
  const { html, contextTitle } = await render(model, hashOf('&section=all'));
  const name = model.views['strategy-detail'].strategy.name;
  assert.ok(contextTitle.includes(name));
  assert.doesNotMatch(html, new RegExp(`<h2>${name.replace(/[()（）·]/g, '.')}</h2>`), '详情区不再重复策略名标题');
  const list = between(html, 'id="diagnosis-title"', '当前身份与状态');
  const parts = model.views['strategy-detail'].diagnosis_list.items.map((item) => item.source_label);
  const linked = [...new Set(model.views['strategy-detail'].diagnosis_list.items.filter((item) => item.experiment).map((item) => item.source_label))];
  const main = mainContent(list);
  assert.deepEqual([...main.matchAll(/<div class="diagnosis-group"><h4>([^<]+)<\/h4>/g)].map((m) => m[1]), linked, '主内容每个研究部分一个小标题，按首次出现的顺序');
  assert.equal((list.match(/<article class="card diagnosis-item">/g) || []).length, parts.length, '条目一条不少');
});

test('J4.2 原版数字与回测结论卡相同的行只写候选与差值（加「原版见回测结论卡」）；不同的原版（如 Q5 的 A25 版本）照常写全', async () => {
  const { model } = await fixture();
  const view = model.views['strategy-detail'];
  const { html } = await render(model, hashOf('&section=all'));
  const q0Block = (key) => view.backtest.blocks.find((block) => block.key === key).data;
  const q0Arm = q0Block('account').arms.find((arm) => arm.key === 'D');
  const q0Stress = new Map(q0Block('stress').rows.map((row) => [row.scenario, row]));
  for (const cmp of view.comparisons) {
    const card = cardOf(html, cmp.question_ref);
    const account = between(card, 'data-cmp-block="account"', 'data-cmp-block="');
    const base = cmp.blocks.find((block) => block.key === 'account').data.arms[0];
    const same = ['end_capital', 'cagr', 'max_drawdown', 'longest_underwater_sessions', 'recovered'].every((key) => base[key] === q0Arm[key]);
    assert.equal(account.includes('原版见回测结论卡'), same, `${cmp.question_ref} 账户`);
    assert.equal(account.includes(`<td>${base.label}`), !same, `${cmp.question_ref} 原版一行`);
    const stress = between(card, 'data-cmp-block="stress"', 'data-cmp-block="');
    for (const row of cmp.blocks.find((block) => block.key === 'stress').data.rows) {
      if (row.kind === 'MISSING' || row.kind === 'INVALID_INPUT' || row.same_as_reference || !row.baseline) continue;
      const o = q0Stress.get(row.scenario);
      const dedupe = Boolean(o && ['max_loss_usd', 'longest_underwater_sessions', 'end_capital'].every((key) => o[key] === row.baseline[key]));
      const cells = between(stress, `<tr><td>${row.label}`, '</tr>');
      assert.ok(cells, `${cmp.question_ref} ${row.scenario}`);
      assert.equal(/原版 /.test(cells), !dedupe, `${cmp.question_ref} ${row.scenario}：${dedupe ? '原版见回测结论卡' : '原版照写'}`);
    }
  }
});

test('J4.3 前向观察集中在「前向观察」页签（按题分组）；对比卡里只留一行「前向：N 行，见前向观察」', async () => {
  const { model } = await fixture();
  const { html } = await render(model, hashOf('&section=all'));
  const forwardTab = between(html, 'id="detail-forward"', 'id="detail-review"');
  for (const cmp of model.views['strategy-detail'].comparisons) {
    const block = cmp.blocks.find((item) => item.key === 'forward');
    const card = between(cardOf(html, cmp.question_ref), 'data-cmp-block="forward"', '</article>');
    assert.match(card, new RegExp(`^data-cmp-block="forward"><h4><span class="bt-num">\\d+</span>[^<]+</h4><p class="forward-pointer">前向：${block.data.rows.length} 行，<a href="[^"]*section=forward">见前向观察</a></p>$`));
    const group = between(forwardTab, `data-forward-card="${cmp.question_ref}"`, '</article>');
    assert.ok(group.includes(block.data.label), `${cmp.question_ref} 的前向标签在前向页签`);
    for (const row of block.data.rows) assert.ok(group.includes(row.stream_label), `${cmp.question_ref} ${row.stream_label}`);
  }
});

// ── J5.2 不丢信息：改版前的金样 ⊆ 改版后全部展开 ────────────────────────────────────────────

test('J5.2 改版前每页签全部展开的事实句，改版后全部展开仍然都在；少掉的只有 J4 列出的重复项（逐条核对）', async () => {
  const { model } = await fixture();
  const before = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const { html, contextTitle } = await render(model, hashOf('&section=all'));
  const after = new Set([contextTitle, ...factSentences(html)].map(stable));
  const name = model.views['strategy-detail'].strategy.name;
  const removed = { 'J4.1': [], 'J4.2': [] };
  const unexplained = [];
  for (const sentence of before) {
    if (after.has(sentence)) continue;
    // J4.1：详情区的策略名标题；页头「当前 Desk 策略」标题里仍有
    if (sentence === name && after.has(stable(contextTitle)) && contextTitle.includes(name)) { removed['J4.1'].push(sentence); continue; }
    // J4.2：对比卡账户表的原版一行与回测结论卡「本策略」一行相同
    const own = /^原版（当前 D） \| (.+)$/.exec(sentence);
    if (own && after.has(`本策略 | ${own[1]}`)) { removed['J4.2'].push(sentence); continue; }
    // J4.2：对比卡压力行去掉与回测结论卡相同的原版数字后，候选与差值仍在
    const stripped = sentence.replace(/原版 [^ |]+(?: 个)? /g, '');
    if (stripped !== sentence && after.has(stripped)) { removed['J4.2'].push(sentence); continue; }
    unexplained.push(sentence);
  }
  assert.deepEqual(unexplained, [], '除 J4 列出的重复项外，没有事实句丢失');
  assert.deepEqual(removed['J4.1'], [name]);
  assert.ok(removed['J4.2'].length > 0);
  assert.ok(before.length > 500 && after.size >= before.length, `${before.length} → ${after.size}`);
});

// ── J5.3 结构 ──────────────────────────────────────────────────────────────────────

test('J5.3 结构：页签标题不重复；每个页签里的 h3 不重复；每张卡里的分块标题不重复；修订 6 一览的轮次小标题不重复', async () => {
  const { model } = await fixture();
  const { html } = await render(model, hashOf('&section=all'));
  const texts = (fragment, tag) => [...fragment.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  const unique = (list, what) => assert.deepEqual(list.filter((item, index) => list.indexOf(item) !== index), [], what);
  unique(texts(html, 'h2'), '整页 h2');
  for (const id of sectionIds(html)) {
    const start = html.indexOf(`id="${id}"`); const next = sectionIds(html)[sectionIds(html).indexOf(id) + 1];
    const tab = html.slice(start, next ? html.indexOf(`id="${next}"`) : undefined);
    unique(texts(tab, 'h3'), `${id} 的 h3`);
  }
  for (const question of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) unique(texts(between(cardOf(html, question), 'class="bt-blocks"', '</section>'), 'h4'), `${question} 分块标题`);
  unique(texts(between(html, '<div class="adoption-overview">', '<div class="research-queue">'), 'h4'), '一览轮次');
});

// ── J5.1 长度（真浏览器）────────────────────────────────────────────────────────────

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

async function probe(port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-a7-chrome-'));
  try {
    const run = await new Promise((resolve) => {
      const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        `--user-data-dir=${profile}`, '--virtual-time-budget=60000', '--dump-dom', `http://127.0.0.1:${port}/__probe`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout }); });
    });
    const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(run.stdout);
    assert.ok(match && match[1] !== 'PENDING', `探针页没有跑完（退出码 ${run.status}）`);
    return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}

test('J5.1 长度：1280 × 800 下总览 ≤ 1,600 px、研究与对比（卡片全部折叠）≤ 3,000 px；390 px 宽下各页签都没有整页横向滚动', { skip: CHROME ? false : '本机没有 Chrome（可用 QRP_TEST_CHROME 指定）；浏览器布局未验证，跳过不算通过', timeout: 300000 }, async () => {
  const { model } = await fixture();
  const page = fs.readFileSync(PAGE_FILE);
  const routes = [[hashOf(), 1280], [hashOf('&section=research'), 1280],
    ...['', '&section=research', '&section=research&card=Q5', '&section=runtime', '&section=all'].map((extra) => [hashOf(extra), 390])];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__probe')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PROBE(routes)); return; }
    if (req.url.startsWith('/api/workspace')) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(model)); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const rows = await probe(server.address().port);
    assert.equal(rows.length, routes.length);
    for (const row of rows) assert.ok(row.sections >= 1 && row.text > 200, `${row.route} @${row.width} 没有渲染出页面`);
    const [overview, research] = rows;
    assert.ok(overview.height <= 1600, `总览 @1280：${overview.height} px > 1,600`);
    assert.ok(research.height <= 3000, `研究与对比（折叠）@1280：${research.height} px > 3,000`);
    for (const row of rows.filter((item) => item.width === 390)) assert.ok(row.scrollWidth <= row.clientWidth, `${row.route} @390：整页横向宽度 ${row.scrollWidth} > ${row.clientWidth}`);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
