'use strict';
/**
 * 机制登记与分诊查询（QRP_RESEARCH_MECHANISM_REGISTER_V1；研究框架修订 2026-11-12 §4，冻结审阅 E1–E18 取 (a)）：
 *   - config/research_mechanism_register.v1.json 的形状：机制 id 写法与层、决策点、parent、entries 的键与结论块；
 *   - 结论块凡写了 sealed_ref，与 QRP 已有的封存结论 ENTRIES 交叉核对（sha256、封存日、做 / 不做）；
 *   - 分诊路由（§4.3 的表）：只在「同 id、同市场、最晚一条是不做、功效 ≥ 80%、之后没有新数据」时给出 NOT_DO_SETTLED，其余一律正常分诊；
 *   - 新数据 = 同市场有效 UNSEEN 段（不完全落在先前窗口内）或晚于先前窗口的 FORWARD_READ；窗口缺失 = UNKNOWN；
 *   - 输出 MECHANISM_PRIOR_TABLE_V1 是确定的（同输入同字节），不写任何文件、不写分诊台账；
 *   - 命令行 mechanism_query.js：参数未知或缺失时失败即关。
 * 全部用合成夹具；不读、不写 desk 与生产。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const mech = require('../services/research-mechanism-register');
const trials = require('../services/trial-ledger');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'apps', 'research-cli', 'mechanism_query.js');
const RAW = JSON.parse(fs.readFileSync(mech.FILE, 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const AS_OF = '2026-11-20T10:00:00+08:00';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

/** 合成登记表：三个机制（一个父、一个子、一个无关），entries 由调用方给。 */
function doc(entries = [], patch = (d) => d) {
  const d = {
    _comment: '合成夹具',
    contract: mech.CONTRACT,
    contract_ref: { path: mech.AMENDMENT.path, sha256: `${mech.AMENDMENT.sha_prefix}${'0'.repeat(64 - mech.AMENDMENT.sha_prefix.length)}`, state: mech.AMENDMENT.state, ref_zh: '合成' },
    registered_at: '2026-11-15T22:00:00+08:00',
    registered_by: '测试',
    mechanisms: [
      { mechanism_id: 'SEL.KLINE_VETO.AT_LEVEL', title_zh: '结构位 K 线否决', layer: 'SELECTION_TIMING', decision_point: 'ENTRY', description_zh: '在结构位出现反向 K 线时不入场' },
      { mechanism_id: 'SEL.KLINE_VETO.AT_LEVEL_STRICT', title_zh: '结构位 K 线否决（严格）', layer: 'SELECTION_TIMING', decision_point: 'ENTRY', description_zh: '同上，只认收盘确认', parent: 'SEL.KLINE_VETO.AT_LEVEL' },
      { mechanism_id: 'RISK.MARKET_STATE.DIRECTION_SWITCH', title_zh: '市场状态方向开关', layer: 'RISK', decision_point: 'SIZING', description_zh: '按市场状态调 k' },
    ],
    entries,
  };
  return patch(d);
}
const bytesOf = (d) => Buffer.from(`${JSON.stringify(d, null, 2)}\n`);

/** 一条带结论的 entry。 */
function concluded(itemId, { market = 'CN_A', ids = ['SEL.KLINE_VETO.AT_LEVEL'], verdict = 'DONT', power = { value: 0.85, ge_80: true }, window = { from: '2024-01-02', to: '2026-09-28' },
  sealedOn = '2026-11-01', seal = SHA_A, state, family = 'ASHARE_V6_PAPER', extra = {} } = {}) {
  const conclusion = {
    verdict, strength_zh: '合成', power: { ...power, effect_zh: '预登记判定效应', source_zh: '合成结果 §3' }, family_id: family, data_window: window, sealed_on: sealedOn, seal_sha256: seal,
  };
  if (state !== undefined) conclusion.state = state;
  return { item_id: itemId, strategy_ref: family, market, mechanism_ids: ids, classified_by: 'test', reason_zh: '合成（§4.2）', conclusion: { ...conclusion, ...extra } };
}
const inProgress = (itemId, { market = 'CN_A', ids = ['SEL.KLINE_VETO.AT_LEVEL'] } = {}) => ({ item_id: itemId, strategy_ref: 'ASHARE_V6_PAPER', market, mechanism_ids: ids, classified_by: 'test', reason_zh: '在研（§4.2）' });

