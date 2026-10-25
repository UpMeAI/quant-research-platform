# US_V5 M2 Q3 · 选对象了吗（Q3a 随机选择对照 + Q3b 行业 RS 排序候选 + 等权参照）· 研究规格 K2 V1

状态：**FROZEN**（2026-10-25，协调会话；研究规格负责人）
草稿来源：smartflow `research/us-v5-m2-q3` 329a2909 `trading-system-v2/docs/US_V5_M2_Q3_SELECTION_K2_DRAFT_V1.md`，sha256 `550237573ac97334f935f67caa33c6f1b3b0c8cbbc1f27f8930b2e5c668f21e5`。正文原样保留；裁定见文末，冲突时以裁定为准。

依据：
- 计划 V1 §2 Q3、§5.1、§5.2、§7。
- 前序：
  - 基线 `Q0-2604282b935f85d3`（`2604282b…`）。
  - `Q1-52d8296ffb10626b`、`Q2-02796a4366aa0263`。
  - 导入规格 V2（QRP `US_V5_M2_COMPARISON_IMPORT_PROFILE_V2.md`，`3ebfeb53…`）。
  - Q2 K2 勘误 1（G1 先判）。
- 已签 RS-1 研究验收（`US_V5_SECTOR_RS_RANKING_RESEARCH_ACCEPTANCE_V1`，签署 2026-10-14T20:02:36+08:00）与 AMENDMENT_23（签署 2026-10-15T00:00:36+08:00）。
- 协调会话 10-25 的 Q3 指示（三部分、不偷看、`random_control` 块）。

## 运行前已核实的事实

**1. 当前 D 怎样在同一扫描的候选之间做选择：**
- 生产 worker（`src/workers/us-v5-strategy-worker.js`）与研究引擎都按标的池文件的序列顺序（`signalSeries`）逐个处理同一扫描时点的信号。名额满时，开仓顺序就是文件顺序，没有排名。
- 只有满仓时的持仓替换按信号分数从高到低问候选。Q0 OOS 的替换意图为 0。

**2. 选择点普查：**
- 定义：同一扫描时点至少一笔开仓，同时另有一个通过全部信号级闸门的同时点候选被容量规则拒绝。容量规则指 BOOK_CAP_FULL、BOOK_NOTIONAL_CAP、CLASS_CAP、PORTFOLIO_RISK、PER_ETF_CAP、风险桶。
- 用基线运行加信号级影子交易匹配来计数，结果如下：

  | 段 | 有两个及以上序列出信号的扫描时点 | 同一时点开两笔以上 | 选择点（上限） | 选择点（影子交易匹配） |
  |---|---|---|---|---|
  | OOS | 384 | 7 | 9 | **7**（7 个交易日） |
  | IS | 203 | 0 | 6 | **2** |

- 名义上限的 54 次拒绝绝大多数是跨时点的：先开的仓占住名额，不是同一时点的二选一。
- 所以按指示原样做的 Q3a，G1（≥ 30 个选择点）在运行前就确定不满足（见读法 1）。

**3. RS-1 与 A23：**
- 规则：13 只行业 ETF（XLK XLF XLE XLV XLI XLY XLP XLU XLB XLRE XLC SMH XBI）对 SPY 的 63 日与 126 日超额收益各占一半作分数，取扫描前一交易日的名次表。不在前 4 或无名次的行业信号拒绝。同一时点的行业候选按名次重排进行业位置。
- 参数在 RS-1 签署时冻结，研究没有拟合。
- RS-1 的 OOS 是 2023-01-01 → 2026-09-30，结果 INSUFFICIENT：
  - 两个相位的 Δ 分别是 −0.093 R / +0.149 R；
  - 随机名次对照在第 59.5 / 68 百分位，低于要求的 75。
- 按 Owner 的「证据不足 → 做 paper 前向」规则进入 A23 前向，所有开关仍关闭。
- 研究模块 `scripts/research/us-v5-sector-rs.js`（`rankTable`、`lineOption`）与生产模块 `src/services/us-v5-sector-rs.js` 都在分支里，引擎已有 `line.sectorRs` 入口。

