'use strict';

/**
 * 挖掘轮次执行器（RF1116 P2 规格 §1；MINING_ROUNDS_V1「P2 requirements」；★R (a)：一轮只用一种生成方式，现在只有 GP）。
 * 只在研究车道的 rootless 容器里跑（deploy/research-lane/round-runner/）：启动即 lockdown，只许写一个输出目录；台账（QRP_DATA_DIR）必须在输出目录里。
 * 九步都走 QRP 正门（services/mining-rounds、services/holdout-vault、services/mining-rounds/gate-records），执行器不直接写台账文件：
 *
 *   1 开轮      requestRound：冻结的空间（docs/freeze 的 JSON + 冻结页，sha 对上）、持有期、GP 种子（大模型：模型与上限取配置 config/mining_llm_generator.v1.json，sha 写进清单）、上限 ≤ 200、冻结的留出段起止
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
const llmMod = require('../llm');
const segs = require('../segments');
const { lockdown } = require('../isolation');
const selector = require('./selector');
const holdoutScoring = require('./holdout-scoring');
const { LEGACY_LINEAR_RAW_V1_ROUNDS, neutralizationOf } = require('../../mining-rounds/neutralization');

const REPO = path.join(__dirname, '..', '..', '..');
const MARKET = 'CN_A';
const RUNNER_ID = 'RF1116_ROUND_RUNNER';
/** 冻结的输入（仓库里的副本，车道上不读协调目录）。 */
const FROZEN_INPUTS = Object.freeze({
  space: Object.freeze({ path: 'docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json', sha256: '0d3556fa97f17d3a67b350e7f74c12fb521ca1fb60c293121601f7eb95f96637' }),
  space_freeze: Object.freeze({ path: 'docs/freeze/MINING_SPACE_V1_CN_A_R1_FREEZE_1.md', sha256: '4ec642b9ae87e7cd69b1bd226cc8964647dcace26a1dec60c0124df23fd8af69' }),
  holdout_freeze: segs.FREEZE_PAGE,
  // 协调会话裁定 R1（2026-11-17）：每份清单的 rulings 引它；协调目录的路径写进清单，车道上核仓库副本
  ruling_r1: Object.freeze({ path: 'docs/freeze/RF1116_RULING_R1_20261117.md', sha256: 'f904e0feb3dc8e96a6e5b80e0ecc790f3cdca309b47fb88972c803f50a689d44',
    coordinator_path: 'artifacts/coordinator/RF1116_RULING_R1_20261117.md' }),
});

/**
 * 挖掘段的覆盖下限（独立复审 2026-11-17 第 4 条）：开轮之前、记任何尝试之前，挖掘段每个决策日（第一天除外，它没有前一日的行）在股票池里、
 * 后复权收盘价有数的名字至少这么多；不够就拒绝（MINE_RUNNER_COVERAGE_BELOW_FLOOR），免得空的股票池往 N 里写 200 个没有分数的尝试。
 * 2,000：2020-06 沪深主板 + 创业板 + 科创板约 3,800 只，扣掉 ST、上市不满 120 日、停牌后仍在 3,000 以上；取一个留足余量、又挡得住缺一大块数据的数。
 */
const COVERAGE_FLOOR = Object.freeze({ min_names_per_day: 2000 });
/**
 * 留出段目录的完整性下限（复审第 1 条；再审 G5、G5c）：留出段里每个 SSE 开市日，日线、daily_basic、复权因子三张表各自按 READY 行里
 * **不同的 security_id**（行里有修订，不按行数；北交所 .BJ 不算，面板里也没有它们）：
 *   - 绝对下限：≥ min_names_per_day（4,000：导出规格 rev 3 §3 的每日最少行数；测试可以压低，压低的数写进开启记录）；
 *   - 相对下限：≥ 封存那一份里各开市日名字数中位数的一半（「封存那一份」= SHA256SUMS.sealed 列的文件，封存之后挪不动）。
 *     锚在留出段自己的中位数上会被薄的补导一起拉低（G5c：补导每天 15 只里 6 只，过绝对下限、也过「自己中位数的一半」）。
 * 挖掘段面板的股票池下限（COVERAGE_FLOOR，2,000）是另一回事：那是池里的名字，2020 年全市场才三千多只，不能用 4,000。
 */
const HOLDOUT_FLOOR = Object.freeze({ min_names_per_day: 4000, min_share_of_sealed_median: 0.5, basis: 'DISTINCT_SECURITY_ID_READY_EXCL_BJ', anchor: 'SEALED_DAYS_MEDIAN' });
/**
 * daily_basic 逐字段的取值状态下限（独立复审第二轮 2026-11-18，协调会话：打分之前必须合并）：只数行不够，V6 有整天某个字段全是 MISSING 的日子
 * （-r4 尾段 2026-09-29、10-08、10-09 的 turnover_rate_f 与 dv_ttm）。对每个 daily_basic 读数（适配器的 BASIC_FIELDS）：同一 (日期, 证券) 取入库最晚、
 * 同刻修订号大的那一行，按适配器的 { state, value } 读法（stateValue）可用的名字数，每天 ≥ 封存那一份各日中位数的 min_share_of_sealed_median；
 * 封存那一份里一天都没有可用值 → HOLDOUT_FIELD_EMPTY；total_mv（市值中性化）另要 ≥ 每天的名字数下限。
 */
const HOLDOUT_FIELD_FLOOR = Object.freeze({ file: 'market_daily_basic_observation_stock.csv', min_share_of_sealed_median: 0.9, absolute_floor_fields: Object.freeze(['total_mv']),
  basis: 'LATEST_ON_TIME_REVISION_READY_EXCL_BJ_STATE_ONLY', anchor: 'SEALED_DAYS_MEDIAN', trade_dates: 'FEEDING_DECISION_DAYS',
  share_ruling: 'RF1116_FIELD_FLOOR_SHARE=0.9 (coordinator 2026-11-18, DEFAULT_A)' });
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
  need(process.env.QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION === undefined, 'TEST_SEAM_SET', 'QRP_TEST_ALLOW_LEGACY_NEUTRALIZATION must not be set when the runner starts'); // 测试的口子（旧版本的轮）不许带进执行器
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
  read1(frozenInputs.ruling_r1);
  need(space.holding_periods.length === 1, 'HOLDING_PERIODS_UNSUPPORTED', space.holding_periods.join(','));
  return { space, dslSpace: spaceMod.dslSpaceOf(space), freeze, holdingPeriod: space.holding_periods[0] };
}

const runDir = (outDir, roundId) => { const d = path.join(outDir, 'rounds', roundId.replace(/[^A-Za-z0-9_-]/g, '_')); fs.mkdirSync(d, { recursive: true }); return d; };
const writeJson = (file, o) => fs.writeFileSync(file, `${JSON.stringify(o, null, 2)}\n`);

/** 大模型配置（可被测试覆盖：开轮之后配置变了的反例）。 */
let llmConfigBytes = null;
const loadLlmConfig = () => llmMod.loadConfig(llmConfigBytes ? { bytes: llmConfigBytes } : {});
const llmBlock = ({ config: c, sha256: h, path: p }) => ({ config_path: p, config_sha256: h, provider: c.model.provider, served_version: c.model.served_version, release_date: c.model.release_date,
  tokens_per_round: c.limits.tokens_per_round, calls_per_round: c.limits.calls_per_round, formulas_per_call: c.batch.formulas_per_call, max_tokens: c.request.max_tokens });
/** 登记表里配置点名的机制（只读 mechanisms[]，不读 entries[] 的封存结论）。 */
const llmMechanisms = (config) => llmMod.mechanismsFor(JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'research_mechanism_register.v1.json'), 'utf8')), config.prompt.mechanisms);

