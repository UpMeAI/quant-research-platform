# Cycle × Research × Desk：V8.1 产品里程碑增量验收 V1

状态：FROZEN  
冻结日期：2026-10-24  
上游规格：`/Users/kaylame/Downloads/Cycle_Research_Desk_金融策略投资系统设计与实施规格_V8_1.md`  
上游规格 SHA-256：`ecfdda23b52075b8e69980576595fd89a1929f182af05e24fd851c2b2bed627f`  
前版规格 SHA-256：`f5762e47d414ac7867339b31383efe6da59351494da6ca83b109d7083e1d7f20`

本文件只冻结 V8.1 相对 V8 新增的 §12.2 产品里程碑、页面交付和阶段回执语义。
它不改写既有 R2 工程验收、Desk `REVIEW_LOOP_WEEK_V1`、Smartflow 运行合同或采用权限。
既有 `Implementation COMPLETE` 只证明原冻结工程范围，不自动证明 M1、M2 或 M3 产品已交付。

## P1. 单一产品里程碑真相

- 产品阶段证据由 QRP 运行态／研究态协调层的 append-only
  `PRODUCT_MILESTONE_EVIDENCE_V1` 产生；Research Web 只消费该投影，不自行推断阶段。
- 未记录的阶段显示 `NOT_VERIFIED`。代码存在、测试通过、HTTP 200、页面可渲染、实验已锁定或
  自述“完成”均不得自动提升阶段。
- 阶段只允许 `PASS` 或在缺陷逃逸后追加 `REVOKED`；不得覆盖历史记录。
- M1–M3 必须顺序通过。M4/M5 本轮只显示 `OUT_OF_SCOPE`，不因已有通用组件而置真。

## P2. 每条 PASS 的共同证据

每条 PASS 必须绑定一个已存在的 `RUNTIME_RESEARCH_CASE_V1`，并完整记录：

1. 实际入口与交付环境；
2. 本阶段新增可用功能和实际支持范围；
3. 一条完整用户操作、所得结果和后续状态；
4. 一个限制或异常的实际呈现；
5. 用户任务证据和适用技术验收证据；
6. 独立的记录人、时点和内容哈希。

字段缺失、空数组、未知 case、同 ID 内容漂移均 fail closed；相同内容重复提交必须幂等。

## P3. 分阶段准入

- **M0**：需要首案说明的实际阅读／确认记录和 T01/K1–K4 映射证据。可以带明确阻断通过，
  但不得因此声称 M1 就绪。
- **M1**：除 M0 PASS 外，需要真实 current-book 原生回放、完整净成本／账户对账、页面诊断操作、
  一项拒绝／未成交／过期／缺项的实际显示以及相应技术证据。fixture 不得作为真实运行证据。
- **M2**：除 M1 PASS 外，需要同一 case 的非 PENDING 锁定结果、固定评价报告、实际压力证据和
  结果重读证据。三态结论可以是 PASS/FAIL/INSUFFICIENT；产品能力缺失不能包装成 INSUFFICIENT。
- **M3**：除 M2 PASS 外，需要同一真实问题完成 Desk → Research → Desk 往返，绑定原 Desk
  后续状态，保存历史重读、Research 不可用时原 D 隔离、重复导入不重复计样本的证据。
  未采用或等待可以是有效终点；没有原采用／执行记录时不得显示为已采用／已执行。

## P4. 交付环境

- `CONTROLLED_PENDING_RELEASE` 表示受控环境已验收、仍待原授权发布。
- `TARGET_DELIVERED` 表示目标用户在获准的实际交付环境完成任务，必须额外绑定发布／交付证据。
- 页面同时显示阶段判断与环境；不得把前者的受控验收改写为线上可用。

## P5. 撤销与安全

- `REVOKED` 必须引用先前 PASS、缺陷记录和撤销理由；撤销 M0–M2 时，所有下游阶段在读模型中
  派生为 `INVALIDATED_BY_UPSTREAM`，历史 PASS 行仍保留。
- 里程碑记录无下单、撤单、broker、生产参数、发布、激活或 Desk 采用写权限。
- Research HTTP 继续只读；新增记录函数不从普通 Web/API POST 暴露。

## P6. 本轮确定性完成证据

1. 正向测试证明 M0→M1→M2→M3 顺序、受控环境与目标环境分别投影。
2. 负向测试证明缺共同字段、缺前置阶段、缺 M1 真实运行／异常证据、缺 M2 锁定结果／压力、
   缺 M3 Desk 往返、无发布证据却声明目标交付、同 ID 漂移均被拒绝。
3. 撤销测试证明历史不覆盖、下游阶段失效且产品状态不被工程状态替代。
4. Research Web 明确显示 M0–M3 状态、实际入口、环境、用户结果、限制和证据；无记录时显示
   `NOT_VERIFIED`，不得显示健康零值。
5. QRP 全量测试、schema、Research Web 语法和 `git diff --check` 为 0 fail；R2 金融成本与
   Result Lock 保护不回归。
6. 独立金融／产品真相复核无阻断项。真实 M1–M3 状态继续由实际证据决定，工程测试不得置真。

## 当前冻结裁决

- M0：`NOT_VERIFIED`（已有准备映射，但无 V8.1 所需完整用户任务回执）。
- M1：`NOT_VERIFIED`（current-book 配置缺失，监管费用仍 `NOT_MODELLED`）。
- M2：`NOT_VERIFIED`（无首案真实完整成本结果与压力报告）。
- M3：`NOT_VERIFIED`（无真实 Desk 往返和目标用户走查）。
- M4/M5：`OUT_OF_SCOPE`。
- Production effect：`NONE`。
