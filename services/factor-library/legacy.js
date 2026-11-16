'use strict';

/**
 * 旧规则因子一次性补登记（研究框架修订 2026-11-16 草稿 ddeb2eea §2.4；P0）。
 *
 * 只登记现行规则已经在用的读数，origin = LEGACY_RULE；不重新判定，只作去重的基准与「现有账本」（§4 第 6、7 项）的组成。
 * 每条绑定钉版提交上的源文件（repo、commit、path、sha256），并写出从源文件读到的字段值（extract）：
 *   JSON_POINTER = 源 JSON 在该指针处的值（深相等）；TEXT = 源文件逐字包含这一段（代码里的算式）。
 * 测试与 build.js 用 git show（只读，不 checkout）逐条核对；读不到的写进 unverified[]，不猜。
 *
 * 钉版：Ashare-V6 origin/main 83ab3af1（协调会话 11-16 指定）；smartflow origin/main 3b25fb61（2026-11-16 读，us-v5-sector-rs.js 最后改动 6346d8d8）。
 * 本文件是因子库 JSON 的唯一数据来源之一，改这里再由 build.js 写出 config/research_factor_library.v1.json；JSON 不手改。
 */

const V6 = Object.freeze({ repo: 'ashare-v6', commit: '83ab3af185c86cd2a21269ce918e49017f8876b3' });
const SF = Object.freeze({ repo: 'smartflow', commit: '3b25fb61ceffb0ed3437a6f6746ed66bf7150955' });
const REGISTERED_AT = '2026-11-16T23:26:44+08:00';
const REGISTERED_BY = 'claude-agent rf1116-p0（协调会话 11-16 23:1x 批准 P0）';

const ptr = (pointer, value) => Object.freeze({ kind: 'JSON_POINTER', pointer, value });
const txt = (contains) => Object.freeze({ kind: 'TEXT', contains });
const bind = (base, role, path, sha256, extract, entry = null) => Object.freeze({ repo: base.repo, commit: base.commit, path, sha256, role, entry, extract: Object.freeze(extract) });

// ── 源文件（sha256 为钉版提交上 git show 的字节） ────────────────────────────────
const P = Object.freeze({
  STOCK_BOOK: ['config/v6/research/stock_book_five_stage_v4.json', '55b818a1b62b1cfa767d5eec28c2f23190c6a51c56895eebeccbefd7bf05077a'],
  MAINLINE: ['config/v6/research/mainline_ranking_v7.json', '69a9471a61fe8963990dd6e1c46948a16a377a9c946b39bc29628445084f6ea8'],
  CORE_MOM: ['config/v6/research/core_pool_stock_momentum_transform_v2.json', '030a96a4516d4760983318ea3f058603e2847bda37336d71432304e0bef5225a'],
  REVISION: ['config/v6/research/analyst_revision_aggregation_v2.json', '58ecf8c608c05ec342e31f9f6ab64d397e2f874d750633bac9a5cecb43379054'],
  INDEX_SECTOR: ['config/v6/research/index_sector_selection_v3.json', '08ab7c3675e8a755e80005d5cc112113ee08ab7df392ec98d4ec61b59a6ef338'],
  ETF_MOM: ['config/v6/research/etf_realized_momentum_transform_v1.json', '0532937f1f76ef444e4993eaef7ffa25808ff292897fb7bc84a23396bda50e1f'],
  SHORTLIST: ['src/stock-book/five-stage/shortlist.js', '36e4f21e0c4e298b973ee2d2c4429bafe57688f584ca3506400a481e78134c25'],
  MAINLINE_JS: ['src/stock-book/five-stage/mainline-ranking.js', '751ce5e0975e6ee7077977735ac38d2845f261657c4a58e5d6669ee4f6576c07'],
  FEATURES_JS: ['src/data-runtime/feature-stock-type.js', 'c3d99d489d175049e9ba6ecca0965ca16b11e7064ab80eae91e6f635af064e6e'],
  REVISION_JS: ['src/research/shared/analyst-revision/revision-breadth.js', '36e0abf15cb57b969900f137f322dc67a564678c7dc709602b354a9a6494fa6a'],
  CONFIG_JS: ['src/kernel/config/research-configuration.js', 'dc0ad905e022737fc2b05d20215ecd9d4676cdc39e099d44c8e7937da0e03550'],
  PRICE_MOM_JS: ['src/index-book/price-momentum.js', 'c4177674abd9903a54879786f14b267e434b12164c5029a3ecb56fb7e45e5292'],
  A23_JS: ['trading-system-v2/src/services/us-v5-sector-rs.js', '1023e87d9d19d5873133ce257a4f87b03c5195223847b04ef13df3f2eef2beff'],
  S17: ['trading-system-v2/config/production-parameter-versions.json', 'e142f593256cd4fe7f36699c4814e5ba6b0236d41a0d06d0dff10acfba517a03'],
});
const v6 = (key, role, extract, entry) => bind(V6, role, P[key][0], P[key][1], extract, entry);
const sf = (key, role, extract, entry) => bind(SF, role, P[key][0], P[key][1], extract, entry);

// ── 共用的字段 ─────────────────────────────────────────────────────────────────
const NOT_COMPUTED = Object.freeze({ state: 'NOT_COMPUTED', reason_zh: 'P0 不读真实行情：库内因子之间的相关性在 P1 有了参考样本段与计算代码 sha 之后再算' });
const BASELINE = Object.freeze({ decision: 'LEGACY_BASELINE', reason_zh: '旧规则因子是去重基准，不参加去重、不重新判定（§2.4）' });
const NOT_REJUDGED = Object.freeze({ state: 'NOT_REJUDGED', refs: Object.freeze([]) });
const NO_HORIZON = (note) => Object.freeze({ trading_days: null, state: 'NOT_DEFINED_BY_SOURCE', note_zh: note });
const LOGIC_UNVERIFIED = Object.freeze({ field: 'economic_logic_zh', reason_zh: '源文件没有写经济逻辑（只写明这是已实现读数、不是收益预测）；这一句由补登记概括，待协调会话核对' });

