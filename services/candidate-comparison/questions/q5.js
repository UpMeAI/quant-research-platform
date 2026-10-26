'use strict';

/**
 * Q5（组合验证：在 A25 之上加 T3，D+A25+T3 对 D+A25）的登记项，出自冻结的 Q5 K2（30d74326…）与裁定 ★1–★4 (a)。
 *
 *   - 原版臂不是 Q0 的 D，而是 Q4 的候选臂（D+A25）：臂键 BASELINE_A25，`identity.baseline_arm_ref` 指向 Q4 当前的锁
 *     （导入器核对锁存在、当前、sha256 相符、同一个 Q0 基线、原版臂摘要与所引那一臂逐项相同）；Q0 锁仍是 D 的基线；
 *   - 主卡：候选臂 CANDIDATE_T3_ON_A25；只按账户层面配对 g 判（95%，G1 先判；98.33% 区间只报不判，★2 (a)），δ_g 0、δ_R 0.10；
 *     G1 的「改变」= 改变的入场 + 改变的出场（`changed_total`，★1 (a)）；必填敞口，两臂都有冷却计数（两臂都是 A25）；
 *   - oos_reuse 必须是 true 且带 OOS_REUSED_FOR_SELECTION（T3 凭这段 OOS 被选出，A25 在同一 OOS 上评价过，点估计在定题时可见）；
 *   - reference_rows：原版 D、D+T3、组合对原版 D，只报不判，单独一张卡；
 *   - recommendation：只在证据不足时有，按 ★3 (a) 的六项核对（前 4 项全「是」→ 建议采用，任一「否」→ 建议不采用；第 5、6 项是反证，
 *     只列出）；导入器只核对「建议与前 4 项一致」，不替 Owner 决定（UX 修订 6：决定记录由协调会话另写）。
 * 规格：docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_3.md。共用部件在 paired_g.js 与 report_only.js。
 */
const { need, isObject, E } = require('../common');
const paired = require('./paired_g');
const reportOnly = require('./report_only');

const K2_REF = 'docs/contracts/US_V5_M2_Q5_T3_ON_A25_COMBINATION_K2_V1.md';
const K2_SHA256 = '30d743264e2e93257e16384e0b2432d8688ed591521a85cd76cad7a0c423f457';

const REFERENCE_ROWS = Object.freeze({
  class: 'REFERENCE_ROWS',
  doc_key: 'reference_rows',
  codes: Object.freeze({ missing: 'REFERENCE_ROWS_MISSING', row_missing: 'REFERENCE_ROW_MISSING', in_verdict: 'REFERENCE_ROW_IN_VERDICT' }),
  rows: Object.freeze([
    Object.freeze({ key: 'REF_D', label_zh: '原版 D（Q0 的 D 臂）' }),
    Object.freeze({ key: 'REF_D_T3', label_zh: 'D+T3（Q1 的候选臂）' }),
    Object.freeze({ key: 'COMBINED_VS_D', label_zh: '组合 D+A25+T3 对原版 D', g_key: 'g_vs_reference', n_optional: true, g_against_zh: '对原版 D' }),
  ]),
  g_label_zh: '年化对数增长差（前两行对 D+A25；组合行对原版 D）',
  changed_label_zh: '改变的入场与出场',
  note_zh: '这三行只报不判：前两行与本题原版（D+A25）比较，组合行与原版 D 比较；不进三态结论，也不进采用条件（Q5 K2「参照行」）。',
});

const split = (arm, path) => path.reduce((x, k) => (isObject(x) ? x[k] : undefined), arm);
const SPLIT = (label, path, part) => Object.freeze({ key: `${path.join('.')}.${part}`, label_zh: label, unit_zh: '个', get: (arm) => split(arm, [...path, part]) });
const EXTRA_ROWS = Object.freeze([
  SPLIT('冷却挡下的信号（开盘扫描）', ['cooldown_blocked_signals'], 'open_scan'),
  SPLIT('冷却挡下的信号（其他扫描）', ['cooldown_blocked_signals'], 'other'),
  SPLIT('未武装的冷却：闸门拒绝（开盘扫描）', ['arms_not_set', 'gate_refusal'], 'open_scan'),
  SPLIT('未武装的冷却：闸门拒绝（其他扫描）', ['arms_not_set', 'gate_refusal'], 'other'),
  SPLIT('未武装的冷却：其他未开仓（开盘扫描）', ['arms_not_set', 'other_no_open'], 'open_scan'),
  SPLIT('未武装的冷却：其他未开仓（其他扫描）', ['arms_not_set', 'other_no_open'], 'other'),
]);

