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

class RunnerError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new RunnerError(`MINE_RUNNER_${code}`, detail); };
const need = (c, code, detail) => { if (!c) fail(code, detail); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
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
function requestRound({ generator, cap = rounds.LIMITS.candidates_per_round, openedAt = null } = {}) {
  generators.assertGeneratorEnabled(generator);
  need(Number.isInteger(generator.gp_seed), 'GP_SEED_REQUIRED');
  const f = loadFrozenSpace();
  return rounds.openRound({
    market: MARKET, space: { space_ref: f.space.space_ref, sha256: f.space.sha256, freeze: f.freeze }, holding_periods: [...f.space.holding_periods],
    generator: { mode: 'AI_MINED_GP', gp_seed: generator.gp_seed }, holdout: { from: segs.SEGMENTS.HOLDOUT.from, to: segs.SEGMENTS.HOLDOUT.to }, cap, openedAt: openedAt || undefined,
  });
}

/** 第 2 步：封存留出段（只记引用与 SHA256SUMS 的 sha256；数据不进 QRP，生成阶段也不挂）。 */
function sealHoldout({ roundId, dataRef, dataSha256, sealedAt = null }) {
  const r = rounds.roundHead(roundId);
  need(r, 'ROUND_NOT_FOUND', roundId);
  return vault.seal({ round_id: roundId, segment: { ...r.holdout }, data_ref: dataRef, data_sha256: dataSha256, sealedBy: RUNNER_ID, sealedAt });
}

const attemptId = (roundId, n) => `${roundId}:A${String(n).padStart(3, '0')}`;

/**
 * 第 3–4 步：生成 + 挖掘段打分 + 每个尝试一行试验台账，到上限停。sources = 车道副本与验证折尾段（不许有留出段）。
 * @returns {{round_id, status, attempts: {scored, parse_refused, deduped}, total}}
 */
function generate({ roundId, sources, outDir, registeredBy }) {
  need(Array.isArray(sources) && sources.length, 'SOURCES_MISSING');
  for (const s of sources) need(!s.holdout, 'HOLDOUT_IN_GENERATION', s.label);
  const dir = runDir(outDir, roundId);
  need(!fs.existsSync(path.join(dir, 'selection.json')), 'GENERATION_CLOSED', `${roundId}: selection done`);
  let r = rounds.roundHead(roundId);
  need(r, 'ROUND_NOT_FOUND', roundId);
  need(r.generator.mode === 'AI_MINED_GP', 'GENERATOR_NOT_GP', r.generator.mode);
  const f = loadFrozenSpace();
  need(r.space.sha256 === f.space.sha256, 'ROUND_SPACE_MISMATCH', r.space.sha256);
  const H = f.holdingPeriod;
  const gen = generatorOverride || generators.generatorFor(r.generator, { space: f.dslSpace, holdingPeriod: H });
  const m = segs.SEGMENTS.MINING;
  const panel = adapter.buildPanel({ sources, space: f.space, segment: 'MINING', from: m.from, to: m.to });
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
    mining_panel: panel.manifest, started_at: startedAt, finished_at: now() };
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
  const dir = runDir(outDir, roundId);
  need(!fs.existsSync(path.join(dir, 'selection.json')), 'SELECTION_EXISTS', roundId);
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
  return out;
}

/**
 * 留出段目录的核对（开 holdout-vault 之前，不读行情）：SHA256SUMS 的 sha 等于封存的；或者有 SHA256SUMS.sealed 等于封存的、且它的每一行
 * 都原样在现在的 SHA256SUMS 里（补导只许追加）。交易日历要到留出段终点（12-31 的数据进来之前不打分）。
 */
function verifyHoldoutDir(roundId, dir) {
  const seal = vault.sealOf(roundId);
  need(seal, 'NOT_SEALED', roundId);
  need(dir && fs.existsSync(path.join(dir, 'SHA256SUMS')), 'HOLDOUT_DIR_INVALID', dir);
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'));
  if (sha256(sums) !== seal.data_sha256) {
    const sealedFile = path.join(dir, 'SHA256SUMS.sealed');
    need(fs.existsSync(sealedFile) && sha256(fs.readFileSync(sealedFile)) === seal.data_sha256, 'HOLDOUT_SHA_MISMATCH', roundId);
    const now1 = new Set(sums.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean));
    const lost = fs.readFileSync(sealedFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !now1.has(l));
    need(!lost.length, 'HOLDOUT_SEALED_FILES_CHANGED', lost.length);
  }
  const src = adapter.csvDirSource(dir, { mode: 'LIVE', label: 'holdout', holdout: true });
  let last = '';
  src.forEach('calendar', (row) => { if (row.calendar_date > last) last = row.calendar_date; });
  need(last >= seal.segment.to, 'HOLDOUT_INCOMPLETE', `${last}<${seal.segment.to}`);
  return { seal_hash: seal.record_hash, data_sha256: seal.data_sha256, calendar_to: last, source: src };
}

