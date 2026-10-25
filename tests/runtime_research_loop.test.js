'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PRODUCT_AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = PRODUCT_AUTHORITY;

const loop = require('../services/runtime-research-loop');
const selfAudit = require('../services/self-audit');
const experiments = require('../services/experiment-orchestrator');
const { setupExperiment } = require('./_fixture');

function caseInput(overrides = {}) {
  return {
    case_id: 'RRC-US-V5-TEST', strategy_ref: 'US_V5_ETF_3000USD', market: 'US_EQUITY',
    runtime_lane: {
      source_ref: 'SMARTFLOW:REVIEW_DECOMPOSITION_V1:2026-10-24', source_hash: 'a'.repeat(64),
      version_ref: 'US_V5@code-hash', as_of: '2026-10-24T20:00:00Z', mode: 'PAPER', real_order: 0,
    },
    baseline: {
      baseline_id: 'BASELINE-US-V5-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY',
      version_ref: 'US_V5_ETF_6000USD@frozen-old',
      source_ref: 'SMARTFLOW:SIGNED_RESEARCH:US_V5_ETF_6000USD', source_hash: 'b'.repeat(64),
      expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
      frozen_at: '2026-10-24T20:01:00Z',
    },
    cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
    data_quality: {
      status: 'VALID', as_of: '2026-10-24', known_at: '2026-10-24T20:00:00Z',
      source_refs: ['SMARTFLOW:US_V5_SCAN_RECORD_V2'], freshness: { state: 'CURRENT', age_seconds: 0 },
    },
    isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
    opened_at: '2026-10-24T20:02:00Z', ...overrides,
  };
}

function productEvidence(stage, kind, evidenceSet = 'PRIMARY', objectRef = null) {
  const safe = `${stage}-${kind}-${evidenceSet}`.replace(/[^A-Za-z0-9_-]/g, '-');
  const dir = path.join(process.env.QRP_DATA_DIR, 'product-evidence-files');
  fs.mkdirSync(dir, { recursive: true });
  const sourceRef = path.join(dir, `${safe}.json`);
  if (!fs.existsSync(sourceRef)) fs.writeFileSync(sourceRef, `${JSON.stringify({ stage, kind, evidenceSet, objectRef })}\n`);
  return loop.registerProductEvidence({
    evidence_id: `PE-${safe}`, case_ref: 'RRC-CN-LOCKED-TEST', kind, source_ref: sourceRef,
    object_ref: objectRef || `ACTUAL:${stage}:${kind}:${evidenceSet}`,
    observed_at: '2026-10-24T20:20:00Z', registered_by: PRODUCT_AUTHORITY,
    recorded_at: '2026-10-24T20:21:00Z',
  });
}

function evidenceId(stage, kind, evidenceSet = 'PRIMARY', objectRef = null) {
  return productEvidence(stage, kind, evidenceSet, objectRef).evidence_id;
}

