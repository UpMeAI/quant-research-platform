'use strict';
/** INSUFFICIENT resolution (AMENDMENT_1 section 4.2), recheck (4.3), transition rule (4.3), information-value order and KPI 9 (1.3). */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../services/promotion-engine');
const insufficient = require('../services/promotion-engine/insufficient');
const fx = require('./_promotion_fixture');

const run = (inputs, { t = fx.terms(), stage = 'S3' } = {}) => engine.evaluate(fx.request(stage, 'INSUFFICIENT', { terms: t, insufficient: fx.insuff(inputs) }));

test('step 4: continue is 做 and carries the review endpoint and the action at the endpoint', () => {
  const out = run({});
  assert.equal(out.verdict, 'INSUFFICIENT');
  assert.equal(out.resolution.conclusion, '做');
  assert.equal(out.resolution.code, 'CONTINUE_FORWARD_SHADOW_OR_SAMPLE');
  assert.deepEqual(out.resolution.review_endpoint, { kind: 'DATE', value: '2027-03-01' });
  assert.equal(out.resolution.action_at_endpoint, 'REJUDGE_UNDER_SECTION_4_2');
  assert.equal(out.nextAction, 'RUN_TO_REVIEW_ENDPOINT');
});

test('step 4 without a review endpoint is INVALID_INPUT', () => {
  const t = fx.terms(); delete t.review_endpoint;
  const out = run({}, { t });
  assert.equal(out.verdict, 'INVALID_INPUT');
  assert.ok(out.reasonCodes.includes('PROMOTION_REVIEW_ENDPOINT_MISSING'));
});

test('step 1: 95% CI upper bound below the minimum economic value pauses (strict)', () => {
  const out = run({ effect_ci: fx.ci(-0.02, 0.0199) });
  assert.equal(out.resolution.conclusion, '暂停');
  assert.equal(out.resolution.code, 'PAUSE_LOW_VALUE');
  assert.equal(out.nextAction, 'PAUSE_UNTIL_RESUME_CONDITION');
  assert.match(out.resolution.resume_condition.kind, /NEW_MECHANISM_EVIDENCE_OR_DATA_BASIS_CHANGE/);
  assert.equal(run({ effect_ci: fx.ci(-0.02, 0.02) }).resolution.code, 'CONTINUE_FORWARD_SHADOW_OR_SAMPLE'); // upper == minimum is not below it
});

test('a pause is never 不做 and never the failure library', () => {
  for (const inputs of [{ effect_ci: fx.ci(-0.02, 0.01) }, { events_per_month: 0.1 }, { cost_to_continue: { model_cost_cny: 500, core_hours: 1 } }]) {
    const out = run(inputs);
    assert.equal(out.resolution.conclusion, '暂停');
    assert.notEqual(out.nextAction, 'SEAL_NOT_DO_TO_FAILURE_LIBRARY');
    assert.ok(!JSON.stringify(out).includes('不做'));
    assert.equal(out.production_effect, 'NONE');
  }
});

test('step 2: P(reach min_sample_n in the K2 horizon) below the K2 threshold pauses, with the resume condition', () => {
  const out = run({ events_per_month: 2, observed_sample_n: 100 }); // needs 100 more, 24 expected in 12 months
  assert.equal(out.resolution.code, 'PAUSE_LOW_POWER');
  assert.ok(out.resolution.p_reach < 0.5);
  assert.deepEqual(out.resolution.resume_condition.sample_n_target, 100); // 50% of min_sample_n 200
  assert.ok(out.resolution.resume_condition.rate_target_per_month > 2);
  assert.equal(out.resolution.resume_condition.kind, 'SAMPLE_FRACTION_OR_RATE_RECOVERY');
});

