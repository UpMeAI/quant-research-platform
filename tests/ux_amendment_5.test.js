'use strict';
/**
 * UX 修订 5（CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_5）F 确定性验收。
 * 只验呈现：读者八问对应的算式、口径、说明与研究队列。数字全部来自封存结果文件，页面只格式化，不重算。
 * 真实文件：仓库里封存的 Q0／Q1／Q2；Q3／Q4 的封存文件在本机 var/evidence 里时一并读入（不在时那几条只用夹具测）。
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
const notes = require('../services/strategy-detail-notes');
const fx0 = require('./_q0_fixture');
const fx1 = require('./_q1_fixture');
const fx3 = require('./_q3_fixture');

const CASE = cc.CASE_REF;
const STRATEGY = cc.STRATEGY_REF;
const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
const REAL = {
  q0: path.join(ROOT, 'var/evidence/us-v5-m2-q0-current-2026-10-25/US_V5_M2_Q0_RESULT_V1.json'),
  q1: path.join(ROOT, 'var/evidence/us-v5-m2-q1-2026-10-25/US_V5_M2_Q1_RESULT_V1.json'),
  q2: path.join(ROOT, 'var/evidence/us-v5-m2-q2-2026-10-25/US_V5_M2_Q2_RESULT_V1.json'),
  q3: path.join(ROOT, 'var/evidence/us-v5-m2-q3-2026-10-26/US_V5_M2_Q3_RESULT_V1.json'),
  q4: path.join(ROOT, 'var/evidence/us-v5-m2-q4-2026-10-26/US_V5_M2_Q4_RESULT_V1.json'),
};
const HAVE_Q3_Q4 = fs.existsSync(REAL.q3) && fs.existsSync(REAL.q4);
const RAW_Q0 = JSON.parse(fs.readFileSync(REAL.q0, 'utf8'));

const RECOVERED_NOTE = '对比的是区间内到过的最高权益，不是起始本金。未恢复 = 期末仍低于此前最高点。'; // 勘误 1 E3.1
const INSUFFICIENT_NOTE = '证据不足 = 95% 区间跨过了事先冻结的门槛，既不能说更好也不能说更差；不等于否定。常见原因是样本太少，或者改动只影响少数交易。';

loop.openCase({
  case_id: CASE, strategy_ref: STRATEGY, market: 'US_EQUITY',
  runtime_lane: { source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64), version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
  baseline: {
    baseline_id: 'BASELINE-A5-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY', version_ref: 'US_V5_ETF_6000USD@frozen-old',
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
const textOf = (html) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
const between = (html, from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const conclusionOf = (html) => between(html, 'class="conclusion', 'class="section-nav');
const blockOfQ0 = (html, key) => between(html, `data-block="${key}"`, '<article class="bt-block"');
const researchSection = (html) => between(html, 'id="detail-research"', 'id="detail-forward"');
const cardsOf = (html) => researchSection(html).split('<section class="backtest comparison').slice(1);
const cmpBlock = (card, key) => {
  const start = card.indexOf(`data-cmp-block="${key}"`);
  const next = card.indexOf('data-cmp-block="', start + 10);
  return card.slice(start, next === -1 ? undefined : next);
};
// 页面的格式化（与 index.html 的 pct／pctM／num 相同）：只用于写出期望值
const pct1 = (value) => `${(value * 100).toFixed(1)}%`;
const pctSigned = (value) => `${value < 0 ? '−' : ''}${(Math.abs(value) * 100).toFixed(1)}%`;

const reset = () => { for (const ledger of [q0.LEDGER(), cc.LEDGER()]) fs.rmSync(ledger, { force: true }); q0.clearCache(); cc.clearCache(); };
const modelOf = (baseline, comparison) => workspace.readModel({ strategyRef: STRATEGY, baseline, comparison });

/** 真实 Q0 + Q1 + Q2（+ 本机有时的 Q3、Q4），和线上页面读到的是同一批封存文件。 */
function realProjections({ withQ3Q4 = HAVE_Q3_Q4 } = {}) {
  reset();
  const baseline = q0.buildProjection(q0.importBaselineEvaluation(REAL.q0, { registeredBy: AUTHORITY }));
  const files = [REAL.q1, REAL.q2, ...(withQ3Q4 ? [REAL.q3, REAL.q4] : [])];
  const cards = files.map((file) => {
    const lock = cc.importCandidateComparison(file, { registeredBy: AUTHORITY });
    return cc.buildProjection(lock, { question: lock.question_ref });
  });
  return { baseline, cards };
}