/** 第 1 步：开轮。大模型轮的模型、知识截止日（= 发布日）和上限只来自配置；调用方给了别的 → MINE_RUNNER_LLM_MODEL_NOT_PINNED。 */
function requestRound({ generator, cap = rounds.LIMITS.candidates_per_round, openedAt = null, coverageFloor = COVERAGE_FLOOR } = {}) {
  generators.assertGeneratorEnabled(generator);
  const isLlm = generator.mode === 'AI_MINED_LLM';
  let L = null;
  if (isLlm) {
    L = loadLlmConfig();
    need(generator.model === undefined || generator.model === L.config.model.api_model, 'LLM_MODEL_NOT_PINNED', `model:${generator.model}`);
    need(generator.model_knowledge_cutoff === undefined || generator.model_knowledge_cutoff === L.config.model.cutoff_used, 'LLM_MODEL_NOT_PINNED', `cutoff:${generator.model_knowledge_cutoff}`);
  } else need(Number.isInteger(generator.gp_seed), 'GP_SEED_REQUIRED');
  const f = loadFrozenSpace();
  return rounds.openRound({
    market: MARKET, space: { space_ref: f.space.space_ref, sha256: f.space.sha256, freeze: f.freeze }, holding_periods: [...f.space.holding_periods],
    generator: isLlm ? { mode: 'AI_MINED_LLM', model: L.config.model.api_model, model_knowledge_cutoff: L.config.model.cutoff_used, llm: llmBlock(L) } : { mode: 'AI_MINED_GP', gp_seed: generator.gp_seed },
    holdout: { from: segs.SEGMENTS.HOLDOUT.from, to: segs.SEGMENTS.HOLDOUT.to }, cap, openedAt: openedAt || undefined,
    data_checks: { coverage_floor: { min_names_per_day: coverageFloor.min_names_per_day, default: COVERAGE_FLOOR.min_names_per_day,
      overridden: coverageFloor.min_names_per_day !== COVERAGE_FLOOR.min_names_per_day } },
    // R1.2：引裁定页；验证折选择规则作为数据冻结进清单（轮中不改）
    rulings: [{ path: frozenInputs.ruling_r1.coordinator_path, sha256: frozenInputs.ruling_r1.sha256 }],
    selection_rule: JSON.parse(JSON.stringify(selector.RULE)),
  });
}

/** 续跑的生成方式要和轮次清单一致（GP 轮不能用大模型续，反过来也一样）。 */
function assertResumeGenerator({ roundId, mode }) {
  const h = rounds.roundHead(roundId);
  need(h, 'ROUND_NOT_FOUND', roundId);
  need(h.generator.mode === mode, 'GENERATOR_MISMATCH', `${roundId}: round is ${h.generator.mode}, asked ${mode}`);
  return h;
}

/**
 * 大模型：开新轮（或续跑）之前先探活：一条不含公式的请求经交换目录交给网络那一步；不开轮、不写台账、不计 N。
 * @returns {{outcome: string, ...}} OK，或 WAITING_*（网络那一步没答、密钥不在、额度 / 限流、版本对不上……）
 */
function probeLlm({ outDir, pollMs = null, waitSeconds = null } = {}) {
  const { config } = loadLlmConfig();
  const dir = llmMod.ensureExchangeDir(path.join(outDir, 'llm-exchange'));
  const every = pollMs || config.exchange.poll_ms;
  const key = `PING-${now().replace(/[^0-9A-Za-z]/g, '')}-${process.pid}`;
  llmMod.writeRequest(dir, { kind: 'PING', key, round_id: null, body: llmMod.pingRequest(config) });
  const res = llmMod.waitResponse(dir, key, { pollMs: every, waitPolls: Math.ceil((waitSeconds === null ? 120 : waitSeconds) * 1000 / every) });
  if (!res) return { outcome: 'WAITING_STEP_NO_RESPONSE', key };
  if (res.outcome !== 'OK') return { outcome: res.outcome, reason: res.reason || null, http_status: res.http_status === undefined ? null : res.http_status, raw_error: res.raw_error || null };
  const m = llmMod.checkResponseModel(res.model, config);
  if (!m.ok) return { outcome: m.outcome, model_reported: m.model_reported };
  return { outcome: 'OK', model_reported: m.model_reported, served_version: m.served_version, usage: res.usage || null, key };
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
 * 金丝雀（2026-11-18 第 1 轮 MR-CN_A-2026-11-e1ab63a27b 缺陷之后）：开轮之前，固定公式在挖掘段面板上必须算得出分。
 * 第 1 轮的行业成员一行都没进面板，打分前的中性化把每个值都变成 NaN，200 个候选的有效 IC 日都是 0，分数是 null 却记成了 SCORED。
 * 要求（独立复审 M-1 收紧，REVIEW.md 12a23861）：打分日 = 1 ≤ t ≤ 日数 − H − 1（第一天不算，最后 H 天没有前推收益）。
 *   - 逐个打分日：池里、金丝雀中性化后（scoring.neutralizedValues，候选同一条路径）有限值的名字数 ≥ 覆盖下限 floor.min_names_per_day，
 *     且 ≥ min_coverage_share × 当天的覆盖数（池里且后复权收盘价有数，同 checkCoverage）。有一天不够就拒（行业只剩一部分名字、只缺一段日子都在这里拒）；
 *   - 分数是有限数，且有效 IC 日 ≥ max(MIN_IC_DAYS, ⌈min_day_share × 打分日数⌉)。
 * 不过 → MINE_RUNNER_CANARY_UNSCORABLE，不开轮、不封存、不记尝试。返回 { formulas: [{ formula, score, ic_days, min_named, min_named_date, min_share, min_share_date }],
 *   scored_days, min_ic_days, min_names_per_day, min_coverage_share, min_day_share, holding_period }（写进 generate.json）。
 */
const CANARY = Object.freeze({ formulas: Object.freeze(['(-close_hfq)']), min_coverage_share: 0.9, min_day_share: 0.95 });
function checkCanary(panel, floor = COVERAGE_FLOOR, canary = CANARY, { neutralization } = {}) {
  need(panel && panel.segment === 'MINING' && Array.isArray(panel.dates) && panel.dates.length && panel.readings && panel.readings.close_hfq, 'CANARY_PANEL_INVALID');
  need(floor && Number.isInteger(floor.min_names_per_day) && floor.min_names_per_day >= 1, 'COVERAGE_FLOOR_INVALID', floor && floor.min_names_per_day);
  const f = loadFrozenSpace();
  const H = f.holdingPeriod;
  const T = panel.dates.length; const N = panel.codes.length;
  const scoredDays = T - H - 1;
  need(scoredDays > 0, 'CANARY_PANEL_INVALID', `no scored day:${T}`);
  const minDays = Math.max(scoring.MIN_IC_DAYS, Math.ceil(canary.min_day_share * scoredDays));
  const formulas = canary.formulas.map((text) => {
    const parsed = dsl.parse(text, f.dslSpace);
    const neu = scoring.neutralizedValues(parsed, panel, { neutralization }).values;
    let minNamed = Infinity; let minNamedDate = null; let minShare = Infinity; let minShareDate = null;
    for (let t = 1; t <= scoredDays; t += 1) {
      let cov = 0; let named = 0;
      for (let j = 0; j < N; j += 1) {
        if (!panel.universe[t][j]) continue;
        if (Number.isFinite(panel.readings.close_hfq[t][j])) cov += 1;
        if (Number.isFinite(neu[t][j])) named += 1;
      }
      const share = cov ? named / cov : 0;
      if (named < minNamed) { minNamed = named; minNamedDate = panel.dates[t]; }
      if (share < minShare) { minShare = share; minShareDate = panel.dates[t]; }
      need(named >= floor.min_names_per_day && named >= canary.min_coverage_share * cov, 'CANARY_UNSCORABLE',
        `${text}:${panel.dates[t]}:neutralized=${named}<max(${floor.min_names_per_day},${canary.min_coverage_share}x${cov})`);
    }
    const s = scoring.miningScore(parsed, panel, { holding_period: H, neutralization });
    need(Number.isFinite(s.score) && s.ic_days >= minDays, 'CANARY_UNSCORABLE', `${text}:ic_days=${s.ic_days}<${minDays}`);
    return { formula: text, score: s.score, ic_days: s.ic_days, min_named: minNamed, min_named_date: minNamedDate, min_share: minShare, min_share_date: minShareDate };
  });
  return { formulas, scored_days: scoredDays, min_ic_days: minDays, min_names_per_day: floor.min_names_per_day, min_coverage_share: canary.min_coverage_share,
    min_day_share: canary.min_day_share, holding_period: H };
}

/**
 * 第 3–4 步：生成 + 挖掘段打分 + 每个尝试一行试验台账，到上限停。sources = 车道副本与验证折尾段（不许有留出段）。
 * 分数不是有限数的尝试记 UNSCORABLE（计入 N，不进选择，GP 不当它有分），永远不记 SCORED（第 1 轮缺陷）。
 * @returns {{round_id, status, attempts: {scored, unscorable, parse_refused, deduped}, total, canary}}
 */
function generate({ roundId, sources, outDir, registeredBy, coverageFloor = COVERAGE_FLOOR, panel: prebuilt = null, llm: llmOpts = {} }) {
  need(Array.isArray(sources) && sources.length, 'SOURCES_MISSING');
  for (const s of sources) need(!s.holdout, 'HOLDOUT_IN_GENERATION', s.label);
  const dir = runDir(outDir, roundId);
  need(!rounds.selectionOf(roundId), 'GENERATION_CLOSED', `${roundId}: selection recorded`);
  let r = rounds.roundHead(roundId);
  need(r, 'ROUND_NOT_FOUND', roundId);
  const isLlm = r.generator.mode === 'AI_MINED_LLM';
  need(isLlm || r.generator.mode === 'AI_MINED_GP', 'GENERATOR_UNSUPPORTED', r.generator.mode);
  // 大模型轮：配置在开轮之后变了（换了版本、改了上限）→ 失败即关，不是等待
  const L = isLlm ? loadLlmConfig() : null;
  if (isLlm) need(r.generator.llm && r.generator.llm.config_sha256 === L.sha256, 'LLM_CONFIG_CHANGED', `${roundId}: manifest ${r.generator.llm && r.generator.llm.config_sha256} vs ${L.sha256}`);
  const f = loadFrozenSpace();
  need(r.space.sha256 === f.space.sha256, 'ROUND_SPACE_MISMATCH', r.space.sha256);
  const H = f.holdingPeriod;
  const gen = isLlm ? generators.generatorFor(r.generator, { space: f.dslSpace, holdingPeriod: H, llm: { config: L.config, mechanisms: llmMechanisms(L.config) } })
    : (generatorOverride || generators.generatorFor(r.generator, { space: f.dslSpace, holdingPeriod: H }));
  const m = segs.SEGMENTS.MINING;
  const panel = prebuilt || adapter.buildPanel({ sources, space: f.space, segment: 'MINING', from: m.from, to: m.to });
  const coverage = checkCoverage(panel, coverageFloor); // 一个尝试都没记之前
  const neutralization = neutralizationOf(r); // 版本跟着轮走（修订 SIZE_V2 N2），不设默认
  const canary = checkCanary(panel, coverageFloor, CANARY, { neutralization }); // 复审 M-3：自己跑，不信调用方给的
  const counts = { scored: 0, unscorable: 0, parse_refused: 0, deduped: 0 };
  const startedAt = now();
  const log = path.join(dir, 'attempts.jsonl');
  let halt = null;
  while (r.status === 'OPEN' && r.candidates_scored < r.cap) {
    const view = rounds.generatorView(roundId);
    const tried = new Set(view.tried_formulas);
    let batch;
    if (isLlm) {
      // 一次调用：写请求 → 等网络那一步答 → 计量；等待 / 停止态在这里停下（本轮留在 OPEN，续跑从下一个尝试接着来）
      const call = llmCall({ roundId, view, want: Math.min(L.config.batch.formulas_per_call, r.cap - r.candidates_scored), cfg: L, gen, outDir, opts: llmOpts });
      if (call.halt) { halt = call; break; }
      batch = call.formulas; // 可以是空的：下一圈再调，调用次数上限与 token 上限保证会停
    } else {
      batch = gen.nextBatch(view, { n: Math.min(gen.params ? gen.params.batch_size : 40, r.cap - r.candidates_scored) });
      need(Array.isArray(batch) && batch.length, 'GENERATOR_EMPTY_BATCH');
    }
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
        const s = scoring.miningScore(parsed, panel, { holding_period: H, neutralization });
        if (Number.isFinite(s.score)) {
          rec = { candidate_id: id, formula_canonical: parsed.canonical, formula_sha256: parsed.sha256, holding_period: H, mining_score: s.score };
          counts.scored += 1;
        } else {
          rec = { candidate_id: id, formula_canonical: parsed.canonical, formula_sha256: parsed.sha256, holding_period: H, mining_score: null,
            rule_config: { formula: parsed.canonical, ...base, attempt: 'UNSCORABLE', ic_days: s.ic_days, attempt_id: id } };
          counts.unscorable += 1;
        }
      }
      rounds.recordCandidate(roundId, rec, { registeredBy, registeredAt: now() });
      tried.add(rec.formula_canonical);
      const status = rec.rule_config ? rec.rule_config.attempt : 'SCORED';
      fs.appendFileSync(log, `${JSON.stringify({ candidate_id: id, text: String(text), canonical: parsed ? parsed.canonical : null, status, refusal, mining_score: rec.mining_score })}\n`);
    }
    r = rounds.roundHead(roundId);
  }
  const out = { schema: 'MINING_RUNNER_GENERATE_V1', round_id: roundId, status: r.status, cap: r.cap, total: r.candidates_scored, attempts: counts, holding_period: H,
    generator: isLlm ? { mode: gen.mode, model: L.config.model.api_model, config_sha256: L.sha256, params: gen.params } : { mode: gen.mode, seed: gen.seed, params: gen.params || null },
    space: { space_ref: f.space.space_ref, sha256: f.space.sha256, freeze: f.freeze },
    mining_panel: panel.manifest, coverage, canary, started_at: startedAt, finished_at: now() };
  if (isLlm) {
    const u = rounds.llmUsage(roundId);
    out.llm = { state: halt ? halt.state : null, halted: Boolean(halt), calls: u.calls, tokens_metered: u.tokens_metered, tokens_per_round: L.config.limits.tokens_per_round, calls_per_round: L.config.limits.calls_per_round,
      last_outcome: u.last_outcome, config_sha256: L.sha256, pending_key: halt && halt.key ? halt.key : null,
      // 预算 / 能力用尽（token 上限、调用次数上限、连续空应答）= 本轮生成到此为止，带着已有的尝试往下走；别的停与等待要有人看
      generation_closed: Boolean(halt && halt.closed) };
  }
  writeJson(path.join(dir, 'generate.json'), out);
  return out;
}

