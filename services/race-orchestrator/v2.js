'use strict';

/**
 * RACE_V2 —— 赛马扩展（研究框架修订 2026-11-16 §4，R1）。合同 docs/contracts/RACE_V2.md。
 * Owner 2026-11-16 23:50 CST 签字：签字文本 SIGNED.text（fd22876f…），签字页 SIGNED.signature（39f8c17c…，★g）。
 *
 *   - 一个市场一个榜（CN_A、US、CRYPTO），从不跨市场排名、合并样本或合并 N；跨市场的参赛者 → RACE_CROSS_MARKET。
 *   - 榜内可以跨账本：每个参赛者都和本市场的冠军在账户层逐日配对。
 *   - 按层分区：SELECTION_TIMING（主指标账户层配对 g，另报回撤与尾部亏损）、RISK（最大回撤、最差月份、日 CVaR 5% 三项都不劣于冠军，
 *     再按 CVaR 改善排名；收益损失是 K2 预登记的约束）。一个分区里混入别的层 → RACE_MIXED_LAYER。
 *   - 一个分区同引擎、同窗口、同成本模型；成本模型过 G-COST（../cost-gate 的 assessCostModel：目录内计成本的模型，或不低于市场下限的自报成本）。
 *   - 校正：选股择时层 DSR 的 N = 本市场累计 N（试验台账 countMarket），PBO 用 CSCV 在本分区算，风控层不用 DSR、按 11-10 修订 §3.4 做 BHY
 *     （同一市场已关闭的风控分区的 p 一起校正）。公式全部取自 ../trial-ledger/overfit，不另写。
 *   - 入场线：挖出的因子在因子库里是 RESEARCH；人工候选有冻结 K2；都声明过 G-CAUSAL（证据 sha）。淘汰线、PBO > 0.5 判 INCONCLUSIVE、每场最多 2 名晋级。
 *   - 赛马清单 RACE_MANIFEST_V1 由协调会话冻结（做法同 K2：清单按 sha256 绑定，冻结页原文写出清单 sha 与 FROZEN）；清单 sha 写进每个参赛者的台账行
 *     （k2_sha256 = 清单 sha，冠军角色 BASELINE、挑战者 VERDICT_ARM，阶段 BOOK，预登记）。
 *   - 两两配对的裁决器（./index 的 adjudicate）原样复用；旧赛马台账 races.jsonl 不碰，RACE_V2 写自己的台账 races_v2.jsonl。
 * 门只拒绝或判负，不改写任何结论；失败即关，错误码 RACE_*（成本门的码沿用 COST_MODEL_*）。只用研究台账，不下单，production_effect NONE。
 */
const crypto = require('crypto');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');
const { validateRecord } = require('../../schemas');
const races = require('./index');
const trials = require('../trial-ledger');
const overfit = require('../trial-ledger/overfit');
const costGate = require('../cost-gate');
const factorLibrary = require('../factor-library');

