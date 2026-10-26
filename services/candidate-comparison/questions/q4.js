'use strict';

/**
 * Q4（冷却只在真正开仓时武装，即已签生效的 A25 `US_V5_COOLDOWN_ARMED_ON_OPEN_ONLY_V1`，对当前 D）的登记项，出自冻结的
 * Q4 K2（262f4b97…）裁定 1–7 与 Q2 K2 勘误 1（G1 先判）。
 *
 *   - 主卡：候选臂 CANDIDATE_COOLDOWN_ON_OPEN；只按账户层面配对 g 判（95%，G1 先判，没有 Bonferroni），δ_g 0、δ_R 0.10；
 *     必填敞口披露，另加冷却挡下的信号数与候选未武装的冷却数（各按开盘扫描与其他扫描分开）；没有归因块；
 *   - oos_reuse 必须是 true 且带 OOS_REUSED_FOR_SELECTION（计划 §5.2 的风控维度行「供 Q4 立题」，Q0 的「完全去掉冷却」行
 *     在定题时可见），并写 oos_reuse_detail；
 *   - report_only_dimensions：四行只报不判（完全去掉冷却、同时持仓 3 → 5、单元风险 60 → 90、只撤销闸门拒绝造成的冷却），
 *     单独一张卡，不进三态、不进采用条件；
 *   - 采用：结论交给 Owner，由 Owner 按 A25 的 C6 决定保留、修改或撤回 A25（裁定 6）。
 * 规格：docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_2.md。共用部件在 paired_g.js。
 */
const { need, isObject, E } = require('../common');
const paired = require('./paired_g');
const reportOnly = require('./report_only');

const K2_REF = 'docs/contracts/US_V5_M2_Q4_COOLDOWN_K2_V1.md';
const K2_SHA256 = '262f4b9790532f647a569a049fb5ad79c66fea0a3006354d01d7123d11c3566c';

const REPORT_ONLY = Object.freeze({
  class: 'REPORT_ONLY_DIMENSIONS',
  rows: Object.freeze([
    Object.freeze({ key: 'NO_24H_COOLDOWN', label_zh: '完全去掉 24 h 冷却' }),
    Object.freeze({ key: 'MAX_POSITIONS_5', label_zh: '同时持仓 3 → 5' }),
    Object.freeze({ key: 'RISK_UNIT_90', label_zh: '单元风险 60 → 90' }),
    Object.freeze({ key: 'GATE_REFUSAL_ONLY_UNARM', label_zh: '只撤销入场闸门拒绝造成的冷却' }),
  ]),
  note_zh: '这四行只报不判：每行与原版比较，不进三态结论，也不进采用条件（Q4 K2 裁定 2）。',
});

const split = (arm, path) => { const node = path.reduce((x, k) => (isObject(x) ? x[k] : undefined), arm); return node; };
const SPLIT = (label, path, part) => Object.freeze({ key: `${path.join('.')}.${part}`, label_zh: label, unit_zh: '个', get: (arm) => split(arm, [...path, part]) });
const EXTRA_ROWS = Object.freeze([
  SPLIT('冷却挡下的信号（开盘扫描）', ['cooldown_blocked_signals'], 'open_scan'),
  SPLIT('冷却挡下的信号（其他扫描）', ['cooldown_blocked_signals'], 'other'),
  SPLIT('候选未武装的冷却：闸门拒绝（开盘扫描）', ['arms_not_set', 'gate_refusal'], 'open_scan'),
  SPLIT('候选未武装的冷却：闸门拒绝（其他扫描）', ['arms_not_set', 'gate_refusal'], 'other'),
  SPLIT('候选未武装的冷却：其他未开仓（开盘扫描）', ['arms_not_set', 'other_no_open'], 'open_scan'),
  SPLIT('候选未武装的冷却：其他未开仓（其他扫描）', ['arms_not_set', 'other_no_open'], 'other'),
]);

const REASON_WORDS_Q4 = Object.freeze({
  ...paired.REASON_WORDS_PAIRED_G,
  OOS_REUSED_FOR_SELECTION: '样本外被定题用过：计划 §5.2 的风控维度行「供 Q4 立题」，Q0 的「完全去掉冷却」行在定题时可见，本题是那一行的收窄版本',
});

const count = (value) => Number.isInteger(value) && value >= 0;
/** 冷却计数的形状（两臂都有 cooldown_blocked_signals；候选臂另有 arms_not_set），坏了就拒绝（同敞口披露）。 */
function validateCooldownCounts(entry, doc) {
  const exposure = paired.exposureOf(entry, doc);
  for (const [label, keys, paths] of [
    ['BASELINE', ['BASELINE', 'D'], [['cooldown_blocked_signals']]],
    [entry.candidate.key, entry.candidate.keys, [['cooldown_blocked_signals'], ['arms_not_set', 'gate_refusal'], ['arms_not_set', 'other_no_open']]],
  ]) {
    const arm = keys.map((key) => exposure[key]).find(isObject);
    for (const path of paths) {
      const node = split(arm, path);
      need(isObject(node) && count(node.open_scan) && count(node.other), E(entry, 'EXPOSURE_DISCLOSURE_INVALID'), `${label}.${path.join('.')}`);
    }
  }
}