function milestoneInput(stage, overrides = {}) {
  const evidenceSet = overrides.evidence_set || 'PRIMARY';
  const cleanOverrides = { ...overrides };
  delete cleanOverrides.evidence_set;
  const deskOutcomeRef = Object.prototype.hasOwnProperty.call(cleanOverrides, 'desk_outcome_ref')
    ? cleanOverrides.desk_outcome_ref : (stage === 'M3' ? 'REVIEW_LOOP_WEEK_V1:RESULT:DONT:001' : null);
  const base = {
    evidence_id: `PME-PRODUCT-${stage}`,
    case_ref: 'RRC-CN-LOCKED-TEST', stage, decision: 'PASS', evidence_mode: 'ACTUAL_USER_TASK',
    delivery_environment: 'CONTROLLED_PENDING_RELEASE',
    actual_entrypoint: 'RESEARCH:runtime-research-loop',
    new_capability: `PRODUCT_CAPABILITY:${stage}`,
    supported_scope: 'CN_A:TEST_STRATEGY:CONTROLLED_PRODUCT_PATH',
    user_operation: `USER_TASK:${stage}:OPEN_INSPECT_RETURN`,
    user_result: `USER_RESULT:${stage}:UNDERSTOOD`,
    exception_behavior: 'MISSING_DATA_SHOWN_AS_MISSING_NOT_ZERO',
    user_evidence_refs: [evidenceId(stage, 'USER_TASK', evidenceSet)],
    technical_evidence_refs: [evidenceId(stage, 'TECHNICAL_CHECK', evidenceSet)],
    preparation_evidence_refs: stage === 'M0' ? [evidenceId(stage, 'M0_PREPARATION', evidenceSet)] : [],
    runtime_evidence_refs: stage === 'M1' ? [
      evidenceId(stage, 'RUNTIME_NATIVE_REPLAY', evidenceSet),
      evidenceId(stage, 'ACCOUNT_RECONCILIATION', evidenceSet),
      evidenceId(stage, 'DECISION_FUNNEL', evidenceSet),
    ] : [],
    exception_evidence_refs: stage === 'M1' ? [evidenceId(stage, 'EXCEPTION_SCENARIO', evidenceSet)] : [],
    stress_evidence_refs: stage === 'M2' ? [evidenceId(stage, 'STRESS_REPORT', evidenceSet)] : [],
    comparison_evidence_refs: stage === 'M2' ? [
      evidenceId(stage, 'COMPARISON_REPORT', evidenceSet), evidenceId(stage, 'RESULT_REREAD', evidenceSet),
    ] : [],
    round_trip_evidence_refs: stage === 'M3' ? [
      evidenceId(stage, 'DESK_ROUND_TRIP', evidenceSet), evidenceId(stage, 'HISTORICAL_REREAD', evidenceSet),
      evidenceId(stage, 'RESEARCH_ISOLATION', evidenceSet), evidenceId(stage, 'DEDUPLICATION', evidenceSet),
    ] : [],
    result_ref: null, desk_outcome_ref: deskOutcomeRef,
    desk_outcome_evidence_ref: stage === 'M3' && deskOutcomeRef
      ? evidenceId(stage, 'DESK_OUTCOME', evidenceSet, deskOutcomeRef) : null,
    release_evidence_ref: null,
    recorded_by: PRODUCT_AUTHORITY, recorded_at: `2026-10-24T2${stage.slice(1)}:30:00Z`,
  };
  const merged = { ...base, ...cleanOverrides };
  if (merged.delivery_environment === 'TARGET_DELIVERED'
    && !Object.prototype.hasOwnProperty.call(cleanOverrides, 'release_evidence_ref')) {
    merged.release_evidence_ref = evidenceId(stage, 'DELIVERY_RELEASE', evidenceSet);
  }
  return merged;
}

test('运行态与冻结基线分别入账；同内容幂等，同 ID 漂移拒绝', () => {
  const first = loop.openCase(caseInput());
  assert.equal(first.baseline_ref, 'BASELINE-US-V5-TEST');
  assert.equal(selfAudit.list('baseline')[0].strategy_ref, 'US_V5_ETF_6000USD');
  assert.equal(loop.readModel().cases.find((row) => row.case_id === first.case_id).baseline.strategy_ref, 'US_V5_ETF_6000USD');
  assert.notEqual(first.runtime_lane.source_hash, selfAudit.list('baseline')[0].source_hash);
  assert.equal(loop.openCase(caseInput()).replayHit, true);
  assert.throws(() => loop.openCase(caseInput({ runtime_lane: { ...caseInput().runtime_lane, source_hash: 'c'.repeat(64) } })), /LOOP_CASE_ID_CONFLICT/);
});

test('调用方不提供时间戳时，业务同内容仍幂等', () => {
  const input = caseInput({ case_id: 'RRC-NO-CALLER-TIME' });
  delete input.opened_at;
  delete input.baseline.frozen_at;
  const first = loop.openCase(input);
  const second = loop.openCase(input);
  assert.equal(second.replayHit, true);
  assert.equal(second.case_hash, first.case_hash);
});

