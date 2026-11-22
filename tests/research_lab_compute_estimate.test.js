'use strict';
/**
 * W24 compute estimate (for ops-coord's Linux slot booking): the extrapolation from a fixture measurement to one real CN_A RF1116 run (dev + validation)
 * is a pure function of the measurement and the scale; this checks its arithmetic and its output shape. The measurement itself is tools/research-lab-compute-estimate.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const est = require('../tools/research-lab-compute-estimate');

const measured = { fixture: { names: 15, days: 600, fields: 20, panel_cells: 15 * 600, candidates: 5 }, phases: { generate_ms: 1000, select_ms: 2000, setup_ms: 500 },
  rss_mb: { baseline: 100, peak: 400 }, disk_bytes: { data: 1e6, out: 2e5 }, io: { fs_reads: 1000, fs_writes: 500 }, threads: { main: 1, libuv_pool: 4 } };
const real = { names: 5000, days: 1600, candidates: 200 };

test('extrapolate: wall time scales with panel cells and candidate count, RSS with panel cells above the baseline, disk with data rows; shape is stable', () => {
  const e = est.extrapolate(measured, real);
  assert.equal(e.schema, 'LAB_COMPUTE_ESTIMATE_V1');
  assert.equal(e.scale.cells_ratio, (5000 * 1600) / (15 * 600));
  assert.equal(e.scale.candidate_ratio, 40);
  assert.ok(e.wall_seconds.generate > measured.phases.generate_ms / 1000);
  assert.ok(e.rss_mb.peak > measured.rss_mb.peak);
  assert.deepEqual(Object.keys(e.threads).sort(), ['active_cpu_threads', 'libuv_pool', 'recommended_cpuset_threads']);
  assert.equal(e.threads.active_cpu_threads, 1);
  assert.ok(e.io.pattern.length > 20, 'the IO pattern is described');
  assert.ok(e.assumptions.length >= 3);
  assert.deepEqual(est.extrapolate(measured, real), e, 'pure');
});

test('extrapolate refuses nonsense scales', () => {
  assert.throws(() => est.extrapolate(measured, { names: 0, days: 1, candidates: 1 }), /COMPUTE_ESTIMATE_SCALE_INVALID/);
  assert.throws(() => est.extrapolate({ ...measured, fixture: { ...measured.fixture, panel_cells: 0 } }, real), /COMPUTE_ESTIMATE_MEASUREMENT_INVALID/);
});

/* ---- the backtester section (W24b NOTE_1): pure arithmetic over a measurement ---- */
const pointsOf = (a, b, c) => [250, 500, 1000, 2000].map((names) => ({ names, ms_per_day: a + (b * names) / 1e3 + (c * names * Math.log2(names)) / 1e3, trades_per_day: 1 }));
const btMeasured = { fixture: { names: 15, days: 1621, panel_cells: 15 * 1621, rss_baseline_mb: 300,
  WEEKLY: { arm_ms: { portfolio_with: 5, portfolio_without: 1 }, panel_ms: 1200, trades_per_decision_day: 0.8, rss_peak_mb: 400 },
  DAILY: { arm_ms: { portfolio_with: 5, portfolio_without: 1 }, panel_ms: 1200, trades_per_decision_day: 4, rss_peak_mb: 400 } },
probe: { points: { universe: { DAILY: pointsOf(0.05, 0, 0.1), WEEKLY: pointsOf(0.05, 0, 0.05) }, quantile: { DAILY: pointsOf(0.1, 1, 0), WEEKLY: pointsOf(0.1, 0.4, 0) } } } };

test('fitDay recovers a + b*N + c*N*log2(N) and drops negative terms', () => {
  const f = est.fitDay(pointsOf(0.2, 0.5, 0.1));
  assert.ok(Math.abs(f.a - 0.2) < 1e-6 && Math.abs(f.b - 0.5) < 1e-6 && Math.abs(f.c - 0.1) < 1e-6, JSON.stringify(f));
  const g = est.fitDay(pointsOf(0, 1, 0));
  assert.ok(g.a >= 0 && g.b > 0 && g.c >= 0);
});

test('extrapolateBacktest: six arms, hours and RSS as numbers, names x days and days-only terms stated, pure; refuses nonsense', () => {
  const real = { names: 5000, days: 1621 };
  const e = est.extrapolateBacktest(btMeasured, real);
  assert.equal(e.schema, 'LAB_BACKTEST_COMPUTE_ESTIMATE_V1');
  assert.equal(e.scale.arms, 6);
  for (const mode of ['DAILY', 'WEEKLY']) {
    assert.deepEqual(Object.keys(e.modes[mode].arm_hours).sort(), ['baseline', 'candidate', 'param_minus_20', 'param_plus_20']);
    assert.ok(e.modes[mode].total_hours.upper >= e.modes[mode].total_hours.linear_panel && e.modes[mode].total_hours.linear_panel > 0);
  }
  assert.ok(e.modes.DAILY.arm_seconds.candidate >= e.modes.WEEKLY.arm_seconds.candidate, 'daily decides more often');
  assert.ok(Number.isFinite(e.rss_gb.peak) && e.rss_gb.peak > 0 && e.rss_gb.steady_state_panel_and_values > 0);
  assert.ok(e.scaling.names_x_days.length && e.scaling.days_only.length && e.scaling.names_log_names_x_days.length);
  assert.deepEqual(est.extrapolateBacktest(btMeasured, real), e);
  assert.throws(() => est.extrapolateBacktest(btMeasured, { names: 0, days: 1 }), /COMPUTE_ESTIMATE_SCALE_INVALID/);
  assert.throws(() => est.extrapolateBacktest({}, real), /COMPUTE_ESTIMATE_MEASUREMENT_INVALID/);
});
