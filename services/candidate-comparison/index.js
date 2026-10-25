'use strict';

/**
 * K3 的候选对比类别：外部封存的「原版对候选」比较（US_V5 M2 Q1，T3 推迟 TIME stop）进入 QRP 的位置。
 *
 * 与 Q0 基线评价（services/baseline-evaluation）同一套封存纪律：研究会话在 Mac 上产出
 * `US_V5_M2_Q1_RESULT_V1`（一个 JSON 加旁边的 sha256 文件），QRP 只读导入——
 *   1. `importCandidateComparison`（命令行，完成权威）校验封存文件，并追加一条
 *      `COMPARISON_EVALUATION_LOCK_V1`：Result Lock 的 `CANDIDATE_COMPARISON_V1` 类别
 *      （SUPPORTED / NOT_PASSED / INSUFFICIENT），引用一份已存在且是当前的 Q0 基线锁；
 *   2. `readProjection`（页面）每次现场复验文件 sha256，再投影成「研究与对比」里的七块。
 *
 * 不重算业务数字：这里只做封存校验、一致性校验和人话标签；只拒绝「标签比证据强」「证据链断了」
 * 「把前向并入结论」「把复用的样本外说成独立」。没有 HTTP 写入口，不用交易凭证，不写生产参数或账本。
 * 规则出处：docs/contracts/US_V5_M2_Q1_RESULT_V1_IMPORT_PROFILE.md。
 */
const fs = require('fs');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const baseline = require('../baseline-evaluation');

const {
  K3Error, fail, need, field, ci, finite, isObject, sha256, canonical, authority, reasonText, digests,
  stressRole, hasNoSeries, preferZh, trimKind, STRESS_NUMBERS, KNOWN_STRESS_STATUS, REASON_WORDS, EDGE_LABELS,
} = baseline.internals;

const RESULT_SCHEMA = 'US_V5_M2_Q1_RESULT_V1';
const EVAL_CLASS = 'CANDIDATE_COMPARISON_V1';
const QUESTION_REF = 'Q1';
const CASE_REF = baseline.CASE_REF;
const STRATEGY_REF = baseline.STRATEGY_REF;
const K2_REF = 'docs/contracts/US_V5_M2_Q1_T3_DEFERRED_TIME_STOP_K2_V1.md';
const K2_SHA256 = '84c96c2843b196046ec17045b20e4dcaf02e0117e8291243a23b3be51990bb02';
const PROFILE_REF = 'docs/contracts/US_V5_M2_Q1_RESULT_V1_IMPORT_PROFILE.md';
const TOP_LEVEL = Object.freeze(['identity', 'inputs', 'gates', 'arms', 'stats', 'stress', 'half_kelly',
  'formula_table', 'verdict', 'diagnosis_items', 'reproducibility', 'comparison', 'oos_reuse']);
const STATES = baseline.STATES;
const T3_OF = Object.freeze({ SUPPORTED: 'PASS', NOT_PASSED: 'FAIL', INSUFFICIENT: 'INSUFFICIENT' });
const DELTA_STAR = 0.15; // K2 判据，冻结，看见结果后不改
const DELTA_G = 0;
const MIN_AFFECTED = 30;
const MIN_BLOCKS = 10;
const BONFERRONI_LEVEL = 0.9833;
const RUN_GATES = Object.freeze(['ACCEPTANCE', 'INPUTS', 'BASELINE_REPRO', 'INERT_Q0F', 'INERT_TWINS', 'TWIN_PARITY', 'PROBE']);
const BASE_KEYS = Object.freeze(['BASELINE', 'D']);
const CAND_KEYS = Object.freeze(['CANDIDATE_T3', 'T3']);
const BLOCKS = Object.freeze([
  ['question', '这个对比在问什么'], ['account', '账户结果：原版与候选'], ['effect', '受影响交易的改善'],
  ['criteria', '判据逐条'], ['stress', '压力：两臂逐行对比'], ['verdict', '三态结论与采用条件'], ['forward', '前向观察'],
]);
const OOS_REUSE_LABEL = '复测（当年用于挑选 T3 的样本，不是独立样本外）';
const OOS_REUSE_DEFAULT = Object.freeze({ reused: { from: '2023-01-03', to: '2026-10-02' }, source: 'K2 裁定 4' });
const ADOPTION_OOS = '独立样本不足，等前向成熟';
const ADOPTION_STRESS = '必要压力缺失，§6.7';
const CRITERIA = Object.freeze({
  G1: { kind: 'met', title: '样本够不够' }, P1: { kind: 'met', title: '受影响交易的平均改善' },
  P2: { kind: 'met', title: '期末资本与回撤' }, P3: { kind: 'met', title: '账户年化对数增长差' },
  P4: { kind: 'met', title: '开发期方向与高费用下不输' },
  F1: { kind: 'triggered', title: '改善的上沿低于最低改善量' }, F2: { kind: 'triggered', title: 'P1 成立但 P2 或 P4 不成立' },
  F3: { kind: 'triggered', title: '账户层面的上沿不高于 0' },
});
const COMPARISON_REASON_WORDS = Object.freeze({
  OOS_REUSED_FOR_SELECTION: '样本外复用：2023-01-03 至 2026-10-02 是 T3 研究的样本外，本次是复测，不是独立样本外',
  SAMPLE_LT_30: '主样本受影响交易少于 30 笔',
  G1_NOT_MET: '样本不够（G1 不满足）',
  CI_STRADDLES_DELTA: '改善的区间跨过最低改善量',
  CI_G_STRADDLES_ZERO: '账户年化对数增长差的区间跨过 0',
  U_G_AT_OR_BELOW_ZERO: '账户年化对数增长差的上沿不高于 0（F3）',
  STRESS_SCENARIO_MISSING: '压力场景有缺（缺场景按不足处理）',
});

const LEDGER = () => path.join(dataDir('research'), 'comparison_evaluations.jsonl');

const pick = (object, keys) => (isObject(object) ? keys.map((key) => object[key]).find((value) => value !== undefined) : undefined);

