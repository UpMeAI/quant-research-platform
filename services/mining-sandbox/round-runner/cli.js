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
 *            协调会话裁定 R1.5：列出过了验证折的候选与机制登记状态、机制集合的 sha 与最新的复审；--register 给一个 JSONL 文件就逐条登记（留出段开启之前，只追加）。
 *   review   --out DIR --round ROUND_ID --file FILE
 *            R1.5「打分之前由协调会话复审这批机制」：裁决文件 JSON { mechanism_set_sha256, reviewer, verdicts: [{candidate_id, verdict: APPROVED|REJECTED, note?}] }
 *            写一行 MECHANISM_REVIEW_V1（只追加，最新的算数）。score / rescore 之前必须有覆盖每个选中候选、集合 sha 对得上、早于开启的复审。
 *   score 另可 --factor-series DIR（FACTOR_SERIES_V1，R1.4：G-MINE 第 7、8 项要的现有因子序列，只读）；--min-names-per-day 是留出段的下限（默认 4,000）。
 *   score / rescore 另可 --field-exclusions FILE --field-exclusions-sha256 SHA（两个一起给）：协调会话的字段排除文件 HOLDOUT_FIELD_EXCLUSIONS_V1，sha 钉住，写进开启记录（复审 #127 P3-1）。
 *   rescore（score 的选项）+ --reason TEXT --crash-log FILE：协调会话裁定 R1.8，开启之后崩溃的那一轮恰好一次同选集重打分；再崩以 FAILED_RESCORE 关轮。
 *   fail-evaluation --out DIR --round ROUND_ID --reason TEXT --evidence-sha256 SHA：★RF1116_ROUND1_STATE (a)，留出段从未开启、本轮没被评估 → FAILED_EVALUATION（只追加）。
 *
 * 启动即 lockdown（只许写 --out）；QRP_DATA_DIR 必须在 --out 里。登记人取 QRP_PRODUCT_MILESTONE_AUTHORITY。
 * 生成方式：--generator AI_MINED_GP（默认，要 --seed）或 AI_MINED_LLM（RF1116 LLM_GEN：模型与上限取配置 config/mining_llm_generator.v1.json，不给 --seed；
 *   开新轮或续跑之前先探活：一条不含公式的请求经 <out>/llm-exchange 交给网络那一步（services/mining-llm-step，唯一连网的容器）；探活不过 → 不开轮、退出码 75）。
 *   别的 → MINE_GENERATOR_UNKNOWN。认不出的选项一律拒绝（generate 没有 --holdout）。
 *   --llm-poll-ms N、--llm-wait-seconds N：等交换目录里应答的间隔与最长时间（探活与每次调用；默认取配置）。
 *   llm-init --out DIR：建交换目录（模式 1777，因为执行器容器与网络那一步容器在宿主机上是不同的 uid）并撤回上一次运行留下的、没人答的请求；run.sh 在起网络那一步之前先跑它。
 * 成功：stdout 一行 JSON，退出码 0；失败：stderr 一行 JSON { error }，退出码 2；
 *   等待：stdout 一行 JSON（status WAITING，llm_state 写原因），退出码 75（密钥不在、额度 / 限流、版本对不上、网络那一步没答；本轮留在 OPEN，续跑接着来）；
 *   停止：stdout 一行 JSON（status STOPPED），退出码 3（token 上限、调用次数上限、请求体不合规）。
 */
const runner = require('./index');
const adapter = require('../data-adapter');

