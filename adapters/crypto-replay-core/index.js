'use strict';
/**
 * 加密 Market Adapter(CRYPTO)—— 由 smartflow replay core 支撑:
 *   C17   → profile NEXT_BAR_OPEN(C17 hooks,含 C17_V2 研究约束);
 *   CARRY → profile HOURLY_REBALANCE_BAND(资金费套利 hooks)。
 *
 * 定位(诚实边界):
 *   - 只做钉版回放:作业载荷是 smartflow 输入构造器(c17Input / carryInput)的参数,hooks 与核心都来自钉住的
 *     smartflow 检出(adapters/replay-core-bridge/pin.json),平台不复制任何 C17 / carry 规则;
 *   - 7×24 无交易日历:日收益按 UTC 日界(核心 DAILY_RETURNS_UTC_CARRIED_V1);
 *   - 只读研究缓存(QRP_REPLAY_CORE_CACHE_CRYPTO),不拉数,不持有任何交易所凭证。
 * 远程 smartflow research-adapter 若经 QRP_ADAPTER_BASE_URL_CRYPTO 接入,注册时以远程适配器为准(registry 按 market_id 覆盖)。
 */
const { createReplayCoreAdapter } = require('../replay-core-bridge/market_adapter');

module.exports = createReplayCoreAdapter({
  market_id: 'CRYPTO',
  adapter_version: 'crypto-replay-core/0.1.0',
  dir: 'adapters/crypto-replay-core',
  strategies: ['C17', 'CARRY'],
  cacheEnv: 'QRP_REPLAY_CORE_CACHE_CRYPTO',
  supported_asset_types: ['USDM_PERP', 'SPOT'],
  trading_calendar_ref: 'CRYPTO_24X7_UTC(无交易日历;business_date 以 UTC 日界切分)',
  cost_model_version: 'REPLAY_CORE_PROFILE_COSTS(费率、滑点档、资金费由输入与 profile 逐项计)',
  trading_rules: {
    session_basis: 'UTC',
    fills: 'NEXT_BAR_OPEN(C17)/ HOURLY_REBALANCE_BAND(CARRY)',
    funding: 'PERIODIC_SETTLEMENT_FROM_INPUT',
    liquidation: 'PROFILE_RULE',
  },
  costBreakdown: (m) => ({
    model: 'REPLAY_CORE_PROFILE_COSTS',
    components: {
      fees: Object.prototype.hasOwnProperty.call(m, 'FEES_PAID_V1') ? { value: m.FEES_PAID_V1, definitionId: 'FEES_PAID_V1', unit: 'USDT' } : 'NOT_REPORTED_BY_PROFILE',
      funding: Object.prototype.hasOwnProperty.call(m, 'FUNDING_NET_V1') ? { value: m.FUNDING_NET_V1, definitionId: 'FUNDING_NET_V1', unit: 'USDT', sign: 'positive = received' } : 'NOT_REPORTED_BY_PROFILE',
      slippage: 'IN_FILL_PRICE(profile 成交价已含滑点)',
      market_impact: 'NOT_MODELLED_MVP',
      fx: 'NOT_APPLICABLE_REPORTED_IN_USDT(绩效按 USDT 汇报,未换算法币)',
      liquidity_constraint: 'NOT_MODELLED_MVP',
    },
    basisCn: '手续费与资金费是逐笔真实现金流;冲击与流动性约束未建模',
  }),
});
