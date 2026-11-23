'use strict';

/**
 * W05「复盘已看过 = 开发信息」（plan-coord 裁定 11-23，W05_REVIEWED_IS_SEEN_RULING_V1 d753f0a0，§1–§3）。
 *
 * 任何一份交给复盘的事实包（人工周编 REVIEW_LOOP_WEEK_V1，或 AI 复盘卡的 REVIEW_AI_FACT_PACK_V1），交付时往试验台账追加一条 DATA_SEGMENT_MARK_V1：
 *   label = SEEN，market = 包的市场，族 = MARKET:<市场>（对该市场每一族生效，见 ./index.js segmentsFor），来源引用 source_refs[0] = { kind: REVIEW_FACT_PACK_V1, sha256, … }。
 *   区间 = [包内各事实各自窗口的最早起点，决策截止日]；某条事实没写窗口 → 起点按该市场数据起点算（宁宽勿窄）；截止日之后的日期不算已看。
 *   同一个包（内容 sha256 相同）重复入库只产生一条标记（幂等）。不新增 reviewed_through 字段：「复盘看到哪天」由 reviewedThrough() 从标记推出，不另存。
 *
 * 包的两种形状：
 *   AI_FACT_PACK    { schema | contract: REVIEW_AI_FACT_PACK_V1, market, week | weekId | week_id, facts[{ id, at, window?: {from, to}, … }], period?: {from, to}, decision_cutoff? }
 *                   事实的窗口只认 fact.window；截止日 = 各事实 at 的日期、各窗口终点、period.to、decision_cutoff（有就算）里最晚的一个；一个日期都没有 → 拒收，不猜。
 *   WEEKLY_COMPILE  { contract: REVIEW_LOOP_WEEK_V1, weekId, generatedAt, periods: { CN | US | CRYPTO: { from, to } } }，每个 period 的市场一条标记；
 *                   周编没有逐条事实的窗口 → 起点 = 该市场数据起点；截止日 = period.to 与周编生成日（CST）里较晚的一个。
 * 包的 sha256 = 规范 JSON（键排序）的 sha256，与 services/research-queue-agent 的 packSha 同一算法；交付的文件字节另存 file_sha256。
 * 复核修正（plan-coord 11-23 14:00，W05_REVIEW P2-1/2/3）：写完读回（读不出 → NOT_READBACK）；截止日晚于「现在 + 36 小时」→ 拒收 CUTOFF_IN_FUTURE（宿主时钟，可注入 now）；
 * 明写的截止日（decision_cutoff / decisionCutoff / cutoff，周编的 generatedAt）写了却读不出 → 拒收 CUTOFF_INVALID，只有没写才退回别的日期来源。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { read } = require('../../packages/ledger');
const ledger = require('./index');
const { SEGMENTS: MINING } = require('../mining-sandbox/segments');

const KIND = ledger.REVIEW_PACK_REF_KIND;
const SHA64 = /^[0-9a-f]{64}$/;
/**
 * 市场数据起点（只在事实没写窗口时用）。CN_A = RF1116 冻结的挖掘段起点；美股、加密在仓库里没有登记过数据起点，这里取台账补登记（back_register SEGMENT_PLAN）里
 * 已经标 SEEN 的最早日期（US_CORE 从 2010-01-01，加密从 2020-01-01）。ASSUMPTION：待 plan-coord 确认；起点取早只会多标 SEEN，不会放过泄漏。
 */
const DATA_START = Object.freeze({ CN_A: MINING.MINING.from, US_EQUITY: '2010-01-01', CRYPTO: '2020-01-01' });
const WEEK_MARKETS = Object.freeze({ CN: 'CN_A', US: 'US_EQUITY', CRYPTO: 'CRYPTO' });
const WEEK_FILE = /^REVIEW_LOOP_WEEK_(\d{4}-W\d{2})(?:_R(\d+))?\.json$/;
const AI_FILE = /^REVIEW_AI_FACT_PACK_(CN_A|US_EQUITY|CRYPTO)_(\d{4}-W\d{2})(?:_R(\d+))?\.json$/;

