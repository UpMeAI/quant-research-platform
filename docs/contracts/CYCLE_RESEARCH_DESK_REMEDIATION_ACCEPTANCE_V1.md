# Cycle × Research × Desk：缺陷逃逸修复验收 V1

状态：FROZEN  
冻结日期：2026-10-24  
修订对象：`CYCLE_RESEARCH_DESK_RUNTIME_RESEARCH_LOOP_ACCEPTANCE_V1.md`  
原因：独立金融闭环验证在首份实施回执后发现身份绑定、结果锁、C2 数据完整性、读取保护及自审计幂等缺口。

本文件不改写原冻结验收，也不把原回执追溯改成通过。原回执中的
`Implementation COMPLETE` 自本修复验收冻结时起撤销；只有本文件全部通过后，
才可在新的修订回执中重新裁决 `IMPLEMENTATION_COMPLETE`。

## R1 运行案例与研究结果身份锁

- link 的 case 必须存在；case、ExperimentSpec、BacktestArtifact 的 market 必须一致。
- case `strategy_ref` 必须等于 ExperimentSpec `champion_ref`。
- Desk `research_question_ref` 必须等于 ExperimentSpec `hypothesis_ref`。
- US_EQUITY artifact 必须携带相同 `native_identity.strategy_ref`。
- 跨市场、跨策略、跨问题的已锁实验一律拒绝回链。

## R2 结果锁与机械裁决

- 未完成 backtest 的实验不能 Result Lock。
- Result Lock 的 `sample_evidence_ref` 与 `result_artifact_hash` 必须等于该实验唯一的
  `backtest_artifact_hash`；调用方不得用 Race sample 或任意字符串替换。
- 结果锁定后不得再次运行 backtest。
- artifact 提供 `mechanical_adjudication` 时，登记 verdict 必须一致；不一致拒绝。

## R3 US_V5 C2 完整性

- bundle 必须含实际载体、初始现金/持仓、成交路径、拒绝路径及其 hash。
- 决策漏斗必须是 `COMPLETE`，五项计数均为非负整数且关系自洽。
- Champion 与 Challenger 均按同一已签费用模型逐 fill 扣费；费用总额必须可加总，
  `missing_components=[]`，NAV 明确为 `NET_OF_SIGNED_MODEL_COSTS`。
- 缺任一项时 bundle 校验或 backtest fail closed；`DEGRADED` bundle 不运行研究回测。
- US_V5 首案固定机械裁决为 `INCONCLUSIVE`，不产生自动采用或发布权限。

## R4 Research 读取保护

- 默认只监听 `127.0.0.1`。
- 非 loopback 绑定必须配置 `QRP_RESEARCH_TOKEN`，缺失时启动配置失败。
- 配置 token 后，Research Web 与普通 `/api/*` GET 必须携带独立 read token。
- `/api/runtime/*` 继续使用独立 `QRP_RUNTIME_TOKEN`，两类安全面不混用。

## R5 自审计完整性

- divergence 的 `baseline_ref` 必须引用已存在 baseline。
- divergence、incident 与 anomaly 在调用方不传记录时间时仍按业务内容幂等。
- anomaly 只允许 `OPEN → OBSERVING → RESOLVED/DISMISSED` 的单向状态演进；终态不可重开。
- 所有对象仍为 append-only，且不触发生产动作。

## 完成证据

1. QRP 全量确定性测试 0 fail；skip 单列，不计通过。
2. Smartflow 指定五套原生回放/Adapter 测试 0 fail。
3. C2 缺成本和缺路径的负向测试必须通过。
4. 跨市场回链、未回测锁结果、机械裁决不一致、非 loopback 无 token、缺 baseline、
   无时间戳重放均有负向或幂等测试。
5. 真实 `US_V5_ETF_3000USD` bundle、实际 Desk 用户旅程和前向观察仍是独立状态，
   不因本修复验收通过而自动置真。
