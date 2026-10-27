'use strict';
/**
 * 复盘闭环修订 6（desk 主稿 D6–D8 ★；QRP 一侧说明 §2、§5 E1）：研究队列导入、按档案补开 case、基线锁／对比锁回链、
 * 回程文件 QRP_RESEARCH_RETURN_V1、「已有 N 项回到 Desk」。全部在临时数据目录（QRP_DATA_DIR）与临时 desk 根（QRP_DESK_ROOT）里跑；
 * desk 夹具是合成的，不含任何真实复盘事实。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { dataRoot } = require('./_env');
const a7 = require('./_a7_model');
const fxCore = require('./_us_core_q0_fixture');
const { PRODUCTION } = require('./_profile_fixture');
const schema = require('./_json_schema');
const loop = require('../services/runtime-research-loop');
const profileCases = require('../services/runtime-research-loop/profile_cases');
const routing = require('../services/desk-review-routing');
const returns = require('../services/desk-review-routing/return');
const { canonicalJson, contentHash } = require('../services/desk-review-routing/canonical');
const profiles = require('../services/strategy-profiles');
const q0 = require('../services/baseline-evaluation');
const cc = require('../services/candidate-comparison');
const adoption = require('../services/research-adoption');
const stage = require('../services/research-workspace/stage');

const ROOT = path.join(__dirname, '..');
const REAL_DESK = path.resolve(ROOT, '..', 'portfolio-desk');
const HAVE_DESK_SRC = fs.existsSync(path.join(REAL_DESK, 'src', 'operation-review.js'));
const SKIP_PAGE = HAVE_DESK_SRC ? false : 'desk checkout（../portfolio-desk/src）不在本机；页面断言跳过，不算通过';
const SCHEMAS = path.join(__dirname, 'fixtures', 'desk-schemas');
const QUEUE_SCHEMA = JSON.parse(fs.readFileSync(path.join(SCHEMAS, 'review-loop-research-queue.v1.schema.json'), 'utf8'));
const RETURN_SCHEMA = JSON.parse(fs.readFileSync(path.join(SCHEMAS, 'qrp-research-return.v1.schema.json'), 'utf8'));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const US_V5 = 'US_V5_ETF_3000USD';
const US_CORE = 'US_CORE_9000USD_3X_GATEOBS';
const KEY_A = `RQK-${'a1'.repeat(8)}`;
const KEY_B = `RQK-${'b2'.repeat(8)}`;
const KEY_C = `RQK-${'c3'.repeat(8)}`;
const KEY_D = `RQK-${'d4'.repeat(8)}`;

// ── 合成 desk 根 ──────────────────────────────────────────────────────────────────────────────

function makeDesk({ withSrc = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-desk-routing-'));
  fs.mkdirSync(path.join(root, routing.QUEUE_DIR), { recursive: true });
  // 页面测试要读 desk 策略目录：链到本机 desk 的 src（只读）；没有时页面断言跳过
  if (withSrc && HAVE_DESK_SRC) fs.symlinkSync(path.join(REAL_DESK, 'src'), path.join(root, 'src'));
  return root;
}
const writeJson = (file, payload) => { fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`); return fs.readFileSync(file); };

function writeWeek(root, weekId, extra = {}, { revision = 0 } = {}) {
  const file = `REVIEW_LOOP_WEEK_${weekId}${revision ? `_R${revision}` : ''}.json`;
  const payload = { schemaVersion: 1, contract: 'REVIEW_LOOP_WEEK_V1', producer: 'COORDINATOR', weekId, revision, fixture: true, ...extra };
  payload.hash = contentHash(payload);
  const bytes = writeJson(path.join(root, routing.WEEK_DIR, file), payload);
  return { file, sha256: sha(bytes), hash: payload.hash };
}

function entry({ questionKey = KEY_A, candidateId = 'RLC-US-2000W01-1', market = 'US', ledgerId = US_V5, firstWeek = '2026-W42', weeksSeen = 1,
  choice = null, mergedInto = null, questionZh = '合成题：这一条规则是否按设计生效？' } = {}) {
  return {
    questionKey, candidateId, market, ledgerId, roleId: null, triggerIds: ['F04'],
    findings: [{ findingId: 'F04-fixture.1', weekId: firstWeek, triggerId: 'F04', fact: '合成事实', evidence: [{ contract: 'FIXTURE_CONTRACT', file: 'fixture.json', hash: 'e'.repeat(64), path: '$.rows[0]' }] }],
    firstWeek, weeksSeen, candidateType: 'RULE', ruleRef: [{ ref: 'FIXTURE_RULE@v1', effectiveFrom: '2026-10-01', source: 'ACCEPTANCE' }],
    versionSegmentId: null, effect: { value: null, unit: 'USD', basis: '合成', state: 'NOT_MEASURED', reasonCode: 'FIXTURE' },
    sample: { n: 3, unit: 'CLOSED_TRADES', floor: 30, state: 'BELOW_FLOOR' }, questionZh,
    ownerPick: { choice, ownerWords: choice ? '合成原话' : null, at: choice ? '2026-10-27T10:00:00+08:00' : null, weekId: choice ? '2026-W43' : null, revision: choice ? 1 : null },
    deskState: choice === null ? 'OPEN' : 'PICKED', mergedInto, qrpHint: null,
  };
}

function writeQueue(root, weekId, entries, { week = writeWeek(root, weekId), mutate = (payload) => payload, rehash = true } = {}) {
  const file = `REVIEW_LOOP_RESEARCH_QUEUE_${weekId}.json`;
  let payload = {
    schemaVersion: 1, contract: 'REVIEW_LOOP_RESEARCH_QUEUE_V1', producer: 'COORDINATOR', weekId, revision: 0, generatedAt: '2026-10-27T02:30:00Z',
    sourceWeek: { file: week.file, sha256: week.sha256, hash: week.hash }, routes: 'REVIEW_LOOP_DEFAULT_ROUTES@v1', entries,
    interpretation: 'RESEARCH_INTAKE_FACTS_NOT_ORDERS', realOrder: 0, brokerWrite: false,
  };
  payload.hash = contentHash(payload);
  payload = mutate(payload) || payload;
  if (rehash) payload.hash = contentHash(payload);
  const bytes = writeJson(path.join(root, routing.QUEUE_DIR, file), payload);
  return { file, sha256: sha(bytes), payload };
}

const LINKS = () => loop.LINKS_LEDGER();
const resetLinks = () => fs.rmSync(LINKS(), { force: true });
const linkRows = () => (fs.existsSync(LINKS()) ? fs.readFileSync(LINKS(), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

/** 每个用例从同一个起点开始：US_V5 case（夹具）+ Q0–Q5 锁与五条采用决定；回链清空。 */
function fresh(options) {
  const out = a7.setup(options);
  resetLinks();
  return out;
}

