'use strict';
/**
 * A 股本地 PIT 日线仓库 —— ashare-local 适配器的数据入口(文件版)。
 *
 * 迁移语义(源:Ashare-V5 services/phase2/vpq_lab_engine.loadUniverseBars,PG 版):
 *   - 宇宙决定论:instrument_id 排序后 skip/stride/cap 显式声明,禁静默截断;
 *   - PIT:bar 按 trade_date 升序,消费方只允许使用 ≤ 评测日的 bar(回测引擎强制);
 *   - 每条 bar 带 source 标注(SAMPLE_SYNTHETIC / TUSHARE / ...),数据真实性不冒充;
 *   - 台账 append-only:同 (instrument_id, d) 以最后一行为准(修正=追加)。
 *
 * bar 形状:{ instrument_id, d: 'YYYY-MM-DD', close, high, vol, source }
 */
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { dataDir, append, read } = require('../../packages/ledger');
const market = require('./market_facts');

function barsFile() {
  return path.join(dataDir('marketdata', market.market_id), 'bars.jsonl');
}

/** 写入日线(证券代码经市场事实校验;非法代码 fail-closed 拒绝)。 */
function ingestBars(bars, { source } = {}) {
  if (!source) throw new Error('INGEST_MISSING_SOURCE');
  let n = 0;
  for (const b of bars) {
    if (!market.isValidInstrument(b.instrument_id)) throw new Error(`INGEST_INVALID_INSTRUMENT:${market.market_id}:${b.instrument_id}`);
    for (const k of ['d', 'close', 'vol']) {
      if (b[k] === undefined || b[k] === null) throw new Error(`INGEST_BAR_MISSING:${k}`);
    }
    append(barsFile(), {
      instrument_id: b.instrument_id, d: b.d,
      close: Number(b.close), high: b.high != null ? Number(b.high) : Number(b.close),
      vol: Number(b.vol), source,
    });
    n++;
  }
  return { ok: true, ingested: n };
}

function _allBars() {
  const m = new Map();
  for (const b of read(barsFile())) m.set(`${b.instrument_id}|${b.d}`, b);
  return [...m.values()];
}

/**
 * 加载股票宇宙日线(决定论 + 显式声明)。
 * @returns { byInst: Map<inst, bars[]>, universe: string[], universeDeclared }
 */
function loadUniverseBars({ skip = 0, stride = 1, cap = 150, minBars = 90 } = {}) {
  const byInstAll = new Map();
  for (const b of _allBars()) {
    if (!byInstAll.has(b.instrument_id)) byInstAll.set(b.instrument_id, []);
    byInstAll.get(b.instrument_id).push(b);
  }
  const stocks = [...byInstAll.keys()]
    .filter((id) => market.classifyInstrument(id) === 'STOCK')
    .filter((id) => byInstAll.get(id).length >= minBars)
    .sort()
    .slice(skip).filter((_, i) => i % stride === 0).slice(0, cap);
  const byInst = new Map();
  for (const id of stocks) {
    byInst.set(id, byInstAll.get(id).slice().sort((a, b) => (a.d < b.d ? -1 : 1)));
  }
  return { byInst, universe: stocks, universeDeclared: { marketId: market.market_id, skip, stride, cap, minBars, actual: stocks.length } };
}

/** 单标的(基准等)日线,按日期升序。 */
function loadInstrumentBars(instrumentId) {
  return _allBars()
    .filter((b) => b.instrument_id === instrumentId)
    .sort((a, b) => (a.d < b.d ? -1 : 1));
}

/** 数据文件校验和(DatasetSnapshot.checksums / lineage_hash 用)。 */
function barsChecksum() {
  try { return crypto.createHash('sha256').update(fs.readFileSync(barsFile())).digest('hex').slice(0, 16); }
  catch { return null; }
}

/** 数据源与覆盖概况(DatasetSnapshot.coverage / freshness 用)。 */
function coverage() {
  const bars = _allBars();
  const dates = [...new Set(bars.map((b) => b.d))].sort();
  const sources = [...new Set(bars.map((b) => b.source))];
  return {
    barCount: bars.length,
    instrumentCount: new Set(bars.map((b) => b.instrument_id)).size,
    dateFrom: dates[0] || null, dateTo: dates[dates.length - 1] || null,
    sources,
  };
}

module.exports = { ingestBars, loadUniverseBars, loadInstrumentBars, barsFile, barsChecksum, coverage };