test('step 2 boundary: threshold taken from the K2, strict less-than', () => {
  const inputs = fx.insuff({ events_per_month: 6 }); // needs 80 more, 72 expected in 12 months
  const p = insufficient.pReach({ observedN: inputs.observed_sample_n, minN: 200, ratePerMonth: inputs.events_per_month, horizonMonths: 12 });
  assert.ok(p > 0 && p < 1);
  const at = (th) => run({ events_per_month: 6 }, { t: fx.terms({ insufficient_policy: { ...fx.POLICY, p_threshold: th } }) }).resolution.code;
  assert.equal(at(p), 'CONTINUE_FORWARD_SHADOW_OR_SAMPLE');
  assert.equal(at(Math.min(1, p + 1e-6)), 'PAUSE_LOW_POWER');
});

test('the horizon is read from the K2, not from an engine constant', () => {
  const short = run({}, { t: fx.terms({ insufficient_policy: { ...fx.POLICY, horizon_months: 1 } }) });
  assert.equal(short.resolution.code, 'PAUSE_LOW_POWER');
  const long = run({ events_per_month: 5 }, { t: fx.terms({ insufficient_policy: { ...fx.POLICY, horizon_months: 36 } }) });
  assert.equal(long.resolution.code, 'CONTINUE_FORWARD_SHADOW_OR_SAMPLE');
});

test('step 3: continuing cost above the K2 share of the market monthly budget pauses (strict; either dimension)', () => {
  assert.equal(run({ cost_to_continue: { model_cost_cny: 200, core_hours: 20 } }).resolution.code, 'CONTINUE_FORWARD_SHADOW_OR_SAMPLE'); // exactly 20%
  assert.equal(run({ cost_to_continue: { model_cost_cny: 200.01, core_hours: 1 } }).resolution.code, 'PAUSE_BUDGET');
  assert.equal(run({ cost_to_continue: { model_cost_cny: 1, core_hours: 20.01 } }).resolution.code, 'PAUSE_BUDGET');
  const out = run({ cost_to_continue: { model_cost_cny: 300, core_hours: 1 } });
  assert.equal(out.resolution.resume_condition.kind, 'NEXT_MONTHLY_BUDGET_QUEUE_BY_INFORMATION_VALUE');
  const loose = run({ cost_to_continue: { model_cost_cny: 300, core_hours: 1 } }, { t: fx.terms({ insufficient_policy: { ...fx.POLICY, budget_share_max: 0.5 } }) });
  assert.equal(loose.resolution.code, 'CONTINUE_FORWARD_SHADOW_OR_SAMPLE');
});

test('order: value before power before budget', () => {
  const all = { effect_ci: fx.ci(-0.02, 0.01), events_per_month: 0.1, cost_to_continue: { model_cost_cny: 900, core_hours: 90 } };
  assert.equal(run(all).resolution.code, 'PAUSE_LOW_VALUE');
  const { effect_ci: _drop, ...rest } = all;
  assert.equal(run(rest).resolution.code, 'PAUSE_LOW_POWER');
});

test('a new K2 without the frozen policy is INVALID_INPUT; the engine has no default', () => {
  const t = fx.terms(); delete t.insufficient_policy;
  const out = run({}, { t });
  assert.equal(out.verdict, 'INVALID_INPUT');
  assert.ok(out.reasonCodes.includes('PROMOTION_POLICY_MISSING'));
  const bad = fx.terms({ insufficient_policy: { ...fx.POLICY, p_threshold: 1.5 } });
  assert.ok(run({}, { t: bad }).reasonCodes.some((c) => c.startsWith('PROMOTION_POLICY_INVALID')));
});

test('INSUFFICIENT without resolution inputs is INVALID_INPUT', () => {
  const r = fx.request('S3', 'INSUFFICIENT', { insufficient: null });
  const out = engine.evaluate(r);
  assert.equal(out.verdict, 'INVALID_INPUT');
  assert.ok(out.reasonCodes.includes('PROMOTION_INSUFFICIENT_INPUTS_MISSING'));
});

