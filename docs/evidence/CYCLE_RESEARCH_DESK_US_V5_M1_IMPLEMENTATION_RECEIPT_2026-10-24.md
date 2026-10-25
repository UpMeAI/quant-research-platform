# Cycle × Research × Desk：US_V5 M1 原版策略诊断实施回执

日期：2026-10-24  
规格：`Cycle_Research_Desk_金融策略投资系统设计与实施规格_V8_1.md`  
验收：V8.1 产品里程碑验收 V1 + 修订 1 + 修订 2 + 修订 3  
环境：本地 loopback 受控验收环境；未发布到新的目标环境  
Production effect：`NONE`

## 用户现在可以做什么

- **实际页面**：`http://127.0.0.1:4311/#strategy-detail?strategy=US_V5_ETF_3000USD&section=health`。
  兼容入口 `/#runtime-research-loop` 仍进入同一策略详情的“体检与证据”，没有新增顶层页面或改变冻结导航。
- **新增能力**：在一个页面区分历史真实记录、原生历史回放与 SPY 报告基准；追踪一笔原生决策的
  扫描、纸面成交、只读退出观察和纸面平仓；查看实际拒绝；核对现金、持仓、毛额费用和 Research
  净结果；并区分当前簿、共享规则命名空间和冻结前身收尾仓位。
- **真实对象／窗口／版本**：`US_V5_ETF_3000USD@2026-10-08T13:30:00.000Z`，NYSE
  `2026-10-08` 至 `2026-10-23` 共 12 个 session，PAPER，原生产端提交
  `2382c2d14eb66c1cef5a7df35c7cdb543c507853`；历史决策输入合同为 `US_V5_SCAN_RECORD_V2`。
- **完成的用户任务**：选择美股 ETF 主策略 3000 美元当前簿，确认旧 6000 美元簿保持冻结前身身份，
  只在 AMENDMENT_17 收尾期参与共享线路限额，不进入当前簿账户；
  沿 MSFU 的 2026-10-09 趋势 BUY 信号追到 29 股纸面成交，再追到 2026-10-14 TIME_STOP 观察与
  纸面平仓；查看 METU 因 RSI 65.9 超出 35–65 而被 ETF 闸拒绝；核对三个账户节点和逐项费用。
- **取得结果**：41 条原生扫描记录全部通过自身 `recordHash` 和嵌套身份校验；其中 5 条如实保留一个
  前身 PLTU 收尾 lot，MSFU 决策时占用共享线路 1/3，但当前成交仍按 3000 USD 本金、60 USD 风险单位
  sizing，前身未进入当前账户等式。原生 plan replay 为 `READY`，41 ticks，
  parity `MATCHED`。Desk 纸面毛额损益 `+5.019987 USD`；Research 完整模型成本
  `1.2840500065 USD`；Research 净损益 `+3.7359369935 USD`，净权益
  `3003.7359369935 USD`；入场现金、出场现金、毛额损益和期末持仓残差均为 0。
- **仍缺什么**：M0 负责人实际确认和完成权威没有登记，故 M0/M1 仍为 `NOT_VERIFIED`；没有目标用户在
  获准交付环境的证据；没有真实账户臂 A；12 个 session 低于原生诊断所需的 20；监管费是
  stand-alone 策略簿研究模型，不是全账户正式账单或实际策略费用分摊。

## 工程交付

1. 新增冻结修订
   `docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_2.md`，冻结当前对象、
   窗口、来源角色、账户等式、费用口径、用户任务和安全边界；没有改写 V1／修订 1 或阶段历史。
   独立复核随后发现外层 current-book 校验不足，新增不可变修订 3，绑定 Smartflow 已签署
   AMENDMENT_17 的交接语义和嵌套身份失败关闭条件；修订 2 保留原样。
2. 新增 canonical 生产者 `services/strategy-diagnostics/index.js`：
   - 校验 64 文件完整包 seal 与三个分组 seal；
   - 解压并逐条验证 41 条原生扫描记录 hash、current-book 外层身份、S17 白名单、PAPER／shadow 占位，
     以及 current／predecessor 每个 lot 的嵌套身份；
   - 验证原生 replay、SPY manifest／series、Desk 决策／监控、交易和账户快照；
   - 单点生产决策漏斗、费用和账户净额投影；缺失、漂移、未知均 fail closed。
3. `services/research-workspace/index.js` 只在 case ID、策略 ID 与 sealed 诊断一致时接入该投影；原 case 的
   历史 `DEGRADED` 记录不被覆盖，页面将“初始 case 登记质量”与“本次诊断输入”分开。
4. `apps/research-web/index.html` 只扩展已有策略详情的体检章节：默认展示人类语言；ID、路径和 hash 仍在
   折叠技术详情。`数据与运行状态` 同步显示 48 个 Desk 文件、12 个扫描文件／41 条记录和回放角色。
