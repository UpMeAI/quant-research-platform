# US_V5_M2_Q0_RESULT_V1 · QRP 导入规格 · 增补 1：差距分解描述记录（`GAP_DECOMPOSITION_V1`）与 Q0 压力补充记录（`BASELINE_STRESS_SUPPLEMENT_V1`）

状态：**提议，随 PR 合并；协调会话合并即冻结。** 研究会话起草，2026-11-03。冻结后只能另出勘误或补充，不改本文件。
Production effect：`NONE`。不改任何结果、判据、K2、已有的锁、生产参数或权限。

上游（全部按 sha256 引用，一字不改）：
- 差距分解 K2：`docs/contracts/US_V5_M2_R2_GAP_DECOMPOSITION_K2_V1.md`（sha256 `a161c5234f07d6cef182ccf21837be100a82be8f18b0184d6e393598814437cc`），「QRP 需要的」一节与 ★6 (a)；
  勘误 1：`docs/contracts/US_V5_M2_R2_GAP_DECOMPOSITION_K2_V1_ERRATUM_1.md`（sha256 `c17802e332a91d7ac539d1bb684427e0375f02c7bb0ae9a5aceed3728b019161`，运行前写定）。
- 2020 压力补充 K2：`docs/contracts/US_V5_M2_Q0_STRESS_SUPPLEMENT_2020_K2_V1.md`（sha256 `cc945872a4210a7ec524a727dc186e2e29051d9200e8a2cf949076ac5645c59a`），「结果文件」「QRP 需要的」两节与 ★3–★5。
- 以上三份是 smartflow `research/us-v5-m2-r2-k2-final` @ `056e5b9d`（`research/us-v5-m2-r2-run` @ `74cf5ca1` 上逐字节相同）的副本，随本 PR 进 QRP，测试核对 sha256。
- 协调会话冻结记录 `artifacts/coordinator/US_V5_M2_R2_K2_FREEZE_1.md`（sha256 `5501741d93de625685fda2013deb560c71227c5100c7d8da50647ea351bc46ba`）：差距分解 ★1–★9 按推荐，★6 (a)「结果导入 QRP」；压力补充路线 (d) 附条件批准，★3–★5 按推荐；`oos_reuse` 差距分解 `true`、补充 `false`。它不在任何 git 仓库里，只按 sha256 绑定（同加密增补 2 对冻结裁定的做法）。
- Q0 导入规格（`23689c99…`）、冻结说明 1（`b1700f37…`）、冻结说明 2（`f44c4b62…`）：Q0 的锁、压力行四种角色（G2）、三行分写（G3）全部沿用，本增补不改其中任何一条。
- 候选对比导入规格 V2 附录 3（`cbf85516…`）第 2 节：原版臂来源（`baseline_arm_ref`）的读法，差距分解的 `base_arm_ref` 照它读。

## 0. 为什么要增补

QRP 现有三种导入：Q0 基线（`BASELINE_EVALUATION_V1`）、Q1–Q5 候选对比（`CANDIDATE_COMPARISON_V1`），以及加密策略的 M2 轮次锁（`M2_ROUND_LOCK_V1`，加密 Q0 导入规格增补 2）。两份冻结 K2 各要一种它们都装不下的记录：

- 差距分解是描述，没有三态。前两类都要求 `verdict.state`；M2 轮次锁按档案读组合候选、前向计划与成本题，result_id 是 `R<轮>-…`，而 K2 冻结的 id 是 `GAP-…`。
- 压力补充只补 Q0 压力表的一行，不重封 Q0。放进 Q0 锁就是 Q0 的修订，这正是 K2 ★3 (b) 被否掉的那条路。

所以按两份 K2「QRP 需要的」新增两类只读导入的记录，每类一条追加式的锁。已冻结的规格一字不改。两类都挂在 Q0 锁上，所以作为 Q0 导入规格的增补，与加密增补 2 的位置相同。

## 1. 差距分解：`GAP_DECOMPOSITION_V1`

### 1.1 登记项