test('研究隔离 fail closed；Cycle 缺失与不适用保持显式状态', () => {
  assert.throws(() => loop.openCase(caseInput({ case_id: 'RRC-BAD-ISO', isolation: { research_can_order: true } })), /LOOP_RESEARCH_ISOLATION_REQUIRED/);
  assert.throws(() => loop.openCase(caseInput({ case_id: 'RRC-BAD-CYCLE', cycle_context: { state: 'CITED', source_ref: null, source_hash: null } })), /LOOP_CITED_CYCLE_CONTEXT_MISSING_REF/);
});

test('Desk 问题拒绝跨市场/跨策略绑定；同身份锁定结果也不自动采用', async () => {
  loop.openCase(caseInput());
  const link = loop.registerReviewQuestion('RRC-US-V5-TEST', {
    link_id: 'RRL-US-V5-TEST', desk_candidate_ref: 'RLC-US-2026W43-01',
    desk_evidence_ref: 'REVIEW_LOOP_WEEK_V1:2026-W43:R1#candidate',
    desk_evidence_hash: 'e'.repeat(64),
    research_question_ref: 'RQ-US-V5-PLAN-ADHERENCE', recorded_at: '2026-10-24T20:03:00Z',
  });
  assert.equal(link.conclusion, 'PENDING');
  const fx = await setupExperiment({ experiment_id: 'EXP-LOOP-LOCKED' });
  await experiments.runBacktest(fx.exp.experiment_id);
  assert.throws(() => loop.linkLockedResult(link.link_id, fx.exp.experiment_id), /LOOP_EXPERIMENT_RESULT_NOT_LOCKED/);
  experiments.recordResult(fx.exp.experiment_id, { verdict: 'INCONCLUSIVE' });
  assert.throws(() => loop.linkLockedResult(link.link_id, fx.exp.experiment_id), /LOOP_EXPERIMENT_MARKET_MISMATCH/);

  const cnCase = loop.openCase(caseInput({
    case_id: 'RRC-CN-LOCKED-TEST', strategy_ref: fx.champRef, market: 'CN_A',
    baseline: { ...caseInput().baseline, baseline_id: 'BASELINE-CN-LOCKED-TEST', strategy_ref: fx.champRef, market: 'CN_A' },
  }));
  const cnLink = loop.registerReviewQuestion(cnCase.case_id, {
    link_id: 'RRL-CN-LOCKED-TEST', desk_candidate_ref: 'RLC-CN-2026W43-01',
    desk_evidence_ref: 'REVIEW_LOOP_WEEK_V1:2026-W43:CN#candidate',
    desk_evidence_hash: 'd'.repeat(64), research_question_ref: fx.hyp.hypothesis_id,
    recorded_at: '2026-10-24T20:04:00Z',
  });
  const result = loop.linkLockedResult(cnLink.link_id, fx.exp.experiment_id);
  assert.equal(result.conclusion, 'INSUFFICIENT');
  assert.equal(result.adoption_state, 'NOT_DECIDED');
  assert.equal(result.production_effect, 'NONE');
  assert.equal(loop.linkLockedResult(cnLink.link_id, fx.exp.experiment_id).replayHit, true);
  assert.equal(loop.readModel().invariants.automatic_promotion, false);
});

