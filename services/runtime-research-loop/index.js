'use strict';

/**
 * 运行态／研究态协调层。
 *
 * 权威边界：
 * - Smartflow/Ashare 是运行事实生产者；本服务只存引用；
 * - QRP Experiment/Result Lock 是研究事实生产者；
 * - Desk REVIEW_LOOP_WEEK_V1 是复盘状态和采用决定生产者；本服务不复制状态机；
 * - Cycle 只作为带身份的证据引用，绝不在这里重算或变成资本约束。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const experiments = require('../experiment-orchestrator');
const selfAudit = require('../self-audit');
const strategyDiagnostics = require('../strategy-diagnostics');
const profiles = require('../strategy-profiles');
const m4Scope = require('../strategy-profiles/m4_scope');

const ACCEPTANCE_REF = 'docs/contracts/CYCLE_RESEARCH_DESK_RUNTIME_RESEARCH_LOOP_ACCEPTANCE_V1.md';
const PRODUCT_ACCEPTANCE_REF = 'docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_V1.md';
const PRODUCT_ACCEPTANCE_AMENDMENT_REF = 'docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_1.md';
const PRODUCT_ACCEPTANCE_AMENDMENT_2_REF = 'docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_2.md';
const PRODUCT_ACCEPTANCE_AMENDMENT_3_REF = 'docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_3.md';
const PRODUCT_ACCEPTANCE_AMENDMENT_4_REF = 'docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_4.md';
const PRODUCT_ACCEPTANCE_AMENDMENT_REFS = Object.freeze([
  PRODUCT_ACCEPTANCE_AMENDMENT_REF,
  PRODUCT_ACCEPTANCE_AMENDMENT_2_REF,
  PRODUCT_ACCEPTANCE_AMENDMENT_3_REF,
  PRODUCT_ACCEPTANCE_AMENDMENT_4_REF,
]);
const PRODUCT_SPEC_REF = '/Users/kaylame/Downloads/Cycle_Research_Desk_金融策略投资系统设计与实施规格_V8_1.md';
const PRODUCT_SPEC_SHA256 = 'ecfdda23b52075b8e69980576595fd89a1929f182af05e24fd851c2b2bed627f';
const DIR = () => dataDir('runtime-research-loop');
const CASES_LEDGER = () => path.join(DIR(), 'cases.jsonl');
const LINKS_LEDGER = () => path.join(DIR(), 'links.jsonl');
const MILESTONES_LEDGER = () => path.join(DIR(), 'product-milestones.jsonl');
const PRODUCT_EVIDENCE_LEDGER = () => path.join(DIR(), 'product-evidence.jsonl');
// 有 canonical 诊断生产者的 case：M1 PASS 除类型化证据外，还必须现场通过该诊断（封印、hash、账户对账），
// 不能只凭已登记的非空文件把一个 INVALID／MISSING 的诊断晋级。
/** M1 诊断按 case 找策略档案（config/strategy_profiles.v1.json）；登记了 M1 证据的策略，M1 里程碑必须先过它的原版诊断。 */
const canonicalM1Profile = (caseRef) => profiles.byCase(caseRef);
const PRODUCT_STAGES = Object.freeze(['M0', 'M1', 'M2', 'M3']);
// 修订 4：M4 记成「M4 范围项」——A4.2 的一条策略在自己的 M0→M3 之后记一条 M4；平台级 M4 由这些范围项与首案 M3 推出。M5 仍不在范围
const RECORDABLE_STAGES = Object.freeze([...PRODUCT_STAGES, 'M4']);
const VERIFIED_STATES = Object.freeze(['CONTROLLED_VERIFIED', 'TARGET_DELIVERED']);
const PRODUCT_STAGE_LABELS = Object.freeze({
  M0: '首案准备完成', M1: '现行策略体检版', M2: '方案对照版', M3: '研究与复盘闭环版',
  M4: '扩展研究版', M5: '组合配置研究版',
});
const PRODUCT_EVIDENCE_KINDS = Object.freeze([
  'USER_TASK', 'TECHNICAL_CHECK', 'M0_PREPARATION',
  'RUNTIME_NATIVE_REPLAY', 'ACCOUNT_RECONCILIATION', 'DECISION_FUNNEL', 'EXCEPTION_SCENARIO',
  'STRESS_REPORT', 'COMPARISON_REPORT', 'RESULT_REREAD',
  'DESK_OUTCOME', 'DESK_ROUND_TRIP', 'HISTORICAL_REREAD', 'RESEARCH_ISOLATION', 'DEDUPLICATION',
  'DELIVERY_RELEASE', 'REGISTRY_REUSE',
]);
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required = (value, code) => { if (value === undefined || value === null || value === '') throw new Error(code); };

function assertRuntimeLane(lane) {
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) throw new Error('LOOP_MISSING_RUNTIME_LANE');
  for (const key of ['source_ref', 'source_hash', 'version_ref', 'as_of', 'mode', 'real_order']) {
    required(lane[key], `LOOP_RUNTIME_LANE_MISSING:${key}`);
  }
  if (!['OFF', 'SHADOW', 'PAPER', 'LIVE'].includes(lane.mode)) throw new Error(`LOOP_BAD_RUNTIME_MODE:${lane.mode}`);
  if (![0, 1].includes(lane.real_order)) throw new Error('LOOP_RUNTIME_REAL_ORDER_MUST_BE_0_OR_1');
  if (!/^[0-9a-f]{64}$/.test(lane.source_hash)) throw new Error('LOOP_RUNTIME_SOURCE_HASH_NOT_SHA256');
  if (!Number.isFinite(Date.parse(lane.as_of))) throw new Error('LOOP_RUNTIME_AS_OF_INVALID');
}

