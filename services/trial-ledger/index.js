'use strict';

/**
 * 全局试验台账 —— 研究框架修订（2026-11-10，过拟合控制）§2、§3.6、§4，冻结页 1（★1–★17 取 (a)）。
 *
 *   - RESEARCH_TRIAL_V1：一族（strategy_ref，★1）一个配置一行；预登记、记结果、补登记、更正，全部只追加（packages/ledger.append）；
 *   - DATA_SEGMENT_MARK_V1：按族、按日期段的数据段标签；没有标签的日期一律当 SEEN（§4.1）；
 *   - OVERFIT_DISCLOSURE_V1：每个判定的披露块，数值由 ./overfit.js 算出（§3.6）。
 * N = 本族计入 N 的行里不同 rule_config_hash 的个数（★2）；UNCOUNTED_HISTORY 行的已知下限加进 N，并把 N 标为「下限」。
 * 台账只在本机 var/ledger/research/（QRP_DATA_DIR 可覆盖），不进 git。只有完成权威能写。production_effect 恒为 NONE。
 */
const crypto = require('crypto');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const overfit = require('./overfit');

const TRIALS = () => path.join(dataDir('research'), 'trials.jsonl');
const SEGMENTS = () => path.join(dataDir('research'), 'data_segments.jsonl');
const DISCLOSURES = () => path.join(dataDir('research'), 'overfit_disclosures.jsonl');

const ROLES = Object.freeze(['VERDICT_ARM', 'REPORT_ONLY_VARIANT', 'DIAGNOSTIC_ARM', 'SIGNAL_TEST', 'STRESS', 'BASELINE', 'REPRO', 'NULL_DRAW', 'WFO_FOLD', 'UNCOUNTED_HISTORY']);
const COUNTS_IN_N = Object.freeze(new Set(['VERDICT_ARM', 'REPORT_ONLY_VARIANT', 'DIAGNOSTIC_ARM', 'SIGNAL_TEST'])); // §2.2
const STAGES = Object.freeze(['SIGNAL', 'BOOK', 'ABLATION', 'WFO', 'FORWARD']);
const BOOK_LEVEL = Object.freeze(new Set(['BOOK', 'ABLATION'])); // §3.1：进方差 V 的账本级试验
const MODES = Object.freeze(['PREREGISTERED', 'UNPLANNED_RUN', 'BACK_REGISTERED']);
const LABELS = Object.freeze(['UNSEEN', 'SEEN', 'FORWARD_RESERVED', 'FORWARD_READ']);
const SEEN_KINDS = Object.freeze(['HISTORY_V1', 'SEEN_DATA', 'SEEN_DATA_DECISION', 'REPORT_ONLY']);
const METRIC_KEYS = Object.freeze(['n_trades', 'changed_entries', 'g', 'delta_g', 'delta_g_ci95', 'mdd', 'worst_month', 'cvar5']);
const EVAL_KEYS = Object.freeze(['cost', 'costs', 'cost_model', 'timing', 'engine', 'engine_sha', 'code_sha', 'window']); // rule_config_hash 不含成本、时点、引擎
const SHA64 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TRIAL_ID = /^TRL-[0-9a-f]{16}$/;

class TrialLedgerError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new TrialLedgerError(`TRIAL_LEDGER_${code}`, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 规范 JSON：对象键按字典序递归排序。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  if (typeof value === 'number' && !Number.isFinite(value)) fail('NON_FINITE_NUMBER');
  return JSON.stringify(value);
}
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const recordHash = (body) => { const { record_hash: _omit, ...rest } = body; return sha256(canonicalJson(rest)); };

function authority(registeredBy) {
  need(isText(registeredBy), 'REGISTERED_BY_REQUIRED');
  const expected = process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  need(expected, 'AUTHORITY_NOT_CONFIGURED');
  need(registeredBy === expected, 'REGISTERED_BY_NOT_AUTHORIZED');
}

/** rule_config_hash：规则开关、参数、信号定义的规范 JSON 的 sha256；不含成本、时点、引擎（§2.3）。 */
function ruleConfigHash(ruleConfig) {
  need(isObj(ruleConfig) && Object.keys(ruleConfig).length, 'RULE_CONFIG_REQUIRED');
  const bad = Object.keys(ruleConfig).filter((k) => EVAL_KEYS.includes(k));
  need(!bad.length, 'RULE_CONFIG_HAS_EVAL_KEY', bad.join(','));
  return sha256(canonicalJson(ruleConfig));
}
/** eval_hash：rule_config_hash ＋ 窗口 ＋ 成本 ＋ 时点 ＋ 运行代码 sha。 */
const evalHash = ({ rule_config_hash: rch, window, costs, timing, code_sha: codeSha }) => sha256(canonicalJson({ rule_config_hash: rch, window, costs: costs ?? null, timing: timing ?? null, code_sha: codeSha ?? null }));
/** trial_id 只由（族、题、配置名）决定，K2 写出之前就能算出并写进 K2（§9 第 2 条）。 */
const trialIdOf = ({ family_id: f, study_ref: s, config_label: c }) => `TRL-${sha256(canonicalJson({ family_id: f, study_ref: s, config_label: c })).slice(0, 16)}`;

