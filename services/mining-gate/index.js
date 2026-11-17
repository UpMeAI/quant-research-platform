'use strict';

/**
 * G-MINE 出沙箱的门 —— 研究框架修订 2026-11-16（因子库与 AI 自动挖掘因子）已签字修订（签字文本 fd22876f，签字页 SIGNATURE_1 39f8c17c）§3.6；P0 只是骨架。合同 docs/contracts/FACTOR_LIBRARY_V1.md §4。
 *
 * 候选从 CANDIDATE 升 RESEARCH（可以立题）要九项全过；全过不等于上线（进生产照旧走 K2、封存、签字，§5）。
 *   1 DSR ≥ DSR_MIN，N = 本族（市场 × 持有期）累计尝试数        —— 门槛读 services/trial-ledger/overfit.js，不另抄
 *   2 PBO ≤ PBO_MAX（CSCV，在本轮候选集上算）                  —— 同上
 *   3 留出段平均 rank IC ≥ ic_mean_min；ICIR（不重叠持有期）≥ icir_min        ★e
 *   4 留出段五分组：组号与组平均收益的 Spearman ≥ monotonicity_min（门自己算）  ★e
 *   5 持有期加倍的 IC ≥ decay_ratio_min × 原持有期 IC                        ★e
 *   6 只做多前 20%，按 G-COST 下限扣成本（services/cost-gate FLOORS；CN_A 卖出另加印花税），年化超额相对等权股票池 > 0
 *   7 对现有账本（库里同市场 LIVE_IN_RULE 因子）：前推净信息比提高 > marginal_ir_delta_min，或截距 t ≥ marginal_intercept_t_min  ★e
 *   8 与库内同市场每个因子的 |ρ| ≤ 因子库 DEDUPE.RHO_MAX，或冲突的都已正交化（且正交化版本计入 N）
 *   9 机制：已登记、写了经济逻辑与预期失效方式、写成时刻早于留出段打分；G-MECH 同机制去重（分诊不是 NOT_DO_SETTLED）
 *
 * ★e 的数是草稿 §4 的建议值，第一轮开跑前由协调会话冻结；冻结前（THRESHOLDS.state = PENDING_FREEZE）门一律失败即关：MINE_THRESHOLDS_UNFROZEN。
 * 门只拒绝，从不改写结果（不改输入对象的任何字段，包括 status 与结论）；错误码 MINE_*。P0 不接任何导入器，不读行情、不写台账、不调用模型接口。
 */
const overfit = require('../trial-ledger/overfit');
const costGate = require('../cost-gate');
const factorLib = require('../factor-library');
const corr = require('../factor-library/correlation');
const mech = require('../research-mechanism-register');

const { DSR_MIN, PBO_MAX } = overfit;
const PENDING_FREEZE = 'PENDING_FREEZE';
const FROZEN = 'FROZEN';
const SHA64 = /^[0-9a-f]{64}$/;
const BEIJING = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?\+08:00$/;

/**
 * ★e：草稿 §4 第 3–5、7 项的建议值。冻结前不得用来放行任何候选。唯一出处是 QRP git 里钉住的 config/mining_gate_thresholds.v1.json
 * （挖掘轮次的逐候选记录也只读它）；转 FROZEN 只经协调会话审过的 PR（协调会话 2026-11-17）。
 */
const THRESHOLDS_FILE = require('path').join(__dirname, '..', '..', 'config', 'mining_gate_thresholds.v1.json');
const THRESHOLDS = (() => {
  const d = JSON.parse(require('fs').readFileSync(THRESHOLDS_FILE, 'utf8'));
  return Object.freeze({ state: d.state, source: Object.freeze({ ...d.source }), frozen_ref: d.frozen_ref ? Object.freeze({ ...d.frozen_ref }) : null,
    ic_mean_min: d.ic_mean_min, icir_min: d.icir_min, monotonicity_min: d.monotonicity_min, decay_ratio_min: d.decay_ratio_min,
    marginal_ir_delta_min: d.marginal_ir_delta_min, marginal_intercept_t_min: d.marginal_intercept_t_min });
})();
const THRESHOLD_KEYS = Object.freeze(['ic_mean_min', 'icir_min', 'monotonicity_min', 'decay_ratio_min', 'marginal_ir_delta_min', 'marginal_intercept_t_min']);

