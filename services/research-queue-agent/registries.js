'use strict';
/**
 * 注册表视图构建器（主机侧，不属于代理运行时）：把机制登记表、因子库和（可选的）冻结的 MINING_SPACE_V1 读数合成验证器用的 registry。
 *   { market, mining_space, mechanisms: [{mechanism_id, layer, decision_point}], readings: { id: {pit_available_at, origin: 'SPACE'|'FACTOR_LIBRARY'} }, holding_periods: [] }
 * 读数只来自两处：该市场冻结空间的读数，与因子库该市场的条目（PIT 可得时刻从登记表抄，不由模型写）。
 */
function buildRegistryView({ market, space = null, spaceFreeze = null, register = null, library = null }) {
  const reg = register || require('../research-mechanism-register').REGISTER;
  const lib = library || require('../../config/research_factor_library.v1.json');
  const PREFIX_LAYER = require('../research-mechanism-register').PREFIX_LAYER;
  const expectedSpaceMarket = market === 'US_EQUITY' ? 'US' : market;
  const membership = space ? require('../mining-sandbox/space').frozenMembership(space, spaceFreeze) : null;
  if (membership && membership.metadata.market !== expectedSpaceMarket) throw new Error(`RQ_REGISTRY_SPACE_MARKET_MISMATCH:${market}:${membership.metadata.market}`);
  const mechanisms = reg.mechanisms.map((m) => ({ mechanism_id: m.mechanism_id, layer: m.layer || PREFIX_LAYER[m.mechanism_id.split('.')[0]], decision_point: m.decision_point }));
  const readings = {};
  for (const f of lib.factors) if (f.market === market && typeof f.pit_available_at === 'string') readings[f.factor_id] = { pit_available_at: f.pit_available_at, origin: 'FACTOR_LIBRARY' };
  if (membership) for (const r of space.readings) if (membership.has(r.name)) readings[r.name] = { pit_available_at: r.pit_available_at, origin: 'SPACE' };
  return { market, mining_space: membership ? membership.metadata : null, mechanisms, readings, holding_periods: space ? [...space.holding_periods] : [] };
}

module.exports = { buildRegistryView };