test('US 成本有显式缺项也不得 Result Lock 回链', () => {
  const caseRec = loop.openCase(caseInput({ case_id: 'RRC-US-PARTIAL-COST' }));
  const link = loop.registerReviewQuestion(caseRec.case_id, {
    link_id: 'RRL-US-PARTIAL-COST', desk_candidate_ref: 'RLC-US-PARTIAL-COST',
    desk_evidence_ref: 'REVIEW_LOOP_WEEK_V1:PARTIAL-COST', desk_evidence_hash: 'f'.repeat(64),
    research_question_ref: 'RQ-US-PARTIAL-COST', recorded_at: '2026-10-24T20:10:00Z',
  });
  const originals = {
    verifyFreeze: experiments.verifyFreeze, experimentHead: experiments.experimentHead, artifactFor: experiments.artifactFor,
  };
  experiments.verifyFreeze = () => ({ ok: true, spec: {
    freeze_hash: 'freeze-partial', market: 'US_EQUITY', champion_ref: 'US_V5_ETF_3000USD',
    hypothesis_ref: 'RQ-US-PARTIAL-COST',
  } });
  experiments.experimentHead = () => ({
    status: 'RESULT_LOCKED', backtest_artifact_hash: 'artifact-partial', result_artifact_hash: 'artifact-partial',
    result: { verdict: 'INCONCLUSIVE', sample_evidence_ref: 'artifact-partial' },
  });
  experiments.artifactFor = () => ({
    result_hash: 'artifact-partial', market: 'US_EQUITY', nav_semantics: 'NET_OF_SIGNED_MODEL_COSTS',
    cost_scope: 'SIGNED_MODEL_ONLY_NOT_COMPLETE_ACTUAL_COSTS',
    native_identity: { strategy_ref: 'US_V5_ETF_3000USD' },
    cost_breakdown: {
      state: 'PARTIAL', completeness: 'PARTIAL', scope: 'SIGNED_MODEL_ONLY_NOT_COMPLETE_ACTUAL_COSTS',
      total: 1, champion_total: 1, challenger_total: 1, missing_components: ['REGULATORY_FEES'],
    },
    decision_funnel: { state: 'COMPLETE', scanned: 1, signaled: 0, intended: 0, filled: 0, rejected: 0 },
    runtime_path: { state: 'COMPLETE', path_hash: 'path' },
    mechanical_adjudication: { verdict: 'INCONCLUSIVE' },
  });
  try {
    assert.throws(() => loop.linkLockedResult(link.link_id, 'EXP-US-PARTIAL-COST'), /LOOP_US_NET_COST_INCOMPLETE/);
  } finally {
    Object.assign(experiments, originals);
  }
});

test('四类自审计对象只记录系统质量，不产生生产动作', () => {
  assert.throws(() => selfAudit.recordDivergence({
    baseline_ref: 'BASELINE-NOT-FOUND', source_run_ref: 'A', target_run_ref: 'B', field_path: '$.x',
    source_value: 1, target_value: 2, difference_state: 'CONFIRMED', cause_state: 'UNKNOWN', status: 'OPEN',
  }), /DIVERGENCE_BASELINE_NOT_FOUND/);
  const div = selfAudit.recordDivergence({
    divergence_id: 'DIV-TEST', baseline_ref: 'BASELINE-US-V5-TEST', source_run_ref: 'RUN-CURRENT',
    target_run_ref: 'RUN-REPLAY', field_path: '$.decision.funnel', source_value: 'A', target_value: 'B',
    difference_state: 'CONFIRMED', cause_state: 'UNKNOWN', status: 'OPEN', evidence_refs: ['E1'],
    detected_at: '2026-10-24T20:04:00Z',
  });
  assert.equal(div.status, 'OPEN');
  const incident = selfAudit.recordIncident({
    incident_id: 'INC-TEST', category: 'DATA', scope: 'US_V5', symptom: 'snapshot missing',
    detection: 'adapter validation', recovery_state: 'NOT_RECOVERED', status: 'OPEN',
    evidence_refs: ['E2'], opened_at: '2026-10-24T20:05:00Z',
  });
  assert.equal(incident.root_cause, null);
  const anomaly = selfAudit.watchAnomaly({
    anomaly_id: 'ANOM-TEST', signal: 'parity unknown', first_seen: '2026-10-24T20:06:00Z',
    evidence_refs: ['E3'], owner: 'RESEARCH', next_checkpoint: null, status: 'OPEN',
    recorded_at: '2026-10-24T20:06:00Z',
  });
  assert.equal(anomaly.status, 'OPEN');
});

