# US_V5 M2 Q1 · T3（TREND 期间推迟 TIME stop）对当前 D · 研究规格 K2 V1

状态：**FROZEN**（2026-10-25，协调会话；研究规格负责人）
草稿来源：smartflow `research/us-v5-m2-q1` a9d15b5d `trading-system-v2/docs/US_V5_M2_Q1_T3_DEFERRED_TIME_STOP_K2_DRAFT_V1.md`，sha256 `3b45706dffd770003317371480e7fe58fced558c62332c572f04a9bc0dec680c`。正文原样保留；裁定见文末，冲突时以裁定为准。

依据：
- 计划 V1 §2 Q1、§5.1、§5.2、§5.3、§7（QRP `docs/contracts/US_V5_M2_RESEARCH_PROGRAM_V1.md`），修订 1 M1.x（Q0 是 Q1–Q4 的原版基线）。
- 已签 T3 验收 `US_V5_TIME_STOP_VS_TREND_EXIT_RESEARCH_ACCEPTANCE_V1.md`（smartflow 896b7cd4，sha256 `6b9d2ff4…e153`）的 §3–§6。
- 前序：
  - 基线结果 `Q0-2604282b935f85d3`：`US_V5_M2_Q0_RESULT_V1.json`，sha256 `2604282b…`，smartflow research/us-v5-m2-q0f b9b85c64。
  - Q0-F K2：QRP `US_V5_M2_Q0F_ENGINE_ALIGNMENT_K2_V1.md`，sha256 `4048ff11…`。

