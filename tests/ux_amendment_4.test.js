'use strict';
/**
 * UX 修订 4（CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_4）D5 确定性验收。
 * 只验呈现：结论依据可见且与结论一致、主内容没有已登记的英文原因码、去重计数、状态一致。
 * 真实文件用仓库里已封存的 Q0／Q1／Q2 结果，夹具用合成数字；不改任何数字，也不重算。
 */
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
const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
const REAL = {
  q0: path.join(ROOT, 'var/evidence/us-v5-m2-q0-current-2026-10-25/US_V5_M2_Q0_RESULT_V1.json'),
  q1: path.join(ROOT, 'var/evidence/us-v5-m2-q1-2026-10-25/US_V5_M2_Q1_RESULT_V1.json'),
  q2: path.join(ROOT, 'var/evidence/us-v5-m2-q2-2026-10-25/US_V5_M2_Q2_RESULT_V1.json'),
};

loop.openCase({
  case_id: CASE, strategy_ref: STRATEGY, market: 'US_EQUITY',
  runtime_lane: { source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64), version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
  baseline: {
    baseline_id: 'BASELINE-A4-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY', version_ref: 'US_V5_ETF_6000USD@frozen-old',
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

/** 去掉所有 <details>（含嵌套）后剩下的就是「主内容」。 */
function mainContent(html) {
  let out = html;
  for (let guard = 0; guard < 50 && /<details/.test(out); guard += 1) {
    out = out.replace(/<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/g, '');
  }
  return out;
}
const text = (html) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
const between = (html, from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const conclusionOf = (html) => between(html, 'class="conclusion', 'class="section-nav');
const researchSection = (html) => between(html, 'id="detail-research"', 'id="detail-forward"');
const forwardSection = (html) => between(html, 'id="detail-forward"', 'id="detail-review"');
const cardsOf = (html) => researchSection(html).split('<section class="backtest comparison"').slice(1);
const blockOf = (card, key) => {
  const start = card.indexOf(`data-cmp-block="${key}"`);
  const next = card.indexOf('data-cmp-block="', start + 10);
  return card.slice(start, next === -1 ? undefined : next);
};
const tableRows = (html) => ((html.match(/<tbody>[\s\S]*?<\/tbody>/) || [''])[0].match(/<tr[\s\S]*?<\/tr>/g) || []);

const reset = () => { for (const ledger of [q0.LEDGER(), cc.LEDGER()]) fs.rmSync(ledger, { force: true }); q0.clearCache(); cc.clearCache(); };
const buildCard = (lock) => cc.buildProjection(lock, { allowNonActual: true, question: lock.question_ref });
const modelOf = (baseline, comparison) => workspace.readModel({ strategyRef: STRATEGY, baseline, comparison });

/** 真实 Q0 + Q1 + Q2，和线上页面读到的是同一批封存文件。 */
function realProjections() {
  reset();
  const baseline = q0.buildProjection(q0.importBaselineEvaluation(REAL.q0, { registeredBy: AUTHORITY }));
  const cards = [REAL.q1, REAL.q2].map((file) => {
    const lock = cc.importCandidateComparison(file, { registeredBy: AUTHORITY });
    return cc.buildProjection(lock, { question: lock.question_ref });
  });
  return { baseline, cards };
}

/** 合成 Q0（可改）+ 合成 Q1 + 合成 Q2。 */
function fixtureProjections({ patch0 = (doc) => doc, q1 = true, q2 = true } = {}) {
  reset();
  const doc0 = fx0.result(patch0);
  const lock0 = q0.importBaselineEvaluation(fx0.write(doc0), { registeredBy: AUTHORITY, allowNonActual: true });
  const baseline = q0.buildProjection(lock0, { allowNonActual: true });
  const cards = [];
  if (q1) cards.push(buildCard(cc.importCandidateComparison(fx1.write(fx1.result(doc0, lock0.file_sha256, lock0.result_id)), { registeredBy: AUTHORITY, allowNonActual: true })));
  if (q2) cards.push(buildCard(cc.importCandidateComparison(fx2.write(fx2.result(doc0, lock0.file_sha256, lock0.result_id)), { registeredBy: AUTHORITY, allowNonActual: true })));
  return { baseline, cards };
}

// ── D1 + D5.1：结论区块的「判定依据」与 verdict.state 一致 ────────────────────────────────────────

test('D5.1 真实 Q0 文件：依据行命名 U_g ≤ 0 那条；限制行叫「其他限制」，不写「区间跨过判定门槛」', async () => {
  const { baseline } = realProjections();
  assert.equal(baseline.conclusion.state, 'NOT_PASSED');
  const html = await renderPage(await modelOf(baseline, []));
  const conclusion = conclusionOf(html);
  assert.match(conclusion, /<h2 id="conclusion-title">未通过<\/h2>/);
  const basis = text(conclusion);
  assert.ok(basis.includes('判定依据：|相对 SPY 买入持有的账户年化对数增长差 95% 区间 −30.7% 至 −1.0%，上沿低于门槛 0（门槛在看到结果前已冻结）'), basis);
  // 另一条判据并列在后面，数字照报，不抢「触发」这一条
  assert.match(basis, /同时：每笔扣费后净 R 均值 −0\.02 R，95% 区间 −0\.27 R 至 \+0\.27 R，区间跨过门槛 \+0\.10 R/);
  assert.match(basis, /同时：相对现金的账户年化对数增长差 95% 区间 −7\.2% 至 14\.9%，区间跨过门槛 0/);
  // 与结论不矛盾：NOT_PASSED 时叫「其他限制」，里面只有与结论不冲突的限制
  assert.match(conclusion, /<strong>其他限制：<\/strong>压力评价不完整：缺场景 1 个、无效输入 1 个/);
  assert.doesNotMatch(conclusion, /最大的限制/);
  assert.doesNotMatch(between(conclusion, 'biggest-limit', '</p>'), /区间跨过判定门槛|区间跨过门槛/);
});

test('D5.1 夹具 INSUFFICIENT：依据行写区间跨门槛的那条判据，限制行与它说同一件事', async () => {
  const { baseline } = fixtureProjections({ q1: false, q2: false });
  assert.equal(baseline.conclusion.state, 'INSUFFICIENT');
  const conclusion = conclusionOf(await renderPage(await modelOf(baseline, [])));
  assert.match(conclusion, /<h2 id="conclusion-title">证据不足<\/h2>/);
  const words = text(conclusion);
  assert.ok(words.includes('判定依据：|相对 SPY 买入持有的账户年化对数增长差 95% 区间 −1.0% 至 40.0%，区间跨过门槛 0（门槛在看到结果前已冻结）'), words);
  assert.match(words, /同时：每笔扣费后净 R 均值 95% 区间 \+0\.12 R 至 \+0\.31 R，下沿高于门槛 \+0\.10 R/);
  assert.match(conclusion, /<strong>最大的限制：<\/strong>相对 SPY 买入持有的账户年化对数增长差的 95% 区间跨过判定门槛，现有样本不足以判定。/);
  assert.doesNotMatch(conclusion, /每笔净 R 的 95% 区间跨过门槛/, '限制行不得说「每笔净 R 区间跨门槛」：这份结果里 R 的下沿在门槛之上');
});

test('D5.1 夹具 SUPPORTED：依据行写下沿高于门槛的两条判据', async () => {
  const { baseline } = fixtureProjections({
    q1: false, q2: false,
    patch0: (doc) => { doc.verdict.state = 'SUPPORTED'; doc.verdict.L_R = 0.12; doc.verdict.L_g = 0.01; doc.verdict.reason_codes = ['STRESS_SCENARIO_MISSING']; return doc; },
  });
  assert.equal(baseline.conclusion.state, 'SUPPORTED');
  const conclusion = conclusionOf(await renderPage(await modelOf(baseline, [])));
  assert.match(conclusion, /<h2 id="conclusion-title">有支持证据<\/h2>/);
  const words = text(conclusion);
  const basis = words.slice(words.indexOf('判定依据：'));
  assert.ok(basis.includes('每笔扣费后净 R 均值 95% 区间 +0.12 R 至 +0.31 R，下沿高于门槛 +0.10 R'), basis);
  assert.ok(basis.includes('相对 SPY 买入持有的账户年化对数增长差 95% 区间 1.0% 至 40.0%，下沿高于门槛 0'), basis);
  assert.ok(basis.includes('门槛在看到结果前已冻结'));
  assert.doesNotMatch(basis.slice(0, basis.indexOf('最大的限制')), /跨过门槛|低于门槛/, 'SUPPORTED 的依据里没有「跨过」或「低于」');
  assert.match(conclusion, /<strong>最大的限制：<\/strong>/);
});

test('D1.4 对比卡也写「判定依据」：真实 Q1／Q2 是 INSUFFICIENT（G1），夹具 Q1／Q2 是 SUPPORTED', async () => {
  const real = realProjections();
  const realHtml = await renderPage(await modelOf(real.baseline, real.cards));
  const [realQ1, realQ2] = cardsOf(realHtml).map((card) => text(mainContent(card)));
  assert.match(realQ1, /优势结论：证据不足/);
  assert.match(realQ1, /判定依据：\|G1 不成立：主样本受影响交易 26 笔，低于门槛 30 笔/);
  assert.match(realQ1, /门槛在看到结果前已冻结/);
  assert.match(realQ2, /优势结论：证据不足/);
  assert.match(realQ2, /判定依据：\|G1 不成立：被改换载体的入场 26 笔，低于门槛 30 笔/);

  const fixture = fixtureProjections();
  const fixtureHtml = await renderPage(await modelOf(fixture.baseline, fixture.cards));
  const [fixtureQ1, fixtureQ2] = cardsOf(fixtureHtml).map((card) => text(mainContent(card)));
  assert.match(fixtureQ1, /优势结论：有支持证据/);
  assert.match(fixtureQ1, /判定依据：\|/);
  assert.match(fixtureQ1, /下沿高于门槛/);
  assert.match(fixtureQ2, /优势结论：完整账户的对数增长更好/);
  assert.match(fixtureQ2, /判定依据：\|/);
  assert.match(fixtureQ2, /下沿高于门槛/);
});

// ── D5.2：主内容没有已登记的英文原因码，未知码折叠 ──────────────────────────────────────────────

const registeredCodes = () => [...new Set([
  ...Object.keys(q0.internals.REASON_WORDS),
  ...Object.values(cc.QUESTIONS).flatMap((entry) => Object.keys(entry.reason_words)),
])];

test('D5.2 主内容（去掉所有 <details>）不含任何已登记的英文原因码：真实页面与夹具页面', async () => {
  const codes = registeredCodes();
  assert.ok(codes.length >= 10 && codes.includes('CI_STRADDLES_DELTA') && codes.includes('G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT'), codes.join(','));
  const real = realProjections();
  const fixture = fixtureProjections();
  for (const [name, projections] of [['真实', real], ['夹具', fixture]]) {
    const html = await renderPage(await modelOf(projections.baseline, projections.cards));
    const main = mainContent(html);
    for (const code of codes) assert.ok(!main.includes(code), `${name}页面主内容出现英文原因码 ${code}`);
    assert.doesNotMatch(main, /闸门代码/, '闸门代码收在折叠里');
  }
});

test('D1.3 未登记的原因码：主内容写「另有 N 个技术原因码（见技术详情）」，原码只在折叠的技术详情里', async () => {
  const { baseline } = fixtureProjections({
    q1: false, q2: false,
    patch0: (doc) => { doc.verdict.reason_codes = ['CI_STRADDLES_DELTA', 'FUTURE_UNREGISTERED_CODE_A', 'FUTURE_UNREGISTERED_CODE_B']; return doc; },
  });
  const html = await renderPage(await modelOf(baseline, []));
  const main = mainContent(html);
  assert.doesNotMatch(main, /FUTURE_UNREGISTERED_CODE/);
  assert.match(main, /另有 2 个技术原因码（见技术详情）/);
  assert.doesNotMatch(main, /CI_STRADDLES_DELTA/);
  const details = html.slice(html.indexOf('技术详情：未登记的原因码'));
  assert.match(details, /<code>FUTURE_UNREGISTERED_CODE_A<\/code>/);
  assert.match(details, /<code>FUTURE_UNREGISTERED_CODE_B<\/code>/);
});

// ── D5.3：计数 ──────────────────────────────────────────────────────────────────────────────

test('D5.3 真实页面计数：「页面不重算」恰好 1 次；三行结论块 = 1 + 锁定对比卡数；对比卡账户表没有 SPY／现金行', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  assert.equal(html.split('页面不重算').length - 1, 1, '整页只出现一次');
  assert.ok(researchSection(html).indexOf('页面不重算') > -1 && researchSection(html).indexOf('页面不重算') < researchSection(html).indexOf('<section class="backtest comparison"'), '放在研究区开头，早于第一张对比卡');
  assert.equal(cards.filter((card) => card.state === 'LOCKED_VERIFIED').length, 2);
  assert.equal((html.match(/class="completeness"/g) || []).length, 1 + 2, '顶部结论区块一份 + 每张锁定对比卡一份');
  const top = conclusionOf(html);
  assert.equal((top.match(/class="completeness"/g) || []).length, 1);
  const q0Card = between(html, '<section class="backtest" aria-labelledby="backtest-title">', 'id="diagnosis-title"');
  assert.equal((q0Card.match(/class="completeness"/g) || []).length, 0, 'Q0 卡第 6 块不再重复三行');

  const comparisonCards = cardsOf(html);
  assert.equal(comparisonCards.length, 2);
  for (const card of comparisonCards) {
    const account = blockOf(card, 'account');
    const rows = tableRows(account);
    assert.equal(rows.length, 3, '原版、候选、差值三行');
    assert.ok(rows.every((row) => !/SPY|现金/.test(row)), '账户表里没有 SPY／现金行');
    assert.match(account, /基准见回测结论卡/);
  }
});

test('D5.3 夹具页面计数：同样的计数断言（合成数字，两张锁定卡）', async () => {
  const { baseline, cards } = fixtureProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  assert.equal(html.split('页面不重算').length - 1, 1);
  const lockedCards = cards.filter((card) => card.state === 'LOCKED_VERIFIED').length;
  assert.equal(lockedCards, 2);
  const incomplete = baseline.conclusion.completeness && !baseline.conclusion.completeness.complete;
  assert.equal((html.match(/class="completeness"/g) || []).length, (incomplete ? 1 : 0) + lockedCards);
  for (const card of cardsOf(html)) {
    const rows = tableRows(blockOf(card, 'account'));
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => !/SPY|现金/.test(row)));
  }
});

test('D3.3 压力表：缺场景与无效输入的原因只在 Q0 卡写一次；对比卡写「同回测结论卡」，风控维度行默认折叠，与参照相同的行合并标注', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  const q0Stress = between(html, 'data-block="stress"', 'data-block="kelly"');
  assert.ok(q0Stress.includes('缺场景：'), 'Q0 卡完整写原因');
  for (const card of cardsOf(html)) {
    const main = mainContent(card);
    assert.match(main, /缺场景与无效输入同回测结论卡/);
    const stress = main.slice(main.indexOf('data-cmp-block="stress"'));
    assert.doesNotMatch(stress.slice(0, stress.indexOf('</article>')), /缺场景：|无效输入：/, '原因不在对比卡重复');
  }
  const all = cardsOf(html).join('');
  assert.match(all, /与参照相同/, '同时持仓 3 → 5 与参照行完全相同，合并标注');
  assert.match(all, /<summary>[^<]*风控维度[^<]*<\/summary>/, '风控维度行折叠');
});