| 项 | 值 |
|---|---|
| 记录类型 / 锁 | `GAP_DECOMPOSITION_V1` / `GAP_DECOMPOSITION_LOCK_V1`，账本 `research/gap_decompositions.jsonl` |
| result_id | `GAP-<文件 sha256 前 16 位>` |
| 策略 | 只有 `US_V5_ETF_3000USD`（case 取档案的 `case_ref`） |
| schema / result_kind | `US_V5_M2_R2_GAP_DECOMPOSITION_V1` / `DESCRIPTIVE_DECOMPOSITION`；`identity.record_type = GAP_DECOMPOSITION_V1` |
| K2 / 勘误 / 冻结 | `identity.k2.sha256`、`identity.erratum.sha256`、`identity.k2.freeze.sha256` 分别等于上游三个值 |
| 运行门 | 12 个，都必须 `PASSED`：`ACCEPTANCE`、`INPUTS`、`ENGINE_FILES`、`RECON_D`、`RECON_B`、`IDENTITY`、`FEE_CROSSCHECK`、`EXIT_COUNTS`、`IS_REPRO`、`IS_RECON`、`REPRO`、`MEM`；文件里其他带 `state` 的门也不能是别的状态 |
| 当前 D（★7 (a)） | `identity.base_arm_ref = {result_id, arm: CANDIDATE_T3_ON_A25, sha256}`，指 Q5 的锁 |
| 引用的结果 | `identity.cited_results` 恰好是 Q1–Q5，各 `{result_id, sha256}` |
| 样本外（★5 (a)） | `oos_reuse` 必须是 `true`；`oos_reuse_detail.reason_code = OOS_REUSED_FOR_SELECTION`，`reason_zh` 有文字 |
| 顶层字段 | `identity`、`oos_reuse`、`oos_reuse_detail`、`gates`、`window`、`decomposition`、`ranking`、`power`、`step2_admission`、`reproducibility` |
| 不允许 | 文件任何位置出现 `verdict` 或 `verdict_state` 键（K2「不允许的字段」） |

### 1.2 整文件核对（失败关闭，不读账本）

错误码前缀 `GAP_`。读封存文件与旁边的 `.sha256` 用 Q0 的同一套读法，错误码 `Q0_RESULT_*` 换成 `GAP_RESULT_*`。

1. 带三态 → `GAP_VERDICT_NOT_ALLOWED`。
2. schema 不对 → `GAP_RESULT_SCHEMA_UNSUPPORTED`；`result_kind` 或 `record_type` 不对 → `GAP_RESULT_KIND_UNSUPPORTED`。
3. K2、勘误、冻结裁定的 sha256 → `GAP_K2_SHA_MISMATCH`、`GAP_ERRATUM_SHA_MISMATCH`、`GAP_FREEZE_SHA_MISMATCH`。`smartflow_commit` 不是 40 位 → `GAP_SMARTFLOW_COMMIT_MISSING`。
4. 运行门 → `GAP_RUN_GATE_NOT_PASSED`。复现：两次以上运行、sha256 相同、`identical: true`，否则 `GAP_RESULT_NOT_REPRODUCED`。
5. 样本外：`GAP_OOS_REUSE_MUST_BE_DECLARED` / `GAP_OOS_REUSE_NOT_DECLARED` / `GAP_OOS_REUSE_DETAIL_MISSING`。
6. 排名表：`rank` 从 1 连续；按对数贡献从大到小；`log`、`usd`、`g`、`share_of_gap` 是数；有 `power` 的行要有 `se`、`z`、`mde80` 与 `class_zh`。另要 `decomposition.SPY` 的期末与总差距。否则 `GAP_RANKING_INVALID`。
7. 第 2 步准入只核对「标签与文件里的数一致」，不重算（K2 §6，★8、★9 (a)）。否则 `GAP_ADMISSION_INCONSISTENT`：
   - 菜单只有 `M-1`，块组等于 `M-1` 的块；
   - 两个门槛（1.96、2.80）各一组，反过来的约定（★3 (a) 敏感性）也各一组。每组：
     - `positive` = g > 0；
     - `is_same_sign` = IS g > 0；
     - `significant` = g ≥ 门槛 × SE。文件里的数已取整，正好落在门槛上（差 ≤ 1e-6）时两种标签都接受；
     - `admitted` = 三项都是；
   - 运行门都过了，`decision` 只能是 `CANDIDATE` 或 `NO_CANDIDATE`：
     - `CANDIDATE` ⇔ 按 1.96 准入；
     - `candidate` 等于 `M-1` 的候选名（无候选时为 `null`）；
   - `research_gaps` 是数组。

### 1.3 账本核对

1. **Q0 基线。**
   - `baseline_result_id` 必须是这个 case 现有的 Q0 锁 → 否则 `GAP_BASELINE_LOCK_NOT_FOUND`；
   - 必须是当前锁 → 否则 `GAP_BASELINE_NOT_CURRENT`；
   - `INPUTS` 门里 Q0 那一项的 `expect` 等于锁记录的文件 sha256 → 否则 `GAP_BASELINE_SHA256_MISMATCH`；
   - Q0 文件可读、未漂移 → 否则 `GAP_BASELINE_FILE_UNREADABLE` / `GAP_BASELINE_FILE_DRIFTED`。
