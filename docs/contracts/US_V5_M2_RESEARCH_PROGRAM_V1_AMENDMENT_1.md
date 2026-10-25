# US_V5 M2 研究计划 V1 · 修订 1

状态：**FROZEN**（2026-10-25 13:4x CST，Q0 任何运行之前）
冻结人：V8.1 协调会话（研究规格负责人）
原文件：`docs/contracts/US_V5_M2_RESEARCH_PROGRAM_V1.md`，sha256 `0f7e0b4966c1835f…`（不改动）
修订原因：① Owner 10-25 的数据来源规则；② 实现会话核查发现，长历史只能用离线研究引擎，它不是部署的 worker；③ QRP 没有能表达「原版对基准」的结果判定。
δ、比较对象、期限与三态规则**不变**。

## M1.1 数据来源（Owner 原话）

> A股有历史数据在闪迪磁盘 不需要重新拉取数据，同样 美股和加密货币也有历史交易数据在vps，不需要重新拉取数据

- Q0–Q4 不从任何外部来源重新拉历史行情。
- 来源按顺序取：
  1. Mac 上已封存的缓存（`research-data/sel4_rsi_band_work`，81 条序列，截至 2026-10-02；`research-data/us_v5_time_stop_v1_work`）；
  2. HK VPS（`smartflow-vps`）上的 smartflow 行情库和研究缓存，只读。
- 不使用任何交易凭证。缓存里记录的 `credentialSource`（Alpaca 密钥对）不得用于新的拉取。
- OOS 截止日 = 封存缓存或 VPS 数据覆盖到的最后一个完整 session。2026-10-08 起的当前 PAPER 窗口只来自 M1 封存包。
- 每条序列在结果包里记：来源主机、表或路径、范围、行数、sha256。两处都没有的序列：停下，向协调会话报序列名和范围，不自行拉取。

## M1.2 引擎身份与对齐门 A0

- 长历史引擎 = `scripts/research/replay-us-v5-universe-comparison.js`。它是对账本逻辑的离线重写，不是部署的 `us-v5-worker`。生产回放（`us-v5-replay.js` / `us-v5-plan-replay.js`）只能重放 2026-09-28 起的生产扫描记录。
- **规则清单**：逐条列出现行规则，每条标「已实现 / 未实现 / 不适用」并附代码位置。至少包括：
  - A4 退出；A6 闸门与风险桶；A12 反转关闭；
  - A15/A16 标的池 v3（SPMO / VOO / SPXL / UPRO，broad_sp500 桶）；
  - A17：3000 / 60 / 3，150 / 450 熔断，T 锚，前身共享限额；
  - 10-14 起的 K 线择时；U1 换仓上限与换仓规则；A23 行业 RS（若线上为开）。
- **对齐门 A0**：同一引擎、同一组 K 线，跑 2026-09-28 → 2026-10-23 的两本账（6000 簿至 2026-10-09 关闭，3000 簿自 2026-10-08 起），各用自己的配置。逐项对照生产扫描记录和纸面账本，包括 M1 封存包：
  - 一致的定义：每笔开仓和平仓的标的、方向、session、退出原因相同，数量相同；成交价落在该 bar 的高低区间内；被拒信号的闸门代码相同（例如 METU `GATE_RSI_OUTSIDE_BAND`）。
  - 判定：
    - A0 通过且规则清单没有「未实现」项：长历史结果才能标「当前 D」。
    - 否则标「研究引擎近似的当前 D（缺：…）」。每个差异和缺口写进 §4.1 问题清单，来源记为「执行」或「数据」。此时 Q0 的三态结论最高为「证据不足」。
- I1（复现 10-03 基线：132 笔 / 5.03% / 37.2% / 8,350.0913）仍在 A0 之前执行。I1 只证明引擎和缓存没漂移，不证明等于当前 D。

## M1.3 工具覆盖分段

单股杠杆 ETF 自 2022-08-09 起陆续上市（MSFU 2022-09-09，METU 2024-06-05，PLTU 2024-12-11 等）。报告按三段写：
- IS-a：2020-01-02 → 2022-08-08（基本只有指数 / 行业载体）；
- IS-b：2022-08-09 → 2022-12-30；
- OOS：2023-01-03 → 截止日。

主判据仍只用 OOS。每段注明可交易载体数和与当前标的池的重叠比例。

## M1.4 结果判定词汇（供 QRP K3）

- 新判定类别 `BASELINE_EVALUATION_V1`，不是冠军对挑战者。状态取 Owner 用语：
  - `SUPPORTED`：有支持证据；
  - `NOT_PASSED`：未通过；
  - `INSUFFICIENT`：证据不足。
- 比较对象 `SPY_BUY_HOLD`、`CASH`；区间方法为按月分块 bootstrap 95%；δ = +0.10 R，δ_g = 0。
- 在 M3 回链中，Q0 是**基线参照**：Q1–Q4 的每个实验引用它的 result id 作为原版基线；它本身不挂 Desk 研究问题。

## M1.5 封存结果文件 `US_V5_M2_Q0_RESULT_V1`（研究会话产出，QRP 只读导入）

一个 JSON 加旁边的 sha256 文件，顶层字段：

| 字段 | 内容 |
|---|---|
| `identity` | 计划与本修订的 sha256、smartflow 提交、引擎文件 blob、完整配置、运行命令、随机种子 |
| `inputs` | 每条序列 {symbol, role: parent/carrier/benchmark, source_host, source_ref, range, rows, sha256}；每年可交易载体普查 |
| `gates` | I1、A0（逐项对照表）、规则清单 |
| `arms` | `D`、`SPY_BUY_HOLD`、`CASH`。每臂给日度权益序列；D 另给逐笔交易：entry/exit 时间、parent、carrier、数量、价格、费用分项、净 R、退出原因、扫描相位 |
| `stats` | 按 段 × 费用（5/15 bps）× 相位：n、胜率、赔率、均值 R 与区间、g、CAGR、最大回撤、最长水下期、是否已恢复、期末资本 |
| `stress` | §5.2 每个场景一行；模拟序列行带 `simulated: true` |
| `half_kelly` | p、b 及区间，f\*、f_half（按下沿）；按半凯利与按固定 60 USD 的重放摘要；P(权益 < 1800) |
| `formula_table` | 假设胜率 × 赔率的期望增长；`kind: FORMULA_NOT_BACKTEST` |
| `verdict` | 判定类别、状态、L、U、δ、原因码；引擎近似标记（M1.2） |
| `diagnosis_items` | §4.1 每条：source、facts、proposed_experiment 或 no_topic_reason |
| `reproducibility` | 重跑命令；两次运行输出 sha256 相等的证明 |