```yaml
模板身份: US_V5_M2_Q1_T3_DEFERRED_TIME_STOP_V1
原问题与研究槽引用:
  - 计划 V1 §2 Q1
  - Q0 诊断项 D-ENTRY-EXIT-TIME：OOS 111 笔成熟交易中 23 笔以 TIME 退出，平均 +0.8678 R，合计 886.52 USD
  - T3 验收 6b9d2ff4…：结果 e90ed385 判 INSUFFICIENT，T3 点估计领先；HK 前向影子 B、S 两条流自 2026-10-05 运行
研究用途: 候选比较。只有一个改动；原版与候选各跑完整账户。不调参，不加变体
目标:
  市场_策略_账本_模式: US_EQUITY / US_V5_ETF_UNIVERSE_V1 / US_V5_ETF_3000USD / PAPER（真实行情）
  当前D有效版本引用: "US_V5_ETF_3000USD@2382c2d1 (KLINE_TIMING_V1 inert: K2 BAD_PRICE defect, 2026-10-14..fix)"
  原实验冻结基线引用:
    result_id: Q0-2604282b935f85d3
    基线臂: arms.D
    口径: SCAN_MAIN、生产时间表 10:04 / 12:04 / 14:04 ET、5 bps / 边 + 监管费
    引擎: Q0-F 的 F1–F6 全开（scan、pickCarrier、derisk PRODUCTION_REALIZED_LOOKBACK、kline K1 / K3 / K2 触发单元）
    K 线: K2 按生产缺陷运行（约 70% 为 BAD_PRICE）
    说明: 2026-10-25 起的 K 线修复属于 D v2；Q1–Q4 仍只对照 D@2382c2d1
  代码_参数_开关引用: 研究文件新增选项全部「不设即不变」（见下文「引擎改动」）。生产代码、S17、开关与账本都不动
  选择规则引用: 不变
  择时退出规则引用: 唯一改动 = TREND 模式仓位的 TIME 时钟按 T3 处理（见下文「改动」）
  组合风控规则引用: 不变（A17 3000 / 60 / 3 仓、U1(b) 名义上限、derisk、S17 持仓替换 S）
  信号标的与交易载体: 不变
  工具执行与成本引用: 不变（5 bps / 边 + stand-alone 监管费；TIME 出场按扫描时点最新收盘价成交，与当前 D 相同）
改动:
  T3（沿用验收 §3.1 原文语义）:
    - 规则: A4 时钟到期时，只有最近一次日线读数不是 TREND（或读数未知）才退出；读数为 TREND 时推迟，之后在每个扫描时点复查
    - 作用范围: 只作用于 TREND 模式仓位。当前 D 的信号与 K2 触发都是 TREND，非 TREND 仓位数照报
    - 读数:
        函数: 生产 us-v5-holding-swap dailyRead
        输入: 信号序列已完成的 session
        时点: 每个 session 一次，取当天第一个扫描时点（10:04 ET，该时点之前已完成的 1h bar）
        hurstOscThreshold: 取策略自身的值
        未知读数: 不推迟，并把连续计数归零
    - 「每根 bar 复查」的对应: 当前 D 只在扫描时点检查退出（Q0-F F3），所以复查也在每个扫描时点
    - 同一时点的检查顺序（沿用 Q0-F 的 scanExits）: 先查自上次检查以来 bar 上的止损 / 止盈（价位成交，跳空按开盘价），再查 TIME（T3），最后对未退出仓位执行 K3
    - 止损 / 止盈 / K1 / K3 / 冷却 / 持仓替换: 一律不变
  候选臂: 基线 line 加 timeStop { rule T3, shadow false }，账本按 T3 运行
  孪生运行: 基线 line 加 timeStop { rule T3, shadow true }，账本不变
    孪生构成: 每笔账本交易一个孪生，入场时点、价格、止损、止盈、模式都相同；在账本外按 T3 退出
    孪生 R: (出场 × (1 − slip) − 入场) / (入场 − 初始止损)；不含监管费，与验收 §4.1 的 shadowAll 公式相同
    ΔR_i: R_孪生(T3) − R_孪生(T0)。两者口径相同，所以 ΔR 不受费用影响
引擎改动（只改研究文件；不设即不变）:
  E1_TIMESTOP_WITH_SWAP_AND_SCAN: 取消 runLine 里 timeStop 与 line.swap / line.scan 不能同用的限制（现在抛出 'timeStop needs A4 exits and holds, no swap'）。仍要求 A4 exits 与 holds。持仓替换模块不改：推迟中的仓位照常可以被替换出去，替换次数按臂分别报告（Q0 OOS 的替换意图为 0）
  E2_SCAN_TIME_RULE: scanExits 在 liveTS 时用 tsTimeDue 代替 timeDue；成交价仍取最新收盘价；记录推迟起点与推迟的 session 数
  E3_SCAN_READS: tsReadStep 挂在扫描时间线的换日钩子上（当天第一个扫描时点）；dailyRead 只读该时点之前已完成的 1h bar
  E4_SCAN_TWINS:
    - 孪生在每个扫描时点按 scanExits 的同一套步骤退出：自孪生上次检查以来 walkBarsExit，6 h 陈旧保护，规则自己的 TIME 按最新收盘价，再执行 K3 收紧
    - US_V5_KLINE_VOLUME 未设，减半路径关闭
    - K3 的内存记录按孪生自己的 key 存，不与账本仓位共用
    - 账本仓位因持仓替换退出后，孪生继续在账本外运行
  E5_SCAN_SHADOW_ALL（只在读法 1 选 (b) 时实现）:
    - 范围: 每个在扫描时点通过闸门的 TREND BUY 信号，由 pickCarrier 路由到 LONG 载体，同一载体同时只开一笔
    - 不受这些约束: 账本仓位上限、同序列持有、类别 / 风险桶上限、熔断、敞口、单 ETF 上限、持仓替换
    - 闸门照用当前 D 的扫描时点规则: 开盘 15 分钟屏蔽、K1 否决、RSI 35–65、ADX、Fed / 市场状态 / 财报、地板与 ADV
    - 入场: 扫描报价加滑点；价位用 computeETFLevels
    - 退出: 同 E4
运行门（任一不过 → BLOCKED (ENGINE_PARITY)，不出结论）:
  ACCEPTANCE: 冻结后的本文件 sha256 等于运行器内置值
  INPUTS: 修订 1 缓存仍对得上 INPUTS_MANIFEST_A1 665cc2a9…；SCAN_MAIN / SCAN_PHASE / SCAN_MAIN_NOCD 信号文件的 sha256 等于 Q0 结果 inputs 里的记录
  BASELINE_REPRO: Q1 运行器不设新选项时，逐字节复现 Q0 结果的 arms.D（交易表与日曲线的 sha256）、stats 行与全部压力行的基线数字
  INERT_Q0F: Q0-F 惰性检查（Q0F_INERT 0ac7c57d…）重跑结果不变
  INERT_TWINS: 开孪生（读法 1 选 (b) 时再加 shadowAll）后，账本哈希等于基线
  TWIN_PARITY: rule T0 的孪生对每笔账本交易（选 (b) 时也包括每笔 S 交易）复现出场时点、原因、价格和 R（误差 1e-9）；因持仓替换退出的账本交易单列，不参与比对
  PROBE: scripts/probe-c17-btc-eth-production.js 输出 0（沿用验收 §4.2；离线源码检查）
输入:
  冻结数据及内容身份: 与 Q0 相同。修订 1 缓存（INPUTS_MANIFEST_A1 665cc2a9…），三组扫描信号，不取新数据（Owner 10-25 数据规则）
  前向证据（单独报告，不并入 OOS）:
    来源: HK 只读文件拷贝，没有访问数据库
    存放: research-data/us_v5_m2_q1/hk/
    文件:
      - time-stop-shadow.jsonl，B 流，sha256 7316fc77…，4 行
      - time-stop-shadow-s.jsonl，S 流，sha256 c6c988a4…，4 行，其中 1 行是 S_RUN_BLOCKED
      - sessions-seen.json，sha256 fe455ec0…
    口径差异: 两条流按 T3 研究的口径产生（B 流 = 生产账本交易的孪生；S 流 = line H 的 shadowAll），与本题引擎不同，所以只并排列出
  历史可知假设与覆盖: 同 Q0（覆盖分段 IS-a / IS-b / OOS；不把今天的标的池当作 2020 年已知）
  扫描相位与业务日历: 同 Q0（主口径 = 生产时间表；压力 = 11:04 / 13:04 / 15:04 ET）
  初始现金_持仓_风险状态: 同 Q0（IS、OOS 各为新的 3,000 空仓账本）
  共享预算或其他账本依赖: 无
比较:
  问题与机制: 把 TREND 期间到期的 5 日 TIME stop 推迟，能否改善扣费后的完整账户；机制是让仍在趋势中的仓位继续持有
  唯一比较对象或唯一改动: 原版 = 基线臂（Q0-2604282b935f85d3 的 arms.D，引擎内重现）；候选 = T3 臂；SPY 买入持有与现金只作参照
  共同规则与不可避免差异: 两臂同引擎、同输入、同时间表。T3 让仓位持有更久，会改变后续仓位占用与入场，这属于账户层面的效应，也正是 P2 / P3 要测的
  数据既往用途与全部尝试:
    - OOS 2023-01-03 → 2026-10-02 是 T3 研究的 OOS。T3 正是因为这一段的点估计领先，才进入前向影子
    - 因此本题的 OOS 是在当前 D 上的重新测量，不是 T3 的新样本外（计划 §7）。结果文件写 oos_reuse
    - T3 研究之后才有的数据只有缓存尾段 2026-10-03 → 10-23（约 15 个 session）与 HK 前向影子
    - 全部运行都记录
  开发_确认_前向范围:
    IS: 2020-01-02 → 2022-12-30
    OOS: 2023-01-03 → 2026-10-23
    前向: HK 两条影子流（只报，不判）
判据:
  主目标与最低改善量:
    D: 每笔受影响交易的平均 ΔR
    δ*: +0.15 R / 受影响交易（验收 §5.3）
    区间: 按入场时点分块，每块 10 个 NYSE session，有放回重抽 10,000 次，种子 20261004，比率估计（验收 §5.2，trend-exit-stats.blockMean）
  账户层面:
    g: 候选臂相对基线臂的年化对数增长差，按共同日标记配对，即 x_t = r_T3,t − r_D,t，g = 252 × mean(x)
    区间: 按月分块 bootstrap，10,000 次，种子 20261025（计划 §5.1 与 Q0 同法）
    δ_g: 0
    另报: 两臂各自相对 SPY 的 g（Q0 口径）
  多重比较: T3 是从三个变体里选出来的，所以沿用 Bonferroni。P1、P3、F1 用双侧 98.33% 区间（百分位 0.8333% / 99.1667%），95% 区间并列
  映射到完整账户比较（验收 §6.1 → 本题）:
    G1: 基线 OOS 成熟交易 ≥ 30（Q0：111，已满足）；主样本的受影响交易 ≥ 30，且分布在 ≥ 10 个不同的块
    P1: L_D（98.33%，主样本）> 0
    P2: 候选臂 OOS 期末资本 > 基线臂，且候选臂最大回撤 ≤ 基线最大回撤 + 1.0 pp（日标记，3,000 新账本）
    P3: L_g（98.33%）> 0
    P4: IS 的 D 点估计 ≥ 0（主样本口径），且在 15 bps / 边下候选臂 OOS 期末资本 ≥ 基线臂（COST_15BPS 压力行，两臂）
    判定顺序（验收 §6.1）:
      1: BLOCKED (ENGINE_PARITY)
      2: INSUFFICIENT (SAMPLE)，G1 不满足时
      3: PASS，P1–P4 全部成立时
      4: FAIL，F1（U_D（98.33%）< δ*）或 F2（P1 成立但 P2 或 P4 不成立，写明是哪一条）成立时
      5: INSUFFICIENT，其余情况
    三态对应计划 §5.1: PASS = 有支持证据（SUPPORTED）；FAIL = 未通过（NOT_PASSED）；INSUFFICIENT = 证据不足（INSUFFICIENT）；BLOCKED 不出结论
    FAIL 标签（验收 §6.3）: 实测 MDE = 2.802 × (U_D − L_D)/3.92；MDE ≤ δ* 时写「数据充分」，否则写「数据偏弱（实测 MDE = x R，n_aff = y）」
  待冻结的读法:
    读法1_主样本:
      (a) 协调会话已定的口径:
        定义: 基线账本的 TIME 出场 = 验收里的样本 B（账本交易）只取 TIME 出场
        依据: 孪生入场相同时，只有 TIME 出场会变（止损 / 止盈 / 数据结束都发生在时钟到期之前，或与时钟无关）。所以受影响交易是这 23 笔的子集，n_aff ≤ 23
        后果: G1（≥ 30）运行前就确定不满足，逐笔结论必然是 INSUFFICIENT (SAMPLE)，D、g、P2–P4 的数字照报。这在运行前写明，不算看结果后的改动
      (b) 验收签过的主样本:
        定义: 样本 S（信号级，需要 E5），样本 B 作为次要样本报告
        规模: 运行前不知道。T3 研究在 line H 上 OOS 有 34 笔受影响的 S 交易，当前 D 的标的池、V1R0 和 K1 都不同，不能照搬
        前向对应: HK 前向的 S 流
        代价: E5 要额外写代码，并过一道 TWIN_PARITY
      执行者建议: (b)。验收的 G1 本来就按 S 计数；选 (a) 则结论在运行前已定。协调会话已定 (a)，最终由协调会话决定
    读法2_受影响的定义: 在所选样本里，按验收 §5.2 只算孪生出场时点或价格与原出场不同的交易（即至少推迟过一次）。未推迟的 TIME 出场 ΔR = 0，单独计数；对全部 23 笔的平均（含 0）作为次要数字报告
    读法3_账户层面的未通过条件: 是否把计划 §5.1 的「U_g ≤ 0 → 未通过」加为 F3（U_g（98.33%）≤ 0）。加了以后账户层面可以单独否决；不加则只用于 P3。执行者建议加，因为计划 §5.1 是 M2 的结论规则；要求协调会话明确选择
  风险上限及允许收益代价: 回撤容差 1.0 pp（P2）；最长水下期照报，不设线
  样本单位_依赖处理_区间方法: D 以受影响交易为单位，按 10 session 入场块抽样；g 以日为单位，按月分块
  适用压力_条件_评价时点:
    两臂同跑计划 §5.2 的全部压力行，每行报告两臂数字与差值（T3 − D）:
      - COST_15BPS
      - COST_SLIPPAGE_X2
      - SCAN_PHASE_PLUS_60MIN
      - WINDOW_2022_01_03_10_31
      - RISK_NO_24H_COOLDOWN、RISK_MAX_POSITIONS_5、RISK_UNIT_90（只报不判）
      - WINDOW_2020_02_19_04_30: 与 Q0 同样记为缺场景（INVALID_INPUT，理由同 Q0）
      - EXTREME_DOWNTURN_2008: 与 Q0 同样记为缺场景（MISSING_SCENARIO，理由同 Q0）
      - SPY / QQQ 合成补充行: 这是 Q0 运行器里独立的日线简化循环，不是 runLine，也没有 1h 序列，取不到 dailyRead。T3 臂这一行记缺项（理由照写），只报基线；该行本来就不进结论
    评价时点: 结果锁定时
  缺项与不足处理: 缺数不填零；样本不足写证据不足；前向样本不并入
采用边界:
  原流程或决定引用: 当前 D 照自己的规则运行。任何采用都走 US_CRYPTO_PAPER_FULL_RUN 修订加 Owner 签字。HK 的 T3 前向影子不受本题影响
  允许输出:
    研究引擎选项 E1–E4（选 (b) 时加 E5）
    结果文件 US_V5_M2_Q1_RESULT_V1.json 与 .sha256
    固定报告 docs/US_V5_M2_Q1_RESULT_V1.md
    回执
  生产或交易写入: 不允许；HK 只读，只拷文件，不读数据库
```

