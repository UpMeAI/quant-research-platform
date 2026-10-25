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
const q1 = require('../services/candidate-comparison');
const fx0 = require('./_q0_fixture');
const fx1 = require('./_q1_fixture');

const CASE = q1.CASE_REF;
const STRATEGY = q1.STRATEGY_REF;
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));

loop.openCase({
  case_id: CASE, strategy_ref: STRATEGY, market: 'US_EQUITY',
  runtime_lane: { source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64), version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
  baseline: {
    baseline_id: 'BASELINE-CMP-PAGE-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY', version_ref: 'US_V5_ETF_6000USD@frozen-old',
    source_ref: 'SMARTFLOW:SIGNED_RESEARCH:US_V5_ETF_6000USD', source_hash: 'b'.repeat(64), expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
    frozen_at: '2026-10-24T20:01:00Z',
  },
  cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
  data_quality: { status: 'VALID', as_of: '2026-10-23', known_at: '2026-10-24T20:00:00Z', source_refs: ['SMARTFLOW:US_V5_SCAN_RECORD_V2'], freshness: { state: 'CURRENT', age_seconds: 0 } },
  isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
  opened_at: '2026-10-24T20:02:00Z',
});

/** 在没有 DOM 的 vm 里运行页面脚本本身，取回它写进 #workspace 的 HTML。 */
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

/** 一份真实导入、真实投影的 Q0 + Q1（合成数字）。 */
function projections(mutateQ1) {
  for (const ledger of [q0.LEDGER(), q1.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); q1.clearCache();
  const q0Doc = fx0.result();
  const q0Lock = q0.importBaselineEvaluation(fx0.write(q0Doc), { registeredBy: AUTHORITY, allowNonActual: true });
  const baseline = q0.buildProjection(q0Lock, { allowNonActual: true });
  const file = fx1.write(fx1.result(q0Doc, q0Lock.file_sha256, q0Lock.result_id, mutateQ1));
  const lock = q1.importCandidateComparison(file, { registeredBy: AUTHORITY, allowNonActual: true });
  return { baseline, comparison: q1.buildProjection(lock, { allowNonActual: true }), file, lock };
}
const modelOf = (baseline, comparison) => workspace.readModel({ strategyRef: STRATEGY, baseline, comparison });
const researchSection = (html) => html.slice(html.indexOf('id="detail-research"'), html.indexOf('id="detail-forward"'));

test('尚未交付：「研究与对比」写「尚未完成：研究会话尚未交付封存的对比结果」；问题清单里的 Q1 一条链到它', async () => {
  const { baseline } = projections();
  const html = await renderPage(await modelOf(baseline, q1.emptyProjection('NOT_IMPORTED')));
  const section = researchSection(html);
  assert.match(section, /<p class="not-backtested">尚未完成：研究会话尚未交付封存的对比结果<\/p>/);
  assert.equal((section.match(/data-cmp-block/g) || []).length, 0);
  const diagnosis = html.slice(html.indexOf('id="diagnosis-title"'), html.indexOf('id="detail-health"'));
  assert.match(diagnosis, /对应实验：<\/strong>Q1 · .*（进行中：K2 已冻结，等研究会话交付封存的对比结果（见研究与对比））/);
  assert.match(diagnosis, /<a class="diagnosis-link" href="#strategy-detail\?strategy=US_V5_ETF_3000USD&section=research">查看研究与对比 →<\/a>/);
  assert.doesNotMatch(diagnosis, /排队：Q0 锁定之后开始/, '过期的排队文案不再出现');
});

test('已交付：七块按固定顺序，主内容里有三行（优势结论／压力评价不完整／采用条件）、前向标「前向，只报不判」，没有哈希和内部编号', async () => {
  const { baseline, comparison } = projections();
  const html = await renderPage(await modelOf(baseline, comparison));
  const section = researchSection(html);
  assert.deepEqual([...section.matchAll(/data-cmp-block="(\w+)"/g)].map((m) => m[1]), ['question', 'account', 'effect', 'criteria', 'stress', 'verdict', 'forward']);
  const main = mainContent(section);
  const order = ['这个对比在问什么', '账户结果：原版与候选', '受影响交易的改善', '判据逐条', '压力：两臂逐行对比', '三态结论与采用条件', '前向观察'];
  const positions = order.map((title) => main.indexOf(title));
  assert.ok(positions.every((position) => position > -1), JSON.stringify(positions));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, '七块顺序固定');
  assert.ok(positions[0] > main.indexOf('候选对比：T3 对原版'));

  assert.match(main, /<li class="">优势结论：有支持证据<\/li>/);
  assert.match(main, /<li class="warn">压力评价不完整：缺场景 1 个、无效输入 1 个（极端下跌 2008：缺场景；区间重放：2020-02-19 至 2020-04-30：无效输入）<\/li>/);
  assert.match(main, /<li class="bad">采用条件：未满足（独立样本不足，等前向成熟；必要压力缺失，§6\.7）<\/li>/);
  assert.ok(main.indexOf('优势结论：有支持证据') < main.indexOf('压力评价不完整'), '优势结论在前，压力评价不盖住它');
  assert.match(main, /复测（当年用于挑选 T3 的样本，不是独立样本外）/);
  assert.match(main, /前向，只报不判/);
  assert.match(main, /B 流：生产账本交易的孪生/);
  assert.match(main, /S 流：信号级影子/);
  for (const pattern of FORBIDDEN) assert.doesNotMatch(main, pattern, String(pattern));
  // 哈希与编号只在折叠的技术详情里
  assert.ok(section.includes(comparison.source.file_sha256) && !main.includes(comparison.source.file_sha256));
  assert.ok(section.includes(comparison.source.baseline_result_id) && !main.includes(comparison.source.baseline_result_id));
  assert.doesNotMatch(section, /<details[^>]*\sopen(?:\s|>)/);
});