test('S6 waiting for an Owner signature is INSUFFICIENT but not a power or value matter', () => {
  const out = engine.evaluate(fx.request('S6', 'INSUFFICIENT'));
  assert.equal(out.verdict, 'INSUFFICIENT');
  assert.equal(out.nextAction, 'AWAIT_OWNER_SIGNATURE');
  assert.equal(out.resolution, null);
});

// ---- transition rule ----
test('pre-cutoff K2 keeps its own text until its endpoint: INSUFFICIENT is 做 (forward shadow), the new rule is not applied', () => {
  const t = fx.terms({ k2_frozen_at: fx.LEGACY_K2_FROZEN_AT, insufficient_policy: undefined });
  delete t.insufficient_policy;
  const out = run({ effect_ci: fx.ci(-0.02, 0.001), events_per_month: 0.1, cost_to_continue: { model_cost_cny: 999, core_hours: 99 } }, { t });
  assert.equal(out.resolution.conclusion, '做');
  assert.equal(out.resolution.code, 'LEGACY_K2_CONTINUE_TO_ENDPOINT');
  assert.ok(out.reasonCodes.includes('PROMOTION_LEGACY_K2_OWN_TEXT'));
  assert.equal(out.nextAction, 'RUN_TO_REVIEW_ENDPOINT');
});

test('pre-cutoff K2 at its endpoint is judged once under 4.2 with the built-in AMENDMENT_1_DEFAULT_POLICY (ruling 11-23 (2))', () => {
  assert.deepEqual({ ...insufficient.AMENDMENT_1_DEFAULT_POLICY }, { source: 'PLAN_V1_1_AMENDMENT_1_AI_RESEARCH_LAB', amendment_sha256_prefix: '0e2f3181', decision_id: 'PLAN-V1-20261123-01', horizon_months: 12, p_threshold: 0.5, budget_share_max: 0.2, resume_sample_fraction: 0.5, max_failed_rechecks: 3 });
  const noPolicy = () => { const t = fx.terms({ k2_frozen_at: fx.LEGACY_K2_FROZEN_AT, review_endpoint: { kind: 'DATE', value: '2026-11-30' }, next_review_endpoint: { kind: 'DATE', value: '2027-06-01' } }); delete t.insufficient_policy; return t; };
  const out = run({ effect_ci: fx.ci(-0.02, 0.001) }, { t: noPolicy() });
  assert.equal(out.resolution.code, 'PAUSE_LOW_VALUE');
  assert.equal(out.resolution.policy_source, 'AMENDMENT_1_DEFAULT_POLICY');
  assert.ok(!out.reasonCodes.includes('PROMOTION_POLICY_MISSING_AT_ENDPOINT'));
  // the defaults decide: 12 months, 0.5, 20%, 3 re-checks
  assert.equal(run({ events_per_month: 2, observed_sample_n: 100 }, { t: noPolicy() }).resolution.code, 'PAUSE_LOW_POWER');
  assert.equal(run({ cost_to_continue: { model_cost_cny: 201, core_hours: 1 } }, { t: noPolicy() }).resolution.code, 'PAUSE_BUDGET');
  const cont = run({}, { t: noPolicy() });
  assert.equal(cont.resolution.code, 'CONTINUE_FORWARD_SHADOW_OR_SAMPLE');
  assert.deepEqual(cont.resolution.review_endpoint, { kind: 'DATE', value: '2027-06-01' });
  // no per-item tuning: a different policy on a legacy K2 is refused, an identical one is accepted
  const tuned = fx.terms({ k2_frozen_at: fx.LEGACY_K2_FROZEN_AT, review_endpoint: { kind: 'DATE', value: '2026-11-30' }, insufficient_policy: { ...fx.POLICY, horizon_months: 3 } });
  const bad = run({}, { t: tuned });
  assert.equal(bad.verdict, 'INVALID_INPUT');
  assert.ok(bad.reasonCodes.includes('PROMOTION_LEGACY_POLICY_TUNING_NOT_ALLOWED'));
  assert.equal(run({}, { t: fx.terms({ k2_frozen_at: fx.LEGACY_K2_FROZEN_AT, review_endpoint: { kind: 'DATE', value: '2026-11-30' }, next_review_endpoint: { kind: 'DATE', value: '2027-06-01' } }) }).verdict, 'INSUFFICIENT');
  // a new K2 never falls back to the defaults
  const t = fx.terms(); delete t.insufficient_policy;
  assert.ok(run({}, { t }).reasonCodes.includes('PROMOTION_POLICY_MISSING'));
});