function assertDataQuality(quality) {
  if (!quality || typeof quality !== 'object' || Array.isArray(quality)) throw new Error('LOOP_MISSING_DATA_QUALITY');
  for (const key of ['status', 'as_of', 'known_at', 'source_refs', 'freshness']) required(quality[key], `LOOP_DATA_QUALITY_MISSING:${key}`);
  if (!['VALID', 'DEGRADED', 'INVALID', 'STALE', 'UNKNOWN', 'MISSING'].includes(quality.status)) {
    throw new Error(`LOOP_BAD_DATA_QUALITY:${quality.status}`);
  }
  if (!Array.isArray(quality.source_refs)) throw new Error('LOOP_DATA_QUALITY_SOURCE_REFS_NOT_ARRAY');
  if (!Number.isFinite(Date.parse(quality.as_of)) || !Number.isFinite(Date.parse(quality.known_at))) throw new Error('LOOP_DATA_QUALITY_TIME_INVALID');
}

function assertIsolation(isolation) {
  const expected = ['research_can_order', 'research_can_activate', 'research_can_write_runtime'];
  if (!isolation || expected.some((key) => isolation[key] !== false)) throw new Error('LOOP_RESEARCH_ISOLATION_REQUIRED');
}

function assertCycleContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('LOOP_MISSING_CYCLE_CONTEXT');
  if (!['CITED', 'RESEARCH_ONLY', 'NOT_APPLICABLE', 'UNKNOWN', 'MISSING'].includes(context.state)) {
    throw new Error(`LOOP_BAD_CYCLE_STATE:${context.state}`);
  }
  if (!Object.prototype.hasOwnProperty.call(context, 'source_ref') || !Object.prototype.hasOwnProperty.call(context, 'source_hash')) {
    throw new Error('LOOP_CYCLE_CONTEXT_REQUIRES_EXPLICIT_REFS');
  }
  if (context.state === 'CITED' && (!context.source_ref || !context.source_hash)) throw new Error('LOOP_CITED_CYCLE_CONTEXT_MISSING_REF');
  if (context.state === 'CITED' && !/^[0-9a-f]{64}$/.test(context.source_hash)) throw new Error('LOOP_CYCLE_HASH_NOT_SHA256');
}

function headBy(file, key, value) {
  const rows = read(file).filter((row) => row[key] === value);
  return rows.length ? rows[rows.length - 1] : null;
}

function semanticEqual(left, right, omitted = []) {
  const strip = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key)));
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

function assertStringArray(value, code, { nonempty = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(code);
  if (nonempty && value.length === 0) throw new Error(code);
}

function assertProductAuthority(recordedBy) {
  required(recordedBy, 'PRODUCT_MILESTONE_RECORDED_BY_REQUIRED');
  const authority = process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  if (!authority) throw new Error('PRODUCT_MILESTONE_AUTHORITY_NOT_CONFIGURED');
  if (recordedBy !== authority) throw new Error('PRODUCT_MILESTONE_RECORDED_BY_NOT_AUTHORIZED');
}

function fileDigest(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size <= 0) throw new Error('PRODUCT_EVIDENCE_SOURCE_NOT_NONEMPTY_FILE');
  return { source_hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), source_size: stat.size };
}

function assertActualSourcePath(sourceRef) {
  if (!path.isAbsolute(sourceRef)) throw new Error('PRODUCT_EVIDENCE_SOURCE_MUST_BE_ABSOLUTE');
  let real;
  try { real = fs.realpathSync(sourceRef); } catch { throw new Error('PRODUCT_EVIDENCE_SOURCE_NOT_FOUND'); }
  if (/(^|[\\/._-])(fixture|demo|mock|synthetic)([\\/._-]|$)/i.test(real)) {
    throw new Error('PRODUCT_EVIDENCE_NON_ACTUAL_SOURCE');
  }
  return real;
}

function productEvidenceHead(evidenceId) {
  return headBy(PRODUCT_EVIDENCE_LEDGER(), 'evidence_id', evidenceId);
}

function registerProductEvidence(input = {}) {
  const caseRec = headBy(CASES_LEDGER(), 'case_id', input.case_ref);
  if (!caseRec) throw new Error(`PRODUCT_EVIDENCE_CASE_NOT_FOUND:${input.case_ref || 'MISSING'}`);
  if (!PRODUCT_EVIDENCE_KINDS.includes(input.kind)) throw new Error(`PRODUCT_EVIDENCE_BAD_KIND:${input.kind || 'MISSING'}`);
  for (const field of ['source_ref', 'object_ref', 'observed_at']) required(input[field], `PRODUCT_EVIDENCE_MISSING:${field}`);
  if (!Number.isFinite(Date.parse(input.observed_at))) throw new Error('PRODUCT_EVIDENCE_OBSERVED_AT_INVALID');
  assertProductAuthority(input.registered_by);
  const sourceRef = assertActualSourcePath(input.source_ref);
  const digest = fileDigest(sourceRef);
  const core = {
    schema: 'PRODUCT_EVIDENCE_ATTESTATION_V1',
    evidence_id: input.evidence_id || `PE-${sha256({ case_ref: input.case_ref, kind: input.kind, sourceRef, ...digest }).slice(0, 16)}`,
    case_ref: input.case_ref, kind: input.kind, source_ref: sourceRef,
    source_hash: digest.source_hash, source_size: digest.source_size,
    object_ref: input.object_ref, observed_at: input.observed_at,
    verification_method: 'FILE_SHA256', production_effect: 'NONE',
    acceptance_ref: PRODUCT_ACCEPTANCE_REF, registered_by: input.registered_by,
  };
  const existing = productEvidenceHead(core.evidence_id);
  if (existing) {
    if (semanticEqual(existing, core, ['record_hash', 'recorded_at'])) return { ...existing, replayHit: true };
    throw new Error(`PRODUCT_EVIDENCE_ID_CONFLICT:${core.evidence_id}`);
  }
  const body = { ...core, recorded_at: input.recorded_at || now() };
  body.record_hash = sha256(body);
  return append(PRODUCT_EVIDENCE_LEDGER(), body);
}

