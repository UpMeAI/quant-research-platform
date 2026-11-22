'use strict';
/**
 * W24b producers (plan-coord 11-23): S3 and S4 stage evidence, cost runs and fills (W22 costBreakdown shape, registry r3, G-COST coverage), V-5 robustness results, the
 * evidence provider and the S2..S4 ladder, integration through verifier and engine on fixtures. Red first.
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const R = require('./_lab_replay_fixture');
const P = require('./_promotion_fixture');
const VF = require('./_verifier_fixture');
const engine = require('../services/promotion-engine');
const costGate = require('../services/cost-gate');
const authority = require('../services/independent-verifier/authority');
const { runners } = require('../services/independent-verifier/stages');
const verifierMod = require('../services/independent-verifier');
const { canonicalJson } = require('../services/trial-ledger');
const s3 = require('../services/research-lab-e2e/s3-evidence');
const s4 = require('../services/research-lab-e2e/s4-evidence');
const costRuns = require('../services/research-lab-e2e/cost-runs');
const robustness = require('../services/research-lab-e2e/robustness');
const ladder = require('../services/research-lab-e2e/ladder');
const provider = require('../services/research-lab-e2e/evidence-provider');
const lab = require('../services/research-lab-e2e');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const STAR = { by_layer: { ALPHA: { thresholds: { s4: { max_overlap: 0.6 } } } } };
const terms = (over = {}) => P.terms({ candidate_id: 'AIP-CNA-001', ...over });
const evalStage = (stage, body, t, over = {}) => engine.evaluate({ candidate_id: t.candidate_id, requested_stage: stage, terms: t, as_of: P.AS_OF,
  history: P.historyBefore(stage), evidence: { schema: 'PROMOTION_STAGE_EVIDENCE_V1', candidate_id: t.candidate_id, stage, k2_sha256: t.k2_sha256, prior_output_sha256: sha(`prev-${P.STAGES[P.STAGES.indexOf(stage) - 1]}`),
    validator: { first_failed: null }, body, ...over } });

/* ---------------------------------------------------------------- S3 */

test('S3 producer (ALPHA): paired Δg per year with a month-block 95% interval, cost x2 interval from the same series, constraints from the fills, W22 cost breakdown; the engine PASSes it', () => {
  const t = terms();
  const out = s3.produce({ replay: R.makeReplay(), terms: t });
  assert.equal(out.refusal, undefined);
  const b = out.body;
  assert.ok(b.n >= 200 && b.delta_g.estimate > 0.02 && b.delta_g.ci.lower > 0 && b.delta_g.ci.level === 0.95, JSON.stringify(b.delta_g));
  assert.equal(b.cost_x2.multiple, t.thresholds.s3.cost_multiple, 'the multiple is the K2 one');
  assert.ok(b.cost_x2.delta_g_ci_lower > 0 && b.cost_x2.delta_g_ci_lower < b.delta_g.ci.lower, 'double costs lower the bound');
  assert.equal(b.constraints_ok, true);
  assert.equal(b.cost_model_ref, 'W24B_FIXTURE_COSTS_V1');
  assert.equal(typeof b.cost_breakdown.commission_bps, 'number');
  const r = evalStage('S3', b, t);
  assert.equal(r.verdict, 'PASS', JSON.stringify(r));
  assert.deepEqual(s3.produce({ replay: R.makeReplay(), terms: t }), out, 'pure');
});

test('S3 producer: a negative edge is a FAIL by the engine, a short sample is INSUFFICIENT, a limit-price fill makes constraints_ok false', () => {
  const t = terms();
  assert.equal(evalStage('S3', s3.produce({ replay: R.makeReplay({ edge: -0.0008 }), terms: t }).body, t).verdict, 'FAIL');
  const short = evalStage('S3', s3.produce({ replay: R.makeReplay({ days: 120 }), terms: t }).body, t, { insufficient_inputs: P.insuff() });
  assert.equal(short.verdict, 'INSUFFICIENT');
  assert.ok(short.reasonCodes.includes('S3_SAMPLE_BELOW_MIN'));
  const bad = R.makeReplay(); bad.trades[0] = { ...bad.trades[0], code: '600000.SH', open: 11.1, prev_close: 10 };
  assert.equal(s3.produce({ replay: bad, terms: t }).body.constraints_ok, false);
  const over = R.makeReplay(); over.trades[0] = { ...over.trades[0], participation: 0.5 };
  assert.equal(s3.produce({ replay: over, terms: t }).body.constraints_ok, false, 'participation cap of the verifier configuration');
});