/** 合成数据段标签（DATA_SEGMENT_MARK_V1 的形状；不写台账）。 */
let markSeq = 0;
function mark({ family = 'ASHARE_V6_PAPER', market = 'CN_A', from, to, label, shadow = null, at = '2026-11-10T10:00:00+08:00' }) {
  markSeq += 1;
  const body = { schema: 'DATA_SEGMENT_MARK_V1', mark_id: `SEG-${String(markSeq).padStart(16, '0')}`, family_id: family, market, from, to, label, seen_kind: null,
    shadow_ref: shadow, reason: '合成', source_refs: [], supersedes: null, defect_ref: null, production_effect: 'NONE', registered_by: 'T', registered_at: at };
  return { ...body, record_hash: sha(trials.canonicalJson(body)) };
}

const ask = (entries, { ids = ['SEL.KLINE_VETO.AT_LEVEL'], market = 'CN_A', ownerNamed = false, marks = [], asOf = AS_OF, patch } = {}) =>
  mech.query({ mechanism_ids: ids, market, owner_named: ownerNamed }, { registerBytes: bytesOf(doc(entries, patch)), registerCommit: null, marks, asOf });

// ── 1. 登记表形状 ─────────────────────────────────────────────────────────────

test('登记表：真实文件通过校验；绑定修订文本的 path 与 sha 前缀；本机有那份文件时现场核对 sha256', () => {
  assert.equal(mech.REGISTER.contract, 'QRP_RESEARCH_MECHANISM_REGISTER_V1');
  assert.equal(RAW.contract_ref.path, mech.AMENDMENT.path);
  assert.ok(RAW.contract_ref.sha256.startsWith(mech.AMENDMENT.sha_prefix));
  assert.equal(RAW.contract_ref.state, mech.AMENDMENT.state);
  const local = path.join(ROOT, '..', RAW.contract_ref.path);
  if (fs.existsSync(local)) assert.equal(sha(fs.readFileSync(local)), RAW.contract_ref.sha256, '本机修订文本的 sha256 与登记不一致');
  // 首版（冻结审阅 E17 (a)）：机制与条目都由补登记另行写入
  assert.ok(Array.isArray(RAW.mechanisms) && Array.isArray(RAW.entries));
  // 公开仓库：登记表只写泛化的一句话，没有 Owner 原话的引号
  assert.doesNotMatch(fs.readFileSync(mech.FILE, 'utf8'), /「[^」]*」/);
});

