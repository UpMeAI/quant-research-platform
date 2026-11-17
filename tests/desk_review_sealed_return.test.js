'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const returns = require('../services/desk-review-routing/return');
const sealed = require('../services/desk-review-routing/sealed');
const overseas = require('../services/overseas-sealed-verdicts');
const ashare = require('../services/ashare-sealed-verdicts');
/** R-XM-1 门的裁定页（R_XM_1_IMPORT_GATES_RULING_1，协调会话冻结）的 sha256。 */
const RXM1_RULING_SHA = '09ecea27d21fccc63a5c22b621c64763926b4bdd83159ae5833d0bc3355efa9a';
const { validateRecord } = require('../schemas');
const schema = require('./_json_schema');

const RETURN_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'desk-schemas', 'qrp-research-return.v1.schema.json'), 'utf8'));
const AUTH = 'TEST_SEALED_AUTHORITY';
const AT = '2026-11-10T03:00:00.000Z';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();

function repoWith(files) {
  const repo = tmp('qrp-sealed-repo-');
  git(repo, 'init', '-q');
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seal');
  return { repo, commit: git(repo, 'rev-parse', 'HEAD') };
}
const CONCLUSION_MD = '# 结论\n\n## 0. 结论\n\n**做。** 读数满足判法。\n\n**按冻结页要求必须写的一句：判法在读数之后改过。** 后文。\n';

function fixture({ x08Spy = '不做', x08Expect = 'V2_SPY:不做', dState = '通过（无 F1、无 F2）' } = {}) {
  const sfFiles = {
    'a.json': `${JSON.stringify({ verdict: { decision: '不做', evidence_strength: '无候选；功效约 7%' } })}\n`,
    'b.json': `${JSON.stringify({ decision: { US_V5: '不做（无候选）' } })}\n`,
    'c.json': `${JSON.stringify({ verdict: { state: 'INSUFFICIENT', reasons: ['CI'] } })}\n`,
    'x08.json': `${JSON.stringify({ final: { V1: { verdict: 'INSUFFICIENT-R2', action: 'UNDECIDED' }, V2_SPY: { verdict: 'DIP_FAIL', action: x08Spy }, V2_SPMO: { verdict: 'INSUFFICIENT-R2', action: 'UNDECIDED' }, V3_E_V: { verdict: 'INSUFFICIENT-R2', action: 'UNDECIDED' }, V3_E_S: { verdict: 'INSUFFICIENT-R2', action: 'UNDECIDED' } } })}\n`,
    'shadow.md': '# shadow\n',
    'd.json': `${JSON.stringify({ verdicts: [{ verdict: '不做', evidence: null }] })}\n`,
  };
  const sf = repoWith(sfFiles);
  const v6Files = { 'r.json': `${JSON.stringify({ decisions: { '510300.SH': { decision: '不做', reasons: ['BELOW_ZERO', 'BELOW_C'] } } })}\n` };
  const v6 = repoWith(v6Files);
  const art = tmp('qrp-sealed-art-');
  fs.writeFileSync(path.join(art, 'CONCLUSION.md'), CONCLUSION_MD);
  const s = (rel) => ({ source: 'smartflow', commit: sf.commit, path: rel, sha256: sha(sfFiles[rel]), ref: `smartflow@x:${rel}` });
  const common = { kind: 'RESULT', sealed_on: '2026-11-04', label_zh: 'T', title_zh: '题', k2: null, freeze: null };
  const entries = [
    { ...common, id: 'T-A', strategy_ref: 'C17_V2_4000USDT', file: s('a.json'), read: { decision: 'verdict.decision', strength: 'verdict.evidence_strength', use: null, text: null }, expect: '不做' },
    { ...common, id: 'T-B', strategy_ref: 'US_V5_ETF_3000USD', file: s('b.json'), read: { decision: 'decision.US_V5', state: 'decision.US_V5', strength: null, use: null, text: null }, expect: '不做（无候选）' },
    { ...common, id: 'T-C', strategy_ref: 'US_CORE_9000USD_3X_GATEOBS', file: s('c.json'), read: { decision: 'verdict.state', strength: 'verdict.reasons', use: null, text: null }, expect: 'INSUFFICIENT', resolve: { INSUFFICIENT: { decision: '做', use_zh: '纸面' } } },
    { ...common, id: 'UC-X08', strategy_ref: 'US_CORE_9000USD_3X_GATEOBS', file: s('x08.json'), read: { final: 'final' }, expect: x08Expect },
    { ...common, id: 'T-SHADOW', kind: 'STATUS', strategy_ref: 'US_V5_ETF_3000USD', file: s('shadow.md'), status_zh: '前向影子运行中' },
    // 导入规格修订 4：文件对「通过」不写状态字，登记表的 state_zh 补上
    { ...common, id: 'T-D', strategy_ref: 'QUICK_SHOT_V3_1000USDT', file: s('d.json'), read: { decision: 'verdicts.0.verdict', strength: 'verdicts.0.evidence' }, expect: '不做', ...(dState ? { state_zh: dState } : {}) },
  ];
  const a = (rel) => ({ source: 'ashare-v6', commit: v6.commit, path: rel, sha256: sha(v6Files[rel]), ref: `Ashare-V6@x:${rel}` });
  const ashareEntries = [
    { ...common, id: 'CN-T', strategy_ref: 'INDEX_BOOK', file: a('r.json'), read: { decision: ['decisions', '510300.SH', 'decision'], state: ['decisions', '510300.SH', 'reasons'], strength: null, use: null, text: null }, expect: '不做' },
    { ...common, id: 'CN-MD', strategy_ref: 'ASHARE_V6_PAPER', file: { source: 'coordinator', path: 'CONCLUSION.md', sha256: sha(CONCLUSION_MD), ref: 'artifacts/coordinator/CONCLUSION.md' }, read: { pattern: '^\\*\\*(做|不做)。\\*\\*', strength_pattern: '按冻结页要求必须写的一句：(.+?)\\*\\*' }, expect: '做' },
  ];
  const stores = [
    { market: null, store: overseas.STORE, entries, locks: () => overseas.locks() },
    { market: 'CN', store: ashare.STORE, entries: ashareEntries, locks: () => ashare.locks() },
  ];
  return { sf, v6, art, entries, ashareEntries, stores };
}
function imported(fx = fixture()) {
  const out = tmp('qrp-sealed-ev-');
  overseas.stageEvidence({ smartflowRoot: fx.sf.repo, artifactsRoot: fx.art, out, entries: fx.entries });
  overseas.importVerdicts(out, { registeredBy: AUTH, entries: fx.entries });
  const aOut = tmp('qrp-sealed-aev-');
  ashare.stageEvidence({ ashareV6Root: fx.v6.repo, artifactsRoot: fx.art, out: aOut, entries: fx.ashareEntries });
  ashare.importVerdicts(aOut, { registeredBy: AUTH, entries: fx.ashareEntries });
  return { ...fx, out, aOut };
}

