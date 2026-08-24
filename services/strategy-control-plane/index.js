'use strict';
/**
 * Strategy Control Plane(L6,§12)—— PromotionCandidate / Compatibility /
 * Immutable StrategyRelease / Founder Review / ActivationRecord / Rollback。
 * 迁移自 Ashare-V5 services/phase2/promotion_manager,按新设计重排发布流水线:
 *
 *   PromotionCandidate → Research Gates → Compatibility Check → Immutable StrategyRelease
 *     → Founder Review → ActivationRecord(PAPER)→ Runtime Pull + Verify Hash
 *     → Runtime ACK + Health → ACTIVE / ROLLBACK               (§12 流程图)
 *
 * 硬约束(§12/§18):
 *   - No Automatic Promotion:只有 Founder 明确批准后才可生成 Activation;
 *   - 「一键发布」= 对已通过全部 Gate 的不可变 Release 执行受控 Activation,不是复制代码;
 *   - MVP 只发布到 PAPER 环境;Live governance 另立决策(§25);
 *   - effective_from 必须是未来业务日(前向生效,不许追溯);
 *   - No Silent Migration:已有 Position 绑定原始 release;要变只产 REPLAN_REQUIRED;
 *   - Rollback 两类:OPERATIONAL 可直接切回 last-known-good;ECONOMIC 只触发
 *     Research Review,不按短期 PnL 自动回滚;
 *   - Fail Closed:数据缺失 / hash 不匹配 / capability 不兼容则不激活。
 */
const path = require('path');
const { dataDir, hash, now, uid, append, read } = require('../../packages/ledger');
const { MVP_ALLOWED_ENVIRONMENTS } = require('../../packages/contracts/runtime_contract');
const registry = require('../strategy-registry');
const experiments = require('../experiment-orchestrator');
const shadow = require('../shadow-control');
const { getAdapter } = require('../../adapters/registry');

const DIR = () => dataDir('control-plane');
const PROMOTIONS_LEDGER = () => path.join(DIR(), 'promotion_candidates.jsonl');
const RELEASES_LEDGER = () => path.join(DIR(), 'strategy_releases.jsonl');
const ACTIVATIONS_LEDGER = () => path.join(DIR(), 'activation_records.jsonl');

const ROLLBACK_TYPES = Object.freeze(['OPERATIONAL', 'ECONOMIC']);
const MIGRATION_POLICY = 'NEW_TRADEPLANS_ONLY_REPLAN_REQUIRED_FOR_EXISTING'; // 冻结,不接受覆盖

// ── PromotionCandidate(§8;Research Gates 在创建时硬校验) ────────────────────
async function createPromotionCandidate(c = {}) {
  for (const k of ['release_candidate_ref', 'market', 'experiment_ref', 'research_evidence_refs', 'shadow_forward_refs', 'rollback_ref']) {
    if (!c[k] || (Array.isArray(c[k]) && !c[k].length)) throw new Error(`PROMOTION_MISSING_FIELD:${k}`);
  }
  // Research Gate:实验必须 RESULT_LOCKED 且 verdict = CHALLENGER_WINS(输了/负结果不进发布)
  const exp = experiments.experimentHead(c.experiment_ref);
  if (!exp || exp.status !== 'RESULT_LOCKED') throw new Error(`PROMOTION_EXPERIMENT_NOT_LOCKED:${c.experiment_ref}`);
  if (exp.result.verdict !== 'CHALLENGER_WINS') throw new Error(`PROMOTION_VERDICT_NOT_WINNER:${exp.result.verdict}`);
  // Shadow Gate:影子前向样本必须达到该实验预注册的最低数(DESCRIBE_ONLY 不能作为升级证据)
  for (const sid of c.shadow_forward_refs) {
    const s = await shadow.sufficiency(sid);
    if (s.claim_status !== 'CLAIM_ELIGIBLE') throw new Error(`PROMOTION_SHADOW_INSUFFICIENT:${sid}:${s.forward_sample_count}/${s.min_required}`);
  }
  const rec = {
    schema: 'PROMOTION_CANDIDATE_V1',
    candidate_id: c.candidate_id || `PC-${hash(c)}`,
    market: c.market,
    release_candidate_ref: c.release_candidate_ref,   // bundle_id#vN
    experiment_ref: c.experiment_ref,
    research_evidence_refs: c.research_evidence_refs,
    shadow_forward_refs: c.shadow_forward_refs,
    compatibility_result: null,                        // Compatibility Check 后追加
    risk_impact: c.risk_impact || null,
    unresolved_gaps: c.unresolved_gaps || [],
    migration_policy: MIGRATION_POLICY,
    effective_from_candidate: c.effective_from_candidate || null,
    rollback_ref: c.rollback_ref,
    review_status: 'PENDING_COMPATIBILITY',
    createdAt: now(),
  };
  return append(PROMOTIONS_LEDGER(), rec);
}

