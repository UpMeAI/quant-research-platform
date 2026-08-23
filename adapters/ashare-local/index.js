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
  shadow_entrypoint: 'run_shadow_observation',
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
  const rows = engine.evaluateVariants(byInst, [champ, chal]);
  if (!rows.length) throw new Error('BACKTEST_NO_EVALUABLE_ROWS(数据长度不足量能预热窗口)');
  const cCurve = engine.backtestCurve(byInst, rows, champ.key, { costPerSide });
  const hCurve = engine.backtestCurve(byInst, rows, chal.key, { costPerSide });
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
    noteCn: '信号层净值对比(GOOD 收盘进/持有期收盘出/等权/显式双边成本);非完整组合模拟',
    ranAt: opts.now || now(),
  };
  artifact.result_hash = hash({
    spec_freeze: spec.freeze_hash || null, universe: universeDeclared,
    nav: artifact.nav, precision: artifact.precision,
  });
  return artifact;
}

/**
 * run_shadow_observation(shadowSpec, evalDate) —— 同 PIT、同 cutoff 对 Champion/Challenger
 * 各判一次当日 GOOD 信号集(§11 Shadow Contract);只产观察输出,不触碰任何 Runtime 状态。
 */
function run_shadow_observation(shadowSpec, evalDate) {
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
  for (const [inst, series] of cut) {
    const i = series.length - 1;
    if (i < 80 || series[i].d !== evalDate) continue;
    const rows = engine.evaluateVariants(new Map([[inst, [...series, ...padFwd(series)]]]), [champ, chal], { dateFrom: evalDate, dateTo: evalDate });
    for (const r of rows) {
      if (r.patterns[champ.key] === 'GOOD') signals.CHAMPION.push(inst);
      if (r.patterns[chal.key] === 'GOOD') signals.CHALLENGER.push(inst);
    }
  }
  return {
    key: evalDate,
    business_date: evalDate,
    champion_output: signals.CHAMPION.sort(),
    challenger_output: signals.CHALLENGER.sort(),
    input_refs: [`pit:${market.market_id}:${pit.barsChecksum()}`],
    data_quality: 'OK',
  };
}

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
  return {
    absolute: {
      cumRet: s.challenger.cumRet, nav_end: a.nav.challenger[a.nav.challenger.length - 1],
      tradeCount: s.challenger.tradeCount,
      champion_cumRet: s.champion.cumRet,
    },
    risk: { maxDrawdown: s.challenger.maxDrawdown, champion_maxDrawdown: s.champion.maxDrawdown },
    relative: { benchmarkExcess: Number((s.challenger.cumRet - s.benchmark.cumRet).toFixed(6)) },
    trading_quality: {
      good_precision: a.precision.challenger.good_precision,
      bad_precision: a.precision.challenger.bad_precision,
      good_count: a.precision.challenger.good_count,
      bad_count: a.precision.challenger.bad_count,
      costPerSide: s.challenger.costPerSide,
      champion_good_precision: a.precision.champion.good_precision,
      champion_bad_precision: a.precision.champion.bad_precision,
      champion_good_count: a.precision.champion.good_count,
    },
    robustness: {
      is_cumRet: s.is.challenger.cumRet, oos_cumRet: s.oos.challenger.cumRet,
      champion_is_cumRet: s.is.champion.cumRet, champion_oos_cumRet: s.oos.champion.cumRet,
    },
    operational: { deterministic: true, result_hash: a.result_hash },
    capacity: {},
  };
}

module.exports = {
  manifest, snapshot, run_backtest, run_shadow_observation,
  validate_release, runtime_capabilities, normalize_result,
  ADAPTER_VERSION,
};
