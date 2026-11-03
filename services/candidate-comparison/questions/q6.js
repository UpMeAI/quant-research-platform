'use strict';

/**
 * Q6（US_V5 M2 第二轮第 2 步：组合候选 D+A25+T3+M-1 对当前 D = D+A25+T3）的登记项，出自冻结的第 2 步 K2（1fc9c18b…）
 * 与协调会话冻结记录 US_V5_ROUND2_ITEMS_1_4_K2_FREEZE_1 第 1 项（★1–★6 全按推荐；★6 (a)：登记为 Q6，锁 `Q6-<sha16>`）。
 *
 *   - 原版臂是 Q5 的候选臂（D+A25+T3）：臂键 BASELINE_T3_A25，`identity.baseline_arm_ref` 按附录 3 第 2 节读（指向 Q5 当前的锁）；
 *   - 判据 G1′ / P_G / F3（★1 (a)）：G1′ = 两臂 OOS 成熟交易各 ≥ 30，且候选持有 SPY 的 session ≥ 30；δ_g 0，95%，单一比较；
 *     本题不报每笔 R 的门槛（M-1 不改逐笔），所以没有 δ_R；
 *   - 三态之外的「做 / 不做」（K2 §6.1，★3 (a)、★4 (a)）：`verdict.do_or_not` 的 N1–N4 逐条与文件里的数核对，结论按顺序推出；
 *     「做」的允许用途只有前向影子账本 US_V5_M1_SHADOW，不是生产采用；
 *   - `recommendation`（§6.3）只在「做（纸面 / 影子）」时有：第 1–4 项写是 / 否、第 5、6 项只列出；不推出采用建议（结论已由 §6.1 定）；
 *   - 前向：还没有行，只有冻结的 §7 原文（`forward_spec`），sha256 与仓库里的 K2 副本切出的那一节相同；
 *   - 2008「只停放 SPY」上界行（★5）：只报不判，单列，不进压力评价的完整性，也不进 N3；
 *   - 引用的锁（＋，同差距分解的 cited 读法）：差距分解 GAP、压力补充 Q0S、Q4 都要有锁、sha256 相符、是当前的锁。
 * 规格：docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_4.md。共用部件在 paired_g.js、report_only.js 与 q5.js。
 */
const {
  need, fail, isObject, E, finite, preferZh, sha256, canonical, stressBlock, resolveReasons, REASON_WORDS, edgeLabel, pct1, criteriaOf,
} = require('../common');
const paired = require('./paired_g');
const reportOnly = require('./report_only');
const { placeOf, FROZEN } = require('./basis');
const q5 = require('./q5');

const K2_REF = 'docs/contracts/US_V5_M2_R2_STEP2_COMBINED_K2_DRAFT_V1.md';
const K2_SHA256 = '1fc9c18bed82ba7e19a4c3e5afb29bcc7b051bcf2134ad8cdc179468920671ad';
/** 冻结记录不在 git 里，按 sha256 绑定（同增补 1 的做法）；文件里只核对它写的路径与项号。 */
const FREEZE = Object.freeze({ file: 'artifacts/coordinator/US_V5_ROUND2_ITEMS_1_4_K2_FREEZE_1.md', item: 1,
  sha256: 'e4bcc0cc81144327bf983b0d50d47b19eaff997b807ce9beb3d95bb3ed2574e3' });
/** 第 1 步（差距分解）的 K2 与勘误 1：运行器 ACCEPTANCE 门同时核对的两份文件（K2 §2）。 */
const STEP1 = Object.freeze({ k2: 'a161c5234f07d6cef182ccf21837be100a82be8f18b0184d6e393598814437cc', erratum: 'c17802e332a91d7ac539d1bb684427e0375f02c7bb0ae9a5aceed3728b019161' });
/**
 * K2 §7 原文：`sha256` 是从「## 7. 前向影子」到「## 8. 结果文件与 QRP」之前那一段（含结尾空行）的 sha256（研究会话运行器的算法），
 * `text_sha256` 是文件里去掉首尾空白的 `text_zh` 的 sha256。两个数都由仓库里的 K2 副本切出（测试核对）。
 */
const FORWARD_SPEC = Object.freeze({ section: '§7', sha256: '8e696d9e6d4d060649b604a619aa0c7817c03750193f5508486458665a35bfd7',
  text_sha256: '54de1f842eef7f5120e313e714e26733cc28d3bcdb903273345f72980a1b23b5' });

const BASE = 'BASELINE_T3_A25';
const CAND = 'CANDIDATE_M1_ON_T3_A25';
const MIN = 30;
const SHA64 = /^[0-9a-f]{64}$/;
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const DECISIONS = Object.freeze(['DO', 'DO_PAPER_SHADOW', 'NOT_DO']);
const DECISION_ZH = Object.freeze({ DO: '做', DO_PAPER_SHADOW: '做（纸面 / 影子）', NOT_DO: '不做' });
/** N3 只看真实历史行（K2 §6.1）：OOS 5 bps、IS、2022、2020、15 bps、相位 +60 分钟。上界行与风控维度行不进。 */
const N3_SCENARIOS = Object.freeze(['BASELINE', 'IS_2020_01_02_2022_12_30', 'WINDOW_2022_01_03_10_31', 'WINDOW_2020_02_19_04_30', 'COST_15BPS', 'SCAN_PHASE_PLUS_60MIN']);
const IS_SCENARIO = 'IS_2020_01_02_2022_12_30';
/** 引用的封存结果（K2 §8「身份」cited_results；★6 (a)）。 */
const CITED = Object.freeze({ GAP: 'GAP_DECOMPOSITION', Q0S: 'BASELINE_STRESS_SUPPLEMENT', Q4: 'COMPARISON' });

