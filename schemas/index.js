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
  PAPER_VALIDATION_V1: {
    _doc: '研究框架修订 2026-11-16 §5（RF1116，签字 fd22876f / 39f8c17c）④ 样本外模拟盘的登记：起始日、最小样本、晋级门、撤回、到期、冠军、配对方式，开跑前冻结（record_hash）。kind NEW = 赛马晋级者，用 §5.3 建议值（赛马关闭后下一个交易日起、不追溯；max(60 交易日, 20 持有期) + 离散交易 ≥ 30 笔；1.5 倍回撤停止；12 个月不足量关闭）；kind EXISTING = §5.4 的五个现有前向影子，每项是封存或冻结页的原文摘句 + 出处 sha256，没写的记「未写」。台账 shadow/paper_validations.jsonl，不动 shadow_runs',
    validation_id: 's', kind: 's', shadow_key: 's', market: 's', shadow_ref: 's?', book_ref: 's?', run_by: 's?', race: 'o?', registered_on: 's',
    start: 'o', min_sample: 'o', promotion_gate: 'o', withdrawal: 'o', expiry: 'o', champion: 'o', pairing: 'o', reading: 'o?', holding_period: 'o?',
    sources: 'a', unverified: 'a', signed: 'o', registeredAt: 's', record_hash: 's',
  },
  PAPER_VALIDATION_EVALUATION_V1: {
    _doc: 'PAPER_VALIDATION_V1（NEW）的一次 §5.3 判定：状态（PENDING_START / RUNNING_DESCRIBE_ONLY / PAUSED_RUN_FAULT / CLAIM_ELIGIBLE / STOPPED_NEGATIVE / CLOSED_INSUFFICIENT）、计入与作废的样本、前向回撤对 1.5 倍上限、同期配对净值、晋级门；输入只读记录器的行（input_sha256）；终态之后不再记',
    validation_id: 's', as_of: 's', state: 's', claim_status: 's', terminal_on: 's?', reasons: 'a', counted: 'o', voided_sessions: 'n', paused_sessions: 'n',
    ignored_pre_start_sessions: 'n', forward_mdd: 'n', forward_mdd_limit: 'n', paired_nav: 'o', guardrail_breaches: 'a', promotion_gate: 'o',
    registration_hash: 's', input_ref: 's', input_sha256: 's', evaluated_at: 's', record_hash: 's',
  },
  PROMOTION_CANDIDATE_V1: {
    _doc: '§8 PromotionCandidate —— 研究/影子双 Gate + 兼容性 + 回滚锚。RF1116 §5 / §8.2：赛马路径另带 race_manifest_ref（RACE_V2 race_id + 清单 sha256）、paper_validation_refs 与 paper_validation_gate（每条模拟盘登记最近一次判定的晋级门都过才写）；旧路径（不带赛马引用）行形不变。RF1116 P1（协调会话裁定 1）：此后新建的候选都带非空 trial_refs（试验谱系），谱系里有 MINED_CANDIDATE 的另记 mined_lineage 且必须走赛马路径；此前的行没有这两个字段，不改写',
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
  RUNTIME_RESEARCH_CASE_V1: {
    _doc: '运行态／研究态闭环 case —— 当前 D 与冻结研究基线分离，研究零生产影响',
    case_id: 's', strategy_ref: 's', market: 's', runtime_lane: 'o', baseline_ref: 's',
    cycle_context: 'o', data_quality: 'o', isolation: 'o', status: 's',
    production_effect: 's', acceptance_ref: 's', case_hash: 's', opened_at: 's',
  },
  RUNTIME_RESEARCH_LINK_V1: {
    _doc: 'Desk 复盘问题与 QRP 冻结实验／锁定结果的不可变回链',
    link_id: 's', case_ref: 's', desk_candidate_ref: 's', desk_evidence_ref: 's', desk_evidence_hash: 's',
    research_question_ref: 's', experiment_ref: 's?', experiment_freeze_hash: 's?',
    result_ref: 's?', result_hash: 's?', conclusion: 's', adoption_state: 's',
    production_effect: 's', link_hash: 's', recorded_at: 's',
  },
  PRODUCT_MILESTONE_EVIDENCE_V1: {
    _doc: 'V8.1 §12.2 产品阶段证据 —— 真实用户任务与交付环境；不由工程状态推断',
    evidence_id: 's', case_ref: 's', stage: 's', decision: 's', evidence_mode: 's',
    delivery_environment: 's', actual_entrypoint: 's', new_capability: 's', supported_scope: 's',
    user_operation: 's', user_result: 's', exception_behavior: 's',
    user_evidence_refs: 'a', technical_evidence_refs: 'a', preparation_evidence_refs: 'a', runtime_evidence_refs: 'a',
    exception_evidence_refs: 'a', stress_evidence_refs: 'a', round_trip_evidence_refs: 'a',
    comparison_evidence_refs: 'a', result_ref: 's?', desk_outcome_ref: 's?', desk_outcome_evidence_ref: 's?',
    release_evidence_ref: 's?',
    upstream_evidence_ref: 's?',
    revokes_ref: 's?', defect_ref: 's?', revocation_reason: 's?',
    production_effect: 's', acceptance_ref: 's', acceptance_amendment_refs: 'a',
    recorded_by: 's', stage_hash: 's', recorded_at: 's',
  },
  PRODUCT_EVIDENCE_ATTESTATION_V1: {
    _doc: '产品里程碑实际证据登记 —— 本地不可变文件的现场 SHA-256、case 与证据类型绑定',
    evidence_id: 's', case_ref: 's', kind: 's', source_ref: 's', source_hash: 's', source_size: 'n',
    object_ref: 's', observed_at: 's', verification_method: 's', production_effect: 's',
    acceptance_ref: 's', registered_by: 's', record_hash: 's', recorded_at: 's',
  },
  M2_ROUND_LOCK_V1: {
    _doc: 'CRYPTO_Q0_RESULT_V1 增补 2 —— 加密 M2 轮次锁：一条策略每一轮一把，按 sha256 绑定分解、候选、冻结的 K2 与冻结裁定（files[]：role、name、path、sha256、size）；没有三态结论（结论只来自前向查看，做 / 不做）；改锁须引用缺陷',
    result_id: 's', case_ref: 's', strategy_ref: 's', round: 'n', baseline_result_id: 's', files: 'a', k2_sha256: 's', import_profile_id: 's',
    supersedes_ref: 's?', defect_ref: 's?', supersede_reason: 's?', production_effect: 's', locked_by: 's', locked_at: 's', lock_hash: 's',
  },
  BASELINE_EVALUATION_LOCK_V1: {
    _doc: 'K3 —— 外部封存的基线评价结果锁（BASELINE_EVALUATION_V1）：文件 sha256、输入序列与引擎 blob 摘要；每 case 只锁一次，改锁须引用缺陷',
    result_id: 's', case_ref: 's', strategy_ref: 's', eval_class: 's', verdict_state: 's',
    file_ref: 's', file_sha256: 's', file_size: 'n', inputs_digest: 's', engine_digest: 's',
    plan_ref: 's', amendment_ref: 's', supersedes_ref: 's?', defect_ref: 's?', supersede_reason: 's?',
    production_effect: 's', locked_by: 's', lock_hash: 's', locked_at: 's',
  },
  COMPARISON_EVALUATION_LOCK_V1: {
    _doc: 'K3 —— 外部封存的候选对比结果锁（CANDIDATE_COMPARISON_V1，按题目 Q1／Q2…；t3_state 只有带镜像状态的题目才有）：文件 sha256、所引用的 Q0 基线锁、输入序列与引擎 blob 摘要；每 case 每题只锁一次，改锁须引用缺陷',
    result_id: 's', case_ref: 's', strategy_ref: 's', question_ref: 's', eval_class: 's', verdict_state: 's', t3_state: 's?',
    baseline_result_id: 's', oos_reuse: 'b', file_ref: 's', file_sha256: 's', file_size: 'n', inputs_digest: 's', engine_digest: 's',
    k2_ref: 's', profile_ref: 's', supersedes_ref: 's?', defect_ref: 's?', supersede_reason: 's?',
    production_effect: 's', locked_by: 's', lock_hash: 's', locked_at: 's',
  },
  GAP_DECOMPOSITION_LOCK_V1: {
    _doc: 'US_V5_M2_Q0_RESULT_V1 导入规格增补 1 §1 —— 差距分解描述记录（GAP_DECOMPOSITION_V1）的锁：文件 sha256、Q0 基线、原版臂来源（Q5 的当前 D 臂）与引用的 Q1–Q5 锁；没有三态（描述，不是结论）；每 case 一条，改锁须引用缺陷',
    record_type: 's', result_id: 's', case_ref: 's', strategy_ref: 's', baseline_result_id: 's', base_arm_ref: 'o', cited_result_ids: 'a', oos_reuse: 'b', decision: 's',
    file_ref: 's', file_sha256: 's', file_size: 'n', smartflow_commit: 's', k2_ref: 's', k2_sha256: 's', import_profile_id: 's',
    supersedes_ref: 's?', defect_ref: 's?', supersede_reason: 's?', production_effect: 's', locked_by: 's', locked_at: 's', lock_hash: 's',
  },
  BASELINE_STRESS_SUPPLEMENT_LOCK_V1: {
    _doc: 'US_V5_M2_Q0_RESULT_V1 导入规格增补 1 §2 —— Q0 压力补充记录（BASELINE_STRESS_SUPPLEMENT_V1）的锁：只追加，不改 Q0 锁；同一 (Q0 基线, 场景) 一条；参照行只显示、不进任何锁；改锁须引用缺陷',
    record_type: 's', result_id: 's', case_ref: 's', strategy_ref: 's', baseline_result_id: 's', scenario: 's', input_route: 's', oos_reuse: 'b', reference_result_ids: 'a',
    file_ref: 's', file_sha256: 's', file_size: 'n', smartflow_commit: 's', k2_ref: 's', k2_sha256: 's', import_profile_id: 's',
    supersedes_ref: 's?', defect_ref: 's?', supersede_reason: 's?', production_effect: 's', locked_by: 's', locked_at: 's', lock_hash: 's',
  },
  SEALED_RESEARCH_RESULT_LOCK_V1: {
    _doc: 'CARRY_V2_RESULT_IMPORT_PROFILE_V1（487cf360…，FREEZE_1）§0/§1/§4 —— 封存研究结论锁：导入封存结论原样（不重算、不重新评价），按 sha256 绑定接入封存包与钉版 smartflow 的封存文件；只有日历与计数，不含任何前向数值；每 case 一条，换包须 supersedes 并引用缺陷',
    record_type: 's', result_id: 's', case_ref: 's', strategy_ref: 's', verdict_form: 's', verdict_result: 's', verdict_next: 's', first_look: 's',
    oos_reuse: 'b', seen_data: 's', data_uses: 'a', segment_marks: 'o', forward_calendar: 'o', half_kelly: 's', reproduction: 'o', sealed_files: 'a',
    bundle_ref: 's', bundle_sha256: 's', receipts: 'a', smartflow_commit: 's', k2_ref: 's', k2_sha256: 's', k2_freeze_sha256: 's',
    import_profile_id: 's', import_profile_sha256: 's', import_profile_freeze_sha256: 's',
    supersedes_ref: 's?', defect_ref: 's?', supersede_reason: 's?', production_effect: 's', locked_by: 's', locked_at: 's', lock_hash: 's',
  },
  OVERSEAS_SEALED_VERDICT_LOCK_V1: {
    _doc: 'OVERSEAS_SEALED_VERDICTS_IMPORT_PROFILE_V1 —— 海外研究封存结论锁：一题一条，按 sha256 绑定封存文件（草稿题为 K2 草稿，前向影子题为冻结的影子规格）、K2 与冻结裁定；结论从封存文件原样读出，不重算；同题换文件须 supersedes 并引用缺陷',
    record_type: 's', result_id: 's', entry_id: 's', kind: 's', strategy_ref: 's', case_ref: 's', sealed_on: 's', decision: 's',
    file_ref: 's', file_sha256: 's', refs: 'a', cites: 'a', smartflow_commit: 's?', import_profile_id: 's',
    supersedes_ref: 's?', defect_ref: 's?', supersede_reason: 's?', production_effect: 's', locked_by: 's', locked_at: 's', lock_hash: 's',
  },
  ASHARE_SEALED_VERDICT_LOCK_V1: {
    _doc: 'ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1 —— A 股研究封存结论锁：一题一条，按 sha256 绑定封存文件、K2 与冻结记录；不重算、不重新评价',
    record_type: 's', result_id: 's', entry_id: 's', kind: 's', strategy_ref: 's', case_ref: 's?', sealed_on: 's', decision: 's',
    file_ref: 's', file_sha256: 's', refs: 'a', cites: 'a', ashare_v6_commit: 's?', import_profile_id: 's',
    supersedes_ref: 's?', defect_ref: 's?', supersede_reason: 's?', production_effect: 's', locked_by: 's', locked_at: 's', lock_hash: 's',
  },
  RESEARCH_ADOPTION_DECISION_V1: {
    _doc: 'UX 修订 6 H1 —— 研究结论的采用决定（追加式）：DECISION（ADOPT／NOT_ADOPTED／NOT_APPLICABLE，Owner 原话、决定时间、后续去向、协调会话建议、决定记录文件 sha256）或 RECOMMENDATION（只有建议与理由）；按 result_id（随机对照加 part）定位，改决定须 supersedes 旧记录；只有完成权威能写',
    record_id: 's', kind: 's', result_id: 's', part: 's?', case_ref: 's', strategy_ref: 's', question_ref: 's',
    decision: 's?', follow_up_zh: 's?', decided_by: 's?', owner_words: 's?', decided_at: 's?', coordinator_recommendation: 'o?', evidence_ref: 'o?',
    supersedes: 's?', production_effect: 's', written_by: 's', written_at: 's', record_hash: 's',
  },
  RESEARCH_TRIAGE_V1: {
    _doc: 'desk 复盘闭环修订 7 §3.3 —— Research 对一个 desk 复盘候选的分诊（追加式）：立题／转工程修复／并入／判不做，判不做与并入带 RESEARCH_TRIAGE_CODES@v1 的码和证据；改正写新一行并 supersedes；只存本机账本（desk 事实不进 git），经回程文件 triage[] 带到 desk',
    record_id: 's', record_hash: 's', candidate_id: 's', question_key: 's', queue_file: 's', queue_sha256: 's', outcome: 's', reason_code: 's?',
    question_ref: 's?', strategy_ref: 's?', merged_into: 's?', fix_ref: 'o?', evidence: 'a', basis_zh: 's', recorded_by: 's', session_ref: 's?',
    triaged_at: 's', supersedes: 's?', production_effect: 's', written_at: 's',
  },
  STRATEGY_BASELINE_V1: {
    _doc: '自审计 strategy_baseline —— 冻结预期基线，只记录不重算策略结论',
    baseline_id: 's', strategy_ref: 's', market: 's', runtime_mode: 's', version_ref: 's',
    source_ref: 's', source_hash: 's', expected_baseline: 'o', acceptance_ref: 's',
    status: 's', record_hash: 's', frozen_at: 's',
  },
  DIVERGENCE_LOG_V1: {
    _doc: '自审计 divergence_log —— 研究／回放／运行差异及处置状态',
    divergence_id: 's', baseline_ref: 's', source_run_ref: 's', target_run_ref: 's',
    field_path: 's', source_value: '*', target_value: '*', difference_state: 's',
    cause_state: 's', status: 's', evidence_refs: 'a', record_hash: 's', detected_at: 's',
  },
  INCIDENT_CATALOG_V1: {
    _doc: '自审计 incident_catalog —— 可复用的故障事实、恢复和复发保护',
    incident_id: 's', category: 's', scope: 's', symptom: 's', root_cause: 's?',
    detection: 's', recovery_state: 's', recurrence_guard: 's?', evidence_refs: 'a',
    status: 's', record_hash: 's', opened_at: 's',
  },
  ANOMALY_WATCHLIST_V1: {
    _doc: '自审计 anomaly_watchlist —— 尚未定性的异常，不冒充事故或策略结论',
    anomaly_id: 's', signal: 's', first_seen: 's', evidence_refs: 'a', owner: 's',
    next_checkpoint: 's?', status: 's', resolution_ref: 's?', resolved_at: 's?',
    record_hash: 's', recorded_at: 's',
  },
  SIGNAL_REGISTRY_V1: {
    _doc: '美股、加密信号登记簿（docs/contracts/SIGNAL_REGISTRY_V1.md）—— 一行 = 一本在跑账本（或其部分）的一条入场信号：命中率、每笔期望、已平笔数及其按市场状态拆分；只读生产方已交付文件，对记分牌 0 差异；事实不是裁决',
    registryVersion: 'n', generatedAt: 's?', contracts: 'o', floors: 'o', books: 'a', rows: 'a', interpretation: 's', productionEffect: 's', hash: 's',
  },
  RESEARCH_TRIAL_V1: {
    _doc: '研究框架修订 2026-11-10（过拟合控制）§2.3 —— 全局试验台账一行：一族（strategy_ref）一个配置的登记或结果；row_kind 为 REGISTRATION／RESULT／CORRECTION，按 trial_id 只追加，更正须 supersedes 加缺陷引用；读不到的值写进 unknown{字段: 原因}，不填 0；只存本机 var/ledger/research/trials.jsonl',
    trial_id: 's', row_kind: 's', family_id: 's', market: 's', shared_mechanism: 's?', study_ref: 's', k2_sha256: 's?', freeze_sha256: 's?',
    stage: 's', role: 's', registration_mode: 's', rule_config_hash: 's', eval_hash: 's?', config_label: 's', delta_vs_baseline: 'a', baseline_trial_ref: 's?',
    window: 'o?', segments: 'a', params_tried: 'a', metrics: 'o?', sr_monthly_delta: '*', skew: '*', kurt: '*', t_months: '*', series_ref: 'o?',
    study_verdict: '*', source_refs: 'a', unknown: 'o', supersedes: 's?', defect_ref: 's?', production_effect: 's', registered_by: 's', registered_at: 's', record_hash: 's',
  },
  DATA_SEGMENT_MARK_V1: {
    _doc: '研究框架修订 2026-11-10（过拟合控制）§4.1 —— 数据段标签：按族、按日期段；UNSEEN／SEEN（seen_kind 沿用 Carry 锁细分）为全族底色，FORWARD_RESERVED／FORWARD_READ 只对 shadow_ref 的候选；没有标签的日期一律当 SEEN；后写的覆盖先写的，更正须 supersedes 加缺陷引用',
    mark_id: 's', family_id: 's', market: 's', from: 's', to: 's', label: 's', seen_kind: 's?', shadow_ref: 's?', reason: 's', source_refs: 'a',
    supersedes: 's?', defect_ref: 's?', production_effect: 's', registered_by: 's', registered_at: 's', record_hash: 's',
  },
  OVERFIT_DISCLOSURE_V1: {
    _doc: '研究框架修订 2026-11-10（过拟合控制）§3.6 —— 每个判定的过拟合披露块：族、N（原始计数，是否下限）、N̂、V、SR0、ŜR、γ3、γ4、T、PSR(0)、DSR、PBO 或不适用、所用回退、段标签、本题新增配置数；数值由 services/trial-ledger/overfit.js 在封存 sha 上算出，算不出写 UNKNOWN 与原因；evidence_gate 只可能把「做 · 有支持证据」降为「做 · 证据不足」',
    disclosure_id: 's', family_id: 's', study_ref: 's', k2_sha256: 's', verdict_trial_ref: 's', sealed_sha256: 's?',
    n_raw: 'n', n_is_lower_bound: 'b', n_hat: '*', v: '*', sr0: '*', sr_hat: '*', skew: '*', kurt: '*', t_months: '*', psr0: '*', dsr: '*', pbo: '*',
    fallback: 'o?', segment_labels: 'a', new_configs: 'n', evidence_gate: 'o', inputs: 'o', unknown: 'o', computed_by: 's',
    supersedes: 's?', defect_ref: 's?', production_effect: 's', registered_by: 's', registered_at: 's', record_hash: 's',
  },
  CAUSALITY_EVIDENCE_V1: {
    _doc: '研究框架修订 2026-11-12（FREEZE_1 c9742ea0）§3.4 —— G-CAUSAL 因果证据：一份 K2 一次运行，逐函数记 T-C1 前缀等价、T-C2 未来替换、T-C3 只读给定输入（PASS／FAIL）与前 20 处不一致；由 tools/causality-harness 写出，写一次不改（更正写新文件）；按 sha256 绑定进导入登记（entry.causality_evidence）；读不到的事实写进 unknown{字段: 原因}；functions[].role 可选（SIGNAL／FEATURE／SCORE／FILTER／FILL，附录 1 §1.1 成交函数标 FILL），逐函数由 services/causality-gate 校验',
    contract_ref: 's', study_ref: 's', k2_sha256: 's', code_repo: 's', code_sha: 's?', harness_version: 's', harness_sha256: 's', seed: 'n', cut_points_per_function: 'n',
    manifest_sha256: 's', functions: 'a', unknown: 'o', production_effect: 's', registered_by: 's', registered_at: 's', record_hash: 's',
  },
  FACTOR_LIBRARY_V1: {
    _doc: '研究框架修订 2026-11-16（因子库与 AI 自动挖掘因子）草稿 ddeb2eea §2，P0 —— 因子库文件 config/research_factor_library.v1.json：只由 services/factor-library 写出（不手改）；按 sha256 绑定修订草稿；factors[] 每条是 FACTOR_LIBRARY_ENTRY_V1；not_registered[] 列出列举到但不是因子的字段与理由；docs/contracts/FACTOR_LIBRARY_V1.md',
    schema: 's', contract_ref: 'o', producer: 's', registered_at: 's', registered_by: 's', sources: 'a', dedupe: 'o', factors: 'a', not_registered: 'a', production_effect: 's',
  },
  FACTOR_LIBRARY_ENTRY_V1: {
    _doc: 'FACTOR_LIBRARY_V1 的一条因子（§2.2）：层只开 SELECTION_CROSS_SECTION；class 八类（OTHER 写理由）；formula 在 P0 只收 CF:<repo>:<path>#<entry>（DSL 留给 P1）；mechanism_id 必须已在机制登记表；LEGACY_RULE 绑定钉版源文件（repo、commit、path、sha256、extract），不重新判定；读不到的写进 unverified[]',
    factor_id: 's', market: 's', universe: 'o', layer: 's', class: 's', class_reason_zh: 's?', definition_zh: 's', formula: 's', inputs: 'a', pit_available_at: 's',
    horizon: 'o', economic_logic_zh: 's', origin: 's', mining: 'o?', status: 's', mechanism_id: 's?', rule_ref: 'o?', weight_in_rule: 'o?', composite: 'o?',
    correlation: 'o', dedupe: 'o', evidence: 'o', source: 'o?', code_refs: 'a', unverified: 'a',
  },
  MINING_SPACE_V1: {
    _doc: '研究框架修订 2026-11-16 §3.2（RF1116，签字 fd22876f / 39f8c17c）—— 每轮开跑前冻结的挖掘搜索空间：已登记的读数（各写 PIT 可得时刻）、白名单算子的子集（每个都要有 role FEATURE、三项 PASS 的因果证据）、常数网格、回看窗口（≤ 250）、持有期、记号 ≤ 20、嵌套 ≤ 5；冻结页写出清单 sha256，台账行与轮次清单引用它（services/mining-sandbox/space.js）',
    space_ref: 's', market: 's', readings: 'a', operators: 'a', constants: 'a', lookbacks: 'a', holding_periods: 'a', max_tokens: 'n', max_depth: 'n', operator_evidence: 'o',
  },
  MINING_ROUND_V1: {
    _doc: '研究框架修订 2026-11-16 §3.3、§3.4（RF1116，签字 fd22876f / 39f8c17c）—— 一轮挖掘的冻结清单（= 预登记）与状态：搜索空间 sha 与冻结页、持有期与族、生成方式（模型与知识截止日 / GP 种子）、上限 ≤ 200、留出段（第一轮冻结，以后不挪）；状态 OPEN → CAP_REACHED → SCORING（留出段已开）→ CLOSED（G-MINE 过了几个由逐候选记录数出来，gmine_basis 记依据，给暂停规则用）；台账 research/mining_rounds.jsonl（services/mining-rounds）',
    round_id: 's', market: 's', month: 's', space: 'o', holding_periods: 'a', family_ids: 'a', generator: 'o', holdout: 'o', cap: 'n', resumed_after_pause: 'a',
    status: 's', candidates_scored: 'n', gmine_passes: 'n?', gmine_basis: 'o?', opened_at: 's', closed_at: 's?', record_hash: 's',
  },
  MINING_SELECTION_V1: {
    _doc: '验证折选择记录（RF1116 §3.4；P2 独立复审 2026-11-17）：一轮一行、只追加，写输出目录里 selection.json 的 sha256 与过了验证折的候选编号；写了之后本轮不再记候选；留出段只开这些候选，公式取试验台账行（services/mining-rounds recordSelection）',
    round_id: 's', market: 's', manifest_sha256: 's', selection_sha256: 's', selected: 'a', evaluated: 'n', rule: 'o?', recorded_at: 's', record_hash: 's',
  },
  MINING_GATE_RECORD_V1: {
    _doc: 'G-MINE 逐候选记录（RF1116 §3.6；协调会话 2026-11-17 裁定 3）：G-MINE 求值这条路写（services/mining-rounds/gate-records.js 调用门求值），每轮每个候选一行、只追加；挂本轮的试验台账行与留出段开启记录；过 = 门判 pass 且九项全过；门槛只读钉住的 config/mining_gate_thresholds.v1.json（不收调用方的），记下文件 sha256 与用到的数、本族 N；关轮从这些记录数「过了几个」',
    round_id: 's', candidate_id: 's', trial_id: 's', trial_record_hash: 's', holdout_open_hash: 's', gate_result_sha256: 's', thresholds_file: 'o', thresholds_used: 'o',
    family_trial_count: 'n', pass: 'b', codes: 'a', items: 'a',
    recorded_at: 's', record_hash: 's',
  },
  HOLDOUT_SEAL_V1: {
    _doc: '留出段封存（RF1116 §3.4，services/holdout-vault）：每轮一次，起止等于轮次清单的留出段，只记数据引用与 sha256',
    round_id: 's', market: 's', segment: 'o', data_ref: 's', data_sha256: 's', sealed_by: 's', sealed_at: 's', record_hash: 's',
  },
  HOLDOUT_OPEN_V1: {
    _doc: '留出段开启日志（RF1116 §3.4）：每轮只开一次，记读了哪些候选（每个只读一次）、谁开、何时开',
    round_id: 's', seal_hash: 's', candidate_ids: 'a', opened_by: 's', opened_at: 's', record_hash: 's',
  },
  RACE_MANIFEST_V1: {
    _doc: '研究框架修订 2026-11-16 §4.3（RF1116，签字 fd22876f / 39f8c17c）—— 赛马清单：一个市场、一个分区（层）、冠军与挑战者、同一引擎 / 窗口 / 成本模型、主指标、护栏、晋级名额（≤ 2）；协调会话冻结（冻结页写出清单 sha256 与 FROZEN），清单 sha 写进每个参赛者的试验台账行（k2_sha256）',
    race_ref: 's', market: 's', partition: 's', periods_per_year: 'n', seed: 'n', engine: 'o', window: 'o', cost_model: 'o', primary_metric: 's', guardrails: 'o',
    pbo_max: 'n', promotion_slots: 'n', champion: 'o', challengers: 'a',
  },
  RACE_V2: {
    _doc: '研究框架修订 2026-11-16 §4（RACE_V2）—— 一场按市场、按层分区的赛马：OPEN 行记冻结的清单、入场线、G-COST 的成本模型；CLOSED 行加 outcome（淘汰线、按本市场 N 的 DSR 或 BHY、分区 PBO、排名、晋级 ≤ 2）；台账 races_v2.jsonl，旧 RACE_RUN_V1 台账不动',
    race_id: 's', status: 's', market: 's', partition: 's', manifest_sha256: 's', freeze: 'o', manifest: 'o', signed: 'o', entry: 'a', cost_model: 'o',
    outcome: 'o?', production_effect: 's', opened_at: 's', closed_at: 's?', record_hash: 's',
  },
  SIGNAL_REGISTRY_ROW_V1: {
    _doc: 'SIGNAL_REGISTRY_V1 的一行（rows[] 与 books[].blocks[].rollup）；windows 为 bookSinceStart / currentVersion / previousVersion',
    rowId: 's', ledgerId: 's', market: 's', partId: 's?', signalKey: 's', signalCodes: 'a', ruleRefs: 'a', entries: 'n',
    firstEntryAt: 's?', lastEntryAt: 's?', windows: 'o', stateSplit: 'o',
  },
  ASHARE_Q0_ACCOUNT_RESULT_V1: {
    _doc: 'Ashare-V6 Q0 未封存账户日导出的只读 QRP 结果投影；账户、成交、权益与规则证据均来自 ASHARE_V6_Q0_ACCOUNT_DAY_V1，不重算交易决定',
    resultVersion: 'n', market: 's', generatedAt: 's?', source: 'o', account: 'o', executions: 'a', equityCurve: 'a', ruleEvidence: 'a',
    signalRegistryHash: 's', summary: 'o', productionEffect: 's', hash: 's',
  },
  ASHARE_Q0_SIGNAL_REGISTRY_V1: {
    _doc: 'Ashare-V6 Q0 开仓成交上原样记录的信号登记；没有开仓成交时 rows 为空并显式 NOT_APPLICABLE，不从阻断原因猜信号',
    registryVersion: 'n', generatedAt: 's?', market: 's', accountId: 's', source: 'o', rowsState: 's', rows: 'a',
    interpretation: 's', productionEffect: 's', hash: 's',
  },
  ASHARE_Q0_SIGNAL_REGISTRY_ROW_V1: {
    _doc: 'Ashare-V6 Q0 信号登记的一行；一行 = 同一未封存账户开仓成交上的同一组 decision.reasonCodes',
    rowId: 's', accountId: 's', market: 's', signalKey: 's', signalCodes: 'a', ruleRefs: 'a', entries: 'n',
    firstEntryAt: 's?', lastEntryAt: 's?', executionRefs: 'a',
  },
  SIGNAL_REGISTRY_V2: {
    _doc: '三市场统一信号登记；只合并各市场权威登记，A 股没有记分牌窗口时绩效保持 NOT_APPLICABLE',
    registryVersion: 'n', generatedAt: 's?', markets: 'a', sources: 'a', rows: 'a', interpretation: 's', productionEffect: 's', hash: 's',
  },
  SIGNAL_REGISTRY_ROW_V2: {
    _doc: '三市场统一信号登记行；绩效只在来源具备权威记分牌窗口时存在',
    rowId: 's', ledgerId: 's', market: 's', partId: 's?', signalKey: 's', signalCodes: 'a', ruleRefs: 'a', entries: 'n',
    firstEntryAt: 's?', lastEntryAt: 's?', performanceState: 's', windows: 'o?', stateSplit: 'o?', sourceRegistryHash: 's',
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
