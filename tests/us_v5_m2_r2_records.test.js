'use strict';
/**
 * US_V5_M2_Q0_RESULT_V1 导入规格 · 增补 1：两类描述记录（差距分解 GAP_DECOMPOSITION_V1、Q0 压力补充 BASELINE_STRESS_SUPPLEMENT_V1）。
 * 规则出处：两份冻结 K2（a161c523…、cc945872…）的「QRP 需要的」两节、差距分解 K2 勘误 1（c17802e3…）、
 * 协调会话 US_V5_M2_R2_K2_FREEZE_1（5501741d…）★6 与 ★3–★5，以及候选对比导入规格 V2 附录 3 第 2 节（原版臂来源的读法）。
 * 账本在临时目录（tests/_env），不碰 var/ledger；结果文件是 tests/_us_v5_r2_fixture.js 的合成文件。
 */
require('./_env');
const test = require('node:test');
const { beforeEach } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const loop = require('../services/runtime-research-loop');
const workspace = require('../services/research-workspace');
const q0 = require('../services/baseline-evaluation');
const cc = require('../services/candidate-comparison');
const gap = require('../services/gap-decomposition');
const supp = require('../services/baseline-stress-supplement');
const { validateRecord } = require('../schemas');
const fx0 = require('./_q0_fixture');
const fx = require('./_us_v5_r2_fixture');

const ROOT = path.join(__dirname, '..');
const CASE = q0.CASE_REF;
const STRATEGY = q0.STRATEGY_REF;
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const rejects = (code) => (error) => { assert.equal(error.code, code, error.message); return true; };

let Q0;
let CITED;
const ctxGap = () => ({ q0Id: Q0.id, q0Sha: Q0.sha, cited: CITED });
const ctxSupp = () => ({ q0Id: Q0.id, q0Sha: Q0.sha, q5Id: CITED.Q5.result_id });
const impGap = (file, extra = {}) => gap.importGapDecomposition(file, { registeredBy: AUTHORITY, allowNonActual: true, ...extra });
const impSupp = (file, extra = {}) => supp.importStressSupplement(file, { registeredBy: AUTHORITY, allowNonActual: true, ...extra });
const writeGap = (fn) => fx.write(fx.gapDoc(ctxGap(), fn), 'US_V5_M2_R2_GAP_DECOMPOSITION_V1.json');
const writeSupp = (fn) => fx.write(fx.supplementDoc(ctxSupp(), fn), 'US_V5_M2_Q0_STRESS_SUPPLEMENT_V1.json');
const refusesGap = (fn, code) => assert.throws(() => impGap(writeGap(fn)), rejects(code), code);
const refusesSupp = (fn, code) => assert.throws(() => impSupp(writeSupp(fn)), rejects(code), code);
/** 把补充的场景整体换成另一行（身份、补充行、参照行一起换）。 */
const scenarioTo = (doc, scenario) => { doc.identity.scenario = scenario; doc.row.scenario = scenario; for (const row of doc.reference_rows) row.scenario = scenario; };

function importQ0(doc = fx.q0Doc()) {
  const lock = q0.importBaselineEvaluation(fx0.write(doc), { registeredBy: AUTHORITY, allowNonActual: true });
  return { doc, id: lock.result_id, sha: lock.file_sha256, lock };
}

beforeEach(() => {
  for (const ledger of [q0.LEDGER(), cc.LEDGER(), gap.LEDGER(), supp.LEDGER()]) fs.rmSync(ledger, { force: true });
  q0.clearCache(); cc.clearCache(); gap.clearCache(); supp.clearCache();
  Q0 = importQ0();
  CITED = fx.seedComparisons(cc, { caseRef: CASE, strategyRef: STRATEGY, baselineResultId: Q0.id });
});

// ── 登记项 ──────────────────────────────────────────────────────────────────────