test('recheck of a legacy K2 uses the built-in defaults too (3 failed rechecks)', () => {
  const t = fx.terms({ k2_frozen_at: fx.LEGACY_K2_FROZEN_AT, review_endpoint: { kind: 'DATE', value: '2026-11-30' } }); delete t.insufficient_policy;
  const p = run({ events_per_month: 2, observed_sample_n: 100 }, { t });
  assert.equal(p.resolution.code, 'PAUSE_LOW_POWER');
  const r = engine.recheckPaused({ paused: p, terms: t, observed: { observed_sample_n: 10, events_per_month: 1 }, history: failedCheck(2), as_of: '2027-03-05T10:00:00+08:00' });
  assert.equal(r.state, 'PAUSE_ESCALATE_TO_OWNER');
});

test('sample-count endpoint: reached when the observed sample reaches the endpoint value', () => {
  const t = fx.terms({ k2_frozen_at: fx.LEGACY_K2_FROZEN_AT, review_endpoint: { kind: 'SAMPLE_N', value: 100 } });
  assert.equal(run({ observed_sample_n: 99, effect_ci: fx.ci(-0.02, 0.001) }, { t }).resolution.code, 'LEGACY_K2_CONTINUE_TO_ENDPOINT');
  assert.equal(run({ observed_sample_n: 100, effect_ci: fx.ci(-0.02, 0.001) }, { t }).resolution.code, 'PAUSE_LOW_VALUE');
});

test('cut-off is exact: 2026-11-23T01:13:00+08:00 is new, one second earlier is legacy', () => {
  assert.equal(insufficient.isLegacyK2('2026-11-23T01:13:00+08:00'), false);
  assert.equal(insufficient.isLegacyK2('2026-11-23T01:12:59+08:00'), true);
  assert.equal(insufficient.isLegacyK2('2026-11-22T17:12:59+00:00'.replace('+00:00', '+08:00')), true);
});

// ---- recheck ----
const paused = (code = 'PAUSE_LOW_POWER') => {
  const out = run(code === 'PAUSE_LOW_POWER' ? { events_per_month: 2, observed_sample_n: 100 } : { effect_ci: fx.ci(-0.02, 0.01) });
  assert.equal(out.resolution.code, code);
  return out;
};
const MONTHS = ['2026-12-05', '2027-01-05', '2027-02-05'];
const failedCheck = (n) => MONTHS.slice(0, n).map((d) => ({ as_of: `${d}T10:00:00+08:00`, state: 'STILL_PAUSED' }));

test('recheck: resume when 50% of the required sample is reached, or the rate recovers', () => {
  const p = paused();
  const r1 = engine.recheckPaused({ paused: p, terms: fx.terms(), observed: { observed_sample_n: 100, events_per_month: 2 }, history: [], as_of: '2026-12-05T10:00:00+08:00' });
  assert.equal(r1.state, 'RESUME');
  assert.equal(r1.nextAction, 'REJUDGE_UNDER_SECTION_4_2');
  const r2 = engine.recheckPaused({ paused: p, terms: fx.terms(), observed: { observed_sample_n: 40, events_per_month: 30 }, history: [], as_of: '2026-12-05T10:00:00+08:00' });
  assert.equal(r2.state, 'RESUME');
  const r3 = engine.recheckPaused({ paused: p, terms: fx.terms(), observed: { observed_sample_n: 40, events_per_month: 2 }, history: [], as_of: '2026-12-05T10:00:00+08:00' });
  assert.equal(r3.state, 'STILL_PAUSED');
  assert.equal(r3.failed_rechecks, 1);
});