// ── D4：状态一致 ────────────────────────────────────────────────────────────────────────────

test('D5.4 / D4.1 有锁定对比结果：页头标签与研究区开头按实际状态生成，页面里没有「暂无研究问题」', async () => {
  const { baseline, cards } = realProjections();
  const model = await modelOf(baseline, cards);
  const html = await renderPage(model);
  const sentence = '研究问题：Q1、Q2 已锁定；Q3、Q4 进行中（来源：Q0 诊断，协调会话立题）；尚未回到 Desk';
  assert.ok(html.slice(0, html.indexOf('class="conclusion')).includes(sentence), '页头标签');
  const lead = between(html, 'id="detail-research"', 'class="muted-note provenance"');
  assert.ok(lead.includes(`${sentence}。`), '研究区开头');
  assert.doesNotMatch(html, /暂无研究问题|暂无真实研究问题/);
  // 同一个句子生成于读模型，页面不拼
  assert.ok(model.views['strategy-detail'].research.answer.startsWith(sentence));
  assert.doesNotMatch(JSON.stringify(model.views['strategy-detail']), /暂无研究问题|暂无真实研究问题/);
});

test('D4.1 只锁定 Q1：「Q1 已锁定」，其余按 Q0 诊断清单里的实验状态生成', async () => {
  const { baseline, cards } = fixtureProjections({ q2: false });
  const html = await renderPage(await modelOf(baseline, cards));
  assert.match(text(html.slice(0, html.indexOf('class="conclusion'))), /研究问题：Q1 已锁定；/);
  assert.doesNotMatch(html, /暂无研究问题|暂无真实研究问题/);
});