/** token 数：接口报的 total_tokens，没有就 prompt + completion；都没有 → null。 */
const usageTokens = (u) => (u && Number.isFinite(u.total_tokens) ? u.total_tokens : (u && Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens) ? u.prompt_tokens + u.completion_tokens : null));

/**
 * 大模型的一次调用（第 3 步里生成一批）。上限在代码里强制（不信模型）：调用次数、发之前「已用 + 这次的上界」不得超过本轮 token 上限。
 * 每次调用（含等待、停止）写一行 MINING_LLM_CALL_V1；网络那一步没答 → 不写行，请求留在交换目录，续跑会再等同一个请求（键里带请求的 sha）。
 * @returns {{halt: false, formulas: string[]} | {halt: true, state: string, key?: string}}
 */
function llmCall({ roundId, view, want, cfg, gen, outDir, opts }) {
  const { config } = cfg;
  const dir = llmMod.ensureExchangeDir(path.join(outDir, 'llm-exchange'));
  const prior = rounds.llmCalls(roundId);
  const seq = prior.length + 1;
  const used = rounds.llmUsage(roundId);
  const plain = `${roundId}:C${String(seq).padStart(3, '0')}`;
  const blank = { seq, key: plain, final: false, sent: false, http_status: null, n_requested: want, formulas_returned: 0, lines_dropped: 0, lines_overflow: 0, usage: null, tokens_metered: 0, tokens_basis: 'NONE',
    model_requested: config.model.api_model, model_reported: null, served_version: null, finish_reason: null, system_fingerprint: null, request_sha256: null, response_sha256: null, prompt_sha256: null,
    config_sha256: cfg.sha256, raw_error: null, reason: null };
  const record = (row) => rounds.recordLlmCall(roundId, { ...blank, ...row }, { recordedAt: now() });
  if (used.calls >= config.limits.calls_per_round) {
    record({ outcome: 'STOPPED_CALL_CAP', reason: `calls ${used.calls} >= ${config.limits.calls_per_round}` });
    return { halt: true, state: 'STOPPED_CALL_CAP', closed: true };
  }
  // 连续空应答（常见于 finish_reason: length）不写尝试，会白花到调用次数上限：到数就停
  let trailing = 0;
  for (let i = prior.length - 1; i >= 0 && prior[i].outcome === 'OK' && prior[i].formulas_returned === 0; i -= 1) trailing += 1;
  if (trailing >= config.limits.empty_replies_stop) {
    record({ outcome: 'STOPPED_EMPTY_REPLIES', reason: `${trailing} consecutive replies without a formula` });
    return { halt: true, state: 'STOPPED_EMPTY_REPLIES', closed: true };
  }
  const prep = gen.prepare(view, { n: want });
  const key = `${plain}-${prep.request_sha256.slice(0, 8)}`;
  if (used.tokens_metered + prep.tokens_upper_bound > config.limits.tokens_per_round) {
    record({ key, outcome: 'STOPPED_TOKEN_CAP', request_sha256: prep.request_sha256, prompt_sha256: prep.prompt_sha256, reason: `used ${used.tokens_metered} + bound ${prep.tokens_upper_bound} > ${config.limits.tokens_per_round}` });
    return { halt: true, state: 'STOPPED_TOKEN_CAP', closed: true };
  }
  // 提示词变了（别的轮加了已试公式）之后，本轮没人答的旧请求要撤回，免得后起的网络那一步悄悄答掉：花了钱没有记账
  // 同一个请求（同序号、同提示词）在 llm-init 里被撤回过：换一个键重新发，不拿「已撤回」当答案
  let useKey = key;
  for (let n = 1; ; n += 1) {
    const prev = llmMod.readResponse(dir, useKey);
    if (prev && prev.outcome === 'WITHDRAWN_BY_RUNNER') useKey = `${key}-w${n}`; else break;
  }
  llmMod.withdrawUnanswered(dir, { roundId, keepKey: useKey, now });
  llmMod.writeRequest(dir, { kind: 'GENERATE', key: useKey, round_id: roundId, body: prep.body });
  const every = opts.pollMs || config.exchange.poll_ms;
  const res = llmMod.waitResponse(dir, useKey, { pollMs: every, waitPolls: opts.waitPolls || config.exchange.wait_polls });
  if (!res) return { halt: true, state: 'WAITING_STEP_NO_RESPONSE', key: useKey };
  const base = { key: useKey, final: true, sent: Boolean(res.sent), http_status: res.http_status === undefined ? null : res.http_status, request_sha256: res.request_sha256 || prep.request_sha256,
    response_sha256: res.response_sha256 || null, prompt_sha256: prep.prompt_sha256, raw_error: res.raw_error || null, reason: res.reason || null, model_reported: res.model || null,
    finish_reason: res.finish_reason || null, system_fingerprint: res.system_fingerprint || null, usage: res.usage || null };
  if (res.outcome === 'OK') {
    const reported = usageTokens(res.usage);
    const meter = { tokens_metered: reported === null ? prep.tokens_upper_bound : reported, tokens_basis: reported === null ? 'UPPER_BOUND' : 'USAGE' };
    const it = gen.interpret(res, want);
    if (!it.ok) { // 模型名对不上：这批公式不用，等待
      record({ ...base, ...meter, outcome: it.outcome, model_reported: it.model_reported, reason: `served model ${it.model_reported} is not the pinned ${config.model.served_version}` });
      return { halt: true, state: it.outcome };
    }
    if (reported === null) { // 计量不明就失败即关：按上界计量，这批公式不用，本轮等待（plan-coord 2026-11-22）
      record({ ...base, ...meter, outcome: 'WAITING_METER_UNKNOWN', reason: 'the reply carries no usage block: the cost cannot be metered, so the round waits and its formulas are not used' });
      return { halt: true, state: 'WAITING_METER_UNKNOWN' };
    }
    record({ ...base, ...meter, outcome: 'OK', model_reported: it.model_reported, served_version: it.served_version, formulas_returned: it.formulas.length, lines_dropped: it.lines_dropped, lines_overflow: it.lines_overflow });
    return { halt: false, formulas: it.formulas };
  }
  // 等待 / 停止：原始错误照留
  // 超时、连接重置、读不懂的 200：请求已经发出，是否计费不知道，同样按上界计量。402 / 429 / 401 / 400 是接口明确拒绝，不计
  const unknownCost = res.sent && (res.outcome === 'WAITING_STEP_CRASHED_MID_CALL' || res.outcome === 'WAITING_PROVIDER_UNAVAILABLE');
  record({ ...base, outcome: res.outcome, tokens_metered: unknownCost ? prep.tokens_upper_bound : 0, tokens_basis: unknownCost ? 'UPPER_BOUND' : 'NONE' });
  return { halt: true, state: res.outcome };
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
  // R1.2：规则读本轮清单（不读常量）
  const rule = r.selection_rule;
  const neutralization = neutralizationOf(r); // 修订 SIZE_V2 N2
  need(rule && rule.schema === 'VALIDATION_SELECTION_V1', 'SELECTION_RULE_MISSING', roundId);
  const panel = adapter.buildPanel({ sources, space: f.space, segment: 'VALIDATION', from: segs.SEGMENTS.MINING.from, to: v.to });
  const valDays = panel.dates.map((d, t) => (d >= v.from ? t : -1)).filter((t) => t >= 0);
  const candidates = scoredAttempts(roundId).map((c) => {
    const { values, ...st } = selector.validationStats(dsl.parse(c.formula, f.dslSpace), panel, { holding_period: f.holdingPeriod, rule, neutralization });
    // R1.3：验证折上的只做多月度配对差（DSR 的样本段），与留出段同一套持仓与成本（含涨跌停）
    const book = holdoutScoring.longOnly(values, panel, f.holdingPeriod, valDays);
    const sr = require('../../trial-ledger/overfit').moments(book.monthly_d).sr;
    return { candidate_id: c.candidate_id, formula: c.formula, mining_score: c.mining_score, ...st, selected: selector.passes(st, c.mining_score, rule),
      validation_book: { months: book.monthly_d.length, monthly_d: book.monthly_d, month_keys: book.months, sr: typeof sr === 'number' && Number.isFinite(sr) ? sr : null, limit_events: book.events } };
  });
  const out = { schema: 'MINING_VALIDATION_SELECTION_V1', round_id: roundId, rule, folds: selector.folds(rule), holding_period: f.holdingPeriod,
    candidates, selected: candidates.filter((c) => c.selected).map((c) => c.candidate_id), validation_panel: panel.manifest, created_at: now() };
  writeJson(path.join(dir, 'selection.json'), out);
  // 台账里只追加一行：文件的 sha 与过了的候选编号（打分时只信这一行，不信输出目录里的文件）
  rounds.recordSelection(roundId, { selection_sha256: sha256(fs.readFileSync(path.join(dir, 'selection.json'))), selected: out.selected, evaluated: candidates.length,
    rule: JSON.parse(JSON.stringify(rule)) });
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
function holdoutDirCheck(dir, seal, { minNamesPerDay = HOLDOUT_FLOOR.min_names_per_day, priorSources = [], fieldExclusions = null } = {}) {
  need(Number.isInteger(minNamesPerDay) && minNamesPerDay >= 1, 'HOLDOUT_FLOOR_INVALID', minNamesPerDay);
  need(seal && SHA64_RE.test(seal.data_sha256 || '') && seal.segment && seal.segment.from && seal.segment.to, 'NOT_SEALED');
  need(dir && fs.existsSync(path.join(dir, 'SHA256SUMS')), 'HOLDOUT_DIR_INVALID', dir);
  const sumsBytes = fs.readFileSync(path.join(dir, 'SHA256SUMS'));
  const parse = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l); need(m, 'HOLDOUT_SHA256SUMS_LINE', l); return { line: l, sha: m[1], name: m[2] };
  });
  const listed = parse(sumsBytes.toString('utf8'));
  let sealedNames = new Set(listed.map((x) => x.name)); // 封存时的文件（没有补导时就是现在这些）
  if (sha256(sumsBytes) !== seal.data_sha256) {
    const sealedFile = path.join(dir, 'SHA256SUMS.sealed');
    need(fs.existsSync(sealedFile) && sha256(fs.readFileSync(sealedFile)) === seal.data_sha256, 'HOLDOUT_SHA_MISMATCH', dir);
    const now1 = new Set(listed.map((x) => x.line));
    const lost = parse(fs.readFileSync(sealedFile, 'utf8')).filter((x) => !now1.has(x.line));
    need(!lost.length, 'HOLDOUT_SEALED_FILES_CHANGED', lost.map((x) => x.name).join(','));
    sealedNames = new Set(parse(fs.readFileSync(sealedFile, 'utf8')).map((x) => x.name));
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
  // 日历：留出段目录与之前的 LIVE 源（验证尾段）的 SSE 开市日，与面板同一种读法（READY，同一天取入库最晚、修订号大的）
  const cal = new Map(); let last = '';
  const readCal = (s, own) => s.forEach('calendar', (r) => {
    const ex = Object.prototype.hasOwnProperty.call(r, 'exchange') ? r.exchange : r.market;
    if (ex !== adapter.CALENDAR_EXCHANGE || (r.quality_state !== undefined && r.quality_state !== 'READY')) return; // 只数 READY 的日历行
    const at = adapter.internals.parseTs(r.first_available_at); const rev = Number(r.revision || 0);
    const cur = cal.get(r.calendar_date);
    if (!cur || adapter.laterRevision(cur.at, cur.rev, at, rev)) cal.set(r.calendar_date, { at, rev, open: r.is_open === 't' || r.is_open === 'true' });
    if (own && r.calendar_date > last) last = r.calendar_date;
  });
  const prior = priorSources.filter((s) => s.mode === 'LIVE' && !s.holdout);
  const others = priorSources.filter((s) => !s.holdout); // 跟进 A：所有留出段以外的源（LIVE 与 HISTORY）都要核没有留出段日子的行
  for (const s of prior) if (s.has('calendar')) readCal(s, false);
  readCal(src, true);
  need(last >= seal.segment.to, 'HOLDOUT_INCOMPLETE', `trading_calendar.csv:${seal.segment.to}`);
  const openAll = [...cal.entries()].filter(([, v]) => v.open).map(([d]) => d).sort();
  const days = openAll.filter((d) => d >= seal.segment.from && d <= seal.segment.to);
  need(days.length, 'HOLDOUT_INCOMPLETE', 'trading_calendar.csv:no open day');
  // 复审 #127 P3-2：面板读的是「喂」这些决策日的交易日——每个决策日的前一个开市日（第一个决策日的前一天在验证尾段里），不是决策日本身；
  // 日线、复权因子另有决策日当天的执行价（标签），那一份不看截止。P1-1：LIVE 截止与面板同一个函数（adapter.liveCutoffs）。
  const k0 = openAll.indexOf(days[0]);
  need(k0 > 0, 'HOLDOUT_INCOMPLETE', `trading_calendar.csv:no open day before ${days[0]}`);
  const feedDays = days.map((d) => openAll[openAll.indexOf(d) - 1]);
  const feedSet = new Set(feedDays); const daySet = new Set(days);
  // 跟进 A（复审 R9 / R9b）：面板把所有源合在一起读，留出段以外的源里交易日落在第一个决策日或之后的日线 / daily_basic / 复权因子行，
  // 会与封存的行争同一格（更晚的修订就顶替）；停牌两张表的行会多记停牌（★RF1116_SUSPENSION_CUT = (a)）。
  // 导出规格 rev 5（0aac3303）改动三：这五张表截到 D1。这样的行一行都不许有，开启之前就拒。
  const CUT_TABLES = [['prices', 'prices_daily_stock.csv'], ['basic', 'market_daily_basic_observation_stock.csv'], ['adj', 'adjustment_factor_observation_stock.csv'],
    ['suspension', 'security_suspension_observation.csv'], ['suspension_coverage', 'security_suspension_day_coverage.csv']];
  for (const s of others) for (const [key, file] of CUT_TABLES) {
    if (!s.has(key)) continue;
    s.forEach(key, (r) => { need(!(r.trade_date >= days[0]), 'HOLDOUT_DAY_IN_NON_HOLDOUT_SOURCE', `${s.label}:${file}:${r.trade_date}`); });
  }
  const cutoffOf = adapter.liveCutoffs(openAll);
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const partsOf = (file) => { const stem = file.slice(0, -'.csv'.length); return listed.map((x) => x.name).filter((n) => n === file || (n.startsWith(stem) && /^_\d{8}\.csv$/.test(n.slice(stem.length)))).sort(); };
  /** 一张表的每一行（READY、非北交所）：留出段目录的各个部分（标 sealed），加上之前的 LIVE 源里交易日在第一个决策日之前、又喂某个决策日的行。 */
  const eachRow = (file, key, cb) => {
    const keep = (r) => r.quality_state === 'READY' && !/\.BJ$/i.test(r.security_id || '');
    for (const part of partsOf(file)) adapter.internals.forEachCsvRow(path.join(dir, part), (r) => { if (keep(r)) cb(r, sealedNames.has(part), part); }); // 第 2 步已经核过 sha
    for (const s of prior) if (s.has(key)) s.forEach(key, (r) => { if (keep(r) && r.trade_date < days[0] && feedSet.has(r.trade_date)) cb(r, false, s.label); });
  };
  const add = (m, d, id) => { if (!m.has(d)) m.set(d, new Set()); m.get(d).add(id); };
  const floorRows = (file, view, list, all, sealedOnly) => {
    const per = list.map((d) => (all.get(d) ? all.get(d).size : 0));
    const sealedCounts = list.filter((d) => sealedOnly.has(d)).map((d) => sealedOnly.get(d).size);
    need(sealedCounts.length, 'HOLDOUT_SEALED_DAYS_EMPTY', view ? `${file}:${view}` : file);
    const anchor = median(sealedCounts);
    list.forEach((d, k) => {
      need(per[k] >= minNamesPerDay && per[k] >= HOLDOUT_FLOOR.min_share_of_sealed_median * anchor, 'HOLDOUT_INCOMPLETE', view ? `${file}:${view}:${d}:${per[k]}` : `${file}:${d}:${per[k]}`);
    });
    return { min_names: Math.min(...per), median_names: median(per), sealed_days: sealedCounts.length, sealed_median_names: anchor, trade_dates: { from: list[0], to: list[list.length - 1] } };
  };
  const rowsPerDay = {}; const labelRowsPerDay = {};
  const fieldKeys = Object.values(adapter.BASIC_FIELDS);
  const USABLE = new Set(adapter.USABLE_BASIC_STATES);
  const bestAll = new Map(); const bestSealed = new Map(); // 「日|代码」→ { at, rev, d, mask }：截止前入库的最新一行，只留七个字段的状态位
  for (const [file, key, label] of [['prices_daily_stock.csv', 'prices', true], ['market_daily_basic_observation_stock.csv', 'basic', false], ['adjustment_factor_observation_stock.csv', 'adj', true]]) {
    const lagAll = new Map(); const lagSealed = new Map(); const labAll = new Map(); const labSealed = new Map();
    const isBasic = file === HOLDOUT_FIELD_FLOOR.file;
    eachRow(file, key, (r, sealed, part) => {
      const at = adapter.internals.parseTs(r.first_available_at);
      if (feedSet.has(r.trade_date)) {
        let mask = 0;
        if (isBasic) { // 复审 P2-1、P2-2：values 解析不过 → 开启之前就拒；只读状态，不读数、不留原文
          let v; try { v = JSON.parse(r.values); } catch { v = undefined; }
          need(v !== null && typeof v === 'object' && !Array.isArray(v), 'HOLDOUT_FIELD_VALUES_INVALID', `${file}:${r.trade_date}:${r.security_id}:${part}`);
          // ★RF1116_PRESENT_NULL = refuse：PRESENT 却没有值（null / 缺这个键）当 MISSING 算——只看有没有值，不读值的大小
          fieldKeys.forEach((f, i) => { const x = v[f]; if (x !== null && typeof x === 'object' && USABLE.has(x.state) && !(x.state === 'PRESENT' && (x.value === null || x.value === undefined))) mask |= 1 << i; });
        }
        if (at <= cutoffOf(r.trade_date)) { // 面板（LIVE）只用截止前入库的行
          add(lagAll, r.trade_date, r.security_id); if (sealed) add(lagSealed, r.trade_date, r.security_id);
          if (isBasic) {
            const row = { at, rev: Number(r.revision || 0), d: r.trade_date, mask }; const k = `${r.trade_date}|${r.security_id}`;
            const pick = (m) => { const cur = m.get(k); if (!cur || adapter.laterRevision(cur.at, cur.rev, row.at, row.rev)) m.set(k, row); };
            pick(bestAll); if (sealed) pick(bestSealed);
          }
        }
      }
      if (label && daySet.has(r.trade_date)) { add(labAll, r.trade_date, r.security_id); if (sealed) add(labSealed, r.trade_date, r.security_id); }
    });
    rowsPerDay[file] = floorRows(file, null, feedDays, lagAll, lagSealed);
    if (label) labelRowsPerDay[file] = floorRows(file, 'LABEL', days, labAll, labSealed);
  }
  // daily_basic 逐字段的取值状态（HOLDOUT_FIELD_FLOOR）：每个交易日、每个字段，状态读得出数的名字 ≥ 封存那一份的中位数 × 份额（★RF1116_FIELD_FLOOR_SHARE）；
  // total_mv 另要 ≥ 名字数下限。协调会话的排除文件（sha 钉住）列出的（日, 字段）不判，照实写进结果。
  const fieldStates = {};
  const excluded = new Set((fieldExclusions ? fieldExclusions.pairs : []).map((x) => `${x.field}|${x.trade_date}`));
  if (fieldExclusions) for (const x of fieldExclusions.pairs) {
    need(!HOLDOUT_FIELD_FLOOR.absolute_floor_fields.includes(x.field), 'FIELD_EXCLUSION_NOT_ALLOWED', `${x.trade_date}:${x.field}`); // 跟进 D：核对自己也拒，不只读文件时拒
    need(feedSet.has(x.trade_date), 'FIELD_EXCLUSION_DAY_UNKNOWN', `${x.trade_date}:${x.field}`);
  }
  {
    const file = HOLDOUT_FIELD_FLOOR.file;
    const tally = (m) => { const out = new Map(); for (const row of m.values()) fieldKeys.forEach((f, i) => { if (row.mask & (1 << i)) { const key = `${f}|${row.d}`; out.set(key, (out.get(key) || 0) + 1); } }); return out; };
    const all = tally(bestAll); const sealedT = tally(bestSealed);
    const sealedDaySet = new Set(); for (const row of bestSealed.values()) sealedDaySet.add(row.d);
    const sealedDays = feedDays.filter((d) => sealedDaySet.has(d));
    for (const k of fieldKeys) {
      const per = feedDays.map((d) => all.get(`${k}|${d}`) || 0);
      const sealedCounts = sealedDays.map((d) => sealedT.get(`${k}|${d}`) || 0);
      const anchor = sealedCounts.length ? median(sealedCounts) : 0;
      need(anchor > 0, 'HOLDOUT_FIELD_EMPTY', `${file}:${k}`);
      const abs = HOLDOUT_FIELD_FLOOR.absolute_floor_fields.includes(k);
      const skipped = [];
      feedDays.forEach((d, i) => {
        if (excluded.has(`${k}|${d}`)) { skipped.push(d); return; }
        need(per[i] >= HOLDOUT_FIELD_FLOOR.min_share_of_sealed_median * anchor && (!abs || per[i] >= minNamesPerDay), 'HOLDOUT_FIELD_INCOMPLETE', `${file}:${k}:${d}:${per[i]}`);
      });
      fieldStates[k] = { min: Math.min(...per), median: median(per), sealed_median: anchor, excluded_days: skipped };
    }
  }
  const { min_names_per_day: _d, ...rest } = HOLDOUT_FLOOR;
  return { calendar_to: last, open_days: days.length, trade_dates: { from: feedDays[0], to: feedDays[feedDays.length - 1], prior_sources: prior.map((s) => s.label) },
    rows_per_day: rowsPerDay, label_rows_per_day: labelRowsPerDay, field_states_per_day: fieldStates, floor: { min_names_per_day: minNamesPerDay, ...rest },
    field_floor: { ...HOLDOUT_FIELD_FLOOR, absolute_floor_fields: [...HOLDOUT_FIELD_FLOOR.absolute_floor_fields] },
    field_exclusions: fieldExclusions ? { sha256: fieldExclusions.sha256, ruling: fieldExclusions.ruling, pairs: fieldExclusions.pairs } : null, source: src };
}

