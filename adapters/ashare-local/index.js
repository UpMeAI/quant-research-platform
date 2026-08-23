'use strict';
/**
 * A 股本地 Market Adapter(CN_A)—— 实现 §14.1 MarketAdapter Contract 的平台内置适配器。
 *
 * 定位(诚实边界):
 *   - 平台 MVP 演示与确定性测试用:数据来自本地 PIT 文件仓库(样本数据 SAMPLE_SYNTHETIC 或真实导入);
 *   - 生产形态由 Ashare-V5 仓库 research-adapter/ 实现同一合同,封装其既有 PG canonical
 *     日线与 phase2 回测内核(设计 §20 M2:不搬 A 股市场特有代码);
 *   - 本适配器不持有任何 broker credential,不触碰任何 Runtime 持仓/订单真相(§13)。
 */
const { hash, now } = require('../../packages/ledger');
const market = require('./market_facts');
const pit = require('./pit_store');
const engine = require('./backtest_engine');
const { CHAMPION_VARIANT, FWD_DAYS } = require('./strategy_vpq');

const ADAPTER_VERSION = 'ashare-local/0.1.0';

const manifest = Object.freeze({
  market_id: market.market_id,
  adapter_version: ADAPTER_VERSION,
  repo_ref: 'UpMeAI/quant-research-platform#adapters/ashare-local',
  commit_hash: null, // 部署指纹由发布管线注入;本地开发为 null,不伪造
  supported_asset_types: ['STOCK', 'ETF', 'INDEX'],
  capabilities: ['snapshot', 'backtest_signal_layer', 'shadow_observation', 'validate_release'],
  trading_calendar_ref: 'CN_A_TRADING_DAYS(PIT 数据自带日期轴)',
  data_contract_version: 'DAILY_BAR_V1',
  cost_model_version: `COST_PER_SIDE_${market.defaultCostPerSide}`,
  execution_model_version: 'SIGNAL_LAYER_CLOSE_ENTRY_FWD_EXIT_V1',
  backtest_entrypoint: 'run_backtest',
  shadow_entrypoint: 'run_shadow',
  runtime_binding_endpoint: 'ashare-paper-runtime(pull-based;MVP 内置 stub)',
  health_status: 'HEALTHY',
  compatibility_range: { platform: '>=0.1.0' },
});

/** DatasetSnapshot(§8):as_of + known_at 策略 + 校验和 + 覆盖,可重放。 */
function snapshot(request = {}) {
  const cov = pit.coverage();
  const checksum = pit.barsChecksum();
  const snap = {
    schema: 'DATASET_SNAPSHOT_V1',
    snapshot_id: `DSS-${hash({ m: market.market_id, checksum, as_of: request.as_of || cov.dateTo })}`,
    market: market.market_id,
    as_of: request.as_of || cov.dateTo,
    known_at_policy: 'BAR_CLOSE_SAME_DAY(日线收盘即知;无盘中修订)',
    source_refs: cov.sources,
    checksums: { bars: checksum },
    coverage: cov,
    freshness: { dateTo: cov.dateTo, capturedAt: now() },
    corporate_action_or_funding_refs: null, // 样本数据无公司行动;真实源接入时必填
    lineage_hash: hash({ checksum, cov }),
  };
  return snap;
}

/**
 * run_backtest(ExperimentSpec) -> BacktestArtifact。
 * 读取冻结域:universe / sample(IS/OOS)/ costs / execution_model(含双方变体参数)。
 * 相同 spec + 相同数据 → 相同 result_hash(决定论,Result Lock 依据)。
 */
