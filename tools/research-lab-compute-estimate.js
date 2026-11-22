#!/usr/bin/env node
'use strict';

/**
 * W24 compute estimate for ops-coord's Linux slot booking. `measure` runs the lab fixture (tiny synthetic CN_A panel, 5 candidates, RF1116 round on dev + validation)
 * and records wall time per phase, RSS, disk and fs call counts; `extrapolate` scales that to one real CN_A experiment run. Pure arithmetic, no host or secret in the output.
 *   node tools/research-lab-compute-estimate.js [--names 5000] [--days 1621] [--candidates 200]
 * The measurement runs the runner in one process (as the lane container does); wall time includes nothing but CPU and local file IO, the LLM generator's model latency is not in it.
 */
const SCHEMA = 'LAB_COMPUTE_ESTIMATE_V1';

class EstimateError extends Error { constructor(code) { super(code); this.code = code; } }
const pos = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** @param {object} m measurement (see measure()) @param {{names: number, days: number, candidates: number}} real */
function extrapolate(m, real) {
  if (!real || !pos(real.names) || !pos(real.days) || !pos(real.candidates)) throw new EstimateError('COMPUTE_ESTIMATE_SCALE_INVALID');
  if (!m || !m.fixture || !pos(m.fixture.panel_cells) || !pos(m.fixture.candidates)) throw new EstimateError('COMPUTE_ESTIMATE_MEASUREMENT_INVALID');
  const cells = (real.names * real.days) / m.fixture.panel_cells;
  const cand = real.candidates / m.fixture.candidates;
  const r1 = (x) => Math.round(x * 10) / 10;
  // generate = one panel build + per-candidate scoring; both grow with cells, scoring also with candidates: the measured total is scaled by both (an upper bound, the panel build is not repeated per candidate)
  const gen = (m.phases.generate_ms / 1000) * cells * cand;
  const sel = (m.phases.select_ms / 1000) * cells * cand;
  return {
    schema: SCHEMA, scale: { cells_ratio: cells, candidate_ratio: cand, real },
    wall_seconds: { generate: r1(gen), select: r1(sel), total: r1(gen + sel), hours: r1((gen + sel) / 3600) },
    rss_mb: { baseline: m.rss_mb.baseline, peak: Math.ceil(m.rss_mb.baseline + (m.rss_mb.peak - m.rss_mb.baseline) * cells) },
    disk_bytes: { input_read_only: Math.ceil(m.disk_bytes.data * cells), output_written: Math.ceil(m.disk_bytes.out * cand) },
    io: { bytes_read: Math.ceil((m.io.bytes_read || 0) * cells), fs_reads: Math.ceil(m.io.fs_reads * cells), fs_writes: Math.ceil(m.io.fs_writes * cand),
      pattern: 'Sequential read of the lane CSV tables once per panel build (mining segment, then mining + validation), no random access; small append-only ledger rows and one attempts.jsonl row per candidate; selection.json written once. IO is not the bottleneck, CPU and RAM are.' },
    threads: { active_cpu_threads: 1, libuv_pool: m.threads.libuv_pool, recommended_cpuset_threads: 2 },
    assumptions: [
      'Time and RSS scale linearly with panel cells (names x trading days) from one 15-name fixture; real cross-sections are neutralised per day (industry + size), which is linear in names but may add a log factor.',
      'Candidates are scored one after another in one Node process (single CPU thread); the libuv pool only serves file IO. The extrapolation is an upper bound: the panel build is counted per candidate.',
      'The LLM generator adds model latency and token metering outside this CPU figure; it is bounded by the round limits in config/mining_llm_generator.v1.json.',
      'Scoring of the locked holdout is a separate one-off phase on or after 2027-01-01 and is not in this estimate.',
    ],
  };
}