function validateProductEvidenceRefs(refs, caseRef, requiredKinds, code) {
  assertStringArray(refs, code, { nonempty: true });
  const evidence = refs.map((evidenceId) => {
    const row = productEvidenceHead(evidenceId);
    if (!row) throw new Error(`PRODUCT_EVIDENCE_NOT_REGISTERED:${evidenceId}`);
    if (row.case_ref !== caseRef) throw new Error(`PRODUCT_EVIDENCE_CASE_MISMATCH:${evidenceId}`);
    const sourceRef = assertActualSourcePath(row.source_ref);
    const digest = fileDigest(sourceRef);
    if (digest.source_hash !== row.source_hash || digest.source_size !== row.source_size) {
      throw new Error(`PRODUCT_EVIDENCE_SOURCE_DRIFT:${evidenceId}`);
    }
    return row;
  });
  for (const kind of requiredKinds) {
    if (!evidence.some((row) => row.kind === kind)) throw new Error(`${code}:${kind}`);
  }
  return evidence;
}

function milestoneRows(caseRef = null) {
  return read(MILESTONES_LEDGER()).filter((row) => !caseRef || row.case_ref === caseRef);
}

function milestoneHead(caseRef, stage) {
  const rows = milestoneRows(caseRef).filter((row) => row.stage === stage);
  return rows.length ? rows[rows.length - 1] : null;
}

function assertActualEvidenceRefs(refs) {
  const forbidden = /(^|[:/_-])(FIXTURE|DEMO|MOCK|SYNTHETIC)([:/_-]|$)/i;
  if (refs.some((ref) => forbidden.test(ref))) throw new Error('PRODUCT_MILESTONE_NON_ACTUAL_EVIDENCE_REF');
}

