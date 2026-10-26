'use strict';

/**
 * 成本模型 US_V5_M1_RESEARCH_COST_V1（冻结的 M1 研究成本合同）：策略签署成本双边 5 bps、监管费研究覆盖层
 * （按日、按账户、各费种向上取整到分）、佣金实测为 0。费率参数取自 M1 证据清单的 `cost_model`。
 * 本模块从 services/strategy-diagnostics/index.js 原样搬出，计算不变；诊断按策略档案的 cost_model_id 选它。
 */

function diagnosticError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function ceilCent(value) {
  if (!Number.isFinite(value) || value < 0) throw diagnosticError('US_V5_M1_COST_NOT_FINITE');
  if (value === 0) return 0;
  // 12 位有效数字吸收二进制浮点噪声（2.2*100 = 220.00000000000003），整分金额不会被误进一分；
  // 真正超过整分的金额（如 3.00000000206 分）仍向上取整。
  return Math.ceil(Number((value * 100).toPrecision(12))) / 100;
}

function calculateCosts(openEvent, closeEvent, model) {
  const signedEntry = openEvent.notional * model.strategy_bps_each_side / 10000;
  const signedExit = closeEvent.notional * model.strategy_bps_each_side / 10000;
  const secSell = ceilCent(closeEvent.notional * model.sec_sell_rate_per_dollar);
  const tafSell = ceilCent(closeEvent.quantity * model.taf_sell_rate_per_share);
  const catBuy = ceilCent(openEvent.quantity * model.cat_rate_per_equivalent_share_each_side);
  const catSell = ceilCent(closeEvent.quantity * model.cat_rate_per_equivalent_share_each_side);
  const regulatory = secSell + tafSell + catBuy + catSell;
  const signedModel = signedEntry + signedExit;
  const total = signedModel + regulatory + model.commission_usd;
  return {
    signed_model: {
      state: 'MODELLED', entry: signedEntry, exit: signedExit, total: signedModel,
      label: '策略签署成本（双边 5 bps）',
    },
    regulatory: {
      state: 'MODELLED_STANDALONE', sec_sell: secSell, taf_sell: tafSell,
      cat_buy: catBuy, cat_sell: catSell, total: regulatory,
      label: '监管费研究覆盖层（按日、按账户、各费种向上取整）',
    },
    commission: { state: 'MEASURED_ZERO', total: model.commission_usd, label: '普通股票／ETF 佣金' },
    total,
  };
}

module.exports = { MODEL_ID: 'US_V5_M1_RESEARCH_COST_V1', ceilCent, calculateCosts };