const CRITERIA = Object.freeze({
  G1_prime: { kind: 'met', title: '样本门（G1′）' },
  P_G: { kind: 'met', title: '账户年化对数增长差' },
  F3: { kind: 'triggered', title: '账户层面的上沿不高于 0' },
});

const REFERENCE_ROWS = Object.freeze({
  class: 'REFERENCE_ROWS',
  doc_key: 'reference_rows',
  codes: Object.freeze({ missing: 'REFERENCE_ROWS_MISSING', row_missing: 'REFERENCE_ROW_MISSING', in_verdict: 'REFERENCE_ROW_IN_VERDICT' }),
  rows: Object.freeze([
    Object.freeze({ key: 'REF_D', label_zh: '原版 D（Q0 的 D 臂）', n_optional: true }),
    Object.freeze({ key: 'REF_D_A25', label_zh: 'D+A25（Q4 的候选臂）', n_optional: true }),
    Object.freeze({ key: 'CANDIDATE_VS_REF_D', label_zh: '候选对原版 D：A25 + T3 + M-1 合起来', g_key: 'g_vs_reference', n_optional: true, g_against_zh: '对原版 D' }),
  ]),
  g_label_zh: '年化对数增长差（前两行对当前 D；最后一行对原版 D）',
  changed_label_zh: '改变的入场与出场',
  note_zh: '这三行只报不判：前两行与本题原版（当前 D = D+A25+T3）比较，最后一行与原版 D 比较；不进三态结论，也不进做 / 不做（第 2 步 K2 §5「参照行」）。',
});

/** 敞口附加行：两臂的冷却计数（同 Q5，两臂都是 A25），加候选的 SPY 停放（K2 §5「敞口」：SPY 名义分列）。 */
const SPY_ROW = (key, label, unit) => Object.freeze({ key, label_zh: label, unit_zh: unit, get: (arm) => (isObject(arm) ? arm[key] : undefined) });
const EXTRA_ROWS = Object.freeze([...q5.EXTRA_ROWS,
  SPY_ROW('spy_mean_notional_usd', '候选的 SPY 平均名义', 'USD'), SPY_ROW('spy_max_notional_usd', '候选的 SPY 最大名义', 'USD'),
  SPY_ROW('mean_parked_share', '候选的平均停放比例（占权益）', '')]);

const REASON_WORDS_Q6 = Object.freeze({
  ...paired.REASON_WORDS_PAIRED_G,
  OOS_REUSED_FOR_SELECTION: '样本外被用过：第 1 步正是在这段样本外上准入 M-1，本题的样本外比较受选择影响，不是独立确认',
  G1_PRIME_NOT_MET: '样本不够（G1′ 不满足）',
});

// ── 判定（G1′ 先判）──────────────────────────────────────────────────────────────

const g1Counts = (item) => [item.baseline_oos_trades, item.candidate_oos_trades, item.candidate_sessions_holding_spy];

function constants(entry, doc) {
  need(doc.verdict.delta_g === paired.DELTA_G, E(entry, 'VERDICT_DELTA_CHANGED'), `${doc.verdict.delta_g}`);
  need(isObject(doc.comparison), E(entry, 'COMPARISON_MISSING'));
}

/** 标签不能越过算术证据（同 Q5 的读法，G1 换成 G1′）；另核对三个判据的真假与文件里的数一致（＋）。 */
function checkVerdict(entry, doc, flags) {
  const verdict = doc.verdict;
  const { L_g, U_g } = paired.boundsOf(doc);
  const g1 = flags.G1_prime.item;
  const counts = g1Counts(g1);
  need(counts.every(finite), E(entry, 'CRITERIA_INCOMPLETE'), 'G1_prime 要写两臂成熟交易与候选持有 SPY 的 session 数');
  need(flags.G1_prime.flag === counts.every((value) => value >= MIN), E(entry, 'CRITERIA_INCONSISTENT'), `G1_prime.met=${flags.G1_prime.flag}，数 ${counts.join('/')}`);
  need(finite(L_g) && finite(U_g), E(entry, 'CRITERIA_INCOMPLETE'), 'L_g / U_g');
  need(flags.P_G.flag === (L_g > paired.DELTA_G), E(entry, 'CRITERIA_INCONSISTENT'), `P_G.met=${flags.P_G.flag}，L_g=${L_g}`);
  need(flags.F3.flag === (U_g <= paired.DELTA_G), E(entry, 'CRITERIA_INCONSISTENT'), `F3.triggered=${flags.F3.flag}，U_g=${U_g}`);
  if (verdict.state === 'SUPPORTED') {
    need(flags.G1_prime.flag === true && flags.P_G.flag === true && flags.F3.flag === false, E(entry, 'VERDICT_SUPPORTED_WITHOUT_EVIDENCE'), 'criteria');
    need(U_g > paired.DELTA_G, E(entry, 'VERDICT_SUPPORTED_VIOLATES_F3'), `U_g=${U_g}`);
    need(L_g > paired.DELTA_G, E(entry, 'VERDICT_SUPPORTED_WITHOUT_EVIDENCE'), `L_g=${L_g}`);
    need(counts.every((value) => value >= MIN), E(entry, 'VERDICT_SUPPORTED_SAMPLE_TOO_SMALL'), counts.join('/'));
    need(!(isObject(verdict.engine_approximation) && verdict.engine_approximation.flag === true), E(entry, 'VERDICT_SUPPORTED_ON_APPROXIMATE_ENGINE'));
  }
  if (verdict.state === 'NOT_PASSED') {
    need(flags.G1_prime.flag === true, E(entry, 'VERDICT_NOT_PASSED_WITHOUT_EVIDENCE'), 'G1′ 不成立时只能判证据不足');
    need(U_g <= paired.DELTA_G && flags.F3.flag === true, E(entry, 'VERDICT_NOT_PASSED_WITHOUT_EVIDENCE'), `U_g=${U_g}`);
  }
}

