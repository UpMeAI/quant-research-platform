# 海外研究封存结论 · 导入规格 V1 · 修订 7（C17 非主流选择，一个单元）

状态：随 QRP PR 交协调会话审阅，协调会话合并即采用。母规格与修订 1–6 原文不改；台账不改写，只追加新题。本修订不加门的偏差码。

## 1. 新增 1 题

| entry_id | 策略 | 结果 sha256（前 12 位） | 提交 | 期望结论 |
|---|---|---|---|---|
| C17-NMSEL | C17_V2 | `e4d311f3d7af` | `4d734c4f` | 做 |

**绑定的文件**（全部按 sha256 钉住）：
- 结果 `docs/evidence/c17-nm-trigger-v1/run/C17_NM_SELECTION_RESULT_V1.json`（smartflow `research/c17-nm-trigger-k2`，NEVER MERGE）；
- K2 `C17_NM_SELECTION_K2_V1.draft.md`（`83e9c2f1…`）；
- 冻结 `C17_NM_SELECTION_K2_V1_FREEZE_1.md`（`7ee0dabf…`，11-12 05:58:36 CST，★1–★5 全 (a)）；
- 运行日志 `RESEARCH_RUN_LOG_V1.json`（同一提交，`0bc404df…`）。

**读法**：结论读 `decision`，证据强度读 `evidence_strength_short_zh`，允许用途读 `allowed_use_zh`，正文读 `first_paragraph_zh`（同修订 6 的 C17-COSTSEL）。

**结论**：「做」，证据强度「证据不足」。
- 判定表第 4 行：Δg +7.60 个百分点/年 [−2.93, +18.78]，H-DD 过，保真 UNKNOWN。
- 允许用途：只开前向影子，生产不变（`nonMajorMax` 仍是 3）。
- 协调会话 11-13 裁定 3：影子 T_start 2026-11-13T00:00:00Z；「本会挡」已平仓满 30 笔或到 2027-06-30，先到为准。

**运行里的两份裁定**只管运行口径，不管门，钉在结果文件的 `pins`（`ruling_1` / `ruling_2`）里，登记表不另绑：
- 裁定 1（`35990ead…`）：T-1 的原因码两边各验。
- 裁定 2（`e81abd27…`）：G-CAP 的「已持」按引擎顺序数。

## 2. 两道门

- **G-TRIAL-PRE 照常过（PASS），不带门的裁定。**
  - K2 §2 只写了实际要跑的 5 行，都是 PREREGISTERED，k2_sha256 等于 K2，登记于 2026-11-11T21:56:07.151Z，早于冻结。
  - 5 行：NMS_REPRO `TRL-2aba59795b69a0e5`、NMS_DESC `TRL-a4df2b7df96ddede`、NMS_T `TRL-d718af04efb82a13`、NMS_B_SLIP2 `TRL-f26e945982c5c34e`、NMS_T_SLIP2 `TRL-0e94467a7808ccf8`。
  - K2 里没有别的台账 id。
- **G-TRIAL-SEAL 照查**：
  - 5 行都有结果（台账 trials 669 → 674，11-13 写入）；
  - 运行日志 5 条，没有未登记的计算；
  - 披露行 `OVD-1d900fa26cd4d4d6`（`a0f84e9e…`）存在。
- **披露行的 DSR 是数值读法**，同修订 6：
  - DSR 为 UNKNOWN（族里带 ŜR 的试验不足 5 个）；按 ★5 (a) 用族 N 的 Bonferroni 兜底（N 65，α 0.00077，下界 −0.0077，不过）。
  - 原判已是「证据不足」，没有被降级。
  - PBO 是工具默认读法 `NOT_APPLICABLE`。
  - 所以不设 `disclosure_not_applicable`。

## 3. 真导入（合并之后）

1. **stage**：`import_overseas_verdicts.js stage --smartflow-root <smartflow> --artifacts-root <artifacts/coordinator> --out var/evidence/overseas-verdicts-2026-11-13-nmsel`
2. **import**：先在台账副本上试（`QRP_DATA_DIR`），再导入真实台账。

**预期**（11-13 已在台账副本上试过，结果一致）：
- 追加 1 条锁 `OSV-C17-NMSEL-e4d311f3d7af`，原有 41 条是幂等重放，原有 48 行逐字节不变；
- 锁上 `trial_gates.pre = PASS`、`seal = PASS`、`run_log_runs = 5`、`disclosure_id = OVD-1d900fa26cd4d4d6`；
- desk 回程打开 sealedVerdicts 时为 49 条，通过 desk schema（`qrp-research-return.v1.schema.json`，与 QRP 测试里的副本同一 sha）。新题读作「做 / 证据不足」。