test('登记项：两份 K2 与勘误 1 是 smartflow 冻结文本的逐字节副本；增补 1 存在；两类锁登记在 schemas；记录属于 US_V5', () => {
  assert.equal(sha(gap.ENTRY.k2.ref), 'a161c5234f07d6cef182ccf21837be100a82be8f18b0184d6e393598814437cc');
  assert.equal(gap.ENTRY.k2.sha256, 'a161c5234f07d6cef182ccf21837be100a82be8f18b0184d6e393598814437cc');
  assert.equal(sha(gap.ENTRY.erratum.ref), 'c17802e332a91d7ac539d1bb684427e0375f02c7bb0ae9a5aceed3728b019161');
  assert.equal(gap.ENTRY.erratum.sha256, 'c17802e332a91d7ac539d1bb684427e0375f02c7bb0ae9a5aceed3728b019161');
  assert.equal(sha(supp.ENTRY.k2.ref), 'cc945872a4210a7ec524a727dc186e2e29051d9200e8a2cf949076ac5645c59a');
  assert.equal(supp.ENTRY.k2.sha256, 'cc945872a4210a7ec524a727dc186e2e29051d9200e8a2cf949076ac5645c59a');
  for (const entry of [gap.ENTRY, supp.ENTRY]) {
    assert.equal(entry.freeze.sha256, '5501741d93de625685fda2013deb560c71227c5100c7d8da50647ea351bc46ba');
    assert.equal(entry.import_profile_id, 'docs/contracts/US_V5_M2_Q0_RESULT_V1_IMPORT_PROFILE_ADDENDUM_1.md');
    assert.ok(fs.existsSync(path.join(ROOT, entry.import_profile_id)));
    assert.equal(entry.strategy_ref, 'US_V5_ETF_3000USD');
  }
  assert.deepEqual([...gap.ENTRY.run_gates], ['ACCEPTANCE', 'INPUTS', 'ENGINE_FILES', 'RECON_D', 'RECON_B', 'IDENTITY', 'FEE_CROSSCHECK', 'EXIT_COUNTS', 'IS_REPRO', 'IS_RECON', 'REPRO', 'MEM']);
  assert.deepEqual([...supp.ENTRY.run_gates], ['ACCEPTANCE', 'INPUTS', 'ATTEST_DATES_ONLY', 'ATTEST_OVERLAP', 'ATTEST_COUNT', 'ENGINE_INERT', 'OPTION_INERT_2022', 'FLOOR_VALID', 'SIGNALS_UNCHANGED', 'REPRO', 'MEM']);
  assert.deepEqual({ ...gap.ENTRY.base_arm }, { question_ref: 'Q5', arm: 'CANDIDATE_T3_ON_A25' });
  assert.deepEqual([...gap.ENTRY.cited], ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
  assert.deepEqual([...supp.ENTRY.input_routes], ['FLOOR_ATTESTATION_LOCAL_DAILY']);
  assert.deepEqual([...supp.ENTRY.not_fillable], ['EXTREME_DOWNTURN_2008']);
});

// ── 差距分解：导入 ───────────────────────────────────────────────────────────────

test('差距分解导入：GAP-<sha256 前 16 位>；锁符合 GAP_DECOMPOSITION_LOCK_V1；同一文件重导是幂等重放；另一份文件要 supersedes + 缺陷 + 原因', () => {
  assert.throws(() => impGap(writeGap(), { registeredBy: 'SOMEONE' }), rejects('BASELINE_LOCK_REGISTERED_BY_NOT_AUTHORIZED'));
  const file = writeGap();
  const lock = impGap(file);
  assert.equal(lock.result_id, `GAP-${fx.sha256(fs.readFileSync(file)).slice(0, 16)}`);
  assert.equal(lock.schema, 'GAP_DECOMPOSITION_LOCK_V1');
  assert.equal(lock.record_type, 'GAP_DECOMPOSITION_V1');
  assert.equal(lock.baseline_result_id, Q0.id);
  assert.deepEqual(lock.base_arm_ref, { result_id: CITED.Q5.result_id, arm: 'CANDIDATE_T3_ON_A25' });
  assert.deepEqual(lock.cited_result_ids, ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].map((key) => CITED[key].result_id));
  assert.equal(lock.oos_reuse, true);
  assert.equal(lock.k2_sha256, gap.ENTRY.k2.sha256);
  assert.equal(lock.production_effect, 'NONE');
  assert.ok(validateRecord(lock, 'GAP_DECOMPOSITION_LOCK_V1').ok);
  assert.equal(impGap(file).replayHit, true);
  assert.equal(gap.locks(CASE).length, 1);
  const other = writeGap((doc) => { doc.identity.command = 'node … （另一次）'; });
  assert.throws(() => impGap(other), rejects('GAP_ALREADY_LOCKED'));
  assert.throws(() => impGap(other, { supersedes: lock.result_id }), rejects('GAP_SUPERSEDE_REQUIRES_DEFECT_AND_REASON'));
  const next = impGap(other, { supersedes: lock.result_id, defectRef: 'DEFECT-1', reason: '测试' });
  assert.equal(next.supersedes_ref, lock.result_id);
  assert.equal(gap.headLock(CASE).result_id, next.result_id);
  assert.equal(gap.locks(CASE).length, 2, '旧锁保留');
});

