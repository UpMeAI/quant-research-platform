'use strict';
/** Promotion engine, ladder S0-S6 (PLAN_V1_1_AMENDMENT_1 section 1.1/1.2): four verdicts per stage, no skipping, byte-identical output. */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../services/promotion-engine');
const fx = require('./_promotion_fixture');

for (const stage of fx.STAGES) {
  for (const verdict of fx.VERDICTS) {
    test(`${stage} ${verdict}`, () => {
      const out = engine.evaluate(fx.request(stage, verdict));
      assert.equal(out.stage, stage);
      assert.equal(out.verdict, verdict, JSON.stringify(out.reasonCodes));
      assert.ok(Array.isArray(out.reasonCodes) && out.reasonCodes.length > 0);
      assert.equal(typeof out.nextAction, 'string');
      if (verdict === 'PASS') assert.equal(out.nextAction, stage === 'S6' ? 'ADOPT_NEW_D_VERSION' : `PROCEED_TO_${fx.STAGES[fx.STAGES.indexOf(stage) + 1]}`);
      if (verdict === 'FAIL') assert.equal(out.nextAction, 'SEAL_NOT_DO_TO_FAILURE_LIBRARY');
      if (verdict === 'INVALID_INPUT') assert.equal(out.nextAction, 'FIX_INPUT');
    });
  }
}

test('INSUFFICIENT is never written as FAIL or sent to the failure library', () => {
  for (const stage of fx.STAGES.slice(0, 6)) {
    const out = engine.evaluate(fx.request(stage, 'INSUFFICIENT'));
    assert.equal(out.verdict, 'INSUFFICIENT');
    assert.notEqual(out.nextAction, 'SEAL_NOT_DO_TO_FAILURE_LIBRARY');
  }
});

test('skip: S2 can never feed trade plans, S3 PASS is not S4', () => {
  const s2 = engine.evaluate(fx.request('S2', 'PASS', { over: { requested_stage: 'TRADE_PLAN' }, history: [...fx.historyBefore('S2'), { stage: 'S2', verdict: 'PASS', output_sha256: fx.sha('prev-S2') }] }));
  assert.equal(s2.verdict, 'INVALID_INPUT');
  assert.deepEqual(s2.reasonCodes, ['PROMOTION_STAGE_SKIP:S2->TRADE_PLAN']);
  const s3 = engine.evaluate(fx.request('S4', 'PASS', { history: fx.historyBefore('S3') })); // S3 not passed in this history
  assert.deepEqual(s3.reasonCodes, ['PROMOTION_STAGE_SKIP:S2->S4']);
  const h3 = [...fx.historyBefore('S4')]; // S0..S3 PASS
  assert.deepEqual(engine.evaluate(fx.request('S5', 'PASS', { history: h3 })).reasonCodes, ['PROMOTION_STAGE_SKIP:S3->S5']);
  assert.deepEqual(engine.evaluate(fx.request('S3', 'PASS', { over: { requested_stage: 'TRADE_PLAN' }, history: h3 })).reasonCodes, ['PROMOTION_STAGE_SKIP:S3->TRADE_PLAN']);
  assert.deepEqual(engine.evaluate(fx.request('S2', 'PASS', { history: [] })).reasonCodes, ['PROMOTION_STAGE_SKIP:NONE->S2']);
});

test('a PASS at S4 or later may feed trade plans; a FAIL anywhere seals the candidate', () => {
  const s4 = [...fx.historyBefore('S5')]; // S0..S4 PASS
  const ok = engine.evaluate({ ...fx.request('S5', 'PASS', { history: s4 }), requested_stage: 'TRADE_PLAN' });
  assert.equal(ok.verdict, 'PASS');
  assert.equal(ok.nextAction, 'ALLOW_TRADE_PLAN');
  const sealed = engine.evaluate(fx.request('S3', 'PASS', { history: [...fx.historyBefore('S3').slice(0, 2), { stage: 'S2', verdict: 'FAIL', output_sha256: fx.sha('prev-S2') }] }));
  assert.equal(sealed.verdict, 'INVALID_INPUT');
  assert.ok(sealed.reasonCodes.includes('PROMOTION_CANDIDATE_SEALED_NOT_DO:S2'));
});

test('lineage: evidence must chain to the previous stage output', () => {
  const out = engine.evaluate(fx.request('S3', 'PASS', { evOver: { prior_output_sha256: fx.sha('forged') } }));
  assert.equal(out.verdict, 'INVALID_INPUT');
  assert.ok(out.reasonCodes.includes('PROMOTION_LINEAGE_MISMATCH:S3'));
});

test('evidence for another candidate, K2 or stage is INVALID_INPUT', () => {
  assert.ok(engine.evaluate(fx.request('S2', 'PASS', { evOver: { candidate_id: 'OTHER' } })).reasonCodes.includes('PROMOTION_EVIDENCE_CANDIDATE_MISMATCH'));
  assert.ok(engine.evaluate(fx.request('S2', 'PASS', { evOver: { k2_sha256: 'b'.repeat(64) } })).reasonCodes.includes('PROMOTION_EVIDENCE_K2_MISMATCH'));
  assert.ok(engine.evaluate(fx.request('S2', 'PASS', { evOver: { stage: 'S3' } })).reasonCodes.includes('PROMOTION_EVIDENCE_STAGE_MISMATCH'));
});

