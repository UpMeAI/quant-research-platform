'use strict';
/**
 * 挖掘轮次执行器（RF1116 P2 规格 §1 九步；§4 第 5、6、7、9 条；MINING_ROUNDS_V1「P2 requirements」）。先红后绿，全部是合成数据。
 *   - 大模型：开轮之前就拒（MINE_LLM_NOT_ENABLED），命令行也一样；generate 没有 --holdout；
 *   - 尝试计数：解析不过、去重被拒的都记一行试验台账、都计入 N，到 200 停、不补；
 *   - 验证折选择不回生成方：选完 generatorView 与试验台账一字不变，选择结果只在输出目录；选完不能再生成；
 *   - 留出段只在开启时交出：目录先核（封存的 sha、补导只追加、日历到 12-31），核不过不开、不耗那一次；开一次之后第二次被拒；
 *   - 唯一生产者：留出段结果只经执行器（holdout-scoring → neutralizeForScoring → recordGateResult）；没有中性化戳的结果进 G-MINE 被拒；
 *   - 隔离：执行器启动即 lockdown，写输出目录以外被拒；台账目录不在输出目录里就不启动；容器定义的静态检查；
 *   - 端到端：命令行在子进程里跑一轮 GP（开轮 → 关轮），台账、留出段日志、G-MINE 记录前后一致；同种子两次逐字节相同。
 * 端到端在子进程里起两次执行器、各算一遍挖掘段与验证折，较慢（~1 分钟）；仍是一个文件，按 heavy-run --light 跑。
 */
const { dataRoot } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const AUTH = 'TEST_ROUND_RUNNER_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const { makeMiningDataFixture, internals: fixtureInternals } = require('./_mining_data_fixture');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const selector = require('../services/mining-sandbox/round-runner/selector');
const holdoutScoring = require('../services/mining-sandbox/round-runner/holdout-scoring');
const rounds = require('../services/mining-rounds');
const vault = require('../services/holdout-vault');
const gateRecords = require('../services/mining-rounds/gate-records');
const trials = require('../services/trial-ledger');
const gate = require('../services/mining-gate');
const { read } = require('../packages/ledger');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'services/mining-sandbox/round-runner/cli.js');
const SPACE = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json'), 'utf8'));
const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-runner-fx-')));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const HOLDOUT_SUMS_SHA = sha(fs.readFileSync(path.join(fx.dirs.holdout, 'SHA256SUMS')));
const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
/** 每个测试一个新的台账目录（dataDir 每次调用都读环境变量）。 */
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-runner-data-')); process.env.QRP_DATA_DIR = d; return d; };
const roundTrials = (roundId) => [...trials.heads().values()].filter((t) => t.role === 'MINED_CANDIDATE' && t.mining && t.mining.round_id === roundId);
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const runDirOf = (out, id) => path.join(out, 'rounds', id.replace(/[^A-Za-z0-9_-]/g, '_'));
/** 一个已知会过验证折的生成方（埋的短期反转），给选择与留出段的测试用；不是 GP，GP 在端到端里跑。 */
const KNOWN = ['rank((-ret_1d))', 'zscore((-ret_1d))', 'rank((-ts_mean(ret_1d,5)))', 'rank(pb)', 'rank(ts_delta(close_hfq,1))', 'zscore(turnover_f)'];
const knownGen = { mode: 'AI_MINED_GP', seed: 0, params: { batch_size: 40 }, nextBatch: (view, { n }) => KNOWN.slice(view.mining_scores.length, view.mining_scores.length + n) };
/** 合成数据只有十几只股票：进程内的 generate 用低的覆盖下限（生产默认见 runner.COVERAGE_FLOOR）。 */
const COV = Object.freeze({ min_names_per_day: 5 });
const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('run.sh：文件参数先用 realpath -e 解析成绝对路径再挂（裸文件名不会被 Docker 当成卷名）；文件不存在就停，不调 docker', (t) => {
  if (spawnSync('realpath', ['-e', '/']).status !== 0) { t.skip('no GNU realpath -e on this host (run.sh runs on the Linux lane)'); return; }
  const RUN_SH = path.join(ROOT, 'deploy/research-lane/round-runner/run.sh');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fake-docker-'));
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$DOCKER_ARGS_OUT"\n', { mode: 0o755 });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-run-sh-cwd-')));
  for (const n of ['verdicts.json', 'mech.jsonl', 'crash.log']) fs.writeFileSync(path.join(cwd, n), 'x\n');
  const run = (args) => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-docker-args-')), 'args');
    const r = spawnSync('bash', [RUN_SH, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RF1116_RUNNER_IMAGE: 'qrp-round-runner:test', DOCKER_ARGS_OUT: out } });
    return { ...r, args: fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean) : null };
  };
  for (const [args, mount] of [[['review', 'MR-X', 'verdicts.json'], `${cwd}/verdicts.json:/data/verdicts.json:ro`],
    [['mechanisms', 'MR-X', 'mech.jsonl'], `${cwd}/mech.jsonl:/data/mechanisms.jsonl:ro`],
    [['mechanisms', 'MR-X', './sub/../mech.jsonl'], `${cwd}/mech.jsonl:/data/mechanisms.jsonl:ro`],
    [['rescore', 'MR-X', 'synthetic crash', 'crash.log'], `${cwd}/crash.log:/data/crash.log:ro`]]) {
    if (args[2] && args[2].includes('sub')) fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
    const r = run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.args.includes(mount), `${args.join(' ')}: ${JSON.stringify(r.args.filter((a) => a.includes('/data/')))}`);
  }
  assert.ok(run(['mechanisms', 'MR-X']).args.includes('/dev/null:/data/mechanisms.jsonl:ro'), 'listing only: /dev/null');
  for (const args of [['review', 'MR-X', 'missing.json'], ['mechanisms', 'MR-X', 'missing.jsonl'], ['rescore', 'MR-X', 'r', 'missing.log'], ['review', 'MR-X', cwd]]) {
    const r = run(args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, /run\.sh: .*(no such file|not a regular file)/);
    assert.equal(r.args, null, 'docker is never called');
  }
});