const STOCK_UNIVERSE = Object.freeze({
  id: 'V6_STOCK_BOOK_FIVE_STAGE_CANDIDATES', version: 'STOCK_BOOK_FIVE_STAGE@v4-portfolio-construction',
  definition_zh: '五段个股簿 ③ 候选：已准入主线单元（MAINLINE_RANKING）的成员，过可交易预筛（CANDIDATE_PREFILTER v1 去掉 PE_TTM）、成员冲突剔除、来源核对准入；打分只给候选，百分位口径各条另写',
});
const STOCK_RULE = Object.freeze({ key: 'STOCK_BOOK_FIVE_STAGE', version: 'v4-portfolio-construction', authority_state: 'APPROVED_FOR_SHADOW',
  effective_from: '2026-10-15', effective_to: null, note_zh: '影子 / 模拟簿记录（bindingCapital false、realOrder 0），不动真实资金' });
const STOCK_HORIZON = NO_HORIZON('STOCK_BOOK_FIVE_STAGE v4 不定持有期（exits.TIME_STOP = NOT_APPLICABLE，按出场规则离场）');
const PIT_DAILY = 'T 日收盘后：V6 特征运行只取 firstAvailableAt ≤ decisionCutoff（known-at）的日线行，前复权后按窗口算（feature-stock-type.js）';
const PIT_SCOPE_UNVERIFIED = Object.freeze({ field: 'universe', reason_zh: 'shortlist 的输入 universe（Map 证券 → 特征行）由 shadow-runtime.js 组装，组装范围本次未追读' });

const UNIT_UNIVERSE = Object.freeze({
  id: 'V6_MAINLINE_UNITS_SW2021_L2', version: 'MAINLINE_RANKING@v7-no-finmap-heat-bonus',
  definition_zh: '申万 2021 二级行业单元（当日没有二级成员时退一级；过预筛成员不足 8 只并入一级母行业残差；成员 = 过预筛且有特征行的证券；属两个以上单元的证券不属任何单元）',
});
const UNIT_RULE = Object.freeze({ key: 'MAINLINE_RANKING', version: 'v7-no-finmap-heat-bonus', authority_state: 'APPROVED_FOR_SHADOW',
  effective_from: '2026-11-17', effective_to: null,
  note_zh: 'v7 自 2026-11-17 生效；前一版 v6（2026-10-29 → 2026-11-17）的 features 与 score.weights 与 v7 逐字相同，v7 只去掉 finmap 热度加分' });
const UNIT_HORIZON = NO_HORIZON('MAINLINE_RANKING 是日度准入排序，不定持有期');

const stockLegacy = (o) => Object.freeze({
  market: 'CN_A', layer: 'SELECTION_CROSS_SECTION', universe: STOCK_UNIVERSE, class_reason_zh: null, pit_available_at: PIT_DAILY, horizon: STOCK_HORIZON,
  origin: 'LEGACY_RULE', mining: null, status: 'LIVE_IN_RULE', mechanism_id: null, correlation: NOT_COMPUTED, dedupe: BASELINE, evidence: NOT_REJUDGED,
  rule_ref: STOCK_RULE, weight_in_rule: null, composite: null, ...o,
});
const unitLegacy = (o) => stockLegacy({ universe: UNIT_UNIVERSE, horizon: UNIT_HORIZON, rule_ref: UNIT_RULE, ...o });
const stockWeight = (component, weight) => Object.freeze({ composite_factor_id: 'CN_A.COMPOSITE.STOCK_BOOK_V4', rule_component: component, weight });
const unitWeight = (component, weight) => Object.freeze({ composite_factor_id: 'CN_A_IND.COMPOSITE.MAINLINE_SCORE_V7', rule_component: component, weight });
const SHORTLIST_FORMULA = 'CF:ashare-v6:src/stock-book/five-stage/shortlist.js#buildFiveStageShortlist';
const MAINLINE_FORMULA = 'CF:ashare-v6:src/stock-book/five-stage/mainline-ranking.js#buildMainlineRanking';

