# US_V5 M2 Q4 · 被闸门拒绝的信号不武装 24 h 冷却（对当前 D）· 研究规格 K2（DRAFT）

状态：**DRAFT**，等协调会话冻结。冻结前不写实现代码，也不运行；Q4 的运行排在 Q3 封存之后（Q3 K2 裁定 7）。

依据：
- 计划 V1 §2 Q4、§5.1、§5.2（风控维度「供 Q4 立题」）、§7。
- 前序：
  - 基线 `Q0-2604282b935f85d3`（`2604282b…`）。
  - Q2 K2 勘误 1（G1 先判）。
  - 导入规格 V2（`3ebfeb53…`）。
- Q0 诊断项 D-EXEC-OPEN-SCAN-COOLDOWN、D-EXEC-COOLDOWN-RESTART、D-RISK-COOLDOWN。
- 协调会话 10-25 的 Q4 题目与要求。

## 运行前已核实的事实

**1. 冷却在哪里武装：**
- `src/strategies/us-v5-strategy.js` 在每次给出 BUY / SELL 信号时就写入该序列的冷却时间戳（l.394–395），时长 `cooldown15M = 96` 折算为 24 小时（l.252）。
- 入场闸门在策略之后，由 worker / 引擎 entryGateChecks 判 ADX ≥ 22、RSI 35–65、ADV。被闸门拒绝的信号，冷却已经武装，该序列 24 小时内不再出信号。
- 生产实例：2026-10-22 的 XLV、XLP。

**2. OOS 规模（Q0 基线，生产时间表）：**
- ETF_GATE_FAILED 共 460 次，每一次都含 RSI 出带。
- 其中 204 次在 10:04 ET 的开盘扫描，那一刻用的是未完成的 1h bar。

**3. 完全去掉冷却（Q0 压力行，只报）：**
- OOS 期末 4,038.14 对基线 3,417.93；成熟交易 129 对 111；每笔 +0.094 R 对 −0.016 R。
- 这一行在定题时已经可见，计划 §5.2 也写明这些行「供 Q4 立题」，见读法 2。

**4. 重启清空冷却：**
- 生产进程重启会清空冷却状态（2026-10-14 重启后第一条扫描记录的冷却为空）。
- 长历史不模拟重启，冷却状态连续。写进适用条件。

**5. 研究信号的冷却：**
- 三组扫描信号里，SCAN_MAIN / SCAN_PHASE 在生成时就按策略冷却过滤，SCAN_MAIN_NOCD 是不冷却的同一批信号。
- K2 触发在 SCAN_MAIN 与 SCAN_MAIN_NOCD 中完全相同（3 次，都是 GGLL）。所以把冷却移到引擎里、在 NOCD 信号上执行，可以复现基线（见运行门 COOLDOWN_PARITY）。

