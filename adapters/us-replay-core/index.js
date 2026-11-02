'use strict';
/**
 * 美股 Market Adapter(US_EQUITY)—— 由 smartflow replay core 支撑(profile CLOSE_MARK,US_V5 退出规则 hooks)。
 *
 * 定位(诚实边界):
 *   - 只做钉版回放:作业载荷是 REPLAY_CORE_INPUT_V1(去掉 hooks),hooks 与核心都来自钉住的 smartflow 检出
 *     (adapters/replay-core-bridge/pin.json),平台不复制任何 US_V5 规则;
 *   - 覆盖 US_V5 的机械切片(逐 tick 退出、腿记账、权益标记);扫描与入场决策仍在 smartflow us-v5-decision;
 *   - 只读研究缓存(QRP_REPLAY_CORE_CACHE_US_EQUITY),不拉数,不持有任何 broker 凭证。
 * 远程 smartflow research-adapter 若经 QRP_ADAPTER_BASE_URL_US_EQUITY 接入,注册时以远程适配器为准(registry 按 market_id 覆盖)。
 */
const { createReplayCoreAdapter } = require('../replay-core-bridge/market_adapter');

module.exports = createReplayCoreAdapter({
  market_id: 'US_EQUITY',
  adapter_version: 'us-replay-core/0.1.0',
  dir: 'adapters/us-replay-core',
  strategies: ['US_V5'],
  cacheEnv: 'QRP_REPLAY_CORE_CACHE_US_EQUITY',
  supported_asset_types: ['ETF', 'STOCK'],
  trading_calendar_ref: 'US_ET_SESSIONS(输入自带的 ET 交易时段;节假日与半日市以记录的扫描时段为准)',
  cost_model_version: 'REPLAY_CORE_COSTS_NONE(CLOSE_MARK:按记录 tick 价退出,不另计费用)',
  trading_rules: {
    session_basis: 'America/New_York',
    exits: 'CLOSE_MARK 档:记录 tick 上先判触价止损(AT_LEVEL_STOP_FIRST)',
    short_selling: 'AS_RECORDED_IN_INPUT',
    account_constraints: 'NOT_MODELLED_REPLAY',
  },
  costBreakdown: () => ({
    model: 'REPLAY_CORE_COSTS_NONE',
    components: {
      commission: 'NOT_MODELLED_CLOSE_MARK',
      slippage: 'NOT_MODELLED_CLOSE_MARK(按记录 tick 价成交)',
      market_impact: 'NOT_MODELLED_MVP',
      borrow_fee: 'NOT_MODELLED_CLOSE_MARK',
      funding: 'NOT_APPLICABLE_CASH_EQUITY',
      fx: 'NOT_APPLICABLE_USD_ONLY',
      liquidity_constraint: 'NOT_MODELLED_MVP',
    },
    basisCn: 'CLOSE_MARK 档不计费用;收益是毛收益 —— 不得按“已计成本”解读',
  }),
});
