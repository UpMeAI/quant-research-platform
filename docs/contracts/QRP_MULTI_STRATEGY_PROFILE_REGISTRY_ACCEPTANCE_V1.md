# QRP 多策略档案注册表 · 验收 V1（只改结构，US_V5 输出不变）

状态：**FROZEN**（2026-10-26，协调会话）
Owner 原话：「接下来Quick Shot和C17 都要接入research，再接下来是A股选股和美股核心轮动，最后是加密货币资金费率套利策略接入research」；「QRP 改造 是否可以加速？」
Production effect：`NONE`。不改任何研究结果、判据、锁、证据、页面内容或生产权限。
基线：QRP `origin/main`（实现会话开工时记下 sha；本地已知 `4dce0b0`）。

## 背景

QRP 现在只认 `US_V5_ETF_3000USD`。导入器、M1 诊断生产者、研究工作台、对比题注册表、前向观察配置和页面路由里都写死了 US_V5 的值，例如：

- 比较对象 `SPY_BUY_HOLD` / `CASH`、底线 1,800 美元；
- 相位词、分段 id；
- 成本模型 `US_V5_M1_RESEARCH_COST_V1`；
- case `RRC-US-V5-3000-V8-1-M0`。

后面还要接入 5 条策略（Quick Shot V3、C17_V2、Ashare-V6 个股账本、US_CORE、Carry V2），它们的币种、比较对象和成本模型各不相同。本次只把「写死的值」搬进一个按策略取值的注册表。真实的新策略档案随各自冻结的 K2 和导入档案另行加入，不在本次范围。

## R1 注册表

1. 新增一个注册表文件（建议 `config/strategy_profiles.v1.json`，并配一个校验模块），每条策略一项，必填字段：
   - `strategy_ref`、`case_ref`、`market`、`currency`（`USD` / `USDT` / `CNY`）；
   - `comparators[]`、`floor`（数值 + 币种）；
   - 基线结果 schema 名、导入档案 id、对比导入档案 id 列表；
   - 相位词表、分段 id 表、成本模型 id；
   - M1 证据位置、前向观察来源键、页面显示名。
2. US_V5 一项**只填今天代码里已有的值**，不改任何一个值。
3. 字段缺失或类型不符时，校验失败并给出明确原因码，进程不得继续。

## R2 读注册表的地方

下列位置改为按 `strategy_ref` 从注册表取值，不再写死。每个位置都在 PR 里列出改前与改后。

- `services/baseline-evaluation/`（含 `apps/research-cli/import_baseline_evaluation.js`）
- `services/strategy-diagnostics/`：成本模型按 id 选择。`US_V5_M1_RESEARCH_COST_V1` 模块原样保留；以后新增的成本模型是独立模块，本次不写。
- `services/research-workspace/`、`services/runtime-research-loop/`
- `services/candidate-comparison/`（含 `registry.js`、`common.js` 和 `apps/research-cli/import_candidate_comparison.js`）：题目注册按策略分组。`questions/q1.js`–`q3.js` 是 US_V5 自己的实验，保留其中的 US_V5 引用。
- `config/hk_forward_observations.v1.json`：按策略分组，US_V5 的行内容不变。
- `apps/research-web/`：策略详情页由 `strategy` 参数选取注册表项，不加顶层入口。

## R3 失败即关闭

1. 未登记的 `strategy_ref`：导入拒绝，返回原因码，账本与证据目录不写入任何东西。
2. 页面打开未登记的策略时显示「该策略尚未接入研究」，不报错、不显示其他策略的数字。
3. 一条策略的数字不得出现在另一条策略的页面上，包括共享预算这类引用。

## R4 本次不加真实新策略

- 只在 `tests/fixtures/` 里加一个测试档案（例如 `FIXTURE_CRYPTO_USDT`：比较对象 `BTC_BUY_HOLD` + `CASH`，币种 `USDT`），用来证明注册表能驱动非 US_V5 的值。它不得进入生产注册表。
- 不写加密、A 股、US_CORE、Carry 的真实档案；不记任何 M4 产品阶段证据（这要等 V8.1 的 M4 范围修订）。

## D 确定性验收

1. **US_V5 输出逐字节不变**：
   - 改造前，在基线 sha 上抓取 research-web 用到的每个 API 的 JSON 响应和 US_V5 策略详情页全部分节的渲染文本，作为金样；改造后逐字节相同。
   - 把已封存的 Q0、Q1、Q2 结果（以及 Q3 注册项）在**临时账本副本**里重新导入，锁记录与 hash 和现有的相同。不碰真实的 `var/ledger`、`var/evidence`。
2. **写死值清零**：在 `services/` 和 `apps/` 里（不含注册表文件、测试和文档），`US_V5_ETF_3000USD`、`RRC-US-V5`、`SPY_BUY_HOLD` 的字面量为 0。确需保留的列在 PR 白名单里并写明原因（R2 已允许 `questions/q1–q3.js` 和 `US_V5_M1_RESEARCH_COST_V1` 模块）。
3. **测试**：
   - 测试档案的导入、诊断、渲染测试通过；
   - 未登记策略的拒绝测试通过（R3.1、R3.2）；
   - 注册表校验的负例测试通过（R1.3）。
4. **全量检查**：QRP 全量测试、research-web 语法检查、`git diff --check` 都是 0 失败。US_V5 页面在桌面和 390 px 宽度下与改造前一致，没有整页横向滚动。
5. **交付**：
   - 一个 PR 到 QRP main，本验收文件原样作为第一个提交；
   - 合并和重启 `com.upmeai.qrp-research-web` 由协调会话来做；
   - PR 正文给出 D1 金样对比的 sha256 列表。