**4. 等权参照的数据：**
- v3 的 1× 多头 15 只是 VOO、SPMO 与 13 只行业 ETF。修订 1 缓存全部从 2019-06-03 覆盖到 2026-10-23。
- 缓存是只做拆股调整的 Alpaca 30 分钟线，**没有分红**，所以只能算价格收益。SPY 总收益参照照旧用封存的 adjclose。

**5. 不偷看：**
- Q0 / Q2 在同一 OOS 上看到的分类别差异（指数 −1.02 R、单股 2× −0.19 R、行业 +0.41 R）不进入本题的任何规则。
- 类别过滤只写进诊断清单，作为需要新数据或前向数据的后续题。

```yaml
模板身份: US_V5_M2_Q3_SELECTION_V1
原问题与研究槽引用: 计划 V1 §2 Q3（选标的与排序：复杂选股是否优于简单基准；行业 RS 作候选）；Owner 研究要求「选对了对象吗」
研究用途: Q3a = 随机选择对照（三态）；Q3b = 候选比较（一个改动，三态）；等权买入持有 = 参照（只报）
目标:
  市场_策略_账本_模式: US_EQUITY / US_V5_ETF_UNIVERSE_V1 / US_V5_ETF_3000USD / PAPER（真实行情）
  当前D有效版本引用: "US_V5_ETF_3000USD@2382c2d1 (KLINE_TIMING_V1 inert: K2 BAD_PRICE defect, 2026-10-14..fix)"
  原实验冻结基线引用: Q0-2604282b935f85d3 的 arms.D（SCAN_MAIN、生产时间表、5 bps / 边 + 监管费、Q0-F 的 F1–F6 全开），引擎内重现
  代码_参数_开关引用: 研究文件新增选项全部「不设即不变」；生产代码、S17、开关与账本都不动
  选择规则引用: Q3a 把同一扫描候选的处理顺序换成随机；Q3b 加行业 RS 排序层；其余不变
  择时退出规则引用: 不变
  组合风控规则引用: 不变
  信号标的与交易载体: 不变
  工具执行与成本引用: 不变
Q3a_随机选择对照（照指示）:
  改动:
    - 每个扫描时点，把该时点全部信号的处理顺序换成均匀随机排列（Fisher–Yates），再照常过闸门、名额与上限
    - 名额紧张时，谁先拿到名额就是在通过同样闸门的候选里均匀随机选择
    - 满仓时问替换候选的顺序同样随机化（OOS 替换意图为 0，预计不起作用）
    - 载体选择不随机（属于 Q2 的范围）
  种子: 1,000 个，seed_i = 20261025 + i（i = 0…999），运行前固定；每个种子的随机数按扫描时点顺序消耗，可逐字节复现
  每个种子的量:
    - OOS 账户 g = 252 × 日对数收益均值（扣监管费后的日标记；与期末资本同序）
    - OOS 每笔净 R 均值（成熟交易）
  基线位置:
    - share_beaten = (基线 g > 种子 g 的种子数 + ½ × 相等的种子数) / 1,000，相等指差的绝对值 ≤ 1e-12
    - 百分位按同一中位秩；净 R 同样计算
  G1: OOS 选择点 ≥ 30（定义见上文事实 2）；在基线运行上先数，种子运行之前判
  三态（只按账户 g；净 R 的位置照报不判）:
    - G1 不成立: 证据不足（G1_NOT_MET）
    - G1 成立且 share_beaten ≥ 0.75: 有支持证据（同 RS-1 的第 75 百分位门槛）
    - G1 成立且 share_beaten ≤ 0.50: 未通过（不比随机中位数好，边界见读法 3）
    - 其余: 证据不足
Q3a2_随机标的对照（读法 1 选 (b) 时才做）:
  问题: 当前 D 的信号与闸门挑出的标的，是否好过在同一时刻随机挑一个可交易标的
  改动:
    - 账本照常运行；每当某个信号会在某扫描时点开仓（通过全部闸门、名额与上限），把它换成一个随机标的
    - 候选集合: 该时点同方向、能路由到 LONG 载体、通过地板、不在财报屏蔽、未被持有、满足类别 / 风险桶 / 单 ETF 上限的序列
    - 抽取方式: 均匀随机
    - 入场: 该标的载体的扫描报价
    - 止损 / 目标: 用策略自身的日线 ATR 与倍数（us-v5-strategy 的 atrRef、slMult 0.8、tpMult）在该标的扫描窗口上计算，经 computeETFLevels 映射
    - 定仓、名义上限、A4 出场、K3 照当前 D
    - 不施加选择性闸门（RSI 35–65、ADX、K1 形态），因为它们正是被检验的「选择」
  种子: 同上 1,000 个
  选择点: 随机运行里候选集合 ≥ 2 的开仓（预计几乎每笔开仓都是）
  三态: 与 Q3a 相同的 G1 / 0.75 / 0.50 规则
Q3b_行业RS排序候选:
  候选: 基线线加 line.sectorRs = us-v5-sector-rs.lineOption(rankTable(缓存日收盘), { topN: 4 })
    - 规则即 RS-1 §3 / A23 R2: 13 只行业 ETF、SPY 基准、63 / 126 个 NYSE 交易日、各 ½、前 4、无名次拒绝、取扫描前一交易日的表、同一时点行业候选按名次重排
    - 指数、单股 2× 不受影响
  两臂: BASELINE = 当前 D；CANDIDATE_SECTOR_RS = 只多排序层
  引擎改动: 无（runLine 已有 line.sectorRs）；名次表由 RS-1 研究模块从修订 1 缓存的 1h 线算日收盘
  判据（同 Q2 与 Q2 勘误 1，单变体，不做多重比较校正）:
    主: 账户层面配对 g（候选对基线，日对数收益差，按月分块 bootstrap 10,000 次，种子 20261025，95%），δ_g = 0
    G1: 两臂 OOS 成熟交易各 ≥ 30，且改变的入场 ≥ 30（只在一臂出现的「序列 + 扫描时点」入场）
    三态: G1 不成立 → 证据不足；G1 成立时 U_g ≤ 0 → 未通过（F3 式否决）、L_g > 0 → 有支持证据；其余 → 证据不足
    次: 候选臂自身每笔净 R 对 +0.10 R（不判）；两臂同一入场的逐笔 ΔR 与 RS-1 式的「每个改变决定的 Δ」作描述
    敞口: 两臂的平均名义金额、在场时间占比、名义上限拒绝与削减次数，另加 SECTOR_RS_NOT_TOP_N 拒绝数与重排时点数
    措辞: 「有支持证据」= 完整账户的对数增长更好，不等于信号 alpha 更大（AC8）
参照臂（只报，不判）:
  EQUAL_WEIGHT_1X_BUY_HOLD:
    - 标的: v3 的 15 只 1× 多头 VOO、SPMO、XLK、XLF、XLE、XLV、XLI、XLY、XLP、XLU、XLB、XLRE、XLC、SMH、XBI；SH、PSQ 是反向工具，不算买入持有
    - 建仓: OOS 起点前一交易日收盘价，3,000 等分为 15 份，扣 5 bps 一次，不再平衡
    - 估值: 每日收盘
    - 口径: 价格收益，不含分红（缓存没有分红），这一点写进标签
运行门（任一不过 → BLOCKED (ENGINE_PARITY)，不出结论）:
  ACCEPTANCE: 冻结后的本文件 sha256 等于运行器内置值
  INPUTS: 修订 1 缓存清单与三组扫描信号同 Q0
  BASELINE_REPRO: 不设新选项时逐字节复现 Q0 的 arms.D、12 行统计、毛信号与全部压力行
  INERT_Q0F: Q0-F 惰性检查重跑结果不变
  INERT_Q1: 在 Q3 代码上重跑 Q1 运行器，去掉 identity 后与封存的 Q1 结果相同
  INERT_Q2: 在 Q3 代码上重跑 Q2 运行器，去掉 identity 后与封存的 Q2 结果相同
  RANDOM_IDENTITY: 随机顺序选项给定「不打乱」的排列时，账本哈希等于基线
  RS_TABLE_PARITY: 研究模块的名次表与生产模块 src/services/us-v5-sector-rs.js 的排名函数，在同一组缓存日收盘上逐交易日相同（IS + OOS）
  PROBE: scripts/probe-c17-btc-eth-production.js 输出 0
输入:
  冻结数据及内容身份: 与 Q0–Q2 相同（修订 1 缓存、三组扫描信号）；不取新数据
  历史可知假设与覆盖: 同 Q0；13 只行业 ETF 与 SPY 在 2019-06-03 起都有，126 日回看在 2020-01 前已满足（RS-1 DG-1）
  扫描相位与业务日历: 同 Q0
  初始现金_持仓_风险状态: 同 Q0
  共享预算或其他账本依赖: 无
比较:
  问题与机制:
    - Q3a: 当前 D 在同一时点候选之间的选择（实际是文件顺序）是否好过随机
    - Q3a2（若冻结）: 当前 D 的信号与闸门是否挑出了比随机更好的标的
    - Q3b: 加行业 RS 排序层是否改善完整账户
  唯一比较对象或唯一改动: Q3a / Q3a2 = 1,000 个随机种子的分布；Q3b = 排序层一个改动；等权买入持有与 SPY / 现金只作参照
  共同规则与不可避免差异: 同引擎、同输入、同时间表
  数据既往用途与全部尝试:
    - 2023–2026 被 Q0–Q2 与其他 US_V5 研究读过
    - 分类别差异只进诊断清单，不进规则
    - RS-1 用 2023-01-01 → 2026-09-30 评价过同一排序规则（见读法 4）
    - 全部运行都记录
  开发_确认_前向范围:
    IS: 2020-01-02 → 2022-12-30（只报）
    OOS: 2023-01-03 → 2026-10-23（判定）
    前向: 无（A23 未开启，HK 没有排序层前向记录）
判据: 见 Q3a / Q3b 各自的三态；两个结论分开写，互不影响，不做多重比较校正（问题不同）
  适用压力_条件_评价时点:
    Q3b 两臂同跑计划 §5.2 的全部压力行，每行给两臂数字与差值:
      - COST_15BPS、COST_SLIPPAGE_X2、SCAN_PHASE_PLUS_60MIN、WINDOW_2022_01_03_10_31
      - RISK_NO_24H_COOLDOWN、RISK_MAX_POSITIONS_5、RISK_UNIT_90（只报不判）
      - WINDOW_2020_02_19_04_30 与 EXTREME_DOWNTURN_2008: 两臂相同，记缺场景（理由同 Q0）
      - SPY / QQQ 合成补充行: 排序层只作用于行业序列，补充行没有行业信号，两臂相同，照写
    Q3a 不做压力行（对照分布本身是测量）
    评价时点: 结果锁定时
  缺项与不足处理: 缺数不填零；样本不足写证据不足
  待冻结的读法:
    读法1_Q3a的范围:
      (a) 只做指示原样的 Q3a: OOS 选择点 7 个（< 30），G1 运行前已确定不满足，结论必然是证据不足；种子运行只作描述
      (b) Q3a 照做，另加 Q3a2 随机标的对照（定义见上），由 Q3a2 回答「复杂选股是否优于简单基准」
      执行者建议: (b)。Q3a 本身答不了核心问题，因为当前 D 几乎没有同一时点的选择；Q3a2 的选择点是每一笔开仓
    读法2_G1不成立时Q3a是否跑种子:
      (a) 跑 200 个种子作描述（RS-1 D13 允许「太慢则 200 次」）
      (b) 不跑，只报普查
      执行者建议: (a)，成本约 40 分钟
    读法3_未通过的边界（指示只给了 0.75 的支持门槛）:
      (a) share_beaten ≤ 0.50 判未通过（不比随机中位数好），0.50 到 0.75 之间是证据不足
      (b) 二分: < 0.75 一律判未通过
      执行者建议: (a)。随机对照只有一条历史路径，介于中位数与 75 分位之间不足以否定
    读法4_Q3b的样本外复用（AC5）:
      (a) oos_reuse: false。排序参数在 RS-1 签署时冻结，没有用该段数据挑选；进入 A23 前向是按「证据不足 → 前向」的常设规则，不是因为结果好。另在 oos_reuse_detail 写明 RS-1 已在 2023-01-01 → 2026-09-30 评价过同一规则，本题是在当前 D 上复测
      (b) oos_reuse: true（原因码 OOS_REUSED_FOR_SELECTION）。把「同一规则已在同一窗口评价过、并据此进入前向」算作复用
      执行者建议: (a)，与 Q1（T3 是看了这段点估计后选出的领先变体）的情形不同；由协调会话裁定
采用边界:
  原流程或决定引用: 当前 D 照自己的规则运行；排序层的上线已由 A23 签署为前向验证，开关仍关，本题不改动它；任何采用都走 US_CRYPTO_PAPER_FULL_RUN 修订加 Owner 签字
  允许输出:
    研究引擎选项: line.randomOrder（Q3a）；读法 1 选 (b) 时加 line.randomInstrument（Q3a2）
    结果文件 US_V5_M2_Q3_RESULT_V1.json 与 .sha256
    固定报告 docs/US_V5_M2_Q3_RESULT_V1.md
    回执
  生产或交易写入: 不允许；本题不需要 HK
```

