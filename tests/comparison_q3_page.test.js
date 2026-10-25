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
const fx3 = require('./_q3_fixture');

const CASE = cc.CASE_REF;
const STRATEGY = cc.STRATEGY_REF;
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));

loop.openCase({
  case_id: CASE, strategy_ref: STRATEGY, market: 'US_EQUITY',
  runtime_lane: { source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64), version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
  baseline: {
    baseline_id: 'BASELINE-Q3-PAGE-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY', version_ref: 'US_V5_ETF_6000USD@frozen-old',
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

/** 真实导入、真实投影的 Q0 + Q1 + Q3（合成数字）；Q0 的清单里多一条指向 Q3 的待验证问题。 */
function projections({ q1 = true, q3 = true, mutateQ3 } = {}) {
  for (const ledger of [q0.LEDGER(), cc.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); cc.clearCache();
  const q0Doc = fx0.result((doc) => {
    doc.diagnosis_items.push({ id: 'DX4', source: 'SELECTION', facts: ['同一扫描时点候选之间没有排名，开仓顺序就是文件顺序'], proposed_experiment: 'Q3', no_topic_reason: null });
  });
  const q0Lock = q0.importBaselineEvaluation(fx0.write(q0Doc), { registeredBy: AUTHORITY, allowNonActual: true });
  const baseline = q0.buildProjection(q0Lock, { allowNonActual: true });
  const build = (lock) => cc.buildProjection(lock, { allowNonActual: true, question: lock.question_ref });
  const cards = [];
  let file3 = null;
  let lock3 = null;
  if (q1) cards.push(build(cc.importCandidateComparison(fx1.write(fx1.result(q0Doc, q0Lock.file_sha256, q0Lock.result_id)), { registeredBy: AUTHORITY, allowNonActual: true })));
  if (q3) {
    file3 = fx3.write(fx3.result(q0Doc, q0Lock.file_sha256, q0Lock.result_id, mutateQ3));
    lock3 = cc.importCandidateComparison(file3, { registeredBy: AUTHORITY, allowNonActual: true });
    cards.push(build(lock3));
  }
  return { baseline, cards, file3, lock3, build };
}
const modelOf = (baseline, comparison) => workspace.readModel({ strategyRef: STRATEGY, baseline, comparison });
const Q3_TITLE = '候选对比：行业 RS 排序层对原版（选对象了吗）';
const RC_TITLE = '随机选择对照（Q3a 候选顺序随机；Q3a2 随机标的）';

test('Q3 锁定：「研究与对比」里 Q1 主卡、Q3 主卡、随机对照卡三张，按这个顺序；Q3 主卡八块，随机对照卡两个部分', async () => {
  const { baseline, cards } = projections();
  const html = await renderPage(await modelOf(baseline, cards));
  const section = researchSection(html);
  assert.equal((section.match(/<section class="backtest comparison/g) || []).length, 3);
  assert.deepEqual([...section.matchAll(/data-cmp-block="(\w+)"/g)].map((match) => match[1]), [
    'question', 'account', 'effect', 'criteria', 'stress', 'verdict', 'forward',
    'question', 'account', 'effect', 'exposure', 'criteria', 'stress', 'verdict', 'forward',
  ]);
  assert.deepEqual([...section.matchAll(/data-rc-part="(\w+)"/g)].map((match) => match[1]), ['Q3A', 'Q3A2']);
  const positions = ['候选对比：T3 对原版', Q3_TITLE, RC_TITLE].map((title) => section.indexOf(title));
  assert.ok(positions.every((position) => position > -1) && positions[0] < positions[1] && positions[1] < positions[2], JSON.stringify(positions));
  assert.match(section, /id="comparison-title-Q3"/);
  assert.match(section, /id="extra-random_control-title"/);
  assert.equal((section.match(/id="comparison-title"/g) || []).length, 1, 'id 不重复');
  assert.deepEqual([...html.matchAll(/data-block="(\w+)"/g)].map((match) => match[1]), ['period', 'account', 'winrate', 'stress', 'kelly', 'verdict'], 'Q0 卡不动');
});

test('Q3 主卡的主内容：同窗复测的标注、优势结论、三行分开、参照行「价格收益，不含分红」、敞口表里的行业 RS 两行', async () => {
  const { baseline, cards } = projections();
  const html = await renderPage(await modelOf(baseline, cards));
  const card = cardOf(researchSection(html), Q3_TITLE);
  const main = mainContent(card);
  assert.match(main, /<span class="pill warn">同窗复测，不是新的样本外<\/span> RS-1 已在同一窗口（2023-01-01 → 2026-09-30）评价过同一规则；本题是在当前 D 上的复测。/);
  assert.match(main, /<span class="pill ok">优势结论：完整账户的对数增长更好（不等于信号 alpha 更大）<\/span>/);
  assert.match(main, /<li class="warn">压力评价不完整：缺场景 1 个、无效输入 1 个（/);
  assert.match(main, /<li class="bad">采用条件：未满足（必要压力缺失，§6\.7）<\/li>/);
  assert.doesNotMatch(main, /独立样本不足|样本外未被复用|Bonferroni|98\.33%|最低改善量/);
  // 账户表：四个比较臂 + 差 + 参照行（只报，不判）
  const account = main.slice(main.indexOf('data-cmp-block="account"'), main.indexOf('data-cmp-block="effect"'));
  assert.match(account, /<strong>候选 − 原版<\/strong>/);
  assert.match(account, /等权买入持有（15 只 1× 多头）<br><span class="muted-inline">价格收益，不含分红；只报，不判<\/span>/);
  assert.ok(account.indexOf('候选 − 原版') < account.indexOf('等权买入持有'), '参照行在差值行之后，不进差值');
  assert.match(account, /<td>14\.0%<\/td><td>19\.0%<\/td>/);
  // 敞口：行业 RS 的两行
  assert.match(main, /行业 RS 拒绝数（SECTOR_RS_NOT_TOP_N）<\/td><td>—<\/td><td>31 次<\/td><td>—<\/td>/);
  assert.match(main, /名次重排的时点数<\/td><td>—<\/td><td>12 个<\/td><td>—<\/td>/);
  assert.match(main, /<strong>G1 · /);
  assert.match(main, /A23 未开启，HK 没有排序层前向/);
  assert.match(main, /改变的入场 41 笔/);
  for (const pattern of FORBIDDEN) assert.doesNotMatch(main, pattern, String(pattern));
  assert.doesNotMatch(card, /<details[^>]*\sopen(?:\s|>)/);
});

test('随机对照卡是单独一张：Q3a 明说 G1 不成立、证据不足；Q3a2 有支持证据；没有 Q3b 的三行文字，Q3b 卡里也没有随机对照的结论', async () => {
  const { baseline, cards } = projections();
  const html = await renderPage(await modelOf(baseline, cards));
  const section = researchSection(html);
  const rc = mainContent(cardOf(section, RC_TITLE));
  assert.match(rc, /随机对照是它自己的结论，与上面行业 RS 排序层（Q3b）的结论分开，互不影响/);
  const q3a = rc.slice(rc.indexOf('data-rc-part="Q3A"'), rc.indexOf('data-rc-part="Q3A2"'));
  assert.match(q3a, /Q3a：同一扫描候选的处理顺序随机化/);
  assert.match(q3a, /<span class="pill warn">结论：证据不足（G1 不成立）<\/span>/);
  assert.match(q3a, /<strong>G1 不成立：OOS 选择点只有 7 个，要求 ≥ 30 个，所以结论是证据不足；200 个种子的运行只作描述，不判。<\/strong>/);
  assert.match(q3a, /OOS 7 个（G1 不成立），开发期 2 个/);
  assert.match(q3a, /200 个（20261025 至 20261224）/);
  assert.match(q3a, /选择点太少（G1 不成立）/);
  const q3a2 = rc.slice(rc.indexOf('data-rc-part="Q3A2"'));
  assert.match(q3a2, /Q3a2：随机标的对照/);
  assert.match(q3a2, /<span class="pill ok">结论：有支持证据<\/span>/);
  assert.match(q3a2, /基线账户 g 胜过 81\.0% 的随机种子（相等算一半）。≥ 75% 有支持证据，≤ 50% 未通过，其余证据不足。/);
  assert.match(q3a2, /基线 g 胜过的种子比例（相等算一半）<\/dt><dd>81\.0%（百分位 81）/);
  assert.match(q3a2, /基线每笔净 R（只报不判）<\/dt><dd>−0\.02 R；胜过 50\.0% 的种子/);
  assert.match(q3a2, /<td>5%<\/td><td>-5\.20%<\/td>|<td>5%<\/td><td>−5\.20%<\/td>|<td>5%<\/td><td>-5\.2%<\/td>/);
  assert.match(q3a2, /1000 个（20261025 至 20262024）/);
  assert.doesNotMatch(rc, /优势结论：|压力评价|采用条件/);
  const q3b = mainContent(cardOf(section, Q3_TITLE));
  assert.doesNotMatch(q3b, /随机种子|RANDOM_SELECTION|share_beaten|胜过 81/);
  // 每笔净 R 的分布在折叠里
  const folded = cardOf(section, RC_TITLE);
  assert.ok(folded.includes('随机种子的每笔净 R 分布') && !rc.includes('随机种子的每笔净 R 分布'));
  for (const pattern of FORBIDDEN) assert.doesNotMatch(rc, pattern, String(pattern));
});

test('待验证问题清单：Q3 锁定后那一条写「已完成：…」并带链接；没锁定时原样不动', async () => {
  const locked = projections();
  const html = await renderPage(await modelOf(locked.baseline, locked.cards));
  const diagnosis = html.slice(html.indexOf('id="diagnosis-title"'), html.indexOf('id="detail-health"'));
  assert.match(diagnosis, /Q3 · .*（已完成：完整账户的对数增长更好（不等于信号 alpha 更大）（见研究与对比））/);
  const pending = projections({ q3: false });
  const pendingHtml = await renderPage(await modelOf(pending.baseline, pending.cards));
  const pendingDiagnosis = pendingHtml.slice(pendingHtml.indexOf('id="diagnosis-title"'), pendingHtml.indexOf('id="detail-health"'));
  assert.match(pendingDiagnosis, /Q3 · .*（排队：Q1 之后）/);
  assert.equal((pendingDiagnosis.match(/class="diagnosis-link"/g) || []).length, 1, '只有 Q1 带链接');
});

test('只有 Q1 锁定时没有 Q3 的任何卡；Q3 校验失败时主卡写「尚未完成」且没有随机对照卡，Q1 照常', async () => {
  const only1 = projections({ q3: false });
  const html1 = researchSection(await renderPage(await modelOf(only1.baseline, only1.cards)));
  assert.equal((html1.match(/<section class="backtest comparison/g) || []).length, 1);
  assert.doesNotMatch(html1, /行业 RS 排序层|随机选择对照/);

  const state = projections();
  fs.writeFileSync(state.file3, `${fs.readFileSync(state.file3, 'utf8')} `);
  const q3 = state.build(state.lock3);
  assert.equal(q3.state, 'INVALID');
  const section = researchSection(await renderPage(await modelOf(state.baseline, [state.cards[0], q3])));
  assert.match(section, /候选对比：行业 RS 排序层对原版（选对象了吗）<\/h3>.*?尚未完成：结果文件校验失败：Q3_RESULT_SHA256_MISMATCH/);
  assert.doesNotMatch(section, /随机选择对照|data-rc-part/);
  assert.equal((section.match(/data-cmp-block/g) || []).length, 7, '只剩 Q1 的七块');
});

test('随机对照一部分读不出来时：只让那一部分写「尚未完成」，另一部分照常（渲染层）', async () => {
  const { baseline, cards } = projections();
  const broken = JSON.parse(JSON.stringify(cards[1]));
  const parts = broken.extra_cards[0].data.parts;
  parts[0] = { key: 'Q3A', title_zh: parts[0].title_zh, question_zh: parts[0].question_zh, state: 'NOT_COMPLETED', reason: '结果文件缺 random_control.baseline' };
  const section = researchSection(await renderPage(await modelOf(baseline, [cards[0], broken])));
  assert.match(section, /data-rc-part="Q3A"[^>]*><h4>Q3a：.*?尚未完成：结果文件缺 random_control\.baseline/);
  assert.match(section, /data-rc-part="Q3A2"[\s\S]*结论：有支持证据/);
  const card = JSON.parse(JSON.stringify(cards[1]));
  card.extra_cards[0] = { key: 'random_control', title_zh: RC_TITLE, state: 'NOT_COMPLETED', reason: '随机对照无法读取', data: null };
  const whole = researchSection(await renderPage(await modelOf(baseline, [cards[0], card])));
  assert.match(whole, /随机选择对照（Q3a 候选顺序随机；Q3a2 随机标的）<\/h3>.*?尚未完成：随机对照无法读取/);
  assert.match(whole, /优势结论：完整账户的对数增长更好/, 'Q3b 主卡不受影响');
});
