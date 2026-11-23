'use strict';

/**
 * 挖掘轮次 MINING_ROUND_V1（研究框架修订 2026-11-16，签字 fd22876f / 39f8c17c，§3.3、§3.4；§8.3 第 8、9 条；P1）。QRP 这一侧的正门：
 * 沙箱进程本身不写台账（services/mining-sandbox/isolation.js），轮次清单、候选的试验台账行、轮次的开与关都经这里写。
 *
 *   开轮（冻结的轮次清单 = 预登记）：搜索空间 sha（MINING_SPACE_V1，带冻结页）、生成方式（大模型写模型名与知识截止日；遗传规划写种子）、
 *     本轮上限 200、留出段起止（第一轮冻结，以后各轮不能挪）。
 *     - 留出段的起点不晚于所用大模型的知识截止日 → MINE_ROUND_HOLDOUT_BEFORE_CUTOFF；
 *     - 同一市场同一个月（北京时间）已开 2 轮 → MINE_ROUND_MONTHLY_CAP（唯一例外：CN_A 2026-11 是 3 轮，MONTHLY_CAP_EXCEPTIONS）；同一市场有没关的轮 → MINE_ROUND_ALREADY_OPEN；
 *     - 连续 3 轮没有候选过 G-MINE → 暂停该市场（MINE_MARKET_PAUSED），直到用一份新的、不在那 3 轮里用过的冻结空间开轮。
 *   记候选：每个算过分的候选写一行试验台账（role MINED_CANDIDATE，stage SIGNAL，族 MINE:<市场>:H<持有期>，计入 N，从不按轮清零）；
 *     第 201 个不算分、不入账，本轮停止（MINE_ROUND_CAP_REACHED，状态 CAP_REACHED，不补）。去重被拒的、正交化的版本照样各记一行。
 *   关轮：G-MINE 过了几个由逐候选的 G-MINE 记录数出来（./gate-records.js；不收调用方报的数），只给暂停规则用。
 *   失败终态（裁定 R1.8、R1.12）：FAILED_RESCORE、FAILED_PARTIAL，都按 0 个通过、记录标 VOID、尝试留在 N、释放名额、留出段开启照旧计数。
 *   FAILED_EVALUATION（★RF1116_ROUND1_STATE (a)，2026-11-18）：留出段从未开启、本轮根本没算出分（第 1 轮缺陷）→ 0 个通过、尝试留在 N、释放名额、计入当月轮数。
 *   大模型生成方的计量（RF1116 LLM_GEN）：每次调用写一行 MINING_LLM_CALL_V1（用量、计入本轮 token 上限的数、模型名与版本、等待 / 停止的原因），清单的 generator.llm 冻结本轮的 token 与调用次数上限和配置 sha。
 *   生成方能看到的（generatorView）：搜索空间、挖掘段分数、已试过的公式；看不到验证折、留出段、赛马、模拟盘的结果，也看不到 G-MINE 过没过。
 * 错误码 MINE_ROUND_* / MINE_MARKET_*；台账 research/mining_rounds.jsonl 与试验台账（只追加）。
 */
const crypto = require('crypto');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const { validateRecord } = require('../../schemas');
const trials = require('../trial-ledger');
const { NEW_ROUND_NEUTRALIZATION, legacyForTests } = require('./neutralization');
const holdoutSegments = require('./holdout-segments');

const SCHEMA = 'MINING_ROUND_V1';
const LEDGER = () => path.join(dataDir('research'), 'mining_rounds.jsonl');
const SELECTION_SCHEMA = 'MINING_SELECTION_V1';
const SELECTIONS = () => path.join(dataDir('research'), 'mining_selections.jsonl');
const MARKETS = Object.freeze(['CN_A', 'US', 'CRYPTO']);
const GENERATORS = Object.freeze(['AI_MINED_LLM', 'AI_MINED_GP']);
/**
 * 上限（签字 §3.3 ★b；协调会话裁定 R1.6，ce254328…）：每轮 200 个尝试；每市场每月 ≤ 2 轮；连续 3 轮没过 G-MINE 暂停；
 * 每个市场最多同时开 2 个没关的轮（第一次打分之前，两轮只生成、各等自己那一次留出段开启）；一段留出段最多给 2 轮用，第 3 轮起要新段（整段在旧段之后）。
 */
const LIMITS = Object.freeze({ candidates_per_round: 200, rounds_per_month: 2, pause_after_failed_rounds: 3, open_rounds_per_market: 2, rounds_per_holdout: 2 });
/**
 * 每月上限的例外（RF1116 修订 2026-11「A 股加一轮 LLM 挖掘」§1.1，Owner 11-22「选b」）：只有 (CN_A, 2026-11)（北京时间）是 3 轮；12 月起、别的市场不变（LIMITS.rounds_per_month）。
 * 页引用：path 是协调目录里的页，sha256 是它的字节，repo_copy 是仓库里的逐字节副本（tests/mining_cna_extra_round.test.js 核副本与 sha 一致）。
 * 引的是冻结页 RF1116_AMENDMENT_2026_11_CN_A_EXTRA_ROUND_FREEZE_1（plan-coord，2026-11-22 17:16 CST，Owner 确认后冻结）；副本在 docs/freeze/，
 * 并在 tests/mining_gate_freeze.test.js 的 FROZEN_COPIES 名单里（那里只放冻结页）。
 */
