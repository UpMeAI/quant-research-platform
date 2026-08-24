'use strict';
/**
 * Observability & Strategy Health(§19)—— 运行观测与衰减监控。
 *
 * 设计约束(逐条对应 §19):
 *   §19.1 Operational Health:adapter 健康 / 数据新鲜度 / 结果决定论 /
 *         runtime active release 与 code hash drift / 卡住的激活 / Shadow 事件滞后与样本缺口;
 *   §19.2 Economic Health:滚动预期、基准超额、回撤等 —— 依赖 Runtime 绩效真相,
 *         平台**只读**;拿不到就 UNAVAILABLE,不用影子虚拟账本冒充实盘/Paper 绩效。
 *
 * 两条硬纪律:
 *   - 不发明阈值:只报机械事实与年龄/缺口,健康裁定仅在**确定性事实**上给出
 *     (如 ACK_REJECTED、hash drift、schema 缺失);
 *   - ACTIVE → DEGRADED 只触发 Research Review,**绝不**自动 economic rollback(§19.2 末条)。
 */
const { getAdapter, listAdapters } = require('../../adapters/registry');
const controlPlane = require('../strategy-control-plane');
const binding = require('../strategy-control-plane/runtime_binding');
const migration = require('../strategy-control-plane/migration');
const experiments = require('../experiment-orchestrator');
const shadow = require('../shadow-control');
const runtimeStatus = require('../runtime-status');

const DAY_MS = 86400000;
const _days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** §19.1 —— 单市场运行健康。 */
async function operationalHealth(marketId, o = {}) {
  const today = o.today || new Date().toISOString().slice(0, 10);
  const adapter = getAdapter(marketId);
  const problems = [];

  // 1) 数据新鲜度:以平台最近一次 DatasetSnapshot 的 as_of 为准(平台自己的观测,不臆造市场日历)
  const snaps = experiments.listExperiments()
    .map((e) => experiments.snapshotHead(e.dataset_snapshot_ref)).filter(Boolean);
  const latest = snaps.sort((a, b) => (a.as_of < b.as_of ? -1 : 1)).pop() || null;
  const dataFreshness = latest
    ? { snapshot_id: latest.snapshot_id, as_of: latest.as_of, age_days: _days(latest.as_of, today), lineage_hash: latest.lineage_hash }
    : { status: 'NO_SNAPSHOT', reasonCn: '平台尚未采集任何 DatasetSnapshot' };

  // 2) Runtime 版本与 hash drift:平台账本认定的生效 Release vs Runtime 自报的生效 Release
  const caps = await runtimeStatus.capabilities(marketId);   // 内含不可达降级
  const runtimeId = caps.runtime_id;
  if (caps.status === 'UNREACHABLE') {
    return {
      market: marketId, runtime_id: null, business_date: today,
      adapter: { adapter_version: adapter.manifest.adapter_version, health_status: 'UNREACHABLE', demo_only: adapter.manifest.demo_only === true },
      data_freshness: dataFreshness,
      problems: [`ADAPTER_UNREACHABLE:${caps.reason}`],
      verdict: 'ATTENTION_REQUIRED',
      verdictCn: '市场适配器不可达 —— 该市场的运行事实无法核验(其他市场不受影响)',
    };
  }
  const platformActive = controlPlane.activeReleaseIdFor(runtimeId);
  const reported = await runtimeStatus.activeRelease(marketId);
  let releaseDrift;
  if (reported && reported.status === 'UNSUPPORTED') {
    releaseDrift = { status: 'UNVERIFIABLE', platform_active_release: platformActive, reasonCn: 'adapter 未提供只读生效版本 —— 无法核对漂移' };
  } else {
    const runtimeActive = reported?.active_release ?? null;
    const expected = platformActive ? controlPlane.releaseHead(platformActive) : null;
    const hashDrift = expected && reported?.release_hash != null && reported.release_hash !== expected.release_hash;
    const idDrift = platformActive !== runtimeActive;
    if (idDrift) problems.push(`RELEASE_ID_DRIFT:platform=${platformActive}|runtime=${runtimeActive}`);
    if (hashDrift) problems.push(`RELEASE_HASH_DRIFT:${reported.release_hash}!=${expected.release_hash}`);
    releaseDrift = {
      status: idDrift || hashDrift ? 'DRIFT' : 'IN_SYNC',
      platform_active_release: platformActive, runtime_active_release: runtimeActive,
      integrity: platformActive ? controlPlane.verifyReleaseIntegrity(platformActive) : null,
    };
  }

  // 3) 激活队列:被拒的是确定性故障;待拉取的只报年龄,不判"卡住"(阈值属运营策略,不由平台发明)
  const acts = controlPlane.listActivations().filter((r) => r.schema === 'ACTIVATION_RECORD_V1' && r.market === marketId);
  const heads = new Map();
  for (const a of acts) heads.set(a.activation_id, a);
  const all = [...heads.values()];
  const rejected = all.filter((a) => ['ACK_REJECTED', 'RUNTIME_REJECTED'].includes(a.activation_status));
  const pending = binding.runtimePendingActivations(runtimeId, { today });
  if (rejected.length) problems.push(`ACTIVATION_REJECTED:${rejected.length}`);

  // 4) Shadow:事件滞后与样本缺口 / 运行故障类停止
  const runs = shadow.listShadowRuns().filter((s) => s.market === marketId);
  const shadowHealth = [];
  for (const s of runs) {
    const health = shadow.operationalHealth(s.shadow_id);
    const obs = shadow.listObservations(s.shadow_id);
    const lastDate = obs.map((r) => r.business_date).sort().pop() || null;
    /* eslint-disable no-await-in-loop */
    const suff = await shadow.sufficiency(s.shadow_id);
    /* eslint-enable no-await-in-loop */
    if (s.halted_failure_class === 'OPERATIONAL') problems.push(`SHADOW_HALTED_OPERATIONAL:${s.shadow_id}:${s.halted_reason}`);
    if (health.data_quality_issue_count) problems.push(`SHADOW_DATA_QUALITY:${s.shadow_id}:${health.data_quality_issue_count}`);
    shadowHealth.push({
      shadow_id: s.shadow_id, status: s.status,
      last_observation_date: lastDate,
      event_lag_days: lastDate ? _days(lastDate, today) : null,
      sample: { observed: suff.forward_sample_count, required: suff.min_required, claim_status: suff.claim_status },
      data_quality_issue_count: health.data_quality_issue_count,
      unclassified_disagreement_count: health.unclassified_disagreement_count,
      halted_failure_class: s.halted_failure_class,
    });
  }

  // 5) No Silent Migration 未决项:UNAVAILABLE 与未处置的 REPLAN_REQUIRED 都是运营待办
  const migRecords = migration.listMigrationRecords().filter((r) => r.market === marketId);
  const unavailable = migRecords.filter((r) => r.schema === 'MIGRATION_ASSESSMENT_V1' && r.status === 'UNAVAILABLE').length;
  const replan = migRecords.filter((r) => r.schema === 'REPLAN_REQUIRED_V1').length;

  return {
    market: marketId, runtime_id: runtimeId, business_date: today,
    adapter: {
      adapter_version: adapter.manifest.adapter_version,
      health_status: adapter.manifest.health_status,
      demo_only: adapter.manifest.demo_only === true,
    },
    data_freshness: dataFreshness,
    release_drift: releaseDrift,
    activations: {
      pending_pull: pending.map((a) => ({ activation_id: a.activation_id, effective_from: a.effective_from, waiting_days: _days(a.effective_from, today) })),
      rejected: rejected.map((a) => ({ activation_id: a.activation_id, status: a.activation_status, reasonCn: a.reject_reasonCn || null })),
    },
    shadow: shadowHealth,
    migration_open_items: { unavailable_assessments: unavailable, replan_required: replan },
    determinism: { result_lock_policy: 'SINGLE_RESULT_PER_EXPERIMENT', ledger_contract_enforced_on_write: true },
    problems,
    verdict: problems.length ? 'ATTENTION_REQUIRED' : 'NO_DETERMINISTIC_PROBLEM_DETECTED',
    verdictCn: problems.length
      ? '存在确定性运行问题(见 problems);平台只报事实,不自动处置'
      : '未检出确定性运行问题;这不等于"策略有效"(经济有效性见 economicHealth)',
  };
}