const REASON_WORDS_Q5 = Object.freeze({
  ...paired.REASON_WORDS_PAIRED_G,
  OOS_REUSED_FOR_SELECTION: '样本外被用过：T3 凭这段样本外被选为领先变体，A25 在同一段上评价过，本题的点估计在定题时已经可见',
});

const count = (value) => Number.isInteger(value) && value >= 0;
/** 两臂都是 A25：都要有冷却挡下的信号数与未武装的冷却数，形状坏了就拒绝（同敞口披露）。 */
function validateCooldownCounts(entry, doc) {
  const exposure = paired.exposureOf(entry, doc);
  for (const [label, keys] of [[entry.baseline_arm.keys[0], entry.baseline_arm.keys], [entry.candidate.key, entry.candidate.keys]]) {
    const arm = keys.map((key) => exposure[key]).find(isObject);
    for (const path of [['cooldown_blocked_signals'], ['arms_not_set', 'gate_refusal'], ['arms_not_set', 'other_no_open']]) {
      const node = split(arm, path);
      need(isObject(node) && count(node.open_scan) && count(node.other), E(entry, 'EXPOSURE_DISCLOSURE_INVALID'), `${label}.${path.join('.')}`);
    }
  }
}

const CHECK_IDS = Object.freeze([1, 2, 3, 4, 5, 6]);
const DECISIVE = Object.freeze([1, 2, 3, 4]);
/** 勘误 1 的两种读法：冻结原文的读法（主建议）在前，第一版运行器的较严读法在后。 */
const READINGS = Object.freeze(['FROZEN_TEXT', 'RUNNER_STRICT_48EF9888']);
/**
 * ★3 (a)：证据不足时必须有建议，且建议与前 4 项一致（全「是」→ ADOPT，任一「否」→ NOT_ADOPTED）；第 5、6 项是反证，只列出。
 * 不是证据不足时不许有建议（有支持证据 → 采用路径；未通过 → 不采用；都不需要这张核对表）。
 */
function validateRecommendation(entry, doc) {
  const rec = doc.recommendation;
  if (doc.verdict.state !== 'INSUFFICIENT') {
    need(rec === undefined || rec === null, E(entry, 'RECOMMENDATION_NOT_ALLOWED'), doc.verdict.state);
    return;
  }
  need(isObject(rec) && Array.isArray(rec.checks), E(entry, 'RECOMMENDATION_MISSING'));
  const byId = new Map(rec.checks.filter(isObject).map((check) => [check.id, check]));
  need(CHECK_IDS.every((id) => byId.has(id)), E(entry, 'RECOMMENDATION_CHECKS_INCOMPLETE'), CHECK_IDS.filter((id) => !byId.has(id)).join(','));
  need(DECISIVE.every((id) => typeof byId.get(id).yes === 'boolean'), E(entry, 'RECOMMENDATION_CHECKS_INCOMPLETE'), '第 1–4 项要写 yes: true／false');
  const expected = DECISIVE.every((id) => byId.get(id).yes) ? 'ADOPT' : 'NOT_ADOPTED';
  need(rec.recommendation === expected, E(entry, 'RECOMMENDATION_INCONSISTENT'), `${rec.recommendation}≠${expected}`);
  // K2 勘误 1（裁定 (b) 的条件 3）：两种读法并列——冻结原文的读法（主建议，与上面的核对表相同）与第一版运行器的较严读法；
  // 每种读法自己的建议也必须与它的第 1–4 项一致
  need(Array.isArray(rec.readings) && READINGS.every((key) => rec.readings.some((r) => isObject(r) && r.key === key)), E(entry, 'RECOMMENDATION_READINGS_MISSING'),
    READINGS.join('、'));
  for (const reading of rec.readings.filter(isObject)) {
    const items = new Map((Array.isArray(reading.checks) ? reading.checks : []).filter(isObject).map((check) => [check.id, check]));
    need(DECISIVE.every((id) => items.has(id) && typeof items.get(id).yes === 'boolean'), E(entry, 'RECOMMENDATION_CHECKS_INCOMPLETE'), `readings.${reading.key}`);
    const own = DECISIVE.every((id) => items.get(id).yes) ? 'ADOPT' : 'NOT_ADOPTED';
    need(reading.recommendation === own, E(entry, 'RECOMMENDATION_INCONSISTENT'), `readings.${reading.key}: ${reading.recommendation}≠${own}`);
  }
  const main = rec.readings.find((r) => isObject(r) && r.key === READINGS[0]);
  need(main.recommendation === rec.recommendation, E(entry, 'RECOMMENDATION_INCONSISTENT'), '主建议必须是冻结原文的读法');
}

