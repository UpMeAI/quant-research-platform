'use strict';

/**
 * 候选对比导入器的共用读法：与题目无关的部分（封存读取、臂与压力表、前向行、三行文字）。
 * 与题目有关的东西（K2 引用、候选臂键、判据集、必填常数、样本外期望、是否要归因块）都在 questions/*.js 的登记项里，
 * 这里的函数一律带 entry 参数，错误码用 `<question>_` 前缀，Q1 的错误码与改造前逐字相同。
 */
const baseline = require('../baseline-evaluation');
const profiles = require('../strategy-profiles');

const {
  K3Error, fail, need, field, ci, finite, isObject, sha256, canonical, authority, reasonText, digests,
  stressRole, hasNoSeries, preferZh, trimKind, STRESS_NUMBERS, KNOWN_STRESS_STATUS, REASON_WORDS, EDGE_LABELS,
  resolveReasons, plainNumbers, pct1, rText,
} = baseline.internals;

const BASE_KEYS = Object.freeze(['BASELINE', 'D']);
const SUMMARY_KEYS = Object.freeze(['end_capital', 'cagr', 'max_drawdown', 'longest_underwater_sessions', 'recovered']);
const ARM_NUMBERS = Object.freeze(['max_loss_usd', 'longest_underwater_sessions', 'recovered', 'end_capital']);
const ADOPTION_STRESS = '必要压力缺失，§6.7';

/** 错误码：`<question>_<NAME>`。 */
const E = (entry, name) => `${entry.code_prefix}_${name}`;

const pick = (object, keys) => (isObject(object) ? keys.map((key) => object[key]).find((value) => value !== undefined) : undefined);
const bound = (value, index) => (Array.isArray(value) && finite(value[index]) ? value[index] : undefined);
const firstFinite = (...values) => values.find(finite);

const fmtR = (value) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)} R`;
const fmtPct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const fmtUsd = (value) => `$${Number(value).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

const edgeLabel = (entry, state) => (entry.edge_labels && entry.edge_labels[state]) || EDGE_LABELS[state];

// ── 判据逐项 ────────────────────────────────────────────────────────────────────

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
function criteriaOf(entry, doc) {
  const sources = [doc.comparison.criteria, doc.verdict.criteria, doc.comparison, doc.verdict].filter(isObject);
  const out = {};
  for (const [name, spec] of Object.entries(entry.criteria)) {
    const hits = sources.map((source) => ({ flag: flagOf(source[name], spec.kind), item: source[name] })).filter((hit) => hit.flag !== undefined);
    need(hits.length, E(entry, 'CRITERIA_INCOMPLETE'), name);
    need(hits.every((hit) => hit.flag === hits[0].flag), E(entry, 'CRITERIA_DISAGREE'), name);
    out[name] = { flag: hits[0].flag, item: isObject(hits[0].item) ? hits[0].item : {} };
  }
  return out;
}

// ── 基线、前向 ──────────────────────────────────────────────────────────────────

const baselineIdOf = (entry, doc) => {
  const fromIdentity = doc.identity.baseline_result_id || (isObject(doc.identity.baseline) ? doc.identity.baseline.result_id : null);
  const fromComparison = isObject(doc.comparison) ? doc.comparison.baseline_result_id : null;
  need(fromIdentity, E(entry, 'BASELINE_RESULT_ID_MISSING'));
  need(!fromComparison || fromComparison === fromIdentity, E(entry, 'BASELINE_RESULT_ID_DISAGREES'), `${fromIdentity}≠${fromComparison}`);
  return fromIdentity;
};

/** K2 正文把 forward 放在 comparison 下，裁定把它放在顶层；两处都认，顶层优先。 */
const forwardRows = (doc) => {
  const raw = doc.forward !== undefined && doc.forward !== null ? doc.forward : (isObject(doc.comparison) ? doc.comparison.forward : null);
  return Array.isArray(raw) ? raw : (isObject(raw) ? raw.rows : null);
};
const forwardReason = (doc) => {
  const candidates = [isObject(doc.forward) ? preferZh(doc.forward, 'reason') : null, preferZh(doc, 'forward_reason'),
    isObject(doc.comparison) ? preferZh(doc.comparison, 'forward_reason') : null];
  return candidates.find((item) => typeof item === 'string' && item.trim()) || null;
};

/** 时间戳写成「月-日」：2026-10-07T17:03:07.000Z → 10-07。 */
const shortDate = (text) => String(text).replace(/\d{4}-(\d{2}-\d{2})T[\d:.]+Z?/g, '$1');

/**
 * 前向行的一句人话（D3.9）：「MSFU 10-09 入场，推迟过时间止损，ΔR −1.07」。
 * 行里有入场标的、入场时间、ΔR 和是否受影响时按这个格式写；否则用行自己的中文说明，时间戳缩成月-日、小数缩成两位。
 * key、type、哈希等技术字段不进这一句，收在折叠里；行里的规则代号（`rule`，例如 T3）也不进这一句（修订 5 E7.2），
 * 它在折叠的技术字段里。
 */
function forwardSentence(row) {
  if (typeof row.carrier === 'string' && row.carrier && typeof row.entry_time === 'string' && finite(row.delta_R) && typeof row.affected === 'boolean') {
    const delta = row.delta_R === 0 ? '0' : `${row.delta_R < 0 ? '−' : '+'}${Math.abs(row.delta_R).toFixed(2)}`;
    return `${row.carrier} ${shortDate(row.entry_time)} 入场，${row.affected ? '推迟过时间止损' : '没有推迟时间止损（不受影响）'}，ΔR ${delta}`;
  }
  const text = preferZh(row, 'text');
  // 研究会话原文里括号中的英文原因码（如「（PREFIX_BROKEN）」）不进主内容这一句；原文整段仍在折叠的技术详情里
  return typeof text === 'string' && text.trim() ? plainNumbers(shortDate(text.trim())).replace(/（[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+）/g, '') : null;
}

function forwardBlock(doc) {
  const raw = forwardRows(doc);
  const SKIP = ['stream', 'file', 'file_sha256', 'sha256', 'line', 'text', 'text_zh', 'in_verdict'];
  const reason = forwardReason(doc);
  return {
    label: '前向，只报不判，不并入结论',
    ...(reason ? { reason_zh: reason.trim() } : {}),
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
        text: typeof text === 'string' && text.trim() ? text.trim() : null, plain_zh: forwardSentence(row), facts, in_verdict: false,
      };
    }),
  };
}

