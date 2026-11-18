'use strict';

/**
 * 挖掘沙箱的数据适配器（RF1116 P2；导出规格 rev 2 `RF1116_CN_A_LANE_EXPORT_SPEC_V1` 744c453e 的文件与列；冻结的空间 0d3556fa 的读数与历史时钟；
 * 冻结准备 §2.3 的股票池；MINING_SANDBOX_V1「只用历史、按 P-14 次日开盘决策」）：把车道上的导出目录读成求值器要的面板。
 *
 * 面板 { segment, dates, codes, readings, industry, size, universe, labels: { exec_open }, manifest }：
 *   - dates 是决策日（开盘执行），取上交所的开市日（导出规格 rev 3 a24afab2：日历来自 canonical_calendar_observation，交易所在 exchange 列；
 *     SSE 与 SZSE 不一致的日子列进 manifest.calendar）；readings[r][i][j] 是决策日 dates[i] 开盘时可用的值，即前一交易日的行（两种历史时钟 BAR_CLOSE、
 *     CLOSE_DATED_NEXT_OPEN_USABLE 都是「t 日的行只喂 t+1 开盘」）。没有那一天的行就是 NaN，不往前补。assertUsable 拒绝更早的用法（MINE_DATA_LOOK_AHEAD）。
 *   - 后复权价 = 原始价 × 同一天的 adjustment_factor_observation 因子（导出规格 rev 2；prices_daily.adjustment_factor 那一列不用）。
 *     ret_1d = close / previous_close − 1（前收是除权后的，等于 Tushare pct_chg）；amount = turnover_amount_cny；其余取 daily_basic 的 values。
 *   - 同一 (证券, 日期) 的多个修订：次一交易日 09:00（北京时间）之前入库的里取入库最晚的（同刻取修订号大的）；
 *     一个都没赶上：LIVE 目录（验证折尾段、留出段）不用，计 late_unused；HISTORY 目录（车道副本，回补的历史）取最早入库那一刻的
 *     （同一时刻几个修订取修订号大的），计 backfill（P-14 的回补约定待协调会话确认，这里先取「最早记录」，不用后来的更正）。quality_state 不是 READY 的行不用，计 quality_skipped。
 *   - 股票池 universe[i][j]：沪深主板、创业板、科创板（北交所整只不进面板）；决策日当天不是 ST、上市满 120 个交易日（按交易日历数）、
 *     当天没有整日停牌、上市状态 LISTED、没退市。证券主表取决策日当天或之前最近的快照。
 *   - 行业 industry[i][j]：申万 2021 一级（industry_code）；成员按 effective_from ≤ 决策日 < effective_to 截断，修订按入库时刻同上（成员表都是回补的历史，
 *     没赶上就取最早记录）；同时有几条覆盖时取 effective_from 最晚的。市值 size = 前一交易日的 total_mv（中性化用）。
 *   - 标签 labels.exec_open[i][j] = 决策日当天开盘的后复权价（当天的原始开盘价 × 当天因子）：只给打分算前推收益，不是读数；
 *     labels.open_raw / prev_close_raw 是当天的原始开盘价与前收，board[j] 是板块（V6 的代码前缀规则，../price-limits），st[i][j] 是当天是否 ST：
 *     只给扣成本净值判涨跌停能否成交（协调会话裁定 R1.7）。
 *   - 分段：挖掘段的面板整段在挖掘段里；验证折、留出段的面板可以带前面的历史（时序算子要回看），但不能超过本段终点；
 *     标了 holdout 的数据源只能进留出段的面板（MINE_DATA_HOLDOUT_SOURCE_OUTSIDE_HOLDOUT）。
 * 数据源：csvDirSource 读导出规格的 CSV 目录，每个文件读的同时核 SHA256SUMS；车道副本的读法可换（loadSource 的 adapter：一个导出 createSource(dir, opts) 的模块）。
 * 只读：不写文件、不连网络、不碰台账。错误码 MINE_DATA_*。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { forEachCsvRow } = require('./csv');
const segs = require('../segments');
const limits = require('../price-limits');

const FILES = Object.freeze({
  prices: 'prices_daily_stock.csv', basic: 'market_daily_basic_observation_stock.csv', adj: 'adjustment_factor_observation_stock.csv', master: 'security_master_stock.csv',
  suspension: 'security_suspension_observation.csv', calendar: 'trading_calendar.csv', industry: 'industry_membership_sw2021.csv',
});
const MODES = Object.freeze(['HISTORY', 'LIVE']);
const SUFFIXED = /^_\d{8}\.csv$/;
const ACCEPTED_QUALITY = Object.freeze(['READY']);
/**
 * 行业成员表另收 DEGRADED（★RF1116_INDUSTRY_QUALITY，2026-11-18 第 1 轮缺陷之后）：V6 把每一行行业成员都写成 DEGRADED
 * （Ashare-V6 src/data-runtime/canonicalize.js:460：单一来源 Tushare index_member_all，没有第二来源核对），
 * 只收 READY 等于一行都不收，打分前的行业中性化就把每个值都变成 NaN。行业只用于中性化与分组，不是读数。其余各表仍只收 READY。
 */
