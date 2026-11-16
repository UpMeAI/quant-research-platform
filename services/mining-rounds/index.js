'use strict';

/**
 * 挖掘轮次 MINING_ROUND_V1（研究框架修订 2026-11-16，签字 fd22876f / 39f8c17c，§3.3、§3.4；§8.3 第 8、9 条；P1）。QRP 这一侧的正门：
 * 沙箱进程本身不写台账（services/mining-sandbox/isolation.js），轮次清单、候选的试验台账行、轮次的开与关都经这里写。
 *
 *   开轮（冻结的轮次清单 = 预登记）：搜索空间 sha（MINING_SPACE_V1，带冻结页）、生成方式（大模型写模型名与知识截止日；遗传规划写种子）、
 *     本轮上限 200、留出段起止（第一轮冻结，以后各轮不能挪）。
 *     - 留出段的起点不晚于所用大模型的知识截止日 → MINE_ROUND_HOLDOUT_BEFORE_CUTOFF；
 *     - 同一市场同一个月（北京时间）已开 2 轮 → MINE_ROUND_MONTHLY_CAP；同一市场有没关的轮 → MINE_ROUND_ALREADY_OPEN；
 *     - 连续 3 轮没有候选过 G-MINE → 暂停该市场（MINE_MARKET_PAUSED），直到用一份新的、不在那 3 轮里用过的冻结空间开轮。
 *   记候选：每个算过分的候选写一行试验台账（role MINED_CANDIDATE，stage SIGNAL，族 MINE:<市场>:H<持有期>，计入 N，从不按轮清零）；
 *     第 201 个不算分、不入账，本轮停止（MINE_ROUND_CAP_REACHED，状态 CAP_REACHED，不补）。去重被拒的、正交化的版本照样各记一行。
 *   关轮：写 G-MINE 过了几个（只给暂停规则用）。
 *   生成方能看到的（generatorView）：搜索空间、挖掘段分数、已试过的公式；看不到验证折、留出段、赛马、模拟盘的结果，也看不到 G-MINE 过没过。
 * 错误码 MINE_ROUND_* / MINE_MARKET_*；台账 research/mining_rounds.jsonl 与试验台账（只追加）。
 */
const crypto = require('crypto');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const { validateRecord } = require('../../schemas');
const trials = require('../trial-ledger');

const SCHEMA = 'MINING_ROUND_V1';
const LEDGER = () => path.join(dataDir('research'), 'mining_rounds.jsonl');
const MARKETS = Object.freeze(['CN_A', 'US', 'CRYPTO']);
const GENERATORS = Object.freeze(['AI_MINED_LLM', 'AI_MINED_GP']);
const LIMITS = Object.freeze({ candidates_per_round: 200, rounds_per_month: 2, pause_after_failed_rounds: 3 });
const SHA64 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

class MiningRoundError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new MiningRoundError(code, detail); };
const need = (c, code, detail) => { if (!c) fail(code, detail); };
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const monthCst = (iso) => new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 7);

function heads() { const m = new Map(); for (const r of read(LEDGER())) if (r.schema === SCHEMA) m.set(r.round_id, r); return m; }
const roundHead = (id) => heads().get(id) || null;
const roundsOf = (market) => [...heads().values()].filter((r) => r.market === market).sort((a, b) => (a.opened_at < b.opened_at ? -1 : 1));

function write(body) {
  const { record_hash: _h, ...rest } = body;
  const rec = { ...rest, record_hash: trials.recordHash(rest) };
  const v = validateRecord(rec, SCHEMA);
  need(v.ok, 'MINE_ROUND_SCHEMA_INVALID', v.problems.join(','));
  return append(LEDGER(), rec);
}

/** 市场是否暂停：最近连续 3 个已关的轮都没有候选过 G-MINE。返回那几轮用过的空间 sha（解除要换一份新的）。 */
function pauseState(market) {
  const closed = roundsOf(market).filter((r) => r.status === 'CLOSED');
  const tail = closed.slice(-LIMITS.pause_after_failed_rounds);
  const paused = tail.length === LIMITS.pause_after_failed_rounds && tail.every((r) => r.gmine_passes === 0);
  return { paused, failed_rounds: paused ? tail.map((r) => r.round_id) : [], spaces_used: paused ? [...new Set(tail.map((r) => r.space.sha256))] : [] };
}

/**
 * 开一轮（冻结的轮次清单）。
 * @param {object} o { market, space: { space_ref, sha256, freeze: { path, sha256 } }, holding_periods: [交易日…], generator: { mode, model?, model_knowledge_cutoff?, gp_seed? },
 *   holdout: { from, to }, cap?: ≤ 200, openedAt? }
 */
