'use strict';
/** 共享夹具:种样本数据 + 注册 Champion/Challenger + 假设 + 快照 + 预注册实验。 */
const pit = require('../adapters/ashare-local/pit_store');
const { generateSampleBars } = require('../adapters/ashare-local/sample_data');
const { CHAMPION_VARIANT } = require('../adapters/ashare-local/strategy_vpq');
const { getAdapter } = require('../adapters/registry');
const registry = require('../services/strategy-registry');
const experiments = require('../services/experiment-orchestrator');

const CHALLENGER_VARIANT = { key: 'CHALLENGER_QUANTILE', type: 'QUANTILE', qHi: 0.8, qLo: 0.1 };

function seedData() {
  if (pit.coverage().barCount === 0) {
    pit.ingestBars(generateSampleBars({ stockCount: 8 }).bars, { source: 'SAMPLE_SYNTHETIC' });
  }
}

/** 注册 Champion/Challenger,返回 bundle 引用。 */
function setupBundles() {
  seedData();
  const adapter = getAdapter('CN_A');
  const cm = registry.registerModule({
    module_id: 'MOD-T-FIXED', market: 'CN_A', module_type: 'TIMING',
    code_ref: 'adapters/ashare-local/strategy_vpq.js#FIXED', parameters: CHAMPION_VARIANT, status: 'ACTIVE',
  });
  const champ = registry.registerChampionBundle({
    market: 'CN_A', bundle_id: 'BND-T-CHAMPION',
    module_refs: [`${cm.record.module_id}#v${cm.record.version}`],
    market_adapter_version: adapter.ADAPTER_VERSION,
  });
  const hm = registry.registerModule({
    module_id: 'MOD-T-QUANTILE', market: 'CN_A', module_type: 'TIMING',
    code_ref: 'adapters/ashare-local/strategy_vpq.js#QUANTILE', parameters: CHALLENGER_VARIANT,
  });
  const chal = registry.registerBundle({
    bundle_id: 'BND-T-QUANTILE', market: 'CN_A',
    module_refs: [`${hm.record.module_id}#v${hm.record.version}`],
    market_adapter_version: adapter.ADAPTER_VERSION,
  });
  return {
    adapter,
    champRef: `${champ.record.bundle_id}#v${champ.record.bundle_version}`,
    chalBundle: chal.record,
    chalRef: `${chal.record.bundle_id}#v${chal.record.bundle_version}`,
  };
}

/** 完整预注册实验(冻结),返回 {expId, ...bundles, oosStart}。 */
function setupExperiment(overrides = {}) {
  const b = setupBundles();
  const hyp = experiments.registerHypothesis({
    research_question: 'Q80/Q10 分位判据 vs 固定阈值', expected_mechanism: '按标的自身量能分布自适应',
    failure_condition: 'OOS good_precision 不高于 Champion 或守卫违约',
    primary_metric: 'good_precision',
    guardrails: [
      { id: 'G1', rule: 'NOT_WORSE_THAN_CHAMPION_BY', metric: 'bad_precision', value: 0.10 },
      { id: 'G2', rule: 'AT_LEAST_FRACTION_OF_CHAMPION', metric: 'good_count', value: 0.5 },
    ],
  });
  const snap = experiments.captureDatasetSnapshot('CN_A');
  const anyBars = pit.loadUniverseBars({ cap: 1 }).byInst.values().next().value;
  const oosStart = anyBars[Math.floor(anyBars.length * 0.7)].d;
  const exp = experiments.preregisterExperiment({
    experiment_id: overrides.experiment_id || `EXP-T-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hypothesis_ref: hyp.hypothesis_id, market: 'CN_A',
    champion_ref: b.champRef, challenger_ref: b.chalRef,
    changed_component: 'TIMING.volume_threshold_rule',
    dataset_snapshot_ref: snap.snapshot_id,
    universe: { skip: 0, stride: 1, cap: 8 },
    sample: { is_end: oosStart, oos_start: oosStart, adjudication_segment: 'OOS' },
    costs: { cost_per_side: 0.001 },
    execution_model: { champion_variant: CHAMPION_VARIANT, challenger_variant: CHALLENGER_VARIANT },
    seed: 20260823, min_forward_evidence: overrides.min_forward_evidence ?? 5,
    ...overrides.spec,
  });
  return { ...b, hyp, snap, exp, oosStart };
}

module.exports = { CHALLENGER_VARIANT, seedData, setupBundles, setupExperiment };