test('大模型（★K 没定之前）：开轮之前就拒 MINE_LLM_NOT_ENABLED，没有轮被开；命令行也拒；generate 没有 --holdout 这个选项', () => {
  const out = freshData();
  assert.equal(runner.loadFrozenSpace().space.sha256, runner.FROZEN_INPUTS.space.sha256);
  for (const k of ['space', 'space_freeze', 'holdout_freeze']) {
    assert.throws(() => runner.internals.withFrozenInputs({ [k]: { ...runner.FROZEN_INPUTS[k], sha256: 'f'.repeat(64) } }, () => runner.loadFrozenSpace()), code(/MINE_RUNNER_FROZEN_INPUT_MISMATCH/), k);
  }
  assert.throws(() => runner.requestRound({ generator: { mode: 'AI_MINED_LLM', model: 'deepseek-v4-pro', model_knowledge_cutoff: '2026-08-13' } }), code(/MINE_LLM_NOT_ENABLED/));
  assert.equal(rounds.roundsOf('CN_A').length, 0);
  const base = ['--out', out, '--lane', fx.dirs.lane, '--tail', fx.dirs.tail, '--seed', '1', '--holdout-ref', 'synthetic:holdout', '--holdout-sha256', HOLDOUT_SUMS_SHA];
  const llm = cli(['generate', ...base, '--generator', 'AI_MINED_LLM'], { QRP_DATA_DIR: out });
  assert.equal(llm.status, 2);
  assert.equal(JSON.parse(llm.stderr).error, 'MINE_LLM_NOT_ENABLED');
  const resumeLlm = cli(['generate', '--out', out, '--lane', fx.dirs.lane, '--tail', fx.dirs.tail, '--resume', 'MR-CN_A-2026-11-x', '--generator', 'AI_MINED_LLM'], { QRP_DATA_DIR: out });
  assert.equal(JSON.parse(resumeLlm.stderr).error, 'MINE_LLM_NOT_ENABLED');
  const thin = cli(['generate', ...base, '--min-names-per-day', '100'], { QRP_DATA_DIR: out });
  assert.equal(thin.status, 2);
  assert.equal(JSON.parse(thin.stderr).error, 'MINE_RUNNER_COVERAGE_BELOW_FLOOR', 'data checked before the round is opened');
  assert.ok(!fs.existsSync(path.join(out, 'research', 'mining_rounds.jsonl')), 'no round opened, nothing written into N');
  const ho = cli(['generate', ...base, '--holdout', fx.dirs.holdout], { QRP_DATA_DIR: out });
  assert.equal(ho.status, 2);
  assert.equal(JSON.parse(ho.stderr).error, 'MINE_RUNNER_OPTION_UNKNOWN');
  assert.deepEqual(fs.readdirSync(out).filter((n) => n !== 'rounds'), []);
});

test('尝试计数（§4 第 5 条）：解析不过、去重被拒的都记一行、都计入 N；到 200 停、不补；再跑一次也不多记', () => {
  const out = freshData();
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, openedAt: '2026-11-20T02:00:00Z' });
  assert.equal(r.cap, 200);
  runner.sealHoldout({ roundId: r.round_id, dataRef: 'synthetic:holdout', dataSha256: HOLDOUT_SUMS_SHA });
  // 覆盖不到下限（生产默认每天 2,000 只）→ 一个尝试都不记
  assert.equal(runner.COVERAGE_FLOOR.min_names_per_day, 2000);
  assert.throws(() => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH }), code(/MINE_RUNNER_COVERAGE_BELOW_FLOOR/));
  assert.equal(roundTrials(r.round_id).length, 0);
  const texts = ['nope(close_hfq)', 'rank(pb)', 'rank( pb )', 'zscore(pb'];
  // 这个生成方不守本批的 n（多给 7 个）：执行器自己到上限就停，不记第 201 个
  const stub = { mode: 'AI_MINED_GP', seed: 0, params: { batch_size: 40 }, nextBatch: (view, { n }) => Array.from({ length: n + 7 }, (_, i) => texts[(view.mining_scores.length + i) % 4]) };
  const g = runner.internals.withGenerator(stub, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV }));
  assert.deepEqual(g.attempts, { scored: 1, parse_refused: 100, deduped: 99 });
  assert.equal(g.total, 200);
  const head = rounds.roundHead(r.round_id);
  assert.deepEqual([head.status, head.candidates_scored], ['CAP_REACHED', 200]);
  const rows = roundTrials(r.round_id);
  assert.equal(rows.length, 200);
  assert.equal(rounds.familyN('CN_A', 5), 200, 'every attempt counts in N');
  const by = (a) => rows.filter((t) => (t.rule_config.attempt || 'SCORED') === a);
  assert.equal(by('PARSE_REFUSED').length, 100);
  assert.equal(by('DEDUPED').length, 99);
  assert.ok(by('PARSE_REFUSED').every((t) => t.metrics.mining_segment_score === null && /^MINE_DSL_(OPERATOR_NOT_WHITELISTED|SYNTAX)$/.test(t.rule_config.refusal)));
  assert.ok(by('DEDUPED').every((t) => t.rule_config.formula === 'rank(pb)' && t.metrics.mining_segment_score === null));
  assert.equal(typeof by('SCORED')[0].metrics.mining_segment_score, 'number');
  const log = lines(path.join(runDirOf(out, r.round_id), 'attempts.jsonl'));
  assert.equal(log.length, 200);
  assert.deepEqual(log.map((x) => x.candidate_id), rows.map((t) => t.mining.candidate_id).sort());
  const again = runner.internals.withGenerator(stub, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV }));
  assert.equal(again.total, 200);
  assert.equal(roundTrials(r.round_id).length, 200);
  assert.equal(rounds.generatorView(r.round_id).mining_scores.filter((s) => s.mining_segment_score === null).length, 199);
  // 选择记录只收本轮算过分的候选：解析被拒、去重被拒的不行
  const refused = by('PARSE_REFUSED')[0].mining.candidate_id; const scored = by('SCORED')[0].mining.candidate_id;
  assert.throws(() => rounds.recordSelection(r.round_id, { selection_sha256: 'a'.repeat(64), selected: [refused], evaluated: 1 }), code(/MINE_ROUND_SELECTION_CANDIDATE_INVALID/));
  assert.throws(() => rounds.recordSelection(r.round_id, { selection_sha256: 'a'.repeat(64), selected: [scored, scored], evaluated: 2 }), code(/MINE_ROUND_SELECTION_INVALID/));
});

/**
 * 留出段目录的几种样子（导出规格 rev 3：日历是整段 2019-06-01 → 2026-12-31，每次导出都一样，所以不按日历判完整）：
 *   partial  11-17 先导的那一份（封存它）；complete 12-31 之后补导的（同目录、<表>_20270105.csv、SHA256SUMS.sealed 不动）；
 *   tampered 补导时改了旧文件、清单也跟着改了；unsealed 没留 SHA256SUMS.sealed；forged SHA256SUMS.sealed 是事后照现在的清单抄的；
 *   corrupt  旧文件字节被改、清单没改（G3）；unlisted 多了一个清单里没有的 CSV；thin 补导的日线里 12-15 只剩 1 行。
 */
