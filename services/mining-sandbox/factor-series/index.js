'use strict';

/**
 * 现有因子序列 FACTOR_SERIES_V1（协调会话裁定 R1.4，ce254328…：A 股 14 个 LIVE_IN_RULE 因子的历史值，先登记为数据集再导出；
 * 导出的 SQL 与 KG 登记条目见协调目录 RF1116_CN_A_LIVE_FACTOR_SERIES_EXPORT_V1）。G-MINE 第 7、8 项读它。只读：不写文件、不连网络。
 *
 * 目录：factor_series.csv（factor_id, grain, business_date, key, value, first_available_at）、unit_membership.csv（business_date, security_id, unit_key），SHA256SUMS。
 *   grain：STOCK（key = security_id）、UNIT（key = 申万单元，如 SW2021:801010；按同一天的 unit_membership 映射到个股）、ETF（key = ETF 代码；对不上个股）。
 *   时钟：business_date D 的值是 V6 当晚（决策截止 18:30）算出来的，只喂 D 之后第一个交易日开盘的决策，且 first_available_at 要早于那天 09:00（北京时间），
 *   迟到的那一天就没有这个值（不往前补）。同一 (因子, 日期, 键) 有几行时取 first_available_at 最晚的、仍赶得上的那一行。
 * stockPanel(fs, factorId, panel) → [{ date: 决策日, values: { 证券: 数 } }]（因子库相关函数的面板格式）；没有这个因子 → null；ETF 级 → MINE_FACTOR_SERIES_GRAIN_NOT_STOCK_MAPPABLE。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { forEachCsvRow } = require('../data-adapter/csv');
const { internals: { parseTs } } = require('../data-adapter');

const GRAINS = Object.freeze(['STOCK', 'UNIT', 'ETF']);
const CUTOFF = 'T09:00:00+08:00';

class FactorSeriesError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new FactorSeriesError(`MINE_FACTOR_SERIES_${code}`, detail); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function readListed(dir, name, sums, onRow) {
  const want = sums.get(name);
  if (!want) fail('FILE_NOT_IN_SHA256SUMS', name);
  const r = forEachCsvRow(path.join(dir, name), onRow);
  if (r.sha256 !== want) fail('SHA256SUMS_MISMATCH', name);
}

/** 读一个 FACTOR_SERIES_V1 目录（每个文件核 SHA256SUMS；清单外的 CSV 拒绝）。 */
function loadFactorSeries(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'SHA256SUMS'))) fail('DIR_INVALID', dir);
  const sumsBytes = fs.readFileSync(path.join(dir, 'SHA256SUMS'));
  const sums = new Map(sumsBytes.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l); if (!m) fail('SHA256SUMS_LINE', l); return [m[2], m[1]];
  }));
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.csv'))) if (!sums.has(n)) fail('FILE_NOT_IN_SHA256SUMS', n);
  const byFactor = new Map(); const grain = new Map();
  readListed(dir, 'factor_series.csv', sums, (r) => {
    if (!GRAINS.includes(r.grain)) fail('GRAIN_INVALID', `${r.factor_id}:${r.grain}`);
    if (grain.has(r.factor_id) && grain.get(r.factor_id) !== r.grain) fail('GRAIN_MIXED', r.factor_id);
    grain.set(r.factor_id, r.grain);
    const v = r.value === null || r.value === '' ? NaN : Number(r.value);
    if (!byFactor.has(r.factor_id)) byFactor.set(r.factor_id, new Map());
    const days = byFactor.get(r.factor_id);
    if (!days.has(r.business_date)) days.set(r.business_date, new Map());
    const keys = days.get(r.business_date);
    if (!keys.has(r.key)) keys.set(r.key, []);
    keys.get(r.key).push({ value: v, at: parseTs(r.first_available_at) });
  });
  const membership = new Map();
  if (sums.has('unit_membership.csv')) {
    readListed(dir, 'unit_membership.csv', sums, (r) => {
      if (!membership.has(r.business_date)) membership.set(r.business_date, new Map());
      membership.get(r.business_date).set(r.security_id, r.unit_key);
    });
  }
  return Object.freeze({ schema: 'FACTOR_SERIES_V1', dir, sums_sha256: sha256(sumsBytes), factor_ids: [...byFactor.keys()], grain, byFactor, membership });
}

/**
 * 一个因子按面板的决策日排好、映射到个股（单元级按当天成员）。没有这个因子 → null；ETF 级 → 拒绝（对不上个股）。
 * @param {object} panel 数据适配器的面板（dates = 决策日）
 */
function stockPanel(src, factorId, panel) {
  if (!src.byFactor.has(factorId)) return null;
  const g = src.grain.get(factorId);
  if (g === 'ETF') fail('GRAIN_NOT_STOCK_MAPPABLE', `${factorId}:${g}`);
  const days = src.byFactor.get(factorId);
  const out = panel.dates.map((d) => ({ date: d, values: {} }));
  const businessDates = [...days.keys()].sort();
  for (const bd of businessDates) {
    const k = panel.dates.findIndex((d) => d > bd);
    if (k <= 0) continue; // 面板之后、或面板第一天之前的值（对不上「前一交易日」）不用
    const decision = panel.dates[k];
    const cutoff = Date.parse(`${decision}${CUTOFF}`);
    const pick = (list) => { const ok = list.filter((x) => x.at <= cutoff); return ok.length ? ok.reduce((a, b) => (b.at >= a.at ? b : a)).value : NaN; };
    const vals = out[k].values;
    if (g === 'STOCK') {
      for (const [sec, list] of days.get(bd)) { const v = pick(list); if (Number.isFinite(v)) vals[sec] = v; }
    } else {
      const members = src.membership.get(bd);
      if (!members) continue;
      const unitVal = new Map([...days.get(bd)].map(([u, list]) => [u, pick(list)]));
      for (const [sec, unit] of members) { const v = unitVal.get(unit); if (Number.isFinite(v)) vals[sec] = v; }
    }
  }
  return out;
}

module.exports = { GRAINS, FactorSeriesError, loadFactorSeries, stockPanel };