test('D4.1 没有任何锁定对比结果时仍如实写「暂无研究问题」（不是一刀切删掉这句话）', async () => {
  reset();
  const html = await renderPage(await workspace.readModel({ strategyRef: STRATEGY, baseline: q0.emptyProjection('NOT_IMPORTED', 'x') }));
  assert.match(html, /暂无研究问题/);
  assert.doesNotMatch(html, /Q1 已锁定|Q1、Q2 已锁定/);
});

test('D4.2 HK 前向影子的行已被锁定结果读入：状态写「已在 Q1 结果中读入 N 行（只报不判）」，不写「尚未导入」', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  const forward = forwardSection(html);
  assert.match(forward, /已在 Q1 结果中读入 4 行（只报不判）/);
  assert.equal((forward.match(/已在 Q1 结果中读入 \d+ 行（只报不判）/g) || []).length, 2, 'B 流与 S 流两条影子各一行');
  assert.doesNotMatch(forward, /尚未导入/);
  assert.match(forward, /HK 上已在跑 2 条前向影子（2 条已在对比结果中读入，只报不判）/);
});

// ── D3 其余条款 ─────────────────────────────────────────────────────────────────────────────

test('D3.5–D3.6 胜率表默认只显示样本外各行（开发期折叠）；公式推算是行=假设胜率、列=假设赔率的紧凑网格', async () => {
  const { baseline } = realProjections();
  const html = await renderPage(await modelOf(baseline, []));
  const winrate = between(html, 'data-block="winrate"', 'data-block="stress"');
  const main = mainContent(winrate);
  assert.doesNotMatch(main, /开发期 [AB]/, '开发期各行不在主内容');
  assert.match(winrate, /<summary>开发期各行（\d+ 行；开发期，样本少，只报）<\/summary>/);
  assert.match(main, /样本外/);
  assert.match(main, /假设胜率 × 赔率（公式推算，不是回测）/);
  assert.match(main, /假设胜率 ＼ 假设赔率/);
  const grid = main.slice(main.indexOf('假设胜率 ＼ 假设赔率'));
  const rows = (grid.slice(0, grid.indexOf('</table>')).match(/<tr/g) || []).length;
  assert.ok(rows <= 8, `紧凑网格：表头加 7 行，实际 ${rows}`);
});