test('主数字：账户对比、受影响交易改善（主 S／次 B）、判据八条、压力两臂加差，全部来自投影', async () => {
  const { baseline, comparison } = projections();
  const main = mainContent(researchSection(await renderPage(await modelOf(baseline, comparison))));
  assert.match(main, /原版（当前 D）/);
  assert.match(main, /候选 T3/);
  assert.match(main, /候选 − 原版/);
  assert.match(main, /推迟 37 个 session/);
  assert.match(main, /<strong>主样本<\/strong>（S）/);
  assert.match(main, /<strong>次要样本（照报不判）<\/strong>（B）/);
  assert.match(main, /34 笔/);
  assert.match(main, /\+0\.31 R/);
  assert.match(main, /98\.33% 区间（主判据）/);
  assert.match(main, /候选相对原版的年化对数增长差<\/dt><dd>2\.10%/);
  for (const key of ['G1', 'P1', 'P2', 'P3', 'P4', 'F1', 'F2', 'F3']) assert.ok(main.includes(`<strong>${key} · `), key);
  assert.equal((main.match(/>成立</g) || []).length, 5);
  assert.equal((main.match(/>未触发</g) || []).length, 3);
  assert.match(main, /费用 15 bps 双边/);
  assert.match(main, /原版 US\$8,000<br>候选 US\$8,200<br><strong>差 \+US\$200<\/strong>/);
  assert.match(main, /差 −US\$10/);
  assert.match(main, /<tr class="missing-scenario"><td>极端下跌 2008<\/td><td colspan="3">缺场景：2007–2009/);
  assert.match(main, /<tr class="missing-scenario"><td>区间重放：2020-02-19 至 2020-04-30<\/td><td colspan="3">无效输入：2020 年 2 月前后/);
  assert.match(main, /候选臂缺项：取不到 dailyRead/);
  assert.match(main, /补充情景，不进结论/);
  assert.match(main, /已执行 3 个压力场景，模拟或补充 1 个，缺场景 1 个，无效输入 1 个/);
});

test('压力完整、样本外仍是复测：页面只有优势结论和采用条件两行，没有「压力评价不完整」', async () => {
  const { baseline, comparison } = projections((doc) => {
    doc.stress.rows = doc.stress.rows.filter((row) => !['WINDOW_2020_02_19_04_30', 'EXTREME_DOWNTURN_2008'].includes(row.scenario));
    doc.verdict.reason_codes = ['OOS_REUSED_FOR_SELECTION'];
  });
  const main = mainContent(researchSection(await renderPage(await modelOf(baseline, comparison))));
  assert.match(main, /采用条件：未满足（独立样本不足，等前向成熟）<\/li>/);
  assert.doesNotMatch(main, /压力评价不完整/);
});

