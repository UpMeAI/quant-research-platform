'use strict';
/**
 * 研究题的层登记（QRP_RESEARCH_LAYER_REGISTER_V1；三层分工合同 V1 §2.1，Owner 2026-11-08）：
 *   - config/research_layer_register.v1.json 按合同的层集合校验：§1 三层 + Note 2 §1 四个标签 + UNDECIDED，一个不多一个不少；
 *     每条一行理由并写明节号；本机有合同文件时现场核对合同正文、Note 1、Note 2 的 sha256；
 *   - 合同登记过的不符项（Note 2 的 D11）在该题旁写一条小注；
 *   - 策略总览与详情页上每个研究题都带层：登记了的写层，没登记的写「待交付 · 层登记」，不猜；
 *   - 总览顶部一句下面有按层计数，计数与研究题清单一致；页面只排版，层标签与计数行都来自读模型。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const layers = require('../services/research-layer-register');
const overviewService = require('../services/research-workspace/strategy-overview');
const workspace = require('../services/research-workspace');

const ROOT = path.join(__dirname, '..');
const RAW = JSON.parse(fs.readFileSync(layers.FILE, 'utf8'));
const PAGE = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
const CONTRACT_FILE = path.join(ROOT, '..', RAW.contract_ref.path);
const NOTE_FILES = RAW.contract_ref.notes.map((note) => [note, path.join(ROOT, '..', note.path)]);
const copy = () => JSON.parse(JSON.stringify(RAW));

async function render(model, hash = '#strategies') {
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = {
    id, innerHTML: '', textContent: '', addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}, scrollIntoView() {},
  });
  const sandbox = {
    document: { getElementById: element, title: '', querySelectorAll() { return []; } }, location: { hash }, window: { addEventListener() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(model)) }),
    requestAnimationFrame() {}, URLSearchParams, Intl, encodeURIComponent, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return elements.workspace.innerHTML;
}

/** 一个层对象只能是两种之一：登记过的五个代码之一，或占位。 */
function assertLayer(layer, where) {
  assert.ok(layer && typeof layer === 'object', `${where} 缺 layer`);
  if (layer.registered) {
    assert.ok(layers.LAYER_CODES.includes(layer.code), `${where} 的层代码 ${layer.code} 不在合同层集合里`);
    assert.equal(layer.label_zh, RAW.layers[layer.code].label_zh, `${where} 的层名不是登记里的中文`);
    assert.match(layer.reason_zh, /§\d/);
  } else {
    assert.deepEqual(layer, { code: null, label_zh: '待交付 · 层登记', registered: false }, `${where} 没登记时只能写占位`);
  }
}

/** 总览上渲染的每个研究题：卡片研究题清单、待研究、封存结论、上级账本的题。 */
function overviewItems(overview) {
  const rows = [];
  for (const parent of overview.parents) {
    for (const item of parent.in_progress || []) rows.push([`${parent.strategy_ref}/${item.id}（上级）`, item.layer]);
    for (const card of parent.modules) {
      for (const item of card.research.items || []) rows.push([`${card.strategy_ref}/${item.id}`, item.layer]);
      for (const item of card.research.in_progress || []) rows.push([`${card.strategy_ref}/${item.id}（待研究）`, item.layer]);
      for (const item of (card.research.detail && card.research.detail.verdicts) || []) rows.push([`${card.strategy_ref}/${item.id}（结论）`, item.layer]);
      if (card.kind === 'RESEARCH_MODULE') rows.push([`${card.strategy_ref}/${card.research_ref}（研究线）`, card.research.layer]);
    }
  }
  return rows;
}