const SCHEMA = 'RACE_V2';
const MANIFEST_SCHEMA = 'RACE_MANIFEST_V1';
const LEDGER = () => path.join(dataDir('research'), 'races_v2.jsonl');
const SIGNED = Object.freeze({
  text: Object.freeze({ path: 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261116_FACTOR_LIBRARY_AI_MINING.signed.fd22876f.md',
    sha256: 'fd22876f6a690b52b07429f333d2545d8fedb5d285dccd3fd3f5a1ecd9f00c80' }),
  signature: Object.freeze({ path: 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261116_SIGNATURE_1.md',
    sha256: '39f8c17cd569f8eadf7bd18102997cc19b421959aec36fae98c1b1a20fbcd3fb' }),
});
const MARKETS = Object.freeze(['CN_A', 'US', 'CRYPTO']);
const PARTITIONS = Object.freeze(['SELECTION_TIMING', 'RISK']);
const PRIMARY = Object.freeze({ SELECTION_TIMING: 'ACCOUNT_PAIRED_G', RISK: 'RISK_TRIPLE_THEN_DAILY_CVAR5' });
const ORIGINS = Object.freeze(['FACTOR', 'HUMAN']);
/** §4.4 的建议值（★g「细则是默认值」）：清单逐项写出，协调会话冻结；这里只给默认值与上限。 */
const DEFAULTS = Object.freeze({
  SELECTION_TIMING: Object.freeze({ dsr_min: overfit.DSR_MIN, mdd_max_ratio: 1.2, participation_cap: 0.10 }),
  RISK: Object.freeze({ bhy_alpha: 0.05 }),
  pbo_max: overfit.PBO_MAX,
  promotion_slots_max: 2,
});
const GUARDRAIL_KEYS = Object.freeze({ SELECTION_TIMING: ['dsr_min', 'mdd_max_ratio', 'participation_cap'], RISK: ['bhy_alpha'] });
const CAUSALITY_STATES = Object.freeze(['PASS', 'DEVIATION_ACCEPTED', 'NOT_APPLICABLE']);
/** 附录 1 §1（A1）：账本级的判定运行只有风控层调 k、账户层能免测成交函数。 */
const CAUSALITY_NA_ALLOWED = 'RISK_K_OR_ACCOUNT_LAYER';
const CVAR_TAIL = 0.05;
const SHA64 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class RaceV2Error extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new RaceV2Error(`RACE_${code}`, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isoAt = (v) => typeof v === 'string' && /[zZ]|[+-]\d{2}:\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const same = (a, b) => trials.canonicalJson(a) === trials.canonicalJson(b);
/** 台账、因子库的 market 归到榜的市场（同 G-COST 的归类）。 */
const boardMarketOf = (m) => costGate.floorMarketOf(m);

// ── 清单与冻结 ──────────────────────────────────────────────────────────────────

/** 解析并核对清单（结构、市场、分区、主指标、护栏、名额、参赛者的市场与层）。 */
function parseManifest(bytes) {
  let m;
  try { m = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)); } catch { return fail('MANIFEST_INVALID', 'NOT_JSON'); }
  need(isObj(m) && m.schema === MANIFEST_SCHEMA, 'MANIFEST_INVALID', 'schema');
  const v = validateRecord(m, MANIFEST_SCHEMA);
  need(v.ok, 'MANIFEST_INVALID', v.problems.join(','));
  need(MARKETS.includes(m.market), 'MANIFEST_INVALID', `market:${m.market}`);
  need(PARTITIONS.includes(m.partition), 'MANIFEST_INVALID', `partition:${m.partition}`);
  need(m.primary_metric === PRIMARY[m.partition], 'MANIFEST_INVALID', `primary_metric:${m.primary_metric}≠${PRIMARY[m.partition]}`);
  need(Number.isInteger(m.periods_per_year) && m.periods_per_year > 0, 'MANIFEST_INVALID', 'periods_per_year');
  need(isText(m.engine.id) && isText(m.engine.version), 'MANIFEST_INVALID', 'engine');
  need(DATE.test(m.window.from || '') && DATE.test(m.window.to || '') && m.window.from <= m.window.to, 'MANIFEST_INVALID', 'window');
  need(isText(m.cost_model.cost_model_ref), 'MANIFEST_INVALID', 'cost_model');
  for (const k of GUARDRAIL_KEYS[m.partition]) need(isNum(m.guardrails[k]) && m.guardrails[k] >= 0, 'MANIFEST_INVALID', `guardrails.${k}`);
  need(m.pbo_max >= 0 && m.pbo_max <= 1, 'MANIFEST_INVALID', 'pbo_max');
  need(Number.isInteger(m.promotion_slots) && m.promotion_slots >= 1 && m.promotion_slots <= DEFAULTS.promotion_slots_max, 'PROMOTION_SLOTS_INVALID', String(m.promotion_slots));
  need(m.challengers.length >= 1, 'MANIFEST_INVALID', 'challengers');
  const all = [m.champion, ...m.challengers];
  for (const e of all) need(isObj(e) && isText(e.entrant_id) && ledger_id(e) && isText(e.book_ref), 'MANIFEST_INVALID', `entrant:${e && e.entrant_id}`);
  need(new Set(all.map((e) => e.entrant_id)).size === all.length, 'ENTRANT_DUPLICATE', m.race_ref);
  need(new Set(all.map((e) => e.trial_id)).size === all.length, 'ENTRANT_DUPLICATE', `${m.race_ref}:trial_id`);
  // 一个市场一个榜；一个分区一层
  for (const e of all) need(e.market === m.market, 'CROSS_MARKET', `${e.entrant_id}:${e.market}≠${m.market}`);
  for (const e of all) need(e.layer === m.partition, 'MIXED_LAYER', `${e.entrant_id}:${e.layer}≠${m.partition}`);
  if (m.partition === 'RISK') for (const e of m.challengers) need(isNum(e.return_loss_max) && e.return_loss_max >= 0, 'MANIFEST_INVALID', `${e.entrant_id}:return_loss_max`);
  return m;
}
const ledger_id = (e) => trials.TRIAL_ID.test(e.trial_id || '');

