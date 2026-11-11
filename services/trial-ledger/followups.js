'use strict';

/**
 * 冻结修订的后续输入转换器。
 *
 * 本模块只把已钉 sha256 的协调输入转换成既有 trial-ledger 规格；策略族归属仍由调用方显式给出，
 * 不从中文说明或文件名推断。输出继续交给 index.js 的完成权威与 schema 校验，不在这里写台账。
 */
const crypto = require('crypto');
const fs = require('fs');
const { internals: { need }, SHA64 } = require('./index');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const MARKET = Object.freeze({ 加密: { market: 'CRYPTO_USDM_PERP', timeZone: 'UTC' }, 美股: { market: 'US_EQUITY', timeZone: 'America/New_York' }, A股: { market: 'CN_A', timeZone: 'Asia/Shanghai' } });
const MARKET_BY_CODE = Object.freeze({
  ...Object.fromEntries(Object.values(MARKET).map((value) => [value.market, value])),
  CRYPTO: { market: 'CRYPTO', timeZone: 'UTC' },
});

function loadPinnedJson(file, expectedSha256, schema) {
  need(typeof file === 'string' && file.startsWith('/'), 'FOLLOWUP_SOURCE_PATH_MUST_BE_ABSOLUTE');
  need(SHA64.test(expectedSha256 || ''), 'FOLLOWUP_SOURCE_SHA256_REQUIRED');
  const bytes = fs.readFileSync(file);
  const actual = sha256(bytes);
  need(actual === expectedSha256, 'FOLLOWUP_SOURCE_SHA256_MISMATCH', `${actual.slice(0, 12)}…≠${expectedSha256.slice(0, 12)}…`);
  const doc = JSON.parse(bytes.toString('utf8'));
  need(doc && doc.schema === schema && Array.isArray(doc.rows), 'FOLLOWUP_SOURCE_SHAPE', schema);
  return { doc, sha256: actual };
}

function localDate(value, precision, marketName) {
  if (precision === 'DATE') {
    need(DATE.test(value || ''), 'FOLLOWUP_TSTART_DATE_INVALID', String(value));
    return value;
  }
  need(precision === 'INSTANT' && !Number.isNaN(Date.parse(value)), 'FOLLOWUP_TSTART_INSTANT_INVALID', String(value));
  const zone = MARKET[marketName] || MARKET_BY_CODE[marketName];
  need(zone, 'FOLLOWUP_MARKET_UNKNOWN', String(marketName));
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function forwardReservedFromRegistry({ file, sha256: expectedSha256, familyMap, openEndedTo }) {
  need(DATE.test(openEndedTo || ''), 'FOLLOWUP_OPEN_END_REQUIRED');
  need(familyMap && typeof familyMap === 'object' && !Array.isArray(familyMap), 'FOLLOWUP_FAMILY_MAP_REQUIRED');
  const source = loadPinnedJson(file, expectedSha256, 'FORWARD_SHADOW_TSTART_REGISTRY_V1');
  const marks = [];
  for (const row of source.doc.rows) {
    need(row.status === 'STARTED' || row.status === 'NOT_STARTED', 'FOLLOWUP_TSTART_STATUS_INVALID', String(row.status));
    if (row.status === 'NOT_STARTED') continue;
    const families = familyMap[row.masterTableRow];
    need(Array.isArray(families) && families.length, 'FOLLOWUP_STARTED_FAMILY_UNMAPPED', String(row.masterTableRow));
    const to = row.to == null ? openEndedTo : row.to;
    for (const family of families) {
      const familyId = typeof family === 'string' ? family : family && family.family_id;
      const market = typeof family === 'string' ? MARKET[row.market] : MARKET_BY_CODE[family && family.market];
      need(typeof familyId === 'string' && familyId && market, 'FOLLOWUP_STARTED_FAMILY_UNMAPPED', String(row.masterTableRow));
      const from = localDate(row.T_start, row.T_start_precision, typeof family === 'string' ? row.market : family.market);
      need(DATE.test(to) && from <= to, 'FOLLOWUP_FORWARD_RANGE_INVALID', `${from}..${to}`);
      marks.push({
        family_id: familyId,
        market: market.market,
        from,
        to,
        label: 'FORWARD_RESERVED',
        shadow_ref: row.shadow_ref,
        reason: `冻结 T_start 清单 ${row.masterTableRow}：${row.T_start_basis}`,
        source_refs: [{ kind: 'FORWARD_SHADOW_TSTART_REGISTRY', registry_sha256: source.sha256, master_table_row: row.masterTableRow, t_start: row.T_start, precision: row.T_start_precision, sources: row.sources || [] }],
      });
    }
  }
  return marks;
}

function uncountedHistorySpecs(rows) {
  need(Array.isArray(rows) && rows.length, 'FOLLOWUP_UNCOUNTED_ROWS_REQUIRED');
  const seen = new Set();
  return rows.map((row) => {
    const key = `${row.family_id}|${row.study_ref}`;
    need(typeof row.family_id === 'string' && row.family_id && typeof row.market === 'string' && row.market && typeof row.study_ref === 'string' && row.study_ref
      && Number.isInteger(row.lower_bound) && row.lower_bound > 0 && Array.isArray(row.source_refs) && row.source_refs.length && !seen.has(key),
    'FOLLOWUP_UNCOUNTED_INVALID', key);
    seen.add(key);
    return {
      family_id: row.family_id,
      market: row.market,
      study_ref: row.study_ref,
      k2_sha256: null,
      freeze_sha256: null,
      stage: 'BOOK',
      role: 'UNCOUNTED_HISTORY',
      config_label: `${row.study_ref}#KNOWN_LOWER_BOUND`,
      rule_config: { uncounted_history: { family_id: row.family_id, study_ref: row.study_ref } },
      uncounted_lower_bound: row.lower_bound,
      source_refs: row.source_refs,
      notes_zh: row.notes_zh || '只登记封存文本能直接计数的已知下限；不反推未记录试验。',
    };
  });
}

module.exports = { forwardReservedFromRegistry, uncountedHistorySpecs, internals: { loadPinnedJson, localDate } };