test('D3.7 当前身份与状态：去掉与页头重复的市场、运行模式、生命周期，只留 Research 关联与运行截至', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  const identity = between(html, '当前身份与状态', 'id="detail-health"');
  assert.match(identity, /Research 关联/);
  assert.match(identity, /运行截至/);
  assert.doesNotMatch(identity, /<dt>(?:市场|运行模式|生命周期)<\/dt>/);
});

test('D3.8 待验证问题清单：有对应实验的在前；「不立题 / 已知近似」折叠为「已知近似与不立题（N 条）」；数字不写 4 位以上小数', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  const list = between(html, 'id="diagnosis-title"', 'id="detail-health"');
  const main = mainContent(list);
  assert.match(list, /<summary>已知近似与不立题（\d+ 条）<\/summary>/);
  assert.doesNotMatch(main, /不立题：/, '不立题的条目不在主内容');
  assert.ok((main.match(/对应实验：/g) || []).length >= 4, '主内容里是有对应实验的条目');
  assert.doesNotMatch(main, /\d\.\d{4,}/, '数字最多两位小数');
  assert.doesNotMatch(list, /\d\.\d{5,}/, '折叠里也不写长小数');
  // 顺序：先实验，后折叠
  assert.ok(list.lastIndexOf('对应实验：', list.indexOf('已知近似与不立题')) > -1 && list.indexOf('已知近似与不立题') > list.indexOf('对应实验：'));
});

