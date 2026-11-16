'use strict';
/**
 * 反例夹具（§8.3 第 7 条）：故意偷看 t+1 的「算子」。不在白名单、不在求值器里，只给因果测试用——T-C1、T-C2 必须 FAIL。
 */
const ROWS = Object.freeze({
  /** 当天输出明天的值（偷看 t+1）。 */
  ts_lead: (rows, n) => rows.map((_, i) => (i + n < rows.length ? rows[i + n].value : NaN)),
});
module.exports = { ROWS };