const FLAG_KEYS = Object.freeze({
  met: ['met', 'pass', 'passed', 'ok', 'holds', 'value', 'result'],
  triggered: ['triggered', 'fired', 'holds', 'value', 'result'],
});
const flagOf = (item, kind) => {
  if (typeof item === 'boolean') return item;
  if (!isObject(item)) return undefined;
  const key = FLAG_KEYS[kind].find((name) => typeof item[name] === 'boolean');
  return key ? item[key] : undefined;
};

/** 判据逐项的真假。K2 把它同时放在 verdict 和 comparison 下，位置不唯一，所以全读，且各处读到的值必须一致。 */
function criteriaOf(doc) {
  const sources = [doc.comparison.criteria, doc.verdict.criteria, doc.comparison, doc.verdict].filter(isObject);
  const out = {};
  for (const [name, spec] of Object.entries(CRITERIA)) {
    const hits = sources.map((source) => ({ flag: flagOf(source[name], spec.kind), item: source[name] })).filter((hit) => hit.flag !== undefined);
    need(hits.length, 'Q1_CRITERIA_INCOMPLETE', name);
    need(hits.every((hit) => hit.flag === hits[0].flag), 'Q1_CRITERIA_DISAGREE', name);
    out[name] = { flag: hits[0].flag, item: isObject(hits[0].item) ? hits[0].item : {} };
  }
  return out;
}

/** 总体 S（主）与 B（次）。K2 正文写 comparison.D 为主总体，裁定写 S 与 B；三种位置都认。 */
function populationsOf(c) {
  const p = isObject(c.populations) ? c.populations : {};
  return { S: p.S || c.S || c.D, B: p.B || c.B };
}
const bound = (value, index) => (Array.isArray(value) && finite(value[index]) ? value[index] : undefined);
const firstFinite = (...values) => values.find(finite);
/** 98.33% 区间的两端：verdict 里有就用，没有就取 comparison 里对应的区间。只读取，不推算。 */
function boundsOf(doc) {
  const v = doc.verdict;
  const { S } = populationsOf(doc.comparison);
  const g = isObject(doc.comparison.g_vs_baseline) ? doc.comparison.g_vs_baseline : {};
  return {
    L_D: firstFinite(v.L_D, v.L_R, bound(isObject(S) ? S.ci_98_33 : null, 0)), U_D: firstFinite(v.U_D, v.U_R, bound(isObject(S) ? S.ci_98_33 : null, 1)),
    L_g: firstFinite(v.L_g, bound(g.ci_98_33, 0)), U_g: firstFinite(v.U_g, bound(g.ci_98_33, 1)),
  };
}

// ── 封存文件 ────────────────────────────────────────────────────────────────────

/** 与 Q0 同一套封存读取；错误码前缀换成 Q1_RESULT_，避免把 Q1 文件的问题报成 Q0。 */
function readSealed(file, options = {}) {
  try { return baseline.readSealed(file, { ...options, topLevel: TOP_LEVEL }); } catch (error) {
    if (error instanceof K3Error && /^Q0_RESULT_/.test(error.code)) throw new K3Error(error.code.replace(/^Q0_RESULT_/, 'Q1_RESULT_'), error.detail);
    throw error;
  }
}

// ── 整文件一致性（失败关闭）──────────────────────────────────────────────────────

const baselineIdOf = (doc) => {
  const fromIdentity = doc.identity.baseline_result_id || (isObject(doc.identity.baseline) ? doc.identity.baseline.result_id : null);
  const fromComparison = isObject(doc.comparison) ? doc.comparison.baseline_result_id : null;
  need(fromIdentity, 'Q1_BASELINE_RESULT_ID_MISSING');
  need(!fromComparison || fromComparison === fromIdentity, 'Q1_BASELINE_RESULT_ID_DISAGREES', `${fromIdentity}≠${fromComparison}`);
  return fromIdentity;
};

/** 压力场景角色（Q0 冻结说明 2 G2）的行里，缺场景、无效输入，或候选臂没有跑出来的。 */
const candidateArmMissing = (row) => {
  const candidate = pick(row.arms, CAND_KEYS);
  return isObject(candidate) && candidate.missing === true;
};
const incompleteStressScenarios = (rows) => rows
  .filter((row) => isObject(row) && stressRole(row) === 'STRESS' && (hasNoSeries(row) || candidateArmMissing(row)))
  .map((row) => row.scenario);

/** K2 正文把 forward 放在 comparison 下，裁定把它放在顶层；两处都认，顶层优先。 */
const forwardRows = (doc) => {
  const raw = doc.forward !== undefined && doc.forward !== null ? doc.forward : (isObject(doc.comparison) ? doc.comparison.forward : null);
  return Array.isArray(raw) ? raw : (isObject(raw) ? raw.rows : null);
};