2. **当前 D 的来源**，照附录 3 第 2 节第 2–8 条，错误码前缀换成 `GAP_BASE_ARM_`：
   - 引用的形状；
   - 所引的锁存在，且是同一 case 里 Q5 的锁；
   - sha256 相符；
   - 是 Q5 当前的锁；
   - 同一个 Q0 基线；
   - 所引文件可读、未漂移。
   第 8 条「摘要逐项相同」：分解文件没有臂摘要，只有一项可比。`decomposition.SPY.end_current_d` 必须等于所引那一臂 `summary.end_capital`（相对误差 1e-9），否则 `GAP_BASE_ARM_DIFFERS_FROM_REF`。所引那一臂缺摘要 → `GAP_BASE_ARM_MISSING`。
3. **引用的 Q1–Q5。** 恰好五题，否则 `GAP_CITED_RESULTS_INCOMPLETE`。每题的锁：
   - 存在且是那一题 → 否则 `GAP_CITED_RESULT_LOCK_NOT_FOUND`；
   - sha256 相符 → 否则 `GAP_CITED_RESULT_SHA256_MISMATCH`；
   - 是当前的锁 → 否则 `GAP_CITED_RESULT_NOT_CURRENT`。

   引用的 Q5 必须就是当前 D 来源那把锁 → 否则 `GAP_CITED_RESULT_DIFFERS_FROM_BASE_ARM`。

### 1.4 写入

- 只追加一条 `GAP_DECOMPOSITION_LOCK_V1`。锁上记：
  - Q0 基线；
  - `base_arm_ref {result_id, arm}`；
  - `cited_result_ids`（Q1–Q5 顺序）；
  - `oos_reuse: true`；
  - 文件里的 `decision`；
  - 文件 sha256、smartflow 提交、K2 路径与 sha256；
  - `import_profile_id` = 本文件路径；
  - `production_effect: NONE`。
- 每个 case 一条。同一文件重导是幂等重放。另一份文件要 `--supersedes <当前锁> --defect-ref … --reason …`，旧锁保留（同 Q0）。
- 这把锁不是结论：
  - 不进采用一览；
  - 不算「待 Owner 决定」；
  - 不写 `RESEARCH_ADOPTION_DECISION_V1`；
  - 不改 Q0–Q5 的任何锁或页面。

### 1.5 页面

- **位置与标题：** 「运行概览」里 Q0 的回测结论卡下面、待验证问题清单上面，一张卡，标题「差距分解（描述，不是结论）」（K2「页面」），带标签「描述，不是结论」。
- **开头两行：**
  - 总差距：年化 g 差、SE、两条期末；
  - 样本外复用的披露：`oos_reuse: true` 加文件里的原因原文。
- **依次三块（K2「排名表、功效列、第 2 步准入表」）：**
  1. **排名表。** 按文件顺序列出各块：年化 g、USD、占差距、SE、z、**MDE80（功效列）**、可检测性、IS g 及是否同号。A 内部切分另成一张小表。
  2. **功效。**
     - 账户层面：总差距 SE、MDE80 / MDE50；
     - 每笔层面：笔数、sd、MDE80 / MDE50、检测 +0.10 R 所需笔数；
     - 文件里的「乐观下界」一句。
  3. **第 2 步准入表。** 三行：块组按 1.96、块组按 2.80、反过来的约定按 1.96（标「不参与准入」）。每行列出 g、SE、z、IS g 与四项「是 / 否」。表下写一句结论：「第 2 步候选：… （按 1.96 准入）；按 2.80 …」，或「第 2 步无候选：…」。另写研究缺口与敏感性说明。
- **排版：** 数字全部取自文件，只排版：g、SE 四位小数，z 两位，USD 两位，占差距一位百分数。
- **状态提示：** Q0 基线或 Q1–Q5 的锁后来被取代时，卡片上加提示「所引用的 … 已被取代 / 已有更新」，数字照旧显示。
- **失败关闭：** 文件漂移、缺失或校验不过时，整卡只写「封存结果校验未通过：原因」，不显示任何数字。
- **技术详情（折叠）：** 结果编号、文件 sha256、Q0 基线、当前 D 来源、Q1–Q5、K2、勘误、冻结裁定、smartflow 提交、本增补路径、锁定时间。
- 没有这把锁的策略，详情投影不多任何字段。

## 2. Q0 压力补充：`BASELINE_STRESS_SUPPLEMENT_V1`

### 2.1 登记项

