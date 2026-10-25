# Cycle × Research × Desk：运行态／研究态闭环验收 V1

状态：FROZEN  
冻结日期：2026-10-24  
范围：M0–M3 首案（当前 `US_V5_ETF_3000USD`，前任 `US_V5_ETF_6000USD`）  
上游规格：`/Users/kaylame/Downloads/Cycle_Research_Desk_金融策略投资系统设计与实施规格.md`  
上游规格 SHA-256：`f5762e47d414ac7867339b31383efe6da59351494da6ca83b109d7083e1d7f20`

本文件只冻结本轮实现与验收，不重写上游 V8，不改变 Desk 已签署的
`REVIEW_LOOP_WEEK_V1`、Smartflow/Ashare 的运行合同或任何生产采用条件。

## 1. 产品边界

系统保留三个入口和两条相互隔离的数据流：

1. Cycle 只提供可引用的市场／周期证据；首案未实际消费时为
   `RESEARCH_ONLY`、`NOT_APPLICABLE` 或 `UNKNOWN`，不得伪装成运行输入。
2. Research（QRP）只冻结输入、运行研究、锁定结果和保留失败；没有下单、
   撤单、生产参数写入、发布或激活权限。
3. Desk 继续作为用户决策与复盘入口；原 `REVIEW_LOOP_WEEK_V1` 是运行复盘到
   研究问题、研究结果到采用决定的唯一协调合同。
4. 运行态继续由 Ashare-V6 / Smartflow 原生产者负责。QRP 不复制策略决定逻辑，
   只通过市场仓的只读 Adapter 调用原生回放。
5. 当前运行对象与旧研究基线必须是两个独立引用；任何一方缺失均保持缺失，
   不用另一方回填。

## 2. 冻结对象

| 锁 | 权威内容 | 首案证据 |
|---|---|---|
| K1 Evidence Snapshot | 来源、版本、`as_of`、`known_at`、哈希、质量与新鲜度 | 市场 Adapter 的 `DATASET_SNAPSHOT_V1` |
| K2 Research Spec | 问题、唯一变化、样本用途、成本、执行、主指标、最低改善量、守卫、失败条件 | QRP `EXPERIMENT_SPEC_V1.freeze_hash` |
| K3 Result Lock | 原生回放结果、压力、三态结论、限制 | QRP `RESULT_LOCKED` + artifact `result_hash` |
| K4 Decision / Outcome | Desk 原诊断／候选、采用决定和后续运行版本 | Desk `REVIEW_LOOP_WEEK_V1` 引用；QRP 只存不可变引用 |

## 3. 首案选择与 M0 映射

首案按“原生可复现程度”选择 `US_V5`，不是按历史收益选择。

| 项 | 当前事实 | 责任与状态 |
|---|---|---|
| 当前 D | Smartflow `US_V5_ETF_3000USD`，PAPER；2026-10-08 起承接前任簿并保留原仓策略、扫描记录、账本和风险真相 | Smartflow；运行数据本轮尚未提供为可冻结 bundle，因此产品运行证据 `PENDING` |
| 旧基线 | 前任 `US_V5_ETF_6000USD`、`docs/evidence/us-v5-holding-swap*` 与现有已签研究记录；不得替换为当前 D | Smartflow；只作历史／前任研究证据，仍在退出的前任持仓不冒充当前簿新开仓 |
| 原生入口 | `scripts/lib/us-v5-plan-replay.js` → `v5Parity` → 生产策略模块 | Smartflow；不得在 QRP 重写 |
| 运行复盘 | `REVIEW_DECOMPOSITION_V1`、`STRATEGY_REVIEW_V1`、`OPERATION_REVIEW_V1` | Smartflow 生产、Desk 校验 |
| RSI 回链 | Desk `REVIEW_LOOP_WEEK_V1` 候选、研究槽、RESULT、DO/DONT | Desk/协调会话；继续沿用原时限和采用权 |
| Cycle | 当前 US_V5 无已证明的 Cycle/FinMap 运行消费 | 首案默认为 `RESEARCH_ONLY`；不得加入资本约束 |
| 成本／账户 | 由原生回放的冻结输入及净账户产物提供 | 缺失或未冻结即 `INSUFFICIENT`，不得按零处理 |
| 生产影响 | 研究阶段为 `NONE` | QRP 不发布、不激活、不改仓位上限 |

