'use strict';
/**
 * 因子库 FACTOR_LIBRARY_V1（研究框架修订 2026-11-16 已签字修订（签字文本 fd22876f）§2、§8.3 第 1–2 条；P0）：
 *   - config/research_factor_library.v1.json 只有一个生产者（services/factor-library）：提交的字节必须等于 build() 的输出；
 *   - 结构校验：缺 pit_available_at、economic_logic_zh、class 被拒；未知 class、origin 被拒；P0 里 DSL 公式被拒；
 *   - mechanism_id 写了就必须在机制登记表里（research-mechanism-register 的 isRegistered）；
 *   - 旧规则补登记：每条绑定的源文件在钉版提交上 sha256 一致、记录的字段值与源文件一致（兄弟仓不在本机时跳过，不算通过）。
 * 全部是合成夹具或钉版源文件的只读 git show；不读行情，不写任何生产路径。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const lib = require('../services/factor-library');
const mech = require('../services/research-mechanism-register');
const { validateRecord } = require('../schemas');

const clone = (v) => JSON.parse(JSON.stringify(v));
const RAW = JSON.parse(fs.readFileSync(lib.FILE, 'utf8'));
const byId = (doc, id) => doc.factors.find((f) => f.factor_id === id);

/** 一条合法的人工登记因子（不绑定源文件），作为结构校验反例的底版。 */
function humanEntry(patch = {}) {
  return {
    factor_id: 'CN_A.MOM.TEST_RS20', market: 'CN_A', layer: 'SELECTION_CROSS_SECTION',
    universe: { id: 'TEST_UNIVERSE', version: 'v1', definition_zh: '合成股票池' },
    class: 'MOMENTUM', class_reason_zh: null,
    definition_zh: '合成：20 日收益的截面秩', formula: 'CF:quant-research-platform:tests/factor_library.test.js#humanEntry',
    inputs: ['V6_FEATURE:relative_strength_20'], pit_available_at: 'T 日收盘后，known-at 首次可得',
    horizon: { trading_days: 20, state: 'DEFINED', note_zh: '合成' },
    economic_logic_zh: '合成：动量延续', origin: 'HUMAN', mining: null, status: 'RESEARCH', mechanism_id: null,
    correlation: { state: 'NOT_COMPUTED', reason_zh: '合成夹具' }, dedupe: { decision: 'NOT_EVALUATED', reason_zh: '合成夹具' },
    evidence: { state: 'NONE', refs: [] }, source: null, code_refs: [], rule_ref: null, weight_in_rule: null, composite: null, unverified: [],
    ...patch,
  };
}
const withEntry = (entry) => { const d = clone(RAW); d.factors.push(entry); return d; };
const rejects = (doc, re) => assert.throws(() => lib.validate(doc), (e) => e instanceof lib.FactorLibraryError && re.test(e.message), `应以 ${re} 拒绝`);

// ── 一个生产者 ────────────────────────────────────────────────────────────────

test('因子库文件：合同 FACTOR_LIBRARY_V1，校验通过，require 时加载', () => {
  assert.equal(RAW.schema, 'FACTOR_LIBRARY_V1');
  assert.equal(lib.LIBRARY.schema, 'FACTOR_LIBRARY_V1');
  assert.ok(Object.isFrozen(lib.LIBRARY));
  assert.doesNotThrow(() => lib.validate(RAW));
  assert.equal(RAW.production_effect, 'NONE');
  assert.equal(RAW.contract_ref.sha256, lib.CONTRACT_REF.sha256);
  assert.ok(RAW.contract_ref.sha256.startsWith('39f8c17c'));
  assert.deepEqual([RAW.contract_ref.state, RAW.contract_ref.effective_from, RAW.contract_ref.texts.map((t) => `${t.id}:${t.sha256.slice(0, 8)}`)],
    ['SIGNED', '2026-11-16T23:50:00+08:00', ['SIGNED_TEXT_REV_4:fd22876f']]);
});

