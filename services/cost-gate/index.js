'use strict';

/**
 * G-COST 成本门 —— 毛收益（不计成本）的回放不得作为「做 / 不做」结论导入。合同 docs/contracts/COST_MODEL_GATE_V1.md。
 *
 * 起因：adapters/us-replay-core 声明 cost_model_version REPLAY_CORE_COSTS_NONE(CLOSE_MARK…)，成本拆分写明佣金、滑点 NOT_MODELLED，
 * 「收益是毛收益，不得按已计成本解读」；此前没有一道门挡住用这种回放判出的结论。
 *
 * 接进海外与 A 股封存结论导入器（同一套 checkEntry），在 G-TRIAL、G-MECH、G-CAUSAL 之后运行。
 * 门只会拒绝导入（失败即关，错误码 COST_MODEL_*），从不改写结论，也不会因此判「不做」；没有裁定放行的路径。
 *
 *   过门的题：kind = RESULT（READING 只报，DRAFT / STATUS 不读结论），entry.k2_frozen_at ≥ EFFECTIVE_FROM；
 *     封存日期在生效日及以后、却没写 k2_frozen_at → 拒绝（判断不了，失败即关）。
 *   读运行日志（entry.run_log，按 sha256 绑定，RESEARCH_RUN_LOG_V1）里本族（family_id = strategy_ref）的每一行：
 *     - 每行写 trial_id 与 cost_model_ref；trial_id 在试验台账里有本族、本 K2 的登记行，角色取登记行（K2 冻结前预登记），
 *       运行日志自己写了 role / rule_config_hash 的，必须与登记行一致；
 *     - cost_model_ref 的模型 id（「(」之前）是适配器声明过的成本模型 → 按适配器的 cost_breakdown 判（行里另写的拆分不算）；
 *       不是 → 这一行必须自带 cost_breakdown.components，按同一条规则判；两样都没有 → 拒绝；
 *     - 计成本 = 佣金（commission，没有时取 fees）与滑点（slippage）两项都写了、都不是 NOT_MODELLED*；ALWAYS_GROSS 里的模型一律算毛收益；
 *     - 只报、诊断、复现（GROSS_ALLOWED_ROLES）可以用毛收益模型；其余角色都是判定用的，必须计成本；本族至少一行判定用的运行。
 *   不过门的题：照原样导入，锁行不加字段。
 *
 * EFFECTIVE_FROM 是假设值（2026-11-17 00:00 CST 起冻结的 K2），等协调会话确认；只写在这一处。
 */
const ledger = require('../trial-ledger');

/** 生效时刻（假设值，待协调会话确认）：此刻及之后冻结的 K2 过门，此前已冻结的不追溯。 */
const EFFECTIVE_FROM = '2026-11-17T00:00:00+08:00';
const RUN_LOG_SCHEMA = 'RESEARCH_RUN_LOG_V1';
/** 可以用毛收益模型的角色（只报、诊断、复现）；试验台账的其余角色都按判定用处理。 */
const GROSS_ALLOWED_ROLES = Object.freeze(['REPORT_ONLY_VARIANT', 'DIAGNOSTIC_ARM', 'REPRO']);
/** 名字里就写明不计费用的模型：拆分怎么写都算毛收益。 */
const ALWAYS_GROSS = Object.freeze(['REPLAY_CORE_COSTS_NONE']);
const NOT_MODELLED = /^NOT_MODELLED/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/;
/** 声明成本模型的适配器（钉版 replay core 两个；平台内置的 A 股演示适配器不出研究结论，不在目录里）。 */
const ADAPTERS = Object.freeze([
  ['adapters/us-replay-core', () => require('../../adapters/us-replay-core')],
  ['adapters/crypto-replay-core', () => require('../../adapters/crypto-replay-core')],
]);