5. `services/runtime-research-loop/index.js` 将修订 2、修订 3 纳入以后新写产品证据的修订引用；未写任何 PASS。
6. 自审计 divergence
   `DIV-US-V5-BOOK-EXPORT-LOCAL-VS-PRODUCTION-20261024` 已 append-only 记录到
   `var/ledger/self-audit/divergence_log.jsonl`；独立复核发现的嵌套身份校验逃逸以
   `INC-US-V5-M1-NESTED-IDENTITY-ESCAPE-20261024` append-only 记录为已解决 incident，保留原缺陷事实。

## 实际运行与来源核对

- `US_V5_BOOK_NOT_CONFIGURED:MISSING` 的精确原因是 **QRP 本地调用 shell 没有 current-book 导出环境变量**，
  不是生产账本或原生产物缺失。
- Smartflow 生产 PM2 只读核对：
  - `us-v5-worker`：`US_V5_BOOK_EQUITY=3000`、起点 `2026-10-08T13:30:00.000Z`、PAPER、
    `US_V5_DRY_RUN=false`、`US_V5_MANAGE_EXISTING_ONLY=false`；
  - `us-desk-exports`：`US_V5_BOOK_EXPORT=3000:2026-10-08T13:30:00.000Z`；
  - 当前参数记录 SHA-256：`8698f327a494648312cd8d9f31757961b6c4d1fd9f57a6d5f79ab8b7425a7349`。
- 原生产者实际交付 12 个扫描日、41 条 current-book 扫描、12 组账户／交易／决策文件，以及一个只读
  production DB current-book row；没有创建或启用生产账本。
- 原生 `runV5Book` 在生产主机隔离 `/tmp` 中运行，交易凭证从进程环境移除；只读数据库和历史文件，
  只写 `/tmp` 研究输出。原生 review document hash：
  `ed5e4e99444df40cb255ddb4618f61bf863509394225d30abcdba3bd73dd4cd7`。
- 历史扫描在窗口内真实跨过若干生产代码版本；每条扫描保留当时的模块内容 hash。页面没有把它们
  伪装成一个单一历史提交，回放引擎文件 hash 另行保存在证据 manifest 中。
- `US_V5_ETF_6000USD.*` 是 AMENDMENT_17 明确保留的共享规则命名空间，不是当前账本 ID。前身 PLTU
  lot 仍带 6000 USD `bookId`、ledger、120 USD 风险单位且开于 T 之前；它在 5 条扫描中占共享线路，
  2026-10-09T19:22:28.999Z 平仓后不再出现。
- 旧 `US_V5_ETF_6000USD` 没有重标或缩放；当前数据库 MSFU row 带 3000 USD `bookId`、ledger、
  60 USD 风险单位；当前回放和账户对账从 3000 USD、空仓起始状态运行。

## 成本与 benchmark

- 策略签署模型：实际买卖名义金额各 5 bps。买入侧 `0.6157700065`、卖出侧 `0.61828`；卖出侧与
  Desk 已记录金额一致，未重复扣费。
- 滑点 `0.49 USD` 已体现在纸面成交价中，只披露、不再次扣减。
- 2026-10-14 卖出按 SEC `$20.60 / million` 得 `0.03 USD`；CAT 买卖各 `0.01 USD`；Alpaca
  2026-10-12 修订费表在股票 TAF 项为 0，故本案 TAF 为显式的模型零，不是未知填零。
- Alpaca 的实际监管费按费种、按日、按账户聚合后向上取整。本案没有全账户正式账单，所以把仅此策略
  为当日账户交易作为冻结研究假设，页面明确显示不是实际 broker invoice。
- SPY 12 根未复权日线 known-at `2026-10-24T20:00:00Z`，只进入报告比较臂 B；不进入策略决策、成交
  或账户事实。B 期末 `2945.77`／损益 `-54.23`；Desk S 为 `3005.02`／`+5.02`；原生计划 D 为
  `3006.09`／`+6.09`。这些臂没有与 Research 净额覆盖层混写。

## 产品验收

- 实际浏览器：Chrome，本地 `127.0.0.1:4311`，桌面默认 viewport 和 `390×844` 窄屏。
- 连续任务实际可见：对象／窗口／PAPER → 三类证据 → 当前簿／共享规则／前身收尾隔离 → 原版规则 →
  MSFU 决策与成交链 → METU 拒绝 →
  现金／持仓表 → 费用逐项 → Research 净结果 → 限制／安全状态。
- 窄屏 `documentElement.scrollWidth=390`、`innerWidth=390`，无页面级横向溢出；宽表在自身容器内处理。
- 浏览器 console warning/error：0。
- 当前是实现者在受控本地环境完成的产品检查，不是目标用户发布证据；因此没有登记
  `PRODUCT_MILESTONE_EVIDENCE_V1` PASS，也没有把环境写为 `TARGET_DELIVERED`。

## 研究结论

- 第一轮没有调整策略参数、研究槽顺序或当前生产规则。
- 原生结论为 `EVIDENCE_INSUFFICIENT`，不是产品能力缺失：只有 12 个 session（最低 20）且没有真实
  账户臂 A。因此本证据可以诊断当前原版路径，但不能据此形成 M2 的可引用策略优劣结论。