test.beforeEach(() => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  delete process.env[returns.SEALED_SWITCH];
  for (const ledger of [overseas.LEDGER(), ashare.LEDGER()]) fs.rmSync(ledger, { force: true });
  overseas.clearCache();
});

test('默认关闭：不带这一块，来源仍是四本账，hash 与显式关闭相同；只有开关等于 1 才打开', () => {
  imported();
  const off = returns.buildReturn({ generatedAt: AT });
  assert.equal(Object.hasOwn(off, 'sealedVerdicts'), false);
  assert.deepEqual(off.sources.map((s) => s.ledger), returns.LEDGERS);
  assert.equal(off.hash, returns.buildReturn({ generatedAt: AT, sealedVerdicts: false }).hash);
  assert.deepEqual(schema.validate(RETURN_SCHEMA, off), []);
  process.env[returns.SEALED_SWITCH] = '0';
  assert.equal(returns.sealedEnabled(), false);
  process.env[returns.SEALED_SWITCH] = '1';
  assert.equal(returns.sealedEnabled(), true);
});

test('打开：只有 RESULT；结论只有做 / 不做，INSUFFICIENT 记做且状态保留；限定语留在 verdictState；符合 desk schema', () => {
  const fx = imported();
  const payload = returns.buildReturn({ generatedAt: AT, sealedVerdicts: true, sealedStores: fx.stores });
  assert.deepEqual(schema.validate(RETURN_SCHEMA, payload), []);
  assert.deepEqual(payload.sources.map((s) => s.ledger).slice(4), sealed.LEDGERS);
  const by = Object.fromEntries(payload.sealedVerdicts.map((r) => [r.id.replace(/^.*?-(T-[A-Z]+|CN-[A-Z]+|UC-X08)-[0-9a-f]{12}/, '$1'), r]));
  assert.deepEqual([by['T-A'].verdict, by['T-A'].verdictState, by['T-A'].market, by['T-A'].book], ['不做', '无候选；功效约 7%', 'CRYPTO', 'C17_V2_4000USDT']);
  assert.deepEqual([by['T-B'].verdict, by['T-B'].verdictState, by['T-B'].market], ['不做', '不做（无候选）', 'US']);
  assert.deepEqual([by['T-C'].verdict, by['T-C'].verdictState], ['做', 'INSUFFICIENT']);
  assert.deepEqual([by['T-D'].verdict, by['T-D'].verdictState, by['T-D'].market], ['不做', '通过（无 F1、无 F2）', 'CRYPTO']);
  assert.deepEqual([by['CN-T'].verdict, by['CN-T'].verdictState, by['CN-T'].market, by['CN-T'].book, by['CN-T'].resultFile], ['不做', 'BELOW_ZERO、BELOW_C', 'CN', 'INDEX_BOOK', 'Ashare-V6:r.json']);
  assert.deepEqual([by['CN-MD'].verdict, by['CN-MD'].verdictState, by['CN-MD'].commit, by['CN-MD'].resultFile], ['做', '判法在读数之后改过。', null, 'artifacts/coordinator/CONCLUSION.md']);
  assert.equal(payload.sealedVerdicts.some((r) => r.id.includes('SHADOW')), false, '前向影子不进这一块');
  assert.ok(payload.sealedVerdicts.every((r) => r.origin === 'QRP_PROGRAM' && r.deskLink === null));
  assert.deepEqual(payload.decisions, returns.buildReturn({ generatedAt: AT }).decisions, '不写采用记录');
});

