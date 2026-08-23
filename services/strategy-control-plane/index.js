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
function createPromotionCandidate(c = {}) {
  for (const k of ['release_candidate_ref', 'market', 'experiment_ref', 'research_evidence_refs', 'shadow_forward_refs', 'rollback_ref']) {
    if (!c[k] || (Array.isArray(c[k]) && !c[k].length)) throw new Error(`PROMOTION_MISSING_FIELD:${k}`);
  }
  // Research Gate:实验必须 RESULT_LOCKED 且 verdict = CHALLENGER_WINS(输了/负结果不进发布)
  const exp = experiments.experimentHead(c.experiment_ref);
  if (!exp || exp.status !== 'RESULT_LOCKED') throw new Error(`PROMOTION_EXPERIMENT_NOT_LOCKED:${c.experiment_ref}`);
  if (exp.result.verdict !== 'CHALLENGER_WINS') throw new Error(`PROMOTION_VERDICT_NOT_WINNER:${exp.result.verdict}`);
  // Shadow Gate:影子前向样本必须达到该实验预注册的最低数(DESCRIBE_ONLY 不能作为升级证据)
  for (const sid of c.shadow_forward_refs) {
    const s = shadow.sufficiency(sid);
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
function runCompatibilityCheck(candidateId) {
  const head = candidateHead(candidateId);
  if (!head) throw new Error('CANDIDATE_NOT_FOUND');
  if (head.review_status !== 'PENDING_COMPATIBILITY') throw new Error(`CANDIDATE_NOT_PENDING_COMPATIBILITY:${head.review_status}`);
  const adapter = getAdapter(head.market);
  const draft = _releaseDraft(head, adapter);
  const compat = adapter.validate_release(draft);
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
function requestActivation(releaseId, o = {}) {
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
  const caps = getAdapter(release.market).runtime_capabilities();
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
    previous_release_ref: cand.rollback_ref,
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

// ── Rollback(§12.3 两类语义) ──────────────────────────────────────────────
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
  // OPERATIONAL(或 Founder 批准的 ECONOMIC):切回 previous_release_ref;前向生效,不改历史
  const rec = append(ACTIVATIONS_LEDGER(), {
    schema: 'ROLLBACK_RECORD_V1',
    rollback_id: `RBK-${hash({ a: o.activation_ref, t: uid() })}`,
    activation_ref: o.activation_ref,
    type: o.type,
    restored_release_ref: act.previous_release_ref,
    approved_by: o.type === 'OPERATIONAL' ? (o.approved_by || 'OPERATOR') : 'FOUNDER',
    approved_by_user_id: o.approvedByUserId || null,
    reasonCn: o.reasonCn || null,
    forward_onlyCn: '仅影响其后新 TradePlan;历史结果不重新归因',
    rolledBackAt: now(),
  });
  append(ACTIVATIONS_LEDGER(), { ...act, activation_status: 'ROLLED_BACK', rollback_status: rec.rollback_id });
  // 安全规则:绝不 retire 正要恢复的那个 release 对应 bundle
  const release = releaseHead(act.release_id);
  if (release && String(release.immutable_bundle_ref) !== String(act.previous_release_ref)) {
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
  createRelease, releaseHead, reviewCandidate,
  requestActivation, activationHead, rollback,
  listCandidates, listReleases, listActivations,
  PROMOTIONS_LEDGER, RELEASES_LEDGER, ACTIVATIONS_LEDGER,
};