- M2 研究问题、压力和 Result Lock 未启动；M3 Desk 往返、采用与原 RSI 后续处理未改变。

## 生产影响与安全

- 未使用可交易凭证；未调用演示审批或自动激活；未下单／撤单；未写生产参数、生产交易账本或
  Desk 采用状态；未改变 Research 槽位。
- 原有效策略继续按自己的 PAPER 规则运行；Research API 仍 loopback-only、只读，`POST /api/workspace`
  返回 `405 RESEARCH_API_READ_ONLY`。
- 本地 Research 服务当前监听 `127.0.0.1:4311`；Runtime token 未配置，因此 Runtime pull/ack 写路径
  继续 fail closed。

## 确定性验证

- QRP `npm test`：78 项，77 pass、0 fail、1 skip。skip 为本机缺 Ashare-V5 checkout 的既有跨仓
  反分叉比对，明确不算通过，也不影响本 US 首案的直接证据。
- QRP `node schemas/validate.js`：记录 divergence 与已解决 incident 后为 24 个台账文件、375 条记录、
  0 违约。
- Research Web inline JavaScript：语法通过；QRP `git diff --check`：通过。
- Smartflow 指定原生回放／book／费用／scope／adapter 六套：72 pass、0 fail；Smartflow
  `git diff --check`：通过。
- Live API：`GET /api/workspace?strategy_ref=US_V5_ETF_3000USD` 返回
  `DIAGNOSTIC_AVAILABLE`／`VERIFIED`、修订 3 和完整 handover，M0/M1 均 `NOT_VERIFIED`；Research
  `POST` 返回 405。
- 独立金融／身份语义复核先发现“只校验扫描外层、未校验共享规则和前身嵌套身份”的 P1，修复后复验
  PASS：41/41 outer current、恰 5 条唯一 PLTU 前身收尾记录、平仓后 0 条、S17 白名单完全匹配；
  最小相关测试 21/21 pass，live 4311 复验 PASS，无剩余金融或身份语义 blocker。

## 仓库、分支与提交

- QRP：`/Users/kaylame/KaylaProject/quant-research-platform`，`main`，基线 HEAD
  `8b011e20dff3f25135d9844a7b271f1776bce5dc`。
- Smartflow：`/Users/kaylame/KaylaProject/smartflow`，`main`，本地 HEAD
  `6a25b5b52f694215cf04359d3aac573d0c20512e`；生产源 HEAD
  `2382c2d14eb66c1cef5a7df35c7cdb543c507853`。
- Portfolio Desk：`/Users/kaylame/KaylaProject/portfolio-desk`，`main`，HEAD
  `7b4804e765eb8cd998617f64734ff4f5639ce7ae`。
- 三仓原有未完成改动均保留。本轮没有创建提交：QRP 的既有未提交施工与本轮在部分同一文件相交，
  为避免把用户原改动混入一个不真实的“本轮提交”，这里只报告基线 HEAD、工作树和逐文件证据。

## 证据位置

- 冻结修订 2：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_2.md`
  （SHA-256 `3806d9265fc0486bf8bee23c360b56caff006dc8dca93a80d39ca914d36b3096`）；缺陷补充修订 3：
  `docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_3.md`
  （SHA-256 `629c43babef597b7fde669b8ac82244d03e6a6d84b85a7af178136f752deb80b`）。
- Sealed manifest：`docs/evidence/CYCLE_RESEARCH_DESK_US_V5_M1_NATIVE_DIAGNOSTIC_2026-10-24.json`
  （SHA-256 `8429553ddb2f4f9d9e441b23aa1852a310bbcada691ab08eb60fe513a81acf1d`）。
- 原始有限输入包：`var/evidence/us-v5-m1-2026-10-08_2026-10-23/`，64 文件，17,492,223 bytes，
  package SHA-256 `8f8780075209802582dc387186a3cb5ade71d892187791f99b73a375e83280cd`。
- Canonical 生产者：`services/strategy-diagnostics/index.js`。
- 确定性测试：`tests/strategy_diagnostics.test.js`、`tests/research_workspace.test.js`、
  `tests/runtime_research_loop.test.js`。
- 自审计：`var/ledger/self-audit/divergence_log.jsonl`。
- 本回执：`docs/evidence/CYCLE_RESEARCH_DESK_US_V5_M1_IMPLEMENTATION_RECEIPT_2026-10-24.md`。

## 当前裁决

- M0 准备盘点：已有 T01 与本轮来源更正证据。
- M0 负责人核对：`NOT_VERIFIED`。
- M1 诊断能力：已在本地受控环境实现并完成实现者产品检查。
- M1 产品里程碑：`NOT_VERIFIED`（M0 未通过；无原完成权威和目标用户／发布证据）。
- M2/M3：`NOT_VERIFIED`；M4/M5：`OUT_OF_SCOPE`。
- 发布：`NOT_RELEASED`；Production effect：`NONE`。
