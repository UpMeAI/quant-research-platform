'use strict';
/**
 * 域对象 Schema 目录(§8 Domain Model 的机器可校验形式)。
 *
 * 只声明**必填字段与类型**(产品级 Contract),不约束可选扩展字段:
 * 台账是 append-only 的,后续版本可加字段,但必填域不可缺、不可改类型。
 * 类型记号:s=string, n=number, b=boolean, a=array, o=object, *=任意非 undefined,
 *          s? 等后缀 ? 表示允许 null(缺失事实必须显式 null,而不是省略)。
 */
const SCHEMAS = Object.freeze({
  MARKET_ADAPTER_MANIFEST: {
    _doc: '§8 MarketAdapterManifest —— 市场适配器身份与能力声明',
    market_id: 's', adapter_version: 's', repo_ref: 's', commit_hash: 's?',
    supported_asset_types: 'a', capabilities: 'a', trading_calendar_ref: 's',
    data_contract_version: 's', cost_model_version: 's', execution_model_version: 's',
    backtest_entrypoint: 's', shadow_entrypoint: 's', runtime_binding_endpoint: 's',
    health_status: 's', compatibility_range: 'o',
  },
  STRATEGY_FAMILY_V1: {
    _doc: '§8 StrategyFamily —— 策略族(active/retired 版本由 Bundle 台账派生)',
    family_id: 's', market_scope: 'a', economic_mechanism: 's', strategy_goal: 's',
    owner: 's', lifecycle_status: 's', capacity_profile: 'o?', supported_regimes: 'a?',
  },
  STRATEGY_MODULE_VERSION_V1: {
    _doc: '§8 StrategyModuleVersion —— 不可变模块版本',
    module_id: 's', family_id: 's?', market: 's', module_type: 's', version: 'n',
    code_ref: 's', code_hash: 's', parameter_hash: 's', hash: 's', status: 's',
    input_contract: 'o?', output_contract: 'o?', universe_ref: 's?', holding_period: 'o?',
    supported_regimes: 'a?', failure_conditions: '*', data_requirements: '*',
    cost_assumptions: '*', test_evidence: '*', registeredAt: 's',
  },
  STRATEGY_BUNDLE_MANIFEST_V1: {
    _doc: '§8 StrategyBundleManifest —— 六态 Bundle(ACTIVE 只能经 Activation 进入)',
    bundle_id: 's', bundle_version: 'n', bundle_hash: 's', market: 's', module_refs: 'a',
    market_adapter_version: 's?', risk_constitution_ref: 's?', status: 's',
    effective_from: 's?', rollback_bundle_ref: 's?', approved_by: 's?', registeredAt: 's',
  },
  RESEARCH_HYPOTHESIS_V1: {
    _doc: '§8 ResearchHypothesis —— 机制/失败条件/主指标/守卫缺一不可',
    hypothesis_id: 's', research_question: 's', expected_mechanism: 's',
    primary_metric: 's', guardrails: 'a', failure_condition: 's',
    secondary_metrics: 'a?', prior_evidence_refs: 'a', owner: 's', registeredAt: 's',
  },
  DATASET_SNAPSHOT_V1: {
    _doc: '§8 DatasetSnapshot —— PIT 可重放数据快照',
    snapshot_id: 's', market: 's', as_of: 's', known_at_policy: 's',
    source_refs: 'a', checksums: 'o', coverage: 'o', freshness: 'o',
    corporate_action_or_funding_refs: '*', lineage_hash: 's',
  },
  EXPERIMENT_SPEC_V1: {
    _doc: '§8 ExperimentSpec —— 预注册冻结域 + freeze_hash + 单结果锁',
    experiment_id: 's', hypothesis_ref: 's', market: 's', champion_ref: 's', challenger_ref: 's',
    changed_component: 's', fixed_components: 'a?', dataset_snapshot_ref: 's',
    universe: 'o', regime_scope: '*', holding_period: 'o?', sample: 'o', costs: 'o',
    execution_model: 'o', signal_action_contract: 'o', drawdown_policy: 'o', primary_metric: 's', secondary_metrics: 'a?', guardrails: 'a',
    failure_condition: 's', multiple_test_policy: 's?', parameter_grid: 'a?', seed: 'n?',
    // §11:数字 = 全局最低样本;对象 { default, by_regime } = 按 Regime 分别预注册
    min_forward_evidence: '*', freeze_hash: 's', status: 's',
    result_lock_policy: 's', preregistered_at: 's',
  },
  BACKTEST_ARTIFACT_V1: {
    _doc: '§8/§14.1 BacktestArtifact —— 决定论回测产物(result_hash 为 Result Lock 依据)',
    market: 's', adapter_version: 's', universe: 'o', benchmark: 's', dates: 'a',
    nav: 'o', summary: 'o', precision: 'o', oos_start: 's', result_hash: 's', ranAt: 's',
  },
  WFO_REPORT_V1: {
    _doc: '§9 Sample.WFO —— 滚动训练选参 / 测试段评估',
    experiment_ref: 's', market: 's', primary_metric: 's', config: 'o', parameter_grid: 'a',
    folds: 'a', fold_count: 'n', evaluated_fold_count: 'n',
    challenger_win_fraction: 'n?', report_hash: 's', ranAt: 's',
  },
  ROBUSTNESS_REPORT_V1: {
    _doc: '§9 Robustness —— 参数扰动/子样本/时间相位/执行压力/数据源',
    experiment_ref: 's', market: 's', primary_metric: 's', baseline: 'o', dimensions: 'o',
    trial_count: 'n', decidable_trial_count: 'n', challenger_better_fraction: 'n?',
    report_hash: 's', ranAt: 's',
  },
  RACE_RUN_V1: {
    _doc: '§10 Race —— 受控变量声明 + paired sample',
    race_id: 's', race_type: 's', market: 's', experiment_ref: 's',
    experiment_freeze_hash: 's', champion_ref: 's', challenger_ref: 's',
    changed_component: 's', control_declaration: 'o', status: 's', openedAt: 's',
  },
  PAIRED_SAMPLE_SET_V1: {
    _doc: '§10 paired sample 原始行(可回溯,regime 分解与审计消费)',
    race_id: 's', experiment_ref: 's', paired_sample_hash: 's', sample_count: 'n',
    samples: 'a', recordedAt: 's',
  },
  RACE_RESULT_V1: {
    _doc: '§8 RaceResult —— 结论 + 七轴 canonical + regime 分解 + result_hash',
    race_id: 's', experiment_ref: 's', paired_sample_ref: 's', conclusion: 's',
    primary_metric: 's', champion_value: 'n?', challenger_value: 'n?',
    guardrail_result: 'a', canonical_metrics: 'o', cost_breakdown: 'o?', regime_breakdown: 'o?',
    reason_codes: 'a', result_hash: 's',
  },
  SHADOW_RUN_V1: {
    _doc: '§8 ShadowRun —— 同 PIT 影子 + Virtual Ledger + 前向最低样本',
    shadow_id: 's', market: 's', experiment_ref: 's', champion_release_ref: 's',
    challenger_release_ref: 's', race_ref: 's', virtual_ledger_ref: 's',
    market_event_stream_ref: 's', min_forward_evidence: '*', min_forward_evidence_default: 'n', status: 's',
    halted_reason: 's?', halted_failure_class: 's?', start_at: 's', end_at: 's?', openedAt: 's',
  },
  SHADOW_OBSERVATION_V1: {
    _doc: '§11 disagreement 台账(input refs / reason codes / 版本 / 数据质量 / outcome)',
    shadow_id: 's', key: 's', business_date: 's', agree: 'b',
    champion_output: '*', challenger_output: '*', reason_codes: 'a', input_refs: 'a',
    versions: 'o', data_quality: 's', outcome: '*', recordedAt: 's',
  },
  SHADOW_VIRTUAL_LEDGER_V1: {
    _doc: '§11 Virtual Ledger —— 只虚拟记账,零 Runtime 影响',
    virtual_ledger_ref: 's', shadow_id: 's', business_date: 's',
    challenger_signals: '*', champion_signals: '*',
    challenger_forward: 'o?', champion_forward: 'o?', recordedAt: 's',
  },
  PROMOTION_CANDIDATE_V1: {
    _doc: '§8 PromotionCandidate —— 研究/影子双 Gate + 兼容性 + 回滚锚',
    candidate_id: 's', market: 's', release_candidate_ref: 's', experiment_ref: 's',
    research_evidence_refs: 'a', shadow_forward_refs: 'a', compatibility_result: 'o?',
    risk_impact: '*', unresolved_gaps: 'a', migration_policy: 's',
    effective_from_candidate: 's?', rollback_ref: 's', review_status: 's', createdAt: 's',
  },
  STRATEGY_RELEASE_V1: {
    _doc: '§8 StrategyRelease —— 不可变发布对象(release_hash 为内容哈希)',
    release_id: 's', market: 's', immutable_bundle_ref: 's', bundle_hash: 's',
    code_hash: 's', parameter_hash: 's', adapter_version: 's', universe_contract: 'o',
    signal_contract: 'o', risk_contract: 'o', execution_contract: 'o',
    cost_model_ref: 's', target_runtime_class: 's', candidate_ref: 's',
    release_hash: 's', created_at: 's',
  },
  ACTIVATION_RECORD_V1: {
    _doc: '§8 ActivationRecord —— PAPER only / 未来生效 / Runtime 拉取验哈希后才 ACTIVE',
    activation_id: 's', target_runtime_id: 's', release_id: 's', release_hash: 's',
    market: 's', environment: 's', effective_from: 's', canary_scope: '*',
    previous_release_ref: 's?', approved_by: 's', runtime_ack: 's?',
    activation_status: 's', rollback_status: 's?', requestedAt: 's',
  },
  RUNTIME_ACK_V1: {
    _doc: '§12.2 Runtime 回执(hash 校验结果必须显式)',
    ack_id: 's', activation_ref: 's', runtime_id: 's', environment: 's',
    verified_release_hash: 's', expected_release_hash: 's', hash_verified: 'b',
    health_check: 'o?', health_verified: 'b', health_problems: 'a', ackedAt: 's',
  },
  RUNTIME_NACK_V1: {
    _doc: '§12.2 Runtime 显式拒绝(健康/本地校验失败;不自动重试,等人工处置)',
    ack_id: 's', activation_ref: 's', runtime_id: 's', reasonCn: 's', nackedAt: 's',
  },
  SHADOW_ARTIFACT_V1: {
    _doc: '§14.1 adapter.run_shadow 产物 —— 同 PIT cutoff 的双边观察(入账前由平台归一)',
    key: 's', business_date: 's', champion_output: '*', challenger_output: '*',
    input_refs: 'a', data_quality: 's',
  },
  ROLLBACK_RECORD_V1: {
    _doc: '§12.3 Operational rollback(直接切回 last-known-good)',
    rollback_id: 's', activation_ref: 's', type: 's', restored_release_ref: 's?',
    approved_by: 's', rolledBackAt: 's',
  },
  ROLLBACK_REVIEW_TRIGGER_V1: {
    _doc: '§12.3 Economic rollback —— 只触发研究复核,不自动执行',
    activation_ref: 's', type: 's', status: 's', triggeredAt: 's',
  },
  MIGRATION_ASSESSMENT_V1: {
    _doc: '§18 No Silent Migration —— 迁移裁定(拿不到持仓真相必须 UNAVAILABLE)',
    activation_ref: 's', market: 's', new_release_ref: 's', migration_policy: 's',
    status: 's', replan_required_count: 'n?', assessedAt: 's',
  },
  REPLAN_REQUIRED_V1: {
    _doc: '§16.3-11 既有持仓需显式重做计划(绝不自动迁移)',
    replan_id: 's', activation_ref: 's', position_ref: 's', originating_release_ref: 's?',
    new_release_ref: 's', required_action: 's', auto_migrated: 'b', assessedAt: 's',
  },
  FACTOR_DEFINITION_V1: {
    _doc: '§9.1 FactorDefinition —— 因子定义(只提供统计信息,无生产动作权)',
    factor_id: 's', market: 's', version: 'n', definition: 'o', economic_rationale: 's',
    direction: 's', horizons: 'a', universe_ref: 's?', data_requirements: '*',
    factor_hash: 's', production_action_authority: 's', owner: 's', registeredAt: 's',
  },
  FACTOR_EVALUATION_V1: {
    _doc: '§9.1 Factor 层基础指标 —— IC / Rank IC / 衰减 / 覆盖(不含通过阈值)',
    factor_ref: 's', factor_hash: 's', market: 's', dataset_snapshot_ref: 's?',
    horizons: 'a', by_horizon: 'o', sample_count: 'n', coverage: 'o', decay: 'o',
    stability: '*', correlation_to_refs: '*', evaluation_hash: 's', evaluatedAt: 's',
  },
  NEGATIVE_RESULT_V1: {
    _doc: '§8 NegativeResult —— 负结果是资产,归档不丢弃',
    negative_result_id: 's', hypothesis_ref: 's', failure_reason: 's',
    strategy_family: 's?', invalidated_assumption: '*', failed_regimes: '*',
    reuse_condition: '*', evidence_refs: 'a', archived_at: 's',
  },
});