// ── 做 / 不做（K2 §6.1–§6.2）──────────────────────────────────────────────────────

const stressRowOf = (doc, scenario) => (Array.isArray(doc.stress.rows) ? doc.stress.rows.find((row) => isObject(row) && row.scenario === scenario) : null);
/** 某一行的两臂格；IS 行在 `stress.is_rows`。 */
function cellsOf(doc, scenario) {
  if (scenario === IS_SCENARIO) return isObject(doc.stress.is_rows) ? { base: doc.stress.is_rows[BASE], cand: doc.stress.is_rows[CAND] } : {};
  const row = stressRowOf(doc, scenario);
  return row && isObject(row.arms) ? { base: row.arms[BASE], cand: row.arms[CAND] } : {};
}
const close = (left, right) => finite(left) && finite(right) && Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(right));

function validateDoOrNot(entry, doc) {
  const d = doc.verdict.do_or_not;
  const bad = (detail) => fail(E(entry, 'DO_OR_NOT_INCONSISTENT'), detail);
  need(isObject(d) && DECISIONS.includes(d.decision) && Array.isArray(d.checks) && Array.isArray(d.triggered), E(entry, 'DO_OR_NOT_MISSING'),
    'verdict.do_or_not {decision, triggered, checks}');
  const byId = new Map(d.checks.filter(isObject).map((check) => [check.id, check]));
  need(['N1', 'N2', 'N3', 'N4'].every((id) => byId.has(id) && typeof byId.get(id).triggered === 'boolean'), E(entry, 'DO_OR_NOT_MISSING'), 'N1–N4 每条要写 triggered: true / false');
  const fired = ['N1', 'N2', 'N3', 'N4'].filter((id) => byId.get(id).triggered);
  if (canonical(d.triggered) !== canonical(fired)) bad(`triggered ${canonical(d.triggered)} ≠ ${canonical(fired)}`);

  const { L_g, U_g } = paired.boundsOf(doc);
  const g1 = isObject(doc.comparison.criteria) && isObject(doc.comparison.criteria.G1_prime) ? doc.comparison.criteria.G1_prime.met === true : false;
  if (byId.get('N1').triggered !== (g1 && U_g <= paired.DELTA_G)) bad('N1 与 G1′、U_g 不一致');
  const isG = isObject(doc.comparison.is) && isObject(doc.comparison.is.paired_g) ? doc.comparison.is.paired_g.g : undefined;
  need(finite(isG), E(entry, 'DO_OR_NOT_INCONSISTENT'), 'comparison.is.paired_g.g（N2 的输入）');
  if (byId.get('N2').triggered !== (isG <= 0)) bad(`N2 与 IS 配对 g ${isG} 不一致`);

  const n3 = byId.get('N3');
  need(Array.isArray(n3.rows) && canonical(n3.rows.map((row) => isObject(row) && row.scenario)) === canonical(N3_SCENARIOS), E(entry, 'DO_OR_NOT_INCONSISTENT'),
    `N3 的行必须正好是 ${N3_SCENARIOS.join('、')}`);
  for (const row of n3.rows) {
    const { cand } = cellsOf(doc, row.scenario);
    need(isObject(cand) && finite(cand.min_equity) && finite(cand.max_drawdown), E(entry, 'DO_OR_NOT_INCONSISTENT'), `N3 ${row.scenario}：压力表里没有候选格的最低权益与最大回撤`);
    if (!close(row.min_equity, cand.min_equity) || !close(row.max_drawdown, cand.max_drawdown)) bad(`N3 ${row.scenario} 的数与压力表候选格不同`);
    if (row.below_1800 !== (row.min_equity < 1800) || row.rule1_50pct !== (row.max_drawdown >= 0.5) || row.triggered !== (row.below_1800 || row.rule1_50pct)) {
      bad(`N3 ${row.scenario}：是否触及 1,800 / 50% 与数不一致`);
    }
  }
  if (n3.triggered !== n3.rows.some((row) => row.triggered)) bad('N3 与逐行不一致');

  const ends = ['COST_15BPS', 'SCAN_PHASE_PLUS_60MIN'].map((scenario) => {
    const { base, cand } = cellsOf(doc, scenario);
    need(isObject(base) && isObject(cand) && finite(base.end_capital) && finite(cand.end_capital), E(entry, 'DO_OR_NOT_INCONSISTENT'), `N4 ${scenario}：两臂期末`);
    return cand.end_capital < base.end_capital;
  });
  if (byId.get('N4').triggered !== ends.some(Boolean)) bad('N4 与 15 bps / 相位 +60 分钟两行的期末不一致');

  const expected = fired.length ? 'NOT_DO' : (L_g > paired.DELTA_G ? 'DO' : 'DO_PAPER_SHADOW');
  if (d.decision !== expected) bad(`decision=${d.decision}，按 §6.1 顺序应为 ${expected}`);
  need(isText(d.strength_zh) && isText(d.allowed_use_zh), E(entry, 'DO_OR_NOT_MISSING'), 'strength_zh / allowed_use_zh');
  const strengthHead = { DO: '有支持证据', DO_PAPER_SHADOW: '证据不足', NOT_DO: '触发' }[d.decision];
  if (!d.strength_zh.startsWith(strengthHead)) bad(`证据强度应以「${strengthHead}」开头（§6.2）`);
  // ★4 (a)：「做」只开前向影子，不是生产采用；「不做」没有允许用途
  if (d.decision === 'NOT_DO') need(d.allowed_use_zh.startsWith('无'), E(entry, 'DO_OR_NOT_ALLOWED_USE'), d.allowed_use_zh);
  else need(d.allowed_use_zh.includes('US_V5_M1_SHADOW') && d.allowed_use_zh.includes('不是生产采用'), E(entry, 'DO_OR_NOT_ALLOWED_USE'), d.allowed_use_zh);
}

