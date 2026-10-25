'use strict';

/**
 * Q3（选对象了吗：Q3a 随机选择对照 + Q3a2 随机标的对照 + Q3b 行业 RS 排序候选 + 等权买入持有参照）的登记项，
 * 出自冻结的 Q3 K2（56d16406…）裁定 1–6 与 Q2 K2 勘误 1（G1 先判）。
 *
 *   - Q3b 是主卡：候选臂 CANDIDATE_SECTOR_RS；只按账户层面配对 g 判（95%，G1 先判，没有 Bonferroni），δ_g 0、δ_R 0.10；
 *     必填敞口披露，另加行业 RS 的拒绝数与重排时点数；没有归因块；
 *   - oos_reuse 必须是 false，且必须带原因码 OOS_PREVIOUSLY_EVALUATED_SAME_RULE（RS-1 已在同一窗口评价过同一规则），
 *     页面写「同窗复测，不是新的样本外」；结论不因此封顶；
 *   - random_control（Q3a 与 Q3a2）是它自己的结论（类别 RANDOM_SELECTION_CONTROL_V1），单独一张卡，与 Q3b 的 verdict 分开；
 *   - 参照臂 EQUAL_WEIGHT_1X_BUY_HOLD：15 只 1× 多头等权买入持有，只报不判，标签「价格收益，不含分红」。
 * 规格：docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_1.md。共用部件在 paired_g.js。
 */
const { need, isObject, E, referenceArmOf } = require('../common');
const paired = require('./paired_g');
const randomControl = require('./random_control');

const K2_REF = 'docs/contracts/US_V5_M2_Q3_SELECTION_K2_V1.md';
const K2_SHA256 = '56d16406d3c116e2dfc8e8c95ece1535697c00e2e02df4f90e651091c92cfa13';

const REFERENCE_ARMS = Object.freeze([Object.freeze({
  key: 'EQUAL_WEIGHT_1X_BUY_HOLD', label_zh: '等权买入持有（15 只 1× 多头）', note_zh: '价格收益，不含分红',
})]);

const RANDOM_CONTROL = Object.freeze({
  class: 'RANDOM_SELECTION_CONTROL_V1',
  support_at: 0.75, // 与 RS-1 的第 75 百分位门槛相同
  fail_at: 0.50, // 不比随机中位数好
  min_choice_points: 30, // G1：OOS 选择点
  seed_first: 20261025, // seed_i = 20261025 + i，运行前固定
  full_seeds: 1000, // 判定（SUPPORTED／NOT_PASSED）要求的种子数；Q3a 在 G1 不成立时只跑 200 个作描述
  parts: Object.freeze([
    Object.freeze({
      key: 'Q3A', get: (doc) => doc.random_control,
      title_zh: 'Q3a：同一扫描候选的处理顺序随机化', question_zh: '当前 D 在同一时点候选之间的选择（实际是文件顺序）好过随机吗？',
    }),
    Object.freeze({
      key: 'Q3A2', get: (doc) => (isObject(doc.random_control) ? doc.random_control.random_instrument : undefined),
      title_zh: 'Q3a2：随机标的对照', question_zh: '当前 D 的信号与闸门挑出的标的，好过在同一时刻随机挑一个可交易标的吗？',
    }),
  ]),
});

const REASON_WORDS_Q3 = Object.freeze({
  ...paired.REASON_WORDS_PAIRED_G,
  OOS_PREVIOUSLY_EVALUATED_SAME_RULE: '样本外不是新的：RS-1 已在同一窗口评价过同一规则，本题是在当前 D 上的复测（结论不因此封顶）',
  SECTOR_RS_NOT_TOP_N: '行业 RS 不在前 4 的行业信号被排序层拒绝',
});

/** 参照臂必须在（顶层 `reference_arms` 或 `arms` 里），读不出来的细节只让页面那一行写原因。 */
function validateReference(entry, doc) {
  for (const spec of entry.reference_arms) need(isObject(referenceArmOf(spec, doc)), E(entry, 'REFERENCE_ARM_MISSING'), spec.key);
}

function validateExtras(entry, doc) {
  validateReference(entry, doc);
  paired.validateExposure(entry, doc);
  randomControl.validateRandomControl(entry, doc);
}

function builders(entry, doc) {
  return { ...paired.builders(entry, doc) };
}