test('D3.9 前向行只写一句人话；key、type、hash 收进折叠', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  const q1 = mainContent(cardsOf(html)[0]);
  const forward = q1.slice(q1.indexOf('data-cmp-block="forward"'));
  assert.match(forward, /MSFU 10-09 入场，T3 推迟过时间止损，ΔR −1\.07/);
  assert.doesNotMatch(forward, /[0-9a-f]{64}|file_sha256|forward_stream|<code>/, 'key、type、hash 不在主内容');
  assert.doesNotMatch(forward, /（PREFIX_BROKEN）/);
  assert.match(cardsOf(html)[0], /<details>[\s\S]*?forward[\s\S]*?<\/details>|<summary>[^<]*(?:来源|技术)[^<]*<\/summary>/);
});

test('D3.10 最近实际运行：摘要保留（一笔交易、净结果、对账残差 0）；节点表与费用逐项收进折叠', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  const health = between(html, 'id="detail-health"', 'id="detail-research"');
  const main = mainContent(health);
  assert.match(main, /一笔真实纸面决策，已完成原生回放与净账户对账/);
  assert.match(main, /账户等式残差 0/);
  assert.match(main, /净结果/);
  assert.doesNotMatch(main, /<table/, '节点表不在主内容');
  assert.match(health, /<summary>账户节点表与费用逐项核对（明细）<\/summary>/);
});

