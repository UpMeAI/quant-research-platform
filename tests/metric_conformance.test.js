'use strict';
require('./_env');
const test = require('node:test');
const { beforeEach } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

/**
 * METRIC_DEFINITIONS_V1 (FROZEN 2026-10-31) -- quant-research-platform's side of the consistency test.
 *
 * QRP computes almost nothing itself. services/baseline-evaluation and candidate-comparison print what the producers sealed
 * (summary values are taken "原样，不从序列推"); the numbers are made by the research runners that live in smartflow and V6
 * branches. So this file does three things:
 *
 *   1. holds the one metric implementation QRP does own (adapters/ashare-local backtestCurve) to the shared fixture;
 *   2. re-derives every sealed summary and every paired g (with its interval) in var/evidence from the sealed equity series,
 *      with the contract's reference -- the sealed Q1/Q2 numbers are the evidence that fixes the contract's conventions;
 *   3. holds the importer's new re-derivation (services/baseline-evaluation/summary_rederive.js) to the same fixture and shows it
 *      refusing a summary that disagrees with its series (D-QRP-02, fixed).
 *
 * No production file is changed.
 */

const H = require('./support/metric-conformance-harness');
const ref = require('./support/metric-reference');
const { backtestCurve } = require('../adapters/ashare-local/backtest_engine');
const { FWD_DAYS } = require('../adapters/ashare-local/strategy_vpq');
const k3 = require('../services/baseline-evaluation');
const { result, write } = require('./_q0_fixture');

const FIXTURE = path.join(__dirname, 'fixtures', 'metric-conformance', 'METRIC_CONFORMANCE_FIXTURE_V1.json');
const SUPPORT = path.join(__dirname, 'support');
const PINS = {
  [path.join(SUPPORT, 'metric-reference.js')]: 'b0bfb6741a6837e76a58e2a3b0d25cfd60323e07cd9dcecfd91669fa6e8e732f',
  [path.join(SUPPORT, 'metric-conformance-harness.js')]: '424a96969bbd08444ef6832c99717521e898de3a8396fc28c51fcf42a128bf4c',
  [FIXTURE]: 'cb7ca1ae31a171c1b847342d8fc959137e879bc1a63200f46f67b7e712573b39',
};

const fixture = H.loadFixture(FIXTURE);
const r6 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6);
/** The exporter rounds to six decimals (§10): a value equal to the reference at six decimals is the reference. */
const atSix = (actual, expected) => (typeof expected === 'number' && actual === r6(expected) ? expected : actual);

// -- 1. the one implementation QRP owns --------------------------------------------------------------------------------

/**
 * backtestCurve is a signal-layer backtest, not a metrics function: it takes bars and GOOD-signal rows. A world in which every
 * session has a position on one instrument and costPerSide is 0 gives daily returns equal to the instrument's, so the fixture's
 * return sample can be fed through it. Cases with a gap cannot be represented (the engine's dates are the union of bar dates).
 */
function backtestWorld(c) {
  const bars = [{ d: '0000-00-00', close: 100, vol: 1 }, ...c.marks.map((m) => ({ d: m.day, close: (100 * m.equity) / c.capital0, vol: 1 }))];
  const rows = [];
  for (let i = 0; i + FWD_DAYS <= bars.length - 1; i += 1) rows.push({ inst: 'X', i, patterns: { v: 'GOOD' } });
  return backtestCurve(new Map([['X', bars]]), rows, 'v', { costPerSide: 0, dateFrom: c.marks[0].day });
}

const IMPLEMENTATIONS = [{
  id: 'QRP-ashare-local-backtestCurve',
  source: 'adapters/ashare-local/backtest_engine.js backtestCurve(...).summary (rounded to six decimals by the engine)',
  series: (c) => {
    if (c.expected.gapMarks > 0) return null;
    const s = backtestWorld(c).summary;
    const e = c.expected;
    const out = {
      totalReturn: atSix(s.cumRet, e.totalReturn),
      maxDrawdown: atSix(Math.abs(s.maxDrawdown), e.maxDrawdown),
      cagr: atSix(s.cagr, e.cagr),
      calmar: atSix(s.calmar, e.calmar),
    };
    if (e.state === 'MEASURED') {
      out.annualVol = atSix(s.annualized_vol, e.annualVol);
      // sharpe_like is CAGR / annualised vol, not mean / sd * sqrt(A): a different quantity under the same name (D-QRP-01).
      out.sharpe = atSix(s.sharpe_like, e.sharpe);
    }
    return out;
  },
}];

