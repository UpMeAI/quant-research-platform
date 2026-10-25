'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const loop = require('../services/runtime-research-loop');
const workspace = require('../services/research-workspace');
const q0 = require('../services/baseline-evaluation');
const cc = require('../services/candidate-comparison');
const fx0 = require('./_q0_fixture');
const fx1 = require('./_q1_fixture');
const fx2 = require('./_q2_fixture');

const CASE = cc.CASE_REF;
const STRATEGY = cc.STRATEGY_REF;
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));

loop.openCase({
  case_id: CASE, strategy_ref: STRATEGY, market: 'US_EQUITY',
  runtime_lane: { source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64), version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
  baseline: {
    baseline_id: 'BASELINE-Q2-PAGE-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY', version_ref: 'US_V5_ETF_6000USD@frozen-old',
    source_ref: 'SMARTFLOW:SIGNED_RESEARCH:US_V5_ETF_6000USD', source_hash: 'b'.repeat(64), expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
    frozen_at: '2026-10-24T20:01:00Z',
  },
  cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
  data_quality: { status: 'VALID', as_of: '2026-10-23', known_at: '2026-10-24T20:00:00Z', source_refs: ['SMARTFLOW:US_V5_SCAN_RECORD_V2'], freshness: { state: 'CURRENT', age_seconds: 0 } },
  isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
  opened_at: '2026-10-24T20:02:00Z',
});

