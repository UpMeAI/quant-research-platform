# 候选对比导入规格 V2 · 附录 4：Q6 登记项（第二轮第 2 步组合验证）、G1′ 判据、做 / 不做（N1–N4）、前向规则与引用的锁

状态：**提议，随 PR 合并；协调会话合并即冻结。** 研究会话起草，2026-11-04。

上游：
- 第 2 步研究规格 `docs/contracts/US_V5_M2_R2_STEP2_COMBINED_K2_DRAFT_V1.md`（sha256 `1fc9c18bed82ba7e19a4c3e5afb29bcc7b051bcf2134ad8cdc179468920671ad`）。
  - 从 smartflow `research/us-v5-m2-r2-step2-k2` @ `b9b92e19` 逐字节照录，文件名照原样；测试核对 sha256。
  - 文件名与状态行写着 DRAFT，但这份文本已由协调会话冻结（见下一条），以 sha256 为准。本附录不改动它。
- 冻结记录 `artifacts/coordinator/US_V5_ROUND2_ITEMS_1_4_K2_FREEZE_1.md` 第 1 项：★1–★6 全按推荐。
  - 它不在 git 里，按 sha256 `e4bcc0cc81144327bf983b0d50d47b19eaff997b807ce9beb3d95bb3ed2574e3` 绑定（同 Q0 导入规格增补 1 的做法）。
  - 结果文件只写了它的路径与项号，导入器核对这两项。
- 导入规格 V2 与附录 1–3：封存、复现、基线链、压力行形状、三行分写、配对 g、敞口附加行、只报行，以及附录 3 第 2 节的 `baseline_arm_ref` 读法。本附录全部沿用。
- Q0 导入规格增补 1：差距分解锁 `GAP_DECOMPOSITION_LOCK_V1` 与压力补充锁 `BASELINE_STRESS_SUPPLEMENT_LOCK_V1`。本题引用这两把锁。

## 0. 为什么要另写附录

★6 (a) 把这份结果登记为 Q6：结果锁 `Q6-<sha16>`，候选臂键 `CANDIDATE_M1_ON_T3_A25`，判据 G1′ / P_G / F3，原版臂按附录 3 第 2 节读。也就是走候选对比的导入路径（`apps/research-cli/import_candidate_comparison.js`，锁 `COMPARISON_EVALUATION_LOCK_V1`）。

加密的 `M2_ROUND_LOCK_V1`（`import_m2_round.js`）不合适：它按策略档案的轮次登记文件角色，锁号是 `R<n>-…`，与 ★6 冻结的 `Q6-…` 不符。增补 1 已为差距分解否决过同一条路。

现有的冻结规格容不下这份文件，原因有以下几处（K2 ★6 说的「QRP 需要新增两处读法」是前两处）：

1. **判据是 G1′ 而不是 G1**（★1 (a)）：第三个样本数是「候选持有 SPY 的 session」，不是改变的入场 / 出场。本题也没有 δ_R（M-1 不改逐笔）。
2. **三态之外另有「做 / 不做」**（K2 §6.1、★3 (a)、★4 (a)）：`verdict.do_or_not` 的 N1–N4 与允许用途。
3. **前向**：文件没有前向行，只有冻结的 §7 原文 `forward_spec`；V2 要求 `forward` 行。
4. **输入**：文件不逐个登记序列（没有 `inputs.series`），而是登记 A1 缓存清单、两组扫描信号、封存结果与证明文件的 sha256。V2 的锁摘要算法读不了它。
5. **现金臂只有摘要**：封存文件照 Q5 只抄了现金臂的摘要，没有权益序列。
6. **2008「只停放 SPY」上界行**（★5）：它不是两臂比较，没有 `arms`。
7. **§6.3 核对**与 Q5 ★3 (a) 不同：它只列出事实，不推出采用 / 不采用建议，因为结论已由 §6.1 定。
8. **引用**：文件引用差距分解（GAP）、压力补充（Q0S）与 Q4 三把锁。

所以另写本附录。它不改任何冻结文本。比 K2 原文更严的项在下文标 **＋** 并写明理由。