const MONTHLY_CAP_EXCEPTIONS = Object.freeze([Object.freeze({
  market: 'CN_A', month: '2026-11', rounds_per_month: 3,
  amendment: Object.freeze({ path: 'artifacts/coordinator/RF1116_AMENDMENT_2026_11_CN_A_EXTRA_ROUND_FREEZE_1.md', sha256: '14c9ad6ddebdfc1ddabd893fb11b126c9b32eba1623d4e83160e0c3c54572fc1',
    repo_copy: 'docs/freeze/RF1116_AMENDMENT_2026_11_CN_A_EXTRA_ROUND_FREEZE_1.md' }),
})]);
const monthlyCapOf = (market, month) => {
  const x = MONTHLY_CAP_EXCEPTIONS.find((e) => e.market === market && e.month === month);
  return x ? x.rounds_per_month : LIMITS.rounds_per_month;
};
/** 裁定页的仓库副本放在这里（车道上照它核，不读协调目录）。 */
const FREEZE_DIR = path.join(__dirname, '..', '..', 'docs', 'freeze');
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
const fsx = require('fs');
/**
 * 清单里的 rulings（R1.2）：每条 { path（协调目录里的裁定页）, sha256 }，仓库 docs/freeze/ 下要有同名的逐字节副本，sha 对得上。
 */
function checkRulings(list) {
  need(Array.isArray(list) && list.length, 'MINE_ROUND_RULINGS_REQUIRED');
  return list.map((x) => {
    need(isObj(x) && isText(x.path) && SHA64.test(x.sha256 || ''), 'MINE_ROUND_RULING_COPY_INVALID', JSON.stringify(x));
    const copy = path.join(FREEZE_DIR, path.basename(x.path));
    need(fsx.existsSync(copy) && sha256(fsx.readFileSync(copy)) === x.sha256, 'MINE_ROUND_RULING_COPY_INVALID', `${x.path}:${path.basename(x.path)}`);
    return { path: x.path, sha256: x.sha256 };
  });
}
/**
 * 清单里的验证折选择规则（R1.2：冻结进清单，作为数据；轮中不改，要改就是新的一轮）：VALIDATION_SELECTION_V1，
 * folds = 按日期升序、不重叠的 { fold, from, to }；mean_ic_gt、mining_score_gt 是数；positive_folds_min 是 1 … 折数的整数。
 */
function checkSelectionRule(rule) {
  need(rule !== undefined && rule !== null, 'MINE_ROUND_SELECTION_RULE_REQUIRED');
  const okFolds = isObj(rule) && Array.isArray(rule.folds) && rule.folds.length > 0 && rule.folds.every((f, k) => isObj(f) && f.fold === k + 1 && DATE.test(f.from || '') && DATE.test(f.to || '')
    && f.from <= f.to && (k === 0 || rule.folds[k - 1].to < f.from));
  need(isObj(rule) && rule.schema === 'VALIDATION_SELECTION_V1' && okFolds && typeof rule.mean_ic_gt === 'number' && Number.isFinite(rule.mean_ic_gt)
    && typeof rule.mining_score_gt === 'number' && Number.isFinite(rule.mining_score_gt) && Number.isInteger(rule.positive_folds_min)
    && rule.positive_folds_min >= 1 && rule.positive_folds_min <= rule.folds.length, 'MINE_ROUND_SELECTION_RULE_INVALID', JSON.stringify(rule).slice(0, 200));
  return JSON.parse(JSON.stringify(rule));
}
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

/**
 * 终态：CLOSED；R1.8 重打分又崩的 FAILED_RESCORE；R1.12 写了一部分 G-MINE 记录之后崩的 FAILED_PARTIAL。
 * 两个 FAILED_* 都按 0 个通过算（暂停规则把它们当「没过」的已关轮），都不占开轮名额，留出段的开启照旧计数。
 */
const TERMINAL = Object.freeze(['CLOSED', 'FAILED_RESCORE', 'FAILED_PARTIAL', 'FAILED_EVALUATION']);
const FAILED_TERMINAL = Object.freeze(['FAILED_RESCORE', 'FAILED_PARTIAL', 'FAILED_EVALUATION']);

/** 市场是否暂停：最近连续 3 个已关的轮都没有候选过 G-MINE。返回那几轮用过的空间 sha（解除要换一份新的）。 */
function pauseState(market) {
  const closed = roundsOf(market).filter((r) => TERMINAL.includes(r.status)); // R1.8 / R1.12：两种失败终态按「没过」算（gmine_passes 0）
  const tail = closed.slice(-LIMITS.pause_after_failed_rounds);
  const paused = tail.length === LIMITS.pause_after_failed_rounds && tail.every((r) => r.gmine_passes === 0);
  return { paused, failed_rounds: paused ? tail.map((r) => r.round_id) : [], spaces_used: paused ? [...new Set(tail.map((r) => r.space.sha256))] : [] };
}