test('修订 4：文件没有状态字、登记表也没写 state_zh → 拒绝导出（RETURN_SEALED_STATE_MISSING），不写空状态', () => {
  const fx = imported(fixture({ dState: null }));
  assert.throws(() => returns.buildReturn({ generatedAt: AT, sealedVerdicts: true, sealedStores: fx.stores }), /RETURN_SEALED_STATE_MISSING:T-D/);
});

test('修订 8 §4：UC-X08 三行按裁定，两条 V3 不进；文件与裁定不符就拒绝导出', () => {
  const fx = imported();
  const rows = sealed.sealedRows({ stores: fx.stores }).filter((r) => r.id.includes('UC-X08'));
  assert.deepEqual(rows.map((r) => [r.id.split(':')[1], r.verdict, r.verdictState]), [['V1', '做', '未判定（转前向）'], ['V2_SPMO', '做', '未判定（转前向）'], ['V2_SPY', '不做', 'DIP_FAIL']]);
  fs.rmSync(overseas.LEDGER());
  const other = imported(fixture({ x08Spy: 'UNDECIDED', x08Expect: 'V1:UNDECIDED' }));
  assert.throws(() => sealed.sealedRows({ stores: other.stores }), /RETURN_SEALED_LINE_NOT_AS_RULED/);
});

test('封存文件漂移：拒绝导出，不跳过', () => {
  const fx = imported();
  const lock = overseas.locks().find((l) => l.entry_id === 'T-A');
  fs.appendFileSync(lock.file_ref, ' ');
  assert.throws(() => returns.buildReturn({ generatedAt: AT, sealedVerdicts: true, sealedStores: fx.stores }), /SHA256_MISMATCH/);
});

test('回链：有 desk 回链才写 REVIEW_CANDIDATE，没有就是 null', () => {
  const fx = imported();
  const lock = overseas.locks().find((l) => l.entry_id === 'T-A');
  const link = { link_id: 'RRL-1', desk_candidate_ref: 'RLC-US-2026W42-1', desk_evidence_ref: 'portfolio-desk:docs/review-loop/research-queue/REVIEW_LOOP_RESEARCH_QUEUE_2026-W43.json#RQK-d8fdad6a84b9c984', result_ref: `QRP:${lock.result_id}:LOCKED`, result_hash: null };
  const rows = sealed.sealedRows({ stores: fx.stores, links: [link] });
  const linked = rows.filter((r) => r.deskLink);
  assert.deepEqual(linked.map((r) => [r.id, r.origin, r.deskLink]), [[lock.result_id, 'REVIEW_CANDIDATE', { candidateId: 'RLC-US-2026W42-1', questionKey: 'RQK-d8fdad6a84b9c984', linkId: 'RRL-1' }]]);
});

test('A 股导入：锁模式登记；幂等重放；非完成权威拒绝；sha256 不符拒绝；期望结论不符拒绝', () => {
  const fx = fixture();
  const out = tmp('qrp-sealed-a-');
  ashare.stageEvidence({ ashareV6Root: fx.v6.repo, artifactsRoot: fx.art, out, entries: fx.ashareEntries });
  const rows = ashare.importVerdicts(out, { registeredBy: AUTH, entries: fx.ashareEntries });
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(validateRecord(row), { ok: true, problems: [] });
  assert.equal(rows[0].ashare_v6_commit, fx.v6.commit);
  assert.match(rows[0].result_id, /^ASV-CN-T-[0-9a-f]{12}$/);
  const before = fs.readFileSync(ashare.LEDGER());
  assert.ok(ashare.importVerdicts(out, { registeredBy: AUTH, entries: fx.ashareEntries }).every((r) => r.replayHit));
  assert.deepEqual(fs.readFileSync(ashare.LEDGER()), before);
  assert.throws(() => ashare.importVerdicts(out, { registeredBy: 'SOMEONE', entries: fx.ashareEntries }), /NOT_AUTHORIZED/);
  const badSha = [{ ...fx.ashareEntries[0], file: { ...fx.ashareEntries[0].file, sha256: 'a'.repeat(64) } }];
  assert.throws(() => ashare.stageEvidence({ ashareV6Root: fx.v6.repo, artifactsRoot: fx.art, out: tmp('qrp-sealed-b-'), entries: badSha }), /STAGE_SHA256_MISMATCH/);
  const wrong = [{ ...fx.ashareEntries[1], expect: '不做' }];
  const out2 = tmp('qrp-sealed-c-');
  ashare.stageEvidence({ ashareV6Root: fx.v6.repo, artifactsRoot: fx.art, out: out2, entries: wrong });
  fs.rmSync(ashare.LEDGER());
  assert.throws(() => ashare.importVerdicts(out2, { registeredBy: AUTH, entries: wrong }), /VERDICT_NOT_AS_REGISTERED/);
});