/** §6.3：只在「做（纸面 / 影子）」时有；第 1–4 项写是 / 否，第 5、6 项只列出（`list_only: true`）。 */
function validateRecommendation(entry, doc) {
  const rec = doc.recommendation;
  if (doc.verdict.do_or_not.decision !== 'DO_PAPER_SHADOW') {
    need(rec === undefined || rec === null, E(entry, 'RECOMMENDATION_NOT_ALLOWED'), doc.verdict.do_or_not.decision);
    return;
  }
  need(isObject(rec) && Array.isArray(rec.checks), E(entry, 'RECOMMENDATION_MISSING'));
  const byId = new Map(rec.checks.filter(isObject).map((check) => [check.id, check]));
  need([1, 2, 3, 4, 5, 6].every((id) => byId.has(id)), E(entry, 'RECOMMENDATION_CHECKS_INCOMPLETE'), '第 1–6 项');
  need([1, 2, 3, 4].every((id) => typeof byId.get(id).yes === 'boolean'), E(entry, 'RECOMMENDATION_CHECKS_INCOMPLETE'), '第 1–4 项要写 yes: true／false');
  need([5, 6].every((id) => byId.get(id).list_only === true), E(entry, 'RECOMMENDATION_CHECKS_INCOMPLETE'), '第 5、6 项只列出（list_only: true）');
}

// ── 其余核对（＋）────────────────────────────────────────────────────────────────

function validateForwardSpec(entry, doc) {
  const spec = doc.forward_spec;
  need(isObject(spec) && isText(spec.text_zh), E(entry, 'FORWARD_SPEC_MISSING'));
  need(spec.section === FORWARD_SPEC.section && spec.sha256 === FORWARD_SPEC.sha256 && sha256(spec.text_zh) === FORWARD_SPEC.text_sha256,
    E(entry, 'FORWARD_SPEC_MISMATCH'), `${spec.section} ${String(spec.sha256).slice(0, 12)}…`);
}

const BOUND_NUMBERS = Object.freeze(['start_capital', 'end_capital', 'min_equity', 'max_drawdown', 'max_loss_usd', 'longest_underwater_sessions']);
/** ★5 的上界行：正好一行，模拟、只报不判；是否触及 1,800 / 50% 与它自己的数一致；数据是 identity 登记的 SPY.json。 */
function validateBound(entry, doc) {
  const rows = doc.stress.rows.filter((row) => isObject(row) && row.simulated_bound === true);
  need(rows.length === 1 && rows[0].scenario === 'SPY_PARK_2008_BOUND', E(entry, 'BOUND_ROW_INVALID'), `上界行 ${rows.length} 行`);
  const row = rows[0];
  need(row.simulated === true && row.in_verdict === false && BOUND_NUMBERS.every((key) => finite(row[key])), E(entry, 'BOUND_ROW_INVALID'), 'simulated / in_verdict / 数');
  need(row.below_1800 === (row.min_equity < 1800) && row.rule1_50pct_touched === (row.max_drawdown >= 0.5), E(entry, 'BOUND_ROW_INVALID'), '是否触及 1,800 / 50% 与数不一致');
  const spy = isObject(doc.inputs) && isObject(doc.inputs.spy_json) ? doc.inputs.spy_json.sha256 : null;
  need(isObject(row.source) && SHA64.test(row.source.sha256 || '') && row.source.sha256 === spy, E(entry, 'BOUND_ROW_INVALID'), 'source.sha256 ≠ inputs.spy_json');
}

/** 冻结记录、第 1 步 K2、引用的形状、参照行的来源与披露（文件内核对；锁与 INPUTS 门的 sha256 在 checkLedger）。 */
function validateIdentity(entry, doc) {
  const id = doc.identity;
  const freeze = isObject(id.k2) ? id.k2.freeze : null;
  need(isObject(freeze) && freeze.file === FREEZE.file && freeze.item === FREEZE.item, E(entry, 'K2_FREEZE_MISMATCH'), isObject(freeze) ? `${freeze.file}#${freeze.item}` : null);
  need(isObject(id.k2_step1) && id.k2_step1.now === STEP1.k2 && isObject(id.erratum_step1) && id.erratum_step1.now === STEP1.erratum, E(entry, 'K2_SHA_MISMATCH'), '第 1 步 K2 / 勘误 1');
  const cited = id.cited_results;
  need(isObject(cited) && canonical(Object.keys(cited).sort()) === canonical(Object.keys(CITED).sort())
    && Object.keys(CITED).every((key) => isObject(cited[key]) && isText(cited[key].result_id) && SHA64.test(cited[key].sha256 || '')),
  E(entry, 'CITED_RESULTS_INCOMPLETE'), isObject(cited) ? Object.keys(cited).join(',') : null);
  const refRow = (key) => doc.reference_rows.find((row) => isObject(row) && row.key === key) || {};
  need(refRow('REF_D').source_result_id === id.baseline_result_id && refRow('REF_D_A25').source_result_id === cited.Q4.result_id,
    E(entry, 'REFERENCE_ROW_SOURCE_MISMATCH'), `${refRow('REF_D').source_result_id} / ${refRow('REF_D_A25').source_result_id}`);
  need(Array.isArray(doc.disclosures_zh) && doc.disclosures_zh.length && doc.disclosures_zh.every(isText), E(entry, 'DISCLOSURES_MISSING'));
}

