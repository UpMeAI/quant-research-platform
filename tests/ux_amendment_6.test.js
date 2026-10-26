'use strict';
/**
 * UX 修订 6（CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_6）H5 确定性验收。
 * H1 采用决定记录（追加式、只有完成权威能写、失败关闭、撤销保留历史）；H2 对比卡第一行是采用决定；
 * H3 一览表行数 = 锁定结果 + 基线 + 随机对照；H4 汇总计数与「方向偏差」提示（N ≥ 3 且采用率 < 50%）。
 * 记录全部写在测试自己的临时账本里（夹具结果）；不写任何真实决定。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const { dataRoot } = require('./_env');
const loop = require('../services/runtime-research-loop');
const workspace = require('../services/research-workspace');
const q0 = require('../services/baseline-evaluation');
const cc = require('../services/candidate-comparison');
const adoption = require('../services/research-adoption');
const overview = require('../services/research-adoption/overview');
const { validateRecord } = require('../schemas');
const fx0 = require('./_q0_fixture');
const fx1 = require('./_q1_fixture');
const fx2 = require('./_q2_fixture');
const fx3 = require('./_q3_fixture');
const fx4 = require('./_q4_fixture');

const CASE = cc.CASE_REF;
const STRATEGY = cc.STRATEGY_REF;
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
const BANNER = '大部分研究未被采用：研究方向偏离『以优化策略为目的』，需要调整（见当前研究计划）';

loop.openCase({
  case_id: CASE, strategy_ref: STRATEGY, market: 'US_EQUITY',
  runtime_lane: { source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64), version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
  baseline: {
    baseline_id: 'BASELINE-A6-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY', version_ref: 'US_V5_ETF_6000USD@frozen-old',
    source_ref: 'SMARTFLOW:SIGNED_RESEARCH:US_V5_ETF_6000USD', source_hash: 'b'.repeat(64), expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
    frozen_at: '2026-10-24T20:01:00Z',
  },
  cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
  data_quality: { status: 'VALID', as_of: '2026-10-23', known_at: '2026-10-24T20:00:00Z', source_refs: ['SMARTFLOW:US_V5_SCAN_RECORD_V2'], freshness: { state: 'CURRENT', age_seconds: 0 } },
  isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
  opened_at: '2026-10-24T20:02:00Z',
});

// 修订 7：「总览」页签（J1）的断言在 ux_amendment_7.test.js；这里的断言只针对原来的五个页签，所以去掉总览那一节
const withoutOverview = (html) => html.replace(/<section class="section detail-section" id="detail-overview">[\s\S]*?(?=<section class="section detail-section" id="detail-runtime">)/, '');
// 修订 7 J2：页签只渲染自己的内容；这些断言读整页，所以渲染「全部展开」视图（section=all，结构折叠全部打开）
async function renderPage(model, hash = `#strategy-detail?strategy=${STRATEGY}&section=all`) {
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
  return withoutOverview(elements.workspace.innerHTML);
}
function mainContent(html) {
  let out = html;
  for (let guard = 0; guard < 50 && /<details/.test(out); guard += 1) out = out.replace(/<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/g, '');
  return out;
}
const between = (html, from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const researchSection = (html) => between(html, 'id="detail-research"', 'id="detail-forward"');
const cardOf = (html, question) => {
  const id = question === 'Q1' ? 'comparison-title' : `comparison-title-${question}`;
  const start = html.indexOf(`aria-labelledby="${id}"`);
  return html.slice(start, html.indexOf('</section>', html.indexOf('class="bt-blocks"', start)));
};
const verdictOf = (card) => card.slice(card.indexOf('data-cmp-block="verdict"'), card.indexOf('data-cmp-block="', card.indexOf('data-cmp-block="verdict"') + 10));
const overviewOf = (html) => between(html, '<div class="adoption-overview">', '<div class="research-queue">');
const ledgerBytes = (file) => { try { return fs.readFileSync(file); } catch { return Buffer.alloc(0); } };
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** 合成 Q0 + Q1–Q4 全部锁定（Q3 带随机对照两部分）；采用记录账本清空。 */
function setup() {
  for (const ledger of [q0.LEDGER(), cc.LEDGER(), adoption.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); cc.clearCache();
  const doc0 = fx0.result();
  const lock0 = q0.importBaselineEvaluation(fx0.write(doc0), { registeredBy: AUTHORITY, allowNonActual: true });
  const files = {
    Q1: fx1.write(fx1.result(doc0, lock0.file_sha256, lock0.result_id)),
    Q2: fx2.write(fx2.result(doc0, lock0.file_sha256, lock0.result_id)),
    Q3: fx3.write(fx3.result(doc0, lock0.file_sha256, lock0.result_id)),
    Q4: fx4.write(fx4.result(doc0, lock0.file_sha256, lock0.result_id)),
  };
  const locks = Object.fromEntries(Object.entries(files).map(([question, file]) => [question, cc.importCandidateComparison(file, { registeredBy: AUTHORITY, allowNonActual: true })]));
  return { lock0, locks, files };
}
const projections = (locks) => ({
  baseline: q0.buildProjection(q0.headLock(CASE), { allowNonActual: true }),
  cards: Object.values(locks).map((lock) => cc.buildProjection(lock, { allowNonActual: true, question: lock.question_ref })),
});
const modelOf = ({ baseline, cards }) => workspace.readModel({ strategyRef: STRATEGY, baseline, comparison: cards });

let evidenceSeq = 0;
/** 决定记录文件（测试自己的临时文件）及其 sha256。 */
function evidence(text = `Owner 决定记录 ${evidenceSeq += 1}`) {
  const file = path.join(dataRoot, `adoption-evidence-${evidenceSeq}.md`);
  fs.writeFileSync(file, `${text}\n`);
  return { path: file, sha256: sha(fs.readFileSync(file)) };
}
const decision = (resultId, decided, extra = {}) => ({
  result_id: resultId, decision: decided, follow_up_zh: decided === 'ADOPT' ? '纳入第二轮组合候选' : '不再研究',
  decided_by: 'OWNER', owner_words: decided === 'ADOPT' ? '这个采用' : '这个不采用', decided_at: '2026-10-26T21:00:00+08:00',
  coordinator_recommendation: { recommendation: decided === 'NOT_APPLICABLE' ? 'NOT_ADOPTED' : decided, reason_zh: '依据见对比卡' },
  evidence_ref: evidence(), ...extra,
});
const write = (input, options = {}) => adoption.recordAdoption(input, { writtenBy: AUTHORITY, allowNonActual: true, ...options });
const rejects = (input, code, options) => assert.throws(() => write(input, options), (error) => error.code === code, code);

// ── H1 记录 ────────────────────────────────────────────────────────────────────────────

test('H1 正向：权威写入一条 ADOPT 决定，字段齐全、过 schema；锁账本一字节不变', () => {
  const { locks } = setup();
  const before = [q0.LEDGER(), cc.LEDGER()].map((file) => sha(ledgerBytes(file)));
  const record = write(decision(locks.Q1.result_id, 'ADOPT'));
  assert.equal(record.schema, 'RESEARCH_ADOPTION_DECISION_V1');
  assert.equal(record.kind, 'DECISION');
  assert.equal(record.decision, 'ADOPT');
  assert.equal(record.decided_by, 'OWNER');
  assert.equal(record.owner_words, '这个采用');
  assert.equal(record.question_ref, 'Q1');
  assert.equal(record.strategy_ref, STRATEGY);
  assert.equal(record.written_by, AUTHORITY);
  assert.equal(record.production_effect, 'NONE');
  assert.match(record.record_id, /^ADR-[0-9a-f]{16}$/);
  assert.deepEqual(validateRecord(record), { ok: true, problems: [] });
  assert.equal(adoption.records().length, 1);
  assert.deepEqual([q0.LEDGER(), cc.LEDGER()].map((file) => sha(ledgerBytes(file))), before, '采用记录不碰结果锁');
});

test('H1 负例：非权威、未知 result_id、未锁定（封存文件被改）的结果、缺字段、字段不合规，一律拒绝且账本不写', () => {
  const { lock0, locks, files } = setup();
  const good = () => decision(locks.Q2.result_id, 'NOT_ADOPTED');
  rejects(good(), 'ADOPTION_WRITTEN_BY_NOT_AUTHORIZED', { writtenBy: 'SOMEONE_ELSE' });
  assert.throws(() => adoption.recordAdoption(good(), { allowNonActual: true }), (error) => error.code === 'ADOPTION_WRITTEN_BY_REQUIRED');
  rejects({ ...good(), result_id: 'Q2-0000000000000000' }, 'ADOPTION_RESULT_UNKNOWN');
  for (const key of ['follow_up_zh', 'owner_words', 'evidence_ref', 'coordinator_recommendation']) {
    const input = good(); delete input[key];
    assert.throws(() => write(input), (error) => /^ADOPTION_(FIELD_MISSING|FIELD_INVALID)$/.test(error.code), key);
  }
  rejects({ ...good(), decision: 'MAYBE' }, 'ADOPTION_FIELD_INVALID');
  rejects({ ...good(), decided_by: 'COORDINATOR' }, 'ADOPTION_FIELD_INVALID');
  rejects({ ...good(), decided_at: '2026-10-26' }, 'ADOPTION_FIELD_INVALID');
  rejects({ ...good(), evidence_ref: { path: '/no/such/file.md', sha256: 'a'.repeat(64) } }, 'ADOPTION_EVIDENCE_MISSING');
  rejects({ ...good(), evidence_ref: { ...evidence(), sha256: 'b'.repeat(64) } }, 'ADOPTION_EVIDENCE_SHA256_MISMATCH');
  // NOT_APPLICABLE 只给基线与随机对照；它们也只能写 NOT_APPLICABLE
  rejects(decision(locks.Q2.result_id, 'NOT_APPLICABLE'), 'ADOPTION_NOT_APPLICABLE_ONLY_FOR_BASELINE_OR_CONTROL');
  rejects(decision(lock0.result_id, 'ADOPT'), 'ADOPTION_BASELINE_OR_CONTROL_MUST_BE_NOT_APPLICABLE');
  rejects(decision(locks.Q3.result_id, 'NOT_ADOPTED', { part: 'Q3A' }), 'ADOPTION_BASELINE_OR_CONTROL_MUST_BE_NOT_APPLICABLE');
  rejects(decision(locks.Q3.result_id, 'NOT_APPLICABLE', { part: 'Q9X' }), 'ADOPTION_PART_UNKNOWN');
  rejects({ kind: 'RECOMMENDATION', result_id: lock0.result_id, coordinator_recommendation: { recommendation: 'ADOPT', reason_zh: 'x' } }, 'ADOPTION_RECOMMENDATION_ONLY_FOR_COMPARISON');
  assert.equal(adoption.records().length, 0, '被拒绝的写入一行都不落账本');
  // 未锁定：封存文件在锁定之后被改，结果不再是 LOCKED_VERIFIED
  fs.appendFileSync(files.Q4, ' ');
  cc.clearCache();
  rejects(decision(locks.Q4.result_id, 'NOT_ADOPTED'), 'ADOPTION_RESULT_NOT_LOCKED');
  assert.equal(adoption.records().length, 0);
  // 基线与对照可以写 NOT_APPLICABLE（可不写建议）
  write(decision(lock0.result_id, 'NOT_APPLICABLE', { coordinator_recommendation: null, follow_up_zh: '基线，不适用' }));
  write(decision(locks.Q3.result_id, 'NOT_APPLICABLE', { part: 'Q3A', coordinator_recommendation: null, follow_up_zh: '对照，不适用' }));
  assert.equal(adoption.records().length, 2);
});

test('H1 撤销：已有有效决定时，不带 supersedes 或 supersedes 对不上都拒绝；正确 supersedes 后新决定生效，旧记录仍在', () => {
  const { locks } = setup();
  const first = write(decision(locks.Q1.result_id, 'NOT_ADOPTED'));
  rejects(decision(locks.Q1.result_id, 'ADOPT'), 'ADOPTION_DECISION_EXISTS');
  rejects(decision(locks.Q1.result_id, 'ADOPT', { supersedes: 'ADR-0000000000000000' }), 'ADOPTION_DECISION_EXISTS');
  rejects(decision(locks.Q2.result_id, 'ADOPT', { supersedes: first.record_id }), 'ADOPTION_SUPERSEDES_TARGET_NOT_FOUND');
  const second = write(decision(locks.Q1.result_id, 'ADOPT', { supersedes: first.record_id, owner_words: '改成采用' }));
  const rows = adoption.records();
  assert.deepEqual(rows.map((row) => [row.record_id, row.decision, row.supersedes]), [[first.record_id, 'NOT_ADOPTED', null], [second.record_id, 'ADOPT', first.record_id]], '历史保留，没有覆盖');
  assert.equal(adoption.effective().get(adoption.keyOf(locks.Q1.result_id)).record_id, second.record_id);
});

test('H1 建议：只有建议时可写 RECOMMENDATION；之后的决定可直接接上（写了 supersedes 就必须对得上），建议留在历史里', () => {
  const { locks } = setup();
  const rec = write({ kind: 'RECOMMENDATION', result_id: locks.Q2.result_id, coordinator_recommendation: { recommendation: 'NOT_ADOPTED', reason_zh: '改善只来自少数交易' } });
  assert.equal(rec.kind, 'RECOMMENDATION');
  assert.equal(rec.decision, null);
  assert.deepEqual(validateRecord(rec), { ok: true, problems: [] });
  rejects({ kind: 'RECOMMENDATION', result_id: locks.Q2.result_id, decision: 'ADOPT', coordinator_recommendation: { recommendation: 'ADOPT', reason_zh: 'x' } }, 'ADOPTION_RECOMMENDATION_HAS_DECISION_FIELD');
  rejects(decision(locks.Q2.result_id, 'NOT_ADOPTED', { supersedes: 'ADR-0000000000000000' }), 'ADOPTION_SUPERSEDES_MISMATCH');
  const done = write(decision(locks.Q2.result_id, 'NOT_ADOPTED'));
  assert.equal(adoption.effective().get(adoption.keyOf(locks.Q2.result_id)).record_id, done.record_id);
  assert.equal(adoption.records().length, 2);
});

// ── H2 对比卡第一行 ─────────────────────────────────────────────────────────────────────

test('H2 有决定的卡片第一行写「采用」或「不采用」；只有建议的写「待 Owner 决定（协调会话建议…）」；三行保留在其后，标题「依据」', async () => {
  const { locks } = setup();
  write(decision(locks.Q1.result_id, 'ADOPT'));
  write(decision(locks.Q2.result_id, 'NOT_ADOPTED', { follow_up_zh: '前向影子观察' }));
  write({ kind: 'RECOMMENDATION', result_id: locks.Q3.result_id, coordinator_recommendation: { recommendation: 'NOT_ADOPTED', reason_zh: '排序层减少了期末资本' } });
  const html = await renderPage(await modelOf(projections(locks)));
  const expected = {
    Q1: '采用（纸面账户执行，Owner 2026-10-26 决定）',
    Q2: '不采用（现行规则不变；后续：前向影子观察）',
    Q3: '待 Owner 决定（协调会话建议：不采用 —— 排序层减少了期末资本）',
    Q4: '待 Owner 决定（协调会话尚未给出建议）',
  };
  for (const [question, label] of Object.entries(expected)) {
    const card = mainContent(cardOf(html, question));
    const status = card.slice(card.indexOf('<div class="status-row">'));
    assert.ok(status.startsWith(`<div class="status-row"><span class="pill`) && status.indexOf(`采用决定：${label}`) < status.indexOf('优势结论：'), `${question} 卡片的第一行是采用决定`);
    const verdict = verdictOf(card);
    const body = verdict.slice(verdict.indexOf('</h4>') + 5);
    assert.ok(body.startsWith(`<p class="adoption-line`) && body.includes(`<strong>采用决定：</strong>${label}</p><h5 class="formula-title">依据</h5><ul class="completeness"`), `${question}：${body.slice(0, 300)}`);
  }
});

// ── H3 / H4 一览与采用率 ────────────────────────────────────────────────────────────────

test('H3 一览表：行数 = 锁定结果数 + 基线 + 随机对照；数字取自锁定结果的投影；基线与对照写「不适用」', async () => {
  const { locks } = setup();
  const { baseline, cards } = projections(locks);
  const html = await renderPage(await modelOf({ baseline, cards }));
  const table = overviewOf(mainContent(researchSection(html)));
  const rows = table.match(/<tr><td>[\s\S]*?<\/tr>/g) || [];
  const controls = cards.flatMap((card) => (card.extra_cards || []).filter((extra) => extra.data && Array.isArray(extra.data.parts)).flatMap((extra) => extra.data.parts));
  assert.equal(controls.length, 2);
  assert.equal(rows.length, cards.length + 1 + controls.length);
  assert.ok(rows[0].includes('<strong>Q0</strong>') && rows[0].includes('不适用（基线）'));
  assert.equal(rows.filter((row) => row.includes('不适用（对照）')).length, 2);
  const q2 = cards.find((card) => card.question_ref === 'Q2');
  const account = q2.blocks.find((block) => block.key === 'account').data;
  const row2 = rows.find((row) => row.includes('<strong>Q2</strong>'));
  const usd = (value) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  assert.ok(row2.includes(`${usd(account.arms[0].end_capital)} → ${usd(account.arms[1].end_capital)}`), row2);
  assert.ok(row2.includes(`<td>${q2.verdict_label}</td>`));
  assert.ok(researchSection(html).indexOf('class="adoption-overview"') < researchSection(html).indexOf('class="research-queue"'), '一览在研究队列之上');
});

async function summaryWith(locks, decisions) {
  for (const [question, decided] of Object.entries(decisions)) write(decision(locks[question].result_id, decided));
  const html = await renderPage(await modelOf(projections(locks)));
  return overviewOf(mainContent(researchSection(html)));
}

test('H4 N = 4、采用率 25%：汇总计数正确，显示「方向偏差」提示', async () => {
  const { locks } = setup();
  const table = await summaryWith(locks, { Q1: 'ADOPT', Q2: 'NOT_ADOPTED', Q3: 'NOT_ADOPTED', Q4: 'NOT_ADOPTED' });
  assert.match(table, /已决定 4 题：采用 1、不采用 3，采用率 1 ÷ 4 = 25%；待决定 0 题/);
  assert.ok(table.includes(`<p class="deviation-banner" role="status">${BANNER}</p>`));
});

test('H4 N = 4、采用率 50%：不显示提示；N < 3 时也不显示；待决定计数只数对比题', async () => {
  let { locks } = setup();
  let table = await summaryWith(locks, { Q1: 'ADOPT', Q2: 'ADOPT', Q3: 'NOT_ADOPTED', Q4: 'NOT_ADOPTED' });
  assert.match(table, /已决定 4 题：采用 2、不采用 2，采用率 2 ÷ 4 = 50%；待决定 0 题/);
  assert.ok(!table.includes(BANNER));
  ({ locks } = setup());
  table = await summaryWith(locks, { Q1: 'NOT_ADOPTED', Q2: 'NOT_ADOPTED' });
  assert.match(table, /已决定 2 题：采用 0、不采用 2，采用率 0 ÷ 2 = 0%；待决定 2 题/);
  assert.ok(!table.includes(BANNER), 'N < 3 不提示');
  ({ locks } = setup());
  table = await summaryWith(locks, {});
  assert.match(table, /已决定 0 题：采用 0、不采用 0，采用率 —（还没有已决定的题）；待决定 4 题/);
});

test('H4.3 研究计划分轮次：一览按轮次分组，每轮各算一次采用率，另给累计；阈值在每个汇总上各判一次', () => {
  const card = (question, resultId) => ({
    state: 'LOCKED_VERIFIED', question_ref: question, result_id: resultId, title_zh: question, verdict_label: '证据不足',
    blocks: [{ key: 'account', state: 'AVAILABLE', data: { arms: [{ end_capital: 3000, max_drawdown: 0.1 }, { end_capital: 3100, max_drawdown: 0.1 }], diff_vs_baseline: { end_capital: 100 } } }],
  });
  const baselineProjection = { state: 'LOCKED_VERIFIED', result_id: 'Q0-x', conclusion: { label: '未通过' }, blocks: [{ key: 'account', state: 'AVAILABLE', data: { arms: [{ key: 'D', end_capital: 3000, max_drawdown: 0.1 }] } }] };
  const queue = {
    baseline: { name_zh: '原版', part_zh: '基线' }, rounds: { 1: '第一轮', 2: '第二轮' },
    questions: { Q1: { round: 1 }, Q2: { round: 1 }, Q3: { round: 1 }, Q5: { round: 2 }, Q6: { round: 2 } },
  };
  const rec = (decided) => ({ kind: 'DECISION', decision: decided, follow_up_zh: '—', decided_at: '2026-11-01T10:00:00+08:00', record_id: `ADR-${decided}` });
  const records = new Map([['R1|', rec('NOT_ADOPTED')], ['R2|', rec('NOT_ADOPTED')], ['R3|', rec('NOT_ADOPTED')], ['R5|', rec('ADOPT')], ['R6|', rec('ADOPT')]]);
  const view = overview.overviewOf({ baselineProjection, comparisons: ['Q1', 'Q2', 'Q3', 'Q5', 'Q6'].map((q) => card(q, `R${q.slice(1)}`)), queue, records });
  assert.deepEqual(view.groups.map((group) => [group.label_zh, group.rows.map((row) => row.question_ref)]), [['第一轮', ['Q0', 'Q1', 'Q2', 'Q3']], ['第二轮', ['Q5', 'Q6']]]);
  assert.deepEqual(view.groups.map((group) => [group.summary.decided, group.summary.adopted, group.summary.deviates]), [[3, 0, true], [2, 2, false]]);
  assert.deepEqual([view.cumulative.decided, view.cumulative.adopted, view.cumulative.rate, view.cumulative.deviates], [5, 2, 0.4, true]);
  assert.equal(view.cumulative.text_zh, '已决定 5 题：采用 2、不采用 3，采用率 2 ÷ 5 = 40%；待决定 0 题');
  assert.equal(overview.MIN_DECIDED, 3);
});

test('真实页面（没有任何采用记录）：每张锁定对比卡第一行写「待 Owner 决定（协调会话尚未给出建议）」，一览只列已锁定的题、基线与对照', async () => {
  for (const ledger of [q0.LEDGER(), cc.LEDGER(), adoption.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); cc.clearCache();
  const ROOT = path.join(__dirname, '..');
  const baseline = q0.buildProjection(q0.importBaselineEvaluation(path.join(ROOT, 'var/evidence/us-v5-m2-q0-current-2026-10-25/US_V5_M2_Q0_RESULT_V1.json'), { registeredBy: AUTHORITY }));
  const cards = ['q1-2026-10-25/US_V5_M2_Q1', 'q2-2026-10-25/US_V5_M2_Q2'].map((name) => {
    const lock = cc.importCandidateComparison(path.join(ROOT, `var/evidence/us-v5-m2-${name}_RESULT_V1.json`), { registeredBy: AUTHORITY });
    return cc.buildProjection(lock, { question: lock.question_ref });
  });
  const html = await renderPage(await modelOf({ baseline, cards }));
  for (const question of ['Q1', 'Q2']) assert.match(verdictOf(cardOf(html, question)), /<strong>采用决定：<\/strong>待 Owner 决定（协调会话尚未给出建议）<\/p>/);
  const rows = overviewOf(mainContent(researchSection(html))).match(/<tr><td>[\s\S]*?<\/tr>/g) || [];
  assert.equal(rows.length, 3, '基线 + Q1 + Q2（没有锁定 Q3，就没有对照行）');
  assert.match(overviewOf(html), /已决定 0 题：采用 0、不采用 0，采用率 —（还没有已决定的题）；待决定 2 题/);
  assert.equal(adoption.records().length, 0, '页面只读，不写采用记录');
});