test('recheck: low value resumes only on new mechanism evidence or a data-basis change', () => {
  const p = paused('PAUSE_LOW_VALUE');
  const at = '2026-12-05T10:00:00+08:00';
  assert.equal(engine.recheckPaused({ paused: p, terms: fx.terms(), observed: {}, history: [], as_of: at }).state, 'STILL_PAUSED');
  assert.equal(engine.recheckPaused({ paused: p, terms: fx.terms(), observed: { new_mechanism_evidence_ref: 'MECH-NEW-1' }, history: [], as_of: at }).state, 'RESUME');
  assert.equal(engine.recheckPaused({ paused: p, terms: fx.terms(), observed: { data_basis_change_ref: 'DS-2' }, history: [], as_of: at }).state, 'RESUME');
});

test('recheck: budget pause resumes when the next monthly budget fits the K2 share', () => {
  const p = run({ cost_to_continue: { model_cost_cny: 300, core_hours: 1 } });
  const r = engine.recheckPaused({ paused: p, terms: fx.terms(), observed: { cost_to_continue: { model_cost_cny: 300, core_hours: 1 }, market_monthly_budget: { model_cost_cny: 2000, core_hours: 100 } }, history: [], as_of: '2026-12-05T10:00:00+08:00' });
  assert.equal(r.state, 'RESUME');
});

test('recheck: after 3 failed rechecks it escalates to the Owner and never converts to 不做', () => {
  const p = paused();
  const base = { paused: p, terms: fx.terms(), observed: { observed_sample_n: 10, events_per_month: 1 } };
  const second = engine.recheckPaused({ ...base, history: failedCheck(1), as_of: '2027-02-05T10:00:00+08:00' });
  assert.equal(second.state, 'STILL_PAUSED');
  assert.equal(second.failed_rechecks, 2);
  assert.equal(second.escalate, false);
  const third = engine.recheckPaused({ ...base, history: failedCheck(2), as_of: '2027-03-05T10:00:00+08:00' });
  assert.equal(third.state, 'PAUSE_ESCALATE_TO_OWNER');
  assert.equal(third.failed_rechecks, 3);
  assert.equal(third.nextAction, 'PLAN_COORD_RECOMMENDS_TO_OWNER');
  assert.equal(third.conclusion, '暂停'); // still paused; the Owner decides
  const later = engine.recheckPaused({ ...base, history: failedCheck(3), as_of: '2027-04-05T10:00:00+08:00' });
  assert.equal(later.state, 'PAUSE_ESCALATE_TO_OWNER');
  assert.ok(!JSON.stringify([second, third, later]).includes('不做'));
  assert.ok(!JSON.stringify([second, third, later]).includes('SEAL_NOT_DO'));
});

test('recheck: the escalation count is read from the K2', () => {
  const p = paused();
  const t = fx.terms({ insufficient_policy: { ...fx.POLICY, max_failed_rechecks: 1 } });
  const r = engine.recheckPaused({ paused: p, terms: t, observed: { observed_sample_n: 10, events_per_month: 1 }, history: [], as_of: '2026-12-05T10:00:00+08:00' });
  assert.equal(r.state, 'PAUSE_ESCALATE_TO_OWNER');
});