test('差距分解拒绝：带三态、K2 / 勘误 / 冻结裁定不符、运行门未过、未复现、样本外复用未披露、schema 或记录类型不对', () => {
  refusesGap((doc) => { doc.verdict = { state: 'INSUFFICIENT' }; }, 'GAP_VERDICT_NOT_ALLOWED');
  refusesGap((doc) => { doc.step2_admission.verdict_state = 'SUPPORTED'; }, 'GAP_VERDICT_NOT_ALLOWED');
  refusesGap((doc) => { doc.identity.schema = 'US_V5_M2_Q5_RESULT_V1'; }, 'GAP_RESULT_SCHEMA_UNSUPPORTED');
  refusesGap((doc) => { doc.identity.result_kind = 'CHALLENGER_VS_BASELINE'; }, 'GAP_RESULT_KIND_UNSUPPORTED');
  refusesGap((doc) => { doc.identity.record_type = 'CANDIDATE_COMPARISON_V1'; }, 'GAP_RESULT_KIND_UNSUPPORTED');
  refusesGap((doc) => { doc.identity.k2.sha256 = fx.hex('other-k2'); }, 'GAP_K2_SHA_MISMATCH');
  refusesGap((doc) => { doc.identity.erratum.sha256 = fx.hex('other-erratum'); }, 'GAP_ERRATUM_SHA_MISMATCH');
  refusesGap((doc) => { doc.identity.k2.freeze.sha256 = fx.hex('other-freeze'); }, 'GAP_FREEZE_SHA_MISMATCH');
  refusesGap((doc) => { doc.gates.RECON_D.state = 'NOT_PASSED'; }, 'GAP_RUN_GATE_NOT_PASSED');
  refusesGap((doc) => { delete doc.gates.MEM; }, 'GAP_RUN_GATE_NOT_PASSED');
  refusesGap((doc) => { doc.gates.EXTRA = { state: 'NOT_PASSED' }; }, 'GAP_RUN_GATE_NOT_PASSED');
  refusesGap((doc) => { doc.reproducibility.runs[1].sha256 = fx.hex('other-run'); }, 'GAP_RESULT_NOT_REPRODUCED');
  refusesGap((doc) => { doc.reproducibility.identical = false; }, 'GAP_RESULT_NOT_REPRODUCED');
  refusesGap((doc) => { doc.oos_reuse = false; }, 'GAP_OOS_REUSE_MUST_BE_DECLARED');
  refusesGap((doc) => { doc.oos_reuse_detail.reason_code = 'OOS_FRESH'; }, 'GAP_OOS_REUSE_NOT_DECLARED');
  refusesGap((doc) => { doc.oos_reuse_detail.reason_zh = ' '; }, 'GAP_OOS_REUSE_DETAIL_MISSING');
  refusesGap((doc) => { delete doc.step2_admission; }, 'GAP_RESULT_TOP_LEVEL_MISSING');
  assert.throws(() => impGap(fx.write(fx.gapDoc(ctxGap()), 'GAP.json', { tamperSidecar: true })), rejects('GAP_RESULT_SHA256_MISMATCH'));
  assert.equal(gap.locks(CASE).length, 0, '拒绝时账本不写');
});