test('A 股修订 1：PVS-2 / PVS-4 从同一份结果文档 §0 各自那一行读出「做」与状态；K2 在 11-11 之前冻结，试验台账门不适用', () => {
  const gates = require('../services/trial-ledger/gates');
  // PVS_2_4_RESULT_V1.md（1cbfe175…）§0 的两行，逐字照抄
  const markdown = ["| 题 | 判定 | 结论 | 规则 |", "| **PVS-2** `A_PVS2_VOLUME_ON_A` 对 `A`（量能增量） | 工具报 `BLOCKED(G1_COUNTER_UNREADABLE)`，按裁定 1 读作 **G1_NOT_MET → INSUFFICIENT** | **做 = 前向记录**（已过惰性诊断：评估过、从未在能起作用的地方成立 = 真惰性，§3.3） | 照 PVS-1 同款：前向一年仍 0 个改变的决策 → 转「不做（惰性）」 |", "| **PVS-4** `A_PVS4_BREAKOUT_QUALITY_ON_A` 对 `A`（价位成交分布，用途 (b)） | 同上，读作 **G1_NOT_MET → INSUFFICIENT** | **做 = 前向记录**；不另建账本、不加账户层影子（同 A_V6_R1_RESULT_V1 对 PVS-1/3/5 的做法） | 前向记录照已有记录器的形状；冻结页 R4-8 已预期「证据不足 → 做」 |"].join('\n');
  for (const [id, other] of [['CN-PVS-2', 'CN-PVS-4'], ['CN-PVS-4', 'CN-PVS-2']]) {
    const entry = ashare.ENTRIES.find((e) => e.id === id);
    const got = overseas.internals.readVerdict(entry, { markdown });
    assert.equal(got.decision, entry.expect, id);
    assert.match(got.strength, /G1_NOT_MET → INSUFFICIENT/, id);
    assert.deepEqual(gates.applies(entry), { applies: false, reason: 'FROZEN_BEFORE_AMENDMENT' }, id);
    assert.equal(entry.trial_gates_ruling, undefined, id);
    // 只读自己那一行：去掉自己那一行后读不出结论（不会读到另一题）
    const tag = id.replace('CN-', '');
    const without = markdown.split('\n').filter((l) => !l.startsWith(`| **${tag}**`)).join('\n');
    assert.throws(() => overseas.internals.readVerdict(entry, { markdown: without }), /VERDICT_FIELD_MISSING/, `${id} vs ${other}`);
  }
});

test('A 股修订 2：行业 ETF 左侧埋伏从封存 JSON 的 verdict.state 读 INSUFFICIENT → 做；K2 在 11-11 之后冻结，两道门都过，运行日志按 sha256 绑定', () => {
  const gates = require('../services/trial-ledger/gates');
  const entry = ashare.ENTRIES.find((e) => e.id === 'CN-SECTOR-ETF-LEFT-1');
  // result-sector-etf-left-1.json（77067969…）的 verdict，逐字照抄
  const doc = { verdict: { pair: 'g(L_LEFT_AMBUSH − CASH)', g: 0.0202, ci95: [0.0031, 0.0434], days: 1759, months: 87, closedEpisodes: 12, g1Min: 30, state: 'INSUFFICIENT', reason: 'G1_NOT_MET', conclusion: '做 = 前向影子' } };
  const got = overseas.internals.readVerdict(entry, doc);
  assert.equal(got.raw, entry.expect);
  assert.equal(got.decision, '做');
  assert.match(got.strength, /INSUFFICIENT（G1_NOT_MET）/);
  assert.match(got.use, /前向影子/);
  // 别的状态不会读成「做」：导入时 VERDICT_NOT_AS_REGISTERED
  for (const state of ['SUPPORTED', 'NOT_PASSED']) assert.notEqual(overseas.internals.readVerdict(entry, { verdict: { ...doc.verdict, state } }).raw, entry.expect, state);
  assert.deepEqual(gates.applies(entry), { applies: true, reason: 'FROZEN_AFTER_AMENDMENT' });
  assert.equal(entry.trial_gates_ruling, undefined);
  const roles = overseas.internals.boundFiles(entry).map((f) => f.role);
  assert.deepEqual(roles, ['FILE', 'K2', 'FREEZE', 'RUN_LOG']);
  assert.equal(entry.strategy_ref, 'INDEX_BOOK');
});

test('A 股修订 3：X07a 从封存 JSON 的 verdict.code 读 DO_INSUFFICIENT → 做（无收紧候选）；冻结后登记按门的裁定，运行日志、两页记录按 sha256 绑定', () => {
  const gates = require('../services/trial-ledger/gates');
  const entry = ashare.ENTRIES.find((e) => e.id === 'CN-X07A');
  // X07A_ASHARE_KELLY_RESULT_V1.json（b2159735…）的 verdict 与 part2.reading，逐字照抄
  const doc = { verdict: { code: 'DO_INSUFFICIENT', zh: '做（证据不足）', candidate: null }, part2: { reading: 'F2' } };
  const got = overseas.internals.readVerdict(entry, doc);
  assert.equal(got.raw, entry.expect);
  assert.equal(got.decision, '做');
  assert.match(got.strength, /DO_INSUFFICIENT（F2）/);
  assert.match(got.use, /SHADOW_NOT_APPLICABLE_NO_CANDIDATE/);
  assert.equal(got.text, '做（证据不足）');
  // 别的读数不会读成期望值：导入时 VERDICT_NOT_AS_REGISTERED
  for (const code of ['DO_TIGHTEN', 'DONT']) assert.notEqual(overseas.internals.readVerdict(entry, { ...doc, verdict: { ...doc.verdict, code } }).raw, entry.expect, code);
  assert.deepEqual(gates.applies(entry), { applies: true, reason: 'FROZEN_AFTER_AMENDMENT' });
  assert.deepEqual(entry.trial_gates_ruling.pre.codes, ['PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN']);
  assert.deepEqual(overseas.internals.boundFiles(entry).map((f) => f.role), ['FILE', 'ALSO', 'ALSO', 'K2', 'RUN_LOG', 'RULING']);
  assert.equal(entry.k2.sha256, 'c3533cd9af966a8fb7fd7a9d759bf61e06aad202c451ed0b5f8ab60bda0aac87');
  assert.equal(entry.strategy_ref, 'ASHARE_V6_PAPER');
});