// ── 1. 导入 ───────────────────────────────────────────────────────────────────────────────────

test('研究队列夹具本身符合 desk 的 REVIEW_LOOP_RESEARCH_QUEUE_V1 schema（夹具与契约同形）', () => {
  const desk = makeDesk({ withSrc: false });
  const queue = writeQueue(desk, '2026-W43', [entry(), entry({ questionKey: KEY_B, choice: 'MERGE', mergedInto: 'Q3' })]);
  assert.deepEqual(schema.validate(QUEUE_SCHEMA, queue.payload), []);
});

test('同一 questionKey 跨两周导入只写一条回链：第二周与重复导入什么也不写；字段取首次出现的队列文件', () => {
  fresh();
  const desk = makeDesk({ withSrc: false });
  const first = writeQueue(desk, '2026-W43', [entry()]);
  const one = routing.importQueue({ deskRoot: desk });
  assert.equal(one.registered.length, 1);
  assert.deepEqual(one.refused, []);
  const caseRef = a7.CASE;
  const linkId = `RRL-${sha(canonicalJson({ case_ref: caseRef, questionKey: KEY_A })).slice(0, 16)}`;
  const [link] = linkRows();
  assert.equal(link.link_id, linkId);
  assert.equal(link.case_ref, caseRef);
  assert.equal(link.desk_candidate_ref, 'RLC-US-2000W01-1');
  assert.equal(link.desk_evidence_ref, `portfolio-desk:docs/review-loop/research-queue/${first.file}#${KEY_A}`);
  assert.equal(link.desk_evidence_hash, first.sha256);
  assert.equal(link.research_question_ref, `DQ-${KEY_A}`);
  assert.equal(link.conclusion, 'PENDING');
  assert.equal(link.adoption_state, 'NOT_DECIDED');
  // 回链里不存 desk 状态：没有题目原文、Owner 挑选、出现周数
  assert.ok(!JSON.stringify(link).includes('合成题'));
  assert.ok(!('ownerPick' in link) && !('weeksSeen' in link) && !('questionZh' in link));

  // 第二周：同一键、Owner 已立研究、出现两周 → 最新一份是 W44，link_id 相同，不写
  writeQueue(desk, '2026-W44', [entry({ weeksSeen: 2, choice: 'RESEARCH' })]);
  const two = routing.importQueue({ deskRoot: desk });
  assert.equal(two.queue.file, 'REVIEW_LOOP_RESEARCH_QUEUE_2026-W44.json');
  assert.equal(two.registered.length, 0);
  assert.deepEqual(two.unchanged.map((row) => row.linkId), [linkId]);
  assert.equal(routing.importQueue({ deskRoot: desk, file: first.file }).registered.length, 0);
  assert.equal(linkRows().length, 1);
});

test('文件级核对失败关闭：payload hash 不符、sourceWeek 文件缺失、周档字节 sha256 不符、周档 hash 不符、常量不对 → 整份拒收，回链账本不写', () => {
  fresh();
  const code = (fn) => { try { fn(); } catch (error) { return error.code; } return 'NO_ERROR'; };
  const cases = [
    ['DESK_QUEUE_HASH_MISMATCH', (desk) => writeQueue(desk, '2026-W43', [entry()], { mutate: (p) => { p.hash = 'f'.repeat(64); }, rehash: false })],
    ['DESK_QUEUE_HASH_MISMATCH', (desk) => writeQueue(desk, '2026-W43', [entry()], { mutate: (p) => { p.entries[0].questionZh = '改过的题'; }, rehash: false })],
    ['DESK_QUEUE_SOURCE_WEEK_MISSING', (desk) => writeQueue(desk, '2026-W43', [entry()], { week: { file: 'REVIEW_LOOP_WEEK_2026-W43_R7.json', sha256: 'a'.repeat(64), hash: 'b'.repeat(64) } })],
    ['DESK_QUEUE_SOURCE_WEEK_SHA256_MISMATCH', (desk) => { const week = writeWeek(desk, '2026-W43'); writeQueue(desk, '2026-W43', [entry()], { week: { ...week, sha256: 'c'.repeat(64) } }); }],
    ['DESK_QUEUE_SOURCE_WEEK_HASH_MISMATCH', (desk) => { const week = writeWeek(desk, '2026-W43'); writeQueue(desk, '2026-W43', [entry()], { week: { ...week, hash: 'd'.repeat(64) } }); }],
    ['DESK_QUEUE_SOURCE_WEEK_HASH_MISMATCH', (desk) => {
      // 周档自己的 hash 字段与内容不符（字节与 sourceWeek 一致，但复算不过）
      const file = 'REVIEW_LOOP_WEEK_2026-W43.json';
      const bytes = writeJson(path.join(desk, routing.WEEK_DIR, file), { contract: 'REVIEW_LOOP_WEEK_V1', weekId: '2026-W43', hash: '9'.repeat(64) });
      writeQueue(desk, '2026-W43', [entry()], { week: { file, sha256: sha(bytes), hash: '9'.repeat(64) } });
    }],
    ['DESK_QUEUE_CONTRACT_INVALID', (desk) => writeQueue(desk, '2026-W43', [entry()], { mutate: (p) => { p.producer = 'QRP'; } })],
    ['DESK_QUEUE_CONTRACT_INVALID', (desk) => writeQueue(desk, '2026-W43', [entry()], { mutate: (p) => { p.realOrder = 1; } })],
    ['DESK_QUEUE_ENTRY_INVALID', (desk) => writeQueue(desk, '2026-W43', [entry({ questionKey: 'RQK-short' })])],
  ];
  for (const [expected, build] of cases) {
    const desk = makeDesk({ withSrc: false });
    build(desk);
    assert.equal(code(() => routing.importQueue({ deskRoot: desk })), expected);
  }
  assert.equal(code(() => routing.importQueue({ deskRoot: makeDesk({ withSrc: false }) })), 'DESK_QUEUE_NONE');
  assert.equal(code(() => routing.importQueue({ deskRoot: path.join(os.tmpdir(), 'qrp-no-such-desk-root') })), 'DESK_QUEUE_DIR_MISSING');
  assert.equal(fs.existsSync(LINKS()), false);
});

