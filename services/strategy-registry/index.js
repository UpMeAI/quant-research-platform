'use strict';
/**
 * Strategy Registry(L0 / §8)—— StrategyFamily / StrategyModuleVersion / StrategyBundleManifest。
 * 迁移自 Ashare-V5 services/phase2/strategy_registry,按新设计泛化 market 维度并采用 6 态 Bundle 状态。
 *
 * 铁律(§18):
 *   - 台账 append-only;版本/哈希冻结后不可改,改动 = 新版本;
 *   - Bundle 进 ACTIVE 只能由 Control Plane Activation 携带 activationRef(No Automatic Promotion);
 *   - Champion 注册是**记录现状**(引用运行中 Bundle 的真实版本与哈希),不是经济变更(§16.1)。
 */
const path = require('path');
const { dataDir, hash, now, append, read, heads } = require('../../packages/ledger');
const {
  MODULE_TYPES, MODULE_LIFECYCLE, MODULE_TRANSITIONS,
  BUNDLE_STATUSES, BUNDLE_TRANSITIONS, checkTransition,
} = require('../../packages/domain-model');
const { hasAdapter } = require('../../adapters/registry');

const DIR = () => dataDir('registry');
const FAMILIES_LEDGER = () => path.join(DIR(), 'strategy_families.jsonl');
const MODULES_LEDGER = () => path.join(DIR(), 'strategy_modules.jsonl');
const BUNDLES_LEDGER = () => path.join(DIR(), 'strategy_bundles.jsonl');

// ── StrategyFamily(§8) ────────────────────────────────────────────────────
function registerFamily(f = {}) {
  for (const k of ['family_id', 'market_scope', 'economic_mechanism', 'strategy_goal']) {
    if (!f[k]) throw new Error(`FAMILY_MISSING_FIELD:${k}`);
  }
  for (const m of [].concat(f.market_scope)) {
    if (!hasAdapter(m)) throw new Error(`FAMILY_MARKET_NOT_REGISTERED:${m}`);
  }
  return append(FAMILIES_LEDGER(), {
    schema: 'STRATEGY_FAMILY_V1',
    family_id: f.family_id,
    market_scope: [].concat(f.market_scope),
    economic_mechanism: f.economic_mechanism,
    strategy_goal: f.strategy_goal,
    owner: f.owner || 'FOUNDER',
    lifecycle_status: f.lifecycle_status || 'RESEARCH',
    capacity_profile: f.capacity_profile || null,
    supported_regimes: f.supported_regimes || null,
    registeredAt: now(),
  });
}
/**
 * Family 的 active/retired 版本(§8 StrategyFamily.active_versions / retired_versions):
 * 由 Bundle 台账**派生**,不另存一份可漂移的冗余状态(单一真相)。
 */
function familyVersions(familyId) {
  const moduleIds = new Set(listModules().filter((m) => m.family_id === familyId).map((m) => m.module_id));
  const owned = listBundles().filter((b) => (b.module_refs || []).some((ref) => moduleIds.has(String(ref).split('#v')[0])));
  const refOf = (b) => `${b.bundle_id}#v${b.bundle_version}`;
  return {
    active_versions: owned.filter((b) => b.status === 'ACTIVE').map(refOf),
    retired_versions: owned.filter((b) => b.status === 'RETIRED').map(refOf),
    in_research_versions: owned.filter((b) => ['RESEARCH', 'CHALLENGER', 'SHADOW', 'CANARY'].includes(b.status)).map(refOf),
  };
}
function familyHead(familyId) {
  const rows = read(FAMILIES_LEDGER()).filter((r) => r.family_id === familyId);
  if (!rows.length) return null;
  return { ...rows[rows.length - 1], ...familyVersions(familyId) };
}
function listFamilies() {
  return [...heads(read(FAMILIES_LEDGER()), 'family_id').values()]
    .map((f) => ({ ...f, ...familyVersions(f.family_id) }));
}