function recordProductMilestone(input = {}) {
  const caseRec = headBy(CASES_LEDGER(), 'case_id', input.case_ref);
  if (!caseRec) throw new Error(`PRODUCT_MILESTONE_CASE_NOT_FOUND:${input.case_ref || 'MISSING'}`);
  if (!RECORDABLE_STAGES.includes(input.stage)) throw new Error(`PRODUCT_MILESTONE_STAGE_OUT_OF_SCOPE:${input.stage || 'MISSING'}`);
  if (!['PASS', 'REVOKED'].includes(input.decision)) throw new Error('PRODUCT_MILESTONE_BAD_DECISION');
  assertProductAuthority(input.recorded_by);
  // 修订 4 A4.2–A4.3：每条策略只能在自己档案里冻结的那个 case 上记阶段（M1 因此总要过该 case 的原版诊断）；
  // 未登记的策略、或不是档案 case 的 case，都不能记任何阶段
  if (input.decision === 'PASS') {
    const profile = profiles.get(caseRec.strategy_ref);
    if (!profile) throw new Error(`PRODUCT_MILESTONE_STRATEGY_NOT_REGISTERED:${caseRec.strategy_ref}`);
    if (profile.case_ref !== input.case_ref) throw new Error(`PRODUCT_MILESTONE_CASE_NOT_PROFILE_CASE:${input.case_ref}`);
  }

  const previous = milestoneHead(input.case_ref, input.stage);
  let upstreamEvidenceRef = null;
  if (input.decision === 'REVOKED') {
    if (!previous || previous.decision !== 'PASS') throw new Error('PRODUCT_MILESTONE_PASS_NOT_FOUND_FOR_REVOCATION');
    if (input.revokes_ref !== previous.evidence_id) throw new Error('PRODUCT_MILESTONE_REVOCATION_TARGET_MISMATCH');
    required(input.defect_ref, 'PRODUCT_MILESTONE_DEFECT_REF_REQUIRED');
    required(input.revocation_reason, 'PRODUCT_MILESTONE_REVOCATION_REASON_REQUIRED');
  }

  if (input.decision === 'PASS') {
    if (input.evidence_mode !== 'ACTUAL_USER_TASK') throw new Error('PRODUCT_MILESTONE_ACTUAL_USER_TASK_REQUIRED');
    if (!['CONTROLLED_PENDING_RELEASE', 'TARGET_DELIVERED'].includes(input.delivery_environment)) {
      throw new Error('PRODUCT_MILESTONE_BAD_DELIVERY_ENVIRONMENT');
    }
    for (const field of ['actual_entrypoint', 'new_capability', 'supported_scope', 'user_operation', 'user_result', 'exception_behavior']) {
      required(input[field], `PRODUCT_MILESTONE_MISSING:${field}`);
    }
    assertStringArray(input.user_evidence_refs, 'PRODUCT_MILESTONE_USER_EVIDENCE_REQUIRED', { nonempty: true });
    assertStringArray(input.technical_evidence_refs, 'PRODUCT_MILESTONE_TECHNICAL_EVIDENCE_REQUIRED', { nonempty: true });
    for (const field of ['preparation_evidence_refs', 'runtime_evidence_refs', 'exception_evidence_refs',
      'stress_evidence_refs', 'comparison_evidence_refs', 'round_trip_evidence_refs']) {
      assertStringArray(input[field], `PRODUCT_MILESTONE_BAD_ARRAY:${field}`);
    }
    assertActualEvidenceRefs([
      ...input.user_evidence_refs, ...input.technical_evidence_refs, ...input.runtime_evidence_refs,
      ...input.preparation_evidence_refs, ...input.exception_evidence_refs, ...input.stress_evidence_refs,
      ...input.comparison_evidence_refs, ...input.round_trip_evidence_refs,
    ]);
    validateProductEvidenceRefs(input.user_evidence_refs, input.case_ref, ['USER_TASK'], 'PRODUCT_MILESTONE_USER_EVIDENCE_REQUIRED');
    validateProductEvidenceRefs(input.technical_evidence_refs, input.case_ref, ['TECHNICAL_CHECK'], 'PRODUCT_MILESTONE_TECHNICAL_EVIDENCE_REQUIRED');
    if (input.delivery_environment === 'TARGET_DELIVERED') {
      required(input.release_evidence_ref, 'PRODUCT_MILESTONE_RELEASE_EVIDENCE_REQUIRED');
      validateProductEvidenceRefs([input.release_evidence_ref], input.case_ref, ['DELIVERY_RELEASE'], 'PRODUCT_MILESTONE_RELEASE_EVIDENCE_REQUIRED');
    }

    const stageIndex = RECORDABLE_STAGES.indexOf(input.stage);
    if (stageIndex > 0) {
      const upstreamStage = RECORDABLE_STAGES[stageIndex - 1];
      // 前一阶段只看本 case 自己的链（A4.3：不从 US_V5 或其他策略继承）
      const upstream = caseChain(input.case_ref).find((row) => row.stage === upstreamStage);
      if (!upstream || !['CONTROLLED_VERIFIED', 'TARGET_DELIVERED'].includes(upstream.state)) {
        throw new Error(`PRODUCT_MILESTONE_UPSTREAM_NOT_VERIFIED:${upstreamStage}`);
      }
      upstreamEvidenceRef = upstream.evidence.evidence_id;
    }
    if (input.stage === 'M0') {
      validateProductEvidenceRefs(input.preparation_evidence_refs, input.case_ref, ['M0_PREPARATION'], 'PRODUCT_MILESTONE_M0_PREPARATION_EVIDENCE_REQUIRED');
    }
    if (input.stage === 'M1') {
      validateProductEvidenceRefs(input.runtime_evidence_refs, input.case_ref,
        ['RUNTIME_NATIVE_REPLAY', 'ACCOUNT_RECONCILIATION', 'DECISION_FUNNEL'], 'PRODUCT_MILESTONE_M1_RUNTIME_EVIDENCE_REQUIRED');
      validateProductEvidenceRefs(input.exception_evidence_refs, input.case_ref,
        ['EXCEPTION_SCENARIO'], 'PRODUCT_MILESTONE_M1_EXCEPTION_EVIDENCE_REQUIRED');
      const diagnosticProfile = canonicalM1Profile(input.case_ref);
      if (diagnosticProfile) {
        const diagnostic = strategyDiagnostics.readFreshDiagnostic(diagnosticProfile.strategy_ref);
        if (diagnostic.state !== 'VERIFIED') {
          throw new Error(`PRODUCT_MILESTONE_M1_DIAGNOSTIC_NOT_VERIFIED:${diagnostic.state}:${diagnostic.reason_code || 'UNKNOWN'}`);
        }
        // CRYPTO_Q0_RESULT_V1 §9.5：诊断必须是本 case 的（别的策略的证据不能充当本策略的运行证据）
        if (diagnostic.case_ref !== input.case_ref) throw new Error(`PRODUCT_MILESTONE_M1_DIAGNOSTIC_CASE_MISMATCH:${diagnostic.case_ref || 'MISSING'}`);
      }
    }
    if (['M2', 'M3'].includes(input.stage)) {
      const link = listLinks().find((row) => row.case_ref === input.case_ref && row.result_ref === input.result_ref);
      if (!link || link.conclusion === 'PENDING') throw new Error('PRODUCT_MILESTONE_LOCKED_RESULT_REQUIRED');
    }
    if (input.stage === 'M2') {
      validateProductEvidenceRefs(input.stress_evidence_refs, input.case_ref,
        ['STRESS_REPORT'], 'PRODUCT_MILESTONE_M2_STRESS_EVIDENCE_REQUIRED');
      validateProductEvidenceRefs(input.comparison_evidence_refs, input.case_ref,
        ['COMPARISON_REPORT', 'RESULT_REREAD'], 'PRODUCT_MILESTONE_M2_COMPARISON_EVIDENCE_REQUIRED');
    }
    if (input.stage === 'M3') {
      required(input.desk_outcome_ref, 'PRODUCT_MILESTONE_M3_DESK_OUTCOME_REQUIRED');
      required(input.desk_outcome_evidence_ref, 'PRODUCT_MILESTONE_M3_DESK_OUTCOME_EVIDENCE_REQUIRED');
      const deskEvidence = validateProductEvidenceRefs([input.desk_outcome_evidence_ref], input.case_ref,
        ['DESK_OUTCOME'], 'PRODUCT_MILESTONE_M3_DESK_OUTCOME_EVIDENCE_REQUIRED')[0];
      if (deskEvidence.object_ref !== input.desk_outcome_ref) throw new Error('PRODUCT_MILESTONE_M3_DESK_OUTCOME_MISMATCH');
      validateProductEvidenceRefs(input.round_trip_evidence_refs, input.case_ref,
        ['DESK_ROUND_TRIP', 'HISTORICAL_REREAD', 'RESEARCH_ISOLATION', 'DEDUPLICATION'],
        'PRODUCT_MILESTONE_M3_ROUND_TRIP_EVIDENCE_REQUIRED');
    }
    if (input.stage === 'M4') assertM4ScopeItem(input, caseRec);
  }

  const base = input.decision === 'REVOKED' ? previous : input;
  if (input.decision === 'REVOKED') upstreamEvidenceRef = previous.upstream_evidence_ref || null;
  const idSeed = { ...input, upstream_evidence_ref: upstreamEvidenceRef };
  delete idSeed.evidence_id;
  delete idSeed.recorded_at;
  const core = {
    schema: 'PRODUCT_MILESTONE_EVIDENCE_V1',
    evidence_id: input.evidence_id || `PME-${sha256(idSeed).slice(0, 16)}`,
    case_ref: input.case_ref, stage: input.stage, decision: input.decision,
    evidence_mode: input.decision === 'PASS' ? input.evidence_mode : previous.evidence_mode,
    delivery_environment: input.decision === 'PASS' ? input.delivery_environment : previous.delivery_environment,
    actual_entrypoint: base.actual_entrypoint, new_capability: base.new_capability, supported_scope: base.supported_scope,
    user_operation: base.user_operation, user_result: base.user_result, exception_behavior: base.exception_behavior,
    user_evidence_refs: input.decision === 'PASS' ? input.user_evidence_refs : [],
    technical_evidence_refs: input.decision === 'PASS' ? input.technical_evidence_refs : [],
    preparation_evidence_refs: input.decision === 'PASS' ? input.preparation_evidence_refs : [],
    runtime_evidence_refs: input.decision === 'PASS' ? input.runtime_evidence_refs : [],
    exception_evidence_refs: input.decision === 'PASS' ? input.exception_evidence_refs : [],
    stress_evidence_refs: input.decision === 'PASS' ? input.stress_evidence_refs : [],
    comparison_evidence_refs: input.decision === 'PASS' ? input.comparison_evidence_refs : [],
    round_trip_evidence_refs: input.decision === 'PASS' ? input.round_trip_evidence_refs : [],
    ...(input.stage === 'M4' ? { reuse_evidence_refs: input.decision === 'PASS' ? input.reuse_evidence_refs : previous.reuse_evidence_refs } : {}),
    result_ref: input.decision === 'PASS' ? (input.result_ref || null) : previous.result_ref,
    desk_outcome_ref: input.decision === 'PASS' ? (input.desk_outcome_ref || null) : previous.desk_outcome_ref,
    desk_outcome_evidence_ref: input.decision === 'PASS' ? (input.desk_outcome_evidence_ref || null) : previous.desk_outcome_evidence_ref,
    release_evidence_ref: input.decision === 'PASS' ? (input.release_evidence_ref || null) : previous.release_evidence_ref,
    upstream_evidence_ref: upstreamEvidenceRef,
    revokes_ref: input.decision === 'REVOKED' ? input.revokes_ref : null,
    defect_ref: input.decision === 'REVOKED' ? input.defect_ref : null,
    revocation_reason: input.decision === 'REVOKED' ? input.revocation_reason : null,
    production_effect: 'NONE', acceptance_ref: PRODUCT_ACCEPTANCE_REF,
    acceptance_amendment_refs: [...PRODUCT_ACCEPTANCE_AMENDMENT_REFS], recorded_by: input.recorded_by,
  };
  const existing = headBy(MILESTONES_LEDGER(), 'evidence_id', core.evidence_id);
  if (existing) {
    // 引用的修订清单是记录当时的版本，不是提交内容：同内容在新增修订之后重复提交仍是幂等重放
    if (semanticEqual(existing, core, ['stage_hash', 'recorded_at', 'acceptance_amendment_refs'])) return { ...existing, replayHit: true };
    throw new Error(`PRODUCT_MILESTONE_EVIDENCE_ID_CONFLICT:${core.evidence_id}`);
  }
  const body = { ...core, recorded_at: input.recorded_at || now() };
  body.stage_hash = sha256(body);
  return append(MILESTONES_LEDGER(), body);
}