const FACTORS = Object.freeze([
  // ── ③ 复合分的六个分量（STOCK_BOOK_FIVE_STAGE v4 composite.weights） ──
  stockLegacy({
    factor_id: 'CN_A.MOM.RS60_MARKET_PCT', class: 'MOMENTUM',
    definition_zh: 'RS_MARKET = 100 × relative_strength_60 在 shortlist 输入 universe 全体证券上的平均秩百分位（[0,1]，并列取平均秩）；relative_strength_60 = 前复权收盘价 60 行窗口末值 ÷ 首值 − 1，是股票自身收益，不相对基准',
    formula: SHORTLIST_FORMULA, inputs: ['V6_FEATURE:relative_strength_60'],
    economic_logic_zh: '中期价格动量：过去约 60 个交易日涨得多的股票，相对强势倾向延续',
    weight_in_rule: stockWeight('RS_MARKET', 0.3),
    source: v6('STOCK_BOOK', 'RULE_RECORD', [ptr('/payload/composite/weights/RS_MARKET', 0.3)]),
    code_refs: [
      v6('SHORTLIST', 'CODE', [txt('const rs60Pct = percentileMap(securityIds.map((id) => [id, finite(universe.get(id)?.relative_strength_60)]));'),
        txt('RS_MARKET: rs60Pct.has(id) ? 100 * rs60Pct.get(id) : null,')], 'buildFiveStageShortlist'),
      v6('FEATURES_JS', 'CODE', [txt("createWindow('relative_strength_60', 60, 'RETURN', 'RATIO');"), txt("else if (calculate === 'RETURN') value = values.at(-1) / values[0] - 1;")], 'buildFeatureRecordsWithWindowReasons'),
    ],
    unverified: [LOGIC_UNVERIFIED, PIT_SCOPE_UNVERIFIED],
  }),
  stockLegacy({
    factor_id: 'CN_A.MOM.RS20_UNIT_PCT', class: 'MOMENTUM',
    definition_zh: 'LEADERSHIP = 100 × relative_strength_20 在同一主线单元的 ③ 候选之内的平均秩百分位；relative_strength_20 = 前复权收盘价 20 行窗口末值 ÷ 首值 − 1',
    formula: SHORTLIST_FORMULA, inputs: ['V6_FEATURE:relative_strength_20'],
    economic_logic_zh: '主线内的领涨度：同一行业单元里近 20 个交易日涨得多的股票是资金先选中的龙头',
    weight_in_rule: stockWeight('LEADERSHIP', 0.2),
    source: v6('STOCK_BOOK', 'RULE_RECORD', [ptr('/payload/composite/weights/LEADERSHIP', 0.2)]),
    code_refs: [
      v6('SHORTLIST', 'CODE', [txt('for (const [id, pct] of percentileMap(ids.map((id) => [id, finite(universe.get(id)?.relative_strength_20)]))) leadership.set(id, pct);'),
        txt('LEADERSHIP: leadership.has(id) ? 100 * leadership.get(id) : null,')], 'buildFiveStageShortlist'),
      v6('FEATURES_JS', 'CODE', [txt("createWindow('relative_strength_20', 20, 'RETURN', 'RATIO');")], 'buildFeatureRecordsWithWindowReasons'),
    ],
    unverified: [LOGIC_UNVERIFIED],
  }),
  stockLegacy({
    factor_id: 'CN_A.QUALITY.STRUCTURAL_SCORE', class: 'QUALITY',
    definition_zh: 'QUALITY = 该股 stockTypes 的 structuralScore（有 primaryType 且为有限数时，原值，不再取百分位）；structuralScore 由 STOCK_TYPE_COMPONENT_TRANSFORM 按股票类型打分',
    formula: SHORTLIST_FORMULA, inputs: ['V6_STOCK_TYPE:structuralScore'],
    pit_available_at: 'T 日收盘后：structuralScore 由同一次 V6 特征运行（decisionCutoff）产出；其中财报类输入按 firstAvailableAt ≤ decisionCutoff 截断',
    economic_logic_zh: '按股票类型的结构质量分：经营质量与成长结构好的公司更值得持有',
    weight_in_rule: stockWeight('QUALITY', 0.2),
    source: v6('STOCK_BOOK', 'RULE_RECORD', [ptr('/payload/composite/weights/QUALITY', 0.2)]),
    code_refs: [v6('SHORTLIST', 'CODE', [txt('QUALITY: type.primaryType && finite(type.structuralScore) != null ? type.structuralScore : null,')], 'buildFiveStageShortlist')],
    unverified: [
      { field: 'definition_zh', reason_zh: 'structuralScore 的构成（stock_type_component_transform_v2.json 与 feature-stock-type.js buildStockTypeScore）本次没有逐项读；class 按 shortlist 的分量名 QUALITY 登记，未按构成核对' },
      { field: 'pit_available_at', reason_zh: '财报类输入的 firstAvailableAt 是否就是公告日，未核实（草稿 §9 第 3 条）' },
      LOGIC_UNVERIFIED,
    ],
  }),
  stockLegacy({
    factor_id: 'CN_A.GROWTH.NETPROFIT_YOY_PCT', class: 'OTHER', class_reason_zh: '成长（净利润同比增速）不在七类之内',
    definition_zh: 'EARNINGS = 100 × netprofit_yoy 在 shortlist 输入 universe 全体证券上的平均秩百分位；netprofit_yoy 取 firstAvailableAt ≤ decisionCutoff 的最新报告期',
    formula: SHORTLIST_FORMULA, inputs: ['V6_FUNDAMENTAL:netprofit_yoy'],
    pit_available_at: '财报读数：V6 特征运行只取 firstAvailableAt ≤ decisionCutoff 的财报行，按报告期取最新（feature-stock-type.js）',
    economic_logic_zh: '盈利增长：净利润同比增速高的公司，基本面在改善',
    weight_in_rule: stockWeight('EARNINGS', 0.1),
    source: v6('STOCK_BOOK', 'RULE_RECORD', [ptr('/payload/composite/weights/EARNINGS', 0.1)]),
    code_refs: [
      v6('SHORTLIST', 'CODE', [txt('const earningsPct = percentileMap(securityIds.map((id) => [id, finite(universe.get(id)?.netprofit_yoy)]));'),
        txt('EARNINGS: earningsPct.has(id) ? 100 * earningsPct.get(id) : null,')], 'buildFiveStageShortlist'),
      v6('FEATURES_JS', 'CODE', [txt("const FUNDAMENTAL_FEATURES = Object.freeze(['roe', 'roic', 'netprofit_yoy', 'tr_yoy', 'grossprofit_margin', 'netprofit_margin', 'debt_to_assets', 'ocf_to_or']);"),
        txt("&& normalizeInstant(row.firstAvailableAt, 'fundamentalFirstAvailableAt') <= cutoff)")], 'buildFeatureRecordsWithWindowReasons'),
    ],
    unverified: [{ field: 'pit_available_at', reason_zh: '财报行的 firstAvailableAt 是否就是公告日，未核实（草稿 §9 第 3 条）' }, LOGIC_UNVERIFIED, PIT_SCOPE_UNVERIFIED],
  }),
  stockLegacy({
    factor_id: 'CN_A.VALUE.VALUATION_GATE_INV', class: 'VALUE',
    definition_zh: 'VALUATION = 100 × (1 − gateScore)，只在该股估值闸行可评（gateEvaluable）且 gateScore 为有限数时；gateScore 由估值闸记录产出',
    formula: SHORTLIST_FORMULA, inputs: ['V6_VALUATION_GATE:gateScore'],
    pit_available_at: 'T 日收盘后：估值闸行按同一 businessDate 读入 shortlist；估值闸自己的截断规则本次未读',
    economic_logic_zh: '估值：同等条件下估值分位低的股票，未来回报的安全边际更大',
    weight_in_rule: stockWeight('VALUATION', 0.1),
    source: v6('STOCK_BOOK', 'RULE_RECORD', [ptr('/payload/composite/weights/VALUATION', 0.1)]),
    code_refs: [v6('SHORTLIST', 'CODE', [txt('VALUATION: gateEvaluable(gate) && finite(gate.gateScore) != null ? 100 * (1 - gate.gateScore) : null,')], 'buildFiveStageShortlist')],
    unverified: [
      { field: 'definition_zh', reason_zh: 'gateScore 的定义与方向在估值闸记录里，本次没有读；「1 − gateScore 越大越便宜」只按 shortlist 的算式写' },
      { field: 'pit_available_at', reason_zh: '估值闸读数的 PIT 截断未核实' },
      LOGIC_UNVERIFIED,
    ],
  }),
  stockLegacy({
    factor_id: 'CN_A.MAINLINE.UNIT_SCORE', class: 'OTHER', class_reason_zh: '行业单元层的合成分（行业动量、广度、量能、龙头强度）映射到成员股，跨 MOMENTUM 与 VOLUME_PRICE 两类',
    definition_zh: 'MAINLINE = 该股所属主线单元的 mainlineScore（原值，不再取百分位；见 CN_A_IND.COMPOSITE.MAINLINE_SCORE_V7）',
    formula: SHORTLIST_FORMULA, inputs: ['V6_MAINLINE_RANKING:mainlineScore'],
    economic_logic_zh: '所在行业的主线强度：资金集中流入的行业里，成员股更容易走强',
    weight_in_rule: stockWeight('MAINLINE', 0.1),
    source: v6('STOCK_BOOK', 'RULE_RECORD', [ptr('/payload/composite/weights/MAINLINE', 0.1), ptr('/payload/mainlineRecord', 'MAINLINE_RANKING')]),
    code_refs: [v6('SHORTLIST', 'CODE', [txt('MAINLINE: finite(unit.mainlineScore),')], 'buildFiveStageShortlist')],
    unverified: [LOGIC_UNVERIFIED],
  }),
  stockLegacy({
    factor_id: 'CN_A.COMPOSITE.STOCK_BOOK_V4', class: 'OTHER', class_reason_zh: '六个已登记分量的加权合成分，另扣条件罚分；不是单一读数',
    definition_zh: '③ 复合分 = Σ 权重 × 可评分量值 ÷ 可评分量的权重和 − 条件罚分合计（WEAK 10、BLOCKED_BY_RULE 25、NOT_EVALUABLE 5、NOT_APPLICABLE 0），保留 4 位；可评权重份额 < 0.6 的不打分（DATA_INSUFFICIENT）；缺失分量权重为 0、其余按比例放大',
    formula: SHORTLIST_FORMULA,
    inputs: ['QRP_FACTOR:CN_A.MOM.RS60_MARKET_PCT', 'QRP_FACTOR:CN_A.MOM.RS20_UNIT_PCT', 'QRP_FACTOR:CN_A.QUALITY.STRUCTURAL_SCORE',
      'QRP_FACTOR:CN_A.GROWTH.NETPROFIT_YOY_PCT', 'QRP_FACTOR:CN_A.VALUE.VALUATION_GATE_INV', 'QRP_FACTOR:CN_A.MAINLINE.UNIT_SCORE'],
    pit_available_at: '同各分量：T 日收盘后，V6 特征运行 decisionCutoff（known-at）',
    economic_logic_zh: '现行个股簿的选股排序：动量、领涨、质量、盈利、估值、主线六个读数按签署权重合成',
    composite: Object.freeze({
      components: Object.freeze([
        { factor_id: 'CN_A.MOM.RS60_MARKET_PCT', rule_component: 'RS_MARKET', weight: 0.3 },
        { factor_id: 'CN_A.MOM.RS20_UNIT_PCT', rule_component: 'LEADERSHIP', weight: 0.2 },
        { factor_id: 'CN_A.QUALITY.STRUCTURAL_SCORE', rule_component: 'QUALITY', weight: 0.2 },
        { factor_id: 'CN_A.GROWTH.NETPROFIT_YOY_PCT', rule_component: 'EARNINGS', weight: 0.1 },
        { factor_id: 'CN_A.VALUE.VALUATION_GATE_INV', rule_component: 'VALUATION', weight: 0.1 },
        { factor_id: 'CN_A.MAINLINE.UNIT_SCORE', rule_component: 'MAINLINE', weight: 0.1 },
      ]),
      aggregation_zh: '可评分量的权重归一后加权求和，再减条件罚分',
      missing_rule: 'COMPONENT_NULL_WEIGHT_ZERO_RESCALED_PLUS_NAMED_PENALTY', evaluable_share_min: 0.6,
    }),
    source: v6('STOCK_BOOK', 'RULE_RECORD', [
      ptr('/key', 'STOCK_BOOK_FIVE_STAGE'), ptr('/version', 'v4-portfolio-construction'), ptr('/authorityState', 'APPROVED_FOR_SHADOW'),
      ptr('/effectiveFrom', '2026-10-15'), ptr('/effectiveTo', null),
      ptr('/payload/composite/weights', { RS_MARKET: 0.3, LEADERSHIP: 0.2, QUALITY: 0.2, EARNINGS: 0.1, VALUATION: 0.1, MAINLINE: 0.1 }),
      ptr('/payload/composite/evaluableShareMin', 0.6), ptr('/payload/composite/missingInputRule', 'COMPONENT_NULL_WEIGHT_ZERO_RESCALED_PLUS_NAMED_PENALTY'),
      ptr('/payload/composite/rounding', 4), ptr('/payload/penalties', { WEAK: 10, BLOCKED_BY_RULE: 25, NOT_EVALUABLE: 5, NOT_APPLICABLE: 0 }),
      ptr('/payload/exits/TIME_STOP', 'NOT_APPLICABLE'),
    ]),
    code_refs: [v6('SHORTLIST', 'CODE', [txt("const base = round4(components.filter((item) => item.state === 'EVALUATED')"), txt('composite: round4(base - penaltyTotal),'),
      txt('if (share < rule.composite.evaluableShareMin) {')], 'buildFiveStageShortlist')],
    unverified: [{ field: 'evidence', reason_zh: '合成分的选股效果没有任何回测或前瞻记录（源记录 calibrationState UNCALIBRATED_OWNER_SIGNED_PRIOR）；不在 P0 重判' }],
  }),

  // ── ② 主线排序 v7 的四个行业单元特征与合成分（MAINLINE_RANKING features、score.weights） ──
  unitLegacy({
    factor_id: 'CN_A_IND.MOM.INDUSTRY_RS60_PCT', class: 'MOMENTUM',
    definition_zh: 'industry_rs60 = 单元成员 relative_strength_60 的中位数；打分读 industryRs60Pct = 它在当日可评单元上的平均秩百分位；成员缺失份额 > maxMissingShare 时不可评',
    formula: MAINLINE_FORMULA, inputs: ['V6_FEATURE:relative_strength_60'],
    economic_logic_zh: '行业中期动量：过去约 60 个交易日整体涨得多的行业，是资金正在流入的方向',
    weight_in_rule: unitWeight('industryRs60Pct', 0.4),
    source: v6('MAINLINE', 'RULE_RECORD', [ptr('/payload/features/industry_rs60', 'median member relative_strength_60 (own 60-bar return)'),
      ptr('/payload/score/weights/industryRs60Pct', 0.4), ptr('/payload/score/percentileScope', 'EVALUABLE_UNITS_OF_THE_SESSION')]),
    code_refs: [v6('MAINLINE_JS', 'CODE', [txt("industryRs60: value('industry_rs60', rs60, median),"),
      txt('const rs60Pct = percentileMap(evaluable.map((row) => [`${row.source}:${row.code}`, row.computed.values.industryRs60]));')], 'buildMainlineRanking')],
    unverified: [LOGIC_UNVERIFIED],
  }),
  unitLegacy({
    factor_id: 'CN_A_IND.MOM.TREND_BREADTH', class: 'MOMENTUM',
    definition_zh: 'industry_trend_breadth = 单元成员中 close > ma20 的比例（原值进打分，不取百分位）；close 或 ma20 缺失的成员不计',
    formula: MAINLINE_FORMULA, inputs: ['V6_FEATURE:close', 'V6_FEATURE:ma20'],
    economic_logic_zh: '行业趋势广度：多数成分股站上 20 日均线，说明行业的上涨不是少数股票拉动',
    weight_in_rule: unitWeight('industryTrendBreadth', 0.3),
    source: v6('MAINLINE', 'RULE_RECORD', [ptr('/payload/features/industry_trend_breadth', 'share of members with close > ma20'), ptr('/payload/score/weights/industryTrendBreadth', 0.3)]),
    code_refs: [v6('MAINLINE_JS', 'CODE', [txt('return close == null || ma20 == null ? null : (close > ma20 ? 1 : 0);'),
      txt("industryTrendBreadth: value('industry_trend_breadth', trend, (v) => v.reduce((a, b) => a + b, 0) / v.length),")], 'buildMainlineRanking')],
    unverified: [LOGIC_UNVERIFIED],
  }),
  unitLegacy({
    factor_id: 'CN_A_IND.VP.VOLUME_EXPANSION_PCT', class: 'VOLUME_PRICE',
    definition_zh: 'industry_volume_expansion = 单元成员 volume_expansion_5_20（5 日均量 ÷ 20 日均量）的中位数；打分读它在当日可评单元上的平均秩百分位 industryVolumeExpansionPct',
    formula: MAINLINE_FORMULA, inputs: ['V6_FEATURE:volume_expansion_5_20'],
    economic_logic_zh: '行业量能扩张：近一周成交放大，说明增量资金在进场',
    weight_in_rule: unitWeight('industryVolumeExpansionPct', 0.15),
    source: v6('MAINLINE', 'RULE_RECORD', [ptr('/payload/features/industry_volume_expansion', 'median member volume_expansion_5_20'), ptr('/payload/score/weights/industryVolumeExpansionPct', 0.15)]),
    code_refs: [
      v6('MAINLINE_JS', 'CODE', [txt("industryVolumeExpansion: value('industry_volume_expansion', volume, median),"),
        txt('const volPct = percentileMap(evaluable.map((row) => [`${row.source}:${row.code}`, row.computed.values.industryVolumeExpansion]));')], 'buildMainlineRanking'),
      v6('FEATURES_JS', 'CODE', [txt("createWindow('volume_expansion_5_20', 20, 'VOLUME_EXPANSION', 'RATIO');")], 'buildFeatureRecordsWithWindowReasons'),
    ],
    unverified: [LOGIC_UNVERIFIED],
  }),
  unitLegacy({
    factor_id: 'CN_A_IND.MOM.LEADER_RS20_Q90', class: 'MOMENTUM',
    definition_zh: 'industry_leader_rs20 = 单元成员「relative_strength_20 的全市场平均秩百分位」的最近秩分位数，分位水平 q = leaderQuantile 0.9（原值进打分，本身已在 [0,1]）',
    formula: MAINLINE_FORMULA, inputs: ['V6_FEATURE:relative_strength_20'],
    economic_logic_zh: '行业龙头强度：行业里最强的一批股票在全市场排得多靠前，龙头强说明主线有带头者',
    weight_in_rule: unitWeight('industryLeaderRs20', 0.15),
    source: v6('MAINLINE', 'RULE_RECORD', [ptr('/payload/features/industry_leader_rs20', "nearest-rank quantile of members' whole-market percentile of relative_strength_20"),
      ptr('/payload/features/leaderQuantile', 0.9), ptr('/payload/score/weights/industryLeaderRs20', 0.15)]),
    code_refs: [v6('MAINLINE_JS', 'CODE', [txt("industryLeaderRs20: value('industry_leader_rs20', leader, (v) => quantile(v, rule.features.leaderQuantile)),")], 'buildMainlineRanking')],
    unverified: [LOGIC_UNVERIFIED],
  }),
  unitLegacy({
    factor_id: 'CN_A_IND.COMPOSITE.MAINLINE_SCORE_V7', class: 'OTHER', class_reason_zh: '四个已登记行业单元特征的加权合成分；不是单一读数',
    definition_zh: 'mainlineScore = round4(100 × (0.4 × industryRs60Pct + 0.3 × industryTrendBreadth + 0.15 × industryVolumeExpansionPct + 0.15 × industryLeaderRs20))；任一特征不可评（成员缺失份额 > 1/3）的单元整行不可评、分数为 null',
    formula: MAINLINE_FORMULA,
    inputs: ['QRP_FACTOR:CN_A_IND.MOM.INDUSTRY_RS60_PCT', 'QRP_FACTOR:CN_A_IND.MOM.TREND_BREADTH', 'QRP_FACTOR:CN_A_IND.VP.VOLUME_EXPANSION_PCT', 'QRP_FACTOR:CN_A_IND.MOM.LEADER_RS20_Q90'],
    economic_logic_zh: '现行主线排序：行业动量、趋势广度、量能扩张、龙头强度按签署权重合成，回答「钱往哪个方向走」',
    composite: Object.freeze({
      components: Object.freeze([
        { factor_id: 'CN_A_IND.MOM.INDUSTRY_RS60_PCT', rule_component: 'industryRs60Pct', weight: 0.4 },
        { factor_id: 'CN_A_IND.MOM.TREND_BREADTH', rule_component: 'industryTrendBreadth', weight: 0.3 },
        { factor_id: 'CN_A_IND.VP.VOLUME_EXPANSION_PCT', rule_component: 'industryVolumeExpansionPct', weight: 0.15 },
        { factor_id: 'CN_A_IND.MOM.LEADER_RS20_Q90', rule_component: 'industryLeaderRs20', weight: 0.15 },
      ]),
      aggregation_zh: '加权求和乘 100，保留 4 位',
      missing_rule: 'UNIT_NOT_EVALUABLE_WHEN_ANY_FEATURE_MISSING_SHARE_GT_MAX', evaluable_share_min: null,
    }),
    source: v6('MAINLINE', 'RULE_RECORD', [
      ptr('/key', 'MAINLINE_RANKING'), ptr('/version', 'v7-no-finmap-heat-bonus'), ptr('/authorityState', 'APPROVED_FOR_SHADOW'), ptr('/effectiveFrom', '2026-11-17'), ptr('/effectiveTo', null),
      ptr('/payload/score/weights', { industryRs60Pct: 0.4, industryTrendBreadth: 0.3, industryVolumeExpansionPct: 0.15, industryLeaderRs20: 0.15 }),
      ptr('/payload/features/maxMissingShare', 0.3333333333), ptr('/payload/units/standard', 'SW2021'), ptr('/payload/units/level', 'L2'), ptr('/payload/units/minPassingMembers', 8),
    ]),
    code_refs: [v6('MAINLINE_JS', 'CODE', [txt('row.mainlineScore = round4(100 * (w.industryRs60Pct * x.industryRs60Pct + w.industryTrendBreadth * x.industryTrendBreadth'),
      txt("const state = (part) => (n > 0 && part.values.length > 0 && part.missing / n <= maxMissing ? 'READY' : 'NOT_EVALUABLE');")], 'buildMainlineRanking')],
    unverified: [{ field: 'evidence', reason_zh: '主线排序的效果没有回测或前瞻记录（源记录 calibrationState UNCALIBRATED_OWNER_SIGNED_PRIOR）；不在 P0 重判' }],
  }),

  // ── 核心池排序键（CORE_POOL_STOCK_MOMENTUM_TRANSFORM v2）：消费者 CORE_POOL_SELECTION 已退役 ──
  stockLegacy({
    factor_id: 'CN_A.MOM.RS20_REALIZED_CORE_POOL', class: 'MOMENTUM',
    universe: Object.freeze({ id: 'V6_CORE_POOL_ADMITTED', version: 'CORE_POOL_SELECTION@v5-theme-momentum-secondary-tiebreak-shadow',
      definition_zh: '核心池过闸的准入名字（CORE_POOL_SELECTION 的候选）；该记录族已退役' }),
    definition_zh: 'realizedMomentum = 当日特征运行里这只股票的 relative_strength_20（前复权收盘价 20 根首尾相除减 1：adjustedClose[t] ÷ adjustedClose[t−19] − 1），状态 READY 或 DEGRADED 且有限才算，否则 null；是 CORE_POOL_SELECTION 的排序键（首选键 opportunityStrengthScore 恒为 null）',
    formula: 'CF:ashare-v6:src/data-runtime/feature-stock-type.js#buildFeatureRecordsWithWindowReasons', inputs: ['V6_FEATURE:relative_strength_20'],
    economic_logic_zh: '短期价格动量：近 20 个交易日涨得多的股票排在前面（源记录写明是已实现数，不是预期收益）',
    status: 'RETIRED',
    rule_ref: Object.freeze({ key: 'CORE_POOL_STOCK_MOMENTUM_TRANSFORM', version: 'v2-canonical-forward-adjusted-relative-strength-20-shadow', authority_state: 'APPROVED_FOR_SHADOW',
      effective_from: '2026-09-26', effective_to: null,
      note_zh: '变换记录本身未关闭，但它的消费者 CORE_POOL_SELECTION 已退役：四簿修订 20 T4 起不再是 Paper 输入（2026-10-08），核心池 2026-10-09 退役，记录族只保留 v1–v5 存档（research-configuration.js）。同一读数 relative_strength_20 仍在 CN_A.MOM.RS20_UNIT_PCT 与 CN_A_IND.MOM.LEADER_RS20_Q90 里在用' }),
    source: v6('CORE_MOM', 'RULE_RECORD', [ptr('/payload/sourceFeature', 'relative_strength_20'), ptr('/payload/formula', 'REALIZED_SIMPLE_RETURN'),
      ptr('/payload/windowCloses', 20), ptr('/payload/windowSessionsBack', 19), ptr('/payload/adjustment', 'FORWARD_ADJUSTED_TO_LATEST_FACTOR'), ptr('/effectiveTo', null)]),
    code_refs: [
      v6('CONFIG_JS', 'RETIREMENT', [txt('// The core-pool selection (CORE_POOL_SELECTION) was retired by four-book Amendment 20 T4 (not a Paper input from'),
        txt("'v5-theme-momentum-secondary-tiebreak-shadow',")], 'assertRecordFamilyNotRetired'),
      v6('FEATURES_JS', 'CODE', [txt("createWindow('relative_strength_20', 20, 'RETURN', 'RATIO');")], 'buildFeatureRecordsWithWindowReasons'),
    ],
    unverified: [{ field: 'definition_zh', reason_zh: '核心池读这条特征的接线（core-pool-service.js / core-pool-repository.js 的 READY/DEGRADED 规则）未逐行读、未绑定 sha256；算式本身绑在 feature-stock-type.js' }],
  }),

  // ── 分析师上调信号（ANALYST_REVISION_AGGREGATION v2） ──
  stockLegacy({
    factor_id: 'CN_A.SENT.ANALYST_REVISION_BREADTH', class: 'SENTIMENT',
    universe: Object.freeze({ id: 'V6_ANALYST_COVERED_STOCKS', version: 'ANALYST_REVISION_AGGREGATION@v2',
      definition_zh: '有券商覆盖、近 90 个自然日内修正票数够的股票；没有覆盖的记 MISSING，从不记 0' }),
    definition_zh: 'analyst_revision_breadth = (上调票 − 下调票) ÷ (上调 + 下调 + 不变)，票 = 券商 × 季度 × 指标，窗口 90 个自然日；票数 ≥ 3、券商 ≥ 2、分歧份额 ≤ 0.34 才出值，取值 [−1, 1]；用作结构分的排序信号与「修正不恶化」闸（下限 0，缺失即拦）',
    formula: 'CF:ashare-v6:src/research/shared/analyst-revision/revision-breadth.js#aggregateAnalystRevision', inputs: ['V6_RESEARCH_EVIDENCE:report_rc'],
    pit_available_at: 'businessDate 往前 90 个自然日内的券商修正对（report_rc 事实表）；事实表的入库可得时刻本次未读',
    economic_logic_zh: '分析师预期修正的广度：覆盖券商净上调，说明市场对公司盈利的预期在改善',
    rule_ref: Object.freeze({ key: 'ANALYST_REVISION_AGGREGATION', version: 'v2', authority_state: 'APPROVED_FOR_SHADOW', effective_from: '2026-09-21', effective_to: null,
      note_zh: '授权用途 STRUCTURAL_RANK_SIGNAL 与 ACTIVE_GATE_CONDITION；五段个股簿的条件 ANALYST_REVISION 读它' }),
    source: v6('REVISION', 'RULE_RECORD', [ptr('/payload/outputFeature', 'analyst_revision_breadth'), ptr('/payload/outputRange', [-1, 1]), ptr('/payload/voteUnit', 'BROKER_QUARTER_METRIC'),
      ptr('/payload/windowCalendarDays', 90), ptr('/payload/minimumVotes', 3), ptr('/payload/minimumBrokers', 2), ptr('/payload/unchangedInDenominator', true),
      ptr('/payload/maximumConflictShare', 0.34), ptr('/payload/authorizedUses', ['STRUCTURAL_RANK_SIGNAL', 'ACTIVE_GATE_CONDITION']),
      ptr('/payload/activeGate/rule', 'REVISION_NOT_DETERIORATING'), ptr('/payload/activeGate/breadthFloor', 0), ptr('/payload/missingIsNotZero', true)]),
    code_refs: [v6('REVISION_JS', 'CODE', [txt('const denominator = rules.unchangedInDenominator ? total : up + down;'), txt('const value = (up - down) / denominator;')], 'aggregateAnalystRevision')],
    unverified: [
      { field: 'pit_available_at', reason_zh: 'report_rc 事实的入库可得时刻与公告日的关系未核实' },
      { field: 'weight_in_rule', reason_zh: '它在结构分 structuralScore 里的权重在 stock_type_component_transform_v2.json，本次未读' },
      LOGIC_UNVERIFIED,
    ],
  }),

  // ── 行业 ETF 短名单排序键（INDEX_SECTOR_SELECTION v3） ──
  stockLegacy({
    factor_id: 'CN_A_ETF.MOM.SECTOR_ETF_REALIZED_MOM20', class: 'MOMENTUM',
    universe: Object.freeze({ id: 'V6_INDEX_BOOK_SECTOR_ETF', version: 'INDEX_SECTOR_SELECTION@v3-no-policy-gate',
      definition_zh: '指数簿行业袖子（SECTOR）的行业 ETF，过袖子、当日评估、档位 ≥ HALF、sectorEligible、评估质量 READY、行业景气广度六道闸之后的准入名字；宽基不进' }),
    definition_zh: 'realizedMomentum = close(sessionDate) ÷ close(往前 20 个交易日) − 1（ETF 自己的 fund_daily 日线，含当日共 21 根收盘价），降序；只在对所有准入名字都可比时用，否则回退 ladderRank；同分按代码；名额 3',
    formula: 'CF:ashare-v6:src/index-book/price-momentum.js#computeRealizedMomentum', inputs: ['V6_FUND_DAILY:close'],
    pit_available_at: 'T 日收盘后：评估行按 sessionDate 的 fund_daily 收盘价计算；评估行必须是本交易日的（ASSESSMENT_CURRENT）',
    horizon: NO_HORIZON('INDEX_SECTOR_SELECTION 是日度短名单，不定持有期；加档何时由 index-book producer 决定'),
    economic_logic_zh: '行业 ETF 的短期动量：已过闸的行业里，近 20 个交易日涨得最多的先选（源记录写明不是预期收益）',
    rule_ref: Object.freeze({ key: 'INDEX_SECTOR_SELECTION', version: 'v3-no-policy-gate', authority_state: 'APPROVED_FOR_SHADOW', effective_from: '2026-11-17', effective_to: null,
      note_zh: 'v3 自 2026-11-17 生效，只删掉政策闸；排序键与名额沿用 v2（2026-09-26 → 2026-11-17）；窗口长度归 ETF_REALIZED_MOMENTUM_TRANSFORM v1' }),
    source: v6('INDEX_SECTOR', 'RULE_RECORD', [ptr('/payload/appliesToSleeve', 'SECTOR'), ptr('/payload/ranking/keys/0/field', 'realizedMomentum'), ptr('/payload/ranking/keys/0/direction', 'DESC'),
      ptr('/payload/ranking/keys/1/field', 'ladderRank'), ptr('/payload/quota/maxSelectedSectorEtf', 3), ptr('/effectiveFrom', '2026-11-17')]),
    code_refs: [
      v6('ETF_MOM', 'RULE_RECORD', [ptr('/key', 'ETF_REALIZED_MOMENTUM_TRANSFORM'), ptr('/payload/windowSessions', 20), ptr('/payload/formula', 'REALIZED_SIMPLE_RETURN'), ptr('/effectiveTo', null)]),
      v6('PRICE_MOM_JS', 'CODE', [txt('const needed = windowSessions + 1;'), txt("state: 'COMPUTABLE', realizedMomentum: (to.close / from.close) - 1,")], 'computeRealizedMomentum'),
    ],
    unverified: [{ field: 'inputs', reason_zh: 'fund_daily 收盘价是否复权（分红除息日两侧）未核实' }, LOGIC_UNVERIFIED],
  }),

  // ── 美股 A23 行业相对强度（smartflow us-v5-sector-rs.js） ──
  stockLegacy({
    factor_id: 'US_EQUITY_ETF.MOM.SECTOR_RS_EXCESS_63_126', market: 'US_EQUITY', class: 'MOMENTUM',
    universe: Object.freeze({ id: 'US_V5_SECTOR_ETF_13', version: 'US_V5_ETF_3000USD.sectorRs@1',
      definition_zh: '13 支行业 ETF（XLK XLF XLE XLV XLI XLY XLP XLU XLB XLRE XLC SMH XBI），基准 SPY；只作用于纸面账本 US_V5_ETF_3000USD' }),
    definition_zh: 'score = ½ × ex63 + ½ × ex126，ex_k(d) = P(d)/P(d−k) − SPY(d)/SPY(d−k)，k 按 SPY 的 NYSE 交易日；同分先比 ex126 再按单元顺序；d、d−63、d−126 缺收盘价的单元 UNRANKED；前 4 名之外或 UNRANKED 的行业信号被拒',
    formula: 'CF:smartflow:trading-system-v2/src/services/us-v5-sector-rs.js#computeTable', inputs: ['SF_RTH_DAILY:close'],
    pit_available_at: '扫描日 D 只读 D 之前一个 NYSE 交易日的表；表只用该交易日及更早的常规时段收盘价（worker 自己的 Yahoo 1h 线聚合）',
    horizon: NO_HORIZON('A23 是开仓前的行业排序过滤，不定持有期'),
    economic_logic_zh: '行业相对强度：相对大盘超额收益高的行业，资金在持续流入，强势倾向延续',
    mechanism_id: 'SEL.SECTOR_RS.RANK',
    rule_ref: Object.freeze({ key: 'US_V5_ETF_3000USD.sectorRs', version: '1', authority_state: 'S17_RECORDED', effective_from: '2026-11-09T14:00:00.000Z', effective_to: null,
      note_zh: 'US_CRYPTO_PAPER_FULL_RUN_ACCEPTANCE_V1 修订 23（Owner 2026-10-15 签）；机制登记表 U04 / ABL-1 记为 SEL.SECTOR_RS.RANK' }),
    source: sf('A23_JS', 'CODE', [txt("const UNITS = Object.freeze(['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH', 'XBI']);"),
      txt("const BENCHMARK = 'SPY';"), txt('const LOOKBACKS = Object.freeze([63, 126]);'), txt('const WEIGHTS = Object.freeze([0.5, 0.5]);'), txt('const TOP_N = 4;'),
      txt('ex[k] = p.get(session) / p.get(back) - spy.get(session) / spy.get(back);'),
      txt('ranked.sort((a, b) => b.score - a.score || b.ex[tie] - a.ex[tie] || pos.get(a.unit) - pos.get(b.unit));')], 'computeTable'),
    code_refs: [sf('S17', 'PARAMETER_RECORD', [
      ptr('/parameters/US_V5_ETF_3000USD.sectorRs/versions/0/effectiveFrom', '2026-11-09T14:00:00.000Z'),
      ptr('/parameters/US_V5_ETF_3000USD.sectorRs/versions/0/value', { units: ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH', 'XBI'], benchmark: 'SPY', lookbacks: [63, 126], weights: [0.5, 0.5], topN: 4 }),
    ])],
    unverified: [{ field: 'status', reason_zh: '在跑还要 HK 上 worker 开关 US_V5_SECTOR_RS=on（运行环境，不在 git 里）；本次只读源文件，没有核对 HK' }, LOGIC_UNVERIFIED],
  }),
]);

/** 列举到、但不是因子的字段（不登记，写明理由）。 */
const NOT_REGISTERED = Object.freeze([
  { repo: V6.repo, commit: V6.commit, path: P.MAINLINE[0], field: '/payload/features/leaderQuantile', value: 0.9,
    reason_zh: '参数，不是读数：CN_A_IND.MOM.LEADER_RS20_Q90 取的分位水平（mainline-ranking.js quantile(v, rule.features.leaderQuantile)）' },
  { repo: V6.repo, commit: V6.commit, path: P.MAINLINE[0], field: '/payload/features/maxMissingShare', value: 0.3333333333,
    reason_zh: '覆盖守卫，不是读数：一个单元特征的成员缺失份额超过它就记 NOT_EVALUABLE（mainline-ranking.js unitFeatures 的 state），不进打分' },
  { repo: V6.repo, commit: V6.commit, path: P.INDEX_SECTOR[0], field: '/payload/ranking/keys/1', value: 'ladderRank',
    reason_zh: '回退键：档位 FULL = 2、HALF = 1 是 LADDER 闸的同一读数；正常路径上 ASSESSMENT_QUALITY 已挡掉算不出动量的名字，轮不到它' },
  { repo: V6.repo, commit: V6.commit, path: P.STOCK_BOOK[0], field: '/payload/conditions', value: null,
    reason_zh: '条件闸与罚分（PE、量能等），只扣分或拦截，不是截面打分；罚分表记在 CN_A.COMPOSITE.STOCK_BOOK_V4 的 source.extract 里' },
  { repo: V6.repo, commit: V6.commit, path: P.MAINLINE_JS[0], field: 'FAST_GATE_SHADOW.weights', value: null,
    reason_zh: '只在影子臂里的候选 F（industryMedianRs20Pct），没有签署记录用它' },
]);

module.exports = { V6, SF, REGISTERED_AT, REGISTERED_BY, FACTORS, NOT_REGISTERED };