/** 冻结页按 sha256 复验后，原文必须写出清单 sha256、RACE_MANIFEST_V1 与 FROZEN（做法同 K2 的冻结页）。 */
function verifyFreeze(manifestSha, freeze) {
  need(isObj(freeze) && isText(freeze.path) && SHA64.test(freeze.sha256 || '') && freeze.bytes, 'MANIFEST_NOT_FROZEN', 'NO_FREEZE_PAGE');
  need(sha256(freeze.bytes) === freeze.sha256, 'MANIFEST_NOT_FROZEN', `FREEZE_SHA256_MISMATCH:${freeze.path}`);
  const text = freeze.bytes.toString('utf8');
  for (const word of [manifestSha, MANIFEST_SCHEMA, 'FROZEN']) need(text.includes(word), 'MANIFEST_NOT_FROZEN', `FREEZE_TEXT_DOES_NOT_STATE:${word}`);
  return { path: freeze.path, sha256: freeze.sha256 };
}

// ── 入场线与台账 ─────────────────────────────────────────────────────────────────

/** 参赛者的台账行：预登记、k2_sha256 = 清单 sha、阶段 BOOK、冠军 BASELINE / 挑战者 VERDICT_ARM、市场归到本榜。 */
function ledgerRowOf(e, role, manifestSha, market, rows) {
  const reg = rows.find((r) => r.row_kind === 'REGISTRATION' && r.trial_id === e.trial_id);
  need(reg, 'LEDGER_ROW_MISSING', `${e.entrant_id}:${e.trial_id}`);
  need(boardMarketOf(reg.market) === market, 'CROSS_MARKET', `${e.entrant_id}:ledger market ${reg.market}`);
  need(reg.k2_sha256 === manifestSha && reg.registration_mode === 'PREREGISTERED' && reg.stage === 'BOOK' && reg.role === role,
    'LEDGER_ROW_INVALID', `${e.entrant_id}:${reg.role}/${reg.stage}/${reg.registration_mode}/k2=${String(reg.k2_sha256).slice(0, 12)}`);
  return reg;
}