/** 合成 Q0（可改）+ 合成 Q1 + 合成 Q3（带随机对照卡）。 */
function fixtureProjections({ patch0 = () => {} } = {}) {
  reset();
  const doc0 = fx0.result(patch0);
  const lock0 = q0.importBaselineEvaluation(fx0.write(doc0), { registeredBy: AUTHORITY, allowNonActual: true });
  const baseline = q0.buildProjection(lock0, { allowNonActual: true });
  const build = (lock) => cc.buildProjection(lock, { allowNonActual: true, question: lock.question_ref });
  const cards = [
    build(cc.importCandidateComparison(fx1.write(fx1.result(doc0, lock0.file_sha256, lock0.result_id)), { registeredBy: AUTHORITY, allowNonActual: true })),
    build(cc.importCandidateComparison(fx3.write(fx3.result(doc0, lock0.file_sha256, lock0.result_id)), { registeredBy: AUTHORITY, allowNonActual: true })),
  ];
  return { baseline, cards };
}

// ── E1 半凯利：算式与代入的下沿 ─────────────────────────────────────────────────────────────

test('E1 真实 Q0：算式行在结论行之前，数值等于结果文件的 p_ci 下沿、b_ci 下沿与 f_star；p、b 与胜率表主行相同', async () => {
  const { baseline } = realProjections({ withQ3Q4: false });
  const k = RAW_Q0.half_kelly;
  const kelly = mainContent(blockOfQ0(await renderPage(await modelOf(baseline, [])), 'kelly'));
  const formula = kelly.indexOf('凯利比例 f* = p − (1 − p) ÷ b，p 为样本外胜率，b 为赔率。');
  const plugged = `按保守下沿 p = ${pct1(k.p_ci[0])}、b = ${k.b_ci[0].toFixed(2)}，f* = ${pctSigned(k.f_star)}。`;
  assert.equal(plugged, '按保守下沿 p = 24.1%、b = 1.74，f* = −19.6%。', '与修订 5 E1.1 的示例一致');
  assert.ok(formula > -1 && kelly.includes(plugged), kelly);
  assert.ok(k.f_star <= 0);
  assert.match(kelly, /f\* ≤ 0 → 半凯利 = 0：长期看下注越多亏得越多，不支持按凯利加仓/);
  assert.ok(formula < kelly.indexOf('class="kelly-line"'), '算式在结论行之前');
  // 来源行：结果文件里 OOS、5 bps、生产相位那一行的胜率与赔率就是 half_kelly 的 p、b（只比对，不另算）
  const main = RAW_Q0.stats.rows.find((row) => row.segment === 'OOS' && row.cost_bps === 5 && row.phase === 'PRODUCTION');
  assert.equal(main.win_rate, k.p);
  assert.equal(main.payoff, k.b);
  assert.match(kelly, /这里的 p、b 与上面「胜率与赔率」表样本外、生产相位、基础成本（5 bps）那一行相同。/);
  // E1.3：固定每笔风险的路径区间与跌破底线的概率照旧显示，标明重抽样路径
  const fixed = kelly.slice(kelly.indexOf('按现行固定'));
  assert.match(fixed, /重抽样路径，不是预测（10000 条路径）/);
  assert.match(fixed, /期末资本区间/);
  assert.match(fixed, /跌破 US\$1,800 的概率/);
  assert.match(fixed, /3\.5%/);
});

test('E1 夹具：f* > 0 时写结果文件的半凯利；p、b 与胜率表主行对不上时如实写，以结果文件为准', async () => {
  let { baseline } = fixtureProjections();
  let kelly = mainContent(blockOfQ0(await renderPage(await modelOf(baseline, [])), 'kelly'));
  assert.match(kelly, /按保守下沿 p = 42\.0%、b = 1\.50，f\* = 24\.0%。/);
  assert.match(kelly, /f\* > 0 → 半凯利 = 6\.0%（结果文件的半凯利比例）/);
  assert.match(kelly, /基础成本（5 bps）那一行相同/);
  ({ baseline } = fixtureProjections({ patch0: (doc) => { doc.half_kelly.p = 0.49; } }));
  assert.equal(baseline.blocks.find((block) => block.key === 'kelly').data.source_row, null);
  kelly = mainContent(blockOfQ0(await renderPage(await modelOf(baseline, [])), 'kelly'));
  assert.match(kelly, /对不上，以结果文件为准/);
});

