'use strict';
/**
 * PAPER_VALIDATION_V1 —— 研究框架修订 2026-11-16 §5（RF1116，签字文本 fd22876f / 签字页 39f8c17c）④ 样本外模拟盘验证。
 *
 * 两类登记，都在 shadow-control 名下、写自己的台账（paper_validations.jsonl / paper_validation_evaluations.jsonl），
 * 不写也不改 shadow_runs / shadow_observations / virtual_ledger（现有影子 SHD-… 的行为不变）：
 *   - NEW：赛马（RACE_V2）关闭后晋级的参赛者。§5.3 的建议值只管这一类：
 *       起始日 = 赛马关闭后的下一个交易日，预登记、不追溯（起始日早于登记日 → 拒绝）；
 *       最小样本 = max(60 个交易日, 20 个不重叠持有期)；有离散交易的账本另要成交 ≥ 30 笔；
 *       晋级门 = CLAIM_ELIGIBLE、同期配对前向净值不低于冠军、没有护栏违约、运行健康；
 *       运行故障 → 暂停，修好后从修复日重计，之前的样本作废；
 *       经济证伪（前向最大回撤 > 1.5 × 回测最大回撤，或机制被证伪）→ 停止，记负结果；
 *       起始日后 12 个月仍不足量 → 关闭，「证据不足」，不续跑。
 *   - EXISTING：§5.4 的五个前向影子，只是登记：起始日、最小样本、停止条件、判读方式照它们自己的封存与冻结页原样录入
 *     （existing-shadows.v1.json：每项是原文摘句 + 出处 path + sha256，没写的记「未写」，不补默认值）；
 *     记录器照旧跑，QRP 只读它们的记录；§5.3 的判定不作用在这一类上。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { dataDir, now, append, read } = require('../../packages/ledger');
const { validateRecord } = require('../../schemas');
const trials = require('../trial-ledger');
const raceV2 = require('../race-orchestrator/v2');

const SCHEMA = 'PAPER_VALIDATION_V1';
const EVAL_SCHEMA = 'PAPER_VALIDATION_EVALUATION_V1';
const LEDGER = () => path.join(dataDir('shadow'), 'paper_validations.jsonl');
const EVAL_LEDGER = () => path.join(dataDir('shadow'), 'paper_validation_evaluations.jsonl');
const EXISTING_FILE = path.join(__dirname, 'existing-shadows.v1.json');
const ROOT = path.join(__dirname, '..', '..');
const SIGNED = raceV2.SIGNED;
const UNWRITTEN = '未写';

/** §5.3 建议值（只管新进来的影子）。 */
const DEFAULTS = Object.freeze({
  min_trading_days: 60,
  min_holding_periods: 20,
  min_fills_discrete: 30,
  mdd_multiple_max: 1.5,
  expiry_months: 12,
});
const FAULT_KINDS = Object.freeze(['LOOKAHEAD', 'DATA_CONTAMINATION', 'RUN_ERROR']);
const STATES = Object.freeze(['PENDING_START', 'RUNNING_DESCRIBE_ONLY', 'PAUSED_RUN_FAULT', 'CLAIM_ELIGIBLE', 'STOPPED_NEGATIVE', 'CLOSED_INSUFFICIENT']);
const TERMINAL = Object.freeze(['STOPPED_NEGATIVE', 'CLOSED_INSUFFICIENT']);
const GATE_BLOCKERS = Object.freeze(['NOT_CLAIM_ELIGIBLE', 'NAV_BELOW_CHAMPION', 'GUARDRAIL_BREACH', 'RUN_NOT_HEALTHY']);
const RULE_FIELDS = Object.freeze(['start', 'min_sample', 'promotion_gate', 'withdrawal', 'expiry', 'champion', 'pairing', 'reading', 'holding_period']);
const MARKET_TZ = Object.freeze({ CN_A: 'Asia/Shanghai', US: 'America/New_York', CRYPTO: 'UTC' });

