'use strict';

/**
 * 挖掘轮次执行器（RF1116 P2 规格 §1；MINING_ROUNDS_V1「P2 requirements」；★R (a)：一轮只用一种生成方式，现在只有 GP）。
 * 只在研究车道的 rootless 容器里跑（deploy/research-lane/round-runner/）：启动即 lockdown，只许写一个输出目录；台账（QRP_DATA_DIR）必须在输出目录里。
 * 九步都走 QRP 正门（services/mining-rounds、services/holdout-vault、services/mining-rounds/gate-records），执行器不直接写台账文件：
 *
 *   1 开轮      requestRound：冻结的空间（docs/freeze 的 JSON + 冻结页，sha 对上）、持有期、GP 种子、上限 ≤ 200、冻结的留出段起止；要大模型 → MINE_LLM_NOT_ENABLED（开轮之前就拒）
 *   2 封存      sealHoldout：留出段目录的引用与它 SHA256SUMS 的 sha256（协调会话在车道上算好交进来；生成阶段的容器不挂这个目录）
 *   3–4 生成    generate：每批只给生成方 generatorView；每个尝试都记一行试验台账（recordCandidate），到上限停、不补：
 *              解析不过的 → PARSE_REFUSED、规范写法已试过的 → DEDUPED（都没有分数，rule_config 里写尝试编号，所以各算一次 N），其余在挖掘段打分 → SCORED
 *   5 选择      select：前推验证折上算 IC（./selector.js），结果只写进输出目录的 selection.json，不进台账、不进 generatorView；选完本轮不能再生成
 *   6 开留出段  scoreHoldout 先核留出段目录（SHA256SUMS 对得上封存的 sha，补导的只许追加；交易日历到留出段终点），核过才 holdout-vault.open（每轮一次）
 *   7 打分      只经 ./holdout-scoring.js（先 neutralizeForScoring）——执行器是留出段结果的唯一生产者
 *   8 记录      每个候选一行 recordGateResult（门槛只读钉住的文件）
 *   9 关轮      close：过了几个由记录数出来
 * 输出目录 <out>/rounds/<round_id>/：attempts.jsonl（每个尝试）、generate.json、selection.json、score.json。错误码 MINE_RUNNER_*。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rounds = require('../../mining-rounds');
const vault = require('../../holdout-vault');
const gateRecords = require('../../mining-rounds/gate-records');
const spaceMod = require('../space');
const dsl = require('../dsl');
const adapter = require('../data-adapter');
const scoring = require('../scoring');
const generators = require('../generators');
const segs = require('../segments');
const { lockdown } = require('../isolation');
const selector = require('./selector');
const holdoutScoring = require('./holdout-scoring');

const REPO = path.join(__dirname, '..', '..', '..');
const MARKET = 'CN_A';
const RUNNER_ID = 'RF1116_ROUND_RUNNER';
/** 冻结的输入（仓库里的副本，车道上不读协调目录）。 */
const FROZEN_INPUTS = Object.freeze({
  space: Object.freeze({ path: 'docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json', sha256: '0d3556fa97f17d3a67b350e7f74c12fb521ca1fb60c293121601f7eb95f96637' }),
  space_freeze: Object.freeze({ path: 'docs/freeze/MINING_SPACE_V1_CN_A_R1_FREEZE_1.md', sha256: '4ec642b9ae87e7cd69b1bd226cc8964647dcace26a1dec60c0124df23fd8af69' }),
  holdout_freeze: segs.FREEZE_PAGE,
});

/**
 * 挖掘段的覆盖下限（独立复审 2026-11-17 第 4 条）：开轮之前、记任何尝试之前，挖掘段每个决策日（第一天除外，它没有前一日的行）在股票池里、
 * 后复权收盘价有数的名字至少这么多；不够就拒绝（MINE_RUNNER_COVERAGE_BELOW_FLOOR），免得空的股票池往 N 里写 200 个没有分数的尝试。
 * 2,000：2020-06 沪深主板 + 创业板 + 科创板约 3,800 只，扣掉 ST、上市不满 120 日、停牌后仍在 3,000 以上；取一个留足余量、又挡得住缺一大块数据的数。
 */