```yaml
模板身份: US_V5_M2_Q4_GATE_REFUSAL_COOLDOWN_V1
原问题与研究槽引用: 计划 V1 §2 Q4（仓位与组合风控：冷却是否合理）；Q0 诊断项 D-EXEC-OPEN-SCAN-COOLDOWN（被 RSI 闸拒绝的信号同样武装 24 h 冷却）
研究用途: 候选比较（一个改动，三态），加只报不判的三个风控维度行
目标:
  市场_策略_账本_模式: US_EQUITY / US_V5_ETF_UNIVERSE_V1 / US_V5_ETF_3000USD / PAPER（真实行情）
  当前D有效版本引用: "US_V5_ETF_3000USD@2382c2d1 (KLINE_TIMING_V1 inert: K2 BAD_PRICE defect, 2026-10-14..fix)"
  原实验冻结基线引用: Q0-2604282b935f85d3 的 arms.D（SCAN_MAIN、生产时间表、5 bps / 边 + 监管费、Q0-F 的 F1–F6 全开），引擎内重现
  代码_参数_开关引用: 研究文件新增选项全部「不设即不变」；生产代码、S17、开关与账本都不动
  选择规则引用: 不变
  择时退出规则引用: 不变
  组合风控规则引用: 唯一改动 = 冷却的武装条件（见下文「改动」）；其余不变
  信号标的与交易载体: 不变
  工具执行与成本引用: 不变
改动:
  候选: 信号照常武装 24 h 冷却；如果它在开仓路径上被入场闸门拒绝（引擎记 ETF_GATE_FAILED），撤销这次武装，该序列的冷却回到这次之前的状态
  范围: 只有入场闸门的拒绝撤销冷却（读法 1）；因其他原因没有开仓的信号照旧武装冷却，包括市场状态、Fed 阶段、地板、财报、K1、名额与上限
  K2 触发: 照生产不受冷却阻挡、也不武装冷却（KP7 路径：dailyLayer 不写冷却）
  两臂:
    BASELINE: 当前 D（Q0 D 臂，SCAN_MAIN 信号，引擎内重现）
    CANDIDATE_GATE_COOLDOWN: SCAN_MAIN_NOCD 信号加引擎内冷却，入场闸门的拒绝不武装冷却
  引擎改动（只改研究文件；不设即不变）:
    E10_ENGINE_COOLDOWN:
      选项: line.cooldown = { hours: 24, armOnGateRefusal: true | false }
      执行时点: 每个信号进入开仓路径时
      阻挡: 距上次武装不足 24 小时的同一序列信号被冷却挡住，挡下的信号不入账本，也不改变 holds 计数（另有计数器）
      武装: 未被挡住的信号武装冷却
      撤销: armOnGateRefusal = false 时，这个信号若被 ETF_GATE_FAILED 拒绝，撤销本次武装
      K2 触发信号: 绕过冷却，也不武装
    E11_PHASE_NOCD_SIGNALS: 新增不冷却的另一相位信号 SCAN_PHASE_NOCD（signals-scan 的新集合），供候选臂的相位压力行使用；sha256 记入 inputs
运行门（任一不过 → BLOCKED (ENGINE_PARITY)，不出结论）:
  ACCEPTANCE: 冻结后的本文件 sha256 等于运行器内置值
  INPUTS: 修订 1 缓存清单与 SCAN_MAIN / SCAN_PHASE / SCAN_MAIN_NOCD 与 Q0 记录相同；SCAN_PHASE_NOCD 记新 sha256
  BASELINE_REPRO: 不设新选项时逐字节复现 Q0 的 arms.D、12 行统计、毛信号与全部压力行
  COOLDOWN_PARITY:
    主时间表: SCAN_MAIN_NOCD 加 line.cooldown { armOnGateRefusal: true }，账本哈希（交易与日曲线）等于基线
    另一相位: SCAN_PHASE_NOCD 加同一选项等于基线的 SCAN_PHASE 运行
    范围: IS 与 OOS
  INERT_Q0F: Q0-F 惰性检查重跑结果不变
  INERT_Q2: 在 Q4 代码上重跑 Q2 运行器，去掉 identity 后与封存的 Q2 结果相同
  INERT_Q3: 在 Q4 代码上重跑 Q3 运行器（不重跑种子，读同一批种子分片），去掉 identity 后与封存的 Q3 结果相同
  PROBE: scripts/probe-c17-btc-eth-production.js 输出 0
输入:
  冻结数据及内容身份: 修订 1 缓存与 Q0 的三组扫描信号；新生成的 SCAN_PHASE_NOCD 来自同一缓存与同一生成器；不取新数据
  历史可知假设与覆盖: 同 Q0
  扫描相位与业务日历: 同 Q0
  初始现金_持仓_风险状态: 同 Q0；冷却状态从每个账本的起点为空
  共享预算或其他账本依赖: 无
比较:
  问题与机制:
    - 开盘扫描用未完成的 1h bar，RSI 容易出带；被拒的信号仍把该序列冷却 24 小时，当天其余扫描即使条件转好也不能入场
    - 候选只撤销「闸门拒绝」造成的冷却，其余冷却照旧
  唯一比较对象或唯一改动: 原版 = 基线臂；候选 = 闸门拒绝不武装冷却；SPY 买入持有与现金只作参照
  共同规则与不可避免差异: 同引擎、同输入、同时间表；候选会多出一些入场，名额与名义上限照常约束，这是改动本身的后果，照报
  数据既往用途与全部尝试: 2023–2026 被 Q0–Q3 读过；Q0 的「完全去掉冷却」行在定题时可见（读法 2）；全部运行都记录
  开发_确认_前向范围:
    IS: 2020-01-02 → 2022-12-30（只报）
    OOS: 2023-01-03 → 2026-10-23（判定）
    前向: 无（HK 没有这条规则的前向影子）
判据（同 Q2 与 Q2 勘误 1；单变体，不做多重比较校正）:
  主目标与最低改善量: 账户层面配对 g（候选对基线，日对数收益差，按月分块 bootstrap 10,000 次，种子 20261025，95%），δ_g = 0
  G1: 两臂 OOS 成熟交易各 ≥ 30，且改变的入场 ≥ 30（只在一臂出现的「序列 + 扫描时点」入场）
  三态: G1 不成立 → 证据不足；G1 成立时 U_g ≤ 0 → 未通过（F3 式否决）、L_g > 0 → 有支持证据；其余 → 证据不足
  次: 候选臂自身每笔净 R 对 +0.10 R（不判）；两臂同一入场的逐笔 ΔR 作描述
  敞口:
    - 两臂的平均名义金额、在场时间占比、名义上限拒绝与削减次数
    - 另报冷却挡下的信号数，以及候选撤销的武装数（按 10:04 开盘扫描与其他扫描分开）
  措辞: 「有支持证据」= 完整账户的对数增长更好，不等于信号 alpha 更大（AC8）
  风险上限及允许收益代价: 两臂最大回撤、最长水下期照报，不设通过线
  样本单位_依赖处理_区间方法: g 以日为单位，按月分块；每笔 R 以成熟交易为单位，按月分块
  适用压力_条件_评价时点:
    两臂同跑计划 §5.2 的全部压力行，每行给两臂数字与差值:
      - COST_15BPS、COST_SLIPPAGE_X2、WINDOW_2022_01_03_10_31
      - SCAN_PHASE_PLUS_60MIN: 候选用 SCAN_PHASE_NOCD 加引擎冷却
      - RISK_NO_24H_COOLDOWN: 没有冷却时两条规则相同，两臂相同，照写
      - RISK_MAX_POSITIONS_5、RISK_UNIT_90（两臂各跑，只报不判）
      - WINDOW_2020_02_19_04_30 与 EXTREME_DOWNTURN_2008: 两臂相同，记缺场景（理由同 Q0）
      - SPY / QQQ 合成补充行: 日线循环的「当日平仓后不再入场」不是信号冷却，也没有入场闸门，两臂相同，照写
    评价时点: 结果锁定时
  只报不判的风控维度（计划 §5.2，作为行，不出结论）:
    report_only_dimensions:
      - NO_24H_COOLDOWN（完全去掉冷却，SCAN_MAIN_NOCD）
      - MAX_POSITIONS_5（同时持仓 3 → 5）
      - RISK_UNIT_90（单元风险 60 → 90）
    每行对基线报告: 期末资本、成熟交易、每笔净 R、最大回撤、配对 g 与 95% 区间（描述）、改变的入场数
    这三行不进三态、不进采用条件
  适用条件:
    - 生产进程重启会清空冷却状态，长历史假设冷却连续
    - 实际运行中重启越频繁，冷却规则的作用越小，两条规则的差别也越小
  缺项与不足处理: 缺数不填零；样本不足写证据不足
  待冻结的读法:
    读法1_撤销冷却的范围:
      (a) 只撤销入场闸门的拒绝（ETF_GATE_FAILED，含 RSI 35–65、ADX、ADV 与 ETF 价位无效）；其他未开仓的信号照旧武装
      (b) 凡是没有开仓的信号都撤销武装，冷却只在真正开仓（含持仓替换执行）后生效。这已经接近「冷却只防交易后的反复进出」，改动更大
      执行者建议: (a)，与题目原文和生产实例一致
    读法2_样本外复用（AC5）:
      (a) oos_reuse: true（原因码 OOS_REUSED_FOR_SELECTION）。计划 §5.2 把风控维度行明写为「供 Q4 立题」，Q0 的「完全去掉冷却」行（OOS 期末 4,038 对 3,418）在定题时可见；本题是那一行的收窄版本
      (b) oos_reuse: false。题目来自 2026-10-22 的生产实例（XLV、XLP）与机制分析，不是来自结果数字；在 oos_reuse_detail 写明 Q0 行可见
      执行者建议: (a)，以免把看过方向的样本当独立样本外；由协调会话裁定
采用边界:
  原流程或决定引用: 当前 D 照自己的规则运行；冷却属于交易规则签字类，任何采用都走 US_CRYPTO_PAPER_FULL_RUN 修订加 Owner 签字
  允许输出:
    研究引擎选项 E10；新信号集合 SCAN_PHASE_NOCD（E11）
    结果文件 US_V5_M2_Q4_RESULT_V1.json 与 .sha256
    固定报告 docs/US_V5_M2_Q4_RESULT_V1.md
    回执
  生产或交易写入: 不允许；本题不需要 HK
```

