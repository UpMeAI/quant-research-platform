# Cycle × Research × Desk V8.1：T01 / M0 首案与来源映射（2026-10-24）

规格：`/Users/kaylame/Downloads/Cycle_Research_Desk_金融策略投资系统设计与实施规格_V8_1.md`  
规格 SHA-256：`ecfdda23b52075b8e69980576595fd89a1929f182af05e24fd851c2b2bed627f`  
增量验收：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_V1.md`  
核对时间：2026-10-24 02:14 PDT；当日为星期六，最近已交付 NYSE session 为 2026-10-23。

## 裁决

| 项 | 状态 | 说明 |
|---|---|---|
| T01 首案盘点 | **COMPLETE** | 当前 D、旧基线、原生入口、实际只读输入、成本、开关和共享风险均已逐项定位 |
| 首案 | **US_V5 保持首案** | 选择依据是已有原生回放与 QRP Adapter，不是历史收益 |
| V8.1 产品 M0 | **NOT_VERIFIED** | 本回执完成准备盘点；尚无目标用户在实际入口完成 M0 整条任务的证据记录 |
| M1 就绪 | **FALSE** | current-book 本机运行配置／scan records 不齐；签署费用模型明确缺监管费，不能形成可封存的完整净成本 bundle |
| M2/M3 | **NOT_STARTED** | 原研究槽无 US_V5 已 PICKED 问题；无锁定评价、压力产物或 Desk 往返 |
| 生产影响 | **NONE** | 未读取交易凭证，未连接 broker，未下单／撤单，未写生产参数、Desk、部署或调度 |

## T01：当前 D 与旧冻结基线

| 维度 | 当前 D | 旧实验／前任冻结基线 |
|---|---|---|
| 账本 | `US_V5_ETF_3000USD` | `US_V5_ETF_6000USD` |
| book identity | `US_V5_ETF_3000USD@2026-10-08T13:30:00.000Z` | `US_V5_ETF_6000USD@2026-09-28T13:30:00.000Z` |
| 模式 | PAPER，`realOrder=0` | PAPER；2026-10-08 起不再开新仓，原仓按原退出规则收尾 |
| 资本／单笔风险／仓位上限 | 3,000 USD / 60 USD / 3 | 6,000 USD / 120 USD / 3 |
| 策略身份 | `US_V5_ETF_UNIVERSE_V1`，ETF universe，V5 信号在未杠杆 parent series 上计算 | 同一策略族的前任 book 版本；不得用来回填当前 D |
| 最后实际账本证据 | Desk inbox `POSITION_LEDGER_SNAPSHOT_2026-10-23.json`；文件 SHA-256 `264da527…e20e`；内部 hash `7c64e2fa…e6a63`；MEASURED equity/cash `3005.019987`，0 lots | `POSITION_LEDGER_SNAPSHOT_2026-10-09.json`；文件 SHA-256 `ab55b634…f8f4`；内部 hash `2b211162…a473`；`BOOK_CLOSED_FINAL:2026-10-09`，successor 为当前 D |
| 最后周复盘证据 | `STRATEGY_REVIEW_2026-10-23.json`；文件 SHA-256 `7f3a5065…e6db7`；内部 hash `ce872deb…1d46` | `STRATEGY_REVIEW_2026-10-02.json`；文件 SHA-256 `82211301…3a46`；内部 hash `6a1fcd5c…a9dc` |
| 运行／研究关系 | 作为 champion 的真实 PAPER 账本；QRP 只能读冻结产物 | 只作为明确 predecessor/baseline；其关闭与当前 D 的有效性分别记录 |

当前 D 的 2026-10-23 Desk 周复盘给出 `netReturn.state=CONFIRMED`、start equity 3000、end equity
3003.79、modelled fee 1.23 USD。该值是 Desk 已签合同下的运行复盘事实；QRP 的研究准入更严格，
因为签署模型仍写明监管费未建模，所以不得把这份运行复盘直接提升为
`COMPLETE_SIGNED_MODEL_COSTS` 或 M1 完整净成本研究证据。

## 账本、开关、输入与原生回放

### 实际只读输入

- Portfolio Desk 当前 inbox 有 `US_V5_ETF_3000USD` 账本快照 2026-10-08 至 2026-10-23、
  同期 trade ledger，以及 2026-10-09／16／23 周复盘。
- Smartflow 本地 `reports/`／`artifacts/` 没有首案所需的 current-book scan-record bundle；
  Desk 输入也不包含 `US_V5_SCAN_RECORD_V2`、benchmark bars 和原生回放完整过程对象。
- Cycle/FinMap 尚无证据表明被当前 US_V5 作为运行输入消费；首案保持 `RESEARCH_ONLY`，
  不进入资本约束或收益归因。

### 当前本机会话的开关事实

以下全部为 `MISSING`：`US_V5_BOOK_EXPORT`、`US_V5_BOOK_EQUITY`、`US_V5_BOOK_START_AT`、
`US_V5_QRP_SCAN_PHASE`、`US_V5_QRP_COST_MODEL`、`US_DESK_V5_MODELLED_FEE`、
`DESK_NET_RETURN`、`US_V5_EXECUTION_MODE`、`US_V5_DRY_RUN`、
`US_V5_MANAGE_EXISTING_ONLY`、`US_V5_LEVERAGED_ETF`、`US_V5_DECISION_INPUTS`。
broker 凭证只核对为未提供，没有读取值。仓库示例中的目标配置不能替代真实运行环境回读。

### 原生入口与扫描相位

原生路径为：

`scripts/export-us-v5-qrp-bundle.js`
→ `scripts/export-us-review-decomposition.js::runV5Book`
→ `scripts/lib/us-v5-plan-replay.js`
→ `scripts/lib/us-v5-replay.js::v5Parity`
→ Smartflow 生产策略模块。

QRP 没有重写策略。Exporter 强制要求 `US_V5_QRP_SCAN_PHASE`；当前本机会话未设置，
因此扫描相位为 **UNKNOWN / REQUIRED**，不能根据 README 示例推定为真实 `US_CLOSE_REVIEW`。

## 工具成本与净口径

签署的 `US_V5_ETF_3000USD.feeModel` v1：

- 每边成交名义金额 5 bps；
- commission 0；
- slippage 包含在记录的 fill price；
- funding 对股票账本不适用；
- SEC fee / FINRA TAF：`NOT_MODELLED`。

因此运行复盘可以保留 `MODELLED` 费用事实，但 QRP bundle 的研究成本状态必须为
`PARTIAL + missing_components=['REGULATORY_FEES']`。在 Owner 提供可冻结的监管费来源，或另行签署
版本化验收修订之前，bundle seal、backtest、Result Lock 和 Desk 研究回链全部 fail closed。

## 共享风险范围

1. **同一 US_V5 继承线：**当前 3000 book 与前任 6000 book 在前任未平之前共享 slots、class caps、
   risk buckets 和 leverage cap；前任实际快照在 2026-10-09 标记关闭。
2. **跨策略海外桶：**2026-10-08 起的 `OVERSEAS_BUCKET_V3` 成员是
   `US_V5_ETF_3000USD`、`US_CORE_9000USD_3X_GATEOBS`、`C17_V2_4000USDT`、
   `QUICK_SHOT_V3_1000USDT`；Rule 1b 40% drawdown line 是共同风险事实。
3. **加密子账户：**C17 与 Quick Shot 另有自己的共享 loss budget；它不应在 US_V5 回放中复制计算，
   只引用原生产者的冻结状态。

## K1–K4 映射与研究槽

| 锁 | 当前映射 | M0 判断 |
|---|---|---|
| K1 Evidence Snapshot | 当前／前任账本与周复盘已有带 hash 的实际文件；首案 scan records、benchmark、完整费用仍缺 | PARTIAL |
| K2 Research Spec | 无 US_V5 已获原队列许可的冻结问题；不得新建名字绕过原研究槽 | NOT_READY |
| K3 Result Lock | 无当前首案真实 bundle、实验、压力和锁定结果 | NOT_READY |
| K4 Decision / Outcome | Desk `REVIEW_LOOP_WEEK_V1` 现有 US candidate `RLC-US-2026W41-1` 实际属于 `US_CORE_9000USD_3X_GATEOBS`，Owner 决定为 `LATER`，不是 US_V5 研究许可 | PRESERVED / NO_US_V5_DECISION |

## 为什么本轮不切 C17

C17 有更丰富的历史研究资产，但当前仍有独立的净收益修复验收、同运行来源完整性和共享风险边界；
QRP 也尚无与 US Adapter 同等级的 C17 sealed native bundle。现有证据不能证明 C17 比 US_V5 更适合
无损完成 M1。静默切换会同时改变首案、冻结验收与原研究队列，所以本轮保留 US_V5，先完成不受阻的
产品真相投影和页面能力。

## 下一可执行动作

1. 在实际证据主机以只读方式导出 current-book scan records、benchmark bars、账本和费用来源；
   固定真实 scan phase，不从示例推断。
2. Owner 提供监管费的权威逐 fill 来源，或签署版本化成本验收修订；工程不得推断为 0。
3. 满足以上条件后生成真实 sealed bundle，完成原版回放、账户对账和决策漏斗，才可进行 M1 用户走查。
4. M2 必须等待原研究队列允许的明确 US_V5 问题；M3 必须使用实际 Desk candidate/result/outcome，
   不复用测试中的示例 ID。

## 研究侧实际 case 投影

已将上述只读事实经协调层登记为 `RRC-US-V5-3000-V8-1-M0`：

- 当前 D 来源为 2026-10-23 POSITION_LEDGER_SNAPSHOT 的文件 SHA-256；
- predecessor 以独立 `BASELINE-US-V5-6000-FINAL-2026-10-09` 冻结，未回填当前 D；
- 数据质量为 `DEGRADED`，而非健康或零：最近闭市账本可读，但 native scan bundle、benchmark bars
  与完整签署费用仍缺；
- 状态为 `M1_BLOCKED_NATIVE_BUNDLE_AND_COMPLETE_COSTS`，生产影响 `NONE`；
- M0–M3 产品阶段仍为 `NOT_VERIFIED`，没有因登记、HTTP 200 或页面显示而升级。
- M1 就绪缺口另以 `ANOM-US-V5-V8-1-M1-READINESS` 进入 anomaly watchlist；它是待观察的
  系统输入状态，不冒充事故、策略结论或生产停止。
- 独立复核发现并在发布前修复的产品证据伪引用门禁记录为
  `INC-V8-1-PRODUCT-EVIDENCE-PSEUDOREF-GATE`；实际里程碑未被错误置真。

受控本地入口 `http://127.0.0.1:4311/#runtime-research-loop` 已实际打开并核对以上投影。
这是实现者的受控产品检查，不是目标用户走查或目标环境发布证据。