/** 第 6 项的口径（草稿 §4 第 6 项与附录 1 §2.4，不是 ★e 新数）。 */
const NET_SPEC = Object.freeze({ top_fraction: 0.2, benchmark: 'EQUAL_WEIGHT_UNIVERSE', long_only_markets: Object.freeze(['CN_A']), stamp_duty_markets: Object.freeze(['CN_A']) });
const QUINTILES = 5;
const PBO_SCOPE = 'ROUND_CANDIDATE_SET';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const numOf = (v) => (isObject(v) && 'value' in v ? v.value : v);
const at = (o, key) => (isObject(o) ? o[key] : undefined);

/** 门槛块是否已冻结且完整：state FROZEN、冻结页 path + sha256、六个数都是有限数。 */
/**
 * 冻结页核对（协调会话 2026-11-17：每台机器一样，不读协调目录）：frozen_ref.path 是仓库里 docs/freeze/ 下的冻结页副本，
 * 要在、sha256 等于 frozen_ref.sha256、页里写着 FROZEN、六个数各在某一行里和它的键一起出现。返回 null（对）或原因。
 */
const REPO_ROOT = require('path').join(__dirname, '..', '..');
let FREEZE_ROOT = REPO_ROOT;
const FREEZE_DIR = 'docs/freeze/';
function verifyFreezeRef(t) {
  const fsx = require('fs'); const px = require('path');
  const ref = isObject(t) ? t.frozen_ref : null;
  if (!isObject(ref) || !isText(ref.path) || !SHA64.test(ref.sha256 || '')) return 'REF_SHAPE';
  const norm = px.posix.normalize(ref.path);
  if (norm !== ref.path || !norm.startsWith(FREEZE_DIR) || norm.includes('..') || px.isAbsolute(norm)) return 'PATH_INVALID';
  const file = px.join(FREEZE_ROOT, norm);
  if (!fsx.existsSync(file)) return 'PAGE_MISSING';
  const bytes = fsx.readFileSync(file);
  if (require('crypto').createHash('sha256').update(bytes).digest('hex') !== ref.sha256) return 'PAGE_SHA_MISMATCH';
  const text = bytes.toString('utf8');
  if (!/\bFROZEN\b/.test(text)) return 'PAGE_NOT_FROZEN';
  const lines = text.split('\n');
  for (const k of THRESHOLD_KEYS) {
    const ok = lines.some((l) => new RegExp(`(^|[^A-Za-z0-9_])${k}([^A-Za-z0-9_]|$)`).test(l)
      && (l.match(/-?\d+(?:\.\d+)?/g) || []).some((n) => Number(n) === t[k]));
    if (!ok) return `PAGE_VALUE_MISSING:${k}`;
  }
  return null;
}

/**
 * 门槛块的状态：没冻结 → MINE_THRESHOLDS_UNFROZEN；冻结但结构或数不对 → MINE_THRESHOLDS_INVALID；
 * checkFreeze（门默认读文件时、逐候选记录）且冻结页核对不过 → MINE_THRESHOLDS_FREEZE_REF_INVALID。
 */
function thresholdState(t, { checkFreeze = false } = {}) {
  if (!isObject(t) || t.state !== FROZEN) return 'MINE_THRESHOLDS_UNFROZEN';
  const ref = t.frozen_ref;
  if (!isObject(ref) || !isText(ref.path) || !SHA64.test(ref.sha256 || '')) return 'MINE_THRESHOLDS_INVALID';
  if (!THRESHOLD_KEYS.every((k) => isNum(t[k]))) return 'MINE_THRESHOLDS_INVALID';
  if (checkFreeze && verifyFreezeRef(t)) return 'MINE_THRESHOLDS_FREEZE_REF_INVALID';
  return null;
}