// ── E2 比较对象的口径 ─────────────────────────────────────────────────────────────────────

test('E2 真实 Q0：账户表下方写 SPY 买入持有的定义与「含分红（复权价）」；口径绑定这份结果文件，有引擎 file:line 依据', async () => {
  const { baseline } = realProjections({ withQ3Q4: false });
  const account = baseline.blocks.find((block) => block.key === 'account').data;
  const spy = account.comparator_notes.find((note) => note.key === 'SPY_BUY_HOLD');
  assert.equal(spy.dividend, 'TOTAL_RETURN');
  assert.ok(spy.evidence.some((line) => /us-v5-m2-q0-current\.js:250-265/.test(line) && /adjclose/.test(line)), spy.evidence.join('\n'));
  // 登记绑定的就是线上锁定的那份 Q0 文件
  const entry = notes.forStrategy(STRATEGY).comparators.SPY_BUY_HOLD.dividend_basis[0];
  assert.equal(entry.result_sha256, baseline.source.file_sha256);
  // 结果文件自己也写了总收益与 adjclose（登记不与文件矛盾）
  assert.match(RAW_Q0.arms.window.book_zh, /SPY 总收益/);
  assert.match(RAW_Q0.arms.SPY_BUY_HOLD.source.note_zh, /adjclose/);
  const html = mainContent(blockOfQ0(await renderPage(await modelOf(baseline, [])), 'account'));
  assert.ok(html.indexOf('SPY 买入持有 = 同本金、同起点一次买入，一直持有到区间结束，中间没有任何买卖。分红口径：含分红（复权价）。') > html.indexOf('</table>'), '口径行在账户表下方');
  assert.equal(baseline.diagnosis.items.filter((item) => /^BASIS-/.test(item.id)).length, 0, '已登记口径时不加待核实项');
});

test('E2 未登记的结果文件：页面写「分红口径未记录」，并列进待验证问题清单；Q3 参照臂仍写「价格收益，不含分红」', async () => {
  const { baseline, cards } = fixtureProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  assert.match(mainContent(blockOfQ0(html, 'account')), /分红口径：分红口径未记录。/);
  const item = baseline.diagnosis.items.find((row) => row.id === 'BASIS-SPY_BUY_HOLD');
  assert.ok(item && item.state_label === '待验证，不是结论' && /分红口径未记录/.test(item.facts[0]), JSON.stringify(item));
  assert.match(between(html, 'id="diagnosis-title"', 'id="detail-health"'), /SPY 买入持有的分红口径在结果文件与说明登记里都没有记录/);
  const q3 = cardsOf(html).find((card) => card.includes('行业 RS 排序层'));
  assert.match(mainContent(cmpBlock(q3, 'account')), /价格收益，不含分红；只报，不判/);
});

// ── E3（勘误 1 替换）「期末是否回到最高点」 ─────────────────────────────────────────────────

test('E3（勘误 1）真实页面：列名「期末是否回到最高点」，每个列头都带说明；账户表与压力表下各有一行脚注；不再出现「是否已恢复」列', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  const heads = [...html.matchAll(/<th scope="col"([^>]*)>(期末是否回到最高点)<\/th>/g)];
  assert.ok(heads.length >= 2 + cards.length, String(heads.length)); // Q0 账户表、Q0 压力表、每张对比卡的账户表
  for (const head of heads) assert.equal(head[1], ` title="${RECOVERED_NOTE}"`);
  assert.doesNotMatch(html, />是否已恢复<\/th>|>期末是否恢复<\/th>/);
  assert.ok(mainContent(blockOfQ0(html, 'account')).includes(`「期末是否回到最高点」：${RECOVERED_NOTE}`));
  assert.ok(mainContent(blockOfQ0(html, 'stress')).includes(`「期末是否回到最高点」：${RECOVERED_NOTE}压力行只封存了汇总数字、没有权益序列`));
});