/**
 * 一个 case 自己的阶段链：M0→M3，加上它作为 M4 范围项的一条（修订 4）。每一阶段只认本 case 的记录，
 * 且必须引用本 case 上一阶段当时有效的证据；上游撤销或失效时下游派生为 INVALIDATED_BY_UPSTREAM。
 */
function caseChain(caseRef) {
  let upstreamValid = true;
  let upstreamEvidenceId = null;
  return RECORDABLE_STAGES.map((stage) => {
    const evidence = milestoneHead(caseRef, stage);
    let state = 'NOT_VERIFIED';
    if (evidence && evidence.decision === 'REVOKED') state = 'REVOKED';
    else if (evidence && evidence.decision === 'PASS' && upstreamValid
      && (stage === 'M0' || evidence.upstream_evidence_ref === upstreamEvidenceId)) {
      state = evidence.delivery_environment === 'TARGET_DELIVERED' ? 'TARGET_DELIVERED' : 'CONTROLLED_VERIFIED';
    } else if (evidence && evidence.decision === 'PASS' && !upstreamValid) state = 'INVALIDATED_BY_UPSTREAM';
    else if (evidence && evidence.decision === 'PASS') state = 'INVALIDATED_BY_UPSTREAM';
    if (VERIFIED_STATES.includes(state)) upstreamEvidenceId = evidence.evidence_id;
    else {
      upstreamValid = false;
      upstreamEvidenceId = null;
    }
    return { stage, label: PRODUCT_STAGE_LABELS[stage], state, evidence };
  });
}