IMPLEMENTATIONS.push({
  id: 'QRP-summary-rederive',
  source: 'services/baseline-evaluation/summary_rederive.js summaryFromSeries(values, startCapital, A) -- what the importer now checks the sealed summaries against',
  series: (c) => {
    if (c.expected.gapMarks > 0) return null; // a sealed series is a list of consecutive marks: no gap can be represented
    const m = require('../services/baseline-evaluation/summary_rederive').summaryFromSeries(c.marks.map((x) => x.equity), c.capital0, c.annualFactor);
    return { cagr: m.cagr, maxDrawdown: m.max_drawdown, longestUnderwaterSessions: m.longest_underwater_sessions, recovered: m.recovered };
  },
});

const KNOWN_DIFFERENCES = require('./metric_conformance.known.json');

test('the vendored fixture, reference and harness are the ones METRIC_DEFINITIONS_V1 pins', () => {
  assert.deepEqual(H.pinProblems(PINS), []);
  assert.equal(fs.readFileSync(`${FIXTURE}.sha256`, 'utf8').split(/\s+/)[0], PINS[FIXTURE]);
  const rebuilt = ref.seriesMetrics(fixture.series.find((c) => c.id === 'PATH_HAND_12'));
  assert.equal(rebuilt.longestUnderwaterSessions, 4, 'the vendored reference still reads the hand-checkable path the way the fixture says');
});

test('qrp metric implementation against METRIC_DEFINITIONS_V1', (t) => {
  const rows = H.compareAll(fixture, IMPLEMENTATIONS);
  const result_ = H.classify(rows, KNOWN_DIFFERENCES);
  t.diagnostic(JSON.stringify(H.summary(result_)));
  H.writeArtifacts(rows, result_, { repo: 'quant-research-platform', fixture: 'METRIC_CONFORMANCE_FIXTURE_V1', implementations: IMPLEMENTATIONS.map((i) => ({ id: i.id, source: i.source })) });
  const lines = result_.unexpected.map((r) => `${r.why} ${r.impl}|${r.caseId}|${r.metric} expected=${H.recordable(r.expected)} actual=${H.recordable(r.actual)}`);
  assert.deepEqual(lines, [], `${lines.length} comparison(s) are neither equal nor recorded; draft entries:\n${JSON.stringify(H.draftKnown(result_.unexpected), null, 1)}`);
  assert.ok(H.summary(result_)['QRP-ashare-local-backtestCurve'], 'the engine was compared on something');
});

// -- 2. the sealed evidence, re-derived ------------------------------------------------------------------------------------

const EVIDENCE = path.join(__dirname, '..', 'var', 'evidence');
const SEALED = fs.existsSync(EVIDENCE)
  ? fs.readdirSync(EVIDENCE).flatMap((dir) => fs.readdirSync(path.join(EVIDENCE, dir)).filter((f) => /^US_V5_M2_Q\d.*_RESULT_V1\.json$/.test(f)).map((f) => path.join(EVIDENCE, dir, f)))
  : [];

const seriesOf = (arm, A) => ({ market: 'US', annualFactor: A, capital0: arm.summary.start_capital,
  marks: arm.equity.dates.map((day, i) => ({ day, state: 'MEASURED', equity: arm.equity.values[i] })) });

test('the sealed US_V5_M2 results are present (the evidence that fixes the contract conventions)', () => {
  assert.ok(SEALED.length >= 4, `expected the Q0, Q0-current, Q1 and Q2 sealed results under var/evidence, found ${SEALED.length}`);
});

for (const file of SEALED) {
  test(`sealed ${path.basename(path.dirname(file))}: every arm's summary and the paired g re-derive from its own equity series`, () => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const A = 252;
    let arms = 0;
    for (const [key, arm] of Object.entries(doc.arms || {})) {
      if (!arm || !arm.equity || !arm.summary || arm.summary.start_capital === undefined) continue;
      const m = ref.seriesMetrics(seriesOf(arm, A));
      const s = arm.summary;
      assert.equal(r6(m.cagr), s.cagr, `${key} cagr (session-count years: nav^(252/T) - 1, T = the number of marks)`);
      assert.equal(r6(m.maxDrawdown), s.max_drawdown, `${key} max_drawdown (peak seeded at the starting capital, positive fraction)`);
      assert.equal(m.longestUnderwaterSessions, s.longest_underwater_sessions, `${key} longest_underwater_sessions`);
      assert.equal(m.recovered, s.recovered, `${key} recovered`);
      assert.ok(Math.abs(arm.equity.values[arm.equity.values.length - 1] - s.end_capital) < 1e-6, `${key} end_capital`);
      arms += 1;
    }
    assert.ok(arms >= 2, 'at least two arms carry a series and a summary');
    const pg = doc.comparison && doc.comparison.paired_g;
    if (pg) {
      const candidate = Object.keys(doc.arms).find((k) => k.startsWith('CANDIDATE'));
      const g = ref.pairedG(seriesOf(doc.arms[candidate], A), seriesOf(doc.arms.BASELINE, A), A);
      assert.equal(r6(g.g), pg.g, 'paired g = 252 * sum(x) / sum(k), x the daily log-return difference');
      assert.deepEqual(g.ci95.map(r6), pg.ci95, 'monthly-block bootstrap: 10,000 resamples, seed 20261025, mulberry32, floor-rank 2.5% / 97.5%');
      assert.equal(g.sessions, pg.sessions);
      assert.equal(g.months, pg.months);
    }
  });
}

