# DIAG-XM-1 跨市场共振 / 互补诊断 · 预登记 V1

- 性质：**诊断，只报**。不出「做 / 不做」，不改任何规则、参数、账本，production_effect = NONE。
- 来源：协调会话任务（Owner 2026-11-16 23:20 CST 在 doc ① 讨论串 77b7d655 同意），截止 2026-11-18 18:00 CST。
- 执行：海外研究会话。QRP 分支 `research/diag-xm-1`（只作研究记录，不合并）。
- 冻结：本文件 sha256 由冻结记录 `DIAG_XM_1_PREREG_V1_FREEZE_1.md` 绑定，冻结时刻即 k2_frozen_at。冻结前没有对任何本的收益序列算过本文的任何统计量（§10）。
- CF: L1 的 k 只用当日开盘前已收盘的基准价（§6.2–6.3）；本题只读已封存或已交付的净值序列，不模拟任何成交。

## 1. 问题

1. Q1 各本模拟盘之间是同涨同跌（共振），还是此消彼长（互补）？
2. Q2 L1「两个市场在压力档 → 其余市场 k ≤ 0.6」在历史上触发过没有：几次、哪几天？
3. Q3 L1 的 k 缩放对各本收益与最大回撤的影响（对比不缩放）。
4. Q4 数据支持哪一个后续题：R-XM-1（A 股闲置现金放短债 / 货币 ETF）、R-XM-2（US_V5 + C17 同向热度上限）（判据 §7，先写死）。

## 2. 本

**实盘（模拟盘）序列，METRIC_DEFINITIONS_V1 的 BOOK_NAV_SERIES_V1，全部本：**

| 本 | 文件（HK 收件箱，只读拷贝） | 时钟 / 估值 | sha256 |
|---|---|---|---|
| US_V5_ETF_3000USD | BOOK_NAV_SERIES_US_V5_ETF_3000USD_2026-11-13.json | NYSE / 盯市，NET_PARTIAL | f29d9545ed1ea7937ba2edda231bfe266b40e81a070c82c19395384e3c17a296 |
| US_CORE_9000USD_3X_GATEOBS | BOOK_NAV_SERIES_US_CORE_9000USD_3X_GATEOBS_2026-11-13.json | NYSE / 盯市 | 2f4c14c761d5196416dd58f03263b7b2ccb3c5404c0c874ced5d6d775d45cee4 |
| C17_V2_4000USDT | BOOK_NAV_SERIES_C17_V2_4000USDT_2026-11-15.json | UTC 日 / **只计已实现** | 3fdd8a86342532faa4bc7e026fa123d0974c9f599a3bad1b3fd10cc7e9f5fa28 |
| QUICK_SHOT_V3_1000USDT | BOOK_NAV_SERIES_QUICK_SHOT_V3_1000USDT_2026-11-15.json | UTC 日 / **只计已实现** | 2810ad1b70ea2f14787ea280e453ae3f6da2455c9c443461d79dc86f6a768134 |
| ASHARE_V6_PAPER · INDEX_BOOK | BOOK_NAV_SERIES_ASHARE_V6_PAPER_INDEX_BOOK_2026-11-16.json | SSE / 盯市 | 24a40c232aca0d63b91eff6ec8320b99dbc9038b82118b647414b7bce1cd9f31 |
| ASHARE_V6_PAPER · STOCK_BOOK | BOOK_NAV_SERIES_ASHARE_V6_PAPER_STOCK_BOOK_2026-11-16.json | SSE / 盯市 | b8f42f92541d626e6b67d969e97fe3de0008992ec87fbec82826d714b7e0169f |
| ASHARE_V6_PAPER（合计，只作对照，不进配对） | BOOK_NAV_SERIES_ASHARE_V6_PAPER_2026-11-16.json | SSE / 盯市 | 4e243dd35249ce6800875c60eacd782d93c7accad48a54f47562597935cd30cf |

- HK 路径：美股、加密在 `/home/admin/deploy-contracts/portfolio-desk-694fa07/inbox/SMARTFLOW_{US,CRYPTO}/ledger/<本>/`，A 股在 `/var/lib/portfolio-desk/from-mac/ASHARE_V6/ledger/ASHARE_V6_PAPER/`。只读文件，没有查数据库。
- 没有别的本在 NAV 序列里（10 月起交付的就是这 7 个文件）。

**回放序列（已封存结果里的逐日权益，不合并到实盘）：**

