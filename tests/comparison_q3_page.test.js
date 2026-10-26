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
const { programBeforeK2, withProgram } = require('./_queue_fixture');

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
    doc.diagnosis_items.push({ id: 'DX5', source: 'RISK', facts: ['被闸门拒绝的信号也武装了 24 h 冷却'], proposed_experiment: 'Q4', no_topic_reason: null });
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
  assert.match(main, /<span class="pill warn">同窗复测，不是新的样本外<\/span> 排序参数在 RS-1 签署时冻结.*RS-1 已在 2023-01-01 → 2026-09-30 评价过同一规则（INSUFFICIENT，随机名次对照在第 59\.5.68 百分位）；本题是在当前 D 上的复测<\/p>/);
  const questionBlock = main.slice(main.indexOf('data-cmp-block="question"'), main.indexOf('data-cmp-block="account"'));
  assert.equal(questionBlock.split('本题是在当前 D 上的复测').length - 1, 1, 'A4 去重：文件已写明样本外怎么回事时，登记项的同义句不再在同一块里重复一遍');
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
  assert.match(main, /行业 RS 拒绝数（不在前 4 的行业信号）<\/td><td>—<\/td><td>31 次<\/td><td>—<\/td>/);
  assert.match(main, /名次重排的时点数<\/td><td>—<\/td><td>12 个<\/td><td>—<\/td>/);
  assert.match(main, /<strong>G1 · /);
  assert.match(main, /A23 未开启，HK 没有排序层前向/);
  assert.match(main, /改变的入场 41 笔/);
  for (const pattern of FORBIDDEN) assert.doesNotMatch(main, pattern, String(pattern));
  assert.doesNotMatch(card, /<details[^>]*\sopen(?:\s|>)/);
});