test('登记表：合成登记表通过；逐项打坏一个字段，各报对应的错误码', () => {
  const good = doc([concluded('A01'), inProgress('A02', { ids: ['SEL.KLINE_VETO.AT_LEVEL_STRICT'] })]);
  assert.doesNotThrow(() => mech.validate(good));
  const cases = [
    ['contract', (d) => { d.contract = 'X'; }, /MECHANISM_REGISTER_CONTRACT_INVALID/],
    ['contract_ref.path', (d) => { d.contract_ref.path = 'x.md'; }, /MECHANISM_REGISTER_FIELD:contract_ref\.path/],
    ['contract_ref.sha256', (d) => { d.contract_ref.sha256 = SHA_A; }, /MECHANISM_REGISTER_FIELD:contract_ref\.sha256/],
    ['id 写法', (d) => { d.mechanisms[0].mechanism_id = 'sel.kline'; }, /MECHANISM_REGISTER_ID_FORMAT/],
    ['前缀与层不符', (d) => { d.mechanisms[0].layer = 'RISK'; }, /MECHANISM_REGISTER_LAYER_PREFIX/],
    ['层不在四个可登记层里', (d) => { d.mechanisms[0].layer = 'DIAGNOSTIC'; }, /MECHANISM_REGISTER_LAYER_PREFIX/],
    ['决策点', (d) => { d.mechanisms[0].decision_point = 'TIMING'; }, /MECHANISM_REGISTER_DECISION_POINT/],
    ['一句话不换行', (d) => { d.mechanisms[0].description_zh = '一\n二'; }, /MECHANISM_REGISTER_FIELD:mechanisms\[0\]\.description_zh/],
    ['机制 id 重复', (d) => { d.mechanisms[2].mechanism_id = d.mechanisms[0].mechanism_id; d.mechanisms[2].layer = 'SELECTION_TIMING'; }, /MECHANISM_REGISTER_DUPLICATE/],
    ['parent 未登记', (d) => { d.mechanisms[1].parent = 'SEL.NOPE.NOPE'; }, /MECHANISM_REGISTER_PARENT/],
    ['parent 成环', (d) => { d.mechanisms[0].parent = 'SEL.KLINE_VETO.AT_LEVEL_STRICT'; }, /MECHANISM_REGISTER_PARENT_CYCLE/],
    ['entry 市场', (d) => { d.entries[0].market = 'A股'; }, /MECHANISM_REGISTER_MARKET/],
    ['entry 引用未登记的机制', (d) => { d.entries[0].mechanism_ids = ['SEL.NOPE.NOPE']; }, /MECHANISM_REGISTER_UNKNOWN_ID/],
    ['entry 机制为空', (d) => { d.entries[0].mechanism_ids = []; }, /MECHANISM_REGISTER_FIELD:entries\[0\]\.mechanism_ids/],
    ['item_id + market 重复', (d) => { d.entries[1].item_id = 'A01'; }, /MECHANISM_REGISTER_DUPLICATE/],
    ['reason_zh 不写节号', (d) => { d.entries[0].reason_zh = '没有节号'; }, /MECHANISM_REGISTER_FIELD:entries\[0\]\.reason_zh/],
    ['verdict 未知', (d) => { d.entries[0].conclusion.verdict = '不做'; }, /MECHANISM_REGISTER_VERDICT/],
    ['功效值与 ge_80 不自洽', (d) => { d.entries[0].conclusion.power.ge_80 = false; }, /MECHANISM_REGISTER_POWER/],
    ['功效越界', (d) => { d.entries[0].conclusion.power.value = 1.2; }, /MECHANISM_REGISTER_POWER/],
    ['功效缺来源', (d) => { delete d.entries[0].conclusion.power.source_zh; }, /MECHANISM_REGISTER_POWER/],
    ['窗口颠倒', (d) => { d.entries[0].conclusion.data_window = { from: '2026-01-02', to: '2025-01-01' }; }, /MECHANISM_REGISTER_WINDOW/],
    ['窗口晚于封存', (d) => { d.entries[0].conclusion.data_window.to = '2026-11-02'; }, /MECHANISM_REGISTER_WINDOW/],
    ['封存 sha', (d) => { d.entries[0].conclusion.seal_sha256 = 'abc'; }, /MECHANISM_REGISTER_FIELD:entries\[0\]\.conclusion\.seal_sha256/],
    ['不做不带状态', (d) => { d.entries[0].conclusion.state = { live: true, as_of: '2026-11-01' }; }, /MECHANISM_REGISTER_STATE/],
    ['sealed_ref 写法', (d) => { d.entries[0].conclusion.sealed_ref = 'CN-PVS-2'; }, /MECHANISM_REGISTER_SEALED_REF/],
  ];
  for (const [label, patch, code] of cases) {
    const d = JSON.parse(JSON.stringify(good));
    patch(d);
    assert.throws(() => mech.validate(d), code, label);
  }
  // 证据不足要写影子状态，有支持证据要写上线状态
  const insufficient = doc([concluded('A01', { verdict: 'DO_INSUFFICIENT' })]);
  assert.throws(() => mech.validate(insufficient), /MECHANISM_REGISTER_STATE/);
  const supportedWrong = doc([concluded('A01', { verdict: 'DO_SUPPORTED', state: { shadow_running: true, as_of: '2026-11-01' } })]);
  assert.throws(() => mech.validate(supportedWrong), /MECHANISM_REGISTER_STATE/);
  assert.doesNotThrow(() => mech.validate(doc([concluded('A01', { verdict: 'DO_SUPPORTED', state: { live: false, as_of: '2026-11-01' } })])));
  // 功效读不到：value 与 ge_80 都写 null（按 < 80% 处理）；只有 MDE80 时 value = null、ge_80 有值
  assert.doesNotThrow(() => mech.validate(doc([concluded('A01', { power: { value: null, ge_80: null } })])));
  assert.doesNotThrow(() => mech.validate(doc([concluded('A01', { power: { value: null, ge_80: true } })])));
  // 窗口可缺（新数据记 UNKNOWN）
  assert.doesNotThrow(() => mech.validate(doc([concluded('A01', { window: null })])));
});

