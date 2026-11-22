#!/usr/bin/env node
'use strict';

/**
 * W24 compute estimate for ops-coord's Linux slot booking. `measure` runs the lab fixture (tiny synthetic CN_A panel, 5 candidates, RF1116 round on dev + validation)
 * and records wall time per phase, RSS, disk and fs call counts; `extrapolate` scales that to one real CN_A experiment run. Pure arithmetic, no host or secret in the output.
 *   node tools/research-lab-compute-estimate.js [--names 5000] [--days 1621] [--candidates 200]
 *   node tools/research-lab-compute-estimate.js --backtest     (the W24b backtester: six arms on the fixture, per-arm ms, RSS, extrapolation to 5,000 names x 1,621 days)
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

/* ------------------------------------------------------------------ backtester (W24b NOTE_1): six arms in one process */

const BACKTEST_SCHEMA = 'LAB_BACKTEST_COMPUTE_ESTIMATE_V1';
const ARM_KINDS = Object.freeze({ baseline: 'universe', candidate: 'quantile', param_minus_20: 'quantile', param_plus_20: 'quantile' });

/** The per-day cost features: a constant (days only), names (names x days) and names x log2(names) (ranking), in units of 1,000 names. */
const FEATURES = Object.freeze([() => 1, (n) => n / 1e3, (n) => (n * Math.log2(n)) / 1e3]);
/** Least-squares fit of ms per decision day = a + b*N + c*N*log2(N) over the probes; a term that comes out negative is dropped and the rest refitted. Returns the coefficients in FEATURES units. */
function fitDay(points) {
  let use = [0, 1, 2];
  for (;;) {
    const k = use.length;
    const M = use.map((a) => [...use.map((b) => points.reduce((s, p) => s + FEATURES[a](p.names) * FEATURES[b](p.names), 0)), points.reduce((s, p) => s + FEATURES[a](p.names) * p.ms_per_day, 0)]);
    for (let i = 0; i < k; i += 1) {
      let piv = i; for (let r = i + 1; r < k; r += 1) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
      [M[i], M[piv]] = [M[piv], M[i]];
      if (Math.abs(M[i][i]) < 1e-12) return { a: 0, b: 0, c: 0 };
      for (let r = 0; r < k; r += 1) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c <= k; c += 1) M[r][c] -= f * M[i][c]; }
    }
    const coef = use.map((_, i) => M[i][k] / M[i][i]);
    const neg = coef.findIndex((c) => !(c >= 0));
    if (neg < 0 || use.length === 1) { const out = [0, 0, 0]; use.forEach((u, i) => { out[u] = Math.max(0, coef[i]); }); return { a: out[0], b: out[1], c: out[2] }; }
    use = use.filter((_, i) => i !== neg);
  }
}
const msPerDay = (f, n) => f.a * FEATURES[0](n) + f.b * FEATURES[1](n) + f.c * FEATURES[2](n);

/** A synthetic panel (random-walk opens, flat universe, MAIN board) of the shape simulateArm reads: N names x T days. Deterministic. */
function syntheticPanel(N, T) {
  const { mulberry32, weekdays } = require('../tests/_lab_replay_fixture');
  const rnd = mulberry32(1234); const dates = weekdays('2025-01-02', T);
  const codes = Array.from({ length: N }, (_, j) => `${j % 2 ? '60' : '00'}${String(1000 + j).padStart(4, '0')}${j % 2 ? '.SH' : '.SZ'}`);
  const px = new Array(N).fill(10); const open = []; const prev = [];
  for (let t = 0; t < T; t += 1) { prev.push(px.slice()); for (let j = 0; j < N; j += 1) px[j] *= 1 + (rnd() - 0.5) * 0.04; open.push(px.slice()); }
  const grid = (f) => dates.map((_, t) => codes.map((_, j) => f(t, j)));
  return { panel: { dates, codes, universe: grid(() => true), board: codes.map(() => 'MAIN'), st: grid(() => false), readings: { amount: grid(() => 5e7) }, labels: { exec_open: open, open_raw: open, prev_close_raw: prev } },
    values: grid(() => rnd()) };
}

