# Cycle × Research × Desk V8.1：本轮施工回执（2026-10-24）

规格：`/Users/kaylame/Downloads/Cycle_Research_Desk_金融策略投资系统设计与实施规格_V8_1.md`  
规格 SHA-256：`ecfdda23b52075b8e69980576595fd89a1929f182af05e24fd851c2b2bed627f`  
冻结验收：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_V1.md`  
验收修订：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_1.md`  
首案证据：`docs/evidence/CYCLE_RESEARCH_DESK_V8_1_T01_M0_2026-10-24.md`
独立复核：`docs/evidence/CYCLE_RESEARCH_DESK_V8_1_INDEPENDENT_VERIFICATION_2026-10-24.md`

## 用户现在能打开什么

受控本地只读入口：`http://127.0.0.1:4311/#runtime-research-loop`。

页面新增并实际显示：

1. V8.1 规格身份、SHA-256 与“工程成功不等于产品交付”的裁决规则；
2. M0–M3 的产品阶段真相、交付环境、实际入口、用户结果、异常和证据；
3. 当前 D、冻结 predecessor、数据质量、Cycle 边界、生产影响与 Desk 回链；
4. 无记录时 `NOT_VERIFIED`，M4/M5 为 `OUT_OF_SCOPE`，缺失不显示为零或健康。

本轮使用的真实对象是 `RRC-US-V5-3000-V8-1-M0`：当前 D 为
`US_V5_ETF_3000USD`，冻结 predecessor 为 `US_V5_ETF_6000USD`。实现者在页面完成
“打开闭环页 → 核对规格身份 → 核对当前/旧账本 → 读取数据降级和 M1 阻断 → 确认生产影响为 NONE”
的受控检查。结果是页面正确显示 `M1_BLOCKED_NATIVE_BUNDLE_AND_COMPLETE_COSTS`、
`DEGRADED`、M0–M3 `NOT_VERIFIED`。这不冒充目标用户走查或目标环境发布。

## 工程

状态：**COMPLETE（独立复核 PASS）**。

- 新增冻结的 V8.1 产品里程碑验收，未改变既有运行、研究、Desk 采用合同。
- `PRODUCT_MILESTONE_EVIDENCE_V1` 是 append-only 单一里程碑生产者；Research Web/API 只读消费。
- PASS 必须绑定实际用户任务、交付环境、用户/技术证据及阶段专属证据。
- 任意字符串不再能作为证据：所有引用必须先登记为 case/类型绑定的实际文件，登记和晋级时均复验
  SHA-256/大小；fixture/demo/mock/synthetic 路径拒绝。
- `QRP_PRODUCT_MILESTONE_AUTHORITY` 未配置或记录人不匹配时，里程碑登记和晋级均 fail closed；
  普通只读 Research 进程不配置该完成权威。
- 独立复核发现的“非空伪引用可晋级”缺陷已在发布前修复，并以
  `INC-V8-1-PRODUCT-EVIDENCE-PSEUDOREF-GATE` 保留根因、修复和复发保护；没有实际阶段被错误置真。
- M0→M3 顺序 fail closed；M2/M3 必须绑定同 case 的锁定结果；M3 必须有 Desk outcome 和往返证据。
- 撤销保留历史并使下游失效；每一阶段绑定当时直接上游证据，上游重新通过不会自动复活旧下游 PASS。
- 上述再验收保护以版本化修订 1 冻结，原验收文件保持原 SHA-256，不重写历史。
- Research 页面移除审批/激活操作，不提供产品里程碑普通 HTTP 写入口。
- 真实只读首案已进入 QRP 本地研究台账；current 与 predecessor 使用不同来源和哈希。
- M1 就绪缺口以 `ANOM-US-V5-V8-1-M1-READINESS` 进入 anomaly watchlist，不升级为事故或策略结论。

## 实际运行

状态：**FALSE（M1 未就绪）**。