test('S3 producer (RISK): CVaR5 improvement and growth sacrifice with intervals, accepted by the engine', () => {
  const t = terms({ layer: 'RISK', min_economic_value: { metric: 'CVAR5_IMPROVEMENT', value: 0.001 } });
  const out = s3.produce({ replay: R.makeReplay(), terms: t });
  assert.ok(out.body.cvar5_improvement && out.body.growth_sacrifice && !('delta_g' in out.body));
  const r = evalStage('S3', out.body, t);
  assert.notEqual(r.verdict, 'INVALID_INPUT', JSON.stringify(r.reasonCodes));
});

test('S3 producer refuses a malformed replay output with a code, never a guess', () => {
  assert.equal(s3.produce({ replay: { schema: 'X' }, terms: terms() }).refusal, 'REPLAY_OUTPUT_INVALID');
  const gap = R.makeReplay(); gap.arms.candidate.daily.pop();
  assert.equal(s3.produce({ replay: gap, terms: terms() }).refusal, 'REPLAY_ARMS_NOT_ALIGNED');
});

/* ---------------------------------------------------------------- S4 */

test('S4 producer: marginal net contribution, tail, stress and overlap from the portfolio with and without; refuses star_missing for the overlap threshold until the star file sets it', () => {
  const t = terms({ thresholds: { s3: { cost_multiple: 2, max_growth_sacrifice: 0.01 }, s4: { max_overlap: 0.6 } } });
  assert.equal(s4.produce({ replay: R.makeReplay(), terms: t, star: null }).refusal, 'S4_STAR_MISSING:max_overlap');
  assert.equal(s4.produce({ replay: R.makeReplay(), terms: t, star: { by_layer: { ALPHA: {} } } }).refusal, 'S4_STAR_MISSING:max_overlap');
  const out = s4.produce({ replay: R.makeReplay(), terms: t, star: STAR });
  const b = out.body;
  assert.ok(b.marginal_net_contribution.ci.lower > 0 && b.n >= 200);
  assert.equal(b.tail_ok, true); assert.equal(b.stress_ok, true);
  assert.deepEqual(b.race, { partition: 'SELECTION_TIMING' });
  assert.ok(b.overlap.risk >= 0 && b.overlap.risk < 0.3 && b.overlap.holdings === b.overlap.risk, 'both = full-sample |rho| of the candidate net against the book (NOTE_1)');
  assert.equal(evalStage('S4', b, t).verdict, 'PASS');
  const hot = R.makeReplay(); hot.portfolio.without = hot.arms.candidate.daily.map((x) => ({ date: x.date, net: x.gross - x.cost })); hot.portfolio.with = hot.portfolio.without; // the book IS the candidate: |rho| = 1
  assert.equal(evalStage('S4', s4.produce({ replay: hot, terms: t, star: STAR }).body, t).verdict, 'FAIL');
  const stress = R.makeReplay(); stress.portfolio.stress[0].delta = -0.01;
  assert.equal(s4.produce({ replay: stress, terms: t, star: STAR }).body.stress_ok, false);
});

/* ---------------------------------------------------------------- cost runs and fills */