/** 入场线（§4.4）：因子在库里是 RESEARCH（过了 G-MINE）且同市场；人工候选有冻结 K2；都声明过 G-CAUSAL。 */
function entryOf(e, market, library) {
  need(ORIGINS.includes(e.origin), 'ENTRY_ORIGIN_INVALID', `${e.entrant_id}:${e.origin}`);
  let ref;
  if (e.origin === 'FACTOR') {
    const f = (library.factors || []).find((x) => x.factor_id === e.factor_ref);
    need(f, 'ENTRY_FACTOR_NOT_IN_LIBRARY', `${e.entrant_id}:${e.factor_ref}`);
    need(boardMarketOf(f.market) === market, 'CROSS_MARKET', `${e.entrant_id}:factor market ${f.market}`);
    need(f.status === 'RESEARCH', 'ENTRY_FACTOR_NOT_RESEARCH', `${e.entrant_id}:${e.factor_ref}:${f.status}`);
    ref = { factor_ref: f.factor_id, status: f.status };
  } else {
    need(isObj(e.k2) && SHA64.test(e.k2.sha256 || '') && isoAt(e.k2.frozen_at), 'ENTRY_K2_NOT_FROZEN', e.entrant_id);
    ref = { k2_sha256: e.k2.sha256, k2_frozen_at: e.k2.frozen_at };
  }
  const c = e.causality;
  need(isObj(c) && CAUSALITY_STATES.includes(c.state), 'ENTRY_CAUSALITY', `${e.entrant_id}:${c && c.state}`);
  if (c.state === 'NOT_APPLICABLE') need(c.not_applicable_code === CAUSALITY_NA_ALLOWED, 'ENTRY_CAUSALITY', `${e.entrant_id}:N/A ${c.not_applicable_code}`);
  else need(SHA64.test(c.evidence_sha256 || ''), 'ENTRY_CAUSALITY', `${e.entrant_id}:evidence_sha256`);
  return { entrant_id: e.entrant_id, origin: e.origin, ...ref, causality: { state: c.state, ...(c.evidence_sha256 ? { evidence_sha256: c.evidence_sha256 } : {}), ...(c.not_applicable_code ? { not_applicable_code: c.not_applicable_code } : {}) } };
}

// ── 开赛 ────────────────────────────────────────────────────────────────────────

const raceIdOf = (m, manifestSha) => `RACE2-${m.market}-${m.partition}-${manifestSha.slice(0, 12)}`;
function heads() { const out = new Map(); for (const r of read(LEDGER())) if (r.schema === SCHEMA) out.set(r.race_id, r); return out; }
const raceHead = (raceId) => heads().get(raceId) || null;

/**
 * 开赛：清单冻结、参赛者同市场同层、台账行、入场线、成本模型过 G-COST，全部通过才写一行 OPEN。
 * @param {{manifestBytes: Buffer, freeze: {path: string, sha256: string, bytes: Buffer}, library?: object}} o  library 只给测试用，默认读因子库
 */
function openRace(o = {}) {
  need(o.manifestBytes, 'MANIFEST_INVALID', 'NO_BYTES');
  const manifestSha = sha256(o.manifestBytes);
  const freeze = verifyFreeze(manifestSha, o.freeze);
  const m = parseManifest(o.manifestBytes);
  const rows = trials.trialRows();
  ledgerRowOf(m.champion, 'BASELINE', manifestSha, m.market, rows);
  for (const e of m.challengers) ledgerRowOf(e, 'VERDICT_ARM', manifestSha, m.market, rows);
  const library = o.library || factorLibrary.library();
  const entry = m.challengers.map((e) => entryOf(e, m.market, library));
  const cost = costGate.assessCostModel(m.cost_model, m.market, { at: `${m.race_ref}:cost_model` });
  const raceId = raceIdOf(m, manifestSha);
  need(!raceHead(raceId), 'ALREADY_OPEN', raceId);
  const body = { schema: SCHEMA, race_id: raceId, status: 'OPEN', market: m.market, partition: m.partition, manifest_sha256: manifestSha, freeze, manifest: m,
    signed: SIGNED, entry, cost_model: cost, outcome: null, production_effect: 'NONE', opened_at: o.openedAt || now(), closed_at: null };
  body.record_hash = trials.recordHash(body);
  return append(LEDGER(), body);
}

// ── 指标 ────────────────────────────────────────────────────────────────────────

