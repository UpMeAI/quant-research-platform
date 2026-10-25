# Cycle × Research × Desk：缺陷修复 R2 回执（2026-10-24）

权威验收：`docs/contracts/CYCLE_RESEARCH_DESK_REMEDIATION_R2_ACCEPTANCE_V1.md`  
缺陷逃逸：`docs/evidence/CYCLE_RESEARCH_DESK_REMEDIATION_DEFECT_ESCAPE_R2_2026-10-24.md`  
独立复核：`financial_loop_verifier`，最终结论 `PASS`  
历史说明：前两份实施回执保留，但其中的 `Implementation COMPLETE` 均已由对应缺陷逃逸记录撤销。

## 状态裁决

| 层 | 状态 | 证据／限制 |
|---|---|---|
| Implementation | **COMPLETE** | R2 冻结验收全部通过；独立金融闭环复核无代码或合同 blocker |
| Runtime verified | **FALSE** | 本机无 current-book 运行配置；真实签署模型还明确 `regulatoryFees=NOT_MODELLED`，current-book bundle 不能 seal |
| Product journey verified | **FALSE** | 尚未把一个真实 Desk candidate 经 K1/K2/K3 写回原 `REVIEW_LOOP_WEEK_V1` 的 RESULT/DO/DONT |
| Strategy conclusion | **INSUFFICIENT** | 无真实首案的完整成本、收益、风险、压力或采用结论；fixture 不构成策略证据 |
| Longitudinal observation | **FALSE** | 未启动或继承真实前向样本计数 |
| Production effect | **NONE** | 无订单、撤单、broker 连接、参数写入、发布、激活或调度变更 |

## 已完成的工程闭环

1. **运行态与研究态分离**：current `US_V5_ETF_3000USD`、predecessor baseline
   `US_V5_ETF_6000USD` 分别冻结；Cycle 只作有来源的 evidence context，不获得策略或资本决定权。
2. **Desk → Research → Desk 引用链**：Desk candidate/question、Experiment freeze、唯一 backtest artifact、
   Result Lock、三态结论和 adoption state 以 hash/identity 绑定；Research 无审批、激活或生产写权限。
3. **原生回放与单一窗口**：Smartflow 复用现有 `us-v5-plan-replay`；首个 EOD snapshot 是严格左开窗口起点，
   path、funnel、两臂费用和 NAV 使用同一窗口，snapshot 之前的 OPEN 不得混入。
4. **成本 fail closed**：费用读取生产事件的 number 形状；非有限或负值拒绝；每个净值日累计全部
   `event.date <= nav.date` 的窗口内费用。当前签署模型的监管费缺口只能形成
   `PARTIAL + missing=['REGULATORY_FEES']` 诊断，不能 seal、backtest、Result Lock 或 Desk 回链。
5. **账户与路径证据**：snapshot 校验 hash、schema、US market、current ledger/strategy、session、EOD 时间、
   MEASURED account、reconciliation、唯一 lot、instrument/units/cost/risk ladder；path 与 funnel 按 order id
   及 `filled + rejected = intended` 对齐。
6. **读取保护与自审计**：Research 默认 loopback，非 loopback 必须独立 read token；Runtime token 分面。
   `strategy_baseline`、`divergence_log`、`incident_catalog`、`anomaly_watchlist` 保持引用完整、业务幂等、
   append-only 和单向状态收敛，不产生生产动作。

## 确定性证据

- QRP：60 tests；59 pass、0 fail、1 skip。skip 是外部 Ashare-V5 checkout 不存在时的反分叉检查，
  明确不计为通过。
- QRP schema：19 个台账文件、369 条记录、0 违约。
- Research Web：1 个内联脚本语法编译通过。
- Smartflow：两组回放/换仓/Adapter 核验的 6-suite 并集为 65 tests，65 pass、0 fail；
  原五套为 59/59，替代 swap 五套为 54/54。
- 两仓 `git diff --check`：通过。
- exporter 探针：设置扫描相位和费用模型开关后退出码 1，精确错误
  `US_V5_BOOK_NOT_CONFIGURED:MISSING`；未用 fixture 替代真实运行证据。
- 独立复核确认：冻结 R3 未放宽；NaN/累计费用、EOD 窗口、snapshot 身份、path↔funnel、
  Result Lock、Desk 权威、读取保护和自审计均无残余 blocker。

## 当前真实阻断与下一动作

1. Owner 需先选择并提供一种权威、可冻结、可逐 fill 复核的 US regulatory-fee 来源；或者批准版本化的
   验收语义变更。现有 `NOT_MODELLED` 不能由工程代码推断为 0。
2. 在实际证据主机配置 current book（既有 `US_V5_BOOK_EXPORT=3000:2026-10-08T13:30:00.000Z`）、
   真实扫描相位及只读数据依赖；确认窗口起点 snapshot 通过全部合同和 EOD 校验。
3. 成本完整后运行 `npm run research:export:us-v5 -- --session <已闭市 NYSE session>`，保存 bundle hash，
   经只读 Adapter 进入冻结实验。
4. 用一个真实 Desk candidate 完成 K2/K3，把锁定引用写回 Desk 原 RESULT/DO/DONT；完成用户走查后，
   才能分别重裁 `Runtime verified` 与 `Product journey verified`。
5. 前向样本仍按原登记门槛积累；不得因工程闭环完成而提前宣称策略有效、可采用或可商业化。