test('差距分解拒绝：基线与原版臂来源（同附录 3 第 2 节的读法）、引用的 Q1–Q5 锁', () => {
  refusesGap((doc) => { doc.identity.baseline_result_id = 'Q0-0000000000000000'; }, 'GAP_BASELINE_LOCK_NOT_FOUND');
  refusesGap((doc) => { doc.gates.INPUTS.sealed[0].expect = fx.hex('other-q0'); }, 'GAP_BASELINE_SHA256_MISMATCH');
  refusesGap((doc) => { doc.identity.base_arm_ref.arm = 'BASELINE_A25'; }, 'GAP_BASE_ARM_REF_MISSING');
  refusesGap((doc) => { doc.identity.base_arm_ref.result_id = 'Q5-0000000000000000'; }, 'GAP_BASE_ARM_REF_LOCK_NOT_FOUND');
  refusesGap((doc) => { doc.identity.base_arm_ref = { ...doc.identity.base_arm_ref, result_id: CITED.Q4.result_id, sha256: CITED.Q4.sha256 }; }, 'GAP_BASE_ARM_REF_LOCK_NOT_FOUND');
  refusesGap((doc) => { doc.identity.base_arm_ref.sha256 = fx.hex('other-q5'); }, 'GAP_BASE_ARM_REF_SHA256_MISMATCH');
  refusesGap((doc) => { doc.decomposition.SPY.end_current_d = 4505.9; }, 'GAP_BASE_ARM_DIFFERS_FROM_REF');
  refusesGap((doc) => { delete doc.identity.cited_results.Q3; }, 'GAP_CITED_RESULTS_INCOMPLETE');
  refusesGap((doc) => { doc.identity.cited_results.Q2.sha256 = fx.hex('other-q2'); }, 'GAP_CITED_RESULT_SHA256_MISMATCH');
  refusesGap((doc) => { doc.identity.cited_results.Q1.result_id = 'Q1-0000000000000000'; }, 'GAP_CITED_RESULT_LOCK_NOT_FOUND');
  refusesGap((doc) => { doc.identity.cited_results.Q5 = { ...CITED.Q4 }; delete doc.identity.cited_results.Q5.file; }, 'GAP_CITED_RESULT_LOCK_NOT_FOUND');
  // Q5 有了更新的锁：原版臂来源不是当前锁
  const newer = fx.seedComparisons(cc, { caseRef: CASE, strategyRef: STRATEGY, baselineResultId: Q0.id, questions: ['Q5'], salt: '-newer' });
  assert.ok(newer.Q5.result_id !== CITED.Q5.result_id);
  refusesGap(null, 'GAP_BASE_ARM_REF_NOT_CURRENT');
});

test('差距分解拒绝：Q0 基线被取代；所引的 Q5 锁引用的是另一个 Q0 基线', () => {
  const lockedFirst = writeGap();
  const base = fx.q0Doc();
  base.identity.smartflow_commit = 'b'.repeat(40);
  const second = q0.importBaselineEvaluation(fx0.write(base), { registeredBy: AUTHORITY, allowNonActual: true, supersedes: Q0.id, defectRef: 'DEFECT-Q0', reason: '测试' });
  assert.notEqual(second.result_id, Q0.id);
  assert.throws(() => impGap(lockedFirst), rejects('GAP_BASELINE_NOT_CURRENT'));
  // 文件指向新的 Q0，而 Q5 锁仍挂在旧 Q0 上
  assert.throws(() => impGap(fx.write(fx.gapDoc({ ...ctxGap(), q0Id: second.result_id, q0Sha: second.file_sha256 }), 'GAP.json')), rejects('GAP_BASE_ARM_REF_BASELINE_DIFFERS'));
});

test('差距分解拒绝：排名表与第 2 步准入只核对一致性（标签不能比文件里的数强）', () => {
  refusesGap((doc) => { [doc.ranking.rows[0], doc.ranking.rows[1]] = [doc.ranking.rows[1], doc.ranking.rows[0]]; }, 'GAP_RANKING_INVALID');
  refusesGap((doc) => { doc.ranking.rows[2].g = 'x'; }, 'GAP_RANKING_INVALID');
  refusesGap((doc) => { doc.step2_admission.checks_1_96.significant = false; }, 'GAP_ADMISSION_INCONSISTENT');
  refusesGap((doc) => { doc.step2_admission.checks_2_80.significant = true; doc.step2_admission.checks_2_80.admitted = true; }, 'GAP_ADMISSION_INCONSISTENT');
  refusesGap((doc) => { doc.step2_admission.decision = 'NO_CANDIDATE'; }, 'GAP_ADMISSION_INCONSISTENT');
  refusesGap((doc) => { doc.step2_admission.candidate = 'D+A25+T3+M-2'; }, 'GAP_ADMISSION_INCONSISTENT');
  refusesGap((doc) => { doc.step2_admission.decision = 'BLOCKED'; }, 'GAP_ADMISSION_INCONSISTENT');
  refusesGap((doc) => { doc.step2_admission.group.blocks = ['A1']; }, 'GAP_ADMISSION_INCONSISTENT');
  refusesGap((doc) => { doc.step2_admission.sensitivity_reversed_convention.checks_1_96.admitted = true; }, 'GAP_ADMISSION_INCONSISTENT');
  // 没有候选的文件同样可以导入（第 2 步不开题），只要读法一致
  const lock = impGap(writeGap((doc) => {
    const s = doc.step2_admission;
    s.group.g = 0.09; s.group.z = 1.69; s.checks_1_96 = { positive: true, significant: false, is_same_sign: true, admitted: false };
    s.decision = 'NO_CANDIDATE'; s.candidate = null; s.decision_zh = '无候选'; s.no_candidate_text_zh = '样本里没有一块既显著、又有已登记的机制可以收回';
  }));
  const card = gap.buildProjection(lock, { allowNonActual: true });
  assert.equal(card.state, 'LOCKED_VERIFIED', card.reason);
  assert.match(card.admission.decision_zh, /无候选/);
});