function validateWhole(doc) {
  const repro = doc.reproducibility;
  need(isObject(repro) && typeof repro.command === 'string' && repro.command && Array.isArray(repro.runs)
    && repro.runs.length >= 2 && repro.runs.every((run) => isObject(run) && /^[0-9a-f]{64}$/.test(run.sha256 || ''))
    && new Set(repro.runs.map((run) => run.sha256)).size === 1 && repro.identical === true,
  'Q1_RESULT_NOT_REPRODUCED');

  const identity = doc.identity;
  need(isObject(identity) && identity.schema === RESULT_SCHEMA, 'Q1_RESULT_SCHEMA_UNSUPPORTED', identity && identity.schema);
  need(identity.result_kind === 'CHALLENGER_VS_BASELINE', 'Q1_RESULT_KIND_UNSUPPORTED', identity.result_kind);
  const k2sha = isObject(identity.k2) ? identity.k2.sha256 : identity.k2_sha256;
  need(k2sha === K2_SHA256, 'Q1_K2_SHA_MISMATCH', k2sha);
  baselineIdOf(doc);

  // 运行门任一不过，K2 规定是 BLOCKED、不出结论；所以带结论的文件里 K2 点名的七道门必须都在且 PASSED，
  // 文件里其他带 state 的门也不能是别的状态。
  for (const name of RUN_GATES) {
    need(isObject(doc.gates) && isObject(doc.gates[name]) && doc.gates[name].state === 'PASSED', 'Q1_RUN_GATE_NOT_PASSED', name);
  }
  for (const [name, gate] of Object.entries(doc.gates)) {
    need(!isObject(gate) || typeof gate.state !== 'string' || gate.state === 'PASSED', 'Q1_RUN_GATE_NOT_PASSED', name);
  }

  const verdict = doc.verdict;
  need(isObject(verdict) && verdict.class === EVAL_CLASS, 'Q1_VERDICT_CLASS_UNSUPPORTED', verdict && verdict.class);
  need(verdict.t3_state !== 'BLOCKED', 'Q1_BLOCKED_HAS_NO_VERDICT');
  need(STATES.includes(verdict.state), 'Q1_VERDICT_STATE_UNSUPPORTED', verdict.state);
  need(verdict.t3_state === T3_OF[verdict.state], 'Q1_T3_STATE_MISMATCH', `${verdict.state}/${verdict.t3_state}`);
  need(verdict.delta_star === DELTA_STAR && verdict.delta_g === DELTA_G, 'Q1_VERDICT_DELTA_CHANGED', `${verdict.delta_star}/${verdict.delta_g}`);
  const comparison = doc.comparison;
  need(isObject(comparison), 'Q1_COMPARISON_MISSING');
  need(isObject(comparison.bonferroni) && finite(comparison.bonferroni.level)
    && Math.abs(comparison.bonferroni.level - BONFERRONI_LEVEL) < 5e-5, 'Q1_BONFERRONI_LEVEL_CHANGED', comparison.bonferroni && comparison.bonferroni.level);
  const codes = Array.isArray(verdict.reason_codes) ? verdict.reason_codes : [];

  // AC5：样本外复用。K2 裁定 4 把它定为 true，且必须带原因码，不能把复测说成独立样本外。
  need(typeof doc.oos_reuse === 'boolean', 'Q1_OOS_REUSE_MISSING');
  need(doc.oos_reuse === true, 'Q1_OOS_REUSE_MUST_BE_DECLARED');
  need(codes.includes('OOS_REUSED_FOR_SELECTION'), 'Q1_OOS_REUSE_NOT_DECLARED');

  // 前向只报不判，任何一行都不能进结论。
  const forward = forwardRows(doc);
  need(Array.isArray(forward), 'Q1_FORWARD_ROWS_MISSING');
  forward.forEach((row, index) => need(isObject(row) && row.in_verdict === false, 'Q1_FORWARD_IN_VERDICT', `rows[${index}]`));

  const criteria = criteriaOf(doc);
  const { S: primary } = populationsOf(comparison);
  need(isObject(primary), 'Q1_PRIMARY_POPULATION_MISSING');
  const { L_D, U_D, L_g, U_g } = boundsOf(doc);
  const nAff = firstFinite(primary.n_aff, NaN);
  const blocks = firstFinite(primary.blocks, primary.n_blocks, NaN);

  if (verdict.state === 'SUPPORTED') {
    need(['G1', 'P1', 'P2', 'P3', 'P4'].every((name) => criteria[name].flag === true)
      && ['F1', 'F2', 'F3'].every((name) => criteria[name].flag === false), 'Q1_VERDICT_SUPPORTED_WITHOUT_EVIDENCE', 'criteria');
    // F3：账户层面的上沿不高于 0 时不得 SUPPORTED（K2 裁定 3）
    need(finite(U_g) && U_g > DELTA_G, 'Q1_VERDICT_SUPPORTED_VIOLATES_F3', `U_g=${U_g}`);
    need(finite(L_D) && L_D > 0 && finite(L_g) && L_g > DELTA_G && finite(U_D) && U_D >= DELTA_STAR,
      'Q1_VERDICT_SUPPORTED_WITHOUT_EVIDENCE', `L_D=${L_D} U_D=${U_D} L_g=${L_g}`);
    need(nAff >= MIN_AFFECTED && blocks >= MIN_BLOCKS, 'Q1_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL', `n_aff=${nAff} blocks=${blocks}`);
    need(!(isObject(verdict.engine_approximation) && verdict.engine_approximation.flag === true), 'Q1_VERDICT_SUPPORTED_ON_APPROXIMATE_ENGINE');
  }
  if (verdict.state === 'NOT_PASSED') {
    const f1 = finite(U_D) && U_D < DELTA_STAR;
    const f2 = criteria.P1.flag === true && (criteria.P2.flag === false || criteria.P4.flag === false);
    const f3 = finite(U_g) && U_g <= DELTA_G;
    need(f1 || f2 || f3, 'Q1_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE', `U_D=${U_D} U_g=${U_g}`);
  }

  // 模拟场景标注（同 Q0）；缺场景行没有序列，不要求。
  const stressRows = isObject(doc.stress) && Array.isArray(doc.stress.rows) ? doc.stress.rows : [];
  for (const row of stressRows) {
    if (isObject(row) && !hasNoSeries(row) && /bear|熊|synthetic|模拟/i.test(`${row.scenario || ''}${row.label || ''}`)) {
      need(row.simulated === true, 'Q1_STRESS_SIMULATED_NOT_FLAGGED', row.scenario);
    }
  }
  // 压力不完整时，SUPPORTED 的文件必须自己写明，不能让「有支持证据」把它盖住（同 Q0 G3）。
  const incomplete = incompleteStressScenarios(stressRows);
  if (verdict.state === 'SUPPORTED' && incomplete.length) {
    need(codes.includes('STRESS_SCENARIO_MISSING'), 'Q1_VERDICT_SUPPORTED_HIDES_INCOMPLETE_STRESS', incomplete.join(','));
  }
  return { incomplete };
}

// ── 区块（各自失败只影响自己）────────────────────────────────────────────────────

const SUMMARY_KEYS = ['end_capital', 'cagr', 'max_drawdown', 'longest_underwater_sessions', 'recovered'];

