# Cycle × Research × Desk：V8.1 产品里程碑验收修订 3

状态：FROZEN  
冻结日期：2026-10-24  
适用 case：`US_V5_ETF_3000USD`  
原验收：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_V1.md`  
修订 1：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_1.md`  
修订 2：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_2.md`  
修订 2 SHA-256：`3806d9265fc0486bf8bee23c360b56caff006dc8dca93a80d39ca914d36b3096`

本修订记录 M1 独立复核发现的身份／输入隔离缺口，并把 Smartflow 已签署的 AMENDMENT_17
跨簿交接语义转成确定性验收。它不修改修订 2 的当前簿、窗口、成本或账户等式，不改变
M0–M3、负责人确认或发布状态，也不授予生产写权限。

## A3.1 缺陷与裁决

修订 2 只写明“当前簿扫描记录”，未明确区分下列三种身份：

1. 当前 3000 USD 账本身份；
2. 当前簿沿用的共享规则命名空间；
3. AMENDMENT_17 收尾期进入线路级限额计算的 6000 USD 前身仓位。

因此，仅验证扫描外层 `bookId` 和 `recordHash` 不足以证明前身没有被重标、缩放或计入当前簿账户。
独立复核将其列为 P1；原 `VERIFIED` 诊断必须撤回，直至本修订的机械断言全部通过。

裁决依据为 Smartflow 已签署的
`US_CRYPTO_PAPER_FULL_RUN_ACCEPTANCE_V1_AMENDMENT_17`（SHA-256
`866aabd4ab1e28e35ec26055b2d7a6c876064073cb318c12861427e0c4ae7d14`）：

- 当前簿从 `2026-10-08T13:30:00.000Z` 以 3000 USD、60 USD 风险单位、3 个槽启动；
- 前身 `US_V5_ETF_6000USD@2026-09-28T13:30:00.000Z` 从该时点不再开新仓，原仓按原规则收尾；
- 前身未平仓期间，两簿共享线路级 slots、class caps、risk buckets 和 leverage cap；
- `US_V5_ETF_6000USD.*` 规则记录保留原名称并继续治理当前簿；名称不是账本归属。

## A3.2 四层身份必须同时成立

### 当前扫描身份

每条纳入 M1 的扫描必须同时满足：

- `ledgerId = US_V5_ETF_3000USD`；
- `bookId = US_V5_ETF_3000USD@2026-10-08T13:30:00.000Z`；
- `bookStartAt = 2026-10-08T13:30:00.000Z`；
- `cfg.riskUnitUSD = 60`；
- PAPER track cap = 3。

任一字段缺失或不一致即 `INVALID`。

### 共享规则身份

扫描中的 `s17.versions` 只允许两类键：

- AMENDMENT_17 明确沿用的 `US_V5_ETF_6000USD.*` 规则键；
- 当前簿自身的 `US_V5_ETF_3000USD.book`、`feeModel`、`sectorRs`。

每个键的版本、生效时点和 value hash 必须落在冻结 evidence manifest 的白名单内；出现其他
6000 USD 身份字段、未知参数键或白名单外版本即 `INVALID`。页面必须把该字段标为“共享规则版本”，
不得称为当前账本 ID。

### 收尾期线路风险身份

扫描 `openPositions` 的 PAPER 行只允许属于当前簿或上述唯一前身：

- 当前簿行必须带当前 `bookId`、`ledgerId`、3000 USD book equity、60 USD risk unit，且开仓时间不早于 T；
- 前身行必须保留前身 `bookId`、`ledgerId`、6000 USD book equity、120 USD risk unit，且开仓时间早于 T；
- 前身只能是冻结 manifest 所列的既有 lot；不得出现 T 后的新前身 lot；
- PAPER track 的 `openCount` 和 `occupied` 必须精确等于两簿 PAPER 行的并集；shadow track 单独核对；
- 前身平仓事件之后的扫描不得继续携带前身 PAPER 仓位。

该前身仓位可以影响当前开仓时的共享 slots／class caps／risk buckets／leverage cap；这是真实交接输入，
不是当前簿的初始持仓、现金、成交或 PnL。页面必须同时披露“影响了什么”和“没有计入什么”。

### 当前账户与交易身份

- 原生产数据库 row 必须带当前 `bookId`、`ledgerId`、3000 USD book equity 和 60 USD risk unit；
- Desk 当前簿快照和交易事件必须只归属于 `US_V5_ETF_3000USD`；
- 当前簿窗口起点仍为现金／权益 3000、持仓 0；前身 PLTU 不得进入当前簿账户等式或净结果；
- MSFU `signalReference.strategyVersion = US_V5_ETF_6000USD.etfUniverse@v3` 只表示共享 universe
  版本；其 `positionRef.ledgerId`、lot 和账户路径必须仍归属于当前簿。

## A3.3 本案冻结的交接事实

在 sealed 输入包中：

- 41 条扫描全部是当前 3000 USD 外层身份；
- 5 条扫描包含一个既有前身 PAPER lot：`USV5_1791392582939_qoxauy`（PLTU）；
- 该 lot 开于 T 之前，并在 `2026-10-09T19:22:28.999Z` 纸面平仓；之后扫描不得再含该前身仓位；
- MSFU 开仓扫描发生在前身仍收尾时，PAPER 线路占用为 1/3；MSFU 使用当前簿 60 USD 风险单位和
  3000 USD sizing，成交后写入当前簿；
- 当前簿账户对账只覆盖 MSFU，PLTU 不进入当前簿现金、持仓或 PnL。

上述数量、lot、时点或身份任一漂移均失败关闭；不能通过前端说明、测试 fixture 或人工解释放行。

## A3.4 状态保持

修复本缺陷只恢复“受控环境中的 M1 诊断能力可检查”，不等于正式 M1 PASS。

- M0 准备盘点：证据可用，不等于 PASS；
- 负责人核对：`NOT_VERIFIED`；
- M0–M3：均保持 `NOT_VERIFIED`；
- 发布：`NOT_RELEASED`；
- Production effect：`NONE`。

