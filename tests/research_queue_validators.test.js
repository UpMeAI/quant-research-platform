'use strict';
/**
 * AUTONOMOUS_RESEARCH_QUEUE_V1（rev 4，sha 52418471）Q2：核对报告 / 卡 / FACTOR_IDEA 的验证器与路由（AQ-12、AQ-23、AQ-36、AQ-44、AQ-45、AQ-46）。
 * 先红后绿；全部用假数据，不连模型、不读密钥。验收在实现之前写定，不为通过而放宽：
 *   AQ-12  §5.6 的每条规则都有一个失败夹具：非 JSON / 多余键 / req_id 缺失或重复 / 未知或无引用 / CONSISTENT 带 GAP / HOLD 无理由 /
 *          数字不在被引用的事实里 / 预测词表（中英）/ 结论与建议词表；
 *   AQ-23  事实包、卡、提案、候选包拒绝挖掘 out/ 与 MINING_SELECTION_V1 / MINING_GATE_RECORD_V1 / 金库事件 / 赛马与纸面结果；核对报告不能当输入；
 *   AQ-36  市场 → 代理主机：CN_A 只在 Linux，US_EQUITY / CRYPTO 只在 HK（含在 Linux 上跑的 US / 加密任务）；
 *   AQ-44  核对与预注册的提示词准入不同；核对包带作者行，作者 = 核对者则拒；
 *   AQ-45  FACTOR_IDEA：公式或算子记号 / 未登记读数或机制 / 事实 id 少于 2 / 方向词 / 每市场每周超过 5 条 / 防火墙来源 / 0 条且无引用理由，逐条一个失败夹具；
 *   AQ-46  想法 → 生成方视野：stub 登记表合并后机制 id 出现在 stub 轮次清单 ideas_in_view[]（带出处 sha）；来源含禁用来源的想法进不去。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./_rq_agent_fixture');
const V = require('../services/research-queue-agent');

const codes = (r) => r.errors.map((e) => e.code);
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---------------------------------------------------------------- 词表 */
test('lexicon: every prediction term and every verdict term is found, ordinary wording is not', () => {
  const pred = ['会涨', '会跌', '上涨概率', '目标价', '预计', '看多', '看空', 'will rise', 'we expect', 'probability of', 'target price', 'forecast', 'outperform'];
  for (const t of pred) assert.ok(V.lexicon.findWording(`本周 ${t} 一些`).some((w) => w.list === 'PREDICTION'), t);
  const verdict = ['不做', '结论：做', '建议上线', '应当采用', '买入', '卖出', '加仓', '减仓', 'we adopt this', 'should adopt'];
  for (const t of verdict) assert.ok(V.lexicon.findWording(`说明 ${t} 一些`).some((w) => w.list === 'VERDICT'), t);
  const direction = ['做多', '做空', '看涨', '看跌', 'bullish', 'bearish', 'go long', 'going short'];
  for (const t of direction) assert.ok(V.lexicon.findWording(`说明 ${t} 一些`, ['DIRECTION']).some((w) => w.list === 'DIRECTION'), t);
  assert.deepEqual(V.lexicon.findWording('做多', ['PREDICTION', 'VERDICT']), [], 'direction words are a separate list, applied to ideas and questions only');
  for (const ok of ['本周有 3 次入场偏晚', '做过这次核对', '样本不足', 'the adopted template id is listed', '命中率为 41.5']) {
    assert.deepEqual(V.lexicon.findWording(ok), [], ok);
  }
});