test('自审计无调用方时间戳也业务幂等；异常状态只能单向收敛', () => {
  loop.openCase(caseInput({ case_id: 'RRC-AUDIT-IDEMPOTENT' }));
  const divInput = {
    baseline_ref: 'BASELINE-US-V5-TEST', source_run_ref: 'RUN-A', target_run_ref: 'RUN-B',
    field_path: '$.parity', source_value: 'MATCHED', target_value: 'UNKNOWN',
    difference_state: 'CONFIRMED', cause_state: 'UNKNOWN', status: 'OPEN', evidence_refs: [],
  };
  const div = selfAudit.recordDivergence(divInput);
  assert.equal(selfAudit.recordDivergence(divInput).replayHit, true);
  const anomalyInput = {
    signal: 'native parity missing', first_seen: '2026-10-24T21:00:00Z', owner: 'RESEARCH',
    status: 'OPEN', evidence_refs: [],
  };
  assert.throws(() => selfAudit.watchAnomaly({
    ...anomalyInput, anomaly_id: 'ANOM-BAD-START', status: 'RESOLVED', resolution_ref: 'E', resolved_at: '2026-10-24T22:00:00Z',
  }), /ANOMALY_MUST_START_OPEN/);
  const anomaly = selfAudit.watchAnomaly(anomalyInput);
  assert.equal(selfAudit.watchAnomaly(anomalyInput).replayHit, true);
  assert.throws(() => selfAudit.watchAnomaly({
    ...anomalyInput, anomaly_id: anomaly.anomaly_id, status: 'RESOLVED', resolution_ref: 'E', resolved_at: '2026-10-24T22:00:00Z',
  }), /ANOMALY_BAD_TRANSITION/);
  selfAudit.watchAnomaly({ ...anomalyInput, anomaly_id: anomaly.anomaly_id, status: 'OBSERVING' });
  assert.throws(() => selfAudit.watchAnomaly({
    ...anomalyInput, anomaly_id: anomaly.anomaly_id, status: 'OPEN', next_checkpoint: '2026-10-25T21:00:00Z',
  }), /ANOMALY_BAD_TRANSITION/);
  assert.ok(div.record_hash);
});