test('cost runs: every registry-CHARGED item of the book with an amount computed from the trades (stamp duty on sells only, exchange fee by venue, minimum commission top-up); G-COST coverage COMPLETE; V-4 passes', () => {
  const replay = R.makeReplay();
  const out = costRuns.produce({ replay });
  const run = out.v4.runs[0];
  assert.deepEqual([run.cost_model_ref, run.cost_book], ['W24B_FIXTURE_COSTS_V1', 'STOCK_BOOK']);
  assert.equal(run.cost_breakdown.model, run.cost_model_ref);
  const cov = costGate.coverage.assessCoverage({ items: run.cost_breakdown.items, books: run.cost_book, flags: run.cost_flags }, 'CN_A');
  assert.equal(cov.state, 'COMPLETE', JSON.stringify(cov));
  const item = (n) => run.cost_breakdown.items.find((x) => x.item === n);
  const sellNotional = replay.trades.filter((x) => x.side === 'SELL').reduce((a, x) => a + x.notional, 0);
  const all = replay.trades.reduce((a, x) => a + x.notional, 0);
  assert.ok(Math.abs(item('STAMP_DUTY').amount - sellNotional * 5e-4) < 1e-6, 'registry schedule: 5 bps on sells from 2023-08-28');
  assert.ok(Math.abs(item('COMMISSION').amount - all * 2.5e-4) < 1e-6);
  assert.ok(item('EXCHANGE_FEE').amount > 0 && item('MIN_COMMISSION_TOPUP').amount >= 0);
  assert.ok(run.cost_breakdown.commission_bps >= costGate.FLOORS.CN_A.commission_bps_min && run.cost_breakdown.slippage_bps >= costGate.FLOORS.CN_A.slippage_bps_min);
  const cfg = authority.loadConfig();
  assert.deepEqual(runners.V4({ cfg, candidateId: 'c', v4: out.v4 }).codes, []);
  assert.equal(out.v4.fills.length, replay.trades.length);
  assert.deepEqual(Object.keys(out.v4.fills[0]).sort(), ['code', 'date', 'open', 'participation', 'prevClose', 'side', 'st']);
});

test('cost runs refuse what they cannot price: an unknown venue, a book the registry does not have, a missing trade list', () => {
  const r = R.makeReplay(); r.trades[0] = { ...r.trades[0], code: '830001.XX' };
  assert.equal(costRuns.produce({ replay: r }).refusal, 'COST_RUN_VENUE_UNKNOWN:830001.XX');
  assert.equal(costRuns.produce({ replay: { ...R.makeReplay(), cost_book: 'NOPE' } }).refusal, 'COST_RUN_BOOK_UNKNOWN:NOPE');
  assert.equal(costRuns.produce({ replay: { ...R.makeReplay(), trades: [] } }).refusal, 'COST_RUN_NO_TRADES');
});

/* ---------------------------------------------------------------- robustness (V-5) */

const DECL = { tests: [
  { id: 'COST_X2', kind: 'COST_MULTIPLIER', multiplier: 2, metric: 'NET_EXCESS_ANNUAL', op: '>', threshold: 0 },
  { id: 'PARAM_PLUS_MINUS_20', kind: 'PARAM_PERTURBATION', metric: 'WORST_NET_EXCESS_ANNUAL', op: '>', threshold: 0 },
  { id: 'SUB_PERIOD_HALVES', kind: 'SUB_PERIOD', metric: 'WORST_HALF_NET_EXCESS_ANNUAL', op: '>', threshold: 0 },
] };
const k2With = (decl) => `# K2\nROBUSTNESS_DECLARATION_SHA256: ${sha(canonicalJson(decl))}\n`;