function holdoutVariants() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-holdout-variants-'));
  const names = ['partial', 'complete', 'tampered', 'unsealed', 'forged', 'corrupt', 'unlisted', 'thin', 'g5a', 'g5b', 'half', 'dupes', 'g5c', 'emptyseal'];
  const THIN = new Set(['S01.SH', 'S02.SH']); const HALF = new Set(['S01.SH', 'S02.SH', 'S03.SH', 'S04.SZ', 'S05.SZ', 'S06.SZ']); const SIX = HALF;
  const DATA = /^(prices_daily|market_daily_basic|adjustment_factor)/;
  const v = Object.fromEntries(names.map((n) => { const d = path.join(root, n); fs.mkdirSync(d); return [n, d]; }));
  const CUT = '2026-11-17';
  const sums = (dir) => {
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.csv')).sort();
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${files.map((n) => `${sha(fs.readFileSync(path.join(dir, n)))}  ${n}`).join('\n')}\n`);
  };
  for (const name of fs.readdirSync(fx.dirs.holdout).filter((n) => n.endsWith('.csv'))) {
    const rows = []; adapter.internals.forEachCsvRow(path.join(fx.dirs.holdout, name), (r) => rows.push(r));
    const cols = rows.length ? Object.keys(rows[0]) : fs.readFileSync(path.join(fx.dirs.holdout, name), 'utf8').split('\n')[0].split(',');
    const isCal = name === 'trading_calendar.csv';
    const day = (r) => r.trade_date || r.business_date;
    const early = isCal ? rows : rows.filter((r) => day(r) <= CUT); const late = isCal ? [] : rows.filter((r) => day(r) > CUT);
    for (const n of names) {
      const e = n === 'g5b' && DATA.test(name) ? early.filter((r) => THIN.has(r.security_id)) // G5b：封存的那一份也只有 2 只
        : n === 'emptyseal' && DATA.test(name) ? [] : early; // emptyseal：封存时还没有留出段的行情
      fs.writeFileSync(path.join(v[n], name), fixtureInternals.csv(cols, e));
    }
    if (isCal) continue;
    for (const n of names.filter((x) => x !== 'partial')) {
      const keep = n === 'thin' && name === 'prices_daily_stock.csv' ? late.filter((r) => r.trade_date !== '2026-12-15' || r.security_id === 'S01.SH')
        : (n === 'g5a' || n === 'g5b') && DATA.test(name) ? late.filter((r) => THIN.has(r.security_id)) // G5a / G5b：补导的每天只有 15 只里的 2 只
          : n === 'half' && name === 'prices_daily_stock.csv' ? late.filter((r) => r.trade_date !== '2026-12-15' || HALF.has(r.security_id))
            // dupes：补导的日线每天只有 2 只，但每行重复成 3 个修订（行数 6 ≥ 5，名字 2 < 5）
            : n === 'dupes' && name === 'prices_daily_stock.csv' ? late.filter((r) => THIN.has(r.security_id)).flatMap((r) => [1, 2, 3].map((k) => ({ ...r, revision: String(k), record_id: `${r.record_id}:r${k}` })))
              // G5c（再审 3）：补导每天 15 只里只有 6 只，过了测试的绝对下限 5，但不到封存那段中位数（15）的一半
              : n === 'g5c' && DATA.test(name) ? late.filter((r) => SIX.has(r.security_id))
                : n === 'emptyseal' && DATA.test(name) ? [...early, ...late] : late;
      fs.writeFileSync(path.join(v[n], name.replace(/\.csv$/, '_20270105.csv')), fixtureInternals.csv(cols, keep));
    }
  }
  sums(v.partial);
  for (const n of ['complete', 'tampered', 'corrupt', 'unlisted', 'thin', 'g5a', 'half', 'dupes', 'g5c']) fs.copyFileSync(path.join(v.partial, 'SHA256SUMS'), path.join(v[n], 'SHA256SUMS.sealed'));
  // G5b 的封存件是它自己那一份（封存时就薄）
  const g5bEarly = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-g5b-early-'));
  for (const n of fs.readdirSync(v.g5b).filter((x) => x.endsWith('.csv'))) fs.copyFileSync(path.join(v.g5b, n), path.join(g5bEarly, n));
  sums(g5bEarly); fs.copyFileSync(path.join(g5bEarly, 'SHA256SUMS'), path.join(v.g5b, 'SHA256SUMS.sealed'));
  const esEarly = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-emptyseal-early-'));
  for (const n of fs.readdirSync(v.emptyseal).filter((x) => x.endsWith('.csv') && !/_20270105\.csv$/.test(x))) fs.copyFileSync(path.join(v.emptyseal, n), path.join(esEarly, n));
  sums(esEarly); fs.copyFileSync(path.join(esEarly, 'SHA256SUMS'), path.join(v.emptyseal, 'SHA256SUMS.sealed'));
  const bump = (file) => { const t = fs.readFileSync(file, 'utf8').split('\n'); t[1] = t[1].replace(/,(\d+\.\d+),/, (m, x) => `,${(Number(x) * 1.01).toFixed(4)},`); fs.writeFileSync(file, t.join('\n')); };
  bump(path.join(v.tampered, 'prices_daily_stock.csv'));
  for (const n of names.filter((x) => x !== 'partial')) sums(v[n]);
  fs.copyFileSync(path.join(v.forged, 'SHA256SUMS'), path.join(v.forged, 'SHA256SUMS.sealed'));
  bump(path.join(v.corrupt, 'prices_daily_stock.csv')); // 清单不改
  fs.writeFileSync(path.join(v.unlisted, 'notes.csv'), 'a\n1\n');
  return { ...v, sealSha: sha(fs.readFileSync(path.join(v.partial, 'SHA256SUMS'))), g5bSealSha: sha(fs.readFileSync(path.join(g5bEarly, 'SHA256SUMS'))),
    emptySealSha: sha(fs.readFileSync(path.join(esEarly, 'SHA256SUMS'))) };
}

test('留出段目录的核对（开 vault 之前，纯函数）：每个列出的文件都核 sha、补导只追加、清单外的 CSV 拒绝、7 张表都要在、每个 SSE 开市日都有足够的 READY 日线 / daily_basic / 复权因子', () => {
  const hv = holdoutVariants();
  const seal = { data_sha256: hv.sealSha, segment: { from: '2026-10-19', to: '2026-12-31' } };
  const check = (dir, s = seal) => runner.holdoutDirCheck(dir, s, { minNamesPerDay: COV.min_names_per_day });
  assert.throws(() => check(hv.partial), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:prices_daily_stock\.csv:2026-11-18/), 'the full calendar does not make a partial export look complete');
  assert.throws(() => check(hv.unsealed), code(/MINE_RUNNER_HOLDOUT_SHA_MISMATCH/));
  assert.throws(() => check(hv.forged), code(/MINE_RUNNER_HOLDOUT_SHA_MISMATCH/));
  assert.throws(() => check(hv.tampered), code(/MINE_RUNNER_HOLDOUT_SEALED_FILES_CHANGED/));
  assert.throws(() => check(hv.corrupt), code(/MINE_RUNNER_HOLDOUT_FILE_SHA_MISMATCH:prices_daily_stock\.csv/));
  assert.throws(() => check(hv.unlisted), code(/MINE_RUNNER_HOLDOUT_FILE_UNLISTED:notes\.csv/));
  assert.throws(() => check(hv.thin), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:prices_daily_stock\.csv:2026-12-15:1$/));
  // 复审 G5：绝对下限按不同的 security_id 数（不是行数，行里有修订）；补导每天只有 2 只（G5a）、整段都只有 2 只（G5b）都拒绝
  assert.throws(() => check(hv.g5a), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:prices_daily_stock\.csv:2026-11-18:2$/));
  assert.throws(() => check(hv.g5b, { ...seal, data_sha256: hv.g5bSealSha }), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:prices_daily_stock\.csv:2026-10-19:2$/));
  assert.throws(() => check(hv.dupes), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:prices_daily_stock\.csv:2026-11-18:2$/), 'distinct security_id, not rows (rows include revisions)');
  // G5c：补导每天 6 只，过了绝对下限 5；相对下限锚在封存那段的中位数（15，封存之后挪不动），6 < 7.5 → 拒绝
  assert.throws(() => check(hv.g5c), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:prices_daily_stock\.csv:2026-11-18:6$/));
  // 封存那一份里没有任何留出段的行情（中位数无从锚定）→ 拒绝
  assert.throws(() => check(hv.emptyseal, { ...seal, data_sha256: hv.emptySealSha }), code(/MINE_RUNNER_HOLDOUT_SEALED_DAYS_EMPTY:prices_daily_stock\.csv/));
  // 过了绝对下限、但不到中位数一半的日子（12-15 只剩 6 只）也拒绝：两条都留着
  assert.throws(() => check(hv.half), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:prices_daily_stock\.csv:2026-12-15:6$/));
  // 生产默认的下限（每天 2,000 只）：16 只的合成数据一律不够
  assert.throws(() => runner.holdoutDirCheck(hv.complete, seal), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:prices_daily_stock\.csv:2026-10-19:\d+$/));
  const ok = check(hv.complete);
  assert.equal(ok.open_days, 54);
  assert.deepEqual(ok.floor, { min_names_per_day: 5, min_share_of_sealed_median: 0.5, basis: 'DISTINCT_SECURITY_ID_READY_EXCL_BJ', anchor: 'SEALED_DAYS_MEDIAN' });
  assert.equal(ok.rows_per_day['prices_daily_stock.csv'].min_names, 15, 'B01.BJ is not counted (16 ids in the file, 15 without the BSE one)');
  assert.equal(ok.rows_per_day['prices_daily_stock.csv'].sealed_median_names, 15);
  assert.deepEqual(Object.keys(ok.rows_per_day).sort(), ['adjustment_factor_observation_stock.csv', 'market_daily_basic_observation_stock.csv', 'prices_daily_stock.csv']);
  // 少一张表（封存时就少）：拒绝
  const noCover = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-holdout-notable-'));
  for (const n of fs.readdirSync(hv.complete).filter((x) => x.endsWith('.csv') && !x.startsWith('security_suspension_day_coverage'))) fs.copyFileSync(path.join(hv.complete, n), path.join(noCover, n));
  const files = fs.readdirSync(noCover).filter((n) => n.endsWith('.csv')).sort();
  fs.writeFileSync(path.join(noCover, 'SHA256SUMS'), `${files.map((n) => `${sha(fs.readFileSync(path.join(noCover, n)))}  ${n}`).join('\n')}\n`);
  assert.throws(() => check(noCover, { ...seal, data_sha256: sha(fs.readFileSync(path.join(noCover, 'SHA256SUMS'))) }), code(/MINE_RUNNER_HOLDOUT_TABLE_MISSING:security_suspension_day_coverage\.csv/));
  // 日历和数据都只到 11-17（旧式的半份导出）：日历不到留出段终点，拒绝
  const shortCal = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-holdout-shortcal-'));
  for (const n of fs.readdirSync(hv.partial).filter((x) => x.endsWith('.csv'))) {
    if (n !== 'trading_calendar.csv') { fs.copyFileSync(path.join(hv.partial, n), path.join(shortCal, n)); continue; }
    const rows = []; adapter.internals.forEachCsvRow(path.join(hv.partial, n), (r) => rows.push(r));
    fs.writeFileSync(path.join(shortCal, n), fixtureInternals.csv(Object.keys(rows[0]), rows.filter((r) => r.calendar_date <= '2026-11-17')));
  }
  const scFiles = fs.readdirSync(shortCal).filter((n) => n.endsWith('.csv')).sort();
  fs.writeFileSync(path.join(shortCal, 'SHA256SUMS'), `${scFiles.map((n) => `${sha(fs.readFileSync(path.join(shortCal, n)))}  ${n}`).join('\n')}\n`);
  assert.throws(() => check(shortCal, { ...seal, data_sha256: sha(fs.readFileSync(path.join(shortCal, 'SHA256SUMS'))) }), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:trading_calendar\.csv:2026-12-31/));
  assert.deepEqual(runner.HOLDOUT_FLOOR, { min_names_per_day: 4000, min_share_of_sealed_median: 0.5, basis: 'DISTINCT_SECURITY_ID_READY_EXCL_BJ', anchor: 'SEALED_DAYS_MEDIAN' });
  assert.equal(runner.COVERAGE_FLOOR.min_names_per_day, 2000, 'the mining-panel universe floor stays 2,000');
  // 日历只数 READY 的行：12-31 那一行不是 READY → 日历不到留出段终点
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-holdout-calstale-'));
  for (const n of fs.readdirSync(hv.complete).filter((x) => x.endsWith('.csv'))) {
    if (n !== 'trading_calendar.csv') { fs.copyFileSync(path.join(hv.complete, n), path.join(stale, n)); continue; }
    const rows = []; adapter.internals.forEachCsvRow(path.join(hv.complete, n), (r) => rows.push(r));
    fs.writeFileSync(path.join(stale, n), fixtureInternals.csv(Object.keys(rows[0]), rows.map((r) => (r.calendar_date === '2026-12-31' && r.exchange === 'SSE' ? { ...r, quality_state: 'STALE' } : r))));
  }
  const stFiles = fs.readdirSync(stale).filter((n) => n.endsWith('.csv')).sort();
  fs.writeFileSync(path.join(stale, 'SHA256SUMS'), `${stFiles.map((n) => `${sha(fs.readFileSync(path.join(stale, n)))}  ${n}`).join('\n')}\n`);
  assert.throws(() => check(stale, { ...seal, data_sha256: sha(fs.readFileSync(path.join(stale, 'SHA256SUMS'))) }), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE:trading_calendar\.csv:2026-12-31/));
});

test('验证折选择不回生成方（§1 第 5 步）；留出段只在开启时交出、目录核不过不开、只开一次；补导的带日期后缀文件照样核 sha', () => {
  const out = freshData();
  const hv = holdoutVariants();
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 2 }, cap: KNOWN.length, openedAt: '2026-11-21T02:00:00Z' });
  runner.sealHoldout({ roundId: r.round_id, dataRef: 'synthetic:holdout-partial', dataSha256: hv.sealSha });
  const holdoutSrc = adapter.csvDirSource(hv.complete, { mode: 'LIVE', label: 'holdout', holdout: true });
  assert.throws(() => runner.generate({ roundId: r.round_id, sources: [...sources(), holdoutSrc], outDir: out, registeredBy: AUTH, coverageFloor: COV }), code(/MINE_RUNNER_HOLDOUT_IN_GENERATION/));
  const g = runner.internals.withGenerator(knownGen, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV }));
  assert.equal(g.attempts.scored, KNOWN.length);
  const view = rounds.generatorView(r.round_id);
  const trialBytes = fs.readFileSync(trials.TRIALS ? trials.TRIALS() : path.join(out, 'research', 'trials.jsonl'));
  const sel = runner.select({ roundId: r.round_id, sources: sources(), outDir: out });
  assert.deepEqual(rounds.generatorView(r.round_id), view, 'selection never reaches the generator view');
  assert.ok(fs.readFileSync(trials.TRIALS ? trials.TRIALS() : path.join(out, 'research', 'trials.jsonl')).equals(trialBytes), 'selection writes no trial rows');
  for (const f of fs.readdirSync(path.join(out, 'research'))) assert.ok(!/"(fold_ic|positive_folds|mean_ic|ic_days)":/.test(fs.readFileSync(path.join(out, 'research', f), 'utf8')), `no fold statistics in ${f}`);
  assert.deepEqual(selector.folds().map((x) => [x.from, x.to]), [['2024-01-02', '2024-06-30'], ['2024-07-01', '2024-12-31'], ['2025-01-01', '2025-06-30'], ['2025-07-01', '2025-12-31'],
    ['2026-01-01', '2026-06-30'], ['2026-07-01', '2026-10-16']]);
  assert.equal(sel.candidates.length, KNOWN.length);
  assert.ok(sel.selected.includes(`${r.round_id}:A001`), 'the planted reversal passes the folds');
  assert.ok(sel.candidates.every((c) => c.fold_ic.length === 6 && c.neutralization.industry === 'APPLIED'));
  assert.ok(fs.existsSync(path.join(runDirOf(out, r.round_id), 'selection.json')));
  const selRow = rounds.selectionOf(r.round_id);
  assert.deepEqual(selRow.selected, sel.selected, 'selection ids are in an append-only ledger row');
  assert.equal(selRow.selection_sha256, sha(fs.readFileSync(path.join(runDirOf(out, r.round_id), 'selection.json'))));
  assert.throws(() => rounds.recordCandidate(r.round_id, { candidate_id: `${r.round_id}:A999`, formula_canonical: 'rank(pb)', formula_sha256: sha('rank(pb)'), holding_period: 5, mining_score: 0.1 },
    { registeredBy: AUTH }), code(/MINE_ROUND_GENERATION_CLOSED/));
  assert.throws(() => runner.internals.withGenerator(knownGen, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV })), code(/MINE_RUNNER_GENERATION_CLOSED/));
  assert.throws(() => runner.select({ roundId: r.round_id, sources: sources(), outDir: out }), code(/MINE_ROUND_SELECTION_EXISTS/));
  const mining = adapter.buildPanel({ sources: sources(), space: SPACE, segment: 'MINING', from: '2023-01-03', to: '2023-12-29' });
  assert.throws(() => selector.validationStats(require('../services/mining-sandbox/dsl').parse('rank(pb)', require('../services/mining-sandbox/space').dslSpaceOf(SPACE)), mining, { holding_period: 5 }),
    code(/MINE_SELECT_NOT_VALIDATION_PANEL/));

  // 留出段：先核目录，核不过不开
  const score = (dir) => runner.scoreHoldout({ roundId: r.round_id, sources: sources(), holdoutDir: dir, outDir: out, scoredAt: '2027-01-06T10:00:00+08:00', holdoutFloor: COV });
  assert.throws(() => score(hv.partial), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE/));
  assert.throws(() => score(hv.unsealed), code(/MINE_RUNNER_HOLDOUT_SHA_MISMATCH/));
  assert.throws(() => score(hv.tampered), code(/MINE_RUNNER_HOLDOUT_SEALED_FILES_CHANGED/));
  assert.throws(() => score(hv.forged), code(/MINE_RUNNER_HOLDOUT_SHA_MISMATCH/));
  assert.throws(() => score(hv.corrupt), code(/MINE_RUNNER_HOLDOUT_FILE_SHA_MISMATCH/), 'G3: a bad file is caught before the open, not after');
  // G2：输出目录里的 selection.json 被改（换公式、塞进没过验证折的候选）→ 对不上台账里的 sha，拒绝
  const selFile = path.join(runDirOf(out, r.round_id), 'selection.json'); const selBytes = fs.readFileSync(selFile);
  const forgedSel = JSON.parse(selBytes); forgedSel.candidates.find((c) => c.candidate_id === sel.selected[0]).formula = 'rank(ts_mean(amount,20))';
  forgedSel.selected.push(...forgedSel.candidates.filter((c) => !c.selected).map((c) => c.candidate_id));
  fs.writeFileSync(selFile, JSON.stringify(forgedSel));
  assert.throws(() => score(hv.complete), code(/MINE_RUNNER_SELECTION_FILE_MISMATCH/));
  fs.writeFileSync(selFile, selBytes);
  assert.equal(vault.openLog(r.round_id).length, 0, 'a failed check never spends the single open');
  assert.notEqual(rounds.roundHead(r.round_id).status, 'SCORING');
  assert.throws(() => runner.scoreHoldout({ roundId: r.round_id, sources: sources(), holdoutDir: hv.complete, outDir: out }), code(/MINE_RUNNER_HOLDOUT_INCOMPLETE/),
    'the production floor (4,000 names) refuses the 15-name fixture before the open');
  assert.equal(vault.openLog(r.round_id).length, 0);
  require('./_mining_manifest').reviewAll(r.round_id); // R1.5：协调会话复审机制之后才能打分
  const s = score(hv.complete);
  assert.equal(s.opened, true);
  assert.deepEqual(vault.openLog(r.round_id)[0].pre_open_checks.min_names_per_day, { value: 5, default: 4000, overridden: true }, 'the score-phase override is in the open record');
  assert.equal(s.records.length, sel.selected.length);
  const [open] = vault.openLog(r.round_id);
  assert.deepEqual(open.candidate_ids, sel.selected);
  const scoreFile = JSON.parse(fs.readFileSync(path.join(runDirOf(out, r.round_id), 'score.json'), 'utf8'));
  const trialFormula = new Map(roundTrials(r.round_id).map((t) => [t.mining.candidate_id, t.rule_config.formula]));
  assert.ok(scoreFile.results.every((x) => x.formula === trialFormula.get(x.candidate_id)), 'formulas come from the trial rows');
  assert.equal(scoreFile.holdout_panel.to, '2026-12-31', 'the date-suffixed completion files were read');
  assert.ok(scoreFile.results.every((x) => x.holdout.neutralization.industry === 'APPLIED' && Number.isFinite(x.holdout.ic_mean) && x.holdout.icir_non_overlapping === true));
  const scoring = require('../services/mining-sandbox/scoring');
  const dslSpace = require('../services/mining-sandbox/space').dslSpaceOf(SPACE);
  const hp = adapter.buildPanel({ sources: [...sources(), adapter.csvDirSource(hv.complete, { mode: 'LIVE', label: 'holdout', holdout: true })], space: SPACE, segment: 'HOLDOUT',
    from: '2020-06-01', to: '2026-12-31' });
  for (const res of scoreFile.results) {
    const neu = scoring.neutralizedValues(require('../services/mining-sandbox/dsl').parse(res.formula, dslSpace), hp);
    const ic = scoring.dailyRankIc(neu.values, scoring.forwardReturns(hp, 5), hp.universe);
    const days = hp.dates.map((d, t) => (d >= '2026-10-19' ? t : -1)).filter((t) => t >= 0);
    const xs = days.map((t) => ic[t]).filter(Number.isFinite);
    assert.equal(res.holdout.ic_mean, xs.reduce((x, y) => x + y, 0) / xs.length, `${res.candidate_id} ic_mean recomputed from the holdout days only`);
    const no = days.filter((_, k) => k % 5 === 0).map((t) => ic[t]).filter(Number.isFinite);
    const m = no.reduce((x, y) => x + y, 0) / no.length; const sdv = Math.sqrt(no.reduce((x, y) => x + (y - m) ** 2, 0) / (no.length - 1));
    assert.equal(res.holdout.icir, m / sdv, `${res.candidate_id} icir on non-overlapping holding periods`);
    assert.equal(res.overfit.n_trials, KNOWN.length);
  }
  assert.throws(() => score(hv.complete), code(/MINE_HOLDOUT_ALREADY_OPENED/));
  const closed = runner.close({ roundId: r.round_id });
  assert.deepEqual([closed.status, closed.gmine_passes, closed.gmine_basis.records], ['CLOSED', 0, sel.selected.length]);
  const extra = path.join(hv.complete, 'trading_calendar_20270301.csv'); fs.copyFileSync(path.join(hv.complete, 'trading_calendar.csv'), extra);
  assert.throws(() => adapter.csvDirSource(hv.complete, { mode: 'LIVE', label: 'h', holdout: true }).forEach('calendar', () => {}), code(/MINE_DATA_FILE_NOT_IN_SHA256SUMS/));
});

test('唯一生产者（§4 第 6 条）：留出段结果只经执行器（holdout-scoring → neutralizeForScoring → recordGateResult）；没有中性化戳的结果进 G-MINE 被拒（P1 回归）', () => {
  const hits = { record: [], neutralize: [], scorer: [], open: [] };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'var', '.git', 'tests'].includes(e.name)) walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const s = fs.readFileSync(p, 'utf8'); const rel = path.relative(ROOT, p);
      if (/recordGateResult\(/.test(s)) hits.record.push(rel);
      if (/neutralizeForScoring\(/.test(s)) hits.neutralize.push(rel);
      if (/require\(['"][./]*(round-runner\/)?holdout-scoring['"]\)/.test(s)) hits.scorer.push(rel);
      if (/\bvault\.open\(|holdout-vault['"]\)\.open\(/.test(s)) hits.open.push(rel);
    }
  };
  for (const d of ['services', 'apps', 'packages', 'adapters', 'tools']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  assert.deepEqual(hits.record.sort(), ['services/mining-rounds/gate-records.js', 'services/mining-sandbox/round-runner/index.js']);
  assert.deepEqual(hits.neutralize.sort(), ['services/mining-sandbox/evaluator/index.js', 'services/mining-sandbox/scoring/index.js']);
  assert.deepEqual(hits.scorer, ['services/mining-sandbox/round-runner/index.js']);
  assert.deepEqual(hits.open, ['services/mining-sandbox/round-runner/index.js']);
  const val = adapter.buildPanel({ sources: sources(), space: SPACE, segment: 'VALIDATION', from: '2026-01-05', to: '2026-10-16' });
  const parsed = require('../services/mining-sandbox/dsl').parse('rank(pb)', require('../services/mining-sandbox/space').dslSpaceOf(SPACE));
  assert.throws(() => holdoutScoring.scoreCandidate(parsed, val, { holding_period: 5 }), code(/MINE_HOLDOUT_SCORE_NOT_HOLDOUT_PANEL/));
  const c = { market: 'CN_A', holdout: { ic_mean: 0.05, icir: 0.5, icir_non_overlapping: true, quintile_mean_returns: [0.01, 0.02, 0.03, 0.04, 0.05], ic_double_horizon: 0.04,
    neutralization: { industry: 'APPLIED', size: 'APPLIED' } } };
  const items = (x) => Object.fromEntries(gate.evaluate(x, { thresholds: gate.THRESHOLDS, familyTrialCount: 10 }).items.map((i) => [i.item, i.codes]));
  for (const k of [3, 4, 5]) assert.ok(!items(c)[k].includes('MINE_NOT_NEUTRALIZED'));
  const { neutralization: _n, ...bare } = c.holdout;
  for (const k of [3, 4, 5]) assert.ok(items({ ...c, holdout: bare })[k].includes('MINE_NOT_NEUTRALIZED'), `item ${k}`);
});

test('隔离（§4 第 7 条）：执行器启动即 lockdown，写输出目录以外被拒（台账的 append 也一样）；台账目录不在输出目录里就不启动；命令行两条命令都先 start', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-runner-out-')); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-runner-outside-'));
  const script = `
    const fs = require('fs'); const runner = require(${JSON.stringify(path.join(ROOT, 'services/mining-sandbox/round-runner'))});
    const res = {};
    try { runner.start({ outDir: ${JSON.stringify(outDir)} }); res.start = 'OK'; } catch (e) { process.stdout.write(JSON.stringify({ start: e.code })); process.exit(0); }
    const tryIt = (k, f) => { try { f(); res[k] = 'OK'; } catch (e) { res[k] = e.code; } };
    tryIt('inside', () => fs.writeFileSync(${JSON.stringify(path.join(outDir, 'ok.txt'))}, 'x'));
    tryIt('outside', () => fs.writeFileSync(${JSON.stringify(path.join(outside, 'no.txt'))}, 'x'));
    tryIt('ledger_outside', () => require(${JSON.stringify(path.join(ROOT, 'packages/ledger'))}).append(${JSON.stringify(path.join(outside, 'x.jsonl'))}, { a: 1 }));
    process.stdout.write(JSON.stringify(res));`;
  const run = (dataDir) => JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, QRP_DATA_DIR: dataDir } }).toString());
  assert.deepEqual(run(path.join(outDir, 'qrp-data')), { start: 'OK', inside: 'OK', outside: 'MINE_SANDBOX_WRITE_REFUSED', ledger_outside: 'MINE_SANDBOX_WRITE_REFUSED' });
  assert.equal(run(path.join(outside, 'qrp-data')).start, 'MINE_RUNNER_DATA_DIR_OUTSIDE_OUTPUT');
  assert.deepEqual(fs.readdirSync(outside), []);
  const src = fs.readFileSync(CLI, 'utf8');
  const main = src.slice(src.indexOf('function main'));
  assert.equal(main.split('runner.start(').length - 1, 4, 'generate, mechanisms, review (R1.5) and score all lock down first');
  assert.ok(main.indexOf('runner.start(') < main.indexOf('runner.generate(') && main.lastIndexOf('runner.start(') < main.indexOf('runner.scoreHoldout('));
  assert.ok(main.lastIndexOf('runner.start(') > main.indexOf('runner.select('), 'the score branch has its own start');
});

test('容器定义（静态）：基础镜像按摘要钉住、npm ci 按锁文件；两个阶段都 --network none、只读根、去掉全部能力、非 root、限 CPU/内存/进程；数据只读、唯一可写的是 /out；留出段只在 score 挂', () => {
  const dir = path.join(ROOT, 'deploy/research-lane/round-runner');
  const df = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8');
  assert.match(df, /^FROM node:[0-9a-z.-]+@sha256:[0-9a-f]{64}$/m, 'base image pinned by digest (the lane has no Docker Hub)');
  assert.match(df, /Node 22\.23\.3/);
  assert.match(df, /^COPY package\.json package-lock\.json \.\/$/m);
  assert.match(df, /^RUN npm ci\b/m);
  assert.match(df, /^USER 1000:1000$/m);
  assert.match(df, /^ENTRYPOINT \[.*services\/mining-sandbox\/round-runner\/cli\.js"\]$/m);
  assert.ok(!/^EXPOSE/m.test(df));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual([lock.name, lock.version, lock.lockfileVersion], [pkg.name, pkg.version, 3]);
  const ignore = fs.readFileSync(path.join(dir, 'Dockerfile.dockerignore'), 'utf8').split('\n');
  for (const k of ['.git', 'var', 'tests']) assert.ok(ignore.includes(k), k);
  const sh = fs.readFileSync(path.join(dir, 'run.sh'), 'utf8');
  const runs = sh.split('\n').filter((l) => /^\s*docker run /.test(l));
  assert.equal(runs.length, 6); // generate、resume、mechanisms（R1.5）、review（R1.5 复审）、rescore（R1.8）、score
  for (const l of runs) {
    for (const flag of ['--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 1000:1000', '-e QRP_DATA_DIR=/out/qrp-data']) assert.ok(l.includes(flag), `${flag} in ${l.slice(0, 60)}`);
    assert.match(l, /--cpus \d+ /); assert.match(l, /--memory \d+g /); assert.match(l, /--memory-swap \d+g /); assert.match(l, /--pids-limit \d+ /);
    const mounts = [...l.matchAll(/-v "([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(mounts.filter((m) => !m.endsWith(':ro')), ['$OUT:/out:rw']);
    assert.ok(!/--privileged|--network host|--cap-add|docker\.sock:/.test(l));
  }
  const score = runs.filter((l) => / score /.test(l)); const gen = runs.filter((l) => / generate /.test(l));
  assert.equal(gen.length, 2, 'generate and resume');
  assert.equal(score.length, 1);
  assert.ok(score[0].includes('-v "$HOLDOUT:/data/holdout:ro"'));
  assert.ok(gen.every((l) => !/\$HOLDOUT[:"]/.test(l) && !l.includes('/data/holdout') && !l.includes('--holdout ')));
  const deploy = fs.readFileSync(path.join(dir, 'DEPLOY.md'), 'utf8');
  for (const v of ['LANE', 'LANE_COPY', 'VAL_TAIL', 'HOLDOUT', 'OUT']) {
    const m = new RegExp(`^${v}="?([^"\\n]+)"?$`, 'm').exec(sh);
    assert.ok(m, v);
    assert.ok(deploy.includes(m[1].replace('$LANE', '/srv/research-lane/rf1116-mining')), `${v} documented in DEPLOY.md`);
  }
  assert.ok(deploy.includes('run.sh generate') && deploy.includes('run.sh score') && deploy.includes('kayla') && deploy.includes('100999'));
  for (const t of ['canonical_calendar_observation', 'canonical_security_observation', 'a24afab2', '--pull=false', 'c3de60bf', '2,000']) assert.ok(deploy.includes(t), `DEPLOY.md: ${t}`);
});