## 结果文件（`US_V5_M2_Q4_RESULT_V1.json`，导入规格 V2 的布局）

- **身份：** `identity.schema: US_V5_M2_Q4_RESULT_V1`，`result_kind: CHALLENGER_VS_BASELINE`，`baseline_result_id`、`k2`、`smartflow_commit`、`engine_files`。
- **`arms`：** `BASELINE`、`CANDIDATE_GATE_COOLDOWN`、`SPY_BUY_HOLD`、`CASH`。
- **`stats` / `stress`：** 同 Q2，两臂。
- **`comparison`：**
  - `question_zh`、`candidate_label_zh`；
  - `g_vs_baseline {value, ci_95}`；
  - `criteria {G1: {met, baseline_oos_trades, candidate_oos_trades, changed_entries}, P_G, F3}`；
  - `secondary {literal, paired}`；
  - `exposure`：同 Q2 键名，另加 `cooldown_blocked_signals`、`gate_refusal_arms_undone {open_scan, other}`。
- **`report_only_dimensions`（新增）：** 三行，每行有 `{key, label_zh, end_capital, n, mean_R, max_drawdown, g_vs_baseline {value, ci_95}, changed_entries, in_verdict: false}`。
- **`verdict`：** `class: CANDIDATE_COMPARISON_V1`。
- **其余字段：**
  - `forward: { rows: [], reason_zh: 'HK 没有这条规则的前向影子' }`；
  - `oos_reuse` 按读法 2，另有 `oos_reuse_detail`；
  - `diagnosis_items`；
  - 不写 `attribution`。