| 项 | 值 |
|---|---|
| 记录类型 / 锁 | `BASELINE_STRESS_SUPPLEMENT_V1` / `BASELINE_STRESS_SUPPLEMENT_LOCK_V1`，账本 `research/baseline_stress_supplements.jsonl` |
| result_id | `Q0S-<文件 sha256 前 16 位>` |
| 策略 | 只有 `US_V5_ETF_3000USD` |
| schema / result_kind | `US_V5_M2_Q0_STRESS_SUPPLEMENT_V1` / `BASELINE_STRESS_SUPPLEMENT`；`identity.record_type = BASELINE_STRESS_SUPPLEMENT_V1` |
| K2 / 冻结 | `identity.k2.sha256 = cc945872…`；`identity.k2.freeze.sha256 = 5501741d…` |
| 运行门 | 11 个，都必须 `PASSED`：`ACCEPTANCE`、`INPUTS`、`ATTEST_DATES_ONLY`、`ATTEST_OVERLAP`、`ATTEST_COUNT`、`ENGINE_INERT`、`OPTION_INERT_2022`、`FLOOR_VALID`、`SIGNALS_UNCHANGED`、`REPRO`、`MEM` |
| 冻结的输入路线 | 只有 `FLOOR_ATTESTATION_LOCAL_DAILY`（FREEZE 1 路线 (d)）；`identity.floor_attestation {file, sha256}` |
| 不可补的场景 | `EXTREME_DOWNTURN_2008`（协调会话裁定） |
| 参照行（★5 (a)） | `reference_rows[*].ref = {result_id, arm: CANDIDATE_T3_ON_A25}`，`in_any_lock: false` |
| 样本外 | `oos_reuse` 必须是 `false`，`window_history_zh` 有文字 |
| 顶层字段 | `identity`、`inputs`、`gates`、`row`、`reference_rows`、`q0_row_before`、`oos_reuse`、`window_history_zh`、`reproducibility` |

### 2.2 只核对，不重算（K2「导入器只做核对」，另加的几条标 ＋）

错误码前缀 `SUPPLEMENT_`。读封存文件同 Q0，`Q0_RESULT_*` 换成 `SUPPLEMENT_RESULT_*`。

1. ＋ 带三态（顶层或补充行有 `verdict`）→ `SUPPLEMENT_VERDICT_NOT_ALLOWED`。理由：K2 写明本补充「只描述损失」，不出三态。
2. ＋ schema、类别、K2、冻结裁定不符：
   - `SUPPLEMENT_RESULT_SCHEMA_UNSUPPORTED`；
   - `SUPPLEMENT_RESULT_KIND_UNSUPPORTED`；
   - `SUPPLEMENT_K2_SHA_MISMATCH`；
   - `SUPPLEMENT_FREEZE_SHA_MISMATCH`。
3. `scenario = EXTREME_DOWNTURN_2008` → `SCENARIO_NOT_FILLABLE`。
4. `input_route` 不是冻结的读法，或缺证明文件引用 → `SUPPLEMENT_INPUT_ROUTE_NOT_FROZEN`。
5. 任一门不是 `PASSED` → `SUPPLEMENT_RUN_GATE_NOT_PASSED`。两次运行不相同 → `SUPPLEMENT_RESULT_NOT_REPRODUCED`。
6. 样本外：
   - `oos_reuse` 不是 `false` → `SUPPLEMENT_OOS_REUSE_MUST_BE_FALSE`；
   - ＋ 缺窗口历史 → `SUPPLEMENT_WINDOW_HISTORY_MISSING`。
7. 补充行：
   - `simulated` 不是 `false` → `SUPPLEMENT_ROW_SIMULATED`；
   - ＋ 场景与 `identity.scenario` 不同，或最大亏损、最长水下、期末、是否回到水上、笔数不是数 → `SUPPLEMENT_ROW_INVALID`。
8. ＋ 参照行：
   - 同形、`simulated: false`、`ref.arm` 是 `CANDIDATE_T3_ON_A25`，否则 `SUPPLEMENT_REFERENCE_INVALID`；
   - `in_any_lock` 不是 `false` → `SUPPLEMENT_REFERENCE_IN_LOCK`；
   - `ref.result_id` 不是同一 case 里 Q5 的锁 → `SUPPLEMENT_REFERENCE_REF_NOT_FOUND`。
9. `baseline_result_id` 不是现有的 Q0 锁，或 `baseline_sha256` 与锁记录的文件 sha256 不同 → `SUPPLEMENT_BASELINE_MISMATCH`。
   - ＋ 不是当前的 Q0 锁 → `SUPPLEMENT_BASELINE_NOT_CURRENT`；
   - ＋ Q0 文件读不了或漂移 → `SUPPLEMENT_BASELINE_FILE_UNREADABLE` / `SUPPLEMENT_BASELINE_FILE_DRIFTED`。