test('V8.1 产品里程碑不由工程状态推断，并按 M0→M3、交付环境与撤销严格收敛', () => {
  const initial = loop.readModel().product_delivery.cases.find((row) => row.case_ref === 'RRC-CN-LOCKED-TEST');
  assert.deepEqual(initial.stages.slice(0, 4).map((row) => row.state),
    ['NOT_VERIFIED', 'NOT_VERIFIED', 'NOT_VERIFIED', 'NOT_VERIFIED']);
  assert.deepEqual(initial.stages.slice(4).map((row) => row.state), ['OUT_OF_SCOPE', 'OUT_OF_SCOPE']);
  assert.deepEqual(loop.readModel().product_delivery.acceptance_amendment_refs,
    [
      'docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_1.md',
      'docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_2.md',
      'docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_3.md',
    ]);
  assert.equal(loop.readModel().product_delivery.evidence_rule, 'REGISTERED_CASE_BOUND_TYPED_FILE_SHA256_EVIDENCE_ONLY');
  assert.equal(loop.readModel().product_delivery.completion_authority, 'CONFIGURED');

  assert.throws(() => loop.recordProductMilestone(milestoneInput('M1')),
    /PRODUCT_MILESTONE_UPSTREAM_NOT_VERIFIED:M0/);
  assert.throws(() => loop.recordProductMilestone(milestoneInput('M0', { user_evidence_refs: [] })),
    /PRODUCT_MILESTONE_USER_EVIDENCE_REQUIRED/);
  assert.throws(() => loop.recordProductMilestone(milestoneInput('M0', {
    evidence_id: 'PME-PRODUCT-M0-TARGET-NO-RELEASE', delivery_environment: 'TARGET_DELIVERED', release_evidence_ref: null,
  })), /PRODUCT_MILESTONE_RELEASE_EVIDENCE_REQUIRED/);
  assert.throws(() => loop.recordProductMilestone(milestoneInput('M0', {
    evidence_id: 'PME-PRODUCT-M0-UNREGISTERED', user_evidence_refs: ['PE-NOT-REGISTERED'],
  })), /PRODUCT_EVIDENCE_NOT_REGISTERED:PE-NOT-REGISTERED/);

  const authorityInput = milestoneInput('M0', { evidence_id: 'PME-PRODUCT-M0-NO-AUTHORITY' });
  delete process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  assert.throws(() => loop.recordProductMilestone(authorityInput), /PRODUCT_MILESTONE_AUTHORITY_NOT_CONFIGURED/);
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = PRODUCT_AUTHORITY;
  assert.throws(() => loop.recordProductMilestone({ ...authorityInput, recorded_by: 'IMPLEMENTER' }),
    /PRODUCT_MILESTONE_RECORDED_BY_NOT_AUTHORIZED/);

  const driftEvidence = productEvidence('M0', 'M0_PREPARATION', 'DRIFT');
  fs.appendFileSync(driftEvidence.source_ref, '{"drift":true}\n');
  assert.throws(() => loop.recordProductMilestone(milestoneInput('M0', {
    evidence_id: 'PME-PRODUCT-M0-DRIFT', preparation_evidence_refs: [driftEvidence.evidence_id],
  })), /PRODUCT_EVIDENCE_SOURCE_DRIFT/);

  const nonActualDir = path.join(process.env.QRP_DATA_DIR, 'fixture-evidence');
  fs.mkdirSync(nonActualDir, { recursive: true });
  const nonActualFile = path.join(nonActualDir, 'user.json');
  fs.writeFileSync(nonActualFile, '{"not":"actual"}\n');
  assert.throws(() => loop.registerProductEvidence({
    case_ref: 'RRC-CN-LOCKED-TEST', kind: 'USER_TASK', source_ref: nonActualFile,
    object_ref: 'NON_ACTUAL', observed_at: '2026-10-24T20:20:00Z', registered_by: PRODUCT_AUTHORITY,
  }), /PRODUCT_EVIDENCE_NON_ACTUAL_SOURCE/);

  const crossCaseFile = path.join(process.env.QRP_DATA_DIR, 'product-evidence-files', 'cross-case.json');
  fs.writeFileSync(crossCaseFile, '{"case":"US"}\n');
  const crossCase = loop.registerProductEvidence({
    evidence_id: 'PE-CROSS-CASE', case_ref: 'RRC-US-V5-TEST', kind: 'M0_PREPARATION', source_ref: crossCaseFile,
    object_ref: 'T01:US', observed_at: '2026-10-24T20:20:00Z', registered_by: PRODUCT_AUTHORITY,
  });
  assert.throws(() => loop.recordProductMilestone(milestoneInput('M0', {
    evidence_id: 'PME-PRODUCT-M0-CROSS-CASE', preparation_evidence_refs: [crossCase.evidence_id],
  })), /PRODUCT_EVIDENCE_CASE_MISMATCH/);
  const wrongKind = milestoneInput('M0').user_evidence_refs[0];
  assert.throws(() => loop.recordProductMilestone(milestoneInput('M0', {
    evidence_id: 'PME-PRODUCT-M0-WRONG-KIND', preparation_evidence_refs: [wrongKind],
  })), /PRODUCT_MILESTONE_M0_PREPARATION_EVIDENCE_REQUIRED:M0_PREPARATION/);

  const m0Input = milestoneInput('M0');
  const m0 = loop.recordProductMilestone(m0Input);
  assert.equal(loop.recordProductMilestone(m0Input).replayHit, true);
  assert.throws(() => loop.recordProductMilestone({ ...m0Input, user_result: 'DRIFTED' }),
    /PRODUCT_MILESTONE_EVIDENCE_ID_CONFLICT/);

  assert.throws(() => loop.recordProductMilestone(milestoneInput('M1', { runtime_evidence_refs: [] })),
    /PRODUCT_MILESTONE_M1_RUNTIME_EVIDENCE_REQUIRED/);
  const m1 = loop.recordProductMilestone(milestoneInput('M1'));

  assert.throws(() => loop.recordProductMilestone(milestoneInput('M2')),
    /PRODUCT_MILESTONE_LOCKED_RESULT_REQUIRED/);
  const linked = loop.listLinks().find((row) => row.link_id === 'RRL-CN-LOCKED-TEST');
  const m2 = loop.recordProductMilestone(milestoneInput('M2', { result_ref: linked.result_ref }));
  assert.ok(m2.stage_hash);

  assert.throws(() => loop.recordProductMilestone(milestoneInput('M3', {
    result_ref: linked.result_ref, desk_outcome_ref: null, desk_outcome_evidence_ref: null,
  })), /PRODUCT_MILESTONE_M3_DESK_OUTCOME_REQUIRED/);
  loop.recordProductMilestone(milestoneInput('M3', {
    result_ref: linked.result_ref, delivery_environment: 'TARGET_DELIVERED',
  }));

  let stages = loop.readModel().product_delivery.cases.find((row) => row.case_ref === 'RRC-CN-LOCKED-TEST').stages;
  assert.deepEqual(stages.slice(0, 4).map((row) => row.state),
    ['CONTROLLED_VERIFIED', 'CONTROLLED_VERIFIED', 'CONTROLLED_VERIFIED', 'TARGET_DELIVERED']);
  assert.ok(stages.every((row) => row.evidence === null || row.evidence.production_effect === 'NONE'));
  assert.ok(stages.filter((row) => row.evidence).every((row) =>
    loop.PRODUCT_ACCEPTANCE_AMENDMENT_REFS.every((ref) => row.evidence.acceptance_amendment_refs.includes(ref))));

  loop.recordProductMilestone({
    evidence_id: 'PME-PRODUCT-M1-REVOKED', case_ref: 'RRC-CN-LOCKED-TEST', stage: 'M1', decision: 'REVOKED',
    revokes_ref: m1.evidence_id, defect_ref: 'DEFECT_ESCAPE:PRODUCT_M1:001',
    revocation_reason: 'USER_PATH_EVIDENCE_INVALIDATED', recorded_by: 'INDEPENDENT_PRODUCT_REVIEWER',
    recorded_at: '2026-10-24T23:30:00Z',
  });
  stages = loop.readModel().product_delivery.cases.find((row) => row.case_ref === 'RRC-CN-LOCKED-TEST').stages;
  assert.deepEqual(stages.slice(0, 4).map((row) => row.state),
    ['CONTROLLED_VERIFIED', 'REVOKED', 'INVALIDATED_BY_UPSTREAM', 'INVALIDATED_BY_UPSTREAM']);
  assert.throws(() => loop.recordProductMilestone(milestoneInput('M3', {
    evidence_id: 'PME-PRODUCT-M3-AFTER-REVOKE', evidence_set: 'AFTER-REVOKE', result_ref: linked.result_ref,
    desk_outcome_ref: 'REVIEW_LOOP_WEEK_V1:RESULT:DONT:002',
  })), /PRODUCT_MILESTONE_UPSTREAM_NOT_VERIFIED:M2/);

  loop.recordProductMilestone(milestoneInput('M1', {
    evidence_id: 'PME-PRODUCT-M1-REVALIDATED', evidence_set: 'REVALIDATED',
  }));
  stages = loop.readModel().product_delivery.cases.find((row) => row.case_ref === 'RRC-CN-LOCKED-TEST').stages;
  assert.deepEqual(stages.slice(0, 4).map((row) => row.state),
    ['CONTROLLED_VERIFIED', 'CONTROLLED_VERIFIED', 'INVALIDATED_BY_UPSTREAM', 'INVALIDATED_BY_UPSTREAM']);
});

test('Research 页面明确展示 V8.1 阶段真相且不提供普通写入口', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'apps', 'research-web', 'index.html'), 'utf8');
  for (const text of ['V8.1 产品里程碑真相', '冻结验收', '版本化修订', '实际证据门禁', '完成权威',
    'NOT_VERIFIED', '实际入口', '交付环境', '用户结果', '限制/异常']) {
    assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(html, /recordProductMilestone|\/api\/product-milestone/);
});
