'use strict';
/**
 * Experiment Orchestrator(L2/L3,§9)—— ResearchHypothesis / DatasetSnapshot /
 * ExperimentSpec(预注册冻结)/ Backtest 编排 / Result Lock / NegativeResult。
 * 迁移自 Ashare-V5 services/phase2/experiment_registry,按新设计扩展:
 *   - market + dataset_snapshot_ref 进入冻结域(§8 ExperimentSpec);
 *   - primary_metric/guardrails/failure_condition 定义在 Hypothesis(§8),预注册时复制进
 *     实验冻结域(冻结后不可变);
 *   - 回测经 Market Adapter 合同执行,产物(BacktestArtifact)入台账,含 result_hash。
 *
 * 冻结语义(与源仓一致):
 *   - 运行后想改任何冻结域 = 本实验作废(INVALIDATED),必须开新实验;
 *   - result lock:结果每实验登记一次,再次登记 = 拒绝(防挑最好一次);
 *   - 参数探索必须以预注册网格出现在 parameter_grid,禁止运行后追加。
 */
const path = require('path');
const { dataDir, hash, now, append, read } = require('../../packages/ledger');
const { freeze, verifyFrozen } = require('../../packages/result-lock');
const { getAdapter } = require('../../adapters/registry');

const DIR = () => dataDir('research');
const HYPOTHESES_LEDGER = () => path.join(DIR(), 'hypotheses.jsonl');
const SNAPSHOTS_LEDGER = () => path.join(DIR(), 'dataset_snapshots.jsonl');
const EXPERIMENTS_LEDGER = () => path.join(DIR(), 'experiments.jsonl');
const ARTIFACTS_LEDGER = () => path.join(DIR(), 'backtest_artifacts.jsonl');
const NEGATIVE_LEDGER = () => path.join(DIR(), 'negative_results.jsonl');

/** ExperimentSpec 冻结域(§8;含市场与数据快照绑定)。 */
const FREEZE_FIELDS = Object.freeze([
  'hypothesis_ref', 'market', 'champion_ref', 'challenger_ref',
  'changed_component', 'fixed_components',
  'dataset_snapshot_ref', 'universe', 'regime_scope', 'holding_period',
  'sample', 'costs', 'execution_model',
  'primary_metric', 'secondary_metrics', 'guardrails', 'failure_condition',
  'multiple_test_policy', 'parameter_grid', 'seed',
  'min_forward_evidence',   // §11:Forward minimum evidence 按实验预注册,不全局一刀切
]);

// ── ResearchHypothesis(§8/§9:机制、预期改善、失败条件缺一不可) ─────────────
function registerHypothesis(h = {}) {
  for (const k of ['research_question', 'expected_mechanism', 'failure_condition', 'primary_metric']) {
    if (!h[k]) throw new Error(`HYPOTHESIS_MISSING_FIELD:${k}`);
  }
  if (!Array.isArray(h.guardrails) || !h.guardrails.length) throw new Error('HYPOTHESIS_MISSING_FIELD:guardrails');
  const rec = {
    schema: 'RESEARCH_HYPOTHESIS_V1',
    hypothesis_id: h.hypothesis_id || `HYP-${hash(h)}`,
    research_request_ref: h.research_request_ref || null,
    research_question: h.research_question,
    expected_mechanism: h.expected_mechanism,
    expected_improvement: h.expected_improvement || null,
    primary_metric: h.primary_metric,
    secondary_metrics: h.secondary_metrics || null,
    guardrails: h.guardrails,
    failure_condition: h.failure_condition,
    prior_evidence_refs: h.prior_evidence_refs || [],
    owner: h.owner || 'FOUNDER',
    registeredAt: now(),
  };
  return append(HYPOTHESES_LEDGER(), rec);
}
function hypothesisHead(id) {
  const rows = read(HYPOTHESES_LEDGER()).filter((r) => r.hypothesis_id === id);
  return rows.length ? rows[rows.length - 1] : null;
}
function listHypotheses() { return read(HYPOTHESES_LEDGER()); }

// ── DatasetSnapshot(§8;经 adapter 生成,平台入账) ───────────────────────────
function captureDatasetSnapshot(marketId, request = {}) {
  const snap = getAdapter(marketId).snapshot(request);
  append(SNAPSHOTS_LEDGER(), snap);
  return snap;
}
function snapshotHead(id) {
  const rows = read(SNAPSHOTS_LEDGER()).filter((r) => r.snapshot_id === id);
  return rows.length ? rows[rows.length - 1] : null;
}

