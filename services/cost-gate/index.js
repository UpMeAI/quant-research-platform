'use strict';

/**
 * G-COST 成本门 —— 不计成本的回放不得作判定。研究框架修订 2026-11-12 附录 1 §2（A2）；合同 docs/contracts/COST_MODEL_GATE_V1.md。
 *
 * 起因：adapters/us-replay-core 声明 cost_model_version REPLAY_CORE_COSTS_NONE(CLOSE_MARK…)，成本拆分写明佣金、滑点 NOT_MODELLED，
 * 「收益是毛收益，不得按已计成本解读」；此前没有一道门挡住用这种回放判出的结论。
 *
 * 接进海外与 A 股封存结论导入器共用的 checkEntry（一处调用），在 G-TRIAL、G-MECH、G-CAUSAL 之后运行。
 * 门只会拒绝导入（失败即关，错误码 COST_MODEL_*），从不改写结论，也不会因此判「不做」；没有裁定放行的路径。
 *
 *   过门的题：kind = RESULT，entry.k2_frozen_at ≥ EFFECTIVE_FROM（附录 1 冻结页，../research-framework-amendment-20261112-addendum-1）；
 *     封存日期在生效日及以后、却没写 k2_frozen_at → 拒绝。冻结页还没有 sha256 时，过门的题一律拒绝（FREEZE_UNBOUND）。
 *   读运行日志（entry.run_log，RESEARCH_RUN_LOG_V1，按 sha256 绑定）里本族（family_id = strategy_ref）的每一行：
 *     - 每行写 trial_id 与 verdict_metric_kind；角色与阶段取试验台账里本族、本 K2 的预登记行，运行日志写了 role / stage / rule_config_hash 的必须一致；
 *     - 门内（§2.2）：角色 ∈ IN_SCOPE_ROLES 且阶段 ∈ IN_SCOPE_STAGES。门内的行读数必须是收益类（RETURN_KINDS），必须写 cost_model_ref，
 *       成本模型必须计成本：适配器目录里的模型按适配器的 cost_breakdown 判；目录外的模型按行里自报的 commission_bps / slippage_bps（数字），
 *       不低于该市场的下限（FLOORS，市场取登记行）；
 *     - 只看信号（§2.3）：角色 SIGNAL_TEST 或阶段 SIGNAL。读数只能是信号类（SIGNAL_KINDS），报收益类即拒绝（SIGNAL_RETURN_CLAIM）；不查成本；
 *     - 其余（只报、诊断、复现、零假设抽样、历史未计数）：不查成本，读数只能是收益类；
 *     - 一题本族一行都没有 → NO_RUNS；门内没有行：全是只看信号的 → SIGNAL_ONLY（通过），否则 → NO_VERDICT_RUN。
 *   不过门的题：照原样导入，锁行不加字段。
 */
const ledger = require('../trial-ledger');
const addendum = require('../research-framework-amendment-20261112-addendum-1');
const coverage = require('./coverage');

const { FREEZE, EFFECTIVE_FROM } = addendum;
const RUN_LOG_SCHEMA = 'RESEARCH_RUN_LOG_V1';
/** §2.2 门内：台账登记行的角色与阶段（冻结页写定，代码与它一致）。 */
const IN_SCOPE_ROLES = Object.freeze(['VERDICT_ARM', 'BASELINE', 'WFO_FOLD', 'STRESS']);
const IN_SCOPE_STAGES = Object.freeze(['BOOK', 'ABLATION', 'WFO', 'FORWARD']);
/** §2.3 只看信号：角色 SIGNAL_TEST，或阶段 SIGNAL。 */
const SIGNAL_ROLE = 'SIGNAL_TEST';
const SIGNAL_STAGE = 'SIGNAL';
/** 运行行的判定读数种类（verdict_metric_kind）。 */
const RETURN_KINDS = Object.freeze(['NET_RETURN_SERIES', 'NET_PNL_SERIES']);
const SIGNAL_KINDS = Object.freeze(['IC', 'RANK_IC', 'HIT_RATE', 'EVENT_STUDY']);
/** 名字里就写明不计费用的模型：拆分怎么写都算毛收益。 */
const ALWAYS_GROSS = Object.freeze(['REPLAY_CORE_COSTS_NONE']);
const NOT_MODELLED = /^NOT_MODELLED/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/;
/** 成本模型目录：声明成本拆分的适配器（钉版 replay core 两个；平台内置的 A 股演示适配器不出研究结论，不在目录里）。 */
const ADAPTERS = Object.freeze([
  ['adapters/us-replay-core', () => require('../../adapters/us-replay-core')],
  ['adapters/crypto-replay-core', () => require('../../adapters/crypto-replay-core')],
]);