test('recheck: once per CST month; only a paused result can be rechecked', () => {
  const p = paused();
  const base = { paused: p, terms: fx.terms(), observed: { observed_sample_n: 10, events_per_month: 1 } };
  const dup = engine.recheckPaused({ ...base, history: [{ as_of: '2026-12-02T10:00:00+08:00', state: 'STILL_PAUSED' }], as_of: '2026-12-30T10:00:00+08:00' });
  assert.equal(dup.state, 'INVALID_INPUT');
  assert.ok(dup.reasonCodes.includes('PROMOTION_RECHECK_ALREADY_DONE_THIS_MONTH'));
  const cont = engine.recheckPaused({ ...base, paused: run({}), history: [], as_of: '2026-12-05T10:00:00+08:00' });
  assert.equal(cont.state, 'INVALID_INPUT');
  assert.ok(cont.reasonCodes.includes('PROMOTION_RECHECK_NOT_PAUSED'));
});

// ---- information value ----
const item = (id, o = {}) => ({ candidate_id: id, market: 'CN_A', mechanism_prior_class: 'NORMAL_NO_PRIOR', effect_ci: fx.ci(0.01, 0.05), min_economic_value: 0.02, p_reach: 0.8, ...o });

test('information value: frozen config, formula, deterministic order', () => {
  const cfg = engine.valueConfig();
  assert.equal(cfg.schema, 'PROMOTION_INFORMATION_VALUE_CONFIG_V1');
  assert.match(engine.VALUE_CONFIG_SHA256, /^[0-9a-f]{64}$/);
  const hi = item('A', { mechanism_prior_class: 'NORMAL_CITE_PRIOR', effect_ci: fx.ci(0.03, 0.06), p_reach: 0.9 });
  const lo = item('B', { mechanism_prior_class: 'NORMAL_NO_PRIOR', effect_ci: fx.ci(-0.02, 0.03), p_reach: 0.6 });
  const out = engine.rankInformationValue([lo, hi], { market: 'CN_A' });
  assert.deepEqual(out.ranked.map((r) => r.candidate_id), ['A', 'B']);
  const prior = cfg.mechanism_prior_weight.NORMAL_CITE_PRIOR;
  assert.equal(out.ranked[0].score, Math.round(prior * 1 * 0.9 * 1e6) / 1e6); // CI fully above the threshold -> crossing 1
  const cross = (0.03 - 0.02) / (0.03 - -0.02);
  assert.equal(out.ranked[1].components.ci_crossing, Math.round(cross * 1e6) / 1e6);
  assert.deepEqual(engine.rankInformationValue([hi, lo], { market: 'CN_A' }), out);
});

test('information value: ties broken by candidate id; one market per ranking; only 做 items', () => {
  const out = engine.rankInformationValue([item('Z'), item('M'), item('C')], { market: 'CN_A' });
  assert.deepEqual(out.ranked.map((r) => r.candidate_id), ['C', 'M', 'Z']);
  assert.throws(() => engine.rankInformationValue([item('A'), item('B', { market: 'CRYPTO' })], { market: 'CN_A' }), /PROMOTION_VALUE_CROSS_MARKET/);
  const paused1 = engine.rankInformationValue([item('A'), item('P', { conclusion: '暂停' })], { market: 'CN_A' });
  assert.deepEqual(paused1.ranked.map((r) => r.candidate_id), ['A']);
  assert.deepEqual(paused1.excluded, [{ candidate_id: 'P', reason: 'NOT_A_DO_CONCLUSION' }]);
});

test('information value: an interval entirely below the threshold scores 0; unknown prior class is refused', () => {
  const out = engine.rankInformationValue([item('A', { effect_ci: fx.ci(-0.02, 0.01) })], { market: 'CN_A' });
  assert.equal(out.ranked[0].score, 0);
  assert.throws(() => engine.rankInformationValue([item('A', { mechanism_prior_class: 'MADE_UP' })], { market: 'CN_A' }), /PROMOTION_VALUE_PRIOR_CLASS_UNKNOWN/);
});

test('information value: a changed config file fails the pin', () => {
  assert.throws(() => engine.valueConfig({ ...engine.valueConfig(), weights: { prior: 2, ci_crossing: 1, p_reach: 1 } }), /PROMOTION_VALUE_CONFIG_PIN_MISMATCH/);
});