/** Probe simulateArm at several names counts (synthetic panels, a few hundred days) for both arm kinds and both rebalance rules. */
function probeArms({ sizes = [250, 500, 1000, 2000], days = 120 } = {}) {
  const bt = require('../services/research-lab-e2e/backtester');
  const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
  const out = { sizes, days, points: { universe: { DAILY: [], WEEKLY: [] }, quantile: { DAILY: [], WEEKLY: [] } } };
  for (const names of sizes) {
    const sp = syntheticPanel(names, days);
    for (const kind of ['universe', 'quantile']) {
      for (const rebalance of ['DAILY', 'WEEKLY']) {
        const t = process.hrtime.bigint();
        const r = bt.internals.simulateArm({ panel: sp.panel, values: sp.values, rule: { rebalance, quantile: 0.2, initialNav: 1e9 }, startIndex: 0, universeOnly: kind === 'universe' });
        out.points[kind][rebalance].push({ names, ms_per_day: ms(t) / (days - 1), trades_per_day: r.trades.length / (days - 1) });
      }
    }
  }
  return out;
}

/** Measure the backtester on the fixture (15 names x 1,621 days, six arms) and probe the per-day scaling. */
function measureBacktest() {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  require('../tests/_env');
  const { makeMiningDataFixture } = require('../tests/_mining_data_fixture');
  const R = require('../tests/_lab_replay_fixture');
  const adapter = require('../services/mining-sandbox/data-adapter');
  const bt = require('../services/research-lab-e2e/backtester');
  const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-bt-est-')));
  const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
  const rnd = R.mulberry32(3); const book = R.weekdays('2020-06-01', 1700).map((date) => ({ date, net: 0.0002 + (rnd() - 0.5) * 0.008 }));
  const baseline = Math.round(process.resourceUsage().maxRSS / 1024);
  const fixture = {};
  for (const rebalance of ['WEEKLY', 'DAILY']) {
    const res = bt.run({ formula: 'rank((-ret_1d))', sources: sources(), rules: { rebalance, initialNav: 1e6 }, existingBook: book, candidateId: 'EST-001', market: 'CN_A', costBook: 'STOCK_BOOK', costModelRef: 'EST_COSTS_V1' });
    if (res.refusal) throw new EstimateError(`COMPUTE_ESTIMATE_BACKTEST_${res.refusal}`);
    fixture[rebalance] = { arm_ms: res.timing.arm_ms, panel_ms: res.timing.panel_ms, total_ms: res.timing.total_ms, trades: res.replay.trades.length, trades_per_decision_day: res.replay.trades.length / res.diagnostics.panel.common_dates,
      rss_peak_mb: Math.round(process.resourceUsage().maxRSS / 1024) };
  }
  const probe = probeArms();
  return { fixture: { names: 15, days: 1621, panel_cells: 15 * 1621, ...fixture, rss_baseline_mb: baseline }, probe };
}