// ── 读 ─────────────────────────────────────────────────────────────────────────

const trialRows = () => read(TRIALS()).filter((r) => r.schema === 'RESEARCH_TRIAL_V1');
function heads(rows = trialRows()) {
  const m = new Map();
  for (const r of rows) m.set(r.trial_id, r);
  return m;
}
const headOf = (trialId, rows) => heads(rows).get(trialId) || null;
const asOfFilter = (asOf) => (r) => !asOf || Date.parse(r.registered_at) <= Date.parse(asOf);

// ── 登记 ───────────────────────────────────────────────────────────────────────

function validateSpec(spec, mode) {
  need(isObj(spec), 'SPEC_NOT_OBJECT');
  for (const k of ['family_id', 'market', 'study_ref', 'config_label']) need(isText(spec[k]), 'SPEC_FIELD_REQUIRED', k);
  need(STAGES.includes(spec.stage), 'STAGE_INVALID', String(spec.stage));
  need(ROLES.includes(spec.role), 'ROLE_INVALID', String(spec.role));
  need(MODES.includes(mode), 'MODE_INVALID', String(mode));
  if (mode === 'PREREGISTERED') need(SHA64.test(spec.k2_sha256 || ''), 'PREREGISTERED_NEEDS_K2_SHA256', spec.config_label);
  for (const k of ['k2_sha256', 'freeze_sha256']) need(spec[k] == null || SHA64.test(spec[k]), 'SHA256_INVALID', k);
  if (spec.role === 'UNCOUNTED_HISTORY') {
    need(mode === 'BACK_REGISTERED', 'UNCOUNTED_HISTORY_ONLY_BACK_REGISTERED');
    need(Number.isInteger(spec.uncounted_lower_bound) && spec.uncounted_lower_bound >= 0, 'UNCOUNTED_HISTORY_NEEDS_LOWER_BOUND');
    need(Array.isArray(spec.source_refs) && spec.source_refs.length, 'UNCOUNTED_HISTORY_NEEDS_SOURCE');
  }
  need(spec.rule_config !== undefined || SHA64.test(spec.rule_config_hash || ''), 'RULE_CONFIG_REQUIRED', spec.config_label);
  for (const k of ['delta_vs_baseline', 'params_tried', 'source_refs', 'segments']) need(spec[k] === undefined || Array.isArray(spec[k]), 'SPEC_FIELD_NOT_ARRAY', k);
  need(spec.unknown === undefined || isObj(spec.unknown), 'SPEC_FIELD_NOT_OBJECT', 'unknown');
}

function registrationBody(spec, mode, registeredBy, registeredAt) {
  const rch = spec.rule_config !== undefined ? ruleConfigHash(spec.rule_config) : spec.rule_config_hash;
  if (spec.rule_config !== undefined && spec.rule_config_hash) need(spec.rule_config_hash === rch, 'RULE_CONFIG_HASH_MISMATCH', spec.config_label);
  const body = {
    schema: 'RESEARCH_TRIAL_V1', trial_id: trialIdOf(spec), row_kind: 'REGISTRATION', family_id: spec.family_id, market: spec.market,
    shared_mechanism: spec.shared_mechanism || null, study_ref: spec.study_ref, k2_sha256: spec.k2_sha256 || null, freeze_sha256: spec.freeze_sha256 || null,
    stage: spec.stage, role: spec.role, registration_mode: mode, rule_config_hash: rch, eval_hash: null, config_label: spec.config_label,
    delta_vs_baseline: spec.delta_vs_baseline || [], baseline_trial_ref: spec.baseline_trial_ref || null, window: spec.window || null,
    segments: spec.segments || [], params_tried: spec.params_tried || [], metrics: spec.metrics || null,
    sr_monthly_delta: spec.sr_monthly_delta ?? null, skew: spec.skew ?? null, kurt: spec.kurt ?? null, t_months: spec.t_months ?? null,
    series_ref: spec.series_ref || null, study_verdict: spec.study_verdict ?? null, source_refs: spec.source_refs || [], unknown: spec.unknown || {},
    supersedes: null, defect_ref: null, production_effect: 'NONE', registered_by: registeredBy, registered_at: registeredAt,
  };
  if (spec.rule_config !== undefined) body.rule_config = spec.rule_config;
  if (spec.role === 'UNCOUNTED_HISTORY') body.uncounted_lower_bound = spec.uncounted_lower_bound;
  if (spec.notes_zh) body.notes_zh = spec.notes_zh;
  body.record_hash = recordHash(body);
  return body;
}
const sameRegistration = (a, b) => { const strip = ({ registered_at: _a, record_hash: _h, ...rest }) => canonicalJson(rest); return strip(a) === strip(b); };