## 结果文件（`US_V5_M2_Q3_RESULT_V1.json`，导入规格 V2 的布局）

- **身份与顶层：**
  - `identity.schema: US_V5_M2_Q3_RESULT_V1`，`result_kind: CHALLENGER_VS_BASELINE`，`baseline_result_id`、`k2`、`smartflow_commit`、`engine_files`。
  - `arms`：`BASELINE`、`CANDIDATE_SECTOR_RS`、`SPY_BUY_HOLD`、`CASH`、`EQUAL_WEIGHT_1X_BUY_HOLD`（`reference: true`，标签写「价格收益，不含分红」）。
  - `stats` / `stress`：同 Q2，两臂。
- **`comparison`（Q3b）：**
  - `question_zh`、`candidate_label_zh`；
  - `g_vs_baseline {value, ci_95}`；
  - `criteria {G1: {met, baseline_oos_trades, candidate_oos_trades, changed_entries}, P_G, F3}`；
  - `secondary {literal, paired}`；
  - `exposure`（同 Q2 键名，另加 `sector_rs_refusals`、`reorder_instants`）；
  - `routing` 不适用，不写。
- **`verdict`：** `class: CANDIDATE_COMPARISON_V1`，即 Q3b 的结论。
- **`random_control`（新增，Q3a，读法 1 选 (b) 时含 Q3a2）：**
  - `seeds {rule, n, first, last}`；
  - `choice_points {definition_zh, oos, is, rows}`；
  - `distribution {g: 分位数表, net_R: 分位数表}`；
  - `baseline {g, net_R, share_beaten_g, share_beaten_net_R, percentile_g}`；
  - `verdict {class: RANDOM_SELECTION_CONTROL_V1, state, rule, reason_codes}`；
  - Q3a2 另有同构的 `random_instrument` 子块。