| 本 | 封存结果 | 窗口 | sha256 |
|---|---|---|---|
| US_V5 | QRP Q0-2604282b935f85d3（M2 基线，Q5/Q6/GAP 引用）`US_V5_M2_Q0_RESULT_V1.json` arms.D | 2023-01-03 → 2026-10-23 | 2604282b935f85d37b6878ba62a63d90e4b3539334f783e3adbf72ed23bdfe49 |
| US_CORE | QRP `US_CORE_M2_Q0_RESULT_V1.json` arms_is.D + arms.D | 2010-02-11 → 2017-12-29，2018-01-02 → 2026-09-30 | c5b6fc7e1e29fff97332f5ce7b033725f901f096111da5c1e7e7ad5fa4cc96e9 |
| C17_V2 | QRP `C17_V2_M2_Q0_RESULT_V2.json` arms.IS.D + arms.D | 2020-01-01 → 2022-12-31，2023-01-01 → 2026-10-24 | e80c42523b30f7681aaede3e4f11b39475ed8fc9d724335400a7a8ba0db009fa |
| QS_V3 | QRP `QS_V3_M2_Q0_RESULT_V1.json` arms.IS.D + arms.D | 2020-01-01 → 2023-12-31，2024-01-01 → 2026-10-24 | bd83dd6ec1754dbc0b3338aefd826f29aa4f885afc05dced80ae4c826bdbfd45 |
| A 股个股本 | Q0 账户 A（A03 基线）Linux `scratch/q0-post-x10/p2lx/ASHARE_V6_STOCK_BOOK_M2_Q0_RESULT_V1.json` arms.D | 2020-06-01 → 2026-09-28 | a7f680718e771f1ff8c9a301b605a199a7d7fd6158f59f067405e0756cd3418e |

- **A 股指数本没有回放序列**：R-ETF-1 封存结果（V6 research/etf-grid-r-etf-1 abe9a3fe）只有换档记录，没有逐日权益；Q0 账户只有个股本。回放部分记 `NOT_AVAILABLE:NO_SEALED_DAILY_EQUITY`，不重建。
- 回放是各本封存时的 D（US_CORE 在触价退出与凯利上限之前、C17 / QS 是 M2 Q0 的版本），不是今天的 D。照此披露，不改。
- 本地拷贝：`/Users/kaylame/KaylaProject/research-data/diag_xm_1_v1/inputs/`，清单 `INPUTS_SHA256SUMS`。

## 3. L1 历史输入

- 引擎：KG `518d178c617aab7e7fe7af91d499013d1245100d` 的 `worker-cf/src/l1-risk-budget/bands.ts`（blob 44773d8b）里的 `bandPath`、`linkK`，由 `scripts/l1-risk-budget/replay-s4.ts`（blob fb68bace）的 `loadArchives` / `buildSeries` 读入。本题不另写分档逻辑。
- 档案（签字 §4 回放的那 4 个，sha 由 replay-s4.ts 自己核对）：H00300.CSI 21068cdc…、H00905.CSI 13eae5ba…（buildSeries 需要，本题不用其收益）、SPY.json 518b5ff5…、btc_daily.csv 93d527fd…（2020-01-01 起）。
- 与实盘读数的差别（照披露）：A 股基准用 H00300.CSI（沪深 300 全收益），实盘生产者读 000300.SH 价格指数，回撤读数差股息部分；BTC 历史只有 2020 年起。

## 4. 日历对齐

1. A1 每条序列用自己的日期标签：A 股是上交所交易日，美股是纽约交易日，加密是 UTC 日（该 UTC 日结束时的收盘）。日期标签就是收盘所在的 UTC 日期（A 股收盘 07:00 UTC，美股 20:00/21:00 UTC，加密 24:00 UTC）。
2. A2 每一对本 (i, j) 的网格 G = 两本都有净值点的日期（在两本共同的时间段内）。加密每天都有点，所以加密配股票本时网格就是股票本的交易日；A 股配美股时网格是两边共同的交易日。
3. A3 网格收益 r_t = NAV(g_t) / NAV(g_{t−1}) − 1，按相邻网格日计算。所以加密的周末、假日收益并进下一个美股 / A 股交易日；一边放假时另一边的涨跌也并进下一个共同日。
4. A4 回放分段（US_CORE、C17、QS 的 IS 与 OOS）各自从起始资金重开：段内收益照算，跨段那一个收益丢弃（记 GAP）。网格收益跨过任一本的 GAP 时丢弃。
5. A5 实盘：state ≠ MEASURED 的点丢弃；用 `nav` 字段（已扣出入金）。回放：用 `equity.values`（无出入金）。
6. A6 敏感性（只报）：A 股收盘早于同日美股收盘约 13 小时，同日相关会低估。另报滞后一格：A 股 g_t 的收益配对方 g_{t−1} 的收益，两个方向都报。

## 5. 指标