const COVERAGE_FLOOR = Object.freeze({ min_names_per_day: 2000 });
/**
 * 留出段目录的完整性下限（复审第 1 条与再审 G5）：留出段里每个 SSE 开市日，日线、daily_basic、复权因子三张表各自按 READY 行里
 * **不同的 security_id** 数（行里有修订，不按行数）：
 *   - 绝对下限：≥ COVERAGE_FLOOR.min_names_per_day（与挖掘段同一个数，生产 2,000；测试可以压低，压低的数写进开启记录）；
 *   - 相对下限：≥ 该表各开市日名字数中位数的一半（绝对下限之上，再拦住个别缺了一大半的日子）。
 * 只用相对下限时，薄的补导（例如 11-18 以后每天 15 只里只有 2 只，占 54 天里的 32 天）会把中位数本身拉低而蒙混过去（G5a / G5b）。
 */
const HOLDOUT_FLOOR = Object.freeze({ min_share_of_median_day: 0.5, basis: 'DISTINCT_SECURITY_ID_READY' });
/** 留出段目录必须有的 7 张表（导出规格 rev 3 §2；行业成员只在 A 目录）。 */
const HOLDOUT_TABLES = Object.freeze(['prices_daily_stock.csv', 'market_daily_basic_observation_stock.csv', 'adjustment_factor_observation_stock.csv', 'security_master_stock.csv',
  'security_suspension_observation.csv', 'security_suspension_day_coverage.csv', 'trading_calendar.csv']);