function validateExtras(entry, doc) {
  paired.validateExposure(entry, doc);
  q5.validateCooldownCounts(entry, doc);
  reportOnly.validateReportOnly(entry, doc);
  validateIdentity(entry, doc);
  validateBound(entry, doc);
  validateDoOrNot(entry, doc);
  validateRecommendation(entry, doc);
}

// ── 账本核对：引用的锁（导入时，在 Q0 与原版臂来源之后）──────────────────────────────────

/**
 * ＋（同差距分解对 Q1–Q5 的 cited 读法）：差距分解、压力补充与 Q4 都要有锁、是那一类、sha256 相符、是当前的锁；
 * 差距分解的结论必须是「有候选」，原版臂来源与本文件是同一把 Q5 锁；压力补充与本文件是同一个 Q0 基线；
 * INPUTS 门里 Q0、Q5、GAP、Q0S、Q4 的 sha256 等于锁与引用。
 * 服务按需加载（差距分解服务自己引用候选对比服务）。
 */
function checkLedger(entry, doc, caseRef, { baselineLock, comparison }) {
  const gap = require('../../gap-decomposition');
  const supp = require('../../baseline-stress-supplement');
  const cited = doc.identity.cited_results;
  const check = (key, lock, head) => {
    need(lock && lock.case_ref === caseRef, E(entry, 'CITED_RESULT_LOCK_NOT_FOUND'), `${key}:${cited[key].result_id}`);
    need(lock.file_sha256 === cited[key].sha256, E(entry, 'CITED_RESULT_SHA256_MISMATCH'), `${key}:${cited[key].result_id}`);
    need(head && head.result_id === lock.result_id, E(entry, 'CITED_RESULT_NOT_CURRENT'), `${lock.result_id} 已被 ${head ? head.result_id : '无'} 取代`);
  };
  const gapLock = gap.locks(caseRef).find((row) => row.result_id === cited.GAP.result_id);
  check('GAP', gapLock, gap.headLock(caseRef));
  need(gapLock.decision === 'CANDIDATE', E(entry, 'CITED_GAP_NOT_CANDIDATE'), gapLock.decision);
  need(isObject(gapLock.base_arm_ref) && gapLock.base_arm_ref.result_id === doc.identity.baseline_arm_ref.result_id, E(entry, 'CITED_GAP_BASE_ARM_DIFFERS'),
    `${isObject(gapLock.base_arm_ref) ? gapLock.base_arm_ref.result_id : '无'}≠${doc.identity.baseline_arm_ref.result_id}`);
  const suppLock = supp.locks(caseRef).find((row) => row.result_id === cited.Q0S.result_id);
  check('Q0S', suppLock, suppLock && supp.headLock(caseRef, suppLock.baseline_result_id, suppLock.scenario));
  need(suppLock.baseline_result_id === baselineLock.result_id, E(entry, 'CITED_Q0S_BASELINE_DIFFERS'), `${suppLock.baseline_result_id}≠${baselineLock.result_id}`);
  const q4Lock = comparison.comparisonFor(cited.Q4.result_id);
  check('Q4', q4Lock && q4Lock.question_ref === 'Q4' ? q4Lock : null, comparison.headLock(caseRef, 'Q4'));
  // INPUTS 门里运行器核对过的封存结果 sha256，与锁、原版臂来源、引用逐一相同
  const sealed = isObject(doc.gates.INPUTS) && Array.isArray(doc.gates.INPUTS.sealed) ? doc.gates.INPUTS.sealed : [];
  const want = { Q0: baselineLock.file_sha256, Q5: doc.identity.baseline_arm_ref.sha256, ...Object.fromEntries(Object.keys(CITED).map((key) => [key, cited[key].sha256])) };
  for (const [input, value] of Object.entries(want)) {
    const item = sealed.find((row) => isObject(row) && row.input === input);
    need(item && item.expect === value && item.now === value, E(entry, 'INPUTS_SEALED_MISMATCH'), input);
  }
}

// ── 锁的摘要 ────────────────────────────────────────────────────────────────────

/**
 * 本题的输入不是逐个序列登记（Q0 的 `inputs.series`），而是 A1 缓存清单、两组扫描信号、封存结果与证明文件的 sha256（K2 §4、§5「运行门 INPUTS」）。
 * inputs_digest = 这些 sha256 的规范化摘要；engine_digest 同 Q0 的算法（smartflow 提交 + 引擎文件表）。
 */
function digestsOf(entry, doc) {
  const inputs = doc.inputs;
  const shaMap = (value) => isObject(value) && Object.keys(value).length > 0 && Object.values(value).every((item) => SHA64.test(item || ''));
  need(isObject(inputs) && isObject(inputs.manifest) && SHA64.test(inputs.manifest.sha256 || '') && shaMap(inputs.signals) && shaMap(inputs.signals_q4)
    && Array.isArray(inputs.sealed) && inputs.sealed.length && inputs.sealed.every((row) => isObject(row) && isText(row.input) && SHA64.test(row.expect || ''))
    && isObject(inputs.floor_attestation) && SHA64.test(inputs.floor_attestation.sha256 || '') && isObject(inputs.spy_json) && SHA64.test(inputs.spy_json.sha256 || ''),
  E(entry, 'INPUTS_INCOMPLETE'));
  const engine = doc.identity.engine_files;
  need(isObject(engine) && Object.keys(engine).length && Object.values(engine).every((value) => /^[0-9a-f]{40,64}$/.test(value)), E(entry, 'ENGINE_BLOBS_MISSING'));
  const smartflow = doc.identity.smartflow_commit;
  need(/^[0-9a-f]{40}$/.test(smartflow || ''), E(entry, 'SMARTFLOW_COMMIT_MISSING'));
  return {
    inputs_digest: sha256(canonical({
      manifest: inputs.manifest.sha256, signals: Object.entries(inputs.signals).sort(), signals_q4: Object.entries(inputs.signals_q4).sort(),
      sealed: inputs.sealed.map((row) => [row.input, row.expect]).sort(), floor_attestation: inputs.floor_attestation.sha256, spy_json: inputs.spy_json.sha256,
    })),
    engine_digest: sha256(canonical({ smartflow, files: Object.entries(engine).sort() })),
  };
}

