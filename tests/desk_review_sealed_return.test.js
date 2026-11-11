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
  assert.equal(ashare.ENTRIES.length, 8);
  assert.equal(ashare.ENTRIES.some((entry) => /Q0/i.test(`${entry.id}${entry.file.path}`)), false);
  assert.deepEqual(Object.keys(sealed.X08_LINES).sort(), ['V1', 'V2_SPMO', 'V2_SPY']);
  assert.throws(() => sealed.verdictWord('INSUFFICIENT', 'x'), /RETURN_SEALED_VERDICT_NOT_DO_OR_DONT/);
});