test('层登记：八个代码 = 合同 §1 三层 + Note 2 §1 四个标签 + 待定；本机有合同文件时三份 sha256 与登记一致', () => {
  assert.equal(layers.REGISTER.contract, 'QRP_RESEARCH_LAYER_REGISTER_V1');
  assert.deepEqual(Object.keys(RAW.layers).sort(), [...layers.LAYER_CODES].sort());
  for (const code of layers.CONTRACT_LAYERS) assert.ok(layers.LAYER_CODES.includes(code), `合同 §1 的 ${code} 必须在层集合里`);
  assert.deepEqual([...layers.LAYER_CODES].filter((code) => !layers.CONTRACT_LAYERS.includes(code)).sort(),
    ['DIAGNOSTIC', 'DIAGNOSTIC_BASELINE', 'NA_ENGINEERING', 'NA_EXECUTION', 'UNDECIDED']);
  // Note 2 §1 的四个标签名逐字
  assert.deepEqual(layers.NOTE_TAGS.map((code) => RAW.layers[code].label_zh), ['诊断（全策略基线）', '诊断', '不适用（工程）', '不适用（执行）']);
  assert.ok(RAW.contract_ref.sha256.startsWith('a5437476'));
  assert.deepEqual(RAW.contract_ref.notes.map((note) => [note.id, note.sha256.slice(0, 8)]), [['NOTE_1', '04e8259d'], ['NOTE_2', 'b61b051f']]);
  for (const [note, file] of NOTE_FILES) {
    if (fs.existsSync(file)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), note.sha256, `${note.id} 的 sha256 与登记不一致`);
  }
  // 不符项只挂合同登记过的编号；C17 第 1 轮带 D11
  assert.deepEqual(RAW.entries.filter((entry) => entry.deviations).map((entry) => [entry.strategy_ref, entry.id, entry.deviations.map((item) => item.ref).join()]),
    [['C17_V2_4000USDT', 'R1', 'D11']]);
  for (const entry of RAW.entries) {
    assert.ok(layers.LAYER_CODES.includes(entry.layer), `${entry.strategy_ref}/${entry.id}`);
    assert.equal(entry.classified_by, 'coordinator-proposal');
    assert.doesNotMatch(entry.reason_zh, /\n/);
  }
  if (fs.existsSync(CONTRACT_FILE)) {
    const bytes = fs.readFileSync(CONTRACT_FILE);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), RAW.contract_ref.sha256, '合同文件与登记的 sha256 不一致');
    const body = bytes.toString('utf8');
    for (const name of ['风控层', '选股择时层', '仓位与账户层']) assert.ok(body.includes(name), `合同 §1 应有「${name}」`);
  }
});

test('层登记：形状不对 require 时就拒绝（未知层、层集合增减、重复、理由多行或没写节号、缺字段、合同不对）', () => {
  const cases = [
    ['RESEARCH_LAYER_UNKNOWN', (doc) => { doc.entries[0].layer = 'TIMING'; }],
    ['RESEARCH_LAYER_SET', (doc) => { delete doc.layers.UNDECIDED; }],
    ['RESEARCH_LAYER_SET', (doc) => { doc.layers.EXECUTION = { label_zh: '执行' }; }],
    ['RESEARCH_LAYER_DUPLICATE', (doc) => { doc.entries.push({ ...doc.entries[0] }); }],
    ['RESEARCH_LAYER_FIELD', (doc) => { doc.entries[0].reason_zh = '第一行\n第二行 §1'; }],
    ['RESEARCH_LAYER_FIELD', (doc) => { doc.entries[0].reason_zh = '没有写合同节号'; }],
    ['RESEARCH_LAYER_FIELD', (doc) => { delete doc.entries[0].classified_by; }],
    ['RESEARCH_LAYER_FIELD', (doc) => { doc.contract_ref.sha256 = '0'.repeat(64); }],
    ['RESEARCH_LAYER_CONTRACT_INVALID', (doc) => { doc.contract = 'OTHER'; }],
    ['RESEARCH_LAYER_FIELD', (doc) => { doc.contract_ref.notes = doc.contract_ref.notes.filter((note) => note.id !== 'NOTE_2'); }],
    ['RESEARCH_LAYER_FIELD', (doc) => { doc.contract_ref.notes[1].sha256 = 'f'.repeat(64); }],
    ['RESEARCH_LAYER_FIELD', (doc) => { doc.entries[0].deviations = [{ ref: 'X11', label_zh: '不符', note_zh: '说明' }]; }],
    ['RESEARCH_LAYER_FIELD', (doc) => { doc.entries[0].deviations = [{ ref: 'D11', label_zh: '不符' }]; }],
  ];
  for (const [code, mutate] of cases) {
    const doc = copy();
    mutate(doc);
    assert.throws(() => layers.validate(doc), (error) => error.code === code, code);
  }
});