test('有结论后：问题清单里 Q1 一条写「已完成：结论」并链到研究与对比；Q0 的回测结论卡原样不动', async () => {
  const { baseline, comparison } = projections();
  const withQ1 = await renderPage(await modelOf(baseline, comparison));
  const without = await renderPage(await modelOf(baseline, q1.emptyProjection('NOT_IMPORTED')));
  const diagnosis = withQ1.slice(withQ1.indexOf('id="diagnosis-title"'), withQ1.indexOf('id="detail-health"'));
  assert.match(diagnosis, /（已完成：有支持证据（见研究与对比））/);
  assert.match(diagnosis, /section=research">查看研究与对比 →/);
  // Q0 卡：六块 data-block 与内容逐字相同；对比块不使用 data-block
  const q0Card = (html) => html.slice(html.indexOf('<section class="backtest" aria-labelledby="backtest-title">'), html.indexOf('id="diagnosis-title"'));
  assert.equal(q0Card(withQ1), q0Card(without));
  assert.deepEqual([...withQ1.matchAll(/data-block="(\w+)"/g)].map((m) => m[1]), ['period', 'account', 'winrate', 'stress', 'kelly', 'verdict']);
  // A4 D4：页头的研究问题标签随锁定状态改写（有锁定写「Q1 已锁定」，没有才写「暂无研究问题」）；除此之外页头与前几节逐字相同
  const head = (html, list) => html.slice(0, html.indexOf('id="detail-research"')).replace(list, '').replace(/<span class="pill [a-z]*">(?:研究问题：[^<]*|已接入，暂无研究问题)<\/span>/, '<span PILL>');
  assert.match(withQ1, /<span class="pill info">研究问题：Q1 已锁定；(?:Q\d、)*Q\d 进行中[^<]*尚未回到 Desk<\/span>|<span class="pill info">研究问题：Q1 已锁定；尚未回到 Desk<\/span>/);
  assert.match(without, /已接入，暂无研究问题/);
  assert.equal(head(withQ1, diagnosis), head(without, without.slice(without.indexOf('id="diagnosis-title"'), without.indexOf('id="detail-health"'))));
});

test('文件校验失败：整节写「尚未完成：结果文件校验失败」，不显示任何数字；问题清单不写「已完成」', async () => {
  const { baseline, file, lock } = projections();
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')} `);
  const broken = q1.buildProjection(lock, { allowNonActual: true });
  assert.equal(broken.state, 'INVALID');
  const html = await renderPage(await modelOf(baseline, broken));
  const section = researchSection(html);
  assert.match(section, /尚未完成：结果文件校验失败：Q1_RESULT_SHA256_MISMATCH/);
  assert.equal((section.match(/data-cmp-block/g) || []).length, 0);
  assert.doesNotMatch(section, /优势结论|34 笔|\+0\.31 R/);
  assert.doesNotMatch(html, /已完成：有支持证据/);
  assert.match(html, /已有封存的对比结果，但校验未通过（见研究与对比）/);
});

test('块级失败：压力块读不出来，只让那一块写「尚未完成」，其余六块照常，压力评价按不完整处理', async () => {
  const { baseline, comparison } = projections((doc) => { doc.stress.rows.find((row) => row.scenario === 'COST_15BPS').diff.end_capital += 1; });
  const section = researchSection(await renderPage(await modelOf(baseline, comparison)));
  assert.equal((section.match(/data-cmp-block/g) || []).length, 7);
  assert.match(section, /data-cmp-block="stress"><h4>.*?<\/h4><p class="not-backtested">尚未完成：结果文件字段无效：stress\.rows\[0\]\.diff/);
  assert.match(section, /压力评价不完整：压力表无法读取/);
  assert.match(section, /采用条件：未满足（独立样本不足，等前向成熟；必要压力缺失，§6\.7）/);
  assert.match(section, /\+0\.31 R/);
});

test('其他没有对比的策略：不显示对比卡，也不出现「尚未完成」', async () => {
  const { baseline } = projections();
  const html = await renderPage(await modelOf(baseline, q1.emptyProjection('NOT_CONNECTED', '这项策略没有候选对比')));
  assert.doesNotMatch(researchSection(html), /候选对比：T3 对原版|尚未完成：/);
});

test('读模型：comparison 与 diagnosis_list 来自注入的投影；没有注入且 case 是首案时读真实账本（尚未导入）', async () => {
  const { baseline, comparison } = projections();
  const model = await modelOf(baseline, comparison);
  const detail = model.views['strategy-detail'];
  assert.equal(detail.comparisons[0].state, 'LOCKED_VERIFIED');
  assert.equal(detail.comparisons[0].verdict_state, 'SUPPORTED');
  assert.equal(detail.comparisons[0].source_label, undefined, 'A4 D3.4：来源说明由研究区开头统一写一次');
  assert.match(detail.research.source_label, /页面不重算/);
  const item = detail.diagnosis_list.items.find((entry) => entry.experiment && entry.experiment.id === 'Q1');
  assert.equal(item.experiment.status, '已完成：有支持证据（见研究与对比）');
  assert.deepEqual(item.link, { label: '查看研究与对比', section: 'research', strategy_ref: STRATEGY });
  assert.equal(detail.diagnosis_list.items.filter((entry) => entry.link).length, 1);

  fs.rmSync(q1.LEDGER(), { force: true });
  q1.clearCache();
  const real = await workspace.readModel({ strategyRef: STRATEGY, baseline });
  assert.equal(real.views['strategy-detail'].comparisons[0].state, 'NOT_IMPORTED');
  assert.equal(real.views['strategy-detail'].comparisons[0].reason, '研究会话尚未交付封存的对比结果');
});