/** 清单里的 generator.llm（LLM 轮）：配置文件的 sha 与本轮冻结的上限，都是数据；没带就不查（直接调 openRound 的合成轮）。 */
const LLM_BLOCK_KEYS = Object.freeze(['config_path', 'config_sha256', 'provider', 'served_version', 'release_date', 'tokens_per_round', 'calls_per_round', 'formulas_per_call', 'max_tokens']);
function checkLlmBlock(b) {
  if (b === undefined) return;
  need(isObj(b) && LLM_BLOCK_KEYS.every((k) => Object.prototype.hasOwnProperty.call(b, k)) && Object.keys(b).length === LLM_BLOCK_KEYS.length, 'MINE_ROUND_GENERATOR_INVALID', 'llm block keys');
  need(isText(b.config_path) && SHA64.test(b.config_sha256 || '') && isText(b.provider) && isText(b.served_version) && DATE.test(b.release_date || ''), 'MINE_ROUND_GENERATOR_INVALID', 'llm block');
  for (const k of ['tokens_per_round', 'calls_per_round', 'formulas_per_call', 'max_tokens']) need(Number.isInteger(b[k]) && b[k] >= 1, 'MINE_ROUND_GENERATOR_INVALID', `llm.${k}`);
}

/**
 * R1.6 的计数口径（RF1116 修订 2026-11 §1.2，协调会话裁定）：这一轮不占「一段留出段最多 2 轮用」的名额，当且仅当四项都成立——
 * 状态是 FAILED_EVALUATION；轮次行没有 holdout_opens；留出段保管里没有这一轮的开启记录；选择记录存在且写了 0 个候选。
 * 选择记录缺失是「未知」，不当 0 算（照旧计数）。其余状态（CLOSED、FAILED_PARTIAL、FAILED_RESCORE、没关的轮）一律计数。
 */
function excludedFromHoldoutCount(r) {
  if (r.status !== 'FAILED_EVALUATION' || r.holdout_opens) return false;
  if (require('../holdout-vault').openLog(r.round_id).length) return false;
  const sel = selectionOf(r.round_id);
  return sel !== null && Array.isArray(sel.selected) && sel.selected.length === 0;
}

/**
 * 登记表选的段能不能再开一轮（RF1116 第二段修订，holdout-segments.js）。失败关闭：选不到可用的段就不开，从不借别的段。
 *   - 台账里有一轮的窗口不在登记表里 → MINE_ROUND_HOLDOUT_SEGMENT_UNSELECTABLE（数不清用了几轮，不数）；
 *   - 已有更靠后的段的轮（往回开）→ MINE_ROUND_HOLDOUT_MOVED；
 *   - 这一段用满了 rounds_per_holdout 轮（计数口径同 excludedFromHoldoutCount）→ MINE_ROUND_HOLDOUT_EXHAUSTED:<段号>；
 *   - 这一段被开启过 → MINE_ROUND_HOLDOUT_SEGMENT_OPENED:<市场>:<段号>。
 */
function checkSegmentUsable(entry, prior, market) {
  const owned = prior.map((r) => ({ r, e: holdoutSegments.entryOfBlock(r.holdout) }));
  const stray = owned.find((x) => !x.e);
  need(!stray, 'MINE_ROUND_HOLDOUT_SEGMENT_UNSELECTABLE', `${market}:${stray && stray.r.round_id}: window is not in the registry`);
  need(!owned.some((x) => x.e.number > entry.number), 'MINE_ROUND_HOLDOUT_MOVED', `${entry.id}: a later segment already has rounds`);
  const mine = owned.filter((x) => x.e === entry).map((x) => x.r);
  need(mine.filter((r) => !excludedFromHoldoutCount(r)).length < LIMITS.rounds_per_holdout, 'MINE_ROUND_HOLDOUT_EXHAUSTED', entry.id);
  const vault = require('../holdout-vault');
  need(!mine.some((r) => r.holdout_opens || vault.openLog(r.round_id).length), 'MINE_ROUND_HOLDOUT_SEGMENT_OPENED', `${market}:${entry.id}`);
}

/**
 * 开一轮（冻结的轮次清单）。
 * @param {object} o { market, space: { space_ref, sha256, freeze: { path, sha256 } }, holding_periods: [交易日…], generator: { mode, model?, model_knowledge_cutoff?, gp_seed? },
 *   holdout?: { from, to }（不给 = 登记表按开轮月份选段，生产路径；给 = 旧路径，合成市场与测试）, cap?: ≤ 200, openedAt?, rulings: [{ path, sha256 }], selection_rule: VALIDATION_SELECTION_V1 }（后两项协调会话裁定 R1.2，每份清单必带）
 */