/** 账户层日序列 [{date, logret}] 的核对：日期升序、在窗口内、数值有限。 */
function series(who, s, window) {
  need(Array.isArray(s) && s.length, 'RESULT_FIELD_INVALID', `${who}:daily`);
  s.forEach((x, i) => {
    need(isObj(x) && DATE.test(x.date || '') && isNum(x.logret), 'RESULT_FIELD_INVALID', `${who}:daily[${i}]`);
    need(x.date >= window.from && x.date <= window.to, 'WINDOW_MISMATCH', `${who}:${x.date}`);
    if (i) need(x.date > s[i - 1].date, 'RESULT_FIELD_INVALID', `${who}:not ascending ${x.date}`);
  });
  return s;
}
/** 最大回撤（正数）：净值 = exp(累计对数收益)。 */
function maxDrawdown(s) {
  let cum = 0; let peak = 0; let mdd = 0;
  for (const x of s) { cum += x.logret; peak = Math.max(peak, cum); mdd = Math.max(mdd, 1 - Math.exp(cum - peak)); }
  return mdd;
}
/** 最差月份（简单收益）。 */
function worstMonth(s) {
  const months = new Map();
  for (const x of s) months.set(x.date.slice(0, 7), (months.get(x.date.slice(0, 7)) || 0) + x.logret);
  return Math.min(...[...months.values()].map((v) => Math.exp(v) - 1));
}
/** 日 CVaR 5%：最差 ⌈5% · n⌉ 天的简单收益均值（负数越小越差）。 */
function cvar5(s) {
  const r = s.map((x) => Math.exp(x.logret) - 1).sort((a, b) => a - b);
  const k = Math.max(1, Math.ceil(CVAR_TAIL * r.length));
  return r.slice(0, k).reduce((a, b) => a + b, 0) / k;
}
const risk = (s) => ({ mdd: maxDrawdown(s), worst_month: worstMonth(s), cvar5: cvar5(s) });
const pairedG = (ch, champ, periods) => (ch.reduce((a, x, i) => a + x.logret - champ[i].logret, 0) / ch.length) * periods;

// ── 裁决 ────────────────────────────────────────────────────────────────────────

/** 结果与清单：同引擎、同窗口、同成本模型；每个挑战者的日期与冠军逐日一致（缺边 = 拒绝）。 */
function checkResults(m, results) {
  need(isObj(results) && isObj(results.champion) && isObj(results.challengers), 'RESULT_FIELD_INVALID', 'results');
  const one = (who, r) => {
    need(isObj(r), 'RESULT_MISSING', who);
    need(same(r.engine, m.engine), 'ENGINE_MISMATCH', who);
    need(same(r.window, m.window), 'WINDOW_MISMATCH', who);
    need(r.cost_model_ref === m.cost_model.cost_model_ref, 'COST_MODEL_MISMATCH', `${who}:${r.cost_model_ref}`);
    return series(who, r.daily, m.window);
  };
  const champ = one(m.champion.entrant_id, results.champion);
  const ids = Object.keys(results.challengers).sort();
  need(same(ids, m.challengers.map((e) => e.entrant_id).sort()), 'RESULT_MISSING', `challengers:${ids.join(',')}`);
  const out = {};
  for (const e of m.challengers) {
    const daily = one(e.entrant_id, results.challengers[e.entrant_id]);
    need(daily.length === champ.length && daily.every((x, i) => x.date === champ[i].date), 'PAIRED_SAMPLE_MISSING', e.entrant_id);
    out[e.entrant_id] = daily;
  }
  return { champ, daily: out };
}

/** 本分区的 PBO：CSCV，列 = 冠军与全部挑战者的日对数收益（overfit.pbo）。 */
function partitionPbo(m, champ, daily) {
  const cols = [champ, ...m.challengers.map((e) => daily[e.entrant_id])];
  const R = champ.map((_, i) => cols.map((c) => c[i].logret));
  const p = overfit.pbo(R);
  const { lambdas: _l, ...rest } = p;
  return rest;
}