**导入规格 V2 缺的部分：**
- **登记项：** 没有 Q4。需要写入 K2 sha、候选臂键 `CANDIDATE_GATE_COOLDOWN`、判据集 G1 / P_G / F3、δ_g 0 与 δ_R 0.10、`oos_reuse` 期望值（按读法 2）、`exposure` 要求、`attribution` 不要求。
- **`report_only_dimensions` 块：** 没有对应读法，需要规定它只报不判、与结论分开显示。

## 执行者估计

- **工作量：** E10 是一个引擎选项，用 COOLDOWN_PARITY 证明在 NOCD 信号上能复现基线；E11 生成一组信号，约 15 分钟。
- **运行：** 两臂 IS / OOS、全部压力行、三个风控维度行、两次 COOLDOWN_PARITY，再加 INERT_Q2 / INERT_Q3 重跑，两次逐字节复核，约 1 小时。
- **风险：** 名义上限可能吃掉多出的入场，改变的入场数也可能不到 30。这只能运行后才知道，不预测。


## 协调会话裁定（冻结时，2026-10-26）

以上草案原文一字未改。草案在 smartflow `research/us-v5-m2-q4` 提交 `cfabaea6`，内容 sha256 `4fb65d46ec330434aa82dbfbce22c178c9916a3372dc5793ab4595e8a780d69e`。冻结后以本节为准。

