'use strict';
/**
 * Ashare-V6 Q0 账户日导出 → QRP 只读结果投影。
 *
 * 这不是回测引擎，也不重算交易决定。账户、成交、权益与规则证据均逐字段取自
 * ASHARE_V6_Q0_ACCOUNT_DAY_V1；缺少的 nav 等字段保留 null。只接受未封存账户，避免
 * 研究平台无意读取 R-STK-1 或封存比较臂。
 */
const fs = require('node:fs');
const crypto = require('node:crypto');

const SOURCE_SCHEMA = 'ASHARE_V6_Q0_ACCOUNT_DAY_V1';
const RESULT_SCHEMA = 'ASHARE_Q0_ACCOUNT_RESULT_V1';
const REGISTRY_SCHEMA = 'ASHARE_Q0_SIGNAL_REGISTRY_V1';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function canonicalJson(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('CANONICAL_NON_FINITE_NUMBER');
  return JSON.stringify(v);
}

const contentHash = (v) => {
  const { hash: _omitted, ...body } = v;
  return crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
};
const withHash = (v) => ({ ...v, hash: contentHash(v) });
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function assertRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('ACCOUNT_DAY_SOURCE_EMPTY');
  let identity = null; let prior = null;
  for (const [index, row] of rows.entries()) {
    if (!row || row.schemaVersion !== SOURCE_SCHEMA) throw new Error(`ACCOUNT_DAY_SCHEMA_INVALID:${index}`);
    if (row.sealed === true) throw new Error(`SEALED_ACCOUNT_REFUSED:${row.accountId || index}`);
    if (!row.point || typeof row.point !== 'object') throw new Error(`ACCOUNT_DAY_POINT_MISSING:${index}`);
    if (typeof row.businessDate !== 'string') throw new Error(`ACCOUNT_DAY_DATE_MISSING:${index}`);
    const current = `${row.accountId}|${row.role}|${row.phase && row.phase.id || '-'}`;
    if (identity === null) identity = current;
    else if (identity !== current) throw new Error(`ACCOUNT_DAY_IDENTITY_CHANGED:${index}`);
    if (prior !== null && byText(prior, row.businessDate) >= 0) throw new Error(`ACCOUNT_DAY_ORDER_INVALID:${prior}:${row.businessDate}`);
    prior = row.businessDate;
  }
}

const evidenceOf = (row) => ({
  businessDate: row.businessDate,
  recordId: row.recordId || null,
  status: row.status,
  reasonCodes: Array.isArray(row.reasonCodes) ? row.reasonCodes : [],
  klineDecisions: Array.isArray(row.klineDecisions) ? row.klineDecisions : [],
  marketGate: row.marketGate === undefined ? null : row.marketGate,
  q0Events: Array.isArray(row.q0Events) ? row.q0Events : [],
  armPoints: Array.isArray(row.armPoints) ? row.armPoints : [],
  ranking: row.ranking === undefined ? null : row.ranking,
  shortlistState: row.shortlistState === undefined ? null : row.shortlistState,
});

function codesOf(event) {
  const decision = event && event.decision;
  const codes = decision && Array.isArray(decision.reasonCodes) ? decision.reasonCodes
    : Array.isArray(event && event.reasonCodes) ? event.reasonCodes : [];
  return codes.map(String);
}