## 附录 C 状态

```yaml
任务与阶段: T01 / M0
产品交付:
  本阶段产品承诺: 明确首案、当前D、旧基线、历史范围、来源与阻断
  实际用户入口: http://127.0.0.1:4311/#runtime-research-loop（本轮受控本地进程）
  环境与发布状态: CONTROLLED_LOCAL_READ_ONLY_NOT_TARGET_USER_VERIFIED
  本期新增可用功能: V8.1 产品里程碑后端真相与只读页面投影
  实际支持范围: US_V5 current/predecessor 身份和只读证据盘点
  完整用户操作与真实对象: 实现者打开运行/研究闭环页，读取 RRC-US-V5-3000-V8-1-M0；尚无目标用户完成记录
  用户所得结果与后续状态: 页面可区分当前D/旧基线/数据降级/阶段真相；M1 因原生输入与完整成本未就绪
  限制或异常场景与实际显示: 无阶段证据时 NOT_VERIFIED；M4/M5 OUT_OF_SCOPE
  对应12_2里程碑及判断: M0 NOT_VERIFIED；准备盘点完成但产品用户任务未验收
执行职责与复核职责: Codex 实施；financial_loop_verifier 独立只读 PASS
目标仓库_分支_原任务: quant-research-platform/main；smartflow/main；沿用原 Desk 研究槽
工程实现: COMPLETE
实际运行: FALSE
产品验收: FALSE
研究结论: INSUFFICIENT_INPUTS
生产影响: NONE
下一步与责任方: Owner/实际证据主机补监管费权威来源与 current-book 只读输入；之后继续 M1
```