function openRound(o = {}) {
  need(MARKETS.includes(o.market), 'MINE_ROUND_MARKET_INVALID', o.market);
  need(isObj(o.space) && isText(o.space.space_ref) && SHA64.test(o.space.sha256 || '') && isObj(o.space.freeze) && isText(o.space.freeze.path) && SHA64.test(o.space.freeze.sha256 || ''),
    'MINE_ROUND_SPACE_NOT_FROZEN');
  need(Array.isArray(o.holding_periods) && o.holding_periods.length && o.holding_periods.every((h) => Number.isInteger(h) && h >= 1), 'MINE_ROUND_HOLDING_PERIODS_INVALID');
  const g = o.generator;
  need(isObj(g) && GENERATORS.includes(g.mode), 'MINE_ROUND_GENERATOR_INVALID');
  if (g.mode === 'AI_MINED_LLM') {
    need(isText(g.model) && DATE.test(g.model_knowledge_cutoff || ''), 'MINE_ROUND_GENERATOR_INVALID', 'LLM needs model and model_knowledge_cutoff');
    checkLlmBlock(g.llm); // 执行器开 LLM 轮要带 llm 块（配置 sha 与本轮上限）；别处直接开的合成轮（测试）可以不带
  } else need(Number.isInteger(g.gp_seed), 'MINE_ROUND_GENERATOR_INVALID', 'GP needs gp_seed');
  // 留出段（RF1116 第二段修订，holdout-segments.js）：不给窗口 = 登记表按开轮月份（北京时间）选段，选不到 → MINE_ROUND_HOLDOUT_SEGMENT_UNSELECTABLE；
  // 给窗口 = 旧路径（合成市场与测试），逐字不变。生产的 requestRound 不给窗口。
  const openedAt = o.openedAt || now();
  const month = monthCst(openedAt);
  const auto = o.holdout === undefined;
  const entry = auto ? holdoutSegments.entryForMonth(month, o.market) : null;
  if (auto) need(entry, 'MINE_ROUND_HOLDOUT_SEGMENT_UNSELECTABLE', `${o.market}:${month}`);
  const holdout = auto ? holdoutSegments.holdoutOf(entry) : o.holdout;
  if (!auto) need(isObj(holdout) && DATE.test(holdout.from || '') && DATE.test(holdout.to || '') && holdout.from <= holdout.to, 'MINE_ROUND_HOLDOUT_INVALID');
  if (g.mode === 'AI_MINED_LLM') need(holdoutSegments.startsAfter(holdout, g.model_knowledge_cutoff), 'MINE_ROUND_HOLDOUT_BEFORE_CUTOFF', `${holdout.from}<=${g.model_knowledge_cutoff}`);
  const cap = o.cap === undefined ? LIMITS.candidates_per_round : o.cap;
  need(Number.isInteger(cap) && cap >= 1 && cap <= LIMITS.candidates_per_round, 'MINE_ROUND_CAP_INVALID', cap);
  const rulings = checkRulings(o.rulings);
  // 版本：新开的轮只能是 RANK_GAUSS_V2（不给就是它）；LINEAR_RAW_V1 只在测试的环境开关下认（neutralization.js 的 legacyForTests），生产没有这个口子
  need(o.scoring_neutralization === undefined || o.scoring_neutralization === NEW_ROUND_NEUTRALIZATION || (o.scoring_neutralization === 'LINEAR_RAW_V1' && legacyForTests()), 'MINE_ROUND_NEUTRALIZATION_INVALID', String(o.scoring_neutralization));
  const selectionRule = checkSelectionRule(o.selection_rule);
  const prior = roundsOf(o.market);
  // 留出段（R1.6）：一段最多给 rounds_per_holdout 轮用；要么沿用最新那一段（还没用满），要么换一段整段在以前各段之后的新段；
  // 其余（重叠、往前挪）一律 MINE_ROUND_HOLDOUT_MOVED，用满了 MINE_ROUND_HOLDOUT_EXHAUSTED。
  // 修订 4 写明本意：共用只限这一段第一次被开启之前；这个市场里任何一轮开启过这一段（轮次行有 holdout_opens，或留出段保管有开启记录），
  // 就不再在这一段上开新轮 → MINE_ROUND_HOLDOUT_SEGMENT_OPENED。没开启留出段就关的轮不算开启。
  if (auto) checkSegmentUsable(entry, prior, o.market);
  else if (prior.length) {
    // 台账里已有登记表选的段（带段号的行）：窗口只会来自登记表，不再接受调用方给的窗口（失败关闭，不拿窗口凑）
    need(!prior.some((r) => r.holdout && r.holdout.segment !== undefined), 'MINE_ROUND_HOLDOUT_SEGMENT_UNSELECTABLE', `${o.market}: explicit window after registry segments`);
    const same = (h) => h.from === o.holdout.from && h.to === o.holdout.to;
    const latest = prior[prior.length - 1].holdout;
    const lastEnd = prior.reduce((m, r) => (r.holdout.to > m ? r.holdout.to : m), '');
    if (same(latest)) {
      const sharing = prior.filter((r) => same(r.holdout));
      // 计数口径（RF1116 修订 2026-11 §1.2）：没有评价过的轮不占这一段的 2 轮（见 excludedFromHoldoutCount）；MINE_ROUND_HOLDOUT_SEGMENT_OPENED 仍看 sharing 里的每一轮
      need(sharing.filter((r) => !excludedFromHoldoutCount(r)).length < LIMITS.rounds_per_holdout, 'MINE_ROUND_HOLDOUT_EXHAUSTED', `${latest.from}..${latest.to}`);
      const vault = require('../holdout-vault');
      need(!sharing.some((r) => r.holdout_opens || vault.openLog(r.round_id).length), 'MINE_ROUND_HOLDOUT_SEGMENT_OPENED', `${o.market}:${latest.from}..${latest.to}`);
    } else need(o.holdout.from > lastEnd, 'MINE_ROUND_HOLDOUT_MOVED', `${o.holdout.from}..${o.holdout.to} vs ${latest.from}..${latest.to}`);
  }
  const stillOpen = prior.filter((r) => !TERMINAL.includes(r.status)).length;
  need(stillOpen < LIMITS.open_rounds_per_market, 'MINE_ROUND_ALREADY_OPEN', `${o.market}:${stillOpen}`);
  need(prior.filter((r) => r.month === month).length < monthlyCapOf(o.market, month), 'MINE_ROUND_MONTHLY_CAP', `${o.market}:${month}`);
  const pause = pauseState(o.market);
  if (pause.paused) need(!pause.spaces_used.includes(o.space.sha256), 'MINE_MARKET_PAUSED', `${o.market}:${pause.failed_rounds.join(',')}`);
  const body = {
    schema: SCHEMA, round_id: `MR-${o.market}-${month}-${sha256(`${o.market}|${openedAt}|${o.space.sha256}`).slice(0, 10)}`, market: o.market, month,
    space: { space_ref: o.space.space_ref, sha256: o.space.sha256, freeze: { path: o.space.freeze.path, sha256: o.space.freeze.sha256 } },
    holding_periods: [...o.holding_periods], family_ids: o.holding_periods.map((h) => `MINE:${o.market}:H${h}`),
    generator: { mode: g.mode, model: g.model || null, model_knowledge_cutoff: g.model_knowledge_cutoff || null, gp_seed: g.mode === 'AI_MINED_GP' ? g.gp_seed : null,
      ...(g.mode === 'AI_MINED_LLM' && g.llm !== undefined ? { llm: JSON.parse(JSON.stringify(g.llm)) } : {}) },
    holdout: auto ? JSON.parse(JSON.stringify(holdout)) : { from: o.holdout.from, to: o.holdout.to }, cap, resumed_after_pause: pause.paused ? pause.failed_rounds : [], rulings, selection_rule: selectionRule, holdout_opens: null,
    scoring_neutralization: o.scoring_neutralization === undefined ? NEW_ROUND_NEUTRALIZATION : o.scoring_neutralization, // 修订 SIZE_V2 N2：新开的轮一律 RANK_GAUSS_V2（第 1、2 轮在 neutralization.js 的名单里）
    status: 'OPEN', candidates_scored: 0, gmine_passes: null, gmine_basis: null, opened_at: openedAt, closed_at: null,
    data_checks: isObj(o.data_checks) ? JSON.parse(JSON.stringify(o.data_checks)) : null, // 执行器开轮前做过的数据核对（覆盖下限，压低了也照实写）
  };
  return write(body);
}