实现：
- `services/candidate-comparison/questions/q6.js`：登记项，以及第 1–11 节的全部核对、块与卡。
- `services/candidate-comparison/index.js`：增加三个可选钩子。登记项不设这些钩子时，读法与之前逐字相同，Q1–Q5 不变：
  - `validateForward`：代替「前向行必须存在」；
  - `checkLedger`：在 Q0 与原版臂来源之后做的账本核对；
  - `digests`：锁的摘要。
- `services/candidate-comparison/common.js`：`armSummaries` 认登记项的 `summary_only_comparators`，不设时不变。
- `services/candidate-comparison/questions/q5.js`：导出冷却计数的校验与敞口附加行，供 Q6 复用；Q5 的读法不变。
- 配置与页面：
  - `config/strategy_profiles.v1.json`：本附录列进 US_V5 的 `comparison_import_profile_ids`，计划队列加 Q6（在 Q5 之后）；
  - `config/strategy_detail_notes.v1.json`：研究队列加 Q6（第二轮，带自己的来源）；
  - 页面认出做 / 不做卡、上界行与前向规则。

## 1. 登记项

| 项 | 值 |
|---|---|
| 题目 | `Q6`，队列顺序 6，结果类别 `CANDIDATE_COMPARISON_V1`；计划队列 `after: [Q5]` |
| schema | `US_V5_M2_R2_STEP2_COMBINED_V1`；`result_kind` = `CHALLENGER_VS_BASELINE` |
| K2 | 上述路径与 sha256；冻结记录按 sha256 绑定，文件的 `identity.k2.freeze` 必须是 `{file: artifacts/coordinator/US_V5_ROUND2_ITEMS_1_4_K2_FREEZE_1.md, item: 1}`（＋，`Q6_K2_FREEZE_MISMATCH`） |
| 第 1 步 K2 | `identity.k2_step1.now` = `a161c523…`，`identity.erratum_step1.now` = `c17802e3…`（K2 §2：运行器的 ACCEPTANCE 门同时核对这两份；＋，`Q6_K2_SHA_MISMATCH`） |
| 原版臂 | 键 `BASELINE_T3_A25`，名字「原版（当前 D = D+A25+T3）」，来源见第 2 节 |
| 候选臂键 | `CANDIDATE_M1_ON_T3_A25` |
| 比较对象 | 档案的 SPY 买入持有与现金；现金臂可以只有摘要（第 11 节） |
| 运行门 | 以下 11 个，都必须 `PASSED`：`ACCEPTANCE`、`INPUTS`、`INERT_TEST`、`ENGINE_STRIP`、`PARITY_M1_OFF`、`BASELINE_REPRO_D`、`M1_FLAT_SPY_IDENTITY`、`CASH_IDENTITY`、`SPY_FEES`、`REPRO`、`MEM` |
| 判据集与常数 | G1′ / P_G / F3；δ_g = 0；95% 区间，单一比较；没有 δ_R；G1′ 先判（第 3 节） |
| 样本外 | `oos_reuse` 必须是 `true`；`verdict.reason_codes` 必须含 `OOS_REUSED_FOR_SELECTION`；`oos_reuse_detail` 必须有文字 |
| 归因 | 不要求 |
| 敞口 | 要求。两臂都要有冷却计数，因为两臂都是 A25（同附录 3）。候选另列 SPY 平均名义、最大名义与平均停放比例，只报 |
| 顶层字段 | `identity`、`power_first`、`inputs`、`gates`、`arms`、`stats`、`stress`、`half_kelly`、`formula_table`、`verdict`、`reproducibility`、`comparison`、`oos_reuse`、`oos_reuse_detail`、`reference_rows`、`forward_spec`、`disclosures_zh`；`recommendation` 不在必填之列（第 5 节） |
| 披露 | `disclosures_zh` 必须是非空的文字数组（＋，`Q6_DISCLOSURES_MISSING`）。理由：K2 §3.3「必须随候选披露的」 |

## 2. 原版臂来源（`baseline_arm_ref`）

照附录 3 第 2 节第 1–8 条，登记项写 `baseline_arm.ref = {question_ref: 'Q5', arm: 'CANDIDATE_T3_ON_A25'}`：
- Q0 锁照旧核对；D 的基线锁仍是 Q0。
- `identity.baseline_arm_ref` 必须指向 Q5 当前的锁，臂名、sha256 与同一个 Q0 都相符。
- 原版臂摘要与 Q5 那一臂逐项相同。

