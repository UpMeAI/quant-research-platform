'use strict';
/**
 * V-1 causality evidence for a mined DSL candidate, produced by COMPOSITION (plan-coord decision 11-23, NOTE_1 6b3be10d item 3).
 * The 12 sandbox operators were certified once with the G-CAUSAL harness (docs/evidence/mining-operators-v1/); a candidate's evidence is those
 * records, copied, for the operators its formula uses. Red first: services/research-lab-e2e/causality-evidence.js does not exist yet.
 * The composed evidence must satisfy the real gates: independent-verifier runners.V1 (causality.check + parity.check) and the K2 freeze program's V5.
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const lab = require('../services/research-lab-e2e/causality-evidence');
const causality = require('../services/causality-gate');
const stages = require('../services/independent-verifier/stages');
const prog = require('../services/k2-freeze-program');
const space = require('../services/mining-sandbox/space');
const V = require('./_verifier_fixture');
const K = require('./_k2_freeze_fixture');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'evidence', 'mining-operators-v1');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const OPS = `${space.OPERATORS_PATH}#ROWS.`;
const OPERATOR_BYTES = fs.readFileSync(path.join(DIR, 'CAUSALITY_EVIDENCE_V1.json'));
const TOKEN = `DATA:V6_CSI300_INDEX_DAILY@${V.REG.registry_version}#${V.REG.registry_sha256}|PIT=BAR_CLOSE|VENDOR=Tushare`;
const K2 = 'b'.repeat(64);

const FORMULAS = {
  CROSS_SECTION: 'rank(ts_mean(close, 20))',
  TIME_SERIES: 'ts_corr(close, volume, 10)',
  ELEMENTWISE: 'sign(abs(log(close)))',
  ARITHMETIC: '-ts_rank(close, 10) + ts_delta(close, 5) / ts_std(close, 20) - 0.5 * volume',
  MIXED: 'neutralize_industry(zscore(ts_mean(close, 5) * 2)) + neutralize_size(rank(volume))',
};

/** An operator evidence document edited and re-hashed (so only the edited fact differs). */
function operatorEvidence(edit) {
  const doc = JSON.parse(OPERATOR_BYTES.toString('utf8'));
  edit(doc);
  doc.record_hash = causality.recordHash(doc);
  const bytes = Buffer.from(JSON.stringify(doc));
  return { bytes, sha256: sha(bytes) };
}
const fn = (doc, op) => doc.functions.find((f) => f.function_id === `${OPS}${op}`);
const refusal = (fnc, code) => assert.throws(fnc, (e) => { assert.ok(String(e.message).startsWith(code), e.message); return true; });