function armSummaries(doc) {
  const arms = doc.arms;
  need(isObject(arms), 'MISSING', 'arms');
  const specs = [['BASELINE', '原版（当前 D）', BASE_KEYS], ['CANDIDATE_T3', '候选 T3', CAND_KEYS], ['SPY_BUY_HOLD', 'SPY 买入持有', ['SPY_BUY_HOLD']], ['CASH', '现金', ['CASH']]];
  let dates = null;
  return specs.map(([key, label, aliases]) => {
    const arm = pick(arms, aliases);
    need(isObject(arm), 'MISSING', `arms.${key}`);
    const equity = arm.equity;
    need(isObject(equity) && Array.isArray(equity.dates) && Array.isArray(equity.values) && equity.dates.length === equity.values.length
      && equity.values.length >= 2 && equity.values.every((value) => finite(value) && value > 0), 'INVALID', `arms.${key}.equity`);
    if (dates) need(canonical(dates) === canonical(equity.dates), 'INVALID', `arms.${key}.equity.dates 与其他臂不一致`);
    dates = equity.dates;
    const summary = arm.summary;
    need(isObject(summary), 'MISSING', `arms.${key}.summary`);
    const end = field(summary, 'end_capital', `arms.${key}.summary.end_capital`);
    need(Math.abs(end - equity.values[equity.values.length - 1]) <= 1e-6 * Math.max(1, Math.abs(end)), 'INVALID', `arms.${key}.summary.end_capital 与权益序列末点不一致`);
    return {
      key, label, end_capital: end, cagr: field(summary, 'cagr', `arms.${key}.summary.cagr`),
      max_drawdown: field(summary, 'max_drawdown', `arms.${key}.summary.max_drawdown`),
      longest_underwater_sessions: field(summary, 'longest_underwater_sessions', `arms.${key}.summary.longest_underwater_sessions`),
      recovered: field(summary, 'recovered', `arms.${key}.summary.recovered`, 'bool'),
      sessions: equity.values.length, start: equity.dates[0], end_date: equity.dates[equity.dates.length - 1],
      deferred_sessions: key === 'CANDIDATE_T3' && finite(arm.deferred_sessions) ? arm.deferred_sessions : null,
    };
  });
}

function questionBlock(doc) {
  const c = doc.comparison;
  const question = preferZh(c, 'question');
  need(typeof question === 'string' && question.trim(), 'MISSING', 'comparison.question');
  const detail = isObject(doc.identity.oos_reuse) ? doc.identity.oos_reuse : {};
  const stated = isObject(detail.reused) ? detail.reused : detail;
  const reused = stated.from && stated.to ? { from: stated.from, to: stated.to } : OOS_REUSE_DEFAULT.reused;
  const candidate = preferZh(c, 'candidate_label');
  return {
    question: question.trim(),
    candidate: typeof candidate === 'string' && candidate.trim() ? candidate.trim() : '候选 T3：趋势期间到期的 5 日时间止损推迟，之后每个扫描时点复查',
    populations: [
      { key: 'S', role: '主样本', label: '信号级总体 S：每个通过闸门的趋势买入信号各算一笔（主）' },
      { key: 'B', role: '次要样本', label: '基线账本的时间止损出场 B（次，照报不判）' },
    ],
    oos_reuse: { label: OOS_REUSE_LABEL, reused, independent: Array.isArray(detail.independent) ? detail.independent : [], from_k2: !(stated.from && stated.to) },
    baseline_result_id: baselineIdOf(doc),
  };
}

function accountBlock(doc) {
  const arms = armSummaries(doc);
  const base = arms[0];
  const cand = arms[1];
  return {
    arms, start: base.start, end: base.end_date,
    diff_vs_baseline: {
      end_capital: cand.end_capital - base.end_capital, cagr: cand.cagr - base.cagr,
      max_drawdown_pp: (cand.max_drawdown - base.max_drawdown) * 100,
      longest_underwater_sessions: cand.longest_underwater_sessions - base.longest_underwater_sessions,
    },
  };
}

function population(raw, key, where) {
  need(isObject(raw), 'MISSING', `${where}.${key}`);
  need(Number.isInteger(raw.n_aff) && raw.n_aff >= 0, 'INVALID', `${where}.${key}.n_aff`);
  const blocks = raw.blocks !== undefined ? raw.blocks : raw.n_blocks;
  need(Number.isInteger(blocks) && blocks >= 0, 'INVALID', `${where}.${key}.blocks`);
  return {
    key, n_aff: raw.n_aff, blocks, n_total: Number.isInteger(raw.n_total) ? raw.n_total : null,
    n_zero: Number.isInteger(raw.n_zero) ? raw.n_zero : null, mean_dR: field(raw, 'mean_dR', `${where}.${key}.mean_dR`),
    ci_95: ci(raw.ci_95, `${where}.${key}.ci_95`), ci_98_33: ci(raw.ci_98_33, `${where}.${key}.ci_98_33`),
    mde: finite(raw.mde) ? raw.mde : null,
  };
}

function effectBlock(doc) {
  const c = doc.comparison;
  const pops = populationsOf(c);
  const g = c.g_vs_baseline;
  need(isObject(g), 'MISSING', 'comparison.g_vs_baseline');
  const secondary = isObject(c.secondary) ? c.secondary : null;
  return {
    S: population(pops.S, 'S', 'comparison.populations'), B: population(pops.B, 'B', 'comparison.populations'),
    g: { value: field(g, 'value', 'comparison.g_vs_baseline.value'), ci_95: ci(g.ci_95, 'comparison.g_vs_baseline.ci_95'), ci_98_33: ci(g.ci_98_33, 'comparison.g_vs_baseline.ci_98_33') },
    bonferroni: '多重比较：T3 是从三个变体里选出来的，主判据用 98.33% 区间（Bonferroni），95% 区间并列',
    secondary: secondary ? {
      mean_dR_all_time_exits: finite(secondary.mean_dR_all_time_exits) ? secondary.mean_dR_all_time_exits : null,
      n_time_exits: Number.isInteger(secondary.n_time_exits) ? secondary.n_time_exits : null,
      by_reason: Array.isArray(secondary.by_reason) ? secondary.by_reason.filter((row) => isObject(row)).map((row) => ({ reason: String(row.reason), n: row.n, mean_dR: row.mean_dR })) : [],
    } : null,
  };
}

