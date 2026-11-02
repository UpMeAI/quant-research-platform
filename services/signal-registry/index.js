'use strict';
/**
 * SIGNAL_REGISTRY_V1 —— 美股、加密的信号登记簿（系统分析报告 V1 §4：序列少，不建因子库，建信号登记簿；§10「美股、加密从记分牌补齐」）。
 * 规格：docs/contracts/SIGNAL_REGISTRY_V1.md。
 *
 * 一行 = 一本在跑账本（或 C17 的一个部分）里的一条入场信号，信号取开仓成交上记录的 decision.reasonCodes。每行给三个窗口
 * （自起始、当前规则版本、上一规则版本）的命中率（= 记分牌 winRate）、每笔期望（R：avgR；金额：expectancyAmount_like，
 * 账本自己记的费用之后）、已平笔数，以及按市场状态拆开的同三项。
 *
 * 只读、纯计算：读 desk 收件箱里生产方已交付的文件（STRATEGY_SCOREBOARD_V1、TRADE_LEDGER_V1、该周 STRATEGY_REVIEW_V1、
 * POSITION_LEDGER_SNAPSHOT_V1），不联网、不取数、不写台账、不碰生产参数。窗口边界、版本段、状态标签都用记分牌交付的，
 * 不由 S17 记录或映射表重算；登记簿只把记分牌没有的部分（按信号拆、金额期望、样本不足以下的计数）补上。
 * 「零、未知、不适用、样本不足」分开，未知为 null + 原因码，不补 0（METRIC_DEFINITIONS_V1 §9.3、§9.4）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'SIGNAL_REGISTRY_V1';
const RATE_FLOOR = 30; // REVIEW_LOOP_ACCEPTANCE_V1 D5 (a)：胜率与平均 R 已平 ≥ 30 笔才出比率
const CELL_FLOOR = 20; // 增补 4 D9 (a)：状态格 20 笔
const WINDOWS = Object.freeze(['bookSinceStart', 'currentVersion', 'previousVersion']);
const SPLIT_WINDOWS = Object.freeze(['bookSinceStart', 'currentVersion']);
const COSTS = Object.freeze(['fee', 'funding', 'slippage']);
const DAY_MS = 86400000;
const MAJORS = Object.freeze(['BTCUSDT', 'ETHUSDT']); // REVIEW_LOOP_ACCEPTANCE_V1 增补 2 §5.1：按品种，BTCUSDT、ETHUSDT 归 BTC_ETH

/**
 * 四本账本。US_CORE 是轮动账本：没有往返交易、没有初始止损（记分牌 usScoreboard 传 trades: []、noInitialStop），
 * 所以只有账本级的一行汇总，费用按换仓成交的建模费用。QUICK_SHOT_V3 不在增补 4 的状态拆分范围（只有 US_V5 与 C17_V2）。
 */
const BOOKS = Object.freeze({
  US_V5_ETF_3000USD: Object.freeze({ market: 'US', producerDir: 'SMARTFLOW_US', currency: 'USD', rotation: false, pnlIsGross: true }),
  US_CORE_9000USD_3X_GATEOBS: Object.freeze({ market: 'US', producerDir: 'SMARTFLOW_US', currency: 'USD', rotation: true, pnlIsGross: false,
    noSplit: 'NOT_APPLICABLE:NO_LOTS_ROTATION_BOOK' }),
  C17_V2_4000USDT: Object.freeze({ market: 'CRYPTO', producerDir: 'SMARTFLOW_CRYPTO', currency: 'USDT', rotation: false, pnlIsGross: false,
    parts: Object.freeze({ BTC_ETH: (s) => MAJORS.includes(s), NON_MAJOR: (s) => !MAJORS.includes(s) }) }),
  QUICK_SHOT_V3_1000USDT: Object.freeze({ market: 'CRYPTO', producerDir: 'SMARTFLOW_CRYPTO', currency: 'USDT', rotation: false, pnlIsGross: false,
    noSplit: 'NOT_AVAILABLE:STATE_SPLIT_NOT_IN_SCOPE_FOR_BOOK' }),
});

const CODES = Object.freeze({
  NO_CLOSED_TRADE: 'NOT_APPLICABLE:NO_CLOSED_TRADE',
  NO_INITIAL_STOP: 'NOT_APPLICABLE:NO_INITIAL_STOP',
  NOT_A_PERPETUAL: 'NOT_APPLICABLE:NOT_A_PERPETUAL',
  SLIPPAGE_IN_FILL: 'NOT_APPLICABLE:SLIPPAGE_INSIDE_MODELLED_FILL_PRICE',
  NO_ROUND_TRIP: 'NOT_APPLICABLE:NO_ROUND_TRIP_TRADES',
  PNL_NOT_RECORDED: 'TRADE_PNL_NOT_RECORDED',
  RISK_UNIT_NOT_RECORDED: 'RISK_UNIT_NOT_RECORDED',
  T_ZERO_VARIANCE: 'T_STAT_ZERO_VARIANCE',
  CELL_UNKNOWN: 'NOT_APPLICABLE:CELL_STATE_UNKNOWN',
  CELL_NOT_APPLICABLE: 'NOT_APPLICABLE:CELL_STATE_NOT_APPLICABLE',
  ENTRY_NOT_IN_LEDGER: 'UNKNOWN:ENTRY_FILL_NOT_IN_LEDGER',
});
const NOT_MEASURED_REASON = Object.freeze({ fee: 'FEE_NOT_REPORTED', funding: 'FUNDING_NOT_RECORDED', slippage: 'SLIPPAGE_NOT_MEASURED' });

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 1e4) / 1e4;
const round6 = (v) => Math.round(v * 1e6) / 1e6;
/**
 * 比率的取整由谁出数决定：汇总行（signalKey '*'）的字段记分牌也有，照记分牌导出的样子（窗口 4 位、状态格不取整），逐字比较；
 * 信号行是登记簿自己算的，按 METRIC_DEFINITIONS_V1 §10.2 取 6 位（协调会话 2026-11-02 裁定）。
 */