/** §19.2 —— 经济健康(只读 Runtime 真相;拿不到就 UNAVAILABLE)。 */
async function economicHealth(marketId) {
  const perf = await runtimeStatus.performanceSummary(marketId);
  const available = perf && perf.status !== 'UNSUPPORTED' && perf.status !== 'UNAVAILABLE' && perf.status !== 'ERROR';

  // 影子虚拟账本**不是**经济绩效:单列并显式标注,禁止被当成 Runtime 真相
  const shadowVirtual = shadow.listShadowRuns()
    .filter((s) => s.market === marketId)
    .map((s) => ({ shadow_id: s.shadow_id, ...shadow.forwardMetrics(s.shadow_id) }));

  return {
    market: marketId,
    runtime_performance: available
      ? perf
      : {
        status: 'UNAVAILABLE',
        reason: perf?.reason || 'RUNTIME_PERFORMANCE_NOT_EXPOSED',
        reasonCn: 'Runtime 未提供绩效真相 —— 平台不以影子虚拟账本或回测结果冒充经济健康',
      },
    rolling_expectancy: { status: 'UNAVAILABLE_WITHOUT_RUNTIME_TRUTH' },
    benchmark_excess: { status: 'UNAVAILABLE_WITHOUT_RUNTIME_TRUTH' },
    drawdown: { status: 'UNAVAILABLE_WITHOUT_RUNTIME_TRUTH' },
    regime_decay: { status: 'NOT_IMPLEMENTED_P4', reasonCn: 'Decay Monitor 属 §21 P4 Strategy Factory' },
    capacity_usage: { status: 'NOT_IMPLEMENTED_P4' },
    shadow_virtual_ledger: shadowVirtual,
    shadow_virtual_ledgerCn: '影子虚拟净值仅供对比观察,不构成任何真实成交或经济有效性主张',
    auto_rollback_policy: 'NEVER',
    auto_rollback_policyCn: 'ACTIVE → DEGRADED 只触发 Research Review;绝不按短期 PnL 自动经济回滚(§19.2)',
  };
}

/** 全市场聚合(§17 Runtime Status 页与运营巡检共用)。 */
async function healthReport(o = {}) {
  const markets = listAdapters().map((m) => m.market_id);
  const out = [];
  for (const m of markets) {
    /* eslint-disable no-await-in-loop */
    out.push({ market: m, operational: await operationalHealth(m, o), economic: await economicHealth(m) });
    /* eslint-enable no-await-in-loop */
  }
  return { generatedAt: new Date().toISOString(), markets: out };
}

module.exports = { operationalHealth, economicHealth, healthReport };