// ── 2. 与 QRP 封存结论交叉核对 ─────────────────────────────────────────────────

test('交叉核对：写了 sealed_ref 的结论与 QRP 封存结论 ENTRIES 的 sha256、封存日、做 / 不做一致；不一致就报错', () => {
  assert.doesNotThrow(() => mech.crossCheck(mech.REGISTER));
  const sealed = [{ id: 'CN-SYN-1', kind: 'RESULT', sealed_on: '2026-11-01', file: { sha256: SHA_A }, expect: '不做' },
    { id: 'CN-SYN-2', kind: 'RESULT', sealed_on: '2026-11-02', file: { sha256: SHA_B }, expect: 'INSUFFICIENT', resolve: { INSUFFICIENT: { decision: '做' } } },
    { id: 'CN-SYN-3', kind: 'DRAFT', sealed_on: '2026-11-02', file: { sha256: SHA_C }, expect: '做' }];
  const sources = { ASHARE_SEALED_VERDICTS: sealed, OVERSEAS_SEALED_VERDICTS: [] };
  const ok = mech.validate(doc([concluded('A01', { extra: { sealed_ref: 'ASHARE_SEALED_VERDICTS:CN-SYN-1' } }),
    concluded('A02', { verdict: 'DO_INSUFFICIENT', state: { shadow_running: true, as_of: '2026-11-02' }, sealedOn: '2026-11-02', seal: SHA_B, extra: { sealed_ref: 'ASHARE_SEALED_VERDICTS:CN-SYN-2' } })]));
  assert.doesNotThrow(() => mech.crossCheck(ok, sources));
  const bad = (patch, code) => assert.throws(() => mech.crossCheck(mech.validate(doc([concluded('A01', { extra: { sealed_ref: 'ASHARE_SEALED_VERDICTS:CN-SYN-1' }, ...patch })])), sources), code);
  bad({ seal: SHA_B }, /MECHANISM_REGISTER_SEALED_REF_MISMATCH:A01\/CN_A:seal_sha256/);
  bad({ sealedOn: '2026-11-03' }, /MECHANISM_REGISTER_SEALED_REF_MISMATCH:A01\/CN_A:sealed_on/);
  bad({ verdict: 'DO_SUPPORTED', state: { live: true, as_of: '2026-11-01' } }, /MECHANISM_REGISTER_SEALED_REF_MISMATCH:A01\/CN_A:decision/);
  assert.throws(() => mech.crossCheck(mech.validate(doc([concluded('A01', { extra: { sealed_ref: 'ASHARE_SEALED_VERDICTS:CN-NOPE' } })])), sources), /MECHANISM_REGISTER_SEALED_REF_NOT_FOUND/);
  assert.throws(() => mech.crossCheck(mech.validate(doc([concluded('A01', { seal: SHA_C, sealedOn: '2026-11-02', extra: { sealed_ref: 'ASHARE_SEALED_VERDICTS:CN-SYN-3' } })])), sources), /MECHANISM_REGISTER_SEALED_REF_NOT_RESULT/);
});

// ── 3. 路由表（§4.3） ───────────────────────────────────────────────────────────