/** 本轮的清单 sha（预登记：候选的试验台账行把它写成 k2_sha256）。 */
const manifestSha = (round) => trials.recordHash({ ...round, status: 'OPEN', candidates_scored: 0, gmine_passes: null, gmine_basis: null, closed_at: null, holdout_opens: null, record_hash: undefined });

/**
 * 记一个算过分的候选：写一行试验台账（MINED_CANDIDATE）。到上限即停：第 cap + 1 个不入账，本轮转 CAP_REACHED。
 * @param {object} c { candidate_id, formula_canonical, formula_sha256, holding_period, mining_score, rule_config? }
 */
const ATTEMPTS = Object.freeze(['PARSE_REFUSED', 'DEDUPED', 'UNSCORABLE']);
function recordCandidate(roundId, c = {}, { registeredBy, registeredAt = null } = {}) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  // 入口（复审 L-1，第 1 轮缺陷之后）：没有 attempt 标记的必须是有限分数；带标记的只能是登记的三种，分数必须是 null
  const attempt = c.rule_config ? c.rule_config.attempt : undefined;
  if (attempt === undefined) need(typeof c.mining_score === 'number' && Number.isFinite(c.mining_score), 'MINE_ROUND_SCORE_NOT_FINITE', `${roundId}:${c.candidate_id}`);
  else {
    need(ATTEMPTS.includes(attempt), 'MINE_ROUND_ATTEMPT_UNKNOWN', `${c.candidate_id}:${attempt}`);
    need(c.mining_score === null || c.mining_score === undefined, 'MINE_ROUND_ATTEMPT_HAS_SCORE', `${c.candidate_id}:${attempt}`);
  }
  need(!selectionOf(roundId), 'MINE_ROUND_GENERATION_CLOSED', `${roundId}: validation-fold selection recorded`);
  if (r.status === 'CAP_REACHED') fail('MINE_ROUND_CAP_REACHED', `${roundId}:${r.candidates_scored}`);
  need(r.status === 'OPEN', 'MINE_ROUND_NOT_OPEN', `${roundId}:${r.status}`);
  need(isText(c.candidate_id) && isText(c.formula_canonical) && c.formula_sha256 === sha256(c.formula_canonical), 'MINE_ROUND_CANDIDATE_INVALID', c.candidate_id);
  // 候选编号全局唯一：<轮次编号>:<本轮编号>（K2 正文按记号边界扫它，协调会话裁定 2）
  need(c.candidate_id.startsWith(`${roundId}:`) && /^[A-Za-z0-9_:-]+$/.test(c.candidate_id) && c.candidate_id.length > roundId.length + 1, 'MINE_ROUND_CANDIDATE_ID_FORMAT', c.candidate_id);
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

/** 本轮的验证折选择记录（只追加，每轮一行；没有 → null）。 */
const selectionOf = (roundId) => read(SELECTIONS()).find((x) => x.schema === SELECTION_SCHEMA && x.round_id === roundId) || null;