/** 协调会话目录：默认是本仓库的上一级（KaylaProject）；QRP_COORDINATOR_ROOT 可覆盖。目录不在（别的机器、CI）就跳过。 */
const COORD_ROOT = process.env.QRP_COORDINATOR_ROOT || require('node:path').resolve(__dirname, '..', '..');
const coordFile = (rel) => require('node:path').join(COORD_ROOT, rel);
const coordPresent = [lib.CONTRACT_REF.path, ...lib.CONTRACT_REF.texts.map((t) => t.path)].every((rel) => fs.existsSync(coordFile(rel)));
const sha256Of = (b) => require('node:crypto').createHash('sha256').update(b).digest('hex');

test('签字页与签字文本：按文件重算 sha256，与绑定一致；签字页写着签字文本的 sha256 与生效时刻（协调会话目录在时）', { skip: coordPresent ? false : `coordinator files not found under ${COORD_ROOT}` }, () => {
  assert.equal(sha256Of(fs.readFileSync(coordFile(lib.CONTRACT_REF.path))), lib.CONTRACT_REF.sha256);
  for (const t of lib.CONTRACT_REF.texts) assert.equal(sha256Of(fs.readFileSync(coordFile(t.path))), t.sha256, t.id);
  const page = fs.readFileSync(coordFile(lib.CONTRACT_REF.path), 'utf8');
  assert.ok(page.includes(lib.CONTRACT_REF.texts[0].sha256), 'signature page names the signed text sha256');
  assert.ok(page.includes(`EFFECTIVE_FROM = ${lib.CONTRACT_REF.effective_from}`), 'signature page states EFFECTIVE_FROM');
});

test('一个生产者：提交的 JSON 字节等于 services/factor-library 的 build() 输出（不手改）', () => {
  assert.equal(fs.readFileSync(lib.FILE, 'utf8'), lib.bytes(lib.build()).toString('utf8'));
});

test('schemas/index.js：FACTOR_LIBRARY_V1 与 FACTOR_LIBRARY_ENTRY_V1 已登记，文件与每一条都合规', () => {
  assert.equal(validateRecord(RAW, 'FACTOR_LIBRARY_V1').ok, true);
  for (const f of RAW.factors) assert.deepEqual(validateRecord(f, 'FACTOR_LIBRARY_ENTRY_V1').problems, [], f.factor_id);
  const bad = clone(RAW.factors[0]); delete bad.pit_available_at;
  assert.ok(validateRecord(bad, 'FACTOR_LIBRARY_ENTRY_V1').problems.includes('MISSING:pit_available_at'));
});

// ── 结构校验的反例 ────────────────────────────────────────────────────────────

test('合法的人工登记条目通过（反例的底版本身合规）', () => {
  assert.doesNotThrow(() => lib.validate(withEntry(humanEntry())));
});

test('缺 pit_available_at、economic_logic_zh 或 class 的条目被拒', () => {
  for (const field of ['pit_available_at', 'economic_logic_zh', 'class']) {
    const e = humanEntry(); delete e[field];
    rejects(withEntry(e), new RegExp(`^FACTOR_LIBRARY_MISSING:factors\\[\\d+\\]\\.${field}$`));
    rejects(withEntry(humanEntry({ [field]: '  ' })), /^FACTOR_LIBRARY_(FIELD|CLASS_UNKNOWN):/);
  }
});

test('未知 class 被拒；OTHER 必须写理由，其余类不得写理由', () => {
  rejects(withEntry(humanEntry({ class: 'GROWTH' })), /^FACTOR_LIBRARY_CLASS_UNKNOWN:/);
  rejects(withEntry(humanEntry({ class: 'OTHER', class_reason_zh: null })), /^FACTOR_LIBRARY_CLASS_OTHER_REASON:/);
  rejects(withEntry(humanEntry({ class: 'MOMENTUM', class_reason_zh: '多余' })), /^FACTOR_LIBRARY_CLASS_OTHER_REASON:/);
  assert.doesNotThrow(() => lib.validate(withEntry(humanEntry({ class: 'OTHER', class_reason_zh: '成长类不在七类之内' }))));
});

