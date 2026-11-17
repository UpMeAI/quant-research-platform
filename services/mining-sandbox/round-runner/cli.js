#!/usr/bin/env node
'use strict';

/**
 * 挖掘轮次执行器的命令行（容器的入口，deploy/research-lane/round-runner/）。两个阶段分开跑，留出段目录只在第二阶段挂进来：
 *
 *   generate --out DIR --lane DIR [--lane-adapter MODULE] --tail DIR --seed N [--cap N] --holdout-ref REF --holdout-sha256 SHA [--resume ROUND_ID]
 *            第 1–5 步：开轮（或续跑 --resume 的轮）→ 封存留出段（只记引用与 sha）→ 生成 + 挖掘段打分 + 记台账 → 前推验证折选择。
 *   score    --out DIR --round ROUND_ID --lane DIR [--lane-adapter MODULE] --tail DIR --holdout DIR
 *            第 6–9 步：核留出段目录 → 开留出段（每轮一次）→ 打分 → 逐候选 G-MINE 记录 → 关轮。
 *
 * 启动即 lockdown（只许写 --out）；QRP_DATA_DIR 必须在 --out 里。登记人取 QRP_PRODUCT_MILESTONE_AUTHORITY。
 * 只有 GP：--generator 给别的（比如 AI_MINED_LLM）→ MINE_LLM_NOT_ENABLED / MINE_GENERATOR_UNKNOWN。认不出的选项一律拒绝（generate 没有 --holdout）。
 * 成功：stdout 一行 JSON，退出码 0；失败：stderr 一行 JSON { error }，退出码 2。
 */
const runner = require('./index');
const adapter = require('../data-adapter');

const OPTIONS = Object.freeze({
  generate: ['out', 'lane', 'lane-adapter', 'tail', 'seed', 'cap', 'holdout-ref', 'holdout-sha256', 'resume', 'generator', 'opened-at'],
  score: ['out', 'round', 'lane', 'lane-adapter', 'tail', 'holdout', 'scored-at', 'closed-at'],
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
    let roundId = o.resume;
    if (!roundId) {
      const r = runner.requestRound({ generator, cap: o.cap === undefined ? undefined : Number(o.cap), openedAt: o['opened-at'] || null });
      roundId = r.round_id;
      runner.sealHoldout({ roundId, dataRef: o['holdout-ref'], dataSha256: o['holdout-sha256'] });
    }
    const sources = sourcesOf(o);
    const g = runner.generate({ roundId, sources, outDir, registeredBy });
    const s = runner.select({ roundId, sources, outDir });
    return { command: 'generate', round_id: roundId, status: g.status, total: g.total, attempts: g.attempts, selected: s.selected.length, candidates_scored_for_selection: s.candidates.length };
  }
  required(o, ['out', 'round', 'lane', 'tail', 'holdout']);
  const { outDir } = runner.start({ outDir: o.out });
  const res = runner.scoreHoldout({ roundId: o.round, sources: sourcesOf(o), holdoutDir: o.holdout, outDir, scoredAt: o['scored-at'] || null });
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
