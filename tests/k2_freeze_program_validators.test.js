'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./_k2_freeze_fixture');

const prog = require('../services/k2-freeze-program');

/**
 * AQ-37 (AUTONOMOUS_RESEARCH_QUEUE_V1, frozen rev 4 sha 52418471; RF1118 r2 §2.1): V1-V14 each have a seeded counter-example that
 * (a) is refused by exactly that validator with the named reason code, and (b) passes when only that validator is switched off
 * (the mutant), so no other validator covers for it. Red first: the service does not exist yet.
 */
const { baseDraft, baseCtx, failing, codesOf, clone } = fx;

function flow(draft, ctxOver = {}, { at = fx.REGISTERED_AT, receiptsPatch = null, finalOver = {} } = {}) {
  const ctx = baseCtx(ctxOver);
  const p = prog.prepare(draft, ctx);
  if (p.state !== 'WAITING_EXTERNAL') return { stage: 'prepare', res: p, ctx };
  const receipts = fx.registerAt(p, at);
  const r2 = receiptsPatch ? receiptsPatch(clone(receipts)) : receipts;
  const ctx2 = { ...ctx, now: fx.NOW_FREEZE, ledgerRows: fx.ledgerRows(), ...finalOver };
  return { stage: 'finalize', res: prog.finalize(draft, r2, ctx2, p.prepared), ctx: ctx2, prepared: p };
}