- **其余字段：**
  - `forward: { rows: [], reason_zh: 'A23 未开启，HK 没有排序层前向' }`；
  - `oos_reuse` 按读法 4；
  - `diagnosis_items` 含「类别过滤（需新数据或前向数据）」与选择点普查；
  - 不写 `attribution`。

**导入规格 V2 缺的部分：**
- **登记项：** 没有 Q3。需要写入 K2 sha、候选臂键 `CANDIDATE_SECTOR_RS`、判据集 G1 / P_G / F3、δ_g 0 与 δ_R 0.10、`oos_reuse` 期望值（按读法 4）、`attribution` 不要求、`exposure` 要求。
- **`random_control` 块：** 没有对应读法。需要定义块的形状、它自己的结论类 `RANDOM_SELECTION_CONTROL_V1` 与三态门槛（G1 选择点 ≥ 30、0.75 / 0.50），以及它与 `verdict`（Q3b）分开显示、互不覆盖的规则。
- **参照臂：** 第五个参照臂 `EQUAL_WEIGHT_1X_BUY_HOLD` 的展示与「不含分红」标签。V2 的臂校验只读四个臂，多出的臂会被忽略。

## 执行者估计

- **工作量：**
  - Q3a 是一个随机顺序选项，加选择点普查。
  - Q3a2 要为随机标的算入场与价位（复用策略自身的 ATR 与 computeETFLevels），并定义候选集合。
  - Q3b 不改引擎，只加名次表与 RS_TABLE_PARITY 门。