test('D2 指标措辞：相对 <比较对象> 的年化对数增长差（95% 区间）；候选相对原版的年化对数增长差；每笔扣费后净 R 均值（门槛 +0.10 R）', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  const q0Card = between(html, '<section class="backtest" aria-labelledby="backtest-title">', 'id="diagnosis-title"');
  assert.match(q0Card, /相对 SPY 买入持有的年化对数增长差（95% 区间，门槛 0）/);
  assert.match(q0Card, /相对现金的年化对数增长差（95% 区间，门槛 0）/);
  assert.doesNotMatch(q0Card, /年化对数增长区间/);
  assert.match(conclusionOf(html), /样本外每笔扣费后净 R 均值（5 bps，生产相位；门槛 \+0\.10 R）/);
  const [q1, q2] = cardsOf(html).map(mainContent);
  assert.match(q1, /候选相对原版的年化对数增长差/);
  assert.match(q2, /候选相对原版的年化对数增长差（主判据）/);
  assert.match(q2, /每笔扣费后净 R 均值（门槛 \+0\.10 R，候选臂自身）/);
});

test('A4 只改呈现：真实 Q0／Q1／Q2 的结果编号、判定和锁字段不变', () => {
  const { baseline, cards } = realProjections();
  assert.equal(baseline.conclusion.state, 'NOT_PASSED');
  assert.deepEqual(cards.map((card) => [card.question_ref, card.verdict_state]), [['Q1', 'INSUFFICIENT'], ['Q2', 'INSUFFICIENT']]);
  assert.equal(cards[0].result_id, 'Q1-52d8296ffb10626b');
  assert.match(cards[1].result_id, /^Q2-[0-9a-f]{16}$/);
  assert.ok(cards.every((card) => card.state === 'LOCKED_VERIFIED'));
});