// ── 差距分解：页面投影 ───────────────────────────────────────────────────────────

test('差距分解投影：标题「差距分解（描述，不是结论）」；依次给排名表、功效列、第 2 步准入表；数字照文件；文件漂移后失败关闭', () => {
  const file = writeGap();
  const lock = impGap(file);
  const card = gap.buildProjection(lock, { allowNonActual: true });
  assert.equal(card.state, 'LOCKED_VERIFIED', card.reason);
  assert.equal(card.title_zh, '差距分解（描述，不是结论）');
  assert.equal(card.verdict_state, undefined, '没有三态');
  assert.deepEqual(card.sections.map((item) => item.key), ['ranking', 'power', 'admission']);
  assert.match(card.lead_zh, /年化 g 差 \+0\.0862（SE 0\.0719）/);
  assert.match(card.lead_zh, /4,505\.88/);
  assert.match(card.lead_zh, /6,248\.08/);
  assert.match(card.oos_note_zh, /oos_reuse: true/);
  const ranking = card.sections[0];
  assert.deepEqual(ranking.rows.map((row) => row[0]), ['A1', 'A2', 'C', 'P', 'START_FEE', 'A3', 'S']);
  assert.deepEqual(ranking.rows[0].slice(2), ['+0.1038', '+1,540.88', '120.5%', '0.0480', '2.16', '0.1345', '边界（1.96–2.80）', '+0.0321 · 同号']);
  assert.deepEqual(ranking.rows[4].slice(2), ['−0.0001', '−1.50', '−0.1%', '—', '—', '—', '—', '−0.0002 · —']);
  assert.ok(ranking.columns_zh.includes('MDE80（功效）'));
  assert.deepEqual(ranking.split_rows.map((row) => row[0]), ['AVG_SHORT', 'TIMING']);
  const powerLines = card.sections[1].lines_zh.join('\n');
  assert.match(powerLines, /SE 0\.0719.*MDE80 0\.2014.*MDE50 0\.1410/);
  assert.match(powerLines, /MDE80 0\.4847 R/);
  assert.match(powerLines, /2,867 笔/);
  const admission = card.sections[2];
  assert.deepEqual(admission.rows.map((row) => row[0]), ['A1+A2 · 按 1.96', 'A1+A2 · 按 2.80', '反过来的约定（★3 (a) 敏感性，不参与准入）· 按 1.96']);
  assert.deepEqual(admission.rows[0].slice(1), ['+0.1454', '0.0532', '2.73', '+0.0515', '是', '是', '是', '准入']);
  assert.deepEqual(admission.rows[1].slice(-1), ['不准入']);
  assert.deepEqual(admission.rows[2].slice(1), ['+0.1262', '0.0729', '1.73', '+0.0415', '是', '否', '是', '不准入']);
  assert.equal(card.admission.decision_zh, '第 2 步候选：D+A25+T3+M-1（按 1.96 准入）；按 2.80 不准入（无候选）');
  assert.equal(card.refs_current, true);
  assert.equal(card.baseline_current, true);
  assert.equal(card.source.import_profile_id, gap.ENTRY.import_profile_id);
  // 锁之后文件漂移：失败关闭
  fs.appendFileSync(file, ' ');
  gap.clearCache();
  const drifted = gap.buildProjection(lock, { allowNonActual: true });
  assert.equal(drifted.state, 'INVALID');
  assert.equal(drifted.sections, undefined);
});

// ── Q0 压力补充：导入 ────────────────────────────────────────────────────────────