- **运行：**
  - 两个 Q3b 臂约 15 分钟，INERT_Q1 / INERT_Q2 重跑约 20 分钟。
  - Q3a2 的 1,000 个种子每个约 12–15 秒。两个进程并行约 1.7 小时，逐字节复核再跑一遍，合计约 3.5 小时。
  - 读法 2 选 (a) 时，Q3a 再加 200 个种子约 40 分钟。
- **风险：**
  - Q3a2 的随机标的在单股 2× 上要过财报屏蔽，候选集合随时点变化，普查照报。
  - 价格收益的等权参照会低估行业 ETF 的总收益，标签写明。


## 协调会话裁定（冻结时）

1. **范围选 (b)。**
   - Q3a 照做：候选处理顺序随机化。其选择点普查（OOS 7 个、IS 2 个）运行前已确定 G1 不成立，结论按规则为 `INSUFFICIENT`。
   - 另加 Q3a2：D 每次真要开仓时，改为从当时可交易的同方向标的里均匀随机挑一个，不加选择性闸门（RSI 35–65、ADX、K1 形态）。由 Q3a2 回答「复杂选股是否优于简单基准」，即这套信号加闸门的选法能否胜过随机挑选。
   - 两者使用同一组种子（20261025 + i，共 1,000 个）和同一门槛，结论分开写。