test('导入只写 QRP_DATA_DIR：desk 根逐文件不变，仓库 git 状态与仓库内 var/ledger 不变', () => {
  fresh();
  const desk = makeDesk({ withSrc: false });
  writeQueue(desk, '2026-W43', [entry()]);
  const tree = (dir) => {
    const out = {};
    const walk = (at) => {
      for (const name of fs.readdirSync(at)) {
        const full = path.join(at, name);
        const stat = fs.lstatSync(full);
        if (stat.isDirectory()) walk(full);
        else out[path.relative(dir, full)] = `${stat.size}:${stat.mtimeMs}:${sha(fs.readFileSync(full))}`;
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out;
  };
  const gitStatus = () => execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: ROOT, encoding: 'utf8' });
  const repoLedger = path.join(ROOT, 'var', 'ledger');
  const before = { desk: tree(desk), git: gitStatus(), ledger: tree(repoLedger) };
  const data = tree(dataRoot);
  const result = routing.importQueue({ deskRoot: desk });
  assert.equal(result.registered.length, 1);
  assert.deepEqual(tree(desk), before.desk);
  assert.equal(gitStatus(), before.git);
  assert.deepEqual(tree(repoLedger), before.ledger);
  const after = tree(dataRoot);
  const changed = Object.keys(after).filter((key) => after[key] !== data[key]);
  assert.deepEqual(changed, [path.relative(dataRoot, LINKS())]);
});

test('逐行拒收、其余照常：未登记策略、case 未开（不带 --open-cases）、case 开不了（带 --open-cases，写明缺哪个字段）；「并入」QRP 题时回链挂到那一题', () => {
  fresh();
  const desk = makeDesk({ withSrc: false });
  writeQueue(desk, '2026-W43', [
    entry({ questionKey: KEY_A }),
    entry({ questionKey: KEY_B, ledgerId: 'NOT_A_REGISTERED_STRATEGY' }),
    entry({ questionKey: KEY_C, candidateId: 'RLC-CRYPTO-2000W01-1', market: 'CRYPTO', ledgerId: 'QUICK_SHOT_V3_1000USDT' }),
    entry({ questionKey: KEY_D, candidateId: 'RLC-US-2000W01-2', choice: 'MERGE', mergedInto: 'Q3' }),
  ]);
  const plain = routing.importQueue({ deskRoot: desk });
  assert.deepEqual(plain.registered.map((row) => row.questionKey), [KEY_A, KEY_D]);
  assert.deepEqual(plain.refused.map((row) => [row.questionKey, row.code]), [
    [KEY_B, 'DESK_QUEUE_ENTRY_STRATEGY_NOT_REGISTERED'], [KEY_C, 'DESK_QUEUE_ENTRY_CASE_NOT_OPEN'],
  ]);
  assert.equal(plain.registered.find((row) => row.questionKey === KEY_D).researchQuestionRef, 'Q3');
  const opened = routing.importQueue({ deskRoot: desk, openCases: true });
  const refusedQs = opened.refused.find((row) => row.questionKey === KEY_C);
  assert.equal(refusedQs.code, 'DESK_QUEUE_ENTRY_CASE_NOT_OPENED');
  assert.match(refusedQs.reason, /^CASE_FACT_MISSING:.*runtime_lane\.mode/);
  assert.equal(opened.unchanged.length, 2);
  assert.equal(loop.listCases().some((row) => row.strategy_ref === 'QUICK_SHOT_V3_1000USDT'), false);
});

// ── 2. 按档案补开 case ────────────────────────────────────────────────────────────────────────