test('E3（勘误 1）真实 Q0：最高点与距最高点由服务端从封存权益序列读出；本策略 3,726.59（2024-10-30）→ 3,417.93，−8.3%；SPY 6,406.19（2026-10-06），−2.5%；现金已恢复', async () => {
  const { baseline } = realProjections({ withQ3Q4: false });
  const arms = new Map(baseline.blocks.find((block) => block.key === 'account').data.arms.map((arm) => [arm.key, arm]));
  const d = arms.get('D');
  assert.equal(d.recovered, false);
  assert.equal(d.peak.value.toFixed(2), '3726.59');
  assert.equal(d.peak.date, '2024-10-30');
  assert.equal(d.peak.end.toFixed(2), '3417.93');
  assert.equal((d.peak.gap * 100).toFixed(1), '-8.3');
  const spy = arms.get('SPY_BUY_HOLD');
  assert.equal(spy.recovered, false);
  assert.equal(spy.peak.value.toFixed(2), '6406.19');
  assert.equal(spy.peak.date, '2026-10-06');
  assert.equal((spy.peak.gap * 100).toFixed(1), '-2.5');
  assert.equal(arms.get('CASH').recovered, true);
  // 读数就是序列的最大值、它第一次出现的日期，以及之后的交易日数（与文件里的权益序列逐点核对）
  const series = RAW_Q0.arms.D.equity;
  const max = Math.max(...series.values);
  assert.equal(d.peak.value, max);
  assert.equal(d.peak.date, series.dates[series.values.indexOf(max)]);
  assert.equal(d.peak.sessions_since, series.values.length - 1 - series.values.indexOf(max));
  const rows = (mainContent(blockOfQ0(await renderPage(await modelOf(baseline, [])), 'account')).match(/<tr><td>[\s\S]*?<\/tr>/g) || []);
  const row = (label) => rows.find((item) => item.startsWith(`<tr><td>${label}</td>`));
  assert.ok(row('本策略').includes(`未恢复<br><span class="muted-inline">距最高点 −8.3%；最高点在 2024-10-30，已过去 ${d.peak.sessions_since} 个交易日</span>`), row('本策略'));
  assert.ok(row('SPY 买入持有').includes(`未恢复<br><span class="muted-inline">距最高点 −2.5%；最高点在 2026-10-06，已过去 ${spy.peak.sessions_since} 个交易日</span>`), row('SPY 买入持有'));
  assert.ok(row('现金').endsWith('<td>已恢复</td></tr>'), row('现金'));
});

// ── E4 开发期折叠 ───────────────────────────────────────────────────────────────────────

test('E4 真实 Q0：表头上方写「结论只用样本外判定；开发期只报不判。」；折叠控件写「开发期 N 行（样本少，只报）——点开查看」并带笔数', async () => {
  const { baseline } = realProjections({ withQ3Q4: false });
  const winrate = blockOfQ0(await renderPage(await modelOf(baseline, [])), 'winrate');
  const main = mainContent(winrate);
  assert.ok(main.indexOf('<p class="muted-note">结论只用样本外判定；开发期只报不判。</p>') > -1 && main.indexOf('结论只用样本外判定') < main.indexOf('<table'));
  const dev = RAW_Q0.stats.rows.filter((row) => row.segment !== 'OOS');
  const at = (segment) => RAW_Q0.stats.rows.find((row) => row.segment === segment && row.cost_bps === 5 && row.phase === 'PRODUCTION').n;
  const summary = `<summary>开发期 ${dev.length} 行（样本少，只报）——点开查看 · 笔数：开发期 A ${at('IS-a')} 笔、开发期 B ${at('IS-b')} 笔（5 bps，生产相位）</summary>`;
  assert.equal(summary, '<summary>开发期 8 行（样本少，只报）——点开查看 · 笔数：开发期 A 45 笔、开发期 B 4 笔（5 bps，生产相位）</summary>');
  assert.ok(winrate.includes(summary), winrate.slice(winrate.indexOf('<summary>'), winrate.indexOf('</summary>') + 10));
  assert.doesNotMatch(winrate, /<details[^>]*\sopen/, '开发期仍默认折叠（修订 4 D3.5）');
});