// ── StrategyModuleVersion(§8;内容哈希冻结,再登记 = 新版本) ────────────────
function registerModule(m = {}) {
  if (!m.module_id) return { ok: false, reason: 'MODULE_ID_REQUIRED' };
  if (!MODULE_TYPES.includes(m.module_type)) return { ok: false, reason: 'MODULE_TYPE_INVALID', allowed: MODULE_TYPES };
  if (!m.code_ref) return { ok: false, reason: 'CODE_REF_REQUIRED' };
  if (!m.market) return { ok: false, reason: 'MARKET_REQUIRED' };
  if (!hasAdapter(m.market)) return { ok: false, reason: `MARKET_NOT_REGISTERED:${m.market}` };
  // 同 Bundle:新模块版本只能以 DRAFT/PREREGISTERED 入册,ACTIVE 等下游态必须走状态机
  if (m.status && !['DRAFT', 'PREREGISTERED'].includes(m.status)) {
    return {
      ok: false,
      reason: `ILLEGAL_INITIAL_MODULE_STATUS:${m.status}`,
      reasonCn: '新模块版本只能以 DRAFT/PREREGISTERED 注册;演进阶梯必须逐级 transitionModule(ACTIVE 需 activationRef)',
      allowed_initial: ['DRAFT', 'PREREGISTERED'],
    };
  }
  const rows = read(MODULES_LEDGER()).filter((r) => r.module_id === m.module_id);
  const version = rows.length ? Math.max(...rows.map((r) => r.version)) + 1 : 1;
  const content = {
    module_id: m.module_id, family_id: m.family_id || null, market: m.market, module_type: m.module_type,
    code_ref: m.code_ref, parameters: m.parameters || null,
    input_contract: m.input_contract || null, output_contract: m.output_contract || null,
    universe_ref: m.universe_ref || null, holding_period: m.holding_period || null,
    supported_regimes: m.supported_regimes || null, failure_conditions: m.failure_conditions || null,
    data_requirements: m.data_requirements || null, cost_assumptions: m.cost_assumptions || null,
  };
  const rec = {
    schema: 'STRATEGY_MODULE_VERSION_V1',
    ...content, version,
    code_hash: m.code_hash || hash({ code_ref: m.code_ref }),
    parameter_hash: hash(m.parameters || null),
    hash: hash(content),
    status: m.status && MODULE_LIFECYCLE.includes(m.status) ? m.status : 'DRAFT',
    test_evidence: m.test_evidence || null,
    registeredAt: now(), registeredBy: m.registeredBy || 'RESEARCH_PLATFORM',
  };
  append(MODULES_LEDGER(), rec);
  return { ok: true, record: rec };
}
function moduleHead(moduleId, version = null) {
  const rows = read(MODULES_LEDGER()).filter((r) => r.module_id === moduleId && (version == null || r.version === version));
  return rows.length ? rows[rows.length - 1] : null;
}
function transitionModule(moduleId, version, toState, o = {}) {
  const head = moduleHead(moduleId, version);
  if (!head) return { ok: false, reason: 'MODULE_NOT_FOUND' };
  if (!MODULE_LIFECYCLE.includes(toState)) return { ok: false, reason: 'STATE_INVALID' };
  const chk = checkTransition(MODULE_TRANSITIONS, head.status, toState, o);
  if (!chk.ok) return chk;
  const rec = {
    ...head, status: toState,
    transitionReason: o.reason || null, evidenceRefs: o.evidenceRefs || null,
    activationRef: o.activationRef || head.activationRef || null,
    transitionedAt: now(), transitionedBy: o.by || 'RESEARCH_PLATFORM',
  };
  append(MODULES_LEDGER(), rec);
  return { ok: true, record: rec };
}
function listModules() {
  const m = new Map();
  for (const r of read(MODULES_LEDGER())) m.set(`${r.module_id}#v${r.version}`, r);
  return [...m.values()];
}

// ── StrategyBundleManifest(§8;6 态) ──────────────────────────────────────
/**
 * 新 Bundle 的**合法初始状态**只有 RESEARCH(§12:进 ACTIVE 唯一入口是 Control Plane Activation)。
 * 审计发现:checkTransition 的 ACTIVE_REQUIRES_ACTIVATION_RECORD 只守迁移不守注册,
 * 于是 registerBundle({status:'ACTIVE'}) 能凭空造出生效版本,绕开 Race/Shadow/Founder/Release 全链。
 * 唯一例外是 §16.1 Champion 导入(记录 Runtime 现状,非经济变更),
 * 必须走 registerChampionBundle 并携带 championImport 内部标记 —— 外部调用方拿不到。
 */
const CHAMPION_IMPORT = Symbol('CHAMPION_IMPORT_EXISTING_RUNTIME_STATE');
const LEGAL_INITIAL_STATUS = 'RESEARCH';