test('路由：§4.3 表的每一行，加上冻结审阅 E9 补的两种落空情况', () => {
  const r = (entry, opts) => ask([entry], opts).route;
  assert.equal(r(concluded('A01')), 'NOT_DO_SETTLED');
  assert.equal(r(concluded('A01'), { marks: [mark({ from: '2026-10-01', to: '2026-11-09', label: 'UNSEEN' })] }), 'NORMAL_CITE_PRIOR');
  assert.equal(r(concluded('A01', { power: { value: 0.6, ge_80: false } })), 'NORMAL_STATE_DIFFERENCE');
  assert.equal(r(concluded('A01', { power: { value: null, ge_80: null } })), 'NORMAL_STATE_DIFFERENCE');
  assert.equal(r(concluded('A01', { verdict: 'DO_INSUFFICIENT', state: { shadow_running: true, as_of: '2026-11-10' } })), 'ATTACH_TO_SHADOW');
  assert.equal(r(concluded('A01', { verdict: 'DO_INSUFFICIENT', state: { shadow_running: false, as_of: '2026-11-10' } })), 'NORMAL_CITE_PRIOR');
  assert.equal(r(concluded('A01', { verdict: 'DO_SUPPORTED', state: { live: true, as_of: '2026-11-10' } })), 'QUARTERLY_ABLATION');
  assert.equal(r(concluded('A01', { verdict: 'DO_SUPPORTED', state: { live: false, as_of: '2026-11-10' } })), 'NORMAL_CITE_PRIOR');
  assert.equal(r(inProgress('A02')), 'NORMAL_NO_PRIOR');
  assert.equal(ask([]).route, 'NORMAL_NO_PRIOR');
  // 「不做（已判）」引用封存 sha；中文读数只是分诊读数
  const settled = ask([concluded('A01')]);
  assert.deepEqual(settled.cite_seal_sha256, [SHA_A]);
  assert.match(settled.route_zh, /不做（已判）/);
  assert.equal(settled.production_effect, 'NONE');
});

test('新数据：三种来源各自触发；窗口内的 UNSEEN 不算；后写的 SEEN 覆盖 UNSEEN 不算；窗口缺失 = UNKNOWN', () => {
  const prior = concluded('A01');
  const nd = (marks, entries = [prior]) => ask(entries, { marks }).by_id[0];
  // (1) UNSEEN 段跨出先前窗口一天就算；完全落在窗口内不算；别的族也算（同市场）
  assert.equal(nd([mark({ from: '2025-01-01', to: '2026-09-28', label: 'UNSEEN' })]).prior.new_data.state, 'NO');
  const out1 = nd([mark({ from: '2025-01-01', to: '2026-09-29', label: 'UNSEEN' })]);
  assert.equal(out1.prior.new_data.state, 'YES');
  assert.equal(out1.prior.new_data.reasons[0].kind, 'UNSEEN');
  assert.equal(nd([mark({ family: 'INDEX_BOOK', from: '2020-01-01', to: '2020-12-31', label: 'UNSEEN' })]).prior.new_data.state, 'YES');
  // 别的市场不算
  assert.equal(nd([mark({ family: 'US_V5_ETF_3000USD', market: 'US_EQUITY', from: '2026-10-01', to: '2026-11-09', label: 'UNSEEN' })]).prior.new_data.state, 'NO');
  // 后写的 SEEN 覆盖先写的 UNSEEN（trial-ledger segmentsFor 的读法）
  assert.equal(nd([mark({ from: '2026-10-01', to: '2026-11-09', label: 'UNSEEN', at: '2026-11-01T00:00:00+08:00' }),
    mark({ from: '2026-10-01', to: '2026-11-09', label: 'SEEN', at: '2026-11-02T00:00:00+08:00' })]).prior.new_data.state, 'NO');
  // as_of 之后才登记的标签不算
  assert.equal(nd([mark({ from: '2026-10-01', to: '2026-11-09', label: 'UNSEEN', at: '2026-11-21T00:00:00+08:00' })]).prior.new_data.state, 'NO');
  // (2) FORWARD_READ 晚于窗口
  const fr = nd([mark({ from: '2026-10-01', to: '2026-11-09', label: 'FORWARD_READ', shadow: 'SHADOW-X' })]);
  assert.equal(fr.prior.new_data.state, 'YES');
  assert.equal(fr.prior.new_data.reasons[0].kind, 'FORWARD_READ');
  assert.equal(nd([mark({ from: '2025-10-01', to: '2026-09-28', label: 'FORWARD_READ', shadow: 'SHADOW-X' })]).prior.new_data.state, 'NO');
  // (3) 更晚封存的结论：它成为先前结论；较早那条记 LATER_CONCLUSION
  const later = concluded('A03', { verdict: 'DONT', sealedOn: '2026-11-12', seal: SHA_B, window: { from: '2024-01-02', to: '2026-11-07' } });
  const both = ask([prior, later]).by_id[0];
  assert.equal(both.prior.item_id, 'A03');
  assert.equal(both.conclusions[0].new_data.state, 'YES');
  assert.deepEqual(both.conclusions[0].new_data.reasons.map((x) => x.kind), ['LATER_CONCLUSION']);
  // 窗口缺失
  const unknown = ask([concluded('A01', { window: null })]);
  assert.equal(unknown.by_id[0].prior.new_data.state, 'UNKNOWN');
  assert.equal(unknown.route, 'NORMAL_CITE_PRIOR');
});