/**
 * 协调会话的字段排除文件（DEPLOY.md「排除那一天或那个字段」的落地；复审 #127 P3-1）：HOLDOUT_FIELD_EXCLUSIONS_V1，按 sha256 钉住。
 *   { schema, round_id, ruling: { path, sha256 }, exclusions: [{ trade_date, field, reason }] }；字段是 daily_basic 的七个键之一；total_mv 不许排除（市值中性化要用它）。
 * 没有这个文件，什么都不排除。
 */
const FIELD_EXCLUSIONS_SCHEMA = 'HOLDOUT_FIELD_EXCLUSIONS_V1';
function loadFieldExclusions(file, expectedSha256, roundId) {
  need(file && fs.existsSync(file), 'FIELD_EXCLUSIONS_MISSING', String(file));
  need(SHA64_RE.test(expectedSha256 || ''), 'FIELD_EXCLUSIONS_SHA_REQUIRED', String(expectedSha256));
  const bytes = fs.readFileSync(file);
  need(sha256(bytes) === expectedSha256, 'FIELD_EXCLUSIONS_SHA_MISMATCH', file);
  let j; try { j = JSON.parse(bytes.toString('utf8')); } catch { j = null; }
  need(j && j.schema === FIELD_EXCLUSIONS_SCHEMA && j.round_id === roundId, 'FIELD_EXCLUSIONS_INVALID', `${file}:schema/round`);
  need(j.ruling && typeof j.ruling.path === 'string' && j.ruling.path && SHA64_RE.test(j.ruling.sha256 || ''), 'FIELD_EXCLUSIONS_INVALID', `${file}:ruling`);
  need(Array.isArray(j.exclusions) && j.exclusions.length > 0, 'FIELD_EXCLUSIONS_INVALID', `${file}:exclusions`);
  const fields = new Set(Object.values(adapter.BASIC_FIELDS)); const seen = new Set();
  const pairs = j.exclusions.map((x) => {
    need(x && /^\d{4}-\d{2}-\d{2}$/.test(x.trade_date || '') && fields.has(x.field) && typeof x.reason === 'string' && x.reason.trim(), 'FIELD_EXCLUSIONS_INVALID', `${file}:${JSON.stringify(x)}`);
    need(!HOLDOUT_FIELD_FLOOR.absolute_floor_fields.includes(x.field), 'FIELD_EXCLUSION_NOT_ALLOWED', `${x.trade_date}:${x.field}`);
    const key = `${x.trade_date}|${x.field}`; need(!seen.has(key), 'FIELD_EXCLUSIONS_INVALID', `${file}:duplicate ${key}`); seen.add(key);
    return { trade_date: x.trade_date, field: x.field, reason: x.reason };
  }).sort((a, b) => (a.trade_date + a.field < b.trade_date + b.field ? -1 : 1));
  return { sha256: expectedSha256, ruling: { path: j.ruling.path, sha256: j.ruling.sha256 }, pairs };
}