const fmtR = (value) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)} R`;
const fmtPct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const fmtUsd = (value) => `$${Number(value).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/**
 * P1–P4 / F1–F3 的人话。数字只取文件里已有的：区间取 verdict／comparison 里的 98.33% 两端，
 * 期末资本与回撤取两臂 summary，高费用取 COST_15BPS 压力行；取不到就只写成立与否，不补、不推算。
 */
function criteriaBlock(doc) {
  const flags = criteriaOf(doc);
  const { L_D, U_D, L_g, U_g } = boundsOf(doc);
  const { S } = populationsOf(doc.comparison);
  const arms = (() => { try { return armSummaries(doc); } catch { return null; } })();
  const base = arms && arms[0];
  const cand = arms && arms[1];
  // 高费用那一行只取通过了压力块校验的数字；压力块读不出来就不显示这几个数。
  let stressRows = [];
  try { stressRows = stressBlock(doc).rows; } catch { stressRows = []; }
  const costRow = stressRows.find((row) => row.scenario === 'COST_15BPS' && row.kind === 'EXECUTED' && !row.candidate_missing);
  const costBase = costRow && costRow.baseline;
  const costCand = costRow && costRow.candidate;
  const has = (...values) => values.every(finite);
  const f = flags;
  const lines = {
    G1: () => `样本要够：基线样本外成熟交易 ≥ 30 笔，主样本受影响交易 ≥ ${MIN_AFFECTED} 笔且分布在 ≥ ${MIN_BLOCKS} 个入场块。`
      + `${finite(f.G1.item.baseline_oos_trades) ? `基线 ${f.G1.item.baseline_oos_trades} 笔；` : ''}${isObject(S) && has(S.n_aff) ? `主样本受影响 ${S.n_aff} 笔${finite(firstFinite(S.blocks, S.n_blocks)) ? `、${firstFinite(S.blocks, S.n_blocks)} 个块` : ''}。` : ''}`,
    P1: () => `受影响交易的平均改善，98.33% 区间的下沿要大于 0。${has(L_D) ? `下沿 ${fmtR(L_D)}。` : ''}`,
    P2: () => `候选的样本外期末资本要高于原版，且最大回撤不超过原版 + 1.0 个百分点。${cand && base ? `期末资本 ${fmtUsd(cand.end_capital)} 对 ${fmtUsd(base.end_capital)}；最大回撤 ${fmtPct(cand.max_drawdown)} 对 ${fmtPct(base.max_drawdown)}。` : ''}`,
    P3: () => `候选相对原版的年化对数增长差，98.33% 区间的下沿要大于 0。${has(L_g) ? `下沿 ${fmtPct(L_g)}。` : ''}`,
    P4: () => `开发期的改善点估计不为负，且 15 bps 高费用下候选的样本外期末资本不低于原版。${costBase && costCand && has(costBase.end_capital, costCand.end_capital) ? `高费用期末资本 ${fmtUsd(costCand.end_capital)} 对 ${fmtUsd(costBase.end_capital)}。` : ''}`,
    F1: () => `否决：改善的 98.33% 区间上沿低于最低改善量 +${DELTA_STAR.toFixed(2)} R。${has(U_D) ? `上沿 ${fmtR(U_D)}。` : ''}`,
    F2: () => `否决：P1 成立，但 P2 或 P4 不成立。${typeof f.F2.item.which === 'string' && f.F2.item.which ? `不成立的是 ${f.F2.item.which}。` : ''}`,
    F3: () => `否决：账户年化对数增长差的 98.33% 区间上沿不高于 0。${has(U_g) ? `上沿 ${fmtPct(U_g)}。` : ''}`,
  };
  return {
    rows: Object.entries(CRITERIA).map(([key, spec]) => {
      const flag = f[key].flag;
      return {
        key, title: spec.title, kind: spec.kind, flag,
        state_label: spec.kind === 'met' ? (flag ? '成立' : '不成立') : (flag ? '触发' : '未触发'),
        tone: spec.kind === 'met' ? (flag ? 'ok' : 'bad') : (flag ? 'bad' : 'ok'),
        text: lines[key](),
      };
    }),
  };
}

const ARM_NUMBERS = ['max_loss_usd', 'longest_underwater_sessions', 'recovered', 'end_capital'];

/**
 * 每行两臂各一格，再加差（候选 − 基线）。行的形状沿用 Q0 冻结说明 1–2：缺场景／无效输入没有序列，数字全为 null；
 * 补充行 `simulated:true` 且 `in_headline:false`。候选臂这一格可单独缺项（`missing:true` + 原因），
 * 补充行的 T3 臂缺项是 K2 规定的，不算压力不完整；压力场景行的候选臂缺项算不完整。
 */
function stressBlock(doc) {
  const stress = doc.stress;
  const rows = stress && stress.rows;
  need(Array.isArray(rows) && rows.length, 'MISSING', 'stress.rows');
  const cell = (arm, where) => {
    need(isObject(arm), 'MISSING', where);
    if (arm.missing === true) {
      const reasonText_ = [arm.missing_reason, arm.reason_zh, arm.reason].find((item) => typeof item === 'string' && item.trim());
      need(reasonText_, 'MISSING', `${where}.missing_reason`);
      need(ARM_NUMBERS.every((key) => arm[key] === null || arm[key] === undefined), 'INVALID', `${where} 缺项的数字必须是 null`);
      return { missing: true, reason: reasonText_.trim(), max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: null };
    }
    return {
      missing: false, reason: null, max_loss_usd: field(arm, 'max_loss_usd', `${where}.max_loss_usd`),
      longest_underwater_sessions: field(arm, 'longest_underwater_sessions', `${where}.longest_underwater_sessions`),
      recovered: field(arm, 'recovered', `${where}.recovered`, 'bool'), end_capital: field(arm, 'end_capital', `${where}.end_capital`),
    };
  };
  const close = (left, right) => Math.abs(left - right) <= 1e-6 * Math.max(1, Math.abs(left), Math.abs(right));
  const mapped = rows.map((row, index) => {
    const where = `stress.rows[${index}]`;
    need(isObject(row), 'INVALID', where);
    const scenario = field(row, 'scenario', `${where}.scenario`, 'string');
    const labelText = preferZh(row, 'label');
    const label = typeof labelText === 'string' && labelText ? labelText : scenario;
    const role = stressRole(row);
    need(row.status === undefined || KNOWN_STRESS_STATUS.includes(row.status), 'INVALID', `${where}.status=${row.status} 不认识`);
    if (hasNoSeries(row)) {
      const reasonRaw = [row.missing_reason, row.reason_zh, row.reason].find((item) => typeof item === 'string' && item.trim());
      need(reasonRaw, 'MISSING', `${where}.reason`);
      const armCells = [pick(row.arms, BASE_KEYS), pick(row.arms, CAND_KEYS)].filter(isObject);
      need(STRESS_NUMBERS.every((key) => row[key] === null || row[key] === undefined)
        && armCells.every((arm) => ARM_NUMBERS.every((key) => arm[key] === null || arm[key] === undefined)),
      'INVALID', `${where} 缺场景／无效输入行的数字必须是 null，不能用 0 或估计值补位`);
      const kind = row.status === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'MISSING';
      const kindLabel = kind === 'INVALID_INPUT' ? '无效输入' : '缺场景';
      return {
        scenario, label, role, kind, kind_label: kindLabel, reason: reasonRaw.trim().replace(new RegExp(`^${kindLabel}[：:]\\s*`), ''),
        simulated: false, baseline: null, candidate: null, diff: null, candidate_missing: false,
      };
    }
    const simulated = field(row, 'simulated', 'stress.simulated', 'bool');
    const supplementary = row.status === 'SUPPLEMENTARY_NOT_IN_CONCLUSION';
    if (supplementary) need(simulated === true && row.in_headline === false, 'INVALID', `${where} 补充行必须 simulated:true 且 in_headline:false`);
    need(isObject(row.arms), 'MISSING', `${where}.arms`);
    const base = cell(pick(row.arms, BASE_KEYS), `${where}.arms.BASELINE`);
    need(!base.missing, 'INVALID', `${where}.arms.BASELINE 不能缺项：原版是比较的基准`);
    const cand = cell(pick(row.arms, CAND_KEYS), `${where}.arms.CANDIDATE_T3`);
    let diff = null;
    if (!cand.missing) {
      need(isObject(row.diff), 'MISSING', `${where}.diff`);
      diff = {
        max_loss_usd: field(row.diff, 'max_loss_usd', `${where}.diff.max_loss_usd`),
        end_capital: field(row.diff, 'end_capital', `${where}.diff.end_capital`),
        longest_underwater_sessions: field(row.diff, 'longest_underwater_sessions', `${where}.diff.longest_underwater_sessions`),
      };
      need(close(diff.max_loss_usd, cand.max_loss_usd - base.max_loss_usd) && close(diff.end_capital, cand.end_capital - base.end_capital)
        && close(diff.longest_underwater_sessions, cand.longest_underwater_sessions - base.longest_underwater_sessions),
      'INVALID', `${where}.diff 与两臂数字（候选 − 基线）不一致`);
    }
    return {
      scenario, label, role, kind: supplementary ? 'SUPPLEMENTARY' : (simulated ? 'SIMULATED' : 'EXECUTED'), kind_label: null, reason: null,
      simulated, baseline: base, candidate: cand, diff, candidate_missing: cand.missing,
      note: simulated ? '模拟序列，不是可交易历史' : null,
    };
  });
  const stressRoleRows = mapped.filter((row) => row.role === 'STRESS');
  const counts = {
    executed: stressRoleRows.filter((row) => row.kind === 'EXECUTED' && !row.candidate_missing).length,
    simulated: mapped.filter((row) => row.simulated).length,
    missing: stressRoleRows.filter((row) => row.kind === 'MISSING').length,
    invalid_input: stressRoleRows.filter((row) => row.kind === 'INVALID_INPUT').length,
    candidate_missing: stressRoleRows.filter((row) => row.candidate_missing).length,
    reference: mapped.filter((row) => row.role === 'REFERENCE').length,
    risk_dimension: mapped.filter((row) => row.role === 'RISK_DIMENSION').length,
  };
  return { rows: mapped, counts };
}

function verdictBlock(doc) {
  const v = doc.verdict;
  const reasons = (Array.isArray(v.reason_codes) ? v.reason_codes : [])
    .map((code) => ({ code, text: COMPARISON_REASON_WORDS[code] || REASON_WORDS[code] || `原因码 ${code}` }));
  const range = (lo, hi) => (finite(lo) && finite(hi) ? { lo, hi } : null);
  const { L_D, U_D, L_g, U_g } = boundsOf(doc);
  const { S } = populationsOf(doc.comparison);
  return {
    class: v.class, state: v.state, label: EDGE_LABELS[v.state], t3_state: v.t3_state, delta_star: DELTA_STAR, delta_g: DELTA_G,
    D_98_33: range(L_D, U_D), g_98_33: range(L_g, U_g), n_aff: isObject(S) && Number.isInteger(S.n_aff) ? S.n_aff : null,
    blocks: isObject(S) && Number.isInteger(firstFinite(S.blocks, S.n_blocks)) ? firstFinite(S.blocks, S.n_blocks) : null, fail_label: typeof preferZh(v, 'fail_label') === 'string' ? preferZh(v, 'fail_label') : null,
    reasons, bonferroni: '98.33%（Bonferroni）',
  };
}

function forwardBlock(doc) {
  const raw = forwardRows(doc);
  const SKIP = ['stream', 'file', 'file_sha256', 'sha256', 'line', 'text', 'text_zh', 'in_verdict'];
  return {
    label: '前向，只报不判，不并入结论',
    rows: raw.map((row, index) => {
      const where = `forward.rows[${index}]`;
      need(isObject(row), 'INVALID', where);
      const stream = String(row.stream || '');
      need(stream, 'MISSING', `${where}.stream`);
      const hash = row.file_sha256 || row.sha256;
      need(/^[0-9a-f]{64}$/.test(hash || ''), 'INVALID', `${where}.file_sha256`);
      const text = preferZh(row, 'text');
      const detail = isObject(row.record) ? row.record : row;
      const facts = Object.entries(detail).filter(([key, value]) => !SKIP.includes(key) && ['string', 'number', 'boolean'].includes(typeof value))
        .slice(0, 8).map(([key, value]) => `${key}：${value}`);
      return {
        stream, stream_label: stream === 'B' ? 'B 流：生产账本交易的孪生' : (stream === 'S' ? 'S 流：信号级影子' : `${stream} 流`), file: row.file || null,
        file_sha256: hash, line: Number.isInteger(row.line) ? row.line : index + 1,
        text: typeof text === 'string' && text.trim() ? text.trim() : null, facts, in_verdict: false,
      };
    }),
  };
}

function buildBlocks(doc) {
  const builders = {
    question: () => questionBlock(doc), account: () => accountBlock(doc), effect: () => effectBlock(doc), criteria: () => criteriaBlock(doc),
    stress: () => stressBlock(doc), verdict: () => verdictBlock(doc), forward: () => forwardBlock(doc),
  };
  return BLOCKS.map(([key, title]) => {
    try { return { key, title, state: 'AVAILABLE', reason: null, data: builders[key]() }; } catch (error) {
      return { key, title, state: 'NOT_COMPLETED', reason: reasonText(error), data: null };
    }
  });
}

/**
 * 优势结论、压力评价、采用条件分开写（V8.1 §6.7；Q0 冻结说明 2 G3 的同一规则）：
 * 压力场景缺场景／无效输入／候选臂缺项时压力评价不完整；样本外复用时采用条件不满足（独立样本不足，等前向成熟）。
 * 这几行永远写在主内容里，不折叠、不并入优势结论。
 */
function linesOf(stressBlock_, verdictState, oosReuse) {
  const lines = [{ kind: 'edge', tone: '', text: `优势结论：${EDGE_LABELS[verdictState] || verdictState}` }];
  let stressIncomplete = false;
  if (!stressBlock_ || stressBlock_.state !== 'AVAILABLE') {
    stressIncomplete = true;
    lines.push({ kind: 'stress', tone: 'warn', text: `压力评价不完整：压力表无法读取（${stressBlock_ ? stressBlock_.reason : '没有压力表'}）` });
  } else {
    const rows = stressBlock_.data.rows.filter((row) => row.role === 'STRESS');
    const missing = rows.filter((row) => row.kind === 'MISSING').map((row) => `${trimKind(row.label)}：缺场景`);
    const invalid = rows.filter((row) => row.kind === 'INVALID_INPUT').map((row) => `${trimKind(row.label)}：无效输入`);
    const candidateMissing = rows.filter((row) => row.candidate_missing).map((row) => `${trimKind(row.label)}：候选臂缺项`);
    if (missing.length || invalid.length || candidateMissing.length) {
      stressIncomplete = true;
      lines.push({
        kind: 'stress', tone: 'warn',
        text: `压力评价不完整：缺场景 ${missing.length} 个、无效输入 ${invalid.length} 个${candidateMissing.length ? `、候选臂缺项 ${candidateMissing.length} 个` : ''}（${[...missing, ...invalid, ...candidateMissing].join('；')}）`,
      });
    }
  }
  const reasons = [oosReuse ? ADOPTION_OOS : null, stressIncomplete ? ADOPTION_STRESS : null].filter(Boolean);
  if (reasons.length) lines.push({ kind: 'adoption', tone: 'bad', text: `采用条件：未满足（${reasons.join('；')}）` });
  return { complete: !stressIncomplete, adoption_met: !reasons.length, lines };
}

// ── 投影 ────────────────────────────────────────────────────────────────────────

function project(sealed, lock) {
  const { doc } = sealed;
  validateWhole(doc);
  const blocks = buildBlocks(doc);
  const verdict = blocks.find((block) => block.key === 'verdict');
  const completeness = linesOf(blocks.find((block) => block.key === 'stress'), doc.verdict.state, doc.oos_reuse === true);
  if (verdict.state === 'AVAILABLE') verdict.data.completeness = completeness;
  const head = baseline.headLock(lock.case_ref);
  return {
    state: 'LOCKED_VERIFIED', reason: null, class: EVAL_CLASS, question_ref: lock.question_ref, result_id: lock.result_id,
    verdict_state: doc.verdict.state, verdict_label: EDGE_LABELS[doc.verdict.state], blocks, completeness,
    baseline: { result_id: lock.baseline_result_id, current: Boolean(head && head.result_id === lock.baseline_result_id) },
    source: {
      result_id: lock.result_id, file_ref: sealed.file, file_sha256: sealed.sha256, size: sealed.size, locked_at: lock.locked_at,
      locked_by: lock.locked_by, k2_ref: K2_REF, profile_ref: PROFILE_REF, baseline_result_id: lock.baseline_result_id,
      inputs_digest: lock.inputs_digest, engine_digest: lock.engine_digest,
    },
    production_effect: 'NONE',
  };
}

const EMPTY_TEXT = '研究会话尚未交付封存的对比结果';

function emptyProjection(state, reason = EMPTY_TEXT, extra = {}) {
  return {
    state, reason, class: EVAL_CLASS, question_ref: QUESTION_REF, result_id: null, verdict_state: null, verdict_label: null,
    blocks: BLOCKS.map(([key, title]) => ({ key, title, state: 'NOT_COMPLETED', reason, data: null })),
    completeness: null, baseline: null, source: null, production_effect: 'NONE', ...extra,
  };
}

// ── Result Lock（候选对比类别）─────────────────────────────────────────────────────

function locks(caseRef = null, questionRef = null) {
  return read(LEDGER()).filter((row) => (!caseRef || row.case_ref === caseRef) && (!questionRef || row.question_ref === questionRef));
}
const headLock = (caseRef = CASE_REF, questionRef = QUESTION_REF) => {
  const rows = locks(caseRef, questionRef);
  return rows.length ? rows[rows.length - 1] : null;
};
const comparisonFor = (resultId) => locks().find((row) => row.result_id === resultId) || null;

/** 引用的基线必须是已存在的、当前的 Q0 基线锁，且原版臂与 Q0 的 D 臂逐项相同（运行门 BASELINE_REPRO 的落地核对）。 */
function checkBaseline(doc, caseRef) {
  const id = baselineIdOf(doc);
  const lock = baseline.baselineFor(id);
  need(lock && lock.case_ref === caseRef, 'Q1_BASELINE_LOCK_NOT_FOUND', id);
  const declared = isObject(doc.identity.baseline) ? doc.identity.baseline.sha256 : null;
  need(declared === null || declared === undefined || declared === lock.file_sha256, 'Q1_BASELINE_SHA256_MISMATCH', id);
  const head = baseline.headLock(caseRef);
  need(head && head.result_id === id, 'Q1_BASELINE_NOT_CURRENT', `${id} 已被 ${head ? head.result_id : '无'} 取代`);
  let q0;
  try { q0 = baseline.readSealed(lock.file_ref, { allowNonActual: true }); } catch (error) { fail('Q1_BASELINE_FILE_UNREADABLE', `${id}:${error.code || error.message}`); }
  need(q0.sha256 === lock.file_sha256, 'Q1_BASELINE_FILE_DRIFTED', id);
  const q1Base = pick(doc.arms, BASE_KEYS);
  const q0Base = q0.doc.arms && q0.doc.arms.D;
  need(isObject(q1Base) && isObject(q1Base.summary) && isObject(q0Base) && isObject(q0Base.summary), 'Q1_BASELINE_ARM_MISSING');
  for (const key of SUMMARY_KEYS) {
    const left = q1Base.summary[key];
    const right = q0Base.summary[key];
    const same = typeof left === 'number' && typeof right === 'number' ? Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(right)) : left === right;
    need(same, 'Q1_BASELINE_ARM_DIFFERS_FROM_Q0', `${key}: ${left} ≠ ${right}`);
  }
  return lock;
}