test('边界：功效恰好 0.80 关闭、0.7999 不关；别的市场的同 id 结论不参与；读过的段标签照台账读法列出', () => {
  assert.equal(ask([concluded('A01', { power: { value: 0.8, ge_80: true } })]).route, 'NOT_DO_SETTLED');
  assert.equal(ask([concluded('A01', { power: { value: 0.7999, ge_80: false } })]).route, 'NORMAL_STATE_DIFFERENCE');
  const other = ask([concluded('U01', { market: 'US_EQUITY', family: 'US_V5_ETF_3000USD' })]);
  assert.equal(other.route, 'NORMAL_NO_PRIOR');
  assert.deepEqual(other.by_id[0].conclusions, []);
  // 加密两种写法按同一市场比
  const crypto1 = ask([concluded('C01', { market: 'CRYPTO', family: 'C17_V2_4000USDT' })], { market: 'CRYPTO_USDM_PERP',
    marks: [mark({ family: 'C17_V2_4000USDT', market: 'CRYPTO_USDM_PERP', from: '2026-10-01', to: '2026-11-09', label: 'UNSEEN' })] });
  assert.equal(crypto1.query.market, 'CRYPTO');
  assert.equal(crypto1.route, 'NORMAL_CITE_PRIOR');
  // 段标签：没标的日期按台账读法当 SEEN
  const seg = ask([concluded('A01')], { marks: [mark({ from: '2024-01-02', to: '2024-06-30', label: 'UNSEEN', at: '2026-11-01T00:00:00+08:00' })] });
  assert.deepEqual(seg.by_id[0].prior.segments_read, ['UNSEEN', 'SEEN']);
  assert.throws(() => ask([], { market: 'HK' }), /MECHANISM_QUERY_MARKET/);
  assert.throws(() => ask([], { ids: ['SEL.NOPE.NOPE'] }), /MECHANISM_ID_NOT_REGISTERED/);
  assert.throws(() => ask([], { ids: [] }), /MECHANISM_QUERY_IDS/);
  assert.throws(() => ask([], { asOf: '2026-11-20T10:00:00Z' }), /MECHANISM_QUERY_AS_OF/);
});