/** 对着本轮的封存记录核留出段目录。 */
function verifyHoldoutDir(roundId, dir, opts = {}) {
  const seal = vault.sealOf(roundId);
  need(seal, 'NOT_SEALED', roundId);
  return { ...holdoutDirCheck(dir, seal, opts), seal_hash: seal.record_hash, data_sha256: seal.data_sha256 };
}
/** 留出段目录核对写进开启记录与 score.json 的那一份（复审 #127 P2-3：逐字段的计数、字段下限、排除文件都在，事后能说清是哪些数放它开的）。 */
const holdoutDirRecord = (c) => ({ open_days: c.open_days, calendar_to: c.calendar_to, trade_dates: c.trade_dates, rows_per_day: c.rows_per_day, label_rows_per_day: c.label_rows_per_day,
  field_states_per_day: c.field_states_per_day, field_floor: c.field_floor, field_exclusions: c.field_exclusions });
/** 覆盖下限的记录（写进台账：开轮写进轮次清单，打分写进开启记录）：用了几、默认几、是不是压低了。 */
const floorRecord = (floor, base = COVERAGE_FLOOR) => ({ min_names_per_day: { value: floor.min_names_per_day, default: base.min_names_per_day, overridden: floor.min_names_per_day !== base.min_names_per_day } });