class CostGateError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new CostGateError(`COST_MODEL_${code}`, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isoAt = (v) => typeof v === 'string' && /[zZ]|[+-]\d{2}:\d{2}$/.test(v) && Number.isFinite(Date.parse(v));

/** 模型 id：适配器写成「ID(说明)」，取「(」之前。 */
const modelIdOf = (ref) => (typeof ref === 'string' ? ref.split('(')[0].trim() : '');

/** 一份成本拆分是否计成本：佣金（没有时取 fees）与滑点都写了、都不是 NOT_MODELLED*，且模型不在 ALWAYS_GROSS。 */
function classify(modelId, breakdown) {
  const c = (breakdown && isObj(breakdown.components)) ? breakdown.components : {};
  const parts = { commission: c.commission !== undefined ? c.commission : c.fees, slippage: c.slippage };
  const missing = Object.keys(parts).filter((k) => parts[k] === undefined || parts[k] === null || parts[k] === '');
  const notModelled = Object.keys(parts).filter((k) => typeof parts[k] === 'string' && NOT_MODELLED.test(parts[k]));
  const alwaysGross = ALWAYS_GROSS.includes(modelId);
  return { counts_costs: !alwaysGross && !missing.length && !notModelled.length, not_modelled: notModelled, missing, always_gross: alwaysGross };
}

/** 适配器声明的成本模型目录：manifest.cost_model_version 的 id 与 cost_breakdown() 的 model 必须一致。 */
function buildCatalogue() {
  const out = new Map();
  for (const [source, load] of ADAPTERS) {
    const adapter = load();
    const id = modelIdOf(adapter.manifest.cost_model_version);
    need(MODEL_ID.test(id) && typeof adapter.cost_breakdown === 'function', 'CATALOGUE_INVALID', source);
    const breakdown = adapter.cost_breakdown({});
    need(isObj(breakdown) && modelIdOf(breakdown.model) === id && !out.has(id), 'CATALOGUE_INVALID', `${source}:${id}`);
    out.set(id, Object.freeze({ model_id: id, source, declared: adapter.manifest.cost_model_version, ...classify(id, breakdown) }));
  }
  return out;
}
const CATALOGUE = buildCatalogue();

/** 这一题是否过门。effectiveFrom 默认取 EFFECTIVE_FROM，只在测试里另传。 */
function applies(entry, effectiveFrom = EFFECTIVE_FROM) {
  if (!entry.k2 || entry.kind === 'DRAFT') return { applies: false, reason: entry.k2 ? 'DRAFT_NOT_FROZEN' : 'NO_K2' };
  if (entry.kind !== 'RESULT') return { applies: false, reason: 'NOT_A_VERDICT' };
  need(isoAt(effectiveFrom), 'EFFECTIVE_FROM_INVALID', String(effectiveFrom));
  const eff = Date.parse(effectiveFrom);
  if (entry.k2_frozen_at !== undefined && entry.k2_frozen_at !== null) {
    need(isoAt(entry.k2_frozen_at), 'K2_FROZEN_AT_INVALID', `${entry.id}:${entry.k2_frozen_at}`);
    const after = Date.parse(entry.k2_frozen_at) >= eff;
    return { applies: after, reason: after ? 'FROZEN_AFTER_EFFECTIVE' : 'FROZEN_BEFORE_EFFECTIVE' };
  }
  const effDate = new Date(eff + 8 * 3600e3).toISOString().slice(0, 10); // 生效日（CST）
  need(!(typeof entry.sealed_on === 'string' && entry.sealed_on >= effDate), 'K2_FROZEN_AT_MISSING', entry.id);
  return { applies: false, reason: 'SEALED_BEFORE_EFFECTIVE' };
}

function parseRunLog(entry, bytes) {
  need(bytes, 'RUN_LOG_MISSING', entry.id);
  let doc;
  try { doc = JSON.parse(bytes.toString('utf8')); } catch { return fail('RUN_LOG_NOT_JSON', entry.id); }
  need(isObj(doc) && doc.schema === RUN_LOG_SCHEMA && Array.isArray(doc.runs), 'RUN_LOG_INVALID', entry.id);
  need(doc.k2_sha256 === entry.k2.sha256, 'RUN_LOG_K2_MISMATCH', entry.id);
  for (const r of doc.runs) need(isObj(r) && isText(r.family_id), 'RUN_LOG_ROW_INVALID', entry.id);
  return doc;
}

/** 一行运行：角色取台账登记行，成本模型按目录或行里的拆分判。 */
function checkRun(entry, run, i, regs) {
  const at = `${entry.id}:runs[${run.config_label || i}]`;
  need(ledger.TRIAL_ID.test(run.trial_id || ''), 'RUN_TRIAL_ID_MISSING', at);
  need(isText(run.cost_model_ref), 'REF_MISSING', `${at}:${run.trial_id}`);
  const reg = regs.find((r) => r.trial_id === run.trial_id);
  need(reg, 'TRIAL_NOT_REGISTERED', `${at}:${run.trial_id}`);
  need(run.role === undefined || run.role === reg.role, 'ROLE_MISMATCH', `${at}:${run.role}≠${reg.role}`);
  need(run.rule_config_hash === undefined || run.rule_config_hash === reg.rule_config_hash, 'RUN_TRIAL_MISMATCH', `${at}:rule_config_hash`);
  const id = modelIdOf(run.cost_model_ref);
  need(MODEL_ID.test(id), 'REF_INVALID', `${at}:${run.cost_model_ref}`);
  const verdictBearing = !GROSS_ALLOWED_ROLES.includes(reg.role);
  let model = CATALOGUE.get(id);
  if (!model) {
    const own = run.cost_breakdown;
    need(isObj(own) && isObj(own.components), 'UNKNOWN', `${at}:${id}`);
    need(own.model === undefined || modelIdOf(own.model) === id, 'BREAKDOWN_MODEL_MISMATCH', `${at}:${own.model}≠${id}`);
    model = { model_id: id, source: 'RUN_LOG_ROW', ...classify(id, own) };
  }
  if (verdictBearing) {
    need(model.always_gross || !model.missing.length, 'BREAKDOWN_INCOMPLETE', `${at}:${id}:${model.missing.join(',')}`);
    need(model.counts_costs, 'GROSS_VERDICT', `${at}:${reg.role}:${id}${model.not_modelled.length ? `:NOT_MODELLED=${model.not_modelled.join(',')}` : ''}`);
  }
  return { trial_id: run.trial_id, role: reg.role, model_id: id, source: model.source, counts_costs: model.counts_costs, verdict_bearing: verdictBearing };
}

/**
 * 导入器调用：原有校验与 G-TRIAL、G-MECH、G-CAUSAL 都通过之后。
 * @param {object} entry 登记表一题
 * @param {{runLogBytes: () => Buffer|null}} files 按 sha256 复验后的运行日志字节（只在过门时才读）
 * @param {{effectiveFrom?: string}} [opts] 只给测试用；导入器不传，取 EFFECTIVE_FROM
 */
function check(entry, { runLogBytes = () => null } = {}, { effectiveFrom = EFFECTIVE_FROM } = {}) {
  const scope = applies(entry, effectiveFrom);
  if (!scope.applies) return { applies: false, reason: scope.reason };
  const doc = parseRunLog(entry, runLogBytes());
  const regs = ledger.trialRows().filter((r) => r.row_kind === 'REGISTRATION' && r.family_id === entry.strategy_ref && r.k2_sha256 === entry.k2.sha256);
  const runs = doc.runs.filter((r) => r.family_id === entry.strategy_ref).map((r, i) => checkRun(entry, r, i, regs));
  const bearing = runs.filter((r) => r.verdict_bearing);
  need(bearing.length, 'NO_VERDICT_RUN', `${entry.id}:${entry.strategy_ref}`);
  const models = new Map();
  for (const r of runs) {
    const key = `${r.model_id}|${r.verdict_bearing}`;
    if (!models.has(key)) models.set(key, { model_id: r.model_id, source: r.source, counts_costs: r.counts_costs, verdict_bearing: r.verdict_bearing });
  }
  return { applies: true, state: 'PASS', effective_from: effectiveFrom, k2_frozen_at: entry.k2_frozen_at,
    verdict_runs: bearing.length, other_runs: runs.length - bearing.length, gross_other_runs: runs.filter((r) => !r.verdict_bearing && !r.counts_costs).length,
    cost_models: [...models.values()] };
}

module.exports = { EFFECTIVE_FROM, RUN_LOG_SCHEMA, GROSS_ALLOWED_ROLES, ALWAYS_GROSS, CATALOGUE, CostGateError, modelIdOf, classify, applies, check,
  internals: { parseRunLog, checkRun, buildCatalogue } };