// ── 块与卡 ──────────────────────────────────────────────────────────────────────

const num = (value, digits) => (finite(value) ? `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}` : '—');
const money = (value) => (finite(value) ? `${value < 0 ? '−' : ''}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD` : '—');
const share = (value) => (finite(value) ? `${(value * 100).toFixed(2)}%` : '—');

/** 判定依据：G1′ 不成立时写它；成立时写区间在门槛上的位置（同 Q5 的写法）。 */
function basisOf(entry, doc, flags) {
  const { L_g, U_g } = paired.boundsOf(doc);
  const g1 = flags.G1_prime.item;
  const gLine = finite(L_g) && finite(U_g) ? `候选相对原版的年化对数增长差 95% 区间 ${pct1(L_g)} 至 ${pct1(U_g)}，${placeOf(L_g, U_g, paired.DELTA_G)} ${paired.DELTA_G}` : null;
  const counts = `原版 ${g1.baseline_oos_trades} 笔、候选 ${g1.candidate_oos_trades} 笔，候选持有 SPY ${g1.candidate_sessions_holding_spy} 个 session；门槛各 ${MIN}`;
  if (flags.G1_prime.flag !== true) return { title: '判定依据', main: [`G1′ 不成立：${counts}`], also: gLine ? [gLine] : [], frozen_zh: FROZEN };
  return { title: '判定依据', main: gLine ? [`${gLine}；G1′ 成立（${counts}）`] : [], also: [], frozen_zh: FROZEN };
}

/** 上界行的页面格：只有一组数（不是两臂），写「只报不判」。 */
const boundRow = (row) => ({
  scenario: row.scenario, label: preferZh(row, 'label') || row.scenario, role: 'BOUND', kind: 'BOUND', kind_label: null, reason: null, simulated: true,
  baseline: null, candidate: null, diff: null, candidate_missing: false, note: '上界情景，不是本策略的回放；只报不判，不进 N3',
  bound: { window: row.window, end_capital: row.end_capital, min_equity: row.min_equity, min_equity_day: row.min_equity_day || null, max_drawdown: row.max_drawdown,
    max_loss_usd: row.max_loss_usd, longest_underwater_sessions: row.longest_underwater_sessions, below_1800: row.below_1800, rule1_50pct_touched: row.rule1_50pct_touched },
});

/** 做 / 不做卡（K2 §6）：结论、证据强度、允许用途、N1–N4 逐条，再写功效、收回率、停放与必须随候选披露的事实；只排版，不重算。 */
function doOrNotCard(entry, doc) {
  const d = doc.verdict.do_or_not;
  const p = doc.power_first || {};
  const real = isObject(p.realized) ? p.realized : {};
  const r = isObject(doc.comparison.recovery) ? doc.comparison.recovery : {};
  const ded = isObject(r.deductions) ? r.deductions : {};
  const park = isObject(doc.comparison.parking) && isObject(doc.comparison.parking.oos) ? doc.comparison.parking.oos : {};
  const isG = doc.comparison.is && doc.comparison.is.paired_g;
  const lines = [
    { label: '功效（运行前）', text: `MDE80 ${num(p.mde80, 4)} /年，天花板 ${num(p.ceiling_g, 4)}（天花板 ÷ MDE80 = ${num(p.ceiling_over_mde80, 3)}）；${isText(p.expected_zh) ? p.expected_zh : ''}` },
    { label: '实现后', text: `配对 g ${num(real.paired_g, 4)}，SE ${num(real.se_boot, 4)}，z ${num(real.z, 2)}；前向要约 ${num(real.forward_years_for_80pct_at_ceiling, 1)} 年才有 80% 功效看见天花板大小的效应` },
    { label: '收回率', text: `收回率 ${finite(r.recovery_pct) ? `${r.recovery_pct.toFixed(2)}%` : '—'}（配对 g ÷ 天花板 ${num(r.ceiling_g, 5)}）；扣减合计 ${num(ded.total, 4)}：不计分红 ${num(ded.dividends_g, 4)}、SPY 费用 ${num(ded.spy_fees_g, 4)}（这两项精确），到价出场后的等待现金 ${num(ded.waiting_cash_g_approx, 4)}、其余 ${num(ded.rest_g, 4)}（近似拆分）` },
    { label: 'IS 配对 g（只作同号检查）', text: isObject(isG) ? `${num(isG.g, 4)}（95% ${num(isG.ci95 && isG.ci95[0], 4)} 至 ${num(isG.ci95 && isG.ci95[1], 4)}）` : '—' },
    { label: '停放（样本外）', text: `平均停放比例 ${share(park.mean_parked_share)}；SPY 成交 ${finite(park.spy_fills) ? park.spy_fills : '—'} 笔，费用 ${money(park.spy_fees_usd)}；持有 SPY ${finite(park.sessions_holding_spy) ? park.sessions_holding_spy : '—'} / ${finite(park.sessions) ? park.sessions : '—'} 个 session；最大 SPY 名义 ${money(park.max_spy_notional_usd)}；由卖 SPY 供款的入场 ${finite(park.entries_funded_by_spy_sale) ? park.entries_funded_by_spy_sale : '—'} 笔` },
  ];
  const rec = doc.recommendation;
  const mark = (check) => (check.list_only === true ? '只列出' : (check.yes === true ? '是' : (check.yes === false ? '否' : '—')));
  return {
    class: 'DO_OR_NOT', decision: d.decision, decision_zh: DECISION_ZH[d.decision], triggered: [...d.triggered], strength_zh: d.strength_zh, allowed_use_zh: d.allowed_use_zh,
    order_zh: isText(d.order_zh) ? d.order_zh : null,
    checks: d.checks.filter(isObject).map((check) => ({ id: check.id, rule: isText(check.rule_zh) ? check.rule_zh : '', triggered: check.triggered, facts: isText(check.facts_zh) ? check.facts_zh : '' })),
    lines,
    recommendation: isObject(rec) ? {
      checks: rec.checks.filter(isObject).map((check) => ({ id: check.id, item: isText(check.item_zh) ? check.item_zh : '', mark: mark(check), facts: isText(check.facts_zh) ? check.facts_zh : '' })),
      analysis: Array.isArray(rec.market_analysis_zh) ? rec.market_analysis_zh.filter(isText) : [], text: isText(rec.recommendation_zh) ? rec.recommendation_zh : null,
    } : null,
    production_note_zh: isText(doc.production_note_zh) ? doc.production_note_zh : null,
    disclosures: doc.disclosures_zh.filter(isText),
    note_zh: '第 2 步 K2 §6 预先登记：先判运行门；N1–N4 任一成立 → 不做；否则 95% 下沿 > 0 → 做；否则 → 做（纸面 / 影子）。「做」只开带标注的前向影子账本，不是生产采用（★4 (a)）。',
  };
}

