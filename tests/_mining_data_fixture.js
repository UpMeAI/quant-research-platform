'use strict';
/**
 * 合成的 A 股导出目录（RF1116 导出规格 rev 2 的文件与列名；全部是编的数，不是任何真实行情）。给数据适配器、GP、执行器的测试用。
 *
 *   lane/         车道副本（HISTORY）：trade_date 2020-06-01 → 2026-09-28。
 *   交易日历（rev 3）：每个目录同一份 2019-06-01 → 2026-12-31，SSE 与 SZSE 各一行（market = A_SHARE）；上市满 120 个交易日要往前数。
 *                 first_available_at 是回补时刻（2026-03-01），只有最后一个月是「当晚入库」。
 *   tail/         验证折尾段（LIVE）：2026-09-29 → 2026-10-16；行业成员整表只放这里。
 *   holdout/      留出段（LIVE）：2026-10-19 → 2026-12-31。
 * 每个目录都有 SHA256SUMS 与 EXPORT_MANIFEST.json。日历是工作日，去掉每年 1 月 1 日与 10 月 1–8 日。
 *
 * 专门放进去的情形（FACTS 里有日期与数值，测试按它核对）：
 *   - 北交所 B01.BJ（整只排除）；新上市 N01.SZ（2021-03-01 上市）；T01.SH 在 2022-01-04 → 2022-06-30 是 ST；
 *     P01.SZ 在 2021-06-07 → 2021-06-11 整日停牌（这几天没有日线）；
 *   - S03.SH 在 2022-07-01 拆股：原始价减半、复权因子从 1 变 2（后复权价连续）；
 *   - S01.SH 在 2022-03-15 的 daily_basic pb = 999（看未来的反例：只能出现在下一个交易日的决策上）；
 *   - tail：S02.SH 2026-10-09 的 daily_basic 有两个修订，修订 2 在次一交易日 09:00 之后才入库；S04.SZ 2026-10-13 的 daily_basic 只有一个迟到的修订；
 *   - lane：S05.SZ 2021-05-10 的 daily_basic 两个修订都是回补（取最早的那个）；S07.SH 2021-08-02 的日线 quality_state = CONFLICT（不用）；
 *   - 日历：2021-04-07 SSE 开市、SZSE 写成休市（两所不一致，适配器以 SSE 为准并列出）；
 *   - 行业：S08.SZ 的成员修订 2（801080 → 801050）2026-10-12 10:00 才入库；S06.SZ 在 2023-07-03 从 801010 改到 801080（旧成员的修订 2 写了 effective_to）；S12.SZ 的成员 2023-07-17 结束、没有下一条；
 *     每只都有一条从 2016-01-04 起的申万二级（不用）。
 * 收益里埋了一个弱的短期反转（下一日收益 ≈ −0.3 × 当日收益 + 噪声），让 GP 有东西可找；不保证任何结论。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEGMENTS = Object.freeze({ lane: ['2020-06-01', '2026-09-28'], tail: ['2026-09-29', '2026-10-16'], holdout: ['2026-10-19', '2026-12-31'] });
const CAL_FROM = '2019-06-01';
const BACKFILL_AT = '2026-03-01 12:00:00+08';

const STOCKS = Object.freeze([
  ['S01.SH', 'SSE', 'MAIN', '2005-01-04', '801010'], ['S02.SH', 'SSE', 'MAIN', '2006-03-01', '801010'], ['S03.SH', 'SSE', 'STAR', '2019-01-02', '801030'],
  ['S04.SZ', 'SZSE', 'MAIN', '2008-05-05', '801030'], ['S05.SZ', 'SZSE', 'CHINEXT', '2012-07-02', '801050'], ['S06.SZ', 'SZSE', 'MAIN', '2009-09-01', '801010'],
  ['S07.SH', 'SSE', 'MAIN', '2010-01-04', '801050'], ['S08.SZ', 'SZSE', 'CHINEXT', '2014-02-03', '801080'], ['S09.SH', 'SSE', 'STAR', '2019-07-22', '801080'],
  ['S10.SZ', 'SZSE', 'MAIN', '2003-04-01', '801030'], ['S11.SH', 'SSE', 'MAIN', '2001-08-01', '801050'], ['S12.SZ', 'SZSE', 'MAIN', '2011-11-01', '801080'],
  ['T01.SH', 'SSE', 'MAIN', '2007-06-01', '801010'], ['P01.SZ', 'SZSE', 'MAIN', '2013-03-01', '801030'], ['N01.SZ', 'SZSE', 'CHINEXT', '2021-03-01', '801050'],
  ['B01.BJ', 'BSE', 'BSE', '2015-01-05', '801080'],
]);
const FACTS = Object.freeze({
  bse: 'B01.BJ', newListing: { code: 'N01.SZ', listing: '2021-03-01' }, st: { code: 'T01.SH', from: '2022-01-04', to: '2022-06-30' },
  suspended: { code: 'P01.SZ', from: '2021-06-07', to: '2021-06-11' }, split: { code: 'S03.SH', date: '2022-07-01', ratio: 2 },
  lookAhead: { code: 'S01.SH', date: '2022-03-15', pb: 999 },
  liveRevision: { code: 'S02.SH', date: '2026-10-09', rev1: { pb: 2.5, at: '2026-10-09 18:30:00+08' }, rev2: { pb: 7.5, at: '2026-10-12 10:00:00+08' } },
  liveLate: { code: 'S04.SZ', date: '2026-10-13', at: '2026-10-15 08:00:00+08' },
  backfillRevision: { code: 'S05.SZ', date: '2021-05-10', rev1: { pb: 3.25, at: BACKFILL_AT }, rev2: { pb: 6.5, at: '2026-04-01 12:00:00+08' } },
  conflict: { code: 'S07.SH', date: '2021-08-02' },
  calendarDisagree: { date: '2021-04-07', sse: 't', szse: 'f' },
  industryRevision: { code: 'S08.SZ', from: '2015-01-05', before: '801080', after: '801050', at: '2026-10-12 10:00:00+08' },
  reclass: { code: 'S06.SZ', date: '2023-07-03', from: '801010', to: '801080' },
  membershipEnds: { code: 'S12.SZ', date: '2023-07-17' },
});

function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const closedHoliday = (d) => d.slice(5) === '01-01' || (d.slice(5, 7) === '10' && Number(d.slice(8)) <= 8);
function calendar(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, open: weekday(d) !== 0 && weekday(d) !== 6 && !closedHoliday(d) }); return out; }
const inSeg = (d, [a, b]) => d >= a && d <= b;
const segOf = (d) => Object.keys(SEGMENTS).find((k) => inSeg(d, SEGMENTS[k])) || null;
const nextOpen = (openDays, d) => openDays.find((x) => x > d);

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) || s === '' ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (cols, rows) => `${cols.join(',')}\n${rows.map((r) => cols.map((c) => csvField(r[c])).join(',')).join('\n')}${rows.length ? '\n' : ''}`;
const round = (x, k = 4) => Number(x.toFixed(k));

const PRICE_COLS = ['record_id', 'security_id', 'trade_date', 'open', 'high', 'low', 'close', 'previous_close', 'volume_shares', 'turnover_amount_cny', 'adjustment_factor', 'adjustment_mode',
  'value_states', 'first_available_at', 'known_at', 'ingested_at', 'source_record_id', 'revision', 'schema_version', 'quality_state'];
const BASIC_COLS = ['record_id', 'raw_record_id', 'security_id', 'trade_date', 'values', 'first_available_at', 'ingested_at', 'source_record_id', 'revision', 'schema_version', 'quality_state',
  'source_reconciliation_state'];
const ADJ_COLS = ['record_id', 'raw_record_id', 'security_id', 'trade_date', 'adjustment_factor', 'value_state', 'first_available_at', 'ingested_at', 'source_record_id', 'revision', 'schema_version',
  'quality_state'];
// 导出规格 rev 3（a24afab2）§2.1：canonical_security_observation，列名同 rev 2 的 security_master，多 record_id、revision、allow_new_risk
const MASTER_COLS = ['record_id', 'security_id', 'business_date', 'ticker', 'security_code', 'exchange', 'board', 'asset_class', 'display_name', 'name_integrity', 'listing_date', 'delisting_date',
  'listing_status', 'risk_warning_status', 'first_available_at', 'ingested_at', 'source_record_id', 'revision', 'schema_version', 'quality_state', 'allow_new_risk'];
const SUSP_COLS = ['record_id', 'security_id', 'trade_date', 'suspension_type', 'suspension_timing', 'full_session', 'first_available_at', 'ingested_at', 'source_record_id', 'revision',
  'schema_version', 'quality_state'];
const COVER_COLS = ['coverage_id', 'trade_date', 'provider_row_count', 'accepted_row_count', 'full_session_count', 'first_available_at', 'ingested_at', 'job_run_id', 'source_registry_version',
  'quality_state'];
// 导出规格 rev 3 §2.2：canonical_calendar_observation，market 恒为 A_SHARE，交易所在 exchange（SSE / SZSE 各一行），每个目录同一份 2019-06-01 → 2026-12-31
const CAL_COLS = ['calendar_date', 'market', 'exchange', 'is_open', 'previous_open_date', 'first_available_at', 'ingested_at', 'source_record_id', 'revision', 'schema_version', 'quality_state'];
const IND_COLS = ['record_id', 'security_id', 'industry_standard', 'industry_level', 'industry_code', 'industry_name', 'effective_from', 'effective_to', 'first_available_at', 'ingested_at',
  'source_record_id', 'revision', 'schema_version', 'quality_state'];

/** 一天的入库时刻：车道段（除最后一个月）是回补；其余是当晚 18:30。 */
const ingestAt = (d) => (segOf(d) === 'lane' && d < '2026-09-01' ? BACKFILL_AT : `${d} 18:30:00+08`);