// ── E5 缺场景与无效输入 ─────────────────────────────────────────────────────────────────────

test('E5 真实 Q0：2008 与 2020 两行都有白话原因与能否补；结果文件原文收进折叠；对比卡照旧写「原因同回测结论卡」', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  const stress = blockOfQ0(html, 'stress');
  const rows = mainContent(stress).match(/<tr class="missing-scenario">[\s\S]*?<\/tr>/g);
  assert.equal(rows.length, 2);
  const row2008 = rows.find((row) => row.includes('2008-09 → 2009-03'));
  const row2020 = rows.find((row) => row.includes('2020-02-19 → 04-30'));
  assert.ok(row2008.includes('缺场景：当时本策略的大部分交易载体（杠杆 ETF、2× 单股 ETF）还不存在，按 Owner 规则也不重拉历史；只能用合成载体做模拟（见模拟行），不计为已执行的压力。'), row2008);
  assert.ok(row2008.includes('<strong>能否补：</strong>不可补：载体当时不存在'), row2008);
  assert.ok(row2020.includes('无效输入：数据从 2019-06-03 起，开局规则要先积累 250 根日线，2020-05-29 前没有可交易载体，这段一笔交易都开不出来。'), row2020);
  assert.ok(row2020.includes('<strong>能否补：</strong>可补，已立项：缓存向前延伸，只取缺的那一段，不是重拉'), row2020);
  // 结果文件的原文仍在，只是收进折叠（不改文件里的原因）
  assert.match(stress, /<summary>结果文件原文<\/summary><div class="detail-body"><p>2007–2009 行业 ETF 日线在 Mac 与 HK 均无/);
  assert.doesNotMatch(mainContent(stress), /AC8 记为缺场景/);
  for (const card of cardsOf(html).filter((item) => item.includes('data-cmp-block="stress"'))) {
    assert.match(cmpBlock(card, 'stress'), /缺场景与无效输入同回测结论卡/);
  }
});

test('E5 没有登记的缺场景：页面写结果文件的原因和「能否补：未登记」，不自行判断', async () => {
  const { baseline } = fixtureProjections();
  const stress = mainContent(blockOfQ0(await renderPage(await modelOf(baseline, [])), 'stress'));
  assert.match(stress, /缺场景：2007–2009 行业 ETF 日线在 Mac 与 HK 均无，按 Owner 规则不重新拉取<br><span class="stress-fill"><strong>能否补：<\/strong>未登记<\/span>/);
});

// ── E6「证据不足」的含义 ────────────────────────────────────────────────────────────────────

test('E6 真实页面：每张对比卡的结论块在第一次出现「证据不足」之后有一行固定说明；结论为「未通过」的顶部区块不加', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  assert.doesNotMatch(conclusionOf(html), /证据不足/);
  assert.ok(!conclusionOf(html).includes(INSUFFICIENT_NOTE));
  const mains = cardsOf(html).filter((card) => card.includes('data-cmp-block="verdict"'));
  assert.equal(mains.length, cards.length);
  for (const card of mains) {
    const verdict = mainContent(cmpBlock(card, 'verdict'));
    assert.equal(verdict.split(INSUFFICIENT_NOTE).length - 1, 1, '每个结论块只加一次');
    const note = verdict.indexOf(INSUFFICIENT_NOTE);
    assert.ok(verdict.indexOf('证据不足') < note && verdict.lastIndexOf('</ul>', note) > verdict.indexOf('证据不足'), '紧跟在第一次出现「证据不足」的那一段之后');
  }
});

test('E6 夹具 INSUFFICIENT 的顶部结论区块：说明紧跟在标题「证据不足」之后', async () => {
  const { baseline } = fixtureProjections();
  assert.equal(baseline.conclusion.state, 'INSUFFICIENT');
  const conclusion = conclusionOf(await renderPage(await modelOf(baseline, [])));
  assert.ok(conclusion.includes(`<h2 id="conclusion-title">证据不足</h2><p class="insufficient-note">${INSUFFICIENT_NOTE}</p>`), conclusion.slice(0, 400));
  assert.equal(conclusion.split(INSUFFICIENT_NOTE).length - 1, 1);
});

