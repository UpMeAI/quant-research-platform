# 架构说明(对齐 2026-08-22 多市场平台产品设计)

## 逻辑分层(设计 §7)与落点

| 层 | 设计定义 | 本仓实现 |
|---|---|---|
| L0 治理与身份 | 全局 ID/哈希/状态机/审计 | `packages/domain-model` · `packages/ledger` |
| L1 策略资产 | Family / ModuleVersion / BundleManifest | `services/strategy-registry` |
| L2 研究工作流 | Hypothesis / ExperimentSpec(冻结) | `services/experiment-orchestrator` |
| L3 数据与回测 | DatasetSnapshot / Backtest(经 adapter) | 同上 + `adapters/*` `run_backtest` |
| L4 赛马 | Stage/Module/Bundle Race + RaceResult | `services/race-orchestrator` |
| L5 影子 | Shadow Run / Virtual Ledger / 前向证据 | `services/shadow-control` |
| L6 控制面 | PromotionCandidate / Release / Activation / Rollback | `services/strategy-control-plane` |
| L7 市场适配 | MarketAdapter Contract(§14.1) | `packages/contracts` + `adapters/registry` + `adapters/ashare-local` |
| L8 市场 Runtime(外部) | 各市场仓库(A 股 = Ashare-V5) | 本仓仅 `paper_runtime_stub`(演示 pull 协议) |

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
  → Runtime Pull(runtimePendingActivations)→ 验 release_hash → ACK/NACK
  → ACTIVE(Bundle 携 activationRef 进 ACTIVE)/ ACK_REJECTED / RUNTIME_REJECTED
```

### 回滚(§12.3)

- OPERATIONAL:直接切回 `previous_release_ref`(前向生效,不改历史),当前 bundle RETIRED;
- ECONOMIC:无 Founder 批准只登记 `ROLLBACK_REVIEW_TRIGGER`(研究复核),不按短期 PnL 自动回滚。

## MarketAdapter 合同(§14.1)

六个函数:`snapshot / run_backtest / run_shadow_observation / validate_release /
runtime_capabilities / normalize_result(→ 七轴 CanonicalRaceMetrics,§10.1)`。
注册即校验(`adapters/registry`,fail-closed);平台核心禁止绕过注册表直连市场实现。

`adapters/ashare-local` 是内置演示/测试适配器(文件 PIT 仓库 + SAMPLE_SYNTHETIC 样本);
生产形态由 Ashare-V5 `research-adapter/` 实现同一合同(§20 M2),两侧语义一致。

## 数据与台账

- 全部台账 append-only JSONL(`var/ledger`,`QRP_DATA_DIR` 可覆盖 —— 测试隔离);
- 修正 = 追加新行;head = 同 ID 最后一行;冻结域校验对**首行**重算哈希;
- 内容哈希 sha256/16;ID 种子含进程内单调 uid,杜绝同毫秒碰撞。

## MVP 范围声明(§16/§25)

- 仅 CN_A 市场、仅 PAPER 环境;PORTFOLIO_RACE、CANARY/LIVE 治理、平台↔Runtime
  传输层协议(REST/CLI job)为后续决策(§25 待冻结),接口已按 pull 语义预留。
