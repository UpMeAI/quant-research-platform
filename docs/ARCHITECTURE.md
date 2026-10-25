# 架构说明(对齐 2026-08-22 多市场平台产品设计)

> 完整的系统边界、权威数据流、当前实现状态、生产目标、安全、部署与演进方案见
> [SYSTEM_ARCHITECTURE_DESIGN_2026-10-23.md](./SYSTEM_ARCHITECTURE_DESIGN_2026-10-23.md)。

## 逻辑分层(设计 §7)与落点

| 层 | 设计定义 | 本仓实现 |
|---|---|---|
| L0 治理与身份 | 全局 ID/哈希/状态机/审计 | `packages/domain-model` · `packages/ledger` |
| L1 策略资产 | Family / ModuleVersion / BundleManifest | `services/strategy-registry` |
| L2 研究工作流 | Hypothesis / ExperimentSpec(冻结) | `services/experiment-orchestrator` |
| L2 因子 | FactorDefinition / IC / RankIC / 衰减(§9.1) | `services/factor-lab` + adapter 可选 `evaluate_factor` |
| L3 数据与回测 | DatasetSnapshot / Backtest / WFO / 鲁棒性 | 同上(`wfo.js` · `robustness.js`)+ `adapters/*` `run_backtest` |
| L4 赛马 | Stage/Module/Bundle Race + RaceResult | `services/race-orchestrator`(paired samples · regime breakdown) |
| L5 影子 | Shadow Run / Virtual Ledger / 前向证据 | `services/shadow-control` |
| L6 控制面 | PromotionCandidate / Release / Activation / Rollback | `services/strategy-control-plane` |
| L7 市场适配 | MarketAdapter Contract(§14.1) | `packages/contracts` + `adapters/registry` + `adapters/ashare-local`(演示)+ `adapters/clients`(远程,§5.2) |
| L8 市场 Runtime(外部) | 各市场仓库(A 股 = Ashare-V5) | 本仓仅 `paper_runtime_stub`(演示 pull 协议)+ `services/runtime-status`(§13.1 只读回读) |
| 观测 | §19 运行观测与衰减监控 | `services/observability`(随 runtime-status 视图投影) |
| 产品面 | Desk 市场/策略优先的人类可读工作台 + 运行态/研究态/Desk 回链 | `apps/research-web` + `apps/research-api` + `services/research-workspace` + `services/runtime-research-loop` |

产品里程碑由 append-only `PRODUCT_MILESTONE_EVIDENCE_V1` 单独裁决。工程完成、HTTP 200、页面存在、
实验锁定都不会自动置真；M0→M3 逐级绑定直接上游证据，撤销或重新验收上游后，下游必须重新验收。
M4/M5 在 V8.1 本轮固定显示 `OUT_OF_SCOPE`。Research Web/API 仅消费该投影，不暴露记录入口。
`services/research-workspace` 只翻译和编排上述 canonical 事实：七个页面共用同一真实 Desk case，
未关联的工程/历史对象默认折叠；它不重算策略、研究结论、采用或生产状态。M1 就绪显示仅在
canonical case 为 `M1_READY`、数据质量为 `VALID` 且必要输入均显式就绪时开放，其余状态 fail closed。
里程碑引用必须先进入 `PRODUCT_EVIDENCE_ATTESTATION_V1`：登记时与晋级时均读取实际绝对路径文件并
校验 SHA-256/大小，绑定 case 和证据类型；`QRP_PRODUCT_MILESTONE_AUTHORITY` 未配置或记录人不匹配时
拒绝登记与晋级。普通 Research 服务默认不配置该完成权威。

## 关键流程

### 研究主链与保留的内部控制面(§9-§12)

```
Hypothesis(机制/预期/失败条件/primary_metric/guardrails)
  → DatasetSnapshot(adapter.snapshot,checksum+lineage)
  → ExperimentSpec 预注册冻结(FREEZE_FIELDS,freeze_hash;改动=作废开新实验)
  → run_backtest(adapter;决定论 result_hash;缺预注册 oos_start 拒绝)
  → Race(paired samples 双边对齐;预注册裁决器:primary + guardrails 机械推导 verdict)
  → Result Lock(每实验一次;Winner/Holds/Negative/Inconclusive 都入台账)
  → Shadow(同 PIT 双跑;Virtual Ledger;min_forward_evidence 按实验预注册;不足=DESCRIBE_ONLY)
  → RuntimeResearchLink(锁 experiment freeze_hash + result_hash，回 Desk 原 REVIEW_LOOP_WEEK_V1)

以下 Promotion/Release/Activation 是既有内部服务与 Runtime 兼容链，**不从 Research Web/API 暴露**：

```
  → PromotionCandidate(gate:RESULT_LOCKED + CHALLENGER_WINS + CLAIM_ELIGIBLE)
  → Compatibility Check(adapter.validate_release,fail-closed)
  → Immutable StrategyRelease(release_hash 内容哈希)
  → Founder Review(APPROVE_PAPER / REJECT;唯一批准人)
  → ActivationRecord(PAPER only;effective_from 必须未来;runtime capability 校验)
  → Runtime Pull(runtimePendingActivations;effective_from > today 拉不到,
     只出现在 runtimeScheduledActivations)→ 验 release_hash → ACK/NACK
  → ACTIVE(Bundle 携 activationRef 进 ACTIVE)/ ACK_REJECTED / RUNTIME_REJECTED
  → Migration 评估(§12.2 No Silent Migration):在途持仓绑定旧 Release
     → REPLAN_REQUIRED_V1(auto_migrated:false,交研究或 Founder 决策);
     持仓不可知时 status=UNAVAILABLE、replan_required_count=null —— 不当作「无需重规划」
