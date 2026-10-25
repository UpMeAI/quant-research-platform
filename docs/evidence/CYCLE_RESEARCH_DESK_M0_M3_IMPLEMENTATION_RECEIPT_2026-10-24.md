# Cycle × Research × Desk M0–M3 实施回执（2026-10-24）

验收合同：`docs/contracts/CYCLE_RESEARCH_DESK_RUNTIME_RESEARCH_LOOP_ACCEPTANCE_V1.md`  
上游 V8 SHA-256：`f5762e47d414ac7867339b31383efe6da59351494da6ca83b109d7083e1d7f20`

## 1. 状态裁决

| 层 | 状态 | 证据／原因 |
|---|---|---|
| Implementation | **COMPLETE** | QRP 双态 case、Desk 回链、四类自审计、只读入口、启动注册；Smartflow US Adapter、原生 bundle exporter、真实 HTTP 合同均有确定性测试 |
| Runtime verified | **FALSE** | 本机 Smartflow `.env` 不含当前簿身份、扫描相位或成本模型；没有真实 `US_V5_ETF_3000USD` bundle，运行命令明确失败 `US_V5_BOOK_NOT_CONFIGURED:MISSING` |
| Product journey verified | **FALSE** | 工程 fixture 已走通 Adapter → QRP snapshot/experiment/result lock → Desk ref link，但 fixture 不属于实际 Desk candidate，不能满足实际用户旅程 |
| Strategy conclusion | **INSUFFICIENT** | 没有真实 K1/K2/K3/K4 首案证据；未评价 US_V5 收益、风险或采用 |
| Longitudinal observation | **FALSE** | 未启动或继承任何前向观察计数；旧样本不改名为新 OOS |
| Production effect | **NONE** | 未下单、未撤单、未改参数、未发布、未激活、未改运行调度；Research POST 固定 405 |

## 2. M0 当前 D 与研究基线

| 对象 | 引用 | 结论 |
|---|---|---|
| 当前 D | Smartflow `US_V5_ETF_3000USD`；`config/production-parameter-versions.json` 的 successor record，2026-10-08 起 | 当前 PAPER 簿；实际主机持续运行状态未在本机验证 |
| 前任／旧基线 | `US_V5_ETF_6000USD` 及 `docs/evidence/us-v5-holding-swap*` | 保留为前任和历史研究；不得冒充当前 D |
| 原生回放 | `scripts/lib/us-v5-plan-replay.js` → `scripts/lib/us-v5-replay.js` → 生产策略模块 | Adapter 只接 sealed bundle，不复制决定逻辑 |
| 运行复盘 | Smartflow `REVIEW_DECOMPOSITION_V1` / `STRATEGY_REVIEW_V1` | 原生产者与 Desk 校验权不变 |
| RSI | Desk `REVIEW_LOOP_WEEK_V1` | 原 candidate/RESULT/DO/DONT 状态机继续为唯一采用链 |
| Cycle | 首案无已证明运行消费 | `RESEARCH_ONLY` / `NOT_APPLICABLE`；不进入资本约束 |

代码基线：QRP `8b011e20dff3f25135d9844a7b271f1776bce5dc`；Smartflow
`6a25b5b52f694215cf04359d3aac573d0c20512e`；Desk
`7b4804e765eb8cd998617f64734ff4f5639ce7ae`；Ashare-V6
`97082eeab2389a266d37524095334467acbd0d7a`。Desk 和 Smartflow 原有未跟踪文件未修改或清理。

## 3. 交付内容

QRP：

- `RUNTIME_RESEARCH_CASE_V1` 把当前运行引用、冻结基线、Cycle 证据、数据质量和隔离声明分开。
- `RUNTIME_RESEARCH_LINK_V1` 只接受冻结完好且 `RESULT_LOCKED` 的实验；锁定 freeze hash 和 result hash，结论映射为 PASS/FAIL/INSUFFICIENT，采用固定从 `NOT_DECIDED` 开始。
- Research API/Web 新增“运行/研究闭环”只读页；移除 Research 侧 Founder review/activate HTTP 写入口。
- API 开放前注册已配置远程 Adapter；已配置但失败时不启动。
- `strategy_baseline`、`divergence_log`、`incident_catalog`、`anomaly_watchlist` 已有 JSONL 实现；PostgreSQL 完整建表/append-only 触发器合同已冻结但未部署。

Smartflow：

