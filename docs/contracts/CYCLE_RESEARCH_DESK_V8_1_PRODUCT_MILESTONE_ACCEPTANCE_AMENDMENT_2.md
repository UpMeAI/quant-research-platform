# Cycle × Research × Desk：V8.1 产品里程碑验收修订 2

状态：FROZEN  
冻结日期：2026-10-24  
适用 case：`US_V5_ETF_3000USD`  
原验收：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_V1.md`  
原验收 SHA-256：`32682ab08a03c168b1cb3648bd72133682785f573076b22ae026b1fabc1f717e`  
修订 1：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_1.md`  
修订 1 SHA-256：`76d504ce05ebe3e2677b7e768460e543e15f154726561edc5cbf16a4b8918998`

本修订只冻结 US_V5 首案 M1 的真实来源、历史窗口、净成本和页面验收语义；不重写 V1 或修订 1，
不改变 M0–M3 的当前判定，不授予完成、发布、采用、交易、资金、生产参数或生产账本写权限。

## A2.1 阶段真相分层

页面和回执必须分别展示，且不得互相代替：

1. **M0 准备盘点**：T01、K1–K4、来源与缺口的工程盘点；存在不等于 M0 PASS。
2. **负责人核对**：由原完成权威登记的实际阅读／确认记录；未登记时保持 `NOT_VERIFIED`。
3. **M1 产品验收**：同一 case 的真实原生回放、净核算、异常和完整用户任务证据；受 M0 当前有效
   PASS 约束。
4. **发布状态**：`CONTROLLED_PENDING_RELEASE` 与 `TARGET_DELIVERED` 分开；受控环境检查不等于发布。

本轮实现、HTTP 200、浏览器走查、测试通过或本修订本身均不得修改上述状态。

## A2.2 首案对象与固定窗口

- 当前对象：`US_V5_ETF_3000USD@2026-10-08T13:30:00.000Z`。
- 历史窗口：NYSE session `2026-10-08` 至 `2026-10-23`，共 12 个交付 session。
- 运行模式：`PAPER`；`real_order=0`；没有真实账户臂。
- 冻结前身：`US_V5_ETF_6000USD`。旧记录不得重标为当前对象，不得按资金比例缩放为当前结果。
- 当前簿必须由当前初始现金 3000 USD、当前簿扫描记录和当前簿账户路径重放。

## A2.3 三类来源不得混写

1. **历史真实记录**：Smartflow 原生产者的 `US_V5_SCAN_RECORD_V2`、纸面交易、Desk 决策／监控和
   `POSITION_LEDGER_SNAPSHOT_V1`。它们回答实际扫描、决策、纸面成交和账户当时记录了什么。
2. **原生历史回放**：Smartflow `runV5Book` / US_V5 plan replay 对同一 current-book 输入的只读重放。
   必须保存原生输出 hash、扫描记录 hash 校验、回放引擎版本／文件 hash 和 parity；不得把回放事件
   写回历史账本，也不得称为历史真实成交。
3. **报告比较基准**：同窗 SPY 日线只用于报告比较臂 B；不得进入策略信号、成交或账户事实。

任一来源缺失、内容漂移或对象不一致时，诊断以 `MISSING`／`INVALID` 失败关闭，不能用 0 补齐。

## A2.4 M1 研究净成本模型

模型名：`US_V5_M1_RESEARCH_COST_V1`。它是 Research 对纸面毛额账本的只读净额覆盖层，不是经纪商
账单，也不改变 Desk 现金或交易记录。

- 策略签署成本：买入和卖出各按实际成交名义金额的 5 bps 精确计算；Desk 已记录的卖出侧
  `0.61828` 是同一模型的一部分，净核算不得再次重复计费。
- 滑点：生产数据库记录的 `slippage_cost` 已体现在纸面成交价中，只披露、不二次扣减。
- 普通股票／ETF 佣金：本案按当前簿已签署的 0 佣金口径；不适用于 Elite router、非零售或合作方
  另行收费场景。