```

### 研究协议深度(§9)

- `runWalkForward(experimentId)`:按预注册 `sample.wfo` 切 fold,train 段在
  `parameter_grid` 上选参、test 段与冠军对比;逐 fold 结果与 `challenger_win_fraction`、
  选参稳定性入 `wfo` 台账。fold 日期先与 artifact 的 `evaluable_range` 求交
  (量能基线预热期不算可评测区间),grid 单点异常记录错误而非静默计 0。
- `runRobustness(experimentId)`:参数扰动 / 子样本(奇偶 stride)/ 时间分段(前后半 + 位移)/
  执行压力(成本 ×2 ×3)/ 数据源五维;单源市场该维 `NOT_APPLICABLE`。
  只报 `challenger_better_fraction` 等机械事实,**不发明通过阈值**。
- Regime breakdown:`computeRegimeBreakdown` 依赖适配器可选能力 `regime_labels`;
  缺该能力 → `UNSUPPORTED`(不构造代理市场状态)。

### 回滚(§12.3)

回滚**不是只写一条台账** —— 必须真的经 §12.2 pull 协议回到 Runtime:

```
rollback(OPERATIONAL)
  → 当前 Activation 标 ROLLED_BACK,当前 bundle RETIRED
  → 为 previous_release_ref(真实 Release id,非 bundle ref)生成
    ROLLBACK_RESTORE Activation(即刻生效、PENDING_RUNTIME_PULL)
  → Runtime 拉取 → 验 release_hash → 健康检查 → ACK → 真正切回 last-known-good
  → 切回目标不是合法 Release      → fail-closed(ROLLBACK_TARGET_NOT_A_RELEASE)
  → 该 Runtime 此前无生效 Release → restore_status=NO_PREVIOUS_RELEASE_TO_RESTORE(不伪装成功)
```

- ECONOMIC:无 Founder 批准只登记 `ROLLBACK_REVIEW_TRIGGER`(研究复核);
  Founder 执行经济回滚**必须先有**该复核记录,否则 `ECONOMIC_ROLLBACK_REQUIRES_PRIOR_RESEARCH_REVIEW`。

### 跨仓传输面(§12.2 / §5.2 / §25)

- Runtime → 平台(pull):`/api/runtime/{pending-activations,scheduled-activations,release,ack,nack}`,
  独立 `QRP_RUNTIME_TOKEN`;平台永不 push、永不持有 broker 凭证;
- 平台 → 市场适配器:`adapters/clients/http_market_adapter_client` 实现同一 §14.1 合同,
  合同函数可同步可异步,平台一律 `await`。

### 观测(§19)

- `operationalHealth`:数据新鲜度 · 平台/Runtime 生效版本与 hash drift · 被拒激活 ·
  Shadow 事件滞后与样本缺口 · 未决迁移裁定;只报确定性事实与年龄,不发明阈值;
- `economicHealth`:Runtime 绩效真相拿不到即 `UNAVAILABLE`,**不以影子虚拟账本冒充**;
  `auto_rollback_policy = NEVER` —— ACTIVE→DEGRADED 只触发 Research Review。

## MarketAdapter 合同(§14.1)

六个必需函数:`snapshot / run_backtest / run_shadow / validate_release /
runtime_capabilities / normalize_result(→ 七轴 CanonicalRaceMetrics,§10.1)`。
注册即校验(`adapters/registry`,fail-closed);平台核心禁止绕过注册表直连市场实现。

可选能力(缺失即按 `UNSUPPORTED` 降级,不阻断注册,也不伪造):
`regime_labels`(§10.2 分市场状态切分)· `runtime_active_release` ·
`runtime_positions_readonly` · `runtime_performance_summary` · `runtime_health`
(§13.1 Runtime 只读回读 —— 建模为可选适配器能力,§14.1 六函数合同保持冻结)。

`adapters/ashare-local` 是内置演示/测试适配器(文件 PIT 仓库 + SAMPLE_SYNTHETIC 样本);
生产形态由 Ashare-V5 `research-adapter/` 实现同一合同(§20 M2),两侧语义一致。

## 数据与台账

- 全部台账 append-only JSONL(`var/ledger`,`QRP_DATA_DIR` 可覆盖 —— 测试隔离);
- 修正 = 追加新行;head = 同 ID 最后一行;冻结域校验对**首行**重算哈希;
- 内容哈希 sha256/16;ID 种子含进程内单调 uid,杜绝同毫秒碰撞;
- `schemas/` 是 §8 域对象的产品级 Contract,`node schemas/validate.js` 逐条校验台账,
  Contract 与实现漂移即非零退出(`marketdata/` 属适配器自有存储,不在 §8 合同内)。

## 反分叉守卫

平台内置 `adapters/ashare-local` 与 Ashare-V5 的 VPQ 判定是同一经济逻辑的两份实现
(前者供无 PG 环境的演示与确定性测试)。`tests/schemas_and_fork_guard.test.js` 在两仓并存时
逐条比对冻结常量(`FWD_DAYS`/`CHAMP`)、pattern 判定表与分位函数,任一侧漂移立即失败;
Ashare-V5 不可达时 skip(单仓 CI 也能跑),但**绝不静默通过** —— 源模块顶层 `require('pg')`
由最小桩解析,桩失效同样只 skip 不放行。

## MVP 范围声明(§16/§25)

- 仅 CN_A 市场、仅 PAPER 环境;PORTFOLIO_RACE、CANARY/LIVE 治理、平台↔Runtime
  传输层协议(REST/CLI job)为后续决策(§25 待冻结),接口已按 pull 语义预留。
