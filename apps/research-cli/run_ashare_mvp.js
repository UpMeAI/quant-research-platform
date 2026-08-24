#!/usr/bin/env node
'use strict';
/**
 * A 股 MVP 端到端闭环(设计 §16.3 十二步)——
 *   数据 → Champion 注册 → 假设 → 快照 → 预注册实验 → 回测 → Stage Race →
 *   Shadow 前向 → PromotionCandidate → Compatibility → Release → Founder Review →
 *   Activation(PAPER)→ Runtime Pull + Verify Hash + ACK → ACTIVE。
 *
 * 诚实边界:
 *   - 数据为 SAMPLE_SYNTHETIC(确定性合成),演示平台治理与流水线,不构成任何经济结论;
 *   - Runtime 为内置 stub(生产 Runtime = Ashare-V5,以同一 pull 协议对接);
 *   - real_order=0,无 broker 凭证,MVP 只发布到 PAPER。
 */
const pit = require('../../adapters/ashare-local/pit_store');
const { generateSampleBars } = require('../../adapters/ashare-local/sample_data');
const { CHAMPION_VARIANT } = require('../../adapters/ashare-local/strategy_vpq');
const { getAdapter } = require('../../adapters/registry');
const registry = require('../../services/strategy-registry');
const experiments = require('../../services/experiment-orchestrator');
const races = require('../../services/race-orchestrator');
const shadow = require('../../services/shadow-control');
const controlPlane = require('../../services/strategy-control-plane');
const runtimeStub = require('../../adapters/ashare-local/paper_runtime_stub');
const { RUNTIME_ID } = require('../../adapters/ashare-local/market_facts');

const MARKET = 'CN_A';
const RUN_TAG = new Date().toISOString().replace(/[:.]/g, '-'); // 每次运行独立实验(冻结/ResultLock 不可复用)
const step = (n, t) => console.log(`\n── Step ${n}: ${t} ${'─'.repeat(Math.max(4, 58 - t.length))}`);