test('未知 origin 被拒；AI 挖出的必须写轮次与候选编号，其余不得写', () => {
  rejects(withEntry(humanEntry({ origin: 'AI' })), /^FACTOR_LIBRARY_ORIGIN_UNKNOWN:/);
  rejects(withEntry(humanEntry({ origin: 'AI_MINED_GP', status: 'CANDIDATE' })), /^FACTOR_LIBRARY_MINING:/);
  rejects(withEntry(humanEntry({ mining: { round_id: 'R1', candidate_id: 'C1' } })), /^FACTOR_LIBRARY_MINING:/);
  assert.doesNotThrow(() => lib.validate(withEntry(humanEntry({ origin: 'AI_MINED_LLM', status: 'CANDIDATE', mining: { round_id: 'R001', candidate_id: 'R001-C001' } }))));
});

test('P0 里 DSL 公式被拒（DSL 留给 P1）；代码引用必须写成 CF:<repo>:<path>#<entry>', () => {
  rejects(withEntry(humanEntry({ formula: 'DSL:rank(ts_delta(close, 20))' })), /^FACTOR_LIBRARY_FORMULA_DSL_RESERVED:/);
  rejects(withEntry(humanEntry({ formula: 'rank(ts_delta(close, 20))' })), /^FACTOR_LIBRARY_FORMULA_DSL_RESERVED:/);
  rejects(withEntry(humanEntry({ formula: { dsl: 'rank(close)' } })), /^FACTOR_LIBRARY_FIELD:/);
  rejects(withEntry(humanEntry({ formula: 'CF:ashare-v6:src/x.js' })), /^FACTOR_LIBRARY_FORMULA_DSL_RESERVED:|^FACTOR_LIBRARY_FORMULA:/);
});

test('其余字段：层只开 SELECTION_CROSS_SECTION、状态与市场取枚举、编号不重复、读数写命名空间', () => {
  rejects(withEntry(humanEntry({ layer: 'TIMING' })), /^FACTOR_LIBRARY_LAYER:/);
  rejects(withEntry(humanEntry({ status: 'LIVE' })), /^FACTOR_LIBRARY_STATUS:/);
  rejects(withEntry(humanEntry({ market: 'CRYPTO' })), /^FACTOR_LIBRARY_MARKET:/);
  rejects(withEntry(humanEntry({ factor_id: RAW.factors[0].factor_id })), /^FACTOR_LIBRARY_DUPLICATE:/);
  rejects(withEntry(humanEntry({ inputs: [] })), /^FACTOR_LIBRARY_FIELD:/);
  rejects(withEntry(humanEntry({ inputs: ['close'] })), /^FACTOR_LIBRARY_INPUT:/);
  rejects(withEntry(humanEntry({ horizon: { trading_days: 0, state: 'DEFINED', note_zh: 'x' } })), /^FACTOR_LIBRARY_HORIZON:/);
  rejects(withEntry(humanEntry({ horizon: { trading_days: null, state: 'DEFINED', note_zh: 'x' } })), /^FACTOR_LIBRARY_HORIZON:/);
});

test('旧规则条目必须绑定源文件且不重新判定；合成分的分量必须已登记、权重与分量自己写的一致', () => {
  const legacy = clone(RAW.factors.find((f) => f.origin === 'LEGACY_RULE'));
  const a = clone(legacy); a.factor_id = 'CN_A.MOM.TEST_A'; a.source = null;
  rejects(withEntry(a), /^FACTOR_LIBRARY_SOURCE:/);
  const b = clone(legacy); b.factor_id = 'CN_A.MOM.TEST_B'; b.source.sha256 = 'xyz';
  rejects(withEntry(b), /^FACTOR_LIBRARY_SOURCE:/);
  const c = clone(legacy); c.factor_id = 'CN_A.MOM.TEST_C'; c.dedupe = { decision: 'KEEP_NEW' };
  rejects(withEntry(c), /^FACTOR_LIBRARY_LEGACY_REJUDGED:/);
  const doc = clone(RAW);
  const comp = doc.factors.find((f) => f.composite);
  comp.composite.components[0].factor_id = 'CN_A.MOM.NOPE';
  rejects(doc, /^FACTOR_LIBRARY_COMPOSITE:/);
  const doc2 = clone(RAW);
  const member = doc2.factors.find((f) => f.weight_in_rule);
  member.weight_in_rule.weight += 0.01;
  rejects(doc2, /^FACTOR_LIBRARY_COMPOSITE:/);
});