function run_backtest(spec, opts = {}) {
  const em = spec.execution_model || {};
  const champVariant = em.champion_variant || CHAMPION_VARIANT;
  const chalVariant = em.challenger_variant;
  if (!chalVariant) throw new Error('BACKTEST_MISSING_CHALLENGER_VARIANT');
  const uni = spec.universe || {};
  const { byInst, universeDeclared } = pit.loadUniverseBars({
    skip: Number(uni.skip ?? 0), stride: Number(uni.stride ?? 1), cap: Math.min(Number(uni.cap ?? 300), 600),
  });
  if (!byInst.size) throw new Error('BACKTEST_EMPTY_UNIVERSE(先导入/生成 PIT 数据)');
  const costPerSide = Number(spec.costs?.cost_per_side ?? market.defaultCostPerSide);

  const champ = { ...champVariant, key: champVariant.key || 'CHAMPION' };
  const chal = { ...chalVariant, key: chalVariant.key || 'CHALLENGER' };
  // 评测窗口(WFO fold / 鲁棒性子样本用;量能基线仍用窗口前完整历史 → PIT 不破)
  const winFrom = spec.sample?.window_from || null;
  const winTo = spec.sample?.window_to || null;
  const rows = engine.evaluateVariants(byInst, [champ, chal], { dateFrom: winFrom, dateTo: winTo });
  if (!rows.length) throw new Error('BACKTEST_NO_EVALUABLE_ROWS(数据长度不足量能预热窗口)');
  const cCurve = engine.backtestCurve(byInst, rows, champ.key, { costPerSide, dateFrom: winFrom, dateTo: winTo });
  const hCurve = engine.backtestCurve(byInst, rows, chal.key, { costPerSide, dateFrom: winFrom, dateTo: winTo });
  const benchBars = pit.loadInstrumentBars(market.benchmark);
  const bench = engine.benchmarkCurve(benchBars, cCurve.dates);

  const from = cCurve.dates[0]; const to = cCurve.dates[cCurve.dates.length - 1];
  const oosStart = spec.sample?.oos_start;
  if (!oosStart) throw new Error('BACKTEST_MISSING_PREREGISTERED_OOS_START'); // 样本边界必须预注册(§9)
  const isEnd = spec.sample?.is_end || oosStart;

  const artifact = {
    schema: 'BACKTEST_ARTIFACT_V1',
    market: market.market_id,
    adapter_version: ADAPTER_VERSION,
    experiment_ref: spec.experiment_id || null,
    universe: universeDeclared,
    benchmark: market.benchmark,
    fwd_days: FWD_DAYS,
    dates: cCurve.dates,
    nav: { champion: cCurve.nav, challenger: hCurve.nav, benchmark: bench.nav },
    summary: {
      champion: cCurve.summary, challenger: hCurve.summary, benchmark: bench.summary,
      is: {
        champion: engine.segStats(cCurve.dates, cCurve.nav, from, isEnd),
        challenger: engine.segStats(hCurve.dates, hCurve.nav, from, isEnd),
        benchmark: engine.segStats(cCurve.dates, bench.nav, from, isEnd),
      },
      oos: {
        champion: engine.segStats(cCurve.dates, cCurve.nav, oosStart, to),
        challenger: engine.segStats(hCurve.dates, hCurve.nav, oosStart, to),
        benchmark: engine.segStats(cCurve.dates, bench.nav, oosStart, to),
      },
    },
    precision: {
      champion: engine.precision(rows, champ.key),
      challenger: engine.precision(rows, chal.key),
    },
    // OOS 段信号精度(Race 裁决口径:样本外,防 IS 过拟合入选)
    precision_oos: {
      champion: engine.precision(rows.filter((r) => r.d >= oosStart), champ.key),
      challenger: engine.precision(rows.filter((r) => r.d >= oosStart), chal.key),
    },
    // OOS 段逐信号 paired rows(Race paired sample 输入;双边都有输出才成对,§10)
    paired_rows_oos: rows.filter((r) => r.d >= oosStart).map((r) => ({
      key: `${r.inst}|${r.d}`, inst: r.inst, d: r.d, fwd: r.fwd,
      champion_output: r.patterns[champ.key], challenger_output: r.patterns[chal.key],
    })),
    oos_start: oosStart,
    window: { from: winFrom, to: winTo },
    // 可评测区间(量能预热 + 前向窗口之后的真实可判日);WFO/鲁棒性按此切分,避免落进预热期
    evaluable_range: { from: rows[0].d, to: rows[rows.length - 1].d, row_count: rows.length },
    noteCn: '信号层净值对比(GOOD 收盘进/持有期收盘出/等权/显式双边成本);非完整组合模拟',
    ranAt: opts.now || now(),
  };
  artifact.result_hash = hash({
    spec_freeze: spec.freeze_hash || null, universe: universeDeclared,
    window: artifact.window, costPerSide,
    nav: artifact.nav, precision: artifact.precision,
  });
  return artifact;
}