/* ---------------------------------------------------------------- AQ-12 核对报告 */
test('AQ-12 check report: a good report passes', () => {
  const r = V.validateCheckReport(JSON.stringify(F.makeCheckReport()), F.makePack());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

const CHECK_FIXTURES = [
  ['CHECK_NOT_JSON', () => '{not json', null],
  ['CHECK_NOT_JSON', () => '[1]', null],
  ['CHECK_KEYS', (r) => ({ ...r, extra: 1 })],
  ['CHECK_KEYS', (r) => { const x = clone(r); delete x.unknowns; return x; }],
  ['CHECK_VERDICT_INVALID', (r) => ({ ...r, verdict: 'PASS' })],
  ['CHECK_ITEM_KEYS', (r) => { const x = clone(r); x.items[0].extra = 1; return x; }],
  ['CHECK_ITEM_STATUS_INVALID', (r) => { const x = clone(r); x.items[0].status = 'OK'; return x; }],
  ['CHECK_REQ_MISSING', (r) => { const x = clone(r); x.items.pop(); return x; }],
  ['CHECK_REQ_DUPLICATE', (r) => { const x = clone(r); x.items[1].req_id = 'R1'; return x; }],
  ['CHECK_REQ_UNKNOWN', (r) => { const x = clone(r); x.items[1].req_id = 'R9'; return x; }],
  ['CHECK_FACT_UNKNOWN', (r) => { const x = clone(r); x.items[0].fact_ids = ['F-999']; return x; }],
  ['CHECK_ITEM_UNCITED', (r) => { const x = clone(r); x.items[0].fact_ids = []; return x; }],
  ['CHECK_CONSISTENT_WITH_GAP', (r) => { const x = clone(r); x.items[0].status = 'GAP'; x.items[0].fact_ids = []; return x; }],
  ['CHECK_CONSISTENT_WITH_GAP', (r) => { const x = clone(r); x.items[0].status = 'CONTRADICTION'; return x; }],
  ['CHECK_HOLD_WITHOUT_REASONS', (r) => ({ ...r, verdict: 'HOLD' })],
  ['CHECK_CONSISTENT_WITH_HOLD_REASONS', (r) => ({ ...r, hold_reasons: [{ code: 'HOLD_MISSING_EVIDENCE', req_id: 'R1', fact_ids: [], remediation_zh: '补充记录' }] })],
  ['CHECK_HOLD_REASON_INVALID', (r) => ({ ...r, verdict: 'HOLD', hold_reasons: [{ code: 'HOLD_OTHER', req_id: 'R1', fact_ids: ['F-001'], remediation_zh: '补充' }] })],
  ['CHECK_HOLD_REASON_INVALID', (r) => ({ ...r, verdict: 'HOLD', hold_reasons: [{ code: 'HOLD_CONTRADICTION', req_id: 'R7', fact_ids: ['F-001'], remediation_zh: '补充' }] })],
  ['CHECK_FACT_UNKNOWN', (r) => ({ ...r, verdict: 'HOLD', hold_reasons: [{ code: 'HOLD_CONTRADICTION', req_id: 'R1', fact_ids: ['F-404'], remediation_zh: '补充' }] })],
  ['CHECK_HOLD_REASON_UNCITED', (r) => ({ ...r, verdict: 'HOLD', hold_reasons: [{ code: 'HOLD_CONTRADICTION', req_id: 'R1', fact_ids: [], remediation_zh: '补充' }] })],
  ['CHECK_NUMBER_NOT_IN_FACT', (r) => { const x = clone(r); x.items[0].note_zh = '窗口 61 日'; return x; }],
  ['CHECK_NUMBER_NOT_IN_FACT', (r) => ({ ...r, unknowns: ['缺 7 项'] })],
  ['CHECK_PREDICTION_WORDING', (r) => { const x = clone(r); x.items[0].note_zh = '下周会涨'; return x; }],
  ['CHECK_VERDICT_WORDING', (r) => { const x = clone(r); x.items[0].note_zh = '建议上线'; return x; }],
];
for (const [code, mut, raw] of CHECK_FIXTURES) {
  test(`AQ-12 check report rejects: ${code} (${String(mut).slice(0, 60).replace(/\s+/g, ' ')})`, () => {
    const input = raw === null ? mut() : JSON.stringify(mut(F.makeCheckReport()));
    const r = V.validateCheckReport(input, F.makePack());
    assert.equal(r.ok, false);
    assert.ok(codes(r).includes(code), `${code} not in ${codes(r)}`);
  });
}

test('AQ-12 check report: a HOLD with a cited reason is valid; GAP may be uncited; a numeric token that sits in a cited fact is fine', () => {
  const r = F.makeCheckReport({
    verdict: 'HOLD',
    items: [{ req_id: 'R1', status: 'GAP', fact_ids: [], note_zh: '没有对应记录' }, { req_id: 'R2', status: 'COVERED', fact_ids: ['F-002'], note_zh: '样本 87 已报告' }],
    hold_reasons: [{ code: 'HOLD_MISSING_EVIDENCE', req_id: 'R1', fact_ids: [], remediation_zh: '补充窗口记录' }],
  });
  const out = V.validateCheckReport(JSON.stringify(r), F.makePack());
  assert.deepEqual(out.errors, []);
});

test('AQ-12 numbers: fact ids and req ids in the text are not numeric claims; numerically equal forms match', () => {
  const x = F.makeCheckReport();
  x.items[0].note_zh = '见 F-001，R1 的窗口为 60.0 日';
  assert.equal(V.validateCheckReport(JSON.stringify(x), F.makePack()).ok, true);
  x.items[0].note_zh = '命中率 41.50%';
  x.items[0].fact_ids = ['F-002'];
  assert.equal(V.validateCheckReport(JSON.stringify(x), F.makePack()).ok, true);
});

/* ---------------------------------------------------------------- AQ-12 卡 */
test('AQ-12 card: a good card passes and yields one idea record draft', () => {
  const r = V.validateCard(JSON.stringify(F.makeCard()), F.ctx());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.card.factor_ideas.length, 1);
});

const CARD_FIXTURES = [
  ['CARD_NOT_JSON', () => 'oops', null],
  ['CARD_KEYS', (c) => ({ ...c, extra: 1 })],
  ['CARD_MARKET_MISMATCH', (c) => ({ ...c, market: 'US_EQUITY' })],
  ['CARD_WEEK_MISMATCH', (c) => ({ ...c, week_id: '2026-W46' })],
  ['CARD_ITEM_KEYS', (c) => { const x = clone(c); x.supporting[0].extra = 1; return x; }],
  ['CARD_ITEM_UNCITED', (c) => { const x = clone(c); x.supporting[0].fact_ids = []; return x; }],
  ['CARD_FACT_UNKNOWN', (c) => { const x = clone(c); x.opposing[0].fact_ids = ['F-777']; return x; }],
  ['CARD_NUMBER_NOT_IN_FACT', (c) => { const x = clone(c); x.supporting[0].text_zh = '本周共 13 次信号'; return x; }],
  ['CARD_PREDICTION_WORDING', (c) => { const x = clone(c); x.supporting[0].text_zh = '后市看多'; return x; }],
  ['CARD_VERDICT_WORDING', (c) => { const x = clone(c); x.opposing[0].text_zh = '应当采用'; return x; }],
  ['CARD_PATTERN_COUNT_MISMATCH', (c) => { const x = clone(c); x.repeated_patterns[0].count = 4; return x; }],
  ['CARD_PATTERN_UNKNOWN', (c) => { const x = clone(c); x.repeated_patterns[0].pattern_key = 'NOPE'; return x; }],
  ['CARD_ZERO_IDEAS_NO_REASON', (c) => ({ ...c, factor_ideas: [] })],
  ['CARD_REASON_WITH_IDEAS', (c) => ({ ...c, no_idea_reason: { text_zh: '无', fact_ids: ['F-001'] } })],
  ['CARD_NO_IDEA_REASON_UNCITED', (c) => ({ ...c, factor_ideas: [], no_idea_reason: { text_zh: '本周没有触及选股或择时的发现', fact_ids: [] } })],
  ['CARD_QUESTIONS_TOO_MANY', (c) => ({ ...c, question_proposals: [0, 1, 2].map(() => ({ mechanism_id: 'NEW', layer: 'RISK', decision_point: 'SIZING', market: 'CN_A', question_zh: '仓位上限是否过紧？', fact_ids: ['F-001'] })) })],
  ['CARD_QUESTION_INVALID', (c) => ({ ...c, question_proposals: [{ mechanism_id: 'SEL.NOPE.X', layer: 'RISK', decision_point: 'SIZING', market: 'CN_A', question_zh: '仓位上限是否过紧？', fact_ids: ['F-001'] }] })],
  ['CARD_QUESTION_INVALID', (c) => ({ ...c, question_proposals: [{ mechanism_id: 'NEW', layer: 'RISK', decision_point: 'SIZING', market: 'CN_A', question_zh: '仓位上限应当收紧', fact_ids: ['F-001'] }] })],
  ['CARD_QUESTION_INVALID', (c) => ({ ...c, question_proposals: [{ mechanism_id: 'NEW', layer: 'RISK', decision_point: 'SIZING', market: 'US_EQUITY', question_zh: '仓位上限是否过紧？', fact_ids: ['F-001'] }] })],
];
for (const [code, mut, raw] of CARD_FIXTURES) {
  test(`AQ-12 card rejects: ${code} (${String(mut).slice(0, 70).replace(/\s+/g, ' ')})`, () => {
    const input = raw === null ? mut() : JSON.stringify(mut(F.makeCard()));
    const r = V.validateCard(input, F.ctx());
    assert.equal(r.ok, false);
    assert.ok(codes(r).includes(code), `${code} not in ${codes(r)}`);
  });
}

test('card: zero ideas with a cited reason is allowed; two non-factor questions are allowed', () => {
  const c = F.makeCard({
    factor_ideas: [], no_idea_reason: { text_zh: '本周没有触及选股或择时的发现', fact_ids: ['F-001'] },
    question_proposals: [{ mechanism_id: 'RISK.TOTAL.BUDGET', layer: 'RISK', decision_point: 'SIZING', market: 'CN_A', question_zh: '总风险线是否在回撤后恢复得过慢？', fact_ids: ['F-003'] }],
  });
  const r = V.validateCard(JSON.stringify(c), F.ctx());
  assert.deepEqual(r.errors, []);
});

/* ---------------------------------------------------------------- AQ-45 FACTOR_IDEA */
const IDEA_FIXTURES = [
  ['FACTOR_IDEA_KEYS', (i) => ({ ...i, formula: 'x' })],
  ['FACTOR_IDEA_KEYS', (i) => { const x = clone(i); delete x.question_zh; return x; }],
  // 公式或算子记号
  ['FACTOR_IDEA_FORMULA_TOKEN', (i) => ({ ...i, question_zh: 'rank(RS60) 靠前的是否更好？' })],
  ['FACTOR_IDEA_FORMULA_TOKEN', (i) => ({ ...i, question_zh: 'ts_mean 之后的 RS60 是否更稳？' })],
  ['FACTOR_IDEA_FORMULA_TOKEN', (i) => ({ ...i, question_zh: 'zscore 处理后是否更好？' })],
  ['FACTOR_IDEA_FORMULA_TOKEN', (i) => ({ ...i, question_zh: 'sma(RS60) 之后是否更稳？' })],
  ['FACTOR_IDEA_FORMULA_TOKEN', (i) => ({ ...i, expected_failure_zh: 'neutralize_industry 之后失效' })],
  ['FACTOR_IDEA_FORMULA_TOKEN', (i) => ({ ...i, question_zh: 'RS60 + VOL20 是否优于单独读数？' })],
  ['FACTOR_IDEA_FORMULA_TOKEN', (i) => ({ ...i, question_zh: 'RS60 / VOL20 是否更稳？' })],
  ['FACTOR_IDEA_FORMULA_TOKEN', (i) => ({ ...i, question_zh: 'RS60 > VOL20 时是否更好？' })],
  ['FACTOR_IDEA_NUMERIC_PARAM', (i) => ({ ...i, question_zh: '权重 0.5 的组合是否更稳？' })],
  ['FACTOR_IDEA_NUMERIC_PARAM', (i) => ({ ...i, expected_failure_zh: '阈值取 20 日以上时失效' })],
  // 未登记
  ['FACTOR_IDEA_READING_UNREGISTERED', (i) => ({ ...i, readings: ['RS60', 'NOT_A_READING'] })],
  ['FACTOR_IDEA_READING_UNREGISTERED', (i) => ({ ...i, readings: [] })],
  ['FACTOR_IDEA_READING_UNREGISTERED', (i) => ({ ...i, readings: ['RS60 + VOL20'] })],
  ['FACTOR_IDEA_MECHANISM_UNREGISTERED', (i) => ({ ...i, mechanism: 'SEL.NOPE.X' })],
  ['FACTOR_IDEA_MECHANISM_UNREGISTERED', (i) => ({ ...i, mechanism: 'RISK.TOTAL.BUDGET' })],
  ['FACTOR_IDEA_MECHANISM_NEW_INVALID', (i) => ({ ...i, mechanism: { NEW: { proposed_id: 'RISK.NEW.X', title_zh: '新机制', description_zh: '一句泛化描述', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } } })],
  ['FACTOR_IDEA_MECHANISM_NEW_INVALID', (i) => ({ ...i, mechanism: { NEW: { proposed_id: 'SEL.NEW.X', title_zh: '新机制', description_zh: '一句泛化描述', layer: 'RISK', decision_point: 'SELECT' } } })],
  ['FACTOR_IDEA_MECHANISM_NEW_INVALID', (i) => ({ ...i, mechanism: { NEW: { proposed_id: 'SEL.NEW.X', title_zh: '新机制', description_zh: '一句泛化描述', layer: 'SELECTION_TIMING', decision_point: 'SIZING' } } })],
  ['FACTOR_IDEA_MECHANISM_NEW_INVALID', (i) => ({ ...i, mechanism: { NEW: { proposed_id: 'SEL.XSEC.REVERSAL', title_zh: '新机制', description_zh: '一句泛化描述', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } } })],
  ['FACTOR_IDEA_MECHANISM_NEW_INVALID', (i) => ({ ...i, mechanism: { NEW: { proposed_id: 'SEL.NEW.X', title_zh: '新机制', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } } })],
  ['FACTOR_IDEA_MECHANISM_NEW_INVALID', (i) => ({ ...i, mechanism: { NEW: { proposed_id: 'SEL.NEW.X', title_zh: '新机制', description_zh: '一句泛化描述', layer: 'SELECTION_TIMING', decision_point: 'SELECT', formula: 'x' } } })],
  ['FACTOR_IDEA_NUMERIC_PARAM', (i) => ({ ...i, mechanism: { NEW: { proposed_id: 'SEL.NEW.X', title_zh: '新机制', description_zh: '阈值取 20 日', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } } })],
  ['FACTOR_IDEA_HOLDING_PERIOD_UNREGISTERED', (i) => ({ ...i, holding_periods: [7] })],
  ['FACTOR_IDEA_HOLDING_PERIOD_UNREGISTERED', (i) => ({ ...i, holding_periods: [] })],
  // 事实 id
  ['FACTOR_IDEA_FACTS_MIN', (i) => ({ ...i, fact_ids: ['F-002'] })],
  ['FACTOR_IDEA_FACTS_MIN', (i) => ({ ...i, fact_ids: ['F-002', 'F-002'] })],
  ['FACTOR_IDEA_FACT_UNKNOWN', (i) => ({ ...i, fact_ids: ['F-002', 'F-909'] })],
  // 词表
  ['FACTOR_IDEA_PREDICTION_WORDING', (i) => ({ ...i, question_zh: '放量后是否会涨？下周预计上行' })],
  ['FACTOR_IDEA_VERDICT_WORDING', (i) => ({ ...i, expected_failure_zh: '建议上线，不做的情形除外' })],
  ['FACTOR_IDEA_DIRECTION_WORDING', (i) => ({ ...i, question_zh: '弱势后是否应当做多？' })],
  ['FACTOR_IDEA_DIRECTION_WORDING', (i) => ({ ...i, question_zh: 'is the bullish case stronger?' })],
  ['FACTOR_IDEA_QUESTION_NOT_INTERROGATIVE', (i) => ({ ...i, question_zh: '弱势后的反弹在放量日之后更常见' })],
];
for (const [code, mut] of IDEA_FIXTURES) {
  test(`AQ-45 factor idea rejects: ${code} (${String(mut).slice(0, 80).replace(/\s+/g, ' ')})`, () => {
    const r = V.validateIdeaDraft(mut(F.goodIdea()), F.ctx());
    assert.equal(r.ok, false);
    assert.ok(codes(r).includes(code), `${code} not in ${codes(r)}`);
  });
}

test('AQ-45 factor idea: a good draft passes; NEW mechanism passes; factor library readings pass', () => {
  assert.deepEqual(V.validateIdeaDraft(F.goodIdea(), F.ctx()).errors, []);
  const nu = F.goodIdea({ mechanism: { NEW: { proposed_id: 'SEL.LIQUIDITY.AMIHUD_TILT', title_zh: '流动性冲击后的选股倾向', description_zh: '成交额骤降后的个股，其后续相对表现是否与流动性恢复有关', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } } });
  assert.deepEqual(V.validateIdeaDraft(nu, F.ctx()).errors, []);
  const lib = F.goodIdea({ readings: ['CN_A.MOM.RS60_MARKET_PCT', 'CN_A.VOL.REALIZED_20'] });
  assert.deepEqual(V.validateIdeaDraft(lib, F.ctx()).errors, []);
});

test('AQ-45 factor idea: more than 5 per market per week is refused (card level and with ideas already recorded)', () => {
  const six = F.makeCard({ factor_ideas: Array.from({ length: 6 }, () => F.goodIdea()) });
  const r = V.validateCard(JSON.stringify(six), F.ctx());
  assert.ok(codes(r).includes('FACTOR_IDEA_TOO_MANY'));
  const five = F.makeCard({ factor_ideas: Array.from({ length: 5 }, () => F.goodIdea()) });
  assert.equal(V.validateCard(JSON.stringify(five), F.ctx()).ok, true);
  const again = V.validateCard(JSON.stringify(F.makeCard({ factor_ideas: [F.goodIdea(), F.goodIdea()] })), F.ctx({ existing_idea_count: 4 }));
  assert.ok(codes(again).includes('FACTOR_IDEA_TOO_MANY'));
});

test('AQ-45 factor idea: a cited fact from behind the provenance firewall is refused', () => {
  const pack = F.makePack();
  pack.facts[2].source.path = 'qrp/var/mining/out/round-7/selection.json';
  const r = V.validateIdeaDraft(F.goodIdea(), F.ctx({ pack }));
  assert.ok(codes(r).includes('FACTOR_IDEA_FIREWALL_SOURCE'));
  const pack2 = F.makePack();
  pack2.facts[2].source.record_type = 'MINING_GATE_RECORD_V1';
  assert.ok(codes(V.validateIdeaDraft(F.goodIdea(), F.ctx({ pack: pack2 }))).includes('FACTOR_IDEA_FIREWALL_SOURCE'));
});

test('AQ-45 factor idea records: code fills ids, hashes, PIT copied from the registry; a record whose PIT text was edited is refused', () => {
  const card = F.makeCard();
  const built = V.buildIdeaRecords(card, F.ctx(), { card_sha256: F.sha('card'), prompt_admission_sha256: F.sha('adm'), model: 'deepseek-flash' });
  assert.equal(built.length, 1);
  const rec = built[0];
  assert.equal(rec.idea_id, 'FI-CN_A-2026-W47-1');
  assert.equal(rec.card_sha256, F.sha('card'));
  assert.match(rec.fact_pack_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(rec.readings, [{ id: 'RS60', pit_available_at: 'T 日收盘后' }, { id: 'VOL20', pit_available_at: 'T 日收盘后' }]);
  assert.equal(rec.schema, 'FACTOR_IDEA_V1');
  assert.deepEqual(V.validateIdeaRecord(rec, F.ctx()).errors, []);
  const bad = clone(rec);
  bad.readings[0].pit_available_at = 'T-1 盘前';
  assert.ok(codes(V.validateIdeaRecord(bad, F.ctx())).includes('FACTOR_IDEA_PIT_MISMATCH'));
  const bad2 = clone(rec);
  bad2.idea_id = 'FI-US_EQUITY-2026-W47-1';
  assert.ok(codes(V.validateIdeaRecord(bad2, F.ctx())).includes('FACTOR_IDEA_ID_INVALID'));
  const bad3 = clone(rec);
  bad3.model = '';
  assert.ok(codes(V.validateIdeaRecord(bad3, F.ctx())).includes('FACTOR_IDEA_KEYS'));
});

test('record: a changed fact pack sha, or an extra key, is refused', () => {
  const rec = V.buildIdeaRecords(F.makeCard(), F.ctx(), { card_sha256: F.sha('c'), prompt_admission_sha256: F.sha('a'), model: 'deepseek-flash' })[0];
  assert.ok(codes(V.validateIdeaRecord({ ...rec, fact_pack_sha256: F.sha('other') }, F.ctx())).includes('FACTOR_IDEA_PACK_SHA_MISMATCH'));
  assert.deepEqual(codes(V.validateIdeaRecord({ ...rec, formula: 'rank(x)' }, F.ctx())), ['FACTOR_IDEA_KEYS']);
});

test('card: an invalid idea inside a card makes the card invalid (the card runs the idea validator)', () => {
  const c = F.makeCard({ factor_ideas: [F.goodIdea({ question_zh: 'rank(RS60) 靠前的是否更好？' })] });
  assert.ok(codes(V.validateCard(JSON.stringify(c), F.ctx())).includes('FACTOR_IDEA_FORMULA_TOKEN'));
});

test('AQ-45 idea carries no formula, direction, or numbers: the record has no free numeric or operator field', () => {
  const rec = V.buildIdeaRecords(F.makeCard(), F.ctx(), { card_sha256: F.sha('c'), prompt_admission_sha256: F.sha('a'), model: 'deepseek-flash' })[0];
  assert.deepEqual(Object.keys(rec).sort(), ['card_sha256', 'expected_failure_zh', 'fact_ids', 'fact_pack_sha256', 'holding_periods', 'idea_id', 'market',
    'mechanism', 'model', 'prompt_admission_sha256', 'question_zh', 'readings', 'schema', 'week_id']);
});

/* ---------------------------------------------------------------- AQ-23 防火墙 */
test('AQ-23 provenance firewall: forbidden sources and record types are refused in fact packs, cards, proposals and bundles', () => {
  const bad = [
    { path: 'qrp/var/mining/out/r1/x.json' }, { path: 'var/mining/out/r2/y.json' }, { path: 'x/MINING_SELECTION_V1.json' },
    { path: 'a/b.json', record_type: 'MINING_SELECTION_V1' }, { path: 'a/b.json', record_type: 'MINING_GATE_RECORD_V1' },
    { path: 'a/b.json', record_type: 'VAULT_EVENT_V1' }, { path: 'vault/events/e1.json' }, { path: 'race/results/r.json' }, { path: 'paper/results/p.json' },
    { path: 'a/b.json', record_type: 'RACE_RESULT_V1' }, { path: 'a/b.json', record_type: 'PAPER_RESULT_V1' },
  ];
  for (const s of bad) {
    const pack = F.makePack();
    pack.facts[0].source = { ...pack.facts[0].source, ...s };
    const r = V.checkPack(pack, { purpose: 'CARD' });
    assert.ok(r.errors.some((e) => e.code === 'PACK_FIREWALL_SOURCE'), JSON.stringify(s));
  }
  assert.deepEqual(V.checkPack(F.makePack(), { purpose: 'CARD' }).errors, []);
});

test('AQ-23 a check report is never an input to cards, proposals, prereg bundles or the generator view', () => {
  for (const purpose of ['CARD', 'PROPOSAL', 'PREREG_BUNDLE', 'GENERATOR_VIEW']) {
    const pack = F.makePack();
    pack.facts[1].source.record_type = 'RQ_CHECK_REPORT_V1';
    assert.ok(V.checkPack(pack, { purpose }).errors.some((e) => e.code === 'PACK_CHECK_REPORT_AS_INPUT'), purpose);
  }
  const pack = F.makePack();
  pack.facts[1].source.record_type = 'RQ_CHECK_REPORT_V1';
  assert.equal(V.checkPack(pack, { purpose: 'CHECK' }).errors.some((e) => e.code === 'PACK_CHECK_REPORT_AS_INPUT'), false);
});

test('pack shape: facts need id/source/at/value, ids unique, no desk ids or Owner text keys, size bounded and splittable by matrix row', () => {
  const cases = [
    ['PACK_FACT_INVALID', (p) => { delete p.facts[0].source; }],
    ['PACK_FACT_INVALID', (p) => { p.facts[0].source.sha256 = 'zz'; }],
    ['PACK_FACT_DUPLICATE', (p) => { p.facts[1].id = 'F-001'; }],
    ['PACK_FORBIDDEN_FIELD', (p) => { p.facts[0].value.owner_text = '...'; }],
    ['PACK_FORBIDDEN_FIELD', (p) => { p.facts[0].value.desk_id = 'D-1'; }],
    ['PACK_MATRIX_FACT_UNKNOWN', (p) => { p.evidence_matrix[0].fact_ids = ['F-404']; }],
  ];
  for (const [code, mut] of cases) {
    const p = F.makePack();
    mut(p);
    assert.ok(V.checkPack(p, { purpose: 'CHECK' }).errors.some((e) => e.code === code), code);
  }
  const big = F.makePack();
  big.facts[0].value = { blob: 'x'.repeat(200000) };
  assert.ok(V.checkPack(big, { purpose: 'CHECK' }).errors.some((e) => e.code === 'PACK_TOO_LARGE'));
  const parts = V.splitPackByRow(F.makePack(), { maxTokens: 100 });
  assert.ok(parts.length >= 2);
  for (const part of parts) assert.ok(part.evidence_matrix.length >= 1);
  assert.deepEqual(parts.flatMap((p) => p.evidence_matrix.map((r) => r.req_id)).sort(), ['R1', 'R2']);
  for (const part of parts) assert.ok(part.facts.every((f) => part.evidence_matrix.some((r) => r.fact_ids.includes(f.id))));
});

/* ---------------------------------------------------------------- AQ-36 */
test('AQ-36 market -> agent host: CN_A on Linux only; US_EQUITY and CRYPTO on HK only, including tasks run on Linux', () => {
  assert.equal(V.agentHostFor('CN_A'), 'LINUX');
  assert.equal(V.agentHostFor('US_EQUITY'), 'HK');
  assert.equal(V.agentHostFor('CRYPTO'), 'HK');
  assert.throws(() => V.agentHostFor('NONE'), /RQ_AGENT_MARKET_INVALID/);
  assert.throws(() => V.agentHostFor('US'), /RQ_AGENT_MARKET_INVALID/);
  assert.doesNotThrow(() => V.assertAgentHost({ market: 'US_EQUITY', host: 'LINUX', agent_host: 'HK', kind: 'AI_CHECK' }, 'HK'));
  assert.throws(() => V.assertAgentHost({ market: 'US_EQUITY', host: 'LINUX', agent_host: 'HK', kind: 'AI_CHECK' }, 'LINUX'), /RQ_AGENT_HOST_MISMATCH/);
  assert.throws(() => V.assertAgentHost({ market: 'CN_A', host: 'LINUX', agent_host: 'LINUX', kind: 'AI_CHECK' }, 'HK'), /RQ_AGENT_HOST_MISMATCH/);
  assert.throws(() => V.assertAgentHost({ market: 'CN_A', host: 'LINUX', agent_host: 'HK', kind: 'AI_CHECK' }, 'HK'), /RQ_AGENT_HOST_MISMATCH/);
  assert.throws(() => V.assertAgentHost({ market: 'CN_A', host: 'LINUX', agent_host: 'HK', kind: 'AI_CHECK' }, 'LINUX'), /RQ_AGENT_HOST_MISMATCH/, 'the task row alone can be wrong');
});

/* ---------------------------------------------------------------- AQ-44 */
test('AQ-44 author != checker: admissions differ, the check pack carries the author row, equal admission is refused', () => {
  const adm = V.prompts.loadAdmissions();
  const check = adm.byKind.AI_CHECK;
  const card = adm.byKind.AI_REVIEW_CARD;
  assert.notEqual(check.system_sha256, card.system_sha256);
  const author = { kind: 'AI_PREREG', prompt_admission_sha256: F.sha('prereg-prompt'), model: 'deepseek-flash' };
  assert.equal(V.checkPack(F.makePack({ author }), { purpose: 'CHECK', check_admission_sha256: check.system_sha256 }).errors.length, 0);
  const same = { ...author, prompt_admission_sha256: check.system_sha256 };
  assert.ok(V.checkPack(F.makePack({ author: same }), { purpose: 'CHECK', check_admission_sha256: check.system_sha256 }).errors.some((e) => e.code === 'PACK_AUTHOR_IS_CHECKER'));
  assert.ok(V.checkPack(F.makePack({ author: { kind: 'AI_PREREG' } }), { purpose: 'CHECK', check_admission_sha256: check.system_sha256 }).errors.some((e) => e.code === 'PACK_AUTHOR_INVALID'));
  // 这个任务的产物是 AI 起草的 K2 时，包必须带作者行
  assert.ok(V.checkPack(F.makePack({ author: undefined }), { purpose: 'CHECK', check_admission_sha256: check.system_sha256, author_required: true }).errors.some((e) => e.code === 'PACK_AUTHOR_MISSING'));
});

test('prompt admissions: unique shas, code pins, and the frozen admitted/pending state matrix', () => {
  const adm = V.prompts.loadAdmissions();
  const shas = adm.entries.map((e) => e.system_sha256);
  const expectedStates = {
    AI_CHECK: 'ADMITTED',
    AI_REVIEW_CARD: 'ADMITTED',
    AI_PREREG: 'ADMITTED',
    AI_MECH_NOTE: 'PENDING_ADMISSION',
    AI_MECH_REVIEW: 'PENDING_ADMISSION',
  };
  assert.equal(new Set(shas).size, shas.length);
  assert.equal(adm.byKind.AI_CHECK.system_sha256, F.sha(V.prompts.CHECK_SYSTEM_TEXT));
  assert.equal(adm.byKind.AI_REVIEW_CARD.system_sha256, F.sha(V.prompts.CARD_SYSTEM_TEXT));
  assert.deepEqual(Object.fromEntries(adm.entries.map((e) => [e.kind, e.state])), expectedStates);
  for (const e of adm.entries.filter((x) => V.prompts.TEXTS[x.kind])) {
    assert.equal(e.system_sha256, F.sha(V.prompts.TEXTS[e.kind]), e.kind);
  }
  assert.equal(adm.byKind.AI_MECH_NOTE, undefined);
  assert.equal(adm.byKind.AI_MECH_REVIEW, undefined);
  assert.ok(V.prompts.CHECK_SYSTEM_TEXT.startsWith('You check whether a research task\'s evidence covers every row of a frozen evidence matrix.'));
  for (const t of [V.prompts.CHECK_SYSTEM_TEXT, V.prompts.CARD_SYSTEM_TEXT]) {
    assert.match(t, /Do not predict prices, returns, directions, probabilities, sizes or market impact/);
    assert.match(t, /Output only/);
  }
});

/* ---------------------------------------------------------------- 路由与 AQ-46 */
const triageNone = () => ({ route: 'NORMAL_NO_PRIOR', cite_seal_sha256: [] });
const idea = (over = {}, n = 1) => V.buildIdeaRecords(F.makeCard({ factor_ideas: [F.goodIdea(over)] }), F.ctx({ existing_idea_count: n - 1 }), { card_sha256: F.sha('c'), prompt_admission_sha256: F.sha('a'), model: 'deepseek-flash' })[0];

test('routing: an idea judged 不做（已判） by TRIAGE_QUERY is closed with the sealed sha, before anything else', () => {
  const r = V.routeIdea(idea(), { registry: F.makeRegistry(), triage: () => ({ route: 'NOT_DO_SETTLED', cite_seal_sha256: [F.sha('seal')] }) });
  assert.equal(r.state, 'CLOSED_NOT_DO_SETTLED');
  assert.deepEqual(r.cite_seal_sha256, [F.sha('seal')]);
  const nu = idea({ mechanism: { NEW: { proposed_id: 'SEL.LIQUIDITY.AMIHUD_TILT', title_zh: '流动性冲击', description_zh: '成交额骤降后的个股后续表现', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } } });
  let asked = false;
  const r2 = V.routeIdea(nu, { registry: F.makeRegistry(), triage: () => { asked = true; return triageNone(); } });
  assert.equal(asked, false, 'a NEW mechanism has no prior to query');
  assert.equal(r2.state, 'WAITING_MECHANISM_ADMISSION');
});

test('routing: NEW mechanism -> admission program queue (WAITING_EXTERNAL:MECHANISM_ADMISSION); existing mechanism with space readings -> generator path; only registered factors -> AI_PREREG', () => {
  const nu = idea({ mechanism: { NEW: { proposed_id: 'SEL.LIQUIDITY.AMIHUD_TILT', title_zh: '流动性冲击', description_zh: '成交额骤降后的个股后续表现', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } } });
  const a = V.routeIdea(nu, { registry: F.makeRegistry(), triage: triageNone });
  assert.deepEqual([a.route, a.state, a.wait_code], ['MECHANISM_ADMISSION', 'WAITING_MECHANISM_ADMISSION', 'WAITING_EXTERNAL:MECHANISM_ADMISSION']);
  const g = V.routeIdea(idea(), { registry: F.makeRegistry(), triage: triageNone });
  assert.deepEqual([g.route, g.state], ['GENERATOR', 'GENERATOR_VIEW_PENDING']);
  const p = V.routeIdea(idea({ readings: ['CN_A.MOM.RS60_MARKET_PCT', 'CN_A.VOL.REALIZED_20'] }), { registry: F.makeRegistry(), triage: triageNone });
  assert.deepEqual([p.route, p.state], ['AI_PREREG', 'PREREG_PROPOSED']);
});

test('routing: an existing-mechanism idea with no TRIAGE_QUERY reading is TRIAGE_PENDING (unknown is not "no prior"), never silently routed', () => {
  const r = V.routeIdea(idea(), { registry: F.makeRegistry(), triage: () => null });
  assert.deepEqual([r.state, r.wait_code], ['TRIAGE_PENDING', 'WAITING_EXTERNAL:TRIAGE_QUERY']);
  const r2 = V.routeIdea(idea(), { registry: F.makeRegistry() });
  assert.equal(r2.state, 'TRIAGE_PENDING');
});

test('routing: crypto holds the generator path (RF1116) but not the prereg path', () => {
  const reg = F.makeRegistry({ market: 'CRYPTO' });
  const mk = (over) => ({ ...idea(over), market: 'CRYPTO', idea_id: 'FI-CRYPTO-2026-W47-1' });
  const g = V.routeIdea(mk({}), { registry: reg, triage: triageNone });
  assert.equal(g.state, 'GENERATOR_HELD_CRYPTO');
  const nu = V.routeIdea(mk({ mechanism: { NEW: { proposed_id: 'SEL.LIQUIDITY.AMIHUD_TILT', title_zh: '流动性冲击', description_zh: '成交额骤降后的个股后续表现', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } } }), { registry: reg, triage: triageNone });
  assert.equal(nu.state, 'GENERATOR_HELD_CRYPTO');
  const p = V.routeIdea(mk({ readings: ['CN_A.MOM.RS60_MARKET_PCT'] }), { registry: reg, triage: triageNone });
  assert.equal(p.state, 'PREREG_PROPOSED');
});

test('routing: the default triage reads the real mechanism register and returns a route reading', () => {
  const r = V.triageViaRegister({ mechanism_id: 'SEL.XSEC.REVERSAL', market: 'CN_A' });
  assert.ok(typeof r.route === 'string' && Array.isArray(r.cite_seal_sha256));
});

test('AQ-46 ideas -> generator view: a merged admission makes the mechanism id visible in ideas_in_view[] with provenance shas', () => {
  const nuMech = { NEW: { proposed_id: 'SEL.LIQUIDITY.AMIHUD_TILT', title_zh: '流动性冲击', description_zh: '成交额骤降后的个股后续表现', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } };
  const nu = idea({ mechanism: nuMech }, 2);
  const ex = idea({}, 1);
  const pack = F.makePack();
  const packsBySha = { [nu.fact_pack_sha256]: pack };
  const routes = [V.routeIdea(nu, { registry: F.makeRegistry(), triage: triageNone }), V.routeIdea(ex, { registry: F.makeRegistry(), triage: triageNone })];
  const before = V.buildIdeasInView({ ideas: [nu, ex], routes, packsBySha, registerIds: new Set(F.makeRegistry().mechanisms.map((m) => m.mechanism_id)) });
  assert.deepEqual(before.ideas_in_view.map((x) => x.idea_id), [ex.idea_id], 'unadmitted NEW mechanism is not in view');
  const merged = V.admission.mergeAdmittedIds(new Set(F.makeRegistry().mechanisms.map((m) => m.mechanism_id)), [{ mechanism_id: 'SEL.LIQUIDITY.AMIHUD_TILT', classified_by: 'AI_REVIEW_CARD', idea_id: nu.idea_id }]);
  const after = V.buildIdeasInView({ ideas: [nu, ex], routes, packsBySha: { [nu.fact_pack_sha256]: pack }, registerIds: merged });
  const entry = after.ideas_in_view.find((x) => x.idea_id === nu.idea_id);
  assert.equal(entry.mechanism_id, 'SEL.LIQUIDITY.AMIHUD_TILT');
  assert.equal(entry.card_sha256, nu.card_sha256);
  assert.equal(entry.fact_pack_sha256, nu.fact_pack_sha256);
  assert.deepEqual(entry.reading_ids, ['RS60', 'VOL20']);
  assert.deepEqual(after.mechanism_ids_in_view, ['SEL.LIQUIDITY.AMIHUD_TILT', 'SEL.XSEC.REVERSAL']);
});

test('AQ-46 ideas whose pack cites forbidden sources never reach the generator view; closed, prereg and crypto-held ideas are not in view', () => {
  const ex = idea({});
  const dirty = F.makePack();
  dirty.facts[1].source.path = 'qrp/var/mining/out/r1/x.json';
  const ids = new Set(F.makeRegistry().mechanisms.map((m) => m.mechanism_id));
  const route = V.routeIdea(ex, { registry: F.makeRegistry(), triage: triageNone });
  const r = V.buildIdeasInView({ ideas: [ex], routes: [route], packsBySha: { [ex.fact_pack_sha256]: dirty }, registerIds: ids });
  assert.deepEqual(r.ideas_in_view, []);
  assert.deepEqual(r.refused.map((x) => [x.idea_id, x.code]), [[ex.idea_id, 'IDEA_PROVENANCE_FIREWALL']]);
  const missing = V.buildIdeasInView({ ideas: [ex], routes: [route], packsBySha: {}, registerIds: ids });
  assert.deepEqual(missing.refused.map((x) => x.code), ['IDEA_PROVENANCE_UNKNOWN']);
  const closed = { ...route, state: 'CLOSED_NOT_DO_SETTLED', route: 'CLOSED' };
  const clean = F.makePack();
  const c = V.buildIdeasInView({ ideas: [ex], routes: [closed], packsBySha: { [ex.fact_pack_sha256]: clean }, registerIds: ids });
  assert.deepEqual(c.ideas_in_view, []);
});

test('mechanism admission stub: a NEW idea is queued as WAITING, never admitted or written to the register here', () => {
  const nu = idea({ mechanism: { NEW: { proposed_id: 'SEL.LIQUIDITY.AMIHUD_TILT', title_zh: '流动性冲击', description_zh: '成交额骤降后的个股后续表现', layer: 'SELECTION_TIMING', decision_point: 'SELECT' } } });
  const p = V.admission.proposeAdmission(nu);
  assert.equal(p.schema, 'MECHANISM_PROPOSAL_V1');
  assert.equal(p.state, 'WAITING_EXTERNAL:MECHANISM_ADMISSION');
  assert.equal(p.classified_by, 'AI_REVIEW_CARD');
  assert.equal(p.proposed.mechanism_id, 'SEL.LIQUIDITY.AMIHUD_TILT');
  assert.equal(p.idea_id, nu.idea_id);
  assert.throws(() => V.admission.proposeAdmission(idea({})), /MECHANISM_PROPOSAL_NOT_NEW/);
  assert.equal(typeof V.admission.admit, 'undefined', 'the admission program itself is RF1118 C4, not in Q2');
});

test('registry view builder (host side): mechanisms with layers from the real register, factor-library readings with PIT copied, frozen-space readings as SPACE', () => {
  const { buildRegistryView } = require('../services/research-queue-agent/registries');
  const reg = buildRegistryView({ market: 'CN_A', space: { readings: [{ name: 'RS60', pit_available_at: 'T 日收盘后' }], holding_periods: [5, 10] } });
  const m = reg.mechanisms.find((x) => x.mechanism_id === 'SEL.XSEC.REVERSAL');
  assert.deepEqual([m.layer, m.decision_point], ['SELECTION_TIMING', 'SELECT']);
  assert.deepEqual(reg.readings.RS60, { pit_available_at: 'T 日收盘后', origin: 'SPACE' });
  assert.equal(reg.readings['CN_A.MOM.RS60_MARKET_PCT'].origin, 'FACTOR_LIBRARY');
  assert.equal(typeof reg.readings['CN_A.MOM.RS60_MARKET_PCT'].pit_available_at, 'string');
  assert.deepEqual(reg.holding_periods, [5, 10]);
  assert.equal(Object.values(reg.readings).some((r) => r.origin === 'FACTOR_LIBRARY' && r.pit_available_at === undefined), false);
});

test('numbers: an uncited free string (unknowns) may use a number that sits in any fact of the pack; a pack with a key-shaped string is refused', () => {
  const x = F.makeCheckReport({ unknowns: ['样本 87 是否足够'] });
  assert.equal(V.validateCheckReport(JSON.stringify(x), F.makePack()).ok, true);
  const pack = F.makePack();
  pack.facts[0].value = { note: 'sk-' + 'A'.repeat(30) };
  assert.ok(V.checkPack(pack, { purpose: 'CARD' }).errors.some((e) => e.code === 'PACK_SECRET_SHAPED'));
  const leak = F.makeCheckReport();
  leak.items[0].note_zh = `见 sk-${'B'.repeat(30)}`;
  assert.ok(V.validateCheckReport(JSON.stringify(leak), F.makePack()).errors.some((e) => e.code === 'CHECK_SECRET_SHAPED'));
});

test('card: a question proposal with direction wording is refused (ideas and questions carry no direction)', () => {
  const c = F.makeCard({ question_proposals: [{ mechanism_id: 'NEW', layer: 'RISK', decision_point: 'SIZING', market: 'CN_A', question_zh: '回撤后是否应当做空？', fact_ids: ['F-001'] }] });
  assert.ok(codes(V.validateCard(JSON.stringify(c), F.ctx())).includes('CARD_DIRECTION_WORDING'));
});