function candidateHead(candidateId) {
  const rows = read(PROMOTIONS_LEDGER()).filter((r) => r.candidate_id === candidateId);
  return rows.length ? rows[rows.length - 1] : null;
}

/** Compatibility Check:构造 release 草案交 Market Adapter 校验(fail-closed)。 */
async function runCompatibilityCheck(candidateId) {
  const head = candidateHead(candidateId);
  if (!head) throw new Error('CANDIDATE_NOT_FOUND');
  if (head.review_status !== 'PENDING_COMPATIBILITY') throw new Error(`CANDIDATE_NOT_PENDING_COMPATIBILITY:${head.review_status}`);
  const adapter = getAdapter(head.market);
  const draft = _releaseDraft(head, adapter);
  const compat = await adapter.validate_release(draft);
  const rec = append(PROMOTIONS_LEDGER(), {
    ...head,
    compatibility_result: compat,
    review_status: compat.compatible ? 'PENDING_FOUNDER_REVIEW' : 'COMPATIBILITY_FAILED',
    compatibilityCheckedAt: now(),
  });
  return { candidate: rec, compatibility: compat };
}

function _bundleOf(ref) {
  const [bundleId, ver] = String(ref).split('#v');
  const bh = registry.bundleHead(bundleId, ver ? Number(ver) : null);
  if (!bh) throw new Error(`BUNDLE_NOT_FOUND:${ref}`);
  return bh;
}

function _releaseDraft(candidate, adapter) {
  const bundle = _bundleOf(candidate.release_candidate_ref);
  const exp = experiments.experimentHead(candidate.experiment_ref);
  return {
    schema: 'STRATEGY_RELEASE_V1',
    market: candidate.market,
    immutable_bundle_ref: `${bundle.bundle_id}#v${bundle.bundle_version}`,
    bundle_hash: bundle.bundle_hash,
    code_hash: hash({ modules: bundle.module_refs }),
    parameter_hash: hash({ execution_model: exp.execution_model }),
    adapter_version: adapter.manifest.adapter_version,
    universe_contract: { ...exp.universe, sample_instruments: [] },
    signal_contract: { changed_component: exp.changed_component, primary_metric: exp.primary_metric },
    risk_contract: { migration_policy: MIGRATION_POLICY },
    execution_contract: { mode: adapter.manifest.execution_model_version, environment_class: 'PAPER' },
    cost_model_ref: adapter.manifest.cost_model_version,
    target_runtime_class: 'PAPER',
  };
}

// ── Immutable StrategyRelease(§8) ─────────────────────────────────────────
function createRelease(candidateId) {
  const head = candidateHead(candidateId);
  if (!head) throw new Error('CANDIDATE_NOT_FOUND');
  if (!head.compatibility_result?.compatible) throw new Error('RELEASE_REQUIRES_COMPATIBILITY_PASS'); // fail-closed
  const adapter = getAdapter(head.market);
  const draft = _releaseDraft(head, adapter);
  const release = {
    ...draft,
    release_id: `REL-${hash({ c: candidateId, b: draft.bundle_hash })}`,
    candidate_ref: candidateId,
    created_at: now(),
  };
  release.release_hash = hash({ ...release, created_at: null }); // 内容哈希,创建时间不参与
  return append(RELEASES_LEDGER(), release);
}
function releaseHead(releaseId) {
  const rows = read(RELEASES_LEDGER()).filter((r) => r.release_id === releaseId);
  return rows.length ? rows[rows.length - 1] : null; // release 不可变:后行只允许附注,内容域不变
}

/**
 * Release 不可变性再校验:按内容重算 release_hash,与登记值比对。
 * 台账是 append-only,但"追加一行改内容"在物理上是可能的 —— 读取侧必须能自证,
 * 而不是只信 append-only 约定(§18 Immutable Release)。
 */