function builders(entry, doc) {
  const base = paired.builders(entry, doc);
  return {
    /** 样本外说明只取 `reason_zh`：文件的 detail 里还有 `is_reuse` 这类英文码，主内容不出现原样的英文原因码（修订 4 D5.2）。 */
    question() {
      const data = base.question();
      const zh = isObject(doc.oos_reuse_detail) ? preferZh(doc.oos_reuse_detail, 'reason') : null;
      return { ...data, oos_reuse: { ...data.oos_reuse, detail_zh: isText(zh) ? zh.trim() : data.oos_reuse.detail_zh } };
    },
    effect: base.effect,
    exposure: base.exposure,
    criteria() {
      const flags = criteriaOf(entry, doc);
      const { L_g, U_g } = paired.boundsOf(doc);
      const g1 = flags.G1_prime.item;
      const text = {
        G1_prime: `${entry.texts.g1_rule}原版 ${g1.baseline_oos_trades} 笔；候选 ${g1.candidate_oos_trades} 笔；候选持有 SPY ${g1.candidate_sessions_holding_spy} 个 session。`,
        P_G: `候选相对原版的年化对数增长差，95% 区间的下沿要大于 0。${finite(L_g) ? `下沿 ${(L_g * 100).toFixed(2)}%。` : ''}`,
        F3: `否决：账户年化对数增长差的 95% 区间上沿不高于 0。${finite(U_g) ? `上沿 ${(U_g * 100).toFixed(2)}%。` : ''}`,
      };
      return {
        rows: Object.entries(entry.criteria).map(([key, spec]) => {
          const flag = flags[key].flag;
          return { key: key === 'G1_prime' ? 'G1′' : key, title: spec.title, kind: spec.kind, flag,
            state_label: spec.kind === 'met' ? (flag ? '成立' : '不成立') : (flag ? '触发' : '未触发'),
            tone: spec.kind === 'met' ? (flag ? 'ok' : 'bad') : (flag ? 'bad' : 'ok'), text: text[key] };
        }),
      };
    },
    verdict() {
      const v = doc.verdict;
      const resolved = resolveReasons(v.reason_codes, entry.reason_words, REASON_WORDS);
      const { L_g, U_g } = paired.boundsOf(doc);
      return {
        layout: 'paired_g', class: v.class, state: v.state, label: edgeLabel(entry, v.state), delta_g: paired.DELTA_G, delta_R: null,
        basis: basisOf(entry, doc, criteriaOf(entry, doc)),
        g_95: finite(L_g) && finite(U_g) ? { lo: L_g, hi: U_g } : null, fail_label: null,
        reasons: resolved.known, unknown_reason_codes: resolved.unknown, method_zh: entry.texts.method,
        caveat_zh: '「有支持证据」在这里的意思是完整账户的对数增长更好，且受选择影响（样本外已用于选块），不说明闲置现金停放 SPY 在别的时期也赚钱；做 / 不做见下面的卡。',
      };
    },
    /** 压力表：上界行不是两臂比较，从通用读法里拿出来单列在最后；计数另加 `bound`，也算一行模拟。 */
    stress() {
      const rows = doc.stress.rows;
      const bounds = rows.filter((row) => isObject(row) && row.simulated_bound === true);
      const data = stressBlock(entry, { ...doc, stress: { ...doc.stress, rows: rows.filter((row) => !(isObject(row) && row.simulated_bound === true)) } });
      data.rows.push(...bounds.map(boundRow));
      data.counts = { ...data.counts, simulated: data.counts.simulated + bounds.length, bound: bounds.length };
      return data;
    },
    /** 前向：还没有行；写明影子账本尚未开始，附冻结的 §7 原文。 */
    forward() {
      const spec = doc.forward_spec;
      need(isObject(spec) && isText(spec.text_zh), 'MISSING', 'forward_spec');
      return {
        label: '前向，只报不判，不并入结论', rows: [],
        reason_zh: '前向影子账本 US_V5_M1_SHADOW 尚未开始：起点是实现上线后的第一个扫描时点，实现另立工程任务，由协调会话安排；规则已在 K2 §7 冻结。',
        spec: { section: spec.section, sha256: spec.sha256, lines_zh: spec.text_zh.split('\n').map((line) => line.trim()).filter(Boolean) },
      };
    },
  };
}