/**
 * §2.4 目录外引擎自报成本的下限（单边 bps），按市场；每个数写来源文件与 sha256，只取现有权威配置，不新编。
 * total_bps_min（可选）：来源只给出佣金加滑点的合计时，按 commission_bps + slippage_bps 比。没有登记的市场 → NO_FLOOR。
 * 默认值经协调会话 11-16 认可，冻结时确认或改动，每项一行。
 */
const src = (repo, commit, file, sha256, field) => Object.freeze({ repo, commit, path: file, sha256, field });
const SF = ['smartflow', '4d9558e58aa4b94526879c8dcdb2a7ab4ff509d4'];
const V6 = ['ashare-v6', '513e00c190f30552f88e735e885f093126431121'];
const FLOORS = Object.freeze({
  CRYPTO: Object.freeze({ commission_bps_min: 2, slippage_bps_min: 2, total_bps_min: null,
    sources: Object.freeze({
      commission: src(...SF, 'trading-system-v2/agent/v5-agent-config.js', 'd946052870ea26a69cf12320f85edc1ed63e4a081677f79cbeb86aaa5c000b6d',
        'MAKER_FEE_PCT 0.0002（目录模型最便宜的一档；更严的备选：TAKER_FEE_PCT 0.0004 = 4 bps）'),
      slippage: src(...SF, 'trading-system-v2/scripts/lib/replay-core-adapters/c17.js', '45e9ce0e9278ffc9e608b038d48f392796784ee1025da9938e16100117e9cc4b',
        'costs.slipTiers 最低一档 0.0002（2/4/6 bps 加场景 extraSlip）'),
    }) }),
  US: Object.freeze({ commission_bps_min: 0, slippage_bps_min: 0, total_bps_min: 5,
    sources: Object.freeze({
      total: src('quant-research-platform', '4e7bab82e4c548fb92cd58ebd1660efda1be64a7', 'docs/evidence/CYCLE_RESEARCH_DESK_US_V5_M1_NATIVE_DIAGNOSTIC_2026-10-24.json',
        '8429553ddb2f4f9d9e441b23aa1852a310bbcada691ab08eb60fe513a81acf1d', 'cost_model US_V5_M1_RESEARCH_COST_V1：strategy_bps_each_side 5（合计，不拆佣金与滑点）；commission_usd 0'),
    }) }),
  CN_A: Object.freeze({ commission_bps_min: 2.5, slippage_bps_min: 10, total_bps_min: null,
    sources: Object.freeze({
      commission: src(...V6, 'config/v6/research/index_sleeve_v5.json', 'aa4a430c52ea22b5044a3f03e701145c484dbae554be8fac15b131e9760becb6',
        'payload.paperExecution.cost.commissionBps 2.5（两本研究模拟簿里较低的一本；个股簿 stock_book_paper_v4 c65f5b95… 为 2.6；印花税不计入下限）'),
      slippage: src(...V6, 'config/v6/research/index_sleeve_v5.json', 'aa4a430c52ea22b5044a3f03e701145c484dbae554be8fac15b131e9760becb6',
        'payload.paperExecution.cost.slippageBps 10（个股簿 stock_book_paper_v4 同为 10）'),
    }) }),
});
/** 台账登记行的 market → 下限市场。 */
const FLOOR_MARKET = Object.freeze([[/^CRYPTO(_|$)/, 'CRYPTO'], [/^US(_|$)/, 'US'], [/^(CN|CN_A|CN_A_[A-Z0-9_]+)$/, 'CN_A']]);
const floorMarketOf = (market) => { const hit = typeof market === 'string' ? FLOOR_MARKET.find(([re]) => re.test(market)) : null; return hit ? hit[1] : null; };