test('robustness results: exactly the declared tests (cost multiple from the declaration, worst perturbation arm, worst half), declaration bound to the K2 line', () => {
  const replay = R.makeReplay();
  const out = robustness.produce({ replay, declaration: DECL, k2Text: k2With(DECL) });
  assert.deepEqual(out.v5.results.map((x) => x.id), ['COST_X2', 'PARAM_PLUS_MINUS_20', 'SUB_PERIOD_HALVES']);
  assert.ok(out.v5.results.every((x) => typeof x.value === 'number' && x.value > 0), JSON.stringify(out.v5.results));
  const x1 = robustness.produce({ replay, declaration: { tests: [{ ...DECL.tests[0], multiplier: 1 }, ...DECL.tests.slice(1)] }, k2Text: k2With({ tests: [{ ...DECL.tests[0], multiplier: 1 }, ...DECL.tests.slice(1)] }) });
  assert.ok(x1.v5.results[0].value > out.v5.results[0].value, 'a higher cost multiple lowers the net excess');
  assert.deepEqual(out.v5.declaration, DECL);
  assert.equal(robustness.produce({ replay, declaration: DECL, k2Text: '# K2\n' }).refusal, 'ROBUSTNESS_DECLARATION_NOT_IN_K2');
  assert.equal(robustness.produce({ replay, declaration: { tests: [...DECL.tests, { id: 'X', kind: 'REGIME', metric: 'MYSTERY', op: '>', threshold: 0 }] }, k2Text: k2With({ tests: [...DECL.tests, { id: 'X', kind: 'REGIME', metric: 'MYSTERY', op: '>', threshold: 0 }] }) }).refusal, 'ROBUSTNESS_METRIC_UNSUPPORTED:MYSTERY');
  const none = R.makeReplay(); none.perturbations = [];
  assert.equal(robustness.produce({ replay: none, declaration: DECL, k2Text: k2With(DECL) }).refusal, 'ROBUSTNESS_PERTURBATION_RUNS_MISSING');
  const neg = R.makeReplay({ edge: -0.0008 });
  assert.ok(robustness.produce({ replay: neg, declaration: DECL, k2Text: k2With(DECL) }).v5.results.some((x) => x.value < 0), 'a bad candidate produces failing values, V-5 judges them');
});

/* ---------------------------------------------------------------- ladder, provider, integration */

test('ladder: S2..S4 in order, stops at the first non-PASS, each evidence chained by the previous output sha; reachedS3 and the S4 result for V-6', () => {
  const t = terms({ thresholds: { s3: { cost_multiple: 2, max_growth_sacrifice: 0.01 }, s4: { max_overlap: 0.6 } } });
  const replay = R.makeReplay();
  const s2body = P.BODY.S2.PASS;
  const stages = { S2: { body: s2body }, S3: { body: s3.produce({ replay, terms: t }).body }, S4: { body: s4.produce({ replay, terms: t, star: STAR }).body } };
  const s0s1 = [{ stage: 'S0', verdict: 'PASS', output_sha256: sha('s0') }, { stage: 'S1', verdict: 'PASS', output_sha256: sha('s1') }];
  const full = ladder.run({ engine, terms: t, asOf: P.AS_OF, prior: s0s1, stages });
  assert.deepEqual(full.results.map((r) => [r.stage, r.verdict]), [['S2', 'PASS'], ['S3', 'PASS'], ['S4', 'PASS']]);
  assert.equal(full.reachedS3, true);
  assert.equal(full.s4.verdict, 'PASS');
  const failS3 = ladder.run({ engine, terms: t, asOf: P.AS_OF, prior: s0s1, stages: { ...stages, S3: { body: s3.produce({ replay: R.makeReplay({ edge: -0.0008 }), terms: t }).body } } });
  assert.deepEqual(failS3.results.map((r) => r.stage), ['S2', 'S3']);
  assert.equal(failS3.reachedS3, false);
  assert.equal(failS3.s4, null);
  const noS4 = ladder.run({ engine, terms: t, asOf: P.AS_OF, prior: s0s1, stages: { S2: stages.S2, S3: stages.S3, S4: { refusal: 'S4_STAR_MISSING:max_overlap' } } });
  assert.equal(noS4.waiting, 'S4_STAR_MISSING:max_overlap');
  assert.deepEqual(noS4.results.map((r) => r.stage), ['S2', 'S3']);
});