// ── 压力表 ──────────────────────────────────────────────────────────────────────

/** 压力场景角色（Q0 冻结说明 2 G2）的行里，缺场景、无效输入，或候选臂没有跑出来的。 */
const candidateArmMissing = (entry, row) => {
  const candidate = pick(row.arms, entry.candidate.keys);
  return isObject(candidate) && candidate.missing === true;
};
const incompleteStressScenarios = (entry, rows) => rows
  .filter((row) => isObject(row) && stressRole(row) === 'STRESS' && (hasNoSeries(row) || candidateArmMissing(entry, row)))
  .map((row) => row.scenario);

/**
 * 每行两臂各一格，再加差（候选 − 基线）。行的形状沿用 Q0 冻结说明 1–2：缺场景／无效输入没有序列，数字全为 null；
 * 补充行 `simulated:true` 且 `in_headline:false`。候选臂这一格可单独缺项（`missing:true` + 原因），
 * 补充行的候选臂缺项是 K2 规定的，不算压力不完整；压力场景行的候选臂缺项算不完整。
 */
function stressBlock(entry, doc) {
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
      const armCells = [pick(row.arms, BASE_KEYS), pick(row.arms, entry.candidate.keys)].filter(isObject);
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
    const cand = cell(pick(row.arms, entry.candidate.keys), `${where}.arms.${entry.candidate.key}`);
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
  // 风控维度行（只报不判）与参照行两臂数字完全相同的（例如同时持仓 3 → 5），页面合并标注「与参照相同」
  const reference = mapped.find((row) => row.role === 'REFERENCE' && row.baseline && row.candidate && !row.candidate_missing);
  const sameCell = (left, right) => ARM_NUMBERS.every((key) => left[key] === right[key]);
  for (const row of mapped) {
    if (reference && row.role === 'RISK_DIMENSION' && row.baseline && row.candidate && !row.candidate_missing
      && sameCell(row.baseline, reference.baseline) && sameCell(row.candidate, reference.candidate)) row.same_as_reference = true;
  }
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

// ── 臂 ──────────────────────────────────────────────────────────────────────────

/** 原版、候选，再加题目所属策略档案里的比较对象（US_V5：SPY 买入持有、现金）。 */
function armSummaries(entry, doc) {
  const arms = doc.arms;
  need(isObject(arms), 'MISSING', 'arms');
  const owner = profiles.byComparisonProfile(entry.profile_ref);
  need(owner, 'INVALID', `题目 ${entry.question_ref} 不属于任何已登记的策略`);
  const specs = [['BASELINE', '原版（当前 D）', BASE_KEYS], [entry.candidate.key, entry.candidate.label_zh, entry.candidate.keys],
    ...owner.comparators.map((item) => [item.key, item.label_zh, [item.key]])];
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
      deferred_sessions: entry.candidate.deferred_sessions && key === entry.candidate.key && finite(arm.deferred_sessions) ? arm.deferred_sessions : null,
    };
  });
}