/**
 * 登记一批试验（预登记 / 未计划的运行 / 补登记）。整批先校验，全部通过才写；同一内容重复登记是幂等重放。
 * @returns {object[]} 每条的行（重放的带 replayHit: true）
 */
function register(specs, { registeredBy, registeredAt = null, mode = 'PREREGISTERED', dryRun = false } = {}) {
  authority(registeredBy);
  const list = Array.isArray(specs) ? specs : [specs];
  need(list.length, 'NOTHING_TO_REGISTER');
  const stamp = registeredAt || now();
  const all = trialRows();
  const existing = heads(all);
  const seen = new Set();
  const plan = list.map((spec) => {
    validateSpec(spec, mode);
    const body = registrationBody(spec, mode, registeredBy, stamp);
    need(!seen.has(body.trial_id), 'DUPLICATE_IN_BATCH', `${spec.study_ref}:${spec.config_label}`);
    seen.add(body.trial_id);
    const prior = all.find((r) => r.trial_id === body.trial_id && r.row_kind === 'REGISTRATION');
    if (prior) {
      need(sameRegistration(prior, body), 'ALREADY_REGISTERED', `${body.trial_id}（${spec.config_label}）`);
      return { replay: existing.get(body.trial_id) };
    }
    return { body };
  });
  if (dryRun) return plan.map((p) => (p.replay ? { ...p.replay, replayHit: true } : { ...p.body, dryRun: true }));
  return plan.map((p) => (p.replay ? { ...p.replay, replayHit: true } : append(TRIALS(), p.body)));
}

/** 月度 d 序列 → ŜR、γ3、γ4、T（§3.1、§3.2）；算不出写 UNKNOWN 与原因。 */
function seriesStats(months) {
  const d = months.map((m) => m.d);
  const m = overfit.moments(d);
  const val = (v) => (isNum(v) ? v : overfit.UNKNOWN);
  const unknown = {};
  for (const [k, v] of [['sr_monthly_delta', m.sr], ['skew', m.skew], ['kurt', m.kurt]]) if (!isNum(v)) unknown[k] = v.reason;
  return { sr_monthly_delta: val(m.sr), skew: val(m.skew), kurt: val(m.kurt), t_months: m.T, unknown };
}

/**
 * 记结果（每个试验只记一次；改要 correct）。数字只从封存文件或运行产物来，不估。
 * result: { window{from,to}, eval{costs,timing,code_sha}, metrics{…}, months?[{month,d}], series_ref?{path,sha256}, study_verdict, unknown?{} }
 */
function recordResult(trialId, result, { registeredBy, registeredAt = null } = {}) {
  authority(registeredBy);
  need(TRIAL_ID.test(trialId || ''), 'TRIAL_ID_INVALID', String(trialId));
  const rows = trialRows();
  const head = headOf(trialId, rows);
  need(head, 'TRIAL_NOT_REGISTERED', trialId);
  need(!rows.some((r) => r.trial_id === trialId && r.row_kind !== 'REGISTRATION'), 'RESULT_ALREADY_RECORDED', trialId);
  return append(TRIALS(), resultBody(head, result, 'RESULT', registeredBy, registeredAt || now(), null, null));
}