1. M1 Pearson ρ；M2 Spearman ρ（并列取平均秩）。都在 A3 网格收益上，报 n。
   - 90% 区间：按日历月分块的自助法，月数个块有放回抽，B = 2000，mulberry32 种子 20261117 + 配对序号（配对按 §2 表的顺序排）；分位取 sorted[floor(q·B)]，q = 0.05 / 0.95。只对 n ≥ 60 的配对算；实盘配对不算区间，只报 n。
   - 一方收益全为 0（方差 0，例如实盘个股本一直空仓）→ ρ = null，原因 `ZERO_VARIANCE`。
2. M3 尾部同跌：在配对网格上，W_i = 本 i 收益最低的 ceil(0.10·n) 天（边界并列全收）中收益 < 0 的那些天。P(j | i) = |W_i ∩ W_j| / |W_i|；独立时的基线 = |W_j| / n；提升倍数 = P / 基线。两个方向都报。|W_i| < 5 → `NOT_ENOUGH_TAIL_DAYS`。
3. M4 回撤段重叠：每本在自己的整条序列上（实盘、回放分开）找水下段：从净值跌破前高的那天起，到第一次回到前高的那天止（到序列末尾还没回来记「未收复」）；段深 = 段内最大 1 − NAV / 前高。回放留段深 ≥ 10% 的段，实盘留 ≥ 3% 的段。配对：在两本共同时间段内按日历日算，两本同时在段内的天数、Jaccard = 交集 / 并集、互相重叠的段对（起止日、段深）。另报：每本最深一段的谷底那天，对方本当时离前高多远。
4. M5 闲置比例：净值较上一交易日不变（|r| < 1e-12）的交易日占比。每本都报；R-XM-1 只看 A 股两本。
5. M6 合并账户（回放、实盘各算一个，只报）：
   - 回放窗口 = 5 本回放都有数据的共同段 2023-01-03 → 2026-09-28；实盘窗口 = 6 本实盘的共同段。
   - 日历 = 窗口内各本日期的并集；某本不交易的日子沿用上一个净值。各本净值在窗口起点归 1。
   - 权益 = Σ w_i · NAV_i，w_i ∝ 各本起始资金折人民币，汇率固定 7.10（同签字 §4.1）：US_V5 3,000 USD、US_CORE 9,000 USD、C17 4,000 USDT、QS 1,000 USDT、A 股个股本 100,000、A 股指数本 400,000（指数本只在实盘账户里）。
   - 报总收益、最大回撤、账户最差 10 天里各本的贡献。

## 6. L1 历史

1. 6.1 档位路径：用 §3 的引擎对 3 个基准算整条路径（A 股 2005 年起，美股 1993 年起，BTC 2020-01-01 起）。一行只有 `windowComplete` 为真时才算读数；之前那个市场记 L9（没有 k，不算压力档），同生产者。
2. 6.2 读数 R_d：对 2006-01-01 到 2026-09-30 的每个日历日 d，A 股档 = 日期 ≤ d 的最新一行，美股档、BTC 档 = 日期 ≤ d−1 的最新一行（实盘 20:30 CST 的读数含当日 A 股收盘、前一日美股与 BTC 收盘）。在 R_d 上调用 `linkK` 得每个市场的 k。
3. 6.3 作用到本：美股本交易日 t 用 R_t（纽约开盘前已出）；A 股本交易日 t 用 t 之前最近一个日历日的读数（前一晚）；加密本 UTC 日 t 用 R_{t−1}。k 为 null（从未读到）→ 按 1，同执行端（只在 READ 时设上限）。
4. 6.4 三种口径（每本回放各一行，§9）：NONE（k = 1）；BANDS（只用本市场自己的档位 k，不看联动）；LINK（签字规则，含联动）。
5. 6.5 作用方式（一阶）：缩放后的日收益 r′_t = k_t · r_t（被减掉的部分收益为 0），在本自己的逐日序列上复利。这等于假设 k < 1 的日子本的毛敞口都在 E_max，所以是 L1 影响的**上限**（少亏和少赚都按上限算）；封存结果里没有逐日敞口。
6. 6.6 报：每本回放和回放合并账户的总收益、年化（股票本 252，加密 365）、最大回撤，三种口径并排，及 BANDS − NONE、LINK − BANDS（联动的增量）；k < 1 日子的对数收益合计。
7. 6.7 触发计数：2006-01-01 到 2026-09-30，联动生效（≥ 2 个市场在 S）的读数日数、触发段（连续日历日为一段）的起止、哪几个市场在 S、哪个市场被压到 0.6（`linkageCapped`）。另报各市场各档的读数日数。

## 7. 后续题的判据（冻结前写死）

