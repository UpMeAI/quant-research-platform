'use strict';

/**
 * Cost runs and fills for V-4 (W24b; W22 costBreakdown shape; registry r3 vendored in QRP #144; G-COST coverage #143). From the candidate's trades the producer charges every item the
 * registry marks CHARGED for the book, with the registry's own rates and side rules (commission, exchange fee by venue, transfer fee, slippage, stamp duty by date on sells, the per-fill
 * minimum commission top-up) and returns { v4: { market, runs: [{cost_model_ref, cost_book, cost_flags, cost_breakdown}], fills } }. No rate is written here. An item the producer
 * cannot price, an unknown venue or book is a refusal, never a zero.
 */
const costGate = require('../cost-gate');

const sideApplies = (rule, side) => rule === 'BOTH' || rule === side;
const venueOf = (code) => (/\.SH$/.test(code) ? 'SH' : /\.SZ$/.test(code) ? 'SZ' : null);
const bpsOn = (date, schedule) => schedule.filter((s) => s.from <= date).sort((a, b) => (a.from < b.from ? -1 : 1)).pop();

function produce({ replay }) {
  if (!replay || typeof replay !== 'object' || !Array.isArray(replay.trades)) return { refusal: 'COST_RUN_NO_TRADES' };
  if (!replay.trades.length) return { refusal: 'COST_RUN_NO_TRADES' };
  const registry = costGate.coverage.loadRegistry();
  const market = replay.market;
  const book = registry.markets[market] && registry.markets[market][replay.cost_book];
  if (!book) return { refusal: `COST_RUN_BOOK_UNKNOWN:${replay.cost_book}` };
  const flags = replay.cost_flags && typeof replay.cost_flags === 'object' ? replay.cost_flags : {};
  const defs = Object.entries(book.items).filter(([, d]) => d.state === 'CHARGED' || (d.state === 'CONDITIONAL' && d.whenOn && flags[d.whenOn] === true));
  const totals = Object.fromEntries(defs.map(([k]) => [k, 0]));
  let notional = 0;
  for (const t of replay.trades) {
    const venue = venueOf(t.code);
    if (!venue) return { refusal: `COST_RUN_VENUE_UNKNOWN:${t.code}` };
    notional += t.notional;
    let commissionFill = 0;
    for (const [item, d] of defs) {
      let amount = 0;
      if (item === 'COMMISSION') { if (sideApplies(d.side, t.side)) amount = t.notional * d.bps * 1e-4; commissionFill = amount; }
      else if (item === 'EXCHANGE_FEE') { if (sideApplies(d.side, t.side)) amount = d.components.filter((c) => c.venue === venue).reduce((s, c) => s + c.bps, 0) * t.notional * 1e-4; }
      else if (item === 'TRANSFER_FEE' || item === 'SLIPPAGE') { if (sideApplies(d.side, t.side)) amount = t.notional * d.bps * 1e-4; }
      else if (item === 'STAMP_DUTY') { if (sideApplies(d.side, t.side)) { const s = bpsOn(t.date, d.schedule); amount = s ? t.notional * s.bps * 1e-4 : 0; } }
      else if (item === 'MIN_COMMISSION_TOPUP') { continue; }
      else return { refusal: `COST_RUN_ITEM_UNSUPPORTED:${item}` };
      totals[item] += amount;
    }
    if ('MIN_COMMISSION_TOPUP' in totals) totals.MIN_COMMISSION_TOPUP += Math.max(0, book.items.MIN_COMMISSION_TOPUP.minPerFillCny - commissionFill);
  }
  const items = Object.keys(totals).sort().map((item) => ({ item, state: 'CHARGED', amount: totals[item] }));
  const bps = (a) => (notional > 0 ? (a / notional) * 1e4 : 0);
  const commissionBps = bps((totals.COMMISSION || 0) + (totals.MIN_COMMISSION_TOPUP || 0));
  const slippageBps = bps(totals.SLIPPAGE || 0);
  const run = { cost_model_ref: replay.cost_model_ref, cost_book: replay.cost_book, cost_flags: flags,
    cost_breakdown: { model: replay.cost_model_ref, commission_bps: commissionBps, slippage_bps: slippageBps, items } };
  const fills = replay.trades.map((t) => ({ date: t.date, code: t.code, st: t.st === true, side: t.side, open: t.open, prevClose: t.prev_close, participation: t.participation }));
  return { v4: { market, runs: [run], fills } };
}

module.exports = { produce };
