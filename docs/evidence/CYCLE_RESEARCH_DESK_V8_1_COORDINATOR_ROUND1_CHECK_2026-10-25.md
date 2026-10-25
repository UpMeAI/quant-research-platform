# Cycle × Research × Desk V8.1：协调会话首轮核对（2026-10-25）

证据类型：`TECHNICAL_CHECK`
核对人：V8.1 协调会话（Claude，非实施者）
对象：分支 `codex/v8-1-m0-m1-workspace` 4e7bab8（PR UpMeAI/quant-research-platform#2）
Production effect：`NONE`

## 版本保存

- Codex 留在 QRP `main`（8b011e2）工作区的 108 个文件原样提交为 4e7bab8；提交后每个 blob 的 sha256 与提交前工作区逐个一致。
- 冻结 UX 合同：V1 `9388ac373d2d4673ff3c4b147d90aa37fd093723ab4579bad96b5b1876617ccd`、修订 1 `74a362b3f8161a57d656399320f7b5973d4ebe3cdd10b1810702df5eb666eb4f`、修订 2 `2141ce26cf941c5301beddcb213f9314d276f076697bbda76a2182c6c0bcb0a7`，均一致。
- 产品里程碑验收：V1 `32682ab0…f717e`、修订 1 `76d504ce…8998`、修订 2 `3806d926…b3096`、修订 3 `629c43ba…b752deb80b`，与回执一致。
- M1 输入包 `var/evidence/us-v5-m1-2026-10-08_2026-10-23`（64 个文件，包 sha256 `8f8780075209802582dc387186a3cb5ade71d892187791f99b73a375e83280cd`）经 Owner 同意一并提交。

## 确定性复跑

- `npm test`：78 项，77 过、0 失败、1 跳过（本机没有 Ashare-V5 检出的跨仓检查，不算通过）。
- `node schemas/validate.js`：24 个台账、375 条记录、0 违约。
- 本机 `127.0.0.1:4311`（pid 3552）`GET /api/workspace?strategy_ref=US_V5_ETF_3000USD`：诊断 `VERIFIED`，产品阶段 `NOT_VERIFIED`，`completion_authority=NOT_CONFIGURED`。

## 独立核对

- 回放来源：manifest 记录的 4 个回放引擎文件 sha256（`us-v5-plan-replay.js`、`us-v5-replay.js`、`export-us-review-decomposition.js`、`us-v5-scan-record.js`）与 smartflow 提交 `2382c2d1` 中的 blob 完全一致；Mac 主检出里未提交的改动与之不同，没有参与回放。
- 账户路径：用包内 Desk 原始账本和成交文件复算。
  - 10-08：现金 3000。
  - 10-09：买入 29 股 @ 42.466897，现金 1768.459987；买入侧费用 `NOT_MEASURED`。
  - 10-14：卖出 29 股 @ 42.64，卖出侧费用 0.61828。
  - 10-23：现金 3005.019987。
  - 毛额 5.019987；研究成本 = 0.6157700065 + 0.61828 + SEC 0.03 + CAT 0.02 = 1.2840500065；净额 3.7359369935，与回执一致。

## 未覆盖

- 没有逐行审读 PR #2 的全部代码；合并前另行审读。
- `var/ledger/` 仍只在本机。
- 证据包的生成命令没有入库：目前只能校验，不能重新生成。