const Q6 = Object.freeze({
  question_ref: 'Q6',
  code_prefix: 'Q6',
  schema: 'US_V5_M2_R2_STEP2_COMBINED_V1',
  queue_order: 6,
  title_zh: '组合验证：在当前 D 之上，闲置现金停放 SPY', // 修订 5 E7.2：标题不带内部代号（M-1、A25、T3 留在 K2 与技术详情里）
  k2: Object.freeze({ ref: K2_REF, sha256: K2_SHA256 }),
  freeze: FREEZE,
  profile_ref: 'docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_4.md',
  pending_status_zh: null,
  top_level: Object.freeze(['identity', 'power_first', 'inputs', 'gates', 'arms', 'stats', 'stress', 'half_kelly', 'formula_table', 'verdict',
    'reproducibility', 'comparison', 'oos_reuse', 'oos_reuse_detail', 'reference_rows', 'forward_spec', 'disclosures_zh']),
  baseline_arm: Object.freeze({
    keys: Object.freeze([BASE]), label_zh: '原版（当前 D = D+A25+T3）',
    ref: Object.freeze({ question_ref: 'Q5', arm: 'CANDIDATE_T3_ON_A25' }),
  }),
  candidate: Object.freeze({ key: CAND, keys: Object.freeze([CAND]), label_zh: '候选：当前 D 再加闲置现金停放 SPY', deferred_sessions: false }),
  /** 现金臂只有摘要（封存文件照 Q5 只抄了摘要）：账户块只核对摘要，不画序列（附录 4 §1）。 */
  summary_only_comparators: Object.freeze(['CASH']),
  run_gates: Object.freeze(['ACCEPTANCE', 'INPUTS', 'INERT_TEST', 'ENGINE_STRIP', 'PARITY_M1_OFF', 'BASELINE_REPRO_D', 'M1_FLAT_SPY_IDENTITY',
    'CASH_IDENTITY', 'SPY_FEES', 'REPRO', 'MEM']),
  mirror: null,
  oos_reuse: Object.freeze({
    expected: true, reason_code: 'OOS_REUSED_FOR_SELECTION', detail_required: true,
    label_zh: '样本外被用过：第 1 步在同一段样本外上准入了闲置现金停放 SPY',
    adoption_zh: '「做」只开带标注的前向影子账本 US_V5_M1_SHADOW；进生产属第 1 类修订，需 Owner 签字并满足 K2 §6.4 四个前提',
  }),
  attribution: Object.freeze({ required: false }),
  exposure: Object.freeze({ required: true, extra_counts: Object.freeze({ baseline: Object.freeze([]), candidate: Object.freeze([]) }), extra_rows: EXTRA_ROWS }),
  report_only: REFERENCE_ROWS,
  criteria: CRITERIA,
  cited: CITED,
  forward_spec: FORWARD_SPEC,
  texts: Object.freeze({
    candidate_default: '候选 D+A25+T3+M-1：当前 D 加闲置现金停放 SPY；入场、出场、仓位与风控规则都不变',
    oos_label: '第 1 步正是在 2023-01-03 → 2026-10-23 这段样本外上，因为空仓日与在场未投入两块显著才准入闲置现金停放 SPY；本题在这段上的比较受选择影响，不是独立确认',
    oos_pill: '样本外被用过',
    oos_tone: 'DEGRADED',
    exposure_note: '两臂的 US_V5 部分同 Q4 / Q5 键名（两臂都是冷却只在开仓时武装）；候选另列 SPY 停放的名义与比例，SPY 不进 US_V5 的任何风控计数',
    g1_rule: '样本要够（G1′）：两臂样本外成熟交易各 ≥ 30 笔，且候选持有 SPY 的 session ≥ 30 个。',
    changed_label: '候选持有 SPY 的 session',
    method: '只按账户层面配对的年化对数增长差判定，先判 G1′：G1′ 不成立一律证据不足；G1′ 成立时 95% 区间下沿大于 0 为有支持证据，上沿不高于 0 为未通过，其余为证据不足；单一比较，不做多重比较校正。做 / 不做另按 K2 §6.1 的 N1–N4 与顺序推出。',
  }),
  blocks: Object.freeze([
    ['question', '这个对比在问什么'], ['account', '账户结果：原版与候选'], ['effect', '账户对数增长'],
    ['exposure', '敞口变化披露（两臂含冷却计数；候选另列 SPY 停放）'], ['criteria', '判据逐条'], ['stress', '压力：两臂逐行对比，另有 2008 只停放 SPY 上界行'],
    ['verdict', '三态结论与采用条件'], ['forward', '前向观察'],
  ]),
  extra_cards: Object.freeze([
    Object.freeze({ key: 'reference_rows', title_zh: '参照行（只报不判：原版 D、D+A25、候选对原版 D）', build: reportOnly.card }),
    Object.freeze({ key: 'do_or_not', title_zh: '做 / 不做（K2 §6：N1–N4 逐条、证据强度与允许用途）', build: doOrNotCard }),
  ]),
  reason_words: REASON_WORDS_Q6,
  edge_labels: Object.freeze({ SUPPORTED: '完整账户的对数增长更好（受选择影响；不等于信号 alpha 更大）' }),
  constants,
  checkVerdict,
  validateExtras,
  validateForward: validateForwardSpec,
  checkLedger,
  digests: digestsOf,
  builders,
});

module.exports = { Q6, K2_REF, K2_SHA256, FREEZE, STEP1, FORWARD_SPEC, N3_SCENARIOS, validateDoOrNot };