/** 合成的 US_CORE 型 M1 证据：临时仓库根下的证据清单 + 输入包（源清单 MANIFEST.sha256 + 运行账本），档案指向它。 */
function usCoreRepo({ ledgerPatch = (ledger) => ledger, manifestPatch = (lines) => lines } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-profile-case-'));
  const relRoot = 'var/evidence/us-core-m1-synthetic';
  const pkg = path.join(repoRoot, relRoot);
  fs.mkdirSync(path.join(pkg, 'files', 'config'), { recursive: true });
  const ledger = ledgerPatch({
    schemaVersion: 2, strategyId: 'US_CORE_ROT', mode: 'paper', initialEquity: 9000,
    initialization: { bookId: `${US_CORE}@2026-10-08T13:30:00.000Z` },
    marks: [{ asOf: '2026-10-22', observedAt: '2026-10-22T20:35:00.000Z', equity: 9000 }, { asOf: '2026-10-23', observedAt: '2026-10-23T20:35:00.717Z', equity: 8000 }],
    notificationOutbox: [{ payload: { action: 'OPEN', executionMode: 'paper' } }],
  });
  const ledgerRel = 'files/config/us_core_ledger.json';
  const ledgerBytes = writeJson(path.join(pkg, ledgerRel), ledger);
  const manifestBytes = Buffer.from(`${manifestPatch([`${sha(ledgerBytes)}  ./${ledgerRel}`]).join('\n')}\n`);
  fs.writeFileSync(path.join(pkg, 'MANIFEST.sha256'), manifestBytes);
  const evidence = {
    schema: 'US_CORE_M1_NATIVE_DIAGNOSTIC_EVIDENCE_V1', case_ref: 'RRC-US-CORE-9000-V8-1-M0', strategy_ref: US_CORE,
    book: { ledger_file: ledgerRel, book_id: `${US_CORE}@2026-10-08T13:30:00.000Z` },
    input_package: { relative_root: relRoot }, source_package: { manifest_path: 'MANIFEST.sha256', manifest_sha256: sha(manifestBytes) },
    safety: { production_effect: 'NONE', research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
  };
  fs.mkdirSync(path.join(repoRoot, 'docs', 'evidence'), { recursive: true });
  const evidenceBytes = writeJson(path.join(repoRoot, 'docs', 'evidence', 'US_CORE_M1_SYNTHETIC.json'), evidence);
  return { repoRoot, ledgerFile: path.join(pkg, ledgerRel), ledgerSha: sha(ledgerBytes), evidenceSha: sha(evidenceBytes) };
}

/** 进程内把 US_CORE 档案的 m1_evidence 换成合成证据（不写 config）；返回原注册表。 */
function withCoreEvidence(evidenceSha) {
  return profiles.use(profiles.validate({
    ...PRODUCTION,
    profiles: PRODUCTION.profiles.map((item) => (item.strategy_ref === US_CORE
      ? { ...item, m1_evidence: { ...item.m1_evidence, manifest_ref: 'docs/evidence/US_CORE_M1_SYNTHETIC.json', manifest_sha256: evidenceSha } } : item)),
  }));
}

function lockCoreQ0() {
  if (q0.headLock('RRC-US-CORE-9000-V8-1-M0')) return q0.headLock('RRC-US-CORE-9000-V8-1-M0');
  const file = fxCore.write(fxCore.result((doc) => { doc.identity.d_version = `${US_CORE}@2026-10-08T13:30:00.000Z (fixture)`; return doc; }));
  return q0.importBaselineEvaluation(file, { registeredBy: a7.AUTHORITY, strategyRef: US_CORE, allowNonActual: true });
}

test('按档案补开 US_CORE case：运行通道取自 M1 包的运行账本（sha256 逐级核对），基线取自当前 Q0 锁；数据质量、Cycle 写 UNKNOWN；重开是原样返回', () => {
  fresh();
  const repo = usCoreRepo();
  const original = withCoreEvidence(repo.evidenceSha);
  try {
    const lock = lockCoreQ0();
    const options = { repoRoot: repo.repoRoot, allowNonActual: true };
    const input = profileCases.caseInputFor(US_CORE, options);
    assert.equal(input.case_id, 'RRC-US-CORE-9000-V8-1-M0');
    assert.deepEqual(input.runtime_lane, {
      source_ref: repo.ledgerFile, source_hash: repo.ledgerSha, version_ref: `${US_CORE}@2026-10-08T13:30:00.000Z`,
      as_of: '2026-10-23T20:35:00.717Z', mode: 'PAPER', real_order: 0,
    });
    assert.equal(input.baseline.source_ref, lock.file_ref);
    assert.equal(input.baseline.source_hash, lock.file_sha256);
    assert.equal(input.baseline.baseline_id, `BASELINE-${lock.result_id}`);
    assert.equal(input.baseline.expected_baseline.verdict_state, lock.verdict_state);
    assert.deepEqual(input.data_quality, { status: 'UNKNOWN', as_of: '2026-10-23', known_at: '2026-10-23T20:35:00.717Z', source_refs: [repo.ledgerFile], freshness: { state: 'UNKNOWN' } });
    assert.deepEqual(input.cycle_context, { state: 'UNKNOWN', source_ref: null, source_hash: null });
    const opened = profileCases.ensureProfileCase(US_CORE, options);
    assert.equal(opened.case_id, 'RRC-US-CORE-9000-V8-1-M0');
    assert.equal(opened.production_effect, 'NONE');
    assert.equal(profileCases.ensureProfileCase(US_CORE, options).replayHit, true);
    assert.equal(loop.listCases().filter((row) => row.case_id === 'RRC-US-CORE-9000-V8-1-M0').length, 1);

    // 导入：US_CORE 那一行登记到它自己的 case 上（E2 的形状：link_count 1）
    const desk = makeDesk({ withSrc: false });
    writeQueue(desk, '2026-W43', [entry({ ledgerId: US_CORE, candidateId: 'RLC-US-2000W01-9', firstWeek: '2026-W41' })]);
    const result = routing.importQueue({ deskRoot: desk, openCases: true, caseOptions: options });
    assert.equal(result.registered.length, 1);
    assert.equal(loop.readModel().cases.find((row) => row.case_id === 'RRC-US-CORE-9000-V8-1-M0').links.length, 1);
  } finally {
    profiles.use(original);
  }
});

test('补开 case 的事实缺失或不符时拒绝并写明字段：账本没有 mode、动作不是纸面、源清单 sha256 不符、档案证据 sha256 不符；真实 QS 档案缺运行方式', () => {
  fresh();
  lockCoreQ0();
  const code = (repo) => {
    const original = withCoreEvidence(repo.evidenceSha);
    try { profileCases.caseInputFor(US_CORE, { repoRoot: repo.repoRoot, allowNonActual: true }); return 'NO_ERROR'; } catch (error) { return error.message; } finally { profiles.use(original); }
  };
  assert.equal(code(usCoreRepo({ ledgerPatch: (ledger) => { delete ledger.mode; return ledger; } })), 'CASE_FACT_MISSING:runtime_lane.mode');
  assert.equal(code(usCoreRepo({ ledgerPatch: (ledger) => { ledger.notificationOutbox[0].payload.executionMode = 'live'; return ledger; } })), 'CASE_FACT_MISSING:runtime_lane.real_order');
  assert.equal(code(usCoreRepo({ ledgerPatch: (ledger) => { ledger.marks = []; return ledger; } })), 'CASE_FACT_MISSING:runtime_lane.as_of');
  assert.match(code(usCoreRepo({ manifestPatch: () => [`${'0'.repeat(64)}  ./files/config/us_core_ledger.json`] })), /^CASE_FACT_SOURCE_SHA256_MISMATCH/);
  assert.match(code({ ...usCoreRepo(), evidenceSha: '1'.repeat(64) }), /^CASE_FACT_M1_EVIDENCE_SHA256_MISMATCH/);
  // 真实 QS 档案：M1 包里没有结构化的运行方式字段；临时账本里也没有它的 Q0 锁
  assert.throws(() => profileCases.caseInputFor('QUICK_SHOT_V3_1000USDT'), (error) => error.code === 'CASE_FACT_MISSING' && /runtime_lane\.mode/.test(error.detail));
  assert.equal(loop.listCases().some((row) => row.strategy_ref === 'QUICK_SHOT_V3_1000USDT'), false);
});

test('补开 case 之后 US_CORE 页能出：运行状态页对非 US_V5 型的已校验诊断只列输入包一项（不再按 US_V5 的 source_status 取值而抛错）', { skip: SKIP_PAGE }, async () => {
  fresh();
  const repo = usCoreRepo();
  const original = withCoreEvidence(repo.evidenceSha);
  try {
    lockCoreQ0();
    profileCases.ensureProfileCase(US_CORE, { repoRoot: repo.repoRoot, allowNonActual: true });
    const diagnostic = {
      schema: 'US_CORE_M1_STRATEGY_DIAGNOSTIC_V1', state: 'VERIFIED', case_ref: 'RRC-US-CORE-9000-V8-1-M0', strategy_ref: US_CORE,
      window: { label: '合成窗口' }, package: { files: [{ path: 'a' }, { path: 'b' }], sha256: 'a'.repeat(64) },
    };
    const model = await withDeskRoot(makeDesk(), () => require('../services/research-workspace').readModel({ strategyRef: US_CORE, diagnostic }));
    const status = model.views['runtime-status'];
    assert.equal(status.answer, 'M1 诊断输入已完成内容校验：2 个文件，当前没有诊断输入缺口。');
    assert.equal(status.sources.length, 1);
    assert.equal(status.sources[0].file_name, '2 个文件');
    assert.equal(status.diagnostic_sources, null);
    assert.equal(model.views['strategy-detail'].health.state, 'DIAGNOSTIC_AVAILABLE');
  } finally {
    profiles.use(original);
  }
});

// ── 3. 基线锁／对比锁回链 ─────────────────────────────────────────────────────────────────────

function deskLinks(entries) {
  const desk = makeDesk({ withSrc: false });
  writeQueue(desk, '2026-W43', entries);
  routing.importQueue({ deskRoot: desk });
  return { desk, links: loop.listLinks() };
}

test('回链绑定对比锁与基线锁：现场复验后写新行（result_ref、result_hash、三态机械映射、NOT_DECIDED）；同一绑定重放，换绑拒绝', () => {
  const { lock0, locks } = fresh();
  const { links } = deskLinks([entry({ questionKey: KEY_A }), entry({ questionKey: KEY_B, candidateId: 'RLC-US-2000W01-2' })]);
  const [linkA, linkB] = [KEY_A, KEY_B].map((key) => links.find((link) => link.research_question_ref === `DQ-${key}`));
  const bound = loop.linkLockedResult(linkA.link_id, { result_id: locks.Q1.result_id, expected_file_sha256: locks.Q1.file_sha256 }, { allowNonActual: true });
  assert.equal(bound.result_ref, `QRP:${locks.Q1.result_id}:LOCKED`);
  assert.equal(bound.result_hash, locks.Q1.file_sha256);
  assert.equal(bound.conclusion, loop.LOCK_CONCLUSION_OF[locks.Q1.verdict_state]);
  assert.equal(bound.adoption_state, 'NOT_DECIDED');
  assert.equal(bound.production_effect, 'NONE');
  assert.equal(bound.experiment_ref, null);
  assert.equal(linkRows().filter((row) => row.link_id === linkA.link_id).length, 2, '只追加，旧行保留');
  assert.equal(loop.linkLockedEvaluation(linkA.link_id, { result_id: locks.Q1.result_id, expected_file_sha256: locks.Q1.file_sha256 }, { allowNonActual: true }).replayHit, true);
  assert.throws(() => loop.linkLockedResult(linkA.link_id, { result_id: locks.Q2.result_id, expected_file_sha256: locks.Q2.file_sha256 }, { allowNonActual: true }), /LOOP_LINK_ALREADY_RESULT_LINKED/);
  // 基线锁
  const base = loop.linkLockedResult(linkB.link_id, { result_id: lock0.result_id, expected_file_sha256: lock0.file_sha256 }, { allowNonActual: true });
  assert.equal(base.result_ref, `QRP:${lock0.result_id}:LOCKED`);
  assert.equal(base.conclusion, loop.LOCK_CONCLUSION_OF[lock0.verdict_state]);
  // 映射表与锁的三态词表一一对应
  assert.deepEqual(Object.keys(loop.LOCK_CONCLUSION_OF).sort(), [...q0.STATES].sort());
  assert.deepEqual(loop.LOCK_CONCLUSION_OF, { SUPPORTED: 'PASS', NOT_PASSED: 'FAIL', INSUFFICIENT: 'INSUFFICIENT' });
});

test('回链绑定拒绝：锁已被替代、锁属于别的 case、文件 sha256 不符、未知锁、并入的题号与锁不符、锁文件漂移；旧实验引擎那条路照旧', () => {
  const { lock0, locks } = fresh();
  const { links } = deskLinks([
    entry({ questionKey: KEY_A }), entry({ questionKey: KEY_B, candidateId: 'RLC-US-2000W01-2' }),
    entry({ questionKey: KEY_C, candidateId: 'RLC-US-2000W01-3', choice: 'MERGE', mergedInto: 'Q3' }),
  ]);
  const link = links.find((row) => row.research_question_ref === `DQ-${KEY_A}`);
  const merged = links.find((row) => row.research_question_ref === 'Q3');
  const bind = (id, lock, sha256 = lock.file_sha256) => () => loop.linkLockedResult(id, { result_id: lock.result_id, expected_file_sha256: sha256 }, { allowNonActual: true });
  assert.throws(bind(link.link_id, locks.Q1, 'f'.repeat(64)), /LOOP_RESULT_HASH_MISMATCH/);
  assert.throws(bind(link.link_id, { result_id: 'Q9-0000000000000000', file_sha256: 'a'.repeat(64) }), /LOOP_LOCK_NOT_FOUND/);
  assert.throws(() => loop.linkLockedResult(link.link_id, { result_id: locks.Q1.result_id }), /LOOP_LOCK_BINDING_MISSING:expected_file_sha256/);
  assert.throws(bind(merged.link_id, locks.Q1), /LOOP_RESEARCH_QUESTION_MISMATCH/);
  // 别的 case 的锁
  const core = lockCoreQ0();
  assert.throws(bind(link.link_id, core), /LOOP_LOCK_CASE_MISMATCH/);
  // 替代：同一 case 的新 Q0 锁取代旧锁之后，旧锁不能再绑
  const next = q0.importBaselineEvaluation(require('./_q0_fixture').write(require('./_q0_fixture').result((doc) => { doc.identity.seed = 99; return doc; })),
    { registeredBy: a7.AUTHORITY, allowNonActual: true, supersedes: lock0.result_id, defectRef: 'DEFECT:FIXTURE', reason: '合成替代' });
  assert.throws(bind(link.link_id, lock0), /LOOP_LOCK_SUPERSEDED/);
  // 锁文件在锁定后被改：复验不过
  const drifted = links.find((row) => row.research_question_ref === `DQ-${KEY_B}`);
  const original = fs.readFileSync(next.file_ref);
  try {
    fs.writeFileSync(next.file_ref, Buffer.concat([original, Buffer.from(' ')]));
    q0.clearCache();
    assert.throws(bind(drifted.link_id, next), /LOOP_LOCK_NOT_VERIFIED/);
  } finally {
    fs.writeFileSync(next.file_ref, original);
    q0.clearCache();
  }
  assert.equal(bind(drifted.link_id, next)().conclusion, loop.LOCK_CONCLUSION_OF[next.verdict_state]);
  // 旧路：实验 ID 照旧走 verifyFreeze
  assert.throws(() => loop.linkLockedResult(link.link_id, 'EXP-NOT-FROZEN'), /LOOP_EXPERIMENT_FREEZE_INVALID/);
  assert.equal(linkRows().filter((row) => row.link_id === link.link_id).length, 1, '拒绝时不写');
});

// ── 4. 回程文件 ───────────────────────────────────────────────────────────────────────────────

test('回程文件：Q1–Q5 的有效采用记录逐行等于账本，锁的字段等于锁账本；符合 desk 的 QRP_RESEARCH_RETURN_V1 schema；hash 与 desk 同算法', () => {
  const { locks } = fresh();
  const ledgerBytes = () => returns.LEDGERS.map((ledger) => { try { return sha(fs.readFileSync(path.join(dataRoot, ledger))); } catch { return null; } });
  const before = ledgerBytes();
  const payload = returns.buildReturn({ generatedAt: '2026-10-27T11:20:00.000Z' });
  assert.deepEqual(schema.validate(RETURN_SCHEMA, payload), []);
  assert.equal(payload.hash, contentHash(payload));
  assert.deepEqual(ledgerBytes(), before, '导出不改任何账本');
  const effective = [...adoption.effective().values()];
  assert.equal(payload.decisions.length, 5);
  assert.deepEqual(payload.decisions.map((row) => [row.questionRef, row.kind, row.decision]),
    [['Q1', 'DECISION', 'ADOPT'], ['Q2', 'DECISION', 'NOT_ADOPTED'], ['Q3', 'DECISION', 'NOT_ADOPTED'], ['Q4', 'DECISION', 'ADOPT'], ['Q5', 'DECISION', 'ADOPT']]);
  for (const row of payload.decisions) {
    const record = effective.find((item) => item.record_id === row.recordId);
    const lock = locks[row.questionRef];
    assert.deepEqual(row, {
      recordId: record.record_id, recordHash: record.record_hash, kind: 'DECISION', strategyRef: record.strategy_ref, caseRef: record.case_ref,
      questionRef: record.question_ref, questionTitleZh: row.questionTitleZh, resultId: record.result_id, part: null,
      lock: { class: 'COMPARISON', verdictState: lock.verdict_state, fileSha256: lock.file_sha256, lockedAt: lock.locked_at, k2Ref: lock.k2_ref },
      decision: record.decision, recommendation: null, recommendationReasonZh: null, ownerWords: record.owner_words,
      decidedAt: record.decided_at, followUpZh: record.follow_up_zh, deskLink: null, origin: 'QRP_PROGRAM',
    });
    assert.ok(row.questionTitleZh, `${row.questionRef} 有中文题名`);
  }
  assert.deepEqual(payload.sources.map((row) => row.ledger), returns.LEDGERS);
  for (const row of payload.sources) {
    const file = path.join(dataRoot, row.ledger);
    if (fs.existsSync(file)) assert.equal(row.sha256, sha(fs.readFileSync(file)));
    else assert.deepEqual([row.sha256, row.rows], [null, 0]);
  }
  assert.equal(payload.sources.find((row) => row.ledger === 'research/adoption_decisions.jsonl').rows, 5);
  assert.equal(payload.questions.every((row) => row.origin === 'QRP_PROGRAM' && row.k2FrozenAt === null && row.expectedResultDate === null), true);
});

test('回程文件：建议行只带建议与理由；回链绑到锁时 deskLink 与 origin = DESK_REVIEW', () => {
  const { locks } = fresh({ decisions: { Q1: ['ADOPT', '后续'] } });
  adoption.recordAdoption({ kind: 'RECOMMENDATION', result_id: locks.Q2.result_id, coordinator_recommendation: { recommendation: 'NOT_ADOPTED', reason_zh: '合成理由' } },
    { writtenBy: a7.AUTHORITY, allowNonActual: true });
  const { links } = deskLinks([entry({ questionKey: KEY_A })]);
  loop.linkLockedResult(links[0].link_id, { result_id: locks.Q1.result_id, expected_file_sha256: locks.Q1.file_sha256 }, { allowNonActual: true });
  const payload = returns.buildReturn({ generatedAt: '2026-10-27T11:20:00.000Z' });
  assert.deepEqual(schema.validate(RETURN_SCHEMA, payload), []);
  const q1 = payload.decisions.find((row) => row.questionRef === 'Q1');
  assert.deepEqual(q1.deskLink, { candidateId: 'RLC-US-2000W01-1', questionKey: KEY_A, linkId: links[0].link_id });
  assert.equal(q1.origin, 'DESK_REVIEW');
  const q2 = payload.decisions.find((row) => row.questionRef === 'Q2');
  assert.deepEqual([q2.kind, q2.decision, q2.recommendation, q2.recommendationReasonZh, q2.ownerWords, q2.decidedAt, q2.followUpZh, q2.origin],
    ['RECOMMENDATION', null, 'NOT_ADOPTED', '合成理由', null, null, null, 'QRP_PROGRAM']);
});

test('回程文件导出：--out 必填，文件名 QRP_RESEARCH_RETURN_<YYYYMMDDTHHMMZ>.json，同名不覆盖；CLI 不带 --out 退出码 1', () => {
  fresh();
  assert.throws(() => returns.exportReturn({}), /RETURN_OUT_DIR_REQUIRED/);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-return-out-'));
  const written = returns.exportReturn({ outDir: out, generatedAt: '2026-10-27T11:20:59.000Z' });
  assert.equal(path.basename(written.file), 'QRP_RESEARCH_RETURN_20261027T1120Z.json');
  assert.equal(written.sha256, sha(fs.readFileSync(written.file)));
  assert.deepEqual(JSON.parse(fs.readFileSync(written.file, 'utf8')), written.payload);
  assert.throws(() => returns.exportReturn({ outDir: out, generatedAt: '2026-10-27T11:20:00.000Z' }), /RETURN_FILE_EXISTS/);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'apps', 'research-cli', 'export_desk_research_return.js')], { env: { ...process.env, QRP_DATA_DIR: dataRoot }, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /USAGE:--out <dir>/);
});