function verifyReleaseIntegrity(releaseId) {
  const r = releaseHead(releaseId);
  if (!r) return { ok: false, reason: 'RELEASE_NOT_FOUND' };
  // createRelease 计哈希时 release_hash 尚未写入 → 重算必须剔除该字段本身,并把 created_at 归零
  const expected = hash({
    ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'release_hash')),
    created_at: null,
  });
  return r.release_hash === expected
    ? { ok: true, release_hash: r.release_hash }
    : { ok: false, reason: 'RELEASE_CONTENT_TAMPERED', declared: r.release_hash, recomputed: expected };
}

// ── Founder Review(No Automatic Promotion;唯一批准人) ─────────────────────
function reviewCandidate(candidateId, decision, o = {}) {
  if (!['APPROVE_PAPER', 'REJECT'].includes(decision)) throw new Error(`BAD_REVIEW_DECISION:${decision}`);
  if (o.reviewer !== 'FOUNDER') throw new Error('REVIEW_REQUIRES_FOUNDER');
  const head = candidateHead(candidateId);
  if (!head) throw new Error('CANDIDATE_NOT_FOUND');
  if (head.review_status !== 'PENDING_FOUNDER_REVIEW') throw new Error(`CANDIDATE_NOT_PENDING:${head.review_status}`);
  return append(PROMOTIONS_LEDGER(), {
    ...head,
    review_status: decision === 'REJECT' ? 'REJECTED' : 'APPROVED_PAPER',
    review_decisionCn: o.decisionCn || null,
    reviewedBy: 'FOUNDER',
    reviewedByUserId: o.approvedByUserId || null,
    reviewedAt: now(),
  });
}

// ── ActivationRecord(§8;Pull-based,§12.2) ───────────────────────────────
/**
 * 生成待 Runtime 拉取的 Activation。此时状态 = PENDING_RUNTIME_PULL;
 * 平台**不** push Runtime;Runtime 经 runtime_binding 拉取、验 hash、回 ACK 后才 ACTIVE。
 */
async function requestActivation(releaseId, o = {}) {
  const release = releaseHead(releaseId);
  if (!release) throw new Error('RELEASE_NOT_FOUND');
  const cand = candidateHead(release.candidate_ref);
  if (!cand || cand.review_status !== 'APPROVED_PAPER') throw new Error(`ACTIVATION_REQUIRES_APPROVAL:${cand?.review_status}`);
  if (!o.target_runtime_id) throw new Error('ACTIVATION_MISSING_TARGET_RUNTIME');
  const environment = o.environment || 'PAPER';
  if (!MVP_ALLOWED_ENVIRONMENTS.includes(environment)) throw new Error(`ENVIRONMENT_NOT_ALLOWED_IN_MVP:${environment}`);
  if (!o.effective_from) throw new Error('ACTIVATION_MISSING_EFFECTIVE_FROM');
  const today = o.today || new Date().toISOString().slice(0, 10);
  if (!(o.effective_from > today)) throw new Error(`EFFECTIVE_FROM_MUST_BE_FUTURE:${o.effective_from}<=${today}`);
  // capability fail-closed:目标 runtime 必须声明支持该环境
  const caps = await getAdapter(release.market).runtime_capabilities();
  if (caps.runtime_id !== o.target_runtime_id) throw new Error(`RUNTIME_UNKNOWN:${o.target_runtime_id}`);
  if (!caps.environments_supported.includes(environment)) throw new Error(`RUNTIME_ENVIRONMENT_UNSUPPORTED:${environment}`);

  const rec = append(ACTIVATIONS_LEDGER(), {
    schema: 'ACTIVATION_RECORD_V1',
    activation_id: `ACT-${hash({ r: releaseId, t: uid() })}`,
    target_runtime_id: o.target_runtime_id,
    release_id: releaseId,
    release_hash: release.release_hash,
    market: release.market,
    environment,
    effective_from: o.effective_from,
    canary_scope: o.canary_scope || null,
    // 回滚锚:previous_release_ref 必须是**真实 Release id**(该 Runtime 当前 ACTIVE 的那个),
    // 否则 rollback 会拿着 bundle ref 当 release 用,切不回去(审计发现的缺陷)。
    // 首次激活时无前任 → null,回滚时显式报 NO_PREVIOUS_RELEASE_TO_RESTORE,不静默留空。
    previous_release_ref: activeReleaseIdFor(o.target_runtime_id),
    rollback_bundle_ref: cand.rollback_ref,   // 候选声明的 bundle 级锚点(审计用,不作切回目标)
    activation_kind: 'PROMOTION',
    approved_by: 'FOUNDER',
    approved_by_user_id: o.approvedByUserId || null,
    migration_policyCn: '已有 Position 绑定原始 release;要变只产 REPLAN_REQUIRED,不静默迁移',
    runtime_ack: null,
    activation_status: 'PENDING_RUNTIME_PULL',
    rollback_status: null,
    activatedAt: null,
    requestedAt: now(),
  });
  return rec;
}