/** 打分要用到的代码（R1.8：重打分要同一份代码）。 */
const CODE_FILES = Object.freeze(['round-runner/index.js', 'round-runner/holdout-scoring.js', 'round-runner/selector.js', 'scoring/index.js', 'data-adapter/index.js', 'data-adapter/csv.js',
  'price-limits.js', 'factor-series/index.js', 'evaluator/index.js', 'evaluator/operators.js', 'dsl/index.js', 'segments.js']);
let codeShaCache = null;
const codeSha = () => (codeShaCache || (codeShaCache = sha256(CODE_FILES.map((f) => `${f}\n${sha256(fs.readFileSync(path.join(__dirname, '..', f)))}`).join('\n'))));

let fault = null;
/** 只给测试用：在给定的点抛 MINE_RUNNER_TEST_FAULT（模拟容器在开启之后崩溃）：AFTER_OPEN、AFTER_FIRST_RECORD、AFTER_RESCORE_EVENT。 */
function withFault(point, cb) { const prior = fault; fault = point; try { return cb(); } finally { fault = prior; } }
const faultAt = (point) => { if (fault === point) fail('TEST_FAULT', point); };

/**
 * R1.5 的协调会话复审（MECHANISM_REVIEW_V1，最新一行算数）：打分之前必须有，且
 *   行没被改过（record_hash 重算得出）→ 否则 MECHANISM_REVIEW_HASH_MISMATCH；选择记录里每个候选都有 APPROVED / REJECTED → 否则 _INCOMPLETE；
 *   选择记录与机制集合 sha 等于现在的登记 → 否则 _STALE；reviewed_at 与 recorded_at 不晚于现在（第一次打分：开启记录在这次检查之后才写）、
 *   重打分时严格早于那次开启的 opened_at → 否则 _AFTER_OPEN。
 * 没有 → MECHANISM_REVIEW_MISSING。返回复审行与 候选 → 裁决。
 */