test('A 股修订 4：R8 A 股部分从封存 JSON 的 judged.verdict_zh 读不做（U_G_AT_OR_BELOW_ZERO）；冻结前预登记，PRE 照常过、不带门的裁定；RF1112 两道门不适用，去掉 k2_frozen_at 就拒绝', () => {
  const gates = require('../services/trial-ledger/gates');
  const mech = require('../services/research-mechanism-register/gate');
  const causality = require('../services/causality-gate');
  const entry = ashare.ENTRIES.find((e) => e.id === 'CN-R8');
  assert.ok(entry, 'CN-R8 缺');
  // R8_RESULT.json（cfa6c0cb…）的 judged 判定字段，逐字照抄
  const doc = { judged: { id: 'T_KC_K_VS_B_K', trial_id: 'TRL-fb2aace30e935a98', state: 'NOT_PASSED', reason_code: 'U_G_AT_OR_BELOW_ZERO', verdict_zh: '不做' } };
  const got = overseas.internals.readVerdict(entry, doc);
  assert.equal(got.raw, '不做');
  assert.equal(got.raw, entry.expect);
  assert.equal(got.decision, '不做');
  // 别的读数不会读成期望值：导入时 VERDICT_NOT_AS_REGISTERED
  for (const word of ['做', '做（证据不足）']) assert.notEqual(overseas.internals.readVerdict(entry, { judged: { ...doc.judged, verdict_zh: word } }).raw, entry.expect, word);
  assert.deepEqual(entry.read, { decision: 'judged.verdict_zh', state: 'judged.reason_code', strength: null, use: null, text: null });
  assert.equal(entry.strategy_ref, 'ASHARE_V6_PAPER');
  assert.equal(entry.kind, 'RESULT');
  assert.equal(entry.sealed_on, '2026-11-15');
  assert.equal(entry.file.sha256, 'cfa6c0cbe7bb95b1fe9a27816de9c6ee0aa13650bc44bed139061d242f0acca3');
  assert.equal(entry.file.path, 'R8_X04_KLINE_CHAN_ASHARE_RESULT_V1.json');
  // K2 绑冻结的草稿本身（台账行的 k2_sha256 = 草稿 sha），冻结页另绑
  assert.equal(entry.k2.sha256, '299473b0bfc3ed15c6075459b96f57b257afdefbc69bf64a6b89c660fd8b4f1c');
  assert.equal(entry.freeze.sha256, '4d30527ee89f94753a38501297e6f7b64b2486249f2b8a15d6b5b002aba2b153');
  assert.equal(entry.run_log.sha256, '60e2a6a94038d92661af569803c154f426eb92e54fa61ac5ede33ef51a8f4e16');
  assert.deepEqual(overseas.internals.boundFiles(entry).map((f) => f.role), ['FILE', 'K2', 'FREEZE', 'RUN_LOG']);
  // 过拟合控制修订之后冻结：G-TRIAL 两道门都过；7 行在冻结（22:28:56）前登记，不带门的裁定
  assert.equal(entry.k2_frozen_at, '2026-11-11T22:28:56+08:00');
  assert.deepEqual(gates.applies(entry), { applies: true, reason: 'FROZEN_AFTER_AMENDMENT' });
  assert.equal(entry.trial_gates_ruling, undefined);
  // K2 在 RF1112 生效（2026-11-15T22:47:42+08:00）之前冻结：G-MECH、G-CAUSAL 都不适用（G-CAUSAL N/A: PRE_EFFECTIVE_K2），锁行不加字段
  assert.deepEqual(mech.applies(entry, mech.EFFECTIVE_FROM), { applies: false, reason: 'FROZEN_BEFORE_AMENDMENT' });
  assert.deepEqual(causality.applies(entry), { applies: false, reason: 'FROZEN_BEFORE_AMENDMENT' });
  assert.equal(entry.causality_evidence, undefined);
  assert.equal(entry.causality_ruling, undefined);
  assert.equal(entry.mechanism_prior_table, undefined);
  // 封存在生效日当天、却没写 k2_frozen_at 的拒绝
  const { k2_frozen_at: _drop, ...bare } = entry;
  assert.throws(() => gates.applies(bare), /K2_FROZEN_AT_MISSING/);
  assert.throws(() => mech.applies(bare, mech.EFFECTIVE_FROM), /MECHANISM_GATE_K2_FROZEN_AT_MISSING/);
  assert.throws(() => causality.applies(bare), /CAUSALITY_K2_FROZEN_AT_MISSING/);
});