const ACCEPTED_INDUSTRY_QUALITY = Object.freeze(['READY', 'DEGRADED']);
/**
 * 行业数据的局限（独立复审 M-4，写进面板清单 industry_limits，只看本面板实际用到的数据）：
 *   - SINGLE_SOURCE_NOT_RECONCILED：用了 DEGRADED 的成员行（V6 只有一个来源，没有第二来源核对）；
 *   - HISTORY_BACKDATED_BY_SOURCE：SW2021 的成员按上市日回溯（例如 1991 年），first_available_at 也跟着回溯，而 SW2021 本身 2021 年才有；
 *     面板里 2021-01-01 之前的日子用到了它，那些日子的分类是事后重述的历史（只用于中性化与分组）。
 */
const INDUSTRY_STANDARD_START = Object.freeze({ SW2021: '2021-01-01' });
/** 成员的 effective_to 含当天（★RF1116_INDUSTRY_END_INCLUSIVE (a)）；用到了写有 effective_to 的成员时，局限里写 END_DATE_INCLUSIVE_V6_READS_EXCLUSIVE（直到 V6 改）。 */
const INDUSTRY_EFFECTIVE_TO = 'INCLUSIVE';
/** 历史时钟 → 最早可用的决策：两种都是次一交易日开盘（MINING_SANDBOX_V1：只用历史、按 P-14 次日开盘决策）。 */
const CLOCKS = Object.freeze({ BAR_CLOSE: 'NEXT_OPEN', CLOSE_DATED_NEXT_OPEN_USABLE: 'NEXT_OPEN' });
const LIVE_CUTOFF = 'T09:00:00+08:00';
const MIN_LISTED_SESSIONS = 120;
const INDUSTRY = Object.freeze({ standard: 'SW2021', level: 'L1' });
/** 开市日的来源：上交所（导出规格 rev 3：canonical_calendar_observation 的 market 恒为 A_SHARE，交易所在 exchange 列）。 */
const CALENDAR_EXCHANGE = 'SSE';
const BASIC_FIELDS = Object.freeze({ turnover_f: 'turnover_rate_f', total_mv: 'total_mv', circ_mv: 'circ_mv', pe_ttm: 'pe_ttm', pb: 'pb', ps_ttm: 'ps_ttm', dv_ttm: 'dv_ttm' });
const BARS = 'V6_CN_STOCK_DAILY_BARS';
const BASIC = 'V6_CN_STOCK_DAILY_BASIC';
/** 冻结空间的读数 → 怎么从导出的表算（数据集与序列必须和空间里写的一致）。 */
const READINGS = Object.freeze({
  close_hfq: Object.freeze({ dataset_id: BARS, series: ['daily', 'adj_factor'], kind: 'HFQ', field: 'close' }),
  open_hfq: Object.freeze({ dataset_id: BARS, series: ['daily', 'adj_factor'], kind: 'HFQ', field: 'open' }),
  high_hfq: Object.freeze({ dataset_id: BARS, series: ['daily', 'adj_factor'], kind: 'HFQ', field: 'high' }),
  low_hfq: Object.freeze({ dataset_id: BARS, series: ['daily', 'adj_factor'], kind: 'HFQ', field: 'low' }),
  ret_1d: Object.freeze({ dataset_id: BARS, series: 'daily', kind: 'RET_1D' }),
  amount: Object.freeze({ dataset_id: BARS, series: 'daily', kind: 'DAILY', field: 'amount' }),
  ...Object.fromEntries(Object.keys(BASIC_FIELDS).map((k) => [k, Object.freeze({ dataset_id: BASIC, series: null, kind: 'BASIC', field: k })])),
});

class DataError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new DataError(`MINE_DATA_${code}`, detail); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
/**
 * V6 的取值形状（第 1 轮的第二个数据原因，2026-11-18 车道探针）：market_daily_basic_observation.values 的每个字段是 { state, value }。
 * PRESENT → value；ZERO → 0；MISSING 与其他任何 state → NaN（调用方计入 value_missing）；裸数照收；别的形状（对象、字符串里不是数）→ NaN。
 * 原来 Number(对象) 恒为 NaN：七个 daily_basic 读数与市值全是 NaN，市值中性化把每个值都变成 NaN。
 */