test('多条结论、多个 id、父子 id、Owner 点名（冻结审阅 E5、E6、E7、E10）', () => {
  // E5：最晚一条决定；同一天按登记表顺序
  const dontOld = concluded('A01', { sealedOn: '2026-11-01' });
  const shadowNew = concluded('A03', { verdict: 'DO_INSUFFICIENT', state: { shadow_running: true, as_of: '2026-11-12' }, sealedOn: '2026-11-12', seal: SHA_B, window: { from: '2024-01-02', to: '2026-11-07' } });
  assert.equal(ask([dontOld, shadowNew]).route, 'ATTACH_TO_SHADOW');
  assert.equal(ask([shadowNew, dontOld]).route, 'ATTACH_TO_SHADOW');
  const sameDayA = concluded('A04', { sealedOn: '2026-11-12', seal: SHA_B, window: { from: '2024-01-02', to: '2026-11-07' } });
  const sameDayB = concluded('A05', { sealedOn: '2026-11-12', seal: SHA_C, window: { from: '2024-01-02', to: '2026-11-07' }, power: { value: 0.5, ge_80: false } });
  assert.equal(ask([sameDayA, sameDayB]).by_id[0].prior.item_id, 'A05');
  assert.equal(ask([sameDayB, sameDayA]).by_id[0].prior.item_id, 'A04');
  // E6：两个 id 都关闭才关闭；去向不同 → NORMAL_MIXED；结果按 id 排序，与输入顺序无关
  const twoSettled = [concluded('A01'), concluded('A06', { ids: ['RISK.MARKET_STATE.DIRECTION_SWITCH'], seal: SHA_B })];
  const ids = ['SEL.KLINE_VETO.AT_LEVEL', 'RISK.MARKET_STATE.DIRECTION_SWITCH'];
  assert.equal(ask(twoSettled, { ids }).route, 'NOT_DO_SETTLED');
  assert.deepEqual(ask(twoSettled, { ids }).cite_seal_sha256, [SHA_A, SHA_B].sort());
  const mixed = ask([concluded('A01')], { ids });
  assert.equal(mixed.route, 'NORMAL_MIXED');
  assert.deepEqual(mixed.by_id.map((x) => [x.mechanism_id, x.route]), [['RISK.MARKET_STATE.DIRECTION_SWITCH', 'NORMAL_NO_PRIOR'], ['SEL.KLINE_VETO.AT_LEVEL', 'NOT_DO_SETTLED']]);
  assert.deepEqual(ask([concluded('A01')], { ids: [...ids].reverse() }), mixed);
  // 一条 entry 带两个 id：两个 id 各自都看得到它
  const dual = ask([concluded('A07', { ids })], { ids });
  assert.equal(dual.route, 'NOT_DO_SETTLED');
  // E7：父 id 上的结论只列为相关，不参与子 id 的路由
  const child = ask([concluded('A01')], { ids: ['SEL.KLINE_VETO.AT_LEVEL_STRICT'] });
  assert.equal(child.route, 'NORMAL_NO_PRIOR');
  assert.deepEqual(child.by_id[0].related.map((x) => [x.item_id, x.mechanism_ids]), [['A01', ['SEL.KLINE_VETO.AT_LEVEL']]]);
  const parent = ask([concluded('A08', { ids: ['SEL.KLINE_VETO.AT_LEVEL_STRICT'] })]);
  assert.equal(parent.route, 'NORMAL_NO_PRIOR');
  assert.equal(parent.by_id[0].related.length, 1);
  // E10：Owner 点名 → 永远正常分诊，列表照附
  const named = ask([concluded('A01')], { ownerNamed: true });
  assert.equal(named.route, 'NORMAL_OWNER_NAMED');
  assert.equal(named.by_id[0].route, 'NORMAL_OWNER_NAMED', '每个 id 的去向也是正常分诊');
  assert.equal(named.by_id[0].conclusions.length, 1);
  assert.deepEqual(named.cite_seal_sha256, []);
  // 在研的同 id 题列出、不影响路由
  const wip = ask([concluded('A01'), inProgress('A09')]);
  assert.equal(wip.route, 'NOT_DO_SETTLED');
  assert.deepEqual(wip.by_id[0].in_progress.map((x) => x.item_id), ['A09']);
});

// ── 4. 确定性与只读 ────────────────────────────────────────────────────────────