test('A4 规则用在 Q3 的卡上：判定依据、两臂账户表加参照行、主内容没有已登记的英文原因码、「页面不重算」一次、三行块 = 1 + 锁定主卡数', async () => {
  const { baseline, cards } = projections();
  const html = await renderPage(await modelOf(baseline, cards));
  const section = researchSection(html);
  const q3b = mainContent(cardOf(section, Q3_TITLE));
  // D1.4：Q3b 的依据（SUPPORTED：区间下沿高于门槛，G1 成立，数字取自文件，门槛已冻结）
  assert.match(q3b, /<p class="basis"><strong>判定依据：<\/strong>候选相对原版的年化对数增长差 95% 区间 0\.3% 至 3\.4%，下沿高于门槛 0；G1 成立（改变的入场 41 笔，门槛 30 笔）（门槛在看到结果前已冻结）<\/p>/);
  // D3.2：账户表 = 原版、候选、差值 + 参照行；没有 SPY／现金行，写一句「基准见回测结论卡」
  const account = q3b.slice(q3b.indexOf('data-cmp-block="account"'), q3b.indexOf('data-cmp-block="effect"'));
  const rows = (account.match(/<tbody>[\s\S]*?<\/tbody>/) || [''])[0].match(/<tr[\s\S]*?<\/tr>/g) || [];
  assert.equal(rows.length, 4, '原版、候选、差值、等权买入持有参照行');
  assert.ok(rows.every((row) => !/SPY|现金/.test(row)));
  assert.match(account, /<p class="muted-note">基准见回测结论卡<\/p>/);
  // D1.3 / D5.2：主内容没有任何已登记的英文原因码（含随机对照卡）
  const codes = [...new Set([...Object.keys(q0.internals.REASON_WORDS), ...Object.values(cc.QUESTIONS).flatMap((entry) => Object.keys(entry.reason_words))])];
  const main = mainContent(html);
  for (const code of codes) assert.ok(!main.includes(code), `主内容出现英文原因码 ${code}`);
  // D3.4、D3.1
  assert.equal(html.split('页面不重算').length - 1, 1);
  assert.equal((html.match(/class="completeness"/g) || []).length, 1 + 2, '顶部 1 + Q1 主卡 + Q3b 主卡；随机对照卡是自己的结论，没有三行块');
  const rc = cardOf(section, RC_TITLE);
  assert.doesNotMatch(rc, /class="completeness"/);
  assert.equal((rc.match(/class="basis"/g) || []).length, 2, '随机对照每一部分各一条判定依据');
  // D1.3：未登记的原因码在随机对照卡里也折叠
  const folded = await renderPage(await modelOf(baseline, [cards[0], { ...cards[1], extra_cards: cards[1].extra_cards.map((extra) => ({
    ...extra, data: { ...extra.data, parts: extra.data.parts.map((p) => ({ ...p, unknown_reason_codes: ['SOME_NEW_RANDOM_CODE'] })) },
  })) }]));
  const foldedRc = cardOf(researchSection(folded), RC_TITLE);
  assert.doesNotMatch(mainContent(foldedRc), /SOME_NEW_RANDOM_CODE/);
  assert.match(mainContent(foldedRc), /另有 1 个技术原因码（见技术详情）/);
  assert.match(foldedRc, /<details><summary>技术详情：未登记的原因码<\/summary>[\s\S]*?<code>SOME_NEW_RANDOM_CODE<\/code>/);
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
  assert.match(q3a, /<strong>选择点太少：OOS 7 个，200 个种子的运行只作描述，不判<\/strong>/);
  assert.match(q3a, /判定依据：<\/strong>G1 不成立：OOS 选择点 7 个，低于门槛 30 个（门槛在看到结果前已冻结）/);
  assert.match(q3a, /同时：基线账户 g 胜过 62\.0% 的随机种子（相等算一半），只作描述，不判/);
  assert.match(q3a, /OOS 7 个（G1 不成立）；开发期 2 个/);
  assert.match(q3a, /200 个（20261025 至 20261224）/);
  assert.match(q3a, /选择点太少（G1 不成立）/);
  const q3a2 = rc.slice(rc.indexOf('data-rc-part="Q3A2"'));
  assert.match(q3a2, /Q3a2：随机标的对照/);
  assert.match(q3a2, /<span class="pill ok">结论：有支持证据<\/span>/);
  assert.match(q3a2, /<strong>基线账户 g 胜过 81\.0% 的随机种子（相等算一半）<\/strong>/);
  assert.match(q3a2, /判定依据：<\/strong>基线账户 g 胜过 81\.0% 的随机种子（相等算一半），不低于门槛 75%；G1 成立（OOS 选择点 112 个，门槛 30 个）（门槛在看到结果前已冻结）/);
  assert.match(q3a2, /OOS 112 个（G1 成立）；开发期 不跑（Q3a2 只跑样本外（K2 裁定 1），开发期不跑）/);
  assert.match(q3a2, /基线账户 g<\/dt><dd>-1\.60%；在随机种子中的百分位 81|基线账户 g<\/dt><dd>−1\.60%；在随机种子中的百分位 81/);
  assert.equal((rc.match(/基线 g 胜过的种子比例/g) || []).length, 0, '比例只在一句结果和判定依据里写，不再单列一行');
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

test('待验证问题清单：Q3 锁定后写「已完成：…」并带链接；没锁定时从登记项与计划推出状态（进行中）；Q4 的 K2 已冻结＝进行中，冻结之前（夹具）随 Q3 排队或待立题', async () => {
  const diagnosisOf = (page) => page.slice(page.indexOf('id="diagnosis-title"'), page.indexOf('id="detail-health"'));
  const headOf = (page) => page.slice(0, page.indexOf('class="conclusion'));
  const q4Running = /Q4 · .*（进行中：K2 已冻结，等研究会话交付封存的对比结果（见研究与对比））/;
  const locked = projections();
  const html = await renderPage(await modelOf(locked.baseline, locked.cards));
  const diagnosis = diagnosisOf(html);
  assert.match(diagnosis, /Q3 · .*（已完成：完整账户的对数增长更好（不等于信号 alpha 更大）（见研究与对比））/);
  assert.match(diagnosis, q4Running, 'Q4 的 K2 已冻结：Q3 锁定之后是进行中，不写待立题');
  assert.match(headOf(html), /研究问题：Q1、Q3 已锁定；Q4 进行中（来源：Q0 诊断，协调会话立题）；尚未回到 Desk/);
  // 原意保留为夹具：Q4 的 K2 冻结之前，Q3 锁定后前置都已锁定，写待立题
  const lockedBefore = await withProgram(programBeforeK2('Q4'), async () => renderPage(await modelOf(locked.baseline, locked.cards)));
  assert.match(diagnosisOf(lockedBefore), /Q4 · .*（待立题：前置题已锁定，等 K2 冻结后开始）/, 'Q3 锁定之后 Q4 的前置都已锁定，等冻结 K2');
  assert.match(headOf(lockedBefore), /研究问题：Q1、Q3 已锁定；Q4 待立题，前置题已锁定，等 K2 冻结（来源：Q0 诊断，协调会话立题）；尚未回到 Desk/);

  const pending = projections({ q3: false });
  const pendingHtml = await renderPage(await modelOf(pending.baseline, pending.cards));
  const pendingDiagnosis = diagnosisOf(pendingHtml);
  assert.match(pendingDiagnosis, /Q3 · .*（进行中：K2 已冻结，等研究会话交付封存的对比结果（见研究与对比））/, 'Q3 的 K2 已冻结、还没有封存结果：进行中');
  assert.doesNotMatch(pendingDiagnosis, /排队：Q1 之后/, '过期的固定文案不再出现');
  assert.match(pendingDiagnosis, q4Running, 'Q4 的 K2 已冻结：Q3 没锁定也是进行中');
  assert.doesNotMatch(pendingDiagnosis, /排队：Q3 锁定之后开始/);
  assert.equal((pendingDiagnosis.match(/class="diagnosis-link"/g) || []).length, 1, '只有 Q1 带链接，Q3 还没有卡');
  assert.match(headOf(pendingHtml), /研究问题：Q1 已锁定；Q3、Q4 进行中（来源：Q0 诊断，协调会话立题）；尚未回到 Desk/);
  // 原意保留为夹具：Q4 的 K2 冻结之前，Q3 没锁定就写排队，等谁
  const pendingBefore = await withProgram(programBeforeK2('Q4'), async () => renderPage(await modelOf(pending.baseline, pending.cards)));
  assert.match(diagnosisOf(pendingBefore), /Q4 · .*（排队：Q3 锁定之后开始）/, 'Q4 在计划里排在 Q3 封存之后；Q3 没锁定就写排队，等谁');
  assert.match(headOf(pendingBefore), /研究问题：Q1 已锁定；Q3 进行中；Q4 排队，等 Q3 锁定（来源：Q0 诊断，协调会话立题）；尚未回到 Desk/);
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