// ── ExperimentSpec(预注册 + 冻结) ─────────────────────────────────────────
function preregisterExperiment(spec = {}) {
  for (const k of ['hypothesis_ref', 'market', 'champion_ref', 'challenger_ref', 'changed_component', 'dataset_snapshot_ref']) {
    if (!spec[k]) throw new Error(`EXPERIMENT_MISSING_FIELD:${k}`);
  }
  const hyp = hypothesisHead(spec.hypothesis_ref);
  if (!hyp) throw new Error(`EXPERIMENT_HYPOTHESIS_NOT_FOUND:${spec.hypothesis_ref}`);
  if (!snapshotHead(spec.dataset_snapshot_ref)) throw new Error(`EXPERIMENT_SNAPSHOT_NOT_FOUND:${spec.dataset_snapshot_ref}`);
  getAdapter(spec.market); // 市场必须已注册
  // 预注册指标/守卫/失败条件从 Hypothesis 复制入冻结域(运行前给出,§9)
  const full = {
    ...spec,
    primary_metric: spec.primary_metric || hyp.primary_metric,
    secondary_metrics: spec.secondary_metrics || hyp.secondary_metrics,
    guardrails: spec.guardrails || hyp.guardrails,
    failure_condition: spec.failure_condition || hyp.failure_condition,
  };
  if (!Array.isArray(full.guardrails) || !full.guardrails.length) throw new Error('EXPERIMENT_MISSING_FIELD:guardrails');
  const { frozen, freeze_hash } = freeze(FREEZE_FIELDS, full);
  const rec = {
    schema: 'EXPERIMENT_SPEC_V1',
    experiment_id: spec.experiment_id || `EXP-${hash(frozen)}`,
    ...frozen,
    freeze_hash,
    status: 'PREREGISTERED',
    result_lock_policy: 'SINGLE_RESULT_PER_EXPERIMENT',
    preregistered_at: now(),
  };
  return append(EXPERIMENTS_LEDGER(), rec);
}

function experimentHead(experimentId) {
  const rows = read(EXPERIMENTS_LEDGER()).filter((r) => r.experiment_id === experimentId);
  return rows.length ? rows[rows.length - 1] : null;
}

/** 冻结完整性:重算冻结域 hash 与预注册一致才允许被回测/Race 引用。 */
function verifyFreeze(experimentId) {
  const rows = read(EXPERIMENTS_LEDGER()).filter((r) => r.experiment_id === experimentId);
  if (!rows.length) return { ok: false, reason: 'EXPERIMENT_NOT_FOUND' };
  const first = rows[0];
  if (!verifyFrozen(FREEZE_FIELDS, first)) return { ok: false, reason: 'FREEZE_HASH_MISMATCH' };
  const head = rows[rows.length - 1];
  if (head.status === 'INVALIDATED') return { ok: false, reason: 'EXPERIMENT_INVALIDATED' };
  return { ok: true, spec: first, status: head.status };
}

/** 作废实验(冻结域需要改动时的唯一合法出口;已锁结果 = 历史,不可抹除)。 */
function invalidateExperiment(experimentId, reasonCn) {
  const head = experimentHead(experimentId);
  if (!head) throw new Error('EXPERIMENT_NOT_FOUND');
  if (head.status === 'RESULT_LOCKED') throw new Error('CANNOT_INVALIDATE_LOCKED_RESULT');
  return append(EXPERIMENTS_LEDGER(), { ...head, status: 'INVALIDATED', invalidatedReasonCn: reasonCn || null, invalidatedAt: now() });
}

/**
 * 回测编排:校验冻结 → 经 Market Adapter 执行 → 产物入台账。
 * 同 (experiment, result_hash) 幂等:已有产物直接返回(决定论重放命中)。
 */