function resultBody(head, result, rowKind, registeredBy, stamp, supersedes, defectRef) {
  need(isObj(result), 'RESULT_NOT_OBJECT');
  const window = result.window || head.window;
  need(isObj(window) && DATE.test(window.from || '') && DATE.test(window.to || '') && window.from <= window.to, 'WINDOW_INVALID', head.trial_id);
  const metrics = result.metrics || {};
  need(isObj(metrics), 'METRICS_NOT_OBJECT');
  const extra = Object.keys(metrics).filter((k) => !METRIC_KEYS.includes(k));
  need(!extra.length, 'METRIC_KEY_UNKNOWN', extra.join(','));
  const unknown = { ...(head.unknown || {}), ...(result.unknown || {}) };
  for (const k of METRIC_KEYS) if (!(k in metrics) && !unknown[`metrics.${k}`]) unknown[`metrics.${k}`] = 'NOT_REPORTED';
  let stats = { sr_monthly_delta: overfit.UNKNOWN, skew: overfit.UNKNOWN, kurt: overfit.UNKNOWN, t_months: overfit.UNKNOWN, unknown: {} };
  if (Array.isArray(result.months)) stats = seriesStats(result.months);
  else if (BOOK_LEVEL.has(head.stage) && COUNTS_IN_N.has(head.role)) need(unknown.sr_monthly_delta, 'BOOK_TRIAL_NEEDS_SERIES_OR_UNKNOWN_REASON', head.trial_id);
  for (const [k, v] of Object.entries(stats.unknown)) unknown[k] = v;
  const ev = result.eval || {};
  const body = {
    ...head, row_kind: rowKind, window, segments: result.segments || segmentLabels(head.family_id, window.from, window.to, { shadowRef: result.shadow_ref || null }),
    eval_hash: evalHash({ rule_config_hash: head.rule_config_hash, window, costs: ev.costs, timing: ev.timing, code_sha: ev.code_sha }),
    metrics, sr_monthly_delta: stats.sr_monthly_delta, skew: stats.skew, kurt: stats.kurt, t_months: stats.t_months,
    series_ref: result.series_ref || head.series_ref || null, study_verdict: result.study_verdict ?? head.study_verdict ?? null,
    source_refs: [...(head.source_refs || []), ...(result.source_refs || [])], unknown, supersedes, defect_ref: defectRef,
    registered_by: registeredBy, registered_at: stamp,
  };
  if (result.series_ref) need(isText(result.series_ref.path) && SHA64.test(result.series_ref.sha256 || ''), 'SERIES_REF_INVALID', head.trial_id);
  delete body.record_hash;
  body.record_hash = recordHash(body);
  return body;
}

/** 更正：只追加新行，supersedes 指向当前 head 的 record_hash，必须带缺陷引用（§2.3）。 */
function correct(trialId, result, { registeredBy, defectRef, registeredAt = null } = {}) {
  authority(registeredBy);
  need(isText(defectRef), 'CORRECTION_NEEDS_DEFECT_REF');
  const head = headOf(trialId);
  need(head, 'TRIAL_NOT_REGISTERED', trialId);
  return append(TRIALS(), resultBody(head, result, 'CORRECTION', registeredBy, registeredAt || now(), head.record_hash, defectRef));
}

// ── 计数（★2） ─────────────────────────────────────────────────────────────────

/** 本族截至 asOf 的 N：计入 N 的角色里不同 rule_config_hash 的个数，加 UNCOUNTED_HISTORY 的已知下限。 */
function count(familyId, { asOf = null, rows = null } = {}) {
  const live = [...heads((rows || trialRows()).filter(asOfFilter(asOf))).values()].filter((r) => r.family_id === familyId);
  const hashes = new Set(live.filter((r) => COUNTS_IN_N.has(r.role)).map((r) => r.rule_config_hash));
  const uncounted = live.filter((r) => r.role === 'UNCOUNTED_HISTORY');
  const pendingArms = live.filter((r) => r.unknown && r.unknown.arms);
  const byRole = {}; const byMode = {};
  for (const r of live) { byRole[r.role] = (byRole[r.role] || 0) + 1; byMode[r.registration_mode] = (byMode[r.registration_mode] || 0) + 1; }
  const lowerBoundReasons = [
    ...(uncounted.length ? [`UNCOUNTED_HISTORY×${uncounted.length}`] : []),
    ...(pendingArms.length ? [`K2_ARMS_NOT_CATALOGUED×${new Set(pendingArms.map((r) => r.study_ref)).size}`] : []),
  ];
  return {
    family_id: familyId, as_of: asOf, n_raw: hashes.size + uncounted.reduce((a, r) => a + (r.uncounted_lower_bound || 0), 0),
    n_distinct_configs: hashes.size, n_uncounted_lower_bound: uncounted.reduce((a, r) => a + (r.uncounted_lower_bound || 0), 0),
    n_is_lower_bound: lowerBoundReasons.length > 0, lower_bound_reasons: lowerBoundReasons, rows: live.length, by_role: byRole, by_mode: byMode,
    studies: new Set(live.map((r) => r.study_ref)).size,
  };
}

/** 进方差 V 的 ŜR：本族计入 N 的账本级试验，一配置一个（同配置取最后登记的数值）。 */
function familySharpes(familyId, { asOf = null, rows = null } = {}) {
  const byHash = new Map();
  for (const r of heads((rows || trialRows()).filter(asOfFilter(asOf))).values()) {
    if (r.family_id !== familyId || !COUNTS_IN_N.has(r.role) || !BOOK_LEVEL.has(r.stage) || !isNum(r.sr_monthly_delta)) continue;
    byHash.set(r.rule_config_hash, { trial_id: r.trial_id, sr: r.sr_monthly_delta });
  }
  return [...byHash.values()];
}

// ── 数据段（§4.1） ─────────────────────────────────────────────────────────────

const addDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

function markSegments(specs, { registeredBy, registeredAt = null, dryRun = false } = {}) {
  authority(registeredBy);
  const list = Array.isArray(specs) ? specs : [specs];
  const stamp = registeredAt || now();
  const bodies = list.map((s) => {
    need(isObj(s) && isText(s.family_id) && isText(s.market) && isText(s.reason), 'SEGMENT_FIELD_REQUIRED');
    need(DATE.test(s.from || '') && DATE.test(s.to || '') && s.from <= s.to, 'SEGMENT_RANGE_INVALID', `${s.from}..${s.to}`);
    need(LABELS.includes(s.label), 'SEGMENT_LABEL_INVALID', String(s.label));
    need(s.seen_kind == null || (s.label === 'SEEN' && SEEN_KINDS.includes(s.seen_kind)), 'SEEN_KIND_INVALID', String(s.seen_kind));
    const overlay = s.label === 'FORWARD_RESERVED' || s.label === 'FORWARD_READ';
    need(overlay ? isText(s.shadow_ref) : s.shadow_ref == null, 'SHADOW_REF_ONLY_FOR_FORWARD_LABELS', s.label);
    need(s.supersedes == null || isText(s.defect_ref), 'SEGMENT_SUPERSEDE_NEEDS_DEFECT_REF');
    const body = {
      schema: 'DATA_SEGMENT_MARK_V1', mark_id: `SEG-${sha256(canonicalJson({ f: s.family_id, from: s.from, to: s.to, label: s.label, shadow: s.shadow_ref || null, at: stamp })).slice(0, 16)}`,
      family_id: s.family_id, market: s.market, from: s.from, to: s.to, label: s.label, seen_kind: s.seen_kind || null, shadow_ref: s.shadow_ref || null,
      reason: s.reason, source_refs: s.source_refs || [], supersedes: s.supersedes || null, defect_ref: s.defect_ref || null,
      production_effect: 'NONE', registered_by: registeredBy, registered_at: stamp,
    };
    body.record_hash = recordHash(body);
    return body;
  });
  return dryRun ? bodies : bodies.map((b) => append(SEGMENTS(), b));
}

/**
 * 一族在 [from, to] 上的段：底色（UNSEEN / SEEN，后写的覆盖先写的；没标的日期一律 SEEN）加前向保留（只对 shadow_ref 的候选）。
 * @returns {{pieces: {from,to,label,seen_kind,source}[], reservations: {from,to,label,shadow_ref}[]}}
 */
function segmentsFor(familyId, from, to) {
  need(DATE.test(from || '') && DATE.test(to || '') && from <= to, 'SEGMENT_RANGE_INVALID', `${from}..${to}`);
  const marks = read(SEGMENTS()).filter((r) => r.schema === 'DATA_SEGMENT_MARK_V1' && r.family_id === familyId);
  const days = [];
  for (let d = from; d <= to; d = addDay(d)) days.push({ d, label: 'SEEN', seen_kind: null, source: 'UNMARKED_DEFAULT_SEEN' });
  for (const m of marks) {
    if (m.label !== 'SEEN' && m.label !== 'UNSEEN') continue;
    for (const day of days) if (day.d >= m.from && day.d <= m.to) Object.assign(day, { label: m.label, seen_kind: m.seen_kind, source: m.mark_id });
  }
  const pieces = [];
  for (const day of days) {
    const last = pieces[pieces.length - 1];
    if (last && last.label === day.label && last.seen_kind === day.seen_kind && last.source === day.source) last.to = day.d;
    else pieces.push({ from: day.d, to: day.d, label: day.label, seen_kind: day.seen_kind, source: day.source });
  }
  const reservations = marks.filter((m) => (m.label === 'FORWARD_RESERVED' || m.label === 'FORWARD_READ') && m.from <= to && m.to >= from)
    .map((m) => ({ from: m.from > from ? m.from : from, to: m.to < to ? m.to : to, label: m.label, shadow_ref: m.shadow_ref }));
  return { pieces, reservations };
}

/** 写进试验行 segments[] 的标签：底色标签去重；本试验是某影子的候选时，其保留段写成 FORWARD_RESERVED:<shadow>。 */
function segmentLabels(familyId, from, to, { shadowRef = null } = {}) {
  const { pieces, reservations } = segmentsFor(familyId, from, to);
  const labels = [...new Set(pieces.map((p) => (p.seen_kind ? `${p.label}:${p.seen_kind}` : p.label)))];
  for (const r of reservations) if (r.label === 'FORWARD_RESERVED' && r.shadow_ref === shadowRef) labels.push(`FORWARD_RESERVED:${r.shadow_ref}`);
  return labels;
}

// ── 披露（§3.6） ───────────────────────────────────────────────────────────────