- 2026-10-23 Desk current snapshot、strategy review、trade ledger 均经原合同验证，文件哈希与内部哈希已记录在 T01。
- 本地 exporter 首次真实探测在提供 scan phase 后返回
  `US_V5_BOOK_NOT_CONFIGURED:MISSING`；未生成 bundle，未写运行态。
- 当前签署费用模型的 SEC/FINRA 监管费为 `NOT_MODELLED`，QRP 必须保持
  `PARTIAL + REGULATORY_FEES`，不能封成 `COMPLETE_SIGNED_MODEL_COSTS`。
- Smartflow 本地没有 current-book native scan bundle/benchmark 完整输入，所以未执行完整原生回放、账户对账或决策漏斗锁定。

## 产品验收

| 阶段 | 当前判断 | 原因 |
|---|---|---|
| M0 | `NOT_VERIFIED` | T01 与实际只读 case 已完成，但没有目标用户在获准交付环境完成整条 M0 任务的证据 |
| M1 | `NOT_VERIFIED` | 缺 current-book 原生输入和完整签署净成本，不能形成真实 replay/account/funnel 证据 |
| M2 | `NOT_VERIFIED` | 原队列无已许可的 US_V5 明确问题，且无同 case 锁定结果与压力报告 |
| M3 | `NOT_VERIFIED` | 无真实 US_V5 Desk candidate/result/outcome 往返和历史重读 |
| M4/M5 | `OUT_OF_SCOPE` | V8.1 本轮不施工 |

受控验收环境是本机 QRP `127.0.0.1:4311`；目标交付环境未发布、未验证。

## 确定性验证

- QRP 全量：62 tests，61 pass，0 fail，1 skip；skip 为本机缺 Ashare-V5 跨仓源，未计为通过。
- V8.1/闭环定向：9/9 pass。
- QRP schema：23 个台账文件、373 条记录、0 违约。
- Research Web inline JavaScript：语法通过；`git diff --check`：通过。
- Smartflow US 原生回放/换仓/Adapter 并集：6 suites、65 tests、全部通过。
- 受控页面和 `/api/runtime-research-loop` 实际读取：真实 case、阶段状态和生产影响与合同一致。
- 独立金融／产品真相复核：PASS；仅确认 V8.1 增量工程完成，不提升 Runtime/Product/Research/Production。

## 研究结论

状态：**INSUFFICIENT_INPUTS**，不是策略参数结论。

US_V5 仍为首案，因为其原生回放与 QRP adapter 工程链最完整；没有按收益挑选。
第一轮未调参数。当前证据只足以确认运行复盘里的账本、MODELLED 费用和 parity 事实，不足以完成
V8.1 要求的完整成本研究回放。C17 没有被静默切入，也没有改变原研究槽顺序。

## 生产影响

状态：**NONE**。

未使用交易凭证，未连接 broker，未下单/撤单，未写生产参数、交易账本、Desk 采用状态、部署或调度；
未调用演示审批、发布或自动激活。原有效策略继续按原规则运行。

## 下一可执行动作

1. 证据主机只读导出 current-book scan records、benchmark bars、账本与固定 scan phase。
2. Owner/合同生产者提供逐 fill 监管费权威来源，或创建版本化验收修订；不得推断为 0。
3. 满足 1–2 后生成真实 sealed bundle，完成原版回放、账户对账、漏斗与 Research 诊断走查，再记录 M1 产品证据。
4. M2 继续等待原队列允许的 US_V5 问题；M3 使用原 Desk RSI/candidate/outcome，不创建名字绕过历史独立性。

## 附录 C