// ── 5. 「已有 N 项回到 Desk」与 desk 来的题怎么显示 ────────────────────────────────────────────

function weekWithReturns(desk, weekId, rows, options) {
  return writeWeek(desk, weekId, { researchReturns: rows }, options);
}
const cite = (record, extra = {}) => ({ recordId: record.record_id, recordHash: record.record_hash, kind: record.kind, conclusion: null, ...extra });

test('回到 Desk 的计数：desk 周档 researchReturns[] 引用、recordHash 一致的 DECISION 记录按对象计；hash 不符、周档复算不过、读不出来都不算，也不抛错', () => {
  fresh();
  const records = adoption.records();
  const desk = makeDesk({ withSrc: false });
  assert.equal(routing.returnedToDeskCount(records, routing.returnCitations({ deskRoot: desk })), 0);
  weekWithReturns(desk, '2026-W44', [...records.map((record) => cite(record)), { recordId: 'ADR-0000000000000000', recordHash: 'a'.repeat(64) }]);
  assert.equal(routing.returnedToDeskCount(records, routing.returnCitations({ deskRoot: desk })), 5);
  // 只引用两条、另一条 hash 不符 → 2
  const other = makeDesk({ withSrc: false });
  weekWithReturns(other, '2026-W44', [cite(records[0]), cite(records[1]), cite(records[2], { recordHash: 'b'.repeat(64) })]);
  assert.equal(routing.returnedToDeskCount(records, routing.returnCitations({ deskRoot: other })), 2);
  // 两份周档引用同一条只算一次；周档 hash 字段不符的不读
  weekWithReturns(other, '2026-W45', [cite(records[0])]);
  writeJson(path.join(other, routing.WEEK_DIR, 'REVIEW_LOOP_WEEK_2026-W46.json'), { contract: 'REVIEW_LOOP_WEEK_V1', researchReturns: records.map((record) => cite(record)), hash: 'c'.repeat(64) });
  fs.writeFileSync(path.join(other, routing.WEEK_DIR, 'REVIEW_LOOP_WEEK_2026-W47.json'), '{ not json');
  assert.equal(routing.returnedToDeskCount(records, routing.returnCitations({ deskRoot: other })), 2);
  assert.equal(routing.returnCitations({ deskRoot: path.join(os.tmpdir(), 'qrp-no-such-desk-root') }).size, 0);
});