function runBacktest(experimentId) {
  const v = verifyFreeze(experimentId);
  if (!v.ok) throw new Error(`BACKTEST_REJECTED:${v.reason}`);
  const spec = { ...v.spec };
  const adapter = getAdapter(spec.market);
  const artifact = adapter.run_backtest(spec);
  const existing = read(ARTIFACTS_LEDGER()).find((r) => r.experiment_ref === experimentId && r.result_hash === artifact.result_hash);
  if (existing) return { ...existing, replayHit: true };
  append(ARTIFACTS_LEDGER(), { ...artifact, experiment_ref: experimentId });
  const head = experimentHead(experimentId);
  if (head.status === 'PREREGISTERED') {
    append(EXPERIMENTS_LEDGER(), { ...head, status: 'BACKTESTED', backtest_artifact_hash: artifact.result_hash, backtestedAt: now() });
  }
  return { ...artifact, experiment_ref: experimentId };
}
function artifactFor(experimentId) {
  const rows = read(ARTIFACTS_LEDGER()).filter((r) => r.experiment_ref === experimentId);
  return rows.length ? rows[rows.length - 1] : null;
}

/** Result lock:每实验只登记一次结果(§18;verdict 必须在枚举内)。 */
function recordResult(experimentId, result = {}) {
  const v = verifyFreeze(experimentId);
  if (!v.ok) throw new Error(`RESULT_REJECTED:${v.reason}`);
  if (v.status === 'RESULT_LOCKED') throw new Error('RESULT_REJECTED:ALREADY_LOCKED');
  if (!result.verdict || !['CHALLENGER_WINS', 'CHAMPION_HOLDS', 'INCONCLUSIVE', 'NEGATIVE_RESULT'].includes(result.verdict)) {
    throw new Error('RESULT_MISSING_VERDICT');
  }
  const head = experimentHead(experimentId);
  return append(EXPERIMENTS_LEDGER(), {
    ...head,
    status: 'RESULT_LOCKED',
    result: {
      verdict: result.verdict,
      primary_metric_value: result.primary_metric_value ?? null,
      champion_value: result.champion_value ?? null,
      challenger_value: result.challenger_value ?? null,
      guardrail_breaches: result.guardrail_breaches || [],
      regime_breakdown: result.regime_breakdown || null,
      sample_evidence_ref: result.sample_evidence_ref || null,
      noteCn: result.noteCn || null,
    },
    result_locked_at: now(),
  });
}

// ── NegativeResult(§8:负结果是资产,归档不丢弃) ───────────────────────────
function archiveNegativeResult(n = {}) {
  for (const k of ['hypothesis_ref', 'failure_reason']) if (!n[k]) throw new Error(`NEGATIVE_MISSING_FIELD:${k}`);
  return append(NEGATIVE_LEDGER(), {
    schema: 'NEGATIVE_RESULT_V1',
    negative_result_id: n.negative_result_id || `NEG-${hash(n)}`,
    hypothesis_ref: n.hypothesis_ref,
    strategy_family: n.strategy_family || null,
    failure_reason: n.failure_reason,
    invalidated_assumption: n.invalidated_assumption || null,
    failed_regimes: n.failed_regimes || null,
    reuse_condition: n.reuse_condition || null,
    evidence_refs: n.evidence_refs || [],
    archived_at: now(),
  });
}
function listNegativeResults() { return read(NEGATIVE_LEDGER()); }

function listExperiments() {
  const m = new Map();
  for (const r of read(EXPERIMENTS_LEDGER())) m.set(r.experiment_id, r);
  return [...m.values()];
}

// ── L3 验证扩展(WFO / Robustness;市场无关编排,经 adapter 逐窗口回测)────────
const wfo = require('./wfo');
const robustness = require('./robustness');
module.exports = {
  FREEZE_FIELDS,
  runWalkForward: wfo.runWalkForward, wfoReportFor: wfo.wfoReportFor, WFO_LEDGER: wfo.WFO_LEDGER,
  runRobustness: robustness.runRobustness, robustnessReportFor: robustness.robustnessReportFor,
  ROBUSTNESS_LEDGER: robustness.ROBUSTNESS_LEDGER,
  registerHypothesis, hypothesisHead, listHypotheses,
  captureDatasetSnapshot, snapshotHead,
  preregisterExperiment, experimentHead, verifyFreeze, invalidateExperiment,
  runBacktest, artifactFor, recordResult,
  archiveNegativeResult, listNegativeResults, listExperiments,
  HYPOTHESES_LEDGER, EXPERIMENTS_LEDGER, SNAPSHOTS_LEDGER, ARTIFACTS_LEDGER, NEGATIVE_LEDGER,
};