test('层登记：没登记的题返回占位「待交付 · 层登记」；计数同一题只算一次，计数行按 三层 · 四个标签 · 待定 的顺序', () => {
  assert.deepEqual(layers.layerOf('US_V5_ETF_3000USD', 'Q99'), { code: null, label_zh: '待交付 · 层登记', registered: false });
  assert.deepEqual(layers.layerOf(null, 'Q1'), { code: null, label_zh: '待交付 · 层登记', registered: false });
  assert.equal(layers.layerOf('US_V5_ETF_3000USD', 'Q1').code, 'SELECTION_TIMING');
  assert.equal(layers.layerOf('ASHARE_V6_PAPER', 'R-STK-1').code, 'SELECTION_TIMING');
  assert.match(layers.layerOf('ASHARE_V6_PAPER', 'R-STK-1').reason_zh, /风控层/);
  assert.equal(layers.layerOf('ASHARE_V6_PAPER', 'Q0').code, 'DIAGNOSTIC_BASELINE');
  assert.equal(layers.layerOf('US_V5_ETF_3000USD', 'Q1').deviations, undefined, '没有不符项的题不加 deviations');
  assert.deepEqual(layers.layerOf('C17_V2_4000USDT', 'R1').deviations.map((item) => item.ref), ['D11']);
  const items = [
    { strategy_ref: 'A', id: 'Q1', layer: layers.layerOf('US_V5_ETF_3000USD', 'Q1') },
    { strategy_ref: 'A', id: 'Q1', layer: layers.layerOf('US_V5_ETF_3000USD', 'Q1') },
    { strategy_ref: 'A', id: 'Q0', layer: layers.layerOf('US_V5_ETF_3000USD', 'Q0') },
    { strategy_ref: 'A', id: 'Q99', layer: layers.layerOf('US_V5_ETF_3000USD', 'Q99') },
  ];
  const counts = layers.countsOf(items);
  assert.deepEqual(counts, { total: 3, SELECTION_TIMING: 1, RISK: 0, ACCOUNT: 0, DIAGNOSTIC_BASELINE: 1, DIAGNOSTIC: 0, NA_ENGINEERING: 0, NA_EXECUTION: 0, UNDECIDED: 0, PENDING: 1 });
  const all = '选股择时 1 · 风控 0 · 账户 0 · 诊断（全策略基线） 1 · 诊断 0 · 不适用（工程） 0 · 不适用（执行） 0 · 待定 0';
  assert.equal(layers.countsLine(counts), `研究按层（共 3 题，含详情页）：${all} · 待交付层登记 1`);
  assert.equal(layers.countsLine({ ...counts, total: 2, PENDING: 0 }), `研究按层（共 2 题，含详情页）：${all}`);
});