test('integration: replay output -> provider -> verifier V-1..V-6 and engine S2..S4 on the fixtures, verdict FORWARD_SHADOW; same inputs, same bytes; a failing robustness result stops at V-5', () => {
  const t = terms({ thresholds: { s3: { cost_multiple: 2, max_growth_sacrifice: 0.01 }, s4: { max_overlap: 0.6 } } });
  const replay = R.makeReplay();
  const build = (decl, replayIn) => {
    const prod = provider.fromReplay({ replay: replayIn, terms: t, star: STAR, declaration: decl, k2Text: k2With(decl), s2Body: P.BODY.S2.PASS });
    assert.equal(prod.refusal, undefined, JSON.stringify(prod.refusal));
    const v = VF.build({ robustness: decl, reachedS3: true, bundle: (b) => {
      b.v4 = prod.bundle.v4; b.v5 = prod.bundle.v5; b.candidateId = 'cand-1'; b.v6 = undefined;
    } });
    return { prod, v };
  };
  const { prod, v } = build(DECL, replay);
  const k2sha = v.bundle.v1.files.k2.sha256;
  const tt = { ...t, k2_sha256: k2sha };
  const s0s1 = [{ stage: 'S0', verdict: 'PASS', output_sha256: sha('s0') }, { stage: 'S1', verdict: 'PASS', output_sha256: sha('s1') }];
  const lad = ladder.run({ engine, terms: tt, asOf: P.AS_OF, prior: s0s1, stages: prod.stages });
  assert.equal(lad.results.length, 3);
  const decide = () => lab.verdict.decide({ bundle: { ...v.bundle, reachedS3: lad.reachedS3 }, verifierCtx: { ...v.ctx, promotionEngine: { s4: () => lad.s4 } }, request: lad.lastRequest, priorEngine: s0s1.concat(lad.results.slice(0, -1)).map((r) => ({ stage: r.stage, verdict: r.verdict, nextAction: null, reasonCodes: [], output_sha256: r.output_sha256 })) });
  const a = decide();
  assert.equal(a.status, 'DECIDED', JSON.stringify(a));
  assert.equal(a.verifier.internal.stages.find((s) => s.stage === 'V6').status, 'PASS', 'V-6 ran on the engine S4 result');
  assert.equal(a.verifier.internal.stages.find((s) => s.stage === 'V5').status, 'PASS');
  assert.equal(a.engine.stage, 'S4');
  assert.equal(a.seal.destination, 'FORWARD_SHADOW');
  assert.equal(decide().verdict_text, a.verdict_text, 'byte-identical');
  // a candidate whose robustness fails: the verifier stops at V-5 with the declared test's code
  const bad = build(DECL, R.makeReplay({ edge: -0.0008 }));
  const r = verifierMod.verify(bad.v.bundle, bad.v.ctx);
  assert.equal(r.generator.verdict, 'fail');
  assert.ok(/^V5_/.test(r.generator.reasonCodes[0]) || /^V4_|^V3_/.test(r.generator.reasonCodes[0]), r.generator.reasonCodes[0]);
});

test('provider refuses with a code when a producer refuses, and reports what it needs from the replay run', () => {
  const t = terms();
  const p = provider.fromReplay({ replay: R.makeReplay(), terms: t, star: null, declaration: DECL, k2Text: k2With(DECL), s2Body: P.BODY.S2.PASS });
  assert.equal(p.stages.S4.refusal, 'S4_STAR_MISSING:max_overlap', 'S4 refusal is a wait for the star file, not a failure of S3');
  assert.ok(p.stages.S3.body);
  const need = provider.replayNeeds({ declaration: DECL });
  assert.deepEqual(need.arm_runs.map((a) => a.id).sort(), ['baseline', 'candidate', 'PARAM_MINUS_20', 'PARAM_PLUS_20', 'portfolio_with', 'portfolio_without'].sort());
  assert.equal(need.arm_runs.length, 6);
  assert.deepEqual(need.derived_without_rerun, ['COST_X2', 'SUB_PERIOD_HALVES']);
  assert.equal(provider.fromReplay({ replay: { schema: 'X' }, terms: t, star: STAR, declaration: DECL, k2Text: k2With(DECL), s2Body: P.BODY.S2.PASS }).refusal, 'REPLAY_OUTPUT_INVALID');
});