1. R-XM-1「数据支持」只要满足一条：(i) 回放 A 股个股本 M5 闲置比例 ≥ 30%；(ii) 实盘 A 股个股本闲置比例 ≥ 50%。同时报闲置金额 = 起始资金 × 闲置比例。
2. R-XM-2「数据支持」只看回放 US_V5 × C17，满足一条即可：(i) Pearson ρ ≥ 0.30 且 90% 区间下沿 > 0；(ii) 任一方向尾部提升倍数 ≥ 2.0 且共同最差日 ≥ 5 天；(iii) 回撤段 Jaccard ≥ 0.30。实盘这一对只报，不进判据（n 太小）。
3. 写法是「数据支持 / 数据不支持」，立不立题由协调会话定。

## 8. 分开报

实盘、回放分开报，不合并、不拼接。实盘的加密两本是「只计已实现」，相关会偏低，照写。

## 9. 运行与台账

1. 脚本在本分支 `research/diag-xm-1/`：`l1-readings.ts`（在 KG 518d178 检出里用 tsx 跑，写 `l1-readings.json`）；`xm1.py`（`python3 -I`，只用标准库，读输入清单、输入和 `l1-readings.json`，写结果 JSON，键排序）。
2. 运行 A 在 Mac；运行 B 在 Linux（不在 02:30–05:30），结果 JSON 必须逐字节相同，不同就照报，以 A 为准。
3. 试验台账（study_ref DIAG-XM-1，冻结前预登记，k2_sha256 = 本文件 sha256）。全部是不进成本门的行：实盘与回放原样序列记 REPRO，L1 口径记 DIAGNOSTIC_ARM。运行日志 RESEARCH_RUN_LOG_V1 每行带 trial_id、verdict_metric_kind = NET_RETURN_SERIES（照 COST_MODEL_GATE_V1 @805d35a0 的 11-17 起规则）。

| 族 | 标签 | 角色 / 阶段 | trial_id |
|---|---|---|---|
| US_V5_ETF_3000USD | XM1_LIVE | REPRO / FORWARD | TRL-813b11279e738293 |
| US_CORE_9000USD_3X_GATEOBS | XM1_LIVE | REPRO / FORWARD | TRL-90e0565ac9985fc6 |
| C17_V2_4000USDT | XM1_LIVE | REPRO / FORWARD | TRL-27b42ea6cd5ba35e |
| QUICK_SHOT_V3_1000USDT | XM1_LIVE | REPRO / FORWARD | TRL-0d73661c995ce56c |
| INDEX_BOOK | XM1_LIVE | REPRO / FORWARD | TRL-aa56aa55e3269596 |
| ASHARE_V6_PAPER | XM1_LIVE_STOCK_BOOK | REPRO / FORWARD | TRL-06d1b905afa96fc3 |
| US_V5_ETF_3000USD | XM1_REPLAY / _L1_BANDS / _L1_LINK | REPRO / DIAGNOSTIC_ARM ×2，BOOK | TRL-41824a629a297d01 / TRL-54bdf7bef05990fc / TRL-1b1ca06121038955 |
| US_CORE_9000USD_3X_GATEOBS | 同上 | 同上 | TRL-ea5c947b88caecf8 / TRL-92b174e612fe548f / TRL-2ddd6de6bda5f1b1 |
| C17_V2_4000USDT | 同上 | 同上 | TRL-5e9de21b38e3e4a9 / TRL-bad375a9338f2a39 / TRL-940fbd59e5d04ff2 |
| QUICK_SHOT_V3_1000USDT | 同上 | 同上 | TRL-80a141786c5987b6 / TRL-6b9a3a37ac211400 / TRL-fa43911c7189a75d |
| ASHARE_V6_PAPER | 同上 | 同上 | TRL-10dbb5ac7e97cb25 / TRL-055cb3a76a70d26e / TRL-4f87d39f42457661 |

## 10. 冻结前已经看过的

- 各文件的结构、日期范围、首尾点：实盘末点 nav 为 US_CORE 0.8305、C17 0.7839、QS 0.9783、US_V5 0.9973，A 股合计 1.000084，个股本 1.0（不变），指数本 1.000105。回放各段的起止日与起始值。
- 11-11 的 L1 影子反事实（10-28 到 11-10 美股、加密每天都是 N）与签字 §4 回放的分档统计（5 个压力窗口）。
- 没有对任何本的收益算过相关、尾部、回撤段或 L1 缩放。

## 11. 封存

结果 JSON、运行日志、中文一页摘要提交到本分支，封存提交的 sha 写进 queue.log（`DIAG-XM-1 SEALED`）并发给协调会话。
