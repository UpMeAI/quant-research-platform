# SIGNAL_REGISTRY_V1（美股、加密信号登记簿 第 1 版）

**状态：草案，随 PR 提交，由协调会话合并。** 起草 2026-11-02。来源：Cycle-Research-Desk 系统分析报告 V1 §4（美股、加密序列少，不建因子库，
建信号登记簿：每条信号规则的命中率、期望、分市场状态的表现，记分牌已有一半）与 §10 排期行「信号登记簿：美股、加密从记分牌补齐；依赖指标定义；
验证对记分牌 0 差异」。

本文件只规定**登记簿怎么从已交付的文件读出来**。不改任何策略规则、风控线、生产参数或台账；不下单、不写台账、不联网取数。
登记簿是事实，不是裁决（`interpretation: REGISTRY_FACTS_NOT_A_VERDICT`，`productionEffect: NONE`）。

实现：`services/signal-registry/`（`index.js` 建簿，`conformance.js` 对记分牌比较），命令行 `apps/research-cli/build_signal_registry.js`，
测试 `tests/signal_registry.test.js`，夹具 `tests/fixtures/signal-registry/inbox`（由 `tests/support/build-signal-registry-fixture.js` 生成），
一次完整文件上的运行 `var/evidence/signal-registry-2026-11-01/`。

## 1. 范围

四本在跑的纸面账本（PAPER，真实行情）：

| 账本 | 市场 | 块 | 说明 |
| --- | --- | --- | --- |
| `US_V5_ETF_3000USD` | US | 整本 | 口径 GROSS（METRIC_DEFINITIONS_V1 C-6：费用模型冻结前不叫净值） |
| `US_CORE_9000USD_3X_GATEOBS` | US | 整本 | 轮动账本：没有往返交易、没有初始止损，只有汇总行（`rowsState: NOT_APPLICABLE:NO_ROUND_TRIP_TRADES`） |
| `C17_V2_4000USDT` | CRYPTO | `BTC_ETH`、`NON_MAJOR` | 部分按品种（REVIEW_LOOP_ACCEPTANCE_V1 增补 2 §5.1：BTCUSDT、ETHUSDT 归 BTC_ETH） |
| `QUICK_SHOT_V3_1000USDT` | CRYPTO | 整本 | 不在增补 4 的状态拆分范围内（`stateSplit: NOT_AVAILABLE:STATE_SPLIT_NOT_IN_SCOPE_FOR_BOOK`） |

## 2. 一行是什么

**一行 = 一个块里的一条入场信号。** 信号键 `signalKey` = 该笔开仓成交（TRADE_LEDGER_V1 `purpose: OPEN`）上记录的
`decision.reasonCodes` 按记录次序用 `+` 连接，不做改写、不做归类（例：`V5_SIGNAL:TREND:BUY`、`C17_SIGNAL_AND_RANKING+TREND`、
`QUICK_SHOT_RULES_V3+QS_V3_SIGNAL_BEARISH+FORWARD_EVIDENCE_TUNING_V1_INSUFFICIENT`）。开仓成交不在台账里的交易归
`UNKNOWN:ENTRY_FILL_NOT_IN_LEDGER`。同一行里出现过的 `decision.ruleRef` 列在 `ruleRefs`（没有记录的为 `null`）。

每个块另有一行汇总（`signalKey: '*'`，在 `books[].blocks[].rollup`），覆盖该块全部交易，用来与记分牌逐字段比较（§7）。
同一块各信号行的已平、未平、赚、亏、平笔数之和等于汇总行。

「在跑」= 记分牌 `book.state` 为 `RUNNING` 的账本；行里给出 `entries`、`firstEntryAt`、`lastEntryAt`，一条信号在当前版本有没有开过仓
看 `windows.currentVersion`，登记簿不另判信号是否仍有效。

## 3. 来源与优先级

全部只读，读 desk 收件箱的布局（`<SMARTFLOW_US|SMARTFLOW_CRYPTO>/review/SCOREBOARD|STRATEGY/<账本>/`、`trades/<账本>/`、`ledger/<账本>/`）。
完整文件逐个验自带 `hash`（desk `src/canonical.js` 的 contentHash），不符即拒（`SOURCE_HASH_MISMATCH`，失败即关）。

| 来源 | 取什么 |
| --- | --- |
| STRATEGY_SCOREBOARD_V1（期末那份） | 期末 `period.to`、每块每窗的边界（`from`、`to`、`segmentIds`）、状态标签与格子键次序（`stateSplit`）、账本状态 |
| TRADE_LEDGER_V1（全部日文件） | 交易集合、信号键、开平仓时刻、已实现结果（`realized`）、换仓成交的手续费（US_CORE） |
| STRATEGY_REVIEW_V1（期末及以前各周） | 每笔已平交易的 `tradeReviews` 行：费用分项与来源（`costs`、`costProvenance`）、结果（后备） |
| POSITION_LEDGER_SNAPSHOT_V1（`period.to` 那天） | 只做核对：持仓 = 登记簿期末未平（`sourceChecks.snapshotOpenLots`） |

