# 海外研究封存结论 · 导入规格 V1 · 修订 8（KELLY-M-S8，两个单元）

状态：随 QRP PR 交协调会话审阅，协调会话合并即采用。母规格与修订 1–7 原文不改；台账不改写，只追加新题。本修订不加门的偏差码，也不改门的代码。

## 1. 新增 2 题

两题绑定同一份结果文件，分别读 US_V5 单本（O1S）与海外桶（O5S）两个对象，同修订 4 的 US5-KWFO 与 US5-KWFO-BUCKET。

| entry_id | 策略 | 对象 | 结果 sha256（前 12 位） | 提交 | 期望结论 |
|---|---|---|---|---|---|
| US5-KMS8 | US_V5 | O1S，L-R1 | `405508d8a58c` | `bd1e125f` | 不做 |
| US5-KMS8-BUCKET | US_V5 | O5S，L-R1b（US_V5 为自由项） | `405508d8a58c` | `bd1e125f` | 不做 |

**绑定的文件**（全部按 sha256 钉住）：
- **结果**：`docs/evidence/kelly-m-s8/KELLY_M_S8_RESULT_V1.json`，`405508d8…`。在 smartflow 的 `research/kelly-m-s8-run` 分支上，NEVER MERGE；封存提交 `bd1e125f`。
- **K2**：`KELLY_M_S8_REFIT_K2_V1.draft.md`，`aa9c1a52…`。
- **冻结页**：`KELLY_M_S8_REFIT_K2_V1_FREEZE_1.md`，`b10f2f3d…`。2026-11-15T17:32:24+08:00 冻结，★1–★4 全取 (a)。
- **附带文件**：`KELLY_M_S8_REFIT_K2_V1_FREEZE_1_NOTE_1.md`，`5aac49ca…`。这是 O5_PRE 补登记的裁定，取 (a)。
- **运行日志**：`RESEARCH_RUN_LOG_V1.json`，`44d0adb1…`。在 QRP 回执提交 `e4b3c60e` 上，共 57 条。
- **门的裁定**：`KELLY_M_WFO_K2_V1_TRIAL_GATES_RULING_20261111.md`，`99203316…`。只放行披露行，见 §2。

**k2_frozen_at**：2026-11-15T17:32:24+08:00，取冻结页第 4 行。

**读法**：
- 结论读 `objects.<O1S|O5S>.verdict`。
- 证据强度读 `objects.<O1S|O5S>.evidence`。
- 允许用途读 `verdict.allowedUse`：「US_V5 不加上限，m 仍是 1」。
- 结果文件对「通过」的对象不写证据强度（`null`）。所以 desk 回程的 verdictState 取登记的 `state_zh`：「通过（无 R、无 F1、无 F2）」，即冻结 K2 §5 判定表「通过」一行，写法同修订 4。

**结论**：两题都是「不做」，没有候选。
- ★4 (a)：US_V5 的结论取 O1S 与 O5S 中更严的一个，两者都是不做。
- **O1S**
  - R：全窗口 m_S8 = 2，在网格顶端。m = 1 时触线概率 0.00%；m = 2 时按样本 0.26%，零优势 1.41%。
  - F1：前推不触线，最大回撤 22.75%（第 5 折），离 L-R1 线 27.25 pp。
  - F2：7 折 m_f 都是 2。
  - 证据强度分开写：R 是样本内的机械读数，F1 是一条已实现路径，F2 是证据不足（参数不稳）。
- **O5S**
  - 签字上限下的判定值是 4.13%，不超过 5%，读作 NO_FURTHER_CAP。S8 之前是 0.77%，离 5% 容差只剩 0.87 pp。
  - F1：前推不触线，最大回撤 11.93%。
  - F2：7 折都是 1。
- **只报**：S8 下，叠加读法与 SEALED 账本在前推窗口里差得远，最大回撤 22.75% 对 10.68%。

**机制**：QRP #87 正在审阅，它的回填把本题登记为机制 `ACCT.KELLY.CAP_M`，条目是 `KELLY-M-S8#US_V5` 与 `KELLY-M-S8#BUCKET`，与本修订的两题一一对应。
- K2 冻结早于 RF1112 生效，G-MECH 不读这道题，登记表也不另写 `mechanism_ids`。
- #87 合并后，可以用 `sealed_ref` 写 `OVERSEAS_SEALED_VERDICTS:US5-KMS8` 与 `OVERSEAS_SEALED_VERDICTS:US5-KMS8-BUCKET` 交叉核对。

