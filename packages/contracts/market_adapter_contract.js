'use strict';
/**
 * MarketAdapter Contract(产品设计 2026-08-22 §14.1)。
 *
 * 共享的是研究协议和结果格式,不共享市场微观结构。每个市场仓库实现本合同,
 * 平台核心只经合同调用市场能力;新市场 = 新适配器,零平台核心改动。
 *
 * 调用约定(审计修复:生产适配器不可能是同步的):
 *   合同函数**可同步可异步**。市场侧真实实现要读 PG / 走 REST / 起 CLI job(§25 传输层),
 *   必然返回 Promise;平台核心一律 `await` 适配器返回值,同步实现 await 后语义不变。
 *   平台**禁止**把适配器返回值直接入账 —— 曾因此把 Promise 当快照写成 `{}`(静默污染)。
 *
 * 必须实现(§14.1 六函数,名称即契约):
 *   manifest                                  —— MarketAdapterManifest(§8)
 *   snapshot(request) -> DatasetSnapshot
 *   run_backtest(experimentSpec, opts) -> BacktestArtifact
 *   run_shadow(shadowSpec, evalDate) -> ShadowArtifact
 *   validate_release(strategyRelease) -> CompatibilityResult { compatible, reasons[] }
 *   runtime_capabilities() -> RuntimeCapability
 *   normalize_result(nativeResult) -> CanonicalRaceMetrics
 *
 * 可选能力(声明即可用,未实现则平台侧显式标 UNSUPPORTED,不静默假装):
 *   regime_labels(spec) -> { [date]: REGIME }            —— 供 Race regime_breakdown(§10)
 *   runtime_active_release / runtime_positions_readonly /
 *   runtime_performance_summary / runtime_health          —— §13.1 只读回读面
 */
const MANIFEST_FIELDS = Object.freeze([
  'market_id', 'adapter_version', 'repo_ref', 'supported_asset_types', 'capabilities',
  'trading_calendar_ref', 'data_contract_version', 'cost_model_version', 'execution_model_version',
]);
const ADAPTER_FNS = Object.freeze([
  'snapshot', 'run_backtest', 'run_shadow', 'validate_release',
  'runtime_capabilities', 'normalize_result',
]);

/** §13.1 只读回读面 + §10 regime 标注:可选实现,平台按存在与否降级。 */
const OPTIONAL_ADAPTER_FNS = Object.freeze([
  'regime_labels',
  'runtime_active_release', 'runtime_positions_readonly',
  'runtime_performance_summary', 'runtime_health',
]);

function validateAdapter(adapter) {
  const problems = [];
  if (!adapter || typeof adapter !== 'object') return { ok: false, problems: ['ADAPTER_NOT_OBJECT'] };
  const m = adapter.manifest;
  if (!m) problems.push('MISSING_MANIFEST');
  else for (const f of MANIFEST_FIELDS) if (m[f] === undefined || m[f] === null) problems.push(`MANIFEST_MISSING:${f}`);
  for (const f of ADAPTER_FNS) if (typeof adapter[f] !== 'function') problems.push(`ADAPTER_MISSING_FN:${f}`);
  const optional_present = OPTIONAL_ADAPTER_FNS.filter((f) => typeof adapter[f] === 'function');
  return { ok: problems.length === 0, problems, optional_present };
}

module.exports = { MANIFEST_FIELDS, ADAPTER_FNS, OPTIONAL_ADAPTER_FNS, validateAdapter };