/** 修订 4 A4.5 的三项前提里，记 M4 范围项时要现场核对的部分（本 case 自己的 M1–M3 已由上游规则核对）。 */
function assertM4ScopeItem(input, caseRec) {
  const scope = m4Scope.current();
  if (!m4Scope.itemFor(caseRec.strategy_ref)) throw new Error(`PRODUCT_MILESTONE_M4_STRATEGY_NOT_IN_SCOPE:${caseRec.strategy_ref}`);
  const first = profiles.get(scope.first_case_strategy_ref);
  const firstM3 = first ? caseChain(first.case_ref).find((row) => row.stage === 'M3').state : 'NOT_VERIFIED';
  if (!VERIFIED_STATES.includes(firstM3)) throw new Error(`PRODUCT_MILESTONE_M4_FIRST_CASE_M3_NOT_PASSED:${firstM3}`);
  let contractSha = null;
  try {
    contractSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', '..', scope.registry_acceptance.ref))).digest('hex');
  } catch { contractSha = null; }
  if (contractSha !== scope.registry_acceptance.sha256) throw new Error('PRODUCT_MILESTONE_M4_REGISTRY_ACCEPTANCE_MISSING');
  assertStringArray(input.reuse_evidence_refs, 'PRODUCT_MILESTONE_M4_REUSE_EVIDENCE_REQUIRED', { nonempty: true });
  assertActualEvidenceRefs(input.reuse_evidence_refs);
  validateProductEvidenceRefs(input.reuse_evidence_refs, input.case_ref, ['REGISTRY_REUSE'], 'PRODUCT_MILESTONE_M4_REUSE_EVIDENCE_REQUIRED');
}

/**
 * 平台级 M4（修订 4 A4.4–A4.5）：首案（US_V5）M3 有效，且至少一条 A4.2 策略的 M4 范围项有效，才不是 NOT_VERIFIED；
 * 五条全部有效才算「支持全部五条」。没有登记档案或还没有 case 的条目写「已列入 M4 范围，尚未接入」，不给阶段零值。
 */
function platformM4() {
  const scope = m4Scope.current();
  const first = profiles.get(scope.first_case_strategy_ref);
  const firstM3 = first ? caseChain(first.case_ref).find((row) => row.stage === 'M3').state : 'NOT_VERIFIED';
  const items = scope.items.map((item) => {
    const profile = item.strategy_ref ? profiles.get(item.strategy_ref) : null;
    // A4.4 第 2 条：有导入档案（已登记档案）就是「已接入」，按它自己的 M0→M3 显示；运行态 case 只是记阶段的前提
    if (!profile) {
      return { ...item, state: 'IN_SCOPE_NOT_ONBOARDED', state_label: m4Scope.NOT_ONBOARDED_LABEL, case_ref: null, stages: null, m4_state: null, m4_evidence_id: null };
    }
    const chain = caseChain(profile.case_ref);
    const own = chain.find((row) => row.stage === 'M4');
    return {
      ...item, state: 'ONBOARDED', state_label: '已接入，按本策略自己的 M0→M3 记录', case_ref: profile.case_ref,
      stages: chain.filter((row) => PRODUCT_STAGES.includes(row.stage)).map(({ stage, label, state }) => ({ stage, label, state })),
      m4_state: own.state, m4_evidence_id: own.evidence ? own.evidence.evidence_id : null,
    };
  });
  const passed = VERIFIED_STATES.includes(firstM3) ? items.filter((item) => VERIFIED_STATES.includes(item.m4_state)) : [];
  const state = !passed.length ? 'NOT_VERIFIED' : (passed.some((item) => item.m4_state === 'TARGET_DELIVERED') ? 'TARGET_DELIVERED' : 'CONTROLLED_VERIFIED');
  return {
    stage: 'M4', label: PRODUCT_STAGE_LABELS.M4, state, acceptance_ref: scope.acceptance_ref,
    direction: scope.direction, other_directions: scope.other_directions,
    first_case: { strategy_ref: scope.first_case_strategy_ref, case_ref: first ? first.case_ref : null, m3_state: firstM3 },
    registry_acceptance_ref: scope.registry_acceptance.ref,
    items, passed_items: passed.map((item) => item.id), supports_all_items: passed.length === items.length,
    m5: { stage: 'M5', label: PRODUCT_STAGE_LABELS.M5, state: 'OUT_OF_SCOPE' },
  };
}

/** 一个 case 的阶段行：本 case 的 M0–M3，平台级 M4 一行（修订 4：A4.5 满足之前都是 NOT_VERIFIED），M5 仍 OUT_OF_SCOPE。 */
function productStagesFor(caseRef, platform = platformM4()) {
  const firstPassed = platform.items.find((item) => platform.passed_items.includes(item.id));
  return [...caseChain(caseRef).filter((row) => PRODUCT_STAGES.includes(row.stage)),
    { stage: 'M4', label: PRODUCT_STAGE_LABELS.M4, state: platform.state, evidence: firstPassed ? milestoneHead(firstPassed.case_ref, 'M4') : null },
    { stage: 'M5', label: PRODUCT_STAGE_LABELS.M5, state: 'OUT_OF_SCOPE', evidence: null }];
}