function selectionTiming(m, results, champ, daily) {
  const g = m.guardrails;
  const marketOf = boardMarketOf;
  const n = trials.countMarket(m.market, { marketOf });
  const ledgerSharpes = trials.marketSharpes(m.market, { marketOf });
  const months = Object.fromEntries(m.challengers.map((e) => [e.entrant_id, overfit.monthlyPairedDiff(daily[e.entrant_id], champ).map((x) => x.d)]));
  // 进方差 V 的 ŜR：本市场台账里已知的账本级 ŜR，加本分区各挑战者的（台账里还没有结果行）
  const own = m.challengers.filter((e) => !ledgerSharpes.some((s) => s.trial_id === e.trial_id)).map((e) => overfit.moments(months[e.entrant_id]).sr).filter(isNum);
  const sharpes = [...ledgerSharpes.map((s) => s.sr), ...own];
  const champRisk = risk(champ);
  return m.challengers.map((e) => {
    const r = results.challengers[e.entrant_id];
    need(isNum(r.participation_max) && r.participation_max >= 0, 'RESULT_FIELD_INVALID', `${e.entrant_id}:participation_max`);
    const s = daily[e.entrant_id];
    const mine = risk(s);
    const gPaired = pairedG(s, champ, m.periods_per_year);
    const adj = races.adjudicate({ primary_metric: 'paired_g', guardrails: [{ id: 'MDD_MAX_RATIO', metric: 'neg_mdd', rule: 'AT_LEAST_FRACTION_OF_CHAMPION', value: g.mdd_max_ratio }] },
      { championMetrics: { paired_g: 0, neg_mdd: -champRisk.mdd }, challengerMetrics: { paired_g: gPaired, neg_mdd: -mine.mdd } });
    const ds = overfit.deflatedSharpe({ d: months[e.entrant_id], N: n.n_raw, familySharpes: sharpes });
    const { dsr } = ds;
    const excess = s.reduce((a, x, i) => a + x.logret - champ[i].logret, 0);
    const reasons = [
      ...(adj.verdict !== 'CHALLENGER_WINS' ? ['NOT_BEATING_CHAMPION'] : []),
      ...(adj.guardrail_breaches.includes('MDD_MAX_RATIO') ? ['MDD_OVER_RATIO'] : []),
      ...(isNum(dsr) ? (dsr < g.dsr_min ? ['DSR_BELOW_MIN'] : []) : ['DSR_UNKNOWN']),
      ...(excess <= 0 ? ['EXCESS_NOT_POSITIVE'] : []),
      ...(r.participation_max > g.participation_cap ? ['PARTICIPATION_OVER_CAP'] : []),
    ];
    return { entrant_id: e.entrant_id, trial_id: e.trial_id, book_ref: e.book_ref, verdict: adj.verdict, primary: gPaired,
      paired_g: gPaired, excess_log_after_costs: excess, mdd: mine.mdd, champion_mdd: champRisk.mdd, tail_cvar5: mine.cvar5, worst_month: mine.worst_month,
      participation_max: r.participation_max,
      dsr: isNum(dsr) ? dsr : { value: dsr.value, reason: dsr.reason }, dsr_n: n.n_raw, dsr_n_is_lower_bound: n.n_is_lower_bound, dsr_known_sr: sharpes.length,
      eliminated: reasons.length > 0, reasons };
  });
}

/** 同一市场已关闭的风控分区记下的原始 p（BHY 按市场累计，从不跨市场）。 */
function priorRiskP(market) {
  const out = [];
  for (const r of heads().values()) {
    if (r.status !== 'CLOSED' || r.market !== market || r.partition !== 'RISK' || !r.outcome) continue;
    for (const e of r.outcome.entrants) out.push(e.p_one_sided);
  }
  return out;
}