const numOr = (v, unknown, key) => { if (isNum(v)) return v; unknown[key] = v && v.reason ? v.reason : 'UNKNOWN'; return overfit.UNKNOWN; };

/**
 * 算并写一条 OVERFIT_DISCLOSURE_V1（只追加）。
 * spec: { family_id, study_ref, k2_sha256, verdict_trial_id, months[{month,d}], seed, original_verdict{decision,strength},
 *         peer_series?{trial_id:{month:d}}, pbo_matrix?, pbo_config_count?, sealed_sha256?, as_of?, inputs?{} }
 */
function disclose(spec, { registeredBy, registeredAt = null, dryRun = false } = {}) {
  authority(registeredBy);
  need(isObj(spec) && isText(spec.family_id) && isText(spec.study_ref), 'DISCLOSURE_FIELD_REQUIRED');
  need(SHA64.test(spec.k2_sha256 || ''), 'SHA256_INVALID', 'k2_sha256');
  need(Array.isArray(spec.months) && spec.months.every((m) => /^\d{4}-\d{2}$/.test(m.month) && isNum(m.d)), 'DISCLOSURE_MONTHS_INVALID');
  need(isObj(spec.original_verdict), 'DISCLOSURE_NEEDS_ORIGINAL_VERDICT');
  const rows = trialRows();
  const arm = headOf(spec.verdict_trial_id, rows);
  need(arm && arm.family_id === spec.family_id && arm.k2_sha256 === spec.k2_sha256, 'VERDICT_TRIAL_NOT_IN_STUDY', String(spec.verdict_trial_id));
  const stats = seriesStats(spec.months);
  if (isNum(arm.sr_monthly_delta)) need(Math.abs(arm.sr_monthly_delta - stats.sr_monthly_delta) < 1e-12, 'SERIES_DOES_NOT_MATCH_TRIAL_ROW', arm.trial_id);
  const asOf = spec.as_of || null;
  const n = count(spec.family_id, { asOf, rows });
  need(n.n_raw >= 1, 'FAMILY_HAS_NO_COUNTED_TRIAL', spec.family_id);
  const sharpes = familySharpes(spec.family_id, { asOf, rows });
  if (!sharpes.some((s) => s.trial_id === arm.trial_id) && isNum(stats.sr_monthly_delta) && BOOK_LEVEL.has(arm.stage)) sharpes.push({ trial_id: arm.trial_id, sr: stats.sr_monthly_delta });
  const d = spec.months.map((m) => m.d);
  const dsr = overfit.deflatedSharpe({ d, N: n.n_raw, familySharpes: sharpes.map((s) => s.sr) });
  let pboResult = { value: 'NOT_APPLICABLE', reason: 'NO_MATRIX_OR_CONFIGS_LT_4' };
  if (spec.pbo_matrix) pboResult = overfit.pbo(spec.pbo_matrix);
  else if (Number.isInteger(spec.pbo_config_count) && spec.pbo_config_count >= overfit.PBO_MIN_CONFIGS) pboResult = { value: overfit.UNKNOWN, reason: 'APPLICABLE_BUT_NO_DAILY_MATRIX' };
  const fallback = isNum(dsr.dsr) ? null : overfit.bonferroniFallback({ d, N: n.n_raw, seed: spec.seed });
  const gate = overfit.overfitColumn(spec.original_verdict, { dsr: dsr.dsr, pbo: pboResult.value, fallback });
  const nHat = overfit.effectiveN(n.n_raw, { ...(spec.peer_series || {}), [arm.trial_id]: Object.fromEntries(spec.months.map((m) => [m.month, m.d])) });
  const unknown = { ...stats.unknown };
  const studyHashes = new Set([...heads(rows).values()].filter((r) => r.family_id === spec.family_id && r.k2_sha256 === spec.k2_sha256 && COUNTS_IN_N.has(r.role)).map((r) => r.rule_config_hash));
  const window = arm.window;
  const body = {
    schema: 'OVERFIT_DISCLOSURE_V1', disclosure_id: `OVD-${sha256(canonicalJson({ f: spec.family_id, k2: spec.k2_sha256, arm: arm.trial_id })).slice(0, 16)}`,
    family_id: spec.family_id, study_ref: spec.study_ref, k2_sha256: spec.k2_sha256, verdict_trial_ref: arm.trial_id, sealed_sha256: spec.sealed_sha256 || null,
    n_raw: n.n_raw, n_is_lower_bound: n.n_is_lower_bound, n_hat: numOr(nHat.nHat, unknown, 'n_hat'), v: numOr(dsr.V, unknown, 'v'), sr0: numOr(dsr.sr0, unknown, 'sr0'),
    sr_hat: numOr(dsr.sr, unknown, 'sr_hat'), skew: numOr(dsr.skew, unknown, 'skew'), kurt: numOr(dsr.kurt, unknown, 'kurt'), t_months: dsr.T,
    psr0: numOr(dsr.psr0, unknown, 'psr0'), dsr: numOr(dsr.dsr, unknown, 'dsr'),
    pbo: pboResult.value, fallback: fallback ? { ...fallback, lower: isNum(fallback.lower) ? fallback.lower : overfit.UNKNOWN } : null,
    segment_labels: window ? segmentLabels(spec.family_id, window.from, window.to) : [], new_configs: studyHashes.size,
    evidence_gate: { original: gate.original, decision: gate.decision, strength: gate.strength, downgraded: gate.downgraded, applied: gate.applied, failed: gate.failed, label_zh: gate.label_zh || null },
    inputs: { known_sr_count: sharpes.length, n_lower_bound_reasons: n.lower_bound_reasons, rho_bar: isNum(nHat.rhoBar) ? nHat.rhoBar : overfit.UNKNOWN, rho_pairs: nHat.pairs, pbo_detail: isNum(pboResult.value) ? { combinations: pboResult.combinations, configs: pboResult.configs, rows: pboResult.rows, dropped_rows: pboResult.droppedRows } : { reason: pboResult.reason }, ...(spec.inputs || {}) },
    unknown, computed_by: 'services/trial-ledger/overfit.js', supersedes: spec.supersedes || null, defect_ref: spec.defect_ref || null,
    production_effect: 'NONE', registered_by: registeredBy, registered_at: registeredAt || now(),
  };
  if (!isNum(pboResult.value) && pboResult.reason) unknown.pbo = pboResult.reason;
  if (body.dsr === overfit.UNKNOWN && fallback) unknown.dsr_fallback = '★5 (a)：按族 N 的 Bonferroni';
  const prior = read(DISCLOSURES()).filter((r) => r.disclosure_id === body.disclosure_id);
  if (prior.length) need(body.supersedes === prior[prior.length - 1].record_hash && isText(body.defect_ref), 'DISCLOSURE_EXISTS_SUPERSEDE_WITH_DEFECT', body.disclosure_id);
  body.record_hash = recordHash(body);
  return dryRun ? body : append(DISCLOSURES(), body);
}