function openCase(input = {}) {
  for (const key of ['strategy_ref', 'market']) required(input[key], `LOOP_CASE_MISSING:${key}`);
  assertRuntimeLane(input.runtime_lane);
  assertDataQuality(input.data_quality);
  assertIsolation(input.isolation);
  assertCycleContext(input.cycle_context);
  if (!input.baseline || typeof input.baseline !== 'object') throw new Error('LOOP_CASE_MISSING:baseline');
  for (const key of ['strategy_ref', 'market']) required(input.baseline[key], `LOOP_BASELINE_MISSING:${key}`);

  const baseline = selfAudit.freezeStrategyBaseline({
    ...input.baseline,
    runtime_mode: input.baseline.runtime_mode || input.runtime_lane.mode,
    acceptance_ref: ACCEPTANCE_REF,
  });
  const core = {
    schema: 'RUNTIME_RESEARCH_CASE_V1',
    case_id: input.case_id || `RRC-${sha256({ strategy_ref: input.strategy_ref, market: input.market, baseline_ref: baseline.baseline_id }).slice(0, 16)}`,
    strategy_ref: input.strategy_ref, market: input.market,
    runtime_lane: input.runtime_lane, baseline_ref: baseline.baseline_id,
    cycle_context: input.cycle_context, data_quality: input.data_quality,
    isolation: input.isolation, status: input.status || 'RESEARCH_PENDING',
    production_effect: 'NONE', acceptance_ref: ACCEPTANCE_REF,
  };
  const existing = headBy(CASES_LEDGER(), 'case_id', core.case_id);
  if (existing) {
    if (semanticEqual(existing, core, ['case_hash', 'opened_at'])) return { ...existing, replayHit: true };
    throw new Error(`LOOP_CASE_ID_CONFLICT:${core.case_id}`);
  }
  const body = { ...core, opened_at: input.opened_at || now() };
  body.case_hash = sha256(body);
  return append(CASES_LEDGER(), body);
}

function registerReviewQuestion(caseId, input = {}) {
  const caseRec = headBy(CASES_LEDGER(), 'case_id', caseId);
  if (!caseRec) throw new Error(`LOOP_CASE_NOT_FOUND:${caseId}`);
  for (const key of ['desk_candidate_ref', 'desk_evidence_ref', 'desk_evidence_hash', 'research_question_ref']) {
    required(input[key], `LOOP_LINK_MISSING:${key}`);
  }
  const core = {
    schema: 'RUNTIME_RESEARCH_LINK_V1',
    link_id: input.link_id || `RRL-${sha256({ caseId, desk_candidate_ref: input.desk_candidate_ref, research_question_ref: input.research_question_ref }).slice(0, 16)}`,
    case_ref: caseId, desk_candidate_ref: input.desk_candidate_ref,
    desk_evidence_ref: input.desk_evidence_ref, desk_evidence_hash: input.desk_evidence_hash,
    research_question_ref: input.research_question_ref,
    experiment_ref: null, experiment_freeze_hash: null, result_ref: null, result_hash: null,
    conclusion: 'PENDING', adoption_state: 'NOT_DECIDED', production_effect: 'NONE',
  };
  if (!/^[0-9a-f]{64}$/.test(core.desk_evidence_hash)) throw new Error('LOOP_DESK_EVIDENCE_HASH_NOT_SHA256');
  const existing = headBy(LINKS_LEDGER(), 'link_id', core.link_id);
  if (existing) {
    if (semanticEqual(existing, core, ['link_hash', 'recorded_at'])) return { ...existing, replayHit: true };
    throw new Error(`LOOP_LINK_ID_CONFLICT:${core.link_id}`);
  }
  const body = { ...core, recorded_at: input.recorded_at || now() };
  body.link_hash = sha256(body);
  return append(LINKS_LEDGER(), body);
}

const CONCLUSION_OF = Object.freeze({
  CHALLENGER_WINS: 'PASS', CHAMPION_HOLDS: 'FAIL', NEGATIVE_RESULT: 'FAIL', INCONCLUSIVE: 'INSUFFICIENT',
});

function linkLockedResult(linkId, experimentId, input = {}) {
  const head = headBy(LINKS_LEDGER(), 'link_id', linkId);
  if (!head) throw new Error(`LOOP_LINK_NOT_FOUND:${linkId}`);
  const caseRec = headBy(CASES_LEDGER(), 'case_id', head.case_ref);
  if (!caseRec) throw new Error(`LOOP_CASE_NOT_FOUND:${head.case_ref}`);
  if (head.conclusion !== 'PENDING') {
    if (head.experiment_ref === experimentId) return { ...head, replayHit: true };
    throw new Error(`LOOP_LINK_ALREADY_RESULT_LINKED:${linkId}`);
  }
  const frozen = experiments.verifyFreeze(experimentId);
  if (!frozen.ok) throw new Error(`LOOP_EXPERIMENT_FREEZE_INVALID:${frozen.reason}`);
  const exp = experiments.experimentHead(experimentId);
  if (!exp || exp.status !== 'RESULT_LOCKED' || !exp.result) throw new Error('LOOP_EXPERIMENT_RESULT_NOT_LOCKED');
  const artifact = experiments.artifactFor(experimentId);
  if (!artifact || !artifact.result_hash) throw new Error('LOOP_EXPERIMENT_ARTIFACT_MISSING');
  if (frozen.spec.market !== caseRec.market || artifact.market !== caseRec.market) throw new Error('LOOP_EXPERIMENT_MARKET_MISMATCH');
  if (frozen.spec.champion_ref !== caseRec.strategy_ref) throw new Error('LOOP_EXPERIMENT_CHAMPION_MISMATCH');
  if (frozen.spec.hypothesis_ref !== head.research_question_ref) throw new Error('LOOP_RESEARCH_QUESTION_MISMATCH');
  const nativeStrategyRef = artifact.native_identity && artifact.native_identity.strategy_ref;
  if ((caseRec.market === 'US_EQUITY' || nativeStrategyRef) && nativeStrategyRef !== caseRec.strategy_ref) {
    throw new Error('LOOP_ARTIFACT_STRATEGY_MISMATCH');
  }
  if (caseRec.market === 'US_EQUITY') {
    const cost = artifact.cost_breakdown;
    const funnel = artifact.decision_funnel;
    const runtimePath = artifact.runtime_path;
    if (!cost || !Number.isFinite(cost.total) || !Number.isFinite(cost.champion_total) || !Number.isFinite(cost.challenger_total)
      || !Array.isArray(cost.missing_components) || artifact.nav_semantics !== 'NET_OF_SIGNED_MODEL_COSTS') {
      throw new Error('LOOP_US_NET_COST_INCOMPLETE');
    }
    const completeCost = cost.completeness === 'COMPLETE' && cost.state === 'MEASURED'
      && cost.scope === 'COMPLETE_SIGNED_MODEL_COSTS' && artifact.cost_scope === 'COMPLETE_SIGNED_MODEL_COSTS'
      && cost.missing_components.length === 0;
    if (!completeCost) throw new Error('LOOP_US_NET_COST_INCOMPLETE');
    if (!funnel || funnel.state !== 'COMPLETE' || ['scanned', 'signaled', 'intended', 'filled', 'rejected'].some((key) => !Number.isInteger(funnel[key]))) {
      throw new Error('LOOP_US_DECISION_FUNNEL_INCOMPLETE');
    }
    if (!runtimePath || runtimePath.state !== 'COMPLETE' || !runtimePath.path_hash) throw new Error('LOOP_US_RUNTIME_PATH_INCOMPLETE');
    if (!artifact.mechanical_adjudication || artifact.mechanical_adjudication.verdict !== exp.result.verdict) {
      throw new Error('LOOP_US_ADJUDICATION_DRIFT');
    }
  }
  if (exp.backtest_artifact_hash !== artifact.result_hash) throw new Error('LOOP_EXPERIMENT_RESULT_ARTIFACT_DRIFT');
  if (exp.result.sample_evidence_ref !== artifact.result_hash || exp.result_artifact_hash !== artifact.result_hash) {
    throw new Error('LOOP_EXPERIMENT_RESULT_EVIDENCE_DRIFT');
  }
  if (input.expected_result_hash && input.expected_result_hash !== artifact.result_hash) throw new Error('LOOP_RESULT_HASH_MISMATCH');
  const conclusion = CONCLUSION_OF[exp.result.verdict];
  if (!conclusion) throw new Error(`LOOP_RESULT_VERDICT_UNSUPPORTED:${exp.result.verdict}`);
  const body = {
    ...head, experiment_ref: experimentId, experiment_freeze_hash: frozen.spec.freeze_hash,
    result_ref: `QRP:${experimentId}:RESULT_LOCKED`, result_hash: artifact.result_hash,
    conclusion, adoption_state: 'NOT_DECIDED', production_effect: 'NONE', recorded_at: input.recorded_at || now(),
  };
  delete body.replayHit;
  delete body.link_hash;
  body.link_hash = sha256(body);
  return append(LINKS_LEDGER(), body);
}