const result = (item, key, codes, detail = {}) => Object.freeze({ item, key, pass: codes.length === 0, codes: Object.freeze([...codes]), detail: Object.freeze(detail) });
/** ★e 项先看门槛块；没冻结就不判。 */
function frozenOr(item, key, ctx) {
  const code = thresholdState(ctx && ctx.thresholds);
  return code ? result(item, key, [code]) : null;
}

// ── 九项 ─────────────────────────────────────────────────────────────────────

/** 1 DSR：门槛读 overfit.DSR_MIN；N 必须是本族累计尝试数。 */
function checkDsr(c, ctx = {}) {
  const o = at(c, 'overfit'); const codes = [];
  const dsr = numOf(at(o, 'dsr'));
  if (!isNum(dsr)) codes.push('MINE_DSR_UNKNOWN');
  else if (!(dsr >= DSR_MIN)) codes.push('MINE_DSR_BELOW_MIN');
  const n = at(o, 'n_trials');
  if (!Number.isInteger(ctx.familyTrialCount) || ctx.familyTrialCount < 1) codes.push('MINE_DSR_N_UNKNOWN');
  else if (n !== ctx.familyTrialCount) codes.push('MINE_DSR_N_NOT_CUMULATIVE');
  return result(1, 'DSR', codes, { dsr: isNum(dsr) ? dsr : null, dsr_min: DSR_MIN, n_trials: n === undefined ? null : n, family_trial_count: ctx.familyTrialCount ?? null });
}

/** 2 PBO：门槛读 overfit.PBO_MAX；必须在本轮候选集上算。 */
function checkPbo(c) {
  const o = at(c, 'overfit'); const codes = [];
  const pbo = numOf(at(o, 'pbo'));
  if (!isNum(pbo)) codes.push('MINE_PBO_UNKNOWN');
  else if (!(pbo <= PBO_MAX)) codes.push('MINE_PBO_ABOVE_MAX');
  if (at(o, 'pbo_scope') !== PBO_SCOPE) codes.push('MINE_PBO_SCOPE');
  return result(2, 'PBO', codes, { pbo: isNum(pbo) ? pbo : null, pbo_max: PBO_MAX });
}

/** 3 IC / ICIR（留出段）。 */
function checkIcIcir(c, ctx = {}) {
  const pending = frozenOr(3, 'IC_ICIR', ctx); if (pending) return pending;
  const t = ctx.thresholds; const h = at(c, 'holdout'); const codes = [];
  const ic = at(h, 'ic_mean'); const icir = at(h, 'icir');
  if (!isNum(ic)) codes.push('MINE_IC_INPUT'); else if (!(ic >= t.ic_mean_min)) codes.push('MINE_IC_BELOW_MIN');
  if (!isNum(icir)) codes.push('MINE_ICIR_INPUT'); else if (!(icir >= t.icir_min)) codes.push('MINE_ICIR_BELOW_MIN');
  if (at(h, 'icir_non_overlapping') !== true) codes.push('MINE_ICIR_OVERLAPPING');
  if (notNeutralized(c)) codes.push('MINE_NOT_NEUTRALIZED');
  return result(3, 'IC_ICIR', codes, { ic_mean: isNum(ic) ? ic : null, icir: isNum(icir) ? icir : null });
}

/** §3.6「先中性化」（§8.3 第 12 条）：IC 类读数（IC、ICIR、单调性、衰减）必须取自按行业与市值中性化后的因子值——留出段结果要写 neutralization { industry: 'APPLIED', size: 'APPLIED' }（挖掘沙箱求值器的 neutralizeForScoring 写的就是这个），否则拒绝。 */
const NEUTRALIZED = Object.freeze({ industry: 'APPLIED', size: 'APPLIED' });
const notNeutralized = (c) => { const n = at(at(c, 'holdout'), 'neutralization'); return !(isObject(n) && n.industry === NEUTRALIZED.industry && n.size === NEUTRALIZED.size); };