/** 建议卡：六项逐条（第 5、6 项标「反证，只列出」）与建议；不是证据不足时写「本题不需要」。 */
function recommendationCard(entry, doc) {
  const rec = doc.recommendation;
  if (doc.verdict.state !== 'INSUFFICIENT') {
    return { class: 'RECOMMENDATION', applicable: false, checks: [], note_zh: '只有证据不足时才按 ★3 (a) 给采用建议；本题的结论不是证据不足，采用按结论本身走。' };
  }
  need(isObject(rec) && Array.isArray(rec.checks), 'MISSING', 'recommendation');
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    class: 'RECOMMENDATION', applicable: true,
    checks: rec.checks.filter(isObject).map((check) => ({ id: check.id, item: text(check.item_zh), counter: check.counter === true,
      yes: typeof check.yes === 'boolean' ? check.yes : null, facts: text(check.facts_zh) })),
    recommendation: rec.recommendation, recommendation_zh: text(rec.recommendation_zh),
    readings: (Array.isArray(rec.readings) ? rec.readings : []).filter(isObject).map((reading) => {
      const item4 = (Array.isArray(reading.checks) ? reading.checks : []).find((check) => isObject(check) && check.id === 4) || {};
      return { key: reading.key, label: text(reading.label_zh), item4_yes: typeof item4.yes === 'boolean' ? item4.yes : null, item4_rule: text(item4.rule_zh),
        recommendation: reading.recommendation, recommendation_zh: text(reading.recommendation_zh) };
    }),
    readings_note: text(rec.readings_note_zh),
    share_count_differences: (Array.isArray(rec.share_count_differences) ? rec.share_count_differences : []).filter(isObject).map((row) => ({
      carrier: text(row.carrier), entry_time: text(row.entry_time), shares: isObject(row.shares) ? row.shares : {}, cause: text(row.cause_zh) })),
    counter_evidence: (Array.isArray(rec.counter_evidence_zh) ? rec.counter_evidence_zh : []).filter((line) => typeof line === 'string'),
    analysis: Array.isArray(rec.market_analysis_zh) ? rec.market_analysis_zh.filter((line) => typeof line === 'string') : [],
    note_zh: '协调会话按 K2 ★3 (a) 预先冻结的规则给出的建议，由 Owner 决定（UX 修订 6：待 Owner 决定）；A25 已采用，不受本题影响。',
  };
}

function validateExtras(entry, doc) {
  paired.validateExposure(entry, doc);
  validateCooldownCounts(entry, doc);
  reportOnly.validateReportOnly(entry, doc);
  validateRecommendation(entry, doc);
}