test('策略总览：每个研究题都带层（登记或占位）；计数行在顶部一句下面，与研究题清单一致', async () => {
  const model = await workspace.readModel();
  const view = model.views.strategies;
  const overview = view.overview;
  const rows = overviewItems(overview);
  assert.ok(rows.length >= 4, '至少有 A 股的 R-ETF-1、R-ETF-2、R-STK-1、Q0');
  for (const [where, layer] of rows) assertLayer(layer, where);
  for (const item of overview.research_items) assertLayer(item.layer, `${item.strategy_ref}/${item.id}`);
  // A 股四题都已登记
  const ashare = Object.fromEntries(overview.research_items.filter((item) => item.strategy_ref === 'ASHARE_V6_PAPER').map((item) => [item.id, item.layer.code]));
  assert.deepEqual(ashare, { Q0: 'DIAGNOSTIC_BASELINE', 'R-ETF-1': 'SELECTION_TIMING', 'R-ETF-2': 'SELECTION_TIMING', 'R-STK-1': 'SELECTION_TIMING' });
  // 计数来自同一份清单
  assert.deepEqual(overview.layer_counts, layers.countsOf(overview.research_items));
  const sum = layers.LAYER_CODES.reduce((total, code) => total + overview.layer_counts[code], overview.layer_counts.PENDING);
  assert.equal(sum, overview.layer_counts.total);
  assert.equal(overview.layer_counts.total, overview.research_items.length);
  assert.equal(view.layer_line_zh, layers.countsLine(overview.layer_counts));
  assert.match(view.layer_line_zh, /^研究按层（共 \d+ 题，含详情页）：选股择时 \d+ · 风控 \d+ · 账户 \d+ · 诊断（全策略基线） \d+ · 诊断 \d+ · 不适用（工程） \d+ · 不适用（执行） \d+ · 待定 \d+/);
});

test('策略总览：登记里缺的题写「待交付 · 层登记」，不猜；计数行多一项「待交付层登记」', async () => {
  const model = await workspace.readModel();
  const doc = copy();
  doc.entries = doc.entries.filter((entry) => !(entry.strategy_ref === 'ASHARE_V6_PAPER' && entry.id === 'R-ETF-2'));
  const register = layers.validate(doc);
  const overview = overviewService.buildOverview(model.strategy_directory, {
    layerOf: (strategyRef, id) => layers.layerOf(strategyRef, id, register),
    extraItems: new Map([['US_V5_ETF_3000USD', [{ id: 'NOT-IN-REGISTER', title_zh: '没有登记的详情页题' }]]]),
  });
  const etf = overview.parents.find((item) => item.strategy_ref === 'ASHARE_V6_PAPER').modules.find((item) => item.module_id === 'CN_A_BROAD_ETF');
  const open = etf.research.in_progress.find((item) => item.id === 'R-ETF-2');
  assert.deepEqual(open.layer, { code: null, label_zh: '待交付 · 层登记', registered: false });
  const extra = overview.research_items.find((item) => item.id === 'NOT-IN-REGISTER');
  assert.equal(extra.where, 'DETAIL');
  assert.equal(extra.layer.label_zh, '待交付 · 层登记');
  assert.equal(overview.layer_counts.PENDING, 2);
  assert.match(overview.layer_line_zh, / · 待交付层登记 2$/);
  for (const [where, layer] of overviewItems(overview)) assertLayer(layer, where);
});