/**
 * 记本轮的验证折选择（独立复审 2026-11-17：不信输出目录里的 selection.json）：一轮一行、只追加，写选择文件的 sha256 和过了验证折的候选编号。
 * 写了之后本轮不能再记候选（MINE_ROUND_GENERATION_CLOSED）；留出段只开这里写的候选，公式取试验台账行。
 * 候选必须是本轮算过分的尝试（不是解析被拒、去重被拒的），每个只写一次。
 * @param {{selection_sha256: string, selected: string[], evaluated: number, rule?: object}} sel
 */
function recordSelection(roundId, sel = {}, { recordedAt = null } = {}) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  need(r.status === 'OPEN' || r.status === 'CAP_REACHED', 'MINE_ROUND_NOT_SELECTABLE', `${roundId}:${r.status}`);
  need(!selectionOf(roundId), 'MINE_ROUND_SELECTION_EXISTS', roundId);
  need(SHA64.test(sel.selection_sha256 || '') && Array.isArray(sel.selected) && Number.isInteger(sel.evaluated) && sel.evaluated >= sel.selected.length, 'MINE_ROUND_SELECTION_INVALID', roundId);
  need(new Set(sel.selected).size === sel.selected.length, 'MINE_ROUND_SELECTION_INVALID', `${roundId}:duplicate`);
  const scored = new Set([...trials.heads(trials.trialRows()).values()].filter((t) => t.role === 'MINED_CANDIDATE' && t.mining && t.mining.round_id === roundId
    && t.rule_config && t.rule_config.attempt === undefined && t.metrics && typeof t.metrics.mining_segment_score === 'number').map((t) => t.mining.candidate_id));
  for (const id of sel.selected) need(scored.has(id), 'MINE_ROUND_SELECTION_CANDIDATE_INVALID', `${roundId}:${id}`);
  const body = { schema: SELECTION_SCHEMA, round_id: roundId, market: r.market, manifest_sha256: manifestSha(r), selection_sha256: sel.selection_sha256,
    selected: [...sel.selected], evaluated: sel.evaluated, rule: sel.rule || null, recorded_at: recordedAt || now() };
  const rec = { ...body, record_hash: trials.recordHash(body) };
  const v = validateRecord(rec, SELECTION_SCHEMA);
  need(v.ok, 'MINE_ROUND_SCHEMA_INVALID', v.problems.join(','));
  return append(SELECTIONS(), rec);
}

/**
 * 留出段开启（services/holdout-vault 调用）：本轮生成结束，转 SCORING，之后不能再记候选。
 * holdoutOpens（R1.6）：这段留出段在本族（同市场）里被开了第几次（含这一次），写进轮次记录并一直带到关轮。
 */
function beginScoring(roundId, { holdoutOpens = null } = {}) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  need(r.status === 'OPEN' || r.status === 'CAP_REACHED', 'MINE_ROUND_NOT_OPEN', `${roundId}:${r.status}`);
  return write({ ...r, status: 'SCORING', holdout_opens: holdoutOpens });
}

/**
 * 关轮（协调会话裁定 3）：「过了几个」不是参数——从本轮逐候选的 G-MINE 记录（./gate-records.js）数出来，过 = 九项全过。
 * 开过留出段的候选只要有一个没有记录 → MINE_ROUND_GMINE_RESULT_MISSING，不许关。没开留出段就关的轮，没有候选到过 G-MINE，记 0。
 * 只给暂停规则用；生成方看不到。
 */
function closeRound(roundId, opts = {}) {
  need(!Object.prototype.hasOwnProperty.call(opts, 'gmine_passes'), 'MINE_ROUND_GMINE_PASSES_NOT_A_PARAMETER', roundId);
  const { closedAt = null } = opts;
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  need(['OPEN', 'CAP_REACHED', 'SCORING'].includes(r.status), 'MINE_ROUND_NOT_OPEN', `${roundId}:${r.status}`);
  const [open] = require('../holdout-vault').openLog(roundId);
  let passes = 0; let basis = { holdout_open_hash: null, records: 0, record_hashes: [] };
  if (open) {
    const recs = require('./gate-records').recordsOf(roundId);
    const byCandidate = new Map(recs.map((x) => [x.candidate_id, x]));
    const missing = open.candidate_ids.filter((id) => !byCandidate.has(id));
    need(!missing.length, 'MINE_ROUND_GMINE_RESULT_MISSING', `${roundId}:${missing.length}`);
    const used = open.candidate_ids.map((id) => byCandidate.get(id));
    passes = used.filter((x) => x.pass === true).length;
    basis = { holdout_open_hash: open.record_hash, records: used.length, record_hashes: used.map((x) => x.record_hash) };
  }
  return write({ ...r, status: 'CLOSED', gmine_passes: passes, gmine_basis: basis, closed_at: closedAt || now() });
}

/**
 * 协调会话裁定 R1.8：重打分（RESCORE_SAME_SELECTION）之后又崩 → 以 FAILED_RESCORE 关轮：不算任何 G-MINE 记录（gmine_passes 0、basis 不收记录），
 * 本轮的尝试照旧在试验台账里、照旧计入 N；暂停规则把它当「没过」。只有 holdout-vault 记过一次重打分、轮次还在 SCORING 才能这样关。
 */