/**
 * 写出三个目录。返回 { root, dirs: { lane, tail, holdout }, facts, calendar: [开市日…] }。
 * opts.stocks（默认全部 16 只）可以只取前几只，给端到端测试提速；opts.seed 换随机序列。
 */
function makeMiningDataFixture(root, { seed = 20261117, stocks = STOCKS.length } = {}) {
  const rng = mulberry32(seed);
  const cal = calendar(CAL_FROM, SEGMENTS.holdout[1]);
  const openDays = cal.filter((c) => c.open).map((c) => c.date);
  const tables = {}; for (const k of Object.keys(SEGMENTS)) tables[k] = { prices: [], basic: [], adj: [], master: [], susp: [], cover: [], cal: [], ind: [] };
  const push = (d, t, row) => { const s = segOf(d); if (s) tables[s][t].push(row); };
  let prevOpen = null;
  for (const c of cal) {
    for (const exchange of ['SSE', 'SZSE']) {
      const dis = FACTS.calendarDisagree.date === c.date ? FACTS.calendarDisagree[exchange.toLowerCase()] : null;
      const row = { calendar_date: c.date, market: 'A_SHARE', exchange, is_open: dis || (c.open ? 't' : 'f'), previous_open_date: prevOpen, first_available_at: BACKFILL_AT, ingested_at: BACKFILL_AT,
        source_record_id: `cal:${c.date}:${exchange}`, revision: 1, schema_version: 'synthetic-v1', quality_state: 'READY' };
      for (const k of Object.keys(SEGMENTS)) tables[k].cal.push(row);
    }
    if (c.open) prevOpen = c.date;
  }
  const allMaster = [];
  STOCKS.slice(0, stocks).forEach(([id, exchange, board, listing, industry], k) => {
    let close = 10 + k; let prevRet = 0; let factor = 1; const shares = 1e8 * (k + 1);
    for (const d of openDays) {
      if (d < SEGMENTS.lane[0] || d < listing) continue;
      const st = id === FACTS.st.code && d >= FACTS.st.from && d <= FACTS.st.to;
      const m = { record_id: `sm:${id}:${d}:1`, security_id: id, business_date: d, ticker: id, security_code: id.slice(0, 3).padEnd(6, '0'), exchange, board, asset_class: 'STOCK',
        display_name: st ? `ST合成${k}` : `合成${k}`, name_integrity: 'VERIFIED', listing_date: listing, delisting_date: null, listing_status: 'LISTED', risk_warning_status: st ? 'ST' : 'NORMAL',
        first_available_at: ingestAt(d), ingested_at: ingestAt(d), source_record_id: `sm:${id}:${d}`, revision: 1, schema_version: 'synthetic-v1', quality_state: 'READY', allow_new_risk: st ? 'f' : 't' };
      push(d, 'master', m); allMaster.push(m);
      if (id === FACTS.suspended.code && d >= FACTS.suspended.from && d <= FACTS.suspended.to) {
        push(d, 'susp', { record_id: `su:${id}:${d}`, security_id: id, trade_date: d, suspension_type: 'S', suspension_timing: null, full_session: 't', first_available_at: `${addDays(d, -1)} 20:00:00+08`,
          ingested_at: `${addDays(d, -1)} 20:00:00+08`, source_record_id: `su:${id}:${d}`, revision: 1, schema_version: 'synthetic-v1', quality_state: 'READY' });
        continue;
      }
      const ret = -0.3 * prevRet + 0.02 * (rng() - 0.5) * 2;
      prevRet = ret;
      let prevClose = close;
      if (id === FACTS.split.code && d === FACTS.split.date) { factor = FACTS.split.ratio; prevClose = close / FACTS.split.ratio; } // 除权：昨收按拆股比例调
      const open = prevClose * (1 + 0.004 * (rng() - 0.5));
      close = prevClose * (1 + ret);
      const high = Math.max(open, close) * (1 + 0.01 * rng()); const low = Math.min(open, close) * (1 - 0.01 * rng());
      const vol = Math.round(1e6 * (1 + 3 * rng()));
      const at = ingestAt(d);
      const quality = id === FACTS.conflict.code && d === FACTS.conflict.date ? 'CONFLICT' : 'READY';
      push(d, 'prices', { record_id: `pd:${id}:${d}`, security_id: id, trade_date: d, open: round(open), high: round(high), low: round(low), close: round(close), previous_close: round(prevClose),
        volume_shares: vol, turnover_amount_cny: round(vol * close, 2), adjustment_factor: null, adjustment_mode: 'RAW_WITH_SEPARATE_ADJUSTMENT_FACTOR', value_states: JSON.stringify({ close: 'OBSERVED' }),
        first_available_at: at, known_at: `${d} 15:00:00+08`, ingested_at: at, source_record_id: `ts:${id}:${d}`, revision: 1, schema_version: 'synthetic-v1', quality_state: quality });
      push(d, 'adj', { record_id: `af:${id}:${d}`, raw_record_id: `afr:${id}:${d}`, security_id: id, trade_date: d, adjustment_factor: factor, value_state: 'OBSERVED', first_available_at: at, ingested_at: at,
        source_record_id: `ts:af:${id}:${d}`, revision: 1, schema_version: 'synthetic-v1', quality_state: 'READY' });
      const mv = round(close * shares, 0);
      const values = { close: round(close), turnover_rate: round(1 + 4 * rng()), turnover_rate_f: round(1 + 5 * rng()), volume_ratio: round(0.5 + rng()), pe: round(10 + 40 * rng()), pe_ttm: round(10 + 40 * rng()),
        pb: round(1 + 4 * rng()), ps: round(1 + 9 * rng()), ps_ttm: round(1 + 9 * rng()), dv_ratio: round(3 * rng()), dv_ttm: round(3 * rng()), total_share: shares / 1e4, float_share: shares * 0.8 / 1e4,
        free_share: shares * 0.6 / 1e4, total_mv: mv / 1e4, circ_mv: round(mv * 0.8 / 1e4, 2) };
      const basic = (v, rev, a) => ({ record_id: `db:${id}:${d}:${rev}`, raw_record_id: `dbr:${id}:${d}:${rev}`, security_id: id, trade_date: d, values: JSON.stringify(v), first_available_at: a, ingested_at: a,
        source_record_id: `ts:db:${id}:${d}`, revision: rev, schema_version: 'synthetic-v1', quality_state: 'READY', source_reconciliation_state: 'MATCHED' });
      const f = FACTS;
      if (id === f.lookAhead.code && d === f.lookAhead.date) push(d, 'basic', basic({ ...values, pb: f.lookAhead.pb }, 1, at));
      else if (id === f.liveRevision.code && d === f.liveRevision.date) {
        push(d, 'basic', basic({ ...values, pb: f.liveRevision.rev1.pb }, 1, f.liveRevision.rev1.at));
        push(d, 'basic', basic({ ...values, pb: f.liveRevision.rev2.pb }, 2, f.liveRevision.rev2.at));
      } else if (id === f.liveLate.code && d === f.liveLate.date) push(d, 'basic', basic(values, 1, f.liveLate.at));
      else if (id === f.backfillRevision.code && d === f.backfillRevision.date) {
        push(d, 'basic', basic({ ...values, pb: f.backfillRevision.rev1.pb }, 1, f.backfillRevision.rev1.at));
        push(d, 'basic', basic({ ...values, pb: f.backfillRevision.rev2.pb }, 2, f.backfillRevision.rev2.at));
      } else push(d, 'basic', basic(values, 1, at));
    }
    const ind = (code, from, to, rev, at) => ({ record_id: `im:${id}:${from}:${rev}`, security_id: id, industry_standard: 'SW2021', industry_level: 'L1', industry_code: code, industry_name: `行业${code}`,
      effective_from: from, effective_to: to, first_available_at: at, ingested_at: at, source_record_id: `sw:${id}:${from}`, revision: rev, schema_version: 'synthetic-v1', quality_state: 'READY' });
    if (id === FACTS.reclass.code) {
      tables.tail.ind.push(ind(FACTS.reclass.from, '2015-01-05', null, 1, BACKFILL_AT));
      tables.tail.ind.push(ind(FACTS.reclass.from, '2015-01-05', FACTS.reclass.date, 2, BACKFILL_AT));
      tables.tail.ind.push(ind(FACTS.reclass.to, FACTS.reclass.date, null, 1, BACKFILL_AT));
    } else if (id === FACTS.membershipEnds.code) {
      tables.tail.ind.push(ind(industry, '2015-01-05', null, 1, BACKFILL_AT));
      tables.tail.ind.push(ind(industry, '2015-01-05', FACTS.membershipEnds.date, 2, BACKFILL_AT));
    } else if (id === FACTS.industryRevision.code) {
      const r = FACTS.industryRevision; // 修订 2 晚到 2026-10-12 10:00 才入库，之前的决策只能用修订 1
      tables.tail.ind.push(ind(r.before, r.from, null, 1, BACKFILL_AT));
      tables.tail.ind.push(ind(r.after, r.from, null, 2, r.at));
    } else tables.tail.ind.push(ind(industry, '2015-01-05', null, 1, BACKFILL_AT));
    tables.tail.ind.push({ ...ind('851000', '2016-01-04', null, 1, BACKFILL_AT), industry_level: 'L2', record_id: `im2:${id}`, source_record_id: `sw2:${id}` }); // L2 不用
  });
  // rev 3 §2.1：A、B 目录还带每只在 D0 之前的最后一条主表行
  for (const k of ['tail', 'holdout']) {
    const last = new Map();
    for (const m of allMaster) if (m.business_date < SEGMENTS[k][0] && (!last.has(m.security_id) || m.business_date > last.get(m.security_id).business_date)) last.set(m.security_id, m);
    tables[k].master.push(...last.values());
  }
  for (const k of Object.keys(SEGMENTS)) {
    for (const d of openDays.filter((x) => inSeg(x, SEGMENTS[k]))) {
      tables[k].cover.push({ coverage_id: `cv:${d}`, trade_date: d, provider_row_count: 1, accepted_row_count: 1, full_session_count: 0, first_available_at: ingestAt(d), ingested_at: ingestAt(d),
        job_run_id: 'synthetic', source_registry_version: 'synthetic-v1', quality_state: 'READY' });
    }
  }
  const files = { prices: ['prices_daily_stock.csv', PRICE_COLS], basic: ['market_daily_basic_observation_stock.csv', BASIC_COLS], adj: ['adjustment_factor_observation_stock.csv', ADJ_COLS],
    master: ['security_master_stock.csv', MASTER_COLS], susp: ['security_suspension_observation.csv', SUSP_COLS], cover: ['security_suspension_day_coverage.csv', COVER_COLS],
    cal: ['trading_calendar.csv', CAL_COLS], ind: ['industry_membership_sw2021.csv', IND_COLS] };
  const names = { lane: 'rf1116-cn-a-lane-copy-20200601-20260928', tail: 'rf1116-cn-a-daily-20260929-20261016', holdout: 'rf1116-cn-a-daily-holdout-from-20261019' };
  const dirs = {};
  for (const k of Object.keys(SEGMENTS)) {
    const dir = path.join(root, names[k]); fs.mkdirSync(dir, { recursive: true }); dirs[k] = dir;
    const sums = []; const manifest = { schema: 'RF1116_EXPORT_MANIFEST_SYNTHETIC', exported_at: '2026-11-17T12:00:00+08:00', database: 'synthetic-fixture', files: {} };
    const sortKey = (r) => `${r.security_id || ''}|${r.trade_date || r.business_date || r.calendar_date || r.effective_from || ''}|${r.source_record_id || ''}|${String(r.revision || 0).padStart(3, '0')}`;
    for (const [t, [file, cols]] of Object.entries(files)) {
      if (t === 'ind' && k !== 'tail') continue;
      const rows = [...tables[k][t]].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
      const bytes = csv(cols, rows);
      fs.writeFileSync(path.join(dir, file), bytes);
      sums.push(`${crypto.createHash('sha256').update(bytes).digest('hex')}  ${file}`);
      const dates = rows.map((r) => r.trade_date || r.business_date || r.calendar_date).filter(Boolean).sort();
      manifest.files[file] = { rows: rows.length, min_trade_date: dates[0] || null, max_trade_date: dates[dates.length - 1] || null };
    }
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sums.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1)).join('\n')}\n`);
    fs.writeFileSync(path.join(dir, 'EXPORT_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { root, dirs, facts: FACTS, calendar: openDays, segments: SEGMENTS };
}

module.exports = { makeMiningDataFixture, FACTS, STOCKS, SEGMENTS, internals: { calendar, nextOpen, csv } };
