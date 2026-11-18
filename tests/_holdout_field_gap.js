'use strict';
/**
 * 测试用（复审 #127 P3-4）：拿一个留出段目录做一份「字段缺了」的副本——封存件照旧（SHA256SUMS.sealed = 原来的 SHA256SUMS），
 * 补导一个带日期后缀的 daily_basic 部分：某一天每只一行新修订（修订号 +1、入库晚 1 秒，仍在截止之前），total_mv 是 MISSING。
 * 面板读的是这个新修订，所以那一天没有市值；留出段核对必须在开启之前拒。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { forEachCsvRow } = require('../services/mining-sandbox/data-adapter/csv');
const { internals } = require('../services/mining-sandbox/data-adapter');

const BASIC = 'market_daily_basic_observation_stock.csv';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

function holdoutWithFieldGap(src, day) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-field-gap-'));
  for (const n of fs.readdirSync(src)) if (n.endsWith('.csv') || n === 'SHA256SUMS' || n === 'EXPORT_MANIFEST.json') fs.copyFileSync(path.join(src, n), path.join(dir, n));
  const sealed = path.join(src, 'SHA256SUMS.sealed');
  fs.copyFileSync(fs.existsSync(sealed) ? sealed : path.join(src, 'SHA256SUMS'), path.join(dir, 'SHA256SUMS.sealed'));
  const rows = []; forEachCsvRow(path.join(dir, BASIC), (r) => { if (r.trade_date === day) rows.push(r); });
  if (!rows.length) throw new Error(`no ${BASIC} rows on ${day}`);
  const cols = Object.keys(rows[0]);
  const late = rows.map((r) => {
    const at = iso(internals.parseTs(r.first_available_at) + 1000);
    return { ...r, record_id: `${r.record_id}:gap`, revision: String(Number(r.revision || 0) + 1), first_available_at: at, ingested_at: at,
      values: JSON.stringify({ ...JSON.parse(r.values), total_mv: { state: 'MISSING', value: null } }) };
  });
  const part = `${BASIC.slice(0, -4)}_20270105.csv`;
  fs.writeFileSync(path.join(dir, part), `${[cols.join(','), ...late.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')}\n`);
  fs.appendFileSync(path.join(dir, 'SHA256SUMS'), `${sha(fs.readFileSync(path.join(dir, part)))}  ${part}\n`);
  return dir;
}
module.exports = { holdoutWithFieldGap };
