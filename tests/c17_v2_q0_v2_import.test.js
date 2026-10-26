'use strict';
/**
 * CRYPTO_Q0_RESULT_V1 增补 1 冻结说明 2（C17_V2 Q0 V2 的读法，`8cb58669…`）：
 *   - 合成夹具（CI 可跑）：对象形式的 supersedes、指向的锁必须存在且 sha 一致、档案 successor_readings 的校验；
 *   - 真实 V1 + V2 文件（Mac research-data/qrp_crypto_v1/）：带 --supersedes 导入、五条读法逐字、页面与 J5.1；文件不在本机时跳过（跳过不算通过）。
 * 账本在临时目录（tests/_env），不碰 var/ledger、var/evidence。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const AUTHORITY = 'C17_Q0_V2_TEST_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const profiles = require('../services/strategy-profiles');
const k3 = require('../services/baseline-evaluation');
const workspace = require('../services/research-workspace');
const c17 = require('./_c17_q0_fixture');

const C17 = profiles.mustGet('C17_V2_4000USDT');
const QS = profiles.mustGet('QUICK_SHOT_V3_1000USDT');
const V2_SCHEMA = 'C17_V2_M2_Q0_RESULT_V2';
const PRODUCTION = JSON.parse(fs.readFileSync(profiles.FILE, 'utf8'));
const REAL_V1 = path.join(process.env.QRP_C17_Q0_REAL_DIR || '/Users/kaylame/KaylaProject/research-data/qrp_crypto_v1/q0-c17', 'C17_V2_M2_Q0_RESULT_V1.json');
const REAL_V2 = path.join(process.env.QRP_C17_Q0_V2_REAL_DIR || '/Users/kaylame/KaylaProject/research-data/qrp_crypto_v1/m2-c17', 'C17_V2_M2_Q0_RESULT_V2.json');
const HAVE_DESK = Boolean(process.env.QRP_DESK_ROOT) && fs.existsSync(path.join(process.env.QRP_DESK_ROOT || '', 'src', 'operation-review.js'));
const SKIP_REAL = fs.existsSync(REAL_V1) && fs.existsSync(REAL_V2) ? false : '真实 C17 Q0 V1 / V2 文件不在本机；跳过不算通过';
const SKIP_PAGE = !SKIP_REAL && HAVE_DESK ? false : '真实 C17 Q0 文件或 Desk 目录（QRP_DESK_ROOT）不在本机；页面断言跳过不算通过';
const CHROME = [process.env.QRP_TEST_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((file) => fs.existsSync(file));
const SKIP_BROWSER = SKIP_PAGE || (CHROME ? false : '本机没有 Chrome（可用 QRP_TEST_CHROME 指定）；浏览器布局未验证，跳过不算通过');
const C17_DETAIL = '#strategy-detail?strategy=C17_V2_4000USDT';

// 冻结说明 2 的五条文字
const NOTE2_ROW = '补充（V1 读法：每根 4H 收线后第一个检查点决定一次）';
const NOTE3_PRODUCTION = '生产 10 分钟扫描网格（勘误 1 E-1）';
const NOTE3_PLUS5 = '网格相位平移 5 分钟（分钟 3，勘误 1 E-2）';
const NOTE4_LINE = 'V1 读法（每根 4H 只决定一次）：期末 7,737';
const NOTE5_LINE = '勘误 1 已于 2026-10-27 冻结（协调冻结裁定 3 F1）';
const V1_SHA = '26691b6c3a2c42277f33f28e2622de56d7f26eea16d371ef9193f0dfe2fe9e4e';
const V2_SHA = 'e80c42523b30f7681aaede3e4f11b39475ed8fc9d724335400a7a8ba0db009fa';
const SUPERSEDE = { supersedes: 'Q0-26691b6c3a2c4227', defectRef: 'C17_V2_QRP_ONBOARDING_K2_ERRATUM_1_CADENCE', reason: 'K2 §5 扫描节奏勘误 1（协调冻结裁定 3 F1）：按生产 10 分钟网格' };

const PAGE = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
async function renderPage(model, hash) {
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
const textOf = (html) => html.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const withoutDetails = (html) => {
  let out = html;
  for (let guard = 0; guard < 50 && /<details/.test(out); guard += 1) out = out.replace(/<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/g, '');
  return out;
};
const block = (projection, key) => projection.blocks.find((item) => item.key === key);
const rejects = (code, detail) => (error) => { assert.equal(error.code, code); if (detail) assert.match(error.detail || '', detail); return true; };

// ── 第 1 条：对象形式的 supersedes（合成夹具） ─────────────────────────────────────

test('冻结说明 2 第 1 条：对象形式读作一个元素的数组——指向的锁必须在同一 case 且 sha 一致、必须带 --supersedes；结构不符与没有登记的档案仍是 Q0_SUPERSEDES_INVALID', () => {
  fs.rmSync(k3.LEDGER(), { force: true });
  const v1 = c17.write(c17.result());
  const v2Of = (patch) => c17.write(c17.result((doc) => {
    doc.identity.schema = V2_SCHEMA;
    doc.identity.supersedes = { schema: 'C17_V2_M2_Q0_RESULT_V1', sha256: c17.fileSha(v1), file: 'synthetic/V1.json', commit: 'abcdef12', state: 'INSUFFICIENT', kept_visible: true, reason_zh: '合成夹具：按生产 10 分钟网格重放', erratum_ref: 'synthetic/ERRATUM.md' };
    if (patch) patch(doc);
  }));
  const opts = { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref, allowNonActual: true };
  // 指向的锁不存在（V1 未锁）
  assert.throws(() => k3.importBaselineEvaluation(v2Of(), opts), rejects('Q0_SUPERSEDES_INVALID', /没有锁/));
  const v1Lock = k3.importBaselineEvaluation(v1, opts);
  // 没带 --supersedes：一个 case 只锁一次
  assert.throws(() => k3.importBaselineEvaluation(v2Of(), opts), rejects('BASELINE_ALREADY_LOCKED'));
  // sha 与已锁的 V1 不一致
  assert.throws(() => k3.importBaselineEvaluation(v2Of((doc) => { doc.identity.supersedes.sha256 = 'a'.repeat(64); }), { ...opts, supersedes: v1Lock.result_id, defectRef: 'D', reason: 'R' }),
    rejects('Q0_SUPERSEDES_INVALID', /没有锁/));
  // 结构不符
  for (const [patch, detail] of [
    [(doc) => { delete doc.identity.supersedes.reason_zh; }, null],
    [(doc) => { doc.identity.supersedes.commit = 'not-hex'; }, /commit/],
    [(doc) => { doc.identity.supersedes.state = 'SUPERSEDED_X'; }, /state/],
    [(doc) => { doc.identity.supersedes.schema = V2_SCHEMA; }, /schema/],
  ]) assert.throws(() => k3.importBaselineEvaluation(v2Of(patch), { ...opts, supersedes: v1Lock.result_id, defectRef: 'D', reason: 'R' }), rejects('Q0_SUPERSEDES_INVALID', detail));
  const v2 = v2Of();
  const v2Lock = k3.importBaselineEvaluation(v2, { ...opts, supersedes: v1Lock.result_id, defectRef: 'D', reason: 'R' });
  assert.deepEqual(k3.locks(C17.case_ref).map((row) => row.result_id), [v1Lock.result_id, v2Lock.result_id]);
  const projection = k3.buildProjection(k3.headLock(C17.case_ref), { allowNonActual: true });
  assert.equal(projection.source.superseded[0].text_zh, `已替代的第一次运行（SUPERSEDED，不是结果）：代码 abcdef12，结果文件 ${c17.fileSha(v1).slice(0, 8)}…`);
  assert.equal(projection.source.superseded[0].erratum_ref, 'synthetic/ERRATUM.md');
  assert.equal(projection.source.superseded_note_zh, NOTE5_LINE);
  // 再导 V1：已被对象形式替代
  assert.throws(() => k3.importBaselineEvaluation(v1, opts), rejects('Q0_RESULT_IS_SUPERSEDED'));
  // V1 schema 的文件不读对象形式（只有 V2 登记了 supersedes_object）
  assert.throws(() => k3.validateWhole(c17.result((doc) => { doc.identity.supersedes = { sha256: 'b'.repeat(64), reason_zh: 'x' }; }), C17), rejects('Q0_SUPERSEDES_INVALID'));
  fs.rmSync(k3.LEDGER(), { force: true });
});

test('冻结说明 2：successor_readings 只对后继 schema 生效——V1 与其他档案不变；键越界、schema 不是后继、form 不认识、固定标签的类别未登记，都拒绝', () => {
  assert.equal(profiles.forSchema(C17, 'C17_V2_M2_Q0_RESULT_V1'), C17);
  assert.equal(profiles.forSchema(QS, V2_SCHEMA), QS);
  assert.equal(C17.phase_words.PRODUCTION, '4H 收线后第一个检查点');
  assert.equal(C17.q0_reading.conclusion_supplementary[0].scenario, 'ENGINE_SCAN_EVERY_10MIN');
  const v2 = profiles.forSchema(C17, V2_SCHEMA);
  assert.equal(v2.phase_words.PRODUCTION, NOTE3_PRODUCTION);
  assert.equal(v2.phase_words.GRID_PHASE_PLUS_5MIN, NOTE3_PLUS5);
  assert.deepEqual(Object.keys(v2.q0_reading.supplementary_kinds), ['RULE_BOUNDARY', 'APPROXIMATION_SIZE', 'SUPERSEDED_READING']);
  assert.equal(v2.q0_reading.supplementary_kind_notes_zh.SUPERSEDED_READING, NOTE2_ROW);
  assert.equal(v2.q0_reading.superseded_note_zh, NOTE5_LINE);
  const rejectsProfile = (patch, detail) => {
    const doc = JSON.parse(JSON.stringify(PRODUCTION));
    patch(doc.profiles.find((item) => item.strategy_ref === C17.strategy_ref).successor_readings);
    assert.throws(() => profiles.validate(doc), (error) => error.code === 'STRATEGY_PROFILE_FIELD_TYPE' && detail.test(error.detail));
  };
  rejectsProfile((all) => { all[V2_SCHEMA].stress_columns = []; }, /stress_columns:不认识/);
  rejectsProfile((all) => { all.C17_V2_M2_Q0_RESULT_V3 = { phase_note_zh: 'x' }; }, /V3:schema 不在 successor_result_schemas/);
  rejectsProfile((all) => { all[V2_SCHEMA].conclusion_supplementary[0].form = 'FULL'; }, /form:END_ONLY/);
  rejectsProfile((all) => { all[V2_SCHEMA].supplementary_kind_notes_zh = { NOT_A_KIND: 'x' }; }, /NOT_A_KIND:不是登记的补充行类别/);
  rejectsProfile((all) => { all[V2_SCHEMA].supersedes_object = 'yes'; }, /supersedes_object:true/);
});

// ── 真实 V1 + V2 ────────────────────────────────────────────────────────────────

function importReal() {
  fs.rmSync(k3.LEDGER(), { force: true });
  const opts = { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref };
  const v1 = k3.importBaselineEvaluation(REAL_V1, opts);
  const v2 = k3.importBaselineEvaluation(REAL_V2, { ...opts, ...SUPERSEDE });
  k3.clearCache();
  return { v1, v2 };
}

test('冻结说明 2 真实文件：V2 带 --supersedes Q0-26691b6c3a2c4227 导入；不带被拒；重导是幂等重放；再导 V1 被拒；V1 只显示为 SUPERSEDED', { skip: SKIP_REAL }, () => {
  fs.rmSync(k3.LEDGER(), { force: true });
  const opts = { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref };
  assert.throws(() => k3.importBaselineEvaluation(REAL_V2, opts), rejects('Q0_SUPERSEDES_INVALID', /没有锁/));
  const v1 = k3.importBaselineEvaluation(REAL_V1, opts);
  assert.throws(() => k3.importBaselineEvaluation(REAL_V2, opts), rejects('BASELINE_ALREADY_LOCKED'));
  const v2 = k3.importBaselineEvaluation(REAL_V2, { ...opts, ...SUPERSEDE });
  assert.equal(v1.result_id, 'Q0-26691b6c3a2c4227');
  assert.equal(v2.result_id, 'Q0-e80c42523b30f768');
  assert.equal(v2.file_sha256, V2_SHA);
  assert.equal(v2.verdict_state, 'INSUFFICIENT');
  assert.equal(v2.inputs_digest, '23a5245cf24708b734a5741c9ecf254e5614a167f31e2355d2dcba57f6c8862e');
  assert.equal(v2.engine_digest, '886272f2c64b4c3a7a66be17cbc7aa069bb244623041f680ea301c944a05a085');
  assert.equal(v2.supersedes_ref, 'Q0-26691b6c3a2c4227');
  assert.equal(v2.defect_ref, SUPERSEDE.defectRef);
  assert.equal(v2.supersede_reason, SUPERSEDE.reason);
  assert.equal(k3.importBaselineEvaluation(REAL_V2, { ...opts, ...SUPERSEDE }).replayHit, true);
  assert.throws(() => k3.importBaselineEvaluation(REAL_V1, opts), rejects('Q0_RESULT_IS_SUPERSEDED'));
  assert.equal(k3.headLock(C17.case_ref).result_id, v2.result_id);
  k3.clearCache();
  const projection = k3.buildProjection(k3.headLock(C17.case_ref));
  assert.equal(projection.state, 'LOCKED_VERIFIED');
  assert.equal(projection.result_id, 'Q0-e80c42523b30f768');
  assert.deepEqual(projection.source.superseded.map(({ text_zh, smartflow_commit, result_sha256, erratum_ref }) => ({ text_zh, smartflow_commit, result_sha256, erratum_ref })), [{
    text_zh: '已替代的第一次运行（SUPERSEDED，不是结果）：代码 4d704291，结果文件 26691b6c…', smartflow_commit: '4d704291', result_sha256: V1_SHA,
    erratum_ref: 'trading-system-v2/docs/C17_V2_QRP_ONBOARDING_K2_ERRATUM_1_CADENCE_DRAFT.md',
  }]);
  // 封存原文原样进技术详情（不改「勘误待冻结」的字样）
  assert.match(projection.source.superseded[0].reason_zh, /K2 §5 节奏勘误草案，待协调会话冻结/);
  fs.rmSync(k3.LEDGER(), { force: true });
});

test('冻结说明 2 真实 V2 的五条读法逐字：补充行固定标签且压力块可用；V2 相位措辞与说明；结论区块的 V1 读法行；勘误已冻结一行', { skip: SKIP_REAL }, () => {
  importReal();
  const projection = k3.buildProjection(k3.headLock(C17.case_ref));
  // 第 2 条
  const stress = block(projection, 'stress');
  assert.equal(stress.state, 'AVAILABLE');
  const row = stress.data.rows.find((item) => item.scenario === 'ENGINE_FIRST_CHECKPOINT_ONLY');
  assert.equal(row.note, NOTE2_ROW);
  assert.equal(row.kind, 'SUPPLEMENTARY');
  assert.equal(row.in_headline, false);
  assert.equal(row.end_capital, 7737.4088059);
  assert.deepEqual(stress.data.counts.supplementary_kinds, [{ kind: 'RULE_BOUNDARY', label_zh: '规则边界', n: 2 }, { kind: 'SUPERSEDED_READING', label_zh: 'V1 读法', n: 1 }]);
  assert.equal(projection.conclusion.completeness.complete, true);
  assert.equal(projection.conclusion.edge_line_zh, '优势结论：证据不足');
  // 第 3 条
  assert.equal(projection.conclusion.main_number.label, `样本外每笔扣费后净 R 均值（基础成本，${NOTE3_PRODUCTION}；门槛 +0.10 R）`);
  const winrate = block(projection, 'winrate').data;
  assert.deepEqual([...new Set(winrate.rows.map((item) => item.phase_label))], [NOTE3_PRODUCTION, NOTE3_PLUS5]);
  assert.deepEqual(winrate.notes, [C17.successor_readings[V2_SCHEMA].phase_note_zh]);
  assert.ok(!JSON.stringify(projection).includes('4H 收线后第一个检查点；门槛'));
  // 第 4 条
  assert.deepEqual(projection.conclusion.supplementary_lines_zh, [NOTE4_LINE]);
  // 第 5 条
  assert.equal(projection.source.superseded_note_zh, NOTE5_LINE);
  fs.rmSync(k3.LEDGER(), { force: true });
});

test('冻结说明 2 真实 V2 的页面：五条文字逐字在主内容；封存原因与勘误引用只在技术详情；总览一句话与胜率卡片；BTC 口径已登记', { skip: SKIP_PAGE }, async () => {
  importReal();
  const model = await workspace.readModel({ strategyRef: C17.strategy_ref });
  const s = model.views['strategy-detail'].summary;
  assert.equal(s.sentence_zh, '现行版本样本外期末 13,199，低于 BTC 买入持有的 14,665（证据不足）；所用引擎为研究引擎近似的当前 D（缺：60 秒成交观测、扫描时刻成交价、stop_loss_history 空源），结论最高只能是证据不足');
  assert.equal(s.tiles.find((tile) => tile.key === 'winrate').row_zh, `样本外 · 基础成本 · ${NOTE3_PRODUCTION}`);
  const html = await renderPage(model, `${C17_DETAIL}&section=runtime`);
  const main = textOf(withoutDetails(html));
  for (const text of [NOTE2_ROW, NOTE3_PRODUCTION, NOTE3_PLUS5, NOTE4_LINE, NOTE5_LINE, '已替代的第一次运行（SUPERSEDED，不是结果）：代码 4d704291，结果文件 26691b6c…']) {
    assert.ok(main.includes(text), `主内容缺：${text}`);
  }
  assert.ok(!main.includes('补充行无效'));
  assert.ok(!main.includes('压力评价不完整'));
  assert.ok(!textOf(html).includes('GRID_PHASE_PLUS_5MIN'), '相位不得写成原码');
  assert.ok(!main.includes('C17_V2_QRP_ONBOARDING_K2_ERRATUM_1_CADENCE_DRAFT.md'));
  assert.ok(textOf(html).includes('勘误引用：trading-system-v2/docs/C17_V2_QRP_ONBOARDING_K2_ERRATUM_1_CADENCE_DRAFT.md'));
  assert.ok(!main.includes('待协调会话冻结') && textOf(html).includes('待协调会话冻结'));
  assert.ok(textOf(html).includes('BTC 买入持有 = 同本金 3,000 USDT、同起点一次买入 BTCUSDT 永续，一直持有到区间结束，中间没有任何买卖。口径：只计价格变化，不计资金费。'));
  assert.ok(!textOf(html).includes('分红口径未记录'));
  fs.rmSync(k3.LEDGER(), { force: true });
});

// J5.1（真浏览器、真实 V2 锁）
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

test('冻结说明 2 J5.1 在 C17 V2 页上：1280 × 800 下总览 ≤ 1,600 px；390 px 宽下总览与各页签都没有整页横向滚动', { skip: SKIP_BROWSER, timeout: 300000 }, async () => {
  importReal();
  const model = await workspace.readModel({ strategyRef: C17.strategy_ref });
  const routes = [[C17_DETAIL, 1280], ...['', '&section=runtime', '&section=health', '&section=research', '&section=forward', '&section=review', '&section=all'].map((extra) => [`${C17_DETAIL}${extra}`, 390])];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__probe')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PROBE(routes)); return; }
    if (req.url.startsWith('/api/workspace')) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(model)); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-c17v2-chrome-'));
  try {
    const stdout = await new Promise((resolve) => {
      const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        `--user-data-dir=${profile}`, '--virtual-time-budget=60000', '--dump-dom', `http://127.0.0.1:${server.address().port}/__probe`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = ''; child.stdout.on('data', (chunk) => { out += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      child.on('close', () => { clearTimeout(timer); resolve(out); });
    });
    const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(stdout);
    assert.ok(match && match[1] !== 'PENDING', '探针页没有跑完');
    const rows = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    assert.equal(rows.length, routes.length);
    for (const row of rows) assert.ok(row.sections >= 1 && row.text > 80, `${row.route} @${row.width} 没有渲染出页面（${row.text} 字）`);
    assert.ok(rows[0].height <= 1600, `C17 V2 总览 @1280：${rows[0].height} px > 1,600`);
    for (const row of rows.filter((item) => item.width === 390)) assert.ok(row.scrollWidth <= row.clientWidth, `${row.route} @390：整页横向宽度 ${row.scrollWidth} > ${row.clientWidth}`);
    console.log(`C17 V2 J5.1: overview@1280 height=${rows[0].height}; 390: ${rows.slice(1).map((row) => `${row.route.split('&section=')[1] || 'overview'} ${row.scrollWidth}/${row.clientWidth}`).join(', ')}`);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(k3.LEDGER(), { force: true });
  }
});
