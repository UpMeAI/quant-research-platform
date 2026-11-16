# 海外研究封存结论 · 导入规格 V1 · 修订 9（US_CORE 职责对照 VOO，一个单元；desk 回链绑定封存结论锁）

状态：随 QRP PR 交协调会话审阅，协调会话合并即采用。母规格与修订 1–8 原文不改；台账不改写，只追加。本修订不改门的代码。

## 1. 新增 1 题

| entry_id | 策略 | 结果 sha256（前 12 位） | 提交 | 期望结论 |
|---|---|---|---|---|
| UC-ROLE-VOO | US_CORE | `3ec623e26cef` | `662fdcb0` | 做（影子） |

**来历**：
- desk 候选 `RLC-US-2026W42-1` 经附录 7 分诊「立题」，分诊行 `RTR-7dd95bd070d0dd7e`，题号 `DQ-RQK-d8fdad6a84b9c984`。
- 回链 `RRL-f2472d2819432bf3` 自 10-27 起一直是 PENDING。

**绑定的文件**（全部按 sha256 钉住）：
- **结果**：`docs/evidence/us-core-role-vs-voo-v1/US_CORE_ROLE_VS_VOO_RESULT_V1.json`，`3ec623e2…`。在 smartflow 的 `research/us-core-role-vs-voo-k2` 分支上，封存提交 `662fdcb0`。
- **附带文件**：同目录的 `RUN_SEAL.json`，`7350da0e…`。它记了 A、B 两次运行逐字节相同（G_REPRO PASSED），代码在 `f7fefe59`。
- **K2**：`docs/US_CORE_ROLE_VS_VOO_RESEARCH_ACCEPTANCE_K2_DRAFT_V1.md`，`635af851…`。绑冻结页写的提交 `e0b5c2d0`；它在封存提交上的字节相同。
- **冻结页**：`US_CORE_ROLE_VS_VOO_K2_FREEZE_1.md`，`c95abd46…`。§11 五项全取 ★ (a)。

**读法**：
- 结论读 `part_b.verdict.conclusionZh`，即「做（影子）」。
- 允许用途读 `part_b.verdict.basisZh`：「D 的回撤大于职责基准，C1 的职责适配区间跨界：C1 前瞻影子；D 不变」。
- 结果文件没有中文证据强度字段，证据强度记空。desk 回程的 verdictState 取结论词「做（影子）」，结论记「做」。

**结论**：判定表 §7 第 4 条，做（影子）。
- C1（同规则 1x）的职责适配 R-FIT 区间跨界。界是 BPR 上界 ≤ 1.00、Δg 下界 ≥ −0.02/年。
- 所以 C1 只开前瞻影子，D（3x，现承担者）不变，生产不变。
- OOS 为 2018-01-02 → 2026-09-30：
  - VOO：g 0.1348，最大回撤 33.72%；
  - D：Δg +0.0850 [−0.1275, +0.2905]，最大回撤 46.08%；
  - C1：Δg −0.0128 [−0.0814, +0.0537]，最大回撤 21.34%。
- 规则版本 `a8601cd3`，趋势档按收盘低于均线触发。Owner 10-28 定了盘中到价出场，那项改造落地后如果要重判，另写附录（冻结页第 2 条）。
- 披露：C1 的 SPY、QQQ 腿不含分红，VOO 用的是总收益。
- 机制登记表 U10（`SEL.CORE_ROLE.TIMING_VS_HOLD`）记的就是这份结果，seal_sha256 相同。

## 2. 门

三道门都不适用，按封存日判断。本题 2026-10-28 封存，早于过拟合控制修订（2026-11-11）和 RF1112（2026-11-15）：
- G-TRIAL、G-MECH、G-CAUSAL 都返回 `SEALED_BEFORE_AMENDMENT`；
- 不写 `k2_frozen_at`，不绑运行日志，也不绑门的裁定；
- `G-CAUSAL N/A: PRE_EFFECTIVE_K2`，锁行不加门的字段。

**只披露**：冻结页自己写「FROZEN（2026-10-28 02:4x CST）」，但实际时间更早：

| 事件 | 时间（CST） |
|---|---|
| K2 草稿提交 | 02:19:50 |
| 冻结页文件写入 | 02:22:51 |
| 红测试 | 02:26 |
| 封存提交 | 02:30:54 |