function openRound(o = {}) {
  need(MARKETS.includes(o.market), 'MINE_ROUND_MARKET_INVALID', o.market);
  need(isObj(o.space) && isText(o.space.space_ref) && SHA64.test(o.space.sha256 || '') && isObj(o.space.freeze) && isText(o.space.freeze.path) && SHA64.test(o.space.freeze.sha256 || ''),
    'MINE_ROUND_SPACE_NOT_FROZEN');
  need(Array.isArray(o.holding_periods) && o.holding_periods.length && o.holding_periods.every((h) => Number.isInteger(h) && h >= 1), 'MINE_ROUND_HOLDING_PERIODS_INVALID');
  const g = o.generator;
  need(isObj(g) && GENERATORS.includes(g.mode), 'MINE_ROUND_GENERATOR_INVALID');
  if (g.mode === 'AI_MINED_LLM') need(isText(g.model) && DATE.test(g.model_knowledge_cutoff || ''), 'MINE_ROUND_GENERATOR_INVALID', 'LLM needs model and model_knowledge_cutoff');
  else need(Number.isInteger(g.gp_seed), 'MINE_ROUND_GENERATOR_INVALID', 'GP needs gp_seed');
  need(isObj(o.holdout) && DATE.test(o.holdout.from || '') && DATE.test(o.holdout.to || '') && o.holdout.from <= o.holdout.to, 'MINE_ROUND_HOLDOUT_INVALID');
  if (g.mode === 'AI_MINED_LLM') need(o.holdout.from > g.model_knowledge_cutoff, 'MINE_ROUND_HOLDOUT_BEFORE_CUTOFF', `${o.holdout.from}<=${g.model_knowledge_cutoff}`);
  const cap = o.cap === undefined ? LIMITS.candidates_per_round : o.cap;
  need(Number.isInteger(cap) && cap >= 1 && cap <= LIMITS.candidates_per_round, 'MINE_ROUND_CAP_INVALID', cap);
  const openedAt = o.openedAt || now();
  const prior = roundsOf(o.market);
  // 留出段第一轮之前冻结，以后不能挪作挖掘段或验证折
  if (prior.length) need(prior[0].holdout.from === o.holdout.from && prior[0].holdout.to === o.holdout.to, 'MINE_ROUND_HOLDOUT_MOVED', `${prior[0].holdout.from}..${prior[0].holdout.to}`);
  need(prior.every((r) => r.status === 'CLOSED'), 'MINE_ROUND_ALREADY_OPEN', o.market);
  const month = monthCst(openedAt);
  need(prior.filter((r) => r.month === month).length < LIMITS.rounds_per_month, 'MINE_ROUND_MONTHLY_CAP', `${o.market}:${month}`);
  const pause = pauseState(o.market);
  if (pause.paused) need(!pause.spaces_used.includes(o.space.sha256), 'MINE_MARKET_PAUSED', `${o.market}:${pause.failed_rounds.join(',')}`);
  const body = {
    schema: SCHEMA, round_id: `MR-${o.market}-${month}-${sha256(`${o.market}|${openedAt}|${o.space.sha256}`).slice(0, 10)}`, market: o.market, month,
    space: { space_ref: o.space.space_ref, sha256: o.space.sha256, freeze: { path: o.space.freeze.path, sha256: o.space.freeze.sha256 } },
    holding_periods: [...o.holding_periods], family_ids: o.holding_periods.map((h) => `MINE:${o.market}:H${h}`),
    generator: { mode: g.mode, model: g.model || null, model_knowledge_cutoff: g.model_knowledge_cutoff || null, gp_seed: g.mode === 'AI_MINED_GP' ? g.gp_seed : null },
    holdout: { from: o.holdout.from, to: o.holdout.to }, cap, resumed_after_pause: pause.paused ? pause.failed_rounds : [],
    status: 'OPEN', candidates_scored: 0, gmine_passes: null, opened_at: openedAt, closed_at: null,
  };
  return write(body);
}

/** 本轮的清单 sha（预登记：候选的试验台账行把它写成 k2_sha256）。 */
const manifestSha = (round) => trials.recordHash({ ...round, status: 'OPEN', candidates_scored: 0, gmine_passes: null, closed_at: null, record_hash: undefined });

/**
 * 记一个算过分的候选：写一行试验台账（MINED_CANDIDATE）。到上限即停：第 cap + 1 个不入账，本轮转 CAP_REACHED。
 * @param {object} c { candidate_id, formula_canonical, formula_sha256, holding_period, mining_score, rule_config? }
 */