/**
 * run_shadow(shadowSpec, evalDate) -> ShadowArtifact(§14.1)—— 同 PIT、同 cutoff 对
 * Champion/Challenger 各判一次当日 GOOD 信号集(§11 Shadow Contract);
 * 只产观察输出,不触碰任何 Runtime 状态。
 * 若前向窗口已完整(数据覆盖到 evalDate+FWD_DAYS),同时给出双方已实现前向收益,
 * 供 Virtual Ledger 累计虚拟 PnL(§17 Shadow 页要求 virtual PnL)。
 */
function run_shadow(shadowSpec, evalDate) {
  const em = shadowSpec.execution_model || {};
  const champ = { ...(em.champion_variant || CHAMPION_VARIANT), key: 'CHAMPION' };
  const chal = { ...em.challenger_variant, key: 'CHALLENGER' };
  if (!em.challenger_variant) throw new Error('SHADOW_MISSING_CHALLENGER_VARIANT');
  const uni = shadowSpec.universe || {};
  const { byInst } = pit.loadUniverseBars({ skip: Number(uni.skip ?? 0), stride: Number(uni.stride ?? 1), cap: Math.min(Number(uni.cap ?? 300), 600) });
  // PIT cutoff:只允许使用 ≤ evalDate 的 bar
  const cut = new Map();
  for (const [inst, series] of byInst) cut.set(inst, series.filter((b) => b.d <= evalDate));
  const signals = { CHAMPION: [], CHALLENGER: [] };
  const fwdOf = new Map(); // inst -> 已实现前向收益(仅当前向窗口已完整)
  for (const [inst, series] of cut) {
    const i = series.length - 1;
    if (i < 80 || series[i].d !== evalDate) continue;
    const rows = engine.evaluateVariants(new Map([[inst, [...series, ...padFwd(series)]]]), [champ, chal], { dateFrom: evalDate, dateTo: evalDate });
    for (const r of rows) {
      if (r.patterns[champ.key] === 'GOOD') signals.CHAMPION.push(inst);
      if (r.patterns[chal.key] === 'GOOD') signals.CHALLENGER.push(inst);
    }
    // 前向收益只在真实数据已覆盖 evalDate+FWD_DAYS 时给出(否则 null —— 不用占位 bar 冒充)
    const full = byInst.get(inst) || [];
    const at = full.findIndex((b) => b.d === evalDate);
    if (at >= 0 && at + FWD_DAYS < full.length) {
      fwdOf.set(inst, (full[at + FWD_DAYS].close - full[at].close) / full[at].close);
    }
  }
  const realized = (list) => {
    const vals = list.map((id) => fwdOf.get(id)).filter((v) => Number.isFinite(v));
    if (!list.length) return { signal_count: 0, forward_return: 0, forward_complete: true };  // 空仓 = 现金,收益 0
    if (vals.length !== list.length) return { signal_count: list.length, forward_return: null, forward_complete: false };
    const cost = market.defaultCostPerSide * 2;
    return { signal_count: list.length, forward_return: Number((vals.reduce((s, v) => s + v, 0) / vals.length - cost).toFixed(6)), forward_complete: true };
  };
  return {
    schema: 'SHADOW_ARTIFACT_V1',
    key: evalDate,
    business_date: evalDate,
    champion_output: signals.CHAMPION.sort(),
    challenger_output: signals.CHALLENGER.sort(),
    champion_forward: realized(signals.CHAMPION),
    challenger_forward: realized(signals.CHALLENGER),
    forward_windowCn: `等权持有 ${FWD_DAYS} 个交易日、扣双边成本;窗口未走完则 forward_return=null`,
    input_refs: [`pit:${market.market_id}:${pit.barsChecksum()}`],
    data_quality: 'OK',
  };
}

