'use strict';
const fs = require('node:fs');
const { sha256, contentHash } = require('../desk-review-routing/canonical');

// Q70 BRIEF §§2/4. These are adapters over the delivered Desk contracts:
// schemas/{trade-ledger.v1,book-nav-series.v1,review-decomposition.v2}.schema.json
// and src/review-decomposition-v2.js bookKeyOf / LOSS_ATTRIBUTION_BOOKS.
// No data discovery, model invocation, producer execution, or business math.
// validateContract MUST come from trusted startup configuration (Desk's
// src/validate.js); never resolve code paths supplied by an input document.
const BOOKS = Object.freeze({
  ASHARE_V6_PAPER: { market: 'CN', producer: 'ASHARE_V6', decompositionProducer: 'ASHARE_V6', currency: 'CNY', parts: ['INDEX', 'STOCK'] },
  US_V5_ETF_3000USD: { market: 'US', producer: 'SMARTFLOW_US', decompositionProducer: 'SMARTFLOW', currency: 'USD', parts: [null] },
  US_CORE_9000USD_3X_GATEOBS: { market: 'US', producer: 'SMARTFLOW_US', decompositionProducer: 'SMARTFLOW', currency: 'USD', parts: [null] },
  C17_V2_4000USDT: { market: 'CRYPTO', producer: 'SMARTFLOW_CRYPTO', decompositionProducer: 'SMARTFLOW', currency: 'USDT', parts: [null] },
  QUICK_SHOT_V3_1000USDT: { market: 'CRYPTO', producer: 'SMARTFLOW_CRYPTO', decompositionProducer: 'SMARTFLOW', currency: 'USDT', parts: [null] },
});
const KINDS = Object.freeze({ trades: 'TRADE_LEDGER_V1', nav: 'BOOK_NAV_SERIES_V1', decomposition: 'REVIEW_DECOMPOSITION_V2' });
const hex = /^[a-f0-9]{64}$/;
const problem = (reason, status = 'INPUT_MISSING') => { throw Object.assign(new Error(reason), { reason, status }); };
function readSource({ source, kind, request, book, period, validateContract, nowMs }) {
  if (!source || typeof source.file !== 'string') problem('SOURCE_MISSING');
  let bytes; try { bytes = fs.readFileSync(source.file); } catch { problem('SOURCE_MISSING'); }
  if (!hex.test(source.sha256 || '') || sha256(bytes) !== source.sha256) problem('SOURCE_HASH');
  let doc; try { doc = JSON.parse(bytes); } catch { problem('SOURCE_JSON'); }
  if (!doc || Array.isArray(doc) || typeof doc !== 'object') problem('SOURCE_JSON');
  if (!hex.test(doc.hash || '') || contentHash(doc) !== doc.hash) problem('PAYLOAD_HASH');
  const decomposition = kind === 'decomposition';
  if (doc.schemaVersion !== (decomposition ? 2 : 1)
      || (kind === 'nav' && doc.contract !== KINDS.nav)
      || doc.producer !== (decomposition ? book.decompositionProducer : book.producer)
      || doc.market !== book.market || doc.currency !== book.currency) problem('PRODUCER_BINDING');
  if (!decomposition && doc.ledgerId !== request.ledgerId) problem('LEDGER_BINDING');
  if (kind === 'nav' && doc.partId !== (request.partId ? `${request.partId}_BOOK` : null)) problem('PART_BINDING');
  if (doc.sessionDate !== period) problem('SESSION_DATE', 'INPUT_STALE');
  let validated;
  try { validated = validateContract(KINDS[kind], doc, { nowMs }); } catch { problem('PRODUCER_VALIDATOR_FAILED'); }
  if (!validated || validated.ok !== true) {
    const reason = validated && typeof validated.reason === 'string' && /^[A-Z][A-Z0-9_]*$/.test(validated.reason) ? validated.reason : 'PRODUCER_INVALID';
    problem(reason, reason === 'SESSION_STALE' ? 'INPUT_STALE' : 'INPUT_MISSING');
  }
  let data = doc;
  if (decomposition) {
    const la = doc.lossAttribution;
    const matches = la && Array.isArray(la.books) ? la.books.filter(b => b.ledgerId === request.ledgerId && (b.partId ?? null) === (request.partId ?? null)) : [];
    if (matches.length !== 1) problem('ATTRIBUTION_BOOK_BINDING');
    // The shared market A/B/S/D arms are not attributed to this book. Only the
    // producer's exact per-book decomposition, windows and ruleVersion enter.
    data = { sessionDate: doc.sessionDate, market: doc.market, currency: doc.currency, plan: la.plan, accountBasis: la.accountBasis, book: matches[0] };
  }
  return { sourceFile: source.file, sourceSha256: source.sha256, sourceContract: KINDS[kind], scope: kind === 'trades' ? 'LEDGER' : 'BOOK', data };
}

// READY covers only this three-source daily slice. The standalone runner consumes
// these packs independently; weekly and complete reconciliation remain pending.
function isRegisteredDailyLedger(ledger) {
  return typeof ledger === 'string' && Object.entries(BOOKS).some(([id, book]) =>
    book.parts.some(part => ledger === `${id}${part ? `:${part}` : ''}`));
}
function readDeskDailyPacks({ period, requests, validateContract, nowMs }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period || '') || !Array.isArray(requests) || !Number.isFinite(nowMs)) throw Error('DESK_INPUT_ARGUMENTS');
  return requests.map(request => {
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.ledgerId !== 'string') {
      return { period, output: 'DAILY', ledger: null, facts: [], states: [{ ledger: null, status: 'INPUT_MISSING', reason: 'REQUEST_INVALID' }], inputState: 'INPUT_MISSING', coverage: 'DESK_DAILY_THREE_SOURCE_SLICE' };
    }
    const partId = request.partId ?? null;
    const ledger = `${request.ledgerId}${partId ? `:${partId}` : ''}`;
    const pack = { period, output: 'DAILY', ledger, facts: [], states: [], inputState: 'INPUT_MISSING', coverage: 'DESK_DAILY_THREE_SOURCE_SLICE' };
    const book = BOOKS[request.ledgerId];
    if (!book || !book.parts.includes(partId) || typeof validateContract !== 'function') {
      pack.states.push({ ledger, status: 'INPUT_MISSING', reason: request.ledgerId === 'CARRY_V2_SHADOW_10000USDT' ? 'NAV_CONTRACT_NOT_REGISTERED' : !book || !book.parts.includes(partId) ? 'BOOK_NOT_REGISTERED' : 'PRODUCER_VALIDATOR_MISSING' });
      return pack;
    }
    for (const kind of Object.keys(KINDS)) {
      try {
        const fact = readSource({ source: (request.sources || {})[kind], kind, request, book, period, validateContract, nowMs });
        pack.facts.push({ id: `F${pack.facts.length + 1}`, ledger, ...fact });
        pack.states.push({ ledger, sourceContract: KINDS[kind], status: 'READY', reason: null });
      } catch (error) {
        pack.states.push({ ledger, sourceContract: KINDS[kind], status: error.status || 'INPUT_MISSING', reason: error.reason || 'SOURCE_INVALID' });
      }
    }
    pack.inputState = pack.states.some(s => s.status === 'INPUT_MISSING') ? 'INPUT_MISSING' : pack.states.some(s => s.status === 'INPUT_STALE') ? 'INPUT_STALE' : 'READY';
    return pack;
  });
}
module.exports = { readDeskDailyPacks, isRegisteredDailyLedger };
