'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const loop = require('../services/runtime-research-loop');
const workspace = require('../services/research-workspace');
const k3 = require('../services/baseline-evaluation');
const { result, write } = require('./_q0_fixture');

const CASE = k3.CASE_REF;
const STRATEGY = k3.STRATEGY_REF;
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));

loop.openCase({
  case_id: CASE, strategy_ref: STRATEGY, market: 'US_EQUITY',
  runtime_lane: { source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64), version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
  baseline: {
    baseline_id: 'BASELINE-RENDER-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY', version_ref: 'US_V5_ETF_6000USD@frozen-old',
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

/** 去掉所有 <details>（含嵌套）后剩下的就是「主内容」。 */
function mainContent(html) {
  let out = html;
  for (let guard = 0; guard < 50 && /<details/.test(out); guard += 1) {
    out = out.replace(/<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/g, '');
  }
  return out;
}
const FORBIDDEN = [/\bM[0-5]\b/, /NOT_VERIFIED/, /CONTROLLED/, /真实账户臂/, /PAPER/, /RRC-/, /PME-/, /[0-9a-f]{64}/, /US_V5_ETF_6000USD/, /准备、验收和发布/];
const model = async (baseline) => workspace.readModel({ strategyRef: STRATEGY, ...(baseline === undefined ? {} : { baseline }) });
const fixtureProjection = (patch) => {
  fs.rmSync(k3.LEDGER(), { force: true });
  const file = write(result(patch));
  const lock = k3.importBaselineEvaluation(file, { registeredBy: process.env.QRP_PRODUCT_MILESTONE_AUTHORITY, allowNonActual: true });
  return k3.buildProjection(lock, { allowNonActual: true });
};
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';

test('结论区块在五段标签之前；回测结论卡六块顺序固定；尚未回测时每块写「尚未回测：原因」', async () => {
  const html = await renderPage(await model(k3.emptyProjection('NOT_IMPORTED', '研究会话尚未交付封存的回测结果')));
  assert.ok(html.indexOf('class="conclusion') > -1 && html.indexOf('class="conclusion') < html.indexOf('class="section-nav'));
  assert.ok(html.indexOf('class="section-nav') < html.indexOf('id="detail-runtime"'));
  assert.ok(html.indexOf('id="detail-runtime"') < html.indexOf('class="backtest'));
  assert.deepEqual([...html.matchAll(/data-block="(\w+)"/g)].map((m) => m[1]), ['period', 'account', 'winrate', 'stress', 'kelly', 'verdict']);
  assert.deepEqual([...html.matchAll(/id="(detail-\w+)"/g)].map((m) => m[1]), ['detail-runtime', 'detail-health', 'detail-research', 'detail-forward', 'detail-review']);
  assert.match(html, /<h2 id="conclusion-title">尚未回测：研究会话尚未交付封存的回测结果<\/h2>/);
  assert.equal((html.match(/尚未回测：研究会话尚未交付封存的回测结果/g) || []).length, 8); // 结论 1 + 六块各 1 + 问题清单 1
  assert.doesNotMatch(html, /证据不足<\/h2>/);
  assert.ok(html.indexOf('data-block="verdict"') < html.indexOf('id="diagnosis-title"'), '问题清单紧跟回测结论卡');
});

test('主内容不含阶段编号、内部 ID、哈希和「真实账户臂」；这些内容收在折叠的技术详情里', async () => {
  const html = await renderPage(await model(k3.emptyProjection('NOT_IMPORTED', '研究会话尚未交付封存的回测结果')));
  const main = mainContent(html);
  assert.ok(main.length > 2000);
  for (const pattern of FORBIDDEN) assert.doesNotMatch(main, pattern, String(pattern));
  assert.match(main, /最近实际运行（纸面交易，真实行情）/);
  assert.match(main, /账户：纸面交易（真实行情），即本策略的真实账户/);
  assert.doesNotMatch(main, /全部账户均为/);
  for (const folded of ['准备、验收和发布不是同一个状态', '先分清三类证据', '为什么原始记录里会出现旧 6000 美元名称', '技术详情：阶段状态、来源与前身交接']) {
    assert.ok(html.includes(folded) && !main.includes(folded), folded);
  }
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/);
});

test('前向观察：HK 上已在跑的影子写「已在 HK 运行，尚未导入」，不写「尚无前向观察」', async () => {
  const html = await renderPage(await model(k3.emptyProjection('NOT_IMPORTED', 'x')));
  const forward = html.slice(html.indexOf('id="detail-forward"'), html.indexOf('id="detail-review"'));
  assert.match(forward, /已在 HK 运行，尚未导入/);
  assert.match(forward, /2026-10-05/);
  assert.match(forward, /HK VPS（smartflow-vps）/);
  assert.doesNotMatch(forward, /尚无属于这项策略的前向观察|暂无前向观察/);
  const shadow = await renderPage(await model(k3.emptyProjection('NOT_IMPORTED', 'x')), '#shadow');
  assert.match(shadow, /已在 HK 运行/);
  assert.match(shadow, /已在 HK 运行，尚未导入/);
});

test('有封存结果时：结论、主数字及区间、六块数字全部来自投影；模拟场景和公式推算被明确标注', async () => {
  const html = await renderPage(await model(fixtureProjection()));
  assert.match(html, /<h2 id="conclusion-title">证据不足<\/h2>/);
  assert.match(html, /样本外每笔扣费后净 R 均值（5 bps，生产相位；门槛 \+0\.10 R）：\+0\.22 R/);
  assert.match(html, /95% 区间 \+0\.12 R 至 \+0\.31 R/);
  assert.match(html, /最大的限制：/);
  const card = html.slice(html.indexOf('class="backtest'), html.indexOf('id="diagnosis-title"'));
  assert.doesNotMatch(card, /尚未回测：/);
  for (const text of ['开发期 A', '样本外', '本策略', 'SPY 买入持有', '现金', '生产相位', '相位 ±60 分钟', '落在同一组时刻', '公式推算，不是回测',
    '模拟序列，不是可交易历史', '极端熊市', '按区间下沿计算的半凯利比例', '研究计算，不是仓位建议；现行仓位规则不变',
    '按半凯利定仓', '按现行固定 60 美元风险', '95% 区间（按月分块 bootstrap）', '相对 SPY 买入持有的年化对数增长差']) assert.ok(card.includes(text), text);
  assert.match(card, /跌破 [^<]*1,800[^<]*的概率/);
  const stress = html.slice(html.indexOf('data-block="stress"'), html.indexOf('data-block="kelly"'));
  assert.match(stress, /最大损失：<strong>[^<]*900[^<]*<\/strong>（场景：区间重放：2020-02-19 至 2020-04-30）/);
  assert.match(stress, /缺场景：2007–2009 行业 ETF 日线在 Mac 与 HK 均无，按 Owner 规则不重新拉取/);
  assert.match(stress, /已执行 2 个压力场景，模拟或补充 1 个，缺场景 1 个，无效输入 0 个；另有当前 D 参照 0 行、风控维度 0 行/);
  assert.match(stress, /规则边界情景：只含 SPY \/ QQQ 合成载体/);
  assert.equal((stress.match(/class="missing-scenario"/g) || []).length, 1);
  const missingRow = /<tr class="missing-scenario">[\s\S]*?<\/tr>/.exec(stress)[0];
  assert.doesNotMatch(missingRow, /US\$|个 session|已恢复|未恢复/, '缺场景行不显示任何数字或恢复状态');
  assert.match(html, /待验证，不是结论/);
  assert.match(html, /对应实验：<\/strong>Q1 · 「趋势中推迟时间止损」/); // UX 修订 5 E7.2：主内容里的 T3 换成中文题名
  assert.match(html, /不立题：<\/strong>相位是执行条件/);
  assert.equal((html.match(/data-block=/g) || []).length, 6);
  const main = mainContent(html);
  for (const pattern of FORBIDDEN) assert.doesNotMatch(main, pattern, String(pattern));
});

test('压力块：缺场景、无效输入各一行写原因，补充行标模拟，压力结论与研究会话原文可见，最大损失不含它们', async () => {
  const html = await renderPage(await model(fixtureProjection((doc) => {
    doc.stress = { rows: [
      { scenario: 'PHASE', label: '扫描相位 ±60 分钟', max_loss_usd: 1083.5614, longest_underwater_sessions: 589, recovered: false, end_capital: 2374, simulated: false },
      { scenario: 'W2020', label: '区间重放 2020', status: 'INVALID_INPUT', simulated: false, max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: null, reason: '没有载体通过流动性底线' },
      { scenario: 'BEAR_2008', label: '极端熊市 2008：缺场景', status: 'MISSING_SCENARIO', simulated: true, max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: null, reason: '行业 ETF 日线均无' },
      { scenario: 'BEAR_SUPPLEMENT', label: '规则边界情景（补充）', status: 'SUPPLEMENTARY_NOT_IN_CONCLUSION', simulated: true, in_headline: false, max_loss_usd: 2000, longest_underwater_sessions: 100, recovered: false, end_capital: 900 },
    ], conclusion: 'incomplete' };
    return doc;
  })));
  const stress = html.slice(html.indexOf('data-block="stress"'), html.indexOf('data-block="kelly"'));
  assert.match(stress, /最大损失：<strong>[^<]*1,084[^<]*<\/strong>（场景：扫描相位 ±60 分钟）/);
  assert.match(stress, /无效输入：没有载体通过流动性底线/);
  assert.match(stress, /缺场景：行业 ETF 日线均无/);
  assert.equal((stress.match(/class="missing-scenario"/g) || []).length, 2);
  assert.match(stress, /已执行 1 个压力场景，模拟或补充 1 个，缺场景 1 个，无效输入 1 个/);
  assert.match(stress, /压力结论：<\/strong>压力评价不完整：缺场景 1 个、无效输入 1 个/);
  assert.match(stress, /研究会话的原文/);
  assert.doesNotMatch(stress, /最大损失：<strong>[^<]*2,000/);
});

test('半凯利为 0 时写「不支持按凯利加仓」；缺一块只让该块写原因，其他块照常', async () => {
  const html = await renderPage(await model(fixtureProjection((doc) => {
    doc.half_kelly.f_half = 0; doc.half_kelly.f_star = 0; delete doc.stats.rows; return doc;
  })));
  assert.match(html, /不支持按凯利加仓/);
  const winrate = html.slice(html.indexOf('data-block="winrate"'), html.indexOf('data-block="stress"'));
  assert.match(winrate, /尚未回测：结果文件缺 stats\.rows/);
  assert.doesNotMatch(winrate, /<table/);
  assert.match(html.slice(html.indexOf('data-block="account"'), html.indexOf('data-block="winrate"')), /<table/);
});

test('结果文件校验失败：整卡失败关闭，页面不显示任何回测数字', async () => {
  const projection = k3.emptyProjection('INVALID', '结果文件校验失败：Q0_RESULT_SHA256_MISMATCH:ab…≠cd…');
  const html = await renderPage(await model(projection));
  assert.match(html, /<h2 id="conclusion-title">尚未回测：结果文件校验失败：Q0_RESULT_SHA256_MISMATCH/);
  assert.equal((html.match(/尚未回测：结果文件校验失败/g) || []).length, 8);
  assert.doesNotMatch(mainContent(html), /<table[^>]*>(?:(?!<\/table>)[\s\S])*\+0\.22 R/);
  assert.doesNotMatch(html, /证据不足<\/h2>|有支持证据<\/h2>|未通过<\/h2>/);
});

test('三态结论文字：有支持证据 / 未通过 / 证据不足，尚未回测不冒充其中任何一个', async () => {
  const supported = await renderPage(await model(fixtureProjection((doc) => {
    doc.verdict.state = 'SUPPORTED'; doc.verdict.L_R = 0.12; doc.verdict.L_g = 0.01; doc.verdict.reason_codes = [];
    doc.stress.rows = doc.stress.rows.filter((row) => !row.missing); return doc;
  })));
  assert.match(supported, /<h2 id="conclusion-title">有支持证据<\/h2>/);
  assert.doesNotMatch(supported, /class="completeness"/, '压力表完整时不出现压力与采用两行');
  const notPassed = await renderPage(await model(fixtureProjection((doc) => { doc.verdict.state = 'NOT_PASSED'; doc.verdict.U_R = 0.05; return doc; })));
  assert.match(notPassed, /<h2 id="conclusion-title">未通过<\/h2>/);
  const approximate = await renderPage(await model(fixtureProjection((doc) => {
    doc.verdict.engine_approximation = { flag: true, missing: ['A17 前身共享限额'] }; return doc;
  })));
  assert.match(approximate, /研究引擎近似的当前 D（缺：A17 前身共享限额），结论最高只能是证据不足/);
  assert.match(approximate, /研究引擎近似（缺：A17 前身共享限额）/);
});

test('未接入 Research 的策略：同样的结论区块和六块，写「尚未回测」', async () => {
  const other = await workspace.readModel({ strategyRef: 'US_CORE_9000USD_3X_GATEOBS' });
  assert.ok(other.views['strategy-detail'].strategy, 'Desk 目录里有这条未接入 Research 的策略');
  assert.equal(other.views['strategy-detail'].case_role, 'NOT_CONNECTED');
  const html = await renderPage(other, '#strategy-detail?strategy=US_CORE_9000USD_3X_GATEOBS');
  assert.match(html, /<h2 id="conclusion-title">尚未回测：/);
  assert.equal((html.match(/data-block=/g) || []).length, 6);
});

test('UX 修订 3 C4：页面任何位置都不把「没有真实账户臂」「全部账户均为 PAPER」呈现为限制', () => {
  assert.doesNotMatch(PAGE, /真实账户臂|全部账户均为|无真实账户/);
  const diagnostics = require('../services/strategy-diagnostics');
  const built = diagnostics.readDiagnostic();
  assert.equal(built.state, 'VERIFIED');
  assert.ok(built.limitations.length >= 3);
  assert.doesNotMatch(built.limitations.join(' '), /PAPER|真实账户|M0|M1/);
  assert.match(built.product_status_note, /M0\/M1/);
});

test('G3（A4 D3.1 修订）：优势结论是「有支持证据」而压力缺场景时，三行只在顶部结论区块写一次且不折叠；第 6 块只写判据与数字', async () => {
  const html = await renderPage(await model(fixtureProjection((doc) => {
    doc.verdict.state = 'SUPPORTED'; doc.verdict.L_R = 0.12; doc.verdict.L_g = 0.01; doc.verdict.reason_codes = ['STRESS_SCENARIO_MISSING']; return doc;
  })));
  assert.match(html, /<h2 id="conclusion-title">有支持证据<\/h2>/, '主状态仍是优势结论');
  const main = mainContent(html);
  const lines = ['优势结论：有支持证据', '压力评价不完整：缺场景 1 个、无效输入 0 个（极端熊市 2008：缺场景）', '采用条件：未满足（必要压力缺失，§6.7）'];
  for (const line of lines) {
    assert.equal(main.split(line).length - 1, 1, `${line} 在主内容里恰好出现一次（顶部结论区块），第 6 块不再重复`);
  }
  assert.equal((main.match(/class="completeness"/g) || []).length, 1, '三行结论块在 Q0 卡只有顶部这一份');
  const conclusion = html.slice(html.indexOf('class="conclusion'), html.indexOf('class="section-nav'));
  assert.ok(lines.every((line) => conclusion.includes(line)));
  assert.ok(conclusion.indexOf(lines[0]) < conclusion.indexOf(lines[1]) && conclusion.indexOf(lines[1]) < conclusion.indexOf(lines[2]));
  const verdictBlock = html.slice(html.indexOf('data-block="verdict"'), html.indexOf('id="diagnosis-title"'));
  assert.ok(lines.every((line) => !verdictBlock.includes(line)), '第 6 块不含三行');
  assert.match(verdictBlock, /比较对象/);
  assert.match(verdictBlock, /判定门槛/);
});