/**
 * regime_labels(spec) -> { [date]: REGIME }(可选能力,供 Race regime_breakdown §10)。
 * 口径:BENCHMARK_TREND_VOL_PROXY_V1 —— 由基准指数 20/60 日均线关系与 20 日已实现波动
 * 派生的**代理**状态,显式标注为代理,不冒充 A 股原生五态市场状态路由器
 * (生产 adapter 应绑定 Ashare-V5 native_market_state_router 的权威状态)。
 */
function regime_labels() {
  const bars = pit.loadInstrumentBars(market.benchmark);
  const labels = {};
  for (let i = 60; i < bars.length; i++) {
    const closes = bars.slice(i - 60, i + 1).map((b) => b.close);
    const ma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / 20;
    const ma60 = closes.reduce((s, v) => s + v, 0) / closes.length;
    const rets = [];
    for (let k = closes.length - 20; k < closes.length; k++) rets.push((closes[k] - closes[k - 1]) / closes[k - 1]);
    const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
    const vol = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length);
    const last = closes[closes.length - 1];
    let label;
    if (vol > 0.02) label = 'HIGH_VOL';
    else if (ma20 > ma60 && last > ma20) label = 'UPTREND';
    else if (ma20 < ma60 && last < ma20) label = 'DOWNTREND';
    else label = 'RANGE';
    labels[bars[i].d] = label;
  }
  return { regime_model: 'BENCHMARK_TREND_VOL_PROXY_V1', labels, proxyCn: '基准指数派生的代理状态,非市场原生权威 Regime' };
}

// ── §13.1 只读回读面(经内置 Paper Runtime stub;生产由 Ashare-V5 Runtime 提供)────
function runtime_active_release() { return require('./paper_runtime_stub').activeRelease(); }
function runtime_positions_readonly() { return require('./paper_runtime_stub').positionsReadonly(); }
function runtime_performance_summary() { return require('./paper_runtime_stub').performanceSummary(); }
function runtime_health() { return require('./paper_runtime_stub').health(); }

// evaluateVariants 需要 i < len - FWD_DAYS 才评测;Shadow 判「当日」信号无前向收益可言,
// 用当日收盘价补齐 FWD_DAYS 个占位 bar(仅让当日可评测;fwd 值不用于 Shadow 结论)。
function padFwd(series) {
  const last = series[series.length - 1];
  const pads = [];
  for (let k = 1; k <= FWD_DAYS; k++) pads.push({ ...last, d: `${last.d}+${k}` });
  return pads;
}

/** validate_release(StrategyRelease) -> CompatibilityResult(§14.1;fail-closed)。 */
function validate_release(release) {
  const reasons = [];
  if (!release) return { compatible: false, reasons: ['RELEASE_MISSING'] };
  if (release.market !== market.market_id) reasons.push(`MARKET_MISMATCH:${release.market}`);
  if (release.adapter_version !== ADAPTER_VERSION) reasons.push(`ADAPTER_VERSION_MISMATCH:${release.adapter_version}!=${ADAPTER_VERSION}`);
  if (!release.code_hash || !release.parameter_hash) reasons.push('RELEASE_HASH_MISSING');
  if (release.execution_contract?.mode !== 'SIGNAL_LAYER_CLOSE_ENTRY_FWD_EXIT_V1') reasons.push('EXECUTION_CONTRACT_UNSUPPORTED');
  const insts = release.universe_contract?.sample_instruments || [];
  for (const id of insts) if (!market.isValidInstrument(id)) reasons.push(`UNIVERSE_INVALID_INSTRUMENT:${id}`);
  return { compatible: reasons.length === 0, reasons, checked_by: ADAPTER_VERSION, checkedAt: now() };
}

/** RuntimeCapability(§13.1 capabilities;MVP 只报 PAPER)。 */
function runtime_capabilities() {
  return {
    runtime_id: market.RUNTIME_ID,
    market_id: market.market_id,
    environments_supported: ['PAPER'],
    trading_rules: market.tradingRules,
    broker_connection: false,   // 平台侧永远只读到 false;credential 只存在 Runtime(§18)
    real_order: 0,
  };
}