const TYPE_CHECK = {
  s: (v) => typeof v === 'string',
  n: (v) => typeof v === 'number' && Number.isFinite(v),
  b: (v) => typeof v === 'boolean',
  a: (v) => Array.isArray(v),
  o: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  '*': (v) => v !== undefined,
};

/** 校验单条记录是否符合其 schema(未知 schema 视为未登记 → 报错,防止无合同对象混入台账)。 */
function validateRecord(rec, schemaName = rec && rec.schema) {
  const def = SCHEMAS[schemaName];
  if (!def) return { ok: false, problems: [`UNKNOWN_SCHEMA:${schemaName}`] };
  const problems = [];
  for (const [field, spec] of Object.entries(def)) {
    if (field === '_doc') continue;
    const nullable = spec.endsWith('?');
    const type = nullable ? spec.slice(0, -1) : spec;
    const v = rec[field];
    if (v === undefined) { problems.push(`MISSING:${field}`); continue; }
    // '*' = 任意值,含显式 null(「无此事实」的诚实表示;缺字段才是违约)
    if (v === null) { if (!nullable && type !== '*') problems.push(`NULL_NOT_ALLOWED:${field}`); continue; }
    if (!TYPE_CHECK[type](v)) problems.push(`TYPE:${field} expected ${type}`);
  }
  return { ok: problems.length === 0, problems };
}

/** 批量校验一个台账文件的全部行。 */
function validateLedger(rows) {
  const results = rows.map((r, i) => ({ i, schema: r.schema, ...validateRecord(r) }));
  return { ok: results.every((r) => r.ok), failures: results.filter((r) => !r.ok) };
}

module.exports = { SCHEMAS, validateRecord, validateLedger };
