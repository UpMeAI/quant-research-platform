'use strict';
/**
 * 三市场信号登记只读合并层。V1（美股/加密）的绩效字段原样保留；A 股 Q0 只有账户日
 * 开仓信号事实，没有记分牌窗口时明确 NOT_APPLICABLE，不创造可比绩效。
 */
const crypto = require('node:crypto');
const legacy = require('./index');
const ashare = require('../../adapters/ashare-local/q0_account_export');
const { validateRecord } = require('../../schemas');

const canonicalJson = legacy.canonicalJson;
const contentHash = legacy.contentHash;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function verify(registry) {
  if (!registry || !/^[0-9a-f]{64}$/.test(registry.hash || '')) throw new Error('UNIFIED_REGISTRY_HASH_MISSING');
  const actual = registry.schema === 'SIGNAL_REGISTRY_V1' ? legacy.contentHash(registry)
    : registry.schema === 'ASHARE_Q0_SIGNAL_REGISTRY_V1' ? ashare.contentHash(registry) : null;
  if (!actual) throw new Error(`UNIFIED_REGISTRY_SCHEMA_UNSUPPORTED:${registry.schema}`);
  if (actual !== registry.hash) throw new Error(`UNIFIED_REGISTRY_HASH_MISMATCH:${registry.schema}`);
  const shape = validateRecord(registry, registry.schema);
  if (!shape.ok) throw new Error(`UNIFIED_REGISTRY_SCHEMA_INVALID:${shape.problems.join(',')}`);
  const rowSchema = registry.schema === 'SIGNAL_REGISTRY_V1' ? 'SIGNAL_REGISTRY_ROW_V1' : 'ASHARE_Q0_SIGNAL_REGISTRY_ROW_V1';
  for (const row of registry.rows) {
    const rv = validateRecord(row, rowSchema);
    if (!rv.ok) throw new Error(`UNIFIED_REGISTRY_ROW_INVALID:${rv.problems.join(',')}`);
  }
}

function normalizeV1(registry) {
  const markets = [...new Set((registry.rows || []).map((r) => r.market))];
  if (markets.length !== 1 || !['US', 'CRYPTO'].includes(markets[0])) throw new Error('UNIFIED_V1_MARKET_AMBIGUOUS');
  const market = markets[0];
  return {
    source: { market, schema: registry.schema, hash: registry.hash, rowsState: registry.rows.length ? 'MEASURED' : 'NOT_APPLICABLE:NO_SIGNAL_ROWS_IN_SOURCE' },
    rows: registry.rows.map((row) => ({
      schema: 'SIGNAL_REGISTRY_ROW_V2', rowId: `${market}|${row.rowId}`, ledgerId: row.ledgerId, market, partId: row.partId,
      signalKey: row.signalKey, signalCodes: row.signalCodes, ruleRefs: row.ruleRefs, entries: row.entries,
      firstEntryAt: row.firstEntryAt, lastEntryAt: row.lastEntryAt,
      performanceState: 'MEASURED:SOURCE_SCOREBOARD_WINDOWS', windows: row.windows, stateSplit: row.stateSplit,
      sourceRegistryHash: registry.hash,
    })),
  };
}

function normalizeAshare(registry) {
  if (registry.market !== 'CN_A') throw new Error('UNIFIED_ASHARE_MARKET_INVALID');
  return {
    source: { market: 'CN_A', schema: registry.schema, hash: registry.hash, rowsState: registry.rowsState },
    rows: registry.rows.map((row) => ({
      schema: 'SIGNAL_REGISTRY_ROW_V2', rowId: `CN_A|${row.rowId}`, ledgerId: row.accountId, market: 'CN_A', partId: null,
      signalKey: row.signalKey, signalCodes: row.signalCodes, ruleRefs: row.ruleRefs, entries: row.entries,
      firstEntryAt: row.firstEntryAt, lastEntryAt: row.lastEntryAt,
      performanceState: 'NOT_APPLICABLE:ACCOUNT_DAY_SOURCE_HAS_NO_SCOREBOARD_WINDOWS', windows: null, stateSplit: null,
      sourceRegistryHash: registry.hash,
    })),
  };
}

function mergeRegistries(registries, { generatedAt = null } = {}) {
  if (!Array.isArray(registries) || registries.length !== 3) throw new Error('UNIFIED_REGISTRY_REQUIRES_THREE_SOURCES');
  for (const registry of registries) verify(registry);
  const normalized = registries.map((registry) => registry.schema === 'SIGNAL_REGISTRY_V1' ? normalizeV1(registry) : normalizeAshare(registry));
  const sources = normalized.map((x) => x.source).sort((a, b) => byText(a.market, b.market));
  const markets = sources.map((x) => x.market);
  if (new Set(markets).size !== 3 || canonicalJson(markets) !== canonicalJson(['CN_A', 'CRYPTO', 'US'])) {
    throw new Error(`UNIFIED_REGISTRY_MARKETS_INVALID:${markets.join(',')}`);
  }
  const rows = normalized.flatMap((x) => x.rows).sort((a, b) => byText(a.rowId, b.rowId));
  const body = {
    schema: 'SIGNAL_REGISTRY_V2', registryVersion: 2, generatedAt, markets, sources, rows,
    interpretation: 'REGISTRY_FACTS_NOT_A_VERDICT;PERFORMANCE_ONLY_WHERE_SOURCE_SCOREBOARD_EXISTS', productionEffect: 'NONE',
  };
  return { ...body, hash: crypto.createHash('sha256').update(canonicalJson(body)).digest('hex') };
}

module.exports = { mergeRegistries };
