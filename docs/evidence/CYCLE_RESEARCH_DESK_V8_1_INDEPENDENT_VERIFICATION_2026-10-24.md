# Cycle × Research × Desk V8.1：独立金融／产品真相复核（2026-10-24）

复核角色：`financial_loop_verifier`（独立只读；未实施代码、未操作生产）  
裁决：**PASS——当前 V8.1 增量无阻断项**

## 五项裁决

| 维度 | 裁决 |
|---|---|
| Engineering | `PASS / COMPLETE`（V8.1 增量；修订 1 与 incident 保留） |
| Runtime | `FALSE`；US_V5 M1 未就绪 |
| Product | `FALSE`；M0–M3 `NOT_VERIFIED`，M4/M5 `OUT_OF_SCOPE` |
| Research | `INSUFFICIENT_INPUTS`；无策略参数或经济结论 |
| Production | `NONE` |

## 独立核验事实

1. 实际 read model 的 M0–M3 均为 `NOT_VERIFIED`；普通 Research 进程
   `completion_authority=NOT_CONFIGURED`。`product-milestone`、`product-evidence`、`review`、
   `activate` 的普通 HTTP POST 均为 405。
2. `PRODUCT_EVIDENCE_ATTESTATION_V1` 要求实际绝对路径文件、case + kind、SHA-256 + size，登记与晋级
   两次复验。authority 缺失／冒名、未登记、跨 case、fixture 路径、source drift 均 fail closed。
   M0/M1/M2/M3、TARGET delivery 与 Desk outcome 分别要求对应 evidence kinds。
3. 原验收 SHA-256 为 `32682ab08a03c168b1cb3648bd72133682785f573076b22ae026b1fabc1f717e`，
   未改写；修订 1 SHA-256 为 `76d504ce05ebe3e2677b7e768460e543e15f154726561edc5cbf16a4b8918998`。
   M1 revoke → 新 M1 PASS 后，旧 M2/M3 仍为 `INVALIDATED_BY_UPSTREAM`。
4. `US_V5_ETF_3000USD` current 与 `US_V5_ETF_6000USD` predecessor 使用不同 source/hash；
   data quality 为 `DEGRADED`，Cycle 为 `RESEARCH_ONLY`，没有 link/adoption。监管费仍 `NOT_MODELLED`；
   exporter 实际探测仍为 `US_V5_BOOK_NOT_CONFIGURED:MISSING`。
5. M1 精确阻断：current native scan/config、benchmark 完整输入和 complete signed costs 未齐。
6. 未新增凭证、broker、订单／撤单、生产参数、Desk write、发布、审批或激活；Research 只读边界保持。

## 独立复现

- QRP：62 total、61 pass、0 fail、1 skip；skip 是本机缺 Ashare-V5 源仓的跨仓反分叉检查，不计通过。
- QRP 定向：9/9 pass。
- Schema：23 个台账文件、373 条记录、0 违约。
- Research Web inline JavaScript 和两仓 `git diff --check`：通过。
- Smartflow：以下精确命令得到 6 suites、65 tests、0 fail：

```bash
npx jest \
  tests/research-us-qrp-adapter.test.js \
  tests/us-v5-book-replay.test.js \
  tests/scripts/us-v5-plan-replay.test.js \
  tests/scripts/us-v5-holding-swap-replay.test.js \
  tests/us-v5-book-replay-swap.test.js \
  tests/scripts/us-review-decomposition.test.js \
  --runInBand
```

本 PASS 仅恢复 V8.1 增量工程完成裁决，不提升 Runtime、Product、Research 或 Production 状态。