/** 4 单调性：门自己从五组平均收益算 Spearman，不读候选自报的数。 */
function checkMonotonicity(c, ctx = {}) {
  const pending = frozenOr(4, 'MONOTONICITY', ctx); if (pending) return pending;
  const q = at(at(c, 'holdout'), 'quintile_mean_returns');
  if (!Array.isArray(q) || q.length !== QUINTILES || !q.every(isNum)) return result(4, 'MONOTONICITY', ['MINE_MONOTONICITY_INPUT']);
  if (notNeutralized(c)) return result(4, 'MONOTONICITY', ['MINE_NOT_NEUTRALIZED']);
  const rho = corr.spearman(q.map((_, i) => i + 1), q);
  const codes = rho === null ? ['MINE_MONOTONICITY_INPUT'] : rho >= ctx.thresholds.monotonicity_min ? [] : ['MINE_MONOTONICITY_BELOW_MIN'];
  return result(4, 'MONOTONICITY', codes, { spearman: rho });
}

/** 5 衰减：持有期加倍时的 IC 不低于原持有期 IC 的 decay_ratio_min 倍；原 IC 不为正时不判。 */
function checkDecay(c, ctx = {}) {
  const pending = frozenOr(5, 'DECAY', ctx); if (pending) return pending;
  const h = at(c, 'holdout');
  const ic = at(h, 'ic_mean'); const ic2 = at(h, 'ic_double_horizon');
  if (!isNum(ic) || !isNum(ic2)) return result(5, 'DECAY', ['MINE_DECAY_INPUT']);
  if (!(ic > 0)) return result(5, 'DECAY', ['MINE_DECAY_BASE_NOT_POSITIVE']);
  if (notNeutralized(c)) return result(5, 'DECAY', ['MINE_NOT_NEUTRALIZED']);
  return result(5, 'DECAY', ic2 >= ctx.thresholds.decay_ratio_min * ic ? [] : ['MINE_DECAY_BELOW_HALF'], { ratio: ic2 / ic });
}

/** 6 扣成本后的净值：口径（只做多前 20%、相对等权股票池）、成本不低于 G-COST 下限、年化超额 > 0。 */
function checkNetOfCost(c) {
  const n = at(c, 'net_of_cost'); const codes = [];
  const market = at(c, 'market');
  const floor = costGate.FLOORS[costGate.floorMarketOf(market)];
  if (NET_SPEC.long_only_markets.includes(market) && at(n, 'long_only') !== true) codes.push('MINE_NET_SCOPE');
  if (at(n, 'top_fraction') !== NET_SPEC.top_fraction || at(n, 'benchmark') !== NET_SPEC.benchmark) codes.push('MINE_NET_SCOPE');
  const cost = at(n, 'cost');
  if (!floor) codes.push('MINE_NET_NO_FLOOR');
  else {
    const com = at(cost, 'commission_bps'); const slip = at(cost, 'slippage_bps');
    const ok = isNum(com) && isNum(slip) && com >= floor.commission_bps_min && slip >= floor.slippage_bps_min
      && (floor.total_bps_min === null || com + slip >= floor.total_bps_min)
      && (!NET_SPEC.stamp_duty_markets.includes(market) || at(cost, 'stamp_duty_on_sell') === true);
    if (!ok) codes.push('MINE_NET_COST_BELOW_FLOOR');
  }
  const ex = at(n, 'annualized_excess');
  if (!isNum(ex)) codes.push('MINE_NET_INPUT'); else if (!(ex > 0)) codes.push('MINE_NET_EXCESS_NOT_POSITIVE');
  return result(6, 'NET_OF_COST', [...new Set(codes)], { floor_market: costGate.floorMarketOf(market) });
}

/** 现有账本（第 7 项）与第 8 项的比较集：库里同市场 LIVE_IN_RULE 的因子，去掉 R1.9 排除的（ETF 级、只存前十名的；协调会话裁定 R1 修订 3）。 */
const bookFactorIds = (library, market) => factorLib.comparisonFactorIds(library, market);