```yaml
任务与阶段: V8.1 T01/M0；按就绪条件检查 M1
产品交付:
  本阶段产品承诺: 明确首案和来源边界；建立不可伪造的产品阶段真相；M1 仅在真实依赖齐备时推进
  实际用户入口: http://127.0.0.1:4311/#runtime-research-loop
  环境与发布状态: CONTROLLED_LOCAL_READ_ONLY_NOT_TARGET_DELIVERED
  本期新增可用功能: 真实 current/predecessor case 诊断；M0-M3 证据裁决；撤销与下游失效；只读页面
  实际支持范围: US_V5_ETF_3000USD current 与 US_V5_ETF_6000USD predecessor；M4/M5 不在范围
  完整用户操作与真实对象: 实现者读取 RRC-US-V5-3000-V8-1-M0 的阶段、账本、数据质量与阻断；目标用户任务尚无记录
  用户所得结果与后续状态: 明确 M1 缺 native bundle 和完整监管费；阶段保持 NOT_VERIFIED
  限制或异常场景与实际显示: 缺失显示 DEGRADED/NOT_VERIFIED；工程或 HTTP 成功不置真；生产影响 NONE
  对应12_2里程碑及判断: M0 NOT_VERIFIED；M1 NOT_VERIFIED；M2/M3 NOT_VERIFIED；M4/M5 OUT_OF_SCOPE
执行职责与复核职责: Codex 实施；financial_loop_verifier 独立只读 PASS
目标仓库_分支_原任务: quant-research-platform/main；smartflow/main；portfolio-desk/main 只读；沿用原任务与研究槽
工程实现: COMPLETE
实际运行: FALSE
产品验收: FALSE
研究结论: INSUFFICIENT_INPUTS
生产影响: NONE
下一步与责任方: 证据主机/Owner 补真实只读输入与监管费来源；工程随后继续 M1
```

---

## 附录 C 增量回执：全站人类可读 Research 工作台

### 用户现在能打开什么

用户现在可以直接打开 `http://127.0.0.1:4311/#strategies`，并在同一入口使用七个按任务命名的页面：
“系统总览、当前策略体检、研究问题、方案对比、前向观察、采用与复盘、数据与运行状态”。

本次新增的可用能力是：所有页面先显示 Desk 的“市场 → 策略 → 当前任务”，内部 case/bundle/experiment/
race/release/hash 只在默认折叠的技术详情中出现；没有真实关联的 A 股和加密明确显示“尚未接入真实研究
case”，旧 CN_A 链只出现在“技术与历史样例”，不再冒充当前 Desk 策略。

受控走查使用的真实对象仍是美股 `US_V5_ETF_3000USD` current book 及其
`US_V5_ETF_6000USD` 冻结 predecessor。完整用户操作为：打开总览确认真实覆盖 → 进入当前策略体检读取
current/predecessor 与三项阻断 → 查看研究问题、方案对比、前向观察和采用与复盘的诚实空态 → 在数据与
运行状态核对三类实际输入、缺口与 Research 权限。用户所得结果是：当前美股首案已接入展示，但 M1 仍因
原生扫描包、基准行情和完整监管费用缺失而 `BLOCKED`；研究链为空，生产影响 `NONE`。

