'use strict';
/**
 * replay-core 支撑的 Market Adapter 工厂(§14.1 合同):US_EQUITY 与 CRYPTO 两个适配器共用同一套合同面,
 * 差异(市场、策略、日历、成本逐项)由各自 index.js 声明。
 *
 * 回测 = 在钉住的 smartflow 检出上跑 replay core(./index.js runJob);平台只接收核心输出的规范字节,
 * result_hash 就是这份字节的 sha256。影子观察不在本适配器:生产侧双跑旁路作业由 smartflow 承担,这里显式不支持。
 */
const fs = require('fs');
const path = require('path');
const { hash, now } = require('../../packages/ledger');
const bridge = require('./index');

const EXECUTION_CONTRACT = 'REPLAY_CORE_CONTRACT_V1';

/** 输出里所有 { value, definitionId } 指标,按 definitionId 索引(核心 metrics.js 的口径:空样本为 null,不是 0)。 */
function metricsByDefinition(output) {
  const out = {};
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (typeof v.definitionId === 'string' && Object.prototype.hasOwnProperty.call(v, 'value')) {
      if (!Object.prototype.hasOwnProperty.call(out, v.definitionId)) out[v.definitionId] = v.value;
      return;
    }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(output && output.metrics);
  return out;
}

const metricOrStatus = (m, id) => (Object.prototype.hasOwnProperty.call(m, id) ? m[id] : 'NOT_REPORTED_BY_PROFILE');

