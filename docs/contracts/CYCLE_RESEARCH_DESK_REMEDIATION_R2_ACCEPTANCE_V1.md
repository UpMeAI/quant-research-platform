# Cycle × Research × Desk：缺陷逃逸修复验收 R2 V1

状态：FROZEN  
冻结日期：2026-10-24  
修订对象：`CYCLE_RESEARCH_DESK_REMEDIATION_ACCEPTANCE_V1.md` 的 R3 费用与路径语义  
缺陷记录：`docs/evidence/CYCLE_RESEARCH_DESK_REMEDIATION_DEFECT_ESCAPE_R2_2026-10-24.md`

本文件不改写或放宽原冻结验收。已签 US_V5 费用模型明确未建模监管费，所以当前真实首案
尚不满足原 R3 的 `missing_components=[]`。R2 要求先如实识别这一缺口，再在 bundle seal、
backtest 和 Desk 回链三层 fail closed；不得用 `INCONCLUSIVE` 绕过冻结的输入完整性门槛。

## R2-1 数值与累计

- 成交事件的 `quantity`、`price` 必须读取生产者的实际 number 形状；非有限、负费用直接拒绝。
- 每个净值日的累计费用等于窗口内所有 `event.date <= nav.date` 的有效费用和；两个净值点之间的
  事件必须 carry 到后一个净值点，不得只做日期精确匹配。
- Champion 与 Challenger 分别逐 fill 计算；fixture 必须锁定可手算金额，防止 `NaN → 0` 回归。

## R2-2 单一时间窗口

- 窗口初态是第一个净值日的、hash 有效的 EOD `POSITION_LEDGER_SNAPSHOT_V1`。
- 成交路径、拒绝路径、决策漏斗和两臂费用只包含 `event_at > initial_account.as_of` 且不晚于
  最后一个净值日的事件；起点 snapshot 之前的 OPEN 不得进入运行路径或费用。
- `initial_account.session_date` 必须等于首个净值日，成本 `period.after` 必须精确等于 snapshot
  `as_of`，`period.through` 必须等于最后一个净值日。
- Champion 首个账户 mark 必须与 snapshot equity 在预定 `$0.01` 容差内一致；两臂净值各自从 1
  归一化。路径事件超窗、路径与漏斗计数漂移均 fail closed。

## R2-3 成本完整性与研究准入

- 成本诊断必须把 `regulatory_fees=NOT_MODELLED` 映射为
  `missing_components=['REGULATORY_FEES']` 和 `PARTIAL`，不得记零或隐藏。
- 只有 `missing_components=[]`、`state=MEASURED`、`completeness=COMPLETE` 且范围明确为
  `COMPLETE_SIGNED_MODEL_COSTS` 的 bundle 才能通过校验并声明 `NET_OF_SIGNED_MODEL_COSTS`。
- 当前真实签署模型为 `PARTIAL`，所以 exporter 必须在 seal 时失败；即使外部构造 partial bundle，
  `validateBundle` / `run_backtest` 也必须拒绝，QRP 不得 Result Lock 或回链 Desk。
- 补齐监管费的可验证来源或变更冻结验收语义都需要 Owner 决定；工程代码不得自行推断。

## 完成证据

1. Smartflow 直接测试证明跨净值日累计，并证明 `NaN` 费用被拒绝。
2. 生产同形的费用诊断证明窗口内 Champion/Challenger 已签模型费用各为 `$0.72`，同时明确
   `REGULATORY_FEES` 缺失并证明 seal 拒绝；不把该诊断当研究结果。
3. 仅用于工程成功路径的完整成本 fixture 证明首点 NAV 为 1、运行路径仅含 snapshot 之后的
   CLOSE，不含之前的 OPEN；另有负向测试证明超窗路径、隐藏成本缺项、成本/路径/漏斗漂移均被拒绝。
4. QRP 全量、schema、Research Web 语法及 Smartflow 指定五套原生回放/Adapter 测试均为 0 fail；
   skip 单列，不计通过。
5. 独立复核无阻断项。真实 current-book bundle、Desk 实际写回、前向观察仍是独立状态，
   不因工程验收通过而自动置真。