async function renderPage(model, hash = `#strategy-detail?strategy=${STRATEGY}`) {
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

function mainContent(html) {
  let out = html;
  for (let guard = 0; guard < 50 && /<details/.test(out); guard += 1) {
    out = out.replace(/<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/g, '');
  }
  return out;
}
const FORBIDDEN = [/\bM[0-5]\b/, /NOT_VERIFIED/, /CONTROLLED/, /真实账户臂/, /PAPER/, /RRC-/, /PME-/, /[0-9a-f]{64}/, /US_V5_ETF_6000USD/, /准备、验收和发布/];
const researchSection = (html) => html.slice(html.indexOf('id="detail-research"'), html.indexOf('id="detail-forward"'));
const cardOf = (html, title) => {
  const start = html.indexOf(`>${title}</h3>`);
  const end = html.indexOf('</section>', html.indexOf('class="bt-blocks"', start));
  return html.slice(html.lastIndexOf('<section', start), end);
};

/** 真实导入、真实投影的 Q0 + Q1 + Q2（合成数字）；Q0 的清单里多一条指向 Q2 的待验证问题。 */
function projections({ q1 = true, q2 = true, mutateQ2 } = {}) {
  for (const ledger of [q0.LEDGER(), cc.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); cc.clearCache();
  const q0Doc = fx0.result((doc) => {
    doc.diagnosis_items.push({ id: 'DX3', source: 'INSTRUMENT', facts: ['样本外 27 笔是单股 2×，没有 1× 载体'], proposed_experiment: 'Q2', no_topic_reason: null });
  });
  const q0Lock = q0.importBaselineEvaluation(fx0.write(q0Doc), { registeredBy: AUTHORITY, allowNonActual: true });
  const baseline = q0.buildProjection(q0Lock, { allowNonActual: true });
  const build = (lock) => cc.buildProjection(lock, { allowNonActual: true, question: lock.question_ref });
  const cards = [];
  let file2 = null;
  let lock2 = null;
  if (q1) cards.push(build(cc.importCandidateComparison(fx1.write(fx1.result(q0Doc, q0Lock.file_sha256, q0Lock.result_id)), { registeredBy: AUTHORITY, allowNonActual: true })));
  if (q2) {
    file2 = fx2.write(fx2.result(q0Doc, q0Lock.file_sha256, q0Lock.result_id, mutateQ2));
    lock2 = cc.importCandidateComparison(file2, { registeredBy: AUTHORITY, allowNonActual: true });
    cards.push(build(lock2));
  }
  return { baseline, cards, file2, lock2, build };
}
const modelOf = (baseline, comparison) => workspace.readModel({ strategyRef: STRATEGY, baseline, comparison });

test('两题都锁定：策略详情「研究与对比」里两张卡，按队列 Q1、Q2；Q1 七块、Q2 九块；各有各的标题', async () => {
  const { baseline, cards } = projections();
  const html = await renderPage(await modelOf(baseline, cards));
  const section = researchSection(html);
  assert.equal((section.match(/<section class="backtest comparison"/g) || []).length, 2);
  const blocks = [...section.matchAll(/data-cmp-block="(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(blocks, [
    'question', 'account', 'effect', 'criteria', 'stress', 'verdict', 'forward',
    'question', 'account', 'effect', 'exposure', 'criteria', 'stress', 'attribution', 'verdict', 'forward',
  ]);
  const q1Title = section.indexOf('候选对比：T3 对原版');
  const q2Title = section.indexOf('候选对比：1× 载体对原版（收益来自信号还是杠杆）');
  assert.ok(q1Title > -1 && q2Title > q1Title, 'Q1 在前，Q2 在后');
  assert.match(section, /id="comparison-title"/);
  assert.match(section, /id="comparison-title-Q2"/);
  assert.equal((section.match(/id="comparison-title"/g) || []).length, 1, 'id 不重复');
  // Q0 回测结论卡不动
  assert.deepEqual([...html.matchAll(/data-block="(\w+)"/g)].map((match) => match[1]), ['period', 'account', 'winrate', 'stress', 'kelly', 'verdict']);
});

test('Q2 卡的主内容：优势结论写「完整账户的对数增长更好（不等于信号 alpha 更大）」；三行分开；采用条件里没有「独立样本不足」', async () => {
  const { baseline, cards } = projections();
  const html = await renderPage(await modelOf(baseline, cards));
  const q2 = mainContent(cardOf(researchSection(html), '候选对比：1× 载体对原版（收益来自信号还是杠杆）'));
  assert.match(q2, /<span class="pill ok">优势结论：完整账户的对数增长更好（不等于信号 alpha 更大）<\/span>/);
  assert.match(q2, /<li class="">优势结论：完整账户的对数增长更好（不等于信号 alpha 更大）<\/li>/);
  assert.match(q2, /<li class="warn">压力评价不完整：缺场景 1 个、无效输入 1 个（/);
  assert.match(q2, /<li class="bad">采用条件：未满足（必要压力缺失，§6\.7）<\/li>/);
  assert.doesNotMatch(q2, /独立样本不足/);
  assert.match(q2, /样本外未被复用/);
  assert.match(q2, /没有用于选择载体杠杆/);
  assert.match(q2, /「有支持证据」在这里的意思是完整账户的对数增长更好，不等于信号 alpha 更大/);
  // Q1 的卡仍是「有支持证据」和「独立样本不足」
  const q1 = mainContent(cardOf(researchSection(html), '候选对比：T3 对原版'));
  assert.match(q1, /优势结论：有支持证据/);
  assert.match(q1, /独立样本不足，等前向成熟/);
  assert.doesNotMatch(q1, /不等于信号 alpha/);
});

test('Q2 卡的内容：g 的 95% 区间、次指标对 +0.10 R（不参与判定）、路由与单股 2×、两臂敞口表、判据三条', async () => {
  const { baseline, cards } = projections();
  const q2 = mainContent(cardOf(researchSection(await renderPage(await modelOf(baseline, cards))), '候选对比：1× 载体对原版（收益来自信号还是杠杆）'));
  assert.match(q2, /<dt>候选相对原版的年化对数增长差（主判据）<\/dt><dd>2\.10%（95% 区间 0\.40% 至 3\.90%）<\/dd>/);
  assert.match(q2, /年化对数增长差按共同日标记配对，按月分块 bootstrap；单变体，不做多重比较校正/);
  assert.doesNotMatch(q2, /98\.33%|Bonferroni（|最低改善量/);
  assert.match(q2, /每笔扣费后净 R 均值（门槛 \+0\.10 R，候选臂自身）/);
  assert.match(q2, /两臂同一信号都开仓的逐笔配对 ΔR（描述）/);
  assert.match(q2, /95% 区间跨过 \+0\.10 R/);
  assert.match(q2, /次指标不参与判定，只报告/);
  assert.match(q2, /仅原版开仓 20 笔，仅候选开仓 14 笔/);
  assert.match(q2, /被改换载体的入场<\/dt><dd>45 笔/);
  assert.match(q2, /回落到下一档载体<\/dt><dd>3 笔/);
  assert.match(q2, /单股 2×<\/dt><dd>保持原 2× 载体，两臂相同（27 笔）/);
  // 敞口
  assert.match(q2, /<th scope="col">项目<\/th><th scope="col">原版<\/th><th scope="col">候选<\/th><th scope="col">差（候选 − 原版）<\/th>/);
  assert.match(q2, /平均名义金额<\/td><td>US\$1,450<\/td><td>US\$2,100<\/td><td>\+US\$650<\/td>/);
  assert.match(q2, /在场时间占比<\/td><td>42\.0%<\/td><td>55\.0%<\/td><td>\+13\.0 个百分点<\/td>/);
  assert.match(q2, /被名义上限拒绝的次数<\/td><td>54<\/td><td>90<\/td><td>\+36 次<\/td>/);
  assert.match(q2, /被名义上限削减股数的次数<\/td><td>7<\/td><td>15<\/td><td>\+8 次<\/td>/);
  // 判据
  for (const key of ['G1', 'P_G', 'F3']) assert.ok(q2.includes(`<strong>${key} · `), key);
  assert.equal((q2.match(/>成立</g) || []).length, 2);
  assert.equal((q2.match(/>未触发</g) || []).length, 1);
  // 前向写明为什么为空
  assert.match(q2, /HK 没有 1× 路由的前向影子/);
});

test('Q2a 归因表：各栏、各类、合计；监管费按日进位差单列；账户期末 − 期初；残差 0；R、开发期、定义在折叠里', async () => {
  const { baseline, cards } = projections();
  const html = await renderPage(await modelOf(baseline, cards));
  const card = cardOf(researchSection(html), '候选对比：1× 载体对原版（收益来自信号还是杠杆）');
  const main = mainContent(card);
  const attribution = main.slice(main.indexOf('data-cmp-block="attribution"'), main.indexOf('data-cmp-block="verdict"'));
  for (const label of ['母序列信号', '杠杆与路径', '单股 2×（不可分）', '费用（含在成交价里的 5 bps／边）', '监管费（逐笔未进位）']) assert.ok(attribution.includes(`<th scope="col">${label}</th>`), label);
  for (const klass of ['指数', '行业', '3× 行业', '单股 2×', '反向']) assert.ok(attribution.includes(`<td>${klass}</td>`), klass);
  assert.match(attribution, /<td><strong>合计<\/strong><\/td><td>112<\/td>/);
  assert.match(attribution, /<td>—<\/td>/, '不适用的栏写「—」，不写 0');
  assert.match(attribution, /监管费按日进位差（账户层面，单列）<\/dt>/);
  assert.match(attribution, /账户期末 − 期初<\/dt>/);
  assert.match(attribution, /残差<\/dt><dd>US\$0\.000000<\/dd>/);
  assert.match(attribution, /归因对的是原版臂的净盈亏/);
  assert.match(attribution, /成交限制（描述，不进对账）/);
  assert.match(attribution, /被拒绝的信号<\/dt><dd>3 条<\/dd>/);
  // 折叠里的东西不在主内容里
  for (const folded of ['按每笔初始风险折成 R', '开发期 2020-01-02 至 2022-12-30（只报，不判）', '各栏的定义']) {
    assert.ok(card.includes(folded) && !main.includes(folded), folded);
  }
  for (const pattern of FORBIDDEN) assert.doesNotMatch(main, pattern, String(pattern));
  assert.doesNotMatch(card, /<details[^>]*\sopen(?:\s|>)/);
});

test('待验证问题清单：Q2 锁定后那一条写「已完成：…」并链到研究与对比；没锁定时原样不动（也没有链接）', async () => {
  const locked = projections();
  const html = await renderPage(await modelOf(locked.baseline, locked.cards));
  const diagnosis = html.slice(html.indexOf('id="diagnosis-title"'), html.indexOf('id="detail-health"'));
  assert.match(diagnosis, /Q1 · .*（已完成：有支持证据（见研究与对比））/);
  assert.match(diagnosis, /Q2 · .*（已完成：完整账户的对数增长更好（不等于信号 alpha 更大）（见研究与对比））/);
  assert.equal((diagnosis.match(/class="diagnosis-link"/g) || []).length, 2);

  const pending = projections({ q2: false });
  const pendingHtml = await renderPage(await modelOf(pending.baseline, pending.cards));
  const pendingDiagnosis = pendingHtml.slice(pendingHtml.indexOf('id="diagnosis-title"'), pendingHtml.indexOf('id="detail-health"'));
  assert.match(pendingDiagnosis, /Q2 · .*（进行中：K2 已冻结，等研究会话交付封存的对比结果（见研究与对比））/, 'Q2 没锁定：K2 已冻结，写进行中（从登记项推出，不是固定文案）');
  assert.doesNotMatch(pendingDiagnosis, /排队：可与 Q1 并行/, '过期的固定文案不再出现');
  assert.equal((pendingDiagnosis.match(/class="diagnosis-link"/g) || []).length, 1, '只有 Q1 带链接：Q2 还没有卡');
});

test('只有 Q1 锁定：只有 Q1 一张卡，不出现 Q2 的空卡；Q1 没有结果时仍是第一张「尚未完成」卡', async () => {
  const only1 = projections({ q2: false });
  const html1 = researchSection(await renderPage(await modelOf(only1.baseline, only1.cards)));
  assert.equal((html1.match(/<section class="backtest comparison"/g) || []).length, 1);
  assert.doesNotMatch(html1, /1× 载体对原版/);

  const none = projections({ q1: false, q2: false });
  const htmlNone = researchSection(await renderPage(await modelOf(none.baseline, [cc.emptyProjection('NOT_IMPORTED')])));
  assert.match(htmlNone, /<p class="not-backtested">尚未完成：研究会话尚未交付封存的对比结果<\/p>/);
  assert.equal((htmlNone.match(/<section class="backtest comparison"/g) || []).length, 1);
});

test('Q2 文件校验失败：只有 Q2 那张卡写「尚未完成：结果文件校验失败」，Q1 那张照常', async () => {
  const state = projections();
  fs.writeFileSync(state.file2, `${fs.readFileSync(state.file2, 'utf8')} `);
  const q2 = state.build(state.lock2);
  assert.equal(q2.state, 'INVALID');
  const html = await renderPage(await modelOf(state.baseline, [state.cards[0], q2]));
  const section = researchSection(html);
  assert.match(section, /候选对比：1× 载体对原版（收益来自信号还是杠杆）<\/h3>.*?尚未完成：结果文件校验失败：Q2_RESULT_SHA256_MISMATCH/);
  assert.equal((section.match(/data-cmp-block/g) || []).length, 7, '只剩 Q1 的七块');
  assert.match(section, /优势结论：有支持证据/);
  const diagnosis = html.slice(html.indexOf('id="diagnosis-title"'), html.indexOf('id="detail-health"'));
  assert.match(diagnosis, /Q2 · .*（已有封存的对比结果，但校验未通过（见研究与对比））/);
});

test('读模型：comparisons 是按队列排的卡片列表；单个投影也认（向后兼容）；没有注入时读真实台账（只有 Q1 的空卡）', async () => {
  const { baseline, cards } = projections();
  const model = await modelOf(baseline, cards);
  const list = model.views['strategy-detail'].comparisons;
  assert.deepEqual(list.map((card) => [card.question_ref, card.state, card.verdict_state]), [['Q1', 'LOCKED_VERIFIED', 'SUPPORTED'], ['Q2', 'LOCKED_VERIFIED', 'SUPPORTED']]);
  assert.ok(list.every((card) => card.source_label === undefined), 'A4 D3.4：「页面不重算」只在研究区开头写一次，卡片不再各带一份');
  assert.match(model.views['strategy-detail'].research.source_label, /页面不重算/);
  assert.equal(model.views['strategy-detail'].comparison, undefined);
  const single = await modelOf(baseline, cards[1]);
  assert.deepEqual(single.views['strategy-detail'].comparisons.map((card) => card.question_ref), ['Q2']);

  for (const ledger of [cc.LEDGER()]) fs.rmSync(ledger, { force: true });
  cc.clearCache();
  const real = await workspace.readModel({ strategyRef: STRATEGY, baseline });
  assert.deepEqual(real.views['strategy-detail'].comparisons.map((card) => [card.question_ref, card.state]), [['Q1', 'NOT_IMPORTED']]);
});