test('A 股修订 5：R21 两条判定 RN、RP 各自从封存 JSON 的 judged.J_RN / judged.J_RP 的 state 读 INSUFFICIENT → 做（前向影子）；冻结后、首次计算前登记，PRE 带门的裁定；RF1112 两道门不适用，去掉 k2_frozen_at 就拒绝', () => {
  const gates = require('../services/trial-ledger/gates');
  const mech = require('../services/research-mechanism-register/gate');
  const causality = require('../services/causality-gate');
  // R21_RESULT.json（9db6f7e8…）的 judged 判定字段，逐字照抄
  const doc = { judged: {
    J_RN: { id: 'J_RN', trial_id: 'TRL-858263e5a0d9c0cc', state: 'INSUFFICIENT', reason_code: 'G1_NOT_MET', verdict_zh: '做 = 前向影子' },
    J_RP: { id: 'J_RP', trial_id: 'TRL-2381abff3b49543c', state: 'INSUFFICIENT', reason_code: 'G1_NOT_MET', verdict_zh: '做 = 前向影子' } } };
  for (const [id, pair] of [['CN-R21-RN', 'J_RN'], ['CN-R21-RP', 'J_RP']]) {
    const entry = ashare.ENTRIES.find((e) => e.id === id);
    assert.ok(entry, `${id} 缺`);
    const got = overseas.internals.readVerdict(entry, doc);
    assert.equal(got.raw, 'INSUFFICIENT');
    assert.equal(got.raw, entry.expect);
    assert.equal(got.decision, '做');
    assert.match(got.strength, /G1_NOT_MET/);
    assert.match(got.use, /前向影子/);
    assert.match(got.use, /R21_FORWARD_SHADOW_RULE_V1/);
    assert.equal(got.text, '做 = 前向影子');
    // 别的读数不会读成期望值：导入时 VERDICT_NOT_AS_REGISTERED
    for (const state of ['SUPPORTED', 'NOT_PASSED', 'BLOCKED']) {
      assert.notEqual(overseas.internals.readVerdict(entry, { judged: { ...doc.judged, [pair]: { ...doc.judged[pair], state } } }).raw, entry.expect, `${id}:${state}`);
    }
    assert.deepEqual(entry.read, { decision: `judged.${pair}.state`, strength: `judged.${pair}.reason_code`, use: null, text: `judged.${pair}.verdict_zh` });
    assert.equal(entry.strategy_ref, 'ASHARE_V6_PAPER');
    assert.equal(entry.kind, 'RESULT');
    assert.equal(entry.sealed_on, '2026-11-16');
    assert.equal(entry.file.sha256, '9db6f7e8d31c08d5d6e8e13c67875bfd86cb21b1b5e03443217757f6e51d74c0');
    assert.equal(entry.file.path, 'R21_ASHARE_TIMING_SCORE_MISSING_WEIGHT_RESULT_V1.json');
    // K2 绑冻结页本身（台账行的 k2_sha256 = 冻结页 ca036b24），不另绑冻结页
    assert.equal(entry.k2.sha256, 'ca036b246ade25d498dd3695fb1ac20ae3df438a11b8b2df53df7817c574b6a6');
    assert.equal(entry.freeze, null);
    assert.equal(entry.run_log.sha256, '1ebfe73c0aeb0f1e66264309c55a3846ae5140915efc28ba7e714c1c2cdd0461');
    assert.deepEqual(overseas.internals.boundFiles(entry).map((f) => f.role), ['FILE', 'K2', 'RUN_LOG', 'RULING']);
    // 过拟合控制修订之后冻结：G-TRIAL 两道门都过；3 行在冻结（01:56:13）后 3 分 19 秒、首次计算（02:03:43）前登记，PRE 带门的裁定
    assert.equal(entry.k2_frozen_at, '2026-11-14T01:56:13+08:00');
    assert.deepEqual(gates.applies(entry), { applies: true, reason: 'FROZEN_AFTER_AMENDMENT' });
    assert.deepEqual(entry.trial_gates_ruling.pre.codes, ['PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN']);
    assert.equal(entry.trial_gates_ruling.pre.preregistered_at, '2026-11-13T17:59:32.399Z');
    assert.equal(entry.trial_gates_ruling.pre.first_run_at, '2026-11-13T18:03:43Z');
    assert.equal(entry.trial_gates_ruling.disclosure_not_applicable, undefined, 'DSR 照算法算出，PBO 由 overfit.js 自记 NOT_APPLICABLE（CONFIGS_LT_4），不用披露不适用的裁定');
    // K2 在 RF1112 生效（2026-11-15T22:47:42+08:00）之前冻结：G-MECH、G-CAUSAL 都不适用（G-CAUSAL N/A: PRE_EFFECTIVE_K2），锁行不加字段
    assert.deepEqual(mech.applies(entry, mech.EFFECTIVE_FROM), { applies: false, reason: 'FROZEN_BEFORE_AMENDMENT' });
    assert.deepEqual(causality.applies(entry), { applies: false, reason: 'FROZEN_BEFORE_AMENDMENT' });
    assert.equal(entry.causality_evidence, undefined);
    assert.equal(entry.causality_ruling, undefined);
    assert.equal(entry.mechanism_prior_table, undefined);
    // 封存在生效日当天及以后、却没写 k2_frozen_at 的拒绝
    const { k2_frozen_at: _drop, ...bare } = entry;
    assert.throws(() => gates.applies(bare), /K2_FROZEN_AT_MISSING/);
    assert.throws(() => mech.applies(bare, mech.EFFECTIVE_FROM), /MECHANISM_GATE_K2_FROZEN_AT_MISSING/);
    assert.throws(() => causality.applies(bare), /CAUSALITY_K2_FROZEN_AT_MISSING/);
  }
  // 两条共用同一结果、K2、运行日志与门的裁定
  const [rn, rp] = ['CN-R21-RN', 'CN-R21-RP'].map((id) => ashare.ENTRIES.find((e) => e.id === id));
  for (const key of ['file', 'k2', 'run_log']) assert.deepEqual(rn[key], rp[key], key);
  assert.deepEqual(rn.trial_gates_ruling.spec, rp.trial_gates_ruling.spec);
});