const RATIO = Object.freeze({ SCOREBOARD: Object.freeze({ window: (v) => round4(round4(v)), cell: (v) => v }), OWN: Object.freeze({ window: round6, cell: round6 }) });
const iso = (ms) => new Date(ms).toISOString();
const stat = (value, state, reasonCode = null) => ({ value, state, reasonCode });
const money = (state, amount = null, reasonCode = null) => ({ state, amount, reasonCode });
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------------------------------------ hashing

/** desk `src/canonical.js`：每层键排序、紧凑分隔；hash = 去掉 hash 字段后的 sha256。 */
function canonicalJson(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('CANONICAL_NON_FINITE_NUMBER');
  return JSON.stringify(v);
}
function contentHash(payload, field = 'hash') {
  const { [field]: _omit, ...rest } = payload;
  return crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex');
}
const withHash = (payload) => ({ ...payload, hash: contentHash(payload) });

// ------------------------------------------------------------------------------------------------ clocks

function etParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
function etInstant(day, hh, mm) {
  for (const offset of ['-04:00', '-05:00']) {
    const ms = Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00${offset}`);
    const p = etParts(ms);
    if (p.date === day && p.hour === hh && p.minute === mm) return ms;
  }
  throw new Error(`ET_INSTANT_UNRESOLVED:${day}`);
}
/** 记分牌的时钟：美股按纽约日期、收盘 16:00 为一天的结束；加密按 UTC 日。 */
function clockOf(market) {
  if (market === 'US') return { dayOf: (ms) => etParts(ms).date, dayEndMs: (day) => etInstant(day, 16, 0) };
  return { dayOf: (ms) => iso(Math.floor(ms / DAY_MS) * DAY_MS).slice(0, 10), dayEndMs: (day) => Date.parse(`${day}T00:00:00Z`) + DAY_MS };
}

// ------------------------------------------------------------------------------------------------ reading the inbox

function readSource(root, file) {
  const json = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  if (json.projection) {
    // 只取登记簿用得到的字段的投影（测试夹具用：公开仓库不放完整的复盘与快照）；原文件的哈希照登记，不能在这里重算。
    if (json.projection !== 'SIGNAL_REGISTRY_INPUT_PROJECTION_V1' || !json.of || !/^[0-9a-f]{64}$/.test(json.of.hash || '')) throw new Error(`SOURCE_PROJECTION_INVALID:${file}`);
    return { json, ref: { file, contract: json.of.contract, hash: json.of.hash, hashState: 'PROJECTION_DECLARED' } };
  }
  if (!/^[0-9a-f]{64}$/.test(json.hash || '') || contentHash(json) !== json.hash) throw new Error(`SOURCE_HASH_MISMATCH:${file}`);
  return { json, ref: { file, contract: json.contract || json.schema || null, hash: json.hash, hashState: 'VERIFIED' } };
}

function datedFiles(root, dir, re) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).map((name) => ({ name, m: re.exec(name) })).filter((x) => x.m).map((x) => ({ file: path.join(dir, x.name), date: x.m[1] }))
    .sort((a, b) => byText(a.date, b.date));
}

/**
 * 一本账本在收件箱里的输入。`periodTo` 不给时取最新一份记分牌。全量文件逐个验自带哈希，不符即拒（失败即关）。
 * 收件箱布局 = desk inbox：<producerDir>/review/SCOREBOARD|STRATEGY/<ledgerId>/、trades/<ledgerId>/、ledger/<ledgerId>/。
 */
function readBookInputs(root, ledgerId, { periodTo = null } = {}) {
  const cfg = BOOKS[ledgerId];
  if (!cfg) throw new Error(`SIGNAL_REGISTRY_BOOK_NOT_IN_SCOPE:${ledgerId}`);
  const p = cfg.producerDir;
  const boards = datedFiles(root, path.join(p, 'review', 'SCOREBOARD', ledgerId), /^STRATEGY_SCOREBOARD_(\d{4}-\d{2}-\d{2})\.json$/);
  const board = periodTo ? boards.find((b) => b.date === periodTo) : boards[boards.length - 1];
  if (!board) throw new Error(`SIGNAL_REGISTRY_SCOREBOARD_MISSING:${ledgerId}:${periodTo || 'latest'}`);
  const scoreboard = readSource(root, board.file);
  if (scoreboard.json.ledgerId !== ledgerId || scoreboard.json.contract !== 'STRATEGY_SCOREBOARD_V1') throw new Error(`SIGNAL_REGISTRY_SCOREBOARD_IDENTITY:${board.file}`);
  const to = scoreboard.json.period.to;
  const ledgers = datedFiles(root, path.join(p, 'trades', ledgerId), /^TRADE_LEDGER_(\d{4}-\d{2}-\d{2})\.json$/).map((f) => readSource(root, f.file));
  const reviews = datedFiles(root, path.join(p, 'review', 'STRATEGY', ledgerId), /^STRATEGY_REVIEW_(\d{4}-\d{2}-\d{2})\.json$/)
    .filter((f) => f.date <= to).map((f) => readSource(root, f.file));
  const snapFile = path.join(p, 'ledger', ledgerId, `POSITION_LEDGER_SNAPSHOT_${to}.json`);
  const snapshot = fs.existsSync(path.join(root, snapFile)) ? readSource(root, snapFile) : null;
  return { ledgerId, scoreboard, ledgers, reviews, snapshot };
}

// ------------------------------------------------------------------------------------------------ trades

const tradeIdOf = (cfg, e) => (cfg.market === 'CRYPTO' ? String(e.lotId).split(':').pop() : String(e.lotId));

/** 成交 → 交易（一手：开仓 + 减仓/平仓）。同一 eventId 只取第一次；内容不同的重复记为来源分歧。 */
function ledgerTrades(cfg, ledgerFiles, divergences) {
  const seen = new Map();
  const lots = new Map();
  for (const { json, ref } of ledgerFiles) {
    for (const e of json.events || []) {
      if (seen.has(e.eventId)) {
        if (canonicalJson(seen.get(e.eventId)) !== canonicalJson(e)) divergences.push({ kind: 'TRADE_LEDGER_EVENT_RESTATED', eventId: e.eventId, file: ref.file });
        continue;
      }
      seen.set(e.eventId, e);
      const id = tradeIdOf(cfg, e);
      const lot = lots.get(id) || { tradeId: id, symbol: String(e.instrument && e.instrument.id || '').toUpperCase(), open: null, closing: [], close: null };
      if (e.purpose === 'OPEN' && !lot.open) lot.open = e;
      else if (e.purpose === 'REDUCE' || e.purpose === 'CLOSE') { lot.closing.push(e); if (e.purpose === 'CLOSE') lot.close = e; }
      lots.set(id, lot);
    }
  }
  return [...lots.values()].map((lot) => {
    const done = lot.closing.filter((e) => e.realized && (e.realized.state === 'MEASURED' || e.realized.state === 'MEASURED_GROSS'));
    const all = lot.close && done.length === lot.closing.length;
    const state = !all ? null : done.every((e) => e.realized.state === 'MEASURED') ? 'MEASURED' : 'MEASURED_GROSS';
    const codes = lot.open && lot.open.decision && Array.isArray(lot.open.decision.reasonCodes) ? lot.open.decision.reasonCodes : null;
    return {
      tradeId: lot.tradeId, symbol: lot.symbol,
      signalKey: codes && codes.length ? codes.join('+') : CODES.ENTRY_NOT_IN_LEDGER, signalCodes: codes || [],
      ruleRef: lot.open && lot.open.decision ? lot.open.decision.ruleRef || null : null,
      entryMs: lot.open ? Date.parse(lot.open.executedAt) : null, exitMs: lot.close ? Date.parse(lot.close.executedAt) : null,
      state: lot.close ? 'CLOSED' : 'OPEN',
      ledger: state ? { state, amount: done.reduce((s, e) => s + e.realized.currencyAmount, 0),
        r: done.every((e) => finite(e.realized.r)) ? done.reduce((s, e) => s + e.realized.r, 0) : null } : null,
      fills: [lot.open, ...lot.closing].filter(Boolean),
    };
  });
}

/**
 * 每笔已平交易的结果，按来源优先级（规格 §3）：①记分牌状态标签里的 outcome（生产方本期的值，全精度）；②成交台账平仓的已实现结果，
 * 仅当其口径就是账本口径（加密 MEASURED = 净；US_V5 MEASURED_GROSS = 毛，C-6）；③该周 STRATEGY_REVIEW_V1 的 tradeReviews 行。
 * 费用与费用来源只有复盘行有（台账成交只带手续费，资金费、滑点不是成交）。
 */
function resolveOutcomes(cfg, trades, { tags, reviewRows }, divergences) {
  const basisState = cfg.pnlIsGross ? 'MEASURED_GROSS' : 'MEASURED';
  for (const t of trades) {
    const review = reviewRows.get(t.tradeId) || null;
    t.costs = review && review.costs ? review.costs : {};
    t.costProvenance = review && review.costProvenance ? review.costProvenance : {};
    t.pnlIsGross = cfg.pnlIsGross;
    t.grossPnl = t.ledger && t.ledger.state === 'MEASURED_GROSS' && !cfg.pnlIsGross ? t.ledger.amount : null;
    t.pnl = null; t.rMultiple = null; t.outcomeSource = null;
    if (t.state !== 'CLOSED') continue;
    const tag = tags.get(t.tradeId);
    const ledgerOk = t.ledger && t.ledger.state === basisState;
    if (tag && tag.outcome && finite(tag.outcome.netPnl)) {
      t.pnl = tag.outcome.netPnl; t.rMultiple = finite(tag.outcome.resultR) ? tag.outcome.resultR : null; t.outcomeSource = 'SCOREBOARD_STATE_TAG';
      if (ledgerOk && Math.abs(t.ledger.amount - t.pnl) > 1e-6) divergences.push({ kind: 'TRADE_LEDGER_VS_SCOREBOARD_TAG', tradeId: t.tradeId, ledger: t.ledger.amount, scoreboard: t.pnl });
    } else if (ledgerOk) {
      t.pnl = t.ledger.amount; t.rMultiple = t.ledger.r; t.outcomeSource = 'TRADE_LEDGER';
    } else if (review && finite(review.pnl)) {
      t.pnl = review.pnl; t.rMultiple = finite(review.rMultiple) ? review.rMultiple : null; t.outcomeSource = 'STRATEGY_REVIEW';
    }
    // 台账与复盘两边都有结果时互相核对（复盘行取到 2–4 位小数，容差按 2 位）；台账停在毛值而复盘已是净值，是台账文件交付后费用才落定。
    if (review && finite(review.pnl) && t.ledger) {
      if (t.ledger.state !== basisState) divergences.push({ kind: 'TRADE_LEDGER_GROSS_REVIEW_NET', tradeId: t.tradeId, ledger: t.ledger.amount, review: review.pnl });
      else if (Math.abs(t.ledger.amount - review.pnl) > 0.005) divergences.push({ kind: 'TRADE_LEDGER_VS_REVIEW', tradeId: t.tradeId, ledger: t.ledger.amount, review: review.pnl });
    }
    if (t.state === 'CLOSED' && !review) divergences.push({ kind: 'CLOSED_TRADE_NOT_IN_ANY_REVIEW', tradeId: t.tradeId });
  }
  return trades;
}

// ------------------------------------------------------------------------------------------------ figures (STRATEGY_SCOREBOARD_V1 的同一读法)

/** 记分牌 tradeCosts：任一笔 UNKNOWN 则该项 NOT_MEASURED（null，不是 0）；美股没有资金费。 */
function tradeCosts(closed, market) {
  const out = {};
  for (const key of COSTS) {
    if (key === 'funding' && market !== 'CRYPTO') { out.funding = money('NOT_APPLICABLE', null, CODES.NOT_A_PERPETUAL); continue; }
    if (!closed.length) { out[key] = money('NOT_APPLICABLE', null, CODES.NO_CLOSED_TRADE); continue; }
    const prov = closed.map((t) => (t.costProvenance && t.costProvenance[key]) || 'UNKNOWN');
    if (key === 'funding' && prov.every((p) => p === 'NOT_APPLICABLE')) { out.funding = money('NOT_APPLICABLE', null, CODES.NOT_A_PERPETUAL); continue; }
    if (prov.some((p) => p !== 'MEASURED' && p !== 'MODELLED') || closed.some((t) => !finite(t.costs && t.costs[key]))) {
      out[key] = money('NOT_MEASURED', null, NOT_MEASURED_REASON[key]);
      continue;
    }
    out[key] = money(prov.includes('MODELLED') ? 'MODELLED' : 'MEASURED', round4(closed.reduce((s, t) => s + t.costs[key], 0)), null);
  }
  return out;
}

/** 轮动账本：窗口内各会话换仓成交的建模手续费（记分牌 coreCostsOf：一项不是数就 NOT_MEASURED、不写金额）。 */
function rotationCosts(fills) {
  const funding = money('NOT_APPLICABLE', null, CODES.NOT_A_PERPETUAL);
  const slippage = money('NOT_APPLICABLE', null, CODES.SLIPPAGE_IN_FILL);
  if (fills.some((f) => !f.fees || !finite(f.fees.amount))) return { fee: money('NOT_MEASURED', null, 'FEE_NOT_REPORTED'), funding, slippage };
  return { fee: money('MODELLED', round4(fills.reduce((s, f) => s + f.fees.amount, 0)), null), funding, slippage };
}

/** smartflow review-verdict-rules expectancyStats：均值与 t = 均值 /(样本标准差/√n)。 */
function expectancyStats(rs) {
  if (rs.some((r) => !finite(r))) return { mean: null, t: null };
  const n = rs.length;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, t: null };
  const sd = Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1));
  return { mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : null };
}

/** 记分牌 sampleStats：平均 R、期望 t，30 笔下限，五态分开。 */
function sampleStats(closed, noInitialStop, ratio = RATIO.SCOREBOARD.window) {
  const na = (code) => stat(null, 'NOT_APPLICABLE', code);
  const below = stat(null, 'INSUFFICIENT_SAMPLE');
  if (noInitialStop) return { avgR: na(CODES.NO_INITIAL_STOP), expectancyT: na(CODES.NO_INITIAL_STOP) };
  if (!closed.length) return { avgR: na(CODES.NO_CLOSED_TRADE), expectancyT: na(CODES.NO_CLOSED_TRADE) };
  if (closed.length < RATE_FLOOR) return { avgR: below, expectancyT: below };
  const s = expectancyStats(closed.map((t) => t.rMultiple));
  if (!finite(s.mean)) { const u = stat(null, 'UNKNOWN', CODES.RISK_UNIT_NOT_RECORDED); return { avgR: u, expectancyT: u }; }
  return { avgR: stat(ratio(s.mean), 'MEASURED'),
    expectancyT: finite(s.t) ? stat(ratio(s.t), 'MEASURED') : stat(null, 'UNKNOWN', CODES.T_ZERO_VARIANCE) };
}

/**
 * 每笔期望金额（成本后，账本自己记的费用）：已平笔数 ≥ 30 才出（与胜率、平均 R 同一下限），金额 2 位（METRIC_DEFINITIONS_V1 §10.2）。
 * 该契约没有定义这个量，按 §1.5 带 `_like` 后缀，不是裁决数字；口径跟窗口的 pnlBasis（US_V5 为 GROSS，C-6）。
 */
function expectancyAmount(values, basis, currency, floor) {
  const n = values.length;
  const out = (value, state, reasonCode = null) => ({ value, state, reasonCode, basis: state === 'MEASURED' ? basis : null, currency });
  if (!n) return out(null, 'NOT_APPLICABLE', CODES.NO_CLOSED_TRADE);
  if (n < floor) return out(null, 'INSUFFICIENT_SAMPLE');
  return out(round2(values.reduce((a, b) => a + b, 0) / n), 'MEASURED');
}

const EMPTY = Object.freeze({ closed: null, open: null, wins: null, losses: null, flats: null, pnlBasis: null, winRate: null, avgR: null,
  expectancyT: null, expectancyAmount_like: null, costs: null });

/**
 * 一个窗口。边界取记分牌这一窗（from、to、segmentIds，规格 §4）：交易按平仓时刻落窗，本期已平 = 平仓日 ≤ period.to；
 * 未平 = 到期末仍持有（上一版本窗：到版本切换时仍持有）。记分牌这一窗没有边界（未开始、不适用）就照抄它的状态与原因。
 */
function windowOf(name, sbw, trades, ctx) {
  const frame = { state: sbw.state, reasonCode: sbw.reasonCode, from: sbw.from, to: sbw.to, segmentIds: [...(sbw.segmentIds || [])] };
  if (!sbw.from) return { ...frame, ...EMPTY };
  const { clock, periodTo, periodEndMs, market, cfg } = ctx;
  const exclusive = name === 'previousVersion';
  const fromMs = Date.parse(sbw.from);
  const toMs = exclusive ? Date.parse(sbw.to) : periodEndMs;
  const inPeriod = (ms) => finite(ms) && clock.dayOf(ms) <= periodTo;
  if (cfg.rotation) {
    // 轮动账本没有往返交易：已平 0；未平 = 窗口结束时仍持有的仓位；费用 = 窗口各会话的换仓成交。
    const firstDay = clock.dayOf(fromMs);
    const lastDayOk = (d) => (exclusive ? d < clock.dayOf(toMs) : d <= periodTo);
    const held = trades.filter((t) => finite(t.entryMs) && lastDayOk(clock.dayOf(t.entryMs)) && !(t.state === 'CLOSED' && lastDayOk(clock.dayOf(t.exitMs)))).length;
    const fills = trades.flatMap((t) => t.fills).filter((f) => { const d = clock.dayOf(Date.parse(f.executedAt)); return d >= firstDay && lastDayOk(d); });
    const costs = rotationCosts(fills);
    return { ...frame, state: 'MEASURED', reasonCode: null, closed: 0, open: held, wins: 0, losses: 0, flats: 0,
      pnlBasis: COSTS.some((k) => costs[k].state === 'NOT_MEASURED') ? 'GROSS' : 'NET', winRate: stat(null, 'NOT_APPLICABLE', CODES.NO_CLOSED_TRADE),
      ...sampleStats([], true), expectancyAmount_like: { ...expectancyAmount([], null, cfg.currency, RATE_FLOOR), reasonCode: CODES.NO_ROUND_TRIP }, costs };
  }
  const closed = trades.filter((t) => t.state === 'CLOSED' && inPeriod(t.exitMs) && t.exitMs >= fromMs && (!exclusive || t.exitMs < toMs))
    .sort((a, b) => a.exitMs - b.exitMs);
  const open = exclusive
    ? trades.filter((t) => finite(t.entryMs) && t.entryMs < toMs && !(t.state === 'CLOSED' && t.exitMs < toMs)).length
    : trades.filter((t) => finite(t.entryMs) && t.entryMs < periodEndMs && !(t.state === 'CLOSED' && inPeriod(t.exitMs))).length;
  const costs = tradeCosts(closed, market);
  // 周复盘行在交付后不再重述（资金费晚落定的那笔仍写 UNKNOWN）。这一窗的已平交易正好是记分牌同一窗的那些（同块、同笔数）、
  // 而记分牌在期末说这项已计量时，取记分牌这一项（它的规则：任一笔未知即 NOT_MEASURED），并在 costsSource 与来源核对里写明。
  const restated = [];
  if (sbw.state === 'MEASURED' && sbw.closed === closed.length && sbw.costs) {
    for (const k of COSTS) {
      if (costs[k].state === 'NOT_MEASURED' && ['MEASURED', 'MODELLED'].includes(sbw.costs[k].state)) { costs[k] = { ...sbw.costs[k] }; restated.push(k); }
    }
  }
  if (restated.length && ctx.restatements) ctx.restatements.push({ window: name, costs: restated });
  const gross = COSTS.some((k) => costs[k].state === 'NOT_MEASURED');
  const basisPnl = (t) => (!gross ? t.pnl : finite(t.grossPnl) ? t.grossPnl : t.pnlIsGross ? t.pnl : null);
  if (closed.some((t) => !finite(basisPnl(t)))) return { ...frame, state: 'UNKNOWN', reasonCode: CODES.PNL_NOT_RECORDED, ...EMPTY };
  const n = closed.length;
  const wins = closed.filter((t) => basisPnl(t) > 0).length;
  const losses = closed.filter((t) => basisPnl(t) < 0).length;
  const pnlBasis = gross ? 'GROSS' : 'NET';
  return {
    ...frame, state: 'MEASURED', reasonCode: null, closed: n, open, wins, losses, flats: n - wins - losses, pnlBasis,
    winRate: !n ? stat(null, 'NOT_APPLICABLE', CODES.NO_CLOSED_TRADE) : n < RATE_FLOOR ? stat(null, 'INSUFFICIENT_SAMPLE') : stat(ctx.ratio.window(wins / n), 'MEASURED'),
    ...sampleStats(closed, false, ctx.ratio.window),
    expectancyAmount_like: expectancyAmount(closed.map(basisPnl), pnlBasis, cfg.currency, RATE_FLOOR),
    costs, costsSource: restated.length ? `SCOREBOARD_WINDOW:${restated.join(',')}` : 'TRADE_ROWS',
  };
}

// ------------------------------------------------------------------------------------------------ state split (增补 4，desk state-split.js 的格子读法)

const cellKeyOf = (a) => (a.state === 'TAGGED' ? a.value : a.state === 'UNKNOWN' ? 'STATE_UNKNOWN' : 'STATE_NOT_APPLICABLE');
function closedInWindow(closedAt, w) {
  const t = Date.parse(closedAt);
  const end = /^\d{4}-\d{2}-\d{2}$/.test(w.to) ? Date.parse(`${w.to}T00:00:00Z`) + DAY_MS : Date.parse(w.to) + 1;
  return t >= Date.parse(w.from) && t < end;
}

function cellOf(key, mine, w, currency, ratio = RATIO.SCOREBOARD.cell) {
  const closed = mine.filter((t) => t.outcome && closedInWindow(t.outcome.closedAt, w));
  const open = mine.filter((t) => !t.outcome).length;
  const base = { key, closed: closed.length, open, sample: { n: closed.length, floor: CELL_FLOOR, state: closed.length >= CELL_FLOOR ? 'AT_OR_ABOVE_FLOOR' : 'BELOW_FLOOR' } };
  const exp = (value, state, reasonCode = null, basis = null) => ({ value, state, reasonCode, basis, currency });
  if (key === 'STATE_UNKNOWN' || key === 'STATE_NOT_APPLICABLE') {
    const r = key === 'STATE_UNKNOWN' ? CODES.CELL_UNKNOWN : CODES.CELL_NOT_APPLICABLE;
    return { ...base, winRate: stat(null, 'NOT_APPLICABLE', r), avgR: stat(null, 'NOT_APPLICABLE', r), netPnl: { ...stat(null, 'NOT_APPLICABLE', r), basis: null },
      expectancyAmount_like: exp(null, 'NOT_APPLICABLE', r) };
  }
  if (closed.length < CELL_FLOOR) {
    const b = stat(null, 'INSUFFICIENT_SAMPLE');
    return { ...base, winRate: b, avgR: b, netPnl: { ...b, basis: null }, expectancyAmount_like: exp(null, 'INSUFFICIENT_SAMPLE') };
  }
  const outcomes = closed.map((t) => t.outcome);
  const pnlMissing = outcomes.find((o) => !finite(o.netPnl));
  const rMissing = outcomes.find((o) => !finite(o.resultR));
  const sum = (v) => v.reduce((a, b) => a + b, 0);
  const noStop = rMissing && outcomes.every((o) => !finite(o.resultR) && o.reasonCode === CODES.NO_INITIAL_STOP);
  const rUnknown = noStop ? stat(null, 'NOT_APPLICABLE', CODES.NO_INITIAL_STOP) : rMissing ? stat(null, 'UNKNOWN', rMissing.reasonCode) : null;
  const pnlUnknown = pnlMissing ? stat(null, 'UNKNOWN', pnlMissing.reasonCode) : null;
  const pnl = outcomes.map((o) => o.netPnl);
  const basis = outcomes.some((o) => o.pnlBasis === 'GROSS') ? 'GROSS' : 'NET';
  return {
    ...base,
    winRate: pnlUnknown || stat(ratio(pnl.filter((v) => v > 0).length / closed.length), 'MEASURED'),
    avgR: rUnknown || stat(ratio(sum(outcomes.map((o) => o.resultR)) / closed.length), 'MEASURED'),
    netPnl: pnlUnknown ? { ...pnlUnknown, basis: null } : { ...stat(sum(pnl), 'MEASURED'), basis },
    expectancyAmount_like: pnlUnknown ? exp(null, 'UNKNOWN', pnlUnknown.reasonCode) : exp(round2(sum(pnl) / closed.length), 'MEASURED', null, basis),
  };
}

/**
 * 一行的状态拆分：标签与格子键次序都用记分牌这一块交付的（标签自决策时刻起不变，`since` 之前开的仓只计数、不拆，§3.3）；
 * 这一行只取自己信号的那些标签。未标签数 = 这一行窗口的已平/未平减去价格轴格子之和（与 desk 同一算法）。
 */
function stateSplitOf(sbSplit, rowTradeIds, rowWindows, cfg, ratio = RATIO.SCOREBOARD) {
  if (!sbSplit) return { state: 'NOT_AVAILABLE', reasonCode: cfg.noSplit || 'NOT_AVAILABLE:STATE_SPLIT_NOT_DELIVERED', since: null, mapping: null, windows: null };
  const tags = sbSplit.tags.filter((t) => rowTradeIds.has(String(t.tradeId)));
  const windows = {};
  for (const name of SPLIT_WINDOWS) {
    const sw = sbSplit.windows[name];
    const frame = { state: sw.state, reasonCode: sw.reasonCode, from: sw.from, to: sw.to, segmentIds: [...(sw.segmentIds || [])] };
    if (!sw.axes) { windows[name] = { ...frame, untaggedClosed: null, untaggedOpen: null, axes: null }; continue; }
    const axes = {};
    for (const [axis, a] of Object.entries(sw.axes)) {
      axes[axis] = a.state !== 'SPLIT' ? { state: a.state, reasonCode: a.reasonCode, cells: [] }
        : { state: 'SPLIT', reasonCode: null, cells: a.cells.map((c) => cellOf(c.key, tags.filter((t) => cellKeyOf(t.axes[axis]) === c.key), sw, cfg.currency, ratio.cell)) };
    }
    const priceCells = (axes.price && axes.price.cells) || [];
    const rw = rowWindows[name];
    windows[name] = { ...frame, untaggedClosed: rw.closed - priceCells.reduce((n, c) => n + c.closed, 0),
      untaggedOpen: rw.open - priceCells.reduce((n, c) => n + c.open, 0), axes };
  }
  return { state: sbSplit.state, reasonCode: sbSplit.reasonCode, since: sbSplit.since, mapping: sbSplit.mapping, axisKeys: sbSplit.axisKeys, windows };
}

// ------------------------------------------------------------------------------------------------ the registry

function rowOf({ ledgerId, partId, signalKey, trades, sbBlock, ctx }) {
  const restatements = [];
  const ratio = signalKey === '*' ? RATIO.SCOREBOARD : RATIO.OWN;
  const windows = Object.fromEntries(WINDOWS.map((n) => [n, windowOf(n, sbBlock.windows[n], trades, { ...ctx, restatements, ratio })]));
  for (const r of restatements) {
    const stale = trades.filter((t) => t.state === 'CLOSED' && r.costs.some((k) => !['MEASURED', 'MODELLED'].includes(t.costProvenance[k] || 'UNKNOWN')))
      .map((t) => t.tradeId);
    ctx.divergences.push({ kind: 'COST_RESTATED_BY_SCOREBOARD_WINDOW', rowId: `${ledgerId}|${partId || '-'}|${signalKey}`, window: r.window, costs: r.costs, staleTradeIds: stale });
  }
  const entries = trades.filter((t) => finite(t.entryMs)).map((t) => t.entryMs).sort((a, b) => a - b);
  return {
    rowId: `${ledgerId}|${partId || '-'}|${signalKey}`, ledgerId, market: ctx.market, partId, signalKey,
    signalCodes: signalKey === '*' ? [] : [...(trades[0] ? trades[0].signalCodes : [])],
    ruleRefs: [...new Set(trades.map((t) => t.ruleRef))].sort((a, b) => byText(String(a), String(b))),
    entries: entries.length, firstEntryAt: entries.length ? iso(entries[0]) : null, lastEntryAt: entries.length ? iso(entries[entries.length - 1]) : null,
    windows,
    stateSplit: ctx.cfg.rotation ? { state: 'NOT_APPLICABLE', reasonCode: ctx.cfg.noSplit, since: null, mapping: null, windows: null }
      : stateSplitOf(sbBlock.stateSplit, new Set(trades.map((t) => t.tradeId)), windows, ctx.cfg, ratio),
  };
}

/** 一本账本：每块（整本或 C17 的部分）一行汇总（signalKey '*'，与记分牌逐字段对照）+ 每条信号一行。 */
function buildBook(inputs) {
  const { ledgerId } = inputs;
  const cfg = BOOKS[ledgerId];
  const sb = inputs.scoreboard.json;
  const clock = clockOf(cfg.market);
  const periodTo = sb.period.to;
  const divergences = [];
  const ctx = { clock, periodTo, periodEndMs: clock.dayEndMs(periodTo), market: cfg.market, cfg, divergences };
  const blocks = sb.parts ? sb.parts.map((p) => ({ partId: p.partId, sb: p })) : [{ partId: null, sb }];
  const tags = new Map(blocks.flatMap((b) => (b.sb.stateSplit ? b.sb.stateSplit.tags : []).map((t) => [String(t.tradeId), { ...t, partId: b.partId }])));
  const reviewRows = new Map(inputs.reviews.flatMap((r) => (r.json.tradeReviews || []).map((t) => [String(t.tradeId), t])));
  const trades = resolveOutcomes(cfg, ledgerTrades(cfg, inputs.ledgers, divergences), { tags, reviewRows }, divergences)
    .filter((t) => !finite(t.entryMs) || t.entryMs < ctx.periodEndMs);
  const partOf = (t) => (cfg.parts ? Object.keys(cfg.parts).find((id) => cfg.parts[id](t.symbol)) : null);
  for (const [id, tag] of tags) {
    const t = trades.find((x) => x.tradeId === id);
    if (!t) divergences.push({ kind: 'TAGGED_LOT_NOT_IN_TRADE_LEDGER', tradeId: id });
    else if (cfg.parts && partOf(t) !== tag.partId) divergences.push({ kind: 'PART_MEMBERSHIP', tradeId: id, registry: partOf(t), scoreboard: tag.partId });
  }
  const bound = inputs.reviews.find((r) => r.ref.hash === sb.bindings.strategyReview.hash);
  if (!bound) divergences.push({ kind: 'BOUND_REVIEW_NOT_READ', hash: sb.bindings.strategyReview.hash });
  const outBlocks = [];
  const rows = [];
  for (const b of blocks) {
    const mine = trades.filter((t) => (cfg.parts ? partOf(t) === b.partId : true));
    const rollup = rowOf({ ledgerId, partId: b.partId, signalKey: '*', trades: mine, sbBlock: b.sb, ctx });
    let blockRows = [];
    if (!cfg.rotation) {
      const keys = [...new Set(mine.map((t) => t.signalKey))].sort(byText);
      blockRows = keys.map((k) => rowOf({ ledgerId, partId: b.partId, signalKey: k, trades: mine.filter((t) => t.signalKey === k), sbBlock: b.sb, ctx }));
    }
    rows.push(...blockRows);
    outBlocks.push({ partId: b.partId, rowsState: cfg.rotation ? CODES.NO_ROUND_TRIP : null, rollup, rowIds: blockRows.map((r) => r.rowId) });
  }
  // 快照对账：期末那天的 POSITION_LEDGER_SNAPSHOT 的持仓 = 登记簿期末未平的交易（只记录，不改任何数）。
  let snapshotOpenLots = { state: 'NOT_AVAILABLE', reasonCode: 'SNAPSHOT_FOR_PERIOD_END_NOT_DELIVERED', snapshot: [], registry: [] };
  if (inputs.snapshot) {
    const snap = (inputs.snapshot.json.lots || []).map((l) => String(l.lotId)).sort(byText);
    const open = trades.filter((t) => !(t.state === 'CLOSED' && clock.dayOf(t.exitMs) <= periodTo))
      .map((t) => (t.fills[0] ? String(t.fills[0].lotId) : t.tradeId)).sort(byText);
    snapshotOpenLots = { state: canonicalJson(snap) === canonicalJson(open) ? 'MATCH' : 'DIFFERENT', reasonCode: null, snapshot: snap, registry: open };
  }
  return {
    book: {
      ledgerId, market: cfg.market, currency: cfg.currency, period: { ...sb.period }, generatedAt: sb.generatedAt,
      bookState: sb.book.state, startedAt: sb.book.startedAt, rotation: cfg.rotation, parts: sb.parts ? sb.parts.map((p) => p.partId) : null,
      currentSegmentIds: Object.fromEntries(blocks.map((b) => [b.partId || '-', b.sb.windows.currentVersion.segmentIds || []])),
      sources: {
        scoreboard: inputs.scoreboard.ref, strategyReviews: inputs.reviews.map((r) => r.ref), tradeLedgers: inputs.ledgers.map((r) => r.ref),
        positionSnapshot: inputs.snapshot ? inputs.snapshot.ref : null,
      },
      blocks: outBlocks,
      trades: trades.map((t) => ({ tradeId: t.tradeId, partId: partOf(t), signalKey: t.signalKey, symbol: t.symbol, entryAt: finite(t.entryMs) ? iso(t.entryMs) : null,
        exitAt: finite(t.exitMs) ? iso(t.exitMs) : null, state: t.state, pnl: t.pnl, rMultiple: t.rMultiple, outcomeSource: t.outcomeSource }))
        .sort((a, b) => byText(String(a.entryAt), String(b.entryAt)) || byText(a.tradeId, b.tradeId)),
      sourceChecks: { divergences, snapshotOpenLots },
    },
    rows,
  };
}

/** 登记簿：四本账本（或给定的几本），无时钟（generatedAt = 输入记分牌里最新的那个），带自身哈希。 */
function buildRegistry(bookInputs) {
  const built = bookInputs.map(buildBook);
  return withHash({
    schema: SCHEMA, registryVersion: 1,
    generatedAt: built.map((b) => b.book.generatedAt).sort(byText).pop() || null,
    contracts: { metrics: 'METRIC_DEFINITIONS_V1', scoreboard: 'STRATEGY_SCOREBOARD_V1', stateSplit: 'REVIEW_LOOP_ACCEPTANCE_V1_ADDENDUM_4', spec: 'docs/contracts/SIGNAL_REGISTRY_V1.md' },
    floors: { rate: RATE_FLOOR, cell: CELL_FLOOR },
    books: built.map((b) => b.book),
    rows: built.flatMap((b) => b.rows),
    interpretation: 'REGISTRY_FACTS_NOT_A_VERDICT', productionEffect: 'NONE',
  });
}

function buildFromInbox(root, ledgerIds = Object.keys(BOOKS), opts = {}) {
  return buildRegistry(ledgerIds.map((id) => readBookInputs(root, id, opts)));
}

module.exports = { BOOKS, CELL_FLOOR, CODES, RATE_FLOOR, SCHEMA, SPLIT_WINDOWS, WINDOWS, buildBook, buildFromInbox, buildRegistry, canonicalJson,
  contentHash, readBookInputs, readSource, withHash };