const Q3 = Object.freeze({
  question_ref: 'Q3',
  code_prefix: 'Q3',
  schema: 'US_V5_M2_Q3_RESULT_V1',
  queue_order: 3,
  title_zh: '候选对比：行业 RS 排序层对原版（选对象了吗）',
  k2: Object.freeze({ ref: K2_REF, sha256: K2_SHA256 }),
  profile_ref: 'docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_1.md',
  pending_status_zh: null,
  top_level: Object.freeze(['identity', 'inputs', 'gates', 'arms', 'stats', 'stress', 'half_kelly',
    'formula_table', 'verdict', 'diagnosis_items', 'reproducibility', 'comparison', 'oos_reuse', 'random_control']),
  candidate: Object.freeze({ key: 'CANDIDATE_SECTOR_RS', keys: Object.freeze(['CANDIDATE_SECTOR_RS', 'SECTOR_RS']), label_zh: '候选 行业 RS 排序', deferred_sessions: false }),
  run_gates: Object.freeze(['ACCEPTANCE', 'INPUTS', 'BASELINE_REPRO', 'INERT_Q0F', 'INERT_Q1', 'INERT_Q2', 'RANDOM_IDENTITY', 'RS_TABLE_PARITY', 'PROBE']),
  mirror: null,
  oos_reuse: Object.freeze({
    expected: false, reason_code: 'OOS_REUSED_FOR_SELECTION', required_code: 'OOS_PREVIOUSLY_EVALUATED_SAME_RULE', detail_required: true,
    label_zh: '同窗复测，不是新的样本外', adoption_zh: null,
  }),
  attribution: Object.freeze({ required: false }),
  exposure: Object.freeze({
    required: true,
    extra_counts: Object.freeze({ baseline: Object.freeze([]), candidate: Object.freeze(['sector_rs_refusals', 'reorder_instants']) }),
    extra_rows: Object.freeze([
      Object.freeze({ key: 'sector_rs_refusals', label_zh: '行业 RS 拒绝数（SECTOR_RS_NOT_TOP_N）', unit_zh: '次' }),
      Object.freeze({ key: 'reorder_instants', label_zh: '名次重排的时点数', unit_zh: '个' }),
    ]),
  }),
  reference_arms: REFERENCE_ARMS,
  random_control: RANDOM_CONTROL,
  criteria: paired.CRITERIA,
  texts: Object.freeze({
    candidate_default: '候选 行业 RS 排序：基线线加行业 RS 排序层（13 只行业 ETF 对 SPY 的 63／126 日超额收益各占一半，取前 4，无名次的行业信号拒绝，同一时点按名次重排）；其余全部相同',
    oos_label: 'RS-1 已在同一窗口（2023-01-01 → 2026-09-30）评价过同一规则；本题是在当前 D 上的复测',
    oos_pill: '同窗复测，不是新的样本外',
    oos_tone: 'DEGRADED',
    exposure_note: '排序层只改变同一时点行业候选的开仓顺序和哪些行业信号被拒绝；平均名义金额、在场时间与名义上限拒绝的变化是这个改动本身的后果，照报',
    g1_rule: '样本要够：两臂样本外成熟交易各 ≥ 30 笔，且改变的入场（只在一臂出现的「序列 + 扫描时点」入场）≥ 30 笔。',
    changed_label: '改变的入场',
    method: '只按账户层面配对的年化对数增长差判定，先判 G1：G1 不成立一律证据不足；G1 成立时 95% 区间下沿大于 0 为有支持证据，上沿不高于 0 为未通过，其余为证据不足；单变体，不做多重比较校正。每笔净 R 对 +0.10 R 只报告，不参与判定。',
  }),
  blocks: Object.freeze([
    ['question', '这个对比在问什么'], ['account', '账户结果：原版、候选与参照'], ['effect', '账户对数增长与每笔净 R'],
    ['exposure', '敞口变化披露（两臂，含行业 RS 的拒绝数与重排时点数）'], ['criteria', '判据逐条'], ['stress', '压力：两臂逐行对比'],
    ['verdict', '三态结论与采用条件'], ['forward', '前向观察'],
  ]),
  /** 主卡之后的独立卡片：随机选择对照（Q3a、Q3a2），自己的结论，与 Q3b 的 verdict 分开。 */
  extra_cards: Object.freeze([Object.freeze({
    key: 'random_control', title_zh: '随机选择对照（Q3a 候选顺序随机；Q3a2 随机标的）', build: randomControl.card,
  })]),
  reason_words: REASON_WORDS_Q3,
  edge_labels: Object.freeze({ SUPPORTED: '完整账户的对数增长更好（不等于信号 alpha 更大）' }),
  constants: paired.constants,
  checkVerdict: paired.checkVerdict,
  validateExtras,
  builders,
});

module.exports = { Q3, K2_REF, K2_SHA256, RANDOM_CONTROL, REFERENCE_ARMS };