test('确定性：同输入同字节；登记表 sha256 与提交写进表；不写数据目录', () => {
  const dataDir = process.env.QRP_DATA_DIR;
  const before = fs.readdirSync(dataDir, { recursive: true });
  const marks = [mark({ from: '2026-10-01', to: '2026-11-09', label: 'UNSEEN' })];
  const regBytes = bytesOf(doc([concluded('A01')]));
  const t1 = mech.query({ mechanism_ids: ['SEL.KLINE_VETO.AT_LEVEL'], market: 'CN_A' }, { registerBytes: regBytes, registerCommit: 'f'.repeat(40), marks, asOf: AS_OF });
  const t2 = mech.query({ mechanism_ids: ['SEL.KLINE_VETO.AT_LEVEL'], market: 'CN_A' }, { registerBytes: Buffer.from(regBytes), registerCommit: 'f'.repeat(40), marks: [...marks], asOf: AS_OF });
  assert.equal(mech.tableBytes(t1).toString(), mech.tableBytes(t2).toString());
  assert.equal(t1.schema, 'MECHANISM_PRIOR_TABLE_V1');
  assert.equal(t1.register.sha256, sha(regBytes));
  assert.equal(t1.register.commit, 'f'.repeat(40));
  assert.deepEqual(t1.marks_used, [{ mark_id: marks[0].mark_id, record_hash: marks[0].record_hash }]);
  assert.ok(mech.tableBytes(t1).toString().endsWith('\n'));
  assert.deepEqual(fs.readdirSync(dataDir, { recursive: true }), before);
  // 默认读本机试验台账的标签（只读）
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'TEST_MECH_AUTHORITY';
  trials.markSegments({ family_id: 'ASHARE_V6_PAPER', market: 'CN_A', from: '2026-10-01', to: '2026-11-09', label: 'UNSEEN', reason: '合成' }, { registeredBy: 'TEST_MECH_AUTHORITY', registeredAt: '2026-11-10T10:00:00+08:00' });
  const fromLedger = mech.query({ mechanism_ids: ['SEL.KLINE_VETO.AT_LEVEL'], market: 'CN_A' }, { registerBytes: regBytes, asOf: AS_OF });
  assert.equal(fromLedger.route, 'NORMAL_CITE_PRIOR');
  assert.equal(fromLedger.marks_used.length, 1);
});

// ── 5. 命令行 ──────────────────────────────────────────────────────────────────

test('命令行：输出 MECHANISM_PRIOR_TABLE_V1；未知参数、缺参数、--register-commit 指向的文件与表一致', () => {
  // 空数据目录：上一个测试在本进程的台账里写过标签，命令行不该读到它
  const emptyData = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-mech-data-'));
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, QRP_DATA_DIR: emptyData } });
  const bad = run(['--mechanism-id', 'SEL.KLINE_VETO.AT_LEVEL', '--market', 'CN_A', '--as-of', AS_OF, '--nope', 'x']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /UNKNOWN_FLAG:nope/);
  const missing = run(['--mechanism-id', 'SEL.KLINE_VETO.AT_LEVEL', '--market', 'CN_A']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /MISSING_FLAG:as-of/);
  // 合成仓库：登记表在某个提交里；--register-commit 从那个提交读
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-mech-repo-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();
  git('init', '-q');
  const rel = 'config/research_mechanism_register.v1.json';
  fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
  const regBytes = bytesOf(doc([concluded('A01')]));
  fs.writeFileSync(path.join(repo, rel), regBytes);
  git('add', '.'); git('commit', '-q', '-m', 'r');
  const commit = git('rev-parse', 'HEAD');
  const outFile = path.join(repo, 'table.json');
  const ok = run(['--mechanism-id', 'SEL.KLINE_VETO.AT_LEVEL', '--market', 'CN_A', '--as-of', AS_OF, '--register-commit', commit, '--repo', repo, '--out', outFile]);
  assert.equal(ok.status, 0, ok.stderr);
  const table = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(table.route, 'NOT_DO_SETTLED');
  assert.equal(table.register.commit, commit);
  assert.equal(table.register.sha256, sha(regBytes));
  assert.match(ok.stdout, new RegExp(sha(fs.readFileSync(outFile))));
  // 同样的输入，直接调用得到逐字节相同的表
  const direct = mech.query({ mechanism_ids: ['SEL.KLINE_VETO.AT_LEVEL'], market: 'CN_A' }, { registerBytes: regBytes, registerCommit: commit, marks: [], asOf: AS_OF });
  assert.equal(fs.readFileSync(outFile, 'utf8'), mech.tableBytes(direct).toString());
});