错误码：`Q6_BASELINE_ARM_REF_MISSING`、`…_LOCK_NOT_FOUND`、`…_SHA256_MISMATCH`、`…_NOT_CURRENT`、`…_BASELINE_DIFFERS`、`…_FILE_UNREADABLE`、`…_FILE_DRIFTED`、`Q6_BASELINE_ARM_DIFFERS_FROM_REF`。

## 3. G1′ 与三态（★1 (a)）

- **G1′**：读 `criteria.G1_prime {met, baseline_oos_trades, candidate_oos_trades, candidate_sessions_holding_spy}`。三个数都 ≥ 30 才成立。
- **三态**：同 Q5 模板。
  - G1′ 不成立 → 证据不足；
  - 成立时 U_g ≤ 0 → 未通过；
  - L_g > 0 → 有支持证据；
  - 其余 → 证据不足。
  - 错误码同附录 3：`SUPPORTED` 缺证据为 `Q6_VERDICT_SUPPORTED_WITHOUT_EVIDENCE`，三个数有一个 < 30 为 `Q6_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL`；`NOT_PASSED` 缺证据为 `Q6_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE`。
- **常数**：`verdict.delta_g` 必须是 0（`Q6_VERDICT_DELTA_CHANGED`）。
- **＋ 标签与数一致**（`Q6_CRITERIA_INCONSISTENT`）：
  - `G1_prime.met` ⇔ 三个数都 ≥ 30；
  - `P_G.met` ⇔ L_g > 0；
  - `F3.triggered` ⇔ U_g ≤ 0。

  理由：页面直接显示这三个真假值，它们不能与文件里的数相反。

## 4. 做 / 不做（K2 §6.1–§6.2，★3 (a)、★4 (a)）

`verdict.do_or_not` 必须有，形状为 `{decision ∈ DO | DO_PAPER_SHADOW | NOT_DO, triggered, strength_zh, allowed_use_zh, checks: [N1..N4]}`，每条写 `triggered: true | false`；缺了为 `Q6_DO_OR_NOT_MISSING`。

BLOCKED 的文件不带结论：运行门不过时，导入器在这一步之前就已拒绝（`Q6_RUN_GATE_NOT_PASSED`）。

以下逐条与文件自己的数核对，不重算任何统计量。任一不符为 `Q6_DO_OR_NOT_INCONSISTENT`。

| 条 | 核对 |
|---|---|
| `triggered` | 等于 N1–N4 中 `triggered: true` 的那几条，按 N1→N4 排 |
| N1 | ⇔ G1′ 成立且 U_g ≤ 0 |
| N2 | ⇔ `comparison.is.paired_g.g` ≤ 0（IS 配对 g 的点估计） |
| N3 | `rows` 正好是 K2 §6.1 的六个真实历史行：`BASELINE`、`IS_2020_01_02_2022_12_30`、`WINDOW_2022_01_03_10_31`、`WINDOW_2020_02_19_04_30`、`COST_15BPS`、`SCAN_PHASE_PLUS_60MIN`。每行的最低权益与最大回撤等于压力表候选格（IS 行取 `stress.is_rows`）；`below_1800` ⇔ 最低权益 < 1,800；`rule1_50pct` ⇔ 最大回撤 ≥ 50%；行触发 ⇔ 二者之一；N3 ⇔ 任一行触发。上界行与风控维度行不进 N3 |
| N4 | ⇔ `COST_15BPS` 或 `SCAN_PHASE_PLUS_60MIN` 行里候选期末 < 基线期末 |
| `decision` | 按 §6.1 的顺序推出：任一 N 成立 → `NOT_DO`；否则 L_g > 0 → `DO`；否则 → `DO_PAPER_SHADOW` |
| `strength_zh` | 分别以「触发」（`NOT_DO`）、「有支持证据」（`DO`）、「证据不足」（`DO_PAPER_SHADOW`）开头（§6.2） |

**允许用途**（`Q6_DO_OR_NOT_ALLOWED_USE`）：
- `NOT_DO` 的 `allowed_use_zh` 以「无」开头；
- `DO` 与 `DO_PAPER_SHADOW` 的必须含 `US_V5_M1_SHADOW` 与「不是生产采用」（★4 (a)：「做」只开带标注的前向影子账本）。