// ---- KPI 9 ----
test('KPI 9: mechanism-deduplicated S4 passes per CNY and per core-hour, monthly, split by layer; negatives apart', () => {
  const out = engine.kpi9({
    month_cst: '2026-12',
    s4_passes: [
      { candidate_id: 'A1', market: 'CN_A', layer: 'ALPHA', mechanism_ids: ['M.ONE'], s4_passed_at: '2026-12-03T10:00:00+08:00' },
      { candidate_id: 'A2', market: 'CN_A', layer: 'ALPHA', mechanism_ids: ['M.ONE'], s4_passed_at: '2026-12-09T10:00:00+08:00' }, // same mechanism: counted once
      { candidate_id: 'A3', market: 'CN_A', layer: 'ALPHA', mechanism_ids: ['M.TWO'], s4_passed_at: '2026-12-10T10:00:00+08:00' },
      { candidate_id: 'R1', market: 'CN_A', layer: 'RISK', mechanism_ids: ['M.ONE'], s4_passed_at: '2026-12-11T10:00:00+08:00' }, // other layer: separate row
      { candidate_id: 'OLD', market: 'CN_A', layer: 'ALPHA', mechanism_ids: ['M.NINE'], s4_passed_at: '2026-11-30T23:59:59+08:00' }, // other month
    ],
    costs: [
      { layer: 'ALPHA', market: 'CN_A', model_cost_cny: 400, core_hours: 50, month_cst: '2026-12' },
      { layer: 'ALPHA', market: 'CN_A', model_cost_cny: 100, core_hours: 50, month_cst: '2026-12' },
      { layer: 'RISK', market: 'CN_A', model_cost_cny: 250, core_hours: 0, month_cst: '2026-12' },
      { layer: 'EXECUTION', market: 'CN_A', model_cost_cny: 30, core_hours: 10, month_cst: '2026-12' },
    ],
    negatives: [{ layer: 'ALPHA', market: 'CN_A', month_cst: '2026-12', count: 4 }],
  });
  const row = (layer) => out.rows.find((r) => r.layer === layer && r.market === 'CN_A');
  assert.equal(row('ALPHA').independent_s4_passes, 2);
  assert.equal(row('ALPHA').model_cost_cny, 500);
  assert.equal(row('ALPHA').core_hours, 100);
  assert.equal(row('ALPHA').per_10k_cny, 40); // 2 / 500 * 10000
  assert.equal(row('ALPHA').per_core_hour, 0.02);
  assert.equal(row('ALPHA').negative_conclusions, 4); // reported apart: not in the numerator and not taken out of the cost
  assert.equal(row('RISK').independent_s4_passes, 1);
  assert.equal(row('RISK').per_core_hour, null); // zero denominator is N/A, not 0
  assert.equal(row('RISK').per_core_hour_reason, 'DENOMINATOR_ZERO');
  assert.equal(row('EXECUTION').independent_s4_passes, 0);
  assert.equal(row('EXECUTION').per_10k_cny, 0);
  assert.deepEqual(out.rows.map((r) => r.layer), ['ALPHA', 'EXECUTION', 'RISK']);
  assert.equal(out.month_cst, '2026-12');
});

test('KPI 9: negative conclusions do not reduce the denominator', () => {
  const mk = (negs) => engine.kpi9({ month_cst: '2026-12', s4_passes: [], costs: [{ layer: 'ALPHA', market: 'CN_A', model_cost_cny: 500, core_hours: 100, month_cst: '2026-12' }], negatives: negs });
  assert.equal(mk([]).rows[0].model_cost_cny, 500);
  assert.equal(mk([{ layer: 'ALPHA', market: 'CN_A', month_cst: '2026-12', count: 9 }]).rows[0].model_cost_cny, 500);
});