test('压力补充导入：Q0S-<sha256 前 16 位>；锁符合 BASELINE_STRESS_SUPPLEMENT_LOCK_V1；只追加，不改 Q0 锁；同一 (基线, 场景) 只能有一条', () => {
  const file = writeSupp();
  const lock = impSupp(file);
  assert.equal(lock.result_id, `Q0S-${fx.sha256(fs.readFileSync(file)).slice(0, 16)}`);
  assert.equal(lock.schema, 'BASELINE_STRESS_SUPPLEMENT_LOCK_V1');
  assert.equal(lock.record_type, 'BASELINE_STRESS_SUPPLEMENT_V1');
  assert.equal(lock.baseline_result_id, Q0.id);
  assert.equal(lock.scenario, 'WINDOW_2020_02_19_04_30');
  assert.equal(lock.oos_reuse, false);
  assert.equal(lock.production_effect, 'NONE');
  assert.ok(validateRecord(lock, 'BASELINE_STRESS_SUPPLEMENT_LOCK_V1').ok);
  assert.equal(impSupp(file).replayHit, true);
  assert.deepEqual(q0.locks(CASE).map((row) => row.result_id), [Q0.id], 'Q0 锁不变');
  const other = writeSupp((doc) => { doc.identity.command = 'node … （另一次）'; });
  assert.throws(() => impSupp(other), rejects('SUPPLEMENT_ALREADY_LOCKED'));
  assert.throws(() => impSupp(other, { supersedes: lock.result_id }), rejects('SUPPLEMENT_SUPERSEDE_REQUIRES_DEFECT_AND_REASON'));
  const next = impSupp(other, { supersedes: lock.result_id, defectRef: 'DEFECT-2', reason: '测试' });
  assert.equal(supp.headLock(CASE, Q0.id, 'WINDOW_2020_02_19_04_30').result_id, next.result_id);
});

test('压力补充拒绝：基线不符、场景不是 Q0 的缺口行、2008 不可补、输入路线未冻结、模拟、运行门、复现、样本外、Q0 原行不符、参照行进锁', () => {
  refusesSupp((doc) => { doc.identity.baseline_result_id = 'Q0-0000000000000000'; }, 'SUPPLEMENT_BASELINE_MISMATCH');
  refusesSupp((doc) => { doc.identity.baseline_sha256 = fx.hex('other-q0'); }, 'SUPPLEMENT_BASELINE_MISMATCH');
  refusesSupp((doc) => { scenarioTo(doc, 'FEES_15BPS'); }, 'SUPPLEMENT_SCENARIO_NOT_A_GAP_ROW');
  refusesSupp((doc) => { scenarioTo(doc, 'WINDOW_2021'); }, 'SUPPLEMENT_SCENARIO_NOT_A_GAP_ROW');
  refusesSupp((doc) => { scenarioTo(doc, 'EXTREME_DOWNTURN_2008'); doc.q0_row_before = fx.clone(fx.ROW_2008); }, 'SCENARIO_NOT_FILLABLE');
  refusesSupp((doc) => { doc.identity.input_route = 'HK_ALPACA_FETCH'; }, 'SUPPLEMENT_INPUT_ROUTE_NOT_FROZEN');
  refusesSupp((doc) => { doc.row.simulated = true; }, 'SUPPLEMENT_ROW_SIMULATED');
  refusesSupp((doc) => { doc.row.scenario = 'WINDOW_2022_01_03_10_31'; }, 'SUPPLEMENT_ROW_INVALID');
  refusesSupp((doc) => { doc.row.max_loss_usd = null; }, 'SUPPLEMENT_ROW_INVALID');
  refusesSupp((doc) => { doc.gates.FLOOR_VALID.state = 'NOT_PASSED'; }, 'SUPPLEMENT_RUN_GATE_NOT_PASSED');
  refusesSupp((doc) => { delete doc.gates.ENGINE_INERT; }, 'SUPPLEMENT_RUN_GATE_NOT_PASSED');
  refusesSupp((doc) => { doc.reproducibility.runs[0].sha256 = fx.hex('x'); }, 'SUPPLEMENT_RESULT_NOT_REPRODUCED');
  refusesSupp((doc) => { doc.oos_reuse = true; }, 'SUPPLEMENT_OOS_REUSE_MUST_BE_FALSE');
  refusesSupp((doc) => { doc.window_history_zh = ''; }, 'SUPPLEMENT_WINDOW_HISTORY_MISSING');
  refusesSupp((doc) => { doc.q0_row_before.missing_reason = '别的原因'; }, 'SUPPLEMENT_Q0_ROW_BEFORE_DIFFERS');
  refusesSupp((doc) => { doc.reference_rows[0].in_any_lock = true; }, 'SUPPLEMENT_REFERENCE_IN_LOCK');
  refusesSupp((doc) => { doc.reference_rows[0].ref.result_id = 'Q5-0000000000000000'; }, 'SUPPLEMENT_REFERENCE_REF_NOT_FOUND');
  refusesSupp((doc) => { doc.reference_rows[0].ref.arm = 'BASELINE_A25'; }, 'SUPPLEMENT_REFERENCE_INVALID');
  refusesSupp((doc) => { doc.verdict = { state: 'NOT_PASSED' }; }, 'SUPPLEMENT_VERDICT_NOT_ALLOWED');
  refusesSupp((doc) => { doc.identity.k2.sha256 = fx.hex('k2'); }, 'SUPPLEMENT_K2_SHA_MISMATCH');
  refusesSupp((doc) => { doc.identity.result_kind = 'BASELINE_EVALUATION'; }, 'SUPPLEMENT_RESULT_KIND_UNSUPPORTED');
  assert.equal(supp.locks(CASE).length, 0, '拒绝时账本不写');
});

