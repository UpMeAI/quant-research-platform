# SIGNAL_REGISTRY_V1：2026-11-01 期末的一次运行

规格：`docs/contracts/SIGNAL_REGISTRY_V1.md`。只读，生产影响 NONE。

## 输入

desk 收件箱（HK 主机上 exporters 那份），2026-11-02 08:4x CST 只读复制，未改动任何文件。每个完整文件的自带哈希都验过（`sources[].hashState: VERIFIED`）。

| 账本 | 期末（记分牌 `period.to`） | 记分牌 | 成交台账 | 周复盘 | 期末快照 |
| --- | --- | --- | --- | --- | --- |
| US_V5_ETF_3000USD | 2026-10-30 | 1 | 17 | 4 | 1 |
| US_CORE_9000USD_3X_GATEOBS | 2026-10-30 | 1 | 17 | 4 | 1 |
| C17_V2_4000USDT | 2026-11-01 | 1 | 33 | 5 | 1 |
| QUICK_SHOT_V3_1000USDT | 2026-11-01 | 1 | 26 | 4 | 1 |

复现（同一批文件放在 `<inbox>` 下，布局同 desk inbox）：

```
node apps/research-cli/build_signal_registry.js --inbox <inbox> \
  --out SIGNAL_REGISTRY_V1.json --conformance-out SIGNAL_REGISTRY_V1.conformance.json
```

测试夹具 `tests/fixtures/signal-registry/inbox` 是同一批输入：记分牌与成交台账按字节复制，周复盘与快照只留登记簿用的字段（原文件含账户说明与风控参数，
不放进公开仓库）。`tests/signal_registry.test.js` T1 断言夹具上的结果与这里的 `rows`、`books`（除来源的 hashState 外）逐字相同。

## 结果

- 登记簿 `SIGNAL_REGISTRY_V1.json`，hash `cf02c2f33b1776427bd4368fa87090ab86cc6ebf698bf5dd98c9c6350469570c`；5 条信号行 + 5 个块的汇总行。
- 一致性 `SIGNAL_REGISTRY_V1.conformance.json`：与四份记分牌比较 752 处，**差异 0**（US_V5 319、US_CORE 46、C17 326、QS 61）。

| 行 | 自起始 已平 / 赚-亏 | 当前版本 已平 / 赚-亏 | 状态拆分 |
| --- | --- | --- | --- |
| US_V5 · `V5_SIGNAL:TREND:BUY` | 1 / 1-0（GROSS） | 0 | 有（标签自 10-16 起） |
| C17 BTC_ETH · `C17_SIGNAL_AND_RANKING+TREND` | 14 / 7-7 | 5 / 3-2 | 有（标签自 10-19 起） |
| C17 NON_MAJOR · `C17_SIGNAL_AND_RANKING+TREND` | 8 / 2-6 | 4 / 0-4 | 有 |
| QS · `…QS_V3_SIGNAL_BEARISH…` | 7 / 2-5 | 5 / 2-3 | 不在增补 4 范围 |
| QS · `…QS_V3_SIGNAL_BULLISH…` | 6 / 1-5 | 2 / 1-1 | 不在增补 4 范围 |
| US_CORE（汇总行，轮动） | 0（无往返交易） | 0 | 不适用 |

所有窗口都不到 30 笔：命中率、平均 R、每笔期望金额都是 `INSUFFICIENT_SAMPLE`（只给赚亏笔数，D5 (a)）；状态格都不到 20 笔。

## 来源核对（照实记录，不改数）

- `TRADE_LEDGER_GROSS_REVIEW_NET`：C17 4733、4739、4749 的成交台账文件停在毛值（`FUNDING_UNVERIFIED`），复盘行与记分牌已是净值。
  台账日文件交付后不再改写，所以这三笔的结果取记分牌标签（4749）或复盘行（4733、4739）。
- `COST_RESTATED_BY_SCOREBOARD_WINDOW`：C17 4733 那周（10-11）的复盘行写资金费 `UNKNOWN`，期末记分牌已计为 MEASURED；
  BTC_ETH 自起始窗（汇总行与 TREND 行，同一组 14 笔）的资金费取记分牌这一项（规格 §3.3）。
- 期末快照持仓与登记簿期末未平：四本都一致。