/** 只有这两个字段可以按裁定写「不适用」（凯利 m 前推门裁定 §2，99203316…）。 */
const NOT_APPLICABLE_FIELDS = Object.freeze(['dsr', 'pbo']);

/**
 * 写一条 DSR、PBO「不适用」的 OVERFIT_DISCLOSURE_V1（只追加）：冻结页已裁定本题不比收益、没有收益序列时用。
 * 必须引用一页按 sha256 绑定的协调会话裁定；只放行 dsr、pbo 两个字段，其余字段照 disclose 的算法：
 * N（原始计数、是否下限）、本题新增配置数、段标签照算；只能由收益序列算出的 N̂、V、SR0、ŜR、γ3、γ4、T、PSR(0) 写 UNKNOWN 与原因。
 * 证据闸门照 overfit.overfitColumn 走（「做 · 有支持证据」照样降为「证据不足」），不因不适用而放宽。
 * spec: { family_id, study_ref, k2_sha256, verdict_trial_id, original_verdict{decision,strength}, sealed_sha256?, as_of?,
 *         not_applicable: { fields: ['dsr','pbo'], reason_zh, ruling: {ref, sha256}, freeze?: {ref, sha256} } }
 */
function discloseNotApplicable(spec, { registeredBy, registeredAt = null, dryRun = false } = {}) {
  authority(registeredBy);
  need(isObj(spec) && isText(spec.family_id) && isText(spec.study_ref), 'DISCLOSURE_FIELD_REQUIRED');
  need(SHA64.test(spec.k2_sha256 || ''), 'SHA256_INVALID', 'k2_sha256');
  need(isObj(spec.original_verdict), 'DISCLOSURE_NEEDS_ORIGINAL_VERDICT');
  const na = spec.not_applicable;
  need(isObj(na) && Array.isArray(na.fields) && [...na.fields].sort().join(',') === NOT_APPLICABLE_FIELDS.join(','), 'DISCLOSURE_NOT_APPLICABLE_FIELDS', 'only dsr, pbo');
  need(isText(na.reason_zh), 'DISCLOSURE_NOT_APPLICABLE_REASON_REQUIRED');
  need(isObj(na.ruling) && isText(na.ruling.ref) && SHA64.test(na.ruling.sha256 || ''), 'DISCLOSURE_NOT_APPLICABLE_NEEDS_RULING');
  if (na.freeze !== undefined && na.freeze !== null) need(isObj(na.freeze) && isText(na.freeze.ref) && SHA64.test(na.freeze.sha256 || ''), 'SHA256_INVALID', 'not_applicable.freeze');
  const rows = trialRows();
  const arm = headOf(spec.verdict_trial_id, rows);
  need(arm && arm.family_id === spec.family_id && arm.k2_sha256 === spec.k2_sha256, 'VERDICT_TRIAL_NOT_IN_STUDY', String(spec.verdict_trial_id));
  const asOf = spec.as_of || null;
  const n = count(spec.family_id, { asOf, rows });
  need(n.n_raw >= 1, 'FAMILY_HAS_NO_COUNTED_TRIAL', spec.family_id);
  const gate = overfit.overfitColumn(spec.original_verdict, { dsr: 'NOT_APPLICABLE', pbo: 'NOT_APPLICABLE', fallback: null });
  const studyHashes = new Set([...heads(rows).values()].filter((r) => r.family_id === spec.family_id && r.k2_sha256 === spec.k2_sha256 && COUNTS_IN_N.has(r.role)).map((r) => r.rule_config_hash));
  const window = arm.window;
  const unknown = {};
  for (const key of ['n_hat', 'v', 'sr0', 'sr_hat', 'skew', 'kurt', 't_months', 'psr0']) unknown[key] = 'NO_RETURN_SERIES_DSR_NOT_APPLICABLE';
  const body = {
    schema: 'OVERFIT_DISCLOSURE_V1', disclosure_id: `OVD-${sha256(canonicalJson({ f: spec.family_id, k2: spec.k2_sha256, arm: arm.trial_id })).slice(0, 16)}`,
    family_id: spec.family_id, study_ref: spec.study_ref, k2_sha256: spec.k2_sha256, verdict_trial_ref: arm.trial_id, sealed_sha256: spec.sealed_sha256 || null,
    n_raw: n.n_raw, n_is_lower_bound: n.n_is_lower_bound, n_hat: overfit.UNKNOWN, v: overfit.UNKNOWN, sr0: overfit.UNKNOWN,
    sr_hat: overfit.UNKNOWN, skew: overfit.UNKNOWN, kurt: overfit.UNKNOWN, t_months: overfit.UNKNOWN, psr0: overfit.UNKNOWN,
    dsr: 'NOT_APPLICABLE', pbo: 'NOT_APPLICABLE', fallback: null,
    segment_labels: window ? segmentLabels(spec.family_id, window.from, window.to) : [], new_configs: studyHashes.size,
    evidence_gate: { original: gate.original, decision: gate.decision, strength: gate.strength, downgraded: gate.downgraded, applied: gate.applied, failed: gate.failed, label_zh: gate.label_zh || null },
    inputs: { n_lower_bound_reasons: n.lower_bound_reasons,
      not_applicable: { fields: [...NOT_APPLICABLE_FIELDS], reason_zh: na.reason_zh, ruling_ref: na.ruling.ref, ruling_sha256: na.ruling.sha256,
        freeze_ref: na.freeze ? na.freeze.ref : null, freeze_sha256: na.freeze ? na.freeze.sha256 : null } },
    unknown, computed_by: 'services/trial-ledger/index.js#discloseNotApplicable', supersedes: spec.supersedes || null, defect_ref: spec.defect_ref || null,
    production_effect: 'NONE', registered_by: registeredBy, registered_at: registeredAt || now(),
  };
  const prior = read(DISCLOSURES()).filter((r) => r.disclosure_id === body.disclosure_id);
  if (prior.length) need(body.supersedes === prior[prior.length - 1].record_hash && isText(body.defect_ref), 'DISCLOSURE_EXISTS_SUPERSEDE_WITH_DEFECT', body.disclosure_id);
  body.record_hash = recordHash(body);
  return dryRun ? body : append(DISCLOSURES(), body);
}

const disclosures = (filter = {}) => read(DISCLOSURES()).filter((r) => r.schema === 'OVERFIT_DISCLOSURE_V1'
  && (!filter.family_id || r.family_id === filter.family_id) && (!filter.k2_sha256 || r.k2_sha256 === filter.k2_sha256));

module.exports = {
  TRIALS, SEGMENTS, DISCLOSURES, ROLES, COUNTS_IN_N, STAGES, BOOK_LEVEL, MODES, LABELS, SEEN_KINDS, METRIC_KEYS, TRIAL_ID, SHA64,
  TrialLedgerError, canonicalJson, ruleConfigHash, evalHash, trialIdOf, recordHash, trialRows, heads, headOf,
  register, recordResult, correct, count, familySharpes, markSegments, segmentsFor, segmentLabels, disclose, discloseNotApplicable, NOT_APPLICABLE_FIELDS, disclosures, seriesStats,
  internals: { authority, need, fail, sameRegistration },
};
