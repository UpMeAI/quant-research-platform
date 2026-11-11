# 海外研究封存结论 · 导入规格 V1 · 修订 6（C17 成本与选择、US_CORE 账户级风险，两个单元）

状态：随 QRP PR 交协调会话审阅，协调会话合并即采用。母规格与修订 1–5 原文不改；台账不改写，只追加新题。

## 1. 新增 2 题

| entry_id | 策略 | 结果 sha256（前 12 位） | 提交 | 期望结论 |
|---|---|---|---|---|
| C17-COSTSEL | C17_V2 | `39d2fd67e631` | `35f5f7d7` | 不做 |
| UC-ACCTRISK | US_CORE | `a16163c1eabe` | `cef860e5` | 不做 |

**C17-COSTSEL 绑定的文件**（全部按 sha256 钉住）：
- 结果 `docs/evidence/c17-cost-sel-v1/C17_COST_SELECTION_RESULT_V1.json`（smartflow `research/c17-cost-sel-run`）；
- K2 `C17_COST_SELECTION_K2_V1.draft.md`（`e15902b9…`）；
- 冻结 `C17_COST_SELECTION_K2_V1_FREEZE_1.md`（`085317e0…`，11-11 23:33:43 CST）；
- 运行日志 `RESEARCH_RUN_LOG_V1.json`（同一提交，`983aef77…`）。

**UC-ACCTRISK 绑定的文件**：
- 结果 `docs/evidence/uc-acct-risk-v1/US_CORE_ACCOUNT_RISK_RESULT_V1.json`（smartflow `research/us-core-acct-risk-run`）；
- K2 `US_CORE_ACCOUNT_RISK_K2_V1.draft.md`（`2104095f…`）；
- 冻结 `US_CORE_ACCOUNT_RISK_K2_V1_FREEZE_1.md`（`c10fb687…`，11-11 23:54:13 CST）；
- 运行日志 `RESEARCH_RUN_LOG_V1.json`（同一提交，`ed788544…`）。

**读法**：
- C17-COSTSEL：结论读 `decision`，证据强度读 `evidence_strength_short_zh`，允许用途读 `allowed_use_zh`，正文读 `first_paragraph_zh`。
- UC-ACCTRISK：结论读 `verdict.decision`，证据强度读 `verdict.evidence`，允许用途与正文同上。

**note_zh**（协调会话 11-12 指定的两条读法）：
- C17：被挡的那类入场在历史上是赢家，实盘那 21 笔的亏损在历史上不成立。
- US_CORE：用每年约 1.5 个百分点换回撤略浅，不划算；深回撤来自凯利上限之前。

两题都是「不做」，生产不变。

## 2. 两道门

- **G-TRIAL-PRE 照常过（PASS），不走偏差。** 两题都在冻结前预登记：
  - C17：5 行，11-11 23:33:07 CST；
  - US_CORE：5 行，23:53:47 CST。
  
  台账 id 全部写在各自 K2 §2，`k2_sha256` 等于 K2。
- **G-TRIAL-SEAL 照查**：
  - 每题 5 行都有结果（台账 trials 429 → 439）；
  - 运行日志各 5 条，没有未登记的计算；
  - 披露行存在：`OVD-3552418f115ebae4`（C17）、`OVD-8c06fad9355c4b51`（US_CORE）。
- **披露行的 DSR 是数值读法**：UNKNOWN，族里带 ŜR 的试验太少，算不出方差，工具按 Bonferroni 兜底。它不是 `NOT_APPLICABLE`，所以两题都不带门的裁定（`trial_gates_ruling` 不设）。
  - PBO 是工具的默认读法 `NOT_APPLICABLE`（没有矩阵、配置数 < 4），门只对 DSR 的「不适用」要求裁定。
  - 两题的原判定都没有被降级。

## 3. 真导入（合并之后）

1. **stage**：`import_overseas_verdicts.js stage --smartflow-root <smartflow> --artifacts-root <artifacts/coordinator> --out var/evidence/overseas-verdicts-2026-11-12-ccs-ucr`
2. **import**：先在台账副本上试（`QRP_DATA_DIR`），再导入真实台账。

预期：
- 追加 2 条锁 `OSV-C17-COSTSEL-39d2fd67e631`、`OSV-UC-ACCTRISK-a16163c1eabe`，原有 39 条是幂等重放，原有行逐字节不变；
- 两条锁都是 `pre: PASS`、`seal: PASS`；
- desk 回程打开时 sealedVerdicts 48 条，通过 desk schema。