test('A 股修订 6：R-XM-1 两题从封存 JSON 的 rows.RXM1_M / rows.RXM1_B 的 verdict 读做 / 不做；K2 冻结在 RF1112、附录 1 与 G-PARITY 之后，五道门都过：G-TRIAL PRE、G-MECH、G-CAUSAL 各带同一页门的裁定（DEVIATION_ACCEPTED），G-COST、G-PARITY 照常', () => {
  const gates = require('../services/trial-ledger/gates');
  const mech = require('../services/research-mechanism-register/gate');
  const causality = require('../services/causality-gate');
  const C = (file, sha) => ({ source: 'coordinator', path: file, sha256: sha });
  const pick = (spec) => ({ source: spec.source, path: spec.path, sha256: spec.sha256 });
  // R_XM_1_ASHARE_IDLE_CASH_RESULT_V1.json（1b277f27…，封存 RXM1_RESULT.json 的逐字节副本）的判定字段，逐字照抄
  const doc = { rows: { RXM1_M: { code: '511880.SH', verdict: '做' }, RXM1_B: { code: '511010.SH', verdict: '不做' } } };
  for (const [id, row, expect] of [['CN-RXM1-M', 'RXM1_M', '做'], ['CN-RXM1-B', 'RXM1_B', '不做']]) {
    const entry = ashare.ENTRIES.find((e) => e.id === id);
    assert.ok(entry, `${id} 缺`);
    const got = overseas.internals.readVerdict(entry, doc);
    assert.equal(got.raw, entry.expect);
    assert.equal(got.decision, expect);
    assert.notEqual(overseas.internals.readVerdict(entry, { rows: { ...doc.rows, [row]: { verdict: expect === '做' ? '不做' : '做' } } }).raw, entry.expect, id);
    assert.deepEqual(entry.read, { decision: `rows.${row}.verdict`, strength: null, use: null, text: null });
    assert.deepEqual([entry.strategy_ref, entry.kind, entry.sealed_on, entry.k2_frozen_at], ['ASHARE_V6_PAPER', 'RESULT', '2026-11-17', '2026-11-17T15:42:02+08:00']);
    assert.deepEqual(pick(entry.file), C('R_XM_1_ASHARE_IDLE_CASH_RESULT_V1.json', '1b277f278a28b0ad10ff422cc75e7f1ff90691e5de9e8ef87317ecb4694e0bea'));
    assert.deepEqual(pick(entry.k2), C('R_XM_1_ASHARE_IDLE_CASH_K2_V1.draft.480ec87f.md', '480ec87fdc39880f1d44e7bd71642b56af1d4af56fb6179c18cf0fc845eb182e'));
    assert.deepEqual(pick(entry.freeze), C('R_XM_1_ASHARE_IDLE_CASH_K2_V1_FREEZE_1.md', '5794f7c3679fcffe21647d9b70e281b09d5b1fe129b5aab465c859151a61c320'));
    assert.deepEqual(entry.k2_notes.map(pick), [C('R_XM_1_ASHARE_IDLE_CASH_K2_V1_FREEZE_1_NOTE_1.md', '4ecde74c33bff06ca39f87264eb42c2536d9ce56bdcf59414d0b94905608b3fb'),
      C('R_XM_1_ASHARE_IDLE_CASH_K2_V1_FREEZE_1_NOTE_2.md', '900d38ccc103346f8e2cba3c164b926cc2eb5f15a94c12edbad372ba5fd91ac9')]);
    assert.deepEqual(pick(entry.run_log), C('R_XM_1_ASHARE_IDLE_CASH_RESEARCH_RUN_LOG_V1.json', '5f253bb3de10ce25fea6bbfd915b9105647ceb9aaa3c09e8efc71ddadeae5bb9'));
    // 封存结果页与 ★R1 裁定页（过拟合门的读法：族方差 V 不用本题自己的行）一并按 sha256 绑定
    assert.deepEqual(entry.also.map(pick), [C('R_XM_1_ASHARE_IDLE_CASH_K2_V1_RESULT.md', 'c13e03fa930a26fe7d9571b2e8aece48c120be066488e3bec145e9271b17a4f3'),
      C('R_XM_1_ASHARE_IDLE_CASH_K2_V1_RESULT_RULING_R1.md', '28bf76ca1c0b845ecb3a7b7008fcbf307369a4732f2fe741071fbb4c53c84e60')]);
    assert.deepEqual(overseas.internals.boundFiles(entry).map((f) => f.role),
      ['FILE', 'ALSO', 'ALSO', 'K2', 'FREEZE', 'K2_NOTE', 'K2_NOTE', 'RUN_LOG', 'RULING', 'MECH_PRIOR', 'MECH_RULING', 'CAUSALITY_RULING']);
    // 三道门都过门，同一页门的裁定（R_XM_1_IMPORT_GATES_RULING_1）
    assert.deepEqual(gates.applies(entry), { applies: true, reason: 'FROZEN_AFTER_AMENDMENT' });
    assert.deepEqual(mech.applies(entry, mech.EFFECTIVE_FROM), { applies: true, reason: 'FROZEN_AFTER_AMENDMENT' });
    assert.deepEqual(causality.applies(entry), { applies: true, reason: 'FROZEN_AFTER_AMENDMENT' });
    const rulings = [entry.trial_gates_ruling.spec, entry.mechanism_ruling.spec, entry.causality_ruling.spec].map(pick);
    assert.deepEqual(rulings[1], rulings[0]);
    assert.deepEqual(rulings[2], rulings[0]);
    assert.equal(rulings[0].sha256, RXM1_RULING_SHA);
    assert.deepEqual(entry.trial_gates_ruling.pre, { status: 'DEVIATION_ACCEPTED', codes: ['PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN'],
      preregistered_at: '2026-11-17T07:48:36.403Z', first_run_at: '2026-11-17T07:54:06.728Z' });
    assert.equal(entry.trial_gates_ruling.disclosure_not_applicable, undefined, 'DSR 照算法算出（OVD-95fd157215597f79、OVD-02f289abe66f0225），不用披露不适用的裁定');
    assert.deepEqual(entry.mechanism_ids, ['ACCT.IDLE_CASH.TBILL_PARKING']);
    assert.deepEqual(pick(entry.mechanism_prior_table), C('R_XM_1_MECHANISM_PRIOR_TABLE_V1.json', '04c4aec8358b7060813bdf379a4bd8dfcb6007964d57640a1478ba02e5f76c97'));
    assert.deepEqual(entry.ai_inputs, []);
    assert.deepEqual(entry.mechanism_ruling.deviations, ['MECHANISM_PRIOR_TABLE_NOT_IN_K2', 'AI_ROLE_K2_LINE4_READ_AS_NONE']);
    assert.equal(entry.mechanism_ruling.line4_text, '无。只用封存回放与实盘账本里抽取的事实。');
    assert.equal(entry.causality_ruling.scope_not_applicable, 'RISK_K_OR_ACCOUNT_LAYER');
    assert.equal(entry.causality_evidence, undefined);
    assert.match(entry.note_zh, /28bf76ca/);
    assert.match(entry.note_zh, /900d38cc/);
  }
  const m = ashare.ENTRIES.find((e) => e.id === 'CN-RXM1-M');
  assert.match(m.note_zh, /不用本题自己的行/);
  assert.match(m.note_zh, /DSR 1/);
  // 两题共用同一结果、K2、运行日志、附注与门的裁定；指数本不出判定，不进登记表
  const b = ashare.ENTRIES.find((e) => e.id === 'CN-RXM1-B');
  for (const key of ['file', 'k2', 'freeze', 'k2_notes', 'run_log', 'also', 'trial_gates_ruling', 'mechanism_prior_table', 'mechanism_ruling', 'causality_ruling']) assert.deepEqual(m[key], b[key], key);
  assert.equal(ashare.ENTRIES.filter((e) => /RXM1/.test(e.id)).length, 2);
});