冻结页写的「02:4x」晚于封存。按提交与文件时间，冻结在运行之前。门不读这个时间。

## 3. desk 回链绑定封存结论锁（新函数）

到修订 8 为止，desk 回链只能绑基线锁或对比锁（`linkLockedEvaluation`）。封存结论锁没有写入口，所以 desk 题指向封存结论时，回程 `sealedVerdicts` 那一行的 `deskLink` 一直为 null。本修订补上 `runtime-research-loop.linkSealedVerdict` 和 CLI `apps/research-cli/link_sealed_verdict.js`（带 `--dry-run 1`）。

**适用范围**：只给 desk 研究队列来的题（`research_question_ref` 为 `DQ-…`）用。

**现场复验**：
- 锁存在，是本题当前的那把（没有被取代），kind 为 RESULT，登记表里有这题；
- 锁的 case 与策略同回链；
- 文件 sha256 等于期望值，并且这份文件只被一把当前锁用。回程按文件 sha256 对回链，多把锁共用一份文件时拒绝（`LOOP_SEALED_FILE_SHARED`）；
- 封存文件与绑定文件按 sha256 复验，结论词仍是登记的期望值。

**写入**：追加一行新的回链。
- `result_ref` = `QRP:<result_id>:LOCKED`，`result_hash` = 锁的 file_sha256；
- `adoption_state` 仍是 `NOT_DECIDED`；
- 回链已指向别的结果时拒绝；同一绑定重放，不再写。

**结论词映射**（机械，表外的词拒绝 `LOOP_RESULT_VERDICT_UNSUPPORTED`）：

| 结论词 | 回链结论 |
|---|---|
| 做 | PASS |
| 做（影子）、做（证据不足）、INSUFFICIENT | INSUFFICIENT |
| 以「不做」开头 | FAIL |

**不写采用记录**：
- desk 复盘闭环修订 8 §1–§2 写明，封存研究结论不是 Owner 的决定，不写采用记录，不进「等你决定」。
- `research-adoption` 也只认基线锁与对比锁。
- 本题的「做（影子）」就是研究结论；前向影子已在运行，登记表 U10 记 `shadow_running: true`（as_of 2026-11-16）。
- 如果 Owner 另有采用决定，按 H1 另记，本修订不代写。

## 4. 真导入与真回链（合并之后）

1. **备份**：先备份 `var/ledger`。
2. **stage**：

   ```
   import_overseas_verdicts.js stage --smartflow-root <smartflow> --artifacts-root <artifacts/coordinator> --out var/evidence/overseas-verdicts-<date>-ucvoo
   ```

3. **import**：先在台账副本上试（`QRP_DATA_DIR`），再导入真实台账。
4. **回链**：

   ```
   link_sealed_verdict.js --link-id RRL-f2472d2819432bf3 --result-id OSV-UC-ROLE-VOO-3ec623e26cef --expected-file-sha256 3ec623e26cef92a040cea6f24d0b28a750ad4bdaeebe00e636bc4492267a0270
   ```

   先跑 `--dry-run 1`。

**预期**（11-16 已在台账副本上试过）：
- **stage**：45 题，95 个文件。
- **import**：追加锁 `OSV-UC-ROLE-VOO-3ec623e26cef`，结论「做（影子）」，原有行逐字节不变。副本上还有修订 8 的两条锁，因为那次的真导入尚未做。
- **回链**：试跑不动账本；真写追加 1 行（2 → 3），结论 INSUFFICIENT；重放不再写。
- **desk 回程**：打开 sealedVerdicts 时为 57 行，desk schema 0 个错误，没有禁用词。UC-ROLE-VOO 一行带 `deskLink` `{ RLC-US-2026W42-1, RQK-d8fdad6a84b9c984, RRL-f2472d2819432bf3 }`，`origin = REVIEW_CANDIDATE`，读作「做 / 做（影子）」。
- **desk 校验**：desk `e1ebae6` 的 `sealedVerdictsProblem` 对这一块返回 null，前提是当周候选里有 RLC-US-2026W42-1。当周没有这个候选时报 `DESK_CANDIDATE_NOT_IN_WEEK`。
