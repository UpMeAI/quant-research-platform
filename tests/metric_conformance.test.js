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
 * METRIC_DEFINITIONS_V1 (draft) -- quant-research-platform's side of the consistency test.
 *
 * QRP computes almost nothing itself. services/baseline-evaluation and candidate-comparison print what the producers sealed
 * (summary values are taken "原样，不从序列推"); the numbers are made by the research runners that live in smartflow and V6
 * branches. So this file does three things:
 *
 *   1. holds the one metric implementation QRP does own (adapters/ashare-local backtestCurve) to the shared fixture;
 *   2. re-derives every sealed summary and every paired g (with its interval) in var/evidence from the sealed equity series,
 *      with the contract's reference -- the sealed Q1/Q2 numbers are the evidence that fixes the contract's conventions;
 *   3. records that the importer accepts a summary that disagrees with its own series (it checks end_capital only).
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
  [path.join(SUPPORT, 'metric-reference.js')]: '2a247f7d98f6cc8bd0f929d538e582bfb508ca715bf2ec0ed64a3fea6a259afb',
  [path.join(SUPPORT, 'metric-conformance-harness.js')]: '424a96969bbd08444ef6832c99717521e898de3a8396fc28c51fcf42a128bf4c',
  [FIXTURE]: '106236a9622519691318c49c9da146a504e79698301d02ae1cbeba8918b3f718',
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

// -- 3. what the importer does not check --------------------------------------------------------------------------------------

beforeEach(() => { fs.rmSync(k3.LEDGER(), { force: true }); k3.clearCache(); });

test('D-QRP-02: the importer accepts a summary that disagrees with its own equity series (it checks end_capital only)', () => {
  const doc = result();
  const arm = doc.arms.D;
  const m = ref.seriesMetrics(seriesOf({ ...arm, summary: { ...arm.summary, start_capital: arm.equity.values[0] } }, 252));
  // The synthetic fixture says max_drawdown 0.05, cagr 0.31 and 2 sessions under water for a six-mark series.
  assert.notEqual(r6(m.maxDrawdown), arm.summary.max_drawdown);
  assert.notEqual(r6(m.cagr), arm.summary.cagr);
  assert.doesNotThrow(() => k3.importBaselineEvaluation(write(doc), { registeredBy: AUTHORITY, allowNonActual: true }),
    'when the importer starts re-deriving cagr / max_drawdown / longest_underwater_sessions / recovered from the series, this record must be deleted');
});
