'use strict';
/**
 * Synthetic LAB_REPLAY_OUTPUT_V1 for the W24b producers: what the replay core would hand the lab for a frozen candidate (daily gross return and cost per arm, the candidate's
 * trades, parameter-perturbation arms, the portfolio with and without the candidate). Deterministic (mulberry32), no ledger, no clock. The numbers have no economic meaning.
 */
const mulberry32 = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

function weekdays(from, n) {
  const out = []; let t = Date.parse(`${from}T00:00:00Z`);
  while (out.length < n) { const d = new Date(t); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10)); t += 864e5; }
  return out;
}

/** @param {{days?: number, edge?: number, seed?: number, from?: string}} [o] edge: daily gross advantage of the candidate over the baseline */
function makeReplay({ days = 504, edge = 0.0004, seed = 7, from = '2025-01-02' } = {}) {
  const rnd = mulberry32(seed); const noise = () => (rnd() - 0.5) * 0.01;
  const dates = weekdays(from, days);
  const base = dates.map((date) => ({ date, gross: 0.0003 + noise(), cost: 0.00015 }));
  const cand = base.map((b) => ({ date: b.date, gross: b.gross + edge + (rnd() - 0.5) * 0.002, cost: 0.0002 }));
  const perturb = (id, shift) => ({ id, daily: cand.map((c) => ({ date: c.date, gross: c.gross - shift, cost: c.cost })) });
  const trades = [];
  dates.slice(0, 40).forEach((date, i) => {
    trades.push({ date, code: i % 2 ? '600000.SH' : '000001.SZ', st: false, side: 'BUY', notional: 100000, open: 10.1, prev_close: 10, participation: 0.02 });
    trades.push({ date, code: i % 2 ? '600000.SH' : '000001.SZ', st: false, side: 'SELL', notional: 100000, open: 10.2, prev_close: 10.1, participation: 0.02 });
  });
  const without = base.map((b) => ({ date: b.date, net: b.gross - b.cost }));
  const withC = base.map((b, i) => ({ date: b.date, net: b.gross - b.cost + (cand[i].gross - b.gross) * 0.2 - (cand[i].cost - b.cost) * 0.2 }));
  return {
    schema: 'LAB_REPLAY_OUTPUT_V1', candidate_id: 'AIP-CNA-001', market: 'CN_A', cost_model_ref: 'W24B_FIXTURE_COSTS_V1', cost_book: 'STOCK_BOOK', cost_flags: {},
    arms: { baseline: { daily: base }, candidate: { daily: cand } }, trades,
    perturbations: [perturb('PARAM_MINUS_20', edge * 0.3), perturb('PARAM_PLUS_20', edge * 0.2)],
    portfolio: { with: withC, without, stress: [{ id: 'STRESS_2024_01', delta: 0.0005 }, { id: 'STRESS_2025_04', delta: 0.0002 }], holdings_overlap: dates.map((date) => ({ date, jaccard: 0.2 })) },
  };
}

module.exports = { makeReplay, weekdays, mulberry32 };