function reviewedMechanisms(roundId, selRow, before, { strict = true } = {}) {
  const mechs = require('../../mining-rounds/mechanisms');
  const rv = mechs.latestReview(roundId);
  need(rv, 'MECHANISM_REVIEW_MISSING', `${roundId}: no MECHANISM_REVIEW_V1 row (run.sh review)`);
  const { record_hash: h, ...body } = rv;
  need(require('../../trial-ledger').recordHash(body) === h, 'MECHANISM_REVIEW_HASH_MISMATCH', roundId);
  const verdicts = new Map((rv.verdicts || []).map((v) => [v.candidate_id, v.verdict]));
  const missing = selRow.selected.filter((id) => !mechs.VERDICTS.includes(verdicts.get(id)));
  need(!missing.length, 'MECHANISM_REVIEW_INCOMPLETE', `${roundId}: ${missing.length} selected candidate(s) without a verdict`);
  need(rv.selection_record_hash === selRow.record_hash && rv.mechanism_set_sha256 === mechs.mechanismSetSha(roundId).sha256, 'MECHANISM_REVIEW_STALE',
    `${roundId}: the registrations changed after the review`);
  // 重打分：严格早于那次开启；第一次打分：不晚于现在（检查在开启之前，开启记录在它之后才写）
  const ok = (t) => Number.isFinite(Date.parse(t)) && (strict ? Date.parse(t) < Date.parse(before) : Date.parse(t) <= Date.parse(before));
  need([rv.reviewed_at, rv.recorded_at].every(ok), 'MECHANISM_REVIEW_AFTER_OPEN', `${roundId}:${rv.recorded_at} vs ${before}`);
  return { review: rv, verdicts };
}

/**
 * 开启之前的一切（第一次打分与 R1.8 的重打分共用）：选择记录与 selection.json、现有因子序列、留出段目录的核对、机制登记与协调会话的复审、
 * 以及这次打分的全部输入的 sha（inputs_sha256：重打分要与开启时一样）。不写任何东西。reviewBefore：复审必须早于它（默认现在）。
 */
function prepareScoring({ roundId, sources, holdoutDir, outDir, holdoutFloor, factorSeriesDir, reviewBefore = null, fieldExclusions = null }) {
  for (const s of sources) need(!s.holdout, 'HOLDOUT_PASSED_AS_SOURCE', s.label);
  const dir = runDir(outDir, roundId);
  // 选择只信台账里那一行（复审第 3 条）：输出目录里的 selection.json 要对得上它的 sha；候选编号取这一行，公式取试验台账行
  const selRow = rounds.selectionOf(roundId);
  need(selRow, 'SELECTION_MISSING', roundId);
  const selFile = path.join(dir, 'selection.json');
  need(fs.existsSync(selFile) && sha256(fs.readFileSync(selFile)) === selRow.selection_sha256, 'SELECTION_FILE_MISMATCH', roundId);
  const formulas = new Map(scoredAttempts(roundId).map((c) => [c.candidate_id, c.formula]));
  for (const id of selRow.selected) need(formulas.has(id), 'SELECTION_CANDIDATE_UNKNOWN', id);
  // R1.3：验证折的月度序列来自已核过 sha 的 selection.json
  const selection = JSON.parse(fs.readFileSync(selFile, 'utf8'));
  const validation = new Map(selection.candidates.map((c) => [c.candidate_id, c.validation_book]));
  const familySharpes = selection.candidates.map((c) => (c.validation_book ? c.validation_book.sr : null)).filter((x) => typeof x === 'number');
  // R1.4：现有因子序列（给了就读、核 sha；在开启之前读完）
  const factorSeries = factorSeriesDir ? require('../factor-series').loadFactorSeries(factorSeriesDir) : null;
  // 复审 #127 P3-2：第一个决策日的前一个交易日在验证尾段（LIVE 源）里，一并核；字段排除文件（有就用，sha 钉住）
  const exclusions = fieldExclusions ? loadFieldExclusions(fieldExclusions.file, fieldExclusions.sha256, roundId) : null;
  const checked = selRow.selected.length ? verifyHoldoutDir(roundId, holdoutDir, { minNamesPerDay: holdoutFloor.min_names_per_day, priorSources: sources, fieldExclusions: exclusions }) : null;
  // R1.5：开启之前写的机制登记（开启之后不能再写）
  const mechs = new Map(require('../../mining-rounds/mechanisms').mechanismsOf(roundId).map((m) => [m.candidate_id, m]));
  const reviewed = selRow.selected.length ? reviewedMechanisms(roundId, selRow, reviewBefore || now(), { strict: Boolean(reviewBefore) }) : null;
  const sealedFile = holdoutDir ? path.join(holdoutDir, 'SHA256SUMS.sealed') : null;
  const inputs = {
    selection_record_hash: selRow.record_hash, selection_sha256: selRow.selection_sha256,
    holdout_sums_sha256: holdoutDir && fs.existsSync(path.join(holdoutDir, 'SHA256SUMS')) ? sha256(fs.readFileSync(path.join(holdoutDir, 'SHA256SUMS'))) : null,
    holdout_sealed_file_sha256: sealedFile && fs.existsSync(sealedFile) ? sha256(fs.readFileSync(sealedFile)) : null,
    factor_series_sums_sha256: factorSeries ? factorSeries.sums_sha256 : null, sources: sources.map((s) => ({ label: s.label, sums_sha256: s.sums_sha256 || null })),
    code_sha256: codeSha(), holdout_floor: holdoutFloor.min_names_per_day, mechanisms: [...mechs.values()].map((m) => m.record_hash).sort(),
    mechanism_review: reviewed ? reviewed.review.record_hash : null,
    ...(exclusions ? { field_exclusions_sha256: exclusions.sha256 } : {}), // 有排除文件才写（没有时 inputs 与之前逐字节相同）
  };
  return { dir, selRow, formulas, validation, familySharpes, factorSeries, checked, mechs, reviewed, inputs, inputs_sha256: sha256(JSON.stringify(inputs)) };
}

/** 开启之后：建留出段面板、只经 holdout-scoring 打分、逐候选记录 G-MINE（第一次与重打分一样）。 */
function scoreOpened(p, { roundId, sources, scoredAt, candidateIds, segmentOpenIndex, openedAt, rescored = false }) {
  const f = loadFrozenSpace();
  const panel = adapter.buildPanel({ sources: [...sources, p.checked.source], space: f.space, segment: 'HOLDOUT', from: segs.SEGMENTS.MINING.from, to: segs.SEGMENTS.HOLDOUT.to });
  const stamp = scoredAt || new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');
  const generatorMode = rounds.roundHead(roundId).generator.mode; // 结果记的生成方式来自轮次清单（LLM 轮不能记成 GP）
  const results = holdoutScoring.roundResults(candidateIds.map((id) => ({ candidate_id: id, formula: p.formulas.get(id), parsed: dsl.parse(p.formulas.get(id), f.dslSpace), generator: generatorMode })),
    panel, { holding_period: f.holdingPeriod, market: MARKET, familyTrialCount: rounds.familyN(MARKET, f.holdingPeriod), scoredAt: stamp, validation: p.validation,
      familySharpes: p.familySharpes, neutralization: neutralizationOf(rounds.roundHead(roundId)), mechanisms: p.mechs, factorSeries: p.factorSeries, segmentOpenIndex, openedAt,
      review: p.reviewed ? { verdicts: p.reviewed.verdicts, review_hash: p.reviewed.review.record_hash, reviewed_at: p.reviewed.review.reviewed_at } : null });
  const records = results.map((res, k) => { const rec = gateRecords.recordGateResult({ round_id: roundId, candidate_id: res.candidate_id, candidate: res }); if (k === 0) faultAt('AFTER_FIRST_RECORD'); return rec; });
  const c = p.checked;
  writeJson(path.join(p.dir, rescored ? 'score.rescore.json' : 'score.json'), { schema: 'MINING_RUNNER_SCORE_V1', round_id: roundId, opened: true, rescored, selection_record_hash: p.selRow.record_hash,
    inputs_sha256: p.inputs_sha256, factor_series: p.factorSeries ? { sums_sha256: p.factorSeries.sums_sha256, factor_ids: p.factorSeries.factor_ids } : null,
    mechanisms: [...p.mechs.values()].map((m) => ({ candidate_id: m.candidate_id, record_hash: m.record_hash })),
    mechanism_review: p.reviewed ? { record_hash: p.reviewed.review.record_hash, mechanism_set_sha256: p.reviewed.review.mechanism_set_sha256, reviewer: p.reviewed.review.reviewer,
      reviewed_at: p.reviewed.review.reviewed_at } : null,
    holdout: { seal_hash: c.seal_hash, data_sha256: c.data_sha256, ...holdoutDirRecord(c) }, holdout_panel: panel.manifest, results,
    records: records.map((x) => ({ candidate_id: x.candidate_id, pass: x.pass, codes: x.codes, record_hash: x.record_hash })) });
  return records;
}

/**
 * 第 6–8 步：核留出段目录 → holdout-vault.open（每轮一次，记下选择记录的 hash 与 inputs_sha256）→ 只经 holdout-scoring 打分 → 每个候选 recordGateResult。
 * 没有候选过验证折：不开留出段，返回 { opened: false }（关轮记 0）。holdoutFloor 默认 HOLDOUT_FLOOR（每天 4,000 只；测试可以压低，压低的数写进开启记录）。
 */
