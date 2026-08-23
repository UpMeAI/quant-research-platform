'use strict';
/**
 * MarketAdapter Contract(产品设计 2026-08-22 §14.1)。
 *
 * 共享的是研究协议和结果格式,不共享市场微观结构。每个市场仓库实现本合同,
 * 平台核心只经合同调用市场能力;新市场 = 新适配器,零平台核心改动。
 *
 * 必须实现:
 *   manifest                                  —— MarketAdapterManifest(§8)
 *   snapshot(request) -> DatasetSnapshot
 *   run_backtest(experimentSpec, opts) -> BacktestArtifact
 *   run_shadow_observation(shadowSpec, evalDate) -> { key, champion_output, challenger_output, ... }
 *   validate_release(strategyRelease) -> CompatibilityResult { compatible, reasons[] }
 *   runtime_capabilities() -> RuntimeCapability
 *   normalize_result(nativeResult) -> CanonicalRaceMetrics
 */
const MANIFEST_FIELDS = Object.freeze([
  'market_id', 'adapter_version', 'repo_ref', 'supported_asset_types', 'capabilities',
  'trading_calendar_ref', 'data_contract_version', 'cost_model_version', 'execution_model_version',
]);
const ADAPTER_FNS = Object.freeze([
  'snapshot', 'run_backtest', 'run_shadow_observation', 'validate_release',
  'runtime_capabilities', 'normalize_result',
]);

function validateAdapter(adapter) {
  const problems = [];
  if (!adapter || typeof adapter !== 'object') return { ok: false, problems: ['ADAPTER_NOT_OBJECT'] };
  const m = adapter.manifest;
  if (!m) problems.push('MISSING_MANIFEST');
  else for (const f of MANIFEST_FIELDS) if (m[f] === undefined || m[f] === null) problems.push(`MANIFEST_MISSING:${f}`);
  for (const f of ADAPTER_FNS) if (typeof adapter[f] !== 'function') problems.push(`ADAPTER_MISSING_FN:${f}`);
  return { ok: problems.length === 0, problems };
}

module.exports = { MANIFEST_FIELDS, ADAPTER_FNS, validateAdapter };
