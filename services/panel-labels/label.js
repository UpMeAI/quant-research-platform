'use strict';

/**
 * Label computation and validation (contract section 7.1 LB-1, LB-6, LB-7; section 7.2).
 * A label is a result fact computed from prices by this deterministic program: no model, no probability, no capital, no order. The clock (`now`) and the price series
 * are injected; nothing here reads a wall clock, the network or a database. An immature label is UNKNOWN / LABEL_NOT_MATURED and carries no return key, never 0.
 *
 * Price provider interface (injected, point in time aware):
 *   providerId, providerVersion : string
 *   priceMethod(market)         : string        CN must be RAW_OPEN_AND_CLOSE_TIMES_HISTORICAL_ADJ_FACTOR_V1 (B13)
 *   entryAt({market, sessionDate, evaluatedAt})                         : ISO instant   calendar only, no price read
 *   exitAt({market, entryAt, windowUnit, windowLength})                 : ISO instant   calendar only, the end of the window
 *   availabilityLagMs({market})                                         : integer       data availability after the window end
 *   price({market, instrumentKey, at, field: OPEN|CLOSE, asOf})         : {state: VALUE, value, availableAt, sourceRef} | {state: UNAVAILABLE, reasonCode}
 *      a price whose availableAt is after asOf must come back UNAVAILABLE; the program refuses a provider that returns one anyway.
 */
const v = require('./vocab');

const { fail, need, sha256, canonicalJson } = v;
/** LB-1: no model / probability / capital / order field in the table. */
const FORBIDDEN_KEY = /(model|prob|capital|order|broker|position)/i;
const SOURCE_REFS = 'sourceRef';

function assertProvider(p) {
  need(v.isObj(p) && v.isText(p.providerId) && v.isText(p.providerVersion), 'LABEL_PROVIDER_INVALID', 'id');
  for (const f of ['priceMethod', 'entryAt', 'exitAt', 'availabilityLagMs', 'price']) need(typeof p[f] === 'function', 'LABEL_PROVIDER_INVALID', f);
}

