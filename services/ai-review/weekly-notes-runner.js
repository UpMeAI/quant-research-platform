'use strict';
// Delivery orchestration for already-built canonical weekly packs only.
// This module neither assembles weekly sources nor freezes reconciliation bindings.
const path = require('node:path');
const { run } = require('./index');
const { persistReport } = require('./runner');
const { isRegisteredDailyLedger } = require('./desk-input');
const { sha256, canonicalJson } = require('../desk-review-routing/canonical');
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
async function runWeeklyNotes({ reviewPacks, directionsPack, root = path.resolve(__dirname, '../../var/ai-review'), ...options }) {
  const validPack = (p, output) => p && p.output === output && validDate(p.period) && Array.isArray(p.facts) && Array.isArray(p.states);
  if (!Array.isArray(reviewPacks) || !reviewPacks.length || !validPack(directionsPack, 'WEEKLY_DIRECTIONS')
      || directionsPack.ledger !== 'ALL_LEDGERS'
      || reviewPacks.some(p => !validPack(p, 'WEEKLY_REVIEW') || p.period !== directionsPack.period
        || !(isRegisteredDailyLedger(p.ledger) || (p.ledger === 'CARRY_V2_SHADOW_10000USDT' && ['INPUT_MISSING', 'INPUT_STALE'].includes(p.inputState))))
      || new Set(reviewPacks.map(p => p.ledger)).size !== reviewPacks.length) throw Error('WEEKLY_SCOPE_INVALID');
  const deliver = async pack => {
    const namespace = `ledger-${sha256(canonicalJson(pack.ledger))}`;
    const result = await run({ ...options, root, pack: { ...pack, coverage: pack.coverage ?? null }, namespace });
    return persistReport({ root, period: pack.period, namespace, output: pack.output, result });
  };
  const reviews = [];
  for (const pack of reviewPacks) reviews.push(await deliver(pack));
  // Exactly one global directions artifact per week; the existing checker enforces
  // <= 3 questions. No per-book generation that multiplies the weekly limit.
  const directions = await deliver(directionsPack);
  return { reviews, directions };
}
module.exports = { runWeeklyNotes };