const VALUE_STATES = Object.freeze({ PRESENT: 'VALUE', ZERO: 'ZERO' });
function stateValue(x) {
  if (x !== null && typeof x === 'object' && !Array.isArray(x)) {
    const how = VALUE_STATES[x.state];
    return how === 'ZERO' ? 0 : how === 'VALUE' ? num(x.value) : NaN;
  }
  return typeof x === 'number' || typeof x === 'string' ? num(x) : NaN;
}

// ── 时刻与日历 ───────────────────────────────────────────────────────────────

const TS = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/;
/** Postgres timestamptz 的文本（`2026-10-09 18:30:00.123+08`、`…+08:00`、`…Z`）→ 毫秒；认不出 → 拒绝（不猜）。 */
function parseTs(s) {
  const m = TS.exec(String(s || ''));
  if (!m) fail('TIMESTAMP_INVALID', s);
  const frac = m[3] ? m[3].slice(0, 4).padEnd(4, '0') : '';
  let tz = m[4];
  if (tz !== 'Z') tz = tz.length === 3 ? `${tz}:00` : tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz;
  const ms = Date.parse(`${m[1]}T${m[2]}${frac}${tz}`);
  if (!Number.isFinite(ms)) fail('TIMESTAMP_INVALID', s);
  return ms;
}
/** 升序数组里第一个 > x 的下标。 */
function upper(arr, x) { let lo = 0; let hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; } return lo; }
/** 升序数组里第一个 ≥ x 的下标。 */
function lower(arr, x) { let lo = 0; let hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; }

/** 读数的时钟（pit_available_at 的第一个记号）。 */
const clockOf = (pit) => String(pit || '').trim().split(/\s+/)[0];

/**
 * t 日的行最早能喂哪一天开盘的决策（calendar = 升序的开市日）。只认 CLOCKS 里的历史时钟。
 */
function usableFrom(tradeDate, clock, calendar) {
  if (!Object.prototype.hasOwnProperty.call(CLOCKS, clock)) fail('CLOCK_UNSUPPORTED', clock);
  const k = upper(calendar, tradeDate);
  return k < calendar.length ? calendar[k] : null;
}

/** 看未来的护栏：t 日的行用在 t 日或更早的决策上 → MINE_DATA_LOOK_AHEAD。返回最早可用的决策日。 */
function assertUsable({ trade_date: tradeDate, clock }, decisionDate, calendar) {
  const first = usableFrom(tradeDate, clock, calendar);
  if (first === null || decisionDate < first) fail('LOOK_AHEAD', `${tradeDate}->${decisionDate}(${clock}, first usable ${first})`);
  return first;
}

// ── 数据源 ──────────────────────────────────────────────────────────────────

/**
 * 导出规格的 CSV 目录。mode：HISTORY（车道副本，回补的历史）或 LIVE（从生产导出的、带真实入库时刻的段）；holdout：留出段目录（只进留出段的面板）。
 * 每个文件读的同时算 sha256，读完对 SHA256SUMS；不在清单里 → MINE_DATA_FILE_NOT_IN_SHA256SUMS，对不上 → MINE_DATA_SHA256SUMS_MISMATCH。
 */
function csvDirSource(dir, { mode, label, holdout = false } = {}) {
  if (!MODES.includes(mode)) fail('SOURCE_MODE', mode);
  if (typeof label !== 'string' || !label) fail('SOURCE_LABEL', label);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail('SOURCE_DIR', dir);
  const sumsFile = path.join(dir, 'SHA256SUMS');
  if (!fs.existsSync(sumsFile)) fail('SHA256SUMS_MISSING', dir);
  const sumsBytes = fs.readFileSync(sumsFile);
  const sums = new Map();
  for (const line of sumsBytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (!m) fail('SHA256SUMS_LINE', line);
    sums.set(m[2], m[1]);
  }
  const manifestFile = path.join(dir, 'EXPORT_MANIFEST.json');
  const manifestSha = fs.existsSync(manifestFile) ? sha256(fs.readFileSync(manifestFile)) : null;
  return Object.freeze({
    kind: 'CSV_DIR', label, mode, holdout: holdout === true, dir, sums_sha256: sha256(sumsBytes), manifest_sha256: manifestSha,
    has: (table) => Boolean(FILES[table]) && fs.existsSync(path.join(dir, FILES[table])),
    /** 读一张表：基础文件，再按文件名顺序读补导的 <表>_<YYYYMMDD>.csv（导出规格 §1：留出段 12-31 之后补导，同一目录，新文件带日期后缀）。 */
    forEach(table, onRow) {
      const name = FILES[table];
      if (!name) fail('TABLE_UNKNOWN', table);
      if (!fs.existsSync(path.join(dir, name))) fail('FILE_MISSING', `${label}:${name}`);
      const stem = name.slice(0, -'.csv'.length);
      const parts = [name, ...fs.readdirSync(dir).filter((n) => n.startsWith(stem) && SUFFIXED.test(n.slice(stem.length))).sort()];
      let rows = 0;
      for (const part of parts) {
        const want = sums.get(part);
        if (!want) fail('FILE_NOT_IN_SHA256SUMS', `${label}:${part}`);
        const r = forEachCsvRow(path.join(dir, part), onRow);
        if (r.sha256 !== want) fail('SHA256SUMS_MISMATCH', `${label}:${part}`);
        rows += r.rows;
      }
      return { rows, files: parts };
    },
  });
}