test('页面：每个研究题旁有层标签，计数行在顶部一句下面；占位照写，页面不另判', async () => {
  const model = await workspace.readModel();
  const html = await render(model);
  assert.ok(html.includes(`<p class="layer-line">${model.views.strategies.layer_line_zh}</p>`), '计数行应在答句下面');
  assert.ok(html.indexOf('class="layer-line"') > html.indexOf('class="answer"'));
  const chips = html.match(/<span class="layer-chip" data-layer="[A-Z_]+"[^>]*>[^<]+<\/span>/g) || [];
  const shown = model.views.strategies.overview.research_items.filter((item) => item.where === 'OVERVIEW');
  assert.ok(chips.length >= shown.length, `层标签 ${chips.length} 个，少于总览上的 ${shown.length} 个研究题`);
  // 美股、加密卡片：研究题清单逐题一行，题号旁是层标签
  for (const card of model.views.strategies.overview.cards.filter((item) => item.kind === 'STRATEGY')) {
    for (const item of card.research.items) {
      assert.ok(html.includes(`<li data-item="${item.id}"><span class="layer-chip" data-layer="${item.layer.code || 'PENDING'}"`), `${card.strategy_ref}/${item.id} 旁没有层标签`);
    }
  }
  for (const chip of chips) {
    const [, code, label] = /data-layer="([A-Z_]+)"[^>]*>([^<]+)</.exec(chip);
    assert.equal(label, code === 'PENDING' ? '待交付 · 层登记' : RAW.layers[code].label_zh);
  }
  // A 股研究线「R-STK-1 · 趋势跟踪」旁是选股择时，鼠标悬停看理由
  assert.match(html, /<span class="layer-chip" data-layer="SELECTION_TIMING" title="[^"]*修订 1[^"]*">选股择时<\/span> R-STK-1 · /);
  // 占位：把一题的层换成占位，页面照写
  const pendingModel = JSON.parse(JSON.stringify(model));
  const etf = pendingModel.views.strategies.overview.parents.find((item) => item.strategy_ref === 'ASHARE_V6_PAPER').modules[0];
  etf.research.in_progress[0].layer = { code: null, label_zh: '待交付 · 层登记', registered: false };
  for (const section of pendingModel.views.strategies.overview.sections) {
    for (const card of section.cards) if (card.module_ref === etf.module_ref) card.research.in_progress[0].layer = etf.research.in_progress[0].layer;
  }
  // 不符项：层标签旁一条小注，全文在悬停提示里
  etf.research.in_progress[0].layer = layers.layerOf('C17_V2_4000USDT', 'R1');
  for (const section of pendingModel.views.strategies.overview.sections) {
    for (const card of section.cards) if (card.module_ref === etf.module_ref) card.research.in_progress[0].layer = etf.research.in_progress[0].layer;
  }
  const flagged = await render(pendingModel);
  assert.match(flagged, /<span class="layer-chip" data-layer="SELECTION_TIMING"[^>]*>选股择时<\/span> <small class="layer-flag" data-deviation="D11" title="[^"]*只调 k[^"]*">D11 不符：市场结构定方向<\/small>/);
  const placeholder = JSON.parse(JSON.stringify(model));
  const etf2 = placeholder.views.strategies.overview.parents.find((item) => item.strategy_ref === 'ASHARE_V6_PAPER').modules[0];
  for (const section of placeholder.views.strategies.overview.sections) {
    for (const card of section.cards) if (card.module_ref === etf2.module_ref) card.research.in_progress[0].layer = { code: null, label_zh: '待交付 · 层登记', registered: false };
  }
  assert.match(await render(placeholder), /<span class="layer-chip" data-layer="PENDING">待交付 · 层登记<\/span>/);
});

test('详情页：方案对比卡带层，登记里没有的题号写占位（层由读模型给）', async () => {
  const comparison = [
    { state: 'INVALID', question_ref: 'Q1', reason: '测试', result_id: null },
    { state: 'INVALID', question_ref: 'Q99', reason: '测试', result_id: null },
  ];
  const model = await workspace.readModel({ strategyRef: 'US_V5_ETF_3000USD', comparison });
  const cards = model.views['strategy-detail'].comparisons;
  assert.equal(cards.find((card) => card.question_ref === 'Q1').layer.code, 'SELECTION_TIMING');
  assert.deepEqual(cards.find((card) => card.question_ref === 'Q99').layer, { code: null, label_zh: '待交付 · 层登记', registered: false });
  // 研究队列小表各行不动，层另列在 layer_items（题号 + 层），页面写在表格下面
  const queue = model.views['strategy-detail'].research_queue;
  assert.deepEqual(queue.layer_items.map((item) => item.id), queue.rows.map((row) => row.question_ref));
  for (const item of queue.layer_items) assertLayer(item.layer, `US_V5_ETF_3000USD/${item.id}（研究队列）`);
  assert.ok(queue.rows.every((row) => !('layer' in row)), '表格行逐字不变');
  const html = await render(model, '#strategy-detail?strategy=US_V5_ETF_3000USD&section=research');
  assert.match(html, /<p class="layer-row">研究题的层：<span class="layer-pair" data-item="Q1"><strong>Q1<\/strong> <span class="layer-chip" data-layer="SELECTION_TIMING"/);
  const empty = await workspace.readModel({ strategyRef: 'ASHARE_V6_PAPER' });
  for (const card of empty.views['strategy-detail'].comparisons) assert.equal(card.layer, undefined, '没有接上的空对比不是研究题，不带层');
});
