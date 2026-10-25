# Cycle × Research × Desk：修复回执二次缺陷逃逸（2026-10-24）

## 被撤销的声明

`CYCLE_RESEARCH_DESK_REMEDIATION_RECEIPT_2026-10-24.md` 的
`Implementation COMPLETE` 被第二轮独立金融闭环核验否决。原文件及第一次修复验收保留，
不覆盖、不删改；它们只表示当时的裁决，不再作为当前完成证据。

## 逃逸缺陷

1. Smartflow `usV5Events()` 的 `quantity`、`price` 是 number，但 bundle builder 按
   `value.value` 读取；结果成为 `NaN`，旧累计逻辑又用零兜底，使真实成交费被伪装成 0。
2. 费用只按与净值点完全同名的日期累计，无法把两个净值点之间发生的费用 carry 到后续净值。
3. 窗口起点使用当日 EOD 账户 snapshot，但成交路径、漏斗和费用仍可混入该 snapshot 之前的事件，
   因而“初始账户”不是后续路径的真实初态。
4. 已签模型明确 `regulatoryFees=NOT_MODELLED`，但回执仍声称 `missing_components=[]` 和费用无缺项，
   违反原规格 AC6“不得把缺失费用假设为零”。

## 影响与安全状态

- 影响：US 首案的净值口径、成本完整性声明、窗口内运行路径及实施完成裁决。
- 未发生：真实 bundle、订单、撤单、broker 连接、参数写入、发布、激活或调度变更。
- `RUNTIME_VERIFIED`、`PRODUCT_JOURNEY_VERIFIED`、`LONGITUDINAL_OBSERVATION` 继续为 FALSE；
  策略结论继续为 `INSUFFICIENT`。

## 新修复权威

版本化修复验收：`docs/contracts/CYCLE_RESEARCH_DESK_REMEDIATION_R2_ACCEPTANCE_V1.md`。
只有该验收全部通过并经独立复核后，才可在新的 R2 回执中重新裁决实施状态。