/** 7 对现有账本的边际贡献。 */
function checkMarginal(c, ctx = {}) {
  const pending = frozenOr(7, 'MARGINAL', ctx); if (pending) return pending;
  const t = ctx.thresholds; const m = at(c, 'marginal'); const codes = [];
  const book = bookFactorIds(ctx.library || factorLib.LIBRARY, at(c, 'market'));
  const given = Array.isArray(at(m, 'book_factor_ids')) ? [...m.book_factor_ids].sort() : null;
  if (!given || given.length !== book.length || given.some((id, i) => id !== book[i])) codes.push('MINE_MARGINAL_BOOK_MISMATCH');
  const ir = at(m, 'wfo_net_ir_delta'); const tt = at(m, 'intercept_t');
  if (!isNum(ir) && !isNum(tt)) codes.push('MINE_MARGINAL_INPUT');
  else if (!((isNum(ir) && ir > t.marginal_ir_delta_min) || (isNum(tt) && tt >= t.marginal_intercept_t_min))) codes.push('MINE_MARGINAL_NOT_POSITIVE');
  return result(7, 'MARGINAL', codes, { book_factor_ids: book });
}

/** 8 与库内因子的相关性：覆盖库里同市场每个因子；|ρ| > RHO_MAX 的必须都已正交化，且正交化版本计入 N。 */
function checkCorrelation(c, ctx = {}) {
  const library = ctx.library || factorLib.LIBRARY;
  const k = at(c, 'correlation'); const codes = [];
  const pairs = Array.isArray(at(k, 'pairs')) ? k.pairs : [];
  const want = factorLib.comparisonFactorIds(library, at(c, 'market')); // R1.9：只和覆盖全部股票截面的 LIVE_IN_RULE 因子比
  const have = new Set(pairs.map((p) => p && p.factor_id));
  if (want.some((id) => !have.has(id))) codes.push('MINE_CORRELATION_LIBRARY_INCOMPLETE');
  const orth = Array.isArray(at(k, 'orthogonalised_against')) ? k.orthogonalised_against : [];
  const decision = corr.dedupeDecision({
    candidate: { factor_id: String(at(c, 'factor_id')), icir_mining: null, orthogonalised_against: orth },
    existing: pairs.filter((p) => isObject(p) && want.includes(p.factor_id))
      .map((p) => ({ factor_id: p.factor_id, icir_mining: null, rho_cross_section: p.rho_cross_section, rho_returns: p.rho_returns })),
    threshold: factorLib.DEDUPE.RHO_MAX,
  });
  if (decision.decision === 'CORRELATION_UNKNOWN') codes.push('MINE_CORRELATION_UNKNOWN');
  else if (decision.conflicts.length && decision.decision !== 'ORTHOGONALISED') codes.push('MINE_CORRELATION_ABOVE_MAX');
  else if (orth.length && at(k, 'new_attempt') !== true) codes.push('MINE_CORRELATION_ORTHOGONALISED_NOT_COUNTED');
  return result(8, 'CORRELATION', codes, { rho_max: factorLib.DEDUPE.RHO_MAX, conflicts: decision.conflicts });
}

/** 9 机制：已登记、写了经济逻辑与失效方式、写成时刻早于留出段打分、G-MECH 分诊不是 NOT_DO_SETTLED。 */
function checkMechanism(c, ctx = {}) {
  const m = at(c, 'mechanism'); const codes = [];
  const id = at(m, 'mechanism_id');
  const register = ctx.registerBytes ? mech.parse(ctx.registerBytes) : mech.REGISTER;
  if (!mech.isRegistered(id, register)) return result(9, 'MECHANISM', ['MINE_MECHANISM_UNKNOWN']);
  if (!isText(at(m, 'economic_logic_zh')) || !isText(at(m, 'failure_mode_zh'))) codes.push('MINE_MECHANISM_FIELDS');
  const written = at(m, 'written_at'); const scored = at(at(c, 'holdout'), 'scored_at');
  if (!BEIJING.test(written || '') || !BEIJING.test(scored || '') || !(Date.parse(written) < Date.parse(scored))) codes.push('MINE_MECHANISM_AFTER_HOLDOUT');
  let route = null;
  if (BEIJING.test(scored || '')) {
    try {
      route = mech.query({ mechanism_ids: [id], market: at(c, 'market') },
        { registerBytes: ctx.registerBytes || null, marks: Array.isArray(ctx.marks) ? ctx.marks : [], asOf: ctx.asOf || scored }).route;
    } catch (e) { codes.push('MINE_MECHANISM_QUERY'); }
    if (route === 'NOT_DO_SETTLED') codes.push('MINE_MECHANISM_NOT_DO_SETTLED');
  }
  return result(9, 'MECHANISM', codes, { route });
}