class PaperValidationError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new PaperValidationError(`PAPER_VALIDATION_${code}`, detail); };
const need = (c, code, detail) => { if (!c) fail(code, detail); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SHA64 = /^[0-9a-f]{64}$/;

/** ISO 时刻 → 该市场的本地日期（A 股按北京时间，美股按纽约时间，加密按 UTC）。 */
function marketDate(iso, market) {
  need(MARKET_TZ[market], 'MARKET_INVALID', market);
  const t = Date.parse(iso);
  need(Number.isFinite(t), 'TIME_INVALID', iso);
  return new Intl.DateTimeFormat('en-CA', { timeZone: MARKET_TZ[market], year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

/** 开盘时刻（协调会话 2026-11-17 02:2x：「预登记」按字面读）：A 股 09:30 +08，美股 09:30 纽约时间（按当天的夏令时），加密 00:00 UTC。 */
const MARKET_OPEN = Object.freeze({ CN_A: '09:30', US: '09:30', CRYPTO: '00:00' });
function tzOffsetMinutes(t, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
  const g = (k) => Number(parts.find((p) => p.type === k).value);
  return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - t) / 60000);
}
/** 某个交易日在该市场开盘的 UTC 时刻（ISO）。 */
function marketOpenAt(date, market) {
  need(MARKET_TZ[market] && isDate(date), 'MARKET_INVALID', `${market}:${date}`);
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = MARKET_OPEN[market].split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall - tzOffsetMinutes(wall, MARKET_TZ[market]) * 60000;
  t = wall - tzOffsetMinutes(t, MARKET_TZ[market]) * 60000; // 夏令时切换当天再校一次
  return new Date(t).toISOString();
}

/** 日期加 n 个月（月末对齐：01-31 + 1 个月 = 02-28/29）。 */
function addMonths(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12); const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** §5.3 最小样本：max(60 个交易日, 20 × 持有期交易日)；有离散交易另要成交 ≥ 30 笔。 */
function minSampleOf(holdingDays, discrete) {
  need(Number.isInteger(holdingDays) && holdingDays >= 1, 'HOLDING_PERIOD_INVALID', holdingDays);
  need(typeof discrete === 'boolean', 'DISCRETE_TRADES_UNDECLARED');
  return {
    rule: 'MAX_60_TRADING_DAYS_OR_20_HOLDING_PERIODS',
    holding_period_trading_days: holdingDays,
    trading_days: Math.max(DEFAULTS.min_trading_days, DEFAULTS.min_holding_periods * holdingDays),
    fills: discrete ? DEFAULTS.min_fills_discrete : null,
    discrete_trades: discrete,
  };
}

/** 赛马头行：必须是记录哈希对得上的 CLOSED 行。 */
function closedRace(raceId) {
  const head = raceV2.raceHead(raceId);
  need(head, 'RACE_NOT_FOUND', raceId);
  need(head.status === 'CLOSED' && isObj(head.outcome), 'RACE_NOT_CLOSED', `${raceId}:${head.status}`);
  need(trials.recordHash(head) === head.record_hash, 'RACE_RECORD_HASH_MISMATCH', raceId);
  return head;
}

const heads = (file, key) => { const m = new Map(); for (const r of read(file)) m.set(r[key], r); return m; };
const registration = (id) => heads(LEDGER(), 'validation_id').get(id) || null;
const evaluations = (id) => read(EVAL_LEDGER()).filter((r) => r.validation_id === id);
const lastEvaluation = (id) => { const rows = evaluations(id); return rows.length ? rows[rows.length - 1] : null; };

function seal(rec, schema) {
  rec.record_hash = trials.recordHash(rec);
  const v = validateRecord(rec, schema);
  need(v.ok, 'SCHEMA_INVALID', v.problems.join(','));
  return rec;
}

/**
 * 登记一个新影子（NEW）。开跑之前冻结：同一 validation_id 只能登记一次。
 * @param {object} o
 * @param {{race_id: string, entrant_id: string}} o.race  已关闭、该参赛者在 outcome.promoted 里
 * @param {string} o.shadow_ref  跑这个影子的 shadow-control 行（SHADOW_RUN_V1 的 shadow_id）
 * @param {{ref: string, days: string[]}} o.calendar  该市场的交易日历（只用来求「下一个交易日」）
 * @param {number} o.holding_period_trading_days
 * @param {boolean} o.discrete_trades
 * @param {string} [o.start_date]  不给就取赛马关闭后的下一个交易日；给了必须等于它
 * @param {{ref: string, statement_zh: string}} o.mechanism  被证伪即停止的机制
 * @param {string} [o.registeredAt]  ISO 时刻（测试用），默认现在
 */
function registerNew(o = {}) {
  need(isObj(o.race) && isText(o.race.race_id) && isText(o.race.entrant_id), 'RACE_REF_MISSING');
  need(isText(o.shadow_ref), 'SHADOW_REF_MISSING');
  need(isObj(o.mechanism) && isText(o.mechanism.ref) && isText(o.mechanism.statement_zh), 'MECHANISM_MISSING');
  const head = closedRace(o.race.race_id);
  const market = head.market;
  const entrant = (head.outcome.entrants || []).find((e) => e.entrant_id === o.race.entrant_id);
  need(entrant, 'ENTRANT_NOT_IN_RACE', o.race.entrant_id);
  need((head.outcome.promoted || []).includes(o.race.entrant_id), 'ENTRANT_NOT_PROMOTED', o.race.entrant_id);
  need(isNum(entrant.mdd) && entrant.mdd >= 0, 'BACKTEST_MDD_MISSING', o.race.entrant_id);
  need(entrant.mdd > 0, 'BACKTEST_DRAWDOWN_ZERO', o.race.entrant_id); // 1.5 倍的上限会是 0，任何回撤都停：登记即拒（协调会话 02:2x）

  need(isObj(o.calendar) && isText(o.calendar.ref) && Array.isArray(o.calendar.days) && o.calendar.days.every(isDate), 'CALENDAR_INVALID');
  const closedOn = marketDate(head.closed_at, market);
  const days = [...new Set(o.calendar.days)].sort();
  const next = days.find((d) => d > closedOn);
  need(next, 'CALENDAR_INCOMPLETE', `no trading day after ${closedOn}`);
  const original = o.start_date === undefined ? next : o.start_date;
  need(isDate(original), 'START_DATE_INVALID', original);
  need(original === next, 'START_NOT_NEXT_TRADING_DAY_AFTER_RACE_CLOSE', `${original}≠${next}`);
  const registeredAt = o.registeredAt || now();
  need(Number.isFinite(Date.parse(registeredAt)), 'TIME_INVALID', registeredAt);
  const registeredOn = marketDate(registeredAt, market);
  // 「预登记」：起始会话开盘时或之后才登记（同一天）→ 顺延到日历里的下一个交易日，记原因与原起始日；晚于原起始日登记仍拒绝
  const openAt = marketOpenAt(original, market);
  let start = original; let shift = null;
  if (registeredOn === original && Date.parse(registeredAt) >= Date.parse(openAt)) {
    start = days.find((d) => d > original);
    need(start, 'CALENDAR_INCOMPLETE', `no trading day after ${original}`);
    shift = { reason: 'START_SHIFTED_REGISTERED_AFTER_OPEN', original_date: original, open_at: openAt };
  }
  need(start >= registeredOn, 'START_BEFORE_REGISTRATION', `${start}<${registeredOn}`);

  const validationId = `PV-${market}-${sha256(`${head.race_id}|${o.race.entrant_id}`).slice(0, 12)}`;
  need(!registration(validationId), 'ALREADY_REGISTERED', validationId);
  const rec = {
    schema: SCHEMA, validation_id: validationId, kind: 'NEW', shadow_key: `${head.race_id}:${o.race.entrant_id}`, market,
    shadow_ref: o.shadow_ref, book_ref: entrant.book_ref || null, run_by: null,
    race: { race_id: head.race_id, manifest_sha256: head.manifest_sha256, race_record_hash: head.record_hash, entrant_id: o.race.entrant_id, closed_on: closedOn },
    registered_on: registeredOn,
    start: { rule: 'NEXT_TRADING_DAY_AFTER_RACE_CLOSE', date: start, ...(shift ? { shift } : {}), calendar_ref: o.calendar.ref, calendar_sha256: sha256(JSON.stringify(days)) },
    min_sample: minSampleOf(o.holding_period_trading_days, o.discrete_trades),
    promotion_gate: { rule: 'ALL_OF', requires: [...GATE_BLOCKERS] },
    withdrawal: {
      run_fault: { kinds: [...FAULT_KINDS], action: 'PAUSE_THEN_RECOUNT_FROM_FIX_DATE_VOID_EARLIER' },
      economic: { forward_mdd_multiple_max: DEFAULTS.mdd_multiple_max, backtest_mdd: entrant.mdd, forward_mdd_limit: DEFAULTS.mdd_multiple_max * entrant.mdd,
        mechanism: { ref: o.mechanism.ref, statement_zh: o.mechanism.statement_zh }, action: 'STOP_RECORD_NEGATIVE' },
    },
    expiry: { months: DEFAULTS.expiry_months, date: addMonths(start, DEFAULTS.expiry_months), action: 'CLOSE_INSUFFICIENT_NO_EXTENSION', verdict_zh: '证据不足' },
    champion: { entrant_id: head.manifest.champion.entrant_id, book_ref: head.manifest.champion.book_ref || null, backtest_mdd: head.outcome.champion ? head.outcome.champion.mdd : null },
    pairing: { method: 'SAME_PERIOD_PAIRED_FORWARD_NAV', basis_zh: '同一 PIT 输入、同一 K 线截点、同一成本模型；只比同期计入的会话（暂停与作废的会话两边都不计）' },
    reading: null, holding_period: null,
    sources: [], unverified: [], signed: SIGNED, registeredAt,
  };
  return append(LEDGER(), seal(rec, SCHEMA));
}

function checkForward(f, reg) {
  need(isObj(f), 'FORWARD_MISSING');
  need(isObj(f.source) && isText(f.source.ref) && SHA64.test(f.source.sha256 || ''), 'FORWARD_SOURCE_MISSING');
  need(Array.isArray(f.sessions), 'FORWARD_SESSIONS_MISSING');
  const seen = new Set();
  for (const s of f.sessions) {
    need(isObj(s) && isDate(s.date), 'FORWARD_SESSION_INVALID', JSON.stringify(s));
    need(!seen.has(s.date), 'FORWARD_DUPLICATE_SESSION', s.date); seen.add(s.date);
    need(isNum(s.challenger_logret) && isNum(s.champion_logret), 'FORWARD_SESSION_RETURNS_MISSING', s.date);
    if (reg.min_sample.discrete_trades) need(Number.isInteger(s.fills) && s.fills >= 0, 'FORWARD_SESSION_FILLS_MISSING', s.date);
  }
  need(Array.isArray(f.faults), 'FORWARD_FAULTS_MISSING');
  for (const x of f.faults) {
    need(isObj(x) && FAULT_KINDS.includes(x.kind) && isDate(x.detected_on) && isText(x.ref), 'FAULT_INVALID', JSON.stringify(x));
    need(x.fixed_on === null || (isDate(x.fixed_on) && x.fixed_on >= x.detected_on), 'FAULT_FIX_DATE_INVALID', x.ref);
  }
  need(f.mechanism_falsified === null || (isObj(f.mechanism_falsified) && isDate(f.mechanism_falsified.on) && isText(f.mechanism_falsified.ref)), 'MECHANISM_FALSIFIED_INVALID');
  need(Array.isArray(f.guardrail_breaches) && f.guardrail_breaches.every((b) => isObj(b) && isDate(b.date) && isText(b.guardrail) && isText(b.ref)), 'GUARDRAIL_BREACHES_INVALID');
  need(isObj(f.run_health) && typeof f.run_health.healthy === 'boolean' && isText(f.run_health.ref), 'RUN_HEALTH_MISSING');
}

/**
 * §5.3 判定（纯函数）：按日期顺序走一遍。同一天里先记故障发现、再记修复、再看机制、最后记会话。
 *   - 故障发现：已计入的样本作废，暂停；修复日起重计（修复日当天的会话计入）；
 *   - 机制被证伪、或计入会话的前向最大回撤 > 1.5 × 回测最大回撤：停止，负结果；
 *   - 到期日（起始日 + 12 个月）当天走完仍不足量，或之后任何时候不足量：关闭，「证据不足」。
 */
function evaluate(reg, forward, asOf) {
  need(isObj(reg) && reg.schema === SCHEMA, 'REGISTRATION_INVALID');
  need(reg.kind === 'NEW', 'EXISTING_SHADOW_RULES_ARE_ITS_OWN', reg.validation_id);
  need(isDate(asOf), 'AS_OF_INVALID', asOf);
  checkForward(forward, reg);
  const start = reg.start.date; const expiry = reg.expiry.date;
  const limit = reg.withdrawal.economic.forward_mdd_limit;
  const need_ = reg.min_sample;
  const c = { sessions: 0, fills: 0, chal: 0, champ: 0, peak: 0, mdd: 0, from: start };
  let voided = 0; let pausedSessions = 0; let ignoredPreStart = 0;
  const open = new Set();
  const met = () => c.sessions >= need_.trading_days && (need_.fills === null || c.fills >= need_.fills);
  const reset = () => { voided += c.sessions; Object.assign(c, { sessions: 0, fills: 0, chal: 0, champ: 0, peak: 0, mdd: 0 }); };

  const byDate = new Map();
  const at = (d) => { if (!byDate.has(d)) byDate.set(d, { detect: [], fix: [], mech: null, session: null }); return byDate.get(d); };
  forward.faults.forEach((x, i) => {
    at(x.detected_on < start ? start : x.detected_on).detect.push(i);
    if (x.fixed_on !== null) at(x.fixed_on < start ? start : x.fixed_on).fix.push(i);
  });
  if (forward.mechanism_falsified) at(forward.mechanism_falsified.on < start ? start : forward.mechanism_falsified.on).mech = forward.mechanism_falsified;
  for (const s of forward.sessions) { if (s.date < start) ignoredPreStart++; else at(s.date).session = s; }

  let state = null; let terminalOn = null; const reasons = [];
  if (asOf < start) state = 'PENDING_START';
  for (const d of [...byDate.keys()].sort()) {
    if (state || d > asOf) break;
    if (d > expiry && !met()) { state = 'CLOSED_INSUFFICIENT'; terminalOn = expiry; reasons.push('EXPIRED_SAMPLE_NOT_MET'); break; }
    const e = byDate.get(d);
    for (const i of e.detect) { if (!open.size) reset(); open.add(i); }
    for (const i of e.fix) { if (open.delete(i) && !open.size) c.from = d; }
    if (e.mech) { state = 'STOPPED_NEGATIVE'; terminalOn = d; reasons.push('MECHANISM_FALSIFIED'); break; }
    const s = e.session;
    if (!s) continue;
    if (open.size) { pausedSessions++; continue; }
    c.sessions++; c.fills += s.fills || 0; c.chal += s.challenger_logret; c.champ += s.champion_logret;
    c.peak = Math.max(c.peak, c.chal); c.mdd = Math.max(c.mdd, 1 - Math.exp(c.chal - c.peak));
    if (c.mdd > limit) { state = 'STOPPED_NEGATIVE'; terminalOn = d; reasons.push('FORWARD_MDD_OVER_1_5X_BACKTEST'); break; }
  }
  if (!state) {
    if (asOf >= expiry && !met()) { state = 'CLOSED_INSUFFICIENT'; terminalOn = expiry; reasons.push('EXPIRED_SAMPLE_NOT_MET'); }
    else if (open.size) { state = 'PAUSED_RUN_FAULT'; reasons.push('RUN_FAULT_OPEN'); }
    else state = met() ? 'CLAIM_ELIGIBLE' : 'RUNNING_DESCRIBE_ONLY';
  }
  const claim = state === 'CLAIM_ELIGIBLE' ? 'CLAIM_ELIGIBLE' : 'DESCRIBE_ONLY';
  const breaches = forward.guardrail_breaches.filter((b) => b.date >= start && b.date <= asOf);
  const blockers = [
    ...(claim !== 'CLAIM_ELIGIBLE' ? ['NOT_CLAIM_ELIGIBLE'] : []),
    ...(c.chal < c.champ ? ['NAV_BELOW_CHAMPION'] : []),
    ...(breaches.length ? ['GUARDRAIL_BREACH'] : []),
    ...(!forward.run_health.healthy || open.size ? ['RUN_NOT_HEALTHY'] : []),
  ];
  return {
    validation_id: reg.validation_id, as_of: asOf, state, claim_status: claim, terminal_on: terminalOn, reasons,
    counted: { from: c.from, sessions: c.sessions, fills: need_.discrete_trades ? c.fills : null, required_sessions: need_.trading_days, required_fills: need_.fills },
    voided_sessions: voided, paused_sessions: pausedSessions, ignored_pre_start_sessions: ignoredPreStart,
    forward_mdd: c.mdd, forward_mdd_limit: limit,
    paired_nav: { challenger: Math.exp(c.chal), champion: Math.exp(c.champ), sessions: c.sessions },
    guardrail_breaches: breaches.map((b) => ({ date: b.date, guardrail: b.guardrail, ref: b.ref })),
    promotion_gate: { pass: blockers.length === 0, blockers },
  };
}

/** 记一次判定（台账追加）。终态（停止 / 关闭）之后不再记；as_of 不能倒退。 */
function recordEvaluation(validationId, forward, { asOf, evaluatedAt = null } = {}) {
  const reg = registration(validationId);
  need(reg, 'NOT_FOUND', validationId);
  const prev = lastEvaluation(validationId);
  if (prev) {
    need(!TERMINAL.includes(prev.state), 'TERMINAL', `${validationId}:${prev.state}@${prev.as_of}`);
    need(asOf >= prev.as_of, 'AS_OF_BACKWARDS', `${asOf}<${prev.as_of}`);
  }
  const out = evaluate(reg, forward, asOf);
  const rec = { schema: EVAL_SCHEMA, ...out, registration_hash: reg.record_hash,
    input_ref: forward.source.ref, input_sha256: sha256(trials.canonicalJson(forward)), evaluated_at: evaluatedAt || now() };
  return append(EVAL_LEDGER(), seal(rec, EVAL_SCHEMA));
}

/**
 * PROMOTION_CANDIDATE_V1 的赛马路径（strategy-control-plane 调用）：
 * 赛马清单引用对得上一场已关闭的 RACE_V2；每个模拟盘登记是 NEW、同一场赛马、同一市场、它的影子在 shadow_forward_refs 里，
 * 且最近一次判定的晋级门通过。任何一条不满足 → 抛 PROMOTION_*。
 */
function promotionGateFor({ market, race_manifest_ref: ref, paper_validation_refs: ids, shadow_forward_refs: shadows = [] } = {}) {
  const bad = (code, detail) => { throw new PaperValidationError(`PROMOTION_${code}`, detail); };
  if (!isObj(ref) || !isText(ref.race_id) || !SHA64.test(ref.manifest_sha256 || '')) bad('RACE_MANIFEST_REF_REQUIRED');
  if (!Array.isArray(ids) || !ids.length || !ids.every(isText)) bad('PAPER_VALIDATION_REFS_REQUIRED');
  const head = raceV2.raceHead(ref.race_id);
  if (!head || head.status !== 'CLOSED') bad('RACE_NOT_CLOSED', ref.race_id);
  if (head.manifest_sha256 !== ref.manifest_sha256) bad('RACE_MANIFEST_MISMATCH', ref.race_id);
  if (head.market !== market) bad('RACE_MARKET_MISMATCH', `${head.market}≠${market}`);
  const detail = {};
  for (const id of ids) {
    const reg = registration(id);
    if (!reg || reg.kind !== 'NEW') bad('PAPER_VALIDATION_NOT_FOUND', id);
    if (reg.race.race_id !== ref.race_id || reg.race.manifest_sha256 !== ref.manifest_sha256) bad('PAPER_VALIDATION_RACE_MISMATCH', id);
    if (!(head.outcome.promoted || []).includes(reg.race.entrant_id)) bad('PAPER_VALIDATION_ENTRANT_NOT_PROMOTED', id);
    if (!shadows.includes(reg.shadow_ref)) bad('PAPER_VALIDATION_SHADOW_NOT_REFERENCED', `${id}:${reg.shadow_ref}`);
    const ev = lastEvaluation(id);
    if (!ev) bad('PAPER_VALIDATION_NOT_EVALUATED', id);
    if (!ev.promotion_gate.pass) bad('PAPER_VALIDATION_GATE_FAILED', `${id}:${ev.promotion_gate.blockers.join('+')}`);
    detail[id] = { evaluation_hash: ev.record_hash, as_of: ev.as_of, state: ev.state, pass: true };
  }
  return { race_manifest_ref: { race_id: ref.race_id, manifest_sha256: ref.manifest_sha256 }, paper_validation_refs: [...ids], paper_validation_gate: detail };
}

// ---------- 现有的五个前向影子（§5.4）：只登记，原样录入 ----------

function loadExisting() { return JSON.parse(fs.readFileSync(EXISTING_FILE, 'utf8')); }

function checkExistingConfig(cfg) {
  need(cfg.schema === 'PAPER_VALIDATION_EXISTING_SHADOWS_V1' && cfg.unwritten === UNWRITTEN, 'EXISTING_CONFIG_INVALID');
  for (const [id, s] of Object.entries(cfg.sources)) {
    need(isText(s.path) && SHA64.test(s.sha256 || '') && ['coordinator', 'smartflow'].includes(s.repo), 'EXISTING_SOURCE_INVALID', id);
    if (s.repo === 'smartflow') need(/^[0-9a-f]{40}$/.test(s.commit || ''), 'EXISTING_SOURCE_COMMIT_MISSING', id);
    if (s.freeze_record) need(isText(s.freeze_record.section_quote) && isObj(s.freeze_record.queue_log) && isText(s.freeze_record.queue_log.path) && isText(s.freeze_record.queue_log.line_quote), 'EXISTING_FREEZE_RECORD_INVALID', id);
  }
  for (const sh of cfg.shadows) {
    need(isText(sh.shadow_key) && MARKET_TZ[sh.market] && isText(sh.run_by), 'EXISTING_SHADOW_INVALID', sh.shadow_key);
    need(Object.keys(sh.fields).join() === RULE_FIELDS.join(), 'EXISTING_FIELDS_ORDER', sh.shadow_key);
    for (const [f, v] of Object.entries(sh.fields)) {
      if (v === UNWRITTEN) continue;
      need(Array.isArray(v) && v.length && v.every((q) => isObj(q) && cfg.sources[q.source] && isText(q.quote)), 'EXISTING_FIELD_INVALID', `${sh.shadow_key}.${f}`);
    }
    need(isObj(sh.listed_as) && cfg.sources[sh.listed_as.source] && isText(sh.listed_as.quote)
      && sh.listed_as.quote.includes(sh.book_zh) && sh.listed_as.quote.includes(sh.run_by), 'EXISTING_LISTING_INVALID', sh.shadow_key);
    need(Array.isArray(sh.consulted) && sh.consulted.every((id) => cfg.sources[id]), 'EXISTING_CONSULTED_INVALID', sh.shadow_key);
    need(Array.isArray(sh.unverified) && sh.unverified.every(isText), 'EXISTING_UNVERIFIED_INVALID', sh.shadow_key);
  }
  return cfg;
}

/** 由 existing-shadows.v1.json 原样生成五条 PAPER_VALIDATION_V1（不读时钟、不补默认值）。 */
function existingRecords(cfg = loadExisting()) {
  checkExistingConfig(cfg);
  return cfg.shadows.map((sh) => {
    const cited = [...new Set([sh.listed_as.source, ...Object.values(sh.fields).flatMap((v) => (v === UNWRITTEN ? [] : v.map((q) => q.source))), ...sh.consulted])];
    const field = (f) => (sh.fields[f] === UNWRITTEN ? { as_written: UNWRITTEN } : { as_written: sh.fields[f].map((q) => ({ source: q.source, quote: q.quote })) });
    const rec = { schema: SCHEMA, validation_id: `PV-EXISTING-${sh.shadow_key}`, kind: 'EXISTING', shadow_key: sh.shadow_key, market: sh.market,
      shadow_ref: null, book_ref: sh.book_zh, run_by: sh.run_by, race: null, registered_on: cfg.registered_on,
      ...Object.fromEntries(RULE_FIELDS.map((f) => [f, field(f)])),
      sources: cited.map((id) => ({ id, ...cfg.sources[id] })), unverified: [...sh.unverified], signed: SIGNED, registeredAt: cfg.registered_at };
    return seal(rec, SCHEMA);
  });
}

/** 一条登记去掉取代信息后的内容。 */
const coreOf = (r) => { const { record_hash: _h, supersedes: _s, supersede_reason: _r, supersede_changes: _c, superseded_at: _t, idempotent_skip: _i, ...rest } = r; return trials.canonicalJson(rest); };

/**
 * 新旧两条之间只是追加吗：账本身份（shadow_key、市场、账本、谁跑）不变；每个规则字段原有的摘句一条不改、按原顺序是新列表的前缀
 * （「未写」可以换成摘句，摘句不能变回「未写」）；原有的出处一个不改（可以加新的）；unverified 随意。返回变了的项，不是追加则 null。
 */
function additiveChanges(old, rec) {
  if (['shadow_key', 'market', 'book_ref', 'run_by'].some((k) => old[k] !== rec[k])) return null;
  const changes = [];
  for (const f of RULE_FIELDS) {
    const a = old[f].as_written; const b = rec[f].as_written;
    if (trials.canonicalJson(a) === trials.canonicalJson(b)) continue;
    if (a !== UNWRITTEN && (b === UNWRITTEN || b.length < a.length || trials.canonicalJson(b.slice(0, a.length)) !== trials.canonicalJson(a))) return null;
    changes.push(f);
  }
  const now_ = new Map(rec.sources.map((x) => [x.id, trials.canonicalJson(x)]));
  if (!old.sources.every((x) => now_.get(x.id) === trials.canonicalJson(x))) return null;
  if (rec.sources.length !== old.sources.length) changes.push('sources');
  if (trials.canonicalJson(old.unverified) !== trials.canonicalJson(rec.unverified)) changes.push('unverified');
  return changes;
}

/**
 * 把五条写进登记台账。幂等：同一条已在则跳过。同 id 内容变了：
 *   - 只是追加（出处与摘句只增不改、「未写」补上摘句、unverified 变了）→ 追加一行取代（supersedes = 旧行的 record_hash，
 *     supersede_changes 列出变了的项），旧行逐字节不动；
 *   - 改了或删了原有的摘句、出处或账本身份 → 拒绝（EXISTING_REGISTRATION_CHANGED）。
 */
function registerExisting(cfg = loadExisting()) {
  const have = heads(LEDGER(), 'validation_id');
  return existingRecords(cfg).map((rec) => {
    const old = have.get(rec.validation_id);
    if (!old) return append(LEDGER(), rec);
    if (coreOf(old) === coreOf(rec)) return { ...old, idempotent_skip: true };
    const changes = additiveChanges(old, rec);
    need(changes, 'EXISTING_REGISTRATION_CHANGED', rec.validation_id);
    const { record_hash: _h, ...body } = rec;
    return append(LEDGER(), seal({ ...body, supersedes: old.record_hash, supersede_reason: 'ADDITIVE_UPDATE', supersede_changes: changes, superseded_at: now() }, SCHEMA));
  });
}

/**
 * 逐字节核对出处：协调目录的文件（QRP_COORDINATOR_DIR，默认仓库旁的 artifacts/coordinator）、smartflow 的 git 对象
 * （QRP_SMARTFLOW_REPO，默认仓库旁的 smartflow）。读不到的记 ABSENT（不当作通过）；sha 不对、摘句不在原文里 → 记出来。
 */
function verifySources(cfg = loadExisting(), { coordinatorDir, smartflowRepo } = {}) {
  checkExistingConfig(cfg);
  const cdir = coordinatorDir || process.env.QRP_COORDINATOR_DIR || path.join(ROOT, '..', 'artifacts', 'coordinator');
  const srepo = smartflowRepo || process.env.QRP_SMARTFLOW_REPO || path.join(ROOT, '..', 'smartflow');
  const bytesOf = (s) => {
    try {
      if (s.repo === 'coordinator') return fs.readFileSync(path.join(cdir, path.basename(s.path)));
      return execFileSync('git', ['-C', srepo, 'show', `${s.commit}:${s.path}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
    } catch { return null; }
  };
  const sources = {};
  for (const [id, s] of Object.entries(cfg.sources)) {
    const b = bytesOf(s);
    sources[id] = { state: b === null ? 'ABSENT' : (sha256(b) === s.sha256 ? 'MATCH' : 'SHA_MISMATCH'), bytes: b };
  }
  const quotes = [];
  for (const sh of cfg.shadows) {
    for (const [f, v] of [['listed_as', [sh.listed_as]], ...Object.entries(sh.fields)]) {
      if (v === UNWRITTEN) continue;
      for (const q of v) {
        const src = sources[q.source];
        const state = src.state !== 'MATCH' ? src.state : (src.bytes.indexOf(Buffer.from(q.quote, 'utf8')) >= 0 ? 'FOUND' : 'QUOTE_NOT_IN_SOURCE');
        quotes.push({ shadow_key: sh.shadow_key, field: f, source: q.source, state });
      }
    }
  }
  // 冻结记录（标题仍写草稿、冻结写在页内「冻结」一节与队列日志的一行）：一节的原文在出处里；队列日志只追加、不钉 sha，查那一行在不在
  const freezeRecords = Object.entries(cfg.sources).filter(([, s]) => s.freeze_record).map(([id, s]) => {
    const src = sources[id];
    const section = src.state !== 'MATCH' ? src.state : (src.bytes.indexOf(Buffer.from(s.freeze_record.section_quote, 'utf8')) >= 0 ? 'FOUND' : 'QUOTE_NOT_IN_SOURCE');
    let queue = 'ABSENT';
    try {
      const log = fs.readFileSync(path.join(cdir, path.relative('artifacts/coordinator', s.freeze_record.queue_log.path)));
      queue = log.indexOf(Buffer.from(s.freeze_record.queue_log.line_quote, 'utf8')) >= 0 ? 'FOUND' : 'LINE_NOT_IN_LOG';
    } catch { /* 读不到记 ABSENT */ }
    return { source: id, section, queue_line: queue };
  });
  return { sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.state])), quotes, freeze_records: freezeRecords };
}

module.exports = {
  SCHEMA, EVAL_SCHEMA, LEDGER, EVAL_LEDGER, EXISTING_FILE, SIGNED, UNWRITTEN, DEFAULTS, FAULT_KINDS, STATES, TERMINAL, GATE_BLOCKERS, RULE_FIELDS,
  PaperValidationError, registerNew, evaluate, recordEvaluation, promotionGateFor, registration, evaluations, lastEvaluation,
  loadExisting, existingRecords, registerExisting, verifySources,
  internals: { marketDate, marketOpenAt, addMonths, minSampleOf, closedRace, checkExistingConfig },
};
