# quant-research-platform

多市场量化策略研究平台 —— **策略研究 → 回测 → 策略赛马 → 分市场发布**。

实现依据:《多市场量化策略研究与策略控制平台产品设计》(2026-08-22,权威规范);
Phase 2 研究治理语义(预注册/冻结/Result Lock/Shadow/晋升治理)自
UpMeAI/Ashare-V5 `services/phase2` 领域抽取(Domain Extraction),按新设计泛化 market 维度。

## 定位(设计 §5)

- **一个共享平台**(Research Plane + Strategy Control Plane)+ **每市场一个 Market Adapter**;
- 各市场 Runtime(执行/持仓/账本/券商对接)**留在各自市场仓库**(L8 外部层)——
  A 股生产 Runtime = UpMeAI/Ashare-V5;
- 平台产出的是**受治理的不可变 StrategyRelease 与受控 Activation**,不是复制代码。

## 治理铁律(设计 §18,代码级强制)

| 铁律 | 强制点 |
|---|---|
| real_order = 0,平台零券商凭证 | `runtime_capabilities` / config/platform.json |
| No Automatic Promotion,Founder 唯一批准人 | `reviewCandidate` 要求 `reviewer==='FOUNDER'` |
| 预注册 + 冻结,Result Lock(每实验一次结果) | `experiment-orchestrator` freeze/verifyFreeze/recordResult |
| Race 受控变量 + 预注册机械裁决 | `race-orchestrator` paired samples / adjudicate |
| Shadow 零 Runtime 影响 + Virtual Ledger + 前向最低样本(按实验预注册) | `shadow-control` |
| Release 不可变(内容哈希);hash 不匹配 fail-closed | `strategy-control-plane` + `runtime_binding` |
| Pull-based 激活:Runtime 拉取 → 验哈希 → ACK → ACTIVE | `runtime_binding` / `paper_runtime_stub` |
| effective_from 必须未来,**且生效日之前拉取不到、ACK 被拒** | `requestActivation` / `runtimePendingActivations` / `runtimeAck` |
| No Silent Migration:在途持仓绑旧 Release → `REPLAN_REQUIRED` | `strategy-control-plane/migration` |
| 回滚两类:OPERATIONAL 直接切回,ECONOMIC 只触发研究复核 | `rollback` |
| 台账全部 append-only(JSONL),负结果归档为资产 | `packages/ledger` / `archiveNegativeResult` |

## 快速开始(A 股 MVP,零依赖,Node ≥ 18)

```bash
npm test                 # 34 项治理/流水线测试(含跨仓反分叉守卫)
npm run mvp:ashare       # §16.3 十二步端到端闭环(样本数据,自动种子)
node schemas/validate.js # 台账 × §8 域对象 Schema 一致性(退出码 0 = 无漂移)
npm run web              # §17 六入口研究工作台(默认 http://localhost:4319)
```

Founder 审批与激活是**写操作**,`apps/research-api` 默认 fail-closed:
未设 `QRP_FOUNDER_TOKEN` 时 `review` / `activate` 一律 403,只读六页照常可看。

MVP 数据为 `SAMPLE_SYNTHETIC`(确定性合成,诚实标注)——演示平台治理与全链路,
**不构成任何经济有效性声明**。真实 A 股数据经 Ashare-V5 `research-adapter/`(同一 §14.1 合同)接入。

## 目录(设计 §5.2 拓扑)

```
packages/            ledger(append-only JSONL 内核)· domain-model(ID/状态机)
                     contracts(adapter/runtime/canonical metrics 合同)· result-lock
schemas/             §8 域对象 JSON Schema + validate.js(台账合同校验器)
services/            strategy-registry · experiment-orchestrator(+ wfo · robustness)
                     race-orchestrator(paired samples · regime breakdown)
                     shadow-control · strategy-control-plane(+ runtime_binding · migration)
                     runtime-status(§13.1 只读回读聚合)
adapters/            registry(合同校验注册表)· ashare-local(CN_A 内置演示适配器)
apps/research-web/   §17 六入口工作台(单页,零依赖)
apps/research-api/   只读投影 + Founder token 门控的 review/activate
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

## 与 Ashare-V5 的边界

- 本仓不含任何 A 股市场特有的执行/持仓/账本代码;
- Ashare-V5 侧新增隔离目录 `research-adapter/`(设计 §20 M2),以同一 MarketAdapter
  合同封装其 PIT 数据与 phase2 回测内核;其 CLAUDE.md 全部不变量(A 股单市场、
  Paper 账本保护、任务图状态不可自改)不受本平台影响。