function createReplayCoreAdapter(def) {
  const { market_id, adapter_version, strategies, cacheEnv } = def;
  const pinned = Object.fromEntries(strategies.map((s) => [s, bridge.PIN.strategies[s]]));

  const manifest = Object.freeze({
    market_id,
    adapter_version,
    repo_ref: `UpMeAI/quant-research-platform#${def.dir}`,
    commit_hash: null,
    supported_asset_types: def.supported_asset_types,
    capabilities: ['snapshot', 'backtest_replay_core', 'validate_release'],
    trading_calendar_ref: def.trading_calendar_ref,
    data_contract_version: 'REPLAY_CORE_INPUT_V1(QRP_REPLAY_CORE_JOB_V1 作业 + v8 载荷)',
    cost_model_version: def.cost_model_version,
    execution_model_version: `${EXECUTION_CONTRACT}@${bridge.PIN.core.version_hash.slice(0, 8)}:${strategies.map((s) => `${s}/${pinned[s].profile}`).join(',')}`,
    backtest_entrypoint: 'run_backtest',
    shadow_entrypoint: null,
    runtime_binding_endpoint: null,
    health_status: 'HEALTHY',
    compatibility_range: { platform: '>=0.1.0' },
    optional_capabilities: [],
    transport: 'LOCAL_SUBPROCESS_PINNED_SMARTFLOW',
    replay_core: {
      core_version_hash: bridge.PIN.core.version_hash,
      smartflow_commit: bridge.PIN.smartflow.commit,
      strategies: Object.fromEntries(strategies.map((s) => [s, { profile: pinned[s].profile, hooks_id: pinned[s].hooks_id }])),
      source_env: bridge.ROOT_ENV,
      cache_env: cacheEnv,
    },
  });

  function cacheDir(o = {}) {
    const dir = o.cache_dir || process.env[cacheEnv];
    if (!dir) throw new Error(`REPLAY_CORE_CACHE_NOT_CONFIGURED:${cacheEnv}`);
    if (!fs.existsSync(dir)) throw new Error(`REPLAY_CORE_CACHE_MISSING:${cacheEnv}`);
    return path.resolve(dir);
  }

  /** DatasetSnapshot(§8):研究缓存里的作业与载荷校验和(只读,不拉数)。 */
  function snapshot(request = {}) {
    const dir = cacheDir(request);
    const jobs = bridge.listJobs(dir).filter((j) => strategies.includes(j.strategy));
    const checksum = hash(jobs);
    return {
      schema: 'DATASET_SNAPSHOT_V1',
      snapshot_id: `DSS-${hash({ m: market_id, checksum, as_of: request.as_of || null })}`,
      market: market_id,
      as_of: request.as_of || null,
      known_at_policy: 'RECORDED_REPLAY_INPUT(作业载荷即冻结输入,sha256 钉住;适配器不拉数)',
      source_refs: [`${cacheEnv}:${path.basename(dir)}`],
      checksums: { jobs: checksum },
      coverage: { jobs: jobs.length, payload_ok: jobs.filter((j) => j.payload_ok).length, strategies: [...new Set(jobs.map((j) => j.strategy))].sort() },
      freshness: { capturedAt: now() },
      corporate_action_or_funding_refs: null,
      lineage_hash: hash({ checksum, core: bridge.PIN.core.version_hash }),
    };
  }

  /**
   * run_backtest(ExperimentSpec) -> BacktestArtifact。
   * spec.execution_model.replay_core_job = QRP_REPLAY_CORE_JOB_V1;载荷文件相对 execution_model.job_dir(缺省为研究缓存目录)。
   */
  function run_backtest(spec = {}, opts = {}) {
    const em = spec.execution_model || {};
    const job = em.replay_core_job;
    if (!job) throw new Error('BACKTEST_MISSING_REPLAY_CORE_JOB');
    if (!strategies.includes(job.strategy)) throw new Error(`STRATEGY_NOT_IN_MARKET:${market_id}:${job.strategy}`);
    const jobDir = em.job_dir ? path.resolve(em.job_dir) : cacheDir(opts);
    const { receipt, output } = bridge.runJob(job, jobDir, opts);
    return {
      schema: 'BACKTEST_ARTIFACT_V1',
      market: market_id,
      adapter_version,
      experiment_ref: spec.experiment_id || null,
      execution_contract: EXECUTION_CONTRACT,
      replay_core: receipt,
      output,
      result_hash: receipt.output_sha256,
    };
  }

  function run_shadow() {
    throw new Error(`SHADOW_UNSUPPORTED:${market_id}(影子观察由 smartflow 生产侧双跑旁路作业承担;本适配器只做钉版回放)`);
  }

  function validate_release(release) {
    const reasons = [];
    if (!release) return { compatible: false, reasons: ['RELEASE_MISSING'] };
    if (release.market !== market_id) reasons.push(`MARKET_MISMATCH:${release.market}`);
    if (release.adapter_version !== adapter_version) reasons.push(`ADAPTER_VERSION_MISMATCH:${release.adapter_version}!=${adapter_version}`);
    if (!release.code_hash || !release.parameter_hash) reasons.push('RELEASE_HASH_MISSING');
    const ec = release.execution_contract || {};
    if (ec.mode !== EXECUTION_CONTRACT) reasons.push('EXECUTION_CONTRACT_UNSUPPORTED');
    if (ec.core_version_hash !== bridge.PIN.core.version_hash) reasons.push('CORE_VERSION_MISMATCH');
    if (!strategies.includes(ec.strategy)) reasons.push(`STRATEGY_UNSUPPORTED:${ec.strategy}`);
    return { compatible: reasons.length === 0, reasons, checked_by: adapter_version, checkedAt: now() };
  }

  function runtime_capabilities() {
    return {
      runtime_id: null,
      market_id,
      environments_supported: [],
      research_only: true,
      trading_rules: def.trading_rules,
      broker_connection: false,
      real_order: 0,
    };
  }

  /** 原生结果 → CanonicalRaceMetrics 八轴;未建模项显式标注,不以 null / 0 冒充。 */
  function normalize_result(a) {
    const out = a.output;
    const m = metricsByDefinition(out);
    const drawdown = Object.prototype.hasOwnProperty.call(m, 'MAX_DRAWDOWN_MARKS_V1') ? m.MAX_DRAWDOWN_MARKS_V1 : metricOrStatus(m, 'MAX_DRAWDOWN_ADVERSE_V1');
    return {
      absolute: {
        total_return: metricOrStatus(m, 'TOTAL_RETURN_V1'),
        trade_count: metricOrStatus(m, 'TRADE_COUNT_V1'),
        basisCn: 'replay core 输出指标(definitionId 口径,空样本为 null)',
      },
      risk: {
        max_drawdown: drawdown,
        liquidations: metricOrStatus(m, 'LIQUIDATIONS_V1'),
        cvar_status: 'NOT_IMPLEMENTED_MVP',
      },
      relative: {
        status: 'NOT_IMPLEMENTED_MVP',
        reasonCn: 'replay core 输出不含基准序列;相对收益需平台另行对齐基准',
      },
      trading_quality: {
        trade_count: metricOrStatus(m, 'TRADE_COUNT_V1'),
        held_share: metricOrStatus(m, 'HELD_SHARE_V1'),
        fills: Array.isArray(out.fills) ? out.fills.length : 'NOT_REPORTED_BY_PROFILE',
        win_rate_status: 'NOT_IMPLEMENTED_MVP',
      },
      robustness: {
        status: 'NOT_IMPLEMENTED_MVP',
        reasonCn: '单次钉版回放;样本内外与参数扰动由 experiment-orchestrator 逐作业编排',
      },
      operational: {
        deterministic: true,
        replayable: true,
        result_hash: a.result_hash,
        core_version_hash: a.replay_core.core_version_hash,
        hooks_id: a.replay_core.hooks_id,
        input_hash: a.replay_core.input_hash,
        gaps: Array.isArray(out.gaps) ? out.gaps.length : 'NOT_REPORTED_BY_PROFILE',
      },
      capacity: {
        status: 'NOT_IMPLEMENTED_P4',
        reasonCn: '容量模型(流动性、资金区间、冲击假设)属 P4,本适配器不估算',
      },
      cost_breakdown: def.costBreakdown(m),
    };
  }

  return { manifest, snapshot, run_backtest, run_shadow, validate_release, runtime_capabilities, normalize_result };
}

module.exports = { EXECUTION_CONTRACT, createReplayCoreAdapter, metricsByDefinition };
