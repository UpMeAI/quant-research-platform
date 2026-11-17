'use strict';

/**
 * A 股涨跌停（协调会话裁定 R1.7，ce254328…：V6 生产没有涨跌停价的来源，按板块涨跌幅规则从 previous_close 推算，与 V6 实盘判断能否成交的规则相同）。
 * 照抄 V6 实盘（Ashare-V6 83ab3af1）：
 *   - 涨跌幅：config/v6/market-rules/price_limit_history_v1.json:105–116（按 交易所:板块:STOCK、风险警示状态、生效日）；
 *     src/kernel/market-rules/price-limit-history.js:69–90（除 'ST' 以外一律读 NORMAL）；
 *   - 板块：src/kernel/security/classifier.js:29–32（688/689 → STAR，300/301/302 → CHINEXT，.BJ → BSE，其余 MAIN）；
 *   - 价格：src/kernel/market-rules/price-limit-band.js:47–48（roundToFen：加 Number.EPSILON 后四舍五入到分）、:61–64（涨停 = roundToFen(前收 × (1 + 幅))，跌停同理）；
 *   - 能否成交：src/stock-book/five-stage/paper-simulator.js:122（开盘 ≥ 涨停 − 0.005 → 买不进）、:89（开盘 ≤ 跌停 + 0.005 → 卖不出，留到下一次）；
 *     AT_LIMIT_EPS = 0.005（price-limit-band.js:45）。没有开盘价（停牌）→ 都不能成交（paper-simulator.js:88 的 EXIT_CARRIED_SUSPENDED）。
 * V6 只登记了主板的全部日期，创业板、科创板只从 2026-07-06 起（之前在 V6 里是 BLOCKED）。研究要用到更早的验证折，所以补了两条
 * RESEARCH_EXTENSION（不是 V6 的，照实标出来源）：创业板 2020-08-24 注册制改革起 20%（之前主板同款 10% / ST 5%），科创板 2019 年开板起 20%。
 * 裁定原文写「主板 ST 5%」；V6 的表写主板 ST 2026-07-06 起是 10%（交易所 2026 年修订），裁定说逐条以 V6 实盘为准，这里照 V6。
 */
const AT_LIMIT_EPS = 0.005;
const RECORDS = Object.freeze([
  { board: 'MAIN', st: false, pct: 0.10, from: null, to: null, source: 'V6' },
  { board: 'MAIN', st: true, pct: 0.05, from: null, to: '2026-07-06', source: 'V6' },
  { board: 'MAIN', st: true, pct: 0.10, from: '2026-07-06', to: null, source: 'V6' },
  { board: 'CHINEXT', st: false, pct: 0.20, from: '2026-07-06', to: null, source: 'V6' },
  { board: 'CHINEXT', st: true, pct: 0.20, from: '2026-07-06', to: null, source: 'V6' },
  { board: 'STAR', st: false, pct: 0.20, from: '2026-07-06', to: null, source: 'V6' },
  { board: 'STAR', st: true, pct: 0.20, from: '2026-07-06', to: null, source: 'V6' },
  { board: 'CHINEXT', st: false, pct: 0.20, from: '2020-08-24', to: '2026-07-06', source: 'RESEARCH_EXTENSION' },
  { board: 'CHINEXT', st: true, pct: 0.20, from: '2020-08-24', to: '2026-07-06', source: 'RESEARCH_EXTENSION' },
  { board: 'CHINEXT', st: false, pct: 0.10, from: null, to: '2020-08-24', source: 'RESEARCH_EXTENSION' },
  { board: 'CHINEXT', st: true, pct: 0.05, from: null, to: '2020-08-24', source: 'RESEARCH_EXTENSION' },
  { board: 'STAR', st: false, pct: 0.20, from: null, to: '2026-07-06', source: 'RESEARCH_EXTENSION' },
  { board: 'STAR', st: true, pct: 0.20, from: null, to: '2026-07-06', source: 'RESEARCH_EXTENSION' },
].map(Object.freeze));

class LimitError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 板块：代码是 V6 的写法（6 位数字 + .SH/.SZ/.BJ）就照 V6 的前缀规则；否则（合成代码）用证券主表的 board。 */
function boardOf(code, masterBoard = null) {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/.exec(String(code || '').toUpperCase());
  if (!m) return masterBoard;
  if (m[2] === 'BJ') return 'BSE';
  if (/^(688|689)/.test(m[1])) return 'STAR';
  if (/^(300|301|302)/.test(m[1])) return 'CHINEXT';
  return 'MAIN';
}

/** 某一天的涨跌幅（{ pct, source }）。北交所不在股票池里（MINE_LIMIT_BOARD_UNSUPPORTED）。 */
function bandOf({ board, st, date }) {
  const hit = RECORDS.find((r) => r.board === board && r.st === Boolean(st) && (r.from === null || date >= r.from) && (r.to === null || date < r.to));
  if (!hit) throw new LimitError('MINE_LIMIT_BOARD_UNSUPPORTED', `${board}:${st ? 'ST' : 'NORMAL'}:${date}`);
  return { pct: hit.pct, source: hit.source };
}

const roundToFen = (v) => Number((Math.round((v + Number.EPSILON) * 100) / 100).toFixed(2));
const limitPrices = (prevClose, pct) => ({ up: roundToFen(prevClose * (1 + pct)), down: roundToFen(prevClose * (1 - pct)) });

/** 开盘买得进吗：有开盘价、有前收，且开盘 < 涨停 − 0.005。 */
function canBuy({ open, prevClose, pct }) {
  if (!isNum(open) || !(open > 0) || !isNum(prevClose) || !(prevClose > 0)) return false;
  return !(open >= limitPrices(prevClose, pct).up - AT_LIMIT_EPS);
}
/** 开盘卖得出吗：有开盘价、有前收，且开盘 > 跌停 + 0.005。 */
function canSell({ open, prevClose, pct }) {
  if (!isNum(open) || !(open > 0) || !isNum(prevClose) || !(prevClose > 0)) return false;
  return !(open <= limitPrices(prevClose, pct).down + AT_LIMIT_EPS);
}

module.exports = { AT_LIMIT_EPS, RECORDS, LimitError, boardOf, bandOf, roundToFen, limitPrices, canBuy, canSell };