function listCases() {
  const map = new Map();
  for (const row of read(CASES_LEDGER())) map.set(row.case_id, row);
  return [...map.values()];
}
function listLinks() {
  const map = new Map();
  for (const row of read(LINKS_LEDGER())) map.set(row.link_id, row);
  return [...map.values()];
}
function readModel() {
  const platform = platformM4();
  const links = listLinks();
  const cases = listCases();
  const baselines = new Map(selfAudit.list('baseline').map((row) => [row.baseline_id, row]));
  return {
    schema: 'RUNTIME_RESEARCH_LOOP_READ_MODEL_V1',
    authority: {
      runtime: 'MARKET_REPOSITORY', research: 'QRP_RESULT_LOCK', review_and_adoption: 'DESK_REVIEW_LOOP_WEEK_V1',
      cycle: 'CYCLE_EVIDENCE_REFERENCE_ONLY',
    },
    invariants: {
      research_can_order: false, research_can_activate: false,
      research_can_write_runtime: false, automatic_promotion: false,
    },
    product_delivery: {
      schema: 'PRODUCT_MILESTONE_READ_MODEL_V1', spec_ref: PRODUCT_SPEC_REF,
      spec_sha256: PRODUCT_SPEC_SHA256, acceptance_ref: PRODUCT_ACCEPTANCE_REF,
      acceptance_amendment_refs: [...PRODUCT_ACCEPTANCE_AMENDMENT_REFS],
      truth_rule: 'ENGINEERING_OR_HTTP_SUCCESS_DOES_NOT_IMPLY_PRODUCT_DELIVERY',
      evidence_rule: 'REGISTERED_CASE_BOUND_TYPED_FILE_SHA256_EVIDENCE_ONLY',
      completion_authority: process.env.QRP_PRODUCT_MILESTONE_AUTHORITY ? 'CONFIGURED' : 'NOT_CONFIGURED',
      cases: cases.map((caseRec) => ({ case_ref: caseRec.case_id, strategy_ref: caseRec.strategy_ref, stages: productStagesFor(caseRec.case_id, platform) })),
      platform_m4: platform,
    },
    cases: cases.map((caseRec) => ({
      ...caseRec,
      baseline: baselines.get(caseRec.baseline_ref) || null,
      links: links.filter((link) => link.case_ref === caseRec.case_id),
    })),
  };
}

module.exports = {
  ACCEPTANCE_REF, PRODUCT_ACCEPTANCE_REF, PRODUCT_ACCEPTANCE_AMENDMENT_REF, PRODUCT_ACCEPTANCE_AMENDMENT_2_REF,
  PRODUCT_ACCEPTANCE_AMENDMENT_3_REF, PRODUCT_ACCEPTANCE_AMENDMENT_4_REF,
  PRODUCT_ACCEPTANCE_AMENDMENT_REFS, PRODUCT_SPEC_REF, PRODUCT_SPEC_SHA256,
  PRODUCT_EVIDENCE_KINDS, CASES_LEDGER, LINKS_LEDGER, MILESTONES_LEDGER, PRODUCT_EVIDENCE_LEDGER,
  openCase, registerReviewQuestion, linkLockedResult, registerProductEvidence, recordProductMilestone,
  listCases, listLinks, readModel,
};