async function withDeskRoot(root, fn) {
  const before = process.env.QRP_DESK_ROOT;
  process.env.QRP_DESK_ROOT = root;
  try { return await fn(); } finally { if (before === undefined) delete process.env.QRP_DESK_ROOT; else process.env.QRP_DESK_ROOT = before; }
}

test('US_V5 页头：desk 周档引用 5 条决定后写「已有 5 项回到 Desk」；没有周档时仍是「尚未回到 Desk」，研究队列表不变', { skip: SKIP_PAGE }, async () => {
  const { locks } = fresh();
  const desk = makeDesk();
  const research = async () => (await withDeskRoot(desk, () => a7.modelOf({ locks }))).views['strategy-detail'];
  const empty = await research();
  assert.match(empty.research.answer, /尚未回到 Desk/);
  assert.deepEqual(empty.research_queue.rows.map((row) => row.question_ref), ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
  weekWithReturns(desk, '2026-W44', adoption.records().map((record) => cite(record)));
  const returned = await research();
  assert.match(returned.research.answer, /已有 5 项回到 Desk/);
  assert.doesNotMatch(returned.research.answer, /尚未回到 Desk/);
  assert.deepEqual(returned.research_queue, empty.research_queue);
});

test('desk 来的题：研究队列表、回链卡与研究进度写「Desk 复盘 <候选号> · <首次出现的周>」和最新队列里的 Owner 挑选；desk 状态不进账本', { skip: SKIP_PAGE }, async () => {
  const { locks } = fresh();
  const desk = makeDesk();
  writeQueue(desk, '2026-W43', [entry()]);
  routing.importQueue({ deskRoot: desk });
  const view = async () => (await withDeskRoot(desk, () => a7.modelOf({ locks }))).views['strategy-detail'];
  const first = await view();
  const row = first.research_queue.rows.find((item) => item.question_ref === `DQ-${KEY_A}`);
  assert.deepEqual(row, {
    question_ref: `DQ-${KEY_A}`, part_zh: 'Desk 复盘问题', name_zh: '合成题：这一条规则是否按设计生效？',
    source_zh: 'Desk 复盘 RLC-US-2000W01-1 · 2026-W42', status_zh: '待 Owner 挑选', locked: false,
  });
  assert.deepEqual(first.research_queue.rows.slice(0, 5).map((item) => item.question_ref), ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
  const card = first.research.items[0];
  assert.equal(card.question_label, '合成题：这一条规则是否按设计生效？');
  assert.equal(card.desk_source_zh, 'Desk 复盘 RLC-US-2000W01-1 · 2026-W42');
  assert.equal(card.desk_state_zh, '待 Owner 挑选');
  // 下一周 Owner 选「不做」：现读最新一份，回链账本不变
  const ledger = fs.readFileSync(LINKS());
  writeQueue(desk, '2026-W44', [entry({ weeksSeen: 2, choice: 'DONT' })]);
  routing.importQueue({ deskRoot: desk });
  assert.deepEqual(fs.readFileSync(LINKS()), ledger);
  const second = await view();
  assert.equal(second.research_queue.rows.find((item) => item.question_ref === `DQ-${KEY_A}`).status_zh, 'Owner 不做');
  const facts = await withDeskRoot(desk, () => stage.factsOf(a7.STRATEGY, { cases: loop.readModel().cases, m4Items: [] }));
  const open = facts.open.find((item) => item.phase === 'DESK_LINK');
  assert.equal(open.title_zh, '合成题：这一条规则是否按设计生效？');
  assert.equal(stage.PHASE_WORDS.DESK_LINK(open), 'Desk 研究问题，Owner 不做');
  // 页面上回链卡带来源与状态
  const { html } = await a7.render(await withDeskRoot(desk, () => a7.modelOf({ locks })), `#strategy-detail?strategy=${a7.STRATEGY}&section=research`);
  assert.ok(html.includes('<dt>来源</dt><dd>Desk 复盘 RLC-US-2000W01-1 · 2026-W42</dd>'));
  assert.ok(html.includes('<dt>Desk 状态</dt><dd>Owner 不做</dd>'));
});

test('Owner 挑选的中文：null／DONT／RESEARCH／MERGE／LATER 各一句；最新队列没有这一题时写明', () => {
  const words = [null, 'DONT', 'RESEARCH', 'MERGE', 'LATER'].map((choice) => routing.pickWords(entry({ choice, mergedInto: choice === 'MERGE' ? 'Q3' : null })));
  assert.deepEqual(words, ['待 Owner 挑选', 'Owner 不做', '已立研究，待冻结 K2', '并入 Q3', '待 Owner 挑选（先放着）']);
  const link = { link_id: 'RRL-x', desk_candidate_ref: 'RLC-US-2000W01-1', desk_evidence_ref: `${routing.EVIDENCE_PREFIX}REVIEW_LOOP_RESEARCH_QUEUE_2026-W43.json#${KEY_A}` };
  assert.deepEqual(routing.deskQuestionView(link, new Map()), {
    question_key: KEY_A, candidate_id: 'RLC-US-2000W01-1', title_zh: 'Desk 研究问题（最新一份 Desk 研究队列未列出）',
    source_zh: 'Desk 复盘 RLC-US-2000W01-1', state_zh: '最新一份 Desk 研究队列未列出',
  });
  assert.equal(routing.deskQuestionView({ link_id: 'RRL-y', desk_candidate_ref: 'CAND-1', desk_evidence_ref: 'DESK:REVIEW_LOOP_WEEK_V1:CAND-1' }, new Map()), null);
});

test('权威边界（D7 ★，协调说明 1）：复盘归 desk 周档，采用决定归 QRP 采用记录；协调说明文件在，且不含 desk 事实', () => {
  const model = loop.readModel();
  assert.deepEqual(model.authority, {
    runtime: 'MARKET_REPOSITORY', research: 'QRP_RESULT_LOCK', review: 'DESK_REVIEW_LOOP_WEEK_V1',
    adoption: 'QRP_RESEARCH_ADOPTION_DECISION_V1', cycle: 'CYCLE_EVIDENCE_REFERENCE_ONLY',
  });
  assert.equal('review_and_adoption' in model.authority, false);
  const note = fs.readFileSync(path.join(ROOT, 'docs', 'contracts', 'CYCLE_RESEARCH_DESK_RUNTIME_RESEARCH_LOOP_ACCEPTANCE_V1_COORDINATOR_NOTE_1.md'), 'utf8');
  assert.match(note, /K4 的「采用决定」= QRP 的采用记录 `RESEARCH_ADOPTION_DECISION_V1`/);
  assert.match(note, /f04f6baa67ea66f8c8b326c5119b64f5dd156442c3efc861e60a612564d9eccc/);
  assert.equal(sha(fs.readFileSync(path.join(ROOT, loop.ACCEPTANCE_REF))), 'f04f6baa67ea66f8c8b326c5119b64f5dd156442c3efc861e60a612564d9eccc', '冻结文本不改');
  assert.doesNotMatch(note, /RLC-|RQK-|W4[0-9]/, '不含 desk 候选号、问题键或周号');
});