// ── E7 研究队列与中文题名 ───────────────────────────────────────────────────────────────────

test('E7 真实页面：研究区开头有「研究队列」小表，Q1–Q5 五行（Q5 写自己的来源），列为题号／研究部分／中文题名／来源／状态', async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  const section = researchSection(html);
  const queue = between(section, '<div class="research-queue">', '</table>');
  assert.ok(section.indexOf('<div class="research-queue">') < section.indexOf('<section class="backtest comparison'), '队列表在卡片之前');
  assert.match(queue, /<th scope="col">题号<\/th><th scope="col">对应的研究部分<\/th><th scope="col">中文题名<\/th><th scope="col">来源<\/th><th scope="col">状态<\/th>/);
  const rows = (queue.match(/<tr><td>[\s\S]*?<\/tr>/g) || []).map((row) => textOf(row).split('|').filter(Boolean));
  const source = 'Q0 诊断，协调会话按 Owner 2026-10-25 授权立题';
  const locked = new Map(cards.map((card) => [card.question_ref, `已锁定：${card.verdict_label}`]));
  assert.deepEqual(rows, [
    ['Q1', '进出规则', '趋势中推迟时间止损', source, locked.get('Q1')],
    ['Q2', '杠杆与载体', '换成 1 倍载体（收益来自信号还是杠杆）', source, locked.get('Q2')],
    ['Q3', '选标的', '选对象了吗：随机对照与行业 RS 排序', source, locked.get('Q3') || '进行中'],
    ['Q4', '风控', '冷却只在开仓时武装', source, locked.get('Q4') || '进行中'],
    ['Q5', '组合验证（进出规则 + 风控）', '在冷却只在开仓时武装之上，趋势中推迟时间止损', 'Owner 2026-10-26 同意先跑 Q1+A25 组合验证（第二轮）', locked.get('Q5') || '进行中'],
  ]);
  // 卡片标题用中文题名
  const main = mainContent(section);
  assert.match(main, /<h3 id="comparison-title">候选对比：「趋势中推迟时间止损」对原版<\/h3>/);
  assert.match(main, /<h3 id="comparison-title-Q2">候选对比：换成 1 倍载体对原版（收益来自信号还是杠杆）<\/h3>/);
  if (HAVE_Q3_Q4) assert.match(main, /<h3 id="comparison-title-Q4">候选对比：冷却只在开仓时武装对原版<\/h3>/);
});

/** 修订 4 D5.2 已登记的英文原因码（主内容不得出现）。 */
const registeredCodes = () => [...new Set([
  ...Object.keys(q0.internals.REASON_WORDS),
  ...Object.values(cc.QUESTIONS).flatMap((entry) => Object.keys(entry.reason_words)),
])];

test('F2 真实页面与夹具页面：主内容（去掉所有 <details>）不含 X1、T3，也不含已登记的英文原因码；代号只留在折叠的技术详情里', async () => {
  const codes = registeredCodes();
  for (const [name, projections] of [['真实', realProjections()], ['夹具', fixtureProjections()]]) {
    const html = await renderPage(await modelOf(projections.baseline, projections.cards));
    const main = textOf(mainContent(html));
    assert.doesNotMatch(main, /T3|X1/, `${name}页面主内容出现内部代号：${(main.match(/.{0,40}(?:T3|X1).{0,40}/) || [''])[0]}`);
    for (const code of codes) assert.ok(!main.includes(code), `${name}页面主内容出现英文原因码 ${code}`);
    if (name === '真实') assert.match(html, /<details[\s\S]*?rule：T3[\s\S]*?<\/details>/, '规则代号仍在折叠的技术字段里');
  }
});

// ── E8 随机选择对照 ─────────────────────────────────────────────────────────────────────────

const RC_INTRO = (n) => `<dl class="rc-intro"><dt>回答的问题</dt><dd>这套选标的的方法，是否比随便挑更好。</dd><dt>做法</dt><dd>信号和开仓时点不变，每次开仓时改为从当时可交易的同方向标的里随机挑一个，重复 ${n} 次。</dd><dt>判法</dt><dd>真实策略胜过 ≥ 75% 的随机版本 → 有支持；≤ 50% → 不比随机好；介于两者之间 → 证据不足。</dd></dl>`;