## 结果文件（`US_V5_M2_Q1_RESULT_V1.json`）

- **基本布局同 Q0：** `identity`、`inputs`、`gates`、`arms`、`stats`、`stress`、`half_kelly`、`formula_table`、`verdict`、`diagnosis_items`、`corrections`、`engine_run`、`reproducibility`。人能读的字符串用中文，代码与 id 保留英文。
- **`identity`：**
  - `schema: US_V5_M2_Q1_RESULT_V1`，`result_kind: CHALLENGER_VS_BASELINE`；
  - `d_version`，取值同上；
  - `baseline: { result_id: Q0-2604282b935f85d3, sha256: 2604282b… }`；
  - `k2`（冻结文件与 sha256）、`t3_acceptance_sha256`；
  - `oos_reuse`：哪一段被 T3 研究读过。
- **`arms`：** `window`、`D`（基线，在引擎内重现，并与 Q0 哈希对照）、`T3`、`SPY_BUY_HOLD`、`CASH`。每个交易臂都带交易表；T3 臂另加 `deferred_sessions` 与推迟起点。
- **`stats.rows`：** 加 `arm` 字段，两臂各出 Q0 的 12 行（IS-a / IS-b / OOS × 5 / 15 bps × 两个相位）。
- **`stress.rows`：** 每行有 `arms: { D, T3 }` 和 `diff`。缺场景沿用 FREEZE_2 的形状。
- **`half_kelly`：** 候选臂按计划 §5.3 计算，只作研究展示。
- **`verdict`：** `class: CHALLENGER_VS_BASELINE`；`state` 用计划 §5.1 的三态；另带 `t3_state`（PASS / FAIL / INSUFFICIENT / BLOCKED）、G1 与 P1–P4 / F1–F2（读法 3 选加时含 F3）的逐项真假与数字、`reason_codes`、FAIL 标签。
- **`comparison`（新增）：**
  - `baseline_result_id`、`candidate_arm: T3`、`population`（读法 1 的选择）；
  - `per_trade`：每笔主样本交易一行，含入场、载体、原出场时点 / 原因 / R、孪生出场时点 / 原因 / R、ΔR、推迟 session 数、所在块；
  - `D`：点估计与 95% / 98.33% 区间、n_aff、块数、实测 MDE；
  - `g_vs_baseline`：点估计与 95% / 98.33% 区间；
  - `secondary`：全部 23 笔的平均（含 0）、按原出场原因的 D、样本 B 或 S 的另一侧；
  - `forward`：HK 两条流逐行列出，带文件 sha256，标「前向，只报不判，不并入」。

