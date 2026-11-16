'use strict';
/**
 * 回链绑定封存研究结论的锁（linkSealedVerdict，海外导入规格修订 9）：desk 研究队列来的题（DQ-…）还在 PENDING 时，
 * 指向同一 case 的一把封存结论锁；现场复验锁与文件；结论按封存结论词机械映射；回程 sealedVerdicts 的那一行带上 deskLink。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const loop = require('../services/runtime-research-loop');
const overseas = require('../services/overseas-sealed-verdicts');
const sealed = require('../services/desk-review-routing/sealed');
const { validateRecord } = require('../schemas');

const AUTH = 'TEST_LINK_SEALED_AUTHORITY';
const UC = 'US_CORE_9000USD_3X_GATEOBS';
const C17 = 'C17_V2_4000USDT';
const UC_CASE = 'RRC-US-CORE-9000-V8-1-M0';
const C17_CASE = 'RRC-C17-V2-4000USDT-V8-1-M0';
const KEY = 'RQK-d8fdad6a84b9c984';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();
const verdictDoc = (word) => `${JSON.stringify({ part_b: { verdict: { conclusionZh: word, basisZh: '依据' } } })}\n`;
const FILES = { 'role.json': verdictDoc('做（影子）'), 'dont.json': verdictDoc('不做'), 'tight.json': verdictDoc('做（收紧）'), 'shared.json': verdictDoc('做'), 'role2.json': verdictDoc('做（影子）') };

function repo() {
  const dir = tmp('qrp-link-sealed-repo-');
  git(dir, 'init', '-q');
  for (const [rel, body] of Object.entries(FILES)) fs.writeFileSync(path.join(dir, rel), body);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'seal');
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}
const READ = Object.freeze({ decision: 'part_b.verdict.conclusionZh', strength: null, use: 'part_b.verdict.basisZh', text: null });

function fixture() {
  process.env.QRP_DATA_DIR = tmp('qrp-link-sealed-data-');
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  overseas.clearCache();
  const sf = repo();
  const art = tmp('qrp-link-sealed-art-');
  const s = (rel) => ({ source: 'smartflow', commit: sf.commit, path: rel, sha256: sha(FILES[rel]), ref: `smartflow@x:${rel}` });
  const common = { kind: 'RESULT', sealed_on: '2026-10-28', label_zh: 'T', title_zh: '题', k2: null, freeze: null, read: READ };
  const entries = [
    { ...common, id: 'T-ROLE', strategy_ref: UC, file: s('role.json'), expect: '做（影子）' },
    { ...common, id: 'T-DONT', strategy_ref: C17, file: s('dont.json'), expect: '不做' },
    { ...common, id: 'T-TIGHT', strategy_ref: UC, file: s('tight.json'), expect: '做（收紧）' },
    { ...common, id: 'T-S1', strategy_ref: UC, file: s('shared.json'), expect: '做' },
    { ...common, id: 'T-S2', strategy_ref: UC, file: s('shared.json'), expect: '做' },
  ];
  const out = tmp('qrp-link-sealed-ev-');
  overseas.stageEvidence({ smartflowRoot: sf.dir, artifactsRoot: art, out, entries });
  overseas.importVerdicts(out, { registeredBy: AUTH, entries });
  const cases = path.join(process.env.QRP_DATA_DIR, 'runtime-research-loop', 'cases.jsonl');
  fs.mkdirSync(path.dirname(cases), { recursive: true });
  fs.appendFileSync(cases, `${JSON.stringify({ case_id: UC_CASE, strategy_ref: UC })}\n${JSON.stringify({ case_id: C17_CASE, strategy_ref: C17 })}\n`);
  const link = (caseId, candidate, key, question = `DQ-${key}`) => loop.registerReviewQuestion(caseId, {
    desk_candidate_ref: candidate, research_question_ref: question,
    desk_evidence_ref: `portfolio-desk:docs/review-loop/research-queue/REVIEW_LOOP_RESEARCH_QUEUE_2026-W43.json#${key}`, desk_evidence_hash: 'a'.repeat(64),
    recorded_at: '2026-10-27T12:08:14.809Z' });
  const stores = [{ market: null, store: overseas.STORE, entries, locks: () => overseas.locks() }];
  const lockOf = (id) => overseas.headLock(id);
  return { sf, art, out, entries, stores, link, lockOf };
}
const bind = (lock) => ({ result_id: lock.result_id, expected_file_sha256: lock.file_sha256 });

test('绑定：PENDING 的 DQ 回链指向同 case 的封存结论锁；result_ref = QRP:<锁>:LOCKED，result_hash = 文件 sha256，做（影子）→ INSUFFICIENT；回程那一行带 deskLink', () => {
  const fx = fixture();
  const l = fx.link(UC_CASE, 'RLC-US-2026W42-1', KEY);
  const lock = fx.lockOf('T-ROLE');
  const before = fs.readFileSync(loop.LINKS_LEDGER());
  const row = loop.linkSealedVerdict(l.link_id, bind(lock), { stores: fx.stores, recorded_at: '2026-11-16T04:00:00.000Z' });
  assert.equal(row.result_ref, `QRP:${lock.result_id}:LOCKED`);
  assert.equal(row.result_hash, sha(FILES['role.json']));
  assert.equal(row.conclusion, 'INSUFFICIENT');
  assert.equal(row.adoption_state, 'NOT_DECIDED');
  assert.equal(row.production_effect, 'NONE');
  assert.equal(row.recorded_at, '2026-11-16T04:00:00.000Z');
  assert.equal(row.link_id, l.link_id);
  assert.equal(row.research_question_ref, `DQ-${KEY}`);
  assert.ok(validateRecord(row, 'RUNTIME_RESEARCH_LINK_V1').ok);
  // 只追加一行，旧字节不变；listLinks 取到的是新行
  const after = fs.readFileSync(loop.LINKS_LEDGER());
  assert.deepEqual(after.subarray(0, before.length), before);
  assert.equal(after.toString().trim().split('\n').length, before.toString().trim().split('\n').length + 1);
  assert.equal(loop.listLinks().find((x) => x.link_id === l.link_id).result_hash, row.result_hash);
  // 重放：同一绑定不再写
  assert.equal(loop.linkSealedVerdict(l.link_id, bind(lock), { stores: fx.stores }).replayHit, true);
  assert.equal(fs.readFileSync(loop.LINKS_LEDGER()).length, after.length);
  // 回程 sealedVerdicts：只有这一题带 deskLink，来源记 REVIEW_CANDIDATE
  const rows = sealed.sealedRows({ links: loop.listLinks(), stores: fx.stores });
  const mine = rows.find((r) => r.id === lock.result_id);
  assert.deepEqual(mine.deskLink, { candidateId: 'RLC-US-2026W42-1', questionKey: KEY, linkId: l.link_id });
  assert.equal(mine.origin, 'REVIEW_CANDIDATE');
  assert.equal(mine.verdict, '做');
  for (const r of rows.filter((x) => x.id !== lock.result_id)) assert.equal(r.deskLink, null, r.id);
});

test('dry run：返回将写的行，账本不动', () => {
  const fx = fixture();
  const l = fx.link(UC_CASE, 'RLC-US-2026W42-1', KEY);
  const before = fs.readFileSync(loop.LINKS_LEDGER());
  const row = loop.linkSealedVerdict(l.link_id, bind(fx.lockOf('T-ROLE')), { stores: fx.stores, dryRun: true });
  assert.equal(row.dryRun, true);
  assert.equal(row.conclusion, 'INSUFFICIENT');
  assert.deepEqual(fs.readFileSync(loop.LINKS_LEDGER()), before);
});

test('结论词机械映射：不做 → FAIL；表外的词（做（收紧））拒绝', () => {
  const fx = fixture();
  const c = fx.link(C17_CASE, 'RLC-CRYPTO-2026W43-1', 'RQK-1111111111111111');
  assert.equal(loop.linkSealedVerdict(c.link_id, bind(fx.lockOf('T-DONT')), { stores: fx.stores }).conclusion, 'FAIL');
  const u = fx.link(UC_CASE, 'RLC-US-2026W43-2', 'RQK-2222222222222222');
  assert.throws(() => loop.linkSealedVerdict(u.link_id, bind(fx.lockOf('T-TIGHT')), { stores: fx.stores }), /LOOP_RESULT_VERDICT_UNSUPPORTED/);
});

test('拒绝：hash 不符、锁不存在、case 不同、不是 DQ 题、文件被多把锁共用、回链已指向别的结果、锁已被取代、文件漂移', () => {
  const fx = fixture();
  const l = fx.link(UC_CASE, 'RLC-US-2026W42-1', KEY);
  const lock = fx.lockOf('T-ROLE');
  const run = (linkId, binding) => () => loop.linkSealedVerdict(linkId, binding, { stores: fx.stores });
  assert.throws(run(l.link_id, { ...bind(lock), expected_file_sha256: 'b'.repeat(64) }), /LOOP_RESULT_HASH_MISMATCH/);
  assert.throws(run(l.link_id, { result_id: 'OSV-NOPE-000000000000', expected_file_sha256: lock.file_sha256 }), /LOOP_LOCK_NOT_FOUND/);
  assert.throws(run(l.link_id, { result_id: lock.result_id }), /LOOP_LOCK_BINDING_MISSING:expected_file_sha256/);
  assert.throws(run('RRL-0000000000000000', bind(lock)), /LOOP_LINK_NOT_FOUND/);
  const c17 = fx.link(C17_CASE, 'RLC-CRYPTO-2026W43-1', 'RQK-1111111111111111');
  assert.throws(run(c17.link_id, bind(lock)), /LOOP_LOCK_CASE_MISMATCH/);
  const merged = fx.link(UC_CASE, 'RLC-US-2026W43-3', 'RQK-3333333333333333', 'Q2');
  assert.throws(run(merged.link_id, bind(lock)), /LOOP_RESEARCH_QUESTION_MISMATCH/);
  assert.throws(run(l.link_id, bind(fx.lockOf('T-S1'))), /LOOP_SEALED_FILE_SHARED/);
  // 已绑定：同一绑定重放，别的结果拒绝
  loop.linkSealedVerdict(l.link_id, bind(lock), { stores: fx.stores });
  assert.throws(run(l.link_id, bind(fx.lockOf('T-TIGHT'))), /LOOP_LINK_ALREADY_RESULT_LINKED/);
  // 取代：同题换文件按 supersede 再导入，旧锁不能再绑
  const fresh = fx.link(UC_CASE, 'RLC-US-2026W43-4', 'RQK-4444444444444444');
  const entries2 = fx.entries.map((e) => (e.id === 'T-ROLE' ? { ...e, file: { ...e.file, path: 'role2.json', sha256: sha(FILES['role2.json']) }, rev: 2 } : e));
  const out2 = tmp('qrp-link-sealed-ev2-');
  overseas.stageEvidence({ smartflowRoot: fx.sf.dir, artifactsRoot: fx.art, out: out2, entries: entries2 });
  overseas.importVerdicts(out2, { registeredBy: AUTH, entries: entries2, supersedes: { 'T-ROLE': lock.result_id }, defectRef: 'D', reason: 'R' });
  const stores2 = [{ ...fx.stores[0], entries: entries2 }];
  assert.throws(() => loop.linkSealedVerdict(fresh.link_id, bind(lock), { stores: stores2 }), /LOOP_LOCK_SUPERSEDED/);
  // 文件漂移：锁指向的证据文件被改，现场复验失败即关
  const dont = fx.link(C17_CASE, 'RLC-CRYPTO-2026W43-5', 'RQK-5555555555555555');
  const dLock = fx.lockOf('T-DONT');
  fs.writeFileSync(dLock.file_ref, verdictDoc('做'));
  assert.throws(() => loop.linkSealedVerdict(dont.link_id, bind(dLock), { stores: fx.stores }), /OVERSEAS_VERDICT_SHA256_MISMATCH/);
});