/**
 * 第 6–8 步：核留出段目录 → holdout-vault.open（每轮一次）→ 只经 holdout-scoring 打分 → 每个候选 recordGateResult。
 * 没有候选过验证折：不开留出段，返回 { opened: false }（关轮记 0）。
 */
function scoreHoldout({ roundId, sources, holdoutDir, outDir, scoredAt = null }) {
  for (const s of sources) need(!s.holdout, 'HOLDOUT_PASSED_AS_SOURCE', s.label);
  const dir = runDir(outDir, roundId);
  const selFile = path.join(dir, 'selection.json');
  need(fs.existsSync(selFile), 'SELECTION_MISSING', roundId);
  const selection = JSON.parse(fs.readFileSync(selFile, 'utf8'));
  need(selection.round_id === roundId, 'SELECTION_ROUND_MISMATCH', selection.round_id);
  if (!selection.selected.length) { writeJson(path.join(dir, 'score.json'), { schema: 'MINING_RUNNER_SCORE_V1', round_id: roundId, opened: false, records: [] }); return { opened: false, records: [] }; }
  const checked = verifyHoldoutDir(roundId, holdoutDir);
  const opened = vault.open({ round_id: roundId, candidate_ids: [...selection.selected], openedBy: RUNNER_ID });
  const f = loadFrozenSpace();
  const panel = adapter.buildPanel({ sources: [...sources, checked.source], space: f.space, segment: 'HOLDOUT', from: segs.SEGMENTS.MINING.from, to: segs.SEGMENTS.HOLDOUT.to });
  const byId = new Map(selection.candidates.map((c) => [c.candidate_id, c]));
  const stamp = scoredAt || new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');
  const results = holdoutScoring.roundResults(opened.candidate_ids.map((id) => ({ candidate_id: id, formula: byId.get(id).formula, parsed: dsl.parse(byId.get(id).formula, f.dslSpace) })),
    panel, { holding_period: f.holdingPeriod, market: MARKET, familyTrialCount: rounds.familyN(MARKET, f.holdingPeriod), scoredAt: stamp });
  const records = results.map((res) => gateRecords.recordGateResult({ round_id: roundId, candidate_id: res.candidate_id, candidate: res }));
  writeJson(path.join(dir, 'score.json'), { schema: 'MINING_RUNNER_SCORE_V1', round_id: roundId, opened: true, holdout: { seal_hash: checked.seal_hash, data_sha256: checked.data_sha256,
    calendar_to: checked.calendar_to }, holdout_panel: panel.manifest, results, records: records.map((x) => ({ candidate_id: x.candidate_id, pass: x.pass, codes: x.codes, record_hash: x.record_hash })) });
  return { opened: true, records };
}

/** 第 9 步：关轮（过了几个由记录数出来）。 */
const close = ({ roundId, closedAt = null }) => rounds.closeRound(roundId, { closedAt });

/** 只给测试用：临时换冻结输入的期望 sha（核对不上必须拒绝），回调结束还原。 */
function withFrozenInputs(patch, cb) { const prior = frozenInputs; frozenInputs = { ...frozenInputs, ...patch }; try { return cb(); } finally { frozenInputs = prior; } }

/** 只给测试用：临时换生成方（合成的尝试序列），回调结束还原。 */
function withGenerator(gen, cb) { const prior = generatorOverride; generatorOverride = gen; try { return cb(); } finally { generatorOverride = prior; } }

module.exports = {
  MARKET, RUNNER_ID, FROZEN_INPUTS, RunnerError, start, loadFrozenSpace, requestRound, sealHoldout, generate, select, verifyHoldoutDir, scoreHoldout, close, scoredAttempts,
  internals: { withGenerator, withFrozenInputs, attemptId },
};