function scoreHoldout({ roundId, sources, holdoutDir, outDir, scoredAt = null, holdoutFloor = HOLDOUT_FLOOR, factorSeriesDir = null, fieldExclusions = null }) {
  const r = rounds.roundHead(roundId);
  need(r, 'ROUND_NOT_FOUND', roundId);
  need(r.status !== 'FAILED_RESCORE', 'ROUND_FAILED_RESCORE', roundId);
  need(r.status !== 'FAILED_PARTIAL', 'ROUND_FAILED_PARTIAL', roundId);
  need(r.status !== 'FAILED_EVALUATION', 'ROUND_FAILED_EVALUATION', roundId);
  const p = prepareScoring({ roundId, sources, holdoutDir, outDir, holdoutFloor, factorSeriesDir, fieldExclusions });
  if (!p.selRow.selected.length) { writeJson(path.join(p.dir, 'score.json'), { schema: 'MINING_RUNNER_SCORE_V1', round_id: roundId, opened: false, records: [] }); return { opened: false, records: [] }; }
  const c = p.checked;
  const opened = vault.open({ round_id: roundId, candidate_ids: [...p.selRow.selected], openedBy: RUNNER_ID, selection_record_hash: p.selRow.record_hash, inputs_sha256: p.inputs_sha256,
    checks: { ...floorRecord(holdoutFloor, HOLDOUT_FLOOR), holdout_dir: holdoutDirRecord(c) } });
  faultAt('AFTER_OPEN');
  const [openRec] = vault.openLog(roundId); // 第 9 项按开启记录的 opened_at 核机制登记（修订 4）
  const records = scoreOpened(p, { roundId, sources, scoredAt, candidateIds: opened.candidate_ids, segmentOpenIndex: opened.segment_open_index, openedAt: openRec.opened_at });
  return { opened: true, records };
}

/**
 * 协调会话裁定 R1.8：开启之后崩溃的恢复，恰好一次 RESCORE_SAME_SELECTION。
 *   轮次在 SCORING、没有记过重打分 → 重做开启之前的全部核对（同样的输入，inputs_sha256 要等于开启时的）→ holdout-vault.recordRescore（第二个事件：原因 + 日志；
 *     它核选集行逐字节没变、第一次没写 G-MINE 记录、只许一次）→ 用同一份选集打分、记录。
 *   已经记过一次重打分、轮次还在 SCORING（重打分又崩了）→ 以 FAILED_RESCORE 关轮（不算记录，尝试照旧计入 N），拒绝（MINE_RUNNER_RESCORE_FAILED）；
 *   没有重打分事件、但第一次已经写了 G-MINE 记录（至少一条、没写完）→ 裁定 R1.12：以 FAILED_PARTIAL 关轮（0 个通过，记录标 VOID，尝试留在 N，
 *     释放名额，留出段开启照旧计数），拒绝（MINE_RUNNER_RESCORE_RECORDS_EXIST）；
 *   之后任何打分或重打分 → MINE_RUNNER_ROUND_FAILED_RESCORE / MINE_RUNNER_ROUND_FAILED_PARTIAL。
 */
function rescore({ roundId, sources, holdoutDir, outDir, reason, log = '', scoredAt = null, holdoutFloor = HOLDOUT_FLOOR, factorSeriesDir = null, fieldExclusions = null }) {
  const r = rounds.roundHead(roundId);
  need(r, 'ROUND_NOT_FOUND', roundId);
  need(r.status !== 'FAILED_RESCORE', 'ROUND_FAILED_RESCORE', roundId);
  need(r.status !== 'FAILED_PARTIAL', 'ROUND_FAILED_PARTIAL', roundId);
  need(r.status !== 'FAILED_EVALUATION', 'ROUND_FAILED_EVALUATION', roundId);
  need(r.status === 'SCORING', 'ROUND_NOT_SCORING', `${roundId}:${r.status}`);
  const [open] = vault.openLog(roundId);
  need(open, 'ROUND_NOT_OPENED', roundId);
  need(gateRecords.recordsOf(roundId).length < open.candidate_ids.length, 'RESCORE_NOT_NEEDED', `${roundId}: every record is written, close the round`);
  if (vault.rescoreLog(roundId).length) {
    rounds.failRescore(roundId, { reason, logSha256: sha256(String(log || '')) });
    fail('RESCORE_FAILED', `${roundId}: second crash, closed as FAILED_RESCORE`);
  }
  const written = gateRecords.recordsOf(roundId).length;
  if (written) {
    rounds.failPartial(roundId, { reason, logSha256: sha256(String(log || '')) });
    fail('RESCORE_RECORDS_EXIST', `${roundId}: ${written} G-MINE record(s) written before the crash, closed as FAILED_PARTIAL (R1.12)`);
  }
  const p = prepareScoring({ roundId, sources, holdoutDir, outDir, holdoutFloor, factorSeriesDir, reviewBefore: open.opened_at, fieldExclusions }); // 复审要早于那一次开启
  vault.recordRescore({ round_id: roundId, reason, log, inputs_sha256: p.inputs_sha256, rescoredBy: RUNNER_ID });
  faultAt('AFTER_RESCORE_EVENT');
  const records = scoreOpened(p, { roundId, sources, scoredAt, candidateIds: open.candidate_ids, segmentOpenIndex: open.segment_open_index, openedAt: open.opened_at, rescored: true });
  return { rescored: true, records };
}

/** 续跑（--resume）用的覆盖下限写进轮次行（data_checks.resumes）。 */
const noteResume = ({ roundId, coverageFloor = COVERAGE_FLOOR }) => rounds.recordResumeCheck(roundId, { ...floorRecord(coverageFloor), at: now() });

/**
 * R1.5：过了验证折的候选（幸存者）与它们的机制登记状态，给命令行 mechanisms 用。候选编号取选择记录，公式取试验台账行，
 * 验证折的读数取已核过 sha 的 selection.json。
 */
function survivors({ roundId, outDir }) {
  const selRow = rounds.selectionOf(roundId);
  need(selRow, 'SELECTION_MISSING', roundId);
  const selFile = path.join(runDir(outDir, roundId), 'selection.json');
  need(fs.existsSync(selFile) && sha256(fs.readFileSync(selFile)) === selRow.selection_sha256, 'SELECTION_FILE_MISMATCH', roundId);
  const sel = new Map(JSON.parse(fs.readFileSync(selFile, 'utf8')).candidates.map((c) => [c.candidate_id, c]));
  const formulas = new Map(scoredAttempts(roundId).map((c) => [c.candidate_id, c]));
  const mechs = require('../../mining-rounds/mechanisms');
  return selRow.selected.map((id) => {
    const m = mechs.mechanismOf(roundId, id); const c = sel.get(id) || {};
    return { candidate_id: id, formula: formulas.get(id).formula, mining_score: formulas.get(id).mining_score, validation_mean_ic: c.mean_ic ?? null, positive_folds: c.positive_folds ?? null,
      registered: Boolean(m), mechanism_id: m ? m.mechanism_id : null, written_at: m ? m.written_at : null };
  });
}

/** 第 9 步：关轮（过了几个由记录数出来）。 */
const close = ({ roundId, closedAt = null }) => rounds.closeRound(roundId, { closedAt });

/** 只给测试用：临时换冻结输入的期望 sha（核对不上必须拒绝），回调结束还原。 */
function withFrozenInputs(patch, cb) { const prior = frozenInputs; frozenInputs = { ...frozenInputs, ...patch }; try { return cb(); } finally { frozenInputs = prior; } }

/** 只给测试用：临时换生成方（合成的尝试序列），回调结束还原。 */
function withLlmConfig(bytes, cb) {
  const prior = llmConfigBytes; llmConfigBytes = bytes;
  let out;
  try { out = cb(); } catch (e) { llmConfigBytes = prior; throw e; }
  if (out && typeof out.then === 'function') return out.finally(() => { llmConfigBytes = prior; });
  llmConfigBytes = prior;
  return out;
}
function withGenerator(gen, cb) { const prior = generatorOverride; generatorOverride = gen; try { return cb(); } finally { generatorOverride = prior; } }

module.exports = {
  MARKET, RUNNER_ID, FROZEN_INPUTS, COVERAGE_FLOOR, HOLDOUT_FLOOR, HOLDOUT_TABLES, RunnerError, CANARY, HOLDOUT_FIELD_FLOOR, start, loadFrozenSpace, checkCoverage, checkCanary, requestRound, sealHoldout, generate, select,
  holdoutDirCheck, verifyHoldoutDir, loadFieldExclusions, FIELD_EXCLUSIONS_SCHEMA, scoreHoldout, rescore, noteResume, close, scoredAttempts, survivors, codeSha, LEGACY_LINEAR_RAW_V1_ROUNDS, neutralizationOf,
  probeLlm, assertResumeGenerator, internals: { withGenerator, withFrozenInputs, withFault, withLlmConfig, attemptId },
};