function activationHead(activationId) {
  const rows = read(ACTIVATIONS_LEDGER()).filter((r) => r.activation_id === activationId);
  return rows.length ? rows[rows.length - 1] : null;
}

/** 某 Runtime 当前 ACTIVE 的 Release(= last-known-good;回滚锚点的唯一真相)。 */
function activeReleaseIdFor(runtimeId) {
  const heads = new Map();
  for (const r of read(ACTIVATIONS_LEDGER())) {
    if (r.schema === 'ACTIVATION_RECORD_V1' && r.target_runtime_id === runtimeId) heads.set(r.activation_id, r);
  }
  const active = [...heads.values()].filter((a) => a.activation_status === 'ACTIVE');
  return active.length ? active[active.length - 1].release_id : null;
}

// ── Rollback(§12.3 两类语义) ──────────────────────────────────────────────
/** 已为某 activation 登记过研究复核触发?(ECONOMIC 回滚的前置条件) */
function hasReviewTrigger(activationRef) {
  return read(ACTIVATIONS_LEDGER()).some(
    (r) => r.schema === 'ROLLBACK_REVIEW_TRIGGER_V1' && r.activation_ref === activationRef,
  );
}

/**
 * §12.3 Rollback —— 关键修复:回滚**不是只写一条台账**。
 * "切回 last-known-good release" 必须真的经 §12.2 pull 协议回到 Runtime:
 * 本函数为 previous_release_ref 生成一条 ROLLBACK_RESTORE Activation
 * (即刻生效、PENDING_RUNTIME_PULL),Runtime 拉取并验 hash + 健康检查后才真正恢复。
 * 无前任 Release 可切回时 fail-closed 报 NO_PREVIOUS_RELEASE_TO_RESTORE,
 * 绝不"回滚成功但 Runtime 无生效版本"(审计实测到的旧行为)。
 */