**QRP 需要新规格：** 现有导入规格（`US_V5_M2_Q0_RESULT_V1_IMPORT_PROFILE` 加 FREEZE_1 / FREEZE_2）只按单臂 `arms.D` 和 Q0 的结论类读取。原版对候选需要四样东西：按臂分开的 stats / stress、`comparison` 块、P1–P4 结论类、前向区。运行后我会用 Q0 导入器只读检查（在 scratch 副本里，不碰 QRP 主 checkout），把具体缺口写进回执。

## 执行者估计

- **工作量：**
  - E1–E4 是主要工作：在扫描模式下处理孪生和 T3 时钟，并让孪生跟随 K3。
  - 选 (b) 时，E5 约再加一半。
  - 运行在 `~/bin/heavy-run` 下进行：基线重现，两臂各跑 IS / OOS 和全部压力行，再加孪生运行，两次重跑做逐字节核对。
- **风险：**
  - K3 的内存记录要按孪生分开，否则 TWIN_PARITY 会失败。
  - 持仓替换与推迟的交互，在 Q0 的 OOS 里大概率不出现（替换意图为 0），但仍要按臂计数。


## 协调会话裁定（冻结时）

1. **主样本：选 (b)。**
   - 理由：与已签 T3 验收一致，也就是信号级总体 S；需要的扫描模式信号级影子交易 E5 照草稿实现。
   - 基线账本的 TIME 出场（OOS 23 笔）作为次要总体 B，照报不判；G1 只按 S 判。