function signalRegistry(executions, identity, source, generatedAt) {
  const grouped = new Map();
  for (const execution of executions) {
    if (!/^FILLED_(BUY|OPEN)/.test(String(execution.sourceEvent.event))) continue;
    const codes = codesOf(execution.sourceEvent);
    const signalKey = codes.length ? codes.join('+') : 'UNKNOWN:ENTRY_SIGNAL_NOT_RECORDED';
    const ruleRef = execution.sourceEvent.decision && execution.sourceEvent.decision.ruleRef || execution.sourceEvent.ruleRef || null;
    const row = grouped.get(signalKey) || { signalKey, signalCodes: codes, ruleRefs: new Set(), dates: [], executionRefs: [] };
    if (ruleRef) row.ruleRefs.add(String(ruleRef));
    row.dates.push(execution.businessDate);
    row.executionRefs.push(`${execution.businessDate}#${execution.eventIndex}`);
    grouped.set(signalKey, row);
  }
  const rows = [...grouped.values()].sort((a, b) => byText(a.signalKey, b.signalKey)).map((row) => ({
    schema: 'ASHARE_Q0_SIGNAL_REGISTRY_ROW_V1',
    rowId: `${identity.accountId}|${row.signalKey}`,
    accountId: identity.accountId,
    market: 'CN_A',
    signalKey: row.signalKey,
    signalCodes: row.signalCodes,
    ruleRefs: [...row.ruleRefs].sort(byText),
    entries: row.dates.length,
    firstEntryAt: row.dates[0] || null,
    lastEntryAt: row.dates[row.dates.length - 1] || null,
    executionRefs: row.executionRefs,
  }));
  return withHash({
    schema: REGISTRY_SCHEMA,
    registryVersion: 1,
    generatedAt,
    market: 'CN_A',
    accountId: identity.accountId,
    source,
    rowsState: rows.length ? 'MEASURED' : 'NOT_APPLICABLE:NO_ENTRY_FILLS_IN_SOURCE',
    rows,
    interpretation: 'REGISTRY_FACTS_NOT_A_VERDICT',
    productionEffect: 'NONE',
  });
}

function adaptAccountDays(rows, { source = null, generatedAt = null } = {}) {
  assertRows(rows);
  if (!source || typeof source.file !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256 || '')) throw new Error('ACCOUNT_DAY_SOURCE_IDENTITY_REQUIRED');
  const first = rows[0]; const last = rows[rows.length - 1];
  const identity = { accountId: first.accountId, role: first.role, sealed: false, phase: first.phase || null };
  const executions = [];
  const equityCurve = [];
  for (const row of rows) {
    const point = row.point;
    const events = Array.isArray(point.executions) ? point.executions : Array.isArray(point.events) ? point.events : [];
    events.forEach((event, eventIndex) => {
      if (String(event && event.event || '').startsWith('FILLED_')) executions.push({
        businessDate: row.businessDate, accountId: row.accountId, recordId: row.recordId || null, eventIndex, sourceEvent: event,
      });
    });
    equityCurve.push({
      businessDate: row.businessDate,
      equity: finite(point.equity) ? point.equity : finite(point.navCny) ? point.navCny : null,
      cash: finite(point.cash) ? point.cash : finite(point.cashCny) ? point.cashCny : null,
      positionsValue: finite(point.positionsValue) ? point.positionsValue : finite(point.grossExposureCny) ? point.grossExposureCny : null,
      nav: finite(point.nav) ? point.nav : null,
      peak: finite(point.peak) ? point.peak : finite(point.peakNavCny) ? point.peakNavCny : null,
    });
  }
  const ending = equityCurve[equityCurve.length - 1];
  if (!finite(ending.equity)) throw new Error('ACCOUNT_DAY_ENDING_EQUITY_MISSING');
  const registry = signalRegistry(executions, identity, source, generatedAt);
  const result = withHash({
    schema: RESULT_SCHEMA,
    resultVersion: 1,
    market: 'CN_A',
    generatedAt,
    source: { ...source, schemaVersion: SOURCE_SCHEMA, records: rows.length, from: first.businessDate, to: last.businessDate },
    account: identity,
    executions,
    equityCurve,
    ruleEvidence: rows.map(evidenceOf),
    signalRegistryHash: registry.hash,
    summary: { accountDays: rows.length, fillCount: executions.length, endingEquity: ending.equity, endingBusinessDate: ending.businessDate },
    productionEffect: 'NONE',
  });
  return { result, registry };
}

module.exports = { SOURCE_SCHEMA, RESULT_SCHEMA, REGISTRY_SCHEMA, canonicalJson, contentHash, sha256File, adaptAccountDays };