**锁与采用**：
- 锁记录不加字段，三态照旧写 `verdict_state`；做 / 不做只在页面上从封存文件读。
- 采用决定仍由协调会话按 UX 修订 6 另写记录。
- 进生产属第 1 类修订，需 Owner 签字，并满足 K2 §6.4 的四个前提；导入器不替任何人决定。

## 5. §6.3 核对（`recommendation`）

- **只在 `DO_PAPER_SHADOW` 时有**（K2 §8：「只在证据不足时填」；§6.1：证据不足而 N 都不成立才是「做（纸面 / 影子）」）。
  - 这时 `checks` 必须含第 1–6 项；第 1–4 项写 `yes: true | false`，第 5、6 项写 `list_only: true`；
  - 缺块为 `Q6_RECOMMENDATION_MISSING`，项不全为 `Q6_RECOMMENDATION_CHECKS_INCOMPLETE`。
- **其余结论不许带**（`Q6_RECOMMENDATION_NOT_ALLOWED`）。
- **与 Q5 ★3 (a) 不同**：本题不从第 1–4 项推出「建议采用 / 不采用」，结论已由 §6.1 定为「做（纸面 / 影子）」。所以页面把这几项列在做 / 不做卡里，不用 Q5 的「待 Owner 决定（建议…）」卡。

## 6. 参照行（`reference_rows`）

一个数组，必须包含这三行（键名固定），每行 `in_verdict: false`：

| 键 | 内容 | g 字段 |
|---|---|---|
| `REF_D` | 原版 D（Q0 的 D 臂） | `g_vs_baseline`（对当前 D） |
| `REF_D_A25` | D+A25（Q4 的候选臂） | `g_vs_baseline`（对当前 D） |
| `CANDIDATE_VS_REF_D` | 候选对原版 D：A25 + T3 + M-1 合起来 | `g_vs_reference`（对原版 D） |

- 文件里这三行都没有成熟交易数，`n` 可缺。
- 错误码同附录 3：`Q6_REFERENCE_ROW_MISSING`、`Q6_REFERENCE_ROW_IN_VERDICT`。
- **＋ 来源**（`Q6_REFERENCE_ROW_SOURCE_MISMATCH`）：`REF_D.source_result_id` 等于本文件的 Q0 基线，`REF_D_A25.source_result_id` 等于引用的 Q4 锁。理由：参照行的数要能追到具体的锁。

## 7. 前向规则（`forward_spec`）

- 本题还没有前向行。登记项用 `validateForward` 代替「前向行必须存在」；文件里若有前向行，仍须 `in_verdict: false`。
- `forward_spec` 必须是 `{section: '§7', sha256, text_zh}`，缺了为 `Q6_FORWARD_SPEC_MISSING`。
  - `sha256` = `8e696d9e6d4d060649b604a619aa0c7817c03750193f5508486458665a35bfd7`：K2 副本从「## 7. 前向影子」到「## 8. 结果文件与 QRP」之前那一段的 sha256，即研究会话运行器的算法；
  - `text_zh` 的 sha256 = `54de1f842eef7f5120e313e714e26733cc28d3bcdb903273345f72980a1b23b5`：同一段去掉首尾空白；
  - 不符为 `Q6_FORWARD_SPEC_MISMATCH`。两个数都由仓库里的 K2 副本切出，测试核对。
- 页面：前向块写「前向影子账本 US_V5_M1_SHADOW 尚未开始」，并附冻结的 §7 原文（折叠）。
- 影子账本的实现与前向记录另立工程任务，不在本附录。

## 8. 压力表与上界行（★5）

- 两臂行照 V2 / 附录 3 读，差 = 候选 − 原版。
- `EXTREME_DOWNTURN_2008` 与 SPY / QQQ 合成补充行是缺场景。`SUPPORTED` 的文件必须带 `STRESS_SCENARIO_MISSING`，同 V2；采用条件写「必要压力缺失」。
- **上界行** `SPY_PARK_2008_BOUND`（`simulated_bound: true`）：
  - 必须正好一行，`simulated: true`、`in_verdict: false`；
  - 期初、期末、最低权益、最大回撤、最大亏损、最长水下期都是数；
  - `below_1800` ⇔ 最低权益 < 1,800，`rule1_50pct_touched` ⇔ 最大回撤 ≥ 50%；
  - `source.sha256` 等于 `inputs.spy_json.sha256`；
  - 不符为 `Q6_BOUND_ROW_INVALID`。