const ITEMS = Object.freeze([
  Object.freeze({ item: 1, key: 'DSR', check: checkDsr }),
  Object.freeze({ item: 2, key: 'PBO', check: checkPbo }),
  Object.freeze({ item: 3, key: 'IC_ICIR', check: checkIcIcir }),
  Object.freeze({ item: 4, key: 'MONOTONICITY', check: checkMonotonicity }),
  Object.freeze({ item: 5, key: 'DECAY', check: checkDecay }),
  Object.freeze({ item: 6, key: 'NET_OF_COST', check: checkNetOfCost }),
  Object.freeze({ item: 7, key: 'MARGINAL', check: checkMarginal }),
  Object.freeze({ item: 8, key: 'CORRELATION', check: checkCorrelation }),
  Object.freeze({ item: 9, key: 'MECHANISM', check: checkMechanism }),
]);

/**
 * 跑 G-MINE。输入对象不被改写（各项只读；结果是新对象）。
 * @param {object} candidate  候选结果对象（字段见合同 §4）
 * @param {{thresholds?, familyTrialCount, library?, registerBytes?, marks?, asOf?}} ctx
 * @returns {{schema, candidate_id, factor_id, pass, eligible_status, codes, items, thresholds, production_effect}}
 */
function evaluate(candidate, ctx = {}) {
  const thresholds = ctx.thresholds ?? THRESHOLDS;
  // 默认读文件（权威）时总核冻结页；调用方自带门槛块（单元测试）时只在 ctx.checkFreeze 时核；逐候选记录总传 checkFreeze
  const checkFreeze = ctx.thresholds === undefined || ctx.thresholds === null || ctx.checkFreeze === true;
  const freezeCheck = checkFreeze && isObject(thresholds) && thresholds.state === FROZEN ? verifyFreezeRef(thresholds) : null;
  const head = {
    schema: 'MINING_GATE_RESULT_V1', candidate_id: at(candidate, 'candidate_id') ?? null, factor_id: at(candidate, 'factor_id') ?? null,
    thresholds: { state: isObject(thresholds) ? thresholds.state ?? null : null, frozen_ref: isObject(thresholds) ? thresholds.frozen_ref ?? null : null,
      ...(freezeCheck ? { freeze_check: freezeCheck } : {}) },
    production_effect: 'NONE',
  };
  const blocked = thresholdState(thresholds, { checkFreeze });
  if (blocked) return Object.freeze({ ...head, pass: false, eligible_status: null, codes: [blocked], items: [] });
  if (!isObject(candidate)) return Object.freeze({ ...head, pass: false, eligible_status: null, codes: ['MINE_CANDIDATE_INVALID'], items: [] });
  const items = ITEMS.map(({ check }) => check(candidate, { ...ctx, thresholds }));
  const codes = items.flatMap((i) => i.codes);
  const pass = codes.length === 0;
  return Object.freeze({ ...head, pass, eligible_status: pass ? 'RESEARCH' : null, codes, items });
}

/** 只给测试用：临时把「仓库根」换成一个放了合成冻结页的目录，回调结束还原。 */
function withFreezeRoot(root, cb) { const prior = FREEZE_ROOT; FREEZE_ROOT = root; try { return cb(); } finally { FREEZE_ROOT = prior; } }

module.exports = {
  DSR_MIN, PBO_MAX, PENDING_FREEZE, FROZEN, THRESHOLDS, THRESHOLDS_FILE, THRESHOLD_KEYS, FREEZE_DIR, verifyFreezeRef, NET_SPEC, QUINTILES, PBO_SCOPE, ITEMS, NEUTRALIZED,
  thresholdState, bookFactorIds, evaluate,
  checkDsr, checkPbo, checkIcIcir, checkMonotonicity, checkDecay, checkNetOfCost, checkMarginal, checkCorrelation, checkMechanism,
  internals: { withFreezeRoot },
};