// ── 机制引用检查 ──────────────────────────────────────────────────────────────

test('mechanism_id 写了就必须在机制登记表里；没写（null）放行', () => {
  assert.equal(mech.isRegistered('SEL.SECTOR_RS.RANK'), true);
  assert.equal(mech.isRegistered('SEL.NOPE.NOPE'), false);
  assert.equal(mech.isRegistered(null), false);
  rejects(withEntry(humanEntry({ mechanism_id: 'SEL.NOPE.NOPE' })), /^FACTOR_LIBRARY_MECHANISM_UNKNOWN:/);
  assert.doesNotThrow(() => lib.validate(withEntry(humanEntry({ mechanism_id: 'SEL.SECTOR_RS.RANK' }))));
  for (const f of RAW.factors) if (f.mechanism_id !== null) assert.equal(mech.isRegistered(f.mechanism_id), true, f.factor_id);
});

// ── 旧规则补登记：登记了什么 ──────────────────────────────────────────────────

test('补登记清单：16 条旧规则因子，全部 LEGACY_RULE、不重新判定', () => {
  assert.deepEqual(RAW.factors.map((f) => f.factor_id), [
    'CN_A.MOM.RS60_MARKET_PCT', 'CN_A.MOM.RS20_UNIT_PCT', 'CN_A.QUALITY.STRUCTURAL_SCORE', 'CN_A.GROWTH.NETPROFIT_YOY_PCT',
    'CN_A.VALUE.VALUATION_GATE_INV', 'CN_A.MAINLINE.UNIT_SCORE', 'CN_A.COMPOSITE.STOCK_BOOK_V4',
    'CN_A_IND.MOM.INDUSTRY_RS60_PCT', 'CN_A_IND.MOM.TREND_BREADTH', 'CN_A_IND.VP.VOLUME_EXPANSION_PCT', 'CN_A_IND.MOM.LEADER_RS20_Q90',
    'CN_A_IND.COMPOSITE.MAINLINE_SCORE_V7', 'CN_A.MOM.RS20_REALIZED_CORE_POOL', 'CN_A.SENT.ANALYST_REVISION_BREADTH',
    'CN_A_ETF.MOM.SECTOR_ETF_REALIZED_MOM20', 'US_EQUITY_ETF.MOM.SECTOR_RS_EXCESS_63_126',
  ]);
  for (const f of RAW.factors) {
    assert.equal(f.origin, 'LEGACY_RULE');
    assert.equal(f.dedupe.decision, 'LEGACY_BASELINE');
    assert.equal(f.evidence.state, 'NOT_REJUDGED');
    assert.match(f.formula, /^CF:(ashare-v6|smartflow):/);
  }
});

test('③ 复合分：六个分量与权重照 stock_book_five_stage_v4.json（55b818a1…）', () => {
  const comp = byId(RAW, 'CN_A.COMPOSITE.STOCK_BOOK_V4');
  assert.ok(comp.source.sha256.startsWith('55b818a1'));
  assert.equal(comp.source.path, 'config/v6/research/stock_book_five_stage_v4.json');
  assert.deepEqual(Object.fromEntries(comp.composite.components.map((c) => [c.rule_component, c.weight])),
    { RS_MARKET: 0.3, LEADERSHIP: 0.2, QUALITY: 0.2, EARNINGS: 0.1, VALUATION: 0.1, MAINLINE: 0.1 });
});

