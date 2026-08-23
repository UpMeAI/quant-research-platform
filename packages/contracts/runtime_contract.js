'use strict';
/**
 * Runtime Contract(产品设计 2026-08-22 §13/§13.1)—— 研究平台与执行平台的边界。
 *
 * 边界铁律:
 *   - Research/Control Plane 拥有 Hypothesis/Experiment/Race/Release/Activation;
 *   - Market Runtime 拥有实时行情/Position/Order/Fill/Account,并持有 broker credential;
 *   - 平台**永不**持有 broker/exchange credential;
 *   - Activation 采用 Pull-based:Runtime 主动拉取已批准 Activation,验证 hash/adapter/
 *     execution mode 后加载并回 ACK(§12.2);平台不能绕过 runtime validation;
 *   - MVP 只允许 environment='PAPER'。
 */
const RUNTIME_INTERFACE = Object.freeze([
  'capabilities',            // GET  /runtime/capabilities
  'active_release',          // GET  /runtime/active-release
  'validate_release',        // POST /runtime/validate-release
  'activate_release',        // POST /runtime/activate-release  (MVP: PAPER only)
  'rollback',                // POST /runtime/rollback
  'health',                  // GET  /runtime/health
  'performance_summary',     // GET  /runtime/performance-summary
  'positions_readonly',      // GET  /runtime/positions-readonly
]);

const ENVIRONMENTS = Object.freeze(['PAPER', 'CANARY', 'LIVE']);
const MVP_ALLOWED_ENVIRONMENTS = Object.freeze(['PAPER']); // Live governance 另立决策(§25),MVP 不含

module.exports = { RUNTIME_INTERFACE, ENVIRONMENTS, MVP_ALLOWED_ENVIRONMENTS };