/** normalize_result(nativeBacktestArtifact) -> CanonicalRaceMetrics(七轴,§10.1)。 */
function normalize_result(a) {
  const s = a.summary;
  const p = a.precision_oos || a.precision;
  return {
    absolute: {
      cumRet: s.challenger.cumRet, nav_end: a.nav.challenger[a.nav.challenger.length - 1],
      cagr: s.challenger.cagr, tradeCount: s.challenger.tradeCount,
      max_dd_recovery_days: s.challenger.max_dd_recovery_days,
      champion_cumRet: s.champion.cumRet, champion_cagr: s.champion.cagr,
      basisCn: s.challenger.basisCn,
    },
    risk: {
      maxDrawdown: s.challenger.maxDrawdown, annualized_vol: s.challenger.annualized_vol,
      calmar: s.challenger.calmar, sortino_like: s.challenger.sortino_like, sharpe_like: s.challenger.sharpe_like,
      champion_maxDrawdown: s.champion.maxDrawdown, champion_calmar: s.champion.calmar,
      cvar_status: 'NOT_IMPLEMENTED_MVP',   // 信号层等权口径下无逐笔分布,CVaR 待组合层(§21 P4)
    },
    relative: {
      benchmarkExcess: Number((s.challenger.cumRet - s.benchmark.cumRet).toFixed(6)),
      champion_benchmarkExcess: Number((s.champion.cumRet - s.benchmark.cumRet).toFixed(6)),
      benchmark_cumRet: s.benchmark.cumRet, benchmark: a.benchmark,
      information_ratio_status: 'NOT_IMPLEMENTED_MVP',      // 需逐日基准对齐序列,MVP 未做
      downside_capture_status: 'NOT_IMPLEMENTED_MVP',
    },
    trading_quality: {
      good_precision: p.challenger.good_precision, bad_precision: p.challenger.bad_precision,
      good_count: p.challenger.good_count, bad_count: p.challenger.bad_count,
      payoff_ratio: p.challenger.payoff_ratio, expectancy: p.challenger.expectancy,
      avg_win: p.challenger.avg_win, avg_loss: p.challenger.avg_loss,
      mae_avg_on_good: p.challenger.mae_avg_on_good, mfe_avg_on_good: p.challenger.mfe_avg_on_good,
      signal_turnover_per_day: s.challenger.signal_turnover_per_day,
      exposure_ratio: s.challenger.exposure_ratio,
      costPerSide: s.challenger.costPerSide,
      champion_good_precision: p.champion.good_precision,
      champion_bad_precision: p.champion.bad_precision,
      champion_good_count: p.champion.good_count,
      champion_payoff_ratio: p.champion.payoff_ratio,
    },
    robustness: {
      is_cumRet: s.is.challenger.cumRet, oos_cumRet: s.oos.challenger.cumRet,
      champion_is_cumRet: s.is.champion.cumRet, champion_oos_cumRet: s.oos.champion.cumRet,
      is_oos_decay: s.is.challenger.cumRet != null && s.oos.challenger.cumRet != null
        ? Number((s.oos.challenger.cumRet - s.is.challenger.cumRet).toFixed(6)) : null,
      wfo_ref: 'services/experiment-orchestrator/wfo(逐 fold 报告独立入台账)',
      parameter_sensitivity_ref: 'services/experiment-orchestrator/robustness(参数扰动维度)',
    },
    operational: {
      deterministic: true, result_hash: a.result_hash,
      evaluable_range: a.evaluable_range || null,
      replayable: true, idempotent_backtest: true,
    },
    capacity: {
      status: 'NOT_IMPLEMENTED_P4',   // 容量/流动性/冲击模型属 §21 P4,MVP 显式不做(不留空对象假装已覆盖)
      reasonCn: '容量模型(流动性、资金区间、冲击假设)属 P4 Strategy Factory,MVP 不估算',
    },
  };
}

module.exports = {
  manifest, snapshot, run_backtest, run_shadow,
  validate_release, runtime_capabilities, normalize_result,
  regime_labels,
  runtime_active_release, runtime_positions_readonly, runtime_performance_summary, runtime_health,
  ADAPTER_VERSION,
};