test('主线排序 v7：四个特征带权重；leaderQuantile 是参数、maxMissingShare 是覆盖守卫，不登记为因子', () => {
  const comp = byId(RAW, 'CN_A_IND.COMPOSITE.MAINLINE_SCORE_V7');
  assert.deepEqual(Object.fromEntries(comp.composite.components.map((c) => [c.rule_component, c.weight])),
    { industryRs60Pct: 0.4, industryTrendBreadth: 0.3, industryVolumeExpansionPct: 0.15, industryLeaderRs20: 0.15 });
  const skipped = RAW.not_registered.map((n) => n.field);
  assert.ok(skipped.includes('/payload/features/leaderQuantile'));
  assert.ok(skipped.includes('/payload/features/maxMissingShare'));
});

test('核心池排序键：CORE_POOL_SELECTION 已退役，登记为 RETIRED；A23 挂 SEL.SECTOR_RS.RANK，运行开关已核实（协调会话 A22 部署后核对）', () => {
  assert.equal(byId(RAW, 'CN_A.MOM.RS20_REALIZED_CORE_POOL').status, 'RETIRED');
  const a23 = byId(RAW, 'US_EQUITY_ETF.MOM.SECTOR_RS_EXCESS_63_126');
  assert.equal(a23.mechanism_id, 'SEL.SECTOR_RS.RANK');
  assert.ok(!a23.unverified.some((u) => /US_V5_SECTOR_RS/.test(u.reason_zh)));
  assert.deepEqual([a23.evidence.runtime_switch.name, a23.evidence.runtime_switch.value, a23.evidence.runtime_switch.state, a23.evidence.runtime_switch.verified_at],
    ['US_V5_SECTOR_RS', 'on', 'VERIFIED', '2026-11-16T23:34:26+08:00']);
});

// ── 旧规则补登记：源文件核对 ──────────────────────────────────────────────────

test('补登记：每条绑定的源文件在钉版提交上 sha256 一致，记录的字段值与源文件一致', (t) => {
  const bindings = lib.bindingsOf(RAW);
  assert.ok(bindings.length >= 16);
  const results = bindings.map((b) => lib.verifyBinding(b));
  const unavailable = results.filter((r) => r.state === 'UNAVAILABLE');
  for (const r of results.filter((x) => x.state !== 'UNAVAILABLE')) {
    assert.equal(r.state, 'MATCH', `${r.repo}@${r.commit.slice(0, 8)}:${r.path} ${JSON.stringify(r.problems)}`);
  }
  if (unavailable.length) {
    const repos = [...new Set(unavailable.map((r) => `${r.repo}(${r.reason})`))].join(', ');
    t.skip(`兄弟仓不在本机或缺钉版提交，${unavailable.length} 条未核对（非通过）：${repos}；可用 QRP_V6_ROOT / QRP_SMARTFLOW_ROOT 指定`);
  }
});

test('源文件核对：sha256 不符、字段值不符都判 MISMATCH；仓不在时判 UNAVAILABLE', () => {
  const b = lib.bindingsOf(RAW)[0];
  const none = lib.verifyBinding(b, { roots: { [b.repo]: '/nonexistent/qrp-test-root' } });
  assert.equal(none.state, 'UNAVAILABLE');
  const bytes = Buffer.from('{"payload":{"x":1}}\n');
  const reader = () => bytes;
  const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const ok = lib.verifyBinding({ ...b, sha256: sha, extract: [{ kind: 'JSON_POINTER', pointer: '/payload/x', value: 1 }] }, { reader });
  assert.equal(ok.state, 'MATCH');
  assert.equal(lib.verifyBinding({ ...b, sha256: 'f'.repeat(64), extract: [] }, { reader }).state, 'MISMATCH');
  assert.equal(lib.verifyBinding({ ...b, sha256: sha, extract: [{ kind: 'JSON_POINTER', pointer: '/payload/x', value: 2 }] }, { reader }).state, 'MISMATCH');
  assert.equal(lib.verifyBinding({ ...b, sha256: sha, extract: [{ kind: 'TEXT', contains: '"y"' }] }, { reader }).state, 'MISMATCH');
});