function riskLayer(m, results, champ, daily) {
  const g = m.guardrails;
  const champRisk = risk(champ);
  const raw = m.challengers.map((e) => {
    const r = results.challengers[e.entrant_id];
    need(isNum(r.p_one_sided) && r.p_one_sided >= 0 && r.p_one_sided <= 1 && isText(r.p_method_ref), 'RESULT_FIELD_INVALID', `${e.entrant_id}:p_one_sided / p_method_ref`);
    return r.p_one_sided;
  });
  const prior = priorRiskP(m.market);
  const adjusted = overfit.bhy([...prior, ...raw]).slice(prior.length);
  return m.challengers.map((e, i) => {
    const s = daily[e.entrant_id];
    const mine = risk(s);
    const returnLoss = -pairedG(s, champ, m.periods_per_year);
    const reasons = [
      ...(mine.mdd > champRisk.mdd ? ['WORSE_MDD'] : []),
      ...(mine.worst_month < champRisk.worst_month ? ['WORSE_WORST_MONTH'] : []),
      ...(mine.cvar5 < champRisk.cvar5 ? ['WORSE_CVAR5'] : []),
      ...(returnLoss > e.return_loss_max ? ['RETURN_LOSS_OVER_CONSTRAINT'] : []),
      ...(adjusted[i] > g.bhy_alpha ? ['BHY_NOT_SIGNIFICANT'] : []),
    ];
    return { entrant_id: e.entrant_id, trial_id: e.trial_id, book_ref: e.book_ref, primary: mine.cvar5 - champRisk.cvar5,
      cvar5_improvement: mine.cvar5 - champRisk.cvar5, mdd: mine.mdd, worst_month: mine.worst_month, cvar5: mine.cvar5,
      champion: champRisk, return_loss: returnLoss, return_loss_max: e.return_loss_max,
      p_one_sided: raw[i], p_method_ref: results.challengers[e.entrant_id].p_method_ref, p_bhy: adjusted[i], bhy_m: prior.length + raw.length,
      eliminated: reasons.length > 0, reasons };
  });
}

/**
 * 一个分区的裁决（纯计算，读试验台账与本台账已关闭的风控分区）：淘汰线、PBO、排名、晋级。
 * PBO > pbo_max 或算不出 → INCONCLUSIVE，谁都不晋级；配置 < 4 时 PBO 不适用（由 DSR / BHY 承担）。
 */
function adjudicatePartition(m, results) {
  const { champ, daily } = checkResults(m, results);
  const pbo = partitionPbo(m, champ, daily);
  const entrants = m.partition === 'SELECTION_TIMING' ? selectionTiming(m, results, champ, daily) : riskLayer(m, results, champ, daily);
  const inconclusive = pbo.value === overfit.UNKNOWN || (isNum(pbo.value) && pbo.value > m.pbo_max);
  const survivors = entrants.filter((e) => !e.eliminated).sort((a, b) => b.primary - a.primary || (a.entrant_id < b.entrant_id ? -1 : 1));
  const promoted = inconclusive ? [] : survivors.slice(0, Math.min(m.promotion_slots, DEFAULTS.promotion_slots_max)).map((e) => e.entrant_id);
  return { state: inconclusive ? 'INCONCLUSIVE' : 'RANKED', primary_metric: m.primary_metric, pbo, champion: { entrant_id: m.champion.entrant_id, ...risk(champ) },
    entrants, ranking: survivors.map((e) => e.entrant_id), promoted, negative_results: entrants.filter((e) => e.eliminated).map((e) => e.entrant_id) };
}

/** 收赛：按 OPEN 行里冻结的清单裁决，写一行 CLOSED（负结果也入台账）。 */
function closeRace(raceId, results, { closedAt = null } = {}) {
  const head = raceHead(raceId);
  need(head, 'NOT_FOUND', raceId);
  need(head.status === 'OPEN', 'NOT_OPEN', `${raceId}:${head.status}`);
  const outcome = adjudicatePartition(head.manifest, results);
  const { record_hash: _h, ...rest } = head;
  const body = { ...rest, status: 'CLOSED', outcome, closed_at: closedAt || now() };
  body.record_hash = trials.recordHash(body);
  return append(LEDGER(), body);
}

const listRaces = () => [...heads().values()];

module.exports = {
  SCHEMA, MANIFEST_SCHEMA, LEDGER, SIGNED, MARKETS, PARTITIONS, PRIMARY, ORIGINS, DEFAULTS, CAUSALITY_NA_ALLOWED, RaceV2Error,
  openRace, closeRace, adjudicatePartition, raceHead, listRaces,
  internals: { parseManifest, verifyFreeze, entryOf, ledgerRowOf, maxDrawdown, worstMonth, cvar5, pairedG, partitionPbo, priorRiskP },
};