若当前 US_V5 bundle 缺实际扫描相位、载体行情、费用或账户路径，M1 不得以测试
fixture、演示 CN_A Adapter 或旧报告替代。此时保留工程已实现、实际运行未验证两种
状态；是否切换 C17 必须另开版本化修订，不能在本冻结文件中静默换案。

## 4. 冻结验收

### A. 工程与隔离

- A1：QRP 启动时注册已配置远程 Adapter；未配置明确跳过，已配置但不可达立即失败。
- A2：QRP 有明确的运行态、研究态、复盘回链只读投影；同一 case 双向可追踪。
- A3：Research Web/API 不暴露 Founder review/activate 写入口；原控制面服务不因本轮被改写。
- A4：研究 case 必须声明 `research_can_order=false`、`research_can_activate=false`、
  `research_can_write_runtime=false`，否则拒绝入账。
- A5：重复相同 case/link 幂等；同 ID 不同内容拒绝；历史行只追加不覆盖。

### B. 数据与冻结

- B1：当前运行引用、冻结基线、Cycle 证据、Desk 问题引用各自独立。
- B2：输入必须有 source/hash/as-of/known-at/quality；`MISSING`、`STALE`、
  `UNKNOWN`、`ZERO`、`NOT_APPLICABLE` 不混用。
- B3：只有 `verifyFreeze=true` 且 `RESULT_LOCKED` 的 QRP 实验可回链为研究结果；
  回链同时锁定 experiment freeze hash 和 artifact result hash。
- B4：结论机械映射为 `PASS`、`FAIL`、`INSUFFICIENT`；采用状态初始只能
  `NOT_DECIDED`，研究结果不得自动改变运行态。

### C. 原生首案

- C1：US_V5 Adapter 读取 Smartflow 自己生成并带哈希的 native replay bundle，
  校验文件边界、内容哈希、运行身份与安全声明；禁止任意路径读取。
- C2：bundle 缺扫描相位、实际载体、净成本、账户曲线、原生入口身份、数据质量
  任一关键项时 fail closed。
- C3：相同冻结 bundle + spec 重跑得到相同 `result_hash`；修改 bundle 后旧 snapshot
  与旧实验不漂移。
- C4：工程 fixture 只证明合同和决定论，不算真实运行或策略通过证据。

### D. 复盘与自审计

- D1：Desk 原 candidate/evidence 与 QRP experiment/result 可双向引用，不复制 Desk 状态机。
- D2：失败与不足结果保留；重复导入不增加独立样本。
- D3：QRP 落地 `strategy_baseline`、`divergence_log`、`incident_catalog`、
  `anomaly_watchlist` 四类 append-only 自审计对象；它们记录系统质量，不重算策略结论。
- D4：当前 D 与研究基线发生差异时只登记 divergence；不得因此自动回滚、发布或调仓。

## 5. 完成裁决

完成状态必须分开报告：

- `IMPLEMENTATION_COMPLETE`：A、B、D 的确定性测试通过，C 的 Adapter 合同通过。
- `RUNTIME_VERIFIED`：真实 US_V5 native bundle 完成可重放对账；测试 fixture 不可满足。
- `PRODUCT_JOURNEY_VERIFIED`：一个实际 Desk 诊断 → 冻结实验 → 锁定三态结果 →
  Desk RESULT/DO/DONT 引用完整走通。
- `LONGITUDINAL_OBSERVATION`：需要等待的前向样本达到原研究槽判据。
- `PRODUCTION_EFFECT`：本版本固定为 `NONE`；任何 PAPER 采用也必须走原 Desk/Owner 流程。

只有上述各自的证据满足时才能把对应项置真；某项为假不允许用其他项替代。