const OPTIONS = Object.freeze({
  generate: ['out', 'lane', 'lane-adapter', 'tail', 'seed', 'cap', 'holdout-ref', 'holdout-sha256', 'resume', 'generator', 'opened-at', 'min-names-per-day', 'llm-poll-ms', 'llm-wait-seconds'],
  'llm-init': ['out'],
  score: ['out', 'round', 'lane', 'lane-adapter', 'tail', 'prior-live', 'holdout', 'scored-at', 'closed-at', 'min-names-per-day', 'factor-series', 'field-exclusions', 'field-exclusions-sha256', 'require-arrival-chain'],
  mechanisms: ['out', 'round', 'register'],
  review: ['out', 'round', 'file'],
  rescore: ['out', 'round', 'lane', 'lane-adapter', 'tail', 'prior-live', 'holdout', 'scored-at', 'closed-at', 'min-names-per-day', 'factor-series', 'reason', 'crash-log', 'field-exclusions', 'field-exclusions-sha256', 'require-arrival-chain'],
  'fail-evaluation': ['out', 'round', 'reason', 'evidence-sha256', 'failed-at'],
  'resolve-segment': ['out', 'segment', 'holdout', 'resolved-at'],
  'r2-arrive': ['holdout', 'driver', 'source', 'arrived-at'],
  'holdout-arrive': ['holdout', 'segment', 'driver', 'source', 'arrived-at', 'check-complete'],
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

// --prior-live (score, rescore): the directory of an EARLIER holdout segment whose holdout has been scored (R1 for an R2 round) as ordinary LIVE history: the feed day before the
// window's first decision day and the lookbacks live there. Not a holdout source (the segment's own data is the --holdout directory).
const sourcesOf = (o) => [adapter.loadSource({ dir: o.lane, mode: 'HISTORY', label: 'lane', adapter: o['lane-adapter'] || null }), adapter.csvDirSource(o.tail, { mode: 'LIVE', label: 'tail' }),
  ...(o['prior-live'] ? [adapter.csvDirSource(o['prior-live'], { mode: 'LIVE', label: 'prior-live' })] : [])];
const required = (o, keys) => { for (const k of keys) if (!o[k]) throw new runner.RunnerError('MINE_RUNNER_OPTION_REQUIRED', `--${k}`); };

function main(argv) {
  const { cmd, o } = parseArgs(argv);
  const registeredBy = process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  if (cmd === 'llm-init') {
    required(o, ['out']);
    const { outDir } = runner.start({ outDir: o.out });
    const llmMod = require('../llm');
    const exchange = llmMod.ensureExchangeDir(require('path').join(outDir, 'llm-exchange'));
    // 网络那一步容器起来之前：上一次运行留下的、没人答的请求全部撤回（不然新起的那一步会悄悄答掉，花了钱没有记账）
    return { command: 'llm-init', exchange, withdrawn: llmMod.withdrawUnanswered(exchange) };
  }
  if (cmd === 'generate') {
    const generator = { mode: o.generator || 'AI_MINED_GP', gp_seed: o.seed === undefined ? undefined : Number(o.seed) };
    require('../generators').assertGeneratorEnabled(generator); // 不认识的生成方式：在开轮、读数据、锁目录之前就拒
    const isLlm = generator.mode === 'AI_MINED_LLM';
    if (isLlm && o.seed !== undefined) throw new runner.RunnerError('MINE_RUNNER_OPTION_NOT_FOR_LLM', '--seed');
    required(o, ['out', 'lane', 'tail', ...(o.resume ? [] : ['holdout-ref', 'holdout-sha256', ...(isLlm ? [] : ['seed'])])]);
    const { outDir } = runner.start({ outDir: o.out });
    // W24：生成方进程的读锁（不许读留出段目录，QRP_HOLDOUT_DATA_DIRS）与访问记录。轮 id 在开轮之后才有：记录先缓冲，开轮（或续跑）后绑到本轮的文件；被拒的读也记
    const accessLog = require('../../independent-verifier/access-log').deferred();
    require('../../independent-verifier/launcher').lockGenerator({ principal: 'mining-generator', allowWriteRoot: outDir, log: accessLog });
    // 数据先核（复审第 4 条）：挖掘段面板建好、逐日覆盖过了下限，才开轮、封存、记尝试
    const sources = sourcesOf(o);
    const floor = o['min-names-per-day'] === undefined ? runner.COVERAGE_FLOOR : { min_names_per_day: Number(o['min-names-per-day']) };
    const m = require('../segments').SEGMENTS.MINING;
    const panel = adapter.buildPanel({ sources, space: runner.loadFrozenSpace().space, segment: 'MINING', from: m.from, to: m.to });
    runner.checkCoverage(panel, floor);
    const neutral = o.resume ? runner.neutralizationOf(require('../../mining-rounds').roundHead(o.resume)) : require('../../mining-rounds/neutralization').NEW_ROUND_NEUTRALIZATION; // 版本跟着轮走：续跑用那一轮的，新开的用 RANK_GAUSS_V2
    runner.checkCanary(panel, floor, undefined, { neutralization: neutral }); // 第 1 轮缺陷之后：固定公式算不出分就不开轮、不记续跑（generate() 里再核一次并写进 generate.json）
    let roundId = o.resume;
    if (roundId) runner.assertResumeGenerator({ roundId, mode: generator.mode }); // 续跑的生成方式要和轮次一致
    const llmOpts = isLlm ? { pollMs: o['llm-poll-ms'] === undefined ? null : Number(o['llm-poll-ms']), waitSeconds: o['llm-wait-seconds'] === undefined ? null : Number(o['llm-wait-seconds']) } : null;
    if (isLlm) {
      // 探活：网络那一步在、密钥在、模型对得上，才开轮或续跑；不过就什么都不写
      const ping = runner.probeLlm({ outDir, ...llmOpts });
      if (ping.outcome !== 'OK') return { command: 'generate', round_id: roundId || null, status: String(ping.outcome).startsWith('WAITING_') ? 'WAITING' : 'STOPPED', llm_state: ping.outcome, ping };
      llmOpts.ping = ping;
    }
    if (roundId) { accessLog.bind(runner.accessLogFile(outDir, roundId)); runner.noteResume({ roundId, coverageFloor: floor }); } // 续跑用的下限也写进台账
    if (!roundId) {
      runner.assertHoldoutRef({ openedAt: o['opened-at'] || null, dataRef: o['holdout-ref'] }); // 引用点了另一段的封存目录 → 开轮之前拒（RF1116 第二段修订）
      const r = runner.requestRound({ generator, cap: o.cap === undefined ? undefined : Number(o.cap), openedAt: o['opened-at'] || null, coverageFloor: floor });
      roundId = r.round_id;
      accessLog.bind(runner.accessLogFile(outDir, roundId));
      runner.sealHoldout({ roundId, dataRef: o['holdout-ref'], dataSha256: o['holdout-sha256'] });
    }
    const wait = isLlm ? { pollMs: llmOpts.pollMs, waitPolls: llmOpts.waitSeconds === null ? null : Math.ceil(llmOpts.waitSeconds * 1000 / (llmOpts.pollMs || require('../llm').loadConfig().config.exchange.poll_ms)) } : {};
    const g = runner.generate({ roundId, sources, outDir, registeredBy, coverageFloor: floor, panel, llm: wait, accessLog });
    if (g.llm && g.llm.halted) {
      const halted = { command: 'generate', round_id: roundId, status: String(g.llm.state).startsWith('WAITING_') ? 'WAITING' : 'STOPPED', round_status: g.status, llm_state: g.llm.state, total: g.total,
        attempts: g.attempts, llm: g.llm, ping: llmOpts.ping };
      // 预算 / 能力用尽（token 上限、调用次数上限、连续空应答）= 生成到此为止：有尝试就选择，让本轮能继续往下走（退出码仍是 3，让人看到它是被截断的）。
      // 没有一个尝试、请求体不合规、等待态：不选择，由协调会话看（fail-evaluation 或续跑）
      if (g.llm.generation_closed && g.total > 0) {
        const s = runner.select({ roundId, sources, outDir, accessLog });
        return { ...halted, selected: s.selected.length, candidates_scored_for_selection: s.candidates.length };
      }
      return halted;
    }
    const s = runner.select({ roundId, sources, outDir, accessLog });
    return { command: 'generate', round_id: roundId, status: g.status, total: g.total, attempts: g.attempts, selected: s.selected.length, candidates_scored_for_selection: s.candidates.length,
      ...(isLlm ? { llm: g.llm, ping: { outcome: llmOpts.ping.outcome, model_reported: llmOpts.ping.model_reported, served_version: llmOpts.ping.served_version } } : {}) };
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
    const latest = mechanisms.latestReview(o.round);
    return { command: 'mechanisms', round_id: o.round, survivors: runner.survivors({ roundId: o.round, outDir }), registered,
      mechanism_set_sha256: mechanisms.mechanismSetSha(o.round).sha256,
      review: latest ? { record_hash: latest.record_hash, mechanism_set_sha256: latest.mechanism_set_sha256, reviewer: latest.reviewer, reviewed_at: latest.reviewed_at, verdicts: latest.verdicts } : null };
  }
  if (cmd === 'review') {
    // R1.5：协调会话的复审（裁决文件只读挂进来），写 MECHANISM_REVIEW_V1
    required(o, ['out', 'round', 'file']);
    runner.start({ outDir: o.out });
    const v = JSON.parse(require('fs').readFileSync(o.file, 'utf8'));
    const row = require('../../mining-rounds/mechanisms').recordReview(o.round, v);
    const count = (k) => row.verdicts.filter((x) => x.verdict === k).length;
    return { command: 'review', round_id: o.round, record_hash: row.record_hash, mechanism_set_sha256: row.mechanism_set_sha256, supersedes: row.supersedes,
      verdicts: { APPROVED: count('APPROVED'), REJECTED: count('REJECTED') } };
  }
  if (cmd === 'fail-evaluation') {
    // ★RF1116_ROUND1_STATE (a)：没被评估的轮（留出段从未开启）以 FAILED_EVALUATION 关轮，证据是缺陷报告的 sha256
    required(o, ['out', 'round', 'reason', 'evidence-sha256']);
    runner.start({ outDir: o.out });
    const row = require('../../mining-rounds').failEvaluation(o.round, { reason: o.reason, evidenceSha256: o['evidence-sha256'], failedAt: o['failed-at'] || null });
    return { command: 'fail-evaluation', round_id: o.round, status: row.status, gmine_passes: row.gmine_passes, evidence_sha256: row.gmine_basis.failed_evaluation.evidence_sha256,
      attempts: row.gmine_basis.failed_evaluation.attempts, record_hash: row.record_hash, closed_at: row.closed_at };
  }
  if (cmd === 'holdout-arrive' || cmd === 'r2-arrive') {
    // RF1116 holdout data arrival (services/.../arrival.js): the only writer of an R1 / R2 holdout directory. It is NOT a sandboxed run: it writes that directory (the one thing it may write)
    // and only READS the ledger (the resolution record gives R2's window end). Loops until nothing is left to do, so a daily timer catches up after a missed day.
    // `r2-arrive` is the R2 command as first built; `holdout-arrive --segment R1|R2` serves both.
    const segment = cmd === 'r2-arrive' ? 'R2' : o.segment;
    required(o, cmd === 'r2-arrive' ? ['holdout', 'driver'] : ['holdout', 'segment']);
    const arrival = require('./arrival');
    if (!arrival.PROFILES[segment]) throw new runner.RunnerError('MINE_RUNNER_OPTION_UNKNOWN', `${cmd} --segment ${segment}`);
    const rec = segment === 'R2' ? require('../../mining-rounds/segment-resolution').resolutionOf('R2') : null;
    const windowEnd = segment === 'R2' ? (rec ? rec.window.to : null) : require('../segments').SEGMENTS.HOLDOUT.to;
    const startAfter = rec ? rec.rule.start_after : undefined;
    if (o['check-complete']) {
      // read-only: the open days of the window that have not arrived; exit code 4 when some are missing (the timer alerts on it)
      if (!windowEnd) return { command: 'holdout-arrive', segment, status: 'WINDOW_END_UNKNOWN', missing: [] };
      const c = arrival.checkComplete({ dir: o.holdout, segment, windowEnd, startAfter });
      return { command: 'holdout-arrive', segment, status: c.complete ? 'COMPLETE' : 'INCOMPLETE', window_end: windowEnd, last_day: c.last_day, missing: c.missing };
    }
    required(o, ['driver']);
    let source;
    if (o.driver === 'csv-day-drop') { required(o, ['source']); source = arrival.csvDayDropSource(o.source); } else if (o.driver === 'pg-psql') source = arrival.pgDaySource({ run: require('../../mining-rounds/arrival-psql').psqlRunner() });
    else throw new runner.RunnerError('MINE_RUNNER_OPTION_UNKNOWN', `${cmd} --driver ${o.driver}`);
    const rows = []; let last = null;
    for (let i = 0; i < 500; i += 1) {
      last = arrival.arrive({ dir: o.holdout, segment, source, arrivedAt: o['arrived-at'] || null, windowEnd, startAfter });
      if (last.status !== 'ARRIVED') break;
      rows.push(last.kind === 'DAY' ? last.day : 'CALENDAR');
    }
    const v = require('fs').existsSync(require('path').join(o.holdout, arrival.CHAIN_FILE)) ? arrival.verifyChain(o.holdout, { segment, startAfter }) : null;
    return { command: cmd, segment, status: last.status, what: last.what === undefined ? null : last.what, arrived: rows, last_day: v ? v.last_day : null, chain_head: v ? v.head_hash : null, window_end: windowEnd };
  }
  if (cmd === 'resolve-segment') {
    // RF1116 第二段修订：从留出段目录的上交所日历解出这一段的窗口，写一行解析记录（读了哪份日历、数出哪些日子）；日历还没列够 → status NOT_READY，什么都不写，退出码 0（定时器再来）
    required(o, ['out', 'segment', 'holdout']);
    runner.start({ outDir: o.out });
    const r = runner.resolveSegment({ segmentId: o.segment, dir: o.holdout, resolvedBy: registeredBy || 'round-runner', resolvedAt: o['resolved-at'] || null });
    return r.status === 'RESOLVED'
      ? { command: 'resolve-segment', status: r.status, created: r.created, segment: r.segment, window: r.window, record_hash: r.record.record_hash, resolved_at: r.record.resolved_at }
      : { command: 'resolve-segment', status: r.status, segment: r.segment, reason: r.reason, calendar_last_date: r.calendar_last_date };
  }
  required(o, ['out', 'round', 'lane', 'tail', 'holdout']);
  const { outDir } = runner.start({ outDir: o.out });
  const floor = o['min-names-per-day'] === undefined ? runner.HOLDOUT_FLOOR : { min_names_per_day: Number(o['min-names-per-day']) };
  // 复审 #127 P3-1：协调会话的字段排除文件，两个选项要么都给、要么都不给（sha 由协调会话钉住）
  const hasEx = o['field-exclusions'] !== undefined; const hasExSha = o['field-exclusions-sha256'] !== undefined;
  if (hasEx !== hasExSha) throw new runner.RunnerError('MINE_RUNNER_OPTION_REQUIRED', hasEx ? '--field-exclusions-sha256' : '--field-exclusions');
  const fieldExclusions = hasEx ? { file: o['field-exclusions'], sha256: o['field-exclusions-sha256'] } : null;
  // W24：打分的执行器是受信的求值方，不受生成方的读锁约束，但每次留出段读取都领一次授权、写一行 HOLDOUT_READ（访问记录在本轮的运行目录里）
  const accessLog = require('../../independent-verifier/access-log').writer(runner.accessLogFile(outDir, o.round));
  if (cmd === 'rescore') {
    // R1.8：开启之后崩溃，恰好一次同选集重打分（原因与崩溃日志写进留出段保管的第二个事件）
    required(o, ['reason', 'crash-log']);
    const log = require('fs').readFileSync(o['crash-log'], 'utf8');
    const rr = runner.rescore({ roundId: o.round, sources: sourcesOf(o), holdoutDir: o.holdout, outDir, scoredAt: o['scored-at'] || null, holdoutFloor: floor,
      factorSeriesDir: o['factor-series'] || null, reason: o.reason, log, fieldExclusions, accessLog, requireChain: o['require-arrival-chain'] === 'true' });
    const closedR = runner.close({ roundId: o.round, closedAt: o['closed-at'] || null });
    return { command: 'rescore', round_id: o.round, rescored: rr.rescored, records: rr.records.length, passes: closedR.gmine_passes, status: closedR.status };
  }
  const res = runner.scoreHoldout({ roundId: o.round, sources: sourcesOf(o), holdoutDir: o.holdout, outDir, scoredAt: o['scored-at'] || null, holdoutFloor: floor,
    factorSeriesDir: o['factor-series'] || null, fieldExclusions, accessLog, requireChain: o['require-arrival-chain'] === 'true' });
  const closed = runner.close({ roundId: o.round, closedAt: o['closed-at'] || null });
  return { command: 'score', round_id: o.round, opened: res.opened, records: res.records.length, passes: closed.gmine_passes, status: closed.status };
}

if (require.main === module) {
  try {
    const out = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (out.status === 'WAITING') process.exitCode = 75; else if (out.status === 'STOPPED') process.exitCode = 3; else if (out.status === 'INCOMPLETE') process.exitCode = 4; // holdout-arrive --check-complete
  } catch (e) {
    process.stderr.write(`${JSON.stringify({ error: e.code || 'MINE_RUNNER_FAILED', message: e.message })}\n`);
    process.exitCode = 2;
  }
}

module.exports = { OPTIONS, parseArgs, main, sourcesOf };