async function main() {
  const adapter = getAdapter(MARKET);

  step(1, '数据就绪(PIT 仓库)');
  if (pit.coverage().barCount === 0) {
    pit.ingestBars(generateSampleBars().bars, { source: 'SAMPLE_SYNTHETIC' });
  }
  const cov = pit.coverage();
  console.log(`  ${cov.instrumentCount} 标的 / ${cov.barCount} bars / ${cov.dateFrom}..${cov.dateTo} / sources=${cov.sources.join(',')}`);

  step(2, 'Champion 注册(记录现状,非经济变更 §16.1)');
  const champModule = registry.registerModule({
    module_id: 'MOD-CN_A-VPQ-TIMING-FIXED', market: MARKET, module_type: 'TIMING',
    code_ref: 'adapters/ashare-local/strategy_vpq.js#FIXED', parameters: CHAMPION_VARIANT,
  });
  if (!champModule.ok) throw new Error(`champion module: ${champModule.reason}`);
  registry.registerFamily({
    family_id: 'FAM-VPQ', market_scope: [MARKET],
    economic_mechanism: '量价确认/量能干涸修复 —— 放量突破延续与缩量回踩企稳的短周期延续效应',
    strategy_goal: '短持有期(3 日)信号层正收益与高 GOOD 精度',
  });
  const champBundle = registry.registerChampionBundle({
    market: MARKET, bundle_id: 'BND-CN_A-VPQ-CHAMPION',
    module_refs: [`${champModule.record.module_id}#v${champModule.record.version}`],
    market_adapter_version: adapter.ADAPTER_VERSION,
  });
  const champRef = `${champBundle.record.bundle_id}#v${champBundle.record.bundle_version}`;
  console.log(`  Champion Bundle = ${champRef}(status=${champBundle.record.status},hash=${champBundle.record.bundle_hash})`);

  step(3, 'Challenger 模块 + Bundle 注册');
  const challengerVariant = { key: 'CHALLENGER_QUANTILE', type: 'QUANTILE', qHi: 0.8, qLo: 0.1 };
  const chalModule = registry.registerModule({
    module_id: 'MOD-CN_A-VPQ-TIMING-QUANTILE', market: MARKET, module_type: 'TIMING',
    family_id: 'FAM-VPQ',
    code_ref: 'adapters/ashare-local/strategy_vpq.js#QUANTILE', parameters: challengerVariant,
  });
  if (!chalModule.ok) throw new Error(`challenger module: ${chalModule.reason}`);
  const chalBundle = registry.registerBundle({
    bundle_id: 'BND-CN_A-VPQ-QUANTILE', market: MARKET,
    module_refs: [`${chalModule.record.module_id}#v${chalModule.record.version}`],
    market_adapter_version: adapter.ADAPTER_VERSION,
  });
  if (!chalBundle.ok) throw new Error(`challenger bundle: ${chalBundle.reason}`);
  const chalRef = `${chalBundle.record.bundle_id}#v${chalBundle.record.bundle_version}`;
  console.log(`  Challenger Bundle = ${chalRef}(status=${chalBundle.record.status})`);

  step(4, 'ResearchHypothesis(机制/预期/失败条件/指标+守卫)');
  const hyp = experiments.registerHypothesis({
    research_question: '自适应分位量能判据(Q80/Q10)能否比固定阈值(1.2/0.7)提高 OOS GOOD 信号精度?',
    expected_mechanism: '个股量能基数差异大;按自身 trailing 分布判放量/缩量,应减少高基数股的假放量与低基数股的漏判',
    expected_improvement: 'OOS GOOD precision 提升,且 BAD precision 与信号覆盖不明显恶化',
    primary_metric: 'good_precision',
    secondary_metrics: ['oos_cumRet', 'bad_precision', 'good_count'],
    guardrails: [
      { id: 'G1_BAD_PRECISION', rule: 'NOT_WORSE_THAN_CHAMPION_BY', metric: 'bad_precision', value: 0.10 },
      { id: 'G2_SIGNAL_COVERAGE', rule: 'AT_LEAST_FRACTION_OF_CHAMPION', metric: 'good_count', value: 0.5 },
    ],
    failure_condition: 'OOS good_precision 不高于 Champion,或任一 guardrail 违约',
  });
  console.log(`  ${hyp.hypothesis_id}`);

  step(5, 'DatasetSnapshot(经 adapter,可重放)');
  const snap = await experiments.captureDatasetSnapshot(MARKET);
  console.log(`  ${snap.snapshot_id}(bars checksum=${snap.checksums.bars},${snap.coverage.dateFrom}..${snap.coverage.dateTo})`);

  step(6, 'ExperimentSpec 预注册 + 冻结');
  const anyBars = pit.loadUniverseBars({ cap: 1 }).byInst.values().next().value;
  const oosStart = anyBars[Math.floor(anyBars.length * 0.7)].d; // 样本边界预注册(不是跑完再挑)
  const exp = experiments.preregisterExperiment({
    experiment_id: `EXP-VPQ-Q80-${RUN_TAG}`,
    hypothesis_ref: hyp.hypothesis_id, market: MARKET,
    champion_ref: champRef, challenger_ref: chalRef,
    changed_component: 'TIMING.volume_threshold_rule(FIXED→QUANTILE)',
    fixed_components: ['UNIVERSE', 'pattern_logic', 'FWD_DAYS', 'cost_model', 'benchmark'],
    dataset_snapshot_ref: snap.snapshot_id,
    universe: {
      skip: 0, stride: 1, cap: 50,
      membership_basis: 'SAMPLE_SYNTHETIC_FIXED_LIST(合成样本固定名单)',
      filter_rules: ['instrument_id 通过 CN_A 分类校验', '量能预热窗口内数据完整'],
      survivorship_policy: 'NO_DELISTING_IN_SAMPLE(合成数据无退市;真实源接入时必须改为 PIT 历史成分)',
    },
    regime_scope: 'ALL', holding_period: { fwd_days: 3 },
    sample: {
      is_end: oosStart, oos_start: oosStart, adjudication_segment: 'OOS',
      wfo: { train_days: 40, test_days: 20, step_days: 20, folds: 2 },
    },
    signal_action_contract: {
      signal_definition: 'VPQ pattern ∈ {GOOD,BAD,NEUTRAL};仅 volUp/volDry 判据为受控变量',
      bar_completion: '日线收盘 bar 完成后判定,当日不可回看未来 bar(PIT)',
      action_semantics: 'GOOD = 当日收盘等权建仓,持有 holding_period.fwd_days 个交易日后收盘平仓',
    },
    drawdown_policy: {
      max_drawdown: 'MEASURED_FROM_SIGNAL_LAYER_NAV',
      cvar: 'NOT_MODELLED_MVP(信号层等权口径无逐笔分布;属 P4 组合层)',
      recovery_time: 'MEASURED_AS_max_dd_recovery_days',
      tail_loss: 'NOT_MODELLED_MVP',
    },
    costs: { cost_per_side: 0.001 },
    execution_model: { champion_variant: CHAMPION_VARIANT, challenger_variant: challengerVariant },
    multiple_test_policy: 'SINGLE_PREREGISTERED_COMPARISON',
    parameter_grid: [{ qHi: 0.8, qLo: 0.1 }, { qHi: 0.85, qLo: 0.1 }, { qHi: 0.75, qLo: 0.1 }],
    seed: 20260823, min_forward_evidence: 20,
  });
  console.log(`  ${exp.experiment_id}(freeze_hash=${exp.freeze_hash},oos_start=${oosStart})`);

  step(7, '回测(经 Market Adapter,决定论)');
  const artifact = await experiments.runBacktest(exp.experiment_id);
  const p = artifact.precision_oos; // 裁决口径 = 预注册的 OOS 段
  console.log(`  result_hash=${artifact.result_hash} paired_oos=${artifact.paired_rows_oos.length}`);
  console.log(`  Champion  (OOS): good_precision=${p.champion.good_precision?.toFixed(4)} good=${p.champion.good_count} bad_precision=${p.champion.bad_precision?.toFixed(4)}`);
  console.log(`  Challenger(OOS): good_precision=${p.challenger.good_precision?.toFixed(4)} good=${p.challenger.good_count} bad_precision=${p.challenger.bad_precision?.toFixed(4)}`);

  step('7b', 'OOS / WFO / Costs / Robustness(§16.3 步骤 4)');
  const wfo = await experiments.runWalkForward(exp.experiment_id);
  console.log(`  WFO:${wfo.evaluated_fold_count}/${wfo.fold_count} fold 可评测,challenger 胜出比例=${wfo.challenger_win_fraction}`);
  for (const f of wfo.folds) {
    console.log(`    fold${f.fold} train ${f.train_from}..${f.train_to} → test ${f.test_from}..${f.test_to}` +
      (f.status === 'EVALUATED' ? ` | 选参 ${JSON.stringify(f.selected_params)} | test champ=${f.test_champion?.toFixed(4)} chal=${f.test_challenger?.toFixed(4)}` : ` | ${f.status}`));
  }
  console.log(`  选参稳定性:${wfo.stabilityCn}`);
  const rob = await experiments.runRobustness(exp.experiment_id);
  console.log(`  Robustness:${rob.decidable_trial_count} 次可判扰动,challenger 仍占优比例=${rob.challenger_better_fraction}`);
  for (const [dim, d] of Object.entries(rob.dimensions)) {
    console.log(`    ${dim}: ${d.status}${d.trials ? `(${d.trials.filter((t) => t.challenger_better).length}/${d.trials.length} 占优)` : ` —— ${d.reasonCn || ''}`}`);
  }

  step(8, 'Stage Race(受控变量 + 预注册裁决 + Regime 分解)');
  const race = races.openRace({ race_type: 'STAGE_RACE', experiment_ref: exp.experiment_id });
  races.submitPairedSamples(race.race_id, artifact.paired_rows_oos);
  const metricsOf = (side) => ({
    good_precision: p[side].good_precision, bad_precision: p[side].bad_precision,
    good_count: p[side].good_count, bad_count: p[side].bad_count,
    oos_cumRet: artifact.summary.oos[side].cumRet,
  });
  const closed = await races.closeRace(race.race_id, {
    championMetrics: metricsOf('champion'),
    challengerMetrics: metricsOf('challenger'),
    canonical: adapter.normalize_result(artifact),
  });
  const verdict = closed.result.conclusion;
  console.log(`  verdict=${verdict} primary(${closed.result.primary_metric}): champion=${closed.result.champion_value?.toFixed(4)} challenger=${closed.result.challenger_value?.toFixed(4)}`);
  for (const g of closed.result.guardrail_result) console.log(`  guardrail ${g.id}: ${g.breached ? '违约' : '通过'}`);
  const rb = closed.result.regime_breakdown;
  if (rb?.status === 'EVALUATED') {
    console.log(`  Regime 分解(${rb.regime_model};challenger 占优 Regime 比例=${rb.stability}):`);
    for (const [reg, cell] of Object.entries(rb.by_regime)) {
      console.log(`    ${reg.padEnd(10)} n=${String(cell.sample_count).padStart(4)} champ_gp=${cell.champion.good_precision ?? '-'} chal_gp=${cell.challenger.good_precision ?? '-'}`);
    }
  } else console.log(`  Regime 分解:${rb?.status}`);

  if (verdict !== 'CHALLENGER_WINS') {
    // 负结果/守擂是合法出口:归档,不进发布(样本数据下也可能发生 —— 诚实终止)
    experiments.archiveNegativeResult({
      hypothesis_ref: hyp.hypothesis_id, strategy_family: 'FAM-VPQ',
      failure_reason: `race verdict=${verdict}(primary=${closed.result.primary_metric})`,
      evidence_refs: [artifact.result_hash, closed.result.result_hash],
    });
    console.log(`\n✅ 闭环终止于 Race:${verdict} —— 已归档 NegativeResult,不进发布(No Automatic Promotion)`);
    return;
  }

  step(9, 'Shadow 前向观察(Virtual Ledger,零 Runtime 影响)');
  registry.transitionBundle(chalBundle.record.bundle_id, chalBundle.record.bundle_version, 'CHALLENGER', { reason: `race:${race.race_id}` });
  registry.transitionBundle(chalBundle.record.bundle_id, chalBundle.record.bundle_version, 'SHADOW', { reason: 'shadow run opened' });
  const shd = shadow.openShadowRun({
    champion_ref: champRef, challenger_ref: chalRef,
    race_ref: race.race_id, experiment_ref: exp.experiment_id,
  });
  const evalDates = artifact.dates.slice(-shd.min_forward_evidence);
  let disagreements = 0;
  for (const d of evalDates) {
    const obs = await shadow.observeViaAdapter(shd.shadow_id, d);
    if (!obs.agree) disagreements++;
  }
  const suff = await shadow.sufficiency(shd.shadow_id);
  console.log(`  ${shd.shadow_id}: ${suff.forward_sample_count}/${suff.min_required} 个前向样本(分歧 ${disagreements})→ ${suff.claim_status}`);

  step(10, 'PromotionCandidate → Compatibility → Immutable Release');
  const cand = await controlPlane.createPromotionCandidate({
    release_candidate_ref: chalRef, market: MARKET, experiment_ref: exp.experiment_id,
    research_evidence_refs: [artifact.result_hash, closed.result.result_hash],
    shadow_forward_refs: [shd.shadow_id],
    rollback_ref: champRef,
  });
  const compat = await controlPlane.runCompatibilityCheck(cand.candidate_id);
  if (!compat.compatibility.compatible) throw new Error(`兼容性失败:${compat.compatibility.reasons.join(';')}`);
  const release = controlPlane.createRelease(cand.candidate_id);
  console.log(`  ${cand.candidate_id} → compatibility PASS → ${release.release_id}(release_hash=${release.release_hash})`);

  step(11, 'Founder Review → Activation(PAPER,未来生效)');
  controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER', decisionCn: 'MVP 演示批准(PAPER only)' });
  const effectiveFrom = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const act = await controlPlane.requestActivation(release.release_id, {
    target_runtime_id: RUNTIME_ID, environment: 'PAPER', effective_from: effectiveFrom,
  });
  console.log(`  ${act.activation_id}(status=${act.activation_status},effective_from=${act.effective_from})`);

  step(12, 'Runtime Pull + Verify Hash + ACK(pull-based §12.2,生效日门控)');
  const beforeEffective = await runtimeStub.pullAndAck({ today: new Date().toISOString().slice(0, 10) });
  console.log(`  生效日前(今日)拉取:pending=${beforeEffective.pulled},未到生效日=${beforeEffective.scheduled_not_yet_effective.length} → 批准 ≠ 生效`);
  const pulled = await runtimeStub.pullAndAck({ today: effectiveFrom }); // 模拟自然到达 effective_from 当日
  console.log(`  生效日(${effectiveFrom})拉取:pending=${pulled.pulled}`);
  for (const r of pulled.results) {
    console.log(`  ${r.activation_id} → ${r.action}`);
    if (r.migration) console.log(`  迁移裁定:${r.migration.schema} status=${r.migration.status || '-'} replan=${r.migration.replan_required_count}(${r.migration.reasonCn})`);
  }
  const finalAct = controlPlane.activationHead(act.activation_id);
  const finalBundle = registry.bundleHead(chalBundle.record.bundle_id, chalBundle.record.bundle_version);

  console.log('\n════════ A 股 MVP 闭环摘要 ════════');
  console.log(`  实验          ${exp.experiment_id} → RESULT_LOCKED(${verdict})`);
  console.log(`  Release       ${release.release_id}(immutable,hash=${release.release_hash})`);
  console.log(`  Activation    ${finalAct.activation_id} → ${finalAct.activation_status}(runtime=${finalAct.target_runtime_id},env=${finalAct.environment})`);
  console.log(`  Bundle        ${chalRef} → ${finalBundle.status}(activationRef=${finalBundle.activationRef})`);
  console.log(`  回滚锚        previous_release_ref=${finalAct.previous_release_ref ?? 'null(首次激活:平台此前未对该 Runtime 发过 Release —— 回滚将报 NO_PREVIOUS_RELEASE_TO_RESTORE,不伪装成功)'}`);
  console.log(`                rollback_bundle_ref=${finalAct.rollback_bundle_ref}(候选声明的 bundle 级锚点,仅审计)`);
  console.log('  不变量        real_order=0 · broker=false · PAPER only · Founder 唯一批准 · append-only 台账');
  if (finalAct.activation_status !== 'ACTIVE') throw new Error(`MVP 未闭环:activation=${finalAct.activation_status}`);
  console.log('\n✅ 12 步闭环完成(数据为 SAMPLE_SYNTHETIC,结论不构成经济有效性声明)');
}

main().catch((e) => { console.error(`\n❌ MVP 闭环失败:${e.message}`); process.exitCode = 1; });