/** 建一个数据源：给了 adapter（模块路径，导出 createSource(dir, { mode, label, holdout })）就用它，不给用 csvDirSource。 */
function loadSource({ dir, mode, label, holdout = false, adapter = null } = {}) {
  if (!adapter) return csvDirSource(dir, { mode, label, holdout });
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const m = require(path.resolve(adapter));
  if (!m || typeof m.createSource !== 'function') fail('ADAPTER_INVALID', adapter);
  const s = m.createSource(dir, { mode, label, holdout });
  if (!s || typeof s.forEach !== 'function' || typeof s.has !== 'function' || s.label !== label || s.mode !== mode || Boolean(s.holdout) !== Boolean(holdout)) fail('ADAPTER_INVALID', adapter);
  return s;
}

// ── 面板 ────────────────────────────────────────────────────────────────────

function mapReadings(space) {
  if (!space || !Array.isArray(space.readings) || !space.readings.length) fail('SPACE_INVALID');
  return space.readings.map((r) => {
    const m = Object.prototype.hasOwnProperty.call(READINGS, r.name) ? READINGS[r.name] : null;
    const sameSeries = m && JSON.stringify(m.series ?? null) === JSON.stringify(r.series ?? null);
    if (!m || m.dataset_id !== r.dataset_id || !sameSeries) fail('READING_UNMAPPED', `${r.name}@${r.dataset_id}`);
    const clock = clockOf(r.pit_available_at);
    if (!Object.prototype.hasOwnProperty.call(CLOCKS, clock)) fail('CLOCK_UNSUPPORTED', `${r.name}:${clock}`);
    return { name: r.name, clock, ...m };
  });
}

/**
 * 修订的选择状态（每个格子一份）：cat 2 = 截止前入库，1 = 回补（只在 HISTORY），0 = 没有。
 * 截止前入库的取入库最晚的；回补的取「最早入库那一刻的知识」：入库最早的时刻，同一时刻有几个修订取修订号大的。
 */
/** 同一格两行谁算数（LATEST_FIRST_AVAILABLE_BY_CUTOFF 里「截止前入库」那一类）：入库晚的；同一时刻修订号大的（相等取后读到的）。面板与留出段核对共用。 */
const laterRevision = (curAt, curRev, at, rev) => at > curAt || (at === curAt && rev >= curRev);
/** LIVE 源的截止：t 日收盘记的行，要在下一个开市日 09:00 +08 之前入库才算数（CLOSE_DATED_NEXT_OPEN_USABLE）；日历里没有下一个开市日 → -Infinity（没有决策日读它）。
 *  面板与留出段核对共用这一份（复审 #127 P1-1：不再各写一份）。cal = 排好序的开市日。 */
function liveCutoffs(cal) {
  const cache = new Map();
  return (t) => {
    let c = cache.get(t);
    if (c === undefined) { const d = usableFrom(t, 'CLOSE_DATED_NEXT_OPEN_USABLE', cal); c = d ? Date.parse(`${d}${LIVE_CUTOFF}`) : -Infinity; cache.set(t, c); }
    return c;
  };
}
/** daily_basic 的 values 里哪些状态读得出数（stateValue：PRESENT → value，ZERO → 0，其余 NaN）。留出段核对只数状态，不读数。 */
const USABLE_BASIC_STATES = Object.freeze(Object.keys(VALUE_STATES));

