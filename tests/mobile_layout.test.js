'use strict';
/**
 * UX 验收 §43／修订 1 A5.4：360 CSS px（及 390 px）下不得有整页水平滚动。
 *
 * 页面脚本在没有 DOM 的 vm 里跑（research_web_render.test.js）量不出布局，所以这里用真浏览器：
 * 本测试起真实的 Research 服务（临时台账里导入了 Q0 与 Q1 的封存结果，文本里故意放了真实文件里那种
 * 不带空格的长代码），用无头 Chrome 加载同源的探针页，探针页把每条路由放进固定宽度的 iframe，量
 * `documentElement.scrollWidth` 与 `clientWidth`。本机没有 Chrome（可用 QRP_TEST_CHROME 指定）时跳过，
 * 并在跳过说明里写明——跳过不算通过。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const loop = require('../services/runtime-research-loop');
const q0 = require('../services/baseline-evaluation');
const q1 = require('../services/candidate-comparison');
const { createServer } = require('../apps/research-api');
const fx0 = require('./_q0_fixture');
const fx1 = require('./_q1_fixture');
const fx2 = require('./_q2_fixture');
const fx3 = require('./_q3_fixture');

const STRATEGY = q0.STRATEGY_REF;
const CHROME = [process.env.QRP_TEST_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .filter(Boolean).find((file) => fs.existsSync(file));
const LONG = 'US_V5_TIME_STOP_VS_TREND_EXIT_RESULT_V1_WITHOUT_ANY_BREAK_OPPORTUNITY_AT_ALL_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// 修订 7：策略详情加默认页签「总览」（不带 section）、全部展开（section=all）与 card= 定位
const ROUTES = [
  '#strategies', `#strategy-detail?strategy=${STRATEGY}`, `#strategy-detail?strategy=${STRATEGY}&section=runtime`, `#strategy-detail?strategy=${STRATEGY}&section=research`,
  `#strategy-detail?strategy=${STRATEGY}&section=forward`, `#strategy-detail?strategy=${STRATEGY}&section=all`, `#strategy-detail?strategy=${STRATEGY}&card=Q3`,
  '#experiments', '#shadow', '#promotion', '#runtime-status',
];

const PROBE = `<!doctype html><meta charset="utf-8"><title>probe</title><pre id="out">PENDING</pre><script>
const width = Number(new URLSearchParams(location.search).get('w'));
const routes = ${JSON.stringify(ROUTES)};
(async () => {
  const results = [];
  for (const route of routes) {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;left:0;top:0;border:0;height:800px;width:' + width + 'px';
    frame.src = '/' + route;
    document.body.appendChild(frame);
    await new Promise((resolve) => frame.addEventListener('load', resolve));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const doc = frame.contentDocument;
    const root = doc.documentElement;
    results.push({ route, width, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, rendered: Boolean(doc.querySelector('#workspace .answer-panel, #workspace .detail-top')), text: doc.getElementById('workspace').innerText.length, cards: doc.querySelectorAll('section.comparison').length });
    frame.remove();
  }
  document.getElementById('out').textContent = JSON.stringify(results);
})();
</script>`;

/** 封存文件放在不带 fixture 字样的目录里，页面读取时才不会被当作「非实际来源」。 */
function sealed(doc, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-mobile-layout-'));
  const file = path.join(dir, name);
  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.sha256`, `${require('node:crypto').createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  return file;
}

function seed() {
  loop.openCase({
    case_id: q0.CASE_REF, strategy_ref: STRATEGY, market: 'US_EQUITY',
    runtime_lane: { source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64), version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
    baseline: {
      baseline_id: 'BASELINE-MOBILE-LAYOUT', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY', version_ref: 'US_V5_ETF_6000USD@frozen-old',
      source_ref: 'SMARTFLOW:SIGNED_RESEARCH:US_V5_ETF_6000USD', source_hash: 'b'.repeat(64), expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
      frozen_at: '2026-10-24T20:01:00Z',
    },
    cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
    data_quality: { status: 'VALID', as_of: '2026-10-23', known_at: '2026-10-24T20:00:00Z', source_refs: ['SMARTFLOW:US_V5_SCAN_RECORD_V2'], freshness: { state: 'CURRENT', age_seconds: 0 } },
    isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
    opened_at: '2026-10-24T20:02:00Z',
  });
  const q0Doc = fx0.result((doc) => {
    doc.diagnosis_items[0].facts = [`T3 研究在 IS 与 OOS 的点估计同向（${LONG}）`, `2026-10-01 生产的 3 次扫描全部以 ${LONG} 拒绝标的池`];
    doc.diagnosis_items[1].no_topic_reason = `原因：${LONG}`;
  });
  const q0Lock = q0.importBaselineEvaluation(sealed(q0Doc, 'Q0.json'), { registeredBy: AUTHORITY });
  const q1Doc = fx1.result(q0Doc, q0Lock.file_sha256, q0Lock.result_id, (doc) => {
    doc.comparison.question_zh = `问题：${LONG}`;
    doc.comparison.candidate_label_zh = `候选：${LONG}`;
    doc.verdict.fail_label = `数据充分度：${LONG}`;
    doc.forward[0].text_zh = `前向：${LONG}`;
  });
  q1.importCandidateComparison(sealed(q1Doc, 'Q1.json'), { registeredBy: AUTHORITY });
  // Q2 的卡：问题、候选、样本外理由、路由、前向原因、归因的定义与说明、类别与栏的名字里都放长代码
  const q2Doc = fx2.result(q0Doc, q0Lock.file_sha256, q0Lock.result_id, (doc) => {
    doc.comparison.question_zh = `问题：${LONG}`;
    doc.comparison.candidate_label_zh = `候选：${LONG}`;
    doc.comparison.routing.single_stock_2x.treatment_zh = `处理：${LONG}`;
    doc.oos_reuse_detail = { reason_zh: `理由：${LONG}`, other_studies_zh: `其他研究：${LONG}` };
    doc.forward.reason_zh = `前向：${LONG}`;
    doc.attribution.definitions_zh = [`定义：${LONG}`];
    doc.attribution.fill_limits.note_zh = `说明：${LONG}`;
    doc.attribution.columns[0].label_zh = `母序列信号${LONG}`;
    doc.attribution.oos.by_class[0].label_zh = `指数${LONG}`;
    doc.verdict.fail_label = `数据充分度：${LONG}`;
  });
  q1.importCandidateComparison(sealed(q2Doc, 'Q2.json'), { registeredBy: AUTHORITY });
  // Q3 的主卡与随机对照卡：问题、候选、样本外理由、前向原因、选择点定义、种子规则、分位数名字里都放长代码
  const q3Doc = fx3.result(q0Doc, q0Lock.file_sha256, q0Lock.result_id, (doc) => {
    doc.comparison.question_zh = `问题：${LONG}`;
    doc.comparison.candidate_label_zh = `候选：${LONG}`;
    doc.oos_reuse_detail = { reason_zh: `理由：${LONG}`, same_rule_zh: `同一规则：${LONG}` };
    doc.forward.reason_zh = `前向：${LONG}`;
    for (const target of [doc.random_control, doc.random_control.random_instrument]) {
      target.choice_points.definition_zh = `定义：${LONG}`;
      target.seeds.rule = `规则：${LONG}`;
      target.distribution.g = { ...target.distribution.g, [LONG]: 0.01 };
    }
    doc.verdict.fail_label = `数据充分度：${LONG}`;
  });
  q1.importCandidateComparison(sealed(q3Doc, 'Q3.json'), { registeredBy: AUTHORITY });
}

/** 必须异步起浏览器：服务就在本进程里，同步等待会让浏览器永远拿不到页面。 */
async function measure(port, width) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-chrome-'));
  try {
    const run = await new Promise((resolve) => {
      const child = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        `--user-data-dir=${profile}`, '--virtual-time-budget=60000', '--dump-dom', `http://127.0.0.1:${port}/__probe?w=${width}`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(run.stdout);
    assert.ok(match && match[1] !== 'PENDING', `探针页没有跑完（退出码 ${run.status}）：${run.stdout.slice(0, 400)} | ${run.stderr.split('\n').filter((line) => !/CVDisplayLink/.test(line)).join(' ').slice(0, 300)}`);
    return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}

test('手机宽度 360 与 390 px：各页路由（含策略详情各页签、全部展开与 card= 定位）都没有整页水平滚动，且页面真的渲染了', { skip: CHROME ? false : '本机没有 Chrome（可用 QRP_TEST_CHROME 指定）；浏览器布局未验证，跳过不算通过', timeout: 300000 }, async () => {
  seed();
  const api = createServer({ researchToken: null });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__probe')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PROBE); return; }
    api.emit('request', req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    for (const width of [360, 390]) {
      const rows = await measure(port, width);
      assert.equal(rows.length, ROUTES.length);
      for (const row of rows) {
        assert.ok(row.rendered && row.text > 200, `${row.route} @${width} 没有渲染出页面`);
        // 修订 7 J2：页签只渲染自己的内容，对比卡只在「研究与对比」（含 card= 定位）与全部展开里
        if (/section=(research|all)|card=/.test(row.route)) assert.equal(row.cards, 4, `${row.route} @${width} 应有 Q1、Q2、Q3 三张对比卡加一张随机对照卡`);
        assert.ok(row.scrollWidth <= row.clientWidth, `${row.route} @${width}px：整页横向宽度 ${row.scrollWidth} > ${row.clientWidth}`);
        assert.equal(row.clientWidth, width);
      }
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