function rollback(o = {}) {
  if (!ROLLBACK_TYPES.includes(o.type)) throw new Error(`BAD_ROLLBACK_TYPE:${o.type}`);
  if (!o.activation_ref) throw new Error('ROLLBACK_MISSING_ACTIVATION_REF');
  const act = activationHead(o.activation_ref);
  if (!act) throw new Error('ACTIVATION_NOT_FOUND');

  if (o.type === 'ECONOMIC' && o.approved_by !== 'FOUNDER') {
    // 经济回滚不自动执行 —— 只登记 Research Review 触发,等 Founder 决定
    return append(ACTIVATIONS_LEDGER(), {
      schema: 'ROLLBACK_REVIEW_TRIGGER_V1',
      activation_ref: o.activation_ref, type: 'ECONOMIC', status: 'RESEARCH_REVIEW_TRIGGERED',
      reasonCn: o.reasonCn || null,
      noteCn: '经济回滚不按短期 PnL 自动执行;已触发研究复核,待 Founder 决定',
      triggeredAt: now(),
    });
  }
  // Founder 批准的 ECONOMIC 回滚必须**先**有研究复核记录(§12.3:经济回滚经 Research Review)
  if (o.type === 'ECONOMIC' && !hasReviewTrigger(o.activation_ref)) {
    throw new Error('ECONOMIC_ROLLBACK_REQUIRES_PRIOR_RESEARCH_REVIEW');
  }

  const restoredId = act.previous_release_ref;
  const restored = restoredId ? releaseHead(restoredId) : null;
  if (restoredId && !restored) throw new Error(`ROLLBACK_TARGET_NOT_A_RELEASE:${restoredId}`); // fail-closed

  const rollbackId = `RBK-${hash({ a: o.activation_ref, t: uid() })}`;
  const today = o.today || new Date().toISOString().slice(0, 10);

  // 切回目标存在 → 生成 ROLLBACK_RESTORE Activation,交 Runtime 拉取生效
  let restoreActivation = null;
  if (restored) {
    restoreActivation = append(ACTIVATIONS_LEDGER(), {
      schema: 'ACTIVATION_RECORD_V1',
      activation_id: `ACT-${hash({ r: restored.release_id, rb: rollbackId })}`,
      target_runtime_id: act.target_runtime_id,
      release_id: restored.release_id,
      release_hash: restored.release_hash,
      market: act.market,
      environment: act.environment,
      // 回滚是运行动作而非新经济变更:即刻生效(仍只影响其后新 TradePlan)
      effective_from: today,
      canary_scope: null,
      previous_release_ref: act.release_id,          // 从哪个版本切回来的
      rollback_bundle_ref: act.rollback_bundle_ref || null,
      activation_kind: 'ROLLBACK_RESTORE',
      rollback_ref: rollbackId,
      approved_by: o.type === 'OPERATIONAL' ? (o.approved_by || 'OPERATOR') : 'FOUNDER',
      approved_by_user_id: o.approvedByUserId || null,
      migration_policyCn: '恢复既有已批准 Release;既有持仓仍绑原始 release,不静默迁移',
      runtime_ack: null,
      activation_status: 'PENDING_RUNTIME_PULL',
      rollback_status: null,
      activatedAt: null,
      requestedAt: now(),
    });
  }

  const rec = append(ACTIVATIONS_LEDGER(), {
    schema: 'ROLLBACK_RECORD_V1',
    rollback_id: rollbackId,
    activation_ref: o.activation_ref,
    type: o.type,
    restored_release_ref: restoredId || null,
    restore_activation_ref: restoreActivation ? restoreActivation.activation_id : null,
    restore_status: restored ? 'PENDING_RUNTIME_PULL' : 'NO_PREVIOUS_RELEASE_TO_RESTORE',
    restore_statusCn: restored
      ? '已生成回滚恢复 Activation;Runtime 拉取并验 hash + 健康检查后才真正切回'
      : '该 Runtime 此前无生效 Release —— 只停用当前版本,无 last-known-good 可切回(需人工处置)',
    approved_by: o.type === 'OPERATIONAL' ? (o.approved_by || 'OPERATOR') : 'FOUNDER',
    approved_by_user_id: o.approvedByUserId || null,
    reasonCn: o.reasonCn || null,
    forward_onlyCn: '仅影响其后新 TradePlan;历史结果不重新归因',
    rolledBackAt: now(),
  });
  append(ACTIVATIONS_LEDGER(), { ...act, activation_status: 'ROLLED_BACK', rollback_status: rec.rollback_id });

  // 安全规则:绝不 retire 正要恢复的那个 release 对应 bundle
  const release = releaseHead(act.release_id);
  const restoredBundleRef = restored ? String(restored.immutable_bundle_ref) : null;
  if (release && String(release.immutable_bundle_ref) !== restoredBundleRef) {
    const bh = _bundleOf(release.immutable_bundle_ref);
    if (['ACTIVE', 'CANARY'].includes(bh.status)) {
      const t = registry.transitionBundle(bh.bundle_id, bh.bundle_version, 'RETIRED', { reason: `rollback:${rec.rollback_id}` });
      if (!t.ok) rec.registry_transition_error = t.reason;
    }
  }
  return rec;
}

function listCandidates() {
  const m = new Map();
  for (const r of read(PROMOTIONS_LEDGER())) if (r.candidate_id) m.set(r.candidate_id, r);
  return [...m.values()];
}
function listReleases() {
  const m = new Map();
  for (const r of read(RELEASES_LEDGER())) m.set(r.release_id, r);
  return [...m.values()];
}
function listActivations() { return read(ACTIVATIONS_LEDGER()); }

module.exports = {
  ROLLBACK_TYPES, MIGRATION_POLICY,
  createPromotionCandidate, candidateHead, runCompatibilityCheck,
  createRelease, releaseHead, verifyReleaseIntegrity, reviewCandidate,
  requestActivation, activationHead, activeReleaseIdFor, rollback, hasReviewTrigger,
  listCandidates, listReleases, listActivations,
  PROMOTIONS_LEDGER, RELEASES_LEDGER, ACTIVATIONS_LEDGER,
};