/**
 * 导入并锁定。同一文件重复导入是幂等重放；case 已有另一份 Q1 锁定时拒绝（防挑最好一次），
 * 除非显式 `supersedes` 指向当前锁并给出 `defectRef` 与 `reason`（旧锁保留）。
 */
function importCandidateComparison(file, {
  registeredBy, caseRef = CASE_REF, allowNonActual = false, supersedes = null, defectRef = null, reason = null, lockedAt = null,
} = {}) {
  authority(registeredBy);
  const sealed = readSealed(file, { allowNonActual });
  validateWhole(sealed.doc);
  const baselineLock = checkBaseline(sealed.doc, caseRef);
  const resultId = `Q1-${sealed.sha256.slice(0, 16)}`;
  const head = headLock(caseRef, QUESTION_REF);
  if (head && head.result_id === resultId) return { ...head, replayHit: true };
  if (head) {
    need(supersedes === head.result_id, 'COMPARISON_ALREADY_LOCKED', head.result_id);
    need(defectRef && reason, 'COMPARISON_SUPERSEDE_REQUIRES_DEFECT_AND_REASON');
  } else need(!supersedes, 'COMPARISON_SUPERSEDE_TARGET_NOT_FOUND', supersedes);
  const core = {
    schema: 'COMPARISON_EVALUATION_LOCK_V1', result_id: resultId, case_ref: caseRef, strategy_ref: STRATEGY_REF, question_ref: QUESTION_REF,
    eval_class: EVAL_CLASS, verdict_state: sealed.doc.verdict.state, t3_state: sealed.doc.verdict.t3_state,
    baseline_result_id: baselineLock.result_id, oos_reuse: sealed.doc.oos_reuse === true,
    file_ref: sealed.file, file_sha256: sealed.sha256, file_size: sealed.size, ...digests(sealed.doc),
    k2_ref: K2_REF, profile_ref: PROFILE_REF, supersedes_ref: supersedes, defect_ref: defectRef, supersede_reason: reason,
    production_effect: 'NONE', locked_by: registeredBy,
  };
  const body = { ...core, locked_at: lockedAt || now() };
  body.lock_hash = sha256(canonical(body));
  return append(LEDGER(), body);
}