function registerBundle(b = {}) {
  if (!b.bundle_id) return { ok: false, reason: 'BUNDLE_ID_REQUIRED' };
  if (!b.market) return { ok: false, reason: 'MARKET_REQUIRED' };
  if (!hasAdapter(b.market)) return { ok: false, reason: `MARKET_NOT_REGISTERED:${b.market}` };
  if (!Array.isArray(b.module_refs) || !b.module_refs.length) return { ok: false, reason: 'MODULE_REFS_REQUIRED' };
  const isChampionImport = b[CHAMPION_IMPORT] === true;
  if (b.status && b.status !== LEGAL_INITIAL_STATUS && !isChampionImport) {
    return {
      ok: false,
      reason: `ILLEGAL_INITIAL_BUNDLE_STATUS:${b.status}`,
      reasonCn: `新 Bundle 只能以 ${LEGAL_INITIAL_STATUS} 注册;进入 ${b.status} 必须走状态机(ACTIVE 更须由 Activation 携 activationRef 驱动,§12/§18)`,
      allowed_initial: [LEGAL_INITIAL_STATUS],
    };
  }
  const rows = read(BUNDLES_LEDGER()).filter((r) => r.bundle_id === b.bundle_id);
  const version = rows.length ? Math.max(...rows.map((r) => r.bundle_version)) + 1 : 1;
  const composition = { market: b.market, module_refs: b.module_refs, market_adapter_version: b.market_adapter_version || null, risk_constitution_ref: b.risk_constitution_ref || null };
  const rec = {
    schema: 'STRATEGY_BUNDLE_MANIFEST_V1',
    bundle_id: b.bundle_id, bundle_version: version, bundle_hash: hash(composition),
    ...composition,
    status: b.status && BUNDLE_STATUSES.includes(b.status) ? b.status : 'RESEARCH',
    activationRef: isChampionImport ? 'CHAMPION_IMPORT_EXISTING_RUNTIME_STATE' : null,
    effective_from: b.effective_from || null,
    rollback_bundle_ref: b.rollback_bundle_ref || null,
    approved_by: b.approved_by || null,
    noteCn: b.noteCn || null,
    registeredAt: now(), registeredBy: b.registeredBy || 'RESEARCH_PLATFORM',
  };
  append(BUNDLES_LEDGER(), rec);
  return { ok: true, record: rec };
}
function bundleHead(bundleId, version = null) {
  const rows = read(BUNDLES_LEDGER()).filter((r) => r.bundle_id === bundleId && (version == null || r.bundle_version === version));
  return rows.length ? rows[rows.length - 1] : null;
}
function transitionBundle(bundleId, version, toState, o = {}) {
  const head = bundleHead(bundleId, version);
  if (!head) return { ok: false, reason: 'BUNDLE_NOT_FOUND' };
  if (!BUNDLE_STATUSES.includes(toState)) return { ok: false, reason: 'STATE_INVALID' };
  const chk = checkTransition(BUNDLE_TRANSITIONS, head.status, toState, o);
  if (!chk.ok) return chk;
  const rec = {
    ...head, status: toState,
    effective_from: o.effective_from || head.effective_from,
    approved_by: o.approved_by || head.approved_by,
    rollback_bundle_ref: o.rollback_bundle_ref || head.rollback_bundle_ref,
    activationRef: o.activationRef || head.activationRef || null,
    transitionReason: o.reason || null,
    transitionedAt: now(), transitionedBy: o.by || 'RESEARCH_PLATFORM',
  };
  append(BUNDLES_LEDGER(), rec);
  return { ok: true, record: rec };
}
function listBundles() { return [...heads(read(BUNDLES_LEDGER()), 'bundle_id').values()]; }

/**
 * Champion 注册(§16.1):把某市场 Runtime 当前 Active Bundle 以 bundle_id/version/hash
 * 形式登记为 Champion(status=ACTIVE,记录现状,非经济变更)。幂等:已登记则返回现有。
 * activationRef 用固定语义值标注「导入现状」,与 Control Plane 新激活区分。
 */
function registerChampionBundle({ market, bundle_id, module_refs, market_adapter_version, noteCn } = {}) {
  const existing = bundleHead(bundle_id);
  if (existing && existing.status === 'ACTIVE') return { ok: true, unchanged: true, record: existing };
  return registerBundle({
    bundle_id, market, module_refs, market_adapter_version,
    status: 'ACTIVE',
    approved_by: 'FOUNDER',
    noteCn: noteCn || 'Champion 注册 = 记录 Runtime 现状(非经济变更);此后全部 Race 以其为对照组',
    registeredBy: 'CHAMPION_IMPORT',
    [CHAMPION_IMPORT]: true,   // §16.1 唯一豁免:导入现状,不是新发布
  });
}

module.exports = {
  registerFamily, familyHead, listFamilies, familyVersions,
  registerModule, moduleHead, transitionModule, listModules,
  registerBundle, bundleHead, transitionBundle, listBundles,
  registerChampionBundle,
  FAMILIES_LEDGER, MODULES_LEDGER, BUNDLES_LEDGER,
};
