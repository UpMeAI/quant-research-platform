# quant-research-platform

多市场量化策略研究平台 —— **运行复盘问题 → 冻结研究 → 回测/赛马 → 锁定报告 → Desk 原采用流程**。

实现依据:《多市场量化策略研究与策略控制平台产品设计》(2026-08-22,权威规范);
Phase 2 研究治理语义(预注册/冻结/Result Lock/Shadow/晋升治理)自
UpMeAI/Ashare-V5 `services/phase2` 领域抽取(Domain Extraction),按新设计泛化 market 维度。

## 定位(设计 §5)

- **一个共享研究平台**（Research Plane；既有 Strategy Control Plane 服务保留但不从 Research API 暴露）+ **每市场一个 Market Adapter**;
- 各市场 Runtime(执行/持仓/账本/券商对接)**留在各自市场仓库**(L8 外部层)——
  A 股生产 Runtime = UpMeAI/Ashare-V5;
- Research 产品面产出的是**冻结研究报告与 Desk 回链**，不是复制代码，也不审批或激活；既有 Release/Activation 服务只保留原合同和 Runtime pull 兼容性。

## 治理铁律(设计 §18,代码级强制)

| 铁律 | 强制点 |
|---|---|
| real_order = 0,平台零券商凭证 | `runtime_capabilities` / config/platform.json |
| No Automatic Promotion，Research 无采用权 | Research API 的普通 POST 固定 405；既有 `reviewCandidate` 仍要求 `reviewer==='FOUNDER'`，但不由研究页调用 |
| 预注册 + 冻结,Result Lock(每实验一次结果) | `experiment-orchestrator` freeze/verifyFreeze/recordResult |
| Race 受控变量 + 预注册机械裁决 | `race-orchestrator` paired samples / adjudicate |
| Shadow 零 Runtime 影响 + Virtual Ledger + 前向最低样本(按实验预注册) | `shadow-control` |
| Release 不可变(内容哈希);hash 不匹配 fail-closed | `strategy-control-plane` + `runtime_binding` |
| Pull-based 激活:Runtime 拉取 → 验哈希 → **健康检查** → ACK → ACTIVE | `runtime_binding`(跨仓走 `/api/runtime/*`) |
| ACK 必过健康检查:缺失/不健康/`real_order≠0`/`broker=true` → `ACK_REJECTED` | `runtime_binding.evaluateHealthCheck` |
| 回滚真的切回:生成 ROLLBACK_RESTORE Activation,仍需 Runtime 拉取验哈希 | `rollback` → `runtime_binding` |
| 同一 Runtime 只允许一个 ACTIVE Activation(前任标 SUPERSEDED) | `runtime_binding` |
| 入账即校验:Promise / 未登记 schema / 字段违约拒绝落盘 | `packages/ledger.append` |
| effective_from 必须未来,**且生效日之前拉取不到、ACK 被拒** | `requestActivation` / `runtimePendingActivations` / `runtimeAck` |
| No Silent Migration:在途持仓绑旧 Release → `REPLAN_REQUIRED` | `strategy-control-plane/migration` |
| 回滚两类:OPERATIONAL 直接切回,ECONOMIC 先研究复核后才允许 Founder 执行 | `rollback` |
| 台账全部 append-only(JSONL),负结果归档为资产 | `packages/ledger` / `archiveNegativeResult` |
| V8.1 产品里程碑不由代码/HTTP 推断；只接受 case/类型绑定且现场验 SHA-256 的实际文件证据；撤销后下游不自动复活 | `runtime-research-loop` / `PRODUCT_EVIDENCE_ATTESTATION_V1` / `PRODUCT_MILESTONE_EVIDENCE_V1` |

## 快速开始(A 股 MVP,零依赖,Node ≥ 18)

```bash
npm test                 # 治理/流水线测试(含跨仓反分叉守卫与真实 HTTP 传输面)
npm run mvp:ashare       # §16.3 十二步端到端闭环(样本数据,自动种子)
node schemas/validate.js # 台账 × §8 域对象 Schema 一致性(退出码 0 = 无漂移)
npm run web              # 只读研究工作台(默认 127.0.0.1:4310；QRP_PORT 可覆盖)
```

Research 页面和 `/api/*` 研究视图只读，不接受 Founder token。Runtime pull 面使用独立令牌并 fail closed：