/**
 * 只报不判的参照臂（登记项 `reference_arms`，例如 Q3 的 15 只 1× 多头等权买入持有）：
 * 位置在顶层 `reference_arms.<键>` 或 `arms.<键>`；页面上的名字和说明用登记项的固定写法，不取文件里的标签。
 * 读不出来只让这一行写原因，不让账户块整块失败。
 */
const referenceArmOf = (spec, doc) => (isObject(doc.reference_arms) && isObject(doc.reference_arms[spec.key]) ? doc.reference_arms[spec.key]
  : (isObject(doc.arms) && isObject(doc.arms[spec.key]) ? doc.arms[spec.key] : null));

function referenceRows(entry, doc) {
  return entry.reference_arms.map((spec) => {
    const row = { key: spec.key, label: spec.label_zh, note_zh: spec.note_zh, report_only: true };
    try {
      const arm = referenceArmOf(spec, doc);
      need(isObject(arm), 'MISSING', `reference_arms.${spec.key}`);
      const summary = arm.summary;
      need(isObject(summary), 'MISSING', `reference_arms.${spec.key}.summary`);
      const end = field(summary, 'end_capital', `reference_arms.${spec.key}.summary.end_capital`);
      if (isObject(arm.equity) && Array.isArray(arm.equity.values) && arm.equity.values.length) {
        need(Math.abs(end - arm.equity.values[arm.equity.values.length - 1]) <= 1e-6 * Math.max(1, Math.abs(end)), 'INVALID', `reference_arms.${spec.key}.summary.end_capital 与权益序列末点不一致`);
      }
      return {
        ...row, end_capital: end, cagr: field(summary, 'cagr', `reference_arms.${spec.key}.summary.cagr`),
        max_drawdown: field(summary, 'max_drawdown', `reference_arms.${spec.key}.summary.max_drawdown`),
        longest_underwater_sessions: field(summary, 'longest_underwater_sessions', `reference_arms.${spec.key}.summary.longest_underwater_sessions`),
        recovered: field(summary, 'recovered', `reference_arms.${spec.key}.summary.recovered`, 'bool'),
      };
    } catch (error) { return { ...row, unavailable_zh: reasonText(error) }; }
  });
}

function accountBlock(entry, doc) {
  const arms = armSummaries(entry, doc); // 四个臂都校验过；对比卡只列原版与候选（D3.2），基准在回测结论卡
  const base = arms[0];
  const cand = arms[1];
  return {
    arms: arms.slice(0, 2), benchmark_note_zh: '基准见回测结论卡', start: base.start, end: base.end_date,
    diff_vs_baseline: {
      end_capital: cand.end_capital - base.end_capital, cagr: cand.cagr - base.cagr,
      max_drawdown_pp: (cand.max_drawdown - base.max_drawdown) * 100,
      longest_underwater_sessions: cand.longest_underwater_sessions - base.longest_underwater_sessions,
    },
    ...(entry.reference_arms ? { reference_arms: referenceRows(entry, doc) } : {}),
  };
}

// ── 三行文字 ────────────────────────────────────────────────────────────────────

/**
 * 优势结论、压力评价、采用条件分开写（V8.1 §6.7；Q0 冻结说明 2 G3 的同一规则）：
 * 压力场景缺场景／无效输入／候选臂缺项时压力评价不完整；样本外复用时采用条件不满足。
 * 这几行永远写在主内容里，不折叠、不并入优势结论。
 */
function linesOf(entry, stressBlock_, verdictState, oosReuse) {
  const lines = [{ kind: 'edge', tone: '', text: `优势结论：${edgeLabel(entry, verdictState) || verdictState}` }];
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
  const reasons = [oosReuse ? entry.oos_reuse.adoption_zh : null, stressIncomplete ? ADOPTION_STRESS : null].filter(Boolean);
  if (reasons.length) lines.push({ kind: 'adoption', tone: 'bad', text: `采用条件：未满足（${reasons.join('；')}）` });
  return { complete: !stressIncomplete, adoption_met: !reasons.length, lines };
}

module.exports = {
  baseline, K3Error, fail, need, field, ci, finite, isObject, sha256, canonical, authority, reasonText, digests,
  stressRole, hasNoSeries, preferZh, trimKind, STRESS_NUMBERS, KNOWN_STRESS_STATUS, REASON_WORDS, EDGE_LABELS,
  BASE_KEYS, SUMMARY_KEYS, ARM_NUMBERS, ADOPTION_STRESS, E, pick, bound, firstFinite, fmtR, fmtPct, fmtUsd, edgeLabel,
  resolveReasons, plainNumbers, pct1, rText, forwardSentence,
  flagOf, criteriaOf, baselineIdOf, forwardRows, forwardReason, forwardBlock, candidateArmMissing, incompleteStressScenarios,
  stressBlock, armSummaries, accountBlock, referenceArmOf, linesOf,
};