class CostGateError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new CostGateError(`COST_MODEL_${code}`, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isoAt = (v) => typeof v === 'string' && /[zZ]|[+-]\d{2}:\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
const isBps = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// 门内与只看信号的角色、阶段都必须是试验台账认得的（台账改名时失败即关）
for (const r of [...IN_SCOPE_ROLES, SIGNAL_ROLE]) need(ledger.ROLES.includes(r), 'CATALOGUE_INVALID', `role:${r}`);
for (const s of [...IN_SCOPE_STAGES, SIGNAL_STAGE]) need(ledger.STAGES.includes(s), 'CATALOGUE_INVALID', `stage:${s}`);

/** 模型 id：适配器写成「ID(说明)」，取「(」之前。 */
const modelIdOf = (ref) => (typeof ref === 'string' ? ref.split('(')[0].trim() : '');

/** 适配器声明的拆分是否计成本：佣金（没有时取 fees）与滑点都写了、都不是 NOT_MODELLED*，且模型不在 ALWAYS_GROSS。 */
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

/** 门的默认读法（导入器只有一处调用、不带选项）；只在测试里经 internals.setDefaults 临时替换。 */
let DEFAULTS = Object.freeze({ effectiveFrom: EFFECTIVE_FROM, freeze: FREEZE, coverageFrom: coverage.COVERAGE_EFFECTIVE_FROM });

/** ★C4 覆盖面检查是否适用：K2 冻结在 coverageFrom（合同冻结时刻）及以后；更早的 K2 保留各自写明的成本，不读本检查。 */
const coverageApplies = (entry, coverageFrom = DEFAULTS.coverageFrom) => typeof entry.k2_frozen_at === 'string' && Date.parse(entry.k2_frozen_at) >= Date.parse(coverageFrom);

/** 这一题是否过门（只看题本身，不看冻结页是否已绑定）。 */
function applies(entry, effectiveFrom = DEFAULTS.effectiveFrom) {
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

/** 目录外的模型：行里自报单边 commission_bps / slippage_bps（数字），不低于登记行所在市场的下限。 */
function selfDeclared(at, run, id, reg) {
  const own = run.cost_breakdown;
  need(isObj(own), 'UNKNOWN', `${at}:${id}`);
  need(own.model === undefined || modelIdOf(own.model) === id, 'BREAKDOWN_MODEL_MISMATCH', `${at}:${own.model}≠${id}`);
  need(isBps(own.commission_bps) && isBps(own.slippage_bps), 'BREAKDOWN_NOT_NUMERIC', `${at}:${id}:commission_bps=${own.commission_bps},slippage_bps=${own.slippage_bps}`);
  const market = floorMarketOf(reg.market);
  const floor = market && FLOORS[market];
  need(floor, 'NO_FLOOR', `${at}:${id}:market=${reg.market}`);
  need(own.commission_bps >= floor.commission_bps_min, 'BELOW_FLOOR', `${at}:${id}:commission_bps ${own.commission_bps} < ${floor.commission_bps_min}（${market}）`);
  need(own.slippage_bps >= floor.slippage_bps_min, 'BELOW_FLOOR', `${at}:${id}:slippage_bps ${own.slippage_bps} < ${floor.slippage_bps_min}（${market}）`);
  if (floor.total_bps_min !== null) {
    need(own.commission_bps + own.slippage_bps >= floor.total_bps_min, 'BELOW_FLOOR', `${at}:${id}:commission_bps + slippage_bps ${own.commission_bps + own.slippage_bps} < ${floor.total_bps_min}（${market}）`);
  }
  return { model_id: id, source: 'RUN_LOG_ROW', floor_market: market, commission_bps: own.commission_bps, slippage_bps: own.slippage_bps };
}

/** 本族、本 K2 的预登记行（角色、阶段、市场都从这里读）。 */
const registrations = (entry) => ledger.trialRows().filter((r) => r.row_kind === 'REGISTRATION' && r.family_id === entry.strategy_ref && r.k2_sha256 === entry.k2.sha256);
/** 一行运行对应的预登记行；运行行自己写的 role / stage / rule_config_hash 必须与它一致。 */
function registrationOf(at, run, regs) {
  need(ledger.TRIAL_ID.test(run.trial_id || ''), 'RUN_TRIAL_ID_MISSING', at);
  const reg = regs.find((r) => r.trial_id === run.trial_id);
  need(reg, 'TRIAL_NOT_REGISTERED', `${at}:${run.trial_id}`);
  need(run.role === undefined || run.role === reg.role, 'ROLE_MISMATCH', `${at}:role ${run.role}≠${reg.role}`);
  need(run.stage === undefined || run.stage === reg.stage, 'ROLE_MISMATCH', `${at}:stage ${run.stage}≠${reg.stage}`);
  need(run.rule_config_hash === undefined || run.rule_config_hash === reg.rule_config_hash, 'RUN_TRIAL_MISMATCH', `${at}:rule_config_hash`);
  return reg;
}
/** §2.2、§2.3：登记行 → COST_GATED（门内）/ SIGNAL_ONLY（只看信号）/ OUT_OF_SCOPE。 */
const scopeOf = (reg) => (reg.role === SIGNAL_ROLE || reg.stage === SIGNAL_STAGE ? 'SIGNAL_ONLY'
  : IN_SCOPE_ROLES.includes(reg.role) && IN_SCOPE_STAGES.includes(reg.stage) ? 'COST_GATED' : 'OUT_OF_SCOPE');
const familyRuns = (entry, doc) => doc.runs.filter((r) => r.family_id === entry.strategy_ref);
const atOf = (entry, run, i) => `${entry.id}:runs[${run.config_label || i}]`;

/** 一行运行：角色与阶段取台账登记行，按门内 / 只看信号 / 其余判读数种类与成本。 */
function checkRun(entry, run, i, regs, coverageOn = false) {
  const at = atOf(entry, run, i);
  const reg = registrationOf(at, run, regs);
  const kind = run.verdict_metric_kind;
  need(RETURN_KINDS.includes(kind) || SIGNAL_KINDS.includes(kind), 'METRIC_KIND_INVALID', `${at}:${kind}`);
  const scope = scopeOf(reg);
  const signalOnly = scope === 'SIGNAL_ONLY';
  const row = { trial_id: run.trial_id, role: reg.role, stage: reg.stage, scope, verdict_metric_kind: kind };
  if (signalOnly) {
    need(SIGNAL_KINDS.includes(kind), 'SIGNAL_RETURN_CLAIM', `${at}:${reg.role}/${reg.stage}:${kind}`);
    return row;
  }
  need(RETURN_KINDS.includes(kind), 'METRIC_KIND_MISMATCH', `${at}:${reg.role}/${reg.stage}:${kind}`);
  if (scope !== 'COST_GATED') return row;
  need(isText(run.cost_model_ref), 'REF_MISSING', `${at}:${run.trial_id}`);
  const out = { ...row, model: assessCostModel(run, reg.market, { at, label: reg.role }) };
  if (!coverageOn) return out;
  // ★C4：佣金与滑点下限照旧（上一行）；其余成本项按登记文件收齐，缺一项即 NET_PARTIAL
  const market = floorMarketOf(reg.market);
  need(market, 'COVERAGE_NO_MARKET', `${at}:market=${reg.market}`);
  const own = isObj(run.cost_breakdown) ? run.cost_breakdown : {};
  return { ...out, coverage: coverage.requireComplete({ items: own.items, books: run.cost_book, flags: run.cost_flags }, market, at) };
}

/**
 * 一个成本模型是否计成本（门内的行与 RF1116 §4.3 赛马共用，不另写）：目录里的模型按适配器的拆分判（不计成本 → GROSS_VERDICT），
 * 目录外的按自报单边 commission_bps / slippage_bps 与 market 的下限判（§2.4）。market 是台账或榜的市场（floorMarketOf 归类）。
 * @param {{cost_model_ref: string, cost_breakdown?: object}} source
 */
function assessCostModel(source, market, { at = 'cost_model', label = null } = {}) {
  need(isObj(source) && isText(source.cost_model_ref), 'REF_MISSING', at);
  const id = modelIdOf(source.cost_model_ref);
  need(MODEL_ID.test(id), 'REF_INVALID', `${at}:${source.cost_model_ref}`);
  const known = CATALOGUE.get(id);
  if (known) {
    const why = [...(known.not_modelled.length ? [`NOT_MODELLED=${known.not_modelled.join(',')}`] : []), ...(known.missing.length ? [`MISSING=${known.missing.join(',')}`] : [])];
    need(known.counts_costs, 'GROSS_VERDICT', `${at}:${label ? `${label}:` : ''}${id}${why.length ? `:${why.join(':')}` : ''}`);
    return { model_id: id, source: known.source };
  }
  return selfDeclared(at, source, id, { market });
}

/**
 * 导入器调用：原有校验与 G-TRIAL、G-MECH、G-CAUSAL 都通过之后。
 * @param {object} entry 登记表一题
 * @param {{runLogBytes: () => Buffer|null}} files 按 sha256 复验后的运行日志字节（只在过门时才读）
 * @param {{effectiveFrom?: string, freeze?: object}} [opts] 只给测试用；导入器不传，取附录 1 冻结页的常量
 */
function check(entry, { runLogBytes = () => null } = {}, { effectiveFrom = DEFAULTS.effectiveFrom, freeze = DEFAULTS.freeze, coverageFrom = DEFAULTS.coverageFrom } = {}) {
  const scope = applies(entry, effectiveFrom);
  if (!scope.applies) return { applies: false, reason: scope.reason };
  need(addendum.isBound(freeze), 'FREEZE_UNBOUND', `${entry.id}:${freeze && freeze.path}:${freeze && freeze.state}`);
  const doc = parseRunLog(entry, runLogBytes());
  const regs = registrations(entry);
  const family = familyRuns(entry, doc);
  need(family.length, 'NO_RUNS', `${entry.id}:${entry.strategy_ref}`);
  const coverageOn = coverageApplies(entry, coverageFrom);
  const rows = family.map((r, i) => checkRun(entry, r, i, regs, coverageOn));
  const gated = rows.filter((r) => r.scope === 'COST_GATED');
  const signal = rows.filter((r) => r.scope === 'SIGNAL_ONLY');
  if (!gated.length) need(signal.length === rows.length, 'NO_VERDICT_RUN', `${entry.id}:${entry.strategy_ref}`);
  const models = new Map();
  for (const r of gated) if (!models.has(r.model.model_id)) models.set(r.model.model_id, r.model);
  return { applies: true, state: gated.length ? 'PASS' : 'SIGNAL_ONLY', effective_from: effectiveFrom, k2_frozen_at: entry.k2_frozen_at,
    freeze: { path: freeze.path, sha256: freeze.sha256, state: freeze.state },
    cost_gated_runs: gated.length, signal_only_runs: signal.length, other_runs: rows.length - gated.length - signal.length, cost_models: [...models.values()],
    ...(coverageOn ? { cost_coverage: coverageBlock(gated, coverageFrom) } : {}) };
}

/** 覆盖面检查的锁块：钉住登记文件与合同的 sha256（过门的行都已 COMPLETE，否则上面已拒绝）。只在 K2 冻结于生效时刻之后才有。 */
function coverageBlock(gated, coverageFrom) {
  const registry = coverage.loadRegistry();
  const unknown = new Set();
  for (const r of gated) for (const k of (r.coverage ? r.coverage.registry_unknown_items : [])) unknown.add(k);
  return { registry_sha256: registry.sha256, registry_revision: registry.registryRevision, contract_sha256: coverage.CONTRACT_SHA256, effective_from: coverageFrom,
    checked_runs: gated.length, registry_unknown_items: [...unknown].sort() };
}

/**
 * A1（附录 1 §1.1，因果门的成交函数）读的范围：同一套过门判断与行分类（不另写），只回答「这一题是否在 G-COST 范围内、门内有几行、冻结页是否已绑定」。
 * 不判成本、不判读数种类（那些留给 check）；不在范围内时不读运行日志。
 */
function costGatedScope(entry, runLogBytes = () => null, { effectiveFrom = DEFAULTS.effectiveFrom, freeze = DEFAULTS.freeze } = {}) {
  const scope = applies(entry, effectiveFrom);
  if (!scope.applies) return { applies: false, reason: scope.reason };
  const doc = parseRunLog(entry, runLogBytes());
  const regs = registrations(entry);
  const rows = familyRuns(entry, doc).map((run, i) => ({ trial_id: run.trial_id, scope: scopeOf(registrationOf(atOf(entry, run, i), run, regs)) }));
  return { applies: true, effective_from: effectiveFrom, freeze: { path: freeze && freeze.path, sha256: freeze && freeze.sha256, state: freeze && freeze.state },
    freeze_bound: addendum.isBound(freeze), cost_gated_runs: rows.filter((r) => r.scope === 'COST_GATED').length, rows: rows.length };
}

/** 测试用：临时替换门的默认读法（导入器那处调用不带选项），返回还原函数。 */
function setDefaults(patch) {
  const prior = DEFAULTS;
  DEFAULTS = Object.freeze({ ...prior, ...patch });
  return () => { DEFAULTS = prior; };
}
function withDefaults(patch, fn) {
  const restore = setDefaults(patch);
  try { return fn(); } finally { restore(); }
}

module.exports = {
  FREEZE, EFFECTIVE_FROM, COVERAGE_EFFECTIVE_FROM: coverage.COVERAGE_EFFECTIVE_FROM, coverage, RUN_LOG_SCHEMA, IN_SCOPE_ROLES, IN_SCOPE_STAGES, SIGNAL_ROLE, SIGNAL_STAGE, RETURN_KINDS, SIGNAL_KINDS, ALWAYS_GROSS, CATALOGUE, FLOORS,
  CostGateError, modelIdOf, classify, floorMarketOf, applies, check, costGatedScope, assessCostModel,
  internals: { parseRunLog, checkRun, scopeOf, buildCatalogue, setDefaults, withDefaults },
};
