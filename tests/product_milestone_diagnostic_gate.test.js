'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const loop = require('../services/runtime-research-loop');
const diagnostics = require('../services/strategy-diagnostics');

const CASE = 'RRC-US-V5-3000-V8-1-M0';

function openCanonicalCase() {
  return loop.openCase({
    case_id: CASE, strategy_ref: 'US_V5_ETF_3000USD', market: 'US_EQUITY',
    runtime_lane: {
      source_ref: 'SMARTFLOW:US_V5_SCAN_RECORD_V2', source_hash: 'a'.repeat(64),
      version_ref: 'US_V5@2382c2d1', as_of: '2026-10-23T20:00:00Z', mode: 'PAPER', real_order: 0,
    },
    baseline: {
      baseline_id: 'BASELINE-GATE-TEST', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY',
      version_ref: 'US_V5_ETF_6000USD@frozen-old', source_ref: 'SMARTFLOW:SIGNED_RESEARCH:US_V5_ETF_6000USD',
      source_hash: 'b'.repeat(64), expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
      frozen_at: '2026-10-24T20:01:00Z',
    },
    cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
    data_quality: {
      status: 'VALID', as_of: '2026-10-23', known_at: '2026-10-24T20:00:00Z',
      source_refs: ['SMARTFLOW:US_V5_SCAN_RECORD_V2'], freshness: { state: 'CURRENT', age_seconds: 0 },
    },
    isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
    opened_at: '2026-10-24T20:02:00Z',
  });
}

function evidence(stage, kind) {
  const dir = path.join(process.env.QRP_DATA_DIR, 'gate-evidence-files');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stage}-${kind}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ stage, kind })}\n`);
  return loop.registerProductEvidence({
    evidence_id: `PE-GATE-${stage}-${kind}`, case_ref: CASE, kind, source_ref: file,
    object_ref: `ACTUAL:${stage}:${kind}`, observed_at: '2026-10-25T04:40:00Z', registered_by: AUTHORITY,
  }).evidence_id;
}

function input(stage, extra = {}) {
  return {
    evidence_id: `PME-GATE-${stage}`, case_ref: CASE, stage, decision: 'PASS', evidence_mode: 'ACTUAL_USER_TASK',
    delivery_environment: 'CONTROLLED_PENDING_RELEASE', actual_entrypoint: 'RESEARCH:strategy-detail',
    new_capability: `CAPABILITY:${stage}`, supported_scope: 'US_V5_ETF_3000USD:PAPER:2026-10-08..2026-10-23',
    user_operation: `USER_TASK:${stage}`, user_result: `USER_RESULT:${stage}`,
    exception_behavior: 'MISSING_SHOWN_AS_MISSING',
    user_evidence_refs: [evidence(stage, 'USER_TASK')], technical_evidence_refs: [evidence(stage, 'TECHNICAL_CHECK')],
    preparation_evidence_refs: stage === 'M0' ? [evidence(stage, 'M0_PREPARATION')] : [],
    runtime_evidence_refs: stage === 'M1' ? [
      evidence(stage, 'RUNTIME_NATIVE_REPLAY'), evidence(stage, 'ACCOUNT_RECONCILIATION'), evidence(stage, 'DECISION_FUNNEL'),
    ] : [],
    exception_evidence_refs: stage === 'M1' ? [evidence(stage, 'EXCEPTION_SCENARIO')] : [],
    stress_evidence_refs: [], comparison_evidence_refs: [], round_trip_evidence_refs: [],
    result_ref: null, desk_outcome_ref: null, desk_outcome_evidence_ref: null, release_evidence_ref: null,
    recorded_by: AUTHORITY, recorded_at: '2026-10-25T04:45:00Z', ...extra,
  };
}

test('有 canonical 诊断生产者的 case：M1 PASS 须现场通过诊断，已登记的非空文件不能替代', () => {
  openCanonicalCase();
  loop.recordProductMilestone(input('M0'));

  const original = diagnostics.readFreshDiagnostic;
  try {
    for (const [state, reason] of [['MISSING', 'US_V5_M1_INPUT_PACKAGE_MISSING'], ['INVALID', 'US_V5_M1_SCAN_RECORD_HASH_MISMATCH']]) {
      diagnostics.readFreshDiagnostic = () => ({ state, reason_code: reason });
      assert.throws(() => loop.recordProductMilestone(input('M1')),
        new RegExp(`PRODUCT_MILESTONE_M1_DIAGNOSTIC_NOT_VERIFIED:${state}:${reason}`));
    }
    assert.equal(loop.readModel().product_delivery.cases.find((row) => row.case_ref === CASE)
      .stages.find((row) => row.stage === 'M1').state, 'NOT_VERIFIED');
  } finally { diagnostics.readFreshDiagnostic = original; }

  const recorded = loop.recordProductMilestone(input('M1'));
  assert.equal(recorded.decision, 'PASS');
  assert.equal(loop.readModel().product_delivery.cases.find((row) => row.case_ref === CASE)
    .stages.find((row) => row.stage === 'M1').state, 'CONTROLLED_VERIFIED');
});