// ── 页面：Q0 卡片与差距分解卡 ─────────────────────────────────────────────────────

loop.openCase({
  case_id: CASE, strategy_ref: STRATEGY, market: 'US_EQUITY',
  runtime_lane: { source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64), version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0 },
  baseline: {
    baseline_id: 'BASELINE-R2-RECORDS-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY', version_ref: 'US_V5_ETF_6000USD@frozen-old',
    source_ref: 'SMARTFLOW:SIGNED_RESEARCH:US_V5_ETF_6000USD', source_hash: 'b'.repeat(64), expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
    frozen_at: '2026-10-24T20:01:00Z',
  },
  cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
  data_quality: { status: 'VALID', as_of: '2026-10-23', known_at: '2026-10-24T20:00:00Z', source_refs: ['SMARTFLOW:US_V5_SCAN_RECORD_V2'], freshness: { state: 'CURRENT', age_seconds: 0 } },
  isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
  opened_at: '2026-10-24T20:02:00Z',
});

const PAGE = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
async function renderPage(model, hash = `#strategy-detail?strategy=${STRATEGY}&section=all`) {
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = { id, innerHTML: '', textContent: '', addEventListener() {}, querySelector() { return null; }, focus() {}, scrollIntoView() {} });
  const sandbox = {
    document: { getElementById: element, title: '' }, location: { hash }, window: { addEventListener() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(model)) }),
    requestAnimationFrame() {}, URLSearchParams, Intl, encodeURIComponent, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return elements.workspace.innerHTML;
}
// Q0 锁的文件在 fixture 路径下，页面读法照 research_web_render.test.js：把放行了非实际来源的 Q0 投影交给 readModel；补充与差距分解照常从账本读
const readModel = () => workspace.readModel({ strategyRef: STRATEGY, baseline: q0.buildProjection(Q0.lock, { allowNonActual: true }) });
const detail = async () => (await readModel()).views['strategy-detail'];
const stressOf = (view) => view.backtest.blocks.find((block) => block.key === 'stress');

test('没有这两类锁时：Q0 卡片与详情投影不多任何字段（US_V5 的投影形状不变）', async () => {
  const view = await detail();
  assert.equal(view.gap_decompositions, undefined);
  const stress = stressOf(view);
  assert.equal(stress.state, 'AVAILABLE', stress.reason);
  assert.ok(stress.data.rows.every((row) => row.supplement === undefined));
  assert.equal(stress.data.supplement_note_zh, undefined);
  assert.equal(view.conclusion.completeness.stress_supplement_zh, undefined);
});