/** A verifier bundle whose V-1 runs on the composed evidence and a K2 that carries the matching CF lines and DATA token. */
function v1Bundle(formula, { mutate = (c) => c } = {}) {
  const fx = V.build();
  const old = fx.files.get('k2.md').toString('utf8');
  const cf = lab.functionIdsOf(formula).map((id) => `- \`CF:${id}\``).join('\n');
  const text = old.replace(/- [^\n]*`CF:[^`]*`/, cf);
  const k2 = fx.put('k2.md', text);
  const honest = lab.fromExpression({ formula, k2Sha256: k2.sha256, dataInputs: [TOKEN] });
  const composed = mutate(honest);
  const ev = fx.put('causality.json', composed.bytes);
  const runLog = fx.put('runlog.json', JSON.stringify({ schema: 'RESEARCH_RUN_LOG_V1', k2_sha256: k2.sha256, runs: [], qrp_run_commit: honest.evidence.code_sha }));
  const v1 = fx.bundle.v1;
  v1.entry = { ...v1.entry, k2: { sha256: k2.sha256 }, causality_evidence: { sha256: ev.sha256 } };
  v1.files = { ...v1.files, k2, causalityEvidence: ev, runLog };
  return { fx, composed, text };
}

test('operatorsOf: the whitelist operators a formula uses, sorted and unique; arithmetic, unary minus and constants are not operators', () => {
  assert.deepEqual(lab.operatorsOf(FORMULAS.CROSS_SECTION), ['rank', 'ts_mean']);
  assert.deepEqual(lab.operatorsOf(FORMULAS.ARITHMETIC), ['ts_delta', 'ts_rank', 'ts_std']);
  assert.deepEqual(lab.operatorsOf('ts_mean(close, 5) + ts_mean(open, 5)'), ['ts_mean']);
  assert.deepEqual(lab.operatorsOf('close / open'), []);
  assert.deepEqual(lab.operatorsOf('rank(close)'), lab.operatorsOf('  rank( close ) '));
});

test('functionIdsOf: the CF ids a K2 draft lists, sorted, in the evidence function_id form', () => {
  assert.deepEqual(lab.functionIdsOf(FORMULAS.CROSS_SECTION), [`${OPS}rank`, `${OPS}ts_mean`]);
  for (const id of lab.functionIdsOf(FORMULAS.MIXED)) assert.match(id, causality.FUNCTION_ID);
  refusal(() => lab.functionIdsOf('close / open'), 'CAUSALITY_COMPOSE_NO_OPERATORS');
  refusal(() => lab.functionIdsOf('ts_lead(close, 1)'), 'CAUSALITY_COMPOSE_OPERATOR_NOT_CERTIFIED:ts_lead:NOT_IN_EVIDENCE');
});

for (const [klass, formula] of Object.entries(FORMULAS)) {
  test(`composition (${klass}): the composed evidence is a valid CAUSALITY_EVIDENCE_V1 and runners.V1 passes on a K2 with the matching CF and DATA lines`, () => {
    const { composed, fx } = v1Bundle(formula);
    const doc = causality.parseEvidence(composed.bytes, 'composed');
    assert.deepEqual(doc, composed.evidence);
    assert.equal(composed.sha256, sha(composed.bytes));
    assert.equal(doc.record_hash, causality.recordHash(doc));
    assert.equal(doc.contract_ref, causality.CONTRACT_REF);
    assert.deepEqual(doc.functions.map((f) => f.function_id), lab.functionIdsOf(formula));
    const original = JSON.parse(OPERATOR_BYTES.toString('utf8'));
    for (const f of doc.functions) {
      assert.deepEqual(f, original.functions.find((o) => o.function_id === f.function_id), 'record copied unchanged');
      assert.deepEqual([f.role, f.t_c1, f.t_c2, f.t_c3], ['FEATURE', 'PASS', 'PASS', 'PASS']);
    }
    assert.deepEqual(doc.unknown, {});
    assert.deepEqual(composed.v1.files.causalityEvidence, { path: 'causality.json', sha256: composed.sha256 });
    const out = stages.runners.V1(fx.bundle, fx.ctx);
    assert.deepEqual(out.codes, []);
    assert.equal(out.detail.causality, 'PASS');
  });
}

test('the composition is bound to the K2 it is given and to nothing else; same inputs, same bytes', () => {
  const a = lab.fromExpression({ formula: FORMULAS.MIXED, k2Sha256: K2, dataInputs: [TOKEN] });
  const b = lab.fromExpression({ formula: ' neutralize_industry( zscore(ts_mean(close,5)*2) ) + neutralize_size( rank(volume) )', k2Sha256: K2, dataInputs: [TOKEN] });
  assert.equal(a.evidence.k2_sha256, K2);
  assert.ok(a.bytes.equals(b.bytes), 'a formula written differently but canonically equal gives the same bytes');
  assert.ok(a.bytes.equals(lab.fromExpression({ formula: FORMULAS.MIXED, k2Sha256: K2, dataInputs: [TOKEN] }).bytes));
  assert.notEqual(a.sha256, lab.fromExpression({ formula: FORMULAS.MIXED, k2Sha256: 'c'.repeat(64), dataInputs: [TOKEN] }).sha256);
  assert.notEqual(a.sha256, lab.fromExpression({ formula: FORMULAS.CROSS_SECTION, k2Sha256: K2, dataInputs: [TOKEN] }).sha256);
  assert.deepEqual(a.evidence.composition.operators, lab.operatorsOf(FORMULAS.MIXED));
  assert.deepEqual(a.evidence.composition.data_inputs, [TOKEN]);
  assert.equal(a.evidence.composition.operator_evidence_sha256, sha(OPERATOR_BYTES));
});

test('K2 freeze program V5 accepts a draft whose causality.functions = functionIdsOf(formula) with the draft-stage composition (K2 not frozen yet)', () => {
  const formula = FORMULAS.ARITHMETIC;
  const composed = lab.fromExpression({ formula, dataInputs: [TOKEN] }); // no K2 yet: bound to the operators' own signed K2, as V5 allows
  assert.equal(composed.evidence.k2_sha256, JSON.parse(OPERATOR_BYTES.toString('utf8')).k2_sha256);
  const arms = K.baseDraft().arms.map((a) => ({ ...a, stage: 'SIGNAL' })); // out of the A1 (cost-gated fill) scope
  const draft = K.baseDraft({ arms, causality: { functions: lab.functionIdsOf(formula), evidence_sha256: composed.sha256 } });
  const ctx = (over = {}) => K.baseCtx({ evidenceBytes: (s) => (s === composed.sha256 ? composed.bytes : null), pinnedCodeShas: composed.pinnedCodeShas, ...over });
  assert.deepEqual(composed.pinnedCodeShas, { qrp: composed.evidence.code_sha });
  const ok = prog.prepare(draft, ctx());
  assert.deepEqual(K.failing(ok), [], JSON.stringify(ok.results.filter((r) => r.state === 'REFUSED')));
  const wrongList = K.baseDraft({ arms, causality: { functions: lab.functionIdsOf(FORMULAS.CROSS_SECTION), evidence_sha256: composed.sha256 } });
  const bad = prog.prepare(wrongList, ctx());
  assert.deepEqual(K.failing(bad), ['V5']);
  assert.ok(K.codesOf(bad, 'V5').some((c) => c.startsWith('CAUSAL_FUNCTION_NOT_IN_')));
});

test('refusals: an operator that is not certified (role, any test not PASS, missing) names the operator and why', () => {
  const asRole = operatorEvidence((d) => { fn(d, 'ts_mean').role = 'SIGNAL'; });
  refusal(() => lab.fromExpression({ formula: FORMULAS.CROSS_SECTION, k2Sha256: K2, dataInputs: [TOKEN], operatorEvidence: asRole }), 'CAUSALITY_COMPOSE_OPERATOR_NOT_CERTIFIED:ts_mean:ROLE_NOT_FEATURE');
  for (const t of ['t_c1', 't_c2', 't_c3']) {
    const failed = operatorEvidence((d) => { const f = fn(d, 'rank'); f[t] = 'FAIL'; f.fail_reasons = { [t]: 'SYNTHETIC' }; });
    refusal(() => lab.fromExpression({ formula: FORMULAS.CROSS_SECTION, k2Sha256: K2, dataInputs: [TOKEN], operatorEvidence: failed }), `CAUSALITY_COMPOSE_OPERATOR_NOT_CERTIFIED:rank:${t.toUpperCase().replace('_', '-')}_NOT_PASS`);
  }
  const missing = operatorEvidence((d) => { d.functions = d.functions.filter((f) => f.function_id !== `${OPS}ts_mean`); });
  refusal(() => lab.fromExpression({ formula: FORMULAS.CROSS_SECTION, k2Sha256: K2, dataInputs: [TOKEN], operatorEvidence: missing }), 'CAUSALITY_COMPOSE_OPERATOR_NOT_CERTIFIED:ts_mean:NOT_IN_EVIDENCE');
  // only the operators the formula uses count
  assert.ok(lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2, dataInputs: [TOKEN], operatorEvidence: missing }).sha256);
  refusal(() => lab.fromExpression({ formula: 'ts_lead(close, 1)', k2Sha256: K2, dataInputs: [TOKEN] }), 'CAUSALITY_COMPOSE_OPERATOR_NOT_CERTIFIED:ts_lead:NOT_IN_EVIDENCE');
  refusal(() => lab.fromExpression({ formula: 'close / open', k2Sha256: K2, dataInputs: [TOKEN] }), 'CAUSALITY_COMPOSE_NO_OPERATORS');
});

test('refusals: operator evidence that does not match its sha256, is not a valid evidence file, or whose code changed (re-run rule)', () => {
  refusal(() => lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2, dataInputs: [TOKEN], operatorEvidence: { bytes: OPERATOR_BYTES, sha256: '0'.repeat(64) } }), 'CAUSALITY_COMPOSE_OPERATOR_EVIDENCE_SHA_MISMATCH');
  const broken = Buffer.from(OPERATOR_BYTES.toString('utf8').replace('"t_c1": "PASS"', '"t_c1": "FAIL"').replace('"t_c1":"PASS"', '"t_c1":"FAIL"'));
  refusal(() => lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2, dataInputs: [TOKEN], operatorEvidence: { bytes: broken, sha256: sha(broken) } }), 'CAUSALITY_COMPOSE_OPERATOR_EVIDENCE_INVALID');
  const operators = fs.readFileSync(path.join(ROOT, 'services', 'mining-sandbox', 'evaluator', 'operators.js'));
  refusal(() => lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2, dataInputs: [TOKEN], operatorsSource: Buffer.concat([operators, Buffer.from('\n// changed\n')]) }), 'CAUSALITY_COMPOSE_OPERATOR_EVIDENCE_STALE');
  assert.ok(lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2, dataInputs: [TOKEN], operatorsSource: operators }).sha256);
});

test('refusals: bad K2 sha, no data inputs, malformed data input; the default evidence is the repo file checked against its sha256 sidecar', () => {
  refusal(() => lab.fromExpression({ formula: 'rank(close)', k2Sha256: 'xyz', dataInputs: [TOKEN] }), 'CAUSALITY_COMPOSE_K2_SHA_INVALID');
  refusal(() => lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2, dataInputs: [] }), 'CAUSALITY_COMPOSE_DATA_INPUTS_MISSING');
  refusal(() => lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2 }), 'CAUSALITY_COMPOSE_DATA_INPUTS_MISSING');
  refusal(() => lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2, dataInputs: ['close'] }), 'CAUSALITY_COMPOSE_DATA_INPUTS_INVALID');
  const side = fs.readFileSync(path.join(DIR, 'CAUSALITY_EVIDENCE_V1.json.sha256'), 'utf8').trim().split(/\s+/)[0];
  assert.equal(lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2, dataInputs: [TOKEN] }).evidence.composition.operator_evidence_sha256, side);
});

test('codeSha: the run commit may stand as code_sha only when git shows operators.js identical at that commit; otherwise refused', () => {
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
  const c = lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2, dataInputs: [TOKEN], codeSha: head });
  assert.equal(c.evidence.code_sha, head);
  assert.deepEqual(c.pinnedCodeShas, { qrp: head });
  assert.equal(c.evidence.record_hash, causality.recordHash(c.evidence));
  refusal(() => lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2, dataInputs: [TOKEN], codeSha: 'f'.repeat(40) }), 'CAUSALITY_COMPOSE_CODE_SHA_UNVERIFIED');
  refusal(() => lab.fromExpression({ formula: 'rank(close)', k2Sha256: K2, dataInputs: [TOKEN], codeSha: 'nope' }), 'CAUSALITY_COMPOSE_CODE_SHA_UNVERIFIED');
});

test('a tampered composed evidence fails V-1: edited result, edited record without re-hash, another K2, a function swapped out', () => {
  const rehash = (c, edit, keepHash = false) => { const doc = JSON.parse(c.bytes.toString('utf8')); edit(doc); if (!keepHash) doc.record_hash = causality.recordHash(doc); const bytes = Buffer.from(JSON.stringify(doc)); return { ...c, bytes, evidence: doc, sha256: sha(bytes) }; };
  const formula = FORMULAS.CROSS_SECTION;
  const ok = v1Bundle(formula);
  assert.deepEqual(stages.runners.V1(ok.fx.bundle, ok.fx.ctx).codes, []);
  const run = (mutate) => { const { fx } = v1Bundle(formula, { mutate }); return () => stages.runners.V1(fx.bundle, fx.ctx); };
  refusal(run((c) => rehash(c, (d) => { d.functions[0].t_c2 = 'FAIL'; d.functions[0].fail_reasons = { t_c2: 'EDITED' }; })), 'CAUSALITY_FUNCTION_NOT_PASS');
  refusal(run((c) => rehash(c, (d) => { d.functions[0].role = 'SIGNAL'; }, true)), 'CAUSALITY_EVIDENCE_RECORD_HASH_MISMATCH');
  refusal(run((c) => rehash(c, (d) => { d.k2_sha256 = 'e'.repeat(64); })), 'CAUSALITY_EVIDENCE_K2_MISMATCH');
  refusal(run((c) => rehash(c, (d) => { d.functions = d.functions.slice(1); })), 'CAUSALITY_FUNCTION_NOT_IN_EVIDENCE');
  refusal(run((c) => rehash(c, (d) => { d.code_sha = 'a'.repeat(40); })), 'CAUSALITY_CODE_SHA_MISMATCH');
});