// ── 页面读取（指纹＋TTL 缓存，同 Q0）──────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 15 * 1000;

function fingerprintOf(lock) {
  if (!lock) return 'NO_LOCK';
  const stat = (file) => { try { const item = fs.statSync(file); return `${item.size}:${item.mtimeMs}`; } catch (error) { return `ERR:${error.code}`; } };
  const head = baseline.headLock(lock.case_ref);
  return `${lock.lock_hash}|${stat(lock.file_ref)}|${stat(`${lock.file_ref}.sha256`)}|${head ? head.lock_hash : 'NO_BASELINE'}`;
}

function buildProjection(lock, { allowNonActual = false } = {}) {
  if (!lock) return emptyProjection('NOT_IMPORTED');
  try {
    const sealed = readSealed(lock.file_ref, { allowNonActual });
    if (sealed.sha256 !== lock.file_sha256) fail('Q1_RESULT_DRIFTED_AFTER_LOCK', `${lock.file_sha256.slice(0, 12)}…≠${sealed.sha256.slice(0, 12)}…`);
    return project(sealed, lock);
  } catch (error) {
    const missing = error instanceof K3Error && /MISSING/.test(error.code);
    return emptyProjection(missing ? 'MISSING' : 'INVALID', `结果文件校验失败：${reasonText(error)}`, { reason_code: error.code || 'UNKNOWN' });
  }
}