- `research-adapter/us/` 只接受专用根目录内的相对 JSON bundle；校验自哈希、期望哈希、原生入口、运行身份、数据质量、账户曲线和 canonical 轴。
- `run_backtest` 输出由原生 bundle 决定的确定性 artifact；`validate_release` 永远拒绝，Runtime 能力固定无激活、无 broker、`real_order=0`。
- `export-us-v5-qrp-bundle.js` 复用 `runV5Book` 的同一次 native evidence；可从原 desk exporter 的 `US_V5_BOOK_EXPORT=equity:start` 解析相同簿身份，不猜资本和起点。
- 缺真实簿、冻结策略、扫描相位、成本模型、S/D/B 任一 arm 或完整路径时 fail closed。

## 4. 确定性验证

- QRP `npm test`：56 tests，55 pass，0 fail，1 skip。skip 是外部 Ashare-V5 反分叉比对未找到其预期 checkout，明确不算通过。
- QRP `node schemas/validate.js`：19 个 ledger 文件、369 条记录、0 违约。
- Research Web 内联脚本语法编译：通过。
- Smartflow 相关测试：5 suites、43 tests、0 fail；覆盖 native plan replay、book replay、swap replay、parity、bundle、路径隔离、token 和 QRP HTTP 客户端。
- 工程 E2E fixture：Smartflow HTTP Adapter → QRP DatasetSnapshot → frozen Experiment → BacktestArtifact → Result Lock → Desk ref link，最终 `INSUFFICIENT / NOT_DECIDED / production_effect=NONE`。
- 真实 exporter 探针：失败 `US_V5_BOOK_NOT_CONFIGURED:MISSING`；这是当前运行证据缺口，不是成功。

## 5. 自审计五阶段

1. 诊断：外部依赖为 Smartflow 原生 bundle、Desk `REVIEW_LOOP_WEEK_V1`、可选 Cycle 证据；当前簿与前任版本已拆分，优先级为真实 bundle → 实际 Desk 问题 → 前向观察。
2. Schema：四类元对象的 JSONL schema 与 PostgreSQL DDL 均已完成；数据库尚未迁移。
3. Hooks：case 创建自动冻结 `strategy_baseline`；差异、事故、异常有显式写入 API。定时巡检/cron 尚未部署，不宣称持续监控。
4. Seed：没有伪造生产 seed。只用 fixture 验证合同；实际 baseline 必须由真实 bundle/Desk 问题生成。
5. Acceptance：冻结合同增加双态、无自动采用、缺失状态、四层完成真相和 AC 对应门禁。

## 6. 产品与商业判断（七段）

1. 需求重构：产品不是“再做一个量化平台”，而是让一个投资者从运行事实、问题、研究证据到自己的采用决定可追溯。
2. 十星产品：最佳体验是一个 Desk 问题能看见当前 D、旧基线、支持/反对证据、不确定性、锁定结论和下一观察条件；成本主要在真实数据与运行证据，不在新增页面数量。
3. 商业模式：本轮是个人理性投资基础设施，没有付费、获客、留存或合规分发证据；不作 SaaS 收入预测。
4. MVP：M0–M3 只接一条 US_V5 实际闭环；Cycle 保持证据入口，QRP 保持研究权，Desk 保持决定权。
5. 转化设计：用户的关键转化不是点击发布，而是从 `PENDING/INSUFFICIENT` 做出可记录的 DO/DONT/继续观察；因此 Research 页删除发布按钮。
6. 对标与风险：相对通用回测平台，本系统优势是原生运行回放与采用审计；主要风险是运行数据不可得、历史时点污染、费用不完整和把 fixture/旧报告误当当前证据。
7. 90 天与投资判断：先在实际主机完成 1 个 US_V5 bundle 和 Desk RESULT，随后积累原判据要求的前向样本，再决定第二市场。现在适合继续做内部基础设施，不具备外部融资或商业化验证结论。

## 7. 下一精确动作

在持有实际 `us-desk-exports` 运行环境和证据目录的主机执行：

1. 明确设置 `US_V5_QRP_SCAN_PHASE` 与 `US_V5_QRP_COST_MODEL`（内容来自当前运行合同，不从结果反推）。
2. 运行 `npm run research:export:us-v5 -- --session <实际已闭市 NYSE session>`，取得真实 bundle/hash；失败保持原错误。
3. 以只读 token 启动 `npm run research:adapter:us`，在 QRP 配置 `QRP_ADAPTER_BASE_URL_US_EQUITY` / token 并启动。
4. 从一个实际 Desk candidate 建 K2 实验、锁 K3 结果，再把 hash 写回原 `REVIEW_LOOP_WEEK_V1` RESULT 行。
5. 运行实际产品走查后，才可分别改变 `RUNTIME_VERIFIED` 与 `PRODUCT_JOURNEY_VERIFIED`。

不得重复：用 fixture 证明策略有效、把 6000 前任当当前 3000、把缺失费用记零、从 Research 直接激活、或为了工程排期缩短前向样本。