function selector(cells) {
  const cat = new Int8Array(cells); const fa = new Float64Array(cells); const rev = new Int32Array(cells);
  return {
    cat,
    take(k, c, at, r) {
      const cur = cat[k];
      const better = c === 2 ? (cur < 2 || laterRevision(fa[k], rev[k], at, r))
        : c === 1 ? (cur === 0 || (cur === 1 && (at < fa[k] || (at === fa[k] && r >= rev[k])))) : false;
      if (better) { cat[k] = c; fa[k] = at; rev[k] = r; }
      return better;
    },
    backfilled() { let n = 0; for (let k = 0; k < cells; k += 1) if (cat[k] === 1) n += 1; return n; },
  };
}

/**
 * @param {{sources: object[], space: object, segment: 'MINING'|'VALIDATION'|'HOLDOUT', from: string, to: string,
 *          calendarExchange?: string, minListedSessions?: number, industry?: {standard, level}}} o
 */
function buildPanel({ sources, space, segment, from, to, calendarExchange = CALENDAR_EXCHANGE, minListedSessions = MIN_LISTED_SESSIONS, industry = INDUSTRY } = {}) {
  const seg = Object.prototype.hasOwnProperty.call(segs.SEGMENTS, segment) ? segs.SEGMENTS[segment] : null;
  if (!seg) fail('SEGMENT_UNKNOWN', segment);
  if (!(typeof from === 'string' && typeof to === 'string' && from <= to)) fail('RANGE_INVALID', `${from}..${to}`);
  const lo = segment === 'MINING' ? seg.from : segs.SEGMENTS.MINING.from;
  if (from < lo || to > seg.to) fail('SEGMENT_RANGE', `${segment}:${from}..${to} outside ${lo}..${seg.to}`);
  if (!Array.isArray(sources) || !sources.length) fail('SOURCES_MISSING');
  for (const s of sources) if (s.holdout && segment !== 'HOLDOUT') fail('HOLDOUT_SOURCE_OUTSIDE_HOLDOUT', s.label);
  const readings = mapReadings(space);

  // 交易日历（导出规格 rev 3）：交易所取 exchange 列，没有这一列（旧写法）才看 market；每个 (日期, 交易所) 取入库最晚的、同刻取修订号大的；
  // 开市日只认 calendarExchange（SSE）；SSE 与 SZSE 的 is_open 不一致的日子列进 manifest.calendar（不顶替、不静默）
  const calRows = new Map(); let calMax = '';
  for (const s of sources) {
    if (!s.has('calendar')) continue;
    s.forEach('calendar', (r) => {
      if (!ACCEPTED_QUALITY.includes(r.quality_state === undefined ? 'READY' : r.quality_state)) return;
      const ex = Object.prototype.hasOwnProperty.call(r, 'exchange') ? r.exchange : r.market;
      const at = parseTs(r.first_available_at); const rev = r.revision === undefined || r.revision === null ? 0 : Number(r.revision);
      const key = `${r.calendar_date}|${ex}`; const cur = calRows.get(key);
      if (!cur || at > cur.at || (at === cur.at && rev >= cur.rev)) calRows.set(key, { date: r.calendar_date, ex, at, rev, open: r.is_open === 't' || r.is_open === 'true' });
      if (ex === calendarExchange && r.calendar_date > calMax) calMax = r.calendar_date;
    });
  }
  const byExchange = (ex) => new Map([...calRows.values()].filter((v) => v.ex === ex).map((v) => [v.date, v.open]));
  const sse = byExchange(calendarExchange); const other = byExchange(calendarExchange === 'SSE' ? 'SZSE' : 'SSE');
  const disagreements = [...sse.entries()].filter(([d, o]) => other.has(d) && other.get(d) !== o).map(([d]) => d).sort();
  const cal = [...sse.entries()].filter(([, o]) => o).map(([d]) => d).sort();
  if (!cal.length) fail('CALENDAR_MISSING', calendarExchange);
  if (calMax < to) fail('CALENDAR_RANGE', `${calMax}<${to}`);
  const dates = cal.filter((d) => d >= from && d <= to);
  if (!dates.length) fail('NO_TRADING_DAYS', `${from}..${to}`);
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const cutoffOf = liveCutoffs(cal);
  const placeOf = (t) => { const d = usableFrom(t, 'CLOSE_DATED_NEXT_OPEN_USABLE', cal); return d === null ? undefined : dateIdx.get(d); };

  // 证券主表：股票、非北交所；每只记快照的变化点
  const timeline = new Map();
  for (const s of sources) {
    if (!s.has('master')) continue;
    s.forEach('master', (r) => {
      if (r.asset_class !== 'STOCK' || r.exchange === 'BSE' || r.board === 'BSE') return;
      if (!ACCEPTED_QUALITY.includes(r.quality_state)) return;
      if (!timeline.has(r.security_id)) timeline.set(r.security_id, []);
      timeline.get(r.security_id).push({ d: r.business_date, risk: r.risk_warning_status, status: r.listing_status, listing: r.listing_date, delisting: r.delisting_date, board: r.board });
    });
  }
  const codes = [...timeline.keys()].sort();
  if (!codes.length) fail('NO_SECURITIES');
  const codeIdx = new Map(codes.map((c, j) => [c, j]));
  for (const [c, list] of timeline) {
    list.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const key = (x) => `${x.risk}|${x.status}|${x.listing}|${x.delisting}|${x.board}`;
    timeline.set(c, list.filter((x, k) => k === 0 || key(x) !== key(list[k - 1])));
  }
  const T = dates.length; const N = codes.length; const cells = T * N;
  const mat = () => new Float64Array(cells).fill(NaN);
  const counts = {
    prices_daily: { rows: 0, quality_skipped: 0, late_unused: 0, backfill: 0 }, adj_factor: { rows: 0, quality_skipped: 0, late_unused: 0, backfill: 0, value_missing: 0 },
    daily_basic: { rows: 0, quality_skipped: 0, late_unused: 0, backfill: 0, value_missing: 0 }, suspension: { rows: 0 }, industry: { rows: 0, backfill: 0, by_quality: Object.fromEntries(ACCEPTED_INDUSTRY_QUALITY.map((q) => [q, 0])), quality_skipped: 0 },
  };
  /** 一行进格子：截止前入库 → 2；没赶上 → HISTORY 回补 1 / LIVE 不用（计数）。 */
  const category = (src, t, at, c) => (at <= cutoffOf(t) ? 2 : src.mode === 'HISTORY' ? 1 : (c.late_unused += 1, 0));

  // 日线：滞后一格（读数）与当天（执行价标签）
  const P = { open: mat(), high: mat(), low: mat(), close: mat(), prev_close: mat(), amount: mat() };
  const execOpen = mat(); const prevCloseX = mat(); const selP = selector(cells); const selPx = selector(cells);
  for (const s of sources) {
    if (!s.has('prices')) continue;
    s.forEach('prices', (r) => {
      const j = codeIdx.get(r.security_id); if (j === undefined) return;
      const i = placeOf(r.trade_date); const i0 = dateIdx.get(r.trade_date);
      if (i === undefined && i0 === undefined) return;
      counts.prices_daily.rows += 1;
      if (!ACCEPTED_QUALITY.includes(r.quality_state)) { counts.prices_daily.quality_skipped += 1; return; }
      const at = parseTs(r.first_available_at); const rev = Number(r.revision);
      if (i !== undefined) {
        const k = i * N + j; const c = category(s, r.trade_date, at, counts.prices_daily);
        if (c && selP.take(k, c, at, rev)) {
          P.open[k] = num(r.open); P.high[k] = num(r.high); P.low[k] = num(r.low); P.close[k] = num(r.close); P.prev_close[k] = num(r.previous_close); P.amount[k] = num(r.turnover_amount_cny);
        }
      }
      if (i0 !== undefined) { const k = i0 * N + j; if (selPx.take(k, 2, at, rev)) { execOpen[k] = num(r.open); prevCloseX[k] = num(r.previous_close); } }
    });
  }
  // 复权因子：同上两处
  const factor = mat(); const factorX = mat(); const selA = selector(cells); const selAx = selector(cells);
  for (const s of sources) {
    if (!s.has('adj')) continue;
    s.forEach('adj', (r) => {
      const j = codeIdx.get(r.security_id); if (j === undefined) return;
      const i = placeOf(r.trade_date); const i0 = dateIdx.get(r.trade_date);
      if (i === undefined && i0 === undefined) return;
      counts.adj_factor.rows += 1;
      if (!ACCEPTED_QUALITY.includes(r.quality_state)) { counts.adj_factor.quality_skipped += 1; return; }
      const v = num(r.adjustment_factor);
      if (!(v > 0)) { counts.adj_factor.value_missing += 1; return; }
      const at = parseTs(r.first_available_at); const rev = Number(r.revision);
      if (i !== undefined) { const k = i * N + j; const c = category(s, r.trade_date, at, counts.adj_factor); if (c && selA.take(k, c, at, rev)) factor[k] = v; }
      if (i0 !== undefined) { const k = i0 * N + j; if (selAx.take(k, 2, at, rev)) factorX[k] = v; }
    });
  }
  // daily_basic：只有滞后一格
  const B = Object.fromEntries(Object.keys(BASIC_FIELDS).map((k) => [k, mat()]));
  const selB = selector(cells);
  for (const s of sources) {
    if (!s.has('basic')) continue;
    s.forEach('basic', (r) => {
      const j = codeIdx.get(r.security_id); if (j === undefined) return;
      const i = placeOf(r.trade_date); if (i === undefined) return;
      counts.daily_basic.rows += 1;
      if (!ACCEPTED_QUALITY.includes(r.quality_state)) { counts.daily_basic.quality_skipped += 1; return; }
      const at = parseTs(r.first_available_at); const k = i * N + j;
      const c = category(s, r.trade_date, at, counts.daily_basic);
      if (!c || !selB.take(k, c, at, Number(r.revision))) return;
      let v; try { v = JSON.parse(r.values); } catch { fail('BASIC_VALUES_INVALID', `${r.security_id}:${r.trade_date}`); }
      for (const [name, key] of Object.entries(BASIC_FIELDS)) { const x = stateValue(v ? v[key] : null); if (!Number.isFinite(x)) counts.daily_basic.value_missing += 1; B[name][k] = x; }
    });
  }
  counts.prices_daily.backfill = selP.backfilled(); counts.adj_factor.backfill = selA.backfilled(); counts.daily_basic.backfill = selB.backfilled();
  // 当天整日停牌
  const suspended = new Uint8Array(cells);
  for (const s of sources) {
    if (!s.has('suspension')) continue;
    s.forEach('suspension', (r) => {
      const j = codeIdx.get(r.security_id); const i0 = dateIdx.get(r.trade_date);
      if (j === undefined || i0 === undefined || !ACCEPTED_QUALITY.includes(r.quality_state)) return;
      if (r.suspension_type === 'S' && (r.full_session === 't' || r.full_session === 'true')) { suspended[i0 * N + j] = 1; counts.suspension.rows += 1; }
    });
  }
  // 行业成员：按 (证券, effective_from) 分组，组内按入库时刻选修订
  const groups = new Map(); let endDated = false;
  for (const s of sources) {
    if (!s.has('industry')) continue;
    s.forEach('industry', (r) => {
      if (r.industry_standard !== industry.standard || r.industry_level !== industry.level || !codeIdx.has(r.security_id)) return;
      if (!ACCEPTED_INDUSTRY_QUALITY.includes(r.quality_state)) { counts.industry.quality_skipped += 1; return; }
      counts.industry.rows += 1;
      counts.industry.by_quality[r.quality_state] += 1;
      const key = `${r.security_id}|${r.effective_from}`;
      if (!groups.has(key)) groups.set(key, { code: r.security_id, from: r.effective_from, revs: [] });
      groups.get(key).revs.push({ at: parseTs(r.first_available_at), rev: Number(r.revision), to: r.effective_to, value: r.industry_code || r.industry_name });
      if (r.effective_to) endDated = true;
    });
  }
  const byCode = new Map();
  for (const g of groups.values()) { if (!byCode.has(g.code)) byCode.set(g.code, []); byCode.get(g.code).push(g); }
  const industryM = Array.from({ length: T }, () => new Array(N).fill(null));
  for (const [c, list] of byCode) {
    const j = codeIdx.get(c);
    list.sort((a, b) => (a.from < b.from ? -1 : 1));
    for (let i = 0; i < T; i += 1) {
      const d = dates[i]; const cutoff = Date.parse(`${d}${LIVE_CUTOFF}`);
      let best = null; let backfill = false;
      for (const g of list) {
        if (g.from > d) continue;
        const known = g.revs.filter((x) => x.at <= cutoff);
        const pick = known.length ? known.reduce((a, b) => (b.at > a.at || (b.at === a.at && b.rev >= a.rev) ? b : a))
          : g.revs.reduce((a, b) => (b.at < a.at || (b.at === a.at && b.rev >= a.rev) ? b : a));
        // ★RF1116_INDUSTRY_END_INCLUSIVE (a)：effective_to 是成员的最后一天（含）。V6 真实数据里新成员的 effective_from 是它的下一天；
        // 按不含读（V6 现在的读法），换行业的股票在最后一天没有行业（2021-07-29 有 564 只）。V6 的读法另有修复，清单里写明差别。
        if (pick.to && d > pick.to) continue;
        if (!best || g.from >= best.from) { best = { from: g.from, value: pick.value }; backfill = !known.length; }
      }
      if (best) { industryM[i][j] = best.value; if (backfill) counts.industry.backfill += 1; }
    }
  }
  // 行业数据的局限（复审 M-4）：只记本面板实际用到的
  const standardStart = INDUSTRY_STANDARD_START[industry.standard] || null;
  const backdated = standardStart !== null && dates.some((d, i) => d < standardStart && industryM[i].some((g) => g !== null));
  const industryLimits = [...(counts.industry.by_quality.DEGRADED > 0 ? ['SINGLE_SOURCE_NOT_RECONCILED'] : []), ...(backdated ? ['HISTORY_BACKDATED_BY_SOURCE'] : []),
    ...(endDated && counts.industry.rows > 0 ? ['END_DATE_INCLUSIVE_V6_READS_EXCLUSIVE'] : [])];
  // 股票池；同时记当天是否 ST 与板块（涨跌停用，R1.7）
  const universe = Array.from({ length: T }, () => new Array(N).fill(false));
  const st = Array.from({ length: T }, () => new Array(N).fill(false));
  const board = codes.map((c) => { const tl = timeline.get(c); return limits.boardOf(c, tl[tl.length - 1].board); });
  for (let j = 0; j < N; j += 1) {
    const tl = timeline.get(codes[j]); let p = -1;
    for (let i = 0; i < T; i += 1) {
      const d = dates[i];
      while (p + 1 < tl.length && tl[p + 1].d <= d) p += 1;
      const snap = p >= 0 ? tl[p] : null;
      st[i][j] = Boolean(snap && snap.risk === 'ST');
      if (!snap || snap.risk !== 'NORMAL' || snap.status !== 'LISTED' || !snap.listing || (snap.delisting && snap.delisting <= d)) continue;
      const sessions = lower(cal, d) - lower(cal, snap.listing);
      if (sessions < minListedSessions || suspended[i * N + j]) continue;
      universe[i][j] = true;
    }
  }
  // 读数
  const rows = (arr) => Array.from({ length: T }, (_, i) => Array.from(arr.subarray(i * N, (i + 1) * N)));
  const combine = (a, b, f) => { const out = mat(); for (let k = 0; k < cells; k += 1) out[k] = f(a[k], b[k]); return out; };
  const mul = (a, b) => a * b;
  const out = {};
  for (const r of readings) {
    if (r.kind === 'HFQ') out[r.name] = rows(combine(P[r.field], factor, mul));
    else if (r.kind === 'RET_1D') out[r.name] = rows(combine(P.close, P.prev_close, (c, pc) => (pc > 0 ? c / pc - 1 : NaN)));
    else if (r.kind === 'DAILY') out[r.name] = rows(P[r.field]);
    else out[r.name] = rows(B[r.field]);
  }
  return {
    segment, dates, codes, readings: out, industry: industryM, size: rows(B.total_mv), universe, board, st,
    labels: { exec_open: rows(combine(execOpen, factorX, mul)), open_raw: rows(execOpen), prev_close_raw: rows(prevCloseX) },
    manifest: {
      schema: 'MINING_PANEL_V1', segment, from, to, dates: T, codes: N, readings: readings.map((r) => ({ name: r.name, clock: r.clock })),
      sources: sources.map((s) => ({ label: s.label, mode: s.mode, kind: s.kind || null, holdout: Boolean(s.holdout), sums_sha256: s.sums_sha256 || null })),
      rules: {
        decision: 'NEXT_OPEN', live_cutoff: `next trading day ${LIVE_CUTOFF.slice(1)}`, revision_known: 'LATEST_FIRST_AVAILABLE_BY_CUTOFF', revision_history_backfill: 'EARLIEST_RECORDED_INSTANT_HIGHEST_REVISION',
        accepted_quality: [...ACCEPTED_QUALITY], industry_accepted_quality: [...ACCEPTED_INDUSTRY_QUALITY], industry_effective_to: INDUSTRY_EFFECTIVE_TO, min_listed_sessions: minListedSessions, industry: { ...industry }, calendar_exchange: calendarExchange, exchanges_excluded: ['BSE'],
      },
      calendar: { exchange: calendarExchange, open_days_in_sources: cal.length, last_date: calMax, sse_szse_disagreements: disagreements.filter((d) => d >= from && d <= to),
        sse_szse_disagreements_all: disagreements.length },
      counts,
      industry_limits: industryLimits,
    },
  };
}

module.exports = {
  FILES, MODES, ACCEPTED_QUALITY, ACCEPTED_INDUSTRY_QUALITY, CLOCKS, MIN_LISTED_SESSIONS, INDUSTRY, CALENDAR_EXCHANGE, READINGS, BASIC_FIELDS, DataError,
  csvDirSource, loadSource, usableFrom, assertUsable, buildPanel, liveCutoffs, laterRevision, USABLE_BASIC_STATES, LIVE_CUTOFF,
  internals: { forEachCsvRow, parseTs, clockOf, mapReadings, stateValue },
};
