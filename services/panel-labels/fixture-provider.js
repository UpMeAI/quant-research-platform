'use strict';

/**
 * Fixture price provider for tests and demonstrations (it is NOT a market data source). It implements the provider interface of label.js over explicit tables:
 * an explicit session calendar (CN, US) or fixed hourly bars (crypto), explicit prices with their availableAt, and an optional delisting instant per instrument.
 * The weekday calendar has no holidays and the US fixture clock is fixed UTC-5 (standard time); it is only good for dates the test chooses with that in mind.
 * `calls` records every price read so a test can prove that no price was read before maturity.
 */
const v = require('./vocab');

const DAY = 86400000;
const HOUR = 3600000;
const SESSION_CLOCK = Object.freeze({ CN: ['T01:30:00.000Z', 'T07:00:00.000Z'], US: ['T14:30:00.000Z', 'T21:00:00.000Z'] });

const addDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/** Mon to Fri sessions from `startDate` (inclusive): [{date, openAt, closeAt}]. */
function weekdaySessions(market, startDate, count) {
  const [open, close] = SESSION_CLOCK[market];
  const out = [];
  for (let d = startDate; out.length < count; d = addDay(d)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push({ date: d, openAt: `${d}${open}`, closeAt: `${d}${close}` });
  }
  return out;
}

function create({ providerId = 'FIXTURE_PRICES', providerVersion = '1', sessions = {}, barMs = {}, lagMs = {}, delisted = {}, priceMethods = {} } = {}) {
  const bars = { US: 300000, CRYPTO: HOUR, ...barMs };
  const lags = { CN: 1800000, US: 1800000, CRYPTO: 60000, ...lagMs };
  const table = new Map(); // `${instrument}|${field}|${at}` -> {value, availableAt}
  const calls = [];
  const sessionsOf = (market) => { v.need(sessions[market] && sessions[market].length, 'FIXTURE_CALENDAR_MISSING', market); return sessions[market]; };

  const provider = {
    providerId, providerVersion, calls,
    priceMethod: (market) => priceMethods[market] || (market === 'CN' ? v.CN_PRICE_METHOD : 'FIXTURE_RAW_BAR_PRICES'),
    entryAt({ market, sessionDate, evaluatedAt }) {
      const t = Date.parse(evaluatedAt);
      if (market === 'CRYPTO') return v.iso(Math.ceil(t / bars.CRYPTO) * bars.CRYPTO);
      const list = sessionsOf(market);
      if (market === 'CN') {
        const next = list.find((s) => s.date > sessionDate);
        v.need(next, 'FIXTURE_CALENDAR_EXHAUSTED', `${market}:${sessionDate}`);
        return next.openAt;
      }
      for (const s of list) {
        const open = Date.parse(s.openAt); const close = Date.parse(s.closeAt);
        if (close <= t) continue;
        const start = t <= open ? open : open + Math.ceil((t - open) / bars.US) * bars.US;
        if (start < close) return v.iso(start);
      }
      return v.fail('FIXTURE_CALENDAR_EXHAUSTED', `${market}:${evaluatedAt}`);
    },
    exitAt({ market, entryAt, windowUnit, windowLength }) {
      if (windowUnit === 'HOUR') return v.iso(Date.parse(entryAt) + windowLength * HOUR);
      const list = sessionsOf(market);
      const t = Date.parse(entryAt);
      const idx = list.findIndex((s) => Date.parse(s.openAt) <= t && t < Date.parse(s.closeAt));
      v.need(idx >= 0 && list[idx + windowLength - 1], 'FIXTURE_CALENDAR_EXHAUSTED', `${market}:${entryAt}+${windowLength}`);
      return list[idx + windowLength - 1].closeAt;
    },
    availabilityLagMs: ({ market }) => lags[market],
    price({ instrumentKey, at, field, asOf }) {
      calls.push({ instrumentKey, at, field, asOf });
      if (delisted[instrumentKey] && Date.parse(at) > Date.parse(delisted[instrumentKey])) return { state: 'UNAVAILABLE', reasonCode: 'INSTRUMENT_DELISTED_IN_WINDOW' };
      const hit = table.get(`${instrumentKey}|${field}|${at}`);
      if (!hit || Date.parse(hit.availableAt) > Date.parse(asOf)) return { state: 'UNAVAILABLE', reasonCode: 'PRICE_UNAVAILABLE' };
      return { state: 'VALUE', value: hit.value, availableAt: hit.availableAt, sourceRef: `FIXTURE:${instrumentKey}:${field}:${at}` };
    },
    /** Add one price: instrument, OPEN|CLOSE, the bar instant it belongs to, the value, and when it became available (default: the instant itself). */
    set(instrumentKey, field, at, value, availableAt = at) { table.set(`${instrumentKey}|${field}|${at}`, { value, availableAt }); return provider; },
  };
  return provider;
}

module.exports = { create, weekdaySessions };
