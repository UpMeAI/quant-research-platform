'use strict';
// Read delivered producer artifacts only. No scanning fallback or producer calls.
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('../desk-review-routing/canonical');
const { readDeskDailyPacks, dailyBookRequests } = require('./desk-input');
function source(file) {
  try { return { file, sha256: sha256(fs.readFileSync(file)) }; }
  catch { return { file, sha256: null }; }
}
function readDailyInbox({ inbox, period, nowMs, validateContract }) {
  if (typeof inbox !== 'string' || !inbox || !/^\d{4}-\d{2}-\d{2}$/.test(period || '') || !Number.isFinite(nowMs)) throw Error('DAILY_INBOX_ARGUMENTS');
  const requests = dailyBookRequests().map(({ ledgerId, partId, producer, market }) => ({
    ledgerId, partId, sources: {
      trades: source(path.join(inbox, producer, 'trades', ledgerId, `TRADE_LEDGER_${period}.json`)),
      nav: source(path.join(inbox, producer, 'ledger', ledgerId, `BOOK_NAV_SERIES_${ledgerId}${partId ? `_${partId}_BOOK` : ''}_${period}.json`)),
      decomposition: source(path.join(inbox, producer, 'review', market, `REVIEW_DECOMPOSITION_V2_${period}.json`)),
    },
  }));
  // Requested by Q70, explicitly unsupported by the existing NAV registration.
  requests.push({ ledgerId: 'CARRY_V2_SHADOW_10000USDT', sources: {} });
  const ruleFile = path.join(inbox, 'COORDINATOR', 'rule-changes', 'RULE_CHANGE_LEDGER.json');
  const ruleSource = source(ruleFile);
  return {
    period,
    slicePacks: readDeskDailyPacks({ period, requests, nowMs, validateContract }),
    completeDailyReady: false,
    ruleChanges: {
      status: ruleSource.sha256 === null ? 'INPUT_MISSING' : 'UNBOUND',
      reason: ruleSource.sha256 === null ? 'SOURCE_MISSING' : 'DAILY_RULE_COVERAGE_UNBOUND',
      sourceFile: ruleFile, sourceSha256: ruleSource.sha256,
    },
  };
}
module.exports = { readDailyInbox };