/** The measured panel carries this many names x days matrices (readings 13, labels 3, industry, size, universe, st) plus the factor values and the neutralisation's two working copies. */
const PANEL_MATRICES = 13 + 3 + 4 + 3;
/** @param {object} m measureBacktest() @param {{names: number, days: number}} real */
function extrapolateBacktest(m, real) {
  if (!real || !pos(real.names) || !pos(real.days)) throw new EstimateError('COMPUTE_ESTIMATE_SCALE_INVALID');
  if (!m || !m.fixture || !m.probe) throw new EstimateError('COMPUTE_ESTIMATE_MEASUREMENT_INVALID');
  const r1 = (x) => Math.round(x * 10) / 10; const r3 = (x) => Math.round(x * 1000) / 1000;
  const cellsRatio = (real.names * real.days) / m.fixture.panel_cells;
  const logRatio = Math.log2(real.names) / Math.log2(m.fixture.names);
  const perMode = {};
  for (const rebalance of ['DAILY', 'WEEKLY']) {
    const fit = {}; const armHours = {}; const armSeconds = {};
    for (const [arm, kind] of Object.entries(ARM_KINDS)) {
      const f = fitDay(m.probe.points[kind][rebalance]); fit[kind] = f;
      const perDay = msPerDay(f, real.names); // ms
      armHours[arm] = r3((perDay * real.days) / 3.6e6); armSeconds[arm] = r1((perDay * real.days) / 1e3);
    }
    const sim = Object.values(armHours).reduce((a, b) => a + b, 0);
    const fixtureWall = m.fixture[rebalance];
    const portfolioMs = ((fixtureWall.arm_ms.portfolio_with + fixtureWall.arm_ms.portfolio_without) / m.fixture.days) * real.days; // days only
    const panelLinear = (fixtureWall.panel_ms / 3.6e6) * cellsRatio;
    perMode[rebalance] = { arm_seconds: armSeconds, arm_hours: armHours, portfolio_hours: r3(portfolioMs / 3.6e6), panel_hours: { linear_in_cells: r3(panelLinear), upper_with_log_factor: r3(panelLinear * logRatio) },
      total_hours: { linear_panel: r3(sim + portfolioMs / 3.6e6 + panelLinear), upper: r3(sim + portfolioMs / 3.6e6 + panelLinear * logRatio) }, fit_ms_per_day: { units: 'ms per decision day = a + b*(N/1000) + c*(N*log2(N)/1000)', ...fit } };
  }
  const cells = real.names * real.days;
  const gb = (x) => r1(x / 1e9);
  const f0 = m.fixture;
  const scaledGb = r1((((Math.max(f0.WEEKLY.rss_peak_mb, f0.DAILY.rss_peak_mb) - f0.rss_baseline_mb) * cellsRatio) + f0.rss_baseline_mb) / 1e3); // same method as extrapolate(): the panel build's transient peak
  const panelBytes = PANEL_MATRICES * cells * 8 * 1.5; // doubles, JS arrays-of-arrays overhead 1.5x
  const armState = real.names * 3 * 8 + cells * 0; // units, last, want per name (the arm walks the panel, it holds no copy of it)
  const tradesBytes = Math.ceil(m.fixture.WEEKLY.trades_per_decision_day * (real.names / m.fixture.names) * real.days) * 160; // one trade object ~ 160 B
  return {
    schema: BACKTEST_SCHEMA, scale: { real, cells_ratio: cellsRatio, log_names_ratio: r3(logRatio), arms: 6, decision_days_per_arm: real.days },
    fixture_measured: m.fixture, probe: m.probe,
    modes: perMode,
    rss_gb: { steady_state_panel_and_values: gb(panelBytes), arm_state_and_trades: gb(armState + tradesBytes), peak: scaledGb, matrices: PANEL_MATRICES,
      note: 'peak = the fixture RSS growth (panel build, evaluation, six arms) scaled by names x days, the same method as the round estimate (the backtester builds the same panel as the runner, so its peak is the panel build\'s transient); steady_state = matrix count x cells x 8 bytes x 1.5 after the build. The arms are serial and reuse the one panel.' },
    scaling: {
      names_x_days: ['panel build (buildPanel, CSV tables to matrices)', 'DSL evaluation and neutralisation inputs', 'universe and open-price scan on each decision day', 'marking the held names (about quantile x names, baseline: all names)', 'trades and their cost pricing (turnover x names)'],
      days_only: ['the per-day cost-runs call and registry lookup', 'daily NAV, log growth and the day record', 'portfolio with / without, stress windows and the rolling 60-day |rho| (about 61 x days)'],
      names_log_names_x_days: ['ranking the pool on each decision day (sort, names x log2 names)', 'the neutralisation rank transform per day'],
    },
    assumptions: [
      'Per-arm wall time is fitted from synthetic panels of 250 to 2,000 names (120 days), per arm kind (equal-weight universe, quantile) and rebalance rule, as a + b*N + c*N*log2(N) ms per decision day (negative terms dropped), then evaluated at the real names x days.',
      'The four simulated arms are serial; the portfolio arms are days-only arithmetic. DAILY decides on every day (the upper bound), WEEKLY on the first trading day of the week; carried remainders trade on other days.',
      'The reference NAV is the rules default (1e8 CNY); a larger book is capped by the participation cap more often and trades over more days, a smaller one trades fewer, larger-share names.',
      'Panel build time is the fixture measurement scaled by names x days (linear) and, as an upper bound, by log2(names) as well (the neutralisation ranks each day).',
    ],
  };
}

async function main(argv) {
  const o = { names: 5000, days: 1621, candidates: 200 };
  if (argv[0] === '--backtest') {
    const b = measureBacktest();
    process.stdout.write(`${JSON.stringify({ backtest: extrapolateBacktest(b, { names: o.names, days: o.days }) }, null, 1)}\n`);
    return;
  }
  for (let i = 0; i < argv.length; i += 2) { const k = argv[i].replace(/^--/, ''); if (!(k in o)) throw new EstimateError(`COMPUTE_ESTIMATE_OPTION_UNKNOWN:${argv[i]}`); o[k] = Number(argv[i + 1]); }
  const m = await measure();
  process.stdout.write(`${JSON.stringify({ measurement: m, estimate: extrapolate(m, o) }, null, 1)}\n`);
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.code || 'ERROR'}: ${e.message}\n`); process.exitCode = 2; });

module.exports = { SCHEMA, BACKTEST_SCHEMA, EstimateError, extrapolate, measure, measureBacktest, extrapolateBacktest, fitDay, probeArms };