test('选择规则 VALIDATION_SELECTION_V1（R1.2 冻结）：全折均值 > 0、正折 ≥ 4/6、挖掘段分数 > 0', () => {
  const st = (mean_ic, positive_folds) => ({ mean_ic, positive_folds });
  assert.equal(selector.passes(st(0.01, 4), 0.01), true);
  assert.equal(selector.passes(st(0.01, 3), 0.01), false);
  assert.equal(selector.passes(st(0, 6), 0.01), false);
  assert.equal(selector.passes(st(0.01, 6), -0.01), false);
  assert.equal(selector.passes(st(null, 6), 0.01), false);
  assert.equal(selector.passes(st(0.01, 6), null), false);
  assert.equal(selector.RULE.state, 'FROZEN'); // R1.2
});

test('留出段打分的口径（手算得出）：五分组、IC、只做多前 20% 扣佣金滑点、卖出加印花税、相对等权池的年化超额', () => {
  const dates = []; for (let d = '2026-12-14'; d <= '2026-12-31'; d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)) if (![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) dates.push(d);
  const T = dates.length; const N = 10; const codes = Array.from({ length: N }, (_, j) => `X${j}`);
  const grow = (j) => 1 + 0.001 * (j + 1);
  const ex = dates.map((_, t) => codes.map((_, j) => 10 * grow(j) ** t));
  const pb = dates.map((_, t) => codes.map((_, j) => (t < 4 ? j : -j)));
  // 涨跌停的输入（R1.7）：开盘 = 前收，从不触及涨跌停
  const panel = { segment: 'HOLDOUT', dates, codes, readings: { pb }, industry: dates.map(() => codes.map(() => '801010')), size: dates.map(() => codes.map(() => 1e9)),
    universe: dates.map(() => codes.map(() => true)), board: codes.map(() => 'MAIN'), st: dates.map(() => codes.map(() => false)),
    labels: { exec_open: ex, open_raw: dates.map(() => codes.map(() => 10)), prev_close_raw: dates.map(() => codes.map(() => 10)) } };
  const parsed = require('../services/mining-sandbox/dsl').parse('pb', require('../services/mining-sandbox/space').dslSpaceOf(SPACE));
  const H = 2; const s = holdoutScoring.scoreCandidate(parsed, panel, { holding_period: H });
  const fwd = (j) => grow(j) ** H - 1; const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  // 期：t = 0, 2, 4, …（t + H < T）；t < 4 时前 20% 是 X9、X8，t ≥ 4 换成 X0、X1（买入 100%、卖出 100%）
  const periods = []; for (let t = 0; t + H < T; t += H) periods.push(t);
  const c = holdoutScoring.NET.cost; const one = (c.commission_bps + c.slippage_bps) / 1e4;
  const net = periods.map((t) => (t < 4 ? mean([fwd(9), fwd(8)]) : mean([fwd(0), fwd(1)])) - (t === 0 ? one : t === 4 ? one + one + c.stamp_duty_bps / 1e4 : 0));
  const bench = periods.map(() => mean(codes.map((_, j) => fwd(j))));
  const prod = (xs) => xs.reduce((a, x) => a * (1 + x), 1);
  const want = (prod(net) / prod(bench)) ** (242 / (periods.length * H)) - 1;
  assert.equal(s.net_of_cost.periods, periods.length);
  assert.ok(Math.abs(s.net_of_cost.annualized_excess - want) < 1e-12, `${s.net_of_cost.annualized_excess} vs ${want}`);
  assert.deepEqual([s.net_of_cost.long_only, s.net_of_cost.top_fraction, s.net_of_cost.benchmark, c.commission_bps, c.slippage_bps, c.stamp_duty_on_sell], [true, 0.2, 'EQUAL_WEIGHT_UNIVERSE', 2.5, 10, true]);
  assert.equal(s.holdout.ic_days, T - H);
  const q = s.holdout.quintile_mean_returns;
  assert.equal(q.length, 5);
  assert.ok(Math.abs(s.holdout.ic_mean - mean(dates.slice(0, T - H).map((_, t) => (t < 4 ? 1 : -1)))) < 1e-12, 'IC +1 before the flip, −1 after');
  // 五分组：在同样的不重叠日上，组 k 在翻转前是 {2k, 2k+1}，翻转后是 {9−2k, 8−2k}
  const before = periods.filter((t) => t < 4).length; const after = periods.length - before;
  q.forEach((v, k) => {
    const exp = (before * mean([fwd(2 * k), fwd(2 * k + 1)]) + after * mean([fwd(9 - 2 * k), fwd(8 - 2 * k)])) / periods.length;
    assert.ok(Math.abs(v - exp) < 1e-12, `quintile ${k + 1}: ${v} vs ${exp}`);
  });
  assert.ok(Number.isFinite(s.holdout.ic_double_horizon));
  assert.equal(s.holdout.icir_non_overlapping, true);
  assert.deepEqual(s.holdout.neutralization, { industry: 'APPLIED', size: 'APPLIED' });
});