10. `scenario` 在 Q0 文件里不是唯一一行「无效输入 / 缺场景」（`INVALID_INPUT`、`MISSING_SCENARIO` 或 `missing: true`）→ `SUPPLEMENT_SCENARIO_NOT_A_GAP_ROW`。
11. ＋ `q0_row_before` 与 Q0 文件里那一行逐字段不同 → `SUPPLEMENT_Q0_ROW_BEFORE_DIFFERS`。理由：页面要拿它对照 Q0 原行，它必须就是那一行。

### 2.3 写入

- **只追加，不改 Q0 的锁。** 锁上记：
  - Q0 基线、场景、输入路线；
  - `oos_reuse: false`；
  - 参照行所引的锁；
  - 文件 sha256、smartflow 提交、K2；
  - `import_profile_id` = 本文件路径；
  - `production_effect: NONE`。
- **唯一性：** 同一 (基线, 场景) 只能有一条。同一文件重导是幂等重放；要改，与 Q0 一样走 `--supersedes … --defect-ref … --reason …`，旧锁保留。
- **参照行只显示，** 不进任何锁的计数。

### 2.4 页面（K2 ★3 (a)）

- **压力表里的位置：**
  - Q0 卡片压力表的 2020 行原样保留「无效输入：…」；
  - 它下面加一行：「补充（另行封存，Q0S-…）：最大亏损 X USD，期末 Y USD，最长水下 Z 个 session，区间内 SPY …%」，金额两位小数，后面注明「只描述损失，不出三态，不进最大损失与压力计数」；
  - 再下一行灰字：「当前 D（D+A25+T3）参照：最大亏损 …，期末 …，最长水下 …，N 笔；只报，不进 Q0、不进 Q5」。
- **补充报告：** 路径（smartflow `trading-system-v2/docs/US_V5_M2_Q0_STRESS_SUPPLEMENT_V1.md`）与哈希放在这一行的技术详情里。
- **只按 Q0 文件算的部分：** 卡片的「最大损失」主数字、「已执行 N 个压力场景…」的计数、压力结论与采用条件。补充行不进其中任何一项。
- **加一句「2020 区间另有补充，见压力表」：** 页面有两处写压力评价，两处都加——顶部结论区块三行中「压力评价不完整」那一行的末尾，以及压力块「压力结论」一行的下面。
- **校验不过时：** 补充文件漂移、缺失或校验不过，只让这一行写「补充（另行封存，Q0S-…）：封存结果校验未通过（原因）」，不显示参照行，也不加那一句。Q0 卡片照常。
- **没有补充锁时：** Q0 投影一个字段都不多。
- Q1–Q5 的页面不变。

## 3. 命令行（完成权威；只读封存文件，只追加一条锁）

```
QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_gap_decomposition.js \
  --file /abs/path/US_V5_M2_R2_GAP_DECOMPOSITION_V1.json --registered-by V8_1_COORDINATOR \
  [--supersedes <result_id> --defect-ref <ref> --reason "<text>"]
QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_stress_supplement.js \
  --file /abs/path/US_V5_M2_Q0_STRESS_SUPPLEMENT_V1.json --registered-by V8_1_COORDINATOR \
  [--supersedes <result_id> --defect-ref <ref> --reason "<text>"]
```

- **封存文件放哪里：** 同 Q0–Q5，放在本机 `var/evidence/` 下（不进 git），例如：
  - `var/evidence/us-v5-m2-r2-gap-2026-11-03/`；
  - `var/evidence/us-v5-m2-q0s-2026-11-03/`。
  
  每份连同旁边的 `.sha256`。
- **导入顺序：** 两条记录互不依赖。差距分解要求 Q1–Q5 的锁都是当前锁；压力补充只要求 Q0 是当前锁、参照行所引的 Q5 锁存在。

## 4. 不做的事

- 不重算任何业务数字。差值、份额、z、MDE、准入都取文件里的数，只核对一致性。
- 不改 Q0–Q5 的锁、文件、三态结论、页面主数字、压力计数与采用条件。2008 行仍不可补。
- 不写采用决定、研究队列或说明登记。
  - 差距分解给出的第 2 步候选（D+A25+T3+M-1）由第 2 步 K2 按 result id 引用；
  - 第 2 步是否开题、何时进队列，由协调会话决定。
- 不写生产参数、HK、smartflow 或 desk。