- SEC：卖出侧按交易日有效的 `$20.60 / $1,000,000`；依据 SEC 2026-02 advisory，自 2026-04-04
  起适用。
- FINRA TAF：FINRA 2026 标准为 `$0.000195 / share`，但 Alpaca 2026-10-12 修订费表在股票项标为
  `$0 / share`；本案卖出发生于 2026-10-14，按经纪商交易日口径计 0，同时在页面披露与 FINRA 标准
  的差异。
- CAT：买卖两侧各 `$0.000003 / executed equivalent share`。
- 经纪商聚合：每一费用类型按日、按账户聚合后向上取整到美分。由于 Research 没有全账户其他交易
  或正式账单，本案按“仅此策略簿为该账户当日交易”的 stand-alone 口径建模；因此监管费是完整、
  可复算的研究模型值，不得标为实际扣费。

权威公开来源：

- Alpaca Brokerage Fee Schedule，revised 2026-10-12：
  `https://files.alpaca.markets/disclosures/library/BrokFeeSched.pdf`
- SEC FY2026 Section 31 Fee Rate Advisory：
  `https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2`
- FINRA Fee Adjustment Schedule：
  `https://www.finra.org/rules-guidance/rule-filings/sr-finra-2024-019/fee-adjustment-schedule`

## A2.5 账户对账断言

页面所用 canonical 诊断生产者必须逐项验证：

1. 2026-10-08：现金／权益 3000、持仓 0；
2. 2026-10-09：MSFU 买入 29 股，纸面成交价 42.466897；现金 1768.459987、持仓 29 股；
3. 2026-10-14：MSFU 因 `TIME_STOP` 纸面卖出 29 股，成交价 42.64；
4. 2026-10-23：毛额现金／权益 3005.019987、持仓 0；
5. 毛额损益 = 卖出名义金额 − 买入名义金额 = 5.019987；
6. Research 净损益 = 毛额损益 − 双边 5 bps − stand-alone 监管费；
7. 现金、持仓、费用和净结果任一等式残差超过 `1e-6 USD` 或 `1e-8 share` 时为 `INVALID`。

## A2.6 M1 页面与用户任务

不新增顶层入口，不改冻结的信息架构。实际入口为：

`/#strategy-detail?strategy=US_V5_ETF_3000USD&section=health`

兼容入口 `/#runtime-research-loop` 仍定向到同一策略详情的“体检与证据”。用户必须能在一个连续任务中：

1. 确认对象、窗口、运行模式和原版规则；
2. 区分真实记录、原生回放和 SPY 报告基准；
3. 从 MSFU 原生信号追踪到买入、时间止损监控和纸面卖出，看到成交原因；
4. 查看至少一项实际拒绝或缺项（例如 RSI 闸门拒绝，或原开仓费用 `NOT_MEASURED`）；
5. 核对起始、持仓期和期末现金／持仓，查看毛额、逐项费用与 Research 净结果；
6. 看见原生回放 parity、12-session 样本不足和没有真实账户臂的限制；
7. 看见 Research 不能下单、激活、写运行参数或账本，且产品阶段仍由原权威裁决。

内部 ID、路径和 hash 置于技术披露，不作为理解任务的前置条件。

## A2.7 确定性证据与当前状态

- 单元测试必须覆盖来源漂移、缺失不等于零、前身隔离、费用不重复、账户等式、基准隔离和只读边界。
- 运行检查必须从真实输入包生成 canonical 诊断，不得由前端重算。
- 产品检查必须走实际入口完成 A2.6 的连续任务，并记录桌面与窄屏证据、环境和版本。
- 独立金融／产品复核必须检查净成本、实际／回放区分和里程碑真相。

冻结时状态：M0 准备盘点已有证据；负责人核对 `NOT_VERIFIED`；M0–M3 均保持
`NOT_VERIFIED`；发布状态为 `NOT_RELEASED`；Production effect 为 `NONE`。