function failRescore(roundId, { reason, logSha256 = null, failedAt = null } = {}) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  need(r.status === 'SCORING', 'MINE_ROUND_NOT_SCORING', `${roundId}:${r.status}`);
  const vault = require('../holdout-vault');
  const [open] = vault.openLog(roundId);
  need(open && vault.rescoreLog(roundId).length === 1, 'MINE_ROUND_FAILED_RESCORE_WITHOUT_RESCORE', roundId);
  const gateRecords = require('./gate-records');
  const partial = gateRecords.recordsOf(roundId).length;
  const row = write({ ...r, status: 'FAILED_RESCORE', gmine_passes: 0,
    gmine_basis: { holdout_open_hash: open.record_hash, records: 0, record_hashes: [], failed_rescore: { reason: String(reason || ''), log_sha256: logSha256, partial_records_ignored: partial } },
    closed_at: failedAt || now() });
  // 重打分时写下的部分记录同样标 VOID（不计数；轮次行先写，读法对 FAILED_* 的轮本来就不返回记录）
  gateRecords.voidRecords(roundId, { roundStatus: 'FAILED_RESCORE', reason: String(reason || ''), ruling: 'R1.8' });
  return row;
}

/**
 * 协调会话裁定 R1.12（修订 4）：留出段开启之后、已经写下一部分 G-MINE 记录（至少一条、没写完）时崩溃 → 以 FAILED_PARTIAL 关轮。
 *   只能从 SCORING 进入，写明崩溃原因；本轮按 0 个通过计（gmine_basis 不收记录）；已写的记录保留原行，另记 VOID（./gate-records.js voidRecords），任何统计都不算；
 *   本轮的尝试照旧在试验台账里、计入 N；释放开轮名额（终态）；留出段的开启照旧计数（开启记录与 holdout_opens 不动）。
 *   一条记录都没写 → R1.8 的重打分（MINE_ROUND_FAILED_PARTIAL_NO_RECORDS）；全写完了 → 正常关轮（MINE_ROUND_FAILED_PARTIAL_COMPLETE）。
 */
function failPartial(roundId, { reason, logSha256 = null, failedAt = null } = {}) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  need(r.status === 'SCORING', 'MINE_ROUND_NOT_SCORING', `${roundId}:${r.status}`);
  need(isText(reason), 'MINE_ROUND_FAILED_PARTIAL_REASON', roundId);
  const [open] = require('../holdout-vault').openLog(roundId);
  need(open, 'MINE_ROUND_FAILED_PARTIAL_NO_RECORDS', `${roundId}: holdout not opened`);
  const gateRecords = require('./gate-records');
  const written = gateRecords.recordsOf(roundId);
  need(written.length > 0, 'MINE_ROUND_FAILED_PARTIAL_NO_RECORDS', `${roundId}: no G-MINE record written, R1.8 rescore applies`);
  need(written.length < open.candidate_ids.length, 'MINE_ROUND_FAILED_PARTIAL_COMPLETE', `${roundId}: every G-MINE record is written, close the round`);
  const row = write({ ...r, status: 'FAILED_PARTIAL', gmine_passes: 0,
    gmine_basis: { holdout_open_hash: open.record_hash, records: 0, record_hashes: [],
      failed_partial: { reason, log_sha256: logSha256, records_written: written.length, candidates_opened: open.candidate_ids.length,
        void_record_hashes: written.map((x) => x.record_hash), ruling: 'R1.12' } },
    closed_at: failedAt || now() });
  gateRecords.voidRecords(roundId, { roundStatus: 'FAILED_PARTIAL', reason, ruling: 'R1.12' });
  return row;
}

/**
 * 协调会话裁定 ★RF1116_ROUND1_STATE (a)（2026-11-18，第 1 轮 MR-CN_A-2026-11-e1ab63a27b）：本轮根本没被评估（例如每个候选的挖掘段分数都算不出），
 * 以 FAILED_EVALUATION 关轮。只追加一行，不改任何一行。
 *   - 只能从 OPEN / CAP_REACHED 进入，且留出段从未开启（轮次行没有 holdout_opens，留出段保管也没有开启记录）；
 *   - 必须写原因与证据（缺陷报告）的 sha256；本轮没有一个尝试算出有限分数（复审 L-7，否则 MINE_ROUND_FAILED_EVALUATION_HAS_SCORES）；
 *     0 个通过（gmine_basis 不收记录）；封存行、选择行原样留着；
 *   - 终态：释放开轮名额；尝试照旧在试验台账里、计入 N（签字 §3.3「从不按轮清零」）；按开轮月份计入每月轮数；暂停规则按 0 个通过算。
 */