/** Run the fixture once and measure it. Returns the measurement for extrapolate(). */
async function measure() {
  const fs = require('fs'); const path = require('path');
  require('../tests/_env');
  const { buildWorld, miningFixture } = require('../tests/_lab_fixture');
  const runner = require('../services/mining-sandbox/round-runner');
  const lab = require('../services/research-lab-e2e');
  const dirSize = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
  const t0 = process.hrtime.bigint();
  const w = await buildWorld();
  const fx = miningFixture();
  const setupMs = ms(t0);
  const baseline = Math.round(process.memoryUsage().rss / 1e6);
  // phase timers and fs counters around the real run
  const phases = { generate_ms: 0, select_ms: 0 };
  const io = { read_calls: 0, read_bytes: 0, write_calls: 0 };
  for (const [name, key] of [['generate', 'generate_ms'], ['select', 'select_ms']]) {
    const orig = runner[name];
    runner[name] = (...a) => { const t = process.hrtime.bigint(); try { return orig(...a); } finally { phases[key] += ms(t); } };
  }
  const rs = fs.readSync; fs.readSync = (...a) => { const n = rs(...a); io.read_calls += 1; io.read_bytes += n; return n; };
  const wf = fs.writeFileSync; const af = fs.appendFileSync;
  fs.writeFileSync = (...a) => { io.write_calls += 1; return wf(...a); };
  fs.appendFileSync = (...a) => { io.write_calls += 1; return af(...a); };
  const c0 = process.cpuUsage(); const t1 = process.hrtime.bigint();
  const res = lab.run(w.job, w.services);
  const wallMs = ms(t1); const c1 = process.cpuUsage(c0);
  fs.readSync = rs; fs.writeFileSync = wf; fs.appendFileSync = af;
  if (res.status !== 'COMPLETE') throw new EstimateError(`COMPUTE_ESTIMATE_FIXTURE_RUN_${res.status}`);
  const lineage = JSON.parse(fs.readFileSync(res.lineage_path, 'utf8'));
  const sel = JSON.parse(fs.readFileSync(path.join(w.outDir, 'steps/07_EXPERIMENT/selection.json'), 'utf8'));
  const panel = sel.validation_panel; // the widest panel of the run: dev + validation segments
  return {
    fixture: { names: panel.codes, days: panel.dates, fields: panel.readings.length, panel_cells: panel.codes * panel.dates, candidates: lineage.attempts.length, input_bytes: dirSize(fx.dirs.lane) + dirSize(fx.dirs.tail) },
    phases: { setup_ms: Math.round(setupMs), generate_ms: Math.round(phases.generate_ms), select_ms: Math.round(phases.select_ms), whole_chain_ms: Math.round(wallMs) },
    rss_mb: { baseline, peak: Math.round(process.resourceUsage().maxRSS / 1024) }, disk_bytes: { data: dirSize(fx.dirs.lane) + dirSize(fx.dirs.tail), out: dirSize(path.join(w.work, 'lane-out')) },
    io: { fs_reads: io.read_calls, fs_writes: io.write_calls, bytes_read: io.read_bytes }, threads: { main: 1, libuv_pool: Number(process.env.UV_THREADPOOL_SIZE || 4) },
    cpu_over_wall: Math.round(((c1.user + c1.system) / 1000 / wallMs) * 100) / 100,
  };
}

async function main(argv) {
  const o = { names: 5000, days: 1621, candidates: 200 };
  for (let i = 0; i < argv.length; i += 2) { const k = argv[i].replace(/^--/, ''); if (!(k in o)) throw new EstimateError(`COMPUTE_ESTIMATE_OPTION_UNKNOWN:${argv[i]}`); o[k] = Number(argv[i + 1]); }
  const m = await measure();
  process.stdout.write(`${JSON.stringify({ measurement: m, estimate: extrapolate(m, o) }, null, 1)}\n`);
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.code || 'ERROR'}: ${e.message}\n`); process.exitCode = 2; });

module.exports = { SCHEMA, EstimateError, extrapolate, measure };