test('页面：压力表 2020 行原样「无效输入」，下面一行补充（Q0S-…）、再下一行灰字当前 D 参照；主数字、计数与结论不变；差距分解卡在 Q0 卡片下面', async () => {
  const before = await detail();
  const beforeStress = stressOf(before).data;
  const suppLock = impSupp(writeSupp());
  const gapLock = impGap(writeGap());
  const view = await detail();
  const stress = stressOf(view).data;
  // 主数字、计数、压力评价只按 Q0 文件
  assert.deepEqual(stress.headline, beforeStress.headline);
  assert.deepEqual(stress.counts, beforeStress.counts);
  assert.deepEqual(stress.evaluation, beforeStress.evaluation);
  const row2020 = stress.rows.find((row) => row.scenario === 'WINDOW_2020_02_19_04_30');
  assert.equal(row2020.kind, 'INVALID_INPUT', '2020 行原样保留');
  assert.equal(row2020.supplement.state, 'LOCKED_VERIFIED', row2020.supplement.reason);
  assert.equal(row2020.supplement.result_id, suppLock.result_id);
  assert.equal(row2020.supplement.line_zh, `补充（另行封存，${suppLock.result_id}）：最大亏损 90.42 USD，期末 2,909.58 USD，最长水下 50 个 session，区间内 SPY −13.27%`);
  assert.deepEqual(row2020.supplement.reference_lines_zh, ['当前 D（D+A25+T3）参照：最大亏损 56.75 USD，期末 2,943.25 USD，最长水下 51 个 session，2 笔；只报，不进 Q0、不进 Q5']);
  assert.equal(stress.supplement_note_zh, '2020 区间另有补充，见压力表');
  assert.equal(view.conclusion.completeness.stress_supplement_zh, '2020 区间另有补充，见压力表');
  assert.ok(stress.rows.filter((row) => row !== row2020).every((row) => row.supplement === undefined));
  assert.equal(view.gap_decompositions.length, 1);
  assert.equal(view.gap_decompositions[0].result_id, gapLock.result_id);

  const html = await renderPage(await readModel());
  const block = html.slice(html.indexOf('data-block="stress"'), html.indexOf('data-block="kelly"'));
  const invalidAt = block.indexOf('无效输入：');
  const suppAt = block.indexOf('class="stress-supplement"');
  const refAt = block.indexOf('class="stress-supplement-reference"');
  assert.ok(invalidAt > 0 && suppAt > invalidAt && refAt > suppAt, `2020 行 → 补充行 → 参照行（${invalidAt} / ${suppAt} / ${refAt}）`);
  assert.match(block, /补充（另行封存，Q0S-[0-9a-f]{16}）：最大亏损 90\.42 USD/);
  assert.equal((block.match(/class="missing-scenario"/g) || []).length, 2, '缺场景／无效输入行数不变');
  assert.match(html, /压力评价不完整[^<]*<span class="stress-supplement-note">2020 区间另有补充，见压力表<\/span>/);
  const backtestAt = html.indexOf('id="backtest-title"');
  const gapAt = html.indexOf('差距分解（描述，不是结论）');
  const diagnosisAt = html.indexOf('id="diagnosis-title"');
  assert.ok(backtestAt > 0 && gapAt > backtestAt && gapAt < diagnosisAt, '差距分解卡紧跟在 Q0 回测结论卡后面');
  const card = html.slice(gapAt, diagnosisAt);
  const order = ['data-gap-block="ranking"', 'data-gap-block="power"', 'data-gap-block="admission"'].map((word) => card.indexOf(word));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `顺序：${order}`);
  assert.match(card, /排名表（对 SPY 总收益/);
  assert.match(card, /MDE80（功效）/);
  assert.match(card, /第 2 步准入（块组 A1\+A2/);
  // 页面按说明登记把代号 T3 换成中文题名（修订 5 E7.2）
  assert.match(card, /第 2 步候选：D\+A25\+[^<]*\+M-1（按 1\.96 准入）；按 2\.80 不准入（无候选）/);
});

test('页面：补充锁的文件漂移只让补充行写「校验未通过」，Q0 卡片照常', async () => {
  const file = writeSupp();
  impSupp(file);
  fs.appendFileSync(file, ' ');
  supp.clearCache();
  const view = await detail();
  const stress = stressOf(view);
  assert.equal(stress.state, 'AVAILABLE');
  const row2020 = stress.data.rows.find((row) => row.scenario === 'WINDOW_2020_02_19_04_30');
  assert.equal(row2020.supplement.state, 'INVALID');
  assert.match(row2020.supplement.line_zh, /补充（另行封存，Q0S-[0-9a-f]{16}）：封存结果校验未通过/);
  assert.deepEqual(row2020.supplement.reference_lines_zh, []);
  assert.equal(view.conclusion.completeness.stress_supplement_zh, undefined, '没有通过校验的补充不写「另有补充」');
});
