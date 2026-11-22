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