test('E8 夹具：随机对照卡开头先说回答什么、怎么做、怎么判；Q3a 另写它只打乱同一时刻的处理顺序与样本外时刻数', async () => {
  const { baseline, cards } = fixtureProjections();
  const rc = cards.find((card) => card.question_ref === 'Q3').extra_cards.find((card) => card.key === 'random_control').data;
  const html = await renderPage(await modelOf(baseline, cards));
  const card = html.slice(html.indexOf('class="backtest comparison random-control"'));
  const n = rc.parts.find((part) => part.key === 'Q3A2').seeds.n;
  assert.ok(card.includes(RC_INTRO(n)), card.slice(0, 900));
  assert.ok(card.indexOf('rc-intro') < card.indexOf('data-rc-part'), '说明在各部分之前');
  const q3a = rc.parts.find((part) => part.key === 'Q3A');
  const scope = `它只打乱同一时刻候选的处理顺序；样本外这种时刻${q3a.g1.met ? `有 ${q3a.g1.oos} 个` : `只有 ${q3a.g1.oos} 个，不足以下结论`}。`;
  assert.ok(between(card, 'data-rc-part="Q3A"', '</article>').includes(`<p class="rc-scope">${scope}</p>`));
});

test('E8 真实 Q3（本机有封存文件时）：重复 1000 次；Q3a 样本外只有 7 个这种时刻，不足以下结论', { skip: !HAVE_Q3_Q4 }, async () => {
  const { baseline, cards } = realProjections();
  const html = await renderPage(await modelOf(baseline, cards));
  const card = html.slice(html.indexOf('class="backtest comparison random-control"'));
  assert.ok(card.includes(RC_INTRO(1000)));
  assert.ok(between(card, 'data-rc-part="Q3A"', '</article>').includes('<p class="rc-scope">它只打乱同一时刻候选的处理顺序；样本外这种时刻只有 7 个，不足以下结论。</p>'));
});

// ── F3 页面不重算 ───────────────────────────────────────────────────────────────────────────

test('F3 页面不重算：半凯利算式只格式化文件里的 p_ci 下沿、b_ci 下沿与 f_star；页面脚本里没有凯利、样本量或区间的计算', () => {
  const formula = SCRIPT.slice(SCRIPT.indexOf('function kellyFormula'), SCRIPT.indexOf('\n}', SCRIPT.indexOf('function kellyFormula')));
  assert.ok(formula.length > 100);
  // 只出现 pct／num／pctM 的格式化与 f_star 和 0 的比较；没有对 p、b 的四则运算
  assert.doesNotMatch(formula, /d\.(?:p|b|p_ci|b_ci|f_star|f_half)(?:\.\w+)?\s*[-+*/](?!>)/);
  assert.doesNotMatch(formula, /[-+*/]\s*d\.(?:p|b|p_ci|b_ci|f_star|f_half)\b/);
  assert.match(formula, /pct\(d\.p_ci\.lo,1\)/);
  assert.match(formula, /num\(d\.b_ci\.lo\)/);
  assert.match(formula, /pctM\(d\.f_star,1\)/);
  // 整个页面脚本：没有开方、对数、正态分位数或所需样本量（区间与样本量都只能来自结果文件）
  assert.doesNotMatch(SCRIPT, /Math\.(?:sqrt|log|exp|pow)\b|1\.96|所需样本/);
});

test('F4 只改呈现：真实 Q0–Q2（本机有时含 Q3、Q4）的结果编号、判定与锁字段不变', () => {
  const { baseline, cards } = realProjections();
  assert.equal(baseline.result_id, 'Q0-2604282b935f85d3');
  assert.equal(baseline.conclusion.state, 'NOT_PASSED');
  const expected = [['Q1', 'Q1-52d8296ffb10626b'], ['Q2', 'Q2-02796a4366aa0263'], ...(HAVE_Q3_Q4 ? [['Q3', 'Q3-0892bfe4891c0a37'], ['Q4', 'Q4-b6873221019ec167']] : [])];
  assert.deepEqual(cards.map((card) => [card.question_ref, card.result_id]), expected);
  assert.ok(cards.every((card) => card.state === 'LOCKED_VERIFIED' && card.verdict_state === 'INSUFFICIENT'));
});