function validateExtras(entry, doc) {
  paired.validateExposure(entry, doc);
  validateCooldownCounts(entry, doc);
  reportOnly.validateReportOnly(entry, doc);
}

function builders(entry, doc) {
  return { ...paired.builders(entry, doc) };
}

const Q4 = Object.freeze({
  question_ref: 'Q4',
  code_prefix: 'Q4',
  schema: 'US_V5_M2_Q4_RESULT_V1',
  queue_order: 4,
  title_zh: '候选对比：冷却只在开仓时武装对原版', // 修订 5 E7.2：标题不带内部代号（A25 留在 K2 与技术详情里）
  k2: Object.freeze({ ref: K2_REF, sha256: K2_SHA256 }),
  profile_ref: 'docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_2.md',
  pending_status_zh: null,
  top_level: Object.freeze(['identity', 'inputs', 'gates', 'arms', 'stats', 'stress', 'half_kelly',
    'formula_table', 'verdict', 'diagnosis_items', 'reproducibility', 'comparison', 'oos_reuse', 'report_only_dimensions']),
  candidate: Object.freeze({ key: 'CANDIDATE_COOLDOWN_ON_OPEN', keys: Object.freeze(['CANDIDATE_COOLDOWN_ON_OPEN', 'COOLDOWN_ON_OPEN']), label_zh: '候选 冷却只在开仓时武装', deferred_sessions: false }),
  run_gates: Object.freeze(['ACCEPTANCE', 'INPUTS', 'BASELINE_REPRO', 'COOLDOWN_PARITY', 'INERT_Q0F', 'INERT_Q2', 'INERT_Q3', 'PROBE']),
  mirror: null,
  oos_reuse: Object.freeze({
    expected: true, reason_code: 'OOS_REUSED_FOR_SELECTION', detail_required: true,
    label_zh: '样本外被定题用过：Q0 的「完全去掉冷却」行在定题时可见',
    adoption_zh: '结论交给 Owner，由 Owner 按 A25 的 C6 决定保留、修改或撤回 A25',
  }),
  attribution: Object.freeze({ required: false }),
  exposure: Object.freeze({
    required: true,
    extra_counts: Object.freeze({ baseline: Object.freeze([]), candidate: Object.freeze([]) }),
    extra_rows: EXTRA_ROWS,
  }),
  report_only: REPORT_ONLY,
  criteria: paired.CRITERIA,
  texts: Object.freeze({
    candidate_default: '候选 冷却只在开仓时武装（A25）：冷却只在真正开仓（含持仓替换执行）时触发、从成交时刻起算；没有开仓的信号都不武装冷却；K2 触发不受冷却阻挡、也不武装；其余全部相同',
    oos_label: '计划 §5.2 的风控维度行「供 Q4 立题」，Q0 的「完全去掉冷却」行（OOS 期末 4,038 对 3,418）在定题时可见；本题是那一行的收窄版本',
    oos_pill: '样本外被定题用过',
    oos_tone: 'DEGRADED',
    exposure_note: '冷却只在开仓时武装后，没有开仓的信号不再挡住同一序列 24 小时；平均名义金额、在场时间与名义上限拒绝的变化是这个改动本身的后果，照报。冷却计数按每个交易日第一个扫描时点（开盘扫描）与其他扫描分开',
    g1_rule: '样本要够：两臂样本外成熟交易各 ≥ 30 笔，且改变的入场（只在一臂出现的「序列 + 扫描时点」入场）≥ 30 笔。',
    changed_label: '改变的入场',
    method: '只按账户层面配对的年化对数增长差判定，先判 G1：G1 不成立一律证据不足；G1 成立时 95% 区间下沿大于 0 为有支持证据，上沿不高于 0 为未通过，其余为证据不足；单变体，不做多重比较校正。每笔净 R 对 +0.10 R 与四个只报行都不参与判定。',
  }),
  blocks: Object.freeze([
    ['question', '这个对比在问什么'], ['account', '账户结果：原版与候选'], ['effect', '账户对数增长与每笔净 R'],
    ['exposure', '敞口变化披露（两臂，含冷却挡下的信号与未武装的冷却）'], ['criteria', '判据逐条'], ['stress', '压力：两臂逐行对比'],
    ['verdict', '三态结论与采用条件'], ['forward', '前向观察'],
  ]),
  /** 主卡之后的独立卡片：四个只报不判的风控维度行，与主卡的 verdict 分开。 */
  extra_cards: Object.freeze([Object.freeze({ key: 'report_only_dimensions', title_zh: '只报不判的风控维度行（四行，与原版比较）', build: reportOnly.card })]),
  reason_words: REASON_WORDS_Q4,
  edge_labels: Object.freeze({ SUPPORTED: '完整账户的对数增长更好（不等于信号 alpha 更大）' }),
  constants: paired.constants,
  checkVerdict: paired.checkVerdict,
  validateExtras,
  builders,
});

module.exports = { Q4, K2_REF, K2_SHA256, REPORT_ONLY };