test('baseline: a clean synthetic draft passes all of V1-V8, V10, V11, V14 at prepare and waits for the TRL receipt; 14 results, none REFUSED', () => {
  const res = prog.prepare(baseDraft(), baseCtx());
  assert.equal(res.state, 'WAITING_EXTERNAL');
  assert.equal(res.code, 'TRL_RECEIPT');
  assert.deepEqual(res.results.map((r) => r.v), ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14']);
  assert.deepEqual(failing(res), []);
  assert.deepEqual(res.results.filter((r) => r.state === 'PENDING').map((r) => r.v), ['V9', 'V12', 'V13']);
  assert.match(res.k2_sha256, /^[0-9a-f]{64}$/);
  assert.equal(res.trl_request.schema, 'TRIAL_REGISTRATION_REQUEST_V1');
  assert.equal(res.trl_request.specs.length, 2);
  assert.ok(res.trl_request.specs.every((s) => s.k2_sha256 === res.k2_sha256));
});

const { armsOf } = fx;

/** [validator, label, draft mutation, ctx mutation, expected code (prefix match)] — prepare-stage counter-examples. */
const PREPARE_CASES = [
  ['V1', 'section0 missing', (d) => { delete d.section0; }, null, 'PREREG_SCHEMA_MISSING'],
  ['V1', 'unknown top-level key', (d) => { d.free_text_verdict_zh = '做'; }, null, 'PREREG_SCHEMA_EXTRA_KEY'],
  ['V1', 'a desk item is missing (REVIEW_LOOP_ACCEPTANCE §5.7 item 8)', (d) => { delete d.desk_items.paper_stop_zh; }, null, 'PREREG_SCHEMA_DESK_ITEM_MISSING'],
  ['V1', 'a deviation code is requested by the draft', (d) => { d.deviation_codes = ['PRE_NO_TRIAL_ID_IN_K2']; }, null, 'PREREG_SCHEMA_DEVIATION_NOT_ALLOWED'],
  ['V1', 'free text that forges a token (backtick / TRL id / label)', (d) => { d.section0.failure_mode_zh = '见 `CF:qrp:x#y` 与 TRL-0123456789abcdef'; }, null, 'PREREG_SCHEMA_TEXT_FORBIDDEN'],
  ['V2', 'unknown decision-table template', (d) => { d.decision_table.template_id = 'DT-FREE-V1'; }, null, 'PREREG_DECISION_TABLE_UNKNOWN_TEMPLATE'],
  ['V2', 'alpha is not the fixed 0.05 (the drafter never picks error rates)', (d) => { d.decision_table.params.alpha = 0.1; }, null, 'PREREG_DECISION_TABLE_PARAM_FIXED'],
  ['V2', 'ci_level is not the fixed 0.95', (d) => { d.decision_table.params.ci_level = 0.9; }, null, 'PREREG_DECISION_TABLE_PARAM_FIXED'],
  ['V2', 'power_target is not the fixed 0.8', (d) => { d.decision_table.params.power_target = 0.9; }, null, 'PREREG_DECISION_TABLE_PARAM_FIXED'],
  ['V2', 'non-inferiority margin: the cited rule has no registered margin', fx.niDraftMut(0.2, 'CN_A.RULE.UNREGISTERED'), null, 'PREREG_DECISION_TABLE_MARGIN_NOT_REGISTERED'],
  ['V2', 'non-inferiority margin differs from the registered rule', fx.niDraftMut(0.3), null, 'PREREG_DECISION_TABLE_MARGIN_MISMATCH'],
  ['V2', 'free text in the table', (d) => { d.decision_table.rules_zh = '看着办'; }, null, 'PREREG_DECISION_TABLE_FREE_TEXT'],
  ['V3', 'n_required differs from the power tool (31 vs 32)', (d) => { d.power.n_required = 31; }, null, 'PREREG_POWER_MISMATCH'],
  ['V3', 'min_sample_n is not copied exactly from the power outputs', (d) => { d.decision_table.params.min_sample_n = 33; }, null, 'PREREG_POWER_MISMATCH'],
  ['V3', 'min_effect_sd is not copied exactly from the power outputs', (d) => { d.decision_table.params.min_effect_sd = 0.6; }, null, 'PREREG_POWER_MISMATCH'],
  ['V3', 'the power block alpha differs from the power outputs', (d) => { d.power.alpha = 0.1; }, null, 'PREREG_POWER_MISMATCH'],
  ['V3', 'no power outputs in the bundle (unknown, not zero)', () => {}, { powerOutputs: null }, 'PREREG_POWER_OUTPUTS_MISSING'],
  ['V3', 'power outputs that are not the tool\'s own', () => {}, { powerOutputs: { effect_size_sd: 0.5, alpha: 0.05, power_target: 0.8, n_required: 31 } }, 'PREREG_POWER_MISMATCH'],
  ['V3', 'a number in the criteria text is not a tool number', (d) => { d.desk_items.decision_criteria_zh = d.desk_items.decision_criteria_zh.replace('32', '20'); }, null, 'PREREG_POWER_MISMATCH'],
  ['V4', 'mechanism routed ATTACH_TO_SHADOW (forward shadow running)', (d) => { d.section0.mechanism_ids = [fx.MECH_SHADOW]; }, null, 'PREREG_ROUTED_ATTACH_TO_SHADOW'],
  ['V4', 'mechanism id not registered', (d) => { d.section0.mechanism_ids = ['SEL.NOT.REGISTERED']; }, null, 'MECHANISM_ID_NOT_REGISTERED'],
  ['V4', 'US mechanism already live (QUARTERLY_ABLATION)', (d) => { d.market = 'US_EQUITY'; d.section0.mechanism_ids = [fx.MECH_LIVE]; d.authored_by.host = 'HK'; },
    { receipt: fx.receipt('c'.repeat(64), { host: 'HK' }) }, 'PREREG_ROUTED_QUARTERLY_ABLATION'],
  ['V5', 'G-CAUSAL N/A code outside the five classes', (d) => { d.causality = { not_applicable_code: 'NOPE' }; }, null, 'CAUSAL_SCOPE_CODE_INVALID'],
  ['V5', 'functions declared, evidence missing', (d) => { d.causality = { functions: ['qrp:services/x/index.js#f'] }; }, null, 'CAUSAL_EVIDENCE_MISSING'],
  ['V6', 'dataset pinned to a registry sha QRP does not have', (d) => { d.data_inputs[0].registry_sha256 = 'd'.repeat(64); }, null, 'PARITY_PIN_MISMATCH'],
  ['V6', 'dataset not in the registry', (d) => { d.data_inputs[0].dataset_id = 'NOT_A_DATASET'; }, { inventory: new Set(['NOT_A_DATASET']) }, 'PARITY_DATASET_UNREGISTERED'],
  ['V7', 'a factor id the library does not have', (d) => { d.arms[1].rule_config.components[0] = { kind: 'FACTOR', id: 'CN_A.INVENTED.NEW' }; }, null, 'PREREG_FORMULA_FORBIDDEN'],
  ['V7', 'a parameter that is an expression', (d) => { d.arms[1].rule_config.params.cap = 'close/open-1'; }, null, 'PREREG_FORMULA_FORBIDDEN'],
  ['V8', 'dataset not on this host', () => {}, { inventory: new Set() }, 'PREREG_DATA_NOT_LOCAL'],
  ['V8', 'new data fetch requested', (d) => { d.scope.new_data_fetch = true; }, null, 'PREREG_DATA_NEW_FETCH'],
  ['V8', 'first read of an UNSEEN segment (RF1118 P3)', () => {}, (d) => ({ marks: [{ schema: 'DATA_SEGMENT_MARK_V1', mark_id: 'SEG-1', family_id: d.family_id, market: 'CN_A', from: '2025-06-01', to: '2025-12-31', label: 'UNSEEN',
    seen_kind: null, shadow_ref: null, registered_at: '2026-11-01T00:00:00+08:00' }] }), 'PREREG_DATA_UNSEEN_FIRST_READ'],
  ['V10', 'agent had network access', () => {}, { receipt: fx.receipt('c'.repeat(64), { network: { egress: 'ANY', gateway_socket: true } }) }, 'PREREG_ISOLATION_NETWORK'],
  ['V10', 'no run receipt', () => {}, { receipt: null }, 'PREREG_ISOLATION_RECEIPT_MISSING'],
  ['V10', 'canary readable', () => {}, { receipt: fx.receipt('c'.repeat(64), { canary: { self_test: 'PASS', probes: [{ label: 'sealed-like-1', readable: true }] } }) }, 'PREREG_ISOLATION_CANARY'],
  ['V10', 'bundle not from the deterministic builder', () => {}, { bundle: { sha256: 'c'.repeat(64), builder: 'HAND_MADE' } }, 'PREREG_ISOLATION_BUNDLE'],
  ['V11', 'CN_A drafted on the HK host', (d) => { d.authored_by.host = 'HK'; }, { receipt: fx.receipt('c'.repeat(64), { host: 'HK' }) }, 'PREREG_SCOPE_HOST_MISMATCH'],
  ['V11', 'live-signature topic that is not research-only', (d) => { d.scope.live_class = 'NEEDS_SIGNATURE'; d.scope.research_only = false; }, null, 'PREREG_SCOPE_LIVE_REQUIRES_SIGNATURE'],
  ['V11', 'more than 20 arms that count in N', (d) => { d.arms = armsOf(21); d.comparison.baseline_label = 'BASE'; }, null, 'PREREG_CAP_ARMS'],
  ['V12', 'draft id is not an artifact-safe id', (d) => { d.draft_id = 'bad id!'; }, null, 'PREREG_ARTIFACT_ID'],
  ['V12', 'clock without +08:00', () => {}, { now: '2026-11-24T02:00:00Z' }, 'PREREG_ARTIFACT_CLOCK'],
  ['V14', 'prompt/schema/model triple not admitted', () => {}, { admissions: [] }, 'PREREG_PROMPT_NOT_ADMITTED'],
  ['V14', 'pro model without a quality-gate record', (d) => { d.authored_by.model = 'deepseek-v4-pro'; }, null, 'PREREG_MODEL_NOT_ADMITTED'],
  ['V14', 'schema sha is not the K2_DRAFT_V1 pin', (d) => { d.authored_by.schema_sha256 = '1'.repeat(64); }, null, 'PREREG_PROMPT_NOT_ADMITTED'],
  ['V10', 'receipt has no isolation block (the core receipt alone is not an isolation proof)', () => {}, { receipt: { receipt: 'RUN_RECEIPT_V1', mounts: [] } }, 'PREREG_ISOLATION_UNKNOWN'],
  ['V1', 'human-authored claim without an author identity', (d) => { d.authored_by = { kind: 'HUMAN_SESSION', session_ref: 'unknown' }; }, null, 'PREREG_SCHEMA_AUTHOR_IDENTITY_MISSING'],
];

for (const [v, label, mutate, ctxOver, code] of PREPARE_CASES) {
  test(`AQ-37 ${v} counter-example: ${label} -> ${code}, only ${v} refuses, and the ${v} mutant lets it through`, () => {
    const d = baseDraft();
    mutate(d);
    const co = (typeof ctxOver === 'function' ? ctxOver(d) : ctxOver) || {};
    const res = prog.prepare(d, baseCtx(co));
    assert.equal(res.state, 'REFUSED', JSON.stringify(res.results.filter((r) => r.state === 'REFUSED')));
    assert.deepEqual(failing(res), [v], `failing: ${failing(res)} codes: ${res.codes}`);
    assert.ok(codesOf(res, v).some((c) => c === code || c.startsWith(`${code}:`)), `${code} not in ${codesOf(res, v)}`);
    // mutation pin: switch the validator off and the same input is no longer refused by it
    const off = prog.prepare(d, baseCtx({ ...co, testDisableValidators: [v] }));
    assert.ok(!failing(off).includes(v), `${v} mutant still refused`);
  });
}

test('AQ-37 every refusal carries reason codes; a refusal never carries a freeze artifact; unknown is not missing is not not-applicable', () => {
  const d = baseDraft();
  delete d.section0;
  const res = prog.prepare(d, baseCtx());
  assert.equal(res.state, 'REFUSED');
  assert.ok(res.codes.length > 0 && res.codes.every((c) => /^[A-Z][A-Z0-9_]+(:.*)?$/.test(c)));
  assert.equal(res.k2_sha256, undefined);
  // human-authored drafts: V10 and V14 are explicitly NOT_APPLICABLE (a frozen reason), never silently PASS
  const h = baseDraft({ authored_by: { kind: 'HUMAN_SESSION', session_ref: 'research-session-1' } });
  const hr = prog.prepare(h, baseCtx({ receipt: null, admissions: [] }));
  assert.equal(hr.state, 'WAITING_EXTERNAL');
  assert.deepEqual(hr.results.filter((r) => r.state === 'NOT_APPLICABLE').map((r) => [r.v, r.reason]), [['V10', 'HUMAN_AUTHORED'], ['V14', 'HUMAN_AUTHORED']]);
});

test('V5 positive and negative with function-level evidence (a harness run at the pinned code sha)', () => {
  const gate = require('../services/causality-gate');
  const CODE = 'c'.repeat(40);
  const FN = 'qrp:services/x/index.js#f';
  const fn = (patch = {}) => ({ function_id: FN, path: 'services/x/index.js', entry: 'f', role: 'FILL', runner: 'node', file_sha256: 'f'.repeat(64),
    inputs: [{ name: 'bars', file: 'bars.json', file_sha256: 'b'.repeat(64), rows: 60, availability: { rule: 'DATE_AT', field: 'date', time: '15:00', tz: '+08:00' } }],
    cut_points: ['2025-01-10T07:00:00.000Z'], t_c1: 'PASS', t_c2: 'PASS', t_c3: 'PASS', fail_reasons: {}, mismatches: [], ...patch });
  const evidence = (patch = {}) => {
    const doc = { schema: 'CAUSALITY_EVIDENCE_V1', contract_ref: gate.CONTRACT_REF, study_ref: 'PRIOR_RUN', k2_sha256: 'a'.repeat(64), code_repo: 'qrp', code_sha: CODE, harness_version: '1.0.0',
      harness_sha256: 'a'.repeat(64), seed: gate.SEED, cut_points_per_function: gate.CUT_POINTS, manifest_sha256: 'd'.repeat(64), functions: [fn()], unknown: {},
      production_effect: 'NONE', registered_by: 'TEST', registered_at: '2026-11-23T14:00:00Z', ...patch };
    doc.record_hash = gate.recordHash(doc);
    return Buffer.from(JSON.stringify(doc));
  };
  const withEvidence = (bytes, pinned = { qrp: CODE }) => {
    const d = baseDraft({ causality: { functions: [FN], evidence_sha256: fx.sha(bytes) } });
    return prog.prepare(d, baseCtx({ evidenceBytes: (s) => (s === fx.sha(bytes) ? bytes : null), pinnedCodeShas: pinned }));
  };
  assert.equal(withEvidence(evidence()).state, 'WAITING_EXTERNAL');
  const bad = withEvidence(evidence({ functions: [fn({ t_c2: 'FAIL', fail_reasons: { t_c2: 'LEAK' } })] }));
  assert.deepEqual(failing(bad), ['V5']);
  assert.ok(codesOf(bad, 'V5').some((c) => c.startsWith('CAUSAL_FUNCTION_NOT_PASS')));
  const unpinned = withEvidence(evidence(), { qrp: 'd'.repeat(40) });
  assert.deepEqual(failing(unpinned), ['V5']);
  assert.ok(codesOf(unpinned, 'V5').some((c) => c.startsWith('CAUSAL_CODE_SHA_NOT_PINNED')));
});

/** Finalize-stage counter-examples: V9 (TRL rows before the freeze), V12 (artifacts), V13 (queue line). */
test('AQ-37 V9 counter-examples: an arm without a PREREGISTERED row; a row registered after the freeze time', () => {
  const missing = flow(baseDraft(), {}, { finalOver: {} , receiptsPatch: (r) => r });
  // drop one arm's row from the ledger snapshot handed to the program
  const d = baseDraft();
  const ctx = baseCtx();
  const p = prog.prepare(d, ctx);
  const receipts = fx.registerAt(p);
  const snapshot = fx.ledgerRows().filter((r) => !(r.study_ref === d.study_ref && r.config_label === 'ARM_A'));
  const res = prog.finalize(d, receipts, { ...ctx, now: fx.NOW_FREEZE, ledgerRows: snapshot }, p.prepared);
  assert.equal(res.state, 'REFUSED');
  assert.deepEqual(failing(res), ['V9']);
  assert.ok(codesOf(res, 'V9').some((c) => c.startsWith('TRIAL_LEDGER_PRE_NOT_REGISTERED')), codesOf(res, 'V9'));
  // a ledger row whose k2_sha256 is not this K2's (registered against another text) is refused by the G-TRIAL-PRE check
  const other = fx.ledgerRows().map((r) => (r.study_ref === d.study_ref ? { ...r, k2_sha256: 'f'.repeat(64) } : r));
  const wrongSha = prog.finalize(d, receipts, { ...ctx, now: fx.NOW_FREEZE, ledgerRows: other }, p.prepared);
  assert.deepEqual(failing(wrongSha), ['V9']);
  assert.ok(codesOf(wrongSha, 'V9').some((c) => c.startsWith('TRIAL_LEDGER_PRE_K2_SHA256_MISMATCH')), codesOf(wrongSha, 'V9'));
  assert.equal(missing.res.state, 'FROZEN');
  const late = flow(baseDraft(), {}, { at: '2026-11-24T10:06:00+08:00' });
  assert.equal(late.res.state, 'REFUSED');
  assert.deepEqual(failing(late.res), ['V9']);
  // plan-coord ruling 11-22: the reason carries both timestamps and their difference; without clock offsets the classification is CLOCK_OFFSET_UNKNOWN
  assert.ok(codesOf(late.res, 'V9').some((c) => c.includes(`registered_at=2026-11-24T10:06:00+08:00:k2_frozen_at=${fx.NOW_FREEZE}:diff_ms=60000:CLOCK_OFFSET_UNKNOWN`)), codesOf(late.res, 'V9'));
  const skew = flow(baseDraft(), { clockOffsets: { registrar_offset_ms: 45000, program_offset_ms: -20000, tolerance_ms: 1000 } }, { at: '2026-11-24T10:06:00+08:00', finalOver: { clockOffsets: { registrar_offset_ms: 45000, program_offset_ms: -20000, tolerance_ms: 1000 } } });
  assert.ok(codesOf(skew.res, 'V9').some((c) => c.endsWith('diff_ms=60000:SKEW_POSSIBLE')), codesOf(skew.res, 'V9'));
  const real = flow(baseDraft(), {}, { at: '2026-11-24T10:06:00+08:00', finalOver: { clockOffsets: { registrar_offset_ms: 5, program_offset_ms: 3, tolerance_ms: 1000 } } });
  assert.ok(codesOf(real.res, 'V9').some((c) => c.endsWith('diff_ms=60000:ORDERING_ERROR')), codesOf(real.res, 'V9'));
  assert.ok(codesOf(late.res, 'V9').some((c) => c.startsWith('TRIAL_LEDGER_PRE_REGISTERED_AFTER_FREEZE')), codesOf(late.res, 'V9'));
  // mutant: V9 off -> frozen although registered late (pins that nothing else covers for V9)
  const lateOff = flow(baseDraft(), { testDisableValidators: ['V9'] }, { at: '2026-11-24T10:06:00+08:00', finalOver: { testDisableValidators: ['V9'] } });
  assert.equal(lateOff.res.state, 'FROZEN');
});

test('AQ-37 V9: no receipt yet is WAITING_EXTERNAL:TRL_RECEIPT, never FROZEN and never REFUSED', () => {
  const d = baseDraft();
  const ctx = baseCtx();
  const p = prog.prepare(d, ctx);
  const res = prog.finalize(d, null, { ...ctx, now: fx.NOW_FREEZE }, p.prepared);
  assert.equal(res.state, 'WAITING_EXTERNAL');
  assert.equal(res.code, 'TRL_RECEIPT');
});

test('AQ-37 V13 counter-example: the queue log already has a different K2_PROGRAM_FROZEN line for this K2 sha; V12 counter: artifact directory already holds a different freeze', () => {
  const d = baseDraft();
  const ctx = baseCtx();
  const p = prog.prepare(d, ctx);
  const receipts = fx.registerAt(p);
  const line = `2026-11-24T10:03:00+08:00 K2_PROGRAM_FROZEN ${d.draft_id} ${p.k2_sha256} ${'9'.repeat(64)} CN_A LINUX`;
  const res = prog.finalize(d, receipts, { ...ctx, now: fx.NOW_FREEZE, ledgerRows: fx.ledgerRows(), queueLogText: `${line}\n` }, p.prepared);
  assert.equal(res.state, 'REFUSED');
  assert.deepEqual(failing(res), ['V13']);
  assert.ok(codesOf(res, 'V13').some((c) => c.startsWith('PREREG_QUEUE_LINE_DUPLICATE')));
  const off = prog.finalize(d, receipts, { ...ctx, now: fx.NOW_FREEZE, ledgerRows: fx.ledgerRows(), queueLogText: `${line}\n`, testDisableValidators: ['V13'] }, p.prepared);
  assert.equal(off.state, 'FROZEN');
  // V12: a pre-existing, different frozen text for the same id is never overwritten
  const ctxB = baseCtx();
  const first = flow(baseDraft({ draft_id: 'AIP-CNA-V12' }), { outDir: ctxB.outDir });
  assert.equal(first.res.state, 'FROZEN');
  const again = flow(baseDraft({ draft_id: 'AIP-CNA-V12', study_ref: 'AIP-CNA-V12-OTHER' }), { outDir: ctxB.outDir });
  assert.equal(again.res.state, 'REFUSED');
  assert.deepEqual(failing(again.res), ['V12']);
  assert.ok(codesOf(again.res, 'V12').some((c) => c.startsWith('PREREG_ARTIFACT_EXISTS')));
});

test('a prepared K2 that no longer renders to the same sha (draft changed after the TRL rows were registered) is refused, not frozen', () => {
  const d = baseDraft();
  const ctx = baseCtx();
  const p = prog.prepare(d, ctx);
  const receipts = fx.registerAt(p);
  const changed = clone(d);
  changed.section0.failure_mode_zh = '换了一句话';
  const res = prog.finalize(changed, receipts, { ...ctx, now: fx.NOW_FREEZE, ledgerRows: fx.ledgerRows() }, p.prepared);
  assert.equal(res.state, 'REFUSED');
  assert.ok(res.codes.includes('PREREG_ARTIFACT_PREPARED_MISMATCH'));
});
