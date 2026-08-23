'use strict';
/**
 * A 股市场适配器(CN_A)—— 平台 MVP 首个落地市场。
 * 证券分类规则迁移自 Ashare-V5 services/market_data/ashare_instrument_classifier 的口径:
 * 按 ts_code 段区分股票/ETF/指数;交易规则:T+1、100 股一手、主板 ±10% 涨跌幅。
 */
const STOCK_PREFIX = /^(600|601|603|605|000|001|002|003|300|301|688)\d{3}\.(SH|SZ)$/;
const ETF_PREFIX = /^(51|56|58|15|16)\d{4}\.(SH|SZ)$/;
const INDEX_PREFIX = /^(000\d{3}\.SH|399\d{3}\.SZ)$/;

function classifyInstrument(id) {
  const s = String(id || '');
  // 指数与深市股票同为 000 开头,靠交易所后缀区分:000xxx.SH 是指数,000xxx.SZ 是股票
  if (INDEX_PREFIX.test(s)) return 'INDEX';
  if (STOCK_PREFIX.test(s)) return 'STOCK';
  if (ETF_PREFIX.test(s)) return 'ETF';
  return 'UNKNOWN';
}

module.exports = {
  market_id: 'CN_A',
  RUNTIME_ID: 'RT-CN_A-PAPER-1', // A 股 Paper Runtime 标识(生产实体在 Ashare-V5)
  displayNameCn: 'A 股(沪深)',
  currency: 'CNY',
  timezone: 'Asia/Shanghai',
  benchmark: '000300.SH',
  tradingRules: {
    settlement: 'T+1',
    lotSize: 100,
    priceLimitPct: 10,       // 主板;科创/创业 20%,MVP 以主板口径声明
    shortAllowed: false,
  },
  defaultCostPerSide: 0.001, // 0.1%/边(佣金+滑点合并近似;与源仓 vpq_lab_engine 同值)
  classifyInstrument,
  isValidInstrument: (id) => classifyInstrument(id) !== 'UNKNOWN',
};
