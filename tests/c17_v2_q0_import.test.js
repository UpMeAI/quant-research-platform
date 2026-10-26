'use strict';
/**
 * CRYPTO_Q0_RESULT_V1 增补 1 §7（C17_V2 长历史 Q0）与协调会话冻结说明 1：
 *   - 负例、校验器负例、一句话结论用合成夹具 tests/_c17_q0_fixture.js（CI 不读真实文件）；
 *   - 真实文件（Mac research-data/qrp_crypto_v1/q0-c17/）的导入、逐字页面断言与 UX 修订 7 J5.1：文件不在本机时跳过（跳过不算通过）。
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
const AUTHORITY = 'C17_Q0_TEST_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const profiles = require('../services/strategy-profiles');
const detailNotes = require('../services/strategy-detail-notes');
const k3 = require('../services/baseline-evaluation');
const summary = require('../services/research-workspace/summary');
const workspace = require('../services/research-workspace');
const diagnostics = require('../services/strategy-diagnostics');
const c17 = require('./_c17_q0_fixture');
const qs = require('./_qs_q0_fixture');

const C17 = profiles.mustGet('C17_V2_4000USDT');
const QS = profiles.mustGet('QUICK_SHOT_V3_1000USDT');
const PRODUCTION = JSON.parse(fs.readFileSync(profiles.FILE, 'utf8'));
const REAL = path.join(process.env.QRP_C17_Q0_REAL_DIR || '/Users/kaylame/KaylaProject/research-data/qrp_crypto_v1/q0-c17', 'C17_V2_M2_Q0_RESULT_V1.json');
const HAVE_DESK = Boolean(process.env.QRP_DESK_ROOT) && fs.existsSync(path.join(process.env.QRP_DESK_ROOT || '', 'src', 'operation-review.js'));
const SKIP_REAL = fs.existsSync(REAL) ? false : '真实 C17 Q0 文件不在本机（QRP_C17_Q0_REAL_DIR）；跳过不算通过';
const SKIP_PAGE = !SKIP_REAL && HAVE_DESK ? false : '真实 C17 Q0 文件或 Desk 目录（QRP_DESK_ROOT）不在本机；页面断言跳过不算通过';
const CHROME = [process.env.QRP_TEST_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((file) => fs.existsSync(file));
const SKIP_BROWSER = SKIP_PAGE || (CHROME ? false : '本机没有 Chrome（可用 QRP_TEST_CHROME 指定）；浏览器布局未验证，跳过不算通过');
const C17_DETAIL = '#strategy-detail?strategy=C17_V2_4000USDT';

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

const project = (doc, profile = C17) => k3.project({ doc, sha256: 'f'.repeat(64), file: '/synthetic', size: 1 },
  { strategy_ref: profile.strategy_ref, result_id: 'Q0-test', locked_at: 't', locked_by: 't', inputs_digest: 'x', engine_digest: 'x' }, profile);
const block = (projection, key) => projection.blocks.find((item) => item.key === key);
const refuses = (patch, code, detail) => assert.throws(() => k3.validateWhole(c17.result(patch), C17), (error) => {
  assert.equal(error.code, code);
  if (detail) assert.match(error.detail || '', detail);
  return true;
});

// ── §7.7 负例（合成夹具） ─────────────────────────────────────────────────────────

test('§7.7 输入与引擎摘要：系列项缺 sha256 也缺 derived/minute、或值不是 64 位 → Q0_INPUT_SERIES_INCOMPLETE；engine_sha256 不合法 → Q0_ENGINE_BLOBS_MISSING', () => {
  const digests = (patch) => () => k3.internals.digests(c17.result(patch));
  const throwsCode = (fn, code) => assert.throws(fn, (error) => error.code === code);
  throwsCode(digests((doc) => { delete doc.inputs.series[0].derived_sha256; }), 'Q0_INPUT_SERIES_INCOMPLETE');
  throwsCode(digests((doc) => { doc.inputs.series[1].minute_sha256 = { a: 'abc' }; }), 'Q0_INPUT_SERIES_INCOMPLETE');
  throwsCode(digests((doc) => { doc.inputs.manifests = { 'x.json': 'short' }; }), 'Q0_INPUT_SERIES_INCOMPLETE');
  throwsCode(digests((doc) => { doc.identity.engine_sha256.research = 'not-a-sha'; }), 'Q0_ENGINE_BLOBS_MISSING');
  const ok = k3.internals.digests(c17.result());
  assert.match(ok.inputs_digest, /^[0-9a-f]{64}$/);
  // 新式只在系列项缺 sha256 时用：QS 夹具（系列项有 sha256）的两个摘要不随 manifests / engine_sha256 以外的读法变化
  const qsDoc = qs.result();
  assert.deepEqual(k3.internals.digests(qsDoc), k3.internals.digests({ ...qsDoc, inputs: { ...qsDoc.inputs, manifests: { 'x.json': 'a'.repeat(64) } } }));
});

test('§7.7 近似引擎：missing ≠ NOT_IMPLEMENTED、标签不以「研究引擎近似的当前 D」开头或缺 A0 残差、uncapped_state 不认识，各被拒绝；flag = true 时 SUPPORTED 仍拒绝', () => {
  refuses((doc) => { doc.verdict.engine_approximation.missing = []; }, 'Q0_ENGINE_GAPS_MISMATCH');
  refuses((doc) => { doc.verdict.label_zh = '当前 D（缺：60 秒成交观测、扫描时刻成交价）'; }, 'Q0_ENGINE_LABEL_INCOMPLETE');
  refuses((doc) => { doc.verdict.label_zh = '研究引擎近似的当前 D（缺：60 秒成交观测）'; }, 'Q0_ENGINE_LABEL_INCOMPLETE', /扫描时刻成交价/);
  refuses((doc) => { doc.verdict.uncapped_state = 'MAYBE'; }, 'Q0_VERDICT_STATE_UNSUPPORTED');
  assert.throws(() => k3.validateWhole(c17.result((doc) => {
    doc.stats.rows[1].mean_R_ci = [0.15, 0.5]; doc.verdict.L_R = 0.15; doc.verdict.L_g = 0.01; doc.stats.g_vs_btc.OOS.ci = [0.01, 0.5]; doc.verdict.state = 'SUPPORTED';
  }), C17), (error) => /^Q0_VERDICT_SUPPORTED_/.test(error.code));
  assert.deepEqual(k3.validateWhole(c17.result(), C17).length > 0, true); // A0 未通过与未实现规则是缺口，flag 必须 true
});

test('§7.7 压力：补充行 simulated:false 但 kind 未登记或 in_headline 不是 false → 无效；最大亏损最大的补充行不进主数字；只有 max_loss_usd → 缺字段', () => {
  const stressOf = (patch) => block(project(c17.result(patch)), 'stress');
  const ok = stressOf();
  assert.equal(ok.state, 'AVAILABLE');
  assert.equal(ok.data.headline.scenario, 'SCAN_PHASE_PLUS_60MIN'); // BOUNDARY_K5_OFF 9,999 是补充行，不进
  assert.equal(ok.data.rows.find((row) => row.scenario === 'BOUNDARY_K5_OFF').note, '补充（规则边界，只报不判，不进结论）');
  assert.deepEqual([ok.data.counts.simulated, ok.data.counts.supplementary], [2, 2]);
  assert.match(stressOf((doc) => { doc.stress.rows.find((row) => row.scenario === 'BOUNDARY_K5_OFF').kind = 'OTHER'; }).reason, /kind 必须是登记的词/);
  assert.match(stressOf((doc) => { delete doc.stress.rows.find((row) => row.scenario === 'BOUNDARY_K5_OFF').in_headline; }).reason, /in_headline:false/);
  const usd = stressOf((doc) => { const row = doc.stress.rows.find((item) => item.scenario === 'FEES_X2'); row.max_loss_usd = row.max_loss_usdt; delete row.max_loss_usdt; });
  assert.equal(usd.state, 'NOT_BACKTESTED');
  assert.match(usd.reason, /缺 stress\.max_loss_usdt/);
  // QS 档案没有 supplementary_kinds：补充行仍必须 simulated:true（G2 不回归）
  assert.match(block(project(qs.result((doc) => { doc.stress.rows.push({ ...doc.stress.rows[1], scenario: 'SUPP', status: 'SUPPLEMENTARY_NOT_IN_CONCLUSION', in_headline: false, kind: 'RULE_BOUNDARY' }); }), QS), 'stress').reason,
    /补充行必须 simulated:true/);
});

test('§7.7 停止事件：样本外有事件而 HALT_HONORED 与参照相同 → 压力块无效；drawdown_pct 原样写，不乘 100', () => {
  const bad = block(project(c17.result((doc) => { doc.halt_events.OOS.events = [...doc.halt_events.IS.events]; })), 'stress');
  assert.equal(bad.state, 'NOT_BACKTESTED');
  assert.match(bad.reason, /停止事件与 HALT_HONORED 不一致/);
  const ok = block(project(c17.result()), 'stress').data.halt;
  assert.match(ok.lines_zh[1], /回撤 50\.09%/);
  assert.doesNotMatch(ok.lines_zh.join(''), /5008/);
});

test('§7.7 非主流近似臂：simulated 不是 true 或期末与压力行不等 → 只有补充块无效，结论与压力块不变', () => {
  const baseline = project(c17.result());
  for (const patch of [(doc) => { doc.non_major_arm.simulated = false; }, (doc) => { doc.non_major_arm.with_non_majors.end_capital = 1101; }]) {
    const projection = project(c17.result(patch));
    const stress = block(projection, 'stress');
    assert.equal(stress.state, 'AVAILABLE');
    assert.equal(stress.data.supplementary_arm.valid, false);
    assert.match(stress.data.supplementary_arm.text_zh, /^非主流近似臂无效：/);
    assert.deepEqual(projection.conclusion, baseline.conclusion);
    assert.deepEqual(stress.data.headline, block(baseline, 'stress').data.headline);
  }
  assert.equal(block(baseline, 'stress').data.supplementary_arm.rows[0].detail_zh, '其中非主流 20 笔，每笔 −0.011 R');
});

test('§7.7 前向：已平 + 未平 ≠ 笔数 → 前向行无效；note_zh 存在时一定显示；子行缺字段只让子行无效', () => {
  const forwardOf = (patch) => block(project(c17.result(patch)), 'account').data.forward;
  assert.equal(forwardOf((doc) => { doc.forward.open = 3; }).valid, false);
  const ok = forwardOf();
  assert.equal(ok.note_line_zh, '研究会话说明：合成夹具：前向说明');
  assert.equal(ok.text_zh, '前向记录（PAPER 账本 C17_V2_4000USDT，2026-10-07 起，只报不判，不进结论）：15 笔（已平 13、未平 2），净 −670.57 USDT，每笔均值 −0.516 R。');
  const sub = forwardOf((doc) => { delete doc.forward.current_d_full_from_2026_10_20.closed; });
  assert.equal(sub.valid, true);
  assert.match(sub.sub_lines_zh[0], /子行无效/);
});

test('§7.7 结论区块的补充行：指向的不是补充行 → 只有那一行无效；census_columns 为空时不读普查，QS 缺普查仍是第 1 块缺字段', () => {
  const projection = project(c17.result((doc) => { delete doc.stress.rows.find((row) => row.scenario === 'ENGINE_SCAN_EVERY_10MIN').status; }));
  assert.deepEqual(projection.conclusion.supplementary_lines_zh, ['补充行无效：ENGINE_SCAN_EVERY_10MIN 不是补充行']);
  assert.equal(projection.conclusion.state, 'INSUFFICIENT');
  const withCensus = block(project(c17.result((doc) => { doc.inputs.census = [{ year: 2024, tradable_carriers: 'x' }]; })), 'period');
  assert.equal(withCensus.state, 'AVAILABLE');
  assert.deepEqual(withCensus.data.census, []);
  const qsPeriod = block(project(qs.result((doc) => { delete doc.inputs.census; }), QS), 'period');
  assert.equal(qsPeriod.state, 'NOT_BACKTESTED');
  assert.match(qsPeriod.reason, /缺 inputs\.census/);
});

test('§7.7 小数位：C17 的 r_digits 3 写「+0.098 R」、probability_digits 2 写「6.95%」；QS 夹具仍是两位 R 与一位概率', async () => {
  const c17Text = (doc, profile) => {
    const projection = project(doc, profile);
    return { projection, basis: projection.conclusion.basis.main.join('；') };
  };
  assert.match(c17Text(c17.result(), C17).basis, /\+0\.098 R/);
  assert.match(c17Text(qs.result(), QS).basis, /\+0\.20 R，95% 区间 −0\.10 R 至 \+0\.50 R/);
  const model = (projection, profile) => ({
    navigation: [], views: { 'strategy-detail': { currency: profile.currency, ...(profile.q0_reading.r_digits ? { r_digits: profile.q0_reading.r_digits } : {}), backtest: { blocks: projection.blocks, source: projection.source } } },
  });
  const kellyHtml = (projection, profile) => {
    // 只渲染半凯利块（页面脚本的 BLOCK_RENDER），不依赖工作台
    const sandbox = { document: { getElementById: () => ({ innerHTML: '', addEventListener() {}, querySelector() { return null; }, focus() {}, scrollIntoView() {} }), title: '' }, location: { hash: '' }, window: { addEventListener() {} },
      fetch: () => new Promise(() => {}), requestAnimationFrame() {}, URLSearchParams, Intl, encodeURIComponent, console }; // 页面自己的 load() 永远等着，不渲染整页
    vm.createContext(sandbox);
    vm.runInContext(`${SCRIPT};globalThis.__k=(m)=>{MONEY=m.views['strategy-detail'].currency;R_DIGITS=m.views['strategy-detail'].r_digits||2;return BLOCK_RENDER.kelly(m.views['strategy-detail'].backtest.blocks.find((b)=>b.key==='kelly').data);};`, sandbox);
    return sandbox.__k(model(projection, profile));
  };
  assert.match(kellyHtml(project(c17.result()), C17), /<dd>6\.95%<\/dd>/);
  assert.match(kellyHtml(project(qs.result(), QS), QS), /<dd>30\.0%<\/dd>/);
});

test('冻结说明 1 第 1 条：V2 按导入规格 §8 替代 V1——V1 先锁；V2（后继 schema，supersedes 指向 V1）带 supersedes 导入；页面只把 V1 写成 SUPERSEDED；再导 V1 拒绝', () => {
  fs.rmSync(k3.LEDGER(), { force: true });
  const v1 = c17.write(c17.result());
  const v1Lock = k3.importBaselineEvaluation(v1, { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref, allowNonActual: true });
  const v2 = c17.write(c17.result((doc) => {
    doc.identity.schema = 'C17_V2_M2_Q0_RESULT_V2';
    doc.identity.supersedes = [{ state: 'SUPERSEDED', smartflow_commit: 'c'.repeat(40), result_sha256: c17.fileSha(v1), reason_zh: '合成夹具：按生产 10 分钟节奏重建基线' }];
  }));
  // 没带 supersedes：一个 case 只锁一次
  assert.throws(() => k3.importBaselineEvaluation(v2, { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref, allowNonActual: true }),
    (error) => error.code === 'BASELINE_ALREADY_LOCKED');
  const v2Lock = k3.importBaselineEvaluation(v2, { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref, allowNonActual: true,
    supersedes: v1Lock.result_id, defectRef: 'C17-V2-SCAN-CADENCE', reason: 'V2 按生产 10 分钟节奏重建基线' });
  assert.equal(v2Lock.supersedes_ref, v1Lock.result_id);
  assert.deepEqual(k3.locks(C17.case_ref).map((row) => row.result_id), [v1Lock.result_id, v2Lock.result_id]);
  const projection = k3.buildProjection(k3.headLock(C17.case_ref), { allowNonActual: true });
  assert.equal(projection.result_id, v2Lock.result_id);
  assert.match(projection.source.superseded[0].text_zh, /^已替代的第一次运行（SUPERSEDED，不是结果）：代码 cccccccc，结果文件 /);
  assert.throws(() => k3.importBaselineEvaluation(v1, { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref, allowNonActual: true }),
    (error) => error.code === 'Q0_RESULT_IS_SUPERSEDED');
  // 不认识的 schema 仍拒绝
  assert.throws(() => k3.validateWhole(c17.result((doc) => { doc.identity.schema = 'C17_V2_M2_Q0_RESULT_V3'; }), C17), (error) => error.code === 'Q0_RESULT_SCHEMA_UNSUPPORTED');
  fs.rmSync(k3.LEDGER(), { force: true });
});

// ── §7.8 档案校验器负例 ───────────────────────────────────────────────────────────

test('§7.8 档案校验器：新键越界或缺字段、LEGACY 带读法、共享约束原文不含「共享，未复算」、空普查无标的说明，都拒绝；新口径词只在有证据时接受', () => {
  const variant = (mutate) => {
    const doc = JSON.parse(JSON.stringify(PRODUCTION));
    mutate(doc.profiles.find((item) => item.strategy_ref === 'C17_V2_4000USDT'), doc.profiles[0]);
    return () => profiles.validate(doc);
  };
  const rejects = (mutate, code, detail) => assert.throws(variant(mutate), (error) => {
    assert.equal(error.code, code);
    if (detail) assert.match(error.detail, detail);
    return true;
  });
  rejects((p) => { p.q0_reading.r_digits = 4; }, 'STRATEGY_PROFILE_FIELD_TYPE', /r_digits/);
  rejects((p) => { p.q0_reading.kelly.probability_digits = 3; }, 'STRATEGY_PROFILE_FIELD_TYPE', /probability_digits/);
  rejects((p) => { p.q0_reading.stress_columns[0].format = 'BPS'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /stress_columns\[0\]\.format/);
  rejects((p) => { p.q0_reading.supplementary_kinds = {}; }, 'STRATEGY_PROFILE_FIELD_MISSING', /supplementary_kinds/);
  rejects((p) => { delete p.q0_reading.supplementary_arm.rows[1].stress_scenario; }, 'STRATEGY_PROFILE_FIELD_MISSING', /supplementary_arm\.rows\[1\]\.stress_scenario/);
  rejects((p) => { p.q0_reading.forward.sub_rows = []; }, 'STRATEGY_PROFILE_FIELD_TYPE', /sub_rows/);
  rejects((p) => { delete p.q0_reading.universe_note_zh; }, 'STRATEGY_PROFILE_FIELD_MISSING', /census_columns/);
  rejects((p) => { p.shared_constraints[1].text_zh = '海外桶 Rule 1b：四本账合计 16,000'; }, 'STRATEGY_PROFILE_FIELD_TYPE', /text_zh/);
  rejects((p, us) => { us.q0_reading = { r_digits: 3 }; }, 'STRATEGY_PROFILE_FIELD_TYPE', /US_V5_ETF_3000USD\.q0_reading/);
  rejects((p) => { p.successor_result_schemas = [p.baseline_result_schema]; }, 'STRATEGY_PROFILE_FIELD_TYPE', /successor_result_schemas/);
  rejects((p, us) => { us.successor_result_schemas = ['US_V5_M2_Q0_RESULT_V2']; }, 'STRATEGY_PROFILE_FIELD_TYPE', /US_V5_ETF_3000USD\.successor_result_schemas/);
  // 说明登记：新口径词 PRICE_ONLY_NO_FUNDING 没有证据 → 拒绝；有证据才接受
  const notes = JSON.parse(fs.readFileSync(detailNotes.FILE, 'utf8'));
  const entry = notes.strategies.C17_V2_4000USDT.comparators.BTC_BUY_HOLD.dividend_basis[0];
  assert.equal(entry.basis, 'PRICE_ONLY_NO_FUNDING');
  assert.ok(entry.evidence.length > 0);
  // 扫描节奏勘误 1：V2 结果文件（e80c4252…）单独登记同一口径，页面不读成「分红口径未记录」
  const v2 = detailNotes.comparatorNote(detailNotes.forStrategy('C17_V2_4000USDT'), 'BTC_BUY_HOLD', 'e80c42523b30f7681aaede3e4f11b39475ed8fc9d724335400a7a8ba0db009fa');
  assert.equal(v2.dividend, 'PRICE_ONLY_NO_FUNDING');
  assert.ok(notes.strategies.C17_V2_4000USDT.comparators.BTC_BUY_HOLD.dividend_basis.find((item) => item.result_sha256.startsWith('e80c4252')).evidence.length > 0);
  const broken = JSON.parse(JSON.stringify(notes));
  broken.strategies.C17_V2_4000USDT.comparators.BTC_BUY_HOLD.dividend_basis[0].evidence = [];
  assert.throws(() => detailNotes.validate(broken), (error) => error.code === 'STRATEGY_DETAIL_NOTES_FIELD' && /evidence/.test(error.detail));
});

// ── §7.9 一句话结论 ────────────────────────────────────────────────────────────────

test('§7.9 一句话结论：C17（flag = true）带标签分句；QS（flag = false）与没有档案读法的调用不带；没有采用一览时不带采用部分', () => {
  const sentenceFor = (projection, engineClause) => summary.overviewOf({
    strategy: null, caseRec: null, conclusion: { ...projection.conclusion, result_state: 'LOCKED_VERIFIED' }, backtest: { ...projection, state: 'LOCKED_VERIFIED' },
    comparisons: [], overview: null, notesQueue: null, queueView: null, isMain: k3.mainRowTest(engineClause ? C17 : QS), engineClause,
  }).sentence_zh;
  assert.equal(sentenceFor(project(c17.result()), true),
    `现行版本样本外期末 1,012，低于 BTC 买入持有的 1,013（证据不足）；所用引擎为${c17.LABEL}，结论最高只能是证据不足`);
  assert.equal(sentenceFor(project(c17.result()), false), '现行版本样本外期末 1,012，低于 BTC 买入持有的 1,013（证据不足）');
  assert.doesNotMatch(sentenceFor(project(qs.result(), QS), true), /所用引擎/);
  assert.doesNotMatch(sentenceFor(project(c17.result()), true), /采用/);
});

// ── §7.3 / §7.4 / §7.5 / §7.6 真实文件 ─────────────────────────────────────────────

async function realModel(strategyRef = C17.strategy_ref) {
  if (!k3.headLock(C17.case_ref)) k3.importBaselineEvaluation(REAL, { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref });
  k3.clearCache();
  return workspace.readModel({ strategyRef });
}

test('§7.3 真实文件导入（临时账本）：result_id、case、三态、两个摘要；重复导入是幂等重放；M1 诊断按规则失败关闭', { skip: SKIP_REAL }, () => {
  fs.rmSync(k3.LEDGER(), { force: true });
  const lock = k3.importBaselineEvaluation(REAL, { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref });
  assert.equal(lock.result_id, 'Q0-26691b6c3a2c4227');
  assert.equal(lock.strategy_ref, 'C17_V2_4000USDT');
  assert.equal(lock.case_ref, 'RRC-C17-V2-4000USDT-V8-1-M0');
  assert.equal(lock.verdict_state, 'INSUFFICIENT');
  assert.equal(lock.file_sha256, '26691b6c3a2c42277f33f28e2622de56d7f26eea16d371ef9193f0dfe2fe9e4e');
  assert.equal(lock.inputs_digest, '23a5245cf24708b734a5741c9ecf254e5614a167f31e2355d2dcba57f6c8862e');
  assert.equal(lock.engine_digest, '0fc06f112c8304ef26d5945882b5f4eb5a1daf0c0567ac5e9fe03baaa4577e76');
  assert.equal(k3.importBaselineEvaluation(REAL, { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref }).replayHit, true);
  assert.equal(k3.locks(C17.case_ref).length, 1);
  // §1.2 M1 ★(a)：没有登记生产者，诊断失败关闭
  assert.equal(diagnostics.readDiagnostic({ strategyRef: C17.strategy_ref }).reason_code, 'DIAGNOSTIC_PRODUCER_NOT_REGISTERED');
});

const US_WORDS = ['undefined', '美元', 'US$', 'SPY', '5 bps', '相位 ±60 分钟', '120 分钟', '规则清单无缺口', '7.2 USDT', '600 USDT', 'Q0-24fb86c3609f7ef3', 'Q0-bd83dd6ec1754dbc', 'RRC-US-V5', '698.67', '2,102'];
const C17_NUMBERS = ['7,737', '3,723.77', 'Q0-26691b6c3a2c4227', '13,198.71', '−670.57', '1,800 USDT', 'C17-R2', 'R1B-1'];

test('§7.4–§7.6 真实文件的页面（全部展开）：逐字断言、C17 页不含 US 与 QS 的词和数字、US 与 QS 页不含 C17 数字、修订 4–7 的计数', { skip: SKIP_PAGE }, async () => {
  const model = await realModel();
  const detail = model.views['strategy-detail'];
  assert.equal(detail.backtest.state, 'LOCKED_VERIFIED');
  assert.deepEqual([detail.currency, detail.r_digits], ['USDT', 3]);
  const html = await renderPage(model, `${C17_DETAIL}&section=all`);
  const text = textOf(html);
  const main = textOf(withoutDetails(html));
  const has = (needle, where = main) => assert.ok(where.includes(needle), `页面（主内容）缺：${needle}`);
  const LABEL = '研究引擎近似的当前 D（缺：60 秒成交观测、扫描时刻成交价、stop_loss_history 空源）';
  // §2.3 / §2.2：结论、引擎行、主数字、排除行、判定依据四行、最大的限制、优势结论一行；标签三处都在主内容
  has('证据不足');
  has(`引擎：${LABEL}`);
  has('样本外每笔扣费后净 R 均值（基础成本，4H 收线后第一个检查点；门槛 +0.10 R）：+0.076 R（95% 区间 −0.010 R 至 +0.163 R）');
  has('主统计不计资金费缺失的 12 笔（占 2.1%，R-FUND (a)）');
  has(`使用的是${LABEL}，结论最高只能是证据不足`);
  has('每笔扣费后净 R 均值 +0.076 R，95% 区间 −0.010 R 至 +0.163 R，区间跨过门槛 +0.10 R');
  has('相对 BTC 买入持有的账户年化对数增长差 95% 区间 −65.8% 至 33.2%，区间跨过门槛 0');
  has('门槛在看到结果前已冻结');
  has(`最大的限制：使用的是${LABEL}，结论最高只能是证据不足。`);
  has('优势结论：证据不足');
  assert.ok(!main.includes('压力评价不完整') && !main.includes('采用条件：'), '压力完整时不写另外两行');
  has('另须知道：按冻结裁定 1 F3 封顶前的判定也是证据不足，封顶没有改变结论');
  has('另须知道：R 的定义：每笔开仓时的计划风险（plannedRiskUsdt，150.75 × 系数），不是固定金额（K2 §5）。');
  // 第 1 块：标的与本金、A0 原因、A19 与 Rule 1b 两行
  has('主臂只交易 BTCUSDT、ETHUSDT；本金 3,000 USDT、每笔基准风险 150.75 USDT（结果文件 identity.config）；账本名 C17_V2_4000USDT 沿用 V8.1 修订 4 的策略身份');
  has('引擎对齐关卡 A0：未通过——注入生产成交后 A0-2..A0-7 通过、A0-1 2,687 / 2,688；不一致全部来自出场观测（R1 生产缺陷、R2 60 秒观测、R3 扫描时刻价、R4 亚秒时钟）');
  has('惰性硬门：通过（研究选项都不设时，研究版引擎与生产引擎输出逐字节相同，冻结裁定 2 G1.2）', text);
  has('A19 共享亏损预算：与 Quick Shot V3 共享，未复算（规则 C17-R2）');
  has('海外桶 Rule 1b：四本账合计 16,000，自起点峰值回撤 ≥ 40% 全体停新开仓，只有 Owner 解除（共享，未复算；研究题 R1B-1）');
  // §3.1 计数行与最大损失；§3.2 补充一行；§3.3 第一行；§3.4 三行；§4 三行
  has('已执行 9 个压力场景（另有 1 个与当前 D 参照相同），模拟 2 个，补充 3 个（规则边界 2、近似大小 1），缺场景 0 个，无效输入 0 个；另有当前 D 参照 1 行、风控维度 4 行（只报不判，不进最大损失）。缺场景和无效输入不计为已执行的压力。');
  has('最大损失：3,723.77 USDT（场景：晚一小时决定（4H 收线后 +60 分钟的检查点））');
  has('补充（只报不判，不进结论）：按生产节奏每 10 分钟扫描，样本外 607 笔，每笔 +0.098 R，期末 13,198.71 USDT；当前 D 参照（4H 收线后第一个检查点）565 笔，每笔 +0.076 R，期末 7,737.41 USDT。这是研究引擎近似（C17-E1）的大小，不是另一个版本的结论。');
  has('补充（规则边界，只报不判，不进结论）');
  has('非主流近似臂（补充，只报不判，不进结论）');
  has('主流 + 非主流（代理标的池）：568 笔，每笔 +0.012 R（95% 区间 −0.074 R 至 +0.096 R），胜率 49.5%，期末 3,636.90 USDT，最大回撤 41.8%；其中非主流 289 笔，每笔 −0.011 R');
  has('前向记录（PAPER 账本 C17_V2_4000USDT，2026-10-07 起，只报不判，不进结论）：15 笔（已平 13、未平 2），净 −670.57 USDT，每笔均值 −0.516 R。');
  has('研究会话说明：只报不判；10-21 22:50 CST 起生产止损移动未写库（C17-D7），这些交易不代表规则本意');
  has('其中 2026-10-20 起全部现行规则同时在效：已平 2 笔，净 −171.59 USDT，每笔均值 −1.138 R。');
  has('停止规则事件（R-HALT (a)：主臂不执行停止，只记事件）');
  has('样本外：周复盘 STOP 0 周，没有停止事件；第一次停止即停（HALT_HONORED）与当前 D 参照相同。');
  has('开发期（只报不判）：第一次在 2022-05-08 结束的那一周，Rule 1：自起点回撤到 50% 停止线（回撤 50.09%，当时已平仓 395 笔，每笔期望 −0.002 R）；开发期 STOP 周共 34 个。');
  has('Rule 1b 看海外桶（含其他账本），不复算。');
  has('Q0 结果文件里带有前向记录 15 笔（只报不判）；HK 前向影子：本策略尚未登记。');
  // §5：两张卡的数字与算式四行
  has('凯利比例 f* = p − (1 − p) ÷ b，p 为样本外胜率，b 为赔率。');
  has('按保守下沿 p = 45.4%、b = 1.08，f* = −5.2%。');
  has('f* ≤ 0 → 半凯利 = 0：长期看下注越多亏得越多，不支持按凯利加仓');
  has('这里的 p、b 与上面「胜率与赔率」表样本外、4H 收线后第一个检查点、基础成本那一行相同。');
  has('按半凯利定仓期末资本区间3,000 USDT 至 3,000 USDT最大回撤0.0%跌破 1,800 USDT（Rule 1b 40% 线；看重抽路径中的最低权益）的概率0.00%半凯利 = 0：不支持按凯利加仓');
  has('期末资本区间2,076 USDT 至 23,589 USDT最大回撤35.9%跌破 1,800 USDT（Rule 1b 40% 线；看重抽路径中的最低权益）的概率6.95%现行：每笔风险 150.75 × min(2, max(1, E / 3000)) × 去风险系数（生产区间）');
  has('研究计算，不是仓位建议；现行仓位规则不变。底线：Rule 1b 的 1,800 USDT（3,000 USDT 的 40% 线）。');
  // §1.2 ★(a) 口径行
  has('BTC 买入持有 = 同本金 3,000 USDT、同起点一次买入 BTCUSDT 永续，一直持有到区间结束，中间没有任何买卖。口径：只计价格变化，不计资金费。');
  // §7.5：不得出现的词与数字；「1,800」只紧跟 USDT；不出现原样的英文原因码
  for (const word of US_WORDS) assert.ok(!text.includes(word), `C17 页面不得出现：${word}`);
  assert.ok(!/1,800(?! USDT)/.test(text), '「1,800」只能紧跟「USDT」');
  for (const code of Object.keys(k3.internals.REASON_WORDS)) assert.ok(!main.includes(code), `主内容不得出现英文原因码 ${code}`);
  // §7.6：判定依据与结论一致；「页面不重算」回测与研究区一次（另加总览页签的来源行）；E1/E3/E4/E6 的行在
  assert.match(html, /<section class="conclusion warn" data-state="INSUFFICIENT"[\s\S]*?判定依据/);
  assert.equal((html.match(/页面不重算/g) || []).length, (html.match(/数字取自已锁定的结果文件与采用记录，页面不重算/g) || []).length + 1);
  assert.match(html, /class="kelly-formula"/); // E1
  assert.match(text, /距最高点 −\d+\.\d%；最高点在 \d{4}-\d{2}-\d{2}/); // E3
  assert.match(text, /开发期 \d+ 行（样本少，只报）——点开查看 · 笔数：开发期 488 笔/); // E4
  assert.match(text, /证据不足 = 95% 区间跨过了事先冻结的门槛/); // E6

  // US_V5 与 QS 页面（全部展开）不得出现 C17 的数字
  for (const ref of ['US_V5_ETF_3000USD', 'QUICK_SHOT_V3_1000USDT']) {
    const other = await renderPage(await realModel(ref), `#strategy-detail?strategy=${ref}&section=all`);
    for (const word of C17_NUMBERS) assert.ok(!textOf(other).includes(word), `${ref} 页面不得出现 C17 的：${word}`);
  }
});

test('修订 7 在 C17 页上：默认「总览」——一句话结论带引擎标签，比较对象是 BTC 买入持有；页签只渲染自己；没有 US / QS 的词', { skip: SKIP_PAGE }, async () => {
  const model = await realModel();
  const s = model.views['strategy-detail'].summary;
  assert.equal(s.sentence_zh, '现行版本样本外期末 7,737，低于 BTC 买入持有的 14,665（证据不足）；所用引擎为研究引擎近似的当前 D（缺：60 秒成交观测、扫描时刻成交价、stop_loss_history 空源），结论最高只能是证据不足');
  assert.equal(s.tiles.find((tile) => tile.key === 'winrate').row_zh, '样本外 · 基础成本 · 4H 收线后第一个检查点');
  const html = await renderPage(model, C17_DETAIL);
  assert.equal((html.match(/class="section detail-section"/g) || []).length, 1);
  assert.match(html, /id="detail-overview"/);
  for (const section of ['runtime', 'health', 'research', 'forward', 'review']) {
    const tab = await renderPage(model, `${C17_DETAIL}&section=${section}`);
    assert.equal((tab.match(/class="section detail-section"/g) || []).length, 1, section);
    for (const word of US_WORDS) assert.ok(!textOf(tab).includes(word), `C17 ${section} 页签不得出现：${word}`);
  }
  for (const word of US_WORDS) assert.ok(!textOf(html).includes(word), `C17 总览不得出现：${word}`);
});

// 修订 7 J5.1 在 C17 页上（真浏览器、真实数据）
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

test('修订 7 J5.1 在 C17 页上：1280 × 800 下总览 ≤ 1,600 px；390 px 宽下总览与各页签都没有整页横向滚动（真实 Q0 锁）', { skip: SKIP_BROWSER, timeout: 300000 }, async () => {
  const model = await realModel();
  const page = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'));
  const routes = [[C17_DETAIL, 1280], ...['', '&section=runtime', '&section=health', '&section=research', '&section=forward', '&section=review', '&section=all'].map((extra) => [`${C17_DETAIL}${extra}`, 390])];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__probe')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PROBE(routes)); return; }
    if (req.url.startsWith('/api/workspace')) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(model)); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-c17-chrome-'));
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
    assert.ok(rows[0].height <= 1600, `C17 总览 @1280：${rows[0].height} px > 1,600`);
    for (const row of rows.filter((item) => item.width === 390)) assert.ok(row.scrollWidth <= row.clientWidth, `${row.route} @390：整页横向宽度 ${row.scrollWidth} > ${row.clientWidth}`);
    console.log(`C17 J5.1: overview@1280 height=${rows[0].height}; 390: ${rows.slice(1).map((row) => `${row.route.split('&section=')[1] || 'overview'} ${row.scrollWidth}/${row.clientWidth}`).join(', ')}`);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});