class RunnerError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new RunnerError(`MINE_RUNNER_${code}`, detail); };
const need = (c, code, detail) => { if (!c) fail(code, detail); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SHA64_RE = /^[0-9a-f]{64}$/;
const now = () => new Date().toISOString();
const inside = (p, root) => { const rel = path.relative(path.resolve(root), path.resolve(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

let generatorOverride = null;
let frozenInputs = FROZEN_INPUTS;

/** 启动：输出目录要在、台账目录要在输出目录里；然后 lockdown（之后本进程只能写输出目录）。 */
function start({ outDir } = {}) {
  need(outDir && fs.existsSync(outDir) && fs.statSync(outDir).isDirectory(), 'OUT_DIR_INVALID', outDir);
  const real = fs.realpathSync(outDir);
  const data = process.env.QRP_DATA_DIR ? path.resolve(process.env.QRP_DATA_DIR) : null; // 台账目录（packages/ledger 的 dataDir 取同一个变量）
  need(data && (inside(data, outDir) || inside(data, real)), 'DATA_DIR_OUTSIDE_OUTPUT', String(data));
  const locked = lockdown({ allowRoot: outDir });
  return { outDir: real, dataDir: data, allowRoot: locked.allowRoot };
}

/** 冻结的空间：仓库副本的 sha 对上、过 parseSpace（登记表、PIT、算子因果证据）、冻结页写着它。 */
function loadFrozenSpace() {
  const read1 = (ref) => { const b = fs.readFileSync(path.join(REPO, ref.path)); need(sha256(b) === ref.sha256, 'FROZEN_INPUT_MISMATCH', ref.path); return b; };
  const bytes = read1(frozenInputs.space);
  const s0 = JSON.parse(bytes.toString('utf8'));
  const evBytes = fs.readFileSync(path.join(REPO, s0.operator_evidence.path));
  const space = spaceMod.parseSpace(bytes, { evidence: JSON.parse(evBytes.toString('utf8')), evidenceBytes: evBytes });
  const page = read1(frozenInputs.space_freeze);
  const freeze = spaceMod.verifyFreeze(space, { path: frozenInputs.space_freeze.path, bytes: page, sha256: frozenInputs.space_freeze.sha256 });
  read1(frozenInputs.holdout_freeze);
  need(space.holding_periods.length === 1, 'HOLDING_PERIODS_UNSUPPORTED', space.holding_periods.join(','));
  return { space, dslSpace: spaceMod.dslSpaceOf(space), freeze, holdingPeriod: space.holding_periods[0] };
}

const runDir = (outDir, roundId) => { const d = path.join(outDir, 'rounds', roundId.replace(/[^A-Za-z0-9_-]/g, '_')); fs.mkdirSync(d, { recursive: true }); return d; };
const writeJson = (file, o) => fs.writeFileSync(file, `${JSON.stringify(o, null, 2)}\n`);

/** 第 1 步：开轮。要大模型 → MINE_LLM_NOT_ENABLED，在 openRound 之前。 */
function requestRound({ generator, cap = rounds.LIMITS.candidates_per_round, openedAt = null, coverageFloor = COVERAGE_FLOOR } = {}) {
  generators.assertGeneratorEnabled(generator);
  need(Number.isInteger(generator.gp_seed), 'GP_SEED_REQUIRED');
  const f = loadFrozenSpace();
  return rounds.openRound({
    market: MARKET, space: { space_ref: f.space.space_ref, sha256: f.space.sha256, freeze: f.freeze }, holding_periods: [...f.space.holding_periods],
    generator: { mode: 'AI_MINED_GP', gp_seed: generator.gp_seed }, holdout: { from: segs.SEGMENTS.HOLDOUT.from, to: segs.SEGMENTS.HOLDOUT.to }, cap, openedAt: openedAt || undefined,
    data_checks: { coverage_floor: { min_names_per_day: coverageFloor.min_names_per_day, default: COVERAGE_FLOOR.min_names_per_day,
      overridden: coverageFloor.min_names_per_day !== COVERAGE_FLOOR.min_names_per_day } },
  });
}

/** 第 2 步：封存留出段（只记引用与 SHA256SUMS 的 sha256；数据不进 QRP，生成阶段也不挂）。 */
function sealHoldout({ roundId, dataRef, dataSha256, sealedAt = null }) {
  const r = rounds.roundHead(roundId);
  need(r, 'ROUND_NOT_FOUND', roundId);
  return vault.seal({ round_id: roundId, segment: { ...r.holdout }, data_ref: dataRef, data_sha256: dataSha256, sealedBy: RUNNER_ID, sealedAt });
}

const attemptId = (roundId, n) => `${roundId}:A${String(n).padStart(3, '0')}`;

/** 挖掘段面板的逐日覆盖：池里且后复权收盘价有数的名字数；有一天低于下限就拒绝。返回 { min, min_date, median, days }。 */
function checkCoverage(panel, floor = COVERAGE_FLOOR) {
  need(panel && panel.segment === 'MINING' && panel.readings && panel.readings.close_hfq, 'COVERAGE_PANEL_INVALID');
  need(Number.isInteger(floor.min_names_per_day) && floor.min_names_per_day >= 1, 'COVERAGE_FLOOR_INVALID', floor.min_names_per_day);
  const counts = panel.dates.map((_, t) => panel.codes.reduce((n, _c, j) => n + (panel.universe[t][j] && Number.isFinite(panel.readings.close_hfq[t][j]) ? 1 : 0), 0));
  const days = counts.slice(1);
  need(days.length, 'COVERAGE_PANEL_INVALID', 'no decision day after the first');
  let min = Infinity; let minDate = null;
  days.forEach((n, k) => { if (n < min) { min = n; minDate = panel.dates[k + 1]; } });
  need(min >= floor.min_names_per_day, 'COVERAGE_BELOW_FLOOR', `${minDate}:${min}<${floor.min_names_per_day}`);
  const sorted = [...days].sort((a, b) => a - b);
  return { min, min_date: minDate, median: sorted[Math.floor(sorted.length / 2)], days: days.length, floor: { ...floor } };
}

/**
 * 第 3–4 步：生成 + 挖掘段打分 + 每个尝试一行试验台账，到上限停。sources = 车道副本与验证折尾段（不许有留出段）。
 * @returns {{round_id, status, attempts: {scored, parse_refused, deduped}, total}}
 */
function generate({ roundId, sources, outDir, registeredBy, coverageFloor = COVERAGE_FLOOR, panel: prebuilt = null }) {
  need(Array.isArray(sources) && sources.length, 'SOURCES_MISSING');
  for (const s of sources) need(!s.holdout, 'HOLDOUT_IN_GENERATION', s.label);
  const dir = runDir(outDir, roundId);
  need(!rounds.selectionOf(roundId), 'GENERATION_CLOSED', `${roundId}: selection recorded`);
  let r = rounds.roundHead(roundId);
  need(r, 'ROUND_NOT_FOUND', roundId);
  need(r.generator.mode === 'AI_MINED_GP', 'GENERATOR_NOT_GP', r.generator.mode);
  const f = loadFrozenSpace();
  need(r.space.sha256 === f.space.sha256, 'ROUND_SPACE_MISMATCH', r.space.sha256);
  const H = f.holdingPeriod;
  const gen = generatorOverride || generators.generatorFor(r.generator, { space: f.dslSpace, holdingPeriod: H });
  const m = segs.SEGMENTS.MINING;
  const panel = prebuilt || adapter.buildPanel({ sources, space: f.space, segment: 'MINING', from: m.from, to: m.to });
  const coverage = checkCoverage(panel, coverageFloor); // 一个尝试都没记之前
  const counts = { scored: 0, parse_refused: 0, deduped: 0 };
  const startedAt = now();
  const log = path.join(dir, 'attempts.jsonl');
  while (r.status === 'OPEN' && r.candidates_scored < r.cap) {
    const view = rounds.generatorView(roundId);
    const tried = new Set(view.tried_formulas);
    const batch = gen.nextBatch(view, { n: Math.min(gen.params ? gen.params.batch_size : 40, r.cap - r.candidates_scored) });
    need(Array.isArray(batch) && batch.length, 'GENERATOR_EMPTY_BATCH');
    for (const text of batch) {
      r = rounds.roundHead(roundId);
      if (r.status !== 'OPEN' || r.candidates_scored >= r.cap) break;
      const id = attemptId(roundId, r.candidates_scored + 1);
      let parsed = null; let refusal = null;
      try { parsed = dsl.parse(String(text), f.dslSpace); } catch (e) { if (e instanceof dsl.DslError) refusal = e.code; else throw e; }
      const base = { holding_period: H, space_sha256: r.space.sha256 };
      let rec;
      if (!parsed) {
        const raw = String(text);
        rec = { candidate_id: id, formula_canonical: raw, formula_sha256: sha256(raw), holding_period: H, mining_score: null,
          rule_config: { formula: raw, ...base, attempt: 'PARSE_REFUSED', refusal, attempt_id: id } };
        counts.parse_refused += 1;
      } else if (tried.has(parsed.canonical)) {
        rec = { candidate_id: id, formula_canonical: parsed.canonical, formula_sha256: parsed.sha256, holding_period: H, mining_score: null,
          rule_config: { formula: parsed.canonical, ...base, attempt: 'DEDUPED', attempt_id: id } };
        counts.deduped += 1;
      } else {
        const s = scoring.miningScore(parsed, panel, { holding_period: H });
        rec = { candidate_id: id, formula_canonical: parsed.canonical, formula_sha256: parsed.sha256, holding_period: H, mining_score: s.score };
        counts.scored += 1;
      }
      rounds.recordCandidate(roundId, rec, { registeredBy, registeredAt: now() });
      tried.add(rec.formula_canonical);
      const status = rec.rule_config ? rec.rule_config.attempt : 'SCORED';
      fs.appendFileSync(log, `${JSON.stringify({ candidate_id: id, text: String(text), canonical: parsed ? parsed.canonical : null, status, refusal, mining_score: rec.mining_score })}\n`);
    }
    r = rounds.roundHead(roundId);
  }
  const out = { schema: 'MINING_RUNNER_GENERATE_V1', round_id: roundId, status: r.status, cap: r.cap, total: r.candidates_scored, attempts: counts, holding_period: H,
    generator: { mode: gen.mode, seed: gen.seed, params: gen.params || null }, space: { space_ref: f.space.space_ref, sha256: f.space.sha256, freeze: f.freeze },
    mining_panel: panel.manifest, coverage, started_at: startedAt, finished_at: now() };
  writeJson(path.join(dir, 'generate.json'), out);
  return out;
}

/** 本轮算过分（SCORED）的尝试：从试验台账里读（续跑也一样）。 */
function scoredAttempts(roundId) {
  const trials = require('../../trial-ledger');
  return [...trials.heads().values()].filter((t) => t.role === 'MINED_CANDIDATE' && t.mining && t.mining.round_id === roundId && t.rule_config && !t.rule_config.attempt)
    .map((t) => ({ candidate_id: t.mining.candidate_id, formula: t.rule_config.formula, mining_score: t.metrics ? t.metrics.mining_segment_score : null }))
    .sort((a, b) => (a.candidate_id < b.candidate_id ? -1 : 1));
}

/**
 * 第 5 步：前推验证折上的选择。只写 <out>/rounds/<id>/selection.json（不进台账、不进 generatorView）；写了之后本轮不能再生成。
 */
function select({ roundId, sources, outDir }) {
  for (const s of sources) need(!s.holdout, 'HOLDOUT_IN_SELECTION', s.label);
  const r = rounds.roundHead(roundId);
  need(r && ['OPEN', 'CAP_REACHED'].includes(r.status), 'ROUND_NOT_SELECTABLE', `${roundId}:${r && r.status}`);
  if (rounds.selectionOf(roundId)) throw new rounds.MiningRoundError('MINE_ROUND_SELECTION_EXISTS', roundId);
  const dir = runDir(outDir, roundId);
  const f = loadFrozenSpace();
  const v = segs.SEGMENTS.VALIDATION;
  const panel = adapter.buildPanel({ sources, space: f.space, segment: 'VALIDATION', from: segs.SEGMENTS.MINING.from, to: v.to });
  const candidates = scoredAttempts(roundId).map((c) => {
    const st = selector.validationStats(dsl.parse(c.formula, f.dslSpace), panel, { holding_period: f.holdingPeriod });
    return { candidate_id: c.candidate_id, formula: c.formula, mining_score: c.mining_score, ...st, selected: selector.passes(st, c.mining_score) };
  });
  const out = { schema: 'MINING_VALIDATION_SELECTION_V1', round_id: roundId, rule: selector.RULE, folds: selector.folds(), holding_period: f.holdingPeriod,
    candidates, selected: candidates.filter((c) => c.selected).map((c) => c.candidate_id), validation_panel: panel.manifest, created_at: now() };
  writeJson(path.join(dir, 'selection.json'), out);
  // 台账里只追加一行：文件的 sha 与过了的候选编号（打分时只信这一行，不信输出目录里的文件）
  rounds.recordSelection(roundId, { selection_sha256: sha256(fs.readFileSync(path.join(dir, 'selection.json'))), selected: out.selected, evaluated: candidates.length,
    rule: { ...selector.RULE } });
  return out;
}

/**
 * 留出段目录的核对（开 holdout-vault 之前做完，独立复审 2026-11-17 第 1、2 条）。seal = { data_sha256, segment: { from, to } }。
 *   1 清单：SHA256SUMS 的 sha 等于封存的；或者 SHA256SUMS.sealed 等于封存的、且它的每一行都原样在现在的 SHA256SUMS 里（补导只许追加）；
 *   2 文件：目录里每个 CSV 都在清单里（MINE_RUNNER_HOLDOUT_FILE_UNLISTED）；清单里每个文件都在、sha 对得上（…_FILE_MISSING / …_FILE_SHA_MISMATCH）；
 *     7 张表都在（…_TABLE_MISSING）；
 *   3 完整：日历（SSE）到留出段终点；留出段里每个 SSE 开市日，日线、daily_basic、复权因子的 READY 行 ≥ HOLDOUT_FLOOR（…_HOLDOUT_INCOMPLETE:<表>:<日>）。
 *     导出规格 rev 3 的日历每次都是整段（到 2026-12-31），所以不能只看日历。
 * 核过才把目录交给面板；任何一条不过都在开启之前拒绝，那一次开启不被耗掉。
 */
function holdoutDirCheck(dir, seal, { minNamesPerDay = COVERAGE_FLOOR.min_names_per_day } = {}) {
  need(Number.isInteger(minNamesPerDay) && minNamesPerDay >= 1, 'COVERAGE_FLOOR_INVALID', minNamesPerDay);
  need(seal && SHA64_RE.test(seal.data_sha256 || '') && seal.segment && seal.segment.from && seal.segment.to, 'NOT_SEALED');
  need(dir && fs.existsSync(path.join(dir, 'SHA256SUMS')), 'HOLDOUT_DIR_INVALID', dir);
  const sumsBytes = fs.readFileSync(path.join(dir, 'SHA256SUMS'));
  const parse = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l); need(m, 'HOLDOUT_SHA256SUMS_LINE', l); return { line: l, sha: m[1], name: m[2] };
  });
  const listed = parse(sumsBytes.toString('utf8'));
  if (sha256(sumsBytes) !== seal.data_sha256) {
    const sealedFile = path.join(dir, 'SHA256SUMS.sealed');
    need(fs.existsSync(sealedFile) && sha256(fs.readFileSync(sealedFile)) === seal.data_sha256, 'HOLDOUT_SHA_MISMATCH', dir);
    const now1 = new Set(listed.map((x) => x.line));
    const lost = parse(fs.readFileSync(sealedFile, 'utf8')).filter((x) => !now1.has(x.line));
    need(!lost.length, 'HOLDOUT_SEALED_FILES_CHANGED', lost.map((x) => x.name).join(','));
  }
  const byName = new Map(listed.map((x) => [x.name, x.sha]));
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.csv')).sort()) need(byName.has(n), 'HOLDOUT_FILE_UNLISTED', n);
  for (const x of listed) {
    const f = path.join(dir, x.name);
    need(fs.existsSync(f), 'HOLDOUT_FILE_MISSING', x.name);
    need(sha256(fs.readFileSync(f)) === x.sha, 'HOLDOUT_FILE_SHA_MISMATCH', x.name);
  }
  for (const t of HOLDOUT_TABLES) need(byName.has(t), 'HOLDOUT_TABLE_MISSING', t);
  const src = adapter.csvDirSource(dir, { mode: 'LIVE', label: 'holdout', holdout: true });
  const cal = new Map(); let last = '';
  src.forEach('calendar', (r) => {
    const ex = Object.prototype.hasOwnProperty.call(r, 'exchange') ? r.exchange : r.market;
    if (ex !== adapter.CALENDAR_EXCHANGE || (r.quality_state !== undefined && r.quality_state !== 'READY')) return; // 只数 READY 的日历行
    const at = adapter.internals.parseTs(r.first_available_at); const rev = Number(r.revision || 0);
    const cur = cal.get(r.calendar_date);
    if (!cur || at > cur.at || (at === cur.at && rev >= cur.rev)) cal.set(r.calendar_date, { at, rev, open: r.is_open === 't' || r.is_open === 'true' });
    if (r.calendar_date > last) last = r.calendar_date;
  });
  need(last >= seal.segment.to, 'HOLDOUT_INCOMPLETE', `trading_calendar.csv:${seal.segment.to}`);
  const days = [...cal.entries()].filter(([d, v]) => v.open && d >= seal.segment.from && d <= seal.segment.to).map(([d]) => d).sort();
  need(days.length, 'HOLDOUT_INCOMPLETE', 'trading_calendar.csv:no open day');
  const rowsPerDay = {};
  for (const [table, file] of [['prices', 'prices_daily_stock.csv'], ['basic', 'market_daily_basic_observation_stock.csv'], ['adj', 'adjustment_factor_observation_stock.csv']]) {
    const names = new Map();
    src.forEach(table, (r) => {
      if (r.quality_state !== 'READY' || !(r.trade_date >= seal.segment.from && r.trade_date <= seal.segment.to)) return;
      if (!names.has(r.trade_date)) names.set(r.trade_date, new Set());
      names.get(r.trade_date).add(r.security_id);
    });
    const per = days.map((d) => (names.get(d) ? names.get(d).size : 0));
    const median = [...per].sort((a, b) => a - b)[Math.floor(per.length / 2)];
    days.forEach((d, k) => {
      need(per[k] >= minNamesPerDay && per[k] >= HOLDOUT_FLOOR.min_share_of_median_day * median, 'HOLDOUT_INCOMPLETE', `${file}:${d}:${per[k]}`);
    });
    rowsPerDay[file] = { min_names: Math.min(...per), median_names: median };
  }
  return { calendar_to: last, open_days: days.length, rows_per_day: rowsPerDay, floor: { min_names_per_day: minNamesPerDay, ...HOLDOUT_FLOOR }, source: src };
}

/** 对着本轮的封存记录核留出段目录。 */
function verifyHoldoutDir(roundId, dir, opts = {}) {
  const seal = vault.sealOf(roundId);
  need(seal, 'NOT_SEALED', roundId);
  return { ...holdoutDirCheck(dir, seal, opts), seal_hash: seal.record_hash, data_sha256: seal.data_sha256 };
}
/** 覆盖下限的记录（写进台账：开轮写进轮次清单，打分写进开启记录）：用了几、默认几、是不是压低了。 */
const floorRecord = (floor) => ({ min_names_per_day: { value: floor.min_names_per_day, default: COVERAGE_FLOOR.min_names_per_day, overridden: floor.min_names_per_day !== COVERAGE_FLOOR.min_names_per_day } });

/**
 * 第 6–8 步：核留出段目录 → holdout-vault.open（每轮一次）→ 只经 holdout-scoring 打分 → 每个候选 recordGateResult。
 * 没有候选过验证折：不开留出段，返回 { opened: false }（关轮记 0）。
 */
function scoreHoldout({ roundId, sources, holdoutDir, outDir, scoredAt = null, coverageFloor = COVERAGE_FLOOR }) {
  for (const s of sources) need(!s.holdout, 'HOLDOUT_PASSED_AS_SOURCE', s.label);
  const dir = runDir(outDir, roundId);
  // 选择只信台账里那一行（复审第 3 条）：输出目录里的 selection.json 要对得上它的 sha；候选编号取这一行，公式取试验台账行
  const selRow = rounds.selectionOf(roundId);
  need(selRow, 'SELECTION_MISSING', roundId);
  const selFile = path.join(dir, 'selection.json');
  need(fs.existsSync(selFile) && sha256(fs.readFileSync(selFile)) === selRow.selection_sha256, 'SELECTION_FILE_MISMATCH', roundId);
  const formulas = new Map(scoredAttempts(roundId).map((c) => [c.candidate_id, c.formula]));
  for (const id of selRow.selected) need(formulas.has(id), 'SELECTION_CANDIDATE_UNKNOWN', id);
  if (!selRow.selected.length) { writeJson(path.join(dir, 'score.json'), { schema: 'MINING_RUNNER_SCORE_V1', round_id: roundId, opened: false, records: [] }); return { opened: false, records: [] }; }
  const checked = verifyHoldoutDir(roundId, holdoutDir, { minNamesPerDay: coverageFloor.min_names_per_day });
  const opened = vault.open({ round_id: roundId, candidate_ids: [...selRow.selected], openedBy: RUNNER_ID,
    checks: { ...floorRecord(coverageFloor), holdout_dir: { open_days: checked.open_days, calendar_to: checked.calendar_to, rows_per_day: checked.rows_per_day } } });
  const f = loadFrozenSpace();
  const panel = adapter.buildPanel({ sources: [...sources, checked.source], space: f.space, segment: 'HOLDOUT', from: segs.SEGMENTS.MINING.from, to: segs.SEGMENTS.HOLDOUT.to });
  const stamp = scoredAt || new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');
  const results = holdoutScoring.roundResults(opened.candidate_ids.map((id) => ({ candidate_id: id, formula: formulas.get(id), parsed: dsl.parse(formulas.get(id), f.dslSpace) })),
    panel, { holding_period: f.holdingPeriod, market: MARKET, familyTrialCount: rounds.familyN(MARKET, f.holdingPeriod), scoredAt: stamp });
  const records = results.map((res) => gateRecords.recordGateResult({ round_id: roundId, candidate_id: res.candidate_id, candidate: res }));
  writeJson(path.join(dir, 'score.json'), { schema: 'MINING_RUNNER_SCORE_V1', round_id: roundId, opened: true, selection_record_hash: selRow.record_hash,
    holdout: { seal_hash: checked.seal_hash, data_sha256: checked.data_sha256, calendar_to: checked.calendar_to, open_days: checked.open_days, rows_per_day: checked.rows_per_day }, holdout_panel: panel.manifest, results, records: records.map((x) => ({ candidate_id: x.candidate_id, pass: x.pass, codes: x.codes, record_hash: x.record_hash })) });
  return { opened: true, records };
}

/** 第 9 步：关轮（过了几个由记录数出来）。 */
const close = ({ roundId, closedAt = null }) => rounds.closeRound(roundId, { closedAt });

/** 只给测试用：临时换冻结输入的期望 sha（核对不上必须拒绝），回调结束还原。 */
function withFrozenInputs(patch, cb) { const prior = frozenInputs; frozenInputs = { ...frozenInputs, ...patch }; try { return cb(); } finally { frozenInputs = prior; } }

/** 只给测试用：临时换生成方（合成的尝试序列），回调结束还原。 */
function withGenerator(gen, cb) { const prior = generatorOverride; generatorOverride = gen; try { return cb(); } finally { generatorOverride = prior; } }

module.exports = {
  MARKET, RUNNER_ID, FROZEN_INPUTS, COVERAGE_FLOOR, HOLDOUT_FLOOR, HOLDOUT_TABLES, RunnerError, start, loadFrozenSpace, checkCoverage, requestRound, sealHoldout, generate, select,
  holdoutDirCheck, verifyHoldoutDir, scoreHoldout, close, scoredAttempts,
  internals: { withGenerator, withFrozenInputs, attemptId },
};