const Q5 = Object.freeze({
  question_ref: 'Q5',
  code_prefix: 'Q5',
  schema: 'US_V5_M2_Q5_RESULT_V1',
  queue_order: 5,
  title_zh: '组合验证：在冷却只在开仓时武装之上，趋势中推迟时间止损', // 修订 5 E7.2：标题不带内部代号（A25、T3 留在 K2 与技术详情里）
  k2: Object.freeze({ ref: K2_REF, sha256: K2_SHA256 }),
  profile_ref: 'docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_3.md',
  pending_status_zh: null,
  top_level: Object.freeze(['identity', 'inputs', 'gates', 'arms', 'stats', 'stress', 'half_kelly',
    'formula_table', 'verdict', 'diagnosis_items', 'reproducibility', 'comparison', 'oos_reuse', 'reference_rows']),
  baseline_arm: Object.freeze({
    keys: Object.freeze(['BASELINE_A25']), label_zh: '原版（D+A25：冷却只在开仓时武装）',
    ref: Object.freeze({ question_ref: 'Q4', arm: 'CANDIDATE_COOLDOWN_ON_OPEN' }),
  }),
  candidate: Object.freeze({ key: 'CANDIDATE_T3_ON_A25', keys: Object.freeze(['CANDIDATE_T3_ON_A25']), label_zh: '候选 D+A25 再加趋势中推迟时间止损', deferred_sessions: true }),
  g1_changed_key: 'changed_total',
  run_gates: Object.freeze(['ACCEPTANCE', 'INPUTS', 'ENGINE_FILES_UNCHANGED', 'COMPOSE_KEYS', 'PARITY_T3_OFF', 'PARITY_A25_OFF', 'BASELINE_REPRO_D', 'NOCD_T3_REPRO']),
  mirror: null,
  oos_reuse: Object.freeze({
    expected: true, reason_code: 'OOS_REUSED_FOR_SELECTION', detail_required: true,
    label_zh: '样本外被用过：T3 凭这段样本外被选出，A25 在同一段上评价过',
    adoption_zh: 'A25 已采用，不受本题影响；T3 只在有支持证据时采用，证据不足时按预先冻结的核对表给建议，由 Owner 决定',
  }),
  attribution: Object.freeze({ required: false }),
  exposure: Object.freeze({
    required: true,
    extra_counts: Object.freeze({ baseline: Object.freeze([]), candidate: Object.freeze([]) }),
    extra_rows: EXTRA_ROWS,
  }),
  report_only: REFERENCE_ROWS,
  criteria: paired.CRITERIA,
  texts: Object.freeze({
    candidate_default: '候选 D+A25+T3：在 D+A25 上，处于趋势时推迟 5 日时间止损；止损、止盈、入场规则都不变',
    oos_label: 'T3 凭 2023-01-03 → 2026-10-02 这段样本外被选为领先变体，A25 在同一段上评价过；Q4 的 D+A25 与「无冷却」同账，Q1 的「无冷却 + T3」行在定题时可见',
    oos_pill: '样本外被用过',
    oos_tone: 'DEGRADED',
    exposure_note: '两臂都是冷却只在开仓时武装；候选持仓更久，在场时间与名义上限拒绝的变化是这个改动本身的后果，照报。冷却计数按每个交易日第一个扫描时点（开盘扫描）与其他扫描分开',
    g1_rule: '样本要够：两臂样本外成熟交易各 ≥ 30 笔，且改变的入场（只在一臂出现的「序列 + 扫描时点」入场）加改变的出场（同一入场、出场时点或原因不同）≥ 30 笔。',
    changed_label: '改变的入场与出场',
    method: '只按账户层面配对的年化对数增长差判定，先判 G1：G1 不成立一律证据不足；G1 成立时 95% 区间下沿大于 0 为有支持证据，上沿不高于 0 为未通过，其余为证据不足；单一比较，不做多重比较校正（98.33% 区间只报不判）。每笔净 R 对 +0.10 R 与三行参照都不参与判定。',
  }),
  blocks: Object.freeze([
    ['question', '这个对比在问什么'], ['account', '账户结果：原版与候选'], ['effect', '账户对数增长与每笔净 R'],
    ['exposure', '敞口变化披露（两臂，含冷却挡下的信号与未武装的冷却）'], ['criteria', '判据逐条'], ['stress', '压力：两臂逐行对比'],
    ['verdict', '三态结论与采用条件'], ['forward', '前向观察'],
  ]),
  /** 主卡之后的独立卡片：三行参照（只报不判），与证据不足时的采用建议核对表。 */
  extra_cards: Object.freeze([
    Object.freeze({ key: 'reference_rows', title_zh: '参照行（只报不判：原版 D、D+T3、组合对原版 D）', build: reportOnly.card }),
    Object.freeze({ key: 'recommendation', title_zh: '采用建议的逐项核对（证据不足时，K2 ★3 (a)）', build: recommendationCard }),
  ]),
  reason_words: REASON_WORDS_Q5,
  edge_labels: Object.freeze({ SUPPORTED: '完整账户的对数增长更好（不等于信号 alpha 更大）' }),
  constants: paired.constants,
  checkVerdict: paired.checkVerdict,
  validateExtras,
  builders: (entry, doc) => ({ ...paired.builders(entry, doc) }),
});

module.exports = { Q5, K2_REF, K2_SHA256, REFERENCE_ROWS, READINGS, validateRecommendation };
