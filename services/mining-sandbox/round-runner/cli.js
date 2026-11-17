#!/usr/bin/env node
'use strict';

/**
 * 挖掘轮次执行器的命令行（容器的入口，deploy/research-lane/round-runner/）。两个阶段分开跑，留出段目录只在第二阶段挂进来：
 *
 *   generate --out DIR --lane DIR [--lane-adapter MODULE] --tail DIR --seed N [--cap N] --holdout-ref REF --holdout-sha256 SHA [--resume ROUND_ID] [--min-names-per-day N]
 *            先建挖掘段面板、核逐日覆盖（默认每天 ≥ 2,000 只，runner.COVERAGE_FLOOR），过了才：
 *            第 1–5 步：开轮（或续跑 --resume 的轮）→ 封存留出段（只记引用与 sha）→ 生成 + 挖掘段打分 + 记台账 → 前推验证折选择。
 *   score    --out DIR --round ROUND_ID --lane DIR [--lane-adapter MODULE] --tail DIR --holdout DIR [--min-names-per-day N]
 *            第 6–9 步：核留出段目录 → 开留出段（每轮一次）→ 打分 → 逐候选 G-MINE 记录 → 关轮。
 *
 *   mechanisms --out DIR --round ROUND_ID [--register FILE]
 *            协调会话裁定 R1.5：列出过了验证折的候选与机制登记状态；--register 给一个 JSONL 文件就逐条登记（留出段开启之前，只追加）。
 *   score 另可 --factor-series DIR（FACTOR_SERIES_V1，R1.4：G-MINE 第 7、8 项要的现有因子序列，只读）；--min-names-per-day 是留出段的下限（默认 4,000）。
 *   rescore（score 的选项）+ --reason TEXT --crash-log FILE：协调会话裁定 R1.8，开启之后崩溃的那一轮恰好一次同选集重打分；再崩以 FAILED_RESCORE 关轮。
 *
 * 启动即 lockdown（只许写 --out）；QRP_DATA_DIR 必须在 --out 里。登记人取 QRP_PRODUCT_MILESTONE_AUTHORITY。
 * 只有 GP：--generator 给别的（比如 AI_MINED_LLM）→ MINE_LLM_NOT_ENABLED / MINE_GENERATOR_UNKNOWN。认不出的选项一律拒绝（generate 没有 --holdout）。
 * 成功：stdout 一行 JSON，退出码 0；失败：stderr 一行 JSON { error }，退出码 2。
 */
const runner = require('./index');
const adapter = require('../data-adapter');

const OPTIONS = Object.freeze({
  generate: ['out', 'lane', 'lane-adapter', 'tail', 'seed', 'cap', 'holdout-ref', 'holdout-sha256', 'resume', 'generator', 'opened-at', 'min-names-per-day'],
  score: ['out', 'round', 'lane', 'lane-adapter', 'tail', 'holdout', 'scored-at', 'closed-at', 'min-names-per-day', 'factor-series'],
  mechanisms: ['out', 'round', 'register'],
  rescore: ['out', 'round', 'lane', 'lane-adapter', 'tail', 'holdout', 'scored-at', 'closed-at', 'min-names-per-day', 'factor-series', 'reason', 'crash-log'],
});

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(OPTIONS, cmd)) throw new runner.RunnerError('MINE_RUNNER_COMMAND_UNKNOWN', String(cmd));
  const o = {};
  for (let k = 0; k < rest.length; k += 2) {
    const key = rest[k].replace(/^--/, '');
    if (!rest[k].startsWith('--') || !OPTIONS[cmd].includes(key)) throw new runner.RunnerError('MINE_RUNNER_OPTION_UNKNOWN', `${cmd} ${rest[k]}`);
    if (rest[k + 1] === undefined) throw new runner.RunnerError('MINE_RUNNER_OPTION_VALUE_MISSING', rest[k]);
    o[key] = rest[k + 1];
  }
  return { cmd, o };
}

const sourcesOf = (o) => [adapter.loadSource({ dir: o.lane, mode: 'HISTORY', label: 'lane', adapter: o['lane-adapter'] || null }), adapter.csvDirSource(o.tail, { mode: 'LIVE', label: 'tail' })];
const required = (o, keys) => { for (const k of keys) if (!o[k]) throw new runner.RunnerError('MINE_RUNNER_OPTION_REQUIRED', `--${k}`); };