function failEvaluation(roundId, { reason, evidenceSha256, failedAt = null } = {}) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  need(r.status === 'OPEN' || r.status === 'CAP_REACHED', 'MINE_ROUND_FAILED_EVALUATION_NOT_ALLOWED', `${roundId}:${r.status}`);
  need(isText(reason), 'MINE_ROUND_FAILED_EVALUATION_REASON', roundId);
  need(SHA64.test(evidenceSha256 || ''), 'MINE_ROUND_FAILED_EVALUATION_EVIDENCE', roundId);
  const vault = require('../holdout-vault');
  need(!r.holdout_opens && !vault.openLog(roundId).length, 'MINE_ROUND_FAILED_EVALUATION_HOLDOUT_OPENED', roundId);
  // 复审 L-7：算出过有限分数的轮是被评估过的轮，不能这样关（防止在留出段开启之前把一轮真结果丢掉）
  const scored = [...trials.heads(trials.trialRows()).values()].filter((t) => t.role === 'MINED_CANDIDATE' && t.mining && t.mining.round_id === roundId
    && t.rule_config && t.rule_config.attempt === undefined && t.metrics && Number.isFinite(t.metrics.mining_segment_score)).length;
  need(scored === 0, 'MINE_ROUND_FAILED_EVALUATION_HAS_SCORES', `${roundId}:${scored}`);
  const sel = selectionOf(roundId);
  return write({ ...r, status: 'FAILED_EVALUATION', gmine_passes: 0,
    gmine_basis: { holdout_open_hash: null, records: 0, record_hashes: [],
      failed_evaluation: { reason, evidence_sha256: evidenceSha256, ruling: '★RF1116_ROUND1_STATE (a)', attempts: r.candidates_scored,
        selected: sel ? sel.selected.length : null, holdout_sealed: Boolean(vault.sealOf(roundId)) } },
    closed_at: failedAt || now() });
}

/** 续跑（--resume）时用过的数据核对（覆盖下限）也写进轮次行（data_checks.resumes，只追加）。 */
function recordResumeCheck(roundId, check) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  need(r.status === 'OPEN' || r.status === 'CAP_REACHED', 'MINE_ROUND_NOT_OPEN', `${roundId}:${r.status}`);
  need(isObj(check), 'MINE_ROUND_DATA_CHECK_INVALID', roundId);
  const dc = isObj(r.data_checks) ? r.data_checks : {};
  return write({ ...r, data_checks: { ...dc, resumes: [...(Array.isArray(dc.resumes) ? dc.resumes : []), JSON.parse(JSON.stringify(check))] } });
}

/**
 * 大模型调用计量（MINING_LLM_CALL_V1，只追加）。row 里 round_id / seq / key / outcome / final / sent / n_requested / config_sha256 等见 schemas；record_hash 由这里算。
 * seq 必须是本轮已有行数 + 1（不跳、不重）；轮次要在、状态是 OPEN 或 CAP_REACHED 以前的（SCORING 之后不再调用）。
 */
const LLM_CALLS = () => path.join(dataDir('research'), 'mining_llm_calls.jsonl');
const llmCalls = (roundId) => read(LLM_CALLS()).filter((x) => x.schema === 'MINING_LLM_CALL_V1' && x.round_id === roundId).sort((a, b) => a.seq - b.seq);
function recordLlmCall(roundId, row = {}, { recordedAt = null } = {}) {
  const r = roundHead(roundId);
  need(r, 'MINE_ROUND_NOT_FOUND', roundId);
  need(r.generator.mode === 'AI_MINED_LLM', 'MINE_ROUND_LLM_CALL_NOT_LLM_ROUND', roundId);
  need(r.status === 'OPEN' || r.status === 'CAP_REACHED', 'MINE_ROUND_NOT_OPEN', `${roundId}:${r.status}`);
  const prior = llmCalls(roundId);
  need(row.seq === prior.length + 1, 'MINE_ROUND_LLM_CALL_SEQ', `${roundId}:${row.seq}≠${prior.length + 1}`);
  const body = { schema: 'MINING_LLM_CALL_V1', round_id: roundId, ...row, recorded_at: recordedAt || now() };
  delete body.record_hash;
  const rec = { ...body, record_hash: trials.recordHash(body) };
  const v = validateRecord(rec, 'MINING_LLM_CALL_V1');
  need(v.ok, 'MINE_ROUND_SCHEMA_INVALID', v.problems.join(','));
  need(Number.isInteger(rec.tokens_metered) && rec.tokens_metered >= 0 && ['USAGE', 'UPPER_BOUND', 'NONE'].includes(rec.tokens_basis), 'MINE_ROUND_LLM_CALL_INVALID', `${roundId}:${row.seq}`);
  return append(LLM_CALLS(), rec);
}
/** 本轮最新一行（没有调用过 → null）。 */
const llmState = (roundId) => { const c = llmCalls(roundId); return c.length ? c[c.length - 1] : null; };
/** 本轮已用：发到接口的调用数（sent）、计入上限的 token、最新一次的 outcome。 */
function llmUsage(roundId) {
  const c = llmCalls(roundId);
  return { calls: c.filter((x) => x.sent).length, tokens_metered: c.reduce((a, x) => a + x.tokens_metered, 0), last_outcome: c.length ? c[c.length - 1].outcome : null };
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

module.exports = { SCHEMA, LEDGER, SELECTION_SCHEMA, SELECTIONS, MARKETS, GENERATORS, LIMITS, MONTHLY_CAP_EXCEPTIONS, monthlyCapOf, monthCst, TERMINAL, FAILED_TERMINAL, MiningRoundError, openRound, recordCandidate, recordSelection, selectionOf,
  beginScoring, closeRound, failRescore, failPartial, failEvaluation, recordResumeCheck,
  roundHead, roundsOf, pauseState, familyN, generatorView, manifestSha, LLM_CALLS, llmCalls, recordLlmCall, llmState, llmUsage };
