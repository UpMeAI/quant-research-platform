# QRP 一致性测试 2026-10-30（METRIC_DEFINITIONS_V1，2026-10-31 冻结）

测试：`tests/metric_conformance.test.js`（已知差异 `tests/metric_conformance.known.json`），共用三个字节相同的文件在 `tests/support/`、`tests/fixtures/metric-conformance/`。
运行：`node --test tests/metric_conformance.test.js`。完整比较表：`QRP_CONFORMANCE_REPORT_2026-10-30.json`。
契约在 portfolio-desk 仓库 `docs/contracts/METRIC_DEFINITIONS_V1.md`，三个共用文件的唯一来源是同仓库 `docs/contracts/metric-definitions-v1/`（本仓库不存契约，只存测试与证据）。没有改任何生产代码。

## 1. QRP 里的指标实现

QRP 自己几乎不算指标：`services/baseline-evaluation` 把封存结果里的 `cagr`、`max_drawdown`、`longest_underwater_sessions`、`recovered`
**原样**印出（代码注释「不从序列推」），只核对 `end_capital` 等于权益序列末点；`services/candidate-comparison` 原样印 `g` 和 95% 区间并检查常量
（`delta_g = 0`、`delta_R = 0.10`、`ci_method = MONTHLY_BLOCK_BOOTSTRAP_95`）。数字由 smartflow／V6 的研究 runner 产生，封存后才进来。

| 实现 | 覆盖 | 结果 |
| --- | --- | --- |
| `adapters/ashare-local/backtest_engine.js` `backtestCurve` | 覆盖无缺口的 3 个序列（US_CLEAN_60、US_COST_60、PATH_HAND_12）；有缺口的 2 个序列该引擎的日期是各标的日期的并集，表示不了缺口，未覆盖 | 14 项一致，2 项已知差异（D-QRP-01） |
| `services/baseline-evaluation`（封存摘要） | 不在 fixture 上比，而是对 `var/evidence` 的 4 份封存结果由序列重算 | 全部一致（见 §2） |
| `services/baseline-evaluation/summary_rederive.js`（2026-10-31 新增，导入器据此核对） | 无缺口的 3 个序列（US_CLEAN_60、US_COST_60、PATH_HAND_12） | 12 项一致 |
| 导入器对臂摘要的核对 | 测试：一致的摘要导入、四个字段各自被篡改时拒收，真实封存 Q0／Q1／Q2 照常导入 | D-QRP-02 已修（见 §3） |
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

| 编号 | 级 | 位置 | 内容 | 契约条款 |
| --- | --- | --- | --- | --- |
| D-QRP-01 | C | `backtestCurve` 的 `sharpe_like` | 等于 `cagr / annualized_vol`，不是 `mean(r)/sd(r) × √A`。例：US_CLEAN_60 参考 −0.5275，引擎 −0.5700。命名带 `like`，rf=0，其余字段（`cagr`、`annualized_vol`、`calmar`、最大回撤、累计收益）与契约一致 | §2.2 |
| D-QRP-02 | A | 导入器与页面读取（`baseline-evaluation`、`candidate-comparison`） | 臂摘要从不与自己的权益序列核对。**更正（2026-10-31）：**导入器 `importBaselineEvaluation`／`importCandidateComparison` 根本不看臂；`end_capital` 等于序列末点是在页面读取时 `accountBlock`／`armSummaries` 里查的，而且只查这一项。`cagr`、`max_drawdown`、`longest_underwater_sessions`、`recovered` 与序列不符时照收、照印（现有合成夹具 `tests/_q0_fixture.js` 的 D 臂就是这样）。**已修：**导入时和页面读取时都由序列重算并核对（`services/baseline-evaluation/summary_rederive.js`），不符即 `INVALID`，消息点名字段和两个数。仅对带 `summary.start_capital` 的臂生效（见下） | §1.2、§5、§6、§8 |

D-QRP-02 的修法与范围：
- 重算按契约：`cagr = (末点/起始资本)^(A/T) − 1`，T = 标记个数；`max_drawdown` 峰值从起始资本起算；水下期严格低于运行峰值；A 取策略档案的 `market`（`US_EQUITY` 252，`CRYPTO_USDM_PERP` 365）。小数项容差 5e-7（文件取 6 位），计数和布尔必须相等。
- **起始资本取自 `summary.start_capital`。** 现有真实封存的 US_V5（Q0、Q0-current、Q1、Q2）都带这个字段，都通过；US_CORE、Quick Shot、C17 的导入规格没有要求它，其测试夹具也没有，这些臂**不重算**（`check` 返回 `checked: false` 和原因，不当作已核对）。**跟进（协调会话裁定 2026-11-01）：下一版 US_CORE／Quick Shot／C17 的导入规格须要求带序列的臂有 `summary.start_capital`；在此之前这几类臂的摘要仍是原样印出、不被重算。** 未排期，随各自导入规格的下一次修订做。
- 没有改任何展示数字，页面输出与之前相同；全量 `npm test` 的失败集合与修改前逐项相同（87 项页面类测试，修改前即失败）。

另有一条观察而非缺陷：`max_dd_recovery_days` 是最近一次完成回撤的恢复天数，不是最长水下期，两者不可互相替代（契约 §8.4）。

## 4. 本仓库没有的

- 按月分块 bootstrap 的**实现**：它在 smartflow 未合并的研究分支 `research/us-v5-m2-q*`。本测试里的参考实现是它的第一个在仓库 main 上可复核的规格。
- 加密的封存序列（QS V3、C17 的封存结果没有 `arms.*.equity`），所以 365 的年化口径在 QRP 侧没有封存证据。
- 本机全量 `npm test`：87 项失败，全部在页面类测试（`ux_amendment_*`、`*_page`、`research_web_render` 等），在干净的 `origin/main` 上同样失败，与本变更无关。