2. **「受影响」的定义：按验收 §5.2。** 只算至少推迟过一次的交易；没推迟的 TIME 出场 ΔR = 0，单独计数。23 笔全算（含 0）的平均作次要数字。
3. **加 F3。** 候选臂对基线臂的账户年化对数增长差，按日配对、按月分块 bootstrap，取 Bonferroni 98.33% 区间。上沿 U_g ≤ 0 即判「未通过」。理由：Owner 要求改动必须改善完整账户结果。
4. **样本外复用（AC5）。**
   - 2023-01-03 → 2026-10-02 是 T3 研究的 OOS。T3 正是凭这一段被选为领先变体并进入前向，所以本次不能当独立样本外。
   - 结果文件写 `oos_reuse: true`，页面把这一段标为「复测（当年用于挑选 T3 的样本，不是独立样本外）」。
   - 独立证据只有两部分，分开报告：缓存尾段 2026-10-03 → 10-23，以及 HK 前向的 B 流和 S 流。
   - 三态结论照验收计算，并加原因码 `OOS_REUSED_FOR_SELECTION`。即使判 PASS，采用条件也必须等 T3 前向记录按它自己的成熟规则成熟，「采用条件」一行写「未满足（独立样本不足，等前向成熟）」。
5. **结果文件 `US_V5_M2_Q1_RESULT_V1`**，一个 JSON 加 `.sha256`。顶层字段如下；子字段沿用 Q0 导入规格的写法，中文人话规则同 Q0-F 裁定 4。
   - `identity`：含 `d_version`、`baseline_result_id = Q0-2604282b935f85d3`。
   - `inputs`；`gates`：含新增的「不设新选项时逐字节复现 Q0 D 臂」门。
   - `arms`：`BASELINE`、`CANDIDATE_T3`，每臂给 equity、summary、trades。
   - `stats`：每行加 `arm` 字段。
   - `stress`：每行给两臂的数字和差值，缺场景照 F1 的写法。
   - `comparison`：总体 S 和 B 的受影响笔数、ΔR 均值与区间、P1–P4、F1–F3 各自的结果、配对 g 及其区间、Bonferroni 水平。
   - `forward`：B 流和 S 流逐行，来源文件与 sha256，`in_verdict: false`。
   - `oos_reuse`。
   - `verdict`：`class = CANDIDATE_COMPARISON_V1`，`state` 取 `SUPPORTED / NOT_PASSED / INSUFFICIENT`（分别对应验收的 PASS / FAIL / INSUFFICIENT），带 `reason_codes`。
   - `diagnosis_items`；`reproducibility`：两次运行输出 sha256 相同。
6. **停止点：** 封存后停下，在临时副本里用 QRP 导入器做只读检查，把结果写进回执，再等协调会话自查与导入。Q2 等协调会话的消息。