test('真实登记表：每个 RESULT 的期望结论都能写成做 / 不做（X08 按裁定）；绑定 sha256 合法；A 股没有 Q0 账户', () => {
  for (const entries of [overseas.ENTRIES, ashare.ENTRIES]) {
    const ids = new Set();
    for (const entry of entries) {
      assert.ok(!ids.has(entry.id), entry.id); ids.add(entry.id);
      for (const { spec } of overseas.internals.boundFiles(entry)) assert.match(spec.sha256, /^[0-9a-f]{64}$/, entry.id);
      if (entry.kind !== 'RESULT' || entry.read.final) continue;
      const word = entry.resolve && entry.resolve[entry.expect] ? entry.resolve[entry.expect].decision : entry.expect;
      assert.ok(['做', '不做'].includes(sealed.verdictWord(word, entry.id)), entry.id);
    }
  }
  assert.equal(ashare.ENTRIES.length, 17);
  assert.equal(ashare.ENTRIES.some((entry) => /Q0/i.test(`${entry.id}${entry.file.path}`)), false);
  assert.deepEqual(Object.keys(sealed.X08_LINES).sort(), ['V1', 'V2_SPMO', 'V2_SPY']);
  assert.throws(() => sealed.verdictWord('INSUFFICIENT', 'x'), /RETURN_SEALED_VERDICT_NOT_DO_OR_DONT/);
});