1. **读法 1 选 (b)：候选臂 = 已签字的生产规则 A25。**
   - **理由**：Owner 已于 2026-10-25T23:28:48+08:00 签署 `US_V5_COOLDOWN_ARMED_ON_OPEN_ONLY_V1`，签字文本 sha256 前缀 `0629f064570b3aa1`，规则已在纸面账户生效：
     - C1：冷却只在真正纸面开仓时触发，从成交时刻起算；
     - C2：被任何 worker 闸门拒绝的信号都不触发冷却。

     这条规则的 C6 写明「QRP M2 Q4 第一个题目正是这一改动」。所以 Q4 必须检验这条生效中的规则。草案推荐的 (a) 比它窄，不能代替它。
   - **候选臂键**：改名为 `CANDIDATE_COOLDOWN_ON_OPEN`。
   - **候选臂的冷却规则**：只在开仓时武装，持仓替换的执行也算开仓。其他所有没开仓的信号都不武装冷却，包括入场闸门、市场状态、Fed 阶段、地板、财报、K1、名额与上限各种原因。K2 触发照生产：既不受冷却阻挡，也不武装冷却。
   - **引擎选项**：E10 改为 `line.cooldown = { hours: 24, armMode: 'SIGNAL' | 'OPEN_ONLY' | 'NOT_GATE_REFUSED' }`，不设时行为不变。各取值的用途：
     - `SIGNAL`：用于 COOLDOWN_PARITY，复现基线；
     - `OPEN_ONLY`：用于候选臂；
     - `NOT_GATE_REFUSED`：草案原来的 (a)，只作下面第 2 条的报告行。
   - **敞口字段**：草案的 `gate_refusal_arms_undone` 改为 `arms_not_set {gate_refusal, other_no_open}`，每项再按 10:04 开盘扫描和其他扫描分开计数。
2. **报告行（只报不判）**：在 `report_only_dimensions` 里，于草案的三行之外加第四行 `GATE_REFUSAL_ONLY_UNARM`，即草案的 (a)。它和其他行一样 `in_verdict: false`，不进三态，也不进采用条件。
3. **读法 2 选 (a)**：`oos_reuse: true`，原因码 `OOS_REUSED_FOR_SELECTION`。`oos_reuse_detail` 写明三点：
   - Q0 的「完全去掉冷却」行（OOS 期末 4,038 对 3,418）在定题时可见；
   - A25 的签字文本也引用了这一行；
   - 本题是那一行的收窄版本。

   G1 与三态判据照 Q2 及其勘误 1，再按导入规格 V2 对 `oos_reuse` 的处理执行。
4. **运行位置**：优先用旧 MBP 研究车道。它已通过跨机器逐字节验收，现在两个任务位都空着。
   - 输入从主力 Mac 拷过去，逐文件核对 sha256。
   - BASELINE_REPRO 门本身就会验证跨机器一致。
   - 如果输入太分散、只能在主力 Mac 上跑，要照 `seeds_batched.sh` 的门槛：swap 已用 < 10 GB，1 分钟负载 < 12。并且不在 09:15–15:05 和 18:30–19:45（CST）开新任务。
5. **QRP 登记项**：Q4 的登记项和 `report_only_dimensions` 块的读法，由研究会话在 QRP 上开一个 PR（同 #23 的做法），由协调会话核对后合并。登记项写入以下内容：
   - 本文件的 sha；
   - 候选臂键 `CANDIDATE_COOLDOWN_ON_OPEN`；
   - 判据集 G1 / P_G / F3，δ_g 0，δ_R 0.10；
   - `oos_reuse` 期望 true；
   - 要求 `exposure`，不要求 `attribution`；
   - 四个只报行的形状与「只报不判」的显示规则。
6. **采用边界不变**：Q4 的结论交给 Owner，由 Owner 按 A25 的 C6 决定保留、修改或撤回 A25。研究不改任何生产规则或开关。
7. **停止点**：Q4 封存并在临时副本里试导入后停下，等协调会话自查与导入。之后协调会话把 Q3、Q4 汇总给 Owner。