2. **Q3a 在 G1 不成立时选 (a)**：跑 200 个种子作描述，不判。
3. **判定边界选 (a)**：基线账户 g 胜过的种子比例（相等算一半）≥ 0.75 → `SUPPORTED`；≤ 0.50 → `NOT_PASSED`；其余 → `INSUFFICIENT`。G1 先判（Q3a2 的选择点即每笔开仓，需 ≥ 30）。净 R 的位置照报，不判。
4. **Q3b 选 (a)**：`oos_reuse: false`，另加原因码 `OOS_PREVIOUSLY_EVALUATED_SAME_RULE`，写明 RS-1 已在同一窗口评价过同一规则（INSUFFICIENT，随机对照在第 59.5 / 68 百分位），本题是在当前 D 上的复测。结论不因此封顶。页面写「同窗复测，不是新的样本外」。判定同 Q2 加勘误 1。
5. **参照臂**：15 只 1× 多头等权买入持有，只报不判，标签写「价格收益，不含分红」。
6. **结果文件**：沿用导入规格 V2 的布局，候选臂键 `CANDIDATE_SECTOR_RS`。另加两块：
   - `random_control`：包含 Q3a 与 Q3a2，各自给种子数、统计量、分布分位数、G1 普查、结论，类别为 `RANDOM_SELECTION_CONTROL_V1`；
   - `reference_arms.EQUAL_WEIGHT_1X_BUY_HOLD`。
   - 两块都由 QRP 实现会话在登记项里补读法，页面上与 Q3b 的结论分开显示。
7. **运行与并行**：
   - Q3a2 的 1,000 个种子及逐字节复核经 `heavy-run` 在后台跑。
   - 后台运行期间，起草 Q4 的 K2（题目已定：「被闸门拒绝的信号不武装 24 h 冷却」），完成后停一次等冻结。Q4 的运行排在 Q3 封存之后。
8. **停止点**：Q3 封存与试导入后停下，等协调会话自查与导入。