function recordCandidate(roundId, c = {}, { registeredBy, registeredAt = null } = {}) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  if (r.status === 'CAP_REACHED') fail('MINE_ROUND_CAP_REACHED', `${roundId}:${r.candidates_scored}`);
  need(r.status === 'OPEN', 'MINE_ROUND_NOT_OPEN', `${roundId}:${r.status}`);
  need(isText(c.candidate_id) && isText(c.formula_canonical) && c.formula_sha256 === sha256(c.formula_canonical), 'MINE_ROUND_CANDIDATE_INVALID', c.candidate_id);
  need(r.holding_periods.includes(c.holding_period), 'MINE_ROUND_HOLDING_PERIOD_NOT_IN_ROUND', `${c.candidate_id}:${c.holding_period}`);
  if (r.candidates_scored >= r.cap) { write({ ...r, status: 'CAP_REACHED' }); fail('MINE_ROUND_CAP_REACHED', `${roundId}:${r.candidates_scored}`); }
  const [row] = trials.register([{
    family_id: `MINE:${r.market}:H${c.holding_period}`, market: r.market, study_ref: roundId, config_label: c.candidate_id, stage: 'SIGNAL', role: 'MINED_CANDIDATE',
    k2_sha256: manifestSha(r), rule_config: c.rule_config || { formula: c.formula_canonical, holding_period: c.holding_period, space_sha256: r.space.sha256 },
    mining: { round_id: roundId, candidate_id: c.candidate_id, space_sha256: r.space.sha256, formula_sha256: c.formula_sha256, generator: r.generator.mode },
    metrics: { mining_segment_score: typeof c.mining_score === 'number' ? c.mining_score : null },
  }], { mode: 'PREREGISTERED', registeredBy, registeredAt: registeredAt || now() }); // registeredBy = 产品里程碑权限（同试验台账）
  const next = r.candidates_scored + 1;
  write({ ...r, candidates_scored: next, status: next >= r.cap ? 'CAP_REACHED' : 'OPEN' });
  return row;
}

/** 留出段开启（services/holdout-vault 调用）：本轮生成结束，转 SCORING，之后不能再记候选。 */
function beginScoring(roundId) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  need(r.status === 'OPEN' || r.status === 'CAP_REACHED', 'MINE_ROUND_NOT_OPEN', `${roundId}:${r.status}`);
  return write({ ...r, status: 'SCORING' });
}

/** 关轮：写 G-MINE 过了几个（只给暂停规则用；生成方看不到）。 */
function closeRound(roundId, { gmine_passes: passes, closedAt = null } = {}) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  need(['OPEN', 'CAP_REACHED', 'SCORING'].includes(r.status), 'MINE_ROUND_NOT_OPEN', `${roundId}:${r.status}`);
  need(Number.isInteger(passes) && passes >= 0 && passes <= r.candidates_scored, 'MINE_ROUND_PASSES_INVALID', passes);
  return write({ ...r, status: 'CLOSED', gmine_passes: passes, closed_at: closedAt || now() });
}

/** 本族累计 N（所有轮次，从不清零；口径同试验台账 count）。 */
const familyN = (market, holdingPeriod, opts = {}) => trials.count(`MINE:${market}:H${holdingPeriod}`, opts).n_raw;

/**
 * 生成方能看到的：搜索空间、挖掘段分数、已试过的公式（同市场所有轮次）。只从试验台账行的 mining 块与 metrics.mining_segment_score 取，
 * 不读验证折、留出段、赛马、模拟盘的任何结果，也不读 G-MINE 过没过（轮次行的 gmine_passes 不给出去）。
 */
function generatorView(roundId) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  const mine = [...trials.heads(trials.trialRows()).values()].filter((t) => t.role === 'MINED_CANDIDATE' && t.market === r.market && t.mining);
  return Object.freeze({
    round_id: r.round_id, market: r.market, space: { space_ref: r.space.space_ref, sha256: r.space.sha256 }, holding_periods: [...r.holding_periods],
    mining_scores: mine.filter((t) => t.mining.round_id === roundId).map((t) => ({ candidate_id: t.mining.candidate_id, formula: t.rule_config ? t.rule_config.formula : null,
      mining_segment_score: t.metrics ? t.metrics.mining_segment_score ?? null : null })),
    tried_formulas: [...new Set(mine.map((t) => (t.rule_config ? t.rule_config.formula : null)).filter(Boolean))].sort(),
  });
}

module.exports = { SCHEMA, LEDGER, MARKETS, GENERATORS, LIMITS, MiningRoundError, openRound, recordCandidate, beginScoring, closeRound, roundHead, roundsOf, pauseState, familyN, generatorView, manifestSha };
