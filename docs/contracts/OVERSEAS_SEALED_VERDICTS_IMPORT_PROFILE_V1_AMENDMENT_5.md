# 海外研究封存结论 · 导入规格 V1 · 修订 5（QS_V3 凯利读数衰减，一个单元）

状态：随 QRP PR 交协调会话审阅，协调会话合并即采用。母规格与修订 1–4 原文不改；台账不改写，只追加新题。

## 1. 新增 1 题

| entry_id | 策略 | 结果 sha256（前 12 位） | 提交 | 期望结论 |
|---|---|---|---|---|
| QS-KDECAY | QUICK_SHOT_V3 | `dd75b449dd52` | `34694ef2` | 做（证据不足） |

- **绑定文件**（全部按 sha256 钉住）：
  - 结果 `docs/evidence/qs-kelly-decay/QS_KELLY_DECAY_RESULT_V1.json`（smartflow `research/qs-kelly-decay-run`）；
  - K2 `QS_KELLY_DECAY_K2_V1.draft.md`（`e5b22ae4…`）；
  - 冻结 `QS_KELLY_DECAY_K2_V1_FREEZE_1.md`（`fe9448ef…`，11-11 13:45:16 CST）；
  - 运行日志 `RESEARCH_RUN_LOG_V1.json`（`f2359908`，`cf4b4573…`）。
  
  裁定 1（`d4e6d4b7…`，G-ROLL-1 的种子冲突）写在 `cites` 里。
- **读法**：结论读 `verdict.verdict`，证据强度读 `verdict.evidence`，允许用途读 `verdict.allowedUse`。
- **note_zh**：收紧候选 0.1175 和四条读法（只来自零优势读数；按样本读数在容差内；原因是波动和活跃度上升而不是优势变小；2024H1 影响大），以及协调会话 11-11 的处理（签字文本交 Owner，推荐 0.12）。
- 「做」≠ 生产采用。

## 2. 两道门

- **G-TRIAL-PRE 照常过（PASS），不走偏差。**
  - 25 行在冻结前预登记（13:44:22 CST），台账 id 全部写在 K2 §2，`k2_sha256` 等于 K2。
  - 裁定 1 的复现检查行 QSD_R1_F1SEED 是 `UNPLANNED_RUN`，不在 PRE 的预登记范围内，照常计入运行日志核对。
- **G-TRIAL-SEAL 照查**：
  - 25 行预登记加 1 行补登记都有结果；
  - 运行日志 26 条，没有未登记的计算；
  - 披露行存在。
- **披露行的 DSR、PBO 是 `NOT_APPLICABLE`。** 按修订 4 §2，题必须带门的裁定，而且披露行引用的就是这一页。
  - 写明「不适用」的是冻结采纳的 K2 §2，所以 `trial_gates_ruling.spec` 就是 K2 本身，只放行 `disclosure_not_applicable: ['dsr', 'pbo']`，不放行 PRE。
  - 锁的 `refs` 里 RULING 一行与 K2 是同一个文件。
- **披露行更正**（QRP 试验台账，11-11 06:58:35Z，`OVD-f761aed45919b449`）：
  - 原披露行把冻结页当作「不适用」的裁定页，冻结页原文没有写 NOT_APPLICABLE。
  - 按 `disclose-na` 的 supersede 规则追加一行更正，引用改为 K2（`e5b22ae4…`），冻结页放在 `freeze` 栏；数值不变；缺陷引用 `QSD-DISCLOSURE-CITE-1`。原行保留。

## 3. 真导入（合并之后）

1. **stage**：`import_overseas_verdicts.js stage --smartflow-root <smartflow> --artifacts-root <artifacts/coordinator> --out var/evidence/overseas-verdicts-2026-11-11-qsd`
2. **import**：先在台账副本上试（`QRP_DATA_DIR`），再导入真实台账。

预期（副本上已验证）：
- 追加 1 条锁 `OSV-QS-KDECAY-dd75b449dd52`，原有 38 条是幂等重放，原有行逐字节不变；
- 锁 `pre: PASS`、`seal: PASS`；
- desk 回程打开时 sealedVerdicts 46 条，通过 desk schema。