- 上界行在页面上单列在压力表最后，写「上界情景，不是本策略的回放；只报不判，不进 N3」。它不算「已执行」，算一行模拟，也不进压力评价的完整性。

## 9. 引用的锁与 INPUTS 门（＋）

照增补 1 差距分解对 Q1–Q5 的 cited 读法：
- `identity.cited_results` 必须正好是 `GAP`、`Q0S`、`Q4` 三项，每项 `{result_id, sha256}`；否则 `Q6_CITED_RESULTS_INCOMPLETE`。
- 导入时，在 Q0 与原版臂来源之后：
  - 每把锁存在于同一 case（`Q6_CITED_RESULT_LOCK_NOT_FOUND`）、sha256 相符（`Q6_CITED_RESULT_SHA256_MISMATCH`）、是当前的锁（`Q6_CITED_RESULT_NOT_CURRENT`）。压力补充的「当前」按（Q0 基线, 场景）判；
  - 差距分解锁的 `decision` 必须是 `CANDIDATE`（`Q6_CITED_GAP_NOT_CANDIDATE`）。理由：本题只因第 1 步按冻结规则准入 M-1 才存在；
  - 差距分解锁的原版臂与本文件是同一把 Q5 锁（`Q6_CITED_GAP_BASE_ARM_DIFFERS`）；
  - 压力补充锁的 Q0 基线与本文件相同（`Q6_CITED_Q0S_BASELINE_DIFFERS`）；
  - `gates.INPUTS.sealed` 里 Q0、Q5、GAP、Q0S、Q4 的 `expect` 与 `now` 等于 Q0 锁、`baseline_arm_ref` 与引用的 sha256（`Q6_INPUTS_SEALED_MISMATCH`）。
- **导入顺序**：协调会话先按增补 1 导入 GAP 与 Q0S，再导入 Q6；顺序反了，Q6 会以 `Q6_CITED_RESULT_LOCK_NOT_FOUND` 拒绝，账本不写。

## 10. 锁的摘要

- `inputs_digest` = 下列 sha256 的规范化摘要：A1 缓存清单、`signals`、`signals_q4`、`inputs.sealed` 的（input, expect）、地板证明文件与 SPY.json。
- `engine_digest` 同 Q0 的算法：smartflow 提交加引擎文件表。
- 字段缺或不是 64 位十六进制：`Q6_INPUTS_INCOMPLETE`、`Q6_ENGINE_BLOBS_MISSING`、`Q6_SMARTFLOW_COMMIT_MISSING`。

## 11. 现金臂

- 登记项写 `summary_only_comparators: ['CASH']`。现金臂没有权益序列时，只核对摘要五项（期末资本、CAGR、最大回撤、最长水下期、是否恢复），不画序列，也不拿别的臂的日期补。
- 有序列时照 V2 读。不设这一项的登记项不变。

## 12. 页面

- 主卡八块：问题、账户、账户对数增长、敞口、判据、压力、三态结论、前向。
  - 判据块的第一行写「G1′ · 样本门（G1′）」；
  - 样本外说明只取 `oos_reuse_detail.reason_zh`，主内容不出现原样的英文原因码。
- 主卡之后两张卡：
  - **参照行**：只报不判；
  - **做 / 不做**：结论、证据强度、允许用途；功效（运行前与实现后）、收回率与扣减拆分、IS 配对 g、停放统计；N1–N4 逐条；§6.3 核对（有时）；生产说明与必须随候选披露的事实。
- 全部文字取自文件，只排版，不重算。

## 13. 不做的事

- 不重算任何业务数字；差值、核对都取文件里的数。
- 不写生产参数、账本或 HK，不开影子账本。
- M-1 是否进生产由 Owner 签字决定（第 1 类修订）。
- 不改 Q1–Q5 的读法；不改差距分解与压力补充的锁。
