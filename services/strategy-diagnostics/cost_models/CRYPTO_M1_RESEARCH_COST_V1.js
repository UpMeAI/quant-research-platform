'use strict';

/**
 * 成本模型 CRYPTO_M1_RESEARCH_COST_V1（CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE §9.2–§9.4）：USDT 永续账本的逐笔对账。
 * 参数取自 QRP 证据清单的 `cost_model` 块，值抄自冻结 K2 QS-F1..F4、QS-P1：
 *   - 手续费 taker / 边，按入场名义（QS-F1）；
 *   - 入场滑点按信号的 quote24h 分档（QS-F2）；出场滑点按库内列读，只核对 = 名义 × detail.exit.slippagePerSide，不重推档位；
 *   - 资金费 = 方向 × Σ 结算费率 × 名义（QS-F3，正数 = 本账本付出）；funding_state 不是 MEASURED 时为 null，不填 0（R-FUND (a)）；
 *   - 毛盈亏 = 方向 × (出场价 − 入场价) × 数量，强平封顶时 = −保证金（QS-F4）；净 R = 净额 ÷ 每笔风险（QS-P1）。
 * 只核对、不改写库内值：任何一项超出容差即 CRYPTO_M1_COST_MISMATCH，写明哪一笔、哪一项。
 */

function costError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const SIDES = Object.freeze({ LONG: 1, SHORT: -1 });

/** 分档按 min_quote24h 从高到低取第一档（档位表来自证据清单）。 */
function slippageTier(quote24h, tiers) {
  if (!finite(quote24h)) throw costError('CRYPTO_M1_COST_INPUT_INVALID', { item: 'quote24h' });
  const ordered = [...tiers].sort((left, right) => right.min_quote24h - left.min_quote24h);
  const tier = ordered.find((item) => quote24h >= item.min_quote24h);
  if (!tier) throw costError('CRYPTO_M1_COST_INPUT_INVALID', { item: 'slippage_tiers' });
  return tier.rate;
}

/**
 * 一笔的逐项对账。返回每一项的 { state, recorded, expected, residual }；资金费缺失时 recorded / expected 都是 null。
 * `trade` 是 quick_shot_v3_trades 的一行（detail 已解析成对象）。
 */
function reconcileTrade(trade, model) {
  const tolerance = model.tolerance_usdt;
  const where = { trade_id: trade.id, symbol: trade.symbol };
  const check = (item, recorded, expected, state) => {
    if (!finite(recorded) || !finite(expected) || Math.abs(recorded - expected) > tolerance) {
      throw costError('CRYPTO_M1_COST_MISMATCH', { ...where, item, recorded: finite(recorded) ? recorded : null, expected: finite(expected) ? expected : null });
    }
    return { state, recorded, expected, residual: recorded - expected };
  };
  const side = SIDES[trade.trade_type];
  if (!side) throw costError('CRYPTO_M1_COST_INPUT_INVALID', { ...where, item: 'trade_type' });
  const detail = trade.detail || {};
  const exit = detail.exit || {};
  const notional = trade.notional;
  const entryTier = slippageTier(detail.signal && detail.signal.quote24h, model.slippage_tiers);
  const items = {
    fee_entry: check('fee_entry_usdt', trade.fee_entry_usdt, notional * model.taker_fee_rate_each_side, 'MEASURED_RECORDED'),
    fee_exit: check('fee_exit_usdt', trade.fee_exit_usdt, notional * model.taker_fee_rate_each_side, 'MEASURED_RECORDED'),
    slippage_entry: { ...check('slippage_entry_usdt', trade.slippage_entry_usdt, notional * entryTier, 'MEASURED_RECORDED'), tier_rate: entryTier },
    slippage_exit: { ...check('slippage_exit_usdt', trade.slippage_exit_usdt, notional * exit.slippagePerSide, 'RECORDED_TIER_NOT_REDERIVED'), tier_rate: exit.slippagePerSide },
  };
  const settlements = Array.isArray(exit.fundingSettlements) ? exit.fundingSettlements : null;
  if (trade.funding_state === 'MEASURED' && settlements) {
    if (trade.funding_settlements !== settlements.length) {
      throw costError('CRYPTO_M1_COST_MISMATCH', { ...where, item: 'funding_settlements', recorded: trade.funding_settlements, expected: settlements.length });
    }
    const rates = settlements.reduce((sum, event) => sum + event.fundingRate, 0);
    items.funding = { ...check('funding_usdt', trade.funding_usdt, side * rates * notional, 'MEASURED'), settlements: settlements.length };
  } else {
    items.funding = { state: 'MISSING', recorded: null, expected: null, residual: null, settlements: null };
  }
  const gross = trade.liquidation_capped === 1 ? -trade.margin_used : side * (trade.exit_price - trade.entry_price) * trade.quantity;
  items.gross = check('gross_pnl', trade.gross_pnl, gross, trade.liquidation_capped === 1 ? 'RULE_CHECKED_LIQUIDATION_CAP' : 'RULE_CHECKED');
  // 净额以库内列为准（不二次扣）：资金费已测时核对 net = gross − 两边手续费 − 两边滑点 − 资金费；缺失时不核对这一项，净额仍按库内列进账户等式
  items.net = items.funding.state === 'MEASURED'
    ? check('net_pnl', trade.net_pnl,
      trade.gross_pnl - trade.fee_entry_usdt - trade.fee_exit_usdt - trade.slippage_entry_usdt - trade.slippage_exit_usdt - trade.funding_usdt, 'RULE_CHECKED')
    : { state: 'NOT_CHECKED_FUNDING_MISSING', recorded: trade.net_pnl, expected: null, residual: null };
  items.net_r = check('net_r', trade.net_r, trade.net_pnl / model.risk_unit_usdt, 'RULE_CHECKED');
  return items;
}

/** §9.3 USDT 账户等式：起点 + Σ 库内 net_pnl = 终点；终点与证据清单登记的期末值比，残差 ≤ 容差。 */
function accountEquation(trades, model, expectedEnd) {
  if (!trades.every((trade) => finite(trade.net_pnl))) throw costError('CRYPTO_M1_COST_INPUT_INVALID', { item: 'net_pnl' });
  const sum = trades.reduce((total, trade) => total + trade.net_pnl, 0);
  const end = model.initial_capital_usdt + sum;
  if (!finite(expectedEnd) || Math.abs(end - expectedEnd) > model.tolerance_usdt) {
    throw costError('CRYPTO_M1_COST_MISMATCH', { item: 'account_end', recorded: end, expected: finite(expectedEnd) ? expectedEnd : null });
  }
  return { start: model.initial_capital_usdt, sum_net_pnl: sum, end, expected_end: expectedEnd, residual: end - expectedEnd };
}

module.exports = { MODEL_ID: 'CRYPTO_M1_RESEARCH_COST_V1', slippageTier, reconcileTrade, accountEquation };