function createProjectionReader({ now: clock = Date.now, ttlMs = CACHE_TTL_MS, failureTtlMs = FAILURE_TTL_MS, head = headLock, build = buildProjection } = {}) {
  const cache = new Map();
  return {
    read(caseRef = CASE_REF) {
      const lock = head(caseRef, QUESTION_REF);
      const stamp = fingerprintOf(lock);
      const hit = cache.get(caseRef);
      if (hit && hit.stamp === stamp && clock() - hit.at < (hit.result.state === 'LOCKED_VERIFIED' ? ttlMs : failureTtlMs)) return hit.result;
      const result = build(lock);
      cache.set(caseRef, { at: clock(), stamp, result });
      return result;
    },
    clear() { cache.clear(); },
  };
}

const defaultReader = createProjectionReader();
const readProjection = (caseRef = CASE_REF) => defaultReader.read(caseRef);
const clearCache = () => defaultReader.clear();

module.exports = {
  RESULT_SCHEMA, EVAL_CLASS, QUESTION_REF, CASE_REF, STRATEGY_REF, TOP_LEVEL, K2_SHA256, RUN_GATES, DELTA_STAR, DELTA_G,
  MIN_AFFECTED, MIN_BLOCKS, BLOCKS, OOS_REUSE_LABEL, LEDGER, readSealed, validateWhole, buildBlocks, linesOf, project, emptyProjection,
  importCandidateComparison, headLock, locks, comparisonFor, createProjectionReader, readProjection, clearCache, fingerprintOf, buildProjection,
};