3.1 **每笔结果**（`pnl`、`rMultiple`）按次序取第一个有的：
①记分牌状态标签里的 `outcome`（生产方本期的值，全精度）；②成交台账平仓的已实现结果，仅当它的口径就是账本口径
（加密 `MEASURED` = 净；US_V5 `MEASURED_GROSS` = 毛）；③该周复盘的 `tradeReviews` 行（2–4 位小数）。每笔记 `outcomeSource`。
加密 `grossPnl` 只在台账给 `MEASURED_GROSS` 时有（窗口落到 GROSS 口径时用）。

3.2 **费用**只来自复盘行（台账成交只带手续费；资金费、滑点不是成交）。

3.3 **期末重述。** 周复盘行交付后不再改写：一笔资金费晚落定的交易，它那周的行仍写 `UNKNOWN`，而期末记分牌已按落定后的值计。
当一个窗口的已平交易正好是记分牌同一块同一窗的那一组（同块、笔数相同），且某项费用在登记簿这边因此成了 `NOT_MEASURED`、
记分牌这一窗却是 `MEASURED / MODELLED` 时（记分牌的规则：任一笔未知即 `NOT_MEASURED`，所以期末每笔都已知），这一项取记分牌的，
窗口写 `costsSource: SCOREBOARD_WINDOW:<项>`，来源核对写 `COST_RESTATED_BY_SCOREBOARD_WINDOW`（列出是哪几笔）。
按信号拆出的子集（笔数少于记分牌那一窗）不借这个数，照样 `NOT_MEASURED`、金额 `null`。

3.4 **来源核对**（`books[].sourceChecks.divergences`，只记录，不改数）：`TRADE_LEDGER_GROSS_REVIEW_NET`（台账文件停在毛值、复盘已是净值）、
`TRADE_LEDGER_VS_REVIEW`、`TRADE_LEDGER_VS_SCOREBOARD_TAG`、`TRADE_LEDGER_EVENT_RESTATED`、`CLOSED_TRADE_NOT_IN_ANY_REVIEW`、
`TAGGED_LOT_NOT_IN_TRADE_LEDGER`、`PART_MEMBERSHIP`、`BOUND_REVIEW_NOT_READ`、`COST_RESTATED_BY_SCOREBOARD_WINDOW`。

## 4. 窗口

`bookSinceStart`、`currentVersion`（当前规则版本段，即「在跑的规则」）、`previousVersion`。边界一律取记分牌这一块这一窗交付的，
不由 S17 记录重算。规则与 STRATEGY_SCOREBOARD_V1 相同（smartflow `strategy-scoreboard.js` `buildBlock`）：

- 时钟：美股按纽约日期、16:00 收盘为一天结束；加密按 UTC 日。期末 = `period.to` 那天的结束。
- 交易按**平仓时刻**落窗；本期已平 = 平仓日 ≤ `period.to` 且平仓时刻 ≥ 窗口 `from`（上一版本窗另要 < 窗口 `to`）。
- 未平：到期末仍持有（上一版本窗：到版本切换时仍持有）。
- 记分牌这一窗没有边界（`NOT_STARTED`、`NOT_APPLICABLE:NO_PREVIOUS_VERSION` 等）就照抄它的状态与原因，各项为 `null`。
- 轮动账本（US_CORE）：已平 0；未平 = 窗口结束时仍持有的仓位；手续费 = 窗口各会话换仓成交的建模费用（`MODELLED`，记分牌 `coreCostsOf`），
  滑点 `NOT_APPLICABLE:SLIPPAGE_INSIDE_MODELLED_FILL_PRICE`，资金费 `NOT_APPLICABLE:NOT_A_PERPETUAL`。

## 5. 指标

