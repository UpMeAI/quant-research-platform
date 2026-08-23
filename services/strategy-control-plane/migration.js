'use strict';
/**
 * No Silent Migration(§18 / §16.3 步骤 11 / §22)—— 激活生效时对既有持仓的迁移裁定。
 *
 * 规则:
 *   - 已有 Position 永远保持 originating release,平台**没有**静默迁移权(§4.4);
 *   - 新 Release 只影响其后新 TradePlan(NEW_TRADEPLANS_ONLY);
 *   - 若某个既有持仓在新 Release 下语义会变,唯一合法出口是产出 REPLAN_REQUIRED_V1
 *     —— 一条待人工/研究决策的台账,不是自动动作;
 *   - 拿不到 Runtime 持仓真相时写 MIGRATION_ASSESSMENT_V1 status=UNAVAILABLE,
 *     绝不以「没有持仓」冒充「已确认无需 replan」(fail-closed,§18)。
 */
const path = require('path');
const { dataDir, hash, now, append, read } = require('../../packages/ledger');
const { getAdapter } = require('../../adapters/registry');

const MIGRATION_LEDGER = () => path.join(dataDir('control-plane'), 'migration_assessments.jsonl');

/**
 * 对一次已生效 Activation 做迁移裁定。
 * @param {object} activation ACTIVATION_RECORD_V1(已 ACTIVE)
 * @param {object} release    对应 STRATEGY_RELEASE_V1
 */
function assessMigration(activation, release) {
  const adapter = getAdapter(activation.market);
  const base = {
    activation_ref: activation.activation_id,
    market: activation.market,
    new_release_ref: release.release_id,
    new_bundle_ref: release.immutable_bundle_ref,
    previous_release_ref: activation.previous_release_ref || null,
    migration_policy: 'NEW_TRADEPLANS_ONLY_REPLAN_REQUIRED_FOR_EXISTING',
    assessedAt: now(),
  };

  if (typeof adapter.runtime_positions_readonly !== 'function') {
    return append(MIGRATION_LEDGER(), {
      schema: 'MIGRATION_ASSESSMENT_V1', ...base,
      status: 'UNAVAILABLE', reason: 'ADAPTER_LACKS_POSITIONS_READONLY',
      reasonCn: '该市场 adapter 未提供只读持仓能力 —— 无法裁定既有持仓,不得视为无需 replan',
      replan_required_count: null,
    });
  }

  const res = adapter.runtime_positions_readonly() || {};
  if (res.status !== 'OK' || !Array.isArray(res.positions)) {
    return append(MIGRATION_LEDGER(), {
      schema: 'MIGRATION_ASSESSMENT_V1', ...base,
      status: 'UNAVAILABLE', reason: res.reason || 'RUNTIME_POSITIONS_UNAVAILABLE',
      reasonCn: res.reasonCn || 'Runtime 未返回持仓真相 —— 迁移裁定挂起,既有持仓一律保持原 release',
      replan_required_count: null,
    });
  }

  // 绑定旧 release(或未标注 release)的在持持仓 = 需要显式 replan 决策的对象
  const affected = res.positions.filter((p) => String(p.originating_release_ref || '') !== String(release.release_id));
  for (const p of affected) {
    append(MIGRATION_LEDGER(), {
      schema: 'REPLAN_REQUIRED_V1',
      replan_id: `RPL-${hash({ a: activation.activation_id, p: p.position_id })}`,
      ...base,
      position_ref: p.position_id,
      instrument_id: p.instrument_id || null,
      originating_release_ref: p.originating_release_ref || null,
      quantity: p.quantity ?? null,
      required_action: 'RESEARCH_OR_FOUNDER_DECISION',
      auto_migrated: false,
      noteCn: '既有持仓继续绑定原始 release;是否按新 Release 重做计划需显式决策,平台不自动迁移',
    });
  }
  return append(MIGRATION_LEDGER(), {
    schema: 'MIGRATION_ASSESSMENT_V1', ...base,
    status: 'ASSESSED',
    open_position_count: res.positions.length,
    replan_required_count: affected.length,
    reasonCn: affected.length
      ? `${affected.length} 个既有持仓需显式 replan 决策(已逐条入台账),无一被自动迁移`
      : '无既有持仓需要 replan;新 Release 只影响其后新 TradePlan',
  });
}

function listMigrationRecords(activationRef = null) {
  return read(MIGRATION_LEDGER()).filter((r) => !activationRef || r.activation_ref === activationRef);
}
function listReplanRequired(activationRef = null) {
  return listMigrationRecords(activationRef).filter((r) => r.schema === 'REPLAN_REQUIRED_V1');
}

module.exports = { assessMigration, listMigrationRecords, listReplanRequired, MIGRATION_LEDGER };
