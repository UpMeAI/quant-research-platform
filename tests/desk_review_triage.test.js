'use strict';
/**
 * desk 复盘闭环修订 7（2026-10-27 冻结 FREEZE_1，D1–D3、D7、D10 ★a）QRP 一侧：Research 分诊账本 RESEARCH_TRIAGE_V1、记录命令、
 * 回程 triage[]、状态词、只给研究类建回链、复盘镜像根。全部在临时数据目录与临时 desk 根里跑；desk 夹具是合成的，不含真实复盘事实。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('./_env');
const schema = require('./_json_schema');
const routing = require('../services/desk-review-routing');
const triage = require('../services/desk-review-routing/triage');
const returns = require('../services/desk-review-routing/return');
const { contentHash } = require('../services/desk-review-routing/canonical');

const ROOT = path.join(__dirname, '..');
const RETURN_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'desk-schemas', 'qrp-research-return.v1.schema.json'), 'utf8'));
const QUEUE_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'desk-schemas', 'review-loop-research-queue.v1.schema.json'), 'utf8'));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const AT = '2000-01-18T10:00:00+08:00';
const COMMIT = 'c'.repeat(40);
const REPO = { kind: 'REPO', repo: 'portfolio-desk', path: 'docs/X.md', commit: COMMIT, clause: '§1' };
const FILE = { kind: 'FILE', file: 'smartflow_crypto/review/PARITY.json', hash: 'f'.repeat(64), path: '$.state' };

const writeJson = (file, payload) => { fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`); return fs.readFileSync(file); };
function makeDesk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-desk-triage-'));
  fs.mkdirSync(path.join(root, routing.QUEUE_DIR), { recursive: true });
  return root;
}
function entry(candidateId, candidateType, { triageState = 'PENDING', dueBy = '2000-01-24T02:30:00.000Z', choice = null, triggerIds = ['F12'], weeks = ['2000-W01'], ledgerId = 'TEST_BOOK_C' } = {}) {
  const research = ['PARAMETER', 'RULE'].includes(candidateType);
  return {
    questionKey: `RQK-${sha(candidateId).slice(0, 16)}`, candidateId, market: candidateId.split('-')[1], ledgerId, roleId: null, triggerIds,
    findings: weeks.map((weekId, i) => ({ findingId: `RLF-${weekId.replace('-', '')}-${i + 1}`, weekId, triggerId: triggerIds[0], fact: '合成事实', evidence: [{ contract: 'FIXTURE', file: 'fixture.json', hash: 'e'.repeat(64), path: '$.x' }] })),
    firstWeek: weeks[0], weeksSeen: weeks.length, candidateType, ruleRef: research ? [{ ref: 'FIXTURE_RULE@v1', effectiveFrom: '2026-10-01', source: 'ACCEPTANCE' }] : [],
    versionSegmentId: null, effect: { value: null, unit: 'USD', basis: '合成', state: 'NOT_MEASURED', reasonCode: 'FIXTURE' },
    sample: { n: 1, unit: 'EVENTS', floor: 1, state: 'AT_OR_ABOVE_FLOOR' }, questionZh: research ? '合成题：这条规则是否按设计生效？' : null,
    ownerPick: { choice, ownerWords: choice ? '合成原话' : null, at: choice ? '2000-01-10T10:00:00+08:00' : null, weekId: choice ? '2000-W02' : null, revision: choice ? 1 : null },
    deskState: choice ? 'PICKED' : 'OPEN', mergedInto: null, qrpHint: null,
    triage: { state: choice ? 'OWNER_DECIDED' : triageState, dueBy: choice ? null : dueBy, outcome: null, reasonCode: null, questionRef: null, mergedInto: null, fixRef: null, recordId: null, recordHash: null },
  };
}
function writeQueue(root, weekId, entries) {
  const weekFile = `REVIEW_LOOP_WEEK_${weekId}.json`;
  const week = { schemaVersion: 1, contract: 'REVIEW_LOOP_WEEK_V1', producer: 'COORDINATOR', weekId, revision: 0, fixture: true };
  week.hash = contentHash(week);
  const weekBytes = writeJson(path.join(root, routing.WEEK_DIR, weekFile), week);
  const payload = {
    schemaVersion: 1, contract: 'REVIEW_LOOP_RESEARCH_QUEUE_V1', producer: 'COORDINATOR', weekId, revision: 0, generatedAt: '2000-01-17T02:30:00Z',
    sourceWeek: { file: weekFile, sha256: sha(weekBytes), hash: week.hash }, routes: 'REVIEW_LOOP_DEFAULT_ROUTES@v1', entries,
    interpretation: 'RESEARCH_INTAKE_FACTS_NOT_ORDERS', realOrder: 0, brokerWrite: false,
  };
  payload.hash = contentHash(payload);
  const file = `REVIEW_LOOP_RESEARCH_QUEUE_${weekId}.json`;
  return { file, sha256: sha(writeJson(path.join(root, routing.QUEUE_DIR, file), payload)), payload };
}
const reset = () => fs.rmSync(triage.LEDGER(), { force: true });
const ENTRIES = () => [
  entry('RLC-CN-2000W01-1', 'DATA', { ledgerId: 'TEST_BOOK_A' }),
  entry('RLC-CN-2000W01-2', 'DATA', { triggerIds: ['F21'], weeks: ['2000-W01', '2000-W02'], ledgerId: 'TEST_BOOK_B' }),
  entry('RLC-US-2000W01-1', 'RULE', { triggerIds: ['F17'], weeks: ['2000-W01', '2000-W02'], ledgerId: 'TEST_RULE_BOOK' }),
  entry('RLC-CRYPTO-2000W01-1', 'DATA'),
  entry('RLC-CRYPTO-1999W52-1', 'EXECUTION', { choice: 'RESEARCH' }),
];
const record = (desk, over) => triage.recordTriage({ outcome: 'CLOSE', evidence: [], basisZh: '依据见所引文件（合成）', at: AT, ...over }, { deskRoot: desk });

test('Q1：判不做带登记码与证据才记；码未登记、证据缺、不在队列、结果与类型不配、不在待分诊、依据有指令词，一律拒收且不写', () => {
  reset();
  const desk = makeDesk();
  writeQueue(desk, '2000-W03', ENTRIES());
  const row = record(desk, { candidateId: 'RLC-CRYPTO-2000W01-1', reasonCode: 'AS_DESIGNED', evidence: [REPO] });
  assert.match(row.record_id, /^RTR-[0-9a-f]{16}$/);
  assert.deepEqual([row.outcome, row.reason_code, row.queue_file, row.recorded_by, row.production_effect], ['CLOSE', 'AS_DESIGNED', 'REVIEW_LOOP_RESEARCH_QUEUE_2000-W03.json', 'RESEARCH', 'NONE']);
  // record_hash 是 desk 回程行（去掉 recordId、recordHash）的 deep-sorted hash：desk 侧可复算
  const { recordId, recordHash, ...body } = triage.deskRow(row);
  assert.equal(recordHash, contentHash(body));
  assert.equal(recordId, row.record_id);
  const before = fs.readFileSync(triage.LEDGER());
  const refused = [
    [{ candidateId: 'RLC-CN-2000W01-1', reasonCode: 'SAMPLE_TOO_SMALL', evidence: [FILE] }, /TRIAGE_CODE_NOT_REGISTERED/],
    [{ candidateId: 'RLC-CN-2000W01-1', reasonCode: 'ALREADY_FIXED', evidence: [REPO] }, /TRIAGE_EVIDENCE/],
    [{ candidateId: 'RLC-CN-2000W01-1', reasonCode: 'COVERED_BY_QUESTION', evidence: [REPO], mergedInto: 'Q1' }, /TRIAGE_CODE_OUTCOME/],
    [{ candidateId: 'RLC-CN-2099W40-1', reasonCode: 'AS_DESIGNED', evidence: [REPO] }, /TRIAGE_CANDIDATE_NOT_IN_QUEUE/],
    [{ candidateId: 'RLC-CN-2000W01-1', outcome: 'OPEN_QUESTION', questionRef: 'DQ-X' }, /TRIAGE_OUTCOME_TYPE_MISMATCH/],
    [{ candidateId: 'RLC-US-2000W01-1', outcome: 'FIX', fixRef: { repo: 'smartflow', ref: 'x' } }, /TRIAGE_OUTCOME_TYPE_MISMATCH/],
    [{ candidateId: 'RLC-CRYPTO-1999W52-1', reasonCode: 'PARITY_MATCHED', evidence: [FILE] }, /TRIAGE_NOT_PENDING/],
    [{ candidateId: 'RLC-CRYPTO-2000W01-1', reasonCode: 'PARITY_MATCHED', evidence: [FILE] }, /TRIAGE_ALREADY_RECORDED/],
    [{ candidateId: 'RLC-CN-2000W01-1', reasonCode: 'AS_DESIGNED', evidence: [REPO], basisZh: '建议不做' }, /TRIAGE_WORDING/],
    [{ candidateId: 'RLC-CN-2000W01-1', reasonCode: 'AS_DESIGNED', evidence: [REPO], at: '2000-01-18T02:00:00Z' }, /TRIAGE_AT_NOT_BEIJING_TIME/],
    [{ candidateId: 'RLC-US-2000W01-1', reasonCode: 'NO_RECURRENCE', evidence: [{ kind: 'SCAN', weekId: '2000-W03', file: 'scans/x.json', hash: 'a'.repeat(64) }] }, /TRIAGE_NO_RECURRENCE_ON_WEEKLY_TRIGGER/],
    [{ candidateId: 'RLC-CN-2000W01-2', reasonCode: 'NO_RECURRENCE', evidence: [{ kind: 'SCAN', weekId: '2000-W02', file: 'scans/x.json', hash: 'a'.repeat(64) }] }, /TRIAGE_NO_RECURRENCE_SEEN/],
  ];
  for (const [over, want] of refused) assert.throws(() => record(desk, over), want, JSON.stringify(over));
  assert.deepEqual(fs.readFileSync(triage.LEDGER()), before, '拒收的一行都没写');
  // 立题、转修复、并入、改正（supersedes）
  const opened = record(desk, { candidateId: 'RLC-US-2000W01-1', outcome: 'OPEN_QUESTION', questionRef: 'DQ-TEST' });
  assert.deepEqual([opened.question_ref, opened.strategy_ref], ['DQ-TEST', 'TEST_RULE_BOOK']);
  const fix = record(desk, { candidateId: 'RLC-CN-2000W01-1', outcome: 'FIX', fixRef: { repo: 'Ashare-V6', ref: 'claude/equity-points' } });
  assert.deepEqual(fix.fix_ref, { repo: 'Ashare-V6', ref: 'claude/equity-points' });
  const merged = record(desk, { candidateId: 'RLC-CN-2000W01-2', outcome: 'MERGE', reasonCode: 'COVERED_BY_CANDIDATE', mergedInto: 'RLC-CN-2000W01-1' });
  const fixed = record(desk, { candidateId: 'RLC-CN-2000W01-2', outcome: 'CLOSE', reasonCode: 'SUBJECT_RETIRED', evidence: [{ ...REPO, clause: null }], supersedes: merged.record_id });
  assert.deepEqual(triage.effectiveTriage().map((r) => [r.candidate_id, r.outcome]),
    [['RLC-CRYPTO-2000W01-1', 'CLOSE'], ['RLC-US-2000W01-1', 'OPEN_QUESTION'], ['RLC-CN-2000W01-1', 'FIX'], ['RLC-CN-2000W01-2', 'CLOSE']]);
  assert.equal(triage.effectiveTriage().find((r) => r.candidate_id === 'RLC-CN-2000W01-2').record_id, fixed.record_id);
  assert.throws(() => record(desk, { candidateId: 'RLC-CN-2000W01-2', reasonCode: 'AS_DESIGNED', evidence: [REPO], supersedes: merged.record_id }), /TRIAGE_SUPERSEDES_NOT_CURRENT/);
});

test('Q2：只写 QRP 数据目录（var/ 被 .gitignore 忽略）；命令行记一条，git 跟踪的文件不变', () => {
  reset();
  const desk = makeDesk();
  writeQueue(desk, '2000-W03', ENTRIES());
  assert.ok(triage.LEDGER().startsWith(process.env.QRP_DATA_DIR));
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\/?var\/?/m);
  const status = () => spawnSync('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout;
  const before = status();
  const out = spawnSync(process.execPath, [path.join(ROOT, 'apps', 'research-cli', 'record_desk_triage.js'), '--candidate', 'RLC-CN-2000W01-1', '--outcome', 'CLOSE', '--code', 'AS_DESIGNED',
    '--evidence', JSON.stringify([REPO]), '--basis', '契约本来不给这一格出数（合成）', '--at', AT, '--desk-root', desk], { encoding: 'utf8', env: process.env });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).production_effect, 'NONE');
  assert.equal(status(), before);
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'apps', 'research-cli', 'record_desk_triage.js'), '--candidate', 'RLC-CN-2000W01-2', '--outcome', 'CLOSE', '--code', 'NOPE',
    '--basis', 'x', '--at', AT, '--desk-root', desk], { encoding: 'utf8', env: process.env });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /TRIAGE_CODE_NOT_REGISTERED/);
  const list = spawnSync(process.execPath, [path.join(ROOT, 'apps', 'research-cli', 'list_desk_triage.js'), '--desk-root', desk], { encoding: 'utf8', env: process.env });
  assert.equal(list.status, 0, list.stderr);
  assert.match(JSON.parse(list.stdout).text_zh, /^Desk 复盘待分诊 3 条，最早 01-24 到期：/);
});

test('Q3：回程 triage[] 是账本当前有效行，按 desk 契约；hash 稳定；desk schema 副本校验通过', () => {
  reset();
  const desk = makeDesk();
  writeQueue(desk, '2000-W03', ENTRIES());
  record(desk, { candidateId: 'RLC-CRYPTO-2000W01-1', reasonCode: 'PARITY_MATCHED', evidence: [FILE] });
  record(desk, { candidateId: 'RLC-US-2000W01-1', outcome: 'OPEN_QUESTION', questionRef: 'DQ-TEST' });
  const a = returns.buildReturn({ generatedAt: '2000-01-18T03:00:00.000Z' });
  const b = returns.buildReturn({ generatedAt: '2000-01-18T03:00:00.000Z' });
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.triage.map((r) => [r.candidateId, r.outcome, r.reasonCode]), [['RLC-CRYPTO-2000W01-1', 'CLOSE', 'PARITY_MATCHED'], ['RLC-US-2000W01-1', 'OPEN_QUESTION', null]]);
  assert.deepEqual(schema.validate(a, RETURN_SCHEMA), []);
  const queue = routing.readQueue({ deskRoot: desk });
  assert.deepEqual(schema.validate(queue.payload, QUEUE_SCHEMA), [], '工程类候选与 triage 块符合 desk 队列 schema');
  assert.equal(a.triage[0].queueSha256, queue.sha256);
});

test('Q4：状态词——待研究分诊（到期日／已逾期）、研究已立题、并入、研究判不做、转工程修复；Owner 的选择优先', () => {
  const now = new Date('2000-01-20T00:00:00Z');
  const base = entry('RLC-CN-2000W01-1', 'DATA');
  assert.equal(routing.pickWords(base, { now }), '待研究分诊（01-24 前）');
  assert.equal(routing.pickWords(base, { now: new Date('2000-01-26T03:00:00Z') }), '待研究分诊，已逾期 2 天');
  const applied = (outcome, extra) => ({ ...base, triage: { ...base.triage, state: 'APPLIED', dueBy: null, outcome, ...extra } });
  assert.equal(routing.pickWords(applied('OPEN_QUESTION', { questionRef: 'DQ-T' })), '研究已立题 DQ-T，待冻结 K2');
  assert.equal(routing.pickWords(applied('MERGE', { mergedInto: 'RLC-CN-2000W01-2' })), '并入 RLC-CN-2000W01-2');
  assert.equal(routing.pickWords(applied('CLOSE', { reasonCode: 'NO_RECURRENCE' })), '研究判不做：之后的扫描没有再出现');
  assert.equal(routing.pickWords(applied('FIX', { fixRef: { repo: 'smartflow', ref: 'x' } })), '转工程修复（smartflow）');
  assert.equal(routing.pickWords(entry('RLC-CRYPTO-1999W52-1', 'EXECUTION', { choice: 'RESEARCH' })), 'Owner 立研究，待冻结 K2');
});

test('Q5：导入只给研究类建回链；工程类只进分诊清单', () => {
  reset();
  const desk = makeDesk();
  writeQueue(desk, '2000-W03', ENTRIES());
  const summary = routing.importQueue({ deskRoot: desk });
  assert.deepEqual(summary.engineering.map((r) => r.candidateId), ['RLC-CN-2000W01-1', 'RLC-CN-2000W01-2', 'RLC-CRYPTO-2000W01-1', 'RLC-CRYPTO-1999W52-1']);
  assert.deepEqual([...summary.registered, ...summary.unchanged, ...summary.refused].map((r) => r.candidateId), ['RLC-US-2000W01-1']);
  const pending = triage.pendingTriage({ deskRoot: desk, now: new Date('2000-01-20T00:00:00Z') });
  assert.deepEqual(pending.entries.map((e) => e.candidateId), ['RLC-CN-2000W01-1', 'RLC-CN-2000W01-2', 'RLC-US-2000W01-1', 'RLC-CRYPTO-2000W01-1']);
  assert.equal(pending.earliestDue, '2000-01-24T02:30:00.000Z');
});

test('Q6：QRP_DESK_REVIEW_LOOP_ROOT（复盘镜像）优先；没设时回落到 QRP_DESK_ROOT', () => {
  const mirror = makeDesk();
  const checkout = makeDesk();
  writeQueue(mirror, '2000-W03', ENTRIES());
  writeQueue(checkout, '2000-W02', ENTRIES().slice(0, 1));
  const saved = { m: process.env.QRP_DESK_REVIEW_LOOP_ROOT, d: process.env.QRP_DESK_ROOT };
  try {
    process.env.QRP_DESK_ROOT = checkout;
    delete process.env.QRP_DESK_REVIEW_LOOP_ROOT;
    assert.equal(routing.readQueue().payload.weekId, '2000-W02');
    process.env.QRP_DESK_REVIEW_LOOP_ROOT = mirror;
    assert.equal(routing.readQueue().payload.weekId, '2000-W03');
    assert.equal(routing.deskRootOf(), path.resolve(checkout), '策略目录仍读 desk checkout');
  } finally {
    if (saved.m === undefined) delete process.env.QRP_DESK_REVIEW_LOOP_ROOT; else process.env.QRP_DESK_REVIEW_LOOP_ROOT = saved.m;
    if (saved.d === undefined) delete process.env.QRP_DESK_ROOT; else process.env.QRP_DESK_ROOT = saved.d;
  }
});
