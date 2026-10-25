# Cycle × Research × Desk 缺陷修复回执（2026-10-24）

权威修复验收：`docs/contracts/CYCLE_RESEARCH_DESK_REMEDIATION_ACCEPTANCE_V1.md`  
缺陷逃逸：`docs/evidence/CYCLE_RESEARCH_DESK_DEFECT_ESCAPE_2026-10-24.md`  
原回执：保留但其 `Implementation COMPLETE` 已撤销，不作为本裁决证据。

## 状态裁决

| 层 | 状态 | 证据／限制 |
|---|---|---|
| Implementation | **COMPLETE** | R1–R5 的身份锁、artifact-bound Result Lock、US C2 fail-closed、读取保护及自审计完整性均有确定性正/负向测试 |
| Runtime verified | **FALSE** | 本机没有当前 `US_V5_ETF_3000USD` 运行簿配置和实际证据；exporter 探针仍明确失败 `US_V5_BOOK_NOT_CONFIGURED:MISSING` |
| Product journey verified | **FALSE** | 未把一个实际 Desk candidate 经真实 K1/K2/K3 写回原 `REVIEW_LOOP_WEEK_V1` RESULT/DO/DONT |
| Strategy conclusion | **INSUFFICIENT** | 工程 fixture 的机械裁决固定为 `INCONCLUSIVE`；没有真实首案的收益、风险或采用结论 |
| Longitudinal observation | **FALSE** | 没有启动或继承实际前向样本计数 |
| Production effect | **NONE** | 无订单、撤单、broker 连接、参数写入、发布、激活或调度变更 |

## 修复证据

1. case ↔ Experiment ↔ Artifact 强制同 market、同 current strategy/champion、同 hypothesis；
   `US_V5_ETF_3000USD` 当前簿与 `US_V5_ETF_6000USD` 前任 baseline 分别保存，旧 baseline 身份不再被 current strategy 覆盖。
2. 未回测不能 Result Lock；结果同时绑定 `backtest_artifact_hash`、`result_artifact_hash`、
   `sample_evidence_ref`；锁定后不可重跑；artifact 有机械裁决时手填不同 verdict 被拒绝。
3. US bundle 只接受实际扫描记录和窗口起点带 hash 的 `POSITION_LEDGER_SNAPSHOT_V1`；
   明确载体、初始现金/持仓、风险状态、成功 order id、拒绝路径及完整五段漏斗。
   `filled + rejected` 必须严格等于 `intended`，成功 order 与账本 opened row 必须逐 id 相等。
4. Champion 与 Challenger 逐 fill 使用已签 `US_V5_ETF_3000USD.feeModel`；fee、commission、
   funding、slippage 均显式给出，缺项拒绝，NAV 标记 `NET_OF_SIGNED_MODEL_COSTS`。
5. Research 默认只绑定 `127.0.0.1`；非 loopback 缺 `QRP_RESEARCH_TOKEN` 启动失败；
   Research read token 与 Runtime token 分离。
6. divergence 必须引用存在的 baseline；无调用方时间戳仍业务幂等；anomaly 只允许
   `OPEN → OBSERVING → RESOLVED/DISMISSED`，JSONL 与 PostgreSQL 合同同义。

## 确定性验证

- QRP 全量：59 tests，58 pass，0 fail，1 skip。skip 为外部 Ashare-V5 预期 checkout 不存在，明确不算通过。
- QRP schema：19 个台账文件、369 条记录、0 违约。
- Research Web 内联 JavaScript：语法编译通过。
- Smartflow 相关：5 suites，58 tests，0 fail；含 native replay、book replay、swap、review decomposition、Adapter/HTTP/QRP E2E。
- 两仓 `git diff --check`：通过。
- 真实 exporter 探针：`US_V5_BOOK_NOT_CONFIGURED:MISSING`，保持失败，不用 fixture 代替。

## 下一精确动作

在实际 `us-desk-exports` 证据主机上：

1. 确认 current book 身份来自既有 `US_V5_BOOK_EXPORT=3000:2026-10-08T13:30:00.000Z`，
   设置真实 `US_V5_QRP_SCAN_PHASE`，并启用已签 `US_DESK_V5_MODELLED_FEE=1`；不得手填费用版本冒充签署值。
2. 确认比较窗口起点的 `POSITION_LEDGER_SNAPSHOT_V1` 为 `MEASURED`、hash 有效，且含真实 cash/lots/risk；缺失就先修生产证据，不封包。
3. 运行 `npm run research:export:us-v5 -- --session <实际已闭市 NYSE session>`，保存 bundle hash 与只读来源。
4. 以独立 token 启动 Smartflow Adapter；QRP 默认 loopback，若经网络访问则配置 `QRP_RESEARCH_TOKEN` 与市场 Adapter token。
5. 用一个实际 Desk candidate 形成 K2，锁定真实 K3，再把引用写回 Desk 原 RESULT/DO/DONT；走查完成后才分别改变 Runtime/Product 状态。