| 令牌 | 头 | 能做什么 |
|---|---|---|
| `QRP_RUNTIME_TOKEN` | `X-Runtime-Token` | `GET /api/runtime/pending-activations` · `…/scheduled-activations` · `…/release` · `POST /api/runtime/ack` · `…/nack` |
| `QRP_RESEARCH_TOKEN` | `X-Research-Token` | 非 loopback 部署时读取 Research Web 与普通 `/api/*` GET |

默认 `QRP_HOST=127.0.0.1`，本机只读视图可不设 token；若把 `QRP_HOST` 改成非 loopback，
缺 `QRP_RESEARCH_TOKEN` 会在启动前失败。Runtime 令牌只访问 `/api/runtime/*`，不能审批或创建 Activation，
也不替代 Research read token。

MVP 数据为 `SAMPLE_SYNTHETIC`(确定性合成,诚实标注)——演示平台治理与全链路,
**不构成任何经济有效性声明**。真实 A 股数据经 Ashare-V5 `research-adapter/`(同一 §14.1 合同)接入。

完整架构设计见 [`docs/SYSTEM_ARCHITECTURE_DESIGN_2026-10-23.md`](docs/SYSTEM_ARCHITECTURE_DESIGN_2026-10-23.md)。

## 目录(设计 §5.2 拓扑)

```
packages/            ledger(append-only JSONL 内核)· domain-model(ID/状态机)
                     contracts(adapter/runtime/canonical metrics 合同)· result-lock
schemas/             §8 域对象 JSON Schema + validate.js(台账合同校验器)
services/            strategy-registry · experiment-orchestrator(+ wfo · robustness)
                     race-orchestrator(paired samples · regime breakdown)
                     shadow-control · strategy-control-plane(+ runtime_binding · migration)
                     factor-lab(§9.1 FactorDefinition + IC/RankIC/衰减)
                     runtime-status(§13.1 只读回读 + 接口覆盖度)
                     observability(§19 运行观测与衰减监控)
                     runtime-research-loop(运行态/研究态/Desk 回链 + V8.1 产品里程碑真相)
                     research-workspace(Desk 市场/策略优先的人类可读 canonical 投影)
                     self-audit(四类元对象)
adapters/            registry(合同校验注册表)· ashare-local(CN_A 内置演示适配器,demo_only)
                     clients/http_market_adapter_client(§5.2 远程市场适配器客户端)
apps/research-web/   只读工作台(单页,零依赖)
apps/research-api/   只读研究投影 + 独立 Runtime pull/ack 传输面
apps/research-cli/   run_ashare_mvp.js · seed_sample_data.js
docs/                ARCHITECTURE.md
var/ledger/          运行时台账(gitignore;QRP_DATA_DIR 可覆盖)
```

## 研究协议深度(设计 §9)

- **WFO**:`runWalkForward` 按 `sample.wfo{train_days,test_days,step_days,folds}` 逐 fold
  在 train 段选参、在 test 段对比冠军,报告 `challenger_win_fraction` 与选参稳定性 ——
  只报机械事实,不发明通过阈值;
- **Robustness**:参数扰动 / 子样本 / 时间分段 / 执行压力(成本 ×2 ×3)/ 数据源五维,
  单数据源市场显式 `NOT_APPLICABLE`,不算「已覆盖」;
- **Regime breakdown**:适配器提供 `regime_labels` 才切分;没有则 `UNSUPPORTED` ——
  绝不用代理指标冒充市场状态。

未实现的指标(容量、IR、CVaR 等)在 CanonicalRaceMetrics 里以
`NOT_IMPLEMENTED_MVP` / `NOT_IMPLEMENTED_P4` / `UNSUPPORTED` 显式标注,不留空对象假装覆盖。

## 适配器可同步可异步

生产适配器要读 PG / 走 REST / 起 CLI job,必然返回 Promise;平台核心一律 `await`
适配器返回值(同步实现语义不变)。跨仓形态用 `adapters/clients/http_market_adapter_client`
把 §14.1 六函数翻译成远程调用,启动即校验合同,未声明的可选能力不挂载。

## 与 Ashare-V5 的边界

- 本仓不含任何 A 股市场特有的执行/持仓/账本代码;
- Ashare-V5 侧新增隔离目录 `research-adapter/`(设计 §20 M2),以同一 MarketAdapter
  合同封装其 PIT 数据与 phase2 回测内核;其 CLAUDE.md 全部不变量(A 股单市场、
  Paper 账本保护、任务图状态不可自改)不受本平台影响。