## 2. 门

**G-TRIAL-PRE：照常过（PASS），不放行偏差。**
- K2 写出 53 个台账 id，都是 PREREGISTERED，k2_sha256 等于 K2。最后一行登记于 2026-11-15T09:31:28.067Z（17:31:28 CST），早于冻结。
- 本题的族是 US_V5，有 22 行。
- O5_PRE 复现检查的 4 行（每本一行）按 NOTE_1 记 UNPLANNED_RUN，不是预登记行，所以不进 PRE。这 4 行在 09:43:48.644Z 登记，晚于冻结、早于首次计算（09:47:47Z）。
  - US_V5：`TRL-31e7dfb82bf647c3`
  - US_CORE：`TRL-dc90c331fd00d243`
  - C17_V2：`TRL-c8f347533dd545c2`
  - QS_V3：`TRL-55ef4bfc1b134c73`
- 偏差码 `PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN` 写在结果文件 `deviations` 里，引用凯利 m 前推的先例 `99203316…`。这里不放进门的裁定：门的这个码只对预登记行成立，台账里没有晚登记的预登记行，放进去就是 `RULING_FACT_NOT_HOLD`。写法同修订 5 的 QS-KDECAY（复现检查行按 UNPLANNED_RUN 记，PRE 照常过）。

**G-TRIAL-SEAL：照查。**
- 57 行都有结果行。
- 运行日志里 US_V5 有 23 条，没有未登记的计算。
- 披露行 `OVD-939cfe1cadad0e5e` 存在。

**披露行 DSR、PBO 不适用。**
- 四个族的披露行（`OVD-939cfe1c…`、`OVD-5b31b117…`、`OVD-1e8c63a3…`、`OVD-b864f097…`）都引用 `99203316…`，K2 §2 写「同 KELLY_M_WFO」。
- 所以门的裁定是 `{ spec: 99203316…, disclosure_not_applicable: ['dsr', 'pbo'] }`，不带 `pre`。

**RF1112 G-MECH 与 G-CAUSAL：不适用。**
- K2 冻结在 2026-11-15T17:32:24+08:00，早于生效时刻 2026-11-15T22:47:42+08:00，两道门都返回 `FROZEN_BEFORE_AMENDMENT`。
- 登记了 k2_frozen_at，所以 E13 / G14「封存在生效日、没写 k2_frozen_at 即拒绝」不触发。
- `G-CAUSAL N/A: PRE_EFFECTIVE_K2`。这是范围说明，不是 §3.2 的五类码。K2 是冻结文本，不补写；不绑因果证据，锁行不加 `mechanism_gate` 或 `causality_gate`。
- 若本题在生效后冻结，按 §3.2 它会落在 `RISK_K_OR_ACCOUNT_LAYER`（凯利上限是风控层的仓位乘数）。

## 3. 真导入（合并之后）

1. **stage**：

   ```
   import_overseas_verdicts.js stage --smartflow-root <smartflow> --artifacts-root <artifacts/coordinator> --out var/evidence/overseas-verdicts-<date>-kms8
   ```

2. **import**：先备份台账，在台账副本上试（`QRP_DATA_DIR`），再导入真实台账。

**预期**（11-16 已在台账副本上试过）：
- **stage**：44 题，91 个文件。
- **import**：追加 2 条锁，`OSV-US5-KMS8-405508d8a58c` 与 `OSV-US5-KMS8-BUCKET-405508d8a58c`。原有 42 题是幂等重放，原有 49 行逐字节不变（49 → 51）。
- **两条锁上的 trial_gates**：
  - pre = PASS，seal = PASS；
  - trial_ids 22 个，run_log_runs = 23；
  - disclosure_id = `OVD-939cfe1cadad0e5e`，disclosure_not_applicable = dsr / pbo，ruling_sha256 = `99203316…`。
- **另外三个族**：按同一套门核对（US_CORE 11 / 12，C17_V2 10 / 11，QS_V3 10 / 11），PRE 与 SEAL 都过，披露都是 DSR、PBO 不适用。这三个族在本题没有结论单元，不登记题。
- **desk 回程**：打开 sealedVerdicts 时为 55 条，desk schema 0 个错误，没有禁用词。两条新行都读作「不做 / 通过（无 R、无 F1、无 F2）」。
