'use strict';
/**
 * 机制查询接进 Research 分诊（研究框架修订 2026-11-12 FREEZE_1 E11；desk 码表 @v2 草稿 REVIEW_LOOP_ACCEPTANCE_V1_ADDENDUM_7_CODES_V2，★T1–T5 取 (a)）：
 *   - 码表 RESEARCH_TRIAGE_CODES@v2 = @v1 + MECHANISM_SETTLED（判不做），与 desk 同表；
 *   - 研究类候选在 FREEZE_1 生效之后（按记录时刻）立题，必须带机制查询；读数 NOT_DO_SETTLED 时拒绝立题（Owner 点名除外）；
 *   - 判不做 MECHANISM_SETTLED：QRP 用给定提交的登记表、在分诊时刻重算查询，读数必须是 NOT_DO_SETTLED，证据的表 hash 与登记表提交都要对上；
 *   - 机制读数只记在本机账本行 mechanism_query，回程 triage[] 的字段不变（desk 复算 record_hash 不受影响）。
 * 全部是合成夹具（合成 desk 根、合成登记表、合成标签）。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const routing = require('../services/desk-review-routing');
const triage = require('../services/desk-review-routing/triage');
const mech = require('../services/research-mechanism-register');
const amendment = require('../services/research-framework-amendment-20261112');
const { contentHash } = require('../services/desk-review-routing/canonical');

const ROOT = path.join(__dirname, '..');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const AT = '2026-11-16T10:00:00+08:00';
const AFTER = '2026-11-16T02:00:00.000Z';   // 记录时刻：生效之后
const BEFORE = '2026-11-15T14:00:00.000Z';  // 记录时刻：生效之前（22:00 CST）
const COMMIT = 'a'.repeat(40);
const ID = 'SEL.KLINE_VETO.AT_LEVEL';
const SEAL = 'b'.repeat(64);

// ── 合成 desk 根（同 desk_review_triage.test.js 的形状） ─────────────────────────

const writeJson = (file, payload) => { fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`); return fs.readFileSync(file); };
function makeDesk(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-desk-mech-'));
  fs.mkdirSync(path.join(root, routing.QUEUE_DIR), { recursive: true });
  const weekId = '2026-W46';
  const weekFile = `REVIEW_LOOP_WEEK_${weekId}.json`;
  const week = { schemaVersion: 1, contract: 'REVIEW_LOOP_WEEK_V1', producer: 'COORDINATOR', weekId, revision: 0, fixture: true };
  week.hash = contentHash(week);
  const weekBytes = writeJson(path.join(root, routing.WEEK_DIR, weekFile), week);
  const payload = {
    schemaVersion: 1, contract: 'REVIEW_LOOP_RESEARCH_QUEUE_V1', producer: 'COORDINATOR', weekId, revision: 0, generatedAt: '2026-11-16T02:30:00Z',
    sourceWeek: { file: weekFile, sha256: sha(weekBytes), hash: week.hash }, routes: 'REVIEW_LOOP_DEFAULT_ROUTES@v1', entries,
    interpretation: 'RESEARCH_INTAKE_FACTS_NOT_ORDERS', realOrder: 0, brokerWrite: false,
  };
  payload.hash = contentHash(payload);
  writeJson(path.join(root, routing.QUEUE_DIR, `REVIEW_LOOP_RESEARCH_QUEUE_${weekId}.json`), payload);
  return root;
}
function entry(candidateId, candidateType) {
  const research = ['PARAMETER', 'RULE'].includes(candidateType);
  return {
    questionKey: `RQK-${sha(candidateId).slice(0, 16)}`, candidateId, market: candidateId.split('-')[1], ledgerId: 'TEST_BOOK', roleId: null, triggerIds: ['F12'],
    findings: [{ findingId: 'RLF-2026W46-1', weekId: '2026-W46', triggerId: 'F12', fact: '合成事实', evidence: [{ contract: 'FIXTURE', file: 'fixture.json', hash: 'e'.repeat(64), path: '$.x' }] }],
    firstWeek: '2026-W46', weeksSeen: 1, candidateType, ruleRef: research ? [{ ref: 'FIXTURE_RULE@v1', effectiveFrom: '2026-10-01', source: 'ACCEPTANCE' }] : [],
    versionSegmentId: null, effect: { value: null, unit: 'USD', basis: '合成', state: 'NOT_MEASURED', reasonCode: 'FIXTURE' },
    sample: { n: 1, unit: 'EVENTS', floor: 1, state: 'AT_OR_ABOVE_FLOOR' }, questionZh: research ? '合成题：这条规则是否按设计生效？' : null,
    ownerPick: { choice: null, ownerWords: null, at: null, weekId: null, revision: null }, deskState: 'OPEN', mergedInto: null, qrpHint: null,
    triage: { state: 'PENDING', dueBy: '2026-11-30T02:30:00.000Z', outcome: null, reasonCode: null, questionRef: null, mergedInto: null, fixRef: null, recordId: null, recordHash: null },
  };
}
const RULE = 'RLC-US-2026W46-1';
const DATA = 'RLC-CN-2026W46-1';
const desk = () => makeDesk([entry(RULE, 'RULE'), entry(DATA, 'DATA')]);

// ── 合成登记表 ─────────────────────────────────────────────────────────────────

function registerBytes(conclusions = []) {
  const doc = {
    _comment: '合成夹具', contract: mech.CONTRACT,
    contract_ref: { path: mech.AMENDMENT.path, sha256: `${mech.AMENDMENT.sha_prefix}${'0'.repeat(56)}`, state: mech.AMENDMENT.state,
      texts: mech.AMENDMENT.texts.map((t) => ({ id: t.id, path: t.path, sha256: `${t.sha_prefix}${'0'.repeat(56)}` })), ref_zh: '合成' },
    registered_at: '2026-11-16T00:00:00+08:00', registered_by: '测试',
    mechanisms: [{ mechanism_id: ID, title_zh: '结构位 K 线否决', layer: 'SELECTION_TIMING', decision_point: 'ENTRY', description_zh: '在结构位出现反向 K 线时不入场' }],
    entries: conclusions,
  };
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
}
const DONT_80 = { item_id: 'U01', strategy_ref: 'US_V5_ETF_3000USD', market: 'US_EQUITY', mechanism_ids: [ID], classified_by: 'test', reason_zh: '合成（§4.2）',
  conclusion: { verdict: 'DONT', strength_zh: '合成', power: { value: 0.9, ge_80: true, effect_zh: '判定效应', source_zh: '合成 §3' }, family_id: 'US_V5_ETF_3000USD',
    data_window: { from: '2020-01-02', to: '2026-09-30' }, sealed_on: '2026-11-01', seal_sha256: SEAL } };
const settledRegister = registerBytes([DONT_80]);
const emptyRegister = registerBytes([]);
const registerAt = (bytes) => (commit) => (commit === COMMIT ? bytes : null);
const mechanismOpts = (bytes) => ({ registerAt: registerAt(bytes), marks: [] });
const tableSha = (bytes, over = {}) => sha(mech.tableBytes(mech.query({ mechanism_ids: [ID], market: 'US_EQUITY', owner_named: false, ...over },
  { registerBytes: bytes, registerCommit: COMMIT, marks: [], asOf: AT })));

const reset = () => fs.rmSync(triage.LEDGER(), { force: true });
const base = { basisZh: '依据见所引文件（合成）', at: AT, evidence: [] };
const mechanism = (over = {}) => ({ ids: [ID], market: 'US_EQUITY', registerCommit: COMMIT, ...over });
const prepare = (root, input, { writtenAt = AFTER, bytes = emptyRegister } = {}) =>
  triage.prepareTriage({ ...base, ...input }, { deskRoot: root, existingRows: [], writtenAt, mechanism: mechanismOpts(bytes) });
const PRIOR_FILE = (hash) => ({ kind: 'FILE', file: 'mechanism/MECHANISM_PRIOR_TABLE.json', hash, path: '$.route' });
const REGISTER_REPO = (commit = COMMIT) => ({ kind: 'REPO', repo: 'quant-research-platform', path: mech.REGISTER_PATH, commit, clause: null });

// ── 码表 ──────────────────────────────────────────────────────────────────────

test('码表 @v2：@v1 七个码不变，加 MECHANISM_SETTLED（判不做）；与 desk 草稿同表', () => {
  assert.equal(triage.CODES_VERSION, 'RESEARCH_TRIAGE_CODES@v2');
  assert.deepEqual(Object.keys(triage.CODES_V1).sort(), ['ALREADY_FIXED', 'AS_DESIGNED', 'COVERED_BY_CANDIDATE', 'COVERED_BY_QUESTION', 'NO_RECURRENCE', 'PARITY_MATCHED', 'SUBJECT_RETIRED']);
  assert.deepEqual(Object.keys(triage.CODES).sort(), [...Object.keys(triage.CODES_V1), 'MECHANISM_SETTLED'].sort());
  assert.equal(triage.CODES.MECHANISM_SETTLED, 'CLOSE');
  assert.ok(triage.CODE_ZH.MECHANISM_SETTLED);
  // desk 的研究队列 schema（夹具按 desk #117 更新）列的也是这八个码
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'desk-schemas', 'review-loop-research-queue.v1.schema.json'), 'utf8'));
  const enums = [];
  const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (!n || typeof n !== 'object') return undefined; if (Array.isArray(n.enum) && n.enum.includes('AS_DESIGNED')) enums.push(n.enum.filter((v) => v !== null).sort()); return Object.values(n).forEach(walk); };
  walk(schema);
  assert.deepEqual(enums, [Object.keys(triage.CODES).sort()]);
});

// ── 立题前先查机制（★T1–T3） ───────────────────────────────────────────────────

test('立题：生效之后（按记录时刻）必须带机制查询；生效之前不要求；带了就记 mechanism_query，回程字段不变', () => {
  reset();
  const root = desk();
  assert.throws(() => prepare(root, { candidateId: RULE, outcome: 'OPEN_QUESTION', questionRef: 'DQ-T' }), /TRIAGE_MECHANISM_REQUIRED/);
  // 自报的 at 早于生效也不行：按记录时刻
  assert.throws(() => prepare(root, { candidateId: RULE, outcome: 'OPEN_QUESTION', questionRef: 'DQ-T', at: '2026-11-15T10:00:00+08:00' }), /TRIAGE_MECHANISM_REQUIRED/);
  const old = prepare(root, { candidateId: RULE, outcome: 'OPEN_QUESTION', questionRef: 'DQ-T' }, { writtenAt: BEFORE });
  assert.equal(old.mechanism_query, undefined, '生效之前的行形状不变');
  const row = prepare(root, { candidateId: RULE, outcome: 'OPEN_QUESTION', questionRef: 'DQ-T', mechanism: mechanism() });
  assert.deepEqual(row.mechanism_query, { mechanism_ids: [ID], market: 'US_EQUITY', owner_named: false, register_commit: COMMIT,
    register_sha256: sha(emptyRegister), table_sha256: tableSha(emptyRegister), route: 'NORMAL_NO_PRIOR' });
  // 回程行字段与不带机制时逐项相同；record_hash 仍是 desk 可复算的回程行 hash
  assert.deepEqual(Object.keys(triage.deskRow(row)).sort(), Object.keys(triage.deskRow(old)).sort());
  const { recordId, recordHash, ...body } = triage.deskRow(row);
  assert.equal(recordHash, contentHash(body));
  // 工程类候选不带机制（机制是研究题的效应）
  assert.throws(() => prepare(root, { candidateId: DATA, outcome: 'FIX', fixRef: { repo: 'Ashare-V6', ref: 'x' }, mechanism: mechanism() }), /TRIAGE_MECHANISM_NOT_RESEARCH/);
  assert.doesNotThrow(() => prepare(root, { candidateId: DATA, outcome: 'FIX', fixRef: { repo: 'Ashare-V6', ref: 'x' } }));
});

test('立题：读数 NOT_DO_SETTLED 时拒绝立题；Owner 点名放行；机制没登记、提交找不到、字段不全都拒', () => {
  reset();
  const root = desk();
  const opts = { bytes: settledRegister };
  assert.throws(() => prepare(root, { candidateId: RULE, outcome: 'OPEN_QUESTION', questionRef: 'DQ-T', mechanism: mechanism() }, opts), new RegExp(`TRIAGE_MECHANISM_SETTLED:${RULE}:${SEAL}`));
  const named = prepare(root, { candidateId: RULE, outcome: 'OPEN_QUESTION', questionRef: 'DQ-T', mechanism: mechanism({ ownerNamed: true }) }, opts);
  assert.equal(named.mechanism_query.route, 'NORMAL_OWNER_NAMED');
  assert.equal(named.mechanism_query.owner_named, true);
  // 同机制、别的市场：没有先前结论，照常立题
  assert.equal(prepare(root, { candidateId: RULE, outcome: 'OPEN_QUESTION', questionRef: 'DQ-T', mechanism: mechanism({ market: 'CRYPTO' }) }, opts).mechanism_query.route, 'NORMAL_NO_PRIOR');
  assert.throws(() => prepare(root, { candidateId: RULE, outcome: 'OPEN_QUESTION', questionRef: 'DQ-T', mechanism: mechanism({ ids: ['SEL.NOT.REGISTERED'] }) }, opts), /MECHANISM_ID_NOT_REGISTERED/);
  assert.throws(() => prepare(root, { candidateId: RULE, outcome: 'OPEN_QUESTION', questionRef: 'DQ-T', mechanism: mechanism({ registerCommit: 'd'.repeat(40) }) }, opts), /TRIAGE_MECHANISM_REGISTER_NOT_FOUND/);
  for (const bad of [{ ids: [] }, { market: '' }, { registerCommit: 'abc' }, { ownerNamed: 'yes' }]) {
    assert.throws(() => prepare(root, { candidateId: RULE, outcome: 'OPEN_QUESTION', questionRef: 'DQ-T', mechanism: mechanism(bad) }, opts), /TRIAGE_MECHANISM_INVALID/, JSON.stringify(bad));
  }
});

// ── 判不做 MECHANISM_SETTLED ─────────────────────────────────────────────────

test('判不做 MECHANISM_SETTLED：重算读数是 NOT_DO_SETTLED、表 hash 与登记表提交都对上才记；其余各种都拒', () => {
  reset();
  const root = desk();
  const opts = { bytes: settledRegister };
  const hash = tableSha(settledRegister);
  const good = { candidateId: RULE, outcome: 'CLOSE', reasonCode: 'MECHANISM_SETTLED', mechanism: mechanism(), evidence: [PRIOR_FILE(hash), REGISTER_REPO()] };
  const row = prepare(root, good, opts);
  assert.deepEqual([row.outcome, row.reason_code, row.mechanism_query.route, row.mechanism_query.table_sha256], ['CLOSE', 'MECHANISM_SETTLED', 'NOT_DO_SETTLED', hash]);
  assert.deepEqual(triage.deskRow(row).evidence, [PRIOR_FILE(hash), REGISTER_REPO()]);
  const refused = [
    [{ mechanism: undefined }, /TRIAGE_MECHANISM_REQUIRED/],
    [{ evidence: [PRIOR_FILE('9'.repeat(64)), REGISTER_REPO()] }, /TRIAGE_EVIDENCE:MECHANISM_SETTLED/],
    [{ evidence: [PRIOR_FILE(hash), REGISTER_REPO('d'.repeat(40))] }, /TRIAGE_EVIDENCE:MECHANISM_SETTLED/],
    [{ evidence: [PRIOR_FILE(hash)] }, /TRIAGE_EVIDENCE:MECHANISM_SETTLED/],
    [{ evidence: [PRIOR_FILE(hash), { ...REGISTER_REPO(), path: 'config/research_layer_register.v1.json' }] }, /TRIAGE_EVIDENCE:MECHANISM_SETTLED/],
    [{ mechanism: mechanism({ ownerNamed: true }) }, /TRIAGE_MECHANISM_NOT_SETTLED:NORMAL_OWNER_NAMED/],
    [{ outcome: 'MERGE' }, /TRIAGE_CODE_OUTCOME/],
    [{ candidateId: DATA }, /TRIAGE_MECHANISM_NOT_RESEARCH/],
  ];
  for (const [over, want] of refused) assert.throws(() => prepare(root, { ...good, ...over }, opts), want, JSON.stringify(Object.keys(over)));
  // 登记表里没有不做结论：读数不是 NOT_DO_SETTLED，判不做被拒
  assert.throws(() => prepare(root, { ...good, evidence: [PRIOR_FILE(tableSha(emptyRegister)), REGISTER_REPO()] }, { bytes: emptyRegister }), /TRIAGE_MECHANISM_NOT_SETTLED:NORMAL_NO_PRIOR/);
  // 分诊时刻之后才登记的新数据标签不算（as_of = at）；之前登记的算，读数变成 NORMAL_CITE_PRIOR
  const markBody = { schema: 'DATA_SEGMENT_MARK_V1', mark_id: 'SEG-00000000000000aa', family_id: 'US_V5_ETF_3000USD', market: 'US_EQUITY', from: '2026-10-01', to: '2026-11-09',
    label: 'UNSEEN', seen_kind: null, shadow_ref: null, reason: '合成', source_refs: [], supersedes: null, defect_ref: null, production_effect: 'NONE', registered_by: 'T', record_hash: 'x' };
  const withMark = (registeredAt) => triage.prepareTriage({ ...base, ...good }, { deskRoot: root, existingRows: [], writtenAt: AFTER,
    mechanism: { registerAt: registerAt(settledRegister), marks: [{ ...markBody, registered_at: registeredAt }] } });
  assert.doesNotThrow(() => withMark('2026-11-16T10:00:01+08:00'));
  assert.throws(() => withMark('2026-11-16T09:59:59+08:00'), /TRIAGE_MECHANISM_NOT_SETTLED:NORMAL_CITE_PRIOR/);
});

test('批量分诊带机制字段同样核；整批任一条不过就一条不写', () => {
  reset();
  const root = desk();
  const hash = tableSha(settledRegister);
  const decisions = [
    { ...base, candidateId: RULE, outcome: 'CLOSE', reasonCode: 'MECHANISM_SETTLED', mechanism: mechanism(), evidence: [PRIOR_FILE(hash), REGISTER_REPO()] },
    { ...base, candidateId: DATA, outcome: 'FIX', fixRef: { repo: 'smartflow', ref: 'y' } },
  ];
  const rows = triage.prepareTriageBatch(decisions, { deskRoot: root, writtenAt: AFTER, mechanism: mechanismOpts(settledRegister) });
  assert.deepEqual(rows.map((r) => [r.candidate_id, r.reason_code, r.mechanism_query ? r.mechanism_query.route : null]), [[RULE, 'MECHANISM_SETTLED', 'NOT_DO_SETTLED'], [DATA, null, null]]);
  const bad = [{ ...decisions[0], evidence: [PRIOR_FILE('9'.repeat(64)), REGISTER_REPO()] }, decisions[1]];
  assert.throws(() => triage.recordTriageBatch(bad, { deskRoot: root, writtenAt: AFTER, mechanism: mechanismOpts(settledRegister) }), /TRIAGE_EVIDENCE:MECHANISM_SETTLED/);
  assert.equal(fs.existsSync(triage.LEDGER()), false, '一条都没写');
});

test('命令行：--mechanism-id（可重复）、--market、--register-commit、--owner-named 照传；生效时刻取冻结页常量', () => {
  reset();
  assert.equal(amendment.EFFECTIVE_FROM, '2026-11-15T22:47:42+08:00');
  const root = desk();
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
  const cli = path.join(ROOT, 'apps', 'research-cli', 'record_desk_triage.js');
  const run = (extra) => spawnSync(process.execPath, [cli, '--candidate', RULE, '--outcome', 'OPEN_QUESTION', '--question-ref', 'DQ-T', '--basis', '依据见所引文件（合成）',
    '--at', AT, '--desk-root', root, '--dry-run', ...extra], { encoding: 'utf8', env: process.env });
  // 现在（生效之后）不带机制 → 拒
  assert.match(run([]).stderr, /TRIAGE_MECHANISM_REQUIRED/);
  // 带了：真实登记表（HEAD 那一版，首版为空）里没有这个 id → 查询失败即关，说明字段一路传到了查询
  const out = run(['--mechanism-id', ID, '--mechanism-id', 'RISK.MARKET_STATE.DIRECTION_SWITCH', '--market', 'US_EQUITY', '--register-commit', head, '--owner-named', 'false']);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /MECHANISM_ID_NOT_REGISTERED/);
  assert.match(run(['--mechanism-id', ID, '--market', 'US_EQUITY']).stderr, /TRIAGE_MECHANISM_INVALID/);
  assert.match(run(['--market', 'US_EQUITY']).stderr, /TRIAGE_MECHANISM_INVALID/);
  assert.equal(fs.existsSync(triage.LEDGER()), false);
});