test('端到端（§4 第 9 条）：命令行在子进程里跑一轮 GP，从开轮到关轮；台账、留出段日志、G-MINE 记录前后一致；同种子再跑一次，尝试串逐字节相同', () => {
  const run = (seed) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-runner-e2e-'));
    const env = { QRP_DATA_DIR: path.join(out, 'qrp-data'), QRP_PRODUCT_MILESTONE_AUTHORITY: AUTH };
    const g = cli(['generate', '--out', out, '--lane', fx.dirs.lane, '--tail', fx.dirs.tail, '--seed', String(seed), '--cap', '24', '--min-names-per-day', '5',
      '--holdout-ref', 'synthetic:holdout', '--holdout-sha256', HOLDOUT_SUMS_SHA], env);
    assert.equal(g.status, 0, g.stderr);
    return { out, env, g: JSON.parse(g.stdout) };
  };
  const a = run(7);
  assert.equal(a.g.total, 24);
  assert.equal(a.g.attempts.scored + a.g.attempts.parse_refused + a.g.attempts.deduped, 24);
  assert.equal(a.g.attempts.parse_refused, 0, 'GP emits only legal DSL');
  assert.ok(a.g.selected >= 1, `some GP candidate passes the folds (${a.g.selected})`);
  const b = run(7);
  const texts = (x) => lines(path.join(runDirOf(x.out, x.g.round_id), 'attempts.jsonl')).map((l) => l.text).join('\n');
  assert.equal(sha(texts(a)), sha(texts(b)), 'same seed, space and data: byte-identical formula list');

  // R1.5：mechanisms 列出机制集合的 sha → 协调会话写裁决文件 → review 一步写 MECHANISM_REVIEW_V1 → 才能 score
  const noReview = cli(['score', '--out', a.out, '--round', a.g.round_id, '--lane', fx.dirs.lane, '--tail', fx.dirs.tail, '--holdout', fx.dirs.holdout, '--min-names-per-day', '5'], a.env);
  assert.equal(noReview.status, 2); assert.equal(JSON.parse(noReview.stderr).error, 'MINE_RUNNER_MECHANISM_REVIEW_MISSING');
  const listed = JSON.parse(cli(['mechanisms', '--out', a.out, '--round', a.g.round_id], a.env).stdout);
  assert.match(listed.mechanism_set_sha256, /^[0-9a-f]{64}$/); assert.equal(listed.review, null);
  const verdictFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-verdicts-')), 'verdicts.json'); // 车道上只读挂进来，不在 out/ 里
  fs.writeFileSync(verdictFile, JSON.stringify({ mechanism_set_sha256: listed.mechanism_set_sha256, reviewer: 'coordinator',
    verdicts: listed.survivors.map((x) => ({ candidate_id: x.candidate_id, verdict: 'REJECTED', note: 'no mechanism registered (synthetic)' })) }));
  assert.equal(cli(['review', '--out', a.out, '--round', a.g.round_id], a.env).status, 2, '--file is required');
  const rv = cli(['review', '--out', a.out, '--round', a.g.round_id, '--file', verdictFile], a.env);
  assert.equal(rv.status, 0, rv.stderr);
  assert.deepEqual([JSON.parse(rv.stdout).command, JSON.parse(rv.stdout).verdicts], ['review', { APPROVED: 0, REJECTED: listed.survivors.length }]);
  const s = cli(['score', '--out', a.out, '--round', a.g.round_id, '--lane', fx.dirs.lane, '--tail', fx.dirs.tail, '--holdout', fx.dirs.holdout, '--min-names-per-day', '5'], a.env);
  assert.equal(s.status, 0, s.stderr);
  const sOut = JSON.parse(s.stdout);
  assert.deepEqual([sOut.opened, sOut.records, sOut.passes, sOut.status], [true, a.g.selected, 0, 'CLOSED']);

  process.env.QRP_DATA_DIR = a.env.QRP_DATA_DIR;
  const id = a.g.round_id;
  const round = rounds.roundHead(id);
  assert.deepEqual([round.status, round.candidates_scored, round.cap, round.generator.mode, round.generator.gp_seed], ['CLOSED', 24, 24, 'AI_MINED_GP', 7]);
  assert.equal(round.space.sha256, runner.FROZEN_INPUTS.space.sha256);
  assert.deepEqual(round.holdout, { from: '2026-10-19', to: '2026-12-31' });
  assert.deepEqual(round.data_checks, { coverage_floor: { min_names_per_day: 5, default: 2000, overridden: true } }, 'the generate-phase override is in the round row');
  const rows = roundTrials(id);
  assert.equal(rows.length, 24);
  const log = lines(path.join(runDirOf(a.out, id), 'attempts.jsonl'));
  assert.deepEqual(log.map((x) => x.candidate_id).sort(), rows.map((t) => t.mining.candidate_id).sort());
  const opened = round.status === 'CLOSED' ? rounds.manifestSha({ ...round, status: 'OPEN' }) : null;
  assert.ok(rows.every((t) => t.k2_sha256 === opened && t.mining.generator === 'AI_MINED_GP' && t.mining.space_sha256 === round.space.sha256));
  const seals = read(vault.LEDGER()).filter((x) => x.schema === vault.SEAL_SCHEMA && x.round_id === id);
  assert.equal(seals.length, 1);
  assert.equal(seals[0].data_sha256, HOLDOUT_SUMS_SHA);
  const opens = vault.openLog(id);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].seal_hash, seals[0].record_hash);
  const selection = JSON.parse(fs.readFileSync(path.join(runDirOf(a.out, id), 'selection.json'), 'utf8'));
  assert.deepEqual(opens[0].candidate_ids, selection.selected);
  const recs = gateRecords.recordsOf(id);
  assert.deepEqual(recs.map((x) => x.candidate_id), selection.selected);
  const headsById = new Map(rows.map((t) => [t.mining.candidate_id, t]));
  for (const x of recs) {
    assert.equal(x.trial_record_hash, headsById.get(x.candidate_id).record_hash);
    assert.equal(x.holdout_open_hash, opens[0].record_hash);
    assert.equal(x.pass, false);
    assert.equal(x.thresholds_used.state, 'FROZEN');
    assert.equal(x.family_trial_count, 24);
    // R1.3：DSR 在验证折上算得出（不再是 UNKNOWN）；R1.4：没给现有因子序列 → 第 7、8 项照实 UNKNOWN；R1.5：没登记机制 → 第 9 项不过
    for (const c of ['MINE_MARGINAL_INPUT', 'MINE_CORRELATION_UNKNOWN', 'MINE_MECHANISM_UNKNOWN']) assert.ok(x.codes.includes(c), `${x.candidate_id}:${c}`);
    assert.equal(x.excluded_factors.length, 3, 'R1.9 exclusions are named even without a factor series');
    assert.ok(!x.codes.includes('MINE_DSR_UNKNOWN'), `${x.candidate_id}: DSR on the validation folds`);
    for (const c of ['MINE_NOT_NEUTRALIZED', 'MINE_DSR_N_NOT_CUMULATIVE', 'MINE_PBO_SCOPE', 'MINE_NET_SCOPE', 'MINE_NET_COST_BELOW_FLOOR', 'MINE_ICIR_OVERLAPPING']) assert.ok(!x.codes.includes(c), c);
  }
  assert.deepEqual(round.gmine_basis.record_hashes, recs.map((x) => x.record_hash));
  assert.equal(round.gmine_basis.holdout_open_hash, opens[0].record_hash);
  const top = fs.readdirSync(a.out).sort();
  assert.deepEqual(top, ['qrp-data', 'rounds']);
  process.env.QRP_DATA_DIR = dataRoot;
});