| 字段 | 定义 | 依据 |
| --- | --- | --- |
| `closed`、`open`、`wins`、`losses`、`flats` | 已平、未平、按窗口口径盈亏 > 0、< 0、= 0 的笔数 | 记分牌 §6.2 |
| `pnlBasis` | 窗口每项费用都是 MEASURED / MODELLED（或不适用）为 `NET`，否则 `GROSS` | 记分牌 §6.2；METRIC_DEFINITIONS_V1 §9 |
| `winRate`（命中率） | 赚的笔数 ÷ 已平笔数；0 笔 `NOT_APPLICABLE:NO_CLOSED_TRADE`，< 30 笔 `INSUFFICIENT_SAMPLE`、值为空；4 位 | REVIEW_LOOP_ACCEPTANCE_V1 §6.2、D5 (a) |
| `avgR`、`expectancyT` | 每笔 R 的均值与 t（smartflow `expectancyStats`）；同一 30 笔下限；无初始止损 `NOT_APPLICABLE:NO_INITIAL_STOP`；风险单位缺失 `UNKNOWN` | 同上 |
| `expectancyAmount_like` | 每笔期望金额 = 窗口口径盈亏的均值（账本自己记的费用之后，US_V5 为毛）；同一 30 笔下限；金额 2 位；带 `basis`、`currency` | METRIC_DEFINITIONS_V1 §1.5（未定义的量带 `_like`，不是裁决数字）、§9、§10.2 |
| `costs` | 手续费、资金费、滑点 `{state, amount, reasonCode}`；任一笔未知 → `NOT_MEASURED`、金额 `null`，不补 0 | METRIC_DEFINITIONS_V1 §9.3；记分牌 `tradeCosts` |

任何一笔取不到窗口口径的盈亏 → 整窗 `UNKNOWN:TRADE_PNL_NOT_RECORDED`，各项为 `null`（与记分牌 `emptyWindow` 相同）。

**取整**（协调会话 2026-11-02 裁定）。汇总行（`signalKey: '*'`）的字段记分牌也有，记分牌是它们唯一的生产者：照记分牌导出的样子（窗口的比率与费用 4 位、状态格的 `winRate`、`avgR`、`netPnl` 不取整），以便逐字比较。登记簿自己算的比率（信号行窗口的 `winRate`、`avgR`、`expectancyT`，信号行状态格的 `winRate`、`avgR`）按 METRIC_DEFINITIONS_V1 §10.2 取 6 位；登记簿自己算的金额（信号行窗口的费用合计、信号行状态格的 `netPnl`、`expectancyAmount_like`）取 2 位。信号行窗口按 §3.3 从记分牌重述的那一项费用是记分牌的数，照它的 4 位（`costsSource` 写明）。

## 6. 按市场状态拆分

只用记分牌交付的状态标签（REVIEW_LOOP_ACCEPTANCE_V1 增补 4：标签以开仓决策时刻已知的状态为准，之后不改；`since` 以前开的仓只计数、不拆）。
登记簿不给没有标签的交易补标签，也不为没有拆分的账本另造状态来源。

- 窗口：`bookSinceStart`、`currentVersion`。轴：`macro`、`industry`、`price`（美股：MACRO_STATE / INDUSTRY_REALTIME_MOMENTUM / US_MARKET_REGIME；
  C17：只有 `price` = C17_MODE，另两条 `NOT_APPLICABLE`）。格子键与次序取记分牌这一块的。
- 每格：`closed`、`open`、`sample`、`winRate`、`avgR`、`netPnl`（desk `state-split.js` 的格子读法，下限 20 笔）与 `expectancyAmount_like`（同一下限，2 位）。
- 每行只取自己信号那些交易的标签；`untaggedClosed / untaggedOpen` = 这一行窗口的已平 / 未平减去价格轴格子之和。

## 7. 对记分牌的一致性（0 差异）

`services/signal-registry/conformance.js` 把每块的汇总行与记分牌同名块比较，值按 canonical JSON 相等，不设容差：

- 窗口（三窗）：`state reasonCode from to segmentIds closed open wins losses flats pnlBasis winRate avgR expectancyT costs`；
- 状态拆分（两窗）：`state reasonCode since`，`from to segmentIds untaggedClosed untaggedOpen`，每条轴的 `state reasonCode` 与格子键次序，
  每格 `key closed open sample winRate avgR netPnl`；记分牌没有拆分的块，登记簿也没有；
- 逐笔：记分牌标签里有结果的每一笔，登记簿的 `pnl`、`rMultiple`、平仓时刻；
- 拆分守恒：各信号行之和 = 汇总行。

命令行有任何一处差异即退出码 1。2026-11-01 期末四本账本：比较 752 处，差异 0（证据目录）。

## 8. 已知的限制

- 加密窗口若落到 GROSS 口径，需要每笔毛值；复盘行不带毛值，台账只在 `MEASURED_GROSS` 时给，所以这时该窗会是 `UNKNOWN`。
- 复盘行的结果只有 2–4 位小数；只有 30 笔以上才出 `avgR`，而这时多数交易的结果来自标签（全精度）或台账（6 位），不足以改变 4 位取整。
- `previousVersion` 之外的历史版本段、滚动 60 天与最近 30 笔窗口不在本版（记分牌已有后两者）。

## 9. 版本

V1 起草 2026-11-02。改字段语义 = 新版本（`SIGNAL_REGISTRY_V2`），不原地改。