// -- 3. the importer re-derives the summary from the series (D-QRP-02, fixed) -----------------------------------------------------

const summaryCheck = require('../services/baseline-evaluation/summary_rederive');
const cc = require('../services/candidate-comparison');

beforeEach(() => { fs.rmSync(k3.LEDGER(), { force: true }); k3.clearCache(); });

/** The synthetic fixture's summaries are arbitrary numbers; this makes each arm's summary the contract's, with its starting capital. */
function consistent(doc, startCapital = 3000) {
  for (const arm of Object.values(doc.arms)) {
    if (!arm.equity) continue;
    const m = ref.seriesMetrics(seriesOf({ ...arm, summary: { start_capital: startCapital } }, 252));
    arm.summary = { ...arm.summary, start_capital: startCapital, end_capital: arm.equity.values[arm.equity.values.length - 1], cagr: r6(m.cagr), max_drawdown: r6(m.maxDrawdown),
      longest_underwater_sessions: m.longestUnderwaterSessions, recovered: m.recovered };
  }
  return doc;
}
const importer = (doc) => k3.importBaselineEvaluation(write(doc), { registeredBy: AUTHORITY, allowNonActual: true });

test('D-QRP-02 fixed: a summary that agrees with its equity series (with start_capital) imports', () => {
  assert.doesNotThrow(() => importer(consistent(result())));
});

for (const [field, tampered] of [['cagr', 0.31], ['max_drawdown', 0.05], ['longest_underwater_sessions', 5], ['recovered', false]]) {
  test(`D-QRP-02 fixed: ${field} that disagrees with the equity series is refused as INVALID, naming the field`, () => {
    const doc = consistent(result());
    doc.arms.D.summary[field] = tampered;
    assert.throws(() => importer(doc), (error) => error.code === 'INVALID' && error.message.includes(`arms.D.summary.${field}`) && error.message.includes('重算'),
      'the importer must say which summary field disagrees with the series');
  });
}

test('an arm without start_capital is not re-derived (the base cannot be known); the check says so instead of passing it', () => {
  const doc = result(); // the synthetic fixture: no start_capital, arbitrary summaries
  assert.doesNotThrow(() => importer(doc));
  const arm = doc.arms.D;
  assert.deepEqual(summaryCheck.check(arm.equity.values, arm.summary, 'US_EQUITY'), { checked: false, reason: 'NO_START_CAPITAL', problems: [] });
  const withStart = { ...arm.summary, start_capital: 3000 };
  assert.deepEqual(summaryCheck.check(arm.equity.values, withStart, 'SOME_NEW_MARKET'), { checked: false, reason: 'NO_ANNUAL_FACTOR:SOME_NEW_MARKET', problems: [] });
  assert.equal(summaryCheck.check(arm.equity.values, { ...arm.summary, start_capital: -1 }, 'US_EQUITY').problems[0].field, 'start_capital');
});

test('the real sealed Q0, Q1 and Q2 files import through the new check, and a Q2 arm summary that is off is refused', () => {
  const ev = (dir, file) => path.join(EVIDENCE, dir, file);
  const lock = k3.importBaselineEvaluation(ev('us-v5-m2-q0-current-2026-10-25', 'US_V5_M2_Q0_RESULT_V1.json'), { registeredBy: AUTHORITY });
  assert.match(lock.result_id, /^Q0-/);
  for (const [dir, file] of [['us-v5-m2-q1-2026-10-25', 'US_V5_M2_Q1_RESULT_V1.json'], ['us-v5-m2-q2-2026-10-25', 'US_V5_M2_Q2_RESULT_V1.json']]) {
    assert.match(cc.importCandidateComparison(ev(dir, file), { registeredBy: AUTHORITY }).result_id, /^Q\d-/);
  }
  const doc = JSON.parse(fs.readFileSync(ev('us-v5-m2-q2-2026-10-25', 'US_V5_M2_Q2_RESULT_V1.json'), 'utf8'));
  doc.arms.CANDIDATE_1X.summary.max_drawdown += 0.01;
  fs.rmSync(cc.LEDGER(), { force: true });
  assert.throws(() => cc.importCandidateComparison(write(doc), { registeredBy: AUTHORITY, allowNonActual: true }),
    (error) => /arms\.CANDIDATE_1X\.summary\.max_drawdown.*重算/.test(error.message));
});
