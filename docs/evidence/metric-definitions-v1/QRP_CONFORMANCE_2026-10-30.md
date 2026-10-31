# QRP 一致性测试 2026-10-30（METRIC_DEFINITIONS_V1 草案）

测试：`tests/metric_conformance.test.js`（已知差异 `tests/metric_conformance.known.json`），共用三个字节相同的文件在 `tests/support/`、`tests/fixtures/metric-conformance/`。
运行：`node --test tests/metric_conformance.test.js`。完整比较表：`QRP_CONFORMANCE_REPORT_2026-10-30.json`。
契约草案在 portfolio-desk 仓库 `docs/contracts/METRIC_DEFINITIONS_V1.draft.md`（本仓库不存契约，只存测试与证据）。没有改任何生产代码。

## 1. QRP 里的指标实现

QRP 自己几乎不算指标：`services/baseline-evaluation` 把封存结果里的 `cagr`、`max_drawdown`、`longest_underwater_sessions`、`recovered`
**原样**印出（代码注释「不从序列推」），只核对 `end_capital` 等于权益序列末点；`services/candidate-comparison` 原样印 `g` 和 95% 区间并检查常量
（`delta_g = 0`、`delta_R = 0.10`、`ci_method = MONTHLY_BLOCK_BOOTSTRAP_95`）。数字由 smartflow／V6 的研究 runner 产生，封存后才进来。

| 实现 | 覆盖 | 结果 |
| --- | --- | --- |
| `adapters/ashare-local/backtest_engine.js` `backtestCurve` | 覆盖无缺口的 3 个序列（US_CLEAN_60、US_COST_60、PATH_HAND_12）；有缺口的 2 个序列该引擎的日期是各标的日期的并集，表示不了缺口，未覆盖 | 14 项一致，2 项已知差异（D-QRP-01） |
| `services/baseline-evaluation`（封存摘要） | 不在 fixture 上比，而是对 `var/evidence` 的 4 份封存结果由序列重算 | 全部一致（见 §2） |
| `services/baseline-evaluation` 导入器 | characterization 测试 | 已知缺陷 D-QRP-02 |
| `packages/contracts/canonical_metrics.js` | 只有轴名，不含计算 | 不适用 |

引擎的输出由它自己取整到 6 位小数（契约 §10.3）；适配器在比较前把参考值取到 6 位。

## 2. 封存结果由序列重算：全部一致

对 `var/evidence/us-v5-m2-q0-2026-10-25`、`...q0-current...`、`...q1...`、`...q2...` 的每个有权益序列和摘要的臂（Q0：D、SPY_BUY_HOLD、CASH；
Q1：BASELINE、CANDIDATE_T3、SPY_BUY_HOLD、CASH；Q2：BASELINE、CANDIDATE_1X、SPY_BUY_HOLD、CASH）：

- `cagr` = `NAV_last ^ (252 / T) − 1`，T = 序列标记个数（第一个标记就是起始资本）；
- `max_drawdown` = 相对运行峰值的最大落差，峰值从起始资本起算，正小数；
- `longest_underwater_sessions` = 连续严格低于运行峰值的最长会话数；`recovered` = 最后一个标记不在水下；
- Q1、Q2 的 `paired_g`：`g = 252 × Σx / Σk`（日对数收益差，无缺口时即 252 × 均值），区间 = 按日历月分块、10,000 次、`mulberry32(20261025)`、
  每次抽 K（月数）块有放回、取升序第 `floor(0.025·B)`、`floor(0.975·B)` 个，**与封存值逐位一致**（Q2：g −0.004811，区间 [−0.031715, 0.019688]；
  Q1：g 0.02763，区间 [−0.04074, 0.101622]；均 956 会话、46 个月）。

试过但不能复现封存值的其他写法：块数不为 K、抽到够长再截断、块均值的均值、插值分位。

## 3. 缺陷

| 编号 | 位置 | 内容 | 契约条款 |
| --- | --- | --- | --- |
| D-QRP-01 | `backtestCurve` 的 `sharpe_like` | 等于 `cagr / annualized_vol`，不是 `mean(r)/sd(r) × √A`。例：US_CLEAN_60 参考 −0.5275，引擎 −0.5700。命名带 `like`，rf=0，其余字段（`cagr`、`annualized_vol`、`calmar`、最大回撤、累计收益）与契约一致 | §2.2 |
| D-QRP-02 | 导入器 | 对每臂只检查 `end_capital` 等于序列末点；`cagr`、`max_drawdown`、`longest_underwater_sessions`、`recovered` 与自己的序列不符时照收。现有合成夹具 `tests/_q0_fixture.js` 的 D 臂就是这样（摘要写 0.05，序列重算约 0.005）。建议：导入时由序列重算并核对，容差 5e-7 | §1.2、§10.3 |

另有一条观察而非缺陷：`max_dd_recovery_days` 是最近一次完成回撤的恢复天数，不是最长水下期，两者不可互相替代（契约 §8.4）。

## 4. 本仓库没有的

- 按月分块 bootstrap 的**实现**：它在 smartflow 未合并的研究分支 `research/us-v5-m2-q*`。本测试里的参考实现是它的第一个在仓库 main 上可复核的规格。
- 加密的封存序列（QS V3、C17 的封存结果没有 `arms.*.equity`），所以 365 的年化口径在 QRP 侧没有封存证据。
- 本机全量 `npm test`：87 项失败，全部在页面类测试（`ux_amendment_*`、`*_page`、`research_web_render` 等），在干净的 `origin/main` 上同样失败，与本变更无关。
