# 架构说明(对齐 2026-08-22 多市场平台产品设计)

## 逻辑分层(设计 §7)与落点

| 层 | 设计定义 | 本仓实现 |
|---|---|---|
| L0 治理与身份 | 全局 ID/哈希/状态机/审计 | `packages/domain-model` · `packages/ledger` |
| L1 策略资产 | Family / ModuleVersion / BundleManifest | `services/strategy-registry` |
| L2 研究工作流 | Hypothesis / ExperimentSpec(冻结) | `services/experiment-orchestrator` |
| L3 数据与回测 | DatasetSnapshot / Backtest / WFO / 鲁棒性 | 同上(`wfo.js` · `robustness.js`)+ `adapters/*` `run_backtest` |
| L4 赛马 | Stage/Module/Bundle Race + RaceResult | `services/race-orchestrator`(paired samples · regime breakdown) |
| L5 影子 | Shadow Run / Virtual Ledger / 前向证据 | `services/shadow-control` |
| L6 控制面 | PromotionCandidate / Release / Activation / Rollback | `services/strategy-control-plane` |
| L7 市场适配 | MarketAdapter Contract(§14.1) | `packages/contracts` + `adapters/registry` + `adapters/ashare-local` |
| L8 市场 Runtime(外部) | 各市场仓库(A 股 = Ashare-V5) | 本仓仅 `paper_runtime_stub`(演示 pull 协议)+ `services/runtime-status`(§13.1 只读回读) |
| 产品面 | §17 六入口研究工作台 | `apps/research-web` + `apps/research-api` |

## 关键流程

### 研究 → 发布主链(§9-§12)

```
Hypothesis(机制/预期/失败条件/primary_metric/guardrails)
  → DatasetSnapshot(adapter.snapshot,checksum+lineage)
  → ExperimentSpec 预注册冻结(FREEZE_FIELDS,freeze_hash;改动=作废开新实验)
  → run_backtest(adapter;决定论 result_hash;缺预注册 oos_start 拒绝)
  → Race(paired samples 双边对齐;预注册裁决器:primary + guardrails 机械推导 verdict)
  → Result Lock(每实验一次;Winner/Holds/Negative/Inconclusive 都入台账)
  → Shadow(同 PIT 双跑;Virtual Ledger;min_forward_evidence 按实验预注册;不足=DESCRIBE_ONLY)
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

- OPERATIONAL:直接切回 `previous_release_ref`(前向生效,不改历史),当前 bundle RETIRED;
- ECONOMIC:无 Founder 批准只登记 `ROLLBACK_REVIEW_TRIGGER`(研究复核),不按短期 PnL 自动回滚。

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