```yaml
任务与阶段: V8.1 全站 Research 人类可读 UX 缺陷修复；不提升 M0-M3
产品交付:
  本阶段产品承诺: 将 QRP 全站从内部对象/ID 导航改为 Desk 市场-策略-用户任务导航，保持事实与权限边界
  实际用户入口: http://127.0.0.1:4311/#strategies 及同入口七个 hash 页面
  环境与发布状态: CONTROLLED_LOCAL_READ_ONLY；浏览器已交付打开；目标环境未发布、目标用户完整任务尚未再次确认
  本期新增可用功能: 全局真实策略上下文；七个用户问题页；诚实空态；技术详情渐进披露；三市场覆盖说明；fail-closed 就绪显示
  实际支持范围: 美股 US_V5_ETF_3000USD current 与 US_V5_ETF_6000USD predecessor；A 股/加密未接入状态；旧 CN_A 工程样例隔离
  完整用户操作与真实对象: 浏览器逐页完成总览→体检→问题→对比→前向→采用复盘→数据运行状态；对象为 RRC-US-V5-3000-V8-1-M0
  用户所得结果与后续状态: 读到三项实际缺口、四段研究链 EMPTY、M0-M3 尚未验证、Research 只读、生产影响 NONE
  限制或异常场景与实际显示: UNKNOWN/STALE/INVALID/null/未识别 freshness 均 fail closed 为 BLOCKED；未接入不显示为 0；页面错误态实现但本轮未在真实浏览器注入网络故障
  对应12_2里程碑及判断: M0 NOT_VERIFIED；M1 NOT_VERIFIED；M2/M3 NOT_VERIFIED；M4/M5 OUT_OF_SCOPE；本次只完成受控 UX 缺陷修复
执行职责与复核职责: Codex 实施与浏览器走查；financial_loop_verifier 独立只读复核 PASS（首次发现 P1，修复后复核无阻断）
目标仓库_分支_原任务: quant-research-platform 当前工作树；沿用原任务、研究槽、生产者与采用流程
基线提交与交付提交: 未提交；保护现有未完成改动，以当前工作树 diff 和本回执标识
范围:
  策略_账本_模式: US_V5 ETF 主策略；3,000 美元 PAPER current；6,000 美元冻结历史基线
  当前D版本: US_V5_ETF_UNIVERSE_V1@US_V5_ETF_3000USD@2026-10-08T13:30:00.000Z；as-of 2026-10-23
  原实验基线: US_V5_ETF_6000USD；历史评价 UNKNOWN
  原问题_诊断_研究槽引用: 无已登记真实 link；原研究槽顺序未改
完成情况:
  工程实现: PASS（human workspace canonical projection、/api/workspace、七页 UI、回归测试）
  实际运行: FALSE（未执行 native replay/account reconciliation/decision funnel）
  产品用户任务: CONTROLLED_UX_VERIFIED；V8.1 M0-M3 仍 FALSE；缺目标用户在获准目标环境再次完成完整任务的证据
  研究结论与压力结论: INSUFFICIENT_INPUTS；未评价策略参数、未运行压力、未锁结果
证据:
  输入_配置_工具_成本: 原 T01 三类 Desk 文件；native scan/benchmark/regulatory fees 三项仍缺
  原生回放_账户对账: 未运行；M1 BLOCKED
  决策差异及解释: 未运行；不显示伪零或无关 CN_A 结果
  样本用途_尝试记录: 旧 CN_A 仅作折叠工程/历史对象；不并入 US_V5 首案样本
  净结果_压力_结果锁: 未运行/未成熟/无真实 Result Lock
  适用UX及AC逐项结果: UX1-UX3 PASS；UX4 桌面与 360px 七页无整页横向溢出、键盘焦点 PASS，加载/正常态浏览器实测，错误态代码与静态检查 PASS 但未注入真实网络故障；UX5 全量与独立复核 PASS
  权限_降级_重复导入检查: POST /api/workspace=405；Research 下单/激活/写运行态均 false；未导入新研究数据
确定性验证:
  QRP全量: 67 total / 66 pass / 1 environment skip / 0 fail
  定向: research workspace + transport 10/10
  Schema: 23 ledger files / 373 records / 0 violations
  浏览器: 7 desktop routes + 7 mobile 360px routes；raw ID 默认不可见；details 默认 closed；console error 0
  其他: inline JavaScript 1/1；git diff --check 0；live GET /api/workspace=200；POST=405
生产影响:
  是否涉及生效或资金: 否；NONE
  原权限或决定引用: Research 继续只读；采用、发布、激活和交易沿用原 Desk/Owner/Runtime 流程
未完成与阻断: M1 仍缺 current-book native scan bundle、benchmark bars 和完整监管费用；错误态真实浏览器故障注入证据缺失；目标用户目标环境任务证据缺失
下一步与责任方: Smartflow/数据与费用权威补三项真实依赖；工程随后执行 M1；目标用户在获准交付环境按七页任务完成走查后再记录产品里程碑证据
```