class ReviewPackSeenError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new ReviewPackSeenError(`REVIEW_PACK_SEEN_${code}`, detail); };
const need = (ok, code, detail) => { if (!ok) fail(code, detail); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** 合法的 YYYY-MM-DD（2026-02-31 不算）。 */
function validDate(d) {
  if (typeof d !== 'string' || !ledger.DATE_PATTERN.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}
/** 带时间的写法取它自己写的日期（2026-11-13T18:00:00+08:00 → 2026-11-13）；不是日期 → null。 */
const dayOf = (v) => (typeof v === 'string' && validDate(v.slice(0, 10)) ? v.slice(0, 10) : null);
/** 完整时刻（ISO 8601，带 Z 或偏移）的毫秒数；别的写法（2026/11/16、数字）一律读不出 → NaN，不交给引擎的宽松解析。 */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const stampMs = (s) => (typeof s === 'string' && STAMP.test(s) ? Date.parse(s) : NaN);
/** 一个时刻在 CST（+08:00）的日期；读不出 → null。 */
function cstDay(stamp) {
  const t = stampMs(stamp);
  return Number.isFinite(t) ? new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10) : null;
}
/**
 * 截止日不得晚于「现在 + 36 小时」所在的 CST 日（宿主时钟，可注入：函数、毫秒数、Date 或 ISO 时刻）。写错的日期不能把未来整段标成 SEEN：
 * segmentsFor 不认 supersedes，台账上没有追加更正的路（W05 复核 P2-2）。
 */
const FUTURE_TOLERANCE_MS = 36 * 3600 * 1000;
function futureLimit(now) {
  const v = typeof now === 'function' ? now() : now;
  const t = v === undefined ? Date.now() : v instanceof Date ? v.getTime() : typeof v === 'number' ? v : stampMs(v);
  need(Number.isFinite(t), 'NOW_INVALID', String(v));
  return new Date(t + FUTURE_TOLERANCE_MS + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
const maxOf = (xs) => xs.reduce((m, x) => (x > m ? x : m));
const minOf = (xs) => xs.reduce((m, x) => (x < m ? x : m));
const statedWindow = (w) => (isObj(w) && validDate(w.from) && validDate(w.to) && w.from <= w.to ? { from: w.from, to: w.to } : null);
const dataStart = (market) => DATA_START[ledger.normalizeMarket(market)] || null;

/** 包的内容 sha256：规范 JSON（键排序）。 */
const packSha256 = (pack) => sha256(ledger.canonicalJson(pack));

const schemaOf = (p) => (p.schema !== undefined ? p.schema : p.contract);
const weekOf = (p) => p.weekId || p.week || p.week_id || null;
const revisionOf = (p) => (Number.isInteger(p.revision) && p.revision >= 0 ? p.revision : 0);

function describeAi(p, base) {
  const market = ledger.normalizeMarket(p.market);
  need(market, 'MARKET_UNKNOWN', String(p.market));
  const facts = Array.isArray(p.facts) ? p.facts.filter(isObj) : [];
  const ends = []; const starts = []; let allStated = facts.length > 0;
  for (const f of facts) {
    const w = statedWindow(f.window);
    if (w) { starts.push(w.from); ends.push(w.to); } else { allStated = false; starts.push(DATA_START[market]); }
    const at = dayOf(f.at);
    if (at) ends.push(at);
  }
  for (const k of ['decision_cutoff', 'decisionCutoff', 'cutoff']) {
    if (p[k] === undefined) continue; // absent: the other date sources carry the cutoff, as before
    const d = dayOf(p[k]);
    need(d, 'CUTOFF_INVALID', `${k}=${JSON.stringify(p[k])}`); // present: it must be a date, never silently ignored (W05 复核 P2-3)
    ends.push(d);
  }
  const periodTo = isObj(p.period) ? dayOf(p.period.to) : null;
  if (periodTo) ends.push(periodTo);
  need(ends.length, 'NO_CUTOFF', `${weekOf(p)} ${market}: no fact date, window, period or decision cutoff`);
  const to = maxOf(ends);
  let from = facts.length ? minOf(starts) : DATA_START[market];
  if (from > to) from = to;
  return [{ ...base, market, pack_kind: 'AI_FACT_PACK', from, to, fact_windows: allStated ? 'ALL_STATED' : 'WIDEST_NO_WINDOW' }];
}

function describeWeekly(p, base) {
  need(isObj(p.periods) && Object.keys(p.periods).length > 0, 'PERIODS_MISSING', String(weekOf(p)));
  let generated = null; // the compile time is the weekly compile's explicit cutoff: absent falls back to the period ends, present must parse
  if (p.generatedAt !== undefined) { generated = cstDay(p.generatedAt); need(generated, 'CUTOFF_INVALID', `generatedAt=${JSON.stringify(p.generatedAt)}`); }
  return Object.keys(p.periods).sort().map((src) => {
    const market = WEEK_MARKETS[src];
    need(market, 'PERIOD_MARKET_UNKNOWN', src);
    const end = isObj(p.periods[src]) ? dayOf(p.periods[src].to) : null;
    need(end, 'PERIOD_INVALID', src);
    const to = generated && generated > end ? generated : end;
    let from = DATA_START[market];
    if (from > to) from = to;
    return { ...base, market, pack_kind: 'WEEKLY_COMPILE', from, to, fact_windows: 'WIDEST_NO_WINDOW' };
  });
}

/**
 * 一份包要标的区间：[{ market, pack_kind, week_id, revision, from, to, sha256, file_sha256, fact_windows }]，每个市场一条。读不出的就拒收（错误码 REVIEW_PACK_SEEN_*），不猜。
 * @param {object} input 解析后的包
 * @param {{fileBytes?: Buffer}} [o] 交付的文件字节（有就记 file_sha256）
 */
function describe(input, { fileBytes = null, now = undefined } = {}) {
  need(isObj(input), 'NOT_OBJECT');
  const base = { week_id: weekOf(input), revision: revisionOf(input), sha256: packSha256(input), file_sha256: fileBytes ? sha256(fileBytes) : null };
  let items;
  if (schemaOf(input) === 'REVIEW_AI_FACT_PACK_V1') items = describeAi(input, base);
  else if (input.contract === 'REVIEW_LOOP_WEEK_V1') items = describeWeekly(input, base);
  else fail('KIND_UNKNOWN', String(schemaOf(input)));
  const limit = futureLimit(now);
  for (const it of items) need(it.to <= limit, 'CUTOFF_IN_FUTURE', `${it.market} ${it.week_id}: cutoff ${it.to} is later than now + 36 h (limit day ${limit})`);
  return items;
}

const refOf = (it) => ({ kind: KIND, sha256: it.sha256, file_sha256: it.file_sha256, pack_kind: it.pack_kind, week_id: it.week_id, revision: it.revision, fact_windows: it.fact_windows });
const reasonOf = (it) => `W05：复盘已看过 = 开发信息（${it.pack_kind} ${it.week_id || '?'}${it.revision ? ` R${it.revision}` : ''}，${it.fact_windows === 'ALL_STATED' ? '事实窗口都有写' : '有事实没写窗口，起点取市场数据起点'}）`;

/** 台账里已有的、同一包同一市场的标记。 */
const findMark = (rows, it) => rows.find((m) => ledger.isReviewPackMark(m) && ledger.normalizeMarket(m.market) === it.market
  && m.source_refs.some((r) => r && r.kind === KIND && r.sha256 === it.sha256)) || null;

/** describe 的结果写进台账（已有的是重放，原样返回，replayHit: true）。整批先校验再写。 */
function markItems(items, { registeredBy, registeredAt = null, dryRun = false } = {}) {
  const existing = read(ledger.SEGMENTS());
  const out = items.map((it) => { const found = findMark(existing, it); return found ? { ...found, replayHit: true } : null; });
  const todo = items.map((it, i) => (out[i] ? null : { i, spec: { family_id: `${ledger.MARKET_FAMILY_PREFIX}${it.market}`, market: it.market, from: it.from, to: it.to, label: 'SEEN', seen_kind: null,
    reason: reasonOf(it), source_refs: [refOf(it)], id_salt: it.sha256 } })).filter(Boolean);
  if (todo.length) {
    const rows = ledger.markSegments(todo.map((t) => t.spec), { registeredBy, registeredAt, dryRun });
    todo.forEach((t, k) => { out[t.i] = dryRun ? { ...rows[k], dryRun: true } : rows[k]; });
    if (!dryRun) readBack(todo.map((t) => items[t.i]));
  }
  return out;
}

/**
 * 写完要读回（W05 复核 P2-1）：台账是追加文件，读的时候丢掉解析不了的行；上一次写到一半（磁盘满、进程被杀）留下的残行会把新写的一行粘坏，
 * 写入照常返回、标记却读不出来。读回走读者的同一条路（读台账行 → segmentsFor / reviewedThrough）：这些包的标记必须在、区间上每一天都被标记盖住、
 * 该市场「复盘看到哪天」不早于它的截止日；否则拒绝（REVIEW_PACK_SEEN_NOT_READBACK），入库方不算交付，下一轮重试（残行已被新行收尾，重试写的是新的一行）。
 */
function readBack(items) {
  const after = read(ledger.SEGMENTS());
  for (const it of items) {
    const where = `${it.market} ${it.week_id}`;
    need(findMark(after, it), 'NOT_READBACK', `${where}: the mark is not in the ledger as read back`);
    const { pieces } = ledger.segmentsFor(`${ledger.MARKET_FAMILY_PREFIX}${it.market}`, it.from, it.to, { marks: after, market: it.market });
    need(pieces.every((p) => p.label === 'SEEN' && p.source !== 'UNMARKED_DEFAULT_SEEN'), 'NOT_READBACK', `${where}: segmentsFor does not see the range ${it.from}..${it.to} as marked`);
    const through = reviewedThrough(it.market, { marks: after });
    need(through !== null && through >= it.to, 'NOT_READBACK', `${where}: reviewed through ${through} is before ${it.to}`);
  }
}

/** 交付一份事实包：写它的 SEEN 标记（每个市场一条）。 */
function markPack(input, opts = {}) {
  return markItems(describe(input, { fileBytes: opts.fileBytes || null, now: opts.now }), opts);
}

/** 交付的文件字节：解析、核对、写标记。 */
function markBytes(bytes, opts = {}) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return fail('NOT_JSON'); }
  return markPack(parsed, { ...opts, fileBytes: Buffer.from(bytes) });
}

// ── 读 ─────────────────────────────────────────────────────────────────────────

const asOfOk = (asOf) => (m) => !asOf || (Number.isFinite(Date.parse(m.registered_at)) && Date.parse(m.registered_at) <= Date.parse(asOf));

/** 事实包的 SEEN 标记（台账里按写入顺序；可按市场、按 as_of 过滤）。 */
function packMarks({ market = null, asOf = null, rows = null } = {}) {
  const want = market ? ledger.normalizeMarket(market) : null;
  return (rows || read(ledger.SEGMENTS())).filter((m) => ledger.isReviewPackMark(m) && (!want || ledger.normalizeMarket(m.market) === want) && asOfOk(asOf)(m));
}

/** 该市场复盘看到哪一天：来源为事实包的 SEEN 标记的最大结束日；没有标记 → null。由标记推出，不另存。 */
function reviewedThrough(market, { marks = null, asOf = null } = {}) {
  const rows = packMarks({ market, asOf, rows: marks });
  return rows.length ? maxOf(rows.map((m) => m.to)) : null;
}

/** 该市场的已复盘区间（相同区间合并，按起点排序）：[{ from, to, mark_id }]。 */
function seenRanges(market, { marks = null, asOf = null } = {}) {
  const out = [];
  for (const m of packMarks({ market, asOf, rows: marks })) if (!out.some((r) => r.from === m.from && r.to === m.to)) out.push({ from: m.from, to: m.to, mark_id: m.mark_id });
  return out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/** 两段闭区间是否相交 / 一组区间里最晚的结束日（实验链路 seen.js 用，区间运算只在这里一处）。 */
const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;
const lastDay = (ranges) => (ranges.length ? maxOf(ranges.map((r) => r.to)) : null);

const summary = (m) => ({ mark_id: m.mark_id, market: m.market, from: m.from, to: m.to, sha256: m.source_refs[0].sha256, file_sha256: m.source_refs[0].file_sha256 || null,
  pack_kind: m.source_refs[0].pack_kind, week_id: m.source_refs[0].week_id, replayHit: m.replayHit === true, ...(m.dryRun ? { dryRun: true } : {}) });

// ── 回填（存档的包）─────────────────────────────────────────────────────────────

const keyOf = (e) => [e.kind, e.week_id, e.revision === undefined ? 0 : e.revision, e.kind === 'AI_FACT_PACK' ? e.market : ''].join('|');

/**
 * 回填：读存档目录里已交付过的包（周编 REVIEW_LOOP_WEEK_*.json、AI 事实包 REVIEW_AI_FACT_PACK_<市场>_<周>.json；只读，不改存档），逐个按 markPack 写标记（幂等）。
 * 找不到存档的包不猜：expected 里没有对应存档的列进 missing。读不出的存档列进 invalid（错误码），其余错误（权限等）照常抛出。
 * @param {{archives: string[], expected?: {kind: 'WEEKLY_COMPILE'|'AI_FACT_PACK', week_id: string, revision?: number, market?: string}[]}} o
 * @returns {{marked: object[], invalid: object[], missing: object[]}}
 */
function backfill({ archives, expected = [], registeredBy, registeredAt = null, dryRun = false, now = undefined } = {}) {
  need(Array.isArray(archives) && archives.length > 0, 'ARCHIVE_REQUIRED');
  const marked = []; const invalid = []; const found = new Set();
  for (const dir of archives) {
    for (const name of fs.readdirSync(dir).filter((n) => WEEK_FILE.test(n) || AI_FILE.test(n)).sort()) {
      const bytes = fs.readFileSync(path.join(dir, name));
      try {
        let parsed;
        try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail('NOT_JSON', name); }
        const items = describe(parsed, { fileBytes: bytes, now });
        const rows = markItems(items, { registeredBy, registeredAt, dryRun });
        items.forEach((it, i) => {
          found.add(keyOf({ kind: it.pack_kind, week_id: it.week_id, revision: it.revision, market: it.market }));
          marked.push({ file: name, ...summary(rows[i]), revision: it.revision });
        });
      } catch (e) {
        if (!(e instanceof ReviewPackSeenError)) throw e;
        invalid.push({ file: name, code: e.code, detail: e.detail });
      }
    }
  }
  return { marked, invalid, missing: expected.filter((e) => !found.has(keyOf(e))) };
}

module.exports = {
  KIND, DATA_START, ReviewPackSeenError, packSha256, describe, markItems, markPack, markBytes, packMarks, reviewedThrough, seenRanges, dataStart, backfill, summary, overlaps, lastDay,
};