function main(argv) {
  const { cmd, o } = parseArgs(argv);
  const registeredBy = process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  if (cmd === 'generate') {
    const generator = { mode: o.generator || 'AI_MINED_GP', gp_seed: o.seed === undefined ? undefined : Number(o.seed) };
    require('../generators').assertGeneratorEnabled(generator); // 大模型：在开轮、读数据、锁目录之前就拒
    required(o, ['out', 'lane', 'tail', ...(o.resume ? [] : ['seed', 'holdout-ref', 'holdout-sha256'])]);
    const { outDir } = runner.start({ outDir: o.out });
    // 数据先核（复审第 4 条）：挖掘段面板建好、逐日覆盖过了下限，才开轮、封存、记尝试
    const sources = sourcesOf(o);
    const floor = o['min-names-per-day'] === undefined ? runner.COVERAGE_FLOOR : { min_names_per_day: Number(o['min-names-per-day']) };
    const m = require('../segments').SEGMENTS.MINING;
    const panel = adapter.buildPanel({ sources, space: runner.loadFrozenSpace().space, segment: 'MINING', from: m.from, to: m.to });
    runner.checkCoverage(panel, floor);
    let roundId = o.resume;
    if (roundId) runner.noteResume({ roundId, coverageFloor: floor }); // 续跑用的下限也写进台账
    if (!roundId) {
      const r = runner.requestRound({ generator, cap: o.cap === undefined ? undefined : Number(o.cap), openedAt: o['opened-at'] || null, coverageFloor: floor });
      roundId = r.round_id;
      runner.sealHoldout({ roundId, dataRef: o['holdout-ref'], dataSha256: o['holdout-sha256'] });
    }
    const g = runner.generate({ roundId, sources, outDir, registeredBy, coverageFloor: floor, panel });
    const s = runner.select({ roundId, sources, outDir });
    return { command: 'generate', round_id: roundId, status: g.status, total: g.total, attempts: g.attempts, selected: s.selected.length, candidates_scored_for_selection: s.candidates.length };
  }
  if (cmd === 'mechanisms') {
    // R1.5：列出幸存者与机制登记状态；给了 --register（JSONL：candidate_id, mechanism_id, economic_logic_zh, failure_mode_zh, written_at）就逐条登记（开启之前）
    required(o, ['out', 'round']);
    const { outDir } = runner.start({ outDir: o.out });
    const mechanisms = require('../../mining-rounds/mechanisms');
    const registered = [];
    if (o.register) {
      for (const line of require('fs').readFileSync(o.register, 'utf8').split('\n').filter((l) => l.trim())) {
        registered.push(mechanisms.registerMechanism(o.round, JSON.parse(line), { writtenBy: registeredBy }).candidate_id);
      }
    }
    return { command: 'mechanisms', round_id: o.round, survivors: runner.survivors({ roundId: o.round, outDir }), registered };
  }
  required(o, ['out', 'round', 'lane', 'tail', 'holdout']);
  const { outDir } = runner.start({ outDir: o.out });
  const floor = o['min-names-per-day'] === undefined ? runner.HOLDOUT_FLOOR : { min_names_per_day: Number(o['min-names-per-day']) };
  if (cmd === 'rescore') {
    // R1.8：开启之后崩溃，恰好一次同选集重打分（原因与崩溃日志写进留出段保管的第二个事件）
    required(o, ['reason', 'crash-log']);
    const log = require('fs').readFileSync(o['crash-log'], 'utf8');
    const rr = runner.rescore({ roundId: o.round, sources: sourcesOf(o), holdoutDir: o.holdout, outDir, scoredAt: o['scored-at'] || null, holdoutFloor: floor,
      factorSeriesDir: o['factor-series'] || null, reason: o.reason, log });
    const closedR = runner.close({ roundId: o.round, closedAt: o['closed-at'] || null });
    return { command: 'rescore', round_id: o.round, rescored: rr.rescored, records: rr.records.length, passes: closedR.gmine_passes, status: closedR.status };
  }
  const res = runner.scoreHoldout({ roundId: o.round, sources: sourcesOf(o), holdoutDir: o.holdout, outDir, scoredAt: o['scored-at'] || null, holdoutFloor: floor,
    factorSeriesDir: o['factor-series'] || null });
  const closed = runner.close({ roundId: o.round, closedAt: o['closed-at'] || null });
  return { command: 'score', round_id: o.round, opened: res.opened, records: res.records.length, passes: closed.gmine_passes, status: closed.status };
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); } catch (e) {
    process.stderr.write(`${JSON.stringify({ error: e.code || 'MINE_RUNNER_FAILED', message: e.message })}\n`);
    process.exitCode = 2;
  }
}

module.exports = { OPTIONS, parseArgs, main };