test('a validator stop in the evidence is INVALID_INPUT (unknown), not a negative verdict', () => {
  const out = engine.evaluate(fx.request('S2', 'PASS', { evOver: { validator: { first_failed: 'V-2' } } }));
  assert.equal(out.verdict, 'INVALID_INPUT');
  assert.ok(out.reasonCodes.includes('PROMOTION_VALIDATOR_STOPPED_AT:V-2'));
});

test('seeded counter-examples: one per rule', () => {
  const t = fx.terms();
  const S3 = (mut) => { const r = fx.request('S3', 'PASS'); mut(r.evidence.body); return engine.evaluate(r); };
  assert.equal(S3((b) => { b.delta_g.estimate = 0.019; }).verdict, 'INSUFFICIENT'); // point estimate below the frozen 2 pp
  assert.equal(S3((b) => { b.cost_x2.delta_g_ci_lower = 0; }).verdict, 'INSUFFICIENT'); // cost x2 lower bound must be > 0
  assert.equal(S3((b) => { b.cost_x2.multiple = 1.5; }).verdict, 'INVALID_INPUT'); // not the frozen multiple
  assert.equal(S3((b) => { b.constraints_ok = false; }).verdict, 'INSUFFICIENT');
  assert.equal(S3((b) => { b.delta_g.ci.lower = 0; }).verdict, 'INSUFFICIENT'); // lower bound must be > 0
  assert.equal(S3((b) => { b.n = 199; }).verdict, 'INSUFFICIENT'); // below min_sample_n
  // adequately powered and the whole CI below the economic minimum: not a pause, the existing rule says 不做
  assert.equal(S3((b) => { b.delta_g = { estimate: 0.005, ci: fx.ci(0.001, 0.012) }; }).verdict, 'FAIL');
  const S2 = (mut) => { const r = fx.request('S2', 'PASS'); mut(r.evidence.body); return engine.evaluate(r); };
  assert.equal(S2((b) => { b.dsr = 0.94; }).verdict, 'INSUFFICIENT'); // DSR below the existing 0.95 gate: downgrade, never PASS
  assert.equal(S2((b) => { b.dsr = null; }).verdict, 'INSUFFICIENT');
  assert.equal(S2((b) => { b.ci.upper = -0.001; b.ci.lower = -0.02; b.dsr = 0.99; }).verdict, 'FAIL');
  const S5 = (mut) => { const r = fx.request('S5', 'PASS'); mut(r.evidence.body); return engine.evaluate(r); };
  assert.equal(S5((b) => { b.holdout = { origin: 'MINED', read_count: 1, read_at: '2026-12-30T23:59:59+08:00' }; }).verdict, 'INVALID_INPUT'); // mined holdout before 12-31
  assert.equal(S5((b) => { b.holdout = { origin: 'MINED', read_count: 1, read_at: '2027-01-01T00:00:00+08:00' }; }).verdict, 'PASS');
  assert.equal(S5((b) => { b.holdout.read_count = 2; }).verdict, 'INVALID_INPUT'); // read once only
  assert.ok(t);
});

test('RISK layer uses the 5.2 B terms (CVaR improvement, growth sacrifice)', () => {
  const t = fx.terms({ layer: 'RISK', min_economic_value: { metric: 'CVAR5_IMPROVEMENT', value: 0.1 } });
  const body = (o) => ({ n: 300, cvar5_improvement: { estimate: 0.12, ci: fx.ci(0.03, 0.2) }, growth_sacrifice: { estimate: 0.005, ci: fx.ci(0, 0.01) }, cost_x2: { multiple: 2, delta_g_ci_lower: 0.001 }, cost_model_ref: 'REPLAY_CORE_PROFILE_COSTS', constraints_ok: true, ...o });
  const run = (o) => { const r = fx.request('S3', 'PASS', { terms: t }); r.evidence.body = body(o); return engine.evaluate(r); };
  assert.equal(run({}).verdict, 'PASS');
  assert.equal(run({ growth_sacrifice: { estimate: 0.011, ci: fx.ci(0.005, 0.02) } }).verdict, 'FAIL');
  assert.equal(run({ cvar5_improvement: { estimate: 0.09, ci: fx.ci(0.01, 0.2) } }).verdict, 'INSUFFICIENT');
});

test('same input gives byte-identical output, whatever the key order of the input', () => {
  const r = fx.request('S3', 'PASS');
  const a = engine.render(engine.evaluate(r));
  const b = engine.render(engine.evaluate(JSON.parse(JSON.stringify(r))));
  const shuffled = JSON.parse(JSON.stringify(r, Object.keys(r).sort().reverse()));
  const c = engine.render(engine.evaluate(shuffled));
  assert.ok(Buffer.isBuffer(a));
  assert.equal(a.compare(b), 0);
  assert.equal(a.compare(c), 0);
  assert.match(JSON.parse(a).output_sha256, /^[0-9a-f]{64}$/);
});

test('evaluation does not mutate its input', () => {
  const r = fx.request('S3', 'INSUFFICIENT');
  const before = JSON.stringify(r);
  engine.evaluate(r);
  assert.equal(JSON.stringify(r), before);
});