/** Hash of the label content without `labelHash` and `computedAt`: the same inputs give the same hash whenever they are recomputed. */
function labelHashOf(label) {
  const { labelHash: _h, computedAt: _c, ...rest } = label;
  return sha256(canonicalJson(rest));
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const isFourState = (x) => v.isObj(x) && v.FOUR_STATES.includes(x.state) && v.isText(x.reasonCode);

/**
 * Store side validation. Refuses, in this order: missing window or maturity (LB-7), a window outside the allowed table, a malformed label,
 * a return key on a label that has no value, a forbidden field, a stale hash.
 */
function validateLabel(label) {
  need(v.isObj(label), 'LABEL_INVALID', 'not an object');
  need(label.schema === 'PANEL_LABEL_V1', 'LABEL_INVALID', 'schema');
  if (!v.isText(label.windowId) || !v.isText(label.windowUnit) || !Number.isInteger(label.windowLength) || !v.isIso(label.maturesAt) || (label.state === 'VALUE' && !v.isIso(label.maturedAt))) {
    fail('LABEL_WINDOW_OR_MATURITY_MISSING', String(label.candidateId));
  }
  need(v.isAllowedWindow(label.windowUnit, label.windowLength) && v.windowIdOf(label.windowUnit, label.windowLength) === label.windowId, 'LABEL_WINDOW_NOT_ALLOWED', label.windowId);
  need(v.isText(label.candidateId) && v.SHA64.test(label.panelRecordHash || ''), 'LABEL_INVALID', 'candidateId or panelRecordHash');
  need(v.STATES.includes(label.state), 'LABEL_INVALID', `state:${label.state}`);
  if (label.state === 'VALUE') {
    need(label.reasonCode === null, 'LABEL_INVALID', 'reasonCode on a value');
    need(typeof label.grossReturn === 'number' && Number.isFinite(label.grossReturn), 'LABEL_INVALID', 'grossReturn');
    for (const k of ['benchmarkReturn', 'excessReturn']) need((typeof label[k] === 'number' && Number.isFinite(label[k])) || isFourState(label[k]), 'LABEL_INVALID', k);
    need(v.isIso(label.entryAt) && v.isIso(label.exitAt), 'LABEL_INVALID', 'entryAt/exitAt');
  } else {
    need(v.REASON_CODES.includes(label.reasonCode), 'LABEL_INVALID', `reasonCode:${label.reasonCode}`);
    for (const k of v.RETURN_KEYS) need(!has(label, k), 'LABEL_RETURN_ON_NON_VALUE', k);
  }
  for (const k of [...Object.keys(label), ...Object.keys(label.priceSourceRef || {})]) need(!FORBIDDEN_KEY.test(k), 'LABEL_FORBIDDEN_FIELD', k);
  need(label.labelHash === labelHashOf(label), 'LABEL_HASH_MISMATCH', label.candidateId);
  return label;
}

const finish = (label) => { const l = { ...label }; l.labelHash = labelHashOf(l); return l; };

function checkPrice(p, label, asOf) {
  if (p.state !== 'VALUE') return p;
  need(v.isIso(p.availableAt), 'LABEL_PROVIDER_INVALID', `${label}:availableAt`);
  need(Date.parse(p.availableAt) <= Date.parse(asOf), 'LABEL_PROVIDER_FUTURE_PRICE', `${label}:${p.availableAt}`);
  return Number.isFinite(p.value) && p.value > 0 ? p : { state: 'UNAVAILABLE', reasonCode: 'PRICE_UNAVAILABLE' };
}

/**
 * @param {{record: object, row: object, windowId: string, provider: object, now: string, benchmarkKey?: string}} o
 *   record: a CANDIDATE_PANEL_V1 record (read only); row: one of its rows; now: the evaluation clock, an ISO instant.
 * @returns {object} a PANEL_LABEL_V1 row (not stored)
 */
function computeLabel({ record, row, windowId, provider, now, benchmarkKey } = {}) {
  assertProvider(provider);
  need(v.isObj(record) && v.MARKETS.includes(record.market) && v.DATE.test(record.sessionDate || '') && v.isIso(record.evaluatedAt) && v.SHA64.test(record.recordHash || ''), 'LABEL_PANEL_INPUT_INVALID', 'record');
  need(v.isObj(row) && v.isText(row.candidateId) && v.isText(row.securityId), 'LABEL_PANEL_INPUT_INVALID', 'row');
  need(v.isIso(now), 'LABEL_PANEL_INPUT_INVALID', 'now');
  const { market } = record;
  const win = v.parseWindowId(market, windowId);
  const benchmarkId = benchmarkKey === undefined ? v.BENCHMARKS[market][0] : benchmarkKey;
  need(v.BENCHMARKS[market].includes(benchmarkId), 'LABEL_BENCHMARK_NOT_ALLOWED', `${market}:${benchmarkId}`);
  const priceMethod = provider.priceMethod(market);
  need(market !== 'CN' || priceMethod === v.CN_PRICE_METHOD, 'LABEL_PRICE_METHOD_NOT_ALLOWED', String(priceMethod));
  const instrumentKey = row.carrierId || row.securityId;

  const entryAt = provider.entryAt({ market, sessionDate: record.sessionDate, evaluatedAt: record.evaluatedAt });
  const exitAt = provider.exitAt({ market, entryAt, windowUnit: win.unit, windowLength: win.length });
  need(v.isIso(entryAt) && v.isIso(exitAt) && Date.parse(entryAt) < Date.parse(exitAt) && Date.parse(entryAt) >= Date.parse(record.evaluatedAt), 'LABEL_PROVIDER_INVALID', 'calendar');
  const maturesAt = v.iso(Date.parse(exitAt) + provider.availabilityLagMs({ market }));
  const base = {
    schema: 'PANEL_LABEL_V1', candidateId: row.candidateId, panelRecordHash: record.recordHash, windowId, windowUnit: win.unit, windowLength: win.length,
    entryBasis: v.ENTRY_BASIS[market], entryAt: null, exitAt: null, maturesAt, maturedAt: null, state: 'UNKNOWN', reasonCode: null,
    priceSourceRef: { providerId: provider.providerId, providerVersion: provider.providerVersion, priceMethod, pricedInstrument: instrumentKey, benchmarkId },
    computedAt: now, researchOnly: true, productionEffect: 'NONE',
  };
  const unresolved = (state, reasonCode) => finish({ ...base, state, reasonCode });
  // LB-6: before maturesAt nothing is read and nothing is claimed
  if (Date.parse(now) < Date.parse(maturesAt)) return unresolved('UNKNOWN', 'LABEL_NOT_MATURED');

  const get = (key, at, field) => checkPrice(provider.price({ market, instrumentKey: key, at, field, asOf: now }), `${key}:${field}`, now);
  const entry = get(instrumentKey, entryAt, 'OPEN');
  const exit = get(instrumentKey, exitAt, 'CLOSE');
  if (entry.state !== 'VALUE' || exit.state !== 'VALUE') {
    const delisted = [entry, exit].some((p) => p.state !== 'VALUE' && p.reasonCode === 'INSTRUMENT_DELISTED_IN_WINDOW');
    return delisted ? unresolved('NOT_APPLICABLE', 'INSTRUMENT_DELISTED_IN_WINDOW') : unresolved('UNKNOWN', 'PRICE_UNAVAILABLE');
  }
  const bEntry = get(benchmarkId, entryAt, 'OPEN');
  const bExit = get(benchmarkId, exitAt, 'CLOSE');
  const grossReturn = exit.value / entry.value - 1;
  const available = [entry.availableAt, exit.availableAt];
  const sourceRefs = { entry: entry[SOURCE_REFS] ?? null, exit: exit[SOURCE_REFS] ?? null };
  let benchmarkReturn = { state: 'UNKNOWN', reasonCode: 'BENCHMARK_PRICE_UNAVAILABLE' };
  let excessReturn = { state: 'UNKNOWN', reasonCode: 'EXCESS_BENCHMARK_UNAVAILABLE' };
  if (bEntry.state === 'VALUE' && bExit.state === 'VALUE') {
    benchmarkReturn = bExit.value / bEntry.value - 1;
    excessReturn = grossReturn - benchmarkReturn;
    available.push(bEntry.availableAt, bExit.availableAt);
    sourceRefs.benchmarkEntry = bEntry[SOURCE_REFS] ?? null; sourceRefs.benchmarkExit = bExit[SOURCE_REFS] ?? null;
  }
  const maturedMs = Math.max(Date.parse(maturesAt), ...available.map(Date.parse));
  return finish({
    ...base, entryAt, exitAt, grossReturn, benchmarkReturn, excessReturn, maturedAt: v.iso(maturedMs), state: 'VALUE', reasonCode: null,
    priceSourceRef: { ...base.priceSourceRef, sourceRefs },
  });
}

module.exports = { FORBIDDEN_KEY, assertProvider, labelHashOf, validateLabel, computeLabel, has };
